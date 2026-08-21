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
  signature: string;
  summary: string;
  capability?: string;
  group: SurfaceGroup;
  cost: number;
}

export interface SliceModel {
  entries: SurfaceEntryRow[];
  /**
   * Chains every object type can reach (BaseObjectContext plus every named
   * subtree: caps, api, range, the handles).
   *
   * Emitted separately from the per-type extras because listing the full set
   * once per object type made the artifact 343 KB — as large as the .d.ts it
   * exists to shrink. ~520 of the ~530 chains are identical across all 17
   * types, so the shared set plus a handful of extras says the same thing in a
   * fraction of the bytes.
   */
  sharedChains: string[];
  /** objectType -> only the chains its OWN root context adds. */
  ownByObjectType: Map<string, string[]>;
}

/**
 * Build the slices from the probe (what exists + its broker policy) and the
 * template (what it is DECLARED as, which is where the signature lives).
 */
export function collectSlices(probe: ProbeResult, model: TemplateModel, source: string): SliceModel {
  const rows = collectSurfaceRows(probe);
  const capabilityByChain = new Map<string, string>();
  const ifaceByChain = new Map<string, string>();
  for (const r of rows) {
    if (r.capability) capabilityByChain.set(r.chain, r.capability);
    if (!ifaceByChain.has(r.chain)) ifaceByChain.set(r.chain, r.iface);
  }

  // Root context interfaces, so a member's "own vs shared" status is known.
  const rootIfaces = new Set(OBJECT_TYPE_INTERFACES.map(([, iface]) => iface).filter(Boolean));

  const entries: SurfaceEntryRow[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.chain)) continue;
    const declared = model.interfaces.get(r.iface)?.members.get(r.path);
    if (!declared) continue; // probed but undeclared: the generator already fails on this
    seen.add(r.chain);
    const signature = oneLine(source.slice(declared.start, declared.end));
    const summary = summaryOf(declared);
    const capability = capabilityByChain.get(r.chain);
    const group = groupOf(r.chain, capability, rootIfaces.has(r.iface));
    entries.push({
      chain: r.chain,
      signature,
      summary,
      ...(capability ? { capability } : {}),
      group,
      cost: estimateTokens(`${r.chain} ${signature} ${summary}`),
    });
  }
  entries.sort((a, b) => a.chain.localeCompare(b.chain));

  // Which chains each object type can reach. A root context contributes its OWN
  // members; BaseObjectContext and every NAMED_SUBTREES interface are reachable
  // from any context, so those are shared. Derived from the same two tables the
  // probe uses, not restated.
  const sharedIfaces = new Set(NAMED_SUBTREES.map(([, iface]) => iface));
  const isShared = (chain: string): boolean => {
    const owner = ifaceByChain.get(chain)!;
    return owner === "BaseObjectContext" || sharedIfaces.has(owner);
  };

  const sharedChains = entries.filter((e) => isShared(e.chain)).map((e) => e.chain);
  // Ownership per TYPE comes from the per-iface ROWS, not from ifaceByChain's
  // first-owner map: a chain carried by several root contexts (onSelectionChange
  // on sheet, slicer, cell AND row) is OWN to each of them, and the first-owner
  // view silently emptied every later type's own-member floor — which is how
  // the prompt ranker under-served slicer/table/timeline tasks.
  const chainsByIface = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = chainsByIface.get(r.iface) ?? new Set<string>();
    set.add(r.chain);
    chainsByIface.set(r.iface, set);
  }
  const sliceChains = new Set(entries.map((e) => e.chain));
  const ownByObjectType = new Map<string, string[]>();
  for (const [objectType, iface] of OBJECT_TYPE_INTERFACES) {
    if (!iface) continue;
    const own = [...(chainsByIface.get(iface) ?? [])].filter(
      (chain) => sliceChains.has(chain) && !isShared(chain),
    );
    ownByObjectType.set(objectType, own.sort());
  }

  return { entries, sharedChains, ownByObjectType };
}

function surfaceSliceModule(slices: SliceModel): string {
  const entryLines = slices.entries.map((e) => {
    const bits = [
      `chain: ${JSON.stringify(e.chain)}`,
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

  return [
    SLICE_BANNER,
    'import type { CapabilityId } from "../capabilityIds";',
    "",
    '/** What decides which members survive a tight token budget. */',
    'export type SurfaceGroup = "context" | "grid" | "capability" | "other";',
    "",
    "/** One callable member, as a model needs to see it. */",
    "export interface SurfaceEntry {",
    "  /** The member-name sequence an author writes, e.g. \"caps.storage.get\". */",
    "  readonly chain: string;",
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
    " * Chains EVERY object type can reach: BaseObjectContext plus every named",
    " * subtree (caps, api, range, the handles).",
    " *",
    " * Held separately from the per-type extras because listing the full set once",
    " * per object type made this file as large as the .d.ts it exists to shrink --",
    " * ~520 of ~530 chains are identical across all 17 types.",
    " */",
    "export const SHARED_CHAINS: readonly string[] = " + JSON.stringify(slices.sharedChains) + ";",
    "",
    "/** objectType -> only the chains its OWN root context adds on top of SHARED_CHAINS. */",
    "export const OWN_CHAINS_BY_OBJECT_TYPE: Readonly<Record<string, readonly string[]>> = {",
    ...typeLines,
    "};",
    "",
    "/** Everything a script attached to `objectType` can reach. */",
    "export function chainsForObjectType(objectType: string): readonly string[] {",
    "  const own = OWN_CHAINS_BY_OBJECT_TYPE[objectType];",
    "  return own ? [...SHARED_CHAINS, ...own] : SHARED_CHAINS;",
    "}",
    "",
    "/** True when the object type has a slice at all (an unknown one has none). */",
    "export function isKnownObjectType(objectType: string): boolean {",
    "  return Object.prototype.hasOwnProperty.call(OWN_CHAINS_BY_OBJECT_TYPE, objectType);",
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
  return {
    output,
    policyOutput: surfacePolicyModule(rows),
    sliceOutput: surfaceSliceModule(slices),
    problems,
    unverified,
    stats: { interfaces: probe.interfaces.size, members: memberCount, documented, policyRows: rows.length, sliceEntries: slices.entries.length },
  };
}
