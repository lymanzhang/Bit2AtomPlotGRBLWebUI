import type { Server } from "node:http";
import request from "supertest";
import { afterAll, describe, expect, test, vi } from "vitest";
import { AxidrawFast, plan } from "../planning";

// 模拟模式回归：ebb == null（无设备/连接失败）时 /plot 必须正常完成。
// 曾因 doPlot 排空估计直接调用 ebb.estimateMotionDurationSec 而空引用崩溃
// （TypeError: Cannot read properties of undefined (reading
// 'estimateMotionDurationSec')），server.test.ts 全部走 mock 串口未覆盖此路径。

vi.mock("../serialport-serialport", () => ({
  SerialPortSerialPort: vi.fn(function SerialPortSerialPort() {
    throw new Error("sim mode: no serial port expected");
  }),
}));

vi.mock("../server", async () => {
  const original = (await vi.importActual("../server")) as any;
  return {
    ...original,
    // 让 ebbs() 生成器连接失败进入重试循环，ebb 保持 null（模拟模式）
    waitForEbb: vi.fn().mockRejectedValue(new Error("sim mode: no device")),
  };
});

import { startServer } from "../server";

const SIMPLE_PLAN = plan([[{x: 10, y: 10}, {x: 20, y: 10}]], AxidrawFast).serialize(); // biome-ignore format: compactness

describe("Sim mode (no device)", () => {
  let server: Server;

  test("/plot completes without a connected device", async () => {
    server = await startServer(0);
    await request(server).post("/plot").send(SIMPLE_PLAN).expect(200);
    for (let i = 0; i < 100; i++) {
      const r = await request(server).get("/plot/status");
      if (!r.body.plotting) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const r = await request(server).get("/plot/status");
    expect(r.body.plotting).toBe(false);
  });

  afterAll(() => {
    server?.close();
  });
});
