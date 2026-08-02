//! FILENAME: app/extensions/Distribution/__tests__/calpTrustPresentation.test.ts
// PURPOSE: Every `.calp` TOFU trust state the Rust side can emit must have its
//          OWN presentation row everywhere it surfaces, and only the state that
//          means "this machine pinned this key" may be called verified.
// CONTEXT: Wave J made pinning a decision instead of a side effect. Passive
//          surfaces (Package Inspector, the Subscribe dialog's Review step, the
//          subscription trust report) now answer `notPinned` on first contact
//          instead of silently writing a pin.
//
//          A new status is only half a fix. Wave I found the other half the hard
//          way: an unknown status rendered as a green "verified" pill in one
//          place and as no badge at all in another — and "no badge" reads as
//          benign, which is the worst possible failure for a security state. The
//          inspector's badge here was exactly that shape:
//              trustStatus === "verified" ? green : amber "first use — key newly
//              pinned"
//          which would have told the user their machine had pinned a key it had
//          deliberately NOT pinned.
//
//          Asserted from SOURCE TEXT (Rust + component) rather than by importing
//          either, exactly as ScriptableObjects/__tests__/libraryTrustBadge.test.ts
//          and ExtensionsManager/__tests__/installTrustChain.test.ts do: this
//          extension may not import the backend, and a reconstructed copy of the
//          status list would pass happily while the real one drifted.

import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";

const APP_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP_ROOT, rel), "utf8");

const INTEGRITY_RS = read("../core/calp/src/integrity.rs");
const INSPECTOR_RS = read("src-tauri/src/calp_inspector.rs");
const CALP_CMDS_RS = read("src-tauri/src/calp_commands.rs");
const DISTRIBUTION_TS = read("src/api/distribution.ts");
const OVERVIEW = read("extensions/Distribution/components/inspector/OverviewSection.tsx");
const SUB_PANE = read("extensions/Distribution/components/SubscriptionManagerPane.tsx");
const SUBSCRIBE = read("extensions/Distribution/components/SubscribeDialog.tsx");

/**
 * The wire strings Rust can emit for a `.calp` trust state, read out of
 * `calp_inspector::trust_status_str` — the exhaustive `TrustStatus` -> &str map.
 */
const RUST_STATUSES: string[] = (() => {
  const fn = INSPECTOR_RS.match(/fn trust_status_str\(trust: TrustStatus\) -> String \{[\s\S]*?\n\}/);
  expect(fn, "trust_status_str moved or was renamed").toBeTruthy();
  const statuses = [...fn![0].matchAll(/TrustStatus::\w+ => "([^"]+)"/g)].map((m) => m[1]);
  expect(statuses.length, "no statuses parsed out of trust_status_str").toBeGreaterThan(0);
  return statuses;
})();

/** The keys of a `Record<CalpTrustStatus, …>` style object literal in a file. */
function objectKeys(src: string, declaration: RegExp): string[] {
  const m = src.match(declaration);
  expect(m, `could not find ${declaration}`).toBeTruthy();
  return [...m![0].matchAll(/^\s{2}([A-Za-z]+):/gm)].map((x) => x[1]);
}

describe("the Rust trust vocabulary is complete and honest", () => {
  it("every TrustStatus variant has a wire string", () => {
    const variants = [
      ...INTEGRITY_RS.matchAll(/^\s{4}(FirstUse|Verified|NotPinned),$/gm),
    ].map((m) => m[1]);
    expect(new Set(variants).size, "TrustStatus variants changed").toBe(3);
    expect(RUST_STATUSES.length).toBe(3);
    expect(RUST_STATUSES).toContain("notPinned");
  });

  it("the passive surfaces map their statuses exhaustively, with no wildcard arm", () => {
    // A `_ =>` arm is how a new security state silently inherits an old label.
    for (const [name, src] of [
      ["calp_inspector::trust_status_str", INSPECTOR_RS],
      ["calp_commands", CALP_CMDS_RS],
    ] as const) {
      const matches = [...src.matchAll(/TrustStatus::NotPinned => "notPinned"/g)];
      expect(matches.length, `${name} does not spell out NotPinned`).toBeGreaterThan(0);
      expect(src, `${name} must not use a wildcard TrustStatus arm`).not.toMatch(
        /match (trust|result\.trust_status)[\s\S]{0,400}?\n\s+_ =>/,
      );
    }
  });

  it("the TS mirror declares exactly the Rust statuses", () => {
    const t = DISTRIBUTION_TS.match(/export type CalpTrustStatus = ([^;]+);/);
    expect(t, "CalpTrustStatus moved or was renamed").toBeTruthy();
    const declared = [...t![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(declared.sort()).toEqual([...RUST_STATUSES].sort());
  });

  it("the 'is this pinned' predicate excludes notPinned", () => {
    // Mirrors library_trust_is_pinned / TRUST_NOT_INSTALLED: the status that
    // means "authentic but not trusted" must be absent from the predicate that
    // answers "has this machine agreed to trust this publisher".
    const fn = DISTRIBUTION_TS.match(/export function calpTrustIsPinned[\s\S]*?\n\}/);
    expect(fn, "calpTrustIsPinned moved or was renamed").toBeTruthy();
    expect(fn![0]).toContain('"verified"');
    expect(fn![0]).toContain('"firstUse"');
    expect(fn![0]).not.toContain('"notPinned"');
  });
});

describe("Package Inspector overview badge", () => {
  const rows = objectKeys(
    OVERVIEW,
    /const TRUST_BADGE: Record<CalpTrustStatus,[\s\S]*?\n\};/,
  );

  it("has a row for every status Rust can return", () => {
    for (const status of RUST_STATUSES) {
      expect(
        rows,
        `trustStatus "${status}" has no row in OverviewSection's TRUST_BADGE — it would render ` +
          `with the fallback and could read as reassuring. Add a row for it.`,
      ).toContain(status);
    }
  });

  it("is a table, not a two-way ternary", () => {
    // The exact shape that produced the bug: a `=== "verified" ? … : …` that
    // labels EVERYTHING else as a pin having just been created, asserting a
    // pin that inspection deliberately does not create.
    //
    // Comments are stripped first: the component documents the old shape (so a
    // future reader knows why it is a table), and describing a bug must not
    // count as committing it.
    const code = OVERVIEW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/trustStatus === "verified" \?/);
    expect(code).not.toMatch(/first use — key newly pinned/);
  });

  it("reserves 'verified' for the status that earns it, and warns on notPinned", () => {
    const labelFor = (status: string): string => {
      const m = OVERVIEW.match(new RegExp(`\\n  ${status}: \\{[\\s\\S]*?label: "([^"]*)"`));
      expect(m, `no label for ${status}`).toBeTruthy();
      return m![1];
    };
    expect(labelFor("verified")).toMatch(/verified/i);
    expect(labelFor("firstUse")).not.toMatch(/^signature verified/i);
    // notPinned must SAY it is not trusted, not merely avoid the happy word.
    expect(labelFor("notPinned")).toMatch(/not trusted/i);
    // ...and it must not be painted with the OK colour.
    const notPinnedRow = OVERVIEW.match(/\n  notPinned: \{[\s\S]*?\n  \},/)![0];
    expect(notPinnedRow).not.toContain("OK_GREEN");
  });
});

describe("Subscribe dialog review step", () => {
  const rows = objectKeys(SUBSCRIBE, /const TRUST_REVIEW: Record<[\s\S]*?\n\};/);

  it("has a row for every status Rust can return", () => {
    for (const status of RUST_STATUSES) {
      expect(
        rows,
        `trustStatus "${status}" has no row in SubscribeDialog's TRUST_REVIEW.`,
      ).toContain(status);
    }
  });

  it("shows WHO signed the package, not just what is inside it", () => {
    // Review is the pre-subscribe trust surface and it is PASSIVE — the backend
    // reports the publisher but writes no pin — so the identity has to be
    // legible here or the user is agreeing to something they were never shown.
    // A name is not an identity: the KEY is the comparable value.
    expect(SUBSCRIBE).toMatch(/inspection\.publisherName/);
    expect(SUBSCRIBE).toMatch(/inspection\.publisherKey/);
  });

  it("explains that subscribing is what records the trust", () => {
    // Join the source's string-concatenation breaks before matching prose.
    const row = SUBSCRIBE.match(/\n  notPinned: \{[\s\S]*?\n  \},/)![0]
      .replace(/"\s*\+\s*\n?\s*"/g, "");
    expect(row).toMatch(/nobody on this computer has agreed to trust this publisher/i);
    expect(row).toMatch(/Subscribing records it/i);
  });

  it("degrades an unknown state to a warning, never to a safe one", () => {
    const fallback = SUBSCRIBE.match(/const TRUST_REVIEW_FALLBACK = \{[\s\S]*?\n\};/);
    expect(fallback, "TRUST_REVIEW_FALLBACK moved or was renamed").toBeTruthy();
    expect(fallback![0]).toMatch(/unrecognised/i);
    expect(fallback![0]).toMatch(/Do not subscribe/i);
  });
});

describe("Subscriptions pane trust notice", () => {
  const rows = objectKeys(SUB_PANE, /const TRUST_NOTICE: Record<[\s\S]*?\n\};/);

  it("has a row for every status the backend can report, plus the transport failure", () => {
    for (const status of [...RUST_STATUSES, "unavailable"]) {
      expect(
        rows,
        `trustStatus "${status}" has no row in SubscriptionManagerPane's TRUST_NOTICE — it would ` +
          `render as nothing, which reads as "everything is fine".`,
      ).toContain(status);
    }
  });

  it("tells the user how to activate an untrusted package", () => {
    // The fail-closed change is invisible without this: a workbook that names a
    // package nobody here subscribed to shows inert writeback/GATHER, and the
    // user needs to be told that subscribing is what fixes it.
    const row = SUB_PANE.match(/\n  notPinned: \{[\s\S]*?\n  \},/)![0];
    expect(row).toMatch(/not trusted on this computer/i);
    expect(row).toMatch(/Subscribe to Package/);
  });

  it("does not collapse an UNKNOWN status into the silent 'verified' branch", () => {
    // The third failure mode of this class, and the subtlest, because the table
    // is complete and still gets it wrong at the point of USE.
    //
    // `verified` is deliberately `null` (the expected case adds no noise). A
    // status this build has no row for is `undefined`. `if (!notice) return
    // null` treats those two identically, so a status the backend gained and
    // this frontend has not yet learned renders as the reassuring nothing —
    // the exact "no badge reads as benign" failure, reintroduced downstream of
    // an exhaustive map.
    const code = SUB_PANE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(
      code,
      "TRUST_NOTICE lookups must distinguish `undefined` (unknown status) from " +
        "`null` (verified, intentionally silent) — a truthiness check merges them.",
    ).not.toMatch(/const notice = TRUST_NOTICE\[[^\]]+\];\s*\n\s*if \(!notice\)/);
    expect(code).toMatch(/notice === undefined/);
    expect(code).toMatch(/notice === null/);
    // ...and the unknown branch must actually say something alarming.
    const unknownBranch = code.match(/if \(notice === undefined\) \{[\s\S]*?\n {18}\);/);
    expect(unknownBranch, "no rendering for an unrecognised status").toBeTruthy();
    expect(unknownBranch![0]).toMatch(/Unrecognised/i);
    expect(unknownBranch![0]).toMatch(/trustDanger/);
    expect(unknownBranch![0]).toMatch(/do not treat the package as trusted/i);
  });
});
