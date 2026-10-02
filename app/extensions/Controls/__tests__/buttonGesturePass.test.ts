//! FILENAME: app/extensions/Controls/__tests__/buttonGesturePass.test.ts
// PURPOSE: Owner decision B (2026-09-30), follow-up F1, at the FLOATING
//          button: "an APPROVED application macro that the user runs
//          EXPLICITLY (button click, ...) gets the same CELL access in either
//          runtime". What proves the click is a PERSON's is the one-time
//          explicit-run pass, and it is minted in the pointer GESTURE itself --
//          the release inside a button a press armed (index.ts
//          `handleButtonPress` -> lib/buttonPress.ts) -- and handed down to the
//          macro link the Rust door answers `link` for:
//            - a press + a release inside runs the held link with a pass for
//              exactly its macro (door "button"), beside the `buttonControl`
//              trigger the host requires and Rust verifies;
//            - each click mints its own pass, usable once;
//            - sliding off, Design Mode and a press with no release mint
//              nothing and run nothing.
// CONTEXT: The real activate() through the ModelMenu lifecycle harness
//          (buttonRunOnRelease.test.ts's precedent) with the real window events
//          Core dispatches for a CONTENT press. Doubled: the Tauri boundary (the
//          door answers `link`; the context channel serves the control's
//          metadata) and the macro-run provider, which records what it was
//          handed. The census that only Core's pointer raises this press is in
//          src/api/__tests__/explicitMacroRun.test.ts.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { loadHarness, settle, type Loader } from "../../ModelMenu/__tests__/lifecycleHarness";

const h = vi.hoisted(() => ({
  backendCalls: [] as string[],
}));

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  listenForEvent: vi.fn(async () => () => {}),
  listenTauriEvent: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async (cmd: string) => {
    h.backendCalls.push(cmd);
    if (cmd === "get_active_sheet") return 0;
    if (cmd === "get_all_styles") return [];
    // The Rust button door: this button links a macro.
    if (cmd === "run_control_action") return { kind: "link" };
    return null;
  }),
}));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => {}),
}));
vi.mock("../../../src/core/state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/state/GridContext")>()),
  getGridStateSnapshot: () => ({
    surface: "grid",
    zoom: 1,
    displayHeadings: true,
    config: { rowHeaderWidth: 50, colHeaderHeight: 24, defaultCellWidth: 100, defaultCellHeight: 24 },
    viewport: { scrollX: 0, scrollY: 0 },
    sheetContext: { activeSheetIndex: 0 },
    dimensions: { columnWidths: new Map(), rowHeights: new Map() },
  }),
}));

import type { MacroRunOptions } from "@api/macroRunService";

const CONTROLS: Loader = () => import("..");

const ANCHOR = { sheetIndex: 0, row: 2, col: 1 };
const BUTTON = `control-0-${ANCHOR.row}-${ANCHOR.col}`;
/** The button in sheet px; on the canvas it sits at (50 + x, 24 + y). */
const B = { x: 64, y: 64, width: 160, height: 40 };
const INSIDE = { x: 50 + B.x + 80, y: 24 + B.y + 20 };
const OFF = { x: INSIDE.x, y: INSIDE.y + 60 };
const STAMP = JSON.stringify({ workspace: "ws", application: "Sales", version: "1.0.0" });

const s = (v: number | string) => ({ valueType: "static" as const, value: String(v) });
/** An application's button: its link to the application's macro HELD and stamped. */
const PROPERTIES = {
  embedded: s("false"),
  x: s(B.x),
  y: s(B.y),
  width: s(B.width),
  height: s(B.height),
  text: s("Run report"),
  heldMacroRef: s("macro-report"),
  heldFrom: s(STAMP),
};

async function invokeBackend(command: string): Promise<unknown> {
  h.backendCalls.push(command);
  if (command === "get_all_controls") {
    return [{ ...ANCHOR, metadata: { controlType: "button", properties: PROPERTIES } }];
  }
  if (command === "get_control_metadata") return { controlType: "button", properties: PROPERTIES };
  return null;
}

let ext: Awaited<ReturnType<typeof loadHarness>>["ext"];
let overlays: typeof import("@api/gridOverlays");
let designMode: typeof import("../lib/designMode");
let area: HTMLElement;
let runs: { macroId: string; options?: MacroRunOptions }[] = [];
let unregister: () => void = () => undefined;
/**
 * The pass module AS CONTROLS LOADED IT: the harness resets the module graph, and
 * a pass is recognised by identity in ONE module instance's private WeakMap.
 */
let claimExplicitMacroRun: typeof import("@api/explicitMacroRun").claimExplicitMacroRun;

function regionOf(id: string) {
  const r = overlays.getGridRegions().find((g) => g.id === id);
  if (!r) throw new Error(`no region ${id}`);
  return r;
}

function fire(name: string, detail: Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

/** Core's CONTENT press on the run-mode button, as pressZone dispatches it. */
function corePress(at = INSIDE): void {
  const r = regionOf(BUTTON);
  const zone = overlays.resolveFloatingZone({ region: r, canvasX: at.x, canvasY: at.y, row: 0, col: 0 } as never);
  const press = { regionId: r.id, regionType: r.type, data: r.data, canvasX: at.x, canvasY: at.y, ctrlKey: false, shiftKey: false };
  fire("floatingObject:selected", { ...press, zone: zone.kind, part: zone.part });
  if (zone.kind === "content") fire("floatingObject:bodyDragStart", { ...press, part: zone.part });
}

function move(at: { x: number; y: number }): void {
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: at.x, clientY: at.y, buttons: 1 }));
}

function release(at: { x: number; y: number }): void {
  window.dispatchEvent(new MouseEvent("mouseup", { clientX: at.x, clientY: at.y, button: 0 }));
}

/** Let the click path's awaits (door, metadata, provider) run out. */
async function drain(): Promise<void> {
  for (let i = 0; i < 6; i++) await settle();
}

beforeAll(async () => {
  area = document.createElement("div");
  area.setAttribute("data-grid-area", "");
  area.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 2000, bottom: 2000, width: 2000, height: 2000, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(area);
  const harness = await loadHarness(CONTROLS, { invokeBackend });
  ext = harness.ext;
  await ext.activate(harness.context);
  await settle();
  overlays = await import("@api/gridOverlays");
  const { floatingControlZoneAt } = await import("../lib/controlZoneAt");
  overlays.registerGridOverlay({ type: "floating-control", render: () => {}, zoneAt: floatingControlZoneAt });
  designMode = await import("../lib/designMode");
  expect(regionOf(BUTTON).data?.movable, "precondition: the button is in RUN mode").toBe(false);
  ({ claimExplicitMacroRun } = await import("@api/explicitMacroRun"));
  const { registerMacroRunProvider } = await import("@api/macroRunService");
  unregister = registerMacroRunProvider({
    runMacroByRef: async (macroId: string, options?: MacroRunOptions) => {
      runs.push({ macroId, options });
      return { status: "ran", name: "Report" };
    },
  });
});

afterAll(async () => {
  unregister();
  await ext.deactivate?.();
  await settle();
  area.remove();
});

beforeEach(async () => {
  release({ x: -500, y: -500 });
  await drain();
  runs = [];
  h.backendCalls.length = 0;
});

describe("the floating button's release is a person's click: it carries the pass", () => {
  // SABOTAGE: drop the `(macroId) => mintExplicitMacroRun("button", macroId)`
  // argument from handleButtonPress's runFloatingButtonClick call (index.ts)
  // -> the link runs with no pass, red.
  it("a press and a release inside run the held link with a pass for exactly its macro", async () => {
    corePress();
    await drain();
    expect(runs, "the PRESS ran the macro").toEqual([]);
    release(INSIDE);
    await drain();
    expect(h.backendCalls, "the click did not ask the door first").toContain("run_control_action");
    expect(runs.map((r) => r.macroId)).toEqual(["macro-report"]);
    const { explicitRun, ...rest } = runs[0].options ?? {};
    expect(rest).toEqual({
      requirePackage: "Sales",
      trigger: { kind: "buttonControl", sheetIndex: ANCHOR.sheetIndex, row: ANCHOR.row, col: ANCHOR.col },
    });
    expect(claimExplicitMacroRun(explicitRun)).toEqual({ door: "button", macroId: "macro-report" });
    expect(claimExplicitMacroRun(explicitRun), "a pass is good for one run").toBeNull();
  });

  it("each click mints its own pass", async () => {
    for (let i = 0; i < 2; i++) {
      corePress();
      release(INSIDE);
      await drain();
    }
    expect(runs).toHaveLength(2);
    const [a, b] = runs.map((r) => r.options?.explicitRun);
    expect(a).toBeDefined();
    expect(a).not.toBe(b);
    expect(claimExplicitMacroRun(a)?.door).toBe("button");
    expect(claimExplicitMacroRun(b)?.door).toBe("button");
  });

  it("SLID OFF before the release: nothing runs, nothing is minted", async () => {
    corePress();
    move(OFF);
    release(OFF);
    await drain();
    expect(runs).toEqual([]);
    expect(h.backendCalls).not.toContain("run_control_action");
  });

  it("DESIGN MODE: the press selects; nothing runs, nothing is minted", async () => {
    designMode.setDesignMode(true);
    await settle();
    try {
      corePress();
      release(INSIDE);
      await drain();
      expect(runs).toEqual([]);
      expect(h.backendCalls).not.toContain("run_control_action");
    } finally {
      designMode.setDesignMode(false);
      await settle();
    }
  });
});
