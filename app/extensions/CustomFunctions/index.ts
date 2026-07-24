//! FILENAME: app/extensions/CustomFunctions/index.ts
// PURPOSE: Custom Functions extension — author JS formula functions (UDFs) that
//          run in the sandboxed script worker, persisted with the workbook and
//          re-installed on open.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  loadAndInstallCustomFunctions,
  uninstallCustomFunctions,
  registerMenuItem,
  DialogExtensions,
  AppEvents,
  IconCustomFunctions,
  listenTauriEvent,
} from "@api";
import { CustomFunctionsDialog } from "./components/CustomFunctionsDialog";

const DIALOG_ID = "custom-functions-manager";
const cleanupFns: Array<() => void> = [];

function activate(context: ExtensionContext): void {
  context.ui.dialogs.register({
    id: DIALOG_ID,
    component: CustomFunctionsDialog,
    priority: 110,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister(DIALOG_ID));

  registerMenuItem("formulas", {
    id: "formulas:customFunctions:sep",
    label: "",
    separator: true,
  });
  registerMenuItem("formulas", {
    id: "formulas:customFunctions",
    label: "Custom Functions...",
    icon: IconCustomFunctions,
    action: () => DialogExtensions.openDialog(DIALOG_ID, {}),
  });

  // Install persisted functions now, and re-install whenever a workbook opens.
  void loadAndInstallCustomFunctions();
  const unsub = context.events.on(AppEvents.AFTER_OPEN, () => {
    void loadAndInstallCustomFunctions();
  });
  cleanupFns.push(unsub);

  // Bridge the backend "custom-functions:refresh" Tauri event (emitted after a
  // .calp pull/refresh merges a package's function library) so distributed
  // functions install live — without this they stay #NAME? until a reopen.
  let unlistenRefresh: (() => void) | undefined;
  void listenTauriEvent("custom-functions:refresh", () => {
    void loadAndInstallCustomFunctions();
  }).then((un) => {
    unlistenRefresh = un;
  });
  cleanupFns.push(() => unlistenRefresh?.());
}

function deactivate(): void {
  uninstallCustomFunctions();
  for (const fn of cleanupFns) {
    try {
      fn();
    } catch {
      /* best-effort */
    }
  }
  cleanupFns.length = 0;
}

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.custom-functions",
    name: "Custom Functions",
    version: "1.0.0",
    description: "Author JavaScript formula functions that run sandboxed.",
  },
  activate,
  deactivate,
};

export default extension;
