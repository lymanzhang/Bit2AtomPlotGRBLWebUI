import type { Path } from "flatten-svg";
import { describe, expect, it } from "vitest";
import { replan } from "../massager.js";
import { defaultPlanOptions, type Plan, PlanOptions, XYMotion } from "../planning.js";
import { PaperSize } from "../paper-size.js";
import type { Vec2 } from "../vec.js";

/**
 * 回归验证：笔起始/停泊点（penHome）跟随「机器原点位置」。
 *
 * penHome 为机器坐标口径（相对机器原点角、向纸面内递增，(0,0) = 原点角
 * 本身）。replan 负责把它换算为屏幕空间坐标：预览中起点圈落在原点角，
 * 执行层 applyMachineFrame 又把它映射回机器 (penHome) —— 默认 (0,0) 时
 * $H 归位后笔已在起点处，不再出现斜穿纸面的长程空程（历史行为：起点
 * 恒为屏幕左上角，原点在左下时首条空程从纸面对角线斜穿）。
 */

function asPath(stroke: string, points: Vec2[]): Path {
  return { points, stroke, groupId: "", fill: "none", fillRule: "nonzero", groupOrder: 0 };
}

const OPTS: PlanOptions = {
  ...defaultPlanOptions,
  paperSize: new PaperSize({ x: 100, y: 80 }),
  marginMm: 20,
  sortPaths: false,
};

/** Plan 的首条 XYMotion 起点（= penHome 屏幕坐标）与末条 XYMotion 终点 */
function firstStartLastEnd(p: Plan): [Vec2, Vec2] {
  const first = p.motions.find((m) => m instanceof XYMotion) as XYMotion;
  const last = p.motions.filter((m) => m instanceof XYMotion).at(-1) as XYMotion;
  return [first.p1, last.p2];
}

describe("penHome 跟随机器原点角", () => {
  it("默认 (0,0)：起点 = 机器原点角（屏幕空间），四个原点角各自成立", () => {
    const lines = [asPath("red", [{ x: 10, y: 10 }, { x: 20, y: 10 }])];
    const cases: [string, Vec2][] = [
      ["top-left", { x: 0, y: 0 }],
      ["bottom-left", { x: 0, y: 80 }],
      ["top-right", { x: 100, y: 0 }],
      ["bottom-right", { x: 100, y: 80 }],
    ];
    for (const [corner, expected] of cases) {
      const plan = replan(lines, {
        ...OPTS,
        driveParams: { ...OPTS.driveParams, originCorner: corner as never },
      });
      const [start, end] = firstStartLastEnd(plan);
      expect(start.x, `${corner} 起点 x`).toBeCloseTo(expected.x, 6);
      expect(start.y, `${corner} 起点 y`).toBeCloseTo(expected.y, 6);
      // 绘制结束后笔应回到同一停泊点
      expect(end.x, `${corner} 终点 x`).toBeCloseTo(expected.x, 6);
      expect(end.y, `${corner} 终点 y`).toBeCloseTo(expected.y, 6);
    }
  });

  it("自定义 penHome 相对原点角向纸面内度量（bottom-left: y 从底边起算）", () => {
    const lines = [asPath("red", [{ x: 10, y: 10 }, { x: 20, y: 10 }])];
    const plan = replan(lines, {
      ...OPTS,
      penHome: { x: 5, y: 7 },
      driveParams: { ...OPTS.driveParams, originCorner: "bottom-left" },
    });
    const [start] = firstStartLastEnd(plan);
    // 原点在左下：x 向右不变，y 自底边向上度量 → 屏幕 y = H - 7
    expect(start.x).toBeCloseTo(5, 6);
    expect(start.y).toBeCloseTo(80 - 7, 6);
  });
});
