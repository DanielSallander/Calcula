//! FILENAME: app/src/api/scriptHost/scriptPreview/__tests__/objectHooks.test.ts
// PURPOSE: Every drafted object type's hooks come out of the generated surface
//          COMPLETE — so no object silently loses its handlers from the preview.
// CONTEXT: docs/design/local-model-script-authoring.md §5c.1.
//
//          THE HISTORY THIS GUARD CARRIES. The first version of this file
//          asserted a naming CONVENTION and a hand-written no-context list —
//          and the adversarial review confirmed both halves wrong at once: the
//          generated surface was chain-DEDUPED across interfaces, so slicer,
//          table, timeline and row read as hookless while the worker really
//          registers their hooks, and the "row has no context" entry ENSHRINED
//          that defect instead of catching it. A row draft whose onInsert
//          handler threw graded clean. The mapping is now the probe's own
//          emitted table (`OBJECT_TYPE_CONTEXTS`) and the per-type hook lists
//          below are pinned against what the worker shim actually registers —
//          the collapse cannot return without redding one of them.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SCRIPTABLE_OBJECT_TYPES } from "../../../scriptableObjects";
import { OBJECT_TYPE_CONTEXTS, SCRIPT_SURFACE } from "../../generated/scriptSurfacePolicy";
import { contextInterfaceFor, objectHooksFor } from "../objectHooks";

describe("the type -> context mapping is the probe's, not a naming guess", () => {
  it("covers every drafted object type", () => {
    const mapped = new Set(OBJECT_TYPE_CONTEXTS.map(([t]) => t));
    for (const t of SCRIPTABLE_OBJECT_TYPES) {
      expect(mapped.has(t), `${t} has no entry in the generated OBJECT_TYPE_CONTEXTS`).toBe(true);
    }
  });

  it("maps textbox to BaseObjectContext — the case the naming convention got wrong", () => {
    // buildTyped's `default` branch hands textbox the base context; the old
    // convention derived "TextboxContext", found nothing, and classified it as
    // hookless for the WRONG reason. Now it is hookless for the RIGHT one.
    expect(contextInterfaceFor("textbox")).toBe("BaseObjectContext");
  });

  it("resolves every mapped interface to real surface rows", () => {
    const ifaces = new Set(SCRIPT_SURFACE.map((m) => m.iface));
    for (const [t, iface] of OBJECT_TYPE_CONTEXTS) {
      expect(ifaces.has(iface), `${t} maps to ${iface}, which has no rows in the surface`).toBe(true);
    }
  });
});

describe("the per-type hooks the dedup used to swallow", () => {
  /**
   * Pinned VALUES, not just non-emptiness: these are what `contextShims.ts`'s
   * own `case "<type>":` branches register, and they are exactly the lists the
   * chain-dedup collapsed to [] (each hook survived only under the
   * alphabetically first interface carrying it). A regression in the
   * generator's dedup key reds a named type here, not a count somewhere.
   */
  it.each([
    ["button", ["onClick"]],
    ["slicer", ["onSelectionChange"]],
    ["table", ["onDataChange"]],
    ["timeline", ["onChange"]],
    ["row", ["onDelete", "onInsert", "onResize"]],
    ["column", ["onDelete", "onInsert", "onResize"]],
  ] as const)("%s fires %j", (objectType, hooks) => {
    expect(objectHooksFor(objectType).sort()).toEqual([...hooks]);
  });

  it("keeps sheet's multi-hook list intact, onDataChange included", () => {
    const sheet = objectHooksFor("sheet");
    expect(sheet).toContain("onSelectionChange");
    expect(sheet, "onDataChange was one of the swallowed members").toContain("onDataChange");
    expect(sheet.length).toBeGreaterThan(2);
  });

  it("returns nothing — rather than throwing — for a type with no hooks", () => {
    expect(objectHooksFor("textbox")).toEqual([]);
    expect(objectHooksFor("not-a-real-object")).toEqual([]);
  });

  it("only ever reports registration hooks, never ordinary members", () => {
    for (const objectType of SCRIPTABLE_OBJECT_TYPES) {
      for (const hook of objectHooksFor(objectType)) {
        expect(hook, `${objectType}.${hook} is not a hook name`).toMatch(/^on[A-Z]/);
      }
    }
  });
});

describe("the generator's dedup key keeps the interface", () => {
  it("carries shared hook chains under EVERY owning interface", () => {
    // The defect's fingerprint was 'every on* chain appears under exactly one
    // iface'. Pin its absence via the known-shared members.
    const owners = (chain: string) =>
      SCRIPT_SURFACE.filter((m) => m.chain === chain).map((m) => m.iface).sort();
    expect(owners("onSelectionChange")).toEqual(["SheetContext", "SlicerContext"]);
    expect(owners("onDataChange")).toEqual(["ChartContext", "SheetContext", "TableContext"]);
    expect(owners("onClick")).toContain("ButtonContext");
    expect(owners("onClick").length).toBeGreaterThan(1);
  });

  it("is pinned in the GENERATOR source, where the regression would happen", () => {
    // The runtime facts above would also red, but this names the line to fix.
    const gen = readFileSync(
      resolve(__dirname, "../../../../../scripts/scriptTypings/generateObjectContexts.ts"),
      "utf8",
    );
    expect(gen).toMatch(/const key = `\$\{ifaceName\} \$\{chain\}/);
  });
});
