// FILENAME: app/extensions/Collaboration/__tests__/includeInApplicationWire.test.ts
// PURPOSE: M4 -- the REAL @api/collaboration wrappers put "Include in
//          application" on the wire the Rust commands read
//          (`PublishParams.include_in_application`,
//          `PublishPreviewParams.include_in_application`,
//          `DiffWorkingCopyParams.include_in_application`, all camelCase).
// CONTEXT: pushIncludeInApplication.test.tsx doubles @api to mount the dialog,
//          so it cannot see a wrapper that drops the argument on its way to
//          Tauri. Here only `invokeBackend` is doubled.

import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ invokes: [] as { cmd: string; args: Record<string, unknown> }[] }));

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  invokeBackend: async (cmd: string, args?: Record<string, unknown>) => {
    h.invokes.push({ cmd, args: args ?? {} });
    return {};
  },
}));

import { diffWorkingCopy, publishApplication, publishPreview, type IncludedItem } from "@api/collaboration";

const INCLUDED: IncludedItem[] = [{ kind: "moduleScript", id: "macro-new", hash: "rust-hash-1" }];
const paramsOf = (cmd: string): Record<string, unknown> => {
  const call = h.invokes.find((i) => i.cmd === cmd);
  expect(call, `${cmd} was not invoked`).toBeTruthy();
  return call!.args.params as Record<string, unknown>;
};

describe("Include in application reaches the Rust commands", () => {
  // SABOTAGE: drop `includeInApplication: includeInApplication ?? [],` from
  // publishPreview in @api/collaboration.ts.
  it("the preview, the push and the diff each carry the inclusion", async () => {
    await publishPreview([1], false, { registryPath: "\\\\server\\apps", packageName: "sales" }, "report", INCLUDED);
    expect(paramsOf("calp_publish_preview").includeInApplication).toEqual(INCLUDED);

    await publishApplication({
      registryPath: "\\\\server\\apps",
      packageName: "sales",
      version: "1.0.1",
      kind: "report",
      sheetIndices: [1],
      publishedBy: "",
      customObjects: [],
      includeInApplication: INCLUDED,
    });
    expect(paramsOf("calp_publish").includeInApplication).toEqual(INCLUDED);

    await diffWorkingCopy({ sheetIndices: [1], customObjects: [], includeInApplication: INCLUDED });
    expect(paramsOf("calp_diff_working_copy").includeInApplication).toEqual(INCLUDED);
  });

  it("a preview that includes nothing says so explicitly", async () => {
    h.invokes.length = 0;
    await publishPreview([1]);
    expect(paramsOf("calp_publish_preview").includeInApplication).toEqual([]);
  });
});
