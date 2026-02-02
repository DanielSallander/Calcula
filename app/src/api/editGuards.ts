//! FILENAME: app/src/api/editGuards.ts
// PURPOSE: API facade for edit guards.
// CONTEXT: Re-exports the Core's edit guard primitives for use by Extensions.
// Extensions must import from here, NOT from core/lib directly.

export {
  type EditGuardResult,
  type EditGuardFn,
  registerEditGuard,
  checkEditGuards,
} from "../core/lib/editGuards";