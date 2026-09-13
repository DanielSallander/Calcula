//! FILENAME: app/extensions/Sorting/lib/__tests__/iconOrderValue.test.ts
// PURPOSE: The Sort dialog's icon choice survives the round trip into
//          `SortField.icon` — BUG-0104's dead half.
// CONTEXT: The backend has implemented sorting by conditional-formatting icon
//          for some time, and `validate_sort_fields` REFUSES an icon level that
//          names no icon ("Choose which icon to bring to the top."). The dialog
//          offered "Conditional Formatting Icon" in its Sort On list and then
//          showed "A to Z" for the order — so it never set an icon, and every
//          such sort was refused with a correct message about a choice the UI
//          never offered. The option was dead for as long as it existed.
//
//          These test the ENCODER and DECODER rather than the component,
//          because the decode is the half that goes wrong silently: a
//          `split("|")` that disagrees with its encoder yields `NaN` or
//          `undefined`, the level carries a malformed icon, and the backend
//          refuses a sort the user really did configure.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  encodeIconOrderValue,
  decodeIconOrderValue,
  iconLabel,
  seedIconChoice,
  seedColorChoice,
  type IconChoice,
} from "../sortHelpers";

const TRAFFIC: IconChoice = { iconSet: "threeTrafficLights1", iconIndex: 2 };

describe("the icon order value round-trips", () => {
  it("carries BOTH halves — an index alone does not identify an icon", () => {
    // BUG-0107: a bare index let a DISABLED rule's glyph family supply the set
    // for another rule's index. `SortField.icon` requires both for that reason,
    // so the dialog's value must carry both too.
    const value = encodeIconOrderValue(TRAFFIC, true);
    expect(value).toContain("threeTrafficLights1");
    expect(value).toContain("2");

    const decoded = decodeIconOrderValue(value);
    expect(decoded.icon).toEqual(TRAFFIC);
    expect(decoded.onTop).toBe(true);
  });

  it("round-trips both directions", () => {
    for (const onTop of [true, false]) {
      const decoded = decodeIconOrderValue(encodeIconOrderValue(TRAFFIC, onTop));
      expect(decoded.icon).toEqual(TRAFFIC);
      expect(decoded.onTop).toBe(onTop);
    }
  });

  it("keeps index 0 — the lowest icon is a real choice, not a missing one", () => {
    // A falsy-index bug here would silently drop the bottom icon of every set,
    // which is exactly the icon a "worst performers on top" sort wants.
    const bottom: IconChoice = { iconSet: "threeArrows", iconIndex: 0 };
    const decoded = decodeIconOrderValue(encodeIconOrderValue(bottom, true));
    expect(decoded.icon).toEqual(bottom);
  });

  it("round-trips every index of a set independently", () => {
    for (const iconIndex of [0, 1, 2, 3, 4]) {
      const ic: IconChoice = { iconSet: "fiveArrows", iconIndex };
      expect(decodeIconOrderValue(encodeIconOrderValue(ic, true)).icon).toEqual(ic);
    }
  });
});

describe("the decoder refuses a malformed value rather than inventing one", () => {
  it("returns no icon for the 'no icons found' placeholder", () => {
    // That placeholder is a REAL option the dropdown renders when nothing in
    // the column shows an icon. Choosing it must leave the level with NO icon,
    // so the backend's refusal names the true reason rather than complaining
    // about an icon set called "".
    const decoded = decodeIconOrderValue("||top");
    expect(decoded.icon).toBeNull();
    expect(decoded.onTop).toBe(true);
  });

  it("returns no icon for a non-numeric index", () => {
    // The failure this prevents is specific: `Number("")` is 0, so a sloppy
    // decode would hand the backend icon 0 of some set and sort by an icon
    // nobody chose — the silent-wrong-answer class this whole bug is about.
    expect(decodeIconOrderValue("threeArrows||top").icon).toBeNull();
    expect(decodeIconOrderValue("threeArrows|abc|top").icon).toBeNull();
    expect(decodeIconOrderValue("threeArrows|1.5|top").icon).toBeNull();
    expect(decodeIconOrderValue("threeArrows|-1|top").icon).toBeNull();
  });

  it("treats anything that is not 'top' as bottom, rather than throwing", () => {
    expect(decodeIconOrderValue("threeArrows|1|bottom").onTop).toBe(false);
    expect(decodeIconOrderValue("threeArrows|1|").onTop).toBe(false);
    expect(decodeIconOrderValue("").onTop).toBe(false);
  });
});

describe("iconLabel", () => {
  it("says WHICH icon of the set, not just the set", () => {
    // A bare set name is ambiguous for every multi-icon set, and the dropdown
    // would show three identical entries.
    expect(iconLabel({ iconSet: "threeTrafficLights1", iconIndex: 0 })).toContain("1");
    expect(iconLabel({ iconSet: "threeTrafficLights1", iconIndex: 2 })).toContain("3");
    expect(iconLabel({ iconSet: "threeTrafficLights1", iconIndex: 0 })).not.toEqual(
      iconLabel({ iconSet: "threeTrafficLights1", iconIndex: 1 }),
    );
  });

  it("is 1-based for the reader — 'icon 0' means nothing to a user", () => {
    expect(iconLabel({ iconSet: "threeArrows", iconIndex: 0 })).toContain("icon 1");
  });
});

// ===========================================================================
// Seeding — the defect that survived this bug's FIRST fix
// ===========================================================================

describe("the level carries what the dropdown shows", () => {
  const RED: IconChoice = { iconSet: "threeTrafficLights1", iconIndex: 0 };
  const GREEN: IconChoice = { iconSet: "threeTrafficLights1", iconIndex: 2 };

  it("seeds the first icon when the level names none", () => {
    // THE LIVE DEFECT. The order `<select>` shows the first icon the moment the
    // list arrives, and a `<select>` fires no change event for an option the
    // user can already see chosen — so `level.icon` stayed `undefined`, the
    // request carried no icon, and `validate_sort_fields` refused the sort
    // with a correct message about a choice the dialog was displaying. That is
    // BUG-0104's own symptom, surviving inside BUG-0104's fix.
    expect(seedIconChoice(undefined, [RED, GREEN])).toEqual(RED);
  });

  it("leaves a level alone when its icon is one the column shows", () => {
    // Returning a value here would fight the user's own pick: the effect writes
    // whatever comes back, so a non-null answer for a valid icon resets the
    // choice to the first entry on every render pass.
    expect(seedIconChoice(GREEN, [RED, GREEN])).toBeNull();
  });

  it("replaces an icon the column no longer shows", () => {
    // The Column dropdown rewrites `columnKey` and leaves `icon` untouched, so
    // a level can hold an icon the NEW column never shows. `<select>` renders
    // blank for a value matching no option, and the sort then keys on an icon
    // zero cells carry: it moves nothing and reports success. Seeding only on
    // ABSENCE misses this entirely.
    const other: IconChoice = { iconSet: "fiveArrows", iconIndex: 4 };
    expect(seedIconChoice(GREEN, [other])).toEqual(other);
  });

  it("distinguishes the same set at a different index", () => {
    // A membership test written on `iconSet` alone would call GREEN present in
    // a list holding only RED — the two halves identify an icon together, which
    // is the whole reason `SortField.icon` carries both (BUG-0107).
    expect(seedIconChoice(GREEN, [RED])).toEqual(RED);
  });

  it("writes nothing while the list is empty", () => {
    // An empty list is what an in-flight fetch looks like. Clearing or
    // rewriting on the way to the answer makes the dropdown flicker between
    // two states, and would clobber a restored level before its column is read.
    expect(seedIconChoice(undefined, [])).toBeNull();
    expect(seedIconChoice(GREEN, [])).toBeNull();
  });

  it("seeds a colour level too, where the failure is SILENT", () => {
    // The colour branch fails differently and worse. A colour level naming no
    // colour reaches the backend's `(Some(a), Some(b), None)` arm, which
    // compares the colour STRINGS — so the sort succeeds and orders by hex code
    // while the dialog says "bring this colour to the top". Nothing refuses and
    // nothing warns.
    expect(seedColorChoice(undefined, ["#ff0000", "#00ff00"])).toBe("#ff0000");
    expect(seedColorChoice("#00ff00", ["#ff0000", "#00ff00"])).toBeNull();
    expect(seedColorChoice("#0000ff", ["#ff0000"])).toBe("#ff0000");
    expect(seedColorChoice(undefined, [])).toBeNull();
  });

  it("matches a colour case-insensitively", () => {
    // The scan and the level can spell the same colour either way, and a
    // case-sensitive compare would reseed a perfectly good choice on every
    // pass — resetting the user's pick to the first colour as they watch.
    expect(seedColorChoice("#FF0000", ["#ff0000", "#00ff00"])).toBeNull();
  });
});

// ===========================================================================
// The WIRING, which the round-trip tests above cannot see
// ===========================================================================

/** A source file with `//` line comments stripped.
 *
 *  NOT decoration: a commented-out line still contains its own spelling, so a
 *  textual guard handed the raw file passes over the very deletion it exists to
 *  catch. This repo has that defect on record one layer over — a `word(` inside
 *  a comment fabricating a call edge in the store census.
 */
function codeOf(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8")
    .split("\n")
    .map((l) => {
      const i = l.indexOf("//");
      return i >= 0 ? l.slice(0, i) : l;
    })
    .join("\n");
}

describe("the dialog's icon choice reaches the backend", () => {
  it("SortDialog maps level.icon into SortField.icon", () => {
    // THE SINGLE LINE THAT CLOSES THE LOOP. Without it every other part of the
    // icon picker is cosmetic: the level carries an icon, the request does not,
    // and `validate_sort_fields` refuses with "names no icon. Choose which icon
    // to bring to the top." — a correct message about a choice the user just
    // made. That is the state the dialog shipped in for as long as the option
    // existed.
    const src = codeOf("extensions/Sorting/components/SortDialog.tsx");
    expect(
      /icon:\s*level\.icon/.test(src),
      "SortDialog no longer forwards the chosen icon to SortField. The Sort On " +
        "dropdown still offers 'Conditional Formatting Icon', so every such " +
        "sort is refused by the backend for naming no icon.",
    ).toBe(true);
  });

  it("the order dropdown gives icon its OWN branch, not the value branch", () => {
    // Icons have no alphabet. Sharing the value branch offered "A to Z" for an
    // icon level and, worse, offered the Custom List optgroup — which the
    // backend refuses outright as "combines a conditional-formatting icon with
    // a custom order".
    const src = codeOf("extensions/Sorting/components/SortLevelRow.tsx");
    expect(
      /level\.sortOn === "icon" \?/.test(src),
      "the icon level shares the value branch again, so it offers A-to-Z and a " +
        "custom list instead of an icon — both refused by the backend.",
    ).toBe(true);
    expect(
      /level\.sortOn === "value" \|\| level\.sortOn === "icon"/.test(src),
      "the value branch has taken the icon level back.",
    ).toBe(false);
  });

  it("switching away from an icon level drops the icon", () => {
    // A stale icon on a value level is not merely untidy: it travels in the
    // request, and the level then means something the user did not choose.
    const src = codeOf("extensions/Sorting/components/SortLevelRow.tsx");
    const handler = src.slice(src.indexOf("handleSortOnChange"));
    expect(
      /icon:\s*undefined/.test(handler.slice(0, 600)),
      "handleSortOnChange no longer clears `icon` when the sort-on type changes.",
    ).toBe(true);
  });

  it("the row SEEDS the level, rather than only displaying a fallback", () => {
    // `seedIconChoice` passing its own unit tests proves nothing about the
    // dialog: the defect was that the component computed a display fallback
    // and never wrote it. Both call sites are pinned — the effect that writes
    // and the display that reads — because an implementation with only the
    // second is exactly the shipped bug.
    const src = codeOf("extensions/Sorting/components/SortLevelRow.tsx");
    expect(
      /updateLevel\([^)]*\{\s*icon:\s*seed\s*\}/.test(src),
      "SortLevelRow no longer WRITES the seeded icon to the level. The order " +
        "dropdown will show an icon the request does not carry, and the " +
        "backend will refuse the sort for naming no icon — BUG-0104 exactly.",
    ).toBe(true);
    expect(
      /seedIconChoice\(level\.icon,\s*uniqueIcons\)\s*\?\?\s*level\.icon/.test(src),
      "the display no longer derives from the same function the effect writes " +
        "with, so it is an independent second opinion again — the arrangement " +
        "that let the dialog look correct while the level stayed empty.",
    ).toBe(true);
    expect(
      /level\.icon\s*\?\?\s*uniqueIcons\[0\]/.test(src),
      "the standalone display fallback is back.",
    ).toBe(false);
  });

  it("every icon-set literal in this file is one the wire can carry", () => {
    // `tsconfig.check.json` EXCLUDES `**/__tests__/**`, and vitest transpiles
    // without type-checking — so nothing in the repo's gates reads the icon-set
    // names in this file. They were written PascalCase ("ThreeArrows") against
    // a camelCase `IconSetType`, mirroring Rust's `#[serde(rename_all =
    // "camelCase")]`: every assertion above passed while exercising a value the
    // backend would reject on arrival. This reads the union from its source and
    // makes that impossible, since tsc will not.
    const api = readFileSync(
      join(process.cwd(), "src/api/backend.ts"),
      "utf8",
    );
    const decl = /export type IconSetType =([\s\S]*?);/.exec(api);
    expect(decl, "IconSetType is no longer declared in src/api/backend.ts").not.toBeNull();
    const known = new Set(
      Array.from(decl![1].matchAll(/"([^"]+)"/g), (m) => m[1]),
    );
    expect(known.size).toBeGreaterThan(10);

    const self = readFileSync(
      join(process.cwd(), "extensions/Sorting/lib/__tests__/iconOrderValue.test.ts"),
      "utf8",
    );
    const used = Array.from(
      self.matchAll(/iconSet:\s*"([^"]*)"/g),
      (m) => m[1],
    );
    expect(used.length).toBeGreaterThan(3);
    for (const name of used) {
      expect(
        known.has(name),
        `"${name}" is not a member of IconSetType. The Rust enum is renamed ` +
          `camelCase, so this value cannot survive the wire — and no gate in ` +
          `this repo type-checks a test file.`,
      ).toBe(true);
    }
  });

  it("the picker asks the ONE evaluator the sort keys on", () => {
    // `evaluateConditionalFormats` returns one result per MATCHING RULE in
    // STORAGE order; `resolve_icons` — which the sort and the filter key on —
    // sorts by PRIORITY and takes the first icon-producing rule. A picker built
    // on the former can offer an icon no cell shows, and choosing it produces a
    // sort that matches zero rows, moves nothing, and reports success: this
    // bug's own defect class, one layer up in its fix.
    const src = codeOf("extensions/Sorting/lib/sortHelpers.ts");
    expect(src).toContain("getRangeIcons");
    expect(
      src.includes("evaluateConditionalFormats"),
      "the icon picker is deriving icons from the per-rule evaluation again, " +
        "which can list icons resolve_icons will never return.",
    ).toBe(false);
  });
});
