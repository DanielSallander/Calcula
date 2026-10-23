//! FILENAME: app/src/api/__tests__/macroModules.test.ts
// PURPOSE: `createStarterMacro` stores ONE record, shaped so every reader
//          treats it as the user's own object-script macro: an id under
//          `macro-` (never the reserved namespace), a workbook scope, the
//          `runtime=objectScript` marker the Macros dialog's route reader
//          parses, the starter as its source, and NO `sourcePackage` key.
//          The naming cases pin the `MacroN` series against both names and
//          ids, and the chosen-name path against the recorder's `(2)` rule.
// CONTEXT: docs/design/open-items.md section 2.ap. The store is doubled in
//          memory; everything else in @api/workbookScripts is REAL, so the
//          runtime marker is read by the actual `parseModuleScriptRuntime`.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ScriptSummary, WorkbookScript } from "@api/workbookScripts";

const h = vi.hoisted(() => ({
  store: new Map<string, { id: string; name: string; description: string | null; source: string; scope?: unknown; sourcePackage?: string | null }>(),
  saves: [] as unknown[],
}));

vi.mock("@api/workbookScripts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@api/workbookScripts")>();
  return {
    ...actual,
    listWorkbookScripts: vi.fn(async (): Promise<ScriptSummary[]> =>
      [...h.store.values()].map((s) => ({ id: s.id, name: s.name, scope: s.scope as ScriptSummary["scope"] })),
    ),
    saveWorkbookScript: vi.fn(async (script: WorkbookScript) => {
      h.saves.push(script);
      h.store.set(script.id, script);
    }),
  };
});

import { createStarterMacro } from "@api/macroModules";
import { saveWorkbookScript } from "@api/workbookScripts";
import { buildMacroStarterSource } from "@api/scriptHost/macroStarter";
import { nextDefaultMacroName, MACRO_ID_PREFIX } from "@api/macroNaming";

/** Put a module in the store the way an earlier macro (or a rename) left it. */
function seed(id: string, name: string): void {
  h.store.set(id, { id, name, description: null, source: "", scope: { type: "workbook" } });
}

beforeEach(() => {
  h.store.clear();
  h.saves.length = 0;
  vi.mocked(saveWorkbookScript).mockClear();
});

describe("createStarterMacro on an empty store", () => {
  it("makes Macro1 as macro-macro1 with the work function macro1", async () => {
    await expect(createStarterMacro()).resolves.toEqual({
      id: "macro-macro1",
      name: "Macro1",
      functionName: "macro1",
    });
  });

  it("saves exactly one record: workbook scope, the starter source, the runtime marker, no sourcePackage", async () => {
    const { parseModuleScriptRuntime } = await vi.importActual<typeof import("@api/workbookScripts")>(
      "@api/workbookScripts",
    );
    await createStarterMacro();

    expect(saveWorkbookScript).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(saveWorkbookScript).mock.calls[0][0];
    expect(saved.id).toBe("macro-macro1");
    expect(saved.name).toBe("Macro1");
    expect(saved.scope).toEqual({ type: "workbook" });
    expect(saved.source).toBe(buildMacroStarterSource("Macro1"));
    expect(parseModuleScriptRuntime(saved.description)).toBe("objectScript");
    // The KEY is absent, not null: this is the user's own code, and a present
    // key is what `saveWorkbookScript` spreads onto the wire.
    expect("sourcePackage" in saved).toBe(false);
    expect(h.store.has("macro-macro1")).toBe(true);
  });

  it("stamps the description with when it was written", async () => {
    await createStarterMacro();
    const saved = vi.mocked(saveWorkbookScript).mock.calls[0][0];
    expect(saved.description).toMatch(/^Macro · runtime=objectScript · written \d{4}-\d{2}-\d{2}T/);
  });
});

describe("the MacroN series", () => {
  it("starts at Macro1", () => {
    expect(nextDefaultMacroName([], [])).toBe("Macro1");
  });

  it("skips a name that is taken in any case", async () => {
    seed("macro-whatever", "macro1");
    await expect(createStarterMacro()).resolves.toEqual({
      id: "macro-macro2",
      name: "Macro2",
      functionName: "macro2",
    });
  });

  it("skips a number whose id is taken under another name", async () => {
    // "Macro1" was renamed to "Totals" and kept its id; a new "Macro1" would
    // otherwise become macro-macro1-2 -- a name and an id that disagree.
    seed("macro-macro1", "Totals");
    await expect(createStarterMacro()).resolves.toEqual({
      id: "macro-macro2",
      name: "Macro2",
      functionName: "macro2",
    });
  });

  it("fills the first gap, not the end of the series", async () => {
    seed("macro-macro1", "Macro1");
    seed("macro-macro3", "Macro3");
    await expect(createStarterMacro()).resolves.toMatchObject({ id: "macro-macro2", name: "Macro2" });
  });
});

describe("a chosen name", () => {
  it("is kept when free, and slugged into the id", async () => {
    await expect(createStarterMacro({ name: "Totals" })).resolves.toEqual({
      id: "macro-totals",
      name: "Totals",
      functionName: "totals",
    });
    const saved = vi.mocked(saveWorkbookScript).mock.calls[0][0];
    expect(saved.source).toBe(buildMacroStarterSource("Totals"));
  });

  it("is suffixed the way the recorder suffixes a recording when it is taken", async () => {
    seed("macro-totals", "Totals");
    await expect(createStarterMacro({ name: "Totals" })).resolves.toEqual({
      id: "macro-totals-2",
      name: "Totals (2)",
      functionName: "totals2",
    });
  });

  it("falls back to the MacroN series when the chosen name is blank", async () => {
    await expect(createStarterMacro({ name: "   " })).resolves.toMatchObject({
      id: "macro-macro1",
      name: "Macro1",
    });
  });

  it("never lands in the reserved namespace", async () => {
    for (const name of ["__calcula_x", "!!!", "Totals", "Macro 12:45"]) {
      const { id } = await createStarterMacro({ name });
      expect(id.startsWith(MACRO_ID_PREFIX)).toBe(true);
      expect(id.startsWith("__calcula_")).toBe(false);
    }
  });
});

describe("a failing save", () => {
  it("rejects and makes nothing", async () => {
    vi.mocked(saveWorkbookScript).mockRejectedValueOnce(new Error("disk"));
    await expect(createStarterMacro()).rejects.toThrow("disk");
    expect(h.store.size).toBe(0);
  });
});
