import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WebSerialDriver } from "../drivers.js";
import { Grbl } from "../grbl.js";
import { GrblController } from "../grbl-controller.js";
import { Block, PenMotion, Plan, XYMotion } from "../planning.js";
import { GrblSimulator } from "../simulator.js";

/**
 * WebSerial 浏览器直连驱动（3.7）：WebSerialDriver 执行循环接 GrblController
 * + 虚拟 GRBL 设备全链路。connect() 依赖 navigator.serial（浏览器 API），
 * 测试经构造直建驱动并手工接线 onalarm/ondisconnect（与 connect 内一致）。
 */

const v = (x: number, y: number) => ({ x, y });
const block = (p1: { x: number; y: number }, p2: { x: number; y: number }, v0: number, v1: number) =>
  new Block(v1 - v0, 1, v0, p1, p2);

// 生产 Plan 的 PenMotion 携带 penPct 口径笔位（0 = 完全抬笔，100 = 完全落笔），
// 驱动层的抬笔值惯用法 Math.min(initialPos, finalPos) 依赖该语义——测试计划
// 同口径构造（pct 60 落笔 / pct 50 抬笔）。
const PEN_DOWN = 60;
const PEN_UP = 50;

/** 落笔画两笔 → 抬笔 → 空程移动（终点远离起点，供归位测试） */
const TEST_PLAN = new Plan([
  new PenMotion(PEN_UP, PEN_DOWN, 0.2),
  new XYMotion([block(v(0, 0), v(10, 0), 0, 25)]),
  new XYMotion([block(v(10, 0), v(10, 5), 25, 25)]),
  new PenMotion(PEN_DOWN, PEN_UP, 0.2),
  new XYMotion([block(v(10, 5), v(30, 5), 200, 200)]),
]);

/** 较长的计划（timeScale 0.01 下设备侧执行约 1s）。取消/Alarm 经 onprogress
 * 在确定位于执行循环中途的时刻注入（固定 idx）——按固定时长 sleep 注入会
 * 与「循环已接受完全部 ok、进入收尾排空」的竞态（GRBL 流水线模型下循环
 * 远早于设备执行结束）。 */
const LONG_PLAN = new Plan([
  new PenMotion(PEN_UP, PEN_DOWN, 0.2),
  ...Array.from({ length: 24 }, (_, i) => new XYMotion([block(v(0, i * 10), v(100, i * 10), 25, 25)])),
]);

describe("WebSerialDriver 浏览器直连 GRBL（3.7）", () => {
  let sim: GrblSimulator | null = null;

  beforeEach(() => {
    vi.stubGlobal("alert", vi.fn());
  });
  afterEach(() => {
    sim?.stop();
    sim = null;
    vi.unstubAllGlobals();
  });

  /** 模拟器 + GrblController + 直建驱动（绕过 navigator.serial） */
  async function makeDriver(opts?: ConstructorParameters<typeof GrblSimulator>[0]) {
    sim = new GrblSimulator({ timeScale: 1e-6, ...opts });
    const grbl = new Grbl(sim, { settleMs: 20 });
    await grbl.handshake(500);
    const gc = new GrblController(grbl, 115200, {
      z: { zPenDownMm: 0, zPenUpMm: 5, zFeedMmMin: 600 },
    });
    const driver = new (WebSerialDriver as unknown as new (d: GrblController, n: string) => WebSerialDriver)(
      gc,
      "test",
    );
    driver.connected = true;
    // connect() 内的守卫接线（测试手工等价复制）
    gc.onalarm = (_code, raw) => (driver as unknown as { handleAlarm(r: string): void }).handleAlarm(raw);
    gc.ondisconnect = () =>
      (driver as unknown as { handleDisconnection(): void }).handleDisconnection();
    return { gc, driver };
  }

  test("plot 完整执行并跟踪笔位", async () => {
    const { driver } = await makeDriver();
    const events: string[] = [];
    driver.onfinished = () => events.push("finished");
    driver.oncancelled = () => events.push("cancelled");

    await driver.plot(TEST_PLAN);
    expect(events).toEqual(["finished"]);
    // 笔位跟踪：计划终点 (30,5)
    expect((driver as unknown as { _lastPenPos: unknown })._lastPenPos).toEqual(v(30, 5));
  }, 20000);

  test("cancel 中途停止：抬笔 + 设备可控可复用", async () => {
    const { gc, driver } = await makeDriver({ timeScale: 0.01 });
    const events: string[] = [];
    driver.onfinished = () => events.push("finished");
    driver.oncancelled = () => events.push("cancelled");
    driver.onprogress = (idx) => {
      if (idx === 5) driver.cancel(); // feedHold 冻结 → 收尾软复位丢弃积压
    };

    await driver.plot(LONG_PLAN);

    expect(events).toEqual(["cancelled"]);
    // 取消收尾已抬笔到计划抬笔高度（pct 50 → Z2.5，避免笔压纸），设备复位后可控、可复用
    await gc.waitUntilMotorsIdle(5000);
    expect(sim!.state).toBe("Idle");
    expect(sim!.wpos.z).toBeCloseTo(2.5, 3);
    // 设备仍可用：立即再画一笔成功
    await driver.plot(TEST_PLAN);
    expect(events).toEqual(["cancelled", "finished"]);
  }, 30000);

  test("homePen 已知位置经抬笔行程归位", async () => {
    const { gc, driver } = await makeDriver();
    await driver.plot(TEST_PLAN); // 终点 (30,5)
    await gc.waitUntilMotorsIdle(5000);
    await driver.homePen(TEST_PLAN);
    expect((driver as unknown as { _lastPenPos: unknown })._lastPenPos).toEqual(v(0, 0));
    await gc.waitUntilMotorsIdle(5000);
    expect(sim!.wpos.x).toBeCloseTo(0, 1);
    expect(sim!.wpos.y).toBeCloseTo(0, 1);
    // 归位行程为抬笔移动：笔保持抬起（计划抬笔 pct 50 → Z2.5）
    expect(sim!.wpos.z).toBeCloseTo(2.5, 3);
  }, 20000);

  test("homePen 位置未知经 $H 归位并重建参考", async () => {
    const { gc, driver } = await makeDriver({ timeScale: 0.01 });
    (driver as unknown as { _lastPenPos: unknown })._lastPenPos = null;
    await driver.homePen(TEST_PLAN);
    // $H 后工作坐标归零 + 再次抬笔（计划抬笔 pct 50 → Z2.5）
    await gc.waitUntilMotorsIdle(5000);
    expect(sim!.wpos.x).toBeCloseTo(0, 1);
    expect(sim!.wpos.y).toBeCloseTo(0, 1);
    expect(sim!.wpos.z).toBeCloseTo(2.5, 3);
    expect((driver as unknown as { _lastPenPos: unknown })._lastPenPos).toEqual(v(0, 0));
  }, 30000);

  test("绘制中 Alarm 立即中止：位置失效、弹窗引导、$H 可恢复", async () => {
    const { gc, driver } = await makeDriver({ timeScale: 0.01 });
    const events: string[] = [];
    driver.onfinished = () => events.push("finished");
    driver.oncancelled = () => events.push("cancelled");
    driver.onprogress = (idx) => {
      if (idx === 5) sim!.triggerAlarm(1); // 硬限位（循环中途确定性注入）
    };

    await driver.plot(LONG_PLAN);

    // 绘制循环经告警拒绝退出（不走 postCancel 软复位路径）
    expect(events).toEqual(["cancelled"]);
    // Alarm 弹窗给出恢复引导
    const alertMock = vi.mocked(alert);
    expect(alertMock).toHaveBeenCalledWith(expect.stringContaining("ALARM:1"));
    expect(alertMock).toHaveBeenCalledWith(expect.stringContaining("笔回原点"));
    // 位置参考不可信
    expect((driver as unknown as { _lastPenPos: unknown })._lastPenPos).toBeNull();
    // 「笔回原点」从 Alarm 恢复：$H 清警并重建参考
    await driver.homePen(LONG_PLAN);
    await gc.waitUntilMotorsIdle(5000);
    expect(sim!.state).toBe("Idle");
    expect((driver as unknown as { _lastPenPos: unknown })._lastPenPos).toEqual(v(0, 0));
  }, 30000);

  test("changeDriveParams 应用硬件档案（Z 抬笔配置）", async () => {
    const { driver } = await makeDriver();
    const { defaultPlanOptions } = await import("../planning.js");
    const dp = JSON.parse(JSON.stringify(defaultPlanOptions.driveParams)) as Parameters<
      WebSerialDriver["changeDriveParams"]
    >[0];
    dp.zPenUpMm = 8;
    driver.changeDriveParams(dp);
    // UI 抬笔传 pct 值（0 = 完全抬笔），同 ui.tsx 口径。
    // 抬笔 pct 50 → Z = zPenUpMm 8 × (1 - 50/100) = 4
    await driver.setPenHeight(PEN_UP, 1000); // 抬笔 → 应用档案后的 zPenUpMm
    await (driver as unknown as { device: GrblController }).device.waitUntilMotorsIdle(5000);
    expect(sim!.wpos.z).toBeCloseTo(4, 3);
  }, 20000);
});
