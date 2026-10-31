//! FILENAME: core/engine/src/cube.rs
//! PURPOSE: Engine-side types + helpers for the CUBE formula family
//! (CUBEVALUE, CUBEMEMBER, CUBESET, CUBESETCOUNT, CUBERANKEDMEMBER,
//!  CUBEMEMBERPROPERTY, CUBEKPIMEMBER) that query a Calcula BI model.
//!
//! CONTEXT: The formula evaluator is synchronous but CUBE functions need async
//! BI-model queries. Following the GETPIVOTDATA / UDF pre-fetch pattern, an async
//! pass in the app layer (app/src-tauri/src/bi/cube.rs) resolves every cube call
//! BEFORE the synchronous recalc and hands the evaluator a `CubePrefetch`.
//!
//! This module is PURE: it knows nothing about BI connections or queries — only
//! the resolved data the evaluator serves, and the SHARED syntactic helpers that
//! keep the pre-pass and the evaluator in exact agreement on call keys. Because
//! both sides compute lookup keys through `cube_call_key` here, the evaluator's
//! job reduces to "resolve key, look up pre-fetched result" — all intelligence
//! lives in the async pre-pass.
//!
//! ## The cube-object cell duality
//! A `=CUBEMEMBER(...)` / `=CUBESET(...)` cell DISPLAYS a caption but carries an
//! underlying member/set object. Another cube formula that references the cell
//! (e.g. `=CUBEVALUE("Sales", B2)`) uses the member/set it holds, not the caption.
//! `CubePrefetch.bindings` records those per-cell objects so a `CellRef` argument
//! resolves to the right member/set.

use crate::cell::{Cell, CellError, CellValue};
use crate::coord::col_to_index;
use crate::dependency_extractor::{BuiltinFunction, Expression, Value};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Whether a cube object is a single member/tuple or a set of members.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CubeBindingKind {
    Member,
    Set,
}

/// A cube object carried by a cell that holds CUBEMEMBER / CUBESET /
/// CUBERANKEDMEMBER / CUBEKPIMEMBER. The cell displays `caption`, but cube
/// formulas that reference the cell use the member/set it carries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CubeBinding {
    /// The connection (model) this object belongs to.
    pub connection: String,
    /// Single member/tuple, or a set of members.
    pub kind: CubeBindingKind,
    /// Canonical member-expression (for a member) or set identity (for a set)
    /// used when this cell is referenced as an argument to another cube function.
    pub expression: String,
    /// Text shown in the cell.
    pub caption: String,
    /// For a set: the resolved, ordered member expressions. Empty for a member.
    #[serde(default)]
    pub members: Vec<String>,
    /// A precomputed scalar carried by this member (e.g. a KPI value/goal/status).
    /// CUBEVALUE returns it when this member is used without an explicit measure.
    #[serde(default)]
    pub scalar: Option<f64>,
}

/// The pre-fetched result of one cube call, keyed in `CubePrefetch.results` by
/// the call signature produced by `cube_call_key`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum CubeCallResult {
    /// A scalar number (CUBEVALUE, CUBESETCOUNT, a numeric property/KPI value).
    Number(f64),
    /// A text value (a string property).
    Text(String),
    /// A cube object (CUBEMEMBER / CUBESET / CUBERANKEDMEMBER / CUBEKPIMEMBER):
    /// the caption to display. (The cell's binding lives in `CubePrefetch.bindings`.)
    Object { caption: String },
    /// An error to surface in the cell.
    Error(CubeError),
}

/// Errors a cube call can produce, mapped to spreadsheet cell errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CubeError {
    /// Unknown connection name -> #NAME?
    Name,
    /// Malformed member/set expression or bad argument -> #VALUE!
    Value,
    /// Member / measure / KPI not found, or no data / connection offline -> #N/A
    NotAvailable,
    /// Bad reference (e.g. CUBERANKEDMEMBER rank out of range) -> #REF!
    Reference,
    /// The model's security refused the query: the active "view as" role
    /// denies an object the formula reads, or its row filters cannot be
    /// enforced for it. Renders as `#N/A` like [`NotAvailable`](Self::NotAvailable)
    /// — a cube cell has no channel for a message, and that is Excel's
    /// semantics — but it is a DISTINCT variant on purpose: a refusal is not
    /// "no data", and every non-cell caller (a script's `cube.value`, the AI
    /// and MCP tools, the capability audit trail) must be able to tell them
    /// apart instead of reporting a refusal as a successful empty answer.
    Refused,
}

impl CubeError {
    pub fn to_cell_error(self) -> CellError {
        match self {
            CubeError::Name => CellError::Name,
            CubeError::Value => CellError::Value,
            // A refusal is #N/A in the CELL (see the variant's doc); the
            // distinction survives everywhere a message can be carried.
            CubeError::NotAvailable | CubeError::Refused => CellError::NA,
            CubeError::Reference => CellError::Ref,
        }
    }
}

/// All cube data pre-fetched for one synchronous recalc.
///
/// Keys in both maps are JSON-friendly strings so the whole struct serializes
/// across the Tauri IPC boundary (a `HashMap` with a tuple key would not).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CubePrefetch {
    /// Per-cell bindings keyed by `cell_key(row, col)` (0-based grid coords) for
    /// every cell whose formula yields a cube object. Lets a `CellRef` argument
    /// in another cube formula resolve to the member/set the referenced cell holds.
    pub bindings: HashMap<String, CubeBinding>,
    /// Pre-fetched results keyed by `cube_call_key`.
    pub results: HashMap<String, CubeCallResult>,
    /// WHICH CELLS this prefetch was built for, or `None` for a prefetch that
    /// answers every cube call by its key alone (the object-binding runtime,
    /// hand-built test data). See [`CubePrefetch::covers`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<CubePrefetchScope>,
    /// A FULL REFRESH's pre-fetch for each OTHER sheet that has cube cells
    /// (Calculate Now, `cube_prefetch_all`), keyed by the sheet's name
    /// UPPERCASED; empty for every other pre-fetch. A sheet's bindings are
    /// keyed by cell, so one pre-fetch cannot carry two sheets' -- each sheet
    /// gets its own, and the evaluator picks the one built for the sheet it is
    /// evaluating ([`CubePrefetch::for_sheet`]).
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub other_sheets: HashMap<String, CubePrefetch>,
}

/// The cells a scoped [`CubePrefetch`] resolved results for: every cube-bearing
/// cell the recalculation it was built for evaluates, on ONE sheet.
///
/// WHY A PREFETCH SAYS WHAT IT COVERS (BUG-0476 follow-up). A recalculation
/// that carries cube data used to answer `#N/A` for every cube call whose key
/// it did not hold, so a cell the prefetch had not been built for -- one the
/// cascade reached by a route the prefetch did not predict, or a cube cell on
/// ANOTHER sheet in a workbook-wide Calculate Now, which was then built from
/// the active sheet alone (it now carries one pre-fetch per sheet,
/// [`CubePrefetch::other_sheets`]) -- was clobbered to `#N/A`. With a scope, such a cell is
/// treated exactly as if no cube data had been fetched at all: each of its
/// calls is answered from the sheet's results cache ([`CallMemo`],
/// `preserved_cube_value`) for exactly the arguments it has now, and is
/// `#N/A` when no answer is recorded for them. A
/// cell the prefetch DID cover whose key
/// is missing still answers `#N/A`, because that means the prefetch and the
/// evaluator keyed the call differently (an argument the prefetch could not
/// see the new value of) -- keeping the previous member's number there would
/// show a stale answer as current, which is worse than a refusal.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CubePrefetchScope {
    /// The sheet the covered cells are on, as the workbook spells it
    /// (compared case-insensitively, as every sheet lookup is).
    pub sheet: String,
    /// `cell_key` of every covered cell.
    pub covered: HashSet<String>,
}

impl CubePrefetch {
    pub fn binding_at(&self, row: u32, col: u32) -> Option<&CubeBinding> {
        self.bindings.get(&cell_key(row, col))
    }
    pub fn result(&self, key: &str) -> Option<&CubeCallResult> {
        self.results.get(key)
    }
    pub fn insert_binding(&mut self, row: u32, col: u32, binding: CubeBinding) {
        self.bindings.insert(cell_key(row, col), binding);
    }

    /// The pre-fetch built for `sheet` (the formula's sheet): the one in
    /// `other_sheets` under its name when there is one, else this one -- whose
    /// `scope` then decides, through [`CubePrefetch::covers`], whether it
    /// covers the cell at all.
    pub fn for_sheet(&self, sheet: Option<&str>) -> &CubePrefetch {
        if self.other_sheets.is_empty() {
            return self;
        }
        match sheet {
            Some(sheet) => self.other_sheets.get(&identity::sheet_name_key(sheet)).unwrap_or(self),
            None => self,
        }
    }

    /// Whether this prefetch was built for the cell being evaluated: the cell
    /// at (`row`, `col`) on `sheet`. An unscoped prefetch covers everything; an
    /// evaluation that does not know its sheet or its position (a detached,
    /// positionless evaluation) is answered by key, as it always was.
    pub fn covers(&self, sheet: Option<&str>, row: Option<u32>, col: Option<u32>) -> bool {
        let Some(scope) = &self.scope else {
            return true;
        };
        if let Some(sheet) = sheet {
            if !identity::sheet_names_equal(sheet, &scope.sheet) {
                return false;
            }
        }
        match (row, col) {
            (Some(r), Some(c)) => scope.covered.contains(&cell_key(r, c)),
            _ => true,
        }
    }
}

/// Stable per-cell binding key (0-based row/col).
pub fn cell_key(row: u32, col: u32) -> String {
    format!("{}:{}", row, col)
}

/// Abstracts the two pieces of context needed to resolve a cube argument:
/// the per-cell cube bindings, and the plain display text of a referenced cell.
/// Implemented by BOTH the evaluator and the app-side pre-pass so they compute
/// identical call keys.
///
/// `Sync` is required so a `&dyn CubeResolver` is `Send` and can be held across
/// `.await` in the app-side async pre-pass (Tauri command futures must be Send).
pub trait CubeResolver: Sync {
    /// The cube object a cell carries, if any (0-based coords).
    fn binding_at(&self, row: u32, col: u32) -> Option<&CubeBinding>;
    /// The plain display text of a (non-cube) cell, if any (0-based coords).
    fn cell_text(&self, row: u32, col: u32) -> Option<String>;
    /// A sheet-QUALIFIED cell argument (`Inputs!B2`; 0-based coords), as the
    /// string it contributes to the call key. An implementation that can see
    /// the workbook's sheets answers it through [`qualified_cell_arg`]; the
    /// default -- a resolver with no sheet table -- refuses it with `#VALUE!`,
    /// because reading the formula's OWN sheet at those coordinates would serve
    /// another cell's member as if it were the one named.
    fn qualified_cell_arg(&self, _sheet: &str, _row: u32, _col: u32) -> Result<String, CubeError> {
        Err(CubeError::Value)
    }
    /// Whether a sheet qualifier names the resolver's OWN sheet (`Sheet1!B2`
    /// in a formula on Sheet1). The default -- no sheet table -- says no.
    fn is_own_sheet(&self, _sheet: &str) -> bool {
        false
    }
}

/// The cube object a cell reference (`sheet`, 0-based `row`/`col`) names --
/// only on the resolver's own sheet, the one sheet whose objects a pre-fetch
/// resolves. A reference to another sheet never borrows the object that
/// happens to sit at the same coordinates here.
pub fn referenced_binding<'r>(
    r: &'r dyn CubeResolver,
    sheet: &Option<String>,
    row: u32,
    col: u32,
) -> Option<&'r CubeBinding> {
    match sheet {
        Some(s) if !r.is_own_sheet(s) => None,
        _ => r.binding_at(row, col),
    }
}

/// The text a cube argument reads from a non-cube cell holding `value` -- THE
/// rule both resolvers (the evaluator's and the app's pre-pass) apply, so the
/// two compute the same call key. `None` for an empty or error cell.
pub fn cube_cell_text(value: &CellValue) -> Option<String> {
    match value {
        CellValue::Text(s) => Some(s.clone()),
        CellValue::Number(n) => Some(format!("{}", n)),
        CellValue::Boolean(b) => Some(if *b { "TRUE".to_string() } else { "FALSE".to_string() }),
        _ => None,
    }
}

/// Whether `func` yields a cube OBJECT (a member or a set, displayed by its
/// caption) rather than a scalar.
pub fn is_cube_object_function(func: &BuiltinFunction) -> bool {
    matches!(
        func,
        BuiltinFunction::CubeMember
            | BuiltinFunction::CubeSet
            | BuiltinFunction::CubeRankedMember
            | BuiltinFunction::CubeKpiMember
    )
}

/// An UNQUALIFIED cell argument on the resolver's own sheet: the cube object
/// the cell carries, else its plain text, else "" (an empty cell).
pub fn local_cell_arg(r: &dyn CubeResolver, row: u32, col: u32) -> String {
    if let Some(b) = r.binding_at(row, col) {
        b.expression.clone()
    } else if let Some(t) = r.cell_text(row, col) {
        t.trim().to_string()
    } else {
        String::new()
    }
}

/// Where a sheet-qualified cube argument points, as a resolver sees it.
pub enum QualifiedCell<'a> {
    /// The formula's own sheet, spelled out (`=CUBEVALUE("S",Sheet1!B2)` on
    /// Sheet1): exactly an unqualified reference.
    OwnSheet,
    /// A sheet the workbook does not have.
    NoSuchSheet,
    /// The cell on another sheet (`None` when it is empty).
    OtherSheet(Option<&'a Cell>),
}

/// THE RULE for a sheet-qualified cube argument (`Inputs!B2`), shared by the
/// evaluator and the app's pre-pass so their keys cannot drift apart.
///
/// - The formula's own sheet: the unqualified answer (object, else text).
/// - A sheet that does not exist: `#REF!`, as every other reference to one.
/// - A cell on another sheet holding a cube OBJECT (`CUBEMEMBER`, `CUBESET`,
///   ...): `#VALUE!`. The object it carries is resolved only for cells on the
///   sheet a pre-fetch is built for, so its caption is all either side could
///   read -- and keying the call on a caption would serve some other member's
///   number with no error at all. A refusal, never a lie; put the member's
///   expression (or a CUBEMEMBER of its own) on the formula's sheet instead.
/// - Any other cell on another sheet: its plain text, as on the own sheet.
///
/// Before this rule a qualified argument read the FORMULA's sheet at the same
/// coordinates, on both sides alike, so the key matched and the call was
/// served for whatever member happened to sit there.
pub fn qualified_cell_arg(
    r: &dyn CubeResolver,
    target: QualifiedCell<'_>,
    row: u32,
    col: u32,
) -> Result<String, CubeError> {
    match target {
        QualifiedCell::OwnSheet => Ok(local_cell_arg(r, row, col)),
        QualifiedCell::NoSuchSheet => Err(CubeError::Reference),
        QualifiedCell::OtherSheet(None) => Ok(String::new()),
        QualifiedCell::OtherSheet(Some(cell)) => {
            let holds_object = matches!(
                cell.get_ast(),
                Some(Expression::FunctionCall { func, .. }) if is_cube_object_function(func)
            );
            if holds_object {
                return Err(CubeError::Value);
            }
            Ok(cube_cell_text(&cell.value).map(|t| t.trim().to_string()).unwrap_or_default())
        }
    }
}

/// Format a numeric literal argument deterministically (so the pre-pass and the
/// evaluator agree on keys). Integers print without a decimal point.
pub fn format_number_arg(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        // Trim to a stable representation.
        let s = format!("{}", n);
        s
    }
}

/// Resolve one cube argument expression to its canonical string form.
///
/// - string literal            -> the trimmed string
/// - number / boolean literal  -> a stable textual form
/// - cell reference            -> the referenced cell's binding expression, else
///                                its plain display text ("" for an empty cell)
/// - sheet-qualified reference -> `CubeResolver::qualified_cell_arg` (the rule
///                                is [`qualified_cell_arg`]): the named sheet's
///                                cell, never the formula's own sheet
/// - nested CUBEMEMBER/CUBESET  -> the nested call's member/set expression argument
pub fn resolve_cube_arg(expr: &Expression, r: &dyn CubeResolver) -> Result<String, CubeError> {
    match expr {
        Expression::Literal(Value::String(s)) => Ok(s.trim().to_string()),
        Expression::Literal(Value::Number(n)) => Ok(format_number_arg(*n)),
        Expression::Literal(Value::Boolean(b)) => {
            Ok(if *b { "TRUE".to_string() } else { "FALSE".to_string() })
        }
        Expression::CellRef { sheet, col, row, .. } => {
            let r0 = row.saturating_sub(1);
            let c0 = col_to_index(col) as u32;
            match sheet {
                Some(sheet) => r.qualified_cell_arg(sheet, r0, c0),
                None => Ok(local_cell_arg(r, r0, c0)),
            }
        }
        Expression::FunctionCall { func, args, .. } => match func {
            // A nested member/set object is identified by its member/set
            // expression argument (args[1]). Nested ranked/KPI members are not
            // representable as a stable string — author those in their own cell.
            BuiltinFunction::CubeMember | BuiltinFunction::CubeSet => {
                if args.len() >= 2 {
                    resolve_cube_arg(&args[1], r)
                } else {
                    Err(CubeError::Value)
                }
            }
            _ => Err(CubeError::Value),
        },
        _ => Err(CubeError::Value),
    }
}

/// Field separator unlikely to appear in member expressions (ASCII unit separator).
const KEY_SEP: char = '\u{1f}';

/// Build the deterministic lookup key for a cube call. Both the async pre-pass
/// and the synchronous evaluator call THIS function with the same arguments and
/// resolver behaviour, guaranteeing their keys match.
///
/// The key is `FUNCNAME␟arg0␟arg1␟…` where each `argN` is `resolve_cube_arg`.
pub fn cube_call_key(
    func_name: &str,
    args: &[Expression],
    r: &dyn CubeResolver,
) -> Result<String, CubeError> {
    let mut key = String::from(func_name);
    for a in args {
        key.push(KEY_SEP);
        key.push_str(&resolve_cube_arg(a, r)?);
    }
    Ok(key)
}

/// Canonical uppercase name for a cube `BuiltinFunction`, or `None` if the
/// function is not a cube function. Used by the app-side pre-pass to label calls.
pub fn cube_function_name(func: &BuiltinFunction) -> Option<&'static str> {
    Some(match func {
        BuiltinFunction::CubeValue => "CUBEVALUE",
        BuiltinFunction::CubeMember => "CUBEMEMBER",
        BuiltinFunction::CubeSet => "CUBESET",
        BuiltinFunction::CubeSetCount => "CUBESETCOUNT",
        BuiltinFunction::CubeRankedMember => "CUBERANKEDMEMBER",
        BuiltinFunction::CubeMemberProperty => "CUBEMEMBERPROPERTY",
        BuiltinFunction::CubeKpiMember => "CUBEKPIMEMBER",
        _ => return None,
    })
}

// ============================================================================
// THE RESULTS CACHE -- what each cube or custom-function call answered when it
// was served with data, for a recalculation that has none (BUG-0476 follow-up)
// ============================================================================

/// How many distinct calls one generation of a [`CallMemo`] holds before it
/// rolls over (see [`CallMemo`] for the two generations). Entries are of
/// fixed size apart from the answer itself (a [`CallKey`] is a digest, never
/// the arguments' spelling), so a generation of these is a few megabytes.
pub const CALL_MEMO_GENERATION: usize = 65_536;

/// How many bytes (entries plus answers, approximately -- see
/// [`entry_bytes`]) one generation of ONE sheet's [`CallMemo`] holds before it
/// rolls over: an answer can be a large array or a long text.
pub const CALL_MEMO_GENERATION_BYTES: usize = 16 * 1024 * 1024;

/// How many bytes every [`CallMemo`] of the WORKBOOK holds together (rev6A#2).
/// A sheet's own bound alone let a 30-sheet workbook hold 30 times it. The
/// ledger is per process, which is per workbook: Calcula holds one document
/// per process, and File > New / Open drops the old sheets' memos, which
/// gives their bytes back ([`CallMemoLedger`]).
pub const CALL_MEMO_WORKBOOK_BYTES: usize = 64 * 1024 * 1024;

/// What kind of call a [`CallKey`] names. A model change forgets the CUBE
/// answers and keeps the custom-function ones ([`CallMemo::forget_cube_answers`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CallKind {
    /// A cube function (`CUBEVALUE`, `CUBEMEMBER`, ...).
    Cube,
    /// A custom (JavaScript) function.
    Custom,
}

/// THE KEY A [`CallMemo`] FILES AN ANSWER UNDER: a fixed-size digest of the
/// call's canonical spelling -- its function and the exact values or member
/// expressions of its arguments (rev6A#2).
///
/// WHY A DIGEST. A custom function's spelling spells every argument VALUE, so
/// `=MYFN(A2,$X$1:$Y$5000)` spelled about 105 KB -- built on every evaluation
/// and stored per answer, so a sheet's byte bound held only ~160 of them and
/// one pass evicted its own answers. The spelling is now streamed into the
/// hash and never kept.
///
/// WHY IT CANNOT CONFUSE TWO CALLS. Two keys are equal only when the kind, the
/// spelling's length in bytes and 128 bits of hash all agree. The hash is two
/// domain-separated SipHash-1-3 outputs under a key drawn at random once per
/// process, so nobody can construct a workbook whose calls collide -- an
/// accidental collision is ~2^-128 per pair -- and a collision is what would
/// serve one call's answer for another's arguments.
///
/// A custom function's key also carries a tag of the function's NAME
/// ([`custom_function_tag`]), so every answer one function gave can be
/// forgotten when its definition changes ([`CallMemo::forget_custom_function_answers`]);
/// a cube key's tag is 0. Two names sharing a tag (2^-64) only forget more.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CallKey {
    kind: CallKind,
    name: u64,
    len: u64,
    digest: [u64; 2],
}

impl CallKey {
    /// The key of a cube call whose canonical spelling is `spelling`
    /// (`cube_call_key` read through the evaluator's fingerprint resolver).
    pub fn cube(spelling: &str) -> CallKey {
        let mut writer = KeyWriter::new();
        writer.bytes(spelling.as_bytes());
        writer.finish(CallKind::Cube)
    }

    /// Whether this is a call of the custom function whose name has `tag`.
    fn calls_custom_function(&self, tag: u64) -> bool {
        self.kind == CallKind::Custom && self.name == tag
    }

    /// Which kind of call this key names.
    pub fn kind(&self) -> CallKind {
        self.kind
    }
}

/// Streams a call's canonical spelling into a [`CallKey`] without building it.
struct KeyWriter {
    first: std::collections::hash_map::DefaultHasher,
    second: std::collections::hash_map::DefaultHasher,
    len: u64,
}

impl KeyWriter {
    fn new() -> Self {
        use std::hash::{BuildHasher, Hasher};
        // ONE secret SipHash key per process; the two outputs are separated by
        // a leading domain byte, so they are two independent pseudo-random
        // functions of the same spelling.
        static KEY: std::sync::OnceLock<std::collections::hash_map::RandomState> = std::sync::OnceLock::new();
        let key = KEY.get_or_init(std::collections::hash_map::RandomState::new);
        let mut first = key.build_hasher();
        first.write_u8(0xA5);
        let mut second = key.build_hasher();
        second.write_u8(0x5A);
        KeyWriter { first, second, len: 0 }
    }

    /// One more piece of the spelling. The hasher is a byte stream, so the
    /// key depends on the concatenation alone, never on how it was chunked.
    fn bytes(&mut self, piece: &[u8]) {
        use std::hash::Hasher;
        self.first.write(piece);
        self.second.write(piece);
        self.len = self.len.wrapping_add(piece.len() as u64);
    }

    fn finish(self, kind: CallKind) -> CallKey {
        use std::hash::Hasher;
        CallKey { kind, name: 0, len: self.len, digest: [self.first.finish(), self.second.finish()] }
    }
}

/// The tag every key of a call of the custom function `name_upper` carries
/// (see [`CallKey`]): a domain-separated digest of the uppercased name.
fn custom_function_tag(name_upper: &str) -> u64 {
    let mut writer = KeyWriter::new();
    writer.bytes(b"\x1dNAME\x1f");
    writer.bytes(name_upper.as_bytes());
    writer.finish(CallKind::Custom).digest[0]
}

impl std::fmt::Write for KeyWriter {
    fn write_str(&mut self, s: &str) -> std::fmt::Result {
        self.bytes(s.as_bytes());
        Ok(())
    }
}

/// The byte budget every [`CallMemo`] of the workbook shares (see
/// [`CALL_MEMO_WORKBOOK_BYTES`]). Each memo adds what it files and gives back
/// what it drops -- on a roll-over, a clear, a forget, and when its last clone
/// is dropped -- so the count is exact, never a running total that only grows.
///
/// FAIR WHEN FULL (rev8A minor). The ledger knows its memos, so when one more
/// answer would overflow the budget, the sheet holding the MOST gives back
/// (its oldest generation), not the sheet that happens to be filing. It used
/// to be the filer: once two big sheets had filled the budget, every answer a
/// third sheet filed rolled that sheet's own generation over, so it kept two
/// answers and refused the rest while the big sheets never gave anything back.
pub struct CallMemoLedger {
    held: std::sync::atomic::AtomicUsize,
    cap: usize,
    /// Every memo counted here, by a weak handle (a dropped memo is skipped
    /// and pruned), with the bytes it holds now -- read without its lock.
    memos: std::sync::Mutex<Vec<(std::sync::Weak<std::sync::Mutex<CallMemoTable>>, std::sync::Arc<std::sync::atomic::AtomicUsize>)>>,
}

impl CallMemoLedger {
    /// A ledger that lets its memos hold `cap` bytes together.
    pub const fn new(cap: usize) -> Self {
        CallMemoLedger { held: std::sync::atomic::AtomicUsize::new(0), cap, memos: std::sync::Mutex::new(Vec::new()) }
    }

    fn register(
        &self,
        table: &std::sync::Arc<std::sync::Mutex<CallMemoTable>>,
        held: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    ) {
        let mut memos = self.memos.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        memos.retain(|(memo, _)| memo.strong_count() > 0);
        memos.push((std::sync::Arc::downgrade(table), held));
    }

    /// The memo, other than the one whose byte count is `me`, that holds the
    /// most bytes, and how many it holds. The ledger's own lock is released
    /// before this returns: the caller locks the memo, never both at once.
    fn largest_other(
        &self,
        me: &std::sync::Arc<std::sync::atomic::AtomicUsize>,
    ) -> Option<(std::sync::Arc<std::sync::Mutex<CallMemoTable>>, usize)> {
        let memos = self.memos.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut largest: Option<(&std::sync::Weak<std::sync::Mutex<CallMemoTable>>, usize)> = None;
        for (memo, held) in memos.iter() {
            if std::sync::Arc::ptr_eq(held, me) {
                continue;
            }
            let held = held.load(std::sync::atomic::Ordering::Relaxed);
            if held > 0 && largest.is_none_or(|(_, most)| held > most) {
                largest = Some((memo, held));
            }
        }
        largest.and_then(|(memo, held)| memo.upgrade().map(|memo| (memo, held)))
    }

    /// The bytes its memos hold now.
    pub fn held(&self) -> usize {
        self.held.load(std::sync::atomic::Ordering::Relaxed)
    }

    fn add(&self, bytes: usize) {
        self.held.fetch_add(bytes, std::sync::atomic::Ordering::Relaxed);
    }

    fn give_back(&self, bytes: usize) {
        // Saturating: an exact ledger never goes below zero, and a defect that
        // made it try must not wrap into "full" and stop every memo.
        let _ = self.held.fetch_update(
            std::sync::atomic::Ordering::Relaxed,
            std::sync::atomic::Ordering::Relaxed,
            |held| Some(held.saturating_sub(bytes)),
        );
    }

    fn would_overflow(&self, bytes: usize) -> bool {
        self.held().saturating_add(bytes) > self.cap
    }
}

/// The workbook's ledger.
static WORKBOOK_CALL_MEMO_LEDGER: CallMemoLedger = CallMemoLedger::new(CALL_MEMO_WORKBOOK_BYTES);

/// The workbook's results-cache ledger: what every sheet's [`CallMemo`] holds
/// together, against [`CALL_MEMO_WORKBOOK_BYTES`].
pub fn workbook_call_memo_ledger() -> &'static CallMemoLedger {
    &WORKBOOK_CALL_MEMO_LEDGER
}

struct CallMemoTable {
    current: HashMap<CallKey, crate::evaluator::EvalResult>,
    previous: HashMap<CallKey, crate::evaluator::EvalResult>,
    /// Approximate bytes held by `current` / `previous` (see [`entry_bytes`]).
    current_bytes: usize,
    previous_bytes: usize,
    /// The workbook-wide budget these bytes are counted against.
    ledger: &'static CallMemoLedger,
    /// `current_bytes + previous_bytes`, mirrored for the ledger, which reads
    /// it without this table's lock to find the largest holder.
    held: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    /// See [`CallMemo::values_may_be_stale`].
    values_may_be_stale: bool,
    /// See [`CallMemo::knows_custom_function`].
    custom_functions: HashSet<String>,
    /// See [`CallMemo::holds_custom_function`]: uppercased name -> the library
    /// generation that must be installed before its served answers count.
    held_custom_functions: HashMap<String, u64>,
}

/// How many custom-function NAMES one memo remembers
/// ([`CallMemo::note_custom_function`]); a workbook defines a handful.
const CALL_MEMO_CUSTOM_FUNCTION_NAMES: usize = 4_096;

impl CallMemoTable {
    fn new(ledger: &'static CallMemoLedger) -> Self {
        CallMemoTable {
            current: HashMap::new(),
            previous: HashMap::new(),
            current_bytes: 0,
            previous_bytes: 0,
            ledger,
            held: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            values_may_be_stale: false,
            custom_functions: HashSet::new(),
            held_custom_functions: HashMap::new(),
        }
    }

    /// Publishes what this table holds now to the ledger's mirror.
    fn mirror(&self) {
        self.held
            .store(self.current_bytes.saturating_add(self.previous_bytes), std::sync::atomic::Ordering::Relaxed);
    }

    /// Removes and returns the answer for `key` from either generation.
    fn take(&mut self, key: &CallKey) -> Option<crate::evaluator::EvalResult> {
        if let Some(answer) = self.current.remove(key) {
            let bytes = entry_bytes(&answer);
            self.current_bytes = self.current_bytes.saturating_sub(bytes);
            self.ledger.give_back(bytes);
            self.mirror();
            return Some(answer);
        }
        let answer = self.previous.remove(key)?;
        let bytes = entry_bytes(&answer);
        self.previous_bytes = self.previous_bytes.saturating_sub(bytes);
        self.ledger.give_back(bytes);
        self.mirror();
        Some(answer)
    }

    /// Rolls the generations over: the previous one is dropped and the current
    /// one becomes the previous one.
    fn roll(&mut self) {
        self.ledger.give_back(self.previous_bytes);
        self.previous = std::mem::take(&mut self.current);
        self.previous_bytes = std::mem::take(&mut self.current_bytes);
        self.mirror();
    }

    /// Gives back this table's OLDEST generation -- the previous one, or the
    /// current one when it has only that -- for another sheet's answer when
    /// the workbook's budget is full and this table holds the most.
    fn shed_oldest(&mut self) {
        if self.previous.is_empty() {
            self.ledger.give_back(self.current_bytes);
            self.current.clear();
            self.current_bytes = 0;
        } else {
            self.ledger.give_back(self.previous_bytes);
            self.previous.clear();
            self.previous_bytes = 0;
        }
        self.mirror();
    }

    /// Makes room in the WORKBOOK's budget for `bytes` more: while it would
    /// overflow and another sheet holds more than this one, that sheet gives
    /// back its oldest generation; when this sheet holds the most, it rolls
    /// its own generations over (as it always did). A sheet another thread is
    /// using right now is not waited for (`try_lock`: this table's own lock is
    /// held, and two fillers waiting on each other would deadlock) -- this one
    /// rolls instead.
    fn make_room(&mut self, bytes: usize) {
        for _ in 0..16 {
            if !self.ledger.would_overflow(bytes) {
                return;
            }
            let mine = self.current_bytes.saturating_add(self.previous_bytes);
            if let Some((other, theirs)) = self.ledger.largest_other(&self.held) {
                if theirs > mine {
                    match other.try_lock() {
                        Ok(mut table) => {
                            table.shed_oldest();
                            continue;
                        }
                        Err(std::sync::TryLockError::Poisoned(poisoned)) => {
                            poisoned.into_inner().shed_oldest();
                            continue;
                        }
                        Err(std::sync::TryLockError::WouldBlock) => {}
                    }
                }
            }
            break;
        }
        if self.ledger.would_overflow(bytes) && !self.current.is_empty() {
            self.roll();
        }
    }

    /// Files `answer` under `key` in the current generation, rolling the
    /// generations over first when the current one is full -- by count or by
    /// this sheet's bytes -- and making room first when the WORKBOOK's budget
    /// would overflow ([`Self::make_room`]).
    fn put(&mut self, key: CallKey, answer: crate::evaluator::EvalResult) {
        let bytes = entry_bytes(&answer);
        if !self.current.is_empty()
            && (self.current.len() >= CALL_MEMO_GENERATION
                || self.current_bytes.saturating_add(bytes) > CALL_MEMO_GENERATION_BYTES)
        {
            self.roll();
        }
        self.make_room(bytes);
        self.current_bytes = self.current_bytes.saturating_add(bytes);
        self.ledger.add(bytes);
        self.current.insert(key, answer);
        self.mirror();
    }

    /// Drops every answer whose key `keep` refuses, giving its bytes back.
    fn retain(&mut self, keep: impl Fn(&CallKey) -> bool) {
        let mut freed_current = 0usize;
        self.current.retain(|key, answer| {
            let kept = keep(key);
            if !kept {
                freed_current += entry_bytes(answer);
            }
            kept
        });
        let mut freed_previous = 0usize;
        self.previous.retain(|key, answer| {
            let kept = keep(key);
            if !kept {
                freed_previous += entry_bytes(answer);
            }
            kept
        });
        self.current_bytes = self.current_bytes.saturating_sub(freed_current);
        self.previous_bytes = self.previous_bytes.saturating_sub(freed_previous);
        self.ledger.give_back(freed_current.saturating_add(freed_previous));
        self.mirror();
    }
}

impl Drop for CallMemoTable {
    /// The last clone of a memo is gone (its sheet was deleted, or the
    /// document closed): its bytes go back to the workbook's budget.
    fn drop(&mut self) {
        self.ledger.give_back(self.current_bytes.saturating_add(self.previous_bytes));
    }
}

/// The approximate heap cost of one memo entry -- a bound, not an accounting:
/// the key, the slot's own answer value and a map slot's overhead, plus what
/// the answer holds on the heap.
fn entry_bytes(answer: &crate::evaluator::EvalResult) -> usize {
    fn answer_bytes(answer: &crate::evaluator::EvalResult) -> usize {
        use crate::evaluator::EvalResult;
        let own = std::mem::size_of::<EvalResult>();
        match answer {
            EvalResult::Text(s) => own + s.capacity(),
            EvalResult::Array(items) | EvalResult::List(items) => {
                own + items.iter().map(answer_bytes).sum::<usize>()
            }
            EvalResult::Dict(entries) => {
                own + entries.iter().map(|(_, v)| 32 + answer_bytes(v)).sum::<usize>()
            }
            _ => own,
        }
    }
    std::mem::size_of::<CallKey>() + 16 + answer_bytes(answer)
}

/// THE RESULTS CACHE of ONE SHEET: what each cube and custom-function call
/// answered when it was served with data, filed by the FINGERPRINT of the
/// call's arguments -- every served call, wherever it sits in its formula.
///
/// WHY IT EXISTS (rev3A#3, BUG-0476). A recalculation that carries no cube
/// data or no custom-function (UDF) resolver -- the cross-sheet walk, a fill, a
/// paste without a pre-fetch, a background-sheet write, F9 and the save's own
/// recalculation (which never run custom functions, and carry cube data only
/// once the session has seen a CUBE formula) --
/// cannot compute such a call, and it must not clobber a working cell to
/// `#N/A` / `#NAME?` either. It used to answer with the cell's WHOLE stored
/// value, which was wrong twice over:
///
/// - inside a larger formula the stored value fed an operator again:
///   `=CUBEVALUE(..)/1000` showing 1234.5 became 1.2345, then 0.0012, one
///   division per recalculation;
/// - a call whose argument had just CHANGED kept the answer for the OLD
///   argument as if it were current (East's revenue next to "West").
///
/// THE RULE. A call with no data is answered by this cache: the answer
/// recorded for EXACTLY the arguments it has now ([`CallMemo::answer`]),
/// wherever the call sits -- `=CUBEVALUE(..)`, `=CUBEVALUE(..)/1000`,
/// `=IF(.., MYFN(A1))` alike. With no such answer it refuses honestly: `#N/A`
/// for a cube call, `#NAME?` for a custom function. The cell's own stored
/// value is never read, so neither lie can recur: a value is never fed back
/// to an operator (the operator gets the CALL's answer, every time the same
/// one), and an answer computed for other arguments is never shown (a changed
/// argument is a different fingerprint). An argument that goes back to what
/// it was finds its answer again.
///
/// KEYED BY FINGERPRINT, NOT BY CELL. An answer is a fact about the arguments
/// (a call with these arguments answered this), so it holds wherever the call
/// sits: sorting, inserting rows or moving cells cannot misfile it, and two
/// cells making the same call share one answer.
///
/// ONE ANSWER PER CALL, THE NEWEST. Serving a call again replaces its answer.
/// A model REFRESH (new data, a changed measure, a connection or "view as"
/// role change -- Calculate Now with cube data, `recalcWithCube`) first
/// FORGETS every cube answer ([`CallMemo::forget_cube_answers`]) and then
/// re-serves every cube call a cell makes now, so an answer from the model as
/// it was is never served afterwards for an argument that comes back (rev6A#1:
/// it used to be, with no error). Custom-function answers survive a refresh:
/// they are facts about their arguments, not about the model -- but not a
/// change of the function's own CODE: when a Custom Functions library changes
/// (the author's Save, an application's subscribe or update), every function
/// whose definition changed forgets its answers and a function that is gone is
/// forgotten altogether ([`CallMemo::forget_custom_function_answers`],
/// [`CallMemo::forget_custom_function`], run by the app's
/// `bi::cube::forget_redefined_custom_functions`).
///
/// SHARED BY CLONES. `Grid::clone` shares one memo (an `Arc`): the app keeps
/// the active sheet twice (`AppState::grid` and `grids[active]`) and copies one
/// over the other, and a per-copy memo would lose what the other recorded. A
/// `Grid::new()` starts empty, so a blank sheet refuses until it is served; a
/// sheet an undo rebuilds from its snapshot keeps its memo
/// (`Grid::new_sharing_call_memo`).
///
/// WHERE ANSWERS COME FROM: every served call, root or nested (`Evaluator`
/// records it as it serves it -- an edit's pre-fetch, a batch's, Calculate
/// Now's full refresh, a UDF resolver), and the stored values of sheets just
/// installed from saved state -- a workbook just opened, the sheets a
/// subscribe, checkout or update of an application installs
/// (`Evaluator::remember_stored_call_result` / `remember_stored_call_answer`,
/// run by those paths: a saved value was calculated for the arguments saved
/// with it; a spill origin's answer is its whole spilled array). Only a call
/// that IS its formula can be seeded that way; a call inside a larger formula
/// has no saved value of its own, so a recalculation that runs because
/// something CHANGED refuses it until it is served (or until a root call with
/// the same fingerprint was seeded). A FULL recalculation (Calculate Now, the
/// save's own) keeps such a cell's stored result instead when nothing it reads
/// has changed -- see `calculation::run_calculation_pass` in the app, and
/// [`CallMemo::values_may_be_stale`] for the one fact it cannot read off the
/// dependency graph.
///
/// BOUNDED: two generations, each of at most [`CALL_MEMO_GENERATION`] calls
/// and about [`CALL_MEMO_GENERATION_BYTES`] bytes, and every sheet's memo
/// together at most about [`CALL_MEMO_WORKBOOK_BYTES`]. When the current
/// generation fills it becomes the previous one and the old previous one is
/// dropped; when the workbook's budget would overflow, the sheet holding the
/// MOST gives back its oldest generation ([`CallMemoLedger`]); a call found in the
/// previous generation moves back to the current one. A call is filed under a
/// fixed-size [`CallKey`], never its arguments' spelling, so what is held is
/// the answers. Forgetting is safe -- it only turns an answer into a refusal.
pub struct CallMemo {
    table: std::sync::Arc<std::sync::Mutex<CallMemoTable>>,
}

impl Default for CallMemo {
    /// An empty memo counted against the workbook's budget.
    fn default() -> Self {
        CallMemo::with_ledger(workbook_call_memo_ledger())
    }
}

impl Clone for CallMemo {
    /// SHARES the memo -- see the type's doc for why a clone is not a copy.
    fn clone(&self) -> Self {
        CallMemo { table: std::sync::Arc::clone(&self.table) }
    }
}

impl std::fmt::Debug for CallMemo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "CallMemo({} calls)", self.len())
    }
}

impl CallMemo {
    /// An empty memo whose bytes count against `ledger` -- the workbook's
    /// ([`CallMemo::default`]), or a test's own.
    pub fn with_ledger(ledger: &'static CallMemoLedger) -> Self {
        let table = CallMemoTable::new(ledger);
        let held = std::sync::Arc::clone(&table.held);
        let table = std::sync::Arc::new(std::sync::Mutex::new(table));
        ledger.register(&table, held);
        CallMemo { table }
    }

    fn table(&self) -> std::sync::MutexGuard<'_, CallMemoTable> {
        // A poisoned memo is still a correct one: every entry is a complete
        // fact, written under the lock in one step.
        self.table.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Records that the call with `key` answered `answer`, replacing whatever
    /// it answered before.
    pub fn remember(&self, key: CallKey, answer: &crate::evaluator::EvalResult) {
        let mut table = self.table();
        table.take(&key);
        table.put(key, answer.clone());
    }

    /// The answer recorded for the call with exactly `key` (an array answer
    /// comes back whole, so it spills again), or `None` when none is, which
    /// the caller turns into a refusal.
    pub fn answer(&self, key: &CallKey) -> Option<crate::evaluator::EvalResult> {
        let mut table = self.table();
        let answer = table.take(key)?;
        table.put(*key, answer.clone());
        Some(answer)
    }

    /// Forgets every answer: until each call is served again, a recalculation
    /// without data refuses it.
    pub fn clear(&self) {
        self.table().retain(|_| false);
    }

    /// Forgets every CUBE answer and keeps the custom-function ones (rev6A#1).
    /// For a recalculation that is about to re-serve every cube call with the
    /// model as it is NOW (Calculate Now with cube data, run after a measure
    /// edit, a data refresh or a "view as" switch): an answer recorded before
    /// it may come from the model as it was, and nothing would ever replace it
    /// for an argument no cell holds at that moment -- so an argument that came
    /// back later was served the old model's number as current.
    pub fn forget_cube_answers(&self) {
        self.table().retain(|key| key.kind() != CallKind::Cube);
    }

    /// Forgets every answer the custom function `name` gave (rev8A): its
    /// DEFINITION changed -- the author edited its code, or an application
    /// update replaced the library. An answer is a fact about the arguments
    /// only for the code that computed it, and nothing else would ever replace
    /// the answer for an argument no cell holds when the new code is installed:
    /// a recalculation without a resolver (the cross-sheet walk, F9, the save)
    /// would serve the OLD code's number for it as current, with no error.
    /// Keeps whether `name` is a known function (see
    /// [`Self::forget_custom_function`] for a function that is gone).
    pub fn forget_custom_function_answers(&self, name: &str) {
        let tag = custom_function_tag(&name.to_uppercase());
        self.table().retain(|key| !key.calls_custom_function(tag));
    }

    /// Forgets the custom function `name` altogether: the workbook no longer
    /// defines it (its library dropped it, or the whole library is gone). Its
    /// answers go, and so does the knowledge that it IS a function here, so a
    /// call of it is Excel's ordinary `#NAME?` again -- which an IFERROR around
    /// it handles (`=IFERROR(GONEFN(A1),0)` is 0 in Excel), never the sticky
    /// refusal of a call nobody computed.
    pub fn forget_custom_function(&self, name: &str) {
        let upper = name.to_uppercase();
        let tag = custom_function_tag(&upper);
        let mut table = self.table();
        table.retain(|key| !key.calls_custom_function(tag));
        table.custom_functions.remove(&upper);
    }

    /// Records that `name` (uppercased) IS a custom function of this workbook:
    /// a resolver served a call of it, a Custom Functions library defines it,
    /// or the host registers it (an add-in's function). Seeding a saved root
    /// call does NOT note it: a saved value proves only that the function
    /// existed when the value was computed. Never forgotten with the answers --
    /// it is a fact about the workbook's functions, not about any argument --
    /// only when the workbook stops defining it ([`Self::forget_custom_function`],
    /// [`Self::unnote_custom_function`]).
    pub fn note_custom_function(&self, name: &str) {
        let mut table = self.table();
        if table.custom_functions.len() < CALL_MEMO_CUSTOM_FUNCTION_NAMES || table.custom_functions.contains(name) {
            table.custom_functions.insert(name.to_string());
        }
    }

    /// Whether `name` (uppercased) is known to be a custom function here
    /// ([`Self::note_custom_function`]). A call of an UNKNOWN name with no data
    /// may be a typo or a function this workbook does not define -- Excel's
    /// `#NAME?`, which `IFERROR` handles -- while a KNOWN function with no data
    /// is a call whose answer nobody computed, which the evaluator answers
    /// with the refusal whole (`Evaluator::evaluate`).
    pub fn knows_custom_function(&self, name: &str) -> bool {
        self.table().custom_functions.contains(name)
    }

    /// Stops knowing `name` as a custom function WITHOUT forgetting its
    /// answers: the host no longer registers it (an add-in that registered it
    /// was unloaded) and no library defines it. A call of it with no data is
    /// then Excel's ordinary `#NAME?`, which an IFERROR handles; an answer
    /// already recorded for exactly its arguments is still the value that call
    /// computed.
    pub fn unnote_custom_function(&self, name: &str) {
        self.table().custom_functions.remove(&name.to_uppercase());
    }

    /// HOLDS the custom function `name` until the host has installed the
    /// library of `generation` (rev10 cache2 residual): its library was just
    /// replaced in the backend, but the page that runs custom functions still
    /// runs the OLD code until it re-installs, so an answer it serves in that
    /// window belongs to the old code and must not be recorded as a fact about
    /// the arguments. Served answers are still used for the edit that carried
    /// them; they are just not filed ([`Self::holds_custom_function`]). A later
    /// hold of the same name keeps the higher generation.
    pub fn hold_custom_function(&self, name: &str, generation: u64) {
        let upper = name.to_uppercase();
        let mut table = self.table();
        let held = table.held_custom_functions.entry(upper).or_insert(generation);
        if *held < generation {
            *held = generation;
        }
    }

    /// Releases every hold whose generation is `generation` or older: the host
    /// reported it has installed (at least) that library.
    pub fn release_custom_functions_up_to(&self, generation: u64) {
        self.table().held_custom_functions.retain(|_, held| *held > generation);
    }

    /// Whether answers the custom function `name` (uppercased) is SERVED must
    /// not be recorded yet ([`Self::hold_custom_function`]).
    pub fn holds_custom_function(&self, name: &str) -> bool {
        self.table().held_custom_functions.contains_key(name)
    }

    /// Whether this sheet's STORED VALUES may be stale for their arguments --
    /// set while manual calculation could have left a dependent un-recalculated
    /// (`calculation::set_calculation_mode` sets it on every sheet when
    /// calculation leaves or enters manual), cleared by a completed Calculate
    /// Now. A full recalculation that has no data for a call keeps the cell's
    /// stored result only when the stored values are vouched for (see
    /// `calculation::run_calculation_pass`, "A CALL WITH NO DATA IN A FULL
    /// PASS"); this is the one fact about that it cannot read off the
    /// dependency graph, because manual calculation records no pending set.
    pub fn values_may_be_stale(&self) -> bool {
        self.table().values_may_be_stale
    }

    /// Records that this sheet's stored values may have been left stale (see
    /// [`Self::values_may_be_stale`]). Never clears an answer: a recorded answer
    /// is a fact about its arguments, whatever the cells hold.
    pub fn note_values_may_be_stale(&self) {
        self.table().values_may_be_stale = true;
    }

    /// Vouches for this sheet's stored values again -- only a recalculation
    /// that evaluated every formula of the workbook may (a completed Calculate
    /// Now): after it each value is its formula's answer or a refusal.
    pub fn vouch_for_stored_values(&self) {
        self.table().values_may_be_stale = false;
    }

    /// The number of calls held (both generations).
    pub fn len(&self) -> usize {
        let table = self.table();
        table.current.len() + table.previous.len()
    }

    /// Whether nothing has been recorded.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Whether `expr` IS a call whose answers a [`CallMemo`] records: a cube
/// function, or a custom function (never the LAMBDA invoker `__INVOKE__`).
pub fn is_memo_call(expr: &Expression) -> bool {
    match expr {
        Expression::FunctionCall { func: BuiltinFunction::Custom(name), .. } => name != "__INVOKE__",
        Expression::FunctionCall { func, .. } => cube_function_name(func).is_some(),
        _ => false,
    }
}

/// Whether `expr` contains such a call at any depth.
pub fn contains_memo_call(expr: &Expression) -> bool {
    contains_call(expr, is_memo_call)
}

/// Whether `expr` contains a cube call ([`cube_function_name`]) at any depth --
/// without cloning or allocating, so a whole sheet's formulas can be screened.
pub fn contains_cube_call(expr: &Expression) -> bool {
    contains_call(expr, |e| {
        matches!(e, Expression::FunctionCall { func, .. } if cube_function_name(func).is_some())
    })
}

/// Whether `expr` reads something its REFERENCES do not name, at any depth: a
/// volatile built-in (the clock, the RNG, OFFSET / INDIRECT / CELL --
/// `crate::volatility::is_volatile_builtin`), the cell's own position
/// (`ROW()`, `COLUMN()`), or state outside the grid -- row heights, column
/// widths, a fill colour, a control's value, a pivot table, writeback
/// submissions, the virtual file system, row visibility (SUBTOTAL).
///
/// A full recalculation asks this before it keeps a cell whose cube or
/// custom-function call has no data (`calculation::run_calculation_pass`): it
/// tells an unchanged input from a changed one by watching the cells the
/// formula REFERENCES, and such a formula's inputs can change without any
/// referenced cell changing, so its stored value cannot be vouched for.
pub fn reads_beyond_its_references(expr: &Expression) -> bool {
    contains_call(expr, |e| match e {
        Expression::FunctionCall { func, .. } => {
            crate::volatility::is_volatile_builtin(func)
                || matches!(
                    func,
                    BuiltinFunction::Row
                        | BuiltinFunction::Column
                        | BuiltinFunction::GetRowHeight
                        | BuiltinFunction::GetColumnWidth
                        | BuiltinFunction::GetCellFillColor
                        | BuiltinFunction::GetControlValue
                        | BuiltinFunction::GetPivotData
                        | BuiltinFunction::Gather
                        | BuiltinFunction::GatherFrom
                        | BuiltinFunction::GatherCount
                        | BuiltinFunction::GatherSubmitters
                        | BuiltinFunction::GatherAt
                        | BuiltinFunction::FileRead
                        | BuiltinFunction::FileLines
                        | BuiltinFunction::FileExists
                        | BuiltinFunction::Subtotal
                )
        }
        _ => false,
    })
}

/// The direct sub-expressions of `expr`, for a walker that must see every
/// reference a formula holds (a range's endpoints included). EXHAUSTIVE on
/// purpose -- no `_` arm -- so a new [`Expression`] variant that holds
/// sub-expressions must be listed here, or every such walker would stop seeing
/// what is inside it.
pub fn sub_expressions(expr: &Expression) -> Vec<&Expression> {
    match expr {
        Expression::FunctionCall { args, .. } => args.iter().collect(),
        Expression::BinaryOp { left, right, .. } => vec![left.as_ref(), right.as_ref()],
        Expression::UnaryOp { operand, .. } => vec![operand.as_ref()],
        Expression::IndexAccess { target, index } => vec![target.as_ref(), index.as_ref()],
        Expression::ArrayLiteral { rows } => rows.iter().flatten().collect(),
        Expression::ListLiteral { elements } => elements.iter().collect(),
        Expression::DictLiteral { entries } => entries.iter().flat_map(|(k, v)| [k, v]).collect(),
        Expression::Sheet3DRef { reference, .. } => vec![reference.as_ref()],
        Expression::SpillRef { cell, .. } => vec![cell.as_ref()],
        Expression::ImplicitIntersection { operand } => vec![operand.as_ref()],
        Expression::Range { start, end, .. } => vec![start.as_ref(), end.as_ref()],
        Expression::Literal(_)
        | Expression::CellRef { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. }
        | Expression::NamedRef { .. }
        | Expression::TableRef { .. } => Vec::new(),
    }
}

/// Whether some node of `expr` satisfies `is_call`. EXHAUSTIVE on purpose, as
/// `volatility::contains_volatile_call` is: a new [`Expression`] variant that
/// holds sub-expressions must be handled here.
fn contains_call(expr: &Expression, is_call: fn(&Expression) -> bool) -> bool {
    if is_call(expr) {
        return true;
    }
    match expr {
        Expression::FunctionCall { args, .. } => args.iter().any(|a| contains_call(a, is_call)),
        Expression::BinaryOp { left, right, .. } => {
            contains_call(left, is_call) || contains_call(right, is_call)
        }
        Expression::UnaryOp { operand, .. } => contains_call(operand, is_call),
        Expression::IndexAccess { target, index } => {
            contains_call(target, is_call) || contains_call(index, is_call)
        }
        Expression::ArrayLiteral { rows } => rows.iter().flatten().any(|e| contains_call(e, is_call)),
        Expression::ListLiteral { elements } => elements.iter().any(|e| contains_call(e, is_call)),
        Expression::DictLiteral { entries } => entries
            .iter()
            .any(|(k, v)| contains_call(k, is_call) || contains_call(v, is_call)),
        Expression::Sheet3DRef { reference, .. } => contains_call(reference, is_call),
        Expression::SpillRef { cell, .. } => contains_call(cell, is_call),
        Expression::ImplicitIntersection { operand } => contains_call(operand, is_call),
        // A range's endpoints are CellRefs (a computed range is OFFSET or
        // INDIRECT, a call caught above); a name's definition is not here.
        Expression::Literal(_)
        | Expression::CellRef { .. }
        | Expression::Range { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. }
        | Expression::NamedRef { .. }
        | Expression::TableRef { .. } => false,
    }
}

/// The [`CallKey`] of a custom-function (UDF) call: its name and the exact
/// values its arguments evaluated to, streamed into the digest -- the
/// spelling, which for a large range runs to megabytes, is never built.
/// `None` when an argument is something no key can spell exactly (a LAMBDA, a
/// list, a dictionary) -- such a call is never recorded and never kept.
///
/// Finer than the resolver's own key on purpose (a blank and an empty string
/// are different here): a finer key can only refuse more, never keep an
/// answer that belongs to other arguments.
pub fn udf_call_fingerprint(name: &str, args: &[crate::evaluator::EvalResult]) -> Option<CallKey> {
    use std::fmt::Write;
    let name_upper = name.to_uppercase();
    let mut key = KeyWriter::new();
    let _ = write!(key, "\u{1e}UDF{}{}", KEY_SEP, name_upper);
    for arg in args {
        let _ = key.write_char(KEY_SEP);
        push_value_fingerprint(arg, &mut key)?;
    }
    let mut key = key.finish(CallKind::Custom);
    key.name = custom_function_tag(&name_upper);
    Some(key)
}

fn push_value_fingerprint(value: &crate::evaluator::EvalResult, out: &mut KeyWriter) -> Option<()> {
    use crate::evaluator::EvalResult;
    use std::fmt::Write;
    match value {
        // `{:?}` prints the shortest text that reads back as the same f64, so
        // two different numbers never share a spelling (-0 included).
        EvalResult::Number(n) => {
            let _ = write!(out, "n{:?}", n);
        }
        // Length-prefixed, so a separator inside the text cannot forge a
        // second argument.
        EvalResult::Text(s) => {
            let _ = write!(out, "t{}:{}", s.len(), s);
        }
        EvalResult::Boolean(b) => {
            let _ = out.write_str(if *b { "b1" } else { "b0" });
        }
        EvalResult::Error(e) => {
            let _ = write!(out, "e{}", e.as_literal());
        }
        EvalResult::Blank => {
            let _ = out.write_char('z');
        }
        EvalResult::Array(items) => {
            let _ = write!(out, "a{}[", items.len());
            for item in items {
                push_value_fingerprint(item, out)?;
                let _ = out.write_char(',');
            }
            let _ = out.write_char(']');
        }
        EvalResult::List(_) | EvalResult::Dict(_) | EvalResult::Lambda { .. } => return None,
    }
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dependency_extractor::Expression;

    /// A test resolver with a couple of seeded bindings + cell texts.
    struct TestResolver {
        bindings: HashMap<(u32, u32), CubeBinding>,
        texts: HashMap<(u32, u32), String>,
    }
    impl CubeResolver for TestResolver {
        fn binding_at(&self, row: u32, col: u32) -> Option<&CubeBinding> {
            self.bindings.get(&(row, col))
        }
        fn cell_text(&self, row: u32, col: u32) -> Option<String> {
            self.texts.get(&(row, col)).cloned()
        }
    }

    fn str_lit(s: &str) -> Expression {
        Expression::Literal(Value::String(s.to_string()))
    }
    fn num_lit(n: f64) -> Expression {
        Expression::Literal(Value::Number(n))
    }
    fn cell_ref(col: &str, row: u32) -> Expression {
        Expression::CellRef {
            sheet: None,
            col: col.to_string(),
            row,
            col_absolute: false,
            row_absolute: false,
            ref_site_id: Default::default(),
        }
    }

    fn empty_resolver() -> TestResolver {
        TestResolver { bindings: HashMap::new(), texts: HashMap::new() }
    }

    #[test]
    fn key_is_deterministic_for_literals() {
        let r = empty_resolver();
        let args = vec![str_lit("Sales"), str_lit("[Revenue]"), str_lit("Geo[Country]=Sweden")];
        let k1 = cube_call_key("CUBEVALUE", &args, &r).unwrap();
        let k2 = cube_call_key("CUBEVALUE", &args, &r).unwrap();
        assert_eq!(k1, k2);
        assert!(k1.starts_with("CUBEVALUE"));
        assert!(k1.contains("[Revenue]"));
    }

    #[test]
    fn cellref_resolves_via_binding() {
        // B2 (row 2 -> 0-based row 1, col B -> 1) holds a CUBEMEMBER object.
        let mut bindings = HashMap::new();
        bindings.insert(
            (1, 1),
            CubeBinding {
                connection: "Sales".into(),
                kind: CubeBindingKind::Member,
                expression: "Geo[Country]=Sweden".into(),
                caption: "Sweden".into(),
                members: vec![],
                scalar: None,
            },
        );
        let r = TestResolver { bindings, texts: HashMap::new() };

        // CUBEVALUE("Sales","[Revenue]",B2) must key on the BINDING expression,
        // identical to the literal form.
        let via_ref = cube_call_key(
            "CUBEVALUE",
            &[str_lit("Sales"), str_lit("[Revenue]"), cell_ref("B", 2)],
            &r,
        )
        .unwrap();
        let via_literal = cube_call_key(
            "CUBEVALUE",
            &[str_lit("Sales"), str_lit("[Revenue]"), str_lit("Geo[Country]=Sweden")],
            &r,
        )
        .unwrap();
        assert_eq!(via_ref, via_literal);
    }

    #[test]
    fn cellref_falls_back_to_plain_text() {
        let mut texts = HashMap::new();
        texts.insert((0, 0), "[Revenue]".to_string()); // A1 contains literal text
        let r = TestResolver { bindings: HashMap::new(), texts };
        let k = cube_call_key("CUBEVALUE", &[str_lit("Sales"), cell_ref("A", 1)], &r).unwrap();
        assert!(k.contains("[Revenue]"));
    }

    #[test]
    fn number_arg_is_stable() {
        assert_eq!(format_number_arg(1.0), "1");
        assert_eq!(format_number_arg(2.0), "2");
        assert_eq!(format_number_arg(2.5), "2.5");
        let r = empty_resolver();
        let k = cube_call_key("CUBERANKEDMEMBER", &[str_lit("Sales"), cell_ref("D", 1), num_lit(1.0)], &r);
        assert!(k.is_ok());
    }

    #[test]
    fn nested_cubemember_resolves_to_member_expr() {
        let r = empty_resolver();
        let nested = Expression::FunctionCall {
            func: BuiltinFunction::CubeMember,
            args: vec![str_lit("Sales"), str_lit("Geo[Country]=Sweden")],
            ref_site_id: Default::default(),
        };
        let via_nested =
            cube_call_key("CUBEVALUE", &[str_lit("Sales"), str_lit("[Revenue]"), nested], &r).unwrap();
        let via_literal = cube_call_key(
            "CUBEVALUE",
            &[str_lit("Sales"), str_lit("[Revenue]"), str_lit("Geo[Country]=Sweden")],
            &r,
        )
        .unwrap();
        assert_eq!(via_nested, via_literal);
    }

    #[test]
    fn cube_function_name_maps_only_cube_fns() {
        assert_eq!(cube_function_name(&BuiltinFunction::CubeValue), Some("CUBEVALUE"));
        assert_eq!(cube_function_name(&BuiltinFunction::Sum), None);
    }

    // ---- The served-call memo ----

    use crate::evaluator::EvalResult;

    /// A ledger of the test's own, so a test that fills memos neither feels
    /// nor squeezes the workbook's budget other tests share.
    fn own_ledger(cap: usize) -> &'static CallMemoLedger {
        Box::leak(Box::new(CallMemoLedger::new(cap)))
    }

    fn key(spelling: &str) -> CallKey {
        CallKey::cube(spelling)
    }

    #[test]
    fn a_memo_answers_exactly_the_fingerprint_it_recorded() {
        let memo = CallMemo::default();
        memo.remember(key("F"), &EvalResult::Number(175.0));
        assert_eq!(memo.answer(&key("F")), Some(EvalResult::Number(175.0)));
        assert_eq!(memo.answer(&key("G")), None, "other arguments have no answer");
    }

    #[test]
    fn an_array_answer_comes_back_whole() {
        let memo = CallMemo::default();
        let array = EvalResult::Array(vec![EvalResult::Number(1.0), EvalResult::Number(2.0)]);
        memo.remember(key("F"), &array);
        assert_eq!(memo.answer(&key("F")), Some(array));
    }

    #[test]
    fn a_clone_shares_the_memo_and_a_new_one_starts_empty() {
        let memo = CallMemo::default();
        let shared = memo.clone();
        shared.remember(key("F"), &EvalResult::Text("USA".to_string()));
        assert_eq!(memo.answer(&key("F")), Some(EvalResult::Text("USA".to_string())));
        assert!(CallMemo::default().is_empty());
        shared.clear();
        assert!(memo.is_empty(), "clearing a clone clears the one memo they share");
    }

    #[test]
    fn serving_a_call_again_replaces_its_answer() {
        // A call served again (an edit's pre-fetch, a resolver) replaces its
        // answer: the newest is the one a recalculation without data gets.
        let memo = CallMemo::default();
        memo.remember(key("F"), &EvalResult::Number(175.0));
        memo.remember(key("F"), &EvalResult::Number(180.0));
        assert_eq!(memo.answer(&key("F")), Some(EvalResult::Number(180.0)), "the newer answer replaces the old one");
        assert_eq!(memo.len(), 1, "one answer per call");
    }

    #[test]
    fn a_model_refresh_forgets_the_cube_answers_and_keeps_the_custom_function_ones() {
        // rev6A#1: Calculate Now with cube data is about to re-serve every cube
        // call a cell makes NOW; an answer for an argument no cell holds at
        // that moment would otherwise outlive the model it came from.
        let ledger = own_ledger(usize::MAX);
        let memo = CallMemo::with_ledger(ledger);
        let udf = udf_call_fingerprint("MYFN", &[EvalResult::Number(3.0)]).unwrap();
        memo.remember(key("CUBEVALUE\u{1f}Sales\u{1f}UK"), &EvalResult::Number(50.0));
        memo.remember(udf, &EvalResult::Number(42.0));
        let held = ledger.held();
        memo.forget_cube_answers();
        assert_eq!(memo.answer(&key("CUBEVALUE\u{1f}Sales\u{1f}UK")), None, "a cube answer outlived a model refresh");
        assert_eq!(memo.answer(&udf), Some(EvalResult::Number(42.0)), "a custom function's answer is a fact about its arguments");
        assert!(ledger.held() < held, "the forgotten answer's bytes go back to the workbook");
        assert_eq!(udf.kind(), CallKind::Custom);
        assert_eq!(key("x").kind(), CallKind::Cube);
    }

    #[test]
    fn a_memo_keeps_two_generations_of_calls() {
        // Two generations: the first call survives one roll-over (and a lookup
        // moves it back into the current generation), not two.
        let memo = CallMemo::with_ledger(own_ledger(usize::MAX));
        memo.remember(key("first"), &EvalResult::Number(1.0));
        for i in 0..CALL_MEMO_GENERATION {
            memo.remember(key(&format!("g1-{}", i)), &EvalResult::Number(0.0));
        }
        assert!(memo.answer(&key("first")).is_some(), "survives one roll-over");
        for i in 0..(2 * CALL_MEMO_GENERATION) {
            memo.remember(key(&format!("g2-{}", i)), &EvalResult::Number(0.0));
        }
        assert!(memo.answer(&key("first")).is_none(), "forgotten after two");
        assert!(memo.len() <= 2 * CALL_MEMO_GENERATION);
    }

    #[test]
    fn a_memo_is_bounded_by_bytes_as_well_as_by_count() {
        // An answer can be a long text or a large array: a few of them must
        // roll the generations long before the count does.
        let memo = CallMemo::with_ledger(own_ledger(usize::MAX));
        let big = "x".repeat(CALL_MEMO_GENERATION_BYTES / 4);
        for i in 0..12 {
            memo.remember(key(&format!("call{}", i)), &EvalResult::Text(format!("{}{}", big, i)));
        }
        assert!(memo.len() <= 8, "two generations of at most ~16 MiB each hold at most 8 of these: {}", memo.len());
        assert_eq!(memo.answer(&key("call11")), Some(EvalResult::Text(format!("{}11", big))), "the newest is kept");
        assert_eq!(memo.answer(&key("call0")), None, "the oldest was dropped");
    }

    #[test]
    fn a_custom_function_handed_a_large_range_does_not_evict_its_own_answers() {
        // rev6A#2: the key spelled every argument VALUE, so =MYFN(A2,$X$1:$Y$5000)
        // filed ~40 KB per answer and a sheet's 2 x 16 MiB held a few hundred;
        // one fill-down evicted its own answers. A key is a fixed-size digest
        // now, so a thousand of them cost what a thousand numbers cost.
        let ledger = own_ledger(usize::MAX);
        let memo = CallMemo::with_ledger(ledger);
        let range = EvalResult::Array((0..5_000).map(|i| EvalResult::Number(i as f64 + 0.25)).collect());
        let call = |row: usize| udf_call_fingerprint("MYFN", &[EvalResult::Number(row as f64), range.clone()]).unwrap();
        for row in 0..1_000 {
            memo.remember(call(row), &EvalResult::Number(row as f64));
        }
        for row in [0usize, 1, 500, 999] {
            assert_eq!(memo.answer(&call(row)), Some(EvalResult::Number(row as f64)), "row {} lost its answer", row);
        }
        assert!(ledger.held() < 1024 * 1024, "a thousand answers hold {} bytes", ledger.held());
        assert_eq!(std::mem::size_of_val(&call(0)), std::mem::size_of::<CallKey>(), "a key's size never depends on its arguments");
    }

    #[test]
    fn every_sheets_memo_together_stays_inside_the_workbooks_budget() {
        // rev6A#2: the bound was per sheet, so a workbook of N such sheets held
        // N times it. The ledger is shared, and a memo that is dropped gives
        // its bytes back.
        let one = entry_bytes(&EvalResult::Number(0.0));
        let ledger = own_ledger(100 * one);
        let first = CallMemo::with_ledger(ledger);
        let second = CallMemo::with_ledger(ledger);
        for i in 0..90 {
            first.remember(key(&format!("a{}", i)), &EvalResult::Number(i as f64));
        }
        assert_eq!(ledger.held(), 90 * one, "the ledger counts what the first sheet holds");
        for i in 0..400 {
            second.remember(key(&format!("b{}", i)), &EvalResult::Number(i as f64));
            assert!(ledger.held() <= 100 * one + one, "after {} more answers the workbook holds {} bytes", i + 1, ledger.held());
        }
        assert_eq!(second.answer(&key("b399")), Some(EvalResult::Number(399.0)), "the newest answer is kept");
        let held_by_first = first.len() * one;
        drop(first);
        assert_eq!(ledger.held(), second.len() * one, "a dropped memo gave back its {} bytes", held_by_first);
    }

    /// rev8A minor: the WORKBOOK's budget starved a sheet. Once two sheets had
    /// filled it, every answer a third sheet filed rolled that sheet's own
    /// generation over -- it kept two answers and refused the rest -- while the
    /// big sheets never gave anything back. The sheet holding the most gives
    /// back now.
    ///
    /// SABOTAGE: `CallMemoLedger::largest_other` answers `None`.
    #[test]
    fn a_full_workbook_budget_never_starves_a_sheet_that_holds_little() {
        let one = entry_bytes(&EvalResult::Number(0.0));
        let ledger = own_ledger(100 * one);
        let first = CallMemo::with_ledger(ledger);
        let second = CallMemo::with_ledger(ledger);
        for i in 0..50 {
            first.remember(key(&format!("a{}", i)), &EvalResult::Number(i as f64));
            second.remember(key(&format!("b{}", i)), &EvalResult::Number(i as f64));
        }
        assert_eq!(ledger.held(), 100 * one, "precondition: two sheets fill the workbook's budget");
        let third = CallMemo::with_ledger(ledger);
        for i in 0..30 {
            third.remember(key(&format!("c{}", i)), &EvalResult::Number(i as f64));
            // At most the filer's own two newest answers over the budget.
            assert!(ledger.held() <= 100 * one + 2 * one, "the workbook holds {} bytes", ledger.held());
        }
        for i in 0..30 {
            assert_eq!(
                third.answer(&key(&format!("c{}", i))),
                Some(EvalResult::Number(i as f64)),
                "the third sheet lost answer {} to a budget the other two filled",
                i
            );
        }
        assert!(first.len() + second.len() < 100, "a big sheet gave back what the third one needed");
    }

    /// rev8A: a custom function's answers were never forgotten when its CODE
    /// changed. Forgetting one function's answers leaves every other
    /// function's -- and every cube call's -- alone, and keeps the name known;
    /// forgetting the function altogether makes the name unknown again.
    ///
    /// SABOTAGE: `CallKey::calls_custom_function` answers false.
    #[test]
    fn a_redefined_custom_function_forgets_its_own_answers_only() {
        let memo = CallMemo::with_ledger(own_ledger(usize::MAX));
        let mine = |n: f64| udf_call_fingerprint("myFn", &[EvalResult::Number(n)]).unwrap();
        let other = udf_call_fingerprint("OTHER", &[EvalResult::Number(4.0)]).unwrap();
        memo.remember(mine(4.0), &EvalResult::Number(40.0));
        memo.remember(mine(3.0), &EvalResult::Number(30.0));
        memo.remember(other, &EvalResult::Number(7.0));
        memo.remember(key("CUBEVALUE\u{1f}Sales"), &EvalResult::Number(175.0));
        memo.note_custom_function("MYFN");
        memo.note_custom_function("OTHER");

        memo.forget_custom_function_answers("MyFn");
        assert_eq!(memo.answer(&mine(4.0)), None, "MYFN(4) kept the old code's answer");
        assert_eq!(memo.answer(&mine(3.0)), None, "MYFN(3) kept the old code's answer");
        assert_eq!(memo.answer(&other), Some(EvalResult::Number(7.0)), "another function's answer was forgotten");
        assert_eq!(memo.answer(&key("CUBEVALUE\u{1f}Sales")), Some(EvalResult::Number(175.0)), "a cube answer was forgotten");
        assert!(memo.knows_custom_function("MYFN"), "a redefined function is still the workbook's");

        memo.forget_custom_function("other");
        assert_eq!(memo.answer(&other), None);
        assert!(!memo.knows_custom_function("OTHER"), "a function the workbook dropped is still known");
        assert!(memo.knows_custom_function("MYFN"));
    }

    #[test]
    fn a_udf_fingerprint_spells_every_argument_exactly() {
        let fp = |args: &[EvalResult]| udf_call_fingerprint("myFn", args);
        assert_eq!(fp(&[EvalResult::Number(1.0)]), udf_call_fingerprint("MYFN", &[EvalResult::Number(1.0)]));
        assert_ne!(fp(&[EvalResult::Number(1.0)]), fp(&[EvalResult::Number(2.0)]));
        assert_ne!(fp(&[EvalResult::Number(1.0)]), fp(&[EvalResult::Text("1".to_string())]));
        assert_ne!(fp(&[EvalResult::Blank]), fp(&[EvalResult::Text(String::new())]));
        assert_ne!(
            fp(&[EvalResult::Text(format!("a{}tb", KEY_SEP))]),
            fp(&[EvalResult::Text("a".to_string()), EvalResult::Text("b".to_string())]),
            "a separator inside a text cannot forge a second argument"
        );
        assert_eq!(fp(&[EvalResult::List(vec![])]), None, "a list has no exact spelling");
    }

    #[test]
    fn a_memo_call_is_found_at_any_depth() {
        let parse = |f: &str| parser::parse(f).unwrap_or_else(|e| panic!("{} did not parse: {:?}", f, e));
        assert!(is_memo_call(&parse("=MYFN(A1)")));
        assert!(is_memo_call(&parse(r#"=CUBEVALUE("Sales","[Revenue]")"#)));
        assert!(!is_memo_call(&parse("=MYFN(A1)*2")), "the root is the multiplication");
        for nested in ["=MYFN(A1)*2", r#"=IF(A1>0,{1,2}+CUBEVALUE("S","[R]"),0)"#, "=-SUM(1,MYFN(2))"] {
            assert!(contains_memo_call(&parse(nested)), "{}", nested);
        }
        assert!(!contains_memo_call(&parse("=SUM(A1:A3)+1")));
        assert!(!contains_memo_call(&parse("=LAMBDA(x,x+1)(3)")), "the LAMBDA invoker is not a memo call");
    }

    #[test]
    fn a_sheet_rebuilt_from_a_snapshot_keeps_its_results_cache() {
        // rev5B#1: an undo of a grouped structural edit rebuilt the sheet from
        // `Grid::new()`, which forgot every answer -- and the save's
        // recalculation then refused every cube and custom-function cell.
        let sheet = crate::grid::Grid::new();
        sheet.call_memo().remember(key("F"), &EvalResult::Number(225.0));
        let rebuilt = crate::grid::Grid::new_sharing_call_memo(&sheet);
        assert!(rebuilt.cells.is_empty(), "the rebuilt sheet starts with no cells");
        assert_eq!(rebuilt.call_memo().answer(&key("F")), Some(EvalResult::Number(225.0)));
        rebuilt.call_memo().remember(key("G"), &EvalResult::Number(1.0));
        assert_eq!(sheet.call_memo().answer(&key("G")), Some(EvalResult::Number(1.0)), "one cache, shared");
        assert!(crate::grid::Grid::new().call_memo().is_empty(), "a plain new sheet starts empty");
    }

    #[test]
    fn a_memo_carries_whether_its_sheets_values_may_be_stale() {
        let memo = CallMemo::default();
        assert!(!memo.values_may_be_stale(), "a new sheet's values are vouched for");
        let shared = memo.clone();
        shared.note_values_may_be_stale();
        assert!(memo.values_may_be_stale(), "a clone shares the flag");
        memo.remember(key("F"), &EvalResult::Number(1.0));
        memo.clear();
        assert!(memo.values_may_be_stale(), "forgetting the answers does not vouch for the values");
        shared.vouch_for_stored_values();
        assert!(!memo.values_may_be_stale());
    }

    #[test]
    fn what_a_formula_reads_beyond_its_references_is_found_at_any_depth() {
        let parse = |f: &str| parser::parse(f).unwrap_or_else(|e| panic!("{} did not parse: {:?}", f, e));
        for beyond in [
            "=MYFN(A1)*RAND()",
            "=MYFN(ROW())*2",
            "=IF(A1>0,MYFN(GETPIVOTDATA(\"Sales\",A1)),0)",
            "=MYFN(INDIRECT(\"A1\"))",
            "=MYFN(SUBTOTAL(9,A1:A3))+1",
            "=-MYFN(GET.CONTROLVALUE(\"Pick\"))",
            "=MYFN(FILEREAD(\"a.txt\"))",
        ] {
            assert!(reads_beyond_its_references(&parse(beyond)), "{}", beyond);
        }
        for within in ["=MYFN(A1)*2", r#"=CUBEVALUE("Sales","[Revenue]",A2)/1000"#, "=MYFN(SUM(A1:B3),Sheet2!C1)"] {
            assert!(!reads_beyond_its_references(&parse(within)), "{}", within);
        }
    }
}
