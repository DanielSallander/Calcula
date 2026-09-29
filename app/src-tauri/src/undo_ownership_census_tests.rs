//! A command commits only the undo transaction IT opened.
//!
//! `UndoStack::begin_transaction` is a no-op while a transaction is open, but
//! `commit_transaction` is not. A command that begins and commits
//! unconditionally, run INSIDE a caller's open step -- a script's `beginBatch`,
//! a command-line run, a gesture -- closes that caller's step at its own commit,
//! and everything the caller writes after it lands in steps of its own. A
//! script's `createNamedStyle` inside a batch split the batch that way (its
//! scratch-cell clear, found live 2026-09-29 by e2e fixall-calp X6), and a
//! scan then found thirty commands carrying the same unconditional pair.
//!
//! They now close through `engine::OwnedTransaction`
//! (`begin_owned_transaction` / `commit_owned` / `cancel_owned`). This census
//! keeps it that way: every production `.begin_transaction(` must be either an
//! owned begin or guarded by `has_open_transaction()` just above it (the older
//! hand-rolled form of the same rule). The frontend caller's door,
//! `begin_transaction_from_caller`, is the one that is MEANT to open or join
//! for somebody else, and is not counted.

use std::path::{Path, PathBuf};

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("read src") {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// The line ranges of `#[cfg(test)] mod name { ... }` blocks (brace-matched).
/// A one-line `#[cfg(test)] mod name;` declaration covers nothing here.
fn test_module_ranges(lines: &[&str]) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if lines[i].trim() == "#[cfg(test)]" {
            // The item the attribute decorates: the next non-attribute line.
            let mut j = i + 1;
            while j < lines.len() && lines[j].trim_start().starts_with("#[") {
                j += 1;
            }
            let item = lines.get(j).map(|l| l.trim()).unwrap_or("");
            let is_inline_mod = (item.starts_with("mod ") || item.starts_with("pub mod ") || item.starts_with("pub(crate) mod "))
                && item.ends_with('{');
            if is_inline_mod {
                let mut depth = 0i32;
                let mut end = lines.len() - 1;
                'scan: for (k, line) in lines.iter().enumerate().skip(j) {
                    for ch in line.chars() {
                        match ch {
                            '{' => depth += 1,
                            '}' => {
                                depth -= 1;
                                if depth == 0 {
                                    end = k;
                                    break 'scan;
                                }
                            }
                            _ => {}
                        }
                    }
                }
                ranges.push((i, end));
                i = end + 1;
                continue;
            }
        }
        i += 1;
    }
    ranges
}

/// Every unguarded bare `.begin_transaction(` in production code of `src`, as
/// 1-based line numbers.
fn unguarded_begins(src: &str) -> Vec<usize> {
    let lines: Vec<&str> = src.lines().collect();
    let tests = test_module_ranges(&lines);
    let mut hits = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let code = line.trim_start();
        if code.starts_with("//") || !line.contains(".begin_transaction(") {
            continue;
        }
        if tests.iter().any(|&(a, b)| i >= a && i <= b) {
            continue;
        }
        let window = &lines[i.saturating_sub(8)..i];
        if window.iter().any(|l| l.contains("has_open_transaction()")) {
            continue;
        }
        hits.push(i + 1);
    }
    hits
}

#[test]
fn the_census_sees_an_unguarded_begin_and_nothing_else() {
    let unguarded = "fn f(s: &mut UndoStack) {\n    s.begin_transaction(\"x\");\n    s.commit_transaction();\n}\n";
    assert_eq!(unguarded_begins(unguarded), vec![2]);

    let guarded = "fn f(s: &mut UndoStack) {\n    let opened = !s.has_open_transaction();\n    if opened {\n        s.begin_transaction(\"x\");\n    }\n}\n";
    assert!(unguarded_begins(guarded).is_empty(), "a has_open_transaction guard satisfies the census");

    let owned = "fn f(s: &mut UndoStack) {\n    let t = s.begin_owned_transaction(\"x\");\n    s.commit_owned(t);\n}\n";
    assert!(unguarded_begins(owned).is_empty(), "an owned begin satisfies the census");

    let caller = "fn f(s: &mut UndoStack) -> bool {\n    s.begin_transaction_from_caller(\"x\")\n}\n";
    assert!(unguarded_begins(caller).is_empty(), "the caller's door is not counted");

    let in_tests = "fn f() {}\n#[cfg(test)]\nmod tests {\n    fn g(s: &mut UndoStack) {\n        s.begin_transaction(\"x\");\n    }\n}\n";
    assert!(unguarded_begins(in_tests).is_empty(), "test modules are not production code");

    let after_tests = format!("{}fn h(s: &mut UndoStack) {{\n    s.begin_transaction(\"y\");\n}}\n", in_tests);
    assert_eq!(unguarded_begins(&after_tests), vec![9], "production code AFTER a test module is still counted");

    let declared = "#[cfg(test)]\nmod tests;\nfn h(s: &mut UndoStack) {\n    s.begin_transaction(\"y\");\n}\n";
    assert_eq!(unguarded_begins(declared), vec![4], "a `mod x;` declaration hides nothing");
}

#[test]
fn every_command_commits_only_the_transaction_it_opened() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    let mut offenders = Vec::new();
    for file in files {
        let rel = file.strip_prefix(&src).unwrap().to_string_lossy().replace('\\', "/");
        if rel.ends_with("tests.rs") {
            continue;
        }
        let text = std::fs::read_to_string(&file).expect("read source");
        for line in unguarded_begins(&text) {
            offenders.push(format!("{rel}:{line}"));
        }
    }
    assert!(
        offenders.is_empty(),
        "begin_transaction with no has_open_transaction() guard: run inside a caller's open step, its \
         commit closes the caller's step early. Use begin_owned_transaction + commit_owned / cancel_owned \
         (engine::OwnedTransaction):\n{}",
        offenders.join("\n")
    );
}
