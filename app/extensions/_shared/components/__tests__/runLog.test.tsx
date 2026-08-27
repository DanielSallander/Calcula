//! FILENAME: app/extensions/_shared/components/__tests__/runLog.test.tsx
// PURPOSE: One log, two windows, one account of what happened.
// CONTEXT: 2026-08-26. The guided screen in AIChat already had a run log; the
//          Object Script Editor's diff had none, and it is a separate Tauri
//          window that may not import AIChat's internals. A COPY would drift the
//          moment one of them is retuned, and the two windows would then be
//          telling the user different stories about the same run.
//
//          SO THE ASSERTION IS ABOUT TEXT, NOT COLOUR: the two themes must
//          differ ONLY in their palette.

import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { RunLog, type RunLogRow } from "../RunLog";

const ROWS: RunLogRow[] = [
  { at: 0, kind: "info", text: "Asked qwen2.5-coder:7b for a button script" },
  { at: 4200, kind: "bad", text: "Attempt 1 rejected", detail: "context.cell.setValue is not on a button" },
  { at: 125_000, kind: "ok", text: "Attempt 2 passed every check" },
  { at: 126_000, kind: "done", text: "Ready for review" },
  { at: 126_100, kind: "error", text: "Could not queue it", detail: "the editor window is closed" },
];

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement | null = null;
let root: Root | null = null;

function render(node: React.ReactElement): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root!.render(node); });
  return host;
}

afterEach(() => {
  act(() => { root?.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

describe("RunLog", () => {
  it("renders the SAME text in both themes", () => {
    const light = render(React.createElement(RunLog, { rows: ROWS, theme: "light" })).textContent;
    act(() => { root!.unmount(); });
    host!.remove();
    const dark = render(React.createElement(RunLog, { rows: ROWS, theme: "dark" })).textContent;
    expect(dark).toBe(light);
  });

  it("shows every row's text, its elapsed gutter and its ASCII mark", () => {
    const text = render(React.createElement(RunLog, { rows: ROWS, theme: "light" })).textContent ?? "";
    for (const r of ROWS) expect(text).toContain(r.text);
    expect(text).toContain("0s");
    expect(text).toContain("4s");
    expect(text).toContain("2m 05s");
    // ASCII marks, per CLAUDE.md's clean-output rule.
    expect(text).toContain("[OK]");
    expect(text).toContain("[!]");
  });

  it("puts `detail` after its own row's text, on the same row", () => {
    const el = render(React.createElement(RunLog, { rows: ROWS, theme: "dark" }));
    // The container's DIRECT children — `querySelectorAll("div > div")` also
    // matches the container itself, which contains every row's text and would
    // make the "did not leak" assertion below fail for the wrong reason.
    const rows = [...el.firstElementChild!.children];
    const bad = rows.find((r) => r.textContent?.includes("Attempt 1 rejected"));
    expect(bad, "the row carrying the detail was not found").toBeTruthy();
    const t = bad!.textContent ?? "";
    expect(t).toContain("Attempt 1 rejected — context.cell.setValue is not on a button");
    // ...and it did NOT leak onto the next row.
    const done = rows.find((r) => r.textContent?.includes("Ready for review"));
    expect(done!.textContent).not.toContain("context.cell.setValue");
  });

  it("says the caller's own empty text when there is nothing yet", () => {
    const el = render(React.createElement(RunLog, {
      rows: [], theme: "light", emptyText: "Starting...",
    }));
    expect(el.textContent).toBe("Starting...");
  });

  it("is a pure function of its rows — the same input renders the same markup", () => {
    const first = render(React.createElement(RunLog, { rows: ROWS, theme: "light" })).innerHTML;
    act(() => { root!.unmount(); });
    host!.remove();
    const second = render(React.createElement(RunLog, { rows: ROWS, theme: "light" })).innerHTML;
    expect(second).toBe(first);
  });

  it("carries the caller's data-testid, so either window can locate it", () => {
    const el = render(React.createElement(RunLog, {
      rows: ROWS, theme: "dark", "data-testid": "ai-edit-run-log",
    }));
    expect(el.querySelector("[data-testid='ai-edit-run-log']")).toBeTruthy();
  });
});
