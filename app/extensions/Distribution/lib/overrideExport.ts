// FILENAME: app/extensions/Distribution/lib/overrideExport.ts
// PURPOSE: Pure orchestration for the "Export overrides…" action (C2c), lifted
//          out of OverridesPane so it is unit-testable without a DOM / RTL /
//          Tauri runtime — all I/O (subscriptions, export, save, prompt, alert)
//          is injected.

/** Injected I/O so the flow can be driven with fakes in a test. */
export interface OverrideExportDeps {
  getSubscriptions: () => Promise<{ subscriptions: { packageName: string }[] }>;
  exportOverrides: (packageName: string) => Promise<unknown>;
  saveJsonPatch: (json: string, suggestedName: string) => Promise<string | null>;
  /** Pick a package when more than one subscription exists. Return null to cancel. */
  prompt: (message: string, defaultValue: string) => string | null;
  alert: (message: string) => void;
}

/**
 * Export this subscriber's override layer as a shareable `.json` patch.
 * Returns the saved file path, or null when nothing was exported (no
 * subscription, the user cancelled the package picker, or the save dialog was
 * cancelled). Throwing is left to the caller to surface.
 */
export async function runOverrideExport(deps: OverrideExportDeps): Promise<string | null> {
  const subs = (await deps.getSubscriptions()).subscriptions;
  if (subs.length === 0) {
    deps.alert("No active subscription to export overrides for.");
    return null;
  }

  let pkg = subs[0].packageName;
  if (subs.length > 1) {
    const choice = deps.prompt(
      `Export overrides for which package?\n\n${subs.map((s) => s.packageName).join("\n")}`,
      pkg,
    );
    if (choice === null) return null; // user cancelled the picker
    pkg = choice.trim();
  }

  const patch = await deps.exportOverrides(pkg);
  return deps.saveJsonPatch(JSON.stringify(patch, null, 2), `${pkg}-overrides.json`);
}
