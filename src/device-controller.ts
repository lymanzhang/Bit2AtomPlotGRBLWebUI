/**
 * DeviceController：设备无关的绘图仪控制接口（任务 1.3）。
 *
 * 目标：drivers.ts / server.ts / ui.tsx 的**执行路径**只面向本接口，
 * 不再感知具体固件协议。GRBL 由 GrblController 实现本契约（EBB 路径已
 * 移除，EBB 设备由姊妹项目 Bit2AtomPlotWebUI 覆盖）。
 *
 * 语义约定（由 GRBL 实现固化）：
 * - executeMotion/executePlan 仅在命令被设备接受后 resolve；队列卡死时由
 *   调用方以 withTimeout 兜底（接口实现内部不自带超时）。
 * - cancel() 清空命令队列并使挂起命令 reject；随后须等待 500ms 沉降期，
 *   丢弃迟到应答，避免新命令响应错位。
 * - setPenHeight 的 height 为 penPct 口径（0 = 完全抬笔，100 = 完全落笔），
 *   由具体实现线性映射到设备笔位（GRBL Z 轴行程）。
 */
import type { Motion, Plan } from "./planning.js";

/** 设备档案标识（GRBL 预设档 key / 已存档案名 / "custom"） */
export type Hardware = string;

export interface DeviceController {
  /** 底层串口对象（服务端仅读取其路径用于展示/日志） */
  readonly port: unknown;
  /** 当前配置的运动队列深度（未知/未配置时 -1），供任务日志记录 */
  readonly fifoDepth: number;
  /** 当前生效的硬件档案 */
  readonly hardware: Hardware;

  /** 切换硬件档案（UI 切换硬件时同步给服务端） */
  changeHardware(hardware: Hardware): void;

  /** 执行单个规划动作（XYMotion/PenMotion） */
  executeMotion(motion: Motion): Promise<void>;
  /** 按顺序执行整个计划（CLI 批处理路径） */
  executePlan(plan: Plan): Promise<void>;
  /** 估算单个动作的执行时长（秒），用于超时与排空等待的动态计算 */
  estimateMotionDurationSec(motion: Motion): number;

  /** 设置笔高（height 为 penPct；rate 为移动速率，delay 为执行前延迟毫秒） */
  setPenHeight(height: number, rate: number, delay?: number): Promise<void>;
  /** 使能电机（GRBL 实现为 Alarm 体检；microsteppingMode 无语义） */
  enableMotors(microsteppingMode: number): Promise<void>;
  /** 断使能电机（GRBL 实现为空操作，闲置断电由 $1 管理） */
  disableMotors(): Promise<void>;
  /** 轮询等待运动队列排空（设备 Idle） */
  waitUntilMotorsIdle(timeoutMs?: number): Promise<void>;

  /** 发送原始命令并期待单一 "OK" 应答 */
  command(cmd: string): Promise<void>;
  /** 发送原始查询并期待单行应答 */
  query(cmd: string): Promise<string>;
  /** 按环境配置调整运动队列深度 */
  configureFifoDepth(): Promise<void>;

  /** 清空命令队列并 reject 全部挂起命令（断连/超时恢复路径） */
  cancel(): void;
  close(): Promise<void>;
}
