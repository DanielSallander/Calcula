//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/editing/clearMenuButton.test.tsx
// PURPOSE: Excel's Clear menu button (CONTRACT 3.16): Clear All (row test id
//          `fmt-clear-all`; `fmt-clearAll` is the standalone button a migrated
//          layout keeps beside this menu, so the two never share an id), Clear
//          Formats, Clear Contents, Clear Comments and Notes, Clear Hyperlinks,
//          a separator, Remove Hyperlinks -- and WHEN two of them are greyed,
//          which is Excel's measured rule (live Excel 16 build 20430,
//          2026-10-04, GetEnabledMso; scratchpad home-editing-probe/probe2.out
//          and probe3.out):
//
//            HyperlinksRemove  enabled iff some cell of the selection (any
//                              Ctrl+click area) holds a hyperlink;
//            ClearComments     enabled iff some cell holds a note OR a
//                              threaded comment;
//            every other row   always enabled (Clear Hyperlinks included).
//
//          Both are read from the backend WHEN THE MENU OPENS -- never on
//          every selection change of a closed menu.

/* eslint-disable @typescript-eslint/naming-convention --
 * The module double below stands in for RibbonIcon, whose real name is
 * PascalCase. */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

vi.mock("@api", async () => {
  const icons = await import("@api/ribbonIcons");
  return { RibbonIcon: icons.RibbonIcon };
});

const dialogs = vi.hoisted(() => ({ alertAsync: vi.fn() }));
vi.mock("@api/dialogs", () => dialogs);

const grid = vi.hoisted(() => ({
  state: {
    selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" } as Record<string, unknown> | null,
    surface: "grid",
    config: { totalRows: 1048576, totalCols: 16384 },
  },
}));
vi.mock("@api/grid", () => ({ useGridState: () => grid.state }));

/** The three backend reads, as @api/lib exports them. */
const lib = vi.hoisted(() => ({
  getHyperlinksInRange: vi.fn(),
  getCommentIndicatorsInRange: vi.fn(),
  getNoteIndicatorsInRange: vi.fn(),
}));
vi.mock("@api/lib", () => lib);

import { findHardcodedColours, ICON_SIZE_SM } from "@api/layout";
import { initKeybindings } from "@api/keybindings";
import { CommandRegistry, CoreCommands } from "@api/commands";
import { ClearMenuButton } from "../../components/editing/ClearMenuButton";
import {
  EDITING_ITEMS,
  SURFACES,
  byTestId,
  click,
  host,
  isRowDisabled,
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

const item = EDITING_ITEMS.clear;
let execute: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  initKeybindings();
});

beforeEach(() => {
  mountRoot();
  execute = vi.spyOn(CommandRegistry, "execute").mockResolvedValue(undefined);
  dialogs.alertAsync.mockReset();
  lib.getHyperlinksInRange.mockReset().mockResolvedValue([]);
  lib.getCommentIndicatorsInRange.mockReset().mockResolvedValue([]);
  lib.getNoteIndicatorsInRange.mockReset().mockResolvedValue([]);
  grid.state = {
    selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" },
    surface: "grid",
    config: { totalRows: 1048576, totalCols: 16384 },
  };
});

afterEach(() => {
  unmountRoot();
  execute.mockRestore();
});

/** Open the menu and let its two reads land. */
async function openClear(): Promise<void> {
  click(byTestId("fmt-clear"));
  await settle();
}

for (const surface of SURFACES) {
  describe(`Clear in the ${surface.name}`, () => {
    const render = () => renderOn(surface, <ClearMenuButton {...propsFor(item, surface.band)} />);

    it("is one icon button with a chevron that opens a menu (Excel's narrow Clear)", async () => {
      await render();
      const trigger = byTestId("fmt-clear");
      expect(trigger.getAttribute("aria-label")).toBe("Clear");
      expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
      expect(trigger.hasAttribute("title")).toBe(false);
      expect(trigger.querySelector("svg")?.getAttribute("width")).toBe(String(ICON_SIZE_SM));
      expect(trigger.textContent).toBe("");
      expect(trigger.closest(".split")).toBeNull();
      await openClear();
      expect(openMenu()).not.toBeNull();
      expect(execute).not.toHaveBeenCalled();
      expect(findHardcodedColours(host())).toEqual([]);
      expect(findHardcodedColours(openMenu()!)).toEqual([]);
    });

    it("the menu is Excel's, in Excel's order, with Clear All as fmt-clear-all (fmt-clearAll is the standalone button's)", async () => {
      await render();
      await openClear();
      expect(menuOutline()).toEqual([
        "Clear All",
        "Clear Formats",
        "Clear Contents",
        "Clear Comments and Notes",
        "Clear Hyperlinks",
        "---",
        "Remove Hyperlinks",
      ]);
      expect(menuRows().map((r) => r.getAttribute("data-testid"))).toEqual([
        "fmt-clear-all",
        "fmt-clear-formats",
        "fmt-clear-contents",
        "fmt-clear-comments",
        "fmt-clear-hyperlinks",
        "fmt-clear-removeHyperlinks",
      ]);
      expect(menuRows().map(rowPicture)).toEqual(["icon", "icon", "blank", "blank", "blank", "icon"]);
      for (const row of menuRows().filter((r) => rowPicture(r) === "icon")) {
        expect(rowIconSize(row)).toBe("20");
      }
    });

    it("each row runs exactly its command, with no args", async () => {
      // Something to remove, so the two read-gated rows are live.
      lib.getHyperlinksInRange.mockResolvedValue([{ row: 0, col: 0 }]);
      lib.getNoteIndicatorsInRange.mockResolvedValue([{ row: 0, col: 0, visible: false }]);
      await render();
      const expected: Array<[string, string]> = [
        ["fmt-clear-all", CoreCommands.CLEAR_ALL],
        ["fmt-clear-formats", CoreCommands.CLEAR_FORMATTING],
        ["fmt-clear-contents", CoreCommands.CLEAR_CONTENTS],
        ["fmt-clear-comments", CoreCommands.CLEAR_COMMENTS],
        ["fmt-clear-hyperlinks", CoreCommands.CLEAR_HYPERLINKS],
        ["fmt-clear-removeHyperlinks", CoreCommands.REMOVE_HYPERLINKS],
      ];
      for (const [testId, command] of expected) {
        execute.mockClear();
        await openClear();
        click(byTestId(testId));
        expect(execute.mock.calls, testId).toStrictEqual([[command]]);
        expect(openMenu(), testId).toBeNull();
      }
    });
  });
}

describe("Remove Hyperlinks: greyed unless the selection holds a link", () => {
  const render = () => renderOn(SURFACES[0], <ClearMenuButton {...propsFor(item, true)} />);

  it("greyed with no link anywhere in the selection; Clear Hyperlinks stays live (Excel)", async () => {
    await render();
    await openClear();
    expect(isRowDisabled(byTestId("fmt-clear-removeHyperlinks"))).toBe(true);
    expect(isRowDisabled(byTestId("fmt-clear-hyperlinks"))).toBe(false);
  });

  it("live once the read finds a link", async () => {
    lib.getHyperlinksInRange.mockResolvedValue([{ row: 0, col: 0 }]);
    await render();
    await openClear();
    expect(isRowDisabled(byTestId("fmt-clear-removeHyperlinks"))).toBe(false);
  });

  it("reads WHEN THE MENU OPENS, not while it is closed", async () => {
    await render();
    expect(lib.getHyperlinksInRange).not.toHaveBeenCalled();
    expect(lib.getCommentIndicatorsInRange).not.toHaveBeenCalled();
    expect(lib.getNoteIndicatorsInRange).not.toHaveBeenCalled();
    await openClear();
    expect(lib.getHyperlinksInRange).toHaveBeenCalled();
  });

  it("asks about every Ctrl+click block, normalised, and a link in ANY of them counts", async () => {
    grid.state = {
      ...grid.state,
      selection: {
        // Drawn up and to the left: the backend gets top-left first.
        startRow: 4,
        startCol: 3,
        endRow: 2,
        endCol: 1,
        type: "cells",
        additionalRanges: [{ startRow: 10, startCol: 0, endRow: 10, endCol: 0 }],
      },
    };
    lib.getHyperlinksInRange.mockImplementation(async (r0: number) => (r0 === 10 ? [{ row: 10, col: 0 }] : []));
    await render();
    await openClear();
    const asked = lib.getHyperlinksInRange.mock.calls.map((c) => c.join(","));
    expect(asked.sort()).toEqual(["10,0,10,0", "2,1,4,3"]);
    expect(isRowDisabled(byTestId("fmt-clear-removeHyperlinks"))).toBe(false);
  });

  it("greyed while the read is still in flight, live when it says so", async () => {
    let answer: (links: unknown[]) => void = () => {};
    lib.getHyperlinksInRange.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await render();
    await openClear();
    expect(isRowDisabled(byTestId("fmt-clear-removeHyperlinks"))).toBe(true);
    answer([{ row: 0, col: 0 }]);
    await settle();
    expect(isRowDisabled(byTestId("fmt-clear-removeHyperlinks"))).toBe(false);
  });

  it("a FAILED read leaves it live: the command itself does nothing without a link, and a failure is not 'no link'", async () => {
    lib.getHyperlinksInRange.mockRejectedValue(new Error("ipc down"));
    await render();
    await openClear();
    expect(isRowDisabled(byTestId("fmt-clear-removeHyperlinks"))).toBe(false);
  });

  it("re-reads when the selection moves while the menu is open", async () => {
    await render();
    await openClear();
    expect(isRowDisabled(byTestId("fmt-clear-removeHyperlinks"))).toBe(true);
    lib.getHyperlinksInRange.mockResolvedValue([{ row: 7, col: 7 }]);
    grid.state = { ...grid.state, selection: { startRow: 7, startCol: 7, endRow: 7, endCol: 7, type: "cells" } };
    await render();
    await settle();
    expect(isRowDisabled(byTestId("fmt-clear-removeHyperlinks"))).toBe(false);
  });

  it("no cell selection (a canvas sheet): greyed, and nothing is asked", async () => {
    grid.state = { ...grid.state, selection: null, surface: "canvas" };
    await render();
    await openClear();
    expect(isRowDisabled(byTestId("fmt-clear-removeHyperlinks"))).toBe(true);
    expect(isRowDisabled(byTestId("fmt-clear-comments"))).toBe(true);
    expect(lib.getHyperlinksInRange).not.toHaveBeenCalled();
    expect(lib.getNoteIndicatorsInRange).not.toHaveBeenCalled();
  });
});

describe("Clear Comments and Notes: greyed unless the selection holds a note or a comment", () => {
  const render = () => renderOn(SURFACES[0], <ClearMenuButton {...propsFor(item, true)} />);

  it("greyed with neither", async () => {
    await render();
    await openClear();
    expect(isRowDisabled(byTestId("fmt-clear-comments"))).toBe(true);
  });

  it("live with a note only", async () => {
    lib.getNoteIndicatorsInRange.mockResolvedValue([{ row: 0, col: 0, visible: false }]);
    await render();
    await openClear();
    expect(isRowDisabled(byTestId("fmt-clear-comments"))).toBe(false);
  });

  it("live with a threaded comment only", async () => {
    lib.getCommentIndicatorsInRange.mockResolvedValue([{ row: 0, col: 0, resolved: false, replyCount: 0 }]);
    await render();
    await openClear();
    expect(isRowDisabled(byTestId("fmt-clear-comments"))).toBe(false);
  });

  it("live when a read fails", async () => {
    lib.getNoteIndicatorsInRange.mockRejectedValue(new Error("ipc down"));
    await render();
    await openClear();
    expect(isRowDisabled(byTestId("fmt-clear-comments"))).toBe(false);
  });

  it("the other four rows are never greyed by the reads", async () => {
    await render();
    await openClear();
    for (const id of ["fmt-clear-all", "fmt-clear-formats", "fmt-clear-contents", "fmt-clear-hyperlinks"]) {
      expect(isRowDisabled(byTestId(id)), id).toBe(false);
    }
  });
});

describe("refusals and shortcuts", () => {
  const render = () => renderOn(SURFACES[0], <ClearMenuButton {...propsFor(item, true)} />);

  it("a refusal reaches the user", async () => {
    execute.mockRejectedValueOnce(new Error("Cannot change part of a merged cell."));
    await render();
    await openClear();
    click(byTestId("fmt-clear-all"));
    await settle();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("Cannot change part of a merged cell.");
  });

  it("a clear that runs alerts nothing (positive control)", async () => {
    await render();
    await openClear();
    click(byTestId("fmt-clear-contents"));
    await settle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(dialogs.alertAsync).not.toHaveBeenCalled();
  });

  it("Clear Contents shows the live Delete binding; the others none", async () => {
    await render();
    await openClear();
    const chips = menuRows().map(rowShortcut);
    expect(chips[2]).toBeTruthy();
    expect(chips.filter((c, i) => i !== 2)).toEqual([null, null, null, null, null]);
  });
});
