//! FILENAME: app/extensions/Charts/lib/__tests__/appLocaleTestKit.ts
// PURPOSE: Install a real app locale in a Charts unit test (P2 S8).
// CONTEXT: The locales are read from THE shared Rust <-> TS corpus
//          (core/engine/tests/fixtures/locale_text_corpus.json, whose own Rust
//          test pins them to `LocaleSettings::from_locale_id`), so a Charts test
//          under "de-DE" sees exactly the separators the backend would send --
//          never a hand-typed copy.
//
//          The locale is installed the way the app installs it: `setLocale`
//          from `@api/locale`, answered by a mocked Tauri IPC that replies to
//          `set_locale` with the corpus settings. So the kit goes through the
//          extension facade only (an extension test may not reach into
//          src/core), and what a test formats in is what `@api/locale` would
//          hold after a real switch. Not a test file (no `.test.`), so vitest
//          only runs it through the suites that import it.

import fs from "fs";
import path from "path";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { setLocale, INVARIANT_LOCALE } from "@api/locale";
import type { LocaleSettings } from "@api/locale";

const CORPUS_PATH = path.resolve(__dirname, "../../../../../core/engine/tests/fixtures/locale_text_corpus.json");

let cache: Record<string, LocaleSettings> | null = null;

function corpusLocales(): Record<string, LocaleSettings> {
  if (!cache) {
    const raw = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8")) as { locales: Record<string, LocaleSettings> };
    cache = raw.locales;
  }
  return cache;
}

/** The corpus locale settings for `id` ("en-US", "en-GB", "sv-SE", "de-DE", "de-CH", "fr-FR"). */
export function corpusLocale(id: string): LocaleSettings {
  const l = corpusLocales()[id];
  if (!l) throw new Error(`the locale corpus has no ${id}`);
  return l;
}

async function install(settings: LocaleSettings): Promise<LocaleSettings> {
  mockIPC((cmd) => {
    if (cmd === "set_locale") return settings;
    throw new Error(`appLocaleTestKit: unexpected IPC ${cmd}`);
  });
  try {
    return await setLocale(settings.localeId);
  } finally {
    clearMocks();
  }
}

/** Make `id` the active app locale of this test (what `@api/locale` formats in). */
export function useAppLocale(id: string): Promise<LocaleSettings> {
  return install(corpusLocale(id));
}

/** Back to the invariant locale every test starts from. */
export async function useInvariantLocale(): Promise<void> {
  await install({ ...INVARIANT_LOCALE });
}
