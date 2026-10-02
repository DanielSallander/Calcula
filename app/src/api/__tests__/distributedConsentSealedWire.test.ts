//! FILENAME: app/src/api/__tests__/distributedConsentSealedWire.test.ts
// PURPOSE: The TypeScript half of "approvals sealed to this computer" (M6 Task A,
//          S2): @api/distributedConsent reads and writes approvals ONLY through
//          the two Rust commands, sends only what the approval screen showed,
//          and a refused approval REJECTS instead of vanishing.
// CONTEXT: Only `invokeBackend` is doubled. The request and response shapes are
//          pinned against app/src/api/__tests__/fixtures/consentSealWire.json,
//          which app/src-tauri/src/consent_seal_tests.rs reads too
//          (`the_record_request_is_the_one_typescript_sends`,
//          `the_list_answer_is_the_shape_typescript_reads`), so a field renamed
//          on either side turns one of the two suites red.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { createConsentStoreDouble } from "./helpers/consentStoreDouble";

const consentStore = createConsentStoreDouble();
/** Every backend call, in order, and when each one finished. */
const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
/** Per-call hooks: a test can hold a record call open. */
let beforeAnswer: ((cmd: string, args?: Record<string, unknown>) => Promise<void>) | null = null;
const fileReads = vi.fn();
const fileWrites = vi.fn();

vi.mock("../backend", () => ({
  invokeBackend: async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (beforeAnswer) await beforeAnswer(cmd, args);
    return consentStore.invoke(cmd, args);
  },
  // Tripwires: the store must never touch the consent FILE from the page.
  readVirtualFile: (...a: unknown[]) => {
    fileReads(...a);
    throw new Error("the consent store read a virtual file");
  },
  createVirtualFile: (...a: unknown[]) => {
    fileWrites(...a);
    throw new Error("the consent store wrote a virtual file");
  },
}));

import {
  loadConsents,
  loadConsentReport,
  recordConsent,
  type CapabilityGrant,
  type ConsentReport,
} from "../distributedConsent";

const APP_ROOT = join(__dirname, "..", "..", "..");

interface WireRequest {
  packageName: string;
  scripts: Array<{ id: string; source: string }>;
  grantedCapabilities: CapabilityGrant[];
}

interface WireFixture {
  inputs: WireRequest;
  request: Record<string, unknown>;
  response: unknown;
  buttonAction: { matched: WireRequest; mismatched: WireRequest };
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "consentSealWire.json"), "utf8"),
) as WireFixture;

beforeEach(() => {
  consentStore.reset();
  calls.length = 0;
  beforeAnswer = null;
  fileReads.mockClear();
  fileWrites.mockClear();
});

describe("approvals are read and written through Rust, never as a file", () => {
  it("loadConsents asks list_script_consents and never reads the consent file", async () => {
    consentStore.seed({ packageName: "Acme", scripts: [{ id: "m1", source: "run()" }] });
    const consents = await loadConsents();
    expect(calls.map((c) => c.cmd)).toEqual(["list_script_consents"]);
    expect(fileReads).not.toHaveBeenCalled();
    expect(consents).toHaveLength(1);
    expect(consents[0].scripts[0]).toEqual({ id: "m1", sourceHash: consentStore.hash("run()"), source: "run()" });
  });

  it("recordConsent sends exactly the request Rust accepts -- no hash, no timestamp, no seal", async () => {
    // `inputs` carries what a caller's array may hold beyond { id, source }:
    // a name, and a hash of its own. None of it may leave the page.
    const { packageName, scripts, grantedCapabilities } = fixture.inputs;
    await recordConsent(packageName, scripts, grantedCapabilities);

    expect(fileWrites).not.toHaveBeenCalled();
    expect(calls.map((c) => c.cmd)).toEqual(["record_script_consent"]);
    const sent = calls[0].args as { request: Record<string, unknown> };
    expect(Object.keys(sent)).toEqual(["request"]);
    expect(sent.request).toEqual(fixture.request);
    const text = JSON.stringify(sent);
    for (const planted of ["sourceHash", "grantedAt", "seal", "keyId", "planted-by-the-caller", "\"name\""]) {
      expect(text, `the request carries ${planted}`).not.toContain(planted);
    }
    // ...and the double, which refuses unknown fields as Rust does, accepted it.
    expect(consentStore.grantedIn(packageName, "obj-refresh", scripts[0].source)).toBe(true);
  });

  it("a Rust refusal REJECTS the promise -- a failed approval is never swallowed", async () => {
    const reason =
      "this computer's approvals key cannot be read (it holds 5 bytes, not 32), so nothing can be approved";
    consentStore.refuseRecords(reason);
    await expect(recordConsent("Acme", [{ id: "m1", source: "run()" }], [])).rejects.toBe(reason);
    expect(consentStore.records()).toEqual([]);
    // The queue survives a refusal: the next approval still reaches Rust.
    consentStore.refuseRecords(null);
    await expect(recordConsent("Acme", [{ id: "m1", source: "run()" }], [])).resolves.toBeUndefined();
    expect(consentStore.grantedIn("Acme", "m1", "run()")).toBe(true);
  });

  it("two approvals started together reach Rust one after the other, in call order", async () => {
    const events: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    beforeAnswer = async (cmd, args) => {
      const name = ((args?.request ?? {}) as { packageName?: string }).packageName;
      events.push(`start:${name}`);
      if (name === "First") await held;
      events.push(`end:${name}`);
    };
    const first = recordConsent("First", [{ id: "a", source: "a()" }], []);
    const second = recordConsent("Second", [{ id: "b", source: "b()" }], []);
    await new Promise((r) => setTimeout(r, 20));
    expect(events, "the second approval reached Rust while the first was still open").toEqual(["start:First"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["start:First", "end:First", "start:Second", "end:Second"]);
  });

  it("an approval of button code must name exactly the bytes it shows (the double holds Rust's refusal)", async () => {
    // The same two requests consent_seal_tests.rs feeds the real writer
    // (a_button_action_approval_must_name_the_bytes_it_shows).
    const { matched, mismatched } = fixture.buttonAction;
    expect(matched.scripts[0].id).toBe(`buttonAction:${consentStore.hash(matched.scripts[0].source)}`);
    expect(mismatched.scripts[0].id).toBe(matched.scripts[0].id);

    await expect(
      recordConsent(mismatched.packageName, mismatched.scripts, mismatched.grantedCapabilities),
    ).rejects.toMatch(/button code/);
    expect(consentStore.records()).toEqual([]);

    await expect(
      recordConsent(matched.packageName, matched.scripts, matched.grantedCapabilities),
    ).resolves.toBeUndefined();
    expect(consentStore.grantedIn(matched.packageName, matched.scripts[0].id, "Report();")).toBe(true);
    expect(consentStore.grantedIn(matched.packageName, matched.scripts[0].id, "Exfiltrate();")).toBe(false);
  });

  it("loadConsentReport passes through what does not count here, and why", async () => {
    consentStore.seed({ packageName: "Acme", scripts: [{ id: "m1", source: "run()" }] });
    consentStore.setIgnored([
      { packageName: "Sealed Elsewhere", reason: "otherComputer" },
      { packageName: "Old File", reason: "unsealed" },
    ]);
    const report = await loadConsentReport();
    expect(report.consents.map((c) => c.packageName)).toEqual(["Acme"]);
    expect(report.ignored).toEqual([
      { packageName: "Sealed Elsewhere", reason: "otherComputer" },
      { packageName: "Old File", reason: "unsealed" },
    ]);
    // loadConsents is the counting half only.
    expect((await loadConsents()).map((c) => c.packageName)).toEqual(["Acme"]);
  });

  it("the list answer Rust sends is what a typed ConsentReport spells, field for field", () => {
    // Typed against the TypeScript mirror: renaming a field here fails
    // check-types; renaming it in Rust fails the Rust twin against the fixture.
    const typed: ConsentReport = {
      consents: [
        {
          packageName: "Quarterly Reports",
          scripts: [
            {
              id: "macro-month-end",
              sourceHash: "0".repeat(64),
              source: "Calcula.setCellValue('A1', 1);",
            },
          ],
          grantedCapabilities: [
            { capability: "net.fetch", origins: ["https://example.com"] },
            { capability: "storage" },
          ],
          grantedAt: "2026-09-30T12:00:00.000Z",
        },
      ],
      ignored: [
        { packageName: "Sealed Elsewhere", reason: "otherComputer" },
        { packageName: "Old File", reason: "unsealed" },
        { packageName: "Edited", reason: "altered" },
        { packageName: "Broken Key", reason: "keyUnavailable" },
      ],
    };
    expect(fixture.response).toEqual(typed);
  });
});

describe("one door", () => {
  /** Every production .ts/.tsx under a folder (tests excluded). */
  function productionSources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "__tests__") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...productionSources(p));
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
    return out;
  }

  it("only @api/distributedConsent invokes the consent commands, and it no longer touches the file", () => {
    // Read with fs, never rg: app/src/api/writebackValidators.ts carries NUL
    // bytes, and rg skips it as binary.
    const spellers = [
      ...productionSources(join(APP_ROOT, "src")),
      ...productionSources(join(APP_ROOT, "extensions")),
    ]
      .filter((f) => /["'`](record_script_consent|list_script_consents)["'`]/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(APP_ROOT.length).replace(/\\/g, "/"));
    expect(new Set(spellers)).toEqual(
      new Set([
        "/src/api/distributedConsent.ts",
        // The denylist that keeps record_script_consent out of non-trusted hands.
        "/src/api/backendCommands.ts",
      ]),
    );
    const store = readFileSync(join(APP_ROOT, "src", "api", "distributedConsent.ts"), "utf8");
    const code = store
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(code).not.toMatch(/readVirtualFile|createVirtualFile|script-consent\.json/);
  });
});
