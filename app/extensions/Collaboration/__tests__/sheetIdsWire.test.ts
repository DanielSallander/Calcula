// FILENAME: app/extensions/Collaboration/__tests__/sheetIdsWire.test.ts
// PURPOSE: Review round 9 -- the REAL @api/collaboration wrappers put the
//          ticked sheets' STABLE ids on the wire (`sheetIds`) at all three
//          publish doors: the push (`calp_publish`), its preview
//          (`calp_publish_preview`) and the working-copy / subscriber diff
//          (`calp_diff_working_copy`). The Rust params read `sheet_ids` and give
//          it precedence over `sheet_indices`, so a sheet dragged, copied or
//          deleted while the non-modal push dialog is open can no longer hand a
//          tick to its neighbour.
// CONTEXT: The dialog tests double @api to mount the dialog, so they cannot see
//          a wrapper that drops `sheetIds` on its way to Tauri. Here only
//          `invokeBackend` is doubled -- and the Rust side of the contract is
//          read from source, in the Rust -> TypeScript direction.

import fs from "fs";
import path from "path";
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ invokes: [] as { cmd: string; args: Record<string, unknown> }[] }));

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  invokeBackend: async (cmd: string, args?: Record<string, unknown>) => {
    h.invokes.push({ cmd, args: args ?? {} });
    return {};
  },
}));

import { diffWorkingCopy, publishApplication, publishPreview } from "@api/collaboration";
import { selectionWire } from "../lib/listedSheets";

const APP_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP_ROOT, rel), "utf8");

const paramsOf = (cmd: string): Record<string, unknown> => {
  const call = h.invokes.find((i) => i.cmd === cmd);
  expect(call, `${cmd} was not invoked`).toBeTruthy();
  return call!.args.params as Record<string, unknown>;
};

const TICKED = { sheetIndices: [2, 0], sheetIds: ["id-summary", "id-dashboard"] };

beforeEach(() => {
  h.invokes.length = 0;
});

describe("the three publish doors carry the ticked sheets by id", () => {
  // SABOTAGE: drop the `sheetIds` spread from publishPreview in
  // @api/collaboration.ts.
  it("the preview, the push and the diff each send sheetIds beside the positions", async () => {
    await publishPreview(TICKED, false, { registryPath: "\\\\server\\apps", packageName: "sales" }, "report");
    expect(paramsOf("calp_publish_preview").sheetIds).toEqual(TICKED.sheetIds);
    expect(paramsOf("calp_publish_preview").sheetIndices).toEqual(TICKED.sheetIndices);

    await publishApplication({
      registryPath: "\\\\server\\apps",
      packageName: "sales",
      version: "1.0.1",
      kind: "report",
      ...TICKED,
      publishedBy: "",
      customObjects: [],
    });
    expect(paramsOf("calp_publish").sheetIds).toEqual(TICKED.sheetIds);
    expect(paramsOf("calp_publish").sheetIndices).toEqual(TICKED.sheetIndices);

    await diffWorkingCopy({ ...TICKED, customObjects: [] });
    expect(paramsOf("calp_diff_working_copy").sheetIds).toEqual(TICKED.sheetIds);
  });

  it("a caller that names positions only sends no sheetIds at all (the door reads the positions)", async () => {
    await publishPreview([1]);
    const params = paramsOf("calp_publish_preview");
    expect(params.sheetIndices).toEqual([1]);
    expect("sheetIds" in params, "an absent selection-by-id was sent as one").toBe(false);
  });
});

describe("selectionWire: ids when every chosen row has one, positions otherwise", () => {
  it("every row has an id: the ids, in list order, beside the positions", () => {
    expect(
      selectionWire([
        { index: 0, sheetId: "id-summary" },
        { index: 2, sheetId: "id-dashboard" },
      ]),
    ).toEqual({ sheetIndices: [0, 2], sheetIds: ["id-summary", "id-dashboard"] });
  });

  // SABOTAGE: send the ids of the rows that have one (a partial list) --
  // Rust takes ids in preference, so the id-less sheet would silently not ship.
  it("a row without an id sends positions only, so the backend refuses that sheet by name instead of dropping it", () => {
    expect(
      selectionWire([
        { index: 0, sheetId: "id-summary" },
        { index: 1, sheetId: "" },
      ]),
    ).toEqual({ sheetIndices: [0, 1] });
  });

  it("no rows is the explicit empty selection", () => {
    expect(selectionWire([])).toEqual({ sheetIndices: [], sheetIds: [] });
  });
});

describe("the Rust side of the contract", () => {
  // Each door's params struct declares the field, defaulted, with the type the
  // wire carries -- read from source so a renamed or dropped field turns this
  // red rather than leaving the dialog sending ids nobody reads.
  const STRUCTS: [string, string][] = [
    ["src-tauri/src/calp_commands.rs", "PublishParams"],
    ["src-tauri/src/calp_commands.rs", "PublishPreviewParams"],
    ["src-tauri/src/calp_diff.rs", "DiffWorkingCopyParams"],
  ];
  for (const [file, name] of STRUCTS) {
    it(`${name} reads sheet_ids (camelCase sheetIds), defaulted`, () => {
      const src = read(file);
      const m = src.match(new RegExp(`pub struct ${name} \\{([\\s\\S]*?)\\n\\}`));
      expect(m, `${name} moved out of ${file}`).toBeTruthy();
      expect(src.slice(0, m!.index)).toMatch(/#\[serde\(rename_all = "camelCase"\)\]\s*$/);
      expect(m![1]).toMatch(/#\[serde\(default\)\]\s*pub sheet_ids: Option<Vec<String>>,/);
    });
  }
});
