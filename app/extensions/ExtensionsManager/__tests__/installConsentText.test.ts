//! FILENAME: app/extensions/ExtensionsManager/__tests__/installConsentText.test.ts
// PURPOSE: The install screen must not promise a just-in-time prompt for
//          capabilities that installing already grants.
// CONTEXT: InstallAddInDialog told the user "Each one is still asked for
//          separately the first time it is actually used" about EVERY declared
//          capability. That is only true of the ones an add-in reaches through
//          a `cap.*` broker call, where `maybeRequestCapabilityGrant` runs.
//          `grid.read` and `formula.udf` are consumed by contributions the HOST
//          calls into the add-in, so the host grants them outright at
//          registration (`recordCapabilityGrant`) with no prompt ever. Install
//          IS the consent for those two, and the install screen is the last
//          place it can be said.
//
//          The auto-granted set is DERIVED from extensionWorkerHost.ts rather
//          than restated here, so a third capability joining it fails this test
//          instead of quietly re-creating the false promise.

import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";
// The one sentence about the door no contribution declares (`ext.executeCommand`).
// Imported, because asserting the TEXT here would recreate the copy that let the
// same false claim ship on two consent surfaces at once.
import { EXTENSION_BUILTIN_ACTION_REACH_NOTE } from "../../../src/api/scriptHost/extensionProtocol";

const APP_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP_ROOT, rel), "utf8");

/** Strip block comments: the comment explaining the fix quotes the old claim. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "");

const WORKER_HOST = read("src/api/scriptHost/extensionWorkerHost.ts");
const DIALOG = code(read("extensions/ExtensionsManager/InstallAddInDialog.tsx"));
const MANAGER = read("src/shell/registries/ExtensionManager.ts");

/**
 * Capabilities the worker host grants to an add-in without any user prompt:
 * every `recordCapabilityGrant(..., "<literal>")` call site. The two dynamic
 * call sites inside `maybeRequestCapabilityGrant` pass a variable, so they do
 * not match — which is exactly right: those ARE the prompted ones.
 *
 * `recordCapabilityGrantUnlessRevoked` and `recordCapabilityGrantAtInstall`
 * count too, and must: both are the SAME install-time grant with no prompt —
 * the first one only adds that a later revoke can withhold it, the second that
 * it is scoped to the MOUNT rather than to the workbook (an add-in survives
 * File > Open, and no prompt exists that could give the capability back).
 * Reading just the base name would have quietly emptied this set the day the
 * three grid.read doors moved onto it, and an emptied set makes every check
 * below vacuous rather than red.
 */
const AUTO_GRANTED: string[] = (() => {
  const found = new Set<string>();
  for (const m of WORKER_HOST.matchAll(
    /recordCapabilityGrant(?:UnlessRevoked|AtInstall)?\([^,]+,\s*"([^"]+)"/g,
  )) {
    found.add(m[1]);
  }
  return [...found].sort();
})();

describe("InstallAddInDialog capability promise", () => {
  it("finds the capabilities the host grants at load with no prompt", () => {
    expect(AUTO_GRANTED).toEqual(["formula.udf", "grid.read"]);
  });

  it("no longer claims every capability is asked for separately", () => {
    expect(DIALOG).not.toContain("Each one is still asked for separately");
  });

  it("names each install-time grant and says installing is the consent", () => {
    const flat = DIALOG.replace(/\s+/g, " ");
    for (const cap of AUTO_GRANTED) {
      expect(flat, `${cap} is auto-granted but not named on the install screen`).toContain(cap);
    }
    expect(flat).toMatch(/granted by installing/);
    expect(flat).toMatch(/as soon as the add-in loads/);
  });

  it("still promises the JIT prompt for the capabilities that do get one", () => {
    const flat = DIALOG.replace(/\s+/g, " ");
    expect(flat).toMatch(/asked for separately the first time they are actually used/);
    // ...and the code that backs that promise is still there.
    expect(WORKER_HOST).toContain("maybeRequestCapabilityGrant");
  });

  it("discloses the built-in actions any add-in can run, and no longer denies them", () => {
    // THE DEFECT. The forms sentence on this screen ended "...so nothing you do
    // in one of its forms is ever written into your workbook" — read before any
    // code runs, and false: a form's button relays into the add-in's own
    // handler, which can call `ext.executeCommand` (no capability, gated only by
    // CommandRegistry.isScriptSafe) and run CLEAR_ALL, DELETE_ROW, FILL_DOWN or
    // any command a feature opted in. The narrow claim survives; the absolute
    // one is gone and the door is disclosed instead.
    const flat = DIALOG.replace(/\s+/g, " ");
    expect(flat).not.toMatch(/nothing you do in one of its forms is ever written/i);
    expect(flat).toMatch(/never writes that cell back/i);
    // Rendered from the SHARED constant, not hand-copied: the per-kind
    // sentences on this screen are copies of CONTRIBUTION_REACH_NOTE, and that
    // is precisely how the two surfaces made the same false claim twice.
    expect(flat).toContain("{EXTENSION_BUILTIN_ACTION_REACH_NOTE}");
    expect(EXTENSION_BUILTIN_ACTION_REACH_NOTE).toMatch(/CHANGE your workbook/);
    // UNCONDITIONAL. An add-in that declares NOTHING still holds this door, so
    // the note must not sit inside either arm of the contributions ternary —
    // the arm that renders a list would hide it from exactly the add-in whose
    // consent screen says "Nothing in your menus, ribbon, shortcuts or
    // formulas.". Checked structurally (outside the ternary's span) rather than
    // as "last thing in the section", so moving it to the top of the section
    // stays legal; only putting it inside a branch is a defect.
    const sectionStart = DIALOG.indexOf('<Section title="What it will add to Calcula">');
    const sectionEnd = DIALOG.indexOf("</Section>", sectionStart);
    expect(sectionStart, "the contributions section must still exist").toBeGreaterThan(-1);
    const section = DIALOG.slice(sectionStart, sectionEnd);
    const ternaryOpen = section.indexOf("report.contributions.length === 0 ? (");
    const ternaryClose = section.lastIndexOf(")}");
    const noteRender = section.indexOf("{EXTENSION_BUILTIN_ACTION_REACH_NOTE}");
    expect(ternaryOpen, "the contributions ternary must still exist").toBeGreaterThan(-1);
    expect(noteRender, "the note must render inside this section").toBeGreaterThan(-1);
    expect(
      noteRender < ternaryOpen || noteRender > ternaryClose,
      "the note renders inside the contributions ternary, so an add-in that declares nothing would not see it",
    ).toBe(true);
  });

  it("the extension manager's own summary does not repeat the false promise", () => {
    // ExtensionManager.ts is @api/shell territory; this is a read-only check so
    // the two surfaces cannot drift apart silently. See the cross-file note.
    const flat = code(MANAGER).replace(/\s+/g, " ");
    const promisesJitForAll = /every (declared )?capability is asked for separately/i.test(flat);
    expect(promisesJitForAll).toBe(false);
  });
});
