//! FILENAME: app/src/core/lib/__tests__/editOpenBuffer.test.ts
// PURPOSE: The rules of the editor-open window, on their own.
// CONTEXT: The integration behaviour (typing into a closed cell keeps every
//          character) is pinned in
//          components/Spreadsheet/__tests__/editorTypingRace.test.tsx. This file
//          pins the classification the container relies on, because getting a
//          single key into the wrong bucket is silent: a passthrough that should
//          have been text loses a character, and a text key that should have
//          been a passthrough steals a shortcut.

import { describe, it, expect, afterEach } from "vitest";
import {
  beginEditorOpen,
  isEditorOpening,
  openEntryValue,
  handleKeyWhileOpening,
  endEditorOpen,
  abortEditorOpen,
  type OpenKeyLike,
} from "../editOpenBuffer";

function key(k: string, mods: Partial<OpenKeyLike> = {}): OpenKeyLike {
  return { key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods };
}

afterEach(() => {
  // Also clears the failsafe timer, so a test that leaves a window open cannot
  // fire a warning into the next one.
  abortEditorOpen();
});

describe("editOpenBuffer", () => {
  it("is closed until an open begins", () => {
    expect(isEditorOpening()).toBe(false);
    expect(openEntryValue()).toBeNull();
    // A key offered while closed is not ours.
    expect(handleKeyWhileOpening(key("a"))).toEqual({ kind: "passthrough" });
  });

  it("accumulates characters in the order they were typed", () => {
    beginEditorOpen("h");
    for (const ch of "ello") handleKeyWhileOpening(key(ch));
    expect(openEntryValue()).toBe("hello");
  });

  it("reports the entry after each key so the caller can show it", () => {
    beginEditorOpen("a");
    expect(handleKeyWhileOpening(key("b"))).toEqual({ kind: "text", value: "ab" });
    expect(handleKeyWhileOpening(key("c"))).toEqual({ kind: "text", value: "abc" });
  });

  it("treats Backspace as a correction, not as a passthrough", () => {
    beginEditorOpen("a");
    handleKeyWhileOpening(key("b"));
    expect(handleKeyWhileOpening(key("Backspace"))).toEqual({ kind: "text", value: "a" });
  });

  it("swallows Delete instead of letting it reach 'clear the cell'", () => {
    beginEditorOpen("a");
    // The caret is at the end of the entry, so there is nothing to delete --
    // but passing it through would hit the container's Delete branch and wipe
    // the entry the user is in the middle of typing.
    expect(handleKeyWhileOpening(key("Delete"))).toEqual({ kind: "text", value: "a" });
  });

  it("makes Alt+Enter a line break in the pending entry", () => {
    beginEditorOpen("a");
    expect(handleKeyWhileOpening(key("Enter", { altKey: true }))).toEqual({
      kind: "text",
      value: "a\n",
    });
  });

  it.each(["Enter", "Tab", "Escape"] as const)("latches %s for replay", (k) => {
    beginEditorOpen("a");
    expect(handleKeyWhileOpening(key(k, { shiftKey: true }))).toEqual({ kind: "terminal" });
    expect(endEditorOpen()).toEqual({ key: k, shiftKey: true });
  });

  it("refuses characters typed after the entry was ended", () => {
    beginEditorOpen("a");
    handleKeyWhileOpening(key("Enter"));
    // "b" belongs to the NEXT cell; folding it in would commit "ab" here.
    expect(handleKeyWhileOpening(key("b"))).toEqual({ kind: "passthrough" });
    expect(openEntryValue()).toBe("a");
  });

  it("hands back keys it has no business with", () => {
    beginEditorOpen("a");
    for (const k of [
      key("ArrowDown"),
      key("F2"),
      key("c", { ctrlKey: true }),
      key("v", { metaKey: true }),
      key("Home"),
      key("Enter", { ctrlKey: true }),
    ]) {
      expect(handleKeyWhileOpening(k)).toEqual({ kind: "passthrough" });
    }
    expect(openEntryValue()).toBe("a");
  });

  it("never takes an IME composition keydown", () => {
    beginEditorOpen("a");
    // Both signals matter: WebView2 reports keyCode 229 with key "Process",
    // and the composition result arrives later on the focused element.
    expect(handleKeyWhileOpening(key("Process", { keyCode: 229 }))).toEqual({
      kind: "passthrough",
    });
    expect(handleKeyWhileOpening(key("a", { isComposing: true }))).toEqual({
      kind: "passthrough",
    });
    expect(openEntryValue()).toBe("a");
  });

  it("closes on end, and reports no terminal when none was pressed", () => {
    beginEditorOpen("a");
    expect(endEditorOpen()).toBeNull();
    expect(isEditorOpening()).toBe(false);
    // Ending twice is harmless -- the editor's focus effect can run again.
    expect(endEditorOpen()).toBeNull();
  });

  it("throws the whole window away on abort", () => {
    beginEditorOpen("a");
    handleKeyWhileOpening(key("Enter"));
    abortEditorOpen();
    expect(isEditorOpening()).toBe(false);
    expect(endEditorOpen()).toBeNull();
  });

  it("starts a fresh window when a second open begins", () => {
    beginEditorOpen("a");
    handleKeyWhileOpening(key("b"));
    beginEditorOpen("z");
    expect(openEntryValue()).toBe("z");
  });
});
