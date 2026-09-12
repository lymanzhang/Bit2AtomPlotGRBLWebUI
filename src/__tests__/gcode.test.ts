import { expect, test } from "vitest";
import { translatePlanToGCode } from "../gcode.js";
import { Block, Plan, PenMotion, XYMotion } from "../planning.js";
import { type Vec2 } from "../vec.js";
import { type ZAxisConfig } from "../zaxis.js";

const z: ZAxisConfig = { zPenDownMm: 0, zPenUpMm: 5, zFeedMmMin: 600 };

/** 恒加速块：p1→p2，速度 v0→v1（mm/s），时长 1s（accel = v1-v0） */
const block = (p1: Vec2, p2: Vec2, v0: number, v1: number) => new Block(v1 - v0, 1, v0, p1, p2);

const v = (x: number, y: number): Vec2 => ({ x, y });

/** 头部 5 行（2 注释 + G21/G90/G54），之后才是动作行 */
const HEADER_LINES = 5;

test("基本转译：落笔 G1 带 F、抬笔空程 G0、PenMotion 转 Z 轴", () => {
  const plan = new Plan([
    new PenMotion(50, 60, 0.2), // 落笔：pct 60 → Z 2mm
    new XYMotion([block(v(0, 0), v(10, 0), 0, 25)]),
    new XYMotion([block(v(10, 0), v(10, 5), 25, 25)]),
    new PenMotion(60, 50, 0.2), // 抬笔：pct 50 → Z 2.5mm
    new XYMotion([block(v(10, 5), v(0, 0), 200, 200)]),
  ]);
  const r = translatePlanToGCode(plan, { z });
  expect(r.lines.slice(HEADER_LINES)).toEqual([
    "G1 Z2 F600",
    "G1 X10 Y0 F1500", // vFinal 25mm/s × 60 = 1500mm/min
    "G1 X10 Y5 F1500",
    "G1 Z2.5 F600",
    "G0 X0 Y0",
  ]);
});

test("头部约定：G21 / G90 / G54 按序出现", () => {
  const plan = new Plan([new XYMotion([block(v(0, 0), v(1, 1), 10, 10)])]);
  const r = translatePlanToGCode(plan, { z });
  const mode = r.lines.filter((l) => ["G21", "G90", "G54"].includes(l));
  expect(mode).toEqual(["G21", "G90", "G54"]);
});

test("索引映射：行区间与行→动作双向一致，头部行映射 -1", () => {
  const plan = new Plan([
    new PenMotion(50, 60, 0.2),
    new XYMotion([block(v(0, 0), v(10, 0), 0, 25), block(v(10, 0), v(10, 5), 25, 25)]),
    new PenMotion(60, 50, 0.2),
    new XYMotion([block(v(10, 5), v(0, 0), 200, 200)]),
  ]);
  const r = translatePlanToGCode(plan, { z });
  expect(r.lineToMotion).toHaveLength(r.lines.length);
  // 头部与脚注不归属任何动作
  for (let i = 0; i < HEADER_LINES; i++) expect(r.lineToMotion[i]).toBe(-1);
  // 双向一致：区间内的行都映射回该动作，区间外都不是
  plan.motions.forEach((_, i) => {
    const range = r.motionLineRanges[i];
    expect(range).not.toBeNull();
    for (let line = 0; line < r.lines.length; line++) {
      if (line >= range!.start && line < range!.end) expect(r.lineToMotion[line]).toBe(i);
      else expect(r.lineToMotion[line]).not.toBe(i);
    }
  });
});

test("F 值受 $110/$111 钳制", () => {
  const plan = new Plan([
    new PenMotion(50, 60, 0.2),
    new XYMotion([block(v(0, 0), v(10, 0), 0, 100)]), // 100mm/s → 6000mm/min
  ]);
  const r = translatePlanToGCode(plan, { z, limits: { maxVelMmMin: { x: 3000 } } });
  expect(r.lines[HEADER_LINES + 1]).toBe("G1 X10 Y0 F3000"); // 前置 PenMotion 占 1 行
});

test("零长块跳过，区间只覆盖有效行", () => {
  const plan = new Plan([
    new PenMotion(50, 60, 0.2),
    new XYMotion([block(v(5, 5), v(5, 5), 10, 10), block(v(5, 5), v(10, 5), 10, 10)]),
  ]);
  const r = translatePlanToGCode(plan, { z });
  expect(r.motionLineRanges[1]).toEqual({ start: HEADER_LINES + 1, end: HEADER_LINES + 2 });
  expect(r.lines[HEADER_LINES + 1]).toBe("G1 X10 Y5 F600"); // vFinal 10 × 60
  // 纯零长动作：区间为 null
  const empty = new Plan([new PenMotion(50, 60, 0.2), new XYMotion([block(v(5, 5), v(5, 5), 10, 10)])]);
  const r2 = translatePlanToGCode(empty, { z });
  expect(r2.motionLineRanges[1]).toBeNull();
});

test("vFinal ≈ 0（拐角停顿）时省略 F 字，沿用模态进给", () => {
  const plan = new Plan([
    new PenMotion(50, 60, 0.2), // 设定模态 F600
    new XYMotion([block(v(0, 0), v(10, 0), 0, 0)]),
  ]);
  const r = translatePlanToGCode(plan, { z });
  expect(r.lines[HEADER_LINES + 1]).toBe("G1 X10 Y0");
});

test("Plan 以落笔状态收尾时，脚注强制抬笔（不归属动作）", () => {
  const plan = new Plan([
    new PenMotion(50, 60, 0.2),
    new XYMotion([block(v(0, 0), v(10, 0), 0, 25)]),
  ]);
  const r = translatePlanToGCode(plan, { z });
  expect(r.lines[r.lines.length - 1]).toBe("G1 Z5 F600");
  expect(r.lineToMotion[r.lines.length - 1]).toBe(-1);
});

test("预计时长：落笔块按平均速度、PenMotion 按 ΔZ ÷ Z 进给", () => {
  const plan = new Plan([
    new PenMotion(50, 60, 999), // ΔZ 0.5mm @ 10mm/s → 0.05s
    new XYMotion([block(v(0, 0), v(10, 0), 0, 25)]), // avg 12.5 → 10/12.5 = 0.8s
    new XYMotion([block(v(10, 0), v(10, 5), 25, 25)]), // 5/25 = 0.2s
    new PenMotion(60, 50, 999), // 0.05s
    new XYMotion([block(v(10, 5), v(0, 0), 200, 200)]), // √125 / 200 ≈ 0.0559s
  ]);
  const r = translatePlanToGCode(plan, { z });
  expect(r.estimatedDurationSec).toBeCloseTo(0.05 + 0.8 + 0.2 + 0.05 + Math.sqrt(125) / 200, 3);
});

test("预计时长：G0 空程按 $110/$111 最大速率估算", () => {
  const plan = new Plan([new XYMotion([block(v(0, 0), v(0, 50), 200, 200)])]);
  const limited = translatePlanToGCode(plan, { z, limits: { maxVelMmMin: { x: 3000, y: 6000 } } });
  // 合成限速 min(3000,6000)/60 = 50mm/s → 50/50 = 1s
  expect(limited.estimatedDurationSec).toBeCloseTo(1, 3);
  // 未提供限速：回退块平均速度 200mm/s → 0.25s
  const fallback = translatePlanToGCode(plan, { z });
  expect(fallback.estimatedDurationSec).toBeCloseTo(0.25, 3);
});

test("预计时长：PenMotion 受 $112 钳制", () => {
  const plan = new Plan([new PenMotion(0, 100, 999)]); // ΔZ 5mm
  const r = translatePlanToGCode(plan, { z, limits: { maxVelMmMin: { z: 300 } } });
  expect(r.estimatedDurationSec).toBeCloseTo(1, 3); // 5mm @ 5mm/s
});
