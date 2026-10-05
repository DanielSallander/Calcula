//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/alignment/accountingSplitButton.test.tsx
// PURPOSE: Excel's Accounting Number Format split button on the Home tab's
//          Number group (CONTRACT 3.7): the icon half applies the locale's
//          Accounting format, the chevron opens Excel's currency menu -- six
//          currencies with no pictures (so no icon column), a separator, and
//          "More Accounting Formats..." -- and each row writes exactly the
//          preset keyword the backend accepts. Refusals reach the user.
// CONTEXT: Rendered alone (HomeItemProps), in the ribbon band and the sidebar
//          panel. The Home tab's state is a double, so `applyFormat` is
//          observed as the component calls it; the command registry is the
//          real one with `execute` spied.

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
import { RibbonIcon } from "@api/ribbonIcons";
import { CommandRegistry, CoreCommands } from "@api/commands";
import type { HomeTabItem } from "../../homeTabConfig";
import type { HomeTabState } from "../../components/homeItemProps";
import { AccountingSplitButton } from "../../components/alignment/AccountingSplitButton";
import { ACCOUNTING_MENU_ROWS } from "../../components/alignment/accountingMenu";

// ============================================================================
// Harness
// ============================================================================

/** The catalog entry CONTRACT section 2 names (home-core adds it to ALL_ITEMS). */
const ITEM: HomeTabItem = {
  id: "accountingFormat",
  label: "Accounting Number Format",
  tooltip: "Accounting Number Format",
  type: "button",
  category: "Number",
  addedIn: 2,
};

const applyFormat = vi.fn();
const execute = vi.fn();

let container: HTMLDivElement;
let root: Root;

const STATE = { currentStyle: null, applyFormat } as unknown as HomeTabState;

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  dialogs.alertAsync.mockClear();
  applyFormat.mockReset().mockResolvedValue(undefined);
  execute.mockReset().mockResolvedValue(undefined);
  vi.spyOn(CommandRegistry, "execute").mockImplementation((id: string, args?: unknown) => execute(id, args));
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  document.body.innerHTML = "";
});

const SURFACES: Array<[string, () => SurfaceLayout, boolean]> = [
  ["band", () => bandLayout(1200), true],
  ["panel", () => panelLayout(300), false],
];

async function render(
  surface: [string, () => SurfaceLayout, boolean] = SURFACES[0],
  item: HomeTabItem = ITEM,
): Promise<void> {
  const [, layout, band] = surface;
  await act(async () => {
    root.render(
      <SurfaceLayoutProvider value={layout()}>
        <AccountingSplitButton item={item} state={STATE} band={band} />
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

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

function rows(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("[role='menu'] button"));
}

function rowLabel(row: Element): string | null | undefined {
  return row.querySelector("[data-menu-label]")?.textContent;
}

function iconMarkup(size: number): string {
  const host = document.createElement("div");
  const r = createRoot(host);
  act(() => r.render(<RibbonIcon.Accounting size={size} />));
  const html = host.innerHTML;
  act(() => r.unmount());
  return html;
}

/** CONTRACT 3.7, row by row: label, preset keyword, test id. */
const CONTRACT_ROWS: Array<[label: string, preset: string, testId: string]> = [
  ["$ English (United States)", "accounting_usd", "fmt-accountingFormat-usd"],
  ["£ English (United Kingdom)", "accounting_gbp", "fmt-accountingFormat-gbp"],
  ["€ Euro (€ 123)", "accounting_eur_before", "fmt-accountingFormat-eurBefore"],
  ["€ Euro (123 €)", "accounting_eur_after", "fmt-accountingFormat-eurAfter"],
  ["¥ Chinese (PRC)", "accounting_cny", "fmt-accountingFormat-cny"],
  ["CHF French (Switzerland)", "accounting_chf", "fmt-accountingFormat-chf"],
];

// ============================================================================
// The control
// ============================================================================

describe("the control", () => {
  for (const surface of SURFACES) {
    it(`is Excel's icon split button: two named 28px halves, the Accounting picture on its face (${surface[0]})`, async () => {
      await render(surface);
      const main = byTestId("fmt-accountingFormat");
      const chevron = byTestId("fmt-accountingFormat-options");
      expect(main.getAttribute("aria-label")).toBe("Accounting Number Format");
      expect(chevron.getAttribute("aria-label")).toBe("Accounting Number Format options");
      expect(chevron.getAttribute("aria-haspopup")).toBe("menu");
      expect(main.hasAttribute("title")).toBe(false);
      expect(chevron.hasAttribute("title")).toBe(false);
      expect(main.style.height).toBe(`${CONTROL_HEIGHT_MD}px`);
      expect(chevron.style.height).toBe(`${CONTROL_HEIGHT_MD}px`);
      expect(main.innerHTML).toBe(iconMarkup(ICON_SIZE_SM));
      // No pressed state: Excel's Accounting button has none.
      expect(main.hasAttribute("aria-pressed")).toBe(false);
    });
  }

  for (const surface of SURFACES) {
    it(`paints with tokens only, the open menu included (${surface[0]})`, async () => {
      await render(surface);
      expect(findHardcodedColours(container)).toEqual([]);
      click(byTestId("fmt-accountingFormat-options"));
      expect(document.querySelector("[role='menu']"), "the menu opened").not.toBeNull();
      expect(findHardcodedColours(document.body)).toEqual([]);
    });
  }

  it("the icon half applies the locale's Accounting format, and opens no menu", async () => {
    await render();
    click(byTestId("fmt-accountingFormat"));
    await settle();
    expect(applyFormat).toHaveBeenCalledTimes(1);
    expect(applyFormat).toHaveBeenCalledWith({ numberFormat: "accounting" }, "Accounting Number Format");
    expect(execute).not.toHaveBeenCalled();
    expect(document.querySelector("[role='menu']")).toBeNull();
  });

  it("shows the catalog tooltip on hover, falling back to the label", async () => {
    async function tooltipText(): Promise<string | null | undefined> {
      vi.useFakeTimers();
      act(() => {
        byTestId("fmt-accountingFormat").dispatchEvent(
          new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }),
        );
      });
      act(() => {
        vi.advanceTimersByTime(TOOLTIP_DELAY_MS + 50);
      });
      vi.useRealTimers();
      return document.querySelector("[role='tooltip']")?.textContent;
    }
    await render();
    expect(await tooltipText()).toBe("Accounting Number Format");
    act(() => root.unmount());
    root = createRoot(container);
    await render(SURFACES[0], { ...ITEM, tooltip: undefined, label: "Accounting" });
    expect(await tooltipText()).toBe("Accounting");
  });
});

// ============================================================================
// The menu
// ============================================================================

describe("the menu", () => {
  it("is Excel's currency rows, a separator, then More Accounting Formats...", async () => {
    await render();
    click(byTestId("fmt-accountingFormat-options"));
    expect(rows().map(rowLabel)).toEqual([...CONTRACT_ROWS.map(([label]) => label), "More Accounting Formats..."]);
    expect(rows().map((r) => r.getAttribute("data-testid"))).toEqual([
      ...CONTRACT_ROWS.map(([, , testId]) => testId),
      "fmt-accountingFormat-more",
    ]);
    expect(rows().every((r) => r.getAttribute("role") === "menuitem")).toBe(true);
    const menu = document.querySelector("[role='menu']")!;
    expect(menu.getAttribute("aria-label")).toBe("Accounting Number Format");
    const children = Array.from(menu.children);
    expect(children.findIndex((c) => c.getAttribute("role") === "separator")).toBe(6);
    expect(menu.querySelectorAll("[role='separator']")).toHaveLength(1);
    expect(ACCOUNTING_MENU_ROWS.map((r) => r.preset)).toEqual(CONTRACT_ROWS.map(([, preset]) => preset));
  });

  it("no row has a picture, so no row reserves an icon column (Excel's list starts at the symbol)", async () => {
    await render();
    click(byTestId("fmt-accountingFormat-options"));
    for (const row of rows()) {
      // [check column][label] -- no icon span between them, blank or drawn.
      expect(row.children, rowLabel(row) ?? "").toHaveLength(2);
      expect(row.children[1].hasAttribute("data-menu-label")).toBe(true);
      expect(row.querySelector("svg")).toBeNull();
      expect(row.querySelector("[data-menu-icon-blank]")).toBeNull();
      expect(row.getAttribute("aria-checked")).toBeNull();
    }
  });

  for (const [label, preset, testId] of CONTRACT_ROWS) {
    it(`"${label}" applies ${preset}`, async () => {
      await render();
      click(byTestId("fmt-accountingFormat-options"));
      click(byTestId(testId));
      await settle();
      expect(applyFormat).toHaveBeenCalledTimes(1);
      expect(applyFormat).toHaveBeenCalledWith({ numberFormat: preset }, "Accounting Number Format");
      expect(execute).not.toHaveBeenCalled();
      expect(document.querySelector("[role='menu']")).toBeNull();
    });
  }

  it("More Accounting Formats... opens Format Cells on the Accounting category, and writes nothing", async () => {
    await render();
    click(byTestId("fmt-accountingFormat-options"));
    click(byTestId("fmt-accountingFormat-more"));
    await settle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(CoreCommands.FORMAT_CELLS, { tab: "number", category: "accounting" });
    expect(applyFormat).not.toHaveBeenCalled();
  });

  it("the keyboard: ArrowDown on the icon half opens the menu on the first row, Enter runs a row", async () => {
    await render();
    key(byTestId("fmt-accountingFormat"), "ArrowDown");
    expect(document.activeElement).toBe(byTestId("fmt-accountingFormat-usd"));
    key(byTestId("fmt-accountingFormat-usd"), "ArrowDown");
    key(byTestId("fmt-accountingFormat-gbp"), "Enter");
    await settle();
    expect(applyFormat).toHaveBeenCalledWith({ numberFormat: "accounting_gbp" }, "Accounting Number Format");
    expect(document.activeElement).toBe(byTestId("fmt-accountingFormat"));
  });
});

// ============================================================================
// Refusals reach the user
// ============================================================================

describe("refusals", () => {
  it("the icon half: a thrown refusal is shown", async () => {
    applyFormat.mockRejectedValue(new Error("The cell is on a protected sheet."));
    await render();
    click(byTestId("fmt-accountingFormat"));
    await settle();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("The cell is on a protected sheet.");
  });

  it("a currency row: a thrown refusal is shown", async () => {
    applyFormat.mockRejectedValue("Formatting refused.");
    await render();
    click(byTestId("fmt-accountingFormat-options"));
    click(byTestId("fmt-accountingFormat-chf"));
    await settle();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("Formatting refused.");
  });

  it("More Accounting Formats...: a thrown refusal is shown", async () => {
    execute.mockRejectedValue(new Error("Format Cells is not available here."));
    await render();
    click(byTestId("fmt-accountingFormat-options"));
    click(byTestId("fmt-accountingFormat-more"));
    await settle();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("Format Cells is not available here.");
  });

  it("nothing is shown when the write succeeds (positive control)", async () => {
    await render();
    click(byTestId("fmt-accountingFormat"));
    await settle();
    expect(dialogs.alertAsync).not.toHaveBeenCalled();
  });
});
