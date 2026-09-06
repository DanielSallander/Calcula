//! FILENAME: app/src-tauri/src/calp_environments_tests.rs
//! PURPOSE: The environment commands' load-bearing SHAPES — what they refuse,
//! in what order, and what they must never construct.
//! CONTEXT: These are source-placement guards for the reason
//! `refresh_resolution_tests.rs` is: what regresses here is the arrangement of
//! a command that needs a `tauri::Window` and eight `State` handles to call.
//! The arithmetic half is behavioural and lives in `core/calp/src/environments.rs`
//! (22 tests) and `refresh.rs` (8), where a `LocalWorkspace` and a `TempDir` are
//! all it takes.
//!
//! Every guard below names the one-line sabotage that must make it red.

fn body_of(src: &str, signature: &str) -> String {
    let start = src
        .find(signature)
        .unwrap_or_else(|| panic!("signature not found: {}", signature));
    let rest = &src[start..];
    let end = rest.find("\n}\n").unwrap_or(rest.len());
    rest[..end]
        .lines()
        .map(|line| match line.find("//") {
            Some(i) => line[..i].to_string(),
            None => line.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

const ENV_SRC: &str = include_str!("calp_environments.rs");
const CALP_SRC: &str = include_str!("calp_commands.rs");
const GATEWAY_SRC: &str = include_str!("scripting/distribution_gateway.rs");

fn at(hay: &str, needle: &str, what: &str) -> usize {
    hay.find(needle)
        .unwrap_or_else(|| panic!("{} is gone (looked for `{}`)", what, needle))
}

// ---------------------------------------------------------------------------
// A. What the workspace-mutating commands are, and are not
// ---------------------------------------------------------------------------

/// Promotion writes to the WORKSPACE, not to the document, so it constructs no
/// `DocumentEffect` at all — not `mutates` (there is no saved state to dirty)
/// and not `deliberately_clean` either, which is a decision about a write to
/// persisted state that HAPPENS. `calp_set_co_publishers` is the precedent.
///
/// SABOTAGE: add a `deliberately_clean` to either body. The close-without-saving
/// prompt then reasons about a command that touched no document.
#[test]
fn the_workspace_mutators_construct_no_document_effect() {
    for name in ["pub fn calp_set_environments(", "pub fn calp_promote("] {
        let body = body_of(ENV_SRC, name);
        assert!(
            !body.contains("DocumentEffect::"),
            "{name} constructs a DocumentEffect; it writes to the workspace, not the document"
        );
    }
}

/// ...and the one that DOES edit the document dirties AFTER the last refusal.
///
/// `mutates` dirties at construction, so a refusal past it arms the
/// close-without-saving prompt for a command that wrote nothing.
///
/// SABOTAGE: hoist the effect above `resolve_target`.
#[test]
fn the_subscription_switch_verifies_before_it_dirties() {
    let body = body_of(ENV_SRC, "pub fn calp_set_subscription_environment(");
    let resolve = at(&body, "resolve_target(", "the target resolution");
    let effect = at(&body, "DocumentEffect::mutates(", "the effect");
    assert!(
        resolve < effect,
        "the target must resolve before the document is dirtied: a switch to an \
         environment that does not exist would otherwise be accepted here and \
         refuse every refresh from then on"
    );
    assert_eq!(
        body.matches("DocumentEffect::mutates(").count(),
        1,
        "exactly one arm"
    );
}

/// A promotion never mints a publisher identity.
///
/// A profile's keypair is that user's identity for every application they
/// publish and for reviewing writeback; creating one as a side effect of
/// pressing Promote would mint an identity nobody asked for — and the promotion
/// would be signed by a key no application authorises anyway.
///
/// SABOTAGE: `load_or_create`.
#[test]
fn a_promotion_never_mints_a_publisher_key() {
    assert!(
        ENV_SRC.contains("PublisherKeypair::load_existing"),
        "the identity must be loaded, never created"
    );
    // COMMENTS STRIPPED. The module header explains the rule and names the
    // function it forbids, so a scanner that reads prose finds the phrase in
    // the explanation and reports the correct file as broken — which is what
    // the first cut of this test did.
    let code: String = ENV_SRC
        .lines()
        .map(|l| match l.find("//") {
            Some(i) => &l[..i],
            None => l,
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        !code.contains("load_or_create"),
        "a promotion must not create a publisher keypair"
    );
}

/// The two mutators are MAIN-window only; the reader may also serve the
/// Inspector, whose whole job is answering "what is in this application and who
/// put it there".
///
/// SABOTAGE: widen either mutator's guard.
#[test]
fn only_the_reader_is_reachable_from_the_inspector() {
    for name in ["pub fn calp_set_environments(", "pub fn calp_promote("] {
        let body = body_of(ENV_SRC, name);
        assert!(
            body.contains("window_guard::MAIN)"),
            "{name} must be main-window only"
        );
        assert!(
            !body.contains("MAIN_AND_APPLICATION_INSPECTOR"),
            "{name} must not be reachable from a read-only window"
        );
    }
    let reader = body_of(ENV_SRC, "pub fn calp_environments(");
    assert!(reader.contains("MAIN_AND_APPLICATION_INSPECTOR"));
}

/// A read-only workspace is refused UP FRONT, so the UI can grey the action
/// with a reason rather than offering a button that always fails at the write.
///
/// SABOTAGE: delete either `workspace_is_writable` check.
#[test]
fn an_http_workspace_refuses_promotion_before_it_opens_anything() {
    for name in ["pub fn calp_set_environments(", "pub fn calp_promote("] {
        let body = body_of(ENV_SRC, name);
        let check = at(&body, "workspace_is_writable(", "the writability check");
        let open = at(&body, "open_workspace_scoped(", "the workspace open");
        assert!(check < open, "{name} must refuse a read-only workspace first");
    }
}
/// A writeback application CAN be promoted, and the promoter is told what it
/// does to data already collected.
///
/// This test replaces the M2 INTERLOCK, which refused promotion outright:
/// submissions were filed under `{version}/submissions/` with no environment of
/// their own, so promoting prod onto a version testers had been filling in
/// turned their dummy answers into production data, in every prod subscriber's
/// GATHER total and in the publisher's dashboard, indistinguishable from the
/// real thing. M5 tags every submission at submit and filters every reader, so
/// the refusal has nothing left to protect against.
///
/// What must NOT come back is the silence. A promotion is a version change for
/// everyone in that environment, so it inherits every rule a version change has
/// for collected data — and the promoter, who is the one deciding, has to see
/// it before clicking rather than reading it later on somebody else's screen.
///
/// SABOTAGE: delete the `describe_writeback_change` call from `calp_promote`,
/// or re-introduce the refusal.
#[test]
fn promoting_a_writeback_application_reports_what_it_costs() {
    let body = body_of(ENV_SRC, "pub fn calp_promote(");
    assert!(
        body.contains("describe_writeback_change("),
        "calp_promote must report what the promotion does to collected data",
    );
    // The refusal is gone from the code path. The constant survives only in
    // the comment that explains why it was removed, so the check is scoped to
    // the function body rather than the file.
    let refusal = ["CALP_PROMOTE", "WRITEBACK", "UNTAGGED"].join("_");
    assert!(
        !body.contains(&refusal),
        "the M2 interlock must not still refuse promotion",
    );
    // And the report is computed from the SIGNED manifests of both versions,
    // not from whatever the caller passed in.
    let helper = body_of(ENV_SRC, "fn describe_writeback_change(");
    assert!(helper.contains("get_version_manifest("));
    assert!(helper.contains("check_region_compatibility("));
}

// ---------------------------------------------------------------------------
// B. Subscribe names its target, and says so before it writes
// ---------------------------------------------------------------------------

/// All three subscribe refusals precede the document effect.
///
/// SABOTAGE: move `DocumentEffect::mutates` above any of them, or delete one.
#[test]
fn calp_pull_settles_its_target_before_it_dirties() {
    let body = body_of(CALP_SRC, "pub fn calp_pull(");
    let effect = at(&body, "DocumentEffect::mutates(", "the effect");
    for code in [
        "CALP_PULL_TARGET_AMBIGUOUS",
        "CALP_PULL_ENVIRONMENT_REQUIRED",
        "CALP_PULL_ALREADY_SUBSCRIBED",
    ] {
        let refusal = at(&body, code, code);
        assert!(refusal < effect, "{code} must refuse before the document is dirtied");
    }
}

/// Following the development line on an application that HAS environments is a
/// deliberate choice, never a default.
///
/// It is the whole footgun: the line receives every push the moment it lands, so
/// a consumer who lands there by omission finds out when a half-finished report
/// reaches them.
///
/// SABOTAGE: drop the `follow_line` condition, so an omitted environment
/// silently means "the line".
#[test]
fn following_the_line_requires_saying_so() {
    let body = body_of(CALP_SRC, "pub fn calp_pull(");
    assert!(
        body.contains("if !params.follow_line"),
        "the line must be an explicit choice on an application with environments"
    );
    // ...and the refusal names what is on offer, so the user can act on it.
    assert!(body.contains("envs.last()"), "the refusal must suggest an environment");
}

/// The apply refuses while any subscription follows an environment that no
/// longer resolves — the same door the dialog blocks, locked a second time for
/// callers that are not the dialog.
///
/// SABOTAGE: delete the block, and a refresh silently skips the stranded
/// subscription while reporting success.
#[test]
fn the_apply_refuses_to_leave_a_stranded_subscription_behind() {
    let body = body_of(CALP_SRC, "pub fn calp_refresh_apply(");
    let gate = at(&body, "CALP_REFRESH_ENVIRONMENT_UNAVAILABLE", "the stranded gate");
    let effect = at(&body, "DocumentEffect::mutates(", "the effect");
    assert!(gate < effect, "the gate must precede the effect");
    // Dev subscriptions have no workspace and must not be walked into it.
    assert!(body.contains("is_dev_subscription(sub)"));
}

/// The merged preview carries both new vectors, or the dialog cannot render a
/// notice or block on a stranded row.
///
/// SABOTAGE: drop either `extend`.
#[test]
fn the_merged_preview_carries_the_notices_and_the_unavailable_rows() {
    let body = body_of(CALP_SRC, "pub fn calp_refresh_preview(");
    assert!(body.contains("merged.environment_notices.extend("));
    assert!(body.contains("merged.unavailable.extend("));
}

// ---------------------------------------------------------------------------
// C. The environment is a PARAMETER, never a prefix
// ---------------------------------------------------------------------------

/// `env:prod` inside a pin string would recreate the `channel:` trap exactly: a
/// magic prefix every parser must special-case. `VersionPin::parse` refuses it,
/// and `calp_inspect_application` takes a separate parameter.
///
/// SABOTAGE: delete the prefix refusal in `version.rs`, or make
/// `calp_inspect_application` sniff the pin for a prefix.
#[test]
fn an_environment_is_never_encoded_into_a_pin() {
    const VERSION_SRC: &str = include_str!("../../../core/calp/src/version.rs");
    // ANCHORED INSIDE `impl VersionPin`. `SemVer::parse` has the same signature
    // and comes first in the file, so a bare search for `pub fn parse(` reads
    // the wrong function — and passes or fails for reasons that have nothing to
    // do with pins.
    let impl_at = at(VERSION_SRC, "impl VersionPin", "the VersionPin impl");
    let parse = body_of(&VERSION_SRC[impl_at..], "pub fn parse(s: &str)");
    // Assembled, so this test does not match itself.
    let needle = format!("{}env{}", '"', ':');
    assert!(
        parse.contains(&needle),
        "VersionPin::parse must refuse an environment-shaped prefix by name"
    );

    let body = body_of(CALP_SRC, "pub fn calp_inspect_application(");
    assert!(
        body.contains("environment: Option<String>"),
        "the environment is a parameter"
    );
    assert!(body.contains("CALP_INSPECT_TARGET_AMBIGUOUS"));
}

// ---------------------------------------------------------------------------
// D. What a script may and may not do
// ---------------------------------------------------------------------------

/// Promotion, pipeline definition and subscription re-targeting are HUMAN-ONLY.
///
/// A promotion decides what every production subscriber receives next — the same
/// class of trust decision as adding a workspace, which the gateway already
/// refuses. Re-targeting a subscription changes which content this workbook will
/// accept, which is the consent the human gave at subscribe time.
///
/// SABOTAGE: add an `Action` variant for any of them.
#[test]
fn promotion_is_not_script_reachable() {
    let product = GATEWAY_SRC.split("mod tests").next().unwrap();
    for forbidden in [
        "calp_promote(",
        "calp_set_environments(",
        "calp_set_subscription_environment(",
    ] {
        assert!(
            !product.contains(forbidden),
            "the script gateway must not reach {forbidden}"
        );
    }
}

/// ...but a script CAN name an environment when it subscribes, and gets the
/// same "say what you mean" rule the dialog does.
///
/// SABOTAGE: drop `followLine` from the scripted params, and a script
/// subscribing "latest" to an application that grew a pipeline silently starts
/// following unreleased work on every machine that runs it.
#[test]
fn a_script_may_name_an_environment_and_must_name_its_target() {
    let body = body_of(GATEWAY_SRC, "fn scripted_pull_params(");
    assert!(body.contains("\"environment\": environment"));
    assert!(body.contains("\"followLine\": follow_line"));
    assert!(body.contains("\"requirePinned\": true"), "unchanged");
}

// ---------------------------------------------------------------------------
// K. Writeback across environments — the data-correctness half
// ---------------------------------------------------------------------------

const BI_WB_SRC: &str = include_str!("bi/writeback.rs");
const BI_SRC_SRC: &str = include_str!("bi/writeback_source.rs");

/// EVERY READER THAT FEEDS A NUMBER FILTERS BY ENVIRONMENT.
///
/// This is the whole point of M5. A submission is stored under the VERSION it
/// was made against, and an environment is a pointer to a version — so testers
/// filling in test@v1.5.0 and a production audience later promoted onto v1.5.0
/// land in the same tree. Without the filter, the tester's number is inside
/// every prod subscriber's GATHER total and inside the publisher's aggregate,
/// and nothing on any screen distinguishes it. A wrong number that looks right
/// is the most expensive failure this system has.
///
/// The three readers listed here are the ones whose output reaches a FORMULA or
/// a MODEL. The review lookups are deliberately not in this list: a publisher
/// reviewing a submission must be able to find the one they were shown.
///
/// SABOTAGE: delete any single `visible_in(` call named below.
#[test]
fn every_value_feeding_reader_filters_by_environment() {
    // `rebuild_gather_cache`, not its `build_gather_data` dispatcher: the
    // dispatcher returns the cached map, and the cache is where the workspace is
    // actually read.
    let gather = body_of(CALP_SRC, "pub(crate) fn rebuild_gather_cache(");
    // THE ARGUMENT, not just the call. Counting `visible_in(` alone let the
    // regression through that mattered most: both filters were present and
    // correct while the VERSION SET beside them was still the semver rule, so a
    // rollback silently dropped the environment's own submissions from every
    // total. A guard that cannot see which versions are walked is not guarding
    // the thing that broke.
    assert!(
        gather.matches("visible_in(").count() >= 2,
        "GATHER reads the resolved version AND the carried-forward ones; both filter",
    );
    assert_eq!(
        gather.matches("Some(&environment)").count(),
        2,
        "both filters must name the owning subscription's environment",
    );
    assert!(
        gather.contains("carry_forward_versions("),
        "GATHER must carry forward over the environment's HELD versions",
    );
    assert!(
        !gather.contains("older_package_versions("),
        "the strictly-lower-semver rule drops an environment's own submissions after a rollback",
    );

    for (name, src) in [
        ("the model writeback feed", BI_WB_SRC),
        ("the dataset table feed", BI_SRC_SRC),
    ] {
        assert!(
            src.contains("visible_in("),
            "{name} must filter submissions by environment",
        );
        assert!(
            src.contains("sub.environment.clone().unwrap_or_default()"),
            "{name} must take the environment from the subscription that owns it",
        );
    }
}

/// The GRID readers filter too — the dashboard, the exports, the response
/// status and the one-shot lifecycle.
///
/// The lifecycle one is not cosmetic: without it, a one-shot region a person
/// already answered in `test` reads as already-answered in `prod`, so they
/// cannot give the real answer — or the reverse, where a promotion re-arms a
/// question that was supposed to be asked once.
///
/// SABOTAGE: delete the `visible_in(` from `registry_has_own_submission`.
#[test]
fn the_grid_readers_and_the_lifecycle_filter_too() {
    for signature in [
        "fn registry_has_own_submission(",
        "fn load_region_current_submissions(",
        "fn reconcile_writeback_layer_internal(",
    ] {
        let body = body_of(CALP_SRC, signature);
        assert!(
            body.contains("visible_in("),
            "{signature} must filter submissions by environment",
        );
        assert!(
            body.contains("carry_forward_versions("),
            "{signature} must carry forward over the environment's held versions",
        );
        assert!(
            !body.contains("older_package_versions("),
            "{signature} must not use the strictly-lower-semver rule",
        );
    }
}

/// A SUBMISSION IS STAMPED WHERE IT LEAVES THE MACHINE, not where it is drafted.
///
/// Drafts persist in the `.cala`, so a workbook can hold one made before the
/// user switched environments. Stamping at draft time freezes the wrong answer;
/// stamping at the authoritative submit is the only point where the tag is
/// guaranteed to match what the subscription actually follows.
///
/// SABOTAGE: delete the re-stamp from the submit loop. Every submission then
/// carries whatever the draft happened to hold — which, for a draft written
/// before this rule existed, is the empty string: the development line.
#[test]
fn the_authoritative_submit_stamps_the_environment() {
    let submit = body_of(CALP_SRC, "fn submit_region_internal(");
    let stamp = at(&submit, "sub.environment = environment", "the stamp");
    let save = at(&submit, "save_submission(", "the workspace write");
    assert!(stamp < save, "the tag must be applied before the value is written");
}

/// CARRY-FORWARD FOLLOWS THE ENVIRONMENT'S OWN HISTORY, not semver order.
///
/// A rollback makes an environment's current pointer LOWER than a version it
/// ran last week. Under the "strictly older" rule the subscriber's own
/// submissions against that newer version stop counting the moment their
/// environment is rolled back — their numbers vanish from the collection and
/// re-appear if it is rolled forward again.
///
/// SABOTAGE: have `carry_forward_versions` call `older_package_versions`
/// unconditionally.
#[test]
fn carry_forward_uses_the_environments_own_history() {
    let body = body_of(CALP_SRC, "pub(crate) fn carry_forward_versions(");
    assert!(
        body.contains("versions_held_by("),
        "an environment carries forward over what it has actually held",
    );
    assert!(
        body.contains("if environment.is_empty()"),
        "a LINE subscription keeps the semver rule it always had",
    );
    // A log that does not verify carries NOTHING forward. Falling back to the
    // semver rule would quietly mix in versions this environment never ran,
    // which is the defect the tag exists to prevent.
    assert!(body.contains("Err(_) => Vec::new()"));
}

/// The one fold of "which versions has this environment held" lives in core.
///
/// Two readers need the same answer — the rollback picker, which may only offer
/// a version this environment actually ran, and writeback carry-forward, which
/// may only count submissions made against one. A second hand-rolled fold would
/// give them two answers, and the one that drifted would be silently wrong.
///
/// SABOTAGE: re-inline the fold as a closure in `read_environments`.
#[test]
fn held_versions_are_folded_in_exactly_one_place() {
    let read = body_of(ENV_SRC, "fn read_environments(");
    assert!(read.contains("versions_held_by("));
    // The HISTORY rows still destructure the event — that is presentation, and
    // it is the only copy. What must not come back is a second computation of
    // WHICH VERSIONS AN ENVIRONMENT HAS HELD, which is the answer two unrelated
    // features depend on agreeing about.
    let held_closure = read
        .split("let held =")
        .nth(1)
        .expect("the held-versions closure")
        .split("let infos")
        .next()
        .unwrap()
        .to_string();
    assert!(
        !held_closure.contains("PromotionEvent::Promote {"),
        "the app crate must not re-fold the promotion log to answer this",
    );
}

/// THE FOLLOW-LINE GATE FAILS CLOSED.
///
/// `environments(...).unwrap_or_default()` collapsed a tampered log, an
/// unreadable one, and a transport that cannot serve one at all into "this
/// application has no environments" — so a bare-pin subscribe was admitted onto
/// the development line with no refusal and no notice, which is the one outcome
/// the gate exists to prevent. The core module states the rule it broke: "no
/// log" and "a log I could not trust" must not behave alike.
///
/// This was the one confirmed finding with no test at all: the sabotage below
/// ran green against the whole app suite.
///
/// SABOTAGE: `let envs = calp::environments::environments(..).unwrap_or_default();`
#[test]
fn the_follow_line_gate_refuses_when_it_cannot_read_the_pipeline() {
    let body = body_of(CALP_SRC, "pub fn calp_pull(");
    // The gate region: from the follow-line branch to its refusal.
    const START: &str = "if !params.follow_line {";
    let gate = body
        .split(START)
        .nth(1)
        .expect("the follow-line gate is gone")
        .split("SubscriptionTarget::Line(")
        .next()
        .unwrap();

    assert!(
        gate.contains("match calp::environments::environments("),
        "the gate must MATCH on the result so an unreadable pipeline is a refusal",
    );
    assert!(
        !gate.contains("unwrap_or_default"),
        "defaulting the read away is exactly how this gate failed open",
    );
    assert!(
        gate.contains("CALP_PULL_ENVIRONMENT_UNKNOWN"),
        "a pipeline that cannot be read must refuse by name",
    );
    assert!(gate.contains("CALP_PULL_ENVIRONMENT_REQUIRED"));
}
