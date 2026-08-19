//! FILENAME: app/src-tauri/src/object_deps.rs
//! PURPOSE: THE OBJECT-DEPENDENCY CENSUS and the cascades it declares — what
//!          happens to every object that POINTS AT another object when that
//!          object is deleted.
//! CONTEXT: §3bn in docs/design/open-decisions-2026-08.md.
//!
//! # The defect this exists for
//!
//! Delete a table that a slicer filters, and the table went away while the
//! slicer stayed — with its binding INTACT, pointing at an id that no longer
//! resolves. Measured: `tables = 0`, `slicers = 1`, `cacheSourceId` still the
//! dead table's. The orphan surfaced twice over: `get_slicer_items` answered
//! `"Table {id} not found"` on every repaint (a console error per frame), and
//! the slicer's overlay kept claiming its rectangle, so clicks meant for the
//! grid underneath hit a control that could never respond — 171 click retries
//! into a 120 s timeout in the invariant runner. It was classified as a monkey
//! flake THREE times before it was reduced by hand.
//!
//! # Why this is a module and not three `retain` calls
//!
//! "Deleting an object that other objects depend on" is a SHAPE, not an
//! incident. The same program has already learned, repeatedly, that fixing the
//! named instance leaves the siblings — and the siblings here were:
//!
//! * deleting a PIVOT orphaned its slicers, its timeline slicers, and every
//!   ribbon filter that listed it in `connected_pivots`;
//! * deleting a SLICER left ribbon filters pointing at it through
//!   `cross_filter_slicer_targets`;
//! * deleting a RIBBON FILTER left its siblings' `cross_filter_targets`
//!   pointing at it;
//! * deleting a CHART left a pane-control slider bound to a chart parameter
//!   that no longer had a chart;
//! * deleting a SHEET removed the tables and pivots on it — and orphaned every
//!   slicer and timeline bound to those, on OTHER sheets, where the user could
//!   still see them.
//!
//! So the pairs are enumerated as data ([`DEPENDENCY_MATRIX`]), the cascades
//! are implemented once here, and `object_deps_census_tests` fails the build if
//! a new delete command appears without a declared answer. Six censuses are the
//! precedent; this is the seventh.
//!
//! # The policy, and why it is Excel's
//!
//! Excel deletes a slicer when the last thing it filters goes away, and keeps
//! it — repointed — when a Report Connection still has a live target. That is
//! exactly [`DeletePolicy::CascadeOrRebind`]: the dead ids are dropped from the
//! connection list first, and only a slicer with NOTHING left to filter is
//! deleted. A slicer that filters three pivots and loses one keeps filtering
//! the other two, and its `cache_source_id` is repointed to one of them so the
//! item list still resolves.
//!
//! Where Excel simply prunes a dangling pointer and keeps the object (a ribbon
//! filter's cross-filter target list, a pane control's chart binding), the
//! policy is [`DeletePolicy::Prune`]: the object survives, minus the reference.
//! Deleting a chart must not delete the slider that drove it.
//!
//! # UNDO IS PART OF THE CASCADE, NOT AN AFTERTHOUGHT
//!
//! A cascade that cannot be undone is a data-loss bug wearing a fix's clothes.
//! [`record_source_cascade_undo`] pushes a restore for every object the cascade
//! touched into the transaction the DELETING command already has open, so one
//! Ctrl+Z brings back the table AND its slicers AND their bindings. The one
//! exception is timeline slicers, which have no restore arm YET. The reason
//! this comment used to give -- "`TimelineSlicerState` is not persisted at all"
//! -- stopped being true on 2026-08-19, when timelines gained a `.cala`/`.calp`
//! section and the store became `Persisted<T>`. What is still missing is only
//! the undo arm, tracked as the remaining half of BUG-0103. Until it lands the
//! cascade still REMOVES them, because a timeline pointing at a deleted pivot
//! renders nothing and eats clicks exactly like the slicer did -- but a delete
//! is now a loss the user cannot undo, which is a stronger reason to finish it.

use std::collections::{BTreeSet, HashSet};

use identity::EntityId;
use tauri::State;

use crate::document_effect::DocumentEffect;
use crate::pane_control::{PaneControl, PaneControlConfig, PaneControlState};
use crate::ribbon_filter::{RibbonFilter, RibbonFilterState};
use crate::slicer::types::{Slicer, SlicerSourceType, SlicerState};
use crate::timeline_slicer::types::{TimelineSlicer, TimelineSlicerState};
use crate::AppState;

// ===========================================================================
// THE DECLARED MATRIX
// ===========================================================================

/// Every workbook object whose deletion this census governs.
///
/// The name is the one the DELETE COMMAND uses, because that is what the census
/// matches on: `delete_table` -> [`ObjectKind::Table`]. A kind here with no row
/// in [`DEPENDENCY_MATRIX`] fails the census, and so does a delete command whose
/// object is not listed here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ObjectKind {
    Table,
    Pivot,
    Chart,
    Slicer,
    TimelineSlicer,
    RibbonFilter,
    PaneControl,
    FloatingControl,
    NamedRange,
    Sheet,
    Report,
    Script,
    ObjectScript,
    CellBehavior,
    ConditionalFormat,
    DataValidation,
    Sparkline,
    AutoFilter,
    NamedStyle,
    PivotLayout,
    Comment,
    Note,
    Hyperlink,
    ComputedProperty,
    TableColumn,
    ObjectTemplate,
    BiConnection,
    FloatingRange,
}

impl ObjectKind {
    /// Stable wire/report name — what the dependency table prints and what
    /// `list_object_dependents` accepts.
    pub fn wire_name(self) -> &'static str {
        match self {
            ObjectKind::Table => "table",
            ObjectKind::Pivot => "pivot",
            ObjectKind::Chart => "chart",
            ObjectKind::Slicer => "slicer",
            ObjectKind::TimelineSlicer => "timelineSlicer",
            ObjectKind::RibbonFilter => "ribbonFilter",
            ObjectKind::PaneControl => "paneControl",
            ObjectKind::FloatingControl => "control",
            ObjectKind::NamedRange => "namedRange",
            ObjectKind::Sheet => "sheet",
            ObjectKind::Report => "report",
            ObjectKind::Script => "script",
            ObjectKind::ObjectScript => "objectScript",
            ObjectKind::CellBehavior => "cellBehavior",
            ObjectKind::ConditionalFormat => "conditionalFormat",
            ObjectKind::DataValidation => "dataValidation",
            ObjectKind::Sparkline => "sparkline",
            ObjectKind::AutoFilter => "autoFilter",
            ObjectKind::NamedStyle => "namedStyle",
            ObjectKind::PivotLayout => "pivotLayout",
            ObjectKind::Comment => "comment",
            ObjectKind::Note => "note",
            ObjectKind::Hyperlink => "hyperlink",
            ObjectKind::ComputedProperty => "computedProperty",
            ObjectKind::TableColumn => "tableColumn",
            ObjectKind::ObjectTemplate => "objectTemplate",
            ObjectKind::BiConnection => "biConnection",
            ObjectKind::FloatingRange => "floatingRange",
        }
    }

    /// Every kind, for the census's exhaustiveness sweep. A new variant that is
    /// not added here makes `every_object_kind_is_enumerated` fail, so the list
    /// cannot silently fall behind the enum.
    pub const ALL: &'static [ObjectKind] = &[
        ObjectKind::Table,
        ObjectKind::Pivot,
        ObjectKind::Chart,
        ObjectKind::Slicer,
        ObjectKind::TimelineSlicer,
        ObjectKind::RibbonFilter,
        ObjectKind::PaneControl,
        ObjectKind::FloatingControl,
        ObjectKind::NamedRange,
        ObjectKind::Sheet,
        ObjectKind::Report,
        ObjectKind::Script,
        ObjectKind::ObjectScript,
        ObjectKind::CellBehavior,
        ObjectKind::ConditionalFormat,
        ObjectKind::DataValidation,
        ObjectKind::Sparkline,
        ObjectKind::AutoFilter,
        ObjectKind::NamedStyle,
        ObjectKind::PivotLayout,
        ObjectKind::Comment,
        ObjectKind::Note,
        ObjectKind::Hyperlink,
        ObjectKind::ComputedProperty,
        ObjectKind::TableColumn,
        ObjectKind::ObjectTemplate,
        ObjectKind::BiConnection,
        ObjectKind::FloatingRange,
    ];

    /// The frontend refresh domain that makes this kind's cached copy agree
    /// with the backend again.
    ///
    /// EVERY VARIANT IS ANSWERED, and the compiler enforces that — the whole
    /// point of putting the mapping here instead of in a lookup table on the
    /// frontend, where it was a list of regexes that a new object kind could
    /// simply miss.
    ///
    /// [`UiDomain::None`] is a claim that no frontend store holds this kind by
    /// id in a way an announcement could repair, and each one is argued:
    ///
    /// * `Report`, `Script`, `ObjectScript`, `CellBehavior`, `ObjectTemplate`,
    ///   `PivotLayout`, `ComputedProperty` — script-side or list-side records.
    ///   They paint nothing on the grid and claim no rectangle, so a stale one
    ///   is a failed lookup, never a swallowed click.
    /// * `AutoFilter` — the extension reads row visibility from the backend on
    ///   every repaint; it holds no object cache that can outlive the delete.
    /// * `BiConnection` — `WarnAndKeep`: nothing is deleted, so nothing goes
    ///   stale.
    pub fn ui_domain(self) -> UiDomain {
        match self {
            // Table definitions ride the `objects` domain, which fans out to
            // TABLE_DEFINITIONS_UPDATED among others.
            ObjectKind::Table | ObjectKind::TableColumn => UiDomain::Objects,
            ObjectKind::Pivot => UiDomain::Pivot,
            // Charts and sparklines are index-anchored floating objects and
            // share the `objects` domain with the table definitions.
            ObjectKind::Chart | ObjectKind::Sparkline => UiDomain::Objects,
            // ONE domain for both slicer families. They are two extensions, so
            // the Shell translator fans `slicer` out to BOTH refresh events --
            // a timeline whose pivot was deleted is the same ghost overlay a
            // canvas slicer is.
            ObjectKind::Slicer | ObjectKind::TimelineSlicer => UiDomain::Slicer,
            ObjectKind::RibbonFilter => UiDomain::RibbonFilter,
            ObjectKind::PaneControl => UiDomain::PaneControl,
            ObjectKind::FloatingControl => UiDomain::Controls,
            ObjectKind::FloatingRange => UiDomain::FloatingRanges,
            ObjectKind::Sheet => UiDomain::Sheets,
            ObjectKind::ConditionalFormat => UiDomain::ConditionalFormats,
            ObjectKind::DataValidation => UiDomain::Validations,
            ObjectKind::NamedStyle => UiDomain::Styles,
            ObjectKind::Comment | ObjectKind::Note => UiDomain::Annotations,
            ObjectKind::Hyperlink => UiDomain::Hyperlinks,
            ObjectKind::NamedRange => UiDomain::NamedRanges,
            ObjectKind::Report
            | ObjectKind::Script
            | ObjectKind::ObjectScript
            | ObjectKind::CellBehavior
            | ObjectKind::AutoFilter
            | ObjectKind::PivotLayout
            | ObjectKind::ComputedProperty
            | ObjectKind::ObjectTemplate
            | ObjectKind::BiConnection => UiDomain::None,
        }
    }
}

/// What deleting the owner does to a dependent.
///
/// The four verbs are deliberately the only four. "Orphan" is not among them:
/// that is the defect, not a policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeletePolicy {
    /// The dependent is deleted with the owner because it cannot exist without
    /// it. Excel's rule for a slicer whose last source is gone.
    Cascade,
    /// The dependent survives if it still has another live source, repointed to
    /// it; it is deleted only when nothing is left. Excel's Report-Connections
    /// rule.
    CascadeOrRebind,
    /// The dependent survives; only the dead REFERENCE is removed from it.
    Prune,
    /// The dependent's stored text is rewritten (structured references frozen
    /// into ranges, 3D references turned into `#REF!`).
    Repair,
    /// The dependent keeps a reference that is now unresolvable, deliberately,
    /// because Excel does — and the user is TOLD before the delete happens.
    /// `note` must name the surface that tells them.
    WarnAndKeep,
    /// The delete is refused while the dependent exists.
    Refuse,
    /// The dependent holds no reference; it is merely CO-LOCATED with the owner
    /// and recalculates or repaints. `note` says what makes that true.
    Recalculate,
    /// Nothing in the workbook can point at this object. `note` says why.
    NoDependents,
}

impl DeletePolicy {
    /// Policies that must be backed by executable cleanup: the census demands a
    /// non-empty `implemented_by` for these and rejects one for the rest.
    pub fn needs_implementation(self) -> bool {
        matches!(
            self,
            DeletePolicy::Cascade
                | DeletePolicy::CascadeOrRebind
                | DeletePolicy::Prune
                | DeletePolicy::Repair
                | DeletePolicy::Recalculate
        )
    }
}

/// One (owner, dependent) pair and the answer to "what does deleting the owner
/// do to it today".
#[derive(Debug, Clone, Copy)]
pub struct DependencyRule {
    /// The object being deleted.
    pub owner: ObjectKind,
    /// What points at it — a human-readable "kind.field" so the row names the
    /// EDGE, not just the type (a slicer points at a table two different ways).
    pub dependent: &'static str,
    /// The WORKBOOK OBJECT the dependent edge lives on, when the dependent is
    /// an object at all. `None` for the rows whose dependent is a formula, a
    /// grid cell, a scheduler job or a capability grant — things that paint
    /// nothing of their own.
    ///
    /// This is what makes the cascade TRANSITIVE and therefore derivable:
    /// deleting a table deletes its slicers, and deleting a slicer prunes it
    /// out of every ribbon filter, so a table delete disturbs the ribbon-filter
    /// store too. [`cascade_domains`] walks exactly this field, so the domain
    /// list an announcement owes is computed from the matrix instead of being
    /// remembered by whoever wrote the announcement.
    pub dependent_kind: Option<ObjectKind>,
    pub policy: DeletePolicy,
    /// The symbol the census greps for in the owner's delete command, or "" for
    /// the policies that need no code. For a cascade that runs inside a shared
    /// helper this is the helper's name — the census follows one level of
    /// delegation, exactly as the save-source census does.
    pub implemented_by: &'static str,
    pub note: &'static str,
}

// ===========================================================================
// THE UI HALF: which frontend store goes stale, and how it is told
// ===========================================================================

/// A frontend refresh DOMAIN — the change CLASS an announcement names.
///
/// One-for-one with the `MutationDomain` union in `app/src/api/events.ts`, and
/// pinned to it by `cascadeAnnouncementCensus.test.ts`, which reads these wire
/// names out of this file and looks each one up in the Shell translator's
/// `MUTATION_DOMAIN_EVENTS`. A domain the translator does not know is dropped
/// on the floor in silence, so the two lists must not drift.
///
/// Domains, never feature events: the backend must not know that "slicer"
/// means `slicers:refresh`, for the same reason an extension must not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum UiDomain {
    /// Nothing on the frontend caches this kind in a way an announcement could
    /// repair. Argued per kind in [`ObjectKind::ui_domain`].
    None,
    Styles,
    Pivot,
    Slicer,
    RibbonFilter,
    PaneControl,
    Objects,
    /// Row/column VISIBILITY. The one domain with no wire name: it drives a
    /// dimension re-read (`hiddenChanged` on the undo result), not a store
    /// refresh, and the frontend `MutationDomain` union does not contain it.
    Hidden,
    Sheets,
    NamedRanges,
    Outline,
    Hyperlinks,
    Validations,
    Annotations,
    Controls,
    ConditionalFormats,
    FloatingRanges,
    /// ROW HEIGHTS / COLUMN WIDTHS, and the sheet DEFAULTS.
    ///
    /// Geometry is not a feature store, which is why this took so long to
    /// notice: a dimension restore changes no cell and no extension cache, so
    /// there was nothing obviously stale to announce to. What DOES go stale is
    /// the renderer's own `config.defaultCellWidth/Height` and the dimension
    /// overrides in Redux, and only a `dimensions:refresh` re-read repairs
    /// those. The registry used to justify `NONE` here by saying the frontend
    /// re-reads dimensions "on the refresh it already runs" -- it does not:
    /// that re-read is gated on structuralRestore/mergeChanged/hiddenChanged,
    /// and a default-dimension restore sets none of the three.
    Dimensions,
}

impl UiDomain {
    /// Every domain, in DECLARATION ORDER — which is the iteration order of a
    /// `MutationDomains` set, so a workbook announces identically on every run.
    ///
    /// Hand-maintained (a Rust enum cannot enumerate itself on stable), and
    /// checked against the exhaustive `wire_name` match by
    /// `every_ui_domain_is_in_all` — a variant missing from here would be
    /// silently dropped from every undo announcement.
    pub const ALL: &'static [UiDomain] = &[
        UiDomain::None,
        UiDomain::Styles,
        UiDomain::Pivot,
        UiDomain::Slicer,
        UiDomain::RibbonFilter,
        UiDomain::PaneControl,
        UiDomain::Objects,
        UiDomain::Hidden,
        UiDomain::Sheets,
        UiDomain::NamedRanges,
        UiDomain::Outline,
        UiDomain::Hyperlinks,
        UiDomain::Validations,
        UiDomain::Annotations,
        UiDomain::Controls,
        UiDomain::ConditionalFormats,
        UiDomain::FloatingRanges,
        UiDomain::Dimensions,
    ];

    /// The exact string the `MutationDomain` union uses, or `None`.
    pub fn wire_name(self) -> Option<&'static str> {
        match self {
            UiDomain::None => None,
            UiDomain::Styles => Some("styles"),
            UiDomain::Pivot => Some("pivot"),
            UiDomain::Slicer => Some("slicer"),
            UiDomain::RibbonFilter => Some("ribbonFilter"),
            UiDomain::PaneControl => Some("paneControl"),
            UiDomain::Objects => Some("objects"),
            UiDomain::Hidden => None,
            UiDomain::Sheets => Some("sheets"),
            UiDomain::NamedRanges => Some("namedRanges"),
            UiDomain::Outline => Some("outline"),
            UiDomain::Hyperlinks => Some("hyperlinks"),
            UiDomain::Validations => Some("validations"),
            UiDomain::Annotations => Some("annotations"),
            UiDomain::Controls => Some("controls"),
            UiDomain::ConditionalFormats => Some("conditionalFormats"),
            UiDomain::FloatingRanges => Some("floatingRanges"),
            UiDomain::Dimensions => Some("dimensions"),
        }
    }
}

/// THE TABLE. Every pair, its policy, and where the policy is executed.
///
/// Ordered by owner so the printed report reads like the design document it is.
pub const DEPENDENCY_MATRIX: &[DependencyRule] = &[
    // -----------------------------------------------------------------------
    // TABLE
    // -----------------------------------------------------------------------
    DependencyRule {
        owner: ObjectKind::Table,
        dependent: "slicer.cacheSourceId / slicer.connectedSources",
        dependent_kind: Some(ObjectKind::Slicer),
        policy: DeletePolicy::CascadeOrRebind,
        implemented_by: "cascade_deleted_sources",
        note: "Excel removes a table's slicers with the table; a slicer with a \
                surviving Report Connection is repointed instead of deleted.",
    },
    DependencyRule {
        owner: ObjectKind::Table,
        dependent: "autoFilter (the one the table installed)",
        dependent_kind: Some(ObjectKind::AutoFilter),
        policy: DeletePolicy::Cascade,
        implemented_by: "clear_table_auto_filter",
        note: "A sheet-level AutoFilter with no visible owner used to survive \
                with rows still hidden by it.",
    },
    DependencyRule {
        owner: ObjectKind::Table,
        dependent: "formula.structuredReference (Table1[Col])",
        dependent_kind: None,
        policy: DeletePolicy::Repair,
        implemented_by: "rewrite_table_refs_to_ranges",
        note: "Excel freezes the specifier into the absolute rectangle the \
                table covered, so the VALUES do not move.",
    },
    DependencyRule {
        owner: ObjectKind::Table,
        dependent: "objectScript.instanceId",
        dependent_kind: Some(ObjectKind::ObjectScript),
        policy: DeletePolicy::Cascade,
        implemented_by: "object_scripts",
        note: "C10: instanceId == the table id; a script left behind would be \
                inherited by the next object minted at that id.",
    },
    // -----------------------------------------------------------------------
    // PIVOT
    // -----------------------------------------------------------------------
    DependencyRule {
        owner: ObjectKind::Pivot,
        dependent: "slicer.cacheSourceId / slicer.connectedSources",
        dependent_kind: Some(ObjectKind::Slicer),
        policy: DeletePolicy::CascadeOrRebind,
        implemented_by: "cascade_deleted_sources",
        note: "Same rule as the table case — one implementation, both owners.",
    },
    DependencyRule {
        owner: ObjectKind::Pivot,
        dependent: "timelineSlicer.sourceId / connectedPivotIds",
        dependent_kind: Some(ObjectKind::TimelineSlicer),
        policy: DeletePolicy::CascadeOrRebind,
        implemented_by: "cascade_deleted_sources",
        note: "A timeline can only be sourced from a pivot, so a timeline \
                whose last pivot is gone has nothing to render.",
    },
    DependencyRule {
        owner: ObjectKind::Pivot,
        dependent: "ribbonFilter.connectedPivots / crossFilterTargets",
        dependent_kind: Some(ObjectKind::RibbonFilter),
        policy: DeletePolicy::Prune,
        implemented_by: "cascade_deleted_sources",
        note: "The filter's own source is a model connection, not the pivot: \
                it survives, minus the dead target.",
    },
    DependencyRule {
        owner: ObjectKind::Pivot,
        dependent: "grid cells in the pivot's region",
        dependent_kind: None,
        policy: DeletePolicy::Recalculate,
        implemented_by: "recalc_after_active_sheet_bulk_rewrite",
        note: "Formulas reading the cleared block drop to 0 at once, as in \
                Excel.",
    },
    DependencyRule {
        owner: ObjectKind::Pivot,
        dependent: "objectScript.instanceId",
        dependent_kind: Some(ObjectKind::ObjectScript),
        policy: DeletePolicy::Cascade,
        implemented_by: "prune_scripts_for_instance",
        note: "C10.",
    },
    // -----------------------------------------------------------------------
    // CHART
    // -----------------------------------------------------------------------
    DependencyRule {
        owner: ObjectKind::Chart,
        dependent: "paneControl.config.chartParamTarget.chartId",
        dependent_kind: Some(ObjectKind::PaneControl),
        policy: DeletePolicy::Prune,
        implemented_by: "cascade_deleted_charts",
        note: "The slider survives with its value; it simply stops driving a \
                chart. Deleting a chart must not delete the control.",
    },
    DependencyRule {
        owner: ObjectKind::Chart,
        dependent: "objectScript.instanceId",
        dependent_kind: Some(ObjectKind::ObjectScript),
        policy: DeletePolicy::Cascade,
        implemented_by: "prune_scripts_for_instance",
        note: "C10.",
    },
    DependencyRule {
        owner: ObjectKind::Chart,
        dependent: "formula.cellsInSourceRange",
        dependent_kind: None,
        policy: DeletePolicy::NoDependents,
        implemented_by: "",
        note: "The edge runs the other way — a chart READS cells. Nothing in \
                the grid reads a chart.",
    },
    // -----------------------------------------------------------------------
    // SLICER
    // -----------------------------------------------------------------------
    DependencyRule {
        owner: ObjectKind::Slicer,
        dependent: "ribbonFilter.crossFilterSlicerTargets",
        dependent_kind: Some(ObjectKind::RibbonFilter),
        policy: DeletePolicy::Prune,
        implemented_by: "cascade_deleted_slicers",
        note: "A filter listing a dead slicer re-evaluated cross-filter \
                candidacy against it on every item fetch.",
    },
    DependencyRule {
        owner: ObjectKind::Slicer,
        dependent: "slicer.computedProperties",
        dependent_kind: Some(ObjectKind::ComputedProperty),
        policy: DeletePolicy::Cascade,
        implemented_by: "drop_slicer_computed_properties",
        note: "Owned outright by the slicer, with its own dependency edges.",
    },
    DependencyRule {
        owner: ObjectKind::Slicer,
        dependent: "objectScript.instanceId",
        dependent_kind: Some(ObjectKind::ObjectScript),
        policy: DeletePolicy::Cascade,
        implemented_by: "prune_scripts_for_instance",
        note: "C10.",
    },
    // -----------------------------------------------------------------------
    // TIMELINE SLICER
    // -----------------------------------------------------------------------
    DependencyRule {
        owner: ObjectKind::TimelineSlicer,
        dependent: "objectScript.instanceId",
        dependent_kind: Some(ObjectKind::ObjectScript),
        policy: DeletePolicy::Cascade,
        implemented_by: "prune_scripts_for_instance",
        note: "C10. Nothing else points at a timeline.",
    },
    // -----------------------------------------------------------------------
    // RIBBON FILTER
    // -----------------------------------------------------------------------
    DependencyRule {
        owner: ObjectKind::RibbonFilter,
        dependent: "ribbonFilter.crossFilterTargets (siblings)",
        dependent_kind: Some(ObjectKind::RibbonFilter),
        policy: DeletePolicy::Prune,
        implemented_by: "cascade_deleted_filters",
        note: "Cross-filter targets are filter ids; a deleted filter left \
                every sibling listing an id that resolves to nothing.",
    },
    DependencyRule {
        owner: ObjectKind::RibbonFilter,
        dependent: "formula.GET.CONTROLVALUE(name)",
        dependent_kind: None,
        policy: DeletePolicy::Recalculate,
        implemented_by: "frontend:filterPaneStore.deleteFilterAsync",
        note: "Excel-parity with a deleted name: the formula keeps its text \
                and re-evaluates to an error rather than being rewritten. The \
                recalc is what makes the stale VALUE go away.",
    },
    // -----------------------------------------------------------------------
    // PANE CONTROL
    // -----------------------------------------------------------------------
    DependencyRule {
        owner: ObjectKind::PaneControl,
        dependent: "formula.GET.CONTROLVALUE(name)",
        dependent_kind: None,
        policy: DeletePolicy::Recalculate,
        implemented_by: "frontend:controlsPaneStore.deleteControlAsync",
        note: "Same rule as the ribbon-filter case.",
    },
    DependencyRule {
        owner: ObjectKind::PaneControl,
        dependent: "objectScript.instanceId (\"pane-\" + id)",
        dependent_kind: Some(ObjectKind::ObjectScript),
        policy: DeletePolicy::Cascade,
        implemented_by: "prune_scripts_for_instance",
        note: "Was frontend-only (ControlsPane's CONTROL_DELETED handler). A \
                script that outlives its control keeps running headless.",
    },
    // -----------------------------------------------------------------------
    // FLOATING (ON-GRID) CONTROL
    // -----------------------------------------------------------------------
    DependencyRule {
        owner: ObjectKind::FloatingControl,
        dependent: "objectScript.instanceId (control-<sheet>-<row>-<col>)",
        dependent_kind: Some(ObjectKind::ObjectScript),
        policy: DeletePolicy::Cascade,
        implemented_by: "frontend:Controls.deleteFloatingControl",
        note: "The instanceId derives from the ANCHOR, so a surviving script \
                is INHERITED by the next control created there (§1a).",
    },
    DependencyRule {
        owner: ObjectKind::FloatingControl,
        dependent: "formula.GET.CONTROLVALUE(name)",
        dependent_kind: None,
        policy: DeletePolicy::Recalculate,
        implemented_by: "frontend:Controls.deleteFloatingControl",
        note: "Named on-grid controls are in the GET.CONTROLVALUE snapshot \
                too.",
    },
    // -----------------------------------------------------------------------
    // NAMED RANGE
    // -----------------------------------------------------------------------
    DependencyRule {
        owner: ObjectKind::NamedRange,
        dependent: "formula.NamedRef",
        dependent_kind: None,
        policy: DeletePolicy::Recalculate,
        implemented_by: "recalc_after_name_change",
        note: "EXCEL'S BEHAVIOUR, DELIBERATELY: the formula keeps saying RATE \
                and shows #NAME?. Not rewritten, not blanked.",
    },
    DependencyRule {
        owner: ObjectKind::NamedRange,
        dependent: "objectScript.instanceId",
        dependent_kind: Some(ObjectKind::ObjectScript),
        policy: DeletePolicy::Cascade,
        implemented_by: "object_scripts",
        note: "C10; instanceId == the name, matched case-insensitively.",
    },
    // -----------------------------------------------------------------------
    // SHEET — the widest owner in the workbook
    // -----------------------------------------------------------------------
    DependencyRule {
        owner: ObjectKind::Sheet,
        dependent: "table on the sheet",
        dependent_kind: Some(ObjectKind::Table),
        policy: DeletePolicy::Cascade,
        implemented_by: "DeletedSource::table",
        note: "Removed with the sheet, and its OWN dependents then cascade \
                through cascade_deleted_sources. SPLIT FROM THE PIVOT ROW so \
                dependent_kind can name one kind: the transitive walk in \
                cascade_domains is only as good as the kind on the row.",
    },
    DependencyRule {
        owner: ObjectKind::Sheet,
        dependent: "pivot on the sheet",
        dependent_kind: Some(ObjectKind::Pivot),
        policy: DeletePolicy::Cascade,
        implemented_by: "pivots_to_delete",
        note: "Same as the table row: removed with the sheet, dependents \
                cascade after.",
    },
    DependencyRule {
        owner: ObjectKind::Sheet,
        dependent: "slicer.sheetIndex",
        dependent_kind: Some(ObjectKind::Slicer),
        policy: DeletePolicy::Cascade,
        implemented_by: "cascade_sheet_removed",
        note: "Two defects in one: a slicer ON the deleted sheet survived \
                invisibly, and every slicer ABOVE it kept an index that now \
                names a DIFFERENT sheet — so it painted over the wrong one.",
    },
    DependencyRule {
        owner: ObjectKind::Sheet,
        dependent: "timelineSlicer.sheetIndex",
        dependent_kind: Some(ObjectKind::TimelineSlicer),
        policy: DeletePolicy::Cascade,
        implemented_by: "cascade_sheet_removed",
        note: "Same two defects as the slicer row; a timeline is \
                index-anchored the same way.",
    },
    DependencyRule {
        owner: ObjectKind::Sheet,
        dependent: "floatingRange.hostSheetId",
        dependent_kind: Some(ObjectKind::FloatingRange),
        policy: DeletePolicy::Cascade,
        implemented_by: "delete_floating_ranges_for_host",
        note: "A floating range floats OVER its host sheet; the host gone, \
                there is nothing to float over. Each orphaned object deletes \
                its own OBJECT-backed cell-store sheet back through \
                delete_sheet_impl, so references into it become #REF! exactly \
                like any sheet delete. SheetId-keyed, so the host's index \
                remap never touches the rows.",
    },
    DependencyRule {
        owner: ObjectKind::FloatingRange,
        dependent: "formula.crossSheetRef",
        dependent_kind: None,
        policy: DeletePolicy::Repair,
        implemented_by: "delete_sheet_impl",
        note: "=Float1!A1 anywhere in the workbook becomes #REF! when the \
                floating range is deleted — the object's cells ARE a sheet \
                (OBJECT_SHEET_VISIBILITY), and its delete runs the sheet \
                delete's own all-formula repair and workbook recalculation. \
                Pinned by formula_serialisation_tests's cross-sheet #REF! \
                test for ordinary sheets; the floating-range delete goes \
                through the identical delete_sheet_impl walk.",
    },
    DependencyRule {
        owner: ObjectKind::Sheet,
        dependent: "chart.sheetIndex",
        dependent_kind: Some(ObjectKind::Chart),
        policy: DeletePolicy::Cascade,
        implemented_by: "cascade_sheet_removed",
        note: "Same two defects. A chart is index-anchored exactly like a \
                slicer.",
    },
    DependencyRule {
        owner: ObjectKind::Sheet,
        dependent: "sparkline.sheetIndex",
        dependent_kind: Some(ObjectKind::Sparkline),
        policy: DeletePolicy::Cascade,
        implemented_by: "cascade_sheet_removed",
        note: "Same two defects; sparkline groups are keyed by sheet index.",
    },
    DependencyRule {
        owner: ObjectKind::Sheet,
        dependent: "ribbonFilter.connectedSheets",
        dependent_kind: Some(ObjectKind::RibbonFilter),
        policy: DeletePolicy::Prune,
        implemented_by: "cascade_sheet_removed",
        note: "bySheet mode resolves its targets from these indices; a stale \
                one silently retargets the filter at another sheet's pivots.",
    },
    DependencyRule {
        owner: ObjectKind::Sheet,
        dependent: "formula.crossSheetReference / definedName.refersTo",
        dependent_kind: None,
        policy: DeletePolicy::Repair,
        implemented_by: "repair_all_formulas",
        note: "References to the deleted sheet become #REF!, and the whole \
                workbook recalculates so no stale value survives.",
    },
    DependencyRule {
        owner: ObjectKind::Sheet,
        dependent: "sheet-index-keyed stores (CF, DV, comments, protection, ...)",
        dependent_kind: None,
        policy: DeletePolicy::Prune,
        implemented_by: "remap_sheet_keyed_stores",
        note: "Drop the deleted sheet's entries, shift the rest down one. \
                dependent_kind is None deliberately: these stores are re-read \
                whenever the sheet changes, and the sheet switch IS the \
                refresh.",
    },
    DependencyRule {
        owner: ObjectKind::Sheet,
        dependent: "report.sheetIndex",
        dependent_kind: Some(ObjectKind::Report),
        policy: DeletePolicy::Prune,
        implemented_by: "remap_report_sheets",
        note: "Otherwise the next refresh materializes a deleted-sheet report \
                onto whichever sheet inherited its index.",
    },
    // -----------------------------------------------------------------------
    // REPORT
    // -----------------------------------------------------------------------
    DependencyRule {
        owner: ObjectKind::Report,
        dependent: "grid cells in the report's region",
        dependent_kind: None,
        policy: DeletePolicy::Recalculate,
        implemented_by: "recalculate_sheet_formulas",
        note: "The region is cleared, so formulas over it must re-evaluate.",
    },
    // -----------------------------------------------------------------------
    // SCRIPT (a macro / workbook module)
    // -----------------------------------------------------------------------
    DependencyRule {
        owner: ObjectKind::Script,
        dependent: "control.properties.macroRef",
        dependent_kind: None,
        policy: DeletePolicy::WarnAndKeep,
        implemented_by: "",
        note: "The link model is deliberate — the user may re-point the \
                button. list_controls_referencing_macro NAMES every button in \
                the confirm, so the orphan is never silent.",
    },
    DependencyRule {
        owner: ObjectKind::Script,
        dependent: "scheduler job.scriptId",
        dependent_kind: None,
        policy: DeletePolicy::Cascade,
        implemented_by: "remove_script_jobs",
        note: "A scheduled job whose module is gone woke up on its timer \
                forever and failed to resolve, every time.",
    },
    DependencyRule {
        owner: ObjectKind::Script,
        dependent: "capability grants (net origins, capabilities)",
        dependent_kind: None,
        policy: DeletePolicy::Cascade,
        implemented_by: "revoke_script",
        note: "A grant outliving its script is a standing authorisation with \
                no code attached — and script ids are author-chosen, so a NEW \
                script created with the same id would inherit it.",
    },
    // -----------------------------------------------------------------------
    // OBJECT SCRIPT / CELL BEHAVIOR
    // -----------------------------------------------------------------------
    DependencyRule {
        owner: ObjectKind::ObjectScript,
        dependent: "cellBehavior.scriptId",
        dependent_kind: Some(ObjectKind::CellBehavior),
        policy: DeletePolicy::WarnAndKeep,
        implemented_by: "",
        note: "The binding carries an `orphaned` flag by design: it survives \
                so undo can restore it and the panel can offer a re-target.",
    },
    DependencyRule {
        owner: ObjectKind::CellBehavior,
        dependent: "objectScript (objectType \"range\")",
        dependent_kind: Some(ObjectKind::ObjectScript),
        policy: DeletePolicy::WarnAndKeep,
        implemented_by: "",
        note: "Documented on remove_cell_behavior: script lifecycle belongs to \
                the script UI, not to the binding.",
    },
    // -----------------------------------------------------------------------
    // LEAVES — nothing in the workbook can point at these
    // -----------------------------------------------------------------------
    DependencyRule {
        owner: ObjectKind::ConditionalFormat,
        dependent: "-",
        dependent_kind: None,
        policy: DeletePolicy::NoDependents,
        implemented_by: "",
        note: "A CF rule READS cells; nothing holds a CF rule id.",
    },
    DependencyRule {
        owner: ObjectKind::DataValidation,
        dependent: "-",
        dependent_kind: None,
        policy: DeletePolicy::NoDependents,
        implemented_by: "",
        note: "Same shape as conditional formatting.",
    },
    DependencyRule {
        owner: ObjectKind::Sparkline,
        dependent: "-",
        dependent_kind: None,
        policy: DeletePolicy::NoDependents,
        implemented_by: "",
        note: "Sparklines are keyed by sheet and read a range; nothing refers \
                to a sparkline group.",
    },
    DependencyRule {
        owner: ObjectKind::AutoFilter,
        dependent: "row visibility + table.autoFilterId",
        dependent_kind: None,
        policy: DeletePolicy::Recalculate,
        implemented_by: "recalc_visibility_after_row_change_from_handle",
        note: "Removing the filter must unhide the rows it hid, or they stay \
                hidden with nothing left to explain them. The owning table's \
                `auto_filter_id` is cleared in the same breath \
                (relink_autofilter_owner) -- a stale id made Data > Filter \
                off/on permanently orphan every table's link.",
    },
    DependencyRule {
        owner: ObjectKind::NamedStyle,
        dependent: "cells carrying the style",
        dependent_kind: None,
        policy: DeletePolicy::NoDependents,
        implemented_by: "",
        note: "NOT a reference: a cell stores a `style_index` into the style \
                registry, never the style NAME, so deleting the name cannot \
                dangle. FLAGGED AS A FIDELITY GAP, not a bug: Excel reverts \
                cells using a deleted style to Normal and Calcula leaves their \
                resolved formatting in place. Leaving it is the safe option \
                (nothing the user can see changes and no formatting is lost); \
                reverting would silently restyle cells across the workbook. \
                Product call, recorded in section 3bn.",
    },
    DependencyRule {
        owner: ObjectKind::PivotLayout,
        dependent: "-",
        dependent_kind: None,
        policy: DeletePolicy::NoDependents,
        implemented_by: "",
        note: "A saved layout is a template applied by value; no pivot points \
                back at it.",
    },
    DependencyRule {
        owner: ObjectKind::Comment,
        dependent: "-",
        dependent_kind: None,
        policy: DeletePolicy::NoDependents,
        implemented_by: "",
        note: "Cell-anchored annotation; nothing holds a comment id.",
    },
    DependencyRule {
        owner: ObjectKind::Note,
        dependent: "-",
        dependent_kind: None,
        policy: DeletePolicy::NoDependents,
        implemented_by: "",
        note: "Cell-anchored annotation.",
    },
    DependencyRule {
        owner: ObjectKind::Hyperlink,
        dependent: "-",
        dependent_kind: None,
        policy: DeletePolicy::NoDependents,
        implemented_by: "",
        note: "Cell-anchored; the link points OUT, nothing points in.",
    },
    DependencyRule {
        owner: ObjectKind::ComputedProperty,
        dependent: "computed-prop dependency edges",
        dependent_kind: None,
        policy: DeletePolicy::Prune,
        implemented_by: "clear_prop_dependencies",
        note: "The cell -> property reverse index must lose the entry or it \
                re-evaluates a property that no longer exists.",
    },
    DependencyRule {
        owner: ObjectKind::TableColumn,
        dependent: "formula.structuredReference (Table1[ThatColumn])",
        dependent_kind: None,
        policy: DeletePolicy::Recalculate,
        implemented_by: "recalc_after_table_change",
        note: "The specifier stays and resolves to #REF! — the same answer \
                Excel gives, and the same rule as a deleted name.",
    },
    DependencyRule {
        owner: ObjectKind::ObjectTemplate,
        dependent: "-",
        dependent_kind: None,
        policy: DeletePolicy::NoDependents,
        implemented_by: "",
        note: "A template is copied into a script at instantiation; the copy \
                keeps no link back.",
    },
    // -----------------------------------------------------------------------
    // BI (MODEL) CONNECTION -- the one owner whose dependents are deliberately
    // left pointing at nothing, because that is what Excel does with a data
    // connection and because the alternative destroys work.
    // -----------------------------------------------------------------------
    DependencyRule {
        owner: ObjectKind::BiConnection,
        dependent: "ribbonFilter.connectionId / biPivot / report.dataSourceId",
        dependent_kind: None,
        policy: DeletePolicy::WarnAndKeep,
        implemented_by: "",
        note: "Excel keeps a PivotTable whose connection is gone -- it fails \
                to REFRESH and says so. Cascading would delete the user's \
                laid-out pivots and their formatting because a connection \
                string went stale, which is unrecoverable; leaving them is \
                recoverable by re-creating the connection. So the objects stay \
                and the delete NAMES them first: \
                list_object_dependents(biConnection, id) feeds the confirm, the \
                same standard list_controls_referencing_macro set for macros.",
    },
];

/// Look up every declared rule for one owner.
pub fn rules_for(owner: ObjectKind) -> impl Iterator<Item = &'static DependencyRule> {
    DEPENDENCY_MATRIX.iter().filter(move |r| r.owner == owner)
}

// ===========================================================================
// THE ANNOUNCEMENT — §3cd, the other half of §3bn
// ===========================================================================
//
// §3bn made the cascade CORRECT. It did not make it VISIBLE. Every object this
// matrix cascades into lives in a frontend store that caches its own objects
// and paints its own overlay, so a slicer the backend deleted goes on
// rendering -- and on claiming the pointer events over the cells underneath --
// until that store re-reads.
//
// Where the deletion is started BY the frontend, the deleting route announces
// on the way back and `cascadeAnnouncementCensus.test.ts` proves it does. This
// module answers the other direction: a mutation started INSIDE the backend
// (an MCP tool driven by an AI client, with no frontend call to return from)
// has nothing to hook an announcement onto, so it must emit one itself.
//
// The domain list is DERIVED from the matrix rather than remembered. That is
// the whole reason `dependent_kind` exists: `table.delete` disturbs the ribbon
// filter store, and the only way to know that without being told is to notice
// that a table cascades into slicers and a slicer cascades into ribbon filters.

/// The Tauri event a backend-initiated mutation emits. Bridged in
/// `app/src/shell/bootstrap.ts` into the SAME `MUTATION_DOMAIN_EVENTS` fan-out
/// the frontend `MUTATION_REFRESH` announcement uses, so there is one
/// translator from domains to feature events and not two.
pub const MUTATION_REFRESH_EVENT: &str = "mutation:refresh";

/// Payload of [`MUTATION_REFRESH_EVENT`] — the wire twin of
/// `MutationRefreshPayload` in `app/src/api/events.ts`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationRefreshEvent {
    pub domains: Vec<String>,
    /// Always `"commit"` from the backend: undo and redo are driven from the
    /// frontend, which reports its own source.
    pub source: String,
}

/// Does this policy actually REMOVE the dependent object, so that the
/// dependent's own dependents cascade in turn?
fn deletes_the_dependent(policy: DeletePolicy) -> bool {
    matches!(policy, DeletePolicy::Cascade | DeletePolicy::CascadeOrRebind)
}

/// Does this policy change the dependent at all, so that its store is stale?
fn disturbs_the_dependent(policy: DeletePolicy) -> bool {
    matches!(
        policy,
        DeletePolicy::Cascade | DeletePolicy::CascadeOrRebind | DeletePolicy::Prune
    )
}

/// Every frontend refresh domain that deleting `owner` leaves stale, INCLUDING
/// the owner's own store, sorted and de-duplicated.
///
/// TRANSITIVE, and that is the point. Deleting a table deletes its slicers
/// (`CascadeOrRebind`), and deleting a slicer prunes it out of every ribbon
/// filter (`Prune`), so a table delete owes the ribbon-filter domain as well.
/// Nobody has to remember that: the walk reads it off `dependent_kind`.
///
/// Recursion follows only the policies that DELETE the dependent — a pruned
/// ribbon filter survives, so its own dependents are untouched — while the
/// domain is collected for every policy that disturbs it at all.
pub fn cascade_domains(owner: ObjectKind) -> Vec<&'static str> {
    let mut domains: BTreeSet<&'static str> = BTreeSet::new();
    let mut visited: HashSet<&'static str> = HashSet::new();
    let mut queue: Vec<ObjectKind> = vec![owner];
    if let Some(name) = owner.ui_domain().wire_name() {
        domains.insert(name);
    }
    while let Some(kind) = queue.pop() {
        if !visited.insert(kind.wire_name()) {
            continue;
        }
        for rule in rules_for(kind) {
            if !disturbs_the_dependent(rule.policy) {
                continue;
            }
            let Some(dependent) = rule.dependent_kind else {
                continue;
            };
            if let Some(name) = dependent.ui_domain().wire_name() {
                domains.insert(name);
            }
            if deletes_the_dependent(rule.policy) {
                queue.push(dependent);
            }
        }
    }
    domains.into_iter().collect()
}

/// Tell the frontend that a BACKEND-INITIATED mutation of `owner` just ran.
///
/// Call it from every surface that mutates the document without a frontend
/// command call to return from — today that is the MCP tool surface, which an
/// AI client drives directly. `mcp_announce_census` in
/// `object_deps_census_tests.rs` fails the build for an MCP function that
/// reaches a declared cascade without calling this.
///
/// Emitted unconditionally: a refresh with nothing to refresh is one cache
/// re-read, while a missed one is a ghost overlay that eats clicks.
pub fn announce_cascade(handle: &tauri::AppHandle, owner: ObjectKind) {
    use tauri::Emitter;
    let domains: Vec<String> = cascade_domains(owner)
        .into_iter()
        .map(str::to_string)
        .collect();
    if domains.is_empty() {
        return;
    }
    let _ = handle.emit(
        MUTATION_REFRESH_EVENT,
        MutationRefreshEvent {
            domains,
            source: "commit".to_string(),
        },
    );
}

// ===========================================================================
// THE CASCADES
// ===========================================================================

/// A data source (table or pivot) that has just been removed, as the slicer
/// family names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeletedSource {
    pub source_type: SlicerSourceType,
    pub id: EntityId,
}

impl DeletedSource {
    pub fn table(id: EntityId) -> Self {
        Self { source_type: SlicerSourceType::Table, id }
    }
    pub fn pivot(id: EntityId) -> Self {
        Self { source_type: SlicerSourceType::Pivot, id }
    }
}

/// Everything a source cascade touched, kept so it can be UNDONE and LOGGED.
///
/// The `rebound_*` vectors hold the PREVIOUS value of an object that survived
/// with an edited binding — that is what a restore needs. The `deleted_*`
/// vectors hold the object as it was at the moment it was removed.
#[derive(Debug, Default)]
pub struct SourceCascade {
    pub deleted_slicers: Vec<Slicer>,
    pub rebound_slicers: Vec<Slicer>,
    pub deleted_timelines: Vec<TimelineSlicer>,
    pub rebound_timelines: Vec<TimelineSlicer>,
    pub rebound_filters: Vec<RibbonFilter>,
}

impl SourceCascade {
    pub fn is_empty(&self) -> bool {
        self.deleted_slicers.is_empty()
            && self.rebound_slicers.is_empty()
            && self.deleted_timelines.is_empty()
            && self.rebound_timelines.is_empty()
            && self.rebound_filters.is_empty()
    }

    /// One log line naming what the cascade did, by object NAME — the same
    /// standard `list_controls_referencing_macro` set for macro deletion.
    pub fn describe(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        if !self.deleted_slicers.is_empty() {
            parts.push(format!(
                "deleted slicer(s) [{}]",
                self.deleted_slicers
                    .iter()
                    .map(|s| s.name.clone())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if !self.rebound_slicers.is_empty() {
            parts.push(format!(
                "repointed slicer(s) [{}]",
                self.rebound_slicers
                    .iter()
                    .map(|s| s.name.clone())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if !self.deleted_timelines.is_empty() {
            parts.push(format!(
                "deleted timeline(s) [{}]",
                self.deleted_timelines
                    .iter()
                    .map(|t| t.name.clone())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if !self.rebound_timelines.is_empty() {
            parts.push(format!(
                "repointed timeline(s) [{}]",
                self.rebound_timelines
                    .iter()
                    .map(|t| t.name.clone())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if !self.rebound_filters.is_empty() {
            parts.push(format!(
                "pruned filter target(s) in [{}]",
                self.rebound_filters
                    .iter()
                    .map(|f| f.name.clone())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        parts.join("; ")
    }
}

/// THE CASCADE, for a table or a pivot that has just been removed.
///
/// Call it AFTER the owner is out of its store and BEFORE the delete command
/// commits its undo transaction — [`record_source_cascade_undo`] has to land
/// inside that transaction.
///
/// The rebind rule, precisely:
///
/// 1. Dead ids are removed from `connected_sources` first, so the survivor test
///    below sees only live targets.
/// 2. If `cache_source_id` is still alive, nothing else happens — the slicer
///    merely filters one fewer object.
/// 3. If it is dead and a live connection of the SAME source type remains, the
///    cache source is repointed to it. (Type must match: the item list is read
///    with a table reader or a pivot reader, never both.)
/// 4. Otherwise the slicer is deleted, because there is nothing left for it to
///    show and it would eat every click landing on its rectangle.
///
/// `BiConnection` slicers are untouched: their `cache_source_id` names a model
/// connection, not a table or a pivot, so a matching id would be a coincidence.
pub fn cascade_deleted_sources(
    state: &AppState,
    slicer_state: &SlicerState,
    timeline_state: &TimelineSlicerState,
    ribbon_filter_state: &RibbonFilterState,
    effect: &DocumentEffect,
    removed: &[DeletedSource],
) -> SourceCascade {
    let mut out = SourceCascade::default();
    if removed.is_empty() {
        return out;
    }

    let dead_tables: HashSet<EntityId> = removed
        .iter()
        .filter(|d| d.source_type == SlicerSourceType::Table)
        .map(|d| d.id)
        .collect();
    let dead_pivots: HashSet<EntityId> = removed
        .iter()
        .filter(|d| d.source_type == SlicerSourceType::Pivot)
        .map(|d| d.id)
        .collect();

    // --- slicers -----------------------------------------------------------
    {
        let mut slicers = slicer_state.slicers.write(effect).unwrap();
        let mut to_delete: Vec<EntityId> = Vec::new();
        for (id, slicer) in slicers.iter_mut() {
            let dead: &HashSet<EntityId> = match slicer.source_type {
                SlicerSourceType::Table => &dead_tables,
                SlicerSourceType::Pivot => &dead_pivots,
                // A model-connection slicer is not bound to a table or pivot.
                SlicerSourceType::BiConnection => continue,
            };
            let touches_connection = slicer
                .connected_sources
                .iter()
                .any(|c| c.source_type == slicer.source_type && dead.contains(&c.source_id));
            let cache_dead = dead.contains(&slicer.cache_source_id);
            if !touches_connection && !cache_dead {
                continue;
            }
            let previous = slicer.clone();
            slicer
                .connected_sources
                .retain(|c| !(c.source_type == slicer.source_type && dead.contains(&c.source_id)));
            if !cache_dead {
                out.rebound_slicers.push(previous);
                continue;
            }
            match slicer
                .connected_sources
                .iter()
                .find(|c| c.source_type == slicer.source_type)
                .map(|c| c.source_id)
            {
                Some(survivor) => {
                    slicer.cache_source_id = survivor;
                    out.rebound_slicers.push(previous);
                }
                None => {
                    *slicer = previous;
                    to_delete.push(*id);
                }
            }
        }
        for id in to_delete {
            if let Some(slicer) = slicers.remove(&id) {
                out.deleted_slicers.push(slicer);
            }
        }
    }
    // Computed properties belong to the slicer outright; a deleted slicer must
    // not leave its properties (or their reverse dependency edges) behind. Done
    // outside the `slicers` guard so the two locks are never held together.
    for slicer in &out.deleted_slicers {
        drop_slicer_computed_properties(slicer_state, effect, slicer.id);
    }

    // --- timeline slicers --------------------------------------------------
    // Timelines can only be sourced from a pivot, so `dead_tables` cannot
    // affect them.
    if !dead_pivots.is_empty() {
        let mut timelines = timeline_state.timelines.write(effect).unwrap();
        let mut to_delete: Vec<EntityId> = Vec::new();
        for (id, tl) in timelines.iter_mut() {
            let touches_connection =
                tl.connected_pivot_ids.iter().any(|p| dead_pivots.contains(p));
            let source_dead = dead_pivots.contains(&tl.source_id);
            if !touches_connection && !source_dead {
                continue;
            }
            let previous = tl.clone();
            tl.connected_pivot_ids.retain(|p| !dead_pivots.contains(p));
            if !source_dead {
                out.rebound_timelines.push(previous);
                continue;
            }
            match tl.connected_pivot_ids.first().copied() {
                Some(survivor) => {
                    tl.source_id = survivor;
                    out.rebound_timelines.push(previous);
                }
                None => {
                    *tl = previous;
                    to_delete.push(*id);
                }
            }
        }
        for id in to_delete {
            if let Some(tl) = timelines.remove(&id) {
                out.deleted_timelines.push(tl);
            }
        }
    }

    // --- THE DELETED SLICERS' AND TIMELINES' OWN CASCADES ------------------
    //
    // A CASCADE THAT DELETES AN OBJECT MUST RUN THAT OBJECT'S OWN CASCADE, and
    // this is where §3bt stopped one step short. `delete_slicer` prunes the
    // slicer out of every ribbon filter's `cross_filter_slicer_targets` and
    // prunes the object script attached to its id -- and the slicers deleted a
    // few lines above went out through this path instead, which ran neither. So
    // deleting the TABLE a slicer filtered left every ribbon filter still
    // cross-filtering against a slicer that no longer existed: the same orphan
    // §3bn opened for, one level further down the tree.
    //
    // Found by the transitive walk added in §3cd (`cascade_domains`), not by
    // reading this function: the old census asked "does `delete_slicer` run the
    // slicer's cascade?" and never "does anything ELSE that deletes a slicer
    // run it?".
    {
        let dead_slicers: Vec<EntityId> = out.deleted_slicers.iter().map(|s| s.id).collect();
        let pruned = cascade_deleted_slicers(ribbon_filter_state, effect, &dead_slicers);
        // Into `rebound_filters`, which is exactly what
        // `record_source_cascade_undo` already restores -- so one Ctrl+Z brings
        // the cross-filter links back with the slicers.
        out.rebound_filters.extend(pruned);
        for id in dead_slicers {
            crate::scripting::object_script_commands::prune_scripts_for_instance(
                state,
                effect,
                &id.to_string(),
            );
        }
        for tl in &out.deleted_timelines {
            crate::scripting::object_script_commands::prune_scripts_for_instance(
                state,
                effect,
                &tl.id.to_string(),
            );
        }
    }

    // --- ribbon filters ----------------------------------------------------
    // A ribbon filter is sourced from a MODEL CONNECTION, never from a pivot,
    // so losing every target does not make it meaningless — it makes it
    // unconnected, which is a legal state the user can fix in the dialog.
    if !dead_pivots.is_empty() {
        let mut filters = ribbon_filter_state.filters.write(effect).unwrap();
        for filter in filters.values_mut() {
            let touches = filter.connected_pivots.iter().any(|p| dead_pivots.contains(p))
                || filter.cross_filter_targets.iter().any(|p| dead_pivots.contains(p));
            if !touches {
                continue;
            }
            out.rebound_filters.push(filter.clone());
            filter.connected_pivots.retain(|p| !dead_pivots.contains(p));
            filter.cross_filter_targets.retain(|p| !dead_pivots.contains(p));
        }
    }

    out
}

/// Drop one slicer's computed properties AND the reverse dependency edges that
/// point at them. Extracted so the delete command and the cascade cannot
/// disagree about what "remove a slicer" means.
pub fn drop_slicer_computed_properties(
    slicer_state: &SlicerState,
    effect: &DocumentEffect,
    slicer_id: EntityId,
) {
    let mut computed_props = slicer_state.computed_properties.write(effect).unwrap();
    let Some(props) = computed_props.remove(&slicer_id) else {
        return;
    };
    let mut deps = slicer_state.computed_prop_dependencies.lock().unwrap();
    let mut rev_deps = slicer_state.computed_prop_dependents.lock().unwrap();
    for prop in &props {
        let Some(old_cells) = deps.remove(&prop.id) else {
            continue;
        };
        for cell in &old_cells {
            if let Some(prop_set) = rev_deps.get_mut(cell) {
                prop_set.remove(&prop.id);
                if prop_set.is_empty() {
                    rev_deps.remove(cell);
                }
            }
        }
    }
}

/// Ribbon filters listing a now-deleted SLICER in `cross_filter_slicer_targets`.
/// Returns the PREVIOUS value of every filter it edited, for undo.
pub fn cascade_deleted_slicers(
    ribbon_filter_state: &RibbonFilterState,
    effect: &DocumentEffect,
    removed: &[EntityId],
) -> Vec<RibbonFilter> {
    if removed.is_empty() {
        return Vec::new();
    }
    let dead: HashSet<EntityId> = removed.iter().copied().collect();
    let mut previous = Vec::new();
    let mut filters = ribbon_filter_state.filters.write(effect).unwrap();
    for filter in filters.values_mut() {
        if !filter
            .cross_filter_slicer_targets
            .iter()
            .any(|s| dead.contains(s))
        {
            continue;
        }
        previous.push(filter.clone());
        filter
            .cross_filter_slicer_targets
            .retain(|s| !dead.contains(s));
    }
    previous
}

/// Ribbon filters listing a now-deleted SIBLING FILTER in `cross_filter_targets`.
/// Returns the PREVIOUS value of every filter it edited, for undo.
pub fn cascade_deleted_filters(
    ribbon_filter_state: &RibbonFilterState,
    effect: &DocumentEffect,
    removed: &[EntityId],
) -> Vec<RibbonFilter> {
    if removed.is_empty() {
        return Vec::new();
    }
    let dead: HashSet<EntityId> = removed.iter().copied().collect();
    let mut previous = Vec::new();
    let mut filters = ribbon_filter_state.filters.write(effect).unwrap();
    for filter in filters.values_mut() {
        if !filter.cross_filter_targets.iter().any(|f| dead.contains(f)) {
            continue;
        }
        previous.push(filter.clone());
        filter.cross_filter_targets.retain(|f| !dead.contains(f));
    }
    previous
}

/// Pane controls whose chart-parameter binding names a now-deleted CHART.
///
/// The control SURVIVES: it keeps its name, its value and its place in the
/// strip, and every `GET.CONTROLVALUE` reading it keeps working. Only the dead
/// binding goes, so dragging the slider stops trying to drive a chart that is
/// not there. Returns the PREVIOUS value of every control it edited, for undo.
pub fn cascade_deleted_charts(
    pane_control_state: &PaneControlState,
    removed: &[EntityId],
) -> Vec<PaneControl> {
    if removed.is_empty() {
        return Vec::new();
    }
    // Chart-param targets store the chart id as a STRING (the binding is
    // authored from the frontend, where ids are strings), so compare on the
    // canonical text of the EntityId rather than parsing the stored value —
    // an unparseable stored id must not silently match everything.
    let dead: HashSet<String> = removed.iter().map(|id| id.to_string()).collect();
    let mut previous = Vec::new();
    let mut controls = pane_control_state.controls.lock().unwrap();
    for control in controls.values_mut() {
        let target = match &control.config {
            PaneControlConfig::Slider { chart_param_target, .. }
            | PaneControlConfig::Dropdown { chart_param_target, .. } => chart_param_target.as_ref(),
            _ => None,
        };
        let Some(target) = target else { continue };
        if !dead.contains(&target.chart_id) {
            continue;
        }
        previous.push(control.clone());
        match &mut control.config {
            PaneControlConfig::Slider { chart_param_target, .. }
            | PaneControlConfig::Dropdown { chart_param_target, .. } => {
                *chart_param_target = None;
            }
            _ => {}
        }
    }
    previous
}

/// Everything a SHEET removal did to the index-anchored object stores nothing
/// else remaps, kept for undo and for the log line.
#[derive(Debug, Default)]
pub struct SheetObjectCascade {
    pub deleted_slicers: Vec<Slicer>,
    pub deleted_timelines: Vec<TimelineSlicer>,
    pub deleted_charts: Vec<crate::api_types::ChartEntry>,
    pub previous_filters: Vec<RibbonFilter>,
}

impl SheetObjectCascade {
    pub fn is_empty(&self) -> bool {
        self.deleted_slicers.is_empty()
            && self.deleted_timelines.is_empty()
            && self.deleted_charts.is_empty()
            && self.previous_filters.is_empty()
    }
}

/// Re-anchor (or remove) every object that names its sheet by INDEX and is not
/// covered by `remap_sheet_keyed_stores`.
///
/// `remap` returns the new index for an old one, or `None` when that sheet is
/// gone — the same closure shape `remap_sheet_keyed_stores` and
/// `remap_report_sheets` already take, so the three cannot disagree about what
/// a sheet operation did.
///
/// TWO DISTINCT DEFECTS, and the second is the quieter one:
///
/// * an object ON the deleted sheet survived with an index that no longer names
///   its sheet;
/// * an object on a sheet ABOVE the deleted one kept its OLD index, which now
///   names a DIFFERENT sheet — so a slicer authored on Sheet3 started painting
///   on Sheet2, and a click there edited it.
///
/// Both are fixed by the one walk, which is why it takes a remap rather than a
/// deleted index: sheet MOVE has the identical problem and can call it too.
pub fn cascade_sheet_removed(
    state: &AppState,
    slicer_state: &SlicerState,
    timeline_state: &TimelineSlicerState,
    ribbon_filter_state: &RibbonFilterState,
    effect: &DocumentEffect,
    remap: &dyn Fn(usize) -> Option<usize>,
) -> SheetObjectCascade {
    let mut out = SheetObjectCascade::default();

    {
        let mut slicers = slicer_state.slicers.write(effect).unwrap();
        let mut to_delete: Vec<EntityId> = Vec::new();
        for (id, slicer) in slicers.iter_mut() {
            match remap(slicer.sheet_index) {
                Some(new_index) => slicer.sheet_index = new_index,
                None => to_delete.push(*id),
            }
        }
        for id in to_delete {
            if let Some(slicer) = slicers.remove(&id) {
                out.deleted_slicers.push(slicer);
            }
        }
    }
    for slicer in &out.deleted_slicers {
        drop_slicer_computed_properties(slicer_state, effect, slicer.id);
    }

    {
        let mut timelines = timeline_state.timelines.write(effect).unwrap();
        let mut to_delete: Vec<EntityId> = Vec::new();
        for (id, tl) in timelines.iter_mut() {
            match remap(tl.sheet_index) {
                Some(new_index) => tl.sheet_index = new_index,
                None => to_delete.push(*id),
            }
        }
        for id in to_delete {
            if let Some(tl) = timelines.remove(&id) {
                out.deleted_timelines.push(tl);
            }
        }
    }

    {
        let mut charts = state.charts.write(effect).unwrap();
        let mut kept: Vec<crate::api_types::ChartEntry> = Vec::with_capacity(charts.len());
        for chart in charts.drain(..) {
            match remap(chart.sheet_index) {
                Some(new_index) => {
                    let mut chart = chart;
                    chart.sheet_index = new_index;
                    kept.push(chart);
                }
                None => out.deleted_charts.push(chart),
            }
        }
        *charts = kept;
    }

    // Sparklines are stored one entry per sheet, keyed by index, and were never
    // remapped either: the deleted sheet's group list stayed and every entry
    // above it kept an index naming a different sheet's grid.
    {
        let mut sparklines = state.sparklines.write(effect).unwrap();
        let mut kept: Vec<crate::api_types::SparklineEntry> = Vec::with_capacity(sparklines.len());
        for entry in sparklines.drain(..) {
            if let Some(new_index) = remap(entry.sheet_index) {
                let mut entry = entry;
                entry.sheet_index = new_index;
                kept.push(entry);
            }
        }
        *sparklines = kept;
    }

    // THE DELETED SLICERS' AND TIMELINES' OWN CASCADES, for the same reason
    // `cascade_deleted_sources` runs them (§3cd): a slicer removed with its
    // sheet is still named in every ribbon filter's cross-filter target list,
    // and still owns an object script keyed on its id. The charts removed here
    // are handled by the caller, which is the one holding `PaneControlState`.
    {
        let dead_slicers: Vec<EntityId> = out.deleted_slicers.iter().map(|s| s.id).collect();
        out.previous_filters
            .extend(cascade_deleted_slicers(ribbon_filter_state, effect, &dead_slicers));
        for id in dead_slicers {
            crate::scripting::object_script_commands::prune_scripts_for_instance(
                state,
                effect,
                &id.to_string(),
            );
        }
        for tl in &out.deleted_timelines {
            crate::scripting::object_script_commands::prune_scripts_for_instance(
                state,
                effect,
                &tl.id.to_string(),
            );
        }
    }

    {
        let mut filters = ribbon_filter_state.filters.write(effect).unwrap();
        for filter in filters.values_mut() {
            if filter.connected_sheets.is_empty() {
                continue;
            }
            let remapped: Vec<usize> = filter
                .connected_sheets
                .iter()
                .filter_map(|&i| remap(i))
                .collect();
            if remapped == filter.connected_sheets {
                continue;
            }
            out.previous_filters.push(filter.clone());
            filter.connected_sheets = remapped;
        }
    }

    out
}

// ===========================================================================
// UNDO
// ===========================================================================

#[derive(serde::Serialize)]
struct SlicerSnapshotOut<'a> {
    slicer_id: EntityId,
    previous: &'a Slicer,
}

#[derive(serde::Serialize)]
struct RibbonFilterSnapshotOut<'a> {
    filter_id: EntityId,
    previous: &'a RibbonFilter,
}

#[derive(serde::Serialize)]
struct PaneControlSnapshotOut<'a> {
    control_id: EntityId,
    previous: &'a PaneControl,
}

/// Push a restore for every object a source cascade touched into the undo
/// transaction the caller already has OPEN.
///
/// Deleted objects use the `*_delete` kinds (undo = re-create); repointed ones
/// use the plain property kinds (undo = write the previous value back). The
/// caller must have called `begin_transaction` and must call
/// `commit_transaction` afterwards — the entries land in whatever transaction
/// is current, which is the whole point: one Ctrl+Z, one restored world.
///
/// TIMELINES ARE NOT RECORDED, and that is a declared gap rather than an
/// oversight: `TimelineSlicerState` is not persisted and has no restore arm at
/// all, so there is nothing to record INTO. Noted on `delete_timeline_slicer`.
pub fn record_source_cascade_undo(state: &AppState, cascade: &SourceCascade) {
    if cascade.is_empty() {
        return;
    }
    let mut undo_stack = state.undo_stack.lock().unwrap();
    record_source_cascade_undo_into(&mut undo_stack, cascade);
}

/// The same recording, over a guard the caller ALREADY HOLDS.
///
/// BUG-0054's structural delete paths hold the undo lock for their whole
/// transaction (grid snapshot first, per-store restores after), so the
/// state-locking wrapper above would self-deadlock there — std mutexes are not
/// reentrant. Entries land in whatever transaction is open on the stack,
/// exactly as the wrapper's doc promises.
pub fn record_source_cascade_undo_into(
    undo_stack: &mut engine::UndoStack,
    cascade: &SourceCascade,
) {
    if cascade.is_empty() {
        return;
    }
    for slicer in &cascade.deleted_slicers {
        let data = serde_json::to_vec(&SlicerSnapshotOut {
            slicer_id: slicer.id,
            previous: slicer,
        })
        .unwrap_or_default();
        undo_stack.record_custom_restore("slicer_delete".to_string(), data, "Restore slicer");
    }
    for slicer in &cascade.rebound_slicers {
        let data = serde_json::to_vec(&SlicerSnapshotOut {
            slicer_id: slicer.id,
            previous: slicer,
        })
        .unwrap_or_default();
        undo_stack.record_custom_restore("slicer".to_string(), data, "Restore slicer binding");
    }
    for filter in &cascade.rebound_filters {
        let data = serde_json::to_vec(&RibbonFilterSnapshotOut {
            filter_id: filter.id,
            previous: filter,
        })
        .unwrap_or_default();
        undo_stack.record_custom_restore(
            "ribbon_filter".to_string(),
            data,
            "Restore filter targets",
        );
    }
}

/// Push a restore for every ribbon filter a prune edited.
pub fn record_filter_prune_undo(state: &AppState, previous: &[RibbonFilter], description: &str) {
    if previous.is_empty() {
        return;
    }
    let mut undo_stack = state.undo_stack.lock().unwrap();
    for filter in previous {
        let data = serde_json::to_vec(&RibbonFilterSnapshotOut {
            filter_id: filter.id,
            previous: filter,
        })
        .unwrap_or_default();
        undo_stack.record_custom_restore("ribbon_filter".to_string(), data, description);
    }
}

/// Push a restore for every pane control a chart prune edited.
pub fn record_pane_control_prune_undo(
    state: &AppState,
    previous: &[PaneControl],
    description: &str,
) {
    if previous.is_empty() {
        return;
    }
    let mut undo_stack = state.undo_stack.lock().unwrap();
    for control in previous {
        let data = serde_json::to_vec(&PaneControlSnapshotOut {
            control_id: control.id,
            previous: control,
        })
        .unwrap_or_default();
        undo_stack.record_custom_restore("pane_control".to_string(), data, description);
    }
}

// ===========================================================================
// THE TRANSPARENCY QUERY
// ===========================================================================

/// One object that would be affected by deleting another — what a confirm
/// dialog needs in order to NAME it.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectDependent {
    /// The dependent's kind, as `ObjectKind::wire_name`.
    pub kind: String,
    /// Its id, as text (an EntityId, or a name for name-keyed objects).
    pub id: String,
    /// Its display name.
    pub name: String,
    /// What the delete will do to it — `DeletePolicy` in lowerCamel.
    pub policy: String,
    /// The edge, e.g. "cacheSourceId".
    pub via: String,
}

fn policy_wire_name(policy: DeletePolicy) -> &'static str {
    match policy {
        DeletePolicy::Cascade => "cascade",
        DeletePolicy::CascadeOrRebind => "cascadeOrRebind",
        DeletePolicy::Prune => "prune",
        DeletePolicy::Repair => "repair",
        DeletePolicy::WarnAndKeep => "warnAndKeep",
        DeletePolicy::Refuse => "refuse",
        DeletePolicy::Recalculate => "recalculate",
        DeletePolicy::NoDependents => "noDependents",
    }
}

/// LIVE dependents of one object, for a confirm dialog or an inspector panel.
///
/// This is the `list_controls_referencing_macro` idea generalised: the backend
/// owns every store, so the "what points at this?" question is answered where
/// the data is instead of being reassembled from a dozen per-feature caches on
/// the frontend. It reports what WOULD happen using the same rules the cascade
/// applies, so the warning and the behaviour cannot drift.
#[tauri::command]
pub fn list_object_dependents(
    state: State<AppState>,
    slicer_state: State<SlicerState>,
    timeline_state: State<TimelineSlicerState>,
    ribbon_filter_state: State<RibbonFilterState>,
    pane_control_state: State<PaneControlState>,
    pivot_state: State<crate::pivot::PivotState>,
    object_kind: String,
    object_id: String,
) -> Vec<ObjectDependent> {
    let mut out: Vec<ObjectDependent> = Vec::new();
    let id = EntityId::parse(&object_id);

    match object_kind.as_str() {
        "table" | "pivot" => {
            let Some(id) = id else { return out };
            let source_type = if object_kind == "table" {
                SlicerSourceType::Table
            } else {
                SlicerSourceType::Pivot
            };
            let slicers = slicer_state.slicers.read().unwrap();
            for slicer in slicers.values() {
                if slicer.source_type != source_type {
                    continue;
                }
                let cache_hit = slicer.cache_source_id == id;
                let conn_hit = slicer
                    .connected_sources
                    .iter()
                    .any(|c| c.source_type == source_type && c.source_id == id);
                if !cache_hit && !conn_hit {
                    continue;
                }
                let survivors = slicer
                    .connected_sources
                    .iter()
                    .filter(|c| c.source_type == source_type && c.source_id != id)
                    .count();
                let policy = if cache_hit && survivors == 0 {
                    DeletePolicy::Cascade
                } else {
                    DeletePolicy::Prune
                };
                out.push(ObjectDependent {
                    kind: ObjectKind::Slicer.wire_name().to_string(),
                    id: slicer.id.to_string(),
                    name: slicer.name.clone(),
                    policy: policy_wire_name(policy).to_string(),
                    via: if cache_hit { "cacheSourceId" } else { "connectedSources" }
                        .to_string(),
                });
            }
            drop(slicers);

            if source_type == SlicerSourceType::Pivot {
                let timelines = timeline_state.timelines.read().unwrap();
                for tl in timelines.values() {
                    let source_hit = tl.source_id == id;
                    let conn_hit = tl.connected_pivot_ids.contains(&id);
                    if !source_hit && !conn_hit {
                        continue;
                    }
                    let survivors = tl
                        .connected_pivot_ids
                        .iter()
                        .filter(|p| **p != id)
                        .count();
                    let policy = if source_hit && survivors == 0 {
                        DeletePolicy::Cascade
                    } else {
                        DeletePolicy::Prune
                    };
                    out.push(ObjectDependent {
                        kind: ObjectKind::TimelineSlicer.wire_name().to_string(),
                        id: tl.id.to_string(),
                        name: tl.name.clone(),
                        policy: policy_wire_name(policy).to_string(),
                        via: if source_hit { "sourceId" } else { "connectedPivotIds" }
                            .to_string(),
                    });
                }
                drop(timelines);

                let filters = ribbon_filter_state.filters.read().unwrap();
                for filter in filters.values() {
                    if !filter.connected_pivots.contains(&id)
                        && !filter.cross_filter_targets.contains(&id)
                    {
                        continue;
                    }
                    out.push(ObjectDependent {
                        kind: ObjectKind::RibbonFilter.wire_name().to_string(),
                        id: filter.id.to_string(),
                        name: filter.name.clone(),
                        policy: policy_wire_name(DeletePolicy::Prune).to_string(),
                        via: "connectedPivots".to_string(),
                    });
                }
            }
        }
        "slicer" => {
            let Some(id) = id else { return out };
            let filters = ribbon_filter_state.filters.read().unwrap();
            for filter in filters.values() {
                if !filter.cross_filter_slicer_targets.contains(&id) {
                    continue;
                }
                out.push(ObjectDependent {
                    kind: ObjectKind::RibbonFilter.wire_name().to_string(),
                    id: filter.id.to_string(),
                    name: filter.name.clone(),
                    policy: policy_wire_name(DeletePolicy::Prune).to_string(),
                    via: "crossFilterSlicerTargets".to_string(),
                });
            }
        }
        "ribbonFilter" => {
            let Some(id) = id else { return out };
            let filters = ribbon_filter_state.filters.read().unwrap();
            for filter in filters.values() {
                if filter.id == id || !filter.cross_filter_targets.contains(&id) {
                    continue;
                }
                out.push(ObjectDependent {
                    kind: ObjectKind::RibbonFilter.wire_name().to_string(),
                    id: filter.id.to_string(),
                    name: filter.name.clone(),
                    policy: policy_wire_name(DeletePolicy::Prune).to_string(),
                    via: "crossFilterTargets".to_string(),
                });
            }
        }
        "chart" => {
            let Some(id) = id else { return out };
            let key = id.to_string();
            let controls = pane_control_state.controls.lock().unwrap();
            for control in controls.values() {
                let target = match &control.config {
                    PaneControlConfig::Slider { chart_param_target, .. }
                    | PaneControlConfig::Dropdown { chart_param_target, .. } => {
                        chart_param_target.as_ref()
                    }
                    _ => None,
                };
                let Some(target) = target else { continue };
                if target.chart_id != key {
                    continue;
                }
                out.push(ObjectDependent {
                    kind: ObjectKind::PaneControl.wire_name().to_string(),
                    id: control.id.to_string(),
                    name: control.name.clone(),
                    policy: policy_wire_name(DeletePolicy::Prune).to_string(),
                    via: "chartParamTarget".to_string(),
                });
            }
        }
        "biConnection" => {
            // The one WarnAndKeep owner. Nothing is cascaded; the point of the
            // query is that the confirm can NAME what will stop refreshing.
            let Some(id) = id else { return out };
            let filters = ribbon_filter_state.filters.read().unwrap();
            for filter in filters.values() {
                if filter.connection_id != id {
                    continue;
                }
                out.push(ObjectDependent {
                    kind: ObjectKind::RibbonFilter.wire_name().to_string(),
                    id: filter.id.to_string(),
                    name: filter.name.clone(),
                    policy: policy_wire_name(DeletePolicy::WarnAndKeep).to_string(),
                    via: "connectionId".to_string(),
                });
            }
            drop(filters);
            // BI-backed pivots. Their connection id lives in `bi_metadata`, not
            // in the definition, which is why this cannot be answered from the
            // pivot list alone.
            if let Ok(meta) = pivot_state.bi_metadata.read() {
                let names = pivot_state.pivot_tables.read().ok();
                for (pivot_id, m) in meta.iter() {
                    if m.connection_id != id {
                        continue;
                    }
                    let name = names
                        .as_ref()
                        .and_then(|t| t.get(pivot_id))
                        .and_then(|(def, _)| def.name.clone())
                        .unwrap_or_else(|| pivot_id.to_string());
                    out.push(ObjectDependent {
                        kind: ObjectKind::Pivot.wire_name().to_string(),
                        id: pivot_id.to_string(),
                        name,
                        policy: policy_wire_name(DeletePolicy::WarnAndKeep).to_string(),
                        via: "biMetadata.connectionId".to_string(),
                    });
                }
            }
        }
        "sheet" => {
            let Ok(sheet_index) = object_id.parse::<usize>() else {
                return out;
            };
            let slicers = slicer_state.slicers.read().unwrap();
            for slicer in slicers.values() {
                if slicer.sheet_index != sheet_index {
                    continue;
                }
                out.push(ObjectDependent {
                    kind: ObjectKind::Slicer.wire_name().to_string(),
                    id: slicer.id.to_string(),
                    name: slicer.name.clone(),
                    policy: policy_wire_name(DeletePolicy::Cascade).to_string(),
                    via: "sheetIndex".to_string(),
                });
            }
            drop(slicers);
            let timelines = timeline_state.timelines.read().unwrap();
            for tl in timelines.values() {
                if tl.sheet_index != sheet_index {
                    continue;
                }
                out.push(ObjectDependent {
                    kind: ObjectKind::TimelineSlicer.wire_name().to_string(),
                    id: tl.id.to_string(),
                    name: tl.name.clone(),
                    policy: policy_wire_name(DeletePolicy::Cascade).to_string(),
                    via: "sheetIndex".to_string(),
                });
            }
            drop(timelines);
            let charts = state.charts.read().unwrap();
            for chart in charts.iter() {
                if chart.sheet_index != sheet_index {
                    continue;
                }
                out.push(ObjectDependent {
                    kind: ObjectKind::Chart.wire_name().to_string(),
                    id: chart.id.to_string(),
                    name: chart.id.to_string(),
                    policy: policy_wire_name(DeletePolicy::Cascade).to_string(),
                    via: "sheetIndex".to_string(),
                });
            }
        }
        _ => {}
    }

    // Deterministic order so a warning reads the same every time (the rule
    // `list_controls_referencing_macro` set).
    out.sort_by(|a, b| (a.kind.as_str(), a.name.as_str()).cmp(&(b.kind.as_str(), b.name.as_str())));
    out
}
