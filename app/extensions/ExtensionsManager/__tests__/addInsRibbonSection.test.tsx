//! FILENAME: app/extensions/ExtensionsManager/__tests__/addInsRibbonSection.test.tsx
// PURPOSE: The host-rendered Add-ins tab after the Calcula Clusters rebuild:
//          one PanelSection per contribution group, CommandButton heroes, the
//          attribution as an always-shown caption, and no hardcoded colours.
// CONTEXT: The three load-bearing rules of AddInsRibbonSection.tsx are pinned
//          here as behaviour, not prose: a click runs ONLY the registered
//          command id (no callback crosses), an icon is a TOKEN resolved
//          against the host's RibbonIcon set with a host fallback (no markup
//          crosses), and every group is attributed by the host on every
//          surface without being drawn twice (attribution is host-drawn).

/* eslint-disable @typescript-eslint/naming-convention --
 * The module doubles below stand in for the CommandRegistry singleton and a
 * React component, whose real names are PascalCase; a camelCase double would
 * simply not be the export the module imports. */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  popoverLayout,
  findHardcodedColours,
  type SurfaceLayout,
} from "@api/layout";
import type { PanelDefinition, PanelSectionProps } from "@api/uiTypes";

interface Contribution {
  extId: string;
  extName: string;
  button: { id: string; label?: string; tooltip?: string; icon?: string; group?: string; order?: number };
  commandId: string;
}

const host = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    contributions: [] as Contribution[],
    listeners,
    emit(): void {
      for (const l of Array.from(listeners)) l();
    },
    execute: vi.fn(),
  };
});

vi.mock("@api/scriptHost/extensionWorkerHost", () => ({
  listExtensionRibbonButtons: () => host.contributions,
  subscribeToExtensionContributions: (cb: () => void) => {
    host.listeners.add(cb);
    return () => {
      host.listeners.delete(cb);
    };
  },
}));
vi.mock("@api/commands", () => ({
  CommandRegistry: { execute: (id: string) => host.execute(id) },
}));
// The manager's list view is irrelevant here and pulls in the whole manager.
vi.mock("../ExtensionsListView", () => ({ ExtensionsListView: () => null }));

import {
  AddInGroupSection,
  addInSectionId,
  addInSectionsKey,
  buildAddInsSections,
  computeAddInGroups,
} from "../AddInsRibbonSection";
import extension from "../index";

function contribution(
  extId: string,
  extName: string,
  id: string,
  extra: Partial<Contribution["button"]> = {},
): Contribution {
  return { extId, extName, button: { id, label: id, ...extra }, commandId: `ext:${extId}:${id}` };
}

let container: HTMLDivElement;
let root: Root;

function render(node: React.ReactNode, layout: SurfaceLayout): void {
  act(() => {
    root.render(<SurfaceLayoutProvider value={layout}>{node}</SurfaceLayoutProvider>);
  });
}

function setContributions(list: Contribution[]): void {
  host.contributions = list;
  act(() => host.emit());
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  host.execute.mockReset().mockResolvedValue(undefined);
  // Contributions change between tests; emitting drops the section store's memo.
  setContributions([]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("Add-ins sections", () => {
  it("builds one section per (extension, group), sorted, with the attribution as an always-shown label", () => {
    setContributions([
      contribution("zeta", "Zeta Tools", "run", { group: "Actions" }),
      contribution("acme", "Acme", "b", { group: "Data", order: 2 }),
      contribution("acme", "Acme", "a", { group: "Data", order: 1 }),
      contribution("acme", "Acme", "x"),
    ]);

    const groups = computeAddInGroups();
    expect(groups.map((g) => g.heading)).toEqual(["Acme - Commands", "Acme - Data", "Zeta Tools - Actions"]);
    expect(groups[1].buttons.map((b) => b.id)).toEqual(["a", "b"]);

    const sections = buildAddInsSections(groups);
    expect(sections.map((s) => s.label)).toEqual(groups.map((g) => g.heading));
    expect(sections.map((s) => s.id)).toEqual(groups.map((g) => addInSectionId(g.heading)));
    expect(new Set(sections.map((s) => s.id)).size).toBe(3);
    for (const s of sections) {
      expect(s.ribbonPresentation).toBe("inline");
      expect((s as { captionMode?: string }).captionMode).toBe("always");
      expect(React.isValidElement(s.icon)).toBe(true);
    }
  });

  it.each([
    ["band", bandLayout()],
    ["panel", panelLayout(300)],
  ] as const)("renders a group's buttons as token-painted heroes in the %s", (_n, layout) => {
    setContributions([
      contribution("acme", "Acme", "sum", { label: "Sum it", icon: "Fx", tooltip: "Adds things" }),
      contribution("acme", "Acme", "odd", { label: "Odd one", icon: "NotARealIconToken" }),
    ]);
    render(<AddInGroupSection heading="Acme - Commands" />, layout);

    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.map((b) => b.textContent)).toEqual(["Odd one", "Sum it"]);
    // No markup crosses: every icon is an svg the HOST drew. A known token
    // resolves to its RibbonIcon; an unknown one to the host's add-in glyph.
    const odd = container.querySelector('[data-testid="addin-button-acme:odd"]')!;
    const sum = container.querySelector('[data-testid="addin-button-acme:sum"]')!;
    expect(odd.querySelector("[data-addin-glyph]")).not.toBeNull();
    expect(sum.querySelector("svg")).not.toBeNull();
    expect(sum.querySelector("[data-addin-glyph]")).toBeNull();

    expect(findHardcodedColours(container)).toEqual([]);
  });

  it("a click runs only the add-in's registered command id", () => {
    setContributions([contribution("acme", "Acme", "sum", { label: "Sum it" })]);
    render(<AddInGroupSection heading="Acme - Commands" />, bandLayout());
    click(container.querySelector('[data-testid="addin-button-acme:sum"]')!);
    expect(host.execute).toHaveBeenCalledTimes(1);
    expect(host.execute).toHaveBeenCalledWith("ext:acme:sum");
  });

  it("a throwing command is contained and does not take the section down", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    host.execute.mockImplementation(() => {
      throw new Error("boom");
    });
    setContributions([contribution("acme", "Acme", "sum", { label: "Sum it" })]);
    render(<AddInGroupSection heading="Acme - Commands" />, bandLayout());
    click(container.querySelector('[data-testid="addin-button-acme:sum"]')!);
    expect(container.querySelector('[data-testid="addin-button-acme:sum"]')).not.toBeNull();
    spy.mockRestore();
  });

  describe("host-drawn attribution", () => {
    it("the band never draws it inside the section (the always-shown cluster caption does)", () => {
      setContributions([contribution("acme", "Acme", "sum")]);
      render(<AddInGroupSection heading="Acme - Commands" />, bandLayout());
      expect(container.querySelector('[data-testid="addin-attribution"]')).toBeNull();
    });

    it.each([
      ["panel", panelLayout(300)],
      ["popover", popoverLayout(300)],
    ] as const)("a lone group draws it in the %s, where the shell draws no header", (_n, layout) => {
      setContributions([contribution("acme", "Acme", "sum")]);
      render(<AddInGroupSection heading="Acme - Commands" />, layout);
      const heading = container.querySelector('[data-testid="addin-attribution"]');
      expect(heading?.textContent).toBe("Acme - Commands");
      expect(findHardcodedColours(container)).toEqual([]);
    });

    it("with several groups the sidebar headers carry it, so it is not drawn twice", () => {
      setContributions([
        contribution("acme", "Acme", "sum"),
        contribution("zeta", "Zeta", "run"),
      ]);
      render(<AddInGroupSection heading="Acme - Commands" />, panelLayout(300));
      expect(container.querySelector('[data-testid="addin-attribution"]')).toBeNull();
    });

    it("an add-in cannot supply its own attribution: the label is the manifest name", () => {
      setContributions([
        contribution("acme", "Acme", "sum", { label: "Calcula - Home", group: "Commands" }),
      ]);
      const [section] = buildAddInsSections();
      expect(section.label).toBe("Acme - Commands");
    });
  });

  it("a mounted section follows registry changes", () => {
    setContributions([contribution("acme", "Acme", "sum", { label: "Sum it" })]);
    render(<AddInGroupSection heading="Acme - Commands" />, bandLayout());
    setContributions([
      contribution("acme", "Acme", "sum", { label: "Sum it" }),
      contribution("acme", "Acme", "avg", { label: "Average" }),
    ]);
    expect(Array.from(container.querySelectorAll("button")).map((b) => b.textContent)).toEqual([
      "Average",
      "Sum it",
    ]);
  });

  it("a section mounted AFTER a change it did not see shows the current buttons", () => {
    setContributions([contribution("acme", "Acme", "sum", { label: "Sum it" })]);
    render(<AddInGroupSection heading="Acme - Commands" />, bandLayout());
    act(() => root.render(null));
    // Changes while nothing is mounted.
    setContributions([contribution("acme", "Acme", "avg", { label: "Average" })]);
    render(<AddInGroupSection heading="Acme - Commands" />, bandLayout());
    expect(Array.from(container.querySelectorAll("button")).map((b) => b.textContent)).toEqual([
      "Average",
    ]);
  });

  it("a group that vanished renders nothing", () => {
    setContributions([contribution("acme", "Acme", "sum")]);
    render(<AddInGroupSection heading="Gone - Commands" />, bandLayout());
    expect(container.innerHTML).toBe("");
  });
});

describe("Add-ins tab registration", () => {
  function fakeContext() {
    const registered: PanelDefinition[] = [];
    const unregistered: string[] = [];
    const ctx = {
      invokeBackend: vi.fn(),
      commands: { register: vi.fn(), unregister: vi.fn() },
      ui: {
        activityBar: { register: vi.fn(), unregister: vi.fn(), toggle: vi.fn() },
        panels: {
          register: (def: PanelDefinition) => registered.push(def),
          unregister: (id: string) => unregistered.push(id),
        },
      },
    };
    return { ctx, registered, unregistered };
  }

  it("registers one section per group, re-registers only when the groups change, unregisters when empty", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { ctx, registered, unregistered } = fakeContext();
    extension.activate(ctx as unknown as Parameters<typeof extension.activate>[0]);
    try {
      // No contributions: no empty tab.
      expect(registered).toHaveLength(0);

      setContributions([
        contribution("acme", "Acme", "sum", { group: "Math" }),
        contribution("zeta", "Zeta", "run"),
      ]);
      expect(registered).toHaveLength(1);
      expect(registered[0].id).toBe("extensions.addins");
      expect(registered[0].sections.map((s) => s.label)).toEqual(["Acme - Math", "Zeta - Commands"]);

      // A button added INSIDE an existing group is a re-render, not a re-registration.
      setContributions([
        contribution("acme", "Acme", "sum", { group: "Math" }),
        contribution("acme", "Acme", "avg", { group: "Math", order: 5 }),
        contribution("zeta", "Zeta", "run"),
      ]);
      expect(registered).toHaveLength(1);

      // A new group re-registers with one more section.
      setContributions([
        contribution("acme", "Acme", "sum", { group: "Math" }),
        contribution("zeta", "Zeta", "run"),
        contribution("zeta", "Zeta", "fmt", { group: "Format" }),
      ]);
      expect(registered).toHaveLength(2);
      expect(registered[1].sections).toHaveLength(3);
      // Same heading -> same component identity, so nothing remounts.
      const byLabel = (def: PanelDefinition, label: string) =>
        def.sections.find((s) => s.label === label)!.component as React.ComponentType<PanelSectionProps>;
      expect(byLabel(registered[1], "Acme - Math")).toBe(byLabel(registered[0], "Acme - Math"));

      setContributions([]);
      expect(unregistered).toEqual(["extensions.addins"]);
    } finally {
      extension.deactivate?.();
      logSpy.mockRestore();
    }
  });

  it("the change key ignores buttons within a group but not a group's icon", () => {
    const a = computeAddInGroups.call(null);
    expect(addInSectionsKey(a)).toBeNull();
    setContributions([contribution("acme", "Acme", "sum", { icon: "Fx" })]);
    const k1 = addInSectionsKey(computeAddInGroups());
    setContributions([contribution("acme", "Acme", "sum", { icon: "Refresh" })]);
    const k2 = addInSectionsKey(computeAddInGroups());
    expect(k1).not.toBeNull();
    expect(k1).not.toBe(k2);
  });
});
