//! FILENAME: app/extensions/ExtensionsManager/backendChannel.ts
// PURPOSE: The capability-gated backend door for the Extensions Manager.
// CONTEXT: Extensions must never import the raw `invokeBackend` passthrough
//          (A3, enforced by npm run lint:boundaries). The sanctioned route for
//          code that runs OUTSIDE activate()'s `ctx` — React components, in this
//          case — is a channel bound once in activate() to `ctx.invokeBackend`,
//          so every call flows through the same trust gate.
//
//          The one command it carries, `install_extension`, is a privileged
//          extension-management door: it copies executable code into the
//          extensions directory and can pin a publisher key. Routing it through
//          the channel (rather than a bare invoke) is what keeps that gate on
//          the call path.

import { createBackendChannel } from "@api";

export const extensionsBackend = createBackendChannel("extensions-manager");

/** A contribution group declared in a sidecar manifest, as Rust reports it. */
export interface DeclaredContribution {
  /** "formulas" | "commands" | "menuItems" | "ribbonButtons" | … */
  kind: string;
  ids: string[];
}

/**
 * Mirror of `InstallExtensionReport` (app/src-tauri/src/extension_install.rs).
 * Field names are camelCase on both sides via `#[serde(rename_all)]`.
 */
export interface InstallExtensionReport {
  id: string;
  name: string;
  version: string;
  bundleFileName: string;
  publisherKey: string;
  pinnedPublisherKey: string;
  /** "unsigned" | "invalid" | "firstUse" | "verified" | "publisherChanged" */
  trustStatus: string;
  /** "notDeclared" | "match" | "mismatch" | "bundleUnreadable" */
  codeHashStatus: string;
  codeCoveredBySignature: boolean;
  declaredCapabilities: string[];
  capabilitiesHonored: boolean;
  contributions: DeclaredContribution[];
  workerSupport: boolean;
  files: string[];
  alreadyInstalled: boolean;
  installedVersion: string;
  installed: boolean;
  pinned: boolean;
  warnings: string[];
}

/** Inspect an add-in WITHOUT copying or trusting anything (Rust guarantees the
 *  preview pass never writes and never pins). */
export function previewAddIn(sourcePath: string): Promise<InstallExtensionReport> {
  return extensionsBackend.invoke<InstallExtensionReport>("install_extension", {
    request: { sourcePath, confirm: false, acceptPublisherChange: false },
  });
}

/** Install an add-in. `acceptPublisherChange` must be set ONLY after the user
 *  answered the separate publisher-change question. */
export function installAddIn(
  sourcePath: string,
  acceptPublisherChange: boolean,
): Promise<InstallExtensionReport> {
  return extensionsBackend.invoke<InstallExtensionReport>("install_extension", {
    request: { sourcePath, confirm: true, acceptPublisherChange },
  });
}
