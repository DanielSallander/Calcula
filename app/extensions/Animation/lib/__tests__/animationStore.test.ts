import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@api/extensionData", () => ({
  getExtensionData: vi.fn(),
  setExtensionData: vi.fn().mockResolvedValue(undefined),
  setExtensionDataUndoable: vi.fn().mockResolvedValue(undefined),
  clearExtensionData: vi.fn().mockResolvedValue(undefined),
}));

import { getExtensionData, setExtensionDataUndoable } from "@api/extensionData";
import {
  listAnimations,
  getAnimation,
  upsertAnimation,
  deleteAnimation,
  loadAnimations,
  resetAnimations,
  subscribeAnimations,
  newAnimationId,
} from "../animationStore";
import type { AnimationSpec } from "../../types";

function spec(id: string, name: string, sheetIndex = 0): AnimationSpec {
  return {
    id,
    name,
    sheetIndex,
    driver: "clockCell",
    playback: { fps: 12, loop: false },
    clockCell: { row: 0, col: 1, from: 0, to: 100, step: 1 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAnimations();
});

describe("animationStore", () => {
  it("loadAnimations populates from the A5 extension-data tier", async () => {
    vi.mocked(getExtensionData).mockResolvedValue({ animations: [spec("a1", "One")] });
    await loadAnimations();
    expect(getExtensionData).toHaveBeenCalledWith("calcula.animation");
    expect(listAnimations().map((s) => s.id)).toEqual(["a1"]);
  });

  it("loadAnimations tolerates null / malformed data", async () => {
    vi.mocked(getExtensionData).mockResolvedValue(null);
    await loadAnimations();
    expect(listAnimations()).toEqual([]);
  });

  it("upsert adds then updates the same id, persisting undoably with a label", async () => {
    await upsertAnimation(spec("a1", "One"));
    expect(setExtensionDataUndoable).toHaveBeenLastCalledWith(
      "calcula.animation",
      { animations: [expect.objectContaining({ id: "a1", name: "One" })] },
      'Create animation "One"',
    );
    await upsertAnimation(spec("a1", "One v2"));
    expect(setExtensionDataUndoable).toHaveBeenLastCalledWith(
      "calcula.animation",
      expect.anything(),
      'Edit animation "One v2"',
    );
    expect(listAnimations()).toHaveLength(1);
    expect(getAnimation("a1")?.name).toBe("One v2");
  });

  it("delete removes and persists undoably with a label", async () => {
    await upsertAnimation(spec("a1", "One"));
    await upsertAnimation(spec("a2", "Two"));
    await deleteAnimation("a1");
    expect(listAnimations().map((s) => s.id)).toEqual(["a2"]);
    expect(setExtensionDataUndoable).toHaveBeenLastCalledWith(
      "calcula.animation",
      { animations: [expect.objectContaining({ id: "a2" })] },
      'Delete animation "One"',
    );
  });

  it("listAnimations can filter by sheet", async () => {
    await upsertAnimation(spec("a1", "One", 0));
    await upsertAnimation(spec("a2", "Two", 1));
    expect(listAnimations(1).map((s) => s.id)).toEqual(["a2"]);
    expect(listAnimations().map((s) => s.id)).toEqual(["a1", "a2"]);
  });

  it("notifies subscribers on mutation", async () => {
    const cb = vi.fn();
    const un = subscribeAnimations(cb);
    await upsertAnimation(spec("a1", "One"));
    expect(cb).toHaveBeenCalled();
    un();
  });

  it("newAnimationId returns unique ids", () => {
    expect(newAnimationId()).not.toBe(newAnimationId());
  });
  // ------------------------------------------------------------------
  // THE ACCEPTANCE SHAPE: mutate -> persist -> reload -> still there.
  //
  // "persist was called" is the assertion that passes on the broken version of
  // this defect -- a store plus a hand-synced mirror is only ever wrong at the
  // ONE mutator nobody wrote a test for. What is worth pinning is that the blob
  // the workbook keeps is the blob that comes back.
  // ------------------------------------------------------------------

  it("what a sequence of mutations persisted is exactly what reloads", async () => {
    await upsertAnimation(spec("a1", "One"));
    await upsertAnimation(spec("a2", "Two"));
    await upsertAnimation(spec("a1", "One renamed"));
    await deleteAnimation("a2");

    const persisted = vi.mocked(setExtensionDataUndoable).mock.calls.at(-1)![1];
    resetAnimations();
    expect(listAnimations()).toEqual([]);

    vi.mocked(getExtensionData).mockResolvedValue(persisted);
    await loadAnimations();

    expect(listAnimations().map((s) => s.id)).toEqual(["a1"]);
    expect(getAnimation("a1")?.name).toBe("One renamed");
  });

  it("a delete of an id that is not there persists nothing and notifies nobody", async () => {
    await upsertAnimation(spec("a1", "One"));
    const cb = vi.fn();
    const un = subscribeAnimations(cb);
    vi.mocked(setExtensionDataUndoable).mockClear();

    await deleteAnimation("nope");

    expect(setExtensionDataUndoable).not.toHaveBeenCalled();
    expect(cb).not.toHaveBeenCalled();
    un();
  });

  it("loading and resetting install a list WITHOUT writing one back", async () => {
    // The two exempt doors. A load that persisted would put the workbook's own
    // contents onto the undo stack on every open; a reset that persisted would
    // write an undo entry into a brand-new document.
    vi.mocked(getExtensionData).mockResolvedValue({ animations: [spec("a1", "One")] });
    await loadAnimations();
    resetAnimations();
    expect(setExtensionDataUndoable).not.toHaveBeenCalled();
  });
});
