// FILENAME: app/extensions/ModelEditor/__tests__/shellPrimitives.test.tsx
// PURPOSE: Guards for the Model Editor shell primitives added with the
//          navigation seam: the route (hash + per-connection memory), the
//          dialog's keyboard contract, and the Badge error tone.
// CONTEXT: This window had NO test coverage of its shell at all — data-testid
//          existed only in StrategySection — so every one of these behaviours
//          would otherwise be guarded by nothing. Each test here corresponds
//          to a defect the seam was built to fix, not to a line of code.

import React, { useState } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Badge, Modal, quantiseModalWidth, isSectionId } from "../components/editorShared";
import { formatRouteHash, parseRouteHash, useSectionRoute } from "../lib/useSectionRoute";
import {
  GEOMETRY_STORAGE_KEY,
  isUsableGeometry,
  readGeometry,
  toLogical,
  writeGeometry,
} from "../lib/windowGeometry";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  window.location.hash = "";
  localStorage.clear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.location.hash = "";
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Route serialisation
// ---------------------------------------------------------------------------

describe("route hash", () => {
  it("round-trips a section and a selection that needs escaping", () => {
    const route = { section: "measures" as const, selection: "Margin % / Net" };
    const hash = formatRouteHash(route);
    // The selection must be escaped, or a "/" in an object name would read as
    // a path separator and truncate the name.
    expect(hash).not.toContain("% /");
    expect(parseRouteHash(hash)).toEqual(route);
  });

  it("round-trips a section with no selection", () => {
    expect(parseRouteHash(formatRouteHash({ section: "tables" }))).toEqual({ section: "tables" });
  });

  it("rejects a section that is not in SECTION_IDS", () => {
    // A hash is user-editable and survives a reload. An unknown section must
    // fall back, never render an empty <main>.
    expect(parseRouteHash("#/notASection")).toBeNull();
    expect(parseRouteHash("#/measures")).toEqual({ section: "measures" });
  });

  it("does not throw on a malformed escape", () => {
    // decodeURIComponent("%E0%A4%A") throws; on boot that would blank the window.
    expect(() => parseRouteHash("#/measures/%E0%A4%A")).not.toThrow();
    expect(parseRouteHash("#/measures/%E0%A4%A")).toEqual({ section: "measures" });
  });

  it("treats an empty hash as no route", () => {
    expect(parseRouteHash("")).toBeNull();
    expect(parseRouteHash("#")).toBeNull();
    expect(parseRouteHash("#/")).toBeNull();
  });

  it("keeps isSectionId in step with the union", () => {
    expect(isSectionId("strategy")).toBe(true);
    expect(isSectionId("Strategy")).toBe(false);
    expect(isSectionId("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// useSectionRoute
// ---------------------------------------------------------------------------

function RouteProbe({ connectionId }: { connectionId: string }): React.ReactElement {
  const { route, navigate } = useSectionRoute(connectionId);
  return (
    <div>
      <span data-testid="section">{route.section}</span>
      <span data-testid="selection">{route.selection ?? ""}</span>
      <button data-testid="go" onClick={() => navigate("measures", "Revenue")}>
        go
      </button>
    </div>
  );
}

function read(id: string): string {
  return container.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";
}

describe("useSectionRoute", () => {
  it("starts on overview and writes the route to the hash", async () => {
    await act(async () => root.render(<RouteProbe connectionId="conn-a" />));
    expect(read("section")).toBe("overview");
    expect(window.location.hash).toBe("#/overview");
  });

  it("navigate moves the section and records the selection", async () => {
    await act(async () => root.render(<RouteProbe connectionId="conn-a" />));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="go"]')!.click();
    });
    expect(read("section")).toBe("measures");
    expect(read("selection")).toBe("Revenue");
    expect(window.location.hash).toBe("#/measures/Revenue");
  });

  it("remembers the route per connection and restores it", async () => {
    await act(async () => root.render(<RouteProbe connectionId="conn-a" />));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="go"]')!.click();
    });
    // Simulate closing and reopening the window: the hash is gone (the window
    // is recreated at a fixed /modelEditor.html) but storage survives.
    act(() => root.unmount());
    window.location.hash = "";
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => root.render(<RouteProbe connectionId="conn-a" />));
    expect(read("section")).toBe("measures");
    expect(read("selection")).toBe("Revenue");
  });

  it("drops the selection when the connection changes but keeps the section", async () => {
    // The selection names an object in the model being LEFT. Restoring it
    // would point a section at a foreign object under a new connectionId —
    // the cross-model hazard ModelEditorApp's setOverview(null)-FIRST ordering
    // exists to prevent.
    await act(async () => root.render(<RouteProbe connectionId="conn-a" />));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="go"]')!.click();
    });
    expect(read("selection")).toBe("Revenue");

    await act(async () => root.render(<RouteProbe connectionId="conn-b" />));
    expect(read("section")).toBe("measures");
    expect(read("selection")).toBe("");
  });

  it("lets an explicit hash win over the stored route on open", async () => {
    localStorage.setItem(
      "calcula.modelEditor.route.conn-a",
      JSON.stringify({ section: "roles" }),
    );
    window.location.hash = "#/lineage";
    await act(async () => root.render(<RouteProbe connectionId="conn-a" />));
    expect(read("section")).toBe("lineage");
  });

  it("survives unreadable stored state", async () => {
    localStorage.setItem("calcula.modelEditor.route.conn-a", "{ not json");
    await act(async () => root.render(<RouteProbe connectionId="conn-a" />));
    expect(read("section")).toBe("overview");
  });
});

// ---------------------------------------------------------------------------
// Modal keyboard contract
// ---------------------------------------------------------------------------

function press(el: Element, key: string, init: KeyboardEventInit = {}): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
}

describe("Modal", () => {
  it("closes on Escape", async () => {
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <Modal title="Edit measure" onClose={onClose}>
          <input data-testid="first" />
        </Modal>,
      ),
    );
    await act(async () => press(container.querySelector('[data-testid="first"]')!, "Escape"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes only the INNERMOST of nested dialogs", async () => {
    // CalcColumnModal -> ExpressionEditorModal renders the inner backdrop
    // inside the outer dialog, so the event bubbles. One Escape must not
    // collapse the whole stack.
    const outer = vi.fn();
    const inner = vi.fn();
    await act(async () =>
      root.render(
        <Modal title="Outer" onClose={outer}>
          <Modal title="Inner" onClose={inner}>
            <input data-testid="inner-input" />
          </Modal>
        </Modal>,
      ),
    );
    await act(async () => press(container.querySelector('[data-testid="inner-input"]')!, "Escape"));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it("focuses its first control on mount", async () => {
    await act(async () =>
      root.render(
        <Modal title="Edit" onClose={vi.fn()}>
          <input data-testid="first" />
          <input data-testid="second" />
        </Modal>,
      ),
    );
    expect(document.activeElement).toBe(container.querySelector('[data-testid="first"]'));
  });

  it("returns focus to the opener when it closes", async () => {
    function Host(): React.ReactElement {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button data-testid="opener" onClick={() => setOpen(true)}>
            open
          </button>
          {open && (
            <Modal title="Edit" onClose={() => setOpen(false)}>
              <input data-testid="field" />
            </Modal>
          )}
        </div>
      );
    }
    await act(async () => root.render(<Host />));
    const opener = container.querySelector<HTMLButtonElement>('[data-testid="opener"]')!;
    opener.focus();
    await act(async () => opener.click());
    expect(document.activeElement).toBe(container.querySelector('[data-testid="field"]'));

    await act(async () => press(container.querySelector('[data-testid="field"]')!, "Escape"));
    // Without the restore, focus lands on <body> and the next Tab restarts
    // from the top of the window.
    expect(document.activeElement).toBe(opener);
  });

  it("wraps Tab at the end and Shift+Tab at the start", async () => {
    await act(async () =>
      root.render(
        <Modal title="Edit" onClose={vi.fn()} footer={<button data-testid="save">Save</button>}>
          <input data-testid="field" />
        </Modal>,
      ),
    );
    const field = container.querySelector<HTMLElement>('[data-testid="field"]')!;
    const save = container.querySelector<HTMLElement>('[data-testid="save"]')!;

    save.focus();
    await act(async () => press(save, "Tab"));
    expect(document.activeElement).toBe(field);

    await act(async () => press(field, "Tab", { shiftKey: true }));
    expect(document.activeElement).toBe(save);
  });

  it("announces itself as a dialog labelled by its title", async () => {
    await act(async () =>
      root.render(
        <Modal title="Edit measure" onClose={vi.fn()}>
          <input />
        </Modal>,
      ),
    );
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    // Compare ids directly rather than building a selector: useId() emits
    // colons, and CSS.escape does not exist in jsdom.
    const heading = container.querySelector("h3")!;
    expect(heading.id).toBe(labelledBy);
    expect(heading.textContent).toBe("Edit measure");
  });
});

describe("quantiseModalWidth", () => {
  it("snaps every legacy width up to a sanctioned step", () => {
    // The old ad-hoc set: 560, 620, 720, 760, 1280.
    expect(quantiseModalWidth(560)).toBe(640);
    expect(quantiseModalWidth(620)).toBe(640);
    expect(quantiseModalWidth(720)).toBe(880);
    expect(quantiseModalWidth(760)).toBe(880);
    expect(quantiseModalWidth(1280)).toBe(1200);
  });

  it("never returns a width smaller than asked for, except past the top step", () => {
    for (const w of [100, 480, 481, 880, 1200]) {
      if (w <= 1200) expect(quantiseModalWidth(w)).toBeGreaterThanOrEqual(w);
    }
  });
});

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Window geometry
// ---------------------------------------------------------------------------

describe("window geometry", () => {
  it("converts physical pixels to logical on a HiDPI display", () => {
    // THE trap: resize payloads are physical, the constructor takes logical.
    // Storing physical and restoring as logical doubles the window each open.
    expect(toLogical(2300, 2)).toBe(1150);
    expect(toLogical(1560, 2)).toBe(780);
    expect(toLogical(1150, 1)).toBe(1150);
    expect(toLogical(1800, 1.5)).toBe(1200);
  });

  it("treats a nonsense scale as 1 rather than dividing by zero", () => {
    expect(toLogical(1150, 0)).toBe(1150);
    expect(Number.isFinite(toLogical(1150, 0))).toBe(true);
  });

  it("round-trips a geometry that survives a 2x round trip unchanged", () => {
    // The full loop: a 1150x780 logical window on a 2x display reports
    // 2300x1560 physical, and must come back as 1150x780.
    const restored = { width: toLogical(2300, 2), height: toLogical(1560, 2), x: 0, y: 0 };
    writeGeometry(restored);
    expect(readGeometry()).toEqual({ width: 1150, height: 780, x: 0, y: 0 });
  });

  it("accepts a negative origin — a monitor left of or above the primary one", () => {
    expect(isUsableGeometry({ width: 1200, height: 800, x: -1920, y: -200 })).toBe(true);
  });

  it("rejects geometry that would strand the window", () => {
    // Below the declared minimums, absurd sizes, and non-finite values are all
    // unrecoverable without clearing storage, so they must never be restored.
    expect(isUsableGeometry({ width: 100, height: 800, x: 0, y: 0 })).toBe(false);
    expect(isUsableGeometry({ width: 1200, height: 10, x: 0, y: 0 })).toBe(false);
    expect(isUsableGeometry({ width: 999999, height: 800, x: 0, y: 0 })).toBe(false);
    expect(isUsableGeometry({ width: 1200, height: 800, x: 0, y: NaN })).toBe(false);
    expect(isUsableGeometry({ width: 1200, height: 800, x: 0 })).toBe(false);
    expect(isUsableGeometry(null)).toBe(false);
    expect(isUsableGeometry("1200x800")).toBe(false);
  });

  it("returns null rather than throwing on unreadable stored geometry", () => {
    localStorage.setItem(GEOMETRY_STORAGE_KEY, "{ not json");
    expect(readGeometry()).toBeNull();
  });

  it("refuses to persist a geometry it would refuse to restore", () => {
    writeGeometry({ width: 10, height: 10, x: 0, y: 0 });
    expect(readGeometry()).toBeNull();
  });
});

describe("Badge", () => {
  it("renders an error distinctly from a warning", async () => {
    // The whole point: `bi_model_validate` only ever emits level "error", and
    // it was rendered in the warn palette, so the ONE tone it can produce was
    // the one tone that was wrong.
    await act(async () =>
      root.render(
        <div>
          <span data-testid="w">
            <Badge tone="warn">warn</Badge>
          </span>
          <span data-testid="e">
            <Badge tone="error">error</Badge>
          </span>
        </div>,
      ),
    );
    const warn = container.querySelector('[data-testid="w"] span') as HTMLElement;
    const err = container.querySelector('[data-testid="e"] span') as HTMLElement;
    expect(err.style.background).not.toBe(warn.style.background);
    expect(err.style.color).not.toBe(warn.style.color);
  });
});
