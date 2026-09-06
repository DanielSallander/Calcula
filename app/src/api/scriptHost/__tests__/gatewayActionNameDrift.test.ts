//! FILENAME: app/src/api/scriptHost/__tests__/gatewayActionNameDrift.test.ts
// PURPOSE: Every `action` string the host sends to a Rust gateway must be one
//          that gateway's parser accepts.
// CONTEXT: `caps.packages.browse()` and `caps.packages.inspect()` were DEAD.
//          The 2026-08-31 vocabulary rename moved the host's action strings to
//          the new nouns — "listApplicationsInWorkspace", "inspectApplication" —
//          while `Action::parse` kept the WIRE names, which is correct: the
//          vocabulary doc lists wire strings as a contract that must not be
//          renamed. Nobody renamed the caller back.
//
//          The failure was silent in the worst way. An unknown action is
//          refused at gate (2), BEFORE the audited capability check, so the
//          denial was not recorded either: the verb did nothing and left no
//          trace. It survived a review, a milestone and a typings regeneration.
//
//          This is the `invoke()` command-drift guard's problem one layer down:
//          a string crossing a language boundary that nothing type-checks.

import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";

const APP_ROOT = path.resolve(__dirname, "../../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP_ROOT, rel), "utf8");

const HOST = read("src/api/scriptHost/host.ts");
const DIST_GATEWAY = read("src-tauri/src/scripting/distribution_gateway.rs");
const WRITEBACK_GATEWAY = read("src-tauri/src/scripting/writeback_gateway.rs");

/** `"name" => Action::Variant,` — the parser's accepted set. */
function acceptedActions(rust: string): Set<string> {
  const out = new Set<string>();
  for (const m of rust.matchAll(/"([A-Za-z][A-Za-z0-9]*)"\s*=>\s*Action::/g)) {
    out.add(m[1]);
  }
  return out;
}

/**
 * The action strings the host sends with a given backend command, read from the
 * `invokeBackend("<command>", { ... action: "<name>" ... })` calls.
 *
 * Deliberately textual: the whole point is that nothing type-checks these.
 */
function sentActions(command: string): string[] {
  const out: string[] = [];
  for (const m of HOST.matchAll(new RegExp(`invokeBackend[^;]*?"${command}"[\\s\\S]{0,600}?\\}\\);`, "g"))) {
    for (const a of m[0].matchAll(/action:\s*"([A-Za-z][A-Za-z0-9]*)"/g)) {
      out.push(a[1]);
    }
  }
  return out;
}

describe("scripted gateway action names", () => {
  it("the distribution gateway accepts every action the host sends it", () => {
    // SABOTAGE: change one `action:` literal in host.ts to a new noun, as the
    // vocabulary rename did. The verb is then refused before it is audited.
    const accepted = acceptedActions(DIST_GATEWAY);
    expect(accepted.size).toBeGreaterThan(5);

    const sent = sentActions("script_distribution");
    expect(sent.length, "the host must still send distribution actions").toBeGreaterThan(4);

    const unknown = sent.filter((a) => !accepted.has(a));
    expect(unknown, `these actions are not in Action::parse: ${unknown.join(", ")}`).toEqual([]);
  });

  it("the writeback gateway accepts every action the host sends it", () => {
    const accepted = acceptedActions(WRITEBACK_GATEWAY);
    if (accepted.size === 0) return; // that gateway parses differently; nothing to check
    const sent = sentActions("script_writeback");
    const unknown = sent.filter((a) => !accepted.has(a));
    expect(unknown, `these actions are not accepted: ${unknown.join(", ")}`).toEqual([]);
  });

  it("names the two verbs the vocabulary rename broke, so a revert is caught", () => {
    // Belt and braces: these two are the ones that were dead, and their old
    // spellings are the exact strings a well-meaning rename would restore.
    for (const dead of ["listApplicationsInWorkspace", "inspectApplication"]) {
      expect(
        HOST.includes(`action: "${dead}"`),
        `host.ts must not send "${dead}" — the gateway does not parse it`,
      ).toBe(false);
    }
    expect(HOST).toContain('action: "browseRegistry"');
    expect(HOST).toContain('action: "inspectPackage"');
  });
});
