//! FILENAME: app/src/api/scriptHost/scriptPrompt/index.ts
// PURPOSE: Assemble the API surface a model is shown when authoring an object
//          script, filled to a TOKEN BUDGET rather than to a fixed template.
// CONTEXT: docs/design/local-model-script-authoring.md §4d, §6.
//
//          WHY A BUDGET AND NOT A TEMPLATE. Context windows in the wild range
//          from 8k to 128k+, and the same prompt has to work across all of them
//          because Calcula does not pick the user's model — the user does. A
//          fixed prompt either wastes a large window or overruns a small one,
//          and overrunning is the worse failure: the surface gets truncated at
//          whatever byte the server stopped reading, which usually means a
//          half-written signature the model then copies.
//
//          THE NUMBERS THAT MOTIVATE IT (measured 2026-08-19):
//            objectContexts.d.ts   ~96,800 tokens   unusable anywhere
//            signature slices      ~29,000 tokens   70% smaller, fits 32k+
//            one object type       ~24,000 tokens   still too big for 8k
//          So slicing alone is not enough; something has to CHOOSE. That is
//          this module, and the order it chooses in is a claim about what a
//          script author reaches for.
//
//          TRUNCATION IS ANNOUNCED, NEVER SILENT. When the budget cuts the
//          surface, the prompt says so and tells the model what to do about it.
//          A silently partial surface is worse than a small one: the model
//          cannot tell "Calcula has no such method" from "I was not shown it",
//          so it invents one, L1 rejects it, and the repair loop spends its
//          rounds rediscovering the same gap.

import {
  SURFACE_ENTRIES,
  OWN_CHAINS_BY_OBJECT_TYPE,
  entriesForObjectType,
  isKnownObjectType,
  type SurfaceEntry,
  type SurfaceGroup,
} from "../generated/scriptSurfaceSlices";

/**
 * Group order when the budget bites.
 *
 * `context` first because those are the members that exist BECAUSE the script is
 * attached to this object — the reason someone is scripting a button is the
 * button. `grid` next because reading and writing cells is what most scripts do.
 * `capability` is deliberately last-but-one: it is only 58 members, but a task
 * that never touches the network should not spend 2,400 tokens describing how.
 */
const GROUP_ORDER: readonly SurfaceGroup[] = ["context", "grid", "capability", "other"];

export interface SurfacePromptRequest {
  /** The draft's target, e.g. "button". Unknown types fall back to everything. */
  objectType: string;
  /** Tokens this section may spend. */
  budgetTokens: number;
  /**
   * Words from the user's request. A chain or summary matching one is promoted
   * ahead of its group, which is what lets a 4k budget still carry `caps.fetch`
   * when the user said "download".
   */
  hints?: string[];
}

export interface SurfacePromptResult {
  /** The text to inject. Empty only when the budget cannot fit one member. */
  text: string;
  includedChains: string[];
  omittedCount: number;
  /** Tokens the text is estimated to cost. Never exceeds `budgetTokens`. */
  costTokens: number;
  /** True when anything was dropped — i.e. the model was told the surface is partial. */
  truncated: boolean;
}

/**
 * The methods a script author reaches for whatever the task is.
 *
 * WHY THIS LIST EXISTS, and why it is not derived: ranking by group then
 * alphabetically put `api.setCellValue` — the single most basic operation there
 * is — outside a 4,000-token budget, behind a hundred alphabetically earlier and
 * far more obscure members. Nothing in the generated surface distinguishes
 * "fundamental" from "niche"; that is a product judgement, so it is written down
 * as one rather than faked out of chain depth.
 *
 * Capability members are deliberately ABSENT. All 58 of them cost ~2,400 tokens,
 * which is most of a small budget, and a task that never touches the network
 * should not pay for the network API. They arrive through hints instead.
 *
 * GUARDED TWO WAYS, so it cannot rot into a lie:
 *   1. every chain here must exist in the generated surface (a rename fails a
 *      test rather than silently dropping the method from every prompt);
 *   2. the eval corpus's canary tasks must be answerable at a 4k budget, which
 *      is what proves the list is SUFFICIENT and not merely well-intentioned.
 */
export const PROMPT_CORE_CHAINS: readonly string[] = [
  // Talking to the user and registering handlers.
  "log",
  "notify",
  "expose",
  // Reading and writing cells — the floor of almost every script.
  "api.getCellValue",
  "api.setCellValue",
  "api.getCellFormula",
  "api.setCellFormula",
  "api.getRangeValues",
  "api.getCellFormat",
  "api.setRangeFormat",
  "api.clearRange",
  // Finding out what is there.
  "api.getUsedRange",
  "api.selection",
  // The handful of whole-range operations a script is repeatedly asked for.
  "api.sortRange",
  "api.findAll",
  "api.replaceAll",
  "api.recalculate",
  "api.addSheet",
  "api.createTable",
];

const CORE = new Set(PROMPT_CORE_CHAINS);

/**
 * One representative member per capability — the shortest chain that needs it.
 *
 * WHY: lexical hint matching cannot be relied on to surface a capability. The
 * task "Get JSON from https://api.example.com/data" matches nothing in
 * `caps.fetch`'s chain OR its prose, so it ranked 468th of 528 and fell outside
 * every small budget — leaving a model that was asked to download something with
 * no evidence that downloading is possible at all. It then either invents
 * `fetch()` or refuses.
 *
 * Showing ONE member of each of the 14 capabilities costs ~600 tokens and
 * removes that whole failure class: the model can always see that the namespace
 * exists, and the truncation note already tells it to ask rather than guess when
 * the specific method is missing. Derived from the surface (shortest chain per
 * capability), so a new capability joins the index automatically.
 */
const CAPABILITY_INDEX: ReadonlySet<string> = (() => {
  const shortest = new Map<string, SurfaceEntry>();
  for (const e of SURFACE_ENTRIES) {
    if (!e.capability) continue;
    const held = shortest.get(e.capability);
    if (!held || e.chain.length < held.chain.length) shortest.set(e.capability, e);
  }
  return new Set([...shortest.values()].map((e) => e.chain));
})();

/**
 * Function words, dropped from hints.
 *
 * These are matched as SUBSTRINGS, so an innocuous "and" in a user's sentence
 * hits `executeCommand` (comm-AND) and hoists it above every context member.
 * Measured: the intent "Count how many times this button has been clicked..."
 * put `api.executeCommand`, `api.getThemePalette` and `api.scenarioShow` at the
 * very top of the ranking, ahead of `log` and `expose`.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "these", "those", "into",
  "has", "have", "had", "been", "was", "were", "are", "its", "our", "your",
  "how", "what", "when", "where", "which", "who", "why", "any", "all", "each",
  "will", "would", "can", "could", "should", "must", "may", "might",
  "many", "much", "more", "most", "some", "one", "two", "then", "than",
  "but", "not", "only", "also", "just", "here", "there", "them", "they",
  "use", "using", "make", "makes", "want", "wants", "need", "needs",
  "please", "user", "users", "script", "workbook", "sheet",
]);

/**
 * Normalize a hint list into lowercase terms worth matching on.
 *
 * Note the STEM: a term of five characters or more also matches on its first
 * four. This is not tidiness — plain substring matching missed `caps.storage`
 * for the term "store", because "storage" does not contain "store" (the fifth
 * letter differs). That single miss ranked both storage methods 517th of 528
 * and made every "remember this across sessions" task unanswerable inside a
 * small budget.
 */
export function hintTerms(hints: readonly string[] | undefined): string[] {
  if (!hints?.length) return [];
  const out = new Set<string>();
  for (const raw of hints) {
    for (const word of raw.toLowerCase().split(/[^a-z0-9]+/)) {
      // Two-letter words match everything and teach the ranker nothing.
      if (word.length < 3 || STOPWORDS.has(word)) continue;
      out.add(word);
      if (word.length >= 5) out.add(word.slice(0, 4));
    }
  }
  return [...out];
}

/**
 * How specifically a hint matched, lower being stronger.
 *
 * Tiering matters because a flat substring test over chain+summary marks half
 * the surface as "relevant" — "cell" alone hits ~100 members — and a signal that
 * fires everywhere ranks nothing. Matching the LAST SEGMENT is the strong
 * signal: a user asking to "sort" wants `sortRange`, not the twelve members
 * whose prose happens to mention sorting.
 */
function hintTier(entry: SurfaceEntry, terms: readonly string[]): number {
  if (terms.length === 0) return 3;
  const tail = (entry.chain.split(".").pop() ?? "").toLowerCase();
  if (terms.some((t) => tail.includes(t))) return 0;
  if (terms.some((t) => entry.chain.toLowerCase().includes(t))) return 1;
  if (terms.some((t) => entry.summary.toLowerCase().includes(t))) return 2;
  return 3;
}

/** Dotted depth: `api.setCellValue` (2) is more central than `api.table.range.autoFill` (4). */
function depthOf(chain: string): number {
  return chain.split(".").length;
}

/**
 * Rank the surface for one request: hinted members first (in group order), then
 * everything else in group order, alphabetical within each bucket so the prompt
 * is stable across runs. A prompt that reshuffles between attempts makes a
 * repair loop non-reproducible and wastes any prefix caching the runtime does.
 */
export function rankSurface(objectType: string, hints?: readonly string[]): SurfaceEntry[] {
  // Resolved per OBJECT TYPE, not per chain. `context.getCellValue` is three
  // different signatures, and the chain-keyed map this replaced handed every
  // object type ShapeContext's, because it sorted first. A sheet script was
  // shown, as the only description of the API it may call, a signature that does
  // not exist on its context; the draft validated clean and did nothing.
  //
  // An unknown object type still degrades to the WHOLE surface rather than to an
  // empty one -- `entriesForObjectType` returns one declaration of every chain --
  // because over-showing costs budget, but handing a model an empty API and
  // watching it invent one wholesale costs the whole attempt.
  const pool: SurfaceEntry[] = [...entriesForObjectType(objectType)];

  const terms = hintTerms(hints);
  // The object's OWN members — a button has exactly `instanceId` and `onClick`.
  // They exist BECAUSE the script is attached to this object, and one of them is
  // usually the only way the script ever RUNS: a button script without
  // `context.onClick(handler)` mounts and does nothing, clicked or not. Hint
  // ranking cannot be trusted to keep them (no user says "onClick"), and at a 4k
  // budget five canary tasks measurably lost the hook behind hinted grid
  // members — a prompt on which the correct answer was unwritable.
  // Guarded by isKnownObjectType, not `?? []`: the map is a plain object, so
  // a prototype-key objectType ("constructor", "toString") would read an
  // inherited FUNCTION here, dodge the ?? and throw inside new Set — taking
  // down the documented unknown-type whole-surface fallback with it.
  const own = new Set<string>(isKnownObjectType(objectType) ? OWN_CHAINS_BY_OBJECT_TYPE[objectType] : []);
  // Ordered comparison rather than one blended number: each key is a separate
  // claim, and blending them into a score made it impossible to say why a member
  // had been dropped.
  const keys = (e: SurfaceEntry): number[] => {
    const group = GROUP_ORDER.indexOf(e.group);
    return [
      // 0. The object's own members outrank everything, hints included.
      own.has(e.chain) ? 0 : 1,
      // 0b. Then the FLOOR — context group, core set, capability index —
      //     ahead of hint pressure. Floor membership used to put these in the
      //     right BUCKET but still ordered by hint tier, so a hint-heavy task
      //     flooded the budget with tier-0 matches until the floor itself fell
      //     out. Measured: at the runner's own 8k default budget,
      //     grid-sum-in-script's prompt held every api.set* sibling EXCEPT
      //     `api.setCellValue`. A floor is a floor only if nothing can rank it
      //     out; the keys below keep the floor's own internal order (index →
      //     context → core grid) exactly as it was.
      e.group === "context" || CORE.has(e.chain) || CAPABILITY_INDEX.has(e.chain) ? 0 : 1,
      // 1. What must be present for the task to be answerable at all:
      //      * the object's OWN members and the core set, always;
      //      * anything the request named precisely (a last-segment match);
      //      * a CAPABILITY member the request gestured at in any way.
      //
      //    The capability clause is the one that needed widening. A task saying
      //    "Get JSON from https://..." names `caps.fetch` nowhere -- the only
      //    link is the word "https" appearing in its summary -- and a task
      //    saying "remember the count across sessions" reaches `caps.storage`
      //    only through "store" inside "storage". Both were ranked below a
      //    hundred grid members and fell outside a 4k budget, which made them
      //    unanswerable by construction. There are only 58 capability members in
      //    total, so admitting the hinted ones early is cheap; admitting none of
      //    them makes every capability task impossible on a small model.
      e.group === "context" ||
      CORE.has(e.chain) ||
      CAPABILITY_INDEX.has(e.chain) ||
      hintTier(e, terms) === 0 ||
      (e.capability !== undefined && hintTier(e, terms) <= 2)
        ? 0
        : 1,
      // 2. Within that, a HINTED CAPABILITY member leads.
      //
      //    Not favouritism — scarcity. A generic verb like "get" tier-0 matches
      //    every `api.get*` member, so a bucket ordered purely by hint strength
      //    buries `caps.fetch` behind forty getters and drops it at 4k. A grid
      //    task whose exact method is missing can often be expressed another
      //    way; a capability task cannot be expressed at all. There are only 58
      //    capability members in total, so leading with the hinted ones is
      //    cheap insurance against an impossible prompt.
      e.capability !== undefined && (CAPABILITY_INDEX.has(e.chain) || hintTier(e, terms) <= 2)
        ? 0
        : 1,
      // 3. Then how specifically the request pointed at it.
      hintTier(e, terms),
      // 3. Then the group's own priority.
      group === -1 ? GROUP_ORDER.length : group,
      // 4. Then centrality: a shallower chain is a more fundamental operation.
      depthOf(e.chain),
    ];
  };
  return [...pool].sort((a, b) => {
    const ka = keys(a);
    const kb = keys(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return ka[i] - kb[i];
    }
    // Alphabetical last, so the order is total and the prompt is reproducible.
    return a.chain.localeCompare(b.chain);
  });
}

function renderEntry(e: SurfaceEntry): string {
  const cap = e.capability ? `  // @capability ${e.capability}` : "";
  const summary = e.summary ? `  // ${e.summary}` : "";
  return `context.${e.chain}\n  ${e.signature}${cap}${summary ? `\n${summary}` : ""}`;
}

const HEADER = [
  "# Calcula object-script API",
  "",
  "These are the ONLY methods this script may call. Reach them through the",
  "`context` parameter of `export function setup(context)`, which is also in scope for",
  "every top-level function in the file. A method not listed",
  "here does not exist -- do not invent one.",
  "",
].join("\n");

/**
 * The note appended when the budget cut the surface.
 *
 * It names a number and gives an instruction, because "some methods were
 * omitted" without either just makes the model anxious and inventive.
 */
function truncationNote(omitted: number): string {
  return [
    "",
    `# NOTE: ${omitted} further methods exist but did not fit this message.`,
    "If the task needs something not listed above, do NOT guess a name.",
    "Say which capability you need and stop; you will be shown that part of the API.",
  ].join("\n");
}

export function buildSurfacePrompt(req: SurfacePromptRequest): SurfacePromptResult {
  const ranked = rankSurface(req.objectType, req.hints);
  const headerCost = Math.ceil(HEADER.length / 3.6);
  // Reserve room for the note up front. Discovering mid-fill that the note no
  // longer fits is how a budget gets quietly overrun by the very text that was
  // supposed to admit the overrun.
  const noteReserve = Math.ceil(truncationNote(9999).length / 3.6);

  const included: SurfaceEntry[] = [];
  let spent = headerCost;
  const ceiling = Math.max(0, req.budgetTokens - noteReserve);
  for (const entry of ranked) {
    // Priced on the RENDERED form, not on `entry.cost`. The generated cost omits
    // the `context.` prefix, the comment markers and the blank line between
    // entries, which added up to an ~8% overrun — and a budget that is exceeded
    // by any margin is exactly the truncation-at-a-random-byte this module
    // exists to prevent. `entry.cost` stays useful for coarse sizing, and
    // `fullSurfaceCost` still uses it, but it never decides a fill.
    const cost = Math.ceil((renderEntry(entry).length + 2) / 3.6);
    if (spent + cost > ceiling) continue; // keep going: a cheaper member may still fit
    included.push(entry);
    spent += cost;
  }

  const omitted = ranked.length - included.length;
  // Alphabetical for the OUTPUT even though ranking chose the members: a model
  // reads a sorted list more reliably than one ordered by our priorities.
  const body = [...included].sort((a, b) => a.chain.localeCompare(b.chain)).map(renderEntry).join("\n\n");
  const text = included.length === 0
    ? ""
    : HEADER + body + (omitted > 0 ? truncationNote(omitted) : "");

  return {
    text,
    includedChains: included.map((e) => e.chain),
    omittedCount: omitted,
    costTokens: text === "" ? 0 : Math.ceil(text.length / 3.6),
    truncated: omitted > 0,
  };
}

/** Total estimated cost of an object type's whole surface, for sizing decisions. */
export function fullSurfaceCost(objectType: string): number {
  return rankSurface(objectType).reduce((sum, e) => sum + e.cost, 0);
}

export {
  SURFACE_ENTRIES,
  SHARED_CHAINS,
  SHARED_IFACES,
  OWN_CHAINS_BY_OBJECT_TYPE,
  REACHABLE_CHAINS_BY_OBJECT_TYPE,
  ROOT_IFACE_BY_OBJECT_TYPE,
  chainsForObjectType,
  entriesForObjectType,
  entryFor,
  isKnownObjectType,
} from "../generated/scriptSurfaceSlices";
export type { SurfaceEntry, SurfaceGroup } from "../generated/scriptSurfaceSlices";
