//! FILENAME: app/extensions/AIChat/lib/providerSelection.ts
// PURPOSE: Which provider + model the user picked, and where that choice lives.
// CONTEXT: It lives in EXTENSION SETTINGS (localStorage, `ext.calcula.ai-chat.*`),
//          not in the backend and never in the workbook.
//
//          THE SELECTION IS AN APPLICATION PREFERENCE, NOT DOCUMENT STATE. It
//          belongs with `locale` and `calculation_mode` in the population
//          open-items.md §2.2 records as permanently exempt from `Persisted<T>`:
//          it is the USER's choice, not the workbook's. A model id written into a
//          `.cala` would mean opening a colleague's workbook silently repoints
//          your AI at a model you have no key for — or, worse, at a cloud vendor
//          when you had deliberately chosen a local one.
//
//          The backend is therefore STATELESS about the choice: every
//          `ai_chat_complete` names its provider and model. No AppState field, no
//          reset-on-open question, no `Persisted<T>` decision to get wrong.
//          Design: docs/design/local-model-script-authoring.md §7a, §11.1.

import { getSetting, setSetting } from "@api";

const EXT_ID = "calcula.ai-chat";

const KEY_PROVIDER = "providerId";
const KEY_MODEL = "model";
const KEY_BASE_URL = "baseUrl";

export interface ProviderSelection {
  providerId: string;
  model: string;
  /** Only meaningful for `custom-openai`, or a runtime on a non-default port. */
  baseUrl: string;
}

export function readSelection(): ProviderSelection {
  return {
    providerId: getSetting(EXT_ID, KEY_PROVIDER, ""),
    model: getSetting(EXT_ID, KEY_MODEL, ""),
    baseUrl: getSetting(EXT_ID, KEY_BASE_URL, ""),
  };
}

export function writeSelection(next: Partial<ProviderSelection>): void {
  if (next.providerId !== undefined) setSetting(EXT_ID, KEY_PROVIDER, next.providerId);
  if (next.model !== undefined) setSetting(EXT_ID, KEY_MODEL, next.model);
  if (next.baseUrl !== undefined) setSetting(EXT_ID, KEY_BASE_URL, next.baseUrl);
}

/** A selection is usable once it names both a provider and a model. */
export function isComplete(sel: ProviderSelection): boolean {
  return sel.providerId.trim() !== "" && sel.model.trim() !== "";
}
