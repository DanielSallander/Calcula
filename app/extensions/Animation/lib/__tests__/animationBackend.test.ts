import { describe, it, expect, vi } from "vitest";
import {
  animationBackend,
  animSnapshot,
  animApplyFrame,
  animRestore,
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

  it("rejects before activate() binds the channel", async () => {
    const fresh = (await import("@api/backendCommands")).createBackendChannel("AnimationTest");
    expect(fresh.bound).toBe(false);
    await expect(fresh.invoke("anim_apply_frame")).rejects.toThrow(/before activate/i);
  });
});
