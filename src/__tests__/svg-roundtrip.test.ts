import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flattenSVG, type Path } from "flatten-svg";
import * as svgdomNs from "svgdom";
import { planToSvg } from "../export-svg.js";
import { replan } from "../massager.js";
import { PaperSize } from "../paper-size.js";
import { defaultPlanOptions, type Plan, PenMotion, XYMotion } from "../planning.js";

const { createSVGWindow } = svgdomNs as unknown as { createSVGWindow: () => any };

/**
 * 回归验证：导出 SVG → 重新导入 往返一致性。
 *
 * 两个历史问题（用户实测：导出 SVG 再导入后图形顺时针旋转 90° 且明显变小）：
 * 1. 导出文件曾包含白色背景 <rect>，导入时被当成一条整页大的笔画路径
 *    （出现 "none" 图层），并把 fit 缩放的包围盒撑到整页，图形被缩小一圈；
 * 2. 「旋转绘制」是规划期变换：导出文件坐标已含该旋转，重新导入时再按
 *    当前旋转选项应用一次，旋转被叠加（每圈多转 90°），且旋转后的页面
 *    矩形超出纸面导致 fit 进一步缩小。
 *
 * 修复：导出去掉背景 rect，并在根节点 data-b2a-rotate-deg 记录已烘焙的
 * 旋转角；导入读入 bakedRotationDeg，replan 以 rotateDrawing - bakedRotation
 * 为有效旋转，往返不再叠加。
 */

function parseSvg(svg: string) {
  const window = createSVGWindow();
  const root = window.document.documentElement;
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  root.innerHTML = inner;
  return root;
}

function penDownPolylines(plan: Plan): { x: number; y: number }[][] {
  const out: { x: number; y: number }[][] = [];
  let penDown = false;
  for (const m of plan.motions) {
    if (m instanceof PenMotion) {
      penDown = m.finalPos > m.initialPos;
    } else if (m instanceof XYMotion && penDown) {
      const pts = m.blocks.map((b) => b.p1).concat([m.p2]);
      if (pts.length >= 2) out.push(pts);
    }
  }
  return out;
}

function fingerprint(polys: { x: number; y: number }[][]) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let len = 0
  for (const pl of polys)
    for (let i = 0; i < pl.length; i++) {
      const p = pl[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
      if (i > 0) len += Math.hypot(p.x - pl[i - 1].x, p.y - pl[i - 1].y);
    }
  return { count: polys.length, minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY, len };
}

const paper = new PaperSize({ x: 380, y: 280 });
const baseOpts = {
  ...defaultPlanOptions,
  paperSize: paper,
  scaleMode: "fit" as const,
  sortPaths: false,
  layerMode: "all" as const,
  cropToMargins: false,
};

describe("planToSvg 导出内容", () => {
  it("不再包含白色背景 rect（避免 none 图层与 fit 包围盒被撑大）", () => {
    const plan = replan(
      [
        {
          points: [
            { x: 0, y: 0 },
            { x: 100, y: 100 },
          ],
          stroke: "black",
          groupId: "",
          fill: null,
          fillRule: "nonzero",
          groupOrder: 0,
        },
      ],
      baseOpts,
    );
    const svg = planToSvg(plan, paper);
    expect(svg).not.toMatch(/<rect/);
  });

  it("根节点记录已烘焙旋转角 data-b2a-rotate-deg", () => {
    const plan = replan(
      [
        {
          points: [
            { x: 0, y: 0 },
            { x: 100, y: 100 },
          ],
          stroke: "black",
          groupId: "",
          fill: null,
          fillRule: "nonzero",
          groupOrder: 0,
        },
      ],
      baseOpts,
    );
    expect(planToSvg(plan, paper, 90)).toMatch(/data-b2a-rotate-deg="90"/);
    expect(planToSvg(plan, paper, 0)).toMatch(/data-b2a-rotate-deg="0"/);
  });
});

describe("导出→重新导入 往返一致性（旋转 90° 场景）", () => {
  it("rotateDrawing=90 时往返几何不旋转、不缩小", () => {
    const paths1 = flattenSVG(parseSvg(readFileSync("testFiles/test7.svg", "utf8")), {}) as Path[];
    // 原始导入：用户设置旋转 90°（顺时针）
    const plan1 = replan(paths1, { ...baseOpts, rotateDrawing: 90 });
    const fp1 = fingerprint(penDownPolylines(plan1));

    // 导出：坐标已含 90° 旋转，根节点记录标记
    const svgStr = planToSvg(plan1, paper, 90);

    // 重新导入：文件带标记（bakedRotationDeg=90）→ 不再施加任何旋转，
    // 所见即所得（无论当前 rotateDrawing 是多少）
    const paths2 = flattenSVG(parseSvg(svgStr), {}) as Path[];
    const plan2 = replan(paths2, { ...baseOpts, rotateDrawing: 90, bakedRotationDeg: 90 });
    const fp2 = fingerprint(penDownPolylines(plan2));

    // 几何指纹应与原图一致（导入侧按速度曲线细分块，点数会变多，
    // 但笔画数/包围盒/总长不变；fit 不再有背景 rect 撑大包围盒）
    expect(fp2.count).toBe(fp1.count);
    expect(fp2.len / fp1.len).toBeCloseTo(1, 2);
    expect(fp2.w / fp1.w).toBeCloseTo(1, 2);
    expect(fp2.h / fp1.h).toBeCloseTo(1, 2);
    expect(fp2.minX).toBeCloseTo(fp1.minX, 0);
    expect(fp2.minY).toBeCloseTo(fp1.minY, 0);
  });

  it("带标记文件忽略当前旋转设置（rotateDrawing=0 也所见即所得）", () => {
    const paths1 = flattenSVG(parseSvg(readFileSync("testFiles/test7.svg", "utf8")), {}) as Path[];
    const plan1 = replan(paths1, { ...baseOpts, rotateDrawing: 90 });
    const svgStr = planToSvg(plan1, paper, 90);
    const paths2 = flattenSVG(parseSvg(svgStr), {}) as Path[];
    const plan2 = replan(paths2, { ...baseOpts, rotateDrawing: 0, bakedRotationDeg: 90 });
    const fp1 = fingerprint(penDownPolylines(plan1));
    const fp2 = fingerprint(penDownPolylines(plan2));
    expect(fp2.len / fp1.len).toBeCloseTo(1, 2);
    expect(fp2.w / fp1.w).toBeCloseTo(1, 2);
    expect(fp2.h / fp1.h).toBeCloseTo(1, 2);
  });

  it("导出/导入多轮循环几何稳定（不随圈数叠加旋转）", () => {
    const paths1 = flattenSVG(parseSvg(readFileSync("testFiles/test7.svg", "utf8")), {}) as Path[];
    const plan1 = replan(paths1, { ...baseOpts, rotateDrawing: 90 });
    const fp1 = fingerprint(penDownPolylines(plan1));

    let svgStr = planToSvg(plan1, paper, 90);
    const fps = [fp1];
    for (let cycle = 0; cycle < 3; cycle++) {
      const paths = flattenSVG(parseSvg(svgStr), {}) as Path[];
      // 每轮导入时用户旋转设置保持 90、文件带标记 → 有效旋转 0
      const plan = replan(paths, { ...baseOpts, rotateDrawing: 90, bakedRotationDeg: 90 });
      const fp = fingerprint(penDownPolylines(plan));
      fps.push(fp);
      svgStr = planToSvg(plan, paper, 90);
    }
    for (const fp of fps.slice(1)) {
      expect(fp.count).toBe(fp1.count);
      expect(fp.len / fp1.len).toBeCloseTo(1, 2);
      expect(fp.w / fp1.w).toBeCloseTo(1, 2);
      expect(fp.h / fp1.h).toBeCloseTo(1, 2);
    }
  });

  it("不带标记的外部 SVG 行为不变（bakedRotationDeg 缺省 undefined）", () => {
    const paths = flattenSVG(parseSvg(readFileSync("testFiles/test7.svg", "utf8")), {}) as Path[];
    const a = replan(paths, { ...baseOpts, rotateDrawing: 90 });
    const b = replan(paths, { ...baseOpts, rotateDrawing: 90, bakedRotationDeg: undefined });
    const fa = fingerprint(penDownPolylines(a));
    const fb = fingerprint(penDownPolylines(b));
    expect(fb.len).toBeCloseTo(fa.len, 4);
    expect(fb.w).toBeCloseTo(fa.w, 4);
    expect(fb.h).toBeCloseTo(fa.h, 4);
  });
});
