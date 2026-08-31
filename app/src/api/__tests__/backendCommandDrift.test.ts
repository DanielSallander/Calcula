//! FILENAME: app/src/api/__tests__/backendCommandDrift.test.ts
// PURPOSE: Every backend command the frontend names by string must actually be
//          registered in `generate_handler!`. Nothing else checks this.
// CONTEXT: `invoke` takes a STRING, so a renamed or deleted Tauri command is
//          invisible to TypeScript, to the boundary lint, and to every unit test
//          that mocks the backend. The failure surfaces only when that exact
//          line runs — which for a rarely-taken path can be much later, in front
//          of a user.
//
//          WRITTEN AFTER SHIPPING EXACTLY THAT. On 2026-08-19 the AI-chat work
//          replaced one fixed credential slot with one per provider and renamed
//          `ai_chat_has_api_key` to `ai_provider_has_key`. `e2e/tests/ai-chat-tools.spec.ts`
//          kept calling the old name; the command no longer existed, the
//          `page.evaluate` rejected, and the whole spec failed. The unit tier
//          stayed green through a full day of work and said nothing, because
//          nothing in it can see a string.
//
//          Same shape and same reason as interpreterReachDrift.test.ts: read the
//          OTHER language's source at test time instead of trusting that two
//          lists agree. Direction is fixed — Rust REGISTERS the commands, so
//          Rust is the authority and the frontend must match it.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const REPO = path.resolve(__dirname, "../../../..");
const LIB_RS = path.join(REPO, "app/src-tauri/src/lib.rs");

/** Directories whose string-literal invokes are checked. */
const SCANNED = ["app/src", "app/extensions", "app/e2e"];

// ---------------------------------------------------------------------------
// The authority: what Rust actually registers
// ---------------------------------------------------------------------------

/**
 * Command names inside `tauri::generate_handler![ ... ]`.
 *
 * Bracket-matched rather than read to the next `]`, because the macro body
 * contains none but a naive scan would still be one edit away from stopping
 * early and passing vacuously.
 */
function registeredCommands(): Set<string> {
  const src = fs.readFileSync(LIB_RS, "utf8");
  const marker = "tauri::generate_handler![";
  const start = src.indexOf(marker);
  expect(start, "generate_handler! not found in lib.rs — update this parser").toBeGreaterThan(-1);

  let depth = 1;
  let i = start + marker.length;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]") depth--;
  }
  const body = src.slice(start + marker.length, i - 1);
  // Entries are `path::to::command_name`, comma separated, with comments.
  const names = [...body.matchAll(/(?:^|,)\s*(?:\/\/[^\n]*\n\s*)*([a-z_][a-z_0-9:]*)/gm)]
    .map((m) => m[1].split("::").pop()!)
    .filter(Boolean);
  return new Set(names);
}

// ---------------------------------------------------------------------------
// The claim: what the frontend asks for
// ---------------------------------------------------------------------------

interface Reference {
  command: string;
  file: string;
  line: number;
}

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
}

/**
 * Every `invoke("command_name")` in the scanned tree.
 *
 * Deliberately only STRING LITERALS. A dynamic name (`invoke(cmd)`) cannot be
 * checked without type flow, and guessing at one would produce false positives —
 * which in a guard like this is worse than a miss, because a guard that reds a
 * clean tree is one somebody switches off.
 */
function referencedCommands(): Reference[] {
  const files: string[] = [];
  for (const rel of SCANNED) walk(path.join(REPO, rel), files);

  const refs: Reference[] = [];
  // TWO shapes, because the app and the E2E harness call differently.
  //
  //   app:  `invoke("x")`, `invoke<T>("x")`, `.invoke("x")`, `invokeBackend("x")`
  //   e2e:  `invoke(page, "x", args)` — the harness threads the Playwright page
  //         in front, so the command is the SECOND argument.
  //
  // Matched in TWO STEPS rather than one regex, because the single-regex form
  // could not span the generics the E2E harness actually writes:
  //
  //     await invoke<{
  //       subscriptions?: Array<{ packageName: string }>;
  //     }>(page, "calp_get_subscriptions", {});
  //
  // A `<[^>()]*>` type argument cannot contain the `>` of `Array<…>` and cannot
  // cross a newline, so every call of that shape was invisible — 52 command
  // names that appear NOWHERE else in the tree, called against the REAL backend
  // in the only place that exercises them end to end, unchecked by the only
  // gate that checks `invoke` strings. TypeScript cannot help: the argument is
  // a string literal.
  //
  // Step 1 finds the call opening (lazy type argument, newlines allowed); step
  // 2 reads the first string argument, permitting one leading identifier.
  const CALL = /\binvoke(?:Backend)?\s*(?:<[\s\S]*?>\s*)?\(/g;
  const FIRST_STRING_ARG = /^\s*(?:[A-Za-z_$][\w$.]*\s*,\s*)?"([a-z_][a-z_0-9]*)"/;
  for (const file of files) {
    const rel = path.relative(REPO, file).replace(/\\/g, "/");
    // A UNIT TEST names commands that deliberately do not exist — `"x"`,
    // `"nope"`, `"my_command"` — to exercise error paths. Scanning them would
    // make the guard permanently red on fixtures, and a guard that reds a clean
    // tree is one somebody switches off.
    //
    // E2E SPECS ARE THE OPPOSITE and are scanned. They drive the REAL backend,
    // so every name in them is a real call site — exactly what this guard is
    // for. `app/e2e` was already in SCANNED, and then the filter below threw
    // away all 174 of its `.spec.ts` files: 654 literal command names,
    // including the ones in the very file this guard's header cites as its
    // reason for existing. Nothing was broken by it, but the eight commands
    // renamed in the 2026-08-31 vocabulary change would have been invisible to
    // the only gate that checks `invoke` strings — which are not typechecked.
    const isE2e = rel.startsWith("app/e2e/");
    if (!isE2e && (/\.(test|spec)\.tsx?$/.test(rel) || rel.includes("/__tests__/"))) continue;

    const src = fs.readFileSync(file, "utf8");
    // Comments are stripped FIRST: `@example invokeBackend("my_command")` in a
    // doc block is documentation, not a call site.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(Math.max(0, m.length - p1.length)));

    let m: RegExpExecArray | null;
    CALL.lastIndex = 0;
    while ((m = CALL.exec(code)) !== null) {
      const after = m.index + m[0].length;
      // 300 chars is comfortably past `page, "some_command_name",` and stops
      // the scan from wandering into an unrelated later string.
      const arg = FIRST_STRING_ARG.exec(code.slice(after, after + 300));
      if (!arg) continue;
      refs.push({
        command: arg[1],
        file: rel,
        line: code.slice(0, m.index).split("\n").length,
      });
    }
  }
  return refs;
}

const REGISTERED = registeredCommands();
const REFERENCED = referencedCommands();

/**
 * Names that are NOT `generate_handler!` commands and are legitimately invoked.
 *
 * Kept explicit and tiny. Anything added here is a claim that the name is
 * resolved somewhere other than the command registry, and it should say where.
 */
const NOT_COMMANDS = new Set<string>([
  // Tauri core built-ins reached through the same `invoke` surface.
  "plugin",
]);

describe("frontend invoke() names match the Rust command registry", () => {
  it("parses a non-trivial registry and a non-trivial set of call sites", () => {
    // Either parser returning nothing would make the diff below pass vacuously.
    expect(REGISTERED.size, "generate_handler! parsed as empty").toBeGreaterThan(500);
    expect(REFERENCED.length, "no invoke() call sites found").toBeGreaterThan(500);
  });

  it("names no command that the backend does not register", () => {
    const unknown = REFERENCED.filter(
      (r) => !REGISTERED.has(r.command) && !NOT_COMMANDS.has(r.command),
    );
    const report = unknown
      .map((r) => `  ${r.file}:${r.line} invokes "${r.command}"`)
      .join("\n");
    expect(
      unknown.map((r) => r.command),
      "These commands are invoked from the frontend but are NOT in " +
        "`generate_handler!` (app/src-tauri/src/lib.rs). `invoke` takes a string, " +
        "so nothing else can see this — the call simply rejects at run time.\n" +
        report +
        "\n\nFIX: rename the call site to the command's current name, or register " +
        "the command. Rust is the authority.",
    ).toEqual([]);
  });

  it("finds the registry entries this project actually has", () => {
    // A couple of spot checks, so a parser that silently matched garbage is
    // caught rather than merely producing an empty `unknown` list.
    expect(REGISTERED.has("get_cell")).toBe(true);
    expect(REGISTERED.has("ai_chat_run_tool")).toBe(true);
    expect(REGISTERED.has("ai_provider_has_key")).toBe(true);
    // ...and one that was deliberately REMOVED, so the parser is not just
    // returning every identifier it sees.
    expect(REGISTERED.has("ai_chat_has_api_key")).toBe(false);
  });
});
