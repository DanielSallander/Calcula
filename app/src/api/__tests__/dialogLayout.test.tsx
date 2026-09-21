//! FILENAME: app/src/api/__tests__/dialogLayout.test.tsx
// PURPOSE: Pin the layout contract of @api/dialogLayout.
// CONTEXT: These primitives exist to stop dialogs from being tall scrolling
//          straws, and the properties that achieve that are easy to lose in a
//          later edit and invisible until someone opens the dialog:
//            - a pane scrolls ITSELF only if every flex ancestor carries
//              `minHeight: 0`; drop it and the dialog grows instead and the
//              footer walks off the bottom of the screen,
//            - a side pane must be a SIBLING of the scrolling pane, never a
//              child of it, or the preview scrolls away with the settings,
//            - the field grid must be `auto-fit` + `minmax`, because a fixed
//              `repeat(2, …)` is exactly the thing that made these dialogs
//              unusable when the user dragged them narrow.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  DialogBody,
  DialogPane,
  DialogSidePane,
  DialogFieldGrid,
  DialogFieldSpan,
  DialogSection,
  useDialogSplit,
  dialogWidth,
  dialogHeight,
  DIALOG_FIELD_MIN_WIDTH,
} from "../dialogLayout";

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

function render(node: React.ReactElement): void {
  act(() => root.render(node));
}

// ----------------------------------------------------------------------------
// DialogBody
// ----------------------------------------------------------------------------

describe("DialogBody", () => {
  it("lays panes out in a ROW by default — the whole point of the module", () => {
    render(
      <DialogBody>
        <div data-testid="a" />
      </DialogBody>,
    );
    const body = container.firstElementChild as HTMLElement;
    expect(body.style.display).toBe("flex");
    expect(body.style.flexDirection).toBe("row");
  });

  it("stacks when asked, for a dialog too narrow to split", () => {
    render(
      <DialogBody stacked>
        <div />
      </DialogBody>,
    );
    const body = container.firstElementChild as HTMLElement;
    expect(body.style.flexDirection).toBe("column");
  });

  it("carries minHeight:0 so a child pane can own its own scrollbar", () => {
    render(
      <DialogBody>
        <div />
      </DialogBody>,
    );
    const body = container.firstElementChild as HTMLElement;
    // Without this the flex item refuses to shrink below its content height,
    // the dialog grows past its max-height, and the footer leaves the screen.
    expect(body.style.minHeight).toBe("0px");
  });

  it("forwards a ref, which useDialogSplit needs to measure the split", () => {
    const ref = React.createRef<HTMLDivElement>();
    render(
      <DialogBody ref={ref}>
        <div />
      </DialogBody>,
    );
    expect(ref.current).toBeInstanceOf(HTMLElement);
  });
});

// ----------------------------------------------------------------------------
// DialogPane / DialogSidePane
// ----------------------------------------------------------------------------

describe("DialogPane", () => {
  it("scrolls itself by default and pins minHeight:0 to make that work", () => {
    render(<DialogPane data-testid="p">x</DialogPane>);
    const pane = container.querySelector('[data-testid="p"]') as HTMLElement;
    expect(pane.style.overflowY).toBe("auto");
    expect(pane.style.minHeight).toBe("0px");
  });

  it("stops scrolling when a tab owns its own split (scroll={false})", () => {
    render(
      <DialogPane scroll={false} data-testid="p">
        x
      </DialogPane>,
    );
    const pane = container.querySelector('[data-testid="p"]') as HTMLElement;
    expect(pane.style.overflowY).toBe("visible");
  });

  it("holds a fixed basis when given a width, instead of flexing", () => {
    render(
      <DialogPane width={280} data-testid="p">
        x
      </DialogPane>,
    );
    const pane = container.querySelector('[data-testid="p"]') as HTMLElement;
    expect(pane.style.flex).toBe("0 0 280px");
  });
});

describe("DialogSidePane", () => {
  it("is a SIBLING of the scrolling pane, so a preview never scrolls away", () => {
    render(
      <DialogBody>
        <DialogPane data-testid="settings">settings</DialogPane>
        <DialogSidePane data-testid="preview">preview</DialogSidePane>
      </DialogBody>,
    );
    const settings = container.querySelector('[data-testid="settings"]')!;
    const preview = container.querySelector('[data-testid="preview"]')!;
    expect(preview.parentElement).toBe(settings.parentElement);
    // The regression this guards: nesting the preview inside the scroller.
    expect(settings.contains(preview)).toBe(false);
  });

  it("does not scroll — it is the pinned pane", () => {
    render(<DialogSidePane data-testid="s">x</DialogSidePane>);
    const pane = container.querySelector('[data-testid="s"]') as HTMLElement;
    expect(pane.style.overflowY).toBe("");
    expect(pane.style.flex).toBe("0 0 360px");
  });

  it("flexes instead when the caller drives the width", () => {
    render(
      <DialogSidePane flexible data-testid="s">
        x
      </DialogSidePane>,
    );
    const pane = container.querySelector('[data-testid="s"]') as HTMLElement;
    expect(pane.style.flex).toBe("1 1 0%");
  });

  it("renders its title above the content", () => {
    render(
      <DialogSidePane title="Preview" data-testid="s">
        <div data-testid="body" />
      </DialogSidePane>,
    );
    const pane = container.querySelector('[data-testid="s"]')!;
    expect(pane.textContent).toContain("Preview");
    expect(pane.firstElementChild!.textContent).toBe("Preview");
  });
});

// ----------------------------------------------------------------------------
// DialogFieldGrid
// ----------------------------------------------------------------------------

describe("DialogFieldGrid", () => {
  it("uses auto-fit + minmax so columns appear and vanish with the width", () => {
    render(
      <DialogFieldGrid>
        <div />
      </DialogFieldGrid>,
    );
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.style.display).toBe("grid");
    expect(grid.style.gridTemplateColumns).toBe(
      `repeat(auto-fit, minmax(${DIALOG_FIELD_MIN_WIDTH}px, 1fr))`,
    );
    // A fixed repeat(N, …) is the bug: it cannot collapse, so dragging the
    // dialog narrow clips the second column instead of folding it away.
    expect(grid.style.gridTemplateColumns).not.toMatch(/repeat\(\d/);
  });

  it("honours a caller's narrower column for checkbox-sized fields", () => {
    render(
      <DialogFieldGrid minColumnWidth={140}>
        <div />
      </DialogFieldGrid>,
    );
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.style.gridTemplateColumns).toContain("minmax(140px");
  });

  it("caps the column count by raising the track MINIMUM, not the maximum", () => {
    render(
      <DialogFieldGrid maxColumns={2} columnGap={24}>
        <div />
      </DialogFieldGrid>,
    );
    const grid = container.firstElementChild as HTMLElement;
    // auto-fit fits as many tracks as the MINIMUM allows. Capping via the
    // maximum (`minmax(210px, 50%)`) caps nothing: a 900px pane still lays out
    // four 210px columns. The minimum must be the width 2 columns would take.
    expect(grid.style.gridTemplateColumns).toBe(
      "repeat(auto-fit, minmax(max(210px, calc((100% - 24px) / 2)), 1fr))",
    );
    expect(grid.style.gridTemplateColumns).not.toContain("50%");
  });

  it("scales the gap allowance with the column cap", () => {
    render(
      <DialogFieldGrid maxColumns={3} columnGap={16} minColumnWidth={180}>
        <div />
      </DialogFieldGrid>,
    );
    const grid = container.firstElementChild as HTMLElement;
    // Three columns leave TWO gaps to subtract, not one.
    expect(grid.style.gridTemplateColumns).toBe(
      "repeat(auto-fit, minmax(max(180px, calc((100% - 32px) / 3)), 1fr))",
    );
  });

  it("DialogFieldSpan takes every column", () => {
    render(
      <DialogFieldSpan>
        <div />
      </DialogFieldSpan>,
    );
    const span = container.firstElementChild as HTMLElement;
    expect(span.style.gridColumn).toBe("1 / -1");
    expect(span.style.minWidth).toBe("0px");
  });
});

describe("DialogSection", () => {
  it("renders a title only when given one", () => {
    render(<DialogSection>body</DialogSection>);
    expect(container.textContent).toBe("body");

    render(<DialogSection title="Data source">body</DialogSection>);
    expect(container.textContent).toContain("Data source");
  });
});

// ----------------------------------------------------------------------------
// useDialogSplit
// ----------------------------------------------------------------------------

function SplitHarness({
  onApi,
  ...options
}: { onApi: (api: ReturnType<typeof useDialogSplit>) => void } & Parameters<
  typeof useDialogSplit
>[0]): React.ReactElement {
  const split = useDialogSplit(options);
  onApi(split);
  return (
    <DialogBody ref={split.containerRef}>
      <DialogPane style={split.primaryStyle} data-testid="primary">
        a
      </DialogPane>
      {split.splitter}
      <DialogSidePane flexible style={split.secondaryStyle} data-testid="secondary">
        b
      </DialogSidePane>
    </DialogBody>
  );
}

/** The primary pane's share, parsed out of `0 0 calc(62% - 3.5px)`.
 *  (The CSSOM normalises "62.000%" to "62%", so match on the number.) */
function primaryPct(): number {
  const el = container.querySelector('[data-testid="primary"]') as HTMLElement;
  const m = /calc\(\s*([\d.]+)%/.exec(el.style.flex);
  if (!m) throw new Error(`primary pane has no percentage basis: "${el.style.flex}"`);
  return Number(m[1]);
}

describe("useDialogSplit", () => {
  it("gives the primary pane the initial share and the rest to the secondary", () => {
    render(<SplitHarness initial={0.6} onApi={() => {}} />);
    const secondary = container.querySelector('[data-testid="secondary"]') as HTMLElement;
    expect(primaryPct()).toBeCloseTo(60, 3);
    expect(secondary.style.flex).toBe("1 1 0%");
  });

  it("exposes a keyboard-reachable separator with a role", () => {
    render(<SplitHarness onApi={() => {}} />);
    const handle = container.querySelector('[data-testid="dialog-splitter"]') as HTMLElement;
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.tabIndex).toBe(0);
  });

  it("moves the divider with the arrow keys and clamps at both ends", () => {
    render(<SplitHarness initial={0.5} min={0.4} max={0.6} onApi={() => {}} />);
    const handle = container.querySelector('[data-testid="dialog-splitter"]') as HTMLElement;

    const press = (key: string, shiftKey = false) =>
      act(() => {
        handle.dispatchEvent(
          new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }),
        );
      });

    press("ArrowRight");
    expect(primaryPct()).toBeCloseTo(52, 3);

    // Shift steps by 10% and must stop at max, not sail past it.
    press("ArrowRight", true);
    expect(primaryPct()).toBeCloseTo(60, 3);
    press("ArrowRight", true);
    expect(primaryPct()).toBeCloseTo(60, 3);

    press("Home");
    expect(primaryPct()).toBeCloseTo(50, 3);

    press("ArrowLeft", true);
    press("ArrowLeft", true);
    expect(primaryPct()).toBeCloseTo(40, 3);
  });

  it("reset() returns to the initial share after the user has dragged it", () => {
    let api!: ReturnType<typeof useDialogSplit>;
    render(<SplitHarness initial={0.62} onApi={(a) => (api = a)} />);
    const handle = container.querySelector('[data-testid="dialog-splitter"]') as HTMLElement;

    act(() => {
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(primaryPct()).not.toBeCloseTo(62, 3);

    act(() => api.reset());
    expect(primaryPct()).toBeCloseTo(62, 3);
  });
});

// ----------------------------------------------------------------------------
// Width helpers
// ----------------------------------------------------------------------------

describe("dialogWidth / dialogHeight", () => {
  it("never lets a preferred size overflow a small screen", () => {
    expect(dialogWidth(1060)).toBe("min(1060px, 94vw)");
    expect(dialogHeight(660)).toBe("min(660px, 88vh)");
    expect(dialogWidth(800, 0.8)).toBe("min(800px, 80vw)");
  });
});
