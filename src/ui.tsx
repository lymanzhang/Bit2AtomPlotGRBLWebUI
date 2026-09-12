/**
 * Front-end for plotter app.
 */

import interpolator from "color-interpolate";
import colormap from "colormap";
import { flattenSVG, type Path } from "flatten-svg";
import React, {
  type ChangeEvent,
  Fragment,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { planToSvg } from "./export-svg.js";
import { planToGCode } from "./export-gcode.js";
import { parseGcode } from "./gcode-import.js";
import { PaperSize } from "./paper-size";
import {
  computeMicrostepsPerMm,
  computeStepsPerMm,
  computeZStepsPerMm,
  defaultPlanOptions,
  type GrblParamComparison,
  GRBL_PRESET_KEYS,
  GRBL_PRESET_PROFILES,
  type MotionData,
  Plan,
  type PlanOptions,
  pathGroupStarts,
  type SavedProfile,
  XYMotion,
  type FirmwareKind,
  type OriginCorner,
  type ZDriveType,
  applyMachineFrame,
  machineFramePoint,
} from "./planning.js";
import useComponentSize from "./useComponentSize.js";
import { defaultPlacement, formatDuration, mmPerSvgUnitFromSvg, type Placement } from "./util.js";

import "./style.css";
import bit2atomLogo from "./bit2atomLogo.svg";
import { type BaseDriver, Bit2AtomDriver, type DeviceInfo, WebSerialDriver } from "./drivers";
import type { Hardware } from "./device-controller.js";
import pathJoinRadiusIcon from "./icons/path-joining radius.svg";
import pointJoinRadiusIcon from "./icons/point-joining radius.svg";
import rotateDrawingIcon from "./icons/rotate-drawing.svg";

const defaultVisualizationOptions = {
  penStrokeWidth: 0.5,
  colorPathsByStrokeOrder: false,
};

// 预览最大放大倍数（最小为 1 = 充满绘制区域）
const MAX_ZOOM = 40;

const initialState = {
  connected: true,

  paused: false,

  deviceInfo: null as DeviceInfo | null,

  // UI state
  planOptions: defaultPlanOptions,
  visualizationOptions: defaultVisualizationOptions,

  // Options used to produce the current value of |plan|.
  plannedOptions: null as PlanOptions | null,

  // Info about the currently-loaded SVG.
  paths: null as Path[] | null,
  groupLayers: [] as string[],
  strokeLayers: [] as string[],

  // While a plot is in progress, this will be the index of the current motion.
  progress: null as number | null,
  // 已绘制水位线：绘制（或补画）进行/结束期间已画到的最大运动索引。
  // 绘制结束后 progress 清空，但仍用它保留"已画过"的着色，避免未重画的路径回退为白色。
  drawnWatermark: null as number | null,
  isSimulating: false,

  // 暂停回溯重绘：将被重绘的运动索引区间 [from, to)。null 表示无回溯。
  rewindRange: null as { from: number; to: number } | null,
  // 已重绘（或正在重绘）的区间列表，绘制完成后保留，供用户检查重复绘制区域。
  redrawnRanges: [] as { from: number; to: number }[],
  // 补画模式（绘制结束后）：双滑块选择路径区间，仅重绘选中区间。
  redrawMode: false as boolean,
};

// Update the initial state with previously persisted settings (if present)

const persistedPlanOptions = JSON.parse(window.localStorage.getItem("planOptions") ?? "{}");
initialState.planOptions = { ...initialState.planOptions, ...persistedPlanOptions };
initialState.planOptions.paperSize = new PaperSize(initialState.planOptions.paperSize.size);
// 迁移旧版持久化数据：旧 fitPage 布尔值 → scaleMode 三态
if (persistedPlanOptions.scaleMode == null && persistedPlanOptions.fitPage === false) {
  initialState.planOptions.scaleMode = "actual";
}
delete (initialState.planOptions as Partial<PlanOptions> & { fitPage?: boolean }).fitPage;

type State = typeof initialState;

type Action =
  | { type: "SET_PLAN_OPTION"; value: Partial<State["planOptions"]> }
  | { type: "SET_VISUALIZATION_OPTION"; value: Partial<State["visualizationOptions"]> }
  | { type: "SET_DEVICE_INFO"; value: State["deviceInfo"] }
  | { type: "SET_PAUSED"; value: boolean }
  | { type: "SET_PROGRESS"; motionIdx: number | null }
  | { type: "SET_DRAWN_WATERMARK"; value: number | null }
  | { type: "SET_SIMULATING"; value: boolean }
  | { type: "SET_CONNECTED"; connected: boolean }
  | { type: "SET_REWIND_RANGE"; value: State["rewindRange"] }
  | { type: "SET_REDRAWN_RANGES"; value: State["redrawnRanges"] }
  | { type: "SET_REDRAW_MODE"; value: State["redrawMode"] }
  | {
      type: "SET_PATHS";
      paths: State["paths"];
      strokeLayers: State["strokeLayers"];
      selectedStrokeLayers: State["planOptions"]["selectedStrokeLayers"];
      groupLayers: State["groupLayers"];
      selectedGroupLayers: State["planOptions"]["selectedGroupLayers"];
      layerMode: State["planOptions"]["layerMode"];
      /** 本次加载的 SVG 推算出的用户单位→mm 换算系数（无绝对单位时为
       * undefined，规划时回退 96dpi 缺省值）。每次加载文件都会整体替换。 */
      mmPerSvgUnit?: number;
      /** 导入文件坐标已烘焙的旋转角（度）。仅本应用导出的 SVG 携带
       * data-b2a-rotate-deg 标记，外部文件为 0。每次加载文件都会整体替换。 */
      bakedRotationDeg?: number;
    }
  | { type: "CLEAR_PATHS" };

type Dispatcher = React.Dispatch<Action>;
const nullDispatch: Dispatcher = () => null;
const DispatchContext = React.createContext<Dispatcher>(nullDispatch);

/**
 * State machine reducer. Handle actions that update the state.
 * @param state Previous state
 * @param action Message
 * @returns New state
 */
function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "SET_PLAN_OPTION":
      return { ...state, planOptions: { ...state.planOptions, ...action.value } };
    case "SET_VISUALIZATION_OPTION":
      return { ...state, visualizationOptions: { ...state.visualizationOptions, ...action.value } };
    case "SET_DEVICE_INFO":
      return { ...state, deviceInfo: action.value };
    case "SET_PAUSED":
      return { ...state, paused: action.value };
    case "SET_PATHS": {
      const { paths, strokeLayers, selectedStrokeLayers, groupLayers, selectedGroupLayers, layerMode, mmPerSvgUnit, bakedRotationDeg } = action;
      return {
        ...state,
        paths,
        groupLayers,
        strokeLayers,
        planOptions: {
          ...state.planOptions,
          selectedStrokeLayers,
          selectedGroupLayers,
          layerMode,
          mmPerSvgUnit,
          bakedRotationDeg,
          // 载入新文件时排版参数回归缺省：这些参数持久化在 localStorage，
          // 若不复位，上一次会话的旋转/对齐/缩放设置会被静默套用到新文件
          // （典型事故：上次设过「旋转 90°」，这次读入的图就莫名转了 90°）。
          rotateDrawing: 0,
          placement: { ...defaultPlacement },
          scaleMode: "fit",
        },
      };
    }
    case "CLEAR_PATHS":
      return {
        ...state,
        paths: null,
        groupLayers: [],
        strokeLayers: [],
        rewindRange: null,
        redrawnRanges: [],
        redrawMode: false,
        planOptions: {
          ...state.planOptions,
          selectedGroupLayers: new Set(),
          selectedStrokeLayers: new Set(),
          layerMode: "stroke",
        },
      };
    case "SET_PROGRESS":
      return {
        ...state,
        progress: action.motionIdx,
        // progress 推进时抬升水位线；结束后（null）保留水位线，维持"已画过"着色。
        drawnWatermark:
          action.motionIdx == null ? state.drawnWatermark : Math.max(state.drawnWatermark ?? 0, action.motionIdx),
      };
    case "SET_DRAWN_WATERMARK":
      return { ...state, drawnWatermark: action.value };
    case "SET_SIMULATING":
      return { ...state, isSimulating: action.value };
    case "SET_CONNECTED":
      return { ...state, connected: action.connected };
    case "SET_REWIND_RANGE":
      return { ...state, rewindRange: action.value };
    case "SET_REDRAWN_RANGES":
      return { ...state, redrawnRanges: action.value };
    case "SET_REDRAW_MODE":
      return { ...state, redrawMode: action.value };
    default:
      console.warn(`Unrecognized action '${JSON.stringify(action)}'`);
      return state;
  }
}

// FIXME: This should probably be used for the WebWorker
function serialize(po: PlanOptions): string {
  return JSON.stringify(po, (_k, v) => (v instanceof Set ? [...v] : v));
}

function attemptRejigger(previousOptions: PlanOptions, newOptions: PlanOptions, previousPlan: Plan): Plan | null {
  const newOptionsWithOldPenHeights = {
    ...newOptions,
    penUpHeight: previousOptions.penUpHeight,
    penDownHeight: previousOptions.penDownHeight,
  };
  if (serialize(previousOptions) === serialize(newOptionsWithOldPenHeights)) {
    // Plan 笔位为 pct 口径（0 = 完全抬笔，100 = 完全落笔），直接复用
    return previousPlan.withPenHeights(newOptions.penUpHeight, newOptions.penDownHeight);
  }
  return null;
}

const usePlan = (paths: Path[] | null, planOptions: PlanOptions) => {
  const [isPlanning, setIsPlanning] = useState(false);
  const [latestPlan, setPlan] = useState<Plan | null>(null);

  const lastPaths = useRef<Path[]>(null);
  const lastPlan = useRef<Plan>(null);
  const lastPlanOptions = useRef<PlanOptions>(null);

  useEffect(() => {
    if (!paths) {
      return () => {};
    }
    if (lastPlan.current != null && lastPaths.current === paths) {
      const rejiggered = attemptRejigger(lastPlanOptions.current ?? defaultPlanOptions, planOptions, lastPlan.current);
      if (rejiggered) {
        setPlan(rejiggered);
        lastPlan.current = rejiggered;
        lastPlanOptions.current = planOptions;
        return () => {};
      }
    }
    lastPaths.current = paths;
    const worker = new Worker("background-planner.js");
    setIsPlanning(true);
    console.time("posting to worker");
    // FIXME: planOptions contains Set objects which get converted to empty objects {}
    // during structured cloning. Should use: { paths, planOptions: JSON.parse(serialize(planOptions)) }
    worker.postMessage({ paths, planOptions });
    console.timeEnd("posting to worker");
    const listener = (m: Record<"data", MotionData[]>) => {
      console.time("deserializing");
      const deserialized = Plan.deserialize(m.data);
      console.timeEnd("deserializing");
      setPlan(deserialized);
      lastPlan.current = deserialized;
      lastPlanOptions.current = planOptions;
      setIsPlanning(false);
    };
    worker.addEventListener("message", listener);
    return () => {
      worker.removeEventListener("message", listener);
      worker.terminate();
      setIsPlanning(false);
    };
  }, [paths, planOptions]);

  return { isPlanning, plan: latestPlan, setPlan };
};

const setPaths = (paths: Path[], mmPerSvgUnit?: number, bakedRotationDeg = 0): Action => {
  const strokes = new Set<string>();
  const groups = new Set<string>();
  for (const path of paths) {
    strokes.add(path.stroke);
    groups.add(path.groupId);
  }
  const layerMode = groups.size > 1 ? "group" : "stroke";
  const groupLayers = Array.from(groups).sort();
  const strokeLayers = Array.from(strokes).sort();
  return {
    type: "SET_PATHS",
    paths,
    groupLayers,
    strokeLayers,
    selectedGroupLayers: new Set(groupLayers),
    selectedStrokeLayers: new Set(strokeLayers),
    layerMode,
    mmPerSvgUnit,
    bakedRotationDeg,
  };
};

const CUSTOM_PROFILES_KEY = "bit2atombot.customProfiles";

function loadSavedProfiles(): SavedProfile[] {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_PROFILES_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function saveSavedProfiles(profiles: SavedProfile[]): void {
  localStorage.setItem(CUSTOM_PROFILES_KEY, JSON.stringify(profiles));
}

function DriveParams({ state }: { state: State }) {
  const dispatch = useContext(DispatchContext);
  const dp = state.planOptions.driveParams;
  const set = (partial: Partial<typeof dp>) =>
    dispatch({ type: "SET_PLAN_OPTION", value: { driveParams: { ...dp, ...partial } } });
  const setFw = (partial: Partial<NonNullable<typeof dp.firmware>>) =>
    set({ firmware: { ...dp.firmware, ...partial } });
  // 工作区输入用本地文本态：直接绑 Number 值时，输入第一个数字会因
  // 「另一维度尚未填写 → 视为未配置清空」被立刻抹掉，表现为无法输入。
  const [waText, setWaText] = useState(() => ({
    x: dp.workingAreaMm?.x != null ? String(dp.workingAreaMm.x) : "",
    y: dp.workingAreaMm?.y != null ? String(dp.workingAreaMm.y) : "",
  }));
  // 档案切换/反向同步等外部变更回填文本（仅当与当前文本解析值不同，避免覆盖输入中内容）
  React.useEffect(() => {
    setWaText((t) => {
      const nx = dp.workingAreaMm?.x;
      const ny = dp.workingAreaMm?.y;
      return {
        x: nx != null && Number(t.x) !== nx ? String(nx) : t.x,
        y: ny != null && Number(t.y) !== ny ? String(ny) : t.y,
      };
    });
  }, [dp.workingAreaMm?.x, dp.workingAreaMm?.y]);
  const setWorkingArea = (axis: "x" | "y", raw: string) => {
    const next = { ...waText, [axis]: raw };
    setWaText(next);
    const x = Number(next.x);
    const y = Number(next.y);
    // 两维均为有效正数才提交；否则视为未配置（服务端仅告警）。文本保留，
    // 允许「先填宽、再填高」的输入过程。
    set({ workingAreaMm: x > 0 && y > 0 ? { x, y } : undefined });
  };
  // $110-$112 最大速度（mm/min）单轴回填；0/负值视为未配置
  const setMaxVel = (axis: "x" | "y" | "z", raw: string) => {
    const v = Number(raw);
    setFw({ maxVelocityMmMin: { ...(dp.firmware?.maxVelocityMmMin ?? {}), [axis]: v > 0 ? v : undefined } });
  };
  const setMaxAccel = (axis: "x" | "y" | "z", raw: string) => {
    const v = Number(raw);
    setFw({ maxAccelMmS2: { ...(dp.firmware?.maxAccelMmS2 ?? {}), [axis]: v > 0 ? v : undefined } });
  };
  const stepsPerMm = computeStepsPerMm(dp);
  const microstepsPerMm = computeMicrostepsPerMm(dp);
  const zStepsPerMm = computeZStepsPerMm(dp);
  const zType = dp.zDriveType ?? "screw";
  const fw = dp.firmware ?? {};

  // ---- 2.7 参数助手 ----
  const [probe, setProbe] = useState<{ comparisons: GrblParamComparison[] } | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const fmtVal = (v: number) => Number(v.toFixed(4)).toString();
  const deviceVal = (key: string) => probe?.comparisons.find((c) => c.key === key)?.device ?? null;

  const readDeviceParams = async (): Promise<void> => {
    setProbing(true);
    setProbeError(null);
    try {
      const res = await fetch("/grbl/params", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dp),
      });
      if (!res.ok) {
        setProbe(null);
        setProbeError(await res.text());
        return;
      }
      setProbeError(null);
      setProbe((await res.json()) as { comparisons: GrblParamComparison[] });
    } catch (e) {
      setProbeError((e as Error).message);
    } finally {
      setProbing(false);
    }
  };

  /** 反向同步（推荐方向）：以设备 $$ 实值为准回填档案。XY/Z 细分由设备
   * 步/mm 除以档案全步密度整周导出；速度/加速度直接回填。 */
  const syncFromDevice = (): void => {
    if (!probe) return;
    const next = { ...dp };
    const changes: string[] = [];
    // XY 细分回解：$100（缺则 $101）÷ 全步/mm ≈ 整数细分
    const xyFull = computeStepsPerMm(dp);
    const devXY = deviceVal("100") ?? deviceVal("101");
    if (devXY != null && xyFull > 0) {
      const micro = Math.round(devXY / xyFull);
      if (micro >= 1 && Math.abs(devXY - micro * xyFull) <= Math.max(0.01, devXY * 0.005)) {
        if (micro !== dp.microstepping) {
          next.microstepping = micro;
          changes.push(`细分 ${dp.microstepping} → ${micro}（$100=${fmtVal(devXY)}）`);
        }
      } else {
        changes.push(
          `$100=${fmtVal(devXY)} 无法由档案传动参数（全步 ${fmtVal(xyFull)} 步/mm）整除出细分，请核对步距角/齿数/齿距`,
        );
      }
    }
    // Z 细分回解：$102 ÷ Z 全步/mm
    const zFull = computeZStepsPerMm(dp);
    const devZ = deviceVal("102");
    if (devZ != null && zFull > 0) {
      const micro = Math.round(devZ / zFull);
      const curZMicro = dp.zMicrostepping ?? dp.microstepping;
      if (micro >= 1 && Math.abs(devZ - micro * zFull) <= Math.max(0.01, devZ * 0.005)) {
        if (micro !== curZMicro) {
          next.zMicrostepping = micro;
          changes.push(`Z 细分 ${curZMicro} → ${micro}（$102=${fmtVal(devZ)}）`);
        }
      } else {
        changes.push(`$102=${fmtVal(devZ)} 无法由档案 Z 传动参数整除出细分，请核对导程/齿距`);
      }
    }
    // 速度/加速度：设备实值直接回填（档案字段缺失视为已同步）
    const vel = { ...dp.firmware?.maxVelocityMmMin };
    const acc = { ...dp.firmware?.maxAccelMmS2 };
    for (const [key, axis] of [
      ["110", "x"],
      ["111", "y"],
      ["112", "z"],
      ["120", "x"],
      ["121", "y"],
      ["122", "z"],
    ] as const) {
      const v = deviceVal(key);
      if (v == null) continue;
      const isVel = Number(key) < 120;
      const target = isVel ? vel : acc;
      if (target[axis] !== v) {
        target[axis] = v;
        changes.push(`$${key} → ${isVel ? "最大速度" : "最大加速度"} ${axis.toUpperCase()} = ${fmtVal(v)}`);
      }
    }
    if (Object.keys(vel).length > 0 || Object.keys(acc).length > 0) {
      next.firmware = { ...dp.firmware, maxVelocityMmMin: vel, maxAccelMmS2: acc };
    }
    if (changes.length === 0) {
      alert("设备参数与档案一致，无需同步。");
      return;
    }
    if (!confirm(`将按设备实值更新以下档案项：\n${changes.join("\n")}\n\n继续？`)) return;
    set(next);
    setProbe(null);
  };

  /** 可选一键写入：将档案换算值写入 $100–$102（需用户确认）。 */
  const writeSuggestions = async (): Promise<void> => {
    if (!probe) return;
    const mismatched = probe.comparisons.filter(
      (c) => ["100", "101", "102"].includes(c.key) && c.match === false && c.suggested != null,
    );
    if (mismatched.length === 0) {
      alert("步/mm（$100–$102）无差异，无需写入。");
      return;
    }
    const lines = mismatched.map(
      (c) => `$${c.key} = ${fmtVal(c.suggested as number)}（设备当前 ${c.device != null ? fmtVal(c.device) : "—"}）`,
    );
    if (
      !confirm(
        `将把档案建议值写入设备：\n${lines.join("\n")}\n\n注意：写入后建议重启设备并试绘 10mm 校准方格验证比例。继续？`,
      )
    ) {
      return;
    }
    try {
      const res = await fetch("/grbl/params/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: Object.fromEntries(mismatched.map((c) => [c.key, c.suggested as number])),
        }),
      });
      if (!res.ok) {
        alert(`写入失败：${await res.text()}`);
        return;
      }
      const result = (await res.json()) as { written: string[]; errors: { key: string; message: string }[] };
      const errText = result.errors.map((e) => `$${e.key}: ${e.message}`).join("；");
      alert(`已写入：${result.written.map((k) => `$${k}`).join(", ") || "无"}${errText ? `\n失败：${errText}` : ""}`);
      await readDeviceParams();
    } catch (e) {
      alert(`写入请求发送失败：${(e as Error).message}`);
    }
  };

  return (
    <div>
      <label title="此配置的名称，方便后续识别">
        设备名称
        <input
          type="text"
          className="center-text"
          value={dp.name}
          onChange={(e) => {
            const v = e.target.value;
            set({ name: v });
          }}
        />
      </label>
      <div className="drive-group-title">
        传动参数（XY）
        <span className="drive-group-subtitle">建议值对照 $100/$101</span>
      </div>
      <div className="flex">
        <label title="步进电机每一步的转角">
          步距角 (&deg;)
          <input
            type="number"
            value={dp.stepAngle}
            step="0.1"
            min="0.1"
            onChange={(e) => set({ stepAngle: Number(e.target.value) })}
          />
        </label>
        <label title="驱动器微步细分">
          细分
          <input
            type="number"
            value={dp.microstepping}
            step="1"
            min="1"
            onChange={(e) => set({ microstepping: Number(e.target.value) })}
          />
        </label>
      </div>
      <div className="flex">
        <label title="同步轮齿数">
          同步轮齿数
          <input
            type="number"
            value={dp.pulleyTeeth}
            step="1"
            min="1"
            onChange={(e) => set({ pulleyTeeth: Number(e.target.value) })}
          />
        </label>
        <label title="同步带齿距 (mm)">
          齿距 (mm)
          <input
            type="number"
            value={dp.beltPitch}
            step="0.1"
            min="0.1"
            onChange={(e) => set({ beltPitch: Number(e.target.value) })}
          />
        </label>
      </div>
      <div className="drive-params-result">
        <div className="drive-result-row">
          <div className="drive-result-label">
            stepsPerMm
            <span className="drive-result-sub">（$100/$101 建议）</span>
          </div>
          <strong>{stepsPerMm.toFixed(4)}</strong>
        </div>
        <div className="drive-result-row">
          <div className="drive-result-label">微步值</div>
          <strong>{microstepsPerMm.toFixed(4)}</strong>
        </div>
      </div>
      <div className="drive-group-title">
        传动参数（Z）与抬笔
        <span className="drive-group-subtitle">建议值对照 $102</span>
      </div>
      <div className="flex">
        <label title="Z 轴传动形式：丝杆按导程换算，同步带按齿数×齿距换算">
          Z 传动
          <select
            value={zType}
            onChange={(e) => set({ zDriveType: e.target.value as ZDriveType })}
          >
            <option value="screw">丝杆</option>
            <option value="belt">同步带</option>
          </select>
        </label>
        <label title="Z 轴步进电机步距角，留空沿用 XY 步距角">
          Z 步距角 (&deg;)
          <input
            type="number"
            value={dp.zStepAngle ?? ""}
            step="0.1"
            min="0.1"
            placeholder={String(dp.stepAngle)}
            onChange={(e) => set({ zStepAngle: e.target.value === "" ? undefined : Number(e.target.value) })}
          />
        </label>
      </div>
      {zType === "screw" ? (
        <div className="flex">
          <label title="丝杆导程：电机转一圈 Z 轴前进的距离 (mm)，T8 丝杆典型 8">
            丝杆导程 (mm/rev)
            <input
              type="number"
              value={dp.zLeadMm ?? ""}
              step="0.5"
              min="0.1"
              onChange={(e) => set({ zLeadMm: Number(e.target.value) })}
            />
          </label>
        </div>
      ) : (
        <div className="flex">
          <label title="Z 轴同步轮齿数">
            Z 同步轮齿数
            <input
              type="number"
              value={dp.zPulleyTeeth ?? ""}
              step="1"
              min="1"
              onChange={(e) => set({ zPulleyTeeth: Number(e.target.value) })}
            />
          </label>
          <label title="Z 轴同步带齿距 (mm)">
            Z 齿距 (mm)
            <input
              type="number"
              value={dp.zBeltPitch ?? ""}
              step="0.1"
              min="0.1"
              onChange={(e) => set({ zBeltPitch: Number(e.target.value) })}
            />
          </label>
        </div>
      )}
      <div className="flex">
        <label title="落笔时的 Z 高度 (mm)，通常为 0">
          落笔 Z (mm)
          <input
            type="number"
            value={dp.zPenDownMm ?? 0}
            step="0.1"
            onChange={(e) => set({ zPenDownMm: Number(e.target.value) })}
          />
        </label>
        <label title="抬笔时的 Z 高度 (mm)，即抬笔行程">
          抬笔 Z (mm)
          <input
            type="number"
            value={dp.zPenUpMm ?? 5}
            step="0.5"
            min="0.5"
            onChange={(e) => set({ zPenUpMm: Number(e.target.value) })}
          />
        </label>
        <label className="label-xs" title="Z 轴进给速率 (mm/min)，抬笔/落笔动作的速度">
          Z 进给 (mm/min)
          <input
            type="number"
            value={dp.zFeedMmMin ?? 600}
            step="50"
            min="10"
            onChange={(e) => set({ zFeedMmMin: Number(e.target.value) })}
          />
        </label>
      </div>
      <div className="drive-params-result">
        <div className="drive-result-row">
          <div className="drive-result-label">
            Z stepsPerMm
            <span className="drive-result-sub">（$102 建议）</span>
          </div>
          <strong>{zStepsPerMm.toFixed(4)}</strong>
        </div>
      </div>
      <div className="drive-group-title">
        固件能力
        <span className="drive-group-subtitle">自动探测 / 手动指定</span>
      </div>
      <div className="flex">
        <label title="固件种类。自动 = 连接时由版本横幅与 $I 探测（grblHAL 可能伪装 Grbl 1.1 横幅，将以 $I 为准）">
          固件种类
          <select
            value={fw.firmwareKind ?? "auto"}
            onChange={(e) => setFw({ firmwareKind: e.target.value as FirmwareKind })}
          >
            <option value="auto">自动探测</option>
            <option value="grbl-0.9">GRBL 0.9</option>
            <option value="grbl-1.1">GRBL 1.1</option>
            <option value="grblhal">grblHAL</option>
          </select>
        </label>
        <label title="串口波特率。GRBL 的波特率为固件编译期属性，连接失败时会按档位轮询重试">
          波特率
          <select
            value={fw.baudRate ?? 115200}
            onChange={(e) => setFw({ baudRate: Number(e.target.value) as 9600 | 57600 | 115200 | 230400 | 250000 })}
          >
            <option value={9600}>9600</option>
            <option value={57600}>57600</option>
            <option value={115200}>115200</option>
            <option value={230400}>230400</option>
            <option value={250000}>250000</option>
          </select>
        </label>
      </div>
      <div className="flex">
        <label title="GRBL 接收缓冲区字节数（默认 128，可调 64–256），用于流式发送的字符计数流控">
          RX 缓冲 (字节)
          <input
            type="number"
            value={fw.rxBufferSize ?? 128}
            step="1"
            min="64"
            max="256"
            onChange={(e) => setFw({ rxBufferSize: Number(e.target.value) })}
          />
        </label>
        <label title="$H 归位支持：有限位开关才可开启。自动 = 连接时探测">
          $H 归位
          <select
            value={fw.homingSupport ?? "auto"}
            onChange={(e) => setFw({ homingSupport: e.target.value as "auto" | "yes" | "no" })}
          >
            <option value="auto">自动探测</option>
            <option value="yes">支持</option>
            <option value="no">不支持</option>
          </select>
        </label>
        <label title="$10 状态回报格式。0.9 与 1.1 报文不兼容，自动 = 按固件版本推断">
          状态回报
          <select
            value={fw.statusReport ?? "auto"}
            onChange={(e) => setFw({ statusReport: e.target.value as "auto" | "v0.9" | "v1.1" })}
          >
            <option value="auto">自动探测</option>
            <option value="v0.9">0.9 格式</option>
            <option value="v1.1">1.1 格式</option>
          </select>
        </label>
      </div>
      {/* 组头 + X/Y/Z 短标签：三列标签等高单行，输入框同一水平线对齐 */}
      <div className="field-group-title">最大速度 (mm/min)</div>
      <div className="flex">
        <label title="$110 最大 X 速度 (mm/min)，供预计时长估算；可连接后在参数助手「从设备读取」回填">
          X
          <input
            type="number"
            value={fw.maxVelocityMmMin?.x ?? ""}
            step="100"
            min="0"
            onChange={(e) => setMaxVel("x", e.target.value)}
          />
        </label>
        <label title="$111 最大 Y 速度 (mm/min)">
          Y
          <input
            type="number"
            value={fw.maxVelocityMmMin?.y ?? ""}
            step="100"
            min="0"
            onChange={(e) => setMaxVel("y", e.target.value)}
          />
        </label>
        <label title="$112 最大 Z 速度 (mm/min)">
          Z
          <input
            type="number"
            value={fw.maxVelocityMmMin?.z ?? ""}
            step="100"
            min="0"
            onChange={(e) => setMaxVel("z", e.target.value)}
          />
        </label>
      </div>
      <div className="field-hint">
        「绘制进给速度」的超限校验与本组上限均以本档案配置值为依据，而非设备实时 $$——设备端手改参数后请用参数助手「从设备读取」回填。
      </div>
      <div className="field-group-title">最大加速度 (mm/s²)</div>
      <div className="flex">
        <label title="$120 最大 X 加速度 (mm/s²)">
          X
          <input
            type="number"
            value={fw.maxAccelMmS2?.x ?? ""}
            step="10"
            min="0"
            onChange={(e) => setMaxAccel("x", e.target.value)}
          />
        </label>
        <label title="$121 最大 Y 加速度 (mm/s²)">
          Y
          <input
            type="number"
            value={fw.maxAccelMmS2?.y ?? ""}
            step="10"
            min="0"
            onChange={(e) => setMaxAccel("y", e.target.value)}
          />
        </label>
        <label title="$122 最大 Z 加速度 (mm/s²)">
          Z
          <input
            type="number"
            value={fw.maxAccelMmS2?.z ?? ""}
            step="10"
            min="0"
            onChange={(e) => setMaxAccel("z", e.target.value)}
          />
        </label>
      </div>
      <div className="drive-group-title">
        坐标系
        <span className="drive-group-subtitle">机器原点位置与轴方向；预览原点标记与标尺随原点联动</span>
      </div>
      <label
        title="设备 (0,0) 位于纸张的哪个角，由此确定轴方向：原点在左 → +X 指向纸面右方，在右 → 指向左；原点在上 → +Y 指向纸面下方，在下 → 指向纸面上方。排版设置的上下左右始终是屏幕/纸面视觉方位（预览即所得），与该设置无关；绘制/补画/归位/G-code 导出会在执行层自动做坐标映射。"
      >
        机器原点位置
        <select
          value={dp.originCorner ?? "top-left"}
          onChange={(e) => set({ originCorner: e.target.value as OriginCorner })}
        >
          <option value="top-left">左上（绘图仪惯例）</option>
          <option value="bottom-left">左下（CNC 惯例）</option>
          <option value="top-right">右上</option>
          <option value="bottom-right">右下</option>
        </select>
      </label>
      <div className="drive-group-title">工作区</div>
      <div className="flex">
        <label title="安全工作区域宽度，自原点 0,0 起。用于绘制前超界校验与预览标红，防止撞轴">
          工作区宽 (mm)
          <input
            type="number"
            value={waText.x}
            step="1"
            min="1"
            onChange={(e) => setWorkingArea("x", e.target.value)}
          />
        </label>
        <label title="安全工作区域高度，自原点 0,0 起。用于绘制前超界校验与预览标红，防止撞轴">
          工作区高 (mm)
          <input
            type="number"
            value={waText.y}
            step="1"
            min="1"
            onChange={(e) => setWorkingArea("y", e.target.value)}
          />
        </label>
      </div>
      <div className="drive-group-title">
        参数助手
        <span className="drive-group-subtitle">设备 $$ 实值对照（GRBL）</span>
      </div>
      <div className="flex">
        <button type="button" onClick={() => void readDeviceParams()} disabled={probing}>
          {probing ? "读取中…" : "读取设备参数"}
        </button>
        {probe && (
          <button type="button" onClick={syncFromDevice} title="以设备 $$ 实值为准回填档案（推荐方向）">
            反向同步到档案
          </button>
        )}
        {probe && (
          <button type="button" onClick={() => void writeSuggestions()} title="将档案换算值写入设备 $100–$102（需确认）">
            写入设备 ($100–$102)
          </button>
        )}
      </div>
      {probeError && <div className="param-compare-error">{probeError}</div>}
      {probe && (
        <div className="param-compare">
          <div className="param-compare-row param-compare-head">
            <span>参数</span>
            <span>项目</span>
            <span>设备值</span>
            <span>档案建议</span>
            <span>状态</span>
          </div>
          {probe.comparisons.map((c) => (
            <div key={c.key} className="param-compare-row">
              <span>${c.key}</span>
              <span>
                {c.label} ({c.unit})
              </span>
              <span>{c.device != null ? fmtVal(c.device) : "—"}</span>
              <span>{c.suggested != null ? fmtVal(c.suggested) : "—"}</span>
              <span>{c.match == null ? "无法比较" : c.match ? "一致" : "不一致"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PenHeight({ state, driver }: { state: State; driver: BaseDriver }) {
  const { penUpHeight, penDownHeight } = state.planOptions;
  const dispatch = useContext(DispatchContext);
  const setPenUpHeight = (x: number) => dispatch({ type: "SET_PLAN_OPTION", value: { penUpHeight: x } });
  const setPenDownHeight = (x: number) => dispatch({ type: "SET_PLAN_OPTION", value: { penDownHeight: x } });
  // 笔位为 pct 口径（0 = 完全抬笔，100 = 完全落笔），GRBL 执行层直接线性映射 Z 高度
  const penUp = () => {
    driver.setPenHeight(penUpHeight, 1000);
  };
  const penDown = () => {
    driver.setPenHeight(penDownHeight, 1000);
  };
  return (
    <Fragment>
      <div className="flex">
        <label className="pen-label">
          抬起高度 (%)
          <input
            type="number"
            min="0"
            max="100"
            value={penUpHeight}
            onChange={(e) => setPenUpHeight(parseInt(e.target.value, 10))}
          />
        </label>
        <label className="pen-label">
          落下高度 (%)
          <input
            type="number"
            min="0"
            max="100"
            value={penDownHeight}
            onChange={(e) => setPenDownHeight(parseInt(e.target.value, 10))}
          />
        </label>
      </div>
      <div className="flex">
        <button type="button" onClick={penUp}>
          抬笔
        </button>
        <button type="button" onClick={penDown}>
          落笔
        </button>
      </div>
    </Fragment>
  );
}

function HardwareOptions({ state, driver }: { state: State; driver: BaseDriver | null }) {
  const dispatch = useContext(DispatchContext);
  const [savedProfiles, setSavedProfiles] = React.useState<SavedProfile[]>(() => loadSavedProfiles());
  const refreshProfiles = () => setSavedProfiles(loadSavedProfiles());
  // 2.7 参数助手：档案变化（编辑/切换预设/反向同步/初始挂载）时全量同步到
  // 服务端，保证 GRBL 执行层（Z 配置/限速/工作区）与前端档案一致。
  // 服务端模式经 ws 转发；浏览器直连模式下 changeDriveParams 由驱动直接生效。
  // send 在未连接时抛错，静默忽略（重连后 effect 不会自动重发，下一次档案
  // 编辑会补上）。
  const driveParams = state.planOptions.driveParams;
  React.useEffect(() => {
    try {
      driver?.changeDriveParams(driveParams);
    } catch (e) {
      console.warn("[Bit2AtomBot] driveParams sync failed:", e);
    }
  }, [driveParams, driver]);
  const handleHardwareChange = (value: string) => {
    if (!value) return;
    if (value === "custom") {
      dispatch({ type: "SET_PLAN_OPTION", value: { hardware: "custom" } });
    } else if (GRBL_PRESET_KEYS.includes(value)) {
      // GRBL 预设模板：以档案值为起点载入 driveParams，可修改后另存为命名档案
      const preset = GRBL_PRESET_PROFILES.find((p) => p.key === value);
      if (preset) {
        dispatch({
          type: "SET_PLAN_OPTION",
          value: { hardware: value, driveParams: { ...preset.driveParams, name: "" } },
        });
        try {
          driver?.changeHardware(value as Hardware);
        } catch (e) {
          console.warn("[Bit2AtomBot] HW change failed:", e);
        }
      }
    } else {
      const profiles = loadSavedProfiles();
      const profile = profiles.find((p) => p.name === value);
      if (profile) {
        dispatch({ type: "SET_PLAN_OPTION", value: { hardware: value, driveParams: { ...profile.driveParams } } });
      }
    }
  };
  const currentHardware = state.planOptions.hardware;
  const isCustomMode = !GRBL_PRESET_KEYS.includes(currentHardware);
  const handleSave = () => {
    const dp = state.planOptions.driveParams;
    const name = dp.name.trim();
    if (!name) {
      alert("请输入设备名称");
      return;
    }
    const profiles = loadSavedProfiles();
    const idx = profiles.findIndex((p) => p.name === name);
    if (idx >= 0) {
      profiles[idx].driveParams = dp;
    } else {
      profiles.push({ name, driveParams: dp });
    }
    saveSavedProfiles(profiles);
    dispatch({ type: "SET_PLAN_OPTION", value: { hardware: name } });
    refreshProfiles();
  };
  const handleDelete = () => {
    const name = state.planOptions.driveParams.name.trim();
    if (!name) return;
    const profiles = loadSavedProfiles().filter((p) => p.name !== name);
    saveSavedProfiles(profiles);
    dispatch({ type: "SET_PLAN_OPTION", value: { hardware: "v3" } });
    refreshProfiles();
  };
  return (
    <div>
      <label title="硬件预设（作为自定义档案的起点模板）">
        硬件列表：
        <select value={currentHardware} onChange={(e) => handleHardwareChange(e.target.value)} disabled={false}>
          <optgroup label="── GRBL 预设模板 ──">
            {GRBL_PRESET_PROFILES.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </optgroup>
          {savedProfiles.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
          <option value="custom">── 新建自定义 ──</option>
        </select>
      </label>
      {isCustomMode && (
        <div>
          <DriveParams state={state} />
          <div className="flex" style={{ marginTop: "4px" }}>
            <button type="button" onClick={handleSave} disabled={!state.planOptions.driveParams.name.trim()}>
              保存配置
            </button>
            {currentHardware !== "custom" && (
              <button type="button" onClick={handleDelete}>
                删除配置
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
function VisualizationOptions({ state }: { state: State }) {
  const dispatch = useContext(DispatchContext);

  return (
    <>
      <label title="预览中线条的宽度，不影响实际绘图。">
        可视化笔触宽度 (mm)
        <input
          type="number"
          value={state.visualizationOptions.penStrokeWidth}
          min="0"
          max="10"
          step="0.1"
          onChange={(e) =>
            dispatch({ type: "SET_VISUALIZATION_OPTION", value: { penStrokeWidth: Number(e.target.value) } })
          }
        />
      </label>
      <label className="flex-checkbox" title="根据绘制顺序为路径着色。黄色最先，粉色最后。">
        <input
          type="checkbox"
          checked={state.visualizationOptions.colorPathsByStrokeOrder}
          onChange={(e) =>
            dispatch({ type: "SET_VISUALIZATION_OPTION", value: { colorPathsByStrokeOrder: !!e.target.checked } })
          }
        />
        按顺序着色
      </label>
    </>
  );
}

function OriginOptions({ state }: { state: State }) {
  const dispatch = useContext(DispatchContext);
  return (
    <div className="flex">
      <label title="绘图时笔的起始和结束位置 (x)，相对机器原点角向纸面内度量（0 = 原点角本身），跟随「机器原点位置」联动">
        起点 x (mm):
        <input
          type="number"
          min="0"
          max={state.planOptions.paperSize.size.x}
          step="10"
          value={state.planOptions.penHome.x}
          onChange={(e) =>
            dispatch({
              type: "SET_PLAN_OPTION",
              value: { penHome: { x: Number(e.target.value), y: state.planOptions.penHome.y } },
            })
          }
        />
      </label>
      <label title="绘图时笔的起始和结束位置 (y)，相对机器原点角向纸面内度量（0 = 原点角本身），跟随「机器原点位置」联动">
        起点 y (mm):
        <input
          type="number"
          min="0"
          max={state.planOptions.paperSize.size.y}
          step="10"
          value={state.planOptions.penHome.y}
          onChange={(e) =>
            dispatch({
              type: "SET_PLAN_OPTION",
              value: { penHome: { x: state.planOptions.penHome.x, y: Number(e.target.value) } },
            })
          }
        />
      </label>
    </div>
  );
}

function SwapPaperSizesButton({ onClick }: { onClick: () => void }) {
  const handleKeyDown = (event: React.KeyboardEvent<SVGSVGElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault(); // Prevent scrolling with spacebar
      onClick();
    }
  };
  return (
    <svg
      className="paper-sizes__swap"
      xmlns="http://www.w3.org/2000/svg"
      width="14.05"
      height="11.46"
      viewBox="0 0 14.05 11.46"
      onKeyDown={handleKeyDown}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: no need for a div wrapper
      tabIndex={0}
      onClick={onClick}
    >
      <title>交换宽高</title>
      <g>
        <polygon points="14.05 3.04 8.79 0 8.79 1.78 1.38 1.78 1.38 4.29 8.79 4.29 8.79 6.08 14.05 3.04" />
        <polygon points="0 8.43 5.26 11.46 5.26 9.68 12.67 9.68 12.67 7.17 5.26 7.17 5.26 5.39 0 8.43" />
      </g>
    </svg>
  );
}

function PaperConfig({ state }: { state: State }) {
  const dispatch = useContext(DispatchContext);
  const landscape = state.planOptions.paperSize.isLandscape;
  function setPaperSize(e: ChangeEvent) {
    const name = (e.target as HTMLInputElement).value;
    if (name !== "Custom") {
      const ps = PaperSize.standard[name][landscape ? "landscape" : "portrait"];
      dispatch({ type: "SET_PLAN_OPTION", value: { paperSize: ps } });
    }
  }
  function setCustomPaperSize(x: number, y: number) {
    dispatch({ type: "SET_PLAN_OPTION", value: { paperSize: new PaperSize({ x, y }) } });
  }
  const { paperSize } = state.planOptions;
  const paperSizeName =
    Object.keys(PaperSize.standard).find((psName) => {
      const ps = PaperSize.standard[psName].size;
      return (
        (ps.x === paperSize.size.x && ps.y === paperSize.size.y) ||
        (ps.y === paperSize.size.x && ps.x === paperSize.size.y)
      );
    }) || "Custom";
  return (
    <div>
      <select value={paperSizeName} onChange={setPaperSize}>
        {Object.keys(PaperSize.standard).map((name) => (
          <option key={name}>{name}</option>
        ))}
        {/* 值与 paperSizeName 兜底返回的 "Custom" 一致，确保自定义纸张时正确回显 */}
        <option value="Custom">自定义</option>
      </select>
      <div className="paper-sizes">
        <label className="paper-label">
          宽度 (mm)
          <input
            type="number"
            value={paperSize.size.x}
            onChange={(e) => setCustomPaperSize(Number(e.target.value), paperSize.size.y)}
          />
        </label>
        <SwapPaperSizesButton
          onClick={() => {
            dispatch({
              type: "SET_PLAN_OPTION",
              value: { paperSize: paperSize.isLandscape ? paperSize.portrait : paperSize.landscape },
            });
          }}
        />
        <label className="paper-label">
          高度 (mm)
          <input
            type="number"
            value={paperSize.size.y}
            onChange={(e) => setCustomPaperSize(paperSize.size.x, Number(e.target.value))}
          />
        </label>
      </div>
      <div>
        <label>
          旋转角度 (度)
          <div className="horizontal-labels">
            <img src={rotateDrawingIcon} alt="rotate drawing (degrees)" />
            <input
              type="number"
              min="-90"
              step="90"
              max="360"
              placeholder="0"
              value={state.planOptions.rotateDrawing}
              onInput={(e) => {
                const value = (e.target as HTMLInputElement).value;
                if (Number(value) < 0) {
                  (e.target as HTMLInputElement).value = "270";
                }
                if (Number(value) > 270) {
                  (e.target as HTMLInputElement).value = "0";
                }
              }}
              onChange={(e) =>
                dispatch({
                  type: "SET_PLAN_OPTION",
                  // 用户主动改旋转角 → 清除导入文件的「最终排版」标记，
                  // 旋转对本文件恢复生效（否则带标记文件始终所见即所得）
                  value: { rotateDrawing: Number(e.target.value), bakedRotationDeg: undefined },
                })
              }
            />
          </div>
        </label>
      </div>
      <label>
        边距 (mm)
        <input
          type="number"
          value={state.planOptions.marginMm}
          min="0"
          max={Math.min(paperSize.size.x / 2, paperSize.size.y / 2)}
          onChange={(e) => dispatch({ type: "SET_PLAN_OPTION", value: { marginMm: Number(e.target.value) } })}
        />
      </label>
    </div>
  );
}

function MotorControl({ driver }: { driver: BaseDriver }) {
  return (
    <div>
      <button type="button" onClick={() => driver.limp()}>
        关闭电机
      </button>
    </div>
  );
}

function PlanStatistics({ plan }: { plan: Plan | null }) {
  const totalDist = plan != null ? plan.totalDistance() : 0;
  const distStr = totalDist >= 1000 ? `${(totalDist / 1000).toFixed(1)} m` : `${Math.round(totalDist)} mm`;
  return (
    <div className="plan-stats">
      <div className="duration">
        <div>总路径</div>
        <div>
          <strong>{plan ? distStr : "-"}</strong>
        </div>
      </div>
      <div className="duration">
        <div>预计时长</div>
        <div>
          <strong>{plan?.duration ? formatDuration(plan.duration()) : "-"}</strong>
        </div>
      </div>
    </div>
  );
}

function TimeLeft({
  plan,
  progress,
  currentMotionStartedTime,
  paused,
}: {
  plan: Plan | null;
  progress: number | null;
  currentMotionStartedTime: Date;
  paused: boolean;
}) {
  const [_, setTime] = useState(new Date());

  // Interval that ticks every second to rerender
  // and recalculate time remaining for long motions
  useEffect(() => {
    const interval = setInterval(() => {
      setTime(new Date());
    }, 1000);

    return () => {
      clearInterval(interval);
    };
  }, []);

  if (!plan?.duration || progress === null || paused) {
    return null;
  }

  const currentMotionTimeSpent = (Date.now() - currentMotionStartedTime.getTime()) / 1000;
  const duration = plan.duration(progress);
  return (
    <div className="duration">
      <div className="time-remaining-label">剩余时间</div>
      <div>
        <strong>{formatDuration(duration - currentMotionTimeSpent)}</strong>
      </div>
    </div>
  );
}

function PlanPreview({
  state,
  previewSize,
  plan,
}: {
  state: State;
  previewSize: { width: number; height: number };
  plan: Plan | null;
}) {
  const ps = state.planOptions.paperSize;
  // Plan 坐标为毫米口径，预览直接按 mm 渲染（viewBox 单位 = mm）。
  const strokeWidth = state.visualizationOptions.penStrokeWidth;
  const colorPathsByStrokeOrder = state.visualizationOptions.colorPathsByStrokeOrder;
  // 设备工作范围（来自 GRBL 档案 workingAreaMm，未配置时不标示）：纸张超出
  // 部分以红色标示，服务端会拒绝坐标超界的绘制任务
  const machineAreaMm = state.planOptions.driveParams.workingAreaMm ?? null;
  const paperOutOfBounds =
    machineAreaMm != null &&
    (ps.size.x > machineAreaMm.x + 0.5 || ps.size.y > machineAreaMm.y + 0.5);
  // 机器原点角（与执行层 applyMachineFrame 同源）：预览图形保持屏幕方位
  // （物理纸面上图形方向不变），但标尺改为机器坐标读数，并在原点角绘制
  // (0,0) 标记与 +X/+Y 方向箭头，保证「预览 ↔ 真机绘制」认知一致。
  const originCorner = state.planOptions.driveParams.originCorner ?? "top-left";
  const originRight = originCorner.endsWith("right");
  const originBottom = originCorner.startsWith("bottom");
  const memoizedPlanPreview = useMemo(() => {
    if (plan) {
      const palette = colorPathsByStrokeOrder
        ? interpolator(colormap({ colormap: "spring" }))
        : () => "var(--canvas-stroke)";
      // Build lines with their corresponding motion index for progress tracking
      const linesWithIdx: { points: { x: number; y: number }[]; motionIdx: number }[] = [];
      for (let i = 0; i < plan.motions.length; i++) {
        const m = plan.motions[i];
        if (m instanceof XYMotion) {
          const points = m.blocks.map((b) => b.p1).concat([m.p2]);
          if (points.length > 0) {
            linesWithIdx.push({ points, motionIdx: i });
          }
        }
      }
      if (linesWithIdx.length === 0) return null;
      const lines = linesWithIdx.map((l) => l.points);
      return { lines, linesWithIdx, palette };
    }
    return null;
  }, [plan, colorPathsByStrokeOrder]);

  // Render plan preview, coloring completed motions differently during plotting
  const progress = state.progress;
  const drawnWatermark = state.drawnWatermark;
  const rewindRange = state.rewindRange;
  const redrawnRanges = state.redrawnRanges;
  const redrawMode = state.redrawMode;
  const paused = state.paused;
  const renderedPlanPreview = useMemo(() => {
    if (!memoizedPlanPreview) return null;
    const { lines, linesWithIdx, palette } = memoizedPlanPreview;
    const isPlotting = progress != null;
    const inRanges = (idx: number, ranges: { from: number; to: number }[]) =>
      ranges.some((r) => idx >= r.from && idx < r.to);
    return (
      <g>
        <title>笔起始点</title>
        <circle
          cx={lines[0][0].x}
          cy={lines[0][0].y}
          r={1.5}
          fill="#2196F3"
          stroke="#1565C0"
          strokeWidth={0.3}
        />
        {lines.map((line, i) => {
          const motionIdx = linesWithIdx[i].motionIdx;
          // During plotting, a motion is "completed" if its index < current progress.
          // After the plot (or redraw) finishes, progress is cleared but the drawn
          // watermark retains the completed coloring for everything already drawn.
          const isCompleted = (progress != null && motionIdx < progress) || motionIdx < (drawnWatermark ?? 0);
          const isCurrent = progress != null && motionIdx === progress;
          // 暂停回溯重绘着色：
          //   红色 — 已重绘完成的落笔线（任务结束后保留，便于检查重复绘制区域）
          //   橙色 — 位于重绘范围内、尚未重绘到的落笔线（暂停选择时为整个回溯区间）
          const inRedrawScope = redrawnRanges.length > 0 && inRanges(motionIdx, redrawnRanges);
          const isRedrawn = inRedrawScope && (!isPlotting || motionIdx < progress);
          const isRewindPending =
            !isRedrawn &&
            ((rewindRange != null &&
              (paused || redrawMode) &&
              motionIdx >= rewindRange.from &&
              motionIdx < rewindRange.to) ||
              (inRedrawScope && isPlotting && motionIdx >= progress));
          let stroke: string;
          if (i % 2 === 0) {
            // Travel moves (pen up) — dimmer
            stroke = isCompleted
              ? "var(--canvas-stroke-done)"
              : isCurrent
                ? "var(--canvas-stroke-current)"
                : "var(--canvas-stroke-faded)";
          } else if (isRedrawn) {
            // 已重绘完成的落笔线
            stroke = "var(--canvas-stroke-rewind)";
          } else if (isRewindPending) {
            // 待重绘的落笔线
            stroke = "var(--canvas-stroke-rewind-pending)";
          } else if (isCompleted) {
            // Completed draw strokes — accent color
            stroke = "var(--canvas-stroke-done)";
          } else if (isCurrent) {
            // Current stroke being drawn
            stroke = "var(--canvas-stroke-current)";
          } else {
            // Pending strokes
            stroke = palette(1 - i / lines.length);
          }
          return (
            <path
              // biome-ignore lint/suspicious/noArrayIndexKey: the paths are not changed elsewhere
              key={i}
              d={line.reduce((m, { x, y }, j) => `${m}${j === 0 ? "M" : "L"}${x} ${y}`, "")}
              style={{ stroke, strokeWidth: i % 2 === 0 ? 0.5 : strokeWidth }}
            />
          );
        })}
      </g>
    );
  }, [
    memoizedPlanPreview,
    progress,
    drawnWatermark,
    paused,
    redrawMode,
    rewindRange,
    redrawnRanges,
    strokeWidth,
  ]);

  // w/h of svg.
  // first try scaling so that h = area.h. if w < area.w, then ok.
  // otherwise, scale so that w = area.w.
  const { width, height } =
    (ps.size.x / ps.size.y) * previewSize.height <= previewSize.width
      ? { width: (ps.size.x / ps.size.y) * previewSize.height, height: previewSize.height }
      : { height: (ps.size.y / ps.size.x) * previewSize.width, width: previewSize.width };

  // —— 预览缩放/平移（纯显示层，不影响规划与绘制坐标） ——
  // zoom=1 即"充满绘制区域"，是最小缩放；仅支持放大。平移钳制在纸面矩形内，
  // zoom=1 时不可平移（锁定到图形/纸面边界）。
  const [view, setView] = useState({ zoom: 1, panX: 0, panY: 0 });
  const canvasRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ clientX: number; clientY: number; panX: number; panY: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const viewW = ps.size.x / view.zoom;
  const viewH = ps.size.y / view.zoom;
  const clampPan = (pan: number, size: number, zoom: number): number => Math.min(Math.max(pan, 0), size - size / zoom);
  // 以视口内比例坐标 (fracX, fracY) 为锚点缩放，保持锚点下的图形位置不动
  const zoomAt = (factor: number, fracX: number, fracY: number): void => {
    setView((v) => {
      const zoom = Math.min(MAX_ZOOM, Math.max(1, v.zoom * factor));
      if (zoom === v.zoom) return v;
      const panX = clampPan(v.panX + fracX * ps.size.x * (1 / v.zoom - 1 / zoom), ps.size.x, zoom);
      const panY = clampPan(v.panY + fracY * ps.size.y * (1 / v.zoom - 1 / zoom), ps.size.y, zoom);
      return { zoom, panX, panY };
    });
  };
  // 纸尺寸变化时复位视图：渲染期间检测到 paperSize 引用变化即重置（React 官方派生状态模式）
  const [prevPaper, setPrevPaper] = useState(ps);
  if (prevPaper !== ps) {
    setPrevPaper(ps);
    setView({ zoom: 1, panX: 0, panY: 0 });
  }
  // 滚轮缩放：仅作用于预览画布；需非被动监听以阻止页面滚动。
  // 通过 ref 引用最新的 zoomAt，监听器只注册一次。
  const zoomAtRef = useRef(zoomAt);
  zoomAtRef.current = zoomAt;
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const fracX = (e.clientX - rect.left) / rect.width;
      const fracY = (e.clientY - rect.top) / rect.height;
      zoomAtRef.current(Math.exp(-e.deltaY * 0.002), fracX, fracY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const [microprogress, setMicroprogress] = useState(0);
  useLayoutEffect(() => {
    let rafHandle: number;
    let cancelled = false;
    if (state.progress != null) {
      const startingTime = Date.now();
      const updateProgress = () => {
        if (cancelled) {
          return;
        }
        setMicroprogress(Date.now() - startingTime);
        rafHandle = requestAnimationFrame(updateProgress);
      };
      updateProgress();
    }
    return () => {
      cancelled = true;
      if (rafHandle != null) {
        cancelAnimationFrame(rafHandle);
      }
      setMicroprogress(0);
    };
  }, [state.progress]);

  let progressIndicator = <></>;
  if (state.progress != null && plan != null) {
    const motion = plan.motion(state.progress);
    const pos =
      motion instanceof XYMotion
        ? motion.instant(Math.min(microprogress / 1000, motion.duration())).p
        : (plan.motion(state.progress - 1) as XYMotion).p2;
    const posXMm = pos.x;
    const posYMm = pos.y;
    progressIndicator = (
      <svg
        width={width * 2}
        height={height * 2}
        viewBox={`${-width} ${-height} ${width * 2} ${height * 2}`}
        // 放大/平移后，十字光标按当前视图把笔位置映射到屏幕
        // （zoom=1 时等价于 (posXMm / ps.size.x) * 50%）
        style={{
          transform:
            "translateZ(0.001px) " +
            `translate(${-width}px, ${-height}px) ` +
            `translate(${((posXMm - view.panX) / viewW) * 50}%,${((posYMm - view.panY) / viewH) * 50}%)`,
        }}
      >
        <title>Progress percentage bar</title>
        <g>
          <path
            d={`M-${width} 0l${width * 2} 0M0 -${height}l0 ${height * 2}`}
            style={{ stroke: "var(--canvas-progress)", strokeWidth: 1, opacity: 0.6 }}
          />
          <path d="M-10 0l20 0M0 -10l0 20" style={{ stroke: "var(--canvas-progress)", strokeWidth: 2 }} />
        </g>
      </svg>
    );
  }
  const margins = (
    <g>
      <rect
        x={state.planOptions.marginMm}
        y={state.planOptions.marginMm}
        width={ps.size.x - state.planOptions.marginMm * 2}
        height={ps.size.y - state.planOptions.marginMm * 2}
        fill="none"
        stroke="var(--canvas-margin)"
        strokeWidth="0.1"
        strokeDasharray="1,1"
      />
    </g>
  );
  const marginMm = state.planOptions.marginMm;
  const drawW = ps.size.x - marginMm * 2;
  const drawH = ps.size.y - marginMm * 2;
  const gridDefs = (
    <defs>
      <pattern id="grid5mm" width={5} height={5} patternUnits="userSpaceOnUse">
        <path d="M 5 0 L 0 0 0 5" fill="none" stroke="var(--canvas-grid5)" strokeWidth="0.05" />
      </pattern>
      <pattern id="grid10mm" width={10} height={10} patternUnits="userSpaceOnUse">
        <path d="M 10 0 L 0 0 0 10" fill="none" stroke="var(--canvas-grid10)" strokeWidth="0.13" />
      </pattern>
    </defs>
  );
  const gridRects = (
    <g>
      <rect x={marginMm} y={marginMm} width={drawW} height={drawH} fill="url(#grid10mm)" />
      <rect x={marginMm} y={marginMm} width={drawW} height={drawH} fill="url(#grid5mm)" />
    </g>
  );
  const rulerMarks = useMemo(() => {
    const ticks = [];
    // 标尺读数口径 = 机器坐标（自原点角起算）：原点在左 → X 值向右递增，
    // 在右 → 向左递增；原点在上 → Y 值向下递增，在下 → 向上递增。
    // 刻度位置仍锚定边距框角，读数为该位置的机器坐标（原点 0,0 在纸角，
    // 由 originMarker 标示）。
    const xLabel = (mm: number): string => {
      const v = originRight ? ps.size.x - marginMm - mm : marginMm + mm;
      return String(Math.round(v * 10) / 10);
    };
    const yLabel = (mm: number): string => {
      const v = originBottom ? ps.size.y - marginMm - mm : marginMm + mm;
      return String(Math.round(v * 10) / 10);
    };
    const maxDim = Math.max(drawW, drawH);
    for (let mm = 0; mm <= maxDim; mm += 5) {
      const is10 = mm % 10 === 0;
      const is50 = mm % 50 === 0;
      const tickLen = is50 ? 9 : is10 ? 6 : 3;
      if (mm <= drawW) {
        ticks.push(
          <line
            key={`rt-${mm}`}
            x1={marginMm + mm}
            y1={marginMm}
            x2={marginMm + mm}
            y2={marginMm - tickLen}
            stroke="var(--canvas-ruler)"
            strokeWidth={is10 ? 0.15 : 0.08}
          />,
        );
        if (is10)
          ticks.push(
            <text
              key={`rtl-${mm}`}
              x={marginMm + mm}
              y={marginMm - tickLen - 0.8}
              fontSize="2.2"
              textAnchor="middle"
              fill="var(--canvas-ruler-text)"
            >{xLabel(mm)}</text>,
          );
      }
      if (mm <= drawW) {
        ticks.push(
          <line
            key={`rb-${mm}`}
            x1={marginMm + mm}
            y1={marginMm + drawH}
            x2={marginMm + mm}
            y2={marginMm + drawH + tickLen}
            stroke="var(--canvas-ruler)"
            strokeWidth={is10 ? 0.15 : 0.08}
          />,
        );
        if (is10)
          ticks.push(
            <text
              key={`rbl-${mm}`}
              x={marginMm + mm}
              y={marginMm + drawH + tickLen + 1.8}
              fontSize="2.2"
              textAnchor="middle"
              fill="var(--canvas-ruler-text)"
            >{xLabel(mm)}</text>,
          );
      }
      if (mm <= drawH) {
        ticks.push(
          <line
            key={`rl-${mm}`}
            x1={marginMm}
            y1={marginMm + mm}
            x2={marginMm - tickLen}
            y2={marginMm + mm}
            stroke="var(--canvas-ruler)"
            strokeWidth={is10 ? 0.15 : 0.08}
          />,
        );
        if (is10)
          ticks.push(
            <text
              key={`rll-${mm}`}
              x={marginMm - tickLen - 0.8}
              y={marginMm + mm + 0.7}
              fontSize="2.2"
              textAnchor="end"
              fill="var(--canvas-ruler-text)"
            >{yLabel(mm)}</text>,
          );
      }
      if (mm <= drawH) {
        ticks.push(
          <line
            key={`rr-${mm}`}
            x1={marginMm + drawW}
            y1={marginMm + mm}
            x2={marginMm + drawW + tickLen}
            y2={marginMm + mm}
            stroke="var(--canvas-ruler)"
            strokeWidth={is10 ? 0.15 : 0.08}
          />,
        );
        if (is10)
          ticks.push(
            <text
              key={`rrl-${mm}`}
              x={marginMm + drawW + tickLen + 0.8}
              y={marginMm + mm + 0.7}
              fontSize="2.2"
              textAnchor="start"
              fill="var(--canvas-ruler-text)"
            >{yLabel(mm)}</text>,
          );
      }
    }
    return ticks;
  }, [marginMm, drawW, drawH, originRight, originBottom, ps.size.x, ps.size.y]);
  // 机器原点标记：原点角处绘制 (0,0) 十字圈与 +X/+Y 方向箭头（指向纸面内），
  // 随「机器原点位置」下拉实时联动，与执行层 applyMachineFrame 的轴方向一致。
  const originAx = originRight ? -1 : 1;
  const originAy = originBottom ? -1 : 1;
  const originX = originRight ? ps.size.x : 0;
  const originY = originBottom ? ps.size.y : 0;
  const axisLen = 14;
  const originMarker = (
    <g>
      <title>机器原点 (0,0)</title>
      {/* +X 轴：原点在左 → 指向纸面右方；在右 → 指向左 */}
      <line
        x1={originX}
        y1={originY}
        x2={originX + originAx * axisLen}
        y2={originY}
        stroke="var(--canvas-origin)"
        strokeWidth={0.5}
      />
      <path
        d={`M${originX + originAx * (axisLen + 2)} ${originY}l${-originAx * 2.5} -1.2l0 2.4z`}
        fill="var(--canvas-origin)"
      />
      <text
        x={originX + originAx * (axisLen + 3.5)}
        y={originY + originAy * 3 + 1}
        fontSize="2.6"
        fontWeight="700"
        textAnchor={originAx === 1 ? "start" : "end"}
        fill="var(--canvas-origin)"
      >+X</text>
      {/* +Y 轴：原点在上 → 指向纸面下方；在下 → 指向上方 */}
      <line
        x1={originX}
        y1={originY}
        x2={originX}
        y2={originY + originAy * axisLen}
        stroke="var(--canvas-origin)"
        strokeWidth={0.5}
      />
      <path
        d={`M${originX} ${originY + originAy * (axisLen + 2)}l-1.2 ${-originAy * 2.5}l2.4 0z`}
        fill="var(--canvas-origin)"
      />
      <text
        x={originX + originAx * 2}
        y={originY + originAy * (axisLen + 3)}
        fontSize="2.6"
        fontWeight="700"
        textAnchor={originAx === 1 ? "start" : "end"}
        dominantBaseline="middle"
        fill="var(--canvas-origin)"
      >+Y</text>
      {/* 原点圈 + 坐标文字 */}
      <circle cx={originX} cy={originY} r={1.4} fill="none" stroke="var(--canvas-origin)" strokeWidth={0.45} />
      <text
        x={originX + originAx * 3.5}
        y={originY + originAy * 7.5}
        fontSize="2.6"
        textAnchor={originAx === 1 ? "start" : "end"}
        dominantBaseline={originAy === 1 ? "hanging" : "auto"}
        fill="var(--canvas-origin)"
      >0,0</text>
    </g>
  );
  return (
    <div className="preview">
      <svg
        ref={canvasRef}
        className={`preview-canvas${view.zoom > 1 ? " zoomed" : ""}${dragging ? " dragging" : ""}`}
        width={width}
        height={height}
        viewBox={`${view.panX} ${view.panY} ${viewW} ${viewH}`}
        onPointerDown={(e) => {
          if (e.button !== 0 || view.zoom <= 1) return;
          // 阻止浏览器在拖拽平移时对标尺文字/图形启动文本选择
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          dragRef.current = { clientX: e.clientX, clientY: e.clientY, panX: view.panX, panY: view.panY };
          setDragging(true);
        }}
        onPointerMove={(e) => {
          const d = dragRef.current;
          if (!d) return;
          const rect = e.currentTarget.getBoundingClientRect();
          setView((v) => ({
            ...v,
            panX: clampPan(d.panX - ((e.clientX - d.clientX) / rect.width) * (ps.size.x / v.zoom), ps.size.x, v.zoom),
            panY: clampPan(d.panY - ((e.clientY - d.clientY) / rect.height) * (ps.size.y / v.zoom), ps.size.y, v.zoom),
          }));
        }}
        onPointerUp={() => {
          dragRef.current = null;
          setDragging(false);
        }}
        onPointerLeave={() => {
          // 指针离开时兜底结束拖拽（正常路径经 setPointerCapture 不会触发）
          if (dragRef.current) {
            dragRef.current = null;
            setDragging(false);
          }
        }}
      >
        <title>Plot preview</title>
        {gridDefs}
        {gridRects}
        {rulerMarks}
        {originMarker}
        {renderedPlanPreview}
        {margins}
      </svg>
      <div className="preview-toolbar">
        <button type="button" title="放大" onClick={() => zoomAt(1.5, 0.5, 0.5)}>
          ＋
        </button>
        <button type="button" title="缩小（最小为充满绘制区域）" onClick={() => zoomAt(1 / 1.5, 0.5, 0.5)}>
          －
        </button>
        <button type="button" title="复位视图（充满绘制区域）" onClick={() => setView({ zoom: 1, panX: 0, panY: 0 })}>
          1:1
        </button>
        <span title="当前缩放比例，滚轮或拖拽可检查图形细节">{Math.round(view.zoom * 100)}%</span>
      </div>
      {paperOutOfBounds && (
        <div className="preview-warning">
          {`图形超出设备工作范围（${machineAreaMm?.x ?? "?"}×${machineAreaMm?.y ?? "?"} mm），红色区域无法绘制，开始绘制将被拒绝`}
        </div>
      )}
      {progressIndicator}
    </div>
  );
}

function PlanLoader({ isLoadingFile, isPlanning }: { isLoadingFile: boolean; isPlanning: boolean }) {
  if (isLoadingFile || isPlanning) {
    return <div className="preview-loader">{isLoadingFile ? "加载文件中..." : "重新规划中..."}</div>;
  }

  return null;
}

function LayerSelector({ state }: { state: State }) {
  const dispatch = useContext(DispatchContext);

  const { layerMode } = state.planOptions;
  const layers = layerMode === "group" ? state.groupLayers : state.strokeLayers;
  if (layers.length <= 1) {
    return null;
  }

  const selectedLayers =
    layerMode === "group" ? state.planOptions.selectedGroupLayers : state.planOptions.selectedStrokeLayers;
  const layersChanged = (e: ChangeEvent<HTMLSelectElement>) => {
    const selectedLayers = new Set([...e.target.selectedOptions].map((o) => o.value));
    if (layerMode === "group") {
      dispatch({ type: "SET_PLAN_OPTION", value: { selectedGroupLayers: selectedLayers } });
    } else {
      dispatch({ type: "SET_PLAN_OPTION", value: { selectedStrokeLayers: selectedLayers } });
    }
  };
  return (
    <div>
      <label>
        图层
        <select
          className="layer-select"
          multiple={true}
          value={[...selectedLayers]}
          onChange={layersChanged}
          size={3}
          disabled={state.progress != null}
        >
          {layers.map((layer) => (
            <option key={layer}>{layer}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

// 机器坐标系映射：屏幕坐标（预览/排版口径，原点在纸面左上）→ 机器坐标。
// 原点角来自硬件档案（缺省左上 = 恒等映射）。绘制/补画/归位/G-code 导出
// 统一在发送前应用；预览、统计、补画区间索引仍全部工作在屏幕空间。
// 模块级共享：PlotButtons（绘制/补画/归位）与 Root（G-code 导出）都需要；
// 此前定义为 PlotButtons 私有函数，Root 的导出处理器引用不到，esbuild 构建
// 无类型检查放行，运行时抛 ReferenceError——表现为导出 G-code「无反馈」。
function machineFramePlan(
  p: Plan,
  originCorner: OriginCorner | undefined,
  paperSizeMm: { x: number; y: number },
): Plan {
  return applyMachineFrame(p, originCorner ?? "top-left", paperSizeMm);
}

function PlotButtons({
  state,
  plan,
  isPlanning,
  driver,
}: {
  state: State;
  plan: Plan | null;
  isPlanning: boolean;
  driver: BaseDriver;
}) {
  const dispatch = useContext(DispatchContext);
  function cancel() {
    dispatch({ type: "SET_REWIND_RANGE", value: null });
    dispatch({ type: "SET_REDRAWN_RANGES", value: [] });
    dispatch({ type: "SET_REDRAW_MODE", value: false });
    driver.cancel();
  }
  function pause() {
    driver.pause();
  }
  function resume() {
    driver.resume();
    dispatch({ type: "SET_REWIND_RANGE", value: null });
    dispatch({ type: "SET_REDRAW_MODE", value: false });
  }
  // 记录上次实际绘制时的规划签名，用于补画前校验区间编号仍然对应。
  const lastPlotSig = React.useRef<string | null>(null);
  const planSignature = (p: Plan) => (p ? `${serialize(state.planOptions)}#${p.motions.length}` : null);
  function plot(plan: Plan) {
    lastPlotSig.current = planSignature(plan);
    // 捕获本次绘制的图层信息（模式 + 选中图层），随请求头传给服务端任务
    // 日志。补画沿用上次绘制时捕获的信息，与 lastPlan 的实际内容对应。
    driver.plotLayerInfo = {
      mode: state.planOptions.layerMode,
      layers:
        state.planOptions.layerMode === "group"
          ? [...state.planOptions.selectedGroupLayers].sort()
          : [...state.planOptions.selectedStrokeLayers].sort(),
    };
    // custom 硬件的安全工作区域随请求头传给服务端做超界校验（服务端亦从
    // ws changeDriveParams 同步的档案中读取，双保险）
    driver.plotWorkingAreaMm = state.planOptions.driveParams.workingAreaMm ?? null;
    dispatch({ type: "SET_REWIND_RANGE", value: null });
    dispatch({ type: "SET_REDRAWN_RANGES", value: [] });
    dispatch({ type: "SET_REDRAW_MODE", value: false });
    // 新一次绘制从头开始，清除上一轮的已绘制水位线
    dispatch({ type: "SET_DRAWN_WATERMARK", value: null });
    driver.plot(machineFramePlan(plan, state.planOptions.driveParams.originCorner, state.planOptions.paperSize.size));
  }

  // --- 暂停回溯重绘 ---
  // plan() 为每条路径生成固定 4 个动作的组：[抬笔移动, 落笔, 绘制, 抬笔]。
  // groupStarts[i] 是第 i 条路径的起始动作索引，即合法的回溯重启点。
  const groupStarts = useMemo(() => (plan ? pathGroupStarts(plan) : []), [plan]);
  const [rewindGroup, setRewindGroup] = useState(0);
  // 暂停时所在路径组的序号（progress 落在哪个组内）
  const pauseGroupIdx = useMemo(() => {
    if (state.progress == null) return -1;
    let g = -1;
    for (let i = 0; i < groupStarts.length; i++) {
      if (groupStarts[i] <= state.progress) g = i;
      else break;
    }
    return g;
  }, [groupStarts, state.progress]);

  // 重绘范围终点：暂停点所在路径组的结束位置。
  // 回溯区间 = [回溯组起点, 暂停点所在组结束)，即从回溯点到暂停点的全部内容。
  const pauseGroupEnd = React.useMemo(() => {
    if (pauseGroupIdx < 0) return 0;
    return pauseGroupIdx + 1 < groupStarts.length
      ? groupStarts[pauseGroupIdx + 1]
      : (plan?.motions.length ?? groupStarts[pauseGroupIdx]);
  }, [pauseGroupIdx, groupStarts, plan]);

  const rewindRangeFor = React.useCallback(
    (g: number) => ({ from: groupStarts[g], to: pauseGroupEnd }),
    [groupStarts, pauseGroupEnd],
  );

  // 进入暂停时，初始化回溯组为当前组，并在预览中高亮重绘区间
  React.useEffect(() => {
    if (state.paused && !state.isSimulating && pauseGroupIdx >= 0) {
      setRewindGroup(pauseGroupIdx);
      dispatch({ type: "SET_REWIND_RANGE", value: rewindRangeFor(pauseGroupIdx) });
    }
  }, [state.paused, state.isSimulating, pauseGroupIdx, rewindRangeFor, dispatch]);

  // 绘制结束/取消后清除回溯高亮（补画模式下保留：高亮跟随双滑块选择）
  React.useEffect(() => {
    if (state.progress == null && !state.redrawMode) {
      dispatch({ type: "SET_REWIND_RANGE", value: null });
    }
  }, [state.progress, state.redrawMode, dispatch]);

  const onRewindSliderChange = (e: ChangeEvent<HTMLInputElement>) => {
    const g = parseInt(e.target.value, 10);
    setRewindGroup(g);
    if (pauseGroupIdx >= 0) {
      dispatch({ type: "SET_REWIND_RANGE", value: rewindRangeFor(g) });
    }
  };

  const rewindAndResume = () => {
    if (rewindGroup < groupStarts.length) {
      // 记录本次重绘区间（红色标记），预览中随重绘进度从橙色变为红色
      dispatch({ type: "SET_REDRAWN_RANGES", value: [...(state.redrawnRanges ?? []), rewindRangeFor(rewindGroup)] });
      driver.resume(groupStarts[rewindGroup]);
      // 保留 rewindRange：重绘进行中预览继续高亮尚未画到的部分
    }
  };

  // --- 补画模式（绘制结束后，仅重绘选中的路径区间） ---
  const [redrawG0, setRedrawG0] = useState(0);
  const [redrawG1, setRedrawG1] = useState(0);
  const groupCount = groupStarts.length;
  // 第 g 条路径的动作区间终点（不含），即下一条路径的起点
  const groupEnd = React.useCallback(
    (g: number) => (g + 1 < groupStarts.length ? groupStarts[g + 1] : (plan?.motions.length ?? groupStarts[g])),
    [groupStarts, plan],
  );
  const redrawMotionRange = React.useCallback(
    (g0: number, g1: number) => ({ from: groupStarts[g0], to: groupEnd(g1) }),
    [groupStarts, groupEnd],
  );
  const enterRedrawMode = () => {
    if (groupCount === 0 || plan == null) return;
    if (planSignature(plan) !== lastPlotSig.current) {
      const ok = window.confirm(
        "当前规划与上次绘制时不一致（修改过选项或重新加载了文件），\n区间编号可能无法对应实际笔迹。是否仍要继续？",
      );
      if (!ok) return;
    }
    const g1 = groupCount - 1;
    setRedrawG0(0);
    setRedrawG1(g1);
    dispatch({ type: "SET_REDRAW_MODE", value: true });
    dispatch({ type: "SET_REWIND_RANGE", value: redrawMotionRange(0, g1) });
  };
  const exitRedrawMode = () => {
    dispatch({ type: "SET_REDRAW_MODE", value: false });
    dispatch({ type: "SET_REWIND_RANGE", value: null });
  };
  const onRedrawFromChange = (e: ChangeEvent<HTMLInputElement>) => {
    const g0 = Math.min(parseInt(e.target.value, 10), redrawG1);
    setRedrawG0(g0);
    dispatch({ type: "SET_REWIND_RANGE", value: redrawMotionRange(g0, redrawG1) });
  };
  const onRedrawToChange = (e: ChangeEvent<HTMLInputElement>) => {
    const g1 = Math.max(parseInt(e.target.value, 10), redrawG0);
    setRedrawG1(g1);
    dispatch({ type: "SET_REWIND_RANGE", value: redrawMotionRange(redrawG0, g1) });
  };
  const startRedraw = () => {
    if (plan == null) return;
    dispatch({ type: "SET_REDRAW_MODE", value: false });
    // 记录补画区间：进行中橙色高亮未画到部分，完成后红色保留
    dispatch({
      type: "SET_REDRAWN_RANGES",
      value: [...(state.redrawnRanges ?? []), redrawMotionRange(redrawG0, redrawG1)],
    });
    try {
      const r = driver.redraw(
        machineFramePlan(plan, state.planOptions.driveParams.originCorner, state.planOptions.paperSize.size),
        groupStarts[redrawG0],
        groupEnd(redrawG1),
      ) as unknown;
      if (r instanceof Promise) {
        r.catch((e: unknown) => alert(`补画失败：${e instanceof Error ? e.message : String(e)}`));
      }
    } catch (e) {
      alert(`补画失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const homePen = () => {
    // 抬笔回原点：位置未知（如服务重启）时恢复已知笔位置，供补画使用
    try {
      const r = driver.homePen(
        plan ? machineFramePlan(plan, state.planOptions.driveParams.originCorner, state.planOptions.paperSize.size) : null,
      ) as unknown;
      if (r instanceof Promise) {
        r.catch((e: unknown) => alert(`笔回原点失败：${e instanceof Error ? e.message : String(e)}`));
      }
    } catch (e) {
      alert(`笔回原点失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const unlockDevice = () => {
    // 3.5 解锁设备（$X）：Alarm 且无法归位时的最后手段（仅服务端 GRBL 支持）
    if (confirm("解锁（$X）会丢失位置参考，解锁后须先「笔回原点」才能补画。确定解锁？")) {
      driver.unlockDevice();
    }
  };

  const simRef = React.useRef<{ timer: number | null; cancelled: boolean }>({ timer: null, cancelled: false });
  const simulate = React.useCallback(
    (simPlan: Plan) => {
      const motions = simPlan.motions;
      let idx = 0;
      simRef.current.cancelled = false;
      dispatch({ type: "SET_SIMULATING", value: true });
      dispatch({ type: "SET_DRAWN_WATERMARK", value: null });
      const advance = () => {
        if (simRef.current.cancelled || idx >= motions.length) {
          dispatch({ type: "SET_PROGRESS", motionIdx: null });
          dispatch({ type: "SET_SIMULATING", value: false });
          return;
        }
        const curMotion = motions[idx];
        dispatch({ type: "SET_PROGRESS", motionIdx: idx });
        idx++;
        simRef.current.timer = window.setTimeout(
          advance,
          Math.max(16, (curMotion instanceof XYMotion ? curMotion.duration() : 0.05) * 1000),
        );
      };
      advance();
    },
    [dispatch],
  );
  const stopSimulate = React.useCallback(() => {
    simRef.current.cancelled = true;
    if (simRef.current.timer != null) {
      clearTimeout(simRef.current.timer);
      simRef.current.timer = null;
    }
    dispatch({ type: "SET_PROGRESS", motionIdx: null });
    dispatch({ type: "SET_SIMULATING", value: false });
  }, [dispatch]);
  React.useEffect(() => {
    return () => {
      simRef.current.cancelled = true;
      if (simRef.current.timer != null) {
        clearTimeout(simRef.current.timer);
      }
    };
  }, []);

  React.useEffect(() => {
    return () => {
      simRef.current.cancelled = true;
      if (simRef.current.timer != null) {
        clearTimeout(simRef.current.timer);
      }
    };
  }, []);
  const totalSteps = plan?.motions?.length ?? 1;
  const pct = state.progress != null ? Math.min(Math.round(((state.progress + 1) / totalSteps) * 100), 100) : 0;

  return (
    <div>
      {state.progress != null && plan && (
        <div className="progress-bar-wrap">
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: pct + "%" }} />
          </div>
          <span className="progress-bar-label">
            {pct}%{pauseGroupIdx >= 0 && ` · 路径 ${pauseGroupIdx + 1}/${groupStarts.length}`}
          </span>
        </div>
      )}
      <div className="button-row">
        {!state.isSimulating ? (
          <button
            type="button"
            className="btn-blue"
            onClick={() => plan && simulate(plan)}
            disabled={plan == null || state.progress != null || state.isSimulating}
          >
            模拟绘制
          </button>
        ) : (
          <button type="button" className="btn-red" onClick={stopSimulate}>
            停止模拟
          </button>
        )}
      </div>
      {isPlanning ? (
        <button type="button" className="replan-button" disabled={true}>
          重新规划中...
        </button>
      ) : (
        <button
          type="button"
          className={`plot-button ${state.progress != null ? "plot-button--plotting" : ""}`}
          disabled={plan == null || state.progress != null}
          onClick={() => plan && plot(plan)}
        >
          {plan && state.progress != null ? "绘制中..." : "开始绘制"}
        </button>
      )}
      <div className={"button-row"}>
        <button
          type="button"
          className={`cancel-button ${state.progress != null ? "cancel-button--active" : ""}`}
          onClick={state.paused ? resume : pause}
          disabled={plan == null || state.progress == null}
        >
          {state.paused ? "继续（原位）" : "暂停"}
        </button>
        <button
          type="button"
          className={`cancel-button ${state.progress != null ? "cancel-button--active" : ""}`}
          onClick={cancel}
          disabled={plan == null || state.progress == null}
        >
          取消
        </button>
      </div>
      {state.paused && !state.isSimulating && state.progress != null && plan && pauseGroupIdx >= 0 && (
        <div className="rewind-controls">
          <div className="rewind-info">
            暂停中 — 已绘制第 {pauseGroupIdx + 1} / {groupStarts.length}{" "}
            条路径。拖动滑块选择回溯位置，重绘的线条将在预览中标红。
          </div>
          <div className="rewind-slider-row">
            <input
              type="range"
              className="rewind-slider"
              min={0}
              max={pauseGroupIdx}
              step={1}
              value={rewindGroup}
              onChange={onRewindSliderChange}
            />
            <span className="rewind-slider-label">第 {rewindGroup + 1} 条</span>
          </div>
          <div className="button-row">
            <button type="button" className="cancel-button cancel-button--active" onClick={rewindAndResume}>
              从第 {rewindGroup + 1} 条路径重绘并继续
            </button>
          </div>
        </div>
      )}
      {state.progress == null && !state.isSimulating && plan && groupCount > 0 && !state.redrawMode && (
        <div className="button-column">
          <button type="button" className="btn-blue" onClick={enterRedrawMode}>补画模式…</button>
          <div className="button-row">
            <button
              type="button"
              onClick={homePen}
              title="抬笔回到起始点。补画前若笔位置未知（如服务重启过），请先执行此项"
            >
              笔回原点
            </button>
            <button
              type="button"
              onClick={unlockDevice}
              title="解除 Alarm 锁定（$X）。仅服务端 GRBL 驱动支持；会丢失位置参考，解锁后须重新归位"
            >
              解锁设备
            </button>
          </div>
        </div>
      )}
      {state.redrawMode && state.progress == null && !state.isSimulating && groupCount > 0 && (
        <div className="rewind-controls redraw-mode-controls">
          <div className="rewind-info">
            补画模式 — 拖动两个滑块选择要补画的路径区间（第 {redrawG0 + 1} 至 {redrawG1 + 1}{" "}
            条），预览中以橙色高亮。确认后点击「补画选中区间」。
          </div>
          <div className="rewind-slider-row">
            <span className="rewind-slider-label">起点</span>
            <input
              type="range"
              className="rewind-slider"
              min={0}
              max={groupCount - 1}
              step={1}
              value={redrawG0}
              onChange={onRedrawFromChange}
            />
            <span className="rewind-slider-label">第 {redrawG0 + 1} 条</span>
          </div>
          <div className="rewind-slider-row">
            <span className="rewind-slider-label">终点</span>
            <input
              type="range"
              className="rewind-slider"
              min={redrawG0}
              max={groupCount - 1}
              step={1}
              value={redrawG1}
              onChange={onRedrawToChange}
            />
            <span className="rewind-slider-label">第 {redrawG1 + 1} 条</span>
          </div>
          <div className="button-column">
            <button type="button" className="btn-red" onClick={startRedraw}>
              补画选中区间
            </button>
            <div className="button-row">
              <button
                type="button"
                onClick={homePen}
                title="抬笔回到起始点。补画前若笔位置未知（如服务重启过），请先执行此项"
              >
                笔回原点
              </button>
              <button
                type="button"
                onClick={unlockDevice}
                title="解除 Alarm 锁定（$X）。仅服务端 GRBL 驱动支持；会丢失位置参考，解锁后须重新归位"
              >
                解锁设备
              </button>
            </div>
            <button type="button" onClick={exitRedrawMode}>退出补画</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ResetToDefaultsButton() {
  const dispatch = useContext(DispatchContext);
  const onClick = () => {
    // Clear all user settings that have been saved and reset to the defaults
    window.localStorage.removeItem("planOptions");
    dispatch({ type: "SET_PLAN_OPTION", value: { ...defaultPlanOptions } });
  };

  return (
    <button type="reset" onClick={onClick}>
      重置所有选项
    </button>
  );
}

/** 排版：图形在边距框内的对齐方式；自定义偏移相对边距框左上角（mm） */
function PlacementConfig({ state }: { state: State }) {
  const dispatch = useContext(DispatchContext);
  const placement = state.planOptions.placement ?? defaultPlacement;
  const set = (p: Partial<Placement>) =>
    dispatch({ type: "SET_PLAN_OPTION", value: { placement: { ...placement, ...p } } });
  return (
    <div title="图形在边距框内的排版位置；自定义偏移相对边距框左上角">
      <div className="flex">
        <label title="水平方向：居左 / 居中 / 居右 / 自定义">
          水平排版
          <select value={placement.alignH} onChange={(e) => set({ alignH: e.target.value as Placement["alignH"] })}>
            <option value="left">居左</option>
            <option value="center">居中</option>
            <option value="right">居右</option>
            <option value="custom">自定义</option>
          </select>
        </label>
        <label title="垂直方向：居上 / 居中 / 居下 / 自定义">
          垂直排版
          <select value={placement.alignV} onChange={(e) => set({ alignV: e.target.value as Placement["alignV"] })}>
            <option value="top">居上</option>
            <option value="middle">居中</option>
            <option value="bottom">居下</option>
            <option value="custom">自定义</option>
          </select>
        </label>
      </div>
      {(placement.alignH === "custom" || placement.alignV === "custom") && (
        <div className="flex">
          {placement.alignH === "custom" ? (
            <label title="图形包围盒左上角相对边距框左上角的 X 偏移 (mm)">
              X 偏移 (mm)
              <input
                type="number"
                value={placement.customXMm}
                step="1"
                onChange={(e) => set({ customXMm: Number(e.target.value) })}
              />
            </label>
          ) : null}
          {placement.alignV === "custom" ? (
            <label title="图形包围盒左上角相对边距框左上角的 Y 偏移 (mm)">
              Y 偏移 (mm)
              <input
                type="number"
                value={placement.customYMm}
                step="1"
                onChange={(e) => set({ customYMm: Number(e.target.value) })}
              />
            </label>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** 缩放模式：等比缩放到纸张绘图区域（默认）/ 按原尺寸 1:1 绘制 / 自定义缩放比例。
 * 非 fit 模式下可配合「裁剪至边距」移除超出纸张绘图区域的部分。 */
function ScaleModeConfig({ state }: { state: State }) {
  const dispatch = useContext(DispatchContext);
  const { scaleMode, scalePercent, cropToMargins } = state.planOptions;
  const set = (value: Partial<PlanOptions>) => dispatch({ type: "SET_PLAN_OPTION", value });
  return (
    <div
      className="scale-mode-config"
      title="非「等比缩放到纸张」模式下，超出纸张绘图区域的部分可用「裁剪至边距」移除"
    >
      <label className="flex-checkbox">
        <input
          type="radio"
          name="scaleMode"
          checked={scaleMode === "fit"}
          onChange={() => set({ scaleMode: "fit" })}
        />
        等比缩放到纸张
      </label>
      <label className="flex-checkbox">
        <input
          type="radio"
          name="scaleMode"
          checked={scaleMode === "actual"}
          onChange={() => set({ scaleMode: "actual" })}
        />
        按原尺寸绘制 (1:1)
      </label>
      <label className="flex-checkbox">
        <input
          type="radio"
          name="scaleMode"
          checked={scaleMode === "custom"}
          onChange={() => set({ scaleMode: "custom" })}
        />
        自定义缩放比例 (%)
      </label>
      {scaleMode === "custom" && (
        <label className="horizontal-labels" title="缩放比例，100 = 原尺寸">
          <span className="horizontal-labels__title">缩放比例</span>
          <input
            type="number"
            value={scalePercent}
            min="1"
            max="1000"
            step="1"
            onChange={(e) => set({ scalePercent: Number(e.target.value) })}
          />
        </label>
      )}
      {scaleMode !== "fit" && (
        <label className="flex-checkbox" title="移除超出边距的线条">
          <input
            type="checkbox"
            checked={cropToMargins}
            onChange={(e) => set({ cropToMargins: !!e.target.checked })}
          />
          裁剪至边距
        </label>
      )}
    </div>
  );
}

function PlanConfig({ state }: { state: State }) {
  // 绘制进给速度与设备 $110/$111 的联动校验：进给（×60 → mm/min）超过
  // 设备 XY 最大速度最小值时，转译层会静默钳制（gcode.ts），此处显式提示
  const xyMaxVel = state.planOptions.driveParams.firmware?.maxVelocityMmMin;
  const xyCapMmMinList = [xyMaxVel?.x, xyMaxVel?.y].filter((v): v is number => v != null && v > 0);
  const xyCapMmMin = xyCapMmMinList.length > 0 ? Math.min(...xyCapMmMinList) : null;
  // 取整消除浮点噪声（0.1×60 = 6.000000000000001）；比较加 1e-6 容差，
  // 避免 16.666…×60 = 1000.0000000000001 这类恰等于上限的值被误报超限
  const feedMmMin = Math.round(state.planOptions.penDownMaxVelocity * 60 * 1000) / 1000;
  const feedClamped = xyCapMmMin != null && feedMmMin > xyCapMmMin + 1e-6;
  const dispatch = useContext(DispatchContext);
  return (
    <div>
      <form>
        <label className="flex-checkbox" title="重新排序路径以最小化抬笔移动时间">
          <input
            type="checkbox"
            checked={state.planOptions.sortPaths}
            onChange={(e) => dispatch({ type: "SET_PLAN_OPTION", value: { sortPaths: !!e.target.checked } })}
          />
          路径排序
        </label>
        <label className="flex-checkbox" title="按组ID分图层，而非按笔画颜色">
          <input
            type="checkbox"
            checked={state.planOptions.layerMode === "group"}
            onChange={(e) =>
              dispatch({ type: "SET_PLAN_OPTION", value: { layerMode: e.target.checked ? "group" : "stroke" } })
            }
          />
          按组分图层
        </label>
        <label className="flex-checkbox">
          <input
            type="checkbox"
            checked={state.planOptions.hiding}
            onChange={(e) => dispatch({ type: "SET_PLAN_OPTION", value: { hiding: !!e.target.checked } })}
          />
          隐藏线去除
        </label>
      </form>
      <div className="horizontal-labels">
        <label title="合并同一路径中相近的点（去重），单位 mm">
          <span className="horizontal-labels__title">点合并半径 (mm)</span>
          <img src={pointJoinRadiusIcon} alt="点合并半径 (mm)" />
          <input
            type="number"
            value={state.planOptions.pointJoinRadius}
            step="0.1"
            min="0"
            onChange={(e) => dispatch({ type: "SET_PLAN_OPTION", value: { pointJoinRadius: Number(e.target.value) } })}
          />
        </label>
        <label title="合并端点相近的不同路径（减少抬笔），单位 mm">
          <span className="horizontal-labels__title">路径合并半径 (mm)</span>
          <img src={pathJoinRadiusIcon} alt="路径合并半径 (mm)" />
          <input
            type="number"
            value={state.planOptions.pathJoinRadius}
            step="0.1"
            min="0"
            onChange={(e) => dispatch({ type: "SET_PLAN_OPTION", value: { pathJoinRadius: Number(e.target.value) } })}
          />
        </label>
      </div>
      <div>
        <label title="移除短于此长度的路径（mm）">
          最小路径长度
          <input
            type="number"
            value={state.planOptions.minimumPathLength}
            step="0.1"
            min="0"
            onChange={(e) =>
              dispatch({ type: "SET_PLAN_OPTION", value: { minimumPathLength: Number(e.target.value) } })
            }
          />
        </label>
        {/* 组标题独立一行 + 单行短标签，保证两列输入框同一水平线对齐 */}
        {/* 绘制进给速度：真正的执行参数（生成绘制段 G1 的 F 进给值），与下方
         * 仅用于时长估算的落笔/抬笔参数明确区分。 */}
        <label
          title="落笔绘制时的进给速度 (mm/s)：主机按它计算每个绘制段 G1 的 F 值（受 $110/$111 最大速度钳制）。属绘制作业参数而非固件 $ 参数，参数助手读不到它。"
        >
          绘制进给速度 (mm/s)
          <input
            type="number"
            value={state.planOptions.penDownMaxVelocity}
            step="5"
            min="0"
            onChange={(e) =>
              dispatch({ type: "SET_PLAN_OPTION", value: { penDownMaxVelocity: Number(e.target.value) } })
            }
          />
        </label>
        <div className={feedClamped ? "field-hint field-hint--warn" : "field-hint"}>
          {feedClamped
            ? `进给 ${feedMmMin} mm/min 超过设备 $110/$111 最小上限 ${xyCapMmMin} mm/min，实际将按 ${xyCapMmMin} 执行。`
            : `落笔绘制段 G1 的 F 进给值来源（${feedMmMin} mm/min，受 $110/$111 钳制）；绘制作业参数，非固件 $ 参数。`}
        </div>
        <div className="field-group-title">落笔参数（仅估算）</div>
        <div className="field-hint">仅用于主机预计时长估算，实际加减速由设备 $120/$121 决定。</div>
        <label title="落笔时的加速度 (mm/s²)，仅用于主机预计时长估算">
          落笔加速度 (mm/s²)
          <input
            type="number"
            value={state.planOptions.penDownAcceleration}
            step="0.1"
            min="0"
            onChange={(e) =>
              dispatch({ type: "SET_PLAN_OPTION", value: { penDownAcceleration: Number(e.target.value) } })
            }
          />
        </label>
        <label>
          转弯系数
          <input
            type="number"
            value={state.planOptions.penDownCorneringFactor}
            step="0.01"
            min="0"
            onChange={(e) =>
              dispatch({ type: "SET_PLAN_OPTION", value: { penDownCorneringFactor: Number(e.target.value) } })
            }
          />
        </label>
        <div className="field-group-title">抬笔参数（仅估算）</div>
        <div className="field-hint">
          抬笔空程以 G0 执行，速度由设备 $110/$111 最大速率决定，本组仅用于主机预计时长估算；抬笔/落笔耗时的实际 Z
          轴速度由设备配置的「Z 进给」决定。
        </div>
        <div className="flex">
          <label title="抬笔时的加速度 (mm/s²)">
            加速度 (mm/s²)
            <input
              type="number"
              value={state.planOptions.penUpAcceleration}
              step="0.1"
              min="0"
              onChange={(e) =>
                dispatch({ type: "SET_PLAN_OPTION", value: { penUpAcceleration: Number(e.target.value) } })
              }
            />
          </label>
          <label title="抬笔时的最大速度 (mm/s)">
            最大速度 (mm/s)
            <input
              type="number"
              value={state.planOptions.penUpMaxVelocity}
              step="0.1"
              min="0"
              onChange={(e) =>
                dispatch({ type: "SET_PLAN_OPTION", value: { penUpMaxVelocity: Number(e.target.value) } })
              }
            />
          </label>
        </div>
        <div className="flex">
          <label title="抬笔所需时间（秒）">
            抬笔耗时 (s)
            <input
              type="number"
              value={state.planOptions.penLiftDuration}
              step="0.01"
              min="0"
              onChange={(e) =>
                dispatch({ type: "SET_PLAN_OPTION", value: { penLiftDuration: Number(e.target.value) } })
              }
            />
          </label>
          <label title="落笔所需时间（秒）">
            落笔耗时 (s)
            <input
              type="number"
              value={state.planOptions.penDropDuration}
              step="0.01"
              min="0"
              onChange={(e) =>
                dispatch({ type: "SET_PLAN_OPTION", value: { penDropDuration: Number(e.target.value) } })
              }
            />
          </label>
        </div>
      </div>
    </div>
  );
}

type PortSelectorProps = {
  driver: BaseDriver | null;
  setDriver: (driver: BaseDriver) => void;
};

function PortSelector({ driver, setDriver }: PortSelectorProps) {
  const [initializing, setInitializing] = useState(false);
  const connectingRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: setDriver is stable
  useEffect(() => {
    if (connectingRef.current) return; // Prevent concurrent connection attempts
    if (driver?.connected) return; // Already connected
    connectingRef.current = true;
    (async () => {
      setInitializing(true);
      try {
        const ports = await navigator.serial.getPorts(); // re-connect to previously established connection
        const port = ports[0];
        if (port) {
          console.log("connecting to", port);
          setDriver(await WebSerialDriver.connect(port));
        }
      } catch (e) {
        console.error("Auto-reconnect failed:", e);
      } finally {
        setInitializing(false);
        connectingRef.current = false;
      }
    })();
  }, [driver]);
  return (
    <>
      {driver?.connected ? `已连接到 ${driver.name()}` : null}
      <button
        type="button"
        disabled={initializing}
        onClick={async () => {
          setInitializing(true);
          try {
            // GRBL 设备 VID/PID 多样（Arduino 兼容板、grblHAL 板卡等），
            // 不设过滤，由用户在授权弹窗中选择目标设备。
            const port = await navigator.serial.requestPort();
            setDriver(await WebSerialDriver.connect(port));
          } catch (e) {
            alert(`Failed to connect to serial device: ${e.message}`);
            console.error(e);
          } finally {
            setInitializing(false);
          }
        }}
      >
        {initializing ? "连接中..." : driver?.connected ? "更换端口" : "连接"}
      </button>
    </>
  );
}

function Root() {
  const [driver, setDriver] = useState<BaseDriver | null>(null);
  const [isDriverConnected, setIsDriverConnected] = useState(false);
  useEffect(() => {
    if (isDriverConnected) return;
    if (IS_WEB) return;
    (async () => {
      setDriver(await Bit2AtomDriver.connect());
      setIsDriverConnected(true);
    })();
  }, [isDriverConnected]);

  const [state, dispatch] = useReducer(reducer, initialState);
  const { isPlanning, plan, setPlan } = usePlan(state.paths, state.planOptions);
  const [isLoadingFile, setIsLoadingFile] = useState(false);

  // 计划变更（切换图层、重新规划、载入新文件）后，旧的重绘/回溯区间记录
  // 基于旧计划的运动索引，不再对应新计划的路径，必须全部清除——
  // 新图层应从全白（未处理）状态开始显示。
  const lastPlanRef = React.useRef<Plan | null>(null);
  useEffect(() => {
    if (plan !== lastPlanRef.current) {
      lastPlanRef.current = plan;
      dispatch({ type: "SET_REDRAWN_RANGES", value: [] });
      dispatch({ type: "SET_REWIND_RANGE", value: null });
      dispatch({ type: "SET_REDRAW_MODE", value: false });
      dispatch({ type: "SET_DRAWN_WATERMARK", value: null });
    }
  }, [plan]);

  useEffect(() => {
    window.localStorage.setItem("planOptions", JSON.stringify(state.planOptions));
  }, [state.planOptions]);

  // biome-ignore lint/correctness/useExhaustiveDependencies(setPlan): React setters are stable
  useEffect(() => {
    if (driver == null) return;
    // 文件可能先于设备连接加载，连接/重连后补同步源文件名供任务日志使用
    driver.plotFileName = svgFileNameRef.current;
    driver.onprogress = (motionIdx: number) => {
      dispatch({ type: "SET_PROGRESS", motionIdx });
    };
    driver.oncancelled = driver.onfinished = () => {
      dispatch({ type: "SET_PROGRESS", motionIdx: null });
    };
    driver.ondevinfo = (devInfo: DeviceInfo) => {
      dispatch({ type: "SET_DEVICE_INFO", value: devInfo });
      dispatch({ type: "SET_PLAN_OPTION", value: { ...state.planOptions, hardware: devInfo.hardware } });
    };
    driver.onpause = (paused: boolean) => {
      dispatch({ type: "SET_PAUSED", value: paused });
    };
    driver.onplan = (plan: Plan) => {
      setPlan(plan);
    };
  }, [driver, state.planOptions]);

  useEffect(() => {
    // poll the driver so React notices connection changes
    if (!driver) return;
    const interval = setInterval(() => {
      if (state.connected !== driver.connected) {
        dispatch({ type: "SET_CONNECTED", connected: driver.connected });
      }
    }, 100);
    return () => clearInterval(interval);
  }, [driver, state.connected]);

  // 当前加载的源 SVG 文件名（ref 保证跨 driver 重连可用），随绘制/补画请求
  // 通过 X-Plot-Filename 头传给服务端，用于生成与源文件同名的任务日志。
  const svgFileNameRef = React.useRef<string | null>(null);

  const handleFile = React.useCallback(
    (file: File) => {
      setIsLoadingFile(true);
      setPlan(null);
      svgFileNameRef.current = file.name;
      if (driver != null) {
        driver.plotFileName = file.name;
      }

      const reader = new FileReader();
      reader.onerror = () => {
        setIsLoadingFile(false);
      };
      if (/\.(gcode|nc|tap|ngc)$/i.test(file.name)) {
        // G-code 导入（3.8）：解析为标准 Plan 直接进入管线（预览/回溯/补画/
        // 超界校验/任务日志复用）。笔位空间为 pct 口径，与当前 UI 档案一致。
        reader.onload = () => {
          try {
            const po = state.planOptions;
            const result = parseGcode(reader.result as string, {
              penUpPos: po.penUpHeight,
              penDownPos: po.penDownHeight,
              penDownProfile: {
                acceleration: po.penDownAcceleration,
                maximumVelocity: po.penDownMaxVelocity,
                corneringFactor: po.penDownCorneringFactor,
              },
              penUpProfile: {
                acceleration: po.penUpAcceleration,
                maximumVelocity: po.penUpMaxVelocity,
                corneringFactor: 0,
              },
              penDropDuration: po.penDropDuration,
              penLiftDuration: po.penLiftDuration,
              penHome: { ...po.penHome },
            });
            const paths: Path[] = result.strokes.map((s) => ({
              points: s.points.map((p) => machineFramePoint(p, po.driveParams.originCorner ?? "top-left", po.paperSize.size)),
              stroke: "black",
              groupId: "",
              fill: "none",
              fillRule: "nonzero",
              groupOrder: 0,
            }));
            // 笔画走 paths→replan 正常管线（与 SVG 导入同一条路）：旋转/
            // 对齐/缩放等排版操作由此生效。此前直接 setPlan 绕过 replan，
            // 排版参数对 G-code 导入完全无效。坐标为机器坐标（毫米），按
            // 当前原点角逐点镜像回屏幕空间（镜像变换自逆）；mmPerSvgUnit
            // = 1（G-code 坐标即毫米）。
            dispatch(setPaths(paths, 1));
            // 导入统计：告警行不静默丢弃，完整明细在控制台
            console.log(`[gcode-import] ${file.name}:`, result.stats, result.warnings);
            const summary = `导入完成：${result.strokes.length} 条笔画、${result.stats.arcs} 段圆弧、${result.warnings.length} 行告警跳过`;
            alert(result.warnings.length > 0 ? `${summary}（明细见浏览器控制台）` : summary);
          } catch (e) {
            console.error("Failed to import G-code:", e);
            alert(`G-code 导入失败：${e instanceof Error ? e.message : String(e)}`);
          }
          setIsLoadingFile(false);
        };
        reader.readAsText(file);
        return;
      }
      reader.onload = () => {
        try {
          const { paths, mmPerSvgUnit } = readSvg(reader.result as string);
          dispatch(setPaths(paths, mmPerSvgUnit));
        } catch (e) {
          // 解析/规划失败必须复位加载状态，否则预览会永久停留在「加载文件中...」
          console.error("Failed to read SVG:", e);
        }
        setIsLoadingFile(false);
      };
      reader.readAsText(file);
    },
    [setPlan, driver, state.planOptions],
  );
  const handleClear = React.useCallback(() => {
    setPlan(null);
    svgFileNameRef.current = null;
    if (driver != null) {
      driver.plotFileName = null;
    }
    dispatch({ type: "CLEAR_PATHS" });
  }, [setPlan, driver]);
  // 导出文件基名：沿用源文件名（对齐任务日志命名惯例）；无源文件回退 export。
  // try/catch 把导出异常转为显式弹窗——此前异常只在控制台留痕，表现为「点击无任何反馈」。
  const handleExportSvg = React.useCallback(() => {
    if (!plan) return;
    try {
      const base = (svgFileNameRef.current ?? "export").replace(/\.[^.]+$/, "");
      // 根节点写入 data-b2a-rotate-deg 标记（值为当前旋转设置）：本文件是
      // 最终排版结果，重导入时不再施加任何旋转（所见即所得），旋转不随
      // 导出/导入循环叠加。用户修改「旋转角度」时标记会被清除、旋转恢复生效。
      const svg = planToSvg(plan, state.planOptions.paperSize, state.planOptions.rotateDrawing);
      downloadText(svg, "image/svg+xml;charset=utf-8", `${base}-export.svg`);
    } catch (err) {
      alert(`导出 SVG 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [plan, state.planOptions]);
  const handleExportGCode = React.useCallback(() => {
    if (!plan) return;
    try {
      const base = (svgFileNameRef.current ?? "export").replace(/\.[^.]+$/, "");
      const gcode = planToGCode(
        machineFramePlan(plan, state.planOptions.driveParams.originCorner, state.planOptions.paperSize.size),
        {
          sourceFileName: svgFileNameRef.current,
          driveParams: state.planOptions.driveParams,
          hardwareLabel: state.planOptions.hardware,
        },
      );
      downloadText(gcode, "text/plain;charset=utf-8", `${base}-export.gcode`);
    } catch (err) {
      alert(`导出 G-code 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [plan, state.planOptions]);
  const [theme, setTheme] = React.useState<"light" | "dark">(
    () => (window.localStorage.getItem("bit2atom-theme") as "light" | "dark") || "light",
  );
  React.useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem("bit2atom-theme", theme);
  }, [theme]);

  useEffect(() => {
    // Called when the user drags and drops the image
    const ondrop = (e: DragEvent) => {
      e.preventDefault();
      document.body.classList.remove("dragover");
      const file = e.dataTransfer?.items[0]?.getAsFile();
      if (file) handleFile(file);
    };
    const ondragover = (e: DragEvent) => {
      e.preventDefault();
      document.body.classList.add("dragover");
    };
    const ondragleave = (e: DragEvent) => {
      e.preventDefault();
      document.body.classList.remove("dragover");
    };
    const onpaste = (e: ClipboardEvent) => {
      e.clipboardData?.items[0].getAsString((s) => {
        const { paths, mmPerSvgUnit, bakedRotationDeg } = readSvg(s);
        dispatch(setPaths(paths, mmPerSvgUnit, bakedRotationDeg));
      });
    };
    document.body.addEventListener("drop", ondrop);
    document.body.addEventListener("dragover", ondragover);
    document.body.addEventListener("dragleave", ondragleave);
    document.addEventListener("paste", onpaste);
    return () => {
      document.body.removeEventListener("drop", ondrop);
      document.body.removeEventListener("dragover", ondragover);
      document.body.removeEventListener("dragleave", ondragleave);
      document.removeEventListener("paste", onpaste);
    };
  }, [handleFile]);

  // Each time new motion is started, save the start time
  // biome-ignore lint/correctness/useExhaustiveDependencies: currentMotionStartedTime should be re-set with each motion
  const currentMotionStartedTime = useMemo(() => {
    return new Date();
  }, [state.progress, state.paused]);

  const previewArea = useRef(null);
  const previewSize = useComponentSize(previewArea);
  const showDragTarget = !plan && !isLoadingFile && !isPlanning;

  return (
    <DispatchContext.Provider value={dispatch}>
      <div className={`root ${state.connected ? "connected" : "disconnected"}`}>
        <div className="control-panel">
          <div className="bit2atom-title">
            <img src={bit2atomLogo} alt="Bit2AtomBot" className="title-logo" />
          </div>
          {!IS_WEB && (
            <div className={state.connected && state.deviceInfo?.path ? "info" : "info-disconnected"}>
              {state.connected
                ? state.deviceInfo?.path
                  ? `已连接到 GRBL (${state.deviceInfo.path})`
                  : "未连接到 GRBL 设备"
                : "未连接"}
            </div>
          )}
          {IS_WEB && (
            <div className="section-body">
              <PortSelector driver={driver} setDriver={setDriver} />
            </div>
          )}
          <div className="section-header">画笔设置</div>
          <div className="section-body">
            <PenHeight state={state} driver={driver} />
            <MotorControl driver={driver} />
            {/* 机器参数配置（硬件档案/传动参数/固件能力/坐标系/参数助手）
             * 收纳进可折叠面板：默认收起保持 UI 简洁，且避免误改参数。
             * 行为与「更多绘制配置」的 details/summary 一致。 */}
            <details className="device-config">
              <summary className="section-header">更多设备配置</summary>
              <div className="device-config-body">
                <HardwareOptions state={state} driver={driver} />
              </div>
            </details>
            <ResetToDefaultsButton />
          </div>
          <div className="section-header">纸张设置</div>
          <div className="section-body">
            <PaperConfig state={state} />
            <LayerSelector state={state} />
          </div>
          <div className="section-header">排版设置</div>
          <div className="section-body">
            <PlacementConfig state={state} />
            <ScaleModeConfig state={state} />
          </div>
          <details>
            <summary className="section-header">更多绘制配置</summary>
            <div className="section-body">
              <PlanConfig state={state} />
              <OriginOptions state={state} />
              <VisualizationOptions state={state} />
              <div className="section-header" style={{ marginTop: "8px" }}>
                主题设置
              </div>
              <label className="flex-checkbox">
                <input type="checkbox" checked={theme === "light"} onChange={() => setTheme("light")} />
                浅色模式
              </label>
              <label className="flex-checkbox">
                <input type="checkbox" checked={theme === "dark"} onChange={() => setTheme("dark")} />
                暗色模式
              </label>
            </div>
          </details>
          <div className="control-panel-bottom">
            <div className="section-header">绘图设置</div>
            <div className="section-body section-body__plot">
              <PlanStatistics plan={plan} />
              <TimeLeft
                plan={plan}
                progress={state.progress}
                currentMotionStartedTime={currentMotionStartedTime}
                paused={state.paused}
              />
              {plan && !state.isSimulating && (
                <div className="button-row">
                  <button type="button" className="export-svg-btn" onClick={handleExportSvg}>
                    导出 SVG
                  </button>
                  <button type="button" className="export-svg-btn" onClick={handleExportGCode}>
                    导出 G-code
                  </button>
                </div>
              )}
              <PlotButtons plan={plan} isPlanning={isPlanning} state={state} driver={driver} />
            </div>
          </div>
        </div>
        <div className="preview-area" ref={previewArea}>
          <PlanPreview
            state={state}
            previewSize={{ width: Math.max(0, previewSize.width - 40), height: Math.max(0, previewSize.height - 40) }}
            plan={plan}
          />
          <PlanLoader isPlanning={isPlanning} isLoadingFile={isLoadingFile} />
          {showDragTarget && <DragTarget handleFile={handleFile} />}
          {(plan != null || (state.paths && state.paths.length > 0)) && (
            <button type="button" className="clear-svg-btn" onClick={handleClear}>
              清除文件
            </button>
          )}
        </div>
      </div>
    </DispatchContext.Provider>
  );
}

function DragTarget({ handleFile }: { handleFile: (file: File) => void }) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const handleFileInputChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  return (
    <div className="drag-target">
      <div className="drag-target-message">
        <span>将 SVG / G-code 拖拽至此，或</span>
        <button type="button" onClick={() => fileInputRef.current.click()}>
          Upload SVG / G-code
        </button>{" "}
        {/* the input for the system file picker can't be styled, so hide it and use this button*/}
        <input
          ref={fileInputRef}
          type="file"
          accept=".svg,.gcode,.nc,.tap,.ngc"
          style={{ display: "none" }}
          onChange={handleFileInputChange}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("app")!).render(<Root />);

/** 文本下载（导出 SVG / G-code 共用） */
function downloadText(text: string, mime: string, fileName: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Read an SVG string and transform it to a list of Path.
 * @param svgString Raw SVG String
 * @returns The flattened paths, plus the SVG-unit→mm scale inferred from the
 * root element's width (undefined → fall back to the 96dpi default).
 */
function readSvg(svgString: string): {
  paths: Path[];
  mmPerSvgUnit: number | undefined;
  bakedRotationDeg: number | undefined;
} {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgString, "image/svg+xml");
  const svg = doc.querySelector("svg");
  // Enumerate shapes exactly like flatten-svg does internally (svg/g/a
  // recursion; geometry elements yielded; other containers like <defs>
  // skipped). This guarantees a 1:1 order correspondence with the
  // flattened output below.
  const shapes = [...enumShapes(svg)];
  // Pre-compute the cumulative transform of every element, in root
  // viewBox user units. flatten-svg (v0.3.0) gets these from getCTM(),
  // which returns the IDENTITY matrix for an SVG parsed via DOMParser
  // (never attached to the document) — silently dropping every
  // <g transform="..."> in the file (e.g. Affinity Designer exports).
  // When the SVG *is* attached, getCTM() would additionally include the
  // viewBox→viewport scale, which we don't want either: the plotter
  // expects coordinates in root user units (1 unit = 1/96 inch, see
  // massager.ts). So we compute the matrices ourselves and apply them
  // to the flattened points afterwards.
  const matMap = collectSvgMatrices(svg);
  const paths = flattenSVG(svg);

  // flattenSVG (v0.3.0) does NOT extract fill/fillRule/groupOrder.
  // We patch them here from the SVG elements.
  let pathIdx = 0;
  for (const shape of shapes) {
    if (pathIdx >= paths.length) break;
    const fill = shape.getAttribute("fill") || (shape as SVGElement).style?.fill || null;
    const fillRule =
      shape.getAttribute("fill-rule") ||
      (shape as SVGElement).style?.fillRule ||
      svg.getAttribute("fill-rule") ||
      (svg as SVGElement).style?.fillRule ||
      null;
    // Handle compound paths: a single <path> can produce multiple flattened paths
    // (one per M command — flatten-svg pushes a new Path at every M). Apply the
    // same fill/fillRule/transform to all of them.
    // NOTE: SVGPathElement.getPathData() is NOT a standard browser API — the
    // polyfill bundled in flatten-svg only exports a standalone function and
    // never patches the prototype, so shape.getPathData is always undefined
    // here and the subpath count silently collapsed to 1. That left every
    // subpath after the first un-transformed (e.g. Affinity exports with a
    // single <path> containing thousands of M subpaths split into two blocks).
    // Count subpaths directly from the `d` attribute instead: each M/m command
    // starts exactly one subpath (letters never occur inside path numbers).
    let subpaths = 1;
    if (shape.nodeName.toLowerCase() === "path") {
      const d = shape.getAttribute("d") ?? "";
      subpaths = (d.match(/[mM]/g) ?? []).length;
      if (subpaths === 0) continue; // empty <path> produces no flattened paths
    }
    const m = matMap.get(shape) ?? SVG_IDENTITY;
    for (let s = 0; s < subpaths && pathIdx < paths.length; s++) {
      paths[pathIdx] = {
        ...paths[pathIdx],
        fill: fill && fill !== "" ? fill : null,
        fillRule: fillRule && fillRule !== "" ? fillRule : "nonzero",
        groupOrder: paths[pathIdx].groupId ? parseInt(paths[pathIdx].groupId, 10) || 0 : 0,
      };
      applyMatrixToPath(paths[pathIdx], m);
      pathIdx++;
    }
  }
  // 导入时推算用户单位→mm 的换算系数（width 带绝对物理单位或 px 数与
  // viewBox 不一致时非 96dpi，按 width_mm ÷ viewBox 宽还原真实尺寸；
  // width="100%"/缺失时为 undefined，规划时回退 96dpi 缺省值）。
  // 同时识别本应用导出的文件（根节点 data-b2a-rotate-deg 标记；外部文件
  // 无此属性 → undefined）：带标记的文件重导入时不再施加「旋转绘制」，
  // 保证导出→再导入所见即所得、旋转不随往返循环叠加。
  return {
    paths,
    mmPerSvgUnit: mmPerSvgUnitFromSvg(svg),
    bakedRotationDeg: svg.hasAttribute("data-b2a-rotate-deg")
      ? Number(svg.getAttribute("data-b2a-rotate-deg")) || 0
      : undefined,
  };
}

// --- Full SVG transform support --------------------------------------------
// See readSvg() for the rationale. flatten-svg returns points transformed
// only by getCTM() (identity here), so we apply the cumulative `transform`
// attribute matrices to the flattened points ourselves.
//
// Supported: matrix/translate/scale/rotate/skewX/skewY transform lists,
// nested and mixed, on <svg>/<g>/<a> and geometry elements.
// Not supported (unchanged from before): <use>/<defs> indirection; nested
// <svg> x/y/width/height viewport setup (treated like <g>).
//
// flatten-svg point format: [x, y] arrays that also carry .x/.y properties
// (set by its internal helper), so both representations are updated.

type SvgMatrix = { a: number; b: number; c: number; d: number; e: number; f: number };

const SVG_IDENTITY: SvgMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function mulSvgMatrix(m1: SvgMatrix, m2: SvgMatrix): SvgMatrix {
  // Equivalent to the transform list "m1 m2": m2 is applied to points first.
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

const SVG_NUM_RE = /[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g;

function parseSvgTransform(transform: string): SvgMatrix {
  let m = SVG_IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null = re.exec(transform);
  while (match !== null) {
    const nums = (match[2].match(SVG_NUM_RE) ?? []).map(Number);
    const rad = (v: number) => (v * Math.PI) / 180;
    let t: SvgMatrix = SVG_IDENTITY;
    switch (match[1]) {
      case "matrix":
        if (nums.length < 6) throw new Error(`Invalid matrix() in transform: ${match[0]}`);
        t = { a: nums[0], b: nums[1], c: nums[2], d: nums[3], e: nums[4], f: nums[5] };
        break;
      case "translate":
        t = { a: 1, b: 0, c: 0, d: 1, e: nums[0] ?? 0, f: nums[1] ?? 0 };
        break;
      case "scale": {
        const sx = nums[0] ?? 1;
        const sy = nums[1] ?? sx;
        t = { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
        break;
      }
      case "rotate": {
        const cos = Math.cos(rad(nums[0] ?? 0));
        const sin = Math.sin(rad(nums[0] ?? 0));
        if (nums.length >= 3) {
          const cx = nums[1];
          const cy = nums[2];
          t = { a: cos, b: sin, c: -sin, d: cos, e: cx - cos * cx + sin * cy, f: cy - sin * cx - cos * cy };
        } else {
          t = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
        }
        break;
      }
      case "skewX":
        t = { a: 1, b: 0, c: Math.tan(rad(nums[0] ?? 0)), d: 1, e: 0, f: 0 };
        break;
      case "skewY":
        t = { a: 1, b: Math.tan(rad(nums[0] ?? 0)), c: 0, d: 1, e: 0, f: 0 };
        break;
    }
    m = mulSvgMatrix(m, t);
    match = re.exec(transform);
  }
  return m;
}

// Per SVG spec, `transform` only takes effect on these element types.
function hasSvgTransform(el: Element): boolean {
  const tag = el.nodeName.toLowerCase();
  return (
    tag === "svg" ||
    tag === "g" ||
    tag === "a" ||
    tag === "path" ||
    tag === "rect" ||
    tag === "circle" ||
    tag === "ellipse" ||
    tag === "line" ||
    tag === "polyline" ||
    tag === "polygon" ||
    tag === "text" ||
    tag === "use" ||
    tag === "image" ||
    tag === "switch"
  );
}

function collectSvgMatrices(svg: Element): Map<Element, SvgMatrix> {
  const map = new Map<Element, SvgMatrix>();
  const walk = (el: Element, parentM: SvgMatrix): void => {
    const t = hasSvgTransform(el) ? el.getAttribute("transform") : null;
    const m = t ? mulSvgMatrix(parentM, parseSvgTransform(t)) : parentM;
    map.set(el, m);
    for (const child of el.children) walk(child, m);
  };
  walk(svg, SVG_IDENTITY);
  return map;
}

// Mirror of flatten-svg's internal shape enumeration: recurse into
// svg/g/a, yield geometry elements, skip everything else (defs, text
// content, ...). Same traversal order as flattenSVG()'s output.
function* enumShapes(el: Element): Generator<SVGGraphicsElement> {
  switch (el.nodeName.toLowerCase()) {
    case "svg":
    case "g":
    case "a":
      for (const child of el.children) yield* enumShapes(child);
      break;
    case "rect":
    case "circle":
    case "ellipse":
    case "path":
    case "line":
    case "polyline":
    case "polygon":
      yield el as SVGGraphicsElement;
      break;
  }
}

function applyMatrixToPath(path: Path, m: SvgMatrix): void {
  if (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0) return;
  // flatten-svg points are [x, y] arrays that also carry .x/.y properties.
  type FlattenPt = { 0: number; 1: number; x: number; y: number };
  for (const pt of path.points as unknown as FlattenPt[]) {
    const x = pt[0];
    const y = pt[1];
    pt[0] = m.a * x + m.c * y + m.e;
    pt[1] = m.b * x + m.d * y + m.f;
    pt.x = pt[0];
    pt.y = pt[1];
  }
}
