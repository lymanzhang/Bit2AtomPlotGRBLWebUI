/**
 * GrblSimulator：无硬件虚拟 GRBL 设备（任务 2.5）。
 *
 * 实现 SerialPortLike，可直接接入 Grbl 协议层 / GrblController：
 * - 消费 G-code 行：planner 有空槽即回 `ok`（「planner 接受」语义）；planner
 *   满时运动行的 `ok` 延迟到有动作完成腾出槽位（与真实 GRBL 一致，主机
 *   最多领先设备约 plannerDepth 条动作），随后按进给速度虚拟计时执行，
 *   `?` 依虚拟运动状态回报 `<Idle|Run|Hold:0|Alarm|WPos:..|FS:..>`（WPos
 *   插值到当前时刻）。
 * - real-time 命令：`?` 状态、`!` 进给保持（冻结当前运动）、`~` 恢复、
 *   0x18 软复位（清空 planner 并重发横幅）。
 * - `$` 命令：`$$` 参数转储、`$N=value` 参数写入（EEPROM 模拟）、`$I` 固件
 *   信息、`$H` 归位（清 Alarm、坐标归零）、`$X` 解锁；未知 `$` 命令回 error:9。
 * - `timeScale` 缩放虚拟时间：1 = 实时；0.01 = 100 倍速（测试观察
 *   Run/Hold 状态转换）；极小值近似即时完成。
 * - 触发 Alarm：`triggerAlarm()`（阶段三 3.5 恢复路径测试用），Alarm 下
 *   运动行回 error:9，`$H`/`$X` 解除。
 *
 * 保真度取舍：不支持 G2/G3 圆弧（回 error，宁可响亮失败也不静默跳过）；
 * G0 速率合成取移动轴最大速率的较大值（忽略按轴分量限速）；无 MPos/G28
 * 偏置（WPos 即机床坐标）。
 */

import { type SerialPortLike } from "./grbl.js";

export interface GrblSimulatorOptions {
  /** 版本横幅（默认 "Grbl 1.1h ['$' for help]"） */
  banner?: string;
  /** 最大速率 $110/$111/$112（mm/min，默认 8000/8000/500） */
  maxRateMmMin?: { x?: number; y?: number; z?: number };
  /** 步/mm $100/$101/$102（默认 80/80/400，对应默认档案：XY 5 全步 ×16 细分、
   * Z 丝杆 25 全步 ×16 细分；供参数助手对照测试） */
  stepsPerMm?: { x?: number; y?: number; z?: number };
  /** 虚拟时间倍率：1 = 实时，0.01 = 100 倍速 */
  timeScale?: number;
  /** planner 深度（未执行完的运动动作上限，模拟真实 GRBL 的 16-17 条） */
  plannerDepth?: number;
}

interface VMove {
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  /** 生效进给（G0 = 移动轴最大速率合成；G1 = 模态 F） */
  feedMmMin: number;
  distanceMm: number;
  /** 实际时长 ms（已含 timeScale） */
  durationMs: number;
  /** 实际开始时间戳（暂停恢复后回拨） */
  startMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Hold 冻结的已进行 ms；null = 未暂停 */
  heldElapsedMs: number | null;
}

const EPS = 1e-9;
const fmt = (n: number) => n.toFixed(3);

/** 最近创建的模拟器实例。测试钩子：server 以 sim 驱动启动时模拟器在
 * connectGrblDevice 内部创建，测试经此获取句柄注入 Alarm（3.5）。 */
export let lastSimulator: GrblSimulator | null = null;

export class GrblSimulator implements SerialPortLike {
  public readable: ReadableStream<Uint8Array>;
  public writable: WritableStream<Uint8Array>;

  public bannerLine: string;
  public maxRates: { x: number; y: number; z: number };
  public stepsPerMm: { x: number; y: number; z: number };
  public timeScale: number;
  public plannerDepth: number;
  /** `$N=value` 写入的参数覆盖（EEPROM 模拟）；`$$` 转储时优先取覆盖值 */
  private settingOverrides = new Map<number, number>();

  /** 虚拟工作坐标（WPos，已提交的完成位置） */
  public wpos = { x: 0, y: 0, z: 0 };
  public state: "Idle" | "Run" | "Hold" | "Alarm" = "Idle";
  /** 模态进给 F（mm/min）；G1 前未设定时运动行回 error */
  public modalFeedMmMin = 0;
  private modalMotion: "G0" | "G1" = "G1";
  private active: VMove | null = null;
  private pending: VMove[] = [];
  /** planner 满时被阻塞的运动行（等待槽位腾出，ok 延迟发送） */
  private blocked: VMove[] = [];
  /** planner 链式末端：最后一条已接受（未必执行完）动作的终点。运动行
   * 的起止点在入队时刻按链确定（前一动作的终点 = 本动作起点），与真实
   * GRBL planner 一致——主机流水线下发时 wpos 仍停在已完成位置，直接
   * 快照 wpos 会把后续动作的坐标链回旧值（如抬笔 Z 随后被 G0 清零）。 */
  private queuedPos = { x: 0, y: 0, z: 0 };
  private greeted = false;
  private closed = false;
  private lineBuf = "";
  private controller: ReadableStreamDefaultController<Uint8Array>;

  public constructor(options: GrblSimulatorOptions = {}) {
    lastSimulator = this;
    this.bannerLine = options.banner ?? "Grbl 1.1h ['$' for help]";
    this.maxRates = { x: 8000, y: 8000, z: 500, ...(options.maxRateMmMin ?? {}) };
    this.stepsPerMm = { x: 80, y: 80, z: 400, ...(options.stepsPerMm ?? {}) };
    this.timeScale = options.timeScale ?? 1;
    this.plannerDepth = options.plannerDepth ?? 16;

    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        const text = new TextDecoder().decode(chunk);
        // 逐字符处理：real-time 单字符（?/!~/0x18）可在行中间插入，
        // 不受行缓冲影响（与真实 GRBL 行为一致）。
        for (const ch of text) {
          if (this.closed) return;
          if (ch === "\x18") {
            this.softReset();
          } else if (ch === "?") {
            this.pushToHost(this.statusLine());
          } else if (ch === "!") {
            this.hold();
          } else if (ch === "~") {
            this.resume();
          } else if (ch === "\n" || ch === "\r") {
            this.flushLine();
          } else {
            this.lineBuf += ch;
          }
        }
      },
    });
  }

  /** 虚拟设备向主机发送一行 */
  public pushToHost(line: string): void {
    this.controller.enqueue(new TextEncoder().encode(`${line}\r\n`));
  }

  /** 注入 Alarm（限位触发模拟）：中止当前运动并上报 */
  public triggerAlarm(code: number): void {
    this.state = "Alarm";
    this.dropAllMoves();
    this.pushToHost(`ALARM:${code}`);
  }

  /** 清空运动队列与计时器（软复位/Alarm 中止共用）；被阻塞行随 planner
   * 一起丢弃，不发 ok（与真实 GRBL 复位语义一致，主机侧由 cancel 沉降期
   * 丢弃这些条目）。 */
  private dropAllMoves(): void {
    if (this.active?.timer) clearTimeout(this.active.timer);
    for (const m of this.pending) if (m.timer) clearTimeout(m.timer);
    this.active = null;
    this.pending = [];
    this.blocked = [];
    // planner 被清空：链式末端回退到已完成位置（队列中未执行的动作一并丢弃）
    this.queuedPos = { ...this.wpos };
  }

  /** 停止虚拟运动（测试 teardown 用；串口仍可用） */
  public stop(): void {
    this.dropAllMoves();
    this.state = this.state === "Alarm" ? "Alarm" : "Idle";
  }

  public close(): Promise<void> {
    this.closed = true;
    this.stop();
    return Promise.resolve();
  }

  // ---- 行处理 ----

  private flushLine(): void {
    const line = this.lineBuf.trim();
    this.lineBuf = "";
    if (line === "") {
      // 唤醒换行（\r\n\r\n）与复位后重发横幅；其余空行忽略
      if (!this.greeted) {
        this.greeted = true;
        this.pushToHost(this.bannerLine);
      }
      return;
    }
    if (line.startsWith("$")) {
      this.handleDollar(line);
      return;
    }
    this.handleGcode(line);
  }

  private handleDollar(line: string): void {
    // $N=value 参数写入（EEPROM 模拟）：Alarm 下拒绝，与真实 GRBL 一致
    const writeMatch = line.match(/^\$(\d+)\s*=\s*(-?(?:\d+\.?\d*|\.\d+))$/);
    if (writeMatch) {
      if (this.state === "Alarm") {
        this.pushToHost("error:9");
        return;
      }
      this.settingOverrides.set(Number(writeMatch[1]), Number(writeMatch[2]));
      this.pushToHost("ok");
      return;
    }
    if (line === "$$") {
      // 步/mm：覆盖值优先（写入后即刻反映到转储）
      const spm = (axis: "x" | "y" | "z", num: number) => this.settingOverrides.get(num) ?? this.stepsPerMm[axis];
      this.pushToHost(`100=${fmt(spm("x", 100))}`);
      this.pushToHost(`101=${fmt(spm("y", 101))}`);
      this.pushToHost(`102=${fmt(spm("z", 102))}`);
      this.pushToHost(`110=${fmt(this.settingOverrides.get(110) ?? this.maxRates.x)}`);
      this.pushToHost(`111=${fmt(this.settingOverrides.get(111) ?? this.maxRates.y)}`);
      this.pushToHost(`112=${fmt(this.settingOverrides.get(112) ?? this.maxRates.z)}`);
      this.pushToHost(`120=${fmt(this.settingOverrides.get(120) ?? 500)}`);
      this.pushToHost(`121=${fmt(this.settingOverrides.get(121) ?? 500)}`);
      this.pushToHost(`122=${fmt(this.settingOverrides.get(122) ?? 100)}`);
      // 3.6 软限位协同：$20 开关与 $130/$131 行程（默认关闭；行程默认
      // 430×300 与默认工作区一致，可经 $N=value 覆盖）
      this.pushToHost(`20=${this.settingOverrides.get(20) ?? 0}`);
      this.pushToHost(`130=${fmt(this.settingOverrides.get(130) ?? 430)}`);
      this.pushToHost(`131=${fmt(this.settingOverrides.get(131) ?? 300)}`);
      this.pushToHost("$13=0");
      this.pushToHost("ok");
      return;
    }
    if (line === "$I") {
      this.pushToHost("[VER:v1.1h.20190825:GRBLSIM]");
      this.pushToHost("[OPT:V,15,128]");
      this.pushToHost("ok");
      return;
    }
    if (line === "$H") {
      // 模拟归位：清空 planner（含未完成动作与链式末端）、清 Alarm、坐标
      // 归零。不清链式末端的话，$H 前已接受的抬笔动作会让后续同高度命令
      // 被判零距离跳过，而真实设备位置已被 $H 归零（笔不会抬起）。
      this.dropAllMoves();
      this.state = "Idle";
      this.wpos = { x: 0, y: 0, z: 0 };
      this.queuedPos = { x: 0, y: 0, z: 0 };
      this.pushToHost("ok");
      return;
    }
    if (line === "$X") {
      this.state = "Idle";
      this.pushToHost("ok");
      return;
    }
    this.pushToHost("error:9");
  }

  private handleGcode(line: string): void {
    if (this.state === "Alarm") {
      this.pushToHost("error:9");
      return;
    }
    const params = new Map<string, number>();
    for (const m of line.matchAll(/([A-Za-z])(-?(?:\d+\.?\d*|\.\d+))?/g)) {
      const letter = m[1].toUpperCase();
      if (m[2] != null) params.set(letter, Number(m[2]));
      else params.set(letter, NaN); // 无值字（如 M3、G90 后无参数也常见）
    }

    // 进给更新：单独 F 行 / 行内 F 字
    if (Number.isFinite(params.get("F"))) {
      this.modalFeedMmMin = params.get("F") as number;
    }

    const gWord = params.has("G") ? (params.get("G") as number) : null;
    if (gWord === 0 || gWord === 1) this.modalMotion = `G${gWord}` as "G0" | "G1";
    if (gWord === 2 || gWord === 3) {
      this.pushToHost("error:2"); // 模拟器不支持圆弧：响亮失败
      return;
    }

    const hasAxis = ["X", "Y", "Z"].some((a) => params.has(a));
    if (!hasAxis) {
      // 纯模式行（G21/G90/G54/M3/M5 等）：接受即可
      this.pushToHost("ok");
      return;
    }

    const from = { ...this.queuedPos };
    const to = {
      x: Number.isFinite(params.get("X")) ? (params.get("X") as number) : from.x,
      y: Number.isFinite(params.get("Y")) ? (params.get("Y") as number) : from.y,
      z: Number.isFinite(params.get("Z")) ? (params.get("Z") as number) : from.z,
    };
    const distanceMm = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);

    let feedMmMin: number;
    if (this.modalMotion === "G0") {
      // G0：移动轴最大速率取较大值（保真度取舍见文件头注释）
      const axes: ("x" | "y" | "z")[] = [];
      if (Math.abs(to.x - from.x) > EPS) axes.push("x");
      if (Math.abs(to.y - from.y) > EPS) axes.push("y");
      if (Math.abs(to.z - from.z) > EPS) axes.push("z");
      feedMmMin = axes.length === 0 ? 0 : Math.max(...axes.map((a) => this.maxRates[a]));
    } else {
      if (this.modalFeedMmMin <= 0) {
        this.pushToHost("error:9"); // G1 前未设定 F
        return;
      }
      feedMmMin = this.modalFeedMmMin;
    }

    if (distanceMm <= EPS || feedMmMin <= 0) {
      this.pushToHost("ok"); // 零距离运动不占 planner 槽位，直接接受
      return;
    }

    const durationMs = (distanceMm / feedMmMin) * 60000 * this.timeScale;
    const move: VMove = {
      from,
      to,
      feedMmMin,
      distanceMm,
      durationMs,
      startMs: 0,
      timer: null,
      heldElapsedMs: null,
    };
    this.acceptMove(move);
  }

  /** planner 占用（执行中 + 待执行的动作数） */
  private plannerUsed(): number {
    return this.pending.length + (this.active ? 1 : 0);
  }

  /** 运动行接受：planner 有空槽即入队并回 ok；满则阻塞（ok 延迟到腾出槽位，
   * 对应真实 GRBL「planner 满 → 解析停住」语义，为主机提供背压）。 */
  private acceptMove(move: VMove): void {
    // 入队即确定链式末端（blocked 亦然：腾出槽位后按链继续）
    this.queuedPos = { ...move.to };
    if (this.plannerUsed() < this.plannerDepth) {
      this.enqueueMove(move);
      this.pushToHost("ok");
    } else {
      this.blocked.push(move);
    }
  }

  private enqueueMove(move: VMove): void {
    if (this.active || this.state === "Hold") {
      this.pending.push(move);
    } else {
      this.startMove(move);
    }
  }

  /** 动作完成腾出槽位后，按接收顺序放行被阻塞的运动行 */
  private flushBlocked(): void {
    while (
      this.blocked.length > 0 &&
      this.plannerUsed() < this.plannerDepth &&
      this.state !== "Alarm" &&
      !this.closed
    ) {
      const move = this.blocked.shift() as VMove;
      this.enqueueMove(move);
      this.pushToHost("ok");
    }
  }

  // ---- 虚拟运动执行 ----

  private startMove(move: VMove): void {
    move.startMs = Date.now();
    move.heldElapsedMs = null;
    this.state = "Run";
    this.active = move;
    move.timer = setTimeout(() => this.completeMove(move), move.durationMs);
  }

  private completeMove(move: VMove): void {
    move.timer = null;
    if (this.active === move) this.active = null;
    this.wpos = { ...move.to };
    if (this.pending.length > 0 && this.state !== "Hold" && !this.closed) {
      this.startMove(this.pending.shift() as VMove);
    } else if (this.state === "Run") {
      this.state = "Idle";
    }
    this.flushBlocked();
  }

  /** `!` 进给保持：冻结当前运动 */
  private hold(): void {
    if (this.state === "Alarm") return;
    if (this.active && this.active.heldElapsedMs == null) {
      const { timer } = this.active;
      if (timer) clearTimeout(timer);
      this.active.heldElapsedMs = Date.now() - this.active.startMs;
    }
    this.state = "Hold";
  }

  /** `~` 恢复 */
  private resume(): void {
    if (this.state !== "Hold") return;
    this.state = "Run";
    if (this.active?.heldElapsedMs != null) {
      const remaining = this.active.durationMs - this.active.heldElapsedMs;
      this.active.startMs = Date.now() - this.active.heldElapsedMs;
      this.active.heldElapsedMs = null;
      this.active.timer = setTimeout(() => this.completeMove(this.active as VMove), Math.max(0, remaining));
    } else if (!this.active && this.pending.length > 0) {
      this.startMove(this.pending.shift() as VMove);
    }
  }

  /** 0x18 软复位：清空 planner、回 Idle、重发横幅（位置保留） */
  private softReset(): void {
    this.dropAllMoves();
    this.state = "Idle";
    this.greeted = false;
    this.pushToHost(this.bannerLine);
  }

  /** 当前虚拟位置：运动中按时间插值，暂停/空闲取已提交位置 */
  private currentPos(): { x: number; y: number; z: number } {
    const m = this.active;
    if (m && this.state === "Run" && m.heldElapsedMs == null && m.durationMs > 0) {
      const t = Math.min(1, Math.max(0, (Date.now() - m.startMs) / m.durationMs));
      return {
        x: m.from.x + (m.to.x - m.from.x) * t,
        y: m.from.y + (m.to.y - m.from.y) * t,
        z: m.from.z + (m.to.z - m.from.z) * t,
      };
    }
    return this.wpos;
  }

  private statusLine(): string {
    const stateStr = this.state === "Hold" ? "Hold:0" : this.state;
    const p = this.currentPos();
    const feed = this.active && this.state === "Run" ? Math.round(this.active.feedMmMin) : 0;
    return `<${stateStr}|WPos:${fmt(p.x)},${fmt(p.y)},${fmt(p.z)}|FS:${feed},0>`;
  }
}
