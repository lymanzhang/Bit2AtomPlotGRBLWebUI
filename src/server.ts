/**
 * Backend web server for controlling the EBB.
 * Serve both the front end UI as static files - made with React, and backend
 * API for controlling the EBB.
 * Keep open web sockets to the front end for real-time updates.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { autoDetect } from "@serialport/bindings-cpp";
import type { PortInfo } from "@serialport/bindings-interface";
import cors from "cors";
import type { Request, Response } from "express";
import express from "express";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { EBB, type Hardware } from "./ebb.js";
import { PlotLogger } from "./plot-log.js";
import {
  type Device,
  getDevice,
  isBuiltinHardware,
  type Motion,
  type MotionData,
  PenMotion,
  Plan,
  rewindTravelMotion,
  snapToGroupStart,
  XYMotion,
} from "./planning.js";
import { startRunLog } from "./run-log.js";
import { SerialPortSerialPort } from "./serialport-serialport.js";
import * as _self from "./server.js"; // use self-import for test mocking
import { formatDuration } from "./util.js";
import { type Vec2, vlen, vsub } from "./vec.js";

type Com = string;

/**
 * Shorthand for getting the device info, either EBB or com port.
 * @param ebb
 * @returns
 */
const getDeviceInfo = (ebb: EBB | null) => {
  const portPath = (ebb?.port as any)?._path ?? null;
  return { path: portPath, hardware: ebb?.hardware ?? "v3" };
};

/**
 * Start the express server.
 * @param port
 * @param hardware
 * @param com
 * @param enableCors
 * @param maxPayloadSize
 * @returns
 */
export async function startServer(
  port: number,
  hardware: Hardware = "v3",
  com: Com = "",
  enableCors = false,
  maxPayloadSize = "200mb",
) {
  startRunLog();
  // Last-resort safety net: a plot can run for hours, so a stray promise
  // rejection must never kill the process (Node's default is fatal). Real
  // failures are surfaced through command rejections/timeouts and logged here.
  process.on("unhandledRejection", (reason) => {
    console.error(`[bit2atombot] unhandled promise rejection: ${reason instanceof Error ? reason.message : reason}`);
  });
  const app = express();
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  app.use("/", express.static(path.join(__dirname, "..", "ui")));
  app.use(express.json({ limit: maxPayloadSize }));
  if (enableCors) {
    app.use(cors());
  }
  // Web and Socket server
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  let ebb: EBB | null;
  let clients: WebSocket[] = [];
  let unpaused: Promise<void> | null = null;
  let signalUnpause: (() => void) | null = null;
  let motionIdx: number | null = null;
  let currentPlan: Plan | null = null;
  let plotting = false;
  let controller: AbortController | null = null;
  // When set, resuming from a pause will rewind the plan to this motion
  // index (snapped to a path-group start) and redraw from there.
  let pendingRewind: number | null = null;
  // Pen position across plots, for redraw-range runs. After a normal finish
  // it is the plan's final travel destination; after a cancel it is the plan's
  // initial pen home (HM). Null after server start (position unknown).
  let lastPenPos: Vec2 | null = null;
  // Serialized plan of the last plot, kept after completion for /redraw.
  let lastPlan: MotionData[] | null = null;
  // The "wake lock unavailable" reminder is informational; only print it once.
  let wakeLockReminderShown = false;
  // 当前绘制任务的文件级日志（每次 /plot 或 /redraw 一个文件，与源文件同名）
  let plotLogger: PlotLogger | null = null;
  // 当前任务已实际绘制的距离（mm），由 doPlot 累加
  let plottedDistanceMm = 0;
  // 计划坐标的步进密度（步/mm）。Plan 的全部坐标与速度都在全步进空间
  // （mm×stepsPerMm），换算真实毫米值必需；由前端经请求头提供。
  let plotStepsPerMm = getDevice(hardware).stepsPerMm;

  /** 从请求头解析步进密度（X-Plot-Steps-Per-Mm），缺失或非法时返回 null。 */
  function parseStepsPerMm(req: Request): number | null {
    const header = req.headers["x-plot-steps-per-mm"];
    if (typeof header === "string") {
      const value = Number(header);
      if (Number.isFinite(value) && value > 0) return value;
    }
    return null;
  }

  /** 从请求头解析自定义硬件的安全工作区域（X-Plot-Working-Area，格式
   * "宽x高" mm，如 "500x400"），缺失或非法时返回 null。 */
  function parseWorkingArea(req: Request): { x: number; y: number } | null {
    const header = req.headers["x-plot-working-area"];
    if (typeof header === "string") {
      const m = header.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/);
      if (m) {
        const x = Number(m[1]);
        const y = Number(m[2]);
        if (x > 0 && y > 0) return { x, y };
      }
    }
    return null;
  }

  /** 扫描计划坐标范围（全步进空间，含落笔路径、抬笔空程与首尾行程），
   * 超出设备工作范围时返回给用户的描述信息，未超界返回 null。
   * 容差 0.5 步吸收浮点误差。 */
  function planOutOfBounds(plan: Plan, device: Device, stepsPerMm: number): string | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const m of plan.motions) {
      if (m instanceof XYMotion) {
        for (const b of m.blocks) {
          minX = Math.min(minX, b.p1.x, b.p2.x);
          minY = Math.min(minY, b.p1.y, b.p2.y);
          maxX = Math.max(maxX, b.p1.x, b.p2.x);
          maxY = Math.max(maxY, b.p1.y, b.p2.y);
        }
      }
    }
    if (!Number.isFinite(minX)) return null;
    const limitX = device.workingAreaMm.x * stepsPerMm;
    const limitY = device.workingAreaMm.y * stepsPerMm;
    const tol = 0.5;
    if (minX >= -tol && minY >= -tol && maxX <= limitX + tol && maxY <= limitY + tol) {
      return null;
    }
    const mm = (v: number) => (v / stepsPerMm).toFixed(1);
    const parts: string[] = [];
    if (minX < -tol) parts.push(`X 方向最小坐标 ${mm(minX)} mm 小于 0`);
    if (minY < -tol) parts.push(`Y 方向最小坐标 ${mm(minY)} mm 小于 0`);
    if (maxX > limitX + tol) parts.push(`X 方向最大坐标 ${mm(maxX)} mm 超出上限 ${mm(limitX)} mm`);
    if (maxY > limitY + tol) parts.push(`Y 方向最大坐标 ${mm(maxY)} mm 超出上限 ${mm(limitY)} mm`);
    return (
      `计划坐标超出设备工作范围（${device.workingAreaMm.x}×${device.workingAreaMm.y} mm）：` +
      `${parts.join("；")}。请缩小图形、更换纸张尺寸或调整排版后再试。`
    );
  }

  /** 依据请求头中的源文件名（X-Plot-Filename）、图层信息（X-Plot-Layers）
   * 与步进密度（X-Plot-Steps-Per-Mm）创建任务日志。测试环境跳过。 */
  function createPlotLogger(req: Request, plan: Plan, mode: string, stepsPerMm: number): PlotLogger | null {
    if (process.env.NODE_ENV === "test") {
      return null;
    }
    const header = req.headers["x-plot-filename"];
    const fileName = typeof header === "string" && header.trim().length > 0 ? header : "untitled.svg";
    // 图层信息为 URI 编码的 JSON（图层名可含中文等非 ASCII 字符）
    let layerInfo: { mode: string; layers: string[] } | null = null;
    const layersHeader = req.headers["x-plot-layers"];
    if (typeof layersHeader === "string" && layersHeader.length > 0) {
      try {
        const parsed = JSON.parse(decodeURIComponent(layersHeader));
        if (typeof parsed?.mode === "string" && Array.isArray(parsed?.layers)) {
          layerInfo = { mode: parsed.mode, layers: parsed.layers.map(String) };
        }
      } catch {
        console.warn(`Ignored malformed X-Plot-Layers header: ${layersHeader}`);
      }
    }
    let maxVelocityStepsS = 0;
    let estimatedDistanceSteps = 0;
    // 预计绘制距离只统计笔落段，与任务尾实际距离同口径（否则预计含
    // 抬笔空程而实际不含，两者可差数米）。笔状态沿动作序列模拟：
    // PenMotion 的 initialPos < finalPos 表示抬笔（伺服值越大笔越高），
    // 与 doPlot 的统计逻辑一致。
    let penIsUp = true;
    for (const m of plan.motions) {
      if (m instanceof XYMotion) {
        // 按 block 累加路径长度（动作级 p2-p1 只是首尾直线距离，
        // 对由上万短段组成的路径会低估数百倍）。注意 Plan 坐标处于
        // 全步进空间（mm×stepsPerMm），需除以步进密度换算为毫米。
        for (const b of m.blocks) {
          maxVelocityStepsS = Math.max(maxVelocityStepsS, b.vInitial, b.vFinal);
          if (!penIsUp) {
            estimatedDistanceSteps += vlen(vsub(b.p2, b.p1));
          }
        }
      } else if (m instanceof PenMotion) {
        penIsUp = m.initialPos < m.finalPos;
      }
    }
    const estimatedDistanceMm = estimatedDistanceSteps / stepsPerMm;
    const maxVelocityMmS = maxVelocityStepsS / stepsPerMm;
    const logger = new PlotLogger();
    logger
      .start({
        fileName,
        mode,
        layerMode: layerInfo?.mode,
        layers: layerInfo?.layers,
        hardware: ebb?.hardware ?? "sim",
        port: (ebb?.port as any)?._path ?? null,
        fifoDepth: ebb?.fifoDepth ?? -1,
        motionCount: plan.motions.length,
        estimatedDurationSec: plan.duration(),
        estimatedDistanceMm,
        maxVelocityMmS,
      })
      .catch((e) => console.warn(`Plot log start failed: ${(e as Error).message}`));
    return logger;
  }

  wss.on("connection", (ws) => {
    clients.push(ws);
    ws.on("message", (message) => {
      let msg: { c: string; p?: Record<string, unknown> };
      try {
        msg = JSON.parse(message.toString());
      } catch (e) {
        console.warn("Received malformed WebSocket message:", (e as Error).message);
        return;
      }
      switch (msg.c) {
        case "ping":
          ws.send(JSON.stringify({ c: "pong" }));
          break;
        case "limp":
          if (ebb) {
            // 挂起的 rejection 无人处理会成为 unhandled rejection，务必捕获。
            ebb.disableMotors().catch((e) => console.error("Limp failed:", e));
          }
          break;
        case "setPenHeight":
          if (ebb) {
            (async () => {
              // 超时兜底：绘制中该命令会排在绘图命令之后，取宽裕的 60s；
              // 队列卡死时至少能在日志中看到失败而不是静默挂起。
              if (await withTimeout(ebb.supportsSR(), 60000, "supportsSR")) {
                await withTimeout(ebb.setServoPowerTimeout(10000, true), 60000, "setServoPowerTimeout");
              }
              await withTimeout(ebb.setPenHeight(msg.p.height as number, msg.p.rate as number), 60000, "setPenHeight");
            })().catch((e) => console.error("Set pen height failed:", e));
          }
          break;
        case "changeHardware":
          ebb?.changeHardware(msg.p.hardware as Hardware);
          broadcast({ c: "dev", p: { path: (ebb?.port as any)?._path ?? null, hardware: msg.p.hardware } });
          break;
      }
    });

    // send starting params to clients
    ws.send(JSON.stringify({ c: "dev", p: getDeviceInfo(ebb) }));

    ws.send(JSON.stringify({ c: "pause", p: { paused: !!unpaused } }));
    if (motionIdx != null) {
      ws.send(JSON.stringify({ c: "progress", p: { motionIdx } }));
    }
    if (currentPlan != null) {
      ws.send(JSON.stringify({ c: "plan", p: { plan: currentPlan } }));
    }

    ws.on("close", () => {
      clients = clients.filter((w) => w !== ws);
    });
  });

  /**
   * /plot POST endpoint. Receive a plan on the POST body, and execute it.
   */
  app.post("/plot", async (req: Request, res: Response) => {
    if (plotting) {
      console.log("Received plot request, but a plot is already in progress!");
      res.status(400).send("Plot in progress");
      return;
    }
    plotting = true;
    controller = new AbortController();
    const { signal } = controller;
    try {
      const plan = Plan.deserialize(req.body);
      currentPlan = req.body;
      lastPlan = req.body;
      // 任务日志先启动，随后的 console 输出（含设备层诊断）自动进入日志文件
      const headerSpm = parseStepsPerMm(req);
      plotStepsPerMm = headerSpm ?? getDevice(ebb?.hardware ?? hardware).stepsPerMm;
      // 工作范围校验：超出设备行程即拒绝任务（任务不启动、日志不创建），
      // 防止撞轴。custom 硬件的真实行程只有前端知道（硬件设置中的安全
      // 工作区域，经请求头传入）；未配置时回退 Axidraw 档案仅告警。
      const hardwareId = ebb?.hardware ?? hardware;
      const customArea = isBuiltinHardware(hardwareId) ? null : parseWorkingArea(req);
      const areaDevice =
        customArea != null ? { ...getDevice(hardwareId), workingAreaMm: customArea } : getDevice(hardwareId);
      const outOfBounds = planOutOfBounds(plan, areaDevice, plotStepsPerMm);
      if (outOfBounds != null) {
        if (customArea != null || isBuiltinHardware(hardwareId)) {
          console.error(`拒绝绘制任务：${outOfBounds}`);
          res.status(400).send(outOfBounds);
          return;
        }
        console.warn(
          `custom 硬件未配置安全工作区域，按 Axidraw 档案校验超界（仅告警不拒绝）：${outOfBounds}` +
            `。请在硬件设置中填写工作区宽高后重试。`,
        );
      }
      plotLogger = createPlotLogger(req, plan, "plot", plotStepsPerMm);
      if (headerSpm == null) {
        console.warn(
          `缺少 X-Plot-Steps-Per-Mm 请求头，按硬件档案兜底 ${plotStepsPerMm} 步/mm。` +
            `custom 硬件下任务日志的距离/速度可能不准，请更新前端页面后重试。`,
        );
      }
      plottedDistanceMm = 0;
      console.log(`Received plan of estimated duration ${formatDuration(plan.duration())}`);
      console.log(ebb != null ? "Beginning plot..." : "Simulating plot...");
      res.status(200).end();

      const begin = Date.now();
      let failureReason: string | null = null;
      let wakeLock: { release(): void } | null = null;

      // The wake-lock module is macOS-only. Log the reminder once per process,
      // not on every plot — it's informational, not an error.
      if (process.platform === "darwin") {
        try {
          // Dynamically import wake-lock only on macOS
          const { WakeLock } = await import("wake-lock");
          wakeLock = new WakeLock("Bit2AtomBot plotting");
        } catch (_error) {
          console.warn("Couldn't acquire wake lock. Ensure your machine does not sleep during plotting");
        }
      } else if (!wakeLockReminderShown) {
        wakeLockReminderShown = true;
        console.log("Wake lock not available on this platform. Ensure your machine does not sleep during plotting");
      }
      try {
        await doPlot(ebb != null ? realPlotter : simPlotter, plan, signal, plotLogger);
        const end = Date.now();
        console.log(`Plot took ${formatDuration((end - begin) / 1000)}`);
      } catch (e) {
        // 兜底：此时 200 响应已发出，无法再改状态码；串口命令超时等
        // 失败若无人处理会成为 unhandled rejection。记录错误并广播
        // cancelled，让 UI 退出绘制状态（doPlot 的 finally 已清 motionIdx）。
        failureReason = (e as Error).message;
        console.error("Plot failed:", e);
        broadcast({ c: "cancelled" });
      } finally {
        if (wakeLock) {
          wakeLock.release();
        }
        const logger = plotLogger;
        plotLogger = null;
        await logger?.finish({
          status: failureReason != null ? "failed" : signal.aborted ? "cancelled" : "success",
          reason: failureReason ?? undefined,
          actualDurationSec: (Date.now() - begin) / 1000,
          actualDistanceMm: plottedDistanceMm,
        });
      }
    } finally {
      plotting = false;
      controller = null;
    }
  });

  app.get("/plot/status", (_req, res) => {
    res.json({ plotting });
  });

  app.post("/cancel", (_req: Request, res: Response) => {
    plotLogger?.line("PLOT", "收到取消请求");
    if (controller) {
      controller.abort();
      controller = null;
    }
    ebb?.cancel();
    pendingRewind = null;
    if (unpaused) {
      signalUnpause?.();
      broadcast({ c: "pause", p: { paused: false } });
    }
    unpaused = signalUnpause = null;
    res.status(200).end();
  });

  app.post("/pause", (_req: Request, res: Response) => {
    if (!unpaused) {
      unpaused = new Promise((resolve) => {
        signalUnpause = resolve;
      });
      plotLogger?.line("PLOT", `收到暂停请求（当前进度 ${motionIdx ?? "?"}）`);
      broadcast({ c: "pause", p: { paused: true } });
    }
    res.status(200).end();
  });

  app.post("/resume", (req: Request, res: Response) => {
    // Optional body: { rewindTo: motionIdx }. When present and the plan is
    // paused, execution rewinds to the nearest path-group start at or before
    // rewindTo (a pen-up travel move is inserted to get there safely) and
    // redraws from that point — useful to re-ink paths missed by a clogged pen.
    if (unpaused) {
      const rewindTo = req.body?.rewindTo;
      const validRewind = typeof rewindTo === "number" && Number.isFinite(rewindTo) && rewindTo >= 0;
      pendingRewind = validRewind ? rewindTo : null;
      plotLogger?.line("PLOT", validRewind ? `收到恢复请求（回溯至动作 ${rewindTo}）` : "收到恢复请求");
      signalUnpause();
      signalUnpause = unpaused = null;
    }
    res.status(200).end();
  });

  app.post("/redraw", async (req: Request, res: Response) => {
    // Body: { from: motionIdx, to: motionIdx } — after a finished (or
    // cancelled) plot, replay only the path groups covering [from, to).
    // Used to patch missing strokes without redoing the whole drawing.
    if (plotting) {
      console.log("Received redraw request, but a plot is already in progress!");
      res.status(400).send("Plot in progress");
      return;
    }
    if (!lastPlan) {
      res.status(409).send("没有可补画的任务：请先完成一次绘制");
      return;
    }
    if (lastPenPos == null) {
      res.status(409).send("笔当前位置未知（服务可能刚重启）。请先执行「笔回原点」后再补画");
      return;
    }
    const from = Number(req.body?.from);
    const to = Number(req.body?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) {
      res.status(400).send("无效的补画区间");
      return;
    }
    plotting = true;
    controller = new AbortController();
    const { signal } = controller;
    res.status(200).end();
    const begin = Date.now();
    let logger: PlotLogger | null = null;
    try {
      const plan = Plan.deserialize(lastPlan);
      const headerSpmRedraw = parseStepsPerMm(req);
      plotStepsPerMm = headerSpmRedraw ?? getDevice(ebb?.hardware ?? hardware).stepsPerMm;
      logger = createPlotLogger(req, plan, `redraw [${from}, ${to})`, plotStepsPerMm);
      if (headerSpmRedraw == null) {
        console.warn(
          `缺少 X-Plot-Steps-Per-Mm 请求头，按硬件档案兜底 ${plotStepsPerMm} 步/mm。` +
            `custom 硬件下任务日志的距离/速度可能不准，请更新前端页面后重试。`,
        );
      }
      plottedDistanceMm = 0;
      console.log(`Redrawing motions [${from}, ${to})`);
      await doPlot(ebb != null ? realPlotter : simPlotter, plan, signal, logger, { redrawFrom: from, redrawTo: to });
      console.log(`Redraw took ${formatDuration((Date.now() - begin) / 1000)}`);
      // 补画完成后自动归位：方便取纸检查，且保证位置跟踪始终已知，
      // 下次补画无需手动「笔回原点」。
      console.log("Auto-homing after redraw...");
      try {
        await homePenNow(plan);
      } catch (e) {
        const message = `补画后自动归位失败：${(e as Error).message}。请点击「笔回原点」重试；若仍失败，请重新连接设备后再试。`;
        console.error(message);
        broadcast({ c: "home-failed", p: { message } });
      }
    } catch (e) {
      // 同 /plot：防止 async rejection 使进程崩溃，并让 UI 退出绘制状态。
      console.error("Redraw failed:", e);
      broadcast({ c: "cancelled" });
      logger?.line("ERROR", `Redraw failed: ${(e as Error).message}`);
    } finally {
      const finishLogger = logger ?? plotLogger;
      logger = null;
      plotLogger = null;
      await finishLogger?.finish({
        status: signal.aborted ? "cancelled" : "success",
        actualDurationSec: (Date.now() - begin) / 1000,
        actualDistanceMm: plottedDistanceMm,
        fifoDepth: ebb?.fifoDepth ?? -1,
      });
      plotting = false;
      controller = null;
    }
  });

  // Reject if the underlying promise neither resolves nor rejects within ms.
  // EBB serial commands otherwise wait forever on a missed response, which
  // would wedge `plotting` and silently swallow later /home requests.
  function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      p.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  // Lift the pen and return the carriage to the plan's pen home.
  // IMPORTANT: this must NOT use the HM command. HM moves to the EBB's
  // absolute origin, which is reset to the CURRENT position whenever the
  // motors are re-enabled (EM). By the time we get here, postPlot has already
  // disabled the motors, so enableMotors() + HM is a zero-length no-op —
  // the pen stays put and HM even reports instant success. (Homing only
  // works via HM when the motors have stayed enabled since the plot began,
  // which is why postCancel's HM does work.) Instead, travel home the same
  // way the redraw initial travel does: a pen-up XY motion in plan space
  // from the tracked lastPenPos, which does not depend on EBB origin state.
  // Throws on failure instead of swallowing the error, so /home can return a
  // 500 (UI alert) and /redraw can broadcast the failure to the UI.
  async function homePenNow(plan: Plan | null): Promise<void> {
    let home: Vec2 = { x: 0, y: 0 };
    if (ebb) {
      // 分步耗时统计：归位是补画后的关键恢复环节，输出每步耗时便于
      // 监控性能与定位偶发卡顿（如 travel 异常变慢 = 机械阻力/固件问题）。
      const homeStart = Date.now();
      const stepTimes: string[] = [];
      let stepStart = homeStart;
      const markStep = (label: string) => {
        const now = Date.now();
        stepTimes.push(`${label} ${((now - stepStart) / 1000).toFixed(1)}s`);
        stepStart = now;
      };
      try {
        // 通信探活：若命令队列因丢失响应而卡死，后续命令会永远排队、
        // 笔一动不动且无任何报错。先用短超时探测；失败则清空队列
        // （等一个沉降期让孤儿响应排空）后重试一次，仍失败则明确抛错。
        try {
          await withTimeout(ebb.query("QM"), 5000, "通信探测(QM)");
        } catch (probeErr) {
          console.warn("Home probe failed, flushing command queue and retrying once...", probeErr);
          ebb.cancel();
          await new Promise((resolve) => setTimeout(resolve, 700)); // 覆盖 500ms 沉降期
          await withTimeout(ebb.query("QM"), 5000, "通信探测重试(QM)");
          console.log("Home probe recovered after queue flush.");
        }
        markStep("probe");
        const firstXY = plan?.motions.find((m): m is XYMotion => m instanceof XYMotion);
        if (firstXY) home = firstXY.p1;
        const device = getDevice(ebb.hardware);
        const penMotion = plan?.motions.find((m): m is PenMotion => m instanceof PenMotion);
        const penUp = penMotion ? Math.max(penMotion.initialPos, penMotion.finalPos) : device.penPctToPos(50);
        console.log("Home: lifting pen...");
        await withTimeout(ebb.setPenHeight(penUp, 1000), 15000, "setPenHeight");
        markStep("pen");
        console.log("Home: enabling motors...");
        await withTimeout(ebb.enableMotors(1), 15000, "enableMotors"); // 16x microstepping, matches prePlot
        markStep("motors");
        if (plan != null && lastPenPos != null && (lastPenPos.x !== home.x || lastPenPos.y !== home.y)) {
          console.log(`Home: travelling to pen home from (${lastPenPos.x}, ${lastPenPos.y})...`);
          const travel = rewindTravelMotion(plan, lastPenPos, home);
          await withTimeout(ebb.executeMotion(travel), 150000, "travelHome");
        } else if (lastPenPos == null) {
          // 位置未知（如服务重启后未绘制过）：无法构造安全的行程移动，
          // 只能尽力用 HM——若 EBB 的原点恰好未被重置（电机未经历关开循环）
          // 它仍会归位，否则为空操作。真正的恢复手段是重新对齐机械原点。
          console.log("Home: position unknown, best-effort HM...");
          await withTimeout(ebb.command("HM,4000"), 150000, "HM");
        } else {
          console.log("Home: pen already at home, no travel needed.");
        }
        markStep("travel");
        console.log("Home: waiting for motors to idle...");
        await withTimeout(ebb.waitUntilMotorsIdle(140000), 150000, "waitUntilMotorsIdle");
        markStep("idle");
        console.log("Home: disabling motors...");
        await withTimeout(ebb.disableMotors(), 15000, "disableMotors");
        markStep("disable");
        lastPenPos = home;
        console.log(`Home: done in ${((Date.now() - homeStart) / 1000).toFixed(1)}s (${stepTimes.join(", ")}).`);
      } catch (e) {
        console.error(
          `Home failed after ${((Date.now() - homeStart) / 1000).toFixed(1)}s (${stepTimes.join(", ")}):`,
          e,
        );
        // 归位失败时位置不可信，标记为未知（下次补画前需重新归位），
        // 并清空可能卡死的命令队列，让后续命令可以重新尝试。
        lastPenPos = null;
        ebb.cancel();
        // 归位中止时电机可能仍处于使能状态（锁轴），尽量关闭。
        try {
          await withTimeout(ebb.disableMotors(), 5000, "disableMotors(fallback)");
        } catch {
          /* ignore */
        }
        throw e;
      }
    } else {
      lastPenPos = home;
    }
  }

  app.post("/home", async (_req: Request, res: Response) => {
    if (plotting) {
      res.status(400).send("Plot in progress");
      return;
    }
    try {
      const plan = lastPlan ? Plan.deserialize(lastPlan) : null;
      await homePenNow(plan);
      res.status(200).end();
    } catch (e) {
      res.status(500).send(`归位失败：${(e as Error).message}`);
    }
  });

  function broadcast(msg: Record<string, unknown>) {
    for (const client of clients) {
      try {
        client.send(JSON.stringify(msg));
      } catch (e) {
        console.warn(e);
      }
    }
  }

  interface Plotter {
    prePlot: (initialPenHeight: number) => Promise<void>;
    executeMotion: (m: Motion, progress: [number, number]) => Promise<void>;
    postCancel: (initialPenHeight: number, drainTimeoutMs: number) => Promise<void>;
    postPlot: (drainTimeoutMs: number, penUpHeight: number) => Promise<void>;
  }

  const realPlotter: Plotter = {
    async prePlot(initialPenHeight: number): Promise<void> {
      // 全部命令加超时：若串口命令队列已卡死（如上次归位失败遗留），
      // 这些命令会永远挂起且 plotting 卡在 true，后续一切请求被拒。
      // 超时快速失败，由 /plot 的 catch 兜底复位并通知 UI。
      await withTimeout(ebb.configureFifoDepth(), 15000, "prePlot:configureFifoDepth");
      await withTimeout(ebb.enableMotors(1), 15000, "prePlot:enableMotors"); // 16x microstepping, matches defaults from Axidraw
      await withTimeout(ebb.setPenHeight(initialPenHeight, 1000, 1000), 15000, "prePlot:setPenHeight");
    },
    async executeMotion(motion: Motion, progress: [number, number]): Promise<void> {
      // 150s 下限用于短动作的卡死检测；但单条长动作（如由上万短段组成的
      // 巨长路径，或被速率钳制减速的高速行程）在设备侧的真实执行时长可达
      // 数十分钟——FIFO=1 时主机会同步等设备画完，硬性 150s 必然误杀。
      // 超时上限按钳制后的估计执行时长 + 60s 裕量动态放宽。
      const estimatedMs = ebb.estimateMotionDurationSec(motion) * 1000;
      const timeoutMs = Math.max(150_000, estimatedMs + 60_000);
      try {
        await withTimeout(ebb.executeMotion(motion), timeoutMs, "executeMotion");
      } catch (e) {
        // 命令应答丢失/设备引擎停摆会让队列头永久挂起；响应按入队顺序匹配，
        // 之后所有命令的响应都会错位。清空队列并等过沉降期（孤儿应答会被
        // 丢弃），让 postPlot 的抬笔/断使能兜底能正确送达设备。
        ebb.cancel();
        await new Promise((resolve) => setTimeout(resolve, 600));
        try {
          console.log(
            `QM after motion failure at ${progress[0] + 1}/${progress[1]} (${motion.constructor.name}):`,
            await withTimeout(ebb.query("QM"), 5000, "QM probe"),
          );
        } catch {
          console.log("QM probe failed (device not responding)");
        }
        throw e;
      }
    },
    async postCancel(initialPenHeight: number, drainTimeoutMs: number): Promise<void> {
      // The board may still be executing motion queued in its FIFO; issuing
      // HM while moving makes the steppers grind against whatever they're doing.
      // 深FIFO（fw≥3.0）下主机会领先设备最多 depth 条动作，取消时设备侧
      // 积压可达数分钟，固定 60s 不够——由 doPlot 按 plan 时长传排空上限。
      try {
        await withTimeout(
          ebb.waitUntilMotorsIdle(drainTimeoutMs),
          drainTimeoutMs + 5000,
          "postCancel:waitUntilMotorsIdle",
        );
      } catch (e) {
        // 排空超时（设备故障/积压异常）：先尽力抬笔（避免笔压在纸上），
        // 再断使能避免长期锁轴，最后抛出让上层通知 UI。
        try {
          await withTimeout(ebb.setPenHeight(initialPenHeight, 1000), 15000, "postCancel:setPenHeight(fallback)");
        } catch {
          /* ignore */
        }
        try {
          await withTimeout(ebb.disableMotors(), 15000, "postCancel:disableMotors(fallback)");
        } catch {
          /* ignore */
        }
        throw e;
      }
      await withTimeout(ebb.setPenHeight(initialPenHeight, 1000), 15000, "postCancel:setPenHeight");
      // 此处 HM 是安全的：绘制全程电机保持使能，EBB 原点未被重置（见 homePenNow 注释）。
      await withTimeout(ebb.command("HM,4000"), 150000, "postCancel:HM"); // HM returns carriage home without 3rd and 4th arguments
    },
    async postPlot(drainTimeoutMs: number, penUpHeight: number): Promise<void> {
      try {
        await withTimeout(
          ebb.waitUntilMotorsIdle(drainTimeoutMs),
          drainTimeoutMs + 5000,
          "postPlot:waitUntilMotorsIdle",
        );
      } catch (e) {
        // 排空超时（设备故障/积压异常）：设备可能停在动作中途，先尽力抬笔
        //（避免笔尖压在纸上），再断使能避免长期锁轴，最后抛出。
        try {
          await withTimeout(ebb.setPenHeight(penUpHeight, 1000), 15000, "postPlot:setPenHeight(fallback)");
        } catch {
          /* ignore */
        }
        try {
          await withTimeout(ebb.disableMotors(), 15000, "postPlot:disableMotors(fallback)");
        } catch {
          /* ignore */
        }
        throw e;
      }
      await withTimeout(ebb.disableMotors(), 15000, "postPlot:disableMotors");
    },
  };

  const simPlotter: Plotter = {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    async prePlot(_initialPenHeight: number): Promise<void> {},
    async executeMotion(motion: Motion, progress: [number, number]): Promise<void> {
      console.log(`Motion ${progress[0] + 1}/${progress[1]}`);
      await new Promise((resolve) => setTimeout(resolve, motion.duration() * 1000));
    },
    async postCancel(_initialPenHeight: number, _drainTimeoutMs: number): Promise<void> {
      console.log("Plot cancelled");
    },
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    async postPlot(_drainTimeoutMs: number, _penUpHeight: number): Promise<void> {},
  };

  async function doPlot(
    plotter: Plotter,
    plan: Plan,
    signal: AbortSignal,
    logger: PlotLogger | null = null,
    opts?: { redrawFrom?: number; redrawTo?: number },
  ): Promise<void> {
    const abortPromise = onceAbort(signal); // reuse abort promise
    unpaused = null;
    signalUnpause = null;
    pendingRewind = null;
    motionIdx = 0;

    // Redraw-range mode: replay only the path groups covering [redrawFrom,
    // redrawTo) instead of the whole plan, after travelling safely to the
    // start of the range.
    const redrawFrom = typeof opts?.redrawFrom === "number" ? opts.redrawFrom : null;
    const redrawTo = typeof opts?.redrawTo === "number" ? opts.redrawTo : null;
    const isRedraw = redrawFrom != null && redrawTo != null;
    const endIdx = isRedraw ? Math.max(0, Math.min(redrawTo, plan.motions.length)) : plan.motions.length;

    const firstPenMotion = plan.motions.find((x) => x instanceof PenMotion) as PenMotion | undefined;
    if (!firstPenMotion) {
      throw new Error("Plan contains no PenMotion; cannot determine initial pen height");
    }
    // 深FIFO（fw≥3.0）下 LM 进入设备侧 FIFO 即响应，主机可领先设备最多
    // depth 条动作。motion 循环发完后设备可能仍有大量积压（高密度 SVG
    // 的短动作尤其多），固定 60s 排空会误报「电机未归位」。积压时长至多
    // 等于计划剩余总时长，用它 + 60s 裕量作为排空上限。注意按钳制后的
    // 估计时长计算（plan.duration() 按未钳制速度算，高速行程被钳制时会
    // 低估数倍）。
    let estimatedBusySec = 0;
    for (const m of plan.motions) {
      // 模拟模式（ebb == null，无设备）下无设备侧积压，估 0 → 60s 下限。
      estimatedBusySec += ebb?.estimateMotionDurationSec(m) ?? 0;
    }
    const drainTimeoutMs = Math.ceil(estimatedBusySec * 1000) + 60_000;
    await plotter.prePlot(firstPenMotion.initialPos);

    let penIsUp = true;
    let plotError: unknown = null;
    let cleanupFailure: unknown = null;
    try {
      // Current pen position. For a fresh plot the pen starts at the plan's
      // initial pen home (p1 of the first travel move); for a redraw-range run
      // it resumes from wherever the previous run left it (tracked across
      // plots by |lastPenPos|).
      let curPos: Vec2 | null = null;
      if (isRedraw) {
        curPos = lastPenPos;
      } else {
        for (const m of plan.motions) {
          if (m instanceof XYMotion) {
            curPos = m.p1;
            break;
          }
        }
      }
      lastPenPos = curPos;

      let idx = isRedraw ? snapToGroupStart(plan, redrawFrom) : 0;

      // Redraw mode: safe pen-up travel from the parked position to the
      // start of the requested range before replaying it.
      if (isRedraw && curPos != null) {
        const goal = plan.motions[idx];
        if (goal instanceof XYMotion && (goal.p1.x !== curPos.x || goal.p1.y !== curPos.y)) {
          const travel = rewindTravelMotion(plan, curPos, goal.p1);
          await Promise.race([plotter.executeMotion(travel, [idx, endIdx]), abortPromise]);
          curPos = goal.p1;
          lastPenPos = curPos;
        }
      }

      while (idx < endIdx) {
        const motion = plan.motions[idx];
        motionIdx = idx;
        broadcast({ c: "progress", p: { motionIdx: idx } });

        await Promise.race([plotter.executeMotion(motion, [idx, endIdx]), abortPromise]);

        if (motion instanceof XYMotion) {
          // 落笔状态下移动才算实际绘制距离（抬笔的行程移动不计入）。
          // 按 block 累加真实路径长度，并除以步进密度换算为毫米
          // （Plan 坐标处于全步进空间 mm×stepsPerMm）。
          if (!penIsUp) {
            for (const b of motion.blocks) {
              plottedDistanceMm += vlen(vsub(b.p2, b.p1)) / plotStepsPerMm;
            }
          }
          curPos = motion.p2;
          lastPenPos = curPos;
        }
        if (motion instanceof PenMotion) {
          penIsUp = motion.initialPos < motion.finalPos;
        }
        logger?.progress(idx + 1, endIdx, plottedDistanceMm);

        if (unpaused && penIsUp) {
          await Promise.race([unpaused, abortPromise]);
          // Resumed. If a rewind was requested, safely travel (pen up) to
          // the start of the target path group and redraw from there.
          // (pause:false must be broadcast on every resume path — including
          // rewinds — so the UI leaves the paused state and can pause/rewind
          // again during the redraw.)
          if (pendingRewind != null && curPos != null) {
            const target = snapToGroupStart(plan, pendingRewind);
            pendingRewind = null;
            if (target < idx) {
              const goal = plan.motions[target];
              if (goal instanceof XYMotion) {
                broadcast({ c: "pause", p: { paused: false } });
                const travel = rewindTravelMotion(plan, curPos, goal.p1);
                let travelMm = 0;
                for (const b of travel.blocks) {
                  travelMm += vlen(vsub(b.p2, b.p1));
                }
                plotLogger?.line("PLOT", `回溯：进度 ${idx} → ${target}（抬笔行程 ${(travelMm / plotStepsPerMm).toFixed(1)} mm）`);
                await Promise.race([plotter.executeMotion(travel, [idx, endIdx]), abortPromise]);
                curPos = goal.p1;
                lastPenPos = curPos;
                idx = target;
                continue;
              }
            }
          }
          pendingRewind = null;
          broadcast({ c: "pause", p: { paused: false } });
        }

        idx += 1;
      }

      broadcast({ c: "finished" });
    } catch (err) {
      if (signal.aborted) {
        await plotter.postCancel(firstPenMotion.initialPos, drainTimeoutMs);
        // The pen was homed (HM), which is the plan's initial pen home.
        for (const m of plan.motions) {
          if (m instanceof XYMotion) {
            lastPenPos = m.p1;
            break;
          }
        }
        broadcast({ c: "cancelled" });
        return;
      }
      plotError = err; // 错误路径的 finally 用短排空尽快收尾（取消路径保留长排空）
      throw err; // propagate real errors
    } finally {
      motionIdx = null;
      currentPlan = null;
      // 出错路径下设备通常很快停止（或已停摆），按计划总时长的长排空毫无
      // 意义，只会让抬笔/断使能兜底迟到：错误路径用短超时尽快收尾。
      // 取消路径保留长排空（设备可能仍有大量积压需要画完再 HM）。
      const cleanupDrainMs = plotError != null ? 60_000 : drainTimeoutMs;
      try {
        await plotter.postPlot(cleanupDrainMs, firstPenMotion.initialPos);
      } catch (cleanupErr) {
        if (plotError != null || signal.aborted) {
          // 主流程已失败或已取消：仅记录清理失败，避免覆盖原始错误
          console.error("Plot cleanup failed:", cleanupErr);
        } else {
          cleanupFailure = cleanupErr;
        }
      }
    }
    if (cleanupFailure != null) {
      throw cleanupFailure;
    }
  }

  function onceAbort(signal: AbortSignal): Promise<never> {
    return new Promise((_resolve, reject) => {
      signal.throwIfAborted();
      signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    });
  }

  return new Promise<http.Server>((resolve) => {
    server.listen(port, () => {
      async function connect() {
        const devices = ebbs(com, hardware);
        for await (const device of devices) {
          ebb = device;
          broadcast({ c: "dev", p: getDeviceInfo(ebb) });
        }
      }
      connect();
      const { family, address, port } = server.address() as AddressInfo;
      const addr = `${family === "IPv6" ? `[${address}]` : address}:${port}`;
      console.log(`Server listening on http://${addr}`);
      resolve(server);
    });
  });
}

async function tryOpen(com: Com) {
  const port = new SerialPortSerialPort(com);
  await port.open({ baudRate: 9600 });
  return port;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEBB(p: PortInfo): boolean {
  return (
    p.manufacturer === "SchmalzHaus" ||
    p.manufacturer === "SchmalzHaus LLC" ||
    (p.vendorId === "04D8" && p.productId === "FD92")
  );
}

async function listEBBs() {
  const Binding = autoDetect();
  const ports = await Binding.list();
  return ports.filter(isEBB).map((p: { path: string }) => p.path);
}

export async function waitForEbb(): Promise<Com> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ebbs = await listEBBs();
    if (ebbs.length) {
      return ebbs[0];
    }
    await sleep(5000);
  }
}

async function* ebbs(path?: string, hardware: Hardware = "v3") {
  while (true) {
    try {
      const com: Com = path || (await _self.waitForEbb()); // use self-import for test mocking
      console.log(`Found EBB at ${com}`);
      const port = await tryOpen(com);
      const closed = new Promise((resolve) => {
        port.addEventListener("disconnect", resolve, { once: true });
      });
      yield new EBB(port, hardware);
      await closed;
      yield null;
      console.error("Lost connection to EBB, reconnecting...");
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.error(`Error connecting to EBB: ${err.message}`);
      console.error("Retrying in 5 seconds...");
      await sleep(5000);
    }
  }
}

export async function connectEBB(hardware: Hardware, device?: string): Promise<EBB | null> {
  const dev = device ?? (await listEBBs())[0];
  if (!dev) return null;

  const port = await tryOpen(dev);
  return new EBB(port, hardware);
}
