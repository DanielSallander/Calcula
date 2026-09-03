//! FILENAME: app/extensions/ScriptNotebook/__tests__/distributedNotebookRefusalHonesty.test.ts
// PURPOSE: The refusal a distributed notebook shows must state the rule that
//          actually applies, not name an approval nobody can give.
// CONTEXT: `distributed_notebook_refusal`
//          (app/src-tauri/src/scripting/notebook_commands.rs) told the user
//          "you have not approved that application's code, so its cells will not
//          run". On every OTHER distributed surface that sentence is true and
//          actionable — a consent screen exists that settles it. For a notebook
//          it is not: the read-only delivery is DELIBERATE (pull strips the
//          execution metadata; the design says a publisher's analysis arrives to
//          be read), and no surface anywhere writes a `notebook:{id}:{cell}` id
//          into the consent store, so nothing the user can press will ever
//          satisfy that check.
//
//          The fix is deliberately the CHEAP HONEST HALF and nothing more: no
//          notebook consent path is added, the consent branch in the gate is
//          left exactly as it was, and only the WORDS change so they describe
//          the rule the product really implements. Naming a nonexistent approval
//          sends the user hunting for a button that is not there — the same
//          class of defect as a consent screen that understates reach, and it is
//          why this file sits beside the other honesty guards.
//
//          Pinned Rust -> TypeScript, the direction CLAUDE.md fixes: the message
//          is produced in Rust and every renderer just displays it.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const NOTEBOOK_COMMANDS = path.join(
  REPO_ROOT,
  "app/src-tauri/src/scripting/notebook_commands.rs",
);
const SRC = fs.readFileSync(NOTEBOOK_COMMANDS, "utf8");

/**
 * Strip comments before matching.
 *
 * Load-bearing in both directions here. The comment beside the corrected
 * message QUOTES the sentence that was removed, so an un-stripped scan fails on
 * the very file that was fixed (consentTextHonesty.test.ts and
 * macroConsentTriggerHonesty.test.ts both record this trap); and the positive
 * control below asserts the quote is still there, which only means something if
 * the stripper really removed it from the scanned text.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Join Rust's line-continuations before flattening whitespace.
 *
 * A long `format!` literal is wrapped with a trailing `\` and re-indented, so
 * the message only exists as one string once those are removed. Flattening alone
 * leaves the backslashes standing in the middle of the sentence, and every
 * assertion below would be matching text the user never sees.
 */
const CODE = code(SRC)
  .replace(/\\\r?\n\s*/g, "")
  .replace(/\s+/g, " ");

describe("the refusal does not promise an approval the product cannot give", () => {
  it("no surface writes a notebook consent id — the approval genuinely does not exist", () => {
    // The premise, established from the code rather than asserted. The id
    // builder is referenced only by the gate that READS it (and by that gate's
    // own tests); there is no writer, in Rust or in TypeScript.
    const builder = "notebook_consent_script_id";
    const gateHalf = SRC.slice(0, SRC.indexOf("#[cfg(test)]"));
    const uses = [...gateHalf.matchAll(new RegExp(builder, "g"))];
    expect(uses.length, "the id builder should exist").toBeGreaterThan(0);
    // Every non-test use is the definition or the READ inside the refusal.
    expect(gateHalf).toContain(`pub(crate) fn ${builder}(`);
    expect(gateHalf).toContain(`let consent_id = ${builder}(notebook_id, cell_id);`);

    // ...and nothing on the TypeScript side builds one either: the consent
    // record's artifact ids come from the object-script and module stores only.
    const consentSet = fs.readFileSync(
      path.join(
        REPO_ROOT,
        "app/extensions/ScriptableObjects/lib/packageConsentSet.ts",
      ),
      "utf8",
    );
    expect(consentSet).not.toContain("notebook:");
  });

  it("the message no longer says the code has 'not been approved'", () => {
    expect(
      CODE,
      "that phrasing describes a pending decision, and there is no screen that " +
        "can settle it for a notebook — the user is sent hunting for a button " +
        "that does not exist",
    ).not.toContain("you have not approved that application's code");
  });

  it("...and the removed sentence is still quoted in the comment that explains why", () => {
    // The positive control for the stripper. Without it the assertion above
    // could pass because the scan never saw the message at all.
    expect(SRC).toContain("you have not approved that application's code");
  });

  it("states the real rule: delivered to be read, with no way to approve one", () => {
    expect(CODE).toContain("Notebooks from an application are delivered to be read, not run");
    expect(CODE).toContain("Calcula has no way to approve one");
  });

  it("still names the sanctioned alternative, so the user is not left stuck", () => {
    expect(CODE).toContain(
      "copy the ones you want into a notebook of your own to run them.",
    );
  });

  it("the read-only refusal itself is untouched — no consent path was added", () => {
    // The finding this file answers was explicitly NOT "add notebook consent".
    // The gate still fails closed on a stamped notebook, and the consent branch
    // it already had is still the only way past it.
    expect(CODE).toContain("let package = source_package.map(str::trim).filter(|p| !p.is_empty())?;");
    expect(CODE).toContain(
      "if crate::calp_commands::consent_granted_in(file, package, &consent_id, &source_hash) {",
    );
  });
});
