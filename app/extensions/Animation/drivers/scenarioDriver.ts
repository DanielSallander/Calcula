//! FILENAME: app/extensions/Animation/drivers/scenarioDriver.ts
// PURPOSE: The scenario driver — tween across named Scenario Manager scenarios as
//          keyframes. Reuses the transient write mechanism (anim_snapshot /
//          anim_apply_frame / anim_restore) over the UNION of all changing cells.
//          Numeric changing cells lerp in "linear" mode; others (and "step" mode)
//          snap. Reuses scenario DATA only — not the (non-transient) scenario_show.
import type { Driver } from "../lib/driver";
import type { ScenarioSpec } from "../types";
import {
  animSnapshot,
  animApplyFrame,
  animRestore,
  listScenarios,
  type TransientCellWrite,
} from "../lib/animationBackend";
import { repaintFromCells } from "../lib/repaint";

let driverSeq = 0;

/** Frames a spec produces: one per keyframe (step) or tweened segments (linear). */
export function scenarioFrameCount(spec: ScenarioSpec): number {
  const k = spec.keyframes.length;
  if (k <= 1) return Math.max(1, k);
  if (spec.interpolate === "step") return k;
  return (k - 1) * Math.max(1, Math.floor(spec.framesPerSegment)) + 1;
}

interface Keyframe {
  name: string;
  cells: Map<string, TransientCellWrite>; // "row,col" -> {row,col,value}
}

interface LoadedScenarios {
  keyframes: Keyframe[];
  union: [number, number][];
}

const key = (row: number, col: number): string => `${row},${col}`;

/** Compute the transient writes for frame `t` from loaded keyframe data. Pure. */
export function scenarioWritesForFrame(
  spec: ScenarioSpec,
  keyframes: Keyframe[],
  union: [number, number][],
  t: number,
): TransientCellWrite[] {
  const k = keyframes.length;
  if (k === 0) return [];
  if (k === 1 || spec.interpolate === "step") {
    const idx = Math.max(0, Math.min(k - 1, spec.interpolate === "step" ? t : 0));
    return [...keyframes[idx].cells.values()];
  }
  // Linear: locate the segment [seg, seg+1] and progress u in [0, 1].
  const per = Math.max(1, Math.floor(spec.framesPerSegment));
  let seg = Math.floor(t / per);
  let u = (t - seg * per) / per;
  if (seg >= k - 1) {
    seg = k - 2;
    u = 1;
  }
  const from = keyframes[seg].cells;
  const to = keyframes[seg + 1].cells;
  const writes: TransientCellWrite[] = [];
  for (const [row, col] of union) {
    const a = from.get(key(row, col));
    const b = to.get(key(row, col));
    let value: string;
    if (a && b) {
      const na = Number(a.value);
      const nb = Number(b.value);
      if (Number.isFinite(na) && Number.isFinite(nb)) {
        value = String(Math.round((na + (nb - na) * u) * 1e9) / 1e9);
      } else {
        value = u < 0.5 ? a.value : b.value;
      }
    } else {
      // Present in only one adjacent keyframe -> constant across the segment.
      value = (a ?? b)!.value;
    }
    writes.push({ row, col, value });
  }
  return writes;
}

export function createScenarioDriver(spec: ScenarioSpec): Driver {
  const token = `anim-scenario-${spec.sheetIndex}-${++driverSeq}`;
  let loaded: LoadedScenarios | null = null;

  async function ensureLoaded(): Promise<LoadedScenarios> {
    if (loaded) return loaded;
    const all = await listScenarios(spec.sheetIndex);
    const byName = new Map(all.map((s) => [s.name, s]));
    const keyframes: Keyframe[] = spec.keyframes.map((name) => {
      const s = byName.get(name);
      const cells = new Map<string, TransientCellWrite>();
      (s?.changingCells ?? []).forEach((c) => cells.set(key(c.row, c.col), { row: c.row, col: c.col, value: c.value }));
      return { name, cells };
    });
    const unionMap = new Map<string, [number, number]>();
    keyframes.forEach((kf) => kf.cells.forEach((c) => unionMap.set(key(c.row, c.col), [c.row, c.col])));
    loaded = { keyframes, union: [...unionMap.values()] };
    return loaded;
  }

  return {
    frameCount: scenarioFrameCount(spec),

    async snapshot(): Promise<void> {
      const data = await ensureLoaded();
      await animSnapshot(token, spec.sheetIndex, data.union);
    },

    async applyFrame(t: number): Promise<void> {
      const data = await ensureLoaded();
      const writes = scenarioWritesForFrame(spec, data.keyframes, data.union, t);
      if (writes.length === 0) return;
      const res = await animApplyFrame(spec.sheetIndex, writes);
      repaintFromCells(res.updatedCells);
    },

    async restore(): Promise<void> {
      const res = await animRestore(token, spec.sheetIndex);
      repaintFromCells(res.updatedCells);
    },

    frameLabel(t: number): string {
      const k = spec.keyframes.length;
      if (k === 0) return "";
      if (k === 1 || spec.interpolate === "step") {
        return spec.keyframes[Math.max(0, Math.min(k - 1, spec.interpolate === "step" ? t : 0))];
      }
      const per = Math.max(1, Math.floor(spec.framesPerSegment));
      let seg = Math.floor(t / per);
      let u = (t - seg * per) / per;
      if (seg >= k - 1) {
        seg = k - 2;
        u = 1;
      }
      return `${spec.keyframes[seg]} → ${spec.keyframes[seg + 1]} ${Math.round(u * 100)}%`;
    },
  };
}
