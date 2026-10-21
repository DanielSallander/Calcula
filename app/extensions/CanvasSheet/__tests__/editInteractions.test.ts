//! FILENAME: app/extensions/CanvasSheet/__tests__/editInteractions.test.ts
// PURPOSE: Edit interactions' rules (P4 S10): when the mode can be entered and
//          why not (one source-capable visual, a canvas, not subscribed); the
//          exits (toggle, sheet switch, File > New / Open, the source deleted);
//          the write -- ONE setCanvasLayout invoke per click, no undo
//          transaction opened on this side, nothing sent when nothing changes,
//          refused on a subscribed canvas; a pair equal to the default is
//          REMOVED from storage; the default rule equals @api/reportFilters'
//          interactionFor; and the store publishing every page's interactions
//          to the seam (and withdrawing a page that is gone).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { CanvasLayout, SheetInfo, SheetsResult } from "@api";

const h = vi.hoisted(() => ({
  getSheets: vi.fn(),
  setCanvasLayout: vi.fn(),
  provenance: vi.fn(async () => [] as Array<{ role: string; sheetId: string }>),
  selected: [] as Array<{ id: string; type: string }>,
  runInUndoTransaction: vi.fn(),
  alert: vi.fn(async () => {}),
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  getSheets: () => h.getSheets(),
  setCanvasLayout: (patch: unknown, index?: number) => h.setCanvasLayout(patch, index),
}));
vi.mock("@api/collaboration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/collaboration")>()),
  getSheetProvenance: () => h.provenance(),
}));
vi.mock("@api/dialogs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/dialogs")>()),
  alertAsync: (...a: unknown[]) => h.alert(...(a as [])),
}));
vi.mock("@api/objectGeometry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/objectGeometry")>()),
  runInUndoTransaction: (...a: unknown[]) => h.runInUndoTransaction(...a),
}));
vi.mock("@api/objectSelection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/objectSelection")>()),
  getSelectedObjectRegions: () => h.selected,
  objectRefOf: (r: { id: string; type: string }) => {
    const [kind, id] = r.id.split(":");
    return { kind, id };
  },
}));

import { AppEvents, emitAppEvent } from "@api";
import { defaultCanvasLayout } from "@api/canvasSheet";
import { registerModelVisualProvider, type ModelVisualInfo } from "@api/modelVisuals";
import { interactionFor, publishPageInteractions, type VisualRef } from "@api/reportFilters";
import { requestOverlayRedraw } from "@api/gridOverlays";
import {
  canvasBySheetId,
  pageInteractionsOf,
  refreshCanvasProvenance,
  refreshCanvasSheets,
  resetCanvasSheetStore,
} from "../lib/canvasSheetStore";
import {
  NOT_A_CANVAS_NOTE,
  SELECT_ONE_VISUAL_NOTE,
  defaultInteractionMode,
  editInteractionsAvailability,
  enterEditInteractions,
  exitEditInteractions,
  getEditInteractionsState,
  installEditInteractions,
  nextInteractions,
  setInteraction,
  toggleEditInteractions,
} from "../lib/editInteractions";
import { SUBSCRIBED_NOTE } from "../lib/canvasNotes";

const PAGE = "cv-1";
const bar: VisualRef = { kind: "chart", id: "bar" };
const card: VisualRef = { kind: "chart", id: "card" };
const slicer: VisualRef = { kind: "slicer", id: "s1" };

function info(ref: VisualRef, over: Partial<ModelVisualInfo["role"]> = {}, connectionId = "c1"): ModelVisualInfo {
  return {
    ref,
    name: ref.id,
    sheetIndex: 1,
    sheetId: PAGE,
    connectionId,
    role: { source: true, target: true, canHighlight: true, reason: null, ...over },
    label: "Column chart",
  };
}

let visuals: ModelVisualInfo[] = [];

function layout(over: Partial<CanvasLayout> = {}): CanvasLayout {
  return { ...defaultCanvasLayout(), ...over };
}

function sheets(activeIndex: number, canvasLayout: CanvasLayout = layout(), extra: SheetInfo[] = []): SheetsResult {
  return {
    activeIndex,
    sheets: [
      { index: 0, name: "Data", visibility: "visible", sheetId: "ws-0" },
      { index: 1, name: "Dashboard", visibility: "visible", sheetId: PAGE, kind: "canvas", canvasLayout },
      ...extra,
    ],
  };
}

function select(...refs: VisualRef[]): void {
  h.selected = refs.map((r) => ({ id: `${r.kind}:${r.id}`, type: r.kind }));
}

let offProvider: () => void = () => {};
let cleanups: Array<() => void> = [];

beforeEach(async () => {
  h.setCanvasLayout.mockReset();
  h.runInUndoTransaction.mockReset();
  h.alert.mockClear();
  h.provenance.mockResolvedValue([]);
  visuals = [info(bar), info(card, { source: false, canHighlight: false, reason: "This visual does not filter others" })];
  offProvider = registerModelVisualProvider({ kind: "chart", list: () => visuals });
  h.getSheets.mockResolvedValue(sheets(1));
  await refreshCanvasSheets();
  await refreshCanvasProvenance();
  select(bar);
});

afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
  exitEditInteractions();
  offProvider();
  resetCanvasSheetStore();
});

describe("the default rule", () => {
  it("equals interactionFor for every source kind, defaultMode and highlight capability", () => {
    for (const defaultMode of [undefined, "filter", "highlight"] as const) {
      publishPageInteractions("rule-page", { defaultMode, pairs: [] });
      for (const source of [bar, slicer]) {
        for (const canHighlight of [true, false]) {
          expect(defaultInteractionMode(defaultMode, source.kind === "slicer", canHighlight)).toBe(
            interactionFor("rule-page", source, { ref: card, canHighlight }, source.kind === "slicer"),
          );
        }
      }
    }
    publishPageInteractions("rule-page", null);
  });
});

describe("nextInteractions: storage holds only what differs from the default", () => {
  it("a pair set to its default is REMOVED", () => {
    const current = { pairs: [{ source: bar, target: card, mode: "none" as const }] };
    // card cannot highlight: its default from a visual source is filter.
    expect(nextInteractions(current, bar, card, "filter", false)).toEqual({ pairs: [] });
  });

  it("a mode that differs from the default is stored, replacing the old pair", () => {
    const current = { pairs: [{ source: bar, target: card, mode: "none" as const }] };
    const other = { kind: "chart" as const, id: "other" };
    expect(nextInteractions({ pairs: [...current.pairs, { source: bar, target: other, mode: "none" as const }] }, bar, card, "filter", true)).toEqual({
      pairs: [
        { source: bar, target: other, mode: "none" },
        { source: bar, target: card, mode: "filter" },
      ],
    });
  });

  it("keeps the page's defaultMode and measures the default against it", () => {
    const next = nextInteractions({ defaultMode: "filter", pairs: [] }, bar, card, "filter", true);
    expect(next).toEqual({ defaultMode: "filter", pairs: [] });
    expect(nextInteractions({ defaultMode: "filter", pairs: [] }, bar, card, "highlight", true).pairs).toHaveLength(1);
  });

  it("a slicer source defaults to filter", () => {
    expect(nextInteractions(undefined, slicer, bar, "filter", true)).toEqual({ pairs: [] });
    expect(nextInteractions(undefined, slicer, bar, "none", true).pairs).toEqual([{ source: slicer, target: bar, mode: "none" }]);
  });
});

describe("entering the mode", () => {
  it("enters with exactly one source-capable visual selected", () => {
    expect(editInteractionsAvailability()).toEqual({ ok: true, reason: null, source: bar });
    expect(enterEditInteractions()).toBe(true);
    expect(getEditInteractionsState()).toEqual({ active: true, source: bar });
  });

  it("refuses with nothing or two things selected", () => {
    select();
    expect(editInteractionsAvailability().reason).toBe(SELECT_ONE_VISUAL_NOTE);
    select(bar, card);
    expect(editInteractionsAvailability().reason).toBe(SELECT_ONE_VISUAL_NOTE);
    expect(enterEditInteractions()).toBe(false);
    expect(getEditInteractionsState().active).toBe(false);
  });

  it("refuses a visual that is not a source, with its family's reason", () => {
    select(card);
    expect(editInteractionsAvailability()).toEqual({ ok: false, reason: "This visual does not filter others", source: null });
  });

  it("refuses off a canvas", async () => {
    h.getSheets.mockResolvedValue(sheets(0));
    await refreshCanvasSheets();
    expect(editInteractionsAvailability().reason).toBe(NOT_A_CANVAS_NOTE);
  });

  it("refuses on a subscribed canvas, with the one note", async () => {
    h.provenance.mockResolvedValue([{ role: "subscribed", sheetId: PAGE }]);
    await refreshCanvasProvenance();
    expect(editInteractionsAvailability()).toEqual({ ok: false, reason: SUBSCRIBED_NOTE, source: null });
  });
});

describe("leaving the mode", () => {
  beforeEach(() => {
    cleanups = installEditInteractions();
    expect(enterEditInteractions()).toBe(true);
  });

  it("the toggle turns it off", () => {
    expect(toggleEditInteractions()).toBe(false);
    expect(getEditInteractionsState().active).toBe(false);
  });

  it("a sheet switch ends it", async () => {
    h.getSheets.mockResolvedValue(sheets(0));
    await refreshCanvasSheets();
    expect(getEditInteractionsState().active).toBe(false);
  });

  it.each([AppEvents.AFTER_NEW, AppEvents.AFTER_OPEN])("%s ends it", (event) => {
    emitAppEvent(event);
    expect(getEditInteractionsState().active).toBe(false);
  });

  it("the source's deletion ends it", () => {
    visuals = visuals.filter((v) => v.ref.id !== "bar");
    requestOverlayRedraw();
    expect(getEditInteractionsState().active).toBe(false);
  });

  it("an unrelated region change keeps it", () => {
    requestOverlayRedraw();
    expect(getEditInteractionsState()).toEqual({ active: true, source: bar });
  });
});

describe("setInteraction", () => {
  it("is ONE setCanvasLayout invoke per click, and opens no undo transaction", async () => {
    h.setCanvasLayout.mockImplementation(async (patch: { interactions: CanvasLayout["interactions"] }) =>
      layout({ interactions: patch.interactions }),
    );
    expect(await setInteraction(PAGE, bar, card, "none")).toBe(true);
    expect(h.setCanvasLayout).toHaveBeenCalledTimes(1);
    expect(h.setCanvasLayout).toHaveBeenCalledWith({ interactions: { pairs: [{ source: bar, target: card, mode: "none" }] } }, 1);
    expect(h.runInUndoTransaction).not.toHaveBeenCalled();
    // The store holds (and published) the stored answer at once.
    expect(canvasBySheetId(PAGE)?.layout.interactions?.pairs).toEqual([{ source: bar, target: card, mode: "none" }]);
    expect(interactionFor(PAGE, bar, { ref: card, canHighlight: false }, false)).toBe("none");
  });

  it("removes the pair from storage when the click picks the default", async () => {
    h.getSheets.mockResolvedValue(sheets(1, layout({ interactions: { pairs: [{ source: bar, target: card, mode: "none" }] } })));
    await refreshCanvasSheets();
    h.setCanvasLayout.mockImplementation(async (patch: { interactions: CanvasLayout["interactions"] }) =>
      layout({ interactions: patch.interactions }),
    );
    expect(await setInteraction(PAGE, bar, card, "filter")).toBe(true);
    expect(h.setCanvasLayout).toHaveBeenCalledWith({ interactions: { pairs: [] } }, 1);
  });

  it("sends nothing when the click changes nothing", async () => {
    expect(await setInteraction(PAGE, bar, card, "filter")).toBe(false);
    expect(h.setCanvasLayout).not.toHaveBeenCalled();
  });

  it("refuses a highlight the target cannot paint, and a pair from a visual to itself", async () => {
    expect(await setInteraction(PAGE, bar, card, "highlight")).toBe(false);
    expect(await setInteraction(PAGE, bar, bar, "none")).toBe(false);
    expect(h.setCanvasLayout).not.toHaveBeenCalled();
  });

  it("refuses on a subscribed canvas without invoking", async () => {
    h.provenance.mockResolvedValue([{ role: "subscribed", sheetId: PAGE }]);
    await refreshCanvasProvenance();
    expect(await setInteraction(PAGE, bar, card, "none")).toBe(false);
    expect(h.setCanvasLayout).not.toHaveBeenCalled();
  });

  it("tells the user a backend refusal", async () => {
    h.setCanvasLayout.mockRejectedValue("Canvas interactions: no such object");
    expect(await setInteraction(PAGE, bar, card, "none")).toBe(false);
    expect(h.alert).toHaveBeenCalledTimes(1);
  });

  it("never names an undo transaction (Rust makes the click one step, DC-9)", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../lib/editInteractions.ts"), "utf8");
    const code = src.replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/runInUndoTransaction|beginUndoTransaction|begin_undo_savepoint/);
  });
});

describe("the store publishes each page's interactions", () => {
  it("publishes on refresh and withdraws a page that is no longer a canvas", async () => {
    h.getSheets.mockResolvedValue(sheets(1, layout({ interactions: { pairs: [{ source: bar, target: card, mode: "none" }] } })));
    await refreshCanvasSheets();
    expect(interactionFor(PAGE, bar, { ref: card, canHighlight: true }, false)).toBe("none");
    h.getSheets.mockResolvedValue({ activeIndex: 0, sheets: [{ index: 0, name: "Data", visibility: "visible", sheetId: "ws-0" }] });
    await refreshCanvasSheets();
    expect(interactionFor(PAGE, bar, { ref: card, canHighlight: true }, false)).toBe("highlight");
  });

  it("maps a layout's interactions to the seam's shape (null at the default)", () => {
    expect(pageInteractionsOf(layout())).toBeNull();
    expect(pageInteractionsOf(layout({ interactions: { pairs: [] } }))).toBeNull();
    expect(pageInteractionsOf(layout({ interactions: { defaultMode: "filter" } }))).toEqual({ defaultMode: "filter", pairs: [] });
  });
});
