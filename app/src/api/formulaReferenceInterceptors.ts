//! FILENAME: app/src/api/formulaReferenceInterceptors.ts
// PURPOSE: API facade for formula reference interceptors.
// CONTEXT: Re-exports the Core's formula reference interceptor primitives for use by Extensions.
// Extensions must import from here, NOT from core/lib directly.

export {
  type FormulaReferenceOverride,
  type FormulaReferenceInterceptorFn,
  registerFormulaReferenceInterceptor,
  checkFormulaReferenceInterceptors,
} from "../core/lib/formulaReferenceInterceptors";
