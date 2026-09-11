import type { Path } from "flatten-svg";
import { elideShorterThan, merge as joinNearbyPaths, reorder as sortPaths } from "optimize-paths";
import { removeHiddenLines } from "./hiding.js";
import { computeStepsPerMm, getDevice, isBuiltinHardware, type Plan, type PlanOptions, plan } from "./planning.js";
import { alignToMargins, cropToMargins, dedupPoints, defaultMmPerSvgUnit, defaultPlacement, scaleToPaper } from "./util.js";
import { type Vec2, vmul, vrot } from "./vec.js";

/**
 * Create a plan based on new vectors and plan options
 * @param inPaths
 * @param planOptions
 * @returns
 */
export function replan(inPaths: Path[], planOptions: PlanOptions): Plan {
  // 每条路径同步携带其在 inPaths 中的原始索引。cropToMargins 会把一条路径
  // 就地拆分成多条碎片，若之后仍按数组下标回查 inPaths 会索引错位（图层
  // 过滤误删/误留碎片，甚至下标越界崩溃），故索引必须随路径一起拆分与过滤。
  let paths: Vec2[][] = inPaths.map((path) => path.points);
  let origIndices: number[] = inPaths.map((_, i) => i);
  // SVG 用户单位 → mm 的换算系数：导入时若根元素 width 带绝对物理单位，
  // 由 mmPerSvgUnitFromSvg() 按 width_mm ÷ viewBox 宽推算（非 96dpi 导出
  // 的文件也能还原真实尺寸）；缺省按 96dpi（1px = 25.4/96 mm）。
  const mmPerUnit = planOptions.mmPerSvgUnit ?? defaultMmPerSvgUnit;
  const device = getDevice(planOptions.hardware);
  const effectiveStepsPerMm = isBuiltinHardware(planOptions.hardware)
    ? device.stepsPerMm
    : computeStepsPerMm(planOptions.driveParams);

  // Rotate drawing around center of paper to handle plotting portrait drawings
  // along y-axis of plotter
  // Rotate around the center of the page, but in SvgUnits (not mm)
  if (planOptions.rotateDrawing !== 0) {
    console.time("rotating paths");
    paths = paths.map((pl) =>
      pl.map((p) =>
        vrot(
          p,
          vmul({ x: planOptions.paperSize.size.x / 2, y: planOptions.paperSize.size.y / 2 }, 1 / mmPerUnit),
          planOptions.rotateDrawing,
        ),
      ),
    );
    console.timeEnd("rotating paths");
  }

  // Compute scaling using _all_ the paths, so it's the same no matter what
  // layers are selected.
  const placement = planOptions.placement ?? defaultPlacement;
  if (planOptions.scaleMode === "fit") {
    paths = scaleToPaper(paths, planOptions.paperSize, planOptions.marginMm, placement);
  } else {
    // 原尺寸 (1:1) 或自定义比例：按毫米换算后（可选地）缩放，再对齐到
    // 边距框；超出纸张绘图区域的部分可由 cropToMargins 裁剪
    paths = paths.map((ps) => ps.map((p) => vmul(p, mmPerUnit)));
    if (planOptions.scaleMode === "custom") {
      const s = planOptions.scalePercent / 100;
      paths = paths.map((ps) => ps.map((p) => vmul(p, s)));
    }
    paths = alignToMargins(paths, planOptions.paperSize, planOptions.marginMm, placement);
    if (planOptions.cropToMargins) {
      // 裁剪按 Liang-Barsky 逐线段与边距框求交：框内的节点与线段全部保留，
      // 只切掉框外部分；一条路径会在穿越边框处被拆分成多条碎片。
      // 重要：每条碎片必须继承原路径的 origIndices[i]！下游的图层过滤与
      // 隐藏线去除都靠它回查 inPaths 获取 stroke/fill 等属性。历史上曾按
      // 碎片在数组中的新下标 i 直接取 inPaths[i]，单路径文件（Affinity 导出
      // 的单个超长 <path>）拆出数百条碎片后下标越界直接崩溃，多路径文件则
      // 错用别的路径的图层归属，导致碎片被整批误删（实测 153m 只剩 4.3m）。
      const cropped: Vec2[][] = [];
      const croppedIndices: number[] = [];
      for (const [i, pl] of paths.entries()) {
        for (const fragment of cropToMargins([pl], planOptions.paperSize, planOptions.marginMm)) {
          cropped.push(fragment);
          croppedIndices.push(origIndices[i]);
        }
      }
      paths = cropped;
      origIndices = croppedIndices;
    }
  }

  // Rescaling/cropping loses the stroke info, so refer back to the original
  // paths to filter based on the stroke.
  // 注意：路径在上面的变换中可能被 cropToMargins 拆分，paths 数组下标已与
  // inPaths 不再一一对应，必须通过每条路径随身携带的 origIndices[i]（原始
  // 索引）回查，绝不能直接用 inPaths[i]。回归测试见
  // __tests__/crop-layer-filter.test.ts。
  //
  // NOTE: When hidden-line removal is enabled, layer filtering is deferred
  // until AFTER hidden-line removal so that fill paths from unselected layers
  // can still clip strokes from selected layers. Without this, selecting only
  // stroke layers (without their fill layers) would defeat hidden-line removal.
  const layerFilterEnabled = planOptions.layerMode === "group" || planOptions.layerMode === "stroke";
  const isLayerSelected = (originalIndex: number): boolean => {
    if (planOptions.layerMode === "group") {
      return planOptions.selectedGroupLayers.has(inPaths[originalIndex].groupId);
    }
    if (planOptions.layerMode === "stroke") {
      return planOptions.selectedStrokeLayers.has(inPaths[originalIndex].stroke);
    }
    return true;
  };

  if (layerFilterEnabled && !planOptions.hiding) {
    // No hidden-line removal: filter up front as before.
    if (planOptions.layerMode === "group") {
      paths = paths.filter((_path, i) => planOptions.selectedGroupLayers.has(inPaths[origIndices[i]].groupId));
    } else if (planOptions.layerMode === "stroke") {
      paths = paths.filter((_path, i) => planOptions.selectedStrokeLayers.has(inPaths[origIndices[i]].stroke));
    }
  }

  // Hidden-line removal
  if (planOptions.hiding) {
    // Build clippable array from ALL paths (not filtered by layer selection)
    // so that fill paths from unselected layers can still clip strokes.
    const clippable = paths.map((points, i) => ({
      points,
      stroke: inPaths[origIndices[i]].stroke ?? null,
      fill: inPaths[origIndices[i]].fill ?? null,
      fillRule: inPaths[origIndices[i]].fillRule ?? "nonzero",
      groupOrder: inPaths[origIndices[i]].groupOrder ?? 0,
      originalIndex: origIndices[i],
    }));
    clippable.sort((a, b) => (a.groupOrder ?? 0) - (b.groupOrder ?? 0));
    const result = removeHiddenLines(clippable);
    // Filter the result by layer selection now (after hidden-line removal).
    // Each result path carries the originalIndex of the path it came from.
    if (layerFilterEnabled) {
      const filtered = result.filter((p) => isLayerSelected(p.originalIndex));
      paths = filtered.map((p) => p.points);
    } else {
      paths = result.map((p) => p.points);
    }
  }

  if (planOptions.pointJoinRadius > 0) {
    paths = paths.map((p) => dedupPoints(p, planOptions.pointJoinRadius));
  }

  if (planOptions.sortPaths) {
    console.time("sorting paths");
    paths = sortPaths(paths);
    console.timeEnd("sorting paths");
  }

  if (planOptions.minimumPathLength > 0) {
    console.time("eliding short paths");
    paths = elideShorterThan(paths, planOptions.minimumPathLength);
    console.timeEnd("eliding short paths");
  }

  if (planOptions.pathJoinRadius > 0) {
    console.time("joining nearby paths");
    paths = joinNearbyPaths(paths, planOptions.pathJoinRadius);
    console.timeEnd("joining nearby paths");
  }

  // Convert the paths to units of "steps".
  paths = paths.map((ps) => ps.map((p) => vmul(p, effectiveStepsPerMm)));

  // And finally, motion planning.
  console.time("planning pen motions");
  const theplan = plan(
    paths,
    {
      penUpPos: device.penPctToPos(planOptions.penUpHeight),
      penDownPos: device.penPctToPos(planOptions.penDownHeight),
      penDownProfile: {
        acceleration: planOptions.penDownAcceleration * effectiveStepsPerMm,
        maximumVelocity: planOptions.penDownMaxVelocity * effectiveStepsPerMm,
        corneringFactor: planOptions.penDownCorneringFactor * effectiveStepsPerMm,
      },
      penUpProfile: {
        acceleration: planOptions.penUpAcceleration * effectiveStepsPerMm,
        maximumVelocity: planOptions.penUpMaxVelocity * effectiveStepsPerMm,
        corneringFactor: 0,
      },
      penDropDuration: planOptions.penDropDuration,
      penLiftDuration: planOptions.penLiftDuration,
    },
    vmul(planOptions.penHome, effectiveStepsPerMm),
  );
  console.timeEnd("planning pen motions");

  return theplan;
}
