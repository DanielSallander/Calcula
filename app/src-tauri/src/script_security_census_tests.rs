//! FILENAME: app/src-tauri/src/script_security_census_tests.rs
//! PURPOSE: THE SCRIPT-SECURITY CENSUS — every production function that touches
//!          `ScriptState::security_level` or `ScriptState::mcp_access_level` is
//!          classified, so the third writer cannot forget the persist.
//! CONTEXT: The recorded recommendation this makes checkable, and why a note
//!          was not enough. See the module docs below.

//! # The recommendation this replaces
//!
//! The register (§3av) reported `persist_security_config` and did NOT fix it:
//!
//! > The Script Security level and the AI access ceiling live in `ScriptState`
//! > and are mirrored to `script-security.json` by a remembered call. Both
//! > writers call it today, and the whole surface is two commands in one file,
//! > so the ratio of a type change to the risk is wrong. **Recommendation:** if
//! > a third writer is ever added, fold the write into a
//! > `set_security_level(state, level)` helper that does both.
//!
//! Re-checked 2026-08-10: **still two writers, and the trigger has not fired.**
//! `set_script_security_level` and `set_mcp_access_level` both call the persist;
//! `hydrate_security_level` writes both fields and must NOT persist (it is the
//! load path, reading the file INTO state); everything else reads.
//!
//! So the recommendation stands and the code is unchanged. What changed is that
//! the recommendation is no longer a sentence in a document that decays: this
//! census fails on the day a fourth function touches either field, and its
//! failure message is the recommendation.
//!
//! # Why a census and not a call count
//!
//! Asserting "`persist_security_config` has exactly two call sites" would fire
//! for the writer who REMEMBERS the persist and stay silent for the one who
//! forgets — which is the defect. The classification is over the fields, so the
//! forgetful writer is exactly the one it catches: a new function that touches
//! `security_level` is unclassified until somebody says, in writing, whether it
//! writes (and must persist), reads, or loads.
//!
//! # The failure mode is a REVERT, not a corruption
//!
//! Worth keeping next to the check so nobody over-reacts to it: a write that
//! skips the persist leaves the in-memory level correct for the session and
//! reverts to the persisted value on relaunch. The load path already refuses
//! malformed or unrecognised levels, so the reverted value is always a legal
//! one. That is why this is a census and not a type change — but note which
//! direction the revert can go: from a level the user TIGHTENED back to a
//! looser persisted one, silently, at the next launch.

/// The production source of the two fields' one home.
const COMMANDS_SRC: &str = include_str!("scripting/commands.rs");

/// The fields the census is about.
const GUARDED_FIELDS: &[&str] = &["security_level", "mcp_access_level"];

/// How each function that touches a guarded field is classified, and why.
///
/// `persists` is the load-bearing column: a WRITER that does not persist is the
/// defect, and the only writer legitimately in that position is the load path,
/// which is where the persisted value is coming FROM.
struct Classification {
    name: &'static str,
    kind: Kind,
    reason: &'static str,
}

#[derive(PartialEq, Eq, Debug)]
enum Kind {
    /// Writes a guarded field and MUST call `persist_security_config`.
    WriterThatPersists,
    /// Writes a guarded field and must NOT persist.
    LoadPath,
    /// Only reads.
    Reader,
}

const CLASSIFIED: &[Classification] = &[
    Classification {
        name: "set_script_security_level",
        kind: Kind::WriterThatPersists,
        reason: "the Script Security setter. Validates against the closed set (disabled/prompt/enabled), writes the field, persists",
    },
    Classification {
        name: "set_mcp_access_level",
        kind: Kind::WriterThatPersists,
        reason: "the AI access-ceiling setter. Validates against the closed set (read/mutate/script), writes the field, persists",
    },
    Classification {
        name: "hydrate_security_level",
        kind: Kind::LoadPath,
        reason: "reads script-security.json INTO state at startup. It must NOT persist: writing the file back from the value just read is a no-op at best, and at worst rewrites a file the user edited by hand while a field the parser rejected is being defaulted",
    },
    Classification {
        name: "persist_security_config",
        kind: Kind::Reader,
        reason: "the persist itself: reads both fields and writes the config file. It is the thing the writers must call, not a writer",
    },
    Classification {
        name: "get_script_security_level",
        kind: Kind::Reader,
        reason: "the Script Security getter, for the Script Security dialog",
    },
    Classification {
        name: "get_mcp_access_level",
        kind: Kind::Reader,
        reason: "the AI access-ceiling getter, for the AI governance dialog",
    },
    Classification {
        name: "check_mcp_access",
        kind: Kind::Reader,
        reason: "the gate every mutating MCP tool calls: reads both levels and decides whether the tool may run. A gate that WROTE the ceiling would be a tool raising its own permissions",
    },
    Classification {
        name: "check_script_security",
        kind: Kind::Reader,
        reason: "the execution gate every script surface calls: reads the level and, at 'prompt', consults the session grants. It refuses; it never relaxes, and a gate that WROTE the level would be a script raising its own permissions",
    },
    Classification {
        name: "script_execution_status",
        kind: Kind::Reader,
        reason: "reports allowed / disabled / needsApproval to the UI so the consent prompt can be drawn before a run is attempted. Read-only by construction — it answers a question, it does not settle one",
    },
];

/// The source with `#[cfg(test)] mod ... { ... }` blocks removed.
///
/// Test modules construct a `ScriptState` and assign both fields directly —
/// which is correct in a test and would be a false positive here. The same
/// stripping the document-store census does, for the same reason.
fn production_source(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
    let len = lines.len();
    let mut i = 0;
    while i < lines.len() {
        if lines[i].trim() == "#[cfg(test)]" {
            let mut j = i + 1;
            while j < lines.len()
                && (lines[j].trim_start().starts_with("#[") || lines[j].trim_start().starts_with("//"))
            {
                j += 1;
            }
            let is_mod = j < lines.len() && {
                let t = lines[j].trim_start();
                t.starts_with("mod ") || t.starts_with("pub mod ")
            };
            if is_mod {
                let mut k = j;
                while k < lines.len() && lines[k] != "}" {
                    k += 1;
                }
                for line in lines.iter_mut().take((k + 1).min(len)).skip(i) {
                    line.clear();
                }
                i = k + 1;
                continue;
            }
        }
        i += 1;
    }
    lines
}

/// `(name, body)` for every free `fn` in the production source, comments
/// stripped. Free functions only — an `impl` method sits at indentation 4, and
/// accepting those is what let a `Drop` impl's `fn drop` be resolved as the
/// `drop(guard)` every lock release calls (document-store census, lesson 3).
fn free_functions(lines: &[String]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let starts: Vec<(usize, String)> = lines
        .iter()
        .enumerate()
        .filter_map(|(n, l)| fn_name(l).map(|name| (n, name)))
        .collect();
    for (start, name) in starts {
        let end = lines[start + 1..]
            .iter()
            .position(|l| l == "}")
            .map(|off| start + 1 + off)
            .unwrap_or(lines.len() - 1);
        let body = lines[start..=end]
            .iter()
            .filter(|l| !l.trim_start().starts_with("//"))
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        out.push((name, body));
    }
    out
}

/// The name, if `line` opens a free `fn` item at column 0.
fn fn_name(line: &str) -> Option<String> {
    if line.starts_with(' ') || line.starts_with('\t') {
        return None;
    }
    let mut rest = line;
    loop {
        let before = rest;
        for prefix in ["pub(crate) ", "pub(super) ", "pub ", "async ", "const ", "unsafe "] {
            if let Some(stripped) = rest.strip_prefix(prefix) {
                rest = stripped;
            }
        }
        if rest == before {
            break;
        }
    }
    let rest = rest.strip_prefix("fn ")?;
    let name: String = rest
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// Every production function that mentions a guarded field.
fn touchers() -> Vec<(String, String)> {
    let lines = production_source(COMMANDS_SRC);
    free_functions(&lines)
        .into_iter()
        .filter(|(_, body)| GUARDED_FIELDS.iter().any(|f| body.contains(f)))
        .collect()
}

// ---------------------------------------------------------------------------

/// NOBODY TOUCHES THE SECURITY LEVELS WITHOUT A DECISION.
///
/// This is the check the register's recommendation asked for, in the only form
/// that cannot decay: a fourth function reaching either field fails here, and
/// the message says what to do about it.
#[test]
fn every_function_that_touches_the_security_levels_is_classified() {
    let found = touchers();
    assert!(
        found.len() >= 6,
        "only {} production functions were found touching {:?} — the scan is \
         broken, not the crate. (`scripting/commands.rs` holds both setters, \
         both getters, the persist and the load path at minimum.)",
        found.len(),
        GUARDED_FIELDS
    );

    let unclassified: Vec<&str> = found
        .iter()
        .map(|(name, _)| name.as_str())
        .filter(|name| !CLASSIFIED.iter().any(|c| c.name == *name))
        .collect();
    assert!(
        unclassified.is_empty(),
        "these functions touch `ScriptState::security_level` or \
         `mcp_access_level` and nobody has said what they do with it:\n  {}\n\n\
         If the function WRITES either field it must also call \
         `persist_security_config`, or the user's choice silently reverts at the \
         next launch — and the register's standing recommendation applies: with \
         a THIRD writer, fold the write and the persist into one \
         `set_security_level(state, level)` helper rather than adding a third \
         remembered call. If it only reads, classify it as a Reader here with \
         the reason.",
        unclassified.join("\n  ")
    );

    // The list may not outlive its entries either: a stale name reads as a
    // considered decision about code that is gone.
    let stale: Vec<&str> = CLASSIFIED
        .iter()
        .map(|c| c.name)
        .filter(|name| !found.iter().any(|(n, _)| n == name))
        .collect();
    assert!(
        stale.is_empty(),
        "the classification names functions that no longer touch either field \
         (renamed, deleted, or moved out of scripting/commands.rs):\n  {}",
        stale.join("\n  ")
    );
}

/// EVERY WRITER PERSISTS — the property the classification exists to protect.
///
/// Read from comment-stripped bodies, so a commented-out call does not satisfy
/// it. That is the shape a careless deletion actually takes here: the call site
/// carries a comment naming it ("Persist (per-app, not per-workbook) …").
#[test]
fn every_writer_of_the_security_levels_persists_the_choice() {
    let found = touchers();
    for c in CLASSIFIED.iter().filter(|c| c.kind == Kind::WriterThatPersists) {
        let (_, body) = found
            .iter()
            .find(|(n, _)| n == c.name)
            .unwrap_or_else(|| panic!("`{}` no longer touches either field", c.name));
        assert!(
            body.contains("persist_security_config("),
            "`{}` writes a security level and does not persist it. The user's \
             choice would survive until the next launch and then silently \
             revert to the stored one — possibly LOOSENING a level they had \
             tightened.",
            c.name
        );
    }
}

/// THE LOAD PATH MUST NOT PERSIST — the other direction, and it is not
/// symmetric with the writers.
///
/// `hydrate_security_level` reads the file into state. Persisting from there
/// writes back a value that either just came out of the file (a no-op) or was
/// DEFAULTED because the parser rejected what was in it — in which case the
/// persist would overwrite the user's own file with the fallback, destroying the
/// evidence of what they had put there.
#[test]
fn the_load_path_does_not_write_the_config_back() {
    let found = touchers();
    for c in CLASSIFIED.iter().filter(|c| c.kind == Kind::LoadPath) {
        let (_, body) = found
            .iter()
            .find(|(n, _)| n == c.name)
            .unwrap_or_else(|| panic!("`{}` no longer touches either field", c.name));
        assert!(
            !body.contains("persist_security_config("),
            "`{}` is the LOAD path and it now writes the config file back. A \
             field the parser rejected is silently defaulted, so this would \
             overwrite the user's own file with the fallback.",
            c.name
        );
    }
}

/// Every classification carries a reason somebody wrote.
///
/// The bar is a SENTENCE, for the reason `SESSION_SCOPED` learned: a one-word
/// reason ("reads it") reads perfectly and decides nothing.
#[test]
fn every_classification_carries_a_written_reason() {
    for c in CLASSIFIED {
        assert!(
            c.reason.len() > 40,
            "the classification for `{}` ({:?}) is not a reason anybody wrote: \
             {:?}",
            c.name,
            c.kind,
            c.reason
        );
    }
}

/// The scan itself, pinned — the census is only as good as its parse.
#[test]
fn the_scan_reads_free_functions_and_ignores_test_modules() {
    assert_eq!(
        fn_name("pub fn set_script_security_level(").as_deref(),
        Some("set_script_security_level")
    );
    assert_eq!(fn_name("    fn helper(&self) {"), None);
    assert_eq!(fn_name("struct Thing {"), None);

    // A `#[cfg(test)] mod` is blanked out. Without this, the test modules that
    // build a `ScriptState` and assign `security_level` directly would each
    // read as an unclassified writer.
    const PROBE: &str = "\
pub fn real(state: &ScriptState) {
    let _ = state.security_level.lock();
}

#[cfg(test)]
mod tests {
    fn fake(state: &ScriptState) {
        *state.security_level.lock().unwrap() = \"enabled\".to_string();
    }
}
";
    let lines = production_source(PROBE);
    let names: Vec<String> = free_functions(&lines)
        .into_iter()
        .filter(|(_, body)| body.contains("security_level"))
        .map(|(n, _)| n)
        .collect();
    assert_eq!(
        names,
        vec!["real".to_string()],
        "the scan read a test module's assignment as a production writer"
    );
}
