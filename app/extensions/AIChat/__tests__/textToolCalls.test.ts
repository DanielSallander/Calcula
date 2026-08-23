//! FILENAME: app/extensions/AIChat/__tests__/textToolCalls.test.ts
// PURPOSE: The salvager must recover a real tool call the model wrote as prose,
//          and must NOT invent one out of prose that merely mentions tools.
// CONTEXT: The reported failure, verbatim: a local model asked to "create a
//          script that formats the background color of each selected cell"
//          replied with a fenced ```json block naming `format_cells`, and
//          nothing happened. Both halves are pinned below — the recovery, and
//          the refusal to guess that `format_cells` meant `apply_formatting`.

import { describe, it, expect } from "vitest";
import {
  salvageTextualToolCalls,
  stripSpans,
  unknownToolMessage,
} from "../lib/textToolCalls";
import { TOOL_NAMES, SALVAGE_AUTORUN, TOOLS } from "../lib/chatTools";

/** The real surface, so a rename of any tool reds these tests rather than
 *  leaving them asserting against a vocabulary the product no longer has. */
const KNOWN = TOOL_NAMES;

describe("salvageTextualToolCalls - the reported failure", () => {
  // The user's actual screenshot, reconstructed. `format_cells` does not exist.
  const REPORTED = [
    "```json",
    "{",
    '  "name": "format_cells",',
    '  "arguments": {',
    '    "cells": ["A1", "B3", "C5"],',
    '    "color_map": { "hello world": "#FFFFFF" }',
    "  }",
    "}",
    "```",
  ].join("\n");

  it("reports the invented name instead of guessing a real one", () => {
    const r = salvageTextualToolCalls(REPORTED, KNOWN);
    expect(r.calls, "an invented tool must never be dispatched").toEqual([]);
    expect(r.unknownNames).toEqual(["format_cells"]);
    // The block stays visible: nothing ran, so hiding what the model tried to do
    // would leave the user with an empty bubble and no explanation.
    expect(r.consumedSpans).toEqual([]);
  });

  it("suggests the real neighbour in the repair message", () => {
    const msg = unknownToolMessage("format_cells", KNOWN);
    expect(msg).toContain("There is no tool called \"format_cells\"");
    expect(msg, "apply_formatting is the tool it meant").toContain("apply_formatting");
    // The closed set is restated, which is what stops the next turn inventing
    // a second name.
    for (const n of KNOWN) expect(msg).toContain(n);
  });

  it("recovers the SAME shape once the name is real", () => {
    const fixed = REPORTED.replace("format_cells", "apply_formatting");
    const r = salvageTextualToolCalls(fixed, KNOWN);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].name).toBe("apply_formatting");
    expect(r.calls[0].input.cells).toEqual(["A1", "B3", "C5"]);
    expect(r.unknownNames).toEqual([]);
    expect(r.consumedSpans).toHaveLength(1);
  });
});

describe("salvageTextualToolCalls - shapes small models actually produce", () => {
  const cases: Array<[string, string]> = [
    ["fenced json", '```json\n{"name":"list_charts","arguments":{}}\n```'],
    ["bare fence", '```\n{"name":"list_charts","arguments":{}}\n```'],
    ["tool_call fence label", '```tool_call\n{"name":"list_charts","arguments":{}}\n```'],
    ["no fence at all", '{"name":"list_charts","arguments":{}}'],
    ["parameters spelling", '{"name":"list_charts","parameters":{}}'],
    ["tool spelling", '{"tool":"list_charts","arguments":{}}'],
    ["no arguments key at all", '{"name":"list_charts"}'],
    ["openai nested function", '{"type":"function","function":{"name":"list_charts","arguments":"{}"}}'],
    ["tool_calls array wrapper", '{"tool_calls":[{"id":"c1","function":{"name":"list_charts","arguments":"{}"}}]}'],
    ["bare array of envelopes", '[{"name":"list_charts","arguments":{}}]'],
  ];

  for (const [label, text] of cases) {
    it(`recovers: ${label}`, () => {
      const r = salvageTextualToolCalls(text, KNOWN);
      expect(r.calls.map((c) => c.name), label).toEqual(["list_charts"]);
    });
  }

  it("parses arguments given as a JSON string, not just an object", () => {
    // OpenAI's own wire format, and what a model imitating it from memory writes.
    const r = salvageTextualToolCalls(
      '```json\n{"name":"read_cell_range","arguments":"{\\"start_row\\":3,\\"start_col\\":0,\\"end_row\\":9,\\"end_col\\":2}"}\n```',
      KNOWN,
    );
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].input.start_row, "the string must be PARSED, not passed through").toBe(3);
    expect(r.calls[0].input.end_col).toBe(2);
  });

  it("recovers two calls from two fenced blocks", () => {
    const text =
      "First I will look:\n```json\n{\"name\":\"list_charts\",\"arguments\":{}}\n```\n" +
      "then the tables:\n```json\n{\"name\":\"list_tables\",\"arguments\":{}}\n```";
    const r = salvageTextualToolCalls(text, KNOWN);
    expect(r.calls.map((c) => c.name)).toEqual(["list_charts", "list_tables"]);
    expect(r.consumedSpans).toHaveLength(2);
  });

  it("survives a script body full of braces and quotes", () => {
    // THE case a naive indexOf('}') truncates: draft_object_script's `source` is
    // an entire macro, and every one of them contains a closing brace.
    const source = "export function setup(context) {\n  context.onClick(() => {\n    context.log(\"hi { } \\\" there\");\n  });\n}";
    const text = "```json\n" + JSON.stringify({
      name: "draft_object_script",
      arguments: { name: "Paint", object_type: "button", source },
    }) + "\n```";
    const r = salvageTextualToolCalls(text, KNOWN);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].input.source, "the whole body must survive").toBe(source);
  });
});

describe("salvageTextualToolCalls - what it must refuse", () => {
  it("finds nothing in prose that merely names a tool", () => {
    const text =
      "You could use apply_formatting to set a background colour, or run_script " +
      "if you want it applied immediately. Which would you prefer?";
    expect(salvageTextualToolCalls(text, KNOWN)).toEqual({
      calls: [], unknownNames: [], consumedSpans: [],
    });
  });

  it("finds nothing in data that happens to carry a matching name", () => {
    // Rule 2. Without the envelope-key check this is a dispatch.
    const text = '```json\n{"name":"run_script","owner":"dan","rows":42}\n```';
    const r = salvageTextualToolCalls(text, KNOWN);
    expect(r.calls, "extra keys mean this is data, not a call").toEqual([]);
    expect(r.unknownNames).toEqual([]);
  });

  it("finds nothing in a truncated fence", () => {
    const text = '```json\n{"name":"read_cell_range","arguments":{"start_row":';
    expect(salvageTextualToolCalls(text, KNOWN).calls).toEqual([]);
  });

  it("finds nothing when arguments are a string that is not JSON", () => {
    const text = '{"name":"read_cell_range","arguments":"the first ten rows"}';
    expect(salvageTextualToolCalls(text, KNOWN).calls).toEqual([]);
  });

  it("never case-folds or fuzzy-matches a name into a real one", () => {
    for (const near of ["Apply_Formatting", "applyFormatting", "apply-formatting", "apply_formating"]) {
      const r = salvageTextualToolCalls(`{"name":"${near}","arguments":{}}`, KNOWN);
      expect(r.calls, `${near} must not become apply_formatting`).toEqual([]);
      expect(r.unknownNames).toEqual([near]);
    }
  });

  it("evaluates nothing - a JS object literal is not a tool call", () => {
    const text = '```js\n{ name: "list_charts", arguments: {} }\n```';
    expect(salvageTextualToolCalls(text, KNOWN).calls).toEqual([]);
  });

  it("returns empty for text with no brace at all, cheaply", () => {
    expect(salvageTextualToolCalls("Sure, I can help with that.", KNOWN).calls).toEqual([]);
    expect(salvageTextualToolCalls("", KNOWN).calls).toEqual([]);
  });
});

describe("stripSpans", () => {
  it("removes the consumed block and keeps the prose around it", () => {
    const text = 'Here is the plan.\n```json\n{"name":"list_charts","arguments":{}}\n```\nThen I will report.';
    const r = salvageTextualToolCalls(text, KNOWN);
    const stripped = stripSpans(text, r.consumedSpans);
    expect(stripped).toBe("Here is the plan.\n\nThen I will report.");
    expect(stripped).not.toContain("list_charts");
  });

  it("is identity when nothing was consumed", () => {
    expect(stripSpans("unchanged", [])).toBe("unchanged");
  });
});

describe("the auto-run allowlist is fail-closed", () => {
  it("names only tools that exist", () => {
    for (const name of SALVAGE_AUTORUN) {
      expect(KNOWN, `${name} is allowlisted but not in TOOLS`).toContain(name);
    }
  });

  it("excludes every tool that mutates the workbook or executes code", () => {
    // The security posture, pinned. A salvaged call is recovered by a heuristic;
    // a heuristic must not be the sole authority for a silent edit.
    const MUTATING = [
      "set_cell_value", "set_cell_range", "apply_formatting", "create_named_range",
      "create_table", "create_chart_from_spec", "create_pivot", "run_script",
    ];
    for (const name of MUTATING) {
      expect(KNOWN, `${name} should still exist`).toContain(name);
      expect(
        SALVAGE_AUTORUN.has(name),
        `${name} mutates and must be confirmed with the user, never auto-run from prose`,
      ).toBe(false);
    }
  });

  it("covers every read-only tool, so the common case needs no dialog", () => {
    // Non-vacuous: if TOOLS shrank to nothing this would still want to pass, so
    // assert the surface is the size we think it is.
    expect(TOOLS.length).toBeGreaterThanOrEqual(20);
    const reads = KNOWN.filter((n) => n.startsWith("list_") || n.startsWith("get_") || n.startsWith("cube_"));
    for (const n of reads) {
      expect(SALVAGE_AUTORUN.has(n), `${n} is read-only and should not need a dialog`).toBe(true);
    }
  });
});

describe("shapes observed from a live Ollama (2026-08-22)", () => {
  // Captured by replaying the user's exact prompt against qwen2.5-coder:3b.
  // Every one of these was a real reply; none of them is hypothetical.

  it("reads a FLATTENED function key, where the name is a plain string", () => {
    // {"function": "x"} rather than {"function": {"name": "x"}} — a model
    // imitating OpenAI's format from memory. Unrecognised, this shape reported
    // no unknown name either, so the model got no repair hint at all.
    const text = '```json\n{ "function": "list_charts", "arguments": {} }\n```';
    expect(salvageTextualToolCalls(text, KNOWN).calls.map((c) => c.name)).toEqual(["list_charts"]);
  });

  it("still reports the flattened shape's INVENTED name so the model can be told", () => {
    const text = '```json\n{ "function": "format_selected_cells", "arguments": {"color": "#FFFF00"} }\n```';
    const r = salvageTextualToolCalls(text, KNOWN);
    expect(r.calls).toEqual([]);
    expect(r.unknownNames).toEqual(["format_selected_cells"]);
  });

  it("does not confuse the flattened key with the nested one", () => {
    const nested = '{"type":"function","function":{"name":"list_tables","arguments":"{}"}}';
    expect(salvageTextualToolCalls(nested, KNOWN).calls.map((c) => c.name)).toEqual(["list_tables"]);
  });

  it("reads the trailing-comment JSON the model actually emits", () => {
    // The reply in the user's first screenshot had `// Replace with...` inside
    // the block. That is not JSON, so nothing is recovered — but it must also
    // not throw, and the surrounding prose must survive.
    const text = '```json\n{ "name": "list_charts", "arguments": {} // do it\n}\n```';
    expect(() => salvageTextualToolCalls(text, KNOWN)).not.toThrow();
    expect(salvageTextualToolCalls(text, KNOWN).calls).toEqual([]);
  });
});
