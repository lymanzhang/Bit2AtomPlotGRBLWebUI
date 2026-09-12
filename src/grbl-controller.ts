/**
 * GrblController：GRBL 设备的 DeviceController 实现（任务 2.4）。
 *
 * 实现设备无关契约（device-controller.ts），上层执行循环
 * （server.ts Plotter / drivers.ts BaseDriver）不感知具体协议：
 * - executeMotion 把单动作转译为 G-code 行并流式下发（字符计数窗口内
 *   自动流水线化，ok 语义 = 行被 planner 接受，毫秒级返回）；笔状态跨
 *   动作跟踪（PenMotion 落笔方向决定后续 XYMotion 是 G1 还是 G0）。
 * - GRBL 无主机侧电机使能/断使能语义：enableMotors 仅做 Alarm 体检
 *   （Alarm 下静默 $X 解锁会丢失位置参考、有撞纸风险，改为显式报错），
 *   disableMotors 为空操作（闲置断电由 $1 管理）。
 * - waitUntilMotorsIdle = 轮询 `?` 直至 Idle（排空判定，见 7.2）。
 * - setPenHeight 的 height 为 penPct 口径（0=抬笔，100=落笔）；rate/
 *   delay 无语义（Z 进给由档案 zFeedMmMin 决定）。
 *   副作用：以 pct>50 判定笔态（仅供后续 XYMotion 选 G0/G1，标准流程中
 *   该调用只发生在抬笔语境——prePlot 初始笔高、取消/补画后的抬笔兜底）。
 */
import { type DeviceController, type Hardware } from "./device-controller.js";
import { estimateMotionDurationSec as estimateMotionSec, fmtNumber, translateMotion, type GCodeLimits, type MotionContext } from "./gcode.js";
import { detectBaudRate, Grbl, type GrblStatus, type SerialPortLike } from "./grbl.js";
import type { DriveParams, FirmwareKind, Motion, Plan } from "./planning.js";
import { penPctToZMm, zAxisConfigFromDriveParams, type ZAxisConfig } from "./zaxis.js";

export interface GrblControllerOptions {
  /** Z 轴抬笔后端配置（缺省从 DriveParams 提取或用 zaxis 缺省值） */
  z?: ZAxisConfig;
  /** 设备限速（$110–$112），用于 F 钳制与主机时长估算 */
  limits?: GCodeLimits;
  /** RX 缓冲区字符数（缺省 128；连接后可经 queryInfo [OPT:] 校正） */
  rxBufferSize?: number;
  /** 波特率（缺省 115200；握手失败自动按档位轮询探测） */
  baudRate?: number;
  /** 握手超时（缺省 3000ms；测试/模拟器可缩短） */
  handshakeTimeoutMs?: number;
}

/** 按波特率打开串口；失败时须自行关闭并 reject */
export type GrblPortOpener = (baud: number) => Promise<{ port: SerialPortLike; close(): Promise<void> }>;

const IDLE_POLL_INTERVAL_MS = 250;

export class GrblController implements DeviceController {
  public grbl: Grbl;
  public baudRate: number;
  public z: ZAxisConfig;
  public limits?: GCodeLimits;

  public hardware: Hardware = "custom";
  /** GRBL 无公开 FIFO 深度查询 */
  public readonly fifoDepth = -1;

  /** Alarm 异步上报转发（限位触发等）。上层用于报错与引导解锁。 */
  public onalarm: (code: number, raw: string) => void = () => {};

  /**
   * 连接意外丢失转发（USB 拔出/串口错误，3.4 断连保护）。上层用于立即
   * 中止绘制、退出绘制状态并通知 UI；置位后所有新命令快速失败。
   */
  public ondisconnect: (err: Error) => void = () => {};

  /** 连接是否已意外丢失（读流关闭/写失败后置位，不因主动 close 置位） */
  public get connectionLost(): boolean {
    return this.grbl.connectionLost;
  }

  private penDown = false;

  public constructor(grbl: Grbl, baudRate: number, options: GrblControllerOptions = {}) {
    this.grbl = grbl;
    this.baudRate = baudRate;
    this.z = options.z ?? { zPenDownMm: 0, zPenUpMm: 5, zFeedMmMin: 600 };
    this.limits = options.limits;
    grbl.onalarm = (code, raw) => this.onalarm(code, raw);
    grbl.ondisconnect = (err) => this.ondisconnect(err);
  }

  /** 连接入口：按配置波特率握手，失败自动轮询探测档位。 */
  public static async connect(
    open: GrblPortOpener,
    options: GrblControllerOptions = {},
  ): Promise<GrblController> {
    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 3000;
    const configured = options.baudRate ?? 115200;
    let lastError: Error | null = null;
    {
      const { port, close } = await open(configured);
      const grbl = new Grbl(port, { rxBufferSize: options.rxBufferSize });
      try {
        await grbl.handshake(handshakeTimeoutMs);
        return new GrblController(grbl, configured, options);
      } catch (e) {
        lastError = e as Error;
        await close();
      }
    }
    const detected = await detectBaudRate(open, undefined, handshakeTimeoutMs);
    if (!detected) {
      throw new Error(`GRBL 握手失败（波特率 ${configured} 及全部探测档位）：${lastError?.message ?? "无应答"}`);
    }
    return new GrblController(detected.grbl, detected.baud, options);
  }

  public get port(): unknown {
    return this.grbl.port;
  }

  public changeHardware(hardware: Hardware): void {
    this.hardware = hardware;
  }

  /** 从硬件档案提取 Z 轴配置（连接前构建 options 用） */
  public static zConfigFromDriveParams(d: DriveParams): ZAxisConfig {
    return zAxisConfigFromDriveParams(d);
  }

  /**
   * 执行单个规划动作：转译为 G-code 行并全部入队（协议层按字符窗口
   * 流式发送）。任一行 error: 即中止整批（后续行已失去上下文）。
   */
  public async executeMotion(motion: Motion): Promise<void> {
    const ctx: MotionContext = { z: this.z, limits: this.limits, penDown: this.penDown };
    const { lines } = translateMotion(motion, ctx);
    this.penDown = ctx.penDown;
    try {
      await Promise.all(lines.map((line) => this.grbl.run(line)));
    } catch (e) {
      // 一行失败，其余行不应继续下发：清队列 + 沉降期，由调用方走恢复路径
      this.grbl.cancel();
      throw e;
    }
  }

  /** 按顺序执行整个计划（CLI 批处理路径） */
  public async executePlan(plan: Plan): Promise<void> {
    await this.enableMotors(0);
    for (const motion of plan.motions) {
      await this.executeMotion(motion);
    }
    await this.waitUntilMotorsIdle();
    await this.disableMotors();
  }

  /** 估算单个动作执行时长（秒），供超时动态计算 */
  public estimateMotionDurationSec(motion: Motion): number {
    return estimateMotionSec(motion, { z: this.z, limits: this.limits });
  }

  /**
   * 设置笔高。height 为 penPct 口径（接口契约，0 = 完全抬笔，100 = 完全落笔）。
   * 副作用：以 pct>50 判定笔态（见文件头注释）。
   */
  public async setPenHeight(height: number, _rate = 0, _delay = 0): Promise<void> {
    this.penDown = height > 50;
    const zTarget = penPctToZMm(height, this.z);
    await this.grbl.run(`G1 Z${fmtNumber(zTarget)} F${fmtNumber(this.z.zFeedMmMin)}`);
  }

  /**
   * GRBL 无使能语义：仅做 Alarm 体检。Alarm 状态下必须先归位（$H）或
   * 显式解锁（$X，会丢失位置参考），拒绝静默启动绘制。
   */
  public async enableMotors(_microsteppingMode: number): Promise<void> {
    const status = await this.grbl.statusReport(2000);
    if (status.state === "Alarm") {
      throw new Error("设备处于 Alarm 状态：请先归位（$H）或解锁（$X）后再绘制");
    }
  }

  /** 空操作：GRBL 闲置断电由 $1 步进闲置延迟管理 */
  public async disableMotors(): Promise<void> {}

  /** 轮询 `?` 直至 Idle；Alarm 立即失败；断连立即失败；超时抛错（调用方走恢复路径）。 */
  public async waitUntilMotorsIdle(timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.grbl.connectionLost) {
        throw new Error("设备连接已断开，无法等待排空");
      }
      const status = await this.grbl.statusReport(2000);
      if (status.state === "Idle") return;
      if (status.state === "Alarm") {
        throw new Error(`等待排空时设备进入 Alarm（${status.raw}）`);
      }
      if (Date.now() > deadline) {
        throw new Error(`waitUntilMotorsIdle timed out after ${timeoutMs}ms (state: ${status.state})`);
      }
      await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_INTERVAL_MS));
    }
  }

  /** 原始命令（期待 ok） */
  public command(cmd: string): Promise<void> {
    return this.grbl.run(cmd);
  }

  /** 原始查询（期待应答行 + ok），返回首行应答 */
  public async query(cmd: string): Promise<string> {
    const lines = await this.grbl.queryM(cmd);
    return lines[0] ?? "";
  }

  /** GRBL 无主机侧 FIFO 深度配置 */
  public async configureFifoDepth(): Promise<void> {}

  /** 清空命令队列并 reject 全部挂起命令（500ms 沉降期丢弃孤儿应答） */
  public cancel(): void {
    this.grbl.cancel();
  }

  public async close(): Promise<void> {
    await this.grbl.close();
  }

  // ---- GRBL 专属扩展（阶段三恢复路径使用） ----

  /** `$H` homing 归位。撞限位会触发 Alarm 并 reject，由上层引导解锁。 */
  public home(timeoutMs = 120000): Promise<void> {
    return this.grbl.run("$H", timeoutMs);
  }

  /** `$X` 解锁（Alarm 恢复；丢失位置参考，之后须重新归位） */
  public unlock(): Promise<void> {
    return this.grbl.run("$X");
  }

  /** 实时进给保持（`!`）。暂停编排（排空确认 + 恢复）归上层执行循环。 */
  public feedHold(): void {
    this.grbl.sendRealTime("!");
  }

  /** 实时恢复（`~`） */
  public cycleStart(): void {
    this.grbl.sendRealTime("~");
  }

  /** 软复位（0x18）：立即中止运动、清空设备侧 planner 缓冲；固件重发
   * 横幅。运动中复位会进 Alarm（须 $X/$H 解锁），位置保留但步进可能
   * 丢失数步（笔绘场景可接受）。 */
  public softReset(): void {
    this.grbl.sendRealTime("\x18");
  }

  /**
   * 同步 UI 硬件档案（2.7 参数助手/档案编辑）：从 DriveParams 重建 Z 配置
   * 与限速。档案是限速的唯一来源，未配置即清除钳制。
   */
  public applyDriveParams(dp: DriveParams): void {
    this.z = zAxisConfigFromDriveParams(dp);
    const fw = dp.firmware ?? {};
    this.limits = { maxVelMmMin: fw.maxVelocityMmMin ? { ...fw.maxVelocityMmMin } : undefined };
  }

  public async statusReport(timeoutMs = 2000): Promise<GrblStatus> {
    return this.grbl.statusReport(timeoutMs);
  }

  /** 固件判型/版本（grblHAL 以 [FIRMWARE:] 为准，横幅可能伪装） */
  public async firmwareInfo(): Promise<FirmwareKind | "unknown"> {
    return (await this.grbl.queryInfo()).firmwareKind;
  }
}
