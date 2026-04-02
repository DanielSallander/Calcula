//! FILENAME: core/engine/src/theme.rs
//! PURPOSE: Document Theme data model (Excel-compatible).
//! CONTEXT: Defines the 12-slot color palette, heading/body font pairs,
//! and the ThemeColor enum that can represent either absolute RGBA or a
//! theme reference (slot + tint). Used by CellStyle for theme-aware formatting.

use crate::style::Color;
use serde::{Deserialize, Serialize};

// ============================================================================
// Theme Color Slots (the 12 named positions from OOXML)
// ============================================================================

/// The 12 named color slots in an Excel-compatible theme.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ThemeColorSlot {
    Dark1,
    Light1,
    Dark2,
    Light2,
    Accent1,
    Accent2,
    Accent3,
    Accent4,
    Accent5,
    Accent6,
    Hyperlink,
    FollowedHyperlink,
}

impl ThemeColorSlot {
    /// All 12 slots in display order.
    pub const ALL: [ThemeColorSlot; 12] = [
        Self::Dark1,
        Self::Light1,
        Self::Dark2,
        Self::Light2,
        Self::Accent1,
        Self::Accent2,
        Self::Accent3,
        Self::Accent4,
        Self::Accent5,
        Self::Accent6,
        Self::Hyperlink,
        Self::FollowedHyperlink,
    ];

    /// Slots shown in the color picker (excludes hyperlink colors).
    pub const PICKER: [ThemeColorSlot; 10] = [
        Self::Dark1,
        Self::Light1,
        Self::Dark2,
        Self::Light2,
        Self::Accent1,
        Self::Accent2,
        Self::Accent3,
        Self::Accent4,
        Self::Accent5,
        Self::Accent6,
    ];

    /// Human-readable label.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Dark1 => "Dark 1",
            Self::Light1 => "Light 1",
            Self::Dark2 => "Dark 2",
            Self::Light2 => "Light 2",
            Self::Accent1 => "Accent 1",
            Self::Accent2 => "Accent 2",
            Self::Accent3 => "Accent 3",
            Self::Accent4 => "Accent 4",
            Self::Accent5 => "Accent 5",
            Self::Accent6 => "Accent 6",
            Self::Hyperlink => "Hyperlink",
            Self::FollowedHyperlink => "Followed Hyperlink",
        }
    }

    /// Serialization key (used in frontend communication).
    pub fn key(&self) -> &'static str {
        match self {
            Self::Dark1 => "dark1",
            Self::Light1 => "light1",
            Self::Dark2 => "dark2",
            Self::Light2 => "light2",
            Self::Accent1 => "accent1",
            Self::Accent2 => "accent2",
            Self::Accent3 => "accent3",
            Self::Accent4 => "accent4",
            Self::Accent5 => "accent5",
            Self::Accent6 => "accent6",
            Self::Hyperlink => "hyperlink",
            Self::FollowedHyperlink => "followedHyperlink",
        }
    }

    /// Parse from key string.
    pub fn from_key(key: &str) -> Option<Self> {
        match key {
            "dark1" => Some(Self::Dark1),
            "light1" => Some(Self::Light1),
            "dark2" => Some(Self::Dark2),
            "light2" => Some(Self::Light2),
            "accent1" => Some(Self::Accent1),
            "accent2" => Some(Self::Accent2),
            "accent3" => Some(Self::Accent3),
            "accent4" => Some(Self::Accent4),
            "accent5" => Some(Self::Accent5),
            "accent6" => Some(Self::Accent6),
            "hyperlink" => Some(Self::Hyperlink),
            "followedHyperlink" => Some(Self::FollowedHyperlink),
            _ => None,
        }
    }
}

// ============================================================================
// Tint
// ============================================================================

/// Tint value stored as permille (-1000..+1000) for Eq/Hash compatibility.
/// Positive = lighter (blend toward white), negative = darker (blend toward black).
/// Excel standard tints: +800, +600, +400, -250, -500.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub struct Tint(pub i16);

impl Tint {
    pub const ZERO: Tint = Tint(0);
    pub const LIGHTER_80: Tint = Tint(800);
    pub const LIGHTER_60: Tint = Tint(600);
    pub const LIGHTER_40: Tint = Tint(400);
    pub const DARKER_25: Tint = Tint(-250);
    pub const DARKER_50: Tint = Tint(-500);

    /// The 5 standard tint levels used in Excel's theme color picker.
    pub const PICKER_TINTS: [Tint; 5] = [
        Self::LIGHTER_80,
        Self::LIGHTER_60,
        Self::LIGHTER_40,
        Self::DARKER_25,
        Self::DARKER_50,
    ];

    /// Convert to f64 fraction (-1.0..+1.0).
    pub fn as_f64(self) -> f64 {
        self.0 as f64 / 1000.0
    }
}

// ============================================================================
// ThemeColor (the dual-model enum)
// ============================================================================

/// A color that is either an absolute RGBA value or a reference to a theme slot + tint.
/// This is the type used in CellStyle wherever a color is needed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ThemeColor {
    /// An explicit RGBA color (user picked a specific color).
    Absolute(Color),
    /// A reference to a theme color slot with an optional tint.
    Theme {
        slot: ThemeColorSlot,
        tint: Tint,
    },
}

impl ThemeColor {
    /// Shorthand for an absolute color.
    pub const fn absolute(r: u8, g: u8, b: u8) -> Self {
        ThemeColor::Absolute(Color::new(r, g, b))
    }

    /// Shorthand for a theme slot with no tint.
    pub const fn theme(slot: ThemeColorSlot) -> Self {
        ThemeColor::Theme { slot, tint: Tint(0) }
    }

    /// Shorthand for a theme slot with a specific tint.
    pub const fn theme_tinted(slot: ThemeColorSlot, tint: Tint) -> Self {
        ThemeColor::Theme { slot, tint }
    }

    /// Default text color (theme Dark1 = black in Office theme).
    pub const fn default_text() -> Self {
        ThemeColor::Theme { slot: ThemeColorSlot::Dark1, tint: Tint(0) }
    }

    /// Default background color (theme Light1 = white in Office theme).
    pub const fn default_background() -> Self {
        ThemeColor::Theme { slot: ThemeColorSlot::Light1, tint: Tint(0) }
    }

    /// Static reference to the default background color (for Fill::background_color).
    pub const DEFAULT_BACKGROUND: ThemeColor = ThemeColor::default_background();
}

impl Default for ThemeColor {
    fn default() -> Self {
        ThemeColor::default_text()
    }
}

impl ThemeColor {
    /// Resolve to CSS string using the given theme.
    pub fn to_css(&self, theme: &ThemeDefinition) -> String {
        match self {
            ThemeColor::Absolute(c) => c.to_css(),
            ThemeColor::Theme { slot, tint } => {
                let base = theme.colors.get(*slot);
                apply_tint(base, *tint).to_css()
            }
        }
    }

    /// Resolve to CSS string using the default Office theme.
    /// Convenience for contexts where the active theme isn't available.
    pub fn to_css_default(&self) -> String {
        match self {
            ThemeColor::Absolute(c) => c.to_css(),
            ThemeColor::Theme { .. } => {
                let theme = ThemeDefinition::office();
                self.to_css(&theme)
            }
        }
    }
}

// ============================================================================
// ThemeColors (the 12 base colors)
// ============================================================================

/// The 12 base colors that define a theme's color scheme.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeColors {
    pub dark1: Color,
    pub light1: Color,
    pub dark2: Color,
    pub light2: Color,
    pub accent1: Color,
    pub accent2: Color,
    pub accent3: Color,
    pub accent4: Color,
    pub accent5: Color,
    pub accent6: Color,
    pub hyperlink: Color,
    pub followed_hyperlink: Color,
}

impl ThemeColors {
    /// Get the base color for a slot.
    pub fn get(&self, slot: ThemeColorSlot) -> Color {
        match slot {
            ThemeColorSlot::Dark1 => self.dark1,
            ThemeColorSlot::Light1 => self.light1,
            ThemeColorSlot::Dark2 => self.dark2,
            ThemeColorSlot::Light2 => self.light2,
            ThemeColorSlot::Accent1 => self.accent1,
            ThemeColorSlot::Accent2 => self.accent2,
            ThemeColorSlot::Accent3 => self.accent3,
            ThemeColorSlot::Accent4 => self.accent4,
            ThemeColorSlot::Accent5 => self.accent5,
            ThemeColorSlot::Accent6 => self.accent6,
            ThemeColorSlot::Hyperlink => self.hyperlink,
            ThemeColorSlot::FollowedHyperlink => self.followed_hyperlink,
        }
    }
}

// ============================================================================
// ThemeFonts
// ============================================================================

/// The heading + body font pair for a theme.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ThemeFonts {
    pub heading: String,
    pub body: String,
}

// ============================================================================
// ThemeDefinition
// ============================================================================

/// A complete document theme: name, 12 colors, and font pair.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThemeDefinition {
    pub name: String,
    pub colors: ThemeColors,
    pub fonts: ThemeFonts,
}

impl ThemeDefinition {
    /// Resolve a ThemeColor to an absolute Color using this theme's palette.
    pub fn resolve_color(&self, tc: &ThemeColor) -> Color {
        match tc {
            ThemeColor::Absolute(c) => *c,
            ThemeColor::Theme { slot, tint } => {
                let base = self.colors.get(*slot);
                apply_tint(base, *tint)
            }
        }
    }

    /// Resolve a font family name. "Body" -> theme body font, "Headings" -> heading font.
    /// Returns the original family if not a theme font keyword.
    pub fn resolve_font<'a>(&'a self, family: &'a str) -> &'a str {
        match family {
            "Body" | "body" => &self.fonts.body,
            "Headings" | "headings" => &self.fonts.heading,
            other => other,
        }
    }

    // ========================================================================
    // Built-in Themes
    // ========================================================================

    /// The default "Office" theme (matches Excel's default).
    pub fn office() -> Self {
        ThemeDefinition {
            name: "Office".to_string(),
            colors: ThemeColors {
                dark1: Color::new(0, 0, 0),
                light1: Color::new(255, 255, 255),
                dark2: Color::new(68, 84, 106),
                light2: Color::new(231, 230, 230),
                accent1: Color::new(68, 114, 196),
                accent2: Color::new(237, 125, 49),
                accent3: Color::new(165, 165, 165),
                accent4: Color::new(255, 192, 0),
                accent5: Color::new(91, 155, 213),
                accent6: Color::new(112, 173, 71),
                hyperlink: Color::new(5, 99, 193),
                followed_hyperlink: Color::new(149, 79, 114),
            },
            fonts: ThemeFonts {
                heading: "Calibri Light".to_string(),
                body: "Calibri".to_string(),
            },
        }
    }

    /// "Office 2007-2010" theme.
    pub fn office_2007() -> Self {
        ThemeDefinition {
            name: "Office 2007-2010".to_string(),
            colors: ThemeColors {
                dark1: Color::new(0, 0, 0),
                light1: Color::new(255, 255, 255),
                dark2: Color::new(31, 73, 125),
                light2: Color::new(238, 236, 225),
                accent1: Color::new(79, 129, 189),
                accent2: Color::new(192, 80, 77),
                accent3: Color::new(155, 187, 89),
                accent4: Color::new(128, 100, 162),
                accent5: Color::new(75, 172, 198),
                accent6: Color::new(247, 150, 70),
                hyperlink: Color::new(0, 0, 255),
                followed_hyperlink: Color::new(128, 0, 128),
            },
            fonts: ThemeFonts {
                heading: "Cambria".to_string(),
                body: "Calibri".to_string(),
            },
        }
    }

    /// "Facet" theme.
    pub fn facet() -> Self {
        ThemeDefinition {
            name: "Facet".to_string(),
            colors: ThemeColors {
                dark1: Color::new(0, 0, 0),
                light1: Color::new(255, 255, 255),
                dark2: Color::new(40, 49, 34),
                light2: Color::new(226, 219, 199),
                accent1: Color::new(144, 194, 38),
                accent2: Color::new(84, 160, 33),
                accent3: Color::new(230, 185, 30),
                accent4: Color::new(231, 102, 24),
                accent5: Color::new(196, 47, 26),
                accent6: Color::new(145, 134, 85),
                hyperlink: Color::new(78, 164, 57),
                followed_hyperlink: Color::new(132, 134, 53),
            },
            fonts: ThemeFonts {
                heading: "Trebuchet MS".to_string(),
                body: "Trebuchet MS".to_string(),
            },
        }
    }

    /// "Integral" theme.
    pub fn integral() -> Self {
        ThemeDefinition {
            name: "Integral".to_string(),
            colors: ThemeColors {
                dark1: Color::new(0, 0, 0),
                light1: Color::new(255, 255, 255),
                dark2: Color::new(51, 63, 80),
                light2: Color::new(212, 216, 217),
                accent1: Color::new(28, 173, 228),
                accent2: Color::new(38, 131, 198),
                accent3: Color::new(39, 206, 215),
                accent4: Color::new(66, 186, 151),
                accent5: Color::new(62, 136, 83),
                accent6: Color::new(98, 163, 159),
                hyperlink: Color::new(28, 173, 228),
                followed_hyperlink: Color::new(96, 120, 137),
            },
            fonts: ThemeFonts {
                heading: "Tw Cen MT Condensed".to_string(),
                body: "Tw Cen MT".to_string(),
            },
        }
    }

    /// "Ion" theme.
    pub fn ion() -> Self {
        ThemeDefinition {
            name: "Ion".to_string(),
            colors: ThemeColors {
                dark1: Color::new(0, 0, 0),
                light1: Color::new(255, 255, 255),
                dark2: Color::new(72, 56, 56),
                light2: Color::new(221, 212, 212),
                accent1: Color::new(176, 21, 19),
                accent2: Color::new(234, 99, 18),
                accent3: Color::new(232, 183, 41),
                accent4: Color::new(106, 172, 144),
                accent5: Color::new(95, 156, 157),
                accent6: Color::new(155, 139, 171),
                hyperlink: Color::new(176, 21, 19),
                followed_hyperlink: Color::new(121, 88, 110),
            },
            fonts: ThemeFonts {
                heading: "Century Gothic".to_string(),
                body: "Century Gothic".to_string(),
            },
        }
    }

    /// "Slice" theme.
    pub fn slice() -> Self {
        ThemeDefinition {
            name: "Slice".to_string(),
            colors: ThemeColors {
                dark1: Color::new(0, 0, 0),
                light1: Color::new(255, 255, 255),
                dark2: Color::new(20, 31, 42),
                light2: Color::new(216, 220, 224),
                accent1: Color::new(5, 47, 97),
                accent2: Color::new(165, 14, 130),
                accent3: Color::new(20, 150, 124),
                accent4: Color::new(106, 155, 65),
                accent5: Color::new(232, 125, 55),
                accent6: Color::new(198, 35, 36),
                hyperlink: Color::new(5, 47, 97),
                followed_hyperlink: Color::new(117, 83, 134),
            },
            fonts: ThemeFonts {
                heading: "Century Gothic".to_string(),
                body: "Century Gothic".to_string(),
            },
        }
    }

    /// Get all built-in themes.
    pub fn all_builtin() -> Vec<ThemeDefinition> {
        vec![
            Self::office(),
            Self::office_2007(),
            Self::facet(),
            Self::integral(),
            Self::ion(),
            Self::slice(),
        ]
    }
}

impl Default for ThemeDefinition {
    fn default() -> Self {
        ThemeDefinition::office()
    }
}

// ============================================================================
// Tint Blending (OOXML spec)
// ============================================================================

/// Apply a tint to a base color following the OOXML specification.
/// Positive tint: blend toward white. Negative tint: blend toward black.
fn apply_tint(base: Color, tint: Tint) -> Color {
    if tint.0 == 0 {
        return base;
    }

    let t = tint.as_f64();

    let blend = |channel: u8| -> u8 {
        let c = channel as f64;
        let result = if t > 0.0 {
            // Lighter: blend toward 255
            c + (255.0 - c) * t
        } else {
            // Darker: blend toward 0
            c * (1.0 + t)
        };
        result.round().clamp(0.0, 255.0) as u8
    };

    Color::new(blend(base.r), blend(base.g), blend(base.b))
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_absolute_color() {
        let theme = ThemeDefinition::office();
        let red = ThemeColor::absolute(255, 0, 0);
        assert_eq!(theme.resolve_color(&red), Color::new(255, 0, 0));
    }

    #[test]
    fn test_resolve_theme_color_no_tint() {
        let theme = ThemeDefinition::office();
        let accent1 = ThemeColor::theme(ThemeColorSlot::Accent1);
        assert_eq!(theme.resolve_color(&accent1), Color::new(68, 114, 196));
    }

    #[test]
    fn test_resolve_theme_color_lighter() {
        let theme = ThemeDefinition::office();
        let tc = ThemeColor::theme_tinted(ThemeColorSlot::Accent1, Tint::LIGHTER_80);
        let resolved = theme.resolve_color(&tc);
        // Accent1 = (68, 114, 196), lighter 80%:
        // r = 68 + (255 - 68) * 0.8 = 68 + 149.6 = 217.6 -> 218
        // g = 114 + (255 - 114) * 0.8 = 114 + 112.8 = 226.8 -> 227
        // b = 196 + (255 - 196) * 0.8 = 196 + 47.2 = 243.2 -> 243
        assert_eq!(resolved.r, 218);
        assert_eq!(resolved.g, 227);
        assert_eq!(resolved.b, 243);
    }

    #[test]
    fn test_resolve_theme_color_darker() {
        let theme = ThemeDefinition::office();
        let tc = ThemeColor::theme_tinted(ThemeColorSlot::Accent1, Tint::DARKER_25);
        let resolved = theme.resolve_color(&tc);
        // Accent1 = (68, 114, 196), darker 25%:
        // r = 68 * (1 - 0.25) = 68 * 0.75 = 51
        // g = 114 * 0.75 = 85.5 -> 86
        // b = 196 * 0.75 = 147
        assert_eq!(resolved.r, 51);
        assert_eq!(resolved.g, 86);
        assert_eq!(resolved.b, 147);
    }

    #[test]
    fn test_resolve_font_body() {
        let theme = ThemeDefinition::office();
        assert_eq!(theme.resolve_font("Body"), "Calibri");
        assert_eq!(theme.resolve_font("Headings"), "Calibri Light");
        assert_eq!(theme.resolve_font("Arial"), "Arial");
    }

    #[test]
    fn test_all_builtin_themes() {
        let themes = ThemeDefinition::all_builtin();
        assert_eq!(themes.len(), 6);
        assert_eq!(themes[0].name, "Office");
    }

    #[test]
    fn test_tint_constants() {
        assert_eq!(Tint::LIGHTER_80.as_f64(), 0.8);
        assert_eq!(Tint::DARKER_50.as_f64(), -0.5);
        assert_eq!(Tint::ZERO.as_f64(), 0.0);
    }

    #[test]
    fn test_theme_color_slot_roundtrip() {
        for slot in ThemeColorSlot::ALL {
            let key = slot.key();
            let parsed = ThemeColorSlot::from_key(key).unwrap();
            assert_eq!(parsed, slot);
        }
    }
}
