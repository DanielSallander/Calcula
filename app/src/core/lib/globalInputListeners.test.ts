//! FILENAME: app/src/core/lib/globalInputListeners.test.ts
// PURPOSE: Give the census teeth. Two failures are possible here and they are
//          the two ways this went wrong before:
//
//            1. A NEW DOOR NOBODY LISTED. The last two rounds each closed the
//               doors they knew about, and a third turned up in a layer nobody
//               had enumerated — `api/keybindings.ts`, a capture-phase `window`
//               keydown that pre-empted every Core guard and cleared the user's
//               cells on Delete. This test re-derives the list from the source
//               tree on every run and fails if it and the census disagree in
//               EITHER direction, so an unlisted listener cannot ship and a row
//               for a listener that has been deleted cannot rot.
//
//            2. A GUARD SILENTLY REMOVED. A row that says "claim-guarded" is a
//               claim about the code, and a claim nothing checks is the "claim
//               nothing can honour" this whole rule was invented to replace. So
//               every claim-guarded file is required to actually reference one
//               of the claim predicates.
//
//          The scan is deliberately the same shape as the one that produced the
//          census, and deliberately CRUDE (a regex over the file text): the
//          point is to notice a new listener, not to type-check it. A listener
//          bound through an indirection this regex cannot see is a listener a
//          reviewer cannot see either.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  GLOBAL_INPUT_LISTENERS,
  CLAIM_PREDICATES,
  claimGuardedFiles,
  verdictCounts,
} from "./globalInputListeners";

/** app/ — this file is app/src/core/lib/. */
const APP_ROOT = path.resolve(__dirname, "../../..");
const SCANNED_DIRS = ["src", "extensions"];

/** The event types a claim could ever be about. Keep in sync with the SCOPE
 *  paragraph in globalInputListeners.ts. */
const INPUT_EVENTS = new Set([
  "keydown", "keyup", "keypress",
  "mousedown", "mouseup", "mousemove", "click", "dblclick", "auxclick",
  "contextmenu", "wheel",
  "pointerdown", "pointerup", "pointermove", "pointercancel",
  "touchstart", "touchmove", "touchend",
  "dragover", "dragstart", "drop",
  "paste", "copy", "cut",
]);

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name === "dist") {
          continue;
        }
        walk(p);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
        out.push(p);
      }
    }
  };
  for (const d of SCANNED_DIRS) walk(path.join(APP_ROOT, d));
  return out;
}

/** `file|event` for every window/document input listener in the tree. */
function scanForListeners(): Set<string> {
  const re = /\b(?:window|document)\.addEventListener\(\s*(["'`])([a-zA-Z]+)\1/g;
  const found = new Set<string>();
  for (const abs of sourceFiles()) {
    const src = fs.readFileSync(abs, "utf8");
    if (!src.includes("addEventListener")) continue;
    const rel = path.relative(APP_ROOT, abs).split(path.sep).join("/");
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      if (INPUT_EVENTS.has(m[2])) found.add(`${rel}|${m[2]}`);
    }
  }
  return found;
}

describe("global input listener census", () => {
  it("lists every window/document key or pointer listener in the app — and nothing that is gone", () => {
    const scanned = scanForListeners();
    const censused = new Set(GLOBAL_INPUT_LISTENERS.map((l) => `${l.file}|${l.event}`));

    const missing = [...scanned].filter((k) => !censused.has(k)).sort();
    const stale = [...censused].filter((k) => !scanned.has(k)).sort();

    // Named separately so the failure says WHICH of the two problems it is.
    expect({ unlistedListeners: missing }).toEqual({ unlistedListeners: [] });
    expect({ censusRowsWithNoListener: stale }).toEqual({ censusRowsWithNoListener: [] });
  });

  it("every claim-guarded row's file really consults a claim predicate", () => {
    const withoutGuard = claimGuardedFiles().filter((rel) => {
      const src = fs.readFileSync(path.join(APP_ROOT, rel), "utf8");
      return !CLAIM_PREDICATES.some((p) => src.includes(`${p}(`));
    });
    expect({ claimGuardedButUnguarded: withoutGuard }).toEqual({ claimGuardedButUnguarded: [] });
  });

  it("the dispatcher that pre-empts every Core door is one of them", () => {
    // Named on purpose. This is the listener the milestone was about, and a
    // census that quietly reclassified it would be the same silence again.
    const row = GLOBAL_INPUT_LISTENERS.find(
      (l) => l.file === "src/api/keybindings.ts" && l.event === "keydown",
    );
    expect(row?.verdict).toBe("claim-guarded");
  });

  it("no row is left without a reason", () => {
    const unexplained = GLOBAL_INPUT_LISTENERS.filter((l) => l.note.trim().length < 20).map(
      (l) => `${l.file}|${l.event}`,
    );
    expect(unexplained).toEqual([]);
  });

  it("every row is unique", () => {
    const keys = GLOBAL_INPUT_LISTENERS.map((l) => `${l.file}|${l.event}`);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it("reports what the census currently says", () => {
    const counts = verdictCounts();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(GLOBAL_INPUT_LISTENERS.length);
    // Not pinned to a number: the census is allowed to grow, it is just not
    // allowed to be INCOMPLETE (test 1) or to lie about a guard (test 2).
    expect(counts["claim-guarded"]).toBeGreaterThan(0);
    expect(counts["app-global"]).toBeGreaterThan(0);
  });
});
