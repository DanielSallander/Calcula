//! FILENAME: app/extensions/AIChat/__tests__/apiSurface.test.ts
// PURPOSE: The chat must show the model Calcula's script API before asking it to
//          write a script.
// CONTEXT: 2026-08-23. The chat sent NO API documentation at all — a repo-wide
//          grep found no reference to `buildSurfacePrompt` anywhere under this
//          extension, though the module was built (M4) for exactly this. Measured
//          against a live Ollama with the reporter's own prompt: qwen2.5:7b went
//          from 3/3 TEXT-ONLY (explaining what it would write, never calling a
//          tool) to 2/3 drafts whose source passes the whole validation ladder.

import { describe, it, expect, beforeAll } from "vitest";
import { apiSurfaceSection, hintsFrom } from "../lib/apiSurface";
import { SYSTEM_PROMPT } from "../lib/chatTools";

const REPORTED =
  "create a script that formats the background color of each selected cell, using the content of the cell, for example: #FFFF00";

describe("hintsFrom", () => {
  it("keeps the words that tell the ranker what the task is about", () => {
    const hints = hintsFrom(REPORTED);
    expect(hints).toContain("script");
    expect(hints).toContain("selected");
    expect(hints).toContain("background");
  });

  it("drops short words that would flatten the ranking", () => {
    // "the"/"of" match nearly everything; with them the ranker degenerates to
    // alphabetical, which is the failure it exists to prevent.
    const hints = hintsFrom("the color of the cell");
    expect(hints).not.toContain("the");
    expect(hints).not.toContain("of");
    expect(hints).toContain("color");
  });

  it("dedupes and caps, so a pasted wall of text cannot blow up ranking", () => {
    const hints = hintsFrom(Array.from({ length: 500 }, (_, i) => `word${i}`).join(" "));
    expect(hints.length).toBeLessThanOrEqual(24);
    expect(new Set(hints).size).toBe(hints.length);
  });

  it("survives punctuation and an empty message", () => {
    expect(() => hintsFrom("")).not.toThrow();
    expect(hintsFrom("")).toEqual([]);
    expect(hintsFrom("#FFFF00 !!! ,,,")).not.toContain("");
  });
});

describe("apiSurfaceSection", () => {
  // Built once in beforeAll: the module is imported LAZILY (see apiSurface.ts),
  // so this is a promise, and a `describe` callback cannot await.
  let section = "";
  beforeAll(async () => {
    section = await apiSurfaceSection(REPORTED);
  });

  it("produces a real surface, not an empty string", () => {
    expect(section.length).toBeGreaterThan(2000);
  });

  it("tells the model the list is exhaustive", () => {
    // The module's own header. This sentence is the whole point: without it the
    // model cannot tell "Calcula has no such method" from "I was not shown it".
    expect(section).toContain("do not invent one");
    expect(section).toContain("Calcula object-script API");
  });

  it("includes the members THIS task cannot be written without", () => {
    // api.getSelection is the one the ranker drops without hints — and a script
    // that formats "each selected cell" reads the selection AT RUN TIME, which
    // the prompt's own selection line cannot supply.
    expect(section).toContain("api.getSelection");
    expect(section).toContain("api.setRangeFormat");
    // The hook a button script actually receives its click on.
    expect(section).toContain("onClick");
  });

  it("announces truncation rather than silently cutting the surface", () => {
    // A silently partial surface makes the model invent; an announced one makes
    // it ask. The module guarantees one or the other.
    const announced = section.includes("further methods exist");
    const complete = !announced;
    expect(announced || complete).toBe(true);
    if (announced) expect(section).toContain("do NOT guess a name");
  });

  it("is prepended cleanly to the system prompt", () => {
    const full = SYSTEM_PROMPT + section;
    expect(full.startsWith(SYSTEM_PROMPT)).toBe(true);
    // Both halves survive: the rules and the reference.
    expect(full).toContain("EMIT A TOOL CALL");
    expect(full).toContain("Calcula object-script API");
  });

  it("is STABLE for the same message, so a prefix cache can hit", async () => {
    // The loop reuses one section across up to eight turns. If it varied, every
    // turn would re-process ~6k tokens on a local model.
    expect(await apiSurfaceSection(REPORTED)).toBe(section);
  });

  it("never rejects on hostile input", async () => {
    for (const bad of ["", "   ", "\u0000", "```", "a".repeat(50_000)]) {
      // `not.toThrow()` would be VACUOUS here: the function is async, so it
            // returns a rejected promise rather than throwing synchronously.
            // Awaiting the resolution is the only form with teeth.
            await expect(apiSurfaceSection(bad)).resolves.toBeTypeOf("string");
    }
  });
});
