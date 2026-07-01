//! FILENAME: app/src/shell/registries/ExtensionManager.ts
// PURPOSE: Manages extension lifecycle (loading, activation, deactivation).
// CONTEXT: Loads built-in extensions from manifest.ts and supports runtime loading.
// NOTE: Uses vanilla listener pattern instead of RxJS for simplicity.

import type { ExtensionModule, ExtensionContext } from "../../api/contract";
import type { LoadedExtension, ExtensionManagerApi } from "../../api/extensionManager";
import { CommandRegistry } from "../../api/commands";
import { API_VERSION } from "../../api/version";
import { builtInExtensions } from "../../../extensions/manifest";
import { invokeBackend, type InvokeArgs } from "../../api/backend";
import { createScopedInvokeBackend } from "../../api/backendCommands";

// Import free functions from API to wire into the context object
import {
  registerMenu,
  registerMenuItem,
  getMenus,
  subscribeToMenus,
  notifyMenusChanged,
  registerTaskPane,
  unregisterTaskPane,
  openTaskPane,
  closeTaskPane,
  getTaskPane,
  showTaskPaneContainer,
  hideTaskPaneContainer,
  isTaskPaneContainerOpen,
  getTaskPaneManuallyClosed,
  markTaskPaneManuallyClosed,
  clearTaskPaneManuallyClosed,
  addTaskPaneContextKey,
  removeTaskPaneContextKey,
  registerDialog,
  unregisterDialog,
  showDialog,
  hideDialog,
  registerOverlay,
  unregisterOverlay,
  registerShellComponent,
  unregisterShellComponent,
  showOverlay,
  hideOverlay,
  hideAllOverlays,
  registerStatusBarItem,
  unregisterStatusBarItem,
  registerActivityView,
  unregisterActivityView,
  openActivityView,
  closeActivityView,
  toggleActivityView,
  registerPanel,
  unregisterPanel,
  openPanel,
  closePanel,
  getPanelPlacement,
  setPanelPlacement,
} from "../../api/ui";
import { emitAppEvent, onAppEvent } from "../../api/events";
import { showToast } from "../../api/notifications";
import {
  registerCellDecoration,
  unregisterCellDecoration,
} from "../../api/cellDecorations";
import {
  registerStyleInterceptor,
  unregisterStyleInterceptor,
  markRangeDirty,
  markSheetDirty,
} from "../../api/styleInterceptors";
import { registerGridOverlay } from "../../api/gridOverlays";
import { registerEditGuard, registerRangeGuard } from "../../api/editGuards";
import { registerCellClickInterceptor } from "../../api/cellClickInterceptors";
import { registerCellDoubleClickInterceptor } from "../../api/cellDoubleClickInterceptors";
import {
  registerKeybinding,
  getAllKeybindings,
  getEffectiveCombo,
} from "../../api/keybindings";
import {
  getSetting,
  setSetting,
  removeSetting,
  registerSettingDefinitions,
} from "../../api/settings";
import { registerCellEditor } from "../../api/cellEditors";
import { registerFileFormat, getFileFormats } from "../../api/fileFormats";
import { registerFunction } from "../../api/formulaFunctions";
// Wave 3 / S8-C7: reuse the script broker's capability vocabulary, handle model,
// and transparency registry to classify + record distributed extensions.
import { CAPABILITY_ID_SET, type CapabilityId } from "../../api/scriptHost/capabilityIds";
import { getScriptExecutionStatus } from "../../api/scriptSecurity";
import {
  buildHandleFromDefinition,
  registerMountedHandle,
} from "../../api/scriptHost/broker";
import {
  computeExtensionCeiling,
  mayActivateOnMainThread,
  type ExtensionTrust,
} from "./extensionTrust";
import { loadDisabledIds, persistDisabledIds } from "./extensionDisabledStore";
import {
  type ConsentMap,
  loadConsents,
  recordConsent,
  isConsentCurrent,
  extensionConsentHash,
} from "./extensionConsentStore";
// Phase B: sandboxed worker-realm execution for opted-in distributed extensions.
import {
  mountWorkerExtension,
  unmountWorkerExtension,
} from "../../api/scriptHost/extensionWorkerHost";
import type { WorkerExtensionManifest } from "../../api/scriptHost/extensionProtocol";

// ============================================================================
// Types
// ============================================================================
//
// ExtensionStatus + LoadedExtension are the @api extension-host contract
// (../../api/extensionManager), imported above. This module IMPLEMENTS that
// contract (ExtensionManagerImpl implements ExtensionManagerApi) and the Shell
// registers the singleton via registerExtensionManager() at boot.

type ChangeListener = () => void;

// The user can disable third-party extensions. The disabled set is persisted to
// localStorage so a disabled extension stays disabled across restarts (it is
// skipped during load but still listed, so it can be re-enabled). This mirrors
// VS Code's model: disabling tears the extension down now; enabling takes effect
// on the next reload. Persistence lives in a tiny standalone module so it is
// unit-testable without the heavy ExtensionManager import graph.

/** Entry returned by the Rust scan_extension_directory command */
interface ExtensionFileEntry {
  fileName: string;
  path: string;
  content: string;
  /** Raw JSON of the sidecar manifest, if present (lets the host read
   *  workerSupport + the capability ceiling WITHOUT importing the bundle). */
  manifestJson?: string;
  /** Ed25519 signature trust over the sidecar manifest:
   *  "unsigned" | "invalid" | "publisherChanged" | "firstUse" | "verified". */
  trustStatus?: string;
}

/** The fields the host reads from a sidecar manifest. */
interface SidecarManifest {
  id: string;
  name?: string;
  version?: string;
  capabilities?: string[];
  workerSupport?: boolean;
}

// ============================================================================
// API Version Compatibility Check
// ============================================================================

/**
 * Parse a version string into [major, minor, patch].
 */
function parseVersion(version: string): [number, number, number] {
  const parts = version.replace(/^[^0-9]*/, "").split(".").map(Number);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/**
 * Check if the host API version satisfies the extension's required version.
 * Supports caret ranges (^1.2.3 means >=1.2.3 and <2.0.0).
 * If no prefix, treats as exact major match (1.x compatible with 1.y).
 */
function isApiVersionCompatible(required: string, host: string): boolean {
  const isCaret = required.startsWith("^");
  const [reqMajor, reqMinor, reqPatch] = parseVersion(required);
  const [hostMajor, hostMinor, hostPatch] = parseVersion(host);

  if (isCaret) {
    // ^1.2.3 means >=1.2.3 and <2.0.0
    if (hostMajor !== reqMajor) return false;
    if (hostMinor < reqMinor) return false;
    if (hostMinor === reqMinor && hostPatch < reqPatch) return false;
    return true;
  }

  // Default: same major version is compatible
  return hostMajor === reqMajor;
}

// ============================================================================
// Build the ExtensionContext (DI wiring)
// ============================================================================

function buildContext(): ExtensionContext {
  return {
    commands: CommandRegistry,
    formulas: {
      registerFunction,
    },
    ui: {
      menus: {
        register: registerMenu,
        registerItem: registerMenuItem,
        getAll: getMenus,
        subscribe: subscribeToMenus,
        notifyChanged: notifyMenusChanged,
      },
      taskPanes: {
        register: registerTaskPane,
        unregister: unregisterTaskPane,
        open: openTaskPane,
        close: closeTaskPane,
        getView: getTaskPane,
        showContainer: showTaskPaneContainer,
        hideContainer: hideTaskPaneContainer,
        isContainerOpen: isTaskPaneContainerOpen,
        addContextKey: addTaskPaneContextKey,
        removeContextKey: removeTaskPaneContextKey,
        getManuallyClosed: getTaskPaneManuallyClosed,
        markManuallyClosed: markTaskPaneManuallyClosed,
        clearManuallyClosed: clearTaskPaneManuallyClosed,
      },
      dialogs: {
        register: registerDialog,
        unregister: unregisterDialog,
        show: showDialog,
        hide: hideDialog,
      },
      overlays: {
        register: registerOverlay,
        unregister: unregisterOverlay,
        show: showOverlay,
        hide: hideOverlay,
        hideAll: hideAllOverlays,
      },
      statusBar: {
        register: registerStatusBarItem,
        unregister: unregisterStatusBarItem,
      },
      activityBar: {
        register: registerActivityView,
        unregister: unregisterActivityView,
        open: openActivityView,
        close: closeActivityView,
        toggle: toggleActivityView,
      },
      panels: {
        register: registerPanel,
        unregister: unregisterPanel,
        open: openPanel,
        close: closePanel,
        getPlacement: getPanelPlacement,
        setPlacement: setPanelPlacement,
      },
      notifications: {
        showToast,
      },
      shellComponents: {
        register: registerShellComponent,
        unregister: unregisterShellComponent,
      },
    },
    events: {
      emit: emitAppEvent,
      on: onAppEvent,
    },
    grid: {
      decorations: {
        register: registerCellDecoration,
        unregister: unregisterCellDecoration,
      },
      styleInterceptors: {
        register: registerStyleInterceptor,
        unregister: unregisterStyleInterceptor,
        markRangeDirty,
        markSheetDirty,
      },
      overlays: {
        register: registerGridOverlay,
      },
      editGuards: {
        register: registerEditGuard,
      },
      rangeGuards: {
        register: registerRangeGuard,
      },
      cellClicks: {
        registerClickInterceptor: registerCellClickInterceptor,
        registerDoubleClickInterceptor: registerCellDoubleClickInterceptor,
      },
    },
    keybindings: {
      register: registerKeybinding,
      getAll: getAllKeybindings,
      getEffectiveCombo,
    },
    settings: {
      get: <T extends string | number | boolean>(key: string, defaultValue: T): T =>
        getSetting("", key, defaultValue),
      set: (key: string, value: string | number | boolean) =>
        setSetting("", key, value),
      remove: (key: string) =>
        removeSetting("", key),
      registerSettings: (defs: import("../../api/settings").SettingDefinition[]) =>
        registerSettingDefinitions("", defs),
    },
    cellEditors: {
      register: registerCellEditor,
    },
    fileFormats: {
      registerFormat: registerFileFormat,
      getFormats: getFileFormats,
    },
    // The trust-less base context is never handed to an extension directly —
    // every extension receives the per-extension override in activateExtension,
    // which carries the real trust-scoped door. If this stub ever runs, a
    // context leaked without a trust classification; refuse loudly rather than
    // invoke ungated (A3 backend facade; see docs/design/backend-facade.md).
    invokeBackend: <T>(_command: string, _args?: InvokeArgs): Promise<T> =>
      Promise.reject(
        new Error(
          "invokeBackend is unavailable on the base extension context (no trust classification)",
        ),
      ),
  };
}

// ============================================================================
// ExtensionManager Implementation
// ============================================================================

class ExtensionManagerImpl implements ExtensionManagerApi {
  private extensions: Map<string, LoadedExtension> = new Map();
  private listeners: Set<ChangeListener> = new Set();
  private initialized = false;

  // Cached array for useSyncExternalStore - MUST return same reference if data unchanged
  private cachedExtensionsArray: LoadedExtension[] = [];

  /** Ids the user has disabled (persisted). Distributed extensions in this set
   *  are skipped during load and torn down immediately when disabled at runtime. */
  private disabledIds: Set<string> = loadDisabledIds();
  /** B3: persisted first-use consent (extId -> the content/trust hash the user
   *  approved). A disk-scanned distributed extension whose current hash is not
   *  in here is listed but NOT activated until consent is granted. */
  private consents: ConsentMap = loadConsents();
  /** B3: extensions awaiting a consent decision this launch, keyed by the same
   *  id used in the manager list. Holds the scan entry + hash so the extension
   *  can be mounted as-is once consent is granted (no re-scan). */
  private pendingConsent: Map<string, { entry: ExtensionFileEntry; hash: string }> = new Map();

  /**
   * The context passed to all extensions during activation.
   * This is our Dependency Injection container.
   */
  private readonly context: ExtensionContext = buildContext();

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  /**
   * Initialize the extension manager and load all built-in extensions.
   * Safe to call multiple times (only initializes once).
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      console.log("[ExtensionManager] Already initialized, skipping.");
      return;
    }

    console.log("[ExtensionManager] Initializing...");
    this.initialized = true;

    // Load all built-in extensions from the manifest. Built-ins are TRUSTED
    // (first-party, kernel-adjacent) — full host authority.
    for (const module of builtInExtensions) {
      await this.activateExtension(module, "trusted");
    }

    // Load third-party extensions from the user's extensions directory
    await this.loadThirdPartyExtensions();

    console.log(
      `[ExtensionManager] Initialization complete. ${this.extensions.size} extensions loaded.`
    );
  }

  /**
   * Check if the manager has been initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  // --------------------------------------------------------------------------
  // Extension Activation
  // --------------------------------------------------------------------------

  /**
   * Activate an extension module under a trust classification (Wave 3 / S8-C7).
   * Built-ins pass "trusted"; third-party bundles pass "distributed".
   */
  private async activateExtension(
    module: ExtensionModule,
    trust: ExtensionTrust,
    trustStatus?: string,
    fileName?: string,
  ): Promise<void> {
    const { id, name, version } = module.manifest;

    // Check for duplicate
    if (this.extensions.has(id)) {
      console.warn(`[ExtensionManager] Extension '${id}' already loaded, skipping.`);
      return;
    }

    const declaredCapabilities = computeExtensionCeiling(
      module.manifest.capabilities,
      trust,
    );

    // Add as pending
    const entry: LoadedExtension = {
      id,
      name,
      version,
      status: "pending",
      module,
      trust,
      declaredCapabilities,
      trustStatus,
      fileName,
    };
    this.extensions.set(id, entry);

    // Distributed extensions are surfaced in the transparency panel with their
    // declared ceiling (deny-by-default; grants come only through consent), so
    // the user always knows a third-party extension is present and what it may
    // touch. This reuses the script broker's handle + transparency registry; in
    // Phase B the same handle gates the extension's broker-mediated calls.
    if (trust === "distributed") {
      const handle = buildHandleFromDefinition({
        id: `extension:${id}`,
        name,
        objectType: "extension",
        instanceId: null,
        accessLevel: "restricted",
        provenance: "distributed",
        packageName: id,
        declaredCapabilities,
      });
      entry.handleCleanup = registerMountedHandle(handle);
    }

    this.updateCachedArray();
    this.notifyChange();

    // Check API version compatibility
    if (module.manifest.apiVersion) {
      if (!isApiVersionCompatible(module.manifest.apiVersion, API_VERSION)) {
        entry.status = "error";
        entry.error = new Error(
          `Extension '${id}' requires API ${module.manifest.apiVersion} but host is ${API_VERSION}`
        );
        console.error(`[ExtensionManager] ${entry.error.message}`);
        this.updateCachedArray();
        this.notifyChange();
        return;
      }
    }

    try {
      console.log(`[ExtensionManager] Activating extension: ${id} (${name} v${version})`);
      // Create a per-extension context with extension-scoped APIs
      const extContext: ExtensionContext = {
        ...this.context,
        keybindings: {
          register: (binding) =>
            registerKeybinding({ ...binding, source: "extension", extensionId: id }),
          getAll: getAllKeybindings,
          getEffectiveCombo,
        },
        settings: {
          get: <T extends string | number | boolean>(key: string, defaultValue: T) =>
            getSetting(id, key, defaultValue),
          set: (key: string, value: string | number | boolean) =>
            setSetting(id, key, value),
          remove: (key: string) => removeSetting(id, key),
          registerSettings: (definitions) =>
            registerSettingDefinitions(id, definitions),
        },
        cellEditors: {
          register: (editorId, canEdit, component, priority) =>
            registerCellEditor(editorId, canEdit, component, priority),
        },
        fileFormats: {
          registerFormat: registerFileFormat,
          getFormats: getFileFormats,
        },
        // Capability-scoped backend door (A3). `trust` is already classified for
        // this extension here, so enforcement is a single gate before the raw
        // invoke: trusted (built-in) callers pass everything; distributed
        // (third-party) callers are denied privileged commands. The denylist,
        // gate, and this factory all live in @api/backendCommands.
        invokeBackend: createScopedInvokeBackend(trust === "trusted", invokeBackend),
      };
      await module.activate(extContext);

      entry.status = "active";
      console.log(`[ExtensionManager] Extension '${id}' activated successfully.`);
    } catch (error) {
      entry.status = "error";
      entry.error = error instanceof Error ? error : new Error(String(error));
      console.error(`[ExtensionManager] Failed to activate extension '${id}':`, error);
    }

    this.updateCachedArray();
    this.notifyChange();
  }

  // --------------------------------------------------------------------------
  // Third-Party Extension Loading
  // --------------------------------------------------------------------------

  /**
   * Load all third-party extensions from the user's extensions directory.
   * Extensions are pre-built .js bundles placed in the app data extensions folder.
   * Each bundle must be an ES module that default-exports an ExtensionModule.
   */
  async loadThirdPartyExtensions(): Promise<void> {
    try {
      // Get the extensions directory path from the backend
      const extDir = await invokeBackend<string>("get_extensions_directory");
      console.log(`[ExtensionManager] Scanning for third-party extensions in: ${extDir}`);

      // Scan directory for .js extension bundles
      const entries = await invokeBackend<ExtensionFileEntry[]>("scan_extension_directory", {
        dir: extDir,
      });

      if (entries.length === 0) {
        console.log("[ExtensionManager] No third-party extensions found.");
        return;
      }

      console.log(`[ExtensionManager] Found ${entries.length} third-party extension(s).`);

      for (const entry of entries) {
        try {
          await this.loadExtension(entry);
        } catch (error) {
          console.error(
            `[ExtensionManager] Failed to load third-party extension '${entry.fileName}':`,
            error
          );
        }
      }

      // Consent gate (B3): any extension the gate held back is now LISTED but
      // un-mounted. Prompt for them WITHOUT awaiting — startup completes (the
      // shell becomes ready) and consents are resolved afterward, so a TOFU
      // prompt can never hang launch. Granting mounts the extension live.
      if (this.pendingConsent.size > 0) {
        void this.processPendingConsents();
      }
    } catch (error) {
      console.error("[ExtensionManager] Failed to scan for third-party extensions:", error);
    }
  }

  /**
   * Load a scanned third-party extension, routing by its (verified) sidecar
   * manifest when present.
   *
   * With a sidecar manifest the host knows workerSupport + the capability
   * ceiling WITHOUT importing the bundle: a workerSupport:true bundle goes
   * straight to the worker realm with the AUTHORITATIVE, trust-gated ceiling
   * (no throwaway worker, no main-thread import); otherwise it goes straight to
   * the main thread. Without a sidecar we keep the legacy behavior (try worker
   * first, then main thread).
   */
  private async loadExtension(entry: ExtensionFileEntry): Promise<void> {
    const parsed = this.parseSidecarManifest(entry.manifestJson);

    // Disabled (C7): the user turned this extension off. Don't mount/activate —
    // just list it as inactive so it can be re-enabled. Persisted-disable works
    // for sidecar-manifest extensions because the id is known before loading.
    if (parsed && this.disabledIds.has(parsed.id)) {
      this.recordDisabledExtension(parsed, entry.trustStatus, entry.fileName);
      return;
    }

    // Script Security master switch — LOCKDOWN parity with the worker-realm script
    // surfaces (object scripts / chart marks / chart transforms / UDFs all gate at
    // hostMountScript via @api/scriptSecurity). A distributed extension also runs
    // arbitrary JS in a worker realm (extensionWorkerHost), so "disabled" must
    // block it too — otherwise the global kill-switch is not honest. We check the
    // non-throwing status here (the single chokepoint every mount path funnels
    // through, including the "Allow"-button re-entry via grantConsentAndActivate)
    // and LIST the extension as blocked so the user still sees it + why. Note:
    // "prompt"/"enabled" deliberately fall through to the extension's OWN trust +
    // per-extension consent gate below (which already asks before first run), so we
    // neither double-prompt nor hang app startup with a master-switch confirm.
    if ((await getScriptExecutionStatus()) === "disabled") {
      const blockedName = parsed?.name || entry.fileName;
      this.recordBlockedExtension(
        blockedName,
        `Extension "${blockedName}" was blocked: Script Security is set to "disabled".`,
        entry.trustStatus,
        entry.fileName,
      );
      return;
    }

    // Consent gate (B3): a disk-scanned distributed extension must NOT auto-
    // activate on first sight — the exact VBA failure mode the project was
    // founded to fix. Consent is keyed by a stable pre-load id (the sidecar id,
    // or the file name when there is no sidecar) + a content/trust hash, so a
    // code swap, a capability change, OR a signature-status change re-prompts.
    // Un-consented bundles are LISTED (so the user sees them in the manager) but
    // their code is never imported until consent is granted.
    const consentId = parsed?.id ?? entry.fileName;
    const consentHash = await extensionConsentHash(entry.content, entry.trustStatus);
    if (!isConsentCurrent(this.consents, consentId, consentHash)) {
      this.recordPendingConsent(consentId, consentHash, entry, parsed);
      return;
    }

    if (!parsed) {
      await this.loadExtensionFromSourceLegacy(entry.content, entry.fileName);
      return;
    }

    // The declared ceiling is honored ONLY for a verified / first-use signature;
    // unsigned / invalid / changed -> deny-by-default (empty ceiling, still loads).
    const trustOk = entry.trustStatus === "verified" || entry.trustStatus === "firstUse";
    const ceiling = trustOk
      ? (parsed.capabilities ?? []).filter((c): c is CapabilityId => CAPABILITY_ID_SET.has(c as CapabilityId))
      : [];
    if (!trustOk) {
      console.warn(
        `[ExtensionManager] '${parsed.id}' sidecar trust='${entry.trustStatus}': capabilities denied (deny-by-default).`,
      );
    }

    const displayName = parsed.name || entry.fileName;
    if (parsed.workerSupport === true) {
      const result = await mountWorkerExtension(entry.content, displayName, {
        id: parsed.id,
        name: parsed.name ?? parsed.id,
        version: parsed.version ?? "0.0.0",
        capabilities: ceiling,
        workerSupport: true,
      });
      if (result.ok && result.extId) {
        this.recordWorkerExtension(result.extId, result.manifest, displayName, entry.trustStatus, entry.fileName);
        return;
      }
      console.warn(
        `[ExtensionManager] worker mount failed for '${parsed.id}', falling back to main thread:`,
        result.error,
      );
    }
    // workerSupport:false (or the worker mount failed) -> main thread directly.
    await this.activateMainThreadExtension(entry.content, displayName, entry.trustStatus, entry.fileName);
  }

  /** List a disabled distributed extension WITHOUT loading its code, so the
   *  manager UI can show it (with its declared ceiling + signature) and offer to
   *  re-enable it. The ceiling shown is what it WOULD get if trusted + enabled. */
  private recordDisabledExtension(parsed: SidecarManifest, trustStatus?: string, fileName?: string): void {
    if (this.extensions.has(parsed.id)) return;
    const declaredCapabilities = computeExtensionCeiling(
      (parsed.capabilities ?? []).filter((c): c is CapabilityId => CAPABILITY_ID_SET.has(c as CapabilityId)),
      "distributed",
    );
    const displayName = parsed.name || parsed.id;
    const entry: LoadedExtension = {
      id: parsed.id,
      name: displayName,
      version: parsed.version ?? "0.0.0",
      status: "inactive",
      // Synthetic module: the real code was never imported (it's disabled).
      module: { manifest: { id: parsed.id, name: displayName, version: parsed.version ?? "0.0.0" }, activate: () => {} },
      trust: "distributed",
      declaredCapabilities,
      trustStatus,
      worker: parsed.workerSupport === true,
      fileName,
    };
    this.extensions.set(parsed.id, entry);
    this.updateCachedArray();
    this.notifyChange();
    console.log(`[ExtensionManager] Disabled extension '${parsed.id}' listed (not loaded).`);
  }

  /** Parse a sidecar manifest JSON string into the fields the host reads. */
  private parseSidecarManifest(manifestJson?: string): SidecarManifest | null {
    if (!manifestJson) return null;
    try {
      const m = JSON.parse(manifestJson) as SidecarManifest;
      return m && typeof m.id === "string" && m.id.length > 0 ? m : null;
    } catch {
      return null;
    }
  }

  /**
   * Legacy load path (no sidecar manifest): try the worker realm first (the
   * worker reports its own manifest), then fall back to the main thread.
   */
  private async loadExtensionFromSourceLegacy(source: string, name: string): Promise<void> {
    console.log(`[ExtensionManager] Loading third-party extension (no sidecar): ${name}`);
    try {
      const result = await mountWorkerExtension(source, name);
      if (result.ok && result.extId) {
        // Legacy path: `name` IS the scan file name (used for uninstall).
        this.recordWorkerExtension(result.extId, result.manifest, name, undefined, name);
        return;
      }
    } catch (e) {
      console.warn(
        `[ExtensionManager] worker-realm mount failed for '${name}', falling back to main thread:`,
        e,
      );
    }
    await this.activateMainThreadExtension(source, name, undefined, name);
  }

  /**
   * SECURITY (B2): distributed (third-party) extensions are REFUSED on the main
   * thread. This path is reached ONLY by distributed bundles — built-ins activate
   * via activateExtension(module,"trusted") and never get here. Untrusted code on
   * the main thread would have full ambient window/Tauri/@api authority that the
   * broker/capability ceiling cannot bound (the founding vision: "never with full
   * machine access like VBA macros"). Such an extension must declare
   * workerSupport:true to run sandboxed. The bundle is NOT imported/executed; it
   * is listed (status:error) so the user can see it — and why — in the manager.
   */
  private async activateMainThreadExtension(_source: string, name: string, trustStatus?: string, fileName?: string): Promise<void> {
    if (!mayActivateOnMainThread("distributed")) {
      const reason =
        `Extension "${name}" was blocked: third-party extensions must run sandboxed ` +
        `(declare workerSupport:true) — they are not allowed full main-thread access.`;
      console.warn(`[ExtensionManager] ${reason}`);
      showToast(reason, { variant: "warning" });
      this.recordBlockedExtension(name, reason, trustStatus, fileName);
      return;
    }
    // No main-thread activation path exists for distributed code by design.
  }

  /** List a distributed extension that was BLOCKED (refused main-thread
   *  activation, B2) so the user sees it + the reason in the manager, WITHOUT
   *  importing/executing its code. Mirrors recordDisabledExtension. */
  private recordBlockedExtension(name: string, reason: string, trustStatus?: string, fileName?: string): void {
    const id = fileName ?? name;
    if (this.extensions.has(id)) return;
    const entry: LoadedExtension = {
      id,
      name,
      version: "0.0.0",
      status: "error",
      error: new Error(reason),
      // Synthetic module: the real code was never imported (it's blocked).
      module: { manifest: { id, name, version: "0.0.0" }, activate: () => {} },
      trust: "distributed",
      declaredCapabilities: [],
      trustStatus,
      worker: false,
      fileName,
    };
    this.extensions.set(id, entry);
    this.updateCachedArray();
    this.notifyChange();
    console.log(`[ExtensionManager] Blocked extension '${id}' listed (not loaded).`);
  }

  /** List a disk-scanned distributed extension that is awaiting first-use
   *  consent (B3): the bundle is NOT imported; it is recorded as inactive +
   *  needsConsent so the manager shows it and offers an "Allow" action. The scan
   *  entry + hash are stashed so grantConsentAndActivate can mount it as-is. */
  private recordPendingConsent(
    id: string,
    hash: string,
    entry: ExtensionFileEntry,
    parsed: SidecarManifest | null,
  ): void {
    this.pendingConsent.set(id, { entry, hash });
    if (!this.extensions.has(id)) {
      const displayName = parsed?.name || entry.fileName;
      const version = parsed?.version ?? "0.0.0";
      // The ceiling shown is what it WOULD get once trusted + consented.
      const declaredCapabilities = parsed
        ? computeExtensionCeiling(
            (parsed.capabilities ?? []).filter((c): c is CapabilityId => CAPABILITY_ID_SET.has(c as CapabilityId)),
            "distributed",
          )
        : [];
      this.extensions.set(id, {
        id,
        name: displayName,
        version,
        status: "inactive",
        // Synthetic module: the real code was never imported (consent pending).
        module: { manifest: { id, name: displayName, version }, activate: () => {} },
        trust: "distributed",
        declaredCapabilities,
        trustStatus: entry.trustStatus,
        worker: parsed?.workerSupport === true,
        fileName: entry.fileName,
        needsConsent: true,
      });
      this.updateCachedArray();
      this.notifyChange();
    }
    console.log(`[ExtensionManager] Extension '${id}' awaiting consent (not loaded).`);
  }

  /** Grant first-use consent for a pending extension and mount it (B3). Records
   *  consent at the hash seen at scan time (so it survives restarts), drops the
   *  synthetic needs-consent entry, then re-runs loadExtension — which now passes
   *  the consent gate and mounts via the normal worker/main path. */
  async grantConsentAndActivate(id: string): Promise<void> {
    const pending = this.pendingConsent.get(id);
    if (!pending) {
      console.warn(`[ExtensionManager] grantConsentAndActivate: '${id}' is not awaiting consent.`);
      return;
    }
    recordConsent(id, pending.hash);
    this.consents.set(id, pending.hash);
    this.pendingConsent.delete(id);
    // Remove the synthetic placeholder so loadExtension can record the real one.
    this.extensions.delete(id);
    this.updateCachedArray();
    this.notifyChange();
    await this.loadExtension(pending.entry);
  }

  /** True when a listed extension is awaiting a first-use consent decision. */
  isAwaitingConsent(id: string): boolean {
    return this.pendingConsent.has(id);
  }

  /** Prompt for every extension awaiting first-use consent (B3). Run
   *  fire-and-forget AFTER the scan loop so startup is never blocked: each
   *  prompt is a once-per-machine TOFU accept (mirrors the .calp pull + the
   *  object-script consent gate). Declining leaves the extension listed but
   *  un-mounted; the manager's "Allow" action can grant it later. */
  private async processPendingConsents(): Promise<void> {
    for (const [id] of [...this.pendingConsent]) {
      const ext = this.extensions.get(id);
      const name = ext?.name ?? id;
      const caps = ext?.declaredCapabilities ?? [];
      const signed = ext?.trustStatus === "verified" || ext?.trustStatus === "firstUse";
      let allow = false;
      try {
        allow = window.confirm(
          `Calcula found a third-party extension that was not installed by Calcula:\n\n` +
            `    "${name}"\n\n` +
            `Signature: ${signed ? (ext?.trustStatus ?? "signed") : "unsigned / unverified"}\n` +
            `Capabilities it can use: ${caps.length ? caps.join(", ") : "none"}\n\n` +
            `Custom code can read and change your data. Only allow extensions you trust.\n\n` +
            `Allow "${name}" to load? (You can change this later in Extensions.)`,
        );
      } catch {
        // No confirm available (headless/test) -> fail closed: leave un-mounted.
        allow = false;
      }
      if (allow) {
        await this.grantConsentAndActivate(id);
      }
    }
  }

  /** Record a sandboxed worker extension in the manager's list. The worker host
   *  (extensionWorkerHost) owns its lifecycle + transparency handle; this entry
   *  exists only so it shows in the extensions list. */
  private recordWorkerExtension(
    extId: string,
    manifest: WorkerExtensionManifest | undefined,
    fallbackName: string,
    trustStatus?: string,
    fileName?: string,
  ): void {
    if (this.extensions.has(extId)) return;
    const displayName = manifest?.name || fallbackName;
    const version = manifest?.version || "0.0.0";
    const declaredCapabilities = computeExtensionCeiling(
      manifest?.capabilities as CapabilityId[] | undefined,
      "distributed",
    );
    const entry: LoadedExtension = {
      id: extId,
      name: displayName,
      version,
      status: "active",
      // Synthetic module: the real code lives in the worker; deactivation routes
      // through unmountWorkerExtension, so `module` is never invoked.
      module: { manifest: { id: extId, name: displayName, version }, activate: () => {} },
      trust: "distributed",
      declaredCapabilities,
      trustStatus,
      worker: true,
      fileName,
    };
    this.extensions.set(extId, entry);
    this.updateCachedArray();
    this.notifyChange();
    console.log(`[ExtensionManager] Worker-isolated extension '${extId}' active.`);
  }

  // --------------------------------------------------------------------------
  // Extension Deactivation
  // --------------------------------------------------------------------------

  /**
   * Deactivate an extension by ID.
   */
  async deactivateExtension(id: string): Promise<void> {
    const entry = this.extensions.get(id);
    if (!entry) {
      console.warn(`[ExtensionManager] Cannot deactivate unknown extension: ${id}`);
      return;
    }

    if (entry.status !== "active") {
      console.warn(`[ExtensionManager] Extension '${id}' is not active (status: ${entry.status})`);
      return;
    }

    // Worker-isolated (Phase B) extensions tear down through the worker host.
    if (entry.worker) {
      try {
        await unmountWorkerExtension(id);
        entry.status = "inactive";
        console.log(`[ExtensionManager] Worker extension '${id}' deactivated.`);
      } catch (error) {
        console.error(`[ExtensionManager] Error deactivating worker extension '${id}':`, error);
        entry.status = "error";
        entry.error = error instanceof Error ? error : new Error(String(error));
      }
      this.updateCachedArray();
      this.notifyChange();
      return;
    }

    try {
      if (entry.module.deactivate) {
        console.log(`[ExtensionManager] Deactivating extension: ${id}`);
        entry.module.deactivate();
      }
      // Drop the transparency-panel handle (distributed extensions only).
      entry.handleCleanup?.();
      entry.handleCleanup = undefined;
      entry.status = "inactive";
      console.log(`[ExtensionManager] Extension '${id}' deactivated.`);
    } catch (error) {
      console.error(`[ExtensionManager] Error deactivating extension '${id}':`, error);
      entry.status = "error";
      entry.error = error instanceof Error ? error : new Error(String(error));
    }

    this.updateCachedArray();
    this.notifyChange();
  }

  // --------------------------------------------------------------------------
  // Accessors
  // --------------------------------------------------------------------------

  /**
   * Update the cached array. Call this whenever extensions Map changes.
   * This ensures getExtensions() returns a stable reference for useSyncExternalStore.
   */
  private updateCachedArray(): void {
    for (const entry of this.extensions.values()) {
      entry.disabled = this.disabledIds.has(entry.id);
    }
    this.cachedExtensionsArray = Array.from(this.extensions.values());
  }

  // --------------------------------------------------------------------------
  // Enable / Disable (C7)
  // --------------------------------------------------------------------------

  /**
   * Enable or disable a third-party extension (built-ins cannot be disabled —
   * they are kernel-adjacent). Disabling tears the extension down immediately
   * AND persists, so it stays off across restarts. Enabling clears the persisted
   * flag; like VS Code, the extension actually loads again on the next reload.
   */
  async setExtensionEnabled(id: string, enabled: boolean): Promise<void> {
    const entry = this.extensions.get(id);
    if (!entry) {
      console.warn(`[ExtensionManager] Cannot toggle unknown extension: ${id}`);
      return;
    }
    if (entry.trust === "trusted") {
      console.warn(`[ExtensionManager] Built-in extension '${id}' cannot be disabled.`);
      return;
    }

    if (enabled) {
      // Clear the persisted flag. The bundle reloads on next launch.
      this.disabledIds.delete(id);
      persistDisabledIds(this.disabledIds);
      this.updateCachedArray();
      this.notifyChange();
      console.log(`[ExtensionManager] Extension '${id}' enabled (loads on next reload).`);
      return;
    }

    // Disable: persist first so a teardown failure still records intent, then
    // tear down now for immediate effect (safety — stop a misbehaving extension).
    this.disabledIds.add(id);
    persistDisabledIds(this.disabledIds);
    if (entry.status === "active") {
      await this.deactivateExtension(id);
    } else {
      this.updateCachedArray();
      this.notifyChange();
    }
    console.log(`[ExtensionManager] Extension '${id}' disabled.`);
  }

  /** Whether an extension is currently disabled (persisted). */
  isDisabled(id: string): boolean {
    return this.disabledIds.has(id);
  }

  /**
   * Uninstall a third-party extension: tear it down (if running), delete its
   * bundle + sidecar files from the extensions directory, and drop it from the
   * list. Built-ins cannot be uninstalled. Idempotent on the list side even if
   * the backend delete fails (the error propagates to the caller).
   */
  async uninstallExtension(id: string): Promise<void> {
    const entry = this.extensions.get(id);
    if (!entry) {
      console.warn(`[ExtensionManager] Cannot uninstall unknown extension: ${id}`);
      return;
    }
    if (entry.trust === "trusted") {
      console.warn(`[ExtensionManager] Built-in extension '${id}' cannot be uninstalled.`);
      return;
    }
    if (!entry.fileName) {
      throw new Error(`Extension '${id}' has no known file on disk to uninstall.`);
    }

    // Tear down a running extension before deleting its files. deactivateExtension
    // records status="error" instead of throwing on a teardown failure, so check
    // it explicitly: deleting the bundle while its command handlers / ribbon tabs /
    // event subscriptions are still live would leave dangling registrations with no
    // backing code AND no way to retry (the entry would be gone). Abort instead.
    if (entry.status === "active") {
      await this.deactivateExtension(id);
      // deactivateExtension mutates entry.status to "error" on a teardown
      // failure, but TS keeps the "active" narrowing across the await — read it
      // back through a widening cast so the (intentional) check type-checks.
      if ((entry.status as string) === "error") {
        throw new Error(
          `Cannot uninstall '${id}': teardown failed (${entry.error?.message ?? "unknown error"}). ` +
          `Files were left on disk to avoid dangling live registrations — reload and retry.`,
        );
      }
    }

    // Delete the bundle + sidecars on disk (path-traversal-guarded in Rust).
    await invokeBackend("uninstall_extension", { fileName: entry.fileName });

    // Drop it from the list + any persisted disabled flag.
    this.extensions.delete(id);
    if (this.disabledIds.delete(id)) {
      persistDisabledIds(this.disabledIds);
    }
    this.updateCachedArray();
    this.notifyChange();
    console.log(`[ExtensionManager] Extension '${id}' uninstalled.`);
  }

  /**
   * Get all loaded extensions.
   * Returns a cached array reference for useSyncExternalStore compatibility.
   */
  getExtensions(): LoadedExtension[] {
    return this.cachedExtensionsArray;
  }

  /**
   * Get a specific extension by ID.
   */
  getExtension(id: string): LoadedExtension | undefined {
    return this.extensions.get(id);
  }

  /**
   * Get all active extensions.
   */
  getActiveExtensions(): LoadedExtension[] {
    return this.cachedExtensionsArray.filter((ext) => ext.status === "active");
  }

  /**
   * Get count of loaded extensions.
   */
  getExtensionCount(): number {
    return this.extensions.size;
  }

  // --------------------------------------------------------------------------
  // Change Subscription (Vanilla Listener Pattern)
  // --------------------------------------------------------------------------

  /**
   * Subscribe to extension state changes.
   * @param callback Called whenever extensions are added, removed, or change status
   * @returns Unsubscribe function
   */
  subscribe(callback: ChangeListener): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /**
   * Notify all listeners of a change.
   */
  private notifyChange(): void {
    this.listeners.forEach((cb) => {
      try {
        cb();
      } catch (error) {
        console.error("[ExtensionManager] Error in change listener:", error);
      }
    });
  }

  // --------------------------------------------------------------------------
  // Utility
  // --------------------------------------------------------------------------

  /**
   * Reset the manager (for testing).
   */
  reset(): void {
    // Deactivate all extensions
    for (const [id, entry] of this.extensions) {
      if (entry.status === "active" && entry.module.deactivate) {
        try {
          entry.module.deactivate();
        } catch (error) {
          console.error(`[ExtensionManager] Error during reset deactivation of '${id}':`, error);
        }
      }
    }
    this.extensions.clear();
    this.initialized = false;
    this.updateCachedArray();
    this.notifyChange();
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const ExtensionManager = new ExtensionManagerImpl();
