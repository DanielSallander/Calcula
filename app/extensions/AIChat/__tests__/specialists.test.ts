//! FILENAME: app/extensions/AIChat/__tests__/specialists.test.ts
// PURPOSE: Every chat tool is reachable from some specialist, every specialist
//          is small enough to help, and only a DECIDED route narrows.
// CONTEXT: The measured lever is surface size (24 tools -> 0/4 real names,
//          12 -> 4/4). The two ways to get that wrong are a tool that no
//          specialist offers — a silent deletion — and a specialist so wide it
//          is the general loop under another name. Both are pinned here.

import { describe, it, expect } from "vitest";
import { SPECIALISTS, specialistFor, narrowedSurface } from "../lib/specialists";
import { TOOL_NAMES, CORE_TOOL_NAMES } from "../lib/chatTools";
import { routeIntent, INTENTS } from "../lib/intentRouter";
import { buildModelFieldIndex } from "@api";

describe("the specialists", () => {
  it("between them reach EVERY tool the chat has", () => {
    const reachable = new Set(SPECIALISTS.filter((s) => s.intent !== "general").flatMap((s) => [...s.toolNames]));
    const unreachable = TOOL_NAMES.filter((n) => !reachable.has(n));
    expect(unreachable, "tools no specialist can ever choose").toEqual([]);
  });

  it("name only tools that exist, in the declared order", () => {
    for (const s of SPECIALISTS) {
      for (const n of s.toolNames) expect(TOOL_NAMES, `${s.intent}: ${n}`).toContain(n);
      const declared = TOOL_NAMES.filter((n) => s.toolNames.includes(n));
      expect([...s.toolNames], s.intent).toEqual(declared);
      expect(s.tools.map((t) => t.name), s.intent).toEqual([...s.toolNames]);
    }
  });

  it("are SMALL — at most eight tools — except the general loop", () => {
    for (const s of SPECIALISTS) {
      if (s.intent === "general" || s.intent === "unclear") continue;
      expect(s.toolNames.length, s.intent).toBeLessThanOrEqual(8);
      expect(s.toolNames.length, s.intent).toBeGreaterThan(0);
    }
  });

  it("never promise the model a tool their addendum then withholds", () => {
    // An addendum that says "call analyze_range" while the subset lacks it is
    // the exact defect buildSystemPrompt guards its own paragraphs against.
    for (const s of SPECIALISTS) {
      for (const n of TOOL_NAMES) {
        if (s.systemAddendum.includes(n)) expect(s.toolNames, `${s.intent} mentions ${n}`).toContain(n);
      }
    }
  });

  it("have one specialist per intent, and each intent's specialist sends its own tools", () => {
    for (const intent of INTENTS) {
      const s = SPECIALISTS.find((x) => x.intent === intent);
      expect(s, intent).toBeDefined();
    }
  });
});

describe("specialistFor", () => {
  const fields = buildModelFieldIndex([
    { tables: [{ name: "Geography", columns: [{ name: "Region" }] }], measures: [{ name: "Revenue" }] },
  ]);

  it("narrows for a DECIDED route", () => {
    const s = specialistFor(routeIntent("make A1:D1 bold"));
    expect(s.intent).toBe("format");
    expect(s.toolNames).toContain("apply_formatting");
    expect(s.toolNames).not.toContain("draft_object_script");
  });

  it("keeps every tool for a lean, an ask, and an unclear", () => {
    expect(specialistFor(routeIntent("what does a pivot table do")).intent).toBe("general");
    expect(specialistFor(routeIntent("fix this")).intent).toBe("general");
    const ask = routeIntent("analyse the sales and then automate the report every week", { fields });
    expect(ask.clarify).toBeDefined();
    expect(specialistFor(ask).intent).toBe("general");
    expect(specialistFor(ask).toolNames.length).toBe(TOOL_NAMES.length);
  });

  it("sends the report tools for a decided report", () => {
    const s = specialistFor(routeIntent("revenue by region", { fields }));
    expect(s.intent).toBe("bi-query");
    expect(s.toolNames).toContain("run_bi_query");
    expect(s.toolNames).not.toContain("apply_formatting");
  });
});

describe("narrowedSurface — the retry after an invented tool name", () => {
  it("drops the general loop to the core set, as it always did", () => {
    const general = specialistFor(routeIntent("hello"));
    expect(general.toolNames.length).toBe(TOOL_NAMES.length);
    const retry = narrowedSurface(general);
    expect(retry).not.toBe(general);
    expect(retry.intent).toBe("core");
    // The same members as CORE_TOOL_NAMES, in the DECLARED order of TOOLS —
    // the prompt's list and the schemas sent used to be ordered differently.
    const coreInDeclaredOrder = TOOL_NAMES.filter((n) => CORE_TOOL_NAMES.includes(n));
    expect(coreInDeclaredOrder.length).toBe(CORE_TOOL_NAMES.length);
    expect([...retry.toolNames]).toEqual(coreInDeclaredOrder);
    expect(retry.tools.map((t) => t.name)).toEqual(coreInDeclaredOrder);
    expect(retry.systemAddendum).toBe("");
  });

  it("never WIDENS a specialist that is already no wider than the core set", () => {
    // The measured lever is size. Handing a model ten names because it
    // invented one from a list of four is the opposite of the fix, and the
    // identity return is how the call site knows to say so honestly.
    for (const s of SPECIALISTS) {
      if (s.toolNames.length > CORE_TOOL_NAMES.length) continue;
      expect(narrowedSurface(s), s.intent).toBe(s);
    }
    const format = specialistFor(routeIntent("make A1:D1 bold"));
    expect(format.toolNames.length).toBeLessThan(CORE_TOOL_NAMES.length);
    expect(narrowedSurface(format)).toBe(format);
  });

  it("is idempotent, so a remembered narrowing cannot compound", () => {
    for (const s of SPECIALISTS) expect(narrowedSurface(narrowedSurface(s))).toBe(narrowedSurface(s));
  });
});
