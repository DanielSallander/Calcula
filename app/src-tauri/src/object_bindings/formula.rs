//! FILENAME: app/src-tauri/src/object_bindings/formula.rs
// PURPOSE: The rules a binding FORMULA obeys before it may be stored (D §3.6):
//          locale, sheet qualification, measure references, CUBE arguments, the
//          canonical stored text, and the analysis every caller reads.
// CONTEXT: Pure. Nothing here takes an AppState lock: the caller copies what a
//          rule needs into a [`FormulaWorld`] (each lock taken and released) and
//          hands in a [`FormulaContext`] built from it. The evaluator
//          (`eval.rs`) re-runs [`prepare_stored`] over every stored row when the
//          store's generation moves; the command (S3b) runs
//          [`normalize_entered`] on what a person, a script or the AI typed.
//
// THE RULES, in the order they run:
//   0. Locale. Stored text is INVARIANT (`,` separators, `.` decimals), exactly
//      like a cell formula. A user-facing editor sends its own locale's text and
//      it is delocalised first; scripts, MCP and the AI send invariant text.
//   1. It starts with `=`, parses, and is at most 8,192 characters.
//   2. Every unqualified reference is QUALIFIED with the sheet it reads
//      ([`default_ref_sheet`]): the host sheet for an object on a worksheet; on
//      a canvas (which has no cells) the chart's data sheet for a chart, else
//      the first visible worksheet -- with a warning saying so. Every sheet name
//      is canonicalised to the workbook's own case (the lexer upper-cases bare
//      names, so `=sheet1!a1` arrives as `SHEET1!A1`); an unknown sheet is a
//      refusal, never a dangling reference.
//   3. If nothing changed, the stored text is the user's text TRIMMED (name
//      casing and spacing survive); otherwise it is re-rendered.
//   4. A table-less `[Name]` is a MEASURE of the binding's model.
//   5. A CUBE function takes literal arguments only.
//   6. The analysis flags.

use std::collections::{HashMap, HashSet};

use engine::{BuiltinFunction, Expression, LocaleSettings};
use parser::ast::TableSpecifier;

use crate::api_types::BindingFormulaAnalysis;
use crate::named_ranges::NamedRange;
use crate::tables::{TableNameRegistry, TableStorage};

/// Longest binding formula accepted, in characters.
pub const MAX_BINDING_FORMULA_CHARS: usize = 8_192;

/// Everything the rules read, borrowed. Build it with
/// [`FormulaWorld::context`].
pub struct FormulaContext<'a> {
    /// The object's sheet (a canvas for canvas objects).
    pub host_sheet_index: usize,
    /// Where an unqualified reference points (rule 2).
    pub default_ref_sheet_index: usize,
    /// The sentence a UI shows when [`Self::default_ref_sheet_index`] is a
    /// FALLBACK (an object on a canvas that is not a chart with a data sheet).
    /// Reported in the analysis only when the formula had an unqualified
    /// reference for it to apply to.
    pub default_ref_warning: Option<String>,
    pub sheet_names: &'a [String],
    pub named_ranges: &'a HashMap<String, NamedRange>,
    /// The workbook's tables, for the measure-versus-column rules (rule 4).
    pub tables: &'a TableStorage,
    pub table_names: &'a TableNameRegistry,
    /// The models on the object's page: (model key, its measures).
    pub model_measures: &'a [(String, Vec<String>)],
    /// The page's only model, when it has exactly one.
    pub default_model: Option<&'a str>,
    /// The locale the person reads formulas in (`display_normalized`).
    pub locale: &'a LocaleSettings,
}

/// A formula as it would be stored.
#[derive(Debug, Clone)]
pub struct NormalizedFormula {
    /// The stored text: invariant, sheet-qualified, canonical sheet case.
    pub text: String,
    /// The qualified AST (measure refs still `TableRef`s with an empty table).
    pub ast: Expression,
    pub analysis: BindingFormulaAnalysis,
}

/// Whether the measure rules VALIDATE (a new binding is being entered) or only
/// COLLECT the refs (a stored row is being re-prepared; its measures were
/// validated when it was set and the model metadata is async, S4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MeasureCheck {
    Validate,
    Collect,
}

/// Rule 0: what is stored is invariant. `invariant == true` (scripts, MCP, the
/// AI) takes the text as is; otherwise the person's locale is undone first --
/// the `update_cell` rule.
pub fn to_invariant(text: &str, invariant: bool, locale: &LocaleSettings) -> String {
    if invariant {
        text.to_string()
    } else {
        engine::delocalize_formula(text, locale)
    }
}

/// A stored formula as a PERSON reads it (`displayFormula`).
pub fn display_formula(stored: &str, locale: &LocaleSettings) -> String {
    engine::localize_formula(stored, locale)
}

/// The full pipeline over text a person (`invariant == false`) or a script /
/// MCP / the AI (`invariant == true`) entered.
pub fn normalize_entered(
    formula: &str,
    invariant: bool,
    cx: &FormulaContext<'_>,
    model: Option<&str>,
) -> Result<NormalizedFormula, String> {
    normalize(&to_invariant(formula, invariant, cx.locale), cx, model)
}

/// Rules 1-6 over INVARIANT text, validating measure references against
/// `cx.model_measures`.
pub fn normalize(
    formula: &str,
    cx: &FormulaContext<'_>,
    model: Option<&str>,
) -> Result<NormalizedFormula, String> {
    normalize_with(formula, cx, model, MeasureCheck::Validate)
}

/// Rules 1-6 over a STORED row: the same qualification and analysis, but
/// measure references are only collected (they were validated at `Set`).
pub fn prepare_stored(
    formula: &str,
    cx: &FormulaContext<'_>,
    model: Option<&str>,
) -> Result<NormalizedFormula, String> {
    normalize_with(formula, cx, model, MeasureCheck::Collect)
}

fn normalize_with(
    formula: &str,
    cx: &FormulaContext<'_>,
    model: Option<&str>,
    check: MeasureCheck,
) -> Result<NormalizedFormula, String> {
    // Rule 1.
    let trimmed = formula.trim();
    if !trimmed.starts_with('=') {
        return Err("A bound property's formula starts with '=' (for example =Sheet1!A1).".to_string());
    }
    if trimmed.chars().count() > MAX_BINDING_FORMULA_CHARS {
        return Err(format!(
            "A bound property's formula is at most {MAX_BINDING_FORMULA_CHARS} characters long."
        ));
    }
    let mut ast = parser::parse(trimmed).map_err(|e| format!("The formula could not be read: {e}"))?;

    // Rule 2.
    let default_sheet = cx
        .sheet_names
        .get(cx.default_ref_sheet_index)
        .cloned()
        .ok_or_else(|| "The sheet this formula would read no longer exists.".to_string())?;
    let mut q = Qualify {
        default_sheet: &default_sheet,
        sheet_names: cx.sheet_names,
        qualified_any: false,
        changed: false,
        uses: HashMap::new(),
    };
    q.walk(&mut ast)?;
    let qualified_any = q.qualified_any;
    let mut changed = q.changed || !spells_every_sheet(trimmed, &q.uses);

    // Rule 4.
    let mut measure_names: Vec<String> = Vec::new();
    collect_measure_refs(&ast, &mut measure_names)?;
    let mut chosen_model: Option<String> = model.map(str::to_string);
    if !measure_names.is_empty() && check == MeasureCheck::Validate {
        let (model_key, measures) = choose_model(cx, model, &measure_names[0])?;
        let mut renames: HashMap<String, String> = HashMap::new();
        for name in &measure_names {
            let canonical = validate_measure(cx, model_key, measures, name)?;
            if canonical != *name {
                renames.insert(name.clone(), canonical);
            }
        }
        if !renames.is_empty() {
            rename_measure_refs(&mut ast, &renames);
            changed = true;
            measure_names.clear();
            collect_measure_refs(&ast, &mut measure_names)?;
        }
        chosen_model = Some(model_key.to_string());
    }

    // Rule 5.
    check_cube_arguments(&ast)?;

    // Rule 3.
    let text = if changed {
        crate::name_resolution::restamp_name_casing(&mut ast, cx.named_ranges);
        crate::table_deps::restamp_table_casing(&mut ast, cx.tables, cx.table_names);
        format!("={}", crate::expression_to_formula(&ast))
    } else {
        trimmed.to_string()
    };

    // Rule 6.
    let mut analysis = analyze(&ast, cx);
    analysis.normalized = text.clone();
    analysis.display_normalized = display_formula(&text, cx.locale);
    analysis.measure_refs = dedup_keep_order(measure_names);
    analysis.model = if analysis.measure_refs.is_empty() { None } else { chosen_model };
    analysis.warning = if qualified_any { cx.default_ref_warning.clone() } else { None };

    Ok(NormalizedFormula { text, ast, analysis })
}

// ---------------------------------------------------------------------------
// Rule 2: the sheet an unqualified reference reads
// ---------------------------------------------------------------------------

/// The workbook's sheets as the qualification rule reads them.
pub struct SheetFacts<'a> {
    pub names: &'a [String],
    pub kinds: &'a [::persistence::SheetKind],
    /// "visible" / "hidden" / "veryHidden" per sheet; a missing entry is visible.
    pub visibility: &'a [String],
}

impl SheetFacts<'_> {
    fn is_canvas(&self, index: usize) -> bool {
        self.kinds.get(index).is_some_and(|k| k.is_canvas())
    }

    fn is_visible(&self, index: usize) -> bool {
        self.visibility.get(index).map_or(true, |v| v == "visible")
    }
}

/// Where an unqualified reference of an object on `host` points, and the
/// warning a UI shows when that is a fallback.
///
/// - an object on a WORKSHEET: that worksheet, no warning;
/// - a CHART on a canvas whose own data source names a worksheet: that sheet
///   (the `specReferenceSheet` rule of `dataSourceResolver.ts`), no warning;
/// - anything else on a canvas: the first visible worksheet (else the first
///   worksheet), with a warning -- the page itself has no cells.
pub fn default_ref_sheet(
    host: usize,
    chart_data_sheet: Option<usize>,
    sheets: &SheetFacts<'_>,
) -> Result<(usize, Option<String>), String> {
    if host < sheets.names.len() && !sheets.is_canvas(host) {
        return Ok((host, None));
    }
    if let Some(data) = chart_data_sheet {
        if data < sheets.names.len() && !sheets.is_canvas(data) {
            return Ok((data, None));
        }
    }
    let worksheets: Vec<usize> = (0..sheets.names.len()).filter(|i| !sheets.is_canvas(*i)).collect();
    let target = worksheets
        .iter()
        .copied()
        .find(|i| sheets.is_visible(*i))
        .or_else(|| worksheets.first().copied())
        .ok_or_else(|| {
            "This workbook has no worksheet, so a reference such as A1 has no cells to read.".to_string()
        })?;
    let name = &sheets.names[target];
    Ok((
        target,
        Some(format!(
            "A canvas page has no cells, so an unqualified reference reads '{name}': A1 means {}!A1.",
            quote_sheet(name)
        )),
    ))
}

/// The sheet a chart's OWN data source names (`spec.data` of the definition
/// envelope, or of a bare spec), as an index into `names`. `None` for a
/// design-query / pivot / unqualified source, or a sheet that no longer exists.
pub fn chart_data_sheet(
    spec_json: &str,
    names: &[String],
    ids: &[identity::SheetId],
) -> Option<usize> {
    let value: serde_json::Value = serde_json::from_str(spec_json).ok()?;
    let inner = match value.get("spec") {
        Some(spec) if spec.is_object() => spec,
        _ => &value,
    };
    let data = inner.get("data")?;
    let only_data = serde_json::json!({ "data": data });
    match calp::chart_refs::chart_spec_source_sheets(&only_data).into_iter().next()? {
        calp::chart_refs::ChartSourceSheet::Id(id) => ids.iter().position(|s| *s == id),
        calp::chart_refs::ChartSourceSheet::Index(i) => (i < names.len()).then_some(i),
        calp::chart_refs::ChartSourceSheet::Name(n) => names.iter().position(|s| s.eq_ignore_ascii_case(&n)),
    }
}

/// True when `text` spells every named sheet in the workbook's own case as
/// often as the formula names it (`=sheet1!A1` does not; `=Sheet1!A1` does).
/// A case-sensitive substring count: a string literal that happens to hold the
/// name can only make a respelling LOOK unnecessary, never alter a reference.
fn spells_every_sheet(text: &str, uses: &HashMap<String, usize>) -> bool {
    uses.iter().all(|(name, n)| text.matches(name.as_str()).count() >= *n)
}

/// A sheet name as a reference prefix spells it.
fn quote_sheet(name: &str) -> String {
    if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !name.starts_with(|c: char| c.is_ascii_digit()) {
        name.to_string()
    } else {
        format!("'{}'", name.replace('\'', "''"))
    }
}

/// The qualification walk (rule 2). A `Range` carries its sheet on the range
/// node -- its two corner `CellRef`s have none and must keep none -- and a
/// `Sheet3DRef`'s inner reference is positional, so neither is descended into
/// for qualification.
struct Qualify<'a> {
    default_sheet: &'a str,
    sheet_names: &'a [String],
    qualified_any: bool,
    changed: bool,
    /// Canonical sheet name -> how many references name it. The lexer
    /// upper-cases a BARE sheet name, so the AST cannot say whether the person
    /// typed `Inputs!` or `inputs!`; [`spells_every_sheet`] asks the text.
    uses: HashMap<String, usize>,
}

impl Qualify<'_> {
    fn canonical(&self, name: &str) -> Result<String, String> {
        self.sheet_names
            .iter()
            .find(|s| s.eq_ignore_ascii_case(name))
            .cloned()
            .ok_or_else(|| format!("There is no sheet named '{name}' in this workbook."))
    }

    fn fix(&mut self, sheet: &mut Option<String>) -> Result<(), String> {
        match sheet {
            None => {
                *sheet = Some(self.default_sheet.to_string());
                self.qualified_any = true;
                self.changed = true;
            }
            // The Calcula all-sheets wildcard: `'*'!A1`. Not a sheet name.
            Some(s) if s == "*" => {}
            Some(s) => self.canonicalise(s)?,
        }
        Ok(())
    }

    /// Respell a named sheet in the workbook's own case and count the use.
    /// Not a CHANGE by itself: whether the text already spells it so is
    /// decided against the text afterwards.
    fn canonicalise(&mut self, name: &mut String) -> Result<(), String> {
        let canonical = self.canonical(name)?;
        *self.uses.entry(canonical.clone()).or_insert(0) += 1;
        *name = canonical;
        Ok(())
    }

    fn walk(&mut self, expr: &mut Expression) -> Result<(), String> {
        match expr {
            Expression::CellRef { sheet, .. }
            | Expression::ColumnRef { sheet, .. }
            | Expression::RowRef { sheet, .. } => self.fix(sheet),
            Expression::Range { sheet, start, end, .. } => {
                self.fix(sheet)?;
                // Corners are CellRefs that carry no sheet; anything else (a
                // function returning a reference) is an ordinary expression.
                for corner in [start.as_mut(), end.as_mut()] {
                    if !matches!(corner, Expression::CellRef { .. }) {
                        self.walk(corner)?;
                    }
                }
                Ok(())
            }
            Expression::Sheet3DRef { start_sheet, end_sheet, .. } => {
                self.canonicalise(start_sheet)?;
                self.canonicalise(end_sheet)
            }
            Expression::BinaryOp { left, right, .. } => {
                self.walk(left)?;
                self.walk(right)
            }
            Expression::UnaryOp { operand, .. } => self.walk(operand),
            Expression::FunctionCall { args, .. } => {
                for a in args {
                    self.walk(a)?;
                }
                Ok(())
            }
            Expression::IndexAccess { target, index } => {
                self.walk(target)?;
                self.walk(index)
            }
            Expression::ArrayLiteral { rows } => {
                for e in rows.iter_mut().flatten() {
                    self.walk(e)?;
                }
                Ok(())
            }
            Expression::ListLiteral { elements } => {
                for e in elements {
                    self.walk(e)?;
                }
                Ok(())
            }
            Expression::DictLiteral { entries } => {
                for (k, v) in entries {
                    self.walk(k)?;
                    self.walk(v)?;
                }
                Ok(())
            }
            Expression::SpillRef { cell, .. } => self.walk(cell),
            Expression::ImplicitIntersection { operand } => self.walk(operand),
            Expression::Literal(_) | Expression::NamedRef { .. } | Expression::TableRef { .. } => Ok(()),
        }
    }
}

/// A stored formula that a sheet RENAME or DELETE repair re-rendered
/// (`calp::sheet_renames`, `repair_formula_text_on_delete_at`), with every
/// sheet it names spelled in the workbook's own case again (rule 2's promise
/// for stored text). The engine's lexer upper-cases a BARE sheet name, so the
/// re-render turns an untouched `Data!A1` beside the repaired reference into
/// `DATA!A1`. `None` when the text already spells every sheet so, does not
/// parse, has an unqualified reference, or names a sheet the workbook does not
/// have -- it is then left exactly as the repair wrote it.
pub fn respell_sheet_case(text: &str, sheet_names: &[String]) -> Option<String> {
    let trimmed = text.trim();
    if !trimmed.starts_with('=') {
        return None;
    }
    let mut ast = parser::parse(trimmed).ok()?;
    let mut q = Qualify { default_sheet: "", sheet_names, qualified_any: false, changed: false, uses: HashMap::new() };
    q.walk(&mut ast).ok()?;
    if q.qualified_any || spells_every_sheet(trimmed, &q.uses) {
        return None;
    }
    Some(format!("={}", crate::expression_to_formula(&ast)))
}

// ---------------------------------------------------------------------------
// Rule 4: measure references
// ---------------------------------------------------------------------------

/// Visit every child expression of `expr` (one level).
fn children(expr: &Expression) -> Vec<&Expression> {
    match expr {
        Expression::Range { start, end, .. } => vec![start.as_ref(), end.as_ref()],
        Expression::Sheet3DRef { reference, .. } => vec![reference.as_ref()],
        Expression::BinaryOp { left, right, .. } => vec![left.as_ref(), right.as_ref()],
        Expression::UnaryOp { operand, .. } => vec![operand.as_ref()],
        Expression::FunctionCall { args, .. } => args.iter().collect(),
        Expression::IndexAccess { target, index } => vec![target.as_ref(), index.as_ref()],
        Expression::ArrayLiteral { rows } => rows.iter().flatten().collect(),
        Expression::ListLiteral { elements } => elements.iter().collect(),
        Expression::DictLiteral { entries } => entries.iter().flat_map(|(k, v)| [k, v]).collect(),
        Expression::SpillRef { cell, .. } => vec![cell.as_ref()],
        Expression::ImplicitIntersection { operand } => vec![operand.as_ref()],
        Expression::Literal(_)
        | Expression::CellRef { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. }
        | Expression::NamedRef { .. }
        | Expression::TableRef { .. } => Vec::new(),
    }
}

/// Mutable twin of [`children`].
fn children_mut(expr: &mut Expression) -> Vec<&mut Expression> {
    match expr {
        Expression::Range { start, end, .. } => vec![start.as_mut(), end.as_mut()],
        Expression::Sheet3DRef { reference, .. } => vec![reference.as_mut()],
        Expression::BinaryOp { left, right, .. } => vec![left.as_mut(), right.as_mut()],
        Expression::UnaryOp { operand, .. } => vec![operand.as_mut()],
        Expression::FunctionCall { args, .. } => args.iter_mut().collect(),
        Expression::IndexAccess { target, index } => vec![target.as_mut(), index.as_mut()],
        Expression::ArrayLiteral { rows } => rows.iter_mut().flatten().collect(),
        Expression::ListLiteral { elements } => elements.iter_mut().collect(),
        Expression::DictLiteral { entries } => {
            let mut out: Vec<&mut Expression> = Vec::new();
            for (k, v) in entries.iter_mut() {
                out.push(k);
                out.push(v);
            }
            out
        }
        Expression::SpillRef { cell, .. } => vec![cell.as_mut()],
        Expression::ImplicitIntersection { operand } => vec![operand.as_mut()],
        Expression::Literal(_)
        | Expression::CellRef { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. }
        | Expression::NamedRef { .. }
        | Expression::TableRef { .. } => Vec::new(),
    }
}

/// The measure a table-less `[Name]` names, or `None` for any other node.
pub fn measure_ref_name(expr: &Expression) -> Option<&str> {
    match expr {
        Expression::TableRef { table_name, specifier: TableSpecifier::Column(name), .. }
            if table_name.is_empty() =>
        {
            Some(name.as_str())
        }
        _ => None,
    }
}

/// Every measure ref in walk order (duplicates kept), or the refusal for a
/// table-less structured reference that is not a plain `[Name]`.
fn collect_measure_refs(expr: &Expression, out: &mut Vec<String>) -> Result<(), String> {
    if let Expression::TableRef { table_name, specifier, .. } = expr {
        if table_name.is_empty() {
            return match specifier {
                TableSpecifier::Column(name) => {
                    out.push(name.clone());
                    Ok(())
                }
                TableSpecifier::ThisRow(name) | TableSpecifier::ThisRowRange(name, _) => Err(format!(
                    "'[@{name}]' names a table row, and a bound property has no row. Write [Measure] for a model measure or Table1[Column] for a table column."
                )),
                _ => Err(
                    "A structured reference in a bound property must name its table (Table1[Column]); only a model measure is written [Measure] on its own."
                        .to_string(),
                ),
            };
        }
        return Ok(());
    }
    for child in children(expr) {
        collect_measure_refs(child, out)?;
    }
    Ok(())
}

fn rename_measure_refs(expr: &mut Expression, renames: &HashMap<String, String>) {
    if let Expression::TableRef { table_name, specifier: TableSpecifier::Column(name), .. } = expr {
        if table_name.is_empty() {
            if let Some(canonical) = renames.get(name.as_str()) {
                *name = canonical.clone();
            }
        }
        return;
    }
    for child in children_mut(expr) {
        rename_measure_refs(child, renames);
    }
}

/// The model a binding's measures are read from: the explicit `model`, else
/// the page's only model, else the only model offered; otherwise a refusal
/// listing them.
fn choose_model<'c>(
    cx: &'c FormulaContext<'_>,
    model: Option<&str>,
    first_measure: &str,
) -> Result<(&'c str, &'c [String]), String> {
    let find = |key: &str| {
        cx.model_measures
            .iter()
            .find(|(k, _)| k == key)
            .map(|(k, m)| (k.as_str(), m.as_slice()))
    };
    if let Some(key) = model {
        return find(key).ok_or_else(|| {
            format!("The model '{key}' is not connected to this workbook, so [{first_measure}] cannot be read from it.")
        });
    }
    if let Some(key) = cx.default_model {
        if let Some(found) = find(key) {
            return Ok(found);
        }
    }
    match cx.model_measures {
        [] => Err(format!(
            "[{first_measure}] names a model measure, but no data model is connected to this page."
        )),
        [(k, m)] => Ok((k.as_str(), m.as_slice())),
        many => {
            let keys: Vec<&str> = many.iter().map(|(k, _)| k.as_str()).collect();
            Err(format!(
                "This page uses {} models ({}); say which one: model \"{}\".",
                many.len(),
                keys.join(", "),
                keys[0]
            ))
        }
    }
}

/// Tables that have a column called `name` (case-insensitive), as
/// (table name, sheet index), sorted by table name.
fn tables_with_column(tables: &TableStorage, name: &str) -> Vec<(String, usize)> {
    let mut out: Vec<(String, usize)> = tables
        .values()
        .flat_map(|by_id| by_id.values())
        .filter(|t| t.columns.iter().any(|c| c.name.eq_ignore_ascii_case(name)))
        .map(|t| (t.name.clone(), t.sheet_index))
        .collect();
    out.sort();
    out
}

/// The canonical spelling of measure `name` in `model`, or why it cannot be
/// one.
fn validate_measure(
    cx: &FormulaContext<'_>,
    model: &str,
    measures: &[String],
    name: &str,
) -> Result<String, String> {
    let columns = tables_with_column(cx.tables, name);
    match measures.iter().find(|m| m.eq_ignore_ascii_case(name)) {
        Some(canonical) => {
            if let Some((table, _)) = columns.iter().find(|(_, sheet)| *sheet == cx.host_sheet_index) {
                return Err(format!(
                    "[{name}] is both a measure of model '{model}' and a column of table {table} on this sheet. Write {table}[{name}] for the column, or rename one of them to bind the measure."
                ));
            }
            Ok(canonical.clone())
        }
        None => {
            if let Some((table, _)) = columns.first() {
                return Err(format!(
                    "Write {table}[{name}] for the table column; [{name}] in a bound property names a model measure."
                ));
            }
            let listed = if measures.is_empty() {
                "it has none".to_string()
            } else {
                measures.join(", ")
            };
            Err(format!("There is no measure [{name}] in model '{model}'. Its measures: {listed}."))
        }
    }
}

// ---------------------------------------------------------------------------
// Rule 5: CUBE arguments
// ---------------------------------------------------------------------------

pub fn is_cube_function(func: &BuiltinFunction) -> bool {
    matches!(
        func,
        BuiltinFunction::CubeValue
            | BuiltinFunction::CubeMember
            | BuiltinFunction::CubeSet
            | BuiltinFunction::CubeSetCount
            | BuiltinFunction::CubeRankedMember
            | BuiltinFunction::CubeMemberProperty
            | BuiltinFunction::CubeKpiMember
    )
}

/// True when `expr` reads no reference at all (literals combined by operators
/// and functions -- `"[Date].[" & "2024]"`, a nested literal CUBEMEMBER).
fn literal_only(expr: &Expression) -> bool {
    match expr {
        Expression::Literal(_) => true,
        Expression::BinaryOp { left, right, .. } => literal_only(left) && literal_only(right),
        Expression::UnaryOp { operand, .. } => literal_only(operand),
        Expression::FunctionCall { args, .. } => args.iter().all(literal_only),
        _ => false,
    }
}

fn check_cube_arguments(expr: &Expression) -> Result<(), String> {
    if let Expression::FunctionCall { func, args, .. } = expr {
        if is_cube_function(func) && !args.iter().all(literal_only) {
            return Err(
                "A CUBE function in a bound property takes text arguments; use [Measure] instead.".to_string(),
            );
        }
    }
    for child in children(expr) {
        check_cube_arguments(child)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Rule 6: analysis
// ---------------------------------------------------------------------------

fn is_reference(expr: &Expression) -> bool {
    matches!(
        expr,
        Expression::CellRef { .. }
            | Expression::Range { .. }
            | Expression::ColumnRef { .. }
            | Expression::RowRef { .. }
            | Expression::Sheet3DRef { .. }
            | Expression::NamedRef { .. }
            | Expression::TableRef { .. }
            | Expression::SpillRef { .. }
    )
}

/// True when the function reads cells it does not name in the formula text:
/// INDIRECT, OFFSET over a computed start, GET.CONTROLVALUE, GETPIVOTDATA.
pub fn is_indirect_call(func: &BuiltinFunction, args: &[Expression]) -> bool {
    match func {
        BuiltinFunction::Indirect | BuiltinFunction::GetControlValue | BuiltinFunction::GetPivotData => true,
        BuiltinFunction::Offset => args.first().map_or(true, |a| !is_reference(a)),
        _ => false,
    }
}

/// Names in FUNCTION position (`=MyLambda(1)` or a JS UDF): a name only when the
/// workbook defines it.
fn function_position_names(expr: &Expression, out: &mut HashSet<String>) {
    if let Expression::FunctionCall { func, .. } = expr {
        if let Some(name) = func.user_definable_name() {
            out.insert(name.to_uppercase());
        }
    }
    for child in children(expr) {
        function_position_names(child, out);
    }
}

#[derive(Default)]
struct Flags {
    sheets: HashSet<usize>,
    uses_table_refs: bool,
    uses_indirect: bool,
    uses_cube: bool,
}

fn sheet_index(names: &[String], name: &str) -> Option<usize> {
    names.iter().position(|s| s.eq_ignore_ascii_case(name))
}

/// The Calcula all-sheets wildcard (`'*'!A1`), which the evaluator expands to a
/// 3D reference over EVERY sheet (`expand_wildcard_sheets`).
pub fn is_all_sheets_wildcard(name: &str) -> bool {
    name == "*"
}

fn flag_walk(expr: &Expression, names: &[String], flags: &mut Flags) {
    match expr {
        Expression::CellRef { sheet: Some(s), .. }
        | Expression::ColumnRef { sheet: Some(s), .. }
        | Expression::RowRef { sheet: Some(s), .. }
        | Expression::Range { sheet: Some(s), .. } => {
            if is_all_sheets_wildcard(s) {
                // `'*'!A1` reads A1 of EVERY sheet: the analysis says so, or the
                // restricted clamp (TS executor and the Rust re-check), which
                // decides from `sheets`, would let a script read every sheet
                // through a reference that names none.
                flags.sheets.extend(0..names.len());
            } else if let Some(i) = sheet_index(names, s) {
                flags.sheets.insert(i);
            }
        }
        Expression::Sheet3DRef { start_sheet, end_sheet, .. } => {
            if is_all_sheets_wildcard(start_sheet) || is_all_sheets_wildcard(end_sheet) {
                flags.sheets.extend(0..names.len());
            } else if let (Some(a), Some(b)) = (sheet_index(names, start_sheet), sheet_index(names, end_sheet)) {
                for i in a.min(b)..=a.max(b) {
                    flags.sheets.insert(i);
                }
            }
        }
        Expression::TableRef { table_name, .. } if !table_name.is_empty() => flags.uses_table_refs = true,
        Expression::FunctionCall { func, args, .. } => {
            if is_cube_function(func) {
                flags.uses_cube = true;
            }
            if is_indirect_call(func, args) {
                flags.uses_indirect = true;
            }
        }
        _ => {}
    }
    for child in children(expr) {
        flag_walk(child, names, flags);
    }
}

/// The analysis of a qualified AST (the text fields are filled by the caller).
fn analyze(ast: &Expression, cx: &FormulaContext<'_>) -> BindingFormulaAnalysis {
    let mut flags = Flags::default();
    flag_walk(ast, cx.sheet_names, &mut flags);
    let mut names = HashSet::new();
    crate::name_resolution::collect_names(ast, &mut names);
    let mut fn_names = HashSet::new();
    function_position_names(ast, &mut fn_names);
    // A name counts when it is DEFINED, or when it stands in a value position
    // (an undefined `=Rate` is a #NAME? waiting for its definition); a JS UDF
    // call in function position that the workbook does not define is not one.
    let uses_names = names
        .iter()
        .any(|n| cx.named_ranges.contains_key(n) || !fn_names.contains(n));
    let mut sheets: Vec<usize> = flags.sheets.into_iter().collect();
    sheets.sort_unstable();
    BindingFormulaAnalysis {
        normalized: String::new(),
        display_normalized: String::new(),
        sheets,
        uses_names,
        uses_table_refs: flags.uses_table_refs,
        uses_indirect: flags.uses_indirect,
        uses_cube: flags.uses_cube,
        measure_refs: Vec::new(),
        model: None,
        error: None,
        warning: None,
    }
}

fn dedup_keep_order(names: Vec<String>) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    names
        .into_iter()
        .filter(|n| seen.insert(n.to_uppercase()))
        .collect()
}

// ---------------------------------------------------------------------------
// The copied world a context is built from
// ---------------------------------------------------------------------------

/// Everything the formula rules read, COPIED out of AppState with each lock
/// taken and released in turn (sheet table first, then the naming
/// authorities). Holds no guard, so it may be built and kept anywhere.
pub struct FormulaWorld {
    pub sheet_names: Vec<String>,
    pub sheet_ids: Vec<identity::SheetId>,
    pub sheet_kinds: Vec<::persistence::SheetKind>,
    pub sheet_visibility: Vec<String>,
    pub named_ranges: HashMap<String, NamedRange>,
    pub tables: TableStorage,
    pub table_names: TableNameRegistry,
    pub locale: LocaleSettings,
}

impl FormulaWorld {
    pub fn read(state: &crate::AppState) -> FormulaWorld {
        let sheet_names = state.sheet_names.read().map(|g| g.clone()).unwrap_or_default();
        let sheet_ids = state.sheet_ids.read().map(|g| g.clone()).unwrap_or_default();
        let sheet_kinds = state.sheet_kinds.read().map(|g| g.clone()).unwrap_or_default();
        let sheet_visibility = state.sheet_visibility.read().map(|g| g.clone()).unwrap_or_default();
        let tables = state.tables.read().map(|g| g.clone()).unwrap_or_default();
        let table_names = state.table_names.read().map(|g| g.clone()).unwrap_or_default();
        let named_ranges = state.named_ranges.read().map(|g| g.clone()).unwrap_or_default();
        let locale = state.locale.lock().map(|g| g.clone()).unwrap_or_else(|_| LocaleSettings::invariant());
        FormulaWorld { sheet_names, sheet_ids, sheet_kinds, sheet_visibility, named_ranges, tables, table_names, locale }
    }

    pub fn sheets(&self) -> SheetFacts<'_> {
        SheetFacts { names: &self.sheet_names, kinds: &self.sheet_kinds, visibility: &self.sheet_visibility }
    }

    /// The context for an object on `host`, whose chart data sheet (for a
    /// chart) is `chart_data_sheet`.
    pub fn context<'a>(
        &'a self,
        host: usize,
        chart_data_sheet: Option<usize>,
        model_measures: &'a [(String, Vec<String>)],
        default_model: Option<&'a str>,
    ) -> Result<FormulaContext<'a>, String> {
        let (default_ref_sheet_index, default_ref_warning) =
            default_ref_sheet(host, chart_data_sheet, &self.sheets())?;
        Ok(FormulaContext {
            host_sheet_index: host,
            default_ref_sheet_index,
            default_ref_warning,
            sheet_names: &self.sheet_names,
            named_ranges: &self.named_ranges,
            tables: &self.tables,
            table_names: &self.table_names,
            model_measures,
            default_model,
            locale: &self.locale,
        })
    }
}
