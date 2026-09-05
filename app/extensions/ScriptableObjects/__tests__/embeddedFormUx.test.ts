//! FILENAME: app/extensions/ScriptableObjects/__tests__/embeddedFormUx.test.ts
// PURPOSE: The USER's half of M3c: that a form CAN be placed on a sheet, that
//          the placement is a distinct instance of the chosen script, that
//          removing it is the user's alone, and that an orphan has a way back.
// CONTEXT: The grid context-menu registry is doubled (`gridExtensions` is the
//          `@api` seam this file registers through), so the items are inspected
//          exactly as the Shell would read them at menu-open time — `visible`
//          and `onClick` are called with a `GridMenuContext`, never assumed.
//
//          WHY THIS FILE EXISTS AT ALL: nothing on the worker's surface can
//          create a placement, deliberately (scriptPanes.ts's header). Without
//          these gestures the whole feature is unreachable, and a test that only
//          exercised the registry would not notice.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  items: new Map<string, Record<string, unknown>>(),
  toasts: [] as string[],
}));

// THE SCRIPT REGISTRY IS REAL HERE, not a double. The submenu's whole
// correctness question is "does this item still hear the registry after the
// workbook is swapped?", and a doubled `onScriptChange` answers yes whatever the
// real one does — which is exactly how a `changeListeners.clear()` inside
// `resetObjectScriptManager` stayed invisible to this suite while the shipped
// menu offered the CLOSED workbook's forms for the rest of the session. Only the
// grid menu registry and the toast surface are doubled, because those are what
// the test needs to READ.
vi.mock("@api", async () => {
  const real = await vi.importActual<typeof import("@api/scriptableObjects")>(
    "@api/scriptableObjects",
  );
  return {
    ObjectScriptManager: real.ObjectScriptManager,
    gridExtensions: {
      registerContextMenuItem: (item: Record<string, unknown>) => {
        hoisted.items.set(item.id as string, item);
      },
      registerContextMenuItems: (items: Array<Record<string, unknown>>) => {
        for (const item of items) hoisted.items.set(item.id as string, item);
      },
      unregisterContextMenuItem: (id: string) => {
        hoisted.items.delete(id);
      },
    },
    onAppEvent: () => () => undefined,
    showToast: (message: string) => hoisted.toasts.push(message),
  };
});
vi.mock("@api/lib", () => ({
  getActiveSheet: async () => 0,
}));

import {
  ObjectScriptManager,
  resetObjectScriptManager,
  type ObjectScriptDefinition,
  type ScriptableObjectType,
} from "@api/scriptableObjects";
import {
  EMBEDDED_FORM_MENU_IDS,
  __setEmbeddedFormUxActiveSheetForTests,
  registerEmbeddedFormUx,
} from "../lib/embeddedFormUx";
import {
  EMBEDDED_FORM_ORPHAN_REMEDY,
  MAX_EMBEDDED_FORMS_PER_SHEET,
  __resetEmbeddedFormPlacementsForTests,
  getEmbeddedFormPlacement,
  listEmbeddedFormPlacements,
  placeEmbeddedForm,
  shiftEmbeddedFormPlacements,
  structuralAnchorShift,
} from "@api/scriptHost/embeddedFormPlacements";

interface MenuItem {
  id: string;
  label: string;
  visible?: (ctx: unknown) => boolean;
  onClick: (ctx: unknown) => void;
  children?: MenuItem[];
}

const ctxAt = (row: number, col: number): unknown => ({
  clickedCell: { row, col },
  selection: null,
  isWithinSelection: false,
  sheetIndex: 0,
});

function item(id: string): MenuItem {
  const found = hoisted.items.get(id);
  if (!found) throw new Error(`no context-menu item "${id}" is registered`);
  return found as unknown as MenuItem;
}

/** A registrable script definition — the registry is real, so this must be too. */
function script(id: string, name: string, objectType: ScriptableObjectType): ObjectScriptDefinition {
  return { id, name, objectType, instanceId: null, source: "", accessLevel: "restricted" };
}

let retried: string[] = [];
let stop: () => void;

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeEach(() => {
  hoisted.items.clear();
  hoisted.toasts.length = 0;
  resetObjectScriptManager();
  for (const s of [
    script("form-a", "Order entry", "form"),
    script("form-b", "Approvals", "form"),
    script("shape-1", "A shape", "shape"),
  ]) {
    ObjectScriptManager.registerScript(s);
  }
  __resetEmbeddedFormPlacementsForTests();
  __setEmbeddedFormUxActiveSheetForTests(0);
  retried = [];
  stop = registerEmbeddedFormUx((id) => retried.push(id));
});

afterEach(() => {
  // The subscriber goes first: it belongs to this registration, and nothing
  // after it should be able to reach a rebuild.
  stop?.();
  resetObjectScriptManager();
  __resetEmbeddedFormPlacementsForTests();
});

describe("placing a form on a sheet", () => {
  it("offers the workbook's FORM scripts, by name, and nothing else", () => {
    const place = item(EMBEDDED_FORM_MENU_IDS.place);
    expect(place.visible?.(ctxAt(3, 3))).toBe(true);
    expect(place.children?.map((c) => c.label)).toEqual(["Approvals", "Order entry"]);
  });

  it("places the chosen script at the clicked cell, with a minted id", async () => {
    const place = item(EMBEDDED_FORM_MENU_IDS.place);
    place.children!.find((c) => c.label === "Order entry")!.onClick(ctxAt(4, 2));
    await flush();
    const [p] = listEmbeddedFormPlacements();
    expect(p).toMatchObject({ scriptId: "form-a", sheetIndex: 0, anchorRow: 4, anchorCol: 2, orphaned: false });
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("places the SAME form twice as two instances, which is the identity model's whole point", async () => {
    const place = item(EMBEDDED_FORM_MENU_IDS.place);
    const chosen = place.children!.find((c) => c.label === "Order entry")!;
    chosen.onClick(ctxAt(4, 2));
    await flush();
    chosen.onClick(ctxAt(9, 2));
    await flush();
    const all = listEmbeddedFormPlacements();
    expect(all).toHaveLength(2);
    expect(new Set(all.map((p) => p.scriptId))).toEqual(new Set(["form-a"]));
    expect(all[0].id).not.toBe(all[1].id);
  });

  it("is hidden where a form is already anchored — that cell offers Remove instead", () => {
    placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 0, anchorRow: 4, anchorCol: 2 });
    expect(item(EMBEDDED_FORM_MENU_IDS.place).visible?.(ctxAt(4, 2))).toBe(false);
    expect(item(EMBEDDED_FORM_MENU_IDS.remove).visible?.(ctxAt(4, 2))).toBe(true);
    expect(item(EMBEDDED_FORM_MENU_IDS.remove).visible?.(ctxAt(5, 2))).toBe(false);
  });

  it("is hidden altogether when the workbook has no form script", () => {
    ObjectScriptManager.removeScript("form-a");
    ObjectScriptManager.removeScript("form-b");
    expect(item(EMBEDDED_FORM_MENU_IDS.place).visible?.(ctxAt(1, 1))).toBe(false);
    expect(item(EMBEDDED_FORM_MENU_IDS.place).children).toEqual([]);
  });

  it("rebuilds the submenu when the script list changes — `children` is a frozen array", () => {
    ObjectScriptManager.registerScript(script("form-c", "Zeta", "form"));
    expect(item(EMBEDDED_FORM_MENU_IDS.place).children?.map((c) => c.label)).toEqual([
      "Approvals",
      "Order entry",
      "Zeta",
    ]);
  });

  // THE WORKBOOK SWAP (File ▸ Open / File ▸ New). The extension's AFTER_OPEN
  // handler calls `resetObjectScriptManager()` and then reloads the incoming
  // workbook's scripts; this item subscribes ONCE at activation and an extension
  // is not re-activated for a document. When the reset unsubscribed everyone,
  // the menu kept offering workbook A's forms inside workbook B, and placing one
  // minted a placement naming a script that is not in this file — a surface
  // whose only advice ("Start it from Code in This File") the user cannot take.
  it("offers the NEW workbook's forms after a workbook swap, and none of the old one's", async () => {
    resetObjectScriptManager();
    // The swap itself is heard: nothing of workbook A survives into the menu,
    // not even while the incoming workbook has registered nothing yet.
    expect(item(EMBEDDED_FORM_MENU_IDS.place).children).toEqual([]);
    expect(item(EMBEDDED_FORM_MENU_IDS.place).visible?.(ctxAt(1, 1))).toBe(false);

    ObjectScriptManager.registerScript(script("form-z", "Timesheet", "form"));
    const place = item(EMBEDDED_FORM_MENU_IDS.place);
    expect(place.children?.map((c) => c.label)).toEqual(["Timesheet"]);
    expect(place.visible?.(ctxAt(1, 1))).toBe(true);

    // ...and placing one names THIS workbook's script, not the closed one's.
    place.children![0].onClick(ctxAt(2, 2));
    await flush();
    expect(listEmbeddedFormPlacements().map((p) => p.scriptId)).toEqual(["form-z"]);
  });

  it("says so in a toast when the sheet's bound refuses the placement", async () => {
    for (let i = 0; i < MAX_EMBEDDED_FORMS_PER_SHEET; i++) {
      placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 0, anchorRow: i, anchorCol: 0 });
    }
    item(EMBEDDED_FORM_MENU_IDS.place).children![0].onClick(ctxAt(99, 9));
    await flush();
    expect(hoisted.toasts.join(" ")).toMatch(/already holds \d+ embedded forms/);
    expect(listEmbeddedFormPlacements()).toHaveLength(MAX_EMBEDDED_FORMS_PER_SHEET);
  });
});

describe("removing a form is the USER's, and only the user's", () => {
  it("drops the placement and leaves the script alone", () => {
    const p = placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 0, anchorRow: 4, anchorCol: 2 });
    item(EMBEDDED_FORM_MENU_IDS.remove).onClick(ctxAt(4, 2));
    expect(getEmbeddedFormPlacement(p.id)).toBeNull();
    // The script is untouched: removing a surface is not deleting code.
    expect(ObjectScriptManager.getAllScripts().some((s) => s.id === "form-a")).toBe(true);
  });
});

describe("an orphan has a way back", () => {
  it("offers 'Put This Form Back Here' only on an orphan, re-anchors it and asks for a retry", () => {
    const p = placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 0, anchorRow: 5, anchorCol: 2 });
    // Not while it is live.
    expect(item(EMBEDDED_FORM_MENU_IDS.restore).visible?.(ctxAt(5, 2))).toBe(false);

    shiftEmbeddedFormPlacements(0, structuralAnchorShift("rowDelete", 5, 1));
    expect(getEmbeddedFormPlacement(p.id)!.orphaned).toBe(true);
    expect(item(EMBEDDED_FORM_MENU_IDS.restore).visible?.(ctxAt(5, 2))).toBe(true);

    // "Here" is the cell the user right-clicked, and the item is offered only on
    // the orphan's own anchor — the coordinates its surface still paints at,
    // which now hold whichever row moved up into them. Re-anchoring there is
    // what un-orphans it.
    item(EMBEDDED_FORM_MENU_IDS.restore).onClick(ctxAt(5, 2));
    const back = getEmbeddedFormPlacement(p.id)!;
    expect(back).toMatchObject({ anchorRow: 5, anchorCol: 2, orphaned: false });
    // The identity survived the whole round trip: deleted anchor, orphan,
    // re-place. The same id is what the retry names.
    expect(back.id).toBe(p.id);
    expect(retried).toEqual([p.id]);
  });
});

// ----------------------------------------------------------------------------
// THE SENTENCE AND THE GESTURE, PINNED TO EACH OTHER
//
// Every surface that reports an orphan — the card the layer paints, the inert
// sentence in lib/scriptEmbedHost.ts, and the host's own refusal in
// `openEmbeddedScriptForm` — used to say "drag it onto a cell to put it back,
// or delete it". NOTHING IMPLEMENTS THAT DRAG: `setEmbeddedFormGeometry` has
// exactly one production caller, the restore item in lib/embeddedFormUx.ts, and
// Core's move path returns early on a region with no `floating` box, which an
// embedded form (cell-anchored) never has. So the user dragged the box, got an
// ordinary range selection, and the ONE action that works sat in the context
// menu under their cursor, named nowhere.
//
// The labels are read OUT of the sentence rather than restated here: a test
// that hard-coded the words would stay green against a sentence that had
// drifted away from the menu, which is precisely the drift being pinned.
// ----------------------------------------------------------------------------

describe("the orphan's remedy names a gesture that exists", () => {
  const quotedLabels = (sentence: string): string[] =>
    [...sentence.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  it("quotes menu items that are REGISTERED and offered on the orphan's own anchor cell", () => {
    const p = placeEmbeddedForm({ scriptId: "form-a", sheetIndex: 0, anchorRow: 5, anchorCol: 2 });
    // Somebody deletes row 5 — the failure scenario exactly.
    shiftEmbeddedFormPlacements(0, structuralAnchorShift("rowDelete", 5, 1));
    expect(getEmbeddedFormPlacement(p.id)!.orphaned).toBe(true);

    const labels = quotedLabels(EMBEDDED_FORM_ORPHAN_REMEDY);
    expect(labels.length, "the remedy must name its items by their menu labels").toBe(2);

    // The orphan still paints at its old anchor, so that cell is where the user
    // is looking and where they will right-click.
    const offered = [...hoisted.items.values()]
      .map((i) => i as unknown as MenuItem)
      .filter((i) => i.visible?.(ctxAt(5, 2)) === true)
      .map((i) => i.label);
    for (const label of labels) {
      expect(offered, `"${label}" is promised to the user but not offered on the orphan's anchor`).toContain(label);
    }
  });

  it("promises no drag, because an embedded form cannot be dragged", () => {
    expect(EMBEDDED_FORM_ORPHAN_REMEDY).not.toMatch(/drag/i);
  });
});
