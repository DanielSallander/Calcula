//! FILENAME: app/src-tauri/src/locale_commands.rs
//! PURPOSE: Tauri commands for locale/regional settings management.

use crate::api_types::{LocaleSettingsData, SupportedLocaleEntry};
use crate::AppState;
use engine::LocaleSettings;
use tauri::State;

/// Get the current locale settings.
#[tauri::command]
pub fn get_locale_settings(state: State<AppState>) -> LocaleSettingsData {
    let locale = state.locale.lock().unwrap();
    LocaleSettingsData::from(&*locale)
}

/// The locale id that means "ask Windows", rather than naming a locale.
///
/// It is the same string the frontend already stored as the ABSENCE of an
/// override (`app/src/api/locale.ts`), and before open-items 1.3 sending it
/// here returned **en-US** in silence: `from_locale_id("system")` matched no
/// arm, and `"system".split('-').next()` is `"system"` again, so even the
/// language-fallback recursion could not fire and it landed on `invariant()`.
pub const SYSTEM_LOCALE_ID: &str = "system";

/// Set the locale by ID. Returns the new locale settings.
///
/// `"system"` RE-READS THE OS rather than naming a locale, which is what makes
/// "System default" in Settings a live re-read: before this, choosing it only
/// re-reported whatever had been captured at launch, so a user who changed
/// Windows Region and came back saw a stale value with no way to refresh short
/// of restarting the app.
#[tauri::command]
pub fn set_locale(state: State<AppState>, locale_id: String) -> LocaleSettingsData {
    let new_locale = if locale_id == SYSTEM_LOCALE_ID {
        crate::os_locale::system_locale_settings()
    } else {
        // An EXPLICIT override is answered by the table, byte for byte. The OS
        // read describes this machine; a user who picked de-DE is asking for
        // Germany, not for Germany-as-configured-here.
        LocaleSettings::from_locale_id(&locale_id)
    };
    let data = LocaleSettingsData::from(&new_locale);
    // Publish to the evaluator's mirror BEFORE dropping the value into state,
    // so the two writes stay adjacent and neither can be added without the
    // other catching the eye. `TEXT(value, format)` reads this.
    crate::eval_budget::set_formula_locale(new_locale.clone());
    *state.locale.lock().unwrap() = new_locale;
    data
}

/// List all supported locales for the settings UI dropdown.
#[tauri::command]
pub fn get_supported_locales() -> Vec<SupportedLocaleEntry> {
    LocaleSettings::supported_locales()
        .into_iter()
        .map(|(id, name)| SupportedLocaleEntry {
            locale_id: id,
            display_name: name,
        })
        .collect()
}
