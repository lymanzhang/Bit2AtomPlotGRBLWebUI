import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { defaultPlanOptions, type PlanOptions } from "../planning";
import { AxidrawFast, plan } from "../planning";
import { replan } from "../massager";
import { PaperSize } from "../paper-size";
import { createMockSerialPort, mockSerialPortInstance } from "./mocks/serialport";

// Mock SerialPortSerialPort using shared implementation
vi.mock("../serialport-serialport", () => ({
  SerialPortSerialPort: vi.fn(function SerialPortSerialPort() {
    return createMockSerialPort();
  }),
}));

// Mock server to use test device
vi.mock("../server", async () => {
  const original = (await vi.importActual("../server")) as any;
  return {
    ...original,
    startServer: (port: number, hardware = "v3", ...args: any[]) =>
      original.startServer(port, hardware, "/dev/ttyMOCK", ...args),
    waitForEbb: vi.fn().mockResolvedValue("/dev/ttyMOCK"),
  };
});

import { startServer } from "../server";

const SIMPLE_PATHS = [
  [{x: 10, y: 10}, {x: 20, y: 10}],
]; // biome-ignore format: compactness

const COMPLEX_PATHS = [
  [{x: 0, y: 0}, {x: 100, y: 0}],
  [{x: 0, y: 50}, {x: 100, y: 50}],
  [{x: 0, y: 100}, {x: 100, y: 100}],
  [{x: 0, y: 150}, {x: 100, y: 150}],
]; // biome-ignore format: compactness

// Pre-serialized plan constants
const SIMPLE_PLAN = plan(SIMPLE_PATHS, AxidrawFast).serialize();
const COMPLEX_PLAN = plan(COMPLEX_PATHS, AxidrawFast).serialize();

// replan 的输入是 flatten-svg 的 Path 对象；测试用最小构造包装裸坐标
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asPaths = (pointLists: { x: number; y: number }[][]): any[] =>
  pointLists.map((points) => ({ points, stroke: "black", fill: null, fillRule: "nonzero", groupOrder: 0 }));

// Helper function to wait for plotting to complete
async function waitForPlottingComplete(server: Server, timeout = 10000): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const response = await request(server).get("/plot/status");
    if (!response.body.plotting) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForCommandsLogged(command = "EM,1,1", timeout = 5000): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (mockSerialPortInstance.commands.includes(command)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Plot Endpoint Test Suite", () => {
  let server: Server;

  beforeAll(async () => {
    server = await startServer(0); // Use port 0 for dynamic port assignment
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  // Reset state before each test to ensure isolation
  beforeEach(async () => {
    await waitForPlottingComplete(server);
    mockSerialPortInstance.clearCommands();
  });

  describe("Basic Plot Operations", () => {
    test("accept a valid plot plan and log EBB commands", async () => {
      await request(server).post("/plot").send(SIMPLE_PLAN).expect(200);

      // Wait for the plotting to actually start and commands to be logged
      await waitForCommandsLogged();

      // Check the commands that were sent to the mock serial port
      expect(mockSerialPortInstance.commands.length).toBeGreaterThan(0);
      expect(mockSerialPortInstance.commands).toContain("EM,1,1");
    });
  });

  describe("Error Handling", () => {
    test("handle malformed plan data", async () => {
      const invalidPlan = {
        notMotions: "invalid",
      };

      await request(server).post("/plot").send(invalidPlan).expect(500);
    });

    test("handle empty request body", async () => {
      await request(server).post("/plot").send({}).expect(500);
    });

    test("reject plot when another plot is in progress", async () => {
      // Start first plot - note the request resolves before the plot is finished
      await request(server).post("/plot").send(SIMPLE_PLAN).expect(200);

      // Immediately try second plot
      await request(server).post("/plot").send(SIMPLE_PLAN).expect(400);

      // Wait for first plot to complete to avoid affecting other tests
      await waitForPlottingComplete(server);
    });

    test("reject plans outside the device working area", async () => {
      // v3 行程 430×300mm × 5 步/mm = 2150×1500 步；把路径平移到行程外
      const FAR_PLAN = plan(
        [SIMPLE_PATHS[0].map((p) => ({ x: p.x + 4000, y: p.y + 4000 }))],
        AxidrawFast,
      ).serialize();
      const response = await request(server).post("/plot").send(FAR_PLAN).expect(400);
      expect(response.text).toContain("超出设备工作范围");
      expect(response.text).toContain("804.0 mm"); // X 最大坐标超出 430mm 上限

      // 行程内的计划不受影响
      await request(server).post("/plot").send(SIMPLE_PLAN).expect(200);
      await waitForPlottingComplete(server);
    });

    test("reject plans from oversized custom paper via the fit-page flow", async () => {
      // 用户流程场景：自定义纸张 600×400mm 超出 v3 行程（430×300），
      // 「等比例缩放」会把图形缩放到纸张大小，计划坐标随之越界
      const planBody = replan(asPaths(COMPLEX_PATHS), {
        ...defaultPlanOptions,
        paperSize: new PaperSize({ x: 600, y: 400 }),
        layerMode: "all",
      } as PlanOptions).serialize();
      const response = await request(server).post("/plot").send(planBody).expect(400);
      expect(response.text).toContain("超出设备工作范围");
    });

    test("reject plans exceeding the area in actual-size scale mode", async () => {
      // 用户流程场景：取消「等比例缩放」后按 1:1 mm 落纸。2100px ≈ 556mm
      // 的路径对齐到 A4 横向纸面后仍超出 430mm 行程
      const BIG_PATH = [[{ x: 0, y: 0 }, { x: 2100, y: 0 }]];
      const planBody = replan(asPaths(BIG_PATH), {
        ...defaultPlanOptions,
        paperSize: PaperSize.standard.A4.landscape,
        scaleMode: "actual",
        cropToMargins: false,
        layerMode: "all",
      } as PlanOptions).serialize();
      const response = await request(server).post("/plot").send(planBody).expect(400);
      expect(response.text).toContain("超出设备工作范围");
    });

    test("accept normal in-range tasks (A4 landscape, fit-page)", async () => {
      // 正常范围任务：A4 横向 + 等比例缩放，坐标始终在 430×300mm 内
      const planBody = replan(asPaths(COMPLEX_PATHS), {
        ...defaultPlanOptions,
        paperSize: PaperSize.standard.A4.landscape,
        layerMode: "all",
      } as PlanOptions).serialize();
      await request(server).post("/plot").send(planBody).expect(200);
      await waitForPlottingComplete(server);
    });

    test("custom hardware hard-rejects only when working area is configured", async () => {
      // 服务端以 EBB 设备档案（非计划字段）判定硬件类型，先经 WebSocket
      // 切换到 custom 硬件，测完切回 v3，避免影响其他用例
      const changeHardware = (hardware: string) =>
        new Promise<void>((resolve, reject) => {
          const port = (server.address() as AddressInfo).port;
          const ws = new WebSocket(`ws://127.0.0.1:${port}`);
          ws.on("open", () => {
            ws.send(JSON.stringify({ c: "changeHardware", p: { hardware } }));
            ws.close();
            resolve();
          });
          ws.on("error", reject);
        });
      // custom 硬件的真实行程只有前端知道：未配置工作区域时仅告警放行，
      // 配置后（X-Plot-Working-Area 头）按真实区域硬拒绝
      const planBody = replan(asPaths(COMPLEX_PATHS), {
        ...defaultPlanOptions,
        paperSize: new PaperSize({ x: 600, y: 400 }),
        layerMode: "all",
      } as PlanOptions).serialize();
      await changeHardware("my-machine");
      try {
        // 未配置 → 仅告警，不拒绝
        await request(server).post("/plot").send(planBody).expect(200);
        await waitForPlottingComplete(server);
        // 配置 500×350mm → 计划 Y 方向最大 380mm 超出上限，硬拒绝
        const rejected = await request(server)
          .post("/plot")
          .set("X-Plot-Working-Area", "500x350")
          .send(planBody)
          .expect(400);
        expect(rejected.text).toContain("350.0 mm");
        // 非法头 → 忽略，仍告警放行
        await request(server).post("/plot").set("X-Plot-Working-Area", "abc").send(planBody).expect(200);
        await waitForPlottingComplete(server);
      } finally {
        await changeHardware("v3");
      }
    });
  });

  describe("Plot Control Operations", () => {
    test("cancel plot", async () => {
      await request(server).post("/plot").send(COMPLEX_PLAN).expect(200);

      // Wait for plot to start executing motions, then cancel
      await new Promise((resolve) => setTimeout(resolve, 20));

      await request(server).post("/cancel").expect(200);

      await waitForPlottingComplete(server);
      expect(mockSerialPortInstance.commands).toContain("EM,1,1");
    });

    test("pause and resume plotting", async () => {
      await request(server).post("/plot").send(COMPLEX_PLAN).expect(200);

      await request(server).post("/pause").expect(200);

      expect(mockSerialPortInstance.commands).not.toContain("SR,60000000,0");

      await request(server).post("/resume").expect(200);

      // Wait for plot to complete
      await waitForPlottingComplete(server);

      // Verify commands were still executed
      expect(mockSerialPortInstance.commands.length).toBeGreaterThan(0);
      expect(mockSerialPortInstance.commands).toContain("EM,1,1");
      // Should have completed with motor disable (plot continued after resume)
      // FIXME: Is this a real bug on Windows?
      // expect(mockSerialPortInstance.commands).toContain('SR,60000000,0');
    }, 10000);

    test("pause, rewind and resume replays from an earlier path", async () => {
      // Run a normal plot first to get a baseline command count
      await request(server).post("/plot").send(COMPLEX_PLAN).expect(200);
      await waitForPlottingComplete(server);
      const normalCount = mockSerialPortInstance.commands.length;
      mockSerialPortInstance.clearCommands();

      // Plot again, pause mid-way, then resume with rewindTo = path 0
      await request(server).post("/plot").send(COMPLEX_PLAN).expect(200);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await request(server).post("/pause").expect(200);
      await request(server).post("/resume").send({ rewindTo: 0 }).expect(200);

      await waitForPlottingComplete(server);

      // Rewinding replays earlier motions, so at least as many commands as a
      // normal run are issued (plus the rewind travel move).
      expect(mockSerialPortInstance.commands.length).toBeGreaterThanOrEqual(normalCount);
      expect(mockSerialPortInstance.commands).toContain("EM,1,1");
    }, 15000);

    test("supports consecutive rewinds (pause → rewind → pause → rewind)", async () => {
      // Long plan so pauses reliably land mid-plot (mock executes ~2ms/command)
      const manyPaths = Array.from({ length: 24 }, (_, i) => [
        { x: 0, y: i * 10 },
        { x: 100, y: i * 10 },
      ]);
      const LONG_PLAN = plan(manyPaths, AxidrawFast).serialize();

      await request(server).post("/plot").send(LONG_PLAN).expect(200);
      await waitForPlottingComplete(server);
      const normalCount = mockSerialPortInstance.commands.length;
      mockSerialPortInstance.clearCommands();

      // First pause + rewind
      await request(server).post("/plot").send(LONG_PLAN).expect(200);
      await new Promise((resolve) => setTimeout(resolve, 80));
      await request(server).post("/pause").expect(200);
      await request(server).post("/resume").send({ rewindTo: 0 }).expect(200);

      // Second pause + rewind during the redraw
      await new Promise((resolve) => setTimeout(resolve, 80));
      await request(server).post("/pause").expect(200);
      await request(server).post("/resume").send({ rewindTo: 0 }).expect(200);

      await waitForPlottingComplete(server, 30000);

      // Two rewinds replay from path 0, so at least one full pass of commands
      // is guaranteed (likely more).
      expect(mockSerialPortInstance.commands.length).toBeGreaterThanOrEqual(normalCount);
      expect(mockSerialPortInstance.commands).toContain("EM,1,1");
    }, 40000);

    test("report plot status", async () => {
      let statusResponse = await request(server).get("/plot/status").expect(200);
      expect(statusResponse.body.plotting).toBe(false);

      await request(server).post("/plot").send(COMPLEX_PLAN).expect(200);

      statusResponse = await request(server).get("/plot/status").expect(200);
      expect(statusResponse.body.plotting).toBe(true);

      await waitForPlottingComplete(server);

      statusResponse = await request(server).get("/plot/status").expect(200);
      expect(statusResponse.body.plotting).toBe(false);
    }, 10000);
  });

  describe("Redraw Range Operations", () => {
    test("reject redraw when no plot has run yet", async () => {
      // Use a fresh server instance: the shared one has already plotted in
      // earlier tests, so |lastPlan| would exist there.
      const fresh = await startServer(0);
      try {
        await request(fresh).post("/redraw").send({ from: 0, to: 4 }).expect(409);
      } finally {
        await new Promise<void>((resolve) => fresh.close(() => resolve()));
      }
    });

    test("reject redraw with an invalid range", async () => {
      await request(server).post("/plot").send(COMPLEX_PLAN).expect(200);
      await waitForPlottingComplete(server);

      // to <= from is invalid
      await request(server).post("/redraw").send({ from: 4, to: 4 }).expect(400);
      await request(server).post("/redraw").send({ from: 8, to: 4 }).expect(400);
      await request(server).post("/redraw").send({ from: -1, to: 4 }).expect(400);

      await waitForPlottingComplete(server);
    });

    test("reject redraw while a plot is in progress", async () => {
      await request(server).post("/plot").send(COMPLEX_PLAN).expect(200);
      await request(server).post("/redraw").send({ from: 0, to: 4 }).expect(400);
      await waitForPlottingComplete(server);
    });

    test("redraw only replays the selected motion range", async () => {
      // Baseline: full plot command count
      await request(server).post("/plot").send(COMPLEX_PLAN).expect(200);
      await waitForPlottingComplete(server);
      const fullCount = mockSerialPortInstance.commands.length;
      mockSerialPortInstance.clearCommands();

      // Each path produces 4 motions (travel, pen down, draw, pen up), so the
      // 4-path plan has 16 motions. Redraw only paths 1-2 → motions [4, 8).
      await request(server).post("/redraw").send({ from: 4, to: 8 }).expect(200);
      await waitForPlottingComplete(server);

      const commands = mockSerialPortInstance.commands;
      expect(commands).toContain("EM,1,1");
      // Substantially fewer commands than a full plot (about half or less)
      expect(commands.length).toBeLessThan(fullCount * 0.75);
      // Ends with motors disabled
      expect(commands[commands.length - 1]).toBe("EM,0,0");
    }, 10000);

    test("redraw snaps the start to a path-group boundary", async () => {
      await request(server).post("/plot").send(COMPLEX_PLAN).expect(200);
      await waitForPlottingComplete(server);
      mockSerialPortInstance.clearCommands();

      // from = 5 falls inside path 1's group [4, 8); it should snap to 4 so
      // the group replays whole (pen up/down pairing preserved).
      await request(server).post("/redraw").send({ from: 5, to: 8 }).expect(200);
      await waitForPlottingComplete(server);

      const commands = mockSerialPortInstance.commands;
      expect(commands).toContain("EM,1,1");
    }, 10000);

    test("redraw auto-homes the pen after finishing", async () => {
      await request(server).post("/plot").send(COMPLEX_PLAN).expect(200);
      await waitForPlottingComplete(server);
      mockSerialPortInstance.clearCommands();

      await request(server).post("/redraw").send({ from: 4, to: 8 }).expect(200);
      await waitForPlottingComplete(server);

      const commands = mockSerialPortInstance.commands;
      // prePlot enables motors once; the auto-home must re-enable them again
      // (postPlot disabled them after the redraw itself).
      const enableIdxs = commands.map((c, i) => (c === "EM,1,1" ? i : -1)).filter((i) => i >= 0);
      expect(enableIdxs.length).toBeGreaterThanOrEqual(2);
      // ...and travel home with a low-level move (LM) — NOT HM, which is a
      // zero-length no-op after the motors have been re-enabled.
      const lastEnableIdx = enableIdxs[enableIdxs.length - 1];
      expect(commands.slice(lastEnableIdx).some((c) => c.startsWith("LM,"))).toBe(true);
      expect(commands).not.toContain("HM,4000");
      // Ends with motors disabled
      expect(commands[commands.length - 1]).toBe("EM,0,0");
    }, 10000);

    test("home is a safe no-op when the pen is already at home", async () => {
      // A full plot ends with the plan's own return-to-home travel, so the
      // pen is already home. /home must lift the pen and re-acquire the
      // motors, but issue no HM (zero-length after re-enable) and no travel,
      // ending with motors disabled.
      await request(server).post("/plot").send(COMPLEX_PLAN).expect(200);
      await waitForPlottingComplete(server);
      mockSerialPortInstance.clearCommands();

      await request(server).post("/home").expect(200);
      await waitForCommandsLogged("EM,0,0");

      const commands = mockSerialPortInstance.commands;
      expect(commands).toContain("EM,1,1");
      expect(commands).not.toContain("HM,4000");
      expect(commands[commands.length - 1]).toBe("EM,0,0");
    }, 10000);
  });
});
