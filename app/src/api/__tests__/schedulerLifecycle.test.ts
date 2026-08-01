//! FILENAME: app/src/api/__tests__/schedulerLifecycle.test.ts
// PURPOSE: Pin the wiring that makes a PERSISTED scheduled job actually run —
//          the one link that was missing when the `schedule` capability first
//          landed. Rust restores the schedule during open_file and is the
//          authority on what may fire, but it cannot call into a renderer
//          worker realm, so the renderer has to tick it. Nothing outside
//          scheduler.ts called `syncPump`, so a restored job sat correctly in
//          the registry and never ran: persisted, visible, and dead.
//
// CONTEXT: These are source-level assertions on purpose. The failure mode is
//          "a call site does not exist", which no amount of mocking inside the
//          scheduler module can detect — the same reason
//          backendCommands.test.ts parses lib.rs rather than trusting a list.
//          The precedent for reading real source in a test is established
//          there and in objectContextsTypings.test.ts.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const repoFile = (rel: string): string =>
  fs.readFileSync(path.resolve(__dirname, "../../..", rel), "utf8");

describe("the scheduler's clock is wired to the workbook lifecycle", () => {
  const OWNER = "extensions/ScriptableObjects/index.ts";

  it("the extension that mounts scripts also starts the pump", () => {
    // ScriptableObjects owns "this workbook's scripts are now loaded", which is
    // the only moment at which starting the pump is both correct and
    // sufficient. If this assertion fails because the wiring MOVED, move this
    // test with it — do not delete it.
    const src = repoFile(OWNER);
    expect(
      src.includes("syncSchedulerPump("),
      "nothing starts the scheduler pump after a workbook's scripts load; a job " +
        "restored from the .cala would never fire",
    ).toBe(true);
  });

  it("the pump is started AFTER the Script Security gate, not before it", () => {
    // loadAndMountScripts returns early when Script Security refuses the
    // workbook's scripts. Starting the pump above that return would tick for a
    // workbook the user declined to run (Rust's `due` would still refuse every
    // job, but the renderer must not be the only thing standing there).
    const src = repoFile(OWNER);
    const gate = src.indexOf("ensureScriptsAllowed(");
    const start = src.indexOf("syncSchedulerPump(");
    expect(gate).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(gate);
  });

  it("the pump is stopped when the workbook goes away", () => {
    // A tick that outlives its workbook would report the PREVIOUS document's
    // mounted scripts against the NEW document's registry.
    const src = repoFile(OWNER);
    const stops = src.split("stopSchedulerPump(").length - 1;
    expect(
      stops,
      "expected stopSchedulerPump on workbook open, new, close and deactivate",
    ).toBeGreaterThanOrEqual(4);
    for (const marker of ["AppEvents.AFTER_OPEN", "AppEvents.AFTER_NEW", "AppEvents.BEFORE_CLOSE"]) {
      expect(src.includes(marker), `${marker} handler missing`).toBe(true);
    }
  });

  it("both halves of the lifecycle are reachable from the @api barrel", () => {
    // Extensions import from @api. A lifecycle primitive reachable only through
    // a deep subpath is a primitive that the next author will not find.
    const barrel = repoFile("src/api/index.ts");
    expect(barrel).toContain("syncPump as syncSchedulerPump");
    expect(barrel).toContain("stopSchedulerPump");
  });

  it("the transparency surface is reachable from the @api barrel too", () => {
    // Seeing what runs and being able to stop it are one promise; they must not
    // live behind different doors.
    const barrel = repoFile("src/api/index.ts");
    for (const name of [
      "getWorkbookScheduledJobs",
      "summarizeScheduledJobs",
      "cancelScheduledJob",
      "setScheduledJobEnabled",
    ]) {
      expect(barrel, `${name} is not exported from @api`).toContain(name);
    }
  });
});

describe("the scheduler's Rust half keeps no orphan registry entries", () => {
  it("deleting an object script drops its jobs", () => {
    // Defence in depth: a deleted script's job can neither fire (it never
    // mounts) nor persist (export filters on the workbook's script index), but
    // it would linger in the transparency panel as a live-looking job for code
    // that no longer exists.
    const src = repoFile("src-tauri/src/scripting/object_script_commands.rs");
    expect(src).toContain("scheduler::remove_script_jobs");
    // Both delete paths: the single-script command and the instance prune.
    expect(src.split("scheduler::remove_script_jobs").length - 1).toBeGreaterThanOrEqual(2);
  });

  it("pausing a job is audited, exactly like cancelling one", () => {
    // "One audit trail spans all script activity" is false the moment a user
    // action that stops (or restarts) automation leaves no entry.
    const src = repoFile("src-tauri/src/scripting/scheduler.rs");
    const setEnabled = src.indexOf('"setEnabled" =>');
    expect(setEnabled).toBeGreaterThan(-1);
    const arm = src.slice(setEnabled, src.indexOf('"due" =>', setEnabled));
    expect(
      arm.includes("record_capability_call"),
      "the setEnabled arm does not audit; pause/resume would be invisible",
    ).toBe(true);
  });
});
