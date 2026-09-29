//! FILENAME: app/src/shell/registries/__tests__/extensionDevLifecycle.test.ts
// PURPOSE: Y15 (wave E). In a DEV / E2E build a built-in extension can be
//          deactivated AND re-activated live, so its lifecycle -- everything it
//          adds taken back on deactivate, and added once again when it comes
//          back -- can be checked in the running app, not only by the unit
//          censuses. In a release build the door does not exist.
// CONTEXT: The wave-D lifecycle fix-up could not run its own live checks: the
//          manager refuses to disable a built-in (setExtensionEnabled) and
//          activateExtension skips an id it already holds, so a deactivated
//          built-in could never come back and "appears exactly once after
//          re-enable" rested on unit tests alone.
//
//          Mocked: only the extension MANIFEST (one probe built-in instead of
//          all of them) and `@api/backend` (the third-party scan, and the one
//          command the probe sends through its context's backend door). The
//          menu registry, the settings store and the manager are REAL, and the
//          probe's item is read back from the registry.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExtensionContext, ExtensionModule } from "../../../api/contract";

const PROBE_ID = "test.dev.lifecycle";
/** The window property the manager installs in a dev build. */
const HOOK = "__CALCULA_EXTENSION_LIFECYCLE__";
const PROBE_ITEM = "data:devLifecycleProbe";

const probe = vi.hoisted(() => ({
  activations: 0,
  deactivations: 0,
  context: null as unknown as { ui: { menus: { unregisterItem: (m: string, id: string) => void } } } | null,
  /**
   * A PRIVILEGED backend command (asserted below to be on the denylist). Only
   * the per-extension context of a TRUSTED extension passes it to the backend:
   * the shared base context refuses every command ("no trust classification")
   * and a distributed context refuses this one (capability error).
   */
  privilegedCommand: "read_text_file",
  /** The setting each activation writes through `context.settings`. */
  settingKey: "devLifecycleProbeActivation",
  /** What each activation's `context.invokeBackend` did, in activation order. */
  backendDoor: [] as string[],
}));

vi.mock("../../../../extensions/manifest", () => ({
  builtInExtensions: [
    {
      manifest: { id: "test.dev.lifecycle", name: "Dev Lifecycle Probe", version: "1.0.0" },
      async activate(context: ExtensionContext): Promise<void> {
        probe.activations++;
        probe.context = context as never;
        context.ui.menus.registerItem("data", {
          id: "data:devLifecycleProbe",
          label: "Probe",
          action: () => {},
        });
        // The doors that only the context built for THIS extension carries:
        // a trust-scoped backend and settings stored under its own id. A
        // refusal is recorded, never thrown, so a wrong context still ends
        // "active" and is caught by what the door did, not by the status.
        probe.backendDoor.push(
          await context
            .invokeBackend<string>(probe.privilegedCommand, { path: "C:/probe.txt" })
            .then(
              (answer) => `answered:${String(answer)}`,
              (error: unknown) => `refused:${error instanceof Error ? error.message : String(error)}`,
            ),
        );
        context.settings.set(probe.settingKey, probe.activations);
      },
      deactivate(): void {
        probe.deactivations++;
        probe.context?.ui.menus.unregisterItem("data", "data:devLifecycleProbe");
        probe.context = null;
      },
    } as unknown as ExtensionModule,
  ],
}));

const backend = vi.hoisted(() => {
  /** The file text the mocked backend answers the probe's command with. */
  const probeText = "probe file text";
  return {
    probeText,
    /** Answers the probe's privileged command; there is no other backend. */
    answer: async (cmd: string): Promise<string> => {
      if (cmd === probe.privilegedCommand) return probeText;
      throw new Error("no backend in this test");
    },
    invoke: null as unknown as import("vitest").Mock,
  };
});

vi.mock("../../../api/backend", async () => {
  const { vi: v } = await import("vitest");
  backend.invoke = v.fn(backend.answer);
  return { invokeBackend: backend.invoke };
});

import { ExtensionManager } from "../ExtensionManager";
import { registerMenu, unregisterMenu, getMenus } from "../../../api/ui";
import { getSetting, removeSetting } from "../../../api/settings";
import { isPrivilegedCommand } from "../../../api/backendCommands";

interface LifecycleHook {
  deactivate: (id: string) => Promise<void>;
  activate: (id: string) => Promise<void>;
  builtIns: () => { id: string; status: string }[];
}

function hook(): LifecycleHook | undefined {
  return (window as unknown as Record<string, LifecycleHook | undefined>)[HOOK];
}

/** How many times the probe's item is in the Data menu. */
function probeItems(): number {
  return getMenus().find((m) => m.id === "data")?.items.filter((i) => i.id === PROBE_ITEM).length ?? 0;
}

/** Forget the probe's setting under its own id AND under the base context's "" id. */
function forgetProbeSettings(): void {
  removeSetting(PROBE_ID, probe.settingKey);
  removeSetting("", probe.settingKey);
}

beforeEach(async () => {
  probe.activations = 0;
  probe.deactivations = 0;
  probe.backendDoor = [];
  backend.invoke.mockClear();
  forgetProbeSettings();
  ExtensionManager.reset();
  registerMenu({ id: "data", label: "Data", order: 42, items: [] });
  await ExtensionManager.initialize();
});

afterEach(() => {
  ExtensionManager.reset();
  unregisterMenu("data");
  forgetProbeSettings();
  vi.unstubAllEnvs();
});

describe("DEV: a built-in can be taken down and brought back live", () => {
  it("installs window.__CALCULA_EXTENSION_LIFECYCLE__ in a dev build, listing the built-ins", () => {
    const h = hook();
    expect(h, "no dev lifecycle hook on window").toBeDefined();
    expect(h!.builtIns()).toEqual([{ id: PROBE_ID, status: "active" }]);
  });

  it("deactivate takes its item away; activate brings it back exactly once, activating the module again", async () => {
    expect(probeItems(), "positive control: the probe's item is in Data").toBe(1);

    await hook()!.deactivate(PROBE_ID);
    expect(ExtensionManager.getExtension(PROBE_ID)?.status).toBe("inactive");
    expect(probe.deactivations).toBe(1);
    expect(probeItems()).toBe(0);

    await hook()!.activate(PROBE_ID);
    expect(ExtensionManager.getExtension(PROBE_ID)?.status, "the built-in did not come back").toBe("active");
    expect(probe.activations, "activate did not run a second time").toBe(2);
    expect(probeItems(), "the item is not back exactly once").toBe(1);

    // And again: the cycle is repeatable, not a one-shot.
    await hook()!.deactivate(PROBE_ID);
    await hook()!.activate(PROBE_ID);
    expect(probe.activations).toBe(3);
    expect(probeItems()).toBe(1);
  });

  it("re-activation hands the module its OWN context -- trusted backend door, settings under its id -- as the first activation did", async () => {
    // A real built-in reads through these doors while it activates:
    // AutoRecover loads its settings with context.invokeBackend. Handed the
    // shared base context, it is refused ("no trust classification") and the
    // extension ends in 'error' -- but the menu probe above cannot tell the
    // two contexts apart, because the base context shares `ui.menus`.
    expect(
      isPrivilegedCommand(probe.privilegedCommand),
      "the probe's command must be privileged, or a distributed context would pass it too",
    ).toBe(true);
    const firstActivation = [`answered:${backend.probeText}`];
    expect(probe.backendDoor, "positive control: the FIRST activation's door reached the backend").toEqual(
      firstActivation,
    );
    expect(getSetting(PROBE_ID, probe.settingKey, 0), "positive control: first activation's setting").toBe(1);

    await hook()!.deactivate(PROBE_ID);
    backend.invoke.mockClear();
    await hook()!.activate(PROBE_ID);

    expect(
      probe.backendDoor,
      "re-activation was not handed a trusted per-extension context: its backend door refused",
    ).toEqual([...firstActivation, `answered:${backend.probeText}`]);
    expect(backend.invoke).toHaveBeenCalledWith(probe.privilegedCommand, { path: "C:/probe.txt" });
    expect(
      getSetting(PROBE_ID, probe.settingKey, 0),
      "re-activation's context.settings did not write under the extension's own id",
    ).toBe(2);
    expect(ExtensionManager.getExtension(PROBE_ID)?.status).toBe("active");
  });

  it("refuses to activate a built-in that is already active -- activate never runs twice", async () => {
    await expect(hook()!.activate(PROBE_ID)).rejects.toThrow(/already active/);
    expect(probe.activations).toBe(1);
    expect(probeItems()).toBe(1);
  });

  it("refuses an id that is not a loaded built-in", async () => {
    await expect(hook()!.activate("no.such.extension")).rejects.toThrow(/not a loaded built-in/);
    await expect(hook()!.deactivate("no.such.extension")).rejects.toThrow(/not a loaded built-in/);
  });

  it("refuses a third-party extension: one the user DISABLED cannot be brought back through the dev door", async () => {
    // The disabled set is read when the manager is constructed, so this runs
    // on a fresh manager whose scan lists one disabled, sidecar-described
    // extension. Its entry is inactive with a synthetic no-op module: without
    // the built-in check the dev door would "activate" it and report it active.
    const DISABLED_KEY = "calcula.extensions.disabled";
    const THIRD_PARTY = "third.party.probe";
    localStorage.setItem(DISABLED_KEY, JSON.stringify([THIRD_PARTY]));
    backend.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_extensions_directory") return "C:/extensions";
      if (cmd === "scan_extension_directory") {
        return [
          {
            fileName: "probe.js",
            content: "",
            manifestJson: JSON.stringify({ id: THIRD_PARTY, name: "Third-party probe", version: "1.0.0" }),
          },
        ];
      }
      return backend.answer(cmd);
    });
    vi.resetModules();
    const { ExtensionManager: fresh } = await import("../ExtensionManager");
    try {
      await fresh.initialize();
      expect(
        fresh.getExtension(THIRD_PARTY)?.trust,
        "positive control: the disabled third-party extension is listed",
      ).toBe("distributed");
      expect(fresh.getExtension(THIRD_PARTY)?.status).toBe("inactive");

      await expect(fresh.devReactivateBuiltIn(THIRD_PARTY)).rejects.toThrow(/not a loaded built-in/);
      expect(fresh.getExtension(THIRD_PARTY)?.status, "a disabled third-party extension came back").toBe("inactive");
    } finally {
      fresh.reset();
      localStorage.removeItem(DISABLED_KEY);
      backend.invoke.mockImplementation(backend.answer);
    }
  });
});

describe("RELEASE: the door does not exist", () => {
  it("with DEV false the manager refuses both directions and nothing changes", async () => {
    vi.stubEnv("DEV", false);
    await expect(ExtensionManager.devDeactivateBuiltIn(PROBE_ID)).rejects.toThrow(/development build/);
    expect(ExtensionManager.getExtension(PROBE_ID)?.status).toBe("active");
    expect(probe.deactivations).toBe(0);

    vi.unstubAllEnvs();
    await ExtensionManager.devDeactivateBuiltIn(PROBE_ID);
    vi.stubEnv("DEV", false);
    await expect(ExtensionManager.devReactivateBuiltIn(PROBE_ID)).rejects.toThrow(/development build/);
    expect(ExtensionManager.getExtension(PROBE_ID)?.status).toBe("inactive");
    expect(probe.activations).toBe(1);
  });

  it("with DEV false a fresh load of the manager installs no window hook", async () => {
    const w = window as unknown as Record<string, unknown>;
    delete w[HOOK];
    vi.stubEnv("DEV", false);
    vi.resetModules();
    await import("../ExtensionManager");
    expect(w[HOOK], "a release build exposed the lifecycle hook").toBeUndefined();

    // Positive control: the same fresh load in a dev build DOES install it.
    vi.unstubAllEnvs();
    vi.resetModules();
    await import("../ExtensionManager");
    expect(w[HOOK]).toBeDefined();
  });
});
