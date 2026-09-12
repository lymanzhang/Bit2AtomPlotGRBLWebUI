/**
 * Backend web server for controlling GRBL plotters.
 * Serve both the front end UI as static files - made with React, and backend
 * API for controlling the device.
 * Keep open web sockets to the front end for real-time updates.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { autoDetect } from "@serialport/bindings-cpp";
import cors from "cors";
import type { Request, Response } from "express";
import express from "express";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { type DeviceController } from "./device-controller.js";
import { GrblController, type GrblControllerOptions } from "./grbl-controller.js";
import { describeGrblAlarm, type GrblStatus } from "./grbl.js";
import { GrblSimulator } from "./simulator.js";
import { PlotLogger } from "./plot-log.js";
import {
  compareGrblSettings,
  type DriveParams,
  defaultPlanOptions,
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
import { formatDuration } from "./util.js";
import { type Vec2, vlen, vsub } from "./vec.js";

type Com = string;

/** 设备驱动种类：grbl = GRBL 固件设备（真实串口），sim = 内置虚拟 GRBL
 * 设备（无硬件全流程演示/测试）。 */
export type DriverKind = "grbl" | "sim";

/** 设备信息速记（串口路径 + 硬件档案标识） */
const getDeviceInfo = (device: DeviceController | null) => {
  const portPath = (device?.port as any)?._path ?? null;
  return { path: portPath, hardware: device?.hardware ?? "custom" };
};

/**
 * Start the express server.
 * @param port
 * @param com
 * @param enableCors
 * @param maxPayloadSize
 * @param driver
 * @returns
 */
export async function startServer(
  port: number,
  com: Com = "",
  enableCors = false,
  maxPayloadSize = "200mb",
  driver: DriverKind = "grbl",
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

  // 设备控制器：执行路径仅面向 DeviceController 契约（任务 1.3）
  let device: DeviceController | null;
  let deviceKind: "grbl" | null = null;
  // GRBL 档案（2.7）：初值取默认档案，UI 连接后经 ws changeDriveParams
  // 持续同步（档案编辑/参数助手反向同步均会触发），保证服务端执行层
  // （Z 配置/限速/工作区）与前端档案一致。
  let grblDriveParams: DriveParams = defaultPlanOptions.driveParams;
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
  // initial pen home. Null after server start (position unknown).
  let lastPenPos: Vec2 | null = null;
  // Serialized plan of the last plot, kept after completion for /redraw.
  let lastPlan: MotionData[] | null = null;
  // The "wake lock unavailable" reminder is informational; only print it once.
  let wakeLockReminderShown = false;
  // 当前绘制任务的文件级日志（每次 /plot 或 /redraw 一个文件，与源文件同名）
  let plotLogger: PlotLogger | null = null;
  // 当前任务已实际绘制的距离（mm），由 doPlot 累加
  let plottedDistanceMm = 0;

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

  /** 扫描计划坐标范围（毫米口径，含落笔路径、抬笔空程与首尾行程）。
   * 无坐标动作时返回 null。 */
  function planBounds(plan: Plan): { minX: number; minY: number; maxX: number; maxY: number } | null {
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
    return { minX, minY, maxX, maxY };
  }

  /** 依据计划范围与设备工作区（mm）判断超界，超界时返回给用户的描述
   * 信息，未超界返回 null。容差 0.1mm 吸收浮点误差。 */
  function planOutOfBounds(plan: Plan, area: { x: number; y: number }): string | null {
    const b = planBounds(plan);
    if (!b) return null;
    const { minX, minY, maxX, maxY } = b;
    const limitX = area.x;
    const limitY = area.y;
    const tol = 0.1;
    if (minX >= -tol && minY >= -tol && maxX <= limitX + tol && maxY <= limitY + tol) {
      return null;
    }
    const mm = (v: number) => v.toFixed(1);
    const parts: string[] = [];
    if (minX < -tol) parts.push(`X 方向最小坐标 ${mm(minX)} mm 小于 0`);
    if (minY < -tol) parts.push(`Y 方向最小坐标 ${mm(minY)} mm 小于 0`);
    if (maxX > limitX + tol) parts.push(`X 方向最大坐标 ${mm(maxX)} mm 超出上限 ${mm(limitX)} mm`);
    if (maxY > limitY + tol) parts.push(`Y 方向最大坐标 ${mm(maxY)} mm 超出上限 ${mm(limitY)} mm`);
    return (
      `计划坐标超出设备工作范围（${area.x}×${area.y} mm）：` +
      `${parts.join("；")}。请缩小图形、更换纸张尺寸或调整排版后再试。`
    );
  }

  /** 依据请求头中的源文件名（X-Plot-Filename）与图层信息（X-Plot-Layers）
   * 创建任务日志。测试环境跳过。 */
  function createPlotLogger(req: Request, plan: Plan, mode: string): PlotLogger | null {
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
    let maxVelocityMmS = 0;
    let estimatedDistanceMm = 0;
    // 预计绘制距离只统计笔落段，与任务尾实际距离同口径（否则预计含
    // 抬笔空程而实际不含，两者可差数米）。笔状态沿动作序列模拟：
    // PenMotion 位置为 penPct 口径，initialPos > finalPos 表示抬笔
    // （pct 越大笔越低），与 doPlot 的统计逻辑一致。
    let penIsUp = true;
    for (const m of plan.motions) {
      if (m instanceof XYMotion) {
        // 按 block 累加路径长度（动作级 p2-p1 只是首尾直线距离，
        // 对由上万短段组成的路径会低估数百倍）。Plan 坐标为毫米口径。
        for (const b of m.blocks) {
          maxVelocityMmS = Math.max(maxVelocityMmS, b.vInitial, b.vFinal);
          if (!penIsUp) {
            estimatedDistanceMm += vlen(vsub(b.p2, b.p1));
          }
        }
      } else if (m instanceof PenMotion) {
        penIsUp = m.initialPos > m.finalPos;
      }
    }
    const logger = new PlotLogger();
    logger
      .start({
        fileName,
        mode,
        layerMode: layerInfo?.mode,
        layers: layerInfo?.layers,
        hardware: device?.hardware ?? "sim",
        port: (device?.port as any)?._path ?? null,
        fifoDepth: device?.fifoDepth ?? -1,
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
          if (device) {
            // 挂起的 rejection 无人处理会成为 unhandled rejection，务必捕获。
            device.disableMotors().catch((e) => console.error("Limp failed:", e));
          }
          break;
        case "setPenHeight":
          if (device) {
            (async () => {
              // 超时兜底：绘制中该命令会排在绘图命令之后，取宽裕的 60s；
              // 队列卡死时至少能在日志中看到失败而不是静默挂起。
              await withTimeout(device.setPenHeight(msg.p.height as number, msg.p.rate as number), 60000, "setPenHeight");
            })().catch((e) => console.error("Set pen height failed:", e));
          }
          break;
        case "changeHardware": {
          device?.changeHardware(msg.p.hardware as string);
          broadcast({ c: "dev", p: { path: (device?.port as any)?._path ?? null, hardware: msg.p.hardware } });
          break;
        }
        case "changeDriveParams": {
          // 2.7 参数助手：UI 档案编辑/反向同步后全量推送。更新服务端档案
          // 副本（工作区参与超界校验），并同步到已连接的 GRBL 控制器
          // （Z 抬笔配置 + 限速钳制）。
          const dp = msg.p?.driveParams as DriveParams | undefined;
          if (dp && typeof dp === "object") {
            grblDriveParams = { ...defaultPlanOptions.driveParams, ...dp };
            if (deviceKind === "grbl" && device instanceof GrblController) {
              device.applyDriveParams(grblDriveParams);
            }
          }
          break;
        }
      }
    });

    // send starting params to clients
    ws.send(JSON.stringify({ c: "dev", p: getDeviceInfo(device) }));

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
    // 无设备静默回退模拟绘制曾是开发期便利，会让用户在未接机时误启「绘制」。
    // 现明确拒绝（UI 弹窗提示）；仅 --driver sim 模式保留模拟绘制。
    if (driver !== "sim" && device == null) {
      console.warn("Received plot request, but no GRBL device is connected");
      res.status(409).send("GRBL 设备未连接：设备插入后服务端会自动连接；如需无硬件试跑，请用 --driver sim 启动");
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
      // 工作范围校验：超出设备行程即拒绝任务（任务不启动、日志不创建），
      // 防止撞轴。Plan 为毫米口径，直接与工作区（mm）比较。工作区来源
      // 优先级：前端请求头（custom 硬件安全区域）> GRBL 档案
      // workingAreaMm。未配置工作区时跳过服务端校验（固件 $20 软限位
      // 检查仍会兜底）。
      const area = parseWorkingArea(req) ?? grblDriveParams.workingAreaMm ?? null;
      if (area != null) {
        const outOfBounds = planOutOfBounds(plan, area);
        if (outOfBounds != null) {
          console.error(`拒绝绘制任务：${outOfBounds}`);
          res.status(400).send(outOfBounds);
          return;
        }
      }
      // 3.6 软限位协同（仅 GRBL）：设备 $20 开启时与固件软限位双保险，
      // 计划超出 $130/$131 行程则提前拒绝（避免绘制中途 ALARM:2）。
      if (deviceKind === "grbl" && device instanceof GrblController) {
        const softLimitViolation = await grblSoftLimitCheck(device, planBounds(plan));
        if (softLimitViolation != null) {
          console.error(`拒绝绘制任务：${softLimitViolation}`);
          res.status(400).send(softLimitViolation);
          return;
        }
      }
      plotLogger = createPlotLogger(req, plan, "plot");
      plottedDistanceMm = 0;
      console.log(`Received plan of estimated duration ${formatDuration(plan.duration())}`);
      console.log(device != null ? "Beginning plot..." : "Simulating plot...");
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
        await doPlot(device != null ? realPlotter : simPlotter, plan, signal, plotLogger);
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
    // penPosKnown：笔位置跟踪是否已知（3.1）。false = 服务刚重启/归位失败，
    // 补画前须先「笔回原点」（/redraw 会以 409 拒绝）。
    res.json({ plotting, device: deviceKind, penPosKnown: lastPenPos != null });
  });

  // ---- 2.7 参数助手：设备 $$ 实值 vs 档案换算值 ----

  /** GRBL 参数助手公共守卫：仅 GRBL 驱动、绘制中拒绝（$$/写入与绘制流
   * 共用命令队列，且写入要求 Idle）。返回 null 表示通过，否则已响应。 */
  function grblParamsGuard(res: Response): GrblController | null {
    if (deviceKind !== "grbl" || !(device instanceof GrblController)) {
      res.status(400).send("参数助手仅支持 GRBL 驱动");
      return null;
    }
    if (plotting) {
      res.status(400).send("绘制进行中，无法访问设备参数");
      return null;
    }
    return device;
  }

  /** 读取设备 $$ 全量参数并按请求体中的档案换算对照。响应：
   * { settings, comparisons }（comparisons 元素见 GrblParamComparison）。 */
  app.post("/grbl/params", async (req: Request, res: Response) => {
    const gc = grblParamsGuard(res);
    if (!gc) return;
    const dp: DriveParams = { ...defaultPlanOptions.driveParams, ...(req.body ?? {}) };
    try {
      // 常规命令 15s 超时纪律；失败交由前端弹窗
      const settings = await withTimeout(gc.grbl.querySettings(), 15000, "querySettings");
      res.json({ settings, comparisons: compareGrblSettings(dp, settings) });
    } catch (e) {
      res.status(500).send(`读取设备参数失败：${(e as Error).message}`);
    }
  });

  /** 一键写入：将档案建议值写入设备 EEPROM（$100–$102）。请求体
   * { settings: { "100": 80, ... } }；逐条 `$N=value` 写入并收集结果。 */
  app.post("/grbl/params/write", async (req: Request, res: Response) => {
    const gc = grblParamsGuard(res);
    if (!gc) return;
    const settings = req.body?.settings as Record<string, unknown> | undefined;
    if (!settings || typeof settings !== "object") {
      res.status(400).send("缺少 settings 参数");
      return;
    }
    const written: string[] = [];
    const errors: { key: string; message: string }[] = [];
    for (const [key, value] of Object.entries(settings)) {
      // 参数号白名单校验：仅允许 $0–$9999 数值参数，拒绝任意行注入
      if (!/^\d{1,4}$/.test(key) || typeof value !== "number" || !Number.isFinite(value)) {
        errors.push({ key, message: "非法参数号或值" });
        continue;
      }
      try {
        await withTimeout(gc.grbl.run(`$${key}=${value}`), 15000, `write $${key}`);
        written.push(key);
      } catch (e) {
        errors.push({ key, message: (e as Error).message });
      }
    }
    res.json({ written, errors });
  });

  // ---- 3.5 Alarm 恢复：解锁（$X）----

  // 解锁是 Alarm 恢复的最后手段（设备不支持 $H 或归位反复失败）。$X 会
  // 丢失位置参考——lastPenPos 已被 Alarm 守卫置 null，解锁后必须先「笔回
  // 原点」（$H）或确认位置后才能补画。
  app.post("/grbl/unlock", async (_req, res) => {
    const gc = grblParamsGuard(res);
    if (!gc) return;
    try {
      const st = await withTimeout(gc.statusReport(2000), 5000, "unlock:status");
      if (st.state !== "Alarm") {
        res.status(409).send("设备不在 Alarm 状态，无需解锁");
        return;
      }
      await withTimeout(gc.unlock(), 15000, "$X 解锁");
      console.log("[bit2atombot] Device unlocked ($X); position reference is lost until re-homing");
      res.status(200).end();
    } catch (e) {
      res.status(500).send(`解锁失败：${(e as Error).message}`);
    }
  });

  app.post("/cancel", (_req: Request, res: Response) => {
    plotLogger?.line("PLOT", "收到取消请求");
    if (controller) {
      controller.abort();
      controller = null;
    }
    device?.cancel();
    // feedHold 立即冻结设备侧运动（planner 缓冲由 postCancel 软复位清空）
    if (device instanceof GrblController) {
      device.feedHold();
    }
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
    if (driver !== "sim" && device == null) {
      res.status(409).send("GRBL 设备未连接：设备插入后服务端会自动连接");
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
      logger = createPlotLogger(req, plan, `redraw [${from}, ${to})`);
      plottedDistanceMm = 0;
      console.log(`Redrawing motions [${from}, ${to})`);
      await doPlot(device != null ? realPlotter : simPlotter, plan, signal, logger, { redrawFrom: from, redrawTo: to });
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
        fifoDepth: device?.fifoDepth ?? -1,
      });
      plotting = false;
      controller = null;
    }
  });

  // Reject if the underlying promise neither resolves nor rejects within ms.
  // Serial commands otherwise wait forever on a missed response, which
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

  /** 双源位置校验容差（mm）：WPos 实测与主机跟踪位置偏差超过此值视为
   * 失步/外部干扰（软复位丢步、中途手动点动、机械打滑等）。 */
  const PEN_POS_TOLERANCE_MM = 1.0;

  /**
   * GRBL 双源位置校验（3.1）：主机按动作序列跟踪笔位（plan 坐标直接作为
   * 工作坐标下发，两者同处工作坐标系），设备 `?` 状态回报的 WPos 是物理
   * 真相。在排空后的安全点（暂停生效、绘制收尾）对照两者，偏差超容差时
   * 记录任务日志并返回实测值——调用方以它修正 lastPenPos/curPos，保证
   * 后续回溯/补画行程的起点真实。校验失败（无 WPos/超时）返回 null，
   * 不阻断主流程（位置维持主机跟踪值）。
   */
  async function grblVerifyPenPos(gc: GrblController, expected: Vec2, context: string): Promise<Vec2 | null> {
    try {
      const st = await withTimeout(gc.statusReport(2000), 5000, `位置校验(${context})`);
      if (!st.wpos) return null;
      const measured = { x: st.wpos.x, y: st.wpos.y };
      const driftMm = Math.hypot(measured.x - expected.x, measured.y - expected.y);
      if (driftMm <= PEN_POS_TOLERANCE_MM) return expected;
      const message =
        `位置校验（${context}）：跟踪 (${expected.x.toFixed(2)}, ${expected.y.toFixed(2)}) vs ` +
        `实测 WPos (${measured.x.toFixed(2)}, ${measured.y.toFixed(2)})，偏差 ${driftMm.toFixed(2)} mm，` +
        `已按实测修正（可能原因：软复位丢步/中途手动点动/机械打滑）`;
      console.warn(`[bit2atombot] ${message}`);
      plotLogger?.line("WARN", message);
      return measured;
    } catch (e) {
      console.warn(`[bit2atombot] 位置校验（${context}）失败：${(e as Error).message}`);
      return null;
    }
  }

  /**
   * 3.6 超界与软限位协同：服务端毫米口径校验（/plot 中 planOutOfBounds）
   * 是第一道防线；设备固件的 $20 软限位是第二道。绘制前读取设备 $$：
   * - $20=1 且计划范围超出软限位行程（$130/$131）→ 提前拒绝（400），
   *   避免绘制中途触发 ALARM:2（恢复流程见 3.5）；
   * - $20=0 → 仅提醒开启双保险（不拒绝，服务端校验仍然兜底）。
   *
   * 行程口径假设：工作坐标原点（对刀点）= 行程原点（笔绘仪典型对刀方式，
   * WPos 0 对应行程一角），故软限位行程 [0, $130]×[0, $131] 直接与计划
   * 工作坐标比较。G54 偏移非零的非常规对刀不在校验范围（固件仍会拦截）。
   * $$ 读取失败不阻断绘制（降级为仅服务端校验）。
   */
  async function grblSoftLimitCheck(
    gc: GrblController,
    bounds: { minX: number; minY: number; maxX: number; maxY: number } | null,
  ): Promise<string | null> {
    if (!bounds) return null;
    let settings: Record<string, string>;
    try {
      settings = await withTimeout(gc.grbl.querySettings(), 15000, "软限位检查($$)");
    } catch (e) {
      console.warn(`[bit2atombot] 软限位状态读取失败（不阻断，服务端校验仍兜底）：${(e as Error).message}`);
      return null;
    }
    if (settings["20"] !== "1") {
      console.warn(
        "[bit2atombot] 设备未启用软限位（$20=0）。超界防护仅依赖服务端校验；" +
          "建议开启 $20=1 并正确配置 $130/$131 行程作为第二道防线。",
      );
      return null;
    }
    const softMaxX = Number(settings["130"]);
    const softMaxY = Number(settings["131"]);
    // 未配置行程（非常见）时固件侧软限位无从判断，跳过预检
    if (!Number.isFinite(softMaxX) || !Number.isFinite(softMaxY)) return null;
    const tol = 0.1;
    const mm = (v: number) => v.toFixed(1);
    const parts: string[] = [];
    if (bounds.maxX > softMaxX + tol) {
      parts.push(`X 方向最大坐标 ${mm(bounds.maxX)} mm 超出软限位行程 ${mm(softMaxX)} mm（$130）`);
    }
    if (bounds.maxY > softMaxY + tol) {
      parts.push(`Y 方向最大坐标 ${mm(bounds.maxY)} mm 超出软限位行程 ${mm(softMaxY)} mm（$131）`);
    }
    if (parts.length === 0) return null;
    return (
      `设备已启用软限位（$20=1），计划${parts.join("；")}。绘制将被固件拦截（ALARM:2）。` +
      `请缩小图形或调整排版；若软限位行程配置与实际不符，请修正 $130/$131 后重试。`
    );
  }

  // Lift the pen and return the carriage to the plan's pen home. Travel is a
  // pen-up XY motion in plan space from the tracked lastPenPos (GRBL 工作坐
  // 标系直通，不依赖原点状态)。位置未知（如服务重启后未绘制过）时用 $H 归
  // 位重建位置参考。Throws on failure instead of swallowing the error, so
  // /home can return a 500 (UI alert) and /redraw can broadcast the failure
  // to the UI.
  async function homePenNow(plan: Plan | null): Promise<void> {
    let home: Vec2 = { x: 0, y: 0 };
    if (device) {
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
      // GRBL 状态探测结果：Alarm 恢复（3.5）需要先知道设备状态
      let grblStatus: GrblStatus | null = null;
      try {
        // 通信探活：若命令队列因丢失响应而卡死，后续命令会永远排队、
        // 笔一动不动且无任何报错。先用短超时探测；失败则清空队列
        // （等一个沉降期让孤儿响应排空）后重试一次，仍失败则明确抛错。
        try {
          grblStatus = await withTimeout((device as GrblController).statusReport(2000), 5000, "通信探测(status)");
        } catch (probeErr) {
          console.warn("Home probe failed, flushing command queue and retrying once...", probeErr);
          device.cancel();
          await new Promise((resolve) => setTimeout(resolve, 700)); // 覆盖 500ms 沉降期
          grblStatus = await withTimeout((device as GrblController).statusReport(2000), 5000, "通信探测重试(status)");
          console.log("Home probe recovered after queue flush.");
        }
        markStep("probe");
        // 3.5 Alarm 恢复：设备处于 Alarm 时唯一安全的恢复动作是 $H 归位
        //（重建位置参考并清除告警）。必须先于抬笔/行程执行——Alarm 下任何
        // G-code 都会被 error:9 拒绝。$H 失败（未装限位/再次撞限）时抛错，
        // 由用户决定改用「解锁设备」（$X）。
        if (grblStatus?.state === "Alarm") {
          const gc = device as GrblController;
          console.log("Home: device in Alarm, attempting $H to rebuild position reference...");
          await withTimeout(gc.home(), 150000, "$H（Alarm 恢复）");
          const st = await withTimeout(gc.statusReport(2000), 5000, "home:alarm-recovery-status");
          if (st.state === "Alarm") {
            throw new Error("归位后仍处于 Alarm 状态：请检查限位开关与机械干涉后重试，或使用「解锁设备」（$X）");
          }
          lastPenPos = st.wpos ? { x: st.wpos.x, y: st.wpos.y } : null;
          if (lastPenPos == null) throw new Error("$H 归位后未获得位置回报（WPos）");
          console.log(`Home: alarm recovered, position reference rebuilt at (${lastPenPos.x}, ${lastPenPos.y}).`);
          return;
        }
        const firstXY = plan?.motions.find((m): m is XYMotion => m instanceof XYMotion);
        if (firstXY) home = firstXY.p1;
        const penMotion = plan?.motions.find((m): m is PenMotion => m instanceof PenMotion);
        const penUp = penMotion ? Math.min(penMotion.initialPos, penMotion.finalPos) : 50;
        console.log("Home: lifting pen...");
        await withTimeout(device.setPenHeight(penUp, 1000), 15000, "setPenHeight");
        markStep("pen");
        console.log("Home: enabling motors...");
        await withTimeout(device.enableMotors(1), 15000, "enableMotors"); // 16x microstepping, matches prePlot
        markStep("motors");
        if (plan != null && lastPenPos != null && (lastPenPos.x !== home.x || lastPenPos.y !== home.y)) {
          console.log(`Home: travelling to pen home from (${lastPenPos.x}, ${lastPenPos.y})...`);
          const travel = rewindTravelMotion(plan, lastPenPos, home);
          await withTimeout(device.executeMotion(travel), 150000, "travelHome");
          lastPenPos = home;
        } else if (lastPenPos == null) {
          // 位置未知（如服务重启后未绘制过）：若设备支持 homing 用 $H 归位
          // 到机械原点；归位后的 WPos（工作坐标零点取决于用户对刀）作为新
          // 的位置参考；不支持 homing 则报错。
          console.log("Home: position unknown, attempting $H homing...");
          await withTimeout((device as GrblController).home(), 150000, "$H");
          const st = await withTimeout((device as GrblController).statusReport(2000), 5000, "home:status");
          lastPenPos = st.wpos ? { x: st.wpos.x, y: st.wpos.y } : null;
          if (lastPenPos == null) throw new Error("$H 归位后未获得位置回报（WPos）");
        } else {
          console.log("Home: pen already at home, no travel needed.");
        }
        markStep("travel");
        console.log("Home: waiting for motors to idle...");
        await withTimeout(device.waitUntilMotorsIdle(140000), 150000, "waitUntilMotorsIdle");
        markStep("idle");
        console.log("Home: disabling motors...");
        await withTimeout(device.disableMotors(), 15000, "disableMotors");
        markStep("disable");
        console.log(`Home: done in ${((Date.now() - homeStart) / 1000).toFixed(1)}s (${stepTimes.join(", ")}).`);
      } catch (e) {
        console.error(
          `Home failed after ${((Date.now() - homeStart) / 1000).toFixed(1)}s (${stepTimes.join(", ")}):`,
          e,
        );
        // 归位失败时位置不可信，标记为未知（下次补画前需重新归位），
        // 并清空可能卡死的命令队列，让后续命令可以重新尝试。
        lastPenPos = null;
        device.cancel();
        // 归位中止时电机可能仍处于使能状态（锁轴），尽量关闭。
        try {
          await withTimeout(device.disableMotors(), 5000, "disableMotors(fallback)");
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
    /**
     * 取消后的收尾。返回值：undefined = sim 无物理位置（视为笔回计划起始
     * 原点）；Vec2 = 取消后的实测位置（GRBL 经 WPos）；null = 位置未知。
     */
    postCancel: (initialPenHeight: number, drainTimeoutMs: number) => Promise<Vec2 | null | void>;
    postPlot: (drainTimeoutMs: number, penUpHeight: number) => Promise<void>;
  }

  /**
   * GRBL 取消收尾：feedHold 已由 /cancel 发出（设备冻结在 Hold）。软复位
   * 清空设备侧 planner 缓冲（立即丢弃未画动作）；运动中复位会进 Alarm，
   * 须 $X 解锁；复位中断运动可能丢步，位置以 WPos 近似（笔绘场景可接受），
   * WPos 不可得则报告位置未知。
   */
  async function grblPostCancel(gc: GrblController, penUpHeight: number): Promise<Vec2 | null> {
    await new Promise((resolve) => setTimeout(resolve, 600)); // cancel() 沉降期：孤儿应答排空
    gc.softReset();
    await new Promise((resolve) => setTimeout(resolve, 500)); // 复位 + 横幅重发
    const status = await withTimeout(gc.statusReport(), 5000, "postCancel:status");
    if (status.state === "Alarm") {
      console.log(`Post-cancel ${status.raw}; unlocking ($X)...`);
      await withTimeout(gc.unlock(), 15000, "postCancel:unlock");
    }
    await withTimeout(gc.setPenHeight(penUpHeight, 1000), 15000, "postCancel:setPenHeight");
    return status.wpos ? { x: status.wpos.x, y: status.wpos.y } : null;
  }

  const realPlotter: Plotter = {
    async prePlot(initialPenHeight: number): Promise<void> {
      // 全部命令加超时：若串口命令队列已卡死（如上次归位失败遗留），
      // 这些命令会永远挂起且 plotting 卡在 true，后续一切请求被拒。
      // 超时快速失败，由 /plot 的 catch 兜底复位并通知 UI。
      await withTimeout(device.configureFifoDepth(), 15000, "prePlot:configureFifoDepth");
      await withTimeout(device.enableMotors(1), 15000, "prePlot:enableMotors"); // 16x microstepping, matches defaults from Axidraw
      await withTimeout(device.setPenHeight(initialPenHeight, 1000, 1000), 15000, "prePlot:setPenHeight");
    },
    async executeMotion(motion: Motion, progress: [number, number]): Promise<void> {
      // 150s 下限用于短动作的卡死检测；但单条长动作（如由上万短段组成的
      // 巨长路径，或被速率钳制减速的高速行程）在设备侧的真实执行时长可达
      // 数十分钟——FIFO=1 时主机会同步等设备画完，硬性 150s 必然误杀。
      // 超时上限按钳制后的估计执行时长 + 60s 裕量动态放宽。
      const estimatedMs = device.estimateMotionDurationSec(motion) * 1000;
      const timeoutMs = Math.max(150_000, estimatedMs + 60_000);
      try {
        await withTimeout(device.executeMotion(motion), timeoutMs, "executeMotion");
      } catch (e) {
        // 命令应答丢失/设备引擎停摆会让队列头永久挂起；响应按入队顺序匹配，
        // 之后所有命令的响应都会错位。清空队列并等过沉降期（孤儿应答会被
        // 丢弃），让 postPlot 的抬笔/断使能兜底能正确送达设备。
        device.cancel();
        await new Promise((resolve) => setTimeout(resolve, 600));
        try {
          const st = await withTimeout((device as GrblController).statusReport(2000), 5000, "status probe");
          console.log(
            `GRBL status after motion failure at ${progress[0] + 1}/${progress[1]} (${motion.constructor.name}): ${st.raw}`,
          );
        } catch {
          console.log("Status probe failed (device not responding)");
        }
        throw e;
      }
    },
    async postCancel(initialPenHeight: number, _drainTimeoutMs: number): Promise<Vec2 | null> {
      // GRBL 无主机侧排空语义：设备侧缓冲由软复位直接丢弃（见 grblPostCancel），
      // drainTimeoutMs 不适用。
      return grblPostCancel(device as GrblController, initialPenHeight);
    },
    async postPlot(drainTimeoutMs: number, penUpHeight: number): Promise<void> {
      try {
        await withTimeout(
          device.waitUntilMotorsIdle(drainTimeoutMs),
          drainTimeoutMs + 5000,
          "postPlot:waitUntilMotorsIdle",
        );
      } catch (e) {
        // 排空超时（设备故障/积压异常）：设备可能停在动作中途，先尽力抬笔
        //（避免笔尖压在纸上），再断使能避免长期锁轴，最后抛出。
        try {
          await withTimeout(device.setPenHeight(penUpHeight, 1000), 15000, "postPlot:setPenHeight(fallback)");
        } catch {
          /* ignore */
        }
        try {
          await withTimeout(device.disableMotors(), 15000, "postPlot:disableMotors(fallback)");
        } catch {
          /* ignore */
        }
        throw e;
      }
      await withTimeout(device.disableMotors(), 15000, "postPlot:disableMotors");
      // 3.1 双源位置校验：排空后设备 Idle，WPos 即最终物理
      // 位置。与跟踪位置对照修正（偏差常源于错误路径的中断/丢步），
      // 保证后续补画行程起点真实。
      if (device instanceof GrblController && lastPenPos != null) {
        const verified = await grblVerifyPenPos(device, lastPenPos, "绘制收尾");
        if (verified) lastPenPos = verified;
      }
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
    // motion 循环发完后设备可能仍在执行尾部动作（RX/planner 缓冲内积
    // 压，高密度 SVG 的短动作尤其多），固定 60s 排空会误报「电机未归位」。
    // 积压时长至多等于计划剩余总时长，用它 + 60s 裕量作为排空上限。注意
    // 按钳制后的估计时长计算（plan.duration() 按未钳制速度算，高速行程
    // 被钳制时会低估数倍）。
    let estimatedBusySec = 0;
    for (const m of plan.motions) {
      // 模拟模式（device == null，无设备）下无设备侧积压，估 0 → 60s 下限。
      estimatedBusySec += device?.estimateMotionDurationSec(m) ?? 0;
    }
    const drainTimeoutMs = Math.ceil(estimatedBusySec * 1000) + 60_000;
    await plotter.prePlot(firstPenMotion.initialPos);

    let penIsUp = true;
    let plotError: unknown = null;
    let cleanupFailure: unknown = null;
    // 取消收尾是否已执行（catch 或 finally 之一），避免重复 postCancel
    let cancelCleanupDone = false;
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
          // 按 block 累加真实路径长度，Plan 坐标为毫米口径，直接累加。
          if (!penIsUp) {
            for (const b of motion.blocks) {
              plottedDistanceMm += vlen(vsub(b.p2, b.p1));
            }
          }
          curPos = motion.p2;
          lastPenPos = curPos;
        }
        if (motion instanceof PenMotion) {
          penIsUp = motion.initialPos > motion.finalPos;
        }
        logger?.progress(idx + 1, endIdx, plottedDistanceMm);

        if (unpaused && penIsUp) {
          // 3.1 双源位置校验（GRBL）：暂停生效时设备侧可能仍有少量缓冲
          // 动作（RX/planner 缓冲浅，秒级排空），等排空（Idle）后用 WPos
          // 实测对照跟踪位置；偏差超容差（丢步/点动/打滑）时按实测修正，
          // 保证随后的回溯行程（rewindTravelMotion 以 curPos 为起点）从
          // 真实物理位置出发。校验失败不阻断暂停流程。
          if (device instanceof GrblController && curPos != null) {
            try {
              await withTimeout(device.waitUntilMotorsIdle(60000), 70000, "pause:drain");
              const verified = await grblVerifyPenPos(device, curPos, `暂停@动作${idx}`);
              if (verified) {
                curPos = verified;
                lastPenPos = verified;
              }
            } catch (e) {
              console.warn("Pause position verification failed:", e);
            }
          }
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
                plotLogger?.line("PLOT", `回溯：进度 ${idx} → ${target}（抬笔行程 ${travelMm.toFixed(1)} mm）`);
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
        // 3.5：Alarm 中止的取消路径不得走 postCancel——设备在 Alarm 时
        // 软复位会再次触发 ALARM:3，随后的自动 $X 解锁会静默丢失位置参考，
        // 违背「Alarm 不静默恢复」原则。保持 Alarm 态，交由 UI 引导流程
        //（笔回原点 $H / 解锁设备 $X）。
        if (await grblInAlarm()) {
          cancelCleanupDone = true;
          broadcast({ c: "cancelled" });
          return;
        }
        cancelCleanupDone = true;
        applyCancelPosition(await plotter.postCancel(firstPenMotion.initialPos, drainTimeoutMs), plan);
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
      // 取消路径保留长排空（feedHold 后仍需等待状态确认再软复位）。
      const cleanupDrainMs = plotError != null ? 60_000 : drainTimeoutMs;
      try {
        if (signal.aborted && !cancelCleanupDone && plotError == null) {
          // 取消落在排空阶段（motion 循环已正常结束、设备仍在执行积压）：
          // 排空对取消无意义（feedHold 下设备永不 Idle），走取消收尾而非
          // postPlot。
          applyCancelPosition(await plotter.postCancel(firstPenMotion.initialPos, cleanupDrainMs), plan);
          broadcast({ c: "cancelled" });
        } else {
          await plotter.postPlot(cleanupDrainMs, firstPenMotion.initialPos);
        }
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

  /** 取消后的笔位维护：GRBL 经 WPos 实测（软复位中断运动可能丢步，近似
   * 值）；WPos 不可得 → 位置未知（后续补画前须先「笔回原点」）；sim 无
   * 物理位置，笔回计划起始原点。 */
  function applyCancelPosition(cancelPos: Vec2 | null | void, plan: Plan): void {
    if (cancelPos === undefined) {
      // sim：无物理位置，视为笔回计划起始原点
      for (const m of plan.motions) {
        if (m instanceof XYMotion) {
          lastPenPos = m.p1;
          break;
        }
      }
    } else if (cancelPos === null) {
      // GRBL：取消后位置未知（WPos 不可得），后续补画前须先「笔回原点」
      lastPenPos = null;
    } else {
      // GRBL：取消位置经 WPos 实测（软复位中断运动可能丢步，近似值）。
      // TS 无法把 void 从 else 分支收窄掉，显式断言。
      lastPenPos = cancelPos as Vec2;
    }
  }

  /** 连接 GRBL 设备（真实串口或内置模拟器）。GRBL 设备无稳定 USB VID/PID
   * 特征（CH340/CP210x 等繁多），真实模式下依次对所有串口（或 --device
   * 指定端口）尝试 GRBL 握手。 */
  async function connectGrbl(sim: boolean): Promise<void> {
    device = await connectGrblDevice(sim, com || undefined, grblDriveParams);
    deviceKind = device ? "grbl" : null;
    if (device instanceof GrblController) {
      wireGrblDisconnectGuard(device, sim);
      wireGrblAlarmGuard(device);
      broadcast({ c: "dev", p: getDeviceInfo(device) });
    }
  }

  /**
   * 3.5 Alarm 恢复：绘制/归位/闲置中收到异步 ALARM: 行（硬限位触发、软限位
   * 越界、运动中复位等）→ 立即中止绘制（grbl.ts 已同步清空命令队列，挂起
   * 命令以告警原因拒绝）、解除暂停挂起、标记位置未知（硬限位后位置参考
   * 不可信，重新归位前禁止补画）、UI 弹窗给出恢复引导。绝不静默 $X 解锁
   * 或继续下发运动指令。
   */
  function wireGrblAlarmGuard(gc: GrblController): void {
    gc.onalarm = (code, raw) => {
      const message =
        `设备触发告警 ${raw}：${describeGrblAlarm(code)}。运动已立即中止。` +
        `请先排除机械故障，再点击「笔回原点」重新建立位置参考；` +
        `若归位不可用（未装限位开关等），可使用「解锁设备」（$X，会丢失位置参考）。`;
      console.error(`[bit2atombot] ${message}`);
      plotLogger?.line("ERROR", message);
      if (controller) {
        controller.abort();
        controller = null;
      }
      if (unpaused) {
        signalUnpause?.();
        unpaused = signalUnpause = null;
      }
      pendingRewind = null;
      // Alarm（尤其硬限位）后位置参考不可信，须重新归位（$H）或解锁后归位
      lastPenPos = null;
      broadcast({ c: "alarm", p: { code, message } });
    };
  }

  /** 3.5：GRBL 设备是否处于 Alarm 状态（查询失败按非 Alarm 处理，走常规路径）。 */
  async function grblInAlarm(): Promise<boolean> {
    if (!(device instanceof GrblController)) return false;
    try {
      const st = await withTimeout(device.statusReport(2000), 5000, "alarm probe");
      return st.state === "Alarm";
    } catch {
      return false;
    }
  }

  /**
   * 3.4 断连保护：USB 拔出/串口错误（grbl.ts 读流关闭/写失败触发）→
   * 立即中止绘制执行循环（收尾路径经 connectionLost 快速失败，不空等
   * 超时）、解除暂停挂起（暂停中拔出否则永远不退出）、位置
   * 标记为未知、UI 弹窗；随后按 5s 周期自动重连（跳过收尾未完成时段）。
   */
  function wireGrblDisconnectGuard(gc: GrblController, sim: boolean): void {
    gc.ondisconnect = (err) => {
      console.error(`[bit2atombot] GRBL device disconnected: ${err.message}`);
      plotLogger?.line("ERROR", `设备连接断开：${err.message}`);
      if (controller) {
        controller.abort();
        controller = null;
      }
      if (unpaused) {
        signalUnpause?.();
        unpaused = signalUnpause = null;
      }
      pendingRewind = null;
      // 断连后位置不可信（软复位/丢步/机械状态未知），重连后须先「笔回原点」
      lastPenPos = null;
      broadcast({ c: "dev", p: { path: null, hardware: gc.hardware } });
      broadcast({
        c: "disconnected",
        p: {
          message: `设备连接已断开（${err.message}）。若绘制中断连，笔可能仍落在纸上；重新连接后请先「笔回原点」再继续操作。`,
        },
      });
      if (sim) return; // 模拟器不会断连，防御性跳过重连
      const retry = () => {
        if (device !== gc) return; // 已重连或已被替换
        if (plotting) {
          // 取消/错误收尾尚未完成（abort 后的异步路径），等下一周期
          setTimeout(retry, 5000);
          return;
        }
        void connectGrbl(sim).then(() => {
          if (device == null) setTimeout(retry, 5000);
        });
      };
      setTimeout(retry, 5000);
    };
  }

  return new Promise<http.Server>((resolve) => {
    server.listen(port, () => {
      async function connect() {
        await connectGrbl(driver === "sim");
        if (device == null && driver !== "sim") {
          // 启动时未发现 GRBL 设备：服务端保持就绪（UI 可预览/编辑），按
          // 周期自动探测，设备插入后自动接入——不要求真机先于服务端上电。
          console.log(
            "[bit2atomplotgrbl] 未发现 GRBL 设备：服务端保持就绪，设备插入后将自动连接（也可用 --device 指定端口）",
          );
          setTimeout(() => void connect(), 5000);
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

/** 全部串口路径（GRBL 设备无统一 VID/PID 特征，握手探测代替枚举过滤） */
async function listSerialPorts(): Promise<string[]> {
  const Binding = autoDetect();
  const ports = await Binding.list();
  return ports.map((p: { path: string }) => p.path);
}

/** 连接 GRBL 设备（供服务端与 CLI 复用）。sim = 内置虚拟 GRBL 设备（无硬件
 * 全流程演示/测试）；真实模式下对 --device 指定端口或全部串口逐个 GRBL
 * 握手探测。失败返回 null（不抛错），由调用方决定退出（CLI）/重试（服务端
 * 周期探测）。driveParams 为服务端档案副本（连接后 UI 经 ws
 * changeDriveParams 持续同步）。 */
export async function connectGrblDevice(
  sim: boolean,
  device?: string,
  driveParams: DriveParams = defaultPlanOptions.driveParams,
): Promise<DeviceController | null> {
  const firmware = driveParams.firmware ?? {};
  const options: GrblControllerOptions = {
    z: GrblController.zConfigFromDriveParams(driveParams),
    rxBufferSize: firmware.rxBufferSize,
    baudRate: firmware.baudRate,
  };
  if (sim) {
    const gc = await GrblController.connect(
      async () => ({ port: new GrblSimulator(), close: async () => {} }),
      { ...options, handshakeTimeoutMs: 2000 },
    );
    console.log("[bit2atombot] GRBL simulator connected (virtual device)");
    return gc;
  }
  const paths = device ? [device] : await listSerialPorts();
  for (const p of paths) {
    try {
      const gc = await GrblController.connect(async (baud) => {
        const port = new SerialPortSerialPort(p);
        await port.open({ baudRate: baud });
        return { port, close: () => port.close() };
      }, options);
      console.log(`[bit2atombot] GRBL device connected at ${p} (baud ${gc.baudRate})`);
      return gc;
    } catch (e) {
      console.warn(`[bit2atombot] No GRBL handshake at ${p}: ${(e as Error).message}`);
    }
  }
  return null;
}
