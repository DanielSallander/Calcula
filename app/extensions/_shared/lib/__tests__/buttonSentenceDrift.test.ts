//! FILENAME: app/extensions/_shared/lib/__tests__/buttonSentenceDrift.test.ts
// PURPOSE: ONE SENTENCE, TWO SPEAKERS. "A button from an application named a
//          macro that is not that application's" is said by the macro-run seam
//          for a button CONTROL's held macro link (TypeScript,
//          `describeMacroNotFromApplication`, MacroRecorder/lib/macroLibrary.ts)
//          and by the Rust button door for a button CELL
//          (`describe_macro_not_from_application`,
//          app/src-tauri/src/scripting/control_action.rs). A user who meets
//          both must read the same words; this renders the Rust template, read
//          at test time, and compares it with the TypeScript output.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { describeMacroNotFromApplication } from "../buttonScriptRun";

const DOOR = fs.readFileSync(
  path.resolve(__dirname, "../../../../src-tauri/src/scripting/control_action.rs"),
  "utf8",
);

/** The body of the Rust fn, up to its closing brace at column 0. */
function rustFn(signature: string): string {
  const start = DOOR.indexOf(signature);
  expect(start, `\`${signature}\` moved`).toBeGreaterThanOrEqual(0);
  return DOOR.slice(start, DOOR.indexOf("\n}\n", start));
}

/** A Rust string literal's value: `\"` unescaped, a `\`-newline continuation and its indent removed. */
function rustString(literal: string): string {
  return literal.replace(/\\\r?\n\s*/g, "").replace(/\\"/g, '"');
}

/** Render the Rust sentence for (fromApplication, macroName, owner). */
function rustSentence(fromApplication: string, macroName: string, owner: string | null): string {
  const body = rustFn("pub(crate) fn describe_macro_not_from_application(");
  const template = /format!\(\s*"((?:[^"\\]|\\[\s\S])*)"/.exec(body);
  expect(template, "the Rust sentence is no longer one format! template").not.toBeNull();
  const none = /None => "((?:[^"\\]|\\[\s\S])*)"\.to_string\(\)/.exec(body);
  const some = /Some\(owner\) => format!\("((?:[^"\\]|\\[\s\S])*)"\)/.exec(body);
  expect(none && some, "the owner clause is no longer a None/Some match").toBeTruthy();
  const clause = owner === null ? rustString(none![1]) : rustString(some![1]).replace("{owner}", owner);
  return rustString(template![1])
    .replace("{from_application}", fromApplication)
    .replace("{macro_name}", macroName)
    .replace("{}", clause);
}

describe("the confused-deputy sentence is the same in TypeScript and in the Rust door", () => {
  // SABOTAGE: change one word of describeMacroNotFromApplication
  // (_shared/lib/buttonScriptRun.ts) -> red.
  it("for the user's own macro", () => {
    expect(describeMacroNotFromApplication("Sales", "Report", null)).toBe(rustSentence("Sales", "Report", null));
    expect(rustSentence("Sales", "Report", null)).toContain("is one of your own");
  });

  it("for another application's macro", () => {
    expect(describeMacroNotFromApplication("Sales", "Report", "HR")).toBe(rustSentence("Sales", "Report", "HR"));
    expect(rustSentence("Sales", "Report", "HR")).toContain('came with a different application, "HR"');
  });
});
