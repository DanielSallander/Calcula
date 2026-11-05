//! FILENAME: app/src/api/__tests__/themeCachePerDocument.test.ts
// PURPOSE: @api/theme's cache is per DOCUMENT and is dropped at the API layer,
//          for every consumer, when another document opens or a new one starts
//          and when the theme changes by any route.
// CONTEXT: `clearThemeCache` had no caller but the Home tab's colour button, so
//          the colour pickers' palette and Format Cells' font list kept the
//          PREVIOUS file's theme after File > Open. Only Tauri's `invoke` is
//          doubled; the module under test is real.

import { describe, it, expect, beforeEach, vi } from "vitest";

let backendTheme = "Office";
let backendPalette = "office-palette";
const invoked: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    invoked.push(cmd);
    if (cmd === "get_document_theme") return Promise.resolve({ name: backendTheme });
    if (cmd === "get_theme_color_palette") return Promise.resolve([{ hex: backendPalette }]);
    return Promise.resolve(null);
  },
}));

import { clearThemeCache, getCachedTheme, getDocumentTheme, getThemeColorPalette } from "../theme";
import { AppEvents, emitAppEvent } from "../events";

beforeEach(() => {
  clearThemeCache();
  backendTheme = "Office";
  backendPalette = "office-palette";
  invoked.length = 0;
});

async function primeWithOffice(): Promise<void> {
  expect(((await getDocumentTheme()) as unknown as { name: string }).name).toBe("Office");
  expect(((await getThemeColorPalette()) as unknown as { hex: string }[])[0].hex).toBe("office-palette");
}

describe("the theme cache follows the document", () => {
  for (const [label, event] of [
    ["File > Open (AFTER_OPEN)", AppEvents.AFTER_OPEN],
    ["File > New (AFTER_NEW)", AppEvents.AFTER_NEW],
  ] as const) {
    it(`${label}: the next read is the NEW document's theme and palette`, async () => {
      await primeWithOffice();
      backendTheme = "Slate";
      backendPalette = "slate-palette";
      emitAppEvent(event);
      expect(((await getDocumentTheme()) as unknown as { name: string }).name, "a stale theme survived").toBe("Slate");
      expect(((await getThemeColorPalette()) as unknown as { hex: string }[])[0].hex, "a stale palette survived").toBe(
        "slate-palette",
      );
    });
  }

  it("a consumer re-reading on the same event already reads the new palette", async () => {
    await primeWithOffice();
    backendPalette = "slate-palette";
    let seen: string | null = null;
    const off = (): void => window.removeEventListener(AppEvents.AFTER_OPEN, onOpen);
    const onOpen = (): void => {
      void getThemeColorPalette().then((p) => {
        seen = (p as unknown as { hex: string }[])[0].hex;
      });
    };
    window.addEventListener(AppEvents.AFTER_OPEN, onOpen);
    emitAppEvent(AppEvents.AFTER_OPEN);
    await new Promise((r) => setTimeout(r, 0));
    off();
    expect(seen).toBe("slate-palette");
  });

  it("THEME_CHANGED from any route drops the palette and keeps the named theme for sync readers", async () => {
    await primeWithOffice();
    backendPalette = "slate-palette";
    emitAppEvent(AppEvents.THEME_CHANGED, { theme: { name: "Slate" } });
    expect((getCachedTheme() as unknown as { name: string } | null)?.name).toBe("Slate");
    expect(((await getThemeColorPalette()) as unknown as { hex: string }[])[0].hex).toBe("slate-palette");
  });

  it("positive control: with no document event the cache answers without asking the backend", async () => {
    await primeWithOffice();
    invoked.length = 0;
    await getDocumentTheme();
    await getThemeColorPalette();
    expect(invoked).toEqual([]);
  });
});
