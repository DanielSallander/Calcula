// FILENAME: app/extensions/Collaboration/lib/includeInApplication.ts
// PURPOSE: What the author has chosen to ADD to the application in the push
//          dialog ("Include in application", M4), and the one rule that makes
//          the choice safe: nothing can be ticked until its code has been on
//          screen, and a tick names the hash RUST computed of that code.
// CONTEXT: A macro, notebook or workbook name the author creates in a working
//          copy is theirs, so a push withholds it (BUG-0261) -- and a button
//          linked to that macro shipped dead. The push report now offers each
//          such item as `includable`, with its exact text (`code`) and the
//          sha256 of that text (`contentHash`). Ticking it sends
//          `{kind, id, hash}`; the push refuses an item whose content no longer
//          has that hash (`CALP_PUSH_INCLUDED_CHANGED`), because what is added
//          goes out under the author's key.
//
//          A tick is keyed by kind + id and REMEMBERS the hash that was read, so
//          code that changes after the tick is recognisable as "changed since
//          you read it" instead of silently becoming a different tick.

import type { IncludedItem, WithheldContent, WithheldKind } from "@api";

/** What the author has ticked, and which code has been on screen. */
export interface IncludeState {
  /** kind + id -> the inclusion, with the hash of the code the author READ. */
  readonly ticks: Readonly<Record<string, IncludedItem>>;
  /** kind + id + hash of every item whose code has been shown. */
  readonly reviewed: readonly string[];
}

export const EMPTY_INCLUDE_STATE: IncludeState = { ticks: {}, reviewed: [] };

/** The kind + id an inclusion is keyed by. A workbook name ignores case, as
 *  every name comparison does (and as Rust matches it). */
export function itemKey(item: { kind: WithheldKind; id: string }): string {
  const id = item.kind === "namedRange" ? item.id.toUpperCase() : item.id;
  return `${item.kind}\u0000${id}`;
}

function reviewKey(item: WithheldContent): string {
  return `${itemKey(item)}\u0000${item.contentHash ?? ""}`;
}

/** Can this item be added at all? Only what Rust offered, with a Rust hash. */
export function canInclude(item: WithheldContent): boolean {
  return item.includable === true && (item.contentHash ?? "") !== "";
}

/** Has THIS item's code -- at this hash -- been on screen? */
export function isReviewed(state: IncludeState, item: WithheldContent): boolean {
  return state.reviewed.includes(reviewKey(item));
}

/** Record that the item's code has been shown. */
export function markReviewed(state: IncludeState, item: WithheldContent): IncludeState {
  if (!canInclude(item) || isReviewed(state, item)) return state;
  return { ...state, reviewed: [...state.reviewed, reviewKey(item)] };
}

/** Is the item ticked for the code it holds NOW? */
export function isIncluded(state: IncludeState, item: WithheldContent): boolean {
  const tick = state.ticks[itemKey(item)];
  return tick !== undefined && tick.hash === (item.contentHash ?? "");
}

/** Ticked -- but for code other than what the item holds now (it changed since it was read). */
export function isTickedForOtherCode(state: IncludeState, item: WithheldContent): boolean {
  const tick = state.ticks[itemKey(item)];
  return tick !== undefined && tick.hash !== (item.contentHash ?? "");
}

/**
 * Tick or untick. A tick is REFUSED -- the state comes back unchanged -- unless
 * the item is includable, carries a Rust hash, and its code has been on screen.
 * The hash sent is the item's own `contentHash`, never one computed here.
 */
export function setIncluded(state: IncludeState, item: WithheldContent, include: boolean): IncludeState {
  const key = itemKey(item);
  if (!include) {
    if (!(key in state.ticks)) return state;
    const ticks = { ...state.ticks };
    delete ticks[key];
    return { ...state, ticks };
  }
  if (!canInclude(item) || !isReviewed(state, item)) return state;
  return {
    ...state,
    ticks: { ...state.ticks, [key]: { kind: item.kind, id: item.id, hash: item.contentHash ?? "" } },
  };
}

/** The request's `includeInApplication`, in a stable order. */
export function includeList(state: IncludeState): IncludedItem[] {
  return Object.keys(state.ticks)
    .sort()
    .map((k) => state.ticks[k]);
}

/** Which inclusion an answer was computed for, as one comparable string. */
export function includeSignature(state: IncludeState): string {
  return JSON.stringify(includeList(state));
}

/**
 * Drop the ticks for items the latest answer no longer offers AT ALL -- in
 * neither what the push withholds nor what it adds. That is an item a push has
 * since shipped (it is part of the application now, so there is nothing left to
 * include), or one that is gone: a tick for it can only ever be refused
 * (`CALP_PUSH_INCLUDED_CHANGED`), and with no row left to untick it from, the
 * push would stay blocked until the dialog was closed. A tick for an item that
 * IS still listed -- changed since it was read, or no longer the author's -- is
 * kept, so the dialog can say why it is refused and offer the untick.
 */
export function pruneTicks(
  state: IncludeState,
  withheld: readonly WithheldContent[],
  added: readonly WithheldContent[],
): IncludeState {
  const offered = new Set([...withheld, ...added].map((item) => itemKey(item)));
  const gone = Object.keys(state.ticks).filter((key) => !offered.has(key));
  if (gone.length === 0) return state;
  const ticks = { ...state.ticks };
  for (const key of gone) delete ticks[key];
  return { ...state, ticks };
}

/**
 * The ticks the latest answer did NOT honour: the item is not among what the
 * push adds with the hash that was read -- its code changed since, it is no
 * longer the author's to add, or it is gone. Only meaningful for an answer
 * computed for this very inclusion.
 */
export function unhonouredIncludes(state: IncludeState, added: readonly WithheldContent[]): IncludedItem[] {
  return includeList(state).filter(
    (tick) => !added.some((a) => itemKey(a) === itemKey(tick) && (a.contentHash ?? "") === tick.hash),
  );
}
