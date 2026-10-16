//! FILENAME: core/visual-format/src/lib.rs
//! PURPOSE: THE VISUAL CONTAINER (D-FORMAT) -- the padding, title, subtitle,
//!          divider, spacing, background, border and shadow every floating
//!          object (chart, pivot box, slicer, timeline, floating grid, control)
//!          carries around its content, as ONE schema shared by every family.
//! CONTEXT: The Rust mirror of `app/src/api/visualContainer.ts`. The JSON is
//!          identical on both sides (camelCase, sparse: an absent leaf means
//!          "the family default"). Two drift tests read THIS FILE AS TEXT, so
//!          its shape is a contract:
//!          - every `pub const` limit below is diffed against the TS
//!            `VISUAL_CONTAINER_LIMITS` (SCREAMING_SNAKE here, camelCase
//!            there), both directions -- one limit per line;
//!          - `FIELD_POINTERS` (pointer + type) is diffed against the TS
//!            `VISUAL_CONTAINER_FIELD_IDS` / `VISUAL_CONTAINER_FIELD_TYPES`, and
//!            `CONTROL_CONTAINER_PROPERTY_KEYS` against its TS twin -- ONE ROW
//!            PER LINE, in exactly one spelling.
//!
//! Three entry points, three jobs:
//! - `validate` is the EDIT path: refuse, naming the first bad leaf.
//! - `sanitized` is the LOAD / PULL path: repair (clamp numbers, drop unsafe
//!   leaves, drop empty sub-structs) and return `None` when nothing is left, so a
//!   record that carried no container still writes no key and a signed `.calp`
//!   manifest stays byte-identical.
//! - `with_field` is the ONE-LEAF write a binding literal / script / MCP / AI
//!   write lands in (WP-D's `write_container_literal`).
//!
//! Refusal sentences (the TS `validateVisualContainer` returns the SAME text;
//! `{id}` is the dotted field id, e.g. `title.fontSize`, or for a control the
//! flat key, e.g. `containerTitleFontSize`; numbers print as JS prints them):
//! - number:  `{id} must be a number from {min} to {max}.`
//! - integer: `{id} must be a whole number from {min} to {max}.`
//! - boolean: `{id} must be true or false.`
//! - colour:  `{id} must be empty or a #rgb, #rrggbb or #rrggbbaa colour.`
//! - font:    `{id} must be at most 64 letters, digits, spaces, commas, apostrophes or hyphens.`
//! - text:    `{id} must be text of at most 1024 characters.`
//! - enum:    `{id} must be one of: a, b, c.`
//! - gradient: `background.gradient must have from 2 to 8 stops.`,
//!   `background.gradient stop {n} offset must be a number from 0 to 1.`,
//!   `background.gradient stop {n} colour must be a #rgb, #rrggbb or #rrggbbaa colour.`
//!   (`n` counts from 1). The gradient is checked right after
//!   `background.transparency`, i.e. in struct order.
//!
//! Lengths count UTF-16 code units, as JavaScript's `String.length` does, so a
//! text the TS check accepts is a text Rust accepts.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

// ---------- limits (mirrored 1:1 by VISUAL_CONTAINER_LIMITS; drift-tested, ONE per line) ----------
pub const PADDING_MAX: f64 = 200.0;
pub const FONT_SIZE_MIN: f64 = 6.0;
pub const FONT_SIZE_MAX: f64 = 96.0;
pub const BORDER_WIDTH_MAX: f64 = 20.0;
pub const RADIUS_MAX: f64 = 100.0;
pub const DIVIDER_WIDTH_MAX: f64 = 20.0;
pub const SPACING_MAX: f64 = 200.0;
pub const SHADOW_BLUR_MAX: f64 = 50.0;
pub const SHADOW_DISTANCE_MAX: f64 = 50.0;
pub const TRANSPARENCY_MAX: f64 = 100.0;
pub const TEXT_MAX_CHARS: usize = 1024;
pub const FONT_FAMILY_MAX_CHARS: usize = 64;
pub const GRADIENT_STOPS_MIN: usize = 2;
pub const GRADIENT_STOPS_MAX: usize = 8;

/// Not a TS limit (the TS `VisualHeadingLevel` is the union 0..6), so it is
/// private and stays out of the limits drift test.
const HEADING_LEVEL_MAX: f64 = 6.0;

// ---------- enums ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VisualTextAlign {
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VisualLineStyle {
    Solid,
    Dashed,
    Dotted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VisualShadowOffset {
    Outside,
    Inside,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VisualShadowPosition {
    BottomRight,
    Bottom,
    BottomLeft,
    Right,
    Center,
    Left,
    TopRight,
    Top,
    TopLeft,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VisualGradientType {
    Linear,
    Radial,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VisualGradientDirection {
    TopToBottom,
    BottomToTop,
    LeftToRight,
    RightToLeft,
    TopLeftToBottomRight,
    BottomRightToTopLeft,
    TopRightToBottomLeft,
    BottomLeftToTopRight,
}

// ---------- the stored shape (sparse) ----------

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualPadding {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bottom: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left: Option<f64>,
}

/// The text style a title and a subtitle share. FLATTENED into them, so the
/// JSON is `{"title":{"show":true,"fontSize":14}}`, never `{"title":{"style":{...}}}`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualTextStyle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub underline: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align: Option<VisualTextAlign>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wrap: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualTitle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heading_level: Option<u8>,
    #[serde(flatten, default)]
    pub style: VisualTextStyle,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualSubtitle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(flatten, default)]
    pub style: VisualTextStyle,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualDivider {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<VisualLineStyle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ignore_padding: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualSpacing {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub below_title: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub below_subtitle: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub below_divider: Option<f64>,
}

/// One colour stop. Both fields REQUIRED (no Default): a stop without a colour
/// or a position is not a stop.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualGradientStop {
    /// 0..=1 along the gradient.
    pub offset: f64,
    /// A non-empty safe colour (`is_safe_color`, but never `""`).
    pub color: String,
}

/// Shape-identical to the chart's `GradientFill` (`Charts/types.ts`), so the
/// chart painter's `applyFillStyle` paints it unchanged. `type` and `stops` are
/// REQUIRED. The Rust field is the raw identifier `r#type`, which serde writes
/// as the JSON key `"type"` with no per-field rename (forbidden by CLAUDE.md).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualGradient {
    pub r#type: VisualGradientType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<VisualGradientDirection>,
    pub stops: Vec<VisualGradientStop>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualBackground {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transparency: Option<f64>,
    /// A structured value written WHOLE (the chart Fill card / setGradientFill);
    /// deliberately not a field pointer, never bound, never a control key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gradient: Option<VisualGradient>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualBorder {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radius: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualShadow {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transparency: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<VisualShadowOffset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<VisualShadowPosition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blur: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distance: Option<f64>,
}

/// The STORED container (sparse). `Default` serializes to `{}`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualContainerFormat {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub padding: Option<VisualPadding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock_aspect: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<VisualTitle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<VisualSubtitle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub divider: Option<VisualDivider>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spacing: Option<VisualSpacing>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<VisualBackground>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub border: Option<VisualBorder>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow: Option<VisualShadow>,
}

// ---------- the field table ----------

/// The value type of one container field (the subset of WP-D's
/// `BindableValueType` a container field can have).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldType {
    Number,
    Integer,
    Boolean,
    Color,
    Text,
    Enum(&'static [&'static str]),
}

impl FieldType {
    /// The type's name as the TS mirror spells it ("number", "enum"...).
    pub fn wire_name(self) -> &'static str {
        match self {
            FieldType::Number => "number",
            FieldType::Integer => "integer",
            FieldType::Boolean => "boolean",
            FieldType::Color => "color",
            FieldType::Text => "text",
            FieldType::Enum(_) => "enum",
        }
    }
}

/// Every field pointer INSIDE the container (the TS `VISUAL_CONTAINER_FIELD_IDS`
/// as RFC 6901 pointers, same order) with its type. ONE ROW PER LINE: drift-tested
/// against the TS ids/types and against WP-D's Container catalog rows.
/// `background.gradient` is deliberately absent (written whole, never a field).
pub const FIELD_POINTERS: &[(&str, FieldType)] = &[
    ("/padding/top", FieldType::Number),
    ("/padding/right", FieldType::Number),
    ("/padding/bottom", FieldType::Number),
    ("/padding/left", FieldType::Number),
    ("/lockAspect", FieldType::Boolean),
    ("/title/show", FieldType::Boolean),
    ("/title/text", FieldType::Text),
    ("/title/headingLevel", FieldType::Integer),
    ("/title/fontFamily", FieldType::Text),
    ("/title/fontSize", FieldType::Number),
    ("/title/bold", FieldType::Boolean),
    ("/title/italic", FieldType::Boolean),
    ("/title/underline", FieldType::Boolean),
    ("/title/color", FieldType::Color),
    ("/title/background", FieldType::Color),
    ("/title/align", FieldType::Enum(&["left", "center", "right"])),
    ("/title/wrap", FieldType::Boolean),
    ("/subtitle/show", FieldType::Boolean),
    ("/subtitle/text", FieldType::Text),
    ("/subtitle/fontFamily", FieldType::Text),
    ("/subtitle/fontSize", FieldType::Number),
    ("/subtitle/bold", FieldType::Boolean),
    ("/subtitle/italic", FieldType::Boolean),
    ("/subtitle/underline", FieldType::Boolean),
    ("/subtitle/color", FieldType::Color),
    ("/subtitle/background", FieldType::Color),
    ("/subtitle/align", FieldType::Enum(&["left", "center", "right"])),
    ("/subtitle/wrap", FieldType::Boolean),
    ("/divider/show", FieldType::Boolean),
    ("/divider/color", FieldType::Color),
    ("/divider/style", FieldType::Enum(&["solid", "dashed", "dotted"])),
    ("/divider/width", FieldType::Number),
    ("/divider/ignorePadding", FieldType::Boolean),
    ("/spacing/custom", FieldType::Boolean),
    ("/spacing/belowTitle", FieldType::Number),
    ("/spacing/belowSubtitle", FieldType::Number),
    ("/spacing/belowDivider", FieldType::Number),
    ("/background/show", FieldType::Boolean),
    ("/background/color", FieldType::Color),
    ("/background/transparency", FieldType::Number),
    ("/border/show", FieldType::Boolean),
    ("/border/color", FieldType::Color),
    ("/border/width", FieldType::Number),
    ("/border/radius", FieldType::Number),
    ("/shadow/show", FieldType::Boolean),
    ("/shadow/color", FieldType::Color),
    ("/shadow/transparency", FieldType::Number),
    ("/shadow/offset", FieldType::Enum(&["outside", "inside"])),
    ("/shadow/position", FieldType::Enum(&["bottomRight", "bottom", "bottomLeft", "right", "center", "left", "topRight", "top", "topLeft"])),
    ("/shadow/blur", FieldType::Number),
    ("/shadow/distance", FieldType::Number),
];

/// A control's flat key for each field, index for index with `FIELD_POINTERS`
/// ("container" + PascalCase of the dotted id: `title.fontSize` ->
/// `containerTitleFontSize`). The existing control keys a container field can
/// map to instead (`fill`, `stroke`, `strokeWidth`, `borderColor`) are NOT in
/// this list -- they are ordinary control properties. ONE ROW PER LINE: mirrors
/// the TS `CONTROL_CONTAINER_PROPERTY_KEYS` (drift test, WP-C S13).
pub const CONTROL_CONTAINER_PROPERTY_KEYS: &[&str] = &[
    "containerPaddingTop",
    "containerPaddingRight",
    "containerPaddingBottom",
    "containerPaddingLeft",
    "containerLockAspect",
    "containerTitleShow",
    "containerTitleText",
    "containerTitleHeadingLevel",
    "containerTitleFontFamily",
    "containerTitleFontSize",
    "containerTitleBold",
    "containerTitleItalic",
    "containerTitleUnderline",
    "containerTitleColor",
    "containerTitleBackground",
    "containerTitleAlign",
    "containerTitleWrap",
    "containerSubtitleShow",
    "containerSubtitleText",
    "containerSubtitleFontFamily",
    "containerSubtitleFontSize",
    "containerSubtitleBold",
    "containerSubtitleItalic",
    "containerSubtitleUnderline",
    "containerSubtitleColor",
    "containerSubtitleBackground",
    "containerSubtitleAlign",
    "containerSubtitleWrap",
    "containerDividerShow",
    "containerDividerColor",
    "containerDividerStyle",
    "containerDividerWidth",
    "containerDividerIgnorePadding",
    "containerSpacingCustom",
    "containerSpacingBelowTitle",
    "containerSpacingBelowSubtitle",
    "containerSpacingBelowDivider",
    "containerBackgroundShow",
    "containerBackgroundColor",
    "containerBackgroundTransparency",
    "containerBorderShow",
    "containerBorderColor",
    "containerBorderWidth",
    "containerBorderRadius",
    "containerShadowShow",
    "containerShadowColor",
    "containerShadowTransparency",
    "containerShadowOffset",
    "containerShadowPosition",
    "containerShadowBlur",
    "containerShadowDistance",
];

/// The type of a field pointer ("/title/fontSize"), or None when it is not one.
pub fn field_type(pointer: &str) -> Option<FieldType> {
    FIELD_POINTERS
        .iter()
        .find(|(p, _)| *p == pointer)
        .map(|(_, t)| *t)
}

/// The inclusive range of a Number / Integer field pointer; None for any other.
pub fn field_range(pointer: &str) -> Option<(f64, f64)> {
    let range = match pointer {
        "/padding/top" | "/padding/right" | "/padding/bottom" | "/padding/left" => (0.0, PADDING_MAX),
        "/title/headingLevel" => (0.0, HEADING_LEVEL_MAX),
        "/title/fontSize" | "/subtitle/fontSize" => (FONT_SIZE_MIN, FONT_SIZE_MAX),
        "/divider/width" => (0.0, DIVIDER_WIDTH_MAX),
        "/spacing/belowTitle" | "/spacing/belowSubtitle" | "/spacing/belowDivider" => (0.0, SPACING_MAX),
        "/background/transparency" | "/shadow/transparency" => (0.0, TRANSPARENCY_MAX),
        "/border/width" => (0.0, BORDER_WIDTH_MAX),
        "/border/radius" => (0.0, RADIUS_MAX),
        "/shadow/blur" => (0.0, SHADOW_BLUR_MAX),
        "/shadow/distance" => (0.0, SHADOW_DISTANCE_MAX),
        _ => return None,
    };
    Some(range)
}

/// "/title/fontSize" -> "title.fontSize" (the TS `ContainerFieldId`).
pub fn field_id(pointer: &str) -> String {
    pointer.trim_start_matches('/').replace('/', ".")
}

/// The field pointer a control's flat container key stands for
/// ("containerTitleFontSize" -> "/title/fontSize"); None for any other key.
pub fn control_container_key_pointer(key: &str) -> Option<&'static str> {
    CONTROL_CONTAINER_PROPERTY_KEYS
        .iter()
        .position(|k| *k == key)
        .and_then(|i| FIELD_POINTERS.get(i))
        .map(|(p, _)| *p)
}

// ---------- leaf checks ----------

/// `""` (the family default) | `#rgb` | `#rrggbb` | `#rrggbbaa`, hex in either case.
/// Nothing else: no names, no `url(...)`, no `rgb(...)`.
pub fn is_safe_color(s: &str) -> bool {
    if s.is_empty() {
        return true;
    }
    match s.strip_prefix('#') {
        Some(hex) => matches!(hex.len(), 3 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit()),
        None => false,
    }
}

/// At most 64 of `[A-Za-z0-9 ,'-]` (so never `;`, `(`, `url(`, quotes that
/// close a CSS string). `""` is the family default.
pub fn is_safe_font_family(s: &str) -> bool {
    utf16_len(s) <= FONT_FAMILY_MAX_CHARS
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | ',' | '\'' | '-'))
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn is_safe_text(s: &str) -> bool {
    utf16_len(s) <= TEXT_MAX_CHARS
}

fn is_font_family_pointer(pointer: &str) -> bool {
    pointer.ends_with("/fontFamily")
}

/// Formats a limit as JavaScript prints a number (6 not 6.0), so the sentence
/// is the same on both sides.
fn js_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

const COLOUR_RULE: &str = "must be empty or a #rgb, #rrggbb or #rrggbbaa colour.";

fn refusal(label: &str, pointer: &str, ty: FieldType) -> String {
    match ty {
        FieldType::Number | FieldType::Integer => {
            let (min, max) = field_range(pointer).unwrap_or((f64::MIN, f64::MAX));
            let kind = if ty == FieldType::Integer { "a whole number" } else { "a number" };
            format!("{label} must be {kind} from {} to {}.", js_number(min), js_number(max))
        }
        FieldType::Boolean => format!("{label} must be true or false."),
        FieldType::Color => format!("{label} {COLOUR_RULE}"),
        FieldType::Text if is_font_family_pointer(pointer) => format!(
            "{label} must be at most {FONT_FAMILY_MAX_CHARS} letters, digits, spaces, commas, apostrophes or hyphens."
        ),
        FieldType::Text => format!("{label} must be text of at most {TEXT_MAX_CHARS} characters."),
        FieldType::Enum(values) => format!("{label} must be one of: {}.", values.join(", ")),
    }
}

/// THE leaf rule. `label` names the leaf in the refusal (a dotted field id, or a
/// control's flat key).
fn check_leaf(label: &str, pointer: &str, ty: FieldType, v: &Value) -> Result<(), String> {
    let ok = match ty {
        FieldType::Number | FieldType::Integer => match (v.as_f64(), field_range(pointer)) {
            (Some(n), Some((min, max))) => {
                n.is_finite() && n >= min && n <= max && (ty != FieldType::Integer || n.fract() == 0.0)
            }
            _ => false,
        },
        FieldType::Boolean => v.is_boolean(),
        FieldType::Color => v.as_str().is_some_and(is_safe_color),
        FieldType::Text if is_font_family_pointer(pointer) => v.as_str().is_some_and(is_safe_font_family),
        FieldType::Text => v.as_str().is_some_and(is_safe_text),
        FieldType::Enum(values) => v.as_str().is_some_and(|s| values.contains(&s)),
    };
    if ok {
        Ok(())
    } else {
        Err(refusal(label, pointer, ty))
    }
}

fn validate_gradient(g: &VisualGradient) -> Result<(), String> {
    if g.stops.len() < GRADIENT_STOPS_MIN || g.stops.len() > GRADIENT_STOPS_MAX {
        return Err(format!(
            "background.gradient must have from {GRADIENT_STOPS_MIN} to {GRADIENT_STOPS_MAX} stops."
        ));
    }
    for (i, stop) in g.stops.iter().enumerate() {
        let n = i + 1;
        if !(stop.offset.is_finite() && (0.0..=1.0).contains(&stop.offset)) {
            return Err(format!("background.gradient stop {n} offset must be a number from 0 to 1."));
        }
        if stop.color.is_empty() || !is_safe_color(&stop.color) {
            return Err(format!(
                "background.gradient stop {n} colour must be a #rgb, #rrggbb or #rrggbbaa colour."
            ));
        }
    }
    Ok(())
}

fn sanitize_gradient(g: VisualGradient) -> Option<VisualGradient> {
    let stops: Vec<VisualGradientStop> = g
        .stops
        .into_iter()
        .filter(|s| s.offset.is_finite() && !s.color.is_empty() && is_safe_color(&s.color))
        .map(|s| VisualGradientStop { offset: s.offset.clamp(0.0, 1.0), color: s.color })
        .take(GRADIENT_STOPS_MAX)
        .collect();
    if stops.len() < GRADIENT_STOPS_MIN {
        return None;
    }
    Some(VisualGradient { r#type: g.r#type, direction: g.direction, stops })
}

// ---------- JSON helpers (the container is edited as its own JSON, one rule path) ----------

fn segments(pointer: &str) -> Vec<&str> {
    pointer.trim_start_matches('/').split('/').collect()
}

/// Set (Some) or remove (None) one leaf of a container's JSON, creating the
/// parent object on a set.
fn set_leaf(root: &mut Value, pointer: &str, leaf: Option<Value>) {
    let segs = segments(pointer);
    let Some((last, parents)) = segs.split_last() else { return };
    let mut cur = root;
    for seg in parents {
        let Some(obj) = cur.as_object_mut() else { return };
        if leaf.is_none() && !obj.contains_key(*seg) {
            return;
        }
        cur = obj.entry(seg.to_string()).or_insert_with(|| Value::Object(Map::new()));
        if !cur.is_object() {
            if leaf.is_none() {
                return;
            }
            *cur = Value::Object(Map::new());
        }
    }
    if let Some(obj) = cur.as_object_mut() {
        match leaf {
            Some(v) => {
                obj.insert(last.to_string(), v);
            }
            None => {
                obj.remove(*last);
            }
        }
    }
}

/// Remove every empty object member, depth first (`{"border":{}}` -> `{}`).
/// Arrays (gradient stops) are left alone.
fn prune_empty(v: &mut Value) {
    if let Value::Object(map) = v {
        for child in map.values_mut() {
            prune_empty(child);
        }
        map.retain(|_, child| !matches!(child, Value::Object(m) if m.is_empty()));
    }
}

impl VisualContainerFormat {
    fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or_else(|_| Value::Object(Map::new()))
    }

    /// EDIT path: `Err` names the first bad leaf, in `FIELD_POINTERS` order with
    /// the gradient checked right after `background.transparency` (the same
    /// sentences as the TS `validateVisualContainer`, see the module docs).
    pub fn validate(&self) -> Result<(), String> {
        let root = self.to_json();
        for (pointer, ty) in FIELD_POINTERS {
            if let Some(v) = root.pointer(pointer) {
                check_leaf(&field_id(pointer), pointer, *ty, v)?;
            }
            if *pointer == "/background/transparency" {
                if let Some(g) = self.background.as_ref().and_then(|b| b.gradient.as_ref()) {
                    validate_gradient(g)?;
                }
            }
        }
        Ok(())
    }

    /// LOAD / PULL path: clamp numbers into range (a whole-number field is
    /// rounded), drop unsafe colours / font families / over-long text and
    /// non-finite numbers, repair or drop the gradient (bad stops dropped, at
    /// most 8 kept, fewer than 2 drops it), drop empty sub-structs. `None` when
    /// nothing is left, so the record writes no key. `validate(sanitized(x))`
    /// is always Ok.
    pub fn sanitized(self) -> Option<VisualContainerFormat> {
        let mut this = self;
        if let Some(bg) = this.background.as_mut() {
            bg.gradient = bg.gradient.take().and_then(sanitize_gradient);
        }
        let mut root = this.to_json();
        for (pointer, ty) in FIELD_POINTERS {
            let Some(v) = root.pointer(pointer).cloned() else { continue };
            if check_leaf("", pointer, *ty, &v).is_ok() {
                continue;
            }
            let repaired = match (ty, v.as_f64(), field_range(pointer)) {
                (FieldType::Number, Some(n), Some((min, max))) if n.is_finite() => {
                    Some(Value::from(n.clamp(min, max)))
                }
                (FieldType::Integer, Some(n), Some((min, max))) if n.is_finite() => {
                    Some(Value::from(n.round().clamp(min, max) as u64))
                }
                _ => None,
            };
            set_leaf(&mut root, pointer, repaired);
        }
        prune_empty(&mut root);
        if root.as_object().is_none_or(Map::is_empty) {
            return None;
        }
        serde_json::from_value(root).ok()
    }

    /// True when the container carries nothing (every sub-struct absent or
    /// empty): such a container is written as NO key.
    pub fn is_empty(&self) -> bool {
        let mut root = self.to_json();
        prune_empty(&mut root);
        root.as_object().is_none_or(Map::is_empty)
    }

    /// Set ONE leaf by its pointer inside the container ("/title/fontSize");
    /// `Value::Null` clears it (and an emptied sub-struct goes with it). `Err`
    /// (a sentence) for a pointer that is not in `FIELD_POINTERS` or a value
    /// failing the leaf's check. Kind-specific refusals (a chart's
    /// `/title/text`) are the caller's: `forbid_chart_title_leaves`.
    pub fn with_field(self, pointer: &str, value: Value) -> Result<VisualContainerFormat, String> {
        let ty = field_type(pointer)
            .ok_or_else(|| format!("{pointer} is not a visual container field."))?;
        let leaf = if value.is_null() {
            None
        } else {
            check_leaf(&field_id(pointer), pointer, ty, &value)?;
            Some(match (ty, value.as_f64()) {
                // 3.0 from JavaScript is 3: store it as an integer so the u8 field reads it.
                (FieldType::Integer, Some(n)) => Value::from(n as u64),
                _ => value,
            })
        };
        let mut root = self.to_json();
        set_leaf(&mut root, pointer, leaf);
        prune_empty(&mut root);
        serde_json::from_value(root)
            .map_err(|e| format!("{} could not be stored: {e}", field_id(pointer)))
    }

    /// Charts: `Err` when `title.text`, `title.color` or `title.fontSize` is
    /// present. A chart's title text is `spec.title` and its colour / size are
    /// `spec.config.theme.titleColor` / `titleFontSize` -- ONE spelling per fact,
    /// so no route (pane, script, MCP, AI) may create a second one here.
    pub fn forbid_chart_title_leaves(&self) -> Result<(), String> {
        let Some(title) = self.title.as_ref() else { return Ok(()) };
        if title.text.is_some() {
            return Err("A chart's title text is spec.title, never container.title.text.".into());
        }
        if title.style.color.is_some() {
            return Err(
                "A chart's title colour is spec.config.theme.titleColor, never container.title.color."
                    .into(),
            );
        }
        if title.style.font_size.is_some() {
            return Err(
                "A chart's title font size is spec.config.theme.titleFontSize, never container.title.fontSize."
                    .into(),
            );
        }
        Ok(())
    }

    /// LOAD / PULL path from RAW JSON: like `sanitized`, but it never fails on
    /// the SHAPE either. A typed `from_value` refuses a whole container over one
    /// leaf of the wrong JSON type (`"bold": "yes"`) or out of a `u8`'s range
    /// (`"headingLevel": 300`, `2.5`, `-1`) -- and with it the record carrying it
    /// (a pivot definition, a slicer). Here every known leaf is taken one at a
    /// time: a valid one is kept, a finite number out of range is clamped (a
    /// whole-number field rounded first), anything else is dropped; the gradient
    /// is kept only if it parses and survives `sanitized`'s repair. Unknown keys
    /// are dropped. `None` when nothing is left (or `value` is not an object).
    pub fn from_value_lenient(value: &Value) -> Option<VisualContainerFormat> {
        if !value.is_object() {
            return None;
        }
        let mut root = Value::Object(Map::new());
        for (pointer, ty) in FIELD_POINTERS {
            let Some(v) = value.pointer(pointer) else { continue };
            let kept = if check_leaf("", pointer, *ty, v).is_ok() {
                Some(match (ty, v.as_f64()) {
                    (FieldType::Integer, Some(n)) => Value::from(n as u64),
                    _ => v.clone(),
                })
            } else {
                match (ty, v.as_f64(), field_range(pointer)) {
                    (FieldType::Number, Some(n), Some((min, max))) if n.is_finite() => {
                        Some(Value::from(n.clamp(min, max)))
                    }
                    (FieldType::Integer, Some(n), Some((min, max))) if n.is_finite() => {
                        Some(Value::from(n.round().clamp(min, max) as u64))
                    }
                    _ => None,
                }
            };
            if kept.is_some() {
                set_leaf(&mut root, pointer, kept);
            }
        }
        let gradient = value
            .pointer("/background/gradient")
            .and_then(|g| serde_json::from_value::<VisualGradient>(g.clone()).ok())
            .and_then(sanitize_gradient)
            .and_then(|g| serde_json::to_value(g).ok());
        if gradient.is_some() {
            set_leaf(&mut root, "/background/gradient", gradient);
        }
        prune_empty(&mut root);
        serde_json::from_value::<VisualContainerFormat>(root).ok()?.sanitized()
    }
}

/// The LOAD-path serde reader for a record's `container` field:
/// `#[serde(default, deserialize_with = "visual_format::deserialize_container_lenient")]`.
/// A container that cannot be read (or is empty after repair) becomes `None`
/// instead of failing the record that carries it -- refusing would drop a whole
/// pivot or slicer over a cosmetic value. Edit paths deserialize STRICTLY and
/// call `validate` instead, so a caller is told its value was wrong.
pub fn deserialize_container_lenient<'de, D>(deserializer: D) -> Result<Option<VisualContainerFormat>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Option::<Value>::deserialize(deserializer)?;
    Ok(raw.as_ref().and_then(VisualContainerFormat::from_value_lenient))
}

/// `^-?\d+(\.\d+)?([eE][+-]?\d+)?$` -- a plain decimal, as `String(n)` writes a
/// number in JavaScript. No hex, no `inf`/`NaN`, no surrounding spaces (Rust's
/// `parse::<f64>` alone would accept `inf` and `NaN`).
fn parse_plain_number(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    let mut i = 0;
    if b.first() == Some(&b'-') {
        i += 1;
    }
    let digits = |i: &mut usize| {
        let start = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i > start
    };
    if !digits(&mut i) {
        return None;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        if !digits(&mut i) {
            return None;
        }
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        if !digits(&mut i) {
            return None;
        }
    }
    if i != b.len() {
        return None;
    }
    s.parse::<f64>().ok().filter(|n| n.is_finite())
}

/// A control's flat container key ("containerTitleFontSize") -> Ok, or an Err
/// sentence naming the key, for its value STRING. Keys outside
/// `CONTROL_CONTAINER_PROPERTY_KEYS` are not ours -> Ok. `""` is Ok for every
/// key (the family default). Booleans are exactly `"true"` / `"false"`; numbers
/// are plain decimals (`parse_plain_number`).
pub fn check_control_container_value(key: &str, value: &str) -> Result<(), String> {
    let Some(pointer) = control_container_key_pointer(key) else { return Ok(()) };
    if value.is_empty() {
        return Ok(());
    }
    let Some(ty) = field_type(pointer) else { return Ok(()) };
    let v = match ty {
        FieldType::Number | FieldType::Integer => match parse_plain_number(value) {
            Some(n) => Value::from(n),
            None => Value::Null,
        },
        FieldType::Boolean => match value {
            "true" => Value::Bool(true),
            "false" => Value::Bool(false),
            _ => Value::Null,
        },
        FieldType::Color | FieldType::Text | FieldType::Enum(_) => Value::String(value.to_string()),
    };
    check_leaf(key, pointer, ty, &v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(v: Value) -> VisualContainerFormat {
        serde_json::from_value(v).expect("deserializes")
    }

    /// The TS `VISUAL_CONTAINER_FIELD_IDS`, copied from the WP-C spec 2.1 so this
    /// crate pins the vocabulary on its own (the TS drift test pins it again).
    const TS_FIELD_IDS: &[&str] = &[
        "padding.top", "padding.right", "padding.bottom", "padding.left", "lockAspect",
        "title.show", "title.text", "title.headingLevel", "title.fontFamily", "title.fontSize", "title.bold",
        "title.italic", "title.underline", "title.color", "title.background", "title.align", "title.wrap",
        "subtitle.show", "subtitle.text", "subtitle.fontFamily", "subtitle.fontSize", "subtitle.bold",
        "subtitle.italic", "subtitle.underline", "subtitle.color", "subtitle.background", "subtitle.align", "subtitle.wrap",
        "divider.show", "divider.color", "divider.style", "divider.width", "divider.ignorePadding",
        "spacing.custom", "spacing.belowTitle", "spacing.belowSubtitle", "spacing.belowDivider",
        "background.show", "background.color", "background.transparency",
        "border.show", "border.color", "border.width", "border.radius",
        "shadow.show", "shadow.color", "shadow.transparency", "shadow.offset", "shadow.position",
        "shadow.blur", "shadow.distance",
    ];

    /// A valid sample value for every field type.
    fn sample(pointer: &str, ty: FieldType) -> Value {
        match ty {
            FieldType::Number | FieldType::Integer => {
                let (min, max) = field_range(pointer).unwrap();
                json!(((min + max) / 2.0).round())
            }
            FieldType::Boolean => json!(true),
            FieldType::Color => json!("#336699"),
            FieldType::Text if is_font_family_pointer(pointer) => json!("Segoe UI"),
            FieldType::Text => json!("Revenue"),
            FieldType::Enum(values) => json!(values[values.len() - 1]),
        }
    }

    // ---- serde shape ----

    #[test]
    fn the_title_style_is_flattened_and_camel_cased() {
        let c = parse(json!({"title": {"show": true, "fontSize": 14}}));
        let title = c.title.as_ref().unwrap();
        assert_eq!(title.show, Some(true));
        assert_eq!(title.style.font_size, Some(14.0));
        let out = serde_json::to_value(&c).unwrap();
        assert_eq!(out["title"]["show"], json!(true));
        assert_eq!(out["title"]["fontSize"].as_f64(), Some(14.0));
        assert!(out["title"].get("style").is_none(), "{out}");
        assert_eq!(out["title"].as_object().unwrap().len(), 2, "{out}");
    }

    #[test]
    fn a_full_container_round_trips_in_camel_case() {
        let input = json!({
            "padding": {"top": 4, "right": 6, "bottom": 8, "left": 10},
            "lockAspect": true,
            "title": {"show": true, "text": "Sales", "headingLevel": 2, "fontFamily": "Segoe UI",
                      "fontSize": 14, "bold": true, "italic": false, "underline": false,
                      "color": "#123", "background": "#ffffff80", "align": "center", "wrap": true},
            "subtitle": {"show": true, "text": "FY", "fontSize": 10, "align": "left"},
            "divider": {"show": true, "color": "#ccc", "style": "dashed", "width": 1, "ignorePadding": true},
            "spacing": {"custom": true, "belowTitle": 2, "belowSubtitle": 3, "belowDivider": 4},
            "background": {"show": true, "color": "#fff", "transparency": 20,
                           "gradient": {"type": "linear", "direction": "leftToRight",
                                        "stops": [{"offset": 0, "color": "#000"}, {"offset": 1, "color": "#ffffff"}]}},
            "border": {"show": true, "color": "#000", "width": 2, "radius": 12},
            "shadow": {"show": true, "color": "#00000040", "transparency": 50, "offset": "inside",
                       "position": "topLeft", "blur": 4, "distance": 3}
        });
        let c = parse(input.clone());
        assert!(c.validate().is_ok(), "{:?}", c.validate());
        let text = serde_json::to_string(&c).unwrap();
        assert!(text.contains("\"type\":\"linear\""), "{text}");
        assert!(text.contains("\"lockAspect\":true"), "{text}");
        assert!(text.contains("\"ignorePadding\":true"), "{text}");
        assert!(text.contains("\"headingLevel\":2"), "{text}");
        assert!(text.contains("\"position\":\"topLeft\""), "{text}");
        assert!(text.contains("\"direction\":\"leftToRight\""), "{text}");
        let back: VisualContainerFormat = serde_json::from_str(&text).unwrap();
        assert_eq!(back, c);
        // Every key of the input survives (no field lost to a misspelling).
        let out = serde_json::to_value(&c).unwrap();
        for (k, v) in input.as_object().unwrap() {
            let o = out.get(k).unwrap_or_else(|| panic!("lost {k}"));
            if let (Some(a), Some(b)) = (v.as_object(), o.as_object()) {
                assert_eq!(a.len(), b.len(), "{k}: {v} vs {o}");
            }
        }
    }

    #[test]
    fn default_serializes_to_an_empty_object() {
        assert_eq!(serde_json::to_string(&VisualContainerFormat::default()).unwrap(), "{}");
        assert!(VisualContainerFormat::default().is_empty());
        assert_eq!(VisualContainerFormat::default().sanitized(), None);
    }

    #[test]
    fn a_gradient_without_stops_or_type_does_not_deserialize() {
        let no_stops = json!({"background": {"gradient": {"type": "linear"}}});
        assert!(serde_json::from_value::<VisualContainerFormat>(no_stops).is_err());
        let no_type = json!({"background": {"gradient": {"stops": [
            {"offset": 0, "color": "#000"}, {"offset": 1, "color": "#fff"}]}}});
        assert!(serde_json::from_value::<VisualContainerFormat>(no_type).is_err());
        let stop_without_color = json!({"background": {"gradient": {"type": "radial", "stops": [
            {"offset": 0}, {"offset": 1, "color": "#fff"}]}}});
        assert!(serde_json::from_value::<VisualContainerFormat>(stop_without_color).is_err());
        let ok = json!({"background": {"gradient": {"type": "radial", "stops": [
            {"offset": 0, "color": "#000"}, {"offset": 1, "color": "#fff"}]}}});
        let c = parse(ok);
        assert_eq!(c.background.unwrap().gradient.unwrap().r#type, VisualGradientType::Radial);
    }

    // ---- validate ----

    #[test]
    fn validate_refuses_each_limit_plus_one_and_accepts_the_limit() {
        let mut checked = 0;
        for (pointer, ty) in FIELD_POINTERS {
            let Some((min, max)) = field_range(pointer) else { continue };
            let at_max = VisualContainerFormat::default().with_field(pointer, json!(max)).unwrap();
            assert!(at_max.validate().is_ok(), "{pointer} at max");
            let at_min = VisualContainerFormat::default().with_field(pointer, json!(min)).unwrap();
            assert!(at_min.validate().is_ok(), "{pointer} at min");
            // Over the top: built as JSON (with_field would refuse it).
            // (An integer field is written as an integer: a u8 does not read 7.0.)
            let over_value = if *ty == FieldType::Integer { json!(max as u64 + 1) } else { json!(max + 1.0) };
            let mut root = json!({});
            set_leaf(&mut root, pointer, Some(over_value));
            let over = parse(root);
            assert_eq!(over.validate(), Err(refusal(&field_id(pointer), pointer, *ty)), "{pointer}");
            // Under the bottom (a negative heading level cannot even be read into a u8).
            let mut root = json!({});
            set_leaf(&mut root, pointer, Some(json!(min - 1.0)));
            if let Ok(under) = serde_json::from_value::<VisualContainerFormat>(root) {
                assert_eq!(under.validate(), Err(refusal(&field_id(pointer), pointer, *ty)), "{pointer} under min");
            }
            checked += 1;
        }
        assert_eq!(checked, 17, "every numeric field has a range");
    }

    #[test]
    fn validate_sentences_are_pinned() {
        let c = parse(json!({"title": {"fontSize": 97}}));
        assert_eq!(c.validate(), Err("title.fontSize must be a number from 6 to 96.".into()));
        let c = parse(json!({"title": {"headingLevel": 7}}));
        assert_eq!(c.validate(), Err("title.headingLevel must be a whole number from 0 to 6.".into()));
        let c = parse(json!({"border": {"color": "red"}}));
        assert_eq!(
            c.validate(),
            Err("border.color must be empty or a #rgb, #rrggbb or #rrggbbaa colour.".into())
        );
        let c = parse(json!({"subtitle": {"fontFamily": "Arial; x"}}));
        assert_eq!(
            c.validate(),
            Err("subtitle.fontFamily must be at most 64 letters, digits, spaces, commas, apostrophes or hyphens.".into())
        );
        let c = parse(json!({"title": {"text": "x".repeat(1025)}}));
        assert_eq!(c.validate(), Err("title.text must be text of at most 1024 characters.".into()));
        let c = parse(json!({"background": {"gradient": {"type": "linear", "stops": [{"offset": 0, "color": "#000"}]}}}));
        assert_eq!(c.validate(), Err("background.gradient must have from 2 to 8 stops.".into()));
        // First bad leaf wins, in field order.
        let c = parse(json!({"shadow": {"blur": 99}, "padding": {"left": -1}}));
        assert_eq!(c.validate(), Err("padding.left must be a number from 0 to 200.".into()));
        // The gradient is checked after background.transparency, before border.
        let c = parse(json!({"border": {"width": 99}, "background": {"transparency": 5,
            "gradient": {"type": "linear", "stops": [{"offset": 0, "color": "#000"}]}}}));
        assert_eq!(c.validate(), Err("background.gradient must have from 2 to 8 stops.".into()));
    }

    #[test]
    fn validate_refuses_every_unsafe_colour_on_every_colour_field() {
        let unsafe_colours = ["red", "url(x)", "#12345", "#1234567", "javascript:", "#ggg", "#1234", "rgb(1,2,3)", " #fff", "#fff "];
        let safe_colours = ["", "#abc", "#AABBCC", "#aabbccdd", "#09F"];
        for (pointer, ty) in FIELD_POINTERS {
            if *ty != FieldType::Color {
                continue;
            }
            for bad in unsafe_colours {
                let mut root = json!({});
                set_leaf(&mut root, pointer, Some(json!(bad)));
                assert!(parse(root).validate().is_err(), "{pointer} accepted {bad:?}");
                assert!(!is_safe_color(bad));
            }
            for good in safe_colours {
                let mut root = json!({});
                set_leaf(&mut root, pointer, Some(json!(good)));
                assert!(parse(root).validate().is_ok(), "{pointer} refused {good:?}");
            }
        }
    }

    #[test]
    fn font_families_and_texts_are_bounded() {
        assert!(is_safe_font_family("Segoe UI, Arial, sans-serif"));
        assert!(is_safe_font_family("'Times New Roman'"));
        assert!(is_safe_font_family(""));
        assert!(!is_safe_font_family("Arial;color:red"));
        assert!(!is_safe_font_family("url(x)"));
        assert!(!is_safe_font_family("\"Arial\""));
        assert!(is_safe_font_family(&"a".repeat(64)));
        assert!(!is_safe_font_family(&"a".repeat(65)));
        let ok = parse(json!({"title": {"text": "x".repeat(1024)}}));
        assert!(ok.validate().is_ok());
        let long = parse(json!({"subtitle": {"text": "x".repeat(1025)}}));
        assert!(long.validate().is_err());
        // UTF-16 units, like JavaScript: 512 astral characters = 1024 units.
        let astral = parse(json!({"title": {"text": "\u{1F600}".repeat(512)}}));
        assert!(astral.validate().is_ok());
        let astral = parse(json!({"title": {"text": "\u{1F600}".repeat(513)}}));
        assert!(astral.validate().is_err());
    }

    #[test]
    fn gradients_need_two_to_eight_safe_stops_in_zero_to_one() {
        let grad = |stops: Value| parse(json!({"background": {"gradient": {"type": "linear", "stops": stops}}}));
        let stops = |n: usize| {
            Value::Array((0..n).map(|i| json!({"offset": i as f64 / 10.0, "color": "#000"})).collect())
        };
        assert!(grad(stops(1)).validate().is_err());
        assert!(grad(stops(2)).validate().is_ok());
        assert!(grad(stops(8)).validate().is_ok());
        assert!(grad(stops(9)).validate().is_err());
        let bad_offset = grad(json!([{"offset": 0, "color": "#000"}, {"offset": 1.5, "color": "#fff"}]));
        assert_eq!(
            bad_offset.validate(),
            Err("background.gradient stop 2 offset must be a number from 0 to 1.".into())
        );
        let empty_colour = grad(json!([{"offset": 0, "color": ""}, {"offset": 1, "color": "#fff"}]));
        assert_eq!(
            empty_colour.validate(),
            Err("background.gradient stop 1 colour must be a #rgb, #rrggbb or #rrggbbaa colour.".into())
        );
        let named = grad(json!([{"offset": 0, "color": "#000"}, {"offset": 1, "color": "red"}]));
        assert!(named.validate().is_err());
    }

    // ---- sanitized ----

    #[test]
    fn sanitized_clamps_and_drops_instead_of_refusing() {
        let c = parse(json!({
            "padding": {"top": 500, "left": -3, "right": 7},
            "title": {"fontSize": 2, "headingLevel": 9, "color": "red", "fontFamily": "a;b",
                      "text": "x".repeat(1025), "bold": true},
            "shadow": {"blur": 1000, "distance": -5, "transparency": 250},
            "border": {"color": "url(x)"}
        }));
        let s = c.sanitized().expect("something is left");
        let p = s.padding.as_ref().unwrap();
        assert_eq!((p.top, p.left, p.right, p.bottom), (Some(200.0), Some(0.0), Some(7.0), None));
        let t = s.title.as_ref().unwrap();
        assert_eq!(t.style.font_size, Some(6.0));
        assert_eq!(t.heading_level, Some(6));
        assert_eq!(t.style.color, None);
        assert_eq!(t.style.font_family, None);
        assert_eq!(t.text, None);
        assert_eq!(t.style.bold, Some(true));
        let sh = s.shadow.as_ref().unwrap();
        assert_eq!((sh.blur, sh.distance, sh.transparency), (Some(50.0), Some(0.0), Some(100.0)));
        assert_eq!(s.border, None, "a border left with nothing is dropped");
        assert!(s.validate().is_ok());
    }

    #[test]
    fn sanitized_is_none_when_nothing_is_left() {
        assert_eq!(parse(json!({"border": {}})).sanitized(), None);
        assert_eq!(parse(json!({"border": {"color": "url(x)"}, "title": {}})).sanitized(), None);
        assert_eq!(parse(json!({})).sanitized(), None);
        assert!(parse(json!({"border": {}, "padding": {}})).is_empty());
        assert!(!parse(json!({"border": {"show": false}})).is_empty());
    }

    #[test]
    fn sanitized_repairs_or_drops_the_gradient() {
        let nine: Vec<Value> = (0..9).map(|i| json!({"offset": i as f64 / 8.0, "color": "#000"})).collect();
        let s = parse(json!({"background": {"gradient": {"type": "linear", "stops": nine}}})).sanitized().unwrap();
        assert_eq!(s.background.as_ref().unwrap().gradient.as_ref().unwrap().stops.len(), 8);
        let one = parse(json!({"background": {"color": "#fff", "gradient": {"type": "linear",
            "stops": [{"offset": 0, "color": "#000"}]}}})).sanitized().unwrap();
        assert_eq!(one.background.as_ref().unwrap().gradient, None);
        assert_eq!(one.background.as_ref().unwrap().color.as_deref(), Some("#fff"));
        let bad_stop = parse(json!({"background": {"gradient": {"type": "radial", "stops": [
            {"offset": -2, "color": "#000"}, {"offset": 0.5, "color": "javascript:"}, {"offset": 3, "color": "#fff"}]}}}))
            .sanitized()
            .unwrap();
        let g = bad_stop.background.unwrap().gradient.unwrap();
        assert_eq!(g.stops, vec![
            VisualGradientStop { offset: 0.0, color: "#000".into() },
            VisualGradientStop { offset: 1.0, color: "#fff".into() },
        ]);
        let only_gradient_and_it_is_bad = parse(json!({"background": {"gradient": {"type": "linear",
            "stops": [{"offset": 0, "color": "red"}, {"offset": 1, "color": "blue"}]}}}));
        assert_eq!(only_gradient_and_it_is_bad.sanitized(), None);
    }

    #[test]
    fn sanitized_output_always_validates_for_a_fuzz_table() {
        let long = "x".repeat(2000);
        let table: Vec<Value> = vec![
            json!({}),
            json!({"padding": {"top": 1e300}}),
            json!({"padding": {"top": -1e300, "right": 0.5}}),
            json!({"lockAspect": false}),
            json!({"title": {"fontSize": 0}}),
            json!({"title": {"fontSize": 96.5, "headingLevel": 255}}),
            json!({"title": {"text": long}}),
            json!({"title": {"fontFamily": "Comic Sans; }"}}),
            json!({"title": {"color": "#1234567", "background": "#12345"}}),
            json!({"title": {"align": "right", "wrap": true, "color": "#FFF"}}),
            json!({"subtitle": {"fontSize": 1000, "color": "javascript:"}}),
            json!({"subtitle": {"text": "", "fontFamily": ""}}),
            json!({"divider": {"width": 21, "color": "url(x)", "style": "dotted"}}),
            json!({"divider": {"width": -0.1, "ignorePadding": true}}),
            json!({"spacing": {"belowTitle": 201, "belowSubtitle": -201, "belowDivider": 0}}),
            json!({"background": {"transparency": 101, "color": "red"}}),
            json!({"background": {"transparency": -1, "show": false}}),
            json!({"background": {"gradient": {"type": "linear", "stops": []}}}),
            json!({"background": {"gradient": {"type": "radial", "direction": "topToBottom",
                "stops": [{"offset": 2, "color": "#000"}, {"offset": -1, "color": "#fff"}]}}}),
            json!({"border": {"width": 20.0001, "radius": 100.0001}}),
            json!({"border": {"width": 0, "radius": 0, "color": ""}}),
            json!({"shadow": {"blur": 51, "distance": 51, "transparency": 100.5}}),
            json!({"shadow": {"position": "center", "offset": "inside", "color": "#00000080"}}),
            json!({"shadow": {"color": "black"}}),
            json!({"title": {}, "subtitle": {}, "divider": {}, "spacing": {}}),
            json!({"padding": {"top": 0, "right": 200, "bottom": 200.5, "left": 199.9}}),
            json!({"title": {"headingLevel": 0, "fontSize": 6}}),
            json!({"title": {"fontFamily": "x".repeat(65)}}),
            json!({"subtitle": {"text": "\u{1F600}".repeat(600)}}),
            json!({"border": {"color": "#ABCDEF", "show": true}, "shadow": {"show": true}}),
        ];
        assert_eq!(table.len(), 30);
        for (i, input) in table.into_iter().enumerate() {
            let c = parse(input.clone());
            if let Some(s) = c.sanitized() {
                assert!(s.validate().is_ok(), "row {i}: {input} -> {:?}", s.validate());
                assert!(!s.is_empty(), "row {i}: sanitized must not return an empty container");
                // Idempotent: sanitizing again changes nothing.
                assert_eq!(s.clone().sanitized(), Some(s), "row {i}");
            }
        }
    }

    #[test]
    fn sanitized_output_always_validates_for_generated_inputs() {
        // A small deterministic LCG: no dev-dependency for randomness.
        let mut seed: u64 = 0x5eed_1234_abcd_0001;
        let mut next = move || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            seed >> 33
        };
        let strings = ["", "#fff", "red", "#12345", "Segoe UI", "a;b", "url(x)", "#AABBCCDD", "left", "x"];
        for round in 0..500 {
            let mut root = json!({});
            for (pointer, ty) in FIELD_POINTERS {
                if next() % 3 != 0 {
                    continue;
                }
                let v = match ty {
                    FieldType::Number => json!((next() % 4000) as f64 / 7.0 - 300.0),
                    FieldType::Integer => json!(next() % 256),
                    FieldType::Boolean => json!(next() % 2 == 0),
                    FieldType::Color | FieldType::Text => {
                        let s = strings[(next() % strings.len() as u64) as usize];
                        if next() % 20 == 0 { json!(s.repeat(300)) } else { json!(s) }
                    }
                    FieldType::Enum(values) => json!(values[(next() % values.len() as u64) as usize]),
                };
                set_leaf(&mut root, pointer, Some(v));
            }
            if next() % 4 == 0 {
                let n = (next() % 11) as usize;
                let stops: Vec<Value> = (0..n)
                    .map(|_| json!({"offset": (next() % 30) as f64 / 10.0 - 1.0,
                                    "color": strings[(next() % strings.len() as u64) as usize]}))
                    .collect();
                set_leaf(&mut root, "/background/gradient", Some(json!({"type": "linear", "stops": stops})));
            }
            let c = parse(root.clone());
            if let Some(s) = c.sanitized() {
                assert!(s.validate().is_ok(), "round {round}: {root} -> {:?}", s.validate());
            }
        }
    }

    // ---- with_field ----

    #[test]
    fn with_field_sets_clears_and_refuses() {
        let c = VisualContainerFormat::default()
            .with_field("/title/fontSize", json!(14))
            .unwrap();
        assert_eq!(c.title.as_ref().unwrap().style.font_size, Some(14.0));
        let c = c.with_field("/title/bold", json!(true)).unwrap();
        let c = c.with_field("/lockAspect", json!(true)).unwrap();
        assert_eq!(c.lock_aspect, Some(true));
        // Null clears one leaf and leaves its siblings.
        let c = c.with_field("/title/fontSize", Value::Null).unwrap();
        let t = c.title.as_ref().unwrap();
        assert_eq!((t.style.font_size, t.style.bold), (None, Some(true)));
        // Clearing the last leaf drops the sub-struct.
        let c = c.with_field("/title/bold", Value::Null).unwrap();
        assert_eq!(c.title, None);
        let c = c.with_field("/lockAspect", Value::Null).unwrap();
        assert!(c.is_empty());
        assert_eq!(serde_json::to_string(&c).unwrap(), "{}");
        // Clearing an absent leaf is fine and changes nothing.
        assert_eq!(c.clone().with_field("/shadow/blur", Value::Null).unwrap(), c);

        // Unknown pointers.
        let e = VisualContainerFormat::default().with_field("/title/nope", json!(1)).unwrap_err();
        assert_eq!(e, "/title/nope is not a visual container field.");
        assert!(VisualContainerFormat::default().with_field("/title", json!({})).is_err());
        assert!(VisualContainerFormat::default().with_field("/background/gradient", json!({})).is_err());
        assert!(VisualContainerFormat::default().with_field("title/fontSize", json!(14)).is_err());
        // Bad values.
        assert_eq!(
            VisualContainerFormat::default().with_field("/title/fontSize", json!(200)).unwrap_err(),
            "title.fontSize must be a number from 6 to 96."
        );
        assert!(VisualContainerFormat::default().with_field("/title/fontSize", json!("14")).is_err());
        assert!(VisualContainerFormat::default().with_field("/border/color", json!("red")).is_err());
        assert!(VisualContainerFormat::default().with_field("/border/show", json!("true")).is_err());
        assert!(VisualContainerFormat::default().with_field("/title/align", json!("justify")).is_err());
        assert!(VisualContainerFormat::default().with_field("/title/headingLevel", json!(2.5)).is_err());
        // A whole number written as 3.0 is stored as the integer 3.
        let h = VisualContainerFormat::default().with_field("/title/headingLevel", json!(3.0)).unwrap();
        assert_eq!(h.title.unwrap().heading_level, Some(3));
    }

    #[test]
    fn with_field_keeps_every_other_leaf_and_the_gradient() {
        let c = parse(json!({"border": {"radius": 8}, "background": {"color": "#fff", "gradient": {
            "type": "linear", "stops": [{"offset": 0, "color": "#000"}, {"offset": 1, "color": "#fff"}]}}}));
        let d = c.clone().with_field("/background/transparency", json!(30)).unwrap();
        assert_eq!(d.border, c.border);
        let bg = d.background.unwrap();
        assert_eq!(bg.transparency, Some(30.0));
        assert_eq!(bg.color.as_deref(), Some("#fff"));
        assert_eq!(bg.gradient, c.background.unwrap().gradient);
    }

    #[test]
    fn every_field_pointer_is_a_real_serde_leaf() {
        // Writing a sample through with_field and reading it back at the same
        // pointer proves FIELD_POINTERS spells exactly what serde writes.
        for (pointer, ty) in FIELD_POINTERS {
            let v = sample(pointer, *ty);
            let c = VisualContainerFormat::default().with_field(pointer, v.clone()).unwrap();
            let out = serde_json::to_value(&c).unwrap();
            let got = out.pointer(pointer).unwrap_or_else(|| panic!("{pointer} not written: {out}"));
            match ty {
                FieldType::Number | FieldType::Integer => assert_eq!(got.as_f64(), v.as_f64(), "{pointer}"),
                _ => assert_eq!(got, &v, "{pointer}"),
            }
            assert!(c.validate().is_ok(), "{pointer}");
            assert!(!c.is_empty(), "{pointer}");
        }
    }

    // ---- charts ----

    #[test]
    fn forbid_chart_title_leaves_refuses_text_colour_and_size() {
        for (leaf, value) in [("/title/text", json!("Sales")), ("/title/color", json!("#000")), ("/title/fontSize", json!(14))] {
            let c = VisualContainerFormat::default().with_field(leaf, value).unwrap();
            assert!(c.forbid_chart_title_leaves().is_err(), "{leaf}");
        }
        let fine = parse(json!({"title": {"show": true, "bold": true, "align": "left", "headingLevel": 2}}));
        assert!(fine.forbid_chart_title_leaves().is_ok());
        assert!(VisualContainerFormat::default().forbid_chart_title_leaves().is_ok());
        assert!(parse(json!({"subtitle": {"text": "x", "color": "#000", "fontSize": 9}}))
            .forbid_chart_title_leaves()
            .is_ok());
    }

    // ---- controls ----

    #[test]
    fn check_control_container_value_table() {
        let cases: &[(&str, &str, bool)] = &[
            // not ours
            ("fill", "red", true),
            ("textColor", "anything", true),
            ("containerNope", "x", true),
            // empty = the family default, for every key
            ("containerTitleFontSize", "", true),
            ("containerTitleBold", "", true),
            // number
            ("containerTitleFontSize", "14", true),
            ("containerTitleFontSize", "14.5", true),
            ("containerTitleFontSize", "6", true),
            ("containerTitleFontSize", "96", true),
            ("containerTitleFontSize", "5", false),
            ("containerTitleFontSize", "97", false),
            ("containerTitleFontSize", "abc", false),
            ("containerTitleFontSize", " 14", false),
            ("containerTitleFontSize", "inf", false),
            ("containerTitleFontSize", "NaN", false),
            ("containerTitleFontSize", "0x10", false),
            ("containerPaddingTop", "0", true),
            ("containerPaddingTop", "1e2", true),
            ("containerPaddingTop", "-1", false),
            ("containerPaddingLeft", "200", true),
            ("containerPaddingLeft", "201", false),
            ("containerBorderRadius", "12", true),
            ("containerBorderRadius", "101", false),
            ("containerShadowBlur", "50", true),
            ("containerShadowDistance", "51", false),
            ("containerBackgroundTransparency", "100", true),
            ("containerBackgroundTransparency", "100.1", false),
            // integer
            ("containerTitleHeadingLevel", "3", true),
            ("containerTitleHeadingLevel", "3.0", true),
            ("containerTitleHeadingLevel", "3.5", false),
            ("containerTitleHeadingLevel", "7", false),
            // boolean
            ("containerTitleShow", "true", true),
            ("containerLockAspect", "false", true),
            ("containerTitleShow", "TRUE", false),
            ("containerTitleShow", "1", false),
            ("containerBorderShow", "yes", false),
            // colour
            ("containerTitleColor", "#fff", true),
            ("containerBackgroundColor", "#11223344", true),
            ("containerBorderColor", "red", false),
            ("containerShadowColor", "url(x)", false),
            ("containerDividerColor", "#12345", false),
            // text
            ("containerTitleText", "Revenue", true),
            ("containerSubtitleText", &"x".repeat(1024), true),
            ("containerSubtitleText", &"x".repeat(1025), false),
            ("containerTitleFontFamily", "Segoe UI", true),
            ("containerTitleFontFamily", "Arial;x", false),
            // enum
            ("containerTitleAlign", "center", true),
            ("containerTitleAlign", "Center", false),
            ("containerDividerStyle", "dashed", true),
            ("containerDividerStyle", "double", false),
            ("containerShadowOffset", "inside", true),
            ("containerShadowPosition", "bottomRight", true),
            ("containerShadowPosition", "middle", false),
        ];
        for (key, value, ok) in cases {
            let got = check_control_container_value(key, value);
            assert_eq!(got.is_ok(), *ok, "{key} = {value:?} -> {got:?}");
        }
        assert_eq!(
            check_control_container_value("containerTitleFontSize", "97"),
            Err("containerTitleFontSize must be a number from 6 to 96.".into())
        );
        assert_eq!(
            check_control_container_value("containerTitleShow", "1"),
            Err("containerTitleShow must be true or false.".into())
        );
    }

    // ---- the tables themselves ----

    #[test]
    fn field_pointers_are_unique_and_are_the_ts_field_ids_in_order() {
        let mut seen = std::collections::HashSet::new();
        for (p, _) in FIELD_POINTERS {
            assert!(seen.insert(*p), "duplicate pointer {p}");
            assert!(p.starts_with('/'), "{p}");
        }
        let ids: Vec<String> = FIELD_POINTERS.iter().map(|(p, _)| field_id(p)).collect();
        assert_eq!(ids, TS_FIELD_IDS.to_vec());
        assert!(field_type("/background/gradient").is_none());
    }

    #[test]
    fn every_numeric_field_has_a_range_and_nothing_else_does() {
        for (p, ty) in FIELD_POINTERS {
            let numeric = matches!(ty, FieldType::Number | FieldType::Integer);
            assert_eq!(field_range(p).is_some(), numeric, "{p}");
        }
        assert_eq!(field_type("/title/headingLevel"), Some(FieldType::Integer));
        assert_eq!(field_range("/title/headingLevel"), Some((0.0, 6.0)));
    }

    #[test]
    fn enum_fields_list_exactly_what_serde_writes_for_the_rust_enums() {
        fn names<T: Serialize>(all: &[T]) -> Vec<String> {
            all.iter().map(|v| serde_json::to_value(v).unwrap().as_str().unwrap().to_string()).collect()
        }
        let expect = |pointer: &str, want: Vec<String>| match field_type(pointer) {
            Some(FieldType::Enum(values)) => assert_eq!(values.iter().map(|s| s.to_string()).collect::<Vec<_>>(), want, "{pointer}"),
            other => panic!("{pointer}: {other:?}"),
        };
        use VisualShadowPosition as P;
        let align = names(&[VisualTextAlign::Left, VisualTextAlign::Center, VisualTextAlign::Right]);
        expect("/title/align", align.clone());
        expect("/subtitle/align", align);
        expect("/divider/style", names(&[VisualLineStyle::Solid, VisualLineStyle::Dashed, VisualLineStyle::Dotted]));
        expect("/shadow/offset", names(&[VisualShadowOffset::Outside, VisualShadowOffset::Inside]));
        expect("/shadow/position", names(&[P::BottomRight, P::Bottom, P::BottomLeft, P::Right, P::Center, P::Left, P::TopRight, P::Top, P::TopLeft]));
        let enum_count = FIELD_POINTERS.iter().filter(|(_, t)| matches!(t, FieldType::Enum(_))).count();
        assert_eq!(enum_count, 5);
    }

    #[test]
    fn control_keys_are_container_plus_pascal_case_index_for_index() {
        fn pascal(pointer: &str) -> String {
            let mut out = String::from("container");
            for seg in pointer.trim_start_matches('/').split('/') {
                let mut chars = seg.chars();
                if let Some(first) = chars.next() {
                    out.extend(first.to_uppercase());
                    out.push_str(chars.as_str());
                }
            }
            out
        }
        assert_eq!(CONTROL_CONTAINER_PROPERTY_KEYS.len(), FIELD_POINTERS.len());
        let mut seen = std::collections::HashSet::new();
        for (i, (p, _)) in FIELD_POINTERS.iter().enumerate() {
            assert_eq!(CONTROL_CONTAINER_PROPERTY_KEYS[i], pascal(p), "row {i}");
            assert!(seen.insert(CONTROL_CONTAINER_PROPERTY_KEYS[i]));
            assert_eq!(control_container_key_pointer(CONTROL_CONTAINER_PROPERTY_KEYS[i]), Some(*p));
        }
        // The existing control keys a field can map to are NOT container keys.
        for existing in ["fill", "stroke", "strokeWidth", "borderColor", "padding"] {
            assert!(!CONTROL_CONTAINER_PROPERTY_KEYS.contains(&existing), "{existing}");
            assert_eq!(control_container_key_pointer(existing), None);
        }
    }

    #[test]
    fn js_number_prints_limits_like_javascript() {
        assert_eq!(js_number(6.0), "6");
        assert_eq!(js_number(0.0), "0");
        assert_eq!(js_number(96.0), "96");
        assert_eq!(js_number(0.5), "0.5");
    }

    #[test]
    fn wire_names_match_wp_d() {
        assert_eq!(FieldType::Number.wire_name(), "number");
        assert_eq!(FieldType::Integer.wire_name(), "integer");
        assert_eq!(FieldType::Boolean.wire_name(), "boolean");
        assert_eq!(FieldType::Color.wire_name(), "color");
        assert_eq!(FieldType::Text.wire_name(), "text");
        assert_eq!(FieldType::Enum(&[]).wire_name(), "enum");
    }

    // ---- the lenient LOAD path ----

    #[test]
    fn lenient_load_repairs_what_a_typed_read_refuses() {
        // Each of these fails a typed from_value (and would drop its record).
        for (bad, why) in [
            (json!({"title": {"headingLevel": 300, "bold": true}}), "u8 overflow"),
            (json!({"title": {"headingLevel": -1, "bold": true}}), "negative u8"),
            (json!({"title": {"headingLevel": 2.5, "bold": true}}), "fractional u8"),
            (json!({"title": {"bold": "yes", "italic": true}}), "wrong JSON type"),
            (json!({"border": {"radius": "8", "width": 2}}), "number as text"),
            (json!({"shadow": {"position": "middle", "blur": 4}}), "unknown enum"),
            (json!({"background": {"gradient": {"type": "linear"}, "color": "#fff"}}), "gradient without stops"),
        ] {
            assert!(serde_json::from_value::<VisualContainerFormat>(bad.clone()).is_err(), "{why}: typed read accepts it");
            let c = VisualContainerFormat::from_value_lenient(&bad).unwrap_or_else(|| panic!("{why}: nothing kept"));
            assert!(c.validate().is_ok(), "{why}");
        }
        let c = VisualContainerFormat::from_value_lenient(&json!({"title": {"headingLevel": 300, "bold": true}})).unwrap();
        assert_eq!(c.title.as_ref().unwrap().heading_level, Some(6));
        let c = VisualContainerFormat::from_value_lenient(&json!({"title": {"headingLevel": 2.5}})).unwrap();
        assert_eq!(c.title.as_ref().unwrap().heading_level, Some(3));
        let c = VisualContainerFormat::from_value_lenient(&json!({"title": {"bold": "yes", "italic": true}})).unwrap();
        assert_eq!((c.title.as_ref().unwrap().style.bold, c.title.as_ref().unwrap().style.italic), (None, Some(true)));
        let c = VisualContainerFormat::from_value_lenient(
            &json!({"background": {"gradient": {"type": "linear"}, "color": "#fff"}}),
        )
        .unwrap();
        assert_eq!(c.background.as_ref().unwrap().gradient, None);
        // Nothing usable -> None; not an object -> None.
        assert_eq!(VisualContainerFormat::from_value_lenient(&json!({"title": {"bold": "yes"}})), None);
        assert_eq!(VisualContainerFormat::from_value_lenient(&json!("x")), None);
        assert_eq!(VisualContainerFormat::from_value_lenient(&json!({"nope": 1})), None);
    }

    #[test]
    fn lenient_load_keeps_a_valid_container_exactly() {
        let input = json!({
            "padding": {"top": 4, "left": 10}, "lockAspect": true,
            "title": {"show": true, "headingLevel": 2, "fontFamily": "Segoe UI", "align": "center"},
            "background": {"color": "#fff", "transparency": 20, "gradient": {"type": "radial",
                "stops": [{"offset": 0, "color": "#000"}, {"offset": 1, "color": "#ffffff"}]}},
            "border": {"radius": 12}, "shadow": {"position": "topLeft", "offset": "inside"}
        });
        let typed: VisualContainerFormat = serde_json::from_value(input.clone()).unwrap();
        assert_eq!(VisualContainerFormat::from_value_lenient(&input), Some(typed));
    }

    #[test]
    fn the_lenient_serde_reader_turns_an_unreadable_container_into_none() {
        #[derive(Deserialize)]
        struct Record {
            name: String,
            #[serde(default, deserialize_with = "deserialize_container_lenient")]
            container: Option<VisualContainerFormat>,
        }
        let r: Record = serde_json::from_value(json!({"name": "a", "container": {"title": {"headingLevel": 999}}})).unwrap();
        assert_eq!(r.name, "a");
        assert_eq!(r.container.unwrap().title.unwrap().heading_level, Some(6));
        let r: Record = serde_json::from_value(json!({"name": "b", "container": 42})).unwrap();
        assert_eq!(r.container, None);
        let r: Record = serde_json::from_value(json!({"name": "c", "container": null})).unwrap();
        assert_eq!(r.container, None);
        let r: Record = serde_json::from_value(json!({"name": "d"})).unwrap();
        assert_eq!(r.container, None);
        let r: Record = serde_json::from_value(json!({"name": "e", "container": {}})).unwrap();
        assert_eq!(r.container, None, "an empty container is no container");
    }
}
