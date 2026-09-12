import { describe, expect, it } from "vitest";
import { applyMachineFrame, AxidrawFast, type Plan, plan, PenMotion, XYMotion } from "../planning.js";
import type { Vec2 } from "../vec.js";

/**
 * 机器原点角映射（applyMachineFrame）：预览/排版固定屏幕方位（原点在纸面
 * 左上、+X 右、+Y 下），执行层按 DriveParams.originCorner 把屏幕坐标映射为
 * 机器坐标。映射必须保持动作序列与时长不变（补画区间/进度索引一一对应）。
 */

const PATHS: Vec2[][] = [
  [
    { x: 10, y: 10 },
    { x: 30, y: 10 },
  ],
  [
    { x: 10, y: 20 },
    { x: 30, y: 40 },
  ],
];
const BASE = plan(PATHS, AxidrawFast);
const PAPER = { x: 100, y: 80 };

/** 收集 Plan 中全部 XY 端点（按出现顺序去重相邻重复） */
function xyPoints(p: Plan): Vec2[] {
  const pts: Vec2[] = [];
  for (const m of p.motions) {
    if (m instanceof XYMotion) {
      pts.push(m.p1, m.p2);
    }
  }
  return pts;
}

describe("applyMachineFrame（机器原点角映射）", () => {
  it("top-left 为恒等映射（返回原 Plan）", () => {
    expect(applyMachineFrame(BASE, "top-left", PAPER)).toBe(BASE);
  });

  it("bottom-left（CNC 惯例）：X 不变，Y 关于纸张水平中线镜像", () => {
    const framed = applyMachineFrame(BASE, "bottom-left", PAPER);
    const orig = xyPoints(BASE);
    const pts = xyPoints(framed);
    expect(pts).toHaveLength(orig.length);
    for (let i = 0; i < pts.length; i++) {
      expect(pts[i].x).toBeCloseTo(orig[i].x);
      expect(pts[i].y).toBeCloseTo(PAPER.y - orig[i].y);
    }
  });

  it("top-right：X 关于纸张竖直中线镜像，Y 不变", () => {
    const pts = xyPoints(applyMachineFrame(BASE, "top-right", PAPER));
    const orig = xyPoints(BASE);
    for (let i = 0; i < pts.length; i++) {
      expect(pts[i].x).toBeCloseTo(PAPER.x - orig[i].x);
      expect(pts[i].y).toBeCloseTo(orig[i].y);
    }
  });

  it("bottom-right：双轴镜像", () => {
    const pts = xyPoints(applyMachineFrame(BASE, "bottom-right", PAPER));
    const orig = xyPoints(BASE);
    for (let i = 0; i < pts.length; i++) {
      expect(pts[i].x).toBeCloseTo(PAPER.x - orig[i].x);
      expect(pts[i].y).toBeCloseTo(PAPER.y - orig[i].y);
    }
  });

  it("动作序列/时长/笔动作保持不变（补画区间与进度索引一一对应）", () => {
    const framed = applyMachineFrame(BASE, "bottom-left", PAPER);
    expect(framed.motions).toHaveLength(BASE.motions.length);
    expect(framed.duration()).toBeCloseTo(BASE.duration());
    for (let i = 0; i < BASE.motions.length; i++) {
      const a = BASE.motions[i];
      const b = framed.motions[i];
      expect(b.duration()).toBeCloseTo(a.duration());
      if (a instanceof PenMotion) {
        // PenMotion 无 XY 坐标：原对象保留
        expect(b).toBe(a);
        expect(b.initialPos).toBe(a.initialPos);
        expect(b.finalPos).toBe(a.finalPos);
      }
    }
  });
});
