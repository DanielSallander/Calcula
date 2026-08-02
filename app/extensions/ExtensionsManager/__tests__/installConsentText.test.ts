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
 */
const AUTO_GRANTED: string[] = (() => {
  const found = new Set<string>();
  for (const m of WORKER_HOST.matchAll(/recordCapabilityGrant\([^,]+,\s*"([^"]+)"/g)) {
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

  it("the extension manager's own summary does not repeat the false promise", () => {
    // ExtensionManager.ts is @api/shell territory; this is a read-only check so
    // the two surfaces cannot drift apart silently. See the cross-file note.
    const flat = code(MANAGER).replace(/\s+/g, " ");
    const promisesJitForAll = /every (declared )?capability is asked for separately/i.test(flat);
    expect(promisesJitForAll).toBe(false);
  });
});
