//! FILENAME: app/src/api/macroSeams.test.ts
// PURPOSE: The two IoC seams the macro-link model rides on behave like the other
//          @api providers: last registration wins, require throws with a
//          user-facing message when nothing is registered, and unregister only
//          clears the provider that is still current.

import { describe, it, expect, beforeEach } from "vitest";
import {
  hasMacroRunProvider,
  registerMacroRunProvider,
  requireMacroRunProvider,
  resetMacroRunProvider,
  type MacroRunOutcome,
} from "./macroRunService";
import {
  hasScriptEditorProvider,
  registerScriptEditorProvider,
  requireScriptEditorProvider,
  resetScriptEditorProvider,
} from "./scriptEditorService";

describe("macroRunService seam", () => {
  beforeEach(() => resetMacroRunProvider());

  it("throws a user-facing message when nothing is registered", () => {
    expect(hasMacroRunProvider()).toBe(false);
    expect(() => requireMacroRunProvider()).toThrow(/Macro Recorder/);
  });

  it("runs through the registered provider and returns its outcome", async () => {
    const outcome: MacroRunOutcome = { status: "ran", name: "M" };
    registerMacroRunProvider({ runMacroByRef: async () => outcome });
    expect(hasMacroRunProvider()).toBe(true);
    expect(await requireMacroRunProvider().runMacroByRef("macro-x")).toEqual(outcome);
  });

  it("unregister only clears the provider that is still current", () => {
    const unregA = registerMacroRunProvider({
      runMacroByRef: async () => ({ status: "notFound", macroId: "a" }),
    });
    registerMacroRunProvider({
      runMacroByRef: async () => ({ status: "ran", name: "B" }),
    });
    // A's cleanup must NOT blank out B (last registration wins).
    unregA();
    expect(hasMacroRunProvider()).toBe(true);
  });
});

describe("scriptEditorService seam", () => {
  beforeEach(() => resetScriptEditorProvider());

  it("throws a user-facing message when nothing is registered", () => {
    expect(hasScriptEditorProvider()).toBe(false);
    expect(() => requireScriptEditorProvider()).toThrow(/ScriptableObjects/);
  });

  it("opens through the registered provider", async () => {
    const opened: string[] = [];
    registerScriptEditorProvider({
      openMacroInEditor: async (id) => {
        opened.push(id);
      },
    });
    await requireScriptEditorProvider().openMacroInEditor("macro-x");
    expect(opened).toEqual(["macro-x"]);
  });
});
