//! FILENAME: app/src/core/lib/selectionOwner.test.ts
// PURPOSE: The selection-owner seam (BUG-0185): the store's rules, and the
//          one Core door that every ribbon/menu grid command goes through
//          (gridCommands.execute) refusing while an owner holds the selection.
// CONTEXT: With a floating grid's cell selected on a worksheet, Core's
//          selection stays on a cell HIDDEN under it. The grid commands (cut,
//          copy, paste, the clears, insert/delete, merge, the fills) act on
//          that selection from the ribbon and the menus. The floating grid
//          guards them itself today; the seam lets ANY owner refuse them, with
//          one toast rather than a modal, and lets the owner drop its copy of
//          the list.

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("./dialogs", () => ({ alertAsync: vi.fn(async () => undefined) }));

import {
  registerSelectionOwner,
  getSelectionOwner,
  isSelectionOwned,
  refuseIfSelectionOwned,
  selectionOwnerReceivesTyping,
  selectionRefusalFor,
  setSelectionRefusalAnnouncer,
  resolveCellTarget,
  cellTargetFor,
  setGridSelectionReader,
  CELL_TARGET_CAPABILITIES,
  WHOLE_OBJECT_CAPABILITIES,
  type CellTargetCapability,
  type OwnedCellTarget,
} from "./selectionOwner";
import { gridCommands, GRID_COMMANDS, GRID_COMMAND_CAPABILITY } from "./gridCommands";
import type { Selection } from "../types";
import { alertAsync } from "./dialogs";

const announced: string[] = [];
const cleanups: (() => void)[] = [];

function owner(owns: () => boolean, extra: Partial<Parameters<typeof registerSelectionOwner>[0]> = {}): void {
  cleanups.push(
    registerSelectionOwner({ id: extra.id ?? "test", label: "the test object's cells", ownsSelection: owns, ...extra }),
  );
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  setSelectionRefusalAnnouncer(null);
  setGridSelectionReader(null);
  announced.length = 0;
  gridCommands.clear();
  vi.mocked(alertAsync).mockClear();
});

describe("the store", () => {
  it("nothing registered: Core's grid holds the selection", () => {
    expect(getSelectionOwner()).toBeNull();
    expect(isSelectionOwned()).toBe(false);
    expect(refuseIfSelectionOwned("Bold")).toBe(false);
  });

  it("asks the owner every time -- a claim cannot outlive the selection it describes", () => {
    let owns = true;
    owner(() => owns);
    expect(isSelectionOwned()).toBe(true);
    owns = false;
    expect(isSelectionOwned()).toBe(false);
  });

  it("refuses ONCE per ask, with the owner's sentence, through the announcer", () => {
    setSelectionRefusalAnnouncer((m) => announced.push(m));
    owner(() => true, { refusal: (action) => `${action}: not for my object.` });
    expect(refuseIfSelectionOwned("Bold")).toBe(true);
    expect(announced).toEqual(["Bold: not for my object."]);
  });

  it("an owner with no sentence gets the default, naming the action and the owner", () => {
    owner(() => true);
    const sentence = selectionRefusalFor("Wrap Text")!;
    expect(sentence).toContain("Wrap Text");
    expect(sentence).toContain("the test object's cells");
  });

  it("an owner that THROWS does not own (a broken extension cannot take formatting away)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    owner(() => {
      throw new Error("boom");
    });
    expect(isSelectionOwned()).toBe(false);
    err.mockRestore();
  });

  it("a stale cleanup does not remove a newer registration under the same id", () => {
    const first = registerSelectionOwner({ id: "same", label: "a", ownsSelection: () => true });
    cleanups.push(registerSelectionOwner({ id: "same", label: "b", ownsSelection: () => true }));
    first();
    expect(getSelectionOwner()?.label).toBe("b");
  });
});

// BUG-0270. The generic "an object is selected" claim must stand BEHIND the
// specific ones -- a floating grid's cell (whose own cell takes typing) and the
// keyboard inside a slicer (its own sentence) -- whatever order the extensions
// happened to register in. Registration order is an accident of the manifest.
describe("a FALLBACK owner stands behind every other owner", () => {
  it("registered FIRST, it still loses to a specific owner registered later: the specific sentence and typing win", () => {
    let specificOwns = true;
    owner(() => true, {
      id: "generic",
      fallback: true,
      refusal: (a) => `${a}: generic.`,
      receivesTyping: () => false,
    });
    owner(() => specificOwns, {
      id: "specific",
      refusal: (a) => `${a}: specific.`,
      receivesTyping: () => true,
    });
    expect(getSelectionOwner()?.id).toBe("specific");
    expect(selectionRefusalFor("Bold")).toBe("Bold: specific.");
    expect(selectionOwnerReceivesTyping()).toBe(true);

    // Only the fallback owns: it answers.
    specificOwns = false;
    expect(getSelectionOwner()?.id).toBe("generic");
    expect(selectionRefusalFor("Bold")).toBe("Bold: generic.");
    expect(selectionOwnerReceivesTyping()).toBe(false);
  });

  it("two fallbacks: insertion order decides between them", () => {
    owner(() => true, { id: "fallback-a", fallback: true });
    owner(() => true, { id: "fallback-b", fallback: true });
    expect(getSelectionOwner()?.id).toBe("fallback-a");
  });

  it("a specific owner that THROWS leaves the fallback to answer", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    owner(() => true, { id: "generic", fallback: true });
    owner(
      () => {
        throw new Error("boom");
      },
      { id: "specific" },
    );
    expect(getSelectionOwner()?.id).toBe("generic");
    err.mockRestore();
  });
});

describe("SelectionOwner.shouldAnnounce: a refusal the owner already said is refused SILENTLY (BUG-0270 review)", () => {
  // Typing a word with a slicer selected queued one identical toast per
  // character. An owner may say a sentence once: the door still refuses
  // (nothing reaches the cell), only the repeat is not announced.
  it("false: the door still refuses, and nothing is announced", () => {
    setSelectionRefusalAnnouncer((m) => announced.push(m));
    owner(() => true, { shouldAnnounce: () => false });
    expect(refuseIfSelectionOwned("Edit Cell"), "a quiet refusal let the door act").toBe(true);
    expect(announced, "the owner asked for silence and a toast was shown").toEqual([]);
  });

  it("asked with the very sentence the door would show; true announces it", () => {
    setSelectionRefusalAnnouncer((m) => announced.push(m));
    const asked: string[] = [];
    owner(() => true, {
      refusal: (a) => `${a}: no.`,
      shouldAnnounce: (sentence) => {
        asked.push(sentence);
        return true;
      },
    });
    expect(refuseIfSelectionOwned("Bold")).toBe(true);
    expect(asked).toEqual(["Bold: no."]);
    expect(announced).toEqual(["Bold: no."]);
  });

  it("a THROW announces (a broken owner must not silence a refusal)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    setSelectionRefusalAnnouncer((m) => announced.push(m));
    owner(() => true, {
      shouldAnnounce: () => {
        throw new Error("boom");
      },
    });
    expect(refuseIfSelectionOwned("Bold")).toBe(true);
    expect(announced.length).toBe(1);
    err.mockRestore();
  });

  it("selectionRefusalFor never asks it (it announces nothing anyway)", () => {
    const ask = vi.fn(() => false);
    owner(() => true, { refusal: (a) => `${a}: no.`, shouldAnnounce: ask });
    expect(selectionRefusalFor("Bold")).toBe("Bold: no.");
    expect(ask).not.toHaveBeenCalled();
  });
});

// Owner call 25 (2026-10-02, Excel parity): Insert Shape, Insert > Controls >
// Button and Insert Image stay available while an object is merely SELECTED on
// a worksheet. The generic "an object is selected" claim declares that it does
// not stand in front of that KIND of door (`admits: ["objectInsert"]`); a door
// of that kind passes it, every other door is refused exactly as before, and a
// claim that admits nothing (a floating grid's cell) still refuses the insert.
describe("SelectionOwner.admits: a claim may let one KIND of door through", () => {
  it("an owner that admits objectInsert does not refuse that door, and still refuses every other", () => {
    setSelectionRefusalAnnouncer((m) => announced.push(m));
    owner(() => true, { id: "generic", fallback: true, admits: ["objectInsert"], refusal: (a) => `${a}: generic.` });
    expect(refuseIfSelectionOwned("Insert Shape", "objectInsert"), "the insert door was refused").toBe(false);
    expect(selectionRefusalFor("Insert Shape", "objectInsert")).toBeNull();
    expect(getSelectionOwner("objectInsert")).toBeNull();
    expect(announced, "an admitted door announced a refusal").toEqual([]);
    // Every other door: refused, as before.
    expect(refuseIfSelectionOwned("Insert Shape"), "a door with no kind passed the claim").toBe(true);
    expect(refuseIfSelectionOwned("Edit Cell")).toBe(true);
    expect(announced).toEqual(["Insert Shape: generic.", "Edit Cell: generic."]);
    expect(isSelectionOwned(), "admitting a door ended the claim itself").toBe(true);
  });

  it("an owner that admits nothing refuses the insert door with ITS sentence, whatever stands behind it", () => {
    setSelectionRefusalAnnouncer((m) => announced.push(m));
    owner(() => true, { id: "generic", fallback: true, admits: ["objectInsert"], refusal: (a) => `${a}: generic.` });
    owner(() => true, { id: "specific", refusal: (a) => `${a}: specific.` });
    expect(refuseIfSelectionOwned("Insert Shape", "objectInsert")).toBe(true);
    expect(getSelectionOwner("objectInsert")?.id).toBe("specific");
    expect(announced).toEqual(["Insert Shape: specific."]);
  });

  it("an admitting owner is skipped, not obeyed: a FALLBACK that admits nothing still refuses", () => {
    owner(() => true, { id: "specific", admits: ["objectInsert"], refusal: (a) => `${a}: specific.` });
    owner(() => true, { id: "generic", fallback: true, refusal: (a) => `${a}: generic.` });
    expect(getSelectionOwner()?.id, "control: the specific owner speaks for an ordinary door").toBe("specific");
    expect(selectionRefusalFor("Insert Shape", "objectInsert")).toBe("Insert Shape: generic.");
  });

  it("no claim holds: the insert door acts (control)", () => {
    owner(() => false, { admits: [] });
    expect(refuseIfSelectionOwned("Insert Shape", "objectInsert")).toBe(false);
  });
});

describe("gridCommands.execute refuses every grid command while the selection is owned", () => {
  for (const command of GRID_COMMANDS) {
    it(`${command}: the handler does not run, one announcement, no modal`, async () => {
      const handler = vi.fn();
      gridCommands.register(command, handler);
      setSelectionRefusalAnnouncer((m) => announced.push(m));
      owner(() => true);
      await expect(gridCommands.execute(command)).resolves.toBe(false);
      expect(handler, `${command} acted on Core's hidden selection`).not.toHaveBeenCalled();
      expect(announced.length).toBe(1);
      expect(alertAsync).not.toHaveBeenCalled();
    });
  }

  it("the refusal comes BEFORE the command's own guards, so the user hears one sentence", async () => {
    const handler = vi.fn();
    const guard = vi.fn(() => "a guard's modal");
    gridCommands.register("mergeCells", handler);
    cleanups.push(gridCommands.registerGuard(["mergeCells"], guard));
    setSelectionRefusalAnnouncer((m) => announced.push(m));
    owner(() => true);
    await gridCommands.execute("mergeCells");
    expect(guard).not.toHaveBeenCalled();
    expect(alertAsync).not.toHaveBeenCalled();
    expect(announced.length).toBe(1);
  });

  it("the refusal names Merge & Center as Excel does, not by a word split", async () => {
    gridCommands.register("mergeCenter", vi.fn());
    gridCommands.register("mergeAcross", vi.fn());
    setSelectionRefusalAnnouncer((m) => announced.push(m));
    owner(() => true);
    await gridCommands.execute("mergeCenter");
    await gridCommands.execute("mergeAcross");
    expect(announced[0]).toContain("Merge & Center");
    expect(announced[0]).not.toContain("Merge Center");
    expect(announced[1]).toContain("Merge Across");
  });

  it("positive control: with no owner the handler runs", async () => {
    const handler = vi.fn();
    gridCommands.register("fillDown", handler);
    owner(() => false);
    await expect(gridCommands.execute("fillDown")).resolves.toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// P3 (owner finding G3): resolveCellTarget -- a door acts on an OWNER's cells
// instead of refusing, when the owner admits the kind of act.
// ============================================================================

const GRID_SEL: Selection = { startRow: 4, startCol: 4, endRow: 4, endCol: 4, type: "cells" };
const OWNED: OwnedCellTarget = {
  ref: { kind: "floatingRange", id: "fr-1" },
  selection: { startRow: 1, startCol: 1, endRow: 2, endCol: 2, type: "cells", activeRow: 1, activeCol: 1 },
  bounds: { rows: 5, cols: 4 },
  label: "Float1",
  wholeObject: false,
};

describe("resolveCellTarget: the door's new question", () => {
  it("no owner: the GRID target, carrying Core's selection from the registered reader", () => {
    setGridSelectionReader(() => GRID_SEL);
    const t = resolveCellTarget("Bold", "format");
    expect(t).toEqual({ kind: "grid", selection: GRID_SEL });
  });

  it("no owner and no reader: still the grid target (a door with no selection behaves as before)", () => {
    expect(resolveCellTarget("Bold", "format")).toEqual({ kind: "grid", selection: null });
  });

  it("an owner that admits the capability and answers: the OBJECT target, naming the owner that answered", () => {
    setSelectionRefusalAnnouncer((m) => announced.push(m));
    setGridSelectionReader(() => GRID_SEL);
    owner(() => true, { id: "fr", actsOn: ["format", "numberFormat"], cellTarget: () => OWNED });
    const t = resolveCellTarget("Decrease Decimal", "numberFormat");
    expect(t?.kind).toBe("object");
    if (t?.kind !== "object") throw new Error("unreachable");
    expect(t.ownerId).toBe("fr");
    expect(t.ref).toEqual({ kind: "floatingRange", id: "fr-1" });
    expect(t.selection, "the door must act on the OWNER's cells, not Core's hidden one").toEqual(OWNED.selection);
    expect(t.bounds).toEqual({ rows: 5, cols: 4 });
    expect(announced, "an admitted door announced a refusal").toEqual([]);
  });

  it("an owner that does NOT admit the capability refuses ONCE, with refusal(action, capability)", () => {
    setSelectionRefusalAnnouncer((m) => announced.push(m));
    const asked: [string, CellTargetCapability | undefined][] = [];
    owner(() => true, {
      id: "fr",
      actsOn: ["format"],
      cellTarget: () => OWNED,
      refusal: (action, capability) => {
        asked.push([action, capability]);
        return `${action}: not inside this object (${capability}).`;
      },
    });
    expect(resolveCellTarget("Format as Table", "table")).toBeNull();
    expect(asked).toEqual([["Format as Table", "table"]]);
    expect(announced).toEqual(["Format as Table: not inside this object (table)."]);
  });

  it("an owner with NO actsOn (every owner before P3) refuses every capability, as before", () => {
    setSelectionRefusalAnnouncer((m) => announced.push(m));
    const cellTarget = vi.fn(() => OWNED);
    owner(() => true, { id: "fr", cellTarget });
    for (const capability of CELL_TARGET_CAPABILITIES) {
      expect(resolveCellTarget("Act", capability), `${capability} was admitted with no actsOn`).toBeNull();
    }
    expect(cellTarget, "cellTarget was asked although nothing is admitted").not.toHaveBeenCalled();
    expect(announced.length).toBe(CELL_TARGET_CAPABILITIES.length);
  });

  it("actsOn without a cellTarget answer: refused (the door has no cells to act on)", () => {
    owner(() => true, { id: "fr", actsOn: ["format"] });
    expect(resolveCellTarget("Bold", "format")).toBeNull();
  });

  it("a WHOLE-OBJECT selection admits format/numberFormat/conditionalFormat/read and refuses structure", () => {
    setSelectionRefusalAnnouncer((m) => announced.push(m));
    const whole: OwnedCellTarget = { ...OWNED, wholeObject: true };
    owner(() => true, {
      id: "fr",
      actsOn: [...CELL_TARGET_CAPABILITIES],
      cellTarget: () => whole,
    });
    for (const capability of WHOLE_OBJECT_CAPABILITIES) {
      expect(resolveCellTarget("Act", capability)?.kind, `${capability} refused on the whole object`).toBe("object");
    }
    expect(announced).toEqual([]);
    expect(resolveCellTarget("Insert Sheet Rows", "structure")).toBeNull();
    expect(announced).toEqual(["Insert Sheet Rows needs cells: select cells inside Float1 first. Nothing was changed."]);
  });

  it("a whole-object refusal uses the owner's own sentence when it gives one for reason 'wholeObject'", () => {
    setSelectionRefusalAnnouncer((m) => announced.push(m));
    owner(() => true, {
      id: "fr",
      actsOn: ["structure"],
      cellTarget: () => ({ ...OWNED, wholeObject: true }),
      refusal: (action, _capability, reason) =>
        reason === "wholeObject" ? "Select cells inside the floating grid first." : `${action}: no.`,
    });
    expect(resolveCellTarget("Delete Sheet Rows", "structure")).toBeNull();
    expect(announced).toEqual(["Select cells inside the floating grid first."]);
  });

  it("a THROWING cellTarget refuses -- it never falls through to Core's hidden cell", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    setSelectionRefusalAnnouncer((m) => announced.push(m));
    setGridSelectionReader(() => GRID_SEL);
    owner(() => true, {
      id: "fr",
      actsOn: ["format"],
      cellTarget: () => {
        throw new Error("boom");
      },
      refusal: (a) => `${a}: refused.`,
    });
    expect(resolveCellTarget("Bold", "format"), "a broken owner handed the door Core's hidden selection").toBeNull();
    expect(announced).toEqual(["Bold: refused."]);
    err.mockRestore();
  });

  it("a null or malformed cellTarget answer refuses too", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let answer: unknown = null;
    owner(() => true, { id: "fr", actsOn: ["format"], cellTarget: () => answer as OwnedCellTarget | null });
    expect(resolveCellTarget("Bold", "format")).toBeNull();
    answer = { ref: { kind: "floatingRange", id: "" }, selection: OWNED.selection, bounds: OWNED.bounds };
    expect(resolveCellTarget("Bold", "format")).toBeNull();
    err.mockRestore();
  });

  it("an owner that does not hold the selection right now is not asked: the grid target", () => {
    const cellTarget = vi.fn(() => OWNED);
    owner(() => false, { id: "fr", actsOn: ["format"], cellTarget });
    expect(resolveCellTarget("Bold", "format")?.kind).toBe("grid");
    expect(cellTarget).not.toHaveBeenCalled();
  });

  it("shouldAnnounce false: still refused, silently", () => {
    setSelectionRefusalAnnouncer((m) => announced.push(m));
    owner(() => true, { id: "fr", shouldAnnounce: () => false });
    expect(resolveCellTarget("Bold", "format")).toBeNull();
    expect(announced).toEqual([]);
  });

  it("cellTargetFor answers the same WITHOUT announcing", () => {
    setSelectionRefusalAnnouncer((m) => announced.push(m));
    owner(() => true, { id: "fr", actsOn: ["read"], cellTarget: () => OWNED, refusal: (a, c) => `${a}/${c}: no.` });
    const read = cellTargetFor("read");
    expect("kind" in read && read.kind).toBe("object");
    expect(cellTargetFor("sort", "Sort A to Z")).toEqual({ refusal: "Sort A to Z/sort: no." });
    expect(announced).toEqual([]);
  });

  it("an admitted owner's target outranks a fallback claim (the specific owner answers)", () => {
    owner(() => true, { id: "generic", fallback: true, refusal: (a) => `${a}: generic.` });
    owner(() => true, { id: "fr", actsOn: ["format"], cellTarget: () => OWNED });
    const t = resolveCellTarget("Bold", "format");
    expect(t?.kind === "object" && t.ownerId).toBe("fr");
  });
});

describe("gridCommands.execute hands the resolved target to the handler", () => {
  it("every grid command has a capability, and the table matches the spec's kinds", () => {
    for (const command of GRID_COMMANDS) {
      expect(CELL_TARGET_CAPABILITIES, `${command} has no capability`).toContain(GRID_COMMAND_CAPABILITY[command]);
    }
    expect(GRID_COMMAND_CAPABILITY.copy).toBe("read");
    expect(GRID_COMMAND_CAPABILITY.cut).toBe("content");
    expect(GRID_COMMAND_CAPABILITY.paste).toBe("content");
    expect(GRID_COMMAND_CAPABILITY.unmergeCells).toBe("merge");
    expect(GRID_COMMAND_CAPABILITY.insertRow).toBe("structure");
    expect(GRID_COMMAND_CAPABILITY.autoFitColumnWidth).toBe("lineSize");
    expect(GRID_COMMAND_CAPABILITY.removeHyperlinks).toBe("clear");
    expect(GRID_COMMAND_CAPABILITY.fillLeft).toBe("content");
  });

  it("an OBJECT target skips the grid guards (they describe Core's sheet) and reaches the handler as ctx.target", async () => {
    const handler = vi.fn();
    const guard = vi.fn(() => "a sheet guard's modal");
    gridCommands.register("clearContents", handler);
    cleanups.push(gridCommands.registerGuard(["clearContents"], guard));
    owner(() => true, { id: "fr", actsOn: ["clear"], cellTarget: () => OWNED });
    await expect(gridCommands.execute("clearContents", { why: "test" })).resolves.toBe(true);
    expect(guard, "a sheet guard judged the object's cells").not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
    const [args, ctx] = handler.mock.calls[0];
    expect(args).toEqual({ why: "test" });
    expect(ctx.target.kind).toBe("object");
    expect(ctx.target.ref).toEqual({ kind: "floatingRange", id: "fr-1" });
    expect(ctx.target.selection).toEqual(OWNED.selection);
  });

  it("the GRID target still runs the guards and reaches the handler as ctx.target", async () => {
    const handler = vi.fn();
    const guard = vi.fn(() => true);
    setGridSelectionReader(() => GRID_SEL);
    gridCommands.register("fillDown", handler);
    cleanups.push(gridCommands.registerGuard(["fillDown"], guard));
    await expect(gridCommands.execute("fillDown")).resolves.toBe(true);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1]).toEqual({ target: { kind: "grid", selection: GRID_SEL } });
  });

  it("an owner that admits OTHER kinds still refuses this command, once, and the handler never runs", async () => {
    const handler = vi.fn();
    setSelectionRefusalAnnouncer((m) => announced.push(m));
    gridCommands.register("insertRow", handler);
    owner(() => true, { id: "fr", actsOn: ["format", "clear"], cellTarget: () => OWNED, refusal: (a) => `${a}: no.` });
    await expect(gridCommands.execute("insertRow")).resolves.toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(announced).toEqual(["Insert Row: no."]);
  });
});
