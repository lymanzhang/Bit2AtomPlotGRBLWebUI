# Bit2AtomBot 项目技术报告

> 基于 SAXI 深度改进的 AxiDraw 笔式绘图仪 Web 控制系统
>
> 本报告版本对应 Bit2AtomBot v0.17.1 ｜ 对比基线：saxi-main（v0.17.1，https://github.com/alexrudd2/saxi）

---

## 1. 项目概述

### 1.1 项目定位

Bit2AtomBot 是一款基于 Web 的笔式绘图仪控制系统，支持 AxiDraw V3 / Brushless、NextDraw 2234、iDraw H SE 及任意兼容 EBB 固件的自定义设备。用户在浏览器中完成从 SVG 加载、路径预览、参数调整到设备驱动的全流程操作。

### 1.2 与 SAXI 的关系

本项目以开源项目 SAXI（AGPL-3.0）为基础进行深度改进。SAXI 提供了优秀的整体框架——Express + WebSocket 服务端、EBB 串口协议层、恒加速度运动规划、React 预览界面。本项目在完整保留该框架的基础上，针对实际使用中遇到的真实痛点做了系统性的功能扩展与工程化改造：

| 改进维度 | 具体内容 |
| --- | --- |
| **渲染正确性** | SVG transform 完整支持（SAXI 会静默丢弃变换） |
| **绘制容错** | 暂停回溯重绘（SAXI 只有暂停/继续，无法回溯） |
| **绘制质量** | 隐藏线去除（SAXI 无此功能） |
| **硬件适配** | 自定义传动参数（SAXI 仅固定预设） |
| **成果输出** | SVG 导出（SAXI 无此功能） |
| **本地化** | 全中文界面、暗色主题、网格标尺、品牌化 |
| **架构精简** | 移除云端生图依赖，纯本地运行 |

### 1.3 代码规模对比

| 模块 | SAXI | 本项目 | 增量说明 |
| --- | ---: | ---: | --- |
| ui.tsx（界面） | 1304 | 1873 | +44%，回溯控制/着色/网格标尺/硬件配置/导出等 |
| style.css（样式） | 385 | 712 | +85%，中文化排版/暗色主题/回溯控件/网格标尺 |
| planning.ts（运动规划） | 675 | 769 | +94 行：回溯核心算法 + 自定义传动参数 |
| drivers.ts（驱动层） | 262 | 310 | +48 行：回溯执行 + 串口恢复 |
| server.ts（服务端） | 379 | 407 | +28/-47 行：回溯接口，移除 SVG.IO |
| massager.ts（路径预处理） | 98 | 143 | +45 行：隐藏线去除集成 + 自定义 stepsPerMm |
| ebb.ts（EBB 协议） | 511 | 509 | hardware 类型扩展 + 品牌化 |
| **hiding.ts（新增）** | — | 181 | 隐藏线去除算法 |
| **export-svg.ts（新增）** | — | 68 | Plan → SVG 导出 |
| **rewind.test.ts（新增）** | — | 6 用例 | 回溯功能专项测试 |
| 测试总计 | 20 用例 | 26 用例 | 新增回溯专项 6 个 |

---

## 2. 体系架构

### 2.1 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│                      浏览器（React UI）                       │
│                                                             │
│  ui.tsx ──→ plan.worker.ts ──→ background-planner.ts        │
│    │         （Web Worker 后台规划，避免阻塞 UI）              │
│    │                                                        │
│    ├─ SVG 解析（readSvg + 自研 transform 矩阵引擎）           │
│    ├─ 路径预处理（massager.ts：排序/合并/隐藏线去除/缩放）      │
│    ├─ 运动规划（planning.ts：恒加速度梯形/三角形速度曲线）       │
│    └─ 预览渲染（SVG DOM：着色/进度/回溯高亮/网格标尺）          │
│                                                             │
│  ┌────────────── 服务端模式 ──────────┐  ┌── WebSerial 模式 ──┐ │
│  │ Bit2AtomDriver (WebSocket)        │  │ WebSerialDriver    │ │
│  └──────────────┬────────────────────┘  └────────┬───────────┘ │
└─────────────────┼────────────────────────────────┼─────────────┘
                  │ ws:// :9080                    │ navigator.serial
┌─────────────────▼────────────────────┐  ┌────────▼─────────────┐
│         server.ts（Express+WS）       │  │   浏览器直连 USB      │
│  /plot /pause /resume(rewindTo)      │  │                      │
│  doPlot：可重定位执行循环              │  │                      │
└─────────────────┬────────────────────┘  └────────┬─────────────┘
                  │        Node SerialPort          │
                  └──────────────┬──────────────────┘
                                 ▼
                    ┌────────────────────────┐
                    │  ebb.ts（EBB 协议层）    │
                    │  LM/XM 指令自适应        │
                    │  运动指令 FIFO 深度管理   │
                    └───────────┬────────────┘
                                ▼  USB Serial
                    ┌────────────────────────┐
                    │  EBB 控制板 / 绘图仪     │
                    └────────────────────────┘
```

### 2.2 双驱动模式

继承 SAXI 的双模式设计并统一扩展回溯能力：

| | 服务端模式（默认） | WebSerial 模式 |
| --- | --- | --- |
| 驱动类 | `Bit2AtomDriver`（由 SAXI 的 `SaxiDriver` 改名） | `WebSerialDriver` |
| 通信 | Express HTTP + WebSocket | Chrome/Edge `navigator.serial` |
| 适用 | 树莓派/服务器远程控制、手机平板访问 | 免 Node.js，纯浏览器 |
| 回溯支持 | ✅ `/resume { rewindTo }` | ✅ `resume(rewindTo)` |

### 2.3 关键数据流

1. **加载**：SVG 文本 → `readSvg()`（flatten-svg 展平 + 自研变换矩阵应用）→ `Path[]`
2. **规划**（Web Worker 中执行）：`replan()` → 图层过滤 → 隐藏线去除（可选）→ 路径排序/合并/去重 → 毫米→步数换算 → `plan()` 生成 `Plan`（`Motion[]`：抬笔移动/落笔/绘制/抬笔 四动作一组）
3. **执行**：驱动层逐动作下发 EBB 指令，实时回报 `motionIdx` 进度
4. **回溯**：暂停态下发 `rewindTo` → 服务端/驱动计算安全移动 → 重放后续动作

---

## 3. 继承自 SAXI 的基础能力

以下能力来自 SAXI 框架，本项目保留并按需增强（此处简述，详见 SAXI 文档）：

- **恒加速度运动规划**：梯形/三角形速度曲线，拐角速度优化（cornering factor），路径排序（最小化抬笔空跑）、路径合并、短路径过滤、去重点
- **EBB 协议层**：LM（低层恒加速）与 XM（高层匀速）指令按固件版本自适应；运动指令 FIFO 深度管理（`BIT2ATOM_FIFO_DEPTH`，原 `SAXI_FIFO_DEPTH`）
- **纸张尺寸体系**：内建 A/B 系列及自定义尺寸
- **图层控制**：按 stroke 颜色 / group ID 分层选择绘制
- **模拟绘制**：无硬件时按真实速度曲线模拟
- **CLI 批处理**：`node cli.mjs plot input.svg --paper-size A4 --margin 15`
- **Web Worker 后台规划**：复杂图形规划不阻塞 UI

---

## 4. 本项目的独有功能（重点）

### 4.1 SVG transform 完整支持 ★

**问题背景**：SAXI 使用 `flatten-svg` 库解析 SVG，该库依赖 `element.getCTM()` 获取变换矩阵。但 `getCTM()` 只对已挂载到 DOM 的元素有效——服务端/Worker 中用 `DOMParser` 解析的 SVG 未挂载，`getCTM()` 恒返回单位矩阵，**所有 transform 被静默丢弃**。结果是 Affinity Designer、Illustrator 等软件导出的含 `transform` 的 SVG（尤其非等比缩放图形）被按变换前的原始坐标绘制，图形比例失真、偏出纸张。

**解决方案**：在 [ui.tsx](src/ui.tsx) 中自研一套变换矩阵引擎，与 `flattenSVG` 输出配合：

- `collectSvgMatrices(svg)`：从根元素深度优先遍历，对每个图形元素复合其祖先链上的全部变换，产出 `Map<Element, SvgMatrix>`
- `parseTransform()`：完整支持 SVG 规范全部 6 种变换函数——`matrix` / `translate` / `scale` / `rotate`（含 `rotate(a cx cy)` 三参数形式）/ `skewX` / `skewY`，以及空格/逗号混合分隔的参数格式
- `enumShapes()`：按文档顺序枚举图形元素（`rect`/`circle`/`ellipse`/`path`/`line`/`polyline`/`polygon`），保证与 `flatten-svg` 的输出路径一一对应；对多子路径的 `<path>` 直接解析 `d` 属性统计 `M`/`m` 命令数进行对齐（早期版本依赖 `SVGPathElement.getPathData()`，但该方法并非标准浏览器 API，flatten-svg 内置的 polyfill 只导出独立函数、不改写原型，导致浏览器中子路径数恒为 1、复合路径除首个子路径外全部丢失矩阵变换—— Affinity 导出的单 `<path>` 含数百个 `M` 子路径的文件会被拆成两块）
- `applyMatrixToPath()`：将复合矩阵应用到路径坐标点（含数组下标与 `x`/`y` 属性双写，兼容 flatten-svg 的点结构）

**验证**：矩阵复合结果与浏览器原生 `getCTM()` 逐项比对，精度达 1e-9；Affinity 导出的多层嵌套 `matrix` 文件输出与独立 Python 烘焙脚本结果完全一致。

**已知限制**：不支持 `<use>`/`<defs>` 引用间接展开；嵌套 `<svg>` 的 `x/y/width/height` 视口设置按 `<g>` 处理。

### 4.2 暂停回溯重绘 ★★（核心独有功能）

**问题背景**：长时间绘制中，笔出墨不畅会导致漏画，且往往发现时已漏画了大量线条。SAXI 只有「暂停/继续」，无法补救；整幅画只能废弃重画。

**功能行为**：绘制中随时「暂停」（在当前笔画结束、抬笔状态下安全停下）→ 拖动滑块选择回溯点 → 预览中以**橙色**高亮从回溯点到暂停点的全部待重绘线条 → 点「从第 X 条路径重绘并继续」，绘图仪抬笔安全移动到回溯点并从该处重绘；重绘中线条随进度**由橙转红**。支持连续多次回溯（重绘中可再暂停再回溯，区间叠加记录）。绘制完成后界面保持完成任务状态，**红色重绘标记持续保留**，供用户对照检查重复绘制区域，直到开始新绘制/取消/清除 SVG 才复位。

**技术实现**（横跨规划、服务端、驱动、UI 四层）：

**(1) 规划层——[planning.ts](src/planning.ts) 回溯算法**

- `pathGroupStarts(plan)`：利用 `plan()` 为每条路径生成固定 4 动作组 `[抬笔移动, 落笔, 绘制, 抬笔]` 的结构特征，识别组起点 = 「`XYMotion` 后紧跟落笔 `PenMotion`（initialPos > finalPos）」的索引。组起点即合法回溯点，保证恢复点总是"抬笔状态下从静止起步的移动动作"
- `snapToGroupStart(plan, motionIdx)`：将用户选择的任意索引向下吸附到最近组起点，杜绝从半截路径恢复导致的速度规划异常
- `rewindTravelMotion(plan, from, to)`：回溯安全移动的加速度/速度参数**直接提取自计划自身的抬笔移动段**（`vInitial===0 && accel>0` 的块），自动匹配当前机器配置；并带保守兜底参数

**(2) 服务端——[server.ts](src/server.ts) 可重定位执行循环**

- `doPlot()` 由 SAXI 的 `for` 循环改为 `while` 循环：暂停解除时若存在 `pendingRewind`，先广播 `pause:false`（UI 退出暂停态），再执行抬笔安全移动到目标组起点，`idx` 跳转后 `continue` 重放
- 关键细节：**回溯分支也必须广播 `pause:false`**——否则 UI 停留暂停态，无法在重绘中发起第二次暂停/回溯（连续回溯即失效）。该问题通过集成测试「consecutive rewinds」固化
- `curPos` 从第一个 XY 动作的 `p1` 初始化，逐动作跟踪笔位置，供回溯移动起点计算

**(3) HTTP/WS 接口**

- `POST /resume`：请求体支持 `{ rewindTo: motionIdx }`（SAXI 为无参数的纯恢复）；`/cancel` 时清空 `pendingRewind`

**(4) 驱动层——[drivers.ts](src/drivers.ts)**

- `WebSerialDriver.resume(rewindTo?)` / `Bit2AtomDriver.resume(rewindTo?)`：签名扩展，WebSerial 模式内实现同样的重定位逻辑（含 `onpause(false)` 修复），两种模式行为一致
- 附带修复：`WebSerialDriver.connect()` 打开串口前若 `port.readable` 已存在（上次会话未正常关闭），先 `close()` 再打开，避免 "Failed to open serial port" 错误

**(5) UI 层——[ui.tsx](src/ui.tsx) 回溯控制条与四色状态**

- 暂停时显示回溯控制条：`pathGroupStarts` 生成滑块刻度、显示「从第 X 条路径重绘并继续」按钮与重绘范围说明
- 预览着色状态机（对每个动作索引判定）：
  - 橙色（`--canvas-stroke-rewind-pending`）：回溯范围内尚未重绘到的落笔线（暂停选择时为整个区间 `[组起点, 暂停组终点)`，而非单条路径）
  - 红色（`--canvas-stroke-rewind`）：已重绘完成的落笔线；任务完成后保留显示
  - 深灰/蓝/淡白：原有绘制进度着色（已完成/正在绘制/未绘制）
- `redrawnRanges` 状态数组叠加记录各次回溯区间，连续多次回溯的重复绘制区域全部可见
- 深浅两套主题分别配色，`useReducer` 集中管理，新绘制/取消/清除时复位

**(6) 测试**：[rewind.test.ts](src/__tests__/rewind.test.ts) 专项覆盖算法函数；[server.test.ts](src/__tests__/server.test.ts) 集成覆盖「暂停→回溯→重放」「连续两次回溯」全流程（验证重放命令数 ≥ 正常绘制）。

### 4.3 隐藏线去除 ★（SAXI 无此功能）

新增 [hiding.ts](src/hiding.ts)（181 行），思路源自 AxiDraw Inkscape 扩展的 `clipping.py`：

- 算法：按 z 序自底向上遍历路径；对每条**有填充**的路径，用其轮廓（`polygon-clipping` 库做差集运算）裁剪其**下方**所有路径；裁剪后移除纯填充路径（它们只充当裁剪模版）
- 支持填充规则（`nonzero`/`evenodd`）、闭合环自动确保、描边/填充有效性判定（`none`/`transparent` 排除）
- **与图层选择的正确交互**（[massager.ts](src/massager.ts) 中关键设计）：启用隐藏线去除时，图层过滤**延迟到裁剪之后**执行。若先过滤（如只选描边层），未选中图层的填充路径就参与不了裁剪，会导致遮挡关系失效。裁剪结果通过 `originalIndex` 回溯原始路径归属，保证过滤语义正确
- 可通过 `hiding` 开关启用/关闭

### 4.4 SVG 导出 ★（SAXI 无此功能）

新增 [export-svg.ts](src/export-svg.ts)：

- `planToSvg(plan, stepsPerMm, paperSize)`：从运动计划反向重建 SVG——只取落笔状态下的 `XYMotion`，由运动块重建折线点列，步数→毫米换算，去重相邻点
- 导出结果包含路径优化（排序/合并/去重）与隐藏线去除的全部效果，即"所见即所得"的最终绘制成果
- UI 预览区一键下载 `export.svg`

### 4.5 自定义硬件与传动参数 ★（SAXI 仅固定预设）

**问题背景**：SAXI 的 `Hardware` 是闭集枚举（v3/brushless/nextdraw-2234），`stepsPerMm` 硬编码于设备定义，无法适配自制或非标绘图仪。

本项目改造：

- `Hardware` 类型扩展为 `"v3" | "brushless" | "nextdraw-2234" | "idraw-h-se" | "custom"`，并进一步放宽为 `string` 以容纳任意命名配置
- `DriveParams` 参数组：步距角（°）、驱动细分、同步轮齿数、同步带齿距（mm）、配置名称
- 物理换算公式开放：`stepsPerMm = (360 / 步距角) / (齿数 × 齿距)`，`computeStepsPerMm` / `computeMicrostepsPerMm` 实时计算；UI 即时显示换算结果
- 配置持久化到浏览器 localStorage，下拉框「── 新建自定义 ──」创建，保存后直接选用
- **全链路生效**：`massager.ts` 中路径缩放、速度/加速度规划、笔起始点全部改用 `effectiveStepsPerMm`（内置硬件用设备定义值，自定义硬件用计算值），规划精度与物理运动一致
- `Device` 重命名为 `getDevice` 以反映其函数语义

### 4.6 交互与可视化增强

- **全中文界面**：全部操作面板、按钮、提示中文化
- **暗色主题**：`data-theme="dark"` 全套 CSS 变量（含预览线色、网格、标尺），偏好持久化
- **网格与标尺**：绘制区 5mm/10mm 双级网格（SVG `<pattern>`），四边毫米刻度标尺，便于对位观察
- **进度条增强**：百分比 + 「路径 X / Y」计数，实时掌握进度
- **总路径统计**：`Plan.totalDistance()` 实时显示走笔总路程
- **清除 SVG**：预览区一键清除，方便更换文件
- **预计时长/剩余时间**、暂停/继续/取消贯穿绘制与模拟全程
- **排版设置（placement）**：水平/垂直定位锚点（左中右 × 上中下）+ 自定义 X/Y 偏移，「适应页面」（`scaleToPaper`）与「对齐边距」（`alignToMargins`）两种缩放模式均按锚点计算偏移；UI 独立分区展示，缺省居中行为与旧版一致
- **标尺拖拽防误选**：预览画布与标尺 `user-select: none` + 指针按下 `preventDefault`，缩放/平移拖拽中刻度数字不再被浏览器选中文本变蓝

### 4.7 架构精简与去依赖化

- **移除 SVG.IO 云端生图**：SAXI 内置 `/generate` 接口调用 svg.io API 以文生图（需 API Key）。本项目整体移除该功能（含 `svgioEnabled` WS 消息、CLI `--svgio-api-key` 参数），实现纯本地运行，无外部服务依赖、无隐私外传
- 新增依赖仅 `polygon-clipping`（隐藏线去除），UI 侧零新增运行时依赖——transform 引擎、回溯算法、导出器均为自研

### 4.8 工程化改进

- **品牌化**：`saxi` → `bit2atombot`（包名/CLI 命令/日志前缀/环境变量 `SAXI_*` → `BIT2ATOM_*`），自定义 logo
- **测试扩充**：vitest 用例从 20 → 41，新增回溯专项（算法单元 + 服务端集成 + 连续回溯场景）、补画归位集成场景、排版锚点（placement）单元、串口写入失败回归与模拟模式（无设备）回归用例
- **Lint 零告警**：清理全部 10 项历史遗留（4 处 `parseInt` 缺 radix、4 处失效的 biome-ignore/eslint-disable 注释、useEffect 多余依赖、CSS 降序特异性），biome 检查 30 文件 0 error / 0 warning / 0 info
- **分发包**：跨平台源码包（install/start 脚本、预构建产物、发布说明），支持 Windows/macOS/Linux

### 4.9 区间补画与归位可靠性 ★★（核心独有功能）

**问题背景**：整幅绘制结束后发现局部漏画，只能整图重画；补画后笔停在终点不归位，影响取纸和下一次补画的位置跟踪。更隐蔽的是 EBB 串口命令队列可能因丢失响应而"卡死"——命令永远排队、笔一动不动且无任何报错。

**(1) 区间补画**（服务端 `POST /redraw { from, to }`，WebSerial `redraw()` 对等实现）

- 绘制结束（或取消）后，UI「补画模式」双滑块选中路径区间，橙色高亮预览，与纸上实际笔迹对照
- `from` 经 `snapToGroupStart()` 对齐到路径组起点（抬笔静止起步）；执行时先抬笔安全移动（`rewindTravelMotion`）到区间起点，再仅重放 `[from, to)` 的动作
- `redrawnRanges` 叠加记录各次补画区间，红色标记持续保留至新绘制/图层切换/清除 SVG；补画中线条由橙转红
- 前置校验：`plotting` 进行中 / 无历史计划 / 笔位置未知（`lastPenPos == null`，如服务重启）分别返回 400/409 并提示先「笔回原点」

**(2) 归位机制——`HM` 命令的陷阱**（实测定位的关键固件行为）

- EBB 固件中 `EM`（使能电机）会**重置位置计数**：补画开头经历 `disableMotors`/`enableMotors` 循环后，EBB 的"绝对原点"已变成补画起点，此时 `HM` 是零移动空操作（日志显示归位成功但笔不动）
- 修复：归位改用与补画起始行程相同的手法——`rewindTravelMotion(plan, lastPenPos, home)` 生成基于**应用层已知位置**的抬笔移动命令（`LM`），不依赖 EBB 的原点状态；仅当位置完全未知时才 best-effort 尝试 `HM`
- 正常整图绘制的归位不在此列：绘制全程电机保持使能，计划末尾的返回原点移动和取消路径中的 `HM` 均安全

**(3) 归位可靠性加固**（[server.ts](src/server.ts) `homePenNow` / [drivers.ts](src/drivers.ts) `homePen`）

- **通信探活**：归位前先用短超时 `QM` 探测命令队列；失败则 `ebb.cancel()` 清空队列、等待 700ms 沉降期（覆盖 500ms 的孤儿响应排空窗口）后重试一次，仍失败才报错——把"静默卡死"转化为可诊断、可自愈的故障
- **失败恢复**：归位失败时 `lastPenPos = null`（位置不可信，下次操作前强制重新归位）、清空命令队列、兜底 `disableMotors` 防止锁轴；服务端通过 WS 广播错误，UI 弹窗提示用户点击「笔回原点」重试
- **超时全覆盖**：所有关键 EBB 调用（`executeMotion`/`setPenHeight`/`enableMotors`/`waitUntilMotorsIdle`/`HM`/行程归位等）均加 `withTimeout` 包装——常规命令 15s、长行程 150s，超时只在队列卡死/串口异常时触发；UI 抬笔/落笔/松弛电机等 fire-and-forget 操作（`setPenHeight`/`limp`）同样加超时与错误弹窗，杜绝 unhandled rejection
- **断开连接即时恢复**（WebSerial 直连模式）：设备拔出或串口断开时，`handleDisconnection` 立即清空 EBB 命令队列（挂起命令马上 reject，而非干等 15~150s 超时）、将 `_lastPenPos` 置为未知、并 reject 暂停中 plot 循环等待的 unpause promise——绘制/补画循环立即落入 catch 触发 `oncancelled`，UI 不会卡在"绘制中/暂停中"状态
- **异步异常兜底**：`/plot`、`/redraw` 的 `doPlot` 阶段（响应已发出后）捕获异常并广播 `cancelled`，UI 不会永久卡在"绘制中"；WebSerial 模式 `plot()`/`redraw()` 同样 catch 后 `oncancelled()` + 弹窗，`homePen()` 失败置位置为未知并重抛
- **串口写入失败兜底**（服务端模式）：EBB 命令 generator 中的 `write()` 此前不等待串口写入结果，USB 瞬断等导致的写入失败（Windows 报 `GetOverlappedResult` 错误码 31）会以 unhandled rejection 击穿 Node 进程（默认视为致命错误），绘制数小时后服务静默退出。现 `write()` 捕获写入错误并注入命令队列（挂起命令立即以真实原因 reject，进入既有的超时/错误广播链），读流错误同样不再 re-throw；`SerialPortSerialPort` 补挂 NodeSerialPort `error` 事件监听（无监听器的 `error` 事件会同步抛出杀进程）；`startServer` 另挂 `process.on("unhandledRejection")` 日志兜底——杂散 rejection 只记日志，不再终止长时绘制任务

**(4) 归位耗时监控**

`homePenNow` 输出分步耗时统计，总耗时与各阶段（probe/pen/motors/travel/idle/disable）一目了然：

```
Home: done in 12.3s (probe 0.1s, pen 1.0s, motors 0.1s, travel 9.8s, idle 1.2s, disable 0.1s).
```

travel 阶段异常变慢往往意味着机械阻力增大或固件通信退化，可据此提前发现硬件问题；失败时同样输出分步耗时便于定位卡在哪个环节。

**(5) 测试**：[server.test.ts](src/__tests__/server.test.ts) 集成覆盖「补画后以 `LM` 行程归位（且禁止 `HM`）」「补画后电机二次使能」「笔已在原点时 `/home` 为安全空操作」。

### 4.10 缩放模式三态与 SVG 真实尺寸检测 ★

**问题背景**：旧版只有一个「适配页面」布尔选项，图形小于纸张绘图区域时也会被强制等比放大铺满，用户想按实际尺寸绘制反而做不到；且 SVG 用户单位按 CSS 规定固定为 1/96 英寸，只有 96dpi 导出的文件才能 1:1 还原物理尺寸，其他 DPI 导出会整体放大/缩小。

本项目改造：

- **三态缩放**：`PlanOptions.scaleMode: "fit" | "actual" | "custom"`（替代原 `fitPage` 布尔值，旧版持久化数据自动迁移）——`fit` 等比缩放到纸张绘图区域（默认，行为不变）；`actual` 按 1:1 原尺寸（毫米换算后对齐边距框）；`custom` 按 `scalePercent` 百分比缩放。非 fit 模式可配合 `cropToMargins` 裁掉超出纸张绘图区域的部分。控件位于常显的「排版设置」分区，CLI 对应 `--fit-page` + `--scale-percent`
- **SVG 真实尺寸自动检测**（`mmPerSvgUnitFromSvg()`）：导入时解析根元素 `width`——带绝对物理单位（mm/cm/in/pt/pc/q/px）或 px 数值与 viewBox 不一致（如 2x/300dpi 导出）时，按 `width 实际毫米 ÷ viewBox 宽` 推算用户单位→毫米换算系数（`PlanOptions.mmPerSvgUnit`），替换默认的 96dpi 基准，规划（含旋转中心换算）全链路生效；`width="100%"`（Affinity 默认）或缺失时物理尺寸信息已丢失，回退 96dpi
- **裁剪拆分与图层过滤的正确交互**（关键设计）：`cropToMargins` 按 Liang-Barsky 逐线段与边距框求交（框内节点与线段全部保留，仅在穿越边框处拆分），一条路径会拆成多条碎片。碎片通过随路径携带的 `origIndices`（原始索引）回查 `inPaths` 获取 stroke/fill 归属——历史上曾按碎片新下标直接取 `inPaths[i]`，单路径文件（Affinity 典型的单个超长 `<path>`）拆分数百碎片后下标越界崩溃、多路径文件错用他路径图层归属整批误删（实测 153m 只剩 4.3m）
- 测试：`crop-layer-filter.test.ts`（裁剪拆分后图层过滤不崩溃/不误删）、`svg-unit-scale.test.ts`（单位推算 + 非 96dpi 端到端还原）

### 4.11 工作范围校验（防撞轴）★★

**问题背景**：2026-09-08 实测事故——计划坐标超出行程的任务直接下发，绘图仪撞轴卡死（应急需先断使能再手动复位）。软件层没有任何超界防护。

本项目改造：

- **设备档案行程**：`Device.workingAreaMm`（v3/brushless 430×300 mm，nextdraw-2234 559×864 mm；custom 硬件前端可在硬件设置配置「工作区宽/高 (mm)」，经 `X-Plot-Working-Area` 请求头传给服务端，未配置时仅按 AxiDraw 档案告警放行）
- **服务端硬校验**：`/plot` 扫描计划全部坐标（含落笔路径、抬笔空程与首尾行程，容差 0.5 步），超出行程即 400 拒绝并明确提示超界方向与数值（如「X 方向最大坐标 804.0 mm 超出上限 430.0 mm」）
- **前端预览标红**：纸张超出设备行程的区域显示红色遮罩 + 底部警示条，未绘制先知
- 测试：`server.test.ts` 覆盖直接超行程、自定义纸张超行程（缩放流程）、不缩放 1:1 超行程、正常范围不受影响、custom 工作区场景

---

## 5. 接口与协议变更对照

### 5.1 HTTP 接口

| 接口 | SAXI | 本项目 |
| --- | --- | --- |
| `POST /plot` | 相同 | 相同 |
| `POST /pause` | 相同 | 相同 |
| `POST /resume` | 无参数，仅恢复 | **支持 `{ rewindTo }` 回溯重绘** |
| `POST /cancel` | 相同 | 相同（附加清空 pendingRewind） |
| `POST /set-pen-height` | 相同 | 相同 |
| `POST /generate`（svg.io） | 有 | **移除** |
| `GET /`、静态资源 | 相同 | 相同 |

自定义请求头（`/plot` 与 `/redraw`，服务端缺失时按硬件档案兜底并告警）：

| 请求头 | 作用 |
| --- | --- |
| `X-Plot-Filename` | 源文件名，任务日志按其命名归档 |
| `X-Plot-Steps-Per-Mm` | 计划步进密度（custom 硬件传动参数只有前端知道），距离/速度换算为真实毫米 |
| `X-Plot-Working-Area` | custom 硬件安全工作区域（mm），参与绘制前超界校验 |
| `X-Plot-Layers` | 图层过滤模式与选中图层，写入任务日志 |

### 5.2 WebSocket 消息

| 消息 | 说明 |
| --- | --- |
| `progress` | 双方一致（`motionIdx`） |
| `pause` | 双方一致；本项目保证**每次恢复（含回溯）都广播 `paused:false`** |
| `dev` | 本项目移除 `svgIoEnabled` 字段 |
| `svgio-enabled` | **本项目移除** |
| `changeHardware` | 本项目支持 `"custom"` 及任意自定义配置名 |

### 5.3 驱动 API

```typescript
// SAXI
resume(): void
// 本项目
resume(rewindTo?: number): void   // 回溯到指定动作索引（吸附到路径组起点）
```

---

## 6. 独有功能价值分析

| 功能 | 解决的真实问题 | 无此功能时的代价 |
| --- | --- | --- |
| SVG transform 支持 | 现代设计软件（Affinity/Illustrator）导出的 SVG 大量携带 transform | 每个文件都要手工用 Inkscape/脚本烘焙变换，流程断裂 |
| 暂停回溯重绘 | 长时间绘制中笔出墨不畅漏画 | 发现时往往已过数百条线，整幅废弃重画（数小时成本） |
| 区间补画 + 归位可靠性 | 绘制结束后局部漏画；EBB 命令队列静默卡死 | 整图重画；笔停在终点不动且无报错，只能重启全套排查 |
| 隐藏线去除 | 填充图形后方线条可见，不符合视觉遮挡预期 | 需在源文件手工分割图层或接受瑕疵 |
| SVG 导出 | 检查/复用优化后的路径成果 | 无法留存中间成果，只能在绘图仪上直接试 |
| 自定义传动参数 | 自制/改装绘图仪步进-传动比各异 | 只能改源码硬编码，普通用户无法使用 |
| 纯本地运行 | 无网环境、隐私要求 | SAXI 的 svg.io 依赖外网 API |

---

## 7. 已知限制与后续方向

**已知限制**：

- SVG transform：不支持 `<use>`/`<defs>` 间接展开；嵌套 `<svg>` 视口按 `<g>` 处理
- SVG 真实尺寸检测依赖根元素 `width`：`width="100%"`（Affinity 等软件默认）或缺失时物理尺寸信息已从文件中丢失，无法恢复，按 96dpi 缺省处理——需 1:1 绘制时请以 96dpi 或带绝对单位宽度导出
- 回溯重绘为覆盖式重画：回溯点之后的所有线条画两遍（对漏画补墨是预期行为，但非"只补漏线"的精确增量模式）
- 隐藏线去除对交叉/自相交复杂填充的裁剪性能受 polygon-clipping 算法限制

**可选后续方向**：

- 回溯重绘可扩展「仅重绘被选中区间」模式（跳过未受损部分）——适用于整个绘制结束后对漏画区域进行区间补画
- 多笔/多色分任务调度（**半自动档位**）：本项目已具备按 stroke 颜色分层的基础能力（手动勾选图层分色绘制），全自动换笔依赖专用硬件（换笔机构/转笔塔），当前无计划。可行档位为半自动——自动按颜色分组任务，每组之间暂停并提示「请更换 XX 色笔，完成后点继续」，将现有手动勾选流程自动化，省去每次重新选择图层和重新规划，零硬件成本
- `<use>`/`<defs>` 引用展开

---

## 8. 结语

Bit2AtomBot 在 SAXI 提供的坚实框架（运动规划、EBB 协议、双驱动架构）之上，围绕**真实使用场景的痛点**完成了四类价值明确的增强：渲染正确性（transform 引擎）、绘制容错（暂停回溯重绘）、绘制质量（隐藏线去除）、硬件开放性（自定义传动参数），并辅以本地化、暗色主题、SVG 导出等体验改进。其中「暂停回溯重绘」从算法（路径组识别、安全回溯移动）、服务端（可重定位执行循环）、驱动（双模式一致行为）到 UI（四色状态机、连续回溯）实现了完整的端到端闭环，并有专项测试保障，是本项目最具独创性的功能。
