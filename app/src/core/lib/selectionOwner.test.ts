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
} from "./selectionOwner";
import { gridCommands, GRID_COMMANDS } from "./gridCommands";
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
