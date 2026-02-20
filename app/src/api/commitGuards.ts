//! FILENAME: app/src/api/commitGuards.ts
// PURPOSE: Public commit guard API for extensions.
// CONTEXT: Extensions should import commit guards from here instead of core/lib/commitGuards.

export {
  registerCommitGuard,
  checkCommitGuards,
} from "../core/lib/commitGuards";

export type {
  CommitGuardResult,
  CommitGuardFn,
} from "../core/lib/commitGuards";
