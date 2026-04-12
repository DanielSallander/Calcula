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

/// Set the locale by ID. Returns the new locale settings.
#[tauri::command]
pub fn set_locale(state: State<AppState>, locale_id: String) -> LocaleSettingsData {
    let new_locale = LocaleSettings::from_locale_id(&locale_id);
    let data = LocaleSettingsData::from(&new_locale);
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
