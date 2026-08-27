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
//
//          L1 IS OBJECT-TYPE AWARE, and it has to be. The surface is not one
//          flat list of names: `onSheetChange` is declared by WorkbookContext,
//          `onClick` by ButtonContext, and a chain checked against the UNION of
//          every context is checked against a context no script is ever handed.
//          A button draft calling `context.onSheetChange` passed every check
//          here and then threw on the first line of `setup`, because at mount
//          that member was `undefined`. Narrowing is by REACHABILITY — a member
//          is legal only if this object can obtain the thing it hangs off —
//          which is what makes `context.cell.setValue` on a button an error
//          rather than a clean pass. When the caller names no object type, or
//          names one the generated table does not know, NOTHING is narrowed:
//          this is a linter, and its worst outcome must be missing a defect,
//          never inventing one.

import { analyzeScript, type AnalyzedScript } from "./analyze";
import { capabilitiesFor, surfaceMember, surfaceScopeFor, wrongContextMember } from "./surface";
import { CAPABILITY_ID_SET } from "../capabilityIds";
import { topLevelFunctions } from "../worker/debugInstrument";

export type FindingSeverity = "error" | "notice";

export interface ValidationFinding {
  severity: FindingSeverity;
  /** Stable machine code, for tests and for the repair prompt builder. */
  code:
    | "parse-error"
    | "no-entry-point"
    | "unknown-member"
    | "wrong-object-type"
    | "undeclared-capability"
    | "unknown-capability-id"
    | "declared-not-observed"
    | "no-run-target";
  message: string;
  line?: number;
  /** Chains the author probably meant, when the finding is `unknown-member`. */
  suggestions?: string[];
  capability?: string;
  /**
   * The object types that CAN call the member, when the finding is
   * `wrong-object-type`.
   *
   * Carried as data, not only inside the sentence, because the repair a model
   * needs is not a better spelling: the script is aimed at the wrong object, and
   * a caller that wants to offer "attach it to a sheet instead" must be able to
   * read the list rather than parse the prose back out of the message.
   */
  objectTypes?: string[];
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
  /**
   * The object type the script was checked AS, when it was narrowed to one.
   *
   * Undefined means nothing was narrowed — either the caller named no object
   * type, or it named one the generated table does not know — and every finding
   * in this report was therefore judged against the whole surface. A consumer
   * that wants to say "this member is a sheet's, not a button's" must know which
   * of the two happened.
   */
  objectType?: string;
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

/**
 * Check a drafted script.
 *
 * @param source     The whole file, as the author would save it.
 * @param objectType The object the script will be attached to ("button",
 *                   "sheet", …). Given one, L1 checks reach against the members
 *                   THAT object's context can actually obtain; omitted — or an
 *                   object type the generated table does not know — it checks
 *                   against the whole surface, which is the fail-open direction.
 */
export function validateScriptSource(source: string, objectType?: string): ValidationReport {
  const analysis = analyzeScript(source);
  const findings: ValidationFinding[] = [];
  const scope = surfaceScopeFor(objectType);
  /** What the report says it checked — undefined when nothing was narrowed. */
  const attachedTo = scope.objectType;

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
      objectType: attachedTo,
      analysis,
    };
  }

  // ---- Entry point --------------------------------------------------------
  // The wrapper's tail is `typeof setup === "function" ? setup(context) : undefined`
  // (worker/debugWrapper.ts), so a script without one MOUNTS AND DOES NOTHING:
  // the module body runs, no error is raised, and nothing happens. It is the
  // quietest failure the system has.
  //
  // Found by the eval corpus (M5): a real 3B model answered with a bare
  // top-level `onClick(() => { ... })` and no `setup`, and every check passed.
  if (!analysis.hasSetup) {
    findings.push({
      severity: "error",
      code: "no-entry-point",
      message:
        "The script defines no `setup` function, so nothing would run when it is mounted. " +
        "Wrap the logic in `export function setup(context) { ... }`, register event handlers " +
        "through the object's hooks (a button's click is `context.onClick(handler)`), and use " +
        "`context.expose(name, handler)` only for named commands.",
    });
  }

  // ---- Run target ----------------------------------------------------------
  // NOTICE, NEVER AN ERROR. `export function setup(context) {
  //   context.onBeforeSave(() => ({ cancel: true })); }` has exactly one
  // top-level function and is CORRECT, as is an onRender painter. This file's
  // own header (:43-45) says its worst outcome must be missing a defect, never
  // inventing one.
  //
  // Computed with `topLevelFunctions` — the SAME scanner
  // `buildRunTargetRegistrations` uses (debugWrapper.ts:320) — so the warning
  // and the registrar cannot disagree about what a run target is.
  //
  // SUPPRESSED for the hooks whose RETURN VALUE is the point. `onRender` and
  // every `onBefore*` are the shapes where hook-only is most often correct, and
  // where a refactor can silently disarm a veto in a way `report.ok` cannot see.
  const runTargets = topLevelFunctions(source).filter((f) => f.name !== "setup");
  const exposes = analysis.calls.some((c) => c.chain === "expose" || c.chain.endsWith(".expose"));
  const vetoHook = analysis.calls.some((c) => {
    const leaf = c.chain.split(".").pop() ?? "";
    return leaf === "onRender" || leaf.startsWith("onBefore");
  });
  if (analysis.hasSetup && runTargets.length === 0 && !exposes && !vetoHook) {
    findings.push({
      severity: "notice",
      code: "no-run-target",
      message:
        "Nothing in this script can be started on demand: setup() is the entry point the mount " +
        "already ran, so it is not a run target, and there is no other top-level function and no " +
        "context.expose(...) command. The script still works when its hooks fire. To be able to " +
        "press Run (F5) in the editor, move the work into a top-level function that takes no " +
        "arguments -- async function run() { ... } -- and have setup() call it.",
    });
  }

  // ---- L1 -----------------------------------------------------------------
  const reported = new Set<string>();
  for (const call of analysis.calls) {
    if (scope.isKnownChain(call.chain)) continue;
    // A bare namespace is not a call target but is legal to reference.
    if (scope.isKnownPrefix(call.chain)) continue;
    // `api.getCellValue(...).toString()` -> the tail belongs to the returned
    // VALUE, not to the script surface.
    if (scope.callableAncestorOf(call.chain) !== undefined) continue;
    if (reported.has(call.chain)) continue;
    reported.add(call.chain);

    // REAL, BUT NOT HERE. A member that exists on some OTHER object's context is
    // a different defect from an invented one, and it has a different repair:
    // there is no better spelling to reach for, the script is aimed at the wrong
    // object. Told only "not part of the object-script API", a model rewrites the
    // name it already had right and the repair loop cannot converge.
    const wrong = wrongContextMember(call.chain, scope);
    if (wrong) {
      findings.push({
        severity: "error",
        code: "wrong-object-type",
        message:
          `\`context.${wrong.chain}\` is not part of the context a ${attachedTo ?? "this object"} ` +
          `script is handed. It is declared by ${wrong.ifaces.join(", ")}, so only a script ` +
          `attached to ${wrong.objectTypes.join(" or ")} can call it.`,
        line: call.line,
        objectTypes: wrong.objectTypes,
        suggestions: scope.suggest(call.chain),
      });
      continue;
    }

    findings.push({
      severity: "error",
      code: "unknown-member",
      message: `\`context.${call.chain}\` is not part of the object-script API`,
      line: call.line,
      suggestions: scope.suggest(call.chain),
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
    objectType: attachedTo,
    analysis,
  };
}

export { analyzeScript, parseDeclaredCapabilities } from "./analyze";
export type { AnalyzedScript } from "./analyze";
export { SURFACE_SIZE, suggestChains, surfaceScopeFor } from "./surface";
export type { SurfaceScope } from "./surface";
