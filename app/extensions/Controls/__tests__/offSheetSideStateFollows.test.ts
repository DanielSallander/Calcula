//! FILENAME: app/extensions/Controls/__tests__/offSheetSideStateFollows.test.ts
// PURPOSE: The id-keyed state a shape keeps beside the floating store -- its
//          html, canvas renderer, declared properties, container and script
//          badge -- follows an insert/delete on a sheet the user is NOT looking
//          at (round 7, NEW-offsheet-structural-frontend-only-state).
// CONTEXT: A control's id IS its anchor cell (`control-{sheet}-{row}-{col}`).
//          The backend re-keys a control that moves with its cells, and its
//          script's binding, on the off-sheet route too (structure.rs
//          `shift_controls`). The frontend re-keyed its side state only through
//          the floating store's `onRename`, which runs for the sheet on screen;
//          the store holds that sheet alone, while the side state of every
//          visited sheet's shapes survives the switch. So after
//          `api.insertRows(2, 3, "Log")` a scripted shape on Log came back
//          without its renderer, html or declared properties, and the state
//          stayed filed under the dead id. The announcement now carries its
//          edits and lib/controlSideState.ts replays them on the side state.
//          Real modules end to end: @api/lib's insert/delete wrappers (Core's
//          tauri-api: off-sheet branch, burst, payload), the real event bus, the
//          real follower and the real shape/properties/container stores, and the
//          real `getAllControls` through the extension's backend channel. Doubled:
//          Tauri's `invoke` and the channel's backend (a control store that
//          shifts as Rust's `shift_controls` does), and the paint primitives.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

interface Meta {
  controlType: string;
  properties: Record<string, { valueType: string; value: string }>;
}

const h = vi.hoisted(() => ({
  active: 0,
  /** "sheet:row:col" -> metadata: the backend's control store. */
  controls: new Map<string, { controlType: string; properties: Record<string, { valueType: string; value: string }> }>(),
  controlReads: [] as number[],
}));

/** Rust's `controls::moves_with_cells`: only the text "false" holds a control in place. */
function movesWithCells(meta: Meta): boolean {
  return meta.properties.pinToGrid?.value !== "false";
}

/** Rust's `shift_controls` on the edited sheet: moving controls follow their cells, deleted ones go. */
function shiftControls(cmd: string, args: Record<string, unknown>): void {
  const sheet = typeof args.sheetIndex === "number" ? args.sheetIndex : h.active;
  const count = args.count as number;
  const next = new Map<string, Meta>();
  for (const [key, meta] of h.controls) {
    const [s, r, c] = key.split(":").map(Number);
    if (s !== sheet || !movesWithCells(meta)) {
      next.set(key, meta);
      continue;
    }
    let row = r;
    let col = c;
    if (cmd === "insert_rows" && r >= (args.row as number)) row += count;
    if (cmd === "insert_columns" && c >= (args.col as number)) col += count;
    if (cmd === "delete_rows") {
      const at = args.row as number;
      if (r >= at && r < at + count) continue;
      if (r >= at + count) row -= count;
    }
    if (cmd === "delete_columns") {
      const at = args.col as number;
      if (c >= at && c < at + count) continue;
      if (c >= at + count) col -= count;
    }
    next.set(`${s}:${row}:${col}`, meta);
  }
  h.controls.clear();
  for (const [k, v] of next) h.controls.set(k, v);
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "get_active_sheet") return Promise.resolve(h.active);
    if (["insert_rows", "delete_rows", "insert_columns", "delete_columns"].includes(cmd)) {
      shiftControls(cmd, args ?? {});
    }
    return Promise.resolve([]);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));
// The shape renderer paints through these; nothing is painted here.
vi.mock("@api/gridOverlays", () => ({
  overlayGetRowHeaderWidth: () => 0,
  overlayGetColHeaderHeight: () => 0,
  overlaySheetToCanvas: (_c: unknown, x: number, y: number) => ({ canvasX: x, canvasY: y }),
  requestOverlayRedraw: () => undefined,
  replaceGridRegionsByType: () => undefined,
  removeGridRegionsByType: () => undefined,
  onPointModeViewChanged: () => () => undefined,
}));
vi.mock("@api", () => ({
  getShapeBitmap: () => null,
  hasShapeBitmapRenderer: () => false,
}));
vi.mock("@api/notifications", () => ({ showToast: () => undefined }));
vi.mock("../Button/floatingSelection", () => ({
  isFloatingControlSelected: () => false,
  getSelectedFloatingControls: () => [] as string[],
}));

import { insertRows, deleteRows, insertColumns } from "@api/lib";
import { controlsBackend } from "../lib/controlsBackend";
import { followStructuralEditsElsewhere } from "../lib/controlSideState";
import {
  getShapeHtmlContent,
  hasCustomCanvasRenderer,
  markShapeHasScript,
  releaseAllShapeHtmlOverlays,
  setCustomCanvasRenderer,
  setShapeHtmlContent,
  shapeHasScript,
  unmarkShapeHasScript,
} from "../Shape/shapeRenderer";
import { getDeclaredProperties, setDeclaredProperties, clearDeclaredProperties } from "../Shape/shapeProperties";
import { getControlContainerEntry, noteControlProperties, resetControlContainers } from "../lib/controlContainer";

/** The off-sheet announcement's burst window (core/lib/tauri-api.ts, STRUCTURAL_EDIT_ELSEWHERE_WINDOW_MS). */
const WINDOW_MS = 50;

const id = (s: number, r: number, c: number): string => `control-${s}-${r}-${c}`;

let unsubscribe: (() => void) | null = null;
let queue: Promise<void> = Promise.resolve();
let repaints = 0;

/** Seed a shape: in the backend, and with the side state a script and a paint leave behind. */
function seedShape(s: number, r: number, c: number, opts: { free?: boolean; html: string }): string {
  h.controls.set(`${s}:${r}:${c}`, {
    controlType: "shape",
    properties: { pinToGrid: { valueType: "static", value: opts.free ? "false" : "true" } },
  });
  const cid = id(s, r, c);
  setShapeHtmlContent(cid, opts.html);
  setCustomCanvasRenderer(cid, () => undefined);
  setDeclaredProperties(cid, [{ key: "label", label: opts.html, type: "text" }]);
  markShapeHasScript(cid);
  noteControlProperties(cid, "shape", { shapeType: "rectangle" });
  return cid;
}

/** Everything the side state says about one id. */
function stateAt(cid: string) {
  return {
    html: getShapeHtmlContent(cid),
    renderer: hasCustomCanvasRenderer(cid),
    declared: getDeclaredProperties(cid).map((p) => p.label),
    badge: shapeHasScript(cid),
    container: getControlContainerEntry(cid) !== undefined,
  };
}

function fullState(html: string) {
  return { html, renderer: true, declared: [html], badge: true, container: true };
}
const NOTHING = { html: undefined, renderer: false, declared: [], badge: false, container: false };

/** Let the announcement, the burst's trailing flush and the structural queue settle (the clock is fake). */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(WINDOW_MS + 1);
  await vi.advanceTimersByTimeAsync(WINDOW_MS + 1);
  await queue;
}

function forgetAll(): void {
  for (const k of h.controls.keys()) {
    const [s, r, c] = k.split(":").map(Number);
    clearDeclaredProperties(id(s, r, c));
    unmarkShapeHasScript(id(s, r, c));
  }
  releaseAllShapeHtmlOverlays();
  resetControlContainers();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  h.active = 0;
  h.controls.clear();
  h.controlReads.length = 0;
  repaints = 0;
  queue = Promise.resolve();
  controlsBackend.set(async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    if (cmd !== "get_all_controls") throw new Error(`unexpected backend call ${cmd}`);
    const sheet = args?.sheetIndex as number;
    h.controlReads.push(sheet);
    return [...h.controls.entries()]
      .map(([k, metadata]) => {
        const [sheetIndex, row, col] = k.split(":").map(Number);
        return { sheetIndex, row, col, metadata: JSON.parse(JSON.stringify(metadata)) };
      })
      .filter((e) => e.sheetIndex === sheet) as T;
  });
  // What Controls' activate installs (index.ts, 6c): the structural queue and
  // the repaint after a re-key.
  unsubscribe = followStructuralEditsElsewhere({
    enqueue: (task) => {
      queue = queue.then(task);
    },
    afterChange: () => {
      repaints++;
    },
  });
});

afterEach(async () => {
  await vi.runAllTimersAsync();
  unsubscribe?.();
  unsubscribe = null;
  forgetAll();
  h.controls.clear();
  vi.useRealTimers();
});

describe("a shape's side state follows an insert/delete on another sheet (round 7)", () => {
  // SABOTAGE: make followStructuralEditsElsewhere ignore the announced edits
  // (controlSideState.ts) -> the Log shape's state stays under control-1-5-2 and
  // this fails at "the shape's html, renderer, properties, container and badge
  // moved with it".
  it("api.insertRows(2, 3, 'Log') with Sheet1 on screen: a pinned shape's state moves to its new id; a free one's and Sheet1's stay", async () => {
    const pinned = seedShape(1, 5, 2, { html: "log" });
    const free = seedShape(1, 7, 2, { html: "free", free: true });
    const onScreen = seedShape(0, 5, 2, { html: "sheet1" });

    await insertRows(2, 3, 1);
    await settle();

    expect(h.controls.has("1:8:2"), "the backend moved the pinned shape").toBe(true);
    expect(stateAt(id(1, 8, 2)), "the shape's html, renderer, properties, container and badge moved with it").toEqual(
      fullState("log"),
    );
    expect(stateAt(pinned), "nothing is left under the dead id").toEqual(NOTHING);
    expect(stateAt(free), "a free shape holds its anchor, and so does its state").toEqual(fullState("free"));
    expect(stateAt(onScreen), "the sheet on screen was not edited").toEqual(fullState("sheet1"));
    expect(repaints).toBeGreaterThan(0);
  });

  // SABOTAGE: apply the renames in plain order in reanchorSideStateOnSheet
  // (call hooks.onRename for each rename directly, not through
  // applyRenamesVacatedFirst) -> r5 -> r6 lands on the lower shape's state
  // before it has moved, and one shape's html is destroyed.
  it("two pinned shapes one row apart, a row inserted above both: neither shape's state lands on the other's", async () => {
    seedShape(1, 5, 0, { html: "upper" });
    seedShape(1, 6, 0, { html: "lower" });

    await insertRows(0, 1, 1);
    await settle();

    expect(stateAt(id(1, 6, 0))).toEqual(fullState("upper"));
    expect(stateAt(id(1, 7, 0))).toEqual(fullState("lower"));
  });

  // SABOTAGE: drop unmarkShapeHasScript from CONTROL_SIDE_STATE_HOOKS.onRemove
  // (controlSideState.ts) -> the deleted row-0 shape's script badge stays and
  // this fails at "a shape whose row went leaves nothing behind".
  it("a delete on another sheet: a shape whose row went is released, and the shape pulled up onto its cell gets its own state", async () => {
    seedShape(1, 0, 0, { html: "gone" });
    seedShape(1, 1, 0, { html: "doomed" });
    seedShape(1, 3, 0, { html: "survivor" });

    await deleteRows(0, 2, 1); // rows 0-1 go, both shapes with them; row 3 -> 1
    await settle();

    expect(stateAt(id(1, 0, 0)), "a shape whose row went leaves nothing behind").toEqual(NOTHING);
    expect(stateAt(id(1, 1, 0)), "the survivor now holds row 1, with its OWN state").toEqual(fullState("survivor"));
    expect(stateAt(id(1, 3, 0))).toEqual(NOTHING);
  });

  it("a script loop of off-sheet inserts and an insert of columns: every edit of the burst is replayed", async () => {
    seedShape(1, 5, 1, { html: "log" });
    for (let i = 0; i < 6; i++) await insertRows(0, 1, 1);
    await insertColumns(0, 2, 1);
    await settle();
    expect(h.controls.has("1:11:3")).toBe(true);
    expect(stateAt(id(1, 11, 3))).toEqual(fullState("log"));
  });

  it("an edit on a sheet whose controls hold no side state asks the backend nothing", async () => {
    seedShape(0, 5, 0, { html: "sheet1" });
    await insertRows(0, 1, 2);
    await settle();
    expect(h.controlReads).toEqual([]);
    expect(repaints).toBe(0);
  });
});

describe("Controls' activate wires the follower and the shared migration (index.ts)", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../index.ts"), "utf8");

  it("installs followStructuralEditsElsewhere on the structural queue and registers its cleanup", () => {
    expect(src).toMatch(/cleanupFns\.push\(\s*followStructuralEditsElsewhere\(\{\s*enqueue: \(task\) => \{\s*structuralQueue = structuralQueue\.then\(task\)/);
  });

  it("re-anchors the sheet on screen with the same side-state migration and the grid's one anchor rule", () => {
    expect(src).toMatch(
      /reanchorFloatingControls\(\s*sheetIndex,\s*structuralAnchorShift\(kind, at, count\),\s*movesWithCells,\s*CONTROL_SIDE_STATE_HOOKS,\s*\)/,
    );
  });
});
