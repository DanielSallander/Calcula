//! FILENAME: app/extensions/BuiltIn/FormatPainter/__tests__/formatPainterLockAndStart.test.ts
// PURPOSE: Format Painter's two commands behave like Excel's button, so the
//          Home tab can send FORMAT_PAINTER on a click and FORMAT_PAINTER_LOCK
//          on a double-click:
//            - LOCK on an ACTIVE painter upgrades it to locked (it used to
//              switch it OFF: activation toggled whatever was running);
//            - a second activation while one is still STARTING (reading its
//              source cells) is ignored -- it used to register a second set of
//              listeners, so every later paint was TWO undo steps -- and a
//              LOCK arriving then makes the starting painter a locked one (a
//              double-click's second click lands exactly there);
//            - Escape while it is starting cancels it;
//            - every transition is published through @api/formatPainterState,
//              so the ribbon can draw the button pressed (and locked).
// CONTEXT: Home tab = Excel's Home tab, clipboard lane (2026-10-04; survey
//          clipboard.md section 7). Driven through the extension's REAL
//          commands and logic; the backend and the selection registry are
//          doubles that behave like the real ones (the registry only adds a
//          listener on subscribe).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  listeners: new Set<(s: unknown) => void>(),
  setCellStyle: vi.fn(async (_r: number, _c: number, _s: number) => {}),
  begins: [] as string[],
  /** When set, getCell waits for this before answering (a slow source read). */
  gate: null as Promise<void> | null,
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  getCell: vi.fn(async () => {
    if (h.gate) await h.gate;
    return { styleIndex: 7 };
  }),
  setCellStyle: (r: number, c: number, s: number) => h.setCellStyle(r, c, s),
  beginUndoTransaction: vi.fn(async (label: string) => {
    h.begins.push(label);
    return h.begins.length;
  }),
  commitUndoTransaction: vi.fn(async () => {}),
  cancelUndoTransaction: vi.fn(async () => {}),
  dispatchGridAction: vi.fn(),
  restoreFocusToGrid: vi.fn(),
  registerEditGuard: () => () => {},
  // eslint-disable-next-line @typescript-eslint/naming-convention -- the real export name
  ExtensionRegistry: {
    onSelectionChange: (cb: (s: unknown) => void) => {
      h.listeners.add(cb);
      return () => h.listeners.delete(cb);
    },
  },
}));
vi.mock("@api/ui", () => ({ registerMenuItem: vi.fn(), unregisterMenuItem: vi.fn() }));
vi.mock("@api/dialogs", () => ({ alertAsync: vi.fn(async () => {}) }));

import extension from "../index";
import { isFormatPainterActive, isFormatPainterPersistent } from "../formatPainterState";
import { CoreCommands } from "@api/commands";
import {
  getFormatPainterState,
  subscribeToFormatPainterState,
  resetFormatPainterStateForTests,
  type FormatPainterState,
} from "@api/formatPainterState";

const A1 = { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" as const };
const B2 = { startRow: 1, startCol: 1, endRow: 1, endCol: 1, type: "cells" as const };
const C3 = { startRow: 2, startCol: 2, endRow: 2, endCol: 2, type: "cells" as const };

const handlers = new Map<string, () => Promise<void>>();

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/** A click on a cell: Core's selection moves, then the button comes up. */
async function clickCell(sel: typeof A1): Promise<void> {
  for (const l of [...h.listeners]) l(sel);
  window.dispatchEvent(new MouseEvent("mouseup"));
  await flush();
}

function painter(): Promise<void> {
  return handlers.get(CoreCommands.FORMAT_PAINTER)!();
}
function lock(): Promise<void> {
  return handlers.get(CoreCommands.FORMAT_PAINTER_LOCK)!();
}

/** Hold the source read open until the returned release is called. */
function holdSourceRead(): () => void {
  let release!: () => void;
  h.gate = new Promise<void>((r) => {
    release = r;
  });
  return () => {
    h.gate = null;
    release();
  };
}

let published: FormatPainterState[] = [];
let unsubscribe: () => void = () => {};

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  h.listeners.clear();
  h.setCellStyle.mockClear();
  h.begins = [];
  h.gate = null;
  handlers.clear();
  resetFormatPainterStateForTests();
  published = [];
  unsubscribe = subscribeToFormatPainterState((s) => published.push(s));
  extension.activate({
    commands: {
      register: (id: string, fn: () => Promise<void>) => handlers.set(id, fn),
      unregister: vi.fn(),
      execute: vi.fn(),
    },
  } as never);
  // The extension tracks the selection the painter will copy FROM.
  for (const l of [...h.listeners]) l(A1);
});

afterEach(() => {
  unsubscribe();
  extension.deactivate();
  vi.restoreAllMocks();
});

describe("FORMAT_PAINTER_LOCK on an active painter upgrades it", () => {
  it("single-use painter + LOCK = locked: it paints twice and stays on", async () => {
    await painter();
    expect(isFormatPainterActive()).toBe(true);
    expect(isFormatPainterPersistent()).toBe(false);
    await lock();
    expect(isFormatPainterActive(), "LOCK switched an active painter OFF").toBe(true);
    expect(isFormatPainterPersistent()).toBe(true);
    await clickCell(B2);
    await clickCell(C3);
    expect(h.setCellStyle).toHaveBeenCalledWith(1, 1, 7);
    expect(h.setCellStyle).toHaveBeenCalledWith(2, 2, 7);
    expect(isFormatPainterActive(), "a locked painter stopped after a paint").toBe(true);
  });

  it("LOCK on a locked painter keeps it locked", async () => {
    await lock();
    await lock();
    expect(isFormatPainterActive()).toBe(true);
    expect(isFormatPainterPersistent()).toBe(true);
  });

  it("FORMAT_PAINTER on an active painter still switches it off (Excel's button)", async () => {
    await painter();
    await painter();
    expect(isFormatPainterActive()).toBe(false);
    await lock();
    await painter();
    expect(isFormatPainterActive(), "a click on the button did not stop a locked painter").toBe(false);
  });
});

describe("a second activation while one is starting", () => {
  it("is ignored: one set of listeners, and a paint is ONE undo step", async () => {
    const release = holdSourceRead();
    const first = painter();
    const second = painter();
    release();
    await Promise.all([first, second]);
    await flush();
    expect(isFormatPainterActive()).toBe(true);
    await clickCell(B2);
    expect(h.begins, "the paint was recorded as more than one undo step").toEqual(["Format Painter"]);
    expect(h.setCellStyle).toHaveBeenCalledTimes(1);
  });

  it("a LOCK while starting makes the starting painter a locked one (the double-click)", async () => {
    const release = holdSourceRead();
    const first = painter(); // click
    const second = painter(); // second click of the double-click: ignored
    const third = lock(); // dblclick
    release();
    await Promise.all([first, second, third]);
    await flush();
    expect(isFormatPainterActive()).toBe(true);
    expect(isFormatPainterPersistent(), "the double-click did not lock the painter").toBe(true);
    await clickCell(B2);
    await clickCell(C3);
    expect(h.begins).toEqual(["Format Painter", "Format Painter"]);
    expect(isFormatPainterActive()).toBe(true);
  });

  it("Escape while starting cancels it: the painter never arms", async () => {
    const release = holdSourceRead();
    const first = painter();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    release();
    await first;
    await flush();
    expect(isFormatPainterActive(), "Escape did not cancel a starting painter").toBe(false);
    await clickCell(B2);
    expect(h.setCellStyle).not.toHaveBeenCalled();
    expect(getFormatPainterState()).toEqual({ active: false, locked: false });
  });
});

describe("@api/formatPainterState follows the painter", () => {
  it("off -> on -> locked -> off", async () => {
    expect(getFormatPainterState()).toEqual({ active: false, locked: false });
    await painter();
    expect(getFormatPainterState()).toEqual({ active: true, locked: false });
    await lock();
    expect(getFormatPainterState()).toEqual({ active: true, locked: true });
    await painter();
    expect(getFormatPainterState()).toEqual({ active: false, locked: false });
    expect(published).toEqual([
      { active: true, locked: false },
      { active: true, locked: true },
      { active: false, locked: false },
    ]);
  });

  it("a single-use painter that paints goes back to off", async () => {
    await painter();
    await clickCell(B2);
    expect(getFormatPainterState()).toEqual({ active: false, locked: false });
  });

  it("Escape on an armed painter goes back to off", async () => {
    await lock();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(getFormatPainterState()).toEqual({ active: false, locked: false });
  });

  it("deactivating the extension leaves the state off", async () => {
    await lock();
    extension.deactivate();
    expect(getFormatPainterState()).toEqual({ active: false, locked: false });
    // afterEach deactivates again: re-activate so it has something to do.
    extension.activate({
      commands: { register: (id: string, fn: () => Promise<void>) => handlers.set(id, fn), unregister: vi.fn() },
    } as never);
  });
});
