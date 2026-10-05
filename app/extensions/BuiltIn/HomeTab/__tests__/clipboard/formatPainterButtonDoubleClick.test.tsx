//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/clipboard/formatPainterButtonDoubleClick.test.tsx
// PURPOSE: A double-click on the ribbon's Format Painter button ends LOCKED,
//          with ONE painter (one source read, one undo step per paint), on
//          both timings a browser can produce -- driven through the REAL
//          FormatPainter extension's commands, logic and published state.
// CONTEXT: Home tab = Excel's Home tab, home-clipboard lane (2026-10-04). A
//          browser sends click, click, dblclick. The extension's table
//          (clipboard lane, formatPainterLogic.ts activateFormatPainter):
//
//            painter state | FORMAT_PAINTER | FORMAT_PAINTER_LOCK
//            off           | arm single-use | arm locked
//            starting      | ignored        | the start arms LOCKED
//            armed         | off            | upgraded to locked
//
//          So the second click lands either on a STARTING painter (ignored) or
//          on an ARMED one (switched off, then the dblclick arms a new locked
//          one: the source read twice, the button flickering off). The button
//          gives the second click of a pair to the dblclick that follows it, so
//          on both timings the dblclick upgrades the ONE painter in place.
//          Backend doubles as in FormatPainter/__tests__/formatPainterLockAndStart.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  listeners: new Set<(s: unknown) => void>(),
  setCellStyle: vi.fn(async (_r: number, _c: number, _s: number) => {}),
  begins: [] as string[],
  /** Source reads (one getCell per source cell). */
  reads: 0,
  /** When set, getCell waits for this before answering (a slow source read). */
  gate: null as Promise<void> | null,
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  getCell: vi.fn(async () => {
    h.reads += 1;
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

import { SurfaceLayoutProvider, bandLayout } from "@api/layout";
import { CommandRegistry } from "@api/commands";
import {
  getFormatPainterState,
  subscribeToFormatPainterState,
  resetFormatPainterStateForTests,
  type FormatPainterState,
} from "@api/formatPainterState";
import formatPainterExtension from "../../../FormatPainter/index";
import { ITEMS_BY_ID } from "../../homeTabConfig";
import type { HomeTabState } from "../../components/homeItemProps";
import { FormatPainterButton } from "../../components/clipboard/FormatPainterButton";

const A1 = { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" as const };
const B2 = { startRow: 1, startCol: 1, endRow: 1, endCol: 1, type: "cells" as const };
const C3 = { startRow: 2, startCol: 2, endRow: 2, endCol: 2, type: "cells" as const };

let container: HTMLDivElement;
let root: Root;
let published: FormatPainterState[] = [];
let unsubscribe: () => void = () => {};

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/** A click on a cell: Core's selection moves, then the mouse comes up. */
async function clickCell(sel: typeof A1): Promise<void> {
  for (const l of [...h.listeners]) l(sel);
  window.dispatchEvent(new MouseEvent("mouseup"));
  await flush();
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

function button(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>("[data-testid='fmt-formatPainter']");
  if (!el) throw new Error("no fmt-formatPainter");
  return el;
}

/** One DOM mouse event on the button; the handlers run, the promises do not settle. */
function fire(type: "click" | "dblclick", detail: number): void {
  act(() => {
    button().dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, detail }));
  });
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

beforeEach(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  h.listeners.clear();
  h.setCellStyle.mockClear();
  h.begins = [];
  h.reads = 0;
  h.gate = null;
  resetFormatPainterStateForTests();
  published = [];
  unsubscribe = subscribeToFormatPainterState((s) => published.push(s));
  // The extension registers its REAL commands in the REAL registry the button
  // executes through.
  formatPainterExtension.activate({
    commands: {
      register: (id: string, fn: (args?: unknown) => unknown) => CommandRegistry.register(id, fn),
      unregister: (id: string) => CommandRegistry.unregister(id),
      execute: (id: string, args?: unknown) => CommandRegistry.execute(id, args),
    },
  } as never);
  // The selection the painter copies FROM.
  for (const l of [...h.listeners]) l(A1);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <SurfaceLayoutProvider value={bandLayout(1200)}>
        <FormatPainterButton
          item={ITEMS_BY_ID.get("formatPainter")!}
          state={{} as HomeTabState}
          band
          labelled
        />
      </SurfaceLayoutProvider>,
    );
  });
});

afterEach(async () => {
  unsubscribe();
  formatPainterExtension.deactivate();
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
  resetFormatPainterStateForTests();
  vi.restoreAllMocks();
});

describe("a double-click on the ribbon button ends LOCKED with ONE painter", () => {
  it("fast start (armed before the second click): upgraded in place, never switched off", async () => {
    fire("click", 1);
    await act(flush);
    expect(getFormatPainterState(), "the first click did not arm the painter").toEqual({ active: true, locked: false });
    fire("click", 2);
    fire("dblclick", 2);
    await act(flush);

    expect(getFormatPainterState()).toEqual({ active: true, locked: true });
    // ONE painter: it went on and was locked -- never off and on again, and
    // its source cells were read once.
    expect(published).toEqual([
      { active: true, locked: false },
      { active: true, locked: true },
    ]);
    expect(h.reads, "the source cells were read more than once").toBe(1);

    // Locked: it paints twice and stays on; each paint is ONE undo step.
    await clickCell(B2);
    await clickCell(C3);
    expect(h.begins).toEqual(["Format Painter", "Format Painter"]);
    expect(h.setCellStyle.mock.calls).toEqual([
      [1, 1, 7],
      [2, 2, 7],
    ]);
    expect(getFormatPainterState().active).toBe(true);
    expect(button().getAttribute("aria-pressed")).toBe("true");
    expect(button().getAttribute("data-locked")).toBe("true");
  });

  it("slow start (still reading its source at the second click): the start arms locked, once", async () => {
    const release = holdSourceRead();
    fire("click", 1);
    fire("click", 2);
    fire("dblclick", 2);
    release();
    await act(flush);

    expect(getFormatPainterState()).toEqual({ active: true, locked: true });
    expect(published).toEqual([{ active: true, locked: true }]);
    expect(h.reads).toBe(1);

    await clickCell(B2);
    await clickCell(C3);
    expect(h.begins, "a paint was recorded as more than one undo step").toEqual(["Format Painter", "Format Painter"]);
    expect(button().getAttribute("aria-pressed")).toBe("true");
    expect(button().getAttribute("data-locked")).toBe("true");
  });

  it("a click on the locked painter's button switches it off (Excel)", async () => {
    fire("click", 1);
    fire("click", 2);
    fire("dblclick", 2);
    await act(flush);
    expect(getFormatPainterState()).toEqual({ active: true, locked: true });
    fire("click", 1);
    await act(flush);
    expect(getFormatPainterState()).toEqual({ active: false, locked: false });
    expect(button().getAttribute("aria-pressed")).toBe("false");
  });

  it("a single click arms a single-use painter that stops after one paint (positive control)", async () => {
    fire("click", 1);
    await act(flush);
    expect(button().getAttribute("aria-pressed")).toBe("true");
    expect(button().hasAttribute("data-locked")).toBe(false);
    await clickCell(B2);
    expect(getFormatPainterState()).toEqual({ active: false, locked: false });
    expect(button().getAttribute("aria-pressed")).toBe("false");
  });
});
