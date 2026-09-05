//! FILENAME: app/extensions/Controls/__tests__/scriptPickerProvenance.test.tsx
// PURPOSE: The Properties Pane's two script pickers — the OnSelect autocomplete
//          and the "script" property select — name a distributed module's
//          application and say on what terms it runs, the same way the
//          button-action dialog does.
//
// The pane used to narrow every listed module to `{ id, name }` before handing
// it to these inputs, so the `sourcePackage` stamp could not reach them even in
// principle; `PublisherMacro()` was suggested with the same "Run script module"
// line as the user's own code.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { buildScriptSuggestions, CodePropertyInput } from "../PropertiesPane/CodePropertyInput";
import { PropertyRow } from "../PropertiesPane/PropertyRow";
import type { PropertyDefinition } from "../lib/types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// DISTINCT names, deliberately. This fixture used to give the local and the
// distributed module the SAME name and expect two rows with the same inserted
// `Report()`, on the premise that "the run planner decides by provenance, not
// spelling". It does not: `planInlineButtonRun` resolves a bare `Name()` by
// NAME with local-wins, so the distributed row's insertion ran the user's own
// module while the row promised the publisher's. The shadow case is pinned
// separately below; here each name has exactly one answer.
const scripts = [
  { id: "mine", name: "Report", sourcePackage: null },
  { id: "theirs", name: "Reporting", sourcePackage: "SalesApp" },
];

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
  vi.useRealTimers();
});

describe("OnSelect autocomplete", () => {
  it("builds a suggestion that names the application and the terms for a distributed module", () => {
    const [mine, theirs] = buildScriptSuggestions(scripts);

    expect(mine.application).toBeNull();
    expect(mine.description).toBe('Run script module "Report"');

    expect(theirs.application).toBe("SalesApp");
    expect(theirs.description).toContain('"SalesApp"');
    expect(theirs.description).toContain("exactly as published");
    expect(theirs.description).toContain("only if you have approved that application");
    // Same inserted call either way: the run planner decides by provenance,
    // not by spelling.
    expect(theirs.insertText).toBe("Reporting()");
    expect(mine.insertText).toBe("Report()");
  });

  it("does not offer a distributed module a local module of the same name shadows", () => {
    // `Report()` resolves by NAME with local-wins, so a row promising the
    // publisher's module would insert a call that runs the user's own.
    const rows = buildScriptSuggestions([
      { id: "mine", name: "Report", sourcePackage: null },
      { id: "theirs", name: "Report", sourcePackage: "SalesApp" },
    ]);
    expect(rows.map((r) => [r.label, r.application])).toEqual([["Report", null]]);
  });

  it("collapses two same-named distributed modules into ONE row that says so", () => {
    // The planner refuses a bare `Report()` that two applications answer to;
    // offering it twice, each row claiming its own application, offered twice a
    // call that cannot run.
    const rows = buildScriptSuggestions([
      { id: "a", name: "Report", sourcePackage: "SalesApp" },
      { id: "b", name: "Report", sourcePackage: "FinancePack" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("Report");
    expect(rows[0].description).toContain('"FinancePack"');
    expect(rows[0].description).toContain('"SalesApp"');
    expect(rows[0].description).toContain("cannot call it by name");
  });

  it("renders the application tag on the suggestion row", async () => {
    vi.useFakeTimers();
    const Harness: React.FC = () => {
      const [value, setValue] = React.useState("");
      return (
        <CodePropertyInput
          value={value}
          onChange={setValue}
          onCommit={() => undefined}
          scripts={scripts}
        />
      );
    };
    await act(async () => {
      root.render(<Harness />);
    });
    const textarea = host.querySelector("textarea");
    if (!textarea) throw new Error("textarea not rendered");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;

    await act(async () => {
      // A real focus: React's onFocus listens for `focusin`, which a synthetic
      // `focus` Event never produces.
      textarea.focus();
    });
    await act(async () => {
      setter?.call(textarea, "Rep");
      textarea.setSelectionRange(3, 3);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      vi.advanceTimersByTime(50);
    });

    const rows = [...host.querySelectorAll<HTMLElement>("[data-script-suggestion]")];
    expect(rows).toHaveLength(2);
    const tags = rows.map(
      (r) => r.querySelector("[data-script-suggestion-application]")?.textContent ?? null,
    );
    expect(tags).toEqual([null, 'from application "SalesApp"']);
  });
});

describe("the 'script' property select", () => {
  const definition: PropertyDefinition = {
    key: "macro",
    label: "Macro",
    inputType: "script",
    defaultValue: "",
    supportsFormula: false,
  };

  async function render(selected: string): Promise<void> {
    await act(async () => {
      root.render(
        <PropertyRow
          definition={definition}
          value={{ valueType: "static", value: selected }}
          scripts={scripts}
          onChange={() => undefined}
        />,
      );
    });
  }

  it("labels the distributed option with its application", async () => {
    await render("");
    const select = host.querySelector<HTMLSelectElement>("[data-control-script-select]");
    if (!select) throw new Error("select not rendered");
    const labels = [...select.options].map((o) => o.textContent);
    expect(labels).toEqual(["(None)", "Report", 'Reporting — from application "SalesApp"']);
  });

  it("shows the provenance note only when the chosen module is distributed", async () => {
    await render("mine");
    expect(host.querySelector("[data-control-script-provenance]")).toBeNull();

    await render("theirs");
    const note = host.querySelector<HTMLElement>("[data-control-script-provenance]");
    expect(note?.getAttribute("data-control-script-provenance")).toBe("SalesApp");
    expect(note?.textContent).toContain("exactly as published");
    expect(note?.textContent).toContain("only if you have approved that application");
  });
});
