//! FILENAME: app/extensions/Pivot/lib/__tests__/drillDispatch.test.ts
// PURPOSE: Pin BUG-0096 — a pivot double-click must never be a silent no-op.
//
// The defect: the interceptor asked "does this pivot have a script attached"
// (`hasObjectScript`), emitted `pivot:drillThrough` and RETURNED. But registering
// a handler is opt-in, so a script hooking only `onRefresh` left the event with no
// subscriber and the built-in drill already skipped — no drill, no fallback, no
// message. The four-fact decision below is what makes the fallback symmetric.

import { describe, it, expect } from "vitest";
import {
  decideDrillDispatch,
  diagnoseScriptDrill,
  type PivotDrillFacts,
} from "../drillDispatch";

const base: PivotDrillFacts = {
  kind: "script",
  script: { id: "s1", name: "Drill handler" },
  mounted: true,
  handlesDrill: true,
};

describe("pivot drill dispatch", () => {
  it("routes to the script only when all four facts hold", () => {
    expect(decideDrillDispatch(base)).toBe("script");
  });

  it("THE BUG: a mounted script with no drill handler falls back, it does not vanish", () => {
    const facts = { ...base, handlesDrill: false };
    expect(
      decideDrillDispatch(facts),
      "this is BUG-0096 exactly: the script exists and is running, but never " +
        "registered pivot.onDrillThrough. Before the fix the event was emitted to " +
        "nobody and the built-in drill was skipped, so the double-click did nothing.",
    ).toBe("builtin");
    const d = diagnoseScriptDrill(facts);
    expect(d?.variant).toBe("warning");
    expect(d?.message).toContain("never registered a drill handler");
    expect(d?.message).toContain("built-in drill instead");
  });

  it("a script that is attached but NOT running falls back, and says why", () => {
    const facts = { ...base, mounted: false, handlesDrill: false };
    expect(decideDrillDispatch(facts)).toBe("builtin");
    const d = diagnoseScriptDrill(facts);
    expect(d?.variant, "not running is an error, not a warning").toBe("error");
    expect(d?.message).toContain("NOT running");
    // Script Security blocking a script is the most likely cause and the one a
    // user can act on, so the message names it.
    expect(d?.message).toContain("Script Security");
  });

  it("is silent in the three cases where silence is correct", () => {
    // Not script mode: the built-in drill is simply what was configured.
    expect(diagnoseScriptDrill({ ...base, kind: "sheet" })).toBeNull();
    expect(diagnoseScriptDrill({ ...base, kind: undefined })).toBeNull();
    // The script IS taking it: nothing went wrong.
    expect(diagnoseScriptDrill(base)).toBeNull();
    // Script mode with NO script attached: pre-existing deliberate behaviour, and
    // the built-in drill still runs, so the click is not lost.
    expect(
      diagnoseScriptDrill({ ...base, script: null, mounted: false, handlesDrill: false }),
    ).toBeNull();
  });

  it("never routes to a script in a non-script mode, whatever the other facts say", () => {
    // Defence against a future caller passing stale facts: `kind` is decisive.
    expect(decideDrillDispatch({ ...base, kind: "sheet" })).toBe("builtin");
    expect(decideDrillDispatch({ ...base, kind: undefined })).toBe("builtin");
  });

  it("every builtin verdict either toasts or is deliberately silent — none is a dead end", () => {
    // The invariant the interceptor's own comment claimed and did not hold:
    // "a double-click is never a silent no-op". Enumerate the whole fact space.
    const kinds = ["script", "sheet", undefined];
    const scripts = [null, { id: "s1", name: "S" }];
    for (const kind of kinds) {
      for (const script of scripts) {
        for (const mounted of [true, false]) {
          for (const handlesDrill of [true, false]) {
            const facts: PivotDrillFacts = { kind, script, mounted, handlesDrill };
            const route = decideDrillDispatch(facts);
            if (route === "script") {
              // The script takes it: it must genuinely be able to.
              expect(facts.kind).toBe("script");
              expect(facts.script).not.toBeNull();
              expect(facts.mounted).toBe(true);
              expect(facts.handlesDrill).toBe(true);
            } else {
              // Otherwise the BUILT-IN drill runs. That is the fallback, so the
              // user always gets something; a toast is extra, not the remedy.
              expect(route).toBe("builtin");
            }
          }
        }
      }
    }
  });
});
