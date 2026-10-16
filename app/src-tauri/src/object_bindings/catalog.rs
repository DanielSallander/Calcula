//! FILENAME: app/src-tauri/src/object_bindings/catalog.rs
// PURPOSE: THE BINDABLE-PATH CATALOG -- which property of which kind of object
//          may carry a binding, what type its value has, and which of the
//          family's own literal gates (sheet protection, Lock Objects) a
//          binding on it must pass.
// CONTEXT: Rust is the AUTHORITY. The TS mirror is
//          `app/src/api/objectBindings/catalog.ts`, and a drift test parses
//          `BINDABLE_PATHS` below line by line and diffs it both ways -- which is
//          why the table is written ONE ROW PER LINE in exactly one spelling.
//          WP-C (the format container) plugs in with `O::Container` rows and
//          typed `O::Family` control rows for its container keys (S7b); their
//          literal door is `container_literal.rs`.
//
// Never-bindable control keys are DERIVED from the controls.rs constants, never
// re-typed: code (`EXECUTABLE_CONTROL_PROPERTIES`), the held compartment
// (`HELD_CONTROL_PROPERTIES`), a button's action wiring
// (`BUTTON_ACTION_PROPERTIES`), placement (`POSITION_SIZE_PROPERTIES` minus
// width/height, `PIN_TO_GRID_PROPERTY`) and identity.

use crate::api_types::ObjectBindingKind;
use crate::controls;

/// The type a bound property's resolved value is coerced to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindableValueType {
    Text,
    Number,
    Integer,
    Boolean,
    Color,
    /// A `media:{sha256}` handle that exists in the document -- a binding may
    /// REFERENCE media, never introduce bytes.
    Media,
    /// number | text | bool, whatever the formula returns (chart param values)
    Scalar,
    Enum(&'static [&'static str]),
}

impl BindableValueType {
    /// The type's name as the TS mirror spells it ("text", "enum"...).
    pub fn wire_name(self) -> &'static str {
        match self {
            BindableValueType::Text => "text",
            BindableValueType::Number => "number",
            BindableValueType::Integer => "integer",
            BindableValueType::Boolean => "boolean",
            BindableValueType::Color => "color",
            BindableValueType::Media => "media",
            BindableValueType::Scalar => "scalar",
            BindableValueType::Enum(_) => "enum",
        }
    }
}

/// Where a row comes from: the object family's own record, or the shared
/// visual container (WP-C).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindableOrigin {
    Family,
    Container,
}

/// One bindable path.
#[derive(Debug, Clone, Copy)]
pub struct BindablePathSpec {
    pub kind: ObjectBindingKind,
    /// RFC 6901 pointer pattern; a `*` segment matches one segment (an array
    /// index for arrays, any key for maps). `~0`/`~1` escaping per RFC 6901.
    pub pointer: &'static str,
    pub value_type: BindableValueType,
    pub origin: BindableOrigin,
    /// The family's LITERAL write of this path is refused on a sheet whose
    /// protection disallows `editObjects` (chart_commands.rs `update_chart_core`
    /// for every chart edit; controls.rs `GEOMETRY_PROPERTIES`;
    /// floating_range.rs `ensure_host_objects_editable`; sheets.rs
    /// `set_canvas_layout_inner`). `Set` and `Clear` apply the same gate.
    pub protect_edit_objects: bool,
    /// The family's literal write of this path is refused on a canvas whose
    /// Lock Objects is on (controls.rs `POSITION_SIZE_PROPERTIES`, narrower than
    /// the protection set: rotation and flips stay editable on a locked page).
    pub lock_objects_position: bool,
}

/// The row constructor the table below is written in. `const` so the table is
/// a `const` and the drift parsers read one spelling.
pub const fn row(
    kind: ObjectBindingKind,
    pointer: &'static str,
    value_type: BindableValueType,
    origin: BindableOrigin,
    protect_edit_objects: bool,
    lock_objects_position: bool,
) -> BindablePathSpec {
    BindablePathSpec { kind, pointer, value_type, origin, protect_edit_objects, lock_objects_position }
}

use BindableOrigin as O;
use BindableValueType as T;
use ObjectBindingKind as K;

/// ONE ROW PER LINE, exactly this spelling -- the TS drift test parses it:
/// `row(K::<Kind>, "<pointer>", T::<Type>, O::<Origin>, <protect>, <lock>),`
/// with an enum type spelled `T::Enum(&["a", "b"])`.
///
/// Flags are not free choices: `row_flags_match_the_family_gates` pins every
/// control row against `GEOMETRY_PROPERTIES` / `POSITION_SIZE_PROPERTIES`, and
/// every chart, floating-range and canvas-page row to `protect = true`.
///
/// The VISUAL CONTAINER rows (WP-C, D-FORMAT) are generated from
/// `visual_format::FIELD_POINTERS` and pinned both ways by
/// `container_rows_are_the_field_table` (catalog_tests.rs):
/// - `O::Container` rows: every field under the kind's [`container_root`],
///   minus the never-bindable `lockAspect` and the fields that live elsewhere --
///   a chart's title text / colour / size are `/spec/title` and
///   `/spec/config/theme/titleColor|titleFontSize`; a slicer's and a timeline's
///   title text / visibility are `/headerText` / `/showHeader`; a floating
///   range's title text and visibility are its identity and its move handle,
///   and its padding is never bound. Flags mirror each family's door: chart and
///   floating range pass `editObjects` (protect), none is a position key.
/// - `O::Family` control rows `/properties/container*`: one EXACT row per
///   `visual_format::CONTROL_CONTAINER_PROPERTY_KEYS` key but
///   `containerLockAspect` -- a control's container facts ARE control
///   properties, written by the control arm through `set_control_property_core`.
///
/// The Page Navigator's per-button rows (`/properties/pageOverrides/*/...`,
/// WP-D S8d, D §3.18a) are keyed by PAGE, never by array index: the `*` is a
/// page key (a SheetId, or `name:<sheet name>`). Their literal and overlay live
/// in `page_overrides.rs`; `/properties/pageOverrides` itself and the
/// `sheetId` / `sheetName` fields are refused by [`match_path`] by name.
pub const BINDABLE_PATHS: &[BindablePathSpec] = &[
    row(K::Chart, "/spec/title", T::Text, O::Family, true, false),
    row(K::Chart, "/spec/xAxis/title", T::Text, O::Family, true, false),
    row(K::Chart, "/spec/yAxis/title", T::Text, O::Family, true, false),
    row(K::Chart, "/spec/xAxis/min", T::Number, O::Family, true, false),
    row(K::Chart, "/spec/xAxis/max", T::Number, O::Family, true, false),
    row(K::Chart, "/spec/yAxis/min", T::Number, O::Family, true, false),
    row(K::Chart, "/spec/yAxis/max", T::Number, O::Family, true, false),
    row(K::Chart, "/spec/series/*/name", T::Text, O::Family, true, false),
    row(K::Chart, "/spec/seriesColors/*", T::Color, O::Family, true, false),
    row(K::Chart, "/spec/params/*/value", T::Scalar, O::Family, true, false),
    row(K::Chart, "/spec/markOptions/goal", T::Number, O::Family, true, false),
    row(K::Chart, "/spec/markOptions/min", T::Number, O::Family, true, false),
    row(K::Chart, "/spec/markOptions/max", T::Number, O::Family, true, false),
    row(K::Chart, "/spec/markOptions/target", T::Number, O::Family, true, false),
    row(K::Chart, "/spec/markOptions/calloutFontSize", T::Number, O::Family, true, false),
    row(K::Chart, "/spec/markOptions/decimals", T::Integer, O::Family, true, false),
    row(K::Chart, "/spec/markOptions/displayUnits", T::Enum(&["auto", "none", "thousands", "millions", "billions", "trillions"]), O::Family, true, false),
    row(K::Chart, "/spec/markOptions/goodColor", T::Color, O::Family, true, false),
    row(K::Chart, "/spec/markOptions/badColor", T::Color, O::Family, true, false),
    row(K::Chart, "/spec/markOptions/neutralColor", T::Color, O::Family, true, false),
    row(K::Chart, "/spec/markOptions/trackColor", T::Color, O::Family, true, false),
    row(K::Chart, "/spec/markOptions/targetColor", T::Color, O::Family, true, false),
    row(K::Chart, "/spec/config/theme/plotBackground", T::Color, O::Family, true, false),
    row(K::Chart, "/spec/config/theme/gridLineColor", T::Color, O::Family, true, false),
    row(K::Chart, "/spec/config/theme/axisColor", T::Color, O::Family, true, false),
    row(K::Chart, "/spec/config/theme/axisLabelColor", T::Color, O::Family, true, false),
    row(K::Chart, "/spec/config/theme/axisTitleColor", T::Color, O::Family, true, false),
    row(K::Chart, "/spec/config/theme/titleColor", T::Color, O::Family, true, false),
    row(K::Chart, "/spec/config/theme/legendTextColor", T::Color, O::Family, true, false),
    row(K::Chart, "/spec/config/theme/titleFontSize", T::Number, O::Family, true, false),
    row(K::Chart, "/spec/config/theme/axisTitleFontSize", T::Number, O::Family, true, false),
    row(K::Chart, "/spec/config/theme/labelFontSize", T::Number, O::Family, true, false),
    row(K::Chart, "/spec/config/theme/legendFontSize", T::Number, O::Family, true, false),
    row(K::Chart, "/spec/container/padding/top", T::Number, O::Container, true, false),
    row(K::Chart, "/spec/container/padding/right", T::Number, O::Container, true, false),
    row(K::Chart, "/spec/container/padding/bottom", T::Number, O::Container, true, false),
    row(K::Chart, "/spec/container/padding/left", T::Number, O::Container, true, false),
    row(K::Chart, "/spec/container/title/show", T::Boolean, O::Container, true, false),
    row(K::Chart, "/spec/container/title/headingLevel", T::Integer, O::Container, true, false),
    row(K::Chart, "/spec/container/title/fontFamily", T::Text, O::Container, true, false),
    row(K::Chart, "/spec/container/title/bold", T::Boolean, O::Container, true, false),
    row(K::Chart, "/spec/container/title/italic", T::Boolean, O::Container, true, false),
    row(K::Chart, "/spec/container/title/underline", T::Boolean, O::Container, true, false),
    row(K::Chart, "/spec/container/title/background", T::Color, O::Container, true, false),
    row(K::Chart, "/spec/container/title/align", T::Enum(&["left", "center", "right"]), O::Container, true, false),
    row(K::Chart, "/spec/container/title/wrap", T::Boolean, O::Container, true, false),
    row(K::Chart, "/spec/container/subtitle/show", T::Boolean, O::Container, true, false),
    row(K::Chart, "/spec/container/subtitle/text", T::Text, O::Container, true, false),
    row(K::Chart, "/spec/container/subtitle/fontFamily", T::Text, O::Container, true, false),
    row(K::Chart, "/spec/container/subtitle/fontSize", T::Number, O::Container, true, false),
    row(K::Chart, "/spec/container/subtitle/bold", T::Boolean, O::Container, true, false),
    row(K::Chart, "/spec/container/subtitle/italic", T::Boolean, O::Container, true, false),
    row(K::Chart, "/spec/container/subtitle/underline", T::Boolean, O::Container, true, false),
    row(K::Chart, "/spec/container/subtitle/color", T::Color, O::Container, true, false),
    row(K::Chart, "/spec/container/subtitle/background", T::Color, O::Container, true, false),
    row(K::Chart, "/spec/container/subtitle/align", T::Enum(&["left", "center", "right"]), O::Container, true, false),
    row(K::Chart, "/spec/container/subtitle/wrap", T::Boolean, O::Container, true, false),
    row(K::Chart, "/spec/container/divider/show", T::Boolean, O::Container, true, false),
    row(K::Chart, "/spec/container/divider/color", T::Color, O::Container, true, false),
    row(K::Chart, "/spec/container/divider/style", T::Enum(&["solid", "dashed", "dotted"]), O::Container, true, false),
    row(K::Chart, "/spec/container/divider/width", T::Number, O::Container, true, false),
    row(K::Chart, "/spec/container/divider/ignorePadding", T::Boolean, O::Container, true, false),
    row(K::Chart, "/spec/container/spacing/custom", T::Boolean, O::Container, true, false),
    row(K::Chart, "/spec/container/spacing/belowTitle", T::Number, O::Container, true, false),
    row(K::Chart, "/spec/container/spacing/belowSubtitle", T::Number, O::Container, true, false),
    row(K::Chart, "/spec/container/spacing/belowDivider", T::Number, O::Container, true, false),
    row(K::Chart, "/spec/container/background/show", T::Boolean, O::Container, true, false),
    row(K::Chart, "/spec/container/background/color", T::Color, O::Container, true, false),
    row(K::Chart, "/spec/container/background/transparency", T::Number, O::Container, true, false),
    row(K::Chart, "/spec/container/border/show", T::Boolean, O::Container, true, false),
    row(K::Chart, "/spec/container/border/color", T::Color, O::Container, true, false),
    row(K::Chart, "/spec/container/border/width", T::Number, O::Container, true, false),
    row(K::Chart, "/spec/container/border/radius", T::Number, O::Container, true, false),
    row(K::Chart, "/spec/container/shadow/show", T::Boolean, O::Container, true, false),
    row(K::Chart, "/spec/container/shadow/color", T::Color, O::Container, true, false),
    row(K::Chart, "/spec/container/shadow/transparency", T::Number, O::Container, true, false),
    row(K::Chart, "/spec/container/shadow/offset", T::Enum(&["outside", "inside"]), O::Container, true, false),
    row(K::Chart, "/spec/container/shadow/position", T::Enum(&["bottomRight", "bottom", "bottomLeft", "right", "center", "left", "topRight", "top", "topLeft"]), O::Container, true, false),
    row(K::Chart, "/spec/container/shadow/blur", T::Number, O::Container, true, false),
    row(K::Chart, "/spec/container/shadow/distance", T::Number, O::Container, true, false),
    row(K::Control, "/properties/text", T::Text, O::Family, false, false),
    row(K::Control, "/properties/tooltip", T::Text, O::Family, false, false),
    row(K::Control, "/properties/fill", T::Color, O::Family, false, false),
    row(K::Control, "/properties/color", T::Color, O::Family, false, false),
    row(K::Control, "/properties/borderColor", T::Color, O::Family, false, false),
    row(K::Control, "/properties/stroke", T::Color, O::Family, false, false),
    row(K::Control, "/properties/textColor", T::Color, O::Family, false, false),
    row(K::Control, "/properties/selectedFill", T::Color, O::Family, false, false),
    row(K::Control, "/properties/selectedColor", T::Color, O::Family, false, false),
    row(K::Control, "/properties/fontSize", T::Number, O::Family, false, false),
    row(K::Control, "/properties/strokeWidth", T::Number, O::Family, false, false),
    row(K::Control, "/properties/opacity", T::Number, O::Family, false, false),
    row(K::Control, "/properties/gap", T::Number, O::Family, false, false),
    row(K::Control, "/properties/padding", T::Number, O::Family, false, false),
    row(K::Control, "/properties/rotation", T::Number, O::Family, true, false),
    row(K::Control, "/properties/fontBold", T::Boolean, O::Family, false, false),
    row(K::Control, "/properties/fontItalic", T::Boolean, O::Family, false, false),
    row(K::Control, "/properties/showHiddenPages", T::Boolean, O::Family, false, false),
    row(K::Control, "/properties/showTooltipPages", T::Boolean, O::Family, false, false),
    row(K::Control, "/properties/flipH", T::Boolean, O::Family, true, false),
    row(K::Control, "/properties/flipV", T::Boolean, O::Family, true, false),
    row(K::Control, "/properties/textAlign", T::Enum(&["left", "center", "right"]), O::Family, false, false),
    row(K::Control, "/properties/orientation", T::Enum(&["horizontal", "vertical"]), O::Family, false, false),
    row(K::Control, "/properties/src", T::Media, O::Family, false, false),
    row(K::Control, "/properties/width", T::Number, O::Family, true, true),
    row(K::Control, "/properties/height", T::Number, O::Family, true, true),
    row(K::Control, "/properties/containerPaddingTop", T::Number, O::Family, false, false),
    row(K::Control, "/properties/containerPaddingRight", T::Number, O::Family, false, false),
    row(K::Control, "/properties/containerPaddingBottom", T::Number, O::Family, false, false),
    row(K::Control, "/properties/containerPaddingLeft", T::Number, O::Family, false, false),
    row(K::Control, "/properties/containerTitleShow", T::Boolean, O::Family, false, false),
    row(K::Control, "/properties/containerTitleText", T::Text, O::Family, false, false),
    row(K::Control, "/properties/containerTitleHeadingLevel", T::Integer, O::Family, false, false),
    row(K::Control, "/properties/containerTitleFontFamily", T::Text, O::Family, false, false),
    row(K::Control, "/properties/containerTitleFontSize", T::Number, O::Family, false, false),
    row(K::Control, "/properties/containerTitleBold", T::Boolean, O::Family, false, false),
    row(K::Control, "/properties/containerTitleItalic", T::Boolean, O::Family, false, false),
    row(K::Control, "/properties/containerTitleUnderline", T::Boolean, O::Family, false, false),
    row(K::Control, "/properties/containerTitleColor", T::Color, O::Family, false, false),
    row(K::Control, "/properties/containerTitleBackground", T::Color, O::Family, false, false),
    row(K::Control, "/properties/containerTitleAlign", T::Enum(&["left", "center", "right"]), O::Family, false, false),
    row(K::Control, "/properties/containerTitleWrap", T::Boolean, O::Family, false, false),
    row(K::Control, "/properties/containerSubtitleShow", T::Boolean, O::Family, false, false),
    row(K::Control, "/properties/containerSubtitleText", T::Text, O::Family, false, false),
    row(K::Control, "/properties/containerSubtitleFontFamily", T::Text, O::Family, false, false),
    row(K::Control, "/properties/containerSubtitleFontSize", T::Number, O::Family, false, false),
    row(K::Control, "/properties/containerSubtitleBold", T::Boolean, O::Family, false, false),
    row(K::Control, "/properties/containerSubtitleItalic", T::Boolean, O::Family, false, false),
    row(K::Control, "/properties/containerSubtitleUnderline", T::Boolean, O::Family, false, false),
    row(K::Control, "/properties/containerSubtitleColor", T::Color, O::Family, false, false),
    row(K::Control, "/properties/containerSubtitleBackground", T::Color, O::Family, false, false),
    row(K::Control, "/properties/containerSubtitleAlign", T::Enum(&["left", "center", "right"]), O::Family, false, false),
    row(K::Control, "/properties/containerSubtitleWrap", T::Boolean, O::Family, false, false),
    row(K::Control, "/properties/containerDividerShow", T::Boolean, O::Family, false, false),
    row(K::Control, "/properties/containerDividerColor", T::Color, O::Family, false, false),
    row(K::Control, "/properties/containerDividerStyle", T::Enum(&["solid", "dashed", "dotted"]), O::Family, false, false),
    row(K::Control, "/properties/containerDividerWidth", T::Number, O::Family, false, false),
    row(K::Control, "/properties/containerDividerIgnorePadding", T::Boolean, O::Family, false, false),
    row(K::Control, "/properties/containerSpacingCustom", T::Boolean, O::Family, false, false),
    row(K::Control, "/properties/containerSpacingBelowTitle", T::Number, O::Family, false, false),
    row(K::Control, "/properties/containerSpacingBelowSubtitle", T::Number, O::Family, false, false),
    row(K::Control, "/properties/containerSpacingBelowDivider", T::Number, O::Family, false, false),
    row(K::Control, "/properties/containerBackgroundShow", T::Boolean, O::Family, false, false),
    row(K::Control, "/properties/containerBackgroundColor", T::Color, O::Family, false, false),
    row(K::Control, "/properties/containerBackgroundTransparency", T::Number, O::Family, false, false),
    row(K::Control, "/properties/containerBorderShow", T::Boolean, O::Family, false, false),
    row(K::Control, "/properties/containerBorderColor", T::Color, O::Family, false, false),
    row(K::Control, "/properties/containerBorderWidth", T::Number, O::Family, false, false),
    row(K::Control, "/properties/containerBorderRadius", T::Number, O::Family, false, false),
    row(K::Control, "/properties/containerShadowShow", T::Boolean, O::Family, false, false),
    row(K::Control, "/properties/containerShadowColor", T::Color, O::Family, false, false),
    row(K::Control, "/properties/containerShadowTransparency", T::Number, O::Family, false, false),
    row(K::Control, "/properties/containerShadowOffset", T::Enum(&["outside", "inside"]), O::Family, false, false),
    row(K::Control, "/properties/containerShadowPosition", T::Enum(&["bottomRight", "bottom", "bottomLeft", "right", "center", "left", "topRight", "top", "topLeft"]), O::Family, false, false),
    row(K::Control, "/properties/containerShadowBlur", T::Number, O::Family, false, false),
    row(K::Control, "/properties/containerShadowDistance", T::Number, O::Family, false, false),
    row(K::Control, "/properties/pageOverrides/*/text", T::Text, O::Family, false, false),
    row(K::Control, "/properties/pageOverrides/*/fill", T::Color, O::Family, false, false),
    row(K::Control, "/properties/pageOverrides/*/color", T::Color, O::Family, false, false),
    row(K::Control, "/properties/pageOverrides/*/borderColor", T::Color, O::Family, false, false),
    row(K::Control, "/properties/pageOverrides/*/hidden", T::Boolean, O::Family, false, false),
    row(K::Slicer, "/headerText", T::Text, O::Family, false, false),
    row(K::Slicer, "/showHeader", T::Boolean, O::Family, false, false),
    row(K::Slicer, "/container/padding/top", T::Number, O::Container, false, false),
    row(K::Slicer, "/container/padding/right", T::Number, O::Container, false, false),
    row(K::Slicer, "/container/padding/bottom", T::Number, O::Container, false, false),
    row(K::Slicer, "/container/padding/left", T::Number, O::Container, false, false),
    row(K::Slicer, "/container/title/headingLevel", T::Integer, O::Container, false, false),
    row(K::Slicer, "/container/title/fontFamily", T::Text, O::Container, false, false),
    row(K::Slicer, "/container/title/fontSize", T::Number, O::Container, false, false),
    row(K::Slicer, "/container/title/bold", T::Boolean, O::Container, false, false),
    row(K::Slicer, "/container/title/italic", T::Boolean, O::Container, false, false),
    row(K::Slicer, "/container/title/underline", T::Boolean, O::Container, false, false),
    row(K::Slicer, "/container/title/color", T::Color, O::Container, false, false),
    row(K::Slicer, "/container/title/background", T::Color, O::Container, false, false),
    row(K::Slicer, "/container/title/align", T::Enum(&["left", "center", "right"]), O::Container, false, false),
    row(K::Slicer, "/container/title/wrap", T::Boolean, O::Container, false, false),
    row(K::Slicer, "/container/subtitle/show", T::Boolean, O::Container, false, false),
    row(K::Slicer, "/container/subtitle/text", T::Text, O::Container, false, false),
    row(K::Slicer, "/container/subtitle/fontFamily", T::Text, O::Container, false, false),
    row(K::Slicer, "/container/subtitle/fontSize", T::Number, O::Container, false, false),
    row(K::Slicer, "/container/subtitle/bold", T::Boolean, O::Container, false, false),
    row(K::Slicer, "/container/subtitle/italic", T::Boolean, O::Container, false, false),
    row(K::Slicer, "/container/subtitle/underline", T::Boolean, O::Container, false, false),
    row(K::Slicer, "/container/subtitle/color", T::Color, O::Container, false, false),
    row(K::Slicer, "/container/subtitle/background", T::Color, O::Container, false, false),
    row(K::Slicer, "/container/subtitle/align", T::Enum(&["left", "center", "right"]), O::Container, false, false),
    row(K::Slicer, "/container/subtitle/wrap", T::Boolean, O::Container, false, false),
    row(K::Slicer, "/container/divider/show", T::Boolean, O::Container, false, false),
    row(K::Slicer, "/container/divider/color", T::Color, O::Container, false, false),
    row(K::Slicer, "/container/divider/style", T::Enum(&["solid", "dashed", "dotted"]), O::Container, false, false),
    row(K::Slicer, "/container/divider/width", T::Number, O::Container, false, false),
    row(K::Slicer, "/container/divider/ignorePadding", T::Boolean, O::Container, false, false),
    row(K::Slicer, "/container/spacing/custom", T::Boolean, O::Container, false, false),
    row(K::Slicer, "/container/spacing/belowTitle", T::Number, O::Container, false, false),
    row(K::Slicer, "/container/spacing/belowSubtitle", T::Number, O::Container, false, false),
    row(K::Slicer, "/container/spacing/belowDivider", T::Number, O::Container, false, false),
    row(K::Slicer, "/container/background/show", T::Boolean, O::Container, false, false),
    row(K::Slicer, "/container/background/color", T::Color, O::Container, false, false),
    row(K::Slicer, "/container/background/transparency", T::Number, O::Container, false, false),
    row(K::Slicer, "/container/border/show", T::Boolean, O::Container, false, false),
    row(K::Slicer, "/container/border/color", T::Color, O::Container, false, false),
    row(K::Slicer, "/container/border/width", T::Number, O::Container, false, false),
    row(K::Slicer, "/container/border/radius", T::Number, O::Container, false, false),
    row(K::Slicer, "/container/shadow/show", T::Boolean, O::Container, false, false),
    row(K::Slicer, "/container/shadow/color", T::Color, O::Container, false, false),
    row(K::Slicer, "/container/shadow/transparency", T::Number, O::Container, false, false),
    row(K::Slicer, "/container/shadow/offset", T::Enum(&["outside", "inside"]), O::Container, false, false),
    row(K::Slicer, "/container/shadow/position", T::Enum(&["bottomRight", "bottom", "bottomLeft", "right", "center", "left", "topRight", "top", "topLeft"]), O::Container, false, false),
    row(K::Slicer, "/container/shadow/blur", T::Number, O::Container, false, false),
    row(K::Slicer, "/container/shadow/distance", T::Number, O::Container, false, false),
    row(K::TimelineSlicer, "/headerText", T::Text, O::Family, false, false),
    row(K::TimelineSlicer, "/showHeader", T::Boolean, O::Family, false, false),
    row(K::TimelineSlicer, "/container/padding/top", T::Number, O::Container, false, false),
    row(K::TimelineSlicer, "/container/padding/right", T::Number, O::Container, false, false),
    row(K::TimelineSlicer, "/container/padding/bottom", T::Number, O::Container, false, false),
    row(K::TimelineSlicer, "/container/padding/left", T::Number, O::Container, false, false),
    row(K::TimelineSlicer, "/container/title/headingLevel", T::Integer, O::Container, false, false),
    row(K::TimelineSlicer, "/container/title/fontFamily", T::Text, O::Container, false, false),
    row(K::TimelineSlicer, "/container/title/fontSize", T::Number, O::Container, false, false),
    row(K::TimelineSlicer, "/container/title/bold", T::Boolean, O::Container, false, false),
    row(K::TimelineSlicer, "/container/title/italic", T::Boolean, O::Container, false, false),
    row(K::TimelineSlicer, "/container/title/underline", T::Boolean, O::Container, false, false),
    row(K::TimelineSlicer, "/container/title/color", T::Color, O::Container, false, false),
    row(K::TimelineSlicer, "/container/title/background", T::Color, O::Container, false, false),
    row(K::TimelineSlicer, "/container/title/align", T::Enum(&["left", "center", "right"]), O::Container, false, false),
    row(K::TimelineSlicer, "/container/title/wrap", T::Boolean, O::Container, false, false),
    row(K::TimelineSlicer, "/container/subtitle/show", T::Boolean, O::Container, false, false),
    row(K::TimelineSlicer, "/container/subtitle/text", T::Text, O::Container, false, false),
    row(K::TimelineSlicer, "/container/subtitle/fontFamily", T::Text, O::Container, false, false),
    row(K::TimelineSlicer, "/container/subtitle/fontSize", T::Number, O::Container, false, false),
    row(K::TimelineSlicer, "/container/subtitle/bold", T::Boolean, O::Container, false, false),
    row(K::TimelineSlicer, "/container/subtitle/italic", T::Boolean, O::Container, false, false),
    row(K::TimelineSlicer, "/container/subtitle/underline", T::Boolean, O::Container, false, false),
    row(K::TimelineSlicer, "/container/subtitle/color", T::Color, O::Container, false, false),
    row(K::TimelineSlicer, "/container/subtitle/background", T::Color, O::Container, false, false),
    row(K::TimelineSlicer, "/container/subtitle/align", T::Enum(&["left", "center", "right"]), O::Container, false, false),
    row(K::TimelineSlicer, "/container/subtitle/wrap", T::Boolean, O::Container, false, false),
    row(K::TimelineSlicer, "/container/divider/show", T::Boolean, O::Container, false, false),
    row(K::TimelineSlicer, "/container/divider/color", T::Color, O::Container, false, false),
    row(K::TimelineSlicer, "/container/divider/style", T::Enum(&["solid", "dashed", "dotted"]), O::Container, false, false),
    row(K::TimelineSlicer, "/container/divider/width", T::Number, O::Container, false, false),
    row(K::TimelineSlicer, "/container/divider/ignorePadding", T::Boolean, O::Container, false, false),
    row(K::TimelineSlicer, "/container/spacing/custom", T::Boolean, O::Container, false, false),
    row(K::TimelineSlicer, "/container/spacing/belowTitle", T::Number, O::Container, false, false),
    row(K::TimelineSlicer, "/container/spacing/belowSubtitle", T::Number, O::Container, false, false),
    row(K::TimelineSlicer, "/container/spacing/belowDivider", T::Number, O::Container, false, false),
    row(K::TimelineSlicer, "/container/background/show", T::Boolean, O::Container, false, false),
    row(K::TimelineSlicer, "/container/background/color", T::Color, O::Container, false, false),
    row(K::TimelineSlicer, "/container/background/transparency", T::Number, O::Container, false, false),
    row(K::TimelineSlicer, "/container/border/show", T::Boolean, O::Container, false, false),
    row(K::TimelineSlicer, "/container/border/color", T::Color, O::Container, false, false),
    row(K::TimelineSlicer, "/container/border/width", T::Number, O::Container, false, false),
    row(K::TimelineSlicer, "/container/border/radius", T::Number, O::Container, false, false),
    row(K::TimelineSlicer, "/container/shadow/show", T::Boolean, O::Container, false, false),
    row(K::TimelineSlicer, "/container/shadow/color", T::Color, O::Container, false, false),
    row(K::TimelineSlicer, "/container/shadow/transparency", T::Number, O::Container, false, false),
    row(K::TimelineSlicer, "/container/shadow/offset", T::Enum(&["outside", "inside"]), O::Container, false, false),
    row(K::TimelineSlicer, "/container/shadow/position", T::Enum(&["bottomRight", "bottom", "bottomLeft", "right", "center", "left", "topRight", "top", "topLeft"]), O::Container, false, false),
    row(K::TimelineSlicer, "/container/shadow/blur", T::Number, O::Container, false, false),
    row(K::TimelineSlicer, "/container/shadow/distance", T::Number, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/padding/top", T::Number, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/padding/right", T::Number, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/padding/bottom", T::Number, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/padding/left", T::Number, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/title/show", T::Boolean, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/title/text", T::Text, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/title/headingLevel", T::Integer, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/title/fontFamily", T::Text, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/title/fontSize", T::Number, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/title/bold", T::Boolean, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/title/italic", T::Boolean, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/title/underline", T::Boolean, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/title/color", T::Color, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/title/background", T::Color, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/title/align", T::Enum(&["left", "center", "right"]), O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/title/wrap", T::Boolean, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/subtitle/show", T::Boolean, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/subtitle/text", T::Text, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/subtitle/fontFamily", T::Text, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/subtitle/fontSize", T::Number, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/subtitle/bold", T::Boolean, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/subtitle/italic", T::Boolean, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/subtitle/underline", T::Boolean, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/subtitle/color", T::Color, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/subtitle/background", T::Color, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/subtitle/align", T::Enum(&["left", "center", "right"]), O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/subtitle/wrap", T::Boolean, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/divider/show", T::Boolean, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/divider/color", T::Color, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/divider/style", T::Enum(&["solid", "dashed", "dotted"]), O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/divider/width", T::Number, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/divider/ignorePadding", T::Boolean, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/spacing/custom", T::Boolean, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/spacing/belowTitle", T::Number, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/spacing/belowSubtitle", T::Number, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/spacing/belowDivider", T::Number, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/background/show", T::Boolean, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/background/color", T::Color, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/background/transparency", T::Number, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/border/show", T::Boolean, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/border/color", T::Color, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/border/width", T::Number, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/border/radius", T::Number, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/shadow/show", T::Boolean, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/shadow/color", T::Color, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/shadow/transparency", T::Number, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/shadow/offset", T::Enum(&["outside", "inside"]), O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/shadow/position", T::Enum(&["bottomRight", "bottom", "bottomLeft", "right", "center", "left", "topRight", "top", "topLeft"]), O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/shadow/blur", T::Number, O::Container, false, false),
    row(K::Pivot, "/canvasFrame/container/shadow/distance", T::Number, O::Container, false, false),
    row(K::FloatingRange, "/container/title/headingLevel", T::Integer, O::Container, true, false),
    row(K::FloatingRange, "/container/title/fontFamily", T::Text, O::Container, true, false),
    row(K::FloatingRange, "/container/title/fontSize", T::Number, O::Container, true, false),
    row(K::FloatingRange, "/container/title/bold", T::Boolean, O::Container, true, false),
    row(K::FloatingRange, "/container/title/italic", T::Boolean, O::Container, true, false),
    row(K::FloatingRange, "/container/title/underline", T::Boolean, O::Container, true, false),
    row(K::FloatingRange, "/container/title/color", T::Color, O::Container, true, false),
    row(K::FloatingRange, "/container/title/background", T::Color, O::Container, true, false),
    row(K::FloatingRange, "/container/title/align", T::Enum(&["left", "center", "right"]), O::Container, true, false),
    row(K::FloatingRange, "/container/title/wrap", T::Boolean, O::Container, true, false),
    row(K::FloatingRange, "/container/subtitle/show", T::Boolean, O::Container, true, false),
    row(K::FloatingRange, "/container/subtitle/text", T::Text, O::Container, true, false),
    row(K::FloatingRange, "/container/subtitle/fontFamily", T::Text, O::Container, true, false),
    row(K::FloatingRange, "/container/subtitle/fontSize", T::Number, O::Container, true, false),
    row(K::FloatingRange, "/container/subtitle/bold", T::Boolean, O::Container, true, false),
    row(K::FloatingRange, "/container/subtitle/italic", T::Boolean, O::Container, true, false),
    row(K::FloatingRange, "/container/subtitle/underline", T::Boolean, O::Container, true, false),
    row(K::FloatingRange, "/container/subtitle/color", T::Color, O::Container, true, false),
    row(K::FloatingRange, "/container/subtitle/background", T::Color, O::Container, true, false),
    row(K::FloatingRange, "/container/subtitle/align", T::Enum(&["left", "center", "right"]), O::Container, true, false),
    row(K::FloatingRange, "/container/subtitle/wrap", T::Boolean, O::Container, true, false),
    row(K::FloatingRange, "/container/divider/show", T::Boolean, O::Container, true, false),
    row(K::FloatingRange, "/container/divider/color", T::Color, O::Container, true, false),
    row(K::FloatingRange, "/container/divider/style", T::Enum(&["solid", "dashed", "dotted"]), O::Container, true, false),
    row(K::FloatingRange, "/container/divider/width", T::Number, O::Container, true, false),
    row(K::FloatingRange, "/container/divider/ignorePadding", T::Boolean, O::Container, true, false),
    row(K::FloatingRange, "/container/spacing/custom", T::Boolean, O::Container, true, false),
    row(K::FloatingRange, "/container/spacing/belowTitle", T::Number, O::Container, true, false),
    row(K::FloatingRange, "/container/spacing/belowSubtitle", T::Number, O::Container, true, false),
    row(K::FloatingRange, "/container/spacing/belowDivider", T::Number, O::Container, true, false),
    row(K::FloatingRange, "/container/background/show", T::Boolean, O::Container, true, false),
    row(K::FloatingRange, "/container/background/color", T::Color, O::Container, true, false),
    row(K::FloatingRange, "/container/background/transparency", T::Number, O::Container, true, false),
    row(K::FloatingRange, "/container/border/show", T::Boolean, O::Container, true, false),
    row(K::FloatingRange, "/container/border/color", T::Color, O::Container, true, false),
    row(K::FloatingRange, "/container/border/width", T::Number, O::Container, true, false),
    row(K::FloatingRange, "/container/border/radius", T::Number, O::Container, true, false),
    row(K::FloatingRange, "/container/shadow/show", T::Boolean, O::Container, true, false),
    row(K::FloatingRange, "/container/shadow/color", T::Color, O::Container, true, false),
    row(K::FloatingRange, "/container/shadow/transparency", T::Number, O::Container, true, false),
    row(K::FloatingRange, "/container/shadow/offset", T::Enum(&["outside", "inside"]), O::Container, true, false),
    row(K::FloatingRange, "/container/shadow/position", T::Enum(&["bottomRight", "bottom", "bottomLeft", "right", "center", "left", "topRight", "top", "topLeft"]), O::Container, true, false),
    row(K::FloatingRange, "/container/shadow/blur", T::Number, O::Container, true, false),
    row(K::FloatingRange, "/container/shadow/distance", T::Number, O::Container, true, false),
    row(K::CanvasPage, "/background", T::Color, O::Family, true, false),
    row(K::CanvasPage, "/wallpaper", T::Color, O::Family, true, false),
];

/// Longest pointer `match_path` accepts.
pub const MAX_BINDING_PATH_CHARS: usize = 256;
/// Most segments a pointer may have.
pub const MAX_BINDING_PATH_SEGMENTS: usize = 8;
/// Longest single segment (in characters, escaped form).
pub const MAX_BINDING_PATH_SEGMENT_CHARS: usize = 64;

/// Control keys that are identity, not appearance. Read with the controls.rs
/// constants by [`is_never_bindable_control_key`]; not a list of code.
const CONTROL_IDENTITY_KEYS: &[&str] = &["uid", "embedded", "shapeType", "name", "controlType"];

/// Why a control key can never carry a binding, or `None` when it may (if the
/// catalog has a row for it). The reason is a full sentence that names the key.
pub fn never_bindable_control_reason(key: &str) -> Option<String> {
    if controls::EXECUTABLE_CONTROL_PROPERTIES.contains(&key) {
        return Some(format!("'{key}' is code; code is never bound."));
    }
    if controls::HELD_CONTROL_PROPERTIES.contains(&key) {
        return Some(format!(
            "'{key}' holds an application's code compartment; it is never bound."
        ));
    }
    if controls::BUTTON_ACTION_PROPERTIES.contains(&key) {
        return Some(format!(
            "'{key}' is a button's action wiring; an action is never bound."
        ));
    }
    if key == controls::PIN_TO_GRID_PROPERTY {
        return Some(format!(
            "'{key}' decides how the control follows its cells; it is not bindable."
        ));
    }
    if controls::POSITION_SIZE_PROPERTIES.contains(&key) && key != "width" && key != "height" {
        return Some(format!(
            "'{key}' places the control; its position is not bindable (only width and height are)."
        ));
    }
    if CONTROL_IDENTITY_KEYS.contains(&key) {
        return Some(format!("'{key}' is the control's identity; it is never bound."));
    }
    None
}

/// Why a path into a Page Navigator's `pageOverrides` can never carry a
/// binding, or `None` (D §3.18a). The UNESCAPED segments, starting at
/// `properties`. Refused by name, so the sentence says what to bind instead:
/// the whole list (a formula would write raw settings JSON), and the two
/// fields that NAME the page an entry is about.
pub fn page_overrides_refusal(segments: &[String]) -> Option<String> {
    if segments.get(1).map(String::as_str) != Some(controls::PAGE_NAVIGATOR_OVERRIDES_PROPERTY) {
        return None;
    }
    if segments.len() == 2 {
        return Some(
            "'/properties/pageOverrides' is a navigator's whole list of page button settings; it is never bound. \
             Bind one button's setting instead: /properties/pageOverrides/<page>/text, /fill, /color, /borderColor or /hidden."
                .to_string(),
        );
    }
    let field = segments.get(3)?;
    (segments.len() == 4 && super::page_overrides::PAGE_OVERRIDE_IDENTITY_FIELDS.contains(&field.as_str())).then(|| {
        format!("'{field}' names the page a button setting is about; it is never bound.")
    })
}

/// The never-bindable CONTROL property keys (see [`match_path`] step 2).
pub fn is_never_bindable_control_key(key: &str) -> bool {
    never_bindable_control_reason(key).is_some()
}

/// Where an object's format container lives in its JSON, or `None`.
///
/// A control's container facts are FLAT keys under `/properties/` (WP-C's
/// `CONTROL_CONTAINER_PROPERTY_KEYS`), and a canvas page has no container.
pub fn container_root(kind: ObjectBindingKind) -> Option<&'static str> {
    match kind {
        ObjectBindingKind::Chart => Some("/spec/container"),
        ObjectBindingKind::Pivot => Some("/canvasFrame/container"),
        ObjectBindingKind::Slicer => Some("/container"),
        ObjectBindingKind::TimelineSlicer => Some("/container"),
        ObjectBindingKind::FloatingRange => Some("/container"),
        ObjectBindingKind::Control => None,
        ObjectBindingKind::CanvasPage => None,
    }
}

/// Every catalog row of `kind`, in table order.
pub fn rows_of(kind: ObjectBindingKind) -> impl Iterator<Item = &'static BindablePathSpec> {
    BINDABLE_PATHS.iter().filter(move |r| r.kind == kind)
}

/// RFC 6901 unescape of one pointer segment (`~1` -> `/`, `~0` -> `~`).
/// `None` for a `~` that is not followed by `0` or `1`.
pub fn unescape_segment(segment: &str) -> Option<String> {
    let mut out = String::with_capacity(segment.len());
    let mut chars = segment.chars();
    while let Some(c) = chars.next() {
        if c == '~' {
            match chars.next() {
                Some('0') => out.push('~'),
                Some('1') => out.push('/'),
                _ => return None,
            }
        } else {
            out.push(c);
        }
    }
    Some(out)
}

/// RFC 6901 escape of one pointer segment (`~` -> `~0`, `/` -> `~1`).
pub fn escape_segment(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}

/// The pointer's segments, still ESCAPED, after the syntactic check
/// (`^(/[^/]{1,64}){1,8}$`, at most 256 characters, `~` only as `~0`/`~1`).
pub fn pointer_segments(path: &str) -> Result<Vec<&str>, String> {
    if path.chars().count() > MAX_BINDING_PATH_CHARS {
        return Err(format!(
            "A property path is at most {MAX_BINDING_PATH_CHARS} characters long."
        ));
    }
    let Some(rest) = path.strip_prefix('/') else {
        return Err(format!(
            "'{path}' is not a property path: a path is a JSON Pointer such as /spec/title."
        ));
    };
    let segments: Vec<&str> = rest.split('/').collect();
    if segments.len() > MAX_BINDING_PATH_SEGMENTS {
        return Err(format!(
            "'{path}' is too deep: a property path has at most {MAX_BINDING_PATH_SEGMENTS} segments."
        ));
    }
    for seg in &segments {
        let n = seg.chars().count();
        if n == 0 || n > MAX_BINDING_PATH_SEGMENT_CHARS {
            return Err(format!(
                "'{path}' is not a property path: every segment has 1 to {MAX_BINDING_PATH_SEGMENT_CHARS} characters."
            ));
        }
        if unescape_segment(seg).is_none() {
            return Err(format!(
                "'{path}' is not a property path: '~' must be written ~0 and '/' inside a name ~1."
            ));
        }
    }
    Ok(segments)
}

/// What a `*` segment of a pattern accepts, decided by the segment before it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WildcardClass {
    /// An array index, `^\d{1,4}$` (`/spec/series/*`, `/spec/params/*`).
    ArrayIndex,
    /// A series key, `^[A-Za-z0-9_ .-]{1,64}$` (`/spec/seriesColors/*`).
    SeriesKey,
    /// A page key: a SheetId, or `name:` + a sheet name of 1 to 31 characters
    /// (`/properties/pageOverrides/*`, S8d).
    PageKey,
}

fn wildcard_class(parent: &str) -> WildcardClass {
    match parent {
        "seriesColors" => WildcardClass::SeriesKey,
        "pageOverrides" => WildcardClass::PageKey,
        _ => WildcardClass::ArrayIndex,
    }
}

fn wildcard_accepts(class: WildcardClass, segment: &str) -> bool {
    match class {
        WildcardClass::ArrayIndex => {
            (1..=4).contains(&segment.len()) && segment.chars().all(|c| c.is_ascii_digit())
        }
        WildcardClass::SeriesKey => {
            let n = segment.chars().count();
            (1..=64).contains(&n)
                && segment
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ' ' | '.' | '-'))
        }
        WildcardClass::PageKey => {
            if identity::SheetId::parse(segment).is_some() {
                return true;
            }
            match segment.strip_prefix("name:") {
                Some(name) => (1..=31).contains(&name.chars().count()),
                None => false,
            }
        }
    }
}

/// Does `pattern` (catalog spelling, `*` wildcards) match the UNESCAPED
/// segments of a path?
fn pattern_matches(pattern: &str, segments: &[String]) -> bool {
    let pat: Vec<&str> = pattern.trim_start_matches('/').split('/').collect();
    if pat.len() != segments.len() {
        return false;
    }
    for (i, (p, s)) in pat.iter().zip(segments.iter()).enumerate() {
        if *p == "*" {
            let parent = if i == 0 { "" } else { pat[i - 1] };
            if !wildcard_accepts(wildcard_class(parent), s) {
                return false;
            }
        } else if p != s {
            return false;
        }
    }
    true
}

/// The catalog row a binding at `path` on an object of `kind` would use, or a
/// full sentence saying why there is none.
///
/// Order: (1) the syntactic pointer check; (2) for a CONTROL only, the key
/// after `/properties/` must not be a never-bindable key -- applied to that
/// segment alone, because `name` is a control's identity while
/// `/spec/series/3/name` is a chart row; (3) the first row of `kind` whose
/// pattern matches, exact rows before `*` rows.
pub fn match_path(kind: ObjectBindingKind, path: &str) -> Result<&'static BindablePathSpec, String> {
    let escaped = pointer_segments(path)?;
    let segments: Vec<String> = escaped
        .iter()
        .map(|s| unescape_segment(s).unwrap_or_default())
        .collect();

    if kind == ObjectBindingKind::Control && segments.len() >= 2 && segments[0] == "properties" {
        if let Some(reason) = never_bindable_control_reason(&segments[1]) {
            return Err(reason);
        }
        if let Some(reason) = page_overrides_refusal(&segments) {
            return Err(reason);
        }
    }

    let exact = rows_of(kind).filter(|r| !r.pointer.contains('*'));
    let wild = rows_of(kind).filter(|r| r.pointer.contains('*'));
    if let Some(found) = exact.chain(wild).find(|r| pattern_matches(r.pointer, &segments)) {
        return Ok(found);
    }

    let listed: Vec<&str> = rows_of(kind).map(|r| r.pointer).collect();
    if listed.is_empty() {
        return Err(format!(
            "A {} has no bindable properties yet, so '{path}' cannot be bound.",
            kind.label()
        ));
    }
    Err(format!(
        "'{path}' is not a bindable property of a {}. Its bindable properties are: {}.",
        kind.label(),
        listed.join(", ")
    ))
}
