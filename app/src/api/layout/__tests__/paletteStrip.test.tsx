// Tests for the @api/layout PaletteStrip: the 44x28 four-bar palette radios
// (a real radiogroup — arrows move AND choose, one tab stop), the rule that
// the selected palette is always visible, and "More palettes" opening every
// palette by name in a card popover listbox. The bars are colour DATA and
// carry data-colour-data; everything else must follow the skin, which the
// scan checks under band AND panel geometry.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SurfaceLayoutProvider, bandLayout, panelLayout, type SurfaceLayout } from "../context";
import { findHardcodedColours } from "../testing";
import { PaletteStrip, stripPalettes, type PaletteOption } from "../primitives/PaletteStrip";

/**
 * findHardcodedColours with its one known false positive neutralised (the
 * helper's colour-name alternation matches the "white" of `white-space`).
 * Same helper as buttons.test.tsx; a harmless no-op once testing.ts is fixed.
 */
function hardcodedColours(root: Element): string[] {
  const tags = Array.from(document.querySelectorAll("style"));
  const saved = tags.map((tag) => tag.textContent);
  try {
    for (const tag of tags) {
      tag.textContent = (tag.textContent ?? "").replace(/white-space\s*:\s*[a-z-]+\s*;?/gi, "");
    }
    return findHardcodedColours(root);
  } finally {
    tags.forEach((tag, i) => {
      tag.textContent = saved[i];
    });
  }
}

const PALETTES: PaletteOption[] = [
  { id: "office", name: "Office", colors: ["#4472c4", "#ed7d31", "#a5a5a5", "#ffc000", "#5b9bd5", "#70ad47"] },
  { id: "tableau", name: "Tableau", colors: ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f"] },
  { id: "viridis", name: "Viridis", colors: ["#440154", "#31688e", "#35b779", "#fde725"] },
  { id: "mono", name: "Mono", colors: ["#1f2937", "#4b5563", "#9ca3af", "#e5e7eb"] },
  { id: "warm", name: "Warm", colors: ["#7f3b08", "#d95f02", "#f0a202", "#fddc9a"] },
  { id: "cool", name: "Cool", colors: ["#023858", "#0570b0", "#74a9cf", "#d0d1e6"] },
];

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
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function render(node: React.ReactNode, layout: SurfaceLayout = bandLayout()): void {
  act(() => {
    root.render(<SurfaceLayoutProvider value={layout}>{node}</SurfaceLayoutProvider>);
  });
}

function key(el: Element, k: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** Flush the deferred focus-on-open inside act. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 2; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

function radios(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("[role='radio']"));
}

function flyout(): HTMLElement | null {
  return document.querySelector("[data-section-flyout]");
}

/** A harness that holds the value, the way a real caller does. */
function Controlled({ initial = "office", onChange }: { initial?: string; onChange?: (id: string) => void }) {
  const [value, setValue] = React.useState(initial);
  return (
    <PaletteStrip
      palettes={PALETTES}
      value={value}
      testIdPrefix="pal"
      onChange={(id) => {
        onChange?.(id);
        setValue(id);
      }}
    />
  );
}

// ============================================================================
// stripPalettes
// ============================================================================

describe("stripPalettes", () => {
  it("shows the first N, and the selected one in the last slot when it is not among them", () => {
    expect(stripPalettes(PALETTES, "office", 4).map((p) => p.id)).toEqual(["office", "tableau", "viridis", "mono"]);
    expect(stripPalettes(PALETTES, "cool", 4).map((p) => p.id)).toEqual(["office", "tableau", "viridis", "cool"]);
    expect(stripPalettes(PALETTES, "unknown", 4).map((p) => p.id)).toEqual(["office", "tableau", "viridis", "mono"]);
    expect(stripPalettes(PALETTES, "cool", 1).map((p) => p.id)).toEqual(["cool"]);
  });
});

// ============================================================================
// The strip
// ============================================================================

describe("PaletteStrip — strip", () => {
  it("is a named radiogroup of 44x28 palette buttons with four data bars each", () => {
    render(<PaletteStrip palettes={PALETTES} value="tableau" onChange={() => {}} />);
    const group = container.querySelector("[role='radiogroup']")!;
    expect(group.getAttribute("aria-label")).toBe("Colour palette");
    const r = radios();
    expect(r.map((b) => b.getAttribute("aria-label"))).toEqual(["Office", "Tableau", "Viridis", "Mono"]);
    for (const b of r) {
      const cs = getComputedStyle(b);
      expect(cs.width).toBe("44px");
      expect(cs.height).toBe("28px");
      const bars = Array.from(b.querySelectorAll<HTMLElement>("[data-colour-data]"));
      expect(bars).toHaveLength(4);
      expect(getComputedStyle(bars[0]).width).toBe("6px");
      expect(getComputedStyle(bars[0]).height).toBe("18px");
    }
    // The bars paint the palette's own first four colours, in order.
    expect(r[0].querySelectorAll<HTMLElement>("[data-colour-data]")[1].style.background).toContain(
      "rgb(237, 125, 49)",
    );
  });

  it("aria-checked marks the selection, which is the one tab stop", () => {
    render(<PaletteStrip palettes={PALETTES} value="tableau" onChange={() => {}} />);
    const r = radios();
    expect(r.map((b) => b.getAttribute("aria-checked"))).toEqual(["false", "true", "false", "false"]);
    expect(r.map((b) => b.tabIndex)).toEqual([-1, 0, -1, -1]);
  });

  it("a selected palette beyond `visible` takes the last slot", () => {
    render(<PaletteStrip palettes={PALETTES} value="cool" onChange={() => {}} />);
    expect(radios().map((b) => b.getAttribute("aria-label"))).toEqual(["Office", "Tableau", "Viridis", "Cool"]);
    expect(radios()[3].getAttribute("aria-checked")).toBe("true");
  });

  it("`visible` sets how many palettes the strip shows", () => {
    render(<PaletteStrip palettes={PALETTES} value="office" visible={5} onChange={() => {}} />);
    expect(radios()).toHaveLength(5);
  });

  it("a click chooses; clicking the chosen one is not a change", () => {
    const onChange = vi.fn();
    render(<PaletteStrip palettes={PALETTES} value="office" onChange={onChange} />);
    click(radios()[2]);
    expect(onChange).toHaveBeenCalledWith("viridis");
    click(radios()[0]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("arrow keys move AND choose, wrapping like native radios; Home/End jump", () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    act(() => radios()[0].focus());
    key(radios()[0], "ArrowRight");
    expect(onChange).toHaveBeenLastCalledWith("tableau");
    expect(document.activeElement).toBe(radios()[1]);
    expect(radios()[1].getAttribute("aria-checked")).toBe("true");
    key(radios()[1], "ArrowLeft");
    key(radios()[0], "ArrowLeft");
    expect(onChange).toHaveBeenLastCalledWith("mono");
    expect(document.activeElement).toBe(radios()[3]);
    key(radios()[3], "Home");
    expect(onChange).toHaveBeenLastCalledWith("office");
    key(radios()[0], "End");
    expect(onChange).toHaveBeenLastCalledWith("mono");
    key(radios()[3], "ArrowDown");
    expect(onChange).toHaveBeenLastCalledWith("office");
  });

  it("names each palette in a tooltip", () => {
    vi.useFakeTimers();
    try {
      render(<PaletteStrip palettes={PALETTES} value="office" onChange={() => {}} />);
      act(() => {
        radios()[1].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(document.querySelector("[role='tooltip']")?.textContent).toBe("Tableau");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["band", bandLayout()],
    ["panel", panelLayout(300)],
  ])("paints no hardcoded colour in the %s (the bars are data)", (_name, layout) => {
    render(<PaletteStrip palettes={PALETTES} value="viridis" onChange={() => {}} />, layout);
    expect(hardcodedColours(container)).toEqual([]);
  });

  it("the scan has teeth: without data-colour-data the bars are reported", () => {
    render(<PaletteStrip palettes={PALETTES} value="viridis" onChange={() => {}} />);
    container.querySelectorAll("[data-colour-data]").forEach((el) => el.removeAttribute("data-colour-data"));
    expect(hardcodedColours(container).length).toBeGreaterThan(0);
  });
});

// ============================================================================
// More palettes
// ============================================================================

describe("PaletteStrip — More palettes", () => {
  it("is a 28px icon button, absent when every palette already shows", () => {
    render(<PaletteStrip palettes={PALETTES} value="office" onChange={() => {}} testIdPrefix="pal" />);
    const more = container.querySelector<HTMLButtonElement>("[data-testid='pal-more']")!;
    expect(more.getAttribute("aria-label")).toBe("More palettes");
    expect(more.getAttribute("aria-haspopup")).toBe("dialog");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(more.style.width).toBe("28px");
    expect(more.style.height).toBe("28px");
    expect(more.querySelector("svg")).not.toBeNull();

    render(<PaletteStrip palettes={PALETTES.slice(0, 4)} value="office" onChange={() => {}} testIdPrefix="pal" />);
    expect(container.querySelector("[data-testid='pal-more']")).toBeNull();
  });

  it("opens a card popover listing every palette by name, the selected one marked", async () => {
    render(<PaletteStrip palettes={PALETTES} value="warm" onChange={() => {}} testIdPrefix="pal" />);
    click(container.querySelector("[data-testid='pal-more']")!);
    await settle();
    const pop = flyout()!;
    expect(pop).not.toBeNull();
    expect(pop.getAttribute("aria-label")).toBe("Colour palettes");
    const list = pop.querySelector("[role='listbox']")!;
    const opts = Array.from(list.querySelectorAll<HTMLButtonElement>("[role='option']"));
    expect(opts.map((o) => o.textContent)).toEqual(PALETTES.map((p) => p.name));
    expect(opts.filter((o) => o.getAttribute("aria-selected") === "true").map((o) => o.textContent)).toEqual(["Warm"]);
    // Up to eight bars per row: Office has six colours, so six.
    expect(opts[0].querySelectorAll("[data-colour-data]")).toHaveLength(6);
    // Focus lands on the selected palette.
    expect(document.activeElement).toBe(opts[4]);
    expect(container.querySelector("[data-testid='pal-more']")!.getAttribute("aria-expanded")).toBe("true");
  });

  it("choosing in the list changes, closes, and returns focus to More palettes", async () => {
    const onChange = vi.fn();
    render(<PaletteStrip palettes={PALETTES} value="office" onChange={onChange} testIdPrefix="pal" />);
    const more = container.querySelector<HTMLButtonElement>("[data-testid='pal-more']")!;
    click(more);
    await settle();
    const cool = document.querySelector<HTMLButtonElement>("[data-testid='pal-option-cool']")!;
    act(() => cool.focus());
    click(cool);
    expect(onChange).toHaveBeenCalledWith("cool");
    expect(flyout()).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it("arrows move through the two-column list without choosing", async () => {
    const onChange = vi.fn();
    render(<PaletteStrip palettes={PALETTES} value="office" onChange={onChange} testIdPrefix="pal" />);
    click(container.querySelector("[data-testid='pal-more']")!);
    await settle();
    const opts = Array.from(document.querySelectorAll<HTMLButtonElement>("[role='option']"));
    expect(document.activeElement).toBe(opts[0]);
    key(opts[0], "ArrowDown");
    expect(document.activeElement).toBe(opts[2]);
    key(opts[2], "ArrowRight");
    expect(document.activeElement).toBe(opts[3]);
    key(opts[3], "End");
    expect(document.activeElement).toBe(opts[5]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("the list's tab stop follows focus, and reopening starts on the selection again", async () => {
    render(<PaletteStrip palettes={PALETTES} value="viridis" onChange={() => {}} testIdPrefix="pal" />);
    const more = container.querySelector<HTMLButtonElement>("[data-testid='pal-more']")!;
    click(more);
    await settle();
    let opts = Array.from(document.querySelectorAll<HTMLButtonElement>("[role='option']"));
    expect(document.activeElement).toBe(opts[2]);
    key(opts[2], "ArrowDown");
    expect(opts.filter((o) => o.tabIndex === 0)).toEqual([opts[4]]);
    key(document.activeElement!, "Escape");
    click(more);
    await settle();
    opts = Array.from(document.querySelectorAll<HTMLButtonElement>("[role='option']"));
    expect(document.activeElement).toBe(opts[2]);
  });

  it("Escape closes the list and returns focus to More palettes", async () => {
    render(<PaletteStrip palettes={PALETTES} value="office" onChange={() => {}} testIdPrefix="pal" />);
    const more = container.querySelector<HTMLButtonElement>("[data-testid='pal-more']")!;
    click(more);
    await settle();
    key(document.activeElement!, "Escape");
    expect(flyout()).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it.each([
    ["band", bandLayout()],
    ["panel", panelLayout(300)],
  ])("the open list paints no hardcoded colour in the %s", async (_name, layout) => {
    render(<PaletteStrip palettes={PALETTES} value="office" onChange={() => {}} testIdPrefix="pal" />, layout);
    click(container.querySelector("[data-testid='pal-more']")!);
    await settle();
    expect(hardcodedColours(flyout()!)).toEqual([]);
  });
});
