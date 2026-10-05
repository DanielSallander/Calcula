//! FILENAME: app/extensions/AutoSum/index.ts
// PURPOSE: AutoSum extension entry point.
// CONTEXT: Registers `autosum.insert { fn }` -- the Home tab's AutoSum split
//          (Sum, Average, Count Numbers, Max, Min) and Alt+= (keybindings.ts)
//          run it -- and the invisible shell component that lends Core's edit
//          opener (lib/editOpener.ts). Excel's rules, measured live, are in
//          lib/autoSumPlan.ts. Uses ExtensionModule lifecycle (Path A).

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { ExtensionCommands } from "@api/commands";
import { registerShellComponent, unregisterShellComponent } from "@api/ui";
import { AutoSumEditHost } from "./components/AutoSumEditHost";
import { runAutoSum } from "./lib/autoSumCommand";

const EDIT_HOST_ID = "autosum.editHost";

const cleanupFns: (() => void)[] = [];

function activate(context: ExtensionContext): void {
  console.log("[AutoSum] Activating...");

  registerShellComponent({ id: EDIT_HOST_ID, component: AutoSumEditHost });
  cleanupFns.push(() => unregisterShellComponent(EDIT_HOST_ID));

  // Not script-safe: a one-cell AutoSum opens an EDIT for a person to confirm,
  // which has no meaning inside a script's run.
  context.commands.register(ExtensionCommands.AUTOSUM, (args?: unknown) => runAutoSum(args));
  cleanupFns.push(() => context.commands.unregister(ExtensionCommands.AUTOSUM));

  console.log("[AutoSum] Activated successfully.");
}

function deactivate(): void {
  console.log("[AutoSum] Deactivating...");
  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[AutoSum] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;
  console.log("[AutoSum] Deactivated.");
}

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.autosum",
    name: "AutoSum",
    version: "1.0.0",
    description: "Excel's AutoSum: totals (Sum, Average, Count, Max, Min) guessed from the data around the selection.",
  },
  activate,
  deactivate,
};

export default extension;
