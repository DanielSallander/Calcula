//! FILENAME: app/src/core/lib/__tests__/gridCommandBridgeArgs.test.ts
// PURPOSE: The grid-command bridge CARRIES ARGUMENTS, and the Home tab's new
//          grid commands (AutoFit Row Height / Column Width, Remove Hyperlinks)
//          are bridged, script-safe and named as Excel names them.
// CONTEXT: (Home tab = Excel's Home tab, 2026-10-04.) `CommandRegistry.execute
//          (id, args)` dropped `args` on the way to `gridCommands.execute`, so
//          a grid command could take no options at all -- and the Orientation
//          menu runs `AUTOFIT_ROW_HEIGHT { growOnly: true }` after rotating text
//          (CONTRACT section 10). A dropped `growOnly` would be a FULL fit:
//          shrinking rows the user sized by hand.

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../dialogs", () => ({ alertAsync: vi.fn(async () => undefined) }));

import { gridCommands, GRID_COMMANDS } from "../gridCommands";
import { registerSelectionOwner, setSelectionRefusalAnnouncer } from "../selectionOwner";
import { CommandRegistry, CoreCommands } from "../../../api/commands";

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  setSelectionRefusalAnnouncer(null);
  gridCommands.clear();
});

describe("the bridge forwards args", () => {
  it("CommandRegistry.execute(id, args) hands args to the grid command's handler", async () => {
    const handler = vi.fn();
    gridCommands.register("autoFitRowHeight", handler);
    await CommandRegistry.execute(CoreCommands.AUTOFIT_ROW_HEIGHT, { growOnly: true });
    // The second argument is the target the door resolved (P3): the grid here.
    expect(handler).toHaveBeenCalledWith({ growOnly: true }, { target: { kind: "grid", selection: null } });
  });

  it("no args stays no args (every existing door: menus, keys, the right-click menu)", async () => {
    const handler = vi.fn();
    gridCommands.register("autoFitColumnWidth", handler);
    await CommandRegistry.execute(CoreCommands.AUTOFIT_COLUMN_WIDTH);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toBeUndefined();
  });

  it("gridCommands.execute(name, args) forwards too", async () => {
    const handler = vi.fn();
    gridCommands.register("autoFitColumnWidth", handler);
    await expect(gridCommands.execute("autoFitColumnWidth", { growOnly: true })).resolves.toBe(true);
    // The second argument is the target the door resolved (P3): the grid here.
    expect(handler).toHaveBeenCalledWith({ growOnly: true }, { target: { kind: "grid", selection: null } });
  });
});

describe("the Home tab's new grid commands", () => {
  const NEW = [
    [CoreCommands.AUTOFIT_ROW_HEIGHT, "autoFitRowHeight"],
    [CoreCommands.AUTOFIT_COLUMN_WIDTH, "autoFitColumnWidth"],
    [CoreCommands.REMOVE_HYPERLINKS, "removeHyperlinks"],
  ] as const;

  it.each(NEW)("%s is bridged to the grid command %s", async (id, grid) => {
    expect(GRID_COMMANDS).toContain(grid);
    expect(CommandRegistry.has(id), "nothing registered yet").toBe(false);
    const handler = vi.fn();
    gridCommands.register(grid, handler);
    expect(CommandRegistry.has(id)).toBe(true);
    await CommandRegistry.execute(id);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("Remove Hyperlinks is script-safe (its reach is Clear Formats + Clear Hyperlinks')", () => {
    expect(CommandRegistry.isScriptSafe(CoreCommands.REMOVE_HYPERLINKS)).toBe(true);
  });

  // Review finding (e), 2026-10-04: a FULL fit unhides the user-hidden rows /
  // columns inside the selection (Excel's AutoFit does). The script doors
  // (`ext.executeCommand` -- restricted tier, no capability, no consent -- and
  // an object script's executeCommand) are gated by isScriptSafe ALONE, while
  // un-hiding is the UNLOCKED API's setRowsHidden reach. Script-safe, a
  // sandboxed add-in with no capability could bring back, over Select All,
  // rows the user hid to keep working data out of a distributed report.
  it.each([CoreCommands.AUTOFIT_ROW_HEIGHT, CoreCommands.AUTOFIT_COLUMN_WIDTH])(
    "%s is NOT script-safe: no restricted script door may un-hide the user's rows / columns",
    (id) => {
      expect(CommandRegistry.isScriptSafe(id)).toBe(false);
    },
  );

  it("control: the clipboard group is still not script-safe", () => {
    expect(CommandRegistry.isScriptSafe(CoreCommands.PASTE)).toBe(false);
  });

  it("a refusal names them as Excel does", async () => {
    const announced: string[] = [];
    setSelectionRefusalAnnouncer((m) => announced.push(m));
    cleanups.push(registerSelectionOwner({ id: "test", label: "the test object's cells", ownsSelection: () => true }));
    for (const [, grid] of NEW) gridCommands.register(grid, vi.fn());
    gridCommands.register("clearComments", vi.fn());
    await gridCommands.execute("autoFitRowHeight");
    await gridCommands.execute("autoFitColumnWidth");
    await gridCommands.execute("removeHyperlinks");
    await gridCommands.execute("clearComments");
    expect(announced[0]).toContain("AutoFit Row Height");
    expect(announced[1]).toContain("AutoFit Column Width");
    expect(announced[2]).toContain("Remove Hyperlinks");
    expect(announced[3]).toContain("Clear Comments and Notes");
  });
});
