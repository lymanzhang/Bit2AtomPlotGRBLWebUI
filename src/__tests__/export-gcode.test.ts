/**
 * export-gcode.ts 测试（任务 3.9）：文件级封装 + 与 2.2 转译层同口径。
 */
import { describe, expect, it } from "vitest";
import { planToGCode } from "../export-gcode";
import { Block, defaultPlanOptions, PenMotion, Plan, XYMotion } from "../planning";

const dp = defaultPlanOptions.driveParams;

describe("planToGCode 导出", () => {
  it("头部注释块：源文件名、步进密度建议、$100-$102 匹配提示", () => {
    const plan = new Plan([
      new PenMotion(50, 60, 0.12), // pct 空间：落笔
      new XYMotion([new Block(200, 1, 0, { x: 10, y: 10 }, { x: 20, y: 10 })]),
    ]);
    const g = planToGCode(plan, { sourceFileName: "demo.svg", driveParams: dp, hardwareLabel: "grbl11-screw" });
    expect(g).toContain("; 源文件: demo.svg");
    expect(g).toContain("; 设备档案: grbl11-screw");
    expect(g).toContain("; 步进密度建议: $100/$101=");
    expect(g).toContain("$100-$102");
    // 头部为纯注释行，动作指令在头部之后
    const firstNonComment = g
      .split("\r\n")
      .find((l) => l.trim() !== "" && !l.trim().startsWith(";"));
    expect(firstNonComment).toBe("G21");
  });

  it("动作行流与转译层同口径；Plan 以落笔收尾时自动补抬笔行", () => {
    const plan = new Plan([
      new PenMotion(50, 60, 0.12), // 落笔
      new XYMotion([new Block(200, 1, 0, { x: 10, y: 10 }, { x: 20, y: 10 })]),
    ]);
    const g = planToGCode(plan, { sourceFileName: null, driveParams: dp });
    expect(g).toContain("G1 X20 Y10");
    // 脚注抬笔：zPenUpMm=5 / zFeedMmMin=600（档案缺省）
    expect(g.trimEnd().endsWith("G1 Z5 F600")).toBe(true);
  });

  it("pct 空间 Plan 正确映射 Z 与笔态：落笔 G1 绘制、抬笔 G0 空程", () => {
    // PenMotion 位置为 penPct 口径（0 = 完全抬笔，100 = 完全落笔）
    const plan = new Plan([
      new PenMotion(50, 60, 0.12), // 落笔（pct 增大）
      new XYMotion([new Block(200, 1, 0, { x: 10, y: 10 }, { x: 20, y: 10 })]),
      new PenMotion(60, 50, 0.12), // 抬笔（pct 减小）
      new XYMotion([new Block(200, 1, 0, { x: 20, y: 10 }, { x: 30, y: 10 })]),
    ]);
    const g = planToGCode(plan, { sourceFileName: null, driveParams: dp });
    // 落笔(pct 60) → Z=5×0.4=2；绘制段 → G1；抬笔(pct 50) → Z=2.5；空程 → G0
    expect(g).toContain("G1 Z2 F600");
    expect(g).toContain("G1 X20 Y10");
    expect(g).toContain("G1 Z2.5 F600");
    expect(g).toContain("G0 X30 Y10");
  });
});
