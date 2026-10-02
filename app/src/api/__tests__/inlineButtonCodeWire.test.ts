//! FILENAME: app/src/api/__tests__/inlineButtonCodeWire.test.ts
// PURPOSE: The inline button code a subscribe HELD and a subscribe or refresh
//          REMOVED (phase 4 of BUG-0257) reaches the page under the names Rust
//          serializes: `PullResponse.inline_button_code_held` /
//          `inline_button_code_removed` (app/src-tauri/src/calp_commands.rs)
//          and core `RefreshResult.inline_button_code_removed`
//          (core/calp/src/refresh.rs), camelCased by `rename_all`. A renamed
//          field on either side would leave the Subscribe and Refresh dialogs
//          silently saying nothing about code that arrived held, or was removed.
// CONTEXT: The buttonsRunningMacroWire pattern: both Rust files are read at
//          test time, and a typed literal ties the TypeScript side.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { PullResponse, RefreshResult } from "../collaboration";

const APP = path.resolve(__dirname, "../../..");
const read = (rel: string) => fs.readFileSync(path.resolve(APP, rel), "utf8").replace(/\r\n/g, "\n");

/** The body of `pub struct <name> {` and the attribute lines above it. */
function rustStruct(src: string, name: string): { head: string; body: string } {
  const at = src.indexOf(`pub struct ${name} {`);
  expect(at, `Rust ${name} not found`).toBeGreaterThanOrEqual(0);
  const head = src.slice(src.lastIndexOf("#[derive", at), at);
  return { head, body: src.slice(at, src.indexOf("\n}\n", at)) };
}

/** `pub <field>: <type>` pairs, comments stripped. */
function rustFields(body: string): Map<string, string> {
  const code = body
    .split("\n")
    .filter((l) => !/^\s*(\/\/|#\[)/.test(l))
    .join("\n");
  return new Map([...code.matchAll(/^\s*pub (\w+): ([^,\n]+),/gm)].map((m) => [m[1], m[2].trim()]));
}

const camel = (snake: string) => snake.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());

/** The text of `export interface <name> {` in collaboration.ts. */
function tsInterface(name: string): string {
  const src = read("src/api/collaboration.ts");
  const at = src.indexOf(`export interface ${name} {`);
  expect(at, `TS ${name} not found`).toBeGreaterThanOrEqual(0);
  return src.slice(at, src.indexOf("\n}\n", at));
}

describe("PullResponse carries the inline button code a subscribe held and removed", () => {
  const rust = rustStruct(read("src-tauri/src/calp_commands.rs"), "PullResponse");
  const fields = rustFields(rust.body);

  // SABOTAGE: rename `inline_button_code_held` in the Rust PullResponse (or
  // `inlineButtonCodeHeld` here) -> red.
  it("names the fields as Rust serializes them", () => {
    expect(rust.head).toContain('#[serde(rename_all = "camelCase")]');
    expect(fields.get("inline_button_code_held")).toBe("usize");
    expect(fields.get("inline_button_code_removed")).toBe("Vec<String>");
    const ts = tsInterface("PullResponse");
    expect(ts).toContain(`${camel("inline_button_code_held")}?: number;`);
    expect(ts).toContain(`${camel("inline_button_code_removed")}?: string[];`);
  });

  it("is the type the dialog reads (a compile-time mirror)", () => {
    const sample: Required<Pick<PullResponse, "inlineButtonCodeHeld" | "inlineButtonCodeRemoved">> = {
      inlineButtonCodeHeld: 2,
      inlineButtonCodeRemoved: ["Dashboard!B2: its action is a formula, ..."],
    };
    expect(Object.keys(sample).sort()).toEqual(
      ["inline_button_code_held", "inline_button_code_removed"].map(camel).sort(),
    );
  });
});

describe("RefreshResult carries the inline button code a refresh removed", () => {
  const rust = rustStruct(read("../core/calp/src/refresh.rs"), "RefreshResult");
  const fields = rustFields(rust.body);

  // SABOTAGE: rename `inline_button_code_removed` in core RefreshResult -> red.
  it("names the field as Rust serializes it", () => {
    expect(rust.head).toContain('#[serde(rename_all = "camelCase")]');
    expect(fields.get("inline_button_code_removed")).toBe("Vec<String>");
    expect(tsInterface("RefreshResult")).toContain(`${camel("inline_button_code_removed")}?: string[];`);
    const sample: Required<Pick<RefreshResult, "inlineButtonCodeRemoved">> = { inlineButtonCodeRemoved: [] };
    expect(Object.keys(sample)).toEqual([camel("inline_button_code_removed")]);
  });

  it("the host fills it from the admission (not left empty by construction)", () => {
    const calp = read("src-tauri/src/calp_commands.rs");
    expect(calp).toContain("inline_button_code_removed.extend(admitted.wiring.inline_removed);");
    expect(calp).toContain("result.inline_button_code_removed.extend(std::mem::take(&mut inline_button_code_removed));");
  });
});
