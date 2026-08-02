//! FILENAME: app/extensions/ScriptableObjects/__tests__/trustedPublishersView.test.ts
// PURPOSE: The transparency panel's "Trusted publishers" section must show every
//          namespace, must flag a package name that resolves to MORE THAN ONE
//          publisher key, and must never render an unreadable pin store as an
//          empty (reassuring) list.
// CONTEXT: Publisher pins are keyed by (namespace, registry scope, name). That
//          fixes the squat where whoever reached a name first owned it for the
//          whole machine — but it introduces a state that has to be visible: the
//          same name legitimately held by two registries, possibly under two
//          different keys. The subscribe dialog asks about a conflict once; THIS
//          view is the only place it stays visible afterwards, so an accepted
//          conflict cannot quietly become invisible history.
//
//          Source-text assertions, same technique as
//          Distribution/__tests__/calpTrustPresentation.test.ts: this extension
//          may not import the backend, and a reconstructed copy of the wire
//          shape would pass happily while the real one drifted.

import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";

const APP_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP_ROOT, rel), "utf8");

const CMDS_RS = read("src-tauri/src/calp_commands.rs");
const SIGNING_RS = read("../core/calp/src/signing.rs");
const DISTRIBUTION_TS = read("src/api/distribution.ts");
const PANEL = read("extensions/ScriptableObjects/components/CodeInThisFilePanel.tsx");

describe("the backend trusted-publisher report", () => {
  it("is read-only and passive", () => {
    const fn = CMDS_RS.match(
      /pub fn calp_list_trusted_publishers\([\s\S]*?\n\}\n/,
    );
    expect(fn, "calp_list_trusted_publishers moved or was renamed").toBeTruthy();
    // It reports on trust; it must not be able to create or verify any.
    expect(fn![0]).not.toContain("pin_publisher(");
    expect(fn![0]).not.toContain("PinPolicy::");
    expect(fn![0]).not.toContain("open_registry");
  });

  it("groups by (namespace, name) and flags a name held by two keys", () => {
    const fn = CMDS_RS.match(/pub fn calp_list_trusted_publishers\([\s\S]*?\n\}\n/)![0];
    expect(fn).toContain("has_key_conflict");
    // The conflict test is "more than one DISTINCT key", not "more than one pin"
    // — two registries pinning the SAME key is a mirror, not a hijack.
    expect(fn).toMatch(/distinct\.len\(\) > 1/);
  });

  it("reports an unreadable pin store as an error, never as an empty list", () => {
    // `load_pins` fails closed on a store that exists and cannot be parsed. If
    // this view swallowed that into `names: []` the panel would say "nothing is
    // trusted" at exactly the moment nothing can be verified.
    const fn = CMDS_RS.match(/pub fn calp_list_trusted_publishers\([\s\S]*?\n\}\n/)![0];
    expect(fn).toMatch(/Err\(e\) =>[\s\S]*?error: e\.to_string\(\)/);
  });

  it("exposes the user's spelling of a registry and never the normalized id", () => {
    // `RegistryScope.id` is key material: lowercased, canonicalized, lossy. It is
    // not a string anyone typed, and showing it to a human would be a lie about
    // what they configured.
    const fn = CMDS_RS.match(/pub fn calp_list_trusted_publishers\([\s\S]*?\n\}\n/)![0];
    expect(fn).toContain("record.scope_label.clone()");
    expect(fn, "the normalized scope id must not be exposed").not.toMatch(
      /scope: record\.scope\.clone\(\)/,
    );

    const pin = CMDS_RS.match(/pub struct TrustedPublisherPin \{[\s\S]*?\n\}/)![0];
    expect(pin).toContain("pub scope_label: String");
    expect(pin).not.toMatch(/\n {4}pub scope: String/);
  });
});

describe("the TS mirror", () => {
  it("declares the report shape the command returns", () => {
    for (const decl of [
      "export interface TrustedPublisherPin",
      "export interface TrustedPublisherName",
      "export interface TrustedPublisherReport",
      "export async function listTrustedPublishers",
    ]) {
      expect(DISTRIBUTION_TS, `${decl} is missing`).toContain(decl);
    }
    const report = DISTRIBUTION_TS.match(
      /export interface TrustedPublisherReport \{[\s\S]*?\n\}/,
    )![0];
    expect(report).toContain("conflictCount: number;");
    expect(report).toContain("error: string;");
  });
});

describe("the panel section", () => {
  it("exists, and is labelled as machine-scoped rather than workbook-scoped", () => {
    expect(PANEL).toContain("function TrustedPublishersSection(");
    expect(PANEL).toContain("<TrustedPublishersSection report={pins} />");
    // The same discipline as the add-in trail next to it: a machine-wide fact
    // rendered inside a workbook panel must say so, or it reads as file content.
    const section = PANEL.match(
      /function TrustedPublishersSection\([\s\S]*?\n\}\n/,
    )![0];
    expect(section).toMatch(/NOT part of this workbook/);
  });

  it("shows both namespaces, and says why an add-in has no registry", () => {
    const section = PANEL.match(/function TrustedPublishersSection\([\s\S]*?\n\}\n/)![0];
    expect(section).toMatch(/add-in/);
    expect(section).toMatch(/package/);
    // An extension pin carries no scope BY DECISION; the row must not look like
    // a missing value.
    expect(section).toMatch(/this computer, any source/);
  });

  it("flags a name held by two publishers, and sorts those rows first", () => {
    const section = PANEL.match(/function TrustedPublishersSection\([\s\S]*?\n\}\n/)![0];
    expect(section).toContain("hasKeyConflict");
    expect(section).toMatch(/two publishers/);
    expect(section).toMatch(/conflictCount/);
    // Conflicts sort to the top — the one row a user opens this section to find.
    expect(section).toMatch(/hasKeyConflict === b\.hasKeyConflict/);
  });

  it("renders an unreadable store as a failure, not as 'nothing is trusted'", () => {
    const section = PANEL.match(/function TrustedPublishersSection\([\s\S]*?\n\}\n/)![0];
    expect(section).toMatch(/report\.error !== ""/);
    expect(section).toMatch(/NOT the same as/);
    // ...and the empty-state message is gated on there being NO error.
    expect(section).toMatch(/report\.error === "" && report\.totalPins === 0/);
  });
});

describe("the store the view reads", () => {
  it("keys pins by namespace + scope + name, built in exactly one place", () => {
    const production = SIGNING_RS.split("#[cfg(test)]")[0];
    expect(production).toMatch(/pub struct PinKey \{\n {4}namespace: PinNamespace,/);
    expect(production).toMatch(/pub fn calp\(scope: &RegistryScope, package: &str\) -> PinKey/);
    expect(production).toMatch(/pub fn extension\(id: &str\) -> PinKey/);
    expect(
      production.match(/PinKey \{\n {12}namespace,/g)?.length ?? 0,
      "a PinKey must be BUILT in exactly one place (PinKey::new)",
    ).toBe(1);
  });

  it("discards un-scopeable v1 pins to an auditable file rather than guessing", () => {
    // A v1 pin recorded only the package name. Inferring a registry for it would
    // bind trust to a registry it may not belong to — the silent-accept outcome
    // this whole change exists to remove — and would be most likely wrong in
    // exactly the multi-registry case that motivated it.
    const production = SIGNING_RS.split("#[cfg(test)]")[0];
    expect(production).toContain("trusted-publishers.v1.discarded.json");
    expect(production).toMatch(/fn migrate_v1_store\(/);
    // Extension pins DO migrate: the key is the same key with the same meaning.
    expect(production).toMatch(/name\.strip_prefix\("ext:"\)/);
  });
});
