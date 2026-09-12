import { describe, expect, it } from "vitest";
import { planToSvg } from "../export-svg.js";
import { Block, PenMotion, Plan, XYMotion } from "../planning.js";
import { PaperSize } from "../paper-size.js";
import type { Vec2 } from "../vec.js";

const p = (x: number, y: number): Vec2 => ({ x, y });

/**
 * 回归验证：planToSvg 笔态判断（pct 口径）。
 *
 * 历史 bug：笔态判断沿用舵机空间时代的 finalPos < initialPos（值小 = 落笔），
 * 而 Plan 笔位已统一为 pct 口径（0 = 完全抬笔，100 = 完全落笔），方向恰好
 * 相反——导出的 SVG 全是空程跳线（每条仅 2-3 个点、1-6mm 短碎片），真正的
 * 绘制路径被整批丢弃。回归样例：testOutputs/cloud_H_800_1200-export.svg。
 */
describe("planToSvg 笔态判断（pct 口径）", () => {
  // 落笔绘制段：pct 30（抬）→ 90（落）→ 画线 → pct 90 → 30（抬）
  function planWithStrokes(): Plan {
    const travel1 = new XYMotion([new Block(0, 0.1, 0, p(0, 0), p(10, 10))]);
    const drop = new PenMotion(30, 90, 0.1);
    const draw1 = new XYMotion([new Block(0, 0.1, 0, p(10, 10), p(50, 10))]);
    const draw2 = new XYMotion([
      new Block(0, 0.05, 0, p(50, 10), p(50, 50)),
      new Block(0, 0.05, 0, p(50, 50), p(10, 50)),
    ]);
    const lift = new PenMotion(90, 30, 0.1);
    const travel2 = new XYMotion([new Block(0, 0.1, 0, p(10, 50), p(60, 60))]);
    const drop2 = new PenMotion(30, 90, 0.1);
    const draw3 = new XYMotion([new Block(0, 0.1, 0, p(60, 60), p(90, 60))]);
    return new Plan([travel1, drop, draw1, draw2, lift, travel2, drop2, draw3]);
  }

  it("只导出落笔段，空程跳线不出现", () => {
    const svg = planToSvg(planWithStrokes(), new PaperSize({ x: 100, y: 100 }));
    // 绘制段：3 条折线（draw1、draw2 两块合一条、draw3）
    const paths = [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
    expect(paths.length).toBe(3);
    // draw1 起点 (10,10)；空程 (0,0)→(10,10) 与 (10,50)→(60,60) 均不出现
    expect(paths[0]).toContain("M10.0000 10.0000");
    expect(paths.some((d) => d.includes("M0.0000 0.0000"))).toBe(false);
    expect(paths.some((d) => d.includes("M10.0000 50.0000"))).toBe(false);
    expect(paths[2]).toContain("M60.0000 60.0000");
  });

  it("抬笔方向的运动（pct 降）不置笔态", () => {
    // 只有空程 + 落笔方向颠倒的异常序列：不应导出任何路径
    const travel = new XYMotion([new Block(0, 0.1, 0, p(0, 0), p(5, 5))]);
    const wrongDrop = new PenMotion(90, 30, 0.1); // pct 降 = 抬笔
    const svg = planToSvg(new Plan([travel, wrongDrop, travel]), new PaperSize({ x: 100, y: 100 }));
    expect(svg).not.toMatch(/<path d=/);
  });
});
