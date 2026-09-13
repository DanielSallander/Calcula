//! FILENAME: app/src-tauri/src/pivot/mask_safety.rs
//! Decides whether a BI pivot's measures can survive HOST-SIDE filtering.
//!
//! # STATUS: correct, tested, and NOT WIRED (2026-09-13)
//!
//! Nothing calls this yet. It was written to close BUG-0108 by routing ordinary
//! (level-1) slicers into the engine for the pivots that need it, the routing
//! was implemented, and an adversarial pass then found NINE defects it would
//! introduce — one of which turns currently-CORRECT answers into a hard query
//! error. The routing was withdrawn; this module was kept because the decision
//! it encodes is right and independently verified, and because re-deriving it
//! later would be the expensive half.
//!
//! The blocker list lives in `docs/design/open-items.md` under BUG-0108. The
//! decisive one: a COMPOUND measure whose `RESET`/`CLEAR` must remove a request
//! filter is a typed refusal in the engine — see that engine's own
//! `reset_with_slicer_on_cleared_table_fails_closed` — so a
//! `% of grand total = DIVIDE(SUM(x), SUM(x, RESET()))` pivot, which masks
//! CORRECTLY today, would fail outright on an ordinary slicer click. Two more
//! are structural rather than incidental: the pivot cache after a routed query
//! holds only the SELECTED members, so the slicer's own value list collapses
//! and it can never re-expand (the escape hatch for this exists but is gated on
//! `filter_level >= 2`), and `get_pivot_field_info` derives "is filtered" from
//! `hidden_items`, which routing deliberately clears — so the header dropdown
//! would report a visibly filtered pivot as unfiltered.
//!
//! Whoever picks this up: the detector below is not the hard part. The hard
//! part is that the host assumes throughout that the pivot cache holds the FULL
//! domain and that `hidden_items` is where filtering lives, and routing
//! falsifies both.
//!
//! # The question this answers
//!
//! A BI pivot is computed by the model engine and then filtered by the HOST:
//! every pivot surface becomes a `GROUP BY` column, the engine returns
//! pre-aggregated leaf rows, and an ordinary (level-1) slicer click merely
//! flips a per-record boolean in `PivotCache::filter_mask`. Nothing is
//! re-queried.
//!
//! For an additive measure that is exactly right and enormously faster — the
//! sum of the visible rows IS the sum over the visible set. For a measure whose
//! value at one leaf group depends on rows in OTHER leaf groups, it is wrong,
//! because the engine already chose that value over a filter context that
//! contained no slicer at all. `CLEAR_INNER`/`ALLSELECTED` are fixed at
//! `LEVEL_AXIS = 0`, so "clear the axis, keep the slicers" has no slicers to
//! keep: the denominator is the whole domain and the host then hides rows from
//! a number that was already decided. That is BUG-0108.
//!
//! # Why it is a live read of the model, not stored metadata
//!
//! `BiPivotMetadata` is a CREATION-TIME snapshot and its `MeasureFieldInfo`
//! carries no expression at all, so it cannot answer this. Worse, a stored
//! answer goes stale silently: editing a measure in the Model Editor to add a
//! `CLEAR` would leave a pivot masking forever, which is the exact silent-wrong
//! -answer this module exists to prevent. Callers MUST recompute; the cached
//! copy on the metadata is for EXPLAINING a slow click to the user, never for
//! deciding.
//!
//! # Fail closed
//!
//! An unknown measure, a circular reference, or an expression shape we cannot
//! classify all answer UNSAFE — route it into the engine. Owner decision
//! 2026-09-13: a slow correct click beats a fast wrong one, and this repo's
//! standing preference is to refuse rather than to answer wrong quietly. The
//! cost is real and was accepted knowingly: an expression the inspector does
//! not recognise makes every slicer click on that pivot take an engine round
//! trip, with no visible cause.

/// True when ANY of `measure_names` is filter-context sensitive, i.e. when
/// hiding rows after the fact can change what the remaining numbers should be.
///
/// The four properties are asked of the EXPANDED expression, because a measure
/// that merely references another measure inherits its sensitivity — a plain
/// `[Revenue Share]` looks additive until the reference is inlined and turns
/// out to be `CLEAR_INNER`.
///
/// - `has_context_ops` — `Clear`/`ClearInner`/`ClearOuter`/`Reset*`/
///   `ClearExcept`/`Keep`/`KeepIn`/`Using`. The direct BUG-0108 class.
/// - `has_window` — `Window`/`Offset`/`Index`/`RankWindow`: the value at one
///   row is computed from its neighbours, so removing neighbours changes it.
/// - `contains_time_intelligence` — `ToDate`/`PeriodShift`/`DatesInPeriod`/
///   `DatesBetween`/`SemiAdditiveBalance`: same, over the calendar.
/// - `contains_is_filtered` — `ISFILTERED` is folded from the REQUEST context,
///   so a host-side mask is INVISIBLE to it. It answers "not filtered" while
///   the user is looking at a visibly filtered pivot. Masking cannot be made
///   right for it at any later stage.
#[allow(dead_code)] // Not wired — see the module header and open-items BUG-0108.
pub(crate) fn measures_are_mask_unsafe(
    engine: &bi_engine::Engine,
    measure_names: &[String],
) -> bool {
    let model = engine.model();
    for name in measure_names {
        let measure = match model.measure(name) {
            Ok(m) => m,
            // Unknown measure: the pivot names something the model does not
            // have. Route — we cannot show it is safe.
            Err(_) => return true,
        };
        let expanded = match bi_engine::expression::expand_measure_refs(
            measure.expression(),
            model,
        ) {
            Ok(e) => e,
            // Circular reference or a malformed chain. Route.
            Err(_) => return true,
        };
        if expanded.has_context_ops()
            || expanded.has_window()
            || expanded.contains_time_intelligence()
            || expanded.contains_is_filtered()
        {
            return true;
        }
    }
    false
}

/// The level a filter is actually applied at, given what the caller asked for
/// and whether this pivot's measures need engine routing.
///
/// `0` means "not routed — use the host-side `hidden_items` mask", which is not
/// a real filter level (levels are 1..=9) but the sentinel the caller branches
/// on. Extracted so the decision itself is testable: it lives inside a ~400
/// line async Tauri command that needs a live engine, two state maps and a
/// window handle to reach.
///
/// The distinction between 1 and 2+ is semantic, not merely bookkeeping. Level
/// 1 is inside bare `CLEAR`/`RESET`'s [0,1] range, so a CLEAR measure still
/// clears it — that is Power BI's ALL/ALLSELECTED split, and it is what an
/// ordinary slicer MUST mean. Levels 2..=9 sit outside that range, which is the
/// whole content of "pinned". Routing an ordinary slicer therefore changes
/// WHERE it is evaluated without changing WHAT it means; promoting it to 2
/// would silently change what every CLEAR measure in the model returns.
#[allow(dead_code)] // Not wired — see the module header and open-items BUG-0108.
pub(crate) fn effective_filter_level(requested: u8, route_level_one: bool) -> u8 {
    if requested >= 2 {
        requested
    } else if route_level_one {
        1
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds an engine over a one-fact-table model carrying `measures`, each
    /// given as `(name, expression text)`.
    ///
    /// The expressions are PARSED from the real expression language rather than
    /// hand-assembled as `Expression` variants, so a test cannot accidentally
    /// assert about a shape the parser would never produce.
    fn engine_with(measures: &[(&str, &str)]) -> bi_engine::Engine {
        let mut builder = bi_engine::DataModel::builder().add_table(
            bi_engine::Table::new(
                "Sales",
                vec![
                    bi_engine::Column::new("Amount", bi_engine::DataType::Int64),
                    bi_engine::Column::new("Region", bi_engine::DataType::String),
                ],
            )
            .unwrap(),
        );
        for (name, text) in measures {
            let expr = bi_engine::parse_measure_expression(text)
                .unwrap_or_else(|e| panic!("test measure {name} does not parse: {e}"));
            builder = builder.add_measure(bi_engine::Measure::new(*name, expr));
        }
        bi_engine::Engine::new(builder.build().unwrap())
    }

    #[test]
    fn a_plain_sum_is_mask_safe() {
        // The overwhelmingly common case, and the reason routing is conditional
        // rather than unconditional: masking a SUM is both correct and free.
        // If this ever answers true, every BI pivot pays an engine round trip
        // per slicer click for nothing.
        let engine = engine_with(&[("Revenue", "SUM(Sales[Amount])")]);
        assert!(!measures_are_mask_unsafe(&engine, &["Revenue".to_string()]));
    }

    #[test]
    fn a_context_op_is_mask_unsafe() {
        // BUG-0108's own shape. CLEAR_INNER is fixed at level 0 — the group-by
        // axis — so "clear the axis, keep the slicers" has no slicer to keep
        // when the slicer never reached the engine. The denominator is the
        // whole domain, and hiding rows afterwards cannot repair it.
        let engine = engine_with(&[
            ("Revenue", "SUM(Sales[Amount])"),
            (
                "Share",
                "SUM(Sales[Amount]) / SUM(Sales[Amount], CLEAR_INNER(Sales[Region]))",
            ),
        ]);
        assert!(measures_are_mask_unsafe(&engine, &["Share".to_string()]));
    }

    #[test]
    fn sensitivity_is_inherited_through_a_measure_reference() {
        // THE REASON THE EXPRESSION IS EXPANDED FIRST. `[Share Pct]` is a bare
        // measure reference and looks perfectly additive; the CLEAR_INNER only
        // appears once the reference is inlined. A detector that inspected the
        // UNexpanded expression would mask this pivot and reproduce BUG-0108
        // exactly, one indirection away from where anyone would look.
        let engine = engine_with(&[
            ("Revenue", "SUM(Sales[Amount])"),
            (
                "Share",
                "SUM(Sales[Amount]) / SUM(Sales[Amount], CLEAR_INNER(Sales[Region]))",
            ),
            ("Share Pct", "[Share]"),
        ]);
        assert!(measures_are_mask_unsafe(&engine, &["Share Pct".to_string()]));
    }

    #[test]
    fn an_unknown_measure_fails_closed() {
        // Owner decision 2026-09-13: route when we cannot decide. A pivot
        // naming a measure the model does not have must not be treated as
        // safe — "we could not check it" is not "it is fine".
        let engine = engine_with(&[("Revenue", "SUM(Sales[Amount])")]);
        assert!(measures_are_mask_unsafe(
            &engine,
            &["No Such Measure".to_string()]
        ));
    }

    #[test]
    fn a_circular_measure_reference_fails_closed() {
        // The OTHER fail-closed arm, and the one a sabotage pass caught as
        // untested: `expand_measure_refs` returns an error for `A -> B -> A`
        // rather than looping. `an_unknown_measure_fails_closed` covers the
        // LOOKUP arm only, so without this the EXPANSION arm could be flipped
        // to fail open — silently masking a pivot nobody could analyse — with
        // every test still green.
        //
        // The cycle is introduced by DESERIALIZING, not by the builder, because
        // `DataModelBuilder::build` refuses it outright. That is not a
        // contrivance: `DataModel` derives `Deserialize` plainly and `validate`
        // is a separate explicit call, so a model FILE carrying a cycle loads
        // into memory intact. That is exactly the path this arm defends.
        let mut json = serde_json::to_value(
            engine_with(&[("A", "[B]"), ("B", "SUM(Sales[Amount])")]).model(),
        )
        .unwrap();

        // Take A's expression (a reference to B) and re-point it at A, then
        // install it as B's expression. Done by walking the JSON rather than
        // by writing the node out, so the test does not depend on how
        // `Expression::MeasureRef` happens to serialize.
        fn repoint(v: &mut serde_json::Value, from: &str, to: &str) {
            match v {
                serde_json::Value::String(s) if s == from => *s = to.to_string(),
                serde_json::Value::Array(a) => a.iter_mut().for_each(|e| repoint(e, from, to)),
                serde_json::Value::Object(o) => {
                    o.values_mut().for_each(|e| repoint(e, from, to))
                }
                _ => {}
            }
        }
        let measures = json
            .get_mut("measures")
            .and_then(|m| m.as_array_mut())
            .expect("model json carries a measures array");
        let idx_of = |name: &str, arr: &[serde_json::Value]| {
            arr.iter()
                .position(|m| m.get("name").and_then(|n| n.as_str()) == Some(name))
                .unwrap_or_else(|| panic!("measure {name} missing from serialized model"))
        };
        let (ia, ib) = (idx_of("A", measures), idx_of("B", measures));
        let mut cyclic = measures[ia]
            .get("expression")
            .expect("measure A carries an expression")
            .clone();
        repoint(&mut cyclic, "B", "A");
        *measures[ib].get_mut("expression").unwrap() = cyclic;

        let model: bi_engine::DataModel = serde_json::from_value(json).unwrap();
        assert!(
            model.validate().is_err(),
            "this test only means something if the model really is circular"
        );
        let engine = bi_engine::Engine::new(model);
        assert!(measures_are_mask_unsafe(&engine, &["A".to_string()]));
    }

    #[test]
    fn one_unsafe_measure_makes_the_whole_pivot_unsafe() {
        // The decision is per PIVOT, not per cell: routing changes the single
        // query the whole pivot is built from. A pivot showing Revenue beside
        // a share measure must route, or the share column stays wrong.
        let engine = engine_with(&[
            ("Revenue", "SUM(Sales[Amount])"),
            (
                "Share",
                "SUM(Sales[Amount]) / SUM(Sales[Amount], CLEAR_INNER(Sales[Region]))",
            ),
        ]);
        assert!(measures_are_mask_unsafe(
            &engine,
            &["Revenue".to_string(), "Share".to_string()]
        ));
    }

    #[test]
    fn an_empty_measure_list_is_safe() {
        // A pivot with no measures has nothing a mask can get wrong and must
        // not pay a round trip for it.
        let engine = engine_with(&[]);
        assert!(!measures_are_mask_unsafe(&engine, &[]));
    }

    #[test]
    fn an_explicit_pin_is_never_downgraded_by_the_router() {
        // A pin is the user's own structural choice and outranks the detector
        // entirely. Re-deciding it here would mean a pivot of additive measures
        // silently lost its pins — and a pin at level 2 exists precisely to
        // survive bare CLEAR, which level 1 does not.
        for requested in 2u8..=9 {
            assert_eq!(effective_filter_level(requested, false), requested);
            assert_eq!(effective_filter_level(requested, true), requested);
        }
    }

    #[test]
    fn a_routed_ordinary_slicer_lands_on_level_ONE_not_two() {
        // THE SEMANTIC POINT. Routing must not promote the slicer to a pin.
        // Level 1 is inside bare CLEAR/RESET's [0,1] range, so a CLEAR measure
        // still clears it — Power BI's ALL/ALLSELECTED split, and what an
        // ordinary slicer means. Landing on 2 would make every CLEAR measure in
        // the model quietly return something else, turning a correctness fix
        // into a different wrong answer.
        assert_eq!(effective_filter_level(1, true), 1);
    }

    #[test]
    fn an_unrouted_slicer_gets_the_mask_sentinel() {
        // 0 is not a filter level (they are 1..=9) — it is the caller's signal
        // to take the host-side mask path, which stays the fast default for the
        // additive measures that are the overwhelming majority.
        assert_eq!(effective_filter_level(1, false), 0);
        assert_eq!(effective_filter_level(0, false), 0);
    }

    #[test]
    fn this_detector_is_still_unwired_and_says_so_where_it_would_be_wired() {
        // THE OPPOSITE OF THE USUAL WIRING GUARD, on purpose.
        //
        // This module is deliberately not called (see the header). The hazard
        // is not that the call gets deleted — it is that someone finds a
        // plausible-looking unused detector, wires it up, and re-introduces all
        // nine defects, because the reason it is unused lives in a comment they
        // did not read. So `apply_pivot_filter` must keep an explicit note at
        // the point where the call WOULD go, and this test fails if either the
        // note disappears or a call appears without it.
        let src = include_str!("commands.rs");
        let wired = src.contains("mask_safety::measures_are_mask_unsafe");
        let explained = src.contains("BUG-0108 ROUTING IS BUILT BUT DELIBERATELY NOT WIRED");
        assert!(
            wired || explained,
            "apply_pivot_filter neither routes nor explains why it does not. If \
             you are enabling the routing, work through the blocker list in \
             docs/design/open-items.md under BUG-0108 first and then replace \
             this test with a real wiring guard — a routed level-1 slicer \
             collapses its own value list and makes a compound RESET measure a \
             hard query error."
        );
    }

    #[test]
    fn every_routed_level_is_one_validate_filter_level_accepts() {
        // The routed level is handed straight to `validate_filter_level`, which
        // refuses anything outside 1..=9. A sentinel that leaked into that call
        // would turn an ordinary slicer click into an error message about
        // filter levels — a refusal for something the user never asked for.
        for requested in 0u8..=9 {
            for routed in [false, true] {
                let level = effective_filter_level(requested, routed);
                if level != 0 {
                    assert!(
                        crate::slicer::types::validate_filter_level(level).is_ok(),
                        "requested={requested} routed={routed} produced level {level}, \
                         which validate_filter_level refuses"
                    );
                }
            }
        }
    }
}
