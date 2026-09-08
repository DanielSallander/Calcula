//! FILENAME: app/src-tauri/src/insights/strategy/infer.rs
// PURPOSE: Produce a COMPLETE first draft of a strategy document from a model
//          plus the way the open workbook already uses it, with every entry
//          marked `reviewed: false`.
// CONTEXT: This is the half of the strategy layer that decides whether the
//          other half is ever used. A blank form with thirty fields per measure
//          does not get filled in; a complete draft that a person confirms row
//          by row does. So the deal this file strikes is: infer everything it
//          can DEFEND, mark all of it unreviewed, and leave the rest absent.
//
//          THE ASYMMETRY THAT DECIDES EVERY DEFAULT HERE. A wrong "additive"
//          produces a share-of-total sentence that is FALSE — "Sweden is 40% of
//          the group" computed by summing a ratio. A wrong "non-additive" only
//          withholds a sentence that would have been true. The two errors are
//          not the same size, so every unrecognised shape resolves to
//          `NonAdditive`, and the same reasoning drives the rest: an
//          unrecognised name is `Neutral`, an unknown role is simply not
//          written, and `neverSliceBy` stays EMPTY because guessing that a
//          column is sensitive is a claim about the business, not an inference
//          from the model.
//
//          WHAT THIS FILE DELIBERATELY DOES NOT KNOW. Column cardinality. The
//          engine stores no statistics, and the only honest way to learn that
//          `Customer[Email]` has a million distinct values is to run a grouped
//          query per column. Inference must not do that — it runs on every
//          model open — so ranking uses declared metadata and observed usage
//          only, and the draft is confirmed by a person who CAN see the data.
//          The one place that absence still bites is a NUMERIC axis on a
//          non-calendar dimension: a `Decimal` `size` on dim_product could be
//          six values or a million, so it stays undeclared. The calendar is
//          exempt because a marked date table declares what its columns are.
//          It is also why `INFER_ANALYSIS_DIMENSIONS` is currently `false`: the
//          ranking below is correct about REACHABILITY and about USAGE and blind
//          to the one thing that separates an axis from an identifier, and an
//          expensive attribute guessed blind is worse than one left empty.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::OnceLock;

use bi_engine::{AggregateOp, ArithmeticOp, DataModel, DataType, DateRole, Expression, Measure};
use regex::Regex;

use super::resolve::ModelFacts;
use super::types::{
    Additivity, AggregationSpec, Cadence, ColumnStrategy, Direction, EntrySource, MeasureStrategy,
    ModelStrategy, QualifiedColumn, Role, StrategyDoc, TableKind, TableStrategy, Target, Unit,
    STRATEGY_DOC_VERSION,
};
use crate::insights::usage::UsageIndex;

/// Whether a draft PROPOSES analysis dimensions at all. THE ONE PLACE THIS
/// POLICY IS DECIDED — flip this constant and nothing else.
///
/// SPLIT THE INFERRED ATTRIBUTES BY THE COST OF BEING WRONG. `direction`,
/// `unit`, `cadence` and a column's `role` are CHEAP: a wrong one is visibly
/// wrong at a glance and costs one dropdown to fix, so they are guessed freely.
/// `analysisDimensions`, `neverSliceBy` and `materiality` are EXPENSIVE: a wrong
/// value there does not LOOK wrong. It steers the decomposition search, and the
/// output is a plausible-sounding explanation of the wrong thing — the Quick
/// Insights failure this whole layer exists to prevent — with a person's Confirm
/// already on it.
///
/// `materiality` and `neverSliceBy` were already left unset for exactly this
/// reason. `analysisDimensions` was not, and it is ranked WITHOUT CARDINALITY:
/// this codebase keeps no per-column statistics at all (see the module header),
/// so the ranking cannot tell a country column with six members from a customer
/// full-name column with a million. Empty degrades to "no decomposition offered
/// for this measure", which is honest, visibly incomplete, and reported as a
/// note by `plan_dimensions`; a wrong list degrades to a confident irrelevant
/// explanation nobody can see is wrong.
///
/// FLIP IT BACK TO `true` WHEN PER-COLUMN DISTINCT COUNTS EXIST. Nothing else
/// about `analysis_dimensions_for` is wrong — it excludes keys, labels,
/// machinery and anything the executor cannot join in one hop, and it ranks by
/// this workbook's own usage. It is missing the one signal that separates an
/// axis from an identifier, and this switch is what says so out loud.
pub const INFER_ANALYSIS_DIMENSIONS: bool = false;

/// How many analysis dimensions one measure's draft offers.
///
/// Three, because the list is a starting point a person edits, and a list of
/// twelve reads as noise nobody curates. The executor's single-hop limit
/// already bounds the candidate pool; this bounds what is worth confirming.
const MAX_ANALYSIS_DIMENSIONS: usize = 3;

/// Ceiling on how deep a `MeasureRef` chain is followed before giving up.
///
/// The cycle guard below is exact, so this is not the cycle defence — it is the
/// defence against a legitimately absurd chain (a thousand measures each
/// referencing the next) turning model open into a stack overflow.
const MAX_MEASURE_REF_DEPTH: usize = 32;

// ---------------------------------------------------------------------------
// Name lexicon
// ---------------------------------------------------------------------------

/// Terms whose presence means a rise is BAD. Bilingual: a Swedish model is the
/// normal case here, not an edge case.
const LOWER_IS_BETTER_TERMS: &[&str] = &[
    "cost", "expense", "churn", "attrition", "defect", "error", "waste", "backlog", "overdue",
    "kostnad", "avgång", "fel", "spill", "ledtid",
];

/// Terms whose presence means a rise is GOOD.
const HIGHER_IS_BETTER_TERMS: &[&str] = &[
    "revenue",
    "sales",
    "margin",
    "profit",
    "income",
    "retention",
    "satisfaction",
    "conversion",
    "uptime",
    "intäkt",
    "omsättning",
    "marginal",
    "vinst",
    "täckningsbidrag",
];

/// Multi-word phrases whose presence means a rise is BAD. They must be matched
/// as CONSECUTIVE words, so "Time to Resolve" hits and "Delivery Time" does not.
const LOWER_IS_BETTER_PHRASES: &[&[&str]] = &[&["lead", "time"], &["days", "to"], &["time", "to"]];

/// A column name that names a key.
///
/// Spelled as the regex the design states. `id$` subsumes `^id$` and `_id$`, and
/// it over-captures ("Paid", "Bid"): the cost of that is a column withheld as an
/// analysis axis, never a false statement — and every entry here is written
/// `reviewed: false` for a person to correct.
fn key_name_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)(^id$|_id$|key$|id$)").expect("the key-name pattern compiles"))
}

/// A column name that names ETL machinery rather than an analysis axis.
fn machinery_name_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(created|updated|modified|loaded)_?(at|on|date)|^etl_|_ts$|^source_")
            .expect("the machinery-name pattern compiles")
    })
}

/// Split a name into lower-cased words on camelCase, spaces, underscores and
/// punctuation.
///
/// WORD BOUNDARIES ARE THE WHOLE POINT. A substring match makes "Costa Rica
/// Sales" a cost measure and "Bidding" a key — the exact class of confident
/// nonsense that makes a draft worse than a blank form.
///
/// `pub(super)` so facts.rs's unit lexicon splits names the SAME way. A second
/// splitter would drift, and the first symptom of the drift would be one surface
/// calling a measure a cost and another not.
pub(super) fn words(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    for (i, &c) in chars.iter().enumerate() {
        if !c.is_alphanumeric() {
            if !current.is_empty() {
                out.push(std::mem::take(&mut current));
            }
            continue;
        }
        let prev = if i > 0 { Some(chars[i - 1]) } else { None };
        let next = chars.get(i + 1).copied();
        let starts_word = match (prev, c.is_uppercase()) {
            // "netSales" -> net | Sales; "q4Revenue" -> q4 | Revenue.
            (Some(p), true) if p.is_lowercase() || p.is_numeric() => true,
            // "HTTPServer" -> HTTP | Server: the last capital of a run that is
            // followed by a lower-case letter opens the next word.
            (Some(p), true) if p.is_uppercase() => next.is_some_and(|n| n.is_lowercase()),
            _ => false,
        };
        if starts_word && !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }
        // `to_lowercase` rather than `to_ascii_lowercase`: the lexicon carries
        // "avgång" and "täckningsbidrag", and ASCII folding leaves Å/Ä/Ö alone.
        current.extend(c.to_lowercase());
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// Does any word equal this term, or the term with a plural `s`?
///
/// The plural is handled by ADDING an `s` rather than stripping one, because
/// stripping turns "costs" into "cost" correctly but also invites the reverse
/// mistakes that word boundaries were introduced to prevent.
pub(super) fn has_term(words: &[String], term: &str) -> bool {
    words
        .iter()
        .any(|w| w == term || (w.len() == term.len() + 1 && w.starts_with(term) && w.ends_with('s')))
}

pub(super) fn has_phrase(words: &[String], phrase: &[&str]) -> bool {
    if phrase.len() > words.len() {
        return false;
    }
    words
        .windows(phrase.len())
        .any(|w| w.iter().zip(phrase).all(|(a, b)| a == b))
}

fn says_lower_is_better(words: &[String]) -> bool {
    LOWER_IS_BETTER_TERMS.iter().any(|t| has_term(words, t))
        || LOWER_IS_BETTER_PHRASES.iter().any(|p| has_phrase(words, p))
}

fn says_higher_is_better(words: &[String]) -> bool {
    HIGHER_IS_BETTER_TERMS.iter().any(|t| has_term(words, t))
}

/// Which way is good, from the measure's name and description.
///
/// A KPI OUTRANKS THE LEXICON, when the KPI says anything at all. A model KPI's
/// band STATUSES run bad-to-good or good-to-bad as the ratio grows, and that is
/// a declaration by whoever authored the model — one validate.rs refuses to
/// contradict. So a KPI that states an ordering decides this outright, and one
/// that states none (a single band, or a flat or non-monotonic status sequence)
/// leaves the lexicon to answer.
///
/// On a name that says both ("Cost of Sales"), lower wins: the cost noun is the
/// head of that phrase far more often than not, and being wrong in the cautious
/// direction is what the rest of this file does too.
fn infer_direction(measure: &Measure, kpi_direction: Option<Direction>) -> Direction {
    if let Some(d) = kpi_direction {
        return d;
    }
    let name_words = words(measure.name());
    // The description is checked SEPARATELY rather than concatenated: joining
    // them would let the last word of a name and the first of a description
    // form a phrase ("...Lead" + "Time to...") that neither text contains.
    let desc_words = measure.description().map(words).unwrap_or_default();
    if says_lower_is_better(&name_words) || says_lower_is_better(&desc_words) {
        Direction::LowerIsBetter
    } else if says_higher_is_better(&name_words) || says_higher_is_better(&desc_words) {
        Direction::HigherIsBetter
    } else {
        Direction::Neutral
    }
}

// ---------------------------------------------------------------------------
// Aggregation, from the AST
// ---------------------------------------------------------------------------

fn additive() -> AggregationSpec {
    AggregationSpec {
        default: Additivity::Additive,
        by_dimension: BTreeMap::new(),
    }
}

fn non_additive() -> AggregationSpec {
    AggregationSpec {
        default: Additivity::NonAdditive,
        by_dimension: BTreeMap::new(),
    }
}

/// Is this spec additive along EVERY dimension, with no per-dimension exception?
///
/// A `+`/`-` chain may only be called additive when both sides are, and a side
/// that is additive over Product but last-value over Date is not "additive" —
/// summing it along Date is exactly the false claim this module exists to avoid.
fn is_plainly_additive(spec: &AggregationSpec) -> bool {
    spec.default == Additivity::Additive && spec.by_dimension.is_empty()
}

/// Does this expression name a column outright?
///
/// `SUM(Sales[Amount])` is additive; `SUM(Sales[Qty] * Sales[Price])` is an
/// aggregate over a computed row expression, and while that one happens to be
/// additive too, "any expression under a SUM is additive" is not a rule that
/// stays true (`SUM(x / y)` is not), so only a bare column earns it.
fn is_column_ref(expr: &Expression) -> bool {
    matches!(
        expr,
        Expression::ColumnRef(_) | Expression::QualifiedColumnRef { .. }
    )
}

/// How this expression may be rolled up.
///
/// `lookup` resolves a `MeasureRef` to its expression. It is a closure rather
/// than a `&DataModel` so a cycle can be exercised in a test without building a
/// model the engine's own builder would refuse.
pub(crate) fn additivity_of(
    expr: &Expression,
    lookup: &dyn Fn(&str) -> Option<Expression>,
    date_table: Option<&str>,
    path: &mut Vec<String>,
    depth: usize,
) -> AggregationSpec {
    if depth > MAX_MEASURE_REF_DEPTH {
        return non_additive();
    }
    match expr {
        Expression::Aggregate { operation, operand } => match operation {
            // COUNTROWS counts rows of a table; there is no operand to qualify
            // and row counts add along every dimension.
            AggregateOp::CountRows => additive(),
            AggregateOp::Sum | AggregateOp::Count if is_column_ref(operand) => additive(),
            // DistinctCount, Average, Median, Min, Max, the deviations and Mode
            // all land here. Every one of them is re-evaluated at each grain;
            // none may be summed.
            _ => non_additive(),
        },

        // A `+`/`-` chain of additive measures is additive; anything else in the
        // chain (a literal, a ratio, a semi-additive balance) is not.
        Expression::BinaryOp { left, op, right }
            if matches!(op, ArithmeticOp::Add | ArithmeticOp::Subtract) =>
        {
            let l = additivity_of(left, lookup, date_table, path, depth + 1);
            let r = additivity_of(right, lookup, date_table, path, depth + 1);
            if is_plainly_additive(&l) && is_plainly_additive(&r) {
                additive()
            } else {
                non_additive()
            }
        }

        // A balance is additive over everything EXCEPT time, where only the
        // boundary value means anything. That is the one shape whose honest
        // answer is per-dimension, and it needs a named date table to say it:
        // without one there is no dimension to hang the exception on, and a bare
        // "additive" would then be the false share-of-total claim again.
        Expression::SemiAdditiveBalance {
            expr: inner,
            opening,
            ..
        } => {
            let Some(date_table) = date_table else {
                return non_additive();
            };
            let inner_spec = additivity_of(inner, lookup, date_table.into(), path, depth + 1);
            if !is_plainly_additive(&inner_spec) {
                return non_additive();
            }
            let mut by_dimension = BTreeMap::new();
            by_dimension.insert(
                date_table.to_string(),
                if *opening {
                    Additivity::FirstValue
                } else {
                    Additivity::LastValue
                },
            );
            AggregationSpec {
                default: Additivity::Additive,
                by_dimension,
            }
        }

        // A reference INHERITS. The path (not a visited set) is what makes a
        // diamond — `[A] + [A]` — still resolve, while a true cycle stops.
        Expression::MeasureRef(name) => {
            if path.iter().any(|p| p == name) {
                return non_additive();
            }
            let Some(referent) = lookup(name) else {
                return non_additive();
            };
            path.push(name.clone());
            let spec = additivity_of(&referent, lookup, date_table, path, depth + 1);
            path.pop();
            spec
        }

        // Spelled out rather than left to the catch-all, because a reader
        // checking "is a ratio really non-additive here" should find the answer
        // by looking, not by proving an absence: division in either spelling,
        // and the two context probes, are re-evaluated per grain.
        Expression::BinaryOp { .. }
        | Expression::SafeDivide { .. }
        | Expression::HasOneValue { .. }
        | Expression::SelectedValue { .. } => non_additive(),

        // EVERYTHING ELSE. See the module header: a wrong "additive" states a
        // false share of a total, a wrong "non-additive" merely declines to
        // state a true one, so the unrecognised case takes the second.
        _ => non_additive(),
    }
}

fn infer_aggregation(model: &DataModel, facts: &ModelFacts, measure: &Measure) -> AggregationSpec {
    let lookup = |name: &str| -> Option<Expression> {
        model.measure(name).ok().map(|m| m.expression().clone())
    };
    let mut path = vec![measure.name().to_string()];
    additivity_of(
        measure.expression(),
        &lookup,
        facts.date_table.as_deref(),
        &mut path,
        0,
    )
}

// ---------------------------------------------------------------------------
// Table kinds and column roles
// ---------------------------------------------------------------------------

/// Every column any relationship joins on.
///
/// Taken from the MODEL rather than from `ModelFacts`, which carries only the
/// ACTIVE relationships: an inactive relationship still tells us the column is a
/// key, and calling it an analysis axis because a `USERELATIONSHIP` is currently
/// switched off would be plainly wrong.
fn join_columns(model: &DataModel) -> BTreeSet<QualifiedColumn> {
    let mut out = BTreeSet::new();
    for rel in model.relationships() {
        for cond in rel.conditions() {
            out.insert(QualifiedColumn::new(rel.from_table(), cond.from_column()));
            out.insert(QualifiedColumn::new(rel.to_table(), cond.to_column()));
        }
    }
    out
}

/// Column names that name something a row has ITS OWN of: contact details,
/// address parts, external identifiers, free text.
///
/// Not "high cardinality" in general — that needs a distinct count. These are
/// the shapes whose cardinality is knowable FROM THE NAME, because one per row
/// is what the thing IS. A country column and an email column are both strings
/// on a dimension; only one of them is an axis, and this is the half of that
/// distinction a name can carry.
const ONE_PER_ROW_WORDS: &[&str] = &[
    // contact
    "email", "mail", "epost", "phone", "telephone", "tel", "mobile", "fax", "telefon",
    // address parts (NOT city / region / country / state — those are axes)
    "address", "addr", "adress", "street", "gata", "zip", "postnummer",
    // external identifiers
    "sku", "barcode", "ean", "isbn", "guid", "uuid", "url", "uri", "link", "slug",
    // free text
    "note", "notes", "comment", "comments", "remark", "kommentar",
];

/// Forms that `words()` splits apart and so cannot match word-by-word.
/// `PostCode` becomes ["post", "code"], neither of which may be listed alone.
const ONE_PER_ROW_JOINED: &[&str] = &["postcode", "zipcode", "postalcode"];

/// Terms strong enough to be matched at the START or the END of a name that
/// `words()` could not split at all.
///
/// THIS IS THE CONCATENATED CONVENTION, and it is the one the harness caught
/// this lexicon failing. `words("emailaddress")` is a SINGLE token, so the
/// `email` entry above — which matches whole words — never fired, and an email
/// column on a `dim_customer` written in concatenated lowercase came back an
/// analysis axis. `postalcode` looked fine only because it happens to be in the
/// joined list verbatim; nothing general was working.
///
/// PREFIX-OR-SUFFIX, NEVER SUBSTRING, AND ONLY ON A SINGLE TOKEN. Both halves of
/// that are load-bearing:
///
///   * A substring test would make `HeadphoneCategory` a contact detail. It does
///     not fire here, because that name splits into two tokens and this rule
///     only runs on names that did not split at all.
///   * Even on a single token, an anchored match is what saves
///     `headphonecategory`: `phone` is neither its start nor its end.
///
/// WHAT IS DELIBERATELY ABSENT. `street`, because `Streetlight` is one token
/// that starts with it and would lose its axis; and every term shorter than four
/// letters, because a three-letter suffix matches by accident (`mean` ends with
/// `ean`). The residual known false positive is a column named exactly
/// `Headphone` or `Microphone`, which loses an axis it should have kept — a cost
/// paid in a withheld breakdown, never in a false statement, and one a person
/// corrects in the dropdown every entry here ships `reviewed: false` for.
const ONE_PER_ROW_STRONG: &[&str] = &[
    "email",
    "epost",
    "mail",
    "phone",
    "telefon",
    "address",
    "adress",
    "addr",
    "postal",
    "postnummer",
    "barcode",
];

/// Does this column name say "one of these per row"?
///
/// WORD EQUALITY FIRST, never substring. A substring test makes "Streetlight
/// Category" an address part and "Emailing Segment" a contact detail — the same
/// class of confident nonsense that the direction lexicon's "Costa Rica Sales"
/// case exists to prevent. The anchored single-token rule below is the one
/// concession, and it is bounded by `ONE_PER_ROW_STRONG`'s own comment.
///
/// A NAME HEURISTIC GENERALISES EXACTLY AS FAR AS ITS NAMING CONVENTIONS DO, AND
/// THIS ONE IS A STOPGAP. It reads English and Swedish, in PascalCase,
/// snake_case and concatenated lowercase, and it is beaten by ABBREVIATIONS:
/// `cust_nm` is a customer name only to somebody who already knows the schema,
/// and no word list can be widened to cover `nm`, `dsc`, `ln1` and their
/// dialects without matching things that are not those. `calibration_tests.rs`
/// measures exactly that — the abbreviated fixture is in there to SHOW the miss
/// rather than to be papered over.
///
/// THE REAL FIX IS A PER-COLUMN DISTINCT COUNT (`INFER_ANALYSIS_DIMENSIONS`,
/// open-items §2.AI.6). Cardinality is what actually separates an axis from an
/// identifier, it is language-neutral and convention-neutral, and every rule in
/// this function is standing in for it until it exists.
fn is_one_per_row_shaped(column: &str) -> bool {
    let w = words(column);
    if w.iter().any(|word| ONE_PER_ROW_WORDS.contains(&word.as_str())) {
        return true;
    }
    let joined: String = w.concat();
    if ONE_PER_ROW_JOINED.contains(&joined.as_str()) {
        return true;
    }
    // Only a name the splitter could not split: see `ONE_PER_ROW_STRONG`.
    w.len() == 1
        && ONE_PER_ROW_STRONG
            .iter()
            .any(|t| w[0].len() > t.len() && (w[0].starts_with(t) || w[0].ends_with(t)))
}

/// Words that make a column the thing a reader recognises a ROW by.
const LABEL_HEAD_WORDS: &[&str] = &["name", "namn", "title", "label", "description"];

/// The heads that also have to be recognised at the END of a single unsplittable
/// token, for the same concatenated convention `ONE_PER_ROW_STRONG` exists for:
/// `words("fullname")` and `words("kundnamn")` are one token each, so the
/// head-noun test has nothing to look at unless it looks inside.
///
/// Only the two `name` spellings. `title`/`label`/`description` are left out
/// because their anchored matches are the ones that go wrong (`subtitle` is a
/// label, `pricelabel` is not a row's name), and a wrong LABEL costs the table
/// its real display column.
const LABEL_JOINED_HEADS: &[&str] = &["name", "namn"];

/// Qualifiers that make a column a FRAGMENT of the row's name rather than the
/// name itself.
///
/// WITHOUT THIS THE ELECTION PICKS BY DECLARATION ORDER. `FirstName`,
/// `MiddleName`, `LastName` and `FullName` all score alike — a trailing "name"
/// that does not restate the table — so the fold's first-maximum tie-break
/// hands the label to whichever was written first, and tables are written
/// first/middle/last/full. The label of a `Contact` row came back `FirstName`,
/// which names three rows "Anna" and is no better than having no label.
///
/// A fragment still scores (0, not `None`): it is label-SHAPED, so it must not
/// become a grouping axis. It just loses to a whole name.
///
/// The Swedish spellings are the stems `LABEL_JOINED_HEADS` leaves behind:
/// `words("fornamn")` is one token, so the qualifier is only visible after the
/// head is stripped. Both `for` and `för` are listed because a column may be
/// written either way and `words()` keeps the non-ASCII letter.
const NAME_PART_QUALIFIERS: &[&str] = &[
    // English
    "first", "middle", "last", "given", "family", "sur", "maiden", "nick", "initial", "initials",
    // Swedish
    "for", "för", "efter", "mellan", "tilltals", "smek", "flick",
];

/// How well a column name reads as a table's display label. Higher is better;
/// `None` means it does not read as one at all. `0` means it reads as a PART of
/// one — see `NAME_PART_QUALIFIERS`.
fn label_score(table: &str, column: &str) -> Option<u32> {
    let table_words = words(table);
    let column_words = words(column);
    let last = column_words.last()?.as_str();
    // "Product Name" on table "Product" beats a bare "Name", which beats
    // "Description" — the more the column restates the table, the more
    // confidently it is the thing a reader recognises a row by.
    let (head, restates_table, names_a_part) = if LABEL_HEAD_WORDS.contains(&last) {
        let qualifiers = &column_words[..column_words.len() - 1];
        (
            last,
            !qualifiers.is_empty() && table_words.iter().any(|t| qualifiers.iter().any(|c| c == t)),
            qualifiers
                .iter()
                .any(|q| NAME_PART_QUALIFIERS.contains(&q.as_str())),
        )
    } else if column_words.len() == 1 {
        let head = LABEL_JOINED_HEADS
            .iter()
            .copied()
            .find(|h| last.len() > h.len() && last.ends_with(h))?;
        // `kundnamn` restates `Kund` exactly the way `Product Name` restates
        // `Product`; the only difference is that nothing separates the two
        // words, which is a spelling convention and not a weaker claim.
        let stem = &last[..last.len() - head.len()];
        (
            head,
            table_words.iter().any(|t| stem.starts_with(t.as_str())),
            // EXACT, not a prefix. `fullstandigtnamn` starts with no qualifier
            // and must not be demoted by one that happens to share a prefix.
            NAME_PART_QUALIFIERS.contains(&stem),
        )
    } else {
        return None;
    };
    // A fragment of the name loses to every whole one, however the whole one is
    // spelled — it stays label-SHAPED so it can never become an axis.
    if names_a_part {
        return Some(0);
    }
    Some(match (restates_table, head) {
        (true, "name" | "namn") => 3,
        (false, "name" | "namn") => 2,
        _ => 1,
    })
}

/// Build one table's draft: its kind, its label column, the role of each column
/// it can defend a role for, and its declared hierarchies.
fn infer_table(
    model: &DataModel,
    facts: &ModelFacts,
    table_name: &str,
    joins: &BTreeSet<QualifiedColumn>,
) -> TableStrategy {
    let kind = facts.tables.get(table_name).and_then(|t| t.kind);
    let Ok(table) = model.table(table_name) else {
        return TableStrategy {
            kind,
            reviewed: false,
            source: Some(EntrySource::Inferred),
            ..Default::default()
        };
    };

    // A column named by ANOTHER column's `sort_by_column` is machinery: the
    // MonthNumber behind MonthName exists to order an axis, not to be one.
    let sort_targets: BTreeSet<&str> = table
        .columns()
        .iter()
        .filter_map(|c| c.sort_by_column())
        .collect();

    // Through the FACTS seam, not `model.hierarchies_for_table`. facts.rs claims
    // in its own header to be the only file that knows both shapes, and this
    // reaching straight into `DataModel` made that claim false — which is how a
    // second, drifting reading of the model gets started.
    let hierarchies: Vec<Vec<String>> = facts
        .tables
        .get(table_name)
        .map(|t| t.hierarchies.clone())
        .unwrap_or_default();
    let hierarchy_levels: BTreeSet<&str> = hierarchies
        .iter()
        .flat_map(|h| h.iter().map(String::as_str))
        .collect();

    let is_calendar = matches!(kind, Some(TableKind::Calendar));

    // The label column is chosen once for the table, and the winner is the
    // pointer a report names a ROW by. It no longer decides the runners-up:
    // every name-like column is `Label` (see the ladder below), because a
    // column that reads as a name is one fact per record whether or not it won
    // an election. The election answers a different question — WHICH of them
    // does a reader recognise the row by — and `NAME_PART_QUALIFIERS` keeps a
    // fragment from winning it on declaration order alone.
    let label_column: Option<String> = if matches!(kind, Some(TableKind::Dimension)) {
        table
            .columns()
            .iter()
            .filter(|c| !c.is_hidden())
            .filter(|c| !joins.contains(&QualifiedColumn::new(table_name, c.name())))
            .filter(|c| matches!(c.data_type(), DataType::String))
            .filter_map(|c| label_score(table_name, c.name()).map(|s| (s, c.name().to_string())))
            // `max_by_key` keeps the LAST maximum; the fold below keeps the
            // first, so a tie breaks on declaration order rather than on
            // whichever column happens to be last in the table.
            .fold(None::<(u32, String)>, |best, cand| match best {
                Some(b) if b.0 >= cand.0 => Some(b),
                _ => Some(cand),
            })
            .map(|(_, name)| name)
    } else {
        None
    };

    let mut columns: BTreeMap<String, ColumnStrategy> = BTreeMap::new();
    for column in table.columns() {
        let qc = QualifiedColumn::new(table_name, column.name());
        let role = if joins.contains(&qc) || key_name_pattern().is_match(column.name()) {
            // KEY IS DECIDED FIRST, deliberately. A key is usually hidden too,
            // and calling a join column "machinery" would be true but less
            // useful than calling it what it is; neither may scope, so the
            // choice costs nothing but the word the reviewer reads.
            Some(Role::Key)
        } else if column.is_hidden()
            || sort_targets.contains(column.name())
            || machinery_name_pattern().is_match(column.name())
        {
            Some(Role::Ignore)
        } else if hierarchy_levels.contains(column.name()) {
            Some(Role::Hierarchy)
        } else if column.date_role().is_some() || is_calendar {
            // A CALENDAR ATTRIBUTE, WHATEVER ITS DATA TYPE.
            //
            // `BI.dim_date` in a real warehouse types year/quarter/month/day as
            // `Decimal(38,10)`, and the data-type allowlist below admits only
            // String/Int32/Int64 — so the calendar's entire decomposition axis
            // fell out of the draft as `ignore` and no fact was ever broken down
            // by month. There is no cardinality anywhere in this codebase to
            // lean on, and neither branch here needs one: `date_role` is the
            // author's own declaration of what the column is, and on the MARKED
            // date table a column that is not a key and not machinery is a
            // calendar attribute by definition — that is what a date table IS.
            //
            // THE PLACEMENT IS THE RULE. Above Key, the date table's own date
            // key (which carries `DateRole::DateKey`) would come back Analysis
            // instead of Key and stop being usable as the default time axis;
            // above Ignore, every ETL stamp and sort-order helper on the
            // calendar would be offered as a breakdown. Both are pinned by
            // `the_calendar_arm_sits_below_key_and_below_ignore`.
            Some(Role::Analysis)
        } else if matches!(column.data_type(), DataType::Boolean) {
            Some(Role::Filter)
        } else if matches!(kind, Some(TableKind::Dimension))
            && matches!(column.data_type(), DataType::String)
            && label_score(table_name, column.name()).is_some()
        {
            // A NAME-LIKE COLUMN IS LABEL-SHAPED WHETHER OR NOT IT WON.
            //
            // This arm used to read `label_column.as_deref() == Some(name)` -
            // the WINNER of the label election and nobody else. Every runner-up
            // fell past it, through `is_one_per_row_shaped` (which carries no
            // name terms at all) and into the dimension+type allowlist, and came
            // out `analysis`. So on any customer, employee or contact dimension,
            // `FirstName` and `LastName` became GROUPING AXES while `FullName`
            // became the label - and revenue broken down by first name is one
            // fact per person wearing the clothes of a segmentation.
            //
            // CARDINALITY WOULD NOT HAVE SAVED THIS, which is why it is fixed
            // here and not deferred to open-items §2.AI.6: `FirstName` really
            // does have a few hundred distinct values across ten thousand
            // customers, so a distinct count CONFIRMS it as an axis. Only the
            // name lexicon can demote it.
            //
            // THE COST, STATED RATHER THAN HIDDEN. A denormalised `Category
            // Name` on a product dimension scores name-like and IS a legitimate
            // axis; this rule demotes it to `label` and its breakdown is not
            // offered. That trade is asserted in `calibration_tests.rs` so it
            // shows up as a fact about the ladder rather than as a surprise.
            // It costs a withheld breakdown, never a false statement, and every
            // entry here ships `reviewed: false` for a person to correct.
            //
            // The filters mirror the ELECTION's own (a dimension, a string
            // column, not hidden and not a join - the last two are already
            // claimed by the arms above), because the columns being demoted are
            // exactly the ones that competed and lost. Winning stays a separate,
            // additional fact about one column: `labelColumn`.
            Some(Role::Label)
        } else if is_one_per_row_shaped(column.name()) {
            // ONE VALUE PER ROW BY NAME, so never an axis.
            //
            // MEASURED, not assumed. `calibration_tests.rs` runs `infer` over a
            // realistic wide customer dimension and, without this arm, promoted
            // EIGHT of eleven columns to `analysis` — Email, Phone, two address
            // lines and PostCode among them — against a design ceiling of four.
            // Grouping revenue by email address is one fact per customer.
            //
            // `label_score` does not catch these: it only picks the single
            // display label, and it fires on a trailing "name"/"title". These
            // are a different shape — contact details, address parts, external
            // identifiers and free text — and they share only that a row has its
            // own one.
            //
            // This is a NAME heuristic standing in for cardinality, and it is
            // the narrow kind: WORD EQUALITY, never substring, so "Streetlight
            // Category" keeps its axis while "Street" loses one. It is
            // deliberately small and it is deliberately not clever — the real
            // fix is a distinct count (open-items §2.AI.6), and every guess here
            // ships `reviewed: false` for a person who can see the data.
            Some(Role::Ignore)
        } else if matches!(kind, Some(TableKind::Dimension))
            && matches!(
                column.data_type(),
                DataType::String | DataType::Int32 | DataType::Int64
            )
        {
            // A NON-CALENDAR dimension still needs the allowlist: a `Decimal`
            // `size` on dim_product may be an axis with six values or a
            // continuous measurement with a million, and nothing in the model
            // says which. That distinction needs column statistics the engine
            // does not keep, so it stays undeclared rather than guessed.
            Some(Role::Analysis)
        } else {
            // No rule fires: a fact table's Amount column, a date-typed column
            // on a fact. The document leaves it UNDECLARED rather than guessing
            // — `StrategyDoc::may_scope` reads undeclared as "not refused" and
            // validate.rs warns, which is the honest state.
            None
        };
        if let Some(role) = role {
            columns.insert(
                column.name().to_string(),
                ColumnStrategy {
                    role,
                    priority: None,
                },
            );
        }
    }

    TableStrategy {
        kind,
        label_column,
        columns,
        hierarchies,
        reviewed: false,
        source: Some(EntrySource::Inferred),
    }
}

// ---------------------------------------------------------------------------
// Analysis dimensions
// ---------------------------------------------------------------------------

/// Tables one ACTIVE relationship away from `fact_table`.
///
/// Single hop only, and that is not a simplification: the query executor refuses
/// longer paths in three separate places, so a snowflaked attribute offered here
/// would be a breakdown the engine cannot compute.
fn directly_related_tables(facts: &ModelFacts, fact_table: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for (a, b) in &facts.relationships {
        if a.table == fact_table {
            out.insert(b.table.clone());
        }
        if b.table == fact_table {
            out.insert(a.table.clone());
        }
    }
    out.remove(fact_table);
    out
}

/// The columns worth offering as breakdowns of one measure.
///
/// Ranked by how the workbook ALREADY uses the pair, then by declaration order.
/// Usage is the only signal available that reflects what this team actually
/// looks at; declaration order is the tie-break because it is stable, and a
/// stable draft is one a reviewer can re-run and diff.
fn analysis_dimensions_for(
    model: &DataModel,
    facts: &ModelFacts,
    tables: &BTreeMap<String, TableStrategy>,
    usage: &UsageIndex,
    measure_name: &str,
    fact_table: Option<&str>,
) -> Vec<QualifiedColumn> {
    let Some(fact_table) = fact_table else {
        return Vec::new();
    };
    let related = directly_related_tables(facts, fact_table);

    let mut declaration_order: HashMap<QualifiedColumn, usize> = HashMap::new();
    let mut n = 0usize;
    for table in model.tables() {
        for column in table.columns() {
            declaration_order.insert(QualifiedColumn::new(table.name(), column.name()), n);
            n += 1;
        }
    }

    let mut candidates: Vec<QualifiedColumn> = Vec::new();
    for table_name in &related {
        let Some(strategy) = tables.get(table_name) else {
            continue;
        };
        for (column, entry) in &strategy.columns {
            if entry.role != Role::Analysis {
                continue;
            }
            // A LABEL IS NEVER AN AXIS, WHATEVER ROLE IT ENDED UP WITH.
            //
            // A label is what a reader recognises ONE ROW by, so breaking a
            // measure down by it produces one fact per record: technically true,
            // completely useless, and validate.rs refuses the pairing. Usually
            // the role check above is enough, because the label column takes
            // `Role::Label`. It is NOT enough when an arm above the label arm
            // claims the same column first: a `Month Name` on a dimension
            // carrying `DateRole::Month` comes back `Analysis` and is still the
            // table's declared `labelColumn`. Proposing it would cost a person a
            // round trip to a refusal, which is worse than not proposing it.
            if strategy.label_column.as_deref() == Some(column.as_str()) {
                continue;
            }
            candidates.push(QualifiedColumn::new(table_name, column));
        }
    }

    candidates.sort_by(|a, b| {
        usage
            .score(measure_name, b)
            .cmp(&usage.score(measure_name, a))
            .then_with(|| {
                declaration_order
                    .get(a)
                    .copied()
                    .unwrap_or(usize::MAX)
                    .cmp(&declaration_order.get(b).copied().unwrap_or(usize::MAX))
            })
            .then_with(|| a.cmp(b))
    });
    candidates.truncate(MAX_ANALYSIS_DIMENSIONS);
    candidates
}

// ---------------------------------------------------------------------------
// Model-wide defaults
// ---------------------------------------------------------------------------

/// The column a time series should be plotted against.
///
/// THE DATE TABLE MAY ITSELF BE A GUESS. `facts.date_table` is the marked table
/// when the author marked one and `facts.rs`'s inferred calendar when nobody
/// did, which is what gives an ordinary imported star schema a time axis at all.
/// The provenance rides along in `facts.calendar_source` and the planner says so
/// (`plan_time_axis` in model.rs); nothing about the choice below changes.
///
/// The date table's declared date KEY if it has one, else its declared day
/// column, else its only `Date`-typed column. "Only" is load-bearing: two
/// date-typed columns on a calendar (order date, ship date on a role-playing
/// dimension) means the choice is a business decision, and picking one would be
/// inventing it.
fn infer_default_time_axis(model: &DataModel, facts: &ModelFacts) -> Option<QualifiedColumn> {
    let date_table = facts.date_table.as_deref()?;
    let table = model.table(date_table).ok()?;
    for wanted in [DateRole::DateKey, DateRole::Day] {
        if let Some(c) = table.columns().iter().find(|c| c.date_role() == Some(wanted)) {
            return Some(QualifiedColumn::new(date_table, c.name()));
        }
    }
    let mut dated = table
        .columns()
        .iter()
        .filter(|c| matches!(c.data_type(), DataType::Date));
    let first = dated.next()?;
    if dated.next().is_some() {
        return None;
    }
    Some(QualifiedColumn::new(date_table, first.name()))
}

/// Which measures lead a report, when the workbook has not said.
///
/// USAGE WINS OUTRIGHT WHEN THERE IS ANY. A workbook's own pivots and saved
/// layouts are evidence about what this team looks at, and no heuristic beats
/// evidence. `ranked_measures` is empty only when the workbook reports nothing —
/// a freshly imported model, or one whose reports live somewhere else — and it
/// was empty that left `model.priority` empty, `MeasureStrategy::priority`
/// unset (it is an override, and inventing one per measure would fight this
/// list) and therefore the report generator with NOTHING to order its KPIs by.
///
/// THIS IS A SEED, NOT A JUDGEMENT. It is written `reviewed: false` like every
/// other inferred value and it is a list a person reorders in one drag. The
/// order it seeds: a measure with a KPI defined against it is by definition one
/// somebody already cared enough about to state a goal for, so those come first;
/// everything else follows in the model's own DECLARATION order, which is stable
/// across re-drafts and is the order the author themself wrote the model in.
/// Declaration order rather than alphabetical order is the point — an
/// alphabetical list would be a ranking nobody chose, wearing the same clothes as
/// one somebody did.
fn seed_priority(model: &DataModel, facts: &ModelFacts, usage: &UsageIndex) -> Vec<String> {
    let observed = usage.ranked_measures();
    if !observed.is_empty() {
        return observed;
    }
    let has_kpi = |name: &str| facts.measures.get(name).is_some_and(|m| m.kpi.is_some());
    let mut with_kpi: Vec<String> = Vec::new();
    let mut rest: Vec<String> = Vec::new();
    for measure in model.measures() {
        let name = measure.name().to_string();
        if has_kpi(&name) {
            with_kpi.push(name);
        } else {
            rest.push(name);
        }
    }
    with_kpi.extend(rest);
    with_kpi
}

/// `MM-DD` for the first day of the fiscal year, from the model's declared
/// fiscal year END month. December-ending (the ordinary calendar year) is left
/// unset rather than written as `01-01`: an absent value and a value that says
/// "the default" resolve the same way, and the absent one does not read as a
/// decision somebody made.
fn infer_fiscal_year_start(model: &DataModel) -> Option<String> {
    let end = model.fiscal_year_end_month()?;
    if !(1..=12).contains(&end) || end == 12 {
        return None;
    }
    Some(format!("{:02}-01", end % 12 + 1))
}

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

/// Draft a complete strategy document for a model.
///
/// EVERY entry it writes is `reviewed: false`. The validator warns on each one
/// until a person confirms it, which is what keeps "the engine inferred this"
/// and "the business stated this" from becoming the same claim.
pub fn infer(facts: &ModelFacts, model: &DataModel, usage: &UsageIndex) -> StrategyDoc {
    let joins = join_columns(model);

    let mut tables: BTreeMap<String, TableStrategy> = BTreeMap::new();
    for table in model.tables() {
        tables.insert(
            table.name().to_string(),
            infer_table(model, facts, table.name(), &joins),
        );
    }

    let mut measures: BTreeMap<String, MeasureStrategy> = BTreeMap::new();
    for measure in model.measures() {
        let name = measure.name();
        let mf = facts.measures.get(name);
        let kpi = mf.and_then(|m| m.kpi.as_ref());
        // A KPI WITH NO NUMBER IS NOT A TARGET. `KpiFacts::target` is `None`
        // both when the KPI declares no constant and when its goal is another
        // MEASURE, and in both cases `{"type": "kpi"}` resolves to nothing: no
        // target_value reaches the planner, so no variance fact is emitted and
        // the report is silently missing the line. Drafting it anyway would also
        // write a document validate.rs now refuses (`unresolvable-target-kpi`),
        // and a draft that cannot be saved is worse than an empty field.
        let has_numeric_kpi_target = kpi.is_some_and(|k| k.target.is_some());
        // The direction the KPI's band statuses state, if they state one. A KPI
        // whose bands say nothing leaves the lexicon to answer.
        let kpi_direction = kpi.and_then(|k| k.direction());
        let fact_table = mf
            .and_then(|m| m.fact_table.as_deref())
            .filter(|t| !t.is_empty());

        measures.insert(
            name.to_string(),
            MeasureStrategy {
                direction: Some(infer_direction(measure, kpi_direction)),
                aggregation: Some(infer_aggregation(model, facts, measure)),
                // THE UNIT IS DECIDED IN ONE PLACE, `facts.rs`, and read here.
                // It resolves the name lexicon and the format string together
                // (`infer_unit`), which matters because `MeasureFacts.unit` is
                // also the RESOLVER's base layer — so a model with no strategy
                // document at all gets the same answer the draft would. A second
                // lexicon here would fix only the drafted document, and would be
                // a second source of truth that drifts on the first edit.
                unit: mf.and_then(|m| m.unit),
                // The model's own KPI is the only target inference can defend,
                // and only when the KPI carries a number to inherit.
                // A literal would be a number nobody supplied.
                target: has_numeric_kpi_target.then_some(Target::Kpi),
                // Materiality is a business threshold. There is nothing in the
                // model to read it from, and a made-up floor silently hides
                // movements, so it stays absent.
                materiality: None,
                cadence: Some(usage.cadence_for(name).unwrap_or(Cadence::Monthly)),
                // A PER-MEASURE priority is an OVERRIDE of `model.priority`, and
                // seeding one here would fight the list `seed_priority` writes
                // below - two rankings, one silently winning.
                priority: None,
                // Empty while `INFER_ANALYSIS_DIMENSIONS` is off. The call is
                // still written out rather than deleted, because a deleted
                // function is not a reversible decision: this is the switch, and
                // the ranking behind it stays compiled, tested and ready.
                analysis_dimensions: if INFER_ANALYSIS_DIMENSIONS {
                    analysis_dimensions_for(model, facts, &tables, usage, name, fact_table)
                } else {
                    Vec::new()
                },
                // DELIBERATELY EMPTY. "Never slice revenue by employee name" is
                // a statement about sensitivity or meaning that no part of the
                // model records. Inference cannot have an opinion here.
                never_slice_by: Vec::new(),
                context: None,
                reviewed: false,
                // A MACHINE GUESSED THIS. `reviewed: false` alone cannot tell
                // that apart from an entry a person typed and has not signed
                // off, nor from one nobody has ever touched - and the Strategy
                // tab was badging all three the same.
                source: Some(EntrySource::Inferred),
            },
        );
    }

    StrategyDoc {
        version: STRATEGY_DOC_VERSION,
        model: ModelStrategy {
            default_time_axis: infer_default_time_axis(model, facts),
            fiscal_year_start: infer_fiscal_year_start(model),
            // Left unset: a currency code can be scraped out of `[$SEK-41d]`,
            // but a model whose measures carry two different codes has a real
            // reporting-currency question that a scrape would paper over.
            reporting_currency: None,
            priority: seed_priority(model, facts, usage),
            // THE BLOCK IS A GUESS LIKE ANY OTHER ROW, and it is the guess that
            // most needs accepting: `default_time_axis` above may be a calendar
            // `facts.rs` INFERRED because nobody marked one, and every trend,
            // seasonality and change-point claim in the report is computed
            // against it. Stamped and left unreviewed, so the Strategy tab has a
            // badge to show and a Confirm to offer here too.
            reviewed: false,
            source: Some(EntrySource::Inferred),
        },
        measures,
        tables,
        // Rules, period annotations and inline tests are AUTHORED. A rule is a
        // scoped exception somebody knows about; there is nothing in a model
        // that implies one, and a generated rule would be an assertion wearing
        // the reviewer's authority.
        rules: Vec::new(),
        periods: Vec::new(),
        tests: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::insights::strategy::facts::facts_from_model;
    use bi_engine::{
        expression, sum_measure, Column, DataType, Hierarchy, HierarchyLevel, Kpi, KpiStatus,
        KpiTarget, Measure, Relationship, StatusBand, Table,
    };

    fn no_usage() -> UsageIndex {
        UsageIndex::default()
    }

    /// What the ranking WOULD offer for a measure, called directly.
    ///
    /// `INFER_ANALYSIS_DIMENSIONS` is off, so `infer` writes an empty list and a
    /// test that read `doc.measures[m].analysis_dimensions` would pass no matter
    /// what the ranking did. Going through this helper keeps every rule the
    /// ranking enforces - one hop only, no keys, no labels, no machinery - under
    /// test while the switch is off, which is what makes flipping it back a
    /// decision rather than a leap.
    fn offered_dimensions(model: &DataModel, measure: &str) -> Vec<QualifiedColumn> {
        let facts = facts_from_model(model);
        let doc = infer(&facts, model, &no_usage());
        let fact_table = facts
            .measures
            .get(measure)
            .and_then(|m| m.fact_table.clone());
        analysis_dimensions_for(
            model,
            &facts,
            &doc.tables,
            &no_usage(),
            measure,
            fact_table.as_deref(),
        )
    }

    /// Sales (fact) -> Product (leaf dimension), Sales -> Date (marked
    /// calendar). Measures are added by the caller.
    ///
    /// Product is deliberately a LEAF: the moment a dimension also points at
    /// something else it becomes a snowflake intermediate, and `facts_from_model`
    /// classifies that as `Bridge` rather than `Dimension`. The snowflake case
    /// gets its own fixture below so this one keeps testing the ordinary star.
    fn a_star_with(measures: Vec<Measure>) -> DataModel {
        let builder = DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("Amount", DataType::Float64),
                        Column::new("Qty", DataType::Int64),
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
                        Column::new("Product Name", DataType::String),
                        Column::new("Category", DataType::String),
                        Column::new("Discontinued", DataType::Boolean),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Date",
                    vec![
                        Column::new("Date", DataType::Date).with_date_role(DateRole::DateKey),
                        Column::new("MonthName", DataType::String).with_sort_by("MonthNumber"),
                        Column::new("MonthNumber", DataType::Int32),
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
                "Sales_Date",
                "Sales",
                "Date",
                "Date",
                "Date",
            ))
            .mark_date_table("Date");
        measures
            .into_iter()
            .fold(builder, |b, m| b.add_measure(m))
            .build()
            .expect("the fixture star schema builds")
    }

    /// Sales -> Product (one hop) AND Sales -> Geo -> Country (Country is TWO
    /// hops away, which the query executor refuses).
    fn a_snowflake() -> DataModel {
        DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("Amount", DataType::Float64),
                        Column::new("ProductKey", DataType::Int64),
                        Column::new("GeoKey", DataType::Int64),
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
                    "Geo",
                    vec![
                        Column::new("GeoKey", DataType::Int64),
                        Column::new("CountryKey", DataType::Int64),
                        Column::new("City", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Country",
                    vec![
                        Column::new("CountryKey", DataType::Int64),
                        Column::new("Region", DataType::String),
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
                "Sales_Geo", "Sales", "GeoKey", "Geo", "GeoKey",
            ))
            .add_relationship(Relationship::many_to_one(
                "Geo_Country",
                "Geo",
                "CountryKey",
                "Country",
                "CountryKey",
            ))
            .add_measure(sum_measure("Revenue", "Sales", "Amount"))
            .build()
            .expect("the snowflake fixture builds")
    }

    fn additivity(model: &DataModel, measure: &str) -> Additivity {
        let facts = facts_from_model(model);
        let doc = infer(&facts, model, &no_usage());
        doc.measures[measure]
            .aggregation
            .as_ref()
            .expect("inference always writes an aggregation")
            .default
    }

    #[test]
    fn a_sum_over_a_fact_column_is_additive() {
        let model = a_star_with(vec![sum_measure("Revenue", "Sales", "Amount")]);
        assert_eq!(additivity(&model, "Revenue"), Additivity::Additive);
    }

    #[test]
    fn a_ratio_is_never_additive() {
        // Both spellings of division: the plain operator and SAFEDIVIDE. Summing
        // either along a dimension is the false share-of-total claim.
        let model = a_star_with(vec![
            sum_measure("Revenue", "Sales", "Amount"),
            sum_measure("Cost", "Sales", "Qty"),
            Measure::new(
                "Margin Ratio",
                Expression::BinaryOp {
                    left: Box::new(Expression::MeasureRef("Revenue".into())),
                    op: ArithmeticOp::Divide,
                    right: Box::new(Expression::MeasureRef("Cost".into())),
                },
            ),
            Measure::new(
                "Safe Margin Ratio",
                expression::safe_divide(
                    Expression::MeasureRef("Revenue".into()),
                    Expression::MeasureRef("Cost".into()),
                    None,
                ),
            ),
        ]);
        assert_eq!(additivity(&model, "Margin Ratio"), Additivity::NonAdditive);
        assert_eq!(
            additivity(&model, "Safe Margin Ratio"),
            Additivity::NonAdditive
        );
        // Positive control: the operands themselves ARE additive, so the ratio's
        // verdict comes from the division and not from a failure to read either
        // side of it.
        assert_eq!(additivity(&model, "Revenue"), Additivity::Additive);
    }

    #[test]
    fn a_difference_of_two_additive_measures_is_additive() {
        let model = a_star_with(vec![
            sum_measure("Revenue", "Sales", "Amount"),
            sum_measure("Units", "Sales", "Qty"),
            Measure::new(
                "Net",
                Expression::BinaryOp {
                    left: Box::new(Expression::MeasureRef("Revenue".into())),
                    op: ArithmeticOp::Subtract,
                    right: Box::new(Expression::MeasureRef("Units".into())),
                },
            ),
        ]);
        assert_eq!(additivity(&model, "Net"), Additivity::Additive);
    }

    #[test]
    fn an_unrecognised_expression_defaults_to_non_additive_because_a_false_share_is_worse() {
        // An average is recognised and refused; a DISTINCTCOUNT is recognised and
        // refused; a shape nobody enumerated must land in the same place, and it
        // is the DEFAULT that is under test here.
        let model = a_star_with(vec![
            Measure::simple("Avg Amount", "Sales", "Amount", AggregateOp::Average),
            Measure::simple("Customers", "Sales", "ProductKey", AggregateOp::DistinctCount),
            Measure::new(
                "Whatever",
                expression::has_one_value(expression::qualified_col("Product", "Category")),
            ),
            // A literal added to an additive measure: summing THIS along a
            // dimension multiplies the literal by the member count.
            Measure::new(
                "Amount Plus One",
                Expression::BinaryOp {
                    left: Box::new(expression::agg(
                        AggregateOp::Sum,
                        expression::qualified_col("Sales", "Amount"),
                    )),
                    op: ArithmeticOp::Add,
                    right: Box::new(Expression::LiteralInt(1)),
                },
            ),
        ]);
        for m in ["Avg Amount", "Customers", "Whatever", "Amount Plus One"] {
            assert_eq!(
                additivity(&model, m),
                Additivity::NonAdditive,
                "'{m}' must default to non-additive"
            );
        }
    }

    #[test]
    fn a_measure_reference_cycle_terminates_instead_of_recursing() {
        // `with_measures` performs no validation, which is exactly how a cyclic
        // pair reaches inference in real life: the model editor writes it and
        // the user has not run validate yet.
        let base = a_star_with(vec![sum_measure("Revenue", "Sales", "Amount")]);
        let model = base.with_measures(vec![
            sum_measure("Revenue", "Sales", "Amount"),
            Measure::new("A", Expression::MeasureRef("B".into())),
            Measure::new("B", Expression::MeasureRef("A".into())),
            // A DIAMOND is not a cycle: `[Revenue] + [Revenue]` must still
            // resolve as additive, which a naive visited-set guard would break.
            Measure::new(
                "Doubled",
                Expression::BinaryOp {
                    left: Box::new(Expression::MeasureRef("Revenue".into())),
                    op: ArithmeticOp::Add,
                    right: Box::new(Expression::MeasureRef("Revenue".into())),
                },
            ),
        ]);
        assert_eq!(additivity(&model, "A"), Additivity::NonAdditive);
        assert_eq!(additivity(&model, "B"), Additivity::NonAdditive);
        assert_eq!(additivity(&model, "Doubled"), Additivity::Additive);
    }

    #[test]
    fn an_integer_formatted_revenue_is_currency_and_not_a_count() {
        // THE REPORTED CASE. `unit_from_format` reads `#,##0` as `Count`,
        // because an integer-only format is what a tally wears — and also what
        // most currency measures wear. So a measure named Revenue inferred as a
        // COUNT, which is a wrong word in front of a reader.
        let model = a_star_with(vec![
            sum_measure("Revenue", "Sales", "Amount").with_format_string("#,##0"),
            sum_measure("Order Count", "Sales", "Qty").with_format_string("#,##0"),
            sum_measure("Margin Percent", "Sales", "Amount").with_format_string("#,##0"),
            // An EXPLICIT format still wins outright: whoever wrote the `%`
            // meant it, whatever the name says.
            sum_measure("Revenue Share", "Sales", "Amount").with_format_string("0.0%"),
            // ...and so does an explicit currency, over a name that says count.
            sum_measure("Headcount Cost", "Sales", "Amount").with_format_string("[$SEK-41d] #,##0"),
        ]);
        let facts = facts_from_model(&model);
        let doc = infer(&facts, &model, &no_usage());
        let unit = |m: &str| doc.measures[m].unit;

        assert_eq!(unit("Revenue"), Some(Unit::Currency), "the name breaks the tie");
        assert_eq!(unit("Order Count"), Some(Unit::Count), "and it can still be a count");
        // "Margin Percent" carries both a currency term and a percent term; the
        // more specific one is the answer.
        assert_eq!(unit("Margin Percent"), Some(Unit::Percent));
        assert_eq!(unit("Revenue Share"), Some(Unit::Percent), "explicit % wins");
        assert_eq!(unit("Headcount Cost"), Some(Unit::Currency), "explicit currency wins");
    }

    #[test]
    fn a_contact_or_address_column_is_not_offered_as_a_breakdown() {
        // Measured in `calibration_tests.rs`: without this the wide customer
        // dimension promoted 8 of 11 columns to `analysis`, Email and both
        // address lines among them. Word equality, never substring — the
        // positive controls are the point.
        for name in ["Email", "Phone", "AddressLine1", "PostCode", "Notes", "SKU"] {
            assert!(is_one_per_row_shaped(name), "{name} names one value per row");
        }
        for name in ["Country", "City", "Segment", "Streetlight Category", "Region"] {
            assert!(!is_one_per_row_shaped(name), "{name} is a perfectly good axis");
        }
    }

    #[test]
    fn a_cost_measure_is_lower_is_better_and_costa_rica_sales_is_not() {
        let model = a_star_with(vec![
            sum_measure("Support Cost", "Sales", "Amount"),
            sum_measure("Costa Rica Sales", "Sales", "Amount"),
            sum_measure("Kostnad", "Sales", "Amount"),
            sum_measure("Lead Time", "Sales", "Qty"),
            sum_measure("Headcount", "Sales", "Qty"),
            sum_measure("Bidding", "Sales", "Qty"),
        ]);
        let facts = facts_from_model(&model);
        let doc = infer(&facts, &model, &no_usage());
        let dir = |m: &str| doc.measures[m].direction.expect("a direction is always written");

        assert_eq!(dir("Support Cost"), Direction::LowerIsBetter);
        assert_eq!(dir("Kostnad"), Direction::LowerIsBetter);
        assert_eq!(dir("Lead Time"), Direction::LowerIsBetter);
        // THE SUBSTRING TRAP, both ways round: "Costa" must not read as "cost",
        // and it must still pick up the "Sales" that IS a word.
        assert_eq!(dir("Costa Rica Sales"), Direction::HigherIsBetter);
        assert_eq!(dir("Headcount"), Direction::Neutral);
        // ...and the same trap in the key lexicon's direction: "Bidding" ends
        // in no key word, so it is not silently reclassified either.
        assert_eq!(dir("Bidding"), Direction::Neutral);
    }

    /// One measure named `Support Cost`, with whatever KPI bands are handed in.
    fn a_cost_measure_with_bands(bands: Vec<StatusBand>) -> DataModel {
        let mut kpi = Kpi::new("Cost KPI", "Support Cost", KpiTarget::Constant(100.0));
        for band in bands {
            kpi = kpi.with_status_band(band);
        }
        DataModel::builder()
            .add_table(
                Table::new("Sales", vec![Column::new("Amount", DataType::Float64)]).unwrap(),
            )
            .add_measure(sum_measure("Support Cost", "Sales", "Amount"))
            .add_kpi(kpi)
            .build()
            .unwrap()
    }

    #[test]
    fn a_kpi_whose_bands_improve_upward_outranks_a_lower_is_better_name() {
        // The measure is named "Cost", so the lexicon alone would say lower. This
        // KPI's statuses improve as the ratio grows, which is the model author
        // saying higher is better — and validate.rs refuses a draft that
        // contradicts it, so a draft that ignored the KPI could not be saved.
        let model = a_cost_measure_with_bands(vec![
            StatusBand::new(0.8, KpiStatus::OffTrack),
            StatusBand::new(1.0, KpiStatus::OnTrack),
        ]);
        let facts = facts_from_model(&model);
        let doc = infer(&facts, &model, &no_usage());
        assert_eq!(
            doc.measures["Support Cost"].direction,
            Some(Direction::HigherIsBetter)
        );
        assert_eq!(doc.measures["Support Cost"].target, Some(Target::Kpi));
    }

    #[test]
    fn a_kpi_whose_bands_worsen_upward_drafts_lower_is_better() {
        // The other half, which the old "a KPI means higher is better" premise
        // made unreachable: ASCENDING thresholds (the engine accepts no other
        // order) with WORSENING statuses is a lower-is-better declaration.
        let model = a_cost_measure_with_bands(vec![
            StatusBand::new(0.8, KpiStatus::OnTrack),
            StatusBand::new(1.0, KpiStatus::OffTrack),
        ]);
        let facts = facts_from_model(&model);
        let doc = infer(&facts, &model, &no_usage());
        assert_eq!(
            doc.measures["Support Cost"].direction,
            Some(Direction::LowerIsBetter)
        );
        // ...and the draft it produces is one validate.rs accepts, which is the
        // whole reason inference must agree with the KPI.
        let findings = crate::insights::strategy::validate(&facts, &doc);
        assert!(
            !findings.iter().any(|f| f.code == "direction-contradicts-kpi"),
            "the draft must be savable: {findings:?}"
        );
    }

    #[test]
    fn a_kpi_that_states_no_ordering_leaves_the_lexicon_to_answer() {
        // One band states a status but no ordering. The name is what is left.
        let model = a_cost_measure_with_bands(vec![StatusBand::new(1.0, KpiStatus::OnTrack)]);
        let facts = facts_from_model(&model);
        let doc = infer(&facts, &model, &no_usage());
        assert_eq!(
            doc.measures["Support Cost"].direction,
            Some(Direction::LowerIsBetter),
            "'Cost' is what decides when the KPI declines to"
        );
        // The target still comes from the KPI: having no ORDERING does not mean
        // having no GOAL.
        assert_eq!(doc.measures["Support Cost"].target, Some(Target::Kpi));
    }

    #[test]
    fn a_join_column_is_a_key_and_never_an_analysis_axis() {
        let model = a_star_with(vec![sum_measure("Revenue", "Sales", "Amount")]);
        let facts = facts_from_model(&model);
        let doc = infer(&facts, &model, &no_usage());

        let product = &doc.tables["Product"];
        assert_eq!(product.columns["ProductKey"].role, Role::Key);
        assert!(
            !Role::Key.may_scope(),
            "the role only means something because a key cannot scope"
        );
        let offered = offered_dimensions(&model, "Revenue");
        assert!(
            !offered.contains(&QualifiedColumn::new("Product", "ProductKey")),
            "a join column must never be offered as a breakdown: {offered:?}"
        );
        // Positive control: the ordinary attribute beside it IS offered.
        assert!(offered.contains(&QualifiedColumn::new("Product", "Category")));
    }

    #[test]
    fn a_sort_by_target_column_is_ignored() {
        let model = a_star_with(vec![sum_measure("Revenue", "Sales", "Amount")]);
        let facts = facts_from_model(&model);
        let doc = infer(&facts, &model, &no_usage());
        let date = &doc.tables["Date"];
        assert_eq!(
            date.columns["MonthNumber"].role,
            Role::Ignore,
            "the number behind MonthName is machinery, not an axis"
        );
        // Positive control: the column it sorts stays a real analysis axis, so
        // the rule targets the TARGET and not the pair.
        assert_eq!(date.columns["MonthName"].role, Role::Analysis);
    }

    #[test]
    fn everything_inferred_is_marked_unreviewed() {
        let model = a_star_with(vec![
            sum_measure("Revenue", "Sales", "Amount"),
            sum_measure("Units", "Sales", "Qty"),
        ]);
        let facts = facts_from_model(&model);
        let doc = infer(&facts, &model, &no_usage());
        assert!(!doc.measures.is_empty() && !doc.tables.is_empty());
        for (name, m) in &doc.measures {
            assert!(!m.reviewed, "measure '{name}' was drafted as reviewed");
        }
        for (name, t) in &doc.tables {
            assert!(!t.reviewed, "table '{name}' was drafted as reviewed");
        }
        // A draft that invented a scoped exception would be an assertion wearing
        // the consultant's authority.
        assert!(doc.rules.is_empty());
        assert!(doc.tests.is_empty());
        assert!(doc.periods.is_empty());
    }

    #[test]
    fn a_snowflaked_dimension_is_not_offered_as_an_analysis_dimension() {
        // Country hangs off Geo, so Sales -> Country is TWO hops and the
        // executor refuses it. Offering Country[Region] would promise a
        // breakdown that cannot be computed.
        let model = a_snowflake();
        let dims = offered_dimensions(&model, "Revenue");
        assert!(
            !dims.contains(&QualifiedColumn::new("Country", "Region")),
            "a two-hop attribute must not be offered: {dims:?}"
        );
        // Positive control in the SAME model: the leaf dimension one hop away is
        // still offered, so the exclusion is about distance and not about the
        // whole model having been given up on.
        assert!(
            dims.contains(&QualifiedColumn::new("Product", "Category")),
            "the one-hop attribute must still be offered: {dims:?}"
        );
        // ...and the snowflake INTERMEDIATE is not offered either: it is a
        // `Bridge` in the model facts, and a bridge's columns are join
        // machinery rather than an axis.
        assert!(
            !dims.contains(&QualifiedColumn::new("Geo", "City")),
            "a bridge's own column must not be offered: {dims:?}"
        );
    }

    #[test]
    fn a_hierarchy_level_takes_the_hierarchy_role_and_a_boolean_takes_filter() {
        let base = a_star_with(vec![sum_measure("Revenue", "Sales", "Amount")]);
        let model = base.with_hierarchies(vec![Hierarchy::new(
            "Products",
            "Product",
            vec![
                HierarchyLevel::new("Category"),
                HierarchyLevel::new("Product Name"),
            ],
        )]);
        let facts = facts_from_model(&model);
        let doc = infer(&facts, &model, &no_usage());
        let product = &doc.tables["Product"];
        assert_eq!(product.columns["Category"].role, Role::Hierarchy);
        assert_eq!(product.columns["Discontinued"].role, Role::Filter);
        assert_eq!(
            product.hierarchies,
            vec![vec!["Category".to_string(), "Product Name".to_string()]]
        );
    }

    #[test]
    fn a_closing_balance_is_last_value_over_the_date_table_and_additive_elsewhere() {
        let model = a_star_with(vec![Measure::new(
            "Stock",
            expression::closing_balance(expression::agg(
                AggregateOp::Sum,
                expression::qualified_col("Sales", "Qty"),
            )),
        )]);
        let facts = facts_from_model(&model);
        let doc = infer(&facts, &model, &no_usage());
        let spec = doc.measures["Stock"]
            .aggregation
            .as_ref()
            .expect("an aggregation is always written");
        assert_eq!(spec.default, Additivity::Additive);
        assert_eq!(
            spec.by_dimension.get("Date"),
            Some(&Additivity::LastValue),
            "a balance may not be summed along time: {:?}",
            spec.by_dimension
        );
    }

    #[test]
    fn a_dimensions_display_column_becomes_its_label_and_not_an_axis() {
        let model = a_star_with(vec![sum_measure("Revenue", "Sales", "Amount")]);
        let facts = facts_from_model(&model);
        let doc = infer(&facts, &model, &no_usage());
        let product = &doc.tables["Product"];
        assert_eq!(product.label_column.as_deref(), Some("Product Name"));
        assert_eq!(product.columns["Product Name"].role, Role::Label);
        assert!(!Role::Label.may_scope());
    }

    #[test]
    fn the_marked_date_tables_key_becomes_the_default_time_axis() {
        let model = a_star_with(vec![sum_measure("Revenue", "Sales", "Amount")]);
        let facts = facts_from_model(&model);
        let doc = infer(&facts, &model, &no_usage());
        assert_eq!(
            doc.model.default_time_axis,
            Some(QualifiedColumn::new("Date", "Date"))
        );
    }

    /// The shape a real warehouse date table has: numeric calendar parts, an ETL
    /// stamp, a sort helper.
    ///
    /// THE TWO VARIANTS DIFFER IN TYPE AS WELL AS IN ROLE, and that is the
    /// finding rather than a convenience. The engine REFUSES a `date_role` on a
    /// `Decimal` column of a MARKED date table ("must be an integer or string
    /// type"), so `Decimal(38,10)` year/quarter/month/day — exactly the columns
    /// the String/Int allowlist dropped — are the columns that cannot carry the
    /// declaration either. Fix (a), the declared `date_role`, therefore cannot
    /// reach them at all; only "it is on the marked date table" can.
    fn a_warehouse_calendar(with_date_roles: bool) -> DataModel {
        let part = |name: &str, role: DateRole| {
            if with_date_roles {
                Column::new(name, DataType::Int64).with_date_role(role)
            } else {
                Column::new(name, DataType::Decimal(38, 10))
            }
        };
        DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("Amount", DataType::Float64),
                        Column::new("Date", DataType::Date),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "BI.dim_date",
                    vec![
                        Column::new("Date", DataType::Date).with_date_role(DateRole::DateKey),
                        part("year", DateRole::Year),
                        part("quarter", DateRole::Quarter),
                        part("month", DateRole::Month),
                        part("day", DateRole::Day),
                        Column::new("month_name", DataType::String).with_sort_by("month"),
                        Column::new("etl_batch", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(Relationship::many_to_one(
                "Sales_Date",
                "Sales",
                "Date",
                "BI.dim_date",
                "Date",
            ))
            .mark_date_table("BI.dim_date")
            .add_measure(sum_measure("Revenue", "Sales", "Amount"))
            .build()
            .expect("the warehouse calendar fixture builds")
    }

    #[test]
    fn a_numeric_calendar_column_is_an_analysis_axis_whatever_its_data_type() {
        // Decimal(38,10) year/quarter/month/day is what `BI.dim_date` actually
        // looks like. The String/Int allowlist dropped every one of them to
        // `ignore`, and with them the calendar's whole decomposition axis.
        // `false`: NO date roles anywhere, which is what a model authored inside
        // Calcula looks like - `date_role` is builder-only and no host command
        // sets it. So being on the marked date table is the only thing that can
        // answer here.
        let model = a_warehouse_calendar(false);
        let facts = facts_from_model(&model);
        let doc = infer(&facts, &model, &no_usage());
        let date = &doc.tables["BI.dim_date"];
        // `month` is deliberately absent from this list: it is `month_name`'s
        // sort-order target, so machinery claims it first. The placement test
        // below is where that is pinned.
        for column in ["year", "quarter", "day"] {
            assert_eq!(
                date.columns.get(column).map(|c| c.role),
                Some(Role::Analysis),
                "'{column}' is a calendar attribute: {:?}",
                date.columns
            );
        }
        // ...and it reaches the RANKING as an offered breakdown, which is the
        // outcome the missing role was costing. (The draft itself writes no
        // dimensions at all while `INFER_ANALYSIS_DIMENSIONS` is off; the role is
        // what the switch would restore, so the role is what is asserted here.)
        let offered = offered_dimensions(&model, "Revenue");
        assert!(
            offered.iter().any(|c| c.table == "BI.dim_date"),
            "{offered:?}"
        );
    }

    /// The same warehouse calendar as above with the mark TAKEN OFF, which is
    /// what an imported star schema actually arrives as: `mark_date_table` is
    /// builder-only and no host command sets it.
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

    #[test]
    fn an_unmarked_calendar_still_produces_a_time_axis_and_its_five_part_roles() {
        // THE WHOLE CASCADE, END TO END, and every step of it used to be dead on
        // a model nobody had marked: no `date_table` meant no default time axis
        // (so no trend, seasonality or change-point fact had anything to compute
        // against), no `TableKind::Calendar` (so the role ladder's calendar arm
        // never fired), and `Decimal` calendar parts falling through the
        // String|Int allowlist to NO ROLE AT ALL.
        let model = an_unmarked_warehouse_calendar();
        let facts = facts_from_model(&model);
        let doc = infer(&facts, &model, &no_usage());

        assert_eq!(facts.tables["dim_date"].kind, Some(TableKind::Calendar));
        assert_eq!(
            doc.model.default_time_axis,
            Some(QualifiedColumn::new("dim_date", "full_date")),
            "the calendar's only Date-typed column is the axis"
        );
        for column in ["year", "quarter", "month", "day", "week_of_year"] {
            assert_eq!(
                doc.tables["dim_date"].columns.get(column).map(|c| c.role),
                Some(Role::Analysis),
                "'{column}' is a calendar attribute: {:?}",
                doc.tables["dim_date"].columns
            );
        }
        // The key stays a key, which is what keeps it usable as the axis.
        assert_eq!(doc.tables["dim_date"].columns["date_key"].role, Role::Key);
        // ...and the parts reach the ranking as offered breakdowns, which is the
        // outcome the missing calendar was costing.
        let offered = offered_dimensions(&model, "Revenue");
        assert!(
            offered.iter().any(|c| c.table == "dim_date"),
            "{offered:?}"
        );
    }

    #[test]
    fn a_declared_date_role_makes_a_column_an_axis_even_off_the_marked_table() {
        // The author's own declaration, honoured on its own. The date table here
        // is NOT marked, so the marked-table branch cannot be what answers.
        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("Amount", DataType::Float64),
                        Column::new("PeriodKey", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Period",
                    vec![
                        Column::new("PeriodKey", DataType::Int64),
                        Column::new("fiscal_year", DataType::Decimal(38, 10))
                            .with_date_role(DateRole::Year),
                        Column::new("size", DataType::Decimal(38, 10)),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(Relationship::many_to_one(
                "Sales_Period",
                "Sales",
                "PeriodKey",
                "Period",
                "PeriodKey",
            ))
            .add_measure(sum_measure("Revenue", "Sales", "Amount"))
            .build()
            .unwrap();
        let facts = facts_from_model(&model);
        let doc = infer(&facts, &model, &no_usage());
        assert_eq!(facts.tables["Period"].kind, Some(TableKind::Dimension));
        assert_eq!(doc.tables["Period"].columns["fiscal_year"].role, Role::Analysis);
        // THE NEGATIVE CONTROL, and the limit stated in this file's header: a
        // Decimal column on an ordinary dimension with no date role stays
        // undeclared, because deciding whether it is an axis needs the column
        // statistics the engine does not keep.
        assert!(
            !doc.tables["Period"].columns.contains_key("size"),
            "a numeric non-calendar column must stay undeclared: {:?}",
            doc.tables["Period"].columns
        );
    }

    #[test]
    fn the_calendar_arm_sits_below_key_and_below_ignore() {
        // PLACEMENT, not outcome. Move the calendar arm above Key and the date
        // table's own key column becomes Analysis, which takes the default time
        // axis with it; move it above Ignore and the ETL stamp and the sort-order
        // helper become offered breakdowns.
        for with_date_roles in [false, true] {
            let model = a_warehouse_calendar(with_date_roles);
            let facts = facts_from_model(&model);
            let doc = infer(&facts, &model, &no_usage());
            let date = &doc.tables["BI.dim_date"];

            assert_eq!(
                date.columns["Date"].role,
                Role::Key,
                "the date key is a JOIN column and stays Key even though it \
                 carries DateRole::DateKey (dateRoles={with_date_roles})"
            );
            assert_eq!(
                doc.model.default_time_axis,
                Some(QualifiedColumn::new("BI.dim_date", "Date")),
                "and the default time axis still finds it"
            );
            assert_eq!(
                date.columns["etl_batch"].role,
                Role::Ignore,
                "machinery on the calendar is still machinery"
            );
            assert_eq!(
                date.columns["month"].role,
                Role::Ignore,
                "the sort-order TARGET of month_name is machinery, and stays so \
                 even carrying DateRole::Month (dateRoles={with_date_roles}) - \
                 that is the arm sitting BELOW Ignore"
            );
            // Positive control: the column that sorts by it is still an axis.
            assert_eq!(date.columns["month_name"].role, Role::Analysis);
        }
    }

    #[test]
    fn every_entry_a_draft_writes_is_stamped_inferred() {
        // `reviewed: false` says "nobody has signed this off"; it cannot say WHO
        // wrote it. The editor sets `authored`, and an entry nobody has touched
        // has no source at all.
        let model = a_star_with(vec![sum_measure("Revenue", "Sales", "Amount")]);
        let facts = facts_from_model(&model);
        let doc = infer(&facts, &model, &no_usage());
        for (name, m) in &doc.measures {
            assert_eq!(
                m.source,
                Some(EntrySource::Inferred),
                "measure '{name}' is unstamped"
            );
        }
        for (name, t) in &doc.tables {
            assert_eq!(
                t.source,
                Some(EntrySource::Inferred),
                "table '{name}' is unstamped"
            );
        }
        assert_eq!(
            MeasureStrategy::default().source,
            None,
            "an untouched entry must stay distinguishable from a guessed one"
        );
        // THE MODEL BLOCK TOO. It had no `reviewed`/`source` at all, so its four
        // fields could not show the badge every other row shows - and one of
        // them, `defaultTimeAxis`, may be a calendar facts.rs GUESSED, which is
        // exactly where a guess needs somewhere to be accepted.
        assert!(!doc.model.reviewed, "the model block is drafted unreviewed");
        assert_eq!(doc.model.source, Some(EntrySource::Inferred));
        assert_eq!(
            ModelStrategy::default().source,
            None,
            "an untouched block stays distinguishable from a guessed one"
        );
    }

    #[test]
    fn a_kpi_that_carries_no_number_does_not_draft_a_kpi_target() {
        // `KpiFacts::target` is None both when the KPI declares no constant and
        // when its goal is another MEASURE, and `{"type": "kpi"}` resolves to
        // nothing in both cases: no target_value reaches the planner, so no
        // variance fact is emitted and the report is silently missing the line.
        // Drafting it would also write a document validate.rs now refuses.
        let mut kpi = Kpi::new(
            "Cost vs Budget",
            "Support Cost",
            KpiTarget::Measure("Budget".into()),
        );
        kpi = kpi.with_status_band(StatusBand::new(0.8, KpiStatus::OnTrack));
        kpi = kpi.with_status_band(StatusBand::new(1.0, KpiStatus::OffTrack));
        let model = DataModel::builder()
            .add_table(
                Table::new("Sales", vec![Column::new("Amount", DataType::Float64)]).unwrap(),
            )
            .add_measure(sum_measure("Support Cost", "Sales", "Amount"))
            .add_measure(sum_measure("Budget", "Sales", "Amount"))
            .add_kpi(kpi)
            .build()
            .expect("the measure-targeted KPI fixture builds");
        let facts = facts_from_model(&model);
        let doc = infer(&facts, &model, &no_usage());
        assert_eq!(
            doc.measures["Support Cost"].target, None,
            "a KPI with no number to inherit supplies no target"
        );
        // The KPI still decides the DIRECTION - having no goal is not having no
        // opinion - so the draft loses nothing it could defend.
        assert_eq!(
            doc.measures["Support Cost"].direction,
            Some(Direction::LowerIsBetter)
        );
        // ...and the draft is one validate.rs accepts, which is the whole point.
        assert!(
            !crate::insights::strategy::validate(&facts, &doc)
                .iter()
                .any(|f| f.code == "unresolvable-target-kpi"),
            "the draft must be savable"
        );
        // POSITIVE CONTROL: the same shape with a CONSTANT target does draft one.
        let with_constant = a_cost_measure_with_bands(vec![
            StatusBand::new(0.8, KpiStatus::OnTrack),
            StatusBand::new(1.0, KpiStatus::OffTrack),
        ]);
        let constant_facts = facts_from_model(&with_constant);
        let constant_doc = infer(&constant_facts, &with_constant, &no_usage());
        assert_eq!(
            constant_doc.measures["Support Cost"].target,
            Some(Target::Kpi)
        );
    }

    /// A contact dimension with FOUR name columns, plus three ordinary axes.
    ///
    /// The shape the role ladder had no fixture for: every model in this file
    /// and in `calibration_tests.rs` had exactly ONE name-ish column, so
    /// "the winner is the label and the runners-up are axes" could not be seen.
    fn a_dimension_with_several_name_columns() -> DataModel {
        DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("Amount", DataType::Float64),
                        Column::new("ContactKey", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Contact",
                    vec![
                        Column::new("ContactKey", DataType::Int64),
                        Column::new("FirstName", DataType::String),
                        Column::new("MiddleName", DataType::String),
                        Column::new("LastName", DataType::String),
                        Column::new("FullName", DataType::String),
                        Column::new("City", DataType::String),
                        Column::new("Country", DataType::String),
                        Column::new("Segment", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(Relationship::many_to_one(
                "Sales_Contact",
                "Sales",
                "ContactKey",
                "Contact",
                "ContactKey",
            ))
            .add_measure(sum_measure("Revenue", "Sales", "Amount"))
            .build()
            .expect("the several-names fixture builds")
    }

    #[test]
    fn a_fragment_of_a_name_still_reads_as_a_label_but_loses_to_the_whole_one() {
        // The ordering the election depends on, asserted directly so a change
        // to the lexicon cannot quietly reshuffle it. Every one of these is
        // `Some`, which is what keeps them all out of `analysis`.
        let whole = label_score("Contact", "FullName").expect("a whole name reads as a label");
        for fragment in [
            "FirstName",
            "MiddleName",
            "LastName",
            "Surname",
            "MaidenName",
            "firstname",
            "fornamn",
            "efternamn",
            "mellannamn",
        ] {
            let score = label_score("Contact", fragment)
                .unwrap_or_else(|| panic!("'{fragment}' must still read as label-shaped"));
            assert!(
                score < whole,
                "'{fragment}' scored {score}, not below the whole name's {whole}"
            );
        }
        // And a whole name that merely SHARES A PREFIX with a qualifier is not
        // a fragment: `fullstandigtnamn` begins with no entry in the list, and
        // the joined arm matches the stem exactly for that reason.
        assert_eq!(
            label_score("Kontakt", "fullstandigtnamn"),
            Some(2),
            "the swedish whole name is not a fragment"
        );
        // The table-restating form still outranks everything.
        assert_eq!(label_score("Contact", "ContactName"), Some(3));
    }

    #[test]
    fn every_name_like_column_is_label_shaped_and_only_one_of_them_wins_the_election() {
        // THE DEFECT. The label arm read the WINNER of the election
        // (`label_column == name`) and nobody else, so `FirstName`,
        // `MiddleName` and `LastName` fell through `is_one_per_row_shaped` -
        // which carries no name terms at all - into the dimension+type
        // allowlist and came out `analysis`. Revenue broken down by first name
        // is one fact per person wearing the clothes of a segmentation.
        //
        // Cardinality would NOT have rescued it: a few hundred distinct first
        // names across ten thousand customers is exactly what an axis looks
        // like to a distinct count. Only the name lexicon can demote it.
        let model = a_dimension_with_several_name_columns();
        let facts = facts_from_model(&model);
        let doc = infer(&facts, &model, &no_usage());
        let contact = &doc.tables["Contact"];

        for column in ["FirstName", "MiddleName", "LastName", "FullName"] {
            assert_eq!(
                contact.columns.get(column).map(|c| c.role),
                Some(Role::Label),
                "'{column}' is name-like and must not be an axis: {:?}",
                contact.columns
            );
        }
        // Winning the election stays a SEPARATE, additional fact about ONE
        // column - which is the pointer the report uses to name a row. It has
        // to be the WHOLE name: `FirstName` is a FRAGMENT of what a reader
        // recognises a row by, and naming a row "Anna" when three Annas are in
        // the table is the same defect as having no label at all.
        //
        // This is the half the election gets wrong on its own. All four columns
        // score alike (a trailing "name" that does not restate the table), so
        // the fold's first-maximum tie-break hands the label to whichever was
        // DECLARED FIRST - reliably a fragment, since tables are written
        // first/middle/last/full.
        assert_eq!(
            contact.label_column.as_deref(),
            Some("FullName"),
            "the whole name must beat a fragment of it: {:?}",
            contact.label_column
        );
        // POSITIVE CONTROLS: the ordinary axes beside them are untouched, so the
        // rule demotes name-like columns rather than the whole dimension.
        for column in ["City", "Country", "Segment"] {
            assert_eq!(
                contact.columns.get(column).map(|c| c.role),
                Some(Role::Analysis),
                "'{column}' is a perfectly good axis: {:?}",
                contact.columns
            );
        }
        // ...and none of them reaches the ranking as an offered breakdown.
        let offered = offered_dimensions(&model, "Revenue");
        for column in ["FirstName", "MiddleName", "LastName", "FullName"] {
            assert!(
                !offered.contains(&QualifiedColumn::new("Contact", column)),
                "'{column}' must not be offered: {offered:?}"
            );
        }
        assert!(offered.contains(&QualifiedColumn::new("Contact", "Segment")));
    }

    #[test]
    fn a_denormalised_name_that_really_is_an_axis_is_demoted_too_and_that_is_the_price() {
        // THE COST OF THE RULE ABOVE, STATED RATHER THAN HIDDEN. A `Category
        // Name` on a product dimension scores as name-like and IS a legitimate
        // axis - grouping revenue by category name is a perfectly good
        // breakdown - and this rule demotes it to `label`.
        //
        // The trade is a withheld breakdown against a meaningless one, and it is
        // paid in a dropdown a person can change: every entry ships
        // `reviewed: false`. It is asserted here so it reads as a known
        // consequence rather than turning up as a surprise.
        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("Amount", DataType::Float64),
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
                        Column::new("Product Name", DataType::String),
                        Column::new("Category Name", DataType::String),
                        Column::new("Color", DataType::String),
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
            .expect("the denormalised-name fixture builds");
        let facts = facts_from_model(&model);
        let doc = infer(&facts, &model, &no_usage());
        let product = &doc.tables["Product"];
        assert_eq!(
            product.label_column.as_deref(),
            Some("Product Name"),
            "the column that restates the table still wins the election"
        );
        assert_eq!(
            product.columns["Category Name"].role,
            Role::Label,
            "the cost: a real axis demoted because its name reads as a row's name"
        );
        // The axis that does NOT read as a name is untouched, so the price is
        // paid only where the lexicon actually fires.
        assert_eq!(product.columns["Color"].role, Role::Analysis);
    }

    #[test]
    fn a_draft_offers_no_analysis_dimensions_while_infer_analysis_dimensions_is_off() {
        // THE POLICY, PINNED. `analysisDimensions` is an EXPENSIVE attribute -
        // a wrong entry does not look wrong, it steers the decomposition search
        // and comes back as a confident explanation of the wrong thing - and it
        // is ranked with no column statistics anywhere in this codebase to tell
        // a country column from a full-name column. Empty is the honest answer
        // until those exist.
        //
        // Flipping `INFER_ANALYSIS_DIMENSIONS` to `true` REDS THIS TEST. That is
        // the point: the switch is one line, and acknowledging it is one line.
        // Bound rather than asserted inline: an assertion on a constant is a
        // clippy lint, and the constant is exactly what this test is about.
        let switch = INFER_ANALYSIS_DIMENSIONS;
        assert!(
            !switch,
            "INFER_ANALYSIS_DIMENSIONS is on: per-column distinct counts must exist \
             before a draft may propose a decomposition, and this test is where that \
             is acknowledged"
        );
        let model = a_star_with(vec![
            sum_measure("Revenue", "Sales", "Amount"),
            sum_measure("Units", "Sales", "Qty"),
        ]);
        let facts = facts_from_model(&model);
        let doc = infer(&facts, &model, &no_usage());
        for (name, m) in &doc.measures {
            assert!(
                m.analysis_dimensions.is_empty(),
                "'{name}' was drafted with dimensions: {:?}",
                m.analysis_dimensions
            );
        }
        // ...and the ranking is still alive, still correct, and still tested:
        // this is a switched-off decision, not a deleted one.
        assert!(offered_dimensions(&model, "Revenue")
            .contains(&QualifiedColumn::new("Product", "Category")));
        // The two attributes that were ALREADY withheld for the same reason.
        assert!(doc.measures["Revenue"].never_slice_by.is_empty());
        assert_eq!(doc.measures["Revenue"].materiality, None);
    }

    /// A dimension whose display column ALSO carries a date role, which is the
    /// one shape where the label column comes back with `Role::Analysis`.
    fn a_dimension_whose_label_is_also_a_date_part() -> DataModel {
        DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("Amount", DataType::Float64),
                        Column::new("PeriodKey", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Period",
                    vec![
                        Column::new("PeriodKey", DataType::Int64),
                        Column::new("Month Name", DataType::String)
                            .with_date_role(DateRole::Month),
                        Column::new("Segment", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(Relationship::many_to_one(
                "Sales_Period",
                "Sales",
                "PeriodKey",
                "Period",
                "PeriodKey",
            ))
            .add_measure(sum_measure("Revenue", "Sales", "Amount"))
            .build()
            .expect("the label-is-also-a-date-part fixture builds")
    }

    #[test]
    fn a_tables_label_column_is_never_offered_as_a_breakdown_even_when_its_role_says_analysis() {
        // A label is what a reader recognises ONE ROW by, so a measure broken
        // down by it produces one fact per record - and validate.rs refuses the
        // pairing. A proposal a validator later refuses still costs a person a
        // confusing round trip, so it must not be made in the first place.
        //
        // The role check alone does not cover this: the date-role arm sits ABOVE
        // the label arm, so `Period[Month Name]` comes back `Analysis` while
        // still being the table's declared `labelColumn`.
        let model = a_dimension_whose_label_is_also_a_date_part();
        let facts = facts_from_model(&model);
        let doc = infer(&facts, &model, &no_usage());
        let period = &doc.tables["Period"];
        assert_eq!(period.label_column.as_deref(), Some("Month Name"));
        assert_eq!(
            period.columns["Month Name"].role,
            Role::Analysis,
            "the fixture only bites while the date-role arm claims this column first"
        );

        let offered = offered_dimensions(&model, "Revenue");
        assert!(
            !offered.contains(&QualifiedColumn::new("Period", "Month Name")),
            "the label column must not be offered: {offered:?}"
        );
        // Positive control: the ordinary attribute on the same table still is,
        // so the exclusion is about the label and not about the table.
        assert!(
            offered.contains(&QualifiedColumn::new("Period", "Segment")),
            "{offered:?}"
        );
    }

    /// Three measures declared in a deliberately NON-alphabetical order, the
    /// second of them carrying a KPI.
    fn three_measures_one_with_a_kpi() -> DataModel {
        DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("Amount", DataType::Float64),
                        Column::new("Qty", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_measure(sum_measure("Zeta", "Sales", "Amount"))
            .add_measure(sum_measure("Alpha", "Sales", "Qty"))
            .add_measure(sum_measure("Beta", "Sales", "Amount"))
            .add_kpi(Kpi::new("Alpha KPI", "Alpha", KpiTarget::Constant(10.0)))
            .build()
            .expect("the priority fixture builds")
    }

    #[test]
    fn a_workbook_with_no_pivots_still_gets_a_priority_seeded_kpi_first_then_declaration_order() {
        // `usage.ranked_measures()` is empty on a model whose workbook has no
        // pivots, saved layouts or slicers - a freshly imported model - and an
        // empty `model.priority` leaves the report generator with nothing to
        // order its KPIs by at all.
        let model = three_measures_one_with_a_kpi();
        let facts = facts_from_model(&model);
        let doc = infer(&facts, &model, &no_usage());
        assert_eq!(
            doc.model.priority,
            vec!["Alpha".to_string(), "Zeta".to_string(), "Beta".to_string()],
            "KPI first, then the order the model declares them in"
        );
        // Both halves of that claim have teeth in this fixture: alphabetical
        // order would have put Beta second, and declaration order alone would
        // have put Zeta first.
        assert_eq!(
            model.measures().iter().map(|m| m.name()).collect::<Vec<_>>(),
            vec!["Zeta", "Alpha", "Beta"]
        );
        // The seed is a model-wide LIST. Per-measure `priority` is an override of
        // it and stays unset, or the two would rank against each other.
        for (name, m) in &doc.measures {
            assert_eq!(m.priority, None, "'{name}' got an invented per-measure rank");
        }
        // A seed is still a guess: it is stamped and left unreviewed like the
        // rest of the draft.
        assert!(doc.measures.values().all(|m| !m.reviewed));
    }

    #[test]
    fn what_the_workbook_actually_reports_beats_the_seeded_order() {
        // Evidence outranks a heuristic. One pivot on Beta and Beta leads, KPI
        // or no KPI - which is also why the seed only ever fills a VACUUM.
        use crate::insights::usage::{ObservedObject, UsageObjectKind};
        let model = three_measures_one_with_a_kpi();
        let facts = facts_from_model(&model);
        let usage = UsageIndex::build(
            &[ObservedObject {
                kind: UsageObjectKind::BiPivot,
                saved: false,
                measures: vec!["Beta".to_string()],
                columns: vec![QualifiedColumn::new("Sales", "Qty")],
            }],
            &model,
        );
        let doc = infer(&facts, &model, &usage);
        assert_eq!(doc.model.priority, vec!["Beta".to_string()]);
    }

    #[test]
    fn a_words_split_breaks_on_camel_case_and_folds_swedish_letters() {
        assert_eq!(words("netSalesAmount"), ["net", "sales", "amount"]);
        assert_eq!(words("Costa Rica Sales"), ["costa", "rica", "sales"]);
        assert_eq!(words("HTTPServerErrors"), ["http", "server", "errors"]);
        assert_eq!(words("Avgång_2025"), ["avgång", "2025"]);
        // The plural rule adds an s rather than stripping one.
        assert!(has_term(&words("Support Costs"), "cost"));
        assert!(!has_term(&words("Costa Rica"), "cost"));
    }
}
