import { type Vec2 } from "./vec.js";
import { PaperSize } from "./paper-size.js";
import { type Plan, PenMotion, XYMotion } from "./planning.js";

/**
 * Convert a Plan back to SVG string.
 * Uses pen-down motions only, preserving path optimization
 * and hidden-line removal results.
 * @param plan - The computed plan（坐标为毫米口径）
 * @param paperSize - Paper dimensions in mm
 * @param rotationDeg - 生成该 Plan 时已应用的「旋转绘制」角（度，顺时针为正）。
 *   写入根节点 data-b2a-rotate-deg 标记：该文件是最终排版结果，坐标已含此
 *   旋转，重新导入时不再施加任何旋转（所见即所得）——否则导出/导入每循环
 *   一圈旋转就被叠加一次（图形越转越偏、越缩越小）。
 * @returns SVG string
 */
export function planToSvg(plan: Plan, paperSize: PaperSize, rotationDeg = 0): string {
  const paths: Vec2[][] = [];

  let penDown = false;
  for (const motion of plan.motions) {
    if (motion instanceof PenMotion) {
      // Plan 笔位为 pct 口径（0 = 完全抬笔，100 = 完全落笔）：pct 升 = 落笔。
      // 历史 bug：曾用舵机空间时代的 finalPos < initialPos（值小 = 落笔），
      // pct 空间下方向恰好相反，导致导出的全是空程跳线、真正的绘制被丢弃。
      penDown = motion.finalPos > motion.initialPos;
      continue;
    }
    if (!penDown) continue;
    if (!(motion instanceof XYMotion)) continue;
    if (motion.blocks.length === 0) continue;

    // Reconstruct polyline from motion blocks.
    // This mirrors PlanPreview's rendering logic.（坐标已是毫米）
    const points = motion.blocks.map((b) => b.p1).concat([motion.p2]);
    if (points.length < 2) continue;

    // Remove consecutive duplicate points
    const deduped: Vec2[] = [];
    for (const pt of points) {
      const last = deduped[deduped.length - 1];
      if (!last || last.x !== pt.x || last.y !== pt.y) {
        deduped.push(pt);
      }
    }
    if (deduped.length >= 2) {
      paths.push(deduped);
    }
  }

  // Build SVG
  const pathElements = paths
    .map((path) => {
      const d = path
        .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(4)} ${p.y.toFixed(4)}`)
        .join(" ");
      return `    <path d="${d}" stroke="black" stroke-width="0.1" fill="none" />`;
    })
    .join("\n");

  const w = paperSize.size.x.toFixed(2);
  const h = paperSize.size.y.toFixed(2);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    // 不再输出白色背景 <rect>：导入时它会被当成一条整页大的笔画路径（出现
    // "none" 图层），既污染图层列表，又把 fit 缩放的包围盒撑到整页，使重
    // 导入的图形比原图缩小一圈。背景对绘图机文件没有意义，直接省略。
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}mm" height="${h}mm" data-b2a-rotate-deg="${rotationDeg}">`,
    pathElements,
    "</svg>",
    "",
  ].join("\n");
}
