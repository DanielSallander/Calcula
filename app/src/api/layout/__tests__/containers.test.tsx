// Tests for the container primitives under the Clusters fill rule: Group's
// two caption recipes, Stack's cap at the cluster content box, ControlGrid's
// 28 + 5 + 28 row geometry, and ControlGrid's `segmentOf`, which must join
// related controls into Segmented pills WITHOUT moving any control to a
// different row than it had before segments existed. Rendered under band AND
// panel geometry and scanned for hardcoded colours.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SurfaceLayoutProvider, bandLayout, panelLayout, type SurfaceLayout } from "../context";
import {
  ActionRow,
  ControlGrid,
  ControlGridBreak,
  ControlRow,
  Group,
  Stack,
  StatusText,
} from "../primitives/containers";
import { BAND_MAX_CONTENT_HEIGHT, GAP_XS, ROW_GAP } from "../tokens";
import { hardcodedColours } from "./colourScan";

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

function render(node: React.ReactNode, layout: SurfaceLayout = bandLayout()): void {
  act(() => {
    root.render(<SurfaceLayoutProvider value={layout}>{node}</SurfaceLayoutProvider>);
  });
}

function rootDiv(): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

// ============================================================================
// Group
// ============================================================================

describe("Group", () => {
  it("band: an 11px/500 caption below the content in the group-label colour", () => {
    render(
      <Group label="Font">
        <button>B</button>
      </Group>,
    );
    const caption = rootDiv().lastElementChild as HTMLElement;
    expect(caption.textContent).toBe("Font");
    expect(caption.style.fontSize).toBe("11px");
    expect(caption.style.fontWeight).toBe("500");
    expect(caption.style.lineHeight).toBe("13px");
    expect(caption.style.marginTop).toBe("2px");
    expect(caption.style.color).toContain("--ribbon-group-label-fg");
    expect(caption.style.textOverflow).toBe("ellipsis");
  });

  it("panel: the one header recipe — 12px/600 sentence case in the text colour", () => {
    render(
      <Group label="Axis options">
        <button>B</button>
      </Group>,
      panelLayout(300),
    );
    const header = rootDiv().firstElementChild as HTMLElement;
    expect(header.textContent).toBe("Axis options");
    expect(header.style.fontSize).toBe("12px");
    expect(header.style.fontWeight).toBe("600");
    expect(header.style.textTransform).toBe("");
    expect(header.style.letterSpacing).toBe("");
    expect(header.style.opacity).toBe("");
    expect(header.style.color).toContain("--text-primary");
  });
});

// ============================================================================
// Stack
// ============================================================================

describe("Stack", () => {
  it("caps at the cluster content box in the band", () => {
    render(<Stack><div>a</div></Stack>);
    expect(rootDiv().style.maxHeight).toBe(`${BAND_MAX_CONTENT_HEIGHT}px`);
  });

  it("honours a provider's own maxContentHeight", () => {
    render(<Stack><div>a</div></Stack>, { ...bandLayout(), maxContentHeight: 40 });
    expect(rootDiv().style.maxHeight).toBe("40px");
  });

  it("falls back to the content box when the provider leaves it null", () => {
    render(<Stack><div>a</div></Stack>, { ...bandLayout(), maxContentHeight: null });
    expect(rootDiv().style.maxHeight).toBe(`${BAND_MAX_CONTENT_HEIGHT}px`);
  });
});

// ============================================================================
// ControlGrid geometry
// ============================================================================

const buttons = (n: number) =>
  Array.from({ length: n }, (_, i) => (
    <button key={i} data-seg={i >= 2 && i <= 4 ? "Align" : undefined}>
      {i}
    </button>
  ));

describe("ControlGrid geometry", () => {
  it("band defaults: two rows 5px apart (28 + 5 + 28 = 61), 4px between controls", () => {
    render(<ControlGrid>{buttons(6)}</ControlGrid>);
    expect(rootDiv().style.gap).toBe(`${ROW_GAP}px`);
    const rows = Array.from(rootDiv().children) as HTMLElement[];
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.style.gap).toBe(`${GAP_XS}px`);
  });

  it("gap and rowGap are independent", () => {
    render(
      <ControlGrid gap={2} rowGap={7}>
        {buttons(6)}
      </ControlGrid>,
    );
    expect(rootDiv().style.gap).toBe("7px");
    expect((rootDiv().firstElementChild as HTMLElement).style.gap).toBe("2px");
  });

  it("panel: one wrapping row, columnGap = gap and rowGap = rowGap", () => {
    render(<ControlGrid>{buttons(6)}</ControlGrid>, panelLayout(300));
    const div = rootDiv();
    expect(div.style.flexWrap).toBe("wrap");
    expect(div.style.columnGap).toBe(`${GAP_XS}px`);
    expect(div.style.rowGap).toBe(`${ROW_GAP}px`);
    expect(div.querySelectorAll("button")).toHaveLength(6);
  });

  it("curated rows split exactly at ControlGridBreak", () => {
    render(
      <ControlGrid>
        <button>a</button>
        <button>b</button>
        <ControlGridBreak />
        <button>c</button>
      </ControlGrid>,
    );
    const rows = Array.from(rootDiv().children) as HTMLElement[];
    expect(rows.map((r) => r.textContent)).toEqual(["ab", "c"]);
  });
});

// ============================================================================
// ControlGrid segmentOf
// ============================================================================

/** Reads a DOM data attribute off a child's props (a string index, since
 *  `data-*` names are not identifiers). */
function dataProp(child: React.ReactElement, name: string): string | undefined {
  return (child.props as Record<string, string | undefined>)[name];
}

const bySeg = (child: React.ReactElement): string | undefined => dataProp(child, "data-seg");

/** Row contents as text, reading order preserved. */
function rowTexts(): string[] {
  return (Array.from(rootDiv().children) as HTMLElement[]).map((r) => r.textContent ?? "");
}

describe("ControlGrid segmentOf", () => {
  it("a 7-child group without breaks splits into exactly the rows it had before segments", () => {
    const seven = () => buttons(7);
    render(<ControlGrid>{seven()}</ControlGrid>);
    const before = rowTexts();
    const beforeCounts = (Array.from(rootDiv().children) as HTMLElement[]).map(
      (r) => r.querySelectorAll("button").length,
    );
    expect(before).toEqual(["0123", "456"]);

    render(<ControlGrid segmentOf={bySeg}>{seven()}</ControlGrid>);
    expect(rowTexts()).toEqual(before);
    expect(
      (Array.from(rootDiv().children) as HTMLElement[]).map((r) => r.querySelectorAll("button").length),
    ).toEqual(beforeCounts);
  });

  it("wraps each run of same-segment children per row in a named Segmented", () => {
    render(<ControlGrid segmentOf={bySeg}>{buttons(7)}</ControlGrid>);
    const [row0, row1] = Array.from(rootDiv().children) as HTMLElement[];

    // Row 0: 0, 1 bare, then [2, 3] joined. Row 1: [4] joined, then 5, 6 bare.
    // The "Align" run straddles the row split, so it becomes two pills rather
    // than pulling 4 up or pushing 2-3 down.
    const kids0 = Array.from(row0.children) as HTMLElement[];
    expect(kids0.map((k) => k.tagName)).toEqual(["BUTTON", "BUTTON", "DIV"]);
    expect(kids0[2].getAttribute("role")).toBe("group");
    expect(kids0[2].getAttribute("aria-label")).toBe("Align");
    expect(kids0[2].textContent).toBe("23");

    const kids1 = Array.from(row1.children) as HTMLElement[];
    expect(kids1.map((k) => k.tagName)).toEqual(["DIV", "BUTTON", "BUTTON"]);
    expect(kids1[0].getAttribute("aria-label")).toBe("Align");
    expect(kids1[0].textContent).toBe("4");
  });

  it("different adjacent segments become separate pills", () => {
    const seg = (child: React.ReactElement) => dataProp(child, "data-g");
    render(
      <ControlGrid segmentOf={seg}>
        <button data-g="A">1</button>
        <button data-g="A">2</button>
        <button data-g="B">3</button>
        <button data-g="B">4</button>
      </ControlGrid>,
    );
    const pills = Array.from(rootDiv().querySelectorAll("[role='group']")) as HTMLElement[];
    expect(pills.map((p) => [p.getAttribute("aria-label"), p.textContent])).toEqual([
      ["A", "12"],
      ["B", "34"],
    ]);
  });

  it("curated rows stay curated; segments apply within each", () => {
    render(
      <ControlGrid segmentOf={bySeg}>
        {buttons(3)}
        <ControlGridBreak />
        {buttons(5).slice(3).map((b, i) => React.cloneElement(b, { key: `r2-${i}` }))}
      </ControlGrid>,
    );
    const rows = Array.from(rootDiv().children) as HTMLElement[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.textContent)).toEqual(["012", "34"]);
    expect(rows[0].querySelector("[role='group']")?.textContent).toBe("2");
    expect(rows[1].querySelector("[role='group']")?.textContent).toBe("34");
  });

  it("the panel's single wrapping row is segmented too, breaks ignored", () => {
    render(
      <ControlGrid segmentOf={bySeg}>
        {buttons(3)}
        <ControlGridBreak />
        {buttons(6).slice(3).map((b, i) => React.cloneElement(b, { key: `r2-${i}` }))}
      </ControlGrid>,
      panelLayout(300),
    );
    const div = rootDiv();
    expect(div.style.flexWrap).toBe("wrap");
    const pills = Array.from(div.querySelectorAll("[role='group']")) as HTMLElement[];
    expect(pills).toHaveLength(1);
    expect(pills[0].textContent).toBe("234");
    expect(div.querySelectorAll("button")).toHaveLength(6);
  });

  it("without segmentOf nothing is wrapped", () => {
    render(<ControlGrid>{buttons(7)}</ControlGrid>);
    expect(rootDiv().querySelector("[role='group']")).toBeNull();
  });
});

// ============================================================================
// Rows and status text
// ============================================================================

describe("ControlRow / ActionRow / StatusText", () => {
  it("ControlRow never wraps in the band and wraps in the panel", () => {
    render(<ControlRow><button>a</button></ControlRow>);
    expect(rootDiv().style.flexWrap).toBe("nowrap");
    render(<ControlRow><button>a</button></ControlRow>, panelLayout(300));
    expect(rootDiv().style.flexWrap).toBe("wrap");
  });

  it("ActionRow keeps its archetype flow", () => {
    render(<ActionRow><button>a</button></ActionRow>);
    expect(rootDiv().style.flexWrap).toBe("nowrap");
  });

  it("StatusText is secondary text, ellipsised", () => {
    render(<StatusText title="Saved">Saved</StatusText>);
    const span = rootDiv();
    expect(span.style.color).toContain("--text-secondary");
    expect(span.style.textOverflow).toBe("ellipsis");
    expect(span.getAttribute("title")).toBe("Saved");
  });
});

// ============================================================================
// Colours
// ============================================================================

describe("containers colours", () => {
  it.each([
    ["band", bandLayout()],
    ["panel", panelLayout(300)],
  ])("paint no hardcoded colour in the %s", (_name, layout) => {
    render(
      <Group label="Alignment">
        <Stack>
          <ControlGrid segmentOf={bySeg}>{buttons(7)}</ControlGrid>
          <ControlRow>
            <button>a</button>
          </ControlRow>
          <ActionRow>
            <button>b</button>
            <StatusText>Ready</StatusText>
          </ActionRow>
        </Stack>
      </Group>,
      layout,
    );
    expect(hardcodedColours(container)).toEqual([]);
  });
});
