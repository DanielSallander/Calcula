//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/clipboard/pasteSplitButton.test.tsx
// PURPOSE: Excel's Paste split button on the Home tab (contract 3.1): the hero
//          face in the ribbon band and the labelled face elsewhere, the menu's
//          three headings and thirteen rows in Excel's order with their
//          pictures, the command each row runs, the enablement the menu reads
//          WHEN IT OPENS (no cell clipboard, a cut, a canvas sheet), and a
//          refusal that reaches the user.
// CONTEXT: Home tab = Excel's Home tab, home-clipboard lane (2026-10-04). The
//          cell clipboard and the canvas question are doubles here (their own
//          rules are pinned in src/api and src/core); the door the main half
//          and the "Paste" row share is proven against the REAL
//          useHomeTabState in pasteSplitButtonDoor.test.tsx.

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

/** What the cell clipboard holds, whether the sheet is a canvas, and how
 *  often the menu asked. */
const env = vi.hoisted(() => ({
  clipboard: null as unknown,
  canvas: false,
  clipboardReads: 0,
  canvasReads: 0,
  /** The read throws (an unreadable clipboard). */
  broken: false,
  /** What the freshness question (`internalClipboardIsCurrent`) answers:
   *  true / false, "pending" (never settles until released), or "throw". */
  current: true as boolean | "pending" | "throw",
  freshnessAsks: 0,
  release: null as ((current: boolean) => void) | null,
}));
vi.mock("@api/cellClipboard", () => ({
  internalClipboardIsCurrent: async () => {
    env.freshnessAsks += 1;
    if (env.current === "throw") throw new Error("clipboard locked");
    if (env.current === "pending") return new Promise<boolean>((resolve) => (env.release = resolve));
    return env.current;
  },
}));
vi.mock("@api/lib", () => ({
  getInternalClipboard: () => {
    env.clipboardReads += 1;
    if (env.broken) throw new Error("ipc down");
    return env.clipboard;
  },
}));
vi.mock("@api/objectClipboard", () => ({
  canvasOwnsObjectClipboard: () => {
    env.canvasReads += 1;
    return env.canvas;
  },
}));

const dialogs = vi.hoisted(() => ({ alertAsync: vi.fn(async (_message: string) => {}) }));
vi.mock("@api/dialogs", () => dialogs);

import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  findHardcodedColours,
  HERO_ICON_SIZE,
  ICON_SIZE_SM,
  TOOLTIP_DELAY_MS,
  type SurfaceLayout,
} from "@api/layout";
import { initKeybindings } from "@api/keybindings";
import { CommandRegistry, CoreCommands } from "@api/commands";
import { ITEMS_BY_ID, type HomeTabItem } from "../../homeTabConfig";
import type { HomeTabState } from "../../components/homeItemProps";
import { PasteSplitButton } from "../../components/clipboard/PasteSplitButton";
import {
  PASTE_MENU_SECTIONS,
  PASTE_SPECIAL_ROW,
  pasteVariantsBlock,
} from "../../components/clipboard/pasteMenu";

// --- Harness ----------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;
const handleItemClick = vi.fn(async (_item: HomeTabItem) => {});
let execute: ReturnType<typeof vi.spyOn>;

/** A clipboard the way a Copy leaves it: one cell. */
const COPIED = { cells: [[{ row: 0, col: 0, display: "1" }]], isCut: false };
/** The same cells after a Cut. */
const CUT = { cells: [[{ row: 0, col: 0, display: "1" }]], isCut: true };

const PASTE = (): HomeTabItem => ITEMS_BY_ID.get("paste")!;

function stateDouble(): HomeTabState {
  return { handleItemClick } as unknown as HomeTabState;
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  initKeybindings();
});

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  handleItemClick.mockClear();
  dialogs.alertAsync.mockClear();
  env.clipboard = COPIED;
  env.canvas = false;
  env.broken = false;
  env.current = true;
  env.freshnessAsks = 0;
  env.release = null;
  env.clipboardReads = 0;
  env.canvasReads = 0;
  execute = vi.spyOn(CommandRegistry, "execute").mockImplementation(async () => undefined);
});

afterEach(() => {
  act(() => root.unmount());
  execute.mockRestore();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

async function render(layout: SurfaceLayout, item: HomeTabItem = PASTE()): Promise<void> {
  const band = layout.container === "band";
  await act(async () => {
    root.render(
      <SurfaceLayoutProvider value={layout}>
        <PasteSplitButton item={item} state={stateDouble()} band={band} />
      </SurfaceLayoutProvider>,
    );
  });
}

function byTestId(id: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`[data-testid='${id}']`);
  if (!el) throw new Error(`no ${id}`);
  return el;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await Promise.resolve();
  });
}

function key(el: Element, k: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

function menu(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[role='menu']");
}

async function openMenu(): Promise<HTMLElement> {
  await click(byTestId("fmt-paste-options"));
  // Let the freshness question (asked on open, asynchronously) answer.
  await act(async () => {
    for (let i = 0; i < 3; i++) await Promise.resolve();
  });
  const m = menu();
  if (!m) throw new Error("the Paste menu did not open");
  return m;
}

function rows(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("[role='menu'] [role='menuitem']"));
}

/** The menu's children as a readable outline: headings, rows, separators. */
function outline(m: HTMLElement): string[] {
  return Array.from(m.children).map((el) => {
    if (el.getAttribute("role") === "separator") return "---";
    if (el.getAttribute("role") === "menuitem") return el.getAttribute("data-testid") ?? "?";
    return `# ${el.textContent}`;
  });
}

/** Every row but the first ("Paste") is a variant the menu may disable. */
const VARIANT_TEST_IDS = [
  "fmt-paste-formulas",
  "fmt-paste-formulasNumberFormats",
  "fmt-paste-keepSource",
  "fmt-paste-noBorders",
  "fmt-paste-columnWidths",
  "fmt-paste-transpose",
  "fmt-paste-values",
  "fmt-paste-valuesNumberFormats",
  "fmt-paste-valuesSourceFormatting",
  "fmt-paste-formatting",
  "fmt-paste-link",
  "fmt-paste-special",
];

// ============================================================================
// The control
// ============================================================================

describe("the control: Excel's large split in the band, its medium split elsewhere", () => {
  it("band: the picture runs Paste (fmt-paste), the label + chevron below opens the menu", async () => {
    await render(bandLayout(1200));
    const main = byTestId("fmt-paste");
    const chevron = byTestId("fmt-paste-options");
    expect(main.getAttribute("aria-label")).toBe("Paste");
    expect(chevron.getAttribute("aria-label")).toBe("Paste options");
    expect(chevron.getAttribute("aria-haspopup")).toBe("menu");
    expect(main.hasAttribute("title")).toBe(false);
    expect(chevron.hasAttribute("title")).toBe(false);
    // The hero face: a 30px picture on the half that runs, the label on the
    // half that opens the menu (Excel's "Paste / v").
    expect(main.querySelector("svg")?.getAttribute("width")).toBe(String(HERO_ICON_SIZE));
    expect(main.textContent).toBe("");
    expect(chevron.textContent).toBe("Paste");
    expect(chevron.querySelectorAll("[data-hero-line]").length).toBeGreaterThan(0);
    expect(main.closest(".split")).toBe(chevron.closest(".split"));
  });

  it("panel: one 28px row, [icon Paste][v], the standard 20px icon", async () => {
    await render(panelLayout(300));
    const main = byTestId("fmt-paste");
    expect(main.querySelector("svg")?.getAttribute("width")).toBe(String(ICON_SIZE_SM));
    expect(main.textContent).toBe("Paste");
    expect(byTestId("fmt-paste-options").textContent).toBe("");
    expect(document.querySelector("[data-hero-line]")).toBeNull();
  });

  it("the main half runs the item's door (state.handleItemClick) and opens no menu", async () => {
    await render(bandLayout(1200));
    await click(byTestId("fmt-paste"));
    expect(handleItemClick).toHaveBeenCalledTimes(1);
    expect(handleItemClick).toHaveBeenCalledWith(PASTE());
    expect(execute, "the main half ran a command past the door").not.toHaveBeenCalled();
    expect(menu()).toBeNull();
  });

  it("the main half explains itself with its live shortcut chip", async () => {
    await render(bandLayout(1200));
    vi.useFakeTimers();
    act(() => {
      byTestId("fmt-paste").dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS + 50);
    });
    vi.useRealTimers();
    const tip = document.querySelector("[role='tooltip']");
    expect(tip?.textContent).toContain("Paste");
    expect(tip?.querySelector("kbd")?.textContent).toBe("Ctrl+V");
    expect(tip?.textContent).not.toContain("(Ctrl+V)");
  });

  it("an item with no catalog tooltip still renders, named by its label", async () => {
    await render(bandLayout(1200), { ...PASTE(), tooltip: undefined });
    expect(byTestId("fmt-paste").getAttribute("aria-label")).toBe("Paste");
  });

  for (const [surface, layout] of [
    ["band", () => bandLayout(1200)],
    ["panel", () => panelLayout(300)],
  ] as const) {
    it(`paints with tokens only, closed and open (${surface})`, async () => {
      await render(layout());
      expect(findHardcodedColours(container)).toEqual([]);
      const m = await openMenu();
      expect(findHardcodedColours(m.parentElement ?? m)).toEqual([]);
    });
  }
});

// ============================================================================
// The menu
// ============================================================================

describe("the menu: Excel's rows, in Excel's order, each with its picture", () => {
  it("three headings, twelve rows, a separator, Paste Special...", async () => {
    await render(bandLayout(1200));
    const m = await openMenu();
    expect(m.getAttribute("aria-label")).toBe("Paste");
    expect(outline(m)).toEqual([
      "# Paste",
      "fmt-paste-paste",
      "fmt-paste-formulas",
      "fmt-paste-formulasNumberFormats",
      "fmt-paste-keepSource",
      "fmt-paste-noBorders",
      "fmt-paste-columnWidths",
      "fmt-paste-transpose",
      "# Paste Values",
      "fmt-paste-values",
      "fmt-paste-valuesNumberFormats",
      "fmt-paste-valuesSourceFormatting",
      "# Other Paste Options",
      "fmt-paste-formatting",
      "fmt-paste-link",
      "---",
      "fmt-paste-special",
    ]);
    expect(rows().map((r) => r.querySelector("[data-menu-label]")?.textContent)).toEqual([
      "Paste",
      "Formulas",
      "Formulas & Number Formatting",
      "Keep Source Formatting",
      "No Borders",
      "Keep Source Column Widths",
      "Transpose",
      "Values",
      "Values & Number Formatting",
      "Values & Source Formatting",
      "Formatting",
      "Paste Link",
      "Paste Special...",
    ]);
  });

  it("every row draws its own 20px picture", async () => {
    await render(bandLayout(1200));
    await openMenu();
    const pictures = rows().map((r) => r.querySelector("svg"));
    for (const [i, svg] of pictures.entries()) {
      expect(svg, `row ${i} has no picture`).not.toBeNull();
      expect(svg!.getAttribute("width"), `row ${i}`).toBe("20");
    }
    // Thirteen DIFFERENT pictures: no row borrowed another's.
    expect(new Set(pictures.map((svg) => svg!.innerHTML)).size).toBe(13);
  });

  it("the data matches what is drawn, and names the contract's commands", () => {
    const run = [...PASTE_MENU_SECTIONS.flatMap((s) => s.rows), PASTE_SPECIAL_ROW].map((r) => [
      r.slug,
      r.commandId,
    ]);
    expect(run).toEqual([
      ["paste", null],
      ["formulas", CoreCommands.PASTE_FORMULAS],
      ["formulasNumberFormats", CoreCommands.PASTE_FORMULAS_AND_NUMBER_FORMATS],
      ["keepSource", CoreCommands.PASTE],
      ["noBorders", CoreCommands.PASTE_NO_BORDERS],
      ["columnWidths", CoreCommands.PASTE_KEEP_SOURCE_COLUMN_WIDTHS],
      ["transpose", CoreCommands.PASTE_TRANSPOSE],
      ["values", CoreCommands.PASTE_VALUES],
      ["valuesNumberFormats", CoreCommands.PASTE_VALUES_AND_NUMBER_FORMATS],
      ["valuesSourceFormatting", CoreCommands.PASTE_VALUES_AND_SOURCE_FORMATTING],
      ["formatting", CoreCommands.PASTE_FORMATTING],
      ["link", CoreCommands.PASTE_LINK],
      ["special", CoreCommands.PASTE_SPECIAL],
    ]);
  });

  it("each variant row runs exactly its command, with no arguments, after the menu closes", async () => {
    await render(bandLayout(1200));
    const expected: Record<string, string> = {
      "fmt-paste-formulas": CoreCommands.PASTE_FORMULAS,
      "fmt-paste-formulasNumberFormats": CoreCommands.PASTE_FORMULAS_AND_NUMBER_FORMATS,
      "fmt-paste-keepSource": CoreCommands.PASTE,
      "fmt-paste-noBorders": CoreCommands.PASTE_NO_BORDERS,
      "fmt-paste-columnWidths": CoreCommands.PASTE_KEEP_SOURCE_COLUMN_WIDTHS,
      "fmt-paste-transpose": CoreCommands.PASTE_TRANSPOSE,
      "fmt-paste-values": CoreCommands.PASTE_VALUES,
      "fmt-paste-valuesNumberFormats": CoreCommands.PASTE_VALUES_AND_NUMBER_FORMATS,
      "fmt-paste-valuesSourceFormatting": CoreCommands.PASTE_VALUES_AND_SOURCE_FORMATTING,
      "fmt-paste-formatting": CoreCommands.PASTE_FORMATTING,
      "fmt-paste-link": CoreCommands.PASTE_LINK,
      "fmt-paste-special": CoreCommands.PASTE_SPECIAL,
    };
    for (const [testId, commandId] of Object.entries(expected)) {
      execute.mockClear();
      await openMenu();
      await click(byTestId(testId));
      expect(execute.mock.calls, testId).toEqual([[commandId]]);
      expect(menu(), `${testId} left the menu open`).toBeNull();
    }
    expect(handleItemClick, "a variant row ran the Paste door").not.toHaveBeenCalled();
  });

  it("the Paste row runs the SAME door as the main half, not a command of its own", async () => {
    await render(bandLayout(1200));
    await openMenu();
    await click(byTestId("fmt-paste-paste"));
    expect(handleItemClick).toHaveBeenCalledTimes(1);
    expect(handleItemClick).toHaveBeenCalledWith(PASTE());
    expect(execute).not.toHaveBeenCalled();
  });

  it("Paste and Paste Special show their live shortcut chips; no other row claims Ctrl+V", async () => {
    await render(bandLayout(1200));
    await openMenu();
    expect(byTestId("fmt-paste-paste").querySelector("kbd")?.textContent).toBe("Ctrl+V");
    expect(byTestId("fmt-paste-special").querySelector("kbd")?.textContent).toBe("Ctrl+Shift+V");
    // Keep Source Formatting runs PASTE too, but the chip belongs to ONE row.
    const ctrlV = rows().filter((r) => r.querySelector("kbd")?.textContent === "Ctrl+V");
    expect(ctrlV.map((r) => r.getAttribute("data-testid"))).toEqual(["fmt-paste-paste"]);
  });

  it("a refusal thrown by a row's command reaches the user", async () => {
    execute.mockImplementation(async () => {
      throw new Error("Paste Values is not available here. Nothing was changed.");
    });
    await render(bandLayout(1200));
    await openMenu();
    await click(byTestId("fmt-paste-values"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(dialogs.alertAsync).toHaveBeenCalledWith("Paste Values is not available here. Nothing was changed.");
  });

  it("a non-Error refusal is said as text", async () => {
    execute.mockImplementation(async () => {
      throw "protected sheet";
    });
    await render(bandLayout(1200));
    await openMenu();
    await click(byTestId("fmt-paste-special"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(dialogs.alertAsync).toHaveBeenCalledWith("protected sheet");
  });

  it("the keyboard: ArrowDown on the main half opens the menu on Paste, Enter runs it", async () => {
    await render(bandLayout(1200));
    key(byTestId("fmt-paste"), "ArrowDown");
    expect(document.activeElement).toBe(byTestId("fmt-paste-paste"));
    key(byTestId("fmt-paste-paste"), "Enter");
    expect(handleItemClick).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(byTestId("fmt-paste"));
  });
});

// ============================================================================
// Enablement, read when the menu opens
// ============================================================================

describe("enablement: every row but Paste needs copied cells (Excel)", () => {
  function disabledIds(): string[] {
    return rows()
      .filter((r) => r.disabled)
      .map((r) => r.getAttribute("data-testid") ?? "?");
  }

  it("after a Copy every row is enabled", async () => {
    env.clipboard = COPIED;
    await render(bandLayout(1200));
    await openMenu();
    expect(disabledIds()).toEqual([]);
    expect(pasteVariantsBlock()).toBeNull();
  });

  it("with nothing copied only Paste is enabled", async () => {
    env.clipboard = null;
    await render(bandLayout(1200));
    await openMenu();
    expect(disabledIds()).toEqual(VARIANT_TEST_IDS);
    expect(byTestId("fmt-paste-paste").disabled).toBe(false);
    expect(byTestId("fmt-paste-values").getAttribute("data-unavailable")).toBe("nothingCopied");
  });

  it("a clipboard with no cells counts as nothing copied (the commands' own rule)", async () => {
    env.clipboard = { cells: [], isCut: false };
    expect(pasteVariantsBlock()).toBe("nothingCopied");
  });

  it("after a Cut only Paste is enabled (measured live: Excel greys the rest)", async () => {
    env.clipboard = CUT;
    await render(bandLayout(1200));
    await openMenu();
    expect(disabledIds()).toEqual(VARIANT_TEST_IDS);
    expect(byTestId("fmt-paste-paste").disabled).toBe(false);
    expect(byTestId("fmt-paste-transpose").getAttribute("data-unavailable")).toBe("afterCut");
  });

  it("on a canvas sheet only Paste is enabled, even with cells copied", async () => {
    env.clipboard = COPIED;
    env.canvas = true;
    await render(bandLayout(1200));
    await openMenu();
    expect(disabledIds()).toEqual(VARIANT_TEST_IDS);
    expect(byTestId("fmt-paste-paste").disabled).toBe(false);
    expect(byTestId("fmt-paste-link").getAttribute("data-unavailable")).toBe("canvas");
  });

  it("an enabled row carries no data-unavailable", async () => {
    await render(bandLayout(1200));
    await openMenu();
    for (const r of rows()) expect(r.hasAttribute("data-unavailable"), r.getAttribute("data-testid")!).toBe(false);
  });

  it("a disabled row runs nothing, and the keyboard skips it", async () => {
    env.clipboard = null;
    await render(bandLayout(1200));
    await openMenu();
    await click(byTestId("fmt-paste-values"));
    expect(execute).not.toHaveBeenCalled();
    // From Paste, ArrowDown lands on the next ENABLED row: Paste Special is
    // disabled too, so focus wraps back to Paste itself.
    byTestId("fmt-paste-paste").focus();
    key(byTestId("fmt-paste-paste"), "ArrowDown");
    expect(document.activeElement).toBe(byTestId("fmt-paste-paste"));
  });

  it("is read when the menu OPENS: nothing while closed, once per open, never per render", async () => {
    env.clipboard = null;
    await render(bandLayout(1200));
    expect(env.clipboardReads + env.canvasReads, "the closed button read the clipboard").toBe(0);

    // Copied after the button rendered: the menu still sees it.
    env.clipboard = COPIED;
    await openMenu();
    expect(byTestId("fmt-paste-values").disabled).toBe(false);
    const readsAtOpen = env.clipboardReads;
    expect(readsAtOpen).toBe(1);

    // A re-render while open asks nothing again.
    await render(bandLayout(1200));
    expect(env.clipboardReads).toBe(readsAtOpen);

    // Closed, cut, opened again: a fresh read.
    await click(byTestId("fmt-paste-options"));
    expect(menu()).toBeNull();
    env.clipboard = CUT;
    await openMenu();
    expect(env.clipboardReads).toBe(readsAtOpen + 1);
    expect(byTestId("fmt-paste-values").disabled).toBe(true);
  });

  it("a clipboard that cannot be read leaves the variants disabled (Paste stays), never a crash", async () => {
    env.clipboard = COPIED;
    env.broken = true;
    expect(pasteVariantsBlock()).toBe("nothingCopied");
    await render(bandLayout(1200));
    await openMenu();
    expect(disabledIds()).toEqual(VARIANT_TEST_IDS);
    expect(byTestId("fmt-paste-paste").disabled).toBe(false);
  });
});

// ============================================================================
// A stale cell clipboard (review finding, 2026-10-04)
// ============================================================================

describe("enablement: another program copied since (a STALE cell clipboard)", () => {
  function disabledIds(): string[] {
    return rows()
      .filter((r) => r.disabled)
      .map((r) => r.getAttribute("data-testid") ?? "?");
  }

  it("greys every variant row, as the commands would each refuse with a dialog; Paste stays (it pastes the newer text)", async () => {
    // Every variant asks pasteRefusals' second question -- is the internal
    // clipboard still what the clipboard holds? -- and refuses with an alert
    // when not. The menu did not ask it, so all twelve rows looked live.
    env.current = false;
    await render(bandLayout(1200));
    await openMenu();
    expect(disabledIds()).toEqual(VARIANT_TEST_IDS);
    expect(byTestId("fmt-paste-paste").disabled).toBe(false);
    expect(byTestId("fmt-paste-values").getAttribute("data-unavailable")).toBe("stale");
    expect(env.freshnessAsks).toBe(1);
  });

  it("is grey while the question is in flight, live once it answers 'current'", async () => {
    env.current = "pending";
    await render(bandLayout(1200));
    await openMenu();
    expect(disabledIds()).toEqual(VARIANT_TEST_IDS);
    expect(byTestId("fmt-paste-formulas").getAttribute("data-unavailable")).toBe("pending");
    await act(async () => {
      env.release?.(true);
      await Promise.resolve();
    });
    expect(disabledIds()).toEqual([]);
  });

  it("a read that FAILS leaves the rows live: the command decides (it falls back the same way)", async () => {
    env.current = "throw";
    await render(bandLayout(1200));
    await openMenu();
    expect(disabledIds()).toEqual([]);
  });

  it("is asked once per opening, and only when the clipboard holds copied cells", async () => {
    await render(bandLayout(1200));
    await openMenu();
    expect(env.freshnessAsks).toBe(1);
    await click(byTestId("fmt-paste-options"));
    await openMenu();
    expect(env.freshnessAsks).toBe(2);
    await click(byTestId("fmt-paste-options"));
    // Nothing copied, after a Cut, on a canvas: already grey, nothing to ask.
    for (const setup of [() => (env.clipboard = null), () => (env.clipboard = CUT), () => ((env.clipboard = COPIED), (env.canvas = true))]) {
      setup();
      await openMenu();
      await click(byTestId("fmt-paste-options"));
    }
    expect(env.freshnessAsks).toBe(2);
  });

  it("a menu closed before the answer arrives sets nothing on an unmounted component", async () => {
    env.current = "pending";
    await render(bandLayout(1200));
    await openMenu();
    await click(byTestId("fmt-paste-options"));
    expect(menu()).toBeNull();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      env.release?.(false);
      await Promise.resolve();
    });
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
