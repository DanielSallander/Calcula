//! FILENAME: app/src-tauri/src/insights/strategy/facts.rs
// PURPOSE: Read a semantic model down to the handful of facts the resolver and
//          the validator actually need.
// CONTEXT: `resolve.rs` and `validate.rs` deliberately take a `ModelFacts`
//          rather than a `DataModel`. That is not indirection for its own sake:
//          it is what lets the whole strategy layer be tested with a struct
//          literal, with no DataFusion in the dependency tree and no query
//          engine to stand up. This file is the ONLY place that knows both
//          shapes, so it is the only place a change in the BI engine's model
//          API can reach the strategy layer.
//
//          THE BASE LAYER IS BUILT HERE. Everything `AttrSource::Base` and
//          `AttrSource::Inferred` later claims comes from what this file
//          extracts — the KPI's target and its bands' STATUSES, the unit implied
//          by a format string AND by the measure's name, which table is the
//          calendar, which columns exist, which hierarchies the model declares.
//          Extracting one of them wrongly does not produce an error; it
//          produces a confidently wrong favourability, which is why each
//          derivation below states what it assumes.
//
//          ONE OF THOSE DERIVATIONS IS A GUESS, AND IT SAYS SO. Most models
//          never mark a date table — `bi_model_set_date_table` exists
//          (`bi/model_editor.rs`, wired to the Model Editor's Settings tab) but
//          it is a step almost nobody takes — so an ordinary imported star
//          schema arrives with no calendar at all, and without one there is no
//          default time axis, no `TableKind::Calendar` and no role for a
//          `Decimal` month column, which switches off the whole time-series half
//          of the engine in silence. `infer_date_table` fills that in when the
//          shape is unmistakable and REFUSES when two tables qualify;
//          `ModelFacts::calendar_source` carries whether the answer was
//          declared, authored or guessed, and the planner announces the
//          difference.
//
//          THE THIRD RUNG IS THE STRATEGY DOCUMENT, and it is the reason this
//          file has document-aware entry points at all. `TableStrategy::kind`
//          is a dropdown on every row of the Strategy tab, and until
//          `facts_from_model_with` existed it was read by NOTHING: a person who
//          watched calendar detection get it wrong and corrected it changed
//          nothing at all. Read `facts_from_model_with` before either of the
//          other two — it carries the precedence, what each rung may and may
//          not overrule, and (bluntly) which of the dropdown's five values
//          actually changes a report. `facts_with_authored_kinds` is the same
//          work returning the VERDICT alongside the facts, for the run, which
//          owes the reader a note when a stored kind is refused;
//          `facts_from_model` is the draft path's document-blind wrapper.

use std::collections::{BTreeMap, BTreeSet};

use bi_engine::{Cardinality, DataModel, DataType, DateRole, KpiStatus, KpiTarget};

use super::infer::{has_phrase, has_term, words};
use super::resolve::{
    BandStatus, CalendarSource, KpiBand, KpiFacts, MeasureFacts, ModelFacts, TableFacts,
};
use super::types::{EntrySource, QualifiedColumn, StrategyDoc, TableKind, Unit};

/// Read a model into the facts the strategy layer resolves against, with NO
/// strategy document in hand.
///
/// This is the DRAFT path's entry point and it must stay that way: `infer`
/// resolves its whole answer out of the model, so that the Strategy tab can show
/// a person where the machine disagrees with what they stored. Facts built with
/// the document folded in would make inference agree with the document by
/// construction, and the divergence badge would go permanently quiet.
pub fn facts_from_model(model: &DataModel) -> ModelFacts {
    facts_from_model_with(model, &StrategyDoc::default())
}

/// Read a model into facts, letting the strategy document's AUTHORED table kinds
/// overrule what the relationship graph and the calendar heuristic worked out.
///
/// WHAT AUTHORING A KIND ACTUALLY DOES TODAY, STATED BEFORE THE LADDER BECAUSE
/// THE LADDER READS LIKE MORE THAN IT IS. The Strategy tab offers a five-value
/// dropdown that presents itself as "correct the machine". Two of the five
/// change what a reader sees, and they change different things:
///
/// * `calendar` is the only value that can move a NUMBER. When it is accepted it
///   becomes `facts.date_table` (rung 3 below — only if the model itself declares
///   none), and from there the time axis, the series query, and every trend,
///   change-point and seasonality claim in the report.
/// * `dimension` moves no number and no cell, but it can produce a run NOTE. It
///   claims the model can look the table up (`claims_a_lookup`), so a topology
///   that disproves it yields `KindRefusal::NothingLooksItUp`, and
///   `kind_conflict_notes` (`model_commands.rs`) turns every conflict into a note
///   carried into the insights pane, the markdown and the report sheet's Notes
///   block. `calendar` can be refused the same way, and additionally as
///   `AmbiguousCalendar`.
/// * `fact`, `bridge` and `other` are INERT. `claims_a_lookup` is false for all
///   three and neither refusal can name them, so they raise no conflict, no run
///   note and no `validate.rs` finding keyed on the kind. They land in
///   `TableFacts::kind` and nothing on the run path branches on a kind value.
///
/// THE TWO NON-TEST READERS OF `TableFacts::kind` OUTSIDE THIS FILE — grepped,
/// not remembered, because both earlier versions of this paragraph named one
/// reader and one of them was falsified by an edit in its own pass:
///
///   1. `infer_table` (infer.rs), which BRANCHES on the value but runs on the
///      DRAFT path alone. It is reached only from `infer`, whose one production
///      caller is the `"infer"` op in `bi/model_editor.rs`, and that call hands
///      it MODEL-ONLY facts from `facts_from_model` — so a document can never
///      reach it. (`facts_from_model` itself has four production callers: that
///      op, `"preview"`, the `"validate"`/`"runTests"`/`"set"` gate, and the
///      `.calp` publish check in `calp_commands.rs`. None of the other three
///      runs inference.)
///   2. `kind_conflict_notes` (model_commands.rs), which runs on the RUN path but
///      reads the kind only to NAME what the run classified the table as instead,
///      inside a note it is already emitting because a kind was refused.
///
/// SAY IT PLAINLY, BECAUSE THE PRODUCT DOES NOT. Only `calendar` corrects the
/// machine; `dimension` can only tell you it was refused; the other three do
/// nothing at all. Wiring them is a SEPARATE decision and not a tidying-up:
/// `fact`/`dimension`/`bridge` are read off join DIRECTION, so a document that
/// could move them would be a second, staler topology competing with the
/// model's own — which is the shape of defect the `Inferred`-source rule below
/// exists to prevent. Do not fix this header by wiring them.
///
/// THE PRECEDENCE, AND WHY EACH RUNG SITS WHERE IT DOES.
///
/// 1. A HUMAN STATEMENT BEATS A HEURISTIC. This is not a new rule; it is the one
///    the calendar detector has always applied by preferring `mark_date_table`
///    over its own inference. An authored `kind: "calendar"` is the same kind of
///    statement about the same question, so it goes on the same ladder — above
///    the guess.
/// 2. A HUMAN STATEMENT DOES NOT BEAT TOPOLOGY. `Fact`/`Dimension`/`Bridge` are
///    read off relationship DIRECTION, which the model can disprove rather than
///    merely disagree with. `Dimension` and `Calendar` both claim the model can
///    LOOK THIS TABLE UP; a table nothing looks up through a to-one relationship
///    cannot be either, so authoring one there is refused and reported by
///    `validate.rs` naming what the topology says. `Fact`, `Bridge` and `Other`
///    claim nothing a relationship can contradict — and are behaviourally
///    identical inside `infer_table` — so they are accepted as written.
/// 3. THE MODEL'S OWN DECLARATION BEATS THE DOCUMENT, for the calendar only.
///    `mark_date_table` is not just another opinion about which table is the
///    calendar: the ENGINE resolves `TOTALYTD`, `DATEADD` and every other time
///    intelligence function against it and refuses when it is unset
///    (`compute/time_intelligence.rs`). If the annotation layer could move the
///    calendar, the insights report would plot its series along one table while
///    the model's own time-intelligence measures computed along another — two
///    different times inside one report. So a declared date table stands, the
///    authored `Calendar` kind is still applied to the table it names, and
///    `validate.rs` raises a WARNING naming both. (The "the authored value is
///    the more recent and more reversible statement" argument does not survive
///    contact with `bi_model_set_date_table`: the declaration is edited from a
///    dropdown in the same window, so it is exactly as local and exactly as
///    reversible as the strategy document's.)
///
/// AMBIGUITY REFUSES, here as everywhere else in this file: two tables authored
/// `Calendar` means neither is applied and both are reported, for the same
/// reason `infer_date_table` returns `None` on two candidates. Picking the one
/// that sorted first would make what time means in a report depend on a table
/// name.
///
/// ONLY *AUTHORED* ENTRIES OVERRULE ANYTHING. `infer` writes the DERIVED kind
/// into the document it drafts, stamped `EntrySource::Inferred`. Honouring that
/// copy would pin a stale reading of an older model over the current
/// relationship graph — the model changes, the saved draft does not, and the
/// document would quietly win. See `authored_table_kinds`.
pub fn facts_from_model_with(model: &DataModel, doc: &StrategyDoc) -> ModelFacts {
    facts_with_authored_kinds(model, doc).0
}

/// The same facts, plus the verdict on every kind the document stated.
///
/// THE REFUSALS ARE PRODUCED HERE AND WERE THROWN AWAY HERE. Building the facts
/// already judges every authored kind — that is what decides which ones enter
/// the map — and `facts_from_model_with` then dropped the refusals on the
/// floor. `validate.rs` re-derived them for its findings, so a document that
/// was valid when it was saved and is invalidated by a later relationship edit
/// changed what a RUN said with nothing reported anywhere: the run applied the
/// same refusal and pushed no note. `run_model_insights` takes this pair so the
/// note costs no second pass over `doc.tables`.
pub fn facts_with_authored_kinds(
    model: &DataModel,
    doc: &StrategyDoc,
) -> (ModelFacts, AuthoredKinds) {
    let mut facts = ModelFacts::default();

    // --- relationships ------------------------------------------------------
    // Only ACTIVE relationships. An inactive one exists for a `USERELATIONSHIP`
    // that the insights planner never issues, so treating it as reachable would
    // offer the user a breakdown the engine would refuse to compute.
    //
    // READ BEFORE THE CALENDAR, because the calendar inference below needs to
    // know which tables are the FROM side of a relationship: a table filters
    // flow out of is the grain of the model, and a grain is never a calendar.
    let mut is_from: BTreeSet<&str> = BTreeSet::new();
    let mut is_to: BTreeSet<&str> = BTreeSet::new();
    for rel in model.relationships() {
        if !rel.is_active() {
            continue;
        }
        is_from.insert(rel.from_table());
        // Only a to-one endpoint makes the far side a lookup. A many-to-many
        // relationship has no dimension side, and calling one of its ends a
        // dimension is how a bridge table ends up offered as an analysis axis.
        if matches!(rel.cardinality(), Cardinality::ManyToOne | Cardinality::OneToOne) {
            is_to.insert(rel.to_table());
        }
        for cond in rel.conditions() {
            facts.relationships.push((
                QualifiedColumn::new(rel.from_table(), cond.from_column()),
                QualifiedColumn::new(rel.to_table(), cond.to_column()),
            ));
        }
    }
    // The to-one to-sides, kept rather than recomputed downstream: the pairs
    // above lose the cardinality, and `validate.rs` — which has no `DataModel` —
    // needs exactly this set to know whether an authored `Dimension` or
    // `Calendar` is a claim the model can disprove.
    facts.lookup_tables = is_to.iter().map(|t| t.to_string()).collect();

    // --- tables -------------------------------------------------------------
    // KIND IS DECIDED IN A SECOND PASS, below, because it depends on which table
    // ends up being the calendar and THAT can depend on the document.
    for table in model.tables() {
        let name = table.name();
        let columns: BTreeSet<String> = table.columns().iter().map(|c| c.name().to_string()).collect();
        facts.tables.insert(
            name.to_string(),
            TableFacts {
                kind: None,
                columns,
                // The model's own hierarchies, level order preserved. Validation
                // reads them from HERE rather than from the strategy document's
                // copy, so a document nobody has run inference over still gets
                // its hierarchy levels recognised as scopable.
                hierarchies: model
                    .hierarchies_for_table(name)
                    .iter()
                    .map(|h| h.levels().iter().map(|l| l.column().to_string()).collect())
                    .collect(),
                // Members are DATA, not schema. Filling this in means running a
                // grouped query per column, which the strategy layer must not
                // do on every validation. The resolver reads an absent entry as
                // "the member list is not known", which is the honest state and
                // makes it decline to prove full coverage rather than assume it.
                members: BTreeMap::new(),
            },
        );
    }

    // --- what the document was allowed to say -------------------------------
    // ONE PLACE WHERE AN AUTHORED KIND ENTERS `ModelFacts`, and this is it: the
    // defect being fixed was a cascade with one arm wired and the rest not, so
    // the calendar rung and the per-table rung below both read this one answer.
    //
    // It is NOT the only call in the process. `validate.rs` asks the same pure
    // question of its own facts to write its findings, and the caller of
    // `facts_with_authored_kinds` gets this very value back rather than asking
    // again. The function is stable under being asked twice (see its header),
    // which is what makes those safe rather than merely cheap.
    let mut authored = authored_table_kinds(&facts, doc, model.date_table());
    let mut demoted_guess: Option<String> = None;

    // --- the calendar -------------------------------------------------------
    // Three rungs, most authoritative first. See this function's header for why
    // the declaration outranks the document and the document outranks the guess.
    let (date_table, calendar_source) = match model.date_table() {
        Some(declared) => (Some(declared.to_string()), Some(CalendarSource::Declared)),
        None => match authored.calendar.clone() {
            Some(chosen) => (Some(chosen), Some(CalendarSource::Authored)),
            // A DEMOTION OVERRULES THE GUESS - BUT ONLY THE TABLE THE GUESS
            // ACTUALLY NAMED. An authored `dimension` on the table this
            // heuristic picked is a person saying "that is not the calendar",
            // and a heuristic does not get to overrule that.
            //
            // NARROWED TO THE GUESS ITSELF ON PURPOSE, and a test caught the
            // wider version: filtering the SEARCH by every non-calendar kind
            // meant that confirming what the tab already showed you - typing
            // `dimension` on a table detection had itself called a dimension -
            // could break a two-candidate tie and INVENT a time axis that did
            // not exist. Agreeing with a displayed value must change nothing.
            None => match infer_date_table(model, &is_from) {
                Some(guessed) if authored.not_a_calendar.contains(&guessed) => {
                    demoted_guess = Some(guessed);
                    (None, None)
                }
                Some(guessed) => (Some(guessed), Some(CalendarSource::Inferred)),
                None => (None, None),
            },
        },
    };
    facts.date_table = date_table;
    facts.calendar_source = calendar_source;
    authored.demoted_guess = demoted_guess;

    // --- what each table is FOR ---------------------------------------------
    // An accepted authored kind stands in for the derived one WHOLESALE, which
    // is what makes one expression here cover all five places `infer_table`
    // branches on kind. A refused one never reaches this map, so a claim the
    // topology disproves cannot cascade while `validate.rs` reports it.
    let calendar = facts.date_table.clone();
    for (name, table_facts) in facts.tables.iter_mut() {
        table_facts.kind = Some(match authored.accepted.get(name) {
            Some(kind) => *kind,
            None => classify_table(
                name,
                calendar.as_deref(),
                is_from.contains(name.as_str()),
                is_to.contains(name.as_str()),
            ),
        });
    }

    // --- KPIs, indexed by the measure they mark up --------------------------
    let mut kpis: BTreeMap<&str, KpiFacts> = BTreeMap::new();
    for kpi in model.kpis() {
        kpis.insert(
            kpi.base_measure(),
            KpiFacts {
                name: kpi.name().to_string(),
                target: match kpi.target() {
                    KpiTarget::Constant(v) => Some(*v),
                    // A measure-valued target is a number only once a query has
                    // run, so it is genuinely unknown here. `None` keeps the
                    // validator from comparing against a value it invented.
                    KpiTarget::Measure(_) => None,
                },
                // THE STATUS COMES ACROSS WITH THE THRESHOLD. The threshold order
                // is validated ascending by the engine's own builder, so a
                // strategy layer that carried thresholds alone could only ever
                // conclude "higher is better" - including for a churn KPI whose
                // every band says the opposite.
                bands: kpi
                    .status_bands()
                    .iter()
                    .map(|b| KpiBand::new(b.threshold, band_status(b.status)))
                    .collect(),
            },
        );
    }

    // --- measures -----------------------------------------------------------
    for measure in model.measures() {
        facts.measures.insert(
            measure.name().to_string(),
            MeasureFacts {
                fact_table: Some(measure.table().to_string()),
                unit: infer_unit(measure.name(), measure.format_string()),
                kpi: kpis.get(measure.name()).cloned(),
            },
        );
    }

    (facts, authored)
}

/// The engine's `KpiStatus` in the strategy layer's own vocabulary.
///
/// Written as a total match rather than a `From` on a foreign type: a new status
/// level in the engine must be a COMPILE ERROR here, because a status silently
/// folded into the wrong bucket flips a direction.
fn band_status(status: KpiStatus) -> BandStatus {
    match status {
        KpiStatus::OffTrack => BandStatus::OffTrack,
        KpiStatus::AtRisk => BandStatus::AtRisk,
        KpiStatus::OnTrack => BandStatus::OnTrack,
    }
}

// ---------------------------------------------------------------------------
// The table kinds a person typed
// ---------------------------------------------------------------------------

/// Why an authored table kind was not applied.
///
/// The variants are the only two things that can refuse one. Everything else a
/// person can type in that dropdown is accepted, because nothing in the model
/// contradicts it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KindRefusal {
    /// The document claims the model LOOKS THIS TABLE UP — `Dimension` or
    /// `Calendar` — and no active to-one relationship points at it.
    ///
    /// `filters` names a table it is the FROM side of, when there is one. That
    /// is the readable half of the contradiction: filters flow out of it, so it
    /// is the grain of the model rather than something the model can slice by.
    NothingLooksItUp { filters: Option<String> },
    /// Two tables are authored `Calendar`. `other` names the other one.
    AmbiguousCalendar { other: String },
    /// The document gives a NON-calendar kind to the table the MODEL declares as
    /// its date table.
    ///
    /// THE DEMOTION IS THE UNCOVERED DIRECTION, and it is the expensive one. The
    /// promotion case (`Dimension` -> `Calendar`, detection missed it) only ADDS
    /// an axis. Demoting the calendar takes one away, and with it every trend,
    /// change-point and seasonality fact in the run - a large consequence for
    /// one dropdown, in a direction the control gives no hint of.
    ///
    /// Refused only against a DECLARATION, never against a guess. `mark_date_table`
    /// is a human statement made in the Model Editor, so it outranks this one
    /// exactly as it outranks an authored `Calendar` elsewhere in this file; a
    /// merely INFERRED calendar is a heuristic, and there the demotion wins and
    /// the guess moves on.
    TheModelDeclaresItTheDateTable,
}

/// One authored kind the model disproves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KindConflict {
    pub table: String,
    pub authored: TableKind,
    pub refusal: KindRefusal,
}

/// What the strategy document's table kinds are allowed to change.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuthoredKinds {
    /// Table -> the kind that stands, for every authored kind the topology does
    /// not disprove.
    pub accepted: BTreeMap<String, TableKind>,
    /// The single accepted `Calendar`, if there is exactly one.
    pub calendar: Option<String>,
    /// Every table the document gives an accepted NON-calendar kind.
    ///
    /// The guesser must skip these. Without it a demotion changed the table's
    /// ROLE LADDER and nothing else: `infer_date_table` still picked the table,
    /// so the model kept a time axis running along a table the document had just
    /// called an ordinary dimension - one document saying two contradictory
    /// things about one table, with the reader told neither.
    pub not_a_calendar: BTreeSet<String>,
    /// The table the heuristic would have made the calendar, when the document
    /// demoted it and the model declares no date table of its own.
    ///
    /// The demotion TOOK EFFECT — that is why this is not a `KindConflict` — and
    /// the model now has no time axis at all. It is recorded because the
    /// consequence is enormous and invisible from the control that caused it:
    /// every trend, change point and seasonality claim for every measure is
    /// gone, from one dropdown.
    ///
    /// Set by `facts_with_authored_kinds`, which is the only place that knows
    /// what the guess WOULD have been. `authored_table_kinds` alone cannot fill
    /// it in, and leaves it `None`.
    pub demoted_guess: Option<String>,
    /// Every authored kind that was refused, in table order.
    pub conflicts: Vec<KindConflict>,
}

/// Does this kind assert that the model can look the table up?
///
/// `Dimension` and `Calendar` do, and that is a claim a relationship graph can
/// contradict. `Fact`, `Bridge` and `Other` assert nothing testable — and, as it
/// happens, nothing behavioural either: `infer_table` branches on `Calendar` and
/// `Dimension` and treats the other three identically.
fn claims_a_lookup(kind: TableKind) -> bool {
    match kind {
        TableKind::Dimension | TableKind::Calendar => true,
        TableKind::Fact | TableKind::Bridge | TableKind::Other => false,
    }
}

/// A table this one filters, for a message that has to show the contradiction.
///
/// The SMALLEST name rather than the first, so the sentence a user reads does
/// not depend on relationship declaration order.
fn a_table_it_filters(facts: &ModelFacts, table: &str) -> Option<String> {
    facts
        .relationships
        .iter()
        .filter(|(from, _)| from.table == table)
        .map(|(_, to)| to.table.clone())
        .min()
}

/// The table kinds the strategy document states, judged against the model.
///
/// PURE, and deliberately takes `ModelFacts` rather than a `DataModel`: it is
/// the same answer whether it is asked while facts are being built (facts.rs) or
/// while a document is being judged (validate.rs), and both must agree or the
/// validator would refuse something the run had already applied.
///
/// IT IS ALSO STABLE UNDER BEING ASKED TWICE. Nothing it reads — the
/// relationships and `lookup_tables` — is anything it changes, so calling it on
/// facts that already carry the accepted kinds returns the same conflicts.
/// A refusal that quietly disappeared the second time round would be the same
/// class of defect as the one this whole seam exists to fix.
///
/// AN INFERRED ENTRY IS NOT AN AUTHORED ONE. `infer` writes the kind it derived
/// into every table of the draft, stamped `EntrySource::Inferred`; treating that
/// copy as a statement would let a document drafted against last month's model
/// overrule this month's relationship graph, silently and forever. An ABSENT
/// source counts as authored: a hand-written document has no `source` field, and
/// somebody typed it.
pub fn authored_table_kinds(
    facts: &ModelFacts,
    doc: &StrategyDoc,
    declared_calendar: Option<&str>,
) -> AuthoredKinds {
    let mut out = AuthoredKinds::default();

    // `doc.tables` is a BTreeMap, so this list — and therefore `conflicts` — is
    // in table-name order whatever order the document was written in.
    let authored: Vec<(&String, TableKind)> = doc
        .tables
        .iter()
        // A kind on a table the model no longer has is already reported as an
        // orphan entry; it cannot classify anything, so it is not a conflict.
        .filter(|(name, _)| facts.tables.contains_key(name.as_str()))
        .filter(|(_, ts)| ts.source != Some(EntrySource::Inferred))
        .filter_map(|(name, ts)| ts.kind.map(|kind| (name, kind)))
        .collect();

    // TOPOLOGY IS JUDGED FIRST, AND A REFUSED CALENDAR IS NOT A CANDIDATE.
    //
    // Otherwise one impossible entry disables a possible one: `calendar` typed
    // on the fact table — which is the commonest way to get this wrong, because
    // a wide fact table carrying an order date does look like a calendar — would
    // make the real calendar "ambiguous" and leave the model with no time axis
    // at all, reporting the good entry as the problem.
    let refused_by_topology: BTreeSet<&str> = authored
        .iter()
        .filter(|(name, kind)| {
            claims_a_lookup(*kind) && !facts.lookup_tables.contains(name.as_str())
        })
        .map(|(name, _)| name.as_str())
        .collect();

    let calendars: Vec<&str> = authored
        .iter()
        .filter(|(name, kind)| {
            matches!(kind, TableKind::Calendar) && !refused_by_topology.contains(name.as_str())
        })
        .map(|(name, _)| name.as_str())
        .collect();

    // One emission loop, so `conflicts` comes out in table order whichever
    // refusal fired.
    for (name, kind) in &authored {
        if refused_by_topology.contains(name.as_str()) {
            out.conflicts.push(KindConflict {
                table: (*name).clone(),
                authored: *kind,
                refusal: KindRefusal::NothingLooksItUp {
                    filters: a_table_it_filters(facts, name),
                },
            });
            continue;
        }
        // A DEMOTION OF THE MODEL'S OWN DECLARATION, refused before it can take
        // the axis away. See `KindRefusal::TheModelDeclaresItTheDateTable`.
        if !matches!(kind, TableKind::Calendar) && declared_calendar == Some(name.as_str()) {
            out.conflicts.push(KindConflict {
                table: (*name).clone(),
                authored: *kind,
                refusal: KindRefusal::TheModelDeclaresItTheDateTable,
            });
            continue;
        }
        if matches!(kind, TableKind::Calendar) && calendars.len() > 1 {
            let other = calendars
                .iter()
                .find(|c| **c != name.as_str())
                .expect("more than one calendar means there is another one");
            out.conflicts.push(KindConflict {
                table: (*name).clone(),
                authored: *kind,
                refusal: KindRefusal::AmbiguousCalendar {
                    other: (*other).to_string(),
                },
            });
            continue;
        }
        out.accepted.insert((*name).clone(), *kind);
        if matches!(kind, TableKind::Calendar) {
            out.calendar = Some((*name).clone());
        } else {
            out.not_a_calendar.insert((*name).clone());
        }
    }

    out
}

/// The table time runs along once the document has had its say.
///
/// `validate.rs` needs this and cannot call `facts_from_model_with`: it is given
/// facts and a document, never a model. The answer matches the ladder in
/// `facts_from_model_with` exactly — a DECLARED calendar is never moved, and an
/// authored one otherwise wins over the guess.
///
/// Correct on facts built either way. Given raw facts it applies the document;
/// given facts already built with the document it returns what they already say,
/// because an authored calendar is stamped `Authored` rather than `Declared`.
pub fn effective_date_table<'a>(
    facts: &'a ModelFacts,
    authored: &'a AuthoredKinds,
) -> Option<&'a str> {
    if facts.calendar_source == Some(CalendarSource::Declared) {
        return facts.date_table.as_deref();
    }
    authored
        .calendar
        .as_deref()
        .or_else(|| facts.date_table.as_deref())
}

// ---------------------------------------------------------------------------
// Which table is the calendar
// ---------------------------------------------------------------------------

/// Words that name a PART of a calendar, matched by WORD EQUALITY through the
/// same splitter the rest of the lexicons use.
///
/// Bilingual for the same reason every other lexicon in this layer is: a Swedish
/// model is the normal case here, not an edge case. The joined spellings
/// (`dayofweek`, `weekofyear`, `monthname`) are listed because `words()` cannot
/// split a name that carries no case change, space or separator.
const CALENDAR_PART_WORDS: &[&str] = &[
    "year",
    "quarter",
    "month",
    "week",
    "day",
    "dayofweek",
    "weekday",
    "monthname",
    "dayname",
    "weekofyear",
    "år",
    "kvartal",
    "månad",
    "vecka",
    "dag",
];

/// How many of a table's columns must read as calendar parts before it can be
/// guessed as the calendar.
///
/// TWO, because one is an ordinary attribute. A customer dimension carrying a
/// `BirthYear` is not a calendar; a table carrying a year AND a month is one
/// shape and one shape only. It is the cheapest guard against the failure mode
/// that matters — a WRONGLY chosen calendar is worse than none, because every
/// trend, change point and seasonality fact in the run is then computed against
/// an axis that is not time.
const MIN_CALENDAR_PART_COLUMNS: usize = 2;

/// Does this column name read as a calendar part?
fn names_a_calendar_part(column: &str) -> bool {
    let w = words(column);
    CALENDAR_PART_WORDS.iter().any(|t| has_term(&w, t))
}

/// The table that IS a calendar on a model whose author never marked one.
///
/// WHY THIS EXISTS AT ALL. Marking a date table is a step almost nobody takes —
/// `bi_model_set_date_table` puts it one dropdown away in the Model Editor's
/// Settings tab, and an ordinary imported star schema still arrives with no
/// mark. Without a `date_table` the
/// whole time-series half of the engine is switched off in silence: there is no
/// default time axis, so trend, seasonality and change-point facts have nothing
/// to compute against; `classify_table` never answers `Calendar`, so the role
/// ladder's calendar arm never fires; and `year`/`quarter`/`month`/`day` fall
/// through the String|Int allowlist to no role at all when a warehouse types
/// them `Decimal`. One rule here unlocks all of it.
///
/// THE DETECTION IS DELIBERATELY CONSERVATIVE, and every clause below is a
/// refusal rather than a preference:
///
///   * NEVER A FACT TABLE. A table filters flow OUT of is the grain of the
///     model, and a fact table with an order-date column is exactly the thing a
///     laxer rule would seize on.
///   * IT MUST ACTUALLY CARRY A DATE. A `Date`/`Timestamp` column, or a column
///     the author declared `DateKey`. A table of month names and years with no
///     date in it cannot be a time axis.
///   * IT MUST READ AS A CALENDAR, in at least `MIN_CALENDAR_PART_COLUMNS` of
///     its column names.
///   * AMBIGUITY REFUSES. Two qualifying tables (a role-playing order-date and
///     ship-date pair, say) means the choice is a business decision. Picking one
///     silently is the confident-wrong this layer exists to avoid, so it infers
///     NOTHING and the model keeps no calendar at all.
///
/// Everything it does infer is stamped `CalendarSource::Inferred`, and the
/// planner says so out loud when it plots a series against it.
fn infer_date_table(model: &DataModel, is_from: &BTreeSet<&str>) -> Option<String> {
    let mut found: Option<String> = None;
    for table in model.tables() {
        let name = table.name();
        if is_from.contains(name) {
            continue;
        }
        let carries_a_date = table.columns().iter().any(|c| {
            matches!(c.data_type(), DataType::Date | DataType::Timestamp)
                || c.date_role() == Some(DateRole::DateKey)
        });
        if !carries_a_date {
            continue;
        }
        let parts = table
            .columns()
            .iter()
            .filter(|c| names_a_calendar_part(c.name()))
            .count();
        if parts < MIN_CALENDAR_PART_COLUMNS {
            continue;
        }
        if found.is_some() {
            // A SECOND CANDIDATE ENDS THE SEARCH OUTRIGHT. Returning the first
            // would make the answer depend on table declaration order, which is
            // the worst possible way to decide what time means in a report.
            return None;
        }
        found = Some(name.to_string());
    }
    found
}

/// What a table is FOR, from its position in the relationship graph.
///
/// This is inference, not a declaration: the engine has no table-kind field.
/// The strategy document can override every one of these, and the Strategy tab
/// shows them as unreviewed until somebody confirms them.
fn classify_table(name: &str, date_table: Option<&str>, from_side: bool, to_side: bool) -> TableKind {
    if date_table == Some(name) {
        return TableKind::Calendar;
    }
    match (from_side, to_side) {
        // Filters flow out of it and nothing looks it up: the grain of the model.
        (true, false) => TableKind::Fact,
        // Looked up and looks nothing up: a leaf dimension.
        (false, true) => TableKind::Dimension,
        // Both — a snowflake intermediate or a many-to-many bridge. Either way
        // it is not a leaf dimension, and v1's single-hop decomposition cannot
        // reach through it, so naming it Bridge is what makes the validator able
        // to report an attribute behind it as unreachable instead of dropping it.
        (true, true) => TableKind::Bridge,
        (false, false) => TableKind::Other,
    }
}

/// The part of a format string that carries meaning rather than decoration.
///
/// A literal escaped percent (`\%`) or one inside quotes is decoration, not a
/// scale factor. Strip both before looking, or `#,##0" %"` reads as percent and
/// the value is reported a hundred times too small.
fn significant_of(format: &str) -> String {
    let mut significant = String::with_capacity(format.len());
    let mut chars = format.chars();
    let mut in_quotes = false;
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                chars.next();
            }
            '"' => in_quotes = !in_quotes,
            _ if in_quotes => {}
            _ => significant.push(c),
        }
    }
    significant
}

/// The unit a format string states OUTRIGHT: a literal `%`, a currency bracket
/// or a currency symbol.
///
/// This is the half of the format reading that OUTRANKS the name lexicon.
/// Somebody typed those characters; a name is a label the same person chose for
/// a different purpose, and it does not get to overrule a written `%`.
fn explicit_unit_from_format(format: &str) -> Option<Unit> {
    let significant = significant_of(format);
    if significant.contains('%') {
        return Some(Unit::Percent);
    }
    // `[$SEK-41d]` and friends: the engine carries the currency inside a bracket
    // section, and a bare currency symbol is the older spelling.
    let lower = significant.to_ascii_lowercase();
    if lower.contains("[$")
        || significant.contains('$')
        || significant.contains('€')
        || significant.contains('£')
        || lower.contains("kr")
    {
        return Some(Unit::Currency);
    }
    None
}

/// The unit a number-format string implies, reading the format ALONE.
///
/// Deliberately conservative. `None` means "we could not tell", and the
/// downstream effect is that a sentence says the bare number — which is never
/// wrong, only less helpful. Guessing `Percent` at a format that is not one
/// produces a sentence that is off by a factor of a hundred.
fn unit_from_format(format: &str) -> Option<Unit> {
    if let Some(explicit) = explicit_unit_from_format(format) {
        return Some(explicit);
    }
    let significant = significant_of(format);
    // An integer format with no decimal separator is a count often enough to be
    // worth saying, and being wrong costs only a rounding style in a sentence.
    //
    // THIS IS THE AMBIGUOUS CASE, and it is where the name gets a vote:
    // `#,##0` is what a whole-krona Revenue measure is formatted with just as
    // often as a row count, and reading it as a count made a measure named
    // Revenue infer as a COUNT.
    if !significant.is_empty()
        && significant.chars().all(|c| matches!(c, '#' | '0' | ',' | ' ' | '_' | '-' | '(' | ')'))
        && !significant.contains('.')
    {
        return Some(Unit::Count);
    }
    None
}

// ---------------------------------------------------------------------------
// The name lexicon
// ---------------------------------------------------------------------------

/// Terms whose presence in a measure NAME means the number is money. Bilingual,
/// for the same reason infer.rs's direction lexicon is: a Swedish model is the
/// normal case here.
const CURRENCY_NAME_TERMS: &[&str] = &[
    "revenue",
    "sales",
    "cost",
    "price",
    "amount",
    "margin",
    "profit",
    "spend",
    "intäkt",
    "omsättning",
    "kostnad",
    "pris",
    "belopp",
];

/// Terms whose presence means the number is a proportion.
///
/// "margin percent" needs no phrase entry of its own: `percent` is a term here,
/// and percent is CHECKED BEFORE currency, so a measure named "Margin Percent"
/// answers Percent rather than being claimed by the `margin` above.
const PERCENT_NAME_TERMS: &[&str] = &["rate", "share", "ratio", "percent", "andel", "andelen"];

/// Terms whose presence means the number is a count. `headcount` is spelled out
/// because the word-boundary rule is exactly what stops `count` from matching
/// inside it — the same discipline that keeps "Costa Rica Sales" out of the cost
/// lexicon.
const COUNT_NAME_TERMS: &[&str] = &["count", "antal", "headcount"];

/// Phrases whose presence means a count, matched as CONSECUTIVE words.
const COUNT_NAME_PHRASES: &[&[&str]] = &[&["number", "of"]];

/// The unit a measure's NAME implies, or `None` when it says nothing.
///
/// Word boundaries, via the same splitter `infer_direction` uses: a substring
/// match makes "Costa Rica Sales" a cost measure and "Shareholder" a percentage.
///
/// ORDER: percent, then count, then currency. Percent leads because it is the
/// most specific vocabulary and the most expensive to lose - a ratio reported as
/// money is a sentence off by the magnitude of the base. Count leads currency so
/// that "Order Count" and "Sales Count" answer Count rather than being claimed by
/// the broad money vocabulary, which is the widest list here and would otherwise
/// swallow them.
fn unit_from_name(name: &str) -> Option<Unit> {
    let words = words(name);
    if PERCENT_NAME_TERMS.iter().any(|t| has_term(&words, t)) {
        return Some(Unit::Percent);
    }
    if COUNT_NAME_TERMS.iter().any(|t| has_term(&words, t))
        || COUNT_NAME_PHRASES.iter().any(|p| has_phrase(&words, p))
    {
        return Some(Unit::Count);
    }
    if CURRENCY_NAME_TERMS.iter().any(|t| has_term(&words, t)) {
        return Some(Unit::Currency);
    }
    None
}

/// The unit of one measure, from its format and its name.
///
/// THE PRECEDENCE IS THE WHOLE DESIGN, and it runs in this order:
///
/// 1. An EXPLICIT format signal - a literal `%`, a currency bracket or symbol.
///    A person who wrote the format meant it, and no name may overrule it: a
///    measure called "Revenue Share" formatted `0.0%` is a percentage.
/// 2. The NAME lexicon. It decides only where the format was AMBIGUOUS or
///    absent, which is exactly the case that produced the defect: `#,##0` on a
///    measure named Revenue was read as a COUNT, because an integer format is
///    the only thing the format reading had left to say.
/// 3. The format's ambiguous reading (integer-only means a count), for a name
///    that says nothing either way.
///
/// The DESCRIPTION is deliberately not consulted, unlike in `infer_direction`. A
/// name is the label the author chose for this number; a description is prose
/// ABOUT it, and it routinely mentions other quantities ("number of orders where
/// the amount exceeds...") that would answer for the measure itself.
fn infer_unit(name: &str, format: Option<&str>) -> Option<Unit> {
    if let Some(explicit) = format.and_then(explicit_unit_from_format) {
        return Some(explicit);
    }
    unit_from_name(name).or_else(|| format.and_then(unit_from_format))
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::types::{Direction, TableStrategy};
    use bi_engine::{
        sum_measure, Column, DataType, Hierarchy, HierarchyLevel, Kpi, Relationship, StatusBand,
        Table,
    };

    /// Sales -> Product (many-to-one), Sales -> Date (many-to-one), Date marked.
    ///
    /// `kpi` is threaded through rather than added afterwards because the
    /// builder consumes itself and there is no "from an existing model" entry
    /// point; re-stating the star in three tests would be worse.
    fn a_small_star_with(kpi: Option<Kpi>) -> DataModel {
        let mut builder = DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("Amount", DataType::Float64),
                        Column::new("ProductKey", DataType::Int64),
                        Column::new("Date", DataType::Date),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Product",
                    vec![
                        Column::new("ProductKey", DataType::Int64),
                        Column::new("Category", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Date",
                    vec![
                        Column::new("Date", DataType::Date),
                        Column::new("Month", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(Relationship::many_to_one(
                "Sales_Product",
                "Sales",
                "ProductKey",
                "Product",
                "ProductKey",
            ))
            .add_relationship(Relationship::many_to_one(
                "Sales_Date", "Sales", "Date", "Date", "Date",
            ))
            .mark_date_table("Date")
            .add_measure(sum_measure("Revenue", "Sales", "Amount"));
        if let Some(k) = kpi {
            builder = builder.add_kpi(k);
        }
        builder.build().expect("the fixture star schema builds")
    }

    fn a_small_star() -> DataModel {
        a_small_star_with(None)
    }

    #[test]
    fn the_marked_date_table_is_a_calendar_even_though_it_is_also_looked_up() {
        let facts = facts_from_model(&a_small_star());
        assert_eq!(facts.date_table.as_deref(), Some("Date"));
        assert_eq!(facts.tables["Date"].kind, Some(TableKind::Calendar));
    }

    #[test]
    fn the_from_side_is_the_fact_and_the_to_side_is_the_dimension() {
        let facts = facts_from_model(&a_small_star());
        assert_eq!(facts.tables["Sales"].kind, Some(TableKind::Fact));
        assert_eq!(facts.tables["Product"].kind, Some(TableKind::Dimension));
    }

    #[test]
    fn every_column_of_every_table_is_reachable_by_name() {
        let facts = facts_from_model(&a_small_star());
        assert!(facts.has_column(&QualifiedColumn::new("Product", "Category")));
        assert!(!facts.has_column(&QualifiedColumn::new("Product", "Colour")));
    }

    #[test]
    fn a_relationship_becomes_a_column_pair_the_resolver_can_walk() {
        let facts = facts_from_model(&a_small_star());
        let pair = (
            QualifiedColumn::new("Sales", "ProductKey"),
            QualifiedColumn::new("Product", "ProductKey"),
        );
        assert!(facts.relationships.contains(&pair), "{:?}", facts.relationships);
    }

    #[test]
    fn members_are_left_unknown_rather_than_reported_as_none() {
        // The distinction matters: an EMPTY member list would let the resolver
        // conclude a rule covers every member of a column, which is how a
        // mixed-direction suppression gets skipped and a wrong favourability
        // ships.
        let facts = facts_from_model(&a_small_star());
        assert!(facts
            .known_members(&QualifiedColumn::new("Product", "Category"))
            .is_none());
    }

    #[test]
    fn a_measure_carries_the_table_it_aggregates_over() {
        let facts = facts_from_model(&a_small_star());
        assert_eq!(
            facts.measures["Revenue"].fact_table.as_deref(),
            Some("Sales")
        );
    }

    #[test]
    fn a_kpis_target_and_band_statuses_reach_the_resolver() {
        let model = a_small_star_with(Some(
            Kpi::new("Revenue KPI", "Revenue", KpiTarget::Constant(1000.0))
                .with_status_band(StatusBand::new(0.8, KpiStatus::OffTrack))
                .with_status_band(StatusBand::new(0.95, KpiStatus::AtRisk))
                .with_status_band(StatusBand::new(1.0, KpiStatus::OnTrack)),
        ));
        let facts = facts_from_model(&model);
        let kpi = facts.measures["Revenue"].kpi.as_ref().expect("the KPI is indexed by its base measure");
        assert_eq!(kpi.target, Some(1000.0));
        assert_eq!(
            kpi.bands,
            vec![
                KpiBand::new(0.8, BandStatus::OffTrack),
                KpiBand::new(0.95, BandStatus::AtRisk),
                KpiBand::new(1.0, BandStatus::OnTrack),
            ],
            "the STATUS has to survive the crossing; the threshold alone says nothing"
        );
        assert_eq!(kpi.direction(), Some(Direction::HigherIsBetter));
    }

    #[test]
    fn a_kpi_whose_bands_worsen_upward_crosses_as_lower_is_better() {
        // The engine refuses non-ascending THRESHOLDS, so this is what a churn
        // KPI has to look like: thresholds up, statuses down. Reading thresholds
        // alone reported higherIsBetter for exactly this shape.
        let model = a_small_star_with(Some(
            Kpi::new("Churn KPI", "Revenue", KpiTarget::Constant(0.05))
                .with_status_band(StatusBand::new(0.5, KpiStatus::OnTrack))
                .with_status_band(StatusBand::new(0.8, KpiStatus::AtRisk))
                .with_status_band(StatusBand::new(1.0, KpiStatus::OffTrack)),
        ));
        let facts = facts_from_model(&model);
        let kpi = facts.measures["Revenue"].kpi.as_ref().unwrap();
        assert_eq!(kpi.direction(), Some(Direction::LowerIsBetter));
    }

    #[test]
    fn the_models_own_hierarchies_reach_the_facts_in_level_order() {
        // Validation reads hierarchy membership from here, so a level the model
        // declares is scopable even in a document that has no `hierarchies` of
        // its own.
        let model = a_small_star().with_hierarchies(vec![Hierarchy::new(
            "Calendar",
            "Date",
            vec![HierarchyLevel::new("Month"), HierarchyLevel::new("Date")],
        )]);
        let facts = facts_from_model(&model);
        assert_eq!(
            facts.tables["Date"].hierarchies,
            vec![vec!["Month".to_string(), "Date".to_string()]],
            "coarse-to-fine, in the order the engine declares the levels"
        );
        assert!(facts.tables["Product"].hierarchies.is_empty());
        assert!(facts.in_a_hierarchy(&QualifiedColumn::new("Date", "Month")));
    }

    #[test]
    fn a_measure_valued_kpi_target_is_unknown_rather_than_zero() {
        // The target measure has to EXIST — the model builder validates that —
        // so this points at the only other measure in the fixture. The point of
        // the test is unchanged: a measure-valued target is not a number until a
        // query has run, so nothing here may report one.
        let model = a_small_star_with(Some(Kpi::new(
            "Revenue KPI",
            "Revenue",
            KpiTarget::Measure("Revenue".to_string()),
        )));
        let facts = facts_from_model(&model);
        assert_eq!(facts.measures["Revenue"].kpi.as_ref().unwrap().target, None);
    }

    #[test]
    fn a_percent_format_is_a_percent_and_a_quoted_percent_sign_is_not() {
        assert_eq!(unit_from_format("0.0%"), Some(Unit::Percent));
        // The trap: this format shows a NUMBER with the word-like suffix " %"
        // pinned on. Reading it as a percent scales the sentence by 100.
        assert_eq!(unit_from_format("#,##0\" %\""), Some(Unit::Count));
        assert_eq!(unit_from_format("#,##0\\%"), Some(Unit::Count));
    }

    #[test]
    fn a_currency_format_is_currency_in_both_spellings() {
        assert_eq!(unit_from_format("[$SEK-41d] #,##0"), Some(Unit::Currency));
        assert_eq!(unit_from_format("$#,##0.00"), Some(Unit::Currency));
    }

    #[test]
    fn a_format_that_says_nothing_useful_returns_no_unit_rather_than_guessing() {
        assert_eq!(unit_from_format("0.000"), None);
        assert_eq!(unit_from_format("General"), None);
    }

    // --- the name lexicon ----------------------------------------------------

    #[test]
    fn a_revenue_measure_formatted_as_a_plain_integer_is_currency_and_not_a_count() {
        // THE DEFECT. `#,##0` is what a whole-krona money measure is formatted
        // with, and reading the format alone answered COUNT for a measure named
        // Revenue - visible in the Strategy tab as "Revenue: count".
        assert_eq!(infer_unit("Revenue", Some("#,##0")), Some(Unit::Currency));
        assert_eq!(
            unit_from_format("#,##0"),
            Some(Unit::Count),
            "the format reading itself is unchanged; the NAME is what breaks the tie"
        );
        // ...and a name that says nothing still lets the ambiguous format answer.
        assert_eq!(infer_unit("Widgets", Some("#,##0")), Some(Unit::Count));
    }

    #[test]
    fn an_explicit_format_signal_outranks_the_name() {
        // A person who wrote a `%` meant it. The name may only decide where the
        // format was ambiguous, or it would silently rescale a real percentage.
        assert_eq!(infer_unit("Revenue Share", Some("0.0%")), Some(Unit::Percent));
        assert_eq!(infer_unit("Revenue", Some("0.0%")), Some(Unit::Percent));
        assert_eq!(
            infer_unit("Order Count", Some("[$SEK-41d] #,##0")),
            Some(Unit::Currency)
        );
        // The DECORATIVE percent is not an explicit signal, so the name still
        // answers - and does not turn `#,##0" %"` into a rescaled percentage.
        assert_eq!(infer_unit("Revenue", Some("#,##0\" %\"")), Some(Unit::Currency));
    }

    #[test]
    fn the_name_lexicon_matches_whole_words_in_both_languages() {
        // The substring trap, the same one infer.rs's direction lexicon carries:
        // "Costa" must not read as "cost", and "Shareholder" must not read as
        // "share".
        assert_eq!(infer_unit("Costa Rica Sales", None), Some(Unit::Currency));
        assert_eq!(infer_unit("Shareholder", None), None);
        assert_eq!(infer_unit("Omsättning", None), Some(Unit::Currency));
        assert_eq!(infer_unit("Antal Ordrar", None), Some(Unit::Count));
        assert_eq!(infer_unit("Andel Nordics", None), Some(Unit::Percent));
        // A name with no term at all says nothing, and a measure with neither a
        // name term nor a format is left with no unit rather than a guess.
        assert_eq!(infer_unit("Widgets", None), None);
    }

    #[test]
    fn percent_outranks_currency_and_count_outranks_currency_in_the_name() {
        // "Margin Percent" carries both a money word and a proportion word; the
        // ORDER is what decides, and it is the order that costs least when wrong.
        assert_eq!(infer_unit("Margin Percent", None), Some(Unit::Percent));
        assert_eq!(infer_unit("Margin", None), Some(Unit::Currency));
        assert_eq!(infer_unit("Sales Count", None), Some(Unit::Count));
        assert_eq!(infer_unit("Number of Orders", None), Some(Unit::Count));
        // ...and "headcount" is its own term, because word boundaries mean
        // "count" does not match inside it.
        assert_eq!(infer_unit("Headcount", None), Some(Unit::Count));
    }

    // --- which table is the calendar ----------------------------------------

    /// A warehouse `dim_date`: a surrogate key, one real date, and calendar
    /// parts typed `Decimal(38,10)` the way a star schema imported from a
    /// database actually types them. NOTHING marks it.
    ///
    /// Marking a date table is possible from the Model Editor
    /// (`bi_model_set_date_table`) and is a step almost nobody takes, so this —
    /// not the marked star above — is what an ordinary imported model looks like.
    fn an_unmarked_warehouse_calendar() -> DataModel {
        DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("Amount", DataType::Float64),
                        Column::new("DateKey", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "dim_date",
                    vec![
                        Column::new("date_key", DataType::Int64),
                        Column::new("full_date", DataType::Date),
                        Column::new("year", DataType::Decimal(38, 10)),
                        Column::new("quarter", DataType::Decimal(38, 10)),
                        Column::new("month", DataType::Decimal(38, 10)),
                        Column::new("day", DataType::Decimal(38, 10)),
                        Column::new("week_of_year", DataType::Decimal(38, 10)),
                        Column::new("month_name", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(Relationship::many_to_one(
                "Sales_Date",
                "Sales",
                "DateKey",
                "dim_date",
                "date_key",
            ))
            .add_measure(sum_measure("Revenue", "Sales", "Amount"))
            .build()
            .expect("the unmarked warehouse calendar fixture builds")
    }

    /// The same warehouse calendar, but MARKED in the Model Editor.
    ///
    /// The mark is what separates the two demotion cases: against a guess the
    /// document wins, against a declaration it does not.
    fn a_marked_warehouse_calendar() -> DataModel {
        DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("Amount", DataType::Float64),
                        Column::new("DateKey", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "dim_date",
                    vec![
                        Column::new("date_key", DataType::Int64),
                        Column::new("full_date", DataType::Date),
                        Column::new("year", DataType::Decimal(38, 10)),
                        Column::new("quarter", DataType::Decimal(38, 10)),
                        Column::new("month", DataType::Decimal(38, 10)),
                        Column::new("day", DataType::Decimal(38, 10)),
                        Column::new("week_of_year", DataType::Decimal(38, 10)),
                        Column::new("month_name", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(Relationship::many_to_one(
                "Sales_Date",
                "Sales",
                "DateKey",
                "dim_date",
                "date_key",
            ))
            .mark_date_table("dim_date")
            .add_measure(sum_measure("Revenue", "Sales", "Amount"))
            .build()
            .expect("the marked warehouse calendar fixture builds")
    }

    #[test]
    fn an_unmarked_warehouse_date_table_is_inferred_and_stamped_as_a_guess() {
        let facts = facts_from_model(&an_unmarked_warehouse_calendar());
        assert_eq!(facts.date_table.as_deref(), Some("dim_date"));
        assert_eq!(facts.calendar_source, Some(CalendarSource::Inferred));
        // ...and the classification cascades from it: without this the table
        // would be an ordinary Dimension and the role ladder's calendar arm
        // would never fire.
        assert_eq!(facts.tables["dim_date"].kind, Some(TableKind::Calendar));
    }

    #[test]
    fn demoting_a_guessed_calendar_takes_the_time_axis_away_and_the_run_says_so() {
        // THE DIRECTION THE PROMOTION TESTS DO NOT COVER. `Dimension -> Calendar`
        // only ADDS an axis; this takes one away, and with it every trend,
        // change point and seasonality claim for every measure - a large,
        // silent consequence for one dropdown, which is why the run has to say
        // it out loud.
        let model = an_unmarked_warehouse_calendar();
        let doc = doc_with_kind("dim_date", TableKind::Dimension);
        let (facts, authored) = facts_with_authored_kinds(&model, &doc);

        assert_eq!(
            facts.date_table, None,
            "a person saying 'that is not the calendar' outranks a heuristic that guessed it was"
        );
        assert_eq!(facts.calendar_source, None);
        assert_eq!(facts.tables["dim_date"].kind, Some(TableKind::Dimension));
        assert_eq!(
            authored.demoted_guess.as_deref(),
            Some("dim_date"),
            "and it is RECORDED, because an absence cannot announce itself"
        );
        assert!(
            authored.conflicts.is_empty(),
            "nothing refused it - it took effect, which is exactly why it needs a note \
             rather than a finding"
        );
    }

    #[test]
    fn demoting_the_models_own_declared_date_table_is_refused_and_time_still_runs_along_it() {
        // The other half of the precedence. A DECLARATION is a human statement
        // made in the Model Editor, so it outranks this one - the same way it
        // outranks an authored `Calendar` elsewhere in this file. The engine's
        // own time intelligence resolves against `model.date_table()` and
        // nothing else, so honouring the demotion here would leave the report
        // and the engine disagreeing about what time means.
        let model = a_marked_warehouse_calendar();
        let doc = doc_with_kind("dim_date", TableKind::Dimension);
        let (facts, authored) = facts_with_authored_kinds(&model, &doc);

        assert_eq!(facts.date_table.as_deref(), Some("dim_date"));
        assert_eq!(facts.calendar_source, Some(CalendarSource::Declared));
        assert_eq!(
            facts.tables["dim_date"].kind,
            Some(TableKind::Calendar),
            "the refused kind must not reach the map, or the calendar arm of the role \
             ladder stops firing on the table time actually runs along"
        );
        assert_eq!(authored.demoted_guess, None, "nothing was demoted");
        assert_eq!(
            authored
                .conflicts
                .iter()
                .map(|c| (c.table.as_str(), &c.refusal))
                .collect::<Vec<_>>(),
            vec![("dim_date", &KindRefusal::TheModelDeclaresItTheDateTable)]
        );
    }

    #[test]
    fn a_declared_date_table_wins_even_when_another_table_looks_more_like_one() {
        // `Kalender` carries a date and one calendar word; `dim_date` carries a
        // date and six. The heuristic would prefer `dim_date` and it does not
        // get a vote: a mark is the author's own statement.
        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("Amount", DataType::Float64),
                        Column::new("DateKey", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Kalender",
                    vec![
                        Column::new("datum", DataType::Date),
                        Column::new("år", DataType::Int32),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "dim_date",
                    vec![
                        Column::new("date_key", DataType::Int64),
                        Column::new("full_date", DataType::Date),
                        Column::new("year", DataType::Int32),
                        Column::new("quarter", DataType::Int32),
                        Column::new("month", DataType::Int32),
                        Column::new("day", DataType::Int32),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(Relationship::many_to_one(
                "Sales_Date",
                "Sales",
                "DateKey",
                "dim_date",
                "date_key",
            ))
            .mark_date_table("Kalender")
            .add_measure(sum_measure("Revenue", "Sales", "Amount"))
            .build()
            .expect("the declared-vs-better-looking fixture builds");
        let facts = facts_from_model(&model);
        assert_eq!(facts.date_table.as_deref(), Some("Kalender"));
        assert_eq!(facts.calendar_source, Some(CalendarSource::Declared));
        assert_eq!(facts.tables["dim_date"].kind, Some(TableKind::Dimension));
    }

    /// A role-playing pair: order date and ship date, both shaped exactly like a
    /// calendar, and nothing marked.
    ///
    /// The heuristic REFUSES this model (two candidates), which is what makes it
    /// the fixture for the authored kind as well: it is the shape where a person
    /// has something to add that no rule can work out for them.
    fn a_role_playing_pair() -> DataModel {
        let mut builder = DataModel::builder().add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("Amount", DataType::Float64),
                    Column::new("OrderDateKey", DataType::Int64),
                    Column::new("ShipDateKey", DataType::Int64),
                ],
            )
            .unwrap(),
        );
        for name in ["dim_order_date", "dim_ship_date"] {
            builder = builder.add_table(
                Table::new(
                    name,
                    vec![
                        Column::new("date_key", DataType::Int64),
                        Column::new("full_date", DataType::Date),
                        Column::new("year", DataType::Int32),
                        Column::new("month", DataType::Int32),
                    ],
                )
                .unwrap(),
            );
        }
        builder
            .add_relationship(Relationship::many_to_one(
                "Sales_Order",
                "Sales",
                "OrderDateKey",
                "dim_order_date",
                "date_key",
            ))
            .add_relationship(Relationship::many_to_one(
                "Sales_Ship",
                "Sales",
                "ShipDateKey",
                "dim_ship_date",
                "date_key",
            ))
            .add_measure(sum_measure("Revenue", "Sales", "Amount"))
            .build()
            .expect("the role-playing fixture builds")
    }

    #[test]
    fn two_candidate_calendars_infer_neither_rather_than_picking_one() {
        // A role-playing pair: order date and ship date, both shaped exactly
        // like a calendar. WHICH ONE time runs along is a business decision, and
        // answering it from table declaration order would be the confident-wrong
        // this whole layer exists to avoid.
        let facts = facts_from_model(&a_role_playing_pair());
        assert_eq!(facts.date_table, None, "ambiguity refuses");
        assert_eq!(facts.calendar_source, None);
        assert_eq!(facts.tables["dim_order_date"].kind, Some(TableKind::Dimension));
    }

    #[test]
    fn a_fact_table_carrying_a_date_and_calendar_names_is_never_the_calendar() {
        // The trap a laxer rule falls into: a wide fact table often carries an
        // order date AND denormalised year/month columns. Filters flow OUT of
        // it, which is what makes it the grain rather than an axis.
        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("Amount", DataType::Float64),
                        Column::new("order_date", DataType::Date),
                        Column::new("year", DataType::Int32),
                        Column::new("month", DataType::Int32),
                        Column::new("ProductKey", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Product",
                    vec![
                        Column::new("ProductKey", DataType::Int64),
                        Column::new("Category", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(Relationship::many_to_one(
                "Sales_Product",
                "Sales",
                "ProductKey",
                "Product",
                "ProductKey",
            ))
            .add_measure(sum_measure("Revenue", "Sales", "Amount"))
            .build()
            .expect("the denormalised fact fixture builds");
        let facts = facts_from_model(&model);
        assert_eq!(facts.date_table, None);
        assert_eq!(facts.tables["Sales"].kind, Some(TableKind::Fact));
    }

    #[test]
    fn a_dimension_with_a_date_but_no_calendar_vocabulary_is_not_the_calendar() {
        // The other half of the conservatism: a customer dimension has a
        // `created_at` and is not a calendar. One calendar-ish column would not
        // be enough either — `MIN_CALENDAR_PART_COLUMNS` is two.
        let model = a_small_star();
        assert_eq!(facts_from_model(&model).date_table.as_deref(), Some("Date"));

        let unmarked = DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("Amount", DataType::Float64),
                        Column::new("CustomerKey", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Customer",
                    vec![
                        Column::new("CustomerKey", DataType::Int64),
                        Column::new("Segment", DataType::String),
                        Column::new("BirthYear", DataType::Int32),
                        Column::new("created_at", DataType::Date),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(Relationship::many_to_one(
                "Sales_Customer",
                "Sales",
                "CustomerKey",
                "Customer",
                "CustomerKey",
            ))
            .add_measure(sum_measure("Revenue", "Sales", "Amount"))
            .build()
            .expect("the customer-dimension fixture builds");
        let facts = facts_from_model(&unmarked);
        assert_eq!(
            facts.date_table, None,
            "one year column is an attribute, not a calendar"
        );
    }

    #[test]
    fn a_measures_name_reaches_the_facts_the_resolver_reads() {
        // End to end: the lexicon is only worth anything if it survives the
        // crossing into `ModelFacts`, which is what the whole strategy layer
        // resolves against.
        let model = a_small_star();
        let facts = facts_from_model(&model);
        assert_eq!(
            facts.measures["Revenue"].unit,
            Some(Unit::Currency),
            "the fixture measure carries no format string at all, so the name is \
             the only thing that can answer"
        );
    }

    // --- the table kinds a person typed --------------------------------------

    /// A document whose only content is one AUTHORED table kind.
    fn doc_with_kind(table: &str, kind: TableKind) -> StrategyDoc {
        let mut doc = StrategyDoc::default();
        doc.tables.insert(
            table.to_string(),
            TableStrategy {
                kind: Some(kind),
                reviewed: true,
                source: Some(EntrySource::Authored),
                ..Default::default()
            },
        );
        doc
    }

    #[test]
    fn the_lookup_tables_are_the_to_one_sides_and_nothing_else() {
        // The set that DISPROVES an authored kind, so it is worth pinning on its
        // own: a table is a lookup when something points at it through a to-one
        // relationship, and the fact table it is pointed at FROM is not one.
        let facts = facts_from_model(&a_small_star());
        assert_eq!(
            facts.lookup_tables,
            BTreeSet::from(["Product".to_string(), "Date".to_string()])
        );
    }

    #[test]
    fn fact_bridge_and_other_are_taken_as_written_on_the_grain_while_dimension_and_calendar_are_refused_there(
    ) {
        // WHAT THIS FUNCTION'S HEADER MEANS BY "INERT". `Sales` is the FROM side
        // of both relationships in the fixture, so nothing looks it up. Three of
        // the five kinds assert nothing a join DIRECTION can contradict, so they
        // are accepted and produce no conflict — and a conflict is the only route
        // by which a non-calendar kind reaches a reader at all
        // (`kind_conflict_notes`, model_commands.rs). The two that claim the
        // model can look the table up are refused on the same fixture.
        let facts = facts_from_model(&a_small_star());
        for inert in [TableKind::Fact, TableKind::Bridge, TableKind::Other] {
            let doc = doc_with_kind("Sales", inert);
            let judged = authored_table_kinds(&facts, &doc, None);
            assert!(
                judged.conflicts.is_empty(),
                "'{}' claims nothing the topology can disprove, so it cannot be refused: {:?}",
                inert.label(),
                judged.conflicts
            );
            assert_eq!(judged.accepted.get("Sales"), Some(&inert));
            assert_eq!(judged.calendar, None);

            // And it moves nothing else: the calendar the model declared is
            // still the calendar, so no trend, change point or seasonality
            // claim in the report can shift because of this entry.
            let with_doc = facts_from_model_with(&a_small_star(), &doc);
            assert_eq!(with_doc.date_table.as_deref(), Some("Date"));
            assert_eq!(with_doc.calendar_source, Some(CalendarSource::Declared));
            assert_eq!(with_doc.tables["Sales"].kind, Some(inert));
        }
        for claims_a_lookup in [TableKind::Dimension, TableKind::Calendar] {
            let judged =
                authored_table_kinds(&facts, &doc_with_kind("Sales", claims_a_lookup), None);
            assert_eq!(
                judged.conflicts.len(),
                1,
                "'{}' says the model can look 'Sales' up, and the joins say it cannot",
                claims_a_lookup.label()
            );
            assert!(judged.accepted.is_empty());
        }
    }

    #[test]
    fn a_many_to_many_end_is_not_a_lookup_and_cannot_be_authored_a_dimension() {
        // WHY `lookup_tables` IS STORED RATHER THAN READ BACK OFF
        // `facts.relationships`. Those pairs keep no cardinality, so a to-side
        // read off them would count this bridge - and offering a many-to-many
        // end as an analysis axis is the exact failure `is_to` was written to
        // avoid. A person authoring `dimension` on it must hit the same refusal.
        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("Amount", DataType::Float64),
                        Column::new("BasketId", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Basket",
                    vec![
                        Column::new("BasketId", DataType::Int64),
                        Column::new("Channel", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(Relationship::new(
                "Sales_Basket",
                "Sales",
                "BasketId",
                "Basket",
                "BasketId",
                Cardinality::ManyToMany,
            ))
            .add_measure(sum_measure("Revenue", "Sales", "Amount"))
            .build()
            .expect("the many-to-many fixture builds");

        let facts = facts_from_model(&model);
        assert!(facts.lookup_tables.is_empty(), "{:?}", facts.lookup_tables);

        let doc = doc_with_kind("Basket", TableKind::Dimension);
        let judged = authored_table_kinds(&facts, &doc, None);
        assert!(judged.accepted.is_empty());
        assert_eq!(judged.conflicts.len(), 1);
        assert_eq!(
            judged.conflicts[0].refusal,
            // Nothing points at Basket through a to-one relationship, and Basket
            // filters nothing either — so the message has no join to quote and
            // says so rather than inventing one.
            KindRefusal::NothingLooksItUp { filters: None }
        );
    }

    #[test]
    fn an_authored_calendar_wins_where_the_heuristic_refused_to_choose() {
        // THE CASE THE SEAM EXISTS FOR. Two role-playing date tables, so
        // `infer_date_table` refuses and the model has no time axis at all. A
        // person says which one it is; from then on the whole cascade below
        // `facts.date_table` follows.
        let model = a_role_playing_pair();
        assert_eq!(
            facts_from_model(&model).date_table,
            None,
            "the control: with no document there is still no calendar"
        );

        let doc = doc_with_kind("dim_order_date", TableKind::Calendar);
        let facts = facts_from_model_with(&model, &doc);
        assert_eq!(facts.date_table.as_deref(), Some("dim_order_date"));
        assert_eq!(
            facts.calendar_source,
            Some(CalendarSource::Authored),
            "a chosen calendar is neither a declaration nor a guess, and the \
             planner's note says which it was"
        );
        assert_eq!(facts.tables["dim_order_date"].kind, Some(TableKind::Calendar));
        assert_eq!(
            facts.tables["dim_ship_date"].kind,
            Some(TableKind::Dimension),
            "the other one is untouched"
        );
    }

    #[test]
    fn an_authored_calendar_on_a_fact_table_is_refused_and_never_becomes_the_calendar() {
        // Filters flow out of Sales and nothing looks it up. That is not a
        // heuristic to be overruled; it is the join direction, and the document
        // does not get to contradict it.
        let model = a_role_playing_pair();
        let doc = doc_with_kind("Sales", TableKind::Calendar);

        let judged = authored_table_kinds(&facts_from_model(&model), &doc, None);
        assert!(judged.accepted.is_empty());
        assert_eq!(judged.calendar, None);
        assert_eq!(judged.conflicts.len(), 1);
        assert_eq!(judged.conflicts[0].table, "Sales");
        assert_eq!(
            judged.conflicts[0].refusal,
            KindRefusal::NothingLooksItUp {
                // The SMALLEST of the tables it filters, so the sentence a user
                // reads does not depend on relationship declaration order.
                filters: Some("dim_order_date".to_string())
            }
        );

        let facts = facts_from_model_with(&model, &doc);
        assert_eq!(facts.date_table, None, "a refused claim cascades nowhere");
        assert_eq!(facts.tables["Sales"].kind, Some(TableKind::Fact));
    }

    #[test]
    fn two_authored_calendars_apply_neither_and_report_both() {
        let model = a_role_playing_pair();
        let mut doc = doc_with_kind("dim_order_date", TableKind::Calendar);
        doc.tables.insert(
            "dim_ship_date".to_string(),
            doc.tables["dim_order_date"].clone(),
        );

        let judged = authored_table_kinds(&facts_from_model(&model), &doc, None);
        assert_eq!(judged.calendar, None);
        assert!(judged.accepted.is_empty());
        assert_eq!(
            judged
                .conflicts
                .iter()
                .map(|c| c.table.as_str())
                .collect::<Vec<_>>(),
            vec!["dim_order_date", "dim_ship_date"],
            "both are refused - picking one would answer a business question by \
             sort order"
        );

        let facts = facts_from_model_with(&model, &doc);
        assert_eq!(facts.date_table, None);
        assert_eq!(facts.tables["dim_order_date"].kind, Some(TableKind::Dimension));
        assert_eq!(facts.tables["dim_ship_date"].kind, Some(TableKind::Dimension));
    }

    #[test]
    fn an_authored_kind_that_agrees_with_detection_changes_nothing_at_all() {
        // Whole-struct equality on purpose: "changes nothing" has to mean the
        // facts are the same facts, not merely that the kind came out the same.
        let model = a_role_playing_pair();
        let doc = doc_with_kind("dim_order_date", TableKind::Dimension);
        assert_eq!(facts_from_model_with(&model, &doc), facts_from_model(&model));
    }

    #[test]
    fn an_inferred_entry_is_a_copy_of_the_derivation_and_never_overrules_it() {
        // `infer` stamps every table it drafts `Inferred`. Honouring that copy
        // would let a draft taken against an older model pin a kind the current
        // relationship graph contradicts - the document winning by being stale.
        let model = a_role_playing_pair();
        let mut doc = doc_with_kind("dim_order_date", TableKind::Calendar);
        doc.tables.get_mut("dim_order_date").unwrap().source = Some(EntrySource::Inferred);

        let judged = authored_table_kinds(&facts_from_model(&model), &doc, None);
        assert!(judged.accepted.is_empty());
        assert!(judged.conflicts.is_empty(), "ignored, not refused");
        assert_eq!(facts_from_model_with(&model, &doc), facts_from_model(&model));
    }

    #[test]
    fn a_document_with_no_source_field_at_all_counts_as_authored() {
        // A hand-written strategy file has no `source`, and somebody typed it.
        // Only `inferred` is excluded.
        let model = a_role_playing_pair();
        let mut doc = doc_with_kind("dim_order_date", TableKind::Calendar);
        doc.tables.get_mut("dim_order_date").unwrap().source = None;
        assert_eq!(
            facts_from_model_with(&model, &doc).date_table.as_deref(),
            Some("dim_order_date")
        );
    }

    #[test]
    fn the_models_own_mark_outranks_an_authored_calendar_but_the_kind_still_lands() {
        // TWO HUMAN STATEMENTS, and the model's wins. `mark_date_table` is not
        // just another opinion: the engine's time intelligence resolves against
        // it and nothing else, so moving the calendar from the annotation layer
        // would plot the report along one table while TOTALYTD computed along
        // another. The authored kind still applies to the table it names - the
        // person is not wrong that it looks like a calendar - and `validate.rs`
        // raises the warning that names both.
        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("Amount", DataType::Float64),
                        Column::new("DateKey", DataType::Int64),
                        Column::new("KalenderKey", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Kalender",
                    vec![
                        Column::new("kalender_key", DataType::Int64),
                        Column::new("datum", DataType::Date),
                        Column::new("år", DataType::Int32),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "dim_date",
                    vec![
                        Column::new("date_key", DataType::Int64),
                        Column::new("full_date", DataType::Date),
                        Column::new("year", DataType::Int32),
                        Column::new("month", DataType::Int32),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(Relationship::many_to_one(
                "Sales_Date",
                "Sales",
                "DateKey",
                "dim_date",
                "date_key",
            ))
            .add_relationship(Relationship::many_to_one(
                "Sales_Kalender",
                "Sales",
                "KalenderKey",
                "Kalender",
                "kalender_key",
            ))
            .mark_date_table("Kalender")
            .add_measure(sum_measure("Revenue", "Sales", "Amount"))
            .build()
            .expect("the declared-versus-authored fixture builds");

        let facts = facts_from_model_with(&model, &doc_with_kind("dim_date", TableKind::Calendar));
        assert_eq!(facts.date_table.as_deref(), Some("Kalender"));
        assert_eq!(facts.calendar_source, Some(CalendarSource::Declared));
        assert_eq!(facts.tables["Kalender"].kind, Some(TableKind::Calendar));
        assert_eq!(facts.tables["dim_date"].kind, Some(TableKind::Calendar));
    }

    #[test]
    fn judging_the_same_document_twice_reaches_the_same_verdict() {
        // The validator is handed RAW facts and the run builds OVERRIDDEN ones.
        // If a refusal quietly disappeared once the accepted kinds were applied,
        // the two would disagree about the same document - which is the shape of
        // the defect this whole seam fixes.
        let model = a_role_playing_pair();
        let mut doc = doc_with_kind("Sales", TableKind::Calendar);
        doc.tables.insert(
            "dim_order_date".to_string(),
            doc.tables["Sales"].clone(),
        );

        let raw = authored_table_kinds(&facts_from_model(&model), &doc, None);
        let applied = authored_table_kinds(&facts_from_model_with(&model, &doc), &doc, None);
        assert_eq!(raw, applied);
        assert_eq!(raw.conflicts.len(), 1, "{:?}", raw.conflicts);
        assert_eq!(raw.calendar.as_deref(), Some("dim_order_date"));
    }

    #[test]
    fn the_effective_calendar_is_the_one_the_document_produces() {
        // What `validate.rs` reads, and it has no `DataModel` to work it out
        // from. Declared stands; otherwise the authored one wins over the guess.
        let model = an_unmarked_warehouse_calendar();
        let guessed = facts_from_model(&model);
        assert_eq!(
            effective_date_table(&guessed, &AuthoredKinds::default()),
            Some("dim_date")
        );

        let doc = doc_with_kind("dim_date", TableKind::Calendar);
        assert_eq!(
            effective_date_table(&guessed, &authored_table_kinds(&guessed, &doc, None)),
            Some("dim_date")
        );
    }
}
