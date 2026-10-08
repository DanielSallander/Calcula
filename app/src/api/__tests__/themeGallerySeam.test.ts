//! FILENAME: app/src/api/__tests__/themeGallerySeam.test.ts
// PURPOSE: The theme-gallery seam (@api/themeGallery): ONE registered gallery
//          that any ribbon tab can host without importing its owner.
// CONTEXT: Review finding (2026-10-08): the seam used to BE a menu-bar item
//          (Format > Themes), so the seam could not exist without adding a
//          non-Excel entry to the Format menu -- the product changed as a side
//          effect of a plumbing choice. It is now a provider registry of its
//          own (the controlsService pattern): register, last wins, a stale
//          release removes nothing, and hosts re-render on every change.

import { describe, it, expect, afterEach } from "vitest";
import {
  getThemeGallery,
  registerThemeGallery,
  subscribeThemeGallery,
  type ThemeGalleryProvider,
} from "../themeGallery";

const releases: Array<() => void> = [];

function provider(name: string): ThemeGalleryProvider {
  return { heading: name, render: () => name };
}

afterEach(() => {
  while (releases.length) releases.pop()!();
});

describe("@api/themeGallery", () => {
  it("is empty until an owner registers, and empty again after it releases", () => {
    expect(getThemeGallery()).toBeNull();
    const p = provider("A");
    const release = registerThemeGallery(p);
    expect(getThemeGallery()).toBe(p);
    release();
    expect(getThemeGallery()).toBeNull();
  });

  it("last registration wins; a STALE release removes nothing", () => {
    const a = provider("A");
    const b = provider("B");
    const releaseA = registerThemeGallery(a);
    releases.push(registerThemeGallery(b));
    expect(getThemeGallery()).toBe(b);
    releaseA();
    expect(getThemeGallery()).toBe(b);
  });

  it("tells subscribers on every change, and stops when unsubscribed", () => {
    let calls = 0;
    const unsubscribe = subscribeThemeGallery(() => {
      calls += 1;
    });
    const release = registerThemeGallery(provider("A"));
    release();
    expect(calls).toBe(2);
    unsubscribe();
    releases.push(registerThemeGallery(provider("B")));
    expect(calls).toBe(2);
  });

  it("is not a menu-bar item: the seam no longer names one", async () => {
    const seam = await import("../themeGallery");
    expect(Object.keys(seam)).not.toContain("DOCUMENT_THEME_MENU_ID");
    expect(Object.keys(seam)).not.toContain("DOCUMENT_THEME_MENU_ITEM_ID");
  });
});
