//! FILENAME: app/extensions/CanvasSheet/lib/objectNudge.ts
// PURPOSE: The arrow-key NUDGE on a canvas: the selected objects move by one
//          step per keystroke, and a burst of keystrokes is ONE undo step.
// CONTEXT: A canvas has no cells, so the grid does no arrow navigation there
//          (Core); the arrows are free for the objects. These are registry
//          bindings with a `when` guard (the objectCycling precedent), so they
//          win only while they apply:
//            - on a CANVAS, with the grid focused, on an EDITABLE surface (a
//              subscribed canvas is the publisher's layout);
//            - with at least one object selected;
//            - never while an INNER selection owns the arrows
//              (`objectOwnsKey("Arrow")`): a floating range's selected cell
//              moves on the arrows, and a chart walked down to a series walks
//              its points -- the registry's window-capture listener runs
//              before either family's own listener, so it must ask.
//
//          THE STEP.
//            - Snap on (and no Alt): to the NEXT grid multiple in that
//              direction, measured from the selection's leading edge -- an
//              off-grid object lands on the grid, an on-grid one moves one
//              pitch.
//            - Otherwise: 1 px, or 10 px with Shift. Alt is the canvas's
//              "move freely" modifier, as it is for a drag.
//            - Then the whole selection is kept on the page (the group's
//              bounds are clamped, so the objects keep their layout). The
//              step is NEVER fed through Core's `applySurfaceToMove`: that
//              snaps to the NEAREST multiple, so a 1 px step would round
//              straight back to where it started.
//          Locked objects and ones whose family refuses moves stay put.
//
//          THE BURST. Each keystroke (and each auto-repeat) PREVIEWS the new
//          geometry through each family's provider (@api/objectGeometry) --
//          no write, no undo entry. The burst is committed once, through
//          `commitObjectGeometry("Nudge")`, when the arrow key is released, or
//          after {@link NUDGE_IDLE_MS} without a keystroke if the release
//          never arrives (focus left the window). A held key is one step;
//          separate presses are separate steps.
//
//          The keyup listener is SESSION-SCOPED: bound when a burst starts and
//          removed when it commits (see app/src/core/lib/globalInputListeners.ts).

import { CommandRegistry } from "@api/commands";
import { registerKeybinding, isGridFocused } from "@api/keybindings";
import { getGridStateSnapshot } from "@api/grid";
import type { GridRegion } from "@api/gridOverlays";
import { clampMoveToPage, getLayoutSurface, type LayoutRect, type LayoutSurface } from "@api/layoutSurface";
import {
  commitObjectGeometry,
  previewObjectGeometry,
  type ObjectGeometryChange,
} from "@api/objectGeometry";
import { getSelectedObjectRegions, objectOwnsKey } from "@api/objectSelection";
import { boundsOf, isArrangeMovable, type PageSize } from "./arrange";

/** A nudge direction. */
export type NudgeDirection = "left" | "right" | "up" | "down";

/** The modifiers a nudge was pressed with. */
export interface NudgeModifiers {
  shift?: boolean;
  alt?: boolean;
}

/** Plain step without snap, px. */
export const NUDGE_STEP_PX = 1;
/** Shift step without snap, px. */
export const NUDGE_LARGE_STEP_PX = 10;
/** Commit a burst this long after the last keystroke when no key is held. */
export const NUDGE_IDLE_MS = 400;
/**
 * A key that is "held" but produced no keystroke for this long lost its
 * keyup (focus moved): the burst commits anyway.
 */
export const NUDGE_HELD_GRACE_MS = 1500;

/** The undo label of a nudge burst. */
export const NUDGE_UNDO_LABEL = "Nudge";

const ARROW_KEYS: ReadonlySet<string> = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

// ============================================================================
// Pure step math (exported for tests)
// ============================================================================

/** The next multiple of `g` strictly above `v` (or strictly below it when `down`). */
function nextMultiple(v: number, g: number, down: boolean): number {
  return down ? Math.ceil(v / g) * g - g : Math.floor(v / g) * g + g;
}

/**
 * The (dx, dy) of ONE nudge of a selection whose leading corner is `origin`
 * (its bounds' left/top), before the page clamp.
 */
export function nudgeDelta(
  direction: NudgeDirection,
  origin: { x: number; y: number },
  surface: Pick<LayoutSurface, "snapToGrid" | "gridSize"> | null,
  mods: NudgeModifiers = {},
): { dx: number; dy: number } {
  const horizontal = direction === "left" || direction === "right";
  const negative = direction === "left" || direction === "up";
  const snap = !!surface && surface.snapToGrid && !mods.alt && surface.gridSize > 0;
  let step: number;
  if (snap) {
    const at = horizontal ? origin.x : origin.y;
    step = nextMultiple(at, surface!.gridSize, negative) - at;
  } else {
    const size = mods.shift ? NUDGE_LARGE_STEP_PX : NUDGE_STEP_PX;
    step = negative ? -size : size;
  }
  return horizontal ? { dx: step, dy: 0 } : { dx: 0, dy: step };
}

/**
 * Clamp a group move so the group's BOUNDS stay on the page (the objects keep
 * their layout; the group stops at the edge as one). Returns the delta that
 * is actually possible.
 */
export function clampGroupDelta(
  rects: readonly LayoutRect[],
  delta: { dx: number; dy: number },
  page: PageSize,
): { dx: number; dy: number } {
  const b = boundsOf(rects);
  if (!b || !page) return { ...delta };
  const moved = clampMoveToPage({ ...b, x: b.x + delta.dx, y: b.y + delta.dy }, page);
  return { dx: moved.x - b.x, dy: moved.y - b.y };
}

// ============================================================================
// Guard
// ============================================================================

function activeSurface(): LayoutSurface | null {
  return getLayoutSurface(getGridStateSnapshot()?.sheetContext.activeSheetIndex ?? 0);
}

/**
 * Whether an arrow key nudges right now: on a canvas, grid focused, surface
 * editable, something selected, and no inner selection owns the arrows.
 */
export function nudgeApplies(): boolean {
  if (getGridStateSnapshot()?.surface !== "canvas") return false;
  if (!isGridFocused()) return false;
  const surface = activeSurface();
  if (!surface || !surface.editable) return false;
  if (getSelectedObjectRegions().length === 0) return false;
  return !objectOwnsKey("Arrow");
}

// ============================================================================
// The burst
// ============================================================================

interface BurstMember {
  region: GridRegion;
  from: LayoutRect;
}

interface Burst {
  members: BurstMember[];
  dx: number;
  dy: number;
  keyHeld: boolean;
  lastActivity: number;
  timer: ReturnType<typeof setTimeout> | null;
  detach: () => void;
}

let burst: Burst | null = null;

function memberRect(m: BurstMember, b: Burst): LayoutRect {
  return { ...m.from, x: m.from.x + b.dx, y: m.from.y + b.dy };
}

function changesOf(b: Burst): ObjectGeometryChange[] {
  return b.members.map((m) => ({ region: m.region, ...memberRect(m, b), from: m.from }));
}

function sameMembers(b: Burst, regions: readonly GridRegion[]): boolean {
  const ids = new Set(regions.map((r) => r.id));
  return b.members.length === ids.size && b.members.every((m) => ids.has(m.region.id));
}

function armTimer(b: Burst): void {
  if (b.timer !== null) clearTimeout(b.timer);
  b.timer = setTimeout(() => {
    b.timer = null;
    if (burst !== b) return;
    if (b.keyHeld && Date.now() - b.lastActivity < NUDGE_HELD_GRACE_MS) {
      armTimer(b);
      return;
    }
    void commitNudgeBurst();
  }, NUDGE_IDLE_MS);
}

function startBurst(members: BurstMember[]): Burst {
  const onKeyUp = (e: KeyboardEvent): void => {
    if (!ARROW_KEYS.has(e.key) || burst !== b) return;
    b.keyHeld = false;
    void commitNudgeBurst();
  };
  const b: Burst = {
    members,
    dx: 0,
    dy: 0,
    keyHeld: false,
    lastActivity: Date.now(),
    timer: null,
    detach: () => {
      window.removeEventListener("keyup", onKeyUp, true);
      if (b.timer !== null) clearTimeout(b.timer);
      b.timer = null;
    },
  };
  window.addEventListener("keyup", onKeyUp, true);
  burst = b;
  return b;
}

/** Whether a nudge burst is waiting to be committed (tests, diagnostics). */
export function hasPendingNudge(): boolean {
  return burst !== null;
}

/**
 * Commit the pending burst (if any) as ONE undo step. Resolves when it has
 * landed. Safe to call when nothing is pending.
 */
export async function commitNudgeBurst(): Promise<void> {
  const b = burst;
  if (!b) return;
  burst = null;
  b.detach();
  if (b.dx === 0 && b.dy === 0) return;
  await commitObjectGeometry(changesOf(b), NUDGE_UNDO_LABEL);
}

/**
 * One nudge keystroke: move the selection one step in `direction`, previewed;
 * the burst commits later. Returns the (dx, dy) actually applied by this
 * keystroke ({0,0} when nothing could move).
 */
export function nudgeSelection(direction: NudgeDirection, mods: NudgeModifiers = {}): { dx: number; dy: number } {
  const selected = getSelectedObjectRegions();
  const movable = selected.filter((r) => !!r.floating && isArrangeMovable(r));
  // A different selection is a different burst: land the old one first.
  if (burst && !sameMembers(burst, movable)) void commitNudgeBurst();
  if (movable.length === 0) return { dx: 0, dy: 0 };

  const b =
    burst ?? startBurst(movable.map((region) => ({ region, from: { ...region.floating! } })));
  const surface = activeSurface();
  const page = surface?.page ?? null;
  const rects = b.members.map((m) => memberRect(m, b));
  const origin = boundsOf(rects)!;
  const step = clampGroupDelta(rects, nudgeDelta(direction, origin, surface, mods), page);

  b.keyHeld = true;
  b.lastActivity = Date.now();
  armTimer(b);
  if (step.dx === 0 && step.dy === 0) return step;
  b.dx += step.dx;
  b.dy += step.dy;
  previewObjectGeometry(changesOf(b));
  return step;
}

// ============================================================================
// Commands and bindings
// ============================================================================

interface NudgeRow {
  direction: NudgeDirection;
  key: string;
  mods: NudgeModifiers;
  prefix: string;
  suffix: string;
  label: string;
}

const DIRECTIONS: ReadonlyArray<{ direction: NudgeDirection; key: string; name: string }> = [
  { direction: "left", key: "ArrowLeft", name: "Left" },
  { direction: "right", key: "ArrowRight", name: "Right" },
  { direction: "up", key: "ArrowUp", name: "Up" },
  { direction: "down", key: "ArrowDown", name: "Down" },
];

/** Every nudge row: plain, Shift (large step) and Alt (free, no snap), per direction. */
export const NUDGE_ROWS: readonly NudgeRow[] = DIRECTIONS.flatMap(({ direction, key, name }) => [
  { direction, key, mods: {}, prefix: "", suffix: "", label: `Nudge Objects ${name}` },
  { direction, key, mods: { shift: true }, prefix: "Shift+", suffix: "Large", label: `Nudge Objects ${name} (Large Step)` },
  { direction, key, mods: { alt: true }, prefix: "Alt+", suffix: "Free", label: `Nudge Objects ${name} (Ignore Grid)` },
]);

/** The command id of a row. */
export function nudgeCommandId(row: Pick<NudgeRow, "direction" | "suffix">): string {
  const dir = row.direction.charAt(0).toUpperCase() + row.direction.slice(1);
  return `canvasSheet.nudge${dir}${row.suffix}`;
}

/** Register the nudge commands and their guarded bindings; returns the cleanups. */
export function installCanvasObjectNudge(extensionId: string): Array<() => void> {
  const cleanups: Array<() => void> = [];
  for (const row of NUDGE_ROWS) {
    const commandId = nudgeCommandId(row);
    CommandRegistry.register(commandId, () => {
      nudgeSelection(row.direction, row.mods);
    });
    cleanups.push(() => CommandRegistry.unregister(commandId));
    cleanups.push(
      registerKeybinding(
        {
          id: `ext.${commandId}`,
          combo: `${row.prefix}${row.key}`,
          commandId,
          label: row.label,
          category: "Canvas",
          context: "not-editing",
          source: "extension",
          extensionId,
        },
        nudgeApplies,
      ),
    );
  }
  // A burst still open when the extension goes away lands rather than being
  // left previewed-but-unsaved.
  cleanups.push(() => void commitNudgeBurst());
  return cleanups;
}

/** Test hook: drop any pending burst WITHOUT committing it. */
export function resetCanvasObjectNudge(): void {
  if (burst) burst.detach();
  burst = null;
}
