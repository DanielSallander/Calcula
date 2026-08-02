//! FILENAME: app/extensions/Settings/__tests__/skinTrustPresentation.test.ts
// PURPOSE: Every org-skin trust state the Rust side can emit must have a row in
//          the Appearance panel, and `notPinned` must never read as verified.
// CONTEXT: `skin_pull` used to collapse `TrustStatus::Verified | FirstUse` into
//          one `SkinTrust::Verified`, with the comment "managed installs pre-pin
//          the org key so this is Verified in practice". A first-contact SQUAT
//          therefore rendered in the Appearance panel as a green "verified"
//          badge — and this path runs at APP LAUNCH, before any user
//          interaction, so nobody was ever asked anything.
//
//          Wave J splits the states apart, runs the org pull under
//          `PinPolicy::RequirePinned` (only the administrator's `publisherKey`
//          may seed the pin), and surfaces an incomplete policy.json instead of
//          silently applying no skin. This test holds the presentation half of
//          that in place — a security state with no label reads as benign.
//
//          Source-text assertions, same technique as
//          Distribution/__tests__/calpTrustPresentation.test.ts.

import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";

const APP_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP_ROOT, rel), "utf8");

const MANAGED_RS = read("src-tauri/src/managed_policy.rs");
const SKIN_PACK_RS = read("../core/calp/src/skin_pack.rs");
const POLICY_TS = read("src/api/appearancePolicy.ts");
const PAGE = read("extensions/Settings/components/AppearancePage.tsx");

/** The wire strings `managed_policy::trust_str` can emit. */
const RUST_STATUSES: string[] = (() => {
  const fn = MANAGED_RS.match(/fn trust_str\(t: SkinTrust\) -> String \{[\s\S]*?\n\}/);
  expect(fn, "trust_str moved or was renamed").toBeTruthy();
  const out = [...fn![0].matchAll(/SkinTrust::\w+ => "([^"]+)"/g)].map((m) => m[1]);
  expect(out.length, "no statuses parsed out of trust_str").toBeGreaterThan(0);
  return out;
})();

describe("org skin trust states", () => {
  it("no longer collapses a first-contact key into 'verified'", () => {
    // The precise defect: `TrustStatus::Verified | TrustStatus::FirstUse =>
    // SkinTrust::Verified`. One TOFU state must map to one skin-trust state.
    const code = SKIN_PACK_RS.replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/TrustStatus::Verified \| TrustStatus::FirstUse/);
    expect(code).toMatch(/TrustStatus::NotPinned => SkinTrust::NotPinned/);
  });

  it("the org skin pull cannot create a pin", () => {
    // Only `resolve_effective_policy`'s pre-pin from the admin-authored
    // publisherKey may do that. The pull itself checks, never decides.
    expect(MANAGED_RS).toMatch(/PinPolicy::RequirePinned/);
    expect(MANAGED_RS).not.toMatch(/PinPolicy::PinOnFirstUse/);
  });

  it("an incomplete policy.json is named rather than silently ignored", () => {
    expect(MANAGED_RS).toMatch(/policy_error/);
    expect(POLICY_TS).toMatch(/policyError: string;/);
    expect(PAGE).toMatch(/managed\.policyError/);
  });

  it("the TS SkinTrust union mirrors the Rust wire strings exactly", () => {
    const t = POLICY_TS.match(/export type SkinTrust =([^;]+);/);
    expect(t, "SkinTrust moved or was renamed").toBeTruthy();
    const declared = [...t![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(declared.sort()).toEqual([...RUST_STATUSES].sort());
  });

  it("the Appearance panel has a presentation row for every state", () => {
    const map = PAGE.match(
      /const SKIN_TRUST_PRESENTATION: Record<SkinTrust,[\s\S]*?\n\};/,
    );
    expect(map, "SKIN_TRUST_PRESENTATION moved or was renamed").toBeTruthy();
    const rows = [...map![0].matchAll(/^\s{2}([A-Za-z]+):\s*\{/gm)].map((m) => m[1]);
    for (const status of RUST_STATUSES) {
      expect(
        rows,
        `SkinTrust "${status}" has no row in SKIN_TRUST_PRESENTATION — it would render as raw ` +
          `text with no colour, which reads as benign.`,
      ).toContain(status);
    }

    // ...and the untrusted ones must not borrow the reassuring vocabulary.
    const labelFor = (status: string): string => {
      const m = map![0].match(new RegExp(`\\n  ${status}: \\{[\\s\\S]*?label: "([^"]*)"`));
      expect(m, `no label for ${status}`).toBeTruthy();
      return m![1];
    };
    expect(labelFor("verified")).toMatch(/verified/i);
    expect(labelFor("notPinned")).toMatch(/not trusted/i);
    expect(labelFor("notPinned")).not.toMatch(/^verified/i);
    expect(labelFor("unknown")).not.toMatch(/^verified/i);
  });
});
