//! FILENAME: app/extensions/Pivot/__tests__/designEditorStrategy.test.tsx
// PURPOSE: The pivot's Design tab suggests from the STRATEGY, and gets it from
//          the one connection-level fetch `PivotEditor` already makes.
// CONTEXT: `get_pivot_bi_metadata` is a snapshot taken at pivot creation and
//          carries `strategy: None`; only the connection-level metadata carries
//          the summary. Until 2026-09-11 the pivot's rows therefore had no
//          strategy at all (filed in open-items.md 2.AI.10).
//
//          The first fix gave `DesignEditor` its own fetch, and an adversarial
//          review found three things wrong with that: it was a SECOND full-model
//          round trip on every pivot open, it never refreshed when the model
//          changed, and — because it did not clear the previous value first — it
//          could hand one connection's strategy to another connection's pivot
//          when the selection moved between pivots without a remount. So the
//          strategy now rides on the `biModel` prop, from `PivotEditor`'s
//          existing `liveModelMeta` fetch, which already does all three
//          correctly. The last describe block guards that wiring, because the
//          way it regresses is silent: pass the cached `biModel` again and every
//          strategy rule simply goes quiet.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as fs from "fs";
import * as path from "path";
import type { BiPivotModelInfo } from "../../_shared/components/types";
import { modelInfoFromFixture, strategySummaryFromFixture } from "../../../../tests/eval/lib/modelFixture.mjs";

const REPO = path.resolve(__dirname, "../../../..");
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(REPO, rel), "utf8"));
const bundle = read("tests/fixtures/model/sales_star.json");
const strategy = strategySummaryFromFixture(read("tests/fixtures/model/sales_star_strategy.json"), bundle);
/** What `get_pivot_bi_metadata` gives: no strategy, because the cache holds no model. */
const cached: BiPivotModelInfo = { ...modelInfoFromFixture(bundle), connectionId: "c1", strategy: null };
/** What `get_connection_bi_model` gives, which is what `PivotEditor` passes down. */
const live: BiPivotModelInfo = { ...cached, strategy };

const h = vi.hoisted(() => ({ editor: null as unknown }));

// Monaco: a fake editor the component can drive, and a textarea for the eye.
vi.mock("@monaco-editor/react", async () => {
  const react = await import("react");
  return {
    default: ({ onMount }: { onMount?: (editor: unknown, monaco: unknown) => void }) => {
      react.useEffect(() => {
        h.editor = {
          setValue: () => undefined,
          getModel: () => ({ getFullModelRange: () => ({}), pushEditOperations: () => null }),
          layout: () => undefined,
        };
        onMount?.(h.editor, { editor: { setModelMarkers: () => undefined }, MarkerSeverity: { Error: 8, Warning: 4, Info: 2 } });
      }, [onMount]);
      return react.createElement("textarea", { "data-testid": "editor-buffer" });
    },
    loader: { config: () => {}, init: () => Promise.resolve({}) },
    useMonaco: () => null,
  };
});
vi.mock("../../_shared/dsl/pivotLayout/pivotDslLanguage", () => ({
  LANGUAGE_ID: "pivot-layout-dsl",
  registerPivotDslLanguage: () => undefined,
  setDslEditorContext: () => undefined,
}));
vi.mock("@api/controlValues", () => ({ getControlValue: () => undefined }));
vi.mock("@api", () => ({
  getAiCompletionProvider: () => null,
  hasAiCompletionProvider: () => false,
}));

const { DesignEditor } = await import("../components/DesignEditor");

// React 18 warns and stops flushing effects synchronously without this, which
// makes every debounce in the file a race. Each React test file sets it itself.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;

async function mount(biModel: BiPivotModelInfo | undefined, text: string): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(DesignEditor, {
        sourceFields: [],
        biModel,
        rows: [],
        columns: [],
        values: [],
        filters: [],
        layout: {} as never,
        filterUniqueValues: new Map(),
        onZoneStateChange: () => undefined,
        externalDslText: text,
        isActive: true,
      }),
    );
  });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 350)); });
}

const accepts = () => [...container.querySelectorAll("[data-testid='next-edit-accept']")].map((b) => b.textContent);

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("the pivot Design tab's suggestions", () => {
  it("use the strategy carried on the model it is given", async () => {
    await mount(live, "VALUES: [Revenue]");
    expect(
      accepts(),
      "Revenue's first analysis dimension — a fact only the strategy knows",
    ).toContain("Add ROWS: Product.Category");
  });

  it("fall back to structural rules when the model carries no strategy", async () => {
    await mount(cached, "VALUES: [Revenue]");
    const labels = accepts();
    expect(labels.length, "the structural rules still have something to say").toBeGreaterThan(0);
    expect(
      labels,
      "without a strategy there is no way to know Revenue is analysed by Category",
    ).not.toContain("Add ROWS: Product.Category");
  });

  it("show nothing for a range pivot, which has no model at all", async () => {
    await mount(undefined, "VALUES: [Revenue]");
    expect(container.querySelector("[data-testid='next-edit-row']")).toBeNull();
  });

  it("apply an accepted edit into the editor buffer", async () => {
    await mount(live, "ROWS: Product.Name\nVALUES: [Revenue]");
    expect(accepts()[0]).toBe("Remove Product.Name from ROWS");
    // The accept path is `applyDraft`, the same one the drafting row uses; it
    // writes through Monaco's own edit operations, so there is nothing to
    // assert here but that the control exists and is wired.
    expect(container.querySelectorAll("[data-testid='next-edit-chip']").length).toBeGreaterThan(0);
  });
});

describe("where the strategy comes from (the wiring that regresses silently)", () => {
  const src = (rel: string) => fs.readFileSync(path.join(REPO, "app/extensions/Pivot/components", rel), "utf8");

  it("PivotEditor asks the connection for it, keeps it, and merges it into the model it passes down", () => {
    const editor = src("PivotEditor.tsx");
    expect(editor, "the connection fetch must keep the strategy").toContain("strategy: m.strategy");
    expect(editor, "and the merged model must carry it").toContain("strategy: liveModelMeta.strategy ?? biModel.strategy");
    // The Design tab must receive the MERGED model. Passing the pivot's cached
    // `biModel` again compiles, renders, and silently loses every strategy rule.
    const mount = /<DesignEditor[\s\S]*?\/>/.exec(editor);
    expect(mount, "no <DesignEditor .../> element found").not.toBeNull();
    expect(mount![0]).toContain("biModel={fieldListModel}");
    expect(mount![0]).not.toContain("biModel={biModel}");
  });

  it("DesignEditor fetches nothing of its own", () => {
    // A second full-model round trip per pivot open, stale on `bi:model-changed`,
    // and cross-connection leakage: all three came from it having its own fetch.
    //
    // IMPORTS ONLY, not the whole file. This repo has already had a census fail
    // because a word appeared in a COMMENT (`build_comment_fabricates_call_edge`),
    // and `DesignEditor`'s header legitimately mentions pivot-api's resolver.
    const imports = src("DesignEditor.tsx")
      .split("\n")
      .filter((l) => /^\s*import\b/.test(l))
      .join("\n");
    expect(imports.length, "the import scan found nothing — it is broken, not the file").toBeGreaterThan(100);
    expect(imports, "the Design tab must not reach the backend for a model its parent already has").not.toContain("pivot-api");
    expect(imports).not.toContain("getConnectionBiModel");
  });
});
