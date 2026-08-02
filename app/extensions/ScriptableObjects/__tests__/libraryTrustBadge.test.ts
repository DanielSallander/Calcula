//! FILENAME: app/extensions/ScriptableObjects/__tests__/libraryTrustBadge.test.ts
// PURPOSE: Every library trust status the Rust resolver can return must have its
//          OWN presentation row in the install plan, and only one of them may be
//          called "verified".
// CONTEXT: `library_resolve` can return three statuses
//          (`library_commands.rs::LIBRARY_TRUST_STATUSES`). The badge used to be
//          a ternary — `firstUse ? "first use" : "verified"` — inside an
//          unconditionally GREEN pill. When Wave I's preview/install split added
//          `notInstalled` ("the signature is authentic, but this machine has
//          never agreed to trust this publisher"), it fell through to
//          **"verified"**: the UI told the user their machine had vouched for a
//          key it had never seen. A security state that degrades to the
//          friendliest label is worse than one with no label at all.
//
//          Asserted from the Rust SOURCE TEXT and the component SOURCE TEXT
//          rather than by importing either: this extension may not import the
//          backend, and a reconstructed copy of the status list would pass
//          happily while the real one drifted. Same technique, and same reason,
//          as ExtensionsManager/__tests__/installTrustChain.test.ts.

import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";

const APP_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP_ROOT, rel), "utf8");

const LIBRARY_RS = read("src-tauri/src/library_commands.rs");
const MARKETPLACE = read("extensions/ScriptableObjects/components/ScriptMarketplace.tsx");

/** The status strings Rust can emit, read out of LIBRARY_TRUST_STATUSES by
 *  resolving each `LIB_TRUST_*` constant it names to its literal value. */
const RUST_STATUSES: string[] = (() => {
  const block = LIBRARY_RS.match(
    /pub const LIBRARY_TRUST_STATUSES: &\[&str\] = &\[([\s\S]*?)\];/,
  );
  expect(block, "LIBRARY_TRUST_STATUSES moved or was renamed").toBeTruthy();
  const names = [...block![1].matchAll(/LIB_TRUST_[A-Z_]+/g)].map((m) => m[0]);
  expect(names.length, "no statuses parsed out of LIBRARY_TRUST_STATUSES").toBeGreaterThan(0);
  return names.map((n) => {
    const decl = LIBRARY_RS.match(new RegExp(`pub const ${n}: &str = "([^"]+)"`));
    expect(decl, `no literal for ${n}`).toBeTruthy();
    return decl![1];
  });
})();

/** The `case "…":` labels of the component's trustBadge switch. */
const PRESENTED: string[] = (() => {
  const fn = MARKETPLACE.match(
    /function trustBadge\(status: string\)[\s\S]*?\n}\n/,
  );
  expect(fn, "trustBadge moved or was renamed").toBeTruthy();
  return [...fn![0].matchAll(/case "([^"]+)":/g)].map((m) => m[1]);
})();

describe("library install plan discloses every trust state", () => {
  it("has a presentation row for every status Rust can return", () => {
    for (const status of RUST_STATUSES) {
      expect(
        PRESENTED,
        `trustStatus "${status}" has no row in ScriptMarketplace's trustBadge — it would fall ` +
          `through to the default badge. Add a case for it.`,
      ).toContain(status);
    }
  });

  it("reserves the word 'verified' for the one status that earns it", () => {
    // "notInstalled" is authentic but NOT trusted; "firstUse" is a pin being
    // created right now. Neither may borrow the vocabulary of an existing pin.
    expect(RUST_STATUSES).toContain("notInstalled");
    const fn = MARKETPLACE.match(/function trustBadge\(status: string\)[\s\S]*?\n}\n/)![0];
    const labelFor = (status: string): string => {
      const m = fn.match(new RegExp(`case "${status}":[\\s\\S]*?label: "([^"]*)"`));
      expect(m, `no label for ${status}`).toBeTruthy();
      return m![1];
    };
    expect(labelFor("verified")).toMatch(/verified/i);
    expect(labelFor("notInstalled")).not.toMatch(/verified/i);
    expect(labelFor("firstUse")).not.toMatch(/verified/i);
    // ...and it must say what it actually means, not merely avoid the word.
    expect(labelFor("notInstalled")).toMatch(/not previously trusted/i);
  });

  it("no status other than 'verified' may contain the word verified", () => {
    for (const status of RUST_STATUSES) {
      if (status === "verified") continue;
      expect(
        status.toLowerCase().includes("verified"),
        `status "${status}" borrows the word "verified"`,
      ).toBe(false);
    }
  });

  it("both name-conflict statuses render in the danger palette", () => {
    // Pins are keyed by (registry, package), so a SECOND registry serving a
    // familiar library name is first contact rather than a refusal. That is only
    // safe because the conflict is loud: both of these are red, never neutral.
    const fn = MARKETPLACE.match(/function trustBadge\(status: string\)[\s\S]*?\n}\n/)![0];
    for (const status of ["notInstalledNameConflict", "firstUseAcceptedNameConflict"]) {
      expect(RUST_STATUSES, `${status} missing from LIBRARY_TRUST_STATUSES`).toContain(status);
      const arm = fn.match(new RegExp(`case "${status}":[\\s\\S]*?\\};`));
      expect(arm, `no badge for ${status}`).toBeTruthy();
      expect(arm![0], `${status} must use the danger palette`).toContain("#FDE7E9");
      expect(arm![0]).not.toContain("#E8F4EA");
      expect(arm![0]).not.toContain("#F0F0F0");
    }
  });

  it("degrades an UNKNOWN status to a caution badge, never to a safe one", () => {
    const fn = MARKETPLACE.match(/function trustBadge\(status: string\)[\s\S]*?\n}\n/)![0];
    expect(fn).toMatch(/default:/);
    const dflt = fn.slice(fn.indexOf("default:"));
    expect(dflt).toMatch(/unrecognized/i);
    // The default must not paint the green pill (#E8F4EA is the verified fill).
    expect(dflt).not.toContain("#E8F4EA");
  });

  it("the pinning predicate and the badge agree on what 'trusted' means", () => {
    // library_trust_is_pinned is the Rust answer to "has this machine agreed to
    // trust this publisher"; notInstalled must be absent from it, or the badge
    // and the gate would disagree about the same word.
    const pred = LIBRARY_RS.match(
      /pub fn library_trust_is_pinned[\s\S]*?matches!\(\s*status,([^)]*)\)/,
    );
    expect(pred, "library_trust_is_pinned moved or was renamed").toBeTruthy();
    expect(pred![1]).not.toContain("LIB_TRUST_NOT_INSTALLED");
    expect(pred![1]).toContain("LIB_TRUST_VERIFIED");
    // ...and the pinning states created by an install DO count, including the
    // one that recorded an accepted cross-registry name conflict: the pin
    // exists, so the ceiling it unlocks exists too. Pretending otherwise would
    // make the badge and the gate disagree in the other direction.
    expect(pred![1]).toContain("LIB_TRUST_FIRST_USE_KNOWN_PUBLISHER");
    expect(pred![1]).toContain("LIB_TRUST_FIRST_USE_ACCEPTED_NAME_CONFLICT");
  });

  it("accepting a name conflict is a SECOND, differently-worded question", () => {
    // `install.ts::pinApprovedPublishers` sets `acceptNameConflict` from the
    // plan's trust status, and the backend refuses to pin a conflicting name
    // without it. So the confirm button IS the acceptance. It used to say plain
    // "Install", which meant one ordinary click trusted a second claimant to a
    // familiar package name — the badge three lines up was the only warning, and
    // a conflicting TRANSITIVE dependency was never named at all.
    const install = fs.readFileSync(
      path.join(APP_ROOT, "src/api/scriptLibraries/install.ts"),
      "utf8",
    );
    expect(
      install,
      "applyInstall must derive acceptNameConflict from the reviewed plan",
    ).toContain("acceptNameConflict: libraryTrustIsNameConflict(n.trustStatus)");

    // The plan panel states the conflict as an aggregate, naming the packages.
    expect(
      MARKETPLACE,
      "ScriptMarketplace must compute the conflicting packages over the whole closure",
    ).toContain("function conflictingPackages(plan: InstallPlan): string[]");
    expect(MARKETPLACE).toContain("plan.nodes.filter((n) => libraryTrustIsNameConflict");
    expect(MARKETPLACE, "the plan must carry a NAME CONFLICT callout").toMatch(
      /NAME CONFLICT — another registry already owns/,
    );

    // ...and the confirm button must be re-worded, not merely re-coloured.
    const footer = MARKETPLACE.slice(MARKETPLACE.indexOf("void confirmInstall()") - 1400);
    expect(footer, "the confirm button must ask a different question on a conflict").toContain(
      "Trust these publishers anyway",
    );
    expect(footer).toContain("conflictingPackages(plan).length > 0");
  });
});
