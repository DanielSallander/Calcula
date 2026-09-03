//! FILENAME: app/src/api/scriptHost/__tests__/formUnmountSweep.test.ts
// PURPOSE: Source-reading guard: every way a script ends must close its form.
// CONTEXT: hostUnmountScript is the ONE debt sweep (explicit unmount, both
//          crash paths, debugger stop) and hostResetAll the workbook-swap
//          version. A form that outlived its script would sit on screen asking
//          on behalf of code that no longer exists, holding the app-wide modal
//          slot until its deadline. The same shape previewSafety.test.ts uses:
//          the presence of a CALL is asserted in the function body, so the
//          sweep cannot be quietly dropped in a refactor.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const host = readFileSync(resolve(__dirname, "../host.ts"), "utf8");

/** The brace-matched body of the function whose header line starts with `signature`. */
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error(`${signature} not found in host.ts`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

/** Strip line comments so a commented-out call cannot satisfy an assertion. */
function codeOnly(body: string): string {
  return body
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

describe("form sessions are swept on every way a script ends", () => {
  const unmount = codeOnly(functionBody(host, "export function hostUnmountScript("));
  const reset = codeOnly(functionBody(host, "export function hostResetAll("));

  it("reads real function bodies, so the assertions below cannot pass vacuously", () => {
    expect(unmount.length).toBeGreaterThan(800);
    expect(unmount).toContain("revokeScriptDialogs(scriptId)");
    expect(reset).toContain("resetScriptDialogs()");
  });

  it("hostUnmountScript closes the script's open form and forgets its layout", () => {
    expect(unmount).toContain("revokeScriptForms(scriptId)");
  });

  it("hostResetAll forgets every form session and layout", () => {
    expect(reset).toContain("resetScriptForms()");
  });

  it("every form row has its executeImpl case (the allowlistCoverage half-pattern)", () => {
    const impl = codeOnly(functionBody(host, "async function executeImpl("));
    for (const method of ["form.define", "form.show", "form.update", "form.close"]) {
      expect(impl, method).toContain(`case "${method}":`);
    }
  });

  it("the debugger's resume cannot restart the relay clock under an open form", () => {
    const resume = codeOnly(functionBody(host, "function resumeMethodCallDeadlines("));
    expect(resume).toContain("formHolds");
  });

  /**
   * THE SWEEP RUNS INSIDE THE UNMOUNT, NOT AFTER IT.
   *
   * `hostUnmountScript` terminates the realm, then closes the script's forms,
   * and only clears the `mounted` map at the very end. So a "is this script
   * still mounted?" test answers TRUE while the realm is already dead, and the
   * relay guard that used to ask it never fired: the answer was posted into a
   * terminated worker, parking a call its own 30 s deadline later rejected.
   * The flag set beside `terminate()` is the fact; the map is bookkeeping.
   */
  it("the answer relay asks the REALM whether it is alive, not the mounted map", () => {
    expect(unmount).toContain("mw.terminated = true;");
    expect(unmount).toContain("mw.worker.terminate();");
    // ...and it is set BEFORE the form sweep that will try to deliver.
    expect(unmount.indexOf("mw.terminated = true;")).toBeLessThan(unmount.indexOf("revokeScriptForms(scriptId)"));
    // ...which is itself before the map is cleared, which is the whole reason
    // the map cannot be the test.
    expect(unmount.indexOf("revokeScriptForms(scriptId)")).toBeLessThan(unmount.indexOf("mounted.delete(scriptId)"));

    const relay = codeOnly(functionBody(host, "function relayFormClosed("));
    expect(relay).toContain("mw.terminated");
  });
});
