//! FILENAME: app/e2e/__tests__/processResidue.test.ts
// PURPOSE: Pin the two rules `processResidue.ts` exists to obey, because both are
//          rules about what it must NOT do — and "did not kill the wrong thing" is
//          invisible on a passing run.
//
//   1. Only pids this run RECORDED are ever killed. A Calcula built from the same
//      CARGO_TARGET_DIR may be another agent's live suite, and killing one is a
//      measured past defect (a pass died at test 166 of ~550).
//   2. `msedgewebview2` is never targeted by image name. Those processes also
//      belong to Windows SearchHost, and Calcula itself renders in WebView2 —
//      killing them wholesale destroyed a journey run.
//
// The ledger is redirected to a temp directory via `E2E_RESIDUE_STATE_DIR`: against
// the real path these tests would rewrite the ledger of a CONCURRENTLY RUNNING
// suite, whose teardown would then kill nothing or fail to recognise its own app.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "residue-test-"));
process.env.E2E_RESIDUE_STATE_DIR = STATE_DIR;
const LEDGER = path.join(STATE_DIR, ".run-pids");

async function fresh() {
  vi.resetModules();
  return await import("../processResidue");
}

function clearLedger(): void {
  try {
    if (fs.existsSync(LEDGER)) fs.unlinkSync(LEDGER);
  } catch { /* nothing to clear */ }
}

describe("process residue", () => {
  beforeEach(clearLedger);
  afterEach(clearLedger);

  it("round-trips the pid ledger and de-duplicates", async () => {
    const m = await fresh();
    expect(m.readRecordedPids()).toEqual([]);
    m.recordAppPid(4242);
    m.recordAppPid(4242); // idempotent — global-setup may survey more than once
    m.recordAppPid(99);
    expect(m.readRecordedPids()).toEqual([4242, 99]);
    m.clearRecordedPids();
    expect(m.readRecordedPids()).toEqual([]);
  });

  it("the ledger survives a fresh module load — teardown is a different process", async () => {
    // global-setup writes it; global-teardown reads it, in another Node process.
    // An in-memory list would be empty by then and the teardown would kill nothing
    // — the same class of bug as the wedge guard's counter.
    (await fresh()).recordAppPid(31337);
    const later = await fresh();
    expect(later.readRecordedPids()).toContain(31337);
  });

  it("never names msedgewebview2 — not in the query, not anywhere", async () => {
    // A source assertion, because the damage is done by the STRING: an image-name
    // kill of WebView2 takes Windows SearchHost and the app's own renderer with it.
    const src = fs.readFileSync(
      path.join(__dirname, "..", "processResidue.ts"),
      "utf-8",
    );
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(
      code.toLowerCase().includes("msedgewebview2"),
      "msedgewebview2 must never appear in executable code here — only in the " +
        "comments explaining why it must not. Those processes also belong to " +
        "Windows SearchHost.",
    ).toBe(false);
    // ...and the process query is narrowed to Calcula's own two image names.
    expect(code).toContain("Name='app.exe'");
    expect(code).toContain("Name='Calcula.exe'");
  });

  it("attributes only recorded pids as ours, and reports the rest", async () => {
    const m = await fresh();
    // The survey shells out, so this asserts the CLASSIFICATION contract rather
    // than a live machine state: whatever it returns, nothing may be marked
    // "recorded" unless it is in the ledger we passed.
    const recorded = m.readRecordedPids();
    for (const p of m.surveyCalculaProcesses(recorded)) {
      if (p.attribution === "recorded") {
        expect(recorded).toContain(p.pid);
      } else {
        expect(p.attribution).toBe("our-target-dir");
      }
    }
  });

  it("isAlive answers truthfully for this process and for a pid that cannot exist", async () => {
    const m = await fresh();
    expect(m.isAlive(process.pid)).toBe(true);
    // NOT pid 0: `process.kill(0, 0)` addresses the process GROUP and succeeds,
    // so it answers a different question and this test asserted the wrong thing
    // on its first run. A pid above the Windows range cannot be assigned.
    expect(m.isAlive(0x7fffffff)).toBe(false);
  });

  it("scans ports with plain netstat -ano, so an IPv6 listener is visible", async () => {
    // `netstat -p TCP` filters to IPv4 ONLY, and Vite binds "localhost" which
    // resolves to ::1 here — so the listener that actually blocks a restart shows
    // up as [::1]:5173 and a `-p TCP` scan never sees it. This is a source
    // assertion because reproducing an IPv6 bind in a unit test proves less than
    // pinning the flag that was wrong.
    const src = fs.readFileSync(
      path.join(__dirname, "..", "processResidue.ts"),
      "utf-8",
    );
    expect(src).toContain('"netstat", ["-ano"]');
    expect(src).not.toContain('"-p", "TCP"');

    const m = await fresh();
    expect(Array.isArray(m.pidsOnPort(5173))).toBe(true); // must not throw
  });
});
