//! FILENAME: app/src/api/__tests__/buttonCommandListDrift.test.ts
// PURPOSE: plan_M8 S2 -- the two yeses of an application's button command are
//          held to ONE list. Rust's `DISTRIBUTABLE_BUTTON_COMMANDS`
//          (app/src-tauri/src/button_cells.rs) decides at admission and in the
//          click gate; the page reads `distributableTrigger: true` off the LIVE
//          registered command. A command on one list and not the other is a
//          button that the subscribe keeps and the click then refuses (Rust
//          yes, page no), or a flag that promises the author something no
//          subscriber's Rust will ever allow (page yes, Rust no).
// CONTEXT: THE DIRECTION IS RUST -> TYPESCRIPT, as in interpreterReachDrift:
//          the Rust constant is read at test time with fs and is the authority;
//          the TypeScript side is every command OBJECT LITERAL under
//          app/extensions and app/src that carries `distributableTrigger: true`
//          (tests excluded -- they flag synthetic commands on purpose). Both
//          lists are EMPTY today (the owner names the first command), so a
//          self-test feeds the scanner synthetic sources and requires it to
//          find what is there and nothing else: an empty-equals-empty pass from
//          a scanner that finds nothing would prove nothing.
//
//          The consent-key prefix is pinned here too: the approval screen
//          records under `button-commands:<application>` and Rust's gate asks
//          that key, so one spelling drifting makes every approval invisible.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { BUTTON_COMMAND_CONSENT_PREFIX, buttonCommandConsentKey } from "../heldButtonCode";

const APP_ROOT = join(__dirname, "..", "..", "..");
const RUST_BUTTON_CELLS = join(APP_ROOT, "src-tauri", "src", "button_cells.rs");

/** The ids of `pub const DISTRIBUTABLE_BUTTON_COMMANDS: &[&str] = &[ ... ];`. */
function rustList(code: string): string[] {
  const marker = "pub const DISTRIBUTABLE_BUTTON_COMMANDS: &[&str] = &[";
  const at = code.indexOf(marker);
  expect(at, "DISTRIBUTABLE_BUTTON_COMMANDS is not declared in button_cells.rs").toBeGreaterThan(-1);
  const end = code.indexOf("];", at);
  expect(end, "DISTRIBUTABLE_BUTTON_COMMANDS has no closing `];`").toBeGreaterThan(at);
  const body = code
    .slice(at + marker.length, end)
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  return [...body.matchAll(/"([^"\\]*)"/g)].map((m) => m[1]);
}

/** The value of `pub const BUTTON_COMMAND_CONSENT_PREFIX: &str = "...";`. */
function rustPrefix(code: string): string {
  const m = /pub const BUTTON_COMMAND_CONSENT_PREFIX: &str = "([^"]*)";/.exec(code);
  expect(m, "BUTTON_COMMAND_CONSENT_PREFIX is not declared in button_cells.rs").not.toBeNull();
  return m![1];
}

/**
 * The source with its comments blanked out, string contents kept: a doc comment
 * that SAYS "`distributableTrigger: true`" is prose, not a registration. Each
 * comment character becomes a space (newlines kept) so offsets stay put.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += src[i];
        i++;
      }
      out += src[i] ?? "";
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** What the scanner found in one source: flagged ids, and flagged literals it could not name. */
interface ScanResult {
  ids: string[];
  unnamed: number;
}

/**
 * Every object literal in `src` that carries `distributableTrigger: true`, by
 * its top-level `id: "..."`. The enclosing `{` is found by walking back with a
 * brace count; the id must sit at depth 1 of that literal (an `id` inside a
 * nested object is not the command's). A flagged literal with no string id --
 * `{ ...base, distributableTrigger: true }`, or an id from a variable -- is
 * counted as UNNAMED, which the census treats as a failure: the list must be
 * checkable, so a flagged command spells its id.
 */
function scanFlaggedCommands(src: string): ScanResult {
  const code = stripComments(src);
  const ids: string[] = [];
  let unnamed = 0;
  for (const m of code.matchAll(/\bdistributableTrigger\s*:\s*true\b/g)) {
    let depth = 0;
    let start = -1;
    for (let i = m.index! - 1; i >= 0; i--) {
      const ch = code[i];
      if (ch === "}") depth++;
      else if (ch === "{") {
        if (depth === 0) {
          start = i;
          break;
        }
        depth--;
      }
    }
    if (start < 0) {
      unnamed++;
      continue;
    }
    let id: string | null = null;
    let d = 0;
    for (let i = start; i < code.length; i++) {
      const ch = code[i];
      if (ch === "{") d++;
      else if (ch === "}") {
        d--;
        if (d === 0) break;
      } else if (d === 1 && /[\s,{]/.test(code[i - 1] ?? " ") && code.startsWith("id", i)) {
        const idMatch = /^id\s*:\s*(["'])([^"']+)\1/.exec(code.slice(i));
        if (idMatch) {
          id = idMatch[2];
          break;
        }
      }
    }
    if (id === null) unnamed++;
    else ids.push(id);
  }
  return { ids, unnamed };
}

/** Every production .ts/.tsx file under `dir` (tests, fixtures and node_modules excluded). */
function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name === "__fixtures__") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...productionFiles(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

describe("the drift scanner (self-test: it must find what is there)", () => {
  // SABOTAGE (6): break the scanner's flag regex (e.g. `distributableTrigger\s*=\s*true`)
  // -> nothing is found, red.
  it("finds a flagged command literal by its id, whatever the property order and nesting", () => {
    const src = `
      ExtensionRegistry.registerCommand({
        id: "reader.refresh",
        name: "Refresh",
        execute: async (ctx) => { const x = { id: "not.this" }; await go(x); },
        distributableTrigger: true,
      });
      const another = { distributableTrigger: true, name: "Other", id: 'reader.other', execute() {} };
    `;
    expect(scanFlaggedCommands(src)).toEqual({ ids: ["reader.refresh", "reader.other"], unnamed: 0 });
  });

  it("ignores prose, the type declaration and an unflagged command", () => {
    const src = `
      /** Opt in with \`distributableTrigger: true\` on the registration. */
      export interface CommandDefinition { id: string; distributableTrigger?: true; }
      // distributableTrigger: true in a line comment
      registerCommand({ id: "plain.command", name: "Plain", execute() {} });
      registerCommand({ id: "off.command", distributableTrigger: false, execute() {} });
    `;
    expect(scanFlaggedCommands(src)).toEqual({ ids: [], unnamed: 0 });
  });

  it("counts a flagged literal whose id it cannot read as UNNAMED", () => {
    expect(scanFlaggedCommands("registerCommand({ ...base, distributableTrigger: true });")).toEqual({ ids: [], unnamed: 1 });
    expect(scanFlaggedCommands("registerCommand({ id: COMMAND_ID, distributableTrigger: true });")).toEqual({ ids: [], unnamed: 1 });
  });

  it("parses the Rust list's string items, comments aside", () => {
    expect(
      rustList(
        'pub const DISTRIBUTABLE_BUTTON_COMMANDS: &[&str] = &[\n    "reader.refresh", // "commented.out"\n    "reader.other",\n];',
      ),
    ).toEqual(["reader.refresh", "reader.other"]);
    expect(rustList("pub const DISTRIBUTABLE_BUTTON_COMMANDS: &[&str] = &[];")).toEqual([]);
  });
});

describe("Rust's list and the flagged registrations are the same list", () => {
  it("every id on DISTRIBUTABLE_BUTTON_COMMANDS is flagged in TypeScript, and every flagged command is on it", () => {
    const rust = rustList(readFileSync(RUST_BUTTON_CELLS, "utf8"));
    const files = [...productionFiles(join(APP_ROOT, "src")), ...productionFiles(join(APP_ROOT, "extensions"))];
    expect(files.length, "the census read no files").toBeGreaterThan(100);
    const flagged: string[] = [];
    const unnamed: string[] = [];
    for (const file of files) {
      const result = scanFlaggedCommands(readFileSync(file, "utf8"));
      flagged.push(...result.ids);
      if (result.unnamed > 0) unnamed.push(file.replace(APP_ROOT, ""));
    }
    expect(unnamed, "a command is flagged distributableTrigger without a literal id the census can read").toEqual([]);
    expect(new Set(flagged), "the flagged commands are not Rust's DISTRIBUTABLE_BUTTON_COMMANDS").toEqual(new Set(rust));
    expect(flagged.length, "a command id is flagged in two registrations").toBe(new Set(flagged).size);
  });
});

describe("the command-approval key is spelled once", () => {
  // SABOTAGE (7): TS spells the prefix "button-command:" -> red.
  it("TypeScript's prefix is Rust's", () => {
    expect(BUTTON_COMMAND_CONSENT_PREFIX).toBe(rustPrefix(readFileSync(RUST_BUTTON_CELLS, "utf8")));
    expect(buttonCommandConsentKey("Sales")).toBe(`${BUTTON_COMMAND_CONSENT_PREFIX}Sales`);
  });

  it("an application's command key is never its bare key (the object-script mount floor's)", () => {
    expect(buttonCommandConsentKey("Sales")).not.toBe("Sales");
    // Application names cannot contain ':' (calp::workspace::validate_component),
    // so no application's bare key equals another's command key.
    expect(BUTTON_COMMAND_CONSENT_PREFIX.endsWith(":")).toBe(true);
  });
});
