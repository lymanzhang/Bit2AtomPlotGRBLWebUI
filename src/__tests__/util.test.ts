import { describe, expect, it } from "vitest";

import { PaperSize } from "../paper-size";
import { alignToMargins, cropToMargins, defaultPlacement, type Placement, scaleToPaper } from "../util";
import type { Vec2 } from "../vec";

describe("crop to margins", () => {
  const paper = new PaperSize({ x: 100, y: 100 });
  const margin = 5;

  it("has no effect on a drawing already inside the margins", () => {
    const drawing = [ [{x: 10, y: 10}, {x: 20, y: 10}] ]; // biome-ignore format: compactness
    expect(cropToMargins(drawing, paper, margin)).toEqual(drawing);
  });

  it("crops a line that extends beyond the margins", () => {
    const drawing = [ [{x: 50, y: 50}, {x: 200, y: 50}] ]; // biome-ignore format: compactness
    const cropped = [ [{x: 50, y: 50}, {x: 95, y: 50}] ]; // biome-ignore format: compactness
    expect(cropToMargins(drawing, paper, margin)).toEqual(cropped);
  });

  it("turns a line that goes beyond the margin and then returns into two lines", () => {
    const drawing = [ [{x: 50, y: 50}, {x: 200, y: 50}, {x: 50, y: 80}] ]; // biome-ignore format: compactness
    const cropped =
      // biome-ignore format: compactness
      [
        [{x: 50, y: 50}, {x: 95, y: 50}],
        [{x: 95, y: 71}, {x: 50, y: 80}],
      ];
    expect(cropToMargins(drawing, paper, margin)).toEqual(cropped);
  });

  it("excludes lines that are entirely outside the page", () => {
    const drawing = [ [{ x: 200, y: 50 }, { x: 250, y: 50 }] ]; // biome-ignore format: compactness
    const cropped: Vec2[][] = [];
    expect(cropToMargins(drawing, paper, margin)).toEqual(cropped);
  });

  it("excludes line segments that are entirely outside the page", () => {
    const drawing = [ [{x: 50, y: 50}, {x: 200, y: 50}, {x: 200, y: 80}, {x: 50, y: 80}] ]; // biome-ignore format: compactness
    const cropped = [
      [{x: 50, y: 50}, {x: 95, y: 50}],
      [{x: 95, y: 80}, {x: 50, y: 80}],
    ]; // biome-ignore format: compactness
    expect(cropToMargins(drawing, paper, margin)).toEqual(cropped);
  });

  it("permits a line along each edge of the margin", () => {
    const drawing = [
      [
        {x: margin, y: margin},
        {x: paper.size.x - margin, y: margin},
        {x: paper.size.x - margin, y: paper.size.y - margin},
        {x: margin, y: paper.size.y - margin},
        {x: margin, y: margin},
      ]
    ]; // biome-ignore format: compactness
    expect(cropToMargins(drawing, paper, margin)).toEqual(drawing);
  });
});

describe("placement (排版对齐)", () => {
  // 纸 100×100，边距 5 → 边距框 (5,5)-(95,95)，可用区域 90×90
  const paper = new PaperSize({ x: 100, y: 100 });
  const margin = 5;
  // 40×10 的图形，(10,10)-(50,20)：装入 90×90 时 scale = min(90/40, 90/10) = 2.25，
  // 缩放后尺寸 90×22.5
  const drawing = [ [{x: 10, y: 10}, {x: 50, y: 20}] ]; // biome-ignore format: compactness
  const bbox = (lists: Vec2[][]) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const pl of lists)
      for (const p of pl) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    return { minX, minY, maxX, maxY };
  };
  const place = (p: Partial<Placement>) => scaleToPaper(drawing, paper, margin, { ...defaultPlacement, ...p });

  it("defaults to centered (与历史行为一致)", () => {
    const { minX, minY, maxX, maxY } = bbox(place({}));
    expect(minX).toBeCloseTo(5);
    expect(maxX).toBeCloseTo(95);
    expect(minY).toBeCloseTo(5 + (90 - 22.5) / 2);
    expect(maxY).toBeCloseTo(5 + (90 - 22.5) / 2 + 22.5);
  });

  it("aligns left/top", () => {
    const { minX, minY } = bbox(place({ alignH: "left", alignV: "top" }));
    expect(minX).toBeCloseTo(5);
    expect(minY).toBeCloseTo(5);
  });

  it("aligns right/bottom", () => {
    const { maxX, maxY, minX, minY } = bbox(place({ alignH: "right", alignV: "bottom" }));
    expect(maxX).toBeCloseTo(95);
    expect(maxY).toBeCloseTo(95);
    expect(minX).toBeCloseTo(5);
    expect(minY).toBeCloseTo(95 - 22.5);
  });

  it("custom offsets are relative to the margin box top-left (允许超出边距)", () => {
    const { minX, minY, maxX } = bbox(place({ alignH: "custom", alignV: "custom", customXMm: 10, customYMm: 20 }));
    expect(minX).toBeCloseTo(5 + 10);
    expect(minY).toBeCloseTo(5 + 20);
    expect(maxX).toBeCloseTo(5 + 10 + 90); // 超出边距框右缘也不钳制
  });

  it("alignToMargins translates 1:1 without scaling", () => {
    const placed = alignToMargins(drawing, paper, margin, { ...defaultPlacement, alignH: "left", alignV: "top" });
    const { minX, minY, maxX, maxY } = bbox(placed);
    expect(minX).toBeCloseTo(5);
    expect(minY).toBeCloseTo(5);
    expect(maxX - minX).toBeCloseTo(40); // 尺寸不变
    expect(maxY - minY).toBeCloseTo(10);
  });
});
