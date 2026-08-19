//! FILENAME: app/src/api/scriptHost/scriptValidation/surface.ts
// PURPOSE: Index the generated script surface for the two questions the
//          validator asks: "is this chain real?" and "what capability does
//          calling it require?" — plus the nearest-neighbour suggestion that
//          turns a rejection into a fix.
// CONTEXT: `generated/scriptSurfacePolicy.ts` is emitted from ONE probe of the
//          live worker shim plus the broker ALLOWLIST, in the same pass as
//          objectContexts.d.ts. Nothing here restates the surface; if this
//          module disagrees with the broker, the generator is the defect.
//          Design: docs/design/local-model-script-authoring.md §5a.

import { SCRIPT_SURFACE, type SurfaceMember } from "../generated/scriptSurfacePolicy";
import type { CapabilityId } from "../capabilityIds";

/** Every chain an author can write, e.g. "caps.storage.get". */
const CHAINS: ReadonlySet<string> = new Set(SCRIPT_SURFACE.map((m) => m.chain));

/**
 * Every PROPER prefix of a known chain: "caps", "caps.storage", "api.chart".
 *
 * Referencing a namespace without calling through it (`const c = context.caps`)
 * is legal, so a bare prefix must not be reported as an unknown member.
 */
const PREFIXES: ReadonlySet<string> = (() => {
  const out = new Set<string>();
  for (const m of SCRIPT_SURFACE) {
    const parts = m.chain.split(".");
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("."));
  }
  return out;
})();

/** chain -> the capabilities calling it can require. */
const CAPABILITY_BY_CHAIN: ReadonlyMap<string, ReadonlySet<CapabilityId>> = (() => {
  const out = new Map<string, Set<CapabilityId>>();
  for (const m of SCRIPT_SURFACE) {
    if (!m.capability) continue;
    const set = out.get(m.chain) ?? new Set<CapabilityId>();
    set.add(m.capability);
    out.set(m.chain, set);
  }
  return out;
})();

export function isKnownChain(chain: string): boolean {
  return CHAINS.has(chain);
}

export function isKnownPrefix(chain: string): boolean {
  return PREFIXES.has(chain);
}

/**
 * True when some PROPER prefix of `chain` is itself a callable member.
 *
 * This is what keeps the reach check free of false positives on ordinary code:
 * `context.api.getCellValue(0, 0).toString()` flattens to
 * `api.getCellValue.toString`, which is not a surface member — but
 * `api.getCellValue` is, so everything past it is a method on the VALUE that
 * call returned and is none of our business.
 */
export function hasCallableAncestor(chain: string): boolean {
  const parts = chain.split(".");
  for (let i = 1; i < parts.length; i++) {
    const ancestor = parts.slice(0, i).join(".");
    // A NAMESPACE is not a data-returning call. `api` and `caps` are listed as
    // members in their own right (the probe sees them as properties) AND are
    // prefixes of hundreds of chains, so treating them as data-returning would
    // suppress every finding under them -- `api.setCellValu` would sail through
    // as "a method on whatever api returned". Only an ancestor that is callable
    // and is NOT a namespace ends the surface.
    if (CHAINS.has(ancestor) && !PREFIXES.has(ancestor)) return true;
  }
  return false;
}

/** The capabilities calling `chain` requires. Empty for unpoliced members. */
export function capabilitiesFor(chain: string): ReadonlySet<CapabilityId> {
  return CAPABILITY_BY_CHAIN.get(chain) ?? new Set<CapabilityId>();
}

export function surfaceMember(chain: string): SurfaceMember | undefined {
  return SCRIPT_SURFACE.find((m) => m.chain === chain);
}

// ---------------------------------------------------------------------------
// Nearest neighbour
// ---------------------------------------------------------------------------

/** Levenshtein distance, iterative two-row. Small strings; no memo needed. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * The closest real chains to one the author invented, best first.
 *
 * A rejection that only says "does not exist" costs a whole repair round to a
 * model that has no way to guess the right name. Comparing the LAST SEGMENT as
 * well as the whole chain matters: a model that writes `api.formatRange` is
 * usually reaching for something whose namespace it got right, and a model that
 * writes `caps.fetchUrl` got the namespace right and the verb wrong.
 */
export function suggestChains(chain: string, limit = 3): string[] {
  const wantedTail = chain.split(".").pop() ?? chain;
  const wantedNs = chain.split(".").slice(0, -1).join(".");
  const scored: Array<{ candidate: string; score: number }> = [];
  for (const candidate of CHAINS) {
    const tail = candidate.split(".").pop() ?? candidate;
    const ns = candidate.split(".").slice(0, -1).join(".");
    // Whole-chain distance, with the tail weighted double and a bonus for
    // landing in the same namespace.
    const score =
      editDistance(chain, candidate) +
      2 * editDistance(wantedTail, tail) +
      (ns === wantedNs ? -3 : 0);
    scored.push({ candidate, score });
  }
  scored.sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate));
  // A wildly distant "suggestion" is noise that makes the message worse, so the
  // list is cut on absolute closeness, not just rank.
  const threshold = Math.max(6, Math.ceil(wantedTail.length * 0.9));
  return scored.filter((s) => s.score <= threshold).slice(0, limit).map((s) => s.candidate);
}

/** Total members indexed — used by tests to prove the surface is not empty. */
export const SURFACE_SIZE = SCRIPT_SURFACE.length;
