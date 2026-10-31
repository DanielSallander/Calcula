//! FILENAME: app/src/api/customFunctionRegistryReport.ts
// PURPOSE: Tell the backend which custom functions this page registers, and
//          which Custom Functions library generation is live
//          (`note_custom_function_registry`, app/src-tauri/src/bi/cube.rs).
//
// A module of its own (not formulaUdf.ts) so `customFunctions.ts` can report
// after an install without importing the UDF bridge and its broker.

import { invokeBackend } from "./backend";
import { getAllCustomFunctions } from "./formulaFunctions";

/**
 * Names the Custom Functions library realms registered on this page
 * (`customFunctions.ts` keeps it: added on register, cleared on uninstall).
 * They are LEFT OUT of the report: the backend reads the workbook's libraries
 * itself, at open and before every pass, so the library is the one authority
 * on its own names. Reporting them made the session list carry the PREVIOUS
 * workbook's library names onto a newly opened one -- its `=IFERROR(MYFN(..),0)`
 * kept a sticky refusal where Excel gives 0 -- until the page re-reported
 * (rev11C). Only an add-in's registration (`formulas.registerFunction`), which
 * the backend cannot read, belongs in the session list.
 */
const libraryRegisteredNames = new Set<string>();

/** Note a name a Custom Functions library realm registered (upper-cased). */
export function noteLibraryRegisteredName(name: string): void {
  libraryRegisteredNames.add(name.trim().toUpperCase());
}

/** Forget every library-registered name (the realms were torn down). */
export function clearLibraryRegisteredNames(): void {
  libraryRegisteredNames.clear();
}

/**
 * Report every name the page registers that the backend cannot read itself --
 * every add-in's (`formulas.registerFunction`), never the Custom Functions
 * library's (see `libraryRegisteredNames`) -- and, after a successful install
 * of the library, the library generation now live.
 *
 * WHY. F9 and the save serve no custom function; a call they cannot answer is
 * refused, and the refusal must survive an IFERROR around it -- but only for a
 * name that IS a function here: a typo's #NAME? is Excel's ordinary error,
 * which IFERROR catches. The backend can read the libraries itself, never an
 * add-in's registrations, so without this report
 * `=IFERROR(FXRATE("USD",TODAY()),0)` saved a plausible 0. The generation lets
 * the backend file served answers again once the NEW code is live, never the
 * old realm's answers from the moment between a merge and the re-install.
 *
 * Best-effort: a failed report leaves the backend's previous knowledge in place.
 *
 * Resolves to the backend's CURRENT library generation (undefined when the
 * report failed). The backend bumps a generation only after its library write
 * has landed, so asking BEFORE reading the library tells the page which
 * generation it is about to read -- the one to report once that install has
 * succeeded (`loadAndInstallCustomFunctions`, `savePersistedLibrary`).
 */
export async function reportCustomFunctionRegistry(installedLibraryGeneration?: number): Promise<number | undefined> {
  const names = getAllCustomFunctions()
    .map((d) => d.name)
    .filter((name) => !libraryRegisteredNames.has(name.trim().toUpperCase()));
  try {
    const current = await invokeBackend<number>("note_custom_function_registry", {
      names,
      installedGeneration: installedLibraryGeneration ?? null,
    });
    return typeof current === "number" ? current : undefined;
  } catch (e) {
    console.warn("[udf] note_custom_function_registry failed", e);
    return undefined;
  }
}

/** The larger of two optional generations (undefined when both are). */
export function newerLibraryGeneration(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}
