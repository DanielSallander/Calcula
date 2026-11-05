//! FILENAME: app/src-tauri/src/bi/member.rs
//! PURPOSE: The BI side of THE member shape (P2, app locale everywhere).
//!
//! A model value list hands out `MemberRef { key, label }`:
//!
//! - the KEY is exactly what `arrow_value_to_string` writes (invariant machine
//!   text: "3578.27", "2024-01-15", "2024-01-15 13:04:05") -- the spelling
//!   every selection, filter, page filter and cross-filter tuple matches on,
//!   and the spelling a BI pivot cache's `FieldCache::member_key` gives;
//! - the LABEL is written for the app locale from the TYPED Arrow value
//!   (`engine::member_label`), never by re-parsing display text.
//!
//! The BLANK member (a NULL and, on a text column, the empty string) is key
//! `""` and label `"(Blank)"` (orchestrator ruling Q8). The BI engine's
//! scoped IN-lists name the blank by its own label
//! (`bi_engine::BLANK_MEMBER_LABEL`, "(blank)"), so every host site that hands
//! member KEYS to the engine as an IN-list goes through [`engine_in_value`].
//!
//! Also here (DC1/DC4): [`BiColumnKind`], [`column_kind`], [`typed_cell`],
//! [`parse_machine_number`] and [`ResultCellWriter`] -- the column TYPE decides
//! how a query result cell is written to the grid (`bi_insert_result` and the
//! refresh writer), not a guess from its text.

use arrow::array::Array;
use arrow::datatypes::DataType as ArrowDataType;
use engine::{Cell, CellStyle, LocaleSettings, MemberSource, NumberFormat, StyleRegistry};
use serde::{Deserialize, Serialize};

use crate::api_types::MemberRef;

use super::commands::arrow_value_to_string;

/// The member at `idx` of `array`, or `None` for the BLANK member (a NULL,
/// or an empty string) -- which every list offers ONCE, last, as
/// [`MemberRef::blank`], so a caller folds it rather than listing it per row.
pub(crate) fn arrow_member(array: &dyn Array, idx: usize, locale: &LocaleSettings) -> Option<MemberRef> {
    let key = arrow_value_to_string(array, idx)?;
    if key.is_empty() {
        return None;
    }
    let source = arrow_member_source(array.data_type(), &key);
    // A non-finite float member keeps its machine key ("inf", "-inf", "NaN":
    // what a selection matches on) and is LABELLED with the word the app
    // shows for it everywhere else (`@api/locale` `nonFiniteNumberText`).
    if let Some(word) = non_finite_member_label(array.data_type(), &key) {
        return Some(MemberRef { key, label: word.to_string() });
    }
    Some(MemberRef::from_source(key, &source, locale))
}

/// The label of a float member that is not a finite number -- Infinity,
/// -Infinity, NaN, the words `@api/locale`'s `nonFiniteNumberText` writes on
/// a canvas visual (open-ledger round D) -- or `None` for any other member.
fn non_finite_member_label(data_type: &ArrowDataType, key: &str) -> Option<&'static str> {
    if !matches!(data_type, ArrowDataType::Float32 | ArrowDataType::Float64) {
        return None;
    }
    let value = parse_machine_number(key)?;
    if value.is_nan() {
        Some("NaN")
    } else if value == f64::INFINITY {
        Some("Infinity")
    } else if value == f64::NEG_INFINITY {
        Some("-Infinity")
    } else {
        None
    }
}

/// What the KEY of a value of `data_type` is, so its label can be written for
/// a locale. Numbers are read from the key (the exact decimal for Decimal128,
/// which `arrow_value_to_string` writes without loss); dates go through the
/// same strict ISO reader the BI pivot cache uses (`engine::iso_member_source`
/// via `FieldCache::member_kind`), so a model list and a model pivot header
/// label one member the same way. Anything that does not read is `Text`.
pub(crate) fn arrow_member_source(data_type: &ArrowDataType, key: &str) -> MemberSource {
    match data_type {
        ArrowDataType::Int8
        | ArrowDataType::Int16
        | ArrowDataType::Int32
        | ArrowDataType::Int64
        | ArrowDataType::UInt8
        | ArrowDataType::UInt16
        | ArrowDataType::UInt32
        | ArrowDataType::UInt64
        | ArrowDataType::Float32
        | ArrowDataType::Float64
        | ArrowDataType::Decimal128(_, _) => match parse_machine_number(key) {
            // A non-finite float (a column holding a 1/0) is no number a
            // member can be written as or sorted among: its key is its
            // machine text ("inf", "-inf", "NaN") and it is TEXT, never a
            // `Number { inf }` that a label writer formats and a numeric sort
            // places. `arrow_member` labels it Infinity / -Infinity / NaN.
            Some(value) if value.is_finite() => MemberSource::Number { value },
            _ => MemberSource::Text,
        },
        ArrowDataType::Date32 | ArrowDataType::Timestamp(_, _) => {
            engine::iso_member_source(key).unwrap_or(MemberSource::Text)
        }
        ArrowDataType::Boolean => match key {
            "true" => MemberSource::Boolean { value: true },
            "false" => MemberSource::Boolean { value: false },
            _ => MemberSource::Text,
        },
        _ => MemberSource::Text,
    }
}

/// A member KEY as the BI engine's scoped IN-list reads it: the blank member
/// (key `""`, or the legacy header spelling "(blank)" in any case) becomes
/// `bi_engine::BLANK_MEMBER_LABEL`, which the engine reads as "keep the NULL
/// rows and, on a text column, the empty-string rows" -- the Q8 fold. Every
/// other key passes through unchanged.
///
/// A literal "" in an engine IN-list would match only the empty-string rows of
/// a text column and silently drop the NULL rows the blank member also names.
pub(crate) fn engine_in_value(key: &str) -> String {
    if pivot_engine::is_blank_member_key(key) {
        bi_engine::BLANK_MEMBER_LABEL.to_string()
    } else {
        key.to_string()
    }
}

/// The TYPE of a query result column, carried on the wire beside the string
/// rows (`BiQueryResult::column_kinds`, S5), so the grid writer decides from
/// the source's declared type rather than guessing from the text (DC1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BiColumnKind {
    Number,
    Date,
    DateTime,
    Boolean,
    Text,
    /// No type known (an empty `column_kinds`, e.g. a hand-built result):
    /// today's behaviour, a number when the text parses invariantly.
    #[default]
    Unknown,
}

/// The [`BiColumnKind`] of an Arrow column type.
pub(crate) fn column_kind(data_type: &ArrowDataType) -> BiColumnKind {
    match data_type {
        ArrowDataType::Int8
        | ArrowDataType::Int16
        | ArrowDataType::Int32
        | ArrowDataType::Int64
        | ArrowDataType::UInt8
        | ArrowDataType::UInt16
        | ArrowDataType::UInt32
        | ArrowDataType::UInt64
        | ArrowDataType::Float16
        | ArrowDataType::Float32
        | ArrowDataType::Float64
        | ArrowDataType::Decimal128(_, _)
        | ArrowDataType::Decimal256(_, _) => BiColumnKind::Number,
        ArrowDataType::Date32 | ArrowDataType::Date64 => BiColumnKind::Date,
        ArrowDataType::Timestamp(_, _) => BiColumnKind::DateTime,
        ArrowDataType::Boolean => BiColumnKind::Boolean,
        ArrowDataType::Utf8 | ArrowDataType::LargeUtf8 | ArrowDataType::Dictionary(_, _) => BiColumnKind::Text,
        _ => BiColumnKind::Unknown,
    }
}

/// The invariant MACHINE parse of a number `arrow_value_to_string` wrote
/// ("1234.5", "-3", "1e-7"). Never a user-text parse: the text was written by
/// the host, not typed, so it is never localised (DC1).
pub(crate) fn parse_machine_number(s: &str) -> Option<f64> {
    s.parse::<f64>().ok()
}

/// A model number as a GRID value: the number, or `#NUM!` when it is not
/// finite. A DAX measure's `1/0`, `-1/0` and `0/0` are Infinity, -Infinity and
/// NaN, which no Excel cell can hold: [LIVE] Excel 16 shows `#NUM!` for all
/// three, in CUBEVALUE and in a data-model PivotTable's value cells alike
/// (open-ledger round D). Every grid writer of a BI number goes through this:
/// [`typed_cell`] (Insert Result and its refresh), the drill-through sheet and
/// the PivotTable writer.
pub(crate) fn grid_number_value(n: f64) -> engine::CellValue {
    if n.is_finite() {
        engine::CellValue::Number(n)
    } else {
        engine::CellValue::Error(engine::CellError::Num)
    }
}

/// The non-finite spellings the host's machine text writes (`f64`'s
/// `Display`: `arrow_value_to_string`). A column of no known type only reads
/// THESE as a number; `"Infinity"` or `"nan"` there is someone's text.
fn is_machine_non_finite(s: &str) -> bool {
    matches!(s, "inf" | "-inf" | "NaN")
}

/// A query result's machine text in a `Number` / `Unknown` column as a grid
/// value, or `None` when it is not a number (the caller writes text). A
/// non-finite number is `#NUM!` ([`grid_number_value`]).
pub(crate) fn machine_number_cell_value(text: &str, kind: BiColumnKind) -> Option<engine::CellValue> {
    let n = parse_machine_number(text)?;
    if n.is_finite() || kind == BiColumnKind::Number || is_machine_non_finite(text) {
        Some(grid_number_value(n))
    } else {
        None
    }
}

/// One query-result cell as the grid writer stores it: the cell, plus the
/// number format a date must be shown with. The caller interns the format as
/// a style (`Cell` carries a style index, not a format).
#[derive(Debug, Clone)]
pub(crate) struct TypedBiCell {
    pub cell: Cell,
    pub number_format: Option<NumberFormat>,
}

/// THE writer of one query-result cell (DC1, DC4), from its machine text and
/// its column's declared kind:
///
/// - `Number`: the invariant machine parse, else text; a non-finite number
///   (a DAX `1/0`) is `#NUM!`, as Excel shows it ([`grid_number_value`]);
/// - `Date` / `DateTime`: the ISO text becomes a date serial, shown with the
///   locale's short-date pattern (plus its time pattern for a date-time).
///   The pattern is FROZEN at write time, exactly as typed date entry freezes
///   it (`typed_entry::parse_date_time_input`, DC4);
/// - `Boolean`: a boolean cell;
/// - `Text`: ALWAYS text ("00123" stays "00123");
/// - `Unknown`: a number when the text parses invariantly, else text.
///
/// `None` (a NULL) is an empty cell.
pub(crate) fn typed_cell(text: Option<&str>, kind: BiColumnKind, locale: &LocaleSettings) -> TypedBiCell {
    let plain = |cell: Cell| TypedBiCell { cell, number_format: None };
    let Some(text) = text else { return plain(Cell::new()) };
    match kind {
        BiColumnKind::Number | BiColumnKind::Unknown => match machine_number_cell_value(text, kind) {
            Some(value) => plain(Cell { value, ..Cell::new() }),
            None => plain(Cell::new_text(text.to_string())),
        },
        BiColumnKind::Date | BiColumnKind::DateTime => match engine::iso_member_source(text) {
            Some(MemberSource::Date { serial }) => TypedBiCell {
                cell: Cell::new_number(serial),
                number_format: Some(NumberFormat::Date { format: locale.date_format.clone() }),
            },
            Some(MemberSource::DateTime { serial }) => TypedBiCell {
                cell: Cell::new_number(serial),
                number_format: Some(NumberFormat::Date {
                    format: format!("{} {}", locale.date_format, locale.time_format),
                }),
            },
            _ => plain(Cell::new_text(text.to_string())),
        },
        BiColumnKind::Boolean => match text {
            "true" | "TRUE" => plain(Cell::new_boolean(true)),
            "false" | "FALSE" => plain(Cell::new_boolean(false)),
            _ => plain(Cell::new_text(text.to_string())),
        },
        BiColumnKind::Text => plain(Cell::new_text(text.to_string())),
    }
}

/// The ONE grid writer of a query result's data cells (DC1, DC4), shared by
/// `bi_insert_result` and the refresh writer so the two cannot drift.
///
/// The date styles are interned ONCE, up front, while the caller holds the
/// style-registry guard and BEFORE it takes the grid guards, and only when
/// some column can produce a date: a result with no date column adds nothing
/// to the persisted style registry.
pub(crate) struct ResultCellWriter {
    kinds: Vec<BiColumnKind>,
    locale: LocaleSettings,
    /// (format, style index) for the short-date and the date-time pattern.
    date_styles: Vec<(NumberFormat, usize)>,
}

impl ResultCellWriter {
    pub(crate) fn new(kinds: &[BiColumnKind], locale: &LocaleSettings, styles: &mut StyleRegistry) -> Self {
        let mut date_styles = Vec::new();
        if kinds.iter().any(|k| matches!(k, BiColumnKind::Date | BiColumnKind::DateTime)) {
            for format in [
                NumberFormat::Date { format: locale.date_format.clone() },
                NumberFormat::Date { format: format!("{} {}", locale.date_format, locale.time_format) },
            ] {
                let index = styles.get_or_create(CellStyle::new().with_number_format(format.clone()));
                date_styles.push((format, index));
            }
        }
        ResultCellWriter { kinds: kinds.to_vec(), locale: locale.clone(), date_styles }
    }

    /// The cell for the machine text `text` of column `col`. A column past
    /// the end of `kinds` (or an empty `kinds`) is `Unknown`.
    pub(crate) fn cell(&self, col: usize, text: Option<&str>) -> Cell {
        let kind = self.kinds.get(col).copied().unwrap_or(BiColumnKind::Unknown);
        let typed = typed_cell(text, kind, &self.locale);
        let mut cell = typed.cell;
        if let Some(format) = typed.number_format {
            if let Some((_, index)) = self.date_styles.iter().find(|(f, _)| *f == format) {
                cell.style_index = *index;
            }
        }
        cell
    }
}

#[cfg(test)]
mod non_finite_member_tests {
    use super::*;
    use arrow::array::{Float64Array, Int64Array};

    /// NEW-kpi-band-sort (member half): a float column holding 1/0, -1/0
    /// and 0/0 listed them as NUMBER members (`Number { inf }`). Each keeps
    /// its machine key -- the text a selection matches on -- is TEXT, and is
    /// labelled with the app's word for it.
    #[test]
    fn a_non_finite_float_member_keeps_its_key_and_reads_as_its_word() {
        let locale = LocaleSettings::from_locale_id("sv-SE");
        let values = Float64Array::from(vec![f64::INFINITY, f64::NEG_INFINITY, f64::NAN, 2.5]);
        let members: Vec<MemberRef> = (0..values.len())
            .map(|i| arrow_member(&values, i, &locale).expect("a member"))
            .collect();
        assert_eq!(
            members,
            vec![
                MemberRef { key: "inf".into(), label: "Infinity".into() },
                MemberRef { key: "-inf".into(), label: "-Infinity".into() },
                MemberRef { key: "NaN".into(), label: "NaN".into() },
                MemberRef { key: "2.5".into(), label: "2,5".into() },
            ]
        );
        // An integer column's text is never one of these words.
        let ints = Int64Array::from(vec![7]);
        assert_eq!(arrow_member(&ints, 0, &locale).unwrap(), MemberRef { key: "7".into(), label: "7".into() });
    }

    /// The member SOURCE of a non-finite float key is Text, never a
    /// `Number { inf }` that a label writer formats and a numeric sort places.
    #[test]
    fn a_non_finite_float_key_is_a_text_member_source() {
        for key in ["inf", "-inf", "NaN"] {
            assert_eq!(arrow_member_source(&ArrowDataType::Float64, key), MemberSource::Text, "{key}");
        }
        assert_eq!(
            arrow_member_source(&ArrowDataType::Float64, "2.5"),
            MemberSource::Number { value: 2.5 }
        );
    }
}
