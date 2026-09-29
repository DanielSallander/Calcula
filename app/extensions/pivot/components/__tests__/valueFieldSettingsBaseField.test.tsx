//! FILENAME: app/extensions/Pivot/components/__tests__/valueFieldSettingsBaseField.test.tsx
// PURPOSE: Show Values As can be set through the Value Field Settings dialog.
//          Found live 2026-09-29 (e2e fixall-pivot X1): the dialog showed its
//          Base field select only when handed fields, and its one caller
//          (PivotEditor) handed it none -- so Running Total In, Difference From
//          and % Of could not be configured through the dialog at all. Also:
//          the dialog is mounted already open, so its reset-on-open block never
//          ran, and a field that showed Running Total In reopened on "Normal".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as fs from "fs";
import * as path from "path";

vi.mock("@api/dialogWindow", () => ({
  useDialogWindow: () => ({ ref: { current: null }, style: {}, onHeaderMouseDown: () => undefined, resizeHandles: null }),
}));

import { ValueFieldSettingsModal } from "../ValueFieldSettingsModal";
import { baseFieldNames, useBaseFieldChoices, type BaseFieldChoice } from "../baseFieldChoices";
import type { ZoneField } from "../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const zone = (sourceIndex: number, name: string, extra: Partial<ZoneField> = {}): ZoneField => ({ sourceIndex, name, isNumeric: false, ...extra });
const SALES = { ...zone(2, "Sales"), isNumeric: true, aggregation: "sum" as const };
const REGION: BaseFieldChoice = { name: "Region", items: ["North", "South"] };

function selectLabelled(label: string): HTMLSelectElement | null {
  // The dialog renders through a PORTAL on document.body.
  for (const l of Array.from(document.querySelectorAll("label"))) {
    if (l.textContent === label) return l.parentElement?.querySelector("select") ?? null;
  }
  return null;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("the Value Field Settings dialog's Base field", () => {
  it("offers the pivot's fields for Running Total In, and saves the base it shows", async () => {
    const onSave = vi.fn();
    act(() => {
      root.render(
        <ValueFieldSettingsModal isOpen field={SALES} availableFields={[REGION]} onSave={onSave} onCancel={() => {}} />,
      );
    });
    const showAs = selectLabelled("Show Values As")!;
    act(() => {
      showAs.value = "running_total";
      showAs.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const base = selectLabelled("Base field");
    expect(base, "no Base field select for Running Total In").not.toBeNull();
    expect(base!.value).toBe("Region");
    const ok = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "OK")!;
    act(() => ok.click());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ showValuesAs: "running_total", baseField: "Region" }));
  });

  it("offers (previous) for Difference From even with no items (a data-model pivot)", () => {
    act(() => {
      root.render(
        <ValueFieldSettingsModal
          isOpen
          field={{ ...SALES, showValuesAs: "difference" }}
          availableFields={[{ name: "Region", items: [] }]}
          onSave={() => {}}
          onCancel={() => {}}
        />,
      );
    });
    const item = selectLabelled("Base item");
    expect(item, "no Base item select without items").not.toBeNull();
    expect(Array.from(item!.options).map((o) => o.value)).toContain("(previous)");
  });

  it("opens on the field's OWN Show Values As and base, not on Normal", () => {
    act(() => {
      root.render(
        <ValueFieldSettingsModal
          isOpen
          field={{ ...SALES, showValuesAs: "running_total", baseField: "Region" }}
          availableFields={[{ name: "Product", items: [] }, REGION]}
          onSave={() => {}}
          onCancel={() => {}}
        />,
      );
    });
    expect(selectLabelled("Show Values As")!.value).toBe("running_total");
    expect(selectLabelled("Base field")!.value).toBe("Region");
  });
});

describe("the choices PivotEditor hands the dialog", () => {
  it("are the row then column fields, each once, never a lookup column", () => {
    const names = baseFieldNames(
      [zone(0, "Region"), zone(3, "Attr", { isLookup: true })],
      [zone(1, "Product"), zone(0, "Region")],
    ).map((f) => f.name);
    expect(names).toEqual(["Region", "Product"]);
  });

  it("read each field's items while the dialog is open", async () => {
    let out: BaseFieldChoice[] = [];
    const readItems = vi.fn(async (i: number) => (i === 0 ? ["North", "South"] : ["Apples"]));
    // STABLE zones, as PivotEditor's state is between renders.
    const rows = [zone(0, "Region")];
    const columns = [zone(1, "Product")];
    function Probe({ open }: { open: boolean }): null {
      out = useBaseFieldChoices(open, rows, columns, readItems);
      return null;
    }
    act(() => root.render(<Probe open={false} />));
    await settle();
    expect(readItems).not.toHaveBeenCalled();
    expect(out).toEqual([{ name: "Region", items: [] }, { name: "Product", items: [] }]);
    act(() => root.render(<Probe open />));
    await settle();
    expect(out).toEqual([{ name: "Region", items: ["North", "South"] }, { name: "Product", items: ["Apples"] }]);
  });

  it("PivotEditor passes them (the dialog got none, so Base field never showed)", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../PivotEditor.tsx"), "utf8");
    const at = src.indexOf("<ValueFieldSettingsModal");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, src.indexOf("/>", at))).toContain("availableFields={baseFieldChoices}");
  });
});
