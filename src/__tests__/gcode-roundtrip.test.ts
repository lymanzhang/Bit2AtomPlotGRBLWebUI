/**
 * G-code 导入 → 导出 → 再导入 round-trip 测试（任务 4.1）。
 *
 * 验证 3.8 导入与 3.9 导出的互逆性：导入样例 → 合成 Plan → planToGCode
 * 导出 → 再导入 → 笔画数与几何等价（双向点到折线距离 + 弧长差，覆盖导出
 * 3 位小数量化与规划器共线分割点），且再导入无告警（导出文件是自产的
 * 标准方言）。同时覆盖 4 种方言样例 fixture 的解析（Inkscape GCodeTools /
 * LaserGRBL / J-Tech / 综合样例）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { planToGCode } from "../export-gcode";
import { defaultGcodeImportPlanOptions, parseGcode } from "../gcode-import";
import { defaultPlanOptions } from "../planning";
import { type Vec2 } from "../vec";

const here = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (name: string) => readFileSync(join(here, name), "utf-8");

/** 点到线段距离 */
const pointSegDist = (p: Vec2, a: Vec2, b: Vec2): number => {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
};

/** pts 每点到折线 poly 的最大距离（几何等价核心量） */
const maxDistToPolyline = (pts: Vec2[], poly: Vec2[]): number => {
  let maxD = 0;
  for (const p of pts) {
    let minD = Infinity;
    for (let i = 0; i + 1 < poly.length; i++) {
      minD = Math.min(minD, pointSegDist(p, poly[i], poly[i + 1]));
    }
    maxD = Math.max(maxD, minD);
  }
  return maxD;
};

const polyLen = (pts: Vec2[]): number => {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return len;
};

/**
 * 几何等价容差。导出侧 3 位小数量化（≤5e-4/轴）使再导入点偏离原折线
 * ≤~1e-3mm；规划器分割点与弧细分点结构不同但几何一致，故不做逐点结构
 * 比对，而做双向「点到折线距离 + 弧长差」等价校验。
 */
const DEVIATION_TOL = 2e-3; // mm
const LENGTH_TOL = 0.1; // mm（量化逐段误差累计上界）

describe("G-code round-trip（4.1）", () => {
  const fixtures = [
    "gcode-sample-basic.gcode",
    "gcode-sample-inkscape-gcodetools.gcode",
    "gcode-sample-lasergrbl.gcode",
    "gcode-sample-jtech.gcode",
  ];

  for (const name of fixtures) {
    it(`${name}: 导入 → 导出 → 再导入，笔画几何一致`, () => {
      const first = parseGcode(read(name), defaultGcodeImportPlanOptions());
      expect(first.strokes.length).toBeGreaterThan(0);
      // 综合样例含 G4/M6 演示告警；三种方言样例应零告警
      if (name !== "gcode-sample-basic.gcode") {
        expect(first.warnings).toEqual([]);
      }

      const g = planToGCode(first.plan, {
        sourceFileName: name,
        driveParams: defaultPlanOptions.driveParams,
        hardwareLabel: "grbl11-screw",
      });

      const second = parseGcode(g, defaultGcodeImportPlanOptions());
      // 再导入无解析告警：导出文件仅含标准指令（G0/G1/G21/G90/G54/Z 轴笔控）
      expect(second.warnings).toEqual([]);
      expect(second.strokes.length).toBe(first.strokes.length);
      for (let i = 0; i < first.strokes.length; i++) {
        const a = first.strokes[i].points;
        const b = second.strokes[i].points;
        // 双向几何等价：一侧每点均落在另一侧折线上（规划器分割点/量化抖动
        // 不改变几何），且折线弧长一致
        expect(maxDistToPolyline(a, b)).toBeLessThanOrEqual(DEVIATION_TOL);
        expect(maxDistToPolyline(b, a)).toBeLessThanOrEqual(DEVIATION_TOL);
        const lenA = polyLen(a);
        const lenB = polyLen(b);
        expect(Math.abs(lenB - lenA)).toBeLessThanOrEqual(Math.max(LENGTH_TOL, lenA * 0.002));
      }
    });
  }

  it("方言样例统计：圆弧计数、M3/M4/M5 笔控计penChanges、S 字静默忽略", () => {
    const laser = parseGcode(read("gcode-sample-lasergrbl.gcode"), defaultGcodeImportPlanOptions());
    expect(laser.stats.arcs).toBe(1);
    expect(laser.stats.penChanges).toBe(4); // M4/M5 ×2
    expect(laser.warnings).toEqual([]);

    const inkscape = parseGcode(read("gcode-sample-inkscape-gcodetools.gcode"), defaultGcodeImportPlanOptions());
    expect(inkscape.stats.arcs).toBe(1);
    expect(inkscape.warnings).toEqual([]);

    const jtech = parseGcode(read("gcode-sample-jtech.gcode"), defaultGcodeImportPlanOptions());
    // M3/M5 ×2 计 4 次变化；Z 轴 Z0/Z5 与 M3/M5 同向（笔态未翻转）不计重复
    expect(jtech.stats.penChanges).toBe(4);
    expect(jtech.warnings).toEqual([]);
  });
});
