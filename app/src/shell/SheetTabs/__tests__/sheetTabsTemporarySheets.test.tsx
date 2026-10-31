//! FILENAME: app/src/shell/SheetTabs/__tests__/sheetTabsTemporarySheets.test.tsx
// PURPOSE: The MOUNTED sheet tab strip and a drill-through's TEMPORARY sheet,
//          driven end to end against a model of the backend: the leave
//          observer, the discard and the keep, through the strip's real
//          handlers, the real Insert Sheet / Move or Copy flows
//          (sheetTabFlows.ts), the real core.sheet.* commands and the REAL
//          core tab-menu items (sheetExtensions.ts).
// CONTEXT: docs/design/model-drillthrough.md 2.7. Until this file the
//          observer's integration was proven only by source-text regexes, and
//          two review blockers lived exactly there:
//            - discard-stale-index-after-insert-or-copy-move: the discard
//              deleted BY AN INDEX taken from a read issued half-way through
//              the strip's own add+move / copy+move, so it removed the user's
//              sheet that slid into that index and left the temporary one;
//            - point-mode-discards-edited-sheet: the observer's skip asked
//              "does the formula expect a reference?", which turns false once
//              a point-mode click inserts the reference while the backend is
//              still on the other sheet, and the sheet being edited was deleted.
//          And the converse, review round 2 (TSHELL3-CONVERSE-OTHER-DOORS,
//          TSHELL3-CONVERSE-DIALOG-WINDOW, DISCARD-RENUMBERS-UNDER-DELETE-CONFIRM,
//          MOC-RERESOLVE-GONE-TARGET-READS-AS-END): the strip's OWN doors that
//          captured an index at their gesture -- the tab menu, a drag, the
//          Delete confirmation, the Move or Copy dialog, a prompt -- acted on
//          whichever sheet a discard landing since had slid into it. Each door
//          is driven here against a discard landing INSIDE its window: sent
//          before the door acts, or landing while its menu, dialog,
//          confirmation or prompt is open.
//
//          THE BACKEND MODEL answers in ARRIVAL order, as the real one does: a
//          request is processed the moment it is sent (so a read sent before a
//          move sees the list before the move), and its answer is delivered
//          later, one answer per macrotask turn, oldest first (`settle`). That
//          is what lets a read issued between a flow's two steps come back
//          AFTER the second step was sent -- the window both blockers needed.
//          The barrel's mutating wrappers announce like the real ones (the
//          Shell translator's `sheets:refresh` + `app:sheet-changed`), so the
//          strip re-reads exactly when it would in the app.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
  interface ModelSheet {
    id: string;
    name: string;
    ephemeral: boolean;
    visibility?: "visible" | "hidden";
    tabColor?: string;
    kind?: "worksheet" | "canvas";
  }
  interface Editing {
    value: string;
    row: number;
    col: number;
    sourceSheetIndex: number;
    sourceSheetName: string;
    sourceSheetId?: string;
  }
  interface GridState {
    editing: Editing | null;
    sheetContext: { activeSheetIndex: number; activeSheetName: string; activeSheetId?: string };
  }

  const m = {
    sheets: [] as ModelSheet[],
    activeId: "",
    /** Every request, as it ARRIVED. */
    log: [] as string[],
    /** Answers not yet delivered, oldest first. */
    pending: [] as Array<() => void>,
    /** When set, a discard is refused with this sentence (Protect Workbook Structure). */
    protectStructure: null as string | null,
    /** When set, a keep is refused with this sentence. */
    keepRefusal: null as string | null,
    /** When true, a keep answers Ok but leaves the flag (a backend that lies). */
    keepNoop: false,
    alerts: [] as string[],
    /** What the rename prompt (`promptAsync`) answers; a test may hold it open. */
    prompt: (async () => null) as (...args: unknown[]) => Promise<string | null>,
    /**
     * Core's edit flag raised with NO editing state yet: an open past its edit
     * guards, before its editing state is dispatched (`getGlobalIsEditing`).
     */
    coreEditFlag: false,
    /** Every Ctrl+click group toggle the strip asked for: [clicked index, active index]. */
    groupToggles: [] as Array<[number, number]>,
    /** What the next group toggle answers (the selection it makes). */
    nextGroup: [] as number[],
    /** How many times the strip cleared the sheet group. */
    groupClears: 0,
    /**
     * The group as the strip SET it (setSelectedSheetIndices), cleared by
     * clearSheetGrouping: the strip asks `isSheetGroupingActive` at the click,
     * so a group the user made must read as active, or a test that a click
     * does NOT clear it could never fail.
     */
    group: [] as number[],
    /**
     * A live EXTERNAL session (a floating grid's cell edit), or null: its host
     * by STABLE id (what Core's identity rule decides by), the TRUE index its
     * host had when it OPENED (the owner's fixed `hostSheetIndex`), and
     * whether it is parked / expecting a reference.
     */
    session: null as null | { hostId: string; openedAt: number; parked: boolean; expecting: boolean },
  };

  const list = () => ({
    sheets: m.sheets.map((s, i) => ({
      index: i,
      name: s.name,
      visibility: s.visibility ?? ("visible" as const),
      sheetId: s.id,
      ephemeral: s.ephemeral,
      kind: s.kind ?? ("worksheet" as const),
      ...(s.tabColor ? { tabColor: s.tabColor } : {}),
    })),
    activeIndex: Math.max(0, m.sheets.findIndex((s) => s.id === m.activeId)),
  });

  function request<T>(label: string, compute: () => T): Promise<T> {
    m.log.push(label);
    let ok = true;
    let value: T | undefined;
    let error: unknown;
    try {
      value = compute();
    } catch (e) {
      ok = false;
      error = e;
    }
    return new Promise<T>((resolve, reject) => {
      m.pending.push(() => (ok ? resolve(value as T) : reject(error)));
    });
  }

  /** The Shell translator's fan-out of a `sheets`-domain MUTATION_REFRESH. */
  const announceSheets = () => {
    window.dispatchEvent(new CustomEvent("sheets:refresh"));
    window.dispatchEvent(new CustomEvent("app:sheet-changed"));
  };

  const inRange = (i: number) => {
    if (!Number.isInteger(i) || i < 0 || i >= m.sheets.length) throw `Sheet index ${i} out of range`;
  };

  /** The backend's refusal of a delete whose index no longer names the expected sheet (sheets.rs). */
  const SHEETS_CHANGED = "The sheets changed while that sheet was being deleted, so nothing was deleted.";

  const ops = {
    activateIndex(index: number) {
      inRange(index);
      m.activeId = m.sheets[index].id;
      return list();
    },
    add() {
      let n = 1;
      while (m.sheets.some((s) => s.name === `Sheet${n}`)) n++;
      const sheet = { id: `id-Sheet${n}`, name: `Sheet${n}`, ephemeral: false };
      m.sheets.push(sheet);
      m.activeId = sheet.id;
      return list();
    },
    copy(index: number) {
      inRange(index);
      const source = m.sheets[index];
      const sheet = { id: `id-${source.name} (2)`, name: `${source.name} (2)`, ephemeral: false };
      m.sheets.splice(index + 1, 0, sheet);
      m.activeId = sheet.id;
      return list();
    },
    move(from: number, to: number) {
      inRange(from);
      inRange(to);
      const [sheet] = m.sheets.splice(from, 1);
      m.sheets.splice(to, 0, sheet);
      return list();
    },
    removeAt(index: number) {
      const [gone] = m.sheets.splice(index, 1);
      if (gone.id === m.activeId) m.activeId = m.sheets[Math.min(index, m.sheets.length - 1)].id;
      return gone;
    },
    /** `delete_sheet { index, expectedSheetId? }`: with the id, refused unless the sheet at `index` carries it. */
    deleteIndex(index: number, expectedSheetId?: string) {
      inRange(index);
      if (expectedSheetId !== undefined && m.sheets[index].id !== expectedSheetId) throw SHEETS_CHANGED;
      ops.removeAt(index);
      return list();
    },
    discard(sheetId: string) {
      const index = m.sheets.findIndex((s) => s.id === sheetId);
      if (index < 0) throw "There is no sheet with that id.";
      if (!m.sheets[index].ephemeral) throw "That sheet is not temporary any more.";
      if (m.protectStructure) throw m.protectStructure;
      const gone = ops.removeAt(index);
      return { deletedIndex: index, deletedName: gone.name, result: list() };
    },
    keep(sheetId: string) {
      if (m.keepRefusal) throw m.keepRefusal;
      const sheet = m.sheets.find((s) => s.id === sheetId);
      if (!sheet) throw "There is no sheet with that id.";
      if (!m.keepNoop) sheet.ephemeral = false;
      return list();
    },
    rename(index: number, newName: string) {
      inRange(index);
      m.sheets[index].name = newName;
      return list();
    },
    hide(index: number) {
      inRange(index);
      const sheet = m.sheets[index];
      sheet.visibility = "hidden";
      if (sheet.id === m.activeId) {
        const next = m.sheets.find((s) => (s.visibility ?? "visible") === "visible");
        if (next) m.activeId = next.id;
      }
      return list();
    },
    unhide(index: number) {
      inRange(index);
      m.sheets[index].visibility = "visible";
      return list();
    },
    tabColor(index: number, color: string) {
      inRange(index);
      m.sheets[index].tabColor = color;
      return list();
    },
  };

  const grid = {
    state: { editing: null, sheetContext: { activeSheetIndex: 0, activeSheetName: "" } } as GridState,
    listeners: new Set<() => void>(),
    set(patch: Partial<GridState>) {
      grid.state = { ...grid.state, ...patch };
      grid.listeners.forEach((l) => l());
    },
    subscribe(listener: () => void) {
      grid.listeners.add(listener);
      return () => {
        grid.listeners.delete(listener);
      };
    },
    get() {
      return grid.state;
    },
  };

  // Core's context as the reducer keeps it: the dispatch's stable id, or none.
  const dispatch = (action: { type: string; index?: number; name?: string; sheetId?: string }) => {
    if (action.type === "setSheetContext" || action.type === "setActiveSheet") {
      grid.set({
        sheetContext: {
          activeSheetIndex: action.index ?? 0,
          activeSheetName: action.name ?? "",
          ...(action.sheetId ? { activeSheetId: action.sheetId } : {}),
        },
      });
    }
  };

  /** The tab menu's items for a context: the REAL core registrations once beforeAll seats them. */
  const menu = { items: (_context: unknown): unknown[] => [] };
  /** Every palette the tab menu's Tab Color opened: the index it opened on, and the colour it marked. */
  const colorPicker = [] as Array<{ index: number; current: string | null | undefined }>;

  return { m, list, request, announceSheets, ops, grid, dispatch, menu, colorPicker };
});

// The @api barrel the strip imports ("../../api"): the sheet wrappers over the
// backend model, the grid context over a tiny store, the real event bus.
vi.mock("../../../api", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const events = await vi.importActual<typeof import("../../../core/lib/events")>("../../../core/lib/events");
  const types = await vi.importActual<typeof import("../../../core/types/types")>("../../../core/types/types");
  return {
    getSheets: () => h.request("get_sheets", h.list),
    setActiveSheetApi: (index: number) => h.request(`activate:${index}`, () => h.ops.activateIndex(index)),
    addSheet: async () => {
      const result = await h.request("add", h.ops.add);
      h.announceSheets();
      return result;
    },
    moveSheet: async (from: number, to: number) => {
      const result = await h.request(`move:${from}->${to}`, () => h.ops.move(from, to));
      h.announceSheets();
      return result;
    },
    copySheet: async (index: number) => {
      const result = await h.request(`copy:${index}`, () => h.ops.copy(index));
      h.announceSheets();
      return result;
    },
    // The label carries the expected id when the strip sends one: `delete:2[id-Summary]`.
    deleteSheet: async (index: number, options?: { expectedSheetId?: string }) => {
      const expected = options?.expectedSheetId;
      const result = await h.request(`delete:${index}${expected ? `[${expected}]` : ""}`, () =>
        h.ops.deleteIndex(index, expected),
      );
      h.announceSheets();
      return result;
    },
    renameSheet: async (index: number, newName: string) => {
      const result = await h.request(`rename:${index}=${newName}`, () => h.ops.rename(index, newName));
      h.announceSheets();
      return result;
    },
    hideSheet: async (index: number) => {
      const result = await h.request(`hide:${index}`, () => h.ops.hide(index));
      h.announceSheets();
      return result;
    },
    unhideSheet: async (index: number) => {
      const result = await h.request(`unhide:${index}`, () => h.ops.unhide(index));
      h.announceSheets();
      return result;
    },
    // The real wrapper announces nothing (the strip adopts the answer).
    setTabColor: (index: number, color: string) => h.request(`tabColor:${index}=${color}`, () => h.ops.tabColor(index, color)),
    sheetExtensions: { getContextMenuItemsForContext: (context: unknown) => h.menu.items(context) },
    registerCoreSheetContextMenu: () => {},
    useGridContext: () => ({
      state: React.useSyncExternalStore(h.grid.subscribe, h.grid.get),
      dispatch: h.dispatch,
    }),
    setActiveSheet: (index: number, name: string, _surface?: string, sheetId?: string) => ({
      type: "setActiveSheet",
      index,
      name,
      sheetId,
    }),
    setSheetContext: (index: number, name: string, _surface?: string, sheetId?: string) => ({
      type: "setSheetContext",
      index,
      name,
      sheetId,
    }),
    setSheetSurfaces: () => ({ type: "setSheetSurfaces" }),
    emitAppEvent: events.emitAppEvent,
    AppEvents: events.AppEvents,
    isFormulaExpectingReference: types.isFormulaExpectingReference,
    setSelectedSheetIndices: (indices: number[]) => {
      h.m.group = [...indices];
    },
    clearSheetGrouping: () => {
      h.m.groupClears += 1;
      h.m.group = [];
    },
    toggleSheetInGroup: (index: number, active: number) => {
      h.m.groupToggles.push([index, active]);
      return [...h.m.nextGroup];
    },
    isSheetGroupingActive: () => h.m.group.length > 1,
    // The group the strip SET, read at the click (the group rules ask it).
    getSelectedSheetIndices: () => [...h.m.group],
    primeSheetSwitch: async () => {},
    getSheetTabDecorations: () => [],
    onSheetTabDecorationsChanged: () => () => {},
    MAX_SHEET_TAB_DECORATION_GLYPHS: 3,
  };
});

// The temporary sheet's two primitives, by stable id, announcing as the real
// wrappers do (both name the `sheets` domain).
vi.mock("../../../api/lib", () => ({
  keepEphemeralSheet: async (sheetId: string) => {
    const result = await h.request(`keep:${sheetId}`, () => h.ops.keep(sheetId));
    h.announceSheets();
    return result;
  },
  discardEphemeralSheet: async (sheetId: string) => {
    const answer = await h.request(`discard:${sheetId}`, () => h.ops.discard(sheetId));
    h.announceSheets();
    return answer;
  },
  isSheetBlank: async () => true,
}));

// The grid editor's synchronous formula-mode flag, computed from the edit the
// test opened (as Core's is from the edit's text), and Core's synchronous edit
// flag: up while an edit is open, and -- `coreEditFlag` -- while an open is past
// its guards with no editing state yet. The typed-open latch is Core's REAL,
// dependency-free one (`beginEditorOpen` / `abortEditorOpen`).
vi.mock("../../../api/editing", async () => {
  const types = await vi.importActual<typeof import("../../../core/types/types")>("../../../core/types/types");
  const identity = await vi.importActual<typeof import("../../../core/lib/editSheetIdentity")>(
    "../../../core/lib/editSheetIdentity",
  );
  return {
    // Core's REAL identity rule: the strip marks the edit's source tab by it.
    findEditSheet: identity.findEditSheet,
    isGlobalFormulaMode: () => {
      const editing = h.grid.state.editing;
      return editing !== null && types.isFormulaExpectingReference(editing.value);
    },
    getGlobalIsEditing: () => h.m.coreEditFlag || h.grid.state.editing !== null,
    getGlobalCursorPosition: () => 0,
    getExternalFormulaTarget: () => null,
  };
});

// The external session, driven by `h.m.session` (null in every test that does
// not set one). `isExternalSessionHostSheet` stands in for Core's identity
// rule (by stable id) -- what is under test here is that the STRIP asks it of
// the tab it means, never compares the owner's opening index.
vi.mock("../../../api/externalEdit", () => ({
  subscribeExternalEdit: () => () => {},
  getCrossSheetPointModeKey: () =>
    h.m.session ? `${h.m.session.openedAt}:${h.m.session.parked ? 1 : 0}:${h.m.session.expecting ? 1 : 0}` : null,
  isCrossSheetPointMode: () => h.m.session !== null && (h.m.session.parked || h.m.session.expecting),
  getExternalEditSession: () => (h.m.session ? { hostSheetIndex: h.m.session.openedAt } : null),
  isExternalSessionParked: () => h.m.session?.parked === true,
  isExternalSessionHostSheet: (sheet: { sheetId?: string }) =>
    h.m.session !== null && sheet.sheetId !== undefined && sheet.sheetId === h.m.session.hostId,
  // Core's point-mode switch, against the model: the backend moves, nothing else.
  switchSheetForPointMode: vi.fn((index: number) => h.request(`point:${index}`, () => h.ops.activateIndex(index))),
  focusExternalSessionView: vi.fn(),
  quoteSheetNameForFormula: (name: string) => name,
}));

vi.mock("@api/dialogs", () => ({
  alertAsync: vi.fn(async (message: string) => {
    h.m.alerts.push(message);
  }),
  promptAsync: (...args: unknown[]) => h.m.prompt(...args),
  confirmAsync: vi.fn(async () => false),
}));

vi.mock("@api/ui", () => ({
  DialogExtensions: { openDialog: vi.fn(), registerDialog: vi.fn(), unregisterDialog: vi.fn() },
}));

// The tab menu's Tab Color palette: which index it was opened on is all this
// file asks (the palette's own pixels are sheetTabMenuColorAndHide.test.tsx's).
vi.mock("../../registries/sheetTabColorPicker", () => ({
  installSheetTabColorPicker: () => {},
  openSheetTabColorPicker: (index: number, current: string | null | undefined) => {
    h.colorPicker.push({ index, current });
  },
}));

vi.mock("../sheetDeletePolicy", () => ({ sheetDeleteNeedsConfirmation: vi.fn(async () => true) }));

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SheetTabs } from "../SheetTabs";
import { getSheetTabsController, STRUCTURE_LOCKED } from "../sheetCommands";
import { abortEditorOpen, beginEditorOpen } from "../../../core/lib/editOpenBuffer";
import {
  clearSheetGrouping as clearCoreSheetGroup,
  endSheetGroupUnlessMember,
  setSelectedSheetIndices as setCoreSheetGroup,
} from "../../../core/state/sheetGrouping";
import { sheetDeleteNeedsConfirmation } from "../sheetDeletePolicy";
import { registerCoreSheetContextMenu, sheetExtensions as coreSheetMenu } from "../../registries/sheetExtensions";
import type { MoveOrCopySheetData } from "../../dialogs/MoveOrCopySheetDialog";
import { CommandRegistry, CoreCommands } from "@api/commands";
import { DialogExtensions } from "@api/ui";
import { registerToastSink, type ToastPayload } from "@api/notifications";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const DRILL = "id-Drillthrough";
const DISCARD_COMMAND = "core.sheet.discardEphemeral";

const toasts: ToastPayload[] = [];
let container: HTMLDivElement;
let root: Root;
const restore: Array<() => void> = [];

/** Deliver every answer, oldest first, one per macrotask turn, until nothing is pending. */
async function settle(maxSteps = 400): Promise<void> {
  for (let step = 0; step < maxSteps; step++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const next = h.m.pending.shift();
    if (!next) return;
    await act(async () => {
      next();
    });
  }
  throw new Error("the backend model never went quiet");
}

/** Deliver answers one per turn, oldest first, until `done()` holds (asked before each delivery). */
async function deliverUntil(done: () => boolean, maxSteps = 200): Promise<void> {
  for (let step = 0; step < maxSteps; step++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (done()) return;
    const next = h.m.pending.shift();
    if (!next) throw new Error("nothing is pending and the condition still does not hold");
    await act(async () => {
      next();
    });
  }
  throw new Error("the condition never held");
}

/** One macrotask turn; delivers nothing. */
const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const names = () => h.m.sheets.map((s) => s.name);
/** Every request that REMOVED or tried to remove a sheet, by kind and target. */
const removals = () => h.m.log.filter((l) => l.startsWith("discard:") || l.startsWith("delete:"));
const tab = (index: number) => container.querySelector(`button[data-sheet-tab="${index}"]`) as HTMLButtonElement;
const fire = (el: Element, type: "click" | "dblclick") =>
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  });
const setEditing = (editing: typeof h.grid.state.editing) =>
  act(() => {
    h.grid.set({ editing });
  });

type LayoutSheet = { id: string; name: string; ephemeral: boolean; visibility?: "visible" | "hidden" };

/** Sales, Costs, Summary and the drill's temporary sheet (or `layout`), the drill sheet active; the strip mounted and settled. */
async function mountOnDrill(layout?: LayoutSheet[]): Promise<void> {
  h.m.sheets = layout ?? [
    { id: "id-Sales", name: "Sales", ephemeral: false },
    { id: "id-Costs", name: "Costs", ephemeral: false },
    { id: "id-Summary", name: "Summary", ephemeral: false },
    { id: DRILL, name: "Drillthrough", ephemeral: true },
  ];
  h.m.activeId = DRILL;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<SheetTabs />);
  });
  await settle();
  h.m.log.length = 0;
}

beforeAll(() => {
  if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === "undefined") {
    Reflect.set(globalThis, "ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    restore.push(() => Reflect.deleteProperty(globalThis, "ResizeObserver"));
  }
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = function scrollIntoView() {};
    restore.push(() => Reflect.deleteProperty(Element.prototype, "scrollIntoView"));
  }
  registerToastSink((t) => toasts.push(t));
  // The REAL core tab-menu items and, through them, the core.sheet.* commands
  // and the Move or Copy dialog's registration -- exactly what bootstrap seats.
  registerCoreSheetContextMenu();
  h.menu.items = (context) =>
    coreSheetMenu.getContextMenuItemsForContext(context as Parameters<typeof coreSheetMenu.getContextMenuItemsForContext>[0]);
});

afterAll(() => {
  h.menu.items = () => [];
  for (const undo of restore.splice(0)) undo();
});

beforeEach(() => {
  toasts.length = 0;
  h.m.log.length = 0;
  h.m.pending.length = 0;
  h.m.alerts.length = 0;
  h.m.protectStructure = null;
  h.m.keepRefusal = null;
  h.m.keepNoop = false;
  h.m.prompt = async () => null;
  h.m.coreEditFlag = false;
  h.m.groupToggles.length = 0;
  h.m.nextGroup = [];
  h.m.groupClears = 0;
  h.m.group = [];
  h.m.session = null;
  abortEditorOpen();
  h.colorPicker.length = 0;
  vi.mocked(DialogExtensions.openDialog).mockClear();
  vi.mocked(sheetDeleteNeedsConfirmation).mockReset();
  vi.mocked(sheetDeleteNeedsConfirmation).mockImplementation(async () => true);
  h.grid.state = { editing: null, sheetContext: { activeSheetIndex: 0, activeSheetName: "" } };
});

afterEach(async () => {
  // Nothing left opening, and every answer delivered: an undelivered discard
  // would stay in the strip's module-level in-flight map and stall the next test.
  abortEditorOpen();
  h.m.coreEditFlag = false;
  await setEditing(null);
  await settle();
  await act(async () => {
    root.unmount();
  });
  await settle();
  container.remove();
});

describe("leaving a temporary sheet (the baseline)", () => {
  it("a tab click away discards it ONCE, by its stable id, and tells the view cache the index the BACKEND removed", async () => {
    await mountOnDrill();
    const reorders: Array<{ fromIndex: number; toIndex: number }> = [];
    const onReorder = (e: Event) => reorders.push((e as CustomEvent).detail);
    window.addEventListener("sheet:reorder", onReorder);
    try {
      await fire(tab(0), "click");
      await settle();
    } finally {
      window.removeEventListener("sheet:reorder", onReorder);
    }
    expect(removals()).toEqual([`discard:${DRILL}`]);
    expect(names()).toEqual(["Sales", "Costs", "Summary"]);
    expect(reorders).toEqual([{ fromIndex: 3, toIndex: Number.MAX_SAFE_INTEGER }]);
    expect(toasts).toEqual([]);
  });
});

// Review finding discard-stale-index-after-insert-or-copy-move (blocker).
describe("the strip's own two-step flows, started while ON the temporary sheet", () => {
  it("Insert Sheet before index 0: the DRILL sheet is removed; every user sheet and the new one survive, in place", async () => {
    await mountOnDrill();
    void getSheetTabsController()!.insertSheetBefore(0);
    await settle();
    expect(names()).toEqual(["Sheet1", "Sales", "Costs", "Summary"]);
    expect(removals()).toEqual([`discard:${DRILL}`]);
    expect(h.m.alerts).toEqual([]);
  });

  it("Insert Sheet before the drill sheet itself (Shift+F11 on it): the new sheet survives where the drill sheet was", async () => {
    await mountOnDrill();
    void getSheetTabsController()!.insertSheetBefore(3);
    await settle();
    expect(names()).toEqual(["Sales", "Costs", "Summary", "Sheet1"]);
    expect(removals()).toEqual([`discard:${DRILL}`]);
    expect(h.m.alerts).toEqual([]);
  });

  it("Move or Copy with a copy that crosses the drill sheet's index (Sales copied to the end): the COPY survives", async () => {
    await mountOnDrill();
    void getSheetTabsController()!.moveOrCopySheet("id-Sales", null, true);
    await settle();
    expect(names()).toEqual(["Sales", "Costs", "Summary", "Sales (2)"]);
    expect(removals()).toEqual([`discard:${DRILL}`]);
    expect(h.m.alerts).toEqual([]);
  });

  it("a structural change from ANOTHER door lands between the leave's read and the discard (a script moves Sales to the end): the discard, by id, removes the drill sheet and only it", async () => {
    await mountOnDrill();
    const api = await import("../../../api");
    // The user left the drill sheet; the strip's read is SENT (Drillthrough at 3)...
    h.m.activeId = "id-Sales";
    window.dispatchEvent(new CustomEvent("app:sheet-changed"));
    // ...and a script's move lands before the discard does: index 3 is now Sales.
    void api.moveSheet(0, 3);
    await settle();
    expect(names()).toEqual(["Costs", "Summary", "Sales"]);
    expect(removals()).toEqual([`discard:${DRILL}`]);
  });

  it("a leave whose read was SENT before an Insert Sheet but answers during it waits for the flow: no discard lands between the add and the move", async () => {
    await mountOnDrill();
    // A door moved the user to Sales and announced it: the strip's read is SENT...
    h.m.activeId = "id-Sales";
    window.dispatchEvent(new CustomEvent("app:sheet-changed"));
    // ...and before it answers, Shift+F11 on Sales: insert before index 0.
    void getSheetTabsController()!.insertSheetBefore(0);
    await settle();
    // The move landed on the list the add answered (no discard renumbered it in between).
    expect(names()).toEqual(["Sheet1", "Sales", "Costs", "Summary"]);
    const discardAt = h.m.log.indexOf(`discard:${DRILL}`);
    expect(discardAt).toBeGreaterThan(h.m.log.indexOf("move:4->0"));
    expect(removals()).toEqual([`discard:${DRILL}`]);
    expect(h.m.alerts).toEqual([]);
  });
});

// Review finding point-mode-discards-edited-sheet (blocker).
describe("a formula written ON the temporary sheet (the observer pauses while ANY cell edit is open)", () => {
  const onDrill = (value: string) => ({ value, row: 4, col: 3, sourceSheetIndex: 3, sourceSheetName: "Drillthrough" });

  it("type '=', point-switch to Sales, insert a reference, a re-read arrives: nothing is discarded; Enter back on the drill sheet: still nothing", async () => {
    await mountOnDrill();
    await setEditing(onDrill("="));
    // Click the Sales tab in point mode: the BACKEND moves, with no SHEET_CHANGED.
    h.m.activeId = "id-Sales";
    // Click B2: the formula expects nothing now, the backend is still on Sales.
    await setEditing(onDrill("=Sales!B2"));
    await settle();
    // Any sheets event re-reads meanwhile.
    window.dispatchEvent(new CustomEvent("sheets:refresh"));
    await settle();
    expect(removals()).toEqual([]);
    // Enter: the commit switches back to the drill sheet, THEN closes the edit.
    h.m.activeId = DRILL;
    const mark = h.m.log.length;
    await setEditing(null);
    await settle();
    expect(removals()).toEqual([]);
    expect(names()).toContain("Drillthrough");
    // The read the pause owed happened once the edit closed.
    expect(h.m.log.slice(mark)).toContain("get_sheets");
  });

  it("Escape (cancel) back on the drill sheet discards nothing either", async () => {
    await mountOnDrill();
    await setEditing(onDrill("=SUM("));
    h.m.activeId = "id-Costs";
    await setEditing(onDrill("=SUM(Costs!A1"));
    window.dispatchEvent(new CustomEvent("app:sheet-changed"));
    await settle();
    h.m.activeId = DRILL;
    await setEditing(null);
    await settle();
    expect(removals()).toEqual([]);
  });

  it("a door switch during the edit, the edit then ending with the backend on another sheet: exactly one discard", async () => {
    await mountOnDrill();
    await setEditing(onDrill("abc"));
    h.m.activeId = "id-Sales";
    window.dispatchEvent(new CustomEvent("app:sheet-changed"));
    await settle();
    expect(removals()).toEqual([]);
    await setEditing(null);
    await settle();
    expect(removals()).toEqual([`discard:${DRILL}`]);
    expect(names()).toEqual(["Sales", "Costs", "Summary"]);
  });

  it("an edit that ends with no read skipped costs no extra read", async () => {
    await mountOnDrill();
    await setEditing(onDrill("abc"));
    await settle();
    const mark = h.m.log.length;
    await setEditing(null);
    await settle();
    expect(h.m.log.slice(mark)).toEqual([]);
  });
});

// C7: core.sheet.discardEphemeral resolves to whether the sheet is gone.
describe("core.sheet.discardEphemeral through the mounted strip", () => {
  it("resolves true only once the backend discard LANDED", async () => {
    await mountOnDrill();
    let answered: unknown = "pending";
    const run = CommandRegistry.execute(DISCARD_COMMAND, { sheetId: DRILL }).then((gone) => {
      answered = gone;
    });
    await tick();
    expect(h.m.log).toEqual([`discard:${DRILL}`]);
    expect(answered).toBe("pending");
    await settle();
    await run;
    expect(answered).toBe(true);
    expect(names()).toEqual(["Sales", "Costs", "Summary"]);
  });

  it("a second request for the same id AWAITS the first: one backend discard, and no answer before it landed", async () => {
    await mountOnDrill();
    const first = CommandRegistry.execute(DISCARD_COMMAND, { sheetId: DRILL });
    let secondAnswer: unknown = "pending";
    const second = CommandRegistry.execute(DISCARD_COMMAND, { sheetId: DRILL }).then((gone) => {
      secondAnswer = gone;
    });
    await tick();
    // The discard was sent once and has not answered: neither may the second request.
    expect(h.m.log).toEqual([`discard:${DRILL}`]);
    expect(secondAnswer).toBe("pending");
    await settle();
    await expect(first).resolves.toBe(true);
    await second;
    expect(secondAnswer).toBe(true);
    expect(removals()).toEqual([`discard:${DRILL}`]);
  });

  it("a REFUSED discard keeps the sheet by its id, says 'Temporary sheet kept: <reason>' once, and resolves false", async () => {
    await mountOnDrill();
    h.m.protectStructure = "The workbook's structure is protected.";
    const run = CommandRegistry.execute(DISCARD_COMMAND, { sheetId: DRILL });
    await settle();
    await expect(run).resolves.toBe(false);
    expect(h.m.log).toContain(`keep:${DRILL}`);
    expect(h.m.sheets.find((s) => s.id === DRILL)?.ephemeral).toBe(false);
    expect(toasts.map((t) => t.message)).toEqual(["Temporary sheet kept: The workbook's structure is protected."]);
    expect(h.m.alerts).toEqual([]);
  });

  it("a refused discard whose keep fails too NEVER says 'kept': it warns the sheet is still temporary", async () => {
    await mountOnDrill();
    h.m.protectStructure = "The workbook's structure is protected.";
    h.m.keepRefusal = "The keep could not be applied.";
    const run = CommandRegistry.execute(DISCARD_COMMAND, { sheetId: DRILL });
    await settle();
    await expect(run).resolves.toBe(false);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe("warning");
    expect(toasts[0].message).not.toMatch(/^Temporary sheet kept/);
    expect(toasts[0].message).toMatch(/still temporary and will close when you leave it/);
    expect(h.m.sheets.find((s) => s.id === DRILL)?.ephemeral).toBe(true);
  });

  // Review TSHELL-2: the keep's ANSWERED list decides, not the keep's success.
  it("a refused discard whose keep answers Ok but leaves the flag NEVER says 'kept': it warns the sheet is still temporary", async () => {
    await mountOnDrill();
    h.m.protectStructure = "The workbook's structure is protected.";
    h.m.keepNoop = true;
    const run = CommandRegistry.execute(DISCARD_COMMAND, { sheetId: DRILL });
    await settle();
    await expect(run).resolves.toBe(false);
    expect(h.m.log).toContain(`keep:${DRILL}`);
    expect(h.m.sheets.find((s) => s.id === DRILL)?.ephemeral).toBe(true);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe("warning");
    expect(toasts[0].message).not.toMatch(/^Temporary sheet kept/);
    expect(toasts[0].message).toMatch(/still temporary and will close when you leave it/);
  });

  // Review TSHELL-1: another door (an MCP delete_sheet by index) removed the
  // sheet behind the strip's back; the discard and the keep are both refused,
  // and a fresh read says the sheet is gone -- which is what the caller wanted.
  it("a refused discard of a sheet ANOTHER door already removed resolves true and tells nothing", async () => {
    await mountOnDrill();
    h.m.sheets = h.m.sheets.filter((s) => s.id !== DRILL);
    h.m.activeId = "id-Summary";
    const run = CommandRegistry.execute(DISCARD_COMMAND, { sheetId: DRILL });
    await settle();
    await expect(run).resolves.toBe(true);
    expect(h.m.log.slice(0, 3)).toEqual([`discard:${DRILL}`, `keep:${DRILL}`, "get_sheets"]);
    expect(toasts).toEqual([]);
    expect(h.m.alerts).toEqual([]);
  });

  // Review TSHELL-3: the door waits out the strip's own two-step flow.
  it("the door WAITS for an Insert Sheet in flight: no discard lands between the add and the move", async () => {
    await mountOnDrill();
    void getSheetTabsController()!.insertSheetBefore(0);
    // The insert's door reads the list again, then sends the add; nothing past that is answered.
    await deliverUntil(() => h.m.log.includes("add"));
    const run = CommandRegistry.execute(DISCARD_COMMAND, { sheetId: DRILL });
    await tick();
    // The hold itself: nothing is sent while the flow is between its steps.
    expect(removals(), "no discard is sent while the flow is in flight").toEqual([]);
    await settle();
    await expect(run).resolves.toBe(true);
    expect(names()).toEqual(["Sheet1", "Sales", "Costs", "Summary"]);
    expect(h.m.log.indexOf(`discard:${DRILL}`)).toBeGreaterThan(h.m.log.indexOf("move:4->0"));
    expect(removals()).toEqual([`discard:${DRILL}`]);
    expect(h.m.alerts).toEqual([]);
  });

  // The converse: the door's discard was SENT before the flow started. The
  // drill tab is FIRST, so its removal renumbers every other sheet; the copy
  // must still copy the sheet the user chose (Costs), never the one that slid
  // into its index (Summary).
  it("a Move or Copy started while a discard is in flight copies the sheet the user chose", async () => {
    await mountOnDrill([
      { id: DRILL, name: "Drillthrough", ephemeral: true },
      { id: "id-Sales", name: "Sales", ephemeral: false },
      { id: "id-Costs", name: "Costs", ephemeral: false },
      { id: "id-Summary", name: "Summary", ephemeral: false },
    ]);
    const run = CommandRegistry.execute(DISCARD_COMMAND, { sheetId: DRILL });
    void getSheetTabsController()!.moveOrCopySheet("id-Costs", null, true);
    await settle();
    await expect(run).resolves.toBe(true);
    expect(names()).toEqual(["Sales", "Costs", "Summary", "Costs (2)"]);
    expect(h.m.alerts).toEqual([]);
  });
});

// Review finding keep-claims-success-it-did-not-get.
describe("keeping a temporary sheet, by its stable id", () => {
  it("a double-click on its tab keeps THAT sheet by id and says 'Sheet kept'; leaving it afterwards discards nothing", async () => {
    await mountOnDrill();
    await fire(tab(3), "dblclick");
    await settle();
    expect(h.m.log).toContain(`keep:${DRILL}`);
    expect(toasts.map((t) => [t.message, t.variant])).toEqual([["Sheet kept", "success"]]);
    await fire(tab(0), "click");
    await settle();
    expect(removals()).toEqual([]);
    expect(names()).toContain("Drillthrough");
  });

  it("a keep the backend answered WITHOUT unflagging the sheet does not claim success", async () => {
    await mountOnDrill();
    h.m.keepNoop = true;
    await act(async () => {
      void getSheetTabsController()!.keepSheet(DRILL);
    });
    await settle();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe("error");
    expect(toasts[0].message).toBe("The sheet could not be kept: it is still temporary and will close when you leave it.");
  });

  it("a keep of a sheet that is gone says so (the refusal is checked against a fresh read)", async () => {
    await mountOnDrill();
    await act(async () => {
      void getSheetTabsController()!.keepSheet("id-Gone");
    });
    await settle();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe("error");
    expect(toasts[0].message).toBe("The sheet could not be kept: it is no longer in the workbook.");
  });

  it("the Keep Sheet door with no id (a list without ids) is refused with a toast, and nothing is sent", async () => {
    await mountOnDrill();
    await act(async () => {
      void getSheetTabsController()!.keepSheet(undefined);
    });
    await settle();
    expect(h.m.log).toEqual([]);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe("error");
  });
});

// ============================================================================
// The strip's OWN doors against a discard landing inside their window (review
// round 2: TSHELL3-CONVERSE-OTHER-DOORS, TSHELL3-CONVERSE-DIALOG-WINDOW,
// DISCARD-RENUMBERS-UNDER-DELETE-CONFIRM, MOC-RERESOLVE-GONE-TARGET-READS-AS-END)
// ============================================================================
//
// The layout the review used: the temporary tab sits LEFT of Summary (a user
// dragged it there; a move keeps the flag), so its discard renumbers Costs,
// Summary and Q4. The user leaves it for Sales; the discard is SENT and its
// answer still pending -- the strip still SHOWS the old list.

const FIVE = (): LayoutSheet[] => [
  { id: "id-Sales", name: "Sales", ephemeral: false },
  { id: DRILL, name: "Drillthrough", ephemeral: true },
  { id: "id-Costs", name: "Costs", ephemeral: false },
  { id: "id-Summary", name: "Summary", ephemeral: false },
  { id: "id-Q4", name: "Q4", ephemeral: false },
];

/** The user left the temporary sheet (active) for the tab at `leaveTo`: its discard is SENT, not yet answered. */
async function leaveDrillDiscardInFlight(layout: LayoutSheet[] = FIVE(), leaveTo = 0): Promise<void> {
  await mountOnDrill(layout);
  await fire(tab(leaveTo), "click");
  await deliverUntil(() => h.m.log.includes(`discard:${DRILL}`));
}

const rightClick = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
/** Every rendered button (the tab menu's rows, a dialog's buttons) with this label -- never a tab. */
const buttonsLabelled = (label: string) =>
  Array.from(container.querySelectorAll("button:not([data-sheet-tab])")).filter(
    (b) => (b.textContent ?? "").trim() === label,
  ) as HTMLButtonElement[];
/** The one rendered button with this label. */
function button(label: string): HTMLButtonElement {
  const found = buttonsLabelled(label);
  expect(found, `exactly one "${label}" button`).toHaveLength(1);
  return found[0];
}
const press = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
/** The sheet the open Delete confirmation names, or null when none is open. */
const promptNames = () => (container.textContent ?? "").match(/Are you sure you want to delete "([^"]*)"\?/)?.[1] ?? null;
const sheetById = (id: string) => h.m.sheets.find((s) => s.id === id);
/** The data the last Move or Copy dialog was opened with. */
function lastMoveOrCopyDialog(): MoveOrCopySheetData {
  const calls = vi.mocked(DialogExtensions.openDialog).mock.calls;
  expect(calls.length, "the Move or Copy dialog was not opened").toBeGreaterThan(0);
  return calls[calls.length - 1][1] as unknown as MoveOrCopySheetData;
}
const GONE_DRILL = (done: string) =>
  `"Drillthrough" is no longer in the workbook: it was a temporary sheet and closed when you left it. Nothing was ${done}.`;
const GONE_DRILL_ANCHOR = (done: string) =>
  `"Drillthrough", the sheet to place it before, is no longer in the workbook: it was a temporary sheet and closed when you left it. Nothing was ${done}.`;

describe("the tab menu's doors find the right-clicked sheet by its id", () => {
  it("Duplicate Sheet picked while the leave's discard is still in flight copies the sheet the user right-clicked", async () => {
    await leaveDrillDiscardInFlight();
    // The strip has not heard the discard's answer: Summary is still at index 3 on screen.
    expect(tab(3).textContent).toBe("Summary");
    await rightClick(tab(3));
    await press(button("Duplicate Sheet"));
    await settle();
    expect(names()).toEqual(["Sales", "Costs", "Summary", "Summary (2)", "Q4"]);
    expect(h.m.log).toContain("copy:2");
    expect(toasts).toEqual([]);
    expect(h.m.alerts).toEqual([]);
  });

  it("Duplicate Sheet picked after the discard LANDED under the open menu copies the sheet the menu was opened for", async () => {
    await leaveDrillDiscardInFlight();
    await rightClick(tab(3)); // Summary, while the discard is in flight
    await settle(); // the discard lands; the menu stays open
    expect(names()).toEqual(["Sales", "Costs", "Summary", "Q4"]);
    await press(button("Duplicate Sheet"));
    await settle();
    expect(names()).toEqual(["Sales", "Costs", "Summary", "Summary (2)", "Q4"]);
    expect(toasts).toEqual([]);
  });

  it("a door started while the leave's READ is still in flight -- no discard sent yet -- acts first; the discard waits for it", async () => {
    await mountOnDrill(FIVE());
    await fire(tab(0), "click");
    // The leave's read is SENT and not answered: the observer has judged nothing yet.
    await deliverUntil(() => h.m.log.includes("get_sheets"));
    expect(removals()).toEqual([]);
    // Duplicate Sheet on Summary (index 3 on screen), by its id.
    await act(async () => {
      window.dispatchEvent(new CustomEvent("sheet:requestCopy", { detail: { index: 3, sheetId: "id-Summary" } }));
    });
    await settle();
    expect(names()).toEqual(["Sales", "Costs", "Summary", "Summary (2)", "Q4"]);
    // The discard went out only after the copy landed.
    expect(h.m.log.indexOf(`discard:${DRILL}`)).toBeGreaterThan(h.m.log.indexOf("copy:3"));
    expect(removals()).toEqual([`discard:${DRILL}`]);
  });

  it("Move Left picked while the discard is in flight moves the sheet one VISIBLE place left of where it stands after the discard", async () => {
    await leaveDrillDiscardInFlight();
    await rightClick(tab(3)); // Summary
    await press(button("Move Left"));
    await settle();
    expect(names()).toEqual(["Sales", "Summary", "Costs", "Q4"]);
    expect(h.m.log).toContain("move:2->1");
  });

  it("Move Right picked after the discard landed under the open menu moves the right-clicked sheet past its visible neighbour", async () => {
    await leaveDrillDiscardInFlight();
    await rightClick(tab(2)); // Costs
    await settle();
    await press(button("Move Right"));
    await settle();
    expect(names()).toEqual(["Sales", "Summary", "Costs", "Q4"]);
    expect(h.m.log).toContain("move:1->2");
  });

  it("Hide Sheet picked after the discard landed under the open menu hides the sheet the menu was opened for", async () => {
    await leaveDrillDiscardInFlight();
    await rightClick(tab(3)); // Summary
    await settle();
    await press(button("Hide Sheet"));
    await settle();
    expect(h.m.log).toContain("hide:2");
    expect(sheetById("id-Summary")?.visibility).toBe("hidden");
    expect(sheetById("id-Q4")?.visibility ?? "visible").toBe("visible");
  });

  it("Rename: the discard lands while the rename PROMPT is open, and the sheet the user named is renamed", async () => {
    await leaveDrillDiscardInFlight();
    let answer: (name: string | null) => void = () => {};
    h.m.prompt = () =>
      new Promise<string | null>((resolve) => {
        answer = resolve;
      });
    await rightClick(tab(3)); // Summary
    await press(button("Rename"));
    await settle(); // the discard lands while the prompt is open
    expect(names()).toEqual(["Sales", "Costs", "Summary", "Q4"]);
    await act(async () => {
      answer("Totals");
    });
    await settle();
    expect(names()).toEqual(["Sales", "Costs", "Totals", "Q4"]);
    expect(h.m.log).toContain("rename:2=Totals");
  });

  it("Tab Color: the palette opens on the sheet the menu was opened for, at the index it has NOW", async () => {
    await leaveDrillDiscardInFlight();
    await rightClick(tab(3)); // Summary
    await settle(); // the discard lands under the open menu
    await press(button("Tab Color"));
    expect(h.colorPicker).toEqual([{ index: 2, current: null }]);
  });

  it("core.sheet.setTabColor for an index read while the discard is in flight colours the sheet that index named THEN", async () => {
    await leaveDrillDiscardInFlight();
    // The strip still lists Summary at 3, and the command reads it there...
    await act(async () => {
      void CommandRegistry.execute(CoreCommands.SHEET_TAB_COLOR, { index: 3, color: "#00FF00" });
    });
    await settle();
    // ...and the strip colours Summary, found again by id after the discard landed.
    expect(h.m.log).toContain("tabColor:2=#00FF00");
    expect(sheetById("id-Summary")?.tabColor).toBe("#00FF00");
    expect(sheetById("id-Q4")?.tabColor).toBeUndefined();
  });

  it("a menu opened on the temporary tab whose discard then LANDS refuses at the click with a toast: nothing is sent for a sheet that is gone", async () => {
    await leaveDrillDiscardInFlight();
    await rightClick(tab(1)); // the Drillthrough tab, still on screen
    await settle(); // its discard lands under the open menu
    const mark = h.m.log.length;
    await press(button("Keep Sheet"));
    await settle();
    expect(h.m.log.slice(mark)).toEqual([]);
    expect(buttonsLabelled("Keep Sheet"), "the menu closed").toEqual([]);
    expect(toasts.map((t) => t.message)).toEqual([GONE_DRILL("done")]);
    expect(h.m.alerts).toEqual([]);
  });

  it("Insert Sheet before the temporary tab, its discard in flight, refuses with a toast instead of adding a sheet somewhere else", async () => {
    await leaveDrillDiscardInFlight();
    await rightClick(tab(1)); // Drillthrough
    await press(button("Insert Sheet"));
    await settle();
    expect(h.m.log).not.toContain("add");
    expect(names()).toEqual(["Sales", "Costs", "Summary", "Q4"]);
    expect(toasts.map((t) => t.message)).toEqual([GONE_DRILL_ANCHOR("inserted")]);
    expect(h.m.alerts).toEqual([]);
  });
});

describe("a drag moves the sheets it picked up and dropped on, by id", () => {
  /** Lay the rendered tabs out 100 px apart (jsdom lays nothing out itself). */
  function layOutTabs(): void {
    const tabs = Array.from(container.querySelectorAll("button[data-sheet-tab]")) as HTMLElement[];
    tabs.forEach((el, i) => {
      Object.defineProperty(el, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ left: i * 100, right: i * 100 + 100, width: 100, top: 0, bottom: 20, height: 20, x: i * 100, y: 0, toJSON() {} }),
      });
    });
  }

  it("Summary dragged onto Costs, the discard landing mid-drag: Summary goes before Costs -- never Q4, which slid into its index", async () => {
    await leaveDrillDiscardInFlight();
    layOutTabs();
    const summary = tab(3);
    expect(summary.textContent).toBe("Summary");
    await act(() => {
      summary.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 350 }));
    });
    await act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 240 })); // over Costs
    });
    await settle(); // the discard lands mid-drag
    expect(names()).toEqual(["Sales", "Costs", "Summary", "Q4"]);
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 240 }));
    });
    await settle();
    expect(names()).toEqual(["Sales", "Summary", "Costs", "Q4"]);
    expect(h.m.log).toContain("move:2->1");
  });

  // Review TSHELL4-DRAG-STATE-ARMED-DURING-DOOR: the drag stayed armed until its
  // door finished, so the next mouseup anywhere -- a click on a grid cell --
  // started a SECOND move from a read taken before the first one landed.
  it("a second mouseup while the drop's door is still reading moves nothing more: the drag was disarmed at the release", async () => {
    await mountOnDrill([
      { id: "id-Sales", name: "Sales", ephemeral: false },
      { id: "id-Costs", name: "Costs", ephemeral: false },
      { id: "id-Summary", name: "Summary", ephemeral: false },
      { id: "id-Q4", name: "Q4", ephemeral: false },
    ]);
    layOutTabs();
    await act(() => {
      tab(0).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 50 }));
    });
    await act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 330 })); // over Q4
    });
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 330 }));
    });
    // The drop's door has sent its fresh read; nothing has answered yet.
    expect(h.m.log).toEqual(["get_sheets"]);
    // The pointer moves on over Summary and the user clicks a cell: a mouseup anywhere.
    await act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 230 }));
    });
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 230 }));
    });
    await settle();
    expect(h.m.log.filter((l) => l.startsWith("move:")), "the released drag moved a sheet again").toEqual(["move:0->3"]);
    expect(names()).toEqual(["Costs", "Summary", "Q4", "Sales"]);
    expect(h.m.alerts).toEqual([]);
  });

  // Review TSHELL4-DRAG-STALE-APPLYSHEETSRESULT: the move was applied through the
  // applySheetsResult the listener closed over, which compared against the active
  // index from BEFORE the door's settle -- and replayed a switch onto Q4.
  it("a drop whose door waits out a discard that renumbers the ACTIVE sheet replays no switch onto the sheet the user is on", async () => {
    await leaveDrillDiscardInFlight(FIVE(), 4); // the user left the temporary sheet for Q4 (index 4 on screen)
    layOutTabs();
    const switches: unknown[] = [];
    const onSwitch = (e: Event) => switches.push((e as CustomEvent).detail);
    window.addEventListener("sheet:normalSwitch", onSwitch);
    try {
      await act(() => {
        tab(0).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 50 }));
      });
      await act(() => {
        document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 300 })); // over Summary
      });
      await act(async () => {
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 300 }));
      });
      await settle(); // the discard lands in the door's settle: Q4 goes from 4 to 3
    } finally {
      window.removeEventListener("sheet:normalSwitch", onSwitch);
    }
    expect(names()).toEqual(["Costs", "Summary", "Sales", "Q4"]);
    expect(h.m.log).toContain("move:0->2");
    expect(switches, "the move replayed a switch onto the sheet the user was already on").toEqual([]);
    expect(h.grid.state.sheetContext).toEqual({ activeSheetIndex: 3, activeSheetName: "Q4", activeSheetId: "id-Q4" });
  });
});

describe("Delete deletes the sheet its confirmation NAMES (a delete ends the undo history)", () => {
  it("the confirmation is open when the discard lands: Delete removes the sheet the prompt names, never the one that slid into its index", async () => {
    await leaveDrillDiscardInFlight();
    await rightClick(tab(3)); // Summary
    await press(button("Delete"));
    await tick();
    expect(promptNames()).toBe("Summary");
    await settle(); // the discard lands under the open prompt
    expect(names()).toEqual(["Sales", "Costs", "Summary", "Q4"]);
    expect(promptNames()).toBe("Summary");
    await press(button("Delete")); // the confirmation's Delete
    await settle();
    expect(names()).toEqual(["Sales", "Costs", "Q4"]);
    expect(removals()).toEqual([`discard:${DRILL}`, "delete:2[id-Summary]"]);
    expect(toasts).toEqual([]);
    expect(h.m.alerts).toEqual([]);
  });

  it("Delete confirmed while the discard is still in flight deletes the sheet the prompt names", async () => {
    await leaveDrillDiscardInFlight();
    await rightClick(tab(3)); // Summary
    await press(button("Delete"));
    await tick();
    expect(promptNames()).toBe("Summary");
    await press(button("Delete")); // before the discard's answer
    await settle();
    expect(names()).toEqual(["Sales", "Costs", "Q4"]);
    expect(removals()).toEqual([`discard:${DRILL}`, "delete:2[id-Summary]"]);
  });

  it("another door moves the sheets after the strip read them: the backend's id check refuses, NOTHING is deleted, and its sentence is a toast", async () => {
    await mountOnDrill([
      { id: "id-Sales", name: "Sales", ephemeral: false },
      { id: "id-Costs", name: "Costs", ephemeral: false },
      { id: "id-Summary", name: "Summary", ephemeral: false },
      { id: "id-Q4", name: "Q4", ephemeral: false },
    ]);
    const api = await import("../../../api");
    await rightClick(tab(2)); // Summary
    await press(button("Delete"));
    await tick();
    await press(button("Delete")); // the door sends its fresh read...
    await tick();
    expect(h.m.log[h.m.log.length - 1]).toBe("get_sheets");
    // ...and a script's move lands right behind it: Sales to the end, Q4 to index 2.
    void api.moveSheet(0, 3);
    await settle();
    expect(names()).toEqual(["Costs", "Summary", "Q4", "Sales"]);
    expect(removals()).toEqual(["delete:2[id-Summary]"]);
    expect(toasts.map((t) => t.message)).toEqual([
      "The sheets changed while that sheet was being deleted, so nothing was deleted.",
    ]);
    expect(h.m.alerts).toEqual([]);
  });

  it("core.sheet.delete (Excel's rule) on the active sheet, a discard in flight: the policy is asked about THAT sheet found again by id, and that sheet goes", async () => {
    await leaveDrillDiscardInFlight(FIVE(), 3); // the user left the temporary sheet for Summary
    vi.mocked(sheetDeleteNeedsConfirmation).mockResolvedValueOnce(false); // a blank sheet: no prompt
    await act(async () => {
      void CommandRegistry.execute(CoreCommands.SHEET_DELETE);
    });
    await settle();
    expect(vi.mocked(sheetDeleteNeedsConfirmation)).toHaveBeenCalledWith({ index: 2, kind: "worksheet" }, true);
    expect(names()).toEqual(["Sales", "Costs", "Q4"]);
    expect(removals()).toEqual([`discard:${DRILL}`, "delete:2[id-Summary]"]);
  });
});

describe("Move or Copy follows its sheets by id, and refuses when one is gone", () => {
  it("the discard lands while the dialog is open: OK copies the sheet the dialog was opened for", async () => {
    await leaveDrillDiscardInFlight();
    await rightClick(tab(3)); // Summary
    await press(button("Move or Copy..."));
    await tick();
    const data = lastMoveOrCopyDialog();
    expect(data.sourceName).toBe("Summary");
    expect(data.sheets.map((s) => s.name)).toContain("Drillthrough");
    await settle(); // the discard lands while the dialog is open
    await act(async () => {
      void data.onResult({ beforeSheetId: null, copy: true });
    });
    await settle();
    expect(names()).toEqual(["Sales", "Costs", "Summary", "Q4", "Summary (2)"]);
    expect(toasts).toEqual([]);
  });

  it("OK pressed while the discard is still in flight copies the sheet the user chose", async () => {
    await leaveDrillDiscardInFlight();
    await rightClick(tab(3)); // Summary
    await press(button("Move or Copy..."));
    await tick();
    const data = lastMoveOrCopyDialog();
    await act(async () => {
      void data.onResult({ beforeSheetId: null, copy: true });
    });
    await settle();
    expect(names()).toEqual(["Sales", "Costs", "Summary", "Q4", "Summary (2)"]);
  });

  it("the sheet to place it before is the temporary sheet being discarded: REFUSED with a toast -- never read as '(move to end)'", async () => {
    await leaveDrillDiscardInFlight([
      { id: "id-Sales", name: "Sales", ephemeral: false },
      { id: "id-Costs", name: "Costs", ephemeral: false },
      { id: DRILL, name: "Drillthrough", ephemeral: true },
      { id: "id-Summary", name: "Summary", ephemeral: false },
    ]);
    // The command line still sees Drillthrough at 2: Sales before it.
    await act(async () => {
      void CommandRegistry.execute(CoreCommands.SHEET_MOVE_OR_COPY, { index: 0, beforeIndex: 2, copy: false });
    });
    await settle();
    expect(names()).toEqual(["Sales", "Costs", "Summary"]);
    expect(h.m.log.filter((l) => l.startsWith("move:"))).toEqual([]);
    expect(toasts.map((t) => t.message)).toEqual([GONE_DRILL_ANCHOR("moved")]);
    expect(h.m.alerts).toEqual([]);
  });

  it("the dialog's 'before' row is the temporary sheet, gone by OK: refused with a toast that still names it", async () => {
    await leaveDrillDiscardInFlight([
      { id: "id-Sales", name: "Sales", ephemeral: false },
      { id: "id-Costs", name: "Costs", ephemeral: false },
      { id: DRILL, name: "Drillthrough", ephemeral: true },
      { id: "id-Summary", name: "Summary", ephemeral: false },
    ]);
    await rightClick(tab(0)); // Sales
    await press(button("Move or Copy..."));
    await tick();
    const data = lastMoveOrCopyDialog();
    const drillRow = data.sheets.find((s) => s.name === "Drillthrough");
    expect(drillRow, "the dialog lists the temporary sheet").toBeDefined();
    await settle(); // the discard lands while the dialog is open
    await act(async () => {
      void data.onResult({ beforeSheetId: drillRow!.sheetId, copy: false });
    });
    await settle();
    expect(names()).toEqual(["Sales", "Costs", "Summary"]);
    expect(h.m.log.filter((l) => l.startsWith("move:"))).toEqual([]);
    expect(toasts.map((t) => t.message)).toEqual([GONE_DRILL_ANCHOR("moved")]);
  });

  it("Move or Copy of the temporary sheet itself, its discard in flight, REFUSES with a toast instead of doing nothing silently", async () => {
    await leaveDrillDiscardInFlight();
    await act(async () => {
      void CommandRegistry.execute(CoreCommands.SHEET_MOVE_OR_COPY, { index: 1, beforeIndex: null, copy: true });
    });
    await settle();
    expect(names()).toEqual(["Sales", "Costs", "Summary", "Q4"]);
    expect(h.m.log.filter((l) => l.startsWith("copy:"))).toEqual([]);
    expect(toasts.map((t) => t.message)).toEqual([GONE_DRILL("copied")]);
    expect(h.m.alerts).toEqual([]);
  });
});

describe("Unhide unhides the sheet its dialog listed", () => {
  it("the discard lands while the Unhide dialog is open: the double-clicked row's sheet is unhidden, never the one that slid into its index", async () => {
    await mountOnDrill([
      { id: "id-Sales", name: "Sales", ephemeral: false },
      { id: DRILL, name: "Drillthrough", ephemeral: true },
      { id: "id-Costs", name: "Costs", ephemeral: false },
      { id: "id-Archive", name: "Archive", ephemeral: false, visibility: "hidden" },
      { id: "id-Old", name: "Old", ephemeral: false, visibility: "hidden" },
    ]);
    await act(async () => {
      void CommandRegistry.execute(CoreCommands.SHEET_UNHIDE);
    });
    await settle(); // the dialog lists Archive (3) and Old (4)
    const row = () =>
      Array.from(container.querySelectorAll("div")).find(
        (d) => d.children.length === 0 && d.textContent === "Archive",
      ) as HTMLDivElement | undefined;
    expect(row(), "the Unhide dialog lists Archive").toBeDefined();
    // Another door moves the user to Sales; the leave's discard lands while the dialog is open.
    h.m.activeId = "id-Sales";
    window.dispatchEvent(new CustomEvent("app:sheet-changed"));
    await settle();
    expect(removals()).toEqual([`discard:${DRILL}`]);
    await fire(row()!, "dblclick");
    await settle();
    expect(h.m.log).toContain("unhide:2");
    expect(sheetById("id-Archive")?.visibility).toBe("visible");
    expect(sheetById("id-Old")?.visibility).toBe("hidden");
  });
});

// ============================================================================
// Review round 4: an edit that opens INSIDE a door's or a discard's wait
// ============================================================================

/** A cell edit on the sheet with this TRUE index and name. */
const editOn = (sourceSheetIndex: number, sourceSheetName: string, value: string) => ({
  value,
  row: 1,
  col: 1,
  sourceSheetIndex,
  sourceSheetName,
});
const copies = () => h.m.log.filter((l) => l.startsWith("copy:"));
/** The discard door's refusal while a plain cell edit is open or opening (SheetTabs.tsx `DISCARD_UNDER_EDIT`). */
const DISCARD_UNDER_EDIT =
  "Finish editing the cell first: the temporary sheet cannot be closed while a cell is being edited.";

// Review TSHELL4-DOOR-WAIT-SKIPS-STRUCTURAL-LOCK: the lock was asked only when a
// door STARTED. A formula edit opened during its wait holds its source sheet by
// INDEX, and the door's copy renumbered that sheet under it.
describe("a door asks the structural lock again after its wait", () => {
  it("Duplicate Sheet waiting on a discard in flight, '=SUM(' opening meanwhile: nothing is copied, one toast, the grid stays where it was", async () => {
    await leaveDrillDiscardInFlight(); // the user left the temporary sheet for Sales
    await rightClick(tab(3)); // Summary
    await press(button("Duplicate Sheet")); // the door waits on the sent discard...
    await setEditing(editOn(0, "Sales", "=SUM(")); // ...and a formula opens on Sales
    await settle();
    expect(copies(), "the door copied under an open formula edit").toEqual([]);
    expect(names()).toEqual(["Sales", "Costs", "Summary", "Q4"]);
    expect(toasts.map((t) => t.message)).toEqual([STRUCTURE_LOCKED]);
    expect(h.grid.state.sheetContext).toEqual({ activeSheetIndex: 0, activeSheetName: "Sales", activeSheetId: "id-Sales" });
    expect(h.m.alerts).toEqual([]);
  });

  it("the edit opens during the door's OWN fresh read (no discard anywhere): refused the same way", async () => {
    await mountOnDrill([
      { id: "id-Sales", name: "Sales", ephemeral: false },
      { id: "id-Costs", name: "Costs", ephemeral: false },
      { id: "id-Summary", name: "Summary", ephemeral: false },
    ]);
    await act(async () => {
      window.dispatchEvent(new CustomEvent("sheet:requestCopy", { detail: { index: 2, sheetId: "id-Summary" } }));
    });
    expect(h.m.log, "the door's fresh read is sent and not answered").toEqual(["get_sheets"]);
    await setEditing(editOn(0, "Sales", "=SUM("));
    await settle();
    expect(copies()).toEqual([]);
    expect(names()).toEqual(["Sales", "Costs", "Summary"]);
    expect(toasts.map((t) => t.message)).toEqual([STRUCTURE_LOCKED]);
  });

  it("a formula keystroke the strip has NOT rendered yet still refuses: the lock is read from Core's synchronous globals too", async () => {
    await mountOnDrill([
      { id: "id-Sales", name: "Sales", ephemeral: false },
      { id: "id-Costs", name: "Costs", ephemeral: false },
      { id: "id-Summary", name: "Summary", ephemeral: false },
    ]);
    await act(async () => {
      window.dispatchEvent(new CustomEvent("sheet:requestCopy", { detail: { index: 2, sheetId: "id-Summary" } }));
    });
    // The keystroke moved Core's synchronous formula state; nothing re-rendered the strip.
    h.grid.state = { ...h.grid.state, editing: editOn(0, "Sales", "=SUM(") };
    await settle();
    expect(copies(), "the door asked only the lock its last render saw").toEqual([]);
    expect(toasts.map((t) => t.message)).toEqual([STRUCTURE_LOCKED]);
  });
});

// Review TSHELL4-DISCARD-LANDS-UNDER-OPEN-EDIT: a discard landing under an open
// edit renumbers the sheet being edited, and the edit commits into whichever
// sheet slid into its index. Core rebases the edit (its own fix); the strip
// narrows the window from both ends.
describe("a temporary sheet's discard is never sent under a cell edit that is open or OPENING", () => {
  it.each([
    ["the typed-open latch (the first keystroke, before the guards answered)", "latch"],
    ["Core's edit flag (past the guards, before the editing state)", "flag"],
  ] as const)("a leave read answering while an edit is opening -- %s -- is not judged; the edit closing re-reads once and discards", async (_label, phase) => {
    await mountOnDrill();
    await fire(tab(0), "click"); // leave for Sales
    await deliverUntil(() => h.m.log.includes("get_sheets")); // the leave read is SENT...
    // ...and the user types into a cell on Sales at once: the open is in flight.
    if (phase === "latch") beginEditorOpen("1");
    else h.m.coreEditFlag = true;
    await settle(); // the read answers while the edit is opening
    expect(removals(), "a discard was sent while an edit was opening").toEqual([]);
    // The open completes, and Enter closes the edit.
    await setEditing(editOn(0, "Sales", "1"));
    abortEditorOpen();
    h.m.coreEditFlag = false;
    await setEditing(null);
    await settle();
    expect(removals()).toEqual([`discard:${DRILL}`]);
    expect(names()).toEqual(["Sales", "Costs", "Summary"]);
  });

  it("core.sheet.discardEphemeral with a plain edit open ON the temporary sheet: nothing is sent, one toast, false -- and the edit closing there discards nothing", async () => {
    await mountOnDrill();
    await setEditing(editOn(3, "Drillthrough", "abc"));
    const run = CommandRegistry.execute(DISCARD_COMMAND, { sheetId: DRILL });
    await settle();
    expect(removals(), "the discard was sent under an open edit").toEqual([]);
    await expect(run).resolves.toBe(false);
    expect(toasts.map((t) => t.message)).toEqual([DISCARD_UNDER_EDIT]);
    // The owed leave is settled by a fresh read once the edit closes: the user is
    // still ON the temporary sheet, so it stays.
    const mark = h.m.log.length;
    await setEditing(null);
    await settle();
    expect(h.m.log.slice(mark)).toContain("get_sheets");
    expect(removals()).toEqual([]);
    expect(names()).toContain("Drillthrough");
    // Leaving it afterwards is an ordinary leave.
    await fire(tab(0), "click");
    await settle();
    expect(removals()).toEqual([`discard:${DRILL}`]);
  });

  it("core.sheet.discardEphemeral while an edit is OPENING (no editing state yet): nothing is sent, one toast, false", async () => {
    await mountOnDrill();
    beginEditorOpen("x");
    const run = CommandRegistry.execute(DISCARD_COMMAND, { sheetId: DRILL });
    await settle();
    expect(removals(), "the discard was sent while an edit was opening").toEqual([]);
    await expect(run).resolves.toBe(false);
    expect(toasts.map((t) => t.message)).toEqual([DISCARD_UNDER_EDIT]);
  });

  it("core.sheet.discardEphemeral held by a door while '=SUM(' opens: it resolves false with the lock's sentence, and nothing is sent", async () => {
    await mountOnDrill();
    // A door is in flight: Tab Color on Sales.
    await act(async () => {
      void getSheetTabsController()!.setTabColor(0, "#FF0000");
    });
    const run = CommandRegistry.execute(DISCARD_COMMAND, { sheetId: DRILL });
    await tick();
    expect(removals(), "the door holds the discard").toEqual([]);
    // The door's read answers and its step is sent...
    await deliverUntil(() => h.m.log.some((l) => l.startsWith("tabColor:")));
    // ...and a formula opens on the temporary sheet before the door settles.
    await setEditing(editOn(3, "Drillthrough", "=SUM("));
    await settle();
    expect(removals(), "the held discard went out under the open formula edit").toEqual([]);
    await expect(run).resolves.toBe(false);
    expect(toasts.map((t) => t.message)).toEqual([STRUCTURE_LOCKED]);
    expect(sheetById("id-Sales")?.tabColor).toBe("#FF0000");
  });
});

// Review DRAG-DISARM-MAKES-THE-DROP-A-CLICK (round 5): round 4 disarmed a drag
// AT its mouseup (TSHELL4-DRAG-STATE-ARMED-DURING-DOOR), and React commits that
// before the browser dispatches the click that follows the release -- so the
// strip's "a finished drag is not a click" guards saw no drag, and a drop
// released over the dragged tab switched to it, or with Ctrl grouped it, by its
// PRE-move index while the move was in flight. Every event below is dispatched
// in the browser's order, each in its own act(): mousedown, mousemove past the
// threshold, mouseup ON the dragged tab, then the click on it.
describe("a finished drag is not a click (browser order: the mouseup, THEN the click)", () => {
  const FOUR = (): LayoutSheet[] => [
    { id: "id-Sales", name: "Sales", ephemeral: false },
    { id: "id-Costs", name: "Costs", ephemeral: false },
    { id: "id-Summary", name: "Summary", ephemeral: false },
    { id: "id-Q4", name: "Q4", ephemeral: false },
  ];

  /** Lay the rendered tabs out 100 px apart (jsdom lays nothing out): tab i spans [i*100, i*100+100), its midpoint i*100+50. */
  function layOutTabs(): void {
    const tabs = Array.from(container.querySelectorAll("button[data-sheet-tab]")) as HTMLElement[];
    tabs.forEach((el, i) => {
      Object.defineProperty(el, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ left: i * 100, right: i * 100 + 100, width: 100, top: 0, bottom: 20, height: 20, x: i * 100, y: 0, toJSON() {} }),
      });
    });
  }

  // Each event in its OWN act(), and none of them awaited: a sync act() has
  // already flushed React's work (the drag's disarm included) when it
  // returns, and AWAITING its thenable runs React's act task queue -- a
  // macrotask -- in which the release's timer can fire before the click. In
  // Chromium the click is dispatched in the mouseup's own task, so no timer
  // can run between them; nor may one here.
  const press = (el: Element, clientX: number, init: MouseEventInit = {}): void => {
    act(() => {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX, ...init }));
    });
  };
  const moveTo = (clientX: number): void => {
    act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX }));
    });
  };
  const release = (el: Element, clientX: number, init: MouseEventInit = {}): void => {
    act(() => {
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, clientX, ...init }));
    });
  };
  const clickOn = (el: Element, init: MouseEventInit = {}): void => {
    act(() => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }));
    });
  };
  const activations = () => h.m.log.filter((l) => l.startsWith("activate:"));

  it("a plain drag of a non-active tab, released over its own right half: the drop's click switches NOTHING, and the move lands", async () => {
    await mountOnDrill(FOUR()); // Sales active
    layOutTabs();
    const costs = tab(1);
    press(costs, 120);
    moveTo(170); // past Costs' midpoint: the drop target is already Summary
    release(costs, 170);
    clickOn(costs);
    expect(activations(), "the drop's click switched to the dragged tab").toEqual([]);
    await settle();
    expect(h.m.log).toContain("move:1->2");
    expect(names()).toEqual(["Sales", "Summary", "Costs", "Q4"]);
    expect(activations()).toEqual([]);
    expect(h.grid.state.sheetContext.activeSheetName).toBe("Sales");
  });

  it("a Ctrl+drag of a non-active tab: the drop's Ctrl+click groups NOTHING", async () => {
    await mountOnDrill(FOUR());
    layOutTabs();
    const costs = tab(1);
    press(costs, 120, { ctrlKey: true });
    moveTo(170);
    release(costs, 170, { ctrlKey: true });
    clickOn(costs, { ctrlKey: true });
    expect(h.m.groupToggles, "the drop's Ctrl+click grouped the dragged sheet by its pre-move index").toEqual([]);
    expect(activations()).toEqual([]);
    await settle();
    expect(h.m.log).toContain("move:1->2");
    expect(h.m.groupToggles).toEqual([]);
  });

  it("a Ctrl+drag of the ACTIVE tab: the drop's Ctrl+click groups nothing either", async () => {
    await mountOnDrill(FOUR());
    layOutTabs();
    const sales = tab(0);
    press(sales, 20, { ctrlKey: true });
    moveTo(70); // past Sales' midpoint: the drop target is Costs
    release(sales, 70, { ctrlKey: true });
    clickOn(sales, { ctrlKey: true });
    expect(h.m.groupToggles).toEqual([]);
    await settle();
    expect(h.m.log).toContain("move:0->1");
  });

  it("a drag released back on its own tab (no move): the click is still a finished drag's -- ignored", async () => {
    await mountOnDrill(FOUR());
    layOutTabs();
    const costs = tab(1);
    press(costs, 120);
    moveTo(135); // past the 5 px threshold, still on Costs' left half
    release(costs, 135);
    clickOn(costs);
    await settle();
    expect(activations(), "a drag released on its own tab switched to it").toEqual([]);
    expect(h.m.log.filter((l) => l.startsWith("move:"))).toEqual([]);
  });

  it("the same, dispatched OUTSIDE act with only a microtask between the mouseup and the click (React's discrete flush): ignored", async () => {
    await mountOnDrill(FOUR());
    layOutTabs();
    const costs = tab(1);
    press(costs, 120);
    moveTo(170);
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
    try {
      costs.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, clientX: 170 }));
      await Promise.resolve();
      await Promise.resolve();
      costs.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    } finally {
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    }
    await settle();
    expect(activations()).toEqual([]);
    expect(h.m.log).toContain("move:1->2");
  });

  it("control: a genuine click AFTER the drop -- a new press, no movement -- still switches", async () => {
    await mountOnDrill(FOUR());
    layOutTabs();
    const costs = tab(1);
    press(costs, 120);
    moveTo(170);
    release(costs, 170);
    clickOn(costs);
    await settle(); // the move lands: Sales, Summary, Costs, Q4
    layOutTabs();
    const q4 = tab(3);
    expect(q4.textContent).toBe("Q4");
    press(q4, 350);
    release(q4, 350);
    clickOn(q4);
    expect(activations()).toEqual(["activate:3"]);
    await settle();
    expect(h.grid.state.sheetContext.activeSheetName).toBe("Q4");
  });

  it("a release whose click never reached a tab is forgotten by the NEXT press: that gesture's click switches", async () => {
    await mountOnDrill(FOUR());
    layOutTabs();
    press(tab(1), 120);
    moveTo(260);
    release(tab(2), 260); // the browser sends this click to the tabs' common ancestor: none reaches a tab
    // At once -- before the release's timer -- the user clicks Summary.
    press(tab(2), 250);
    release(tab(2), 250);
    clickOn(tab(2));
    expect(activations(), "a stale drop swallowed a genuine click").toEqual(["activate:2"]);
    await settle();
  });

  it("a release whose click never reached a tab is forgotten after its turn: a later click switches", async () => {
    await mountOnDrill(FOUR());
    layOutTabs();
    press(tab(1), 120);
    moveTo(260);
    release(tab(2), 260);
    await settle(); // the release's turn is over; the move lands: Sales, Summary, Q4, Costs
    layOutTabs();
    clickOn(tab(2)); // a click with no press of its own (a keyboard- or script-driven one)
    expect(activations(), "a stale drop swallowed a later click").toEqual(["activate:2"]);
    await settle();
  });
});

// Review F3-strip-uses-owner-host-index (round 5): the strip decided "is this
// the parked edit's host tab" by the owner's OPENING index, and marked the
// source tab by it. After a renumbering under a parked edit, a click on the
// host's own tab was ignored, a canvas that slid into the host's old index was
// accepted, and the source marker sat on the wrong tab.
describe("the external session's host tab, by identity", () => {
  /** A floating grid on canvas Report (index 3 when its edit opened), parked on Sales; Board is another canvas. */
  const LAYOUT = (): LayoutSheet[] =>
    [
      { id: "id-Sales", name: "Sales", ephemeral: false },
      { id: "id-Q4", name: "Q4", ephemeral: false },
      { id: "id-Costs", name: "Costs", ephemeral: false },
      { id: "id-Report", name: "Report", ephemeral: false, kind: "canvas" },
      { id: "id-Board", name: "Board", ephemeral: false, kind: "canvas" },
    ] as LayoutSheet[];

  async function parkedThenRenumbered(): Promise<void> {
    h.m.session = { hostId: "id-Report", openedAt: 3, parked: true, expecting: false };
    await mountOnDrill(LAYOUT());
    // An MCP / script delete of Q4 lands while the edit is parked: Report 3 -> 2, Board slides into 3.
    h.ops.removeAt(1);
    h.announceSheets();
    await settle();
    expect(names()).toEqual(["Sales", "Costs", "Report", "Board"]);
  }

  it("a click on the host's OWN tab at its new index brings the parked edit back", async () => {
    await parkedThenRenumbered();
    await fire(tab(2), "click");
    expect(h.m.log, "the host's own tab was ignored").toContain("point:2");
    await settle();
  });

  it("a click on the canvas that slid into the host's OLD index is refused (a canvas is no reference target)", async () => {
    await parkedThenRenumbered();
    await fire(tab(3), "click");
    expect(h.m.log.filter((l) => l.startsWith("point:") || l.startsWith("activate:"))).toEqual([]);
  });

  it("the source marker sits on the host's tab (found by identity), not on the tab at its opening index", async () => {
    await parkedThenRenumbered();
    expect(tab(2).title).toContain("Formula source: Report");
    expect(tab(3).title).not.toContain("Formula source");
  });
});

describe("Core's own edit: the source marker by identity", () => {
  it("a point-mode edit whose sheet was renumbered: the marker is on the edit's sheet, not on the tab at its stored index", async () => {
    await mountOnDrill([
      { id: "id-Sales", name: "Sales", ephemeral: false },
      { id: "id-Costs", name: "Costs", ephemeral: false },
      { id: "id-Summary", name: "Summary", ephemeral: false },
      { id: "id-Q4", name: "Q4", ephemeral: false },
    ]);
    // "=" typed on Summary when it was sheet 3; the grid now shows Sales (point mode), and Summary is sheet 2.
    await setEditing({ value: "=", row: 0, col: 0, sourceSheetIndex: 3, sourceSheetName: "Summary", sourceSheetId: "id-Summary" });
    expect(tab(2).title, "the marker is not on the edit's own sheet").toContain("Formula source: Summary");
    expect(tab(3).title).not.toContain("Formula source");
  });
});

// Review F1-rename-refuses-entry (round 5): an open edit follows its sheet by
// the STABLE id Core's sheet context carries -- which only works if the strip
// hands that id over in every dispatch. The strip's re-read after a rename is
// the path a rename of the edited sheet takes.
describe("the strip moves Core's sheet context WITH the sheet's stable id", () => {
  const FOUR_SHEETS = (): LayoutSheet[] => [
    { id: "id-Sales", name: "Sales", ephemeral: false },
    { id: "id-Costs", name: "Costs", ephemeral: false },
    { id: "id-Summary", name: "Summary", ephemeral: false },
    { id: "id-Q4", name: "Q4", ephemeral: false },
  ];

  it("a rename's re-read (sheets:refresh) arrives at the SAME id under the new name", async () => {
    await mountOnDrill(FOUR_SHEETS());
    expect(h.grid.state.sheetContext).toEqual({ activeSheetIndex: 0, activeSheetName: "Sales", activeSheetId: "id-Sales" });
    h.ops.rename(0, "Data");
    h.announceSheets();
    await settle();
    expect(h.grid.state.sheetContext, "the re-read moved the context without the sheet's id").toEqual({
      activeSheetIndex: 0,
      activeSheetName: "Data",
      activeSheetId: "id-Sales",
    });
  });

  it("a temporary sheet's discard that renumbers the destination carries its id -- in the discard's OWN dispatch, before any re-read", async () => {
    await mountOnDrill([
      { id: "id-Sales", name: "Sales", ephemeral: false },
      { id: DRILL, name: "Drillthrough", ephemeral: true },
      { id: "id-Costs", name: "Costs", ephemeral: false },
      { id: "id-Summary", name: "Summary", ephemeral: false },
    ]);
    await fire(tab(3), "click"); // leave the temporary sheet for Summary (3)
    // The discard lands: Summary 3 -> 2. Stop the moment its own dispatch moved
    // the context, before the re-read the discard announced has answered.
    await deliverUntil(() => h.grid.state.sheetContext.activeSheetIndex === 2);
    expect(h.grid.state.sheetContext, "the discard's dispatch dropped the sheet's id").toEqual({
      activeSheetIndex: 2,
      activeSheetName: "Summary",
      activeSheetId: "id-Summary",
    });
    await settle();
    expect(removals()).toEqual([`discard:${DRILL}`]);
  });

  it("a tab click's switch carries the clicked sheet's id -- in its OWN dispatch, before any re-read", async () => {
    await mountOnDrill(FOUR_SHEETS());
    await fire(tab(2), "click");
    // Stop the moment the click's own switch landed: the re-read its
    // SHEET_CHANGED triggers has not answered yet, so this is the click's dispatch.
    await deliverUntil(() => h.grid.state.sheetContext.activeSheetIndex === 2);
    expect(h.grid.state.sheetContext, "the click's switch dropped the sheet's id").toEqual({
      activeSheetIndex: 2,
      activeSheetName: "Summary",
      activeSheetId: "id-Summary",
    });
    await settle();
  });
});

// Review DRAG-DISARM-MAKES-THE-DROP-A-CLICK, refinement (2): the drop's click
// must be ignored BEFORE the strip's "a normal click clears the sheet group"
// step -- otherwise a drag released on its own tab (no move) still clears a
// group the user made on purpose.
// Review revG#4 (BUG-0350): the strip kept its OWN copy of the sheet group in
// React state, so a group Core ended -- an ordinary switch (Name Box, Go To, a
// link, the command line) to a sheet outside it, which Excel ungroups on --
// went on being highlighted. The strip now paints Core's group.
describe("the strip paints Core's sheet group (review revG#4)", () => {
  // SABOTAGE: subscribe to nothing (`useSyncExternalStore(() => () => {}, ...)`)
  // -> the strip never hears the group change.
  it("a group Core holds shows [Group]; Core ending it on a switch outside it stops showing it at once", async () => {
    await mountOnDrill([
      { id: "id-Sales", name: "Sales", ephemeral: false },
      { id: "id-Costs", name: "Costs", ephemeral: false },
      { id: "id-Summary", name: "Summary", ephemeral: false },
    ]);
    try {
      expect(container.textContent).not.toContain("[Group]");
      act(() => setCoreSheetGroup([0, 2]));
      expect(container.textContent, "the strip does not show the group Core holds").toContain("[Group]");
      // A switch to a member keeps it...
      act(() => endSheetGroupUnlessMember(2));
      expect(container.textContent).toContain("[Group]");
      // ...a switch outside it ends it, and the strip follows.
      act(() => endSheetGroupUnlessMember(1));
      expect(container.textContent, "the strip still highlights a group Core ended").not.toContain("[Group]");
    } finally {
      act(() => clearCoreSheetGroup());
    }
  });
});

describe("a drag's click never clears an existing sheet group", () => {
  function layOutTabs(): void {
    const tabs = Array.from(container.querySelectorAll("button[data-sheet-tab]")) as HTMLElement[];
    tabs.forEach((el, i) => {
      Object.defineProperty(el, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ left: i * 100, right: i * 100 + 100, width: 100, top: 0, bottom: 20, height: 20, x: i * 100, y: 0, toJSON() {} }),
      });
    });
  }
  // Each in its own act(), none awaited (see the drag-click block above).
  const send = (el: Element | Document, type: string, init: MouseEventInit = {}): void => {
    act(() => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
    });
  };

  it("Sales + Costs grouped, then Summary dragged and released back on its own tab: the group stands, and nothing switches", async () => {
    await mountOnDrill([
      { id: "id-Sales", name: "Sales", ephemeral: false },
      { id: "id-Costs", name: "Costs", ephemeral: false },
      { id: "id-Summary", name: "Summary", ephemeral: false },
      { id: "id-Q4", name: "Q4", ephemeral: false },
    ]);
    layOutTabs();
    // A genuine Ctrl+click on Costs groups Sales and Costs.
    h.m.nextGroup = [0, 1];
    send(tab(1), "mousedown", { clientX: 120, ctrlKey: true });
    send(tab(1), "mouseup", { clientX: 120, ctrlKey: true });
    send(tab(1), "click", { ctrlKey: true });
    expect(h.m.groupToggles).toEqual([[1, 0]]);
    await settle();
    // A plain drag of Summary, released back on Summary (no move), then its click.
    send(tab(2), "mousedown", { clientX: 220 });
    send(document, "mousemove", { clientX: 235 });
    send(tab(2), "mouseup", { clientX: 235 });
    send(tab(2), "click");
    expect(h.m.groupClears, "the drop's click cleared the group").toBe(0);
    expect(h.m.log.filter((l) => l.startsWith("activate:"))).toEqual([]);
    await settle();
  });

  // Review RESOLVETABCLICK-DRAGGING-DEAD (round 6): resolveTabClick no longer
  // takes a drag input -- its rule was dead, the strip had always returned
  // first. The strip's SECOND early return refuses a click that lands while a
  // drag is still ARMED: the button held past the threshold, no release yet,
  // and a keyboard-driven click (Enter / Space on a focused tab). Like the
  // finished drag's click it must be refused before the group-clearing step.
  it("a click while a drag is still ARMED (a keyboard click mid-drag): nothing switches, and the group stands", async () => {
    await mountOnDrill([
      { id: "id-Sales", name: "Sales", ephemeral: false },
      { id: "id-Costs", name: "Costs", ephemeral: false },
      { id: "id-Summary", name: "Summary", ephemeral: false },
      { id: "id-Q4", name: "Q4", ephemeral: false },
    ]);
    layOutTabs();
    h.m.nextGroup = [0, 1];
    send(tab(1), "mousedown", { clientX: 120, ctrlKey: true });
    send(tab(1), "mouseup", { clientX: 120, ctrlKey: true });
    send(tab(1), "click", { ctrlKey: true });
    expect(h.m.groupToggles).toEqual([[1, 0]]);
    await settle();
    // Summary pressed and dragged past the threshold, the button still held...
    send(tab(2), "mousedown", { clientX: 220 });
    send(document, "mousemove", { clientX: 260 });
    // ...when a keyboard click lands on Q4 (no press of its own).
    send(tab(3), "click");
    expect(h.m.log.filter((l) => l.startsWith("activate:")), "a click mid-drag switched sheets").toEqual([]);
    expect(h.m.groupClears, "a click mid-drag cleared the group").toBe(0);
    // The release ends the drag.
    send(tab(2), "mouseup", { clientX: 260 });
    await settle();
    expect(h.m.log.filter((l) => l.startsWith("activate:"))).toEqual([]);
  });
});

// The strip's other switching doors hand Core the sheet's STABLE id in their
// own dispatch too (review F1-rename-refuses-entry). Each test stops the
// moment the door's own dispatch landed -- before the re-read its wrapper's
// announcement triggers has answered, which would re-supply the id.
describe("the strip's switching doors carry the sheet's stable id in their own dispatch", () => {
  const FOUR_SHEETS = (): LayoutSheet[] => [
    { id: "id-Sales", name: "Sales", ephemeral: false },
    { id: "id-Costs", name: "Costs", ephemeral: false },
    { id: "id-Summary", name: "Summary", ephemeral: false },
    { id: "id-Q4", name: "Q4", ephemeral: false },
  ];

  it("the \"+\" (append): the new sheet's id", async () => {
    await mountOnDrill(FOUR_SHEETS());
    void getSheetTabsController()!.appendSheet();
    await deliverUntil(() => h.grid.state.sheetContext.activeSheetName === "Sheet1");
    expect(h.grid.state.sheetContext, "the append's switch dropped the sheet's id").toEqual({
      activeSheetIndex: 4,
      activeSheetName: "Sheet1",
      activeSheetId: "id-Sheet1",
    });
    await settle();
  });

  it("Insert Sheet (an add, a move, then the apply): the new sheet's id", async () => {
    await mountOnDrill(FOUR_SHEETS());
    void getSheetTabsController()!.insertSheetBefore(0);
    await deliverUntil(
      () => h.grid.state.sheetContext.activeSheetName === "Sheet1" && h.grid.state.sheetContext.activeSheetIndex === 0,
    );
    expect(h.grid.state.sheetContext, "the insert's apply dropped the sheet's id").toEqual({
      activeSheetIndex: 0,
      activeSheetName: "Sheet1",
      activeSheetId: "id-Sheet1",
    });
    await settle();
  });

  it("Delete of the active sheet: the sheet the backend lands on, with its id", async () => {
    await mountOnDrill(FOUR_SHEETS());
    await rightClick(tab(0)); // Sales, the active sheet
    await press(button("Delete"));
    await tick();
    expect(promptNames()).toBe("Sales");
    await press(button("Delete")); // the confirmation's Delete
    await deliverUntil(() => h.grid.state.sheetContext.activeSheetName === "Costs");
    expect(h.grid.state.sheetContext, "the delete's switch dropped the sheet's id").toEqual({
      activeSheetIndex: 0,
      activeSheetName: "Costs",
      activeSheetId: "id-Costs",
    });
    await settle();
    expect(names()).toEqual(["Costs", "Summary", "Q4"]);
  });
});

// BUG-0616 item 6: what a tab click does to a group of selected sheets, as
// Excel 16 does it [LIVE, 2026-10-30, real mouse clicks on a visible instance;
// resolveTabClick.ts SHEET GROUP CLICKS]. The strip ended the group on EVERY
// plain click -- the active tab and a member's included -- and took a
// Shift+click for a plain one.
describe("a tab click and the sheet group, as Excel does it (BUG-0616 item 6)", () => {
  const FOUR: LayoutSheet[] = [
    { id: "id-Sales", name: "Sales", ephemeral: false },
    { id: "id-Costs", name: "Costs", ephemeral: false },
    { id: "id-Summary", name: "Summary", ephemeral: false },
    { id: "id-Q4", name: "Q4", ephemeral: false },
  ];
  /** Mount on Sales (index 0) with `group` selected, as Core holds it. */
  async function mountGrouped(group: number[], layout: LayoutSheet[] = FOUR): Promise<void> {
    await mountOnDrill(layout);
    h.m.activeId = "id-Sales";
    h.m.group = [...group];
    h.m.groupClears = 0;
  }
  const clickTab = (index: number, init: MouseEventInit = {}) =>
    act(() => {
      tab(index).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
    });
  const activations = () => h.m.log.filter((l) => l.startsWith("activate:"));

  it("some sheets grouped: a plain click on ANOTHER member switches to it and KEEPS the group", async () => {
    await mountGrouped([0, 2]);
    await clickTab(2);
    await settle();
    expect(activations()).toEqual(["activate:2"]);
    expect(h.m.groupClears, "a click on a member of the group ended it (Excel keeps it)").toBe(0);
    expect(h.m.group).toEqual([0, 2]);
  });

  it("a plain click on the ACTIVE tab changes nothing, the group included -- all sheets grouped too", async () => {
    await mountGrouped([0, 1, 2, 3]);
    await clickTab(0);
    await settle();
    expect(activations()).toEqual([]);
    expect(h.m.groupClears, "a click on the active tab ended the group").toBe(0);
    expect(h.m.group).toEqual([0, 1, 2, 3]);
  });

  it("EVERY visible tab grouped: a plain click on another member ends the group and switches", async () => {
    await mountGrouped([0, 1, 2, 3]);
    await clickTab(2);
    await settle();
    expect(activations()).toEqual(["activate:2"]);
    expect(h.m.groupClears).toBe(1);
    expect(h.m.group).toEqual([]);
  });

  it("every VISIBLE tab grouped (the fourth hidden): a member click ends the group as well", async () => {
    await mountGrouped([0, 1, 2], [...FOUR.slice(0, 3), { ...FOUR[3], visibility: "hidden" }]);
    await clickTab(2);
    await settle();
    expect(h.m.groupClears).toBe(1);
    expect(h.m.group).toEqual([]);
  });

  it("a plain click on a tab OUTSIDE the group ends it and switches", async () => {
    await mountGrouped([0, 2]);
    await clickTab(1);
    await settle();
    expect(activations()).toEqual(["activate:1"]);
    expect(h.m.groupClears).toBe(1);
    expect(h.m.group).toEqual([]);
  });

  it("Shift+click selects the sheets from the active one to the clicked one, the active sheet unchanged", async () => {
    await mountGrouped([]);
    await clickTab(2, { shiftKey: true });
    await settle();
    expect(h.m.group, "Shift+click did not select the range of sheets").toEqual([0, 1, 2]);
    expect(activations(), "Shift+click switched sheets").toEqual([]);
  });

  it("Shift+click passes over a hidden sheet, and replaces an existing group", async () => {
    await mountGrouped([0, 3], [FOUR[0], { ...FOUR[1], visibility: "hidden" }, FOUR[2], FOUR[3]]);
    await clickTab(2, { shiftKey: true });
    await settle();
    expect(h.m.group).toEqual([0, 2]);
    expect(activations()).toEqual([]);
  });

  it("Shift+click on the active tab leaves that sheet alone selected", async () => {
    await mountGrouped([0, 2]);
    await clickTab(0, { shiftKey: true });
    await settle();
    expect(h.m.group).toEqual([]);
    expect(activations()).toEqual([]);
  });
});
