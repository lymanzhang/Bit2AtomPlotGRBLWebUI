import { describe, expect, test, vi } from "vitest";
import {
  type GrblStatus,
  Grbl,
  describeGrblAlarm,
  describeGrblError,
  detectBaudRate,
  parseBanner,
  parseGrblStatus,
} from "../grbl.js";
import { MockGrblPort } from "./mocks/grbl-port.js";

/**
 * GRBL 行协议层测试（任务 2.1）：
 * 横幅/状态解析、ok/error 匹配、字符计数流控窗口、孤儿应答沉降丢弃、
 * 写失败中止、状态查询、$$/$I 解析、波特率探测。
 */

async function makeGrbl(opts?: ConstructorParameters<typeof Grbl>[1]) {
  const port = new MockGrblPort();
  const grbl = new Grbl(port, opts);
  await grbl.handshake(200);
  return { grbl, port };
}

describe("parseBanner / parseGrblStatus", () => {
  test("横幅解析：经典 GRBL 1.1 / 0.9 / grblHAL", () => {
    expect(parseBanner("Grbl 1.1h ['$' for help]")).toEqual({ version: "1.1", kind: "grbl-1.1" });
    expect(parseBanner("Grbl 0.9j ['$' for help]")).toEqual({ version: "0.9", kind: "grbl-0.9" });
    expect(parseBanner("GrblHAL 1.1 ['$' for help]")).toEqual({ version: "1.1", kind: "grblhal" });
    expect(parseBanner("ok")).toBeNull();
    expect(parseBanner("<Idle|MPos:0,0,0>")).toBeNull();
  });

  test("状态解析：v1.1 报文（WPos/FS/Buf/Pn/Hold 子码）", () => {
    const s = parseGrblStatus("<Hold:1|WPos:1.000,2.000,0.500|FS:300,12000|Buf:20|Pn:XYZ>") as GrblStatus;
    expect(s.state).toBe("Hold");
    expect(s.substate).toBe(1);
    expect(s.wpos).toEqual({ x: 1, y: 2, z: 0.5 });
    expect(s.mpos).toBeUndefined();
    expect(s.feed).toBe(300);
    expect(s.spindle).toBe(12000);
    expect(s.buf).toBe(20);
    expect(s.pins).toBe("XYZ");
  });

  test("状态解析：v0.9 报文（MPos + F）", () => {
    const s = parseGrblStatus("<Run|MPos:10.0,20.0,0.0|F:800>") as GrblStatus;
    expect(s.state).toBe("Run");
    expect(s.mpos).toEqual({ x: 10, y: 20, z: 0 });
    expect(s.wpos).toBeUndefined();
    expect(s.feed).toBe(800);
    expect(s.spindle).toBeUndefined();
  });
});

describe("握手与应答匹配", () => {
  test("握手：唤醒后收到横幅并判型", async () => {
    const port = new MockGrblPort();
    const grbl = new Grbl(port);
    await grbl.handshake(200);
    expect(grbl.version).toBe("1.1");
    expect(grbl.firmwareKind).toBe("grbl-1.1");
    expect(port.received).toContain("");
  });

  test("握手超时：无横幅时 reject（用于波特率轮询）", async () => {
    const port = new MockGrblPort();
    port.banner = false;
    const grbl = new Grbl(port);
    await expect(grbl.handshake(50)).rejects.toThrow("handshake timed out");
  });

  test("run(): ok 应答 resolve，error:N 应答 reject", async () => {
    const { grbl, port } = await makeGrbl({ defaultTimeoutMs: 500 });
    await grbl.run("G21");
    expect(port.received).toContain("G21");
    // 手工脚本：设备对下一行回 error:9
    port.autoOk = false;
    const p = grbl.run("G1 X999999");
    await vi.waitFor(() => expect(port.received).toContain("G1 X999999"));
    port.pushToHost("error:9");
    await expect(p).rejects.toThrow(/^error/);
  });

  test("run(): 超行 RX 缓冲区的命令直接拒绝且不发送", async () => {
    const { grbl } = await makeGrbl({ rxBufferSize: 32 });
    const long = "G1 " + "X1 ".repeat(20); // 60 chars > 32
    await expect(grbl.run(long)).rejects.toThrow("exceeds RX buffer");
    expect(grbl.usedWindow).toBe(0);
  });
});

describe("字符计数流控窗口", () => {
  test("窗口满时停止发送，ok 回收额度", async () => {
    const { grbl, port } = await makeGrbl({ rxBufferSize: 32, defaultTimeoutMs: 500 });
    port.autoOk = false;
    // 每行占 6 字节（5+1）：32 字节窗口最多容纳 5 行
    const lines = ["G0 X1", "G0 X2", "G0 X3", "G0 X4", "G0 X5", "G0 X6"];
    // catch 常态化：任何路径下的 rejection 都有接管方，避免 unhandled
    const pending: Promise<string | undefined>[] = lines.map((l) =>
      grbl.run(l).then(
        () => undefined,
        (e: Error) => e.message,
      ),
    );
    await vi.waitFor(() =>
      expect(port.received.filter((l) => l.startsWith("G0")).length).toBe(5),
    );
    expect(grbl.usedWindow).toBe(30); // 5 行 × 6

    // 逐条 ack：额度回收后第 6 行进入窗口（3 未应答 + 新发 1 = 24）
    port.pushToHost("ok");
    port.pushToHost("ok");
    await vi.waitFor(() =>
      expect(port.received.filter((l) => l.startsWith("G0")).length).toBe(6),
    );
    await vi.waitFor(() => expect(grbl.usedWindow).toBe(24)); // 4 行 × 6

    // 全部 ack 后队列清零、全部成功
    for (let i = 0; i < 4; i++) port.pushToHost("ok");
    const results = await Promise.all(pending);
    expect(results.every((r) => r === undefined)).toBe(true);
    expect(grbl.usedWindow).toBe(0);
  });

  test("实时命令不占窗口、不排队", async () => {
    const { grbl, port } = await makeGrbl({ rxBufferSize: 32 });
    port.autoOk = false;
    grbl.sendRealTime("?");
    expect(grbl.usedWindow).toBe(0);
    expect(port.received).toContain("?");
  });

  test("RX=128 默认窗口边界：127 字符（+换行=128）恰好入窗发送，128 拒绝", async () => {
    const { grbl, port } = await makeGrbl(); // 缺省 rxBufferSize = 128
    const boundary = "G1 " + "X".repeat(124); // 127 chars + 1 newline = 128
    const pending = grbl.run(boundary);
    await vi.waitFor(() => expect(port.received.filter((l) => l.startsWith("G1")).length).toBe(1));
    port.pushToHost("ok");
    await expect(pending).resolves.toBeUndefined();

    const over = boundary + "Y"; // 128 chars + 1 newline = 129 > 128
    await expect(grbl.run(over)).rejects.toThrow("exceeds RX buffer");
  });
});

describe("状态查询与信息解析", () => {
  test("statusReport(): 解析 <Idle|...> 报文", async () => {
    const { grbl } = await makeGrbl();
    const status = await grbl.statusReport(500);
    expect(status.state).toBe("Idle");
    expect(status.wpos).toEqual({ x: 1, y: 2, z: 0 });
  });

  test("querySettings(): $$ 全量解析", async () => {
    const { grbl } = await makeGrbl();
    const settings = await grbl.querySettings(500);
    expect(settings["110"]).toBe("8000.000");
    expect(settings.$13).toBe("0");
  });

  test("queryInfo(): $I 解析版本/编译选项", async () => {
    const { grbl } = await makeGrbl();
    const info = await grbl.queryInfo(500);
    expect(info.version).toBe("v1.1h.20190825:");
    expect(info.options).toBe("V,15,128");
    expect(info.firmwareKind).toBe("grbl-1.1"); // 横幅判型回填
  });
});

describe("取消与沉降期", () => {
  test("cancel(): 挂起命令 reject，沉降期内孤儿 ok 被丢弃", async () => {
    const { grbl, port } = await makeGrbl({ rxBufferSize: 128, settleMs: 60 });
    port.autoOk = false;
    const first = grbl.run("G0 X1");
    await vi.waitFor(() => expect(grbl.usedWindow).toBe(6));
    const cancelP = first.catch((e: Error) => e);
    grbl.cancel();
    expect(((await cancelP) as Error).message).toBe("Cancelled");

    // 沉降期内立刻发新命令：发送被推迟到沉降期结束后
    const second = grbl.run("G0 X2", 2000);
    // 沉降期内推送孤儿 ok —— 不得错位完成第二条命令
    port.pushToHost("ok");
    port.pushToHost("ok");
    await new Promise((r) => setTimeout(r, 120)); // 越过沉降期
    // 此刻 G0 X2 已进入窗口，随后的 ok 才是它的应答
    await vi.waitFor(() => expect(port.received).toContain("G0 X2"));
    port.pushToHost("ok");
    await expect(second).resolves.toBeUndefined();
  });

  test("写失败：全部挂起命令 reject", async () => {
    const { grbl, port } = await makeGrbl({ rxBufferSize: 128 });
    port.autoOk = false;
    port.failWrites = true;
    // 注意：第一行可能已在 failWrites 前发出？写入是同步触发 write 回调，
    // 设为 true 后所有新写入都失败。
    const p1 = grbl.run("G0 X1").catch((e: Error) => e);
    await expect(p1).resolves.toMatchObject({ message: /GetOverlappedResult/ });
  });
});

describe("Alarm 与 error 分类（3.5）", () => {
  test("describeGrblError：保留 error:N 前缀并附加中文描述", () => {
    expect(describeGrblError("error:9")).toContain("Alarm/点动状态下");
    expect(describeGrblError("error:5")).toContain("归位未启用");
    expect(describeGrblError("error:99")).toBe("error:99"); // 未知码原样
    expect(describeGrblError("ok")).toBe("ok");
  });

  test("describeGrblAlarm：官方码描述与未知码兜底", () => {
    expect(describeGrblAlarm(1)).toContain("硬限位");
    expect(describeGrblAlarm(2)).toContain("软限位");
    expect(describeGrblAlarm(9)).toContain("归位失败");
    expect(describeGrblAlarm(99)).toContain("99");
  });

  test("run(): error:N 应答映射为用户可读错误（前缀不变）", async () => {
    const { grbl, port } = await makeGrbl({ defaultTimeoutMs: 500 });
    port.autoOk = false;
    const p = grbl.run("G1 X999999");
    await vi.waitFor(() => expect(port.received).toContain("G1 X999999"));
    port.pushToHost("error:9");
    await expect(p).rejects.toThrow(/^error:9（/);
    await expect(p).rejects.toThrow(/Alarm\/点动状态下/);
  });

  test("ALARM: 行触发 onalarm 并以告警原因中止全部挂起命令", async () => {
    const { grbl, port } = await makeGrbl({ rxBufferSize: 128 });
    port.autoOk = false;
    const alarms: number[] = [];
    grbl.onalarm = (code) => alarms.push(code);
    const pending = [
      grbl.run("G0 X1").catch((e: Error) => e),
      grbl.run("G0 X2").catch((e: Error) => e),
    ];
    await vi.waitFor(() => expect(grbl.usedWindow).toBe(12));
    port.pushToHost("ALARM:1");
    const [e1, e2] = await Promise.all(pending);
    expect(alarms).toEqual([1]);
    expect(e1.message).toContain("ALARM:1");
    expect(e1.message).toContain("硬限位");
    expect(e2.message).toContain("ALARM:1");
    // 队列立即清空，不再空等 15s 超时
    expect(grbl.usedWindow).toBe(0);
  });
});

describe("波特率探测", () => {
  test("逐档轮询：首档失败、次档成功", async () => {
    const tried: number[] = [];
    const makePort = async (baud: number) => {
      tried.push(baud);
      const port = new MockGrblPort();
      if (baud === 115200) {
        port.banner = false; // 首档：死端口（波特率不对，无横幅）
      }
      return {
        port,
        close: async () => {},
      };
    };
    const result = await detectBaudRate(makePort, [115200, 9600], 50);
    expect(tried).toEqual([115200, 9600]);
    expect(result?.baud).toBe(9600);
    expect(result?.grbl.firmwareKind).toBe("grbl-1.1");
  });

  test("全部档位失败时返回 null", async () => {
    const makePort = async () => {
      const port = new MockGrblPort();
      port.banner = false;
      return { port, close: async () => {} };
    };
    expect(await detectBaudRate(makePort, [115200], 30)).toBeNull();
  });
});
