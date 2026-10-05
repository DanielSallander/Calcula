//! FILENAME: app/extensions/Table/components/__tests__/tableStylesExcelSet.test.tsx
// PURPOSE: The table-style galleries offer EXCEL'S set, and a table that wears
//          a style outside it still shows -- and still paints -- that style.
// CONTEXT: The catalogue generates Light 1-28, Medium 1-28 and Dark 1-21 (77
//          styles), and both galleries offered all of them. Excel (read live,
//          2026-10-04) offers Light 1-21, Medium 1-28 and Dark 1-11: 60. The
//          extra 17 are KEPT in the catalogue -- a workbook saved while they
//          were offered stores e.g. "TableStyleLight25", and that table must
//          keep its paint (the interceptor resolves the stored name through
//          TABLE_STYLES_BY_ID) and its highlight in Table Design -- they are
//          simply no longer OFFERED to a table that does not wear one.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SurfaceLayoutProvider, panelLayout } from "@api/layout";
import { TableStylesGallery } from "../TableStylesGallery";
import {
  EXCEL_TABLE_STYLES,
  TABLE_STYLES,
  TABLE_STYLES_BY_ID,
  isExcelGalleryStyle,
  tableStyleIdForName,
} from "../../lib/tableStyles";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

function options(): string[] {
  return Array.from(document.querySelectorAll("[role='option']")).map((el) => el.getAttribute("aria-label") ?? "");
}

function renderGallery(selectedStyleId: string | null): void {
  act(() => {
    root.render(
      <SurfaceLayoutProvider value={panelLayout(0)}>
        <TableStylesGallery selectedStyleId={selectedStyleId} onStyleSelect={vi.fn()} onStyleClear={vi.fn()} />
      </SurfaceLayoutProvider>,
    );
  });
}

describe("Excel's set [LIVE 2026-10-04]", () => {
  it("is Light 1-21, Medium 1-28, Dark 1-11, in gallery order", () => {
    const names = EXCEL_TABLE_STYLES.map((s) => s.id);
    expect(names).toHaveLength(60);
    expect(names.slice(0, 21)).toEqual(Array.from({ length: 21 }, (_, i) => `table-light-${i + 1}`));
    expect(names.slice(21, 49)).toEqual(Array.from({ length: 28 }, (_, i) => `table-medium-${i + 1}`));
    expect(names.slice(49)).toEqual(Array.from({ length: 11 }, (_, i) => `table-dark-${i + 1}`));
  });

  it("the catalogue still holds every style a saved table may wear", () => {
    expect(TABLE_STYLES).toHaveLength(77);
    expect(isExcelGalleryStyle(TABLE_STYLES_BY_ID.get("table-light-25")!)).toBe(false);
    expect(isExcelGalleryStyle(TABLE_STYLES_BY_ID.get("table-dark-11")!)).toBe(true);
    expect(tableStyleIdForName("TableStyleLight25")).toBe("table-light-25");
    expect(tableStyleIdForName("TableStyleDark15")).toBe("table-dark-15");
  });
});

describe("Table Design's gallery", () => {
  it("offers None and Excel's 60, nothing else, for a table wearing an Excel style", () => {
    renderGallery("table-medium-2");
    const names = options();
    expect(names).toHaveLength(61);
    expect(names[0]).toBe("None");
    expect(names).not.toContain("Light 22");
    expect(names).not.toContain("Dark 12");
  });

  it("a table wearing a style outside Excel's set still finds it, selected, in its own group", () => {
    renderGallery("table-light-25");
    const names = options();
    expect(names).toHaveLength(62);
    // It closes the Light group: after Light 21, before Medium 1.
    expect(names.indexOf("Light 25")).toBe(names.indexOf("Light 21") + 1);
    expect(names.indexOf("Medium 1")).toBe(names.indexOf("Light 25") + 1);
    const selected = document.querySelector("[role='option'][aria-selected='true']");
    expect(selected?.getAttribute("aria-label")).toBe("Light 25");
  });
});
