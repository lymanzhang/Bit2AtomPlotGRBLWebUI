/**
 * 绘制任务日志：每次 /plot 或 /redraw 任务写一个独立日志文件到 logs/ 目录。
 * 文件名与源 SVG 文件同名（附加开始时间戳避免同名覆盖），方便按文件归档查找。
 *
 * 任务日志结构：
 *   ┌ 任务头：源文件、模式、硬件/端口、FIFO 深度、动作数、预计时长/距离、开始时间
 *   ├ 过程记录：[时间戳] [级别] 消息（含节流的进度心跳、暂停/恢复/回溯、
 *   │           设备层诊断——通过拦截 console 自动捕获 ebb.ts 的全部输出）
 *   └ 任务尾：结束时间、实际时长、实际绘制距离、结果（成功/失败/已取消）
 */
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";

// 与 run-log.ts 的目录约定一致：默认 logs/，BIT2ATOM_LOG_DIR 可覆盖。
const logsDir = process.env.BIT2ATOM_LOG_DIR ?? "logs";

export interface PlotLogMeta {
  /** 源 SVG 文件名（如 cloud13.svg），未提供时为 untitled.svg */
  fileName: string;
  /** 任务模式："plot" 或 "redraw 1200-1400" */
  mode: string;
  /** 图层过滤模式（"group" | "stroke" | "all"），未提供时省略 */
  layerMode?: string;
  /** 本次绘制包含的图层名（已按过滤模式选择），未提供时省略 */
  layers?: string[];
  /** 硬件类型，如 custom（模拟模式为 sim） */
  hardware: string;
  /** 串口端口（如 COM4），模拟模式为 null */
  port: string | null;
  /** EBB 运动 FIFO 深度（-1 表示未知/未配置） */
  fifoDepth: number;
  /** 动作总数 */
  motionCount: number;
  /** 预计时长（秒） */
  estimatedDurationSec: number;
  /** 预计绘制距离（mm） */
  estimatedDistanceMm: number;
  /** 计划中的最大速度（mm/s） */
  maxVelocityMmS: number;
}

export interface PlotLogResult {
  status: "success" | "failed" | "cancelled";
  reason?: string;
  /** 实际时长（秒） */
  actualDurationSec: number;
  /** 实际绘制距离（mm） */
  actualDistanceMm: number;
  /** 结束时的 FIFO 深度（-1 表示未知/未配置）。任务头记录时设备可能
   * 尚未配置（首个任务在 prePlot 之前），故在任务尾补充记录。 */
  fifoDepth?: number;
}

type ConsoleKind = "log" | "warn" | "error";

/** Windows 文件名非法字符与首尾空白/点 */
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, "_").trim().replace(/^\.+/, "");
  return cleaned.length > 0 ? cleaned : "untitled";
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

function timestampOf(date: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

function clockOf(date: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}.${p(date.getMilliseconds(), 3)}`;
}

export class PlotLogger {
  private stream: ReturnType<typeof createWriteStream> | null = null;
  private filePath: string | null = null;
  private startedAt: Date | null = null;
  private originalConsole: Record<ConsoleKind, (...args: unknown[]) => void> | null = null;
  // 进度节流：每 1000 个动作或每 60s 记一条
  private lastProgressIdx = -1000;
  private lastProgressAt = 0;

  get file(): string | null {
    return this.filePath;
  }

  async start(meta: PlotLogMeta): Promise<void> {
    this.startedAt = new Date();
    const stamp = timestampOf(this.startedAt).replace(/[: ]/g, "-");
    const base = sanitizeFileName(meta.fileName).replace(/\.[^.]+$/, "");
    mkdirSync(logsDir, { recursive: true });
    this.filePath = join(logsDir, `${base}__${stamp}.log`);
    this.stream = createWriteStream(this.filePath, { encoding: "utf8" });
    this.stream.on("error", (e) => {
      this.originalConsole?.error.call(console, `[bit2atombot] plot log write failed: ${e}`);
    });

    const dur = formatDuration(meta.estimatedDurationSec);
    const layerLines: string[] = [];
    if (meta.layerMode != null) {
      const modeText =
        meta.layerMode === "group" ? "按组（group）" : meta.layerMode === "stroke" ? "按描边色（stroke）" : "全部图层（all）";
      layerLines.push(`图层过滤:      ${modeText}`);
    }
    if (meta.layers != null) {
      layerLines.push(
        meta.layers.length > 0 ? `绘制图层:      ${meta.layers.join(", ")}（共 ${meta.layers.length} 层）` : "绘制图层:      （无选中图层）",
      );
    }
    this.header(
      [
        "=".repeat(64),
        "Bit2AtomBot 绘制任务日志",
        "=".repeat(64),
        `源文件:        ${meta.fileName}`,
        `任务模式:      ${meta.mode}`,
        ...layerLines,
        `硬件:          ${meta.hardware}${meta.port != null ? ` @ ${meta.port}` : "（模拟模式）"}`,
        `FIFO 深度:     ${meta.fifoDepth < 0 ? "未配置" : meta.fifoDepth}`,
        `动作总数:      ${meta.motionCount}`,
        `预计时长:      ${dur}`,
        `预计绘制距离:  ${(meta.estimatedDistanceMm / 1000).toFixed(1)} m`,
        `计划最大速度:  ${meta.maxVelocityMmS.toFixed(1)} mm/s`,
        `开始时间:      ${timestampOf(this.startedAt)}`,
        "-".repeat(64),
      ].join("\n"),
    );

    // 拦截 console：设备层（ebb.ts 等）的全部诊断输出同步进入日志文件。
    this.originalConsole = { log: console.log, warn: console.warn, error: console.error };
    const levelMap: Record<ConsoleKind, "INFO" | "WARN" | "ERROR"> = { log: "INFO", warn: "WARN", error: "ERROR" };
    for (const kind of ["log", "warn", "error"] as ConsoleKind[]) {
      const original = this.originalConsole[kind].bind(console);
      console[kind] = (...args: unknown[]) => {
        original(...args);
        this.line(levelMap[kind], format(...args));
      };
    }
  }

  /** 记录一条过程日志（不重复输出到控制台，console 已被拦截） */
  line(kind: "INFO" | "PLOT" | "WARN" | "ERROR", msg: string): void {
    this.write(`[${clockOf(new Date())}] [${kind}] ${msg}`);
  }

  /** 进度心跳：每 1000 个动作或每 60s 记一条 */
  progress(idx: number, end: number, distanceMm: number): void {
    const now = Date.now();
    if (idx - this.lastProgressIdx < 1000 && now - this.lastProgressAt < 60000) {
      return;
    }
    this.lastProgressIdx = idx;
    this.lastProgressAt = now;
    const pct = end > 0 ? ((idx / end) * 100).toFixed(1) : "0.0";
    this.line("PLOT", `进度 ${idx}/${end} (${pct}%)，已绘制 ${(distanceMm / 1000).toFixed(1)} m`);
  }

  async finish(result: PlotLogResult): Promise<void> {
    if (this.stream == null || this.startedAt == null) {
      return;
    }
    const statusText =
      result.status === "success" ? "成功" : result.status === "cancelled" ? "已取消" : `失败${result.reason != null ? ` — ${result.reason}` : ""}`;
    const end = new Date();
    const fifoLine = result.fifoDepth != null ? [`FIFO 深度:      ${result.fifoDepth < 0 ? "未配置" : result.fifoDepth}（任务尾）`] : [];
    this.header(
      [
        "-".repeat(64),
        `结束时间:      ${timestampOf(end)}`,
        `实际时长:      ${formatDuration(result.actualDurationSec)}`,
        `实际绘制距离:  ${(result.actualDistanceMm / 1000).toFixed(1)} m`,
        ...fifoLine,
        `结果:          ${statusText}`,
        "=".repeat(64),
        "",
      ].join("\n"),
    );

    // 还原 console 后再关闭流（还原要在流关闭前，避免最后的日志丢失钩子）
    if (this.originalConsole != null) {
      for (const kind of ["log", "warn", "error"] as ConsoleKind[]) {
        console[kind] = this.originalConsole[kind];
      }
      this.originalConsole = null;
    }
    const stream = this.stream;
    this.stream = null;
    this.lastProgressIdx = -1000;
    this.lastProgressAt = 0;
    return new Promise((resolve) => {
      stream.end(resolve);
    });
  }

  private header(text: string): void {
    this.write(text);
  }

  private write(text: string): void {
    this.stream?.write(`${text}\n`);
  }
}
