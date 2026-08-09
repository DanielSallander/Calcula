//! FILENAME: app/extensions/Animation/overlay/__tests__/PlayPill.test.tsx
// PURPOSE: The pill's own behaviour — it is viewport-pinned chrome, and its
//          close affordance is a real product route to `clearDriver`.
// CONTEXT: §2q / D4. Before this, a loaded driver put a hit-testable control on
//          A1:C2 and there was NO way in the product to unload it. Both halves
//          are pinned here: the pill is fixed-position DOM chrome, and clicking
//          its close control leaves the engine with no driver.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PlayPill } from "../PlayPill";
import { pillPosition } from "../pillGeometry";
import { playbackEngine } from "../../lib/animationEngine";
import { animationBackend } from "../../lib/animationBackend";

const CLOCK_DRIVER = { sheetIndex: 0, row: 0, col: 1, from: 0, to: 10, step: 1 };

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(React.createElement(PlayPill));
  });
}

function byTestId(id: string): HTMLElement | null {
  return container?.querySelector(`[data-testid="${id}"]`) ?? null;
}

beforeEach(() => {
  animationBackend.set(
    vi.fn().mockImplementation(async (cmd: string) =>
      cmd === "anim_snapshot" ? { success: true, error: null } : { updatedCells: [], error: null },
    ),
  );
});

afterEach(async () => {
  if (root) {
    const r = root;
    await act(async () => {
      r.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  await playbackEngine.clearDriver();
});

describe("pillPosition", () => {
  it("pins to the grid canvas's bottom-left corner, not the window's", () => {
    // A canvas inset by a 320px side panel and sitting 120px above the window
    // bottom (sheet tabs + status bar). The pill follows the CANVAS, which is
    // what keeps it from fighting the panel/layout system.
    expect(pillPosition({ left: 320, bottom: 880 }, 1000)).toEqual({ left: 332, bottom: 132 });
  });

  it("falls back to the window's bottom-left when no grid is mounted", () => {
    expect(pillPosition(null, 1000)).toEqual({ left: 12, bottom: 64 });
  });

  it("never produces a negative offset for a canvas taller than the window", () => {
    expect(pillPosition({ left: 0, bottom: 1200 }, 1000).bottom).toBe(0);
  });
});

describe("PlayPill", () => {
  it("renders nothing until a driver is loaded", async () => {
    await playbackEngine.clearDriver();
    mount();
    expect(byTestId("anim-play-pill")).toBeNull();
  });

  it("is fixed-positioned chrome (it occupies no grid coordinates)", async () => {
    await playbackEngine.setClockCellDriver(CLOCK_DRIVER);
    mount();
    const pill = byTestId("anim-play-pill") as HTMLElement;
    expect(pill).not.toBeNull();
    expect(pill.style.position).toBe("fixed");
    expect(byTestId("anim-pill-frame")?.textContent).toBe("1/11");
  });

  it("the close affordance unloads the driver and the pill disappears", async () => {
    await playbackEngine.setClockCellDriver(CLOCK_DRIVER);
    mount();
    expect(byTestId("anim-play-pill")).not.toBeNull();

    // Only the CLICK. Nothing else in this test touches the engine — calling
    // clearDriver here "to settle it" would make the assertion vacuous, which is
    // the trap §3ak caught elsewhere in this program.
    await act(async () => {
      (byTestId("anim-pill-close") as HTMLElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(playbackEngine.getState().frameCount).toBe(0);
    expect(byTestId("anim-play-pill")).toBeNull();
  });

  it("the toggle plays and pauses, and pausing does NOT unload", async () => {
    await playbackEngine.setClockCellDriver(CLOCK_DRIVER);
    mount();

    await act(async () => {
      (byTestId("anim-pill-toggle") as HTMLElement).click();
      await Promise.resolve();
    });
    expect(playbackEngine.getState().status).toBe("playing");

    await act(async () => {
      (byTestId("anim-pill-toggle") as HTMLElement).click();
      await Promise.resolve();
    });
    expect(playbackEngine.getState().status).toBe("paused");
    expect(playbackEngine.getState().frameCount).toBe(11);

    await act(async () => {
      await playbackEngine.stop();
    });
  });
});
