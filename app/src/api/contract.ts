//! FILENAME: app/src/api/contract.ts
// PURPOSE: Defines the ExtensionModule interface and ExtensionContext.
// CONTEXT: Every extension must default-export an object satisfying ExtensionModule.
//          The ExtensionContext is the DI container passed to activate().

import type { ICommandRegistry } from "./commands";

// ============================================================================
// Extension Context (Dependency Injection Container)
// ============================================================================

/**
 * The "API" object we pass to extensions.
 * This acts as a Dependency Injection container.
 */
export interface ExtensionContext {
  /** Command registry for registering and executing commands */
  commands: ICommandRegistry;
  // Future: Add other API surfaces here
  // ribbon: IRibbonRegistry;
  // menus: IMenuRegistry;
  // dialogs: IDialogRegistry;
  // overlays: IOverlayRegistry;
}

// ============================================================================
// Extension Manifest (Metadata)
// ============================================================================

export interface ExtensionManifest {
  /** Unique identifier for the extension */
  id: string;
  /** Human-readable name */
  name: string;
  /** Semantic version string */
  version: string;
  /** Events that trigger activation (future use) */
  activationEvents?: string[];
  /** Optional description */
  description?: string;
}

// ============================================================================
// Extension Module Interface
// ============================================================================

/**
 * Every extension file must default-export an object satisfying this interface.
 */
export interface ExtensionModule {
  /** Extension metadata */
  manifest: ExtensionManifest;
  /** Called when the extension is activated */
  activate: (context: ExtensionContext) => void | Promise<void>;
  /** Called when the extension is deactivated (optional) */
  deactivate?: () => void;
}