// FILENAME: app/extensions/ModelEditor/cli/cliLanguage.ts
// PURPOSE: The MODEL domain's binding of the shared CLI Monaco language
//          (_shared/cli/language.ts): registers the "calcula-model-cli"
//          language from the SAME vocabulary the parser uses, and feeds the
//          shared completion provider a model context — live object names
//          from the current ModelOverview (modelCompletion.ts) and option
//          keys derived per verb+kind from the audited schema
//          (modelOptions.ts), so completion can never drift from what the
//          executors accept.

import type { ModelOverview } from "@api";
import {
  registerCliLanguage as registerSharedCliLanguage,
  setCliCompletionContext,
} from "../../_shared/cli/language";
import { MODEL_CLI_VOCABULARY, normalizeKind } from "./parse";
import { modelNameSuggestions } from "./modelCompletion";
import { modelOptionSpecsFor } from "./modelOptions";

export const CLI_LANGUAGE_ID = "calcula-model-cli";

/** Feed the completion provider the live model (call on every overview install). */
export function setCliLanguageContext(overview: ModelOverview | null): void {
  setCliCompletionContext(CLI_LANGUAGE_ID, {
    normalizeKind,
    nameSuggestions: (kind) => {
      const k = normalizeKind(kind);
      return k ? modelNameSuggestions(overview, k) : [];
    },
    optionKeys: (kind, verbWord) => {
      const k = normalizeKind(kind);
      if (!k) return [];
      return modelOptionSpecsFor(verbWord, k).map((s) => ({ key: s.key, help: s.help }));
    },
  });
}

/** Register the CLI language + providers. Safe to call repeatedly. */
export function registerCliLanguage(): void {
  registerSharedCliLanguage(CLI_LANGUAGE_ID, MODEL_CLI_VOCABULARY);
}
