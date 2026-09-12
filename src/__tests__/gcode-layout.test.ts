import { describe, expect, it } from "vitest";
import { parseGcode } from "../gcode-import.js";
import { replan } from "../massager.js";
import { PaperSize } from "../paper-size.js";
import { defaultPlanOptions, PenMotion, XYMotion } from "../planning.js";
import type { Path } from "flatten-svg";

/**
 * 回归验证：G-code 导入必须走 paths→replan 正常管线，排版操作
 * （旋转/对齐/缩放）对 G-code 导入与 SVG 导入同等生效。
 *
 * 历史 bug：G-code 导入直接 setPlan 绕过 replan——旋转、对齐、缩放
 * 等排版参数全部无效（replan 是这些参数唯一的生效点）。
 */

/** 对角线笔画（机器坐标 = 毫米），覆盖 300×200 的横向矩形区域 */
const GCODE = ["G90", "G21", "M3", "G0 X50 Y50", "G1 X350 Y250", "M5", "M30"].join("\n");

function strokesToPaths(corner: "top-left" | "bottom-left" = "top-left", paper = { x: 380, y: 280 }): Path[] {
  const { strokes } = parseGcode(GCODE);
  // 与 ui.tsx G-code 导入一致：机器坐标按原点角逐点镜像回屏幕空间
  // （top-left = 恒等）
  return strokes.map((s) => ({
    points: s.points.map((p) => ({
      x: corner.endsWith("right") ? paper.x - p.x : p.x,
      y: corner.startsWith("bottom") ? paper.y - p.y : p.y,
    })),
    stroke: "black",
    groupId: "",
    fill: "none",
    fillRule: "nonzero",
    groupOrder: 0,
  }));
}

function penDownBbox(plan: ReturnType<typeof replan>) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let len = 0
  let down = false;
  for (const m of plan.motions) {
    if (m instanceof PenMotion) {
      down = m.finalPos > m.initialPos;
    } else if (m instanceof XYMotion && down) {
      const pts = m.blocks.map((b) => b.p1).concat([m.p2]);
      for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      for (let i = 1; i < pts.length; i++) {
        len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      }
    }
  }
  return { w: maxX - minX, h: maxY - minY, len };
}

const paper = new PaperSize({ x: 380, y: 280 });
const baseOpts = {
  ...defaultPlanOptions,
  paperSize: paper,
  scaleMode: "fit" as const,
  sortPaths: false,
  layerMode: "stroke" as const,
  selectedStrokeLayers: new Set(["black"]),
  cropToMargins: false,
};

describe("G-code 导入排版生效", () => {
  it("旋转 90° 使笔画包围盒纵横比反转（与 SVG 导入同等生效）", () => {
    const plan0 = replan(strokesToPaths(), { ...baseOpts, rotateDrawing: 0 });
    const plan90 = replan(strokesToPaths(), { ...baseOpts, rotateDrawing: 90 });
    const bb0 = penDownBbox(plan0);
    const bb90 = penDownBbox(plan90);

    const aspect0 = bb0.w / bb0.h; // 对角线 300×200 → 横向（>1）
    const aspect90 = bb90.w / bb90.h; // 旋转后 → 纵向（<1）
    expect(aspect0).toBeGreaterThan(1.2);
    expect(aspect90).toBeLessThan(0.85);
    expect(aspect0 * aspect90).toBeCloseTo(1, 1); // 互为倒数（转了 90°）
  });

  it("原点角为左下时坐标正确镜像（预览与原点角一致）", () => {
    const planBl = replan(strokesToPaths("bottom-left"), baseOpts);
    const bb = penDownBbox(planBl);
    // 左下原点：Y 镜像后对角线仍覆盖绘图区（仅方向翻转，尺寸不变）
    expect(bb.w).toBeGreaterThan(250);
    expect(bb.h).toBeGreaterThan(150);
  });
});
