// FILENAME: app/extensions/ModelEditor/__tests__/strategyLayering.test.ts
// PURPOSE: The Strategy folder's import graph must stay a layered DAG, and
//          StrategySection.tsx must stay the only door into it.
// CONTEXT: A CYCLE HERE FAILS NOTHING. Vite and vitest both resolve circular
//          imports, so the symptom is not a build error — it is one module's
//          initialisation order quietly depending on which file the importer
//          happened to reach first, which shows up later as an undefined
//          constant in one test file and not another.
//
//          The layering is also the thing that made the split safe. 4,681 lines
//          came out of one file with ZERO test edits because every one of the
//          131 Strategy tests mounts the whole section through the shell; the
//          moment a sibling reaches back to the shell, or a test starts
//          importing a leaf directly, that property is gone and the next
//          refactor pays for it.
//
//          Read as TEXT rather than by importing, for the reason
//          themeTokenContract does: the point is what is WRITTEN, and importing
//          the modules to inspect them would itself create the coupling being
//          measured.

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const SECTIONS = join(__dirname, "..", "components", "sections");
const DIR = join(SECTIONS, "strategy");

/** module name -> the sibling modules it imports. */
function graph(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const f of readdirSync(DIR).filter((n) => /\.tsx?$/.test(n))) {
    const src = readFileSync(join(DIR, f), "utf8");
    const deps = new Set<string>();
    for (const m of src.matchAll(/from\s+"\.\/([A-Za-z]+)"/g)) deps.add(m[1]);
    out.set(f.replace(/\.tsx?$/, ""), deps);
  }
  return out;
}

describe("the Strategy folder's layering", () => {
  it("actually found the modules (the other half of the guard)", () => {
    // If the folder moved or the regex stopped matching, every assertion below
    // would pass over an empty graph.
    const g = graph();
    expect(g.size).toBeGreaterThan(10);
    expect([...g.keys()]).toContain("MeasuresGrid");
    expect([...g.keys()]).toContain("constants");
  });

  it("has no import cycles", () => {
    const g = graph();
    const state = new Map<string, "open" | "done">();
    const cycles: string[] = [];
    const visit = (n: string, stack: string[]): void => {
      if (state.get(n) === "done") return;
      if (state.get(n) === "open") {
        cycles.push([...stack.slice(stack.indexOf(n)), n].join(" -> "));
        return;
      }
      state.set(n, "open");
      for (const d of g.get(n) ?? []) visit(d, [...stack, n]);
      state.set(n, "done");
    };
    for (const n of g.keys()) visit(n, []);
    expect({ cycles }).toEqual({ cycles: [] });
  });

  it("keeps constants a LEAF, because two grids and the tree share it", () => {
    // MEASURE_HEADERS is read by the folder header row (tree) and the measures
    // grid; TARGET_HINT by the measures grid and the rule modal. Putting either
    // inside the module that "owns" it is what would create the cycle.
    expect([...(graph().get("constants") ?? [])]).toEqual([]);
  });

  it("never lets a sibling import the shell", () => {
    // The inversion that matters most: the shell imports the folder, and
    // nothing in the folder may import back. It would make StrategySection.tsx
    // part of a cycle with every component in it at once.
    const offenders: string[] = [];
    for (const f of readdirSync(DIR).filter((n) => /\.tsx?$/.test(n))) {
      const src = readFileSync(join(DIR, f), "utf8");
      if (/from\s+"\.\.\/StrategySection"/.test(src)) offenders.push(f);
    }
    expect({ siblingsImportingTheShell: offenders }).toEqual({ siblingsImportingTheShell: [] });
  });

  it("keeps the shell as the only door for everyone outside the folder", () => {
    // Four files import Strategy symbols and all four name StrategySection.
    // If a test or another section starts reaching into strategy/ directly, the
    // barrel stops being a barrel and the next move breaks callers.
    const roots = [join(__dirname, ".."), join(__dirname)];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules") continue;
          walk(p);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        if (p.startsWith(DIR)) continue; // siblings may import each other
        const src = readFileSync(p, "utf8");
        if (/from\s+"[^"]*sections\/strategy\/[A-Za-z]+"/.test(src)) offenders.push(entry.name);
      }
    };
    for (const r of roots) walk(r);
    expect({ reachingPastTheBarrel: [...new Set(offenders)] }).toEqual({
      reachingPastTheBarrel: [],
    });
  });

  it("keeps the numbered property header in ONE place", () => {
    // Six of the nineteen properties are invariants over several modules now.
    // Splitting the list across ten files is how property (10) went stale once
    // inside a SINGLE file; the header therefore stays in the shell, and each
    // module points at it instead of quoting it.
    const shell = readFileSync(join(SECTIONS, "StrategySection.tsx"), "utf8");
    expect(shell).toContain("(19) A ROW THAT CAN BE HIDDEN MUST STILL BE REACHABLE");
    expect(shell).toContain("Nineteen properties are the design");

    // ...and no module re-states the list rather than referring to it.
    for (const f of readdirSync(DIR).filter((n) => /\.tsx?$/.test(n))) {
      const src = readFileSync(join(DIR, f), "utf8");
      expect(src, `${f} must point at the header, not copy it`).not.toContain(
        "properties are the design",
      );
    }
  });
});
