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
  /**
   * The finished `scriptSurfaceSlices.ts` text -- signature-only, per object
   * type, priced in tokens. Empty when `problems` is non-empty.
   */
  sliceOutput: string;
  /** Human-readable drift reports; a non-empty list must fail the build. */
  problems: string[];
  /** Interfaces the probe reached but the template never declares. */
  unverified: string[];
  stats: { interfaces: number; members: number; documented: number; policyRows: number; sliceEntries: number };
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

/**
 * The `ext.*` namespace belongs to the SANDBOXED-EXTENSION realm
 * (EXTENSION_BROKER_METHODS in extensionProtocol.ts). An object script cannot
 * call any of it: those rows are dispatched by extensionWorkerHost.ts against a
 * mounted add-in, and the object-script executor has no arm for them.
 *
 * They were invisible here until M4 only because none of them carried a
 * capability. `ext.formShow` / `ext.formUpdate` / `ext.formClose` carry
 * `ui.dialog`, so without this filter the table below — whose own header
 * promises "the broker methods each one unlocks" for an object script — would
 * have listed three methods an object script's `// @capability ui.dialog`
 * unlocks nothing of. A generated author-facing artifact that overstates the
 * surface is the same defect class as consent text that overstates the reach.
 */
function isExtensionOnlyMethod(method: string): boolean {
  return method.startsWith("ext.");
}

function capabilityTable(): string {
  const byCapability = new Map<string, string[]>();
  for (const [method, policy] of Object.entries(ALLOWLIST)) {
    if (!policy.capability) continue;
    if (isExtensionOnlyMethod(method)) continue;
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
        // The IFACE is part of the identity, deliberately. The key used to be
        // chain+broker+capability alone, which collapsed every same-named hook
        // onto the alphabetically FIRST interface that carried it: the surface
        // said onSelectionChange belongs to SheetContext only, while the worker
        // really registers it for slicer, cell and row too — so anything
        // deriving per-TYPE facts from these rows (objectHooksFor, the prompt's
        // own-member floor) saw slicer/table/timeline/row as hookless and a
        // preview never fired their handlers. Validation is untouched: the
        // validator matches by CHAIN, and duplicate chains across interfaces
        // were already legal (getCellValue has two owners).
        const key = `${ifaceName} ${chain} ${member.broker ?? ""} ${policy?.capability ?? ""}`;
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
    "/**",
    " * Which context interface each drafted object type is handed — the probe's",
    " * own table (OBJECT_TYPE_INTERFACES), emitted so runtime consumers stop",
    " * deriving it from the `\"<Type>Context\"` naming convention. The convention",
    ' * was wrong for "textbox" (BaseObjectContext, not TextboxContext) and would',
    " * silently misfire again on the next irregular name; the preview's",
    " * objectHooksFor fires an object's handlers from this map, so a wrong entry",
    " * here means a type whose handlers are never exercised.",
    " */",
    "export const OBJECT_TYPE_CONTEXTS: ReadonlyArray<readonly [objectType: string, iface: string]> = [",
    ...OBJECT_TYPE_INTERFACES.map(([t, i]) => `  [${JSON.stringify(t)}, ${JSON.stringify(i)}],`),
    "];",
    "",
  ].join("\n");
}

// ============================================================================
// The prompt surface (signature-only slices, per object type)
// ============================================================================

const SLICE_BANNER = `// =============================================================================
// GENERATED FILE - DO NOT EDIT.
// =============================================================================
// Produced by:  npm run gen:script-typings
// Generator:    app/scripts/scriptTypings/generateObjectContexts.ts
//
// WHAT THIS IS: the object-script API as SIGNATURES, sliced by object type and
// priced in tokens, for injecting into a script-authoring prompt.
//
// SLICED BY INTERFACE AND BY REACHABILITY. A chain is not unique: \`getCellValue\`
// is three declarations with two different brokers, and every entry lists the
// interfaces that declare THAT declaration -- \`entryFor(chain, objectType)\` is
// the only correct way to resolve one. And a member is listed for a type only if
// that type can actually OBTAIN the object it hangs off: \`range()\` and \`cell()\`
// exist on SheetContext and TableContext alone, so their 102 members are not
// shared. Both rules were wrong until 2026-08-25, and a draft written against
// either error passes the whole validator ladder and is dead at runtime.
//
// WHY IT EXISTS: a model that does not know Calcula's API invents Excel VBA or
// Office.js, and the fix is to put the real surface in front of it. But
// objectContexts.d.ts is 348 KB and fits no context window worth having --
// roughly 85% of it is prose, worked examples and generated policy paragraphs,
// all of which a human reading IntelliSense wants and a model composing a call
// does not. What is left after stripping them is the declaration itself, which
// is the part that makes the call correct.
//
// Design: docs/design/local-model-script-authoring.md §4d, §6.
// Consumed by: app/src/api/scriptHost/scriptPrompt/ (budget-aware assembly).
// =============================================================================
`;

/** Rough token count. Deliberately cheap and slightly pessimistic. */
function estimateTokens(text: string): number {
  // ~3.6 chars/token holds well for dense TypeScript signatures; rounding up
  // keeps the assembler from overrunning a budget it promised to respect.
  return Math.max(1, Math.ceil(text.length / 3.6));
}

/**
 * Collapse a declaration to one line: no comments, no newlines, no double
 * spaces.
 *
 * STRIPPING COMMENTS IS NOT COSMETIC. A member whose type is a nested type
 * literal carries that literal's OWN JSDoc inside its declaration — `api.text`
 * dragged 200+ characters of CSV prose into what was supposed to be a
 * signature, which is precisely the bulk this artifact exists to remove. The
 * summary field already carries one sentence of prose deliberately; anything
 * else is the .d.ts leaking back in.
 */
function oneLine(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/;\s*$/, "")
    .trim();
}

/**
 * The first sentence of the hand-written prose, with the generated policy
 * paragraph excluded.
 *
 * `policyLines()` appends "Calcula policy (generated): ..." and "Reach: ..." to
 * every documented member. Those two are for a human hovering in Monaco; the
 * capability a call needs is already a FIELD here, so repeating it as prose
 * would spend the model's budget restating what the schema says.
 */
function summaryOf(decl: DeclaredMember): string {
  if (!decl.jsDoc) return "";
  const body = decl.jsDoc.text
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\*/, "").trim())
    .filter((l) => l && !l.startsWith("Calcula policy (generated):") && !l.startsWith("Reach:"))
    .join(" ");
  // Stop at the first code fence: a worked example is exactly the bulk we are
  // here to strip.
  const beforeExample = body.split("```")[0];
  const firstSentence = beforeExample.split(/(?<=\.)\s/)[0] ?? "";
  return firstSentence.trim().slice(0, 160);
}

/**
 * How a member is grouped, which is what decides what SURVIVES a tight budget.
 *
 * The order is a claim about what a script author reaches for: the members
 * specific to the object being scripted, then reading and writing the grid,
 * then the privileged extras, then everything else.
 */
export type SurfaceGroup = "context" | "grid" | "capability" | "other";

function groupOf(chain: string, capability: string | undefined, ownMember: boolean): SurfaceGroup {
  if (capability) return "capability";
  if (ownMember) return "context";
  if (chain.startsWith("api.") || chain.startsWith("range.") || chain.startsWith("cell.")) return "grid";
  return "other";
}

export interface SurfaceEntryRow {
  chain: string;
  /**
   * Every context interface that declares THIS declaration of the chain.
   *
   * A chain is NOT unique. `getCellValue` is declared three times with three
   * signatures and two brokers — ShapeContext takes an A1 string, TableContext a
   * data row + column index, SheetContext row + col + optional sheet (and that
   * one dispatches to `sheet.getCellValue`, not `object.getState`). Keyed by
   * chain alone, the slices kept whichever interface sorted first and told every
   * sheet script the SHAPE signature.
   *
   * A LIST because the dedup key is the emitted DECLARATION: an inherited member
   * is one declaration shared by seventeen contexts, stored once, naming them
   * all. That is what makes `entryFor`'s exact match total — all 894
   * (chain, iface) pairs the policy knows appear in exactly one entry.
   */
  ifaces: string[];
  signature: string;
  summary: string;
  capability?: string;
  group: SurfaceGroup;
  cost: number;
}

export interface SliceModel {
  entries: SurfaceEntryRow[];
  /**
   * Chains EVERY object type can reach — REACHABILITY, not ownership.
   *
   * The old rule was "the owning interface is BaseObjectContext or appears in
   * NAMED_SUBTREES", which answers a different question: a named subtree is only
   * reachable through the member that HANDS IT OUT, and `range()` / `cell()` are
   * declared on SheetContext and TableContext alone. So all 51 `range.*` and all
   * 51 `cell.*` chains were published to all 17 object types while the `range` /
   * `cell` entry points were correctly withheld. Measured at the chat's own
   * 6,000-token budget: 22 such members in a button prompt, under a header that
   * says "these are the ONLY methods this script may call".
   *
   * Emitted separately from the per-type extras because listing the full set
   * once per object type made the artifact 343 KB — as large as the .d.ts it
   * exists to shrink.
   */
  sharedChains: string[];
  /**
   * objectType -> the chains its OWN ROOT CONTEXT declares.
   *
   * The prompt ranker's FLOOR. Deliberately NOT the reachable set: flooring a
   * sheet script's 119 reachable extras would spend the budget before
   * `api.setCellValue`.
   */
  ownByObjectType: Map<string, string[]>;
  /**
   * objectType -> every NON-SHARED chain it can REACH: its own root members plus
   * everything hanging off a sub-object only this type can obtain. This bounds
   * the prompt's pool. Differs from `ownByObjectType` exactly for "sheet" (17 vs
   * 119) and "table" (28 vs 130), the two contexts that hand out a ScriptRange.
   */
  reachableByObjectType: Map<string, string[]>;
  /** Drift reports; a non-empty list must fail the build. */
  problems: string[];
}

/**
 * The chain a member hangs off, or "" for one declared on a context root.
 *
 * `collectSurfaceRows` builds `chain` as `root ? root + "." + path : path`, so
 * the entry is the chain with its own in-interface path removed. Derived rather
 * than stored, so the two can never disagree.
 */
function entryChainOf(row: SurfaceMemberRow): string {
  return row.chain === row.path ? "" : row.chain.slice(0, row.chain.length - row.path.length - 1);
}

/** Rows grouped by the chain they hang off — the surface as a graph. */
export function indexSurfaceByEntry(
  rows: readonly SurfaceMemberRow[],
): Map<string, SurfaceMemberRow[]> {
  const byEntry = new Map<string, SurfaceMemberRow[]>();
  for (const row of rows) {
    const entry = entryChainOf(row);
    const list = byEntry.get(entry) ?? [];
    list.push(row);
    byEntry.set(entry, list);
  }
  return byEntry;
}

/**
 * Every chain a script attached to `rootIface`'s object type can actually WRITE.
 *
 * The root context's own members, then everything hanging off a member already
 * reached, transitively. `api.table.range.setValue` is reachable from any
 * context because `api` is on every root; `range.setValue` only where `range`
 * is. Total: every non-root entry key is itself a member chain (measured: 0
 * orphan prefixes over the committed rows), because `ifacePrefixes()` and
 * `collectSurfaceRows` are built from the same two tables.
 */
export function reachableChains(
  byEntry: ReadonlyMap<string, SurfaceMemberRow[]>,
  rootIface: string,
): Set<string> {
  const reached = new Set<string>();
  const queue: string[] = [];
  for (const row of byEntry.get("") ?? []) {
    if (row.iface !== rootIface || reached.has(row.chain)) continue;
    reached.add(row.chain);
    queue.push(row.chain);
  }
  while (queue.length > 0) {
    const entry = queue.pop()!;
    for (const row of byEntry.get(entry) ?? []) {
      if (reached.has(row.chain)) continue;
      reached.add(row.chain);
      queue.push(row.chain);
    }
  }
  return reached;
}

/**
 * Build the slices from the probe (what exists + its broker policy) and the
 * template (what it is DECLARED as, which is where the signature lives).
 */
export function collectSlices(probe: ProbeResult, model: TemplateModel, source: string): SliceModel {
  const rows = collectSurfaceRows(probe);
  const capabilityByChain = new Map<string, string>();
  for (const r of rows) {
    if (r.capability) capabilityByChain.set(r.chain, r.capability);
  }

  // Root context interfaces, so a member's GROUP is known. (BaseObjectContext is
  // one: "textbox" maps to it.)
  const rootIfaces = new Set(OBJECT_TYPE_INTERFACES.map(([, iface]) => iface).filter(Boolean));

  // ONE ENTRY PER DISTINCT DECLARATION, NAMING EVERY INTERFACE THAT DECLARES IT.
  //
  // This loop used to open `if (seen.has(r.chain)) continue`, keeping whichever
  // declaration `collectSurfaceRows` happened to emit first — it sorts by chain,
  // then BROKER, with the alphabetical interface order entering only as the
  // stable third key — and throwing the rest away: ShapeContext's for
  // `getCellValue`, TableContext's for `setCellValue`. A lie for 28 chains, and
  // on those two, where the owners disagree about the broker as well, a lie
  // about the BROKER too. (Not "the alphabetically first interface": that is
  // right for 27 of the 28 and wrong for `setCellValue`, where TableContext beat
  // alphabetically-first SheetContext on the broker key.)
  // These rows are the ONLY description of the API a model is shown,
  // so a sheet script was taught the shape signature, produced code that passed
  // the whole validator ladder (the reach check matches by CHAIN and cannot see
  // arity) and did nothing at runtime.
  //
  //   keyed by chain:         667 rows, getCellValue means whatever ShapeContext says
  //   keyed by (chain,iface): 894 rows, 176 byte-identical repeats of an inherited decl
  //   keyed by declaration:   718 rows covering all 894 pairs   <- this one
  const entries: SurfaceEntryRow[] = [];
  const byDeclaration = new Map<string, SurfaceEntryRow>();
  for (const r of rows) {
    const declared = model.interfaces.get(r.iface)?.members.get(r.path);
    if (!declared) continue; // probed but undeclared: the generator already fails on this
    const signature = oneLine(source.slice(declared.start, declared.end));
    const summary = summaryOf(declared);
    const capability = capabilityByChain.get(r.chain);
    const group = groupOf(r.chain, capability, rootIfaces.has(r.iface));
    // JSON, not a delimiter-joined string: a signature legitimately contains
    // quotes, pipes and backslashes (`lineEnding?: "\r\n" | "\n"`), and no
    // separator is safe against all of them. It also keeps NUL escapes out of
    // the source, which `npm run check:line-endings` hunts for a reason.
    const key = JSON.stringify([r.chain, signature, summary, capability ?? "", group]);
    const held = byDeclaration.get(key);
    if (held) {
      if (!held.ifaces.includes(r.iface)) held.ifaces.push(r.iface);
      continue;
    }
    const entry: SurfaceEntryRow = {
      chain: r.chain,
      ifaces: [r.iface],
      signature,
      summary,
      ...(capability ? { capability } : {}),
      group,
      cost: estimateTokens(`${r.chain} ${signature} ${summary}`),
    };
    byDeclaration.set(key, entry);
    entries.push(entry);
  }
  for (const entry of entries) entry.ifaces.sort();
  // Chain first so the file still reads alphabetically; declaring interface
  // second so a chain's several declarations have a total order and the artifact
  // is byte-reproducible between runs.
  entries.sort((a, b) => a.chain.localeCompare(b.chain) || a.ifaces[0].localeCompare(b.ifaces[0]));

  // WHICH CHAINS EACH OBJECT TYPE CAN ACTUALLY REACH — walked as a graph,
  // because that is the shape the surface has.
  const byEntry = indexSurfaceByEntry(rows);
  const sliceChains = new Set(entries.map((e) => e.chain));
  const reachSets = new Map<string, Set<string>>();
  for (const [objectType, iface] of OBJECT_TYPE_INTERFACES) {
    if (!iface) continue;
    reachSets.set(objectType, reachableChains(byEntry, iface));
  }

  // SHARED is the INTERSECTION of what every root can reach — not "what
  // BaseObjectContext can reach". The two are the same 424 chains today and the
  // check below asserts it, but they FAIL differently: BaseObjectContext is only
  // probed because "textbox" maps to it, so dropping that one row would make the
  // base walk return NOTHING, every chain would become a per-type extra, and the
  // artifact would grow to the 343 KB this split exists to avoid — while a "is
  // every shared chain reachable?" guard passed vacuously over the empty set.
  const problems: string[] = [];
  let intersection: Set<string> | null = null;
  for (const reached of reachSets.values()) {
    if (intersection === null) {
      intersection = new Set(reached);
      continue;
    }
    for (const chain of [...intersection]) if (!reached.has(chain)) intersection.delete(chain);
  }
  const shared = intersection ?? new Set<string>();
  const sharedChains = [...shared].filter((chain) => sliceChains.has(chain)).sort();

  // The cheap explanation of that set, kept as a CHECKED claim rather than a
  // comment: every root spreads BaseObjectContext in, so what all of them can
  // reach is exactly what the base can reach.
  const baseReach = reachableChains(byEntry, "BaseObjectContext");
  const baseOnly = [...baseReach].filter((c) => sliceChains.has(c) && !shared.has(c));
  const sharedOnly = sharedChains.filter((c) => !baseReach.has(c));
  if (baseOnly.length > 0 || sharedOnly.length > 0) {
    problems.push(
      'the shared surface is no longer "what BaseObjectContext can reach": ' +
        `${baseOnly.length} chain(s) reachable only from the base (${baseOnly.slice(0, 5).join(", ")}), ` +
        `${sharedOnly.length} shared but not from the base (${sharedOnly.slice(0, 5).join(", ")})`,
    );
  }
  if (sharedChains.length === 0) {
    problems.push(
      "SHARED_CHAINS came out EMPTY — no chain is reachable from every context root. " +
        "The probe has almost certainly stopped producing one of the root interfaces.",
    );
  }

  // The RANKING FLOOR still comes from the per-iface ROWS: a chain carried by
  // several root contexts (onSelectionChange on sheet, slicer, cell AND row) is
  // OWN to each of them.
  const chainsByIface = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = chainsByIface.get(r.iface) ?? new Set<string>();
    set.add(r.chain);
    chainsByIface.set(r.iface, set);
  }

  const ownByObjectType = new Map<string, string[]>();
  const reachableByObjectType = new Map<string, string[]>();
  for (const [objectType, iface] of OBJECT_TYPE_INTERFACES) {
    if (!iface) continue;
    const reached = reachSets.get(objectType)!;
    ownByObjectType.set(
      objectType,
      [...(chainsByIface.get(iface) ?? [])]
        .filter((chain) => sliceChains.has(chain) && !shared.has(chain))
        .sort(),
    );
    reachableByObjectType.set(
      objectType,
      [...reached].filter((chain) => sliceChains.has(chain) && !shared.has(chain)).sort(),
    );
    // THE INVARIANT THAT MAKES "SHARED" MEAN ANYTHING, per type so the message
    // names what broke it.
    const unreachable = sharedChains.filter((chain) => !reached.has(chain));
    if (unreachable.length > 0) {
      problems.push(
        `SHARED_CHAINS holds ${unreachable.length} chain(s) that "${objectType}" cannot reach ` +
          `(${unreachable.slice(0, 5).join(", ")}${unreachable.length > 5 ? ", ..." : ""}) — ` +
          '"shared" must mean reachable from every context root',
      );
    }
  }

  // `isKnownObjectType` reads one map and `chainsForObjectType` the other, so a
  // key in one and not the other is a type the ranker calls known and then hands
  // the shared surface only.
  const ownKeys = [...ownByObjectType.keys()].sort().join(",");
  const reachKeys = [...reachableByObjectType.keys()].sort().join(",");
  if (ownKeys !== reachKeys) {
    problems.push(
      "OWN_CHAINS_BY_OBJECT_TYPE and REACHABLE_CHAINS_BY_OBJECT_TYPE have different keys " +
        `(${ownKeys} vs ${reachKeys})`,
    );
  }

  return { entries, sharedChains, ownByObjectType, reachableByObjectType, problems };
}

function surfaceSliceModule(slices: SliceModel): string {
  const entryLines = slices.entries.map((e) => {
    const bits = [
      `chain: ${JSON.stringify(e.chain)}`,
      `ifaces: ${JSON.stringify(e.ifaces)}`,
      `signature: ${JSON.stringify(e.signature)}`,
      `summary: ${JSON.stringify(e.summary)}`,
    ];
    if (e.capability) bits.push(`capability: ${JSON.stringify(e.capability)}`);
    bits.push(`group: ${JSON.stringify(e.group)}`, `cost: ${e.cost}`);
    return `  { ${bits.join(", ")} },`;
  });
  const typeLines = [...slices.ownByObjectType]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([objectType, chains]) => `  ${JSON.stringify(objectType)}: ${JSON.stringify(chains)},`);
  const reachLines = [...slices.reachableByObjectType]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([objectType, chains]) => `  ${JSON.stringify(objectType)}: ${JSON.stringify(chains)},`);
  const rootIfaceLines = OBJECT_TYPE_INTERFACES.map(
    ([objectType, iface]) => `  ${JSON.stringify(objectType)}: ${JSON.stringify(iface)},`,
  );
  // Emitted so `entryFor`'s fallback cannot drift from the generator: a
  // declaration on the base or on a named subtree means the same thing wherever
  // it is reached from.
  const sharedIfaceNames = ["BaseObjectContext", ...new Set(NAMED_SUBTREES.map(([, iface]) => iface))];

  return [
    SLICE_BANNER,
    'import type { CapabilityId } from "../capabilityIds";',
    "",
    '/** What decides which members survive a tight token budget. */',
    'export type SurfaceGroup = "context" | "grid" | "capability" | "other";',
    "",
    "/** One callable member, as a model needs to see it. */",
    "export interface SurfaceEntry {",
    '  /** The member-name sequence an author writes, e.g. "caps.storage.get". */',
    "  readonly chain: string;",
    "  /**",
    "   * Every context interface that declares THIS declaration of the chain.",
    "   *",
    "   * A chain is NOT unique: `getCellValue` is three declarations with two",
    "   * different brokers. Resolve one with `entryFor(chain, objectType)` --",
    "   * NEVER by scanning for the first entry whose chain matches, which is what",
    "   * taught sheet scripts the shape signature and produced drafts that",
    "   * validated clean and were dead at runtime.",
    "   */",
    "  readonly ifaces: readonly string[];",
    "  /** The declaration, collapsed to one line. */",
    "  readonly signature: string;",
    "  /** First sentence of the hand-written prose; generated policy excluded. */",
    "  readonly summary: string;",
    "  readonly capability?: CapabilityId;",
    "  readonly group: SurfaceGroup;",
    "  /** Estimated tokens for chain + signature + summary. */",
    "  readonly cost: number;",
    "}",
    "",
    "export const SURFACE_ENTRIES: readonly SurfaceEntry[] = [",
    ...entryLines,
    "];",
    "",
    "/**",
    " * Chains EVERY object type can reach -- REACHABILITY, not ownership.",
    " *",
    " * The intersection of what each context root can reach by walking the surface",
    " * as a graph, which is also exactly what BaseObjectContext reaches. A named",
    " * subtree is NOT automatically shared: it is reachable only through the member",
    " * that hands it out, and `range()` / `cell()` are declared on SheetContext and",
    " * TableContext alone. All 51 `range.*` and all 51 `cell.*` chains used to be",
    " * listed here, so a prompt told a button script that `context.cell.setValue`",
    " * exists while correctly withholding any way to obtain a cell.",
    " *",
    " * Held separately from the per-type extras because listing the full set once",
    " * per object type made this file as large as the .d.ts it exists to shrink.",
    " */",
    "export const SHARED_CHAINS: readonly string[] = " + JSON.stringify(slices.sharedChains) + ";",
    "",
    "/**",
    " * objectType -> the chains its OWN ROOT CONTEXT declares.",
    " *",
    " * The prompt ranker's FLOOR. NOT the reachable set: flooring a sheet script's",
    " * whole ScriptRange facet would spend the budget before `api.setCellValue`.",
    " */",
    "export const OWN_CHAINS_BY_OBJECT_TYPE: Readonly<Record<string, readonly string[]>> = {",
    ...typeLines,
    "};",
    "",
    "/**",
    " * objectType -> every NON-SHARED chain it can REACH.",
    " *",
    ' * Differs from OWN_CHAINS_BY_OBJECT_TYPE exactly for "sheet" and "table", the',
    " * two contexts that hand out a ScriptRange. This bounds the prompt's pool -- a",
    " * chain outside it is a method the script cannot call. Its keys are identical",
    " * to OWN_CHAINS_BY_OBJECT_TYPE's; the generator fails the build otherwise.",
    " */",
    "export const REACHABLE_CHAINS_BY_OBJECT_TYPE: Readonly<Record<string, readonly string[]>> = {",
    ...reachLines,
    "};",
    "",
    "/**",
    " * objectType -> the context interface `setup(context)` is handed for it.",
    " *",
    " * The probe's own table, emitted so no consumer derives it from the",
    ' * `"<Type>Context"` naming convention -- already wrong for "textbox".',
    " */",
    "export const ROOT_IFACE_BY_OBJECT_TYPE: Readonly<Record<string, string>> = {",
    ...rootIfaceLines,
    "};",
    "",
    "/** Interfaces whose declarations mean the same thing wherever they are reached. */",
    "export const SHARED_IFACES: readonly string[] = " + JSON.stringify(sharedIfaceNames) + ";",
    "",
    "/** Everything a script attached to `objectType` can reach. */",
    "export function chainsForObjectType(objectType: string): readonly string[] {",
    "  const extra = REACHABLE_CHAINS_BY_OBJECT_TYPE[objectType];",
    "  return extra ? [...SHARED_CHAINS, ...extra] : SHARED_CHAINS;",
    "}",
    "",
    "/** True when the object type has a slice at all (an unknown one has none). */",
    "export function isKnownObjectType(objectType: string): boolean {",
    "  return Object.prototype.hasOwnProperty.call(OWN_CHAINS_BY_OBJECT_TYPE, objectType);",
    "}",
    "",
    "const VARIANTS_BY_CHAIN: ReadonlyMap<string, readonly SurfaceEntry[]> = (() => {",
    "  const out = new Map<string, SurfaceEntry[]>();",
    "  for (const entry of SURFACE_ENTRIES) {",
    "    const held = out.get(entry.chain);",
    "    if (held) held.push(entry);",
    "    else out.set(entry.chain, [entry]);",
    "  }",
    "  return out;",
    "})();",
    "",
    "const SHARED_IFACE_SET: ReadonlySet<string> = new Set(SHARED_IFACES);",
    "",
    "/**",
    " * The ONE entry a script attached to `objectType` means when it writes `chain`.",
    " *",
    " * Most chains have a single declaration and this is a map lookup. The 28 that",
    " * do not are why this exists.",
    " */",
    "export function entryFor(chain: string, objectType: string): SurfaceEntry | undefined {",
    "  const variants = VARIANTS_BY_CHAIN.get(chain);",
    "  if (!variants) return undefined;",
    "  if (variants.length === 1) return variants[0];",
    "  // hasOwnProperty, not `?? undefined`: the map is a plain object, so a",
    '  // prototype-key objectType ("constructor") would read an inherited FUNCTION.',
    "  if (Object.prototype.hasOwnProperty.call(ROOT_IFACE_BY_OBJECT_TYPE, objectType)) {",
    "    const rootIface = ROOT_IFACE_BY_OBJECT_TYPE[objectType];",
    "    const exact = variants.find((entry) => entry.ifaces.includes(rootIface));",
    "    if (exact) return exact;",
    "  }",
    "  return variants.find((entry) => entry.ifaces.some((i) => SHARED_IFACE_SET.has(i))) ?? variants[0];",
    "}",
    "",
    "/**",
    " * Every member a script attached to `objectType` can call, each resolved to",
    " * that object's OWN declaration. An unknown type degrades to one declaration",
    " * of every chain rather than to nothing.",
    " */",
    "export function entriesForObjectType(objectType: string): readonly SurfaceEntry[] {",
    "  const chains = isKnownObjectType(objectType)",
    "    ? chainsForObjectType(objectType)",
    "    : [...VARIANTS_BY_CHAIN.keys()];",
    "  const out: SurfaceEntry[] = [];",
    "  for (const chain of chains) {",
    "    const entry = entryFor(chain, objectType);",
    "    if (entry) out.push(entry);",
    "  }",
    "  return out;",
    "}",
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
    return { output: "", policyOutput: "", sliceOutput: "", problems, unverified, stats: { interfaces: probe.interfaces.size, members: memberCount, documented, policyRows: 0, sliceEntries: 0 } };
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
    return { output: "", policyOutput: "", sliceOutput: "", problems, unverified, stats: { interfaces: probe.interfaces.size, members: memberCount, documented, policyRows: 0, sliceEntries: 0 } };
  }
  body = body.replace(OBJECT_TYPE_MARKER, objectTypeTable(probe));
  body = body.replace(CAPABILITY_MARKER, capabilityTable());
  body = body.replace(CONTEXT_MAP_MARKER, contextTypeMap(probe));

  const headerAt = body.indexOf(HEADER_MARKER);
  if (headerAt >= 0) body = body.slice(headerAt + HEADER_MARKER.length).replace(/^\s*\n/, "");

  const output = `${BANNER}\n${body.replace(/\s*$/, "")}\n`;
  const rows = collectSurfaceRows(probe);
  const slices = collectSlices(probe, model, templateSource);
  // A slice model that contradicts itself must not be emitted, for the same
  // reason a drifted .d.ts must not. Routed through `problems` because that is
  // the one channel both callers already handle: gen-script-typings.mjs prints
  // and exits 1 without writing, and objectContextsTypings.test.ts asserts empty.
  if (slices.problems.length > 0) {
    return {
      output: "",
      policyOutput: "",
      sliceOutput: "",
      problems: slices.problems,
      unverified,
      stats: { interfaces: probe.interfaces.size, members: memberCount, documented, policyRows: 0, sliceEntries: 0 },
    };
  }
  return {
    output,
    policyOutput: surfacePolicyModule(rows),
    sliceOutput: surfaceSliceModule(slices),
    problems,
    unverified,
    stats: { interfaces: probe.interfaces.size, members: memberCount, documented, policyRows: rows.length, sliceEntries: slices.entries.length },
  };
}
