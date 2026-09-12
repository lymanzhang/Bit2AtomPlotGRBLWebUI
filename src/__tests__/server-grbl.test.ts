import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import request from "supertest";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AxidrawFast, plan } from "../planning";
import { lastSimulator } from "../simulator";
import { startServer } from "../server";

/**
 * GRBL sim 全流程集成测试（任务 2.6）：driver = "sim" 时服务端接入内置
 * 虚拟 GRBL 设备，验证 /plot /cancel /home 端点与取消收尾路径。
 */

const SIMPLE_PLAN = plan([[{ x: 10, y: 10 }, { x: 20, y: 10 }]], AxidrawFast).serialize();
// 足够长的计划，保证取消能落在绘制中途
const MANY_PLAN = plan(
  Array.from({ length: 24 }, (_, i) => [{ x: 0, y: i * 10 }, { x: 100, y: i * 10 }]),
  AxidrawFast,
).serialize();

async function waitForPlottingComplete(server: Server, timeout = 20000): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const response = await request(server).get("/plot/status");
    if (!response.body.plotting) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 等待虚拟 GRBL 设备连接完成（/plot/status 新增 device 字段回报种类） */
async function waitForDevice(server: Server, timeout = 5000): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const response = await request(server).get("/plot/status");
    if (response.body.device === "grbl") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("GRBL simulator did not connect in time");
}

describe("GRBL sim driver", () => {
  let server: Server;

  beforeAll(async () => {
    server = await startServer(0, "", false, "200mb", "sim");
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("connects the virtual GRBL device", async () => {
    await waitForDevice(server);
  });

  test("plot completes on the virtual GRBL device", async () => {
    await request(server).post("/plot").send(SIMPLE_PLAN).expect(200);
    await waitForPlottingComplete(server);
    expect((await request(server).get("/plot/status")).body.plotting).toBe(false);
  }, 30000);

  test("rejects concurrent plot while plotting", async () => {
    await request(server).post("/plot").send(MANY_PLAN).expect(200);
    await request(server).post("/plot").send(SIMPLE_PLAN).expect(400);
    await request(server).post("/cancel").expect(200);
    await waitForPlottingComplete(server);
  }, 30000);

  test("cancel stops plotting and unlocks the device", async () => {
    await request(server).post("/plot").send(MANY_PLAN).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await request(server).post("/cancel").expect(200);
    await waitForPlottingComplete(server);
    expect((await request(server).get("/plot/status")).body.plotting).toBe(false);
    // 取消收尾后设备仍可用：再画一笔成功
    await request(server).post("/plot").send(SIMPLE_PLAN).expect(200);
    await waitForPlottingComplete(server);
  }, 40000);

  test("home endpoint works on GRBL", async () => {
    await request(server).post("/home").expect(200);
  }, 20000);
});

describe("GRBL pen position tracking (3.1)", () => {
  let server: Server;

  beforeAll(async () => {
    server = await startServer(0, "", false, "200mb", "sim");
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("position unknown after fresh start; /home seeds it via $H + WPos", async () => {
    await waitForDevice(server);
    // 服务重启后 lastPenPos 为 null，/plot/status 如实回报
    const status = await request(server).get("/plot/status");
    expect(status.body.penPosKnown).toBe(false);
    // 归位（$H）后经 WPos 回填，位置转为已知
    await request(server).post("/home").expect(200);
    expect((await request(server).get("/plot/status")).body.penPosKnown).toBe(true);
  }, 30000);

  test("pause/resume runs position verification and keeps tracking consistent", async () => {
    // 小型计划：模拟器按实时速率执行，须保证暂停落在绘制中途且总时长
    // 可控（MANY_PLAN 实时执行 90s+，不适合完整走完）
    const pausePlan = plan(
      Array.from({ length: 6 }, (_, i) => [{ x: 0, y: i * 5 }, { x: 30, y: i * 5 }]),
      AxidrawFast,
    ).serialize();
    await request(server).post("/plot").send(pausePlan).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await request(server).post("/pause").expect(200);
    // 暂停生效点会排空设备缓冲并做 WPos 双源校验（无漂移时不修正）
    await new Promise((resolve) => setTimeout(resolve, 300));
    await request(server).post("/resume").expect(200);
    await waitForPlottingComplete(server, 60000);
    const status = await request(server).get("/plot/status");
    expect(status.body.plotting).toBe(false);
    // 绘制收尾校验后位置已知，可供补画
    expect(status.body.penPosKnown).toBe(true);
  }, 70000);
});

describe("GRBL pause rewind (3.2)", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = await startServer(0, "", false, "200mb", "sim");
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("resume with rewindTo replays from an earlier path group", async () => {
    await waitForDevice(server);
    // ws 客户端收集进度事件，验证回溯后进度确实回退到更早的组起点
    const progress: number[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve) => ws.on("open", resolve));
    ws.on("message", (m: WebSocket.RawData) => {
      const msg = JSON.parse(m.toString()) as { c: string; p?: { motionIdx?: number } };
      if (msg.c === "progress" && typeof msg.p?.motionIdx === "number") {
        progress.push(msg.p.motionIdx);
      }
    });

    // 8 条独立路径（各自成组，组起点为抬笔行程），模拟器实时速率 ~2s/组
    const rewindPlan = plan(
      Array.from({ length: 8 }, (_, i) => [{ x: 0, y: i * 5 }, { x: 30, y: i * 5 }]),
      AxidrawFast,
    ).serialize();
    await request(server).post("/plot").send(rewindPlan).expect(200);

    // 等待推进到第 4 组（进度 ≥ 3）后暂停
    const waitStart = Date.now();
    while (Date.now() - waitStart < 20000 && Math.max(...progress, -1) < 3) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await request(server).post("/pause").expect(200);
    // 暂停生效：排空设备缓冲（3.1 排空确认 + 双源校验）
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const maxBefore = Math.max(...progress);
    expect(maxBefore).toBeGreaterThanOrEqual(3);

    // 回溯到第一个组起点重放
    const marker = progress.length;
    await request(server).post("/resume").send({ rewindTo: 0 }).expect(200);
    await waitForPlottingComplete(server, 90000);

    const afterRewind = progress.slice(marker);
    expect(afterRewind.length).toBeGreaterThan(0);
    // 重放确实从更早的组起点开始（进度回退）
    expect(Math.min(...afterRewind)).toBeLessThan(maxBefore);
    // 回溯重放后完整画完
    expect(Math.max(...progress)).toBeGreaterThanOrEqual(8 * 4 - 2);
    // 回溯行程后位置跟踪保持已知（补画可用）
    expect((await request(server).get("/plot/status")).body.penPosKnown).toBe(true);
    ws.close();
  }, 120000);
});

describe("GRBL alarm recovery (3.5)", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = await startServer(0, "", false, "200mb", "sim");
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("alarm during plot aborts plotting, notifies UI, marks position unknown", async () => {
    await waitForDevice(server);
    const sim = lastSimulator;
    if (!sim) throw new Error("simulator handle not available");
    // ws 客户端收集 alarm 弹窗消息
    const alarms: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve) => ws.on("open", resolve));
    ws.on("message", (m: WebSocket.RawData) => {
      const msg = JSON.parse(m.toString()) as { c: string; p?: { message?: string } };
      if (msg.c === "alarm" && typeof msg.p?.message === "string") alarms.push(msg.p.message);
    });

    const alarmPlan = plan(
      Array.from({ length: 12 }, (_, i) => [{ x: 0, y: i * 5 }, { x: 30, y: i * 5 }]),
      AxidrawFast,
    ).serialize();
    await request(server).post("/plot").send(alarmPlan).expect(200);
    // 注入硬限位 Alarm（模拟限位触发，协议层同步清空命令队列）
    sim.triggerAlarm(1);

    // 绘制立即退出（不走 postCancel 软复位/自动解锁路径），UI 收到告警弹窗
    await waitForPlottingComplete(server, 30000);
    expect(alarms.length).toBe(1);
    expect(alarms[0]).toContain("ALARM:1");
    expect(alarms[0]).toContain("硬限位");
    // Alarm 后位置参考不可信：重新归位前禁止补画
    const status = await request(server).get("/plot/status");
    expect(status.body.plotting).toBe(false);
    expect(status.body.penPosKnown).toBe(false);
    ws.close();
  }, 40000);

  test("unlock endpoint clears Alarm ($X) and rejects when not in Alarm", async () => {
    // 上一用例结束后设备保持 Alarm 态（未被静默解锁）
    await request(server).post("/grbl/unlock").expect(200);
    // 解锁后再解锁 → 409（不在 Alarm 状态）
    await request(server).post("/grbl/unlock").expect(409);
  }, 20000);

  test("/home recovers from Alarm via $H and rebuilds position reference", async () => {
    const sim = lastSimulator;
    if (!sim) throw new Error("simulator handle not available");
    sim.triggerAlarm(1);
    // 归位探测到 Alarm → 先 $H 重建位置参考（模拟器归位后坐标归零）
    await request(server).post("/home").expect(200);
    expect((await request(server).get("/plot/status")).body.penPosKnown).toBe(true);
  }, 30000);
});

describe("GRBL redraw mode (3.3)", () => {
  let server: Server;

  beforeAll(async () => {
    server = await startServer(0, "", false, "200mb", "sim");
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("redraw replays a motion range and auto-homes afterwards", async () => {
    await waitForDevice(server);
    const redrawPlan = plan(
      Array.from({ length: 8 }, (_, i) => [{ x: 0, y: i * 5 }, { x: 30, y: i * 5 }]),
      AxidrawFast,
    ).serialize();
    await request(server).post("/plot").send(redrawPlan).expect(200);
    await waitForPlottingComplete(server, 90000);
    expect((await request(server).get("/plot/status")).body.penPosKnown).toBe(true);

    // 补画区间 [1, 4)：从已知笔位抬笔行程至区间起点重放
    await request(server).post("/redraw").send({ from: 1, to: 4 }).expect(200);
    await waitForPlottingComplete(server, 90000);
    const status = await request(server).get("/plot/status");
    expect(status.body.plotting).toBe(false);
    // 完成后 Z 抬笔自动归位 → 位置仍已知，可继续补画
    expect(status.body.penPosKnown).toBe(true);

    // 归位后可立即再补画（连续补画不错位）
    await request(server).post("/redraw").send({ from: 4, to: 8 }).expect(200);
    await waitForPlottingComplete(server, 90000);
    expect((await request(server).get("/plot/status")).body.penPosKnown).toBe(true);
  }, 150000);
});

describe("GRBL soft limit coordination (3.6)", () => {
  let server: Server;

  beforeAll(async () => {
    server = await startServer(0, "", false, "200mb", "sim");
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const widePlan = plan([[{ x: 0, y: 0 }, { x: 100, y: 0 }]], AxidrawFast).serialize();

  test("plots normally when soft limits are disabled ($20=0)", async () => {
    await waitForDevice(server);
    await request(server).post("/plot").send(SIMPLE_PLAN).expect(200);
    await waitForPlottingComplete(server, 30000);
  }, 40000);

  test("rejects a plan exceeding soft-limit travel when $20=1", async () => {
    // 经参数写入端点开启软限位并缩小行程（$20=1，$130/$131=50）
    await request(server)
      .post("/grbl/params/write")
      .send({ settings: { 20: 1, 130: 50, 131: 50 } })
      .expect(200);
    // 超出行程的计划被提前拒绝（而非绘制中途 ALARM:2）
    const res = await request(server).post("/plot").send(widePlan).expect(400);
    expect(res.text).toContain("$20=1");
    expect(res.text).toContain("$130");
    // 行程内的计划不受影响，正常绘制
    await request(server).post("/plot").send(SIMPLE_PLAN).expect(200);
    await waitForPlottingComplete(server, 30000);
  }, 40000);

  test("no longer blocks after soft limits are disabled again ($20=0)", async () => {
    await request(server).post("/grbl/params/write").send({ settings: { 20: 0 } }).expect(200);
    await request(server).post("/plot").send(widePlan).expect(200);
    await waitForPlottingComplete(server, 30000);
  }, 40000);
});
