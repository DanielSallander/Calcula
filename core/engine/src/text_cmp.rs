//! FILENAME: core/engine/src/text_cmp.rs
//! PURPOSE: Allocation-free case-insensitive text comparison for the
//! evaluator's hot paths (comparison operators, lookup matching, criteria).
//!
//! Equivalence contract: every function here produces EXACTLY the same result
//! as first materializing `a.to_uppercase()` / `b.to_uppercase()` Strings and
//! comparing those. This holds because:
//!   - `str::to_uppercase` is per-char (`chars().flat_map(char::to_uppercase)`;
//!     unlike lowercasing there are no context-dependent uppercase mappings
//!     such as final sigma), and
//!   - `String` ordering is byte-wise lexicographic, which for UTF-8 equals
//!     code-point lexicographic order — so comparing the streamed uppercase
//!     expansions char-by-char is identical to comparing the built Strings.
//! Multi-char expansions (e.g. "ß" -> "SS") stream in the same order they
//! would appear in the built String.

use std::cmp::Ordering;

/// `a.to_uppercase().cmp(&b.to_uppercase())` without the two allocations.
#[inline]
pub fn cmp_ci(a: &str, b: &str) -> Ordering {
    a.chars()
        .flat_map(char::to_uppercase)
        .cmp(b.chars().flat_map(char::to_uppercase))
}

/// `a.to_uppercase() == b.to_uppercase()` without the two allocations.
#[inline]
pub fn eq_ci(a: &str, b: &str) -> bool {
    a.chars()
        .flat_map(char::to_uppercase)
        .eq(b.chars().flat_map(char::to_uppercase))
}

/// `a.to_uppercase() == folded` where `folded` is ALREADY an uppercase image
/// (e.g. criteria keys stored uppercased at parse time). One allocation saved.
#[inline]
pub fn eq_ci_folded(a: &str, folded: &str) -> bool {
    a.chars().flat_map(char::to_uppercase).eq(folded.chars())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Differential corpus: ASCII, sharp-s multi-char expansion, dotted/dotless
    /// I, ligatures, astral-plane chars, combining marks, empties, prefixes.
    const CORPUS: &[&str] = &[
        "",
        "a",
        "A",
        "abc",
        "ABC",
        "abd",
        "Straße",
        "STRASSE",
        "strasse",
        "ﬀ",     // latin small ligature ff (uppercases to "FF")
        "FF",
        "ﬃ",    // ligature ffi -> "FFI"
        "ı",     // dotless i (uppercases to I)
        "i",
        "İ",     // dotted capital I
        "Ǆ",    // DZ digraph
        "ǆ",    // dz digraph (uppercases to DZ digraph)
        "𝕏ray", // astral char
        "e\u{0301}clair", // combining acute
        "éclair",
        "ZEBRA",
        "zebr",
        "5",
        "5.0",
        " spaced ",
        "*wild?",
    ];

    #[test]
    fn cmp_ci_matches_materialized_uppercase() {
        for a in CORPUS {
            for b in CORPUS {
                let expected = a.to_uppercase().cmp(&b.to_uppercase());
                assert_eq!(
                    cmp_ci(a, b),
                    expected,
                    "cmp_ci({:?}, {:?}) diverged from to_uppercase comparison",
                    a,
                    b
                );
            }
        }
    }

    #[test]
    fn eq_ci_matches_materialized_uppercase() {
        for a in CORPUS {
            for b in CORPUS {
                let expected = a.to_uppercase() == b.to_uppercase();
                assert_eq!(eq_ci(a, b), expected, "eq_ci({:?}, {:?}) diverged", a, b);
            }
        }
    }

    #[test]
    fn eq_ci_folded_matches_materialized_uppercase() {
        for a in CORPUS {
            for b in CORPUS {
                let folded = b.to_uppercase();
                let expected = a.to_uppercase() == folded;
                assert_eq!(
                    eq_ci_folded(a, &folded),
                    expected,
                    "eq_ci_folded({:?}, {:?}) diverged",
                    a,
                    folded
                );
            }
        }
    }

    #[test]
    fn ordering_relations_hold() {
        // < and > via cmp_ci agree with String comparison operators.
        for a in CORPUS {
            for b in CORPUS {
                let (ua, ub) = (a.to_uppercase(), b.to_uppercase());
                assert_eq!(cmp_ci(a, b) == Ordering::Less, ua < ub);
                assert_eq!(cmp_ci(a, b) == Ordering::Greater, ua > ub);
            }
        }
    }
}
