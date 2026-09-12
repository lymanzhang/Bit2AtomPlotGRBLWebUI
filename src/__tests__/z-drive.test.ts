import { expect, test } from "vitest";
import {
  computeStepsPerMm,
  computeZStepsPerMm,
  GRBL_PRESET_PROFILES,
  type DriveParams,
} from "../planning.js";

// 换算契约：与 GRBL $ 参数同口径（全步，不含细分）
// - XY: stepsPerMm = (360 / 步距角) / (齿数 × 齿距)
// - Z 丝杆: (360 / Z步距角) / 导程；Z 同步带: (360 / Z步距角) / (齿数 × 齿距)

const base: DriveParams = {
  name: "test",
  stepAngle: 1.8,
  microstepping: 16,
  pulleyTeeth: 20,
  beltPitch: 2,
};

test("XY stepsPerMm：1.8° / 20 齿 / GT2 = 5 步/mm", () => {
  expect(computeStepsPerMm(base)).toBeCloseTo(5);
});

test("Z 丝杆：1.8° / T8 导程 8mm = 25 步/mm", () => {
  expect(computeZStepsPerMm({ ...base, zDriveType: "screw", zLeadMm: 8 })).toBeCloseTo(25);
});

test("Z 同步带：1.8° / 20 齿 / 齿距 2 = 5 步/mm", () => {
  expect(computeZStepsPerMm({ ...base, zDriveType: "belt", zPulleyTeeth: 20, zBeltPitch: 2 })).toBeCloseTo(5);
});

test("Z 步距角缺省沿用 XY 步距角", () => {
  const d: DriveParams = { ...base, zDriveType: "screw", zLeadMm: 4 };
  // (360/1.8)/4 = 50
  expect(computeZStepsPerMm(d)).toBeCloseTo(50);
});

test("Z 步距角独立指定（0.9° 电机）", () => {
  const d: DriveParams = { ...base, zDriveType: "screw", zStepAngle: 0.9, zLeadMm: 8 };
  // (360/0.9)/8 = 50
  expect(computeZStepsPerMm(d)).toBeCloseTo(50);
});

test("三个 GRBL 预设档字段齐全且可换算", () => {
  expect(GRBL_PRESET_PROFILES).toHaveLength(3);
  for (const preset of GRBL_PRESET_PROFILES) {
    const d = preset.driveParams;
    expect(d.firmware?.firmwareKind).toBeTruthy();
    expect(d.firmware?.baudRate).toBe(115200);
    expect(d.firmware?.rxBufferSize).toBe(128);
    expect(d.zPenUpMm).toBeGreaterThan(0);
    expect(d.zFeedMmMin).toBeGreaterThan(0);
    // 换算结果应为正数且在合理范围（1–100 步/mm）
    const xy = computeStepsPerMm(d);
    const z = computeZStepsPerMm(d);
    expect(xy).toBeGreaterThan(0);
    expect(z).toBeGreaterThan(0);
    expect(xy).toBeLessThan(100);
    expect(z).toBeLessThan(100);
  }
});
