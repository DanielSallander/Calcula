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
      ...INTEGRITY_RS.matchAll(
        /^\s{4}(FirstUse|FirstUseKnownPublisher|FirstUseAcceptedNameConflict|Verified|NotPinned|NotPinnedNameConflict),$/gm,
      ),
    ].map((m) => m[1]);
    expect(new Set(variants).size, "TrustStatus variants changed").toBe(6);
    expect(RUST_STATUSES.length).toBe(6);
    expect(RUST_STATUSES).toContain("notPinned");
    expect(RUST_STATUSES).toContain("notPinnedNameConflict");
  });

  it("there is exactly ONE Rust map, and nothing hand-rolls a second", () => {
    // Two exhaustive matches meaning the same thing are two matches that can
    // DISAGREE, and a trust state rendered with the wrong word is a security
    // bug. `calp_inspector::trust_status_str` is the map; `calp_commands`
    // delegates to it rather than repeating it.
    expect(CALP_CMDS_RS).toMatch(
      /fn calp_trust_status_str\([\s\S]{0,200}?calp_inspector::trust_status_str\(trust\)/,
    );
    expect(
      CALP_CMDS_RS,
      "calp_commands must not carry its own TrustStatus -> string match",
    ).not.toMatch(/TrustStatus::NotPinned => "notPinned"/);
  });

  it("the one map is exhaustive, with no wildcard arm", () => {
    // A `_ =>` arm is how a new security state silently inherits an old label.
    const fn = INSPECTOR_RS.match(
      /fn trust_status_str\(trust: TrustStatus\) -> String \{[\s\S]*?\n\}/,
    )![0];
    expect(fn).toContain('TrustStatus::NotPinned => "notPinned"');
    expect(fn).toContain('TrustStatus::NotPinnedNameConflict => "notPinnedNameConflict"');
    expect(fn, "the map must not use a wildcard arm").not.toMatch(/\n\s+_ =>/);
  });

  it("only `verified` may use the word verified, and both conflicts are distinct", () => {
    // The recurring failure: a new state inherits the friendliest label. No
    // status other than `verified` may CONTAIN the word.
    for (const status of RUST_STATUSES) {
      if (status === "verified") continue;
      expect(
        status.toLowerCase().includes("verified"),
        `status "${status}" contains the word "verified"`,
      ).toBe(false);
    }
    expect(RUST_STATUSES).toContain("firstUseKnownPublisher");
    expect(RUST_STATUSES).toContain("firstUseAcceptedNameConflict");
  });

  it("the TS mirror declares exactly the Rust statuses", () => {
    const t = DISTRIBUTION_TS.match(/export type CalpTrustStatus =([^;]+);/);
    expect(t, "CalpTrustStatus moved or was renamed").toBeTruthy();
    const declared = [...t![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(declared.sort()).toEqual([...RUST_STATUSES].sort());
  });

  it("the 'is this pinned' predicate excludes both notPinned states", () => {
    // Mirrors library_trust_is_pinned / TRUST_NOT_INSTALLED: the statuses that
    // mean "authentic but not trusted" must be absent from the predicate that
    // answers "has this machine agreed to trust this publisher".
    const fn = DISTRIBUTION_TS.match(/export function calpTrustIsPinned[\s\S]*?\n\}/);
    expect(fn, "calpTrustIsPinned moved or was renamed").toBeTruthy();
    expect(fn![0]).toContain('"verified"');
    expect(fn![0]).toContain('"firstUse"');
    expect(fn![0]).toContain('"firstUseKnownPublisher"');
    expect(fn![0]).toContain('"firstUseAcceptedNameConflict"');
    expect(fn![0]).not.toContain('"notPinned"');
    expect(fn![0]).not.toContain('"notPinnedNameConflict"');
  });

  it("the pin key is scoped to a registry, and only in one place", () => {
    // THE BUG THIS WAVE FIXED. A pin keyed by package NAME alone let whoever
    // made first contact with a name own it machine-wide: a package served once
    // from a hostile share wrote the pin the genuine publisher was later
    // measured against, so the real author's first release read as
    // "publisherChanged". The key is now (namespace, registry scope, name), and
    // it may only be BUILT by the two sanctioned constructors.
    const signing = read("../core/calp/src/signing.rs");
    const production = signing.split("#[cfg(test)]")[0];
    expect(production).toMatch(/pub fn calp\(scope: &RegistryScope, package: &str\) -> PinKey/);
    expect(production).toMatch(/pub fn extension\(id: &str\) -> PinKey/);
    expect(
      production.match(/PinKey \{\n {12}namespace,/g)?.length ?? 0,
      "a PinKey must be built in exactly one place",
    ).toBe(1);
    expect(
      production,
      "the old ext: string convention must be gone",
    ).not.toContain('format!("ext:');

    // ...and the verifier cannot be called without a scope.
    const integrityProd = INTEGRITY_RS.split("#[cfg(test)]")[0];
    expect(integrityProd).toContain("    scope: &RegistryScope,");
    expect(integrityProd).not.toContain("Option<RegistryScope>");
    expect(integrityProd).not.toContain("impl Default for RegistryScope");
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

  it("paints both name-conflict states as danger", () => {
    // A name claimed by two registries under two keys is the loudest thing this
    // vocabulary can say. Neither state may be painted amber or green.
    for (const status of ["notPinnedNameConflict", "firstUseAcceptedNameConflict"]) {
      const row = OVERVIEW.match(new RegExp(`\\n  ${status}: \\{[\\s\\S]*?\\n  \\},`));
      expect(row, `no row for ${status}`).toBeTruthy();
      expect(row![0], `${status} must be DANGER_RED`).toContain("DANGER_RED");
      expect(row![0]).not.toContain("OK_GREEN");
      expect(row![0]).not.toContain("WARN_AMBER");
    }
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

  it("paints both name-conflict states as danger and asks a SECOND question", () => {
    for (const status of ["notPinnedNameConflict", "firstUseAcceptedNameConflict"]) {
      const row = SUBSCRIBE.match(new RegExp(`\\n  ${status}: \\{[\\s\\S]*?\\n  \\},`));
      expect(row, `no row for ${status}`).toBeTruthy();
      // The danger box + red text, same palette as TRUST_REVIEW_FALLBACK.
      expect(row![0]).toContain("#c5221f");
      expect(row![0]).toContain("#fdeceb");
    }
    // Accepting a conflict must be a SEPARATE, differently-worded confirmation —
    // the same two-question pattern as acceptPublisherChange on add-in installs.
    // The flag may only be set from the state that displayed the conflict.
    expect(SUBSCRIBE).toMatch(
      /acceptNameConflict: inspection\?\.trustStatus === "notPinnedNameConflict"/,
    );
    expect(SUBSCRIBE).toMatch(/Trust this publisher anyway/);
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
