//! FILENAME: app/src/api/scriptHost/scriptValidation/index.ts
// PURPOSE: Validate a drafted object script BEFORE a human is asked to read it.
//          Three checks, none of which costs an inference call:
//            L0  does it parse
//            L1  does it only call members that exist
//            L2  do its `// @capability` pragmas match what it actually calls
// CONTEXT: docs/design/local-model-script-authoring.md §5, §5a, §11.2.
//
//          THIS IS A LINTER, NOT A SANDBOX. The security boundary is and stays
//          the broker at dispatch time (broker.ts:162 refuses any capability
//          outside the script's declared ceiling). Nothing here grants anything,
//          and a script that slips past every check is no more privileged for
//          it. What this buys is that a model's mistakes are caught by a machine
//          instead of spending a human's attention — and, for the
//          under-declaration case, caught at all: an undeclared capability does
//          not prompt at run time, it throws PermissionDenied, possibly weeks
//          later inside a schedule or a distributed report.
//
//          THE ASYMMETRY IS DELIBERATE (§11.2). A source scan is SOUND but not
//          COMPLETE: what it finds is really there; what it does not find may
//          still be there, because `context.caps[method](url)` names nothing.
//          So:
//            * calls something it did NOT declare  -> ERROR. The scanner saw a
//              real call, so this is a real defect. No false positive is
//              possible, and the repair is one free local round-trip.
//            * declared something not OBSERVED     -> NOTICE, never an error.
//              Could be computed access (correct), could be over-broad (should
//              be trimmed). A machine cannot tell; a person can.
//          Do not "simplify" this into auto-declaring the pragmas. That was
//          considered and rejected: an auto-written list always LOOKS right,
//          which removes the reviewer's ability to notice when it is not.

import { analyzeScript, type AnalyzedScript } from "./analyze";
import {
  capabilitiesFor,
  hasCallableAncestor,
  isKnownChain,
  isKnownPrefix,
  suggestChains,
  surfaceMember,
} from "./surface";
import { CAPABILITY_ID_SET } from "../capabilityIds";

export type FindingSeverity = "error" | "notice";

export interface ValidationFinding {
  severity: FindingSeverity;
  /** Stable machine code, for tests and for the repair prompt builder. */
  code:
    | "parse-error"
    | "unknown-member"
    | "undeclared-capability"
    | "unknown-capability-id"
    | "declared-not-observed";
  message: string;
  line?: number;
  /** Chains the author probably meant, when the finding is `unknown-member`. */
  suggestions?: string[];
  capability?: string;
}

export interface ValidationReport {
  /** False when any finding is an `error`. Notices never block. */
  ok: boolean;
  findings: ValidationFinding[];
  /** What the pragmas claim. */
  declared: string[];
  /** What the scan could actually see the script require. */
  observed: string[];
  /**
   * True when the script uses computed member access somewhere on a context
   * chain, so `observed` is known to be a floor rather than the whole story.
   * This is the fact that makes a `declared-not-observed` notice explicable.
   */
  hasDynamicAccess: boolean;
  analysis: AnalyzedScript;
}

/**
 * Render the report as the text handed back to a model for repair.
 *
 * Only errors are included: a notice is for the human reviewer, and feeding it
 * to the model would teach it to strip declarations it cannot prove it needs,
 * which is the opposite of what §11.2 wants.
 */
export function repairPrompt(report: ValidationReport): string {
  const errors = report.findings.filter((f) => f.severity === "error");
  if (errors.length === 0) return "";
  const lines = ["The script was not accepted. Fix these and return the whole script again:", ""];
  for (const f of errors) {
    const where = f.line ? ` (line ${f.line})` : "";
    lines.push(`- ${f.message}${where}`);
    if (f.suggestions?.length) {
      lines.push(`  Did you mean: ${f.suggestions.join(", ")}?`);
    }
  }
  return lines.join("\n");
}

export function validateScriptSource(source: string): ValidationReport {
  const analysis = analyzeScript(source);
  const findings: ValidationFinding[] = [];

  // ---- L0 -----------------------------------------------------------------
  if (!analysis.parsed) {
    findings.push({
      severity: "error",
      code: "parse-error",
      message: `The script does not parse: ${analysis.parseError?.message ?? "unknown syntax error"}`,
      line: analysis.parseError?.line,
    });
    return {
      ok: false,
      findings,
      declared: analysis.declaredCapabilities,
      observed: [],
      hasDynamicAccess: false,
      analysis,
    };
  }

  // ---- L1 -----------------------------------------------------------------
  const reported = new Set<string>();
  for (const call of analysis.calls) {
    if (isKnownChain(call.chain)) continue;
    // A bare namespace is not a call target but is legal to reference.
    if (isKnownPrefix(call.chain)) continue;
    // `api.getCellValue(...).toString()` -> the tail belongs to the returned
    // VALUE, not to the script surface.
    if (hasCallableAncestor(call.chain)) continue;
    if (reported.has(call.chain)) continue;
    reported.add(call.chain);
    findings.push({
      severity: "error",
      code: "unknown-member",
      message: `\`context.${call.chain}\` is not part of the object-script API`,
      line: call.line,
      suggestions: suggestChains(call.chain),
    });
  }

  // ---- L2 -----------------------------------------------------------------
  const observedSet = new Set<string>();
  const firstLineFor = new Map<string, number>();
  for (const call of analysis.calls) {
    for (const cap of capabilitiesFor(call.chain)) {
      observedSet.add(cap);
      if (!firstLineFor.has(cap)) firstLineFor.set(cap, call.line);
    }
  }
  const observed = [...observedSet].sort();
  const declared = analysis.declaredCapabilities;

  for (const id of declared) {
    if (!CAPABILITY_ID_SET.has(id as never)) {
      findings.push({
        severity: "error",
        code: "unknown-capability-id",
        message: `\`// @capability ${id}\` is not a recognized capability id`,
        capability: id,
      });
    }
  }

  // Uses something it did not declare: a real defect the broker WILL refuse.
  for (const cap of observed) {
    if (declared.includes(cap)) continue;
    const chain = analysis.calls.find((c) => capabilitiesFor(c.chain).has(cap as never))?.chain;
    const broker = chain ? surfaceMember(chain)?.broker : undefined;
    findings.push({
      severity: "error",
      code: "undeclared-capability",
      message:
        `\`context.${chain}\` requires the \`${cap}\` capability, which this script does not declare. ` +
        `Add \`// @capability ${cap}\` at the top of the file` +
        (broker ? ` (the broker gates it as \`${broker}\`)` : "") +
        ". Without it the call throws PermissionDenied at run time.",
      line: firstLineFor.get(cap),
      capability: cap,
    });
  }

  // Declared but not observed: information for the reviewer, never a rejection.
  const hasDynamicAccess = analysis.dynamicAccesses.length > 0;
  for (const cap of declared) {
    if (observedSet.has(cap)) continue;
    if (!CAPABILITY_ID_SET.has(cap as never)) continue; // already an error above
    const note = hasDynamicAccess
      ? " This script uses computed member access (line " +
        analysis.dynamicAccesses[0].line +
        "), which the scanner cannot follow, so the declaration may well be correct."
      : " Either it is reached in a way this scan cannot see, or the declaration is broader than the script needs.";
    findings.push({
      severity: "notice",
      code: "declared-not-observed",
      message: `\`${cap}\` is declared but no call requiring it was found.${note}`,
      capability: cap,
    });
  }

  return {
    ok: !findings.some((f) => f.severity === "error"),
    findings,
    declared,
    observed,
    hasDynamicAccess,
    analysis,
  };
}

export { analyzeScript, parseDeclaredCapabilities } from "./analyze";
export type { AnalyzedScript } from "./analyze";
export { SURFACE_SIZE, suggestChains } from "./surface";
