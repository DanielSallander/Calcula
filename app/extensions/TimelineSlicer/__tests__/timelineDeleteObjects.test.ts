//! FILENAME: app/extensions/TimelineSlicer/__tests__/timelineDeleteObjects.test.ts
// PURPOSE: A4 (wave B) + W26 (wave C). The timelines' share of a canvas
//          multi-selection Delete (`deleteTimelineRegions`) resolves once the
//          deletes LANDED (the store re-read) and REJECTS with the backend's
//          reason on a refusal (the seam contract) -- and it IS the provider's
//          `deleteObjects` (W26), so a timeline in a canvas multi-selection
//          is deleted with the rest instead of staying selected and being
//          named "delete it on its own".
//          That is right ONLY while the backend's `delete_timeline_slicer`
//          JOINS an open transaction: the seam runs every family inside ONE
//          undo transaction, and a delete that commits whatever is open splits
//          the canvas-wide Delete into several Ctrl+Z steps (the review of A4).
//          The pairing test reads the Rust delete PATH -- the command and every
//          same-file function it reaches, `delete_timeline_slicer_core`
//          included -- and fails if the delete ever goes back to its own
//          begin/commit pair (wave C review: the first version read only the
//          thin wrapper and stayed green with the pair back in `_core`).

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  backend: [] as Array<Record<string, unknown>>,
  refuse: {} as Record<string, string>,
  deleted: [] as string[],
}));

vi.mock("../lib/timeline-slicer-api", () => ({
  getAllTimelineSlicers: async () => h.backend.map((t) => ({ ...t })),
  getTimelineData: async () => ({ periods: [] }),
  deleteTimelineSlicer: async (id: string) => {
    if (h.refuse[id]) throw new Error(h.refuse[id]);
    h.deleted.push(id);
    h.backend = h.backend.filter((t) => t.id !== id);
  },
}));
vi.mock("@api/state", () => ({ getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 0 } }) }));

import type { GridRegion } from "@api/gridOverlays";
import {
  createTimelineSelectionProvider,
  deleteTimelineRegions,
  TIMELINE_REGION_TYPE,
} from "../lib/timelineObjectSelection";
import { getTimelineById, refreshCache } from "../lib/timelineSlicerStore";

function timeline(id: string): Record<string, unknown> {
  return { id, name: `Timeline ${id}`, sheetIndex: 0, x: 0, y: 0, width: 300, height: 120, sourceId: "p1" };
}

function region(id: string): GridRegion {
  return {
    id: `timeline-${id}`,
    type: TIMELINE_REGION_TYPE,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 0, y: 0, width: 300, height: 120 },
    data: { timelineId: id },
  };
}

beforeEach(async () => {
  h.backend = [timeline("t1"), timeline("t2")];
  h.refuse = {};
  h.deleted.length = 0;
  await refreshCache();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

// ============================================================================
// The Rust delete path (the pairing check)
// ============================================================================

/** timeline_slicer/commands.rs, LF line endings. */
async function readTimelineCommands(): Promise<string> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  return fs
    .readFileSync(path.resolve(__dirname, "../../../src-tauri/src/timeline_slicer/commands.rs"), "utf8")
    .split("\r\n")
    .join("\n");
}

/**
 * The whole DELETE PATH, not just the Tauri command: the command is a thin
 * wrapper over `delete_timeline_slicer_core`, where the removal and its undo
 * record live (wave C review: a check of the wrapper alone stayed green with
 * the old begin/commit pair put back into `_core`). Every same-file function
 * the command calls, transitively; each body runs from its signature to its
 * brace-matched end. Code only: a comment that names the old pair must not
 * count.
 */
async function deletePathOf(raw: string): Promise<{ visited: string[]; code: string }> {
  const src = raw
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  const bodyOf = (name: string): string | null => {
    const m = new RegExp(`\\bfn ${name}\\s*[<(]`).exec(src);
    if (!m) return null;
    const open = src.indexOf("{", m.index);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return src.slice(m.index, i + 1);
    }
    return null;
  };
  const defined = new Set(Array.from(src.matchAll(/\bfn ([a-z_][a-z0-9_]*)\s*[<(]/g), (m) => m[1]));
  const visited = new Map<string, string>();
  const queue = ["delete_timeline_slicer"];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    const body = bodyOf(name);
    expect(body, `test out of date: fn ${name} in timeline_slicer/commands.rs`).not.toBeNull();
    visited.set(name, body!);
    for (const call of body!.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/g)) {
      if (defined.has(call[1]) && !visited.has(call[1])) queue.push(call[1]);
    }
  }
  return { visited: [...visited.keys()], code: [...visited.values()].join("\n") };
}

/** Whether `code` opens AND commits a transaction of its own. */
function commitsWhateverIsOpen(code: string): boolean {
  return /\.begin_transaction\(/.test(code) && /\.commit_transaction\(\)/.test(code);
}

describe("the timelines' share of a canvas-wide Delete", () => {
  it("IS the provider's deleteObjects: a timeline in a canvas multi-selection is deleted with the rest (W26)", async () => {
    const provider = createTimelineSelectionProvider();
    expect(
      provider.deleteObjects,
      "the timeline provider has no deleteObjects: a canvas-wide Delete keeps every selected timeline and names it",
    ).toBeDefined();
    await provider.deleteObjects!([region("t1")]);
    expect(h.deleted, "the provider's delete did not reach the backend").toEqual(["t1"]);
    expect(getTimelineById("t1"), "the provider resolved before the delete landed in the store").toBeUndefined();
    h.refuse = { t2: "Sheet is protected." };
    await expect(provider.deleteObjects!([region("t2")])).rejects.toThrow("Sheet is protected.");
  });

  it("pairing: the backend's delete joins an open transaction (it never commits the seam's one step half-way)", async () => {
    const path = await deletePathOf(await readTimelineCommands());
    expect(path.visited, "the command no longer reaches its core: follow the new path").toContain(
      "delete_timeline_slicer_core",
    );
    // The inspected path is where the delete records its undo -- through the
    // JOINING recorder -- or this check proves nothing.
    expect(
      path.code,
      "the delete path records its undo somewhere else now: point this test at it",
    ).toContain("record_restores_joining_open_transaction(");
    expect(
      commitsWhateverIsOpen(path.code),
      "the timeline delete path opens and commits its own transaction again: detach deleteObjects, or the canvas-wide Delete becomes several Ctrl+Z steps",
    ).toBe(false);
  });

  it("pairing has teeth: the old begin/commit pair put back into `_core` (in memory) is caught", async () => {
    const raw = await readTimelineCommands();
    const anchor = "    let removed = pending.authorize(&effect).remove(&timeline_id);\n";
    expect(raw, "test out of date: the removal line of delete_timeline_slicer_core").toContain(anchor);
    const sabotaged = raw.replace(
      anchor,
      anchor +
        "    let mut undo_stack = state.undo_stack.lock().unwrap();\n" +
        '    undo_stack.begin_transaction("Delete timeline slicer".to_string());\n' +
        "    undo_stack.commit_transaction();\n",
    );
    expect(sabotaged).not.toBe(raw);
    expect(
      commitsWhateverIsOpen((await deletePathOf(sabotaged)).code),
      "the pair inside delete_timeline_slicer_core went unseen (only the thin wrapper was read)",
    ).toBe(true);
  });

  it("deletes every timeline it is handed and resolves once the store no longer holds them", async () => {
    await deleteTimelineRegions([region("t1"), region("t2")]);
    expect(h.deleted).toEqual(["t1", "t2"]);
    expect(getTimelineById("t1")).toBeUndefined();
    expect(getTimelineById("t2")).toBeUndefined();
  });

  it("REJECTS with the backend's reason when a delete is refused (the others still go)", async () => {
    h.refuse = { t2: "Sheet is protected." };
    await expect(deleteTimelineRegions([region("t1"), region("t2")])).rejects.toThrow("Sheet is protected.");
    expect(h.deleted).toEqual(["t1"]);
    expect(getTimelineById("t2")).toBeDefined();
  });
});
