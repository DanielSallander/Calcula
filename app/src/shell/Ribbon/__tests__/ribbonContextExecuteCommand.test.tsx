//! FILENAME: app/src/shell/Ribbon/__tests__/ribbonContextExecuteCommand.test.tsx
// PURPOSE: The RibbonContext the ribbon frame hands a tab RUNS the command a
//          tab asks for -- from whichever registry holds it -- instead of
//          looking it up and only logging it.
// CONTEXT: Z10 (wave F; wave E core report NEW 2). RibbonContainer's
//          `executeCommand` (the public RibbonContext contract: "Execute a
//          registered command") did `ExtensionRegistry.getCommand(id)` and a
//          console.log, and nothing else: a tab that called it ran nothing, and
//          a CommandRegistry command was not even looked up. It now goes through
//          src/api/commandDispatch.ts `executeCommandAnywhere`, the one door
//          Core's keyboard and the TestRunner already use.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../../api/state", () => ({
  useGridState: () => ({ selection: null, editing: null }),
}));

import { RibbonContainer } from "../RibbonContainer";
import { ExtensionRegistry as ExtensionRegistryImpl } from "../../registries/ExtensionRegistry";
import { panelRegistry, initPanelRegistry } from "../../registries/panelRegistry";
import { usePanelPlacementStore } from "../../registries/usePanelPlacementStore";
import {
  registerExtensionRegistryService,
  type CommandDefinition,
  type ExtensionRegistryService,
  type RibbonContext,
  type RibbonTabDefinition,
} from "../../../api/extensions";
import { CommandRegistry } from "../../../api/commands";

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let container: HTMLDivElement;
let root: Root;
/** The contexts the frame handed the probe tab, newest last. */
const handed: RibbonContext[] = [];
const seen = (): RibbonContext | undefined => handed[handed.length - 1];

/** A tab that keeps the context the frame hands it. */
function ProbeTab({ context }: { context: RibbonContext }): React.ReactElement {
  handed.push(context);
  return <div data-testid="probe" />;
}

const extensionCommands = new Map<string, CommandDefinition>();

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  handed.length = 0;
  extensionCommands.clear();
  ExtensionRegistryImpl.clear();
  panelRegistry.clear();
  usePanelPlacementStore.setState({ placements: {} });
  initPanelRegistry({
    activityBar: { registerView: () => {}, unregisterView: () => {} },
    extensionRegistry: {
      registerRibbonTab: (t) => ExtensionRegistryImpl.registerRibbonTab(t),
      unregisterRibbonTab: (id) => ExtensionRegistryImpl.unregisterRibbonTab(id),
    },
    getActivityBarStore: () => ({ openView: () => {}, close: () => {}, activeViewId: null }),
  });
  registerExtensionRegistryService({
    getRibbonTabs: () => ExtensionRegistryImpl.getRibbonTabs(),
    getRibbonGroupsForTab: (id: string) => ExtensionRegistryImpl.getRibbonGroupsForTab(id),
    getCommand: (id: string) => extensionCommands.get(id),
    onRegistryChange: (cb: () => void) => ExtensionRegistryImpl.onRegistryChange(cb),
  } as unknown as ExtensionRegistryService);
  ExtensionRegistryImpl.registerRibbonTab({
    id: "probe",
    label: "Probe",
    order: 1,
    component: ProbeTab as unknown as RibbonTabDefinition["component"],
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<RibbonContainer />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  CommandRegistry.unregister("test.ribbon.local");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("RibbonContext.executeCommand (the ribbon frame's)", () => {
  it("runs an EXTENSION-registry command, with a CommandContext", async () => {
    const run = vi.fn();
    extensionCommands.set("test.ribbon.ext", { id: "test.ribbon.ext", name: "Ext", execute: run });
    expect(seen(), "the frame never rendered the probe tab").toBeDefined();
    await seen()!.executeCommand("test.ribbon.ext");
    expect(run, "the ribbon looked the command up and did not run it").toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toHaveProperty("refreshGrid");
  });

  it("runs a CommandRegistry command too (it was not even looked up there)", async () => {
    const handler = vi.fn();
    CommandRegistry.register("test.ribbon.local", handler);
    await seen()!.executeCommand("test.ribbon.local");
    expect(handler, "a CommandRegistry command never ran from the ribbon").toHaveBeenCalledTimes(1);
  });

  it("does not run a command its isEnabled refuses, and says so", async () => {
    const run = vi.fn();
    extensionCommands.set("test.ribbon.off", { id: "test.ribbon.off", name: "Off", isEnabled: () => false, execute: run });
    await seen()!.executeCommand("test.ribbon.off");
    expect(run).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes("test.ribbon.off"))).toBe(true);
  });

  it("an id no registry holds runs nothing, and says so instead of failing silently", async () => {
    await seen()!.executeCommand("test.ribbon.nowhere");
    expect(vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes("test.ribbon.nowhere"))).toBe(true);
  });
});
