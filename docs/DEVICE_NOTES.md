# GRBL 目标设备能力矩阵调研（DEVICE_NOTES）

> 用途：为 Bit2AtomPlotGRBLWebUI（GRBL 笔式绘图仪 WebUI）的目标设备适配层提供决策依据。
> 调研日期：2026-09-11。信息来源以官方 Wiki / 源码 / 官方文档 CSV 为准，搜不到权威来源的条目已标注「**待实测确认**」。

---

## ① 固件版本矩阵（含探测方式）

### 1.1 Classic GRBL 0.9 vs 1.1

| 维度 | Grbl 0.9（如 0.9j） | Grbl 1.1（最终 1.1h，gnea/grbl） |
|---|---|---|
| 版本横幅 | `Grbl 0.9j ['$' for help]` | `Grbl 1.1h ['$' for help]`，格式规范 `Grbl X.Xx ['$' for help]`（X.X 主版本 + 小版本字母） |
| `$I` 版本查询 | `[0.9j.20160726:]`（无 `v` 前缀，见实测日志） | `[VER:v1.1f.20170131:可选字符串]` + `[OPT:编译选项码,planner块数,RX字节数]`，例 `[OPT:VL,16,128]` |
| 状态报文分隔符 | 逗号 `,` | 竖线 `\|` |
| 位置字段 | **同时**报 `MPos:` 与 `WPos:` | **只报其一**（由 `$10` 位 0 决定），另以 `WCO:` 间歇刷新，换算关系 `WPos = MPos - WCO` |
| 缓冲区字段 | 无 | `Bf:15,128`（planner 可用块数、RX 可用字节，注意是"可用"而非"已用"），需 `$10` 位 1 开启 |
| 引脚字段 | `Lim:000`（二进制位图） | `Pn:XYZPDHRS`（触发时才出现） |
| 进给/转速字段 | 无 | `FS:进给,转速`（或 `F:`，取决于是否启用可变主轴） |
| 倍率字段 | 无（无倍率功能） | `Ov:100,100,100` + 附件状态 `A:SFM`，间歇刷新（10~30 报一次） |
| `$10` 语义 | 位掩码，可同时开 MPos/WPos/Lim 报文（0.9j 实测默认 `$10=3`，注释"状态报告掩码"） | 仅 2 个选项位：位 0 = MPos(1)/WPos(0)，位 1 = Buf 字段(2)。默认 `1`。bCNC 建议 1.1 用户设 `$10=3`（MPos+Buf），失败时回退 `$10=1` |
| `$$` 输出 | 每行带 `()` 括号人类可读描述 | 去掉括号描述（省 flash），仅 `$x=val` |
| error / ALARM | 人类可读文本（如 `error: Setting disabled`） | 数字码：`error:N` / `ALARM:N` |
| error 码范围 | 文本型，无数值码表 | **1–17、20–38**（经典 1.1 没有 18/19；"40+" 是 grblHAL 的扩展，见下） |
| 实时命令 | `?`(0x3F)、`~`(0x7E)、`!`(0x19)、复位(0x18) | 同左，另新增扩展 ASCII：安全门 0x84、Jog 取消 0x85、进给/快速/转速倍率 0x90–0x9D、主轴停切换 0x9E、冷却切换 0xA0/0xA1 |
| 新增系统命令 | — | `$J=line`（独立点动）、`$SLP`（睡眠）、激光模式 `$32` |
| 默认波特率 | 115200 | 115200 |

主要来源：
- 1.1 变更总表（官方 change_summary.md）：https://github.com/gnea/grbl/blob/master/doc/markdown/change_summary.md
- 1.1 界面协议（状态报文全字段定义、error/alarm 表、流控协议）：https://github.com/gnea/grbl/blob/master/doc/markdown/interface.md
- 1.1 配置 Wiki（`$10` 位定义、`$1=255` 保持锁轴、steps/mm 公式）：https://github.com/gnea/grbl/wiki/Grbl-v1.1-Configuration
- 0.9j 实测 `$$`/报文样例（`$10=3（状态报告掩码）`、逗号分隔双位置）：https://www.grbl.cc/p=94856
- bCNC 对 1.1 的 `$10=3` 建议：https://gitee.com/xiaodelea/bCNC

### 1.2 grblHAL

- 定位：grbl 1.1f 的重写/移植，加入硬件抽象层（HAL），面向 ARM/32 位 MCU（STM32、ESP32、Teensy、RP2040 等 15+ 平台），最高约 300kHz 无抖动脉冲。项目已从 `terjeio/grblHAL` 迁移到 **github.com/grblHAL** 组织（core 仓库活跃，最新构建 20260908）。
  来源：https://github.com/grblHAL/core
- 与经典 1.1 的关键差异（发送端必须处理）：
  1. **错误持久化**：GCode 出错后，后续所有 GCode 都会被拒绝，直到复位 / 收到空行 / 收到 `$` 系统命令——发送端遇 `error:` 必须立即停流（比 1.1 更严格）。
  2. **版本横幅可能为 `GrblHAL 1.1...`**；编译 `COMPATIBILITY_LEVEL=1` 时伪装成 `Grbl 1.1...`，=2 再禁用新增 `$$` 参数，=10 还会禁 G59.1–59.3 与 `$G` 扩展。
  3. **error 码扩充**：新增 18（复位引脚未释放）、19（非正值）、20–48、50（E-Stop）、60–64（SD 卡）、70（蓝牙）等；报警新增 ALARM:10（E-Stop）等。
  4. **`$I` 探测特征**：返回 `[VER:1.1f.20210608:]`、`[NEWOPT:ENUMS,RT+,HOME,TC]`、**`[FIRMWARE:grblHAL]`**、`[DRIVER:STM32F411]`、`[BOARD:...]`、`[PLUGIN:...]`。
  5. **`$$` 参数大量扩展**：大量编译期选项变成 `$xx` 运行时参数（如 `$14` 控制引脚反转掩码、`$340s` 换刀模式等），参数列表长度不定。
  6. **输入默认常闭（NC）**：未接线时可能上电即报警；官方给出规避法：短接 Reset/E-Stop/Door 输入到地，或设 `$14=73` 反转对应输入。
  7. Homing 行为增强：跟踪哪些轴已归位、归位中上报 `Home` 状态；归位失败且设为开机必需时，复位后仍会要求重新归位。
  来源：https://github.com/grblHAL/core/wiki/Changes-from-grbl-1.1 、https://github.com/grblHAL/core 、grblHAL `$I` 实测样例（bCNC 议题转述）：https://www.grbl.cc/p=88251 、grblHAL 错误/报警表中文转译：http://www.grbl.cc/1-5
- 自动探测：`$I` 响应含 `[FIRMWARE:grblHAL]` 即可 100% 识别；辅助信号为横幅含 `GrblHAL` 或 `$$` 中出现 `$14` 等扩展参数。
- 用户配置覆盖：提供 `固件类型 = classic-1.1 / grblHAL` 手动档；grblHAL 档下启用「遇错即停 + 错误持久化提示」，并忽略未知 `$` 参数而不是报错。

### 1.3 grbl-Mega 分支现状

- 原版 `grbl/grbl-Mega`：面向 Arduino Mega2560 的 5–6 轴分支，界面协议按 1.1 系（error:14 明确标注 "Grbl-Mega Only"），但官方仓库长期处于低维护状态。
  来源：https://github.com/gnea/grbl/blob/master/doc/markdown/interface.md （error:14 说明）；仓库 https://github.com/grbl/grbl-Mega
- 社区活跃分支：`fra589/grbl-Mega-5X`（Mega2560 上 4–6 轴，前瞻约 24 块），CNCjs 等上位机仍单列 "Grbl-Mega" 控制器类型。
  来源：https://blog.csdn.net/ghie9090/article/details/161680823 、https://blog.csdn.net/gitblog_00018/article/details/146584457 、https://www.grbl.cc/7-2-html
- 适配结论：**以 Grbl 1.1 与 grblHAL 为一等公民**；grbl-Mega 系在探测层视同 1.1（横幅/`$I` 格式基本一致），planner/RX 缓冲尺寸通过 `$I` 的 `[OPT:...,<blocks>,<rx>]` 动态读取，不要写死。横幅具体字符串（`Grbl` vs `GrblMega`）**待实测确认**。

### 1.4 探测流程建议（版本识别决策树）

1. 连接后等待欢迎横幅，正则 `^Grbl(HAL)?\s+v?(\d+\.\d+)([a-zA-Z])` → 得到主版本；横幅含 `GrblHAL` → grblHAL。
2. 发送 `$I`：含 `[FIRMWARE:grblHAL]` → grblHAL；`[VER:v1.1...]` → 1.1；`[VER:]` 缺失且 `$I` 返回 `[0.9j...]` 形态 → 0.9。
3. 发送 `?` 一次：报文用 `|` 分隔 → 1.1+；仅逗号且同时出现 `MPos` 与 `WPos` → 0.9。
4. 从 `$I` 的 `[OPT:...,<blocks>,<rx>]` 读取 planner 块数与 RX 字节数，动态设置字符计数流控上限。
5. 允许用户在 UI 中手动指定固件类型覆盖自动探测（OEM 可能改写横幅）。
   来源：interface.md（`[OPT:]` 两数字为 planner 块数与 RX 字节数）、change_summary.md、上述 0.9j 实测日志。

---

## ② Z 轴传动换算

### 2.1 通用公式

```
steps/mm = (360° / 步距角θ) × 细分μ × (1/减速比R) ÷ L
```

其中 `L` = 电机转一圈工作台直线行程（mm/rev），由传动形式决定；步距角 θ 常见 1.8°（200 步/rev）或 0.9°（400 步/rev）。
来源：https://github.com/gnea/grbl/wiki/Grbl-v1.1-Configuration （官方给出 `steps_per_mm = (steps_per_revolution*microsteps)/mm_per_rev`）

三种传动形式的 L：

| 传动形式 | L（mm/rev） | 说明 |
|---|---|---|
| 丝杆 | L = 导程 P | 注意**多头丝杆**：导程 = 螺距 × 头数（"T8" 指直径 8mm；T8×8 = 螺距 2mm × 4 头 = 导程 8mm） |
| 同步带 | L = 主动轮齿数 z × 带齿距 p | GT2 带 p=2mm，HTD-3M p=3mm，HTD-5M p=5mm |
| 齿条齿轮 | L = π × 模数 m × 小齿轮齿数 z | 即小齿轮分度圆周长 π·d；英制齿条用径节 DP 换算：d = z/DP（英寸） |

来源：grbl.cc 官方计算器（丝杆/同步带说明、齿轮比）：https://www.grbl.cc/enc_down/jisuan.php ；Klipper 官方文档（多头丝杆导程 = 螺距×头数、同步带 L = 齿距×齿数）：https://www.klipper3d.org/zh/Rotation_Distance.html

### 2.2 算例

**算例 1（丝杆 Z）**：1.8° 电机（200 步/rev）、驱动器 16 细分、T8×8 丝杆（导程 8mm）、直连（R=1）：

```
steps/mm = 200 × 16 / 8 = 400 步/mm
分辨率 = 1/400 = 0.0025 mm/步
```

**算例 2（同步带 Z / XY 通用）**：1.8° 电机、16 细分、GT2 带 + 20 齿同步轮（L = 2×20 = 40mm/rev）：

```
steps/mm = 200 × 16 / 40 = 80 步/mm
分辨率 = 0.0125 mm/步
```

**算例 3（齿条齿轮）**：1.8° 电机、8 细分、模数 1.5、14 齿小齿轮（L = π×1.5×14 ≈ 65.97mm/rev）：

```
steps/mm = 200 × 8 / 65.97 ≈ 24.25 步/mm
```

来源：算例 2 与 Firgelli 工程计算器示例一致（https://www.firgelliauto.com/en-ee/blogs/engineering-calculators/stepper-motor-steps-per-mm-calculator-cnc-and-3d-printer ）；步距角→步数换算来源：https://superglobalcalculator.com/calculators/electronics/stepper-motor/
校准建议：设定后命令移动已知距离（如 100mm）用卡尺/百分表实测，按比例修正 `$10x` 值。来源：https://www.grbl.cc/enc_down/jisuan.php

> 笔式绘图仪注意：Z（抬笔轴）行程极短，steps/mm 只影响回零/深度的线性度，重点保证 XY 精度。

---

## ③ Homing 与限位

### 3.1 `$H` 归位流程

1. 前提：`$22=1`（启用归位）。启用后固件**上电即进入 ALARM 锁定**（编译选项 `HOMING_INIT_LOCK`），欢迎消息后附 `[MSG:'$H'|'$X' to unlock]`，必须 `$H` 归位或 `$X` 解锁。
2. `$H` 执行：搜索阶段（以 `$25` 寻找速率撞向限位开关）→ 定位阶段（以 `$24` 慢速来回精定位，重复 `N_HOMING_LOCATE_CYCLE`=1 次）→ 以 `$27` 拉脱距离退离开关。默认周期顺序为编译期定义：先 Z 轴正向，再 X/Y 同步。
3. `$23` 为归位方向反转掩码；`$26` 为开关去抖延时。

来源：config.h 源码注释（`HOMING_INIT_LOCK`、`HOMING_CYCLE_0 (1<<Z_AXIS)` 等）：https://github.com/gnea/grbl/blob/master/grbl/config.h ；配置 Wiki `$22–$27` 说明：https://github.com/gnea/grbl/wiki/Grbl-v1.1-Configuration

### 3.2 超时行为

- **没有墙钟超时**。搜索距离由行程参数决定：搜索阶段上限 = `1.5 × $13x(max_travel)`（编译宏 `HOMING_AXIS_SEARCH_SCALAR 1.5`），定位阶段 = 5 × `$27` 拉脱距离。
- 超过搜索距离仍未触发开关 → **`ALARM:9`**（Homing fail. Could not find limit switch within search distance）。
- 其他归位报警：ALARM:6（归位中复位）、ALARM:7（归位中开安全门）、ALARM:8（拉脱失败清不开开关）。
- 归位过程中 `?` 状态查询**不保证响应**（官方 interface.md 明示）。

来源：https://github.com/gnea/grbl/blob/master/doc/markdown/interface.md （ALARM 表与 `?` 响应豁免条款）、config.h（`HOMING_AXIS_SEARCH_SCALAR 1.5`）、LightBurn 文档佐证 1.5×max_travel：https://docs.lightburnsoftware.com/1.7/Troubleshooting/GRBLErrors/

### 3.3 `$20` 软限位 / `$21` 硬限位 / `$22`

| 参数 | 作用 | 依赖与行为 |
|---|---|---|
| `$20` 软限位 | 发送运动前检查目标是否超出 `$130–132` 机器行程，超出则立即暂停并 **ALARM:2**（位置保留，可解锁） | **必须先启用 homing** 且 `$13x` 准确，否则设置时直接报 `error:10` |
| `$21` 硬限位 | 限位开关触发立即断步进（**ALARM:1** + `[MSG:Reset to continue]`），位置可能丢失，需复位 | 引脚默认上拉、常开接地触发；`$5` 可反转；上电检测到限位已触发会输出 `[MSG:Check Limits]` |
| `$22` 归位 | 启用 `$H`；启用后上电进入 ALARM 直至归位/解锁 | 无限位开关的设备必须保持 `$22=0` |

来源：https://github.com/gnea/grbl/wiki/Grbl-v1.1-Configuration 、https://github.com/gnea/grbl/blob/master/doc/markdown/interface.md

### 3.4 无限位开关设备的行为（笔式绘图仪常见）

- 应保持 `$20=0、$21=0、$22=0`；此时发送 `$H` 会得到 **`error:5`**（Homing cycle is not enabled via settings）。
- ⚠️ 勘误：常见说法"$H 会报 error:9"不准确——`error:9` 是"G-code 在 ALARM/Jog 状态下被锁定"；归位未启用是 `error:5`。`9` 出现在**报警状态下发送运动指令**（如未解锁就发 G0）时。
- 归位过程中若复位 → ALARM:3/6（位置不保证）。

来源：官方 error 码表 https://github.com/gnea/grbl/blob/master/doc/csv/error_codes_en_US.csv 及 interface.md 内嵌错误表（error:5 / error:9 原文）

### 3.5 WebUI 实现建议

- `$H` 前先查 `$$` 中 `$22` 与 `?` 中 `Pn` 字段；`$22=0` 时直接提示并给 `error:5` 语义解释。
- 上位机自行加 15–30s 兜底超时（固件无墙钟超时，靠 1.5×行程自然终止，但开关失联时表现为长时间不动）。
- 无开关设备提供"跳过归位/软回零"按钮（用 `$J=` 或 G53 定位代替）。

---

## ④ 串口流控与缓冲

### 4.1 缓冲区结构（经典 grbl 1.1，AVR）

| 缓冲区 | 默认大小 | 常量与位置 | 说明 |
|---|---|---|---|
| RX 字符环形缓冲 | **128 字节** | `RX_BUFFER_SIZE 128`（serial.h，可覆盖 1–254） | 字符计数流控的基准 |
| TX 缓冲 | 104（启用行号时 112） | `TX_BUFFER_SIZE`（serial.h） | 主要承载回显消息；0.9 版为 64（**待实测确认**，据社区源码分析） |
| planner 块缓冲 | **16 块** | `BLOCK_BUFFER_SIZE 16`（planner.h，config.h 可覆盖；启用行号宏后为 15） | 0.9 版为 18 块（**待实测确认**）；Mega 系更大，勿写死 |
| 行缓冲 | 80 字符 | `LINE_BUFFER_SIZE 80`（protocol.h） | 单行超长 → `error:11` |
| 分段缓冲 | 6 段 | `SEGMENT_BUFFER_SIZE 6`（stepper.h） | — |

来源：serial.h 源码 https://github.com/gnea/grbl/blob/master/grbl/serial.h ；config.h https://github.com/gnea/grbl/blob/master/grbl/config.h ；interface.md 明示"serial receive buffer up to 127 characters / planner 16 lines"
> 常量名备注：1.1 源码中为 `RX_BUFFER_SIZE`；`RX_BUFFER_CAPACITY` 等命名见于部分派生分支/文档（**待实测确认**对应仓库），语义相同。
> ⚠️ 重要：planner 块数与 RX 字节数可通过 `$I` 的 `[OPT:...,16,128]` 动态读出，应据此适配流控而非硬编码。

### 4.2 字符计数流控协议（Character-Counting）

- 上位机维护"已发送未确认字符数"（**包含每行末尾 CR/LF**），上限 = RX 缓冲 128；收到每条 `ok`/`error:` 响应时扣减该行字符数。
- 官方示例：5 行分别 25/40/31/58/20 字符；先发 25+40+31=96，收到第 1 条响应后缓冲剩 71，58+71=129>128 故等待，收到下一条响应后剩余 31，可再发 58+20=110。
- `<>`（状态报文）与 `[]`（推送消息）**不参与计数**，需单独处理；实时命令字符随时可插发。
- 官方保留意见（RESERVATION）：若某行产生 `error:`，缓冲内后续行仍会被继续执行，无法撤回 → 建议**先 `$C` 检查模式预检全文件**再正式流式发送。
- `$x=` 等 EEPROM 写命令**禁止**用字符计数协议发送（AVR 写 EEPROM 时关闭 RX 中断，会丢数据）——设置写入用 send-response 模式。
- `Bf:` 缓冲字段**不可**用于流控（读到时已过时，官方明令禁止）。

来源：https://github.com/gnea/grbl/blob/master/doc/markdown/interface.md （Streaming / EEPROM Issues / Buffer State 章节）

### 4.3 实时命令（不占缓冲）

`?`(0x3F)、`~`(0x7E)、`!`(0x19)、复位(0x18) 及扩展 ASCII（0x84 安全门、0x85 Jog 取消、0x90–0x9D/0x9E 倍率与主轴停、0xA0/0xA1 冷却切换）在 RX **中断 ISR 中被直接摘除**，不进入 RX 缓冲、不参与计数、无需回车，可任意时刻插发。复位 0x18 会同时清空接收缓冲。
来源：config.h 实时命令定义：https://github.com/gnea/grbl/blob/master/grbl/config.h ；interface.md Real-Time Control Commands 章节

### 4.4 其他约束

- 状态查询频率官方建议 **≤5Hz**（10Hz 可行但收益递减、加重 CPU 负担）；连续多个 `?` 只有第一个生效。
- 同步点：需要"等待排空"时插 `G4 P0.01` 官方推荐。
来源：interface.md

---

## ⑤ 波特率

| 波特率 | 情况 |
|---|---|
| **115200** | 官方默认（0.9 / 1.1 / grblHAL / ESP32 变体均为此），8-N-1。来源：https://github.com/gnea/grbl/wiki/Grbl-v1.1-Configuration （"Set the baud rate to 115200 as 8-N-1"）、https://www.grbl.cc/p=94744 （"默认设置为 115200 波特，N-8-1"） |
| 9600 | 0.8 及更早时代默认；现役固件一般不支持。外接蓝牙（HC-05/06）需用 AT 指令把模块也改成 115200 匹配 1.1 固件。来源：https://www.grbl.cc/7-2-html （"GRBL 1.1v 固件的默认波特率是 115200"） |
| 250000 | 部分板卡可用：需编译期修改 `BAUD_RATE`（config.h，官方注释示例还有 230400），且依赖 USB-串口芯片与上位机支持；AVR 16MHz 下 250000 的 UBRR 分频误差较小故常见于 Mega/部分 OEM 板。来源：config.h `// #define BAUD_RATE 230400`、社区波特率选型表 https://blog.csdn.net/gitblog_00257/article/details/151907198 |
| 更高（≥1M） | 32 位 grblHAL 板支持（如 grblHAL/Due 实测 2M），仅限对应驱动。来源：https://www.grbl.cc/p=5184 |

WebUI 建议：波特率下拉提供 `9600 / 57600 / 115200（默认）/ 250000`，连接失败时自动降级扫描 115200→9600。波特率是**编译期属性**，不存在运行时 `$` 参数（网传"用 `$11` 设波特率"是错误信息）。

---

## ⑥ $ 参数速查表（Classic GRBL 1.1）

| 参数 | 含义 | 单位/默认 | 备注 |
|---|---|---|---|
| `$0` | 步进脉冲宽度 | µs，默认 10 | 最小 >3µs（`error:6`） |
| `$1` | 步进空闲延时 | ms，默认 25 | **`255` = 永不失能（保持锁轴）**，笔架防滑落用 |
| `$2` | 步进脉冲反转掩码 | 位图 bit0/1/2=XYZ | — |
| `$3` | 方向反转掩码 | 位图 | 改变轴的正方向 |
| `$4` | 使能引脚反转 | 布尔 | — |
| `$5` | 限位引脚反转 | 布尔 | 默认上拉/常开 |
| `$6` | 探针引脚反转 | 布尔 | — |
| `$10` | 状态报文选项 | 位图，默认 1 | 位0：MPos(1)/WPos(0)；位1：`Bf:` 缓冲字段(2)。推荐 `1` 或 `3` |
| `$11` | 拐角偏差 | mm，默认 0.010 | 越小过弯越保守 |
| `$12` | 圆弧公差 | mm，默认 0.002 | — |
| `$13` | 英制报文 | 布尔，默认 0 | **影响 `?`/`$#` 所有坐标与速率的单位**，解析报文前必须确认 |
| `$20` | 软限位 | 布尔，默认 0 | 依赖 `$22=1`，否则 `error:10` |
| `$21` | 硬限位 | 布尔，默认 0 | 触发即 ALARM:1 |
| `$22` | 归位循环 | 布尔，默认 0（固件默认 1，多数 OEM 关） | 启用后上电 ALARM 锁定 |
| `$23` | 归位方向反转掩码 | 位图 | — |
| `$24` | 归位定位速率 | mm/min，默认 25 | — |
| `$25` | 归位搜索速率 | mm/min，默认 500 | — |
| `$26` | 归位去抖 | ms，默认 250 | — |
| `$27` | 归位拉脱距离 | mm，默认 1.000 | — |
| `$30`/`$31` | 主轴最大/最小转速 | RPM，默认 1000/0 | 决定 S 值→PWM 占空比线性映射；笔式抬笔舵机多为 OEM 自定义映射（**待实测确认**） |
| `$32` | 激光模式 | 布尔，默认 0 | 绘图仪一般 0；连续 S 变化不停机 |
| `$100–102` | X/Y/Z 步进当量 | 步/mm | 见 §② 换算 |
| `$110–112` | X/Y/Z 最大速率 | mm/min | 同时是 G0 速度上限 |
| `$120–122` | X/Y/Z 加速度 | mm/s² | 多轴联动取最慢轴 |
| `$130–132` | X/Y/Z 最大行程 | mm | 供软限位与归位搜索距离（1.5×）使用 |

来源：https://github.com/gnea/grbl/wiki/Grbl-v1.1-Configuration 、https://github.com/gnea/grbl/blob/master/doc/markdown/interface.md
> grblHAL 注意：以上编号语义一致，但追加大量扩展参数（如 `$14` 控制输入反转掩码、`$39`…），解析 `$$` 时应忽略未知编号而非报错。来源：https://github.com/grblHAL/core/wiki/Changes-from-grbl-1.1

---

## ⑦ 内置预设档草案

> 预设仅作初始值，写入前应逐项经用户确认；所有「行程」字段必须按实际机型修改。

### 预设 A：GRBL 1.1 · 丝杆 Z 笔式绘图仪（ATmega328P + CNC Shield）

XY 为 GT2 带 + 20 齿轮（16 细分），Z 为 T8×8 丝杆（16 细分），舵机抬笔。

| 字段 | 建议值 | 依据 |
|---|---|---|
| firmware | `grbl-1.1` | — |
| baudRate | `115200` | §⑤ |
| `$0` | `10` | Wiki 默认 |
| `$1` | `255` | 保持锁轴防笔架滑落（Wiki $1 说明） |
| `$10` | `3` | MPos + Bf，便于调试（bCNC 建议） |
| `$13` | `0` | 统一公制解析 |
| `$20`/`$21`/`$22` | `0`/`0`/`0` | 无限位开关设备（§③.4） |
| `$30`/`$31` | `1000`/`0` | 舵机映射依 OEM（待实测） |
| `$100`/`$101` | `80` / `80` | 算例 2 |
| `$102` | `400` | 算例 1 |
| `$110`/`$111` | `6000` / `6000` | GT2 轻载带轴保守值 |
| `$112` | `1500` | 丝杆 Z 慢速 |
| `$120`/`$121` | `800` / `800` | 笔式轻负载 |
| `$122` | `200` | 丝杆 Z 保守加速度 |
| `$130`/`$131`/`$132` | 实测行程 | 软限位/归位依赖 |

### 预设 B：GRBL 1.1 · 同步带 Z 抬笔轴

与预设 A 的差异项（其余同 A）：

| 字段 | 建议值 | 依据 |
|---|---|---|
| zDrive | `belt:GT2,20T,16µstep` | — |
| `$102` | `80` | 算例 2（Z 同公式） |
| `$112` | `3000` | 带轴 Z 可达速率 |
| `$122` | `500` | 皮带抬起机构加速度 |
| `$1` | `255` | 断电后笔架靠带自锁性差，务必保持锁轴 |

### 预设 C：grblHAL（STM32/ESP32 通用）

| 字段 | 建议值 | 依据 |
|---|---|---|
| firmware | `grblHAL` | `$I` 含 `[FIRMWARE:grblHAL]` |
| baudRate | `115200` | §⑤ |
| `$10` | `1` | 兼容 1.1 解析；`3` 亦可 |
| `$14` | `73` | **仅当**未接任何控制输入且上电报警时（官方 README 规避法） |
| 机械参数 | 复制预设 A 对应项 | grblHAL 与 1.1 编号语义一致 |
| errorHandling | `persistent`（遇 error 停流+提示空行/复位解锁） | Changes-from-grbl-1.1 |
| 扩展处理 | `$$` 未知参数忽略；`[NEWOPT:]` 记录不阻断 | 同上 |

> 补充：grblHAL 伪装模式（`COMPATIBILITY_LEVEL=1`）下横幅是 `Grbl 1.1...`，只能靠 `[FIRMWARE:grblHAL]` 识别——`$I` 探测必须做。来源：https://github.com/grblHAL/core/wiki/Changes-from-grbl-1.1

---

## 附：待实测确认清单

1. Grbl 0.9 的 `TX_BUFFER_SIZE=64`、`BLOCK_BUFFER_SIZE=18` 具体值（据社区源码分析，未直接核对 0.9 源码）。
2. grbl-Mega / grbl-Mega-5X 的版本横幅字符串与 planner 缓冲实际大小。
3. 笔式绘图仪抬笔舵机的 `S` 值→PWM/脉宽映射（随 OEM 固件而异）。
4. `RX_BUFFER_CAPACITY` 常量命名对应的仓库/分支（1.1 官方源码为 `RX_BUFFER_SIZE`）。
5. 各 OEM 板（如 grbl.cc 所列 ENC 系列板）是否有自定义波特率/报文（官网"用户必读"提示了 400kHz 脉冲上限等 OEM 差异）。

## 附：主要参考来源汇总

- 官方 1.1 变更总表：https://github.com/gnea/grbl/blob/master/doc/markdown/change_summary.md
- 官方 1.1 界面协议/流控/错误表：https://github.com/gnea/grbl/blob/master/doc/markdown/interface.md
- 官方 1.1 配置 Wiki：https://github.com/gnea/grbl/wiki/Grbl-v1.1-Configuration
- 源码 config.h：https://github.com/gnea/grbl/blob/master/grbl/config.h ；serial.h：https://github.com/gnea/grbl/blob/master/grbl/serial.h
- 官方错误码 CSV：https://github.com/gnea/grbl/blob/master/doc/csv/error_codes_en_US.csv
- grblHAL 主仓库：https://github.com/grblHAL/core ；与 1.1 差异 Wiki：https://github.com/grblHAL/core/wiki/Changes-from-grbl-1.1
- grblHAL 错误/报警表（中文转译）：http://www.grbl.cc/1-5
- grbl.cc 串口设置：https://www.grbl.cc/p=94744 ；轴参数计算器：https://www.grbl.cc/enc_down/jisuan.php ；0.9j 实测日志：https://www.grbl.cc/p=94856
- Klipper 旋转距离（多头丝杆/带传动公式）：https://www.klipper3d.org/zh/Rotation_Distance.html
- Firgelli steps/mm 计算器：https://www.firgelliauto.com/en-ee/blogs/engineering-calculators/stepper-motor-steps-per-mm-calculator-cnc-and-3d-printer
- LightBurn GRBL 错误文档：https://docs.lightburnsoftware.com/1.7/Troubleshooting/GRBLErrors/
- bCNC 控制器设置建议（$10=3）：https://gitee.com/xiaodelea/bCNC
- grbl-Mega-5X 社区分支介绍：https://blog.csdn.net/ghie9090/article/details/161680823
