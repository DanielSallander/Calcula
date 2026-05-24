//! Function catalog generated from `docs/functions/*.md` at build time.
//!
//! Provides metadata (name, description, signature) for every expression
//! language function, suitable for driving IDE features like autocomplete,
//! signature help, and hover documentation.

/// Metadata for a single expression language function.
#[derive(Debug, Clone)]
pub struct FunctionInfo {
    /// Canonical name, e.g. `"SUM"`.
    pub name: &'static str,
    /// One-line description from the function's documentation.
    pub description: &'static str,
    /// Syntax signature, e.g. `"SUM(table[column])"`.
    pub signature: &'static str,
}

include!(concat!(env!("OUT_DIR"), "/function_catalog_generated.rs"));

/// Returns the complete function catalog, sorted alphabetically by name.
pub fn function_catalog() -> &'static [FunctionInfo] {
    CATALOG
}
