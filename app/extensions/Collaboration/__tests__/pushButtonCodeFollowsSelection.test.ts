// FILENAME: app/extensions/Collaboration/__tests__/pushButtonCodeFollowsSelection.test.ts
// PURPOSE: Two review findings on the Publish dialog (2026-09-30):
//          1. The push readiness gated on a button-code review fetched for the
//             OPEN-TIME selection: unticking the sheet with refused code still
//             blocked the push, and ticking a sheet with new code showed nothing
//             to review until the backend refused. The review now follows the
//             tick list, and the push waits while it is being fetched again.
//          2. The stale-push banner named whoever the UNSIGNED version listing
//             said published the head -- a share-writer can type a colleague's
//             name there. It now names the head's SIGNER, from its verified
//             manifest, or nobody.
// CONTEXT: Source-text assertions for the wiring, the house style for this
//          dialog (see pushButtonAnswers.test.ts: mounting it talks to Tauri on
//          every render), plus the pure readiness rule by behaviour.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { pushBlockingReason, type PushReadinessInput } from "../lib/pushReadiness";
import { sheetsSignature } from "../components/PublishDialog";

const APP_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP_ROOT, rel), "utf8");
/** Comments quote the defects they removed, so scanners must not read them. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const CODE = code(read("extensions/Collaboration/components/PublishDialog.tsx"));

const ready: PushReadinessInput = {
  mode: "push",
  registryPath: "\\\\server\\reports",
  packageName: "sales",
  version: "1.0.1",
  changeSummary: "a change",
  pushed: false,
  sheetsSelected: 1,
  sheetsAvailable: 2,
  kind: "report",
  nameAlreadyTaken: false,
  buttonCodeRefused: 0,
  buttonCodeUnacknowledged: 0,
};

describe("the push waits for the button code of the sheets actually ticked", () => {
  // SABOTAGE: drop the `buttonCodeStale` rule from pushBlockingReason.
  it("a review for another selection blocks the push, and says what to do", () => {
    expect(pushBlockingReason(ready)).toBeNull();
    const why = pushBlockingReason({ ...ready, buttonCodeStale: true });
    expect(why).toMatch(/Checking the button code for the sheets you ticked/);
    expect(why).toMatch(/press Preview/);
    // Stale counts are not trusted in EITHER direction: a refusal counted for a
    // sheet no longer ticked must not show as the reason.
    expect(pushBlockingReason({ ...ready, buttonCodeStale: true, buttonCodeRefused: 3 })).toMatch(/Checking/);
  });

  it("a selection is compared order-insensitively", () => {
    expect(sheetsSignature([2, 0, 1])).toBe(sheetsSignature([0, 1, 2]));
    expect(sheetsSignature([0, 1])).not.toBe(sheetsSignature([0, 2]));
  });

  // SABOTAGE: delete the `buttonCodeStale:` line from the dialog's readiness
  // call, or the effect that re-fetches on `sheetSelection`.
  it("the dialog marks its review stale for another selection and fetches it again", () => {
    expect(CODE).toMatch(
      /buttonCodeStale:\s*mode !== "loading" &&\s*availableSheets\.length > 0 &&\s*buttonCodeFor !== sheetsSignature\(selectedIndices\(\)\)/,
    );
    // The refresh: an effect keyed on the tick list that asks the preview for
    // the ticked sheets and records which selection the answer belongs to.
    const effect = CODE.match(
      /useEffect\(\(\) => \{\s*if \(mode === "loading" \|\| availableSheets\.length === 0\) return;([\s\S]*?)\}, \[([^\]]*)\]\);/,
    );
    expect(effect, "the button-code refresh effect is gone").toBeTruthy();
    const [, body, deps] = effect!;
    expect(body).toContain("publishPreview(");
    expect(body).toContain("setButtonCode(result.report.buttonCode ?? null);");
    expect(body).toContain("setButtonCodeFor(signature);");
    expect(deps).toContain("sheetSelection");
    expect(deps).toContain("buttonCodeFor");
  });

  it("a push refused over button code fetches the review again", () => {
    const handler = CODE.match(/const handlePublish = async \(\) => \{([\s\S]*?)\n  \};/);
    expect(handler, "handlePublish moved").toBeTruthy();
    expect(handler![1]).toMatch(
      /CALP_PUSH_\(BUTTON_CODE_UNREVIEWED\|HELD_CODE_UNVERIFIED\)[\s\S]*?setButtonCodeFor\(null\)/,
    );
  });
});

describe("the stale-push banner names the head's SIGNER, never the listing's name", () => {
  // SABOTAGE: restore `merge?.headPublishedBy || gates?.latestPublishedBy` in
  // the banner.
  it("reads the signer from the verified merge analysis and nothing else", () => {
    expect(CODE).not.toContain("headPublishedBy");
    expect(CODE).not.toContain("gates?.latestPublishedBy");
    expect(CODE).toContain("const signer = merge?.headSigner;");
    expect(CODE).toMatch(/signed by \$\{signer\.name \|\| "an unnamed publisher"\} \(key \$\{signer\.fingerprint\}\)/);
  });

  it("the wire type carries the signer, not the unsigned name", () => {
    const api = code(read("src/api/collaboration.ts"));
    const m = api.match(/export interface MergeAnalysisResponse \{([\s\S]*?)\n\}/);
    expect(m, "MergeAnalysisResponse moved").toBeTruthy();
    expect(m![1]).toMatch(/headSigner: CheckoutSigner;/);
    expect(m![1]).not.toMatch(/headPublishedBy/);
    // ...and Rust sends exactly that field (camelCase of `head_signer`).
    const rust = read("src-tauri/src/calp_merge.rs");
    const r = rust.match(/pub struct MergeAnalysisResponse \{([\s\S]*?)\n\}/);
    expect(r![1]).toMatch(/pub head_signer: crate::calp_commands::CheckoutSignerInfo,/);
    expect(r![1]).not.toMatch(/head_published_by/);
  });
});
