import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";

// 每次服务运行的日志落盘：包装 console.log/warn/error，同时输出到
// 终端与 logs/bit2atombot-<启动时间>.log。绘制耗时、补画区间、归位
// 分步耗时（probe/pen/motors/travel/idle/disable）、通信探活等性能
// 数据都在这些日志里，便于事后分析评估（如 travel+idle 段耗时趋势
// 反映机械健康度）。
//
// 环境变量：
//   BIT2ATOM_NO_FILE_LOG=1  禁用文件日志（仅终端输出）
//   BIT2ATOM_LOG_DIR=<dir>  日志目录（默认 logs/）
const MAX_LOG_FILES = 50; // 保留最近 N 个运行日志，避免无限增长
const LOG_PREFIX = "bit2atombot-";

export function startRunLog(): void {
  if (process.env.BIT2ATOM_NO_FILE_LOG) return;
  let logDir = "logs";
  if (process.env.BIT2ATOM_LOG_DIR) logDir = process.env.BIT2ATOM_LOG_DIR;

  try {
    mkdirSync(logDir, { recursive: true });
    const now = new Date();
    const p = (n: number): string => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
    const logPath = join(logDir, `${LOG_PREFIX}${stamp}.log`);
    pruneOldLogs(logDir);

    const write = (level: string, args: unknown[]): void => {
      const t = new Date();
      const ts = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
      const text = args
        .map((a) => (typeof a === "string" ? a : inspect(a, { depth: 4 })))
        .join(" ");
      try {
        appendFileSync(logPath, `[${ts}] [${level}] ${text}\n`, "utf8");
      } catch {
        // 磁盘满/权限问题不应影响服务运行；关闭文件日志避免反复报错。
        console.log = original.log;
        console.warn = original.warn;
        console.error = original.error;
      }
    };

    const original = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    };
    console.log = (...args: unknown[]) => {
      original.log(...args);
      write("INFO", args);
    };
    console.warn = (...args: unknown[]) => {
      original.warn(...args);
      write("WARN", args);
    };
    console.error = (...args: unknown[]) => {
      original.error(...args);
      write("ERROR", args);
    };
    console.log(`Logging to ${logPath}`);
  } catch (e) {
    // 日志目录创建失败（如只读文件系统）不应阻止服务启动。
    console.warn("File logging disabled (cannot create log directory):", e);
  }
}

function pruneOldLogs(logDir: string): void {
  try {
    const logs = readdirSync(logDir)
      .filter((f) => f.startsWith(LOG_PREFIX) && f.endsWith(".log"))
      .sort()
      .reverse(); // 新的在前
    for (const f of logs.slice(MAX_LOG_FILES)) {
      unlinkSync(join(logDir, f));
    }
  } catch {
    // 清理失败不影响本次运行。
  }
}
