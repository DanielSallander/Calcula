//! FILENAME: app/extensions/ScriptableObjects/lib/debugger.ts
// PURPOSE: Basic debugging support for object scripts.
// CONTEXT: Provides breakpoint management and variable inspection.
//          Does NOT implement full step-through (would require a debug protocol).
//          Instead, scripts can call `context.log()` for inspection, and the
//          debugger injects console.log calls at breakpoint lines before execution.

import { emitAppEvent } from "@api/events";

// ============================================================================
// Types
// ============================================================================

export interface Breakpoint {
  scriptId: string;
  line: number;
  enabled: boolean;
}

export interface DebugSnapshot {
  scriptId: string;
  line: number;
  timestamp: number;
  variables: Record<string, string>;
}

// ============================================================================
// State
// ============================================================================

const breakpoints = new Map<string, Breakpoint[]>();

/** Get all breakpoints for a script. */
export function getBreakpoints(scriptId: string): Breakpoint[] {
  return breakpoints.get(scriptId) ?? [];
}

/** Toggle a breakpoint on a line. Returns the updated breakpoints. */
export function toggleBreakpoint(scriptId: string, line: number): Breakpoint[] {
  let bps = breakpoints.get(scriptId) ?? [];
  const existing = bps.find((bp) => bp.line === line);
  if (existing) {
    bps = bps.filter((bp) => bp.line !== line);
  } else {
    bps = [...bps, { scriptId, line, enabled: true }];
  }
  breakpoints.set(scriptId, bps);
  emitAppEvent("objectscript:breakpoints-changed", { scriptId, breakpoints: bps });
  return bps;
}

/** Clear all breakpoints for a script. */
export function clearBreakpoints(scriptId: string): void {
  breakpoints.delete(scriptId);
  emitAppEvent("objectscript:breakpoints-changed", { scriptId, breakpoints: [] });
}

/**
 * Instrument a script source with logging at breakpoint lines.
 * This is a lightweight alternative to a full debug protocol —
 * it injects `context.log("[BP L{line}]", ...)` calls before breakpoint lines.
 */
export function instrumentSource(scriptId: string, source: string): string {
  const bps = getBreakpoints(scriptId).filter((bp) => bp.enabled);
  if (bps.length === 0) return source;

  const lines = source.split("\n");
  const bpLines = new Set(bps.map((bp) => bp.line));

  const instrumented = lines.map((line, idx) => {
    const lineNum = idx + 1;
    if (bpLines.has(lineNum)) {
      // Inject a log call before this line
      const indent = line.match(/^(\s*)/)?.[1] ?? "";
      return `${indent}context.log("[BP L${lineNum}]", "reached breakpoint at line ${lineNum}");\n${line}`;
    }
    return line;
  });

  return instrumented.join("\n");
}

/** Clear all breakpoints across all scripts. */
export function clearAllBreakpoints(): void {
  breakpoints.clear();
}
