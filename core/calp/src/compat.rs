//! FILENAME: core/calp/src/compat.rs
//! PURPOSE: Compatibility contract — refuse a .calp package that needs a newer
//!          Calcula than this one, with an honest "update the app" error rather
//!          than a silent or partial failure. The host records its version once
//!          at startup; the pull-time gate (pull.rs) consults it. This is the
//!          whole-package analogue of the BI-model `ModelFormatTooNew` gate.
//! CONTEXT: First slice of the compatibility contract. Deferred to later slices:
//!          required-capabilities check and script/extension-API semver.

use std::sync::OnceLock;

use crate::error::CalpError;
use crate::version::SemVer;

/// The host application's version, set once at startup via
/// [`set_host_app_version`]. `None` before startup / in headless tests, in which
/// case the compatibility gate is skipped (lenient) so the calp crate stays
/// usable without a host.
static HOST_APP_VERSION: OnceLock<String> = OnceLock::new();

/// Record the host application's version (e.g. `env!("CARGO_PKG_VERSION")`) so
/// the pull-time compatibility gate can reject packages requiring a newer app.
/// Idempotent — only the first call takes effect (the version is fixed for the
/// life of the process).
pub fn set_host_app_version(version: impl Into<String>) {
    let _ = HOST_APP_VERSION.set(version.into());
}

/// The host application's version, if it has been set.
pub fn host_app_version() -> Option<&'static str> {
    HOST_APP_VERSION.get().map(String::as_str)
}

/// Compatibility gate: refuse a package version whose declared `min_app_version`
/// is newer than the host app.
///
/// Passes when: the package declares no minimum (`min_app_version` empty), or
/// the host version is unknown (`None` — tests / headless). A malformed version
/// string is a typed [`CalpError`]. Otherwise compares as semver and returns
/// [`CalpError::AppTooOld`] when the host is older than required.
pub fn check_min_app_version(
    package: &str,
    version: &str,
    min_app_version: &str,
    app_version: Option<&str>,
) -> Result<(), CalpError> {
    if min_app_version.is_empty() {
        return Ok(());
    }
    let Some(current_str) = app_version else {
        return Ok(());
    };
    let required = SemVer::parse(min_app_version)?;
    let current = SemVer::parse(current_str)?;
    if current < required {
        return Err(CalpError::AppTooOld {
            package: package.to_string(),
            version: version.to_string(),
            required: required.to_string(),
            current: current.to_string(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_minimum_always_passes() {
        assert!(check_min_app_version("p", "1.0.0", "", Some("0.1.0")).is_ok());
    }

    #[test]
    fn unknown_host_version_is_lenient() {
        assert!(check_min_app_version("p", "1.0.0", "9.9.9", None).is_ok());
    }

    #[test]
    fn equal_or_newer_host_passes() {
        assert!(check_min_app_version("p", "1.0.0", "1.0.0", Some("1.0.0")).is_ok());
        assert!(check_min_app_version("p", "1.0.0", "1.2.0", Some("1.5.0")).is_ok());
        assert!(check_min_app_version("p", "1.0.0", "0.1.0", Some("2.0.0")).is_ok());
    }

    #[test]
    fn older_host_is_rejected_with_versions() {
        let err = check_min_app_version("pkg", "3.1.0", "2.0.0", Some("1.4.0")).unwrap_err();
        match err {
            CalpError::AppTooOld { package, version, required, current } => {
                assert_eq!(package, "pkg");
                assert_eq!(version, "3.1.0");
                assert_eq!(required, "2.0.0");
                assert_eq!(current, "1.4.0");
            }
            other => panic!("expected AppTooOld, got {other:?}"),
        }
    }
}
