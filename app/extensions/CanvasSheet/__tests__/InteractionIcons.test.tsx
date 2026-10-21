//! FILENAME: app/extensions/CanvasSheet/__tests__/InteractionIcons.test.tsx
// PURPOSE: Edit interactions' on-page strips (P4 S10), from the model to the
//          rendered DOM: Filter / Highlight / None on every OTHER visual,
//          Highlight omitted where the visual cannot paint one (a card), ONE
//          disabled None with the reason for a range chart and for a visual on
//          another model, the current mode aria-pressed and bold, the strip at
//          the top-right of the content rect (scroll and zoom applied), the
//          source outlined, the pointer claim on every strip, and NOTHING shown
//          while a reference pick or an in-place text edit is live.
// CONTEXT: @testing-library/react is not installed; react-dom + `act`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CanvasLayout, SheetsResult } from "@api";

const h = vi.hoisted(() => ({
  getSheets: vi.fn(),
  picking: false,
  textEditing: false,
  geo: { rowHeaderWidth: 0, colHeaderHeight: 0, scrollX: 0, scrollY: 0 },
  zoom: 1,
  selected: [] as Array<{ id: string; type: string }>,
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  getSheets: () => h.getSheets(),
}));
vi.mock("@api/collaboration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/collaboration")>()),
  getSheetProvenance: async () => [],
}));
vi.mock("@api/editing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/editing")>()),
  isFormulaReferencePickActive: () => h.picking,
}));
vi.mock("@api/overlayTextEditor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/overlayTextEditor")>()),
  isOverlayTextEditorOpen: () => h.textEditing,
}));
vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/gridOverlays")>()),
  currentFloatingHitGeometry: () => h.geo,
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({ zoom: h.zoom }),
}));
vi.mock("@api/objectSelection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/objectSelection")>()),
  getSelectedObjectRegions: () => h.selected,
  objectRefOf: (r: { id: string }) => {
    const [kind, id] = r.id.split(":");
    return { kind, id };
  },
}));

import type { GridRegion } from "@api/gridOverlays";
import { POINTER_CLAIM_ATTR } from "@api/pointerClaims";
import { defaultCanvasLayout } from "@api/canvasSheet";
import { registerModelVisualProvider, type ModelVisualInfo } from "@api/modelVisuals";
import { publishPageInteractions, type VisualRef } from "@api/reportFilters";
import { refreshCanvasSheets, resetCanvasSheetStore } from "../lib/canvasSheetStore";
import { enterEditInteractions, exitEditInteractions } from "../lib/editInteractions";
import {
  NOT_A_MODEL_VISUAL_REASON,
  OTHER_MODEL_REASON,
  buildInteractionOverlayModel,
  type InteractionOverlayModel,
} from "../lib/interactionOverlay";
import { InteractionIcons } from "../components/InteractionIcons";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const PAGE = "cv-1";
const ref = (id: string, kind: VisualRef["kind"] = "chart"): VisualRef => ({ kind, id });

function info(r: VisualRef, role: Partial<ModelVisualInfo["role"]> = {}, connectionId: string | null = "c1"): ModelVisualInfo {
  return {
    ref: r,
    name: r.id,
    sheetIndex: 1,
    sheetId: PAGE,
    connectionId,
    role: { source: true, target: true, canHighlight: true, reason: null, ...role },
    label: "Column chart",
  };
}

const VISUALS: ModelVisualInfo[] = [
  info(ref("bar")),
  info(ref("line")),
  info(ref("card"), { source: false, canHighlight: false, reason: "This visual does not filter others" }),
  info(ref("range"), { source: false, target: false, canHighlight: false, reason: "Reads cells, not the model" }, null),
  info(ref("other"), {}, "c2"),
];

function region(id: string, x: number, y: number, w = 200, hgt = 100): GridRegion {
  return {
    id: `chart:${id}`,
    type: "chart",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x, y, width: w, height: hgt },
  } as GridRegion;
}

const REGIONS: GridRegion[] = [
  region("bar", 0, 0),
  region("line", 300, 0),
  region("card", 0, 200),
  region("range", 300, 200),
  region("other", 600, 0),
  // A pivot no family lists yet.
  { ...region("p1", 600, 200), id: "pivot:p1", type: "pivot" } as GridRegion,
];

function sheets(): SheetsResult {
  const canvasLayout: CanvasLayout = defaultCanvasLayout();
  return {
    activeIndex: 1,
    sheets: [
      { index: 0, name: "Data", visibility: "visible", sheetId: "ws-0" },
      { index: 1, name: "Dashboard", visibility: "visible", sheetId: PAGE, kind: "canvas", canvasLayout },
    ],
  };
}

let offProvider: () => void = () => {};
let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  h.picking = false;
  h.textEditing = false;
  h.geo = { rowHeaderWidth: 0, colHeaderHeight: 0, scrollX: 0, scrollY: 0 };
  h.zoom = 1;
  offProvider = registerModelVisualProvider({ kind: "chart", list: () => VISUALS });
  h.getSheets.mockResolvedValue(sheets());
  await refreshCanvasSheets();
  h.selected = [{ id: "chart:bar", type: "chart" }];
  expect(enterEditInteractions()).toBe(true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  exitEditInteractions();
  publishPageInteractions(PAGE, null);
  offProvider();
  resetCanvasSheetStore();
});

function model(): InteractionOverlayModel {
  const m = buildInteractionOverlayModel(REGIONS);
  if (!m) throw new Error("no model");
  return m;
}

function strip(m: InteractionOverlayModel, id: string) {
  const s = m.strips.find((x) => x.target.id === id);
  if (!s) throw new Error(`no strip for ${id}`);
  return s;
}

function render(m: InteractionOverlayModel | null, onPick = vi.fn()): typeof onPick {
  act(() => root.render(<InteractionIcons model={m} onPick={onPick} />));
  return onPick;
}

const byTestId = (id: string): HTMLButtonElement => {
  const el = container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no ${id}`);
  return el;
};

describe("the strips", () => {
  it("one strip per OTHER visual; the source is outlined instead", () => {
    const m = model();
    expect(m.strips.map((s) => s.target.id)).toEqual(["line", "card", "range", "other", "p1"]);
    expect(m.sourceOutline).toEqual({ left: 0, top: 0, width: 200, height: 100 });
    render(m);
    expect(container.querySelector('[data-testid="canvas-interaction-source-outline"]')).not.toBeNull();
  });

  it("offers Filter, Highlight and None on a visual that can highlight", () => {
    expect(strip(model(), "line").buttons.map((b) => b.mode)).toEqual(["filter", "highlight", "none"]);
  });

  it("omits Highlight for a card", () => {
    const s = strip(model(), "card");
    expect(s.buttons.map((b) => b.mode)).toEqual(["filter", "none"]);
    render(model());
    expect(container.querySelector('[data-testid="canvas-interaction-chart-card-highlight"]')).toBeNull();
    expect(byTestId("canvas-interaction-chart-card-filter").getAttribute("aria-pressed")).toBe("true");
  });

  it("a range chart shows ONE disabled None whose title is its reason", () => {
    render(model());
    const none = byTestId("canvas-interaction-chart-range-none");
    expect(none.disabled).toBe(true);
    expect(none.title).toBe("Reads cells, not the model");
    expect(container.querySelector('[data-testid="canvas-interaction-chart-range-filter"]')).toBeNull();
  });

  it("a visual on another model shows a disabled None: Uses another model", () => {
    render(model());
    const none = byTestId("canvas-interaction-chart-other-none");
    expect(none.disabled).toBe(true);
    expect(none.title).toBe(OTHER_MODEL_REASON);
  });

  it("a visual no family lists shows a disabled None too", () => {
    render(model());
    expect(byTestId("canvas-interaction-pivot-p1-none").title).toBe(NOT_A_MODEL_VISUAL_REASON);
  });

  it("the current mode is aria-pressed and bold, and follows the page's pairs", () => {
    render(model());
    const highlight = byTestId("canvas-interaction-chart-line-highlight");
    expect(highlight.getAttribute("aria-pressed")).toBe("true");
    expect(highlight.style.fontWeight).toBe("700");
    expect(byTestId("canvas-interaction-chart-line-none").getAttribute("aria-pressed")).toBe("false");

    publishPageInteractions(PAGE, { pairs: [{ source: ref("bar"), target: ref("line"), mode: "none" }] });
    render(model());
    expect(byTestId("canvas-interaction-chart-line-none").getAttribute("aria-pressed")).toBe("true");
    expect(byTestId("canvas-interaction-chart-line-highlight").getAttribute("aria-pressed")).toBe("false");
  });

  it("a click picks the mode for that target; the pressed one does nothing", () => {
    const onPick = render(model());
    act(() => byTestId("canvas-interaction-chart-line-none").click());
    expect(onPick).toHaveBeenCalledWith(PAGE, ref("bar"), ref("line"), "none");
    onPick.mockClear();
    act(() => byTestId("canvas-interaction-chart-line-highlight").click());
    expect(onPick).not.toHaveBeenCalled();
  });

  it("every strip carries the pointer claim", () => {
    render(model());
    const strips = container.querySelectorAll('[role="toolbar"]');
    expect(strips.length).toBe(5);
    for (const s of Array.from(strips)) expect(s.hasAttribute(POINTER_CLAIM_ATTR)).toBe(true);
  });

  it("sits at the top-right of the content rect, with scroll and zoom applied", () => {
    h.geo = { rowHeaderWidth: 0, colHeaderHeight: 0, scrollX: 100, scrollY: 50 };
    h.zoom = 2;
    const s = strip(model(), "line");
    // content = outer (no container): x 300..500, y 0; canvas x = 300 - 100, y = 0 - 50; x zoom 2.
    expect(s.right).toBe((500 - 100) * 2);
    expect(s.top).toBe((0 - 50) * 2);
  });
});

describe("hidden while something else owns the page", () => {
  it("shows nothing during a reference pick", () => {
    h.picking = true;
    expect(buildInteractionOverlayModel(REGIONS)).toBeNull();
    render(buildInteractionOverlayModel(REGIONS));
    expect(container.innerHTML).toBe("");
  });

  it("shows nothing while an in-place text editor is open", () => {
    h.textEditing = true;
    expect(buildInteractionOverlayModel(REGIONS)).toBeNull();
  });

  it("shows nothing once the mode is off", () => {
    exitEditInteractions();
    expect(buildInteractionOverlayModel(REGIONS)).toBeNull();
  });
});

describe("the overlay's lifetime", () => {
  it("mounts in the grid's canvas layer while the mode is on, and is gone when it ends", async () => {
    const { installInteractionOverlay, INTERACTION_OVERLAY_ATTR } = await import("../lib/interactionOverlay");
    const layer = document.createElement("div");
    layer.setAttribute("data-grid-canvas-layer", "");
    document.body.appendChild(layer);
    exitEditInteractions();
    const cleanups = installInteractionOverlay();
    try {
      act(() => {
        expect(enterEditInteractions()).toBe(true);
      });
      const host = layer.querySelector(`[${INTERACTION_OVERLAY_ATTR}]`);
      expect(host).not.toBeNull();
      act(() => exitEditInteractions());
      expect(layer.querySelector(`[${INTERACTION_OVERLAY_ATTR}]`)).toBeNull();
    } finally {
      act(() => {
        for (const c of cleanups) c();
      });
      layer.remove();
    }
  });
});
