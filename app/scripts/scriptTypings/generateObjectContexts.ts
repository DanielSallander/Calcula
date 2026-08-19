//! FILENAME: app/scripts/scriptTypings/generateObjectContexts.ts
// PURPOSE: Generate app/extensions/ScriptableObjects/objectContexts.d.ts — the
//          ONLY extraLib Monaco loads for object scripts — from the two places
//          the surface really lives: the worker context shim (shape) and the
//          broker ALLOWLIST (policy + the `desc` a user is shown at consent).
// CONTEXT: Calcula's authoring pitch is "the object browser is accurate by
//          construction", which a hand-maintained .d.ts cannot deliver: the
//          shim grew biQuery / biSql / cube.* / connector.* / a range + chartMark
//          context while the typings did not, so those were uncallable as far as
//          IntelliSense was concerned. This module makes that class of drift a
//          BUILD FAILURE rather than a silent loss.
//
//          It is not a full type synthesizer, and deliberately so. Prose,
//          parameter names and parameter types live in a hand-authored TEMPLATE
//          (objectContexts.template.d.ts) because no amount of introspection can
//          invent "reading display strings and writing them back replaces every
//          formula with its text". What is DERIVED is everything that can drift
//          mechanically:
//            1. MEMBERSHIP  — every member the shim exposes must be declared,
//                             and every member declared must exist on the shim.
//                             Both directions, both tiers, every objectType.
//            2. POLICY DOCS — each member's broker method, tier, required
//                             capability and limits, with the allowlist `desc`
//                             verbatim, spliced into its JSDoc so hovering a
//                             method in Monaco says what it can touch.
//            3. THE ROSTERS — the objectType -> interface table and the
//                             capability -> methods table, emitted at markers.

import {
  probeSurface,
  NAMED_SUBTREES,
  OBJECT_TYPE_INTERFACES,
  type ProbedMember,
  type ProbeResult,
} from "./probeShim";
import { readTemplate, type DeclaredMember, type TemplateModel } from "./declarations";
import { ALLOWLIST, type MethodPolicy } from "../../src/api/scriptHost/allowlist";

export const OBJECT_TYPE_MARKER = "// @generated:object-type-table";
export const CAPABILITY_MARKER = "// @generated:capability-table";
/** Everything above this line in the template is instructions to the AUTHOR and
 *  never reaches the generated file. */
export const HEADER_MARKER = "// @generated:template-header-end";
export const CONTEXT_MAP_MARKER = "// @generated:context-type-map";

export interface GenerateResult {
  /** The finished .d.ts text. Empty when `problems` is non-empty. */
  output: string;
  /**
   * The finished `scriptSurfacePolicy.ts` text — the same probe + allowlist
   * facts as the JSDoc splice, but as DATA the app can read at runtime. Empty
   * when `problems` is non-empty, for the same reason `output` is: a knowingly
   * wrong map is worse than no map.
   */
  policyOutput: string;
  /** Human-readable drift reports; a non-empty list must fail the build. */
  problems: string[];
  /** Interfaces the probe reached but the template never declares. */
  unverified: string[];
  stats: { interfaces: number; members: number; documented: number; policyRows: number };
}

// ============================================================================
// Policy rendering
// ============================================================================

function limitText(limits: Record<string, number> | undefined): string {
  if (!limits) return "";
  const parts = Object.entries(limits).map(([k, v]) => `${k} ${v.toLocaleString("en-US")}`);
  return parts.length ? ` Limits: ${parts.join(", ")}.` : "";
}

/**
 * The generated tail for one member: what the broker will let this call do,
 * in the allowlist's own words. The `desc` string is the SAME text the consent
 * dialog and the transparency panel render, so an author reading a tooltip and
 * a user reading a permission prompt are reading one sentence.
 */
function policyLines(member: ProbedMember): string[] {
  if (!member.broker) return [];
  const policy: MethodPolicy | undefined = ALLOWLIST[member.broker];
  if (!policy) return [];
  const lines: string[] = [];
  lines.push(`Calcula policy (generated): ${policy.desc}.`);
  const bits = [`broker \`${member.broker}\``];
  if (member.aspect) bits.push(`aspect \`${member.aspect}\``);
  bits.push(`${policy.tier} tier`);
  bits.push(`class ${policy.class}`);
  if (policy.capability) bits.push(`requires the \`${policy.capability}\` capability`);
  lines.push(`Reach: ${bits.join(", ")}.${limitText(policy.limits)}`);
  return lines;
}

// ============================================================================
// Splicing
// ============================================================================

interface Edit {
  start: number;
  end: number;
  text: string;
}

function jsDocInsertion(decl: DeclaredMember, lines: string[]): Edit {
  const indent = decl.indent;
  const body = lines.map((l) => `${indent} * ${l}`).join("\n");
  if (decl.jsDoc) {
    // Append to the existing block: keep every hand-written word, add the
    // derived paragraph after a blank comment line.
    const trimmed = decl.jsDoc.text.replace(/\s*\*\/\s*$/, "");
    return {
      start: decl.jsDoc.start,
      end: decl.jsDoc.end,
      text: `${trimmed}\n${indent} *\n${body}\n${indent} */`,
    };
  }
  return {
    start: decl.start,
    end: decl.start,
    text: `/**\n${body}\n${indent} */\n${indent}`,
  };
}

function applyEdits(source: string, edits: Edit[]): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let out = source;
  for (const edit of ordered) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

// ============================================================================
// Generated roster blocks
// ============================================================================

function objectTypeTable(probe: ProbeResult): string {
  const rows = probe.objectTypes.map(([objectType, iface]) => `//   ${objectType.padEnd(12)} -> ${iface}`);
  return [
    "// Object types the script host can mount, and the context interface each",
    "// one receives (generated from contextShims.ts buildTyped).",
    ...rows,
  ].join("\n");
}

/**
 * The objectType -> context interface map, as a real TYPE.
 *
 * This is what finally binds forty interfaces to something an author can reach.
 * `setup(context)` takes its context as a PARAMETER, and TypeScript will not
 * contextually type a parameter from an ambient interface — so before this,
 * every declaration in this file was unreachable: typing `context.` in the
 * editor produced nothing at all. The editor now emits, per open script,
 *
 *   declare type ObjectScriptContext = ObjectScriptContextByType["slicer"];
 *
 * and a one-line JSDoc annotation on `setup` resolves the whole surface.
 */
function contextTypeMap(probe: ProbeResult): string {
  const rows = probe.objectTypes.map(([objectType, iface]) => `  ${objectType}: ${iface};`);
  return [
    "/**",
    " * Every objectType a script can be attached to, mapped to the context",
    " * interface `setup(context)` receives for it (generated from",
    " * contextShims.ts).",
    " *",
    " * The editor narrows this to the script you have open and publishes the",
    " * result as `ObjectScriptContext`. Annotate your setup function with",
    ' * `@param {ObjectScriptContext} context` in a JSDoc block and the whole',
    " * surface below becomes typed: completions, parameter hints, and the",
    " * generated broker-policy text on hover.",
    " */",
    "declare interface ObjectScriptContextByType {",
    ...rows,
    "}",
  ].join("\n");
}

function capabilityTable(): string {
  const byCapability = new Map<string, string[]>();
  for (const [method, policy] of Object.entries(ALLOWLIST)) {
    if (!policy.capability) continue;
    const list = byCapability.get(policy.capability) ?? [];
    list.push(method);
    byCapability.set(policy.capability, list);
  }
  const rows: string[] = [];
  for (const capability of [...byCapability.keys()].sort()) {
    rows.push(`//   ${capability}`);
    for (const method of byCapability.get(capability)!.sort()) {
      rows.push(`//     - ${method}: ${ALLOWLIST[method].desc}`);
    }
  }
  return [
    "// Capabilities an object script can declare with `// @capability <id>`, and",
    "// the broker methods each one unlocks (generated from allowlist.ts). A call",
    "// without its grant rejects with CapabilityRequired; the user is asked with",
    "// the exact sentence shown here.",
    ...rows,
  ].join("\n");
}

// ============================================================================
// The surface policy map (consumed by the app at runtime)
// ============================================================================

const POLICY_BANNER = `// =============================================================================
// GENERATED FILE - DO NOT EDIT.
// =============================================================================
// Produced by:  npm run gen:script-typings
// Generator:    app/scripts/scriptTypings/generateObjectContexts.ts
// Shape source: app/src/api/scriptHost/worker/contextShims.ts   (probed at build)
// Policy source app/src/api/scriptHost/allowlist.ts             (tier/capability)
//
// WHAT THIS IS: the author-facing script surface as DATA — every member an
// object script can call, the broker method it dispatches to, and the capability
// the broker will demand for it. Same facts the JSDoc splice in
// objectContexts.d.ts renders as prose, in a form the running app can index.
//
// WHY IT EXISTS: the draft validator (app/src/api/scriptHost/scriptValidation)
// has to answer two questions about a script it has never seen — "is this a real
// method?" and "which capabilities does calling it require?" — and neither can be
// answered from a hand-written list without drifting from the broker that
// actually enforces. Design: docs/design/local-model-script-authoring.md §5a.
//
// The .d.ts and this file are emitted from ONE probe in ONE pass, so they cannot
// disagree with each other; objectContextsTypings.test.ts fails the build when
// either stops matching the shim.
// =============================================================================
`;

/** One callable member of the author-facing object-script surface. */
export interface SurfaceMemberRow {
  /**
   * The member-name sequence an author actually writes, rooted at the context
   * and with call parentheses removed: `caps.storage.get`, `api.chart.setSpec`,
   * `range.setValue`.
   *
   * Calls are erased on BOTH sides -- here and in the validator's AST walk -- so
   * `context.api.chart("c1").setSpec(s)` reduces to `api.chart.setSpec` and
   * matches. Erasing them is what lets a purely syntactic walk follow a handle
   * with no type inference at all.
   */
  chain: string;
  iface: string;
  /** Path within its own interface, e.g. "get" on ScriptStorageApi. */
  path: string;
  /**
   * The allowlist key it dispatches to, e.g. "cap.fetch". Absent for members
   * that only read a worker-local mirror and cross no policy boundary.
   *
   * Those are included anyway, and must be: the reach check flags a call it
   * cannot find, so a surface missing `objectId` or `log` would reject valid
   * scripts. A false positive here rejects the user's work, which is worse than
   * the miss it would be trading against.
   */
  broker?: string;
  tier?: string;
  /** The capability the broker demands, when it demands one. */
  capability?: string;
}

/**
 * Collect every probed member that dispatches to an allowlisted broker method.
 *
 * Members with no `broker` are skipped: they read a worker-local mirror and
 * cross no policy boundary, so they are neither capability-bearing nor useful
 * for reach checking. Rows are deduplicated on the whole tuple — the same path
 * is reachable from many interfaces through `extends`, and the validator cares
 * about the path, not which context re-exposes it.
 */
/**
 * Where each interface hangs off a context root, with call parens erased.
 *
 * `NAMED_SUBTREES` is the probe's OWN answer to "this sub-object is its own
 * interface", so it is also the only honest way to rebuild the chain an author
 * types. An interface can hang in several places -- `ScriptRange` is reachable
 * as `range()`, `cell()` and `api.table().range()` -- so every prefix is kept
 * and the member is emitted once per chain.
 */
function ifacePrefixes(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (iface: string, prefix: string) => {
    const list = out.get(iface) ?? [];
    if (!list.includes(prefix)) list.push(prefix);
    out.set(iface, list);
  };
  // Root contexts are reached as a bare `context.<member>`.
  for (const [, iface] of OBJECT_TYPE_INTERFACES) if (iface) add(iface, "");
  add("BaseObjectContext", "");
  for (const [path, iface] of NAMED_SUBTREES) add(iface, path.replace(/\(\)/g, ""));
  return out;
}

export function collectSurfaceRows(probe: ProbeResult): SurfaceMemberRow[] {
  const prefixes = ifacePrefixes();
  const seen = new Set<string>();
  const rows: SurfaceMemberRow[] = [];
  for (const [ifaceName, probed] of [...probe.interfaces].sort((a, b) => a[0].localeCompare(b[0]))) {
    // An interface nothing hangs off a context yields no row: a chain that
    // cannot be written cannot be validated.
    const roots = prefixes.get(ifaceName);
    if (!roots) continue;
    for (const [path, member] of [...probed.members].sort((a, b) => a[0].localeCompare(b[0]))) {
      const policy: MethodPolicy | undefined = member.broker ? ALLOWLIST[member.broker] : undefined;
      for (const root of roots) {
        const chain = root ? `${root}.${path}` : path;
        const key = `${chain} ${member.broker ?? ""} ${policy?.capability ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          chain,
          iface: ifaceName,
          path,
          ...(member.broker ? { broker: member.broker } : {}),
          ...(policy ? { tier: policy.tier } : {}),
          ...(policy?.capability ? { capability: policy.capability } : {}),
        });
      }
    }
  }
  return rows.sort(
    (a, b) => a.chain.localeCompare(b.chain) || (a.broker ?? "").localeCompare(b.broker ?? ""),
  );
}

function surfacePolicyModule(rows: SurfaceMemberRow[]): string {
  const lines = rows.map((r) => {
    const bits = [
      `chain: ${JSON.stringify(r.chain)}`,
      `iface: ${JSON.stringify(r.iface)}`,
      `path: ${JSON.stringify(r.path)}`,
    ];
    if (r.broker) bits.push(`broker: ${JSON.stringify(r.broker)}`);
    if (r.tier) bits.push(`tier: ${JSON.stringify(r.tier)}`);
    if (r.capability) bits.push(`capability: ${JSON.stringify(r.capability)}`);
    return `  { ${bits.join(", ")} },`;
  });
  return [
    POLICY_BANNER,
    'import type { CapabilityId } from "../capabilityIds";',
    "",
    "/** One callable member of the author-facing object-script surface. */",
    "export interface SurfaceMember {",
    "  /**",
    "   * The member-name sequence an author writes, rooted at the context and",
    '   * with call parentheses removed: "caps.storage.get", "api.chart.setSpec".',
    "   * The validator erases calls from the source the same way, so",
    '   * `context.api.chart("c1").setSpec(s)` matches "api.chart.setSpec".',
    "   */",
    "  readonly chain: string;",
    "  /** The context interface that exposes it. */",
    "  readonly iface: string;",
    '  /** Path within that interface, e.g. "get" on ScriptStorageApi. */',
    "  readonly path: string;",
    "  /**",
    '   * The broker method it dispatches to, e.g. "cap.fetch". Absent for members',
    "   * that only read a worker-local mirror and cross no policy boundary; those",
    "   * are still listed, because the reach check flags what it cannot find and a",
    "   * surface missing them would reject valid scripts.",
    "   */",
    "  readonly broker?: string;",
    "  readonly tier?: string;",
    "  /** The capability the broker demands, when it demands one. */",
    "  readonly capability?: CapabilityId;",
    "}",
    "",
    "export const SCRIPT_SURFACE: readonly SurfaceMember[] = [",
    ...lines,
    "];",
    "",
  ].join("\n");
}

// ============================================================================
// Entry point
// ============================================================================

const BANNER = `// =============================================================================
// GENERATED FILE - DO NOT EDIT.
// =============================================================================
// Produced by:  npm run gen:script-typings
// Generator:    app/scripts/scriptTypings/generateObjectContexts.ts
// Prose source: app/scripts/scriptTypings/objectContexts.template.d.ts
// Shape source: app/src/api/scriptHost/worker/contextShims.ts   (probed at build)
// Policy source app/src/api/scriptHost/allowlist.ts             (desc/tier/caps)
//
// This is the ONLY extraLib Monaco loads for object scripts, so it is the whole
// of what IntelliSense knows. Editing it by hand is pointless: the next
// generation overwrites you, and objectContextsTypings.test.ts fails the build
// the moment this file stops matching the shim.
//
// Adding a method to contextShims.ts? Declare it in the TEMPLATE, then run
// \`npm run gen:script-typings\`. The generator refuses to emit while the shim
// and the typings disagree in either direction.
// =============================================================================
`;

/**
 * Generate the .d.ts from `template`, verifying it against the live shim.
 *
 * Returns problems rather than throwing so both callers can present them well:
 * the CLI prints them and exits non-zero; the lockstep test asserts they are
 * empty and shows the list as the failure message.
 */
export function generateObjectContexts(templateSource: string, templateName = "objectContexts.template.d.ts"): GenerateResult {
  const probe = probeSurface();
  const model: TemplateModel = readTemplate(templateName, templateSource);

  const problems: string[] = [];
  const unverified: string[] = [];
  const edits: Edit[] = [];
  let memberCount = 0;
  let documented = 0;

  for (const [ifaceName, probed] of [...probe.interfaces].sort((a, b) => a[0].localeCompare(b[0]))) {
    const declared = model.interfaces.get(ifaceName);
    if (!declared) {
      problems.push(
        `interface ${ifaceName} is exposed by the shim but is NOT declared in the template ` +
          `(members: ${[...probed.members.keys()].sort().join(", ")})`,
      );
      continue;
    }
    for (const [path, member] of [...probed.members].sort((a, b) => a[0].localeCompare(b[0]))) {
      memberCount++;
      const decl = declared.members.get(path);
      if (!decl) {
        problems.push(
          `${ifaceName}.${path} exists on the shim but is MISSING from the typings ` +
            `(authors cannot discover it)${member.broker ? ` [broker ${member.broker}]` : ""}`,
        );
        continue;
      }
      // Policy JSDoc is attached where the member is DECLARED. An inherited
      // member is documented once, on the interface that owns it, so the same
      // paragraph is not spliced fifteen times over.
      if (decl.inherited) continue;
      const lines = policyLines(member);
      if (lines.length) {
        documented++;
        edits.push(jsDocInsertion(decl, lines));
      }
    }
    for (const path of declared.members.keys()) {
      if (!probed.members.has(path)) {
        problems.push(
          `${ifaceName}.${path} is declared in the typings but does NOT exist on the shim ` +
            `(IntelliSense would offer a method that always fails)`,
        );
      }
    }
  }

  for (const name of model.interfaces.keys()) {
    if (!probe.interfaces.has(name)) unverified.push(name);
  }

  if (problems.length) {
    return { output: "", policyOutput: "", problems, unverified, stats: { interfaces: probe.interfaces.size, members: memberCount, documented, policyRows: 0 } };
  }

  let body = applyEdits(templateSource, edits);
  if (!body.includes(OBJECT_TYPE_MARKER)) {
    problems.push(`template is missing the ${OBJECT_TYPE_MARKER} marker`);
  }
  if (!body.includes(CAPABILITY_MARKER)) {
    problems.push(`template is missing the ${CAPABILITY_MARKER} marker`);
  }
  if (!body.includes(CONTEXT_MAP_MARKER)) {
    problems.push(`template is missing the ${CONTEXT_MAP_MARKER} marker`);
  }
  if (problems.length) {
    return { output: "", policyOutput: "", problems, unverified, stats: { interfaces: probe.interfaces.size, members: memberCount, documented, policyRows: 0 } };
  }
  body = body.replace(OBJECT_TYPE_MARKER, objectTypeTable(probe));
  body = body.replace(CAPABILITY_MARKER, capabilityTable());
  body = body.replace(CONTEXT_MAP_MARKER, contextTypeMap(probe));

  const headerAt = body.indexOf(HEADER_MARKER);
  if (headerAt >= 0) body = body.slice(headerAt + HEADER_MARKER.length).replace(/^\s*\n/, "");

  const output = `${BANNER}\n${body.replace(/\s*$/, "")}\n`;
  const rows = collectSurfaceRows(probe);
  return {
    output,
    policyOutput: surfacePolicyModule(rows),
    problems,
    unverified,
    stats: { interfaces: probe.interfaces.size, members: memberCount, documented, policyRows: rows.length },
  };
}
