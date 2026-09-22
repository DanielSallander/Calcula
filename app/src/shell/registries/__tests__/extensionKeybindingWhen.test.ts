//! FILENAME: app/src/shell/registries/__tests__/extensionKeybindingWhen.test.ts
// PURPOSE: An extension that registers a keybinding through the CONTEXT FACADE
//          (`context.keybindings.register`) gets the same `when` applicability
//          predicate the free `registerKeybinding` honours — end to end, all
//          the way to the dispatcher.
// CONTEXT: `IKeybindingsAPI.register` was a one-argument signature while
//          `registerKeybinding` had grown a second (`when`), and the
//          per-extension wrapper in ExtensionManager — the one that exists to
//          stamp `source: "extension"` — was written as `(binding) =>
//          registerKeybinding({...binding, ...})`. Both halves failed silently:
//          TypeScript accepts a one-parameter arrow where a two-parameter
//          method is expected, so an extension passing a predicate had it
//          dropped on the floor and received an UNGUARDED binding that fires
//          everywhere. Charts escaped it only by importing the free function
//          directly, which is precisely the Facade Rule violation the API
//          exists to make unnecessary.
//
//          THIS FILE IS BEHAVIOURAL ON PURPOSE. A sibling guard in
//          `app/src/api/__tests__/api-surface-stability.test.ts` reads
//          keybindings.ts and pins the two SIGNATURES against each other; a
//          type cannot be observed at runtime, so it has to read source. The
//          argument actually ARRIVING is a different claim, and asserting that
//          the wrapper "mentions" `when` would be the kind of shape check that
//          passes on a wrapper which mentions it and then ignores it. So here
//          the registry, the guard map and `handleGlobalKeyDown` are all REAL,
//          and the test presses the keys.
//
//          Mocked: only the extension MANIFEST (so exactly one fake extension
//          activates instead of all 66 built-ins) and `@api/backend` (the
//          third-party scan would otherwise reach for Tauri; ExtensionManager
//          already swallows that failure, but a rejected promise per run is
//          noise).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExtensionContext, ExtensionModule } from "../../../api/contract";

// ---------------------------------------------------------------------------
// The one extension this manager will see
// ---------------------------------------------------------------------------

/** The command the guarded binding runs. */
const COMMAND_ID = "test.extensionFacade.formatChartElement";

/** A combination nothing in the app binds, so this test owns it outright. */
const COMBO = "Ctrl+Alt+Shift+F9";

const EXTENSION_ID = "test.facade.keybindings";
const BINDING_ID = "test.facade.keybindings.formatElement";

/**
 * `vi.mock` factories are hoisted above every declaration in this file, so the
 * probe extension and the state it closes over have to be hoisted with them.
 * `vi.hoisted` is the sanctioned way to say that; a plain `const` above the
 * mock reads fine and throws "cannot access before initialization" at import.
 */
const probe = vi.hoisted(() => ({
  /** Flipped by the test; the registered predicate reads it. */
  chartElementSelected: false,
  /** Every consultation of the predicate, so "was it asked?" is provable. */
  guardCalls: [] as boolean[],
  /** How many times the bound command actually ran. */
  executed: 0,
}));

vi.mock("../../../../extensions/manifest", () => ({
  builtInExtensions: [
    {
      manifest: {
        id: "test.facade.keybindings",
        name: "Facade Keybinding Probe",
        version: "1.0.0",
        description: "Registers one guarded shortcut through the context facade.",
      },
      activate(context: ExtensionContext): void {
        context.commands.register("test.extensionFacade.formatChartElement", async () => {
          probe.executed++;
        });
        // THE CALL UNDER TEST. Two arguments, through the facade, exactly as
        // an extension obeying the Facade Rule would write it.
        context.keybindings.register(
          {
            id: "test.facade.keybindings.formatElement",
            combo: "Ctrl+Alt+Shift+F9",
            commandId: "test.extensionFacade.formatChartElement",
            label: "Format Chart Element",
            category: "Formatting",
          },
          () => {
            probe.guardCalls.push(probe.chartElementSelected);
            return probe.chartElementSelected;
          },
        );
      },
    } as unknown as ExtensionModule,
  ],
}));

vi.mock("../../../api/backend", () => ({
  invokeBackend: vi.fn(async () => {
    throw new Error("no backend in this test");
  }),
}));

import { ExtensionManager } from "../ExtensionManager";
import {
  handleGlobalKeyDown,
  getAllKeybindings,
  getKeybinding,
} from "../../../api/keybindings";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A keydown for {@link COMBO}, built the way the browser would deliver it. */
function pressTheCombo(): boolean {
  return handleGlobalKeyDown(
    new KeyboardEvent("keydown", {
      key: "F9",
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
}

/** `CommandRegistry.execute` is fired and not awaited by the dispatcher. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  probe.executed = 0;
  probe.guardCalls.length = 0;
  probe.chartElementSelected = false;
  ExtensionManager.reset();
  await ExtensionManager.initialize();
});

afterEach(() => {
  ExtensionManager.reset();
});

// ---------------------------------------------------------------------------

describe("context.keybindings.register — the `when` predicate survives the facade", () => {
  it("activates the probe extension and registers its binding", () => {
    // The premise, stated rather than assumed: everything below is meaningless
    // if the binding never reached the registry.
    expect(ExtensionManager.getExtension(EXTENSION_ID)?.status).toBe("active");
    const binding = getKeybinding(BINDING_ID);
    expect(binding, "the probe's binding is not in the registry").toBeDefined();
    expect(binding!.combo).toBe(COMBO);
    expect(binding!.commandId).toBe(COMMAND_ID);
    // ...and the host stamped the attribution the wrapper exists to add.
    expect(binding!.source).toBe("extension");
    expect(binding!.extensionId).toBe(EXTENSION_ID);
  });

  it("does NOT fire while the predicate says no", () => {
    probe.chartElementSelected = false;

    const handled = pressTheCombo();

    // THE DEFECT. With `when` dropped the binding is unguarded, so it matches,
    // the dispatcher preventDefaults and runs the command — a shortcut firing
    // in a context its owner explicitly excluded itself from.
    expect(handled).toBe(false);
    expect(probe.executed).toBe(0);
  });

  it("DOES fire while the predicate says yes", async () => {
    probe.chartElementSelected = true;

    const handled = pressTheCombo();
    await settle();

    expect(handled).toBe(true);
    expect(probe.executed).toBe(1);
  });

  it("consults the predicate on every press, not once at registration", () => {
    // A wrapper that evaluated `when()` eagerly and passed the BOOLEAN would
    // pass the two cases above in isolation and be wrong forever after.
    probe.chartElementSelected = false;
    pressTheCombo();
    probe.chartElementSelected = true;
    pressTheCombo();
    probe.chartElementSelected = false;
    pressTheCombo();

    expect(probe.guardCalls).toEqual([false, true, false]);
  });

  it("keeps the predicate OFF the binding object the settings UI can read", () => {
    // `bindingGuards` is a private map for exactly this reason: a callable on
    // the binding would leak through getAll() into the shortcut list and into
    // everything that serialises a binding.
    const listed = getAllKeybindings().find((b) => b.id === BINDING_ID);
    expect(listed).toBeDefined();
    for (const value of Object.values(listed as unknown as Record<string, unknown>)) {
      expect(typeof value).not.toBe("function");
    }
  });
});
