//! FILENAME: app/extensions/_shared/lib/__tests__/structuralEditReload.test.ts
// PURPOSE: BUG-0357 -- the ONE list of announcements after which a range the
//          backend keeps for an extension (chart and sparkline data ranges)
//          may have moved, and the subscription both extensions use.

import { describe, it, expect, vi } from "vitest";
import { AppEvents } from "@api";
import { STRUCTURAL_EDIT_EVENTS, onStructuralEdit } from "../structuralEditReload";

describe("structural edit announcements", () => {
  // CHANGED DELIBERATELY (review FU#5): an edit OFF the sheet on screen now
  // announces its own STRUCTURAL_EDIT_ELSEWHERE instead of STRUCTURAL_UNDO,
  // whose other listeners re-read the visible sheet and close its open UI.
  it("are the four whole-line events, STRUCTURAL_UNDO (Insert/Delete Cells, any structural undo) and STRUCTURAL_EDIT_ELSEWHERE (an edit off the sheet on screen)", () => {
    expect([...STRUCTURAL_EDIT_EVENTS].sort()).toEqual(
      [
        AppEvents.ROWS_INSERTED,
        AppEvents.COLUMNS_INSERTED,
        AppEvents.ROWS_DELETED,
        AppEvents.COLUMNS_DELETED,
        AppEvents.STRUCTURAL_UNDO,
        AppEvents.STRUCTURAL_EDIT_ELSEWHERE,
      ].sort(),
    );
  });

  it("onStructuralEdit calls back for each of them, told where the edit was, and its cleanup drops every subscription", () => {
    const handlers = new Map<string, () => void>();
    const off = vi.fn();
    const subscribe = vi.fn((name: string, cb: (detail: unknown) => void) => {
      handlers.set(name, () => cb(undefined));
      return off;
    });
    const onEdit = vi.fn();
    const cleanup = onStructuralEdit(subscribe, onEdit);
    expect([...handlers.keys()].sort()).toEqual([...STRUCTURAL_EDIT_EVENTS].sort());
    for (const [name, fire] of handlers) {
      onEdit.mockClear();
      fire();
      expect(onEdit, name).toHaveBeenCalledTimes(1);
      expect(onEdit, name).toHaveBeenCalledWith(
        name === AppEvents.STRUCTURAL_EDIT_ELSEWHERE ? "elsewhere" : "activeSheet",
      );
    }
    cleanup();
    expect(off).toHaveBeenCalledTimes(STRUCTURAL_EDIT_EVENTS.length);
  });
});
