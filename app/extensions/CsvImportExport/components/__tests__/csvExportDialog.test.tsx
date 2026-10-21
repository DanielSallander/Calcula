//! FILENAME: app/extensions/CsvImportExport/components/__tests__/csvExportDialog.test.tsx
// PURPOSE: P2 S10 -- the CSV export dialog's default delimiter is the APP
//          locale's list separator: ";" in de-DE (where "1,5" is a number and a
//          comma delimiter would split it), "," in en-US. It used to be a
//          hard-coded ",".

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("@api", () => ({
  getViewportCells: vi.fn(async () => []),
  showToast: vi.fn(),
  restoreFocusToGrid: vi.fn(),
}));
vi.mock("@api/lib", () => ({ getGridBounds: vi.fn(async () => [0, 0]) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(async () => null) }));
vi.mock("../../lib/csvBackend", () => ({ csvBackend: {} }));

import { CsvExportDialog } from "../CsvExportDialog";
import { useAppLocale, useInvariantLocale } from "../../../Charts/lib/__tests__/appLocaleTestKit";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  await useInvariantLocale();
});

function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<CsvExportDialog isOpen onClose={() => {}} />));
}

/** The select under the "Delimiter" label (the dialog's first select). */
function delimiterSelect(): HTMLSelectElement {
  const label = Array.from(container!.querySelectorAll("div")).find((d) => d.textContent === "Delimiter");
  const select = label?.parentElement?.querySelector("select");
  if (!select) throw new Error("no delimiter select");
  return select as HTMLSelectElement;
}

describe("CsvExportDialog default delimiter", () => {
  it('de-DE defaults to ";"', async () => {
    await useAppLocale("de-DE");
    mount();
    expect(delimiterSelect().value).toBe(";");
  });

  it('en-US defaults to ","', async () => {
    await useAppLocale("en-US");
    mount();
    expect(delimiterSelect().value).toBe(",");
  });
});
