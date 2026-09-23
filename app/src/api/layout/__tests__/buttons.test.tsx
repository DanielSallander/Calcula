// Tests for the @api/layout button atoms: Button, ToggleButton, IconButton
// (sm / md / tall, chevron, split), CommandButton (band hero vs panel button),
// Badge, and DropdownChevron. Sizes are pinned in px because the ribbon's fill
// rule is arithmetic (28 + 5 + 28 = 61): a control one pixel off breaks it.
// Every primitive is also rendered under band AND panel geometry and scanned
// for hardcoded colours — chrome must follow the skin.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SurfaceLayoutProvider, bandLayout, panelLayout, type SurfaceLayout } from "../context";
import { findHardcodedColours } from "../testing";
import {
  Button,
  ToggleButton,
  IconButton,
  CommandButton,
  DropdownChevron,
} from "../primitives/Button";
import { Badge } from "../primitives/Badge";

/**
 * findHardcodedColours with its one known false positive neutralised. The
 * colour-name alternation in testing.ts is `\b(?:white|...)\b`, and `\b`
 * matches between "white" and "-", so every `white-space: nowrap` reports
 * "-> white". Filtering those findings out is NOT safe: the helper reports only
 * the FIRST hit per rule, so a real `#333` after a white-space declaration in
 * the same rule is dropped with it (measured: a sabotaged Badge passed). So the
 * white-space declarations are removed from the stylesheet text for the
 * duration of the scan instead, and every real colour stays visible. Reported
 * to the owner of testing.ts (fix: `(?<![\w-])white(?![\w-])`); once fixed this
 * is a harmless no-op.
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

/**
 * The value `el` is DECLARED to have for `prop` by the stylesheet rules that
 * match it (last match wins — emotion emits a block's nested state rules after
 * its base rule). jsdom's getComputedStyle cannot be used for shorthands
 * written with var(): it drops `background: var(--x, ...)` and reports the
 * initial transparent, so the token a rule paints with is read from the rule.
 */
function declared(el: Element, prop: string): string {
  let value = "";
  const decl = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`);
  for (const style of Array.from(document.querySelectorAll("style"))) {
    const text = style.textContent ?? "";
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      let matches = false;
      try {
        matches = el.matches(m[1].trim());
      } catch {
        matches = false;
      }
      if (!matches) continue;
      const hit = decl.exec(m[2]);
      if (hit) value = hit[1].trim();
    }
  }
  return value;
}

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

function render(node: React.ReactNode, layout: SurfaceLayout = panelLayout(300)): void {
  act(() => {
    root.render(<SurfaceLayoutProvider value={layout}>{node}</SurfaceLayoutProvider>);
  });
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function q<T extends Element = HTMLElement>(selector: string): T {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`no element for ${selector}`);
  return el as T;
}

const LAYOUTS: Array<[string, SurfaceLayout]> = [
  ["band", bandLayout()],
  ["panel", panelLayout(300)],
];

const Icon = ({ size = 20 }: { size?: number }) => (
  <svg data-testid="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <rect x="3" y="3" width="18" height="18" rx="2" fill="currentColor" />
  </svg>
);

// ============================================================================
// Button
// ============================================================================

describe("Button", () => {
  it("md is the standard 28px control", () => {
    render(<Button data-testid="b">Edit</Button>);
    const b = q("[data-testid='b']");
    expect(b.style.height).toBe("28px");
    expect(b.style.minWidth).toBe("28px");
    expect(b.style.padding).toBe("0px 9px");
    expect(getComputedStyle(b).fontSize).toBe("12px");
    expect(getComputedStyle(b).gap).toBe("5px");
  });

  it("sm is the compact 24px control", () => {
    render(<Button size="sm" data-testid="b">Edit</Button>);
    const b = q("[data-testid='b']");
    expect(b.style.height).toBe("24px");
    expect(b.style.minWidth).toBe("24px");
    expect(b.style.padding).toBe("0px 6px");
  });

  it("uses the control radius and hover motion tokens", () => {
    render(<Button data-testid="b">Edit</Button>);
    const cs = getComputedStyle(q("[data-testid='b']"));
    expect(cs.borderRadius).toContain("--radius-control");
    expect(cs.transition).toContain("--motion-hover");
  });

  it("renders a leading icon before the label, hidden from assistive tech", () => {
    render(
      <Button data-testid="b" icon={<Icon />}>
        Edit
      </Button>,
    );
    const b = q("[data-testid='b']");
    const slot = b.firstElementChild as HTMLElement;
    expect(slot.getAttribute("aria-hidden")).toBe("true");
    expect(slot.querySelector("[data-testid='icon']")).not.toBeNull();
    expect(b.textContent).toBe("Edit");
  });

  it("grow stretches, and caller style wins", () => {
    render(
      <Button data-testid="b" grow style={{ height: 40 }}>
        Edit
      </Button>,
    );
    const b = q("[data-testid='b']");
    expect(b.style.flex).toContain("1");
    expect(b.style.height).toBe("40px");
  });

  it("passes HTML props through (title, aria-*, onClick, disabled)", () => {
    const onClick = vi.fn();
    render(
      <Button data-testid="b" title="Play" aria-describedby="x" onClick={onClick}>
        Play
      </Button>,
    );
    const b = q("[data-testid='b']");
    expect(b.getAttribute("title")).toBe("Play");
    expect(b.getAttribute("aria-describedby")).toBe("x");
    click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("forwards its ref to the <button>", () => {
    const ref = React.createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Edit</Button>);
    expect(ref.current?.tagName).toBe("BUTTON");
  });

  it("tone danger paints the danger foreground", () => {
    render(
      <>
        <Button data-testid="n">Keep</Button>
        <Button data-testid="d" tone="danger">
          Delete
        </Button>
      </>,
    );
    expect(getComputedStyle(q("[data-testid='d']")).color).toContain("--tone-danger-fg");
    expect(getComputedStyle(q("[data-testid='n']")).color).not.toContain("--tone-danger-fg");
  });

  it("outlined draws the control border on a surface", () => {
    render(
      <Button data-testid="b" variant="outlined">
        OK
      </Button>,
    );
    const b = q("[data-testid='b']");
    expect(declared(b, "border-color")).toContain("--control-border");
    expect(declared(b, "background")).toContain("--bg-surface");
  });

  it("disabled uses the one disabled idiom (opacity .5)", () => {
    render(
      <Button data-testid="b" disabled>
        Redo
      </Button>,
    );
    const b = q<HTMLButtonElement>("[data-testid='b']");
    expect(b.disabled).toBe(true);
    expect(getComputedStyle(b).opacity).toBe("0.5");
  });

  it.each(LAYOUTS)("paints no hardcoded colour in the %s", (_name, layout) => {
    render(
      <>
        <Button icon={<Icon />}>Edit</Button>
        <Button variant="outlined">OK</Button>
        <Button tone="danger">Delete</Button>
        <Button size="sm" disabled>
          Redo
        </Button>
      </>,
      layout,
    );
    expect(hardcodedColours(container)).toEqual([]);
  });
});

// ============================================================================
// ToggleButton
// ============================================================================

describe("ToggleButton", () => {
  it("drives aria-pressed from active, and the pressed look from aria-pressed", () => {
    render(
      <>
        <ToggleButton data-testid="on" active>
          B
        </ToggleButton>
        <ToggleButton data-testid="off" active={false}>
          I
        </ToggleButton>
      </>,
    );
    const on = q("[data-testid='on']");
    const off = q("[data-testid='off']");
    expect(on.getAttribute("aria-pressed")).toBe("true");
    expect(off.getAttribute("aria-pressed")).toBe("false");
    expect(declared(on, "background")).toContain("--button-pressed-bg");
    expect(declared(on, "border-color")).toContain("--button-pressed-border");
    expect(declared(off, "background")).toContain("--button-bg");
    expect(declared(off, "background")).not.toContain("--button-pressed-bg");
  });

  it("keeps the Home tab's data attributes", () => {
    render(
      <ToggleButton active data-testid="fmt-bold" data-active title="Bold">
        B
      </ToggleButton>,
    );
    const b = q("[data-testid='fmt-bold']");
    expect(b.hasAttribute("data-active")).toBe(true);
    expect(b.getAttribute("title")).toBe("Bold");
  });

  it.each(LAYOUTS)("paints no hardcoded colour in the %s", (_name, layout) => {
    render(
      <>
        <ToggleButton active>B</ToggleButton>
        <ToggleButton active={false}>I</ToggleButton>
      </>,
      layout,
    );
    expect(hardcodedColours(container)).toEqual([]);
  });
});

// ============================================================================
// IconButton
// ============================================================================

describe("IconButton", () => {
  it.each([
    ["sm", "24px", "24px"],
    ["md", "28px", "28px"],
    ["tall", "44px", "61px"],
  ] as const)("%s is %s wide and %s tall", (size, width, height) => {
    render(<IconButton data-testid="b" size={size} icon={<Icon />} label="Palette" />);
    const b = q("[data-testid='b']");
    expect(b.style.width).toBe(width);
    expect(b.style.minWidth).toBe(width);
    expect(b.style.height).toBe(height);
    expect(b.style.padding).toBe("0px");
  });

  it("defaults to md", () => {
    render(<IconButton data-testid="b" icon={<Icon />} label="Palette" />);
    expect(q("[data-testid='b']").style.height).toBe("28px");
  });

  it("is named by aria-label, with no automatic title and no text", () => {
    render(<IconButton data-testid="b" icon={<Icon />} label="Palette" />);
    const b = q("[data-testid='b']");
    expect(b.getAttribute("aria-label")).toBe("Palette");
    expect(b.hasAttribute("title")).toBe(false);
    expect(b.textContent).toBe("");
  });

  it("passes an explicit title through", () => {
    render(<IconButton data-testid="b" icon={<Icon />} label="Play" title="Play" />);
    expect(q("[data-testid='b']").getAttribute("title")).toBe("Play");
  });

  it("carries aria-pressed only when pressed is defined", () => {
    render(
      <>
        <IconButton data-testid="plain" icon={<Icon />} label="Refresh" />
        <IconButton data-testid="on" icon={<Icon />} label="Gridlines" pressed />
        <IconButton data-testid="off" icon={<Icon />} label="Legend" pressed={false} />
      </>,
    );
    expect(q("[data-testid='plain']").hasAttribute("aria-pressed")).toBe(false);
    expect(q("[data-testid='on']").getAttribute("aria-pressed")).toBe("true");
    expect(q("[data-testid='off']").getAttribute("aria-pressed")).toBe("false");
  });

  it("passes role/aria-checked through for radio use", () => {
    render(
      <IconButton data-testid="b" icon={<Icon />} label="Stacked" role="radio" aria-checked />,
    );
    const b = q("[data-testid='b']");
    expect(b.getAttribute("role")).toBe("radio");
    expect(b.getAttribute("aria-checked")).toBe("true");
    expect(b.hasAttribute("aria-pressed")).toBe(false);
  });

  it("an inline chevron widens a short button from its square minimum", () => {
    render(<IconButton data-testid="b" icon={<Icon />} label="More" chevron />);
    const b = q("[data-testid='b']");
    expect(b.style.width).toBe("");
    expect(b.style.minWidth).toBe("28px");
    expect(b.querySelectorAll("svg")).toHaveLength(2);
  });

  it("a tall chevron button stacks icon over chevron at 44x61", () => {
    render(<IconButton data-testid="b" size="tall" icon={<Icon size={28} />} label="Title" chevron />);
    const b = q("[data-testid='b']");
    expect(b.style.width).toBe("44px");
    expect(b.style.height).toBe("61px");
    expect(getComputedStyle(b).flexDirection).toBe("column");
  });

  it("forwards its ref to the <button>", () => {
    const ref = React.createRef<HTMLButtonElement>();
    render(<IconButton ref={ref} icon={<Icon />} label="Palette" />);
    expect(ref.current?.getAttribute("aria-label")).toBe("Palette");
  });

  describe("split", () => {
    it("renders span.split with a main button and a named chevron button", () => {
      const onClick = vi.fn();
      const onChevronClick = vi.fn();
      render(
        <IconButton
          data-testid="legend"
          icon={<Icon />}
          label="Legend"
          pressed
          split
          onClick={onClick}
          onChevronClick={onChevronClick}
        />,
      );
      const wrap = container.firstElementChild as HTMLElement;
      expect(wrap.tagName).toBe("SPAN");
      expect(wrap.classList.contains("split")).toBe(true);
      const [main, chev] = Array.from(wrap.children) as HTMLElement[];
      expect(wrap.children).toHaveLength(2);
      expect(main.tagName).toBe("BUTTON");
      expect(chev.tagName).toBe("BUTTON");
      expect(main.getAttribute("data-testid")).toBe("legend");
      expect(main.getAttribute("aria-label")).toBe("Legend");
      expect(main.getAttribute("aria-pressed")).toBe("true");
      expect(chev.getAttribute("aria-label")).toBe("Legend options");
      expect(chev.hasAttribute("aria-pressed")).toBe(false);
      // Stable hooks for a containing Segmented's first/last/divider rules.
      expect(main.classList.contains("split-main")).toBe(true);
      expect(chev.classList.contains("split-chevron")).toBe(true);

      click(main);
      expect(onClick).toHaveBeenCalledTimes(1);
      expect(onChevronClick).not.toHaveBeenCalled();
      click(chev);
      expect(onChevronClick).toHaveBeenCalledTimes(1);
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("uses chevronLabel when given", () => {
      render(
        <IconButton
          icon={<Icon />}
          label="Data labels"
          split
          chevronLabel="Data label options"
          onChevronClick={() => undefined}
        />,
      );
      const chev = container.querySelectorAll("button")[1];
      expect(chev.getAttribute("aria-label")).toBe("Data label options");
    });

    it("md: main 28x28, chevron 16x28", () => {
      render(<IconButton icon={<Icon />} label="Legend" split onChevronClick={() => undefined} />);
      const [main, chev] = Array.from(container.querySelectorAll("button"));
      expect([main.style.width, main.style.height]).toEqual(["28px", "28px"]);
      expect([chev.style.width, chev.style.height]).toEqual(["16px", "28px"]);
    });

    it("tall: main 44x61, chevron 16x61", () => {
      render(
        <IconButton
          icon={<Icon size={28} />}
          label="Title"
          size="tall"
          split
          onChevronClick={() => undefined}
        />,
      );
      const [main, chev] = Array.from(container.querySelectorAll("button"));
      expect([main.style.width, main.style.height]).toEqual(["44px", "61px"]);
      expect([chev.style.width, chev.style.height]).toEqual(["16px", "61px"]);
    });

    it("chevronProps reach the chevron but cannot rename it", () => {
      const chevronProps = {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- DOM attribute names
        "data-testid": "legend-chev",
        // eslint-disable-next-line @typescript-eslint/naming-convention -- DOM attribute names
        "aria-expanded": true,
        // eslint-disable-next-line @typescript-eslint/naming-convention -- DOM attribute names
        "aria-label": "Renamed",
      } as React.ButtonHTMLAttributes<HTMLButtonElement>;
      render(
        <IconButton
          icon={<Icon />}
          label="Legend"
          split
          onChevronClick={() => undefined}
          chevronProps={chevronProps}
        />,
      );
      const chev = q("[data-testid='legend-chev']");
      expect(chev.getAttribute("aria-expanded")).toBe("true");
      expect(chev.getAttribute("aria-label")).toBe("Legend options");
    });

    it("a chevron with no handler is disabled rather than dead", () => {
      render(<IconButton icon={<Icon />} label="Legend" split />);
      const [main, chev] = Array.from(container.querySelectorAll("button"));
      expect(main.disabled).toBe(false);
      expect(chev.disabled).toBe(true);
    });

    it("disabled disables both halves", () => {
      render(
        <IconButton icon={<Icon />} label="Legend" split disabled onChevronClick={() => undefined} />,
      );
      const buttons = Array.from(container.querySelectorAll("button"));
      expect(buttons.every((b) => b.disabled)).toBe(true);
    });
  });

  it.each(LAYOUTS)("paints no hardcoded colour in the %s", (_name, layout) => {
    render(
      <>
        <IconButton icon={<Icon />} label="Palette" size="sm" />
        <IconButton icon={<Icon />} label="Gridlines" pressed />
        <IconButton icon={<Icon />} label="More" chevron />
        <IconButton icon={<Icon size={28} />} label="Title" size="tall" chevron />
        <IconButton icon={<Icon />} label="Legend" split pressed onChevronClick={() => undefined} />
        <IconButton icon={<Icon />} label="Delete" tone="danger" variant="outlined" />
      </>,
      layout,
    );
    expect(hardcodedColours(container)).toEqual([]);
  });
});

// ============================================================================
// CommandButton
// ============================================================================

describe("CommandButton", () => {
  it("band: a 61px column hero whose only text is icon + label", () => {
    render(<CommandButton icon="P" label="Paste" data-testid="hero" />, bandLayout());
    const b = q("button[data-testid='hero']");
    expect(b.textContent).toBe("PPaste");
    expect(b.style.height).toBe("");
    const cs = getComputedStyle(b);
    expect(cs.flexDirection).toBe("column");
    expect(cs.height).toBe("61px");
    expect(cs.minWidth).toBe("58px");
    expect(cs.padding).toBe("6px 10px");
  });

  it("band: 34px icon slot and an 11px/500 ellipsised label", () => {
    render(<CommandButton icon={<Icon size={30} />} label="Save Image" data-testid="hero" />, bandLayout());
    const b = q("button[data-testid='hero']");
    const [slot, label] = Array.from(b.children) as HTMLElement[];
    expect(slot.getAttribute("aria-hidden")).toBe("true");
    expect(getComputedStyle(slot).width).toBe("34px");
    expect(getComputedStyle(slot).height).toBe("34px");
    const lcs = getComputedStyle(label);
    expect(lcs.fontSize).toBe("11px");
    expect(lcs.fontWeight).toBe("500");
    expect(lcs.lineHeight).toBe("13px");
    expect(lcs.maxWidth).toBe("92px");
    const text = label.firstElementChild as HTMLElement;
    expect(text.textContent).toBe("Save Image");
    expect(getComputedStyle(text).textOverflow).toBe("ellipsis");
  });

  it("band: chevron follows the label", () => {
    render(<CommandButton icon="S" label="Styles" chevron data-testid="hero" />, bandLayout());
    const b = q("button[data-testid='hero']");
    const label = b.lastElementChild as HTMLElement;
    expect(label.querySelector("svg")).not.toBeNull();
    expect(b.textContent).toBe("SStyles");
  });

  it("band: active drives aria-pressed", () => {
    render(
      <>
        <CommandButton icon="F" label="Filter" active data-testid="on" />
        <CommandButton icon="F" label="Filter" data-testid="plain" />
      </>,
      bandLayout(),
    );
    expect(q("[data-testid='on']").getAttribute("aria-pressed")).toBe("true");
    expect(q("[data-testid='plain']").hasAttribute("aria-pressed")).toBe(false);
  });

  it("band: badge sits in the icon slot, hidden from assistive tech", () => {
    render(<CommandButton icon="F" label="Filter" badge={3} data-testid="hero" />, bandLayout());
    const b = q("button[data-testid='hero']");
    const slot = b.firstElementChild as HTMLElement;
    const badge = slot.querySelector("[data-tone]") as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe("3");
    expect(badge.getAttribute("aria-hidden")).toBe("true");
    expect(getComputedStyle(badge).position).toBe("absolute");
  });

  it("panel: a standard 28px inline button", () => {
    render(<CommandButton icon="P" label="Paste" data-testid="hero" />);
    const b = q("button[data-testid='hero']");
    expect(getComputedStyle(b).flexDirection).not.toBe("column");
    expect(b.style.height).toBe("28px");
    expect(b.textContent).toBe("PPaste");
  });

  it("panel: fits a band-sized icon to 20px", () => {
    render(<CommandButton icon={<Icon size={30} />} label="Paste" data-testid="hero" />);
    const svg = q("button[data-testid='hero'] svg");
    expect(getComputedStyle(svg).width).toBe("20px");
  });

  it("popover container renders the panel form too", () => {
    render(<CommandButton icon="P" label="Paste" data-testid="hero" />, {
      ...panelLayout(200),
      container: "popover",
    });
    expect(q("button[data-testid='hero']").style.height).toBe("28px");
  });

  it("forwards its ref in both forms", () => {
    const bandRef = React.createRef<HTMLButtonElement>();
    render(<CommandButton ref={bandRef} icon="P" label="Paste" />, bandLayout());
    expect(bandRef.current?.tagName).toBe("BUTTON");
    const panelRef = React.createRef<HTMLButtonElement>();
    render(<CommandButton ref={panelRef} icon="P" label="Paste" />);
    expect(panelRef.current?.tagName).toBe("BUTTON");
  });

  it.each(LAYOUTS)("paints no hardcoded colour in the %s", (_name, layout) => {
    render(
      <>
        <CommandButton icon={<Icon size={30} />} label="Paste" />
        <CommandButton icon={<Icon size={30} />} label="Filter" badge="3" active />
        <CommandButton icon={<Icon size={30} />} label="Styles" chevron disabled />
      </>,
      layout,
    );
    expect(hardcodedColours(container)).toEqual([]);
  });
});

// ============================================================================
// Badge
// ============================================================================

describe("Badge", () => {
  it("is a pill: min-width and height equal size, radius half of it", () => {
    render(<Badge data-testid="b">3</Badge>);
    const b = q("[data-testid='b']");
    expect(b.style.minWidth).toBe("14px");
    expect(b.style.height).toBe("14px");
    expect(b.style.borderRadius).toBe("7px");
    expect(b.style.fontSize).toBe("9px");
    expect(getComputedStyle(b).fontWeight).toBe("600");
    expect(getComputedStyle(b).padding).toBe("0px 4px");
  });

  it("size 16 grows the font to 10px", () => {
    render(<Badge data-testid="b" size={16}>12</Badge>);
    const b = q("[data-testid='b']");
    expect(b.style.height).toBe("16px");
    expect(b.style.borderRadius).toBe("8px");
    expect(b.style.fontSize).toBe("10px");
  });

  it("tones: accent uses the badge tokens, danger the danger foreground", () => {
    render(
      <>
        <Badge data-testid="a">1</Badge>
        <Badge data-testid="d" tone="danger">
          2
        </Badge>
        <Badge data-testid="n" tone="neutral">
          3
        </Badge>
      </>,
    );
    const a = q("[data-testid='a']");
    const d = q("[data-testid='d']");
    expect(declared(a, "background")).toContain("--badge-bg");
    expect(declared(a, "color")).toContain("--badge-fg");
    expect(declared(d, "background")).toContain("--tone-danger-fg");
    expect(declared(d, "color")).toContain("--badge-fg");
    expect(q("[data-testid='n']").getAttribute("data-tone")).toBe("neutral");
  });

  it("is content unless the caller hides it", () => {
    render(<Badge data-testid="b">3</Badge>);
    expect(q("[data-testid='b']").hasAttribute("aria-hidden")).toBe(false);
  });

  it.each(LAYOUTS)("paints no hardcoded colour in the %s", (_name, layout) => {
    render(
      <>
        <Badge>1</Badge>
        <Badge tone="danger" size={16}>
          2
        </Badge>
        <Badge tone="neutral">3</Badge>
      </>,
      layout,
    );
    expect(hardcodedColours(container)).toEqual([]);
  });
});

// ============================================================================
// DropdownChevron
// ============================================================================

describe("DropdownChevron", () => {
  it("defaults to 9px and takes an explicit size", () => {
    render(
      <>
        <DropdownChevron />
        <DropdownChevron size={7} />
      </>,
    );
    const [a, b] = Array.from(container.querySelectorAll("svg"));
    expect(a.getAttribute("width")).toBe("9");
    expect(b.getAttribute("width")).toBe("7");
    expect(a.getAttribute("aria-hidden")).toBe("true");
  });

  it("paints with currentColor only", () => {
    render(<DropdownChevron />);
    expect(hardcodedColours(container)).toEqual([]);
    expect(container.querySelector("path")?.getAttribute("fill")).toBe("currentColor");
  });
});
