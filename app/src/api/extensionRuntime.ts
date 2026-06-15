//! FILENAME: app/src/api/extensionRuntime.ts
// PURPOSE: Publish the host runtime singletons that blob-loaded third-party
//          extensions must share (C2).
// CONTEXT: A runtime-loaded extension is imported from a blob URL and cannot
//          resolve the build-time `@api`/`react` aliases. For React this is a
//          hard correctness problem: a bundle that vendors its OWN React gets a
//          SECOND React instance, which breaks hooks/context the moment its
//          components mount into the host tree. So the host must publish ITS
//          React instance as a shared singleton the extension references.
//
//          DELIBERATELY NOT published as a global: the `@api` facade. Its
//          services are module-scoped singletons, so vendoring can't work — but
//          exposing a live global `@api` would hand every main-thread script the
//          full API and discard the per-extension scoping that the injected
//          `ExtensionContext` (passed to `activate()`) provides. Extensions get
//          the API through that context, which keeps access scoped and aligned
//          with the sandboxing vision. React is a pure UI library, not a
//          capability, so sharing it carries no such authority.

import React from "react";

/** Global name under which the host's React singleton is published. A
 *  third-party extension build aliases `react` to a shim that re-exports this
 *  (see the authoring note in docs/design/vision-gap-review.md, C2). */
export const REACT_GLOBAL = "CalculaReact";

/**
 * Publish the host runtime singletons for runtime-loaded extensions. Currently
 * just the React instance. Idempotent; safe to call once at bootstrap before any
 * third-party extension is loaded.
 */
export function exposeExtensionRuntimeGlobals(): void {
  (globalThis as Record<string, unknown>)[REACT_GLOBAL] = React;
}

/** The published React singleton, or undefined if not yet exposed. */
export function getExtensionReact(): typeof React | undefined {
  return (globalThis as Record<string, unknown>)[REACT_GLOBAL] as typeof React | undefined;
}
