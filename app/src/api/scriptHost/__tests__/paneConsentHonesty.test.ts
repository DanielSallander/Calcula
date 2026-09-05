//! FILENAME: app/src/api/scriptHost/__tests__/paneConsentHonesty.test.ts
// PURPOSE: `ui.pane` exists so that a MODELESS surface never rides on
//          `ui.dialog`'s promise — and every sentence written for it must say
//          what a pane is, with the bounds that make it safe to grant.
// CONTEXT: `ui.dialog`'s four user-facing sentences promise "a dialog you must
//          answer or close before continuing" (formConsentHonesty pins them). A
//          task pane stays open beside the grid for hours; a sentence softened
//          to cover both would be false for the modal, and a pane granted under
//          the modal's sentence would be a surface the user never consented to.
//          So: a NEW id, at the same index in both lists (the Rust mirror pins
//          ORDER, not membership), in all
//          nine exhaustive `Record<CapabilityId, …>` maps, NOT in
//          `RUST_MIRRORED_CAPABILITIES` (host-painted, no Rust gate) and asserted
//          non-grantable in Rust.
//
//          Mirror of formConsentHonesty.test.ts, with the NEGATIVE assertions
//          that file cannot make: no `ui.pane` sentence may borrow the modal's
//          words, and every prose sentence must carry the "while you work" bound.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ALL_CAPABILITY_IDS } from "../capabilityIds";
import { RUST_MIRRORED_CAPABILITIES, describeCapability } from "../capabilities";

// __tests__ -> scriptHost -> api -> src -> app: four levels, one more than the
// extension-side honesty tests this file mirrors.
const APP = path.resolve(__dirname, "../../../..");
const REPO = path.resolve(APP, "..");
const read = (rel: string): string => fs.readFileSync(path.join(APP, rel), "utf8");

/** The `"ui.pane": "…"` sentence in one map, or null if the map lacks it. */
function paneSentence(src: string): string | null {
  const m = /"ui\.pane":\s*"([^"]+)"/.exec(src);
  return m ? m[1] : null;
}

const PROSE_MAPS = [
  "extensions/Distribution/components/inspector/ScriptsSection.tsx",
  "extensions/Distribution/components/SubscribeDialog.tsx",
  "extensions/ScriptableObjects/index.ts",
];
const ICON_MAPS = [
  "extensions/Charts/components/ChartLibraryConsentDialog.tsx",
  "extensions/CustomFunctions/components/DistributedFunctionsConsentDialog.tsx",
  "extensions/ScriptableObjects/components/ScriptConsentDialog.tsx",
];
const LABEL_MAPS = [
  "extensions/ScriptableObjects/components/CodeInThisFilePanel.tsx",
  "extensions/Settings/components/ScriptSecurityPage.tsx",
];

describe("the id itself", () => {
  it("sits at the SAME INDEX as the Rust mirror — order is pinned, not membership", () => {
    // Was "is LAST". It stopped being last when `ui.htmlInput` was appended
    // (M6b), and "last" was never the property that mattered: the Rust array
    // pins ORDER, so what has to hold is that the two agree position for
    // position. `htmlInputConsentHonesty.test.ts` owns the "newest id is last"
    // assertion, which is where it belongs — on the newest id.
    expect(ALL_CAPABILITY_IDS.indexOf("ui.pane")).toBeGreaterThan(-1);
  });

  it("is NOT Rust-mirrored: a host-painted surface has no backend gate to grant", () => {
    expect(RUST_MIRRORED_CAPABILITIES.has("ui.pane" as never)).toBe(false);
  });

  it("is at the same index in the core Rust array, with the annotation matching", () => {
    const rs = fs.readFileSync(
      path.join(REPO, "core/persistence/src/lib.rs"),
      "utf8",
    );
    const m = /pub const KNOWN_CAPABILITY_IDS: \[&str; (\d+)\] = \[([\s\S]*?)\];/.exec(rs);
    expect(m, "KNOWN_CAPABILITY_IDS moved or was renamed").not.toBeNull();
    const ids = [...m![2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect(Number(m![1])).toBe(ids.length);
    expect(ids.length).toBe(ALL_CAPABILITY_IDS.length);
    // Position for position — the Rust array's order IS the contract, so a
    // reorder on either side has to fail here rather than only where the newest
    // id happens to sit.
    expect(ids).toEqual([...ALL_CAPABILITY_IDS]);
    expect(ids.indexOf("ui.pane")).toBe(ALL_CAPABILITY_IDS.indexOf("ui.pane"));
  });

  it("is asserted NON-grantable in Rust, beside ui.dialog and ui.html", () => {
    const rs = fs.readFileSync(
      path.join(REPO, "app/src-tauri/src/scripting/capability_store.rs"),
      "utf8",
    );
    expect(rs).toContain('assert!(!is_grantable("ui.pane"));');
  });
});

describe("what the prompts say about it", () => {
  it("CAP_DESCRIPTION names a pane you can keep open, never a dialog you must answer", () => {
    const s = describeCapability("ui.pane" as never);
    expect(s).toMatch(/task pane/);
    expect(s).toMatch(/while you work/);
    expect(s).not.toMatch(/must answer|before continuing|dialog/);
  });

  it.each(PROSE_MAPS)("%s carries a bounded, non-modal sentence", (file) => {
    const s = paneSentence(read(file));
    expect(s, "the map has no ui.pane entry").not.toBeNull();
    expect(s!).toMatch(/task pane/);
    expect(s!).toMatch(/while you work/);
    expect(s!).not.toMatch(/must answer|before continuing|dialog/);
  });

  it.each(ICON_MAPS)("%s has an icon glyph for it", (file) => {
    const s = paneSentence(read(file));
    expect(s).not.toBeNull();
    expect(s!.length).toBeGreaterThan(0);
  });

  it.each(LABEL_MAPS)("%s labels it as a task pane", (file) => {
    expect(paneSentence(read(file))).toBe("Task pane");
  });

  it("does not soften any ui.dialog sentence to cover a modeless surface", () => {
    // The modal's own honesty test pins these verbatim; this is the guard in
    // the other direction — a pane must not have been made to fit the old words.
    for (const file of PROSE_MAPS) {
      const src = read(file);
      const m = /"ui\.dialog":\s*"([^"]+)"/.exec(src);
      expect(m).not.toBeNull();
      expect(m![1]).not.toMatch(/pane/);
    }
  });
});
