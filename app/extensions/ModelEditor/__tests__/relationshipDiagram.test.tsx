// FILENAME: app/extensions/ModelEditor/__tests__/relationshipDiagram.test.tsx
// PURPOSE: The relationship diagram's INTERACTIONS — pan-by-drag, the click
//          that must survive a pan, the inspector, and the Fit control that
//          used to lie.
// CONTEXT: THE DIAGRAM HAD NO COMPONENT TESTS AT ALL. It had 401 lines of
//          pure-function tests (layoutEngine, nodeGeometry) and not one that
//          rendered it, because jsdom implements the SVG DOM but none of its
//          GEOMETRY: `createSVGPoint` and `getScreenCTM` are absent, and the
//          diagram calls both on every mouse event. `vitest.setup.ts` now shims
//          them as IDENTITY transforms — enough to drive an interaction and
//          read the coordinates back, and deliberately not enough to pretend
//          jsdom can lay out an SVG.
//
//          What that buys: pan, the inspector and the selection seam are now
//          gateable at the only gate this extension has. What it does not buy
//          is real geometry — `clientWidth` is still 0, which is why the Fit
//          test drives the capped path through a stubbed viewport rather than
//          measuring one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { ModelRelationshipInfo, ModelTableInfo } from "@api";
import { RelationshipDiagram } from "../components/diagram/RelationshipDiagram";
import { DiagramInspector } from "../components/diagram/DiagramInspector";
import { RelationshipsSection } from "../components/sections/RelationshipsSection";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

function table(name: string, cols: string[]): ModelTableInfo {
  return {
    name,
    columns: cols.map((c) => ({ name: c, dataType: "String" })),
    refreshStrategies: [],
    incrementalRefresh: null,
    transformSteps: [],
    transformScript: "",
    sourceColumns: [],
  } as unknown as ModelTableInfo;
}

const REL: ModelRelationshipInfo = {
  name: "Sales_Dim",
  fromTable: "Sales",
  toTable: "Dim",
  conditions: [{ fromColumn: "DeptKey", toColumn: "DeptKey" }],
  cardinality: "manyToOne",
  active: true,
  filterPropagation: "auto",
} as unknown as ModelRelationshipInfo;

const TABLES = [table("Sales", ["Amount", "DeptKey"]), table("Dim", ["DeptKey", "Dept"])];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function mount(props: Record<string, unknown> = {}): Promise<{ onSelectTable: ReturnType<typeof vi.fn> }> {
  const onSelectTable = vi.fn();
  await act(async () => {
    root.render(
      <RelationshipDiagram
        tables={TABLES}
        relationships={[REL]}
        selectedTable={null}
        onSelectTable={onSelectTable}
        {...props}
      />,
    );
  });
  return { onSelectTable };
}

const svg = (): SVGSVGElement =>
  container.querySelector('[data-testid="relationship-diagram"]') as unknown as SVGSVGElement;

/** The scroller the pan drives. */
const scroller = (): HTMLElement => svg().parentElement as HTMLElement;

function mouse(el: Element, type: string, x: number, y: number): void {
  el.dispatchEvent(
    new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }),
  );
}

describe("pan by dragging the background", () => {
  it("scrolls the canvas, and does NOT clear the selection", async () => {
    // The defect this guards: the background click handler clears the
    // selection, so a pan that ends over the background would deselect the very
    // table the user panned across the canvas in order to look at.
    const { onSelectTable } = await mount();
    const el = scroller();
    Object.defineProperty(el, "scrollLeft", { value: 0, writable: true });
    Object.defineProperty(el, "scrollTop", { value: 0, writable: true });

    await act(async () => {
      mouse(svg(), "mousedown", 200, 200);
      mouse(svg(), "mousemove", 150, 170);
      mouse(svg(), "mouseup", 150, 170);
      svg().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(el.scrollLeft, "dragging left scrolls right").toBe(50);
    expect(el.scrollTop).toBe(30);
    expect(
      onSelectTable,
      "a pan that ends on the background is not a click on the background",
    ).not.toHaveBeenCalled();
  });

  it("still lets a plain background CLICK clear the selection", async () => {
    // The positive control. Without it the test above passes against a diagram
    // whose background click handler was simply deleted.
    const { onSelectTable } = await mount();
    await act(async () => {
      mouse(svg(), "mousedown", 200, 200);
      mouse(svg(), "mouseup", 200, 200);
      svg().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSelectTable).toHaveBeenCalledWith(null);
  });

  it("treats a two-pixel wobble as a click, not a pan", async () => {
    // A click with a shaky hand must still be a click.
    const { onSelectTable } = await mount();
    await act(async () => {
      mouse(svg(), "mousedown", 200, 200);
      mouse(svg(), "mousemove", 201, 202);
      mouse(svg(), "mouseup", 201, 202);
      svg().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSelectTable).toHaveBeenCalledWith(null);
  });

  it("does not pan when the drag starts on a NODE", async () => {
    // A mousedown on a node is a node interaction — selecting it, or dragging
    // it in Free mode. Panning as well would move the canvas out from under
    // the node being dragged.
    await mount();
    const el = scroller();
    Object.defineProperty(el, "scrollLeft", { value: 0, writable: true });
    const node = container.querySelector("[data-diagram-node]");
    expect(node, "the positive control: a node is rendered").not.toBeNull();

    await act(async () => {
      mouse(node as Element, "mousedown", 200, 200);
      mouse(svg(), "mousemove", 100, 200);
    });
    expect(el.scrollLeft).toBe(0);
  });

  it("ends the pan when the pointer LEAVES the diagram", async () => {
    // Otherwise releasing outside the SVG leaves the pan armed, and the next
    // mousemove over the diagram jumps the scroll position.
    await mount();
    const el = scroller();
    Object.defineProperty(el, "scrollLeft", { value: 0, writable: true });
    await act(async () => {
      mouse(svg(), "mousedown", 200, 200);
      mouse(svg(), "mousemove", 190, 200);
      // React does not listen for `mouseleave`; it SYNTHESIZES onMouseLeave
      // from a bubbling `mouseout` whose relatedTarget is outside the element.
      // Dispatching mouseleave directly reaches nothing, which is a fact about
      // React's event system rather than about the diagram — and a test that
      // got this wrong would report a bug that does not exist.
      svg().dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }),
      );
    });
    const afterLeave = el.scrollLeft;
    await act(async () => {
      mouse(svg(), "mousemove", 50, 200);
    });
    expect(el.scrollLeft, "a move after the pointer left must not still pan").toBe(afterLeave);
  });
});

describe("the Fit control", () => {
  it("says so when the model is too large to fit", async () => {
    // It used to clamp at the 25% zoom floor and leave the diagram
    // overflowing, under a button labelled "Fit" — a control that lies rather
    // than one that is merely limited.
    await mount();
    const el = scroller();
    // A viewport far smaller than the canvas, so the true fit is below the
    // floor. jsdom reports 0 for both, which the code treats as unmeasurable.
    Object.defineProperty(el, "clientWidth", { value: 40, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 40, configurable: true });

    expect(container.querySelector('[data-testid="diagram-fit-capped"]')).toBeNull();
    await act(async () => {
      (container.querySelector('[data-testid="diagram-fit"]') as HTMLButtonElement).click();
    });
    expect(
      container.querySelector('[data-testid="diagram-fit-capped"]'),
      "a fit that could not fit has to say so",
    ).not.toBeNull();
  });

  it("stays quiet when the model DOES fit", async () => {
    await mount();
    const el = scroller();
    Object.defineProperty(el, "clientWidth", { value: 4000, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 4000, configurable: true });
    await act(async () => {
      (container.querySelector('[data-testid="diagram-fit"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="diagram-fit-capped"]')).toBeNull();
  });

  it("does nothing at all when the viewport cannot be measured", async () => {
    // clientWidth is 0 in jsdom and in a hidden tab. Treating 0 as a real
    // measurement would make every fit look capped.
    await mount();
    await act(async () => {
      (container.querySelector('[data-testid="diagram-fit"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="diagram-fit-capped"]')).toBeNull();
  });
});

describe("the diagram inspector", () => {
  function renderInspector(over: Record<string, unknown> = {}): {
    onOpenTable: ReturnType<typeof vi.fn>;
    onEditRelationship: ReturnType<typeof vi.fn>;
  } {
    const onOpenTable = vi.fn();
    const onEditRelationship = vi.fn();
    act(() => {
      root.render(
        <DiagramInspector
          table={TABLES[0]}
          relationships={[REL]}
          onOpenTable={onOpenTable}
          onEditRelationship={onEditRelationship}
          onClose={vi.fn()}
          {...over}
        />,
      );
    });
    return { onOpenTable, onEditRelationship };
  }

  it("finds relationships on BOTH sides of the table", () => {
    // A dimension is almost always on the `to` side, so a one-sided filter
    // would show an empty list for exactly the tables people click most.
    renderInspector({ table: TABLES[1] });
    expect(
      container.querySelector('[data-testid="diagram-inspector-rel-Sales_Dim"]'),
      "Dim is the TO side and must still see the join",
    ).not.toBeNull();
  });

  it("navigates rather than editing", () => {
    // Read-only plus navigate, deliberately: TablesSection owns table editing
    // and a second set of write controls here would be a second write path.
    const { onOpenTable, onEditRelationship } = renderInspector();
    (container.querySelector('[data-testid="diagram-inspector-open-table"]') as HTMLButtonElement).click();
    expect(onOpenTable).toHaveBeenCalledWith("Sales");
    (container.querySelector('[data-testid="diagram-inspector-rel-Sales_Dim"]') as HTMLButtonElement).click();
    expect(onEditRelationship).toHaveBeenCalledWith("Sales_Dim");
  });

  it("says what an orphan table means, rather than showing a blank", () => {
    renderInspector({ relationships: [] });
    const text = container.textContent ?? "";
    expect(text).toContain("This table joins nothing");
  });
});

// ===========================================================================
// Arriving with a selection
// ===========================================================================
//
// `modelIndex` has emitted every relationship as
// `{section: "relationships", selection: r.name}` since the search palette
// shipped, and the problems drawer navigates the same way — and this section
// read NEITHER. Every Ctrl+K hit on a relationship landed you on the right page
// with nothing indicated and nothing scrolled to, which is a search result that
// answers "somewhere on this page".

describe("RelationshipsSection honours ctx.selection", () => {
  function ctxFor(selection?: string): unknown {
    return {
      connectionId: "conn-1",
      overview: {
        editable: true,
        readOnlyReason: null,
        tables: TABLES,
        relationships: [REL],
        hierarchies: [],
        kpis: [],
        securityRoles: [],
        perspectives: [],
        cultures: [],
        calculationGroups: [],
        measures: [],
        contexts: [],
        contextColumns: [],
        tableVariables: [],
        globalVariables: [],
        scriptFunctions: [],
        dateTable: null,
        defaultLookupResolution: null,
        modelName: "Test",
        modelVersion: null,
        modelAuthor: null,
        modelDescription: null,
        sources: [],
        writebackColumns: [],
      },
      readOnly: false,
      selection,
      applyOverview: vi.fn(),
      applyMeasures: vi.fn(),
      reportError: vi.fn(),
      navigate: vi.fn(),
      runCommand: vi.fn().mockResolvedValue([]),
    };
  }

  const row = (name: string): HTMLElement | null =>
    ([...container.querySelectorAll("[data-relationship]")] as HTMLElement[]).find(
      (el) => el.getAttribute("data-relationship") === name,
    ) ?? null;

  it("marks the relationship it was sent to", async () => {
    await act(async () => {
      root.render(<RelationshipsSection ctx={ctxFor("Sales_Dim") as never} />);
    });
    const hit = row("Sales_Dim");
    expect(hit, "the positive control: the row is rendered").not.toBeNull();
    expect(hit?.getAttribute("data-selected"), "and it is the one marked").toBe("true");
  });

  it("marks nothing when it arrives with no selection", async () => {
    await act(async () => {
      root.render(<RelationshipsSection ctx={ctxFor() as never} />);
    });
    expect(row("Sales_Dim")?.getAttribute("data-selected")).toBeNull();
  });

  it("ignores a selection naming a relationship the model does not have", async () => {
    // A stale route, or a model switched under a remembered selection. Marking
    // nothing is right; throwing is not.
    await act(async () => {
      root.render(<RelationshipsSection ctx={ctxFor("Gone") as never} />);
    });
    expect(row("Sales_Dim")?.getAttribute("data-selected")).toBeNull();
  });
});

describe("selecting a node", () => {
  it("STICKS — the click must not fall through to the background", async () => {
    // A PRE-EXISTING BUG, invisible until something read the selection. The
    // node's onClick sets the name and then bubbles straight into the SVG
    // background handler, which clears it — so `onSelectTable` was called twice
    // per click, second with null, and node selection never survived a single
    // click. Nobody filed it because the only consumer was the node's own
    // highlight: a write-only feature whose writer is broken looks like nothing
    // at all. The inspector is what made it visible.
    const { onSelectTable } = await mount();
    const node = container.querySelector("[data-diagram-node]") as Element;
    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSelectTable).toHaveBeenCalledTimes(1);
    expect(onSelectTable).toHaveBeenCalledWith("Sales");
    expect(
      onSelectTable,
      "the background handler must not have cleared it on the way up",
    ).not.toHaveBeenCalledWith(null);
  });
});
