//! FILENAME: app/src/shell/RootErrorBoundary/__tests__/RootErrorBoundary.test.tsx
// PURPOSE: Prove that a render-time exception produces a LEGIBLE window instead
//          of an empty one, and that every React root in the app is behind the
//          boundary that does it.
// CONTEXT: BUG-0083. Before this existed there were zero error boundaries in
//          `app/src` and `app/extensions` across five React roots, and every
//          window's HTML shell is `<div id="root"></div>` with no fallback
//          content -- so any throw during render left a white Tauri window with
//          no message, no devtools and no address bar.
//
//          The second suite below is the half that keeps the fix alive. The
//          boundary is one wrapper element per entry file: a sixth window added
//          next year would ship blank again and every test would still pass.
//          So the entry points are ENUMERATED FROM DISK, not listed here.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RootErrorBoundary, formatFailureReport } from "../index";

let container: HTMLDivElement;
let root: Root;

// React's development build RETHROWS a caught error so devtools can break on
// it, and jsdom then prints the whole stack to stderr. The throws below are
// deliberate, so swallow the window-level report; the assertions, not the
// console, are what say whether the boundary worked.
const swallowDeliberateThrow = (event: Event): void => event.preventDefault();

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  window.addEventListener("error", swallowDeliberateThrow);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  window.removeEventListener("error", swallowDeliberateThrow);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function Boom({ message }: { readonly message: string }): React.ReactElement {
  throw new Error(message);
}

describe("RootErrorBoundary", () => {
  it("renders its children when nothing throws", () => {
    act(() => {
      root.render(
        <RootErrorBoundary surface="Calcula">
          <div data-testid="ok">the app</div>
        </RootErrorBoundary>,
      );
    });
    expect(container.querySelector("[data-testid='ok']")?.textContent).toBe("the app");
    expect(container.querySelector("[data-testid='root-error-boundary']")).toBeNull();
  });

  it("replaces a blank window with a named, legible failure state", () => {
    // React logs the caught error; silence it so the suite output stays about
    // the assertion rather than the deliberate throw.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    act(() => {
      root.render(
        <RootErrorBoundary surface="Model Editor">
          <Boom message="skinLoader exploded" />
        </RootErrorBoundary>,
      );
    });

    const fallback = container.querySelector("[data-testid='root-error-boundary']");
    expect(
      fallback,
      "a throwing child left the container EMPTY -- which is the blank Tauri window " +
        "BUG-0083 exists to delete.",
    ).not.toBeNull();
    // The container must not be empty. That is the whole point.
    expect(container.childElementCount).toBeGreaterThan(0);
    // It must say WHICH window failed and WHAT failed.
    expect(fallback?.textContent).toContain("Model Editor");
    expect(fallback?.textContent).toContain("skinLoader exploded");
    // And it must offer the one recovery a user can perform.
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toContain("Reload");
  });

  it("reports the failure through the injected hook and the console", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onError = vi.fn();
    act(() => {
      root.render(
        <RootErrorBoundary surface="Calcula" onError={onError}>
          <Boom message="bootstrap failed" />
        </RootErrorBoundary>,
      );
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe("bootstrap failed");
    expect(consoleError).toHaveBeenCalled();
  });

  it("survives a reporting hook that itself throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    act(() => {
      root.render(
        <RootErrorBoundary
          surface="Calcula"
          onError={() => {
            throw new Error("the reporter is broken too");
          }}
        >
          <Boom message="original failure" />
        </RootErrorBoundary>,
      );
    });
    // The ORIGINAL failure is what the user must see, not the reporter's.
    const text = container.querySelector("[data-testid='root-error-boundary']")?.textContent ?? "";
    expect(text).toContain("original failure");
    expect(text).not.toContain("the reporter is broken too");
  });

  it("formats a self-contained report", () => {
    const report = formatFailureReport("Calcula", new Error("nope"), "\n    at App");
    expect(report).toContain("Calcula - Calcula failed to start");
    expect(report).toContain("Error: nope");
    expect(report).toContain("component stack:");
    // A missing error must not produce "undefined" in something a user copies
    // into a bug report.
    expect(formatFailureReport("Calcula", null, "")).not.toContain("undefined");
  });
});

describe("every React root in the app is behind a RootErrorBoundary", () => {
  const SRC = join(process.cwd(), "src");

  /**
   * Window entry points, found on disk rather than listed here.
   *
   * The discriminator is `createRoot(document.getElementById(` -- mounting into
   * the PAGE's own container, which is what a window entry point does and what
   * a test never does (tests build their own detached container). Scanning is
   * RECURSIVE: a census that only read `src/*.tsx` would miss a sixth window
   * added one directory down, which is the exact way this guard would rot.
   */
  function findWindowEntries(dir: string): Array<{ name: string; source: string }> {
    const found: Array<{ name: string; source: string }> = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        found.push(...findWindowEntries(full));
        continue;
      }
      if (!entry.name.endsWith(".tsx")) continue;
      if (/\.(test|spec)\.tsx$/.test(entry.name)) continue;
      const source = readFileSync(full, "utf8");
      if (!source.includes("createRoot(document.getElementById(")) continue;
      found.push({ name: full.slice(SRC.length + 1).replace(/\\/g, "/"), source });
    }
    return found;
  }

  const entryFiles = findWindowEntries(SRC);

  it("finds the entry points at all (the census must not be vacuous)", () => {
    // Five today: main + chartSpecEditor + objectScript + modelEditor +
    // packageInspector. If this ever reads zero, the suite below is asserting
    // nothing and would pass forever.
    expect(
      entryFiles.length,
      "no file under app/src mounts a React root, which cannot be true -- the census " +
        "is looking in the wrong place and is therefore asserting nothing.",
    ).toBeGreaterThanOrEqual(5);
  });

  it.each(entryFiles.map((f) => f.name))("%s wraps its root in RootErrorBoundary", (name) => {
    const source = entryFiles.find((f) => f.name === name)?.source ?? "";
    expect(
      source.includes("<RootErrorBoundary"),
      `app/src/${name} mounts a React root with no RootErrorBoundary above it. A throw ` +
        `during render will unmount the tree and leave that window blank -- no message, ` +
        `no devtools, no address bar (BUG-0083).`,
    ).toBe(true);
    expect(
      /RootErrorBoundary\s+surface="[^"]+"/.test(source),
      `app/src/${name} does not name its surface, so the failure message would not say ` +
        `WHICH window failed.`,
    ).toBe(true);
  });
});
