//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/alignment/orientationMenuButton.test.tsx
// PURPOSE: Excel's Orientation menu on the Home tab's Alignment group
//          (CONTRACT 3.6): the icon-with-chevron trigger and its lack of a
//          pressed state, the menu's six rows in Excel's order with their
//          pictures, the check that follows the active cell's rotation, the
//          "indented text cannot be angled" rule, what each row writes -- the
//          rotation, then a grow-only AutoFit of the rows, as ONE undo step --
//          and every refusal reaching the user.
// CONTEXT: Rendered alone (HomeItemProps: item, state, band), in the ribbon
//          band and in the sidebar panel. The Home tab's state is a double, so
//          `applyFormat` is observed exactly as the component calls it; the
//          command registry is the real one with `execute` spied, so the test
//          sees the command ids and arguments the menu really sends.

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

const dialogs = vi.hoisted(() => ({ alertAsync: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock("@api/dialogs", () => dialogs);

/** The undo-transaction doors. A begin that OPENS answers a ticket (7). */
const lib = vi.hoisted(() => ({
  beginUndoTransaction: vi.fn(),
  commitUndoTransaction: vi.fn(),
  cancelUndoTransaction: vi.fn(),
}));
vi.mock("@api/lib", () => lib);

import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  CONTROL_HEIGHT_MD,
  ICON_SIZE_SM,
  TOOLTIP_DELAY_MS,
  findHardcodedColours,
  type SurfaceLayout,
} from "@api/layout";
import { RibbonIcon, type RibbonIconKey } from "@api/ribbonIcons";
import { CommandRegistry, CoreCommands } from "@api/commands";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";
import type { StyleData } from "@api/types";
import type { HomeTabItem } from "../../homeTabConfig";
import type { HomeTabState } from "../../components/homeItemProps";
import { OrientationMenuButton } from "../../components/alignment/OrientationMenuButton";
import {
  ORIENTATION_ROWS,
  ORIENTATION_UNAVAILABLE_WHILE_INDENTED,
} from "../../components/alignment/orientationMenu";

// ============================================================================
// Harness
// ============================================================================

/** The catalog entry CONTRACT section 2 names (home-core adds it to ALL_ITEMS). */
const ITEM: HomeTabItem = {
  id: "orientation",
  label: "Orientation",
  tooltip: "Orientation",
  type: "button",
  category: "Alignment",
  addedIn: 2,
};

/** What happened, in order: the transaction, the writes, the commands. */
const log: string[] = [];
const applyFormat = vi.fn();
const execute = vi.fn();

let container: HTMLDivElement;
let root: Root;
let toasts: ToastPayload[] = [];
let releaseOwner: (() => void) | null = null;

function makeState(style: Partial<StyleData> | null): HomeTabState {
  return {
    currentStyle: style === null ? null : ({ textRotation: "none", indent: 0, ...style } as StyleData),
    applyFormat,
  } as unknown as HomeTabState;
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  log.length = 0;
  toasts = [];
  registerToastSink((t) => toasts.push(t));
  dialogs.alertAsync.mockClear();
  applyFormat.mockReset().mockImplementation(async (formatting: { textRotation?: string }) => {
    log.push(`format:${formatting.textRotation}`);
  });
  execute.mockReset().mockImplementation(async (id: string, args?: unknown) => {
    log.push(`execute:${id}:${JSON.stringify(args)}`);
  });
  vi.spyOn(CommandRegistry, "execute").mockImplementation((id: string, args?: unknown) => execute(id, args));
  lib.beginUndoTransaction.mockReset().mockImplementation(async (description: string) => {
    log.push(`begin:${description}`);
    return 7;
  });
  lib.commitUndoTransaction.mockReset().mockImplementation(async (ticket?: number) => {
    log.push(`commit:${ticket}`);
  });
  lib.cancelUndoTransaction.mockReset().mockImplementation(async (ticket?: number) => {
    log.push(`cancel:${ticket}`);
  });
});

afterEach(() => {
  releaseOwner?.();
  releaseOwner = null;
  act(() => root.unmount());
  vi.useRealTimers();
  document.body.innerHTML = "";
});

const SURFACES: Array<[string, () => SurfaceLayout, boolean]> = [
  ["band", () => bandLayout(1200), true],
  ["panel", () => panelLayout(300), false],
];

async function render(
  style: Partial<StyleData> | null = {},
  surface: [string, () => SurfaceLayout, boolean] = SURFACES[0],
  item: HomeTabItem = ITEM,
): Promise<void> {
  const [, layout, band] = surface;
  await act(async () => {
    root.render(
      <SurfaceLayoutProvider value={layout()}>
        <OrientationMenuButton item={item} state={makeState(style)} band={band} />
      </SurfaceLayoutProvider>,
    );
  });
}

function byTestId(id: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`[data-testid='${id}']`);
  if (!el) throw new Error(`no ${id}`);
  return el;
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function key(el: Element, k: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

/** Let a row's async work (transaction, write, AutoFit, commit) finish. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** The open menu's item rows (separators and headings are not buttons). */
function rows(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("[role='menu'] button"));
}

function rowLabel(row: Element): string | null | undefined {
  return row.querySelector("[data-menu-label]")?.textContent;
}

/** The markup a RibbonIcon draws at `size`, to compare a row's picture with. */
function iconMarkup(iconKey: RibbonIconKey, size: number): string {
  const host = document.createElement("div");
  const r = createRoot(host);
  act(() => r.render(React.createElement(RibbonIcon[iconKey], { size })));
  const html = host.innerHTML;
  act(() => r.unmount());
  return html;
}

async function openMenu(style: Partial<StyleData> | null = {}): Promise<void> {
  await render(style);
  click(byTestId("fmt-orientation"));
}

/** The six rows of Excel's menu, by test id, in order. */
const ROW_IDS = [
  "fmt-orientation-angleCounterclockwise",
  "fmt-orientation-angleClockwise",
  "fmt-orientation-verticalText",
  "fmt-orientation-rotateTextUp",
  "fmt-orientation-rotateTextDown",
  "fmt-orientation-formatCellAlignment",
];

const ROTATIONS: Array<[testId: string, value: string, label: string]> = [
  ["fmt-orientation-angleCounterclockwise", "custom:45", "Angle Counterclockwise"],
  ["fmt-orientation-angleClockwise", "custom:-45", "Angle Clockwise"],
  ["fmt-orientation-verticalText", "vertical", "Vertical Text"],
  ["fmt-orientation-rotateTextUp", "rotate90", "Rotate Text Up"],
  ["fmt-orientation-rotateTextDown", "rotate270", "Rotate Text Down"],
];

const AUTOFIT = `execute:${CoreCommands.AUTOFIT_ROW_HEIGHT}:${JSON.stringify({ growOnly: true })}`;

// ============================================================================
// The control
// ============================================================================

describe("the control", () => {
  for (const surface of SURFACES) {
    it(`is Excel's 28px icon button with a chevron, named Orientation (${surface[0]})`, async () => {
      await render({}, surface);
      const trigger = byTestId("fmt-orientation");
      expect(trigger.tagName).toBe("BUTTON");
      expect(trigger.getAttribute("aria-label")).toBe("Orientation");
      expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(trigger.hasAttribute("title")).toBe(false);
      // A standard control on both surfaces: Excel's Orientation is a small
      // button in the band too, never a hero.
      expect(trigger.style.height).toBe(`${CONTROL_HEIGHT_MD}px`);
      // The face is Text Orientation at the standard 20px, then the chevron.
      const svgs = trigger.querySelectorAll("svg");
      expect(svgs).toHaveLength(2);
      expect(svgs[0].outerHTML).toBe(iconMarkup("TextOrientation", ICON_SIZE_SM));
    });
  }

  for (const surface of SURFACES) {
    it(`paints with tokens only, the open menu included (${surface[0]})`, async () => {
      await render({ textRotation: "rotate90" }, surface);
      expect(findHardcodedColours(container)).toEqual([]);
      click(byTestId("fmt-orientation"));
      const menu = document.querySelector("[role='menu']");
      expect(menu, "the menu opened").not.toBeNull();
      // The whole card the menu sits in (portalled to <body>).
      expect(findHardcodedColours(document.body)).toEqual([]);
    });
  }

  it("has no pressed state, even on rotated text (Excel's Orientation has none)", async () => {
    await render({ textRotation: "rotate90" });
    const trigger = byTestId("fmt-orientation");
    expect(trigger.hasAttribute("aria-pressed")).toBe(false);
    expect(trigger.hasAttribute("data-active")).toBe(false);
  });

  it("opens its menu on click, and a click on the trigger runs nothing", async () => {
    await openMenu();
    expect(byTestId("fmt-orientation").getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("[role='menu']")).not.toBeNull();
    expect(applyFormat).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("shows the catalog tooltip on hover, falling back to the label when the catalog has none", async () => {
    async function tooltipText(): Promise<string | null | undefined> {
      vi.useFakeTimers();
      act(() => {
        byTestId("fmt-orientation").dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
      });
      act(() => {
        vi.advanceTimersByTime(TOOLTIP_DELAY_MS + 50);
      });
      vi.useRealTimers();
      return document.querySelector("[role='tooltip']")?.textContent;
    }
    await render({});
    expect(await tooltipText()).toBe("Orientation");
    act(() => root.unmount());
    root = createRoot(container);
    await render({}, SURFACES[0], { ...ITEM, tooltip: undefined, label: "Text Direction" });
    expect(await tooltipText()).toBe("Text Direction");
    expect(byTestId("fmt-orientation").getAttribute("aria-label")).toBe("Text Direction");
  });
});

// ============================================================================
// The menu
// ============================================================================

describe("the menu", () => {
  it("is Excel's six rows, in Excel's order, with a separator before Format Cell Alignment", async () => {
    await openMenu();
    expect(rows().map(rowLabel)).toEqual([
      "Angle Counterclockwise",
      "Angle Clockwise",
      "Vertical Text",
      "Rotate Text Up",
      "Rotate Text Down",
      "Format Cell Alignment",
    ]);
    expect(rows().map((r) => r.getAttribute("data-testid"))).toEqual(ROW_IDS);
    // The five orientations are check rows; Format Cell Alignment is a command.
    expect(rows().map((r) => r.getAttribute("role"))).toEqual([
      "menuitemcheckbox",
      "menuitemcheckbox",
      "menuitemcheckbox",
      "menuitemcheckbox",
      "menuitemcheckbox",
      "menuitem",
    ]);
    const menu = document.querySelector("[role='menu']")!;
    const children = Array.from(menu.children);
    const separator = children.findIndex((c) => c.getAttribute("role") === "separator");
    expect(separator).toBe(5);
    expect(children[separator + 1].getAttribute("data-testid")).toBe("fmt-orientation-formatCellAlignment");
    expect(menu.querySelectorAll("[role='separator']")).toHaveLength(1);
  });

  it("every row carries the contract's picture at the 20px menu size", async () => {
    await openMenu();
    const expected: RibbonIconKey[] = [
      "AngleCounterclockwise",
      "AngleClockwise",
      "VerticalText",
      "RotateTextUp",
      "RotateTextDown",
      "TextOrientation",
    ];
    rows().forEach((row, i) => {
      // [check column][icon column][label]: the icon column holds the picture.
      const iconColumn = row.children[1];
      expect(iconColumn.querySelector("[data-menu-label]")).toBeNull();
      expect(iconColumn.innerHTML, rowLabel(row) ?? "").toBe(iconMarkup(expected[i], 20));
    });
    // The table the component renders from names the same keys.
    expect(ORIENTATION_ROWS.map((r) => r.icon)).toEqual(expected.slice(0, 5));
  });

  it("the keyboard: ArrowDown on the trigger opens on the first row, Enter runs the focused row", async () => {
    await render({});
    key(byTestId("fmt-orientation"), "ArrowDown");
    expect(document.activeElement).toBe(byTestId(ROW_IDS[0]));
    key(byTestId(ROW_IDS[0]), "ArrowDown");
    key(byTestId(ROW_IDS[1]), "ArrowDown");
    key(byTestId(ROW_IDS[2]), "Enter");
    await settle();
    expect(applyFormat).toHaveBeenCalledWith({ textRotation: "vertical" }, "Vertical Text");
    expect(document.querySelector("[role='menu']")).toBeNull();
    expect(document.activeElement).toBe(byTestId("fmt-orientation"));
  });
});

// ============================================================================
// Checked: the active cell's orientation
// ============================================================================

describe("checked rows follow the active cell's textRotation", () => {
  for (const [testId, value] of ROTATIONS) {
    it(`${value} checks ${testId} and nothing else`, async () => {
      await openMenu({ textRotation: value });
      for (const row of rows()) {
        const expected = row.getAttribute("data-testid") === testId;
        if (row.getAttribute("role") !== "menuitemcheckbox") continue;
        expect(row.getAttribute("aria-checked"), row.getAttribute("data-testid") ?? "").toBe(String(expected));
      }
    });
  }

  for (const [what, style] of [
    ["horizontal text", { textRotation: "none" }],
    ["an angle no row names (30 degrees)", { textRotation: "custom:30" }],
    ["no style read yet", null],
  ] as const) {
    it(`nothing is checked for ${what}`, async () => {
      await openMenu(style);
      for (const row of rows().slice(0, 5)) expect(row.getAttribute("aria-checked")).toBe("false");
    });
  }
});

// ============================================================================
// What each row runs
// ============================================================================

describe("what each row runs", () => {
  for (const [testId, value, label] of ROTATIONS) {
    it(`${label}: the rotation, then a grow-only AutoFit of the rows, as ONE undo step`, async () => {
      await openMenu({ textRotation: "none" });
      click(byTestId(testId));
      await settle();
      expect(applyFormat).toHaveBeenCalledTimes(1);
      expect(applyFormat).toHaveBeenCalledWith({ textRotation: value }, label);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(CoreCommands.AUTOFIT_ROW_HEIGHT, { growOnly: true });
      // The begin opens the step before anything is written and the commit
      // closes it after the AutoFit: one Ctrl+Z takes both back, as one
      // Ctrl+Z restores Excel's orientation AND its automatic row height.
      expect(log).toEqual([`begin:${label}`, `format:${value}`, AUTOFIT, "commit:7"]);
      expect(lib.cancelUndoTransaction).not.toHaveBeenCalled();
    });
  }

  for (const [testId, value, label] of ROTATIONS) {
    it(`${label} when already chosen returns the text to horizontal, and grows nothing`, async () => {
      await openMenu({ textRotation: value });
      click(byTestId(testId));
      await settle();
      expect(applyFormat).toHaveBeenCalledTimes(1);
      expect(applyFormat).toHaveBeenCalledWith({ textRotation: "none" }, label);
      expect(execute).not.toHaveBeenCalled();
      expect(log).toEqual(["format:none"]);
    });
  }

  it("a different row switches straight to it (Excel: 45 degrees, then Rotate Text Up, gives 90)", async () => {
    await openMenu({ textRotation: "custom:45" });
    click(byTestId("fmt-orientation-rotateTextUp"));
    await settle();
    expect(applyFormat).toHaveBeenCalledWith({ textRotation: "rotate90" }, "Rotate Text Up");
    expect(execute).toHaveBeenCalledWith(CoreCommands.AUTOFIT_ROW_HEIGHT, { growOnly: true });
  });

  it("Format Cell Alignment opens Format Cells on the Alignment tab, and writes nothing", async () => {
    await openMenu();
    click(byTestId("fmt-orientation-formatCellAlignment"));
    await settle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(CoreCommands.FORMAT_CELLS, { tab: "alignment" });
    expect(applyFormat).not.toHaveBeenCalled();
    expect(lib.beginUndoTransaction).not.toHaveBeenCalled();
  });

  it("a begin that fails still applies the rotation and the AutoFit (as two steps), closing nothing", async () => {
    lib.beginUndoTransaction.mockRejectedValue(new Error("ipc down"));
    await openMenu();
    click(byTestId("fmt-orientation-angleClockwise"));
    await settle();
    expect(log).toEqual(["format:custom:-45", AUTOFIT]);
    expect(lib.commitUndoTransaction).not.toHaveBeenCalled();
    expect(dialogs.alertAsync).not.toHaveBeenCalled();
  });

  it("a begin that JOINS a script's batch closes nothing: the holder closes it", async () => {
    lib.beginUndoTransaction.mockResolvedValue(null);
    await openMenu();
    click(byTestId("fmt-orientation-angleClockwise"));
    await settle();
    expect(log).toEqual(["format:custom:-45", AUTOFIT]);
    expect(lib.commitUndoTransaction).not.toHaveBeenCalled();
    expect(lib.cancelUndoTransaction).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Indented text (Excel disables the four angles)
// ============================================================================

describe("with an indent, the four angle rows are disabled and Vertical Text is not", () => {
  it("disables exactly the four angles", async () => {
    await openMenu({ indent: 2 });
    const disabled = rows().map((r) => [r.getAttribute("data-testid"), r.disabled]);
    expect(disabled).toEqual([
      ["fmt-orientation-angleCounterclockwise", true],
      ["fmt-orientation-angleClockwise", true],
      ["fmt-orientation-verticalText", false],
      ["fmt-orientation-rotateTextUp", true],
      ["fmt-orientation-rotateTextDown", true],
      ["fmt-orientation-formatCellAlignment", false],
    ]);
    expect(ORIENTATION_UNAVAILABLE_WHILE_INDENTED).toEqual(["custom:45", "custom:-45", "rotate90", "rotate270"]);
  });

  it("a disabled row runs nothing; Vertical Text still runs", async () => {
    await openMenu({ indent: 1 });
    click(byTestId("fmt-orientation-angleCounterclockwise"));
    await settle();
    expect(applyFormat).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    click(byTestId("fmt-orientation-verticalText"));
    await settle();
    expect(applyFormat).toHaveBeenCalledWith({ textRotation: "vertical" }, "Vertical Text");
  });

  it("the arrows skip the disabled angles", async () => {
    await render({ indent: 3 });
    key(byTestId("fmt-orientation"), "ArrowDown");
    expect(document.activeElement).toBe(byTestId("fmt-orientation-verticalText"));
    key(byTestId("fmt-orientation-verticalText"), "ArrowDown");
    expect(document.activeElement).toBe(byTestId("fmt-orientation-formatCellAlignment"));
  });

  it("with no indent every row is enabled (positive control)", async () => {
    await openMenu({ indent: 0 });
    expect(rows().every((r) => !r.disabled)).toBe(true);
  });
});

// ============================================================================
// Refusals reach the user
// ============================================================================

describe("refusals", () => {
  it("while something else owns the selection: one toast, nothing written, no step opened", async () => {
    releaseOwner = registerSelectionOwner({
      id: "test-owner",
      label: "the test object's cells",
      ownsSelection: () => true,
    });
    await openMenu();
    click(byTestId("fmt-orientation-rotateTextUp"));
    await settle();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toContain("Rotate Text Up");
    expect(applyFormat).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(lib.beginUndoTransaction).not.toHaveBeenCalled();
  });

  it("a write the door refused (applyFormat answers false) is not followed by an AutoFit", async () => {
    applyFormat.mockImplementation(async (formatting: { textRotation?: string }) => {
      log.push(`format:${formatting.textRotation}`);
      return false;
    });
    await openMenu();
    click(byTestId("fmt-orientation-rotateTextDown"));
    await settle();
    expect(execute).not.toHaveBeenCalled();
    // The (empty) step is still closed: an open transaction would swallow
    // every later edit.
    expect(log).toEqual(["begin:Rotate Text Down", "format:rotate270", "commit:7"]);
  });

  it("a write the door CONFIRMS (applyFormat answers true) is followed by the AutoFit (positive control)", async () => {
    // The door's answer as home-core is asked to make it (true = written,
    // false = refused): only `false` may skip the AutoFit, so a door that
    // starts answering `true` must not silently stop rotated text growing.
    applyFormat.mockImplementation(async (formatting: { textRotation?: string }) => {
      log.push(`format:${formatting.textRotation}`);
      return true;
    });
    await openMenu();
    click(byTestId("fmt-orientation-rotateTextDown"));
    await settle();
    expect(log).toEqual(["begin:Rotate Text Down", "format:rotate270", AUTOFIT, "commit:7"]);
  });

  it("a write that throws is shown, the step is closed, and nothing is AutoFitted", async () => {
    applyFormat.mockRejectedValue(new Error("The cell is on a protected sheet."));
    await openMenu();
    click(byTestId("fmt-orientation-angleCounterclockwise"));
    await settle();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("The cell is on a protected sheet.");
    expect(execute).not.toHaveBeenCalled();
    expect(lib.commitUndoTransaction).toHaveBeenCalledWith(7);
  });

  it("an AutoFit that throws is shown, and the rotation that landed stays one undoable step", async () => {
    execute.mockRejectedValue(new Error("Row height refused."));
    await openMenu();
    click(byTestId("fmt-orientation-verticalText"));
    await settle();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("Row height refused.");
    expect(log).toEqual(["begin:Vertical Text", "format:vertical", "commit:7"]);
  });

  it("returning to horizontal: a thrown refusal is shown", async () => {
    applyFormat.mockRejectedValue("Formatting refused.");
    await openMenu({ textRotation: "vertical" });
    click(byTestId("fmt-orientation-verticalText"));
    await settle();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("Formatting refused.");
  });

  it("Format Cell Alignment: a thrown refusal is shown", async () => {
    execute.mockRejectedValue(new Error("Format Cells is not available here."));
    await openMenu();
    click(byTestId("fmt-orientation-formatCellAlignment"));
    await settle();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("Format Cells is not available here.");
  });
});
