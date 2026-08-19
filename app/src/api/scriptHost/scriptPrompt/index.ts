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
  chainsForObjectType,
  isKnownObjectType,
  type SurfaceEntry,
  type SurfaceGroup,
} from "../generated/scriptSurfaceSlices";

const BY_CHAIN: ReadonlyMap<string, SurfaceEntry> = new Map(SURFACE_ENTRIES.map((e) => [e.chain, e]));

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

/** Normalize a hint list into lowercase word stems worth matching on. */
function hintTerms(hints: readonly string[] | undefined): string[] {
  if (!hints?.length) return [];
  const out = new Set<string>();
  for (const raw of hints) {
    for (const word of raw.toLowerCase().split(/[^a-z0-9]+/)) {
      // Two-letter words match everything and teach the ranker nothing.
      if (word.length >= 3) out.add(word);
    }
  }
  return [...out];
}

function matchesHint(entry: SurfaceEntry, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  const hay = `${entry.chain} ${entry.summary}`.toLowerCase();
  return terms.some((t) => hay.includes(t));
}

/**
 * Rank the surface for one request: hinted members first (in group order), then
 * everything else in group order, alphabetical within each bucket so the prompt
 * is stable across runs. A prompt that reshuffles between attempts makes a
 * repair loop non-reproducible and wastes any prefix caching the runtime does.
 */
export function rankSurface(objectType: string, hints?: readonly string[]): SurfaceEntry[] {
  // An unknown object type degrades to the WHOLE surface rather than to an
  // empty one: over-showing costs budget, but handing a model an empty API and
  // watching it invent one wholesale costs the whole attempt.
  const pool: SurfaceEntry[] = isKnownObjectType(objectType)
    ? chainsForObjectType(objectType)
        .map((c) => BY_CHAIN.get(c))
        .filter((e): e is SurfaceEntry => Boolean(e))
    : [...SURFACE_ENTRIES];

  const terms = hintTerms(hints);
  const rank = (e: SurfaceEntry): number => {
    const group = GROUP_ORDER.indexOf(e.group);
    const groupRank = group === -1 ? GROUP_ORDER.length : group;
    return (matchesHint(e, terms) ? 0 : 1) * GROUP_ORDER.length + groupRank;
  };
  return [...pool].sort((a, b) => rank(a) - rank(b) || a.chain.localeCompare(b.chain));
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
  "`context` parameter of `export function setup(context)`. A method not listed",
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
  OWN_CHAINS_BY_OBJECT_TYPE,
  chainsForObjectType,
  isKnownObjectType,
} from "../generated/scriptSurfaceSlices";
export type { SurfaceEntry, SurfaceGroup } from "../generated/scriptSurfaceSlices";
