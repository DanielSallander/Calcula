//! FILENAME: app/extensions/FormulaAssist/lib/store.ts
// PURPOSE: The popover's state, held OUTSIDE React so a command, a keybinding
//          and a context-menu item can open it without owning a component.
// CONTEXT: The overlay is registered once at activation and rendered
//          permanently (the FormulaAutocomplete pattern): the component returns
//          null while `open` is false, so "always mounted" costs nothing. That
//          only works if the thing that decides whether it is open lives
//          somewhere a plain function can reach — hence a module-level store
//          with `useSyncExternalStore` on top, rather than component state.
//
//          Hand-rolled rather than zustand, for one reason that matters: the
//          ladder's phase callback fires from a promise chain that has no
//          component behind it, and the insert path must be drivable from a
//          unit test with no DOM at all. A 60-line store with `getState` /
//          `setState` / `subscribe` does that and stays readable.
//
//          NOTHING HERE WRITES A CELL. The store records what the user asked
//          for and what came back; `insert.ts` is the only writer, and it is
//          called from a click handler, never from a state transition.

import { useSyncExternalStore } from "react";
import type { AnchorRect } from "@api/uiTypes";
import type { FormulaProposal } from "@api/formulaAssistService";
import type { ExplainResult } from "./explain";

/** What the live phase line says while a request is in flight. */
export type PhaseText = string;

export interface AssistTarget {
  sheetIndex: number;
  row: number;
  col: number;
  a1: string;
  /** The formula already in the cell, when there is one. Drives "Fix this…". */
  existingFormula: string | null;
}

export interface AssistState {
  open: boolean;
  /** The text in the intent box. */
  intent: string;
  /** The cell a request is bound to, captured when the popover opened. */
  target: AssistTarget | null;
  anchor: AnchorRect | null;
  running: boolean;
  /** A sentence, refreshed as the ladder advances. Never empty while running. */
  phase: PhaseText;
  proposal: FormulaProposal | null;
  /** Tier-0 explanation of what is IN the cell, when the user asked for one. */
  explanation: ExplainResult | null;
  /** A transport failure — the only thing the ladder throws for. */
  failure: string | null;
  inserting: boolean;
  /** What the last insert did, so the popover can confirm it in words. */
  inserted: { a1: string; cellsWritten: number; selectionMoved: boolean } | null;
}

const initial: AssistState = {
  open: false,
  intent: "",
  target: null,
  anchor: null,
  running: false,
  phase: "",
  proposal: null,
  explanation: null,
  failure: null,
  inserting: false,
  inserted: null,
};

let state: AssistState = initial;
const listeners = new Set<() => void>();

export function getAssistState(): AssistState {
  return state;
}

export function setAssistState(patch: Partial<AssistState>): void {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
}

export function subscribeAssist(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React binding. The component re-renders on every `setAssistState`. */
export function useAssistState(): AssistState {
  return useSyncExternalStore(subscribeAssist, getAssistState, getAssistState);
}

/**
 * Open the popover on a cell.
 *
 * Clears every previous result. A stale proposal from the last cell showing
 * above a fresh intent box is how a person inserts a formula that was verified
 * somewhere else.
 */
export function openAssist(args: {
  target: AssistTarget;
  anchor: AnchorRect | null;
  intent?: string;
}): void {
  setAssistState({
    open: true,
    intent: args.intent ?? "",
    target: args.target,
    anchor: args.anchor,
    running: false,
    phase: "",
    proposal: null,
    explanation: null,
    failure: null,
    inserting: false,
    inserted: null,
  });
}

export function closeAssist(): void {
  setAssistState({ ...initial });
}

/** Test hook: back to the state a fresh session starts in. */
export function resetAssistStore(): void {
  state = initial;
  for (const listener of [...listeners]) listener();
}
