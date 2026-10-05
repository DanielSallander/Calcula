//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/clipboard/formatPainterButton.test.tsx
// PURPOSE: Excel's Format Painter button on the Home tab (contract 3.2): a
//          click runs FORMAT_PAINTER, a double-click FORMAT_PAINTER_LOCK, and
//          the button shows pressed while the painter is on (and says so when
//          it is locked); labelled beside the Paste hero, icon-only elsewhere;
//          a refusal reaches the user.
// CONTEXT: Home tab = Excel's Home tab, home-clipboard lane (2026-10-04). A
//          browser sends click, click, dblclick for one double-click; which
//          commands that sequence becomes is pinned here with the registry
//          mocked, and what the REAL FormatPainter extension does with it is
//          proven in formatPainterButtonDoubleClick.test.tsx.

/* eslint-disable @typescript-eslint/naming-convention --
 * The module double below stands in for RibbonIcon, whose real name is
 * PascalCase. */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@api", async () => {
  const icons = await import("@api/ribbonIcons");
  return { RibbonIcon: icons.RibbonIcon };
});

const dialogs = vi.hoisted(() => ({ alertAsync: vi.fn(async (_message: string) => {}) }));
vi.mock("@api/dialogs", () => dialogs);

import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  findHardcodedColours,
  ICON_SIZE_SM,
  TOOLTIP_DELAY_MS,
  type SurfaceLayout,
} from "@api/layout";
import { initKeybindings } from "@api/keybindings";
import { CommandRegistry, CoreCommands } from "@api/commands";
import { publishFormatPainterState, resetFormatPainterStateForTests } from "@api/formatPainterState";
import { ITEMS_BY_ID, type HomeTabItem } from "../../homeTabConfig";
import type { HomeTabState } from "../../components/homeItemProps";
import { FormatPainterButton } from "../../components/clipboard/FormatPainterButton";

// --- Harness ----------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;
let execute: ReturnType<typeof vi.spyOn>;
const handleItemClick = vi.fn();

const PAINTER = (): HomeTabItem => ITEMS_BY_ID.get("formatPainter")!;

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  initKeybindings();
});

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  resetFormatPainterStateForTests();
  dialogs.alertAsync.mockClear();
  handleItemClick.mockClear();
  execute = vi.spyOn(CommandRegistry, "execute").mockImplementation(async () => undefined);
});

afterEach(() => {
  act(() => root.unmount());
  execute.mockRestore();
  resetFormatPainterStateForTests();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

async function render(
  layout: SurfaceLayout,
  opts: { labelled?: boolean; item?: HomeTabItem } = {},
): Promise<void> {
  const band = layout.container === "band";
  await act(async () => {
    root.render(
      <SurfaceLayoutProvider value={layout}>
        <FormatPainterButton
          item={opts.item ?? PAINTER()}
          state={{ handleItemClick } as unknown as HomeTabState}
          band={band}
          labelled={opts.labelled}
        />
      </SurfaceLayoutProvider>,
    );
  });
}

function button(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>("[data-testid='fmt-formatPainter']");
  if (!el) throw new Error("no fmt-formatPainter");
  return el;
}

/** One DOM mouse event on the button, `detail` = the browser's click count. */
async function fire(type: "click" | "dblclick", detail: number): Promise<void> {
  await act(async () => {
    button().dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, detail }));
    for (let i = 0; i < 3; i++) await Promise.resolve();
  });
}

/** What a browser sends for ONE double-click. */
async function doubleClick(): Promise<void> {
  await fire("click", 1);
  await fire("click", 2);
  await fire("dblclick", 2);
}

function ran(): unknown[][] {
  return execute.mock.calls.map((call: unknown[]) => [...call]);
}

// ============================================================================
// Faces
// ============================================================================

describe("the control", () => {
  it("labelled (beside the Paste hero): Excel's medium button, icon and 'Format Painter'", async () => {
    await render(bandLayout(1200), { labelled: true });
    expect(button().tagName).toBe("BUTTON");
    expect(button().textContent).toBe("Format Painter");
    expect(button().querySelector("svg")?.getAttribute("width")).toBe(String(ICON_SIZE_SM));
    expect(button().hasAttribute("title")).toBe(false);
  });

  it("icon-only otherwise, named for assistive technology", async () => {
    await render(panelLayout(300));
    expect(button().textContent).toBe("");
    expect(button().getAttribute("aria-label")).toBe("Format Painter");
    expect(button().querySelector("svg")).not.toBeNull();
    expect(button().hasAttribute("title")).toBe(false);
  });

  it("explains itself with the live Ctrl+Shift+C chip, said once", async () => {
    await render(bandLayout(1200), { labelled: true });
    vi.useFakeTimers();
    act(() => {
      button().dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS + 50);
    });
    vi.useRealTimers();
    const tip = document.querySelector("[role='tooltip']");
    expect(tip?.textContent).toContain("Format Painter");
    expect(tip?.querySelector("kbd")?.textContent).toBe("Ctrl+Shift+C");
    expect(tip?.textContent).not.toContain("(Ctrl+Shift+C)");
  });

  it("an item with no catalog tooltip still renders, named by its label", async () => {
    await render(panelLayout(300), { item: { ...PAINTER(), tooltip: undefined } });
    expect(button().getAttribute("aria-label")).toBe("Format Painter");
  });

  for (const [surface, layout] of [
    ["band", () => bandLayout(1200)],
    ["panel", () => panelLayout(300)],
  ] as const) {
    it(`paints with tokens only, at rest and pressed (${surface})`, async () => {
      await render(layout(), { labelled: surface === "band" });
      expect(findHardcodedColours(container)).toEqual([]);
      act(() => publishFormatPainterState({ active: true, locked: true }));
      expect(findHardcodedColours(container)).toEqual([]);
    });
  }
});

// ============================================================================
// Click and double-click
// ============================================================================

describe("a click runs FORMAT_PAINTER, a double-click FORMAT_PAINTER_LOCK", () => {
  for (const labelled of [true, false]) {
    it(`one click: FORMAT_PAINTER once, no arguments (${labelled ? "labelled" : "icon"})`, async () => {
      await render(bandLayout(1200), { labelled });
      await fire("click", 1);
      expect(ran()).toEqual([[CoreCommands.FORMAT_PAINTER]]);
    });

    it(`a double-click (click, click, dblclick): FORMAT_PAINTER then LOCK, nothing else (${labelled ? "labelled" : "icon"})`, async () => {
      await render(bandLayout(1200), { labelled });
      await doubleClick();
      // The second click of the pair belongs to the dblclick that follows it:
      // run as a plain click it would switch an armed painter OFF just before
      // the lock armed it again (and read the source cells twice).
      expect(ran()).toEqual([[CoreCommands.FORMAT_PAINTER], [CoreCommands.FORMAT_PAINTER_LOCK]]);
    });
  }

  it("a keyboard or assistive activation (detail 0) is a click", async () => {
    await render(bandLayout(1200), { labelled: true });
    await act(async () => {
      button().click();
      await Promise.resolve();
    });
    expect(ran()).toEqual([[CoreCommands.FORMAT_PAINTER]]);
  });

  it("two slow clicks (no double-click) are two clicks: on, then off", async () => {
    await render(bandLayout(1200), { labelled: true });
    await fire("click", 1);
    await fire("click", 1);
    expect(ran()).toEqual([[CoreCommands.FORMAT_PAINTER], [CoreCommands.FORMAT_PAINTER]]);
  });

  it("a triple-click is a double-click and then a click (Windows' pairing): lock, then off", async () => {
    await render(bandLayout(1200), { labelled: true });
    await doubleClick();
    await fire("click", 3);
    expect(ran()).toEqual([
      [CoreCommands.FORMAT_PAINTER],
      [CoreCommands.FORMAT_PAINTER_LOCK],
      [CoreCommands.FORMAT_PAINTER],
    ]);
  });

  it("runs the commands itself, not the group's item door", async () => {
    await render(bandLayout(1200), { labelled: true });
    await doubleClick();
    expect(handleItemClick).not.toHaveBeenCalled();
  });

  it("a refusal from FORMAT_PAINTER reaches the user", async () => {
    execute.mockImplementation(async () => {
      throw new Error("Format Painter is not available while an object is selected.");
    });
    await render(bandLayout(1200), { labelled: true });
    await fire("click", 1);
    expect(dialogs.alertAsync).toHaveBeenCalledWith("Format Painter is not available while an object is selected.");
  });

  it("a refusal from FORMAT_PAINTER_LOCK reaches the user too", async () => {
    execute.mockImplementation(async (id: unknown) => {
      if (id === CoreCommands.FORMAT_PAINTER_LOCK) throw new Error("locked out");
      return undefined;
    });
    await render(bandLayout(1200), { labelled: true });
    await doubleClick();
    expect(dialogs.alertAsync.mock.calls).toEqual([["locked out"]]);
  });
});

// ============================================================================
// Pressed while the painter is on
// ============================================================================

describe("pressed while the painter is on (@api/formatPainterState)", () => {
  for (const labelled of [true, false]) {
    it(`follows the store: off, on, locked, off (${labelled ? "labelled" : "icon"})`, async () => {
      await render(bandLayout(1200), { labelled });
      expect(button().getAttribute("aria-pressed")).toBe("false");
      expect(button().hasAttribute("data-active")).toBe(false);
      expect(button().hasAttribute("data-locked")).toBe(false);

      act(() => publishFormatPainterState({ active: true, locked: false }));
      expect(button().getAttribute("aria-pressed")).toBe("true");
      expect(button().getAttribute("data-active")).toBe("true");
      expect(button().hasAttribute("data-locked")).toBe(false);

      act(() => publishFormatPainterState({ active: true, locked: true }));
      expect(button().getAttribute("aria-pressed")).toBe("true");
      expect(button().getAttribute("data-locked")).toBe("true");

      act(() => publishFormatPainterState({ active: false, locked: false }));
      expect(button().getAttribute("aria-pressed")).toBe("false");
      expect(button().hasAttribute("data-active")).toBe(false);
      expect(button().hasAttribute("data-locked")).toBe(false);
    });
  }

  it("a painter armed BEFORE the button mounted shows pressed at once", async () => {
    publishFormatPainterState({ active: true, locked: true });
    await render(panelLayout(300));
    expect(button().getAttribute("aria-pressed")).toBe("true");
    expect(button().getAttribute("data-locked")).toBe("true");
  });
});
