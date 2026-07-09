//! Reference documentation for the expression-language functions.
//!
//! The canonical docs live as one Markdown file per function under
//! `docs/functions/` in this repository (e.g. `SUM.md`, `DIVIDE.md`). They are
//! read from disk at runtime — deliberately NOT embedded — so that edits to the
//! docs reflect in host applications (Calcula's measure editor) without
//! recompiling the engine.
//!
//! [`function_docs`] returns an empty list when the folder is absent (for
//! example a packaged build shipped without the source tree); callers should
//! treat the docs as an optional enhancement.

use std::path::PathBuf;

/// One function's reference documentation: the function name (the file stem,
/// e.g. `"DIVIDE"`) and its raw Markdown body.
#[derive(Debug, Clone)]
pub struct FunctionDoc {
    pub name: String,
    pub markdown: String,
}

/// Absolute path to the `docs/functions` folder, resolved from this crate's
/// location at build time.
pub fn function_docs_dir() -> PathBuf {
    // crate dir = <repo>/crates/engine; the docs live at <repo>/docs/functions.
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/functions")
}

/// Read every `NAME.md` under [`function_docs_dir`], sorted by name. Files that
/// cannot be read are skipped. Returns an empty vec if the folder is missing.
pub fn function_docs() -> Vec<FunctionDoc> {
    let mut docs = Vec::new();
    let Ok(entries) = std::fs::read_dir(function_docs_dir()) else {
        return docs;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let (Some(name), Ok(markdown)) = (
            path.file_stem().and_then(|s| s.to_str()).map(str::to_string),
            std::fs::read_to_string(&path),
        ) else {
            continue;
        };
        docs.push(FunctionDoc { name, markdown });
    }
    docs.sort_by(|a, b| a.name.cmp(&b.name));
    docs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_function_docs_from_disk() {
        let docs = function_docs();
        // The repo ships these docs; if the folder resolves they must be present.
        if !docs.is_empty() {
            let abs = docs.iter().find(|d| d.name == "ABS").expect("ABS.md present");
            assert!(abs.markdown.contains("# ABS"));
            // Sorted by name.
            let mut sorted = docs.clone();
            sorted.sort_by(|a, b| a.name.cmp(&b.name));
            assert_eq!(
                docs.iter().map(|d| &d.name).collect::<Vec<_>>(),
                sorted.iter().map(|d| &d.name).collect::<Vec<_>>()
            );
        }
    }
}
