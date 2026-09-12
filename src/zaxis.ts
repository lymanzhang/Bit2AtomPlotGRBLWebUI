/**
 * Z 轴抬笔后端（任务 2.3）。
 *
 * GRBL plotter 以 Z 轴步进电机抬笔/落笔：
 * - 笔高采用 penPct 口径（0 = 完全抬笔，100 = 完全落笔，即
 *   PlanOptions.penUpHeight/penDownHeight 的语义），由 penPctToZMm 线性
 *   映射到 [zPenUpMm, zPenDownMm] 行程。Plan PenMotion 位置即 pct 直存。
 * - PenMotion 的 duration 是 EBB 舵机时长的遗留口径；Z 轴下的真实时长
 *   = |ΔZ| ÷ Z 进给，由 penMotionDurationSec 重算（进度条与预计时长的
 *   正确性依赖此项，见 GRBL_PORT_PLAN.md 任务 2.3）。
 * - Z 步/mm 由档案 Z 传动参数推算（planning.computeZStepsPerMm），仅用于
 *   「参数助手」建议与 $102 校验对照；实际运动以设备 $102 为准。
 */
import { type DriveParams, type PenMotion } from "./planning.js";

export interface ZAxisConfig {
  /** 落笔 Z 高度 mm（通常 0，贴纸面） */
  zPenDownMm: number;
  /** 抬笔 Z 高度 mm（相对落笔的抬起行程） */
  zPenUpMm: number;
  /** Z 进给速度 mm/min */
  zFeedMmMin: number;
}

/** 从硬件档案提取 Z 轴配置（缺省值与 DriveParams 注释口径一致）。 */
export function zAxisConfigFromDriveParams(d: DriveParams): ZAxisConfig {
  return {
    zPenDownMm: d.zPenDownMm ?? 0,
    zPenUpMm: d.zPenUpMm ?? 5,
    zFeedMmMin: d.zFeedMmMin ?? 600,
  };
}

/**
 * penPct → Z 高度（mm）线性映射：pct 0 → zPenUpMm，pct 100 → zPenDownMm。
 * 越界 pct 钳制到 [0, 100]。
 */
export function penPctToZMm(pct: number, cfg: ZAxisConfig): number {
  const t = Math.min(100, Math.max(0, pct)) / 100;
  return cfg.zPenUpMm * (1 - t) + cfg.zPenDownMm * t;
}

/** Z 进给（mm/min），受设备 $112 最大 Z 速度钳制（档案缺省不钳制）。 */
export function effectiveZFeedMmMin(cfg: ZAxisConfig, zMaxVelMmMin?: number): number {
  return zMaxVelMmMin != null ? Math.min(cfg.zFeedMmMin, zMaxVelMmMin) : cfg.zFeedMmMin;
}

/**
 * 重算 PenMotion 时长（秒）：|ΔZ| ÷ 有效 Z 进给。
 * 进度条/预计时长的正确性依赖此项——EBB 舵机时长对 Z 轴无意义。
 */
export function penMotionDurationSec(pm: PenMotion, cfg: ZAxisConfig, zMaxVelMmMin?: number): number {
  const dz = Math.abs(penPctToZMm(pm.finalPos, cfg) - penPctToZMm(pm.initialPos, cfg));
  const feedMmS = effectiveZFeedMmMin(cfg, zMaxVelMmMin) / 60;
  return feedMmS > 0 ? dz / feedMmS : 0;
}
