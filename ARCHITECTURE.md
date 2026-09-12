# Architecture

The application has two main operating modes:

- `IS_WEB` not set (default), where the javascript client in the browser talks to an Express server (HTTP + websocket), which forwards commands to a GRBL controller using NodeSerialPort. This will work for most use cases.
- `IS_WEB=TRUE`, where only static files are served. The javascript client talks directly to the GRBL controller using the WebSerial API. This mode is ideal for hosting on a public site where people can access it from their browser to control a plotter connected to their computer.

There's a third operation mode, which is sending individual instructions to the machine, without displaying any web client or starting a web server. This can be used for development and testing.

A fourth mode needs no hardware at all: `--driver sim` connects the same execution stack to a built-in virtual GRBL device (`src/simulator.ts`), which consumes G-code line by line, models planner backpressure and answers `?`/`$$`/`$I` status queries. All driver selection is done via the global `--driver` option (`grbl` | `sim`).

## Design decision: Plan → G-code translation ("方案 B")

The host still builds a full `Plan` (preview coloring, rewind/补画 algorithms, distance statistics all depend on it). The execution layer only *translates* the Plan to G-code and streams it; the GRBL planner re-plans the actual velocity profile. Consequences:

- Acceleration/speed tuning lives in firmware `$110–$122`, not in the host.
- Duration estimation re-computes path lengths divided by speeds clamped by the hardware profile's `$110–$122` values.
- The host works in millimeters end to end; steps/mm conversion is the firmware's job (`$100–$102`).
- Pen lift is a Z-axis stepper: `PenMotion` → `G1 Z{height} F{feed}`, mapped from the UI pen-height slider via `zaxis.ts`.

## Important Files

- [`src/cli.ts`](src/cli.ts) The main entry point. When called with no commands, it starts an Express Server that serves the compiled static code. The global `--driver` option selects the device kind for `plot`/`pen` commands and the server.
- [`src/server.ts`](src/server.ts) The Express Server definition. It serves these main paths:
  - `/` The static files for compiled UI code.
  - `/plot` To start plotting.
  - `/cancel` To cancel the current plotting task.
  - `/pause` and `/resume` (resume supports rewind-to-path).
  - `/home` Pen-safe return to origin (`$H` when position is unknown).
  - `/grbl/params`, `/grbl/params/write`, `/grbl/unlock` Parameter assistant (read/compare/write `$$`) and Alarm unlock.
  - It also keeps a WebSocket connection with the UI to track drawing progress, broadcast `alarm`/`disconnected` events, and sync the hardware profile (`changeDriveParams`).
- [`src/ui.tsx`](src/ui.tsx) The bulk of the React UI, handles the logic for rendering and interaction. It uses the `BaseDriver` interface to pass instructions to the Express Server. Important parts are:
  - `Root` contains all other components, the state of the UI, and handles most of the interaction events, including the loading of a new SVG or G-code file.
  - The control panel has all the config settings, grouped in components: `PenHeight`, `MotorControl`, `PaperConfig`, the GRBL hardware profile groups (XY/Z drive, pen lift, firmware capabilities, working area), and the parameter assistant.
  - `reducer` manages state and handles the UI interaction flow - i.e. disabling/enabling controls when plotting.
- [`src/drivers.ts`](src/drivers.ts) Interface between UI and machine. `Bit2AtomDriver`, which uses an intermediate server and NodeSerialPort, and `WebSerialDriver`, which uses WebSerial, are both implementations of `BaseDriver`. Both drive a `GrblController` underneath.
- [`src/device-controller.ts`](src/device-controller.ts) The `DeviceController` abstraction (connect/executeMotion/setPenHeight/waitUntilMotorsIdle/cancel/probeAlive/…). The server and UI code are written against this interface, not against any concrete protocol class.
- [`src/grbl.ts`](src/grbl.ts) The GRBL line protocol layer: wake-up handshake and banner parsing (grblHAL detection needs `$I`), strict FIFO `ok`/`error` response matching, character-counting flow control over the RX buffer (default 128 bytes; over-long lines are rejected up front), real-time commands (`?` `!` `~` 0x18) bypassing the queue, `ALARM:` handling that aborts all pending commands, 15 s command timeout with cancel + 500 ms settle period, write-failure abort, and baud-rate probing (`detectBaudRate`).
- [`src/grbl-controller.ts`](src/grbl-controller.ts) Implements `DeviceController` on top of `grbl.ts`: translates and streams motions, tracks pen state, polls `?` until `Idle` for drain confirmation, performs `$H`/`$X`, and feeds Alarm/disconnect events upward.
- [`src/gcode.ts`](src/gcode.ts) The Plan → G-code translation layer. Pen-down segments become `G1 X.. Y.. F..`, travel moves `G0`, pen lifts `G1 Z..`. Maintains a bidirectional motion-index ↔ G-code line map (`motionLineRanges` / `lineToMotion`) used by rewind and progress reporting. G90/G21/G54 conventions are documented and fixed.
- [`src/zaxis.ts`](src/zaxis.ts) Z-axis pen-lift backend: maps the UI pen-percentage to Z heights (`penPctToZMm`), derives lift durations from Z feed, and exposes the Z config derived from the hardware profile.
- [`src/gcode-import.ts`](src/gcode-import.ts) Parses third-party G-code files (lines, arcs with I/J/R and full circles, M3/M4/M5 and Z pen control, G90/G91, G20/G21) into normalized strokes; strokes are converted to `Path[]` (machine coordinates mirrored back to screen space via `planning.machineFramePoint`) and fed through the same `setPaths → replan` pipeline as SVG imports, so layout operations (rotate/align/scale) apply equally. Unsupported words get per-line warnings. Dialect samples live in `src/__tests__/fixtures/`.
- [`src/export-gcode.ts`](src/export-gcode.ts) Exports the finished Plan as standard GRBL G-code, reusing the same translation as the execution layer; the header documents `$100–$102`/`$110`/`$111` suggestions.
- [`src/simulator.ts`](src/simulator.ts) A virtual GRBL device implementing `SerialPortLike`: consumes G-code with planner-depth backpressure, virtual timed execution, status reports, `$H`/`$X`/`$$`/`$I`, and injectable Alarms.
- [`src/planning.ts`](src/planning.ts) Most of the logic of interpreting an SVG-like object and converting it into a `Plan` of machine instructions to execute. It defines attribute interfaces that are used both in the UI and the server, plus the `DriveParams` hardware-profile model and GRBL preset profiles.
- [`src/massager.ts`](src/massager.ts) Some higher-level transformations that can be done like rotating, rescaling (three scale modes: fit / actual size / custom percent), aligning to margins and cropping to margins. Each path carries the index of its source path (`origIndices`) through all transformations: cropping splits one path into several fragments, and the downstream layer filtering / hidden-line removal must look up the original path by that index (never by the fragment's array position).

## When dropping an SVG (or G-code) on the Drawing Area

On `ui.tsx`:

1. The event `ondrop` is triggered on the `Root` component.
2. For an SVG file, it reads the file as a string and calls the `readSvg` function, which parses the text as a DOM object and calls the `flatten-svg` library to convert it into a list of `Line`s, each converted to a `Path` (a list of `Vec2`); the SVG-unit→mm scale is inferred from the root element's `width` (falling back to the 96dpi default).
3. For a G-code file, `parseGcode` (`src/gcode-import.ts`) normalizes it into absolute-millimeter strokes (arcs subdivided) plus warnings/statistics.
4. The `setPaths` function assigns the result into `paths` and groups strokes by layers.
5. Then the paths are converted into a `Plan` - parameterized by the `PlanOptions` on the `usePlan` function`.
  a. It spawns a background `Worker` in `background-planner.ts`
  b. It calls `replan` on `massager.ts` to apply higher level transformations.
  c. Which in turn calls `plan` on `planning.ts` to transform a list of lines and parameters into a list of `PenMotion`s.
6. The plan gets stored in the state of the `Root` component.

## Plot execution flow (server mode)

1. `POST /plot` validates the Plan against the working area (millimeters, 0.1 mm tolerance; soft-limit `$130/$131` cross-check when `$20=1`), writes the task-log header, and starts the motion loop.
2. `GrblController.executeMotion` translates each motion to G-code lines and streams them under character-counting flow control.
3. Pause = stop feeding + drain (`?` polling until `Idle`) + dual-source position verification (host-tracked vs. device WPos, >1 mm logs and corrects `lastPenPos`).
4. Rewind = snap to group start → Z up → `G0` travel → replay from the mapped motion index.
5. Cancel = `!` feed hold immediately freezes the device, the host queue is cleared, then soft reset (0x18) flushes the planner, `$X` unlock if needed, pen up, WPos back-fill.
6. Alarm = abort all pending commands, clear position, broadcast `alarm` with a recovery guide (`$H` or `$X`).
