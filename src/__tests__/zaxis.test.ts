import { expect, test } from "vitest";
import { PenMotion } from "../planning.js";
import {
  effectiveZFeedMmMin,
  penMotionDurationSec,
  penPctToZMm,
  zAxisConfigFromDriveParams,
  type ZAxisConfig,
} from "../zaxis.js";

const cfg: ZAxisConfig = { zPenDownMm: 0, zPenUpMm: 5, zFeedMmMin: 600 };

test("penPctToZMm：0=抬笔 5mm，100=落笔 0mm，线性", () => {
  expect(penPctToZMm(0, cfg)).toBeCloseTo(5);
  expect(penPctToZMm(100, cfg)).toBeCloseTo(0);
  expect(penPctToZMm(50, cfg)).toBeCloseTo(2.5);
  expect(penPctToZMm(60, cfg)).toBeCloseTo(2);
});

test("penPctToZMm：越界钳制到 [0, 100]", () => {
  expect(penPctToZMm(-10, cfg)).toBeCloseTo(5);
  expect(penPctToZMm(150, cfg)).toBeCloseTo(0);
});

test("penPctToZMm：反向档案（落笔 > 抬笔）同样线性有效", () => {
  const c: ZAxisConfig = { zPenDownMm: -1, zPenUpMm: 3, zFeedMmMin: 600 };
  expect(penPctToZMm(0, c)).toBeCloseTo(3);
  expect(penPctToZMm(100, c)).toBeCloseTo(-1);
});

test("zAxisConfigFromDriveParams：档案缺省值回退", () => {
  const r = zAxisConfigFromDriveParams({ name: "", stepAngle: 1.8, microstepping: 16, pulleyTeeth: 20, beltPitch: 2 });
  expect(r).toEqual({ zPenDownMm: 0, zPenUpMm: 5, zFeedMmMin: 600 });
});

test("zAxisConfigFromDriveParams：档案显式值优先", () => {
  const r = zAxisConfigFromDriveParams({
    name: "",
    stepAngle: 1.8,
    microstepping: 16,
    pulleyTeeth: 20,
    beltPitch: 2,
    zPenDownMm: 0.5,
    zPenUpMm: 8,
    zFeedMmMin: 1200,
  });
  expect(r).toEqual({ zPenDownMm: 0.5, zPenUpMm: 8, zFeedMmMin: 1200 });
});

test("effectiveZFeedMmMin：$112 缺省不钳制，提供时取小", () => {
  expect(effectiveZFeedMmMin(cfg)).toBe(600);
  expect(effectiveZFeedMmMin(cfg, 1200)).toBe(600);
  expect(effectiveZFeedMmMin(cfg, 300)).toBe(300);
});

test("penMotionDurationSec：|ΔZ| ÷ Z 进给", () => {
  // penPct 50→60：Z 2.5→2.0，ΔZ=0.5mm；600mm/min = 10mm/s → 0.05s
  expect(penMotionDurationSec(new PenMotion(50, 60, 999), cfg)).toBeCloseTo(0.05);
  // 抬笔反向同理
  expect(penMotionDurationSec(new PenMotion(60, 50, 999), cfg)).toBeCloseTo(0.05);
});

test("penMotionDurationSec：受 $112 钳制后时长变长", () => {
  // 进给被钳到 300mm/min = 5mm/s → 0.5/5 = 0.1s
  expect(penMotionDurationSec(new PenMotion(50, 60, 999), cfg, 300)).toBeCloseTo(0.1);
});
