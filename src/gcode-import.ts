/**
 * G-code → Plan 导入解析器（任务 3.8）。
 *
 * 外部 G-code（Inkscape GCodeTools、LaserGRBL、J-Tech 等方言基线）归一化为
 * 本项目的标准 Plan 与笔画（ImportedStroke），进入既有绘制管线（预览着色、
 * 回溯、补画、超界校验、任务日志全部复用）。
 *
 * 归一化口径（与 gcode.ts 转译层镜像）：
 * - 笔画 = 进给移动链（G1 含 XY 字 / G2/G3 圆弧）。G0 为空程，永不进入
 *   笔画——这是 G-code 世界的「笔落/笔抬」本质（G0=rapid / G1=feed），
 *   样例契约亦如此（M5 抬笔后的 G1 段仍构成笔画）。
 * - 笔控信号（Z 轴式 Z>0=抬笔/Z≤0=落笔；M3/M4=落笔、M5=抬笔）不参与
 *   笔画切分，仅计入统计（penChanges）；Plan 的笔动作按笔画归一化合成
 *   （每笔画一组：空程 → 落笔 → 绘制 → 抬笔），保证 pathGroupStarts
 *   回溯/补画语义可用。
 * - G91 相对坐标、G20 英寸（1in = 25.4mm）均在解析期换算为绝对毫米；
 *   N 行号剥离；`;` 与 `(...)` 注释剥离。
 * - 圆弧按最大 5° 步角细分为折线（弦差对 r=10mm 约 0.01mm），I/J 圆心
 *   偏移（增量式，相对起点）与 R 半径式均支持；无终点词 = 整圆。
 * - 无法识别的行记录告警并跳过（不静默丢弃），导入完成由调用方展示统计。
 * - 管线接入（维护要点）：归一化笔画（strokes）由调用方转为 flatten-svg
 *   约定的 Path[]——机器坐标按当前原点角逐点经 planning.machineFramePoint
 *   镜像回屏幕空间（镜像变换自逆）——再 dispatch setPaths 走 paths→replan
 *   正常管线，与 SVG 导入同一条路，旋转/对齐/缩放等排版操作由此同等生效。
 *   切勿绕过 replan 直接用 result.plan 调 setPlan：排版变换全部在 replan
 *   中执行，绕过会导致导入后排版操作失灵（历史 bug，gcode-layout.test.ts
 *   回归覆盖）。
 */

import {
  constantAccelerationPlan,
  defaultPlanOptions,
  Plan,
  type AccelerationProfile,
  type Motion,
  type Plan as PlanType,
  PenMotion,
} from "./planning.js";
import { type Vec2 } from "./vec.js";

export interface ImportedStroke {
  /** 归一化笔画恒为落笔段（进给移动链）；保留字段以兼容契约 */
  penDown: boolean;
  /** 笔画首段生效的 F 原值（mm/min，G20 已换算）；未设定时为 null */
  feedMmMin: number | null;
  points: Vec2[];
}

export interface GcodeImportWarning {
  /** 源文件物理行号（1-based） */
  line: number;
  message: string;
  /** 剥离注释/行号后的代码文本 */
  raw: string;
}

export interface GcodeImportStats {
  totalLines: number;
  motionLines: number;
  penChanges: number;
  arcs: number;
  skippedLines: number;
}

export interface GcodeImportResult {
  /** 备用直接合成 Plan（笔控参数直读缺省档案）。UI 导入不使用它——见文件头
   * 「管线接入」：须走 strokes→Path[]→setPaths→replan，否则排版失灵 */
  plan: PlanType;
  /** 归一化落笔笔画（机器坐标毫米）；UI 导入据此构造 Path[] 走 replan 管线 */
  strokes: ImportedStroke[];
  warnings: GcodeImportWarning[];
  stats: GcodeImportStats;
}

/** Plan 合成参数（与 planning.plan() 的 ToolingProfile + penHome 同口径，
 * PenMotion 位置为 penPct 口径（0 = 完全抬笔，100 = 完全落笔），与
 * PlanOptions.penUpHeight/penDownHeight 及 GrblController 的 Z 映射一致）。 */
export interface GcodeImportPlanOptions {
  penUpPos: number;
  penDownPos: number;
  penDownProfile: AccelerationProfile;
  penUpProfile: AccelerationProfile;
  penDropDuration: number;
  penLiftDuration: number;
  penHome: Vec2;
}

/** 缺省 Plan 合成参数：defaultPlanOptions 直读（penPct 口径） */
export function defaultGcodeImportPlanOptions(): GcodeImportPlanOptions {
  const o = defaultPlanOptions;
  return {
    penUpPos: o.penUpHeight,
    penDownPos: o.penDownHeight,
    penDownProfile: {
      acceleration: o.penDownAcceleration,
      maximumVelocity: o.penDownMaxVelocity,
      corneringFactor: o.penDownCorneringFactor,
    },
    penUpProfile: {
      acceleration: o.penUpAcceleration,
      maximumVelocity: o.penUpMaxVelocity,
      corneringFactor: 0,
    },
    penDropDuration: o.penDropDuration,
    penLiftDuration: o.penLiftDuration,
    penHome: { ...o.penHome },
  };
}

const EPS = 1e-9;
/** 圆弧细分最大步角（rad）：5° */
const ARC_STEP_RAD = (5 * Math.PI) / 180;
const INCH_MM = 25.4;

interface Word {
  letter: string;
  /** 无值字为 null（如 M5、G90） */
  value: number | null;
}

/** 剥离 `;` 行注释与 `(...)` 行内注释（未闭合括号截断到行尾） */
function stripComments(line: string): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ";") break;
    if (c === "(") {
      const close = line.indexOf(")", i + 1);
      if (close < 0) break;
      i = close;
      continue;
    }
    out += c;
  }
  return out.trim();
}

/** 词法切分：字母 + 可选带符号数值；非法行（词间有非空白垃圾字符）返回 null */
function tokenize(code: string): Word[] | null {
  const words: Word[] = [];
  const re = /([A-Za-z])\s*(-?(?:\d+\.?\d*|\.\d+))?/g;
  let last = 0;
  for (const m of code.matchAll(re)) {
    if (code.slice(last, m.index).trim() !== "") return null;
    words.push({ letter: m[1].toUpperCase(), value: m[2] != null ? Number(m[2]) : null });
    last = (m.index as number) + m[0].length;
  }
  if (code.slice(last).trim() !== "") return null;
  return words;
}

export function parseGcode(source: string, planOptions?: GcodeImportPlanOptions): GcodeImportResult {
  const opts = planOptions ?? defaultGcodeImportPlanOptions();
  const lines = source.split(/\r?\n/);
  const strokes: ImportedStroke[] = [];
  const warnings: GcodeImportWarning[] = [];
  const stats: GcodeImportStats = {
    totalLines: lines.length,
    motionLines: 0,
    penChanges: 0,
    arcs: 0,
    skippedLines: 0,
  };

  const warn = (lineNo: number, raw: string, message: string) => {
    warnings.push({ line: lineNo, message, raw });
    stats.skippedLines += 1;
  };

  // ---- 模态状态 ----
  let unitScale = 1; // G21 → 1；G20 → 25.4
  let absolute = true; // G90/G91
  let modalMotion: "G0" | "G1" | "G2" | "G3" = "G1";
  let modalFeedMmMin: number | null = null;
  let pos: Vec2 = { x: 0, y: 0 };
  let zPosMm = 0;
  let penDown = false;
  let ended = false;

  // 当前进给移动链：G0 / 程序结束切断
  let current: ImportedStroke | null = null;

  /** 单位换算（G20 英寸 → 毫米）。四舍五入到 1e-9mm：消除 3×25.4 =
   * 76.20000000000001 类浮点漂移，保证换算值与十进制字面量精确相等。 */
  const toMm = (v: number) => Math.round(v * unitScale * 1e9) / 1e9;
  const breakStroke = () => {
    current = null;
  };
  /** 开始新笔画（若未开）：首点 = 移动起点 */
  const startStroke = () => {
    if (current == null) {
      current = { penDown: true, feedMmMin: modalFeedMmMin, points: [{ ...pos }] };
      strokes.push(current);
    }
    return current;
  };

  const appendSegment = (to: Vec2) => {
    if (Math.hypot(to.x - pos.x, to.y - pos.y) <= EPS) return; // 零长移动不进笔画
    startStroke().points.push({ ...to });
    pos = { ...to };
  };

  /** 圆弧细分：起点 pos、终点 end、圆心 center；cw = G2（屏幕坐标 Y 向下
   * 顺时针，对应数学坐标逆时针——SVG/激光 dialect 的方向语义）。
   * 中间点取在半径 r 圆周上（r 按起点半径），终点用精确目标值兜底。 */
  const appendArc = (end: Vec2, center: Vec2, cw: boolean, fullCircle: boolean) => {
    const r = Math.hypot(pos.x - center.x, pos.y - center.y);
    if (!(r > EPS)) return; // 退化：圆心即起点，无法定义圆弧
    const a0 = Math.atan2(pos.y - center.y, pos.x - center.x);
    let sweep: number;
    if (fullCircle) {
      sweep = 2 * Math.PI;
    } else {
      const a1 = Math.atan2(end.y - center.y, end.x - center.x);
      // G2（屏幕顺时针 = 数学逆时针）：数学角增；G3：数学角减。
      // sweep ∈ (0, 2π]
      sweep = cw ? (a1 - a0) % (2 * Math.PI) : (a0 - a1) % (2 * Math.PI);
      if (sweep <= EPS) sweep += 2 * Math.PI;
    }
    const n = Math.max(2, Math.ceil(sweep / ARC_STEP_RAD));
    startStroke();
    const dir = cw ? 1 : -1;
    for (let k = 1; k < n; k++) {
      const a = a0 + (dir * sweep * k) / n;
      current?.points.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
    }
    current?.points.push({ ...end });
    pos = { ...end };
  };

  for (let idx = 0; idx < lines.length; idx++) {
    if (ended) break;
    const lineNo = idx + 1;
    const raw = stripComments(lines[idx]);
    if (raw === "" || raw === "%") continue; // 空行 / 程序段标记：忽略
    // N 行号剥离（必须整行首，防止误伤坐标值）
    const code = raw.replace(/^[Nn]\d+\s*/, "").trim();
    if (code === "") continue;

    const words = tokenize(code);
    if (words == null) {
      warn(lineNo, code, "无法解析的行（词法错误），已跳过");
      continue;
    }

    // 词分类
    let motionG: "G0" | "G1" | "G2" | "G3" | null = null;
    const gOthers: number[] = [];
    const mWords: number[] = [];
    let fVal: number | null = null;
    const axis: Record<"x" | "y" | "z" | "i" | "j" | "r", number | null> = {
      x: null,
      y: null,
      z: null,
      i: null,
      j: null,
      r: null,
    };
    let bad = false;
    for (const w of words) {
      const v = w.value;
      switch (w.letter) {
        case "G":
          if (v == null) {
            warn(lineNo, code, "G 词缺少数值，已跳过");
            bad = true;
          } else if (v === 0 || v === 1 || v === 2 || v === 3) {
            motionG = `G${v}` as "G0" | "G1" | "G2" | "G3";
          } else {
            gOthers.push(v);
          }
          break;
        case "M":
          if (v == null) {
            warn(lineNo, code, "M 词缺少数值，已跳过");
            bad = true;
          } else {
            mWords.push(v);
          }
          break;
        case "X":
        case "Y":
        case "Z":
        case "I":
        case "J":
        case "R":
          axis[w.letter.toLowerCase() as "x" | "y" | "z" | "i" | "j" | "r"] = v;
          break;
        case "F":
          fVal = v;
          break;
        // 静默忽略的参数字：S 主轴功率 / T 刀号 / P Q 参数 / L E D H 修饰字
        case "S":
        case "T":
        case "P":
        case "Q":
        case "L":
        case "E":
        case "D":
        case "H":
          break;
        default:
          warn(lineNo, code, `不支持的词 ${w.letter}${v != null ? v : ""}，已跳过`);
          bad = true;
          break;
      }
      if (bad) break;
    }
    if (bad) continue;

    // 模态字先行处理（G20/G21、G90/G91、F：同一行内后续坐标按新模式换算，
    // 与真实 G-code 块内执行顺序一致）
    let planeWarnedThisLine = false;
    for (const g of gOthers) {
      if (g === 20) unitScale = INCH_MM;
      else if (g === 21) unitScale = 1;
      else if (g === 90) absolute = true;
      else if (g === 91) absolute = false;
      else if (g === 17) {
        /* XY 平面：解析器假定，接受 */
      } else if (g === 18 || g === 19) {
        if (!planeWarnedThisLine) {
          planeWarnedThisLine = true;
          // 非 XY 平面：坐标仍按 XY 尽力解析（不中断），保留告警痕迹
          warnings.push({
            line: lineNo,
            message: `非 XY 平面（G${g}）：解析器仅支持 G17 XY 平面，坐标按 XY 平面尽力解析`,
            raw: code,
          });
        }
      } else if (g === 4) {
        warn(lineNo, code, `G${g} 暂停指令对绘图仪无意义，已跳过`);
      } else if (g >= 54 && g <= 59) {
        /* 工作坐标系：接受 */
      } else {
        warn(lineNo, code, `不支持的 G-code（G${g}），已跳过`);
      }
    }
    if (fVal != null) {
      const f = toMm(fVal);
      if (f > 0) modalFeedMmMin = f;
    }

    // M 字处理
    for (const m of mWords) {
      if (m === 30 || m === 2) {
        ended = true; // 程序结束：本行后续及之后全部忽略
      } else if (m === 3 || m === 4) {
        if (!penDown) stats.penChanges += 1;
        penDown = true;
      } else if (m === 5) {
        if (penDown) stats.penChanges += 1;
        penDown = false;
      } else if (m === 6) {
        warn(lineNo, code, "M6 换刀指令不支持，已跳过");
      } else {
        warn(lineNo, code, `不支持的 M-code（M${m}），已跳过`);
      }
    }
    if (ended) break;

    // 运动执行
    const hasXY = axis.x != null || axis.y != null;
    const hasZ = axis.z != null;
    const hasArcParams = axis.i != null || axis.j != null || axis.r != null;
    if (motionG != null) modalMotion = motionG;
    const motion = motionG ?? modalMotion;
    // 纯模式行跳过；整圆（G2/G3 仅带 I/J，无轴字）仍是运动
    if (!hasXY && !hasZ && !(hasArcParams && (motion === "G2" || motion === "G3"))) continue;

    // 目标坐标（绝对毫米）
    const target: Vec2 = {
      x: axis.x != null ? (absolute ? toMm(axis.x) : pos.x + toMm(axis.x)) : pos.x,
      y: axis.y != null ? (absolute ? toMm(axis.y) : pos.y + toMm(axis.y)) : pos.y,
    };
    stats.motionLines += 1;

    // Z 笔控（Z 轴式方言）：不切笔画，仅计笔态变化
    if (hasZ) {
      zPosMm = absolute ? toMm(axis.z!) : zPosMm + toMm(axis.z!);
      const newPenDown = zPosMm <= EPS;
      if (newPenDown !== penDown) stats.penChanges += 1;
      penDown = newPenDown;
    }

    if (motion === "G0") {
      // 空程：更新位置并切断笔画链
      breakStroke();
      pos = target;
    } else if (motion === "G1") {
      if (hasXY) appendSegment(target);
    } else {
      // G2/G3 圆弧
      stats.arcs += 1;
      const cw = motion === "G2";
      if (axis.r != null) {
        // R 半径式（Grbl/LinuxCNC 公式）：R 正负选择优/劣弧
        const dx = target.x - pos.x;
        const dy = target.y - pos.y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= EPS) {
          warn(lineNo, code, "R 式圆弧起点与终点重合，无法定义，已跳过");
          continue;
        }
        let r = toMm(axis.r);
        // R 式（Grbl/LinuxCNC 数学坐标公式）：h 取负 sqrt；数学逆时针时翻转。
        // 本解析器 cw（G2）= 屏幕顺时针 = 数学逆时针，即需翻转的分支。
        let h = -Math.sqrt(Math.max(0, 4 * r * r - d2)) / Math.sqrt(d2);
        if (cw) h = -h;
        if (r < 0) {
          h = -h;
          r = -r;
        }
        if (4 * r * r < d2 - EPS) {
          warn(lineNo, code, `R 式圆弧半径过小（起终点距离 ${Math.sqrt(d2).toFixed(3)}mm > 2R），已跳过`);
          continue;
        }
        const i = 0.5 * (dx - dy * h);
        const j = 0.5 * (dy + dx * h);
        appendArc(target, { x: pos.x + i, y: pos.y + j }, cw, false);
      } else if (axis.i != null || axis.j != null) {
        // I/J 圆心偏移（增量式，相对起点）；无终点词 = 整圆
        const center = {
          x: pos.x + toMm(axis.i ?? 0),
          y: pos.y + toMm(axis.j ?? 0),
        };
        const fullCircle = !hasXY;
        appendArc(target, center, cw, fullCircle);
      } else {
        warn(lineNo, code, `G${motion === "G2" ? 2 : 3} 缺少 I/J 或 R 圆弧参数，已跳过`);
      }
    }
  }

  // 过滤退化笔画（< 2 点无法构成线段）
  const usable = strokes.filter((s) => s.points.length >= 2);

  return {
    plan: buildPlan(usable, opts),
    strokes: usable,
    warnings,
    stats,
  };
}

/** 由归一化笔画合成标准 Plan：每笔画一组「空程 → 落笔 → 绘制 → 抬笔」，
 * 与 planning.plan() 的 4-motion 组结构一致（pathGroupStarts 回溯可用）。 */
function buildPlan(strokes: ImportedStroke[], o: GcodeImportPlanOptions): PlanType {
  const motions: Motion[] = [];
  let cur: Vec2 = { ...o.penHome };
  for (const s of strokes) {
    const start = s.points[0];
    if (Math.hypot(start.x - cur.x, start.y - cur.y) > EPS) {
      motions.push(constantAccelerationPlan([cur, start], o.penUpProfile));
    }
    motions.push(new PenMotion(o.penUpPos, o.penDownPos, o.penDropDuration));
    motions.push(constantAccelerationPlan(s.points, o.penDownProfile));
    motions.push(new PenMotion(o.penDownPos, o.penUpPos, o.penLiftDuration));
    cur = s.points[s.points.length - 1];
  }
  if (Math.hypot(cur.x - o.penHome.x, cur.y - o.penHome.y) > EPS) {
    motions.push(constantAccelerationPlan([cur, o.penHome], o.penUpProfile));
  }
  return new Plan(motions);
}
