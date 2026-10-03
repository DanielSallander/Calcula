//! FILENAME: app/extensions/ScriptableObjects/__tests__/codeStatusItem.test.tsx
// PURPOSE: The status bar's code-and-scripts indicator DRAWS each state the way
//          the design says, opens onto its facts and the two panels, and keeps
//          the status bar's own right-click menu out of its way.
// CONTEXT: The words are deriveCodeStatus's (pinned in codeStatus.test.ts);
//          this file pins the drawing and the doors. jsdom computes no layout,
//          so the "never pushed off the bar" guarantee is pinned as CSS here
//          (and in statusBarChrome.test.tsx) and proved on real boxes live.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { findHardcodedColours } from "@api/layout";
import { createCodeStatusItem, type CodeStatusDoor } from "../components/CodeStatusItem";
import { LOADING_SNAPSHOT, type CodeStatusSnapshot, type CodeStatusSource } from "../lib/codeStatus";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const NO_JOBS = { total: 0, enabled: 0, disabled: 0, running: 0, orphaned: 0, nextRunMs: null };
const NOTHING_HELD = {
  shortcuts: 0,
  clipboards: 0,
  clipboardCells: 0,
  runningWatches: 0,
  panes: 0,
  embeddedForms: 0,
  forms: 0,
  any: false,
};

function ready(over: Partial<CodeStatusSnapshot> = {}): CodeStatusSnapshot {
  return {
    phase: "ready",
    inventory: { total: 0, local: 0, distributed: 0, libraries: 0, beyondGrid: 0, mounted: 0 },
    inventoryError: null,
    inventoryGaps: [],
    jobs: NO_JOBS,
    held: NOTHING_HELD,
    heldButtons: 0,
    commandButtons: 0,
    refusals: 0,
    ...over,
  };
}

/** A source double: a settable snapshot behind the real subscribe shape. */
function fakeSource(initial: CodeStatusSnapshot) {
  let snap = initial;
  const listeners = new Set<() => void>();
  return {
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    getSnapshot: () => snap,
    refreshNow: vi.fn(async () => undefined),
    set(next: CodeStatusSnapshot) {
      snap = next;
      listeners.forEach((l) => l());
    },
  };
}

let container: HTMLDivElement;
let root: Root;
let opened: CodeStatusDoor[];
let barContextMenu: ReturnType<typeof vi.fn>;

function render(source: ReturnType<typeof fakeSource>): void {
  const Item = createCodeStatusItem(source as unknown as CodeStatusSource, (door) => opened.push(door));
  act(() => {
    // The status bar's own right-click handler sits on an ancestor, exactly as
    // in StatusBar.tsx; the item must keep its right-click from reaching it.
    root.render(
      <div data-testid="bar" onContextMenu={barContextMenu}>
        <Item />
      </div>,
    );
  });
}

const trigger = (): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>("[data-testid='code-status']")!;
const dot = (): Element | null => container.querySelector("[data-testid='code-status-dot']");
const menu = (): HTMLElement | null => document.querySelector<HTMLElement>("[role='menu']");
const facts = (): string[] =>
  Array.from(document.querySelectorAll("[data-code-status-fact]")).map((el) =>
    el.getAttribute("data-code-status-fact")!,
  );
/** The trigger's visible text: the count, "?", or nothing (the glyph is an svg). */
const drawnText = (): string => trigger().textContent ?? "";

beforeEach(() => {
  opened = [];
  barContextMenu = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("the indicator draws each state", () => {
  it("CHECKING: a quiet shield, no number, no dot -- and says so", () => {
    render(fakeSource(LOADING_SNAPSHOT));
    expect(trigger().dataset.level).toBe("loading");
    expect(drawnText()).toBe("");
    expect(dot()).toBeNull();
    expect(trigger().getAttribute("aria-label")).toMatch(/checking/i);
  });

  it("NONE: a quiet shield, no number, no dot", () => {
    render(fakeSource(ready()));
    expect(trigger().dataset.level).toBe("none");
    expect(drawnText()).toBe("");
    expect(dot()).toBeNull();
    expect(trigger().title).toBe("No code in this file");
  });

  it("PRESENT: the panel's count, no dot", () => {
    render(fakeSource(ready({ inventory: { total: 3, local: 3, distributed: 0, libraries: 0, beyondGrid: 0, mounted: 0 } })));
    expect(trigger().dataset.level).toBe("present");
    expect(drawnText()).toBe("3");
    expect(trigger().dataset.count).toBe("3");
    expect(dot()).toBeNull();
  });

  it("NOTICE: the count AND the attention dot", () => {
    render(
      fakeSource(
        ready({
          inventory: { total: 2, local: 2, distributed: 0, libraries: 0, beyondGrid: 0, mounted: 0 },
          jobs: { ...NO_JOBS, total: 1, enabled: 1 },
        }),
      ),
    );
    expect(trigger().dataset.level).toBe("notice");
    expect(drawnText()).toBe("2");
    expect(dot()).not.toBeNull();
  });

  it("NOTICE with no code at all (a refused call from an add-in): the dot, no number", () => {
    render(fakeSource(ready({ refusals: 1 })));
    expect(trigger().dataset.level).toBe("notice");
    expect(drawnText()).toBe("");
    expect(dot()).not.toBeNull();
  });

  it("UNKNOWN: a '?' and the dot -- never the quiet 'no code' shield", () => {
    render(fakeSource(ready({ inventory: null, inventoryError: "backend gone" })));
    expect(trigger().dataset.level).toBe("unknown");
    expect(drawnText()).toBe("?");
    expect(dot()).not.toBeNull();
  });

  it("a PARTLY read file is UNKNOWN too: '?' instead of a count that might be short", () => {
    render(
      fakeSource(
        ready({
          inventory: { total: 0, local: 0, distributed: 0, libraries: 0, beyondGrid: 0, mounted: 0 },
          inventoryGaps: ["object scripts"],
        }),
      ),
    );
    expect(trigger().dataset.level).toBe("unknown");
    expect(drawnText()).toBe("?");
    expect(dot()).not.toBeNull();
    expect(trigger().getAttribute("aria-label")).not.toMatch(/no code/i);
  });

  it("the CHECK mark is drawn only when the file was read and nothing is worth a look", () => {
    // A check is "verified, safe": it must never sit on a warning or on a file
    // nobody could read.
    const mark = (): string | null => trigger().querySelector("svg")!.getAttribute("data-shield-mark");
    const cases: Array<[CodeStatusSnapshot, string]> = [
      [LOADING_SNAPSHOT, "none"],
      [ready(), "check"],
      [ready({ inventory: { total: 2, local: 2, distributed: 0, libraries: 0, beyondGrid: 0, mounted: 0 } }), "check"],
      [ready({ refusals: 1 }), "alert"],
      [ready({ jobs: { ...NO_JOBS, total: 1, enabled: 1 } }), "alert"],
      [ready({ inventory: null, inventoryError: "x" }), "none"],
      [ready({ inventoryGaps: ["notebooks"] }), "none"],
    ];
    for (const [snap, expected] of cases) {
      render(fakeSource(snap));
      expect(mark(), `${trigger().dataset.level}`).toBe(expected);
    }
  });

  it("a large count is capped at 99+", () => {
    render(fakeSource(ready({ inventory: { total: 250, local: 250, distributed: 0, libraries: 0, beyondGrid: 0, mounted: 0 } })));
    expect(drawnText()).toBe("99+");
    // The full number is still in the accessible name.
    expect(trigger().getAttribute("aria-label")).toContain("250 pieces of code");
  });

  it("repaints when the source changes, without being opened", () => {
    const source = fakeSource(ready());
    render(source);
    expect(trigger().dataset.level).toBe("none");
    act(() => source.set(ready({ inventory: { total: 1, local: 1, distributed: 0, libraries: 0, beyondGrid: 1, mounted: 0 } })));
    expect(trigger().dataset.level).toBe("notice");
    expect(drawnText()).toBe("1");
  });

  it("is a real, named button that does not shrink (the status bar's left-zone contract)", () => {
    render(fakeSource(ready()));
    const t = trigger();
    expect(t.tagName).toBe("BUTTON");
    expect(t.type).toBe("button");
    expect(t.getAttribute("aria-haspopup")).toBe("menu");
    expect(t.getAttribute("aria-expanded")).toBe("false");
    // The glyph and the count are decoration; the NAME is the aria-label.
    expect(t.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("the button's OWN rule is the chip (18px well), never the dot's styles composed into it", () => {
    // Found live: `.${dotClass}` inside the trigger's css`` made @emotion/css
    // paste the DOT's declarations (7px, amber) into the button's rule. jsdom
    // computes no layout, so this reads the generated CSS itself.
    render(fakeSource(ready({ refusals: 1 })));
    const buttonClass = trigger().className.split(/\s+/)[0];
    const css = Array.from(document.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .join("\n");
    const rule = new RegExp(`\\.${buttonClass}\\{([^}]*)\\}`).exec(css.replace(/\s+/g, ""));
    expect(rule, `no rule for .${buttonClass}`).not.toBeNull();
    const body = rule![1];
    expect(body).toContain("height:18px");
    expect(body).not.toContain("height:7px");
    expect(body).not.toContain("--status-bar-attention");
    // ...and the hover ring reaches the dot by attribute, not by class name.
    expect(css).toContain("[data-attention-dot]");
    expect(dot()!.hasAttribute("data-attention-dot")).toBe(true);
  });

  it("paints no hardcoded colour (status-bar tokens only)", () => {
    render(fakeSource(ready({ refusals: 1 })));
    expect(findHardcodedColours(container)).toEqual([]);
  });
});

describe("the indicator opens onto its facts and the two panels", () => {
  function openWithClick(source: ReturnType<typeof fakeSource>): void {
    render(source);
    act(() => trigger().click());
  }

  it("a click opens the popover, asks for a FRESH read, and lists the facts", () => {
    const source = fakeSource(
      ready({
        inventory: { total: 2, local: 1, distributed: 1, libraries: 0, beyondGrid: 1, mounted: 0 },
        refusals: 2,
      }),
    );
    openWithClick(source);
    expect(source.refreshNow).toHaveBeenCalledTimes(1);
    expect(menu()).not.toBeNull();
    expect(menu()!.getAttribute("aria-label")).toBe("Code and scripts");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(facts()).toEqual(["code", "beyond-grid", "refusals"]);
    const text = document.querySelector("[data-testid='code-status-facts']")!.textContent!;
    expect(text).toContain("2 pieces of code in this file");
    expect(text).toContain("1 written here · 1 came with an application");
    expect(text).toContain("2 script calls refused");
    // Only the worth-a-look facts carry the attention mark.
    const notices = Array.from(document.querySelectorAll("[data-code-status-fact][data-notice='true']")).map(
      (el) => el.getAttribute("data-code-status-fact"),
    );
    expect(notices).toEqual(["beyond-grid", "refusals"]);
  });

  it("the popover shows 'checking' before the first read, never an empty list", () => {
    openWithClick(fakeSource(LOADING_SNAPSHOT));
    expect(facts()).toEqual(["loading"]);
  });

  it("the two items open the two panels, and say what is behind them", () => {
    openWithClick(fakeSource(ready({ inventory: { total: 4, local: 4, distributed: 0, libraries: 0, beyondGrid: 0, mounted: 0 }, refusals: 1 })));
    const code = document.querySelector<HTMLButtonElement>("[data-testid='code-status-open-code']")!;
    const perms = document.querySelector<HTMLButtonElement>("[data-testid='code-status-open-permissions']")!;
    expect(code.textContent).toContain("Code in This File");
    expect(code.textContent).toContain("4");
    expect(perms.textContent).toContain("Script Permissions");
    expect(perms.textContent).toContain("1 refused");
    act(() => code.click());
    expect(opened).toEqual(["code"]);
    // Choosing closes the popover (the panel is what the user asked for).
    expect(menu()).toBeNull();
    act(() => trigger().click());
    act(() => document.querySelector<HTMLButtonElement>("[data-testid='code-status-open-permissions']")!.click());
    expect(opened).toEqual(["code", "permissions"]);
  });

  it("focus lands on the first item, and Escape returns it to the indicator", () => {
    openWithClick(fakeSource(ready()));
    const first = document.querySelector<HTMLButtonElement>("[data-testid='code-status-open-code']")!;
    expect(document.activeElement).toBe(first);
    act(() => {
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("ArrowDown on the indicator opens it from the keyboard -- and reads FRESH, like a click", () => {
    const source = fakeSource(ready());
    render(source);
    trigger().focus();
    act(() => {
      trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(menu()).not.toBeNull();
    expect(source.refreshNow).toHaveBeenCalledTimes(1);
  });

  it("ArrowUp opens it too, reading fresh", () => {
    const source = fakeSource(ready());
    render(source);
    act(() => {
      trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    expect(menu()).not.toBeNull();
    expect(source.refreshNow).toHaveBeenCalledTimes(1);
  });

  it("a screen reader hears EVERY fact as the menu opens: the facts are the menu's description", () => {
    openWithClick(
      fakeSource(
        ready({
          inventory: { total: 3, local: 1, distributed: 2, libraries: 0, beyondGrid: 0, mounted: 2 },
          heldButtons: 1,
          refusals: 1,
        }),
      ),
    );
    const describedBy = menu()!.getAttribute("aria-describedby");
    expect(describedBy, "the menu names a description").toBeTruthy();
    const description = document.getElementById(describedBy!)!;
    expect(description.getAttribute("data-testid")).toBe("code-status-facts");
    const text = description.textContent!;
    // The facts arrow keys never reach -- where the code came from, what runs,
    // held buttons -- are all in it, details included.
    expect(text).toContain("2 came with an application");
    expect(text).toContain("2 running now");
    expect(text).toContain("1 button holds an application's code");
    expect(text).toContain("Since this file was opened");
  });

  it("'worth a look' is said in words and weight, never by the dot's colour alone", () => {
    openWithClick(fakeSource(ready({ refusals: 1 })));
    const fact = document.querySelector<HTMLElement>("[data-code-status-fact='refusals']")!;
    expect(fact.textContent).toContain("Worth a look: 1 script call refused");
    const plain = document.querySelector<HTMLElement>("[data-code-status-fact='code']")!;
    expect(plain.textContent).not.toContain("Worth a look");
  });

  it("RIGHT-click opens the same popover and never reaches the status bar's Sum/Average menu", () => {
    render(fakeSource(ready()));
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => {
      trigger().dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(barContextMenu).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
    // A second right-click while it is open leaves it open (it does not toggle shut).
    act(() => {
      trigger().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    expect(menu()).not.toBeNull();
    expect(barContextMenu).not.toHaveBeenCalled();
  });

  it("a right-click INSIDE the popover (a fact, an item) never reaches the Sum/Average menu either", () => {
    // The popover is a portal; its events bubble through the React tree to the
    // status bar's own handler, past the trigger's.
    openWithClick(fakeSource(ready({ refusals: 1 })));
    for (const target of [
      document.querySelector<HTMLElement>("[data-code-status-fact='refusals']")!,
      document.querySelector<HTMLElement>("[data-testid='code-status-open-permissions']")!,
    ]) {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      act(() => {
        target.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(true);
    }
    expect(barContextMenu).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
  });

  it("a second click closes it", () => {
    openWithClick(fakeSource(ready()));
    act(() => trigger().click());
    expect(menu()).toBeNull();
  });
});
