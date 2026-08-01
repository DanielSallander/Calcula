//! FILENAME: app/extensions/ScriptableObjects/__tests__/debugPanel.test.ts
// PURPOSE: The gutter must be HONEST. A solid dot means "execution will stop
//          here"; anything else must be visibly different and must say why. A
//          breakpoint that looks armed and never fires is the single worst bug
//          a debugger UI can have.

import { describe, it, expect } from "vitest";
import { breakpointShift, computeDebugDecorations } from "../components/DebugPanel";
import type { DebugSessionState } from "../lib/debugger";

function session(partial: Partial<DebugSessionState>): DebugSessionState {
  return {
    scriptId: "s1",
    scriptName: "Test",
    status: "running",
    breakpoints: [],
    ready: null,
    paused: null,
    lastSnapshot: null,
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
