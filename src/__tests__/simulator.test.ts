import { afterEach, describe, expect, test, vi } from "vitest";
import { Grbl } from "../grbl.js";
import { GrblController } from "../grbl-controller.js";
import { Block, type Motion, PenMotion, Plan, XYMotion } from "../planning.js";
import { GrblSimulator } from "../simulator.js";

/**
 * 模拟模式集成测试（任务 2.5）：GrblController 全链路接入虚拟 GRBL 设备，
 * 验证握手 → 执行计划 → 排空 → Run/Hold 状态转换 → Alarm 解锁 → 归位。
 */

const v = (x: number, y: number) => ({ x, y });
const block = (p1: { x: number; y: number }, p2: { x: number; y: number }, v0: number, v1: number) =>
  new Block(v1 - v0, 1, v0, p1, p2);

describe("GrblSimulator 集成（任务 2.5）", () => {
  let sim: GrblSimulator | null = null;
  afterEach(() => {
    sim?.stop();
    sim = null;
  });

  /** 建立握手完成的控制器；timeScale 缺省即时完成 */
  async function makeController(opts?: ConstructorParameters<typeof GrblSimulator>[0]) {
    sim = new GrblSimulator({ timeScale: 1e-6, ...opts });
    const grbl = new Grbl(sim, { settleMs: 20 });
    await grbl.handshake(500);
    const ctrl = new GrblController(grbl, 115200, {
      z: { zPenDownMm: 0, zPenUpMm: 5, zFeedMmMin: 600 },
    });
    return { grbl, ctrl };
  }

  test("握手 → executePlan 全流程 → 虚拟位置与笔态正确", async () => {
    const { ctrl } = await makeController();
    const plan = new Plan([
      new PenMotion(0, 100, 0.2), // 落笔：pct 100 → Z 0
      new XYMotion([block(v(0, 0), v(10, 0), 0, 25)]),
      new XYMotion([block(v(10, 0), v(10, 5), 25, 25)]),
      new PenMotion(100, 0, 0.2), // 抬笔：pct 0 → Z 5
      new XYMotion([block(v(10, 5), v(0, 0), 200, 200)]),
    ]);
    await ctrl.executePlan(plan);
    expect(sim!.state).toBe("Idle");
    expect(sim!.wpos).toEqual({ x: 0, y: 0, z: 5 }); // 终点回原点、抬笔 Z=zPenUpMm
  });

  test("setPenHeight 按 penPct → Z 线性映射", async () => {
    const { ctrl } = await makeController();
    await ctrl.setPenHeight(0); // 抬笔
    // ok = planner 接受；虚拟运动提交需等排空
    await ctrl.waitUntilMotorsIdle(5000);
    expect(sim!.wpos.z).toBeCloseTo(5, 3);
    await ctrl.setPenHeight(100); // 落笔
    await ctrl.waitUntilMotorsIdle(5000);
    expect(sim!.wpos.z).toBeCloseTo(0, 3);
    await ctrl.setPenHeight(50);
    await ctrl.waitUntilMotorsIdle(5000);
    expect(sim!.wpos.z).toBeCloseTo(2.5, 3);
  });

  test("waitUntilMotorsIdle 等待虚拟运动完成", async () => {
    // 1mm @ F60 = 60s 虚拟 = 0.6s 实际（timeScale 0.01）
    const { ctrl } = await makeController({ timeScale: 0.01 });
    await ctrl.enableMotors(0);
    await ctrl.executeMotion(new XYMotion([block(v(0, 0), v(1, 0), 0, 1)]));
    await ctrl.waitUntilMotorsIdle(8000);
    expect(sim!.state).toBe("Idle");
    expect(sim!.wpos.x).toBeCloseTo(1, 1);
  });

  test("feedHold → Hold → cycleStart → Run → 完成回 Idle", async () => {
    // 10mm @ F60 = 600s 虚拟 = 6s 实际；中途保持再恢复
    const { grbl, ctrl } = await makeController({ timeScale: 0.01 });
    ctrl.onalarm = () => {};
    await ctrl.enableMotors(0);
    void ctrl.executeMotion(new XYMotion([block(v(0, 0), v(10, 0), 0, 1)])).catch(() => {});
    // executeMotion 等 ok（入队即回），此刻虚拟运动仍在进行
    await vi.waitFor(async () => {
      const s = await grbl.statusReport(500);
      return s.state === "Run";
    });
    ctrl.feedHold();
    const held = await grbl.statusReport(500);
    expect(held.state).toBe("Hold");
    ctrl.cycleStart();
    await vi.waitFor(async () => {
      const s = await grbl.statusReport(500);
      return s.state === "Run";
    });
    await ctrl.waitUntilMotorsIdle(15000);
    expect(sim!.wpos.x).toBeCloseTo(10, 0);
  }, 20000);

  test("Alarm 注入：onalarm 转发、enableMotors 拒绝、unlock 恢复", async () => {
    const { ctrl } = await makeController();
    const alarms: number[] = [];
    ctrl.onalarm = (code) => alarms.push(code);
    sim!.triggerAlarm(1);
    // ALARM 行经读管线异步到达 Grbl 层
    await vi.waitFor(() => expect(alarms).toEqual([1]));
    await expect(ctrl.enableMotors(0)).rejects.toThrow(/Alarm/);
    await ctrl.unlock();
    expect(sim!.state).toBe("Idle");
    await ctrl.enableMotors(0); // 不再抛错
  });

  test("$H 归位：清 Alarm、坐标归零", async () => {
    const { ctrl } = await makeController({ timeScale: 0.01 });
    await ctrl.command("G0 X5");
    await ctrl.waitUntilMotorsIdle(8000);
    expect(sim!.wpos.x).toBeCloseTo(5, 1);
    sim!.triggerAlarm(2);
    // ALARM 行经读管线异步到达 Grbl 层（并清空命令队列）后再归位
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ctrl.home(5000);
    expect(sim!.wpos).toEqual({ x: 0, y: 0, z: 0 });
    expect(sim!.state).toBe("Idle");
  });

  test("Alarm 后入队命令以告警原因立即拒绝（3.5），不产生位移", async () => {
    const { grbl } = await makeController();
    sim!.triggerAlarm(1);
    // ALARM:1 到达时 G0 X10 已入队：被中止并以告警原因拒绝，不再空等
    // 设备侧 error:9 应答（挂起命令在 Alarm 后永无应答）
    await expect(grbl.run("G0 X10")).rejects.toThrow(/ALARM:1/);
    expect(sim!.wpos.x).toBe(0);
  });

  test("未知 $ 命令回 error:9", async () => {
    const { grbl } = await makeController();
    await expect(grbl.run("$Q")).rejects.toThrow(/^error/);
  });

  test("软复位（0x18）：清空虚拟运动并重发横幅", async () => {
    const { grbl } = await makeController({ timeScale: 0.01 });
    await grbl.run("G0 X100"); // 0.75s 实际，未完成
    grbl.sendRealTime("\x18");
    // 0x18 经写流异步到达虚拟设备
    await vi.waitFor(() => expect(sim!.state).toBe("Idle"));
    expect(sim!.wpos.x).toBe(0); // 运动中止，位置未到达
  });

  test("估算时长与虚拟执行一致量级（Z 抬笔）", async () => {
    const { ctrl } = await makeController({ timeScale: 1e-6 });
    const pm = new PenMotion(0, 100, 0.2) as Motion;
    // ΔZ 5mm @ 600mm/min = 0.5s
    expect(ctrl.estimateMotionDurationSec(pm)).toBeCloseTo(0.5, 2);
  });
});
