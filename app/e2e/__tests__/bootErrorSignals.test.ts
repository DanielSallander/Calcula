//! FILENAME: app/e2e/__tests__/bootErrorSignals.test.ts
// PURPOSE: Prove that the startup guard's `boot-error` arm still recognises the
//          REAL root error boundary -- and that it does not depend on the one
//          attribute a build step could remove.
//
// THE FRAGILITY THIS CLOSES, verbatim from the pass that shipped the arm:
//   "The `boot-error` arm keys on `data-testid` -- nothing verifies it survives a
//    production `vite build`. A future strip step would silently return the guard
//    to reading a crashed boot as healthy, with no test failing."
//
// That is the shape this programme has been punished by more than any other: a
// guard that stops guarding and says nothing (a lock-order census green because
// `.ok()` MOVES a guard; four cleanup calls that had never run because serde
// rejected their argument). Two tests close it, on two different axes:
//
//   * THIS FILE -- the SEMANTIC axis. It renders the actual product component
//     and runs the actual probe over the actual DOM, so a reworded panel, a
//     removed attribute, a dropped `role` or a renamed component fails here.
//     Every arm is exercised INDEPENDENTLY, including the negative one: if the
//     fallback could not fail, it would not be evidence that it works.
//   * `bootErrorMarkerSurvivesBuild.test.ts` -- the TOOLCHAIN axis. It runs a
//     real production `vite build` through the real config and looks for the
//     markers in the minified output.
//
// No JSX here on purpose: vitest picks up `e2e/**/*.test.ts` only (Playwright
// owns `*.spec.ts` under `e2e/`), so a harness test lives in a `.ts` file and
// builds its tree with `createElement`.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { RootErrorBoundary } from "../../src/shell/RootErrorBoundary";
import { BOOT_ERROR_SIGNALS, readPageState } from "../pageState";

/**
 * The attribute the fixtures wait for. Built once, and OUTSIDE a literal, because
 * the repo-wide camelCase naming rule applies to object literal keys and a DOM
 * data-attribute cannot obey it.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
const SPREADSHEET_PROPS: Record<string, string> = { "data-focus-container": "spreadsheet" };

let root: Root;

/** React's dev build rethrows a caught error; the throws below are deliberate. */
const swallowDeliberateThrow = (event: Event): void => event.preventDefault();

function Boom({ message }: { readonly message: string }): React.ReactElement {
  throw new Error(message);
}

/** The page shell every Calcula window actually has: `<div id="root"></div>`. */
function mountPage(child: React.ReactElement, surface = "Calcula"): void {
  act(() => {
    root.render(React.createElement(RootErrorBoundary, { surface, children: child }));
  });
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  window.addEventListener("error", swallowDeliberateThrow);
  document.body.innerHTML = "";
  const host = document.createElement("div");
  host.id = "root";
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  window.removeEventListener("error", swallowDeliberateThrow);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("the probe reads the REAL boundary, not a stand-in for it", () => {
  it("says nothing about a boot error when the app renders normally", () => {
    mountPage(React.createElement("div", SPREADSHEET_PROPS, "grid"));
    const state = readPageState(BOOT_ERROR_SIGNALS);
    expect(state.bootErrorText).toBeNull();
    expect(state.bootErrorSignal).toBeNull();
    // ...and the healthy reading is still a healthy reading.
    expect(state.rootChildCount).toBeGreaterThan(0);
    expect(state.spreadsheetPresent).toBe(true);
  });

  it("finds the panel by `data-testid` and carries the error text out", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mountPage(React.createElement(Boom, { message: "skinLoader exploded" }), "Model Editor");

    const state = readPageState(BOOT_ERROR_SIGNALS);
    expect(state.bootErrorSignal).toBe("data-testid");
    expect(state.bootErrorText).toContain("Model Editor");
    expect(state.bootErrorText).toContain("skinLoader exploded");
    // THE TRAP THE ARM EXISTS FOR: `#root` is NOT empty, because the panel is
    // itself a child of it. Without the boot-error check the barrier would call
    // this a healthy mount.
    expect(state.rootChildCount).toBeGreaterThan(0);
  });
});

describe("the fallback signal survives losing the attribute", () => {
  it("still finds the panel when `data-testid` has been stripped", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mountPage(React.createElement(Boom, { message: "bootstrap failed" }));

    // Exactly what an attribute-stripping production build leaves behind. The
    // build test proves no such step exists TODAY; this proves the guard would
    // survive one being added.
    const panel = document.querySelector(`[data-testid='${BOOT_ERROR_SIGNALS.testId}']`);
    expect(panel, "the boundary did not render at all -- the premise is broken").not.toBeNull();
    panel?.removeAttribute("data-testid");
    expect(document.querySelector(`[data-testid='${BOOT_ERROR_SIGNALS.testId}']`)).toBeNull();

    const state = readPageState(BOOT_ERROR_SIGNALS);
    expect(
      state.bootErrorSignal,
      "with the test hook gone the guard went blind: a crashed boot would be waved " +
        "through the barrier and re-reported as N spreadsheet-selector timeouts.",
    ).toBe("role+text");
    expect(state.bootErrorText).toContain("bootstrap failed");
  });

  it("the fallback is genuinely role+text -- it fails when BOTH are gone", () => {
    // Without this case the test above proves nothing: a fallback that matched
    // any element at all would pass it. A sabotage that is a no-op passes.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mountPage(React.createElement(Boom, { message: "bootstrap failed" }));

    const panel = document.querySelector(`[data-testid='${BOOT_ERROR_SIGNALS.testId}']`);
    panel?.removeAttribute("data-testid");
    panel?.removeAttribute("role");

    expect(readPageState(BOOT_ERROR_SIGNALS).bootErrorSignal).toBeNull();
  });

  it("the product still ships BOTH signals on the same element", () => {
    // The two signals are only independent if the component emits them both.
    // Checked against the rendered DOM rather than the source, because that is
    // what the probe reads.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mountPage(React.createElement(Boom, { message: "x" }));
    const panel = document.querySelector(`[data-testid='${BOOT_ERROR_SIGNALS.testId}']`);
    expect(panel?.getAttribute("role")).toBe(BOOT_ERROR_SIGNALS.role);
    expect(panel?.textContent ?? "").toContain(BOOT_ERROR_SIGNALS.textSignature);
  });
});

describe("the probe survives being sent to the page as SOURCE", () => {
  it("works when rebuilt from its own toString, with no module scope at all", () => {
    // HOW PLAYWRIGHT ACTUALLY RUNS IT: `page.evaluate(readPageState, args)`
    // stringifies the function and evaluates the text inside the browser, where
    // the module's imports, constants and helpers DO NOT EXIST. A single free
    // identifier -- a shared regex, an extracted helper, an enum -- becomes a
    // `ReferenceError` in the page, and the barrier's own `.catch(() =>
    // UNREADABLE_PAGE_STATE)` would swallow it and report "page unreadable"
    // forever. That failure is silent, permanent and looks like infrastructure.
    //
    // Calling the function directly (as every other test here does) cannot catch
    // that, because the module scope is present. Rebuilding from source can.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mountPage(React.createElement(Boom, { message: "serialised probe" }));

    const rebuilt = new Function(`return (${readPageState.toString()});`)() as typeof readPageState;
    const state = rebuilt(BOOT_ERROR_SIGNALS);

    expect(state.bootErrorSignal).toBe("data-testid");
    expect(state.bootErrorText).toContain("serialised probe");
    expect(state.rootChildCount).toBeGreaterThan(0);
    expect(Array.isArray(state.depUrls)).toBe(true);
  });
});

describe("the fallback cannot be tripped by an ordinary in-app alert", () => {
  it("ignores a `role=alert` that is not the boundary's panel", () => {
    // A toast, a validation message or a live region would abort a HEALTHY run
    // if the fallback matched on `role` alone. It matches on role AND the
    // panel's own opening line for exactly this reason.
    mountPage(React.createElement("div", SPREADSHEET_PROPS, "grid"));
    const toast = document.createElement("div");
    toast.setAttribute("role", "alert");
    toast.textContent = "Sheet1 could not be renamed";
    document.body.appendChild(toast);

    const state = readPageState(BOOT_ERROR_SIGNALS);
    expect(state.bootErrorSignal).toBeNull();
    expect(state.bootErrorText).toBeNull();
  });
});
