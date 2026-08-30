//! FILENAME: core/calp/src/checkout.rs
//! PURPOSE: Open a published package version as a WORKING COPY.
//! CONTEXT: The author-side counterpart of `pull()`. A subscriber pulls a
//! package to CONSUME it; a developer checks it out to DEVELOP it. The
//! difference is one field wide (sheet identity) and one policy wide (trust
//! pinning) — everything else, including all three gates and the whole artifact
//! walk, is the same audited code path.

use std::path::Path;

use crate::error::CalpError;
use crate::integrity::PinPolicy;
use crate::pull::{pull_with_options, PullRequest, PullResult, SheetIdMode};
use crate::registry_id::RegistryScope;
use crate::transport::RegistryTransport;
use crate::version::{SemVer, VersionPin};

/// Check out a package version for editing.
///
/// `version` selects a specific version; `None` means the registry head (the
/// highest published version, which is what a `latest` pin resolves to).
///
/// Two deliberate differences from [`crate::pull::pull`]:
///
/// * **Sheet ids are preserved** ([`SheetIdMode::PreservePackage`]). This is
///   the whole point: a push from the resulting workbook produces the NEXT
///   version of this package rather than a package that merely shares its name,
///   so subscribers see modified sheets and their overrides survive.
///
/// * **`PinPolicy::VerifyOnly`** — a checkout verifies the signature and
///   reports the trust status, but never creates a TOFU pin. A pin is the
///   subscriber's standing decision to keep accepting updates from one
///   publisher on the refresh loop; a working copy has no refresh loop, so
///   minting one here would file a trust decision the user was never asked to
///   make. (`only_subscribe_and_install_may_create_a_calp_pin` in
///   `tests/lifecycle.rs` holds this line.)
///
/// The returned [`PullResult`] carries `subscription` as `pull()` builds it;
/// the caller MUST discard it for a checkout. A working copy is not a
/// subscriber of its own package — see the role rule in
/// `docs/design/calp-workspace-collaboration.md` §2.3.
pub fn checkout(
    registry: &dyn RegistryTransport,
    package_name: &str,
    version: Option<SemVer>,
    now: &str,
    scope: &RegistryScope,
    profile_dir: &Path,
) -> Result<PullResult, CalpError> {
    let request = PullRequest {
        package_name: package_name.to_string(),
        version_pin: match version {
            Some(v) => VersionPin::Exact(v),
            None => VersionPin::Latest,
        },
        now: now.to_string(),
    };
    pull_with_options(
        registry,
        &request,
        scope,
        profile_dir,
        PinPolicy::VerifyOnly,
        SheetIdMode::PreservePackage,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::publish::{self, PublishRequest, PushMode};
    use crate::registry::LocalRegistry;
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

    fn publish_v1(reg: &LocalRegistry, prof: &Path, wb: &Workbook) {
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
        let reg = LocalRegistry::open(dir.path()).unwrap();
        let wb = workbook_with("hello");
        let package_sheet_id = wb.sheets[0].id;
        publish_v1(&reg, prof.path(), &wb);

        let scope = crate::registry_id::registry_scope(dir.path().to_str().unwrap()).unwrap();

        let checked_out =
            checkout(&reg, "sales", None, "2026-08-29T01:00:00Z", &scope, prof.path()).unwrap();
        assert_eq!(checked_out.sheets.len(), 1);
        assert_eq!(
            checked_out.sheets[0].sheet.id, package_sheet_id,
            "a working copy carries the package's sheet identity"
        );
        assert_eq!(checked_out.sheets[0].package_sheet_id, package_sheet_id);
        assert_eq!(checked_out.resolved_version, SemVer::new(1, 0, 0));

        // The subscribe path, by contrast, mints its own. (Same package, same
        // registry — the ONLY difference is the mode.)
        let pulled = crate::pull::pull(
            &reg,
            &PullRequest {
                package_name: "sales".to_string(),
                version_pin: VersionPin::Latest,
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
        let reg = LocalRegistry::open(dir.path()).unwrap();
        let wb = workbook_with("some content");
        publish_v1(&reg, prof.path(), &wb);
        let scope = crate::registry_id::registry_scope(dir.path().to_str().unwrap()).unwrap();

        let co = checkout(&reg, "sales", None, "2026-08-29T01:00:00Z", &scope, prof.path()).unwrap();
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
        let reg = LocalRegistry::open(dir.path()).unwrap();
        publish_v1(&reg, prof.path(), &workbook_with("x"));
        let scope = crate::registry_id::registry_scope(dir.path().to_str().unwrap()).unwrap();

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
}
