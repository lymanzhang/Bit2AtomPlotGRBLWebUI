import { EBB, type Hardware } from "./ebb";
import { getDevice, PenMotion, Plan, rewindTravelMotion, snapToGroupStart, XYMotion } from "./planning.js";
import type { Vec2 } from "./vec.js";

// Reject a promise that neither resolves nor rejects within ms. EBB serial
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
   * 计划坐标所用的步进密度（步/mm）。Plan 的全部坐标都在全步进空间
   * （mm×stepsPerMm），服务端换算真实毫米距离时必需；custom 硬件的
   * driveParams 只有前端知道，故随请求头传给服务端。
   */
  public plotStepsPerMm: number | null = null;
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
  abstract name(): string;
  abstract close(): Promise<void>;
}

/**
 * WebSerial driver for the EBB. Implement interface by connecting directly to the Axi
 * machine. Used on serverless configuration (IS_WEB is set), where the control is handled
 * directly on the browser.
 */
export class WebSerialDriver extends BaseDriver {
  private _unpaused: Promise<void> | null = null;
  private _signalUnpause: (() => void) | null = null;
  private _rejectUnpause: ((reason: Error) => void) | null = null;
  private _cancelRequested = false;
  private _pendingRewind: number | null = null;
  private _disconnectHandler: ((event: Event) => void) | null = null;
  // Pen position tracked across plots, for redraw-range runs.
  private _lastPenPos: Vec2 | null = null;

  public static async connect(port?: SerialPort, hardware: Hardware = "v3") {
    if (!port)
      // biome-ignore lint/style/noParameterAssign: trivial
      port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x04d8, usbProductId: 0xfd92 }] });
    // If the port is already open (e.g. from a previous session that wasn't
    // properly closed), close it first to avoid "Failed to open serial port" error.
    if (port.readable) {
      try {
        await port.close();
      } catch {
        // ignore close errors — port may be in a bad state, but we try to open anyway
      }
    }
    // baudRate ref: https://github.com/evil-mad/plotink/blob/a45739b7d41b74d35c1e933c18949ed44c72de0e/plotink/ebb_serial.py#L281
    // (doesn't specify baud rate)
    // and https://pyserial.readthedocs.io/en/latest/pyserial_api.html#serial.Serial.__init__
    // (pyserial defaults to 9600)
    await port.open({ baudRate: 9600 });
    const { usbVendorId, usbProductId } = port.getInfo();
    const ebb = new EBB(port, hardware);

    const vendorId = usbVendorId?.toString(16).padStart(4, "0");
    const productId = usbProductId?.toString(16).padStart(4, "0");
    const name = `${vendorId}:${productId}`;

    const driver = new WebSerialDriver(ebb, name);
    driver._disconnectHandler = (event: Event) => {
      if (event.target === port) {
        driver.handleDisconnection();
      }
    };
    navigator.serial.addEventListener("disconnect", driver._disconnectHandler);
    driver.connected = true;

    return driver;
  }

  private _name: string;
  public name(): string {
    return this._name;
  }

  public ebb: EBB;
  private constructor(ebb: EBB, name: string) {
    super();
    this.ebb = ebb;
    this._name = name;
  }

  private handleDisconnection(): void {
    console.log("WebSerial device disconnected");
    this.connected = false;
    // 断开后读流关闭，命令队列中挂起的命令永远等不到响应。立即清空
    // 队列让它们 reject——正在执行的 plot/redraw/homePen 会立刻落入
    // catch（oncancelled + 弹窗），UI 不必干等 withTimeout 的 15~150s。
    this.ebb.cancel();
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

  public async close(): Promise<void> {
    this.handleDisconnection();
    if (this._disconnectHandler) {
      navigator.serial.removeEventListener("disconnect", this._disconnectHandler);
    }
    return this.ebb.close();
  }

  public async plot(plan: Plan): Promise<void> {
    const microsteppingMode = 1; // 16x microstepping, matches defaults from Axidraw
    this._unpaused = null;
    this._cancelRequested = false;
    this._pendingRewind = null;
    try {
      // 超时兜底：串口队列卡死时命令会永久挂起，UI 卡在绘制态。
      // 正常命令毫秒级返回，超时只在异常时触发。
      await withTimeout(this.ebb.enableMotors(microsteppingMode), 15000, "enableMotors");

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
        // LM/XM 指令在 EBB FIFO 接受后即返回（毫秒级），150s 只在队列卡死时触发。
        await this.guardedMotion(() => this.ebb.executeMotion(motion), "executeMotion");
        if (motion instanceof XYMotion) {
          curPos = motion.p2;
          this._lastPenPos = curPos;
        }
        if (motion instanceof PenMotion) {
          penIsUp = motion.initialPos < motion.finalPos;
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
                await this.guardedMotion(() => this.ebb.executeMotion(travel), "rewindTravel");
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
        const device = getDevice(this.ebb.hardware);
        if (!penIsUp) {
          // Move to the pen up position, or 50% if no position was found
          const penMotion = plan.motions.find((motion): motion is PenMotion => motion instanceof PenMotion);
          const penUpPosition = penMotion ? Math.max(penMotion.initialPos, penMotion.finalPos) : device.penPctToPos(50);
          await withTimeout(this.ebb.setPenHeight(penUpPosition, 1000), 15000, "setPenHeight");
          // 此处 HM 安全：绘制全程电机保持使能，EBB 原点未被重置。
          await withTimeout(this.ebb.command("HM,4000"), 150000, "HM"); // HM returns carriage home without 3rd and 4th arguments
        }
        // After HM the pen sits at the plan's initial pen home: position known.
        for (const m of plan.motions) {
          if (m instanceof XYMotion) {
            this._lastPenPos = m.p1;
            break;
          }
        }
        this.oncancelled();
      } else {
        this.onfinished();
      }
    } catch (e) {
      // 兜底：命令超时/串口异常时，rejection 若无人处理会让 UI 永久卡在
      // 绘制状态（onprogress 已置位而 oncancelled/onfinished 不会再来）。
      console.error("Plot failed:", e);
      alert(`绘制失败：${e instanceof Error ? e.message : String(e)}`);
      this.oncancelled();
    } finally {
      try {
        // 深FIFO（fw≥3.0）下 motion 循环发完后设备侧可能仍有积压（见
        // server.ts doPlot 注释），排空上限按计划总时长 + 60s 裕量。
        const drainTimeoutMs = Math.ceil(plan.duration() * 1000) + 60000;
        await withTimeout(this.ebb.waitUntilMotorsIdle(drainTimeoutMs), drainTimeoutMs + 5000, "waitUntilMotorsIdle");
        await withTimeout(this.ebb.disableMotors(), 15000, "disableMotors");
      } catch (e) {
        console.error("Plot cleanup failed:", e);
        // 队列可能因应答丢失而错位：先清空并等过沉降期再发兜底命令。
        this.ebb.cancel();
        await new Promise((resolve) => setTimeout(resolve, 600));
        // 排空超时后设备可能停在动作中途：尽力抬笔（避免笔压纸）再断使能。
        const penMotion = plan.motions.find((motion): motion is PenMotion => motion instanceof PenMotion);
        const penUpPosition = penMotion
          ? Math.max(penMotion.initialPos, penMotion.finalPos)
          : getDevice(this.ebb.hardware).penPctToPos(50);
        try {
          await withTimeout(this.ebb.setPenHeight(penUpPosition, 1000), 15000, "setPenHeight(fallback)");
        } catch {
          /* ignore */
        }
        try {
          await withTimeout(this.ebb.disableMotors(), 15000, "disableMotors(fallback)");
        } catch {
          /* ignore */
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
      this.ebb.cancel();
      await new Promise((resolve) => setTimeout(resolve, 600));
      throw e;
    }
  }

  public cancel(): void {
    this._cancelRequested = true;
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
    const microsteppingMode = this.ebb.hardware === "v3" ? 2 : 3;
    await withTimeout(this.ebb.disableMotors(), 15000, "disableMotors");
    await withTimeout(this.ebb.enableMotors(microsteppingMode), 15000, "enableMotors");
    this._cancelRequested = false;
    this._pendingRewind = null;

    const firstPenMotion = plan.motions.find((x): x is PenMotion => x instanceof PenMotion);
    if (!firstPenMotion) {
      throw new Error("Plan contains no PenMotion; cannot determine initial pen height");
    }
    await withTimeout(this.ebb.setPenHeight(firstPenMotion.initialPos, 1000), 15000, "setPenHeight");

    const start = Math.max(0, Math.min(snapToGroupStart(plan, from), plan.motions.length));
    const end = Math.max(start, Math.min(to, plan.motions.length));

    let curPos: Vec2 | null = this._lastPenPos;
    let penIsUp = true;
    try {
      // Safe pen-up travel to the start of the requested range.
      const goal = plan.motions[start];
      if (goal instanceof XYMotion && (goal.p1.x !== curPos.x || goal.p1.y !== curPos.y)) {
        const travel = rewindTravelMotion(plan, curPos, goal.p1);
        await this.guardedMotion(() => this.ebb.executeMotion(travel), "redrawTravel");
        curPos = goal.p1;
        this._lastPenPos = curPos;
      }

      let idx = start;
      while (idx < end && !this._cancelRequested) {
        const motion = plan.motions[idx];
        this.onprogress(idx);
        await this.guardedMotion(() => this.ebb.executeMotion(motion), "executeMotion");
        if (motion instanceof XYMotion) {
          curPos = motion.p2;
          this._lastPenPos = curPos;
        }
        if (motion instanceof PenMotion) {
          penIsUp = motion.initialPos < motion.finalPos;
        }
        idx += 1;
      }

      if (this._cancelRequested) {
        this._cancelRequested = false;
        const device = getDevice(this.ebb.hardware);
        if (!penIsUp) {
          const penMotion = plan.motions.find((motion): motion is PenMotion => motion instanceof PenMotion);
          const penUpPosition = penMotion ? Math.max(penMotion.initialPos, penMotion.finalPos) : device.penPctToPos(50);
          await withTimeout(this.ebb.setPenHeight(penUpPosition, 1000), 15000, "setPenHeight");
          await withTimeout(this.ebb.command("HM,4000"), 150000, "HM");
        }
        for (const m of plan.motions) {
          if (m instanceof XYMotion) {
            this._lastPenPos = m.p1;
            break;
          }
        }
        this.oncancelled();
      } else {
        this.onfinished();
        // 补画完成后自动归位：方便取纸检查，且保证位置跟踪始终已知，
        // 下次补画无需手动「笔回原点」。
        // 注意不能用 HM：本次补画开头经历了电机关闭再重开（disableMotors/
        // enableMotors），EBB 的绝对原点已变成补画起点，HM 只会回到补画起点
        // 而不是机械原点。改用与补画起始行程相同的抬笔移动（rewindTravelMotion）
        // 回到 home，不依赖 EBB 的原点状态。
        const firstXY = plan.motions.find((m): m is XYMotion => m instanceof XYMotion);
        const home = firstXY ? firstXY.p1 : { x: 0, y: 0 };
        const penMotion = plan.motions.find((motion): motion is PenMotion => motion instanceof PenMotion);
        const penUpPosition = penMotion
          ? Math.max(penMotion.initialPos, penMotion.finalPos)
          : getDevice(this.ebb.hardware).penPctToPos(50);
        await withTimeout(this.ebb.setPenHeight(penUpPosition, 1000), 15000, "setPenHeight");
        if (curPos != null && (curPos.x !== home.x || curPos.y !== home.y)) {
          const travel = rewindTravelMotion(plan, curPos, home);
          await withTimeout(this.ebb.executeMotion(travel), 150000, "travelHome");
        }
        this._lastPenPos = home;
      }
    } catch (e) {
      // 兜底：防止命令超时/串口异常时 UI 卡在绘制状态（与 plot() 相同）。
      // 吞掉异常（已弹窗提示），避免与 ui.tsx 的 .catch 弹出重复警告。
      console.error("Redraw failed:", e);
      alert(`补画失败：${e instanceof Error ? e.message : String(e)}`);
      this.oncancelled();
    } finally {
      try {
        const drainTimeoutMs = Math.ceil(plan.duration() * 1000) + 60000;
        await withTimeout(this.ebb.waitUntilMotorsIdle(drainTimeoutMs), drainTimeoutMs + 5000, "waitUntilMotorsIdle");
        await withTimeout(this.ebb.disableMotors(), 15000, "disableMotors");
      } catch (e) {
        console.error("Redraw cleanup failed:", e);
        // 队列可能因应答丢失而错位：先清空并等过沉降期再发兜底命令。
        this.ebb.cancel();
        await new Promise((resolve) => setTimeout(resolve, 600));
        // 排空超时后设备可能停在动作中途：尽力抬笔（避免笔压纸）再断使能。
        const penMotion = plan.motions.find((motion): motion is PenMotion => motion instanceof PenMotion);
        const penUpPosition = penMotion
          ? Math.max(penMotion.initialPos, penMotion.finalPos)
          : getDevice(this.ebb.hardware).penPctToPos(50);
        try {
          await withTimeout(this.ebb.setPenHeight(penUpPosition, 1000), 15000, "setPenHeight(fallback)");
        } catch {
          /* ignore */
        }
        try {
          await withTimeout(this.ebb.disableMotors(), 15000, "disableMotors(fallback)");
        } catch {
          /* ignore */
        }
      }
    }
  }

  public async homePen(plan: Plan | null): Promise<void> {
    const device = getDevice(this.ebb.hardware);
    let home: Vec2 = { x: 0, y: 0 };
    const firstXY = plan?.motions.find((m): m is XYMotion => m instanceof XYMotion);
    if (firstXY) home = firstXY.p1;
    const penMotion = plan?.motions.find((m): m is PenMotion => m instanceof PenMotion);
    const penUp = penMotion ? Math.max(penMotion.initialPos, penMotion.finalPos) : device.penPctToPos(50);
    await withTimeout(this.ebb.setPenHeight(penUp, 1000), 15000, "setPenHeight");
    // 自包含：绘制结束后电机已关闭，需重新使能。但重新使能会把 EBB 的
    // 绝对原点重置到当前位置，随后的 HM 会变成零移动——所以归位不能用
    // enableMotors + HM，必须用基于已知位置的抬笔行程移动。
    await withTimeout(this.ebb.enableMotors(this.ebb.hardware === "v3" ? 2 : 3), 15000, "enableMotors");
    try {
      if (
        plan != null &&
        this._lastPenPos != null &&
        (this._lastPenPos.x !== home.x || this._lastPenPos.y !== home.y)
      ) {
        const travel = rewindTravelMotion(plan, this._lastPenPos, home);
        await withTimeout(this.ebb.executeMotion(travel), 150000, "travelHome");
      } else if (this._lastPenPos == null) {
        // 位置未知：无法构造安全行程，尽力用 HM（原点未被重置时有效）。
        await withTimeout(this.ebb.command("HM,4000"), 150000, "HM");
      }
      await withTimeout(this.ebb.waitUntilMotorsIdle(140000), 150000, "waitUntilMotorsIdle");
      await withTimeout(this.ebb.disableMotors(), 15000, "disableMotors");
      this._lastPenPos = home;
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
      if (await withTimeout(this.ebb.supportsSR(), 15000, "supportsSR")) {
        await withTimeout(this.ebb.setServoPowerTimeout(10000, true), 15000, "setServoPowerTimeout");
      }
      await withTimeout(this.ebb.setPenHeight(height, rate), 15000, "setPenHeight");
    } catch (e) {
      console.error("setPenHeight failed:", e);
      alert(`设置笔高失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  public limp(): void {
    // 同 setPenHeight：松弛电机按钮 fire-and-forget，需自行兜底。
    withTimeout(this.ebb.disableMotors(), 15000, "disableMotors").catch((e) => {
      console.error("Limp failed:", e);
      alert(`松弛电机失败：${e instanceof Error ? e.message : String(e)}`);
    });
  }

  public changeHardware(hardware: Hardware): void {
    this.ebb.changeHardware(hardware);
    this.ondevinfo({
      path: this._name,
      hardware: hardware,
    });
  }
}

/**
 * Bit2AtomBot Serial driver for the EBB. Implement interface by connecting to the Axi
 * through the Bit2AtomBot web server, which handles the control. Used in the default
 * configuration (IS_WEB is unset).
 */
export class Bit2AtomDriver extends BaseDriver {
  private socket: WebSocket;
  private pingInterval: number | undefined;

  public name() {
    return "Bit2AtomBot Server";
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
      console.log("Connected to EBB server.");
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
        default: {
          console.log("Unknown message from server:", msg);
        } break;
      }
    }); // biome-ignore format: compactness
    this.socket.addEventListener("error", () => {
      // TODO: something
    });
    this.socket.addEventListener("close", () => {
      console.log("Disconnected from EBB server, reconnecting in 5 seconds.");
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
    if (this.plotStepsPerMm != null) {
      headers["X-Plot-Steps-Per-Mm"] = String(this.plotStepsPerMm);
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
  public ping() {
    this.send({ c: "ping" });
  }
}
