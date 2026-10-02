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
const GATEWAY_SRC: &str = include_str!("scripting/collaboration_gateway.rs");

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
    let resolve = at(&body, "resolve_target_via(", "the target resolution");
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
    // not from whatever the caller passed in. This comment said so while the
    // helper read the UNSIGNED copy (`get_version_manifest`) and this guard
    // pinned exactly that call -- open-items M4 follow-up (m). The guard now
    // pins the verified reader the code summary uses, and refuses the
    // unverified one; the behaviour is proved by
    // `the_writeback_report_reads_signed_manifests_and_says_when_it_cannot`.
    let helper = body_of(ENV_SRC, "fn describe_writeback_change(");
    assert!(
        helper.contains("open_verified_content(registry_path, package_name, &format!(\"={version}\"), false)"),
        "the writeback report must read each version through the verified reader",
    );
    assert!(
        !helper.contains("get_version_manifest("),
        "the writeback report read the unsigned manifest a share-writer can edit",
    );
    assert!(helper.contains("check_region_compatibility("));
    assert!(
        body.contains("describe_writeback_change(\n            &params.registry_path,"),
        "calp_promote's report must read through the same verified reader, from the workspace it promoted in",
    );
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
/// SABOTAGE: `let envs = calp::environments::environments_via(..).unwrap_or_default();`
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
        gate.contains("match calp::environments::environments_via("),
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

/// EVERY SURFACE ARBITRATES WITH THE SAME RULE.
///
/// The cross-version winner is decided in two commands and again in the BI feed.
/// The first attempt at this compared `(updated_at, id)` as raw STRINGS while
/// `fold::cmp_timestamps` — which `merge_lenient_submissions` and the fold both
/// use — PARSES the RFC3339 value and only falls back to bytes when a parse
/// fails. The two disagree whenever a timestamp's spelling differs:
/// `2026-01-01T10:00:00+02:00` is 08:00Z and therefore OLDER than
/// `2026-01-01T09:00:00Z`, but sorts LATER as a string. Those values arrive from
/// other machines and other builds, so their spelling is not this process's to
/// assume — and a disagreement here is the same defect the arbitration was added
/// to fix, one layer down.
///
/// SABOTAGE: compare `(a.updated_at.as_str(), a.id.as_str())` tuples again.
#[test]
fn cross_version_arbitration_uses_the_crates_own_ordering() {
    for signature in [
        "pub fn calp_set_submission_state(",
        "fn load_region_current_submissions(",
    ] {
        let body = body_of(CALP_SRC, signature);
        assert!(
            body.contains("cmp_timestamps("),
            "{signature} must arbitrate with fold::cmp_timestamps",
        );
        assert!(
            !body.contains("updated_at.as_str()"),
            "{signature} must not compare timestamps as raw strings",
        );
    }
}

/// EVERY SUBSCRIBER-FACING RESOLUTION USES THE **PINNED** ANCHOR.
///
/// `PromotionTrust::Workspace` asks the workspace who may promote; `Pinned` asks
/// the key this machine already agreed to trust for this application. On a
/// share anyone can write to, the first answer is the attacker's: `root_key_of`
/// derives the root from the LOWEST entry of the UNSIGNED manifest listing, so
/// planting a `0.0.1` that names your own key makes every promotion you sign
/// look authorised. TOFU never catches the retarget, because it checks the
/// signature on the version finally pulled and never the pointer that chose it.
///
/// The core test `the_anchor_is_the_pin_not_the_workspaces_own_account` proves
/// the mechanism. This proves the CALL SITES use it — which is the half that
/// actually shipped wrong, and the half a core test cannot see. Every one of
/// these five is a surface a subscriber acts on: what Review promises, what the
/// preview offers, what Apply refuses to strand, what the switch accepts, and
/// what the pull finally fetches. Two of them disagreeing is the
/// two-surfaces-disagree failure this feature has already produced once.
///
/// SABOTAGE: change any one of them back to `resolve_target(` /
/// `resolve_environment(` / `environments(` — the `Workspace`-anchored wrappers.
#[test]
fn every_subscriber_facing_resolution_is_anchored_on_the_pin() {
    let sites: [(&str, &str); 6] = [
        (CALP_SRC, "pub fn calp_pull("),
        (CALP_SRC, "pub fn calp_inspect_application("),
        (CALP_SRC, "pub fn calp_refresh_preview("),
        (CALP_SRC, "pub fn calp_refresh_apply("),
        (CALP_SRC, "pub fn calp_subscription_trust("),
        (ENV_SRC, "pub fn calp_set_subscription_environment("),
    ];
    for (src, signature) in sites {
        let body = body_of(src, signature);
        assert!(
            body.contains("PromotionTrust::Pinned"),
            "{signature} resolves for a subscriber, so it must anchor on this \
             machine's pin, not on the workspace's own account of who may promote",
        );
        assert!(
            !body.contains("PromotionTrust::Workspace"),
            "{signature} must not mix anchors — two answers in one command is \
             worse than the wrong one",
        );
        // The `Workspace`-anchored convenience wrappers, by exact call shape so
        // the `_via` forms beside them do not match.
        for wrapper in ["resolve_target(", "resolve_environment(", "environments::environments("] {
            assert!(
                !body.contains(wrapper),
                "{signature} calls `{wrapper}`, which is anchored on the workspace. \
                 Use the `_via` form with `PromotionTrust::Pinned`.",
            );
        }
    }
}

// ---------------------------------------------------------------------------
// F. The promotion's developer gate (M4 review: promotion signs, so it asks
//    what every developer door asks)
// ---------------------------------------------------------------------------

/// A PROMOTION IS A DEVELOPER DOOR THAT SIGNS. Before a pointer moves, the
/// application's PROVED root is checked against what this computer remembers,
/// the promoter's key must be one that root authorises, and so must the key
/// that signed the version the pointer would move to -- core `promote` finds
/// its root through the unsigned listing and falls back to the head signer,
/// which a planted first version satisfies.
///
/// SABOTAGE (each alone turns one block red): drop the `anchor_root` call from
/// `promotion_gate`; drop its `authority.allows(..)` check; drop its
/// `authorize_signer` call; make `natural_promotion_target` return `Ok(None)`.
#[test]
fn a_promotion_asks_the_anchor_the_promoter_and_the_targets_signer() {
    use crate::calp_signer_trust_tests::{keypair, location, plant_fake_root, workspace_with_planted, PKG};
    use calp::workspace::LocalWorkspace;

    let v = |s: &str| calp::SemVer::parse(s).unwrap();

    // THE TARGET'S SIGNER. Alice defines the pipeline; then Mallory re-signs
    // 1.2.0 (the head). The root is still Alice's.
    let (dir, alice, mallory) = workspace_with_planted(&[]);
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let scope = calp::workspace_scope(&location(&dir)).unwrap();
    calp::environments::set_pipeline(
        &reg,
        PKG,
        &["test".to_string(), "prod".to_string()],
        0,
        &keypair(alice.path()),
        "2026-09-30T00:00:00Z",
    )
    .unwrap();
    crate::calp_signer_trust_tests::resign_as(&reg, "1.2.0", &mallory, "mallory");
    let gate = |profile: &std::path::Path, env: &str, version: Option<&calp::SemVer>| {
        crate::calp_environments::promotion_gate(&reg, &scope, profile, PKG, env, version)
    };
    assert_eq!(gate(alice.path(), "test", Some(&v("1.1.0"))).unwrap(), Some(v("1.1.0")), "a version the root signed");
    assert!(
        matches!(gate(alice.path(), "test", Some(&v("1.2.0"))), Err(calp::CalpError::SignerNotAuthorized { .. })),
        "a version signed by a key the root does not authorise was promotable"
    );
    // ...and with nothing typed, the NATURAL target (the head, for the first
    // environment) is judged -- and returned, so it is what core signs.
    assert!(
        matches!(gate(alice.path(), "test", None), Err(calp::CalpError::SignerNotAuthorized { .. })),
        "the natural target (the head, re-signed by Mallory) escaped the signer check"
    );
    assert!(calp::developer_anchor::list_anchors(alice.path()).unwrap().is_empty(), "a promotion recorded an anchor");

    // THE ANCHOR AND THE PROMOTER. A clean line; this computer remembers Alice.
    let (dir, alice, mallory) = workspace_with_planted(&[]);
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let scope = calp::workspace_scope(&location(&dir)).unwrap();
    let gate = |profile: &std::path::Path, version: &calp::SemVer| {
        crate::calp_environments::promotion_gate(&reg, &scope, profile, PKG, "test", Some(version))
    };
    assert!(crate::calp_commands::anchor_after_push(alice.path(), &reg, &scope, PKG).is_none());
    gate(alice.path(), &v("1.2.0")).expect("the genuine promoter, the genuine version");
    // Mallory plants a root of her own and re-signs the head.
    plant_fake_root(&reg, "0.0.1", &mallory, "mallory");
    crate::calp_signer_trust_tests::resign_as(&reg, "1.2.0", &mallory, "mallory");
    assert!(
        matches!(gate(alice.path(), &v("1.2.0")), Err(calp::CalpError::DeveloperAnchorContradicted { .. })),
        "a root that contradicts what this computer remembers did not refuse the promotion"
    );
    // Forgotten (so no anchor speaks): the planted root does not authorise
    // Alice's key, and the promotion says whom the workspace claims instead.
    calp::developer_anchor::forget_anchor(alice.path(), &scope, PKG).unwrap();
    match gate(alice.path(), &v("1.2.0")) {
        Err(calp::CalpError::NotAuthorizedPublisher { root_holder, .. }) => {
            assert!(root_holder.contains(&calp::signing::key_fingerprint(&mallory.public_key_hex())), "{root_holder}");
        }
        other => panic!("expected NotAuthorizedPublisher, got {other:?}"),
    }
}

/// `calp_promote` asks the gate BEFORE core signs anything, records a refusal at
/// the "promote" door, returns the coded text, and hands core the version the
/// gate JUDGED -- never `None`, which core would re-resolve on its own.
///
/// SABOTAGE: pass `requested` to `calp::environments::promote` instead of
/// `version`; or move the gate below the `promote(` call.
#[test]
fn calp_promote_gates_before_it_signs_and_signs_what_it_gated() {
    let body = body_of(ENV_SRC, "pub fn calp_promote(");
    let gate = at(&body, "promotion_gate(", "the promotion gate");
    let sign = at(&body, "calp::environments::promote(", "core promote");
    assert!(gate < sign, "calp_promote signs before it asks the gate");
    let refusal = &body[gate..sign];
    assert!(refusal.contains("record_signer_refusal(&state, \"promote\""), "a refused promotion leaves no trail");
    assert!(refusal.contains("developer_refusal_text(&refused)"), "the refusal is not coded");
    assert!(refusal.contains("Ok(judged) => judged.or(requested)"), "the judged version is not what core gets");
    let call = &body[sign..];
    let call = &call[..call.find(")\n").unwrap_or(call.len())];
    assert!(call.contains("\n        version,"), "core promote is not handed the judged version: {call}");
    // `you_may_promote` is answered by the same proved root.
    let may = body_of(ENV_SRC, "fn may_promote(");
    assert!(may.contains("root_anchored_publishers("), "you_may_promote is not anchored at the proved root");
    assert!(!may.contains("resolve_authorized_keys("), "you_may_promote still trusts the unsigned listing");
}

// ---------------------------------------------------------------------------
// G. The promotion's CODE summary (plan_M8 S4)
// ---------------------------------------------------------------------------

/// Alice publishes 1.0.0 (the macro `return 1;`, one writeback region) and
/// 1.1.0 (the macro `return 2;`, no region), defines `test` and `prod`, and
/// promotes `test` to 1.0.0. Returns (workspace dir, alice's profile).
fn promotion_code_fixture() -> (tempfile::TempDir, tempfile::TempDir) {
    use crate::calp_signer_trust_tests::{keypair, workbook, PKG};
    use calp::publish::{self, PublishRequest, PushMode};
    use calp::version::SemVer;
    use calp::workspace::LocalWorkspace;

    let dir = tempfile::TempDir::new().unwrap();
    let alice = tempfile::TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();

    let with_macro = |wb: &persistence::Workbook, source: &str| {
        let mut wb = wb.clone();
        wb.scripts = vec![persistence::SavedScript {
            id: "mod-report".to_string(),
            name: "Report".to_string(),
            description: None,
            source: source.to_string(),
            scope: persistence::SavedScriptScope::default(),
            source_package: None,
        }];
        wb
    };
    let publish_as = |wb: &persistence::Workbook,
                      version: SemVer,
                      mode: PushMode,
                      regions: Option<Vec<calp::WritebackRegionDeclaration>>| {
        let request = PublishRequest {
            workbook: wb,
            package_name: PKG.to_string(),
            version,
            kind: "report".to_string(),
            mode,
            change_summary: "a change".to_string(),
            sheet_indices: vec![0],
            now: "2026-10-01T00:00:00Z".to_string(),
            published_by: "author".to_string(),
            writeback_regions: regions,
            model_writebacks: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        publish::publish(&reg, &request, alice.path()).expect("publish failed");
    };

    let base = workbook("v1");
    let region: calp::WritebackRegionDeclaration = serde_json::from_value(serde_json::json!({
        "id": "budget",
        "selector": {
            "sheetId": base.sheets[0].id.to_string(),
            "rowStart": 4, "rowEnd": 6, "colStart": 0, "colEnd": 0
        },
        "schema": { "valueType": "number" },
    }))
    .unwrap();
    publish_as(&with_macro(&base, "return 1;"), SemVer::new(1, 0, 0), PushMode::CreateNew, Some(vec![region]));
    publish_as(
        &with_macro(&base, "return 2;"),
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        None,
    );
    calp::environments::set_pipeline(
        &reg,
        PKG,
        &["test".to_string(), "prod".to_string()],
        0,
        &keypair(alice.path()),
        "2026-10-01T00:00:00Z",
    )
    .unwrap();
    calp::environments::promote(
        &reg,
        PKG,
        "test",
        Some(SemVer::new(1, 0, 0)),
        None,
        &keypair(alice.path()),
        "2026-10-01T00:01:00Z",
    )
    .unwrap();
    (dir, alice)
}

/// The impact names the CODE that changes between the version the environment
/// holds and the target, with what it means for its subscribers -- beside the
/// writeback report, which is unchanged.
///
/// SABOTAGE: have `promotion_impact_core` leave `code_changes` empty.
#[test]
fn promotion_impact_reports_code_between_the_pointer_and_the_target() {
    use crate::calp_signer_trust_tests::{location, PKG};
    use calp::code_summary::{CodeChangeKind, CodeKind, SubscriberConsequence};
    let (dir, _alice) = promotion_code_fixture();
    let impact = crate::calp_environments::promotion_impact_core(&location(&dir), PKG, "test", "1.1.0").unwrap();
    assert_eq!(impact.code_error, None);
    let report = impact
        .code_changes
        .iter()
        .find(|c| c.id == "mod-report")
        .unwrap_or_else(|| panic!("the changed macro is not listed: {:?}", impact.code_changes));
    assert_eq!(report.kind, CodeKind::Macro);
    assert_eq!(report.change, CodeChangeKind::Modified);
    assert_eq!(report.consequence, SubscriberConsequence::AsksApprovalAgain);
    assert_eq!(report.before.as_deref(), Some("return 1;"));
    assert_eq!(report.after.as_deref(), Some("return 2;"));
    assert!(impact.asks_approval_again);
    assert!(
        impact.writeback_report.contains("no longer exist"),
        "the writeback report is still there: {}",
        impact.writeback_report
    );
    // The wire shape: camelCase, and `codeError` is present as null.
    let wire = serde_json::to_value(&impact).unwrap();
    assert!(wire.get("codeError").is_some_and(|v| v.is_null()), "{wire}");
    assert!(wire.get("codeChanges").is_some() && wire.get("asksApprovalAgain").is_some());
}

/// A FIRST promotion has no pointer to compare with: every piece of the
/// target's code is new, and everybody is asked. It used to show nothing.
///
/// SABOTAGE: answer `code_summary(None, ..)` with an empty summary.
#[test]
fn a_first_promotion_lists_the_targets_code() {
    use crate::calp_signer_trust_tests::{location, PKG};
    use calp::code_summary::{CodeChangeKind, SubscriberConsequence};
    let (dir, _alice) = promotion_code_fixture();
    let impact = crate::calp_environments::promotion_impact_core(&location(&dir), PKG, "prod", "1.0.0").unwrap();
    assert_eq!(impact.code_error, None);
    let report = impact.code_changes.iter().find(|c| c.id == "mod-report").expect("the macro is listed");
    assert_eq!(report.change, CodeChangeKind::Added);
    assert_eq!(report.consequence, SubscriberConsequence::AsksApprovalAgain);
    assert!(report.before.is_none());
    assert!(impact.asks_approval_again);
}

/// A target signed by a key the application does not authorise shows NO code
/// -- the promotion would refuse it over its signer -- and says why; the
/// writeback report is still computed.
///
/// SABOTAGE: open the target with `open_verified_content` (code rows appear).
#[test]
fn a_target_signed_by_an_unauthorised_key_shows_no_code_and_says_why() {
    use crate::calp_signer_trust_tests::{keypair, location, resign_as, PKG};
    use calp::workspace::LocalWorkspace;
    let (dir, _alice) = promotion_code_fixture();
    let mallory = tempfile::TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    resign_as(&reg, "1.1.0", &keypair(mallory.path()), "mallory");

    let impact = crate::calp_environments::promotion_impact_core(&location(&dir), PKG, "test", "1.1.0").unwrap();
    assert!(impact.code_changes.is_empty(), "code of an unauthorised version was shown: {:?}", impact.code_changes);
    assert!(!impact.asks_approval_again);
    let error = impact.code_error.expect("the refusal is named, not swallowed");
    assert!(error.contains("not an authorised publisher"), "{error}");
    assert!(error.contains("mallory"), "the refusal names the signer: {error}");
    assert!(error.starts_with("v1.1.0 cannot be shown"), "{error}");
    assert!(impact.writeback_report.contains("no longer exist"), "{}", impact.writeback_report);
}

/// WHERE THE ENVIRONMENT POINTS COULD NOT BE READ: that is said, never folded
/// into "this is a first promotion". Read as one, every piece of the target's
/// code would read "new", approvals already given would not be reused, and code
/// the environment runs today but the target drops would get no "stops
/// running" row -- a read failure that looks like a normal answer.
///
/// SABOTAGE: put back `.ok()` on the `environments(..)` read in
/// `promotion_impact_core`.
#[test]
fn an_unreadable_pointer_is_reported_not_read_as_a_first_promotion() {
    use crate::calp_signer_trust_tests::{location, PKG};
    let (dir, _alice) = promotion_code_fixture();
    // Positive control: the pointer reads, and the change is measured from it.
    let read = crate::calp_environments::promotion_impact_core(&location(&dir), PKG, "test", "1.1.0").unwrap();
    assert_eq!(read.code_error, None);
    assert!(read.code_changes.iter().any(|c| c.change == calp::code_summary::CodeChangeKind::Modified));

    let log = dir.path().join(PKG).join(calp::environments::PROMOTIONS_FILE);
    assert!(log.is_file(), "the fixture's promotion log is not where this test corrupts it: {}", log.display());
    std::fs::write(&log, b"{ this is not a promotion log").unwrap();

    let impact = crate::calp_environments::promotion_impact_core(&location(&dir), PKG, "test", "1.1.0").unwrap();
    assert!(
        impact.code_changes.is_empty(),
        "code was listed against a pointer nobody could read: {:?}",
        impact.code_changes
    );
    assert!(!impact.asks_approval_again);
    let error = impact.code_error.expect("the unreadable pointer is named, not read as 'no version'");
    assert!(error.contains("test"), "the refusal names the environment: {error}");
    assert!(error.contains("cannot be read"), "{error}");
    assert!(
        impact.writeback_report.contains("cannot be read"),
        "the collected-data report must not read as 'nothing affected' either: {:?}",
        impact.writeback_report
    );
}

/// THE WRITEBACK REPORT READS SIGNED MANIFESTS, and a version it cannot read
/// that way is SAID (open-items M4 follow-up (m)).
///
/// The regions and model columns a version collects into are declared in its
/// version manifest, and only the SIGNED reading of that manifest is the
/// publisher's statement. The report used to read the unsigned copy
/// (`get_version_manifest(..).ok()`), so anyone who could write to the share
/// could edit it to say "nothing affected" about a promotion that orphans a
/// region's collected data -- and a manifest that could not be read at all
/// counted as one that declares nothing: "nothing affected", or a removal
/// that never happened. Each case below is a promotion of `test` from 1.0.0
/// (which collects into `budget`) to 1.1.0 (which drops it).
///
/// SABOTAGE: read the manifests unverified again
/// (`open_workspace_scoped(..)` + `get_version_manifest(..)` in
/// `describe_writeback_change`); or swallow a read failure into an empty
/// manifest (`Err(_) => VersionManifest::default()`-style fallbacks).
#[test]
fn the_writeback_report_reads_signed_manifests_and_says_when_it_cannot() {
    use crate::calp_signer_trust_tests::{location, PKG};
    use calp::workspace::LocalWorkspace;
    let impact = |dir: &tempfile::TempDir, env: &str, version: &str| {
        crate::calp_environments::promotion_impact_core(&location(dir), PKG, env, version).unwrap()
    };

    // POSITIVE CONTROL: the signed manifests say `budget` is dropped.
    let (dir, _alice) = promotion_code_fixture();
    let read = impact(&dir, "test", "1.1.0");
    assert!(
        read.writeback_report.contains("no longer exist in v1.1.0") && read.writeback_report.contains("budget"),
        "the untouched fixture must report the dropped region: {:?}",
        read.writeback_report
    );
    // ...and a FIRST promotion reads nothing: there is no collected data in an
    // environment nothing was ever promoted into.
    assert_eq!(impact(&dir, "prod", "1.0.0").writeback_report, "");

    // 1. THE TARGET'S UNSIGNED COPY EDITED to declare `budget` again. Read
    //    unverified, the region "still exists" and the report says nothing is
    //    affected; read signed, the edit breaks the signature and is said.
    {
        let (dir, _alice) = promotion_code_fixture();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        let held = reg.get_version_manifest(PKG, "1.0.0").unwrap();
        assert!(held.writeback_regions.as_ref().is_some_and(|r| !r.is_empty()), "the fixture's 1.0.0 lost its region");
        let mut target = reg.get_version_manifest(PKG, "1.1.0").unwrap();
        target.writeback_regions = held.writeback_regions.clone();
        reg.write_version_manifest(PKG, "1.1.0", &target).unwrap();

        let report = impact(&dir, "test", "1.1.0").writeback_report;
        assert!(!report.is_empty(), "an edited, unsigned manifest made the promotion read as 'nothing affected'");
        assert!(report.contains("is not known"), "{report}");
        assert!(report.contains("v1.1.0 cannot be read"), "the report must name the version it could not read: {report}");
    }

    // 2. THE POINTER'S UNSIGNED COPY EDITED to declare no region. Read
    //    unverified, nothing was ever collected and the report is empty.
    {
        let (dir, _alice) = promotion_code_fixture();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        let mut held = reg.get_version_manifest(PKG, "1.0.0").unwrap();
        held.writeback_regions = None;
        reg.write_version_manifest(PKG, "1.0.0", &held).unwrap();

        let report = impact(&dir, "test", "1.1.0").writeback_report;
        assert!(!report.is_empty(), "an edited pointer manifest made the promotion read as 'nothing affected'");
        assert!(report.contains("is not known"), "{report}");
        assert!(
            report.contains("v1.0.0, the version test holds, cannot be read"),
            "the report must name the held version it could not read: {report}"
        );
    }

    // 3. THE TARGET'S MANIFEST CANNOT BE READ AT ALL. Read as "declares
    //    nothing", the report claimed `budget` no longer exists in a version
    //    nobody read. A 1.2.0 is pushed first so the unreadable 1.1.0 is
    //    neither the first version nor the head: the pipeline's own fold
    //    reads both, and a corrupt one there fails the POINTER read instead,
    //    which is the other test's case.
    {
        let (dir, alice) = promotion_code_fixture();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        crate::calp_signer_trust_tests::push(
            &reg,
            alice.path(),
            &crate::calp_signer_trust_tests::workbook("v3"),
            calp::SemVer::new(1, 2, 0),
            calp::publish::PushMode::Update { expected_base: calp::SemVer::new(1, 1, 0) },
        );
        let manifest = reg.version_dir(PKG, "1.1.0").unwrap().join(calp::integrity::VERSION_MANIFEST_FILE);
        assert!(manifest.is_file(), "the fixture's manifest is not where this test removes it: {}", manifest.display());
        std::fs::write(&manifest, b"{ this is not a version manifest").unwrap();

        let report = impact(&dir, "test", "1.1.0").writeback_report;
        assert!(
            !report.contains("no longer exist"),
            "a version nobody could read was reported as dropping a region: {report}"
        );
        assert!(report.contains("is not known"), "{report}");
        assert!(report.contains("v1.1.0 cannot be read"), "{report}");
    }
}

/// THE WRITEBACK REPORT READS AS ONE VOICE. Both of its consumers end the
/// sentence themselves -- the Promote dialog writes `{impact}. Moving ...` and
/// its receipt writes ` Collected data: {report}.` -- so no sentence the report
/// can be may carry its own closing period (the unreadable-pointer one did, and
/// the dialog showed "..").  Nor may a sentence carry the run of spaces a
/// string literal broken across a line without a `\` puts inside it (the
/// "moved or changed shape" one did: "collected against              them").
///
/// SABOTAGE: put the closing `.` back on the unreadable-pointer sentence in
/// `promotion_impact_core`; or break the region sentence in
/// `describe_writeback_change` across a line without its `\`.
#[test]
fn the_writeback_sentences_leave_the_period_to_their_consumers_and_carry_no_runs_of_spaces() {
    use crate::calp_signer_trust_tests::{location, workbook, PKG};
    use calp::publish::{self, PublishRequest, PushMode};
    use calp::version::SemVer;
    use calp::workspace::LocalWorkspace;
    let impact = |dir: &tempfile::TempDir, env: &str, version: &str| {
        crate::calp_environments::promotion_impact_core(&location(dir), PKG, env, version).unwrap()
    };
    let no_runs_of_spaces = |report: &str| {
        assert!(!report.contains("  "), "the report carries a run of spaces: {report:?}");
    };

    // 1. A REGION THAT MOVED. 1.2.0 declares `budget` on another sheet and
    //    other rows, so what `test` (at 1.0.0) collected there stops counting.
    {
        let (dir, alice) = promotion_code_fixture();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        let moved_wb = workbook("v3");
        let moved: calp::WritebackRegionDeclaration = serde_json::from_value(serde_json::json!({
            "id": "budget",
            "selector": {
                "sheetId": moved_wb.sheets[0].id.to_string(),
                "rowStart": 5, "rowEnd": 7, "colStart": 0, "colEnd": 0
            },
            "schema": { "valueType": "number" },
        }))
        .unwrap();
        let request = PublishRequest {
            workbook: &moved_wb,
            package_name: PKG.to_string(),
            version: SemVer::new(1, 2, 0),
            kind: "report".to_string(),
            mode: PushMode::Update { expected_base: SemVer::new(1, 1, 0) },
            change_summary: "budget moved".to_string(),
            sheet_indices: vec![0],
            now: "2026-10-02T00:00:00Z".to_string(),
            published_by: "author".to_string(),
            writeback_regions: Some(vec![moved]),
            model_writebacks: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        publish::publish(&reg, &request, alice.path()).expect("publish failed");

        let report = impact(&dir, "test", "1.2.0").writeback_report;
        // Positive control: this IS the sentence the run of spaces sat in.
        assert!(
            report.contains("moved or changed shape") && report.contains("budget"),
            "the moved region must be reported: {report:?}"
        );
        assert!(
            report.contains("collected against them stop counting"),
            "the sentence must read as written: {report:?}"
        );
        no_runs_of_spaces(&report);
    }

    // 2. WHERE THE ENVIRONMENT POINTS CANNOT BE READ.
    {
        let (dir, _alice) = promotion_code_fixture();
        let log = dir.path().join(PKG).join(calp::environments::PROMOTIONS_FILE);
        std::fs::write(&log, b"{ this is not a promotion log").unwrap();
        let report = impact(&dir, "test", "1.1.0").writeback_report;
        assert!(report.contains("is not known"), "the unreadable pointer is said: {report:?}");
        assert!(!report.ends_with('.'), "the consumers add the period; the report must not: {report:?}");
        no_runs_of_spaces(&report);
    }

    // 3. A VERSION THAT CANNOT BE READ SIGNED: the same sentence, the same
    //    punctuation as case 2.
    {
        let (dir, _alice) = promotion_code_fixture();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        let mut held = reg.get_version_manifest(PKG, "1.0.0").unwrap();
        held.writeback_regions = None;
        reg.write_version_manifest(PKG, "1.0.0", &held).unwrap();
        let report = impact(&dir, "test", "1.1.0").writeback_report;
        assert!(report.contains("is not known"), "{report:?}");
        assert!(!report.ends_with('.'), "the consumers add the period; the report must not: {report:?}");
        no_runs_of_spaces(&report);
    }
}

/// An unnamed target answers nothing -- and claims nothing about code.
#[test]
fn an_unnamed_target_answers_nothing_about_code() {
    use crate::calp_signer_trust_tests::{location, PKG};
    let (dir, _alice) = promotion_code_fixture();
    let impact = crate::calp_environments::promotion_impact_core(&location(&dir), PKG, "test", "  ").unwrap();
    assert!(impact.writeback_report.is_empty() && impact.code_changes.is_empty());
    assert!(!impact.asks_approval_again && impact.code_error.is_none());
}

/// The impact stays a READER (Inspector-reachable, no `State`, no
/// `DocumentEffect`), reads the TARGET through the authorised reader and the
/// pointer's version through the verified one, both checked per read, and
/// judges button commands by the production list.
///
/// SABOTAGE: swap the target's reader to `open_verified_content(`.
#[test]
fn the_promotion_impact_reads_the_target_authorised_and_stays_a_reader() {
    let command = body_of(ENV_SRC, "pub fn calp_promotion_impact(");
    assert!(command.contains("MAIN_AND_APPLICATION_INSPECTOR"));
    assert!(!command.contains("State<"), "the impact is a read; it takes no State");
    assert!(command.contains("promotion_impact_core("));
    let core = body_of(ENV_SRC, "pub(crate) fn promotion_impact_core(");
    let summary = body_of(ENV_SRC, "fn promotion_code_summary(");
    for (name, body) in [
        ("calp_promotion_impact", &command),
        ("promotion_impact_core", &core),
        ("promotion_code_summary", &summary),
    ] {
        assert!(!body.contains("DocumentEffect::"), "{name} constructs a DocumentEffect; it reads the workspace");
    }
    assert!(
        summary.contains("open_authorized_content(registry_path, package, &format!(\"={to}\")"),
        "the TARGET must be read through the authorised reader"
    );
    assert!(
        summary.contains("open_verified_content(registry_path, package, &format!(\"={version}\")"),
        "the pointer's version is what subscribers already hold: the verified reader"
    );
    assert_eq!(summary.matches("DiffSide::PublishedChecked").count(), 2, "both sides are checked per read");
    assert!(summary.contains("crate::button_cells::DISTRIBUTABLE_BUTTON_COMMANDS"));
    assert!(core.contains("describe_writeback_change("), "the writeback report is still computed");
}

/// Core's code summary MIRRORS the app's own names and ids (core cannot depend
/// on the app). A drift here makes the promotion preview describe code by
/// rules the subscriber's admission no longer applies.
///
/// SABOTAGE: change any mirrored constant in core/calp/src/code_summary.rs.
#[test]
fn the_code_summary_mirrors_the_apps_constants() {
    use calp::code_summary as cs;
    assert_eq!(cs::CUSTOM_FUNCTIONS_LIB_ID, crate::calp_push_scope::CUSTOM_FUNCTIONS_LIB_ID);
    assert_eq!(cs::RESERVED_SCRIPT_PREFIX, crate::scripting::commands::RESERVED_SCRIPT_PREFIX);
    assert_eq!(cs::BUTTON_ACTION_PREFIX, crate::scripting::control_action::BUTTON_ACTION_CONSENT_PREFIX);
    assert_eq!(cs::ON_SELECT_SLOT, crate::controls::ON_SELECT_PROPERTY);
    assert_eq!(cs::MACRO_REF_SLOT, crate::controls::MACRO_REF_PROPERTY);
    assert_eq!(crate::controls::EXECUTABLE_CONTROL_PROPERTIES, &[cs::ON_SELECT_SLOT, cs::MACRO_REF_SLOT]);
    assert_eq!(cs::HELD_CONTROL_CODE_SLOTS, crate::controls::HELD_CODE_PROPERTIES);
    assert_eq!(cs::BUTTON_CELL_TYPE_ID, crate::button_cells::BUTTON_CELL_TYPE_ID);
    assert_eq!(cs::CELL_ACTION_PARAM, crate::button_cells::ACTION_PARAM);
    assert_eq!(cs::CELL_HELD_ACTION_PARAM, crate::button_cells::HELD_ACTION_PARAM);
    let code = "Report();";
    assert_eq!(
        cs::button_action_approval_id(code),
        crate::scripting::control_action::button_action_consent_id(code)
    );
    assert_eq!(
        cs::notebook_cell_approval_id("nb-1", "c1"),
        crate::scripting::notebook_commands::notebook_consent_script_id("nb-1", "c1")
    );
}
