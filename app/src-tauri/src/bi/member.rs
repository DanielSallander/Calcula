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
    Some(MemberRef::from_source(key, &source, locale))
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
            Some(value) => MemberSource::Number { value },
            None => MemberSource::Text,
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
/// - `Number`: the invariant machine parse, else text;
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
        BiColumnKind::Number | BiColumnKind::Unknown => match parse_machine_number(text) {
            Some(n) => plain(Cell::new_number(n)),
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
