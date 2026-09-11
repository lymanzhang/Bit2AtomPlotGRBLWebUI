import { readFileSync } from "node:fs";
import { flattenSVG } from "flatten-svg";
import { createSVGDocument, HTMLParser } from "svgdom";
import { describe, expect, it } from "vitest";

/**
 * 回归验证：ui.tsx readSvg() 的复合路径矩阵映射。
 *
 * cloud04_simplified_t0.1.svg（Affinity 导出）是单个 <path> 内含 846 个 M
 * 子路径 + 外层 <g transform="matrix(...)">。历史 bug：readSvg() 依赖非标准的
 * shape.getPathData() 统计子路径数（浏览器中恒为 undefined），子路径数退化
 * 为 1，导致除第一个子路径外的全部路径未应用 group 矩阵，预览/绘制结果被
 * 拆成两块。
 */
const SVG_PATH = new URL("./fixtures/cloud04_simplified_t0.1.svg", import.meta.url);

// 文件中的 group 变换矩阵（matrix(7.701218,0,0,7.701218,-1982.108693,481.683961)）
const M = { a: 7.701218, b: 0, c: 0, d: 7.701218, e: -1982.108693, f: 481.683961 };

describe("readSvg 复合路径矩阵映射（cloud04 回归）", () => {
  it("单个 <path> 的所有 M 子路径都应用 group 变换", () => {
    const svgText = readFileSync(SVG_PATH, "utf8");
    const noDecl = svgText.replace(/<\?xml[^?]*\?>\s*/, "");
    const doc = createSVGDocument();
    HTMLParser(noDecl, doc);
    const svg = doc.documentElement;
    // DOMParser 解析的未挂载 SVG 中 getCTM() 恒为 null/identity（与浏览器一致）
    for (const el of svg.querySelectorAll("*")) (el as any).getCTM = () => null;

    const shapes = [...svg.querySelectorAll("path")];
    const paths = flattenSVG(svg as any, {});

    // —— 与 ui.tsx readSvg() 修复后的映射逻辑保持一致 ——
    let pathIdx = 0;
    for (const shape of shapes) {
      if (pathIdx >= paths.length) break;
      const d = shape.getAttribute("d") ?? "";
      const subpaths = (d.match(/[mM]/g) ?? []).length;
      if (subpaths === 0) continue;
      for (let s = 0; s < subpaths && pathIdx < paths.length; s++) {
        for (const pt of paths[pathIdx].points as any) {
          const x = pt[0];
          const y = pt[1];
          pt[0] = pt.x = M.a * x + M.c * y + M.e;
          pt[1] = pt.y = M.b * x + M.d * y + M.f;
        }
        pathIdx++;
      }
    }

    // 本文件：1 个 <path>，846 个 M 子路径
    expect(shapes.length).toBe(1);
    const d = shapes[0].getAttribute("d") ?? "";
    const mCount = (d.match(/[mM]/g) ?? []).length;
    expect(mCount).toBeGreaterThan(100);
    // flatten-svg 按每个 M 拆分 → Path 数 = M 命令数
    expect(paths.length).toBe(mCount);
    // 关键断言：全部子路径都完成映射（bug 场景下 pathIdx 只会走到 1）
    expect(pathIdx).toBe(paths.length);

    // 全部点必须落在变换后的包围盒内。
    // bug 场景下绝大多数点停留在原始坐标 x∈[358,806]，minX ≈ 358。
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of paths) {
      for (const pt of p.points as any) {
        minX = Math.min(minX, pt[0]);
        maxX = Math.max(maxX, pt[0]);
        minY = Math.min(minY, pt[1]);
        maxY = Math.max(maxY, pt[1]);
      }
    }
    expect(minX).toBeGreaterThan(770);
    expect(minY).toBeGreaterThan(480);
    expect(maxX).toBeLessThan(4230);
    expect(maxY).toBeLessThan(6600);
  });
});
