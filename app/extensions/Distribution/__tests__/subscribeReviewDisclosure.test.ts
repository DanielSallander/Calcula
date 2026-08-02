//! FILENAME: app/extensions/Distribution/__tests__/subscribeReviewDisclosure.test.ts
// PURPOSE: The pre-pull Subscribe review must disclose every KIND of code a
//          package carries, and describe each capability truthfully.
// CONTEXT: Three defects, one screen:
//
//          1. `inspect_package` returns `module_scripts` and `notebooks`
//             (calp_commands.rs::PackageInspection) and the review rendered
//             NEITHER — only `scripts`. A reviewer reading "Scripts (2)" had no
//             way to learn the package also shipped a formula-function library
//             that runs whenever a cell calls it.
//          2. `storage` was phrased "store data on this device". The store is
//             the workbook's own virtual filesystem, so it travels inside the
//             .cala to whoever the file is sent to — the opposite of the
//             reassurance "on this device" gives.
//          3. The writeback-validator pane claimed the validator runs "with no
//             access to your data". It is handed the row, column and value of
//             every answer it checks, which IS the user's data.
//
//          The set of code kinds is DERIVED from the Rust struct, so the day
//          `PackageInspection` grows another one this test names it instead of
//          the review silently omitting it.

import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";

const APP_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP_ROOT, rel), "utf8");
/**
 * Strip comments before matching. The comments explaining each of these fixes
 * QUOTE the false claim they removed, so a scanner that reads comments reports
 * the opposite of the truth — it fails on precisely the file that was fixed.
 * (`[^:]` keeps `https://` out of the line-comment rule.)
 */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const CALP_RS = read("src-tauri/src/calp_commands.rs");
const SUBSCRIBE = code(read("extensions/Distribution/components/SubscribeDialog.tsx"));
const SCRIPTS_SECTION = code(read("extensions/Distribution/components/inspector/ScriptsSection.tsx"));
const WRITEBACK_PANE = code(read("extensions/Distribution/components/WritebackPane.tsx"));

/** The `pub struct PackageInspection { ... }` body, read out of the Rust source. */
const INSPECTION_STRUCT: string = (() => {
  const m = CALP_RS.match(/pub struct PackageInspection \{([\s\S]*?)\n\}/);
  expect(m, "PackageInspection moved or was renamed").toBeTruthy();
  return m![1];
})();

describe("Subscribe review discloses every kind of code in the package", () => {
  it("the backend really does report module scripts and notebooks", () => {
    expect(INSPECTION_STRUCT).toMatch(/pub module_scripts:\s*Vec<InspectedModuleScript>/);
    expect(INSPECTION_STRUCT).toMatch(/pub notebooks:\s*Vec<InspectedNotebook>/);
  });

  it("renders the module scripts the package carries", () => {
    expect(SUBSCRIBE).toContain("inspection.moduleScripts");
    const flat = SUBSCRIBE.replace(/\s+/g, " ");
    expect(flat).toContain("Module scripts (");
    // They must be labelled as code AND as inert on arrival — both, because
    // either half alone misleads.
    expect(flat).toMatch(/executable code/);
    expect(flat).toMatch(/arrive switched off: subscribing stores them, it does not run them/);
  });

  it("renders the notebooks the package carries", () => {
    expect(SUBSCRIBE).toContain("inspection.notebooks");
    const flat = SUBSCRIBE.replace(/\s+/g, " ");
    expect(flat).toContain("Notebooks (");
    expect(flat).toMatch(/nothing in them runs on its own/);
  });

  it("calls out the custom formula-function library for what it is", () => {
    // The reserved record's ID, as @api/customFunctions.ts persists it.
    const CUSTOM_FNS = read("src/api/customFunctions.ts");
    expect(CUSTOM_FNS).toContain('"__calcula_custom_functions__"');
    expect(SUBSCRIBE).toContain('"__calcula_custom_functions__"');
    const flat = SUBSCRIBE.replace(/\s+/g, " ");
    expect(flat).toMatch(/Custom formula functions — run whenever a cell uses them/);
    expect(flat).toMatch(/approve them separately/);
  });

  it("recognises that library by ID, not by its display name", () => {
    // A publisher chooses the display name and can therefore both wear this
    // label falsely and shed it by renaming; the id is assigned by Calcula.
    // The first version of this check matched on "Custom Functions (data)".
    expect(SUBSCRIBE).toMatch(/isCustomFunctionLibrary\(m\.id\)/);
    expect(SUBSCRIBE).not.toContain('"Custom Functions (data)"');
  });

  it("...and the backend actually sends that id", () => {
    // The id can only be matched if it crosses the wire: `InspectedModuleScript`
    // dropped `PublishedModuleScript::id` for its first three waves, which is
    // exactly why the name check existed.
    const struct = CALP_RS.match(/pub struct InspectedModuleScript \{([\s\S]*?)\n\}/);
    expect(struct, "InspectedModuleScript moved or was renamed").toBeTruthy();
    expect(struct![1]).toMatch(/pub id: String/);
    expect(CALP_RS).toMatch(/InspectedModuleScript \{\s*(?:\/\/[^\n]*\n\s*)*id: m\.id\.clone\(\)/);
    // ...and that the TS mirror declares it, so the dialog can read it.
    const DIST_TS = read("src/api/distribution.ts");
    const iface = DIST_TS.match(/export interface InspectedModuleScript \{([\s\S]*?)\n\}/);
    expect(iface, "InspectedModuleScript mirror moved or was renamed").toBeTruthy();
    expect(iface![1]).toMatch(/^\s*id: string;$/m);
  });
});

describe("capability phrases tell the truth about where storage lives", () => {
  const PHRASE =
    "store its own private data inside this workbook file (256 KB; it travels with the file if you share it)";

  it("no surface still says storage is on this device", () => {
    expect(SUBSCRIBE).not.toContain("store data on this device");
    expect(SCRIPTS_SECTION).not.toContain("store data on this device");
  });

  it("the Subscribe review and the package inspector use the identical phrase", () => {
    expect(SUBSCRIBE).toContain(PHRASE);
    expect(SCRIPTS_SECTION).toContain(PHRASE);
  });

  it("the quota it quotes is the quota the host enforces", () => {
    const HOST = read("src/api/scriptHost/host.ts");
    const quota = HOST.match(/SCRIPT_STORAGE_QUOTA_BYTES\s*=\s*([0-9_]+)/);
    expect(quota, "SCRIPT_STORAGE_QUOTA_BYTES moved or was renamed").toBeTruthy();
    expect(Number(quota![1].replace(/_/g, ""))).toBe(256 * 1024);
  });
});

describe("the writeback validator pane describes what the validator sees", () => {
  it("no longer claims the validator has no access to your data", () => {
    expect(WRITEBACK_PANE).not.toContain("no\n        access to your data");
    expect(WRITEBACK_PANE.replace(/\s+/g, " ")).not.toContain("with no access to your data");
  });

  it("says it sees the answers it checks and nothing else", () => {
    const flat = WRITEBACK_PANE.replace(/\s+/g, " ");
    expect(flat).toContain(
      "It sees only the answers it checks — never the rest of your workbook, the network, or your files.",
    );
  });

  it("...which is what the Rust gate actually hands it", () => {
    // `ValidatorInput` is the whole of the per-value payload: row, col, value.
    const input = CALP_RS.match(/struct ValidatorInput \{([\s\S]*?)\n\}/);
    expect(input, "ValidatorInput moved or was renamed").toBeTruthy();
    const fields = [...input![1].matchAll(/^\s*(?:pub )?([a-z_]+):/gm)].map((m) => m[1]).sort();
    expect(fields).toEqual(["col", "row", "value"]);
  });
});
