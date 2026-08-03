//! FILENAME: app/src/api/macroRunService.ts
// PURPOSE: The feature-neutral seam through which any extension can RUN a
//          recorded macro by its module id, without knowing the Macro Recorder
//          exists or how a macro is stored and executed.
// CONTEXT: Inversion of Control, the same shape buttonControlService.ts,
//          autoFilterService.ts and printService.ts use. This is the LINK
//          mechanism at the heart of the "a button links a macro, it does not
//          copy it" model:
//
//            - A macro lives ONCE, as a module script (`macro-<slug>`) in the
//              workbook script store — the canonical thing the editor edits.
//            - A button that "runs a macro" carries only a 12-byte `macroRef`
//              control property: the macro's module id. No copied body, anywhere.
//            - On a click, Controls resolves that id THROUGH THIS SEAM and runs
//              whatever the macro currently is. Because the macro is loaded at
//              click time, editing the macro is reflected on every button that
//              links it with zero re-save — the link-not-copy guarantee falls out
//              for free.
//
// WHY A SEAM AND NOT A DIRECT CALL. The run path (load the module, route on its
// runtime marker to either the QuickJS module runtime or a transient unlocked
// object-script mount) lives inside the Macro Recorder extension. Controls must
// not import another extension's internals (the Facade Rule), and @api owns
// nothing about macros except this one contract. The Macro Recorder registers
// the provider at activation; Controls calls `requireMacroRunProvider()`.
//
// THE OUTCOME IS NEVER SILENT. `runMacroByRef` reports exactly one of three
// states, and the caller surfaces each. `notFound` — the macro a button links no
// longer exists (deleted locally, or missing on a subscriber that received a
// .calp without it) — is the recurring silent-dead-button failure this whole
// feature has fought, so it is a first-class outcome the caller MUST voice, not
// an exception it can swallow.

/** What running a macro-by-ref did. Exactly one of three states, all explicit. */
export type MacroRunOutcome =
  /** The macro ran to completion. `name` is its display name for a toast. */
  | { status: "ran"; name: string }
  /**
   * No macro with this id exists in the workbook. The button links a macro that
   * was deleted, or a .calp arrived without it. NEVER a silent no-op — the caller
   * tells the user the id is gone and how to fix it.
   */
  | { status: "notFound"; macroId: string }
  /** The macro exists and started, but its own code threw. `message` is why. */
  | { status: "failed"; name: string; message: string };

/** What the Macro Recorder provides: run one macro by its module id. */
export interface MacroRunProvider {
  runMacroByRef(macroId: string): Promise<MacroRunOutcome>;
}

let provider: MacroRunProvider | null = null;

/**
 * Register the macro runner. Called once by the Macro Recorder extension at
 * activation; returns the unregister function for its cleanup list.
 *
 * Last registration wins, and unregistering only clears the provider if it is
 * still the one that was registered — so a re-activation followed by the OLD
 * cleanup running cannot blank out the live provider.
 */
export function registerMacroRunProvider(next: MacroRunProvider): () => void {
  provider = next;
  return () => {
    if (provider === next) provider = null;
  };
}

/** Whether macro-by-ref execution is currently available. */
export function hasMacroRunProvider(): boolean {
  return provider !== null;
}

/**
 * The registered provider.
 *
 * THROWS when none is registered (the Macro Recorder is disabled or failed to
 * load). Refusing loudly is the point: a button that links a macro is useless
 * without the extension that can run one, and a silent no-op on the click is the
 * exact failure this seam exists to prevent. The caller turns the throw into a
 * message the user can read.
 */
export function requireMacroRunProvider(): MacroRunProvider {
  if (!provider) {
    throw new Error(
      "This button links a recorded macro, but the Macro Recorder extension is not loaded, so nothing can run it. Enable it and try again.",
    );
  }
  return provider;
}

/** Test/reset hook: forget the registered provider. */
export function resetMacroRunProvider(): void {
  provider = null;
}
