import { describe, expect, it } from "vitest";
import { replan } from "../massager.js";
import { defaultPlanOptions, type Plan, PenMotion, XYMotion } from "../planning.js";
import { PaperSize } from "../paper-size.js";
import { defaultMmPerSvgUnit, mmPerSvgUnitFromSvg } from "../util.js";

/**
 * 导入时 SVG 真实尺寸检测：根元素 width 带绝对物理单位（或 px 数与
 * viewBox 不一致）时，按 width_mm ÷ viewBox 宽推算用户单位→mm 换算系数，
 * 非 96dpi 导出的文件也能在「按原尺寸/自定义缩放」模式下还原真实尺寸。
 */

function svgEl(attrs: Record<string, string>) {
  return { getAttribute: (n: string) => attrs[n] ?? null };
}

/** 累计落笔状态下的 XYMotion 距离（mm） */
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
  return totalSteps / 5; // v3 stepsPerMm
}

describe("mmPerSvgUnitFromSvg", () => {
  it("width 带绝对物理单位时按 width_mm ÷ viewBox 宽推算", () => {
    expect(mmPerSvgUnitFromSvg(svgEl({ width: "210mm", viewBox: "0 0 794 1078" }))).toBeCloseTo(210 / 794, 6);
    expect(mmPerSvgUnitFromSvg(svgEl({ width: "8.27in", viewBox: "0 0 794 1078" }))).toBeCloseTo(
      (8.27 * 25.4) / 794,
      6,
    );
    expect(mmPerSvgUnitFromSvg(svgEl({ width: "21cm", viewBox: "0 0 794 1078" }))).toBeCloseTo(210 / 794, 6);
  });

  it("px 数值与 viewBox 不一致（如 2x 导出）时按比例还原", () => {
    // 2x 导出：物理 794px@96dpi 的内容被写成 1588px
    expect(mmPerSvgUnitFromSvg(svgEl({ width: "1588px", viewBox: "0 0 794 1078" }))).toBeCloseTo(
      (2 * defaultMmPerSvgUnit * 794) / 794,
      6,
    );
  });

  it("无单位数字按 px（96dpi）处理", () => {
    expect(mmPerSvgUnitFromSvg(svgEl({ width: "794", viewBox: "0 0 794 1078" }))).toBeCloseTo(defaultMmPerSvgUnit, 6);
  });

  it("百分比 / 缺失 width 或 viewBox 时返回 undefined（回退 96dpi）", () => {
    // Affinity 默认导出 width="100%"：物理尺寸信息已丢失，无法恢复
    expect(mmPerSvgUnitFromSvg(svgEl({ width: "100%", viewBox: "0 0 794 1078" }))).toBeUndefined();
    expect(mmPerSvgUnitFromSvg(svgEl({ viewBox: "0 0 794 1078" }))).toBeUndefined();
    expect(mmPerSvgUnitFromSvg(svgEl({ width: "210mm" }))).toBeUndefined();
    expect(mmPerSvgUnitFromSvg(svgEl({}))).toBeUndefined();
  });
});

describe("replan 使用导入推算的 mmPerSvgUnit", () => {
  it("原尺寸模式下非 96dpi 文件按真实毫米落纸", () => {
    // 300dpi 风格导出：210mm 物理宽被写成 1588 个用户单位。
    // 若仍按 96dpi（defaultMmPerSvgUnit）解释，线长会错误放大为
    // 1588 × 25.4/96 ≈ 420mm；正确推算后应为 210mm。
    const lines = [
      {
        points: [
          { x: 0, y: 539 },
          { x: 1588, y: 539 },
        ],
        stroke: "black",
        groupId: "",
        fill: "none",
        fillRule: "nonzero",
        groupOrder: 0,
      },
    ];
    const plan = replan(lines, {
      ...defaultPlanOptions,
      paperSize: new PaperSize({ x: 380, y: 280 }),
      scaleMode: "actual",
      cropToMargins: false,
      rotateDrawing: 0,
      sortPaths: false,
      layerMode: "all",
      mmPerSvgUnit: 210 / 1588,
    });
    expect(penDownDistance(plan)).toBeCloseTo(210, 3);
  });
});
