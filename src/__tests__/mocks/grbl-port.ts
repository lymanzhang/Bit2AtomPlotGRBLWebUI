import { type SerialPortLike } from "../../grbl.js";

/**
 * 可编程 GRBL 设备 mock：记录主机写入的行；autoOk 时对每行自动回 ok；
 * 测试可随时向主机推送任意应答行（pushToHost）、脚本化 `?` 状态回报
 * （statusReplies）或接管任意行的应答（onLine）。
 */
export class MockGrblPort implements SerialPortLike {
  public readable: ReadableStream<Uint8Array>;
  public writable: WritableStream<Uint8Array>;
  /** 主机写入过的行（trim 后；空行 = \r\n\r\n 唤醒） */
  public received: string[] = [];
  public failWrites = false;
  /** 设备侧应答脚本：收到行时自动回 ok；置 false 后由测试手工应答 */
  public autoOk = true;
  /** 收到空行（\r\n\r\n 唤醒）时是否回横幅（false = 模拟波特率不对） */
  public banner = true;
  /** `?` 状态回报脚本：逐个消费；耗尽/未配置时回 defaultStatus */
  public statusReplies: string[] | null = null;
  /** statusReplies 耗尽/未配置时的默认状态回报 */
  public defaultStatus = "<Idle|WPos:1.000,2.000,0.000|FS:0,0>";
  /** 行应答钩子：返回 true 表示已接管该行（跳过 autoOk） */
  public onLine: ((line: string, port: MockGrblPort) => boolean) | null = null;
  public closeCount = 0;
  private controller: ReadableStreamDefaultController<Uint8Array>;

  public constructor() {
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (this.failWrites) throw new Error("GetOverlappedResult failed (mock)");
        const text = new TextDecoder().decode(chunk);
        for (const line of text.split(/\r?\n/)) {
          this.handleWrite(line);
        }
      },
    });
  }

  private handleWrite(line: string): void {
    const trimmed = line.trim();
    this.received.push(trimmed);
    // 空行 = 唤醒（\r\n\r\n）
    if (trimmed === "") {
      if (this.banner) this.pushToHost("Grbl 1.1h ['$' for help]");
      return;
    }
    if (trimmed === "?") {
      const scripted = this.statusReplies?.shift();
      this.pushToHost(scripted ?? this.defaultStatus);
      return;
    }
    if (trimmed === "$$") {
      this.pushToHost("110=8000.000");
      this.pushToHost("111=8000.000");
      this.pushToHost("$13=0");
      this.pushToHost("ok");
      return;
    }
    if (trimmed === "$I") {
      this.pushToHost("[VER:v1.1h.20190825:]");
      this.pushToHost("[OPT:V,15,128]");
      this.pushToHost("ok");
      return;
    }
    if (this.onLine?.(trimmed, this)) return;
    if (this.autoOk) {
      setTimeout(() => this.pushToHost("ok"), 1);
    }
  }

  /** 模拟设备向主机发送任意行 */
  public pushToHost(line: string): void {
    this.controller.enqueue(new TextEncoder().encode(`${line}\r\n`));
  }

  /** 模拟 USB 拔出：读流关闭（node-serialport 断连时读迭代器以 done 结束）；
   * failWritesToo = 后续写入也失败（半开端口完全死亡的完整模拟）。 */
  public simulateUnplug(failWritesToo = false): void {
    if (failWritesToo) this.failWrites = true;
    this.controller.close();
  }

  public close(): Promise<void> {
    this.closeCount++;
    return Promise.resolve();
  }
}
