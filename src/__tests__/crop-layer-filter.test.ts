import type { Path } from "flatten-svg";
import { describe, expect, it } from "vitest";
import { replan } from "../massager.js";
import { defaultPlanOptions, type Plan, PlanOptions, PenMotion, XYMotion } from "../planning.js";
import { PaperSize } from "../paper-size.js";
import type { Vec2 } from "../vec.js";

/**
 * 回归验证：cropToMargins 把路径就地拆分成碎片后，图层过滤必须按
 * 「碎片继承的原路径索引」而非数组下标回查 inPaths。
 *
 * 历史 bug：过滤用 `inPaths[i].stroke`（i 为裁剪后碎片数组下标）。单路径
 * 文件（如 Affinity 导出的单个超长 <path>）被裁剪拆成数百条碎片后下标越界
 * 直接抛 TypeError（worker 崩溃）；多路径文件则索引错位，按别的路径的颜色
 * 判定选中与否，大量碎片被误删（表现为裁剪后只剩极少数路径）。
 */

function asPath(stroke: string, points: Vec2[]): Path {
  return { points, stroke, groupId: "", fill: "none", fillRule: "nonzero", groupOrder: 0 };
}

// 非 fit 模式下 replan 把输入坐标按 SVG px（96dpi）换算成 mm，测试数据用 mm 表达
const px = (mm: number) => (mm * 96) / 25.4;

const V3_STEPS_PER_MM = 5;

const CROPPING_OPTS: PlanOptions = {
  ...defaultPlanOptions,
  paperSize: new PaperSize({ x: 100, y: 100 }),
  marginMm: 10,
  scaleMode: "actual",
  cropToMargins: true,
  rotateDrawing: 0,
  sortPaths: false,
  layerMode: "stroke",
};

/** 累计落笔状态下的 XYMotion 距离（不含抬笔空程），单位 mm */
function penDownDistance(plan: Plan): number {
  let totalSteps = 0;
  let penDown = false;
  for (const m of plan.motions) {
    if (m instanceof PenMotion) {
      penDown = m.finalPos < m.initialPos;
    } else if (m instanceof XYMotion && penDown) {
      for (const b of m.blocks) totalSteps += b.distance;
    }
  }
  // 坐标处于全步进空间，换算回 mm
  return totalSteps / V3_STEPS_PER_MM;
}

describe("裁剪拆分后的图层过滤（原索引回查）", () => {
  it("单条路径被裁剪拆分后，stroke 过滤不崩溃且不误删", () => {
    // 水平长线横穿 100×100 纸面（边距 10），对齐居中后 x ∈ [-25, 125]，
    // 裁剪应保留 x ∈ [10, 90] 的 80mm 段。历史 bug 下 stroke 模式直接抛
    // TypeError（碎片下标越界 inPaths）。
    const lines = [asPath("red", [{ x: 0, y: px(50) }, { x: px(150), y: px(50) }])];
    const plan = replan(lines, {
      ...CROPPING_OPTS,
      selectedStrokeLayers: new Set(["red"]),
    });
    expect(penDownDistance(plan)).toBeCloseTo(80, 3);
  });

  it("多条路径裁剪后碎片仍按原路径的 stroke 过滤", () => {
    // blue 在前且完全落在边距框内但未被选中；red 在后被裁剪且被选中。
    // 历史 bug 按碎片数组下标回查会张冠李戴：误留 blue、删掉 red。
    const lines = [
      asPath("blue", [{ x: px(30), y: px(30) }, { x: px(60), y: px(30) }]),
      asPath("red", [{ x: 0, y: px(50) }, { x: px(150), y: px(50) }]),
    ];
    const plan = replan(lines, {
      ...CROPPING_OPTS,
      selectedStrokeLayers: new Set(["red"]),
    });
    // 只保留 red 在边距框内的 80mm 段，blue 的 30mm 应被过滤
    expect(penDownDistance(plan)).toBeCloseTo(80, 3);
  });
});
