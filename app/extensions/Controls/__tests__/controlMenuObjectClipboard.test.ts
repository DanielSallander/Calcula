//! FILENAME: app/extensions/Controls/__tests__/controlMenuObjectClipboard.test.ts
// PURPOSE: A control's right-click menu Copy and Duplicate do what their keys
//          do (the shortcuts the menu shows): on a CANVAS they act on the
//          WHOLE object selection through the object clipboard (W25 -- the
//          "Duplicate (Ctrl+D, menu)" door); on a worksheet on EVERY selected
//          control, not only the one right-clicked.
// CONTEXT: The menu called `duplicateControl(controlId)` / `copyControl(controlId)`
//          on the clicked control alone while Ctrl+D / Ctrl+C took the whole
//          selection, and on a canvas it could not copy the chart beside it.

import { describe, it, expect, beforeEach, vi } from "vitest";

let onCanvas = false;
const seam = {
  copySelectedObjects: vi.fn(async () => ({ acted: 0, unsupported: 0, failed: 0 })),
  duplicateSelectedObjects: vi.fn(async () => ({ acted: 0, unsupported: 0, failed: 0 })),
};
vi.mock("@api/objectClipboard", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  canvasOwnsObjectClipboard: () => onCanvas,
  copySelectedObjects: () => seam.copySelectedObjects(),
  duplicateSelectedObjects: () => seam.duplicateSelectedObjects(),
}));
const own = {
  copyControls: vi.fn(async (_ids: readonly string[]) => {}),
  duplicateControls: vi.fn(async (_ids: readonly string[]) => {}),
  pasteControl: vi.fn(async (_sheet: number) => {}),
};
vi.mock("../lib/controlClipboard", () => ({
  copyControls: (ids: readonly string[]) => own.copyControls(ids),
  duplicateControls: (ids: readonly string[]) => own.duplicateControls(ids),
  pasteControl: (sheet: number) => own.pasteControl(sheet),
  hasClipboardControl: () => true,
}));
vi.mock("@api/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitAppEvent: vi.fn(),
}));

import { buildControlObjectMenu } from "../lib/controlContextMenu";
import { addFloatingControl, resetFloatingStore } from "../lib/floatingStore";
import { deselectFloatingControl, selectFloatingControls } from "../Button/floatingSelection";

const BUTTON = "control-0-1-1";
const SHAPE = "control-0-3-3";

function run(controlId: string, itemId: string): void {
  const item = buildControlObjectMenu(controlId).find((i) => i.id === itemId);
  if (!item) throw new Error(`no ${itemId} item`);
  item.run();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  onCanvas = false;
  for (const f of [...Object.values(seam), ...Object.values(own)]) f.mockClear();
  resetFloatingStore();
  deselectFloatingControl();
  addFloatingControl({ id: BUTTON, sheetIndex: 0, row: 1, col: 1, x: 100, y: 50, width: 80, height: 24, controlType: "button" });
  addFloatingControl({ id: SHAPE, sheetIndex: 0, row: 3, col: 3, x: 300, y: 200, width: 120, height: 60, controlType: "shape" });
});

describe("on a worksheet the menu acts on every selected control", () => {
  it("Duplicate and Copy take the whole selection when it holds the clicked control", async () => {
    selectFloatingControls([BUTTON, SHAPE]);
    run(BUTTON, "controls.duplicate");
    run(BUTTON, "controls.copy");
    await settle();
    expect(own.duplicateControls, "the menu duplicated only the clicked control").toHaveBeenCalledWith([BUTTON, SHAPE]);
    expect(own.copyControls, "the menu copied only the clicked control").toHaveBeenCalledWith([BUTTON, SHAPE]);
    expect(seam.duplicateSelectedObjects).not.toHaveBeenCalled();
  });

  it("control: a clicked control that is NOT in the selection is acted on alone", async () => {
    selectFloatingControls([SHAPE]);
    run(BUTTON, "controls.duplicate");
    await settle();
    expect(own.duplicateControls).toHaveBeenCalledWith([BUTTON]);
  });
});

describe("on a CANVAS the menu acts on the whole object selection (every family)", () => {
  it("Duplicate and Copy go through the object clipboard, not Controls' own", async () => {
    onCanvas = true;
    selectFloatingControls([BUTTON]);
    run(BUTTON, "controls.duplicate");
    run(BUTTON, "controls.copy");
    await settle();
    expect(seam.duplicateSelectedObjects, "the menu Duplicate left the other families out").toHaveBeenCalledTimes(1);
    expect(seam.copySelectedObjects).toHaveBeenCalledTimes(1);
    expect(own.duplicateControls).not.toHaveBeenCalled();
    expect(own.copyControls).not.toHaveBeenCalled();
  });

  it("Paste pastes the object clipboard on the control's sheet", async () => {
    onCanvas = true;
    run(BUTTON, "controls.paste");
    await settle();
    expect(own.pasteControl).toHaveBeenCalledWith(0);
  });
});
