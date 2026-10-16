//! FILENAME: app/src/api/__tests__/objectClipboardWorksheetDoor.test.ts
// PURPOSE: The Copy / Paste DOORS (the Home tab's buttons, the Edit menu) do
//          what Ctrl+C / Ctrl+V do on a WORKSHEET with a floating control
//          selected: Controls' own Copy / Paste of the selected controls --
//          not the grid's cell Copy / Paste, which the "an object is selected"
//          claim refuses there.
// CONTEXT: Home tab = Excel's Home tab, clipboard lane (2026-10-04; survey
//          clipboard.md section 4). `clipboardDoorCommand` answered the
//          object clipboard's command on a CANVAS only; on a worksheet it
//          always answered CoreCommands.COPY / PASTE. With a shape selected on
//          a worksheet, Ctrl+C ran `ext.controls.copySelection` (Controls'
//          guarded binding, lib/controlKeys.ts) while the ribbon's Copy ran
//          the cell copy and was refused with "Copy is not available while an
//          object is selected".
//
//          The worksheet rule mirrors Controls' key guards exactly:
//            Ctrl+C -- a control is selected (worksheet, not a canvas);
//            Ctrl+V -- a control is selected AND the object clipboard holds
//                      something;
//          otherwise the cell command answers, as the key falls through to
//          the grid's built-in. A worksheet chart or slicer has no Copy of its
//          own there (Charts lib/chartMenuSelection.ts: "on a worksheet a
//          chart's Ctrl+C is still the grid's"), so the door does not hand it
//          one either. The canvas rule is unchanged (objectClipboardDoorRule).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

const grid = vi.hoisted(() => ({ state: { surface: "grid" as "grid" | "canvas", selection: null as unknown } }));
vi.mock("../../core/state/GridContext", () => ({ getGridStateSnapshot: () => grid.state }));

import {
  clipboardDoorCommand,
  OBJECT_COPY_COMMAND,
  OBJECT_PASTE_COMMAND,
  WORKSHEET_CONTROL_COPY_COMMAND,
  WORKSHEET_CONTROL_PASTE_COMMAND,
  putOnObjectClipboard,
  resetObjectClipboard,
} from "../objectClipboard";
import { CommandRegistry, CoreCommands } from "../commands";
import {
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  type ObjectSelectionKey,
} from "../objectSelection";
import { getGridRegions, setGridRegions, type GridRegion } from "../gridOverlays";

const APP = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP, rel), "utf8").replace(/\r\n/g, "\n");

/** The region type Controls publishes its floating controls under. */
const CONTROL_TYPE = "floating-control";

const cleanups: Array<() => void> = [];

function region(id: string, type: string): GridRegion {
  return { id, type, startRow: 0, startCol: 0, endRow: 0, endCol: 0, floating: { x: 10, y: 10, width: 80, height: 30 } };
}

/** A family double whose one object is published and selected. */
function selectedObjectOf(type: string, id: string): void {
  setGridRegions([...getGridRegions(), region(id, type)]);
  cleanups.push(
    registerObjectSelectionProvider({
      types: [type],
      isSelected: (r) => r.id === id,
      select: () => {},
      deselectAll: () => {},
    }),
  );
}

const ran: string[] = [];
function registerCommands(ids: string[]): void {
  for (const id of ids) {
    CommandRegistry.register(id, () => {
      ran.push(id);
    });
    cleanups.push(() => CommandRegistry.unregister(id));
  }
}

beforeEach(() => {
  grid.state = { surface: "grid", selection: null };
  vi.spyOn(console, "log").mockImplementation(() => {});
  setGridRegions([]);
  resetObjectClipboard();
  ran.length = 0;
});

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  resetObjectSelectionProviders();
  setGridRegions([]);
  resetObjectClipboard();
  vi.restoreAllMocks();
});

describe("a worksheet with a floating control selected", () => {
  beforeEach(() => {
    registerCommands([WORKSHEET_CONTROL_COPY_COMMAND, WORKSHEET_CONTROL_PASTE_COMMAND]);
    selectedObjectOf(CONTROL_TYPE, "fc-1");
  });

  it("Copy: Controls' copy of the selected controls (what Ctrl+C runs there)", () => {
    expect(clipboardDoorCommand("copy")).toBe(WORKSHEET_CONTROL_COPY_COMMAND);
  });

  it("the door's command, executed, is Controls' copy", async () => {
    await CommandRegistry.execute(clipboardDoorCommand("copy"));
    expect(ran).toEqual([WORKSHEET_CONTROL_COPY_COMMAND]);
  });

  it("Paste with something on the object clipboard: Controls' paste (what Ctrl+V runs there)", () => {
    putOnObjectClipboard(CONTROL_TYPE, [{ copied: true }]);
    expect(clipboardDoorCommand("paste")).toBe(WORKSHEET_CONTROL_PASTE_COMMAND);
  });

  it("Paste with the object clipboard EMPTY: the cell paste (Ctrl+V falls through to the grid there too)", () => {
    expect(clipboardDoorCommand("paste")).toBe(CoreCommands.PASTE);
  });

  it("an INNER selection holding the clipboard keys keeps them: the cell commands", () => {
    cleanups.push(
      registerObjectSelectionProvider({
        types: ["test-inner"],
        isSelected: () => false,
        select: () => {},
        deselectAll: () => {},
        ownsKey: (key: ObjectSelectionKey) => key === "Clipboard",
      }),
    );
    putOnObjectClipboard(CONTROL_TYPE, [{ copied: true }]);
    expect(clipboardDoorCommand("copy")).toBe(CoreCommands.COPY);
    expect(clipboardDoorCommand("paste")).toBe(CoreCommands.PASTE);
  });

  it("an INNER selection that names its own Copy / Paste (innerClipboardCommand) wins over Controls' door", () => {
    registerCommands(["test.inner.copy", "test.inner.paste"]);
    cleanups.push(
      registerObjectSelectionProvider({
        types: ["test-inner-named"],
        isSelected: () => false,
        select: () => {},
        deselectAll: () => {},
        ownsKey: (key: ObjectSelectionKey) => key === "Clipboard",
        innerClipboardCommand: (action) => (action === "copy" ? "test.inner.copy" : "test.inner.paste"),
      }),
    );
    putOnObjectClipboard(CONTROL_TYPE, [{ copied: true }]);
    expect(clipboardDoorCommand("copy")).toBe("test.inner.copy");
    expect(clipboardDoorCommand("paste")).toBe("test.inner.paste");
  });
});

describe("the worksheet branch stands aside", () => {
  it("Controls' commands not registered (its extension off): the cell commands", () => {
    selectedObjectOf(CONTROL_TYPE, "fc-1");
    putOnObjectClipboard(CONTROL_TYPE, [{ copied: true }]);
    expect(clipboardDoorCommand("copy")).toBe(CoreCommands.COPY);
    expect(clipboardDoorCommand("paste")).toBe(CoreCommands.PASTE);
  });

  it("a worksheet CHART selected (no control): the cell commands -- a worksheet chart's Ctrl+C is the grid's", () => {
    registerCommands([WORKSHEET_CONTROL_COPY_COMMAND, WORKSHEET_CONTROL_PASTE_COMMAND]);
    selectedObjectOf("chart", "chart-1");
    putOnObjectClipboard("chart", [{ copied: true }]);
    expect(clipboardDoorCommand("copy")).toBe(CoreCommands.COPY);
    expect(clipboardDoorCommand("paste")).toBe(CoreCommands.PASTE);
  });

  it("nothing selected: the cell commands (positive control)", () => {
    registerCommands([WORKSHEET_CONTROL_COPY_COMMAND, WORKSHEET_CONTROL_PASTE_COMMAND]);
    putOnObjectClipboard(CONTROL_TYPE, [{ copied: true }]);
    expect(clipboardDoorCommand("copy")).toBe(CoreCommands.COPY);
    expect(clipboardDoorCommand("paste")).toBe(CoreCommands.PASTE);
  });

  it("a CANVAS keeps the canvas rule: the object clipboard's commands, even with a control selected", () => {
    grid.state = { surface: "canvas", selection: null };
    registerCommands([
      WORKSHEET_CONTROL_COPY_COMMAND,
      WORKSHEET_CONTROL_PASTE_COMMAND,
      OBJECT_COPY_COMMAND,
      OBJECT_PASTE_COMMAND,
    ]);
    selectedObjectOf(CONTROL_TYPE, "fc-1");
    putOnObjectClipboard(CONTROL_TYPE, [{ copied: true }]);
    expect(clipboardDoorCommand("copy")).toBe(OBJECT_COPY_COMMAND);
    expect(clipboardDoorCommand("paste")).toBe(OBJECT_PASTE_COMMAND);
  });
});

describe("@api spells Controls' ids the way Controls registers them (drift guard)", () => {
  // @api cannot import an extension (seams point one way). The command ids
  // are therefore spelled ONCE, here in @api, and Controls registers its two
  // commands under @api's constants (as CanvasSheet does for the canvas's
  // ids): a rename in @api moves both doors together, and a Controls that
  // spelled its own literal again would fail here, not as a ribbon Copy that
  // silently falls back to the refused cell copy. The region type is still
  // spelled twice (it is a private constant of @api) and pinned below.
  it("the copy and paste command ids ARE @api's constants (imported, never re-spelled)", async () => {
    const keys = read("extensions/Controls/lib/controlKeys.ts");
    const imports = /import\s*\{([^}]*)\}\s*from\s*"@api\/objectClipboard";/.exec(keys);
    expect(imports, "controlKeys.ts imports nothing from @api/objectClipboard").not.toBeNull();
    expect(imports![1]).toMatch(/\bWORKSHEET_CONTROL_COPY_COMMAND\b/);
    expect(imports![1]).toMatch(/\bWORKSHEET_CONTROL_PASTE_COMMAND\b/);
    expect(keys).toMatch(/CONTROLS_COPY_COMMAND = WORKSHEET_CONTROL_COPY_COMMAND;/);
    expect(keys).toMatch(/CONTROLS_PASTE_COMMAND = WORKSHEET_CONTROL_PASTE_COMMAND;/);
    // No second spelling of either id anywhere in the file's code.
    const code = keys.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/CONTROLS_(COPY|PASTE)_COMMAND\s*=\s*"/);
    // And at run time the values Controls registers under are @api's.
    const controls = await import("../../../extensions/Controls/lib/controlKeys");
    expect(controls.CONTROLS_COPY_COMMAND).toBe(WORKSHEET_CONTROL_COPY_COMMAND);
    expect(controls.CONTROLS_PASTE_COMMAND).toBe(WORKSHEET_CONTROL_PASTE_COMMAND);
  });

  it("the floating control's region type", () => {
    expect(read("extensions/Controls/lib/controlHitTest.ts")).toContain(
      `FLOATING_CONTROL_REGION_TYPE = "${CONTROL_TYPE}"`,
    );
    expect(read("src/api/objectClipboard.ts")).toContain(`"${CONTROL_TYPE}"`);
  });

  it("Controls' worksheet key guards are the rule the door mirrors", () => {
    const keys = read("extensions/Controls/lib/controlKeys.ts");
    // Ctrl+V applies only when the object clipboard holds something.
    expect(keys).toMatch(/"Ctrl\+V", CONTROLS_PASTE_COMMAND[\s\S]{0,120}worksheetKey\(\) && deps\.hasClipboard\(\)/);
    // A worksheet key: a control selected, not a canvas.
    expect(keys).toMatch(/worksheetKey = \(\): boolean => selectedAndFocused\(\) && !canvasOwnsObjectClipboard\(\)/);
  });
});
