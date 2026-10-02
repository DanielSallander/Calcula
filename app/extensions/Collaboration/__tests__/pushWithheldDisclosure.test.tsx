//! FILENAME: app/extensions/Collaboration/__tests__/pushWithheldDisclosure.test.tsx
// PURPOSE: The push report NAMES what a push leaves in the workbook because it
//          is not the application's (BUG-0261), and the Publish dialog shows
//          that list before anything is pushed.
// CONTEXT: A working-copy push re-published other applications' object scripts
//          and the merged Custom Functions library under the developer's key.
//          The backend now withholds them (app/src-tauri/src/calp_push_scope.rs,
//          behaviour-tested there) and returns each item in
//          `PublishReport.withheld`. The private scripts, notebooks and names
//          the older filter withheld used to reach ONLY the log -- a silent
//          drop to the person pushing -- and the report said "Nothing in this
//          workbook is left out." while leaving them out.
//
//          Pinned here:
//            * the report view names every item, grouped by WHY (another
//              application's code vs your own the application never had);
//            * "nothing is left out" is said only when nothing was;
//            * the dialog shows the list from the preview it runs on open, not
//              only after a manual Preview;
//            * the TypeScript labels cover exactly the Rust enum's variants
//              (Rust -> TypeScript, never the reverse).

import fs from "fs";
import path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PublishReport, WithheldContent } from "@api";

vi.mock("@api", () => ({
  getSubscriptions: vi.fn(async () => ({ subscriptions: [] })),
  getApplicationObjects: vi.fn(),
  publishPreview: vi.fn(),
  activateSheet: vi.fn(),
  onAppEvent: vi.fn(() => () => undefined),
  AppEvents: {},
}));

vi.mock("../lib/openApplicationInspectorWindow", () => ({
  openApplicationInspectorWindow: vi.fn(),
}));

import { PublishReportView } from "../components/ApplicationExplorerPanel";
import {
  WithheldContentList,
  WITHHELD_KIND_LABEL,
  describeWithheld,
} from "../components/WithheldContentList";

const APP_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP_ROOT, rel), "utf8");
/** Comments quote the defects they removed, so scanners must not read them. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const FOREIGN_SCRIPT: WithheldContent = {
  kind: "objectScript",
  id: "os-1",
  name: "Refresh",
  reason: "otherApplication",
  owner: "finance",
};
const FOREIGN_UDF: WithheldContent = {
  kind: "customFunction",
  id: "FXRATE",
  name: "FXRATE",
  reason: "otherApplication",
  owner: "finance",
};
const PRIVATE_MODULE: WithheldContent = {
  kind: "moduleScript",
  id: "macro-token",
  name: "Private helper",
  reason: "notInApplication",
  owner: "",
};

function report(withheld: WithheldContent[]): PublishReport {
  return {
    included: [{ category: "sheets", count: 1, detail: "cell data" }],
    excluded: [],
    withheld,
  };
}

let container: HTMLDivElement;
let root: Root;
const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the push report names what the push withheld (BUG-0261)", () => {
  // SABOTAGE: drop `<WithheldContentList items={report.withheld ?? []} />` from
  // PublishReportView.
  it("lists every withheld item by name, grouped by why", async () => {
    await act(async () => {
      root.render(<PublishReportView report={report([FOREIGN_SCRIPT, FOREIGN_UDF, PRIVATE_MODULE])} />);
    });
    const list = byTestId("withheld-content");
    expect(list, "the report does not show what the push withheld").toBeTruthy();
    expect(list!.textContent).toContain("(3)");

    const foreign = byTestId("withheld-other-applications")!;
    expect(foreign.textContent).toContain("Object script 'Refresh' — from application 'finance'");
    expect(foreign.textContent).toContain("Custom function 'FXRATE' — from application 'finance'");
    expect(foreign.textContent).toMatch(/sign that application's code under your key/);
    expect(foreign.textContent, "your own item is not filed under another application").not.toContain(
      "Private helper",
    );

    const yours = byTestId("withheld-yours")!;
    expect(yours.textContent).toContain("Script 'Private helper'");
    expect(yours.textContent).toMatch(/Nothing is deleted/);
  });

  // SABOTAGE: put the condition back to `report.excluded.length === 0 ? (`.
  it("says nothing is left out only when nothing was", async () => {
    await act(async () => {
      root.render(<PublishReportView report={report([PRIVATE_MODULE])} />);
    });
    expect(container.textContent).not.toContain("Nothing in this workbook is left out.");

    await act(async () => {
      root.render(<PublishReportView report={report([])} />);
    });
    expect(container.textContent).toContain("Nothing in this workbook is left out.");
    expect(byTestId("withheld-content"), "an empty list renders nothing").toBeNull();
  });

  it("names the owner, or says 'another application' when there is none", () => {
    expect(describeWithheld(FOREIGN_SCRIPT)).toBe("Object script 'Refresh' — from application 'finance'");
    expect(describeWithheld({ ...FOREIGN_SCRIPT, owner: "" })).toBe(
      "Object script 'Refresh' — from another application",
    );
    expect(describeWithheld(PRIVATE_MODULE)).toBe("Script 'Private helper'");
    expect(describeWithheld({ ...PRIVATE_MODULE, name: "" })).toBe("Script 'macro-token'");
  });

  it("renders nothing for an empty list", async () => {
    await act(async () => {
      root.render(<WithheldContentList items={[]} />);
    });
    expect(container.innerHTML).toBe("");
  });
});

describe("the Publish dialog shows the withheld list before the push", () => {
  const DIALOG = code(read("extensions/Collaboration/components/PublishDialog.tsx"));

  // SABOTAGE: delete `setWithheld(result.report.withheld ?? []);` from the
  // open-time preview effect -- the list then appears only after Preview.
  it("takes the list from the preview it runs on open", () => {
    // The open-time preview is the one called with an EMPTY selection.
    const effect = DIALOG.indexOf("const result = await publishPreview(\n          [],");
    expect(effect, "the open-time preview moved").toBeGreaterThan(-1);
    const end = DIALOG.indexOf("}, [mode, registryPath, packageName]);", effect);
    expect(end, "the open-time preview effect's dependency list moved").toBeGreaterThan(effect);
    expect(DIALOG.slice(effect, end)).toContain("setWithheld(result.report.withheld ?? []);");
  });

  it("renders the list, and makes room for it even outside a push", () => {
    expect(DIALOG).toMatch(/withheld\.length > 0 && report === null && \(/);
    expect(DIALOG).toContain("<WithheldContentList items={withheld} />");
    expect(DIALOG).toMatch(/const hasReview =[\s\S]*?withheld\.length > 0;/);
  });

  it("refreshes the list from every report it shows", () => {
    // After a manual Preview and after the push itself, the list is the one the
    // report carries -- a stale open-time list must not outlive them. The fourth
    // is the button-code refresh that follows the tick list (the withheld list
    // depends on the sheets ticked too).
    const sets = DIALOG.match(/setWithheld\(result\.report\.withheld \?\? \[\]\);/g) ?? [];
    expect(sets.length).toBe(4);
  });
});

describe("the labels mirror the Rust enum", () => {
  // Rust is the source of truth for the wire values: read the enum, camelCase
  // its variants (serde `rename_all = "camelCase"`), and demand exactly those
  // keys. A variant added in Rust without a label here would print its raw id.
  it("has one label per WithheldKind variant", () => {
    const rust = read("src-tauri/src/calp_push_scope.rs");
    const m = rust.match(/pub enum WithheldKind \{([\s\S]*?)\}/);
    expect(m, "WithheldKind moved").toBeTruthy();
    const variants = m![1]
      .split("\n")
      .map((l) => l.trim().replace(/,$/, ""))
      .filter((l) => /^[A-Z][A-Za-z]*$/.test(l))
      .map((v) => v[0].toLowerCase() + v.slice(1));
    expect(variants.length).toBeGreaterThan(0);
    expect(Object.keys(WITHHELD_KIND_LABEL).sort()).toEqual([...variants].sort());
  });

  it("switches on exactly the Rust WithheldReason values", () => {
    const rust = read("src-tauri/src/calp_push_scope.rs");
    const m = rust.match(/pub enum WithheldReason \{([\s\S]*?)\n\}/);
    expect(m, "WithheldReason moved").toBeTruthy();
    const variants = m![1]
      .split("\n")
      .map((l) => l.trim().replace(/,$/, ""))
      .filter((l) => /^[A-Z][A-Za-z]*$/.test(l))
      .map((v) => v[0].toLowerCase() + v.slice(1));
    expect(variants.sort()).toEqual(["notInApplication", "otherApplication"]);
    const ts = read("src/api/collaboration.ts");
    expect(ts).toMatch(/export type WithheldReason = "notInApplication" \| "otherApplication";/);
  });
});
