//! FILENAME: core/pivot-engine/src/cache.rs
//! Pivot Cache - High-performance internal representation.
//!
//! The cache is designed for:
//! - Fast initial build from source data (O(n) where n = rows)
//! - Instant re-grouping when fields are rearranged (no re-scan)
//! - Memory-efficient storage via value interning
//! - Incremental updates when source data changes
//!
//! Architecture:
//! - Each unique value is stored once and referenced by index
//! - Row data is stored as vectors of indices into the unique value stores
//! - Aggregates are pre-computed and keyed by group combinations

use std::collections::{HashMap, HashSet};
use rustc_hash::{FxHashMap, FxHashSet};
use smallvec::SmallVec;
use serde::{Deserialize, Serialize};
use engine::{CellValue, MemberSource};
use crate::definition::{AggregationType, FieldIndex, PivotId};

/// Inline capacity for GroupKey — covers the typical 2-6 field case
/// without heap allocation.
pub type GroupKeyVec = SmallVec<[ValueId; 6]>;

// serde helpers: serialize maps whose KEY is not a string/integer (CacheValue is
// an enum, GroupKey is a struct) as SEQUENCES of (key, value) pairs. serde_json
// cannot serialize such maps as JSON objects, so a populated PivotCache would
// otherwise fail to serialize entirely (which silently broke pivot undo — the
// snapshot serialized to empty bytes). Storing them as JSON arrays round-trips
// losslessly. PivotCache is only serialized for undo snapshots (never persisted
// to .cala), so this format change has no on-disk compatibility impact.
mod value_to_id_pairs {
    use super::{CacheValue, ValueId};
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use std::collections::HashMap;

    pub fn serialize<S: Serializer>(m: &HashMap<CacheValue, ValueId>, s: S) -> Result<S::Ok, S::Error> {
        m.iter().collect::<Vec<(&CacheValue, &ValueId)>>().serialize(s)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<HashMap<CacheValue, ValueId>, D::Error> {
        Ok(Vec::<(CacheValue, ValueId)>::deserialize(d)?.into_iter().collect())
    }
}

mod aggregates_pairs {
    use super::{AggregateAccumulator, GroupKey};
    use rustc_hash::FxHashMap;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(
        m: &FxHashMap<GroupKey, Vec<AggregateAccumulator>>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        m.iter().collect::<Vec<(&GroupKey, &Vec<AggregateAccumulator>)>>().serialize(s)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<FxHashMap<GroupKey, Vec<AggregateAccumulator>>, D::Error> {
        Ok(Vec::<(GroupKey, Vec<AggregateAccumulator>)>::deserialize(d)?
            .into_iter()
            .collect())
    }
}

// ============================================================================
// VALUE INTERNING
// ============================================================================

/// A reference to an interned value within a field's unique value store.
/// Using u32 to save memory (supports up to 4B unique values per field).
pub type ValueId = u32;

/// Two meanings, never both at once:
/// - in a RECORD (`CacheRecord::values`, `virtual_records`): the value is
///   blank -- blanks are never interned ([`FieldCache::intern`]);
/// - in a GROUP KEY (the aggregate keys, a column key, an axis item's
///   `group_values`): "all values" -- the padding of a subtotal or
///   grand-total key. A blank MEMBER in a group key is [`VALUE_ID_BLANK`].
pub const VALUE_ID_EMPTY: ValueId = u32::MAX;

/// The BLANK member's id in a GROUP KEY: the aggregate keys, the column
/// layout, every axis item's `group_values`, every view cell's `group_path`
/// and every row / column descriptor's `group_values`.
///
/// A record stores a blank as [`VALUE_ID_EMPTY`], and every RECORD reader --
/// hidden items, page filters, slicers, timelines -- keeps
/// reading it that way. A group key cannot: there `VALUE_ID_EMPTY` is the
/// "all values" padding, so a blank member keyed by it WAS the total one
/// level up. The (blank) row showed the grand total, a rolled-up total
/// counted the blank records twice (as their own member, and again as the
/// total they collided with), and the blank member's cells named nothing in
/// their group path, so a drill-through listed the level above. [`member_id`]
/// is the ONE translation from a record's id to its member's id;
/// [`FieldCache::get_value`] reads this id as `CacheValue::Empty`, so every
/// label path spells it as a blank.
pub const VALUE_ID_BLANK: ValueId = u32::MAX - 1;

/// The id a record's value has as a MEMBER in a group key: the blank
/// ([`VALUE_ID_EMPTY`] in a record) becomes [`VALUE_ID_BLANK`]; every
/// interned id is its own member id.
#[inline(always)]
pub fn member_id(record_value: ValueId) -> ValueId {
    if record_value == VALUE_ID_EMPTY {
        VALUE_ID_BLANK
    } else {
        record_value
    }
}

/// True when a GROUP-KEY id (an axis item's value, a `group_path` entry)
/// names the blank member.
#[inline(always)]
pub fn is_blank_member_id(id: ValueId) -> bool {
    id == VALUE_ID_BLANK
}

/// How the view (and every item list) spells a blank item. Blanks are never
/// interned -- they are `VALUE_ID_EMPTY` -- so a hidden-items list names them
/// by this label, compared ignoring case (the host spells it "(Blank)").
pub const BLANK_ITEM_LABEL: &str = "(blank)";

/// True when `label` names the blank item.
pub fn is_blank_item_label(label: &str) -> bool {
    label.eq_ignore_ascii_case(BLANK_ITEM_LABEL)
}

/// The blank member's KEY: the empty string (orchestrator ruling Q8,
/// 2026-10-16 -- Power BI's "(Blank)" semantics: the pivot cache's empty
/// item, a BI NULL and a BI empty string are ONE member, keyed ""). Its LABEL
/// is `engine::BLANK_MEMBER_LABEL` ("(Blank)"), written by
/// `engine::member_label` from [`MemberSource::Blank`].
///
/// This is the spelling [`FieldCache::member_key`] returns. The view's HEADER
/// TEXT for the blank member (`PivotViewCell::value`, `group_path` names,
/// GETPIVOTDATA and every persisted hidden-items list) still reads
/// [`BLANK_ITEM_LABEL`] ("(blank)"). A reader that takes a member NAME from
/// both worlds (a selection written from the key, or one written from the
/// header text) tests it with [`is_blank_member_key`].
pub const BLANK_MEMBER_KEY: &str = "";

/// True when `name` names the blank MEMBER: its key "" ([`BLANK_MEMBER_KEY`])
/// or its header text "(blank)" in any case ([`is_blank_item_label`]).
pub fn is_blank_member_key(name: &str) -> bool {
    name == BLANK_MEMBER_KEY || is_blank_item_label(name)
}

/// What the KEYS of a field are, when the cache cannot tell from the value:
/// a BI cache stores a Date32 / Timestamp column as its ISO TEXT
/// ("2024-01-15", "2024-01-15 13:04:05"), so the host's BI cache builder
/// says so here and [`FieldCache::member_source`] reads such a key as a
/// date -- no string pattern is ever guessed for a field that did not
/// declare it (a text code "2024-01-15" in a text column stays text).
///
/// A BI Decimal column is interned as an f64, which forgets its scale, while
/// the model's value list keys it by the exact decimal text ("5.50",
/// `arrow_value_to_string`). [`MemberKind::Decimal`] gives the scale back to
/// [`FieldCache::member_key`], so a model pivot's member key and the model
/// list's key are ONE spelling (P2 S4; P4 pins it byte for byte).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum MemberKind {
    /// Keys are what the cache value says they are.
    #[default]
    Plain,
    /// Text keys are ISO dates (`%Y-%m-%d`).
    IsoDate,
    /// Text keys are ISO date-times (`%Y-%m-%d %H:%M:%S`).
    IsoDateTime,
    /// Number keys are decimals of `scale` fraction digits ("5.50").
    Decimal { scale: u32 },
}

/// A normalized, hashable representation of a cell value.
/// Used as keys in the unique value store.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CacheValue {
    Empty,
    Number(OrderedFloat),
    Text(String),
    Boolean(bool),
    Error(String),
}

impl From<&CellValue> for CacheValue {
    fn from(value: &CellValue) -> Self {
        match value {
            CellValue::Empty => CacheValue::Empty,
            CellValue::Number(n) => CacheValue::Number(OrderedFloat(*n)),
            CellValue::Text(s) => CacheValue::Text(s.clone()),
            CellValue::Boolean(b) => CacheValue::Boolean(*b),
            // The error's BARE Excel code ("DIV/0!", "N/A"), the convention a
            // calculated field's `CalcValue::Error` uses; every reader adds
            // the `#`, so a member and its label read "#DIV/0!" as Excel's
            // do. It was the Rust variant name, "#Div0" (BUG-0761).
            CellValue::Error(e) => CacheValue::Error(e.as_literal().trim_start_matches('#').to_string()),
            CellValue::List(items) => CacheValue::Text(format!("[List({})]", items.len())),
            CellValue::Dict(entries) => CacheValue::Text(format!("[Dict({})]", entries.len())),
        }
    }
}

/// Wrapper around f64 that implements Eq and Hash for use as HashMap keys.
/// NaN values are treated as equal to each other.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct OrderedFloat(pub f64);

impl PartialEq for OrderedFloat {
    fn eq(&self, other: &Self) -> bool {
        if self.0.is_nan() && other.0.is_nan() {
            true
        } else {
            self.0 == other.0
        }
    }
}

impl Eq for OrderedFloat {}

impl std::hash::Hash for OrderedFloat {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        if self.0.is_nan() {
            // All NaN values hash to the same thing
            u64::MAX.hash(state);
        } else {
            self.0.to_bits().hash(state);
        }
    }
}

impl OrderedFloat {
    pub fn as_f64(&self) -> f64 {
        self.0
    }
}

// ============================================================================
// FIELD CACHE
// ============================================================================

/// Cache for a single field (column) from the source data.
/// Stores unique values and provides O(1) lookup by ValueId.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldCache {
    /// The source column index this cache represents.
    pub source_index: FieldIndex,

    /// Display name (from header row).
    pub name: String,

    /// Map from value to its unique ID (for deduplication during build).
    #[serde(with = "value_to_id_pairs")]
    value_to_id: HashMap<CacheValue, ValueId>,

    /// Ordered list of unique values (indexed by ValueId).
    /// This allows O(1) lookup from ID to value.
    id_to_value: Vec<CacheValue>,

    /// Pre-sorted order of ValueIds (ascending by value).
    /// Used for fast sorted iteration.
    sorted_ids_asc: Vec<ValueId>,

    /// Whether the sorted indices need rebuilding.
    sort_dirty: bool,

    /// Optional display label overrides for values (used by date/number grouping).
    /// When present, get_value_label uses this map instead of the raw CacheValue display.
    #[serde(default)]
    pub label_map: HashMap<ValueId, String>,

    /// The source's own identity for this column when its display NAME is not
    /// unique: a BI model pivot's cache is named from the query's Arrow schema,
    /// which is the BARE column name, so Customers.name and Products.name are
    /// both "name". The host stamps "Table.Column" here when it builds such a
    /// cache, and it travels with the records (clones AND the serialized undo
    /// snapshots, so it must never be `serde(skip)`), so "which table's column
    /// is this?" never has to be guessed from the name. `None` for a
    /// grid-sourced cache, whose header names are all it has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_key: Option<String>,

    /// What this field's KEYS are when the value alone cannot say (an ISO
    /// date stored as text by the BI cache builder). Locale-free; travels in
    /// undo snapshots, so it is serde-default.
    #[serde(default)]
    pub member_kind: MemberKind,

    /// The [`MemberSource`] of every `label_map` entry that the engine wrote
    /// (date grouping, number binning): what the KEY in `label_map` IS, so
    /// its LABEL can be written for the app locale at response time
    /// (`engine::member_label`). `label_map` keeps the invariant KEY in every
    /// case. Locale-free; serde-default (undo snapshots).
    #[serde(default)]
    pub label_source_map: HashMap<ValueId, MemberSource>,
}

impl FieldCache {
    pub fn new(source_index: FieldIndex, name: String) -> Self {
        FieldCache {
            source_index,
            name,
            value_to_id: HashMap::new(),
            id_to_value: Vec::new(),
            sorted_ids_asc: Vec::new(),
            sort_dirty: true,
            label_map: HashMap::new(),
            model_key: None,
            member_kind: MemberKind::Plain,
            label_source_map: HashMap::new(),
        }
    }

    /// THE member KEY of `value_id`: the invariant canonical text every
    /// selection, filter, page filter and cross-filter tuple matches on.
    /// Never localised (the app-locale LABEL is `engine::member_label` over
    /// [`FieldCache::member_source`]).
    ///
    /// The body is the pivot engine's header spelling (formerly the private
    /// `PivotEngine::get_value_label`), moved here so the engine and the host
    /// spell a member ONE way: `label_map` first (grouping keys), then the
    /// value -- `format!("{}", n)` / the text / `TRUE`/`FALSE` / `#err`.
    /// The ONE difference from the header text is the blank member: its key
    /// is [`BLANK_MEMBER_KEY`] ("", ruling Q8), where the header still reads
    /// [`BLANK_ITEM_LABEL`] ("(blank)").
    pub fn member_key(&self, value_id: ValueId) -> String {
        if value_id == VALUE_ID_EMPTY || value_id == VALUE_ID_BLANK {
            return BLANK_MEMBER_KEY.to_string();
        }
        if let Some(label) = self.label_map.get(&value_id) {
            return label.clone();
        }
        match self.get_value(value_id) {
            Some(CacheValue::Empty) => BLANK_MEMBER_KEY.to_string(),
            Some(CacheValue::Number(n)) => match self.member_kind {
                MemberKind::Decimal { scale } if scale > 0 => format!("{:.*}", scale as usize, n.as_f64()),
                _ => format!("{}", n.as_f64()),
            },
            Some(CacheValue::Text(s)) => s.clone(),
            Some(CacheValue::Boolean(b)) => if *b { "TRUE" } else { "FALSE" }.to_string(),
            Some(CacheValue::Error(e)) => format!("#{}", e),
            None => "(unknown)".to_string(),
        }
    }

    /// What the member `value_id` IS, so its label can be written for a
    /// locale (`engine::member_label`) without re-parsing its key.
    ///
    /// `label_source_map` first (the engine's grouping and binning keys);
    /// any other `label_map` entry is shown as written (`Text`); then the
    /// cache value: the blank (and an empty text, which shares its key "")
    /// -> `Blank`, a number -> `Number`, a text -> `Date` / `DateTime` when
    /// [`FieldCache::member_kind`] declares ISO keys AND the key parses
    /// strictly (`engine::iso_member_source`), else `Text`; a boolean ->
    /// `Boolean`; an error -> `Error`. An unknown id is `Text`.
    pub fn member_source(&self, value_id: ValueId) -> MemberSource {
        if value_id == VALUE_ID_EMPTY || value_id == VALUE_ID_BLANK {
            return MemberSource::Blank;
        }
        if let Some(source) = self.label_source_map.get(&value_id) {
            return source.clone();
        }
        if self.label_map.contains_key(&value_id) {
            return MemberSource::Text;
        }
        match self.get_value(value_id) {
            Some(CacheValue::Empty) => MemberSource::Blank,
            Some(CacheValue::Number(n)) => MemberSource::Number { value: n.as_f64() },
            Some(CacheValue::Text(s)) if s.is_empty() => MemberSource::Blank,
            Some(CacheValue::Text(s)) => match self.member_kind {
                MemberKind::Plain | MemberKind::Decimal { .. } => MemberSource::Text,
                MemberKind::IsoDate | MemberKind::IsoDateTime => {
                    engine::iso_member_source(s).unwrap_or(MemberSource::Text)
                }
            },
            Some(CacheValue::Boolean(b)) => MemberSource::Boolean { value: *b },
            Some(CacheValue::Error(_)) => MemberSource::Error,
            None => MemberSource::Text,
        }
    }
    
    /// Interns a value and returns its ValueId.
    /// If the value already exists, returns the existing ID.
    pub fn intern(&mut self, value: CacheValue) -> ValueId {
        if let CacheValue::Empty = value {
            return VALUE_ID_EMPTY;
        }
        
        if let Some(&id) = self.value_to_id.get(&value) {
            return id;
        }
        
        let id = self.id_to_value.len() as ValueId;
        self.id_to_value.push(value.clone());
        self.value_to_id.insert(value, id);
        self.sort_dirty = true;
        id
    }

    /// Read-only lookup of an interned value's id (never interns).
    /// `CacheValue::Empty` maps to `VALUE_ID_EMPTY`, mirroring `intern`.
    pub fn find_id(&self, value: &CacheValue) -> Option<ValueId> {
        if let CacheValue::Empty = value {
            return Some(VALUE_ID_EMPTY);
        }
        self.value_to_id.get(value).copied()
    }
    
    /// Gets the value for a given ID. Both spellings of a blank -- a record's
    /// `VALUE_ID_EMPTY` and a group key's `VALUE_ID_BLANK` -- read as
    /// `CacheValue::Empty`.
    pub fn get_value(&self, id: ValueId) -> Option<&CacheValue> {
        if id == VALUE_ID_EMPTY || id == VALUE_ID_BLANK {
            return Some(&CacheValue::Empty);
        }
        self.id_to_value.get(id as usize)
    }
    
    /// Returns the number of unique values (excluding empty).
    pub fn unique_count(&self) -> usize {
        self.id_to_value.len()
    }
    
    /// Returns all unique ValueIds in sorted order.
    pub fn sorted_ids(&mut self) -> &[ValueId] {
        if self.sort_dirty {
            self.rebuild_sort_order();
        }
        &self.sorted_ids_asc
    }
    
    /// Rebuilds the sorted order of unique values.
    fn rebuild_sort_order(&mut self) {
        self.sorted_ids_asc = (0..self.id_to_value.len() as ValueId).collect();
        self.sorted_ids_asc.sort_by(|&a, &b| {
            let va = &self.id_to_value[a as usize];
            let vb = &self.id_to_value[b as usize];
            Self::compare_cache_values(va, vb)
        });
        self.sort_dirty = false;
    }
    
    /// Comparison function for sorting CacheValues.
    fn compare_cache_values(a: &CacheValue, b: &CacheValue) -> std::cmp::Ordering {
        // (Text: `compare_text_excel`, the ONE text order of item lists and rows.)
        use std::cmp::Ordering;
        match (a, b) {
            (CacheValue::Empty, CacheValue::Empty) => Ordering::Equal,
            (CacheValue::Empty, _) => Ordering::Less,
            (_, CacheValue::Empty) => Ordering::Greater,
            
            (CacheValue::Number(na), CacheValue::Number(nb)) => {
                na.0.partial_cmp(&nb.0).unwrap_or(Ordering::Equal)
            }
            (CacheValue::Number(_), _) => Ordering::Less,
            (_, CacheValue::Number(_)) => Ordering::Greater,
            
            (CacheValue::Text(ta), CacheValue::Text(tb)) => compare_text_excel(ta, tb),
            (CacheValue::Text(_), _) => Ordering::Less,
            (_, CacheValue::Text(_)) => Ordering::Greater,
            
            (CacheValue::Boolean(ba), CacheValue::Boolean(bb)) => ba.cmp(bb),
            (CacheValue::Boolean(_), _) => Ordering::Less,
            (_, CacheValue::Boolean(_)) => Ordering::Greater,
            
            (CacheValue::Error(ea), CacheValue::Error(eb)) => ea.cmp(eb),
        }
    }
}

/// Excel's text order for pivot items: CASE-INSENSITIVE ("YoY" before "YTD",
/// "apple" beside "Apple"), with the ordinal order only as the tie-break so the
/// order stays total (two spellings never compare Equal unless identical).
/// Both the item lists (`FieldCache`) and the row/column sort
/// (`compare_values`) use it; they used to compare bytes, so every capital
/// sorted before every lower-case letter (found in the fix-all wave F review,
/// 2026-09-29). Compares without allocating.
pub fn compare_text_excel(a: &str, b: &str) -> std::cmp::Ordering {
    a.chars()
        .flat_map(char::to_lowercase)
        .cmp(b.chars().flat_map(char::to_lowercase))
        .then_with(|| a.cmp(b))
}

// ============================================================================
// ROW RECORD
// ============================================================================

/// A single row from the source data, stored as interned value IDs.
/// This is extremely memory-efficient for large datasets with repeated values.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheRecord {
    /// The original row index in the source data (0-based, excluding header).
    pub source_row: u32,
    
    /// ValueIds for each field, indexed by FieldIndex.
    pub values: Vec<ValueId>,
}

// ============================================================================
// GROUP KEY
// ============================================================================

/// A key representing a unique combination of row/column field values.
/// Used to look up pre-computed aggregates.
///
/// Implements `Borrow<[ValueId]>` so that HashMap lookups can use a
/// `&[ValueId]` slice without allocating a new Vec.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct GroupKey {
    /// ValueIds for each field in the grouping (row fields then column fields).
    /// A VALUE_ID_EMPTY indicates "all values" (for subtotals/grand totals);
    /// the blank MEMBER is VALUE_ID_BLANK (see [`member_id`]).
    /// Uses SmallVec to avoid heap allocation for the typical 2-6 field case.
    pub values: GroupKeyVec,
}

impl std::borrow::Borrow<[ValueId]> for GroupKey {
    fn borrow(&self) -> &[ValueId] {
        &self.values
    }
}

impl GroupKey {
    pub fn new(values: Vec<ValueId>) -> Self {
        GroupKey { values: SmallVec::from_vec(values) }
    }

    pub fn from_slice(slice: &[ValueId]) -> Self {
        GroupKey { values: SmallVec::from_slice(slice) }
    }

    /// Creates a key for the grand total (all fields are "all values").
    pub fn grand_total(field_count: usize) -> Self {
        GroupKey {
            values: smallvec::smallvec![VALUE_ID_EMPTY; field_count],
        }
    }

    /// Creates a subtotal key by setting fields after `level` to "all values".
    pub fn subtotal_at_level(&self, level: usize) -> Self {
        let mut values = self.values.clone();
        for i in (level + 1)..values.len() {
            values[i] = VALUE_ID_EMPTY;
        }
        GroupKey { values }
    }
}

// ============================================================================
// AGGREGATE ACCUMULATOR
// ============================================================================

/// The bare error codes (no `#`, as [`CacheValue::Error`] stores them) an
/// accumulator can carry, indexed by the `u8` it stores. An unknown code is
/// kept as `VALUE!`.
const ACCUMULATOR_ERROR_CODES: &[&str] = &[
    "VALUE!", "DIV/0!", "N/A", "NUM!", "REF!", "NAME?", "NULL!", "SPILL!", "CALC!",
    "CIRCULAR!", "CONFLICT!", "BLOCKED!", "LIMIT!", "GETTING_DATA", "FIELD!", "CONNECT!", "BUSY!",
];

/// The accumulator index of a bare error code (`"DIV/0!"`); `VALUE!` for one
/// the table does not hold.
pub fn accumulator_error_index(code: &str) -> u8 {
    let code = code.trim_start_matches('#');
    ACCUMULATOR_ERROR_CODES
        .iter()
        .position(|c| c.eq_ignore_ascii_case(code))
        .unwrap_or(0) as u8
}

/// The bare error code an accumulator error index stands for.
pub fn accumulator_error_code(index: u8) -> &'static str {
    ACCUMULATOR_ERROR_CODES.get(index as usize).copied().unwrap_or("VALUE!")
}

/// What one source record contributes to one value field (BUG-0760
/// follow-up): Excel's pivot counts text and errors, sums only numbers, and an
/// error in the source makes every numeric summary over it that error.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum SourceContribution {
    /// An empty source cell: counted by nothing.
    Empty,
    Number(f64),
    /// Text or a boolean: counted by Count, ignored by every numeric summary.
    Other,
    /// A source error (an [`accumulator_error_index`]).
    Error(u8),
}

/// Accumulator for computing aggregates incrementally.
/// Stores intermediate state needed for all aggregation types.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AggregateAccumulator {
    pub sum: f64,
    pub count: u64,
    pub count_numbers: u64,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub product: f64,
    /// For variance/stddev: sum of squared differences from mean.
    /// Using Welford's algorithm for numerical stability.
    pub m2: f64,
    pub mean: f64,
    pub has_product: bool,
    /// The FIRST source error added, in record order ([`accumulator_error_code`]).
    /// Excel [LIVE, piv4 probe5]: a group holding #DIV/0! then #N/A shows
    /// #DIV/0! in every numeric summary (Sum, Average, Max, Min, Product,
    /// StdDev, Var); Count counts the error row and Count Numbers ignores it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_error: Option<u8>,
    /// The LAST source error added: what a CALCULATED field over this field
    /// reads (Excel [LIVE, piv4 probe5]: `=Amount*2` over #DIV/0! then #N/A
    /// shows #N/A where Sum of Amount shows #DIV/0!).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<u8>,
}

impl AggregateAccumulator {
    pub fn new() -> Self {
        AggregateAccumulator {
            sum: 0.0,
            count: 0,
            count_numbers: 0,
            min: None,
            max: None,
            product: 1.0,
            m2: 0.0,
            mean: 0.0,
            has_product: false,
            first_error: None,
            last_error: None,
        }
    }

    /// Adds a source error (an [`accumulator_error_index`]): counted by
    /// Count, and the result of every numeric summary.
    pub fn add_error(&mut self, error: u8) {
        self.count += 1;
        if self.first_error.is_none() {
            self.first_error = Some(error);
        }
        self.last_error = Some(error);
    }

    /// Adds one record's contribution.
    pub(crate) fn add_contribution(&mut self, contribution: SourceContribution) {
        match contribution {
            SourceContribution::Empty => {}
            SourceContribution::Number(n) => self.add_number(n),
            SourceContribution::Other => self.add_non_number(),
            SourceContribution::Error(e) => self.add_error(e),
        }
    }

    /// The error a summary of this accumulator shows instead of a number, as
    /// a bare code (`"DIV/0!"`), or `None` when it shows [`Self::compute`]'s
    /// number. Excel [LIVE, piv4 probe4]: a source error is the result of
    /// every summary but Count and Count Numbers; with no NUMBER at all
    /// Average is #DIV/0!, and StdDev / Var need two numbers (StdDevP / VarP
    /// one), else #DIV/0! -- while Sum, Max, Min and Product of no numbers
    /// read 0. An accumulator nothing reached (`count == 0`) is the empty
    /// cell, never an error.
    pub fn error_code(&self, aggregation: AggregationType) -> Option<&'static str> {
        if self.count == 0 {
            return None;
        }
        if matches!(aggregation, AggregationType::Count | AggregationType::CountNumbers) {
            return None;
        }
        if let Some(e) = self.first_error {
            return Some(accumulator_error_code(e));
        }
        let too_few = match aggregation {
            AggregationType::Average | AggregationType::VarP | AggregationType::StdDevP => self.count_numbers == 0,
            AggregationType::Var | AggregationType::StdDev => self.count_numbers < 2,
            _ => false,
        };
        too_few.then_some("DIV/0!")
    }

    /// Adds a numeric value to the accumulator.
    pub fn add_number(&mut self, value: f64) {
        // Count
        self.count += 1;
        self.count_numbers += 1;
        
        // Sum
        self.sum += value;
        
        // Min/Max
        self.min = Some(self.min.map_or(value, |m| m.min(value)));
        self.max = Some(self.max.map_or(value, |m| m.max(value)));
        
        // Product
        if !self.has_product {
            self.has_product = true;
            self.product = value;
        } else {
            self.product *= value;
        }
        
        // Welford's algorithm for variance
        let delta = value - self.mean;
        self.mean += delta / (self.count_numbers as f64);
        let delta2 = value - self.mean;
        self.m2 += delta * delta2;
    }
    
    /// Adds a non-numeric value (only increments count).
    pub fn add_non_number(&mut self) {
        self.count += 1;
    }

    /// Computes the final aggregate value.
    pub fn compute(&self, aggregation: AggregationType) -> f64 {
        match aggregation {
            AggregationType::Sum => self.sum,
            AggregationType::Count => self.count as f64,
            AggregationType::CountNumbers => self.count_numbers as f64,
            AggregationType::Average => {
                if self.count_numbers > 0 {
                    self.sum / (self.count_numbers as f64)
                } else {
                    0.0
                }
            }
            AggregationType::Min => self.min.unwrap_or(0.0),
            AggregationType::Max => self.max.unwrap_or(0.0),
            AggregationType::Product => {
                if self.has_product {
                    self.product
                } else {
                    0.0
                }
            }
            AggregationType::Var => {
                if self.count_numbers > 1 {
                    self.m2 / ((self.count_numbers - 1) as f64)
                } else {
                    0.0
                }
            }
            AggregationType::VarP => {
                if self.count_numbers > 0 {
                    self.m2 / (self.count_numbers as f64)
                } else {
                    0.0
                }
            }
            AggregationType::StdDev => {
                if self.count_numbers > 1 {
                    (self.m2 / ((self.count_numbers - 1) as f64)).sqrt()
                } else {
                    0.0
                }
            }
            AggregationType::StdDevP => {
                if self.count_numbers > 0 {
                    (self.m2 / (self.count_numbers as f64)).sqrt()
                } else {
                    0.0
                }
            }
        }
    }
    
    /// Merges another accumulator into this one (for parallel computation).
    pub fn merge(&mut self, other: &AggregateAccumulator) {
        if other.count == 0 {
            return;
        }
        
        let combined_count = self.count_numbers + other.count_numbers;
        
        // Parallel Welford merge
        if combined_count > 0 && self.count_numbers > 0 && other.count_numbers > 0 {
            let delta = other.mean - self.mean;
            let new_mean = self.mean + delta * (other.count_numbers as f64) / (combined_count as f64);
            self.m2 = self.m2 + other.m2 + 
                delta * delta * (self.count_numbers as f64) * (other.count_numbers as f64) / (combined_count as f64);
            self.mean = new_mean;
        } else if other.count_numbers > 0 {
            self.mean = other.mean;
            self.m2 = other.m2;
        }
        
        self.sum += other.sum;
        self.count += other.count;
        self.count_numbers = combined_count;
        if self.first_error.is_none() {
            self.first_error = other.first_error;
        }
        if other.last_error.is_some() {
            self.last_error = other.last_error;
        }
        
        if let Some(other_min) = other.min {
            self.min = Some(self.min.map_or(other_min, |m| m.min(other_min)));
        }
        if let Some(other_max) = other.max {
            self.max = Some(self.max.map_or(other_max, |m| m.max(other_max)));
        }
        
        if other.has_product {
            if self.has_product {
                self.product *= other.product;
            } else {
                self.product = other.product;
                self.has_product = true;
            }
        }
    }
}

// ============================================================================
// PRE-COMPUTED AGGREGATES
// ============================================================================

/// Pre-computed aggregate values for a specific group and value field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComputedAggregate {
    /// The computed result for each aggregation type.
    /// Key is the value field index, value is the accumulator.
    pub accumulators: Vec<AggregateAccumulator>,
}

// ============================================================================
// MAIN CACHE STRUCT
// ============================================================================

/// Layout information for flattening column combinations into array indices.
/// Enables O(1) column lookups by replacing HashMap with arithmetic indexing.
///
/// Per column field `i` the slots are: the interned members `0..card[i]`,
/// then -- only when the field has one -- the BLANK member
/// ([`VALUE_ID_BLANK`]) at `card[i]`, then the subtotal slot
/// ([`VALUE_ID_EMPTY`]). A key naming a member the layout has no slot for
/// reads the VOID combination, which nothing ever accumulates into: it used
/// to be clamped onto the subtotal slot, so a member missing from the layout
/// silently read its total.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ColumnLayout {
    /// Interned member count of each column field (the blank excluded).
    cardinalities: Vec<usize>,
    /// Whether each column field has a BLANK member (some record's value is
    /// blank): its slot is `cardinalities[i]`, and the subtotal slot follows.
    #[serde(default)]
    has_blank: Vec<bool>,
    /// Strides for index computation. stride[i] = product of (slots[j]+1)
    /// for j > i, where slots[j] = card[j] + has_blank[j].
    strides: Vec<usize>,
    /// Total number of column combinations = product of (slots[i]+1), plus
    /// the one VOID combination (see [`Self::void_index`]) when there are
    /// column fields.
    pub total_combinations: usize,
    /// Number of value fields.
    pub value_count: usize,
}

impl ColumnLayout {
    /// Builds a ColumnLayout from column field cardinalities (interned
    /// members), whether each field has a blank member, and the value count.
    fn new(col_cardinalities: &[usize], col_has_blank: &[bool], value_count: usize) -> Self {
        let col_count = col_cardinalities.len();
        if col_count == 0 {
            return ColumnLayout {
                cardinalities: Vec::new(),
                has_blank: Vec::new(),
                strides: Vec::new(),
                total_combinations: 1, // single "no-column" slot
                value_count,
            };
        }

        let has_blank: Vec<bool> = (0..col_count).map(|i| col_has_blank.get(i).copied().unwrap_or(false)).collect();
        let width = |i: usize| col_cardinalities[i] + usize::from(has_blank[i]) + 1;
        let mut strides = vec![1usize; col_count];
        // strides[last] = 1, strides[i] = product of width(j) for j > i
        for i in (0..col_count - 1).rev() {
            strides[i] = strides[i + 1] * width(i + 1);
        }
        let real = strides[0] * width(0);

        ColumnLayout {
            cardinalities: col_cardinalities.to_vec(),
            has_blank,
            strides,
            total_combinations: real + 1, // + the void combination
            value_count,
        }
    }

    /// The combination a key naming a member without a slot reads: always
    /// empty, because nothing accumulates into it.
    #[inline(always)]
    pub fn void_index(&self) -> usize {
        self.total_combinations - 1
    }

    /// The slot of `vid` in column field `i`: an interned member, the blank
    /// member, or the subtotal ([`VALUE_ID_EMPTY`]). `None` when the field has
    /// no such member.
    #[inline(always)]
    fn slot(&self, i: usize, vid: ValueId) -> Option<usize> {
        let card = self.cardinalities[i];
        let blank = self.has_blank.get(i).copied().unwrap_or(false);
        if vid == VALUE_ID_EMPTY {
            Some(card + usize::from(blank))
        } else if vid == VALUE_ID_BLANK {
            if blank { Some(card) } else { None }
        } else if (vid as usize) < card {
            Some(vid as usize)
        } else {
            None
        }
    }

    /// The flat column index of `col_key` with every position at or after
    /// `level` read as a subtotal ("all values"); `None` when the key names a
    /// member some field has no slot for.
    #[inline(always)]
    fn try_col_index_at_level(&self, col_key: &[ValueId], level: usize) -> Option<usize> {
        let mut idx = 0;
        for i in 0..self.cardinalities.len() {
            let vid = if i < level { col_key.get(i).copied().unwrap_or(VALUE_ID_EMPTY) } else { VALUE_ID_EMPTY };
            idx += self.slot(i, vid)? * self.strides[i];
        }
        Some(idx)
    }

    /// Computes the flat column index for a column key slice.
    /// VALUE_ID_EMPTY -- and any position past the key's end -- maps to the
    /// subtotal slot; VALUE_ID_BLANK to the blank member's slot. A key naming
    /// a member without a slot maps to [`Self::void_index`].
    #[inline(always)]
    pub fn col_index(&self, col_key: &[ValueId]) -> usize {
        if self.cardinalities.is_empty() {
            return 0;
        }
        self.try_col_index_at_level(col_key, col_key.len())
            .unwrap_or_else(|| self.void_index())
    }

    /// Returns the flat index into the accumulator array for a specific
    /// column combination and value field.
    #[inline(always)]
    pub fn acc_index(&self, col_key: &[ValueId], value_field_idx: usize) -> usize {
        self.col_index(col_key) * self.value_count + value_field_idx
    }

    /// Total number of accumulators per row slot.
    #[inline(always)]
    pub fn slot_len(&self) -> usize {
        self.total_combinations * self.value_count
    }

    /// The grain level of flat column index `idx`: how many column fields
    /// (outermost first) it names a member of, every later one being the
    /// subtotal. `None` for the void combination and any index that is not
    /// such a prefix.
    fn col_level(&self, idx: usize) -> Option<usize> {
        if self.cardinalities.is_empty() {
            return (idx == 0).then_some(0);
        }
        if idx >= self.void_index() {
            return None;
        }
        let mut level = 0;
        let mut in_totals = false;
        for i in 0..self.cardinalities.len() {
            let total_slot = self.cardinalities[i] + usize::from(self.has_blank.get(i).copied().unwrap_or(false));
            let digit = (idx / self.strides[i]) % (total_slot + 1);
            if digit == total_slot {
                in_totals = true;
            } else if in_totals {
                return None;
            } else {
                level += 1;
            }
        }
        Some(level)
    }
}

/// The main pivot cache structure.
/// Designed for 1M+ row performance with O(1) lookups after initial build.
///
/// Aggregates use a two-level structure: row keys in a HashMap, column
/// combinations as flat arrays. This reduces HashMap entries by a factor
/// of `column_combinations` and replaces column hashing with arithmetic.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PivotCache {
    /// The pivot table ID this cache belongs to.
    pub pivot_id: PivotId,

    /// Version from the definition (for invalidation checking).
    pub definition_version: u64,

    /// Cache for each source field (column).
    pub fields: Vec<FieldCache>,

    /// All source records, stored as interned value IDs.
    pub records: Vec<CacheRecord>,

    /// Pre-computed aggregates keyed by ROW-only GroupKey.
    /// Each entry is a flat array of accumulators:
    ///   slot[col_index * value_count + value_field_idx]
    /// where col_index is computed via ColumnLayout.
    #[serde(with = "aggregates_pairs")]
    aggregates: FxHashMap<GroupKey, Vec<AggregateAccumulator>>,

    /// Column layout for computing flat column indices.
    col_layout: ColumnLayout,

    /// Whether aggregates need recomputation.
    aggregates_dirty: bool,

    /// Whether the last aggregate computation added any source error (see
    /// [`PivotCache::rederive_total_errors`]).
    #[serde(default, skip)]
    source_errors_seen: bool,

    /// Whether the last aggregate computation left some subtotal of a
    /// GROUPED level EMPTY for a value field whose totals are not the sum of
    /// its leaves (see [`PivotCache::grouped_totals_withheld`]).
    #[serde(default, skip)]
    grouped_totals_withheld: bool,

    /// Bitmap of which records pass the current filters.
    /// Length = records.len(), true = included.
    pub filter_mask: Vec<bool>,

    /// Virtual fields created by grouping transforms (date grouping, number binning, manual grouping).
    /// Indexed starting at fields.len(), so virtual field i is at index fields.len() + i.
    /// Each virtual field maps source record indices to transformed ValueIds.
    pub virtual_fields: Vec<FieldCache>,

    /// Mapping from source record index to virtual field ValueIds.
    /// virtual_records[virtual_field_index][record_index] = ValueId
    pub virtual_records: Vec<Vec<ValueId>>,

    /// The SOURCE field each virtual field was made from
    /// (`virtual_origins[virtual_field_index]` = a base field index): the
    /// field a grouped item's sort or filter belongs to
    /// ([`PivotCache::virtual_field_origin`], BUG-0733). Rebuilt with the
    /// virtual fields on every render.
    #[serde(default)]
    pub virtual_origins: Vec<FieldIndex>,

    /// Per virtual field, parallel to `virtual_origins`: the grouping LEVEL
    /// it is (`definition::LevelSort::level`) when it is a field of its own
    /// -- a manual group's parent, a date level above the finest -- whose
    /// sort is kept apart from its origin's; `None` when it stands for the
    /// origin field itself (a number bin, the finest date level).
    #[serde(default)]
    pub virtual_levels: Vec<Option<String>>,

    /// Statistics for optimization decisions.
    pub stats: CacheStats,

    /// Engine-evaluated totals installed by the host for BI-backed pivots.
    /// Applied (accumulator-slot overwrite) at the end of
    /// `compute_aggregates`; only valid for the unfiltered record set (a
    /// filtered state has its own, in [`PivotCache::mask_overlays`]).
    /// See [`TotalOverride`].
    #[serde(default)]
    pub total_overrides: Vec<TotalOverride>,

    /// Engine-evaluated values for FILTERED states of a BI-backed pivot
    /// (BUG-0108), newest first, at most [`MAX_MASK_OVERLAYS`]. Each is keyed
    /// by exactly the filter mask and field layout it was evaluated for and
    /// applies only to that state -- see [`MaskOverlay`]. It describes THESE
    /// records, so it travels with every clone and undo snapshot of the cache;
    /// a BI cache is never written to a workbook file, so it is never saved.
    #[serde(default)]
    pub mask_overlays: Vec<MaskOverlay>,

    /// Which value columns of these records a host-side filter mask can get
    /// wrong (BUG-0108), decided by the host from the model when it fetched
    /// them. `None` for a cache nobody classified (a range pivot, a
    /// calculation group): its masked values are never re-evaluated.
    #[serde(default)]
    pub mask_sensitivity: Option<MaskSensitivity>,

    /// The identity of these records: [`PivotCache::new`] mints a fresh one for
    /// every cache, and clones and undo snapshots keep it. A host that
    /// evaluates an overlay ASYNCHRONOUSLY checks it before installing the
    /// answer, so an overlay computed for records a concurrent re-query has
    /// since replaced is dropped instead of being laid over the new ones. `0`
    /// (a snapshot written before the field existed) names no records.
    #[serde(default)]
    pub build_id: u64,
}

/// How many filtered states' overlays one cache keeps
/// ([`PivotCache::mask_overlays`]): a slicer clicked back and forth, or an undo
/// and redo of one, finds its overlay again without another engine query.
pub const MAX_MASK_OVERLAYS: usize = 8;

/// The source of [`PivotCache::build_id`]: process-wide, never reused.
static NEXT_CACHE_BUILD_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// The engine-evaluated values of ONE filtered state of a BI-backed pivot
/// (BUG-0108).
///
/// A BI pivot's records are pre-aggregated per leaf group WITHOUT the pivot's
/// own level-1 filters -- slicers, header filters, the filter area -- because
/// filtering is a host-side mask over them: a click re-queries nothing. For an
/// additive measure that is exact. For a measure whose value depends on rows
/// the mask hides (a share of the visible total, `ALLSELECTED` /
/// `CLEAR_INNER`; a window) or whose total is not the sum of its leaves (a
/// ratio, an average) it is not: the engine chose those numbers over a filter
/// context with no filter in it. The host evaluates them again over the
/// members the mask leaves VISIBLE and installs the answer here.
///
/// An overlay is keyed by EXACTLY the filter mask (one bit per record) and the
/// effective field layout it was evaluated for, and `compute_aggregates`
/// splices it only over that state ([`MaskOverlay::matches`]). A later filter,
/// an unfilter, an undo or a redo that leaves a different mask finds no
/// overlay and gets the masked roll-up -- never another state's numbers; one
/// that returns to this mask finds it again. The records are never touched.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MaskOverlay {
    /// The filter mask evaluated for, one bit per record ([`pack_filter_mask`]).
    pub mask: Vec<u64>,
    /// How many records `mask` covers.
    pub record_count: usize,
    /// The effective row field indices the overrides' row keys are over.
    pub row_fields: Vec<FieldIndex>,
    /// The effective column field indices the column keys are over.
    pub col_fields: Vec<FieldIndex>,
    /// The value field source indices, in definition order: what each
    /// override's `values` are parallel to.
    pub value_fields: Vec<FieldIndex>,
    /// The engine's cells -- leaf, subtotal and grand-total slots alike --
    /// keyed and applied exactly as a [`TotalOverride`] is. May be EMPTY: the
    /// engine refused this state, and remembering that keeps the next click on
    /// it from asking again.
    pub overrides: Vec<TotalOverride>,
    /// The grains (and, per grain, the value fields) the engine ANSWERED.
    /// Its answer at such a grain is the whole truth: every cell of the grain
    /// a value field's answer does not name is BLANK -- the engine leaves out
    /// a row whose measures are all BLANK (`IF(ISFILTERED(..), BLANK(), ..)`
    /// under a slicer), and an override can only carry a number. The masked
    /// roll-up used to stand in such a cell (W1 pivotmask verifier,
    /// `an_overlay_blanks_what_the_engine_answers_blank`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub answered: Vec<AnsweredGrain>,
}

/// One grain a [`MaskOverlay`] holds the engine's whole answer for.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnsweredGrain {
    /// How many row fields (outermost first) the grain groups by.
    pub row_depth: usize,
    /// How many column fields the grain groups by.
    pub col_depth: usize,
    /// The value fields (definition order) the engine answered there.
    pub value_fields: Vec<usize>,
}

impl MaskOverlay {
    /// Whether this overlay was evaluated for exactly `filter_mask` over this
    /// field layout.
    pub fn matches(
        &self,
        filter_mask: &[bool],
        row_fields: &[FieldIndex],
        col_fields: &[FieldIndex],
        value_fields: &[FieldIndex],
    ) -> bool {
        self.record_count == filter_mask.len()
            && self.row_fields == row_fields
            && self.col_fields == col_fields
            && self.value_fields == value_fields
            && mask_bits_equal(&self.mask, filter_mask)
    }
}

/// Which value columns of a BI cache a filter mask can get wrong (see
/// [`PivotCache::mask_sensitivity`]). Columns are CACHE field indices -- the
/// `source_index` of the value fields that show them.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct MaskSensitivity {
    /// Columns whose subtotals and grand totals under a mask are not the sum
    /// of the visible records' values (a ratio, an average, a share).
    pub total_fields: Vec<FieldIndex>,
    /// The subset whose LEAF values also depend on rows the mask hides (a
    /// share of the visible total, a window, `ISFILTERED`).
    pub leaf_fields: Vec<FieldIndex>,
}

/// `mask` packed one bit per record, record `i` at bit `i % 64` of word
/// `i / 64` (set = included).
pub fn pack_filter_mask(mask: &[bool]) -> Vec<u64> {
    let mut bits = vec![0u64; mask.len().div_ceil(64)];
    for (i, &included) in mask.iter().enumerate() {
        if included {
            bits[i / 64] |= 1u64 << (i % 64);
        }
    }
    bits
}

/// Overwrites accumulator slots with `overrides` (see [`TotalOverride`]): each
/// `Some` value REPLACES its slot (a fresh accumulator holding that one
/// number), a missing row slot is created, and an entry whose key shape does
/// not match the current axis layout -- or names a column member the layout
/// has no slot for -- is skipped (a stale entry: writing it would fill the
/// void every missing key reads).
fn splice_overrides(
    aggregates: &mut FxHashMap<GroupKey, Vec<AggregateAccumulator>>,
    col_layout: &ColumnLayout,
    overrides: &[TotalOverride],
    row_count: usize,
    col_count: usize,
    value_count: usize,
    slot_len: usize,
) {
    for ov in overrides {
        if ov.row_key.len() != row_count || ov.col_key.len() != col_count {
            continue;
        }
        let col_index = if col_count == 0 {
            0
        } else {
            match col_layout.try_col_index_at_level(&ov.col_key, col_count) {
                Some(idx) => idx,
                None => continue,
            }
        };
        let base = col_index * value_count;
        let slot = aggregates
            .entry(GroupKey::from_slice(&ov.row_key))
            .or_insert_with(|| vec![AggregateAccumulator::new(); slot_len]);
        for (vi, value) in ov.values.iter().enumerate().take(value_count) {
            if let Some(n) = value {
                if let Some(acc) = slot.get_mut(base + vi) {
                    let mut replacement = AggregateAccumulator::new();
                    replacement.add_number(*n);
                    *acc = replacement;
                }
            }
        }
    }
}

/// Whether a data-model pivot's value at an axis grain of `depth` levels (of
/// `count`) is one the engine evaluated, when the levels at `grouped` are
/// GROUPED (virtual) ones: a grain naming no grouped member (the host's
/// totals override it), or a LEAF with a source field below its last grouped
/// level (the main query's own value -- a manual group's detail). Any other
/// -- a group's subtotal, a date level or a bin, which replace the source
/// field -- is a roll-up nothing evaluated (see `withhold_grouped_totals`).
fn grain_is_evaluated(depth: usize, count: usize, grouped: &[usize]) -> bool {
    let Some(&last_grouped) = grouped.iter().filter(|&&j| j < depth).max() else {
        return true;
    };
    depth == count && (last_grouped + 1..count).any(|k| !grouped.contains(&k))
}

/// Whether `bits` ([`pack_filter_mask`]) packs exactly `mask`.
fn mask_bits_equal(bits: &[u64], mask: &[bool]) -> bool {
    if bits.len() != mask.len().div_ceil(64) {
        return false;
    }
    mask.chunks(64).zip(bits.iter()).all(|(chunk, &word)| {
        let mut packed = 0u64;
        for (i, &included) in chunk.iter().enumerate() {
            if included {
                packed |= 1u64 << i;
            }
        }
        packed == word
    })
}

/// One engine-evaluated total cell for a BI-backed pivot.
///
/// BI pivot caches hold PRE-AGGREGATED rows (one per leaf group combination),
/// so the additive roll-up in `compute_aggregates` is only an identity for
/// leaf cells. Subtotal / grand-total cells of non-additive measures (ratios,
/// averages, distinct counts) must instead be evaluated by the BI engine in
/// each total's own filter context. The host queries every total grain and
/// installs the results via `set_total_overrides`; `compute_aggregates`
/// overwrites the corresponding accumulator slots after rolling up, so every
/// read path (data cells, show-values-as, visual calcs) sees them unchanged.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TotalOverride {
    /// Full-length row key over the effective row fields; positions beyond the
    /// grain's depth are VALUE_ID_EMPTY (matching subtotal/grand-total keys),
    /// and a blank member is VALUE_ID_BLANK, as in every group key.
    pub row_key: Vec<ValueId>,
    /// Full-length column key over the effective column fields, padded the
    /// same way (empty when there are no column fields).
    pub col_key: Vec<ValueId>,
    /// One entry per value field, in definition order. `None` keeps the
    /// rolled-up value for that field.
    pub values: Vec<Option<f64>>,
}

/// Statistics about the cache for optimization.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CacheStats {
    pub total_records: usize,
    pub filtered_records: usize,
    pub unique_value_count: usize,
    pub aggregate_groups: usize,
    pub build_time_ms: u64,
}

impl PivotCache {
    /// Creates a new empty cache.
    pub fn new(pivot_id: PivotId, field_count: usize) -> Self {
        PivotCache {
            pivot_id,
            definition_version: 0,
            fields: (0..field_count)
                .map(|i| FieldCache::new(i, format!("Field{}", i)))
                .collect(),
            records: Vec::new(),
            aggregates: FxHashMap::default(),
            col_layout: ColumnLayout::default(),
            aggregates_dirty: true,
            source_errors_seen: false,
            grouped_totals_withheld: false,
            filter_mask: Vec::new(),
            virtual_fields: Vec::new(),
            virtual_records: Vec::new(),
            virtual_origins: Vec::new(),
            virtual_levels: Vec::new(),
            stats: CacheStats::default(),
            total_overrides: Vec::new(),
            mask_overlays: Vec::new(),
            mask_sensitivity: None,
            build_id: NEXT_CACHE_BUILD_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        }
    }
    
    /// Reserves capacity for expected record count (performance optimization).
    pub fn reserve(&mut self, record_count: usize) {
        self.records.reserve(record_count);
        self.filter_mask.reserve(record_count);
    }
    
    /// Adds a record to the cache.
    /// Values should be in field order.
    pub fn add_record(&mut self, source_row: u32, values: &[CellValue]) {
        let mut interned_values = Vec::with_capacity(self.fields.len());
        
        for (i, value) in values.iter().enumerate() {
            if i < self.fields.len() {
                let cache_value = CacheValue::from(value);
                let value_id = self.fields[i].intern(cache_value);
                interned_values.push(value_id);
            }
        }
        
        // Pad with empty if needed
        while interned_values.len() < self.fields.len() {
            interned_values.push(VALUE_ID_EMPTY);
        }
        
        self.records.push(CacheRecord {
            source_row,
            values: interned_values,
        });
        self.filter_mask.push(true); // Default: include all
        self.aggregates_dirty = true;
    }
    
    /// Sets the field name (from header row).
    pub fn set_field_name(&mut self, field_index: FieldIndex, name: String) {
        if field_index < self.fields.len() {
            self.fields[field_index].name = name;
        }
    }
    
    /// Applies filters and updates the filter mask.
    pub fn apply_filters(&mut self, hidden_items: &[(FieldIndex, Vec<ValueId>)]) {
        // Reset filter mask
        for mask in self.filter_mask.iter_mut() {
            *mask = true;
        }

        // Apply each field's hidden items
        for (field_idx, hidden) in hidden_items {
            if *field_idx >= self.fields.len() {
                continue;
            }

            for (i, record) in self.records.iter().enumerate() {
                if !self.filter_mask[i] {
                    continue; // Already filtered out
                }

                let value_id = record.values.get(*field_idx).copied().unwrap_or(VALUE_ID_EMPTY);
                if hidden.contains(&value_id) {
                    self.filter_mask[i] = false;
                }
            }
        }

        // Update stats
        self.stats.filtered_records = self.filter_mask.iter().filter(|&&x| x).count();
        self.aggregates_dirty = true;
    }

    /// Pre-filters records based on Page Filter selections.
    /// This acts as a "pre-filter" on the dataset before aggregation happens.
    /// Only records matching ALL page filter selections are included.
    ///
    /// # Arguments
    /// * `page_filters` - A map from field index to the set of allowed ValueIds.
    ///   If a field is in the map, only records with values in the HashSet are included.
    ///   If the HashSet is empty, all values for that field are excluded.
    pub fn pre_filter_records(&mut self, page_filters: &HashMap<FieldIndex, HashSet<ValueId>>) {
        // Reset filter mask
        for mask in self.filter_mask.iter_mut() {
            *mask = true;
        }

        // Skip if no page filters
        if page_filters.is_empty() {
            self.stats.filtered_records = self.records.len();
            self.aggregates_dirty = true;
            return;
        }

        // Apply page filters - record must match ALL filter criteria
        for (i, record) in self.records.iter().enumerate() {
            if !self.filter_mask[i] {
                continue; // Already filtered out
            }

            // Check each page filter
            for (field_idx, allowed_values) in page_filters {
                if *field_idx >= self.fields.len() {
                    continue;
                }

                let value_id = record.values.get(*field_idx).copied().unwrap_or(VALUE_ID_EMPTY);

                // If the value is not in the allowed set, exclude this record
                if !allowed_values.contains(&value_id) {
                    self.filter_mask[i] = false;
                    break; // No need to check other filters
                }
            }
        }

        // Update stats
        self.stats.filtered_records = self.filter_mask.iter().filter(|&&x| x).count();
        self.aggregates_dirty = true;
    }

    /// Applies both page filters and hidden item filters in sequence.
    /// Page filters are applied first (inclusion filter), then hidden items (exclusion filter).
    ///
    /// # Arguments
    /// * `page_filters` - Map of field index to allowed ValueIds (inclusion filter)
    /// * `hidden_items` - List of (field_index, hidden_value_ids) tuples (exclusion filter)
    pub fn apply_combined_filters(
        &mut self,
        page_filters: &HashMap<FieldIndex, HashSet<ValueId>>,
        hidden_items: &[(FieldIndex, Vec<ValueId>)],
    ) {
        // Reset filter mask
        for mask in self.filter_mask.iter_mut() {
            *mask = true;
        }

        // First pass: apply page filters (inclusion filter)
        if !page_filters.is_empty() {
            for (i, record) in self.records.iter().enumerate() {
                for (field_idx, allowed_values) in page_filters {
                    if *field_idx >= self.fields.len() {
                        continue;
                    }

                    let value_id = record.values.get(*field_idx).copied().unwrap_or(VALUE_ID_EMPTY);
                    if !allowed_values.contains(&value_id) {
                        self.filter_mask[i] = false;
                        break;
                    }
                }
            }
        }

        // Second pass: apply hidden items filter (exclusion filter)
        for (field_idx, hidden) in hidden_items {
            if *field_idx >= self.fields.len() {
                continue;
            }

            for (i, record) in self.records.iter().enumerate() {
                if !self.filter_mask[i] {
                    continue; // Already filtered out
                }

                let value_id = record.values.get(*field_idx).copied().unwrap_or(VALUE_ID_EMPTY);
                if hidden.contains(&value_id) {
                    self.filter_mask[i] = false;
                }
            }
        }

        // Update stats
        self.stats.filtered_records = self.filter_mask.iter().filter(|&&x| x).count();
        self.aggregates_dirty = true;
    }

    /// Returns all unique values for a specific filter field.
    /// Used for populating the dropdown list in Page Filters.
    ///
    /// # Arguments
    /// * `field_index` - The index of the field to get unique values for
    ///
    /// # Returns
    /// A vector of (ValueId, String) pairs where the string is the display label
    pub fn get_unique_values_for_filter(&self, field_index: FieldIndex) -> Vec<(ValueId, String)> {
        let mut result = Vec::new();

        if let Some(field_cache) = self.fields.get(field_index) {
            for id in 0..field_cache.unique_count() as ValueId {
                if let Some(value) = field_cache.get_value(id) {
                    let label = match value {
                        CacheValue::Empty => "(blank)".to_string(),
                        CacheValue::Number(n) => format!("{}", n.as_f64()),
                        CacheValue::Text(s) => s.clone(),
                        CacheValue::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
                        CacheValue::Error(e) => format!("#{}", e),
                    };
                    result.push((id, label));
                }
            }
        }

        result
    }

    /// [`PivotCache::get_unique_values_for_filter`] with each member's
    /// [`MemberSource`]: `(id, key, source)`. The key is that function's OWN
    /// spelling, unchanged; the source is [`FieldCache::member_source`].
    pub fn get_unique_members_for_filter(&self, field_index: FieldIndex) -> Vec<(ValueId, String, MemberSource)> {
        let Some(field_cache) = self.fields.get(field_index) else { return Vec::new() };
        self.get_unique_values_for_filter(field_index)
            .into_iter()
            .map(|(id, key)| {
                let source = field_cache.member_source(id);
                (id, key, source)
            })
            .collect()
    }

    /// [`PivotCache::get_unique_values_for_filter_in_data`] with each
    /// member's [`MemberSource`]: `(id, key, source)`, in that function's
    /// order and with its OWN key spelling ("(blank)" for the blank).
    pub fn get_unique_members_for_filter_in_data(&self, field_index: FieldIndex) -> Vec<(ValueId, String, MemberSource)> {
        let Some(field_cache) = self.fields.get(field_index) else { return Vec::new() };
        self.get_unique_values_for_filter_in_data(field_index)
            .into_iter()
            .map(|(id, key)| {
                let source = field_cache.member_source(id);
                (id, key, source)
            })
            .collect()
    }

    /// Returns unique values for a filter field that exist in the current filtered dataset.
    /// This is useful when cascading filters (showing only values that exist after other filters).
    ///
    /// # Arguments
    /// * `field_index` - The index of the field to get unique values for
    ///
    /// # Returns
    /// A vector of (ValueId, String) pairs for values that exist in filtered records
    pub fn get_unique_values_for_filter_in_data(&self, field_index: FieldIndex) -> Vec<(ValueId, String)> {
        let mut seen_ids: FxHashSet<ValueId> = FxHashSet::default();

        // Collect unique value IDs from filtered records
        for (i, record) in self.records.iter().enumerate() {
            if !self.filter_mask[i] {
                continue;
            }

            if let Some(&value_id) = record.values.get(field_index) {
                seen_ids.insert(value_id);
            }
        }

        // Convert to (ValueId, label) pairs
        let mut result = Vec::with_capacity(seen_ids.len());

        if let Some(field_cache) = self.fields.get(field_index) {
            for id in seen_ids {
                let label = if id == VALUE_ID_EMPTY {
                    "(blank)".to_string()
                } else if let Some(value) = field_cache.get_value(id) {
                    match value {
                        CacheValue::Empty => "(blank)".to_string(),
                        CacheValue::Number(n) => format!("{}", n.as_f64()),
                        CacheValue::Text(s) => s.clone(),
                        CacheValue::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
                        CacheValue::Error(e) => format!("#{}", e),
                    }
                } else {
                    "(unknown)".to_string()
                };
                result.push((id, label));
            }
        }

        // Sort by label for consistent ordering
        result.sort_by(|a, b| a.1.cmp(&b.1));

        result
    }
    
    /// Returns an iterator over filtered records.
    pub fn filtered_records(&self) -> impl Iterator<Item = &CacheRecord> {
        self.records
            .iter()
            .zip(self.filter_mask.iter())
            .filter_map(|(record, &included)| if included { Some(record) } else { None })
    }

    /// Returns an iterator over filtered records with their indices.
    pub fn filtered_records_indexed(&self) -> impl Iterator<Item = (usize, &CacheRecord)> {
        self.records
            .iter()
            .enumerate()
            .zip(self.filter_mask.iter())
            .filter_map(|((idx, record), &included)| {
                if included { Some((idx, record)) } else { None }
            })
    }
    
    /// Gets or computes the aggregate for a combined row+col group key.
    /// Triggers lazy computation if aggregates are dirty.
    pub fn get_aggregate(
        &mut self,
        group_key: &GroupKey,
        row_field_indices: &[FieldIndex],
        col_field_indices: &[FieldIndex],
        value_field_indices: &[FieldIndex],
    ) -> Option<&Vec<AggregateAccumulator>> {
        if self.aggregates_dirty {
            self.compute_aggregates(row_field_indices, col_field_indices, value_field_indices);
        }

        // Split the combined key into row portion — the HashMap key
        let row_count = row_field_indices.len();
        let row_key = &group_key.values[..row_count.min(group_key.values.len())];
        self.aggregates.get(row_key)
    }

    /// Returns the row slot (flat array of all column × value accumulators)
    /// for the given row key. Use with `col_layout()` for column indexing.
    pub fn get_row_slot(&self, row_key: &[ValueId]) -> Option<&Vec<AggregateAccumulator>> {
        self.aggregates.get(row_key)
    }

    /// Returns the column layout for computing flat column indices.
    pub fn col_layout(&self) -> &ColumnLayout {
        &self.col_layout
    }

    /// Whether the last aggregate computation saw a source error.
    pub fn source_errors_seen(&self) -> bool {
        self.source_errors_seen
    }

    /// Whether the last aggregate computation WITHHELD (left empty) some
    /// subtotal of a grouped level -- a manual group, a date level, a bin --
    /// for a value field `mask_sensitivity` marks as non-additive. The host
    /// evaluates a data-model pivot's totals per SOURCE member, so nothing
    /// evaluates a group's own total, and the rolled-up sum of its items is a
    /// wrong number for an average, a ratio or a distinct count (wave-3
    /// verify). The host tells the user so (a notice) rather than show it.
    pub fn grouped_totals_withheld(&self) -> bool {
        self.grouped_totals_withheld
    }

    /// Re-derives the errors of the total at `parent_key` from its children
    /// (`child_keys`, in DISPLAY order), slot by slot: its first error is the
    /// first child's that has one, its last error the last child's. Excel
    /// [LIVE, piv4 probe5] combines a total's errors from its items as they
    /// are shown -- the grand total over Aa #NUM!, Mm #DIV/0!, Zz #N/A reads
    /// #NUM! sorted ascending and #N/A sorted descending -- while one item's
    /// own cell takes the first error of its records in source order.
    pub fn rederive_total_errors(&mut self, parent_key: &[ValueId], child_keys: &[Vec<ValueId>]) {
        let slot_len = self.col_layout.slot_len();
        let mut derived: Vec<(Option<u8>, Option<u8>)> = vec![(None, None); slot_len];
        for key in child_keys {
            let Some(slot) = self.aggregates.get(key.as_slice()) else { continue };
            for (i, acc) in slot.iter().enumerate().take(slot_len) {
                if derived[i].0.is_none() {
                    derived[i].0 = acc.first_error;
                }
                if acc.last_error.is_some() {
                    derived[i].1 = acc.last_error;
                }
            }
        }
        let Some(parent) = self.aggregates.get_mut(parent_key) else { return };
        for (acc, (first, last)) in parent.iter_mut().zip(derived) {
            if acc.first_error.is_some() && first.is_some() {
                acc.first_error = first;
            }
            if acc.last_error.is_some() && last.is_some() {
                acc.last_error = last;
            }
        }
    }

    /// Read-only value→id lookup on field `field_index` (`None` when the value
    /// was never interned there). Used by the host to translate engine query
    /// results into cache keys without mutating the interning tables.
    pub fn find_value_id(&self, field_index: FieldIndex, value: &CacheValue) -> Option<ValueId> {
        self.fields.get(field_index).and_then(|f| f.find_id(value))
    }

    /// Installs engine-evaluated totals (see [`TotalOverride`]) and marks
    /// aggregates dirty so the next computation splices them in.
    pub fn set_total_overrides(&mut self, overrides: Vec<TotalOverride>) {
        self.total_overrides = overrides;
        self.aggregates_dirty = true;
    }

    /// Removes any installed engine-evaluated totals.
    pub fn clear_total_overrides(&mut self) {
        if !self.total_overrides.is_empty() {
            self.total_overrides.clear();
            self.aggregates_dirty = true;
        }
    }

    /// Installs the engine-evaluated values of one filtered state (see
    /// [`MaskOverlay`]) as the NEWEST overlay: one already installed for the
    /// same mask and layout is replaced, and beyond [`MAX_MASK_OVERLAYS`] the
    /// oldest is dropped. Marks aggregates dirty so the next computation
    /// splices it in.
    pub fn install_mask_overlay(&mut self, overlay: MaskOverlay) {
        self.mask_overlays.retain(|o| {
            !(o.mask == overlay.mask
                && o.record_count == overlay.record_count
                && o.row_fields == overlay.row_fields
                && o.col_fields == overlay.col_fields
                && o.value_fields == overlay.value_fields)
        });
        self.mask_overlays.insert(0, overlay);
        self.mask_overlays.truncate(MAX_MASK_OVERLAYS);
        self.aggregates_dirty = true;
    }

    /// The overlay evaluated for exactly the CURRENT filter mask over this
    /// field layout, if one is installed.
    pub fn mask_overlay_for(
        &self,
        row_fields: &[FieldIndex],
        col_fields: &[FieldIndex],
        value_fields: &[FieldIndex],
    ) -> Option<&MaskOverlay> {
        self.mask_overlays
            .iter()
            .find(|o| o.matches(&self.filter_mask, row_fields, col_fields, value_fields))
    }

    /// Computes all aggregates using a two-level row/column split.
    ///
    /// Row keys stay in a HashMap (high cardinality). Column combinations
    /// are stored as a flat array per row entry, indexed by arithmetic.
    /// This reduces HashMap entries by `column_combinations` and replaces
    /// column hashing with O(1) array indexing.
    fn compute_aggregates(
        &mut self,
        row_field_indices: &[FieldIndex],
        col_field_indices: &[FieldIndex],
        value_field_indices: &[FieldIndex],
    ) {
        self.aggregates.clear();
        self.source_errors_seen = false;
        self.grouped_totals_withheld = false;

        let value_count = value_field_indices.len();
        let row_count = row_field_indices.len();
        let col_count = col_field_indices.len();
        let base_field_count = self.fields.len();

        // Build column layout from field cardinalities, with a slot for the
        // blank member of every column field that has one (over ALL records,
        // so the layout does not move with the filters).
        let col_cardinalities: Vec<usize> = col_field_indices.iter().map(|&fi| {
            self.get_field(fi).map(|fc| fc.unique_count()).unwrap_or(1).max(1)
        }).collect();
        let col_has_blank: Vec<bool> = col_field_indices.iter().map(|&fi| {
            (0..self.records.len()).any(|ri| self.get_record_value_id(ri, fi) == VALUE_ID_EMPTY)
        }).collect();
        self.col_layout = ColumnLayout::new(&col_cardinalities, &col_has_blank, value_count);
        let slot_len = self.col_layout.slot_len();

        // Estimate row-only capacity
        let estimated_row_unique = {
            let mut est: usize = 1;
            for &fi in row_field_indices.iter() {
                let card = self.get_field(fi)
                    .map(|fc| fc.unique_count())
                    .unwrap_or(1)
                    .max(1);
                est = est.saturating_mul(card);
            }
            est.min(self.records.len()).min(500_000)
        };
        let row_subtotal_combos = row_count + 1;
        self.aggregates.reserve(estimated_row_unique * row_subtotal_combos);

        // Reusable buffers
        let mut row_buf = vec![VALUE_ID_EMPTY; row_count];
        let mut col_buf = vec![VALUE_ID_EMPTY; col_count];
        let mut value_buf: Vec<SourceContribution> = vec![SourceContribution::Empty; value_count];
        let mut row_key_buf = vec![VALUE_ID_EMPTY; row_count];

        // Helper: accumulate values into a row slot at a given column index
        #[inline(always)]
        fn accumulate_at(
            aggregates: &mut FxHashMap<GroupKey, Vec<AggregateAccumulator>>,
            row_key: &[ValueId],
            col_index: usize,
            value_buf: &[SourceContribution],
            value_count: usize,
            slot_len: usize,
        ) {
            let base = col_index * value_count;
            if let Some(slot) = aggregates.get_mut(row_key) {
                for (vi, &contribution) in value_buf.iter().enumerate() {
                    slot[base + vi].add_contribution(contribution);
                }
            } else {
                let mut slot = vec![AggregateAccumulator::new(); slot_len];
                for (vi, &contribution) in value_buf.iter().enumerate() {
                    slot[base + vi].add_contribution(contribution);
                }
                aggregates.insert(GroupKey::from_slice(row_key), slot);
            }
        }

        let col_layout = &self.col_layout;

        for (i, record) in self.records.iter().enumerate() {
            if !self.filter_mask[i] {
                continue;
            }

            // Fill row values buffer -- MEMBER ids: a blank record value is
            // the blank member (VALUE_ID_BLANK), never the "all values"
            // padding the subtotal keys below are built with.
            for (slot, &fi) in row_buf.iter_mut().zip(row_field_indices.iter()) {
                *slot = member_id(if fi < base_field_count {
                    record.values.get(fi).copied().unwrap_or(VALUE_ID_EMPTY)
                } else {
                    let vi = fi - base_field_count;
                    self.virtual_records.get(vi)
                        .and_then(|vr| vr.get(i))
                        .copied()
                        .unwrap_or(VALUE_ID_EMPTY)
                });
            }

            // Fill column values buffer (member ids, as above)
            for (slot, &fi) in col_buf.iter_mut().zip(col_field_indices.iter()) {
                *slot = member_id(if fi < base_field_count {
                    record.values.get(fi).copied().unwrap_or(VALUE_ID_EMPTY)
                } else {
                    let vi = fi - base_field_count;
                    self.virtual_records.get(vi)
                        .and_then(|vr| vr.get(i))
                        .copied()
                        .unwrap_or(VALUE_ID_EMPTY)
                });
            }

            // Fill value data buffer. Text and booleans are COUNTED and a
            // source error poisons every numeric summary over it (Excel [LIVE,
            // piv4 probe4]; numbers alone used to reach the accumulator, so
            // Count of a text field read 0 and a Sum over #DIV/0! read the sum
            // of the other rows).
            for (slot, &field_idx) in value_buf.iter_mut().zip(value_field_indices.iter()) {
                let value_id = record.values.get(field_idx).copied().unwrap_or(VALUE_ID_EMPTY);
                *slot = match self.fields.get(field_idx).and_then(|fc| fc.get_value(value_id)) {
                    Some(CacheValue::Number(n)) => SourceContribution::Number(n.0),
                    Some(CacheValue::Error(e)) => {
                        self.source_errors_seen = true;
                        SourceContribution::Error(accumulator_error_index(e))
                    }
                    Some(CacheValue::Text(_)) | Some(CacheValue::Boolean(_)) => SourceContribution::Other,
                    Some(CacheValue::Empty) | None => SourceContribution::Empty,
                };
            }

            // For each row subtotal level × each column subtotal level:
            // - Row subtotals: set trailing row positions to VALUE_ID_EMPTY (HashMap key)
            // - Column subtotals: compute flat index with VALUE_ID_EMPTY in trailing positions
            for row_level in 0..=row_count {
                // Build row subtotal key
                row_key_buf[..row_level.min(row_count)].copy_from_slice(&row_buf[..row_level.min(row_count)]);
                for j in row_level..row_count {
                    row_key_buf[j] = VALUE_ID_EMPTY;
                }

                for col_level in 0..=col_count {
                    // Column index with the first col_level values real and
                    // the rest the subtotal slot. Every record member has a
                    // slot (the layout was built from these records), so a
                    // miss is a defect -- skipped, never folded into the void.
                    let col_idx = if col_count == 0 {
                        0
                    } else {
                        match col_layout.try_col_index_at_level(&col_buf, col_level) {
                            Some(idx) => idx,
                            None => continue,
                        }
                    };

                    accumulate_at(
                        &mut self.aggregates,
                        &row_key_buf,
                        col_idx,
                        &value_buf,
                        value_count,
                        slot_len,
                    );
                }
            }
        }

        // BI pivots: splice engine-evaluated totals over the rolled-up
        // subtotal/grand-total slots. Rolled-up totals are only correct for
        // additive measures; pre-aggregated BI measures (ratios, averages,
        // distinct counts) need per-grain evaluation by the BI engine.
        self.apply_total_overrides(row_field_indices, col_field_indices, value_field_indices, slot_len);
        // And, for a FILTERED state, the overlay evaluated for exactly that
        // state (BUG-0108), over leaf and total slots alike.
        self.apply_mask_overlay(row_field_indices, col_field_indices, value_field_indices, slot_len);

        self.stats.aggregate_groups = self.aggregates.len();
        self.aggregates_dirty = false;
    }

    /// Overwrites aggregate slots with engine-evaluated totals (see
    /// [`TotalOverride`]). No-op when no overrides are installed, when any
    /// record is filtered out (overrides describe the UNFILTERED set — a
    /// filtered state's values come from its own [`MaskOverlay`], or are the
    /// rolled-up totals when it has none), or — per entry — when an
    /// override's key shape doesn't match the current axis layout (stale entry
    /// from an older field configuration).
    ///
    /// A GROUPED level (a virtual field: number bins, a date level, a manual
    /// group) is keyed by the grouping's own ids, while the host keys every
    /// override by the SOURCE column's members (`totals::
    /// overrides_from_grain_result`). An entry naming a member at a grouped
    /// position is therefore a raw id that can equal some bin's id -- it would
    /// overwrite that bin's subtotal with one source value's (wave 1 pivotmask
    /// lane, CONFIRMED by `a_raw_keyed_override_never_lands_on_a_grouped_level`)
    /// -- so it is skipped; an entry padding every grouped position (the grand
    /// total, a total over the other levels) still applies.
    fn apply_total_overrides(
        &mut self,
        row_field_indices: &[FieldIndex],
        col_field_indices: &[FieldIndex],
        value_field_indices: &[FieldIndex],
        slot_len: usize,
    ) {
        let value_count = value_field_indices.len();
        if self.total_overrides.is_empty() {
            return;
        }
        if self.filter_mask.iter().any(|&included| !included) {
            return;
        }
        let base = self.fields.len();
        let grouped_rows: Vec<usize> =
            row_field_indices.iter().enumerate().filter(|(_, &fi)| fi >= base).map(|(j, _)| j).collect();
        let grouped_cols: Vec<usize> =
            col_field_indices.iter().enumerate().filter(|(_, &fi)| fi >= base).map(|(j, _)| j).collect();
        if !grouped_rows.is_empty() || !grouped_cols.is_empty() {
            self.withhold_grouped_totals(row_field_indices.len(), &grouped_rows, &grouped_cols, value_field_indices, value_count);
        }
        let applicable: Vec<TotalOverride> = if grouped_rows.is_empty() && grouped_cols.is_empty() {
            self.total_overrides.clone()
        } else {
            self.total_overrides
                .iter()
                .filter(|ov| {
                    grouped_rows.iter().all(|&j| ov.row_key.get(j).is_none_or(|&id| id == VALUE_ID_EMPTY))
                        && grouped_cols.iter().all(|&j| ov.col_key.get(j).is_none_or(|&id| id == VALUE_ID_EMPTY))
                })
                .cloned()
                .collect()
        };
        splice_overrides(
            &mut self.aggregates,
            &self.col_layout,
            &applicable,
            row_field_indices.len(),
            col_field_indices.len(),
            value_count,
            slot_len,
        );
    }

    /// Empties every subtotal slot below a GROUPED level (see
    /// [`Self::grouped_totals_withheld`]) for the value fields
    /// `mask_sensitivity` marks non-additive, at every row key and column
    /// combination `grain_is_evaluated` refuses. A total ABOVE every grouped
    /// level (the grand total) is the engine's and keeps its override; a
    /// manual group's detail leaf is the main query's own value.
    fn withhold_grouped_totals(
        &mut self,
        row_count: usize,
        grouped_rows: &[usize],
        grouped_cols: &[usize],
        value_field_indices: &[FieldIndex],
        value_count: usize,
    ) {
        let Some(sensitivity) = self.mask_sensitivity.as_ref() else { return };
        let fields: Vec<usize> = (0..value_count)
            .filter(|&vi| {
                value_field_indices.get(vi).is_some_and(|fi| sensitivity.total_fields.contains(fi))
            })
            .collect();
        if fields.is_empty() {
            return;
        }
        let col_count = self.col_layout.cardinalities.len();
        let withheld_cols: Vec<usize> = (0..self.col_layout.total_combinations)
            .filter(|&ci| {
                self.col_layout
                    .col_level(ci)
                    .is_some_and(|level| !grain_is_evaluated(level, col_count, grouped_cols))
            })
            .collect();
        let combos = self.col_layout.total_combinations;
        let mut withheld = false;
        for (key, slot) in self.aggregates.iter_mut() {
            let depth = key.values.iter().take_while(|&&id| id != VALUE_ID_EMPTY).count();
            let row_withheld = !grain_is_evaluated(depth, row_count, grouped_rows);
            for ci in 0..combos {
                if !row_withheld && !withheld_cols.contains(&ci) {
                    continue;
                }
                for &vi in &fields {
                    if let Some(acc) = slot.get_mut(ci * value_count + vi) {
                        if acc.count > 0 {
                            *acc = AggregateAccumulator::new();
                            withheld = true;
                        }
                    }
                }
            }
        }
        self.grouped_totals_withheld |= withheld;
    }

    /// Overwrites aggregate slots with the [`MaskOverlay`] evaluated for
    /// exactly the current filter mask and this field layout, when one is
    /// installed. Spliced AFTER the totals overrides, so an overlay for the
    /// unfiltered state (the host evaluates one when the cache has no totals
    /// of its own) wins over nothing at all.
    fn apply_mask_overlay(
        &mut self,
        row_field_indices: &[FieldIndex],
        col_field_indices: &[FieldIndex],
        value_field_indices: &[FieldIndex],
        slot_len: usize,
    ) {
        let Some(i) = self.mask_overlays.iter().position(|o| {
            o.matches(&self.filter_mask, row_field_indices, col_field_indices, value_field_indices)
        }) else {
            return;
        };
        // An answered grain is the engine's whole answer: blank its cells
        // first, so a cell the answer leaves out reads BLANK, then splice.
        let value_count = value_field_indices.len();
        let row_count = row_field_indices.len();
        for grain in &self.mask_overlays[i].answered {
            let cols: Vec<usize> = (0..self.col_layout.total_combinations)
                .filter(|&ci| self.col_layout.col_level(ci) == Some(grain.col_depth))
                .collect();
            for (key, slot) in self.aggregates.iter_mut() {
                let at_depth = key.values.len() == row_count
                    && key.values.iter().take(grain.row_depth).all(|&id| id != VALUE_ID_EMPTY)
                    && key.values.iter().skip(grain.row_depth).all(|&id| id == VALUE_ID_EMPTY);
                if !at_depth {
                    continue;
                }
                for &ci in &cols {
                    for &vi in grain.value_fields.iter().filter(|&&vi| vi < value_count) {
                        if let Some(acc) = slot.get_mut(ci * value_count + vi) {
                            *acc = AggregateAccumulator::new();
                        }
                    }
                }
            }
        }
        splice_overrides(
            &mut self.aggregates,
            &self.col_layout,
            &self.mask_overlays[i].overrides,
            row_field_indices.len(),
            col_field_indices.len(),
            value_field_indices.len(),
            slot_len,
        );
    }
    
    /// Updates aggregates for a single group key.
    #[allow(dead_code)]
    fn update_aggregates_for_key(
        &mut self,
        key: &GroupKey,
        record: &CacheRecord,
        value_field_indices: &[FieldIndex],
        value_count: usize,
    ) {
        let accumulators = self.aggregates
            .entry(key.clone())
            .or_insert_with(|| vec![AggregateAccumulator::new(); value_count]);
        
        for (acc_idx, &field_idx) in value_field_indices.iter().enumerate() {
            let value_id = record.values.get(field_idx).copied().unwrap_or(VALUE_ID_EMPTY);
            
            if let Some(cache_value) = self.fields.get(field_idx).and_then(|f| f.get_value(value_id)) {
                match cache_value {
                    CacheValue::Number(n) => accumulators[acc_idx].add_number(n.0),
                    CacheValue::Empty => {} // Don't count empty
                    _ => accumulators[acc_idx].add_non_number(),
                }
            }
        }
    }
    
    /// Marks aggregates as needing recomputation.
    pub fn invalidate_aggregates(&mut self) {
        self.aggregates_dirty = true;
    }
    
    /// Returns the record count.
    pub fn record_count(&self) -> usize {
        self.records.len()
    }

    /// True when some record has no value in `field_index` -- the field has a
    /// blank item (`VALUE_ID_EMPTY`), which `get_unique_values_for_filter`
    /// never lists because blanks are not interned. Ignores the filter mask.
    pub fn has_blank_values(&self, field_index: FieldIndex) -> bool {
        self.records
            .iter()
            .any(|r| r.values.get(field_index).copied().unwrap_or(VALUE_ID_EMPTY) == VALUE_ID_EMPTY)
    }
    
    /// Returns the filtered record count.
    pub fn filtered_count(&self) -> usize {
        self.stats.filtered_records
    }
    
    /// Returns the number of fields (columns) in the cache.
    pub fn field_count(&self) -> usize {
        self.fields.len()
    }

    /// Returns the name of a field by index.
    pub fn field_name(&self, field_index: usize) -> Option<String> {
        self.fields.get(field_index).map(|f| f.name.clone())
    }

    /// Returns a display label for a value in a field.
    /// Uses label_map overrides (for date/number grouping) if available,
    /// otherwise formats the raw CacheValue.
    pub fn get_value_label(&self, field_index: usize, value_id: ValueId) -> Option<String> {
        let field = self.get_field(field_index)?;
        // Check label_map first (for grouped fields)
        if let Some(label) = field.label_map.get(&value_id) {
            return Some(label.clone());
        }
        // Fall back to raw value display
        let value = field.get_value(value_id)?;
        Some(match value {
            CacheValue::Empty => String::new(),
            CacheValue::Number(n) => format!("{}", n.0),
            CacheValue::Text(s) => s.clone(),
            CacheValue::Boolean(b) => if *b { "TRUE".to_string() } else { "FALSE".to_string() },
            // "#DIV/0!", as every other label of an error member (BUG-0761).
            CacheValue::Error(e) => format!("#{}", e),
        })
    }

    /// The [`MemberSource`] of `value_id` in `field_index` (base or virtual
    /// field): the sibling of [`PivotCache::get_value_label`], whose own key
    /// spelling is unchanged. `None` for an unknown field.
    pub fn get_value_member_source(&self, field_index: usize, value_id: ValueId) -> Option<MemberSource> {
        Some(self.get_field(field_index)?.member_source(value_id))
    }

}

impl PivotCache {
    /// Checks if a field contains primarily numeric values.
    /// Returns true if more than 50% of non-empty values are numbers.
    pub fn is_numeric_field(&self, field_index: usize) -> bool {
        if let Some(field) = self.fields.get(field_index) {
            let mut numeric_count = 0;
            let mut total_count = 0;

            for id in 0..field.unique_count() as ValueId {
                if let Some(value) = field.get_value(id) {
                    match value {
                        CacheValue::Empty => continue,
                        CacheValue::Number(_) => {
                            numeric_count += 1;
                            total_count += 1;
                        }
                        _ => total_count += 1,
                    }
                }
            }

            if total_count == 0 {
                return false;
            }

            (numeric_count as f64 / total_count as f64) > 0.5
        } else {
            false
        }
    }

    /// Clears all virtual fields and records (called before re-building grouping transforms).
    pub fn clear_virtual_fields(&mut self) {
        self.virtual_fields.clear();
        self.virtual_records.clear();
        self.virtual_origins.clear();
        self.virtual_levels.clear();
    }

    /// The grouping level (`virtual_levels`) the field at EFFECTIVE index
    /// `field_index` is, when it is a grouped field of its own.
    pub fn virtual_field_level(&self, field_index: FieldIndex) -> Option<&str> {
        let vi = field_index.checked_sub(self.fields.len())?;
        self.virtual_levels.get(vi)?.as_deref()
    }

    /// Marks virtual field `vf_index` as grouping level `level`.
    pub fn set_virtual_level(&mut self, vf_index: usize, level: &str) {
        if let Some(slot) = self.virtual_levels.get_mut(vf_index) {
            *slot = Some(level.to_string());
        }
    }

    /// The base field the field at EFFECTIVE index `field_index` belongs to:
    /// itself for a base field, the field a grouping made it from for a
    /// virtual one (a date level, a number bin, a manual group). `None` for
    /// an index no field has.
    pub fn virtual_field_origin(&self, field_index: FieldIndex) -> Option<FieldIndex> {
        if field_index < self.fields.len() {
            return Some(field_index);
        }
        self.virtual_origins.get(field_index - self.fields.len()).copied()
    }

    /// Adds a virtual field made from base field `origin` and returns its
    /// "virtual index" (0-based within virtual_fields).
    /// The effective field index for lookups is `self.fields.len() + virtual_index`.
    pub fn add_virtual_field(&mut self, name: String, origin: FieldIndex) -> usize {
        let vf_index = self.virtual_fields.len();
        let source_index = self.fields.len() + vf_index;
        self.virtual_fields.push(FieldCache::new(source_index, name));
        self.virtual_origins.push(origin);
        self.virtual_levels.push(None);
        // Pre-allocate record mapping for this virtual field
        self.virtual_records.push(vec![VALUE_ID_EMPTY; self.records.len()]);
        vf_index
    }

    /// Sets the virtual field value for a specific record.
    pub fn set_virtual_record_value(&mut self, vf_index: usize, record_index: usize, value: CacheValue) {
        if vf_index < self.virtual_fields.len() && record_index < self.records.len() {
            let value_id = self.virtual_fields[vf_index].intern(value);
            self.virtual_records[vf_index][record_index] = value_id;
        }
    }

    /// Gets a field by effective index (source fields first, then virtual fields).
    pub fn get_field(&self, effective_index: usize) -> Option<&FieldCache> {
        if effective_index < self.fields.len() {
            self.fields.get(effective_index)
        } else {
            let vi = effective_index - self.fields.len();
            self.virtual_fields.get(vi)
        }
    }

    /// Gets a field by effective index (mutable).
    pub fn get_field_mut(&mut self, effective_index: usize) -> Option<&mut FieldCache> {
        let base_len = self.fields.len();
        if effective_index < base_len {
            self.fields.get_mut(effective_index)
        } else {
            let vi = effective_index - base_len;
            self.virtual_fields.get_mut(vi)
        }
    }

    /// Gets the ValueId for a record at an effective field index (source or virtual).
    pub fn get_record_value_id(&self, record_index: usize, effective_field_index: usize) -> ValueId {
        if effective_field_index < self.fields.len() {
            self.records.get(record_index)
                .and_then(|r| r.values.get(effective_field_index))
                .copied()
                .unwrap_or(VALUE_ID_EMPTY)
        } else {
            let vi = effective_field_index - self.fields.len();
            self.virtual_records.get(vi)
                .and_then(|vr| vr.get(record_index))
                .copied()
                .unwrap_or(VALUE_ID_EMPTY)
        }
    }
}

// ============================================================================
// DATE PARSING HELPERS
// ============================================================================

/// Parsed date components for date grouping.
#[derive(Debug, Clone, Copy)]
pub struct ParsedDate {
    pub year: i32,
    pub month: u32,
    pub day: u32,
}

impl ParsedDate {
    /// Returns the quarter (1-4) based on the month.
    pub fn quarter(&self) -> u32 {
        (self.month - 1) / 3 + 1
    }

    /// Returns the ISO week number (approximate, 1-53).
    pub fn week(&self) -> u32 {
        // Simple day-of-year based ISO week approximation
        let doy = self.day_of_year();
        ((doy + 6) / 7).min(53).max(1)
    }

    /// Returns the approximate day of year (1-366).
    fn day_of_year(&self) -> u32 {
        let days_before_month = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
        let m = (self.month as usize).min(12).max(1) - 1;
        let mut doy = days_before_month[m] + self.day;
        // Leap year adjustment for months after February
        if self.month > 2 && is_leap_year(self.year) {
            doy += 1;
        }
        doy
    }
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

/// Attempts to parse a CacheValue as a date.
/// Supports:
/// - Number: Excel serial date (days since 1899-12-30)
/// - Text: ISO 8601 "YYYY-MM-DD", "YYYY/MM/DD", "MM/DD/YYYY", "DD.MM.YYYY"
pub fn parse_cache_value_as_date(value: &CacheValue) -> Option<ParsedDate> {
    match value {
        CacheValue::Number(n) => excel_serial_to_date(n.as_f64()),
        CacheValue::Text(s) => parse_date_string(s),
        _ => None,
    }
}

/// Converts an Excel serial date number to (year, month, day), through THE
/// engine's conversion (`engine::date_serial`, Lotus 1900 leap-year quirk
/// included). This used to run its own arithmetic -- a Julian-day algorithm fed
/// a days-since-0001-01-01 count -- and put a typed 2026-01-10 (serial 46032)
/// in year -2688: a timeline over typed dates listed nonsense periods (found
/// live 2026-09-29, e2e fixall-pivot TL-NUM).
fn excel_serial_to_date(serial: f64) -> Option<ParsedDate> {
    let serial = serial.floor() as i64;
    if serial < 1 || serial > 2958465 {
        return None; // Out of range
    }
    let (year, month, day) = engine::date_serial::serial_to_date(serial);
    Some(ParsedDate { year, month, day })
}

/// Parses a date string in common formats.
fn parse_date_string(s: &str) -> Option<ParsedDate> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }

    // Try ISO 8601: YYYY-MM-DD or YYYY/MM/DD
    if s.len() >= 10 {
        let sep = s.as_bytes()[4];
        if sep == b'-' || sep == b'/' {
            let parts: Vec<&str> = if sep == b'-' { s.split('-').collect() } else { s.split('/').collect() };
            if parts.len() >= 3 {
                if let (Ok(y), Ok(m), Ok(d)) = (
                    parts[0].parse::<i32>(),
                    parts[1].parse::<u32>(),
                    parts[2].get(..2).unwrap_or(parts[2]).parse::<u32>(),
                ) {
                    if m >= 1 && m <= 12 && d >= 1 && d <= 31 {
                        return Some(ParsedDate { year: y, month: m, day: d });
                    }
                }
            }
        }
    }

    // Try MM/DD/YYYY
    if let Some(result) = try_parse_mdy(s, '/') {
        return Some(result);
    }

    // Try DD.MM.YYYY
    if let Some(result) = try_parse_dmy(s, '.') {
        return Some(result);
    }

    None
}

fn try_parse_mdy(s: &str, sep: char) -> Option<ParsedDate> {
    let parts: Vec<&str> = s.split(sep).collect();
    if parts.len() >= 3 {
        if let (Ok(m), Ok(d), Ok(y)) = (
            parts[0].parse::<u32>(),
            parts[1].parse::<u32>(),
            parts[2].parse::<i32>(),
        ) {
            if m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 {
                return Some(ParsedDate { year: y, month: m, day: d });
            }
        }
    }
    None
}

fn try_parse_dmy(s: &str, sep: char) -> Option<ParsedDate> {
    let parts: Vec<&str> = s.split(sep).collect();
    if parts.len() >= 3 {
        if let (Ok(d), Ok(m), Ok(y)) = (
            parts[0].parse::<u32>(),
            parts[1].parse::<u32>(),
            parts[2].parse::<i32>(),
        ) {
            if m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 {
                return Some(ParsedDate { year: y, month: m, day: d });
            }
        }
    }
    None
}

#[cfg(test)]
mod date_serial_tests {
    use super::*;

    fn ymd(serial: f64) -> Option<(i32, u32, u32)> {
        parse_cache_value_as_date(&CacheValue::Number(OrderedFloat(serial))).map(|d| (d.year, d.month, d.day))
    }

    /// Found live 2026-09-29 (e2e fixall-pivot TL-NUM): a typed 2026-01-10 is
    /// the number 46032, and the cache read it as year -2688.
    #[test]
    fn a_date_serial_reads_as_the_date_excel_shows() {
        assert_eq!(ymd(46032.0), Some((2026, 1, 10)));
        assert_eq!(ymd(46084.0), Some((2026, 3, 3)));
        assert_eq!(ymd(1.0), Some((1900, 1, 1)));
        // Past the Lotus 1900 leap day: serial 61 is 1 March 1900.
        assert_eq!(ymd(61.0), Some((1900, 3, 1)));
        assert_eq!(ymd(45292.5), Some((2024, 1, 1)), "a time of day does not move the date");
        assert_eq!(ymd(0.0), None);
    }
}

#[cfg(test)]
mod total_override_tests {
    use super::*;
    use crate::definition::{
        AggregationType, PivotDefinition, PivotField, PivotId, ValueField,
    };
    use crate::engine::calculate_pivot;
    use crate::view::{PivotCellValue, PivotRowType, PivotView};
    use engine::CellValue;

    fn test_pivot_id() -> PivotId {
        PivotId::from_bytes([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2])
    }

    /// A BI-style cache: one PRE-AGGREGATED row per group with a summable
    /// measure (Revenue) and a non-additive ratio measure (Pct). The pct
    /// values are chosen so their float roll-up (0.1 + 0.2) differs from the
    /// exact engine-evaluated total (0.3).
    fn bi_style_cache() -> PivotCache {
        let mut cache = PivotCache::new(test_pivot_id(), 3);
        cache.set_field_name(0, "Region".to_string());
        cache.set_field_name(1, "Revenue".to_string());
        cache.set_field_name(2, "Pct".to_string());
        cache.add_record(0, &[
            CellValue::Text("North".to_string()),
            CellValue::Number(100.0),
            CellValue::Number(0.1),
        ]);
        cache.add_record(1, &[
            CellValue::Text("South".to_string()),
            CellValue::Number(200.0),
            CellValue::Number(0.2),
        ]);
        cache
    }

    fn bi_style_definition() -> PivotDefinition {
        let mut def = PivotDefinition::new(test_pivot_id(), (0, 0), (2, 2));
        def.row_fields.push(PivotField::new(0, "Region".to_string()));
        def.value_fields.push(ValueField::new(1, "[Revenue]".to_string(), AggregationType::Sum));
        def.value_fields.push(ValueField::new(2, "[Pct]".to_string(), AggregationType::Sum));
        def
    }

    /// Finds the numeric value of the data cell for `value_field_index` in the
    /// grand-total row of the view.
    fn grand_total_value(view: &PivotView, value_field_index: usize) -> Option<f64> {
        let gt_row = view
            .rows
            .iter()
            .position(|r| matches!(r.row_type, PivotRowType::GrandTotal))?;
        view.cells[gt_row].iter().find_map(|c| {
            if c.value_field_index == Some(value_field_index) {
                match c.value {
                    PivotCellValue::Number(n) => Some(n),
                    _ => None,
                }
            } else {
                None
            }
        })
    }

    #[test]
    fn grand_total_uses_engine_override() {
        let mut cache = bi_style_cache();
        let definition = bi_style_definition();

        // Without overrides the grand total is the float roll-up of the
        // pre-aggregated rows: 0.1 + 0.2 != 0.3 exactly.
        let view = calculate_pivot(&definition, &mut cache);
        let rolled_up = grand_total_value(&view, 1).expect("pct grand total cell");
        assert_eq!(rolled_up, 0.1 + 0.2);
        assert_ne!(rolled_up, 0.3);

        // Install the engine-evaluated total for the grand-total grain.
        // `None` for Revenue keeps its rolled-up value.
        cache.set_total_overrides(vec![TotalOverride {
            row_key: vec![VALUE_ID_EMPTY],
            col_key: vec![],
            values: vec![None, Some(0.3)],
        }]);
        let view = calculate_pivot(&definition, &mut cache);
        assert_eq!(grand_total_value(&view, 1), Some(0.3));
        assert_eq!(grand_total_value(&view, 0), Some(300.0));

        // Leaf rows are untouched.
        let north_row = view
            .rows
            .iter()
            .position(|r| matches!(r.row_type, PivotRowType::Data))
            .expect("data row");
        let north_pct = view.cells[north_row]
            .iter()
            .find_map(|c| {
                if c.value_field_index == Some(1) {
                    match c.value {
                        PivotCellValue::Number(n) => Some(n),
                        _ => None,
                    }
                } else {
                    None
                }
            })
            .expect("north pct cell");
        assert_eq!(north_pct, 0.1);
    }

    #[test]
    fn subtotal_level_override_with_two_row_fields() {
        let mut cache = PivotCache::new(test_pivot_id(), 3);
        cache.set_field_name(0, "Region".to_string());
        cache.set_field_name(1, "City".to_string());
        cache.set_field_name(2, "Pct".to_string());
        cache.add_record(0, &[
            CellValue::Text("A".to_string()),
            CellValue::Text("X".to_string()),
            CellValue::Number(0.1),
        ]);
        cache.add_record(1, &[
            CellValue::Text("A".to_string()),
            CellValue::Text("Y".to_string()),
            CellValue::Number(0.2),
        ]);
        cache.add_record(2, &[
            CellValue::Text("B".to_string()),
            CellValue::Text("Z".to_string()),
            CellValue::Number(0.4),
        ]);

        let id_a = cache
            .find_value_id(0, &CacheValue::from(&CellValue::Text("A".to_string())))
            .expect("id for A");

        cache.set_total_overrides(vec![
            TotalOverride {
                row_key: vec![id_a, VALUE_ID_EMPTY],
                col_key: vec![],
                values: vec![Some(0.3)],
            },
            TotalOverride {
                row_key: vec![VALUE_ID_EMPTY, VALUE_ID_EMPTY],
                col_key: vec![],
                values: vec![Some(0.7)],
            },
        ]);

        let row_fields = [0usize, 1usize];
        let value_fields = [2usize];

        // Subtotal (A, *) gets the engine value, not 0.1 + 0.2.
        let sub = cache
            .get_aggregate(
                &GroupKey::new(vec![id_a, VALUE_ID_EMPTY]),
                &row_fields,
                &[],
                &value_fields,
            )
            .expect("subtotal slot")[0]
            .compute(AggregationType::Sum);
        assert_eq!(sub, 0.3);

        // Grand total gets the engine value, not 0.1 + 0.2 + 0.4.
        let gt = cache
            .get_aggregate(
                &GroupKey::grand_total(2),
                &row_fields,
                &[],
                &value_fields,
            )
            .expect("grand total slot")[0]
            .compute(AggregationType::Sum);
        assert_eq!(gt, 0.7);

        // Leaf (A, X) keeps its own value.
        let id_x = cache
            .find_value_id(1, &CacheValue::from(&CellValue::Text("X".to_string())))
            .expect("id for X");
        let leaf = cache
            .get_aggregate(
                &GroupKey::new(vec![id_a, id_x]),
                &row_fields,
                &[],
                &value_fields,
            )
            .expect("leaf slot")[0]
            .compute(AggregationType::Sum);
        assert_eq!(leaf, 0.1);
    }

    #[test]
    fn overrides_skipped_while_filtered_and_reapplied_after() {
        let mut cache = bi_style_cache();
        cache.set_total_overrides(vec![TotalOverride {
            row_key: vec![VALUE_ID_EMPTY],
            col_key: vec![],
            values: vec![None, Some(0.3)],
        }]);

        let id_south = cache
            .find_value_id(0, &CacheValue::from(&CellValue::Text("South".to_string())))
            .expect("id for South");

        let row_fields = [0usize];
        let value_fields = [1usize, 2usize];

        // With a local filter active, overrides describe a different (wider)
        // record set — the grand total must stay the roll-up of VISIBLE rows.
        cache.apply_filters(&[(0, vec![id_south])]);
        let gt_pct = cache
            .get_aggregate(&GroupKey::grand_total(1), &row_fields, &[], &value_fields)
            .expect("grand total slot")[1]
            .compute(AggregationType::Sum);
        assert_eq!(gt_pct, 0.1);

        // Clearing the filter restores the unfiltered set the overrides were
        // computed for, so they apply again.
        cache.apply_filters(&[]);
        let gt_pct = cache
            .get_aggregate(&GroupKey::grand_total(1), &row_fields, &[], &value_fields)
            .expect("grand total slot")[1]
            .compute(AggregationType::Sum);
        assert_eq!(gt_pct, 0.3);
    }

    #[test]
    fn stale_override_key_shapes_are_ignored() {
        let mut cache = bi_style_cache();
        // Key shaped for a two-row-field layout, but the pivot has one row
        // field — the entry must be skipped, leaving the roll-up in place.
        cache.set_total_overrides(vec![TotalOverride {
            row_key: vec![VALUE_ID_EMPTY, VALUE_ID_EMPTY],
            col_key: vec![],
            values: vec![None, Some(99.0)],
        }]);

        let row_fields = [0usize];
        let value_fields = [1usize, 2usize];
        let gt_pct = cache
            .get_aggregate(&GroupKey::grand_total(1), &row_fields, &[], &value_fields)
            .expect("grand total slot")[1]
            .compute(AggregationType::Sum);
        assert_eq!(gt_pct, 0.1 + 0.2);
    }

    // ---- BUG-0108: the mask overlay ----------------------------------------

    /// W1 pivotmask verifier: an overlay could never BLANK a cell. The engine
    /// leaves out a row whose measures are all BLANK, and an override carries
    /// only a number, so such a cell kept its masked roll-up. A grain the
    /// overlay records as ANSWERED reads BLANK wherever its answer is silent;
    /// a grain it does not record (refused) keeps the roll-up.
    ///
    /// SABOTAGE (piv4-sabB): `apply_mask_overlay` skips the answered grains.
    #[test]
    fn an_overlay_blanks_what_the_engine_answers_blank() {
        let mut cache = bi_style_cache();
        let definition = bi_style_definition();
        let mut overlay = north_only_overlay(&mut cache, &definition);
        // The engine answered the leaf grain for value field 1 with nothing
        // for North (its measure is BLANK there), and the grand total.
        overlay.overrides.retain(|ov| ov.row_key == vec![VALUE_ID_EMPTY]);
        overlay.answered = vec![
            AnsweredGrain { row_depth: 1, col_depth: 0, value_fields: vec![1] },
            AnsweredGrain { row_depth: 0, col_depth: 0, value_fields: vec![1] },
        ];
        cache.install_mask_overlay(overlay);
        let view = calculate_pivot(&south_hidden(&definition), &mut cache);
        assert_eq!(cell_value(&view, Some("North"), 1), None, "North's value 1 is the engine's BLANK");
        assert_eq!(cell_value(&view, None, 1), Some(1.0), "the grand total is the engine's answer");
        // Value field 0 was not answered at any grain: its roll-up stands.
        assert!(cell_value(&view, Some("North"), 0).is_some(), "an unanswered value field keeps its roll-up");
    }

    /// The numeric value of the cell for `value_field_index` on the row whose
    /// label is `label` (a data row) or on the grand-total row (`None`).
    fn cell_value(view: &PivotView, label: Option<&str>, value_field_index: usize) -> Option<f64> {
        let row = match label {
            Some(label) => view.cells.iter().position(|cells| {
                cells.first().is_some_and(|c| c.formatted_value == label)
            })?,
            None => view.rows.iter().position(|r| matches!(r.row_type, PivotRowType::GrandTotal))?,
        };
        view.cells[row].iter().find_map(|c| match (c.value_field_index, &c.value) {
            (Some(i), PivotCellValue::Number(n)) if i == value_field_index => Some(*n),
            _ => None,
        })
    }

    /// `definition` with South hidden on the Region row field.
    fn south_hidden(definition: &PivotDefinition) -> PivotDefinition {
        let mut def = definition.clone();
        def.row_fields[0].hidden_items = vec!["South".to_string()];
        def
    }

    /// The overlay a host would evaluate for "South hidden": North is the only
    /// visible region, so its share of the visible total -- and that total --
    /// is exactly 1. Revenue is additive and left to the roll-up (`None`).
    fn north_only_overlay(cache: &mut PivotCache, definition: &PivotDefinition) -> MaskOverlay {
        let masked = south_hidden(definition);
        crate::engine::apply_definition_filters(&masked, cache);
        assert_eq!(cache.filter_mask, vec![true, false], "fixture: South is masked");
        let id_north = cache
            .find_value_id(0, &CacheValue::from(&CellValue::Text("North".to_string())))
            .expect("id for North");
        MaskOverlay {
            mask: pack_filter_mask(&cache.filter_mask),
            record_count: cache.records.len(),
            row_fields: vec![0],
            col_fields: vec![],
            value_fields: vec![1, 2],
            overrides: vec![
                TotalOverride { row_key: vec![id_north], col_key: vec![], values: vec![None, Some(1.0)] },
                TotalOverride { row_key: vec![VALUE_ID_EMPTY], col_key: vec![], values: vec![None, Some(1.0)] },
            ],
            answered: vec![],
        }
    }

    /// THE MECHANISM. An overlay replaces the masked LEAF value and the total
    /// for exactly the state it was evaluated for; the same records under any
    /// other mask -- here, unfiltered -- render the plain roll-up, and the
    /// overlay applies again the moment the mask comes back (an undo and redo,
    /// a slicer clicked back and forth). Revenue's `None` keeps its roll-up.
    #[test]
    fn a_mask_overlay_applies_to_its_own_mask_only_and_again_when_it_returns() {
        let mut cache = bi_style_cache();
        let definition = bi_style_definition();
        let overlay = north_only_overlay(&mut cache, &definition);
        cache.install_mask_overlay(overlay);
        let masked = south_hidden(&definition);

        let view = calculate_pivot(&masked, &mut cache);
        assert_eq!(cell_value(&view, Some("North"), 1), Some(1.0), "the masked leaf takes the overlay");
        assert_eq!(cell_value(&view, None, 1), Some(1.0), "and so does the total");
        assert_eq!(cell_value(&view, Some("North"), 0), Some(100.0), "an additive column keeps its roll-up");
        assert_eq!(cell_value(&view, None, 0), Some(100.0));

        let view = calculate_pivot(&definition, &mut cache);
        assert_eq!(cell_value(&view, Some("North"), 1), Some(0.1), "unfiltered: the record's own value");
        assert_eq!(cell_value(&view, None, 1), Some(0.1 + 0.2), "unfiltered: the roll-up, not the overlay");

        let view = calculate_pivot(&masked, &mut cache);
        assert_eq!(cell_value(&view, Some("North"), 1), Some(1.0), "the mask came back, and so did its overlay");
        assert_eq!(cell_value(&view, None, 1), Some(1.0));
    }

    /// An overlay is keyed by its mask AND its field layout: one evaluated for
    /// another mask, or with the value fields in another order (its values are
    /// parallel to them), is never laid over this view.
    #[test]
    fn an_overlay_for_another_mask_or_another_layout_never_applies() {
        let mut cache = bi_style_cache();
        let definition = bi_style_definition();
        let masked = south_hidden(&definition);

        let mut swapped = north_only_overlay(&mut cache, &definition);
        swapped.value_fields = vec![2, 1];
        cache.install_mask_overlay(swapped);
        let view = calculate_pivot(&masked, &mut cache);
        assert_eq!(cell_value(&view, Some("North"), 1), Some(0.1), "another value layout: not applied");

        let mut other_mask = north_only_overlay(&mut cache, &definition);
        other_mask.mask = pack_filter_mask(&[false, true]);
        cache.mask_overlays.clear();
        cache.install_mask_overlay(other_mask);
        let view = calculate_pivot(&masked, &mut cache);
        assert_eq!(cell_value(&view, Some("North"), 1), Some(0.1), "another mask: not applied");
        assert_eq!(cell_value(&view, None, 1), Some(0.1), "the masked roll-up stands");
    }

    /// The overlays describe THESE records, so a JSON undo snapshot of the
    /// cache keeps them (and the sensitivity and identity beside them);
    /// re-installing a state replaces its entry; the list keeps the newest
    /// `MAX_MASK_OVERLAYS`.
    #[test]
    fn overlays_survive_the_undo_snapshot_and_the_list_keeps_the_newest() {
        let mut cache = bi_style_cache();
        let definition = bi_style_definition();
        let overlay = north_only_overlay(&mut cache, &definition);
        cache.install_mask_overlay(overlay.clone());
        cache.mask_sensitivity = Some(MaskSensitivity { total_fields: vec![2], leaf_fields: vec![2] });

        let back: PivotCache = serde_json::from_slice(&serde_json::to_vec(&cache).unwrap()).unwrap();
        assert_eq!(back.mask_overlays, vec![overlay.clone()], "the snapshot keeps the overlay");
        assert_eq!(back.mask_sensitivity, cache.mask_sensitivity, "and the sensitivity");
        assert_eq!(back.build_id, cache.build_id, "and the records' identity");

        cache.install_mask_overlay(overlay.clone());
        assert_eq!(cache.mask_overlays.len(), 1, "the same state replaces its entry");

        for n in 0..(MAX_MASK_OVERLAYS + 3) {
            let mut o = overlay.clone();
            o.mask = vec![n as u64 + 7];
            cache.install_mask_overlay(o);
        }
        assert_eq!(cache.mask_overlays.len(), MAX_MASK_OVERLAYS, "capped");
        assert_eq!(cache.mask_overlays[0].mask, vec![(MAX_MASK_OVERLAYS + 2) as u64 + 7], "newest first");
    }

    /// Every cache names its own records; a clone shares the name (same
    /// records), a new build never does.
    #[test]
    fn every_new_cache_has_its_own_build_id_and_a_clone_keeps_it() {
        let a = bi_style_cache();
        let b = bi_style_cache();
        assert_ne!(a.build_id, 0, "0 names no records");
        assert_ne!(a.build_id, b.build_id, "two builds, two identities");
        assert_eq!(a.clone().build_id, a.build_id);
    }

    /// The packed mask is exact, beyond one 64-record word too.
    #[test]
    fn a_packed_mask_matches_only_its_own_mask() {
        let mask: Vec<bool> = (0..130).map(|i| i % 3 != 0).collect();
        let bits = pack_filter_mask(&mask);
        assert_eq!(bits.len(), 3);
        assert!(mask_bits_equal(&bits, &mask));
        let mut flipped = mask.clone();
        flipped[129] = !flipped[129];
        assert!(!mask_bits_equal(&bits, &flipped), "the last record's bit counts");
        // The record count is the overlay's own check.
        let overlay = MaskOverlay {
            mask: bits,
            record_count: mask.len(),
            row_fields: vec![0],
            col_fields: vec![],
            value_fields: vec![1],
            overrides: vec![],
            answered: vec![],
        };
        assert!(overlay.matches(&mask, &[0], &[], &[1]));
        assert!(!overlay.matches(&mask[..129], &[0], &[], &[1]), "and so does the length");
        assert!(!overlay.matches(&mask, &[0], &[], &[2]), "and the layout");
    }

    /// Wave 1 pivotmask lane, verified here: a BI pivot's engine totals are
    /// keyed by the SOURCE column's members, but a number-binned row field is
    /// aggregated under its BINS' ids. Size (1, 2, 11) binned 1-10 / 11-20 by
    /// Region: the override for Size = 2's subtotal (raw id 1) has the same
    /// key shape as the 11-20 bin's subtotal (bin id 1) and overwrote it with
    /// 999. A raw-keyed entry never lands on a grouped level; the grand total,
    /// which pads it, still applies.
    ///
    /// SABOTAGE (pivotfix-sabL): no grouped-position filter -- fails at
    /// "BIN SUBTOTAL" with 999.
    #[test]
    fn a_raw_keyed_override_never_lands_on_a_grouped_level() {
        let mut cache = PivotCache::new(test_pivot_id(), 3);
        cache.set_field_name(0, "Size".to_string());
        cache.set_field_name(1, "Region".to_string());
        cache.set_field_name(2, "Amount".to_string());
        for (i, (size, region, amount)) in
            [(1.0, "East", 10.0), (2.0, "West", 20.0), (11.0, "East", 100.0)].iter().enumerate()
        {
            cache.add_record(
                i as u32,
                &[CellValue::Number(*size), CellValue::Text(region.to_string()), CellValue::Number(*amount)],
            );
        }
        let raw_size_two = cache
            .find_value_id(0, &CacheValue::Number(OrderedFloat(2.0)))
            .expect("fixture: Size 2's raw id");
        let mut def = PivotDefinition::new(test_pivot_id(), (0, 0), (3, 2));
        let mut size = PivotField::new(0, "Size".to_string());
        size.grouping = crate::definition::FieldGrouping::NumberBinning { start: 1.0, end: 20.0, interval: 10.0 };
        def.row_fields.push(size);
        def.row_fields.push(PivotField::new(1, "Region".to_string()));
        def.value_fields.push(ValueField::new(2, "[Amount]".to_string(), AggregationType::Sum));
        cache.set_total_overrides(vec![
            TotalOverride { row_key: vec![raw_size_two, VALUE_ID_EMPTY], col_key: vec![], values: vec![Some(999.0)] },
            TotalOverride { row_key: vec![VALUE_ID_EMPTY, VALUE_ID_EMPTY], col_key: vec![], values: vec![Some(130.0)] },
        ]);
        let view = calculate_pivot(&def, &mut cache);
        let numbers: Vec<f64> = view
            .cells
            .iter()
            .flatten()
            .filter(|c| c.value_field_index == Some(0))
            .filter_map(|c| match c.value {
                PivotCellValue::Number(n) => Some(n),
                _ => None,
            })
            .collect();
        assert!(!numbers.contains(&999.0), "BIN SUBTOTAL: a source member's total landed on a bin: {numbers:?}");
        assert!(numbers.contains(&100.0), "the 11-20 bin's own subtotal: {numbers:?}");
        assert_eq!(grand_total_value(&view, 0), Some(130.0), "the padded grand total still applies");
    }

    /// Wave 3 verifier: with the raw-keyed override skipped, a grouped
    /// level's subtotal of a NON-ADDITIVE measure (an average) was the
    /// rolled-up SUM of its items -- a wrong number, with no notice. Nothing
    /// evaluates a group made in the PivotTable, so that subtotal is now left
    /// EMPTY and the cache says so (`grouped_totals_withheld`, which the host
    /// turns into a notice); a manual group's detail leaves (the main query's
    /// own values) and the engine's grand total stand, and an additive
    /// measure keeps its exact roll-up.
    ///
    /// SABOTAGE (piv4-sabW): `withhold_grouped_totals` returns at once.
    #[test]
    fn a_grouped_levels_non_additive_subtotal_is_withheld_not_summed() {
        let build = |sensitive: bool| {
            let mut cache = PivotCache::new(test_pivot_id(), 2);
            cache.set_field_name(0, "Region".to_string());
            cache.set_field_name(1, "Avg".to_string());
            for (i, (region, avg)) in [("A", 10.0), ("B", 20.0), ("C", 5.0)].iter().enumerate() {
                cache.add_record(i as u32, &[CellValue::Text(region.to_string()), CellValue::Number(*avg)]);
            }
            if sensitive {
                cache.mask_sensitivity = Some(MaskSensitivity { total_fields: vec![1], leaf_fields: vec![] });
            }
            let mut def = PivotDefinition::new(test_pivot_id(), (0, 0), (3, 1));
            let mut region = PivotField::new(0, "Region".to_string());
            region.grouping = crate::definition::FieldGrouping::ManualGrouping {
                groups: vec![crate::definition::ManualGroup { name: "G".into(), members: vec!["A".into(), "B".into()] }],
                ungrouped_name: "Other".into(),
            };
            def.row_fields.push(region);
            def.value_fields.push(ValueField::new(1, "[Avg]".to_string(), AggregationType::Sum));
            cache.set_total_overrides(vec![TotalOverride {
                row_key: vec![VALUE_ID_EMPTY, VALUE_ID_EMPTY],
                col_key: vec![],
                values: vec![Some(11.0)],
            }]);
            let view = calculate_pivot(&def, &mut cache);
            let numbers: Vec<f64> = view
                .cells
                .iter()
                .flatten()
                .filter(|c| c.value_field_index == Some(0))
                .filter_map(|c| match c.value {
                    PivotCellValue::Number(n) => Some(n),
                    _ => None,
                })
                .collect();
            (numbers, cache.grouped_totals_withheld(), grand_total_value(&view, 0))
        };
        let (numbers, withheld, gt) = build(true);
        assert!(withheld, "the cache reports the withheld subtotals");
        assert!(!numbers.contains(&30.0), "GROUP SUBTOTAL: G's subtotal is not the sum 10 + 20: {numbers:?}");
        assert!(numbers.contains(&10.0) && numbers.contains(&20.0), "the group's items stand: {numbers:?}");
        assert_eq!(gt, Some(11.0), "the engine's grand total stands");
        let (numbers, withheld, _) = build(false);
        assert!(!withheld && numbers.contains(&30.0), "an additive measure keeps its roll-up: {numbers:?}");
    }
}
#[cfg(test)]
mod model_key_tests {
    use super::*;
    use crate::definition::PivotId;

    fn pid() -> PivotId {
        PivotId::from_bytes([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3])
    }

    /// The host restores a BI pivot's records from a JSON undo snapshot
    /// (`encode_pivot_definition_snapshot`). A column's "Table.Column" identity
    /// must come back with them: without it, a redo hands the host two columns
    /// called "name" and no way to tell whose they are.
    #[test]
    fn a_columns_model_key_survives_the_json_undo_snapshot() {
        let mut cache = PivotCache::new(pid(), 2);
        cache.set_field_name(0, "name".to_string());
        cache.set_field_name(1, "name".to_string());
        cache.fields[0].model_key = Some("Customers.name".to_string());
        cache.fields[1].model_key = Some("Products.name".to_string());
        cache.add_record(0, &[
            engine::CellValue::Text("Acme".to_string()),
            engine::CellValue::Text("Widget".to_string()),
        ]);

        let bytes = serde_json::to_vec(&cache).expect("serialize");
        let back: PivotCache = serde_json::from_slice(&bytes).expect("deserialize");
        assert_eq!(back.fields[0].model_key.as_deref(), Some("Customers.name"));
        assert_eq!(back.fields[1].model_key.as_deref(), Some("Products.name"));
        assert_eq!(back.fields[0].name, "name");
    }

    /// A grid-sourced cache has no key and serializes exactly as before, and a
    /// snapshot written before the key existed still reads (as `None`).
    #[test]
    fn a_cache_without_model_keys_serializes_no_key_and_old_snapshots_read() {
        let mut cache = PivotCache::new(pid(), 1);
        cache.set_field_name(0, "Region".to_string());
        let json = serde_json::to_string(&cache).expect("serialize");
        assert!(!json.contains("model_key"), "an absent key must not be written: {json}");
        let back: PivotCache = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.fields[0].model_key, None);
    }
}

#[cfg(test)]
mod error_member_tests {
    use super::*;

    /// BUG-0761: a source error member is named as Excel names it -- the
    /// item label, the member key and the filter list all read "#DIV/0!" /
    /// "#N/A" -- never the Rust variant name ("#Div0", "#NA").
    #[test]
    fn a_source_error_member_reads_as_its_excel_literal() {
        let mut cache = PivotCache::new(identity::EntityId::ZERO, 1);
        cache.add_record(0, &[CellValue::Error(engine::CellError::Div0)]);
        cache.add_record(1, &[CellValue::Error(engine::CellError::NA)]);
        cache.add_record(2, &[CellValue::Error(engine::CellError::Name)]);
        let listed = cache.get_unique_values_for_filter(0);
        let labels: Vec<&str> = listed.iter().map(|(_, l)| l.as_str()).collect();
        for want in ["#DIV/0!", "#N/A", "#NAME?"] {
            assert!(labels.contains(&want), "the filter list names {want}: {labels:?}");
        }
        for (id, label) in &listed {
            assert_eq!(cache.get_value_label(0, *id).as_deref(), Some(label.as_str()), "the item label");
            assert_eq!(&cache.get_field(0).unwrap().member_key(*id), label, "the member key");
        }
    }
}
