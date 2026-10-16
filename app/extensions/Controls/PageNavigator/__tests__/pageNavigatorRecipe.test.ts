//! FILENAME: app/extensions/Controls/PageNavigator/__tests__/pageNavigatorRecipe.test.ts
// PURPOSE: ONE defaults table (WP-B S5). The recipe a navigator is created
//          with, the Properties rows' defaults and the reader's fallbacks must
//          all be the same values -- the "copied recipe drifts" guard.

import { describe, it, expect } from "vitest";
import { PAGE_NAVIGATOR_DEFAULT_SIZE } from "@api/buttonControlService";
import { isBindablePath } from "@api/objectBindings";
import { PAGE_NAVIGATOR_DEFAULTS, pageNavigatorRecipe } from "../pageNavigatorRecipe";
import { PAGE_NAVIGATOR_PROPERTIES } from "../pageNavigatorProperties";

const RECT = { x: 12, y: 34, width: 472, height: 32 };

describe("pageNavigatorRecipe", () => {
  const recipe = pageNavigatorRecipe(RECT, "vertical");

  it("writes exactly 18 keys, every value a string", () => {
    expect(Object.keys(recipe).sort()).toEqual(
      [
        ...Object.keys(PAGE_NAVIGATOR_DEFAULTS),
        "embedded",
        "pinToGrid",
        "x",
        "y",
        "width",
        "height",
      ].sort(),
    );
    expect(Object.keys(recipe)).toHaveLength(18);
    for (const [k, v] of Object.entries(recipe)) expect(typeof v, k).toBe("string");
  });

  it("writes embedded and pinToGrid as the STRING \"false\" (an absent pinToGrid means 'moves')", () => {
    expect(recipe.embedded).toBe("false");
    expect(recipe.pinToGrid).toBe("false");
  });

  it("carries no code slot, no caption and no target", () => {
    for (const key of ["onSelect", "macroRef", "text", "tooltip", "action", "actionTarget", "actionTargetName"]) {
      expect(recipe, key).not.toHaveProperty(key);
    }
  });

  it("takes geometry from the rect and the orientation asked for", () => {
    expect(recipe).toMatchObject({ x: "12", y: "34", width: "472", height: "32", orientation: "vertical" });
  });

  it("every non-geometry value equals the defaults table", () => {
    const horizontal = pageNavigatorRecipe(RECT, "horizontal");
    for (const [key, value] of Object.entries(PAGE_NAVIGATOR_DEFAULTS)) {
      expect(horizontal[key], key).toBe(value);
    }
  });
});

describe("PAGE_NAVIGATOR_PROPERTIES read their defaults from the one table", () => {
  it("each row's defaultValue equals PAGE_NAVIGATOR_DEFAULTS or the seam's default size", () => {
    const defaults = PAGE_NAVIGATOR_DEFAULTS as Readonly<Record<string, string>>;
    for (const row of PAGE_NAVIGATOR_PROPERTIES) {
      if (row.key === "width") {
        expect(row.defaultValue).toBe(String(PAGE_NAVIGATOR_DEFAULT_SIZE.width));
      } else if (row.key === "height") {
        expect(row.defaultValue).toBe(String(PAGE_NAVIGATOR_DEFAULT_SIZE.height));
      } else {
        expect(defaults, row.key).toHaveProperty(row.key);
        expect(row.defaultValue, row.key).toBe(defaults[row.key]);
      }
    }
  });

  it("has the 13 rows of the spec, none named after the overrides, none in a 'Buttons' group", () => {
    expect(PAGE_NAVIGATOR_PROPERTIES.map((r) => r.key)).toEqual([
      "orientation",
      "gap",
      "padding",
      "fill",
      "color",
      "borderColor",
      "fontSize",
      "selectedFill",
      "selectedColor",
      "showHiddenPages",
      "showTooltipPages",
      "width",
      "height",
    ]);
    expect(PAGE_NAVIGATOR_PROPERTIES.some((r) => r.group === "Buttons")).toBe(false);
  });

  it("every row offers fx (WP-D S8d): each key has a row in the binding catalog", () => {
    expect(PAGE_NAVIGATOR_PROPERTIES.every((r) => r.supportsFormula === true)).toBe(true);
    for (const row of PAGE_NAVIGATOR_PROPERTIES) {
      expect(isBindablePath("control", `/properties/${row.key}`), row.key).not.toBeNull();
    }
  });

  it("orientation is a menu of the seam's orientations", () => {
    const row = PAGE_NAVIGATOR_PROPERTIES.find((r) => r.key === "orientation");
    expect(row?.inputType).toBe("select");
    expect(row?.options?.map((o) => o.value)).toEqual(["horizontal", "vertical"]);
  });
});
