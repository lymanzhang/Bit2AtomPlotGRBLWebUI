/**
 * GRBL 行协议层（任务 2.1）。
 *
 * 参照 ebb.ts 的超时纪律设计，协议语义全新实现：
 * - 启动握手：发送 `\r\n\r\n` 唤醒并等待 `Grbl x.x` 横幅；grblHAL 可能伪装
 *   同样的横幅，精确判型须再查 `$I` 的 `[FIRMWARE:grblHAL]`（queryInfo）。
 * - `ok`/`error:` 逐行应答按入队顺序匹配（GRBL 严格 FIFO 应答）。
 * - 字符计数流控：RX 缓冲区（默认 128 字符）窗口内才发送，`ok`/`error`
 *   回收窗口额度——替代 EBB 的 FIFO 深度模型。
 * - 实时命令（`?` `!` `~` 0x18）不排队、不占窗口，立即写入。
 * - 全命令超时：常规 15s；超时即 cancel()（清队列 + 沉降期），由调用方
 *   走恢复路径（hold → 状态探测 → 报错）。沉降期内迟到的孤儿 `ok` 被丢弃，
 *   防止错位到新命令上。
 * - 串口写失败即中止全部挂起命令（移植 EBB 错误码 31 教训）。
 */

import { type FirmwareKind } from "./planning.js";

/** 最小串口形状（node serialport 封装与浏览器 WebSerial 均满足） */
export interface SerialPortLike {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}

export interface GrblStatus {
  /** 机器状态：Idle / Run / Hold / Jog / Alarm / Door / Check / Sleep */
  state: string;
  /** Hold 子码（Hold:1 = 保持中排空） */
  substate?: number;
  /** 机床坐标（$10 含 MPos 位时出现） */
  mpos?: { x: number; y: number; z: number };
  /** 工作坐标（$10 含 WPos 位时出现） */
  wpos?: { x: number; y: number; z: number };
  /** 进给率 mm/min（$10=1/2 v1.1 报文） */
  feed?: number;
  /** 主轴转速 rpm */
  spindle?: number;
  /** RX 缓冲区剩余可用字符（grblHAL / $10=2） */
  buf?: number;
  /** 引脚状态 Pn:XYZ */
  pins?: string;
  raw: string;
}

export interface GrblInfo {
  /** [VER:v1.1h...] 中的 "v1.1h" */
  version: string | null;
  /** [FIRMWARE:grblHAL] 判型（grblHAL 专用行，经典 GRBL 无） */
  firmwareKind: FirmwareKind | "unknown";
  /** [OPT:...] 原始编译选项码 */
  options: string | null;
  lines: string[];
}

export interface GrblOptions {
  /** RX 缓冲区字符数（默认 128；可由档案配置或 $I 探测覆盖） */
  rxBufferSize?: number;
  /** 常规命令超时（默认 15s） */
  defaultTimeoutMs?: number;
  /** 队列清空后的应答沉降期（默认 500ms，与 EBB 纪律一致） */
  settleMs?: number;
}

interface QueueEntry {
  line: string;
  /** 占用窗口字节数（含行尾换行） */
  bytes: number;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  sent: boolean;
  /** 头部期间收到非应答行（[MSG:] 等）时回调；返回 true 表示已消费 */
  onLine?: (line: string) => boolean;
}

// ---- 3.5 错误/告警分类映射（GRBL v1.1 官方代码表） ----

/** GRBL v1.1 `error:N` 官方描述（中文摘要，error:18/19 等保留码不列出） */
const GRBL_ERROR_MESSAGES: Record<number, string> = {
  1: "G-code 词缺少命令字母",
  2: "数值格式无效或缺少期望值",
  3: "无法识别或不受支持的 $ 系统命令",
  4: "期望正值却收到负值",
  5: "归位未启用（$22=0），无法执行 $H",
  6: "最小步进脉冲时间必须大于 3μs",
  7: "EEPROM 读取失败，已恢复默认值",
  8: "设备忙（非 Idle），$ 命令被拒绝",
  9: "Alarm/点动状态下 G-code 被锁定（须先归位或解锁）",
  10: "软限位（$20）依赖归位（$22），未启用归位无法开启",
  11: "超过单行最大字符数，本行未执行",
  12: "$ 设置值超过固件支持的最大步进速率",
  13: "检测到安全门打开",
  14: "构建信息/启动行超出 EEPROM 行长度限制",
  15: "点动目标超出机器行程，已忽略",
  16: "点动命令缺少 '=' 或包含被禁止的 G-code",
  20: "块中包含不支持或无效的 G-code 命令",
  21: "块中出现同一模态组的多个 G-code 命令",
  22: "进给率尚未设置或未定义",
  23: "块中的 G-code 命令需要整数值",
  24: "块中出现多个需要轴字的 G-code 命令",
  25: "块中出现重复的 G-code 字",
  26: "G-code 命令需要 XYZ 轴字但块中未找到",
  27: "行号值超出有效范围（1–9999999）",
  28: "G-code 命令缺少必需的 P 或 L 值",
  29: "不支持 G59.1/G59.2/G59.3 工作坐标系",
  30: "G53 需要 G0/G1 运动模式激活",
  31: "G80 运动取消模式下出现未使用的轴字",
  32: "G2/G3 圆弧在所选平面内缺少轴字",
  33: "运动目标无效（圆弧无法生成或探测目标为当前位置）",
  34: "G2/G3 半径定义的圆弧几何计算错误",
  35: "G2/G3 偏移定义的圆弧缺少所选平面内的 IJK 偏移字",
  36: "块中存在未被任何命令使用的多余 G-code 字",
  37: "G43.1 动态刀长偏置不能用于配置轴以外的轴",
  38: "工具编号无效",
};

/** 把 `error:N` 应答行映射为用户可读错误；保留 `error:N` 前缀供上层
 * 正则匹配（如测试与错误分类），描述附于括号内。非 error 行原样返回。 */
export function describeGrblError(line: string): string {
  const m = line.match(/^error:(\d+)/);
  if (!m) return line;
  const desc = GRBL_ERROR_MESSAGES[Number(m[1])];
  return desc ? `${line}（${desc}）` : line;
}

/** GRBL v1.1 `ALARM:N` 官方描述与恢复提示（中文摘要）。 */
export function describeGrblAlarm(code: number): string {
  switch (code) {
    case 1:
      return "硬限位触发：急停后机器位置可能丢失，强烈建议重新归位（$H）";
    case 2:
      return "软限位报警：运动目标超出机器行程；位置已安全保留，可直接解锁（$X）";
    case 3:
      return "运动中复位：无法保证位置精度（可能丢步），强烈建议重新归位（$H）";
    case 4:
      return "探测失败：探测循环开始前探针初始状态不符";
    case 5:
      return "探测失败：探针未在程序行程内接触到工件";
    case 6:
      return "归位失败：归位循环期间发生复位";
    case 7:
      return "归位失败：归位循环期间安全门被打开";
    case 8:
      return "归位失败：拉离行程未能脱离限位开关（检查 $27 拉离距离/接线）";
    case 9:
      return "归位失败：搜索距离内未找到限位开关（检查限位开关安装与接线）";
    default:
      return `未知告警码 ${code}`;
  }
}

/** 解析 `Grbl 1.1h ['$' for help]` 横幅；非横幅返回 null。 */
export function parseBanner(line: string): { version: string; kind: FirmwareKind } | null {
  const m = line.match(/^Grbl(?:HAL)?\s+(\d+\.\d+)/i);
  if (!m) return null;
  const kind: FirmwareKind = m[0].toLowerCase().startsWith("grblhal")
    ? "grblhal"
    : m[1].startsWith("0.")
      ? "grbl-0.9"
      : "grbl-1.1";
  return { version: m[1], kind };
}

/** 解析 `<Idle|MPos:0.000,0.000,0.000|FS:0,0>` 状态行；非状态行返回 null。 */
export function parseGrblStatus(line: string): GrblStatus | null {
  if (!line.startsWith("<") || !line.endsWith(">")) return null;
  const fields = line.slice(1, -1).split("|");
  const [stateField, ...rest] = fields;
  const [stateRaw, subRaw] = stateField.split(":");
  const status: GrblStatus = { state: stateRaw, raw: line };
  if (subRaw != null && subRaw !== "") {
    const sub = Number(subRaw);
    if (Number.isFinite(sub)) status.substate = sub;
  }
  for (const f of rest) {
    const idx = f.indexOf(":");
    if (idx < 0) continue;
    const key = f.slice(0, idx);
    const value = f.slice(idx + 1);
    if (key === "MPos" || key === "WPos") {
      const parts = value.split(",").map(Number);
      if (parts.length >= 3 && parts.every(Number.isFinite)) {
        status[key === "MPos" ? "mpos" : "wpos"] = { x: parts[0], y: parts[1], z: parts[2] };
      }
    } else if (key === "FS") {
      const [feed, spindle] = value.split(",").map(Number);
      if (Number.isFinite(feed)) status.feed = feed;
      if (Number.isFinite(spindle)) status.spindle = spindle;
    } else if (key === "F") {
      const feed = Number(value);
      if (Number.isFinite(feed)) status.feed = feed; // v0.9 报文
    } else if (key === "Buf") {
      const buf = Number(value);
      if (Number.isFinite(buf)) status.buf = buf;
    } else if (key === "Pn") {
      status.pins = value;
    }
  }
  return status;
}

export class Grbl {
  public port: SerialPortLike;
  /** RX 缓冲区字符数（字符计数流控窗口） */
  public rxBufferSize: number;
  public defaultTimeoutMs: number;
  private settleMs: number;
  /** 版本横幅判型结果（握手后可用；grblHAL 伪装横幅时须以 queryInfo 为准） */
  public firmwareKind: FirmwareKind | "unknown" = "unknown";
  public version: string | null = null;

  /** Alarm 异步上报（如 $H 撞限位）。上层用于恢复路径与 UI 提示。 */
  public onalarm: (code: number, raw: string) => void = () => {};

  private commandQueue: QueueEntry[] = [];
  private outstandingBytes = 0;
  /** 队列被清空后的沉降期截止时间戳；期间孤儿 ok/error 丢弃 */
  private settleUntil = 0;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private statusWaiters: ((s: GrblStatus) => void)[] = [];
  private bannerWaiter: ((b: { version: string; kind: FirmwareKind }) => void) | null = null;
  private closed = false;
  private writer: WritableStreamDefaultWriter<Uint8Array>;

  public constructor(port: SerialPortLike, options: GrblOptions = {}) {
    this.port = port;
    this.rxBufferSize = options.rxBufferSize ?? 128;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 15000;
    this.settleMs = options.settleMs ?? 500;
    this.writer = port.writable.getWriter();

    let buffer = "";
    void port.readable
      .pipeThrough(new TextDecoderStream() as TransformStream<Uint8Array, string>)
      .pipeTo(
        new WritableStream({
          write: (chunk) => {
            buffer += chunk;
            const parts = buffer.split(/[\r\n]+/);
            buffer = parts.pop() || "";
            for (const part of parts) {
              if (part.trim() === "") continue;
              this.handleLine(part.trim());
            }
          },
        }),
      )
      .then(
        () => {
          // 读流正常关闭同样是断连（USB 拔出时 node-serialport 的读迭代器
          // 以 done 结束，不抛错）——与出错路径同等处置。
          this.handlePortDeath(new Error("GRBL read stream closed (device disconnected)"));
        },
        (error: Error & { code?: string }) => {
          // 读流失败（含正常断连的 premature close）：中止全部挂起命令。
          if (error?.code !== "ERR_STREAM_PREMATURE_CLOSE") {
            console.error(`[bit2atomplotgrbl] GRBL read stream error: ${error.message}`);
          }
          this.handlePortDeath(new Error(`GRBL read stream closed: ${error.message}`));
        },
      );
  }

  /** 连接意外丢失标记（读流关闭/错误且非主动 close）。置位后新命令立即失败。 */
  private lostConnection = false;

  /** 握手是否已完成。未完成时端口死亡属探测预期路径（波特率不对/非 GRBL
   * 端口），静默处置——不刷「connection lost」噪音日志。 */
  private handshakeComplete = false;

  /** 连接是否已意外丢失（USB 拔出/串口错误）；执行层据此快速失败不空等超时。 */
  public get connectionLost(): boolean {
    return this.lostConnection;
  }

  /** 断连上报（USB 拔出/串口错误）。上层用于中止绘制并通知 UI。 */
  public ondisconnect: (err: Error) => void = () => {};

  private handlePortDeath(err: Error): void {
    // 主动 close() 引发的读流结束不算断连
    if (this.closed || this.lostConnection) return;
    this.lostConnection = true;
    // 探测路径（握手未完成）：端口本就可能不是 GRBL 设备，死亡是预期结果，
    // 静默处置；上层 detectBaudRate/GrblController.connect 已按失败处理。
    if (!this.handshakeComplete) return;
    console.error(`[bit2atomplotgrbl] GRBL connection lost: ${err.message}`);
    this.abortPending(err);
    this.ondisconnect(err);
  }

  // ---- 行处理状态机 ----

  private handleLine(line: string): void {
    // 状态报告：异步应答 `?`，不入应答队列
    if (line.startsWith("<")) {
      const status = parseGrblStatus(line);
      if (status) {
        const waiter = this.statusWaiters.shift();
        if (waiter) waiter(status);
      }
      return;
    }

    // 握手横幅（可能先于/后于换行到达）
    const banner = parseBanner(line);
    if (banner && this.bannerWaiter) {
      this.firmwareKind = banner.kind;
      this.version = banner.version;
      const w = this.bannerWaiter;
      this.bannerWaiter = null;
      w(banner);
      return;
    }

    if (line === "ok" || line.startsWith("error")) {
      // 沉降期内的孤儿应答：队列已被 cancel() 清空，丢弃防止错位
      if (Date.now() < this.settleUntil) return;
      const entry = this.headSentEntry();
      if (!entry) {
        console.log(`unexpected data: ${line}`);
        return;
      }
      this.completeHead(entry, line === "ok" ? null : new Error(describeGrblError(line)));
      return;
    }

    if (line.startsWith("ALARM:")) {
      const code = Number(line.slice(6));
      const alarmCode = Number.isFinite(code) ? code : -1;
      this.onalarm(alarmCode, line);
      // Alarm 后挂起命令永无应答（GRBL 已终止运动且不再回 ok，如运动中
      // 的 $H / planner 内的 G-code）：立即清队列并以告警原因拒绝，防止
      // 调用方空等 15s 超时；沉降期丢弃随后的孤儿应答。
      this.abortPending(new Error(`设备告警 ${line}：${describeGrblAlarm(alarmCode)}`));
      return;
    }

    // 其余行（[MSG:]/[VER:]/[OPT:]/$$ 的 key=value 等）交给头部条目消费
    const entry = this.headSentEntry();
    if (entry?.onLine?.(line)) return;
    console.log(`unexpected data: ${line}`);
  }

  /** 最先已发送、未应答的条目（应答严格按入队顺序） */
  private headSentEntry(): QueueEntry | null {
    for (const e of this.commandQueue) {
      if (e.sent) return e;
    }
    return null;
  }

  private completeHead(entry: QueueEntry, error: Error | null): void {
    const idx = this.commandQueue.indexOf(entry);
    this.commandQueue.splice(idx, 1);
    this.outstandingBytes -= entry.bytes;
    if (entry.timer) clearTimeout(entry.timer);
    if (error) entry.reject(error);
    else entry.resolve();
    this.sendNext();
  }

  // ---- 发送与流控 ----

  private write(str: string): Promise<void> {
    return this.writer.write(new TextEncoder().encode(str)).catch((err) => {
      // 写失败意味着流已损坏（USB 故障等）：后续写入只会持续报错，
      // 立即中止全部挂起命令让上层走断连恢复路径。
      console.error(`[bit2atomplotgrbl] GRBL serial write failed: ${(err as Error).message}`);
      this.abortPending(err as Error);
    });
  }

  /** 尽量把队首起连续未发送的行送入窗口（严格 FIFO）。 */
  private sendNext(): void {
    if (this.closed) return;
    if (Date.now() < this.settleUntil) {
      // 沉降期未过：暂缓发送，到期后重试
      if (this.settleTimer == null) {
        this.settleTimer = setTimeout(() => {
          this.settleTimer = null;
          this.sendNext();
        }, this.settleUntil - Date.now() + 10);
      }
      return;
    }
    for (const entry of this.commandQueue) {
      if (entry.sent) continue;
      if (this.outstandingBytes + entry.bytes > this.rxBufferSize) break;
      entry.sent = true;
      this.outstandingBytes += entry.bytes;
      void this.write(`${entry.line}\n`);
    }
  }

  // ---- 对外 API ----

  /**
   * 启动握手：发送 `\r\n\r\n` 唤醒控制器并等待版本横幅。
   * 失败（无横幅）通常意味着波特率不对，调用方可换档重试（detectBaudRate）。
   */
  public async handshake(timeoutMs = 3000): Promise<void> {
    // 先挂横幅等待者再发唤醒字节：设备应答可能在唤醒写入的 promise 链
    // 完成前就被读管线消费（快速/虚拟设备均有此竞态），晚挂等待者会
    // 把横幅当 unexpected data 丢弃，导致握手超时。
    const banner = await new Promise<{ version: string; kind: FirmwareKind }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.bannerWaiter = null;
        reject(new Error(`GRBL handshake timed out after ${timeoutMs}ms (no version banner)`));
      }, timeoutMs);
      // 包装 resolve 以清除定时器
      this.bannerWaiter = (b) => {
        clearTimeout(timer);
        resolve(b);
      };
      void this.write("\r\n\r\n");
    });
    // 横幅后的初始 ok（对唤醒换行的应答）由沉降机制之外自然丢弃——
    // 此时队列为空，handleLine 走 "unexpected data" 分支，无副作用。
    this.handshakeComplete = true;
    console.log(`[bit2atomplotgrbl] GRBL ${banner.kind} v${banner.version} detected`);
  }

  /**
   * 发送一行命令并等待 `ok`；`error:N` reject。
   * onLine 用于收集该命令执行期间的头部位消息行（queryM）。
   */
  public run(line: string, timeoutMs = this.defaultTimeoutMs, onLine?: (line: string) => boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.lostConnection) {
        reject(new Error(`GRBL connection lost, command '${line}' not sent`));
        return;
      }
      const bytes = line.length + 1;
      if (bytes > this.rxBufferSize) {
        reject(
          new Error(
            `GRBL line exceeds RX buffer: ${bytes} > ${this.rxBufferSize} chars. Split long lines.`,
          ),
        );
        return;
      }
      const entry: QueueEntry = {
        line,
        bytes,
        resolve,
        reject,
        timer: null,
        sent: false,
        onLine,
      };
      entry.timer = setTimeout(() => {
        // 超时：清空队列（含本条）并进入沉降期。迟到的应答按孤儿丢弃，
        // 后续命令不会被错位应答污染（与 EBB 纪律一致）。
        this.cancel();
        reject(new Error(`GRBL command '${line}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.commandQueue.push(entry);
      this.sendNext();
    });
  }

  /** 发送查询命令，收集 `[...]`/key=value 行直到 `ok`。 */
  public async queryM(line: string, timeoutMs = this.defaultTimeoutMs): Promise<string[]> {
    const collected: string[] = [];
    await this.run(line, timeoutMs, (l) => {
      collected.push(l);
      return true;
    });
    return collected;
  }

  /** 实时命令（`?` `!` `~` 0x18）：不排队、不占窗口。 */
  public sendRealTime(cmd: string): void {
    if (!["?", "!", "~", "\x18", "\x84", "\x85", "\x86", "\x87"].includes(cmd)) {
      throw new Error(`Not a real-time command: ${JSON.stringify(cmd)}`);
    }
    void this.write(cmd);
  }

  /** `?` 实时状态查询 */
  public statusReport(timeoutMs = 2000): Promise<GrblStatus> {
    return new Promise<GrblStatus>((resolve, reject) => {
      if (this.lostConnection) {
        reject(new Error("GRBL connection lost, status report unavailable"));
        return;
      }
      const waiter = (s: GrblStatus) => {
        clearTimeout(timer);
        resolve(s);
      };
      const timer = setTimeout(() => {
        const idx = this.statusWaiters.indexOf(waiter);
        if (idx >= 0) this.statusWaiters.splice(idx, 1);
        reject(new Error(`GRBL status report timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.statusWaiters.push(waiter);
      this.sendRealTime("?");
    });
  }

  /** `$$` 全量参数读取 */
  public async querySettings(timeoutMs = this.defaultTimeoutMs): Promise<Record<string, string>> {
    const lines = await this.queryM("$$", timeoutMs);
    const settings: Record<string, string> = {};
    for (const l of lines) {
      const idx = l.indexOf("=");
      if (idx > 0) settings[l.slice(0, idx)] = l.slice(idx + 1);
    }
    return settings;
  }

  /** `$I` 固件信息（[VER:]/[OPT:]/[FIRMWARE:]） */
  public async queryInfo(timeoutMs = this.defaultTimeoutMs): Promise<GrblInfo> {
    const lines = await this.queryM("$I", timeoutMs);
    const info: GrblInfo = { version: null, firmwareKind: "unknown", options: null, lines };
    for (const l of lines) {
      if (l.startsWith("[VER:")) info.version = l.slice(5, -1);
      else if (l.startsWith("[OPT:")) info.options = l.slice(5, -1);
      else if (l.startsWith("[FIRMWARE:")) {
        const fw = l.slice(10, -1).toLowerCase();
        info.firmwareKind = fw.includes("grblhal") ? "grblhal" : "unknown";
      }
    }
    // grblHAL 可能伪装经典横幅，[FIRMWARE:] 判型优先（调研结论）
    if (info.firmwareKind === "unknown" && this.firmwareKind !== "unknown") {
      info.firmwareKind = this.firmwareKind;
    }
    return info;
  }

  /** 清空命令队列并 reject 全部挂起命令；随后等沉降期让孤儿应答排空。 */
  public cancel(): void {
    const hadPending = this.commandQueue.length > 0;
    if (hadPending) {
      this.settleUntil = Date.now() + this.settleMs;
    }
    for (const e of this.commandQueue) {
      if (e.timer) clearTimeout(e.timer);
      e.reject(new Error("Cancelled"));
    }
    this.commandQueue = [];
    this.outstandingBytes = 0;
  }

  private abortPending(err: Error): void {
    const hadPending = this.commandQueue.length > 0;
    if (hadPending) {
      this.settleUntil = Date.now() + this.settleMs;
    }
    for (const e of this.commandQueue) {
      if (e.timer) clearTimeout(e.timer);
      e.reject(err);
    }
    this.commandQueue = [];
    this.outstandingBytes = 0;
  }

  public async close(): Promise<void> {
    this.closed = true;
    this.cancel();
    return await this.port.close();
  }

  /** 测试/诊断：当前占用窗口字节数 */
  public get usedWindow(): number {
    return this.outstandingBytes;
  }
}

/**
 * 波特率探测：逐档打开串口并握手，首个握手成功的档位即为设备波特率
 * （GRBL 波特率为编译期属性，档案未命中时按档位轮询并回填）。
 * makePort(baud) 打开一个新串口连接；探测失败须由工厂自行关闭。
 */
export async function detectBaudRate(
  makePort: (baud: number) => Promise<{ port: SerialPortLike; close(): Promise<void> }>,
  rates: number[] = [115200, 9600, 57600, 230400, 250000],
  handshakeTimeoutMs = 3000,
): Promise<{ baud: number; grbl: Grbl } | null> {
  for (const baud of rates) {
    let conn: { port: SerialPortLike; close(): Promise<void> } | null = null;
    try {
      conn = await makePort(baud);
      const grbl = new Grbl(conn.port);
      await grbl.handshake(handshakeTimeoutMs);
      return { baud, grbl };
    } catch {
      await conn?.close().catch(() => {});
    }
  }
  return null;
}
