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
  onAppEvent,
  describeCapability,
  grantCustomFunctionConsent,
  CUSTOM_FUNCTIONS_CONSENT_NEEDED,
  type PendingCustomFunctionPackage,
} from "@api";
import { CustomFunctionsDialog } from "./components/CustomFunctionsDialog";
import { DistributedFunctionsConsentDialog } from "./components/DistributedFunctionsConsentDialog";

const DIALOG_ID = "custom-functions-manager";
const CONSENT_DIALOG_ID = "custom-functions-distributed-consent";
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

  // ===== Distributed (.calp) consent gate for packaged formula functions =====
  //
  // A package's functions are merged into this workbook's ONE Custom Functions
  // record by the backend and withheld from the sandbox by the gate in
  // @api/customFunctions until the user answers here. This extension owns only
  // the PROMPT — refusing to answer leaves the functions unmounted, which is the
  // safe state, so nothing here can fail open.
  //
  // Queued one package at a time (a single refresh can update several), keyed by
  // package name so a re-emitted event never stacks duplicate dialogs, and reset
  // per workbook so a prior file's package cannot be approved against a new one.
  context.ui.dialogs.register({
    id: CONSENT_DIALOG_ID,
    component: DistributedFunctionsConsentDialog,
    priority: 120,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister(CONSENT_DIALOG_ID));

  const pendingConsents = new Map<string, PendingCustomFunctionPackage>();
  const consentQueue: string[] = [];
  /** Packages the user blocked this session — never re-prompted until reopen. */
  const declined = new Set<string>();
  let activeConsent: string | null = null;
  let consentEpoch = 0;

  const showNextConsent = (): void => {
    if (activeConsent !== null) return;
    const next = consentQueue.shift();
    if (next === undefined) return;
    const p = pendingConsents.get(next);
    if (!p) {
      showNextConsent();
      return;
    }
    activeConsent = next;
    DialogExtensions.openDialog(CONSENT_DIALOG_ID, {
      packageName: p.packageName,
      functionNames: p.functionNames,
      requestedCapabilities: p.capabilities.map((capability) => ({
        capability,
        description: describeCapability(capability),
      })),
    });
  };

  cleanupFns.push(
    onAppEvent(CUSTOM_FUNCTIONS_CONSENT_NEEDED, (detail) => {
      const { pending } = (detail ?? {}) as { pending?: PendingCustomFunctionPackage[] };
      for (const p of pending ?? []) {
        if (declined.has(p.packageName)) continue;
        const known = pendingConsents.get(p.packageName);
        // A CHANGED consent source is a new question even if the package name
        // is one we already asked about, so replace and re-queue in that case.
        pendingConsents.set(p.packageName, p);
        if (known && known.consentSource === p.consentSource) {
          if (activeConsent === p.packageName || consentQueue.includes(p.packageName)) continue;
        }
        consentQueue.push(p.packageName);
      }
      showNextConsent();
    }),
  );

  cleanupFns.push(
    onAppEvent("customfunctions:consent-granted", (detail) => {
      const { packageName } = (detail ?? {}) as { packageName?: string };
      const epoch = consentEpoch;
      const p = packageName ? pendingConsents.get(packageName) : undefined;
      if (packageName) pendingConsents.delete(packageName);
      activeConsent = null;
      if (p) {
        void grantCustomFunctionConsent(p)
          .then(() => {
            // A grant re-runs the install, which re-emits for anything still
            // pending; the queue below picks that up.
            if (epoch === consentEpoch) showNextConsent();
          })
          .catch((e) => {
            console.error("[CustomFunctions] failed to record package consent", e);
            if (epoch === consentEpoch) showNextConsent();
          });
        return;
      }
      showNextConsent();
    }),
  );

  cleanupFns.push(
    onAppEvent("customfunctions:consent-denied", (detail) => {
      const { packageName } = (detail ?? {}) as { packageName?: string };
      if (packageName) {
        pendingConsents.delete(packageName);
        declined.add(packageName);
      }
      activeConsent = null;
      showNextConsent();
    }),
  );

  // Install persisted functions now, and re-install whenever a workbook opens.
  void loadAndInstallCustomFunctions();
  const unsub = context.events.on(AppEvents.AFTER_OPEN, () => {
    // A different workbook is a different consent domain: drop every queued
    // question (and every session refusal) before the new file's gate speaks.
    consentEpoch++;
    pendingConsents.clear();
    consentQueue.length = 0;
    declined.clear();
    if (activeConsent !== null) {
      DialogExtensions.closeDialog(CONSENT_DIALOG_ID);
      activeConsent = null;
    }
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
