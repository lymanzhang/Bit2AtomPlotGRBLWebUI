/**
 * Plan → G-code 文件导出（任务 3.9）。
 *
 * 复用 2.2 转译层（translatePlanToGCode）同口径生成动作行流；本模块补齐
 * 文件级封装：头部注释块（源文件名、导出时间、硬件档案关键参数、Z 抬笔/
 * 落笔高度、进给/限速建议）与目标固件 $100–$102 步/mm 匹配提示。
 *
 * 头部是纯注释（`;` 前缀），不影响固件解析；动作部分与「浏览器直连 /
 * 服务端执行」的实时转译完全一致（同一 translatePlanToGCode），保证
 * 「导出的文件拿去别台设备跑」与「本机直接绘制」同口径。
 */

import { translatePlanToGCode, type GCodeLimits } from "./gcode.js";
import { computeMicrostepsPerMm, computeZStepsPerMm, type DriveParams, type Plan } from "./planning.js";
import { zAxisConfigFromDriveParams, type ZAxisConfig } from "./zaxis.js";

export interface GCodeExportOptions {
  /** 源文件名（SVG 或导入的 G-code）；无源文件时为 null */
  sourceFileName: string | null;
  /** 当前硬件档案（Z 配置 / 步进密度 / 固件限速均取自此） */
  driveParams: DriveParams;
  /** 设备档案显示名（预设档 key 或自定义名） */
  hardwareLabel?: string;
}

const num = (v: number | undefined, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** XY 限速（$110/$111，mm/min）建议值；档案未配置时不写该行 */
function xyMaxVelLines(dp: DriveParams): string[] {
  const v = dp.firmware?.maxVelocityMmMin;
  const parts: string[] = [];
  if (v?.x != null) parts.push(`$110=${num(v.x)}`);
  if (v?.y != null) parts.push(`$111=${num(v.y)}`);
  return parts.length > 0 ? [`; XY 最大速率建议: ${parts.join(" / ")}`] : [];
}

/**
 * 导出 Plan 为 G-code 文本。动作行流与执行路径同口径（translatePlanToGCode），
 * 收尾自动补抬笔行防止划伤纸面。
 */
export function planToGCode(plan: Plan, options: GCodeExportOptions): string {
  const dp = options.driveParams;
  const z: ZAxisConfig = zAxisConfigFromDriveParams(dp);
  const limits: GCodeLimits = { maxVelMmMin: dp.firmware?.maxVelocityMmMin };

  const header: string[] = [
    "; ============================================================",
    "; Bit2AtomPlotGRBL G-code 导出",
    `; 源文件: ${options.sourceFileName ?? "(未命名)"}`,
    `; 导出时间: ${new Date().toISOString()}`,
    `; 设备档案: ${[options.hardwareLabel, dp.name].filter((s) => s).join(" - ") || "(默认)"}`,
    `; Z 抬笔高度: ${z.zPenUpMm} mm / 落笔高度: ${z.zPenDownMm} mm / Z 进给: ${z.zFeedMmMin} mm/min`,
    `; 步进密度建议: $100/$101=${computeMicrostepsPerMm(dp)} $102=${computeZStepsPerMm(dp)} (步/mm)`,
    ...xyMaxVelLines(dp),
    "; 注意: 目标固件的 $100-$102 步/mm 必须与上述建议值一致，否则绘制比例失真；",
    ";       G21 毫米 / G90 绝对 / G54 工作坐标系，Z 轴用于抬笔落笔。",
    "; ============================================================",
  ];

  const translation = translatePlanToGCode(plan, { z, limits });
  return [...header, ...translation.lines].join("\r\n") + "\r\n";
}
