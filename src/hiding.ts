/**
 * Hidden-line removal for pen plotting.
 *
 * Uses filled paths from upper layers to clip strokes from lower layers,
 * simulating the effect of filled regions hiding lines behind them.
 *
 * Inspired by the AxiDraw Inkscape extension (clipping.py).
 */

export interface ClippablePath {
  points: Array<{ x: number; y: number }>;
  stroke: string | null;
  fill: string | null;
  fillRule: string;
  groupOrder: number;
  /**
   * Index of the original path this clippable path was derived from.
   * Preserved across clipping so that callers can filter the result by
   * the original layer/stroke membership after hidden-line removal.
   */
  originalIndex: number;
}

function hasStroke(stroke: string | null): boolean {
  return !!stroke && stroke.toLowerCase() !== "none";
}

function hasFill(fill: string | null): boolean {
  return !!fill && fill.toLowerCase() !== "none" && fill.toLowerCase() !== "transparent";
}

/**
 * Remove hidden lines from an array of paths.
 *
 * Algorithm (mirrors AxiDraw's ClipPathsProcess.clip):
 * 1. Process paths in their given order (bottom-to-top in z-order)
 * 2. For each path that has a non-"none" fill, use its outline as a clipping region
 * 3. Clip all paths that appear BEFORE it (lower in z-order)
 * 4. After clipping, remove paths without strokes (they served as clipping masks)
 *
 * @param paths - Array of paths in bottom-to-top layer order
 * @returns Array of paths with hidden lines removed
 */
export function removeHiddenLines(paths: ClippablePath[]): ClippablePath[] {
  if (paths.length === 0) return [];

  let result: ClippablePath[] = paths.map((p) => ({
    ...p,
    points: [...p.points],
    originalIndex: p.originalIndex,
  }));

  let i = 1;
  while (i < result.length) {
    const clipper = result[i];
    if (hasFill(clipper.fill) && clipper.points.length >= 3) {
      const ring = ensureClosed(clipper.points);
      if (ring.length >= 3) {
        const newLower: ClippablePath[] = [];
        for (let j = 0; j < i; j++) {
          const clippee = result[j];
          if (hasStroke(clippee.stroke)) {
            const clipped = clipPolylineByRing(clippee.points, ring);
            if (clipped.length === 0) continue;
            for (const part of clipped) {
              // Clipped segments inherit the clippee's originalIndex so that
              // callers can still filter by layer after hidden-line removal.
              newLower.push({ ...clippee, points: part, originalIndex: clippee.originalIndex });
            }
          } else {
            newLower.push({ ...clippee, points: [...clippee.points], originalIndex: clippee.originalIndex });
          }
        }
        result = [...newLower, ...result.slice(i)];
        i = newLower.length + 1;
        continue;
      }
    }
    i++;
  }

  return result.filter((p) => hasStroke(p.stroke));
}

function ensureClosed(polyline: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  if (polyline.length < 2) return polyline;
  const first = polyline[0];
  const last = polyline[polyline.length - 1];
  if (first.x === last.x && first.y === last.y) return polyline;
  return [...polyline, { x: first.x, y: first.y }];
}

function clipPolylineByRing(
  polyline: Array<{ x: number; y: number }>,
  ring: Array<{ x: number; y: number }>,
): Array<Array<{ x: number; y: number }>> {
  if (polyline.length < 2) return [polyline];

  const result: Array<Array<{ x: number; y: number }>> = [];
  let current: Array<{ x: number; y: number }> = [];

  for (let i = 0; i < polyline.length - 1; i++) {
    const p1 = polyline[i];
    const p2 = polyline[i + 1];

    const intersections: Array<{ x: number; y: number }> = [];
    for (let j = 0; j < ring.length - 1; j++) {
      const pt = segmentIntersection(p1, p2, ring[j], ring[j + 1]);
      if (pt) intersections.push(pt);
    }

    if (intersections.length === 0) {
      if (!pointInRing(p1, ring)) {
        if (current.length === 0) current.push(p1);
        current.push(p2);
      } else {
        if (current.length > 1) result.push(current);
        current = [];
      }
    } else {
      const pts = [p1, ...sortPointsAlongSegment(p1, p2, intersections), p2];
      for (let k = 0; k < pts.length - 1; k++) {
        const mid = { x: (pts[k].x + pts[k + 1].x) / 2, y: (pts[k].y + pts[k + 1].y) / 2 };
        if (!pointInRing(mid, ring)) {
          if (current.length === 0) current.push(pts[k]);
          current.push(pts[k + 1]);
        } else {
          if (current.length > 1) result.push(current);
          current = [];
        }
      }
    }
  }

  if (current.length > 1) result.push(current);
  return result;
}

function segmentIntersection(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  d: { x: number; y: number },
): { x: number; y: number } | null {
  const dx1 = b.x - a.x;
  const dy1 = b.y - a.y;
  const dx2 = d.x - c.x;
  const dy2 = d.y - c.y;
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-12) return null;

  const t = ((c.x - a.x) * dy2 - (c.y - a.y) * dx2) / denom;
  const u = ((c.x - a.x) * dy1 - (c.y - a.y) * dx1) / denom;

  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return { x: a.x + t * dx1, y: a.y + t * dy1 };
  }
  return null;
}

function sortPointsAlongSegment(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  points: Array<{ x: number; y: number }>,
): Array<{ x: number; y: number }> {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const lenSq = dx * dx + dy * dy || 1;
  return [...points].sort((a, b) => {
    const ta = ((a.x - p1.x) * dx + (a.y - p1.y) * dy) / lenSq;
    const tb = ((b.x - p1.x) * dx + (b.y - p1.y) * dy) / lenSq;
    return ta - tb;
  });
}

function pointInRing(
  point: { x: number; y: number },
  ring: Array<{ x: number; y: number }>,
  fillRule = "nonzero",
): boolean {
  let winding = 0;
  const n = ring.length - 1;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[i + 1];

    if ((point.x === a.x && point.y === a.y) || (point.x === b.x && point.y === b.y)) {
      return true;
    }

    if (a.y <= point.y) {
      if (b.y > point.y) {
        const l = (a.x - point.x) * (b.y - point.y) - (a.y - point.y) * (b.x - point.x);
        if (l > 0) winding++;
      }
    } else if (b.y <= point.y) {
      const l = (a.x - point.x) * (b.y - point.y) - (a.y - point.y) * (b.x - point.x);
      if (l < 0) winding--;
    }
  }

  return fillRule === "evenodd" ? winding % 2 !== 0 : winding !== 0;
}

