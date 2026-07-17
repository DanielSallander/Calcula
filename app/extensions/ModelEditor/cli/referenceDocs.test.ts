// FILENAME: app/extensions/ModelEditor/cli/referenceDocs.test.ts
// PURPOSE: Consistency checks for the CLI reference guide: topic ids are
//          unique and linkable, every `topic.md` cross-link resolves, and
//          every object kind the parser accepts is covered by a topic.

import { describe, expect, it } from "vitest";
import { CLI_REFERENCE } from "./referenceDocs";
import { KINDS } from "./parse";
import type { Kind } from "./parse";

describe("CLI reference guide", () => {
  const ids = new Set(CLI_REFERENCE.map((t) => t.id));

  it("has unique, renderer-linkable topic ids", () => {
    expect(ids.size).toBe(CLI_REFERENCE.length);
    // The Markdown renderer only navigates (id.md) targets of this shape.
    for (const t of CLI_REFERENCE) {
      expect(t.id).toMatch(/^[A-Za-z0-9_]+$/);
    }
  });

  it("resolves every topic.md cross-link to an existing topic", () => {
    const broken: string[] = [];
    for (const t of CLI_REFERENCE) {
      const re = /\]\(([A-Za-z0-9_]+)\.md\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(t.markdown)) !== null) {
        if (!ids.has(m[1])) broken.push(`${t.id} -> ${m[1]}.md`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("covers every object kind the parser accepts", () => {
    // Kinds folded into a sibling's topic:
    const foldedInto: Partial<Record<Kind, string>> = {
      translation: "culture",
      calcitem: "calcgroup",
      sourcetable: "source",
    };
    const missing = KINDS.filter((k) => !ids.has(foldedInto[k] ?? k));
    expect(missing).toEqual([]);
  });

  it("every topic has a group, title and summary", () => {
    for (const t of CLI_REFERENCE) {
      expect(["Guide", "Verbs", "Objects"]).toContain(t.group);
      expect(t.title.length).toBeGreaterThan(2);
      expect(t.summary.length).toBeGreaterThan(10);
      expect(t.markdown.trimStart().startsWith("#")).toBe(true);
    }
  });
});
