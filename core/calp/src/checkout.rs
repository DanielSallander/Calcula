//! FILENAME: core/calp/src/checkout.rs
//! PURPOSE: Open a published application version as a WORKING COPY.
//! CONTEXT: The author-side counterpart of `pull()`. A subscriber pulls an
//! application to CONSUME it; a developer checks it out to DEVELOP it. The
//! difference is one field wide (sheet identity) and one policy wide (trust
//! pinning) — everything else, including all three gates and the whole artifact
//! walk, is the same audited code path.

use std::path::{Path, PathBuf};

use crate::developer_anchor::{AnchorGate, AnchorPolicy, AnchoredBy};
use crate::publishers::{AuthorizedSigner, RootAnchoredPublishers};
use crate::error::CalpError;
use crate::integrity::PinPolicy;
use crate::pull::{pull_with_options, PullRequest, PullResult, SheetIdMode};
use crate::workspace_id::WorkspaceScope;
use crate::transport::WorkspaceTransport;
use crate::version::{SemVer, VersionPin};

/// Check out an application version for editing.
///
/// `version` selects a specific version; `None` means the workspace head (the
/// highest published version, which is what a `latest` pin resolves to).
///
/// Two deliberate differences from [`crate::pull::pull`]:
///
/// * **Sheet ids are preserved** ([`SheetIdMode::PreserveApplication`]). This is
///   the whole point: a push from the resulting workbook produces the NEXT
///   version of this application rather than an application that merely shares
///   its name, so subscribers see modified sheets and their overrides survive.
///
/// * **`PinPolicy::VerifyOnly`** — a checkout verifies the signature and
///   reports the trust status, but never creates a TOFU pin. A pin is the
///   subscriber's standing decision to keep accepting updates from one
///   publisher on the refresh loop; a working copy has no refresh loop, so
///   minting one here would file a trust decision the user was never asked to
///   make. (`only_subscribe_and_install_may_create_a_calp_pin` in
///   `tests/lifecycle.rs` holds this line.)
///
/// And one deliberate ADDITION (BUG-0262): **the signer must be an authorised
/// publisher of the application, anchored at its root**
/// ([`crate::publishers::authorize_signer`]). A subscriber is protected by the
/// key it pinned; a working copy has no pin, and it is where the developer's
/// next SIGNED push comes from — so a version planted in the workspace by
/// anyone who can write to it would otherwise be opened silently and
/// re-signed under the developer's key. It FAILS CLOSED: an unsigned or
/// unverifiable first version refuses, it never switches the check off.
///
/// And the root itself must agree with what THIS MACHINE remembers
/// ([`crate::developer_anchor`]): a checkout records the root on first contact
/// and refuses a later one that names a different root, or serves a
/// co-publisher list older than one this machine has already seen. First
/// contact is recorded only once the checkout is ADMITTED: this function is
/// [`prepare_checkout`] followed at once by [`PendingCheckout::admit`], and a
/// door with gates of its own calls the two halves itself with its gates
/// between them, so a checkout that any gate refuses leaves nothing remembered
/// (BUG-0266).
///
/// The returned [`CheckedOut::pulled`] carries `subscription` as `pull()`
/// builds it; the caller MUST discard it for a checkout. A working copy is not
/// a subscriber of its own application — see the role rule in
/// `docs/design/calp-workspace-collaboration.md` §2.3.
pub fn checkout(
    registry: &dyn WorkspaceTransport,
    package_name: &str,
    version: Option<SemVer>,
    now: &str,
    scope: &WorkspaceScope,
    profile_dir: &Path,
) -> Result<CheckedOut, CalpError> {
    prepare_checkout(registry, package_name, version, now, scope, profile_dir)?.admit()
}

/// Every READ and every check of [`checkout`] -- signature, TOFU verify,
/// min_app_version, the artifact walk, who signed it, and whether the root
/// contradicts this machine's memory -- with nothing written anywhere: not the
/// caller's document, not a pin, and not the developer anchor. The caller runs
/// its own gates over [`PendingCheckout::pulled`] and then
/// [`PendingCheckout::admit`]s it, which is the one place a checkout records
/// first contact.
pub fn prepare_checkout(
    registry: &dyn WorkspaceTransport,
    package_name: &str,
    version: Option<SemVer>,
    now: &str,
    scope: &WorkspaceScope,
    profile_dir: &Path,
) -> Result<PendingCheckout, CalpError> {
    let request = PullRequest {
        package_name: package_name.to_string(),
        // ALWAYS the line, never an environment. A working copy is a working
        // copy OF A VERSION — the thing a push declares as its base — and an
        // environment is a pointer that moves under you. Checking out "prod"
        // would produce a link whose base version silently disagreed with the
        // workspace's head the moment somebody promoted.
        target: crate::manifest::SubscriptionTarget::Line(match version {
            Some(v) => VersionPin::Exact(v),
            None => VersionPin::Latest,
        }),
        now: now.to_string(),
    };
    let pulled = pull_with_options(
        registry,
        &request,
        scope,
        profile_dir,
        PinPolicy::VerifyOnly,
        SheetIdMode::PreserveApplication,
    )?;

    // WHO SIGNED IT, against who may publish it. Asked of the key in the
    // manifest the pull VERIFIED and materialized from — never a re-read — and
    // anchored at the root, never at the head or the predecessor (one or two
    // planted versions would vouch for themselves). Nothing has been written
    // to the caller's document yet: `pull_with_options` only reads, and
    // `VerifyOnly` pins nothing, so a refusal here leaves it untouched.
    //
    // THE ROOT ITSELF is checked against what this machine remembers (the
    // developer anchor): a first version planted by a share-writer is PROVED
    // by its own signature just as well as the real one, and only a memory
    // outside the workspace can tell them apart. CHECKED here, never recorded:
    // opening for editing is an act of the user, but only once it is ADMITTED
    // (`PendingCheckout::admit`).
    let anchor = AnchorGate {
        profile_dir,
        scope,
        policy: AnchorPolicy::CheckOnly,
    };
    let (signer, authority) = crate::publishers::authorize_signer_under(
        registry,
        package_name,
        &pulled.resolved_version.to_string(),
        &pulled.publisher_key,
        &pulled.publisher_name,
        &anchor,
    )?;
    Ok(PendingCheckout {
        package_name: package_name.to_string(),
        pulled,
        signer,
        authority,
        scope: scope.clone(),
        profile_dir: profile_dir.to_path_buf(),
    })
}

/// A version that passed every check of a checkout and has not been admitted
/// yet. Its content can be READ -- a door's own gates run over it -- but only
/// [`PendingCheckout::admit`] hands it over, so nothing can materialize a
/// checkout that skipped the step that records this machine's first contact.
pub struct PendingCheckout {
    package_name: String,
    pulled: PullResult,
    signer: AuthorizedSigner,
    /// The authority `signer` was judged against. Admission records THIS root,
    /// never a re-read: a share-writer racing the door's gates must not get a
    /// different first version remembered than the one that was checked.
    authority: RootAnchoredPublishers,
    scope: WorkspaceScope,
    profile_dir: PathBuf,
}

impl PendingCheckout {
    /// The verified content, for the door's own gates.
    pub fn pulled(&self) -> &PullResult {
        &self.pulled
    }

    /// Who signed it, as judged. Its `anchor` is `Matches` or `NotAnchored`
    /// here -- never `FirstContact`, which only admission produces.
    pub fn signer(&self) -> &AuthorizedSigner {
        &self.signer
    }

    /// The checkout is going ahead: every gate of the door passed. Records the
    /// root on first contact -- in the anchor store, never the pin store (a
    /// working copy agreed to receive nothing) -- and hands the content over.
    ///
    /// `anchor_root` asks again under its lock, so a contradicting record made
    /// since `prepare_checkout` refuses here, before anything is written to the
    /// caller's document.
    pub fn admit(self) -> Result<CheckedOut, CalpError> {
        let record = AnchorGate {
            profile_dir: &self.profile_dir,
            scope: &self.scope,
            policy: AnchorPolicy::RecordOnFirstContact { via: AnchoredBy::Checkout },
        };
        let status =
            crate::developer_anchor::anchor_root(&record, &self.package_name, &self.authority)?;
        let mut signer = self.signer;
        signer.anchor = status;
        Ok(CheckedOut { pulled: self.pulled, signer })
    }
}

/// A version opened for editing, and who signed it.
///
/// The signer travels WITH the content rather than being looked up again by
/// the caller, so what the developer is shown is the answer the gate gave for
/// exactly these bytes.
pub struct CheckedOut {
    pub pulled: PullResult,
    /// Proven authorised: the root, or a co-publisher the root lists.
    pub signer: AuthorizedSigner,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::publish::{self, PublishRequest, PushMode};
    use crate::workspace::LocalWorkspace;
    use engine::cell::Cell;
    use persistence::{Sheet, Workbook};
    use tempfile::TempDir;

    fn workbook_with(text: &str) -> Workbook {
        let mut sheet = Sheet::new("Dashboard".to_string());
        sheet
            .cells
            .insert((0, 0), persistence::SavedCell::from_cell(&Cell::new_text(text.to_string())));
        let mut wb = Workbook::default();
        wb.sheets = vec![sheet];
        wb
    }

    fn publish_v1(reg: &LocalWorkspace, prof: &Path, wb: &Workbook) {
        let request = PublishRequest {
            workbook: wb,
            package_name: "sales".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            mode: PushMode::CreateNew,
            change_summary: "first".to_string(),
            sheet_indices: vec![0],
            now: "2026-08-29T00:00:00Z".to_string(),
            published_by: "author".to_string(),
            writeback_regions: None,
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
        publish::publish(reg, &request, prof).unwrap();
    }

    #[test]
    fn checkout_preserves_package_sheet_ids_where_pull_mints_new_ones() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        let wb = workbook_with("hello");
        let package_sheet_id = wb.sheets[0].id;
        publish_v1(&reg, prof.path(), &wb);

        let scope = crate::workspace_id::workspace_scope(dir.path().to_str().unwrap()).unwrap();

        let checked_out =
            checkout(&reg, "sales", None, "2026-08-29T01:00:00Z", &scope, prof.path())
                .unwrap()
                .pulled;
        assert_eq!(checked_out.sheets.len(), 1);
        assert_eq!(
            checked_out.sheets[0].sheet.id, package_sheet_id,
            "a working copy carries the package's sheet identity"
        );
        assert_eq!(checked_out.sheets[0].package_sheet_id, package_sheet_id);
        assert_eq!(checked_out.resolved_version, SemVer::new(1, 0, 0));

        // The subscribe path, by contrast, mints its own. (Same application, same
        // workspace — the ONLY difference is the mode.)
        let pulled = crate::pull::pull(
            &reg,
            &PullRequest {
                package_name: "sales".to_string(),
                target: crate::manifest::SubscriptionTarget::Line(VersionPin::Latest),
                now: "2026-08-29T01:00:00Z".to_string(),
            },
            &scope,
            prof.path(),
            PinPolicy::PinOnFirstUse,
        )
        .unwrap();
        assert_ne!(
            pulled.sheets[0].sheet.id, package_sheet_id,
            "a subscriber's copy must get its own local sheet identity"
        );
    }

    #[test]
    fn checkout_materializes_the_same_content_as_a_pull() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        let wb = workbook_with("some content");
        publish_v1(&reg, prof.path(), &wb);
        let scope = crate::workspace_id::workspace_scope(dir.path().to_str().unwrap()).unwrap();

        let co = checkout(&reg, "sales", None, "2026-08-29T01:00:00Z", &scope, prof.path())
            .unwrap()
            .pulled;
        let cell = co.sheets[0].sheet.cells.get(&(0, 0)).expect("cell materialized");
        assert!(
            matches!(&cell.value, persistence::SavedCellValue::Text(t) if t == "some content"),
            "checkout carries cell content, got {:?}",
            cell.value
        );
    }

    #[test]
    fn checkout_of_a_missing_version_is_an_error_not_a_silent_empty_workbook() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        publish_v1(&reg, prof.path(), &workbook_with("x"));
        let scope = crate::workspace_id::workspace_scope(dir.path().to_str().unwrap()).unwrap();

        let result = checkout(
            &reg,
            "sales",
            Some(SemVer::new(9, 9, 9)),
            "2026-08-29T01:00:00Z",
            &scope,
            prof.path(),
        );
        assert!(result.is_err(), "checkout of an unpublished version must fail loudly");
    }

    // -----------------------------------------------------------------------
    // BUG-0262: who signed the version a developer opens
    // -----------------------------------------------------------------------

    use crate::error::CalpError;
    use crate::publishers::{AuthorizedKey, PublisherList, SignerRole};
    use crate::signing::{key_fingerprint, PublisherKeypair};

    const NOW: &str = "2026-09-29T00:00:00Z";

    fn keypair(prof: &Path) -> PublisherKeypair {
        PublisherKeypair::load_or_create(prof).unwrap()
    }

    fn scope_of(dir: &TempDir) -> WorkspaceScope {
        crate::workspace_id::workspace_scope(dir.path().to_str().unwrap()).unwrap()
    }

    /// Publish `wb` as `sales@version` from the profile in `prof`.
    fn push_version(reg: &LocalWorkspace, prof: &Path, wb: &Workbook, version: SemVer, mode: PushMode) {
        let request = PublishRequest {
            workbook: wb,
            package_name: "sales".to_string(),
            version,
            kind: "report".to_string(),
            mode,
            change_summary: "a change".to_string(),
            sheet_indices: vec![0],
            now: NOW.to_string(),
            published_by: "author".to_string(),
            writeback_regions: None,
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
        publish::publish(reg, &request, prof).expect("publish failed");
    }

    /// Re-sign an existing version as somebody else — what a person who can
    /// write to the share does to plant a version. The result is a
    /// CRYPTOGRAPHICALLY VALID signature by `kp`, so every check that only asks
    /// "does the signature verify?" accepts it.
    fn resign_as(reg: &LocalWorkspace, version: &str, kp: &PublisherKeypair, name: &str) {
        let mut ver = reg.get_version_manifest("sales", version).unwrap();
        ver.publisher_key = kp.public_key_hex();
        ver.publisher_name = name.to_string();
        reg.write_version_manifest("sales", version, &ver).unwrap();
        let dir = reg.version_dir("sales", version).unwrap();
        let bytes = std::fs::read(dir.join(crate::integrity::VERSION_MANIFEST_FILE)).unwrap();
        std::fs::write(dir.join(crate::integrity::VERSION_MANIFEST_SIG_FILE), kp.sign(&bytes))
            .unwrap();
    }

    /// Plant an UNSIGNED `0.0.1` below every real version: a copy of v1.0.0's
    /// manifest with no key and no signature, listed in the (unsigned)
    /// application manifest. It carries no artifacts, and needs none — it is
    /// never opened, only consulted as "the first version".
    fn plant_unsigned_first_version(reg: &LocalWorkspace) {
        let mut ver = reg.get_version_manifest("sales", "1.0.0").unwrap();
        ver.version = "0.0.1".to_string();
        ver.publisher_key = String::new();
        ver.publisher_name = "nobody".to_string();
        reg.write_version_manifest("sales", "0.0.1", &ver).unwrap();
        let mut app = reg.get_application_manifest("sales").unwrap();
        let mut entry = app.versions[0].clone();
        entry.version = "0.0.1".to_string();
        entry.publisher_key = String::new();
        app.versions.insert(0, entry);
        reg.write_application_manifest(&app).unwrap();
    }

    /// `checkout` without `unwrap_err`: `CheckedOut` carries no `Debug` (its
    /// `PullResult` has deep persistence types that have none).
    fn refused(result: Result<CheckedOut, CalpError>) -> CalpError {
        match result {
            Ok(co) => panic!(
                "expected a refusal, but v{} checked out (signed by {})",
                co.pulled.resolved_version, co.signer.name
            ),
            Err(e) => e,
        }
    }

    /// The positive case, and what the dialog is handed: the root signed it.
    #[test]
    fn a_version_the_root_signed_checks_out_and_says_so() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        publish_v1(&reg, prof.path(), &workbook_with("x"));

        let co = checkout(&reg, "sales", None, NOW, &scope_of(&dir), prof.path()).unwrap();
        let me = keypair(prof.path()).public_key_hex();
        assert_eq!(co.signer.key, me, "the signer is the key in the verified manifest");
        assert_eq!(co.signer.role, SignerRole::Root);
        assert_eq!(co.signer.root_key, me);
        assert_eq!(co.pulled.publisher_key, me, "the pull reports who signed what it read");
    }

    /// A co-publisher the root lists is authorised, and named by the ROOT's
    /// word for them rather than only by their own manifest.
    #[test]
    fn a_listed_co_publishers_version_checks_out_as_a_co_publisher() {
        let dir = TempDir::new().unwrap();
        let alice = TempDir::new().unwrap();
        let bob = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        let wb = workbook_with("v1");
        publish_v1(&reg, alice.path(), &wb);

        let alice_kp = keypair(alice.path());
        let bob_key = keypair(bob.path()).public_key_hex();
        let mut list = PublisherList::new("sales", &alice_kp.public_key_hex(), NOW);
        list.authorized_keys.push(AuthorizedKey {
            key: bob_key.clone(),
            name: "Bob".to_string(),
            added_at: NOW.to_string(),
        });
        crate::publishers::write_signed(&reg, &list, &alice_kp).unwrap();
        push_version(
            &reg,
            bob.path(),
            &wb,
            SemVer::new(1, 1, 0),
            PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        );

        // Checked out by a THIRD profile: authorisation is about the signer,
        // not about who is looking.
        let viewer = TempDir::new().unwrap();
        let co = checkout(&reg, "sales", None, NOW, &scope_of(&dir), viewer.path()).unwrap();
        assert_eq!(co.pulled.resolved_version, SemVer::new(1, 1, 0));
        assert_eq!(co.signer.key, bob_key);
        assert_eq!(co.signer.role, SignerRole::CoPublisher);
        assert_eq!(co.signer.listed_as, "Bob");
        assert_eq!(co.signer.root_key, alice_kp.public_key_hex());
    }

    /// THE HOLE. A version signed by a key the application never authorised —
    /// planted by anyone who can write to the share — used to check out
    /// silently: `VerifyOnly` reports `NotPinned` and carries on, and nothing
    /// compared the signer with anyone. With no `publishers.json`, the push
    /// side's own fallback (`resolve_authorized_keys`) takes the HEAD's signer
    /// as authorised, so one planted head vouched for itself; two planted
    /// versions beat a predecessor anchor the same way.
    ///
    /// SABOTAGE: in `publishers::authorize_signer`, drop the
    /// `!authority.allows(signer_key)` refusal (or anchor it at the head).
    #[test]
    fn a_version_signed_by_an_unauthorised_key_is_refused_and_names_the_signer() {
        let dir = TempDir::new().unwrap();
        let alice = TempDir::new().unwrap();
        let mallory = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        let wb = workbook_with("v1");
        publish_v1(&reg, alice.path(), &wb);
        // Two versions after the root, both re-signed by Mallory: the head
        // AND its predecessor now name her.
        push_version(
            &reg,
            alice.path(),
            &wb,
            SemVer::new(1, 1, 0),
            PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        );
        push_version(
            &reg,
            alice.path(),
            &wb,
            SemVer::new(1, 2, 0),
            PushMode::Update { expected_base: SemVer::new(1, 1, 0) },
        );
        let mallory_kp = keypair(mallory.path());
        resign_as(&reg, "1.1.0", &mallory_kp, "mallory");
        resign_as(&reg, "1.2.0", &mallory_kp, "mallory");

        // Precondition: the planted head is a VALID signature, so the checks
        // that existed before would have let it through.
        crate::integrity::load_signed_manifest_via(&reg, "sales", "1.2.0")
            .expect("precondition: the planted version's signature verifies");

        let scope = scope_of(&dir);
        let err = refused(checkout(&reg, "sales", None, NOW, &scope, alice.path()));
        match &err {
            CalpError::SignerNotAuthorized { version, signer_name, signer_fingerprint, .. } => {
                assert_eq!(version, "1.2.0");
                assert_eq!(signer_name, "mallory");
                assert_eq!(signer_fingerprint, &key_fingerprint(&mallory_kp.public_key_hex()));
            }
            other => panic!("expected SignerNotAuthorized, got {other:?}"),
        }
        // The refusal NAMES the signer, by name and key, for a person.
        let msg = err.to_string();
        assert!(msg.contains("mallory"), "{msg}");
        assert!(msg.contains(&key_fingerprint(&mallory_kp.public_key_hex())), "{msg}");

        // The predecessor is refused too — two planted versions do not vouch
        // for each other.
        let err = refused(checkout(
            &reg,
            "sales",
            Some(SemVer::new(1, 1, 0)),
            NOW,
            &scope,
            alice.path(),
        ));
        assert!(matches!(err, CalpError::SignerNotAuthorized { .. }), "got {err:?}");

        // Positive control: the root's own version still opens.
        let co = checkout(&reg, "sales", Some(SemVer::new(1, 0, 0)), NOW, &scope, alice.path())
            .expect("the root's version is authorised");
        assert_eq!(co.signer.role, SignerRole::Root);
    }

    /// FAIL CLOSED on an unsigned first version. `root_key_of` answers "no
    /// root" for one, read with no signature check, and the authorised-key
    /// check turned that into "nothing to enforce" — so planting an UNSIGNED
    /// `0.0.1` (easier than a signed one) switched the check off for every
    /// version above it.
    ///
    /// SABOTAGE: in `root_anchored_publishers`, fall back to the unsigned
    /// `get_version_manifest` read when the first version has no signature.
    #[test]
    fn an_unsigned_first_version_refuses_rather_than_switching_the_check_off() {
        let dir = TempDir::new().unwrap();
        let alice = TempDir::new().unwrap();
        let mallory = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        let wb = workbook_with("v1");
        publish_v1(&reg, alice.path(), &wb);
        push_version(
            &reg,
            alice.path(),
            &wb,
            SemVer::new(1, 1, 0),
            PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        );
        resign_as(&reg, "1.1.0", &keypair(mallory.path()), "mallory");
        plant_unsigned_first_version(&reg);
        assert_eq!(
            crate::publishers::root_key_of(&reg, "sales").unwrap(),
            None,
            "precondition: the old anchor reads the planted version as 'no root'"
        );

        let err = refused(checkout(&reg, "sales", None, NOW, &scope_of(&dir), alice.path()));
        match &err {
            CalpError::ApplicationRootUnverifiable { reason, .. } => {
                assert!(reason.contains("v0.0.1") && reason.contains("not signed"), "{reason}");
            }
            other => panic!("expected ApplicationRootUnverifiable, got {other:?}"),
        }
        // It refuses EVERY version, the genuine one included: without a
        // verifiable anchor there is no way to tell which versions are real.
        let err = refused(checkout(
            &reg,
            "sales",
            Some(SemVer::new(1, 0, 0)),
            NOW,
            &scope_of(&dir),
            alice.path(),
        ));
        assert!(matches!(err, CalpError::ApplicationRootUnverifiable { .. }), "got {err:?}");
    }

    /// A first version whose bytes were changed after signing does not verify
    /// under the key it names, and is not an anchor.
    #[test]
    fn a_first_version_that_does_not_verify_under_its_own_key_refuses() {
        let dir = TempDir::new().unwrap();
        let alice = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        let wb = workbook_with("v1");
        publish_v1(&reg, alice.path(), &wb);
        push_version(
            &reg,
            alice.path(),
            &wb,
            SemVer::new(1, 1, 0),
            PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        );
        // Name a different root in v1.0.0, leaving Alice's signature in place.
        let other = TempDir::new().unwrap();
        let mut root = reg.get_version_manifest("sales", "1.0.0").unwrap();
        root.publisher_key = keypair(other.path()).public_key_hex();
        reg.write_version_manifest("sales", "1.0.0", &root).unwrap();

        let err = refused(checkout(
            &reg,
            "sales",
            Some(SemVer::new(1, 1, 0)),
            NOW,
            &scope_of(&dir),
            alice.path(),
        ));
        match &err {
            CalpError::ApplicationRootUnverifiable { reason, .. } => {
                assert!(reason.contains("does not verify"), "{reason}");
            }
            other => panic!("expected ApplicationRootUnverifiable, got {other:?}"),
        }
    }

    /// A planter cannot authorise themselves with a co-publisher list of their
    /// own: the list must verify under the ROOT, and one that does not is an
    /// error, not "no list".
    #[test]
    fn a_co_publisher_list_the_root_did_not_sign_cannot_authorise_the_planter() {
        let dir = TempDir::new().unwrap();
        let alice = TempDir::new().unwrap();
        let mallory = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        let wb = workbook_with("v1");
        publish_v1(&reg, alice.path(), &wb);
        push_version(
            &reg,
            alice.path(),
            &wb,
            SemVer::new(1, 1, 0),
            PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        );
        let mallory_kp = keypair(mallory.path());
        resign_as(&reg, "1.1.0", &mallory_kp, "mallory");

        // Mallory writes a list naming Alice as root and herself as delegate,
        // signed with HER key (`write_signed` would refuse, so by hand).
        let mut list = PublisherList::new("sales", &keypair(alice.path()).public_key_hex(), NOW);
        list.authorized_keys.push(AuthorizedKey {
            key: mallory_kp.public_key_hex(),
            name: "definitely a colleague".to_string(),
            added_at: NOW.to_string(),
        });
        let bytes = serde_json::to_vec_pretty(&list).unwrap();
        reg.write_application_artifact("sales", crate::publishers::PUBLISHERS_FILE, &bytes)
            .unwrap();
        reg.write_application_artifact(
            "sales",
            crate::publishers::PUBLISHERS_SIG_FILE,
            mallory_kp.sign(&bytes).as_bytes(),
        )
        .unwrap();

        let err = refused(checkout(&reg, "sales", None, NOW, &scope_of(&dir), alice.path()));
        assert!(matches!(err, CalpError::PublisherListInvalid { .. }), "got {err:?}");
    }

    // -----------------------------------------------------------------------
    // The developer anchor: what THIS MACHINE remembers about the root
    // -----------------------------------------------------------------------

    use crate::developer_anchor::{list_anchors, AnchorStatus, AnchoredBy};

    /// Plant a first version `version` BELOW every real one, signed by `kp` --
    /// a copy of v1.0.0's manifest re-keyed and re-signed, listed in the
    /// (unsigned) application manifest. Its signature is VALID for `kp`, so
    /// `root_anchored_publishers` proves it as the root: exactly what a
    /// share-writer can do, and what only a remembered root can refuse.
    fn plant_fake_root(reg: &LocalWorkspace, version: &str, kp: &PublisherKeypair, name: &str) {
        let mut ver = reg.get_version_manifest("sales", "1.0.0").unwrap();
        ver.version = version.to_string();
        reg.write_version_manifest("sales", version, &ver).unwrap();
        resign_as(reg, version, kp, name);
        let mut app = reg.get_application_manifest("sales").unwrap();
        let mut entry = app.versions[0].clone();
        entry.version = version.to_string();
        entry.publisher_key = kp.public_key_hex();
        app.versions.insert(0, entry);
        reg.write_application_manifest(&app).unwrap();
    }

    #[test]
    fn a_checkout_records_the_root_on_first_contact_and_matches_it_next_time() {
        let dir = TempDir::new().unwrap();
        let alice = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        publish_v1(&reg, alice.path(), &workbook_with("x"));
        let viewer = TempDir::new().unwrap();

        let first = checkout(&reg, "sales", None, NOW, &scope_of(&dir), viewer.path()).unwrap();
        match &first.signer.anchor {
            AnchorStatus::FirstContact { recorded } => {
                assert_eq!(recorded.root_key, keypair(alice.path()).public_key_hex());
                assert_eq!(recorded.anchored_by, AnchoredBy::Checkout);
                assert_eq!(recorded.root_version, "1.0.0");
            }
            other => panic!("expected FirstContact, got {other:?}"),
        }
        assert_eq!(list_anchors(viewer.path()).unwrap().len(), 1);

        let second = checkout(&reg, "sales", None, NOW, &scope_of(&dir), viewer.path()).unwrap();
        assert!(
            matches!(second.signer.anchor, AnchorStatus::Matches { .. }),
            "got {:?}",
            second.signer.anchor
        );
        assert_eq!(list_anchors(viewer.path()).unwrap().len(), 1, "a second record was written");
    }

    /// THE PLANTED ROOT. Mallory, who can write to the share, plants a
    /// mallory-signed `0.0.1` below Alice's versions and re-signs the head as
    /// herself. Everything verifies, and the root she planted authorises the head
    /// she signed -- so BUG-0262's check alone lets it through (the fresh-profile
    /// control below proves it). Only a machine that REMEMBERS Alice's root can
    /// refuse, and it names both keys.
    ///
    /// SABOTAGE: core `checkout` passes `AnchorPolicy::CheckOnly` (nothing is
    /// remembered, so the contradiction is never seen).
    #[test]
    fn a_planted_self_signed_first_version_is_refused_by_this_machines_anchor() {
        let dir = TempDir::new().unwrap();
        let alice = TempDir::new().unwrap();
        let mallory = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        let wb = workbook_with("v1");
        publish_v1(&reg, alice.path(), &wb);
        push_version(
            &reg,
            alice.path(),
            &wb,
            SemVer::new(1, 1, 0),
            PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        );
        // Alice's machine opens it once: the anchor is recorded.
        checkout(&reg, "sales", None, NOW, &scope_of(&dir), alice.path()).expect("the genuine checkout");

        let mallory_kp = keypair(mallory.path());
        plant_fake_root(&reg, "0.0.1", &mallory_kp, "mallory");
        resign_as(&reg, "1.1.0", &mallory_kp, "mallory");

        let err = refused(checkout(&reg, "sales", None, NOW, &scope_of(&dir), alice.path()));
        match &err {
            CalpError::DeveloperAnchorContradicted {
                remembered_fingerprint,
                claimed_fingerprint,
                claimed_root_version,
                ..
            } => {
                assert_eq!(remembered_fingerprint, &key_fingerprint(&keypair(alice.path()).public_key_hex()));
                assert_eq!(claimed_fingerprint, &key_fingerprint(&mallory_kp.public_key_hex()));
                assert_eq!(claimed_root_version, "0.0.1");
            }
            other => panic!("expected DeveloperAnchorContradicted, got {other:?}"),
        }

        // POSITIVE CONTROL: a machine that remembers nothing opens it -- the
        // planted root authorises the planted head. It is the anchor that
        // refused above, not the signer check.
        let fresh = TempDir::new().unwrap();
        let co = checkout(&reg, "sales", None, NOW, &scope_of(&dir), fresh.path())
            .expect("first contact with a planted root is trust on first use");
        assert_eq!(co.signer.root_key, mallory_kp.public_key_hex());
    }

    /// THE ROLLED-BACK LIST. Alice lists Bob (revision 1), then removes him
    /// (revision 2), and a checkout on this machine sees revision 2. Mallory
    /// restores revision 1 WITH its still-valid signature and plants a
    /// Bob-signed head. Revision 1 verifies under Alice's root and lists Bob, so
    /// without a remembered mark the head is authorised again.
    ///
    /// SABOTAGE: drop the revision compare in `developer_anchor::anchor_root`.
    #[test]
    fn a_rolled_back_co_publisher_list_is_refused_after_a_newer_one_was_seen() {
        let dir = TempDir::new().unwrap();
        let alice = TempDir::new().unwrap();
        let bob = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        let wb = workbook_with("v1");
        publish_v1(&reg, alice.path(), &wb);
        let alice_kp = keypair(alice.path());
        let bob_kp = keypair(bob.path());

        let mut list = PublisherList::new("sales", &alice_kp.public_key_hex(), NOW);
        list.authorized_keys.push(AuthorizedKey {
            key: bob_kp.public_key_hex(),
            name: "Bob".to_string(),
            added_at: NOW.to_string(),
        });
        crate::publishers::write_signed(&reg, &list, &alice_kp).unwrap();
        let rev1 = reg
            .read_application_artifact("sales", crate::publishers::PUBLISHERS_FILE)
            .unwrap()
            .unwrap();
        let rev1_sig = reg
            .read_application_artifact("sales", crate::publishers::PUBLISHERS_SIG_FILE)
            .unwrap()
            .unwrap();
        list.revision = 2;
        list.authorized_keys.clear();
        crate::publishers::write_signed(&reg, &list, &alice_kp).unwrap();

        let viewer = TempDir::new().unwrap();
        checkout(&reg, "sales", None, NOW, &scope_of(&dir), viewer.path()).expect("sees revision 2");
        assert_eq!(list_anchors(viewer.path()).unwrap()[0].publishers_revision, 2);

        // The rollback, and a head only the rolled-back list authorises.
        reg.write_application_artifact("sales", crate::publishers::PUBLISHERS_FILE, &rev1).unwrap();
        reg.write_application_artifact("sales", crate::publishers::PUBLISHERS_SIG_FILE, &rev1_sig)
            .unwrap();
        push_version(
            &reg,
            alice.path(),
            &wb,
            SemVer::new(1, 1, 0),
            PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        );
        resign_as(&reg, "1.1.0", &bob_kp, "bob");

        let err = refused(checkout(&reg, "sales", None, NOW, &scope_of(&dir), viewer.path()));
        match &err {
            CalpError::PublisherListRolledBack { seen, found, .. } => assert_eq!((*seen, *found), (2, 1)),
            other => panic!("expected PublisherListRolledBack, got {other:?}"),
        }

        // POSITIVE CONTROL: a machine that never saw revision 2 cannot know it
        // existed, and opens the head Bob signed.
        let fresh = TempDir::new().unwrap();
        let co = checkout(&reg, "sales", None, NOW, &scope_of(&dir), fresh.path())
            .expect("a machine with no mark accepts the list it is served");
        assert_eq!(co.signer.role, SignerRole::CoPublisher);
    }

    /// BUG-0266: a checkout the SIGNER CHECK refuses records nothing.
    /// `authorize_signer` used to run `anchor_root` -- under the checkout's
    /// `RecordOnFirstContact` -- BEFORE it judged the signer, so a fresh
    /// machine that was refused a planted root's application remembered the
    /// PLANTER as its creator anyway, and then refused the genuine application
    /// as a contradiction (until Forget). The last step proves that second harm
    /// gone as well: with the plant removed, the same machine opens it.
    ///
    /// Two layers keep the REFUSAL half green -- `prepare_checkout` asks
    /// `CheckOnly`, and `authorize_signer_under` records only after the signer
    /// passed -- so the sabotage that turns that half red reverts BOTH (each
    /// layer alone has its own test:
    /// `a_prepared_checkout_records_nothing_until_it_is_admitted` and
    /// `a_signer_refused_under_a_recording_gate_records_no_anchor`). Reverting
    /// the first alone turns the LAST assertion red: prepare then records, and
    /// admission reports a match instead of first contact (measured 2026-09-30).
    #[test]
    fn a_refused_checkout_records_no_developer_anchor() {
        let dir = TempDir::new().unwrap();
        let alice = TempDir::new().unwrap();
        let mallory = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        publish_v1(&reg, alice.path(), &workbook_with("v1"));
        // A Mallory-signed 0.0.1 planted BELOW Alice's 1.0.0; the head is
        // still Alice's, which the planted root does not authorise.
        let genuine_listing = reg.get_application_manifest("sales").unwrap();
        let mallory_kp = keypair(mallory.path());
        plant_fake_root(&reg, "0.0.1", &mallory_kp, "mallory");

        let fresh = TempDir::new().unwrap();
        let err = refused(checkout(&reg, "sales", None, NOW, &scope_of(&dir), fresh.path()));
        assert!(matches!(err, CalpError::SignerNotAuthorized { .. }), "got {err:?}");
        let recorded = list_anchors(fresh.path()).unwrap();
        assert!(recorded.is_empty(), "a REFUSED checkout recorded a developer anchor: {recorded:?}");

        // The plant removed, the genuine application opens on that machine --
        // it is not refused as a contradiction of a planter it never admitted.
        reg.write_application_manifest(&genuine_listing).unwrap();
        let co = checkout(&reg, "sales", None, NOW, &scope_of(&dir), fresh.path())
            .expect("the genuine application opens once the plant is gone");
        assert_eq!(co.signer.root_key, keypair(alice.path()).public_key_hex());
        assert!(matches!(co.signer.anchor, AnchorStatus::FirstContact { .. }), "got {:?}", co.signer.anchor);
    }

    /// The two halves of a checkout: a door that PREPARES one and then refuses
    /// it (by its own gate, after core's) leaves nothing remembered; only
    /// `admit` records first contact, and it reports that it did.
    ///
    /// SABOTAGE: `prepare_checkout` asks `RecordOnFirstContact` again.
    #[test]
    fn a_prepared_checkout_records_nothing_until_it_is_admitted() {
        let dir = TempDir::new().unwrap();
        let alice = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        publish_v1(&reg, alice.path(), &workbook_with("v1"));

        let viewer = TempDir::new().unwrap();
        let pending = prepare_checkout(&reg, "sales", None, NOW, &scope_of(&dir), viewer.path())
            .expect("every check passes");
        assert_eq!(pending.signer().anchor, AnchorStatus::NotAnchored);
        drop(pending); // the door's own gate refused it
        assert!(
            list_anchors(viewer.path()).unwrap().is_empty(),
            "a checkout its door refused after core's checks recorded a developer anchor"
        );

        let admitted = prepare_checkout(&reg, "sales", None, NOW, &scope_of(&dir), viewer.path())
            .unwrap()
            .admit()
            .expect("admitted");
        assert!(
            matches!(admitted.signer.anchor, AnchorStatus::FirstContact { .. }),
            "got {:?}",
            admitted.signer.anchor
        );
        assert_eq!(list_anchors(viewer.path()).unwrap().len(), 1);
    }

    /// The second layer, alone: `authorize_signer` handed a RECORDING gate
    /// (as no production door does today) still records nothing for a signer
    /// it refuses -- the record comes after the signer check, never before.
    ///
    /// SABOTAGE: in `authorize_signer_under`, ask `anchor` instead of
    /// `&check_only` in the first `anchor_root` call.
    #[test]
    fn a_signer_refused_under_a_recording_gate_records_no_anchor() {
        let dir = TempDir::new().unwrap();
        let alice = TempDir::new().unwrap();
        let mallory = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        publish_v1(&reg, alice.path(), &workbook_with("v1"));
        plant_fake_root(&reg, "0.0.1", &keypair(mallory.path()), "mallory");

        let fresh = TempDir::new().unwrap();
        let scope = scope_of(&dir);
        let gate = AnchorGate {
            profile_dir: fresh.path(),
            scope: &scope,
            policy: AnchorPolicy::RecordOnFirstContact { via: AnchoredBy::Checkout },
        };
        let err = crate::publishers::authorize_signer(
            &reg,
            "sales",
            "1.0.0",
            &keypair(alice.path()).public_key_hex(),
            "author",
            &gate,
        )
        .unwrap_err();
        assert!(matches!(err, CalpError::SignerNotAuthorized { .. }), "got {err:?}");
        assert!(list_anchors(fresh.path()).unwrap().is_empty(), "a refused signer was remembered");
    }

    /// Admission records the root that was JUDGED, and asks again under the
    /// store's lock: a different root recorded in between (another Calcula, a
    /// second thread) refuses at admission rather than being overwritten.
    ///
    /// SABOTAGE: `admit` returns `Ok` without calling `anchor_root`.
    #[test]
    fn admission_refuses_a_root_recorded_since_the_checkout_was_prepared() {
        let dir = TempDir::new().unwrap();
        let alice = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        publish_v1(&reg, alice.path(), &workbook_with("v1"));
        let viewer = TempDir::new().unwrap();
        let pending = prepare_checkout(&reg, "sales", None, NOW, &scope_of(&dir), viewer.path()).unwrap();

        // Meanwhile this machine remembered a DIFFERENT creator for it.
        let mallory = TempDir::new().unwrap();
        let other = crate::publishers::RootAnchoredPublishers {
            root_key: keypair(mallory.path()).public_key_hex(),
            root_name: "mallory".to_string(),
            root_version: "0.0.1".to_string(),
            list: None,
        };
        let scope = scope_of(&dir);
        let gate = AnchorGate {
            profile_dir: viewer.path(),
            scope: &scope,
            policy: AnchorPolicy::RecordOnFirstContact { via: AnchoredBy::Checkout },
        };
        crate::developer_anchor::anchor_root(&gate, "sales", &other).unwrap();

        match pending.admit() {
            Err(CalpError::DeveloperAnchorContradicted { .. }) => {}
            Err(other) => panic!("expected DeveloperAnchorContradicted, got {other:?}"),
            Ok(_) => panic!("admission overwrote or ignored a root recorded since the checks"),
        }
        let kept = list_anchors(viewer.path()).unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].root_key, keypair(mallory.path()).public_key_hex());
    }
}
