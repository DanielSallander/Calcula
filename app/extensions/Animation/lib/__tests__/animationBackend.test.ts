import { describe, it, expect, vi } from "vitest";
import {
  animationBackend,
  animSnapshot,
  animApplyFrame,
  animRestore,
  animRerollAndRead,
  listScenarios,
  exportGif,
} from "../animationBackend";

// These assert the exact IPC payload shape ({ params: {...} } with camelCase
// keys) that the Rust anim_* commands deserialize (AnimSnapshotParams /
// AnimApplyFrameParams / AnimRestoreParams, all #[serde(rename_all="camelCase")]).
describe("animationBackend wrappers", () => {
  it("animSnapshot -> anim_snapshot with token/sheetIndex/cells", async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true, error: null });
    animationBackend.set(invoke);

    const res = await animSnapshot("tok-1", 2, [
      [0, 0],
      [1, 3],
    ]);

    expect(invoke).toHaveBeenCalledWith("anim_snapshot", {
      params: { token: "tok-1", sheetIndex: 2, cells: [[0, 0], [1, 3]] },
    });
    expect(res).toEqual({ success: true, error: null });
  });

  it("animApplyFrame -> anim_apply_frame with sheetIndex/writes", async () => {
    const invoke = vi.fn().mockResolvedValue({ updatedCells: [], error: null });
    animationBackend.set(invoke);

    await animApplyFrame(0, [{ row: 1, col: 1, value: "42" }]);

    expect(invoke).toHaveBeenCalledWith("anim_apply_frame", {
      params: { sheetIndex: 0, writes: [{ row: 1, col: 1, value: "42" }] },
    });
  });

  it("animRestore -> anim_restore with token/sheetIndex", async () => {
    const invoke = vi.fn().mockResolvedValue({ updatedCells: [], error: null });
    animationBackend.set(invoke);

    await animRestore("tok-1", 2);

    expect(invoke).toHaveBeenCalledWith("anim_restore", {
      params: { token: "tok-1", sheetIndex: 2 },
    });
  });

  it("animRerollAndRead -> anim_reroll_and_read", async () => {
    const invoke = vi.fn().mockResolvedValue({ value: 3.14, error: null });
    animationBackend.set(invoke);
    const r = await animRerollAndRead(2, 9, 1);
    expect(invoke).toHaveBeenCalledWith("anim_reroll_and_read", {
      params: { sheetIndex: 2, outcomeRow: 9, outcomeCol: 1 },
    });
    expect(r).toEqual({ value: 3.14, error: null });
  });

  it("listScenarios -> scenario_list, returns the scenarios array", async () => {
    const invoke = vi.fn().mockResolvedValue({ scenarios: [{ name: "A", changingCells: [] }] });
    animationBackend.set(invoke);
    const r = await listScenarios(0);
    expect(invoke).toHaveBeenCalledWith("scenario_list", { sheetIndex: 0 });
    expect(r).toEqual([{ name: "A", changingCells: [] }]);
  });

  it("exportGif -> export_gif with a { req } payload", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    animationBackend.set(invoke);
    const req = {
      path: "/tmp/a.gif",
      width: 4,
      height: 4,
      frames: [{ rgba: [0, 0, 0, 255], delayCs: 5 }],
      repeat: true,
    };
    await exportGif(req);
    expect(invoke).toHaveBeenCalledWith("export_gif", { req });
  });

  it("rejects before activate() binds the channel", async () => {
    const fresh = (await import("@api/backendCommands")).createBackendChannel("AnimationTest");
    expect(fresh.bound).toBe(false);
    await expect(fresh.invoke("anim_apply_frame")).rejects.toThrow(/before activate/i);
  });
});
