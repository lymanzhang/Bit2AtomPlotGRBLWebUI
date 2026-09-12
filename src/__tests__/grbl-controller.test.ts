import { describe, expect, test } from "vitest";
import { GrblController } from "../grbl-controller.js";
import { Grbl } from "../grbl.js";
import { Block, PenMotion, Plan, XYMotion, defaultPlanOptions } from "../planning.js";
import type { Vec2 } from "../vec.js";
import { MockGrblPort } from "./mocks/grbl-port.js";

/**
 * GrblController 测试（任务 2.4）：DeviceController 契约下的动作转译流式
 * 下发、笔状态跟踪、Alarm 体检、Idle 轮询、笔高 penPct 口径、波特率回退探测。
 */

const v = (x: number, y: number): Vec2 => ({ x, y });
const block = (p1: Vec2, p2: Vec2, v0: number, v1: number) => new Block(v1 - v0, 1, v0, p1, p2);

async function makeController(options?: Parameters<typeof GrblController.connect>[1]) {
  const port = new MockGrblPort();
  const grbl = new Grbl(port, {});
  await grbl.handshake(200);
  const controller = new GrblController(grbl, 115200, options);
  return { controller, port };
}

describe("connect", () => {
  test("配置波特率握手成功即返回", async () => {
    const opened: number[] = [];
    const controller = await GrblController.connect(async (baud) => {
      opened.push(baud);
      const port = new MockGrblPort();
      return { port, close: () => port.close() };
    }, { handshakeTimeoutMs: 200 });
    expect(opened).toEqual([115200]);
    expect(controller.baudRate).toBe(115200);
  });

  test("配置波特率握手失败 → 自动探测回退到首个成功档位", async () => {
    const opened: number[] = [];
    const controller = await GrblController.connect(async (baud) => {
      opened.push(baud);
      const port = new MockGrblPort();
      port.banner = baud === 9600; // 仅 9600 应答横幅
      return { port, close: () => port.close() };
    }, { baudRate: 115200, handshakeTimeoutMs: 200 });
    expect(opened[0]).toBe(115200);
    expect(controller.baudRate).toBe(9600);
  });

  test("全部档位无应答 → 明确报错", async () => {
    await expect(
      GrblController.connect(async (_baud) => {
        const port = new MockGrblPort();
        port.banner = false;
        return { port, close: () => port.close() };
      }, { handshakeTimeoutMs: 100 }),
    ).rejects.toThrow(/握手失败/);
  });
});

describe("executeMotion 转译与笔状态跟踪", () => {
  test("抬笔状态下的 XYMotion → G0 空程", async () => {
    const { controller, port } = await makeController();
    await controller.executeMotion(new XYMotion([block(v(0, 0), v(10, 0), 200, 200)]));
    const motionLines = port.received.filter((l) => l !== "" && l !== "?");
    expect(motionLines).toEqual(["G0 X10 Y0"]);
  });

  test("落笔后 XYMotion → G1 带 F；PenMotion → Z 轴命令", async () => {
    const { controller, port } = await makeController();
    await controller.executeMotion(new PenMotion(50, 60, 0.2));
    await controller.executeMotion(new XYMotion([block(v(0, 0), v(10, 0), 0, 25)]));
    const motionLines = port.received.filter((l) => l !== "" && l !== "?");
    expect(motionLines).toEqual(["G1 Z2 F600", "G1 X10 Y0 F1500"]);
  });

  test("抬笔 PenMotion 后恢复 G0", async () => {
    const { controller, port } = await makeController();
    await controller.executeMotion(new PenMotion(50, 60, 0.2));
    await controller.executeMotion(new XYMotion([block(v(0, 0), v(5, 0), 25, 25)]));
    await controller.executeMotion(new PenMotion(60, 50, 0.2));
    await controller.executeMotion(new XYMotion([block(v(5, 0), v(0, 0), 200, 200)]));
    const motionLines = port.received.filter((l) => l !== "" && l !== "?");
    expect(motionLines).toEqual(["G1 Z2 F600", "G1 X5 Y0 F1500", "G1 Z2.5 F600", "G0 X0 Y0"]);
  });

  test("任一行 error: → 整批中止并 reject", async () => {
    const { controller, port } = await makeController();
    port.onLine = (line, p) => {
      if (line.startsWith("G0") || line.startsWith("G1")) {
        p.pushToHost("error:9");
        return true;
      }
      return false;
    };
    const motion = new XYMotion([block(v(0, 0), v(10, 0), 0, 25), block(v(10, 0), v(20, 0), 25, 25)]);
    await expect(controller.executeMotion(motion)).rejects.toThrow(/error:9/);
  });
});

describe("setPenHeight（penPct 口径）", () => {
  test("height=60 → Z2；后续 XY 按落笔 G1", async () => {
    const { controller, port } = await makeController();
    await controller.setPenHeight(60);
    await controller.executeMotion(new XYMotion([block(v(0, 0), v(10, 0), 0, 25)]));
    const motionLines = port.received.filter((l) => l !== "" && l !== "?");
    expect(motionLines).toEqual(["G1 Z2 F600", "G1 X10 Y0 F1500"]);
  });

  test("height=50（抬笔）→ 后续 XY 按空程 G0", async () => {
    const { controller, port } = await makeController();
    await controller.setPenHeight(50);
    await controller.executeMotion(new XYMotion([block(v(0, 0), v(10, 0), 200, 200)]));
    const motionLines = port.received.filter((l) => l !== "" && l !== "?");
    expect(motionLines).toEqual(["G1 Z2.5 F600", "G0 X10 Y0"]);
  });
});

describe("电机使能体检与排空等待", () => {
  test("enableMotors：Idle → 放行", async () => {
    const { controller } = await makeController();
    await expect(controller.enableMotors(0)).resolves.toBeUndefined();
  });

  test("enableMotors：Alarm → 拒绝并提示解锁", async () => {
    const { controller, port } = await makeController();
    port.statusReplies = ["<Alarm|WPos:0.000,0.000,0.000>"];
    await expect(controller.enableMotors(0)).rejects.toThrow(/Alarm/);
  });

  test("waitUntilMotorsIdle：Run → Idle 后返回", async () => {
    const { controller, port } = await makeController();
    port.statusReplies = ["<Run|WPos:1.000,2.000,0.000>", "<Idle|WPos:1.000,2.000,0.000>"];
    await expect(controller.waitUntilMotorsIdle(3000)).resolves.toBeUndefined();
  });

  test("waitUntilMotorsIdle：持续 Run → 超时报错", async () => {
    const { controller, port } = await makeController();
    port.defaultStatus = "<Run|WPos:1.000,2.000,0.000>";
    await expect(controller.waitUntilMotorsIdle(300)).rejects.toThrow(/timed out/);
  });
});

describe("其余 DeviceController 契约", () => {
  test("estimateMotionDurationSec：按档案限速口径估算", async () => {
    const { controller } = await makeController();
    const motion = new XYMotion([block(v(0, 0), v(10, 0), 0, 25)]);
    // avg (0+25)/2 = 12.5mm/s → 10/12.5 = 0.8s
    expect(controller.estimateMotionDurationSec(motion)).toBeCloseTo(0.8);
  });

  test("disableMotors/configureFifoDepth：GRBL 语义空实现", async () => {
    const { controller } = await makeController();
    await expect(controller.disableMotors()).resolves.toBeUndefined();
    await expect(controller.configureFifoDepth()).resolves.toBeUndefined();
    expect(controller.fifoDepth).toBe(-1);
  });

  test("home/unlock/feedHold/cycleStart/softReset：$H、$X、!、~、0x18 下发", async () => {
    const { controller, port } = await makeController();
    await controller.home(1000);
    await controller.unlock();
    controller.feedHold();
    controller.cycleStart();
    controller.softReset();
    await new Promise((resolve) => setTimeout(resolve, 20)); // 实时命令写串口为异步
    const motionLines = port.received.filter((l) => l !== "" && l !== "?");
    expect(motionLines).toEqual(["$H", "$X", "!", "~", "\x18"]);
  });

  test("executePlan：整计划顺序执行", async () => {
    const { controller, port } = await makeController();
    const plan = new Plan([
      new PenMotion(50, 60, 0.2),
      new XYMotion([block(v(0, 0), v(10, 0), 0, 25)]),
      new PenMotion(60, 50, 0.2),
    ]);
    await controller.executePlan(plan);
    const motionLines = port.received.filter((l) => l !== "" && l !== "?");
    expect(motionLines).toEqual(["G1 Z2 F600", "G1 X10 Y0 F1500", "G1 Z2.5 F600"]);
  });

  test("onalarm 转发：grbl.onalarm → controller.onalarm", async () => {
    const { controller, port } = await makeController();
    const seen: string[] = [];
    controller.onalarm = (_code, raw) => seen.push(raw);
    port.pushToHost("ALARM:1");
    await new Promise((resolve) => setTimeout(resolve, 20)); // 读流处理为异步
    expect(seen).toEqual(["ALARM:1"]);
  });
});

describe("applyDriveParams（2.7 参数助手档案同步）", () => {
  test("更新 Z 抬笔配置与限速", async () => {
    const { controller, port } = await makeController();
    controller.applyDriveParams({
      ...defaultPlanOptions.driveParams,
      zPenUpMm: 8,
      zFeedMmMin: 1200,
      firmware: { ...defaultPlanOptions.driveParams.firmware, maxVelocityMmMin: { x: 6000, y: 6000, z: 300 } },
    });
    expect(controller.z.zPenUpMm).toBe(8);
    expect(controller.z.zFeedMmMin).toBe(1200);
    expect(controller.limits?.maxVelMmMin).toEqual({ x: 6000, y: 6000, z: 300 });

    // 限速钳制生效：落笔 10mm，vFinal 150mm/s → F9000 钳到 6000mm/min。
    // height 为 pct 口径：60（落笔）→ Z = 8×0.4 = 3.2
    await controller.setPenHeight(60);
    await controller.executeMotion(new XYMotion([block(v(0, 0), v(10, 0), 0, 150)]));
    const motionLines = port.received.filter((l) => l !== "" && l !== "?");
    expect(motionLines).toEqual(["G1 Z3.2 F1200", "G1 X10 Y0 F6000"]);
  });

  test("档案未配置限速 → 清除钳制", async () => {
    const { controller } = await makeController();
    controller.limits = { maxVelMmMin: { x: 100 } };
    controller.applyDriveParams(defaultPlanOptions.driveParams);
    expect(controller.limits?.maxVelMmMin).toBeUndefined();
  });
});
