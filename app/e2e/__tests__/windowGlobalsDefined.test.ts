//! FILENAME: app/e2e/__tests__/windowGlobalsDefined.test.ts
// PURPOSE: Every `window.__CALCULA_*__` global an e2e file reads must be one the
//          app actually DEFINES.
// CONTEXT: `fixtures.ts` closed the task panes left over from the previous test
//          through `window.__CALCULA_TASKPANE_STORE__` -- a global nothing in the
//          app has ever set -- inside a try/catch that swallowed the miss. The
//          reset was therefore a silent no-op, File > New closes no pane, and a
//          pane one spec opened (the Audit Log, Format Chart) stayed docked on
//          the right for every later spec, narrowing the grid by ~500 px:
//          Ctrl+clicks, pixel samples and form clicks then failed in specs that
//          had nothing to do with the pane (E2E runs 9 and 10, 2026-09-30 and
//          2026-10-01). A spec copied the same no-op, which is how a broken
//          helper spreads.
//
//          A read of a global that does not exist is indistinguishable from "no
//          leftover state" at runtime, so the check has to be static: every
//          name read under e2e/ must appear in non-test app source.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const APP_ROOT = process.cwd();
const GLOBAL = /__CALCULA_[A-Z0-9_]+__/g;

function walk(dir: string, keep: (path: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "test-results" || name === "playwright-report") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, keep, out);
    else if (keep(path)) out.push(path);
  }
  return out;
}

const isSource = (p: string) => /\.(ts|tsx)$/.test(p);
const isTest = (p: string) => /[\\/]__tests__[\\/]|\.test\.tsx?$|\.spec\.tsx?$/.test(p);

/** Names e2e code reads, with one file each reads it in (for the message). */
function e2eGlobals(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of walk(join(APP_ROOT, "e2e"), isSource)) {
    // This guard names the globals it is about; it reads none of them.
    if (file.endsWith("windowGlobalsDefined.test.ts")) continue;
    for (const m of readFileSync(file, "utf8").matchAll(GLOBAL)) {
      if (!found.has(m[0])) found.set(m[0], relative(APP_ROOT, file));
    }
  }
  return found;
}

/** Names the app's non-test source mentions (where every global is set). */
function appGlobals(): Set<string> {
  const names = new Set<string>();
  for (const root of ["src", "extensions"]) {
    for (const file of walk(join(APP_ROOT, root), (p) => isSource(p) && !isTest(p))) {
      for (const m of readFileSync(file, "utf8").matchAll(GLOBAL)) names.add(m[0]);
    }
  }
  return names;
}

describe("e2e reads only window globals the app defines", () => {
  it("every __CALCULA_*__ name under e2e/ appears in the app's own source", () => {
    const used = e2eGlobals();
    const defined = appGlobals();
    expect(used.size, "precondition: the e2e suite reads some app globals").toBeGreaterThan(5);
    const missing = [...used].filter(([name]) => !defined.has(name)).map(([name, file]) => `${name} (read in ${file})`);
    expect(
      missing,
      "an e2e file reads a window global that nothing in the app sets -- the read is a silent " +
        "no-op at runtime. Use the real module (import it by URL from the dev server, as " +
        "fixtures.ts does for the task pane store) or define the global in the app",
    ).toEqual([]);
  });

  it("the appPage fixture closes task panes through the real store, never a window global", () => {
    const fixtures = readFileSync(join(APP_ROOT, "e2e", "fixtures.ts"), "utf8");
    expect(fixtures).toContain('"/src/shell/TaskPane/useTaskPaneStore.ts"');
    expect(fixtures).toContain("useTaskPaneStore.getState().reset()");
    expect(fixtures).not.toContain("__CALCULA_TASKPANE_STORE__");
    // The store module the fixture imports must exist and export what it calls.
    const store = readFileSync(join(APP_ROOT, "src", "shell", "TaskPane", "useTaskPaneStore.ts"), "utf8");
    expect(store).toMatch(/export const useTaskPaneStore\b/);
    expect(store).toMatch(/\breset: \(\) =>/);
  });
});
