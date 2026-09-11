import type { PaperSize } from "./paper-size.js";
import { type Vec2, vadd, vlen2, vmul, vsub } from "./vec.js";

// CSS, and thus SVG, defines 1px = 1/96th of 1in
// https://www.w3.org/TR/css-values-4/#absolute-lengths
const svgUnitsPerInch = 96;
const mmPerInch = 25.4;
/** 默认的「每个 SVG 用户单位对应多少毫米」（96dpi 基准） */
export const defaultMmPerSvgUnit = mmPerInch / svgUnitsPerInch;

/** CSS 绝对长度单位 → mm 换算表（px 按 96dpi 基准；无单位数字按 px 处理） */
const svgUnitToMm: Record<string, number> = {
  "": mmPerInch / svgUnitsPerInch,
  px: mmPerInch / svgUnitsPerInch,
  pt: mmPerInch / 72,
  pc: mmPerInch / 6,
  mm: 1,
  cm: 10,
  in: mmPerInch,
  q: mmPerInch / 40,
};

/**
 * 从 SVG 根元素的 width 属性推断「每个用户单位对应多少毫米」。
 *
 * 背景：SVG/CSS 规定用户单位（px）固定为 1/96 英寸，与导出 DPI 无关。
 * Affinity 等软件按「导出 DPI」把物理尺寸折算成 px 数值写入 width 与
 * viewBox，只有 96dpi 导出时 1 单位才恰好对应 1/96in；非 96dpi 导出的
 * 同一物理尺寸会被写成更多/更少的单位。但当 width 带绝对物理单位
 * （如 width="210mm"），或 px 数值与 viewBox 不一致（如 2x 导出
 * width="1588px" + viewBox 宽 794）时，可按
 * mmPerUnit = width_mm ÷ viewBox宽度 推断出真实尺度，供「按原尺寸 /
 * 自定义缩放」模式正确还原物理尺寸。
 *
 * width 缺失、为百分比（如 "100%"，物理尺寸信息已丢失）或数值非法时
 * 返回 undefined，调用方应回退到 96dpi 缺省值（defaultMmPerSvgUnit）。
 *
 * 调用链：ui.tsx readSvg()（文件导入/剪贴板粘贴）与 cli.ts plot 子命令
 * 在导入时调用一次 → 结果经 PlanOptions.mmPerSvgUnit 传入规划 worker →
 * massager.replan 以 `mmPerSvgUnit ?? defaultMmPerSvgUnit` 取用（缩放、
 * 旋转中心换算）。 massager.ts 内不再重复解析 SVG，保证 UI 与 CLI 口径
 * 一致。
 */
export function mmPerSvgUnitFromSvg(svg: { getAttribute(name: string): string | null }): number | undefined {
  const width = (svg.getAttribute("width") ?? "").trim();
  const viewBox = svg.getAttribute("viewBox") ?? "";
  // viewBox 格式为 "minX minY width height"（正常 4 个分量）；宽度取第 3 个
  const vb = viewBox.split(/[\s,]+/).filter(Boolean).map(Number);
  const vbW = vb.length === 4 ? vb[2] : vb[0];
  const m = /^(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*(px|pt|pc|mm|cm|in|q)?$/i.exec(width);
  if (!m || !(vbW > 0)) {
    return undefined;
  }
  const factor = svgUnitToMm[(m[2] ?? "").toLowerCase()];
  if (factor == null) {
    return undefined;
  }
  const mmPerUnit = (Number(m[1]) * factor) / vbW;
  return mmPerUnit > 0 ? mmPerUnit : undefined;
}

/** Format a smallish duration in 2h30m15s form */
export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 60 / 60);
  const mins = Math.floor((seconds - hours * 60 * 60) / 60);
  const secs = Math.floor(seconds - hours * 60 * 60 - mins * 60);
  const parts = [
    [hours, "h"],
    [mins, "m"],
    [secs, "s"],
  ];
  return parts
    .slice(parts.findIndex((x) => x[0] !== 0))
    .map(([v, u]) => `${v}${u}`)
    .join("");
}

/** Return the top-left and bottom-right corners of the bounding box containing all points in pointLists */
function extent(pointLists: Vec2[][]): [Vec2, Vec2] {
  let maxX = -Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  let minY = Infinity;
  for (const pl of pointLists) {
    for (const p of pl) {
      if (p.x > maxX) { maxX = p.x; }
      if (p.y > maxY) { maxY = p.y; }
      if (p.x < minX) { minX = p.x; }
      if (p.y < minY) { minY = p.y; }
    } // biome-ignore format: compactness
  }
  return [{ x: minX, y: minY }, { x: maxX, y: maxY }]; // biome-ignore format: compactness
}

/**
 * Drawing placement within the margin box. `custom*` offsets are relative to
 * the margin box top-left corner, in mm.
 */
export interface Placement {
  alignH: "left" | "center" | "right" | "custom";
  alignV: "top" | "middle" | "bottom" | "custom";
  customXMm: number;
  customYMm: number;
}

export const defaultPlacement: Placement = {
  alignH: "center",
  alignV: "middle",
  customXMm: 0,
  customYMm: 0,
};

/**
 * Top-left position (in target coordinates) of a bbox of size (scaledW, scaledH)
 * placed inside the target box according to the placement anchors.
 */
function anchorOffset(scaledW: number, scaledH: number, targetMin: Vec2, targetMax: Vec2, placement: Placement): Vec2 {
  let x: number;
  switch (placement.alignH) {
    case "left":
      x = targetMin.x;
      break;
    case "right":
      x = targetMax.x - scaledW;
      break;
    case "custom":
      x = targetMin.x + placement.customXMm;
      break;
    default:
      x = targetMin.x + (targetMax.x - targetMin.x - scaledW) / 2;
  }
  let y: number;
  switch (placement.alignV) {
    case "top":
      y = targetMin.y;
      break;
    case "bottom":
      y = targetMax.y - scaledH;
      break;
    case "custom":
      y = targetMin.y + placement.customYMm;
      break;
    default:
      y = targetMin.y + (targetMax.y - targetMin.y - scaledH) / 2;
  }
  return { x, y };
}

/**
 * Scale pointLists to fit within the bounding box specified by (targetMin, targetMax).
 *
 * Preserves aspect ratio, scaling as little as possible to completely fit within the box.
 *
 * The drawing is positioned inside the box according to the placement anchors
 * (default: centered both ways).
 */
function scaleToFit(pointLists: Vec2[][], targetMin: Vec2, targetMax: Vec2, placement: Placement): Vec2[][] {
  const [min, max] = extent(pointLists);
  const availWidthMm = targetMax.x - targetMin.x;
  const availHeightMm = targetMax.y - targetMin.y;
  const scaleFitX = availWidthMm / (max.x - min.x);
  const scaleFitY = availHeightMm / (max.y - min.y);
  const scale = Math.min(scaleFitX, scaleFitY);
  const anchor = anchorOffset((max.x - min.x) * scale, (max.y - min.y) * scale, targetMin, targetMax, placement);
  const offset = vadd(anchor, vmul(min, -scale));
  return pointLists.map((pl) => pl.map((p) => vadd(vmul(p, scale), offset)));
}

/** Scale a drawing to fill a piece of paper, with the given size and margins. */
export function scaleToPaper(
  pointLists: Vec2[][],
  paperSize: PaperSize,
  marginMm: number,
  placement: Placement = defaultPlacement,
): Vec2[][] {
  return scaleToFit(
    pointLists,
    { x: marginMm, y: marginMm },
    vsub(paperSize.size, { x: marginMm, y: marginMm }),
    placement,
  );
}

/**
 * Translate pointLists (1:1, no scaling) so that the drawing's bounding box is
 * positioned inside the margin box according to the placement anchors.
 */
export function alignToMargins(
  pointLists: Vec2[][],
  paperSize: PaperSize,
  marginMm: number,
  placement: Placement = defaultPlacement,
): Vec2[][] {
  const [min, max] = extent(pointLists);
  const anchor = anchorOffset(
    max.x - min.x,
    max.y - min.y,
    { x: marginMm, y: marginMm },
    vsub(paperSize.size, { x: marginMm, y: marginMm }),
    placement,
  );
  const offset = vsub(anchor, min);
  return pointLists.map((pl) => pl.map((p) => vadd(p, offset)));
}

/**
 * Liang-Barsky algorithm for computing segment-AABB intersection.
 * https://gist.github.com/ChickenProp/3194723
 */
function liangBarsky(aabb: [Vec2, Vec2], seg: [Vec2, Vec2]): Vec2 | null {
  const [lower, upper] = aabb;
  const [a, b] = seg;
  const delta = vsub(b, a);
  const p = [-delta.x, delta.x, -delta.y, delta.y];
  const q = [a.x - lower.x, upper.x - a.x, a.y - lower.y, upper.y - a.y];
  let u1 = -Infinity;
  let u2 = Infinity;

  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0 && u1 < t) u1 = t;
      else if (p[i] > 0 && u2 > t) u2 = t;
    }
  }

  if (u1 > u2 || u1 > 1 || u1 < 0) return null;

  return vadd(a, vmul(delta, u1));
}

/**
 * Returns true if aabb contains point (edge-inclusive).
 */
function contains(aabb: [Vec2, Vec2], point: Vec2): boolean {
  const [lower, upper] = aabb;
  return point.x >= lower.x && point.x <= upper.x && point.y >= lower.y && point.y <= upper.y;
}

/**
 * Returns a segment that is the subset of seg which is completely contained
 * within aabb, or null if seg is outside aabb.
 */
function truncate(aabb: [Vec2, Vec2], seg: [Vec2, Vec2]): [Vec2, Vec2] | null {
  const [a, b] = seg;

  const start = contains(aabb, a) ? a : liangBarsky(aabb, seg);
  if (start === null) return null;

  const end = contains(aabb, b) ? b : liangBarsky(aabb, [b, a]);
  if (end === null) return null;

  return [start, end];
}

/**
 * Given a polyline, returns a list of polylines that form a subset of the
 * input polyline that is completely within aabb.
 *
 * 裁剪语义（重要）：这是**逐线段**裁剪，不是按路径整体取舍——
 * - 框内的节点与线段**全部保留**，仅在折线穿越边框处求交拆分；
 * - 一条输入折线可能被拆分成 **0 条、1 条或多条**输出碎片（穿过边框
 *   进出一次就多一条），因此「输出碎片下标」与「输入路径下标」不再
 *   一一对应；
 * - 拆分处会插入边框上的交点作为碎片端点，保证落笔路径精确止于边距框。
 *
 * ⚠️ 调用方契约：碎片必须继承其来源路径的元数据（stroke/fill/图层归属
 * 等）。massager.ts 通过随路径携带的 origIndices 原始索引满足此契约；
 * 历史上曾按碎片新下标直接回查原始路径数组，导致单路径文件（一个超长
 * <path>）拆分数百碎片后下标越界崩溃、多路径文件错用他路径图层归属
 * 整批误删。回归测试：__tests__/crop-layer-filter.test.ts。
 */
function cropLineToAabb(pointList: Vec2[], aabb: [Vec2, Vec2]): Vec2[][] {
  const truncatedPointLists: Vec2[][] = [];
  let currentPointList: Vec2[] | null = null;
  for (let i = 1; i < pointList.length; i++) {
    const [a, b] = [pointList[i - 1], pointList[i]];
    const truncated = truncate(aabb, [a, b]);
    if (truncated) {
      if (!currentPointList) {
        currentPointList = [truncated[0]];
        truncatedPointLists.push(currentPointList);
      }
      currentPointList.push(truncated[1]);
      if (truncated[1] !== b) {
        // the end was truncated, record the end point and end the line
        currentPointList = null;
      }
    } else {
      // the segment was entirely outside the aabb, end the line if there was one.
      currentPointList = null;
    }
  }
  return truncatedPointLists;
}

/**
 * Crops a drawing so it is kept entirely within the given margin.
 *
 * 仅在 scaleMode !== "fit"（原尺寸/自定义缩放）路径下由 massager 调用：
 * fit 模式下图形必然落在边距框内，无需裁剪。输出碎片数量可能多于输入
 * 路径数（见 cropLineToAabb 说明——一条折线穿越边框几次就拆成几段），
 * 调用方必须同步维护「碎片 → 原始路径」的索引映射，供后续图层过滤与
 * 隐藏线去除按原始路径取 stroke/fill 归属。
 */
export function cropToMargins(pointLists: Vec2[][], paperSize: PaperSize, marginMm: number): Vec2[][] {
  const pageAabb: [Vec2, Vec2] = [{ x: 0, y: 0 }, paperSize.size];
  const margin = { x: marginMm, y: marginMm };
  const insetAabb: [Vec2, Vec2] = [vadd(pageAabb[0], margin), vsub(pageAabb[1], margin)];
  const truncatedPointLists: Vec2[][] = [];
  for (const pointList of pointLists) {
    for (const croppedLine of cropLineToAabb(pointList, insetAabb)) {
      truncatedPointLists.push(croppedLine);
    }
  }
  return truncatedPointLists;
}

export function dedupPoints(points: Vec2[], epsilon: number): Vec2[] {
  if (epsilon === 0) {
    return points;
  }
  const dedupedPoints = [points[0]];
  const epsilon2 = epsilon * epsilon;
  for (const p of points.slice(1)) {
    if (vlen2(vsub(p, dedupedPoints[dedupedPoints.length - 1])) > epsilon2) {
      dedupedPoints.push(p);
    }
  }
  return dedupedPoints;
}
