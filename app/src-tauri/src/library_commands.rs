// FILENAME: app/src-tauri/src/library_commands.rs
// PURPOSE: Script-library resolution against a .calp registry — the ONE backend
//          command behind the script package manager (docs/design/
//          script-package-manager.md). Given a batch of {package, pin} requests
//          it resolves each pin to a concrete version, verifies the publisher's
//          Ed25519 signature + TOFU pin, integrity-checks every module artifact
//          against the signed checksum map, and returns the module SOURCES.
// CONTEXT: A "library" is an ordinary .calp package whose manifest `kind` is
//          "library" and whose payload is `module_scripts` (modules/{id}.json,
//          a calcula-format ScriptDef). Nothing here mounts, installs, writes,
//          or consents — resolution is a pure read. The frontend
//          (@api/scriptLibraries) drives the transitive closure by re-calling
//          this command for the `// @uses` pragmas it parses out of the
//          returned sources, so pragma semantics have exactly ONE
//          implementation (scriptHost/capabilities.ts + scriptLibraries/
//          usesPragma.ts) instead of a drifting Rust copy.
// SECURITY: Reuses the EXISTING .calp trust root — no second signer, no second
//          pin namespace, no new key store:
//            * verify_and_load_manifest_via = Ed25519 over the raw manifest
//              bytes + TOFU pin under the package name (unsigned packages are
//              rejected outright by that function; there is no "unsigned but
//              installable" path here).
//            * every returned module artifact is SHA-256 checked against the
//              signature-sealed `artifact_checksums` map, and an artifact the
//              signed manifest does not list is never read (that key check is
//              also the path-traversal guard).
//          Capability ceilings, consent and mounting are decided in the
//          frontend from these verified bytes; this command deliberately grants
//          nothing.

use calp::integrity::{sha256_hex, verify_and_load_manifest_via, TrustStatus};
use calp::version::VersionPin;
use calcula_format::features::scripts::ScriptDef;
use serde::{Deserialize, Serialize};

use crate::calp_commands::calcula_profile_dir;
use crate::security::window_guard;

/// The manifest `kind` a package must declare to be usable as a script library.
/// Kept as a string comparison (PackageManifest.kind is a free-form String with
/// a "report" default) so no core enum has to grow a variant for this slice.
const LIBRARY_KIND: &str = "library";

/// Hard cap on modules returned per package — a runaway package must not be
/// able to make the renderer allocate without bound.
const MAX_MODULES_PER_PACKAGE: usize = 64;

/// One "resolve this package at this pin" request.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryRequest {
    pub package: String,
    /// A `VersionPin` string: "1.2.3", "^1.2.0", "~1.2.0", "latest", "*".
    pub pin: String,
}

/// One module of a resolved library package, with its verified source.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLibraryModule {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// The module body, read from `modules/{id}.json` AFTER its SHA-256 matched
    /// the signed checksum map.
    pub source: String,
    /// SHA-256 (lowercase hex) of the module ARTIFACT bytes as signed. The
    /// frontend hashes the `source` separately for the consent store; this hash
    /// is the on-registry integrity identity.
    pub artifact_sha256: String,
}

/// A resolved library package version.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLibrary {
    pub package: String,
    /// The concrete version the pin resolved to.
    pub resolved_version: String,
    /// The pin as requested (echoed so the frontend can write the lockfile
    /// without re-deriving it).
    pub pin: String,
    pub description: String,
    pub author: String,
    /// The verified publisher's display name (from the signed manifest).
    pub publisher_name: String,
    /// The publisher's Ed25519 public key (hex), as signed. The lockfile pins
    /// this so a later publisher-key change is visible as such.
    pub publisher_key: String,
    /// "firstUse" (key newly pinned) or "verified" (matched the prior pin).
    pub trust_status: String,
    pub modules: Vec<ResolvedLibraryModule>,
}

/// Resolve + verify a batch of library packages in one registry.
///
/// Errors (never partial success): an unknown package, an unsatisfiable pin, a
/// missing/invalid signature, a publisher-key change that breaks the TOFU pin, a
/// package whose kind is not "library", or a module artifact whose bytes do not
/// match the signed checksum.
#[tauri::command]
pub fn library_resolve(
    registry_path: String,
    requests: Vec<LibraryRequest>,
    window: tauri::Window,
) -> Result<Vec<ResolvedLibrary>, String> {
    window_guard::require_label(&window, window_guard::MAIN)?;
    let registry = crate::calp_registry::open_registry(&registry_path).map_err(|e| e.to_string())?;
    resolve_libraries(registry.as_ref(), &calcula_profile_dir(), &requests)
}

/// The command's whole body, minus the window guard and the transport
/// construction — split out so it is unit-testable against an in-process
/// `LocalRegistry` without a Tauri window.
pub fn resolve_libraries(
    registry: &dyn calp::transport::RegistryTransport,
    profile_dir: &std::path::Path,
    requests: &[LibraryRequest],
) -> Result<Vec<ResolvedLibrary>, String> {
    let mut out = Vec::with_capacity(requests.len());

    for request in requests {
        let pin = VersionPin::parse(&request.pin)
            .map_err(|e| format!("{}: invalid version pin '{}': {}", request.package, request.pin, e))?;
        let resolved = registry
            .resolve_version(&request.package, &pin)
            .map_err(|e| format!("{}@{}: {}", request.package, request.pin, e))?;
        let version = resolved.to_string();

        // Package-level manifest: kind + description + author. Read BEFORE the
        // version manifest so a non-library package is refused without reading
        // any of its code.
        let package_manifest = registry
            .get_package_manifest(&request.package)
            .map_err(|e| e.to_string())?;
        if package_manifest.kind != LIBRARY_KIND {
            return Err(format!(
                "'{}' is a '{}' package, not a script library. Only packages published with kind='{}' can be imported by a script.",
                request.package, package_manifest.kind, LIBRARY_KIND
            ));
        }

        // THE trust gate: Ed25519 over the raw manifest bytes + TOFU pin. An
        // unsigned package errors here (MissingSignature) — there is no
        // "install it anyway with an empty ceiling" path in this command.
        let (trust, manifest) =
            verify_and_load_manifest_via(registry, &request.package, &version, profile_dir)
                .map_err(|e| format!("{}@{}: {}", request.package, version, e))?;
        let trust_status = match trust {
            TrustStatus::FirstUse => "firstUse",
            TrustStatus::Verified => "verified",
        }
        .to_string();

        if manifest.module_scripts.is_empty() {
            return Err(format!(
                "{}@{} is a library package but carries no module scripts — nothing to import.",
                request.package, version
            ));
        }
        if manifest.module_scripts.len() > MAX_MODULES_PER_PACKAGE {
            return Err(format!(
                "{}@{} declares {} modules; the limit is {}.",
                request.package,
                version,
                manifest.module_scripts.len(),
                MAX_MODULES_PER_PACKAGE
            ));
        }

        let mut modules = Vec::with_capacity(manifest.module_scripts.len());
        for published in &manifest.module_scripts {
            let path = format!("modules/{}.json", published.id);
            // Only artifacts the SIGNED manifest lists are readable. This is the
            // integrity check and the traversal guard in one: an id that is not
            // a checksum key never reaches read_artifact.
            let expected = manifest.artifact_checksums.get(&path).ok_or_else(|| {
                format!(
                    "{}@{}: module '{}' is not covered by the package signature.",
                    request.package, version, published.id
                )
            })?;
            let bytes = registry
                .read_artifact(&request.package, &version, &path)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| {
                    format!(
                        "{}@{}: module artifact '{}' is missing from the registry.",
                        request.package, version, path
                    )
                })?;
            let actual = sha256_hex(&bytes);
            if &actual != expected {
                return Err(format!(
                    "{}@{}: module '{}' failed its integrity check (expected {}, got {}). The package has been tampered with.",
                    request.package, version, published.id, expected, actual
                ));
            }
            let def: ScriptDef = serde_json::from_slice(&bytes).map_err(|e| {
                format!(
                    "{}@{}: module '{}' is not a valid script definition: {}",
                    request.package, version, published.id, e
                )
            })?;
            modules.push(ResolvedLibraryModule {
                id: published.id.clone(),
                name: published.name.clone(),
                description: published.description.clone(),
                source: def.source,
                artifact_sha256: actual,
            });
        }

        out.push(ResolvedLibrary {
            package: request.package.clone(),
            resolved_version: version,
            pin: request.pin.clone(),
            description: package_manifest.description.clone(),
            author: package_manifest.author.clone(),
            publisher_name: manifest.publisher_name.clone(),
            publisher_key: manifest.publisher_key.clone(),
            trust_status,
            modules,
        });
    }

    Ok(out)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use calp::integrity::{VERSION_MANIFEST_FILE, VERSION_MANIFEST_SIG_FILE};
    use calp::manifest::{PackageManifest, PublishedModuleScript, VersionEntry, VersionManifest};
    use calp::registry::LocalRegistry;
    use calp::signing::PublisherKeypair;
    use tempfile::TempDir;

    fn module_artifact(id: &str, source: &str) -> Vec<u8> {
        serde_json::to_vec_pretty(&serde_json::json!({
            "id": id,
            "name": id,
            "description": null,
            "source": source,
            "scope": { "type": "workbook" },
            "sourcePackage": null,
        }))
        .unwrap()
    }

    /// Publish a minimal LIBRARY package the same way `calp::publish` seals one:
    /// artifacts first, then the checksum map, then the manifest, then the
    /// detached Ed25519 signature over the manifest bytes AS WRITTEN.
    fn publish_library(
        registry: &LocalRegistry,
        keypair: &PublisherKeypair,
        pkg: &str,
        ver: &str,
        kind: &str,
        modules: &[(&str, &str)],
        sign: bool,
    ) {
        for (id, source) in modules {
            registry
                .write_artifact(
                    pkg,
                    ver,
                    &format!("modules/{id}.json"),
                    &module_artifact(id, source),
                )
                .unwrap();
        }
        let mut manifest: VersionManifest = serde_json::from_value(serde_json::json!({
            "formatVersion": 1,
            "packageName": pkg,
            "version": ver,
            "kind": kind,
            "publishedAt": "2026-08-01T00:00:00Z",
            "publishedBy": "tester",
            "publisherKey": if sign { keypair.public_key_hex() } else { String::new() },
            "publisherName": "Test Publisher",
            "sheets": [],
        }))
        .unwrap();
        manifest.module_scripts = modules
            .iter()
            .map(|(id, _)| PublishedModuleScript {
                id: (*id).to_string(),
                name: (*id).to_string(),
                scope: "workbook".to_string(),
                description: None,
            })
            .collect();
        manifest.artifact_checksums =
            calp::integrity::compute_artifact_checksums_via(registry, pkg, ver).unwrap();
        registry.write_version_manifest(pkg, ver, &manifest).unwrap();

        if sign {
            let bytes = registry
                .read_artifact(pkg, ver, VERSION_MANIFEST_FILE)
                .unwrap()
                .unwrap();
            registry
                .write_artifact(
                    pkg,
                    ver,
                    VERSION_MANIFEST_SIG_FILE,
                    keypair.sign(&bytes).as_bytes(),
                )
                .unwrap();
        }

        let mut pkg_manifest = registry
            .get_package_manifest(pkg)
            .unwrap_or_else(|_| PackageManifest::new(pkg, kind, "tester", "2026-08-01T00:00:00Z"));
        pkg_manifest.kind = kind.to_string();
        pkg_manifest.versions.push(VersionEntry {
            version: ver.to_string(),
            published_at: "2026-08-01T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            extra: Default::default(),
        });
        registry.write_package_manifest(&pkg_manifest).unwrap();
    }

    struct Fixture {
        _reg_dir: TempDir,
        profile: TempDir,
        registry: LocalRegistry,
        keypair: PublisherKeypair,
    }

    fn fixture() -> Fixture {
        let reg_dir = TempDir::new().unwrap();
        let profile = TempDir::new().unwrap();
        let registry = LocalRegistry::open(reg_dir.path()).unwrap();
        let keypair = PublisherKeypair::load_or_create(profile.path()).unwrap();
        Fixture {
            _reg_dir: reg_dir,
            profile,
            registry,
            keypair,
        }
    }

    const LIB_SRC: &str =
        "// @export mean\nfunction library(context) { return { mean: () => 1 }; }";

    fn req(pkg: &str, pin: &str) -> Vec<LibraryRequest> {
        vec![LibraryRequest {
            package: pkg.to_string(),
            pin: pin.to_string(),
        }]
    }

    #[test]
    fn resolves_a_signed_library_and_returns_its_module_source() {
        let f = fixture();
        publish_library(
            &f.registry,
            &f.keypair,
            "acme.stats",
            "1.2.4",
            "library",
            &[("stats", LIB_SRC)],
            true,
        );

        let out =
            resolve_libraries(&f.registry, f.profile.path(), &req("acme.stats", "^1.2.0")).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].resolved_version, "1.2.4");
        assert_eq!(out[0].trust_status, "firstUse");
        assert_eq!(out[0].publisher_key, f.keypair.public_key_hex());
        assert_eq!(out[0].modules.len(), 1);
        assert_eq!(out[0].modules[0].source, LIB_SRC);
    }

    #[test]
    fn refuses_an_unsigned_package() {
        let f = fixture();
        publish_library(
            &f.registry,
            &f.keypair,
            "acme.stats",
            "1.0.0",
            "library",
            &[("stats", LIB_SRC)],
            false,
        );

        let err =
            resolve_libraries(&f.registry, f.profile.path(), &req("acme.stats", "1.0.0")).unwrap_err();
        let lowered = err.to_lowercase();
        assert!(
            lowered.contains("signature") || lowered.contains("signed"),
            "unsigned package must be refused, got: {err}"
        );
    }

    #[test]
    fn refuses_a_package_whose_kind_is_not_library() {
        let f = fixture();
        publish_library(
            &f.registry,
            &f.keypair,
            "acme.report",
            "1.0.0",
            "report",
            &[("m", LIB_SRC)],
            true,
        );

        let err = resolve_libraries(&f.registry, f.profile.path(), &req("acme.report", "1.0.0"))
            .unwrap_err();
        assert!(err.contains("not a script library"), "got: {err}");
    }

    #[test]
    fn refuses_a_module_artifact_that_was_tampered_after_signing() {
        let f = fixture();
        publish_library(
            &f.registry,
            &f.keypair,
            "acme.stats",
            "1.0.0",
            "library",
            &[("stats", LIB_SRC)],
            true,
        );
        // The signature covers the manifest (and therefore the checksum map);
        // rewriting the module bytes must fail the per-artifact SHA-256 check.
        f.registry
            .write_artifact(
                "acme.stats",
                "1.0.0",
                "modules/stats.json",
                &module_artifact(
                    "stats",
                    "// @export mean\nfunction library() { return { mean: () => 666 }; }",
                ),
            )
            .unwrap();

        let err =
            resolve_libraries(&f.registry, f.profile.path(), &req("acme.stats", "1.0.0")).unwrap_err();
        assert!(err.contains("integrity check"), "got: {err}");
    }

    #[test]
    fn refuses_a_library_package_with_no_modules() {
        let f = fixture();
        publish_library(
            &f.registry,
            &f.keypair,
            "acme.empty",
            "1.0.0",
            "library",
            &[],
            true,
        );

        let err =
            resolve_libraries(&f.registry, f.profile.path(), &req("acme.empty", "1.0.0")).unwrap_err();
        assert!(err.contains("no module scripts"), "got: {err}");
    }

    #[test]
    fn rejects_a_malformed_pin_before_touching_the_registry() {
        let f = fixture();
        let err = resolve_libraries(&f.registry, f.profile.path(), &req("acme.stats", "nonsense"))
            .unwrap_err();
        assert!(err.contains("invalid version pin"), "got: {err}");
    }

    #[test]
    fn a_second_resolve_reports_verified_against_the_tofu_pin() {
        let f = fixture();
        publish_library(
            &f.registry,
            &f.keypair,
            "acme.stats",
            "1.0.0",
            "library",
            &[("stats", LIB_SRC)],
            true,
        );

        let first =
            resolve_libraries(&f.registry, f.profile.path(), &req("acme.stats", "1.0.0")).unwrap();
        assert_eq!(first[0].trust_status, "firstUse");
        let second =
            resolve_libraries(&f.registry, f.profile.path(), &req("acme.stats", "1.0.0")).unwrap();
        assert_eq!(second[0].trust_status, "verified");
    }

    #[test]
    fn a_publisher_key_change_breaks_the_tofu_pin() {
        let f = fixture();
        publish_library(
            &f.registry,
            &f.keypair,
            "acme.stats",
            "1.0.0",
            "library",
            &[("stats", LIB_SRC)],
            true,
        );
        resolve_libraries(&f.registry, f.profile.path(), &req("acme.stats", "1.0.0")).unwrap();

        // A different publisher republishes the same package name at a new version.
        let other_profile = TempDir::new().unwrap();
        let impostor = PublisherKeypair::load_or_create(other_profile.path()).unwrap();
        assert_ne!(impostor.public_key_hex(), f.keypair.public_key_hex());
        publish_library(
            &f.registry,
            &impostor,
            "acme.stats",
            "1.0.1",
            "library",
            &[("stats", LIB_SRC)],
            true,
        );

        let err =
            resolve_libraries(&f.registry, f.profile.path(), &req("acme.stats", "1.0.1")).unwrap_err();
        assert!(
            !err.is_empty(),
            "a publisher-key change must not resolve silently"
        );
    }
}
