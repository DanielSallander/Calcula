//! FILENAME: core/calcula-format/src/features/script_authoring.rs
//! PURPOSE: On-disk schema for the workbook's SCRIPT AUTHORING TRANSCRIPT — what
//!          the author asked an AI for, what the model said back, what the
//!          checks found, how the run ended and what the author then decided.
//!          Lives at `files/script_authoring.json` inside the .cala ZIP.
//!
//! CONTEXT: 2026-08-26, from one report: "I saw the diff page (it looked nice),
//!          however it did not change anything ... but I could not see the
//!          reasoning or the results from the chat." The model's account of its
//!          own work was being destroyed at the moment it arrived, and nothing
//!          survived the window closing. This section is the durable half of the
//!          fix; `app/src/api/scriptHost/authoringRun/index.ts` is the live half
//!          and the two are field-for-field the same record.
//!
//! NOTHING HERE EXECUTES ANYTHING.
//! Every field is TEXT the user or the model already produced, plus counters and
//! timestamps. There is no source to mount, no handler name to call, no
//! capability to name, no URL. A hand-edited (or hostile) `script_authoring.json`
//! can at worst make the history panel lie about a run that already happened; it
//! cannot cause anything to run. The `source` of a proposal is deliberately NOT a
//! field: a rejected proposal's code stays inside the capped `reply` text of the
//! attempt that produced it, where it is prose, not a program.
//!
//! WHY IT CANNOT RIDE A .calp PACKAGE
//! Same structural guarantee `scheduled_jobs` relies on: the section lives in
//! `Workbook::user_files`, the publish path excludes that map by policy, and the
//! `calp` crate never reads `Workbook::user_files` at all. Choosing `user_files`
//! over a new typed `Workbook` field is what makes "the prompts you typed are
//! never published to your subscribers" structural rather than a promise. This is
//! the strongest reason of the three: a prompt is the user's own words about
//! their own data ("customers who are behind on payments") and it is exactly the
//! kind of thing nobody expects to travel. `core/calp/src/publish.rs` carries the
//! byte-level test that proves it.
//!
//! WHY IT DECLARES A FEATURE ID BUT TAKES NO FORMAT-VERSION LINK
//! The chain's own test (manifest.rs, "why a feature ever gets a link"): a link
//! exists when an older reader would MISHANDLE the document, not merely lose
//! state. An older reader that drops this section loses a LOG. It is not made to
//! lie: no schedule is silently disarmed, no stale workbook comes back looking
//! calculated, no hidden row comes back visible. The document still says exactly
//! what it said. So there is no `SCRIPT_AUTHORING_MIN_FORMAT_VERSION` constant
//! here — its ABSENCE is the decision made structural, because there is then no
//! symbol for a later edit to reach for on the way to stamping a version that
//! would make every workbook with a transcript unopenable by an older build.
//!
//! The feature id still earns its keep, exactly as `media`'s does: it lets
//! `read_calcula_manifest` answer "does this workbook carry the prompts its
//! author typed?" without materializing the workbook — a privacy question
//! somebody should be able to answer before emailing a `.cala`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::error::FormatError;

/// Path of the section inside the archive's user-files area (the ZIP entry is
/// `files/script_authoring.json`).
pub const SCRIPT_AUTHORING_FILE: &str = "script_authoring.json";

/// Manifest `features` id declared when the section is present.
pub const SCRIPT_AUTHORING_FEATURE: &str = "script_authoring";

/// Schema version of this envelope, independent of the archive's format version.
pub const SCRIPT_AUTHORING_SCHEMA_VERSION: u32 = 1;

/// The id prefix an unsaved AI draft's runs are keyed by, until
/// `adopt_script_authoring_runs` re-keys the bucket onto the saved script's id.
///
/// ONE spelling for the whole tree: the app's authoring-log commands and the
/// save/load filters in the app's persistence.rs all compare against this
/// constant. Draft buckets are SESSION state — the save path filters them out
/// of the serialized copy and the load path drops any arriving from disk (a
/// draft id is minted per process and dies with it, so a persisted draft
/// bucket would be orphaned by construction) — which makes adoption at Save
/// the only way a draft's runs become persistent.
pub const DRAFT_ID_PREFIX: &str = "draft-";

// ---------------------------------------------------------------------------
// The caps. Re-applied HERE, not merely trusted from the renderer.
//
// CLAUDE.md fixes the authority direction Rust -> TypeScript for exactly this
// reason: the renderer can be compromised, and a store that grows without bound
// on a `#[tauri::command]` a compromised webview can call is a denial-of-service
// against the user's own save path. Every number below is the twin of a constant
// exported from `@api/scriptHost/authoringRun`; a drift between the two is
// caught the moment a run round-trips.
// ---------------------------------------------------------------------------

pub const MAX_REPLY_CHARS: usize = 4_000;
pub const MAX_REASONING_CHARS: usize = 2_000;
pub const MAX_INSTRUCTION_CHARS: usize = 2_000;
pub const MAX_RUNS_PER_SCRIPT: usize = 30;
/// The whole record's prose: the summary, every notice, and every reply, note
/// and reasoning buffer TOGETHER. A budget that skipped the summary and the
/// notices was a hole a hostile append walked straight through.
pub const MAX_RUN_CHARS: usize = 12_000;
pub const MAX_LOG_BYTES: usize = 1_048_576;

// EVERY string and EVERY vector on the record is capped — not just the four
// transcript buffers. The measured attack: one append under a fresh `draft-*`
// id (accepted unconditionally, as it must be — a create run predates its
// script) carrying a 100 MB summary passed every clamp, and the byte-budget
// loop then evicted INNOCENT scripts' history trying to pay for it, because a
// single-run bucket is structurally exempt from eviction (`runs.len() > 1`).
//
// The counts below are chosen so ONE fully clamped run has a serialized
// ceiling BELOW `MAX_LOG_BYTES` even when every character is one that
// serde_json escapes to six bytes (U+0001 serializes as a six-byte
// backslash-u escape): that worst case is pinned by
// `a_clamped_run_serializes_below_the_log_cap_even_when_every_char_escapes`,
// which measures rather than trusts this comment. Findings dominate that
// arithmetic — severity + code + message across every attempt — which is why
// `MAX_FINDINGS_PER_ATTEMPT` and `MAX_HOOKS_PER_RUN` are the small ones.

/// Detail strings: each notice, each finding's message, each unexercised hook,
/// and a dry run's error / declined reason.
pub const MAX_DETAIL_CHARS: usize = 500;
/// Metadata strings: ids, enums-carried-as-strings, timestamps, provider and
/// model names, and a finding's severity/code.
pub const MAX_META_CHARS: usize = 200;
/// Attempts kept per run — the EARLIEST, matching the budget's attempt-order
/// philosophy (what was first asked and first wrong is what a reader wants).
pub const MAX_ATTEMPTS_PER_RUN: usize = 16;
pub const MAX_NOTICES_PER_RUN: usize = 50;
pub const MAX_FINDINGS_PER_ATTEMPT: usize = 8;
pub const MAX_HOOKS_PER_RUN: usize = 16;

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/// One finding the validator reported on one attempt.
///
/// `severity` and `code` are the validator's own strings ("error"/"notice", and
/// the stable machine code) carried as `String` rather than a Rust enum ON
/// PURPOSE: this crate must not be the place a new validator code has to be
/// registered before the log can record it. A section that refuses to store a
/// code it has not heard of would drop exactly the finding a reviewer most needs
/// to see.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunFinding {
    pub severity: String,
    pub code: String,
    pub message: String,
}

/// What the sandboxed dry run against a COPY of the workbook found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDryRun {
    pub applicable: bool,
    pub ok: bool,
    pub changed_cells: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declined_reason: Option<String>,
}

/// One round-trip to the model inside one run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunAttempt {
    /// 1-based, the way the log says it.
    pub attempt: u32,
    /// Milliseconds since the run started.
    pub at: i64,
    /// Wall clock for this attempt alone.
    pub duration_ms: i64,
    pub ok: bool,
    /// The model's WHOLE reply, capped. Never just the fenced code.
    pub reply: String,
    /// True length before capping, so an elision is legible as one.
    pub reply_chars: u32,
    /// The prose outside the fence — the model's account of what it did.
    #[serde(default)]
    pub note: String,
    /// Reasoning deltas, capped. Empty for a model that emits none.
    #[serde(default)]
    pub reasoning: String,
    #[serde(default)]
    pub reasoning_chars: u32,
    #[serde(default)]
    pub findings: Vec<RunFinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<RunDryRun>,
}

/// ONE authoring run, start to decision.
///
/// `decision` and `decided_at` are `Option` because a run exists before the
/// author acts: a CREATE run is stored at draft delivery with no decision (and
/// never gains one — being adopted onto the saved script's id at Save is the
/// record that the draft was kept), while an EDIT run is stored only when the
/// author accepts, rejects or saves. The `Option` exists BECAUSE of the create
/// path, not in spite of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthoringRun {
    pub run_id: String,
    /// "create" | "edit".
    pub kind: String,
    /// How the RUN ended: changed | unchanged | stalled | exhausted | failed |
    /// cancelled | refused.
    pub outcome: String,
    /// What the AUTHOR did: accepted | rejected | saved. Absent until they act.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<String>,
    pub started_at: String,
    #[serde(default)]
    pub elapsed_ms: i64,
    /// The author's own words, verbatim and capped only at absurd lengths.
    pub instruction: String,
    #[serde(default)]
    pub object_type: String,
    #[serde(default)]
    pub provider_id: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub tier: String,
    /// The surface the model was shown, as a SIZE rather than as text: recording
    /// ~13 KB of API surface on each of seven rounds is not a log, it is a copy.
    #[serde(default)]
    pub surface_tokens: u32,
    #[serde(default)]
    pub surface_truncated: bool,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub attempts: Vec<RunAttempt>,
    #[serde(default)]
    pub notices: Vec<String>,
    #[serde(default)]
    pub changed_nothing: bool,
    #[serde(default)]
    pub unexercised_hooks: Vec<String>,
    /// Set when anything was elided to fit the caps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elided: Option<bool>,
}

/// Runs by script id — or by a `DRAFT_ID_PREFIX` id while a draft lives in the
/// session; the save path filters draft buckets out, so the ARCHIVE never
/// carries one.
///
/// `BTreeMap`, not `HashMap`: the archive bytes must be deterministic for the
/// same content, which is what keeps a `.cala` diff readable and a re-save from
/// churning for no reason.
pub type ScriptAuthoringLog = BTreeMap<String, Vec<AuthoringRun>>;

/// The `script_authoring.json` envelope.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptAuthoringFile {
    pub schema_version: u32,
    #[serde(default)]
    pub runs: ScriptAuthoringLog,
}

impl ScriptAuthoringFile {
    pub fn new(runs: ScriptAuthoringLog) -> Self {
        ScriptAuthoringFile {
            schema_version: SCRIPT_AUTHORING_SCHEMA_VERSION,
            runs,
        }
    }

    /// Serialize for the archive (pretty, so the section stays reviewable in a
    /// diff — the whole point of a transparency record).
    pub fn to_json_bytes(&self) -> Result<Vec<u8>, FormatError> {
        Ok(serde_json::to_vec_pretty(self)?)
    }

    /// Parse from the archive.
    ///
    /// A future schema version is REFUSED rather than best-effort decoded, for
    /// the same reason `scheduled_jobs` refuses one: a partially understood
    /// record is worse than none. Unlike the scheduler, the consequence is a
    /// missing LOG rather than a missing gate — the load path therefore warns
    /// and continues with an empty log rather than failing the open.
    pub fn from_json_bytes(bytes: &[u8]) -> Result<Self, FormatError> {
        let parsed: ScriptAuthoringFile = serde_json::from_slice(bytes)?;
        if parsed.schema_version > SCRIPT_AUTHORING_SCHEMA_VERSION {
            return Err(FormatError::InvalidFormat(format!(
                "script_authoring.json schema version {} is newer than this build supports ({})",
                parsed.schema_version, SCRIPT_AUTHORING_SCHEMA_VERSION
            )));
        }
        Ok(parsed)
    }
}

/// The same envelope, BORROWING the log, so its size can be measured without
/// cloning the very thing that is too big. Private: it exists only so
/// `log_json_size` measures exactly what `to_json_bytes` writes — a compact
/// measurement against a pretty writer under-reports by roughly a third, which
/// is how a 1.1 MB section slips past a 1 MiB cap.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScriptAuthoringFileRef<'a> {
    schema_version: u32,
    runs: &'a ScriptAuthoringLog,
}

/// Bytes this log will occupy in the archive, measured the way the archive
/// writes them.
pub fn log_json_size(log: &ScriptAuthoringLog) -> usize {
    serde_json::to_vec_pretty(&ScriptAuthoringFileRef {
        schema_version: SCRIPT_AUTHORING_SCHEMA_VERSION,
        runs: log,
    })
    .map(|b| b.len())
    .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// The caps, applied
// ---------------------------------------------------------------------------

/// Keep the head and the tail, and SAY how much went.
///
/// THE RESULT IS NEVER LONGER THAN `max`, and that guarantee is the reason the
/// last line exists rather than being an optimisation. The marker alone is ~35
/// characters, so for any `max` below that the "elided" string comes back LONGER
/// than the cap it was asked to enforce — and the budget loop below calls this
/// with `left = 0` for every attempt past the overflow point, so a seven-attempt
/// record would come out ABOVE a 12,000 cap and grow by another 35 per extra
/// attempt. Below the marker's own width the honest answer is a hard cut.
///
/// Byte-for-byte the twin of `elideMiddle` in
/// `app/src/api/scriptHost/authoringRun/index.ts`, with one deliberate
/// difference: this one counts CHARACTERS (Unicode scalar values) where the
/// TypeScript counts UTF-16 code units. They agree for everything but astral
/// characters, and counting chars is what keeps the slice off a byte boundary
/// mid-codepoint — a panic would be a far worse divergence than an emoji costing
/// one unit instead of two.
pub fn elide_middle(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        return text.to_string();
    }
    let keep = max.saturating_sub(40);
    // `ceil(keep * 0.7)` without floating point: (keep * 7 + 9) / 10.
    let head = (keep * 7 + 9) / 10;
    let tail = keep - head;
    let dropped = chars.len() - head - tail;
    let marked: String = chars[..head]
        .iter()
        .collect::<String>()
        + &format!("\n... ({} characters omitted) ...\n", dropped)
        + &chars[chars.len() - tail..].iter().collect::<String>();
    if marked.chars().count() <= max {
        marked
    } else {
        chars[..max.min(chars.len())].iter().collect()
    }
}

fn char_len(s: &str) -> usize {
    s.chars().count()
}

/// Cap one string in place, marking the run elided only when it actually gave
/// ground. `>` not `>=`: a string exactly at its cap is left byte-identical.
fn clamp_str(s: &mut String, max: usize, elided: &mut bool) {
    if char_len(s) > max {
        *s = elide_middle(s, max);
        *elided = true;
    }
}

fn clamp_opt(s: &mut Option<String>, max: usize, elided: &mut bool) {
    if let Some(v) = s.as_mut() {
        clamp_str(v, max, elided);
    }
}

/// Bring ONE run inside the per-field caps and the overall budget.
///
/// EVERY string and EVERY vector is capped — the metadata, the summary, the
/// notices, the findings, the dry-run reasons and the hook names, not just the
/// transcript buffers — so a clamped run has a serialized ceiling a hostile
/// append cannot exceed. Vectors keep their EARLIEST entries, matching the
/// budget's attempt-order philosophy.
///
/// Per-field first, then the budget, spent headline-first: summary, then the
/// notices, then the attempts in attempt order — the EARLY attempts are the
/// ones a reader wants (what was first asked, what was first wrong), so the
/// tail is what gives ground. A run that ALREADY fits is left byte-identical
/// with `elided` untouched — an off-by-one that marked an honest log `elided`
/// would make the marker meaningless.
pub fn clamp_run(run: &mut AuthoringRun) {
    let mut elided = false;

    // Metadata. A compromised renderer picks these strings as freely as the
    // big ones, so "it is only an id" is not a reason to leave one uncapped.
    clamp_str(&mut run.run_id, MAX_META_CHARS, &mut elided);
    clamp_str(&mut run.kind, MAX_META_CHARS, &mut elided);
    clamp_str(&mut run.outcome, MAX_META_CHARS, &mut elided);
    clamp_opt(&mut run.decision, MAX_META_CHARS, &mut elided);
    clamp_opt(&mut run.decided_at, MAX_META_CHARS, &mut elided);
    clamp_str(&mut run.started_at, MAX_META_CHARS, &mut elided);
    clamp_str(&mut run.object_type, MAX_META_CHARS, &mut elided);
    clamp_str(&mut run.provider_id, MAX_META_CHARS, &mut elided);
    clamp_str(&mut run.model, MAX_META_CHARS, &mut elided);
    clamp_str(&mut run.tier, MAX_META_CHARS, &mut elided);

    clamp_str(&mut run.instruction, MAX_INSTRUCTION_CHARS, &mut elided);
    clamp_str(&mut run.summary, MAX_REPLY_CHARS, &mut elided);

    // Vector bounds, earliest kept.
    if run.attempts.len() > MAX_ATTEMPTS_PER_RUN {
        run.attempts.truncate(MAX_ATTEMPTS_PER_RUN);
        elided = true;
    }
    if run.notices.len() > MAX_NOTICES_PER_RUN {
        run.notices.truncate(MAX_NOTICES_PER_RUN);
        elided = true;
    }
    if run.unexercised_hooks.len() > MAX_HOOKS_PER_RUN {
        run.unexercised_hooks.truncate(MAX_HOOKS_PER_RUN);
        elided = true;
    }

    for n in run.notices.iter_mut() {
        clamp_str(n, MAX_DETAIL_CHARS, &mut elided);
    }
    for h in run.unexercised_hooks.iter_mut() {
        clamp_str(h, MAX_DETAIL_CHARS, &mut elided);
    }

    for a in run.attempts.iter_mut() {
        clamp_str(&mut a.reply, MAX_REPLY_CHARS, &mut elided);
        clamp_str(&mut a.note, MAX_REPLY_CHARS, &mut elided);
        clamp_str(&mut a.reasoning, MAX_REASONING_CHARS, &mut elided);
        if a.findings.len() > MAX_FINDINGS_PER_ATTEMPT {
            a.findings.truncate(MAX_FINDINGS_PER_ATTEMPT);
            elided = true;
        }
        for f in a.findings.iter_mut() {
            clamp_str(&mut f.severity, MAX_META_CHARS, &mut elided);
            clamp_str(&mut f.code, MAX_META_CHARS, &mut elided);
            clamp_str(&mut f.message, MAX_DETAIL_CHARS, &mut elided);
        }
        if let Some(d) = a.dry_run.as_mut() {
            clamp_opt(&mut d.error, MAX_DETAIL_CHARS, &mut elided);
            clamp_opt(&mut d.declined_reason, MAX_DETAIL_CHARS, &mut elided);
        }
    }

    // The overall budget. The summary is capped at MAX_REPLY_CHARS, well under
    // MAX_RUN_CHARS, so the headline always fits and pays first.
    let mut spent = char_len(&run.summary);
    for n in run.notices.iter_mut() {
        let cost = char_len(n);
        if spent + cost <= MAX_RUN_CHARS {
            spent += cost;
            continue;
        }
        let left = MAX_RUN_CHARS.saturating_sub(spent);
        spent = MAX_RUN_CHARS;
        elided = true;
        *n = elide_middle(n, left);
    }
    for a in run.attempts.iter_mut() {
        let cost = char_len(&a.reply) + char_len(&a.note) + char_len(&a.reasoning);
        if spent + cost <= MAX_RUN_CHARS {
            spent += cost;
            continue;
        }
        let left = MAX_RUN_CHARS.saturating_sub(spent);
        spent = MAX_RUN_CHARS;
        elided = true;
        a.reply = elide_middle(&a.reply, left);
        a.note = String::new();
        a.reasoning = String::new();
    }

    if elided {
        run.elided = Some(true);
    }
}

/// Bring the WHOLE log inside the caps.
///
/// Three passes, in this order:
///  1. every run through `clamp_run`;
///  2. per script, drop the OLDEST run that is not index 0 until the script is
///     within `MAX_RUNS_PER_SCRIPT`;
///  3. while the serialized log exceeds `MAX_LOG_BYTES`, drop the oldest
///     non-index-0 run from whichever script currently holds the most.
///
/// INDEX 0 IS NEVER DROPPED, for any script. The first run is the one that says
/// where a script came from — "I asked for X, it proposed Y, I said no" is
/// provenance a later run cannot reconstruct — so recency eviction protects it
/// and stops rather than eating it. A log that cannot shrink further without
/// dropping a first run is left as it is; the alternative is losing the only
/// fact the log exists to carry.
pub fn clamp_log(log: &mut ScriptAuthoringLog) {
    for runs in log.values_mut() {
        for run in runs.iter_mut() {
            clamp_run(run);
        }
        while runs.len() > MAX_RUNS_PER_SCRIPT {
            runs.remove(1);
        }
    }
    log.retain(|_, runs| !runs.is_empty());

    loop {
        // Measured the way the ARCHIVE writes it — pretty, envelope included —
        // and against a BORROWED log, because cloning on every eviction pass
        // turns a bounded sweep into an O(n^2) copy of the thing that is too big.
        if log_json_size(log) <= MAX_LOG_BYTES {
            return;
        }
        // The script currently holding the most droppable runs gives one up.
        // Ties broken by key so the eviction is deterministic.
        let victim = log
            .iter()
            .filter(|(_, runs)| runs.len() > 1)
            .max_by_key(|(k, runs)| (runs.len(), std::cmp::Reverse((*k).clone())))
            .map(|(k, _)| k.clone());
        match victim {
            Some(key) => {
                if let Some(runs) = log.get_mut(&key) {
                    runs.remove(1);
                }
            }
            // Nothing left but protected first runs.
            None => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attempt(n: u32) -> RunAttempt {
        RunAttempt {
            attempt: n,
            at: 100 * n as i64,
            duration_ms: 250,
            ok: n > 1,
            reply: "here is the script\n```js\nexport function setup(c) {}\n```\nit clicks"
                .to_string(),
            reply_chars: 58,
            note: "here is the script it clicks".to_string(),
            reasoning: String::new(),
            reasoning_chars: 0,
            findings: vec![RunFinding {
                severity: "notice".to_string(),
                code: "no-run-target".to_string(),
                message: "nothing can be started on demand".to_string(),
            }],
            dry_run: Some(RunDryRun {
                applicable: true,
                ok: true,
                changed_cells: 3,
                error: None,
                declined_reason: None,
            }),
        }
    }

    fn run(id: &str) -> AuthoringRun {
        AuthoringRun {
            run_id: id.to_string(),
            kind: "edit".to_string(),
            outcome: "unchanged".to_string(),
            decision: Some("rejected".to_string()),
            decided_at: Some("2026-08-26T10:00:05Z".to_string()),
            started_at: "2026-08-26T10:00:00Z".to_string(),
            elapsed_ms: 5_000,
            instruction: "colour the cells red when they are negative".to_string(),
            object_type: "button".to_string(),
            provider_id: "ollama".to_string(),
            model: "qwen3:8b".to_string(),
            tier: "restricted".to_string(),
            surface_tokens: 3_200,
            surface_truncated: false,
            summary: "returned unchanged".to_string(),
            attempts: vec![attempt(1), attempt(2)],
            notices: vec!["declares net.fetch but never calls it".to_string()],
            changed_nothing: true,
            unexercised_hooks: vec!["onClick".to_string()],
            elided: None,
        }
    }

    #[test]
    fn round_trips_through_json() {
        let mut log = ScriptAuthoringLog::new();
        log.insert("obj-1".to_string(), vec![run("r1")]);
        let bytes = ScriptAuthoringFile::new(log).to_json_bytes().unwrap();
        let back = ScriptAuthoringFile::from_json_bytes(&bytes).unwrap();
        assert_eq!(back.schema_version, SCRIPT_AUTHORING_SCHEMA_VERSION);
        assert_eq!(back.runs["obj-1"].len(), 1);
        assert_eq!(back.runs["obj-1"][0].run_id, "r1");
        assert_eq!(back.runs["obj-1"][0].attempts.len(), 2);
        assert_eq!(
            back.runs["obj-1"][0].attempts[0].findings[0].code,
            "no-run-target"
        );
    }

    #[test]
    fn wire_shape_is_camel_case() {
        // The golden rule: the TS mirror in @api/scriptHost/authoringRun uses
        // these names exactly.
        let mut log = ScriptAuthoringLog::new();
        log.insert("obj-1".to_string(), vec![run("r1")]);
        let json =
            String::from_utf8(ScriptAuthoringFile::new(log).to_json_bytes().unwrap()).unwrap();
        for key in [
            "\"runId\"",
            "\"schemaVersion\"",
            "\"startedAt\"",
            "\"elapsedMs\"",
            "\"objectType\"",
            "\"providerId\"",
            "\"surfaceTokens\"",
            "\"surfaceTruncated\"",
            "\"changedNothing\"",
            "\"unexercisedHooks\"",
            "\"durationMs\"",
            "\"replyChars\"",
            "\"reasoningChars\"",
            "\"dryRun\"",
            "\"changedCells\"",
            "\"decidedAt\"",
        ] {
            assert!(json.contains(key), "missing {} in {}", key, json);
        }
        assert!(!json.contains("run_id"), "{}", json);
        assert!(!json.contains("object_type"), "{}", json);
    }

    #[test]
    fn a_newer_schema_is_refused_not_guessed() {
        let raw = br#"{"schemaVersion": 99, "runs": {}}"#;
        assert!(ScriptAuthoringFile::from_json_bytes(raw).is_err());
    }

    #[test]
    fn no_proposal_source_field_exists() {
        // The standing rule: a rejected proposal's code stays inside the capped
        // `reply` text, as prose. A typed `source` field would be a place for a
        // whole script to live at full length, un-capped, in a document section.
        let mut log = ScriptAuthoringLog::new();
        log.insert("obj-1".to_string(), vec![run("r1")]);
        let json =
            String::from_utf8(ScriptAuthoringFile::new(log).to_json_bytes().unwrap()).unwrap();
        assert!(!json.contains("\"source\""), "{}", json);
        assert!(!json.contains("\"proposal\""), "{}", json);
    }

    #[test]
    fn elide_middle_never_exceeds_the_cap() {
        // The measured defect: below the marker's own width the "elided" string
        // came back LONGER than the cap. Walk every small budget, and the big
        // ones too.
        for max in 0..80 {
            let out = elide_middle(&"x".repeat(5_000), max);
            assert!(
                out.chars().count() <= max,
                "cap {} produced {} chars",
                max,
                out.chars().count()
            );
        }
        for max in [100usize, 500, 2_000, 4_000, 12_000] {
            let out = elide_middle(&"y".repeat(50_000), max);
            assert!(out.chars().count() <= max, "cap {}", max);
            assert!(out.contains("characters omitted"), "cap {}", max);
        }
    }

    #[test]
    fn elide_middle_leaves_a_fitting_string_byte_identical() {
        let s = "short enough";
        assert_eq!(elide_middle(s, MAX_REPLY_CHARS), s);
        let exact = "z".repeat(MAX_REPLY_CHARS);
        assert_eq!(elide_middle(&exact, MAX_REPLY_CHARS), exact);
    }

    #[test]
    fn elide_middle_never_splits_a_codepoint() {
        // A byte-slice implementation panics here. Chars do not.
        let s = "é".repeat(5_000);
        for max in [0usize, 1, 7, 39, 41, 100] {
            let out = elide_middle(&s, max);
            assert!(out.chars().count() <= max);
        }
    }

    #[test]
    fn a_run_at_every_cap_exactly_is_not_marked_elided() {
        // The off-by-one guard: `>` not `>=`. A run that already fits must come
        // back byte-identical, or the `elided` marker means nothing.
        let mut r = run("r1");
        r.instruction = "i".repeat(MAX_INSTRUCTION_CHARS);
        r.attempts = vec![RunAttempt {
            reply: "r".repeat(MAX_REPLY_CHARS),
            note: String::new(),
            reasoning: "g".repeat(MAX_REASONING_CHARS),
            ..attempt(1)
        }];
        let before = r.clone();
        clamp_run(&mut r);
        assert_eq!(r, before, "a run exactly at the caps must be untouched");
        assert_eq!(r.elided, None);
    }

    #[test]
    fn the_overall_budget_is_spent_in_attempt_order() {
        let mut r = run("r1");
        r.attempts = (1..=7)
            .map(|n| RunAttempt {
                reply: "r".repeat(3_000),
                note: "n".repeat(2_000),
                reasoning: String::new(),
                ..attempt(n)
            })
            .collect();
        clamp_run(&mut r);
        assert_eq!(r.elided, Some(true));
        let total: usize = r
            .attempts
            .iter()
            .map(|a| char_len(&a.reply) + char_len(&a.note) + char_len(&a.reasoning))
            .sum();
        assert!(total <= MAX_RUN_CHARS, "record was {} chars", total);
        // Attempt 1 keeps everything it had; the tail is what gave ground.
        assert_eq!(char_len(&r.attempts[0].reply), 3_000);
        assert_eq!(char_len(&r.attempts[0].note), 2_000);
        assert_eq!(r.attempts[6].note, "");
    }

    #[test]
    fn recency_eviction_protects_the_first_run() {
        let mut log = ScriptAuthoringLog::new();
        let runs: Vec<AuthoringRun> = (0..40).map(|i| run(&format!("r{}", i))).collect();
        log.insert("obj-1".to_string(), runs);
        clamp_log(&mut log);
        let kept = &log["obj-1"];
        assert_eq!(kept.len(), MAX_RUNS_PER_SCRIPT);
        assert_eq!(kept[0].run_id, "r0", "the first run is never evicted");
        assert_eq!(
            kept[kept.len() - 1].run_id,
            "r39",
            "the most recent run is kept"
        );
    }

    #[test]
    fn the_byte_budget_never_eats_a_first_run() {
        let mut log = ScriptAuthoringLog::new();
        for s in 0..5 {
            let runs: Vec<AuthoringRun> = (0..MAX_RUNS_PER_SCRIPT)
                .map(|i| {
                    let mut r = run(&format!("s{}-r{}", s, i));
                    r.attempts = vec![RunAttempt {
                        reply: "r".repeat(MAX_REPLY_CHARS),
                        note: "n".repeat(MAX_REPLY_CHARS),
                        reasoning: "g".repeat(MAX_REASONING_CHARS),
                        ..attempt(1)
                    }];
                    r
                })
                .collect();
            log.insert(format!("obj-{}", s), runs);
        }
        clamp_log(&mut log);
        let size = log_json_size(&log);
        for s in 0..5 {
            let key = format!("obj-{}", s);
            let runs = &log[&key];
            assert!(!runs.is_empty(), "{} lost every run", key);
            assert_eq!(
                runs[0].run_id,
                format!("s{}-r0", s),
                "{}'s first run was evicted",
                key
            );
        }
        assert!(
            size <= MAX_LOG_BYTES || log.values().all(|r| r.len() == 1),
            "log is {} bytes and still has droppable runs",
            size
        );
    }

    #[test]
    fn clamp_log_terminates_when_only_first_runs_remain() {
        // Five scripts, one enormous run each: nothing is droppable, so the
        // budget loop must give up rather than spin.
        let mut log = ScriptAuthoringLog::new();
        for s in 0..5 {
            let mut r = run(&format!("s{}-r0", s));
            r.attempts = (1..=3)
                .map(|n| RunAttempt {
                    reply: "r".repeat(MAX_REPLY_CHARS),
                    note: "n".repeat(MAX_REPLY_CHARS),
                    reasoning: "g".repeat(MAX_REASONING_CHARS),
                    ..attempt(n)
                })
                .collect();
            log.insert(format!("obj-{}", s), vec![r]);
        }
        clamp_log(&mut log);
        assert_eq!(log.len(), 5);
        for runs in log.values() {
            assert_eq!(runs.len(), 1);
        }
    }

    // -----------------------------------------------------------------------
    // The clamp holes: every field, every vector. (2026-08-27)
    // -----------------------------------------------------------------------

    /// A run with EVERY string oversized and EVERY vector overlong, built from
    /// the given filler character so the same shape serves both the plain and
    /// the worst-case-escaping tests.
    fn hostile_run(fill: char) -> AuthoringRun {
        let big = |n: usize| fill.to_string().repeat(n);
        AuthoringRun {
            run_id: big(10_000),
            kind: big(10_000),
            outcome: big(10_000),
            decision: Some(big(10_000)),
            decided_at: Some(big(10_000)),
            started_at: big(10_000),
            elapsed_ms: i64::MAX,
            instruction: big(100_000),
            object_type: big(10_000),
            provider_id: big(10_000),
            model: big(10_000),
            tier: big(10_000),
            surface_tokens: u32::MAX,
            surface_truncated: true,
            summary: big(3_000_000),
            attempts: (1..=(MAX_ATTEMPTS_PER_RUN as u32 + 20))
                .map(|n| RunAttempt {
                    attempt: n,
                    at: i64::MAX,
                    duration_ms: i64::MAX,
                    ok: false,
                    reply: big(100_000),
                    reply_chars: u32::MAX,
                    note: big(100_000),
                    reasoning: big(100_000),
                    reasoning_chars: u32::MAX,
                    findings: (0..(MAX_FINDINGS_PER_ATTEMPT + 20))
                        .map(|_| RunFinding {
                            severity: big(10_000),
                            code: big(10_000),
                            message: big(10_000),
                        })
                        .collect(),
                    dry_run: Some(RunDryRun {
                        applicable: true,
                        ok: false,
                        changed_cells: u32::MAX,
                        error: Some(big(100_000)),
                        declined_reason: Some(big(100_000)),
                    }),
                })
                .collect(),
            notices: (0..(MAX_NOTICES_PER_RUN + 20)).map(|_| big(100_000)).collect(),
            changed_nothing: false,
            unexercised_hooks: (0..(MAX_HOOKS_PER_RUN + 20)).map(|_| big(100_000)).collect(),
            elided: None,
        }
    }

    #[test]
    fn every_field_of_a_hostile_run_is_capped() {
        // The measured hole: clamp_run capped only instruction/reply/note/
        // reasoning, so a multi-MB summary (or notices, findings, dry-run
        // reasons, metadata, attempt count) passed every clamp and persisted.
        let mut r = hostile_run('x');
        clamp_run(&mut r);

        for (name, s) in [
            ("run_id", &r.run_id),
            ("kind", &r.kind),
            ("outcome", &r.outcome),
            ("started_at", &r.started_at),
            ("object_type", &r.object_type),
            ("provider_id", &r.provider_id),
            ("model", &r.model),
            ("tier", &r.tier),
        ] {
            assert!(char_len(s) <= MAX_META_CHARS, "{} is {} chars", name, char_len(s));
        }
        assert!(char_len(r.decision.as_deref().unwrap()) <= MAX_META_CHARS);
        assert!(char_len(r.decided_at.as_deref().unwrap()) <= MAX_META_CHARS);
        assert!(char_len(&r.instruction) <= MAX_INSTRUCTION_CHARS);
        assert!(char_len(&r.summary) <= MAX_REPLY_CHARS, "summary is {} chars", char_len(&r.summary));

        assert_eq!(r.attempts.len(), MAX_ATTEMPTS_PER_RUN);
        assert_eq!(r.attempts[0].attempt, 1, "the EARLIEST attempts are the ones kept");
        assert_eq!(r.attempts[MAX_ATTEMPTS_PER_RUN - 1].attempt, MAX_ATTEMPTS_PER_RUN as u32);
        assert_eq!(r.notices.len(), MAX_NOTICES_PER_RUN);
        assert_eq!(r.unexercised_hooks.len(), MAX_HOOKS_PER_RUN);

        for n in &r.notices {
            assert!(char_len(n) <= MAX_DETAIL_CHARS);
        }
        for h in &r.unexercised_hooks {
            assert!(char_len(h) <= MAX_DETAIL_CHARS);
        }
        for a in &r.attempts {
            assert!(char_len(&a.reply) <= MAX_REPLY_CHARS);
            assert!(char_len(&a.note) <= MAX_REPLY_CHARS);
            assert!(char_len(&a.reasoning) <= MAX_REASONING_CHARS);
            assert_eq!(a.findings.len(), MAX_FINDINGS_PER_ATTEMPT);
            for f in &a.findings {
                assert!(char_len(&f.severity) <= MAX_META_CHARS);
                assert!(char_len(&f.code) <= MAX_META_CHARS);
                assert!(char_len(&f.message) <= MAX_DETAIL_CHARS);
            }
            let d = a.dry_run.as_ref().unwrap();
            assert!(char_len(d.error.as_deref().unwrap()) <= MAX_DETAIL_CHARS);
            assert!(char_len(d.declined_reason.as_deref().unwrap()) <= MAX_DETAIL_CHARS);
        }
        assert_eq!(r.elided, Some(true));
    }

    #[test]
    fn a_run_at_every_new_cap_exactly_is_not_marked_elided_either() {
        // The identity contract extends to the new caps: summary, notices,
        // hooks, findings and metadata all exactly AT their caps must come
        // back byte-identical, unmarked. (The prose budget: 4,000 summary +
        // 4 x 500 notices + 4,000 reply + 2,000 reasoning = 12,000 exactly.)
        let mut r = run("r1");
        r.run_id = "i".repeat(MAX_META_CHARS);
        r.model = "m".repeat(MAX_META_CHARS);
        r.summary = "s".repeat(MAX_REPLY_CHARS);
        r.notices = (0..4).map(|_| "n".repeat(MAX_DETAIL_CHARS)).collect();
        r.unexercised_hooks = (0..MAX_HOOKS_PER_RUN)
            .map(|_| "h".repeat(MAX_DETAIL_CHARS))
            .collect();
        r.attempts = vec![RunAttempt {
            reply: "r".repeat(MAX_REPLY_CHARS),
            note: String::new(),
            reasoning: "g".repeat(MAX_REASONING_CHARS),
            findings: (0..MAX_FINDINGS_PER_ATTEMPT)
                .map(|_| RunFinding {
                    severity: "notice".to_string(),
                    code: "c".repeat(MAX_META_CHARS),
                    message: "m".repeat(MAX_DETAIL_CHARS),
                })
                .collect(),
            dry_run: Some(RunDryRun {
                applicable: true,
                ok: true,
                changed_cells: 1,
                error: Some("e".repeat(MAX_DETAIL_CHARS)),
                declined_reason: Some("d".repeat(MAX_DETAIL_CHARS)),
            }),
            ..attempt(1)
        }];
        let before = r.clone();
        clamp_run(&mut r);
        assert_eq!(r, before, "a run exactly at the new caps must be untouched");
        assert_eq!(r.elided, None);
    }

    #[test]
    fn summary_and_notices_spend_the_same_budget_as_the_attempts() {
        // 4,000 (summary at its cap) + 4 x 500 (notices at theirs) + 3,000 +
        // 3,000 spends the 12,000 budget exactly, so the THIRD attempt's text
        // arrives with nothing left. A budget that skips the summary and the
        // notices leaves it 3,000 chars instead.
        let mut r = run("r1");
        r.summary = "s".repeat(MAX_REPLY_CHARS);
        r.notices = (0..4).map(|_| "n".repeat(MAX_DETAIL_CHARS)).collect();
        r.attempts = (1..=3)
            .map(|n| RunAttempt {
                reply: "r".repeat(3_000),
                note: String::new(),
                reasoning: String::new(),
                ..attempt(n)
            })
            .collect();
        clamp_run(&mut r);

        assert_eq!(char_len(&r.attempts[0].reply), 3_000);
        assert_eq!(char_len(&r.attempts[1].reply), 3_000);
        assert_eq!(
            r.attempts[2].reply, "",
            "the summary and the notices must pay from the same budget as the attempts"
        );
        let total = char_len(&r.summary)
            + r.notices.iter().map(|n| char_len(n)).sum::<usize>()
            + r.attempts
                .iter()
                .map(|a| char_len(&a.reply) + char_len(&a.note) + char_len(&a.reasoning))
                .sum::<usize>();
        assert!(total <= MAX_RUN_CHARS, "record prose was {} chars", total);
        assert_eq!(r.elided, Some(true));
    }

    #[test]
    fn a_clamped_run_serializes_below_the_log_cap_even_when_every_char_escapes() {
        // U+0001 is what serde_json turns into a six-byte backslash-u escape,
        // and a compromised renderer gets to pick its characters — so the
        // per-run ceiling is only real if it holds at six bytes per char.
        let mut r = hostile_run('\u{1}');
        clamp_run(&mut r);
        let mut log = ScriptAuthoringLog::new();
        log.insert("draft-hostile".to_string(), vec![r]);
        let size = log_json_size(&log);
        println!("worst-case clamped run: {} bytes of a {} cap", size, MAX_LOG_BYTES);
        assert!(
            size < MAX_LOG_BYTES,
            "one fully clamped run serializes at {} bytes, at or over the {} log cap",
            size,
            MAX_LOG_BYTES
        );
    }

    #[test]
    fn one_hostile_append_cannot_evict_an_innocent_scripts_history() {
        // The measured attack end to end: a fresh `draft-*` bucket (any such id
        // is accepted — a create run predates its script) holds ONE run, which
        // the byte loop's `runs.len() > 1` filter structurally exempts from
        // eviction. Before the caps, its unclamped summary/notices put the log
        // multiple MB over budget, the loop evicted the INNOCENT script's runs
        // trying to pay, and still returned over MAX_LOG_BYTES.
        let mut log = ScriptAuthoringLog::new();
        log.insert(
            "obj-innocent".to_string(),
            (0..5).map(|i| run(&format!("r{}", i))).collect(),
        );
        let mut hostile = run("evil");
        hostile.summary = "s".repeat(3_000_000);
        hostile.notices = (0..2_000).map(|_| "n".repeat(10_000)).collect();
        log.insert("draft-evil".to_string(), vec![hostile]);

        clamp_log(&mut log);

        assert_eq!(
            log["obj-innocent"].len(),
            5,
            "the innocent script's history paid for the hostile bucket"
        );
        let size = log_json_size(&log);
        assert!(size <= MAX_LOG_BYTES, "log is {} bytes after clamping", size);
    }
}
