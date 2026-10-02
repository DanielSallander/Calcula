//! FILENAME: core/calp/src/sheet_renames.rs
//! PURPOSE: Rewrite the sheet NAMES that pulled content refers to, all at once
//! (BUG-0151).
//! CONTEXT: A pull resolves a name collision by renaming the INCOMING sheet
//! ("Data" arrives as "Data (2)", `pull::resolve_sheet_name_collisions`). Every
//! reference inside the application that names a sheet does so by NAME -- a
//! formula's `Data!A1`, a defined name's `refers_to`, a chart's string source
//! `"Data!A1:B5"` -- so after the rename each of them read the SUBSCRIBER's own
//! "Data", silently. A refresh has the same problem for every sheet whose local
//! name differs from the publisher's (a collision on subscribe, or a rename by
//! the subscriber since).
//!
//! # Why SIMULTANEOUS
//!
//! The renames of one pull form a map, and a map can chain: a subscriber who
//! owns "A" pulling an application with "A" and "A (2)" gets
//! `{A -> "A (2)", "A (2)" -> "A (2) (2)"}`. Applying those as a sequence of
//! pairwise renames sends a reference to the publisher's "A" through BOTH steps
//! and it lands on "A (2) (2)" -- the wrong sheet. Each reference here is looked
//! up in the map ONCE, so every name moves exactly one step.
//!
//! # What is NOT rewritten
//!
//! Text inside a string literal (`INDIRECT("Data!A1")`): Excel does not rewrite
//! it on a rename either, and a string is data, not a reference.
//!
//! Matching is case-insensitive (the lexer upper-cases a bare sheet name, and
//! every sheet-name comparison in the product ignores case); the replacement is
//! written with the target's own spelling, quoted by the one renderer.
//!
//! # A sheet that is GONE
//!
//! A refresh can carry a reference to an application sheet that has no
//! counterpart here at all -- the subscriber detached their copy and then
//! deleted it. Leaving such a reference in the publisher's spelling is the
//! failure this module exists to prevent: in THIS workbook that name may be the
//! subscriber's own sheet, and an honest `#REF!` would silently turn into a
//! number. A gone sheet's references become `#REF!`, the answer the sheet's
//! deletion gave them.
//!
//! # Spelling is not an edit
//!
//! The rewrite re-renders every formula it touches, and the renderer is not
//! the identity on stored text: the lexer upper-cases a bare sheet name
//! (`Data!A1` is stored `DATA!A1`), so a checkout rename and the push's undo
//! of it bring an untouched `DATA!A1*2` back as `Data!A1*2`. The same formula,
//! and nothing may report it as a change -- [`same_formula_text`] is the one
//! comparison for that.

use std::collections::{HashMap, HashSet};

use engine::Expression;

/// A set of sheet renames applied in ONE step. See the module header.
#[derive(Debug, Clone, Default)]
pub struct SheetRenames {
    /// UPPERCASED old name -> new name (the target's own spelling).
    by_upper: HashMap<String, String>,
    /// UPPERCASED names of sheets with NO counterpart here: every reference to
    /// one becomes `#REF!` (see "A sheet that is GONE" above). Disjoint from
    /// `by_upper` by construction.
    gone: HashSet<String>,
}

/// What one sheet-qualified reference becomes.
enum SlotEdit {
    /// Left as it was.
    Keep,
    /// Its sheet name was rewritten in place.
    Changed,
    /// Its sheet does not exist here: the whole reference becomes `#REF!`.
    Gone,
}

/// The `#REF!` error literal a gone reference is replaced by.
fn ref_error() -> Expression {
    Expression::Literal(engine::Value::Error("#REF!".to_string()))
}

fn is_ref_error(expr: &Expression) -> bool {
    matches!(expr, Expression::Literal(engine::Value::Error(e)) if e == "#REF!")
}

/// Call `f` on every sheet name a reference in `expr` carries, and apply its
/// answer. True when anything changed.
///
/// EXHAUSTIVE on purpose -- no `_` arm. A new reference-bearing node must be
/// decided here, not silently skipped (the sheet-rename repair in the host
/// falls through to "leaf" for every node it does not name, which is how
/// `@Data!A1:A9` and `Data!A1#` escape a rename there). Both the rename and
/// the spelling-blind comparison walk through here, so they cannot disagree
/// about which names a formula carries.
fn walk_sheet_slots(expr: &mut Expression, f: &mut dyn FnMut(&mut String) -> SlotEdit) -> bool {
    let gone = match expr {
        Expression::Literal(_) | Expression::NamedRef { .. } | Expression::TableRef { .. } => {
            return false
        }
        Expression::CellRef { sheet, .. }
        | Expression::ColumnRef { sheet, .. }
        | Expression::RowRef { sheet, .. } => match sheet.as_mut().map(|s| f(s)) {
            None | Some(SlotEdit::Keep) => return false,
            Some(SlotEdit::Changed) => return true,
            Some(SlotEdit::Gone) => true,
        },
        Expression::Range { sheet, start, end, .. } => {
            match sheet.as_mut().map(|s| f(s)).unwrap_or(SlotEdit::Keep) {
                SlotEdit::Gone => true,
                own => {
                    let mut changed = matches!(own, SlotEdit::Changed);
                    changed |= walk_sheet_slots(start, f);
                    changed |= walk_sheet_slots(end, f);
                    return changed;
                }
            }
        }
        Expression::Sheet3DRef { start_sheet, end_sheet, reference, .. } => {
            let first = f(start_sheet);
            let last = f(end_sheet);
            if matches!(first, SlotEdit::Gone) || matches!(last, SlotEdit::Gone) {
                true
            } else {
                let mut changed = matches!(first, SlotEdit::Changed) | matches!(last, SlotEdit::Changed);
                changed |= walk_sheet_slots(reference, f);
                return changed;
            }
        }
        Expression::BinaryOp { left, right, .. } => {
            let l = walk_sheet_slots(left, f);
            let r = walk_sheet_slots(right, f);
            return l | r;
        }
        Expression::UnaryOp { operand, .. } => return walk_sheet_slots(operand, f),
        Expression::FunctionCall { args, .. } => {
            let mut changed = false;
            for a in args.iter_mut() {
                changed |= walk_sheet_slots(a, f);
            }
            return changed;
        }
        Expression::IndexAccess { target, index } => {
            let t = walk_sheet_slots(target, f);
            let i = walk_sheet_slots(index, f);
            return t | i;
        }
        Expression::ArrayLiteral { rows } => {
            let mut changed = false;
            for row in rows.iter_mut() {
                for e in row.iter_mut() {
                    changed |= walk_sheet_slots(e, f);
                }
            }
            return changed;
        }
        Expression::ListLiteral { elements } => {
            let mut changed = false;
            for e in elements.iter_mut() {
                changed |= walk_sheet_slots(e, f);
            }
            return changed;
        }
        Expression::DictLiteral { entries } => {
            let mut changed = false;
            for (k, v) in entries.iter_mut() {
                changed |= walk_sheet_slots(k, f);
                changed |= walk_sheet_slots(v, f);
            }
            return changed;
        }
        // A spill (`Data!A1#`) and an implicit intersection (`@Data!A1:A9`)
        // WRAP a reference; when that reference is gone the wrapper goes with
        // it, because `#REF!#` and `@#REF!` are not formulas.
        Expression::SpillRef { cell, .. } => {
            let changed = walk_sheet_slots(cell, f);
            if !(changed && is_ref_error(cell)) {
                return changed;
            }
            true
        }
        Expression::ImplicitIntersection { operand } => {
            let changed = walk_sheet_slots(operand, f);
            if !(changed && is_ref_error(operand)) {
                return changed;
            }
            true
        }
    };
    if gone {
        *expr = ref_error();
    }
    gone
}

/// A formula text with every sheet name upper-cased, as the renderer writes
/// it: the form two spellings of the same formula share. `None` when the text
/// does not parse.
fn comparable_formula(text: &str) -> Option<String> {
    let mut ast = *engine::Cell::new_formula(text.to_string()).ast?;
    walk_sheet_slots(&mut ast, &mut |name| {
        let upper = name.to_uppercase();
        if upper == *name {
            SlotEdit::Keep
        } else {
            *name = upper;
            SlotEdit::Changed
        }
    });
    Some(engine::ast_render::render_formula_raw(&ast))
}

/// Are these two formula texts the SAME formula, spelled differently?
///
/// THE ONE COMPARISON across a rename boundary (see "Spelling is not an edit"
/// in the module header). A checkout renames an application's references to
/// this workbook's names and a push renames them back; the renderer spells
/// the result its own way (`DATA!A1*2` returns as `Data!A1*2`, a quoted
/// `'Data'!A1` as `Data!A1`). The version diff, the merge analysis, the
/// subscriber's "View changes" and a refresh's override check all compare
/// formulas that may have crossed such a boundary, and each used to read the
/// re-spelling as an edit: a push of an untouched working copy listed every
/// reference to a collision-renamed sheet as changed, shipped it, and
/// conflicted with a teammate's edit of the same cell.
///
/// Sheet-name case, sheet-name quoting, whitespace and a leading `=` are
/// spelling; everything else -- including the case of a string literal -- is
/// the formula. Texts that differ in more than spelling are rejected without a
/// parse, so the diff pays for two parses only on a genuine re-spelling.
pub fn same_formula_text(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    fn loose(text: &str) -> impl Iterator<Item = char> + '_ {
        text.chars()
            .filter(|c| *c != '\'' && *c != '=' && !c.is_whitespace())
            .flat_map(char::to_uppercase)
    }
    // A NECESSARY condition: every spelling difference above survives it.
    if !loose(a).eq(loose(b)) {
        return false;
    }
    match (comparable_formula(a), comparable_formula(b)) {
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

/// An A1 reference string (`"Data!A1:B5"`, a chart's string source) in the
/// form two spellings of the same reference share: its sheet name
/// upper-cased and quoted by the one renderer, the remainder upper-cased
/// (`$a$1` and `$A$1` are one cell). A string with no sheet prefix -- an
/// unqualified range or a defined name -- is returned as it was.
pub fn comparable_reference(reference: &str) -> String {
    match crate::publish::split_sheet_reference(reference) {
        Some((name, rest)) if !name.is_empty() => format!(
            "{}!{}",
            engine::ast_render::quote_sheet_name(&name.to_uppercase()),
            rest.trim().to_uppercase()
        ),
        _ => reference.to_string(),
    }
}

/// How many references one [`SheetRenames::rename_pull`] rewrote, by kind.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RenameCounts {
    pub cell_formulas: usize,
    pub named_ranges: usize,
    pub charts: usize,
    /// Formulas inside conditional-formatting rules.
    pub conditional_formats: usize,
    /// Formulas inside data-validation rules.
    pub data_validations: usize,
    /// Formula-valued properties of cell-anchored controls.
    pub controls: usize,
    /// Cell-range sources of pane-control dropdowns.
    pub pane_controls: usize,
    /// Formulas of slicers' computed properties (BUG-0263: they travel now).
    pub slicer_formulas: usize,
}

/// The per-sheet and workbook-scoped RULE payloads a pull carries next to its
/// sheets, each opaque host JSON that nevertheless names sheets inside
/// (BUG-0151 follow-up, wave-B B4).
pub struct PulledRules<'a> {
    pub conditional_formats: &'a mut [persistence::SavedSheetConditionalFormats],
    pub data_validations: &'a mut [persistence::SavedSheetDataValidations],
    pub controls: &'a mut [persistence::SavedSheetControls],
    pub pane_controls: &'a mut [persistence::SavedPaneControl],
}

fn key(name: &str) -> String {
    name.to_uppercase()
}

impl SheetRenames {
    /// Build from `(old name, new name)` pairs. A pair whose two names are the
    /// same ignoring case is dropped: a reference to it already resolves, and
    /// rewriting it would only re-spell the formula.
    pub fn new<I, K, V>(pairs: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: AsRef<str>,
        V: AsRef<str>,
    {
        let mut by_upper = HashMap::new();
        for (from, to) in pairs {
            let (from, to) = (from.as_ref(), to.as_ref());
            if from.is_empty() || key(from) == key(to) {
                continue;
            }
            by_upper.insert(key(from), to.to_string());
        }
        SheetRenames { by_upper, gone: HashSet::new() }
    }

    /// Also turn every reference to these sheets into `#REF!`: sheets of the
    /// pull that have NO counterpart in this workbook (see "A sheet that is
    /// GONE" in the module header). A name this set already renames is not
    /// gone, and is left to the rename.
    pub fn with_gone<I, K>(mut self, names: I) -> Self
    where
        I: IntoIterator<Item = K>,
        K: AsRef<str>,
    {
        for name in names {
            let k = key(name.as_ref());
            if !k.is_empty() && !self.by_upper.contains_key(&k) {
                self.gone.insert(k);
            }
        }
        self
    }

    pub fn is_empty(&self) -> bool {
        self.by_upper.is_empty() && self.gone.is_empty()
    }

    /// Is `name` a sheet with no counterpart here, case-insensitively?
    pub fn is_gone(&self, name: &str) -> bool {
        self.gone.contains(&key(name))
    }

    /// The name `name` is renamed to, case-insensitively; `None` when it is not
    /// renamed.
    pub fn target(&self, name: &str) -> Option<&str> {
        self.by_upper.get(&key(name)).map(String::as_str)
    }

    fn swap(&self, sheet: &mut String) -> bool {
        match self.target(sheet) {
            Some(to) => {
                *sheet = to.to_string();
                true
            }
            None => false,
        }
    }

    /// Rename every sheet reference in `expr`, in place, and turn every
    /// reference to a GONE sheet into `#REF!`. True when anything changed.
    /// The walk is [`walk_sheet_slots`], exhaustive over every node.
    pub fn rename_expression(&self, expr: &mut Expression) -> bool {
        if self.is_empty() {
            return false;
        }
        walk_sheet_slots(expr, &mut |sheet| {
            if self.is_gone(sheet) {
                SlotEdit::Gone
            } else if self.swap(sheet) {
                SlotEdit::Changed
            } else {
                SlotEdit::Keep
            }
        })
    }

    /// Rename the sheet references in one formula TEXT. `None` when nothing
    /// changed or the text does not parse (it is then left exactly as it was --
    /// a reader that cannot parse it cannot resolve it either). A leading `=` is
    /// kept when the input had one: stored cell formulas carry none, defined
    /// names' `refers_to` carry one.
    pub fn rename_formula(&self, text: &str) -> Option<String> {
        if self.is_empty() {
            return None;
        }
        // `engine` owns the one parser this crate reaches; `Cell::new_formula`
        // is that parse, and a text it cannot read comes back with no AST.
        let mut ast = *engine::Cell::new_formula(text.to_string()).ast?;
        if !self.rename_expression(&mut ast) {
            return None;
        }
        // RAW, never the collapsed display form: a named LAMBDA's resolved
        // `__INVOKE__` marker has to survive, exactly as persistence keeps it.
        let rendered = engine::ast_render::render_formula_raw(&ast);
        Some(if text.trim_start().starts_with('=') {
            format!("={}", rendered)
        } else {
            rendered
        })
    }

    /// Rename the sheet prefix of an A1 reference string (`"Data!A1:B5"`,
    /// `"'My Data'!A1"`), the shape a chart's string source and a dropdown's
    /// cell range use. `None` when it has no prefix or the prefix is not renamed.
    /// A reference to a GONE sheet becomes `"#REF!"`, which no sheet, range or
    /// defined name answers to.
    pub fn rename_reference(&self, reference: &str) -> Option<String> {
        // ONE scan decides both the name and where the range after it starts
        // (`split_sheet_reference`): a quoted name may itself contain `'!`.
        let (name, rest) = crate::publish::split_sheet_reference(reference)?;
        if name.is_empty() {
            return None;
        }
        if self.is_gone(&name) {
            return Some("#REF!".to_string());
        }
        let to = self.target(&name)?;
        Some(format!("{}!{}", engine::ast_render::quote_sheet_name(to), rest))
    }

    /// `saved` with its formula spelled in the names this set renames to --
    /// the cell a working copy's grid takes when a merge or a hold-back lays a
    /// PUBLISHED version's cell into it (BUG-0151). Borrowed unchanged when
    /// there is nothing to rename.
    pub fn rename_saved_cell<'a>(
        &self,
        saved: &'a persistence::SavedCell,
    ) -> std::borrow::Cow<'a, persistence::SavedCell> {
        match saved.formula.as_deref().and_then(|f| self.rename_formula(f)) {
            Some(formula) => std::borrow::Cow::Owned(persistence::SavedCell {
                formula: Some(formula),
                ..saved.clone()
            }),
            None => std::borrow::Cow::Borrowed(saved),
        }
    }

    /// Rename every stored formula on one sheet. Returns how many changed.
    pub fn rename_sheet_formulas(&self, sheet: &mut persistence::Sheet) -> usize {
        if self.is_empty() {
            return 0;
        }
        let mut changed = 0;
        for cell in sheet.cells.values_mut() {
            let Some(formula) = cell.formula.as_deref() else { continue };
            if let Some(renamed) = self.rename_formula(formula) {
                cell.formula = Some(renamed);
                changed += 1;
            }
        }
        changed
    }

    /// Rename every sheet-name-bound reference a pull carries: the formulas on
    /// every pulled sheet (object-backed sheets included -- they are sheets of
    /// the pull like any other), every defined name's `refers_to`, every
    /// chart's string sources, the rule payloads, and every slicer's computed
    /// property formulas. Run BEFORE the sheets become grids, so the edges
    /// built from them, the override baselines captured from them and the
    /// upstream values a refresh compares against are all in ONE spelling.
    pub fn rename_pull(&self, result: &mut crate::pull::PullResult) -> RenameCounts {
        let content =
            self.rename_pulled_content(&mut result.sheets, &mut result.named_ranges, &mut result.charts);
        let rules = self.rename_pulled_rules(PulledRules {
            conditional_formats: &mut result.conditional_formats,
            data_validations: &mut result.data_validations,
            controls: &mut result.controls,
            pane_controls: &mut result.pane_controls,
        });
        let slicer_formulas = self.rename_slicer_formulas(&mut result.slicers);
        RenameCounts {
            cell_formulas: content.cell_formulas,
            named_ranges: content.named_ranges,
            charts: content.charts,
            conditional_formats: rules.conditional_formats,
            data_validations: rules.data_validations,
            controls: rules.controls,
            pane_controls: rules.pane_controls,
            slicer_formulas,
        }
    }

    /// Rename the sheet references in every slicer's COMPUTED PROPERTY
    /// formulas (BUG-0263). A computed property is a formula the cell
    /// evaluator runs (`slicer/computed.rs`) and it names sheets by NAME, so
    /// once these travel -- on checkout, so an untouched push republishes them,
    /// and to subscribers, who evaluate them like the cell formulas that
    /// already travel -- a collision rename has to reach them exactly as it
    /// reaches a cell. The push half is the host's
    /// `restore_published_sheet_references`. Returns how many changed.
    pub fn rename_slicer_formulas(&self, slicers: &mut [persistence::SavedSlicer]) -> usize {
        if self.is_empty() {
            return 0;
        }
        let mut changed = 0;
        for slicer in slicers.iter_mut() {
            for prop in slicer.computed_properties.iter_mut() {
                changed += usize::from(self.rename_slot(&mut prop.formula));
            }
        }
        changed
    }

    /// Rename the sheet references inside the RULE payloads a pull carries:
    /// conditional-formatting formulas, data-validation formulas, the
    /// formula-valued properties of cell-anchored controls, and pane-control
    /// dropdowns' cell-range sources. Each names sheets by NAME exactly as a
    /// cell formula does, so after a collision rename each read the
    /// SUBSCRIBER's own same-named sheet -- a highlight, a validation rule or
    /// a dropdown list silently driven by the wrong data.
    pub fn rename_pulled_rules(&self, rules: PulledRules<'_>) -> RenameCounts {
        let mut counts = RenameCounts::default();
        if self.is_empty() {
            return counts;
        }
        for cf in rules.conditional_formats.iter_mut() {
            counts.conditional_formats += self.rename_conditional_format_rules(&mut cf.rules);
        }
        for dv in rules.data_validations.iter_mut() {
            counts.data_validations += self.rename_validation_ranges(&mut dv.ranges);
        }
        for sheet in rules.controls.iter_mut() {
            counts.controls += self.rename_control_entries(&mut sheet.controls);
        }
        for pane in rules.pane_controls.iter_mut() {
            counts.pane_controls += self.rename_pane_control_config(&mut pane.config);
        }
        counts
    }

    /// Rename one formula slot in place; true when it changed.
    fn rename_slot(&self, text: &mut String) -> bool {
        match self.rename_formula(text) {
            Some(renamed) => {
                *text = renamed;
                true
            }
            None => false,
        }
    }

    /// Conditional-formatting rules (the host's `Vec<ConditionalFormatDefinition>`):
    /// every formula a rule carries (see [`visit_cf_rule_formulas`]). Returns
    /// how many changed.
    pub fn rename_conditional_format_rules(&self, rules: &mut serde_json::Value) -> usize {
        visit_cf_rule_formulas(rules, &mut |s| self.rename_slot(s))
    }

    /// Data-validation ranges (the host's `Vec<ValidationRange>`): a custom
    /// rule's `formula` (see [`visit_validation_formulas`]). Returns how many
    /// changed.
    pub fn rename_validation_ranges(&self, ranges: &mut serde_json::Value) -> usize {
        visit_validation_formulas(ranges, &mut |s| self.rename_slot(s))
    }

    /// Cell-anchored controls (the host's `Vec<SavedControlEntry>`): every
    /// formula-valued property (see [`visit_control_formulas`]). Returns how
    /// many changed.
    pub fn rename_control_entries(&self, controls: &mut serde_json::Value) -> usize {
        visit_control_formulas(controls, &mut |s| self.rename_slot(s))
    }

    /// A pane control's config (the host's `PaneControlConfig`): a dropdown's
    /// cell-range source (see [`visit_pane_control_reference`]). Returns 1
    /// when it changed.
    pub fn rename_pane_control_config(&self, config: &mut serde_json::Value) -> usize {
        visit_pane_control_reference(config, &mut |reference| match self.rename_reference(reference) {
            Some(renamed) => {
                *reference = renamed;
                true
            }
            None => false,
        })
    }

    /// [`Self::rename_pull`] over the three parts it touches.
    pub fn rename_pulled_content(
        &self,
        sheets: &mut [crate::pull::PulledSheet],
        named_ranges: &mut [crate::manifest::PublishedNamedRange],
        charts: &mut [persistence::SavedChart],
    ) -> RenameCounts {
        let mut counts = RenameCounts::default();
        if self.is_empty() {
            return counts;
        }
        for pulled in sheets.iter_mut() {
            counts.cell_formulas += self.rename_sheet_formulas(&mut pulled.sheet);
        }
        for nr in named_ranges.iter_mut() {
            if let Some(renamed) = self.rename_formula(&nr.refers_to) {
                nr.refers_to = renamed;
                counts.named_ranges += 1;
            }
        }
        for chart in charts.iter_mut() {
            if let Some(renamed) =
                crate::chart_refs::rename_chart_spec_sheet_names(&chart.spec_json, self)
            {
                chart.spec_json = renamed;
                counts.charts += 1;
            }
        }
        counts
    }
}

// ---------------------------------------------------------------------------
// The RULE payloads' formula slots (wave-B B4)
// ---------------------------------------------------------------------------
//
// Conditional formats, data validations, cell-anchored controls and pane
// controls travel as OPAQUE host JSON, and each names sheets inside. ONE
// visitor per payload decides which strings are formulas (or, for a dropdown,
// an A1 reference); the rename on pull and push and the version diff's
// spelling-blind comparison both walk through it, so they cannot disagree
// about which strings a payload's references live in. The host pins these
// shapes against its typed structs (calp_commands.rs `pull_rename_payload_tests`).

/// Call `f` on one JSON string slot; true when `f` changed it.
fn visit_string(value: Option<&mut serde_json::Value>, f: &mut dyn FnMut(&mut String) -> bool) -> bool {
    match value {
        Some(serde_json::Value::String(text)) => f(text),
        _ => false,
    }
}

/// Call `f` on one JSON string slot only when it is a formula by its leading
/// `=` -- the slots the host reads as a literal otherwise.
fn visit_equals_formula(value: Option<&mut serde_json::Value>, f: &mut dyn FnMut(&mut String) -> bool) -> bool {
    match value {
        Some(serde_json::Value::String(text)) if text.trim_start().starts_with('=') => f(text),
        _ => false,
    }
}

/// Every formula a conditional-formatting rules payload (`Vec<ConditionalFormatDefinition>`)
/// carries, visited exactly where the HOST's evaluator reads a formula: an
/// expression rule's `formula`, a colour-scale point's and an icon-set
/// threshold's `formula`, and a data bar's `minFormula` / `maxFormula` are
/// formulas with or without a leading `=` (`evaluate_formula_multi_sheet`
/// parses either), so each is always visited; a cell-value rule's `value1` /
/// `value2` is a formula only when it starts with `=` -- without one it is a
/// literal the evaluator reads as a number, and a rename must not rewrite text
/// the user typed as data. Returns how many `f` changed.
pub fn visit_cf_rule_formulas(rules: &mut serde_json::Value, f: &mut dyn FnMut(&mut String) -> bool) -> usize {
    let Some(defs) = rules.as_array_mut() else { return 0 };
    let mut changed = 0;
    for def in defs.iter_mut() {
        let Some(rule) = def.get_mut("rule").and_then(|r| r.as_object_mut()) else { continue };
        for key in ["formula", "minFormula", "maxFormula"] {
            changed += usize::from(visit_string(rule.get_mut(key), f));
        }
        for key in ["value1", "value2"] {
            changed += usize::from(visit_equals_formula(rule.get_mut(key), f));
        }
        for point in ["minPoint", "midPoint", "maxPoint"] {
            if let Some(p) = rule.get_mut(point).and_then(|p| p.as_object_mut()) {
                changed += usize::from(visit_string(p.get_mut("formula"), f));
            }
        }
        if let Some(thresholds) = rule.get_mut("thresholds").and_then(|t| t.as_array_mut()) {
            for t in thresholds.iter_mut() {
                if let Some(t) = t.as_object_mut() {
                    changed += usize::from(visit_string(t.get_mut("formula"), f));
                }
            }
        }
    }
    changed
}

/// Every formula a data-validation ranges payload (`Vec<ValidationRange>`)
/// carries: a custom rule's `formula`. (A list rule names its source range by
/// sheet INDEX, not by name, and literal list items are data.)
pub fn visit_validation_formulas(ranges: &mut serde_json::Value, f: &mut dyn FnMut(&mut String) -> bool) -> usize {
    let Some(ranges) = ranges.as_array_mut() else { return 0 };
    let mut changed = 0;
    for range in ranges.iter_mut() {
        let custom = range
            .get_mut("validation")
            .and_then(|v| v.get_mut("rule"))
            .and_then(|r| r.get_mut("custom"))
            .and_then(|c| c.as_object_mut());
        if let Some(custom) = custom {
            changed += usize::from(visit_string(custom.get_mut("formula"), f));
        }
    }
    changed
}

/// Every formula-valued property of a cell-anchored controls payload
/// (`Vec<SavedControlEntry>`): a property whose `valueType` is `"formula"`
/// AND whose value starts with `=` -- the host's own rule (`controls.rs`
/// evaluates `value_type == "formula" && value.starts_with('=')` and displays
/// anything else literally). A static property is a literal.
pub fn visit_control_formulas(controls: &mut serde_json::Value, f: &mut dyn FnMut(&mut String) -> bool) -> usize {
    let Some(entries) = controls.as_array_mut() else { return 0 };
    let mut changed = 0;
    for entry in entries.iter_mut() {
        let Some(props) = entry.get_mut("properties").and_then(|p| p.as_object_mut()) else { continue };
        for prop in props.values_mut() {
            let Some(prop) = prop.as_object_mut() else { continue };
            if prop.get("valueType").and_then(|t| t.as_str()) != Some("formula") {
                continue;
            }
            match prop.get_mut("value") {
                Some(serde_json::Value::String(text)) if text.starts_with('=') => {
                    changed += usize::from(f(text));
                }
                _ => {}
            }
        }
    }
    changed
}

/// A pane control's config (`PaneControlConfig`): a dropdown whose source is
/// a `cellRange` names its sheet in `reference`, an A1 string like a chart's.
pub fn visit_pane_control_reference(config: &mut serde_json::Value, f: &mut dyn FnMut(&mut String) -> bool) -> usize {
    let Some(source) = config.get_mut("source").and_then(|s| s.as_object_mut()) else { return 0 };
    if source.get("type").and_then(|t| t.as_str()) != Some("cellRange") {
        return 0;
    }
    usize::from(visit_string(source.get_mut("reference"), f))
}

/// Every formula a slicer's `computed_properties` list carries (one saved
/// slicer's JSON field -- `SavedSlicer` serializes snake_case): each entry's
/// `formula`, which the slicer evaluator parses with or without a leading `=`,
/// so it is always visited (BUG-0263).
pub fn visit_slicer_computed_formulas(props: &mut serde_json::Value, f: &mut dyn FnMut(&mut String) -> bool) -> usize {
    let Some(props) = props.as_array_mut() else { return 0 };
    props
        .iter_mut()
        .map(|prop| usize::from(visit_string(prop.get_mut("formula"), f)))
        .sum()
}

/// A rule payload OBJECT (one version-diff item of `domain`) with every
/// formula slot in the form two spellings of it share, so a checkout's
/// collision rename and the push's undo of it -- which re-render the
/// formulas they touch -- are not read as an edit ("Spelling is not an edit"
/// in the module header). EVERY slot the payload's visitor reaches is
/// canonicalised, with or without its leading `=`: the visitors reach exactly
/// the slots the host reads as formulas -- the same ones the rename rewrites --
/// so a slot the rename can re-spell is always compared spelling-blind, and a
/// literal the visitor skips (a cell-value bound without `=`) stays
/// byte-compared: `abc` becoming `ABC` is still a change. `None` for a domain
/// with no such slots (and for a slicer that carries no computed properties,
/// which is then compared byte for byte like any other object).
pub fn comparable_rule_payload(domain: &str, item: &serde_json::Value) -> Option<serde_json::Value> {
    let (field, visit): (&str, fn(&mut serde_json::Value, &mut dyn FnMut(&mut String) -> bool) -> usize) = match domain {
        "conditionalFormat" => ("rules", visit_cf_rule_formulas),
        "dataValidation" => ("ranges", visit_validation_formulas),
        "control" => ("controls", visit_control_formulas),
        "paneControl" => ("config", visit_pane_control_reference),
        "slicer" => ("computed_properties", visit_slicer_computed_formulas),
        _ => return None,
    };
    let mut out = item.clone();
    let slot = out.get_mut(field)?;
    if domain == "paneControl" {
        visit(slot, &mut |reference| {
            *reference = comparable_reference(reference);
            false
        });
    } else {
        visit(slot, &mut |text| {
            if let Some(canonical) = comparable_formula(text) {
                *text = format!("={}", canonical);
            }
            false
        });
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn renames(pairs: &[(&str, &str)]) -> SheetRenames {
        SheetRenames::new(pairs.iter().copied())
    }

    #[test]
    fn a_chain_moves_every_name_exactly_one_step() {
        // THE CASE a pairwise rewrite gets wrong: {A -> "A (2)", "A (2)" -> "A (2) (2)"}.
        let r = renames(&[("A", "A (2)"), ("A (2)", "A (2) (2)")]);
        assert_eq!(
            r.rename_formula("A!B1+'A (2)'!C1").as_deref(),
            Some("'A (2)'!B1+'A (2) (2)'!C1"),
            "each reference is looked up ONCE; a pairwise application sends A!B1 to 'A (2) (2)'"
        );
        // ...and the swap the ledger names: {B -> A, A -> "A (2)"}.
        let swap = renames(&[("B", "A"), ("A", "A (2)")]);
        assert_eq!(swap.rename_formula("=B!A1&A!A1").as_deref(), Some("=A!A1&'A (2)'!A1"));
    }

    #[test]
    fn matching_ignores_case_and_the_target_keeps_its_spelling() {
        let r = renames(&[("Data", "Data (2)")]);
        // The lexer upper-cases a bare name: `Data!A1` is stored as `DATA!A1`.
        assert_eq!(r.rename_formula("DATA!A1*2").as_deref(), Some("'Data (2)'!A1*2"));
        assert_eq!(r.rename_formula("'data'!A1").as_deref(), Some("'Data (2)'!A1"));
        // A same-name pair (ignoring case) is not a rename at all.
        assert!(renames(&[("Data", "DATA")]).is_empty());
    }

    #[test]
    fn every_reference_shape_is_renamed() {
        let r = renames(&[("Data", "Facts")]);
        for (input, expected) in [
            ("SUM(Data!A1:B5)", "SUM(Facts!A1:B5)"),
            ("SUM(Data!A:A)", "SUM(Facts!A:A)"),
            ("SUM(Data!1:3)", "SUM(Facts!1:3)"),
            ("SUM(Data:Data!A1)", "SUM(Facts:Facts!A1)"),
            ("@Data!A1:A9", "@Facts!A1:A9"),
            ("Data!A1#", "Facts!A1#"),
            ("-Data!A1", "-Facts!A1"),
        ] {
            assert_eq!(r.rename_formula(input).as_deref(), Some(expected), "{input}");
        }
    }

    #[test]
    fn untouched_text_is_left_alone() {
        let r = renames(&[("Data", "Facts")]);
        // No reference to a renamed sheet: None, so the caller keeps the bytes.
        assert_eq!(r.rename_formula("Other!A1+B2"), None);
        // A string literal is data, not a reference -- Excel leaves it too.
        assert_eq!(r.rename_formula("INDIRECT(\"Data!A1\")"), None);
        // An unparsable text is left exactly as it was.
        assert_eq!(r.rename_formula("=SUM(("), None);
        assert_eq!(SheetRenames::default().rename_formula("Data!A1"), None);
    }

    #[test]
    fn a_reference_string_is_renamed_by_its_prefix() {
        let r = renames(&[("Data", "Data (2)"), ("It's", "Its")]);
        assert_eq!(r.rename_reference("Data!A1:B5").as_deref(), Some("'Data (2)'!A1:B5"));
        assert_eq!(r.rename_reference("'data'!$A$1").as_deref(), Some("'Data (2)'!$A$1"));
        assert_eq!(r.rename_reference("'It''s'!C1:C5").as_deref(), Some("Its!C1:C5"));
        assert_eq!(r.rename_reference("A1:B5"), None, "no prefix, no rename");
        assert_eq!(r.rename_reference("Other!A1"), None);
        assert_eq!(r.rename_reference("SalesData"), None);
    }

    /// A LEGAL sheet name may contain `'!` ("Rock'!Roll" -- only a leading or
    /// trailing apostrophe is refused). Quoted, it reads `'Rock''!Roll'!A1:B5`,
    /// and the rename cut the reference at the FIRST `'!` -- the one inside the
    /// doubled-quote escape -- gluing the rest of the name onto the range:
    /// `'Rock''!Roll (2)'!Roll'!A1:B5`.
    ///
    /// SABOTAGE: split at `find("'!")` again instead of where the prefix scan
    /// ended.
    #[test]
    fn a_quoted_name_containing_quote_bang_is_renamed_by_its_real_prefix() {
        let r = renames(&[("Rock'!Roll", "Rock'!Roll (2)")]);
        assert_eq!(
            r.rename_reference("'Rock''!Roll'!A1:B5").as_deref(),
            Some("'Rock''!Roll (2)'!A1:B5")
        );
        assert_eq!(
            crate::publish::split_sheet_reference(" 'Rock''!Roll'!$A$1 "),
            Some(("Rock'!Roll".to_string(), "$A$1"))
        );
        assert_eq!(crate::publish::split_sheet_reference("Data!A1"), Some(("Data".to_string(), "A1")));
        assert_eq!(crate::publish::split_sheet_reference("'Quoted'NoBang"), None);
    }

    /// SPELLING IS NOT AN EDIT. A checkout rename and the push's undo of it
    /// bring an untouched formula home re-spelled -- the lexer upper-cased the
    /// bare `Data` the author typed, the renderer writes the target's own
    /// spelling -- and a quoted bare-able name comes back unquoted. The same
    /// formula, every time; while a real edit, a different sheet or a changed
    /// STRING literal is still a different formula.
    ///
    /// SABOTAGE: make `same_formula_text` a byte compare.
    #[test]
    fn a_rename_round_trip_is_the_same_formula_and_an_edit_is_not() {
        let checkout = renames(&[("Data", "Data (2)")]);
        let push = renames(&[("data (2)", "Data")]);
        let stored = engine::Cell::new_formula("Data!A1*2".to_string()).formula_string_raw().unwrap();
        assert_eq!(stored, "DATA!A1*2", "precondition: the lexer upper-cases a bare sheet name");
        let home = push.rename_formula(&checkout.rename_formula(&stored).unwrap()).unwrap();
        assert_ne!(home, stored, "precondition: the round trip re-spells the text");
        assert!(same_formula_text(&home, &stored), "{home} vs {stored}");

        for (a, b) in [
            ("'Data'!A1*2", "DATA!A1*2"),
            ("=Data!$A$1", "=DATA!$A$1"),
            ("SUM('My Data'!A1:B5)", "sum('MY DATA'!a1:b5)"),
            ("Data:Report!A1", "data:report!a1"),
        ] {
            assert!(same_formula_text(a, b), "{a} vs {b}");
        }
        for (a, b) in [
            ("Data!A1*2", "Data!A1*3"),
            ("Data!A1", "Other!A1"),
            ("Data!A1", "Data!A2"),
            ("INDIRECT(\"data!A1\")", "INDIRECT(\"Data!A1\")"),
            ("Data!A1*2", "=SUM(("),
        ] {
            assert!(!same_formula_text(a, b), "{a} vs {b} is a real difference");
        }
    }

    /// A merge or a hold-back lays a PUBLISHED cell into a working copy whose
    /// checkout collision-renamed a sheet; the cell must say what the grid says.
    #[test]
    fn a_published_cell_takes_the_working_copys_sheet_names() {
        let r = renames(&[("Data", "Data (2)")]);
        let formula = persistence::SavedCell::from_cell(&engine::Cell::new_formula("Data!A1*2".to_string()));
        assert_eq!(r.rename_saved_cell(&formula).formula.as_deref(), Some("'Data (2)'!A1*2"));
        let literal = persistence::SavedCell::from_cell(&engine::Cell::new_number(5.0));
        assert!(matches!(r.rename_saved_cell(&literal), std::borrow::Cow::Borrowed(_)));
        let other = persistence::SavedCell::from_cell(&engine::Cell::new_formula("Other!A1".to_string()));
        assert!(matches!(r.rename_saved_cell(&other), std::borrow::Cow::Borrowed(_)));
    }

    #[test]
    fn a_pull_is_renamed_in_every_place_that_names_a_sheet() {
        use persistence::{SavedCell, Sheet};
        let mut sheet = Sheet::new("Report".to_string());
        sheet
            .cells
            .insert((0, 0), SavedCell::from_cell(&engine::Cell::new_formula("Data!A1*2".to_string())));
        sheet
            .cells
            .insert((1, 0), SavedCell::from_cell(&engine::Cell::new_formula("B1+1".to_string())));
        let mut sheets = vec![crate::pull::PulledSheet {
            package_sheet_id: sheet.id,
            name: "Report".to_string(),
            sheet,
        }];
        let mut named_ranges = vec![crate::manifest::PublishedNamedRange {
            name: "Rate".to_string(),
            refers_to: "=Data!$B$2".to_string(),
            sheet_id: None,
            extra: Default::default(),
        }];
        let mut charts = vec![persistence::SavedChart {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            sheet_id: identity::SheetId::from_bytes(identity::generate_uuid_v7()),
            spec_json: serde_json::json!({ "spec": { "data": "Data!A1:B5" } }).to_string(),
        }];

        let counts = renames(&[("Data", "Data (2)")])
            .rename_pulled_content(&mut sheets, &mut named_ranges, &mut charts);
        assert_eq!(
            counts,
            RenameCounts { cell_formulas: 1, named_ranges: 1, charts: 1, ..RenameCounts::default() }
        );
        let cells = &sheets[0].sheet.cells;
        assert_eq!(cells[&(0, 0)].formula.as_deref(), Some("'Data (2)'!A1*2"));
        assert_eq!(cells[&(1, 0)].formula.as_deref(), Some("B1+1"), "an unrelated formula keeps its bytes");
        assert_eq!(named_ranges[0].refers_to, "='Data (2)'!$B$2");
        assert!(charts[0].spec_json.contains("'Data (2)'!A1:B5"));
    }

    /// The rule payloads, in the host's own JSON shapes (the host pins those
    /// shapes against its typed structs in calp_commands.rs
    /// `pull_rename_payload_tests`).
    fn rule_payloads() -> (
        Vec<persistence::SavedSheetConditionalFormats>,
        Vec<persistence::SavedSheetDataValidations>,
        Vec<persistence::SavedSheetControls>,
        Vec<persistence::SavedPaneControl>,
    ) {
        use serde_json::json;
        let sheet = identity::SheetId::from_bytes(identity::generate_uuid_v7());
        let cfs = vec![persistence::SavedSheetConditionalFormats {
            sheet_id: sheet,
            rules: json!([
                { "id": 1, "rule": { "type": "expression", "formula": "=A1>Data!$B$1" } },
                { "id": 2, "rule": { "type": "cellValue", "operator": "between", "value1": "=Data!A1", "value2": "=Other!A1" } },
                { "id": 3, "rule": { "type": "colorScale",
                    "minPoint": { "valueType": "formula", "formula": "=MIN(Data!A:A)", "color": "#fff" },
                    "maxPoint": { "valueType": "max", "color": "#000" } } },
                { "id": 4, "rule": { "type": "dataBar", "minFormula": "=Data!C1", "maxFormula": "=Data!C2", "fillColor": "#00f" } },
                { "id": 5, "rule": { "type": "iconSet", "thresholds": [ { "valueType": "formula", "value": 0, "formula": "=Data!D1" } ] } },
                { "id": 6, "rule": { "type": "containsText", "text": "Data!A1" } }
            ]),
        }];
        let dvs = vec![persistence::SavedSheetDataValidations {
            sheet_id: sheet,
            ranges: json!([
                { "startRow": 0, "startCol": 0, "endRow": 9, "endCol": 0,
                  "validation": { "rule": { "custom": { "formula": "=COUNTIF(Data!A:A,A1)=1" } } } },
                { "startRow": 0, "startCol": 1, "endRow": 9, "endCol": 1,
                  "validation": { "rule": { "list": { "source": { "values": ["Data!A1"] }, "inCellDropdown": true } } } }
            ]),
        }];
        let controls = vec![persistence::SavedSheetControls {
            sheet_id: sheet,
            controls: json!([
                { "row": 1, "col": 1, "controlType": "button", "properties": {
                    "text": { "valueType": "formula", "value": "=Data!A1" },
                    "fill": { "valueType": "static", "value": "Data!A1" } } }
            ]),
        }];
        let panes = vec![
            persistence::SavedPaneControl {
                id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
                name: "Region".to_string(),
                control_type: "dropdown".to_string(),
                config: json!({ "type": "dropdown", "source": { "type": "cellRange", "reference": "Data!A1:A5" }, "placeholder": null }),
                value: serde_json::Value::Null,
                order: 0,
            },
            persistence::SavedPaneControl {
                id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
                name: "Static".to_string(),
                control_type: "dropdown".to_string(),
                config: json!({ "type": "dropdown", "source": { "type": "static", "items": ["Data!A1"] }, "placeholder": null }),
                value: serde_json::Value::Null,
                order: 1,
            },
        ];
        (cfs, dvs, controls, panes)
    }

    #[test]
    fn a_pull_renames_every_rule_formula_and_dropdown_source() {
        let (mut cfs, mut dvs, mut controls, mut panes) = rule_payloads();
        let counts = renames(&[("Data", "Data (2)")]).rename_pulled_rules(PulledRules {
            conditional_formats: &mut cfs,
            data_validations: &mut dvs,
            controls: &mut controls,
            pane_controls: &mut panes,
        });
        let rules = &cfs[0].rules;
        assert_eq!(rules[0]["rule"]["formula"], "=A1>'Data (2)'!$B$1", "a CF expression");
        assert_eq!(rules[1]["rule"]["value1"], "='Data (2)'!A1", "a CF cell-value bound");
        assert_eq!(rules[1]["rule"]["value2"], "=Other!A1", "an unrelated bound keeps its bytes");
        assert_eq!(rules[2]["rule"]["minPoint"]["formula"], "=MIN('Data (2)'!A:A)", "a colour-scale point");
        assert_eq!(rules[3]["rule"]["minFormula"], "='Data (2)'!C1", "a data-bar bound");
        assert_eq!(rules[3]["rule"]["maxFormula"], "='Data (2)'!C2", "a data-bar bound");
        assert_eq!(rules[4]["rule"]["thresholds"][0]["formula"], "='Data (2)'!D1", "an icon-set threshold");
        assert_eq!(rules[5]["rule"]["text"], "Data!A1", "contains-text is a literal, not a reference");

        assert_eq!(
            dvs[0].ranges[0]["validation"]["rule"]["custom"]["formula"],
            "=COUNTIF('Data (2)'!A:A,A1)=1",
            "a custom validation formula"
        );
        assert_eq!(dvs[0].ranges[1]["validation"]["rule"]["list"]["source"]["values"][0], "Data!A1", "a literal list item");

        let props = &controls[0].controls[0]["properties"];
        assert_eq!(props["text"]["value"], "='Data (2)'!A1", "a formula-valued control property");
        assert_eq!(props["fill"]["value"], "Data!A1", "a STATIC property is a literal");

        assert_eq!(panes[0].config["source"]["reference"], "'Data (2)'!A1:A5", "a dropdown's cell-range source");
        assert_eq!(panes[1].config["source"]["items"][0], "Data!A1", "a static item is a literal");

        assert_eq!(
            counts,
            RenameCounts { conditional_formats: 6, data_validations: 1, controls: 1, pane_controls: 1, ..RenameCounts::default() }
        );
    }

    /// Wave-B fix-up: a slot is renamed exactly where the HOST reads a formula.
    /// An always-formula slot (a CF expression, a data-bar bound, ...) is one
    /// with or without its `=` -- the CF evaluator parses either -- while a
    /// cell-value bound without `=` is a literal (the evaluator reads it as a
    /// number) and a formula-typed control property without `=` is shown
    /// literally (`controls.rs` evaluates only values starting with `=`).
    /// Renaming a literal rewrote text the user sees; leaving an `=`-less
    /// formula alone left it reading the wrong sheet.
    #[test]
    fn a_rule_slot_is_renamed_only_where_the_host_reads_a_formula() {
        use serde_json::json;
        let r = renames(&[("Data", "Data (2)")]);
        let mut cf = json!([
            { "id": 1, "rule": { "type": "expression", "formula": "A1 > Data!$B$1" } },
            { "id": 2, "rule": { "type": "cellValue", "operator": "equal", "value1": "Data!A1", "value2": "=Data!A2" } },
            { "id": 3, "rule": { "type": "dataBar", "minFormula": "Data!C1", "fillColor": "#00f" } }
        ]);
        let cf_changed = r.rename_conditional_format_rules(&mut cf);
        assert_eq!(cf[0]["rule"]["formula"], "A1>'Data (2)'!$B$1", "an `=`-less CF expression is a formula");
        assert_eq!(cf[1]["rule"]["value1"], "Data!A1", "an `=`-less cell-value bound is a literal");
        assert_eq!(cf[1]["rule"]["value2"], "='Data (2)'!A2", "an `=` cell-value bound is a formula");
        assert_eq!(cf[2]["rule"]["minFormula"], "'Data (2)'!C1", "an `=`-less data-bar bound is a formula");
        assert_eq!(cf_changed, 3, "{cf}");

        let mut controls = json!([{ "row": 0, "col": 0, "controlType": "button", "properties": {
            "text": { "valueType": "formula", "value": "Data!A1" },
            "tooltip": { "valueType": "formula", "value": "=Data!A2" } } }]);
        let controls_changed = r.rename_control_entries(&mut controls);
        assert_eq!(
            controls[0]["properties"]["text"]["value"], "Data!A1",
            "a formula-typed control value without `=` is displayed literally by the host"
        );
        assert_eq!(controls[0]["properties"]["tooltip"]["value"], "='Data (2)'!A2");
        assert_eq!(controls_changed, 1, "{controls}");
    }

    #[test]
    fn a_rule_reference_to_a_gone_sheet_reads_ref() {
        let (mut cfs, mut dvs, mut controls, mut panes) = rule_payloads();
        SheetRenames::default().with_gone(["Data"]).rename_pulled_rules(PulledRules {
            conditional_formats: &mut cfs,
            data_validations: &mut dvs,
            controls: &mut controls,
            pane_controls: &mut panes,
        });
        assert_eq!(cfs[0].rules[0]["rule"]["formula"], "=A1>#REF!");
        assert_eq!(panes[0].config["source"]["reference"], "#REF!");
    }

    /// BUG-0263. Slicer computed properties now make the checkout -> push round
    /// trip, and a collision rename re-renders every formula it touches: the
    /// author typed `=data!a1 * 2`, the push brings it home as `=Data!A1*2`.
    /// That is the same formula and must not show in the push preview as a
    /// changed slicer (nor collide with a teammate's edit in the merge
    /// analysis) -- while a real edit, or a formula gained or lost, still does.
    ///
    /// SABOTAGE: drop the `"slicer"` arm from `comparable_rule_payload`.
    #[test]
    fn a_slicer_formula_re_spelled_by_a_rename_round_trip_is_the_same_slicer() {
        use serde_json::json;
        let slicer = |formula: &str| {
            json!({ "id": "s1", "name": "ByRegion", "width": 180.0,
                    "computed_properties": [{ "id": "p1", "attribute": "width", "formula": formula }] })
        };
        let typed = slicer("=data!a1 * 2");
        let checkout = renames(&[("Data", "Data (2)")]);
        let push = renames(&[("data (2)", "Data")]);
        let mut wrapped: Vec<persistence::SavedSlicer> = vec![serde_json::from_value(json!({
            "id": identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            "name": "ByRegion",
            "sheet_id": identity::SheetId::from_bytes(identity::generate_uuid_v7()),
            "x": 0.0, "y": 0.0, "width": 180.0, "height": 220.0,
            "source_type": "table",
            "cache_source_id": identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            "field_name": "Region", "selected_items": null, "show_header": true,
            "columns": 1, "style_preset": "SlicerStyleLight1",
            "computed_properties": [{
                "id": identity::EntityId::from_bytes(identity::generate_uuid_v7()),
                "attribute": "width",
                "formula": "=data!a1 * 2"
            }]
        }))
        .expect("a minimal saved slicer")];
        assert_eq!(checkout.rename_slicer_formulas(&mut wrapped), 1);
        assert_eq!(push.rename_slicer_formulas(&mut wrapped), 1);
        let home = wrapped[0].computed_properties[0].formula.clone();
        assert_ne!(home, "=data!a1 * 2", "precondition: the round trip re-spells the text");

        let same = |a: &serde_json::Value, b: &serde_json::Value| {
            match (comparable_rule_payload("slicer", a), comparable_rule_payload("slicer", b)) {
                (Some(x), Some(y)) => x == y,
                _ => false,
            }
        };
        assert!(same(&typed, &slicer(&home)), "{home} vs =data!a1 * 2 is only spelling");
        assert!(!same(&typed, &slicer("=Data!A1*3")), "a real edit is still a change");
        assert!(!same(&typed, &slicer("=Other!A1*2")), "another sheet is still a change");
        let mut no_props = typed.clone();
        no_props.as_object_mut().unwrap().remove("computed_properties");
        assert!(!same(&typed, &no_props), "losing the computed properties is a change");
    }
}
