//! FILENAME: app/extensions/ScriptableObjects/__tests__/debugPanel.test.ts
// PURPOSE: The gutter must be HONEST. A solid dot means "execution will stop
//          here"; anything else must be visibly different and must say why. A
//          breakpoint that looks armed and never fires is the single worst bug
//          a debugger UI can have.

import { describe, it, expect } from "vitest";
import { breakpointShift, computeDebugDecorations, statusLabel } from "../components/DebugPanel";
import type { DebugSessionState } from "../lib/debugger";

function session(partial: Partial<DebugSessionState>): DebugSessionState {
  return {
    scriptId: "s1",
    scriptName: "Test",
    status: "running",
    // The object-script default: the mount called setup. A module macro's
    // session is the false case, and the tests below name it explicitly.
    autoInvokeSetup: true,
    breakpoints: [],
    ready: null,
    paused: null,
    lastSnapshot: null,
    activity: null,
    lastActivity: null,
    triggers: [],
    error: null,
    ...partial,
  };
}

describe("gutter decorations", () => {
  it("shows breakpoints as not-yet-armed before a session exists", () => {
    const [d] = computeDebugDecorations([4], null);
    expect(d.glyphClassName).toBe("breakpoint-glyph");
    expect(d.hover).toMatch(/Start debugging/);
  });

  it("marks a breakpoint on a pausable line as armed", () => {
    const s = session({
      ready: { instrumented: true, pausableLines: [4], snapshotLines: [], promotedFunctions: [] },
    });
    const [d] = computeDebugDecorations([4], s);
    expect(d.glyphClassName).toBe("breakpoint-glyph");
    expect(d.hover).toMatch(/will pause/);
  });

  it("marks a breakpoint in a SYNCHRONOUS function as unverified, and says why", () => {
    const s = session({
      ready: { instrumented: true, pausableLines: [], snapshotLines: [9], promotedFunctions: [] },
    });
    const [d] = computeDebugDecorations([9], s);
    expect(d.glyphClassName).toBe("breakpoint-glyph-unverified");
    expect(d.hover).toMatch(/SYNCHRONOUS/);
    expect(d.hover).toMatch(/async/);
  });

  it("marks a breakpoint on a line with no statement as unverified", () => {
    const s = session({
      ready: { instrumented: true, pausableLines: [2], snapshotLines: [], promotedFunctions: [] },
    });
    const [d] = computeDebugDecorations([7], s);
    expect(d.glyphClassName).toBe("breakpoint-glyph-unverified");
    expect(d.hover).toMatch(/No statement starts on line 7/);
  });

  it("adds a distinct paused-line marker", () => {
    const s = session({
      status: "paused",
      ready: { instrumented: true, pausableLines: [4], snapshotLines: [], promotedFunctions: [] },
      paused: { line: 4, reason: "breakpoint", variables: [], callStack: [], waiting: 0 },
    });
    const decos = computeDebugDecorations([4], s);
    const pausedMarker = decos.find((d) => d.glyphClassName === "debug-paused-glyph");
    expect(pausedMarker?.line).toBe(4);
    expect(pausedMarker?.lineClassName).toBe("debug-paused-line");
  });
});

describe("the status badge must never claim work is happening", () => {
  it("says WAITING, not Running, for a script that is idle between triggers", () => {
    const s = session({
      status: "waiting",
      triggers: [
        {
          id: "hook:onClick",
          kind: "hook",
          name: "onClick",
          description: "a click on it (the button this script is attached to)",
          fireable: true,
        },
      ],
    });
    expect(statusLabel(s)).toBe("Waiting for a trigger");
    expect(statusLabel(s)).not.toMatch(/running/i);
  });

  it("says FINISHED for a script that ran to completion with nothing to restart it", () => {
    expect(statusLabel(session({ status: "finished" }))).toBe("Finished");
  });

  it("NAMES what is running while something really is", () => {
    const s = session({ status: "running", activity: { label: "onClick" } });
    expect(statusLabel(s)).toBe("Running onClick");
  });

  it("falls back to a bare Running when the realm did not name the execution", () => {
    expect(statusLabel(session({ status: "running" }))).toBe("Running");
  });

  it("says setup() failed rather than pretending the session is live", () => {
    const s = session({ status: "failed", error: "button is not defined" });
    expect(statusLabel(s)).toBe("setup() failed");
  });

  it("still reports the paused line", () => {
    const s = session({
      status: "paused",
      paused: { line: 12, reason: "breakpoint", variables: [], callStack: [], waiting: 0 },
    });
    expect(statusLabel(s)).toBe("Paused — line 12");
  });
});

// ============================================================================
// An INERT mount (a module macro) executed NOTHING when the session opened, so
// the badge must not say "Paused — line N" (which is what the mount-time
// execution used to produce), must not say "Running", and must not claim
// "setup() finished" either. It says the script is ready and nothing has run.
// ============================================================================

describe("the badge after an inert mount", () => {
  const macroTrigger = {
    id: "method:monthlyClose",
    kind: "method" as const,
    name: "monthlyClose",
    description: "run monthlyClose() from the top",
    fireable: true,
    runTarget: true,
  };

  it("says nothing has run yet — not Paused, not Running, not Waiting-for-a-trigger", () => {
    const s = session({
      status: "waiting",
      autoInvokeSetup: false,
      triggers: [macroTrigger],
    });
    expect(statusLabel(s)).toBe("Ready — nothing has run yet");
    expect(statusLabel(s)).not.toMatch(/paused|running/i);
  });

  it("reverts to the ordinary idle wording once the user HAS run something", () => {
    const s = session({
      status: "waiting",
      autoInvokeSetup: false,
      triggers: [macroTrigger],
      lastActivity: { label: "monthlyClose()" },
    });
    expect(statusLabel(s)).toBe("Waiting for a trigger");
  });

  it("says NOTHING TO RUN — not 'setup() failed' — when an inert mount has no run target", () => {
    const s = session({
      status: "failed",
      autoInvokeSetup: false,
      error: "no top-level function declaration was found",
    });
    expect(statusLabel(s)).toBe("Nothing to run");
  });

  it("leaves the object-script wording alone (the scope guard)", () => {
    const s = session({ status: "waiting", autoInvokeSetup: true, triggers: [macroTrigger] });
    expect(statusLabel(s)).toBe("Waiting for a trigger");
  });
});

describe("breakpoint re-anchoring", () => {
  it("reports the shift for an inserted line", () => {
    expect(breakpointShift({ range: { startLineNumber: 5, endLineNumber: 5 }, text: "\n" })).toEqual({
      fromLine: 6,
      delta: 1,
    });
  });

  it("reports the shift for a multi-line paste", () => {
    expect(
      breakpointShift({ range: { startLineNumber: 2, endLineNumber: 2 }, text: "a\nb\nc" }),
    ).toEqual({ fromLine: 3, delta: 2 });
  });

  it("reports a negative shift for deleted lines", () => {
    expect(breakpointShift({ range: { startLineNumber: 3, endLineNumber: 6 }, text: "" })).toEqual({
      fromLine: 4,
      delta: -3,
    });
  });

  it("ignores an edit within one line", () => {
    expect(
      breakpointShift({ range: { startLineNumber: 3, endLineNumber: 3 }, text: "hello" }),
    ).toBeNull();
  });
});
