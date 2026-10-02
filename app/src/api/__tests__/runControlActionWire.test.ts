//! FILENAME: app/src/api/__tests__/runControlActionWire.test.ts
// PURPOSE: `runControlAction` is the ONE page wrapper of the Rust button door
//          `run_control_action` (phase 4 of BUG-0257). Its wire is Rust's:
//            * the request names the BUTTON -- kind, sheet, cell, view state --
//              and nothing else, spelled as `RunControlActionRequest`
//              deserializes it (app/src-tauri/src/scripting/types.rs, read at
//              test time), which REFUSES an unknown field;
//            * the answer is `ControlActionOutcome`, variant for variant and
//              field for field;
//            * Script Security's prompt sentinel asks once, AWAITED and failing
//              closed (the Tauri-shaped double: a Promise, never a boolean),
//              and retries the whole door exactly once after a yes.
// CONTEXT: The real @api wrapper, with only the backend door, the dialog and
//          the grid snapshot doubled.

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const h = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: unknown }[],
  /** Answers for run_control_action, in order; an Error is thrown. */
  answers: [] as unknown[],
  confirm: vi.fn(),
}));

vi.mock("../backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backend")>()),
  invokeBackend: async (cmd: string, args?: unknown) => {
    h.calls.push({ cmd, args });
    if (cmd !== "run_control_action") return undefined;
    const next = h.answers.shift();
    if (next instanceof Error) throw next;
    return next;
  },
}));
vi.mock("../dialogs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dialogs")>()),
  confirmAsync: (...a: unknown[]) => h.confirm(...a),
}));
vi.mock("../../core/state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/state/GridContext")>()),
  getGridStateSnapshot: () => ({
    displayZeros: true,
    viewMode: "normal",
    zoom: 1.5,
    displayHeadings: true,
    showFormulas: false,
  }),
}));

import {
  CONTROL_ACTION_OUTCOME_KINDS,
  SCRIPT_DEFERRED_ACTIONS_EVENT,
  runControlAction,
  type ControlActionButton,
  type ControlActionOutcome,
  type RunControlActionRequest,
  type UnavailableButtonModule,
} from "../workbookScripts";

const SRC_TAURI = path.resolve(__dirname, "../../../src-tauri/src");
const TYPES_RS = fs.readFileSync(path.join(SRC_TAURI, "scripting/types.rs"), "utf8");
const DOOR_RS = fs.readFileSync(path.join(SRC_TAURI, "scripting/control_action.rs"), "utf8");

const camel = (snake: string) => snake.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());

/** The text of `<head> { ... }` up to the closing brace at column 0. */
function bodyOf(src: string, head: string): string {
  const start = src.indexOf(head);
  expect(start, `\`${head}\` is gone from the Rust source`).toBeGreaterThanOrEqual(0);
  return src.slice(start, src.indexOf("\n}\n", start));
}

/** The lines Rust serializes: comments and attributes stripped. */
function code(body: string): string {
  return body
    .split("\n")
    .filter((l) => !/^\s*(\/\/|#\[)/.test(l))
    .join("\n");
}

/** `pub field:` names of a struct body, camelCased. */
function structFields(body: string): string[] {
  return [...code(body).matchAll(/^\s*pub (\w+):/gm)].map((m) => camel(m[1])).sort();
}

const BUTTON: ControlActionButton = { kind: "cell", sheetIndex: 3, row: 4, col: 1 };
const RAN_OK = {
  kind: "ran",
  result: { type: "success", output: [], cellsModified: 1, durationMs: 1, screenUpdating: true },
  unavailable: [],
};

beforeEach(() => {
  h.calls.length = 0;
  h.answers.length = 0;
  h.confirm.mockReset();
});

const doorCalls = () => h.calls.filter((c) => c.cmd === "run_control_action");
const request = (i = 0) => (doorCalls()[i].args as { request: Record<string, unknown> }).request;

describe("the request names the button and nothing else", () => {
  // SABOTAGE: build the request by spreading the caller's object
  // (`{ ...button, viewState }`) in runControlAction -> the smuggled source
  // rides along, red.
  it("sends exactly Rust's RunControlActionRequest fields, never code", async () => {
    h.answers.push(RAN_OK);
    const smuggled = { ...BUTTON, source: "Exfiltrate();", functionName: "X", trigger: {} };
    await runControlAction(smuggled as unknown as ControlActionButton);
    const rust = bodyOf(TYPES_RS, "pub struct RunControlActionRequest {");
    expect(Object.keys(request()).sort()).toEqual(structFields(rust));
    expect(request()).toEqual({
      kind: "cell",
      sheetIndex: 3,
      row: 4,
      col: 1,
      viewState: { displayZeros: true, viewMode: "normal", zoom: 150, displayHeadings: true, displayFormulas: false },
    });
    expect(JSON.stringify(request()), "code reached the door's request").not.toContain("Exfiltrate");
    expect(h.calls.map((c) => c.cmd), "the click went around the door").not.toContain("run_script");
  });

  it("Rust refuses an unknown field rather than ignoring it, and spells the kinds as TypeScript does", () => {
    const head = TYPES_RS.slice(0, TYPES_RS.indexOf("pub struct RunControlActionRequest {"));
    expect(head.slice(head.lastIndexOf("#[derive")), "deny_unknown_fields is gone").toContain(
      '#[serde(rename_all = "camelCase", deny_unknown_fields)]',
    );
    const kinds = bodyOf(TYPES_RS, "pub enum ControlActionKind {");
    const variants = [...code(kinds).matchAll(/^\s*(\w+),/gm)].map((m) => camel(m[1].charAt(0).toLowerCase() + m[1].slice(1)));
    const ts: ControlActionButton["kind"][] = ["control", "cell"];
    expect(variants.sort()).toEqual([...ts].sort());
  });
});

describe("the answer is Rust's ControlActionOutcome", () => {
  // A literal of every TS variant: a field the TS type lacks is a compile
  // error in the checked tree; one Rust adds or renames fails the comparison.
  const samples: { [K in ControlActionOutcome["kind"]]: Extract<ControlActionOutcome, { kind: K }> } = {
    ran: { kind: "ran", result: { type: "error", message: "m", output: [] }, unavailable: [] },
    link: { kind: "link" },
    macro: { kind: "macro", macroId: "macro-report", application: null },
    command: { kind: "command", commandId: "format.bold", application: null },
    refused: { kind: "refused", reason: "notConsented", message: "m" },
    nothing: { kind: "nothing", message: null },
  };

  it("tags on `kind`, camelCased", () => {
    const head = TYPES_RS.slice(0, TYPES_RS.indexOf("pub enum ControlActionOutcome {"));
    expect(head.slice(head.lastIndexOf("#[derive"))).toContain('#[serde(tag = "kind", rename_all = "camelCase")]');
  });

  it("every variant and every field, both directions", () => {
    const body = code(bodyOf(TYPES_RS, "pub enum ControlActionOutcome {"));
    const rust = new Map<string, string[]>();
    for (const m of body.matchAll(/^ {4}(\w+)\s*(?:\{([^}]*)\})?\s*,/gm)) {
      const variant = m[1].charAt(0).toLowerCase() + m[1].slice(1);
      const fields = [...(m[2] ?? "").matchAll(/(\w+)\s*:(?!:)/g)].map((f) => camel(f[1])).sort();
      rust.set(variant, fields);
    }
    expect([...rust.keys()], "the Rust variants are not the TypeScript kinds").toEqual([
      ...CONTROL_ACTION_OUTCOME_KINDS,
    ]);
    for (const kind of CONTROL_ACTION_OUTCOME_KINDS) {
      const ts = Object.keys(samples[kind]).filter((k) => k !== "kind").sort();
      expect(ts, `the fields of "${kind}"`).toEqual(rust.get(kind));
    }
  });

  it("every struct variant renames its fields to camelCase (command_id -> commandId)", () => {
    const body = bodyOf(TYPES_RS, "pub enum ControlActionOutcome {");
    for (const variant of ["Ran {", "Macro {", "Command {", "Refused {", "Nothing {"]) {
      const at = body.indexOf(`    ${variant}`);
      expect(at, variant).toBeGreaterThan(0);
      const before = body.slice(0, at).trimEnd().split("\n").pop() ?? "";
      expect(before, `${variant} has no rename_all`).toContain('#[serde(rename_all = "camelCase")]');
    }
  });

  it("an unavailable module is Rust's UnavailableModule", () => {
    const rust = bodyOf(DOOR_RS, "pub struct UnavailableModule {");
    const sample: UnavailableButtonModule = { id: "m", name: "M", reason: "distributed", message: "m" };
    expect(Object.keys(sample).sort()).toEqual(structFields(rust));
    const head = DOOR_RS.slice(0, DOOR_RS.indexOf("pub struct UnavailableModule {"));
    expect(head.slice(head.lastIndexOf("#[derive"))).toContain('#[serde(rename_all = "camelCase")]');
    // The two reasons the door writes.
    expect(DOOR_RS).toContain('reason: "distributed".to_string(),');
    expect(DOOR_RS).toContain('reason: "objectScript".to_string(),');
  });
});

describe("what the wrapper does with the answer", () => {
  it("hands every outcome back as it came", async () => {
    for (const outcome of [
      { kind: "link" },
      { kind: "macro", macroId: "macro-report", application: "Sales" },
      { kind: "command", commandId: "format.bold", application: null },
      { kind: "command", commandId: "test.reader.refresh", application: "Sales" },
      { kind: "refused", reason: "notConsented", message: "m" },
      { kind: "nothing", message: null },
    ]) {
      h.answers.push(outcome);
      await expect(runControlAction(BUTTON)).resolves.toEqual(outcome);
    }
  });

  it("dispatches a successful run's deferred actions, as runWorkbookScript does", async () => {
    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(SCRIPT_DEFERRED_ACTIONS_EVENT, listener);
    try {
      h.answers.push({ ...RAN_OK, result: { ...RAN_OK.result, deferredActions: [{ action: "calculate" }] } });
      await runControlAction(BUTTON);
    } finally {
      window.removeEventListener(SCRIPT_DEFERRED_ACTIONS_EVENT, listener);
    }
    expect(seen).toEqual([[{ action: "calculate" }]]);
  });

  it("an answer that is no outcome is a failure, never a silent success", async () => {
    h.answers.push(null);
    await expect(runControlAction(BUTTON)).rejects.toThrow(/no answer Calcula understands/);
    h.answers.push({ kind: "exploded" });
    await expect(runControlAction(BUTTON)).rejects.toThrow(/no answer Calcula understands/);
  });
});

describe("Script Security's prompt: asked once, awaited, failing closed", () => {
  const PROMPT = new Error("SCRIPT_PROMPT_REQUIRED: Script Security is set to prompt.");

  it("a yes grants the session approval and retries the whole door exactly once", async () => {
    h.confirm.mockReturnValue(Promise.resolve(true));
    h.answers.push(PROMPT, RAN_OK);
    await expect(runControlAction(BUTTON)).resolves.toEqual(RAN_OK);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.calls.map((c) => c.cmd)).toEqual(["run_control_action", "grant_script_session_approval", "run_control_action"]);
    expect(request(1), "the retry asks about the same button").toEqual(request(0));
  });

  // SABOTAGE: drop the `await` on confirmAsync in withScriptSecurityPrompt
  // (src/api/workbookScripts.ts) -> a pending Promise reads as yes, and this
  // retries.
  it("a no (the Tauri shape: a Promise of false) grants nothing and retries nothing", async () => {
    h.confirm.mockReturnValue(Promise.resolve(false));
    h.answers.push(PROMPT, RAN_OK);
    await expect(runControlAction(BUTTON)).rejects.toThrow(/SCRIPT_PROMPT_REQUIRED/);
    expect(h.calls.map((c) => c.cmd)).toEqual(["run_control_action"]);
  });

  it("any other refusal is not a prompt: no dialog, no retry", async () => {
    h.answers.push(new Error("SCRIPTS_DISABLED: scripts are disabled."));
    await expect(runControlAction(BUTTON)).rejects.toThrow(/SCRIPTS_DISABLED/);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(doorCalls()).toHaveLength(1);
  });
});

describe("the request type itself", () => {
  it("is the button plus the view state (a compile-time mirror)", () => {
    const r: Required<RunControlActionRequest> = {
      ...BUTTON,
      viewState: { displayZeros: true, viewMode: "normal", zoom: 100, displayHeadings: true, displayFormulas: false },
    };
    expect(Object.keys(r).sort()).toEqual(structFields(bodyOf(TYPES_RS, "pub struct RunControlActionRequest {")));
  });
});
