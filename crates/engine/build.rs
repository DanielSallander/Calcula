//! Build script that embeds the function reference docs
//! (`docs/functions/**/*.md`, one category subfolder per function group)
//! into the compiled library.
//!
//! It writes a generated Rust file containing one `(name, markdown)` tuple per
//! doc file, `include!`-ed by the `function_docs` module. Embedding at compile
//! time means hosts never touch the source tree at runtime (a packaged build
//! has no `docs/` folder), and the reference is always exactly as fresh as the
//! engine build it ships with.

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let docs_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../docs/functions");

    // Re-run if any function doc is added, removed, or edited.
    println!("cargo:rerun-if-changed={}", docs_dir.display());

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let out_file = out_dir.join("function_docs_generated.rs");

    let mut docs: Vec<(String, String)> = Vec::new();

    if fs::read_dir(&docs_dir).is_ok() {
        collect_docs(&docs_dir, &mut docs);
    } else {
        eprintln!(
            "Warning: could not read function docs at {}; embedding an empty set",
            docs_dir.display()
        );
    }

    // Sort alphabetically for deterministic output.
    docs.sort_by(|a, b| a.0.cmp(&b.0));

    let mut code = String::new();
    code.push_str("static FUNCTION_DOCS: &[(&str, &str)] = &[\n");
    for (name, markdown) in &docs {
        code.push_str(&format!("    ({name:?}, {markdown:?}),\n"));
    }
    code.push_str("];\n");

    fs::write(&out_file, code).unwrap();
}

/// Recursively collect `(name, markdown)` for every function doc under `dir`.
/// The docs live in one category subfolder per function group; README.md
/// files are indexes, not function docs.
fn collect_docs(dir: &std::path::Path, docs: &mut Vec<(String, String)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            // Watch the subfolder so added/removed docs retrigger the build.
            println!("cargo:rerun-if-changed={}", path.display());
            collect_docs(&path, docs);
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
        docs.push((name.to_string(), markdown));
    }
}
