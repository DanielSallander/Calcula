//! FILENAME: app/extensions/BuiltIn/CellBookmarks/__tests__/viewBookmarkScriptPicker.test.ts
// PURPOSE: The two view-bookmark overlays let a user wire a bookmark to a
//          script MODULE, and a module that arrived in a `.calp` must be shown
//          as one — the same way every other module picker shows it.
// CONTEXT: Both overlays declared a private `ScriptSummary { id; name }` that
//          dropped the `sourcePackage` `list_scripts` already carries, and
//          rendered `<option>{s.name}</option>`. Two modules named "Report"
//          from two applications were two identical options, and nothing said
//          the bookmark would run publisher code. The button picker, the
//          properties-pane select and the OnSelect autocomplete had all been
//          fixed to label and describe provenance through
//          `_shared/lib/scriptModuleProvenance.ts`; these two were missed.
//
//          Pinned at the SOURCE: the overlays are React components over a
//          backend door, and what matters is that they route through the ONE
//          labeller and the ONE describer every other picker uses — a second
//          spelling here is how they drifted in the first place.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const HERE = path.resolve(__dirname, "..", "components");
const read = (name: string): string => fs.readFileSync(path.join(HERE, name), "utf8");

const OVERLAYS = ["ViewBookmarkCreateOverlay.tsx", "ViewBookmarkEditOverlay.tsx"] as const;

describe.each(OVERLAYS)("%s", (file) => {
  const src = read(file);

  it("keeps the application stamp `list_scripts` hands it", () => {
    expect(src).toContain("sourcePackage?: string | null;");
  });

  it("labels every option through the shared labeller, never by bare name", () => {
    expect(src).toContain("{scriptPickerLabel(s)}");
    expect(src).not.toContain("{s.name}\n");
  });

  it("says out loud, through the shared describer, when the chosen module is a publisher's", () => {
    expect(src).toContain("describeDistributedScriptChoice(chosen)");
    expect(src).toContain("data-bookmark-script-provenance");
  });

  it("imports both from the one shared module, not a local copy", () => {
    expect(src).toContain('from "../../../_shared/lib/scriptModuleProvenance"');
  });
});
