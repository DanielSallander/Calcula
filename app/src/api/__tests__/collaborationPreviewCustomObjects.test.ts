//! FILENAME: app/src/api/__tests__/collaborationPreviewCustomObjects.test.ts
// PURPOSE: BUG-0150. The push preview and the merge analysis must be handed the
//          frontend providers' distributable objects, exactly as a push is.
// CONTEXT: `publishApplication` collects them (`collectDistributableObjects`)
//          and `calp_publish` merges them into the application. The preview
//          commands (`calp_diff_working_copy`, `calp_push_merge_analyze`,
//          `calp_push_merge_apply`) serialize the workbook through the same
//          publish, but nothing sent them the objects -- so every model overlay
//          and report the push WOULD carry read as REMOVED in the push diff,
//          and as a piece "you" touched in the merge analysis.

import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeBackend = vi.fn();
vi.mock("../backend", () => ({
  invokeBackend: (...args: unknown[]) => invokeBackend(...args),
}));

import { registerDistributableObjectProvider } from "../distributableObjects";
import { diffWorkingCopy, pushMergeAnalyze, pushMergeApply } from "../collaboration";

const OVERLAY = {
  kind: "test.overlay",
  id: "overlay-1",
  name: "Workbook measures",
  payload: { measures: ["Margin"] },
};

describe("the push preview sees the objects the push would carry (BUG-0150)", () => {
  beforeEach(() => {
    invokeBackend.mockReset();
    invokeBackend.mockResolvedValue({});
  });

  it("the working-copy diff is handed the providers' objects", async () => {
    const cleanup = registerDistributableObjectProvider({
      kind: OVERLAY.kind,
      collect: () => [OVERLAY],
      materialize: () => {},
    });
    try {
      await diffWorkingCopy({ includeComments: true });
    } finally {
      cleanup();
    }
    expect(invokeBackend).toHaveBeenCalledTimes(1);
    const [command, args] = invokeBackend.mock.calls[0];
    expect(command).toBe("calp_diff_working_copy");
    expect(args.params.includeComments).toBe(true);
    expect(args.params.customObjects).toEqual([OVERLAY]);
  });

  it("a caller's own objects win over collecting again", async () => {
    await diffWorkingCopy({ customObjects: [] });
    const [, args] = invokeBackend.mock.calls[0];
    expect(args.params.customObjects).toEqual([]);
  });

  it("the merge analysis AND the merge apply are handed the same objects", async () => {
    const cleanup = registerDistributableObjectProvider({
      kind: OVERLAY.kind,
      collect: () => [OVERLAY],
      materialize: () => {},
    });
    try {
      await pushMergeAnalyze();
      await pushMergeApply();
    } finally {
      cleanup();
    }
    const commands = invokeBackend.mock.calls.map((c) => c[0]);
    expect(commands).toEqual(["calp_push_merge_analyze", "calp_push_merge_apply"]);
    for (const [, args] of invokeBackend.mock.calls) {
      expect(args.params.customObjects).toEqual([OVERLAY]);
    }
  });
});
