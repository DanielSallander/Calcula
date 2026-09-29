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

  it("positive control: with no owner the handler runs", async () => {
    const handler = vi.fn();
    gridCommands.register("fillDown", handler);
    owner(() => false);
    await expect(gridCommands.execute("fillDown")).resolves.toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
