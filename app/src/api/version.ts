//! FILENAME: app/src/api/version.ts
// PURPOSE: API version constant for extension compatibility checking.
// CONTEXT: Extensions declare which API version they target via manifest.apiVersion.
//          The ExtensionManager checks compatibility before activation.

/**
 * Current API version.
 * Uses semantic versioning (major.minor.patch):
 * - Major: Breaking changes to extension APIs
 * - Minor: New APIs added (backward compatible)
 * - Patch: Bug fixes to existing APIs
 */
export const API_VERSION = "1.1.0";
