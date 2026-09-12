import { describe, expect, it } from "vitest";
import { planToGCode } from "../export-gcode.js";
import { parseGcode, defaultGcodeImportPlanOptions } from "../gcode-import.js";
import { applyMachineFrame, Block, defaultPlanOptions, PenMotion, Plan, XYMotion } from "../planning.js";
import type { OriginCorner } from "../planning.js";
import type { Vec2 } from "../vec.js";

const p = (x: number, y: number): Vec2 => ({ x, y });
const PAPER = { x: 100, y: 100 };

/** 屏幕空间样例 Plan：空程 → 落笔 → 画 L 形 → 抬笔 */
function samplePlan(): Plan {
  const travel = new XYMotion([new Block(0, 0.1, 0, p(0, 0), p(10, 10))]);
  const drop = new PenMotion(30, 90, 0.1);
  const draw = new XYMotion([
    new Block(0, 0.1, 0, p(10, 10), p(50, 10)),
    new Block(0, 0.1, 0, p(50, 10), p(50, 50)),
  ]);
  const lift = new PenMotion(90, 30, 0.1);
  const travelBack = new XYMotion([new Block(0, 0.1, 0, p(50, 50), p(0, 0))]);
  return new Plan([travel, drop, draw, lift, travelBack]);
}

/**
 * 落笔段的几何指纹：每条笔画的起点/终点/折线总长。
 * （导入侧 Plan 合成按速度曲线把 G1 段细分为多个恒加速块，点数不可直接
 * 比较，但几何指纹在往返两侧必然一致。）
 */
interface StrokeFingerprint {
  start: Vec2;
  end: Vec2;
  length: number;
}

function penDownStrokes(plan: Plan): StrokeFingerprint[] {
  const runs: StrokeFingerprint[] = [];
  let down = false;
  let cur: { start: Vec2; last: Vec2; length: number } | null = null;
  const flush = () => {
    if (cur) runs.push({ start: cur.start, end: cur.last, length: cur.length });
    cur = null;
  };
  for (const m of plan.motions) {
    if (m instanceof PenMotion) {
      flush();
      down = m.finalPos > m.initialPos;
      continue;
    }
    if (!down) continue;
    for (const b of m.blocks) {
      if (!cur) cur = { start: b.p1, last: b.p1, length: 0 };
      cur.length += Math.hypot(b.p2.x - cur.last.x, b.p2.y - cur.last.y);
      cur.last = b.p2;
    }
  }
  flush();
  return runs;
}

const eq = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

/**
 * 回归验证：G-code 导入的机器坐标 → 屏幕坐标归一化。
 *
 * 历史 bug：导出 G-code 前经 applyMachineFrame 做 屏幕→机器 变换（如左下
 * 原点 = Y 轴镜像），但 UI 导入时把机器坐标直接当屏幕坐标显示，预览与原
 * SVG 沿 X 轴镜像、模拟起点落在屏幕左上而非原点角。镜像变换自逆：导入时
 * 按当前原点角再应用一次同角变换即归一化回屏幕空间。
 */
describe("G-code 导入机器坐标归一化（帧变换自逆往返）", () => {
  for (const corner of ["top-left", "bottom-left", "top-right", "bottom-right"] as const satisfies readonly OriginCorner[]) {
    it(`原点 ${corner}：导出→导入→逆变换 几何无损`, () => {
      const original = samplePlan();
      // 屏幕 → 机器（导出路径）
      const machine = applyMachineFrame(original, corner, PAPER);
      const gcode = planToGCode(machine, {
        sourceFileName: "frame.svg",
        driveParams: { ...defaultPlanOptions.driveParams, originCorner: corner },
      });
      // 机器 → 屏幕（导入路径，与 ui.tsx handleFile 归一化同口径）
      const imported = parseGcode(gcode, defaultGcodeImportPlanOptions());
      const screen = applyMachineFrame(imported.plan, corner, PAPER);
      const a = penDownStrokes(original);
      const b = penDownStrokes(screen);
      expect(b.length).toBe(a.length);
      for (let i = 0; i < a.length; i++) {
        expect(eq(a[i].start, b[i].start), `笔画 ${i} 起点: ${JSON.stringify(a[i].start)} vs ${JSON.stringify(b[i].start)}`).toBe(true);
        expect(eq(a[i].end, b[i].end), `笔画 ${i} 终点: ${JSON.stringify(a[i].end)} vs ${JSON.stringify(b[i].end)}`).toBe(true);
        expect(Math.abs(a[i].length - b[i].length)).toBeLessThan(1e-6);
      }
    });
  }

  it("左下原点：未归一化的导入数据确实 Y 镜像（保护测试语义）", () => {
    const original = samplePlan();
    const machine = applyMachineFrame(original, "bottom-left", PAPER);
    const gcode = planToGCode(machine, {
      sourceFileName: "frame.svg",
      driveParams: { ...defaultPlanOptions.driveParams, originCorner: "bottom-left" },
    });
    const imported = parseGcode(gcode, defaultGcodeImportPlanOptions());
    const raw = penDownStrokes(imported.plan);
    const expect0 = penDownStrokes(original);
    // 未逆变换：Y = 100 - y（左下原点导出）；X 不变
    expect(eq(raw[0].start, { x: expect0[0].start.x, y: PAPER.y - expect0[0].start.y })).toBe(true);
  });
});
