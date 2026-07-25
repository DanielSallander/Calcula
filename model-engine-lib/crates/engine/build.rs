//! Build script that embeds the function reference docs
//! (`docs/functions/**/*.md`, one category subfolder per function group)
//! into the compiled library.
//!
//! It writes a generated Rust file containing one `(name, category, markdown)`
//! tuple per doc file, `include!`-ed by the `function_docs` module. The
//! category is the doc's top-level subfolder name (e.g. "Math Functions").
//! Embedding at compile time means hosts never touch the source tree at
//! runtime (a packaged build has no `docs/` folder), and the reference is
//! always exactly as fresh as the engine build it ships with.
//!
//! The tuples are sorted by category — in the order the categories appear in
//! `docs/functions/README.md`'s index (categories missing from the README
//! sort after the listed ones, alphabetically) — then by function name, so
//! hosts can render grouped sections by walking consecutive category runs.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    let docs_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../docs/functions");

    // Re-run if any function doc is added, removed, or edited.
    println!("cargo:rerun-if-changed={}", docs_dir.display());

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let out_file = out_dir.join("function_docs_generated.rs");

    // (name, category, markdown)
    let mut docs: Vec<(String, String, String)> = Vec::new();

    if fs::read_dir(&docs_dir).is_ok() {
        collect_docs(&docs_dir, None, &mut docs);
    } else {
        eprintln!(
            "Warning: could not read function docs at {}; embedding an empty set",
            docs_dir.display()
        );
    }

    // Sort by category (README index order, unlisted categories last,
    // alphabetically), then by name — deterministic, and render-ready for
    // hosts that group by consecutive category runs.
    let order = readme_category_order(&docs_dir);
    let rank = |cat: &str| order.iter().position(|c| c == cat).unwrap_or(usize::MAX);
    docs.sort_by(|a, b| {
        (rank(&a.1), a.1.as_str(), a.0.as_str()).cmp(&(rank(&b.1), b.1.as_str(), b.0.as_str()))
    });

    let mut code = String::new();
    code.push_str("static FUNCTION_DOCS: &[(&str, &str, &str)] = &[\n");
    for (name, category, markdown) in &docs {
        code.push_str(&format!("    ({name:?}, {category:?}, {markdown:?}),\n"));
    }
    code.push_str("];\n");

    fs::write(&out_file, code).unwrap();
}

/// Recursively collect `(name, category, markdown)` for every function doc
/// under `dir`. The docs live in one category subfolder per function group;
/// the category is the top-level subfolder name (deeper nesting keeps the
/// top-level name; a doc directly at the root falls back to "Other").
/// README.md files are indexes, not function docs.
fn collect_docs(dir: &Path, category: Option<&str>, docs: &mut Vec<(String, String, String)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            // Watch the subfolder so added/removed docs retrigger the build.
            println!("cargo:rerun-if-changed={}", path.display());
            let folder_name = path.file_name().unwrap().to_string_lossy().to_string();
            collect_docs(&path, Some(category.unwrap_or(&folder_name)), docs);
            continue;
        }
        let file_name = path.file_name().unwrap().to_string_lossy().to_string();
        if !file_name.ends_with(".md") || file_name == "README.md" {
            continue;
        }
        println!("cargo:rerun-if-changed={}", path.display());
        let Some(name) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(markdown) = fs::read_to_string(&path) else {
            continue;
        };
        docs.push((
            name.to_string(),
            category.unwrap_or("Other").to_string(),
            markdown,
        ));
    }
}

/// The category display order: the order in which the categories appear in
/// the docs README's index. Category links are the ones whose href is a
/// directory (ends with `/`), which distinguishes them from the per-function
/// links (`... .md`). Returns an empty list when the README is missing, in
/// which case everything sorts alphabetically.
fn readme_category_order(docs_dir: &Path) -> Vec<String> {
    let readme = docs_dir.join("README.md");
    // The dir-level rerun-if-changed only tracks adds/removes; the README's
    // CONTENT drives ordering, so track the file itself too.
    println!("cargo:rerun-if-changed={}", readme.display());
    let Ok(content) = fs::read_to_string(&readme) else {
        return Vec::new();
    };
    let mut order: Vec<String> = Vec::new();
    for line in content.lines() {
        let mut rest = line;
        while let Some(open) = rest.find('[') {
            let after = &rest[open + 1..];
            let Some(close) = after.find("](") else { break };
            let text = &after[..close];
            let tail = &after[close + 2..];
            let Some(end) = tail.find(')') else { break };
            let href = &tail[..end];
            if href.ends_with('/') && !order.iter().any(|c| c == text) {
                order.push(text.to_string());
            }
            rest = &tail[end + 1..];
        }
    }
    order
}
