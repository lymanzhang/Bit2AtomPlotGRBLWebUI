# Bit2AtomPlotGRBL 项目完整介绍

> 本文档是项目的**全景式技术介绍**，覆盖背景、架构设计、坐标系模型、模块职责、可靠性纪律、测试体系与开发指南。
> 快速上手（安装/启动/常用命令）请先阅读 [README.md](README.md)；本文档与其互补，面向希望深入理解或参与开发本项目的读者。

---

## 1. 项目是什么

Bit2AtomPlotGRBL 是面向 **GRBL 固件体系笔式绘图仪**的 Web 控制端。它把一个普通 CNC 体系（Arduino CNC Shield / grblHAL 板卡 + Z 轴步进抬笔机构）变成一台**真正好用的绘图仪**：

- 浏览器里完成 **SVG / G-code 双输入 → 路径预览与排版 → 硬件配置 → 绘制执行 → 漏画补救** 的全流程；
- 绘图仪视角的完整能力：SVG 渲染正确性（transform 全支持）、路径优化、隐藏线去除、暂停回溯重绘、区间补画、防撞轴校验、任务日志——这些在 CNC 工具链里通常缺失；
- 纯 Web 技术栈（Node.js + React），无桌面软件依赖，跨 Windows / macOS / Linux（含树莓派）。

**姊妹项目关系**：本项目是 [Bit2AtomPlotWebUI](https://github.com/lymanzhang/Bit2AtomPlotWebUI)（EBB/AxiDraw 版，Bit2AtomBot）的 **GRBL 独立移植版**。两者共享规划层设计与 UI 交互，执行层完全独立。本项目**不含任何 EBB 兼容路径**（`--driver` 仅 `grbl|sim`），EBB 设备一律由姊妹项目覆盖。

---

## 2. 运行模式

| 模式 | 启动方式 | 说明 |
| --- | --- | --- |
| **服务端模式**（默认） | `node cli.mjs` | Express 服务器（HTTP + WebSocket），服务端经 NodeSerialPort 直连 GRBL 设备，浏览器为纯前端 |
| **WebSerial 直连** | `IS_WEB=1` 构建 | 仅托管静态文件，浏览器经 WebSerial API 直接驱动设备（适合公共站点托管） |
| **模拟器模式** | `node cli.mjs --driver sim` | 内置虚拟 GRBL 设备，无硬件体验全流程（planner 背压、`?`/`$$`/`$I`、可注入 Alarm） |
| **CLI 批处理** | `node cli.mjs plot input.svg` | 不启动 Web 服务器，命令行直接绘制 |

全局 `--driver grbl|sim` 选项统一选择设备类型，作用于 plot/pen 命令与服务器。

---

## 3. 核心设计

### 3.1 方案 B：Plan → G-code 转译

主机仍生成完整 `Plan`（预览着色、回溯/补画算法、距离统计全部依赖它），执行层只把 Plan **转译**为 G-code 流式下发，真实速度曲线交给 GRBL planner 重新规划。

**取舍**：放弃主机端恒加速精调，换取架构简单与广泛硬件适应性。后果：

- 加速度/限速调校完全由设备 `$110–$122` 参数负责；
- 主机时长估算 = 路径长度 ÷（速度按档案 `$110–$111` 钳制），不建模梯形加减速；
- 主机端到端工作在**毫米口径**，steps/mm 换算是固件 `$100–$102` 的职责；
- 抬笔是 Z 轴步进电机：`PenMotion → G1 Z{height} F{feed}`。

### 3.2 坐标系与机器原点（认知一致性核心设计）

这是本项目**预览与实物一致**的关键保障，由三个层层递进的机制构成：

**(a) 屏幕坐标口径（预览/排版空间）**

预览、排版、统计全程工作在屏幕坐标系：原点在纸面左上、+X 向右、+Y 向下。排版语义（居左/居右/居上/居下）永远指**显示器物理方位**，不随硬件配置漂移。

**(b) 机器原点角帧变换（执行空间）**

每台机器的原点位置不同（左上/左下/右上/右下）。用户在「更多设备配置 → 坐标系」中选择原点角后，`planning.ts` 的 `applyMachineFrame` 在**发送前**统一做帧变换：

- 原点在左 → X 恒等；在右 → X 关于纸张竖直中线镜像；
- 原点在上 → Y 恒等；在下 → Y 关于纸张水平中线镜像。

变换保持动作序列、时长、运动索引一一对应（PenMotion 无 XY 坐标原样保留），因此补画区间、进度索引、回溯映射在屏幕空间与机器空间**完全等价**。绘制、补画、归位、G-code 导出统一应用该映射。

**(c) 绘制起点的机器坐标语义**

起点参数（penHome）按机器坐标解释：**相对所选原点角、向纸面内度量，(0,0) 即原点角本身**。切换原点角时绘制起点自动跟随（预览中起点标记随之移动），默认 (0,0) 时 `$H` 归位后笔已处于起点，无长程空程。

**预览联动**：预览标尺刻度按原点角实时换算为机器坐标读数（原点在下 → Y 值向上递增），并以十字标记标出 (0,0) 原点位置与 +X/+Y 方向。用户改动原点设置即刻看到与真机一致的坐标呈现。

### 3.3 字符计数流控（GRBL 执行的可靠性根基)

GRBL 无 per-command 应答缓冲语义，本项目按真实固件行为建模：

- 发送窗口 = RX 缓冲区字节数（默认 128，可配 64–256），按行字节数扣减额度；
- `ok`/`error` 严格 FIFO 配对回收额度，杜绝响应错位；
- 超长行（超过窗口容量）提前拒绝，不发送；
- 全命令 15s 超时纪律：超时即清空队列 + 500ms 沉降期（丢弃孤儿 `ok`），随后执行抬笔/断使能兜底；
- 实时命令（`?` `!` `~` 0x18）绕过队列直发；
- 串口写失败立即中止全部挂起命令。

### 3.4 Z 轴抬笔模型

UI 笔高滑杆为 **pct 口径**（0 = 完全抬笔，100 = 完全落笔），`zaxis.ts` 线性映射到机器 Z 高度（`zPenUpMm` ↔ `zPenDownMm`）；抬笔/落笔速度由 `zFeedMmMin` 决定。Plan 的笔动作统一为 pct 口径，与执行层 Z 映射解耦。

### 3.5 绘制进给速度与固件限速的关系

「绘制进给速度 (mm/s)」（绘制配置）是**绘制作业参数**——它决定每个落笔段 `G1 F..` 的进给值；`$110/$111`（设备配置）是**硬件上限**。执行时 `F = min(进给×60, min($110,$111))`。UI 中的超限校验提示以**档案配置值**为依据（非设备实时 `$$`，设备端手改后请用参数助手「从设备读取」回填）。落笔/抬笔的加速度与转弯系数参数仅用于主机预计时长估算（标注「仅估算」），真实加减速由设备 `$120–$122` 决定。

---

## 4. 模块地图

```
                     ┌─────────────── 浏览器 ───────────────┐
 SVG/G-code 文件 ──▶ │ ui.tsx（React）                       │
                     │  ├─ usePlan → background-planner 工作线程 │
                     │  │    └─ massager.ts → planning.ts    │
                     │  ├─ 预览/着色/回溯滑杆/参数助手        │
                     │  └─ drivers.ts（BaseDriver）          │
                     └──────┬──────────────┬────────────────┘
                     HTTP/WS（服务端模式）   WebSerial（直连模式）
                            ▼              ▼
                     server.ts ──────▶ GrblController（grbl-controller.ts）
                       │                      │
                  串口(NodeSerialPort)    gcode.ts（Plan→G-code 转译）
                       │                      │
                       ▼                      ▼
                   GRBL 设备 ◀────────── grbl.ts（行协议/流控/状态）
                     （或 simulator.ts 虚拟设备）
```

| 模块 | 职责 | 层次 |
| --- | --- | --- |
| `grbl.ts` | GRBL 行协议：握手/横幅判型、ok/error FIFO 配对、字符计数流控、实时命令、ALARM 处理、波特率探测 | 协议 |
| `gcode.ts` | Plan → G-code 转译（方案 B 核心）：G0/G1/G1-Z 生成、motion↔行号双向映射、时长估算 | 转译 |
| `gcode-import.ts` | 第三方 G-code 导入：直线/圆弧（I/J/R/整圆）、M3/M4/M5 与 Z 笔控、G90/G91、G20 英寸换算、方言兼容 | 解析 |
| `export-gcode.ts` | G-code 成果导出，与执行路径同一转译器（口径必然一致） | 导出 |
| `zaxis.ts` | Z 轴抬笔后端：pct→Z 高度映射、抬笔时长 | 设备 |
| `grbl-controller.ts` | DeviceController 实现：动作流式执行、笔态跟踪、`?` 排空确认、`$H`/`$X` | 控制器 |
| `simulator.ts` | 内置虚拟 GRBL 设备：planner 背压、状态回报、`$$`/`$I`、可注入 Alarm | 模拟 |
| `device-controller.ts` | 设备控制接口抽象（connect/executeMotion/cancel/probeAlive/…） | 抽象 |
| `planning.ts` | 运动规划内核（Plan）、硬件档案模型（DriveParams）、GRBL 预设、`applyMachineFrame` | 规划 |
| `massager.ts` | 路径预处理：旋转/三态缩放/对齐/裁剪/图层过滤/消隐集成（origIndices 随路径拆分传递） | 预处理 |
| `hiding.ts` | 隐藏线去除 | 预处理 |
| `util.ts` | 几何工具：scaleToPaper/alignToMargins/cropToMargins（Liang-Barsky 裁剪）、SVG 单位换算 | 工具 |
| `server.ts` | Express 服务器：REST API、WebSocket 进度/事件广播、任务日志、超界校验 | 服务 |
| `drivers.ts` | UI↔设备桥：Bit2AtomDriver（服务端）/ WebSerialDriver（直连） | 桥接 |
| `ui.tsx` | React 全中文界面：状态机 reducer、预览、控制面板、参数助手 | UI |

---

## 5. 数据流：从文件到动作

以拖入 SVG 为例（G-code 导入在第 1 步由 `parseGcode` 归一化为笔画路径后汇入同一管线，排版操作同等生效）：

1. **解析**：`flatten-svg` 将 SVG 展平为路径列表（transform 6 种变换函数任意深度复合，与浏览器原生精度一致）；从根元素 `width` 推断 SVG 单位→mm 换算系数（缺省 96dpi）。
2. **预处理**（massager.ts，背景工作线程）：旋转 → 三态缩放（等比/1:1/自定义比例）→ 九宫格对齐 → 边距裁剪（Liang-Barsky 逐线段求交，路径可拆分为多条碎片，每条碎片携带 `origIndices` 原始索引）→ 图层过滤 → 隐藏线去除 → 去重/排序/短路径剔除/近端拼接。
3. **规划**（planning.ts `plan`）：路径列表 + 笔位/速度参数 → `Plan`（XYMotion 序列 + PenMotion 抬落笔，毫米口径，含恒加速速度曲线供预览时长估算）。
4. **预览**：SVG 渲染 + 按绘制进度着色（白色未画 → 彩色已画，水位线保持「画过」状态）+ 机器坐标标尺。
5. **执行**：`applyMachineFrame` 帧变换 → `translatePlanToGCode` 转译 → 字符计数流控下发。

---

## 6. 绘制执行流程（服务端模式）

1. **校验**：`POST /plot` 按工作区（毫米，0.1mm 容差）与软限位（`$20=1` 时对照 `$130/$131`）预检，超界拒绝并预览标红；未连接设备返回 409 拒绝。
2. **执行**：逐动作转译 G-code，字符计数流控下发；进度经 WebSocket 推送 UI 着色。
3. **暂停**：停止进给 + `?` 轮询排空至 `Idle` + **位置双源校验**（主机跟踪位置 vs 设备 WPos 实测，偏差 >1mm 记日志并修正 `lastPenPos`）。
4. **回溯重绘**：回溯到目标路径组 → Z 抬笔 → `G0` 空程 → 从映射的运动索引重放；显式记录「回溯：进度 起点 → 目标（抬笔行程 xx mm）」日志。
5. **补画**（绘制结束后）：双滑块选择路径区间，仅重绘选中段。
6. **完成/取消**：
   - 完成：按 `lastPenPos` 生成回程动作归位（不依赖 `$H`）；
   - 取消：`!` 进给保持 → 清队列 → 0x18 软复位冲刷 planner → 必要时 `$X` → 抬笔 → WPos 回填；
   - Alarm：立即中止全部挂起命令（不空等超时）、位置失效、广播恢复引导（`$H` 归位 / `$X` 解锁）。
7. **断连保护**：USB 拔出/串口错误立即中止、位置失效、UI 弹窗；服务端模式 5s 周期自动重连。

---

## 7. 可靠性纪律清单

以下是贯穿全项目的硬性约束（违反任何一条都会在实际绘制中造成事故）：

- 通信层所有命令必须设超时；超时后清队列 + 500ms 沉降期，再发送兜底命令；
- 异常路径必须先抬笔到安全高度，再断使能；
- LM/长行程速率必须钳制（防 32 位相位累加器溢出——继承自姊妹项目的教训）；
- 图层/补画状态切换必须清空回溯区间与补画模式，避免脏状态；
- 每次绘制任务生成与源文件同名的日志文件（`logs/[文件名]__<时间戳>.log`），任务头/过程事件/任务尾完整留痕；
- 任务头预计距离与任务尾实际距离同口径统计（仅笔落段）；
- 服务重启/归位失败后位置标记为未知，`/home` 经 `$H` + WPos 回填转为已知。

---

## 8. UI 结构

控制面板分为两大折叠区（默认收起保持简洁）：

- **更多绘制配置**：绘制进给速度（执行参数）、落笔/抬笔参数（仅估算，附灰色小说明）、路径优化（点合并/路径拼接半径、最短路径、隐藏线去除）、排版（三态缩放、九宫格、自定义偏移）、旋转；
- **更多设备配置**：硬件列表与档案、传动参数（XY/Z）与抬笔、固件能力（自动探测/手动指定、最大速度/加速度 X/Y/Z）、坐标系（机器原点角）、工作区、参数助手（`$$` 实值对照/一键写入/反向同步）、保存/删除配置。

**状态配色约定**：模拟绘制、开始绘制、补画模式三个关键按钮未激活时为蓝色，激活/进行中变为红色，以凸显状态与重要性。

预览区：纸张边框 + 网格 + 机器坐标标尺 + 原点十字标记 + 进度着色 + 超界标红。

---

## 9. 测试与质量保障

- **测试框架**：vitest，当前 **174 个用例**（25 个文件，+1 skipped）全部通过，`npm test`。
- **分层策略**：
  - 单元：协议层（`grbl.test.ts` 21 例）、转译层（`gcode.test.ts` 10 例）、规划/几何（planning/util/machine-frame/pen-home-origin）；
  - 回归专项：裁剪-图层索引映射（crop-layer-filter）、4 方言 G-code round-trip（import→export→re-import 几何等价 ≤0.002mm）、SVG 导出/导入往返几何指纹（svg-roundtrip：旋转标记语义、多轮循环稳定）、G-code 导入排版与帧变换（gcode-layout/gcode-frame）、SVG 单位换算（svg-unit-scale）；
  - 集成：虚拟设备全流程（server-grbl 15 例：并发拒绝/取消解锁/暂停校验/回溯重绘/Alarm 中止/软限位协同）、参数助手（server-grbl-params）、WebSerial 驱动模拟（webserial-driver）；
  - 模拟器行为：planner 背压、`$$` 读写、penPct→Z 映射（simulator.test.ts）。
- **静态检查**：biome，当前 **0 告警**（`npm run lint`）。
- **构建**：TypeScript 服务器 + esbuild 前端，`npm run build` 零错误。

---

## 10. 开发指南

### 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm start` | 构建 + 启动 |
| `node cli.mjs --driver sim` | 模拟器模式启动 |
| `npm run build` | 完整构建（服务器 + 前端） |
| `npm run lint` | biome 静态检查 |
| `npm test` | vitest 全量测试 |

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `BIT2ATOM_LOG_DIR` | 日志目录（默认 `logs/`，自动保留最近 50 个） |
| `BIT2ATOM_NO_FILE_LOG` | 置 1 禁用文件日志（仅终端输出） |
| `IS_WEB` | 置 1 启用 WebSerial 直连构建（`npm run start-webserial`） |

### 代码约定

- 模块为 ESM（`"type": "module"`），导入带 `.js` 后缀；
- 中文注释承载设计意图与历史教训（关键算法处标注回归测试文件名）；
- 提交前必须通过：`npm run lint` + `npm test` + `npm run build`；
- 每次行为变更同步补记 [CHANGELOG.md](CHANGELOG.md)。

### 文档索引

| 文档 | 定位 |
| --- | --- |
| [README.md](README.md) | 快速上手：定位、功能、安装启动、Z 轴配置指南 |
| [PROJECT_INTRODUCTION.md](PROJECT_INTRODUCTION.md) | 本文档：全景式技术介绍 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 架构细节：运行模式、设计决策、重要文件、执行流程 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |
| [GRBL_PORT_PLAN.md](GRBL_PORT_PLAN.md) | 移植开发总纲（任务拆解与技术备忘） |
| [docs/DEVICE_NOTES.md](docs/DEVICE_NOTES.md) | 目标设备调研记录（固件差异/传动换算/预设档依据） |
| [docs/RELEASE.md](docs/RELEASE.md) | 发布流程 |

---

## 11. 版本与发布

- 当前版本 **v0.1.0**（首个 GRBL 移植版），发布历史见 CHANGELOG.md；
- 发布前检查单：版本号一致性（package.json / CHANGELOG / 提交历史 / git tag）、全量测试 + lint + build 通过、发布包文档齐全；
- 详细流程见 [docs/RELEASE.md](docs/RELEASE.md)。

---

## 12. 许可证与致谢

**AGPL-3.0-only**。本项目派生自 [SAXI](https://github.com/alexrudd2/saxi)（AGPL-3.0），基于本项目的修改与分发须遵循该协议的开源义务。

致谢：[SAXI](https://github.com/alexrudd2/saxi)（基础框架）、[Bit2AtomPlotWebUI](https://github.com/lymanzhang/Bit2AtomPlotWebUI)（EBB 姊妹项目）、[GRBL](https://github.com/grbl/grbl) 与 [grblHAL](https://github.com/terjeio/grblHAL)（目标固件生态）、[axi](https://github.com/fogleman/axi)（运动规划算法启发）。
