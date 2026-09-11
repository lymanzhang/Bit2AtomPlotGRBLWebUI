import { beforeEach, describe, expect, it, vi } from "vitest";
import { EBB } from "../ebb";
import { SerialPortSerialPort } from "../serialport-serialport";
import { createMockSerialPort, mockSerialPortInstance } from "./mocks/serialport";

vi.mock("../serialport-serialport", () => ({
  SerialPortSerialPort: vi.fn(function SerialPortSerialPort() {
    return createMockSerialPort();
  }),
}));

describe("EBB", () => {
  beforeEach(() => {
    mockSerialPortInstance.clearCommands();
  });

  it("firmware version", async () => {
    const port = new SerialPortSerialPort("/dev/ebb");
    await port.open({ baudRate: 9600 });
    const ebb = new EBB(port);

    const version = await ebb.firmwareVersion();
    expect(version).toEqual("test 2.5.3");
    expect(mockSerialPortInstance.commands).toContain("V");
  });

  it("enable motors", async () => {
    const port = new SerialPortSerialPort("/dev/ebb");
    await port.open({ baudRate: 9600 });
    const ebb = new EBB(port);

    await ebb.enableMotors(2);
    expect(mockSerialPortInstance.commands).toContain("EM,2,2");
    expect(mockSerialPortInstance.commands).toContain("V"); // Version check for supportsSR()
  });

  it("serial write failure rejects the pending command instead of leaking an unhandled rejection", async () => {
    // Reproduces the field crash: mid-plot USB glitch →
    // "Writing to COM port (GetOverlappedResult): Unknown error code 31" →
    // the write rejection leaked past every catch and Node killed the process.
    const writeError = new Error("Writing to COM port (GetOverlappedResult): Unknown error code 31");
    const encoder = new TextEncoder();
    let responseController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let failWrites = false;
    const port = {
      readable: new ReadableStream({
        start(c) {
          responseController = c;
        },
      }),
      writable: new WritableStream({
        write: async () => {
          if (failWrites) throw writeError;
          setTimeout(() => responseController?.enqueue(encoder.encode("OK\r\n")), 2);
        },
      }),
      close: async () => {},
      addEventListener: () => {},
    } as unknown as SerialPort;
    const ebb = new EBB(port);

    // Sanity: normal command flow works
    await expect(ebb.command("HM,1000")).resolves.toBeUndefined();

    // Simulate the USB glitch: writes now fail
    failWrites = true;
    // The command must reject with the real cause, routed through the command
    // queue (an unhandled rejection would fail the whole vitest run).
    await expect(ebb.command("HM,1000")).rejects.toThrow("GetOverlappedResult");
  });
});
