//! FILENAME: app/extensions/ScriptNotebook/__tests__/notebookProvenance.test.tsx
// PURPOSE: The notebook surface must SAY where a notebook's code came from.
// CONTEXT: `core/calp/src/pull.rs` materializes a published application's
//          notebooks into the subscriber's workbook stamped with
//          `source_package`, and strips their execution metadata precisely
//          because they are not trusted. The notebook panel showed none of
//          that: the picker listed a publisher's notebook exactly like one the
//          user wrote, the open notebook carried no band, and when the backend
//          gate refused to run it the whole refusal was a console line. These
//          tests render the real toolbar over the real store and pin all three.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../lib/notebookApi", () => ({
  listNotebooks: vi.fn(),
  createNotebook: vi.fn(),
  saveNotebook: vi.fn(),
  loadNotebook: vi.fn(),
  deleteNotebook: vi.fn(),
  runNotebookCell: vi.fn(),
  runAllCells: vi.fn(),
  rewindNotebook: vi.fn(),
  runFromCell: vi.fn(),
  resetNotebookRuntime: vi.fn(),
  grantNotebookBiCapability: vi.fn(),
}));

vi.mock("@api/backend", () => ({
  invokeBackend: vi.fn(),
}));

import { NotebookToolbar } from "../components/NotebookToolbar";
import { useNotebookStore } from "../lib/useNotebookStore";
import type { NotebookDocument } from "../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const PACKAGE = "Quarterly Reports";

function notebook(overrides: Partial<NotebookDocument> = {}): NotebookDocument {
  return {
    id: "nb-1",
    name: "Sales Analysis",
    cells: [
      {
        id: "c1",
        source: "Calcula.setCellValue(0, 0, 1);",
        lastOutput: [],
        lastError: null,
        cellsModified: 0,
        durationMs: 0,
        executionIndex: null,
      },
    ],
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

function render(): string {
  act(() => {
    root.render(React.createElement(NotebookToolbar));
  });
  return container.textContent ?? "";
}

describe("the notebook surface shows provenance", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useNotebookStore.setState({
      notebooks: [],
      activeNotebook: null,
      isExecuting: false,
      executingCellId: null,
      runRefusal: null,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("names the application the OPEN notebook arrived in", () => {
    useNotebookStore.setState({
      activeNotebook: notebook({ sourcePackage: PACKAGE }),
    });

    expect(render()).toContain(`From application "${PACKAGE}"`);
  });

  it("says nothing about an application for a notebook the user wrote", () => {
    useNotebookStore.setState({ activeNotebook: notebook() });

    const text = render();
    expect(text).not.toContain("From application");
    // A blank stamp is nothing stamped — never an application named "".
    useNotebookStore.setState({
      activeNotebook: notebook({ sourcePackage: "   " }),
    });
    expect(render()).not.toContain("From application");
  });

  it("tags the picker row, so the user knows BEFORE opening it", () => {
    useNotebookStore.setState({
      notebooks: [
        { id: "nb-1", name: "Sales Analysis", cellCount: 3, sourcePackage: PACKAGE },
        { id: "nb-2", name: "My Scratch Pad", cellCount: 1 },
      ],
    });

    const text = render();
    expect(text).toContain(`Sales Analysis (3 cells) — from "${PACKAGE}"`);
    expect(text).toContain("My Scratch Pad (1 cell)");
    expect(text).not.toContain("My Scratch Pad (1 cell) — from");
  });

  it("shows a refused run instead of swallowing it", () => {
    // The fixture is the sentence `distributed_notebook_refusal`
    // (app/src-tauri/src/scripting/notebook_commands.rs) actually produces. It
    // used to say "you have not approved that application's code", which named
    // an approval no surface can give — nothing writes a `notebook:{id}:{cell}`
    // id into the consent store — so the words now state the real rule.
    useNotebookStore.setState({
      activeNotebook: notebook({ sourcePackage: PACKAGE }),
      runRefusal: `The notebook 'Sales Analysis' arrived in the application '${PACKAGE}'. Notebooks from an application are delivered to be read, not run — Calcula has no way to approve one, so its cells stay inert here.`,
    });

    expect(render()).toContain("delivered to be read, not run");
  });
});
