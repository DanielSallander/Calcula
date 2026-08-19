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
import { TOOLS, DRAFT_OBJECT_TYPES } from "../lib/chatTools";

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

// ---------------------------------------------------------------------------

describe("in-app chat tool surface", () => {
  it("parses a non-trivial dispatcher (the parser itself must not silently return nothing)", () => {
    // A parser that matched nothing would make every diff below pass vacuously.
    expect(ARMS.length).toBeGreaterThan(20);
    expect(DECLARED.length).toBeGreaterThan(20);
  });

  it("declares no tool the Rust dispatcher cannot serve", () => {
    const orphans = DECLARED.filter((n) => !ARMS.includes(n));
    expect(orphans, `Declared to the model but unreachable: ${orphans.join(", ")}. ${FIX}`).toEqual([]);
  });

  it("dispatches no tool the model is never told about", () => {
    const unreachable = ARMS.filter((n) => !DECLARED.includes(n));
    expect(unreachable, `Dispatcher arms the model can never call: ${unreachable.join(", ")}. ${FIX}`).toEqual([]);
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
