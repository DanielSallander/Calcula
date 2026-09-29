//! FILENAME: app/src/core/components/Spreadsheet/__tests__/activeSheetViewPrimed.test.ts
// PURPOSE: The active-sheet view hydration applies the switch's PRIMED view
//          state in the switch's own flush (a layout effect, before paint), so
//          a tab click from a canvas to a worksheet shows the worksheet's own
//          headings, gridlines and zoom in the first frame (open-items 2.af,
//          "One-frame flash on a tab click from a canvas to a worksheet").
// CONTEXT: SOURCE-TEXT assertions, the precedent of
//          activeSheetViewHydration.test.ts: mounting Spreadsheet needs the
//          whole Core provider tree; the rule under test is WHERE and HOW the
//          primed view is applied. The prime itself (what is read, the slot's
//          one-take / right-sheet / age rules) is proved behaviourally in
//          core/lib/__tests__/sheetSwitchViewPrime.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "../Spreadsheet.tsx"), "utf8");
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function hydrationEffect(): string {
  const at = CODE.indexOf("const viewHydratedOnceRef");
  expect(at, "the active-sheet hydration effect is gone").toBeGreaterThan(-1);
  return CODE.slice(at, CODE.indexOf("}, [", at) + 200);
}

describe("the primed view is applied in the switch's own flush", () => {
  it("the hydration runs in a LAYOUT effect (before the browser paints)", () => {
    const effect = hydrationEffect();
    expect(effect, "a passive effect runs after paint: the first frame keeps the canvas's view").toMatch(
      /^const viewHydratedOnceRef = useRef\(false\);\s*useLayoutEffect\(\(\) => \{/,
    );
  });

  it("takes the view primed for THIS sheet first, synchronously", () => {
    const effect = hydrationEffect();
    const take = effect.indexOf("takePrefetchedSheetView(activeSheetIndexForView)");
    expect(take, "the effect never takes the primed view").toBeGreaterThan(-1);
    // Before any async read of the view.
    const firstAsync = effect.search(/invoke<boolean>\("get_show_gridlines"\)|void hydrateSheetView\(\)/);
    expect(firstAsync).toBeGreaterThan(take);
  });

  it("applies the primed view through the SAME appliers as the async hydration", () => {
    const effect = hydrationEffect();
    expect(effect).toContain("applySheetView(primed.view)");
    expect(effect).toContain("applySheetDisplayFlags(primed.flags)");
    expect(effect).toContain("dispatch(setDisplayGridlines(primed.showGridlines))");
    // And the async path is those appliers over a fresh read -- one recipe.
    expect(CODE).toMatch(/applySheetView\(await loadSheetViewState\(\)\)/);
    expect(CODE).toMatch(/applySheetDisplayFlags\(await loadSheetDisplayFlags\(\)\)/);
  });

  it("a route that did not prime still hydrates (no payload -> the async reads)", () => {
    const effect = hydrationEffect();
    expect(effect).toContain("if (primed) return;");
    const guard = effect.indexOf("if (primed) return;");
    expect(effect.indexOf("void hydrateSheetView()", guard)).toBeGreaterThan(guard);
    expect(effect.indexOf("void hydrateSheetDisplayFlags()", guard)).toBeGreaterThan(guard);
  });
});
