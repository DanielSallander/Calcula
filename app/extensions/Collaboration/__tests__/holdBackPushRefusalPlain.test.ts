// The hold-back hands back the push resolver's refusals unchanged; every
// CALP_PUSH_ code (CALP_PUSH_SHEET_WITHOUT_ID included) is said in plain words
// with no Ctrl+Z hint, because nothing was written (round 12 review).
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(resolve(__dirname, "../components/PublishDialog.tsx"), "utf8");

describe("the hold-back's selection refusals", () => {
  it("routes every CALP_PUSH_ refusal through the plain-sentence path", () => {
    const at = src.indexOf("THE PUSH'S OWN SELECTION IS PART OF THIS REQUEST");
    expect(at).toBeGreaterThan(0);
    const branch = src.slice(at, src.indexOf("explainPushError(e)", at));
    expect(branch).toContain("/\bCALP_PUSH_[A-Z_]+:/.test(String(e))");
  });
});
