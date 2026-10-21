//! FILENAME: app/src-tauri/src/locale_commands.rs
//! PURPOSE: Tauri commands for locale/regional settings management.
//! CONTEXT: Thin wrappers over `app_locale`, which is the one authority (the
//! startup value, the one writer of `state.locale` + the evaluator mirror, and
//! the persisted override file). These commands mutate NO document state: the
//! locale is an application preference, so no `DocumentEffect` is constructed
//! and the workbook never becomes dirty by a locale switch.

use std::path::Path;

use crate::api_types::{LocaleSettingsData, SupportedLocaleEntry};
use crate::app_locale::{self, AppSettingsFile, SYSTEM_LOCALE_ID};
use crate::AppState;
use engine::LocaleSettings;
use tauri::{AppHandle, Emitter, State, Window};

/// Get the current locale settings, with the persisted override id (`None` =
/// following the OS) and the calendar names.
#[tauri::command]
pub fn get_locale_settings(state: State<AppState>) -> LocaleSettingsData {
    let locale = state.locale.lock().unwrap().clone();
    LocaleSettingsData::from(&locale).with_override(app_locale::current_override())
}

/// Set the locale by id and persist the choice. Main window only.
///
/// `"system"` RE-READS THE OS and REMOVES the persisted override, which is what
/// makes "System default" in Settings a live re-read. Every explicit id --
/// including the one the app is already on -- is persisted as an override. An
/// unknown id is an error (never `from_locale_id`'s silent en-US).
///
/// Order: validate, build, write the file, install, announce. A failed write
/// returns `Err` and installs nothing, so the running app and the disk never
/// disagree. `locale:changed` then updates every window.
#[tauri::command]
pub fn set_locale(
    state: State<AppState>,
    app: AppHandle,
    window: Window,
    locale_id: String,
) -> Result<LocaleSettingsData, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let data = set_locale_core(&state, &app_locale::settings_dir(), &locale_id)?;
    if let Err(e) = app.emit(app_locale::LOCALE_CHANGED_EVENT, &data) {
        crate::log_warn!("SYS", "Could not announce {}: {}", app_locale::LOCALE_CHANGED_EVENT, e);
    }
    Ok(data)
}

/// The body of [`set_locale`] without the window guard and the event, so tests
/// can drive it with a plain `AppState` and a throwaway settings directory.
pub(crate) fn set_locale_core(
    state: &AppState,
    settings_dir: &Path,
    locale_id: &str,
) -> Result<LocaleSettingsData, String> {
    // 1. Validate and build.
    let (locale, override_id) = if locale_id == SYSTEM_LOCALE_ID {
        (crate::os_locale::system_locale_settings(), None)
    } else if app_locale::is_supported_locale_id(locale_id) {
        // An EXPLICIT override is answered by the table, byte for byte. The OS
        // read describes this machine; a user who picked de-DE is asking for
        // Germany, not for Germany-as-configured-here.
        (LocaleSettings::from_locale_id(locale_id), Some(locale_id.to_string()))
    } else {
        return Err(format!("Unknown locale id '{}'", locale_id));
    };

    // 2. Persist. Read-modify-write so any other preference in the file
    //    survives; a failure stops here with nothing installed.
    let mut settings: AppSettingsFile = app_locale::read_settings(settings_dir);
    settings.locale_override = override_id.clone();
    app_locale::write_settings(settings_dir, &settings)
        .map_err(|e| format!("Could not save the locale setting: {}", e))?;

    // 3. Install (state.locale + the evaluator mirror).
    let data = LocaleSettingsData::from(&locale).with_override(override_id.clone());
    app_locale::install(state, locale, override_id);
    Ok(data)
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
