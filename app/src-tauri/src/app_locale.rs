//! FILENAME: app/src-tauri/src/app_locale.rs
//! PURPOSE: THE one authority for the application locale (the regional format
//! every display and every input parse uses). It decides the startup value
//! (a persisted override, else the OS regional format), it is the ONE writer of
//! `AppState::locale` plus the process mirror the evaluator reads, and it owns
//! the on-disk override file `app-settings.json` in the user profile.
//! CONTEXT: P2 "app locale everywhere" (owner rule: every display and every
//! input parse uses the APP locale). Before this module the locale lived in two
//! places that could disagree: `state.locale` in the backend and a
//! `localStorage` override in each WebView, which the backend never saw, so a
//! user who picked de-DE got German separators in the Settings page and the
//! OS locale in every number the backend formatted -- and lost the choice on
//! restart in any window but the one that made it.
//!
//! ## Who reads what
//!
//! * Code that holds an `AppState` reads `state.locale` (a LEAF lock: take,
//!   clone, drop) -- never the mirror below. Pivot and slicer commands clone it
//!   at the top of the command and pass the clone down.
//! * Code that has NO `AppState` -- in practice the evaluator, reached through
//!   `eval_budget::apply` from the ~19 `evaluate_formula*` wrappers -- reads
//!   [`display_locale_opt`]. Unset (before startup, or in a test that did not
//!   ask) every `Evaluator` keeps the engine's invariant default: a forgotten
//!   install costs the separators, never the answer.
//!
//! ## Tests never share a global locale
//!
//! [`install`] writes `state.locale` always and the process mirror only in a
//! non-test build. In a test build [`display_locale_opt`] reads a THREAD-LOCAL
//! slot that only [`with_test_display_locale`] sets (the
//! `profile_dir::with_test_profile` pattern). So the hundreds of
//! `create_app_state()` test sites install nothing process-wide, the evaluator
//! stays on the invariant default in every test unless that test asks, and
//! parallel tests cannot race on it. (Before this, `create_app_state` wrote the
//! machine's OS locale into a process-wide static, so an evaluator test's
//! `TEXT()` output depended on the Windows region of whoever ran it.)
//!
//! ## Lock order
//!
//! `state.locale` and the mirror are LEAF locks. [`install`] takes them one
//! after the other, never nested, and the file write happens before either is
//! taken. Nothing else may be acquired while either is held.

use std::io;
use std::path::{Path, PathBuf};

use engine::LocaleSettings;
use serde::{Deserialize, Serialize};

use crate::AppState;

/// The Tauri event announcing a locale switch. Payload: `LocaleSettingsData`.
/// Mirrored by `LOCALE_CHANGED_EVENT` in `app/src/api/locale.ts` (pinned by
/// `crossLayerConstantDrift.test.ts`). Every window listens; one switch
/// produces exactly one event.
pub const LOCALE_CHANGED_EVENT: &str = "locale:changed";

/// The application-preferences file in the user profile
/// (`%LOCALAPPDATA%\Calcula\app-settings.json`). It is an APPLICATION
/// preference, never part of a `.cala` document.
pub const APP_SETTINGS_FILE: &str = "app-settings.json";

/// The locale id that means "follow Windows" rather than naming a locale.
/// Choosing it re-reads the OS and REMOVES the persisted override.
pub const SYSTEM_LOCALE_ID: &str = "system";

/// The on-disk shape of `app-settings.json`. Every field defaults, so a file
/// written by a later build with more fields still reads.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettingsFile {
    /// The locale the user explicitly chose (an id from
    /// `LocaleSettings::supported_locales()`), or `None` = follow the OS.
    pub locale_override: Option<String>,
}

/// True when `id` is one of the locales the engine actually has a table for.
///
/// `LocaleSettings::from_locale_id` silently answers en-US for an id it does
/// not know, so a value from the FILE (which anyone can edit) must pass this
/// before it is trusted -- otherwise "xx-XX" in the file would quietly turn a
/// Swedish user's app American.
pub fn is_supported_locale_id(id: &str) -> bool {
    LocaleSettings::supported_locales().iter().any(|(known, _)| known == id)
}

/// The profile directory the settings file lives in. In a test build this is
/// the thread's `with_test_profile` directory or a per-process throwaway, so a
/// test can never touch the real profile.
pub fn settings_dir() -> PathBuf {
    crate::profile_dir::resolve()
}

/// Startup value: a VALID override from the settings file, else the OS
/// regional format. Returns the locale and the override id that produced it
/// (`None` when following the OS).
pub fn startup_locale() -> (LocaleSettings, Option<String>) {
    startup_locale_in(&settings_dir())
}

fn startup_locale_in(dir: &Path) -> (LocaleSettings, Option<String>) {
    let settings = read_settings(dir);
    if let Some(id) = settings.locale_override {
        if is_supported_locale_id(&id) {
            crate::log_info!("SYS", "App locale override from {}: {}", APP_SETTINGS_FILE, id);
            return (LocaleSettings::from_locale_id(&id), Some(id));
        }
        crate::log_warn!(
            "SYS",
            "Ignoring unknown locale override '{}' in {} -- following the OS regional format",
            id,
            APP_SETTINGS_FILE
        );
    }
    // THE REGIONAL FORMAT, NOT THE DISPLAY LANGUAGE -- see os_locale.rs
    // (open-items 1.3).
    let locale = crate::os_locale::system_locale_settings();
    crate::log_info!("SYS", "Detected system regional format: {}", locale.locale_id);
    (locale, None)
}

/// The ONE writer: `state.locale` plus the process mirror the evaluator reads.
///
/// The mirror is written only in a non-test build (see the module header).
/// The two locks are taken sequentially, never nested.
pub fn install(state: &AppState, locale: LocaleSettings, override_id: Option<String>) {
    {
        let mut slot = state.locale.lock().unwrap_or_else(|p| p.into_inner());
        *slot = locale.clone();
    }
    #[cfg(not(test))]
    {
        let mut mirror = APP_LOCALE.write().unwrap_or_else(|p| p.into_inner());
        *mirror = Some((locale, override_id));
    }
    #[cfg(test)]
    {
        // Deliberately nothing process-wide: a test that wants the evaluator
        // on a locale asks with `with_test_display_locale`.
        let _ = (locale, override_id);
    }
}

/// The process mirror: `(locale, override id)`, `None` before [`install`].
#[cfg(not(test))]
static APP_LOCALE: std::sync::RwLock<Option<(LocaleSettings, Option<String>)>> =
    std::sync::RwLock::new(None);

#[cfg(test)]
thread_local! {
    static TEST_DISPLAY_LOCALE: std::cell::RefCell<Option<(LocaleSettings, Option<String>)>> =
        const { std::cell::RefCell::new(None) };
}

fn mirror() -> Option<(LocaleSettings, Option<String>)> {
    #[cfg(not(test))]
    {
        APP_LOCALE.read().ok().and_then(|slot| slot.clone())
    }
    #[cfg(test)]
    {
        TEST_DISPLAY_LOCALE.with(|slot| slot.borrow().clone())
    }
}

/// The app locale for code with NO `AppState` (the evaluator via
/// `eval_budget::apply`). `None` before [`install`]; in a test build, `None`
/// unless the current thread is inside [`with_test_display_locale`].
pub fn display_locale_opt() -> Option<LocaleSettings> {
    mirror().map(|(locale, _)| locale)
}

/// [`display_locale_opt`], or the engine's invariant locale when unset.
pub fn display_locale() -> LocaleSettings {
    display_locale_opt().unwrap_or_else(LocaleSettings::invariant)
}

/// The persisted override id the running app was installed with (`None` =
/// following the OS). `get_locale_settings` reports it as `overrideId`.
pub fn current_override() -> Option<String> {
    mirror().and_then(|(_, override_id)| override_id)
}

/// Run `f` with [`display_locale_opt`] answering `locale` ON THIS THREAD.
/// Restored on the way out, panics included.
#[cfg(test)]
pub fn with_test_display_locale<R>(locale: LocaleSettings, f: impl FnOnce() -> R) -> R {
    struct Restore(Option<(LocaleSettings, Option<String>)>);
    impl Drop for Restore {
        fn drop(&mut self) {
            let previous = self.0.take();
            TEST_DISPLAY_LOCALE.with(|slot| *slot.borrow_mut() = previous);
        }
    }
    let previous = TEST_DISPLAY_LOCALE.with(|slot| slot.borrow_mut().replace((locale, None)));
    let _restore = Restore(previous);
    f()
}

/// Read `app-settings.json` from `dir`. A missing file is the default
/// silently; an unreadable or invalid one is the default with a warning, so a
/// corrupt file can never stop the app from starting.
pub(crate) fn read_settings(dir: &Path) -> AppSettingsFile {
    let path = dir.join(APP_SETTINGS_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return AppSettingsFile::default(),
        Err(e) => {
            crate::log_warn!("SYS", "Cannot read {}: {} -- using defaults", path.display(), e);
            return AppSettingsFile::default();
        }
    };
    match serde_json::from_str::<AppSettingsFile>(&text) {
        Ok(settings) => settings,
        Err(e) => {
            crate::log_warn!("SYS", "Ignoring invalid {}: {} -- using defaults", path.display(), e);
            AppSettingsFile::default()
        }
    }
}

/// Write `app-settings.json` into `dir` atomically: a sibling temp file, then a
/// rename over the target, so a crash mid-write never leaves a torn file. The
/// temp file is removed if the rename fails.
pub(crate) fn write_settings(dir: &Path, settings: &AppSettingsFile) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let target = dir.join(APP_SETTINGS_FILE);
    let tmp = dir.join(format!("{}.{}.tmp", APP_SETTINGS_FILE, std::process::id()));
    std::fs::write(&tmp, json.as_bytes())?;
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}
