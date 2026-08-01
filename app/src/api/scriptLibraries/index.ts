//! FILENAME: app/src/api/scriptLibraries/index.ts
// PURPOSE: Public surface of the script package manager (@api/scriptLibraries).
// CONTEXT: Extensions and host code import from HERE, never from the submodules,
//          so the internal split (pragma parser / ceiling / lockfile / registry /
//          linker / install) can move without breaking a consumer.
//          Design: docs/design/script-package-manager.md.

export type {
  LibraryRequest,
  ResolvedLibrary,
  ResolvedLibraryModule,
  ModulePragmas,
  LibraryUseDeclaration,
  LibraryClosure,
  LibraryClosureNode,
  LockedLibrary,
  LockedModule,
  LibraryLockfile,
  LinkedImport,
  LinkResult,
  LibraryUpdateStatus,
} from "./types";
export { LibraryLinkError } from "./types";

export { parseUses, parseExports, parseModulePragmas } from "./usesPragma";
export type { ParsedUses } from "./usesPragma";

export {
  intersectCeiling,
  chainCeiling,
  intersectOrigins,
  minTier,
} from "./ceiling";
export type { ConsumerCeiling, EffectiveCeiling } from "./ceiling";

export { consentKeyFor, packageFromConsentKey } from "./consentKey";

export {
  loadLockfile,
  findLocked,
  readLockedSource,
  commitLockedLibraries,
  removeLockedLibrary,
  blobPath,
} from "./lockfile";

export { searchLibraries, resolveClosure, LIBRARY_PACKAGE_KIND } from "./registry";
export type { RegistryPackageInfo } from "./registry";

export {
  linkScript,
  listLibraryRealms,
  resetScriptLibraryRealms,
  getGeneratedPrelude,
  generatePrelude,
  generateLibraryRealmSource,
  IMPORTS_BINDING,
} from "./linker";
export type { LinkRequest } from "./linker";

export { generateImportsTypings } from "./typings";

export {
  planInstall,
  applyInstall,
  checkUpdates,
  uninstallLibrary,
  listInstalledLibraries,
} from "./install";
export type { InstallPlan, InstallPlanNode } from "./install";
