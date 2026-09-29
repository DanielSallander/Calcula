//! FILENAME: app/src/api/__tests__/keybindings.noStandAsideHelper.test.ts
// PURPOSE: The keybinding module offers no "does the registry bind this
//          command?" helper for an extension's OWN key listener to stand aside
//          by.
// CONTEXT: W19 (wave C; wb-doors new defect). `isCommandShortcutBound` was
//          written for the stand-aside listeners of BUG-0183: an extension
//          listened for its command's hard-coded combination and was to skip
//          the key when the registry bound the command. Wave B deleted every
//          such listener instead (D1, D2 -- a remap moved the binding, never
//          the listener's combination), which left the helper with no caller
//          and an invitation to write the retired pattern again. The rule is
//          the registry's: register the command, let a binding run it
//          (extensions/__tests__/extensionKeyListenersRetired.test.ts).

import { describe, it, expect } from "vitest";
import * as keybindings from "../keybindings";

describe("@api/keybindings", () => {
  it("has no stand-aside helper for extension key listeners", () => {
    expect(Object.keys(keybindings)).not.toContain("isCommandShortcutBound");
  });

  it("control: the registry's own questions are still exported", () => {
    expect(typeof keybindings.getAllKeybindings).toBe("function");
    expect(typeof keybindings.isGridFocused).toBe("function");
  });
});
