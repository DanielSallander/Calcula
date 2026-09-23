//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/homeTabIcons.test.tsx
// PURPOSE: The Home tab's icon audit, as a property: every catalog command
//          resolves to a drawing in the one duotone set, except the ones the
//          design keeps typographic on purpose; group launcher glyphs are
//          drawn at the launcher's 24px; the glyph-id vocabulary a saved
//          layout can name only grows.

import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The real icon set, without the @api barrel (which reaches every extension).
vi.mock("@api", async () => {
  const icons = await import("@api/ribbonIcons");
  return { RibbonIcon: icons.RibbonIcon };
});

import { LAUNCHER_ICON_SIZE } from "@api/layout";
import { ALL_ITEMS, ITEMS_BY_ID, DEFAULT_LAYOUT } from "../homeTabConfig";
import {
  homeTabIcon,
  groupIcon,
  groupIconFor,
  GROUP_ICON_IDS,
  GROUP_ICON_FALLBACK_ID,
  TYPOGRAPHIC_ITEM_IDS,
  HomeTabCustomizeIcon,
} from "../components/homeTabIcons";

function markup(node: React.ReactNode): string {
  return renderToStaticMarkup(<>{node}</>);
}

describe("item icons", () => {
  it("every catalog command resolves to a drawing, except the typographic ones", () => {
    const missing = ALL_ITEMS.filter(
      (item) => !TYPOGRAPHIC_ITEM_IDS.has(item.id) && homeTabIcon(item.id, 20) === null,
    ).map((item) => item.id);
    expect(missing).toEqual([]);
  });

  it("keeps exactly the approved letters typographic, each with its text", () => {
    expect([...TYPOGRAPHIC_ITEM_IDS].sort()).toEqual(
      [
        "bold",
        "italic",
        "underline",
        "strikethrough",
        "superscript",
        "subscript",
        "percentFormat",
        "commaFormat",
        "increaseDecimal",
        "decreaseDecimal",
      ].sort(),
    );
    for (const id of TYPOGRAPHIC_ITEM_IDS) {
      expect(homeTabIcon(id, 20), id).toBeNull();
      expect(ITEMS_BY_ID.get(id)?.icon, `${id} has a text glyph`).toBeTruthy();
    }
  });

  it("draws every icon as an SVG at the size asked, painted with tokens only", () => {
    for (const item of ALL_ITEMS) {
      const icon = homeTabIcon(item.id, 20);
      if (icon === null) continue;
      const html = markup(icon);
      expect(html, item.id).toMatch(/^<svg[^>]*width="20"/);
      expect(html, `${item.id} carries a colour literal`).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    }
  });

  it("Align Left and Align Right are no longer the same glyph", () => {
    const left = ITEMS_BY_ID.get("alignLeft")!;
    const right = ITEMS_BY_ID.get("alignRight")!;
    expect(left.icon).not.toBe(right.icon);
    expect(markup(homeTabIcon("alignLeft", 20))).not.toBe(markup(homeTabIcon("alignRight", 20)));
  });
});

describe("group launcher glyphs", () => {
  it("every default group draws its own glyph at the launcher's 24px", () => {
    expect(LAUNCHER_ICON_SIZE).toBe(24);
    for (const group of DEFAULT_LAYOUT.groups) {
      const html = markup(groupIconFor(group));
      expect(html, group.id).toMatch(/^<svg[^>]*width="24"/);
    }
  });

  it("the glyph-id vocabulary only grows: every id a saved layout could name still resolves", () => {
    // The ids this list offered before the Clusters redesign. A saved layout
    // stores one of them in `iconId`; losing one would silently turn that
    // user's launcher into the fallback.
    const HISTORICAL = [
      "alignment",
      "cells",
      "clipboard",
      "deleteRow",
      "editing",
      "fill",
      "font",
      "format",
      "insertColumn",
      "merge",
      "number",
      "percent",
      "styles",
      "undo",
      "wrap",
    ];
    for (const id of HISTORICAL) {
      expect(GROUP_ICON_IDS, id).toContain(id);
      expect(groupIcon(id), id).not.toBeNull();
    }
    expect(GROUP_ICON_IDS).toContain(GROUP_ICON_FALLBACK_ID);
  });

  it("an unknown id falls back instead of rendering nothing", () => {
    expect(markup(groupIconFor({ id: "my-own", iconId: "gone" }))).toBe(
      markup(groupIcon(GROUP_ICON_FALLBACK_ID)),
    );
  });

  it("the Customize menu entry uses the set's own gear", () => {
    expect(markup(<HomeTabCustomizeIcon size={14} />)).toMatch(/^<svg[^>]*width="14"/);
  });
});
