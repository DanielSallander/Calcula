//! FILENAME: app/src-tauri/src/insights/strategy/overlap.rs
// PURPOSE: Decide, statically, whether two scoped rules can both claim the same
//          attribute at the same point - and refuse the document when they can.
// CONTEXT: This one file is what separates "scoped rules" from "a rules engine
//          nobody can predict". Every rules system that ships without it ends up
//          with a reader asking why Nordics says the opposite of Dept A, and the
//          only honest answer being "whichever rule the loop reached first".
//
//          It is decidable here because a scope ranges over FINITE DECLARED
//          members: a member list or an inclusive date range. So "do these two
//          scopes admit a common point" is enumeration, not theorem proving, and
//          the checker can hand back a WITNESS - an actual point both rules claim
//          - which is the difference between a finding a consultant can fix and a
//          warning they learn to ignore.
//
//          THE SPECIFICITY LADDER. Rules at DIFFERENT specificity (different
//          counts of constrained columns) are not a conflict: the more specific
//          one wins, which is the ordinary override a consultant is asking for.
//          Only EQUAL specificity is undecidable by the ladder, and that is what
//          is refused - unless some strictly more specific rule on the same
//          attribute covers the whole intersection, in which case the ambiguous
//          region has already been given an answer.
//
//          A COLUMN CONSTRAINED BY ONLY ONE SIDE IMPOSES NO RESTRICTION. This is
//          the trap: `{Dept: A}` and `{Region: Nordics}` look unrelated and DO
//          intersect, at the point (Dept=A, Region=Nordics). A checker that
//          compares scopes key-by-key and calls differing keys "disjoint" is
//          worse than no checker, because it certifies the exact case that breaks.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::types::{Attribute, QualifiedColumn, Rule, Scope, ScopeValue, StrategyDoc};

/// Two rules of equal specificity that both claim one attribute over a region
/// nothing more specific resolves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Conflict {
    pub attribute: Attribute,
    pub rule_a: String,
    pub rule_b: String,
    /// A concrete point both rules claim. Quoted verbatim in the validation
    /// finding so the consultant can see the collision rather than infer it.
    pub example_point: BTreeMap<QualifiedColumn, String>,
}

impl Conflict {
    /// The sentence the validator prints. Names BOTH rules and the point.
    pub fn message(&self) -> String {
        let point = if self.example_point.is_empty() {
            "every point (neither rule is scoped)".to_string()
        } else {
            self.example_point
                .iter()
                .map(|(c, m)| format!("{c}={m}"))
                .collect::<Vec<_>>()
                .join(", ")
        };
        format!(
            "rules '{}' and '{}' both set '{}' at the same specificity and both claim {} - \
             nothing decides which wins, so add a more specific rule or narrow one of them",
            self.rule_a, self.rule_b, self.attribute, point
        )
    }
}

/// How many columns a scope constrains. The rung on the override ladder.
pub fn specificity(scope: &Scope) -> usize {
    scope.len()
}

/// The region both scopes admit, or `None` when they admit nothing in common.
///
/// A column constrained by only one side is copied through unchanged, because the
/// other side leaves it free.
pub fn scope_intersection(a: &Scope, b: &Scope) -> Option<Scope> {
    let mut out: Scope = Scope::new();
    for (col, av) in a {
        match b.get(col) {
            None => {
                out.insert(col.clone(), av.clone());
            }
            Some(bv) => {
                let merged = intersect_values(av, bv)?;
                out.insert(col.clone(), merged);
            }
        }
    }
    for (col, bv) in b {
        if !a.contains_key(col) {
            out.insert(col.clone(), bv.clone());
        }
    }
    Some(out)
}

/// The overlap of two constraints on ONE column.
fn intersect_values(a: &ScopeValue, b: &ScopeValue) -> Option<ScopeValue> {
    match (a, b) {
        (ScopeValue::Members(x), ScopeValue::Members(y)) => {
            // Keep `x`'s order so the witness is stable across runs; a HashSet
            // here would make the reported example point nondeterministic, which
            // is the same defect that once defeated .calp blob dedup.
            let common: Vec<String> = x.iter().filter(|m| y.contains(m)).cloned().collect();
            if common.is_empty() {
                None
            } else {
                Some(ScopeValue::Members(common))
            }
        }
        (
            ScopeValue::DateRange { from: f1, to: t1 },
            ScopeValue::DateRange { from: f2, to: t2 },
        ) => {
            // Zero-padded ISO-8601 compares correctly as a string; validate.rs
            // refuses any bound that is not in that form, which is what makes
            // this line safe rather than merely convenient.
            let from = if f1 >= f2 { f1 } else { f2 };
            // An absent `to` is "onwards", so it is the WEAKER bound: the
            // intersection ends at whichever side actually names an end, and
            // only stays open when neither does. Treating `None` as an empty
            // upper bound instead would make every open-ended rule disjoint
            // from every other, which silently disables the whole checker for
            // the most common way a business rule is written.
            let to = match (t1, t2) {
                (None, None) => None,
                (Some(a), None) => Some(a),
                (None, Some(b)) => Some(b),
                (Some(a), Some(b)) => Some(if a <= b { a } else { b }),
            };
            if to.is_some_and(|t| from > t) {
                None
            } else {
                Some(ScopeValue::DateRange {
                    from: from.clone(),
                    to: to.cloned(),
                })
            }
        }
        // One side lists members, the other gives a date range. Enumeration
        // cannot settle it here (the members may or may not be dates in that
        // range), and the safe direction is to REFUSE: reporting an overlap that
        // may not exist costs a consultant one edit, while certifying a pair that
        // does overlap ships a document with an undecidable rule in it.
        // validate.rs separately flags the mixed constraint as its own finding.
        _ => Some(a.clone()),
    }
}

/// Does `outer` contain every point of `region`?
fn covers(outer: &Scope, region: &Scope) -> bool {
    for (col, oc) in outer {
        match region.get(col) {
            // The region leaves this column free, so it holds points `outer`
            // excludes: `outer` covers only part of it.
            None => return false,
            Some(rc) => {
                if !is_subset(rc, oc) {
                    return false;
                }
            }
        }
    }
    true
}

fn is_subset(inner: &ScopeValue, outer: &ScopeValue) -> bool {
    match (inner, outer) {
        (ScopeValue::Members(i), ScopeValue::Members(o)) => i.iter().all(|m| o.contains(m)),
        (
            ScopeValue::DateRange { from: fi, to: ti },
            ScopeValue::DateRange { from: fo, to: to_ },
        ) => {
            // `inner` is inside `outer` when outer starts no later and ends no
            // earlier. An open-ended outer ends no earlier than anything; an
            // open-ended inner is contained only by an open-ended outer.
            let starts_within = fo <= fi;
            let ends_within = match (ti, to_) {
                (_, None) => true,
                (None, Some(_)) => false,
                (Some(i), Some(o)) => i <= o,
            };
            starts_within && ends_within
        }
        _ => false,
    }
}

/// One concrete point inside a region: the first member of each constraint, or
/// the opening date of each range.
fn witness(region: &Scope) -> BTreeMap<QualifiedColumn, String> {
    region
        .iter()
        .filter_map(|(col, v)| match v {
            ScopeValue::Members(m) => m.first().map(|m| (col.clone(), m.clone())),
            ScopeValue::DateRange { from, .. } => Some((col.clone(), from.clone())),
        })
        .collect()
}

/// Every unresolved equal-specificity collision in the document.
///
/// `Attribute::Suppress` is deliberately EXEMPT. Suppression is a union and a
/// union is order-independent: two rules that both hide the "outlier" kind in
/// overlapping regions produce the same outcome whichever is applied first, so
/// there is nothing for a consultant to disambiguate and refusing would be noise.
/// Every other attribute picks ONE value, and picking is where order shows.
pub fn check_overlaps(doc: &StrategyDoc) -> Vec<Conflict> {
    let mut conflicts = Vec::new();

    // (measure, attribute) -> the rules that set it.
    let mut buckets: BTreeMap<(&str, Attribute), Vec<&Rule>> = BTreeMap::new();
    for rule in &doc.rules {
        for attr in rule.set.touched() {
            if attr == Attribute::Suppress {
                continue;
            }
            buckets
                .entry((rule.measure.as_str(), attr))
                .or_default()
                .push(rule);
        }
    }

    for ((_measure, attribute), rules) in buckets {
        for i in 0..rules.len() {
            for j in (i + 1)..rules.len() {
                let a = rules[i];
                let b = rules[j];
                let k = specificity(&a.scope);
                if k != specificity(&b.scope) {
                    // Different rungs: the ladder decides, no ambiguity.
                    continue;
                }
                let Some(region) = scope_intersection(&a.scope, &b.scope) else {
                    continue;
                };
                let disambiguated = rules.iter().any(|candidate| {
                    specificity(&candidate.scope) > k && covers(&candidate.scope, &region)
                });
                if disambiguated {
                    continue;
                }
                conflicts.push(Conflict {
                    attribute,
                    rule_a: a.id.clone(),
                    rule_b: b.id.clone(),
                    example_point: witness(&region),
                });
            }
        }
    }

    conflicts
}

#[cfg(test)]
mod tests {
    use super::*;
    // StrategyDoc, Rule, Scope, ScopeValue and QualifiedColumn arrive through
    // `use super::*`.
    use crate::insights::strategy::types::{AttributeSet, Direction, Materiality};

    fn col(table: &str, column: &str) -> QualifiedColumn {
        QualifiedColumn::new(table, column)
    }

    fn members(pairs: &[(&str, &str, &[&str])]) -> Scope {
        pairs
            .iter()
            .map(|(t, c, ms)| {
                (
                    col(t, c),
                    ScopeValue::Members(ms.iter().map(|m| m.to_string()).collect()),
                )
            })
            .collect()
    }

    fn rule(id: &str, scope: Scope, set: AttributeSet) -> Rule {
        Rule {
            id: id.into(),
            measure: "Revenue".into(),
            scope,
            set,
            note: None,
        }
    }

    fn dir(d: Direction) -> AttributeSet {
        AttributeSet {
            direction: Some(d),
            ..Default::default()
        }
    }

    #[test]
    fn two_equal_specificity_intersecting_rules_on_one_attribute_are_refused_naming_both() {
        // The trap case: the scopes constrain DIFFERENT columns, so they look
        // unrelated, and they both claim (Dept=A, Region=Nordics).
        let mut doc = StrategyDoc::default();
        doc.rules.push(rule(
            "dept-a",
            members(&[("Dim", "Dept", &["A"])]),
            dir(Direction::HigherIsBetter),
        ));
        doc.rules.push(rule(
            "nordics",
            members(&[("Geo", "Region", &["Nordics"])]),
            dir(Direction::LowerIsBetter),
        ));

        let conflicts = check_overlaps(&doc);
        assert_eq!(conflicts.len(), 1, "expected one conflict, got {conflicts:?}");
        let c = &conflicts[0];
        assert_eq!(c.attribute, Attribute::Direction);
        assert_eq!(c.rule_a, "dept-a");
        assert_eq!(c.rule_b, "nordics");
        assert_eq!(
            c.example_point,
            BTreeMap::from([
                (col("Dim", "Dept"), "A".to_string()),
                (col("Geo", "Region"), "Nordics".to_string()),
            ]),
            "the witness must be the point both rules claim"
        );
        let msg = c.message();
        assert!(msg.contains("dept-a") && msg.contains("nordics"), "message: {msg}");
    }

    #[test]
    fn a_more_specific_rule_resolves_the_pair() {
        // Positive control for the test above: same two rules, plus a rule that
        // covers exactly their intersection. The ladder now has an answer.
        let mut doc = StrategyDoc::default();
        doc.rules.push(rule(
            "dept-a",
            members(&[("Dim", "Dept", &["A"])]),
            dir(Direction::HigherIsBetter),
        ));
        doc.rules.push(rule(
            "nordics",
            members(&[("Geo", "Region", &["Nordics"])]),
            dir(Direction::LowerIsBetter),
        ));
        doc.rules.push(rule(
            "dept-a-in-nordics",
            members(&[("Dim", "Dept", &["A"]), ("Geo", "Region", &["Nordics"])]),
            dir(Direction::Neutral),
        ));

        assert_eq!(
            check_overlaps(&doc),
            vec![],
            "a strictly more specific rule covering the whole intersection resolves it"
        );

        // ...and it must be the SAME attribute that gets disambiguated. A more
        // specific rule that sets materiality says nothing about direction.
        let mut other = StrategyDoc::default();
        other.rules.push(rule(
            "dept-a",
            members(&[("Dim", "Dept", &["A"])]),
            dir(Direction::HigherIsBetter),
        ));
        other.rules.push(rule(
            "nordics",
            members(&[("Geo", "Region", &["Nordics"])]),
            dir(Direction::LowerIsBetter),
        ));
        other.rules.push(rule(
            "unrelated",
            members(&[("Dim", "Dept", &["A"]), ("Geo", "Region", &["Nordics"])]),
            AttributeSet {
                materiality: Some(Materiality::Absolute { value: 10.0 }),
                ..Default::default()
            },
        ));
        assert_eq!(
            check_overlaps(&other).len(),
            1,
            "a more specific rule on a DIFFERENT attribute must not resolve a direction conflict"
        );
    }

    #[test]
    fn a_more_specific_rule_covering_only_part_of_the_region_does_not_resolve_it() {
        // `dept-a` and `nordics` intersect over Dept=A x Region=Nordics for EVERY
        // Segment. A rule that pins Segment=Retail answers one slice and leaves
        // the rest ambiguous, so the pair must still be refused.
        let mut doc = StrategyDoc::default();
        doc.rules.push(rule(
            "dept-a",
            members(&[("Dim", "Dept", &["A"])]),
            dir(Direction::HigherIsBetter),
        ));
        doc.rules.push(rule(
            "nordics",
            members(&[("Geo", "Region", &["Nordics"])]),
            dir(Direction::LowerIsBetter),
        ));
        doc.rules.push(rule(
            "retail-only",
            members(&[
                ("Dim", "Dept", &["A"]),
                ("Geo", "Region", &["Nordics"]),
                ("Dim", "Segment", &["Retail"]),
            ]),
            dir(Direction::Neutral),
        ));
        assert_eq!(check_overlaps(&doc).len(), 1);
    }

    #[test]
    fn disjoint_equal_specificity_rules_coexist() {
        let mut doc = StrategyDoc::default();
        doc.rules.push(rule(
            "dept-a",
            members(&[("Dim", "Dept", &["A"])]),
            dir(Direction::HigherIsBetter),
        ));
        doc.rules.push(rule(
            "dept-b",
            members(&[("Dim", "Dept", &["B"])]),
            dir(Direction::LowerIsBetter),
        ));
        assert_eq!(check_overlaps(&doc), vec![]);
    }

    #[test]
    fn two_rules_on_different_measures_never_collide() {
        let mut doc = StrategyDoc::default();
        let mut a = rule("a", Scope::new(), dir(Direction::HigherIsBetter));
        a.measure = "Revenue".into();
        let mut b = rule("b", Scope::new(), dir(Direction::LowerIsBetter));
        b.measure = "Cost".into();
        doc.rules.push(a);
        doc.rules.push(b);
        assert_eq!(check_overlaps(&doc), vec![]);
    }

    #[test]
    fn two_rules_at_different_specificity_are_the_ordinary_override_not_a_conflict() {
        let mut doc = StrategyDoc::default();
        doc.rules.push(rule(
            "broad",
            members(&[("Dim", "Dept", &["A", "B"])]),
            dir(Direction::HigherIsBetter),
        ));
        doc.rules.push(rule(
            "narrow",
            members(&[("Dim", "Dept", &["A"]), ("Geo", "Region", &["Nordics"])]),
            dir(Direction::LowerIsBetter),
        ));
        assert_eq!(check_overlaps(&doc), vec![]);
    }

    #[test]
    fn overlapping_date_ranges_collide_and_adjacent_ones_do_not() {
        let range = |from: &str, to: &str| -> Scope {
            Scope::from([(
                col("Cal", "Date"),
                ScopeValue::between(from, to),
            )])
        };

        let mut doc = StrategyDoc::default();
        doc.rules
            .push(rule("h1", range("2025-01-01", "2025-06-30"), dir(Direction::HigherIsBetter)));
        doc.rules
            .push(rule("q2", range("2025-04-01", "2025-06-30"), dir(Direction::LowerIsBetter)));
        let conflicts = check_overlaps(&doc);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(
            conflicts[0].example_point.get(&col("Cal", "Date")).map(String::as_str),
            Some("2025-04-01"),
            "the witness is the first day both ranges admit"
        );

        let mut apart = StrategyDoc::default();
        apart
            .rules
            .push(rule("h1", range("2025-01-01", "2025-06-30"), dir(Direction::HigherIsBetter)));
        apart
            .rules
            .push(rule("h2", range("2025-07-01", "2025-12-31"), dir(Direction::LowerIsBetter)));
        assert_eq!(check_overlaps(&apart), vec![]);
    }

    #[test]
    fn two_unscoped_rules_on_one_attribute_are_refused() {
        // Specificity 0 on both sides: they claim the whole space.
        let mut doc = StrategyDoc::default();
        doc.rules.push(rule("a", Scope::new(), dir(Direction::HigherIsBetter)));
        doc.rules.push(rule("b", Scope::new(), dir(Direction::LowerIsBetter)));
        let conflicts = check_overlaps(&doc);
        assert_eq!(conflicts.len(), 1);
        assert!(conflicts[0].message().contains("neither rule is scoped"));
    }

    #[test]
    fn suppression_is_a_union_so_overlapping_suppress_rules_are_not_refused() {
        let mut doc = StrategyDoc::default();
        let suppress = |k: &str| AttributeSet {
            suppress: vec![k.to_string()],
            ..Default::default()
        };
        doc.rules
            .push(rule("a", members(&[("Dim", "Dept", &["A"])]), suppress("outlier")));
        doc.rules
            .push(rule("b", members(&[("Geo", "Region", &["Nordics"])]), suppress("trend")));
        assert_eq!(check_overlaps(&doc), vec![]);
    }

    #[test]
    fn an_intersection_keeps_only_the_common_members() {
        let a = members(&[("Dim", "Dept", &["A", "B", "C"])]);
        let b = members(&[("Dim", "Dept", &["B", "C", "D"])]);
        let region = scope_intersection(&a, &b).unwrap();
        assert_eq!(
            region.get(&col("Dim", "Dept")),
            Some(&ScopeValue::Members(vec!["B".into(), "C".into()]))
        );
        assert_eq!(
            scope_intersection(&a, &members(&[("Dim", "Dept", &["Z"])])),
            None
        );
    }
}
