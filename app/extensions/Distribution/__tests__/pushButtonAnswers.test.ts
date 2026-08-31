// FILENAME: app/extensions/Distribution/__tests__/pushButtonAnswers.test.ts
// PURPOSE: The primary action of the Publish dialog must answer every click.
// CONTEXT: `pushReadiness.test.ts` pins the REASONS. This pins the WIRING, which
//          is where the reported bug actually lived: the reason existed as a
//          boolean and was spent on `disabled`, so the button went dead and the
//          user got nothing — no error, no status, no movement. Rewriting the
//          message does not help if the click never runs.
//
//          Source-text assertions, deliberately: the failure mode is a JSX prop,
//          not a pure function, and the alternative is mounting a dialog that
//          talks to Tauri on every render.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const APP_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP_ROOT, rel), "utf8");

const DIALOG = read("extensions/Distribution/components/PublishDialog.tsx");
/** Comments quote the defect they removed, so scanners must not read them. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const CODE = code(DIALOG);

describe("the Push button answers every click", () => {
  it("is never disabled for a merely incomplete form", () => {
    // The exact shape that shipped the bug. `disabled` may still express
    // "already pushed" — that is a receipt, not an unmet requirement.
    expect(CODE).not.toMatch(/disabled=\{\s*!canPush\s*\}/);
    expect(CODE).not.toMatch(/disabled=\{\s*!\s*blocked/);
  });

  it("validates inside the click handler, so a blocked click still reports", () => {
    const handler = CODE.match(/const handlePublish = async \(\) => \{([\s\S]*?)\n  \};/);
    expect(handler, "handlePublish moved or was renamed").toBeTruthy();
    const body = handler![1];
    // It must consult the reason and surface it BEFORE attempting a publish.
    const guardAt = body.search(/blockingReason\(\)/);
    const publishAt = body.search(/publishApplication\(/);
    expect(guardAt, "handlePublish no longer asks why it is blocked").toBeGreaterThanOrEqual(0);
    expect(publishAt).toBeGreaterThanOrEqual(0);
    expect(guardAt, "the guard must run before the publish call").toBeLessThan(publishAt);
    expect(body).toMatch(/setError\(/);
  });

  it("shows the reason without waiting to be clicked", () => {
    expect(CODE).toMatch(/\(error \|\| status \|\| \(blocked && !pushed\)\)/);
  });

  it("puts the answer OUTSIDE the scrolling body, next to the button", () => {
    // The error and status used to render inside the scroll region of a dialog
    // tall enough to need scrolling, so pressing Push with the sheet list in
    // view put the reply above the fold — indistinguishable from silence.
    const bodyStart = CODE.indexOf("<div style={bodyStyle}>");
    const strip = CODE.indexOf("(error || status || (blocked && !pushed))");
    const footer = CODE.indexOf("<div style={footerStyle}>");
    expect(bodyStart, "bodyStyle block moved").toBeGreaterThanOrEqual(0);
    expect(strip, "the answer strip is gone").toBeGreaterThanOrEqual(0);
    expect(footer, "footerStyle block moved").toBeGreaterThanOrEqual(0);
    // Between the body and the footer means pinned, not scrolled.
    expect(strip).toBeGreaterThan(bodyStart);
    expect(strip).toBeLessThan(footer);
    // And `flexShrink: 0`, or the flex column will collapse it away.
    const region = CODE.slice(strip, footer);
    expect(region).toMatch(/flexShrink:\s*0/);
  });

  it("marks the required summary as empty rather than letting a placeholder pass for a value", () => {
    // The placeholder is a complete sentence. Something on the control itself
    // has to distinguish "example" from "typed".
    expect(CODE).toMatch(/mode === "push" && changeSummary\.trim\(\) === ""/);
    // ...and the placeholder says it is an example.
    expect(CODE).toMatch(/placeholder="e\.g\. /);
  });

  it("never claims a preview that the current selection has invalidated", () => {
    // The report names the sheets it would ship; moving a checkbox makes it
    // describe a publish nobody is about to perform. Overstating what leaves
    // the machine is the worst direction for this panel to be wrong in.
    expect(CODE).toMatch(/reportFor !== null && reportFor !== previewSignature\(\)/);
    expect(DIALOG).toMatch(/Out of date — the sheet selection changed/);
  });
});
