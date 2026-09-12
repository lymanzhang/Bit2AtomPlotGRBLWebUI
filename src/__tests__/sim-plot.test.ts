import type { Server } from "node:http";
import request from "supertest";
import { afterAll, describe, expect, test, vi } from "vitest";
import { AxidrawFast, plan } from "../planning";

// 无设备拒绝回归：真实驱动模式下 device == null（未连接设备）时 /plot 必须
// 以 409 拒绝并说明原因——曾静默回退模拟绘制，用户未接机点「开始绘制」会
// 误入绘制状态。无硬件试跑应显式使用 --driver sim。
// （历史：本文件曾验证「无设备回退模拟」不崩溃，该行为已按需求移除。）

vi.mock("../serialport-serialport", () => ({
  SerialPortSerialPort: vi.fn(function SerialPortSerialPort() {
    throw new Error("sim mode: no serial port expected");
  }),
}));

import { startServer } from "../server";

const SIMPLE_PLAN = plan([[{x: 10, y: 10}, {x: 20, y: 10}]], AxidrawFast).serialize(); // biome-ignore format: compactness

describe("No device connected (real driver)", () => {
  let server: Server;

  test("/plot is rejected with 409 when no device is connected", async () => {
    server = await startServer(0);
    const res = await request(server).post("/plot").send(SIMPLE_PLAN).expect(409);
    expect(res.text).toContain("GRBL 设备未连接");
    const r = await request(server).get("/plot/status");
    expect(r.body.plotting).toBe(false);
  });

  afterAll(() => {
    server?.close();
  });
});
