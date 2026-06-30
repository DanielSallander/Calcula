//! FILENAME: app/src/api/extensionManager.ts
// PURPOSE: The @api contract for the extension HOST — the typed interface an
//   extension (e.g. ExtensionsManager) uses to inspect/manage other extensions,
//   plus an IoC slot the Shell fills with its concrete ExtensionManager at boot.
// CONTEXT: The host manager is a Shell concern; @api must not import the Shell.
//   So @api owns the INTERFACE + the value types here, the Shell registers its
//   singleton via registerExtensionManager() in bootstrapShell(), and consumers
//   reach it through getExtensionManager() — mirroring the other @api IoC
//   registries (ui.ts shell-components, extensions.ts ExtensionRegistry).

import type { ExtensionModule } from "./contract";
import type { CapabilityId } from "./scriptHost/capabilityIds";

/** Lifecycle status of a loaded extension. */
export type ExtensionStatus = "pending" | "active" | "error" | "inactive";

/**
 * Trust class of an extension.
 *  - "trusted": built-in / first-party (extensions/manifest.ts). Full host authority.
 *  - "distributed": third-party bundle. Bounded by a declared-capability ceiling
 *    (deny-by-default) and run sandboxed in a worker realm.
 */
export type ExtensionTrust = "trusted" | "distributed";

/** A loaded extension as tracked by the host (surfaced in the manager UI). */
export interface LoadedExtension {
  id: string;
  name: string;
  version: string;
  status: ExtensionStatus;
  module: ExtensionModule;
  error?: Error;
  /** Trust classification (built-in vs third-party). */
  trust: ExtensionTrust;
  /** The R19 declared-capability ceiling. Empty for trusted built-ins (full
   *  authority) and for distributed extensions that declared nothing
   *  (deny-by-default). */
  declaredCapabilities: CapabilityId[];
  /** Deregisters this extension's transparency-panel handle (distributed only). */
  handleCleanup?: () => void;
  /** True for a distributed extension running SANDBOXED in a worker realm.
   *  Its lifecycle is owned by the worker host, not `module`. */
  worker?: boolean;
  /** Ed25519 sidecar-signature trust for distributed extensions:
   *  "unsigned" | "invalid" | "publisherChanged" | "firstUse" | "verified".
   *  Undefined for built-ins (trusted, never signed). */
  trustStatus?: string;
  /** True when the user has disabled this extension (persisted). */
  disabled?: boolean;
  /** The scan-reported file name for a distributed extension. Undefined for built-ins. */
  fileName?: string;
  /** True while a disk-scanned distributed extension is listed but NOT activated
   *  because the user has not yet consented to its current code. */
  needsConsent?: boolean;
}

/**
 * The typed extension-host surface @api exposes. The Shell's concrete
 * ExtensionManager `implements` this; consumers obtain it via getExtensionManager().
 */
export interface ExtensionManagerApi {
  initialize(): Promise<void>;
  isInitialized(): boolean;
  getExtensions(): LoadedExtension[];
  getExtension(id: string): LoadedExtension | undefined;
  getActiveExtensions(): LoadedExtension[];
  getExtensionCount(): number;
  subscribe(callback: () => void): () => void;
  setExtensionEnabled(id: string, enabled: boolean): Promise<void>;
  isDisabled(id: string): boolean;
  grantConsentAndActivate(id: string): Promise<void>;
  isAwaitingConsent(id: string): boolean;
  deactivateExtension(id: string): Promise<void>;
  uninstallExtension(id: string): Promise<void>;
  reset(): void;
}

// ---------------------------------------------------------------------------
// IoC registry — the Shell registers its singleton at boot; @api hands it out.
// ---------------------------------------------------------------------------

let extensionManager: ExtensionManagerApi | undefined;

/** Shell-only: register the concrete ExtensionManager (called in bootstrapShell). */
export function registerExtensionManager(manager: ExtensionManagerApi): void {
  extensionManager = manager;
}

/**
 * Get the host ExtensionManager. Throws if the Shell hasn't registered it yet —
 * call only after bootstrap (from a component/effect/handler, never at module top).
 */
export function getExtensionManager(): ExtensionManagerApi {
  if (!extensionManager) {
    throw new Error(
      "[API] ExtensionManager not registered. The Shell must call registerExtensionManager() in bootstrapShell() before any extension consumes it.",
    );
  }
  return extensionManager;
}
