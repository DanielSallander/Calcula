//! FILENAME: app/src-tauri/src/theme_commands.rs
//! PURPOSE: Tauri commands for document theme management.

use crate::api_types::{
    SetThemeResult, StyleData, StyleEntry, ThemeColorInfo, ThemeDefinitionData,
};
use crate::AppState;
use engine::{ThemeColorSlot, ThemeDefinition, Tint};
use tauri::State;

/// Get the active document theme.
#[tauri::command]
pub fn get_document_theme(state: State<AppState>) -> ThemeDefinitionData {
    let theme = state.theme.lock().unwrap();
    ThemeDefinitionData::from_theme(&theme)
}

/// Set the document theme. Returns refreshed styles for cache invalidation.
#[tauri::command]
pub fn set_document_theme(
    state: State<AppState>,
    theme: ThemeDefinitionData,
) -> Result<SetThemeResult, String> {
    let new_theme = theme.to_theme();

    // Update the theme
    *state.theme.lock().unwrap() = new_theme;

    // Re-resolve all styles against the new theme
    let styles = state.style_registry.lock().unwrap();
    let theme = state.theme.lock().unwrap();
    let updated_styles: Vec<StyleEntry> = styles
        .all_styles()
        .iter()
        .enumerate()
        .map(|(index, style)| StyleEntry {
            index,
            style: StyleData::from_cell_style(style, &theme),
        })
        .collect();

    Ok(SetThemeResult {
        styles: updated_styles,
    })
}

/// List all built-in themes.
#[tauri::command]
pub fn list_builtin_themes() -> Vec<ThemeDefinitionData> {
    ThemeDefinition::all_builtin()
        .iter()
        .map(ThemeDefinitionData::from_theme)
        .collect()
}

/// Get the theme color palette for the color picker (60 entries).
/// Returns 10 base colors + 5 tint rows = 60 total entries.
#[tauri::command]
pub fn get_theme_color_palette(state: State<AppState>) -> Vec<ThemeColorInfo> {
    let theme = state.theme.lock().unwrap();
    let mut palette = Vec::with_capacity(60);

    // Row 1: Base colors (10 picker slots)
    for slot in ThemeColorSlot::PICKER {
        let base = theme.colors.get(slot);
        palette.push(ThemeColorInfo {
            slot: slot.key().to_string(),
            tint: 0,
            resolved_color: base.to_css(),
            label: slot.label().to_string(),
        });
    }

    // Rows 2-6: Tint variations
    let tint_labels = [
        (Tint::LIGHTER_80, "Lighter 80%"),
        (Tint::LIGHTER_60, "Lighter 60%"),
        (Tint::LIGHTER_40, "Lighter 40%"),
        (Tint::DARKER_25, "Darker 25%"),
        (Tint::DARKER_50, "Darker 50%"),
    ];

    for (tint, tint_label) in &tint_labels {
        for slot in ThemeColorSlot::PICKER {
            let tc = engine::ThemeColor::Theme { slot, tint: *tint };
            let resolved = theme.resolve_color(&tc);
            palette.push(ThemeColorInfo {
                slot: slot.key().to_string(),
                tint: tint.0,
                resolved_color: resolved.to_css(),
                label: format!("{}, {}", slot.label(), tint_label),
            });
        }
    }

    palette
}
