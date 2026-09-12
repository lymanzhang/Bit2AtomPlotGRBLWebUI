import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import request from "supertest";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AxidrawFast, defaultPlanOptions, plan, type GrblParamComparison } from "../planning";
import { startServer } from "../server";

/**
 * 2.7 参数助手集成测试（GRBL sim 驱动）：
 * - POST /grbl/params：读取 $$ 并按档案换算对照（一致/不一致/无法比较）
 * - POST /grbl/params/write：$N=value 写入（含非法参数号拒绝）
 * - ws changeDriveParams：档案同步后工作区参与超界校验
 * 模拟器 $$ 默认值 80/80/400/8000/8000/500/500/500/100 与默认档案
 * （XY 5 全步 ×16 细分、Z 25 全步 ×16 细分）一致。
 */

const OUT_OF_AREA_PLAN = plan([[{ x: 10, y: 10 }, { x: 100, y: 10 }]], AxidrawFast).serialize();
// 足够长的计划，保证绘制中的守卫测试能命中 plotting 窗口
const MANY_PLAN = plan(
  Array.from({ length: 24 }, (_, i) => [{ x: 0, y: i * 10 }, { x: 100, y: i * 10 }]),
  AxidrawFast,
).serialize();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDevice(server: Server, timeout = 5000): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const response = await request(server).get("/plot/status");
    if (response.body.device === "grbl") return;
    await sleep(10);
  }
  throw new Error("GRBL simulator did not connect in time");
}

async function waitForPlottingComplete(server: Server, timeout = 20000): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const response = await request(server).get("/plot/status");
    if (!response.body.plotting) break;
    await sleep(10);
  }
}

const comparisonByKey = (comparisons: GrblParamComparison[]): Map<string, GrblParamComparison> =>
  new Map(comparisons.map((c) => [c.key, c]));

describe("GRBL 参数助手", () => {
  let server: Server;
  let ws: WebSocket;

  beforeAll(async () => {
    server = await startServer(0, "", false, "200mb", "sim");
    await waitForDevice(server);
    ws = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
      s.on("open", () => resolve(s));
      s.on("error", reject);
    });
  });

  afterAll(async () => {
    ws?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("probe：默认档案与模拟器 $$ 步/mm 全部一致", async () => {
    const res = await request(server).post("/grbl/params").send({}).expect(200);
    const byKey = comparisonByKey(res.body.comparisons as GrblParamComparison[]);
    for (const key of ["100", "101"]) {
      expect(byKey.get(key)?.match).toBe(true);
      expect(byKey.get(key)?.device).toBeCloseTo(80, 3);
      expect(byKey.get(key)?.suggested).toBeCloseTo(80, 3);
    }
    expect(byKey.get("102")?.match).toBe(true);
    expect(byKey.get("102")?.device).toBeCloseTo(400, 3);
    // 默认档案未配置速度/加速度 → 建议值缺失，无法比较
    expect(byKey.get("110")?.match).toBeNull();
    expect(byKey.get("110")?.device).toBeCloseTo(8000, 3);
    expect(byKey.get("120")?.device).toBeCloseTo(500, 3);
  });

  test("probe：检出档案与设备的差异（细分/限速）", async () => {
    const res = await request(server)
      .post("/grbl/params")
      .send({ microstepping: 8, firmware: { maxVelocityMmMin: { x: 6000 } } })
      .expect(200);
    const byKey = comparisonByKey(res.body.comparisons as GrblParamComparison[]);
    // 建议 5 全步 ×8 = 40 vs 设备 80 → 不一致
    expect(byKey.get("100")?.match).toBe(false);
    expect(byKey.get("100")?.suggested).toBeCloseTo(40, 3);
    expect(byKey.get("101")?.match).toBe(false);
    // $110: 6000 vs 设备 8000 → 不一致；$111 未配置 → 无法比较
    expect(byKey.get("110")?.match).toBe(false);
    expect(byKey.get("111")?.match).toBeNull();
  });

  test("write：写入 $100 后再探测转为一致", async () => {
    const res = await request(server).post("/grbl/params/write").send({ settings: { "100": 90 } }).expect(200);
    expect(res.body.written).toEqual(["100"]);
    expect(res.body.errors).toEqual([]);
    // 档案细分改 18（5×18=90）后与设备一致
    const probe = await request(server).post("/grbl/params").send({ microstepping: 18 }).expect(200);
    const c100 = comparisonByKey(probe.body.comparisons as GrblParamComparison[]).get("100");
    expect(c100?.match).toBe(true);
    expect(c100?.device).toBeCloseTo(90, 3);
  });

  test("write：非法参数号与值被拒绝", async () => {
    const res = await request(server)
      .post("/grbl/params/write")
      .send({ settings: { "bad-key": 1, "99999": 2, "101": "nan" } })
      .expect(200);
    expect(res.body.written).toEqual([]);
    expect(res.body.errors).toHaveLength(3);
  });

  test("changeDriveParams：档案工作区参与超界校验", async () => {
    ws.send(
      JSON.stringify({
        c: "changeDriveParams",
        p: { driveParams: { ...defaultPlanOptions.driveParams, workingAreaMm: { x: 50, y: 50 } } },
      }),
    );
    await sleep(100); // 等服务端处理 ws 消息
    const res = await request(server).post("/plot").send(OUT_OF_AREA_PLAN).expect(400);
    expect(res.text).toContain("超出设备工作范围");

    // 放宽工作区后同一计划可绘制（模拟器即时执行）
    ws.send(
      JSON.stringify({
        c: "changeDriveParams",
        p: { driveParams: { ...defaultPlanOptions.driveParams, workingAreaMm: { x: 300, y: 300 } } },
      }),
    );
    await sleep(100);
    await request(server).post("/plot").send(OUT_OF_AREA_PLAN).expect(200);
    await waitForPlottingComplete(server);
  }, 30000);

  test("绘制中拒绝访问设备参数", async () => {
    await request(server).post("/plot").send(MANY_PLAN).expect(200);
    const res = await request(server).post("/grbl/params").send({}).expect(400);
    expect(res.text).toContain("绘制进行中");
    await request(server).post("/cancel").expect(200);
    await waitForPlottingComplete(server);
  }, 30000);
});
