//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/homeTabMergeDoors.test.tsx
// PURPOSE: The Home tab's Merge doors run Excel's commands through the ONE
//          command door the ribbon, Ctrl+M and scripts share: the split
//          button's icon half runs Merge & Center (not plain Merge Cells, which
//          it ran before), each menu row runs its own command, and a refusal
//          that escapes as an error reaches the user.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const selection = { startRow: 0, startCol: 0, endRow: 0, endCol: 2 };

vi.mock("@api", () => ({
  useGridState: () => ({ selection }),
  cellEvents: { emit: vi.fn() },
}));
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => ({ selection }),
}));
const execute = vi.hoisted(() => vi.fn(async (..._a: unknown[]): Promise<unknown> => undefined));
vi.mock("@api/commands", () => ({
  CommandRegistry: { execute: (...a: unknown[]) => execute(...a) },
  CoreCommands: {
    MERGE_CELLS: "core.grid.merge",
    UNMERGE_CELLS: "core.grid.unmerge",
    MERGE_CENTER: "core.grid.mergeCenter",
    MERGE_ACROSS: "core.grid.mergeAcross",
  },
}));
vi.mock("@api/ui", () => ({ DialogExtensions: { openDialog: vi.fn() } }));
const alertAsync = vi.hoisted(() => vi.fn());
vi.mock("@api/dialogs", () => ({ alertAsync: (...a: unknown[]) => alertAsync(...a) }));
vi.mock("@api/lib", () => ({
  getCell: vi.fn(async () => null),
  getStyle: vi.fn(async () => ({ bold: false, fontSize: 11 })),
  applyFormatting: vi.fn(async () => ({ cells: [] })),
  setCellRichText: vi.fn(async () => undefined),
}));
vi.mock("../../../_shared/lib/fontList", () => ({ FONT_SIZES: [8, 11, 14] }));

import { useHomeTabState } from "../components/useHomeTabState";

let container: HTMLDivElement;
let root: Root;
let latest: ReturnType<typeof useHomeTabState> | null = null;

function Probe(): React.ReactElement | null {
  latest = useHomeTabState();
  return null;
}

beforeEach(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  execute.mockReset();
  execute.mockResolvedValue(undefined);
  alertAsync.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Probe />);
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  latest = null;
});

describe("the Merge doors", () => {
  it("the split button's icon half (the catalog item) runs Merge & Center", async () => {
    await act(async () => {
      await latest!.handleItemClick({ id: "mergeCells", label: "Merge & Center" } as never);
    });
    expect(execute).toHaveBeenCalledWith("core.grid.mergeCenter");
    expect(execute).not.toHaveBeenCalledWith("core.grid.merge");
  });

  it("each menu row runs its own command", async () => {
    for (const [row, id] of [
      ["mergeCenter", "core.grid.mergeCenter"],
      ["mergeAcross", "core.grid.mergeAcross"],
      ["mergeCells", "core.grid.merge"],
      ["unmergeCells", "core.grid.unmerge"],
    ] as const) {
      await act(async () => {
        await latest!.handleMergeCommand(row);
      });
      expect(execute).toHaveBeenLastCalledWith(id);
    }
  });

  it("a refusal that escapes as an error reaches the user", async () => {
    execute.mockRejectedValue(new Error("Cannot merge: selection overlaps with existing merged region"));
    await act(async () => {
      await latest!.handleMergeCommand("mergeCells");
    });
    expect(alertAsync).toHaveBeenCalledWith("Cannot merge: selection overlaps with existing merged region");
  });
});
