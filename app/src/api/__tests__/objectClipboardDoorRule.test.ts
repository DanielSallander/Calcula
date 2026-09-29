//! FILENAME: app/src/api/__tests__/objectClipboardDoorRule.test.ts
// PURPOSE: ONE rule, in @api/objectClipboard, says which command answers Copy
//          and Paste right now -- and the Edit menu, the Home tab and the
//          canvas's Ctrl+C / Ctrl+V guard all ask it.
// CONTEXT: Y11 (wave E; wave D shell fix-up "worth doing"). X12 gave the Edit
//          menu and the Home tab each a copy of the same rule
//          (StandardMenus/objectClipboardDoors.ts and
//          HomeTab/components/objectClipboardDoors.ts: the canvas owns the
//          object clipboard, no inner selection claims the clipboard keys, the
//          canvas's command is registered) plus a third spelling of the
//          canvas's command ids next to CanvasSheet's own. Three copies of a
//          rule drift on the first change. Behaviour of each door stays pinned
//          by its own test (editMenuObjectClipboard, homeTabObjectClipboard,
//          CanvasSheet canvasClipboard); this file pins the rule and that
//          nobody keeps a private copy of it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

const grid = vi.hoisted(() => ({ state: { surface: "grid" as "grid" | "canvas", selection: null as unknown } }));
vi.mock("../../core/state/GridContext", () => ({ getGridStateSnapshot: () => grid.state }));

import * as objectClipboard from "../objectClipboard";
import { CommandRegistry, CoreCommands } from "../commands";
import { registerObjectSelectionProvider, type ObjectSelectionKey } from "../objectSelection";

const APP = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP, rel), "utf8").replace(/\r\n/g, "\n");

type Rule = {
  clipboardDoorCommand?: (action: "copy" | "paste") => string;
  objectClipboardHasClipboardKeys?: () => boolean;
  OBJECT_COPY_COMMAND?: string;
  OBJECT_PASTE_COMMAND?: string;
};
const rule = objectClipboard as unknown as Rule;

const cleanups: (() => void)[] = [];

function registerCanvasCommands(): void {
  for (const id of [rule.OBJECT_COPY_COMMAND, rule.OBJECT_PASTE_COMMAND]) {
    if (!id) continue;
    CommandRegistry.register(id, () => {});
    cleanups.push(() => CommandRegistry.unregister(id));
  }
}

function innerSelectionOwnsClipboard(): void {
  cleanups.push(
    registerObjectSelectionProvider({
      types: ["test-inner-rule"],
      isSelected: () => true,
      select: () => {},
      deselectAll: () => {},
      ownsKey: (key: ObjectSelectionKey) => key === "Clipboard",
    }),
  );
}

beforeEach(() => {
  grid.state = { surface: "grid", selection: null };
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  vi.restoreAllMocks();
});

describe("@api/objectClipboard owns the Copy / Paste door rule", () => {
  it("exports the rule and the canvas's two command ids", () => {
    expect(typeof rule.clipboardDoorCommand, "no clipboardDoorCommand in @api/objectClipboard").toBe("function");
    expect(typeof rule.objectClipboardHasClipboardKeys).toBe("function");
    expect(rule.OBJECT_COPY_COMMAND).toBe("canvasSheet.copySelection");
    expect(rule.OBJECT_PASTE_COMMAND).toBe("canvasSheet.pasteObjects");
  });

  it("on a canvas with the canvas's commands registered: the object clipboard's commands", () => {
    grid.state = { surface: "canvas", selection: null };
    registerCanvasCommands();
    expect(rule.objectClipboardHasClipboardKeys!()).toBe(true);
    expect(rule.clipboardDoorCommand!("copy")).toBe(rule.OBJECT_COPY_COMMAND);
    expect(rule.clipboardDoorCommand!("paste")).toBe(rule.OBJECT_PASTE_COMMAND);
  });

  it("an INNER selection holding the clipboard keys keeps them: the cell clipboard", () => {
    grid.state = { surface: "canvas", selection: null };
    registerCanvasCommands();
    innerSelectionOwnsClipboard();
    expect(rule.objectClipboardHasClipboardKeys!()).toBe(false);
    expect(rule.clipboardDoorCommand!("copy")).toBe(CoreCommands.COPY);
    expect(rule.clipboardDoorCommand!("paste")).toBe(CoreCommands.PASTE);
  });

  it("the canvas's commands not registered (its extension off): the cell clipboard", () => {
    grid.state = { surface: "canvas", selection: null };
    expect(rule.clipboardDoorCommand!("copy")).toBe(CoreCommands.COPY);
    expect(rule.clipboardDoorCommand!("paste")).toBe(CoreCommands.PASTE);
  });

  it("a worksheet: the cell clipboard, whatever is registered (positive control)", () => {
    registerCanvasCommands();
    expect(rule.objectClipboardHasClipboardKeys!()).toBe(false);
    expect(rule.clipboardDoorCommand!("copy")).toBe(CoreCommands.COPY);
    expect(rule.clipboardDoorCommand!("paste")).toBe(CoreCommands.PASTE);
  });
});

describe("the doors ask the rule; nobody keeps a copy of it", () => {
  const EDIT_MENU = "extensions/BuiltIn/StandardMenus/objectClipboardDoors.ts";
  const HOME_TAB = "extensions/BuiltIn/HomeTab/components/useHomeTabState.ts";
  const CANVAS_GUARD = "extensions/CanvasSheet/lib/canvasClipboard.ts";

  it("the Edit menu and the Home tab run clipboardDoorCommand", () => {
    expect(read(EDIT_MENU)).toMatch(/clipboardDoorCommand\("copy"\)/);
    expect(read(EDIT_MENU)).toMatch(/clipboardDoorCommand\("paste"\)/);
    expect(read(HOME_TAB)).toMatch(/clipboardDoorCommand\("copy"\)/);
    expect(read(HOME_TAB)).toMatch(/clipboardDoorCommand\("paste"\)/);
  });

  it("the canvas's key guard asks objectClipboardHasClipboardKeys and registers under @api's ids", () => {
    const guard = read(CANVAS_GUARD);
    expect(guard).toMatch(/objectClipboardHasClipboardKeys\(\)/);
    expect(guard).toMatch(/OBJECT_COPY_COMMAND/);
    expect(guard).toMatch(/OBJECT_PASTE_COMMAND/);
  });

  it("the Home tab's private copy of the rule is gone", () => {
    expect(fs.existsSync(path.join(APP, "extensions/BuiltIn/HomeTab/components/objectClipboardDoors.ts"))).toBe(false);
  });

  it("no source outside @api/objectClipboard spells the rule or the canvas's Copy / Paste ids", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === "__tests__") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
          const rel = path.relative(APP, full).split(path.sep).join("/");
          if (rel === "src/api/objectClipboard.ts") continue;
          const src = fs.readFileSync(full, "utf8");
          if (/"canvasSheet\.(copySelection|pasteObjects)"/.test(src)) offenders.push(`${rel} (command id)`);
          if (/canvasOwnsObjectClipboard\(\)\s*&&[\s\S]{0,40}!objectOwnsKey\("Clipboard"\)/.test(src)) {
            offenders.push(`${rel} (the rule)`);
          }
        }
      }
    };
    walk(path.join(APP, "src"));
    walk(path.join(APP, "extensions"));
    expect(offenders).toEqual([]);
  });
});
