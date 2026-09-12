# Bit2AtomPlotGRBL —— GRBL 绘图仪移植开发计划

> 从 Bit2AtomPlotWebUI（EBB 版，v0.20.0 基线）移植至 GRBL 体系的独立项目计划
>
> 本文档为开发总纲：任务拆解按四个阶段组织，每阶段附验收标准

---

## 1. 已定决策

| 决策项 | 结论 | 影响 |
| --- | --- | --- |
| 速度规划 | **方案 B**：主机仍生成完整 `Plan`（预览/回溯/统计沿用），执行层将 `Plan` 转译为 G-code，速度曲线交给 GRBL 控制器 planner | 放弃主机端恒加速精调，换取架构简单；GRBL `$` 参数负责加速度调校 |
| 抬笔机制 | **Z 轴步进电机**（`G1 Z...`） | `PenMotion` → Z 轴移动，抬笔/落笔时长按行程与 Z 进给速度计算 |
| 项目形态 | **独立项目** `Bit2AtomPlotGRBLWebUI`，复制现有项目为基线后裁剪改造，不改动 EBB 版 | EBB 版保持稳定发布线；两版本共享 UI/规划层代码结构 |
| 硬件适应性 | **广泛开放配置**：固件版本/Z 轴与 XY 传动参数/`$H` homing 能力/RX 缓冲/状态回报格式/`$110–$122` 限速加速度，全部进入 custom 硬件档案，支持自动探测 + 用户覆盖 | 设备调研结论沉淀为**默认预设档**而非单机锁定；探测定能力、配置定行为；新增「参数助手」做档案换算值与设备 `$$` 实值的对照校验 |
| 输入/输出格式 | **输入**：SVG（基线继承）+ G-code 文件导入（新增）；**输出**：处理成果导出 SVG + G-code（新增，含消隐/分色分层/排版缩放结果）。PDF/DXF/EPS 暂不支持，留路线图 | 统一经 Plan 适配：任何输入构建为 `Plan` 即免费获得预览/回溯/补画/统计全套功能；G-code 导出复用转译层 `gcode.ts` 同口径生成 |

## 2. 总体策略

1. **复制基线**：将 `Bit2AtomPlotWebUI` 整体复制到本项目作为起点（保留 git 历史不必要，全新初始化仓库），而非从零搭建——UI、SVG 解析、路径预处理、服务端接口、日志体系直接复用。
2. **裁剪 EBB**：删除/替换 EBB 专属代码（`ebb.ts`、`serialport-serialport.ts` 中的 EBB 语义、`HM`/`EM`/`SP`/`LM`/`XM`/`QM` 相关逻辑）。
3. **先立接口再填实现**：第一阶段先抽出 `DeviceController` 接口（drivers.ts 当前直接引用 `EBB` 类 40+ 处），后续阶段以 `GrblController` 实现之。
4. **毫米口径 + 开放式硬件档案**：主机全程工作在毫米（步/mm 换算由 GRBL 控制器完成），`X-Plot-Steps-Per-Mm` 头与全步进空间换算移除；但 custom 硬件传动参数（XY 同步带 + Z 丝杆）**保留并扩展**，用于参数换算建议、与设备 `$$` 实值的校验对照、主机时长估算钳制——而非主机运动学换算。设备能力（固件版本、`$H`、RX 缓冲、状态回报格式）默认自动探测，用户配置可覆盖，保证广泛硬件适应性。

### 计划目录结构（目标形态）

```
Bit2AtomPlotGRBLWebUI/
├── src/
│   ├── ui.tsx / style.css / index.html      # 复用（硬件控件改造）
│   ├── server.ts / cli.ts                   # 复用改造
│   ├── planning.ts / massager.ts            # 复用（Plan 仍为主机逻辑计划）
│   ├── gcode.ts                             # 【新增】Plan → G-code 转译层
│   ├── gcode-import.ts                      # 【新增】G-code 文件 → Plan 导入解析器
│   ├── grbl.ts                              # 【新增】GRBL 协议层（替代 ebb.ts）
│   ├── zaxis.ts                             # 【新增】Z 轴抬笔后端
│   ├── drivers.ts                           # 改造：DeviceController 接口 + GrblDriver
│   └── __tests__/                           # 复用 + 新增 GRBL mock 测试
├── docs/
│   └── DEVICE_NOTES.md                      # 【新增】目标设备调研记录（阶段一产出）
└── GRBL_PORT_PLAN.md                        # 本文档
```

---

## 3. 阶段一：先决调研与项目初始化

**目标**：明确目标设备能力边界，完成基线复制与 EBB 解耦，接口先于实现。

### 任务清单

- [ ] **1.1 目标设备能力矩阵调研**（产出 `docs/DEVICE_NOTES.md`，结论沉淀为**默认预设档**而非单机锁定）
  - [ ] 调研 GRBL 1.1 / Classic 及常见分支（grbl-Mega、grblHAL）差异：版本横幅格式、`$10` 状态回报扩展字段、real-time 命令兼容性、`error:` 码表差异
  - [ ] 梳理 Z 轴常见传动形式（丝杆/同步带/齿条）及换算公式：步距角/细分/导程 → Z 步/mm
  - [ ] 梳理 `$H` homing、`$20/$21` 限位、RX 缓冲区大小（128 默认，部分固件编译期可调）在不同固件中的可用性差异
  - [ ] 每项能力标注两个入口：**自动探测方式**（版本横幅/`$$` 查询）与**用户配置覆盖**，探测失败时回退配置
- [ ] **1.2 基线复制与项目更名**
  - [ ] 复制 `Bit2AtomPlotWebUI` → 本项目，`package.json` 更名 `bit2atomplotgrbl`，`npm install` 后 `npm test` / `npm run build` 确认基线可跑
  - [ ] 初始化独立 git 仓库
- [ ] **1.3 DeviceController 接口抽象（EBB 解耦核心）**
  - [ ] 从 `drivers.ts` + `ebb.ts` 的使用面提炼接口：`connect/close`、`executeMotion`、`setPenHeight`、`enableMotors/disableMotors`、`command`、`waitUntilMotorsIdle`、`cancel`、`probeAlive`、硬件档案读取
  - [ ] `server.ts` 与 `ui.tsx`（WebSerial 侧）改为面向接口编程，消除对 `EBB` 类的直接引用
  - [ ] 现有 EBB 路径临时封装为 `EbbController implements DeviceController`（保证基线行为不变，最终阶段删除）
- [ ] **1.4 custom 硬件档案扩展（广泛适应性核心）**
  - [x] **XY 传动参数保留**：步距角/细分/同步轮齿数/齿距 → 换算 `stepsPerMm`，用途调整为与设备 `$100/$101` 校验对照及「参数助手」建议值（不再参与主机运动学换算）※UI 已标注「建议值对照 $100/$101」；主机换算移除归 1.4b
  - [x] **新增 Z 传动参数**：步距角/细分/丝杆导程（mm/rev）或齿距 → 换算 Z 步/mm，对照 `$102`（`computeZStepsPerMm`，含单测 `z-drive.test.ts`）
  - [x] **新增固件能力项**（均支持「自动探测 / 手动指定」双入口）：
    - 固件版本：GRBL 1.1 / Classic / grblHAL（版本横幅自动解析；**grblHAL 可能伪装 `Grbl 1.1` 横幅，须以 `$I` 的 `[FIRMWARE:grblHAL]` 为准**——调研结论）
    - `$H` homing 支持（有限位开关与否）
    - RX 缓冲字节数（默认 128，可调 64–256）
    - `$10` 状态回报格式（WPos/MPos、是否带 Buf 字段）
    - `$110–$122` 最大速度/加速度（供主机时长估算钳制；支持「从设备读取」回填）
    - **串口波特率**（默认 115200；下拉覆盖 9600/57600/115200/230400/250000，兼容部分国产板卡的 250000 与旧固件 9600；连接失败时 UI 提示按档位轮询重试）
  - [x] 移除 `X-Plot-Steps-Per-Mm` 请求头与全步进空间换算，Plan 全程毫米口径：planning（ToolingProfile mm 直读、`totalDistance()` 无参）、massager（去 `effectiveStepsPerMm`）、ebb（执行期 ×stepsPerMm×细分，`changeHardware` 重置档案值）、export-svg（`planToSvg(plan, paperSize)`）、server（超界校验 0.1mm 容差直读、任务日志/实际距离 mm 直读、新增 ws `setStepsPerMm` 消息）、drivers（删 header 字段、新增 `setStepsPerMm` 抽象：WebSerial 直写控制器 / Bit2Atom ws 同步）、ui（预览/统计/起点输入/导出 mm 直读，plot 前 `driver.setStepsPerMm(...)`）
  - [x] 硬件设置 UI 分组改造：**传动参数（XY/Z）/ 抬笔（Z）/ 固件能力 / 工作区** 四组，随命名档案持久化；内置至少 3 个预设档（GRBL 1.1 丝杆 Z / GRBL 1.1 同步带 Z / grblHAL，作为「新建自定义」模板入口）※抬笔（Z）参数并入「传动参数（Z）与抬笔」组

### 验收标准

1. `npm test` 全部通过（基线 53 用例不回归）、`npm run build` 成功、`npm run lint` 零告警
2. `drivers.ts` / `server.ts` / `ui.tsx` 中不再出现对 `EBB` 类的直接 import（仅经 `DeviceController` 接口）
3. EBB 路径经 `EbbController` 包装后功能与基线一致（模拟模式 + mock 串口测试通过）
4. `docs/DEVICE_NOTES.md` 完成全部调研项，并转化为 ≥3 个内置硬件预设档
5. custom 硬件档案新字段（Z 传动/固件能力/限速加速度）可保存、加载、回显；任务日志/超界校验无全步进空间换算残留（代码 grep 为零）

---

## 4. 阶段二：GRBL 协议层与最小绘制闭环

**目标**：实现 `grbl.ts` 协议层与 `gcode.ts` 转译层，打通「SVG → Plan → G-code → GRBL 流式绘制」最小闭环，含暂停/取消。

### 任务清单

- [ ] **2.1 `grbl.ts` 协议层**（参照 ebb.ts 的超时纪律设计，语义全新实现）
  - [x] 行协议状态机：启动握手（发送 `\r\n\r\n` 后等待 `Grbl x.x` 横幅）、`ok/error` 按入队顺序逐行应答匹配（`grbl.ts`，16 用例全过）
  - [x] 连接参数：`detectBaudRate` 按档位（115200/9600/57600/230400/250000，可自定义顺序）轮询握手探测并回填
  - [x] **字符计数流控**：按 RX 缓冲区（默认 128 字符）窗口流式发送，`ok`/`error` 回收窗口额度（超窗口长行直接拒绝，提示拆行）
  - [x] `?` 实时状态查询解析（`parseGrblStatus`：Idle/Run/Hold(含子码)/Alarm 等状态 + MPos/WPos/FS/Buf/Pn，兼容 v0.9 报文）
  - [x] real-time 命令原语：`!` 进给保持、`~` 恢复、`0x18` 软复位（`sendRealTime` 不排队不占窗口；取消 = hold + flush + soft reset + `$X` 的编排逻辑归 2.4 执行循环）
  - [ ] `$H` homing（带超时与 Alarm 恢复路径）、`$X` unlock、`$G` 解析状态查询（原语已具备：`run("$H")/run("$X")`，恢复路径与封装归 2.4）
  - [x] 全命令超时纪律移植：常规命令 15s；超时即 cancel()（清队列 + 500ms 沉降期，孤儿 `ok` 按沉降窗口丢弃，防止错位到新命令）
  - [x] 串口写入错误注入队列中止（写失败即 reject 全部挂起命令）
  - [ ] `$` 参数读写：`$$` 全量解析（`querySettings` 已实现）；单项查询与单项写入封装（归 2.7 参数助手）
  - [x] `$I` 固件信息解析（`queryInfo`：[VER:]/[OPT:]/[FIRMWARE:]，grblHAL 判型优先于伪装横幅）
  - [ ] 能力探测：版本横幅解析 → capability 对象；**优先级 = 用户配置 > 探测值 > 预设档默认**，探测失败自动回退（横幅/`$I` 解析已完成，优先级链与档案接线归 2.7/2.4）
- [x] **2.2 `gcode.ts` 转译层（方案 B 核心）**（已完成，`gcode.ts` + 10 用例全过）
  - [x] `XYMotion` → 线段流：落笔段 `G1 X.. Y.. F{vFinal×60}`（mm/s → mm/min，受 $110/$111 钳制，F≈0 省略沿用模态进给），抬笔空程 `G0 X.. Y..`
  - [x] `PenMotion` → `G1 Z{up/down} F{zFeed}`（经 `zaxis.ts` 后端）
  - [x] 保留 `Plan` 动作索引 → G-code 行号的双向映射表（`motionLineRanges`/`lineToMotion`，头部/脚注行 = -1，未产生行动作 = null）
  - [x] 坐标模式约定：G90 绝对模式、G21 毫米、工作坐标系 G54（文档化，不做 G91 相对模式）
  - [x] 主机 Block 的 v0/accel 信息仅用于预览与时长估算，不再下发（文档记录该取舍）
  - [x] 预计时长估算按硬件档案中 `$110–$122` 钳制值重算（毫米口径，不依赖设备在线；档案值缺失时回退块平均速度/档案 Z 进给）
- [x] **2.3 `zaxis.ts` Z 轴抬笔后端**（后端已完成，`zaxis.ts` + 8 用例全过；UI 笔高滑杆接线归 2.4）
  - [x] 配置项：`zPenDownMm`（落笔 Z，通常 0）、`zPenUpMm`（抬笔 Z，如 +5mm）、`zFeedMmMin`（`zAxisConfigFromDriveParams` 从档案提取）
  - [x] UI 笔高滑杆（penPct）→ Z 行程线性映射（`penPctToZMm`：pct 0 = zPenUpMm、100 = zPenDownMm）；`PenMotion.duration` 按 `|ΔZ| / zFeed` 重算（`penMotionDurationSec`，受 $112 钳制；进度条/预计时长正确性依赖此项）
  - [x] Z 步/mm 由档案 Z 传动参数推算，仅用于「参数助手」建议与校验；实际运动以设备 `$102` 为准（1.4a `computeZStepsPerMm` 已实现）
- [ ] **2.4 `GrblDriver` 与执行循环**（`grbl-controller.ts` 已完成 DeviceController 契约实现，18 用例全过；驱动层接线归 2.6）
  - [x] 实现 `DeviceController`：`executeMotion` 逐动作转译 + 流式下发（`grbl-controller.ts`）；笔状态跨动作跟踪（PenMotion 方向决定 G0/G1）
  - [x] Alarm 体检：`enableMotors` 状态查询，Alarm 下显式报错引导 `$H`/`$X`，不静默解锁
  - [x] 排空等待：`waitUntilMotorsIdle` = 轮询 `?` 直至 `Idle`（`$H`/`$X`/`feedHold`/`cycleStart`/`onalarm` 转发原语就绪，暂停/回溯编排归阶段三）
  - [ ] 归位：`$H` 可用时用之；否则基于已知位置的 `G0` 抬笔行程移动（移植 rewindTravel 思路，Z 先抬后移 XY）（原语 `home()`/`unlock()` 已具备，编排归阶段三 3.1/3.2）
- [x] **2.5 模拟模式**（`simulator.ts` + 10 集成用例全过）
  - [x] 无设备模拟驱动：`GrblSimulator` 虚拟 GRBL 设备（实现 SerialPortLike）——本地逐行消费 G-code（ok = planner 接受语义）、按进给速度虚拟计时执行、`?` 依虚拟状态回报 `<Idle|Run|Hold|Alarm|WPos|FS>`（WPos 插值）、`!`/`~`/0x18 实时命令、`$H`/`$X`/`$$`/`$I`、`triggerAlarm()` 注入；经 `GrblController` 全链路驱动（握手→executePlan→排空→Hold/Resume→Alarm 解锁→$H 归位）
  - [x] **planner 深度背压**（默认 16 条，`plannerDepth` 可配）：planner 满时运动行 `ok` 延迟到有动作完成腾出槽位——与真实 GRBL「planner 满 → 解析停住」一致；修复原先无界 pending 队列导致主机瞬间排空全部行、掩盖取消时序的问题
  - [x] 自写 mock 供 vitest 集成测试（`__tests__/simulator.test.ts`；未引入 grbl-simulator——Node 依赖其 Python/编译环境，自写模拟器保真度足够且可注入 Alarm）；接入服务端/UI 的「无设备全流程」归 2.6
  - [x] 修复握手竞态：横幅等待者先于唤醒字节挂载（虚拟/快速设备的应答可能在唤醒写入 promise 链完成前被读管线消费）
- [x] **2.6 服务端接口适配**（`server.ts` + `cli.ts` + `server-grbl.test.ts` 5 用例全过）
  - [x] `DriverKind = "ebb" | "grbl" | "sim"`（※当时含 EBB；4.5 已彻底删除，现为 `"grbl" | "sim"`）：`startServer` 增加 driver 参数，`connect` 按种类分支（EBB 枚举 / `connectGrblDevice` 握手探测 / 内置模拟器直连）；CLI 全局 `--driver` 选项（`plot`/`pen`/服务端均生效）
  - [x] `/plot`、`/pause`、`/resume`、`/cancel`、`/redraw`、`/home`、WebSocket 进度广播接 `GrblController`（复用 DeviceController 契约执行循环，EBB 行为零回归）
  - [x] GRBL 取消收尾：`/cancel` 先 `feedHold` 立即冻结 → `grblPostCancel` 软复位（0x18）清空设备 planner 缓冲 → Alarm 自动 `$X` 解锁 → 抬笔 → WPos 实测回填 `lastPenPos`（不可得则置 null）
  - [x] **修复取消时序缺口**：abort 落在 postPlot 排空阶段（motion 循环已结束、设备仍执行积压）时原实现会卡死等待排空（feedHold 下永不 Idle）——doPlot finally 检测 aborted 转走取消收尾（`cancelCleanupDone` 标志防止与 catch 路径重复 postCancel）
  - [x] 归位路径：`homePenNow` 支持 GRBL 探活（`statusReport`），位置未知时 `$H` 归位
  - [x] `/plot/status` 增加 `device` 字段回报已连接驱动种类（测试/UI 判断连接就绪）
  - [x] 超界校验毫米直读（工作区来自 GRBL 档案 `workingAreaMm` 或用户配置，`X-Plot-Working-Area` 头沿用）
- [x] **2.7 参数助手（广泛适应性配套）**（已完成，`server-grbl-params.test.ts` 6 用例全过；140 用例全绿）
  - [x] 连接后读取设备 `$$`，与档案传动参数换算值（XY/Z 步/mm）逐项对照，不一致时列出差异并告警（档案与固件不同步会导致时长估算/显示偏差）。实现：`POST /grbl/params`（请求体带档案，服务端 `querySettings()` + `compareGrblSettings` 纯函数逐项对照，容差相对 0.5%/绝对 0.01；绘制中拒绝访问）；UI「读取设备参数」按钮 + 对照表（设备值/档案建议/一致状态）
  - [x] 可选一键写入：将档案换算值写入 `$100–$102`（`POST /grbl/params/write`，参数号白名单校验拒绝任意行注入；UI confirm 二次确认并提示重启/试绘校准方格），保持「建议不强制」原则
  - [x] **反向同步（推荐方向）**：以设备 `$$` 实值为准一键回填档案——XY/Z 细分由设备步/mm ÷ 档案全步密度整除导出（不可整除时提示核对传动参数），`$110–$122` 速度/加速度直接回填；保证「档案即设备真相」
  - [x] 档案同步通道：ws `changeDriveParams` 消息（UI 档案编辑/反向同步/初始挂载时全量推送）→ 服务端档案副本（工作区参与超界校验）+ `GrblController.applyDriveParams`（Z 抬笔配置 + 限速钳制，保留 penPosRange）
  - [ ] **写入后校准**：一键写入成功后提示试绘 10mm 校准方格（十宫格），实测尺寸吻合后再进行正式绘制——档案错误值经写入放大成比例失真的最后防线（UI 已在写入确认中提示；校准方格自动生成归阶段三输出扩展）

### 验收标准

1. `npm test` 全绿，新增测试覆盖：G-code 转译正确性（含索引映射）、流控窗口算法、`ok/error` 匹配与孤儿丢弃、状态回报解析、写入失败中止、模拟模式全流程
2. **模拟模式**：加载 SVG → 预览 → 模拟绘制 → 暂停 → 恢复 → 取消，全程 UI 无卡死，进度条与路径着色正确
3. **真实设备（或 grbl-simulator）冒烟**：简单 SVG（< 100 路径）完整绘制成功；Z 轴按落笔/抬笔高度正确动作；绘制结束设备 `Idle`、无 Alarm
4. 暂停后设备进 `Hold`，取消后缓冲区清空、设备可控不失控（无幽灵运动）
5. 任务日志正常生成且距离/速度统计为真实毫米口径，与 UI 显示一致
6. **广泛适应性验证**：切换 ≥3 种硬件档案（不同 RX 缓冲 64/128/256、固件 1.1/Classic、启用/禁用 `$H`、不同 Z 传动参数）下，模拟测试与协议层测试全部通过；参数助手能正确检出档案与 `$$` 的差异

---

## 5. 阶段三：功能补全（回溯/补画/可靠性）

**目标**：把 EBB 版的护城河功能在 GRBL 上重建，补齐长时绘制可靠性。

### 任务清单

- [ ] **3.1 位置跟踪与 lastPenPos**（核心已完成，`server-grbl.test.ts` 位置跟踪 2 用例全过）
  - [x] 基于 `?` 状态回报（`MPos`/`WPos`）维护 `lastPenPos`：取消收尾（`grblPostCancel` WPos 实测回填，2.6 已具备）、`$H` 归位后 WPos 回填（2.6 已具备）；新增**双源校验** `grblVerifyPenPos`——在排空后的安全点（暂停生效、绘制收尾）对照主机动作跟踪位置与 WPos 实测，偏差 >1mm（软复位丢步/中途点动/机械打滑）时记录任务日志并按实测修正（WPos 与下发坐标同处工作坐标系，是设备侧真相）。绘制中行号映射级的连续校验以暂停/收尾两个排空点近似（方案 B 下流式发送期间 WPos 滞后 planner，逐行对照无意义）
  - [x] 服务重启后位置未知路径：`/redraw` 409 提示「笔当前位置未知（服务可能刚重启）。请先执行「笔回原点」后再补画」+ `/home` GRBL 分支 `$H` 归位（2.6 已具备）；新增 `/plot/status` 回报 `penPosKnown` 供 UI/测试判断；启动时不从 WPos 盲目回填（上电后 WPos 无效值不可辨别，保守视为未知）
- [x] **3.2 暂停回溯重绘**（已完成，`server-grbl.test.ts` 回溯用例全过：ws 进度事件验证重放回退到更早组起点）
  - [x] 暂停 = 停止投喂 + 缓冲区排空确认（`waitUntilMotorsIdle` + 3.1 双源位置校验）。**设计决策**：未采用 `!` hold——方案 B 流式架构下主机领先设备最多 planner 深度，feedHold 后 planner 槽位不再释放，主机侧挂起的 `ok` 等待会永久卡死在 `executeMotion` 内，需要跨端点解阻塞编排；而「停止投喂 + 排空」用户可见效果等价（暂停在秒级内生效于路径边界、笔回抬笔态，GRBL RX/planner 缓冲浅），且与 EBB 版暂停语义（LM FIFO 无法远程中止，同为边界暂停）一致
  - [x] 回溯执行：暂停生效于抬笔边界（笔回抬笔态）→ resume(rewindTo) → `snapToGroupStart` 定位组起点 → `rewindTravelMotion` 生成 Z 抬笔 + `G0` 行程（3.1 校验保证起点真实）→ 从组起点重放（组内自带落笔 PenMotion，动作索引 ↔ G-code 行映射在方案 B 下逐动作一一对应）
  - [x] 「进度 起点 → 目标（抬笔行程 xx mm）」日志行（doPlot 回溯分支既有）；橙色/红色着色逻辑复用（UI 端 rewindRange/redrawnRanges 客户端计算，无需服务端改动）
- [x] **3.3 补画模式**（已完成，`server-grbl.test.ts` 补画用例全过）
  - [x] 区间选择双滑块、区间重放、完成后 Z 抬笔自动归位（`/redraw` 补画后调用 `homePenNow` 自动归位；失败经 `home-failed` ws 消息弹窗提示，不阻塞补画结果）
- [x] **3.4 断连保护**（已完成，`grbl.ts`/`grbl-controller.ts`/`server.ts`/`drivers.ts` 全链路）
  - [x] USB 拔出/串口错误 → 中止流式发送、清窗口、退出绘制状态、UI 弹窗（移植错误码 31 全套处置）。实现：`grbl.ts` 读流正常关闭（USB 拔出时 node-serialport 读迭代器以 done 结束不抛错）与写失败统一 `handlePortDeath` → `ondisconnect` 回调；`server.ts` `wireGrblDisconnectGuard` 中止绘制（abort）、解除暂停挂起（暂停中拔出否则永不退出）、`lastPenPos = null`（断连后位置不可信）、广播 `disconnected` 消息，5s 周期自动重连（跳过收尾未完成时段）；执行层经 `connectionLost` getter 快速失败，不空等超时
- [x] **3.5 Alarm/错误恢复路径**（已完成，`grbl.test.ts` 4 用例 + `server-grbl.test.ts` 3 集成用例全过）
  - [x] 绘制中 Alarm（硬限位触发等）→ 立即报错 + 引导恢复流程，不得静默继续发送。实现：`grbl.ts` 收到 `ALARM:` 行即 `onalarm` 上报并**中止全部挂起命令**（Alarm 后挂起命令永无应答，如运动中的 `$H`/planner 内 G-code，以告警原因拒绝而非空等 15s 超时）；`server.ts` `wireGrblAlarmGuard` 立即中止绘制、解除暂停挂起、`lastPenPos = null`（硬限位后位置参考不可信，重新归位前禁止补画）、广播 `alarm` ws 消息弹窗引导（排除故障 → 笔回原点 $H；归位不可用时「解锁设备」$X）。**Alarm 中止的取消路径不走 postCancel**——软复位会再次触发 ALARM:3、随后自动 $X 解锁静默丢失位置参考，违背「不静默恢复」原则（doPlot catch 先 `grblInAlarm()` 探测再分支）
  - [x] `homePenNow` Alarm 恢复：`/home` 探测到 Alarm 态时先 `$H` 归位（重建位置参考并清警，必须先于抬笔/行程执行——Alarm 下任何 G-code 被 error:9 拒绝）；归位后仍 Alarm 则报错引导 $X
  - [x] 新增 `POST /grbl/unlock` 端点（`$X` 解锁，非 Alarm 态 409 拒绝；解锁丢失位置参考，UI confirm 确认 + 解锁后提示先「笔回原点」）；UI「笔回原点」旁新增「解锁设备」按钮
  - [x] GRBL `error:`/`ALARM:` 行分类映射：`describeGrblError`（error:1–38 官方 v1.1 代码表中文描述，保留 `error:N` 前缀兼容既有正则匹配）与 `describeGrblAlarm`（ALARM:1–9 官方码 + 恢复提示），未知码原样返回兜底
- [x] **3.6 超界与软限位协同**（已完成，`server-grbl.test.ts` 软限位用例通过）
  - [x] 服务端毫米口径校验保留（第一道防线）；设备开启 `$20` 软限位时绘制前读取 `$$`，计划范围超出软限位行程（`$130/$131`，假定 WPos 0 对应行程一角）→ 提前拒绝（400）；`$20=0` 时仅提醒开启双保险不拒绝（服务端校验兜底）。`$$` 读取失败仅告警不阻断
- [x] **3.7 WebSerial 直连模式**（已完成，`webserial-driver.test.ts` 6 用例全过：完整绘制跟踪笔位、cancel 中途停止抬笔可复用、homePen 已知/未知位置归位、绘制中 Alarm 立即中止引导恢复、changeDriveParams 应用 Z 档案）
  - [x] `WebSerialDriver` 改接 `GrblController`（浏览器直连 GRBL，`DeviceController` 契约复用，与服务端执行/恢复路径同语义）：断连保护（读流关闭/写失败 → `ondisconnect` + 位置失效）、ALARM 守卫（`onalarm` 立即中止 + `lastPenPos = null` + 弹窗引导 `$H`/`$X`）、取消收尾统一入口 `finishCancel`（幂等：`grblPostCancel` 软复位排空 + 抬笔回填位置 + `oncancelled`）
  - [x] 取消即时性：`cancel()` 发 `feedHold`（`!`）冻结设备后**立即清空主机命令队列**——被 planner 背压阻塞的动作行以 Cancelled reject，绘制循环立即转入收尾，不等命令超时（GRBL 流水线模型下主循环远早于设备执行结束）
  - [x] 归位路径：位置已知 → 抬笔 + `rewindTravelMotion` 行程回 (0,0)；位置未知 → 先 `$H` 归位重建参考再抬笔
  - [x] 模拟器保真度修复：`queuedPos` 维护 planner 链式末端（动作入队时刻按前一动作终点确定坐标，匹配真实 GRBL planner；修复流水线下发后继动作把已抬高 Z 链回旧值）；`$H` 归位 `dropAllMoves()` 清空 planner 与链式末端（修复归位后抬笔被判零距离跳过）；`dropAllMoves` 同步重置 `queuedPos`
  - [x] UI 已适配：移除 VID/PID 过滤，档案变更经 `changeDriveParams` 直达 `applyDriveParams`（与服务端 ws 通道同口径）
- [x] **3.8 输入扩展：G-code 文件导入**（已完成，`gcode-import.test.ts` 13 用例全过）
  - [x] `gcode-import.ts` `parseGcode(source, planOptions?)`：`G0/G1` 直线、`G2/G3` 圆弧（最大 5° 步角细分进 Plan；I/J 增量圆心 + R 半径式 + 无终点词整圆）、`M3/M4/M5` 与 Z 轴变化（笔起落统计）、`F` 进给、`G90/G91` 绝对/相对、`G20/G21` 英寸换算（1e-9mm 取整消除浮点漂移）、G17 平面假定（G18/G19 告警后尽力解析）；归一化输出 `strokes`（绝对毫米折线，圆弧已细分）+ 标准 `Plan`（每笔画一组「空程→落笔→绘制→抬笔」，pathGroupStarts 回溯语义可用）
  - [x] 方言兼容基线：N 行号剥离、`;`/`(...)` 注释、S/T/P 等参数字静默忽略、G4/M6/未知 G-M code 告警跳过不静默丢弃（warnings 含行号+原文，stats 计数）；M30/M2 程序结束截断
  - [x] 导入后进入标准 Plan 管线：UI 文件选择/拖拽接受 `.gcode/.nc/.tap/.ngc`，笔位空间与速度档案对齐当前 UI 档案（同 massager 口径 `device.penPctToPos`），导入完成 alert 展示统计（告警明细入控制台），「清除文件」按钮覆盖 G-code 场景
- [x] **3.9 输出扩展：处理成果导出 SVG / G-code**（已完成，`export-gcode.test.ts` 2 用例全过；全套 175 测试通过）
  - [x] SVG 导出：`planToSvg` 基线已覆盖既定口径——Plan 本身即消隐/图层过滤/排版缩放后的最终几何，笔落段逐块重建折线，坐标毫米直读；按图层/颜色分组导出不适用（图层与颜色在规划前已消解，Plan 仅含最终笔画）
  - [x] G-code 导出：新增 `export-gcode.ts` `planToGCode(plan, {sourceFileName, driveParams, hardwareLabel})`，动作行流复用 2.2 `translatePlanToGCode` 同口径（含收尾自动抬笔）；头部注释块写源文件名、导出时间、设备档案、Z 抬笔/落笔高度与 Z 进给、`$100/$101/$102` 步进密度建议（`computeMicrostepsPerMm`/`computeZStepsPerMm`）、`$110/$111` 限速建议（档案已配置时），并注明目标固件步/mm 必须匹配否则比例失真
  - [x] UI 与接口：绘图设置区「导出 SVG / 导出 G-code」双按钮（非模拟模式可用）；导出走浏览器 Blob 下载（Plan 存于前端，无需服务端中转——计划中「服务端下载接口」按此决策省略）；导出文件名沿用源文件基名（如 `drawing.svg → drawing-export.gcode`），无源文件回退 `export`

### 验收标准

1. 回溯/补画在模拟模式 + 真实设备（或模拟器）均通过：重放区间与预览高亮一致、Z 先抬后移、连续多次回溯不错位
2. 断连测试：绘制中拔 USB，UI 正确退出绘制态、无 unhandled rejection、重连后「笔回原点」可用
3. Alarm 注入测试（模拟器触发限位）：服务报错、引导解锁、状态复位，无后续指令下发
4. 长时任务冒烟：高密度图形（数万短段）流式绘制 30 分钟+ 无窗口卡死、进度与着色持续正确
5. 任务日志含回溯/补画/断连/Alarm 全部事件留痕
6. G-code 导入：≥3 种来源的样例文件（如 Inkscape GCodeTools / LaserGRBL / J-Tech，收进 `src/__tests__/fixtures/`）导入后预览、绘制、回溯全链路正确；无法解析行有告警与统计留痕
7. 成果导出：消隐/分色/分层处理后的 SVG 与 G-code 导出文件可被第三方系统正确使用（G-code 导出经 grbl-simulator 验证可完整绘制，比例与预览一致）

---

## 6. 阶段四：质量保障、联调与发布

**目标**：质量体系对齐 EBB 版水位，完成真实设备验收与首个发布。

### 任务清单

- [x] **4.1 测试体系补齐**（已完成，182 用例 + 1 skipped 全绿，lint 零告警）
  - [x] G-code 导入/导出 round-trip 专项（`gcode-roundtrip.test.ts` 5 用例）：4 种方言样例「导入 → 导出 → 再导入」笔画数与几何等价（双向点到折线距离 ≤0.002mm + 弧长差 ≤0.1mm，兼容导出 3 位小数量化与规划器共线分割点）。**发现并修复 3.9 真 bug**：`planToGCode` 经 `zAxisConfigFromDriveParams` 构建 Z 配置时缺 `penPosRange`，真实舵机空间 Plan 导出笔态反转、Z 值错误（既有导出测试因使用字面 pct 值而未暴露）——`GCodeExportOptions` 新增 `hardware` 字段补齐 penPosRange，UI 导出与回归用例同步（`export-gcode.test.ts` 3 用例）
  - [x] 方言样例 fixture 收进 `src/__tests__/fixtures/`：Inkscape GCodeTools（前导零 G00/M03）、LaserGRBL（M4 S 功率字）、J-Tech Photonizer（M3/M5 + Z 轴笔控）+ 既有综合样例，满足验收标准 ≥3 种来源
  - [x] GRBL mock 串口（`__tests__/mocks/grbl-port.ts`）覆盖协议层全部分支（`grbl.test.ts` 21 用例：握手判型/ok-error FIFO 匹配/字符计数流控（窗口满回收、实时命令不占窗、超行拒绝、RX=128 默认边界）/状态与 $$ $I 解析/取消沉降期孤儿丢弃/写失败中止/ALARM-分类映射/波特率轮询）
  - [x] 专项测试核对：G-code 转译与索引映射（`gcode.test.ts` 11 用例，含行区间双向映射、F 钳制、零长块、时长估算）、G-code 导入（`gcode-import.test.ts` 13 用例）、round-trip（新增 5 用例）、裁剪/图层过滤原索引回查（`crop-layer-filter.test.ts` 规划层）、Z 轴时长估算（`zaxis.test.ts` + gcode.test.ts）、流控边界（grbl.test.ts）、超界三场景（`server-grbl.test.ts` 3.6 三用例 + `server.test.ts` 工作区）
  - [x] `npm run lint` 零告警（57 文件），测试用例数 182+1skip ≥ EBB 版基线
- [ ] **4.2 真实设备验收**
  - [ ] 按 DEVICE_NOTES 记录的设备完成全功能验收：绘制/暂停/回溯/补画/归位/取消/超界拒绝
  - [ ] 长时任务实测一次数小时级绘制，验证任务日志与统计口径
  - [ ] `$` 参数推荐基线写入文档（Z 轴速度/加速度、$10 状态回报配置）
- [x] **4.3 文档与品牌**（已完成）
  - [x] README / CHANGELOG / ARCHITECTURE 更名改写为 GRBL 版内容（GRBL 差异、方案 B 转译取舍、Z 轴配置指南、姊妹项目关系说明）；docs/RELEASE.md 品牌与发布记录同步（EBB 版发布历史移回姊妹项目）；删除 EBB 基线遗留的 PROJECT_INTRODUCTION.md / TECHNICAL_REPORT.md
  - [x] 品牌更名落地：index.html 标题、CLI 描述、驱动名（`Bit2AtomPlotGRBL Server`）、任务日志头、运行日志前缀（`bit2atomplotgrbl-`）、console 标签 `[bit2atomplotgrbl]`；`BIT2ATOM_LOG_DIR`/`BIT2ATOM_NO_FILE_LOG` 环境变量名保持不变（向后兼容）
- [x] **4.5 EBB 路径彻底删除**（已完成，153 用例（+1 skipped）全绿，lint/build 通过）
  - [x] 删除 `ebb.ts`、`__tests__/ebb.test.ts`、`__tests__/mocks/serialport.ts`、EBB 版 `server.test.ts`；`--driver` 仅保留 `grbl|sim`（CLI/服务端同步收窄）；EBB 设备由姊妹项目 Bit2AtomPlotWebUI 覆盖
  - [x] 笔位空间统一 penPct 口径（0 = 完全抬笔，100 = 完全落笔）：zaxis/gcode/grbl-controller/massager/gcode-import/export-gcode/drivers/ui 全链路去除舵机空间（penPos）逆变换，`PenMotion` 直存 pct、GRBL 执行层线性映射 Z 高度（顺带修正原舵机方向的 penIsUp/路径组起点判断）
  - [x] UI 硬件预设选中修复：识别 GRBL 预设 key 并加载对应档案（原 `preset:` 前缀未处理导致选中无效果）；预览工作区改从 `driveParams.workingAreaMm` 直读，不再依赖 `getDevice`
- [x] **4.6 无设备启动体验**（已完成：真机未上电也能正常启动服务端）
  - [x] 服务端启动未发现设备时保持就绪 + 5s 周期自动探测，设备插入/上电后自动接入（与断连重连同口径）；不再以 error 级「No GRBL device found」收尾（CLI 仍为探测失败即退出并提示）
  - [x] 探测噪音治理：grbl.ts 握手未完成的端口死亡静默处置（探测预期路径，不刷「connection lost」）；serialport 主动 close 的 aborted 读错误不记录
- [x] **4.7 UI 体验修复批次**（已完成：153 用例全绿，lint/build 通过）
  - [x] 未接机误启绘制：真实模式无设备时 /plot、/redraw 以 409 拒绝并弹窗说明（原静默回退 simPlotter）；sim-plot.test.ts 改写为 409 回归
  - [x] 工作区宽/高无法输入：DriveParams 输入改本地文本态（waText），两维有效才提交，中间态保留
  - [x] 底部绘图面板 fixed → sticky，移除 spacer(200px) + padding-bottom(150px) 占位 hack，模拟绘制时不再露出大片空白
  - [x] 补画/设备操作按钮改纵向全宽（.button-column）；字号降一档并建立三级层级（16px 板块标题 / 12px 组标题+10px 副题 / 12px 控件），破折号说明下沉副题
- [x] **4.8 机器坐标系映射 + UI 规范化批次 2**（已完成：157 用例 + 1 skipped 全绿，lint/build 通过）
  - [x] 新增 `DriveParams.originCorner`（左上缺省/左下/右上/右下）+ `applyMachineFrame()`（planning.ts）：预览/排版固定屏幕方位，绘制/补画/归位/G-code 导出发送前统一映射机器坐标；动作序列/时长不变，补画区间索引一一对应；machine-frame.test.ts 5 用例
  - [x] UI 规范化：`.flex` 列均分 + 8px 间距（修复三列行溢出）、输入/下拉统一 28px 高、stepsPerMm/$102 结果行改「主名 + 10px 副题」两行、补画面板滑块行对齐与间距统一
- [ ] **4.4 发布 v0.1.0**
  - [ ] 版本号、tag、发布包（正斜杠 zip 教训沿用：.NET ZipArchive 打包并验证 0 反斜杠条目）
  - [ ] GitHub 仓库初始化与 tag `v0.1.0`

### 验收标准

1. 全部自动化测试通过 + lint 零告警，发布包内测试可独立运行
2. 真实设备全功能验收清单逐项通过并留档（附任务日志）
3. 发布包、tag、文档版本号三者一致
4. EBB 版仓库零改动（独立项目策略达成）

---

## 7. 关键技术设计备忘

### 7.1 G-code 转译规则（方案 B）

```
Plan 动作                    →  G-code
────────────────────────────────────────────────────────────
XYMotion（落笔绘制段）        →  G1 X{x} Y{y} F{vFinal×60}   （mm/min）
XYMotion（抬笔空程/首尾行程）  →  G0 X{x} Y{y}
PenMotion（落笔 down）        →  G1 Z{zPenDownMm} F{zFeed}
PenMotion（抬笔 up）          →  G1 Z{zPenUpMm} F{zFeed}
任务开始                      →  G21 G90 G54
任务结束                      →  G1 Z{zPenUpMm} + G0 X0 Y0（归位，可选）
```

- 主机 `Plan` 保持完整存在（预览着色、`totalDistance`、回溯算法、UI 全部依赖它）；`gcode.ts` 只是执行后端
- 速度取 Block 的 `vFinal`（恒加速段末端速度）；GRBL 的 planner 会对整条路径重新规划，因此实际速度曲线由设备 `$110–$122` 决定——**预计时长估算需按转译后 G-code 路径长度 ÷ 受硬件档案限速值钳制的有效速度重算**，不能直接用 EBB 版的 `estimateMotionDurationSec`；档案值优先级：用户配置 > 设备 `$$` 读取 > 预设档默认

### 7.2 GRBL 流控与 EBB FIFO 的对应

| | EBB 版 | GRBL 版 |
| --- | --- | --- |
| 设备缓冲 | 运动 FIFO（深度可配） | RX 字符缓冲（128 字符）+ planner 块缓冲（默认 16/18 块） |
| 发送许可 | FIFO 深度窗口 | 字符计数窗口（发一行扣字节数，收 `ok` 归还） |
| 排空判定 | `waitUntilMotorsIdle` 轮询 QM | 轮询 `?` 直至 `<Idle`，且全部行已 `ok` |
| 卡死判定 | 应答超时 + QM 探活 | 窗口枯竭且 `ok` 超时 + `?` 状态不推进 |
| 取消 | 清队列 + 500ms 沉降期 | `!` hold → 排空确认 → `0x18` 软复位 → `$X`/`$H` 恢复 |

### 7.3 输入/输出格式矩阵

| 方向 | 格式 | 状态 | 说明 |
| --- | --- | --- | --- |
| 输入 | SVG | 基线继承 | 语义完整输入（transform 引擎 + massager） |
| 输入 | G-code | 3.8 新增 | 构建 Plan（圆弧细分、方言告警），进入标准管线 |
| 输出 | SVG | 基线已有 | `export-svg.ts`；需核对消隐/分色/分层覆盖口径 |
| 输出 | G-code | 3.9 新增 | 复用转译层同口径生成；文件头注明 `$100–$102` 依赖 |
| 暂不支持 | PDF / DXF / EPS | 路线图 | PDF 需外转换（mutool/Inkscape）+ 填充语义处理（描轮廓或 hatch） |

### 7.4 风险清单

| 风险 | 应对 |
| --- | --- |
| 双规划器语义偏差（主机 Block 速度 vs GRBL planner 结果） | 方案 B 已接受该取舍；实测校准 `$` 参数并重算预计时长；文档记录 |
| Z 轴落笔深度因笔尖磨损/纸张厚度漂移 | Z 落笔高度做成 UI 可调项（对齐 EBB 版笔高滑杆体验） |
| 回溯重放与 G-code 行号映射在裁剪/图层过滤后错位 | 复用 EBB 版「原始索引贯穿变换」的既有修复；索引映射表单测覆盖 |
| GRBL 固件碎片化（1.1 / Classic / grblHAL / 厂商分支） | 能力自动探测 + 用户配置覆盖双通道（优先级：配置 > 探测 > 预设档）；差异沉淀为预设档；不支持特性显式降级并提示，不静默失败 |
| 档案传动参数错误经「一键写入」流入固件 → 绘制比例失真 | 固件 `$100–$102` 是绘制权威；写入前二次确认，写入后强制提示试绘 10mm 校准方格验证；日常以「反向同步」（设备实值回填档案）为推荐方向 |
| 开放配置项过多导致新用户无从下手 | 内置 ≥3 个预设档覆盖典型组合；custom 档案缺省值合理，高级项折叠 |
| real-time 命令与行协议交织的竞态 | real-time 单字符立即发送不经队列；协议层单线程化串行处理 |

---

## 8. 里程碑总览

| 里程碑 | 阶段 | 标志性产出 |
| --- | --- | --- |
| M1 | 阶段一 | `DeviceController` 接口落地、EBB 解耦完成、设备调研文档 |
| M2 | 阶段二 | 模拟模式 + 真实设备最小闭环绘制成功 |
| M3 | 阶段三 | 回溯/补画/断连保护全功能对齐 EBB 版水位；G-code 导入与 SVG/G-code 成果导出可用 |
| M4 | 阶段四 | 真机全功能验收通过，发布 `v0.1.0` |
