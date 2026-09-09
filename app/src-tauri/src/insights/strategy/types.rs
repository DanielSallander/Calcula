//! FILENAME: app/src-tauri/src/insights/strategy/types.rs
// PURPOSE: The strategy document itself - the on-disk shape a consultant authors
//          and the vocabulary every other file in this subtree resolves against.
// CONTEXT: Two properties of these types are load-bearing and must survive any
//          later edit.
//
//          (1) AN UNKNOWN KEY IS REFUSED EVERYWHERE, BY NAME. A strategy
//          file is hand-written; without that, `higherIsBeter` or `analysisDimension`
//          parses cleanly and the engine silently generates the wrong facts
//          forever. A typo must be an error, not a shrug. Every derived
//          container WITH FIELDS carries `#[serde(deny_unknown_fields)]` - the
//          fieldless unit enums (`Direction`, `Unit`, `Role`, `Cadence`,
//          `ExpectedStatus` and the rest) do not, because the attribute governs
//          nothing there and serde already refuses an unknown VARIANT by name.
//          This paragraph used to stop at the attribute and claim it covered the
//          file. It did not: `RawScopeValue`, the enum every `ScopeValue`
//          arrives through, is shape-dispatched rather than field-named, and
//          while it was derived `untagged` a scope written
//          `{"from": .., "too": ..}` parsed as an open-ended range with the
//          typo dropped. The attribute is not the fix there - it refuses the
//          document but reports only "data did not match any variant", naming
//          nothing - so that enum has a hand-written visitor that refuses an
//          unexpected key by name instead. See its own comment. The attribute
//          is NOT the house
//          default, and this file used to claim it was by citing the .calp
//          manifest types: no type under `core/calp/src` carries the attribute,
//          and the .cala reader deliberately DROPS a section it does not know
//          (`zip_io.rs` says so in the comment beside its feature-id list). Those
//          formats are written by one build and read by another, where tolerating
//          an unknown key is the point. This one is typed by a PERSON, and the
//          only thing an unknown key can be is a mistake.
//
//          (2) `AttributeSet` - the ONLY thing a `Rule` can carry - has no field
//          that can assert a value about the data. `direction`, `materiality`,
//          `cadence` and `aggregation` say how to INTERPRET a number the model
//          computed; `suppress` removes fact kinds; `rankWeight` reorders. There
//          is deliberately no `value`, no `note` that reaches ranking, and no way
//          to state what a measure "is" at a point. `target` is the boundary case
//          and it stays because a target is a GOAL supplied by the business, not
//          an observation - the engine still computes the actual from the model
//          and compares. If a future field could let a rule put an unverified
//          number in front of a reader, it does not belong on `AttributeSet`.
//
//          (3) A CLOSED SET IS A TYPE, NOT A STRING PLUS A CHECK. `suppress` was
//          `Vec<String>` guarded by a validator arm, and the doc comment beside
//          it offered `"outlier"` as its example - a spelling nothing emits under
//          either `outlier` or the core engine's plural `outliers`. That is the
//          failure mode a prose list has and a variant list cannot: the comment
//          drifted from the parser, and the one place a person copies a spelling
//          from named something that could not work. The same reasoning gives
//          `IsoDate` and `MonthDay` validating `Deserialize` impls: a value whose FORM is load-bearing is refused where it is
//          read, not somewhere later by a check that a future caller can skip.
//
//          WHAT PARSE-TIME REFUSAL COSTS, stated so the next author can weigh it.
//          `insights::model_commands::strategy_doc` answers a serde failure by
//          discarding the WHOLE document and running on `StrategyDoc::default()`
//          with one note, so a single bad `suppress` entry now costs every
//          direction, materiality and rule rather than one suppression. Both
//          write paths (`bi_model_strategy` `set` and the .calp publish gate)
//          refuse an invalid document, so nothing typed through the product can
//          reach that state; a hand-edited model file can. `rekey_stored_strategy`
//          (`bi/model_editor.rs`) is the one other writer and is MOSTLY not an
//          exception - it re-serializes a document it has just PARSED, so what it
//          stores is the validated one's content - with one hole its own comment
//          does not mention: `renamed_qualified_column` rebuilds a
//          `QualifiedColumn` from whatever new name a rename supplied, unchecked,
//          and a column renamed to one carrying `]` stores a string `from_str`
//          then refuses. The trade is deliberate: a document that cannot be read
//          fails loudly, while a document that parses and quietly means something
//          else is the defect this whole subtree exists to prevent.

use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// The schema version a freshly written document carries.
pub const STRATEGY_DOC_VERSION: u32 = 1;

/// Is this a schema version this build can honestly claim to understand?
///
/// DELIBERATELY NOT A VALIDATING `Deserialize`, unlike `IsoDate` and `MonthDay`.
/// A malformed DATE is a typo in one field and refusing it at parse time costs
/// the author nothing; an unreadable VERSION is a statement about the whole
/// document, and refusing it in `Deserialize` would turn an anchored
/// `unsupported-document-version` finding - which the Strategy tab pins to a row
/// - into a path-less `unreadable-document` pinned to nothing.
///
/// So the refusal lives in TWO readers instead, and this predicate is what keeps
/// them agreeing: `validate.rs` for the write gates, and `strategy_doc`
/// (`model_commands.rs`) for the RUN path, which parses without validating and
/// was the real hole - a `.calp` carrying a newer document would have been
/// applied as v1, every field read with a meaning it does not have.
pub fn is_readable_doc_version(version: u32) -> bool {
    version != 0 && version <= STRATEGY_DOC_VERSION
}

/// Every fact kind a `Rule`'s `suppress` list may name.
///
/// THE ONLY WAY A SUPPRESSION COULD FAIL WAS BY SPELLING. `insights::model`
/// filters facts by kind, so a key nobody emits removed nothing and the author's
/// instruction was silently ignored - the fact they asked to withhold appeared
/// in the report. It was a `Vec<String>` with a validator arm behind it, and the
/// spelling the type's own doc comment offered as an example (`"outlier"`) was
/// one nothing emits. As a TYPE that cannot happen: `serde` refuses the document
/// at parse time with "unknown variant `outlier`, expected one of ...".
///
/// The set lives here, in the vocabulary file, because it is part of the
/// document's contract with the person writing it; it is kept honest by
/// `every_fact_kind_a_run_can_emit_is_spelled_in_the_suppressible_list` in
/// `insights::model`, which builds one of each fact kind and diffs the two
/// directions. Add a `ModelFactKind` without adding it here and that test reds.
///
/// `rename_all = "camelCase"` produces exactly the eight wire spellings
/// `ModelFactKind::kind_key` returns, which is what makes the two diffable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SuppressibleFactKind {
    Change,
    ChangePoint,
    Contribution,
    DefinitionalDriver,
    MemberMove,
    Seasonality,
    Trend,
    Variance,
}

impl SuppressibleFactKind {
    /// Every variant, in wire-spelling order.
    ///
    /// Written as a literal and diffed against an exhaustive match in this
    /// file's own tests, so a new variant that is not listed here fails a test
    /// rather than quietly dropping out of the message the validator prints.
    pub const ALL: &'static [SuppressibleFactKind] = &[
        SuppressibleFactKind::Change,
        SuppressibleFactKind::ChangePoint,
        SuppressibleFactKind::Contribution,
        SuppressibleFactKind::DefinitionalDriver,
        SuppressibleFactKind::MemberMove,
        SuppressibleFactKind::Seasonality,
        SuppressibleFactKind::Trend,
        SuppressibleFactKind::Variance,
    ];

    /// The wire spelling - the same string `ModelFactKind::kind_key` returns.
    pub fn as_str(self) -> &'static str {
        match self {
            SuppressibleFactKind::Change => "change",
            SuppressibleFactKind::ChangePoint => "changePoint",
            SuppressibleFactKind::Contribution => "contribution",
            SuppressibleFactKind::DefinitionalDriver => "definitionalDriver",
            SuppressibleFactKind::MemberMove => "memberMove",
            SuppressibleFactKind::Seasonality => "seasonality",
            SuppressibleFactKind::Trend => "trend",
            SuppressibleFactKind::Variance => "variance",
        }
    }

    /// The variant a wire spelling names, or `None`.
    ///
    /// The engine needs this direction because a `core/insights` series fact
    /// arrives as a `FactKind` with twenty possible keys, only three of which a
    /// model run ever wraps; asking "is this key suppressible" is the honest
    /// question there, and it must not be answered by a second hand-written list.
    pub fn from_wire(s: &str) -> Option<Self> {
        SuppressibleFactKind::ALL.iter().copied().find(|k| k.as_str() == s)
    }

    /// Every variant, comma-separated - for a message that has to list them.
    pub fn vocabulary() -> String {
        SuppressibleFactKind::ALL
            .iter()
            .map(|k| k.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    }
}

impl fmt::Display for SuppressibleFactKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The serialized ceiling for one strategy document, in bytes.
///
/// 256 KB is not a taste judgement: it is the same number as
/// `MODEL_EXTENSION_DATA_MAX_VALUE_BYTES` (262_144, `bi/model_editor.rs`), the
/// per-key quota the model editor puts on every extension-data value, and a
/// strategy document is stored as one such key. The quota is the HOST's and not
/// the BI engine's - nothing in `model-engine-lib` caps an extension-data value,
/// and this comment used to say the engine did. So these are two independent
/// literals spelling one number, with nothing diffing them; a change to that one
/// has to be copied here by hand. A document over the
/// cap is refused by the validator rather than truncated at write time, because
/// a truncated document parses as a DIFFERENT, smaller strategy and would apply
/// silently.
pub const MAX_STRATEGY_DOC_BYTES: usize = 256 * 1024;

// ---------------------------------------------------------------------------
// QualifiedColumn
// ---------------------------------------------------------------------------

/// A column named the way a model author writes it: `Table[Column]`.
///
/// It is a map KEY in `Scope`, so it serializes as that one string rather than as
/// a nested object - a JSON object cannot have a structured key, and a
/// `[{table, column, value}]` array would let the same column appear twice with
/// two different constraints, which is exactly the ambiguity overlap.rs exists to
/// remove.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct QualifiedColumn {
    pub table: String,
    pub column: String,
}

impl QualifiedColumn {
    pub fn new(table: impl Into<String>, column: impl Into<String>) -> Self {
        Self {
            table: table.into(),
            column: column.into(),
        }
    }
}

impl fmt::Display for QualifiedColumn {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}[{}]", self.table, self.column)
    }
}

/// Why a `Table[Column]` string could not be read. Carries the offending text so
/// a validation finding can quote it back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QualifiedColumnParseError {
    pub input: String,
    pub reason: &'static str,
}

impl fmt::Display for QualifiedColumnParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "'{}' is not a Table[Column] reference: {}", self.input, self.reason)
    }
}

impl FromStr for QualifiedColumn {
    type Err = QualifiedColumnParseError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let fail = |reason: &'static str| QualifiedColumnParseError {
            input: s.to_string(),
            reason,
        };
        let open = s.find('[').ok_or_else(|| fail("no '[' in it"))?;
        if !s.ends_with(']') {
            return Err(fail("it does not end with ']'"));
        }
        let table = s[..open].trim();
        // The closing bracket is the LAST character, so the column is everything
        // between. A column name containing ']' is unrepresentable and is
        // rejected here rather than silently truncated.
        let column = &s[open + 1..s.len() - 1];
        if table.is_empty() {
            return Err(fail("the table name is empty"));
        }
        if column.is_empty() {
            return Err(fail("the column name is empty"));
        }
        if column.contains('[') || column.contains(']') {
            return Err(fail("the column name contains a bracket"));
        }
        Ok(QualifiedColumn::new(table, column))
    }
}

impl Serialize for QualifiedColumn {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for QualifiedColumn {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        QualifiedColumn::from_str(&raw).map_err(D::Error::custom)
    }
}

// ---------------------------------------------------------------------------
// Validated scalar forms
// ---------------------------------------------------------------------------

/// Why a formatted scalar could not be read. Carries the offending text so a
/// serde error and a validation finding can both quote it back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormatError {
    pub input: String,
    pub expected: &'static str,
}

impl fmt::Display for FormatError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "'{}' is not {}", self.input, self.expected)
    }
}

/// A zero-padded ISO-8601 `YYYY-MM-DD` date.
///
/// THE FORM IS THE ALGORITHM, NOT A NICETY. overlap.rs intersects two date
/// ranges by comparing their bounds as TEXT and resolve.rs decides whether a
/// range admits a member the same way; both are exact for zero-padded ISO-8601
/// and meaningless for anything else, so `1/4/2025` would make the overlap
/// checker quietly conclude "disjoint" and a rule silently stop colliding.
///
/// It was checked by the validator (`malformed-date-range`) and stored as a
/// bare `String`, which protected the two write gates and not the RUN path: a
/// hand-edited model file reached `resolve` with the malformed bound intact.
/// Refusing it in `Deserialize` closes that, and the derived `Ord` is the same
/// lexicographic comparison the two consumers already perform - so the ordering
/// this type hands them is chronological BECAUSE the format is enforced here.
///
/// THE VALIDATOR FINDING IS GONE, SO THIS IS THE ONLY GUARD LEFT. The
/// `malformed-date-range` arm was deleted on the grounds that the type now
/// stands there, and nothing downstream looks at a bound again. That is why
/// `is_valid` checks the day against ITS MONTH rather than against 31:
/// `2026-02-31` and `2026-04-31` are ten well-formed characters naming a day
/// the calendar does not have, they compare against real dates perfectly
/// happily, and a rule bounded by one silently admits or excludes members
/// nobody meant it to.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct IsoDate(String);

/// Whether the Gregorian calendar gives this year a 29th of February.
///
/// THE CENTURY RULE IN FULL, not the divisible-by-four shorthand. 2000 was a
/// leap year and 1900 was not, and the shorthand accepts `1900-02-29` - a date
/// no calendar has ever had.
fn is_leap_year(year: u32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// How many days that month of that year has, or 0 for a month outside 1..=12.
///
/// Zero for an impossible month is what lets one comparison
/// (`1 <= day <= days_in_month(..)`) refuse a bad month and a bad day together,
/// rather than two range checks that pass INDEPENDENTLY - which is exactly how
/// `2026-02-31` got through.
fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

impl IsoDate {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Is this text a well-formed ISO-8601 date that the calendar actually has?
    ///
    /// The one implementation; the validator asks it about column MEMBERS,
    /// which are raw strings from the model and can be anything.
    pub fn is_valid(s: &str) -> bool {
        let b = s.as_bytes();
        if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
            return false;
        }
        if !b
            .iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
        {
            return false;
        }
        let year: u32 = s[0..4].parse().unwrap_or(0);
        let month: u32 = s[5..7].parse().unwrap_or(0);
        let day: u32 = s[8..10].parse().unwrap_or(0);
        (1..=days_in_month(year, month)).contains(&day)
    }
}

impl fmt::Display for IsoDate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for IsoDate {
    type Err = FormatError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        if IsoDate::is_valid(s) {
            Ok(IsoDate(s.to_string()))
        } else {
            Err(FormatError {
                input: s.to_string(),
                expected: "a YYYY-MM-DD date the calendar actually has; the overlap checker \
                           compares these bounds as text, so any other spelling would make it \
                           wrongly conclude two rules are disjoint, and a day its month does not \
                           have (2026-02-31) is a bound no member can ever match",
            })
        }
    }
}

impl Serialize for IsoDate {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for IsoDate {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        IsoDate::from_str(&raw).map_err(D::Error::custom)
    }
}

/// `MM-DD` - the day a fiscal year starts on.
///
/// NOTHING READS IT YET, and the newtype is here for exactly that reason: no
/// code in `model.rs`, `model_commands.rs` or `report.rs` asks where the fiscal
/// year begins, so a malformed value would sit in the document until whoever
/// wires it up trips over it. A value stored in a form no consumer can read is
/// a trap, and the cheapest place to refuse it is where it is read off the wire.
/// Unread is not the same as unset: `infer_fiscal_year_start` (`infer.rs`) SEEDS
/// one from the model's declared fiscal-year-end month, so an inferred draft
/// routinely carries a value nothing consumes.
///
/// THE DAY IS CHECKED AGAINST ITS MONTH, AND FEBRUARY IS THE ONE LOOSE CASE.
/// An MM-DD carries no year, so `02-29` cannot be refused: whether it exists is
/// a property of a YEAR and there is no year here. That is an argument for
/// accepting 29 in February and for nothing else. `02-30`, `02-31`, `04-31`,
/// `06-31`, `09-31` and `11-31` are days NO year has — SIX, where this paragraph
/// used to name five: `02-30` was missing, because February was being thought
/// about as the leap-year case rather than as a month with a ceiling like any
/// other. A per-month maximum that simply ignores the leap rule — February 29,
/// April/June/September/November 30, the rest 31 — accepts `02-29` and refuses
/// all six, in one predicate; the same six are named one by one in
/// `a_fiscal_year_start_takes_every_months_last_real_day_and_refuses_the_day_after_it`
/// at the bottom of this file.
///
/// THIS TYPE IS NOW THE ONLY THING GUARDING THE FIELD. The
/// `malformed-fiscal-year-start` finding was deleted from `validate.rs` on the
/// grounds that the newtype guards it, so anything this predicate accepts
/// reaches a stored document with nothing else to catch it.
///
/// THE TAB AGREES, AND A TEST READS THIS FILE TO KEEP IT AGREEING. What stood
/// here said the opposite - that `parseFiscalYearStart`
/// (`ModelEditor/components/sections/StrategySection.tsx`) still checked a flat
/// 1..=12 and 1..=31, and that teaching it the per-month maximum was the matching
/// one-file change still to make. That change is done. The function bounds the
/// day by `MONTH_DAY_MAX = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]` and
/// refuses it with a per-month message, so `02-31` is stopped at the keystroke
/// rather than by `Deserialize` at the write gate.
///
/// That array is a restatement of `max_day_of_month` below, and a restatement is
/// only a mirror while something diffs it. `ModelEditor/lib/strategyTypes.test.ts`
/// PARSES the `match` arms of `max_day_of_month` out of THIS FILE at test time
/// and probes the tab's function against the table it builds ("gives a fiscal
/// year start the day ceilings max_day_of_month declares"), naming `02-30`,
/// `02-31`, `04-31`, `06-31`, `09-31` and `11-31` while keeping `02-29`. Two more
/// rows there pin what a behavioural probe cannot see - that `MonthDay::new`
/// still spells `(1..=12).contains(&month)`, and that it has not gone back to a
/// flat `1..=31` inline - and `ModelEditor/__tests__/StrategySection.test.tsx`
/// drives the refusal on screen. The direction is fixed Rust -> TypeScript:
/// loosen or tighten this predicate and the TypeScript side reds.
///
/// `max_day_of_month` and `days_in_month` are diffed SEPARATELY over there, and
/// deliberately: they are different tables, and February is where they differ.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct MonthDay {
    month: u32,
    day: u32,
}

/// The highest day number the month can ever carry, leap rule ignored.
///
/// February answers 29 rather than 28 because an MM-DD names no year; see the
/// type's header. The `_` arm covers months outside 1..=12, which `new` has
/// already rejected before it asks.
const fn max_day_of_month(month: u32) -> u32 {
    match month {
        2 => 29,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

impl MonthDay {
    /// `None` for a month outside 1..=12, or a day its month does not have —
    /// February allowing 29. See the type's header.
    pub fn new(month: u32, day: u32) -> Option<Self> {
        if (1..=12).contains(&month) && (1..=max_day_of_month(month)).contains(&day) {
            Some(MonthDay { month, day })
        } else {
            None
        }
    }

    pub fn month(self) -> u32 {
        self.month
    }

    pub fn day(self) -> u32 {
        self.day
    }
}

impl fmt::Display for MonthDay {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:02}-{:02}", self.month, self.day)
    }
}

impl FromStr for MonthDay {
    type Err = FormatError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let fail = || FormatError {
            input: s.to_string(),
            expected: "an MM-DD fiscal year start whose day its month actually has, e.g. '04-01'. \
                       February accepts 29 because an MM-DD names no year; April, June, September \
                       and November stop at 30, and '02-31' is a day no year has",
        };
        let b = s.as_bytes();
        if b.len() != 5 || b[2] != b'-' || !b.iter().enumerate().all(|(i, c)| i == 2 || c.is_ascii_digit())
        {
            return Err(fail());
        }
        let month: u32 = s[0..2].parse().map_err(|_| fail())?;
        let day: u32 = s[3..5].parse().map_err(|_| fail())?;
        MonthDay::new(month, day).ok_or_else(fail)
    }
}

impl Serialize for MonthDay {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for MonthDay {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        MonthDay::from_str(&raw).map_err(D::Error::custom)
    }
}

// ---------------------------------------------------------------------------
// The extension namespace
// ---------------------------------------------------------------------------

/// The namespace built-in features own, and nobody else may write.
pub const RESERVED_EXTENSION_PREFIX: &str = "calcula.";

/// The longest an extension key may be, in BYTES.
///
/// The model-level message used to say "chars" while the check counted bytes,
/// so a key of Swedish or Japanese characters was refused sooner than the
/// sentence promised. Bytes is the honest word and this constant carries it.
pub const MAX_EXTENSION_KEY_BYTES: usize = 200;

/// Why this key may not name a third-party namespace, or `None`.
///
/// ONE RULE, TWO READERS, AND THEY MUST NOT DRIFT. The model's own
/// `extension_data` map is guarded by `validate_extension_data_key`
/// (`bi/model_editor.rs`), and the strategy document's per-object `x` bag is
/// guarded by `ExtKey` below. They are the same reservation one nesting level
/// apart: a user writing `acme.notes` on the MODEL and a user writing
/// `acme.notes` on a MEASURE are doing the same thing, and a rule that held in
/// one place and not the other would be discovered by whoever hit the softer
/// half.
///
/// THE CASE-SENSITIVITY IS A FIX, NOT A CHOICE. The model-level check was
/// `key.starts_with("calcula.")`, so `Calcula.strategy` walked past a
/// reservation whose entire purpose is that the generic writer can never
/// replace a document its owning command validates. It did not bite only
/// because every reader looks up the exact lower-case literal — which is luck,
/// not a guard.
pub fn extension_namespace_refusal(key: &str) -> Option<String> {
    if key.len() > MAX_EXTENSION_KEY_BYTES {
        return Some(format!(
            "'{key}' is too long for an extension key: {} bytes, and the limit is {}",
            key.len(),
            MAX_EXTENSION_KEY_BYTES
        ));
    }
    // `get` rather than a slice: a non-ASCII first character is not a char
    // boundary at byte 8, and it is also not `calcula.`, so `None` is the right
    // answer both ways.
    let reserved = key
        .get(..RESERVED_EXTENSION_PREFIX.len())
        .is_some_and(|p| p.eq_ignore_ascii_case(RESERVED_EXTENSION_PREFIX));
    if reserved {
        return Some(format!(
            "the '{RESERVED_EXTENSION_PREFIX}' namespace is reserved for built-in features, so \
             '{key}' cannot be written here; a built-in is written through the command that owns \
             it and validates its shape"
        ));
    }
    let mut parts = key.splitn(2, '.');
    let vendor = parts.next().unwrap_or("");
    let feature = parts.next().unwrap_or("");
    if vendor.trim().is_empty() || feature.trim().is_empty() || key.contains(char::is_whitespace) {
        return Some(format!(
            "extension keys are namespaced 'vendor.feature' with both halves non-empty and no \
             spaces; '{key}' is not"
        ));
    }
    None
}

/// A key in a strategy entry's `x` bag — one user-defined attribute.
///
/// THE BAG IS THE RESERVATION, AND THAT IS THE WHOLE DESIGN. Built-in
/// attributes are FIELDS on `MeasureStrategy` and friends; user attributes are
/// KEYS in `x`. The two never share a key space, so the hazard that motivates
/// every namespacing scheme — a user adds `confidence` today, a built-in
/// `confidence` ships next year, and every model carrying it collides in
/// silence — cannot arise. A future built-in `confidence` is a field. It is not
/// a prefix convention that a careful author has to respect; it is a shape.
///
/// This is why `deny_unknown_fields` survives untouched on every container: `x`
/// is one KNOWN field. Strict outside, open inside one named door.
///
/// Refused at parse time like `IsoDate` and `MonthDay`, and by the same
/// predicate the model-level bag uses, so the two cannot drift.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ExtKey(String);

impl ExtKey {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The vendor half — everything before the first dot.
    ///
    /// Used to group a document's extension keys by who owns them, which is how
    /// a person answers "what is this file carrying that is not mine".
    pub fn vendor(&self) -> &str {
        self.0.split_once('.').map(|(v, _)| v).unwrap_or(&self.0)
    }
}

impl fmt::Display for ExtKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for ExtKey {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match extension_namespace_refusal(s) {
            Some(why) => Err(why),
            None => Ok(ExtKey(s.to_string())),
        }
    }
}

impl Serialize for ExtKey {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ExtKey {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        ExtKey::from_str(&raw).map_err(D::Error::custom)
    }
}

/// One user-defined attribute bag, as it hangs off a strategy entry.
pub type ExtBag = BTreeMap<ExtKey, serde_json::Value>;

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/// Which way is good. The single most consequential field in the document: it is
/// what turns "-4%" into "worse".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    HigherIsBetter,
    LowerIsBetter,
    /// Good means inside a band; both ends are bad. Needs a `Target::Band`.
    TargetBand,
    /// Movement carries no favourability at all (headcount, a mix share).
    Neutral,
}

/// How a measure may be rolled up along a dimension.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Additivity {
    Additive,
    /// Summable along nothing; must be re-evaluated at each grain.
    NonAdditive,
    LastValue,
    FirstValue,
    Average,
    Max,
    Min,
}

/// Per-dimension additivity. A stock balance is `Additive` over Product and
/// `LastValue` over Date, and getting that wrong produces a fact that is simply
/// false rather than merely uninteresting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AggregationSpec {
    pub default: Additivity,
    #[serde(default)]
    pub by_dimension: BTreeMap<String, Additivity>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Unit {
    Currency,
    Percent,
    Ratio,
    Count,
    Duration,
    Other,
}

/// A bound of a `Target::Band` is INCLUSIVE unless the document says otherwise.
///
/// A separate function rather than a literal in the attribute because
/// `#[serde(default)]` on a `bool` means `false`, and "the bound nobody
/// mentioned excludes its own endpoint" is the opposite of what a person writing
/// `low: 90000` means.
fn bound_is_inclusive() -> bool {
    true
}

/// Skip predicate for a bound that is inclusive, i.e. the default. A band whose
/// bounds are both ordinary still serializes as `{low, high}`, which is the form
/// the checked-in corpus and every hand-written document use.
fn is_inclusive(inclusive: &bool) -> bool {
    *inclusive
}

/// What "on target" means. A goal supplied by the business - never an observation.
///
/// INTERNALLY tagged, so a person writes `{"type": "literal", "value": 0.38}`
/// rather than serde's default `{"literal": {"value": 0.38}}`. This document is
/// hand-authored and hand-reviewed; the wire shape is a readability decision,
/// not an implementation detail.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Target {
    Literal { value: f64 },
    /// Another measure in the same model carries the target.
    Measure {
        // `ref` is a Rust keyword; the raw identifier keeps the WIRE name `ref`
        // without a per-field serde rename, which house rules forbid.
        r#ref: String,
    },
    /// Good means landing between `low` and `high`; both ends are bad.
    ///
    /// The inclusivity of each end is part of the band and not a separate
    /// parallel field, because a band whose ends are described somewhere else is
    /// a band that can be half-copied. `rename_all` sits on the VARIANT so the
    /// wire names are `lowInclusive` / `highInclusive` without a per-field
    /// rename, which house rules forbid.
    #[serde(rename_all = "camelCase")]
    Band {
        low: f64,
        high: f64,
        #[serde(default = "bound_is_inclusive", skip_serializing_if = "is_inclusive")]
        low_inclusive: bool,
        #[serde(default = "bound_is_inclusive", skip_serializing_if = "is_inclusive")]
        high_inclusive: bool,
    },
    /// Inherit whatever the model's own KPI declares for this measure.
    Kpi,
}

/// A band's bounds, flattened out of `Target::Band` so the two things that
/// actually ask about a band - "is this value inside it" and "can anything be
/// inside it" - are answered in ONE place.
///
/// Both questions read the inclusivity flags, which is what keeps them from
/// being decoration - but through ONE call site each, and not the ones this
/// comment used to name. `contains` has exactly one caller outside this file's
/// own tests: `side`, directly below, which is the same test plus the end the
/// value missed on. `side` is reached through `band_placement` (model.rs), which
/// `favourability_at` calls to judge a `targetBand` measure and which
/// `facts_for_measure` calls again to STORE the placement on the Change and
/// Variance facts it builds. `band_clause` does not call it: it writes "160,000
/// is above the band" out of the `BandPlacement` the fact already carries.
/// `validate.rs` reads no band at all on that path -
/// `judge_once` CALLS `favourability_at` rather than re-deriving containment,
/// which is the point its own header makes at length, and the comment here
/// credited it with a `contains` call it does not make. What validate.rs does
/// read is `is_empty`, for the `empty-band` finding: a band no value can ever
/// satisfy.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BandBounds {
    pub low: f64,
    pub high: f64,
    pub low_inclusive: bool,
    pub high_inclusive: bool,
}

/// Which side of a band a value landed on.
///
/// `contains` collapses "below" and "above" into one answer, which is all a
/// FAVOURABILITY needs and less than a SENTENCE needs: "160,000, which is worse"
/// and "160,000, which is above the band [90,000, 140,000]" cost the same to
/// produce and only the second tells the reader what to do. Deliberately NOT a
/// new `Favourability` variant - that enum is the generic good/bad axis every
/// fact shares, and band-specific members would be unreachable for three of the
/// four directions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BandSide {
    Below,
    Inside,
    Above,
}

impl BandSide {
    /// The word a sentence uses: "is above the band [90000, 140000]".
    pub fn word(self) -> &'static str {
        match self {
            BandSide::Below => "below",
            BandSide::Inside => "inside",
            BandSide::Above => "above",
        }
    }
}

/// Where a value landed relative to the band that judged it.
///
/// The bounds travel WITH the side because the sentence needs both and a fact
/// that carried only the side would send its reader back to the strategy
/// document to find out which band was meant.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BandPlacement {
    pub side: BandSide,
    pub bounds: BandBounds,
}

impl BandBounds {
    /// Which side of the band this value landed on.
    ///
    /// `contains` is the inside test and this is the same test plus the side it
    /// missed on, so the inclusivity flags are read in exactly one place: a
    /// value sitting exactly on an EXCLUDED low bound is `Below`, not `Inside`.
    pub fn side(&self, value: f64) -> BandSide {
        if self.contains(value) {
            BandSide::Inside
        } else if value < self.low || (value == self.low && !self.low_inclusive) {
            BandSide::Below
        } else {
            BandSide::Above
        }
    }

    /// Is this value inside the band?
    pub fn contains(&self, value: f64) -> bool {
        let above = if self.low_inclusive {
            value >= self.low
        } else {
            value > self.low
        };
        let below = if self.high_inclusive {
            value <= self.high
        } else {
            value < self.high
        };
        above && below
    }

    /// Can NO value be inside it?
    ///
    /// `low > high` is the reversed band; `low == high` is a single point, which
    /// is a legal (if strange) band only while both ends are inclusive. Left
    /// unchecked, either one judges every value unfavourable forever - the exact
    /// mirror of the empty date range validate.rs has always refused.
    pub fn is_empty(&self) -> bool {
        self.low > self.high
            || (self.low == self.high && !(self.low_inclusive && self.high_inclusive))
    }

    /// `[90000, 140000]`, with a round bracket for an excluded end - the
    /// interval notation, so provenance can quote a band without a sentence.
    pub fn label(&self) -> String {
        format!(
            "{}{}, {}{}",
            if self.low_inclusive { "[" } else { "(" },
            self.low,
            self.high,
            if self.high_inclusive { "]" } else { ")" }
        )
    }
}

impl Target {
    /// A band with both ends included, which is what a person writing
    /// `{"type": "band", "low": 90000, "high": 140000}` gets.
    pub fn band(low: f64, high: f64) -> Self {
        Target::Band {
            low,
            high,
            low_inclusive: true,
            high_inclusive: true,
        }
    }

    /// The bounds, when this target is a band.
    pub fn as_band(&self) -> Option<BandBounds> {
        match self {
            Target::Band {
                low,
                high,
                low_inclusive,
                high_inclusive,
            } => Some(BandBounds {
                low: *low,
                high: *high,
                low_inclusive: *low_inclusive,
                high_inclusive: *high_inclusive,
            }),
            _ => None,
        }
    }
}

/// The floor below which a movement is not worth saying out loud.
///
/// Internally tagged for the same readability reason as `Target`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Materiality {
    /// In the measure's own unit.
    Absolute { value: f64 },
    /// A fraction of the baseline, e.g. 0.02 for two percent.
    Relative { value: f64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Cadence {
    Daily,
    Weekly,
    Monthly,
    Quarterly,
    Yearly,
}

impl Cadence {
    /// How many points of a series at this cadence make one natural cycle.
    ///
    /// `cadence`'s FIRST READER. A monthly series has a twelve-point year in it,
    /// and the seasonality scan — which knows nothing about calendars — can pick
    /// a noisier five-point correlation over the real annual one on a short
    /// window. "Revenue repeats every 5 months" is not a claim anybody can act
    /// on; it is a maximum found by a scan that had no idea what a month was.
    /// Telling it the number the reader would recognise fixes that, and costs
    /// `core/insights` no knowledge of calendars: it receives a `usize`.
    ///
    /// HARDCODED ON PURPOSE, and the reasoning is §13.8 of the design doc. The
    /// obvious intuition is that an unwritten consumer is the natural place to
    /// ask "could a user have written this?" — but this one is not, because
    /// cadence's OTHER consumer is period bucketing, which is query planning,
    /// and a producer never influences a query. The first instance of a pattern
    /// must not be the case the pattern forbids.
    ///
    /// `Yearly` gets `None`: a cycle above a year needs years of history the
    /// series will not have, so there is no lag worth preferring.
    pub fn expected_cycle(self) -> Option<usize> {
        match self {
            // A week, not a year. Daily data long enough to carry an annual
            // cycle is rare, and the weekly rhythm is the one a reader sees.
            Cadence::Daily => Some(7),
            Cadence::Weekly => Some(52),
            Cadence::Monthly => Some(12),
            Cadence::Quarterly => Some(4),
            Cadence::Yearly => None,
        }
    }
}

/// What a column is FOR, which decides whether it may scope a rule or slice a
/// fact. Keys and labels can do neither: slicing revenue by invoice id produces
/// one fact per invoice and says nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    Key,
    Analysis,
    Label,
    Filter,
    Hierarchy,
    Ignore,
}

impl Role {
    /// Roles a rule scope and a fact slice may name.
    pub fn may_scope(self) -> bool {
        matches!(self, Role::Analysis | Role::Filter | Role::Hierarchy)
    }
}

/// Who put this entry here.
///
/// `reviewed` answers "has a person signed this off"; it cannot tell a machine's
/// guess from a person's statement from an entry nobody has ever filled in. The
/// Strategy tab was showing an "inferred" badge next to a Confirm button on rows
/// where every value was absent, so Confirm did nothing and taught people to
/// click it without reading. An absent `source` is the third state: untouched.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntrySource {
    /// Written by `infer`, from the model and the workbook's own usage.
    Inferred,
    /// Typed by a person.
    Authored,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TableKind {
    Fact,
    Dimension,
    Bridge,
    Calendar,
    Other,
}

impl TableKind {
    /// The wire spelling - the word the dropdown shows and the document stores.
    ///
    /// It lives on the type so that a message quoting a kind back at a person
    /// does not spell one by hand. IT HAS NOT FINISHED THAT JOB, and this comment
    /// used to say it had, naming three files that route through it. Outside
    /// this file's own tests it has two callers, and one of them is the
    /// `Display` impl directly below - so every `{kind}` in a format string is
    /// a third-party caller too. The only other is `kind_conflict_notes`
    /// (`model_commands.rs`); `validate.rs` still carries its own `table_kind_label` match for the
    /// finding it prints, and the tab spells the five words a third time in
    /// `TABLE_KINDS` (`ModelEditor/lib/strategyTypes.ts`). Of the three, only the
    /// tab's is actually diffed against this enum - `strategyTypes.test.ts`
    /// parses the variants out of this file. The three AGREE today; the risk is
    /// that nothing keeps `table_kind_label` agreeing, so a variant renamed here
    /// would leave a validator finding printing the old word beside a run note
    /// printing the new one. Pointing that one match at this method is the cheap
    /// fix.
    pub fn label(self) -> &'static str {
        match self {
            TableKind::Fact => "fact",
            TableKind::Dimension => "dimension",
            TableKind::Bridge => "bridge",
            TableKind::Calendar => "calendar",
            TableKind::Other => "other",
        }
    }
}

impl fmt::Display for TableKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.label())
    }
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/// One column's constraint inside a scope.
///
/// UNTAGGED, so a member list is written as the bare array a person reaches for
/// — `{"Product[Category]": ["Gadgets"]}` — rather than serde's default
/// `{"Product[Category]": {"members": ["Gadgets"]}}`. A list of members and an
/// object with `from`/`to` cannot be confused for each other, so the untagged
/// form is unambiguous as well as readable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged, rename_all = "camelCase")]
pub enum ScopeValue {
    Members(Vec<String>),
    /// Inclusive ISO-8601 `YYYY-MM-DD` bounds. `to` may be omitted, which means
    /// "from this date onwards" — the way a business rule is actually stated
    /// ("the Nordics floor took effect in 2025"), and the way it stays true
    /// when next year's data arrives.
    ///
    /// The format is not cosmetic. overlap.rs compares these bounds as STRINGS,
    /// which is exact for zero-padded ISO-8601 and wrong for anything else, so
    /// `IsoDate` refuses a malformed bound WHERE IT IS READ rather than letting
    /// the overlap checker quietly conclude "disjoint".
    DateRange {
        from: IsoDate,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to: Option<IsoDate>,
    },
}

/// `ScopeValue` as it arrives, before the bounds are validated.
///
/// AN UNTAGGED ENUM SWALLOWS ITS INNER ERROR. Deriving `Deserialize` straight
/// onto `ScopeValue` made a malformed date report "data did not match any
/// variant of untagged enum ScopeValue" - serde tries each variant, discards
/// whatever each one said and reports only that none matched. That is a WORSE
/// message than the validation finding it replaced, which quoted the offending
/// bound and explained why the form matters.
///
/// Splitting it in two fixes that: this step decides only "array or object",
/// and the bounds are parsed afterwards where the error is ours to write.
///
/// THE STEP IS HAND-WRITTEN BECAUSE `deny_unknown_fields` COULD NOT DO THE JOB
/// HERE, and while it was derived `untagged` this type was the one hole in the
/// module header's "a typo must be an error, not a shrug". A scope written
/// `{"from": "2025-01-01", "too": "2025-06-30"}` parsed as an OPEN-ENDED range
/// with the second key dropped in silence - the rule then ran on for every
/// period after the start date, which is the same class of defect as the
/// `suppress` spelling that gave `SuppressibleFactKind` its type. Measured
/// both ways before this was written: derived and untagged, that JSON parses
/// happily; adding `deny_unknown_fields` to the untagged enum DOES refuse it,
/// but serde then reports "data did not match any variant of untagged enum
/// RawScopeValue" and never names `too` - the exact message this split exists
/// to avoid. A visitor answers both at once: it dispatches on the shape it is
/// handed, so there is no variant-trying to swallow anything, and an unexpected
/// key is refused BY NAME against the two this range has.
enum RawScopeValue {
    Members(Vec<String>),
    DateRange {
        from: String,
        to: Option<String>,
    },
}

/// The two keys a date range may carry, for a refusal that can name them.
const DATE_RANGE_FIELDS: &[&str] = &["from", "to"];

struct RawScopeValueVisitor;

impl<'de> serde::de::Visitor<'de> for RawScopeValueVisitor {
    type Value = RawScopeValue;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(
            "a list of members, or a date range object with 'from' and an optional 'to'",
        )
    }

    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        let mut members = Vec::new();
        while let Some(m) = seq.next_element::<String>()? {
            members.push(m);
        }
        Ok(RawScopeValue::Members(members))
    }

    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut from: Option<String> = None;
        let mut to: Option<String> = None;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "from" => {
                    if from.is_some() {
                        return Err(serde::de::Error::duplicate_field("from"));
                    }
                    from = Some(map.next_value()?);
                }
                "to" => {
                    if to.is_some() {
                        return Err(serde::de::Error::duplicate_field("to"));
                    }
                    to = map.next_value()?;
                }
                other => return Err(serde::de::Error::unknown_field(other, DATE_RANGE_FIELDS)),
            }
        }
        let from = from.ok_or_else(|| serde::de::Error::missing_field("from"))?;
        Ok(RawScopeValue::DateRange { from, to })
    }
}

impl<'de> Deserialize<'de> for RawScopeValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(RawScopeValueVisitor)
    }
}

impl<'de> Deserialize<'de> for ScopeValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match RawScopeValue::deserialize(deserializer)? {
            RawScopeValue::Members(members) => Ok(ScopeValue::Members(members)),
            RawScopeValue::DateRange { from, to } => Ok(ScopeValue::DateRange {
                from: from.parse().map_err(D::Error::custom)?,
                to: to
                    .map(|t| t.parse::<IsoDate>())
                    .transpose()
                    .map_err(D::Error::custom)?,
            }),
        }
    }
}

impl ScopeValue {
    /// An inclusive range with both bounds.
    ///
    /// PANICS on a bound that is not `YYYY-MM-DD`. This is a constructor for
    /// code that writes a date LITERAL, where a bad bound is a programmer error
    /// and the wrong answer is to build a value the overlap checker cannot reason
    /// about. Every caller today is a TEST - in this file, overlap.rs and
    /// validate.rs. The checked-in strategy fixture is JSON and arrives through
    /// `Deserialize` like any other document, and "the CLI's own canned scopes",
    /// which this comment used to list, is a caller that does not exist.
    /// Anything reading a date from outside goes through `IsoDate::from_str`.
    #[track_caller]
    pub fn between(from: &str, to: &str) -> Self {
        ScopeValue::DateRange {
            from: from.parse().expect("a literal date bound must be YYYY-MM-DD"),
            to: Some(to.parse().expect("a literal date bound must be YYYY-MM-DD")),
        }
    }

    /// An open-ended range: everything from `from` onwards. Panics like
    /// `between`, and for the same reason.
    #[track_caller]
    pub fn from_onwards(from: &str) -> Self {
        ScopeValue::DateRange {
            from: from.parse().expect("a literal date bound must be YYYY-MM-DD"),
            to: None,
        }
    }
}

/// A finite region of the analysis space: column -> allowed members.
///
/// A column absent from the map is UNCONSTRAINED, which is why `{Dept: [A]}` and
/// `{Region: [Nordics]}` intersect - both admit the point (Dept=A, Region=Nordics).
pub type Scope = BTreeMap<QualifiedColumn, ScopeValue>;

// ---------------------------------------------------------------------------
// The attribute set a rule may set - and nothing more
// ---------------------------------------------------------------------------

/// The one and only payload a `Rule` may carry.
///
/// Read the module header before adding a field. Every member here either
/// reinterprets a number the model computed, removes a fact kind, or reorders
/// ranking. None of them can introduce a number.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttributeSet {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<Direction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<Target>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub materiality: Option<Materiality>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cadence: Option<Cadence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aggregation: Option<AggregationSpec>,
    /// Fact KINDS to withhold in this scope (e.g. `contribution`, `trend`). It
    /// can only take facts away.
    ///
    /// TYPED, so a near-miss cannot reach the engine. It was a `Vec<String>`,
    /// and a near-miss withheld nothing while looking exactly like an
    /// instruction - the fact the author asked to hide was PUBLISHED. This very
    /// comment used to give `"outlier"` as its example, and it was wrong twice
    /// over: the core engine's own key for that fact is the PLURAL `"outliers"`,
    /// and a model run never wraps an outlier fact anyway. A comment can drift
    /// from a parser; a variant list is the parser.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub suppress: Vec<SuppressibleFactKind>,
    /// Multiplier on this measure's ranking score in this scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rank_weight: Option<f64>,
}

/// The attributes a rule can address, as a first-class value.
///
/// overlap.rs groups conflicts by attribute and resolve.rs layers attribute by
/// attribute, so this enum is the axis both of them iterate; a new member of
/// `AttributeSet` that is not added here is invisible to BOTH, which is why
/// `AttributeSet::touched` is written as an exhaustive match rather than a list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Attribute {
    Direction,
    Target,
    Materiality,
    Cadence,
    Aggregation,
    Suppress,
    RankWeight,
}

impl fmt::Display for Attribute {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Attribute::Direction => "direction",
            Attribute::Target => "target",
            Attribute::Materiality => "materiality",
            Attribute::Cadence => "cadence",
            Attribute::Aggregation => "aggregation",
            Attribute::Suppress => "suppress",
            Attribute::RankWeight => "rankWeight",
        };
        f.write_str(s)
    }
}

impl AttributeSet {
    /// Which attributes this set actually addresses.
    ///
    /// Written as a destructuring match on purpose: adding a field to
    /// `AttributeSet` without deciding what it means here is a COMPILE ERROR,
    /// which is the only reliable way to keep the overlap checker honest.
    pub fn touched(&self) -> Vec<Attribute> {
        let AttributeSet {
            direction,
            target,
            materiality,
            cadence,
            aggregation,
            suppress,
            rank_weight,
        } = self;
        let mut out = Vec::new();
        if direction.is_some() {
            out.push(Attribute::Direction);
        }
        if target.is_some() {
            out.push(Attribute::Target);
        }
        if materiality.is_some() {
            out.push(Attribute::Materiality);
        }
        if cadence.is_some() {
            out.push(Attribute::Cadence);
        }
        if aggregation.is_some() {
            out.push(Attribute::Aggregation);
        }
        if !suppress.is_empty() {
            out.push(Attribute::Suppress);
        }
        if rank_weight.is_some() {
            out.push(Attribute::RankWeight);
        }
        out
    }

    pub fn is_empty(&self) -> bool {
        self.touched().is_empty()
    }
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/// Model-wide defaults.
///
/// It carries `reviewed`/`source` for the same reason every measure and table
/// entry does, and one of its four fields is the reason it matters most:
/// `defaultTimeAxis` may be a GUESS - `facts.rs` infers a calendar when nobody
/// marked one - and a guessed calendar drives every trend, seasonality and
/// change-point claim in the report. Without a badge and a Confirm on this
/// block, that guess is the one thing in the document a person cannot accept.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelStrategy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_time_axis: Option<QualifiedColumn>,
    /// `MM-DD`, e.g. `"04-01"` for an April fiscal year. NOTHING READS IT YET -
    /// see `MonthDay`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fiscal_year_start: Option<MonthDay>,
    /// The currency every money measure in this model is reported in.
    ///
    // `reporting_currency` WAS HERE AND IS DELETED. It was authored, mirrored
    // into TypeScript, given a validating `CurrencyCode` newtype - and read by
    // NOTHING: `infer` wrote `None`, and no formatter in `model.rs`,
    // `model_commands.rs` or `report.rs` ever looked it up. Typing it made it a
    // STRICTER inert field, which is effort spent making a decoration rigorous.
    //
    // Deleting is also the cheaper reversal: re-adding a field once a formatter
    // exists costs less than carrying one that never gets used, and this file's
    // standing rule is that nothing becomes authorable until it has a reader.
    // `unit` and `cadence` were kept where this was dropped, because both have a
    // designed reader coming and this had none.
    /// Measure names, most important first.
    ///
    /// NOT A TIE-BREAK, which is what this line used to call it. `resolve` turns
    /// a name's POSITION here into that measure's `priority` whenever the measure
    /// entry states none of its own, and three things then read that number, none
    /// of them as a tie-break: `choose_measures` (model.rs) analyses these
    /// measures FIRST and truncates the rest away, `fact_score` (model.rs) adds
    /// `0.10 / (1.0 + priority)` to every fact's rank, and `build_report`
    /// (report.rs) sorts rows by priority and breaks ITS ties by name.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub priority: Vec<String>,
    /// Has a human confirmed this block? BLOCK-LEVEL: one badge for four
    /// fields, which is the same granularity a measure row already has.
    #[serde(default)]
    pub reviewed: bool,
    /// Who wrote this block. Absent means nobody has - see `EntrySource`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<EntrySource>,
    /// USER-DEFINED ATTRIBUTES. The one open door in a schema that refuses
    /// every other unknown key, and the engine reads NOTHING out of it - see
    /// `ExtKey` for why the bag rather than a prefix is the design.
    ///
    /// Its guarantee is ROUND-TRIP FIDELITY, NOT CONSUMPTION, which is the
    /// narrow carve-out from "nothing becomes authorable until it has a
    /// reader": what a user puts here is theirs, travels with the model, and
    /// is never interpreted. A built-in that wants meaning gets a field.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub x: ExtBag,
}

/// Everything the strategy says about one measure, outside any scope.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MeasureStrategy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<Direction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aggregation: Option<AggregationSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<Unit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<Target>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub materiality: Option<Materiality>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cadence: Option<Cadence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<u32>,
    /// Columns worth breaking this measure down by.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub analysis_dimensions: Vec<QualifiedColumn>,
    /// Columns that must never appear in a fact about this measure - the
    /// meaningless (invoice id) and the sensitive (employee name) alike.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub never_slice_by: Vec<QualifiedColumn>,
    /// PROSE. Reaches the narrative layer's wording and nothing else. It cannot
    /// change which facts exist or how they rank.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    /// Has a human confirmed this entry? A generated draft is `false` and the
    /// validator warns until someone looks at it.
    #[serde(default)]
    pub reviewed: bool,
    /// Who wrote this entry. Absent means nobody has - see `EntrySource`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<EntrySource>,
    /// USER-DEFINED ATTRIBUTES. The one open door in a schema that refuses
    /// every other unknown key, and the engine reads NOTHING out of it - see
    /// `ExtKey` for why the bag rather than a prefix is the design.
    ///
    /// Its guarantee is ROUND-TRIP FIDELITY, NOT CONSUMPTION, which is the
    /// narrow carve-out from "nothing becomes authorable until it has a
    /// reader": what a user puts here is theirs, travels with the model, and
    /// is never interpreted. A built-in that wants meaning gets a field.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub x: ExtBag,
}

// NO `Eq`: the `x` bag holds `serde_json::Value`, which is PartialEq and not Eq
// (a JSON number can be a NaN float). Nothing compares these for total equality.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ColumnStrategy {
    pub role: Role,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<u32>,
    /// USER-DEFINED ATTRIBUTES. The one open door in a schema that refuses
    /// every other unknown key, and the engine reads NOTHING out of it - see
    /// `ExtKey` for why the bag rather than a prefix is the design.
    ///
    /// Its guarantee is ROUND-TRIP FIDELITY, NOT CONSUMPTION, which is the
    /// narrow carve-out from "nothing becomes authorable until it has a
    /// reader": what a user puts here is theirs, travels with the model, and
    /// is never interpreted. A built-in that wants meaning gets a field.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub x: ExtBag,
}

// NO `Eq`, for the same reason as `ColumnStrategy` above.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableStrategy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<TableKind>,
    /// The column a reader recognises a row by ("Product Name", not "ProductKey").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_column: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub columns: BTreeMap<String, ColumnStrategy>,
    /// Coarse-to-fine column chains, e.g. `[["Country", "Region", "City"]]`.
    ///
    /// A COPY of the model's own hierarchies when `infer` wrote it, and a place
    /// to state one the model does not declare otherwise. Validation reads the
    /// UNION of this and `TableFacts::hierarchies`, so neither source can hide a
    /// level from the other.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hierarchies: Vec<Vec<String>>,
    #[serde(default)]
    pub reviewed: bool,
    /// Who wrote this entry. Absent means nobody has - see `EntrySource`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<EntrySource>,
    /// USER-DEFINED ATTRIBUTES. The one open door in a schema that refuses
    /// every other unknown key, and the engine reads NOTHING out of it - see
    /// `ExtKey` for why the bag rather than a prefix is the design.
    ///
    /// Its guarantee is ROUND-TRIP FIDELITY, NOT CONSUMPTION, which is the
    /// narrow carve-out from "nothing becomes authorable until it has a
    /// reader": what a user puts here is theirs, travels with the model, and
    /// is never interpreted. A built-in that wants meaning gets a field.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub x: ExtBag,
}

/// A scoped override. It ANNOTATES facts; it cannot generate one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub id: String,
    pub measure: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub scope: Scope,
    pub set: AttributeSet,
    /// PROSE. Wording only - see the module header.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// "Q3 2025 was the ERP cutover." Pure prose attached to a region.
///
/// It has no `set` at all, which is the structural reason a period annotation can
/// never change which facts appear: it is the wording channel, full stop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeriodAnnotation {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub measure: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub scope: Scope,
    pub note: String,
}

/// The hypothetical movement an inline test asks the resolver to judge.
///
/// A test states a movement it INVENTS; it never claims the model contains one.
/// That is why this lives on `StrategyTest` and not anywhere near `AttributeSet`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestGiven {
    /// Signed movement in the measure's own unit.
    pub delta: f64,
    /// The value the measure LANDED at, which decides whether a `Variance` fact
    /// exists at this point at all.
    ///
    /// NOT "needed only to judge a `TargetBand` direction", which is what this
    /// line used to say and what stopped being true when the harness learned that
    /// a variance is judged outside the materiality gate. `variance_at`
    /// (validate.rs) reads `given.value` BEFORE it reads the target and returns
    /// `NotBuilt` without it - under every target shape and every direction - so
    /// a test that omits it is judged as though the run made no comparison of
    /// levels, and is refused as under-specified (`test-needs-value`) wherever
    /// freeing the value would change the verdict. It is separately what
    /// `favourability_at` reads to place a value inside or outside a band. The
    /// shipped fixture's two Revenue tests state one; its Cost tests, whose
    /// measure resolves no target, do not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    /// What `delta` was measured from, needed only for relative materiality.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline: Option<f64>,
}

/// What an inline test asserts the engine will say.
///
/// `Ord` is derived because the test runner collects the statuses REACHABLE from
/// a `given` into a set and asks whether the expectation is one of them; the
/// order is the declaration order and carries no meaning of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExpectedStatus {
    Favourable,
    Unfavourable,
    Neutral,
    /// THE RUN MAKES NO JUDGEMENT ABOUT THIS MEASURE AT THIS POINT.
    ///
    /// NOT A SYNONYM FOR `Neutral`, and the whole reason this variant exists.
    /// `neutral` is a judgement stated BESIDE a fact the engine emitted — this
    /// movement happened and is neither good nor bad. `immaterial` asserts the
    /// ABSENCE of any judgement, which needs both halves to hold:
    ///
    ///   * the movement is below the materiality floor, so
    ///     `insights::model::facts_for_measure` builds no `Change` fact
    ///     (`clears_materiality` gates it), AND
    ///   * no target resolves to a NUMBER, so no `Variance` fact is built
    ///     either. That branch sits OUTSIDE the materiality gate and needs only
    ///     `observation.target_value`, which `model_commands.rs` fills in for a
    ///     `Target::Literal` and a `Target::Measure`.
    ///
    /// WHEN A TARGET RESOLVES TO A NUMBER *AND* THE TEST STATES `given.value`,
    /// `immaterial` is unreachable and asserting it is refused: the `Variance`
    /// fact judges the LEVEL and carries
    /// `favourability_at(resolved, Some(value), delta)`, which is a judgement.
    /// That is right rather than a workaround: materiality is a property of a
    /// MOVEMENT, a variance against target is a comparison of LEVELS, and a tiny
    /// movement can still sit far from target. Gating the `Variance` fact on
    /// movement-materiality would be the wrong fix.
    ///
    /// BOTH HALVES OF THAT CONDITION CARRY WEIGHT, and this comment used to
    /// state only the first. `variance_at` reads `given.value` before it reads
    /// the target, so a test that omits the value builds no `Variance` fact and
    /// `judge_once` answers `Immaterial` after all - the verdict itself is not
    /// unreachable there. What refuses such a test is the OTHER gate: freeing the
    /// omitted value reaches a different verdict, `determined` comes back holding
    /// two answers, and `run_inline_tests` reports `test-needs-value` naming the
    /// number to add. Refused either way, but by a different finding and with a
    /// different thing to do about it. A band target, a KPI target that resolved
    /// to no number, and a literal target of ZERO each make `variance_at` answer
    /// `NotBuilt` whatever the test states, so `immaterial` stays reachable and
    /// assertable under all three.
    ///
    /// WHAT BELOW-THE-FLOOR IS ACTUALLY SILENT ABOUT IS THE FAVOURABILITY, AND
    /// ONLY THAT. `model.rs` sets `prior_label`, `prior_value`, `delta` and `pct`
    /// UNCONDITIONALLY, before the gate, and `report.rs` prints all four into the
    /// report row; only `favourability` is inside the gate, so the Status cell
    /// reads "No claim" unless a KPI band fills it. The accurate sentence is "no
    /// `Change` FACT, so no favourability — the numbers are still printed", not
    /// "nothing in the report".
    ///
    /// The inline-test harness used to answer `neutral` for both, so a
    /// consultant's assertion could go green over a point the run makes no claim
    /// about — a green tick meaning absence of evidence. Pinning the floor is a
    /// legitimate thing to assert ("a 900 kr move in Cost is noise and must not
    /// be judged"), which is why it gets a word rather than a refusal.
    Immaterial,
    /// The engine must say nothing about favourability here.
    Suppressed,
}

impl fmt::Display for ExpectedStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            ExpectedStatus::Favourable => "favourable",
            ExpectedStatus::Unfavourable => "unfavourable",
            ExpectedStatus::Neutral => "neutral",
            ExpectedStatus::Immaterial => "immaterial",
            ExpectedStatus::Suppressed => "suppressed",
        };
        f.write_str(s)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestExpect {
    pub status: ExpectedStatus,
    /// Optionally, the rule id that must be the one that decided it. This is what
    /// turns "the answer happens to be right" into "the answer is right for the
    /// reason I intended".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_by: Option<String>,
}

/// A consultant's own assertion about their file, run by the validator.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StrategyTest {
    pub measure: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub scope: Scope,
    pub given: TestGiven,
    pub expect: TestExpect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StrategyDoc {
    pub version: u32,
    #[serde(default)]
    pub model: ModelStrategy,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub measures: BTreeMap<String, MeasureStrategy>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tables: BTreeMap<String, TableStrategy>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<Rule>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub periods: Vec<PeriodAnnotation>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tests: Vec<StrategyTest>,
    /// What each `x` key in this document is supposed to look like.
    ///
    /// WITHOUT THIS, THE OPEN DOOR REINTRODUCES THE BUG IT WAS OPENED BESIDE.
    /// The whole point of `deny_unknown_fields` everywhere else is that a typo
    /// is an error rather than a shrug - and `x` is a map, so `acme.slaTeir`
    /// would otherwise be a perfectly good key that nothing reads. A user who
    /// declares their own attributes gets the same protection for them that the
    /// built-ins have.
    ///
    /// Declaring is OPTIONAL, and that asymmetry is deliberate: an undeclared
    /// key is a WARNING and still saves, because a hand-edited `x` on a model
    /// whose author never wrote a schema must not be fatal. Strictness inside
    /// the namespace differs from strictness outside it by SEVERITY, never by
    /// silence.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extensions: BTreeMap<ExtKey, ExtensionDecl>,
}

/// The declared shape of one user-defined attribute.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionDecl {
    /// The JSON shape values must take.
    ///
    /// A RAW IDENTIFIER, not a per-field `rename`. `type` is a Rust keyword and
    /// the wire word a person expects; serde strips the `r#` and the
    /// struct-level `rename_all` does the rest, so the house rule against
    /// per-field renames holds.
    pub r#type: ExtValueType,
    /// When non-empty, the only values allowed. String-typed keys only - a
    /// closed set of numbers is a range, and this is not trying to be JSON
    /// Schema.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed: Vec<String>,
    /// What it means, for whoever opens the file next. Prose; nothing reads it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// The JSON shapes a declared extension value may take.
///
/// DELIBERATELY FOUR, NOT JSON SCHEMA. The job is catching a typo and a wrong
/// shape, not expressing a grammar; a validator nobody can predict is worse
/// than no validator. `Any` exists so a user can declare a key they know is
/// structured without being forced to describe it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExtValueType {
    Text,
    Number,
    Boolean,
    Any,
}

impl ExtValueType {
    /// Does `value` match this declared shape?
    pub fn admits(self, value: &serde_json::Value) -> bool {
        match self {
            ExtValueType::Text => value.is_string(),
            ExtValueType::Number => value.is_number(),
            ExtValueType::Boolean => value.is_boolean(),
            ExtValueType::Any => true,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ExtValueType::Text => "text",
            ExtValueType::Number => "number",
            ExtValueType::Boolean => "boolean",
            ExtValueType::Any => "any",
        }
    }
}

impl Default for StrategyDoc {
    fn default() -> Self {
        Self {
            version: STRATEGY_DOC_VERSION,
            model: ModelStrategy::default(),
            measures: BTreeMap::new(),
            tables: BTreeMap::new(),
            rules: Vec::new(),
            periods: Vec::new(),
            tests: Vec::new(),
            extensions: BTreeMap::new(),
        }
    }
}

impl StrategyDoc {
    /// The declared role of a column, if the document declares one.
    pub fn role_of(&self, col: &QualifiedColumn) -> Option<Role> {
        self.tables
            .get(&col.table)
            .and_then(|t| t.columns.get(&col.column))
            .map(|c| c.role)
    }

    /// Does any declared hierarchy in the column's table name it?
    ///
    /// A column can earn the right to scope a rule either by declaring
    /// `role: hierarchy` or by appearing in a hierarchy chain; requiring both
    /// would reject the ordinary case where the chain IS the declaration.
    pub fn in_a_hierarchy(&self, col: &QualifiedColumn) -> bool {
        self.tables
            .get(&col.table)
            .map(|t| t.hierarchies.iter().any(|h| h.iter().any(|c| c == &col.column)))
            .unwrap_or(false)
    }

    /// May this column constrain a rule scope or slice a fact?
    pub fn may_scope(&self, col: &QualifiedColumn) -> bool {
        match self.role_of(col) {
            Some(role) => role.may_scope() || self.in_a_hierarchy(col),
            // Undeclared is not refused: the strategy file is allowed to be
            // partial, and refusing every undeclared column would make an empty
            // `tables` section reject every rule in the document. validate.rs
            // warns instead.
            None => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_qualified_column_prints_and_parses_as_table_bracket_column() {
        let qc = QualifiedColumn::new("Sales", "Region");
        assert_eq!(qc.to_string(), "Sales[Region]");
        assert_eq!(QualifiedColumn::from_str("Sales[Region]").unwrap(), qc);
    }

    #[test]
    fn a_qualified_column_keeps_spaces_inside_both_halves() {
        let qc = QualifiedColumn::from_str("Sales Orders[Order Date]").unwrap();
        assert_eq!(qc.table, "Sales Orders");
        assert_eq!(qc.column, "Order Date");
    }

    #[test]
    fn a_malformed_qualified_column_reports_why_rather_than_guessing() {
        for (input, needle) in [
            ("Sales", "no '['"),
            ("Sales[Region", "does not end with ']'"),
            ("[Region]", "table name is empty"),
            ("Sales[]", "column name is empty"),
            ("Sales[Re[gion]", "contains a bracket"),
        ] {
            let err = QualifiedColumn::from_str(input).unwrap_err();
            assert!(
                err.to_string().contains(needle),
                "'{input}' should have reported '{needle}', reported '{err}'"
            );
        }
    }

    #[test]
    fn a_qualified_column_serializes_as_a_bare_string_so_it_can_be_a_map_key() {
        let mut scope: Scope = Scope::new();
        scope.insert(
            QualifiedColumn::new("Dim", "Dept"),
            ScopeValue::Members(vec!["A".into()]),
        );
        let json = serde_json::to_string(&scope).unwrap();
        // The column is a bare string BECAUSE it is a map key, and the member
        // list is a bare array because `ScopeValue` is untagged. Together those
        // give the form a person actually writes; this test pins both, because
        // this document is hand-authored and its wire shape is part of its
        // contract with the people who write it.
        assert_eq!(json, r#"{"Dim[Dept]":["A"]}"#);
        let back: Scope = serde_json::from_str(&json).unwrap();
        assert_eq!(back, scope);
    }

    #[test]
    fn an_open_ended_date_range_round_trips_and_omits_its_missing_end() {
        // "The Nordics floor took effect in 2025" has no end date, and writing
        // one in would make the rule quietly stop applying next year.
        let mut scope: Scope = Scope::new();
        scope.insert(
            QualifiedColumn::new("Date", "Date"),
            ScopeValue::from_onwards("2025-01-01"),
        );
        let json = serde_json::to_string(&scope).unwrap();
        assert_eq!(json, r#"{"Date[Date]":{"from":"2025-01-01"}}"#);
        assert_eq!(serde_json::from_str::<Scope>(&json).unwrap(), scope);

        let closed = r#"{"Date[Date]":{"from":"2025-01-01","to":"2025-06-30"}}"#;
        assert_eq!(
            serde_json::from_str::<Scope>(closed).unwrap()[&QualifiedColumn::new("Date", "Date")],
            ScopeValue::between("2025-01-01", "2025-06-30")
        );
    }

    #[test]
    fn a_typo_in_a_date_range_key_is_refused_by_name_and_not_read_as_an_open_ended_range() {
        // THE ONE PLACE `deny_unknown_fields` COULD NOT REACH. `ScopeValue`
        // deserializes through `RawScopeValue`, which decides "array or object"
        // by SHAPE rather than by field name; while that step was a derived
        // untagged enum, `too` was simply not a field it knew and the range came
        // back open-ended - so the rule went on applying to every period after
        // the start date and nothing anywhere said why. The attribute is not the
        // repair either: on an untagged enum it refuses the document but reports
        // "data did not match any variant", which names neither the key nor the
        // range. The visitor names it.
        let typo = r#"{"version":1,"rules":[
            {"id":"r1","measure":"Returns",
             "scope":{"Date[Date]":{"from":"2025-01-01","too":"2025-06-30"}},
             "set":{"cadence":"monthly"}}
        ]}"#;
        let err = serde_json::from_str::<StrategyDoc>(typo).unwrap_err().to_string();
        assert!(err.contains("too"), "the error must quote the typo: {err}");
        assert!(
            err.contains("from") && err.contains("to"),
            "and list the keys a range has: {err}"
        );

        // POSITIVE CONTROLS, so the refusal is about the unknown key and not
        // about the object shape: both legal spellings still parse, and a member
        // list is untouched by any of this.
        let key = QualifiedColumn::new("Date", "Date");
        let closed: Scope =
            serde_json::from_str(r#"{"Date[Date]":{"from":"2025-01-01","to":"2025-06-30"}}"#)
                .unwrap();
        assert_eq!(closed[&key], ScopeValue::between("2025-01-01", "2025-06-30"));
        let open: Scope = serde_json::from_str(r#"{"Date[Date]":{"from":"2025-01-01"}}"#).unwrap();
        assert_eq!(open[&key], ScopeValue::from_onwards("2025-01-01"));
        let members: Scope = serde_json::from_str(r#"{"Date[Date]":["Q1","Q2"]}"#).unwrap();
        assert_eq!(
            members[&key],
            ScopeValue::Members(vec!["Q1".into(), "Q2".into()])
        );

        // An explicit null end is the same statement as an absent one, which is
        // what the derived form allowed and the visitor must keep allowing.
        let nulled: Scope =
            serde_json::from_str(r#"{"Date[Date]":{"from":"2025-01-01","to":null}}"#).unwrap();
        assert_eq!(nulled[&key], ScopeValue::from_onwards("2025-01-01"));

        // A range with no start is refused by name too, rather than falling
        // through to "not a member list either".
        let no_start = serde_json::from_str::<Scope>(r#"{"Date[Date]":{"to":"2025-06-30"}}"#)
            .unwrap_err()
            .to_string();
        assert!(no_start.contains("from"), "{no_start}");

        // ...and the inner error still survives, which is the whole reason the
        // two-step split exists: a malformed bound quotes itself.
        let bad_bound = serde_json::from_str::<Scope>(r#"{"Date[Date]":{"from":"1/4/2025"}}"#)
            .unwrap_err()
            .to_string();
        assert!(bad_bound.contains("1/4/2025"), "{bad_bound}");
    }

    #[test]
    fn an_unknown_field_anywhere_in_the_document_is_an_error_not_a_shrug() {
        // The whole point of deny_unknown_fields: a typo must not parse.
        let json = r#"{
            "version": 1,
            "measures": { "Revenue": { "direktion": "higherIsBetter" } }
        }"#;
        let err = serde_json::from_str::<StrategyDoc>(json).unwrap_err();
        assert!(
            err.to_string().contains("direktion"),
            "the error should quote the typo, said: {err}"
        );
    }

    #[test]
    fn a_minimal_document_needs_only_a_version() {
        let doc: StrategyDoc = serde_json::from_str(r#"{"version":1}"#).unwrap();
        assert_eq!(doc.version, 1);
        assert!(doc.rules.is_empty());
        assert!(doc.measures.is_empty());
    }

    #[test]
    fn a_target_measure_reference_uses_the_wire_name_ref() {
        let t = Target::Measure {
            r#ref: "Budget".into(),
        };
        // Internally tagged, so the discriminant reads as a field. The raw
        // identifier keeps the wire name `ref` without a per-field serde
        // rename, which house rules forbid.
        assert_eq!(serde_json::to_string(&t).unwrap(), r#"{"type":"measure","ref":"Budget"}"#);
        assert_eq!(
            serde_json::to_string(&Target::Kpi).unwrap(),
            r#"{"type":"kpi"}"#,
            "a unit variant still carries its tag, so `target` is never a bare string"
        );
        assert_eq!(
            serde_json::to_string(&Materiality::Absolute { value: 2.5 }).unwrap(),
            r#"{"type":"absolute","value":2.5}"#
        );
    }

    #[test]
    fn the_document_round_trips_through_json_unchanged() {
        let mut doc = StrategyDoc::default();
        doc.model.priority = vec!["Revenue".into()];
        doc.measures.insert(
            "Revenue".into(),
            MeasureStrategy {
                direction: Some(Direction::HigherIsBetter),
                unit: Some(Unit::Currency),
                materiality: Some(Materiality::Relative { value: 0.02 }),
                context: Some("Net of returns.".into()),
                reviewed: true,
                ..Default::default()
            },
        );
        doc.rules.push(Rule {
            id: "r1".into(),
            measure: "Revenue".into(),
            scope: Scope::new(),
            set: AttributeSet {
                direction: Some(Direction::LowerIsBetter),
                ..Default::default()
            },
            note: None,
        });
        let json = serde_json::to_string(&doc).unwrap();
        let back: StrategyDoc = serde_json::from_str(&json).unwrap();
        assert_eq!(back, doc);
    }

    #[test]
    fn an_entry_source_is_optional_on_the_wire_and_absent_means_untouched() {
        // A document written before `source` existed must still parse under
        // `deny_unknown_fields`, and an entry nobody has written must be
        // distinguishable from one a machine guessed.
        let doc: StrategyDoc = serde_json::from_str(
            r#"{"version":1,"measures":{"Revenue":{"reviewed":true}},"tables":{"Dim":{}}}"#,
        )
        .unwrap();
        assert_eq!(doc.measures["Revenue"].source, None);
        assert_eq!(doc.tables["Dim"].source, None);

        let mut stamped = MeasureStrategy::default();
        stamped.source = Some(EntrySource::Inferred);
        assert_eq!(
            serde_json::to_string(&stamped).unwrap(),
            r#"{"reviewed":false,"source":"inferred"}"#
        );
        // ...and an absent source writes NO key at all, so "untouched" is a state
        // the JSON can express rather than one it fakes with a default.
        assert_eq!(
            serde_json::to_string(&MeasureStrategy::default()).unwrap(),
            r#"{"reviewed":false}"#
        );
    }

    #[test]
    fn an_attribute_set_reports_exactly_the_attributes_it_addresses() {
        let empty = AttributeSet::default();
        assert!(empty.touched().is_empty());
        assert!(empty.is_empty());

        let set = AttributeSet {
            direction: Some(Direction::LowerIsBetter),
            // A kind the engine really emits: the example in this file used to
            // be `"outlier"`, which nothing carries under any spelling.
            suppress: vec![SuppressibleFactKind::Contribution],
            rank_weight: Some(2.0),
            ..Default::default()
        };
        assert_eq!(
            set.touched(),
            vec![Attribute::Direction, Attribute::Suppress, Attribute::RankWeight]
        );
    }

    #[test]
    fn only_analysis_filter_and_hierarchy_roles_may_scope_a_rule() {
        assert!(Role::Analysis.may_scope());
        assert!(Role::Filter.may_scope());
        assert!(Role::Hierarchy.may_scope());
        assert!(!Role::Key.may_scope());
        assert!(!Role::Label.may_scope());
        assert!(!Role::Ignore.may_scope());
    }

    #[test]
    fn a_band_written_without_inclusivity_includes_both_ends_and_serializes_back_unchanged() {
        // The wire shape a person writes, and the one the checked-in corpus
        // uses. `#[serde(default)]` on a bool would have made an unmentioned
        // bound EXCLUSIVE, which is the opposite of what `low: 90000` means.
        let t: Target = serde_json::from_str(r#"{"type":"band","low":90000,"high":140000}"#).unwrap();
        assert_eq!(t, Target::band(90000.0, 140000.0));
        let band = t.as_band().expect("a band reports its bounds");
        assert!(band.low_inclusive && band.high_inclusive);
        assert!(band.contains(90000.0) && band.contains(140000.0));
        // ...and it writes back the way it was written, with no two keys added
        // to every hand-authored document.
        assert_eq!(
            serde_json::to_string(&t).unwrap(),
            r#"{"type":"band","low":90000.0,"high":140000.0}"#
        );
    }

    #[test]
    fn an_excluded_bound_survives_the_round_trip_and_changes_what_the_band_contains() {
        let json = r#"{"type":"band","low":0.0,"high":1.0,"highInclusive":false}"#;
        let t: Target = serde_json::from_str(json).unwrap();
        let band = t.as_band().unwrap();
        assert!(band.low_inclusive, "the bound nobody mentioned stays inclusive");
        assert!(!band.high_inclusive);
        assert!(band.contains(0.0), "the included end is inside");
        assert!(!band.contains(1.0), "the excluded end is not");
        assert!(band.contains(0.999));
        // Only the bound that is NOT the default is written out, so the document
        // stays as small as the statement it makes.
        assert_eq!(serde_json::to_string(&t).unwrap(), json);
        assert_eq!(band.label(), "[0, 1)");
    }

    #[test]
    fn a_reversed_or_pointlike_band_is_recognised_as_one_no_value_can_satisfy() {
        // Unchecked, every one of these judges every value unfavourable forever.
        assert!(Target::band(140000.0, 90000.0).as_band().unwrap().is_empty());
        assert!(!Target::band(5.0, 5.0).as_band().unwrap().is_empty(), "a single point is legal");
        let half_open = Target::Band {
            low: 5.0,
            high: 5.0,
            low_inclusive: true,
            high_inclusive: false,
        };
        assert!(
            half_open.as_band().unwrap().is_empty(),
            "a single point with an excluded end admits nothing"
        );
        assert!(!Target::band(90000.0, 140000.0).as_band().unwrap().is_empty());
    }

    #[test]
    fn the_suppressible_fact_kinds_are_sorted_unique_and_spelled_the_way_the_engine_emits_them() {
        // The set is a CONTRACT with the person writing the document: they copy
        // a spelling out of it. Sorted and unique so a diff of it reads.
        //
        // Neither spelling of the example this file used to give is in it. A
        // model run wraps only three of `core/insights`' series facts, so
        // `outlier` (the typo) and `outliers` (the core engine's real key) are
        // BOTH unsuppressible here - which is exactly why it is a closed set and
        // not a sentence. That it matches the emitter is proved in
        // `insights::model`, where the emitter lives.
        let mut sorted: Vec<&str> = SuppressibleFactKind::ALL.iter().map(|k| k.as_str()).collect();
        sorted.sort_unstable();
        sorted.dedup();
        let declared: Vec<&str> = SuppressibleFactKind::ALL.iter().map(|k| k.as_str()).collect();
        assert_eq!(sorted, declared, "ALL must be sorted by wire spelling and unique");
        assert_eq!(SuppressibleFactKind::from_wire("outlier"), None);
        assert_eq!(SuppressibleFactKind::from_wire("outliers"), None);
    }

    #[test]
    fn every_suppressible_fact_kind_variant_appears_in_the_all_slice() {
        // `ALL` is a literal, and a literal can go stale. The exhaustive match
        // is what makes a new variant a COMPILE error here and then a test
        // failure below, rather than a variant serde accepts and the validator's
        // own error message never mentions.
        for kind in [
            SuppressibleFactKind::Change,
            SuppressibleFactKind::ChangePoint,
            SuppressibleFactKind::Contribution,
            SuppressibleFactKind::DefinitionalDriver,
            SuppressibleFactKind::MemberMove,
            SuppressibleFactKind::Seasonality,
            SuppressibleFactKind::Trend,
            SuppressibleFactKind::Variance,
        ] {
            // The match is the exhaustiveness check: adding a variant without
            // adding an arm fails to compile.
            let _: () = match kind {
                SuppressibleFactKind::Change
                | SuppressibleFactKind::ChangePoint
                | SuppressibleFactKind::Contribution
                | SuppressibleFactKind::DefinitionalDriver
                | SuppressibleFactKind::MemberMove
                | SuppressibleFactKind::Seasonality
                | SuppressibleFactKind::Trend
                | SuppressibleFactKind::Variance => (),
            };
            assert!(
                SuppressibleFactKind::ALL.contains(&kind),
                "{kind} is a variant and must be in ALL"
            );
        }
        assert_eq!(SuppressibleFactKind::ALL.len(), 8);
    }

    #[test]
    fn a_suppress_entry_naming_a_kind_nobody_emits_stops_the_document_from_parsing_at_all() {
        // THE POINT OF THE TYPE. `outlier` was refused by a validator arm, which
        // meant it was refused where the validator ran and nowhere else, and the
        // doc comment a person copied the spelling from had drifted from the
        // check. serde's own message names every legal variant, which is more
        // than the hand-written one managed.
        let json = r#"{"version":1,"rules":[
            {"id":"r1","measure":"Returns","set":{"suppress":["outlier"]}}
        ]}"#;
        let err = serde_json::from_str::<StrategyDoc>(json).unwrap_err().to_string();
        assert!(err.contains("outlier"), "the error must quote the typo: {err}");
        assert!(
            err.contains("memberMove") && err.contains("changePoint"),
            "the error must list the vocabulary: {err}"
        );

        // POSITIVE CONTROL: every kind the engine really emits round-trips
        // through the wire spelling, or the type would refuse working documents.
        for kind in SuppressibleFactKind::ALL {
            let wire = format!("[\"{}\"]", kind.as_str());
            let back: Vec<SuppressibleFactKind> = serde_json::from_str(&wire).unwrap();
            assert_eq!(back, vec![*kind]);
            assert_eq!(serde_json::to_string(&back).unwrap(), wire);
        }
    }

    #[test]
    fn a_date_bound_that_is_not_iso_8601_stops_the_document_from_parsing() {
        // overlap.rs compares these bounds as TEXT. It was the validator's job
        // to guarantee the form, which left the RUN path - a hand-edited model
        // file - comparing `1/4/2025` lexicographically against `2025-06-30`.
        let json = r#"{"version":1,"rules":[
            {"id":"r1","measure":"Returns","scope":{"Date[Date]":{"from":"1/4/2025"}},
             "set":{"cadence":"monthly"}}
        ]}"#;
        let err = serde_json::from_str::<StrategyDoc>(json).unwrap_err().to_string();
        assert!(err.contains("1/4/2025"), "the error must quote the bound: {err}");

        for bad in ["2025-1-31", "2025/01/31", "31-01-2025", "2025-13-01", "2025-01-00", ""] {
            assert!(bad.parse::<IsoDate>().is_err(), "'{bad}' must not parse");
        }
        for good in ["2025-01-31", "2025-12-01"] {
            assert_eq!(good.parse::<IsoDate>().unwrap().as_str(), good);
        }
        // Lexicographic order IS chronological order, which is the property both
        // consumers already rely on and this type now guarantees.
        assert!("2025-01-31".parse::<IsoDate>().unwrap() < "2025-02-01".parse::<IsoDate>().unwrap());
    }

    #[test]
    fn a_date_naming_a_day_its_month_does_not_have_is_refused_like_any_other_malformed_bound() {
        // THE GUARD THAT IS NOW ALONE. `validate.rs`'s `malformed-date-range`
        // finding was deleted because this type stands there, and the type
        // checked month and day INDEPENDENTLY - so `2026-02-31` parsed, reached
        // overlap.rs and resolve.rs, and named a day nothing can ever equal.
        for bad in ["2026-02-30", "2026-02-31", "2026-04-31", "2026-06-31", "2026-09-31", "2026-11-31"]
        {
            assert!(bad.parse::<IsoDate>().is_err(), "'{bad}' is not a day");
        }
        for good in ["2026-01-31", "2026-03-31", "2026-04-30", "2026-02-28", "2026-12-31"] {
            assert_eq!(good.parse::<IsoDate>().unwrap().as_str(), good);
        }
        // ...and the whole document is refused, which is what a run path with no
        // validator between it and `resolve` needs.
        let json = r#"{"version":1,"rules":[
            {"id":"r1","measure":"Returns","scope":{"Date[Date]":{"from":"2026-02-31"}},
             "set":{"cadence":"monthly"}}
        ]}"#;
        let err = serde_json::from_str::<StrategyDoc>(json).unwrap_err().to_string();
        assert!(err.contains("2026-02-31"), "the error must quote the bound: {err}");
    }

    #[test]
    fn the_29th_of_february_follows_the_gregorian_century_rule_and_not_the_shorthand() {
        // The four cases that separate the real rule from `year % 4 == 0`:
        // an ordinary non-leap year, an ordinary leap year, a century that IS
        // a leap year, and a century that is NOT. Getting the last one wrong
        // accepts a date no calendar has ever had.
        assert!("2026-02-29".parse::<IsoDate>().is_err(), "2026 is not a leap year");
        assert_eq!("2024-02-29".parse::<IsoDate>().unwrap().as_str(), "2024-02-29");
        assert_eq!(
            "2000-02-29".parse::<IsoDate>().unwrap().as_str(),
            "2000-02-29",
            "divisible by 400, so the century IS a leap year"
        );
        assert!(
            "1900-02-29".parse::<IsoDate>().is_err(),
            "divisible by 100 and not by 400, so 1900 had 28 days in February"
        );
        // The 28th exists in all four, so the test above is about the 29th and
        // not about the century being rejected wholesale.
        for year in ["2026", "2024", "2000", "1900"] {
            let d = format!("{year}-02-28");
            assert!(d.parse::<IsoDate>().is_ok(), "{d}");
        }
    }

    #[test]
    fn a_table_kind_prints_the_same_word_it_serializes_as() {
        // Three places quote a kind back at a person - a validator finding, a
        // run note and the tab - and only the run note goes through `label`.
        // What this row proves is the one thing it can see from here: `label`
        // and the serde wire name are the SAME word, so the run note cannot say
        // `Calendar` where the document says `calendar`. See the method's own
        // comment for the two spellings that still stand beside it.
        for kind in [
            TableKind::Fact,
            TableKind::Dimension,
            TableKind::Bridge,
            TableKind::Calendar,
            TableKind::Other,
        ] {
            let wire = serde_json::to_string(&kind).unwrap();
            assert_eq!(wire, format!("\"{}\"", kind.label()));
            assert_eq!(kind.to_string(), kind.label());
        }
    }

    #[test]
    fn a_fiscal_year_start_is_refused_at_the_door_rather_than_stored_malformed() {
        assert_eq!("04-01".parse::<MonthDay>().unwrap().to_string(), "04-01");
        for bad in ["4-1", "13-01", "04-32", "0401", "04-01-01", ""] {
            assert!(bad.parse::<MonthDay>().is_err(), "'{bad}' must not parse as MM-DD");
        }
        let err = serde_json::from_str::<StrategyDoc>(
            r#"{"version":1,"model":{"fiscalYearStart":"4-1"}}"#,
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("4-1"), "{err}");
    }

    fn ext_key(k: &str) -> ExtKey {
        k.parse().expect("a namespaced key")
    }

    #[test]
    fn the_reserved_namespace_is_refused_however_it_is_capitalised() {
        // THE HOLE THIS CLOSES. The model-level check was
        // `key.starts_with("calcula.")` - case-SENSITIVE - so `Calcula.strategy`
        // walked past a reservation whose entire purpose is that the generic
        // writer can never replace a document its owning command validates. It
        // did not bite only because every reader looks up the exact lower-case
        // literal, which is luck rather than a guard. And the whole function had
        // no test at all: the shape, the cap and the reservation were unpinned.
        for spelling in [
            "calcula.strategy",
            "Calcula.strategy",
            "CALCULA.strategy",
            "cAlCuLa.anything",
        ] {
            let why = extension_namespace_refusal(spelling)
                .unwrap_or_else(|| panic!("'{spelling}' must be refused"));
            assert!(why.contains(spelling), "the refusal quotes the key: {why}");
        }
        // A vendor that merely STARTS like the reserved one is fine - the
        // reservation is a namespace, not a substring.
        assert!(extension_namespace_refusal("calculax.notes").is_none());
        assert!(extension_namespace_refusal("acme.calcula.notes").is_none());
    }

    #[test]
    fn an_extension_key_is_vendor_dot_feature_and_says_so_when_it_is_not() {
        for good in ["acme.notes", "acme.sla.tier", "a.b"] {
            assert!(
                extension_namespace_refusal(good).is_none(),
                "'{good}' is a valid namespaced key"
            );
        }
        // `splitn(2, '.')` on purpose: the feature half may carry further dots,
        // so a vendor can nest without asking anyone.
        assert_eq!("acme.sla.tier".parse::<ExtKey>().unwrap().vendor(), "acme");

        for bad in ["acme", "acme.", ".notes", "", "a b.c", "acme. notes"] {
            assert!(
                extension_namespace_refusal(bad).is_some(),
                "'{bad}' is not a namespaced key"
            );
        }
    }

    #[test]
    fn the_key_length_cap_counts_bytes_and_the_message_now_says_bytes() {
        // The old message said "max 200 chars" while the check counted BYTES, so
        // a key of Swedish or Japanese characters was refused sooner than the
        // sentence promised - and there was no test to notice.
        let ascii = format!("acme.{}", "a".repeat(MAX_EXTENSION_KEY_BYTES - 5));
        assert_eq!(ascii.len(), MAX_EXTENSION_KEY_BYTES);
        assert!(extension_namespace_refusal(&ascii).is_none(), "exactly at the cap is fine");

        let over = format!("{ascii}a");
        let why = extension_namespace_refusal(&over).expect("one byte over is refused");
        assert!(why.contains("bytes"), "the unit is named: {why}");

        // Half as many CHARACTERS, still over the cap, because they are two
        // bytes each. That is the honest behaviour; the old message denied it.
        let swedish = format!("acme.{}", "ä".repeat(120));
        assert!(swedish.chars().count() < MAX_EXTENSION_KEY_BYTES);
        assert!(swedish.len() > MAX_EXTENSION_KEY_BYTES);
        assert!(extension_namespace_refusal(&swedish).is_some());
    }

    #[test]
    fn a_bad_extension_key_stops_the_document_parsing_rather_than_being_dropped() {
        // `ExtKey` refuses where it is READ, like `IsoDate` and `MonthDay`. A
        // bag is a map, so a key serde merely tolerated would be a perfectly
        // good entry that nothing reads - the silent-no-op shape this whole
        // subtree exists to refuse.
        let err = serde_json::from_str::<StrategyDoc>(
            r#"{"version":1,"measures":{"Revenue":{"x":{"calcula.sneaky":1}}}}"#,
        )
        .expect_err("the reserved namespace is refused inside the document too")
        .to_string();
        assert!(err.contains("calcula.sneaky"), "{err}");

        let ok: StrategyDoc = serde_json::from_str(
            r#"{"version":1,"measures":{"Revenue":{"x":{"acme.slaTier":"gold"}}}}"#,
        )
        .expect("a properly namespaced key parses");
        let bag = &ok.measures["Revenue"].x;
        assert_eq!(bag.len(), 1);
        assert_eq!(bag.values().next().unwrap(), &serde_json::json!("gold"));
    }

    #[test]
    fn the_open_door_does_not_open_any_of_the_others() {
        // The bag is ONE known field. Every other unknown key is still refused
        // by name, which is the whole reason `deny_unknown_fields` survives the
        // arrival of an extension namespace untouched.
        let err = serde_json::from_str::<StrategyDoc>(
            r#"{"version":1,"measures":{"Revenue":{"direktion":"higherIsBetter"}}}"#,
        )
        .expect_err("a typo in a BUILT-IN key is still an error")
        .to_string();
        assert!(err.contains("direktion"), "{err}");
    }

    #[test]
    fn an_extension_bag_round_trips_and_an_empty_one_writes_nothing() {
        // THE GUARANTEE IS VALUE FIDELITY, NOT BYTE FIDELITY, and the difference
        // is worth stating because it is the opposite of a defect. `serde_json`
        // is built here without `preserve_order`, so an object's keys come back
        // SORTED rather than in the order they were typed. That is what the
        // model bytes need: `extension_data` is a `BTreeMap` for exactly this
        // reason - deterministic bytes feed `.calp` checksums and signatures, so
        // two publishes of the same document have to produce the same file.
        //
        // What must survive intact is every VALUE, at any depth.
        let json = r#"{"version":1,"measures":{"Revenue":{"reviewed":false,"x":{"acme.owner":{"team":"finance","ids":[1,2]}}}}}"#;
        let doc: StrategyDoc = serde_json::from_str(json).expect("parses");
        let value = &doc.measures["Revenue"].x[&ext_key("acme.owner")];
        assert_eq!(value["team"], serde_json::json!("finance"));
        assert_eq!(value["ids"], serde_json::json!([1, 2]));

        // And writing it out and reading it back is a FIXED POINT, which is the
        // property a document that travels actually depends on.
        let once = serde_json::to_string(&doc).unwrap();
        let again: StrategyDoc = serde_json::from_str(&once).expect("re-parses");
        assert_eq!(serde_json::to_string(&again).unwrap(), once);
        assert_eq!(again, doc);

        // An entry that names no extension writes no `x` at all, so a document
        // does not grow a key just by being opened.
        let plain: StrategyDoc =
            serde_json::from_str(r#"{"version":1,"measures":{"Revenue":{"reviewed":false}}}"#)
                .expect("parses");
        let written = serde_json::to_string(&plain).unwrap();
        assert!(!written.contains("\"x\""), "no bag key appears at all: {written}");
    }

    #[test]
    fn only_a_version_this_build_understands_is_readable_and_zero_is_not_one() {
        // The predicate BOTH readers ask, so the write gate and the run path
        // cannot drift into disagreeing about which documents are legible.
        assert!(is_readable_doc_version(STRATEGY_DOC_VERSION));
        assert!(
            !is_readable_doc_version(0),
            "0 is not a version this format ever had"
        );
        for ahead in [STRATEGY_DOC_VERSION + 1, 99] {
            assert!(
                !is_readable_doc_version(ahead),
                "a document from a newer schema is not readable by pretending it is this one"
            );
        }
        // A LOWER version stays readable when there is one - that is an OLDER
        // document, which is the direction that must keep working. There is no
        // such version yet, which is exactly why this is asserted rather than
        // assumed: `<=` is the operator, not `==`.
        assert!(
            (1..=STRATEGY_DOC_VERSION).all(is_readable_doc_version),
            "every version up to and including the current one must stay readable"
        );
    }

    #[test]
    fn no_untagged_enum_in_this_schema_can_swallow_a_typed_key() {
        // THE `too` DEFECT, GUARDED AGAINST ITS RETURN. An untagged enum with a
        // STRUCT variant is the shape where a misspelled key vanishes: serde
        // tries each variant, and `{"from": .., "too": ..}` matched the range
        // with `to` absent, so a bounded scope became an open-ended one and the
        // rule ran on for every later period. `deny_unknown_fields` is NOT the
        // repair - on an untagged enum it refuses but reports only "data did not
        // match any variant", naming nothing - which is why `RawScopeValue` has
        // a hand-written visitor instead.
        //
        // The rule this pins: in THIS file, an untagged enum may not also derive
        // `Deserialize`. Scalar-discriminated ones elsewhere (`PivotCellValueData`,
        // `PlanValue`) are safe because they have no field names to misspell;
        // the moment one here grows a struct variant, it needs the visitor.
        let source = include_str!("types.rs");
        let lines: Vec<&str> = source.lines().collect();
        let mut offenders: Vec<String> = Vec::new();
        for (n, line) in lines.iter().enumerate() {
            if !line.trim_start().starts_with("#[serde(") || !line.contains("untagged") {
                continue;
            }
            // The derive list sits directly above the serde attribute, in the
            // unbroken run of attributes and comments that introduces the item.
            let derives_deserialize = lines[..n]
                .iter()
                .rev()
                .take_while(|l| {
                    l.trim_start().starts_with("#[") || l.trim_start().starts_with("//")
                })
                .any(|l| l.contains("derive(") && l.contains("Deserialize"));
            if derives_deserialize {
                let name = lines[n..]
                    .iter()
                    .find(|l| l.contains("enum "))
                    .copied()
                    .unwrap_or("<unknown>");
                offenders.push(format!("line {}: {}", n + 1, name.trim()));
            }
        }
        assert!(
            offenders.is_empty(),
            "an untagged enum on the READ path can swallow a misspelled key. Give it a \
             hand-written visitor the way `RawScopeValue` has one:\n  {}",
            offenders.join("\n  ")
        );
        // POSITIVE CONTROL: the scan can see the untagged attribute at all, so
        // an empty offender list means "checked and clean", not "found nothing".
        assert!(
            source.lines().any(|l| l.contains("#[serde(untagged")),
            "the scan found no untagged enum whatsoever - it has stopped looking"
        );
    }

    #[test]
    fn a_fiscal_year_start_takes_every_months_last_real_day_and_refuses_the_day_after_it() {
        // `02-31` PARSED until the day was checked against its month, and this
        // type is the only thing standing there: the
        // `malformed-fiscal-year-start` finding was deleted from `validate.rs`
        // on the grounds that the newtype covers it.
        for (month, last) in [
            (1, 31),
            (2, 29),
            (3, 31),
            (4, 30),
            (5, 31),
            (6, 30),
            (7, 31),
            (8, 31),
            (9, 30),
            (10, 31),
            (11, 30),
            (12, 31),
        ] {
            let real = format!("{month:02}-{last:02}");
            assert_eq!(
                real.parse::<MonthDay>().unwrap().to_string(),
                real,
                "'{real}' is a day that month has"
            );
            let past_the_end = format!("{month:02}-{:02}", last + 1);
            assert!(
                past_the_end.parse::<MonthDay>().is_err(),
                "'{past_the_end}' is a day no year has"
            );
        }

        // The spellings the old 1..=31 range let through, named one by one so a
        // regression says which month came back.
        for impossible in ["02-30", "02-31", "04-31", "06-31", "09-31", "11-31"] {
            assert!(
                impossible.parse::<MonthDay>().is_err(),
                "'{impossible}' must not parse as MM-DD"
            );
        }

        // February stops at 29 and not 28, because an MM-DD names no year and
        // the leap rule is a property of one.
        assert_eq!("02-29".parse::<MonthDay>().unwrap().day(), 29);
        assert_eq!("02-29".parse::<MonthDay>().unwrap().month(), 2);

        // The refusal has to send a person to the right edit, so it says what a
        // legal day is rather than only that this one is not.
        let err = "02-31".parse::<MonthDay>().unwrap_err().to_string();
        assert!(err.contains("02-31"), "{err}");
        assert!(err.contains("its month actually has"), "{err}");
    }

    #[test]
    fn a_band_reports_which_side_a_value_missed_on_and_not_only_that_it_missed() {
        // "worse" and "above the band [90000, 140000]" cost the same to compute.
        let band = Target::band(90000.0, 140000.0).as_band().unwrap();
        assert_eq!(band.side(80000.0), BandSide::Below);
        assert_eq!(band.side(90000.0), BandSide::Inside);
        assert_eq!(band.side(120000.0), BandSide::Inside);
        assert_eq!(band.side(140000.0), BandSide::Inside);
        assert_eq!(band.side(160000.0), BandSide::Above);

        // An EXCLUDED end is outside, and the side says which end it fell off -
        // the same flag `contains` reads, asked once.
        let half_open = Target::Band {
            low: 0.0,
            high: 1.0,
            low_inclusive: false,
            high_inclusive: false,
        }
        .as_band()
        .unwrap();
        assert_eq!(half_open.side(0.0), BandSide::Below);
        assert_eq!(half_open.side(1.0), BandSide::Above);
        assert_eq!(half_open.side(0.5), BandSide::Inside);
        assert_eq!(BandSide::Above.word(), "above");
    }

    #[test]
    fn the_model_block_carries_the_same_reviewed_and_source_badge_every_other_row_does() {
        // `defaultTimeAxis` can be an inferred calendar, and an inferred
        // calendar drives every trend claim in the report. Without these two
        // fields the panel has no badge to show and no Confirm to offer on the
        // one block where a guess most needs accepting.
        let doc: StrategyDoc = serde_json::from_str(
            r#"{"version":1,"model":{"fiscalYearStart":"04-01"}}"#,
        )
        .unwrap();
        assert!(!doc.model.reviewed, "a block nobody wrote is not reviewed");
        assert_eq!(doc.model.source, None, "and nobody has touched it");

        let stamped = ModelStrategy {
            default_time_axis: Some(QualifiedColumn::new("Date", "Date")),
            reviewed: false,
            source: Some(EntrySource::Inferred),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_string(&stamped).unwrap(),
            r#"{"defaultTimeAxis":"Date[Date]","reviewed":false,"source":"inferred"}"#
        );
    }

    #[test]
    fn a_column_named_by_a_hierarchy_may_scope_even_when_its_role_says_label() {
        let mut doc = StrategyDoc::default();
        doc.tables.insert(
            "Geo".into(),
            TableStrategy {
                columns: BTreeMap::from([(
                    "Country".to_string(),
                    ColumnStrategy {
                        role: Role::Label,
                        priority: None,
                        x: Default::default(),
                    },
                )]),
                hierarchies: vec![vec!["Country".into(), "City".into()]],
                ..Default::default()
            },
        );
        assert!(doc.may_scope(&QualifiedColumn::new("Geo", "Country")));

        // ...but a plain label that no hierarchy names may not.
        doc.tables.get_mut("Geo").unwrap().hierarchies.clear();
        assert!(!doc.may_scope(&QualifiedColumn::new("Geo", "Country")));
    }
}
