//! FILENAME: app/extensions/Animation/__tests__/timelineSections.test.tsx
// PURPOSE: The Animation panel after the Calcula Clusters rebuild — the
//          reference DUAL-SURFACE panel — on both surfaces: token-painted, the
//          band obeying the fill rule, and the E2E contracts intact.
// CONTEXT: Pins the brief: the raw range became the @api Slider, the loop
//          checkbox became a "Loop: On/Off" Chip that toggles, the unicode close
//          glyph became an IconButton, the error red became a token, and the
//          transport buttons keep their exact `title`s because the journeys
//          select them by title (animation.spec, panel-placement.spec,
//          dirty-flag.spec).

/* eslint-disable @typescript-eslint/naming-convention --
 * The module doubles below stand in for React components and the @api
 * ExtensionRegistry singleton, whose real names are PascalCase; a camelCase
 * double would simply not be the export the sections import. */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  findHardcodedColours,
  type SurfaceLayout,
} from "@api/layout";
import type { PanelDefinition } from "@api/uiTypes";

type State = {
  status: "idle" | "playing" | "paused";
  frame: number;
  frameCount: number;
  fps: number;
  loop: boolean;
  rangeStart: number;
  rangeEnd: number;
  frameLabel: string | null;
};

const m = vi.hoisted(() => {
  const listeners = new Set<(s: unknown) => void>();
  return {
    state: null as unknown as {
      status: "idle" | "playing" | "paused";
      frame: number;
      frameCount: number;
      fps: number;
      loop: boolean;
      rangeStart: number;
      rangeEnd: number;
      frameLabel: string | null;
    },
    listeners,
    specs: [] as Array<{ id: string; name: string }>,
    mcActive: false,
    engine: {
      getState: () => m.state,
      subscribe: (cb: (s: unknown) => void) => {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
      step: vi.fn(async () => {}),
      play: vi.fn(),
      pause: vi.fn(),
      stop: vi.fn(async () => {}),
      clearDriver: vi.fn(async () => {}),
      seek: vi.fn(async () => {}),
      setFps: vi.fn(),
      setLoop: vi.fn(),
      loadSpec: vi.fn(async () => {}),
      setClockCellDriver: vi.fn(async () => {}),
      getExportSource: vi.fn(() => null),
      stopAndRestore: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    },
    deleteAnimation: vi.fn(async () => {}),
    showDialog: vi.fn(),
    registerStatusBarItem: vi.fn(),
    unregisterStatusBarItem: vi.fn(),
    registerDialog: vi.fn(),
    unregisterDialog: vi.fn(),
    registerMenuItem: vi.fn(),
    unregisterMenuItem: vi.fn(),
  };
});

vi.mock("../lib/animationEngine", () => ({ playbackEngine: m.engine }));
vi.mock("../lib/animationStore", () => ({
  listAnimations: () => m.specs,
  subscribeAnimations: () => () => {},
  deleteAnimation: m.deleteAnimation,
  loadAnimations: vi.fn(async () => {}),
  resetAnimations: vi.fn(),
}));
vi.mock("../lib/gifExporter", () => ({ exportAnimationGif: vi.fn(async () => ({ ok: true, path: "x.gif" })) }));
vi.mock("../lib/webmExporter", () => ({
  exportAnimationWebm: vi.fn(async () => ({ ok: true, path: "x.webm" })),
  isWebmRecordingSupported: () => true,
}));
vi.mock("../lib/monteCarloStore", () => ({ mcActive: () => m.mcActive }));
vi.mock("../lib/animationBackend", () => ({ animationBackend: { set: vi.fn() } }));
vi.mock("../components/MonteCarloView", () => ({ MonteCarloView: () => <div>histogram</div> }));
vi.mock("../components/AnimationDialog", () => ({
  ANIMATION_DIALOG_ID: "animation-dialog",
  AnimationDialog: () => null,
}));
vi.mock("../components/TransportStatusItem", () => ({ TransportStatusItem: () => null }));
vi.mock("../overlay/playOverlay", () => ({ installPlayOverlay: () => () => {} }));
vi.mock("@api/lib", () => ({ getActiveSheet: vi.fn(async () => 0) }));
vi.mock("@api/ui", () => ({
  showDialog: m.showDialog,
  registerStatusBarItem: m.registerStatusBarItem,
  unregisterStatusBarItem: m.unregisterStatusBarItem,
  registerDialog: m.registerDialog,
  unregisterDialog: m.unregisterDialog,
  registerMenuItem: m.registerMenuItem,
  unregisterMenuItem: m.unregisterMenuItem,
}));
vi.mock("@api", () => ({
  ExtensionRegistry: { onSelectionChange: () => () => {} },
}));

import {
  DriverSection,
  ExportSection,
  SavedAnimationsSection,
  TransportSection,
} from "../components/TimelineSections";
import extension from "../index";

const IDLE: State = {
  status: "idle",
  frame: 0,
  frameCount: 0,
  fps: 12,
  loop: false,
  rangeStart: 0,
  rangeEnd: 0,
  frameLabel: null,
};

const LOADED: State = {
  status: "paused",
  frame: 1,
  frameCount: 5,
  fps: 12,
  loop: true,
  rangeStart: 0,
  rangeEnd: 4,
  frameLabel: "t = 1",
};

let container: HTMLDivElement;
let root: Root;

function render(node: React.ReactNode, layout: SurfaceLayout): void {
  act(() => {
    root.render(<SurfaceLayoutProvider value={layout}>{node}</SurfaceLayoutProvider>);
  });
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function q<T extends Element = HTMLElement>(selector: string): T {
  const el = container.querySelector<T>(selector);
  if (!el) throw new Error(`no element for ${selector}`);
  return el;
}

/** The section's outermost element, whose element children are its rows. */
function sectionRoot(): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

const LAYOUTS: Array<[string, SurfaceLayout]> = [
  ["band", bandLayout()],
  ["panel", panelLayout(300)],
];

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  m.state = { ...LOADED };
  m.specs = [];
  m.mcActive = false;
  for (const fn of Object.values(m.engine)) {
    if (typeof fn === "function" && "mockClear" in fn) (fn as { mockClear(): void }).mockClear();
  }
  m.deleteAnimation.mockClear();
  m.showDialog.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("Animation — every section is token-painted on both surfaces", () => {
  const SECTIONS: Array<[string, React.ComponentType<{ placement: "ribbon" | "sidebar" }>]> = [
    ["saved", SavedAnimationsSection],
    ["driver", DriverSection],
    ["transport", TransportSection],
    ["export", ExportSection],
  ];

  for (const [name, Section] of SECTIONS) {
    it.each(LAYOUTS)(`${name} in the %s`, (_n, layout) => {
      m.specs = [{ id: "a1", name: "Sweep" }];
      render(<Section placement={layout.container === "band" ? "ribbon" : "sidebar"} />, layout);
      expect(findHardcodedColours(container)).toEqual([]);
    });
  }
});

describe("Animation — transport", () => {
  it.each(LAYOUTS)("keeps the transport buttons' exact titles in the %s (the journeys select by title)", (_n, layout) => {
    render(<TransportSection placement="ribbon" />, layout);
    for (const title of ["Step back", "Play", "Stop (reset)", "Step forward"]) {
      const button = q<HTMLButtonElement>(`button[title="${title}"]`);
      // Named for assistive tech too, and no second (custom) tooltip.
      expect(button.getAttribute("aria-label")).toBe(title);
      expect(button.querySelector("svg")).not.toBeNull();
      expect(button.textContent).toBe("");
    }
    expect(q('[data-testid="anim-clear-driver"]').getAttribute("title")).toBe(
      "Unload driver (restores the model and hides the play pill)",
    );
    expect(q('[data-testid="anim-frame"]').textContent).toBe("2 / 5");
  });

  it("Play becomes Pause while playing", () => {
    m.state = { ...LOADED, status: "playing" };
    render(<TransportSection placement="ribbon" />, bandLayout());
    expect(container.querySelector('button[title="Play"]')).toBeNull();
    click(q('button[title="Pause"]'));
    expect(m.engine.pause).toHaveBeenCalled();
  });

  it("the transport drives the engine", () => {
    render(<TransportSection placement="ribbon" />, bandLayout());
    click(q('button[title="Step forward"]'));
    click(q('button[title="Step back"]'));
    click(q('button[title="Play"]'));
    click(q('button[title="Stop (reset)"]'));
    click(q('[data-testid="anim-clear-driver"]'));
    expect(m.engine.step).toHaveBeenCalledWith(1);
    expect(m.engine.step).toHaveBeenCalledWith(-1);
    expect(m.engine.play).toHaveBeenCalled();
    expect(m.engine.stop).toHaveBeenCalled();
    expect(m.engine.clearDriver).toHaveBeenCalled();
  });

  it("with no driver everything is disabled and the readout says so", () => {
    m.state = { ...IDLE };
    render(<TransportSection placement="ribbon" />, bandLayout());
    for (const title of ["Step back", "Play", "Stop (reset)", "Step forward"]) {
      expect(q<HTMLButtonElement>(`button[title="${title}"]`).disabled).toBe(true);
    }
    expect(q<HTMLButtonElement>('[data-testid="anim-clear-driver"]').disabled).toBe(true);
    expect(q<HTMLInputElement>('[data-testid="anim-scrubber"]').disabled).toBe(true);
    expect(q('[data-testid="anim-frame"]').textContent).toBe("no driver");
  });

  it("the band is TWO rows (fill rule); the sidebar gives the scrubber a row of its own", () => {
    render(<TransportSection placement="ribbon" />, bandLayout());
    const bandRows = Array.from(sectionRoot().children);
    expect(bandRows).toHaveLength(2);
    expect(bandRows[1].querySelector('input[type="range"]')).not.toBeNull();

    render(<TransportSection placement="sidebar" />, panelLayout(300));
    expect(sectionRoot().children).toHaveLength(3);
  });

  it("the Monte Carlo histogram is a launcher in the band, never a third row", () => {
    m.mcActive = true;
    render(<TransportSection placement="ribbon" />, bandLayout());
    const children = Array.from(sectionRoot().children);
    // Two rows + the 61px launcher the band Stack wraps into its own column.
    expect(children).toHaveLength(3);
    expect(container.querySelector('[data-testid="anim-mc-block"]')).not.toBeNull();
    expect(container.textContent).not.toContain("histogram");
  });

  it("the scrubber is the @api Slider and seeks", () => {
    render(<TransportSection placement="ribbon" />, bandLayout());
    const range = q<HTMLInputElement>('[data-testid="anim-scrubber"]');
    expect(range.type).toBe("range");
    expect(range.min).toBe("0");
    expect(range.max).toBe("4");
    expect(range.getAttribute("aria-label")).toBe("Frame");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(range, "3");
      range.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(m.engine.seek).toHaveBeenCalledWith(3);
  });

  it("loop is a Chip reading 'Loop: On/Off' that toggles", () => {
    render(<TransportSection placement="ribbon" />, bandLayout());
    const chip = q<HTMLButtonElement>('[data-testid="anim-loop"]');
    expect(chip.textContent).toBe("Loop: On");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    click(chip);
    expect(m.engine.setLoop).toHaveBeenCalledWith(false);

    m.state = { ...LOADED, loop: false };
    act(() => {
      for (const l of Array.from(m.listeners)) l(m.state);
    });
    expect(q('[data-testid="anim-loop"]').textContent).toBe("Loop: Off");
    click(q('[data-testid="anim-loop"]'));
    expect(m.engine.setLoop).toHaveBeenLastCalledWith(true);
  });

  it("fps is a NumberField that sets the engine's rate", () => {
    render(<TransportSection placement="sidebar" />, panelLayout(300));
    const fps = q<HTMLInputElement>('[data-testid="anim-fps"]');
    expect(fps.type).toBe("number");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(fps, "24");
      fps.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(m.engine.setFps).toHaveBeenCalledWith(24);
  });
});

describe("Animation — saved list, driver, export", () => {
  it("a saved animation is deleted with a named IconButton, not a unicode glyph", () => {
    m.specs = [{ id: "a1", name: "Sweep" }];
    render(<SavedAnimationsSection placement="sidebar" />, panelLayout(300));
    expect(container.textContent).not.toContain("✕");
    const del = q<HTMLButtonElement>('[data-testid="anim-delete-a1"]');
    expect(del.getAttribute("aria-label")).toBe("Delete");
    expect(del.querySelector("svg")).not.toBeNull();
    click(del);
    expect(m.deleteAnimation).toHaveBeenCalledWith("a1");
  });

  it("the saved list is a launcher in the band (its E2E testid intact)", () => {
    render(<SavedAnimationsSection placement="ribbon" />, bandLayout());
    const launcher = q('[data-testid="anim-saved-list"]');
    expect(launcher.tagName).toBe("BUTTON");
    expect(container.querySelector('[data-testid="anim-new"]')).toBeNull();
  });

  it("the driver section is two rows in the band and reports errors in the danger token", async () => {
    render(<DriverSection placement="ribbon" />, bandLayout());
    expect(sectionRoot().children).toHaveLength(2);

    const cell = q<HTMLInputElement>('[data-testid="anim-driver-cell"]');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(cell, "not a cell");
      cell.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click(q('[data-testid="anim-set-driver"]'));
    await flush();
    const error = q('[data-testid="anim-driver-error"]');
    expect(error.textContent).toBe("Enter a driver cell like B1");
    expect(error.getAttribute("style")).toContain("var(--tone-danger-fg");
    expect(findHardcodedColours(container)).toEqual([]);
    expect(m.engine.setClockCellDriver).not.toHaveBeenCalled();
  });

  it("a valid driver is handed to the engine", async () => {
    render(<DriverSection placement="sidebar" />, panelLayout(300));
    click(q('[data-testid="anim-set-driver"]'));
    await flush();
    expect(m.engine.setClockCellDriver).toHaveBeenCalledWith({
      sheetIndex: 0,
      row: 0,
      col: 1,
      from: 0,
      to: 100,
      step: 1,
    });
  });

  it.each(LAYOUTS)("export is two heroes named 'Export GIF' / 'Export WebM' in the %s", (_n, layout) => {
    render(<ExportSection placement="ribbon" />, layout);
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.map((b) => b.textContent)).toEqual(["Export GIF", "Export WebM"]);
    expect(buttons.every((b) => !b.disabled)).toBe(true);
    expect(buttons.every((b) => b.querySelector("svg") !== null)).toBe(true);
  });
});

describe("Animation — panel registration", () => {
  it("stays the sidebar-default, movable dual-surface panel with an icon on every section", () => {
    const registered: PanelDefinition[] = [];
    const ctx = {
      invokeBackend: vi.fn(),
      ui: {
        panels: {
          register: (def: PanelDefinition) => registered.push(def),
          unregister: vi.fn(),
          open: vi.fn(),
        },
      },
    };
    extension.activate(ctx as unknown as Parameters<typeof extension.activate>[0]);
    try {
      expect(registered).toHaveLength(1);
      const panel = registered[0];
      expect(panel.id).toBe("animation.timeline");
      expect(panel.defaultPlacement).toBe("sidebar");
      expect(panel.movable).not.toBe(false);
      expect(panel.supportedPlacements).toBeUndefined();
      expect(panel.sections.map((s) => s.id)).toEqual([
        "animation.timeline.saved",
        "animation.timeline.driver",
        "animation.timeline.playback",
        "animation.timeline.export",
      ]);
      for (const s of panel.sections) expect(React.isValidElement(s.icon)).toBe(true);
    } finally {
      extension.deactivate?.();
    }
  });
});
