/**
 * The app-locale BASELINE of a journey run (P2 S11) -- recorded read-only.
 *
 * WHY. Since P2 the app locale is owned by the Rust backend: an explicit
 * `set_locale` (any id but "system") persists `{"localeOverride": "<id>"}` to
 * %LOCALAPPDATA%\Calcula\app-settings.json, and the NEXT launch starts in that
 * locale. A spec that switches the locale and fails to put it back therefore
 * leaves the owner's own profile pinned to, say, de-DE -- every later run and
 * every later working session formats numbers differently, with nothing on
 * screen saying why.
 *
 * WHAT THE HARNESS DOES. It never edits the profile. `global-setup` reads the
 * file READ-ONLY (absent = no override) and writes what it found to
 * `e2e/results/locale-baseline.json`; `journeys/zz-persisted-residue.spec.ts`
 * (the last spec) asserts the live `get_locale_settings().overrideId` equals
 * that baseline, naming the value when it does not. Each spec that switches the
 * locale restores its BOOT override (`boot.overrideId ?? "system"`) in a
 * `finally`. Manual mode (`E2E_MANUAL=1`) is safe because nothing here writes
 * outside the run directory.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Where the run records the baseline (beside the run's other markers). */
export const LOCALE_BASELINE_FILE = path.join(HERE, "results", "locale-baseline.json");

/** The backend's settings file (`app_locale::APP_SETTINGS_FILE` under `profile_dir::resolve()`). */
export function appSettingsPath(): string {
  const local = process.env.LOCALAPPDATA ?? ".";
  return path.join(local, "Calcula", "app-settings.json");
}

export interface LocaleBaseline {
  /** The override the profile held when the run began; null = none (follow the OS). */
  localeOverride: string | null;
  /** The file it came from, for the message. */
  source: string;
  /** Present when the file existed but could not be read as the backend's shape. */
  note?: string;
}

/**
 * Read the profile's override WITHOUT touching it. An absent file, or a
 * `localeOverride` that is null or not a string, is "no override" -- the same
 * reading the backend makes (it ignores an unreadable value with a warning).
 */
export function readAppSettingsOverride(file: string = appSettingsPath()): LocaleBaseline {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { localeOverride: null, source: file };
  }
  try {
    const parsed = JSON.parse(raw) as { localeOverride?: unknown };
    const v = parsed?.localeOverride;
    return { localeOverride: typeof v === "string" ? v : null, source: file };
  } catch (e) {
    return { localeOverride: null, source: file, note: `unparseable (${String(e)}); the backend ignores it too` };
  }
}

/** global-setup: record the baseline in the run directory and return it for the banner. */
export function recordLocaleBaseline(): LocaleBaseline {
  const baseline = readAppSettingsOverride();
  try {
    fs.mkdirSync(path.dirname(LOCALE_BASELINE_FILE), { recursive: true });
    fs.writeFileSync(LOCALE_BASELINE_FILE, JSON.stringify(baseline, null, 2) + "\n");
  } catch (e) {
    console.warn(`[e2e] could not record the locale baseline at ${LOCALE_BASELINE_FILE}: ${String(e)}`);
  }
  return baseline;
}

/** The residue spec: the baseline this run recorded, or null when none was written. */
export function readLocaleBaseline(): LocaleBaseline | null {
  try {
    return JSON.parse(fs.readFileSync(LOCALE_BASELINE_FILE, "utf8")) as LocaleBaseline;
  } catch {
    return null;
  }
}
