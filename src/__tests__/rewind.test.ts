import { describe, expect, test } from "vitest";
import { AxidrawFast, pathGroupStarts, plan, rewindTravelMotion, snapToGroupStart, XYMotion } from "../planning";

const PATHS = [
  [{x: 0, y: 0}, {x: 100, y: 0}],
  [{x: 0, y: 50}, {x: 100, y: 50}],
  [{x: 0, y: 100}, {x: 100, y: 100}],
  [{x: 0, y: 150}, {x: 100, y: 150}],
]; // biome-ignore format: compactness

describe("pathGroupStarts", () => {
  test("每条路径的组起点间隔为 4（travel, pen down, draw, pen up）", () => {
    const p = plan(PATHS, AxidrawFast);
    const starts = pathGroupStarts(p);
    expect(starts).toEqual([0, 4, 8, 12]);
  });

  test("单条路径的组起点为 [0]", () => {
    const p = plan([PATHS[0]], AxidrawFast);
    expect(pathGroupStarts(p)).toEqual([0]);
  });
});

describe("snapToGroupStart", () => {
  test("snap 到 <= motionIdx 的最近路径组起点", () => {
    const p = plan(PATHS, AxidrawFast);
    expect(snapToGroupStart(p, 0)).toBe(0);
    expect(snapToGroupStart(p, 3)).toBe(0);
    expect(snapToGroupStart(p, 4)).toBe(4);
    expect(snapToGroupStart(p, 9)).toBe(8);
    expect(snapToGroupStart(p, 100)).toBe(12);
  });
});

describe("rewindTravelMotion", () => {
  test("生成从当前位置到目标组起点的移动", () => {
    const p = plan(PATHS, AxidrawFast);
    const m = rewindTravelMotion(p, { x: 100, y: 100 }, { x: 0, y: 0 });
    expect(m).toBeInstanceOf(XYMotion);
    expect(m.p1).toEqual({ x: 100, y: 100 });
    expect(m.p2).toEqual({ x: 0, y: 0 });
  });

  test("速度参数取自 plan 自身的移动段", () => {
    const p = plan(PATHS, AxidrawFast);
    const m = rewindTravelMotion(p, { x: 50, y: 50 }, { x: 0, y: 0 });
    // duration > 0 且有限（profile 有效）
    expect(m.duration()).toBeGreaterThan(0);
    expect(Number.isFinite(m.duration())).toBe(true);
  });
});
