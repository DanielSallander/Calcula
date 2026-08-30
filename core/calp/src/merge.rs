//! FILENAME: core/calp/src/merge.rs
//! PURPOSE: Decide whether two concurrent sets of changes to a package can both
//! land, and say precisely where they collide when they cannot.
//! CONTEXT: A package is not a monolith. It is a tree of addressable pieces —
//! sheets down to individual cells, and objects (charts, controls, scripts,
//! measures) with stable ids. Two developers who touch different pieces have
//! not conflicted, and telling them they have is the thing that makes people
//! stop using version control.
//!
//! # The grain
//!
//! * **Sheet data: one cell.** Editing `Summary!B4` while somebody edits
//!   `Summary!D9` is not a conflict, even though it is the same sheet and the
//!   same file.
//! * **Everything else: one object.** A chart, a control, a script, a measure —
//!   each identified by its stable id. Two people editing the same chart is a
//!   conflict; one editing a chart while the other edits a script is not.
//! * **Structure: the sheet.** Adding, removing or renaming a sheet is a change
//!   to the sheet as a whole, and collides with any other structural change to
//!   it.
//!
//! # What disjointness does NOT mean
//!
//! It does not mean independence. Your new formula may reference a cell their
//! change rewrote, and no piece-level check can see that — the reference lives
//! in the formula's meaning, not in its address. A merged result is therefore
//! always RECALCULATED, and the merge is disclosed rather than performed
//! silently. A later refinement can walk the dependency graph and warn; the
//! honest answer today is to recalculate and say what was merged with what.
//!
//! # When the analysis cannot answer
//!
//! If either diff had to cap its cell counts, the set of touched pieces is a
//! floor rather than the truth — and a disjointness claim made from a floor is
//! a guess. [`analyze`] refuses in that case. "I could not tell" and "they do
//! not overlap" must never produce the same answer.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::diff::VersionDiff;

/// One addressable piece of a package.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PieceKey {
    /// One cell of one sheet.
    #[serde(rename_all = "camelCase")]
    Cell { sheet_id: String, a1: String },
    /// A sheet as a whole: added, removed or renamed.
    #[serde(rename_all = "camelCase")]
    SheetStructure { sheet_id: String },
    /// Anything with a stable id: a chart, a script, a measure, a control.
    #[serde(rename_all = "camelCase")]
    Object { domain: String, id: String },
    /// A manifest-level field (the compat floor, the package kind).
    #[serde(rename_all = "camelCase")]
    ManifestField { field: String },
}

impl PieceKey {
    /// How a person would refer to this piece.
    pub fn describe(&self) -> String {
        match self {
            PieceKey::Cell { a1, .. } => format!("cell {a1}"),
            PieceKey::SheetStructure { .. } => "the sheet itself".to_string(),
            PieceKey::Object { domain, id } => format!("{domain} {id}"),
            PieceKey::ManifestField { field } => format!("package setting '{field}'"),
        }
    }
}

/// One piece both sides changed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collision {
    pub piece: PieceKey,
    /// A sentence naming what collided, for the refusal message.
    pub description: String,
    /// The sheet the piece belongs to, when it belongs to one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sheet_name: Option<String>,
}

/// What a push can do, given what landed while its author was working.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeVerdict {
    /// Nothing landed since: publish straight away.
    FastForward,
    /// Something landed, but it touched different pieces, and every piece it
    /// touched is one this build knows how to bring across.
    CanMerge,
    /// Something landed that touched the same pieces. There is no automatic
    /// content merge inside a piece, and last-writer-wins is the Excel failure
    /// this project exists to end.
    Conflict,
    /// Disjoint, but this build cannot apply the intervening changes — see
    /// [`MergeAnalysis::unmergeable`]. Not a conflict: the work is compatible,
    /// the machinery is the limit, and the remedy is the same as a conflict's.
    CannotApply,
}

/// The full picture, for a UI that has to explain itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeAnalysis {
    pub verdict: MergeVerdict,
    /// Pieces both sides changed. Empty unless the verdict is `Conflict`.
    pub collisions: Vec<Collision>,
    /// A short account of what landed while the author was working.
    pub their_summary: Vec<String>,
    /// …and of what the author changed.
    pub your_summary: Vec<String>,
    /// Kinds of intervening change this build cannot bring across, when that is
    /// what blocked the merge.
    pub unmergeable: Vec<String>,
}

/// Every piece a diff says was touched.
///
/// Reads the diff's exact per-sheet cell lists rather than its display SAMPLE —
/// callers must have run the diff with sampling wide enough to cover the
/// changes, which [`analyze`] checks for.
pub fn pieces_touched(diff: &VersionDiff) -> BTreeSet<PieceKey> {
    let mut out = BTreeSet::new();

    for sheet in &diff.sheets {
        if sheet.change != "modified" {
            out.insert(PieceKey::SheetStructure { sheet_id: sheet.sheet_id.clone() });
        }
        for cell in &sheet.sample {
            out.insert(PieceKey::Cell {
                sheet_id: sheet.sheet_id.clone(),
                a1: cell.a1.clone(),
            });
        }
        // A sheet-wide presentation change (its style table, its layout, its
        // settings) is a change to the sheet, not to any one cell.
        if sheet.styles_table_changed || sheet.layout_changed || sheet.metadata_changed {
            out.insert(PieceKey::Object {
                domain: "sheetPresentation".to_string(),
                id: sheet.sheet_id.clone(),
            });
        }
    }

    for object in &diff.objects {
        out.insert(PieceKey::Object {
            domain: object.domain.clone(),
            id: object.id.clone(),
        });
    }

    for change in &diff.manifest_changes {
        // The publisher key is not a piece anybody edits — it is an identity
        // fact, gated separately by key continuity — so it never participates
        // in a merge decision.
        if change.field == "publisherKey" || change.field == "publishedBy" {
            continue;
        }
        out.insert(PieceKey::ManifestField { field: change.field.clone() });
    }

    out
}

/// Whether every change in `theirs` is one this build can bring into a working
/// copy.
///
/// Cell edits can: they are values and formulas written into a grid the app
/// already knows how to write to. Object changes cannot yet — materializing one
/// chart, or one control, out of a published version means calling a slice of
/// the pull materializer that is not separately addressable. That is a
/// machinery limit, stated plainly, not a judgement about the change.
fn unmergeable_kinds(theirs: &BTreeSet<PieceKey>) -> Vec<String> {
    let mut kinds: BTreeSet<String> = BTreeSet::new();
    for piece in theirs {
        match piece {
            PieceKey::Cell { .. } => {}
            PieceKey::SheetStructure { .. } => {
                kinds.insert("a sheet was added, removed or renamed".to_string());
            }
            PieceKey::Object { domain, .. } => {
                kinds.insert(format!("changes to {domain}"));
            }
            PieceKey::ManifestField { field } => {
                kinds.insert(format!("a change to the package setting '{field}'"));
            }
        }
    }
    kinds.into_iter().collect()
}

/// Decide what a push can do.
///
/// * `theirs` — head against the author's base: what landed while they worked.
/// * `yours` — the working copy against that same base: what they changed.
///
/// Both must be diffed against the SAME base, or the two piece sets are not
/// comparable.
pub fn analyze(theirs: &VersionDiff, yours: &VersionDiff) -> MergeAnalysis {
    let their_pieces = pieces_touched(theirs);
    let your_pieces = pieces_touched(yours);

    if their_pieces.is_empty() {
        return MergeAnalysis {
            verdict: MergeVerdict::FastForward,
            collisions: Vec::new(),
            their_summary: Vec::new(),
            your_summary: summarize(yours),
            unmergeable: Vec::new(),
        };
    }

    // A piece set built from a capped diff is a FLOOR, and disjointness proved
    // against a floor is not proved. Refuse rather than guess: "I could not
    // tell" and "they do not overlap" must not be the same answer.
    if !theirs.totals.cells_changed_exact || !yours.totals.cells_changed_exact {
        return MergeAnalysis {
            verdict: MergeVerdict::CannotApply,
            collisions: Vec::new(),
            their_summary: summarize(theirs),
            your_summary: summarize(yours),
            unmergeable: vec![
                "the changes are too large to compare cell by cell, so whether \
                 they overlap cannot be established"
                    .to_string(),
            ],
        };
    }
    // Same argument for a truncated SAMPLE: the sheet's cell list is short of
    // its own count, so pieces are missing from the set.
    if theirs.sheets.iter().any(|s| s.sample_truncated)
        || yours.sheets.iter().any(|s| s.sample_truncated)
    {
        return MergeAnalysis {
            verdict: MergeVerdict::CannotApply,
            collisions: Vec::new(),
            their_summary: summarize(theirs),
            your_summary: summarize(yours),
            unmergeable: vec![
                "too many changed cells to list, so whether they overlap cannot \
                 be established"
                    .to_string(),
            ],
        };
    }

    let overlap: Vec<&PieceKey> = their_pieces.intersection(&your_pieces).collect();
    if !overlap.is_empty() {
        let collisions = overlap
            .into_iter()
            .map(|piece| Collision {
                description: describe_collision(piece, theirs, yours),
                sheet_name: sheet_name_of(piece, theirs).or_else(|| sheet_name_of(piece, yours)),
                piece: piece.clone(),
            })
            .collect();
        return MergeAnalysis {
            verdict: MergeVerdict::Conflict,
            collisions,
            their_summary: summarize(theirs),
            your_summary: summarize(yours),
            unmergeable: Vec::new(),
        };
    }

    let unmergeable = unmergeable_kinds(&their_pieces);
    MergeAnalysis {
        verdict: if unmergeable.is_empty() {
            MergeVerdict::CanMerge
        } else {
            MergeVerdict::CannotApply
        },
        collisions: Vec::new(),
        their_summary: summarize(theirs),
        your_summary: summarize(yours),
        unmergeable,
    }
}

fn describe_collision(piece: &PieceKey, theirs: &VersionDiff, yours: &VersionDiff) -> String {
    match piece {
        PieceKey::Cell { sheet_id, a1 } => {
            let sheet = theirs
                .sheets
                .iter()
                .chain(yours.sheets.iter())
                .find(|s| &s.sheet_id == sheet_id)
                .map(|s| s.name.as_str())
                .unwrap_or("a sheet");
            format!("{sheet}!{a1} was changed on both sides")
        }
        PieceKey::SheetStructure { sheet_id } => {
            let sheet = theirs
                .sheets
                .iter()
                .chain(yours.sheets.iter())
                .find(|s| &s.sheet_id == sheet_id)
                .map(|s| s.name.as_str())
                .unwrap_or("a sheet");
            format!("the sheet '{sheet}' was added, removed or renamed on both sides")
        }
        PieceKey::Object { domain, id } => {
            let name = theirs
                .objects
                .iter()
                .chain(yours.objects.iter())
                .find(|o| &o.domain == domain && &o.id == id)
                .map(|o| o.name.clone())
                .unwrap_or_else(|| id.clone());
            format!("the {domain} '{name}' was changed on both sides")
        }
        PieceKey::ManifestField { field } => {
            format!("the package setting '{field}' was changed on both sides")
        }
    }
}

fn sheet_name_of(piece: &PieceKey, diff: &VersionDiff) -> Option<String> {
    let sheet_id = match piece {
        PieceKey::Cell { sheet_id, .. } | PieceKey::SheetStructure { sheet_id } => sheet_id,
        _ => return None,
    };
    diff.sheets
        .iter()
        .find(|s| &s.sheet_id == sheet_id)
        .map(|s| s.name.clone())
}

/// A few lines a person can read, describing one side's changes.
fn summarize(diff: &VersionDiff) -> Vec<String> {
    let mut out = Vec::new();
    for sheet in &diff.sheets {
        let cells = sheet.cells_added + sheet.cells_removed + sheet.cells_modified;
        match sheet.change.as_str() {
            "added" => out.push(format!("added the sheet '{}'", sheet.name)),
            "removed" => out.push(format!("removed the sheet '{}'", sheet.name)),
            "renamed" => out.push(format!(
                "renamed '{}' to '{}'",
                sheet.renamed_from.as_deref().unwrap_or("a sheet"),
                sheet.name
            )),
            _ if cells > 0 => out.push(format!(
                "changed {cells} cell{} on '{}'",
                if cells == 1 { "" } else { "s" },
                sheet.name
            )),
            _ => {}
        }
    }
    for object in &diff.objects {
        let verb = match object.change.as_str() {
            "added" => "added",
            "removed" => "removed",
            _ => "changed",
        };
        out.push(format!("{verb} the {} '{}'", object.domain, object.name));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::{
        ArtifactDiffSummary, CellDiff, DiffTotals, ObjectChange, SheetDiffSummary, VersionDiff,
    };

    fn sheet(id: &str, name: &str, cells: &[&str]) -> SheetDiffSummary {
        SheetDiffSummary {
            sheet_id: id.to_string(),
            name: name.to_string(),
            change: "modified".to_string(),
            renamed_from: None,
            cells_added: 0,
            cells_removed: 0,
            cells_modified: cells.len(),
            formula_changes: 0,
            counts_exact: true,
            style_changed_cells: 0,
            styles_table_changed: false,
            layout_changed: false,
            metadata_changed: false,
            sample: cells
                .iter()
                .map(|a1| CellDiff {
                    a1: (*a1).to_string(),
                    row: 0,
                    col: 0,
                    change: "modified".to_string(),
                    before: None,
                    after: None,
                })
                .collect(),
            sample_truncated: false,
        }
    }

    fn object(domain: &str, id: &str, name: &str) -> ObjectChange {
        ObjectChange {
            domain: domain.to_string(),
            id: id.to_string(),
            name: name.to_string(),
            sheet_name: None,
            change: "added".to_string(),
            detail: String::new(),
            artifact_path: None,
            before: None,
            after: None,
            before_truncated: false,
            after_truncated: false,
            added_capabilities: Vec::new(),
            removed_capabilities: Vec::new(),
        }
    }

    fn diff(sheets: Vec<SheetDiffSummary>, objects: Vec<ObjectChange>) -> VersionDiff {
        let cells = sheets
            .iter()
            .map(|s| s.cells_added + s.cells_removed + s.cells_modified)
            .sum();
        VersionDiff {
            package_name: "pkg".to_string(),
            from_version: "1.0.0".to_string(),
            to_version: "1.1.0".to_string(),
            artifacts: ArtifactDiffSummary::default(),
            sheets,
            objects,
            manifest_changes: Vec::new(),
            totals: DiffTotals {
                objects_added: 0,
                objects_removed: 0,
                objects_modified: 0,
                sheets_changed: 0,
                cells_changed: cells,
                cells_changed_exact: true,
            },
        }
    }

    #[test]
    fn nothing_landed_is_a_fast_forward() {
        let theirs = diff(Vec::new(), Vec::new());
        let yours = diff(vec![sheet("s1", "Summary", &["B4"])], Vec::new());
        assert_eq!(analyze(&theirs, &yours).verdict, MergeVerdict::FastForward);
    }

    #[test]
    fn different_cells_on_the_same_sheet_do_not_collide() {
        // The case the whole design turns on: one file, two people, no conflict.
        let theirs = diff(vec![sheet("s1", "Summary", &["B4"])], Vec::new());
        let yours = diff(vec![sheet("s1", "Summary", &["D9"])], Vec::new());
        let analysis = analyze(&theirs, &yours);
        assert_eq!(analysis.verdict, MergeVerdict::CanMerge);
        assert!(analysis.collisions.is_empty());
        assert_eq!(analysis.their_summary, vec!["changed 1 cell on 'Summary'"]);
    }

    #[test]
    fn the_same_cell_on_both_sides_collides_and_names_itself() {
        let theirs = diff(vec![sheet("s1", "Summary", &["B4"])], Vec::new());
        let yours = diff(vec![sheet("s1", "Summary", &["B4", "D9"])], Vec::new());
        let analysis = analyze(&theirs, &yours);
        assert_eq!(analysis.verdict, MergeVerdict::Conflict);
        assert_eq!(analysis.collisions.len(), 1);
        assert_eq!(
            analysis.collisions[0].description,
            "Summary!B4 was changed on both sides"
        );
        assert_eq!(analysis.collisions[0].sheet_name.as_deref(), Some("Summary"));
    }

    #[test]
    fn cells_on_different_sheets_do_not_collide() {
        let theirs = diff(vec![sheet("s1", "Summary", &["B4"])], Vec::new());
        let yours = diff(vec![sheet("s2", "Data", &["B4"])], Vec::new());
        assert_eq!(analyze(&theirs, &yours).verdict, MergeVerdict::CanMerge);
    }

    #[test]
    fn a_button_and_a_formula_are_different_pieces() {
        // The owner's worked example: one developer adds a control, another
        // edits a cell. Disjoint — but adding a control is not something this
        // build can bring across, so the verdict is CannotApply rather than
        // Conflict, and the distinction is the point: the WORK is compatible.
        let theirs = diff(Vec::new(), vec![object("control", "btn-1", "Refresh")]);
        let yours = diff(vec![sheet("s1", "Summary", &["B4"])], Vec::new());
        let analysis = analyze(&theirs, &yours);
        assert_eq!(analysis.verdict, MergeVerdict::CannotApply);
        assert!(
            analysis.collisions.is_empty(),
            "a button and a formula never collide"
        );
        assert_eq!(analysis.unmergeable, vec!["changes to control"]);

        // The other direction merges: their cell edit CAN be brought into a
        // copy that added a button.
        let analysis = analyze(&yours, &theirs);
        assert_eq!(analysis.verdict, MergeVerdict::CanMerge);
    }

    #[test]
    fn the_same_object_on_both_sides_collides() {
        let theirs = diff(Vec::new(), vec![object("chart", "c-1", "Revenue")]);
        let yours = diff(Vec::new(), vec![object("chart", "c-1", "Revenue")]);
        let analysis = analyze(&theirs, &yours);
        assert_eq!(analysis.verdict, MergeVerdict::Conflict);
        assert_eq!(
            analysis.collisions[0].description,
            "the chart 'Revenue' was changed on both sides"
        );
    }

    #[test]
    fn different_objects_do_not_collide() {
        let theirs = diff(Vec::new(), vec![object("chart", "c-1", "Revenue")]);
        let yours = diff(Vec::new(), vec![object("moduleScript", "m-1", "helpers")]);
        let analysis = analyze(&theirs, &yours);
        assert!(analysis.collisions.is_empty());
    }

    #[test]
    fn an_inexact_diff_refuses_rather_than_guessing_disjointness() {
        // The safety rule. A piece set built from a capped diff is a FLOOR, so
        // "no overlap found" would mean "no overlap found IN WHAT I LOOKED AT".
        let mut theirs = diff(vec![sheet("s1", "Summary", &["B4"])], Vec::new());
        theirs.totals.cells_changed_exact = false;
        let yours = diff(vec![sheet("s2", "Data", &["D9"])], Vec::new());
        let analysis = analyze(&theirs, &yours);
        assert_eq!(
            analysis.verdict,
            MergeVerdict::CannotApply,
            "disjointness proved against a floor is not proved"
        );
        assert!(!analysis.unmergeable.is_empty());
    }

    #[test]
    fn a_truncated_sample_also_refuses() {
        let mut theirs = diff(vec![sheet("s1", "Summary", &["B4"])], Vec::new());
        theirs.sheets[0].sample_truncated = true;
        let yours = diff(vec![sheet("s2", "Data", &["D9"])], Vec::new());
        assert_eq!(analyze(&theirs, &yours).verdict, MergeVerdict::CannotApply);
    }

    #[test]
    fn a_publisher_key_change_is_not_a_merge_conflict() {
        // Key continuity has its own gate, with its own remedy. Reporting it
        // here as well would give the user two different explanations of one
        // problem, and neither would be the actionable one.
        let mut theirs = diff(Vec::new(), Vec::new());
        theirs.manifest_changes.push(crate::diff::ManifestFieldChange {
            field: "publisherKey".to_string(),
            before: "aaa".to_string(),
            after: "bbb".to_string(),
        });
        let yours = diff(vec![sheet("s1", "Summary", &["B4"])], Vec::new());
        assert_eq!(
            analyze(&theirs, &yours).verdict,
            MergeVerdict::FastForward,
            "no PIECE was touched, so there is nothing to merge"
        );
    }
}
