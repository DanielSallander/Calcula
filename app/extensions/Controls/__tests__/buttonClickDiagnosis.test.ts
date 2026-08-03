//! FILENAME: app/extensions/Controls/__tests__/buttonClickDiagnosis.test.ts
// PURPOSE: A run-mode click that runs nothing must SAY so, and say the right
//          thing for each distinguishable cause.
// CONTEXT: The third round of "nothing happens". A silent no-op is treated here
//          as a defect in its own right: every state in which a click cannot do
//          anything gets a message that names the cause and a place to go.

import { describe, it, expect } from "vitest";
import {
  diagnoseButtonClick,
  macroRunnerUnavailableDiagnosis,
  orphanMacroDiagnosis,
} from "../lib/buttonClickDiagnosis";

const script = { id: "macro-control-0-1-1", name: "Macro1426" };

describe("diagnoseButtonClick", () => {
  it("stays quiet when the inline OnSelect actually ran", () => {
    expect(
      diagnoseButtonClick({
        ranInline: true,
        script: null,
        mounted: false,
        hasClickHandler: false,
      }),
    ).toBeNull();
  });

  it("stays quiet when a mounted script with a click handler owns the click", () => {
    expect(
      diagnoseButtonClick({
        ranInline: false,
        script,
        mounted: true,
        hasClickHandler: true,
      }),
    ).toBeNull();
  });

  it("says the button has nothing bound to it", () => {
    const d = diagnoseButtonClick({
      ranInline: false,
      script: null,
      mounted: false,
      hasClickHandler: false,
    })!;
    expect(d.reason).toBe("unbound");
    expect(d.message).toMatch(/no action bound/i);
    // Somewhere to go, not just a complaint.
    expect(d.message).toMatch(/Macros/);
  });

  it("says the bound script is not RUNNING, and names the likely cause", () => {
    const d = diagnoseButtonClick({
      ranInline: false,
      script,
      mounted: false,
      hasClickHandler: false,
    })!;
    expect(d.reason).toBe("notMounted");
    expect(d.variant).toBe("error");
    expect(d.message).toContain("Macro1426");
    expect(d.message).toMatch(/Script Security/);
    expect(d.message).toMatch(/Object Scripts/);
  });

  it("says a running script registered no click handler", () => {
    const d = diagnoseButtonClick({
      ranInline: false,
      script,
      mounted: true,
      hasClickHandler: false,
    })!;
    expect(d.reason).toBe("noClickHandler");
    expect(d.message).toContain("Macro1426");
    expect(d.message).toMatch(/onClick/);
  });

  it("names the missing macro when a linked button is orphaned", () => {
    const d = orphanMacroDiagnosis("macro-do-thing");
    expect(d.reason).toBe("orphanMacro");
    expect(d.variant).toBe("error");
    // The exact failure this feature fought: never a silent no-op.
    expect(d.message).toContain("macro-do-thing");
    expect(d.message).toMatch(/no longer exists/i);
    expect(d.message).toMatch(/Macros/);
  });

  it("distinguishes 'nothing can run a macro' from an orphaned link", () => {
    const d = macroRunnerUnavailableDiagnosis(
      'This button links the recorded macro "macro-x", but the Macro Recorder extension is not loaded.',
    );
    expect(d.reason).toBe("orphanMacro");
    expect(d.variant).toBe("error");
    expect(d.message).toMatch(/Macro Recorder/);
  });

  it("never returns an empty message for a state it reports", () => {
    const states = [
      { ranInline: false, script: null, mounted: false, hasClickHandler: false },
      { ranInline: false, script, mounted: false, hasClickHandler: false },
      { ranInline: false, script, mounted: true, hasClickHandler: false },
    ];
    for (const facts of states) {
      const d = diagnoseButtonClick(facts)!;
      expect(d).not.toBeNull();
      expect(d.message.trim().length).toBeGreaterThan(40);
    }
  });
});
