//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/editing/autoSumSplitButton.test.tsx
// PURPOSE: Excel's AutoSum split button (CONTRACT 3.14): the sigma half runs
//          AutoSum with SUM, the chevron opens Excel's menu -- Sum, Average,
//          Count Numbers, Max, Min, then More Functions... -- and every row
//          runs exactly the contract's command with the contract's args, on
//          both surfaces, with a refusal reaching the user.

/* eslint-disable @typescript-eslint/naming-convention --
 * The module double below stands in for RibbonIcon, whose real name is
 * PascalCase. */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";

vi.mock("@api", async () => {
  const icons = await import("@api/ribbonIcons");
  return { RibbonIcon: icons.RibbonIcon };
});

const dialogs = vi.hoisted(() => ({ alertAsync: vi.fn() }));
vi.mock("@api/dialogs", () => dialogs);

import { TOOLTIP_DELAY_MS, findHardcodedColours, ICON_SIZE_SM } from "@api/layout";
import { initKeybindings } from "@api/keybindings";
import { CommandRegistry, CoreCommands, ExtensionCommands } from "@api/commands";
import { AutoSumSplitButton, AUTOSUM_MENU_ROWS } from "../../components/editing/AutoSumSplitButton";
import {
  EDITING_ITEMS,
  SURFACES,
  byTestId,
  click,
  host,
  key,
  menuOutline,
  menuRows,
  mountRoot,
  openMenu,
  propsFor,
  renderOn,
  rowIconSize,
  rowPicture,
  rowShortcut,
  settle,
  unmountRoot,
} from "./editingHarness";

const item = EDITING_ITEMS.autoSum;
let execute: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  initKeybindings();
});

beforeEach(() => {
  mountRoot();
  execute = vi.spyOn(CommandRegistry, "execute").mockResolvedValue(undefined);
  dialogs.alertAsync.mockReset();
});

afterEach(() => {
  unmountRoot();
  execute.mockRestore();
  vi.useRealTimers();
});

for (const surface of SURFACES) {
  describe(`AutoSum in the ${surface.name}`, () => {
    const render = () => renderOn(surface, <AutoSumSplitButton {...propsFor(item, surface.band)} />);

    it("is an icon split: the sigma half and a chevron half, both named, no native title", async () => {
      await render();
      const main = byTestId("fmt-autoSum");
      const chevron = byTestId("fmt-autoSum-options");
      expect(main.getAttribute("aria-label")).toBe("AutoSum");
      expect(chevron.getAttribute("aria-label")).toBe("AutoSum options");
      expect(chevron.getAttribute("aria-haspopup")).toBe("menu");
      expect(main.hasAttribute("title")).toBe(false);
      expect(chevron.hasAttribute("title")).toBe(false);
      // The icon face on BOTH surfaces (Excel's narrow Editing group): the
      // picture is the 20px AutoSum sigma, never the label.
      expect(main.querySelector("svg")?.getAttribute("width")).toBe(String(ICON_SIZE_SM));
      expect(main.textContent).toBe("");
      expect(main.closest(".split")).not.toBeNull();
      expect(findHardcodedColours(host())).toEqual([]);
    });

    it("the sigma half runs AutoSum with SUM, once, and opens no menu", async () => {
      await render();
      click(byTestId("fmt-autoSum"));
      expect(execute.mock.calls).toStrictEqual([[ExtensionCommands.AUTOSUM, { fn: "SUM" }]]);
      expect(openMenu()).toBeNull();
    });

    it("the menu is Excel's: Sum, Average, Count Numbers, Max, Min, a separator, More Functions...", async () => {
      await render();
      click(byTestId("fmt-autoSum-options"));
      expect(menuOutline()).toEqual(["Sum", "Average", "Count Numbers", "Max", "Min", "---", "More Functions..."]);
      expect(menuRows().map((r) => r.getAttribute("data-testid"))).toEqual([
        "fmt-autoSum-sum",
        "fmt-autoSum-average",
        "fmt-autoSum-countNumbers",
        "fmt-autoSum-max",
        "fmt-autoSum-min",
        "fmt-autoSum-moreFunctions",
      ]);
      // Only Sum has a picture; every other row RESERVES the picture column,
      // so the labels line up as Excel's do.
      expect(menuRows().map(rowPicture)).toEqual(["icon", "blank", "blank", "blank", "blank", "blank"]);
      expect(rowIconSize(menuRows()[0])).toBe("20");
      for (const row of menuRows()) {
        expect(row.getAttribute("role")).toBe("menuitem");
        expect(row.disabled).toBe(false);
      }
      expect(findHardcodedColours(openMenu()!)).toEqual([]);
    });

    it("each row runs exactly its command with its args", async () => {
      await render();
      const expected: Array<[string, unknown[]]> = [
        ["fmt-autoSum-sum", [ExtensionCommands.AUTOSUM, { fn: "SUM" }]],
        ["fmt-autoSum-average", [ExtensionCommands.AUTOSUM, { fn: "AVERAGE" }]],
        ["fmt-autoSum-countNumbers", [ExtensionCommands.AUTOSUM, { fn: "COUNT" }]],
        ["fmt-autoSum-max", [ExtensionCommands.AUTOSUM, { fn: "MAX" }]],
        ["fmt-autoSum-min", [ExtensionCommands.AUTOSUM, { fn: "MIN" }]],
        ["fmt-autoSum-moreFunctions", [CoreCommands.INSERT_FUNCTION]],
      ];
      for (const [testId, call] of expected) {
        execute.mockClear();
        click(byTestId("fmt-autoSum-options"));
        click(byTestId(testId));
        expect(execute.mock.calls, testId).toStrictEqual([call]);
        // The menu closed before the command ran (a dialog keeps its focus).
        expect(openMenu(), testId).toBeNull();
      }
    });

    it("the keyboard: ArrowDown on the sigma half opens the menu on Sum; Enter runs a row", async () => {
      await render();
      key(byTestId("fmt-autoSum"), "ArrowDown");
      expect(document.activeElement).toBe(byTestId("fmt-autoSum-sum"));
      key(byTestId("fmt-autoSum-sum"), "ArrowDown");
      key(byTestId("fmt-autoSum-average"), "Enter");
      expect(execute.mock.calls).toStrictEqual([[ExtensionCommands.AUTOSUM, { fn: "AVERAGE" }]]);
      expect(document.activeElement).toBe(byTestId("fmt-autoSum"));
    });
  });
}

describe("refusals and teaching", () => {
  const render = () => renderOn(SURFACES[0], <AutoSumSplitButton {...propsFor(item, true)} />);

  it("a refusal from the sigma half reaches the user, in the command's words", async () => {
    execute.mockRejectedValueOnce(new Error("AutoSum can't be used on a protected sheet."));
    await render();
    click(byTestId("fmt-autoSum"));
    await settle();
    expect(dialogs.alertAsync).toHaveBeenCalledTimes(1);
    expect(dialogs.alertAsync).toHaveBeenCalledWith("AutoSum can't be used on a protected sheet.");
  });

  it("a refusal from a menu row reaches the user too (a non-Error refusal as its text)", async () => {
    execute.mockRejectedValueOnce("Insert Function is not available here.");
    await render();
    click(byTestId("fmt-autoSum-options"));
    click(byTestId("fmt-autoSum-moreFunctions"));
    await settle();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("Insert Function is not available here.");
  });

  it("a command that succeeds alerts nothing (positive control)", async () => {
    await render();
    click(byTestId("fmt-autoSum"));
    await settle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(dialogs.alertAsync).not.toHaveBeenCalled();
  });

  it("Sum and More Functions... show their LIVE bindings (Alt+=, Shift+F3); the other rows none", async () => {
    await render();
    click(byTestId("fmt-autoSum-options"));
    const chips = menuRows().map(rowShortcut);
    expect(chips[0]).toMatch(/^Alt\+=$/);
    expect(chips[5]).toBe("Shift+F3");
    // Average..Min run AutoSum too, but Alt+= is SUM: a chip there would lie.
    expect(chips.slice(1, 5)).toEqual([null, null, null, null]);
  });

  it("the sigma half's tooltip is 'AutoSum' with the live Alt+= chip", async () => {
    await render();
    vi.useFakeTimers();
    act(() => {
      byTestId("fmt-autoSum").dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS + 50);
    });
    const tip = document.querySelector("[role='tooltip']");
    expect(tip?.textContent).toContain("AutoSum");
    expect(tip?.querySelector("kbd")?.textContent).toBe("Alt+=");
    // Said once: the catalog's "(Alt+=)" is not repeated in the text.
    expect(tip?.textContent).not.toContain("(Alt+=)");
  });

  it("AUTOSUM_MENU_ROWS is the five functions AutoSum accepts, in Excel's order", () => {
    expect(AUTOSUM_MENU_ROWS.map((r) => r.fn)).toEqual(["SUM", "AVERAGE", "COUNT", "MAX", "MIN"]);
  });
});
