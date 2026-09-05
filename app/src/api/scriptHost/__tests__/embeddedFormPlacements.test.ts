//! FILENAME: app/src/api/scriptHost/__tests__/embeddedFormPlacements.test.ts
// PURPOSE: The IDENTITY model for a form embedded on a sheet (M3c part 1), and
//          the three things an anchor-derived id got wrong.
// CONTEXT: Every on-grid object before this one carried its position IN its id
//          (`control-{sheet}-{row}-{col}`, floatingStore.ts). These tests are
//          the inverse of that, one per consequence:
//            - a COPY keeps the SCRIPT and takes a NEW id;
//            - a STRUCTURAL EDIT moves the geometry and leaves the id alone;
//            - DELETING THE ANCHOR orphans the record instead of dropping it.
//          They are written against the store, not the renderer, because the
//          claim is about what the workbook holds — a surface can be repainted,
//          but an identity that was lost is lost.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  EMBEDDED_FORM_PLACEMENTS_CHANGED_EVENT,
  MAX_EMBEDDED_FORMS_PER_SHEET,
  MIN_EMBEDDED_FORM_HEIGHT,
  MIN_EMBEDDED_FORM_WIDTH,
  __resetEmbeddedFormPlacementsForTests,
  __setEmbeddedFormIdMinterForTests,
  copyEmbeddedForm,
  getEmbeddedFormPlacement,
  listEmbeddedFormPlacements,
  listEmbeddedFormPlacementsForScript,
  listEmbeddedFormPlacementsForSheet,
  orphanEmbeddedFormsForSheet,
  placeEmbeddedForm,
  removeEmbeddedFormPlacement,
  resetEmbeddedFormPlacements,
  setEmbeddedFormGeometry,
  shiftEmbeddedFormPlacements,
  structuralAnchorShift,
} from "../embeddedFormPlacements";

const SCRIPT = "form-script-1";

function place(overrides: Partial<Parameters<typeof placeEmbeddedForm>[0]> = {}) {
  return placeEmbeddedForm({
    scriptId: SCRIPT,
    sheetIndex: 0,
    anchorRow: 5,
    anchorCol: 2,
    width: 320,
    height: 240,
    ...overrides,
  });
}

beforeEach(() => {
  __resetEmbeddedFormPlacementsForTests();
});

afterEach(() => {
  __resetEmbeddedFormPlacementsForTests();
});

describe("identity is minted, never derived from the anchor", () => {
  it("mints a fresh id per placement, and two forms of ONE script at one anchor are two records", () => {
    const a = place();
    const b = place();
    // Same script, same sheet, same cell — and still two identities. That is
    // exactly what `control-{sheet}-{row}-{col}` cannot express: under the old
    // rule these two WOULD have been one object.
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(listEmbeddedFormPlacements().map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("bounds the box rather than trusting the caller's numbers", () => {
    const tiny = place({ width: 1, height: 1 });
    expect(tiny.width).toBe(MIN_EMBEDDED_FORM_WIDTH);
    expect(tiny.height).toBe(MIN_EMBEDDED_FORM_HEIGHT);
    const silly = place({ width: Number.POSITIVE_INFINITY, height: Number.NaN });
    expect(Number.isFinite(silly.width)).toBe(true);
    expect(Number.isFinite(silly.height)).toBe(true);
  });

  it("refuses past the per-sheet bound by name, and the bound is per SHEET", () => {
    for (let i = 0; i < MAX_EMBEDDED_FORMS_PER_SHEET; i++) place({ anchorRow: i });
    expect(() => place({ anchorRow: 99 })).toThrow(/already holds \d+ embedded forms/);
    // Another sheet has its own budget.
    expect(() => place({ sheetIndex: 1 })).not.toThrow();
    expect(listEmbeddedFormPlacementsForSheet(1)).toHaveLength(1);
  });
});

describe("a COPY is a distinct instance of the SAME script", () => {
  it("takes a new id, keeps the scriptId and the size, and lands on the paste anchor", () => {
    const source = place({ width: 400, height: 300, offsetX: 7, offsetY: 3 });
    const copy = copyEmbeddedForm(source.id, { sheetIndex: 1, anchorRow: 20, anchorCol: 4 });
    expect(copy).not.toBeNull();

    // THE DEFECT THIS CLOSES: with an anchor-derived id the copy's identity was
    // decided by where it landed, so the script bound to the ORIGINAL id was not
    // bound to the copy at all — it pasted, painted nothing, and said nothing.
    expect(copy!.scriptId).toBe(source.scriptId);
    expect(copy!.id).not.toBe(source.id);

    expect(copy!.sheetIndex).toBe(1);
    expect(copy!.anchorRow).toBe(20);
    expect(copy!.anchorCol).toBe(4);
    expect(copy!.width).toBe(400);
    expect(copy!.height).toBe(300);
    expect(copy!.offsetX).toBe(7);
    expect(copy!.offsetY).toBe(3);

    // Both instances exist, both run the same script.
    const forScript = listEmbeddedFormPlacementsForScript(SCRIPT);
    expect(forScript).toHaveLength(2);
    expect(new Set(forScript.map((p) => p.scriptId))).toEqual(new Set([SCRIPT]));

    // The ORIGINAL is untouched — a copy is not a move.
    expect(getEmbeddedFormPlacement(source.id)).toMatchObject({ anchorRow: 5, anchorCol: 2, sheetIndex: 0 });
  });

  it("copies an ORPHAN as a live placement — the copy is anchored to a cell that exists", () => {
    const source = place();
    shiftEmbeddedFormPlacements(0, () => null);
    expect(getEmbeddedFormPlacement(source.id)!.orphaned).toBe(true);
    const copy = copyEmbeddedForm(source.id, { sheetIndex: 0, anchorRow: 1, anchorCol: 1 });
    expect(copy!.orphaned).toBe(false);
  });

  it("copying an id that is not there is null, never a placement of nothing", () => {
    expect(copyEmbeddedForm("no-such-id", { sheetIndex: 0, anchorRow: 0, anchorCol: 0 })).toBeNull();
    expect(listEmbeddedFormPlacements()).toEqual([]);
  });
});

describe("a structural edit shifts the GEOMETRY and re-points nothing", () => {
  it("moves the anchor of a placement below an inserted row, id unchanged", () => {
    const p = place({ anchorRow: 5, anchorCol: 2 });
    const changed = shiftEmbeddedFormPlacements(0, structuralAnchorShift("rowInsert", 3, 2));
    expect(changed).toBe(true);
    // THE IDENTITY IS THE SAME OBJECT. With an anchor-derived id this edit was a
    // RENAME, and every id-keyed consumer had to be told (`onRename`) — so the
    // first thing that must still be true is that the id the caller was given
    // still FINDS the placement.
    expect(
      getEmbeddedFormPlacement(p.id),
      "the id handed out at placement must still find the record after a structural edit",
    ).not.toBeNull();
    const after = getEmbeddedFormPlacement(p.id)!;
    expect(after.id).toBe(p.id);
    expect(after.scriptId).toBe(p.scriptId);
    expect(after.anchorRow).toBe(7);
    expect(after.anchorCol).toBe(2);
    expect(after.orphaned).toBe(false);
  });

  it("leaves a placement ABOVE the edit alone, and reports that nothing changed", () => {
    const p = place({ anchorRow: 1 });
    expect(shiftEmbeddedFormPlacements(0, structuralAnchorShift("rowInsert", 9, 3))).toBe(false);
    expect(getEmbeddedFormPlacement(p.id)!.anchorRow).toBe(1);
  });

  it("only touches the sheet named", () => {
    const here = place({ sheetIndex: 0, anchorRow: 5 });
    const elsewhere = place({ sheetIndex: 1, anchorRow: 5 });
    shiftEmbeddedFormPlacements(0, structuralAnchorShift("rowInsert", 0, 4));
    expect(getEmbeddedFormPlacement(here.id)!.anchorRow).toBe(9);
    expect(getEmbeddedFormPlacement(elsewhere.id)!.anchorRow).toBe(5);
  });

  it("shifts columns the same way", () => {
    const p = place({ anchorCol: 6 });
    shiftEmbeddedFormPlacements(0, structuralAnchorShift("colDelete", 2, 3));
    expect(getEmbeddedFormPlacement(p.id)!.anchorCol).toBe(3);
    expect(getEmbeddedFormPlacement(p.id)!.id).toBe(p.id);
  });

  it("a MOVE by the user changes geometry and never the id", () => {
    const p = place();
    const moved = setEmbeddedFormGeometry(p.id, { anchorRow: 40, anchorCol: 9, width: 500 });
    expect(moved!.id).toBe(p.id);
    expect(moved!.anchorRow).toBe(40);
    expect(moved!.width).toBe(500);
  });
});

describe("deleting the anchor ORPHANS the placement — it does not disappear", () => {
  it("keeps the record, marks it orphaned, and keeps its script and geometry", () => {
    const p = place({ anchorRow: 5 });
    const changed = shiftEmbeddedFormPlacements(0, structuralAnchorShift("rowDelete", 4, 3));
    expect(changed).toBe(true);

    // THE DEFECT THIS CLOSES: `reanchorFloatingControls` DROPS a control whose
    // anchor row was deleted, and nothing anywhere tells the user their object
    // is gone. The record survives so the surface can say what happened.
    const after = getEmbeddedFormPlacement(p.id);
    expect(after).not.toBeNull();
    expect(after!.orphaned).toBe(true);
    expect(after!.scriptId).toBe(SCRIPT);
    expect(after!.anchorRow).toBe(5);
    expect(listEmbeddedFormPlacements()).toHaveLength(1);
  });

  it("does not re-shift an orphan on the next edit — its anchor is already meaningless", () => {
    const p = place({ anchorRow: 5 });
    shiftEmbeddedFormPlacements(0, structuralAnchorShift("rowDelete", 5, 1));
    expect(getEmbeddedFormPlacement(p.id)!.orphaned).toBe(true);
    expect(shiftEmbeddedFormPlacements(0, structuralAnchorShift("rowInsert", 0, 5))).toBe(false);
    expect(getEmbeddedFormPlacement(p.id)!.anchorRow).toBe(5);
  });

  it("re-anchoring an orphan clears the flag — the one action that fixes it", () => {
    const p = place({ anchorRow: 5 });
    shiftEmbeddedFormPlacements(0, structuralAnchorShift("rowDelete", 5, 1));
    const back = setEmbeddedFormGeometry(p.id, { anchorRow: 2, anchorCol: 2 });
    expect(back!.orphaned).toBe(false);
    // A pure RESIZE is not a re-anchor: it must not silently un-orphan.
    const other = place({ anchorRow: 8 });
    shiftEmbeddedFormPlacements(0, structuralAnchorShift("rowDelete", 8, 1));
    expect(setEmbeddedFormGeometry(other.id, { width: 400 })!.orphaned).toBe(true);
  });

  it("a deleted SHEET orphans its placements too, and leaves other sheets alone", () => {
    const here = place({ sheetIndex: 0 });
    const elsewhere = place({ sheetIndex: 1 });
    expect(orphanEmbeddedFormsForSheet(0)).toBe(true);
    expect(getEmbeddedFormPlacement(here.id)!.orphaned).toBe(true);
    expect(getEmbeddedFormPlacement(elsewhere.id)!.orphaned).toBe(false);
    // Idempotent: a second delete announces nothing.
    expect(orphanEmbeddedFormsForSheet(0)).toBe(false);
  });

  it("REMOVE is the only path that forgets a placement, and it is the user's", () => {
    const p = place();
    expect(removeEmbeddedFormPlacement(p.id)).toBe(true);
    expect(getEmbeddedFormPlacement(p.id)).toBeNull();
    expect(removeEmbeddedFormPlacement(p.id)).toBe(false);
  });
});

describe("the change announcement", () => {
  it("fires on every write and never on a no-op shift", () => {
    const seen: string[] = [];
    const listener = (): void => {
      seen.push("changed");
    };
    window.addEventListener(EMBEDDED_FORM_PLACEMENTS_CHANGED_EVENT, listener);
    try {
      const p = place();
      expect(seen).toHaveLength(1);
      shiftEmbeddedFormPlacements(0, structuralAnchorShift("rowInsert", 99, 1));
      expect(seen).toHaveLength(1);
      shiftEmbeddedFormPlacements(0, structuralAnchorShift("rowInsert", 0, 1));
      expect(seen).toHaveLength(2);
      removeEmbeddedFormPlacement(p.id);
      expect(seen).toHaveLength(3);
      resetEmbeddedFormPlacements();
      // Nothing left: a reset with an empty store announces nothing.
      expect(seen).toHaveLength(3);
    } finally {
      window.removeEventListener(EMBEDDED_FORM_PLACEMENTS_CHANGED_EVENT, listener);
    }
  });

  it("hands out COPIES, so a caller cannot mutate the store by holding a row", () => {
    const p = place();
    const read = getEmbeddedFormPlacement(p.id)!;
    read.anchorRow = 999;
    read.orphaned = true;
    expect(getEmbeddedFormPlacement(p.id)).toMatchObject({ anchorRow: 5, orphaned: false });
  });
});

describe("the id minter", () => {
  it("is crypto.randomUUID in production", () => {
    const spy = vi.spyOn(crypto, "randomUUID");
    place();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("is replaceable for tests, and the test seam restores it", () => {
    let n = 0;
    __setEmbeddedFormIdMinterForTests(() => `fixed-${++n}`);
    expect(place().id).toBe("fixed-1");
    __setEmbeddedFormIdMinterForTests(null);
    expect(place().id).not.toBe("fixed-2");
  });
});
