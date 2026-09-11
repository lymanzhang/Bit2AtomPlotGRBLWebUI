/**
 * gcode-import.ts 规格测试（TDD）
 *
 * gcode-import.ts 属阶段三任务 3.8，尚未实现。本测试按以下契约编写；
 * 实现时若签名有出入，请以「归一化输出」为准调整实现，而非修改断言：
 *
 *   parseGcode(source: string): GcodeImportResult
 *
 *   interface GcodeImportResult {
 *     plan: Plan;                 // planning.ts 标准 Plan（进入既有绘制管线）
 *     strokes: ImportedStroke[];  // 归一化笔画：绝对毫米坐标，圆弧已细分为折线
 *     warnings: { line: number; message: string; raw: string }[];
 *     stats: { totalLines: number; motionLines: number; penChanges: number;
 *              arcs: number; skippedLines: number };
 *   }
 *
 *   interface ImportedStroke {
 *     penDown: boolean;           // 仅落笔段构成笔画；抬笔空程不进 strokes
 *     feedMmMin: number | null;   // 笔画生效的 F 原值（mm/min）；mm/s 换算归 Plan 层
 *     points: { x: number; y: number }[];
 *   }
 *
 * 样例文件的笔控约定（两种方言均映射为笔动作）：
 *   Z 轴式：Z5.000 = 抬笔 / Z0.000 = 落笔；M3/M5 式：M3 = 落笔（S 忽略）/ M5 = 抬笔
 *
 * 断言值均取自样例文件注释中的期望坐标，几何推导见注释。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseGcode } from "../gcode-import";

const sample = readFileSync(
  fileURLToPath(new URL("./fixtures/gcode-sample-basic.gcode", import.meta.url)),
  "utf8",
);

type Pt = { x: number; y: number };
type Stroke = { penDown: boolean; feedMmMin: number | null; points: Pt[] };
type Warn = { line: number; message: string; raw: string };

function near(a: Pt, x: number, y: number, eps = 0.001): boolean {
  return Math.hypot(a.x - x, a.y - y) < eps;
}

/** 按笔画起点定位目标笔画，避免依赖 strokes 的整体顺序 */
function findStroke(strokes: Stroke[], x: number, y: number, eps = 0.01): Stroke {
  const hit = strokes.find((s) => near(s.points[0], x, y, eps));
  expect(hit, `找不到起点 (${x}, ${y}) 的笔画`).toBeTruthy();
  return hit as Stroke;
}

describe("gcode-import：样例文件解析", () => {
  const result = parseGcode(sample);

  it("告警统计：G4/M6 被跳过且留痕，N 行号剥离后不告警", () => {
    const raws = result.warnings.map((w: Warn) => w.raw);
    expect(raws.some((r) => r.includes("G4"))).toBe(true);
    expect(raws.some((r) => r.includes("M6"))).toBe(true);
    expect(result.warnings.every((w) => w.line > 0)).toBe(true);
    // N10/N11 剥离行号后应正常解析，不应产生告警
    expect(raws.some((r) => r.includes("N10") || r.includes("N11"))).toBe(false);
    expect(result.stats.skippedLines).toBeGreaterThanOrEqual(2);
  });

  it("第一组：Z 轴笔控 + 正方形闭合（F 显式与继承）", () => {
    const square = findStroke(result.strokes, 10, 10);
    expect(square.penDown).toBe(true);
    expect(square.feedMmMin).toBe(3000); // 首段显式 F3000，后续段继承
    expect(square.points.map((p) => [p.x, p.y])).toEqual([
      [10, 10],
      [40, 10],
      [40, 40],
      [10, 40],
      [10, 10],
    ]);
  });

  it("第二组：G3/G2 圆弧细分（90° 短弧，圆心/半径/中点校验）", () => {
    const arc = findStroke(result.strokes, 20, 10);
    expect(arc.penDown).toBe(true);
    expect(arc.feedMmMin).toBe(1500);
    // 起点 (20,10)、终点 (40,10)：两段弧首尾相接、一笔画完
    expect(near(arc.points[0], 20, 10)).toBe(true);
    expect(near(arc.points[arc.points.length - 1], 40, 10)).toBe(true);
    expect(arc.points.length).toBeGreaterThanOrEqual(8); // 细分密度下限
    // 弧 1（G3，圆心 (30,10)）中点 225°：30-10/√2, 10-10/√2
    expect(arc.points.some((p) => near(p, 22.929, 2.929, 0.6))).toBe(true);
    // 弧 2（G2，圆心 (40,0)）中点 135°：40-10/√2, 10/√2
    expect(arc.points.some((p) => near(p, 32.929, 7.071, 0.6))).toBe(true);
    // 半径约束：每个细分点距所属圆心 10mm（细分弦略偏内侧）
    for (const p of arc.points) {
      const r1 = Math.hypot(p.x - 30, p.y - 10);
      const r2 = Math.hypot(p.x - 40, p.y);
      expect((r1 > 9.5 && r1 < 10.05) || (r2 > 9.5 && r2 < 10.05)).toBe(true);
    }
  });

  it("第二组：整圆（无终点词 = 全圆）", () => {
    const circle = findStroke(result.strokes, 50, 50);
    expect(circle.penDown).toBe(true);
    expect(circle.feedMmMin).toBe(1800);
    // 圆心 (60,50)、半径 10：三个象限极值点均应被细分覆盖
    expect(circle.points.some((p) => near(p, 60, 40, 0.6))).toBe(true);
    expect(circle.points.some((p) => near(p, 70, 50, 0.6))).toBe(true);
    expect(circle.points.some((p) => near(p, 60, 60, 0.6))).toBe(true);
    expect(near(circle.points[circle.points.length - 1], 50, 50, 0.6)).toBe(true);
  });

  it("第三组：M3/M5 笔控方言（S 参数忽略）", () => {
    const s1 = findStroke(result.strokes, 10, 60);
    expect(s1.penDown).toBe(true);
    expect(s1.feedMmMin).toBe(2500);
    expect(s1.points.map((p) => [p.x, p.y])).toEqual([
      [10, 60],
      [30, 60],
      [30, 75],
    ]);
    const s2 = findStroke(result.strokes, 10, 85);
    expect(s2.penDown).toBe(true);
    expect(s2.points.map((p) => [p.x, p.y])).toEqual([
      [10, 85],
      [30, 85],
      [20, 92],
    ]);
  });

  it("第四组：G91 相对模式逐段换算并闭合回起点 (45,15)", () => {
    const tri = findStroke(result.strokes, 45, 15);
    expect(tri.penDown).toBe(true);
    expect(tri.points.map((p) => [p.x, p.y])).toEqual([
      [45, 15],
      [55, 15], // +(10,0)
      [50, 27], // +(-5,12)
      [45, 15], // +(-5,-12) 闭合
    ]);
  });

  it("第五组：N 行号剥离后的行程与绘制段", () => {
    const s = findStroke(result.strokes, 55, 40);
    expect(s.penDown).toBe(true);
    expect(s.points.map((p) => [p.x, p.y])).toEqual([[55, 40], [65, 40]]);
  });

  it("第六组：G20 英寸模式换算（1in = 25.4mm，F 换算为 mm/min）", () => {
    const s = findStroke(result.strokes, 50.8, 50.8);
    expect(s.penDown).toBe(true);
    expect(s.points.map((p) => [p.x, p.y])).toEqual([
      [50.8, 50.8],
      [76.2, 50.8], // 3in × 25.4
      [76.2, 76.2],
    ]);
    expect(s.feedMmMin).toBeCloseTo(1524, 6); // 60 in/min × 25.4
  });

  it("笔态收尾：所有输出笔画均为落笔段，最终笔态为抬笔（Z5）", () => {
    expect(result.strokes.every((s) => s.penDown)).toBe(true);
  });
});

describe("gcode-import：内联边界用例", () => {
  it("M30 之后的内容被忽略", () => {
    const r = parseGcode("G21\nG90\nM30\nG0 X99 Y99\nG1 X98 Y98 F1000\n");
    expect(r.strokes).toEqual([]);
  });

  it("G18/G19 非 XY 平面应告警（解析器仅假定 G17）", () => {
    const r = parseGcode("G21\nG18\nG0 X1 Y1\n");
    expect(r.warnings.some((w) => /G18|平面/.test(`${w.message} ${w.raw}`))).toBe(true);
  });

  it("空输入：无笔画、无告警、无致命错误", () => {
    const r = parseGcode("");
    expect(r.strokes).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("最小可用程序应产出非空 Plan（进入标准绘制管线）", () => {
    const r = parseGcode("G21\nG90\nG0 X10 Y10\nG1 Z0\nG1 X20 Y10 F3000\nG1 Z5\nM30\n");
    expect(r.plan).toBeTruthy();
    expect(r.strokes.length).toBe(1);
    expect(r.strokes[0].points.map((p) => [p.x, p.y])).toEqual([[10, 10], [20, 10]]);
  });
});
