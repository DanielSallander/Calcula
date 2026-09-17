//! FILENAME: app/extensions/AIChat/__tests__/chatToolSurface.test.ts
// PURPOSE: The in-app chat's declared tool surface and the Rust dispatcher that
//          serves it must agree, in BOTH directions. A tool declared in
//          lib/chatTools.ts with no arm in ai_chat_run_tool is a promise the
//          model will try to call and always fail; an arm with no declaration is
//          dead code the model can never reach.
// CONTEXT: This guard exists because the second failure mode SHIPPED and stayed
//          invisible. `draft_object_script`, `list_script_drafts` and
//          `get_script_draft` were registered on the MCP server (37 tools) and
//          absent from the in-app chat (21 tools, 21 matching arms — a perfectly
//          consistent surface that was simply missing a feature). So an external
//          MCP client could hand the user a script to review while the built-in
//          chat's only route to a script was `run_script`, which executes
//          immediately. Nothing failed; the capability just did not exist.
//
//          Same shape and same reason as
//          app/src/api/__tests__/interpreterReachDrift.test.ts: read the OTHER
//          language's source at test time instead of re-typing what it says.
//          Direction of truth here is RUST -> TypeScript for the object-type
//          vocabulary (drafts.rs is the validator that actually refuses), and
//          MUTUAL for the tool names, because neither side can serve a request
//          the other has not heard of.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  TOOLS, DRAFT_OBJECT_TYPES, TOOL_NAMES, AUTORUN_TOOLS, SYSTEM_PROMPT,
  CORE_TOOLS, CORE_TOOL_NAMES, buildSystemPrompt,
} from "../lib/chatTools";
import { CLIENT_TOOL_NAMES, runClientTool } from "../lib/clientTools";

const REPO = path.resolve(__dirname, "../../../..");
const AI_CHAT_RS = path.join(REPO, "app/src-tauri/src/ai/tools.rs");
const DRAFTS_RS = path.join(REPO, "app/src-tauri/src/mcp/drafts.rs");

const aiChatSrc = fs.readFileSync(AI_CHAT_RS, "utf8");
const draftsSrc = fs.readFileSync(DRAFTS_RS, "utf8");

const FIX =
  "FIX: add the tool to BOTH sides — a `name` entry in " +
  "app/extensions/AIChat/lib/chatTools.ts (TOOLS) and a matching match arm in " +
  "`ai_chat_run_tool` (app/src-tauri/src/ai/tools.rs). Neither side can serve a " +
  "tool the other has never heard of.";

// ---------------------------------------------------------------------------
// Parse the Rust dispatcher
// ---------------------------------------------------------------------------

/**
 * The tool names `ai_chat_run_tool` dispatches on.
 *
 * Bounded to the `match name.as_str()` block and stopped at the `other =>`
 * catch-all, rather than grepping the whole file for quoted strings: the file
 * also contains error-message literals, and
 * a looser parse would silently admit them as "tools".
 */
function dispatcherArms(): string[] {
  const marker = "match name.as_str() {";
  const start = aiChatSrc.indexOf(marker);
  expect(start, `\`${marker}\` not found in ai/tools.rs — the dispatcher was restructured; update this parser`).toBeGreaterThan(-1);

  const rest = aiChatSrc.slice(start + marker.length);
  const endIdx = rest.indexOf("other =>");
  expect(endIdx, "the dispatcher's `other =>` catch-all is gone — update this parser").toBeGreaterThan(-1);

  const body = rest.slice(0, endIdx);
  return [...body.matchAll(/^\s*"([a-z0-9_]+)"\s*=>/gm)].map((m) => m[1]);
}

/** `VALID_OBJECT_TYPES` from drafts.rs — the authoritative draft-target list. */
function rustObjectTypes(): string[] {
  const marker = "const VALID_OBJECT_TYPES: &[&str] = &[";
  const start = draftsSrc.indexOf(marker);
  expect(start, "VALID_OBJECT_TYPES not found in mcp/drafts.rs").toBeGreaterThan(-1);
  const body = draftsSrc.slice(start + marker.length);
  const end = body.indexOf("];");
  expect(end, "VALID_OBJECT_TYPES has no closing `];`").toBeGreaterThan(-1);
  return [...body.slice(0, end).matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);
}

const ARMS = dispatcherArms();
const DECLARED = TOOLS.map((t) => t.name);
/** Tools served in the webview instead of by a Rust arm (`lib/clientTools.ts`). */
const CLIENT = [...CLIENT_TOOL_NAMES];

// ---------------------------------------------------------------------------

describe("in-app chat tool surface", () => {
  it("parses a non-trivial dispatcher (the parser itself must not silently return nothing)", () => {
    // A parser that matched nothing would make every diff below pass vacuously.
    expect(ARMS.length).toBeGreaterThan(20);
    expect(DECLARED.length).toBeGreaterThan(20);
  });

  it("declares no tool that neither the Rust dispatcher nor a client handler can serve", () => {
    const orphans = DECLARED.filter((n) => !ARMS.includes(n) && !CLIENT.includes(n));
    expect(orphans, `Declared to the model but unreachable: ${orphans.join(", ")}. ${FIX}`).toEqual([]);
  });

  it("dispatches no tool the model is never told about", () => {
    const unreachable = ARMS.filter((n) => !DECLARED.includes(n));
    expect(unreachable, `Dispatcher arms the model can never call: ${unreachable.join(", ")}. ${FIX}`).toEqual([]);
  });

  it("serves every client tool in exactly one place: declared, handled here, and NOT also a Rust arm", () => {
    for (const n of CLIENT) {
      expect(DECLARED, `client tool ${n} is not declared in TOOLS`).toContain(n);
      expect(ARMS, `client tool ${n} also has a Rust arm — two servers for one name`).not.toContain(n);
      expect(runClientTool(n, {}), `client tool ${n} has no handler`).not.toBeNull();
    }
    // And a name nobody owns is answered by null, so the Rust path stays the default.
    expect(runClientTool("list_charts", {})).toBeNull();
  });

  it("declares every tool exactly once", () => {
    const dupes = DECLARED.filter((n, i) => DECLARED.indexOf(n) !== i);
    expect(dupes, `Duplicate tool declarations: ${dupes.join(", ")}`).toEqual([]);
  });

  it("gives every tool a description and an object schema", () => {
    for (const t of TOOLS) {
      expect(t.description.length, `${t.name} has no description`).toBeGreaterThan(20);
      expect(t.inputSchema.type, `${t.name} schema is not an object`).toBe("object");
    }
  });
});

describe("the chat can hand the user a script to review (M1)", () => {
  // Named explicitly rather than left to the generic diffs above: this is the
  // regression that shipped, and a guard whose failure does not name the missing
  // feature just says "a tool is missing".
  const DRAFT_TOOLS = ["draft_object_script", "list_script_drafts", "get_script_draft"];

  it.each(DRAFT_TOOLS)("%s is declared to the model", (name) => {
    expect(
      DECLARED,
      `${name} is missing from TOOLS. Without it the chat's only route to a script is run_script, ` +
        "which EXECUTES immediately — the inverse of the review-then-mount invariant mcp/drafts.rs holds.",
    ).toContain(name);
  });

  it.each(DRAFT_TOOLS)("%s is dispatched by the Rust backend", (name) => {
    expect(ARMS, `${name} has no arm in ai_chat_run_tool`).toContain(name);
  });

  it("tells the model that a draft is NOT mounted and NOT running", () => {
    const draft = TOOLS.find((t) => t.name === "draft_object_script")!;
    // The tool description is the only place the model learns this. If it reads
    // as "save a script", the model will report to the user that automation is
    // live when nothing has run.
    expect(draft.description).toMatch(/does NOT mount it/);
    expect(draft.description).toMatch(/does NOT run it/);
    expect(draft.description).toMatch(/review/i);
  });

  it("steers durable automation away from run_script", () => {
    const runScript = TOOLS.find((t) => t.name === "run_script")!;
    // Both descriptions must point at each other, or the model picks whichever
    // it saw first. run_script is listed earlier, so its own text has to defer.
    expect(runScript.description).toMatch(/draft_object_script/);
    expect(TOOLS.find((t) => t.name === "draft_object_script")!.description).toMatch(/run_script/);
  });

  it("requires the arguments drafts.rs refuses to do without", () => {
    const draft = TOOLS.find((t) => t.name === "draft_object_script")!;
    // validate_draft rejects an empty name, an unknown type and empty source.
    expect(draft.inputSchema.required).toEqual(
      expect.arrayContaining(["name", "object_type", "source"]),
    );
    // instance_id and description are genuinely optional (serde `default`).
    expect(draft.inputSchema.required).not.toContain("instance_id");
    expect(draft.inputSchema.required).not.toContain("description");
  });
});

describe("the tool schemas reach the STRICTEST provider in the picker", () => {
  // WHY THIS EXISTS, measured live against Ollama 2026-08-22:
  //
  //   Ollama error 400: json: cannot unmarshal number into Go struct field
  //   .tools.function.parameters.properties.enum of type string
  //
  // `cube_kpi` declared `property: { type: "integer", enum: [1, 2, 3] }` — valid
  // JSON Schema, accepted by Anthropic and OpenAI, and rejected by Ollama, whose
  // tool type declares the per-property `enum` as a Go `[]string`. The failure is
  // at JSON-DECODE time, so it lands before any inference: no model is loaded, no
  // token is generated, and the message the user typed never matters.
  //
  // The blast radius is what makes it worth a guard rather than a fix. ChatView
  // sends the WHOLE `TOOLS` array on every turn, so a single unportable member in
  // a tool nobody invoked broke every message to that runtime. Nothing else could
  // catch it: `probeRunner` sends `tools: []`, so "Test this model" reported the
  // model as perfectly healthy while the chat was unusable, and every cloud
  // provider accepted the schema, so no amount of testing against Claude or GPT
  // would ever have shown it.
  //
  // Local runtimes are the DEFAULT posture (providers.rs §11.1: "Local is the
  // DEFAULT because the workbook never leaves the machine"), so the tool surface
  // is held to the lowest common denominator of the providers actually offered,
  // not to what the spec permits.

  interface EnumSite {
    /** Dotted path from the tool name, for a failure that names the offender. */
    path: string;
    values: unknown[];
    /** The `type` declared beside it, if any. */
    declaredType: unknown;
  }

  /** Every `enum` in a schema — nested objects and array `items` included. */
  function enumSites(node: unknown, path: string, out: EnumSite[]): void {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => enumSites(item, `${path}[${i}]`, out));
      return;
    }
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.enum)) {
      out.push({ path: `${path}.enum`, values: obj.enum, declaredType: obj.type });
    }
    for (const [key, value] of Object.entries(obj)) {
      // `enum` itself is a value list, not a subschema: descending into it would
      // report each member as its own site.
      if (key !== "enum") enumSites(value, `${path}.${key}`, out);
    }
  }

  const ENUM_SITES = TOOLS.flatMap((t) => {
    const out: EnumSite[] = [];
    enumSites(t.inputSchema, t.name, out);
    return out;
  });

  it("finds the enums at all (a walker that returns nothing passes vacuously)", () => {
    // Four string enums are declared today. If this ever drops to zero, the two
    // assertions below are meaningless rather than satisfied.
    expect(ENUM_SITES.length).toBeGreaterThanOrEqual(4);
    // ...and the walk must reach NESTED ones, not just the top level of
    // `properties`. This one is four levels down, inside an array's `items`, and
    // a walker that only scanned `inputSchema.properties` would silently miss it
    // — which is the exact shape of the bug this whole block is here to stop.
    expect(ENUM_SITES.map((e) => e.path)).toContain(
      "run_bi_query.properties.filters.items.properties.operator.enum",
    );
  });

  it("declares no enum member that is not a string", () => {
    const bad = ENUM_SITES.flatMap((e) =>
      e.values.filter((v) => typeof v !== "string").map((v) => `${e.path}: ${JSON.stringify(v)}`),
    );
    expect(
      bad,
      "Unportable enum member(s). Ollama decodes a tool schema's `enum` into a Go []string, " +
        "so a number or boolean is an HTTP 400 before any inference — and since every tool is " +
        "sent on every turn, ONE of these breaks EVERY message to that runtime. " +
        "FIX: express the constraint in `description` (as cube_kpi.property does), or make the " +
        "members strings and widen the Rust param type to match.",
    ).toEqual([]);
  });

  it("declares `type: \"string\"` beside every enum", () => {
    // The other half of the same trap. `type: "integer"` next to string members
    // would pass the check above while still telling the model — and a stricter
    // server — two different things about the same field.
    const contradictory = ENUM_SITES.filter(
      (e) => e.declaredType !== undefined && e.declaredType !== "string",
    ).map((e) => `${e.path}: type ${JSON.stringify(e.declaredType)}`);
    expect(
      contradictory,
      "An enum's members are strings, so its `type` must say \"string\".",
    ).toEqual([]);
  });
});

describe("draft object types mirror the Rust validator", () => {
  it("matches VALID_OBJECT_TYPES in mcp/drafts.rs exactly, in order", () => {
    // Rust is the source of truth: it is the validator that actually refuses,
    // and its list was derived from what save_object_script will accept — so a
    // type only on the TS side produces a draft the user cannot mount, and a
    // type only on the Rust side is a target the model is never offered.
    expect(
      [...DRAFT_OBJECT_TYPES],
      "FIX: update DRAFT_OBJECT_TYPES in app/extensions/AIChat/lib/chatTools.ts to match " +
        "VALID_OBJECT_TYPES in app/src-tauri/src/mcp/drafts.rs — never the other way round.",
    ).toEqual(rustObjectTypes());
  });

  it("is offered to the model as a closed enum, not prose", () => {
    const draft = TOOLS.find((t) => t.name === "draft_object_script")!;
    const objectType = draft.inputSchema.properties.object_type as { enum?: string[] };
    expect(objectType.enum, "object_type must constrain the model to the valid set").toEqual([
      ...DRAFT_OBJECT_TYPES,
    ]);
  });
});

// ---------------------------------------------------------------------------
// The system prompt and the surface must agree
// ---------------------------------------------------------------------------

describe("SYSTEM_PROMPT teaches the mechanism and the closed set", () => {
  // WHY. On 2026-08-22 a local model asked to "create a script that formats the
  // background color of each selected cell" replied with a fenced ```json block
  // naming `format_cells` — a tool that does not exist — and nothing ran. Two
  // separate defects, and the prompt is the cheapest place to address both.

  it("names every tool that exists, so the set is closed", () => {
    // Built from TOOLS, so a rename cannot leave the prompt promising a tool the
    // surface no longer offers. Non-vacuous: assert the surface is real first.
    expect(TOOL_NAMES.length).toBeGreaterThanOrEqual(20);
    expect(TOOL_NAMES).toEqual(TOOLS.map((t) => t.name));
    for (const name of TOOL_NAMES) {
      expect(SYSTEM_PROMPT, `${name} is offered to the model but never named in the prompt`)
        .toContain(name);
    }
  });

  it("says that writing a tool call as text does nothing", () => {
    expect(SYSTEM_PROMPT).toContain("EMIT A TOOL CALL");
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("does nothing");
    // The exact failure shape, named so the model can recognise it.
    expect(SYSTEM_PROMPT).toContain("```json");
  });

  it("tells the model not to invent a name", () => {
    expect(SYSTEM_PROMPT).toMatch(/never call a name outside/i);
  });

  it("tells the model where the selection comes from", () => {
    // No tool reads it; the coordinates are appended to this prompt at send
    // time by selectionContext.ts. A model told nothing invents a range.
    expect(SYSTEM_PROMPT).toMatch(/no tool reads the selection/i);
  });

  it("warns that a draft mounts at the restricted tier", () => {
    // draftToScriptDefinition mounts every AI draft "restricted", and every
    // `api.*` chain needs "unlocked".
    expect(SYSTEM_PROMPT).toContain("RESTRICTED");
    expect(SYSTEM_PROMPT).toContain("Unlocked");
  });
});

describe("the salvage auto-run allowlist is a subset of the real surface", () => {
  it("names only tools that exist", () => {
    for (const name of AUTORUN_TOOLS) {
      expect(TOOL_NAMES, `${name} is allowlisted for auto-run but is not a tool`).toContain(name);
    }
  });

  it("admits nothing that writes to the workbook or runs code", () => {
    // A salvaged call is recovered from prose by a heuristic. Reads and drafting
    // are harmless; everything else asks the user first (ChatView).
    const writesOrExecutes = TOOL_NAMES.filter(
      (n) => n.startsWith("set_") || n.startsWith("create_") || n.startsWith("apply_") || n === "run_script",
    );
    expect(writesOrExecutes.length, "the mutating set must not be empty or this is vacuous")
      .toBeGreaterThanOrEqual(6);
    for (const name of writesOrExecutes) {
      expect(AUTORUN_TOOLS.has(name), `${name} mutates and must never auto-run from prose`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The narrowed surface a small model falls back to
// ---------------------------------------------------------------------------

describe("CORE_TOOLS is a real, usable subset", () => {
  // Measured 2026-08-22 against a live Ollama with the user's exact request:
  // qwen2.5-coder:3b named a real tool 0/4 times at 24 tool schemas and 4/4 at
  // 12. ChatView narrows to this set after a turn in which every call was
  // invented.

  it("is a strict subset of the real surface", () => {
    for (const name of CORE_TOOL_NAMES) {
      expect(TOOL_NAMES, `${name} is in the core set but is not a tool`).toContain(name);
    }
    expect(CORE_TOOLS.map((t) => t.name).sort()).toEqual([...CORE_TOOL_NAMES].sort());
  });

  it("is meaningfully smaller than the full surface, or it fixes nothing", () => {
    expect(CORE_TOOLS.length).toBeLessThanOrEqual(12);
    expect(CORE_TOOLS.length).toBeLessThan(TOOLS.length / 1.5);
  });

  it("keeps the script path — the naive slice drops it", () => {
    // Taking "the first twelve tools" excludes draft_object_script, which
    // produced a model that formatted cells when asked to write a SCRIPT.
    expect(CORE_TOOL_NAMES).toContain("draft_object_script");
    expect(CORE_TOOL_NAMES).toContain("run_script");
  });

  it("keeps enough to orient, read, write and format", () => {
    for (const essential of [
      "get_sheet_summary", "read_cell_range", "set_cell_value", "apply_formatting",
    ]) {
      expect(CORE_TOOL_NAMES).toContain(essential);
    }
  });
});

describe("buildSystemPrompt never promises a tool it is not sending", () => {
  it("names exactly the surface it was given", () => {
    const prompt = buildSystemPrompt(CORE_TOOL_NAMES);
    for (const name of CORE_TOOL_NAMES) expect(prompt).toContain(name);
    // The BI paragraph must not survive into a prompt whose surface lacks them.
    for (const dropped of TOOL_NAMES.filter((n) => !CORE_TOOL_NAMES.includes(n))) {
      expect(prompt, `${dropped} is not offered and must not be named`).not.toContain(dropped);
    }
  });

  it("the exported full prompt is just the full-surface case", () => {
    expect(SYSTEM_PROMPT).toBe(buildSystemPrompt(TOOL_NAMES));
    expect(SYSTEM_PROMPT).toBe(buildSystemPrompt());
  });

  it("keeps the mechanism rules whichever surface it builds", () => {
    for (const prompt of [buildSystemPrompt(TOOL_NAMES), buildSystemPrompt(CORE_TOOL_NAMES)]) {
      expect(prompt).toContain("EMIT A TOOL CALL");
      expect(prompt).toMatch(/never call a name outside/i);
      expect(prompt).toMatch(/no tool reads the selection/i);
    }
  });
});
