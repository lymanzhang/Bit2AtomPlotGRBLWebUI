// Cribbed from https://github.com/fogleman/axi/blob/master/axi/planner.py
import { PaperSize } from "./paper-size.js";
import { defaultPlacement, type Placement } from "./util.js";
import { type Vec2, vadd, vdot, vlen, vmul, vnorm, vsub } from "./vec.js";

const epsilon = 1e-9;

/** Z 轴传动形式：丝杆（导程）或同步带（齿数×齿距） */
export type ZDriveType = "screw" | "belt";

/** 固件种类。auto 表示连接时由版本横幅/$I 自动探测（grblHAL 可能伪装
 * "Grbl 1.1" 横幅，须以 [FIRMWARE:grblHAL] 为准），探测失败回退预设值。 */
export type FirmwareKind = "auto" | "grbl-0.9" | "grbl-1.1" | "grblhal";

/** 固件能力项。所有字段支持「自动探测 / 手动指定」双入口，
 * auto/undefined = 探测；探测逻辑在阶段二 grbl.ts 实现。 */
export interface FirmwareCapabilities {
  firmwareKind?: FirmwareKind;
  /** 串口波特率。GRBL 为编译期属性，连接失败时按档位轮询重试 */
  baudRate?: 9600 | 57600 | 115200 | 230400 | 250000;
  /** RX 缓冲区字节数（默认 128，可调 64–256；$I [OPT:] 可探测） */
  rxBufferSize?: number;
  /** $H homing 支持（有限位开关与否） */
  homingSupport?: "auto" | "yes" | "no";
  /** $10 状态回报格式（0.9 与 1.1 报文不兼容） */
  statusReport?: "auto" | "v0.9" | "v1.1";
  /** 设备最大速度 mm/min（$110–$112），供主机时长估算钳制；「从设备读取」回填 */
  maxVelocityMmMin?: { x?: number; y?: number; z?: number };
  /** 设备最大加速度 mm/s²（$120–$122），同上 */
  maxAccelMmS2?: { x?: number; y?: number; z?: number };
}

export interface DriveParams {
  name: string; // 自定义设备名称
  /** XY 传动参数：仅用于与设备 $100/$101 校验对照及「参数助手」建议值，
   * 不参与主机运动学换算（GRBL 下固件 $ 参数是绘制权威）。 */
  stepAngle: number; // 步距角 (度)，典型值 1.8
  microstepping: number; // 驱动细分，典型值 16
  pulleyTeeth: number; // 同步轮齿数，典型值 20
  beltPitch: number; // 同步带齿距 (mm)，典型值 2
  /** Z 传动参数：用于与设备 $102 校验对照及 Z 轴抬笔行程换算 */
  zDriveType?: ZDriveType; // 缺省 screw
  zStepAngle?: number; // 缺省 1.8
  zMicrostepping?: number; // 缺省 16
  zLeadMm?: number; // 丝杆导程 (mm/rev)，screw 型必填，典型 8
  zPulleyTeeth?: number; // belt 型同步轮齿数，典型 20
  zBeltPitch?: number; // belt 型齿距 (mm)，典型 2
  /** 抬笔（Z 轴）：落笔 Z 高度 mm（通常 0）、抬笔 Z 高度 mm、Z 进给 mm/min */
  zPenDownMm?: number; // 默认 0
  zPenUpMm?: number; // 默认 5
  zFeedMmMin?: number; // 默认 600
  /** 固件能力（自动探测 / 手动指定） */
  firmware?: FirmwareCapabilities;
  /** 自定义硬件的安全工作区域（自原点 0,0 起，mm）。用于绘制前的超界
   * 校验与预览标红；未配置时服务端仅按 Axidraw 档案告警、前端不标红。 */
  workingAreaMm?: { x: number; y: number };
  /** 机器原点角：设备 (0,0) 位于纸张的哪个角（缺省 top-left）。预览与
   * 排版始终采用屏幕方位（原点在纸面左上、+X 右、+Y 下），执行层按此
   * 设置把屏幕坐标映射为机器坐标（applyMachineFrame）。 */
  originCorner?: OriginCorner;
}

export interface SavedProfile {
  name: string;
  driveParams: DriveParams;
}

/** 机器原点角。左上 = 绘图仪/SVG 惯例（屏幕坐标即机器坐标，恒等映射）；
 * 左下 = CNC 常见惯例（+Y 向上）。 */
export type OriginCorner = "top-left" | "bottom-left" | "top-right" | "bottom-right";

/**
 * 屏幕坐标（预览/排版口径：原点在纸面左上，+X 右、+Y 下）→ 机器坐标。
 * 轴方向由原点角推导：原点在左 → +X 指向纸面右方（X 恒等），在右 → X
 * 关于纸张竖直中线镜像；原点在上 → +Y 指向纸面下方（Y 恒等），在下 →
 * Y 关于纸张水平中线镜像。
 *
 * PenMotion 无 XY 坐标，原样保留；动作序列与时长完全不变，因此补画
 * 区间、进度索引在屏幕空间与机器空间中一一对应。绘制/补画/归位/G-code
 * 导出统一在发送前应用本映射，服务端与驱动全程只见机器坐标。
 */
/** 机器坐标帧的单点变换（屏幕↔机器；镜像变换自逆，同角再变换即还原）。
 * applyMachineFrame 的逐点版本：供 G-code 导入把笔画转为 Path 走
 * paths→replan 正常管线时复用（排版操作对 G-code 导入同样生效）。 */
export function machineFramePoint(
  p: Vec2,
  corner: OriginCorner,
  paperSizeMm: { x: number; y: number },
): Vec2 {
  if (corner === "top-left") return p;
  return {
    x: corner.endsWith("right") ? paperSizeMm.x - p.x : p.x,
    y: corner.startsWith("bottom") ? paperSizeMm.y - p.y : p.y,
  };
}

export function applyMachineFrame(
  plan: Plan,
  corner: OriginCorner,
  paperSizeMm: { x: number; y: number },
): Plan {
  if (corner === "top-left") return plan;
  const fx = (p: Vec2): Vec2 => machineFramePoint(p, corner, paperSizeMm);
  const motions = plan.motions.map((m) =>
    m instanceof XYMotion
      ? new XYMotion(m.blocks.map((b) => new Block(b.accel, b.duration, b.vInitial, fx(b.p1), fx(b.p2))))
      : m,
  );
  return new Plan(motions);
}

export function computeStepsPerMm(d: DriveParams): number {
  const stepsPerRev = 360 / d.stepAngle;
  const mmPerRev = d.pulleyTeeth * d.beltPitch;
  return stepsPerRev / mmPerRev;
}

export function computeMicrostepsPerMm(d: DriveParams): number {
  return computeStepsPerMm(d) * d.microstepping;
}

/** Z 轴全步数/mm（与 $102 同口径：全步，不含细分）。screw = 360/zStepAngle ÷ 导程；
 * belt = 360/zStepAngle ÷ (齿数×齿距)。 */
export function computeZStepsPerMm(d: DriveParams): number {
  const stepAngle = d.zStepAngle ?? d.stepAngle;
  const mmPerRev = d.zDriveType === "belt" ? (d.zPulleyTeeth ?? 20) * (d.zBeltPitch ?? 2) : (d.zLeadMm ?? 8);
  return 360 / stepAngle / mmPerRev;
}

/** 参数助手单条对照项（任务 2.7） */
export interface GrblParamComparison {
  /** GRBL 参数号（如 "100"） */
  key: string;
  label: string;
  unit: string;
  /** 设备 `$$` 实值；固件未回报该参数时为 null */
  device: number | null;
  /** 档案传动参数换算的建议值；档案未配置时为 null */
  suggested: number | null;
  /** true/false = 一致/不一致；null = 一侧缺失无法比较 */
  match: boolean | null;
}

const parseSettingNumber = (s: string | undefined): number | null => {
  if (s == null) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};

/** 一致判定：相对误差 ≤0.5% 或绝对差 ≤0.01（吸收 EEPROM 存储的舍入尾差） */
const GRBL_PARAM_TOL_REL = 0.005;

function compareGrblParam(
  key: string,
  label: string,
  unit: string,
  device: number | null,
  suggested: number | null,
): GrblParamComparison {
  const match =
    device == null || suggested == null
      ? null
      : Math.abs(device - suggested) <= Math.max(0.01, Math.abs(suggested) * GRBL_PARAM_TOL_REL);
  return { key, label, unit, device, suggested, match };
}

/**
 * 参数助手对照计算：设备 `$$` 实值 vs 档案传动参数换算值（任务 2.7）。
 * $100/$101 与 XY 微步值（全步 × 细分）对照；$102 与 Z 微步值对照；
 * $110–$112（mm/min）与档案最大速度对照；$120–$122（mm/s²）与最大加速度对照。
 */
export function compareGrblSettings(dp: DriveParams, settings: Record<string, string>): GrblParamComparison[] {
  const microXY = computeMicrostepsPerMm(dp);
  const zMicro = computeZStepsPerMm(dp) * (dp.zMicrostepping ?? dp.microstepping);
  const fw = dp.firmware ?? {};
  return [
    compareGrblParam("100", "X 步/mm", "步/mm", parseSettingNumber(settings["100"]), microXY),
    compareGrblParam("101", "Y 步/mm", "步/mm", parseSettingNumber(settings["101"]), microXY),
    compareGrblParam("102", "Z 步/mm", "步/mm", parseSettingNumber(settings["102"]), zMicro),
    compareGrblParam("110", "X 最大速度", "mm/min", parseSettingNumber(settings["110"]), fw.maxVelocityMmMin?.x ?? null),
    compareGrblParam("111", "Y 最大速度", "mm/min", parseSettingNumber(settings["111"]), fw.maxVelocityMmMin?.y ?? null),
    compareGrblParam("112", "Z 最大速度", "mm/min", parseSettingNumber(settings["112"]), fw.maxVelocityMmMin?.z ?? null),
    compareGrblParam("120", "X 最大加速度", "mm/s²", parseSettingNumber(settings["120"]), fw.maxAccelMmS2?.x ?? null),
    compareGrblParam("121", "Y 最大加速度", "mm/s²", parseSettingNumber(settings["121"]), fw.maxAccelMmS2?.y ?? null),
    compareGrblParam("122", "Z 最大加速度", "mm/s²", parseSettingNumber(settings["122"]), fw.maxAccelMmS2?.z ?? null),
  ];
}

/** GRBL 硬件预设档：作为「新建自定义」的起点模板，选择后可修改并保存为
 * 命名档案。字段值取 docs/DEVICE_NOTES.md 调研结论的典型配置。 */
export const GRBL_PRESET_PROFILES: { key: string; label: string; driveParams: DriveParams }[] = [
  {
    key: "grbl11-screw",
    label: "GRBL 1.1 · 丝杆 Z",
    driveParams: {
      name: "",
      stepAngle: 1.8,
      microstepping: 16,
      pulleyTeeth: 20,
      beltPitch: 2, // GT2 带，XY 5 步/mm（全步）
      zDriveType: "screw",
      zLeadMm: 8, // T8 丝杆，Z 25 步/mm（全步）
      zPenDownMm: 0,
      zPenUpMm: 5,
      zFeedMmMin: 600,
      firmware: { firmwareKind: "grbl-1.1", baudRate: 115200, rxBufferSize: 128, homingSupport: "auto", statusReport: "v1.1" },
    },
  },
  {
    key: "grbl11-belt",
    label: "GRBL 1.1 · 同步带 Z",
    driveParams: {
      name: "",
      stepAngle: 1.8,
      microstepping: 16,
      pulleyTeeth: 20,
      beltPitch: 2,
      zDriveType: "belt",
      zPulleyTeeth: 20,
      zBeltPitch: 2,
      zPenDownMm: 0,
      zPenUpMm: 8, // 同步带 Z 行程通常更大
      zFeedMmMin: 1200,
      firmware: { firmwareKind: "grbl-1.1", baudRate: 115200, rxBufferSize: 128, homingSupport: "auto", statusReport: "v1.1" },
    },
  },
  {
    key: "grblhal",
    label: "grblHAL · 丝杆 Z",
    driveParams: {
      name: "",
      stepAngle: 1.8,
      microstepping: 16,
      pulleyTeeth: 20,
      beltPitch: 2,
      zDriveType: "screw",
      zLeadMm: 8,
      zPenDownMm: 0,
      zPenUpMm: 5,
      zFeedMmMin: 600,
      firmware: { firmwareKind: "grblhal", baudRate: 115200, rxBufferSize: 128, homingSupport: "auto", statusReport: "v1.1" },
    },
  },
];

/** GRBL 预设档 key 集合（UI 区分「预设模板」与「自定义/已存档案」用） */
export const GRBL_PRESET_KEYS = GRBL_PRESET_PROFILES.map((p) => p.key);

export interface PlanOptions {
  paperSize: PaperSize;
  marginMm: number;
  selectedStrokeLayers: Set<string>;
  selectedGroupLayers: Set<string>;
  layerMode: "group" | "stroke" | "all";

  penUpHeight: number;
  penDownHeight: number;
  pointJoinRadius: number;
  pathJoinRadius: number;

  penDownAcceleration: number;
  penDownMaxVelocity: number;
  penDownCorneringFactor: number;

  penUpAcceleration: number;
  penUpMaxVelocity: number;

  penDropDuration: number;
  penLiftDuration: number;

  sortPaths: boolean;
  rotateDrawing: number;
  /** 缩放模式：fit=等比缩放到纸张绘图区域（默认）；actual=按原尺寸 (1:1)
   * 绘制；custom=按 scalePercent 自定义比例缩放。非 fit 模式下可配合
   * cropToMargins 裁掉超出纸张绘图区域的部分。 */
  scaleMode: "fit" | "actual" | "custom";
  /** 自定义缩放比例（%），scaleMode === "custom" 时生效 */
  scalePercent: number;
  /** 每个 SVG 用户单位对应的毫米数。导入时若 SVG 根元素 width 带绝对物理
   * 单位（或 px 数与 viewBox 不一致）则按 width_mm ÷ viewBox 宽自动推算，
   * 未提供时按 96dpi 缺省（1px = 25.4/96 mm）。见 util.ts
   * mmPerSvgUnitFromSvg()。 */
  mmPerSvgUnit?: number;
  /** 导入文件是否为本应用导出的最终排版结果：根节点带 data-b2a-rotate-deg
   * 标记时为数字（可为 0，表示导出时未旋转），无标记的外部文件为 undefined。
   * replan 对带标记的文件不再施加「旋转绘制」（坐标已含当时烘焙的旋转，
   * 重导入所见即所得）；用户主动修改旋转角度时该标记会被清除，旋转恢复生效。 */
  bakedRotationDeg?: number;
  cropToMargins: boolean;
  placement: Placement;

  minimumPathLength: number;
  hardware: string;
  /** 笔起始/停泊点，机器坐标口径：相对 DriveParams.originCorner 所指的
   * 机器原点角、向纸面内递增（(0,0) = 机器原点角本身，$H 归位后笔已在
   * 起点处）。replan 时按原点角换算为屏幕空间坐标供 plan() 使用，执行层
   * applyMachineFrame 再映射回机器坐标，口径闭环一致。 */
  penHome: Vec2;
  driveParams: DriveParams;
  hiding: boolean;
}

export const defaultPlanOptions: PlanOptions = {
  penUpHeight: 50,
  penDownHeight: 60,
  pointJoinRadius: 0,
  pathJoinRadius: 0.5,
  paperSize: PaperSize.standard.ArchA.landscape,
  marginMm: 20,
  selectedGroupLayers: new Set(),
  selectedStrokeLayers: new Set(),
  layerMode: "stroke",

  penDownAcceleration: 200,
  penDownMaxVelocity: 50,
  penDownCorneringFactor: 0.127,

  penUpAcceleration: 400,
  penUpMaxVelocity: 200,

  penDropDuration: 0.12,
  penLiftDuration: 0.12,

  sortPaths: true,
  rotateDrawing: 0,
  scaleMode: "fit",
  scalePercent: 100,
  cropToMargins: true,
  placement: defaultPlacement,

  minimumPathLength: 0,
  hardware: "grbl11-screw",
  hiding: false,
  penHome: { x: 0, y: 0 },
  driveParams: {
    name: "",
    stepAngle: 1.8,
    microstepping: 16,
    pulleyTeeth: 20,
    beltPitch: 2,
    zDriveType: "screw",
    zLeadMm: 8,
    zPenDownMm: 0,
    zPenUpMm: 5,
    zFeedMmMin: 600,
    firmware: { firmwareKind: "auto", baudRate: 115200, rxBufferSize: 128, homingSupport: "auto", statusReport: "auto" },
  },
};

/**
 * An abstraction of all motion variables at a single point in time
 * (t), including position (p), distance (s), velocity (v), and acceleration (a).
 */
interface Instant {
  t: number;
  p: Vec2;
  s: number;
  v: number;
  a: number;
}

export interface AccelerationProfile {
  acceleration: number;
  maximumVelocity: number;
  corneringFactor: number;
}

interface ToolingProfile {
  penDownProfile: AccelerationProfile;
  penUpProfile: AccelerationProfile;
  /** 落笔笔高（penPct 口径：0 = 完全抬笔，100 = 完全落笔） */
  penDownPos: number;
  /** 抬笔笔高（penPct 口径） */
  penUpPos: number;
  penLiftDuration: number;
  penDropDuration: number;
}

// Plan 坐标空间约定（1.4b）：Plan 的全部坐标、速度、加速度均为**毫米口径**
// （坐标 mm、速度 mm/s、加速度 mm/s²）；PenMotion 位置为 penPct 口径
// （0 = 完全抬笔，100 = 完全落笔），GRBL 执行层直接线性映射 Z 高度。

/** 兼容测试用 ToolingProfile（pct 口径笔高，与 defaultPlanOptions 一致） */
export const AxidrawFast: ToolingProfile = {
  penDownProfile: {
    acceleration: 200,
    maximumVelocity: 50,
    corneringFactor: 0.127,
  },
  penUpProfile: {
    acceleration: 400,
    maximumVelocity: 200,
    corneringFactor: 0,
  },
  penUpPos: 50,
  penDownPos: 60,
  penDropDuration: 0.12,
  penLiftDuration: 0.12,
};

/**
 * A Motion Block, where the pen moves with a constant acceleration, from
 * a start to an end point, and initial to final velocity.
 */
interface BlockData {
  accel: number;
  duration: number;
  vInitial: number;
  p1: Vec2;
  p2: Vec2;
}

export class Block {
  public static deserialize(o: BlockData): Block {
    return new Block(o.accel, o.duration, o.vInitial, o.p1, o.p2);
  }

  public distance: number;

  constructor(
    public accel: number,
    public duration: number,
    public vInitial: number,
    public p1: Vec2,
    public p2: Vec2,
  ) {
    if (!(vInitial >= 0)) {
      throw new Error(`vInitial must be >= 0, but was ${vInitial}`);
    }
    if (!(vInitial + accel * duration >= -epsilon)) {
      throw new Error(`vFinal must be >= 0, but vInitial=${vInitial}, duration=${duration}, accel=${accel}`);
    }
    this.accel = accel;
    this.duration = duration;
    this.vInitial = vInitial;
    this.p1 = p1;
    this.p2 = p2;
    this.distance = vlen(vsub(p1, p2));
  }

  public get vFinal(): number {
    return Math.max(0, this.vInitial + this.accel * this.duration);
  }

  /**
   * Compute the motion at a given time.
   * @param tU The time at which to compute the motion.
   * @param dt The time offset.
   * @param ds The distance offset.
   * @return The motion at time tU.
   **/
  public instant(tU: number, dt = 0, ds = 0): Instant {
    const t = Math.max(0, Math.min(this.duration, tU));
    const a = this.accel;
    const v = this.vInitial + this.accel * t;
    const s = Math.max(0, Math.min(this.distance, this.vInitial * t + (a * t * t) / 2));
    const p = vadd(this.p1, vmul(vnorm(vsub(this.p2, this.p1)), s));
    return { t: t + dt, p, s: s + ds, v, a };
  }

  public serialize(): BlockData {
    return {
      accel: this.accel,
      duration: this.duration,
      vInitial: this.vInitial,
      p1: this.p1,
      p2: this.p2,
    };
  }
}

export interface Motion {
  duration(): number;
  serialize(): MotionData;
}

/**
 * Pen Motion accross a single axis, represented as an initial positon, final position and duration.
 */
export class PenMotion implements Motion {
  public static deserialize(o: PenMotionData): PenMotion {
    return new PenMotion(o.initialPos, o.finalPos, o.duration);
  }

  constructor(
    public initialPos: number,
    public finalPos: number,
    public pDuration: number,
  ) {}

  public duration(): number {
    return this.pDuration;
  }

  public serialize(): PenMotionData {
    return {
      initialPos: this.initialPos,
      finalPos: this.finalPos,
      duration: this.pDuration,
    };
  }
}

interface PenMotionData {
  initialPos: number;
  finalPos: number;
  duration: number;
}

/**
 * Scan an array, applying an operation to each element - accumulating the result.
 * @param a - The array to scan.
 * @param z - The initial value (zero).
 * @param op - The binary operation to apply.
 * @returns An array of partially accumulated values - running total.
 */
function scanLeft<A, B>(a: A[], z: B, op: (b: B, a: A) => B): B[] {
  const b: B[] = [];
  let acc = z;
  b.push(acc);
  for (const x of a) {
    acc = op(acc, x);
    b.push(acc);
  }
  return b;
}

/**
 * Find insertion point of en element on a sorted array, to keep the order.
 * @param array
 * @param obj
 * @returns
 */
function sortedIndex<T>(array: T[], obj: T): number {
  let low = 0;
  let high = array.length;
  // binary search
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (array[mid] < obj) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/**
 * XY Motion - across a 2 dimensioanl plane, represented as a list of blocks.
 */
export class XYMotion implements Motion {
  public static deserialize(o: XYMotionData): XYMotion {
    return new XYMotion(o.blocks.map(Block.deserialize));
  }
  private ts: number[];
  private ss: number[];

  constructor(public blocks: Block[]) {
    // time progression
    this.ts = scanLeft(
      blocks.map((b) => b.duration),
      0,
      (a, b) => a + b,
    ).slice(0, -1);
    // distance progression
    this.ss = scanLeft(
      blocks.map((b) => b.distance),
      0,
      (a, b) => a + b,
    ).slice(0, -1);
  }

  public get p1(): Vec2 {
    return this.blocks[0].p1;
  }
  public get p2(): Vec2 {
    return this.blocks[this.blocks.length - 1].p2;
  }

  public duration(): number {
    return this.blocks.map((b) => b.duration).reduce((a, b) => a + b, 0);
  }

  public instant(t: number): Instant {
    const idx = sortedIndex(this.ts, t);
    const blockIdx = this.ts[idx] === t ? idx : idx - 1;
    const block = this.blocks[blockIdx];
    return block.instant(t - this.ts[blockIdx], this.ts[blockIdx], this.ss[blockIdx]);
  }

  public serialize(): XYMotionData {
    return {
      blocks: this.blocks.map((b) => b.serialize()),
    };
  }
}

interface XYMotionData {
  blocks: BlockData[];
}

export type MotionData = XYMotionData | PenMotionData;
/**
 * Plotting Plan.
 * Contains a list of pen motions.
 */
export class Plan {
  public static deserialize(o: MotionData[]): Plan {
    return new Plan(
      o.map((m) => {
        if ("blocks" in m) return XYMotion.deserialize(m);
        if ("initialPos" in m) return PenMotion.deserialize(m);
        throw new Error(`Wrong parameter: ${m}`);
      }),
    );
  }

  constructor(public motions: Motion[]) {}

  /**
   * Calculate duration of the plan from a given start index.
   * @param start - the index of the first motion to consider (default: 0)
   * @returns duration of the plan (sec)
   */
  public duration(start = 0): number {
    return this.motions
      .slice(start)
      .map((m) => m.duration())
      .reduce((a, b) => a + b, 0);
  }
  public motion(i: number) {
    return this.motions[i];
  }

  /** 落笔路径总长度（mm，毫米口径直读）。 */
  public totalDistance(): number {
    let total = 0;
    for (const motion of this.motions) {
      if (motion instanceof XYMotion) {
        for (const block of motion.blocks) {
          total += block.distance;
        }
      }
    }
    return total;
  }

  public withPenHeights(penUpHeight: number, penDownHeight: number): Plan {
    let penMotionIndex = 0;
    return new Plan(
      this.motions.map((motion, j) => {
        if (motion instanceof XYMotion) {
          return motion;
        }
        if (motion instanceof PenMotion) {
          // TODO: Remove this hack by storing the pen-up/pen-down heights
          // in a single place, and reference them from the PenMotions.
          if (j === this.motions.length - 1) {
            return new PenMotion(penDownHeight, penUpHeight, motion.duration());
          }
          return penMotionIndex++ % 2 === 0
            ? new PenMotion(penUpHeight, penDownHeight, motion.duration())
            : new PenMotion(penDownHeight, penUpHeight, motion.duration());
        }
        throw new Error(`Wrong motion ${motion}`);
      }),
    );
  }

  public serialize(): MotionData[] {
    return this.motions.map((m) => m.serialize());
  }
}

class Segment {
  public maxEntryVelocity = 0;
  public entryVelocity = 0;

  constructor(
    public p1: Vec2,
    public p2: Vec2,
    public blocks: Block[] = [],
  ) {}
  public length(): number {
    return vlen(vsub(this.p2, this.p1));
  }
  public direction(): Vec2 {
    return vnorm(vsub(this.p2, this.p1));
  }
}

function cornerVelocity(seg1: Segment, seg2: Segment, vMax: number, accel: number, cornerFactor: number): number {
  // https://onehossshay.wordpress.com/2011/09/24/improving_grbl_cornering_algorithm/
  const cosine = -vdot(seg1.direction(), seg2.direction());
  // assert(!cosine.isNaN, s"cosine was NaN: $seg1, $seg2, ${seg1.direction}, ${seg2.direction}")
  if (Math.abs(cosine - 1) < epsilon) {
    return 0;
  }
  const sine = Math.sqrt((1 - cosine) / 2);
  if (Math.abs(sine - 1) < epsilon) {
    return vMax;
  }
  const v = Math.sqrt((accel * cornerFactor * sine) / (1 - sine));
  // assert(!v.isNaN, s"v was NaN: $accel, $cornerFactor, $sine")
  return Math.min(v, vMax);
}

/** Represents a triangular velocity profile for moving in a straight line.
 *
 * {{{
 * +a ^____,        positive acceleration until maximum velocity is reached
 *    |    |
 *    |----|---> t
 *    |    |___
 * -a v             followed by negative acceleration until final velocity is reached
 *
 * +v ^    ,
 *    |  ,' `.
 * vi |,'     `  vf
 *    |
 *    +--------> t
 * }}}
 *
 * @param s1 the length of the first (accelerating) part of the profile.
 * @param s2 the length of the second (decelerating) part of the profile.
 * @param t1 the duration of the first (accelerating) part of the profile.
 * @param t2 the duration of the second (decelerating) part of the profile.
 * @param vMax the maximum velocity achieved during the motion.
 * @param p1 the initial position
 * @param p2 the position at v=vMax
 * @param p3 the final position
 */
interface Triangle {
  s1: number;
  s2: number;
  t1: number;
  t2: number;
  vMax: number;
  p1: Vec2;
  p2: Vec2;
  p3: Vec2;
}
/** Compute a triangular velocity profile with piecewise constant acceleration.
 *
 * The maximum velocity is derived from the acceleration and the distance to be travelled.
 *
 * @param distance Distance to travel (equal to |p3-p1|).
 * @param initialVel Starting velocity, unit length per unit time.
 * @param finalVel Final velocity, unit length per unit time.
 * @param accel Magnitude of acceleration, unit length per unit time per unit time.
 * @param p1 Starting point.
 * @param p3 Ending point.
 * @return
 */
function computeTriangle(
  distance: number,
  initialVel: number,
  finalVel: number,
  accel: number,
  p1: Vec2,
  p3: Vec2,
): Triangle {
  const acceleratingDistance = (2 * accel * distance + finalVel * finalVel - initialVel * initialVel) / (4 * accel);
  const deceleratingDistance = distance - acceleratingDistance;
  const vMax = Math.sqrt(initialVel * initialVel + 2 * accel * acceleratingDistance);
  const t1 = (vMax - initialVel) / accel;
  const t2 = (finalVel - vMax) / -accel;
  const p2 = vadd(p1, vmul(vnorm(vsub(p3, p1)), acceleratingDistance));
  return { s1: acceleratingDistance, s2: deceleratingDistance, t1, t2, vMax, p1, p2, p3 };
}

/** Represents a trapezoidal velocity profile for moving in a straight line.
 *
 * {{{
 * +a ^____,           positive acceleration until maximum velocity is reached
 *    |    |
 *    |----+--+---> t  then zero acceleration while at maximum velocity
 *    |       |___
 * -a v                finally, negative acceleration until final velocity is reached
 *
 * +v ^    ,...     vmax
 *    |  ,'    `.
 * vi |,'        `  vf
 *    |
 *    +-----------> t
 * }}}
 *
 * @param s1 the length of the first (accelerating) part of the profile.
 * @param s2 the length of the second (constant velocity) part of the profile.
 * @param s3 the length of the third (decelerating) part of the profile.
 * @param t1 the duration of the first (accelerating) part of the profile.
 * @param t2 the duration of the second (constant velocity) part of the profile.
 * @param t3 the duration of the third (decelerating) part of the profile.
 * @param p1 the initial position.
 * @param p2 the position upon achieving v=vMax and beginning constant velocity interval.
 * @param p3 the position upon beginning to decelerate after v=vMax.
 * @param p4 the final position.
 */
interface Trapezoid {
  s1: number;
  s2: number;
  s3: number;
  t1: number;
  t2: number;
  t3: number;
  p1: Vec2;
  p2: Vec2;
  p3: Vec2;
  p4: Vec2;
}
function computeTrapezoid(
  distance: number,
  initialVel: number,
  maxVel: number,
  finalVel: number,
  accel: number,
  p1: Vec2,
  p4: Vec2,
): Trapezoid {
  const t1 = (maxVel - initialVel) / accel;
  const s1 = ((maxVel + initialVel) / 2) * t1;
  const t3 = (finalVel - maxVel) / -accel;
  const s3 = ((finalVel + maxVel) / 2) * t3;
  const s2 = distance - s1 - s3;
  const t2 = s2 / maxVel;
  const dir = vnorm(vsub(p4, p1));
  const p2 = vadd(p1, vmul(dir, s1));
  const p3 = vadd(p1, vmul(dir, distance - s3));
  return { s1, s2, s3, t1, t2, t3, p1, p2, p3, p4 };
}

function dedupPoints(points: Vec2[], epsilon: number): Vec2[] {
  if (epsilon === 0) {
    return points;
  }
  const dedupedPoints: Vec2[] = [];
  dedupedPoints.push(points[0]);
  for (const p of points.slice(1)) {
    if (vlen(vsub(p, dedupedPoints[dedupedPoints.length - 1])) > epsilon) {
      dedupedPoints.push(p);
    }
  }
  return dedupedPoints;
}

/**
 * Plan a path, using a constant acceleration profile.
 * This function plans only a single x/y motion of the tool,
 * i.e. between a single pen-down/pen-up pair.
 *
 * @param points Sequence of points to pass through
 * @param profile Tooling profile to use
 * @return A plan of action
 */
export function constantAccelerationPlan(points: Vec2[], profile: AccelerationProfile): XYMotion {
  const dedupedPoints = dedupPoints(points, epsilon);
  if (dedupedPoints.length === 1) {
    return new XYMotion([new Block(0, 0, 0, dedupedPoints[0], dedupedPoints[0])]);
  }
  const segments = dedupedPoints.slice(1).map((a, i) => new Segment(dedupedPoints[i], a));

  const accel = profile.acceleration;
  const vMax = profile.maximumVelocity;
  const cornerFactor = profile.corneringFactor;

  // Calculate the maximum entry velocity for each segment based on the angle between it
  // and the previous segment.
  segments.slice(1).forEach((seg2, i) => {
    const seg1 = segments[i];
    seg2.maxEntryVelocity = cornerVelocity(seg1, seg2, vMax, accel, cornerFactor);
  });

  // This is to force the velocity to zero at the end of the path.
  const lastPoint = dedupedPoints[dedupedPoints.length - 1];
  segments.push(new Segment(lastPoint, lastPoint));

  let i = 0;
  while (i < segments.length - 1) {
    const segment = segments[i];
    const nextSegment = segments[i + 1];
    const distance = segment.length();
    const vInitial = segment.entryVelocity;
    const vExit = nextSegment.maxEntryVelocity;
    const p1 = segment.p1;
    const p2 = segment.p2;

    const m = computeTriangle(distance, vInitial, vExit, accel, p1, p2);
    if (m.s1 < -epsilon) {
      // We'd have to start decelerating _before we started on this segment_. backtrack.
      // In order enter this segment slow enough to be leaving it at vExit, we need to
      // compute a maximum entry velocity s.t. we can slow down in the distance we have.
      // TODO: verify this equation.
      segment.maxEntryVelocity = Math.sqrt(vExit * vExit + 2 * accel * distance);
      i -= 1;
    } else if (m.s2 <= 0) {
      // No deceleration.
      // TODO: shouldn't we check vMax here and maybe do trapezoid? should the next case below come first?
      const vFinal = Math.sqrt(vInitial * vInitial + 2 * accel * distance);
      const t = (vFinal - vInitial) / accel;
      segment.blocks = [new Block(accel, t, vInitial, p1, p2)];
      nextSegment.entryVelocity = vFinal;
      i += 1;
    } else if (m.vMax > vMax) {
      // Triangle profile would exceed maximum velocity, so top out at vMax.
      const z = computeTrapezoid(distance, vInitial, vMax, vExit, accel, p1, p2);
      segment.blocks = [
        new Block(accel, z.t1, vInitial, z.p1, z.p2),
        new Block(0, z.t2, vMax, z.p2, z.p3),
        new Block(-accel, z.t3, vMax, z.p3, z.p4),
      ];
      nextSegment.entryVelocity = vExit;
      i += 1;
    } else {
      // Accelerate, then decelerate.
      segment.blocks = [new Block(accel, m.t1, vInitial, m.p1, m.p2), new Block(-accel, m.t2, m.vMax, m.p2, m.p3)];
      nextSegment.entryVelocity = vExit;
      i += 1;
    }
  }
  const blocks: Block[] = [];
  for (const segment of segments) {
    for (const block of segment.blocks) {
      if (block.duration > epsilon) {
        blocks.push(block);
      }
    }
  }
  return new XYMotion(blocks);
}

/**
 * Build a Plan from a list of lines and profile parameters.
 * @param paths list of lines, each a list of Vec2
 * @param profile machine parameters
 * @param penHome initial location of the pen
 * @returns A full Plan
 */
export function plan(paths: Vec2[][], profile: ToolingProfile, penHome: Vec2 = { x: 0, y: 0 }): Plan {
  const motions: Motion[] = [];
  let curPos = penHome;

  const penMotions = {
    up: new PenMotion(profile.penDownPos, profile.penUpPos, profile.penLiftDuration),
    down: new PenMotion(profile.penUpPos, profile.penDownPos, profile.penDropDuration),
  };

  // For each path - move to the initial position, put the pen down, draw the path, bring pen up
  for (const path of paths) {
    const motion = constantAccelerationPlan(path, profile.penDownProfile);
    const position = constantAccelerationPlan([curPos, motion.p1], profile.penUpProfile);
    motions.push(position, penMotions.down, motion, penMotions.up);
    curPos = motion.p2;
  }

  // Final return to pen home
  motions.push(constantAccelerationPlan([curPos, penHome], profile.penUpProfile));
  return new Plan(motions);
}

/**
 * Find the motion index at which each drawn path starts in the plan.
 * plan() emits a fixed 4-motion group per path:
 *   [travel (XYMotion), pen down (PenMotion), draw (XYMotion), pen up (PenMotion)]
 * A group start is an XYMotion immediately followed by a pen-down PenMotion
 * (penPct increasing: initialPos < finalPos; larger pct = lower pen).
 * These indices are the valid resume points for rewind-and-redraw.
 */
export function pathGroupStarts(plan: Plan): number[] {
  const starts: number[] = [];
  const motions = plan.motions;
  for (let i = 0; i < motions.length - 1; i++) {
    const m = motions[i];
    const next = motions[i + 1];
    if (m instanceof XYMotion && next instanceof PenMotion && next.initialPos < next.finalPos) {
      starts.push(i);
    }
  }
  return starts;
}

/**
 * Snap a user-chosen motion index to the nearest path-group start at or
 * before it, so that resuming always begins with a pen-up travel move
 * planned from rest.
 */
export function snapToGroupStart(plan: Plan, motionIdx: number): number {
  const starts = pathGroupStarts(plan);
  let best = starts[0] ?? 0;
  for (const s of starts) {
    if (s <= motionIdx) best = s;
    else break;
  }
  return best;
}

/**
 * Build a safe pen-up travel move from `from` to `to` for rewinding:
 * the acceleration/velocity profile is extracted from the plan's own
 * travel moves, so it matches the machine's configured speeds.
 */
export function rewindTravelMotion(plan: Plan, from: Vec2, to: Vec2): XYMotion {
  for (const m of plan.motions) {
    if (m instanceof XYMotion && m.blocks.length > 0 && m.blocks[0].vInitial === 0 && m.blocks[0].accel > 0) {
      const vMax = Math.max(...m.blocks.map((b) => b.vFinal));
      const accel = m.blocks[0].accel;
      return constantAccelerationPlan([from, to], { acceleration: accel, maximumVelocity: vMax, corneringFactor: 0 });
    }
  }
  // Fallback: conservative generic pen-up profile.
  return constantAccelerationPlan([from, to], { acceleration: 400, maximumVelocity: 200, corneringFactor: 0 });
}
