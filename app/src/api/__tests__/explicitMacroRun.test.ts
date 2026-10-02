//! FILENAME: app/src/api/__tests__/explicitMacroRun.test.ts
// PURPOSE: The explicit-run pass (owner decision B, 2026-09-30) is what tells
//          the script host "a PERSON ran this macro". It must be impossible to
//          forge, forward or reuse -- and it must be minted only at the doors a
//          person operates.
// CONTEXT: explicitMacroRun.ts. A pass is a live object recognised by identity
//          in a private WeakMap: everything a worker realm sends is a structured
//          clone, every event detail and JSON payload is a copy, and a copy is
//          never a member. The census below is the other half: main-realm code
//          COULD mint one anywhere, so the files that DO are enumerated and a new
//          one fails here until someone decides it is a door.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  claimExplicitMacroRun,
  mintExplicitMacroRun,
  voidExplicitMacroRun,
  type ExplicitMacroRunDoor,
} from "../explicitMacroRun";

const APP_ROOT = resolve(__dirname, "..", "..", "..");

describe("a pass is single use, macro bound, and recognised only by identity", () => {
  it("mint then claim answers { door, macroId } exactly once", () => {
    const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
    expect(claimExplicitMacroRun(pass)).toEqual({ door: "macrosDialog", macroId: "macro-b" });
    // SPENT on the first claim: a crash respawn, a debug remount or a retry of a
    // refused run cannot use it again.
    expect(claimExplicitMacroRun(pass)).toBeNull();
  });

  it("a voided pass claims as nothing", () => {
    const pass = mintExplicitMacroRun("button", "macro-b");
    voidExplicitMacroRun(pass);
    expect(claimExplicitMacroRun(pass)).toBeNull();
  });

  // SABOTAGE (a): make claimExplicitMacroRun accept any object whose door and
  // macroId are strings -> all three copies below claim as a pass.
  it("a COPY is never a pass: structured clone, JSON round trip, a literal", () => {
    const pass = mintExplicitMacroRun("macrosDialog", "m");
    // What a worker's postMessage delivers.
    expect(claimExplicitMacroRun(structuredClone(pass))).toBeNull();
    // What an event detail / a Tauri payload / a log line delivers.
    expect(claimExplicitMacroRun(JSON.parse(JSON.stringify(pass)))).toBeNull();
    // What a script could simply write.
    expect(claimExplicitMacroRun({ door: "macrosDialog", macroId: "m" })).toBeNull();
    // ...and none of those spent the real one.
    expect(claimExplicitMacroRun(pass)).toEqual({ door: "macrosDialog", macroId: "m" });
  });

  it("the answer comes from the private record, not from the object handed in", () => {
    const pass = mintExplicitMacroRun("macrosDialog", "macro-real");
    // The object is frozen; a caller cannot re-point it at another macro.
    expect(Object.isFrozen(pass)).toBe(true);
    expect(() => {
      (pass as unknown as { macroId: string }).macroId = "macro-other";
    }).toThrow();
    expect(claimExplicitMacroRun(pass)?.macroId).toBe("macro-real");
  });

  it("non-objects claim and void as nothing, without throwing", () => {
    for (const value of [undefined, null, "macro-b", 42, true]) {
      expect(claimExplicitMacroRun(value)).toBeNull();
      expect(() => voidExplicitMacroRun(value)).not.toThrow();
    }
  });

  it("minting refuses a door outside the closed set, and a missing macro id", () => {
    expect(() => mintExplicitMacroRun("script" as ExplicitMacroRunDoor, "m")).toThrow(/not a door/);
    expect(() => mintExplicitMacroRun("macrosDialog", "")).toThrow(/must name the macro/);
    expect(() => mintExplicitMacroRun("macrosDialog", "   ")).toThrow(/must name the macro/);
    expect(() => mintExplicitMacroRun("button", undefined as unknown as string)).toThrow();
  });
});

// ============================================================================
// THE CENSUS: who may mint a pass, and who may claim one.
// ============================================================================

/** Strip block and line comments (a comment that QUOTES a call is not a call). */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "__tests__" || name === "__snapshots__") continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(name)) continue;
      if (/\.(test|spec)\.(ts|tsx)$/.test(name)) continue;
      out.push(full);
    }
  };
  walk(root);
  return out;
}

/** Repo-relative (to app/), forward slashes, of every production file holding `needle`. */
function filesContaining(needle: string | RegExp): string[] {
  const hits: string[] = [];
  for (const root of [join(APP_ROOT, "src"), join(APP_ROOT, "extensions")]) {
    for (const file of sourceFiles(root)) {
      const text = code(readFileSync(file, "utf8"));
      if (typeof needle === "string" ? text.includes(needle) : needle.test(text)) {
        hits.push(relative(APP_ROOT, file).split(sep).join("/"));
      }
    }
  }
  return hits.sort();
}

/**
 * Every way a file can reach the pass module WITHOUT naming the function it
 * uses: a namespace import (`import * as m` -> `m["mint" + ...]`), a star
 * re-export (`export * from` -> another module name to import it under), or a
 * dynamic `import(...)` (the namespace object again). Any of these defeats an
 * identifier census, so outside the module itself there must be none.
 */
const OPAQUE_REACH_OF_THE_PASS_MODULE =
  /import\s*\*\s*as\s+\w+\s+from\s*["'][^"']*explicitMacroRun["']|export\s*\*[^;]*from\s*["'][^"']*explicitMacroRun["']|import\s*\(\s*["'][^"']*explicitMacroRun["']\s*\)/;

/**
 * The files that mint a pass: the Macros dialog, the three pointer GESTURE
 * handlers of a button click (owner decision B; follow-ups F1 + F6) -- the
 * floating button's release (Controls/index.ts), the in-cell button's click
 * (Controls/Button/interceptors.ts) and the button cell's click
 * (CellTypes/types/button.ts) -- both of those two at the RELEASE of the press
 * they claimed (Core's press session, BUG-0258 design phase 4) -- the command
 * line's typed `run` line
 * (CommandLine/cli/appWriters.ts, follow-up F2), plus the module itself.
 */
const MINT_SITES = [
  "extensions/CellTypes/types/button.ts",
  "extensions/CommandLine/cli/appWriters.ts",
  "extensions/Controls/Button/interceptors.ts",
  "extensions/Controls/index.ts",
  "extensions/MacroRecorder/components/MacroLibraryDialog.tsx",
  "src/api/explicitMacroRun.ts",
];

describe("the census: passes are minted only at a door a person operates", () => {
  // SABOTAGE (b): add `mintExplicitMacroRun("button", resolved.id)` to
  // host.ts executeRunMacro's provider call -> a new mint site appears here.
  it("exactly these files MINT a pass", () => {
    expect(
      filesContaining("mintExplicitMacroRun("),
      "a new file mints an explicit-run pass. A pass is the claim that a PERSON started this " +
        "run; add the file here only if it is the code behind a door a person operates " +
        "(Developer > Macros > Run, a button click, a typed command line), never a path a " +
        "script can start",
    ).toEqual(MINT_SITES);
  });

  // The call-shape census above cannot see an ALIAS: `import { mintExplicitMacroRun
  // as m }` then `m(...)`, or `const f = mintExplicitMacroRun; f(...)`. So the
  // IDENTIFIER is counted wherever it appears in code at all -- an import, a
  // re-export, a reference -- and the module may not be reached opaquely.
  // SABOTAGE: add `import { mintExplicitMacroRun as grant } from "@api/explicitMacroRun";`
  // and `export const sabotage = () => grant("button", "x");` to a non-door file
  // (e.g. extensions/MacroRecorder/lib/macroLibrary.ts) -> the call-shape census
  // stays green and this goes red.
  it("exactly these files even NAME the minting function (an alias is still a mint site)", () => {
    expect(
      filesContaining(/\bmintExplicitMacroRun\b/),
      "a new file imports, re-exports or references mintExplicitMacroRun. Only the code " +
        "behind a door a person operates may hold it",
    ).toEqual(MINT_SITES);
  });

  it("no file reaches the pass module opaquely (namespace import, star re-export, dynamic import)", () => {
    expect(filesContaining(OPAQUE_REACH_OF_THE_PASS_MODULE)).toEqual([]);
    // Positive controls: the pattern sees each opaque form.
    for (const sample of [
      'import * as passes from "@api/explicitMacroRun";',
      "export * from './explicitMacroRun';",
      'const m = await import("../explicitMacroRun");',
    ]) {
      expect(OPAQUE_REACH_OF_THE_PASS_MODULE.test(sample), sample).toBe(true);
    }
    // ...and not the named imports every legitimate holder uses.
    expect(
      OPAQUE_REACH_OF_THE_PASS_MODULE.test('import { voidExplicitMacroRun, type ExplicitMacroRun } from "./explicitMacroRun";'),
    ).toBe(false);
  });

  // The two places a RUN is admitted: a worker realm (host.ts `admitMount`) and
  // the module runtime (workbookScripts.ts `runWorkbookScript`, which tells Rust
  // who started the run -- follow-up F10). Nothing else spends a pass for a door.
  // SABOTAGE: claim the pass in macroLibrary.ts runMacroModule instead of
  // forwarding it -> a third claim site appears here.
  it("exactly these files CLAIM a pass: the two places a run is admitted", () => {
    expect(filesContaining("claimExplicitMacroRun(")).toEqual([
      "src/api/explicitMacroRun.ts",
      "src/api/scriptHost/host.ts",
      "src/api/workbookScripts.ts",
    ]);
    // ...and the identifier, so an aliased claim is seen too.
    expect(filesContaining(/\bclaimExplicitMacroRun\b/)).toEqual([
      "src/api/explicitMacroRun.ts",
      "src/api/scriptHost/host.ts",
      "src/api/workbookScripts.ts",
    ]);
  });

  it("the script-facing paths never mint one", () => {
    for (const rel of [
      "src/api/scriptHost/host.ts",
      "src/api/macroRunService.ts",
      "src/api/objectScriptRunner.ts",
      "src/api/workbookScripts.ts",
      "extensions/CommandLine/cli/appGateway.ts",
      "extensions/MacroRecorder/lib/macroLibrary.ts",
      "src/api/scriptHost/validators.ts",
      "src/api/scriptHost/allowlist.ts",
      "src/api/scriptHost/worker/contextShims.ts",
      "src/api/scriptHost/worker/bootstrap.ts",
    ]) {
      const src = code(readFileSync(join(APP_ROOT, rel), "utf8"));
      expect(src, `${rel} mints an explicit-run pass`).not.toContain("mintExplicitMacroRun(");
    }
  });

  it("positive control: the scanner sees the doors that mint today", () => {
    const dialog = code(
      readFileSync(join(APP_ROOT, "extensions/MacroRecorder/components/MacroLibraryDialog.tsx"), "utf8"),
    );
    expect(dialog).toContain('mintExplicitMacroRun("macrosDialog", loaded.id)');
    for (const rel of BUTTON_GESTURES.map((g) => g.file)) {
      expect(source(rel), rel).toContain('mintExplicitMacroRun("button", macroId)');
    }
    expect(source("extensions/CommandLine/cli/appWriters.ts")).toContain(
      'mintExplicitMacroRun("commandLine", match.id)',
    );
  });
});

// ============================================================================
// THE COMMAND-LINE DOOR: the typed `run` line, and only it (follow-up F2)
// ============================================================================
//
// A pass on the command line proves a person typed `run <macro>` and ran it
// now. So the mint sits in the `run` verb's writer, after the macro was
// resolved and its provenance announced, and the chain from the panel to it is
// pinned: the gateway (a seam other callers can reach) only FORWARDS, and the
// only engine that hosts the app domain is the panel's.

describe("the command-line door: the mint sits in the typed `run` line", () => {
  // SABOTAGE: mint in appGateway.ts instead
  // (`runMacroByRef: (macroId) => requireMacroRunProvider().runMacroByRef(macroId,
  // { explicitRun: mintExplicitMacroRun("commandLine", macroId) })`) -> a new
  // mint site, and the gateway no longer forwards: red here and above.
  it("runMacro mints exactly once, after resolution and the notice, right before the run", () => {
    const writers = source("extensions/CommandLine/cli/appWriters.ts");
    expect(count(writers, "mintExplicitMacroRun(")).toBe(1);
    const body = blockAt(writers, "async function runMacro(cmd: GenericCommand, s: AppCliSession, io: CliIo): Promise<void> {");
    const mint = body.indexOf('const explicitRun = mintExplicitMacroRun("commandLine", match.id);');
    expect(mint, "the mint left the `run` writer").toBeGreaterThan(-1);
    // After every refusal of the line and the provenance notice...
    for (const before of ["if (!match) {", "if (!s.gateway.hasMacroRunProvider()) {", "macroProvenanceNotice(match)"]) {
      const at = body.indexOf(before);
      expect(at, `\`${before}\` moved`).toBeGreaterThan(-1);
      expect(at, `the pass is minted before \`${before}\``).toBeLessThan(mint);
    }
    // ...and handed straight to the run.
    expect(body.slice(mint)).toMatch(/^const explicitRun = mintExplicitMacroRun\("commandLine", match\.id\);\s*const outcome = await s\.gateway\.runMacroByRef\(match\.id, explicitRun\);/);
  });

  it("the gateway forwards the pass it is handed and makes none", () => {
    const gateway = source("extensions/CommandLine/cli/appGateway.ts");
    expect(gateway.replace(/\s+/g, " ")).toContain(
      "runMacroByRef: (macroId: string, explicitRun?: ExplicitMacroRun) => requireMacroRunProvider().runMacroByRef(macroId, { explicitRun }),",
    );
  });

  // SABOTAGE: add a second caller of runMacro (an exported `runMacroNamed` that
  // a replay or a tool could call) -> red.
  it("only a line the panel's engine runs reaches it", () => {
    const writers = source("extensions/CommandLine/cli/appWriters.ts");
    // `runMacro` is the `run` verb's case, and nothing else calls it.
    expect(count(writers, "runMacro(")).toBe(2);
    expect(blockAt(writers, "async function runMisc(cmd: GenericCommand, s: AppCliSession, io: CliIo): Promise<void> {")).toContain(
      'case "run":\n      await runMacro(cmd, s, io);',
    );
    // The writers are run by the app domain alone, and the app domain is
    // hosted only by the panel (a person's Enter, Ctrl+Enter, Run or Confirm).
    expect(filesContaining(/\brunAppWrite\b/)).toEqual([
      "extensions/CommandLine/cli/appDomain.ts",
      "extensions/CommandLine/cli/appWriters.ts",
    ]);
    expect(filesContaining("createAppDomain(")).toEqual([
      "extensions/CommandLine/cli/appDomain.ts",
      "extensions/CommandLine/components/AppCliPanel.tsx",
    ]);
  });
});

// ============================================================================
// THE BUTTON DOOR: who can REACH the mint (owner decision B, F1 + F6)
// ============================================================================
//
// For a button, Rust `verify_trigger` proves only that a button running that
// macro sits at that cell -- NOT that anyone clicked it. So WHERE the pass is
// minted is the whole proof that a person did: the mint sits in the pointer
// gesture handler itself, and the chain from Core's pointer handler to it is
// pinned link by link. A new caller anywhere along it -- a keyboard shortcut, a
// command, a "press this button" seam, a macro replay, an AI tool -- fails here
// until someone decides it is a person's door. Everything below the handler
// receives the mint as a `ButtonGesturePass` and never makes one (the identifier
// census above: no other file even names the function).

/** Comment-stripped production source of an app-relative file. */
function source(rel: string): string {
  return code(readFileSync(join(APP_ROOT, rel), "utf8"));
}

/**
 * The brace-matched block that opens at the first `opener` (which ends in `{`)
 * at or after `anchor`, in comment-stripped source.
 */
function blockAt(src: string, anchor: string, opener: string = anchor): string {
  const at = src.indexOf(anchor);
  expect(at, `\`${anchor}\` moved`).toBeGreaterThanOrEqual(0);
  const from = src.indexOf(opener, at);
  expect(from, `\`${opener}\` is not after \`${anchor}\``).toBeGreaterThanOrEqual(0);
  const open = from + opener.length - 1;
  expect(src[open], `\`${opener}\` does not end in "{"`).toBe("{");
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`\`${anchor}\` never closes`);
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;

/** The three gesture handlers that mint for a button click: where each starts, and its body's `{`. */
const BUTTON_GESTURES = [
  {
    file: "extensions/Controls/index.ts",
    anchor: "const handleButtonPress = (e: Event) => {",
    opener: "const handleButtonPress = (e: Event) => {",
  },
  {
    file: "extensions/Controls/Button/interceptors.ts",
    anchor: "export async function buttonClickInterceptor(",
    opener: "): Promise<CellClickAnswer> {",
  },
  {
    file: "extensions/CellTypes/types/button.ts",
    anchor: "onClick: async ({ row, col }) => {",
    opener: "onClick: async ({ row, col }) => {",
  },
];

describe("the button door: the mint sits in the pointer gesture, and only Core's pointer reaches it", () => {
  // SABOTAGE: move the mint from the gesture into runButtonMacroLink
  // (`const explicitRun = mintExplicitMacroRun("button", link.macroId);`,
  // Controls/lib/applicationMacroLink.ts) -> a new mint site, and the in-cell
  // handler's body no longer mints: red here and in the census above.
  it("each gesture file mints exactly once, a BUTTON pass, inside its gesture handler", () => {
    for (const g of BUTTON_GESTURES) {
      const src = source(g.file);
      expect(count(src, "mintExplicitMacroRun("), `${g.file}: mints more than once, or not at all`).toBe(1);
      expect(src, g.file).toContain('(macroId) => mintExplicitMacroRun("button", macroId)');
      expect(blockAt(src, g.anchor, g.opener), `${g.file}: the mint is not inside the gesture handler`).toContain(
        'mintExplicitMacroRun("button", macroId)',
      );
    }
  });

  it("the floating button: the release a press armed, from Core's content press only", () => {
    const index = source("extensions/Controls/index.ts");
    // The handler is a listener of Core's content press, and nothing else.
    expect(count(index, "handleButtonPress")).toBe(3);
    expect(index).toContain('window.addEventListener("floatingObject:bodyDragStart", handleButtonPress);');
    expect(index).toContain('window.removeEventListener("floatingObject:bodyDragStart", handleButtonPress)');
    // It runs the click at the RELEASE inside the button (lib/buttonPress.ts).
    const handler = blockAt(index, "const handleButtonPress = (e: Event) => {");
    expect(handler).toContain("beginFloatingButtonPress({");
    // The click path has exactly one caller: that handler.
    expect(count(index, "runFloatingButtonClick(")).toBe(2);
    expect(handler).toContain("runFloatingButtonClick(");
    // Core's pointer handler is the only production code that raises the press.
    expect(filesContaining('CustomEvent("floatingObject:bodyDragStart"')).toEqual([
      "src/core/hooks/useMouseSelection/layout/overlayMoveHandlers.ts",
    ]);
  });

  // SABOTAGE: add a second caller of executeButtonAction (say, an exported
  // `pressButtonAt(row, col)` passing its own mint) -> red.
  it("the in-cell button: the cell click interceptor, which only Core's mouse-down asks", () => {
    const interceptors = source("extensions/Controls/Button/interceptors.ts");
    const handler = blockAt(interceptors, "export async function buttonClickInterceptor(", "): Promise<CellClickAnswer> {");
    expect(count(interceptors, "executeButtonAction(")).toBe(2);
    expect(handler).toContain("executeButtonAction(row, col,");
    // It runs at the RELEASE of the press it claims (BUG-0258 design phase 4):
    // the handler answers with a release claim for its own cell, and the action
    // is that claim's.
    expect(handler).toContain("return actOnCellRelease(");
    // Registered as a click interceptor, and referenced nowhere else.
    expect(filesContaining(/\bbuttonClickInterceptor\b/)).toEqual([
      "extensions/Controls/Button/interceptors.ts",
      "extensions/Controls/index.ts",
    ]);
    const index = source("extensions/Controls/index.ts");
    expect(count(index, "buttonClickInterceptor")).toBe(2);
    expect(index).toContain("registerClickInterceptor(buttonClickInterceptor)");
    // The interceptors are asked only by Core's mouse-down handler.
    expect(filesContaining("checkCellClickInterceptors(")).toEqual([
      "src/core/components/Spreadsheet/useSpreadsheetSelection.ts",
      "src/core/lib/cellClickInterceptors.ts",
    ]);
    expect(source("src/core/lib/cellClickInterceptors.ts")).toContain(
      "export async function checkCellClickInterceptors(",
    );
  });

  it("the button cell: its type's onClick, which only the cell click interceptor calls", () => {
    const button = source("extensions/CellTypes/types/button.ts");
    const handler = blockAt(button, "onClick: async ({ row, col }) => {");
    expect(count(button, "runButtonCell(")).toBe(2);
    expect(handler).toContain("runButtonCell(");
    // ...at the RELEASE of the press it claims (a release claim for its cell).
    expect(handler).toContain("return actOnCellRelease(");
    expect(count(button, "runCellMacro(")).toBe(2);
    expect(blockAt(button, "async function runButtonCell(at: ClickedButtonCell, gesture: ButtonGesturePass): Promise<void> {")).toContain(
      "macro: (macroId, application) => runCellMacro(at, macroId, application, gesture),",
    );
    // The type is registered once, and its onClick is called only from the
    // cell click interceptor the registry installs.
    expect(filesContaining(/\bbuttonCellType\b/)).toEqual([
      "extensions/CellTypes/index.ts",
      "extensions/CellTypes/types/button.ts",
    ]);
    expect(filesContaining("def.onClick(")).toEqual(["src/api/cellTypes.ts"]);
    const cellTypes = source("src/api/cellTypes.ts");
    expect(blockAt(cellTypes, "registerCellClickInterceptor(async (row, col, event) => {")).toContain(
      "a.def.onClick(",
    );
  });

  // A RELEASE CLAIM is the gesture's action, deferred to the press's release
  // (BUG-0258 design phase 4). Only Core's press session runs one -- the
  // session opened by Core's mouse-down for the press the claim answered, and
  // it is not on @api: an extension answers a press, it never releases one.
  // (cellClickInterceptors.ts is the claim's own constructor, forwarding the
  // spec's function.)
  //
  // SABOTAGE: add a `releaseNow(claim)` to src/api/cellClickInterceptors.ts
  // that calls `claim.runAtRelease(...)` -> a third file, red.
  it("a release claim runs only from Core's press session, opened only by Core's mouse-down", () => {
    expect(filesContaining(".runAtRelease(")).toEqual([
      "src/core/lib/cellClickInterceptors.ts",
      "src/core/lib/cellPressRelease.ts",
    ]);
    expect(filesContaining("openCellPress(")).toEqual([
      "src/core/components/Spreadsheet/useSpreadsheetSelection.ts",
      "src/core/lib/cellPressRelease.ts",
    ]);
    // The session is Core's: the facade re-exports the claim's builders, never the session.
    const facade = source("src/api/cellClickInterceptors.ts");
    expect(facade).not.toMatch(/openCellPress|cellPressRelease/);
  });

  // The routes below the gestures take the mint as a parameter, and only from
  // the gestures: a new caller is a new way to reach a person's pass.
  it("below the gestures, each route has exactly the callers the gestures give it", () => {
    expect(filesContaining("clickButtonControl(")).toEqual([
      "extensions/Controls/Button/interceptors.ts",
      "extensions/Controls/index.ts",
      "extensions/Controls/lib/controlClick.ts",
    ]);
    expect(filesContaining("runButtonMacroLink(")).toEqual([
      "extensions/Controls/lib/applicationMacroLink.ts",
      "extensions/Controls/lib/controlClick.ts",
    ]);
    const click = source("extensions/Controls/lib/controlClick.ts");
    expect(click).toContain("link: () => followMacroLink(sheetIndex, row, col, gesture),");
    expect(click).toContain("runButtonMacroLink(sheetIndex, row, col, metadata?.properties, gesture)");
    // The pass is made at the run, for the macro the link names -- once.
    const link = source("extensions/Controls/lib/applicationMacroLink.ts");
    expect(count(link, "gesture?.(")).toBe(1);
    expect(link).toContain("const explicitRun = gesture?.(link.macroId);");
    const button = source("extensions/CellTypes/types/button.ts");
    expect(count(button, "gesture(")).toBe(1);
    expect(button).toContain("const explicitRun = gesture(macroId);");
    // The button cell's click route lives in its type file and nowhere else.
    expect(filesContaining("runButtonCell(")).toEqual(["extensions/CellTypes/types/button.ts"]);
  });

  // THE BUTTON DOOR ITSELF (review of M6b). Since phase 4 the Rust door
  // (`run_control_action`) RUNS an application's approved held inline code,
  // and a button cell's module-runtime macro, with the module runtime's full
  // `Calcula.*` reach -- more than cell access -- and Rust cannot ask who
  // clicked: `run_control_action_core` reads the button from its own store, and
  // nothing on that path says a person pressed it (contrast `run_script`, whose
  // gate refuses an application's macro no person started, F10). So the only
  // proof of a person is WHO REACHES THE DOOR: the three gestures above, through
  // the shared click (`clickButtonThroughDoor`) and the one wire call
  // (`runControlAction`). A "press this button" seam, a scriptSafe command, a
  // VBA-style `.Click`, a macro replay or an AI tool that calls either function
  // -- or invokes the command by name -- fails here until someone decides it is
  // a person's door.
  // SABOTAGE: add `export const press = (r: number, c: number) =>
  // runControlAction({ kind: "cell", sheetIndex: 0, row: r, col: c });` to any
  // non-door file -> red.
  it("only the three button gestures reach the button door (the shared click, the wire call, the command)", () => {
    const shared = "extensions/_shared/lib/buttonClickDoor.ts";
    const clickers = ["extensions/CellTypes/types/button.ts", "extensions/Controls/lib/controlClick.ts", shared];
    expect(
      filesContaining("clickButtonThroughDoor("),
      "a new file clicks a button through the door. Only the routes below a person's gesture may",
    ).toEqual(clickers);
    // The identifier too: an alias (`import { clickButtonThroughDoor as press }`) is still a caller.
    expect(filesContaining(/\bclickButtonThroughDoor\b/)).toEqual(clickers);
    const wire = [shared, "src/api/workbookScripts.ts"];
    expect(
      filesContaining("runControlAction("),
      "a new file asks the button door directly. Only the shared click may",
    ).toEqual(wire);
    expect(filesContaining(/\brunControlAction\b/)).toEqual(wire);
    // ...and nobody invokes the command by its name but the wire call (and the
    // facade's denylist, which names it to keep third parties out).
    expect(filesContaining('"run_control_action"')).toEqual(["src/api/backendCommands.ts", "src/api/workbookScripts.ts"]);

    // Each caller calls ONCE, from inside the route the gesture census pins.
    const door = source(shared);
    expect(count(door, "runControlAction(")).toBe(1);
    expect(blockAt(door, "export async function clickButtonThroughDoor(", "): Promise<void> {")).toContain(
      "await runControlAction(button)",
    );
    const click = source("extensions/Controls/lib/controlClick.ts");
    expect(count(click, "clickButtonThroughDoor(")).toBe(1);
    expect(blockAt(click, "export async function clickButtonControl(", "): Promise<void> {")).toContain(
      "await clickButtonThroughDoor(",
    );
    const cell = source("extensions/CellTypes/types/button.ts");
    expect(count(cell, "clickButtonThroughDoor(")).toBe(1);
    expect(
      blockAt(cell, "async function runButtonCell(at: ClickedButtonCell, gesture: ButtonGesturePass): Promise<void> {"),
    ).toContain("await clickButtonThroughDoor(");
    const workbookScripts = source("src/api/workbookScripts.ts");
    expect(count(workbookScripts, "runControlAction(")).toBe(1);
    expect(count(workbookScripts, '"run_control_action"')).toBe(1);
  });

  it("the script-facing modules never import a gesture route", () => {
    for (const rel of [
      "src/api/scriptHost/host.ts",
      "src/api/macroRunService.ts",
      "src/api/objectScriptRunner.ts",
      "extensions/MacroRecorder/lib/macroLibrary.ts",
      "src/api/scriptHost/worker/contextShims.ts",
      "src/api/scriptHost/worker/bootstrap.ts",
    ]) {
      expect(source(rel), rel).not.toMatch(/Controls\/|CellTypes\/|buttonClickDoor/);
    }
  });
});
