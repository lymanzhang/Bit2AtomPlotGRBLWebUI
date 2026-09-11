import { type Vec2 } from "./vec.js";
import { PaperSize } from "./paper-size.js";
import { type Plan, PenMotion, XYMotion } from "./planning.js";

/**
 * Convert a Plan back to SVG string.
 * Uses pen-down motions only, preserving path optimization
 * and hidden-line removal results.
 * @param plan - The computed plan
 * @param stepsPerMm - Steps per millimeter for the current hardware
 * @param paperSize - Paper dimensions in mm
 * @returns SVG string
 */
export function planToSvg(
  plan: Plan,
  stepsPerMm: number,
  paperSize: PaperSize,
): string {
  const paths: Vec2[][] = [];

  let penDown = false;
  for (const motion of plan.motions) {
    if (motion instanceof PenMotion) {
      penDown = motion.finalPos < motion.initialPos;
      continue;
    }
    if (!penDown) continue;
    if (!(motion instanceof XYMotion)) continue;
    if (motion.blocks.length === 0) continue;

    // Reconstruct polyline from motion blocks.
    // This mirrors PlanPreview's rendering logic.
    const points = motion.blocks.map((b) => b.p1).concat([motion.p2]);
    if (points.length < 2) continue;

    // Convert from steps to mm
    const mmPoints = points.map((p) => ({
      x: p.x / stepsPerMm,
      y: p.y / stepsPerMm,
    }));

    // Remove consecutive duplicate points
    const deduped: Vec2[] = [];
    for (const pt of mmPoints) {
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
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}mm" height="${h}mm">`,
    `  <rect x="0" y="0" width="${w}" height="${h}" fill="white" stroke="none" />`,
    pathElements,
    "</svg>",
    "",
  ].join("\n");
}
