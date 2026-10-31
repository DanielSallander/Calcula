//! FILENAME: app/extensions/Controls/__tests__/shapeScriptBadgeUndo.test.ts
// PURPOSE: A shape's script badge follows the UNDO of a structural edit
//          (BUG-0615#5).
// CONTEXT: A row delete releases a scripted shape's side state, its badge
//          included (`CONTROL_SIDE_STATE_HOOKS.onRemove`), and a row insert
//          re-keys it to the shape's new anchor (`onRename`) -- in step with the
//          backend, which moves the script's binding with the control. Undoing
//          either edit moves the control AND its script binding back in the
//          backend, but announces only STRUCTURAL_UNDO, with no coordinates; the
//          extension reloaded its controls and left the badge set as the edit
//          had made it. The restored shape came back without its badge. The
//          handler now re-reads the backend's scripted shapes
//          (lib/shapeScriptBadges.ts).
//          Real side-state hooks and the real shape renderer's badge set;
//          doubled: the backend's object-script list and the paint primitives.

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

const h = vi.hoisted(() => ({
  /** The backend's object scripts: `{ objectType, instanceId }`. */
  scripts: [] as Array<{ objectType: string; instanceId: string | null }>,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(), listen: vi.fn(async () => () => {}) }));
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
  listObjectScripts: () => Promise.resolve(h.scripts.map((s) => ({ ...s }))),
}));
vi.mock("@api/notifications", () => ({ showToast: () => undefined }));
vi.mock("../Button/floatingSelection", () => ({
  isFloatingControlSelected: () => false,
  getSelectedFloatingControls: () => [] as string[],
}));

import { CONTROL_SIDE_STATE_HOOKS, reanchorSideStateOnSheet } from "../lib/controlSideState";
import { resyncShapeScriptBadges, scriptedShapeIds } from "../lib/shapeScriptBadges";
import { markShapeHasScript, replaceShapeScriptMarks, shapeHasScript } from "../Shape/shapeRenderer";

const id = (s: number, r: number, c: number): string => `control-${s}-${r}-${c}`;

/** The anchor map of a row insert of `count` at `at` / a row delete. */
const insertRowsShift = (at: number, count: number) => (row: number, col: number) =>
  row >= at ? { row: row + count, col } : { row, col };
const deleteRowsShift = (at: number, count: number) => (row: number, col: number) =>
  row >= at && row < at + count ? null : row >= at + count ? { row: row - count, col } : { row, col };

beforeEach(() => {
  replaceShapeScriptMarks([]);
  h.scripts = [];
});

describe("a shape's script badge follows a structural undo", () => {
  it("an undone row delete gives the restored shape its badge back", async () => {
    h.scripts = [{ objectType: "shape", instanceId: id(0, 5, 1) }];
    markShapeHasScript(id(0, 5, 1));

    // Delete row 6 (0-based 5): the shape and its script binding go.
    reanchorSideStateOnSheet(0, deleteRowsShift(5, 1), () => false, CONTROL_SIDE_STATE_HOOKS);
    h.scripts = [];
    expect(shapeHasScript(id(0, 5, 1))).toBe(false);

    // Undo: the backend restores the control and its script.
    h.scripts = [{ objectType: "shape", instanceId: id(0, 5, 1) }];
    expect(await resyncShapeScriptBadges()).toBe(true);
    expect(shapeHasScript(id(0, 5, 1))).toBe(true);
  });

  it("an undone row insert moves the badge back to the shape's old anchor", async () => {
    h.scripts = [{ objectType: "shape", instanceId: id(0, 5, 1) }];
    markShapeHasScript(id(0, 5, 1));

    reanchorSideStateOnSheet(0, insertRowsShift(2, 3), () => false, CONTROL_SIDE_STATE_HOOKS);
    h.scripts = [{ objectType: "shape", instanceId: id(0, 8, 1) }];
    expect(shapeHasScript(id(0, 8, 1))).toBe(true);

    h.scripts = [{ objectType: "shape", instanceId: id(0, 5, 1) }];
    await resyncShapeScriptBadges();
    expect(shapeHasScript(id(0, 5, 1))).toBe(true);
    expect(shapeHasScript(id(0, 8, 1))).toBe(false);
  });

  it("badges only on-grid shapes, and a failed read changes nothing", async () => {
    expect(
      scriptedShapeIds([
        { objectType: "shape", instanceId: id(1, 2, 3) },
        { objectType: "shape", instanceId: "pane-1234-abcd" },
        { objectType: "chart", instanceId: id(0, 0, 0) },
        { objectType: "shape", instanceId: null },
      ]),
    ).toEqual([id(1, 2, 3)]);

    markShapeHasScript(id(0, 1, 1));
    expect(await resyncShapeScriptBadges(() => Promise.reject(new Error("no backend")))).toBe(false);
    expect(shapeHasScript(id(0, 1, 1))).toBe(true);
  });

  it("the structural-undo and backend-change reloads re-read the badges", () => {
    // The extension's activate() wiring is not run here (it needs the whole
    // shell); pin that both reload handlers call the resync.
    const src = fs.readFileSync(path.resolve(__dirname, "../index.ts"), "utf8");
    const undoHandler = src.slice(src.indexOf("AppEvents.STRUCTURAL_UNDO, () =>"));
    expect(undoHandler.slice(0, undoHandler.indexOf("Structural-undo reload failed"))).toContain(
      "await resyncShapeScriptBadges()",
    );
    const backendReload = src.slice(src.indexOf("const reloadForBackendChange = ()"));
    expect(backendReload.slice(0, backendReload.indexOf("Backend-change reload failed"))).toContain(
      "await resyncShapeScriptBadges()",
    );
  });
});
