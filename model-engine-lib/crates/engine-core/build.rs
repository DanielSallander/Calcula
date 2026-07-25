//! Build script that generates a function catalog from `docs/functions/**/*.md`
//! (one category subfolder per function group).
//!
//! Each markdown file must follow this structure:
//!
//! ```markdown
//! # FUNCTION_NAME
//!
//! One-line description.
//!
//! ## Syntax
//!
//! ```
//! FUNCTION_NAME(args...)
//! ```
//! ```
//!
//! The build script extracts the function name, description (first non-empty
//! line after the title), and syntax (the longest call variant among the code
//! lines in the `## Syntax` section — docs list the bare form first and the
//! fullest form, e.g. with optional context operations, after it). It writes
//! a generated Rust file that is `include!`-ed by the `catalog` module.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    let docs_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../docs/functions");

    // Re-run if any function doc changes
    println!("cargo:rerun-if-changed={}", docs_dir.display());

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let out_file = out_dir.join("function_catalog_generated.rs");

    if let Err(e) = fs::read_dir(&docs_dir) {
        eprintln!(
            "Warning: could not read function docs at {}: {e}",
            docs_dir.display()
        );
        // Write an empty catalog so the build doesn't fail
        fs::write(&out_file, "static CATALOG: &[FunctionInfo] = &[];").unwrap();
        return;
    }

    let mut functions: Vec<(String, String, String)> = Vec::new();
    collect_function_docs(&docs_dir, &mut functions);

    // Sort alphabetically for deterministic output
    functions.sort_by(|a, b| a.0.cmp(&b.0));

    // Generate Rust source
    let mut code = String::new();
    code.push_str("static CATALOG: &[FunctionInfo] = &[\n");

    for (name, description, signature) in &functions {
        code.push_str("    FunctionInfo {\n");
        code.push_str(&format!("        name: {:?},\n", name));
        code.push_str(&format!("        description: {:?},\n", description));
        code.push_str(&format!("        signature: {:?},\n", signature));
        code.push_str("    },\n");
    }

    code.push_str("];\n");

    fs::write(&out_file, code).unwrap();
}

/// Recursively parse every function doc under `dir`. The docs live in one
/// category subfolder per function group; README.md files are indexes, not
/// function docs.
fn collect_function_docs(dir: &Path, functions: &mut Vec<(String, String, String)>) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();

        if path.is_dir() {
            // Watch the subfolder so added/removed docs retrigger the build.
            println!("cargo:rerun-if-changed={}", path.display());
            collect_function_docs(&path, functions);
            continue;
        }

        let name = path.file_name().unwrap().to_string_lossy().to_string();

        // Skip non-md files and README.md
        if !name.ends_with(".md") || name == "README.md" {
            continue;
        }

        // Re-run if this specific file changes
        println!("cargo:rerun-if-changed={}", path.display());

        if let Some(info) = parse_function_doc(&path) {
            functions.push(info);
        }
    }
}

/// Parse a function doc markdown file, returning (name, description, signature).
fn parse_function_doc(path: &Path) -> Option<(String, String, String)> {
    let content = fs::read_to_string(path).ok()?;
    let lines: Vec<&str> = content.lines().collect();

    if lines.is_empty() {
        return None;
    }

    // Extract function name from "# NAME"
    let first_line = lines[0].trim();
    let name = first_line.strip_prefix("# ")?.trim().to_string();

    // Extract description: first non-empty line after the title
    let mut description = String::new();
    for line in &lines[1..] {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with("##") {
            break;
        }
        description = trimmed.to_string();
        break;
    }

    // Extract syntax: docs may list several call variants inside the Syntax
    // section — as multiple lines in one code block (e.g. `SUM(table[column])`
    // then `SUM(table[column], context_op1, ...)`) and/or as several code
    // blocks (alias forms). Each non-empty code line is one variant; the
    // longest variant is the fullest signature, which is what intellisense
    // should advertise.
    let mut signature = String::new();
    let mut in_syntax_section = false;
    let mut in_code_block = false;
    let mut variants: Vec<String> = Vec::new();

    for line in &lines {
        let trimmed = line.trim();

        if trimmed == "## Syntax" {
            in_syntax_section = true;
            continue;
        }

        if in_syntax_section {
            // Stop at the next section
            if trimmed.starts_with("## ") && trimmed != "## Syntax" {
                break;
            }

            if trimmed.starts_with("```") {
                in_code_block = !in_code_block;
                continue;
            }

            if in_code_block && !trimmed.is_empty() {
                // Collapse internal whitespace
                variants.push(trimmed.split_whitespace().collect::<Vec<&str>>().join(" "));
            }
        }
    }

    if let Some(fullest) = variants.iter().max_by_key(|v| v.len()) {
        signature = fullest.clone();
    }

    // Fallback: if no syntax found, use "NAME()"
    if signature.is_empty() {
        signature = format!("{name}()");
    }

    Some((name, description, signature))
}
