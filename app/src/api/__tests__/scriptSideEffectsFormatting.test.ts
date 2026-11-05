//! FILENAME: app/src/api/__tests__/scriptSideEffectsFormatting.test.ts
// PURPOSE: A module run's queued cell styles arrive APPLIED (Rust applies them
//          with the run's cells, in one undo step -- apply_run_with_queued_styles)
//          and flagged `formattingApplied`; the page then only re-reads its
//          styles and repaints, and never replays a style.
// SABOTAGE: drop the `formattingApplied` branch from dispatchScriptSideEffects
//          -> no "styles:refresh" is heard and the first test fails.

import { describe, it, expect, afterEach } from "vitest";
import {
  dispatchScriptSideEffects,
  SCRIPT_DEFERRED_ACTIONS_EVENT,
} from "../workbookScripts";

const heard: string[] = [];
const listen = (type: string) => {
  const fn = () => heard.push(type);
  window.addEventListener(type, fn);
  return () => window.removeEventListener(type, fn);
};
const stops: Array<() => void> = [];

afterEach(() => {
  for (const s of stops.splice(0)) s();
  heard.length = 0;
});

describe("a run that applied its queued cell styles", () => {
  it("makes the grid re-read its styles and repaint", () => {
    stops.push(listen("styles:refresh"), listen("grid:refresh"), listen(SCRIPT_DEFERRED_ACTIONS_EVENT));
    dispatchScriptSideEffects({ formattingApplied: true });
    expect(heard).toContain("styles:refresh");
    expect(heard).toContain("grid:refresh");
    expect(heard, "nothing is replayed").not.toContain(SCRIPT_DEFERRED_ACTIONS_EVENT);
  });

  it("a run that applied none announces nothing", () => {
    stops.push(listen("styles:refresh"), listen("grid:refresh"));
    dispatchScriptSideEffects({});
    expect(heard).toEqual([]);
  });
});
