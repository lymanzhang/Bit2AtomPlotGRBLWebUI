import type { Hardware } from "./device-controller.js";
import { GrblController } from "./grbl-controller.js";
import type { SerialPortLike } from "./grbl.js";
import {
  type DriveParams,
  PenMotion,
  Plan,
  rewindTravelMotion,
  snapToGroupStart,
  XYMotion,
} from "./planning.js";
import type { Vec2 } from "./vec.js";

// Reject a promise that neither resolves nor rejects within ms. Serial
// commands otherwise wait forever on a missed response — a wedged command
// queue would hang the driver loop and leave the UI stuck in "plotting".
// Mirrors the helper in server.ts (browser mode cannot import it from there).
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

export interface DeviceInfo {
  path: string;
  hardware: Hardware;
}

/**
 * Driver interface for the Axi machine.
 */
export abstract class BaseDriver {
  public onprogress: (motionIdx: number) => void = () => {};
  public oncancelled: () => void = () => {};
  public onfinished: () => void = () => {};
  public ondevinfo: (devInfo: DeviceInfo) => void = () => {};
  public onpause: (paused: boolean) => void = () => {};
  public connected = false;
  /**
   * Called when plan loaded
   */
  public onplan: (plan: Plan) => void = () => {};
  /**
   * 当前加载的源 SVG 文件名。发起绘制/补画请求时通过 X-Plot-Filename
   * 头传给服务端，用于生成与源文件同名的任务日志。
   */
  public plotFileName: string | null = null;
  /**
   * 本次绘制任务的图层信息（图层过滤模式 + 选中的图层名）。发起绘制/
   * 补画请求时通过 X-Plot-Layers 头传给服务端，写入任务日志。
   */
  public plotLayerInfo: { mode: string; layers: string[] } | null = null;
  /**
   * custom 硬件的安全工作区域（mm，自原点 0,0 起）。发起绘制请求时通过
   * X-Plot-Working-Area 头传给服务端，参与绘制前超界校验；内置硬件为 null。
   */
  public plotWorkingAreaMm: { x: number; y: number } | null = null;

  abstract plot(plan: Plan): void;
  abstract cancel(): void;
  abstract pause(): void;
  /**
   * Resume plotting after a pause. When `rewindTo` (a motion index) is given,
   * execution rewinds to the nearest path-group start at or before that index
   * and redraws from there instead of continuing in place.
   */
  abstract resume(rewindTo?: number): void;
  /**
   * Redraw only the path groups covering motion indices [from, to). Used to
   * patch missing strokes after a finished (or cancelled) plot. `plan` is the
   * plan that was last plotted (the server keeps its own copy).
   */
  abstract redraw(plan: Plan, from: number, to: number): void;
  /**
   * Lift the pen and return the carriage to home, restoring known position
   * tracking after an unknown-position situation (e.g. server restart).
   */
  abstract homePen(plan: Plan | null): void;
  abstract setPenHeight(height: number, rate: number): void;
  abstract limp(): void;
  abstract changeHardware(hardware: Hardware): void;
  /**
   * 同步 custom 硬件档案（2.7 参数助手）：档案编辑/反向同步后推送到设备
   * 执行层。GRBL 驱动（服务端 ws 转发 / 浏览器直连）据此更新 Z 抬笔配置
   * 与限速；无档案语义的实现默认空操作。
   */
  public changeDriveParams(_driveParams: DriveParams): void {}
  /**
   * 3.5 Alarm 恢复：解锁设备（$X）。仅 GRBL 驱动支持（服务端与浏览器直连）；
   * 解锁会丢失位置参考，之后须重新「笔回原点」。默认空实现。
   */
  public unlockDevice(): void {}
  abstract name(): string;
  abstract close(): Promise<void>;
}

/**
 * WebSerial driver for GRBL devices (3.7). Connects directly to a GRBL
 * controller over Web Serial; used on serverless configuration (IS_WEB is
 * set), where the control is handled directly on the browser. The execution
 * loop is protocol-agnostic (DeviceController contract); GRBL-specific
 * recovery paths (feedHold cancel / soft reset / $H homing / $X unlock /
 * Alarm & disconnect guards) mirror server.ts.
 */
export class WebSerialDriver extends BaseDriver {
  private _unpaused: Promise<void> | null = null;
  private _signalUnpause: (() => void) | null = null;
  private _rejectUnpause: ((reason: Error) => void) | null = null;
  private _cancelRequested = false;
  /** 取消收尾（finishCancel）已执行标记：防止 catch/finally 双路径重复收尾 */
  private _cancelFinished = false;
  private _pendingRewind: number | null = null;
  private _disconnectHandler: ((event: Event) => void) | null = null;
  // Pen position tracked across plots, for redraw-range runs.
  private _lastPenPos: Vec2 | null = null;

  public static async connect(port?: SerialPort) {
    if (!port)
      // biome-ignore lint/style/noParameterAssign: trivial
      port = await navigator.serial.requestPort();
    const p = port;
    // GRBL 握手：115200 失败时自动按档位轮询探测（detectBaudRate）。Z 抬笔
    // 配置与限速来自 UI 硬件档案，连接后经 changeDriveParams 持续同步。
    const gc = await GrblController.connect(
      async (baud) => {
        // If the port is already open (e.g. from a previous session that wasn't
        // properly closed), close it first to avoid "Failed to open serial port" error.
        if (p.readable) {
          try {
            await p.close();
          } catch {
            // ignore close errors — port may be in a bad state, but we try to open anyway
          }
        }
        await p.open({ baudRate: baud });
        // 浏览器 SerialPort 的 readable/writable/close 与 SerialPortLike 同构
        return { port: p as unknown as SerialPortLike, close: () => p.close() };
      },
      { baudRate: 115200 },
    );

    const { usbVendorId, usbProductId } = p.getInfo();
    const vendorId = usbVendorId?.toString(16).padStart(4, "0") ?? "????";
    const productId = usbProductId?.toString(16).padStart(4, "0") ?? "????";
    const name = `GRBL ${vendorId}:${productId} @${gc.baudRate}bps`;

    const driver = new WebSerialDriver(gc, name);
    driver._disconnectHandler = (event: Event) => {
      if (event.target === p) {
        driver.handleDisconnection();
      }
    };
    navigator.serial.addEventListener("disconnect", driver._disconnectHandler);
    // 3.4 断连保护（浏览器直连移植）：USB 拔出/串口错误经读流关闭/写失败
    // 统一上报。中止挂起命令、位置失效、解除暂停挂起；UI 由弹窗与后续
    // 命令快速失败感知。
    gc.ondisconnect = (err) => {
      alert(`设备连接已断开：${err.message}。绘制已中止；重新连接后请先「笔回原点」。`);
      driver.handleDisconnection();
    };
    // 3.5 Alarm 守卫（浏览器直连移植）：grbl.ts 收到 ALARM: 行已同步清空
    // 命令队列，绘制循环随即以告警原因 reject 退出；此处标记位置失效并
    // 解除暂停挂起，给出恢复引导。
    gc.onalarm = (_code, raw) => driver.handleAlarm(raw);
    driver.connected = true;

    return driver;
  }

  private _name: string;
  public name(): string {
    return this._name;
  }

  /** 设备控制器：GRBL 协议层实现 DeviceController 契约（3.7 起浏览器直连） */
  public device: GrblController;
  private constructor(device: GrblController, name: string) {
    super();
    this.device = device;
    this._name = name;
  }

  private handleDisconnection(): void {
    if (!this.connected) return; // navigator 事件与读流关闭双源触发，去重
    console.log("WebSerial device disconnected");
    this.connected = false;
    // 断开后读流关闭，命令队列中挂起的命令永远等不到响应。立即清空
    // 队列让它们 reject——正在执行的 plot/redraw/homePen 会立刻落入
    // catch（oncancelled + 弹窗），UI 不必干等 withTimeout 的 15~150s。
    this.device.cancel();
    // 断开后电机可能被手动移动，位置不可信，下次操作前需重新归位。
    this._lastPenPos = null;
    // 暂停中拔出：plot 循环挂在 _unpaused 上且无超时，否则永远不退出。
    // reject 让循环立即落入 catch → oncancelled（该 await 在 try 块内）。
    if (this._unpaused != null) {
      this._signalUnpause = null;
      const reject = this._rejectUnpause;
      this._unpaused = null;
      this._rejectUnpause = null;
      reject?.(new Error("设备已断开连接"));
    }
  }

  /** 3.5 Alarm 守卫（浏览器直连）：位置失效 + 解除暂停挂起 + 恢复引导。 */
  private handleAlarm(raw: string): void {
    // Alarm（尤其硬限位）后位置参考不可信，须重新归位（$H）或解锁后归位
    this._lastPenPos = null;
    this._pendingRewind = null;
    if (this._unpaused != null) {
      this._signalUnpause = null;
      const reject = this._rejectUnpause;
      this._unpaused = null;
      this._rejectUnpause = null;
      reject?.(new Error(`设备告警 ${raw}：运动已中止`));
    }
    alert(
      `设备触发告警 ${raw}：运动已立即中止。请先排除机械故障，再点击「笔回原点」` +
        `重新建立位置参考；若归位不可用（未装限位开关等），可使用「解锁设备」（$X，会丢失位置参考）。`,
    );
  }

  public async close(): Promise<void> {
    this.handleDisconnection();
    if (this._disconnectHandler) {
      navigator.serial.removeEventListener("disconnect", this._disconnectHandler);
    }
    return this.device.close();
  }

  public async plot(plan: Plan): Promise<void> {
    this._unpaused = null;
    this._cancelRequested = false;
    this._cancelFinished = false;
    this._pendingRewind = null;
    try {
      // GRBL enableMotors 仅做 Alarm 体检（Alarm 态拒绝启动绘制，见
      // grbl-controller.ts）；microsteppingMode 参数无语义。
      await withTimeout(this.device.enableMotors(1), 15000, "enableMotors");

      // Current pen position, tracked from executed XY motions.
      let curPos: Vec2 | null = null;
      for (const m of plan.motions) {
        if (m instanceof XYMotion) {
          curPos = m.p1;
          break;
        }
      }
      this._lastPenPos = curPos;
      let idx = 0;
      let penIsUp = true;
      while (idx < plan.motions.length && !this._cancelRequested) {
        const motion = plan.motions[idx];
        this.onprogress(idx);
        // G-code 行 ok = planner 接受（毫秒级），150s 只在队列卡死时触发。
        await this.guardedMotion(() => this.device.executeMotion(motion), "executeMotion");
        if (motion instanceof XYMotion) {
          curPos = motion.p2;
          this._lastPenPos = curPos;
        }
        if (motion instanceof PenMotion) {
          penIsUp = motion.initialPos > motion.finalPos;
        }
        if (this._unpaused && penIsUp) {
          await this._unpaused;
          // Resumed. If a rewind was requested, safely travel (pen up) to the
          // start of the target path group and redraw from there.
          // (onpause(false) must fire on every resume path — including
          // rewinds — so the UI leaves the paused state and can pause/rewind
          // again during the redraw.)
          if (this._pendingRewind != null && curPos != null) {
            const target = snapToGroupStart(plan, this._pendingRewind);
            this._pendingRewind = null;
            if (target < idx) {
              const goal = plan.motions[target];
              if (goal instanceof XYMotion) {
                this.onpause(false);
                const travel = rewindTravelMotion(plan, curPos, goal.p1);
                await this.guardedMotion(() => this.device.executeMotion(travel), "rewindTravel");
                curPos = goal.p1;
                this._lastPenPos = curPos;
                idx = target;
                continue;
              }
            }
          }
          this._pendingRewind = null;
          this.onpause(false);
        }
        idx += 1;
      }

      if (this._cancelRequested) {
        await this.finishCancel(plan);
      } else {
        this.onfinished();
      }
    } catch (e) {
      if (this._cancelRequested) {
        // 取消打断动作执行：cancel() 已 feedHold 冻结设备并清空主机队列，
        // 被背压阻塞的动作行以 "Cancelled" reject 落到这里——走取消收尾
        // （软复位丢弃设备侧积压并退出 Hold），不弹「绘制失败」。
        await this.finishCancel(plan);
      } else {
        // 兜底：命令超时/串口异常时，rejection 若无人处理会让 UI 永久卡在
        // 绘制状态（onprogress 已置位而 oncancelled/onfinished 不会再来）。
        console.error("Plot failed:", e);
        alert(`绘制失败：${e instanceof Error ? e.message : String(e)}`);
        this.oncancelled();
      }
    } finally {
      if (this._cancelFinished) {
        // 取消收尾已完成（软复位后设备 Idle），无需排空
      } else if (this._cancelRequested) {
        // 取消落在收尾排空阶段（onfinished 已发出）：补走收尾退出 Hold
        await this.finishCancel(plan);
      } else {
        try {
          // 正常结束（非取消）时主机仅领先设备 planner 深度条动作；排空
          // 等待按计划总时长 + 60s 裕量兜底（取消路径已在收尾中复位设备，
          // 此处瞬时通过）。
          const drainTimeoutMs = Math.ceil(plan.duration() * 1000) + 60000;
          await withTimeout(this.device.waitUntilMotorsIdle(drainTimeoutMs), drainTimeoutMs + 5000, "waitUntilMotorsIdle");
          // GRBL 断使能为空操作（闲置断电由 $1 管理）
          await withTimeout(this.device.disableMotors(), 15000, "disableMotors");
        } catch (e) {
          console.error("Plot cleanup failed:", e);
          // 队列可能因应答丢失而错位：先清空并等过沉降期再发兜底命令。
          this.device.cancel();
          await new Promise((resolve) => setTimeout(resolve, 600));
          // 排空超时后设备可能停在动作中途：尽力抬笔（避免笔压纸）再收尾。
          const penMotion = plan.motions.find((motion): motion is PenMotion => motion instanceof PenMotion);
          const penUpPosition = penMotion ? Math.min(penMotion.initialPos, penMotion.finalPos) : 50;
          try {
            await withTimeout(this.device.setPenHeight(penUpPosition, 1000), 15000, "setPenHeight(fallback)");
          } catch {
            /* ignore */
          }
          try {
            await withTimeout(this.device.disableMotors(), 15000, "disableMotors(fallback)");
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  /**
   * 执行运动命令并在超时后自恢复：命令应答丢失/设备引擎停摆会让队列头
   * 永久挂起，且响应按入队顺序匹配、之后所有命令的响应都会错位。清空
   * 队列并等过沉降期（孤儿应答被丢弃），后续抬笔/断使能兜底才能送达设备。
   */
  private async guardedMotion(run: () => Promise<void>, label: string): Promise<void> {
    try {
      await withTimeout(run(), 150000, label);
    } catch (e) {
      this.device.cancel();
      await new Promise((resolve) => setTimeout(resolve, 600));
      throw e;
    }
  }

  /**
   * GRBL 取消收尾（3.7，与 server.ts grblPostCancel 同口径）：cancel() 已
   * 实时 feedHold 冻结设备运动；软复位丢弃设备侧 planner 积压（不再画完
   * 积压，立即可控）；运动中复位会进 Alarm，须 $X 解锁；随后抬笔并以
   * 复位前的 WPos 实测回填笔位（不可得则 null——位置未知，须重新归位后
   * 才能补画）。
   */
  private async grblPostCancel(plan: Plan): Promise<Vec2 | null> {
    await new Promise((resolve) => setTimeout(resolve, 600)); // cancel() 沉降期：孤儿应答排空
    this.device.softReset();
    await new Promise((resolve) => setTimeout(resolve, 500)); // 复位 + 横幅重发
    const status = await withTimeout(this.device.statusReport(), 5000, "postCancel:status");
    if (status.state === "Alarm") {
      await withTimeout(this.device.unlock(), 15000, "postCancel:unlock");
    }
    const penMotion = plan.motions.find((motion): motion is PenMotion => motion instanceof PenMotion);
    const penUpPosition = penMotion ? Math.min(penMotion.initialPos, penMotion.finalPos) : 50;
    await withTimeout(this.device.setPenHeight(penUpPosition, 1000), 15000, "postCancel:setPenHeight");
    return status.wpos ? { x: status.wpos.x, y: status.wpos.y } : null;
  }

  /**
   * 取消收尾统一入口（幂等）：grblPostCancel + oncancelled。绘制循环的
   * try/catch/finally 三处取消路径共用，_cancelFinished 防止重复收尾。
   * 收尾失败（如收尾中断连）仅记录——设备状态已不可控，交由断连守卫处理。
   */
  private async finishCancel(plan: Plan): Promise<void> {
    if (this._cancelFinished) return;
    this._cancelFinished = true;
    try {
      this._lastPenPos = await this.grblPostCancel(plan);
    } catch (e) {
      console.error("Post-cancel cleanup failed:", e);
    }
    this.oncancelled();
  }

  public cancel(): void {
    this._cancelRequested = true;
    // GRBL：实时进给保持（!）立即冻结设备侧运动。写失败（断连）由
    // ondisconnect 路径处理，此处吞掉异常避免未捕获 rejection。
    try {
      this.device.feedHold();
    } catch {
      /* ignore */
    }
    // 立即清空主机侧命令队列：feedHold 下被 planner 背压阻塞的动作行永无
    // ok，不清空则执行循环会挂在 executeMotion 上直到命令超时。清空后当前
    // executeMotion 以 "Cancelled" reject，绘制循环转入 catch → finishCancel
    // （软复位丢弃设备侧积压并退出 Hold），与服务端 abortPromise 中断同口径。
    this.device.cancel();
    // 暂停中取消：解除暂停挂起（与断连/Alarm 守卫同口径），循环落入 catch。
    if (this._unpaused != null) {
      const reject = this._rejectUnpause;
      this._unpaused = null;
      this._signalUnpause = null;
      this._rejectUnpause = null;
      reject?.(new Error("Cancelled"));
    }
  }

  public pause(): void {
    this._unpaused = new Promise((resolve, reject) => {
      this._signalUnpause = resolve;
      this._rejectUnpause = reject;
    });
    this.onpause(true);
  }

  public resume(rewindTo?: number): void {
    this._pendingRewind = typeof rewindTo === "number" && Number.isFinite(rewindTo) && rewindTo >= 0 ? rewindTo : null;
    const signal = this._signalUnpause;
    this._unpaused = null;
    this._signalUnpause = null;
    this._rejectUnpause = null;
    signal?.();
  }

  /**
   * Redraw only the path groups covering motion indices [from, to) of the
   * given plan. The pen travels (up) from its last known position to the
   * start of the range, then replays the motions in place.
   */
  public async redraw(plan: Plan, from: number, to: number): Promise<void> {
    if (this._lastPenPos == null) {
      throw new Error("笔当前位置未知：请先执行「笔回原点」");
    }
    // GRBL：disableMotors 空操作，enableMotors 仅做 Alarm 体检（Alarm 态
    // 拒绝补画并引导恢复）。
    await withTimeout(this.device.disableMotors(), 15000, "disableMotors");
    await withTimeout(this.device.enableMotors(1), 15000, "enableMotors");
    this._cancelRequested = false;
    this._cancelFinished = false;
    this._pendingRewind = null;

    const firstPenMotion = plan.motions.find((x): x is PenMotion => x instanceof PenMotion);
    if (!firstPenMotion) {
      throw new Error("Plan contains no PenMotion; cannot determine initial pen height");
    }
    await withTimeout(this.device.setPenHeight(firstPenMotion.initialPos, 1000), 15000, "setPenHeight");

    const start = Math.max(0, Math.min(snapToGroupStart(plan, from), plan.motions.length));
    const end = Math.max(start, Math.min(to, plan.motions.length));

    let curPos: Vec2 | null = this._lastPenPos;
    try {
      // Safe pen-up travel to the start of the requested range.
      const goal = plan.motions[start];
      if (goal instanceof XYMotion && (goal.p1.x !== curPos.x || goal.p1.y !== curPos.y)) {
        const travel = rewindTravelMotion(plan, curPos, goal.p1);
        await this.guardedMotion(() => this.device.executeMotion(travel), "redrawTravel");
        curPos = goal.p1;
        this._lastPenPos = curPos;
      }

      let idx = start;
      while (idx < end && !this._cancelRequested) {
        const motion = plan.motions[idx];
        this.onprogress(idx);
        await this.guardedMotion(() => this.device.executeMotion(motion), "executeMotion");
        if (motion instanceof XYMotion) {
          curPos = motion.p2;
          this._lastPenPos = curPos;
        }
        idx += 1;
      }

      if (this._cancelRequested) {
        this._cancelRequested = false;
        // GRBL 取消收尾：同 plot()（feedHold 已在 cancel() 发出）。
        await this.finishCancel(plan);
      } else {
        this.onfinished();
        // 补画完成后自动归位：方便取纸检查，且保证位置跟踪始终已知，
        // 下次补画无需手动「笔回原点」。用抬笔行程（rewindTravelMotion，
        // Z 先抬后 G0 空程）回到计划原点——不依赖 $H（未配置限位开关时
        // 不可用），与服务端补画收尾同口径。
        const firstXY = plan.motions.find((m): m is XYMotion => m instanceof XYMotion);
        const home = firstXY ? firstXY.p1 : { x: 0, y: 0 };
        const penMotion = plan.motions.find((motion): motion is PenMotion => motion instanceof PenMotion);
        const penUpPosition = penMotion ? Math.min(penMotion.initialPos, penMotion.finalPos) : 50;
        await withTimeout(this.device.setPenHeight(penUpPosition, 1000), 15000, "setPenHeight");
        if (curPos != null && (curPos.x !== home.x || curPos.y !== home.y)) {
          const travel = rewindTravelMotion(plan, curPos, home);
          await withTimeout(this.device.executeMotion(travel), 150000, "travelHome");
        }
        this._lastPenPos = home;
      }
    } catch (e) {
      if (this._cancelRequested) {
        // 取消打断动作执行：同 plot()，走取消收尾而不弹「补画失败」。
        this._cancelRequested = false;
        await this.finishCancel(plan);
      } else {
        // 兜底：防止命令超时/串口异常时 UI 卡在绘制状态（与 plot() 相同）。
        // 吞掉异常（已弹窗提示），避免与 ui.tsx 的 .catch 弹出重复警告。
        console.error("Redraw failed:", e);
        alert(`补画失败：${e instanceof Error ? e.message : String(e)}`);
        this.oncancelled();
      }
    } finally {
      if (this._cancelFinished) {
        // 取消收尾已完成（软复位后设备 Idle），无需排空
      } else if (this._cancelRequested) {
        // 取消落在收尾排空阶段：补走收尾退出 Hold
        this._cancelRequested = false;
        await this.finishCancel(plan);
      } else {
        try {
          const drainTimeoutMs = Math.ceil(plan.duration() * 1000) + 60000;
          await withTimeout(this.device.waitUntilMotorsIdle(drainTimeoutMs), drainTimeoutMs + 5000, "waitUntilMotorsIdle");
          await withTimeout(this.device.disableMotors(), 15000, "disableMotors");
        } catch (e) {
          console.error("Redraw cleanup failed:", e);
          // 队列可能因应答丢失而错位：先清空并等过沉降期再发兜底命令。
          this.device.cancel();
          await new Promise((resolve) => setTimeout(resolve, 600));
          // 排空超时后设备可能停在动作中途：尽力抬笔（避免笔压纸）再收尾。
          const penMotion = plan.motions.find((motion): motion is PenMotion => motion instanceof PenMotion);
          const penUpPosition = penMotion ? Math.min(penMotion.initialPos, penMotion.finalPos) : 50;
          try {
            await withTimeout(this.device.setPenHeight(penUpPosition, 1000), 15000, "setPenHeight(fallback)");
          } catch {
            /* ignore */
          }
          try {
            await withTimeout(this.device.disableMotors(), 15000, "disableMotors(fallback)");
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  public async homePen(plan: Plan | null): Promise<void> {
    let home: Vec2 = { x: 0, y: 0 };
    const firstXY = plan?.motions.find((m): m is XYMotion => m instanceof XYMotion);
    if (firstXY) home = firstXY.p1;
    const penMotion = plan?.motions.find((m): m is PenMotion => m instanceof PenMotion);
    const penUp = penMotion ? Math.min(penMotion.initialPos, penMotion.finalPos) : 50;

    // Alarm 态：任何 G-code 被 error:9 拒绝，必须先 $H 清警并重建位置参考
    // （与 server.ts homePenNow 的 Alarm 恢复同口径）。归位失败（如撞限位
    // 再次 Alarm）时位置保持未知并抛错，由 UI 提示引导 $X 解锁。
    const st = await withTimeout(this.device.statusReport(2000), 5000, "homePen:status");
    if (st.state === "Alarm") {
      await withTimeout(this.device.home(120000), 130000, "homePen:$H(alarm)");
      this._lastPenPos = { x: 0, y: 0 }; // $H 后工作坐标归零
    }
    try {
      await withTimeout(this.device.setPenHeight(penUp, 1000), 15000, "setPenHeight");
      if (
        plan != null &&
        this._lastPenPos != null &&
        (this._lastPenPos.x !== home.x || this._lastPenPos.y !== home.y)
      ) {
        // 位置已知：抬笔 + 安全行程移动回计划原点（Z 先抬后 G0 空程）。
        const travel = rewindTravelMotion(plan, this._lastPenPos, home);
        await withTimeout(this.device.executeMotion(travel), 150000, "travelHome");
        this._lastPenPos = home;
      } else if (this._lastPenPos == null) {
        // 位置未知：$H homing 重建参考（未配置 $22 限位开关时固件报错，
        // 由 UI 提示引导手动对刀）。$H 将 Z 一并归零（落笔位）：再次抬笔
        // 避免笔尖压纸。
        await withTimeout(this.device.home(120000), 130000, "homePen:$H");
        this._lastPenPos = { x: 0, y: 0 };
        await withTimeout(this.device.setPenHeight(penUp, 1000), 15000, "setPenHeight(after $H)");
      }
      await withTimeout(this.device.waitUntilMotorsIdle(140000), 150000, "waitUntilMotorsIdle");
    } catch (e) {
      // 归位失败后位置不可信，置为未知（ui.tsx 会弹窗提示，此处重抛）。
      this._lastPenPos = null;
      throw e;
    }
  }

  public async setPenHeight(height: number, rate: number): Promise<void> {
    // UI 的抬笔/落笔按钮 fire-and-forget 调用本方法：不加超时和 catch，
    // 队列卡死时会挂起并产生 unhandled rejection。
    try {
      await withTimeout(this.device.setPenHeight(height, rate), 15000, "setPenHeight");
    } catch (e) {
      console.error("setPenHeight failed:", e);
      alert(`设置笔高失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  public limp(): void {
    // 同 setPenHeight：松弛电机按钮 fire-and-forget，需自行兜底。
    // GRBL 下 disableMotors 为空操作（无使能语义，保留接口一致性）。
    withTimeout(this.device.disableMotors(), 15000, "disableMotors").catch((e) => {
      console.error("Limp failed:", e);
      alert(`松弛电机失败：${e instanceof Error ? e.message : String(e)}`);
    });
  }

  public changeHardware(hardware: Hardware): void {
    this.device.changeHardware(hardware);
    this.ondevinfo({
      path: this._name,
      hardware: hardware,
    });
  }

  public changeDriveParams(driveParams: DriveParams): void {
    // 浏览器直连：硬件档案直接应用到 GRBL 控制器（Z 抬笔配置 + 限速钳制），
    // 与服务端 ws changeDriveParams 通道同口径。
    this.device.applyDriveParams(driveParams);
  }

  /** 3.5 解锁设备（$X）：Alarm 且无法归位时的最后手段；解锁后须重新归位。 */
  public unlockDevice(): void {
    this.device
      .unlock()
      .then(() => alert("设备已解锁（$X）。位置参考已丢失，请先「笔回原点」再继续操作。"))
      .catch((e) => alert(`解锁失败：${e instanceof Error ? e.message : String(e)}`));
  }
}

/**
 * Bit2AtomPlotGRBL Serial driver. Implement interface by connecting to the plotter
 * through the Bit2AtomPlotGRBL web server, which handles the control. Used in the default
 * configuration (IS_WEB is unset).
 */
export class Bit2AtomDriver extends BaseDriver {
  private socket: WebSocket;
  private pingInterval: number | undefined;

  public name() {
    return "Bit2AtomPlotGRBL Server";
  }

  public close() {
    this.socket.close();
    return Promise.resolve();
  }

  public static async connect(): Promise<Bit2AtomDriver> {
    const d = new Bit2AtomDriver();
    await d.connect();
    return d;
  }

  public async connect() {
    const websocketProtocol = document.location.protocol === "https:" ? "wss" : "ws";
    this.socket = new WebSocket(`${websocketProtocol}://${document.location.host}/chat`);

    this.socket.addEventListener("open", () => {
      console.log("Connected to Bit2AtomPlotGRBL server.");
      this.connected = true;
      this.pingInterval = window.setInterval(() => this.ping(), 30000);
    });
    this.socket.addEventListener("message", (e: MessageEvent) => {
      const msg = JSON.parse(e.data);
      switch (msg.c) {
        case "pong": {
          // nothing
        } break;
        case "progress": {
          this.onprogress(msg.p.motionIdx);
        } break;
        case "cancelled": {
          this.oncancelled();
        } break;
        case "finished": {
          this.onfinished();
        } break;
        case "dev": {
          this.ondevinfo(msg.p);
        } break;
        case "pause": {
          this.onpause(msg.p.paused);
        } break;
        case "plan": {
          this.onplan(Plan.deserialize(msg.p.plan));
        } break;
        case "home-failed": {
          alert(msg.p.message as string);
        } break;
        case "disconnected": {
          // 3.4 断连保护：服务端设备连接丢失（USB 拔出/串口错误）。
          // 绘制态退出由随后的 cancelled 广播驱动；此处仅弹窗告知。
          alert(msg.p.message as string);
        } break;
        case "alarm": {
          // 3.5 Alarm 恢复：绘制/归位中设备触发告警（硬限位、软限位、
          // 运动中复位等）。绘制态退出由随后的 cancelled 广播驱动；此处
          // 弹窗给出恢复引导（排除故障 → 笔回原点，必要时解锁）。
          alert(msg.p.message as string);
        } break;
        default: {
          console.log("Unknown message from server:", msg);
        } break;
      }
    }); // biome-ignore format: compactness
    this.socket.addEventListener("error", () => {
      // TODO: something
    });
    this.socket.addEventListener("close", () => {
      console.log("Disconnected from Bit2AtomPlotGRBL server, reconnecting in 5 seconds.");
      window.clearInterval(this.pingInterval);
      this.pingInterval = undefined;
      this.connected = false;
      setTimeout(() => void this.connect(), 5000);
    });
  }

  /** 构造绘制/补画请求头：源文件名与图层信息（供服务端任务日志使用） */
  private plotHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.plotFileName != null) {
      headers["X-Plot-Filename"] = this.plotFileName;
    }
    if (this.plotLayerInfo != null) {
      headers["X-Plot-Layers"] = encodeURIComponent(JSON.stringify(this.plotLayerInfo));
    }
    if (this.plotWorkingAreaMm != null) {
      headers["X-Plot-Working-Area"] = `${this.plotWorkingAreaMm.x}x${this.plotWorkingAreaMm.y}`;
    }
    return headers;
  }

  public plot(plan: Plan) {
    fetch("/plot", {
      method: "POST",
      headers: this.plotHeaders(),
      body: JSON.stringify(plan.serialize()),
    })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          alert(`无法开始绘制：${text || res.statusText}`);
        }
      })
      .catch((e) => alert(`绘制请求发送失败：${(e as Error).message}`));
  }

  public cancel() {
    fetch("/cancel", { method: "POST" });
  }

  public pause() {
    fetch("/pause", { method: "POST" })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          alert(`暂停失败：${text || res.statusText}`);
        }
      })
      .catch((e) => alert(`暂停请求发送失败：${(e as Error).message}`));
  }

  public resume(rewindTo?: number) {
    fetch("/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rewindTo != null ? { rewindTo } : {}),
    })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          alert(`继续绘制失败：${text || res.statusText}`);
        }
      })
      .catch((e) => alert(`继续绘制请求发送失败：${(e as Error).message}`));
  }

  public redraw(plan: Plan, from: number, to: number) {
    void plan;
    fetch("/redraw", {
      method: "POST",
      headers: this.plotHeaders(),
      body: JSON.stringify({ from, to }),
    }).catch((e) => alert(`补画请求发送失败：${(e as Error).message}`));
  }

  public homePen(_plan: Plan | null) {
    fetch("/home", { method: "POST" })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          alert(`笔回原点失败：${text || res.statusText}`);
        }
      })
      .catch((e) => alert(`笔回原点请求发送失败：${(e as Error).message}`));
  }

  /** 3.5 解锁设备（$X）：Alarm 且无法归位时的最后手段；解锁后须重新归位。 */
  public unlockDevice() {
    fetch("/grbl/unlock", { method: "POST" })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          alert(`解锁失败：${text || res.statusText}`);
        } else {
          alert("设备已解锁（$X）。位置参考已丢失，请先「笔回原点」再继续操作。");
        }
      })
      .catch((e) => alert(`解锁请求发送失败：${(e as Error).message}`));
  }

  public send(msg: object) {
    if (!this.connected) {
      throw new Error(`Can't send message: not connected`);
    }
    this.socket.send(JSON.stringify(msg));
  }

  public setPenHeight(height: number, rate: number) {
    this.send({ c: "setPenHeight", p: { height, rate } });
  }

  public limp() {
    this.send({ c: "limp" });
  }
  public changeHardware(hardware: Hardware) {
    this.send({ c: "changeHardware", p: { hardware } });
  }
  public changeDriveParams(driveParams: DriveParams) {
    // 服务端模式：硬件档案经 ws 同步到服务端（GRBL 控制器更新
    // Z 配置与限速；工作区参与超界校验）。
    this.send({ c: "changeDriveParams", p: { driveParams } });
  }
  public ping() {
    this.send({ c: "ping" });
  }
}
