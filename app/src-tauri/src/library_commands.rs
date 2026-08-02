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
//            * Ed25519 over the raw manifest bytes + TOFU pin under the package
//              name (unsigned packages are rejected outright; there is no
//              "unsigned but installable" path here).
//            * every returned module artifact is SHA-256 checked against the
//              signature-sealed `artifact_checksums` map, and an artifact the
//              signed manifest does not list is never read (that key check is
//              also the path-traversal guard).
//          Capability ceilings, consent and mounting are decided in the
//          frontend from these verified bytes; resolution itself grants nothing.
//
//          A PREVIEW VERIFIES; ONLY AN INSTALL PINS. See `PinPolicy` below.
//          This mirrors `extension_install.rs` (`decide_extension_trust_for_scan`):
//          creating a TOFU pin is a promise only a human answering a question
//          can keep, so an unattended or merely-exploratory read must never
//          create one.

use std::path::Path;

use calp::error::CalpError;
use calp::integrity::{sha256_hex, VERSION_MANIFEST_FILE, VERSION_MANIFEST_SIG_FILE};
use calp::manifest::VersionManifest;
use calp::signing::{load_trusted_publishers, pin_publisher, verify_signature};
use calp::transport::RegistryTransport;
use calp::version::VersionPin;
use calcula_format::features::scripts::ScriptDef;
use serde::{Deserialize, Serialize};

use crate::calp_commands::calcula_profile_dir;
use crate::security::window_guard;

/// The manifest `kind` a package must declare to be usable as a script library.
/// Kept as a string comparison (PackageManifest.kind is a free-form String with
/// a "report" default) so no core enum has to grow a variant for this slice.
pub(crate) const LIBRARY_KIND: &str = "library";

/// Hard cap on modules returned per package — a runaway package must not be
/// able to make the renderer allocate without bound.
const MAX_MODULES_PER_PACKAGE: usize = 64;

// ---------------------------------------------------------------------------
// The trust vocabulary
// ---------------------------------------------------------------------------

/// INSTALL-ONLY. The publisher key was not pinned before and has been pinned
/// NOW, as part of an install the user confirmed. It is a statement about a
/// decision that just happened, so only the install path may emit it.
pub const LIB_TRUST_FIRST_USE: &str = "firstUse";

/// PREVIEW-ONLY. The signature verified, but this machine holds NO pin for this
/// package — nobody has ever agreed to trust this publisher for this name.
///
/// This is a distinct, NON-TRUSTING status rather than a silent pin because
/// pinning during a preview lets a source SQUAT the identity a genuine
/// publisher will later be measured against: publish `acme.stats` signed with
/// your own key to any registry the user browses, let their package manager
/// preview it, and the pin for `acme.stats` is now yours. When Acme ships the
/// real library, the user is told the PUBLISHER CHANGED and the legitimate
/// author looks like the attacker.
///
/// A preview is attended and grants nothing, so this was never an escalation on
/// its own — it is the same structural bug `decide_extension_trust_for_scan`
/// fixed for extension scanning, and it gets the same shape of fix: a preview
/// VERIFIES against an existing pin and never CREATES one.
pub const LIB_TRUST_NOT_INSTALLED: &str = "notInstalled";

/// The signature verified against the key already pinned for this package.
pub const LIB_TRUST_VERIFIED: &str = "verified";

/// Every status `library_resolve` can return. The frontend must have a
/// presentation row for each — a security state that renders as an unlabelled
/// box (or, worse, falls through to "verified") is the worst possible failure.
pub const LIBRARY_TRUST_STATUSES: &[&str] = &[
    LIB_TRUST_FIRST_USE,
    LIB_TRUST_NOT_INSTALLED,
    LIB_TRUST_VERIFIED,
];

/// The ONLY status that means "this machine has, at some point, deliberately
/// agreed to trust this publisher for this package name". `notInstalled` is
/// deliberately absent: a previewed-but-never-installed library is not trusted,
/// it is merely authentic.
pub fn library_trust_is_pinned(status: &str) -> bool {
    matches!(status, LIB_TRUST_FIRST_USE | LIB_TRUST_VERIFIED)
}

/// Whether this resolution is allowed to CREATE a trust-on-first-use pin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinPolicy {
    /// Look, verify, report. Writes nothing to the pin store, ever. Used by the
    /// install PLAN, by the update check, and by anything else that resolves in
    /// order to show the user what would happen.
    Preview,
    /// The user has seen the publisher key and the closure and said yes. First
    /// contact pins here, and only here.
    Install,
}

/// Verify a library version's manifest signature and answer the TOFU question
/// WITHOUT necessarily answering it in writing.
///
/// This is `calp::integrity::verify_and_load_manifest_via` with one difference:
/// that function always pins on first contact, which is exactly the behaviour
/// being removed from the preview path. Everything else is deliberately
/// identical, including the property that makes it sound over an untrusted
/// transport: the manifest bytes are read ONCE, the signature is checked
/// against exactly those bytes, and the `VersionManifest` every downstream gate
/// trusts is parsed from exactly those bytes. (A design that fetches the
/// manifest once for parsing and again for verification lets a hostile server
/// serve a genuinely-signed manifest to the crypto check and a different body
/// to the payload — a split view that rewrites `artifact_checksums` under a
/// valid publisher badge.)
///
/// Fails closed in every direction: an unsigned package, a bad signature, a key
/// that differs from the pin, or a pin store that exists but cannot be read
/// (`load_trusted_publishers` returns `Err`, which is propagated rather than
/// treated as "no pin") all produce an error, never a status.
///
/// It never writes the pin store itself: under `PinPolicy::Install` it returns
/// the key that SHOULD be pinned, and `resolve_libraries` writes the whole
/// batch's pins only once every package in the batch has verified. Writing here
/// would make a batch that fails part way leave pins behind for the packages it
/// happened to reach first — a partial "install" the user never completed.
fn verify_library_manifest(
    t: &dyn RegistryTransport,
    package: &str,
    version: &str,
    profile_dir: &Path,
    policy: PinPolicy,
) -> Result<VerifiedLibraryManifest, CalpError> {
    // The single trusted copy of the manifest bytes.
    let manifest_bytes = t
        .read_artifact(package, version, VERSION_MANIFEST_FILE)?
        .ok_or_else(|| {
            CalpError::Registry(format!(
                "version-manifest.json not found for {package}@{version}"
            ))
        })?;
    let manifest: VersionManifest = serde_json::from_slice(&manifest_bytes)?;

    // (1) Unsigned packages are rejected outright (no backward compat).
    let sig_bytes = t.read_artifact(package, version, VERSION_MANIFEST_SIG_FILE)?;
    let sig_bytes = match (manifest.publisher_key.is_empty(), sig_bytes) {
        (false, Some(sig)) => sig,
        _ => {
            return Err(CalpError::MissingSignature {
                package: package.to_string(),
                version: version.to_string(),
            });
        }
    };

    // (2) Cryptographic verification over the SAME bytes `manifest` was parsed
    //     from, against the key the manifest asserts.
    let sig_hex = String::from_utf8_lossy(&sig_bytes);
    verify_signature(
        &manifest.publisher_key,
        &manifest_bytes,
        sig_hex.trim(),
        package,
        version,
    )?;

    // (3) TOFU — read always; a WRITE is only ever PROPOSED, and only on an
    //     install (see `VerifiedLibraryManifest::pending_pin`).
    let pinned = load_trusted_publishers(profile_dir)?;
    let (status, pending_pin) = match pinned.get(package) {
        Some(pinned_key) if pinned_key != &manifest.publisher_key => {
            return Err(CalpError::PublisherKeyChanged {
                package: package.to_string(),
                version: version.to_string(),
                pinned: pinned_key.clone(),
                got: manifest.publisher_key.clone(),
            });
        }
        Some(_) => (LIB_TRUST_VERIFIED, None),
        None => match policy {
            PinPolicy::Preview => (LIB_TRUST_NOT_INSTALLED, None),
            PinPolicy::Install => (
                LIB_TRUST_FIRST_USE,
                Some(manifest.publisher_key.clone()),
            ),
        },
    };

    Ok(VerifiedLibraryManifest {
        status,
        manifest,
        pending_pin,
    })
}

/// What `verify_library_manifest` established about one package version.
struct VerifiedLibraryManifest {
    /// One of `LIBRARY_TRUST_STATUSES`.
    status: &'static str,
    /// The manifest, parsed from the exact bytes the signature was checked over.
    manifest: VersionManifest,
    /// The publisher key this package would be pinned to, when (and only when)
    /// this is an INSTALL making first contact. Held rather than written so the
    /// whole batch commits its pins together — see `commit_pending_pins`.
    pending_pin: Option<String>,
}

/// Write the trust-on-first-use pins a fully-verified INSTALL batch earned.
///
/// Called once, after every package in the batch has passed every gate, so the
/// pin store moves in step with the caller's all-or-nothing contract: if
/// `resolve_libraries` returns `Err`, no package in that batch is pinned.
fn commit_pending_pins(profile_dir: &Path, pins: &[(String, String)]) -> Result<(), CalpError> {
    for (package, key) in pins {
        pin_publisher(profile_dir, package, key)?;
    }
    Ok(())
}

/// One "resolve this package at this pin" request.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryRequest {
    pub package: String,
    /// A `VersionPin` string: "1.2.3", "^1.2.0", "~1.2.0", "latest", "*".
    pub pin: String,

    // --- Install-time expectations (ignored by a preview) --------------------
    //
    // WHY THE BACKEND, NOT THE CALLER, ENFORCES THESE: an install is two steps
    // separated by a human — review the plan, then approve it — and the registry
    // is free to move in between. If the caller pinned first and compared
    // afterwards, a key swapped inside that window would already be PINNED by
    // the time the comparison failed, which is the exact squat this whole change
    // exists to prevent. So the caller states, up front, the identity it is
    // approving; a confirmed resolve that finds anything else refuses before
    // touching the pin store.
    /// The publisher key the user was shown and approved. When set (install
    /// only), a version signed by any other key is refused rather than pinned.
    #[serde(default)]
    pub expected_publisher_key: Option<String>,
    /// The concrete version the user was shown. When set (install only), a pin
    /// that now resolves elsewhere is refused — floating pins like `^1.2.0` can
    /// move between the review and the approval.
    #[serde(default)]
    pub expected_version: Option<String>,
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
    /// One of `LIBRARY_TRUST_STATUSES`: "notInstalled" (authentic, but this
    /// machine has never agreed to trust this publisher for this name — the
    /// only first-contact answer a PREVIEW may give), "firstUse" (pinned just
    /// now, by an install the user confirmed) or "verified" (matched the pin).
    pub trust_status: String,
    pub modules: Vec<ResolvedLibraryModule>,
}

/// Resolve + verify a batch of library packages in one registry.
///
/// `confirm` distinguishes the two callers, exactly like `InstallExtensionRequest.confirm`:
///   * absent/false = PREVIEW (`planInstall`, `checkUpdates`). Verifies against
///     any existing pin and reports; never writes one.
///   * true = INSTALL. The user has approved the closure, so first contact pins.
///
/// It defaults to PREVIEW when omitted so a caller that forgets it fails
/// closed — the worst outcome of a missing flag is a package that reads as
/// `notInstalled`, never a pin nobody asked for.
///
/// Errors (never partial success): an unknown package, an unsatisfiable pin, a
/// missing/invalid signature, a publisher-key change that breaks the TOFU pin, a
/// package whose kind is not "library", or a module artifact whose bytes do not
/// match the signed checksum.
#[tauri::command]
pub fn library_resolve(
    registry_path: String,
    requests: Vec<LibraryRequest>,
    confirm: Option<bool>,
    window: tauri::Window,
) -> Result<Vec<ResolvedLibrary>, String> {
    window_guard::require_label(&window, window_guard::MAIN)?;
    let policy = if confirm.unwrap_or(false) {
        PinPolicy::Install
    } else {
        PinPolicy::Preview
    };
    let registry = crate::calp_registry::open_registry(&registry_path).map_err(|e| e.to_string())?;
    resolve_libraries(
        registry.as_ref(),
        &calcula_profile_dir(),
        &requests,
        policy,
    )
}

/// The command's whole body, minus the window guard and the transport
/// construction — split out so it is unit-testable against an in-process
/// `LocalRegistry` without a Tauri window.
pub fn resolve_libraries(
    registry: &dyn calp::transport::RegistryTransport,
    profile_dir: &std::path::Path,
    requests: &[LibraryRequest],
    policy: PinPolicy,
) -> Result<Vec<ResolvedLibrary>, String> {
    let mut out = Vec::with_capacity(requests.len());
    // TOFU pins an INSTALL earned, held until the whole batch has verified.
    let mut pending_pins: Vec<(String, String)> = Vec::new();

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

        // THE trust gate: Ed25519 over the raw manifest bytes + TOFU. An
        // unsigned package errors here (MissingSignature) — there is no
        // "install it anyway with an empty ceiling" path in this command.
        // Under PinPolicy::Preview this READS the pin store and never writes it.
        let verified =
            verify_library_manifest(registry, &request.package, &version, profile_dir, policy)
                .map_err(|e| format!("{}@{}: {}", request.package, version, e))?;
        let VerifiedLibraryManifest {
            status,
            manifest,
            pending_pin,
        } = verified;

        // An INSTALL states, before it runs, which identity the user approved.
        // Checked here — after the signature verified, so `manifest.publisher_key`
        // is an established fact rather than an assertion, and BEFORE the pin is
        // queued, so a mismatch can never leave a pin behind.
        if policy == PinPolicy::Install {
            if let Some(expected) = &request.expected_version {
                if expected != &version {
                    return Err(format!(
                        "{} changed between review and install: {} was reviewed but the pin '{}' now resolves to {}. Nothing was installed — review it again.",
                        request.package, expected, request.pin, version
                    ));
                }
            }
            if let Some(expected) = &request.expected_publisher_key {
                if expected != &manifest.publisher_key {
                    return Err(format!(
                        "{}@{} changed between review and install: it was reviewed as published by {} but this version is signed by {}. Nothing was installed — review it again.",
                        request.package, version, expected, manifest.publisher_key
                    ));
                }
            }
        }

        let trust_status = status.to_string();
        if let Some(key) = pending_pin {
            pending_pins.push((request.package.clone(), key));
        }

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

    // Every package verified. Only now may an INSTALL create pins — so the
    // "never partial success" contract covers the pin store, not just the
    // returned value.
    commit_pending_pins(profile_dir, &pending_pins).map_err(|e| e.to_string())?;

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
            ..Default::default()
        }]
    }

    /// An install request that states the identity the user approved.
    fn approved(pkg: &str, pin: &str, key: &str, version: &str) -> Vec<LibraryRequest> {
        vec![LibraryRequest {
            package: pkg.to_string(),
            pin: pin.to_string(),
            expected_publisher_key: Some(key.to_string()),
            expected_version: Some(version.to_string()),
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

        let out = resolve_libraries(
            &f.registry,
            f.profile.path(),
            &req("acme.stats", "^1.2.0"),
            PinPolicy::Install,
        )
        .unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].resolved_version, "1.2.4");
        assert_eq!(out[0].trust_status, LIB_TRUST_FIRST_USE);
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

        let err = resolve_libraries(
            &f.registry,
            f.profile.path(),
            &req("acme.stats", "1.0.0"),
            PinPolicy::Install,
        )
        .unwrap_err();
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

        let err = resolve_libraries(
            &f.registry,
            f.profile.path(),
            &req("acme.report", "1.0.0"),
            PinPolicy::Install,
        )
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

        let err = resolve_libraries(
            &f.registry,
            f.profile.path(),
            &req("acme.stats", "1.0.0"),
            PinPolicy::Install,
        )
        .unwrap_err();
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

        let err = resolve_libraries(
            &f.registry,
            f.profile.path(),
            &req("acme.empty", "1.0.0"),
            PinPolicy::Install,
        )
        .unwrap_err();
        assert!(err.contains("no module scripts"), "got: {err}");
    }

    #[test]
    fn rejects_a_malformed_pin_before_touching_the_registry() {
        let f = fixture();
        let err = resolve_libraries(
            &f.registry,
            f.profile.path(),
            &req("acme.stats", "nonsense"),
            PinPolicy::Install,
        )
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

        let first = resolve_libraries(
            &f.registry,
            f.profile.path(),
            &req("acme.stats", "1.0.0"),
            PinPolicy::Install,
        )
        .unwrap();
        assert_eq!(first[0].trust_status, LIB_TRUST_FIRST_USE);
        let second = resolve_libraries(
            &f.registry,
            f.profile.path(),
            &req("acme.stats", "1.0.0"),
            PinPolicy::Install,
        )
        .unwrap();
        assert_eq!(second[0].trust_status, LIB_TRUST_VERIFIED);
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
        resolve_libraries(
            &f.registry,
            f.profile.path(),
            &req("acme.stats", "1.0.0"),
            PinPolicy::Install,
        )
        .unwrap();

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

        let err = resolve_libraries(
            &f.registry,
            f.profile.path(),
            &req("acme.stats", "1.0.1"),
            PinPolicy::Install,
        )
        .unwrap_err();
        assert!(
            !err.is_empty(),
            "a publisher-key change must not resolve silently"
        );
    }
    // ------------------------------------------------------------------
    // A PREVIEW VERIFIES; ONLY AN INSTALL PINS
    //
    // The bug these lock down: resolution used to pin trust-on-first-use
    // unconditionally, so merely PREVIEWING a package created the pin a genuine
    // publisher would later be measured against. It is the same structural bug
    // `decide_extension_trust_for_scan` fixed for extension scanning.
    // ------------------------------------------------------------------

    /// True when the TOFU store FILE exists at all. Deliberately not
    /// `load_trusted_publishers` (which reports a missing file as an empty map):
    /// these tests must be able to say "nothing was written", not merely
    /// "nothing was written for this package".
    fn pin_store_exists(profile: &std::path::Path) -> bool {
        calp::signing::trusted_publishers_file_path(profile).exists()
    }

    fn pinned_key(profile: &std::path::Path, pkg: &str) -> Option<String> {
        load_trusted_publishers(profile).unwrap().get(pkg).cloned()
    }

    #[test]
    fn a_preview_verifies_but_writes_no_pin() {
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

        let out = resolve_libraries(
            &f.registry,
            f.profile.path(),
            &req("acme.stats", "1.0.0"),
            PinPolicy::Preview,
        )
        .unwrap();

        // The signature IS checked and the sources ARE returned — a preview is
        // still a full verification, it just does not create trust.
        assert_eq!(out[0].publisher_key, f.keypair.public_key_hex());
        assert_eq!(out[0].modules[0].source, LIB_SRC);
        // First contact reads as its own non-trusting status, never "firstUse"
        // (which would claim a pin exists) and never "verified".
        assert_eq!(out[0].trust_status, LIB_TRUST_NOT_INSTALLED);
        assert!(
            !library_trust_is_pinned(&out[0].trust_status),
            "notInstalled must not count as a trusted, pinned publisher"
        );
        assert_eq!(
            pinned_key(f.profile.path(), "acme.stats"),
            None,
            "a preview must not create a TOFU pin"
        );
    }

    #[test]
    fn repeated_previews_never_start_pinning() {
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
        for _ in 0..3 {
            let out = resolve_libraries(
                &f.registry,
                f.profile.path(),
                &req("acme.stats", "1.0.0"),
                PinPolicy::Preview,
            )
            .unwrap();
            assert_eq!(out[0].trust_status, LIB_TRUST_NOT_INSTALLED);
        }
        assert!(
            !pin_store_exists(f.profile.path()),
            "no amount of previewing may bring the pin store into existence"
        );
    }

    #[test]
    fn an_install_pins_and_a_later_preview_then_reads_verified() {
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

        let installed = resolve_libraries(
            &f.registry,
            f.profile.path(),
            &req("acme.stats", "1.0.0"),
            PinPolicy::Install,
        )
        .unwrap();
        assert_eq!(installed[0].trust_status, LIB_TRUST_FIRST_USE);
        assert_eq!(
            pinned_key(f.profile.path(), "acme.stats").as_deref(),
            Some(f.keypair.public_key_hex().as_str()),
            "install is the ONE path that pins"
        );

        // Now that a human has agreed, a preview can honestly say "verified".
        let previewed = resolve_libraries(
            &f.registry,
            f.profile.path(),
            &req("acme.stats", "1.0.0"),
            PinPolicy::Preview,
        )
        .unwrap();
        assert_eq!(previewed[0].trust_status, LIB_TRUST_VERIFIED);
    }

    #[test]
    fn a_squatter_previewed_first_does_not_make_the_genuine_publisher_look_hijacked() {
        // THE ATTACK THIS CLOSES. An impostor publishes `acme.stats` to a
        // registry the user browses. The user previews it (or the package
        // manager does, resolving a dependency) and — crucially — does NOT
        // install it. Later the genuine Acme publishes the real library and the
        // user installs THAT.
        //
        // Under the old behaviour the preview pinned the impostor's key, so the
        // genuine publisher resolved as a publisher CHANGE and the real author
        // was accused of hijacking their own package name.
        let f = fixture();
        let squatter_profile = TempDir::new().unwrap();
        let squatter = PublisherKeypair::load_or_create(squatter_profile.path()).unwrap();
        assert_ne!(squatter.public_key_hex(), f.keypair.public_key_hex());

        publish_library(
            &f.registry,
            &squatter,
            "acme.stats",
            "1.0.0",
            "library",
            &[("stats", LIB_SRC)],
            true,
        );
        let squat = resolve_libraries(
            &f.registry,
            f.profile.path(),
            &req("acme.stats", "1.0.0"),
            PinPolicy::Preview,
        )
        .unwrap();
        assert_eq!(squat[0].trust_status, LIB_TRUST_NOT_INSTALLED);
        assert_eq!(pinned_key(f.profile.path(), "acme.stats"), None);

        // The genuine publisher ships. A SEPARATE registry, so this test is
        // purely about the pin store and not about which key signed which
        // version inside one registry.
        let genuine_dir = TempDir::new().unwrap();
        let genuine_registry = LocalRegistry::open(genuine_dir.path()).unwrap();
        publish_library(
            &genuine_registry,
            &f.keypair,
            "acme.stats",
            "2.0.0",
            "library",
            &[("stats", LIB_SRC)],
            true,
        );

        let genuine = resolve_libraries(
            &genuine_registry,
            f.profile.path(),
            &req("acme.stats", "2.0.0"),
            PinPolicy::Preview,
        )
        .expect("the genuine publisher must not be refused because a squatter was previewed");
        assert_eq!(
            genuine[0].trust_status, LIB_TRUST_NOT_INSTALLED,
            "still first contact - nothing has been trusted yet"
        );

        // Installing the genuine one pins the GENUINE key.
        let installed = resolve_libraries(
            &genuine_registry,
            f.profile.path(),
            &req("acme.stats", "2.0.0"),
            PinPolicy::Install,
        )
        .unwrap();
        assert_eq!(installed[0].trust_status, LIB_TRUST_FIRST_USE);
        assert_eq!(
            pinned_key(f.profile.path(), "acme.stats").as_deref(),
            Some(f.keypair.public_key_hex().as_str())
        );

        // And NOW the squatter is the one who reads as a publisher change.
        let err = resolve_libraries(
            &f.registry,
            f.profile.path(),
            &req("acme.stats", "1.0.0"),
            PinPolicy::Preview,
        )
        .unwrap_err();
        assert!(
            err.contains("changed since first use"),
            "the squatter must now be the one flagged, got: {err}"
        );
    }

    #[test]
    fn a_preview_still_refuses_a_key_that_contradicts_an_existing_pin() {
        // A preview must VERIFY against the pin even though it will not create
        // one - "does not write" must not be confused with "does not check".
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
        resolve_libraries(
            &f.registry,
            f.profile.path(),
            &req("acme.stats", "1.0.0"),
            PinPolicy::Install,
        )
        .unwrap();

        let other_profile = TempDir::new().unwrap();
        let impostor = PublisherKeypair::load_or_create(other_profile.path()).unwrap();
        publish_library(
            &f.registry,
            &impostor,
            "acme.stats",
            "1.0.1",
            "library",
            &[("stats", LIB_SRC)],
            true,
        );

        let err = resolve_libraries(
            &f.registry,
            f.profile.path(),
            &req("acme.stats", "1.0.1"),
            PinPolicy::Preview,
        )
        .unwrap_err();
        assert!(err.contains("changed since first use"), "got: {err}");
        // ...and the pin is untouched by the refusal.
        assert_eq!(
            pinned_key(f.profile.path(), "acme.stats").as_deref(),
            Some(f.keypair.public_key_hex().as_str())
        );
    }

    #[test]
    fn a_refused_install_pins_nothing() {
        // Everything that can refuse a package must refuse it BEFORE the pin is
        // written, or a hostile package gets to squat the name it just failed
        // to install under.
        let f = fixture();

        // (a) unsigned
        publish_library(
            &f.registry,
            &f.keypair,
            "acme.unsigned",
            "1.0.0",
            "library",
            &[("m", LIB_SRC)],
            false,
        );
        assert!(resolve_libraries(
            &f.registry,
            f.profile.path(),
            &req("acme.unsigned", "1.0.0"),
            PinPolicy::Install
        )
        .is_err());

        // (b) wrong kind
        publish_library(
            &f.registry,
            &f.keypair,
            "acme.report",
            "1.0.0",
            "report",
            &[("m", LIB_SRC)],
            true,
        );
        assert!(resolve_libraries(
            &f.registry,
            f.profile.path(),
            &req("acme.report", "1.0.0"),
            PinPolicy::Install
        )
        .is_err());

        assert!(
            !pin_store_exists(f.profile.path()),
            "a refused install must leave the pin store untouched"
        );
    }

    #[test]
    fn one_bad_package_in_a_batch_pins_none_of_them() {
        // `resolve_libraries` is all-or-nothing for the CALLER (it returns Err),
        // so it must be all-or-nothing for the pin store too: a batch that dies
        // part way must not leave the packages it already processed pinned to
        // keys the user never approved. Ordering matters here - "acme.bad"
        // sorts after "acme.good", so the good one is reached first.
        let f = fixture();
        publish_library(
            &f.registry,
            &f.keypair,
            "acme.good",
            "1.0.0",
            "library",
            &[("m", LIB_SRC)],
            true,
        );
        publish_library(
            &f.registry,
            &f.keypair,
            "acme.bad",
            "1.0.0",
            "report", // refused: not a library
            &[("m", LIB_SRC)],
            true,
        );

        let batch = vec![
            LibraryRequest {
                package: "acme.good".to_string(),
                pin: "1.0.0".to_string(),
                ..Default::default()
            },
            LibraryRequest {
                package: "acme.bad".to_string(),
                pin: "1.0.0".to_string(),
                ..Default::default()
            },
        ];
        assert!(
            resolve_libraries(&f.registry, f.profile.path(), &batch, PinPolicy::Install).is_err()
        );
        assert_eq!(
            pinned_key(f.profile.path(), "acme.good"),
            None,
            "a batch that fails must not leave partial pins behind"
        );
    }

    #[test]
    fn every_emitted_status_is_in_the_declared_vocabulary() {
        // The frontend renders `trustStatus`; a status missing from this list is
        // a status nobody wrote a presentation row for.
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
        for policy in [PinPolicy::Preview, PinPolicy::Install, PinPolicy::Preview] {
            let out = resolve_libraries(
                &f.registry,
                f.profile.path(),
                &req("acme.stats", "1.0.0"),
                policy,
            )
            .unwrap();
            assert!(
                LIBRARY_TRUST_STATUSES.contains(&out[0].trust_status.as_str()),
                "undeclared trust status: {}",
                out[0].trust_status
            );
        }
    }

    #[test]
    fn the_local_tofu_check_agrees_with_the_shared_calp_one_on_the_pinning_path() {
        // `verify_library_manifest` is a policy-aware copy of
        // `calp::integrity::verify_and_load_manifest_via`. Pin the two together
        // so the copy cannot silently drift from the shared implementation on
        // the behaviour they DO share: signature verification, and exactly what
        // lands in the pin store on first contact.
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

        let mine = TempDir::new().unwrap();
        let verified = verify_library_manifest(
            &f.registry,
            "acme.stats",
            "1.0.0",
            mine.path(),
            PinPolicy::Install,
        )
        .unwrap();
        // The local path proposes the pin and commits it separately; commit it
        // here so the two stores can be compared byte for byte.
        commit_pending_pins(
            mine.path(),
            &[(
                "acme.stats".to_string(),
                verified.pending_pin.clone().expect("install must propose a pin"),
            )],
        )
        .unwrap();
        let status = verified.status;
        let manifest = verified.manifest;

        let theirs = TempDir::new().unwrap();
        let (their_status, their_manifest) = calp::integrity::verify_and_load_manifest_via(
            &f.registry,
            "acme.stats",
            "1.0.0",
            theirs.path(),
        )
        .unwrap();

        assert_eq!(their_status, calp::integrity::TrustStatus::FirstUse);
        assert_eq!(status, LIB_TRUST_FIRST_USE);
        assert_eq!(manifest.publisher_key, their_manifest.publisher_key);
        assert_eq!(
            load_trusted_publishers(mine.path()).unwrap(),
            load_trusted_publishers(theirs.path()).unwrap(),
            "the local pinning path must write exactly what calp writes"
        );
    }
    // ------------------------------------------------------------------
    // Install-time expectations: the approved identity travels with the
    // request, so a registry that moves between review and approval is
    // refused BEFORE anything is pinned.
    // ------------------------------------------------------------------

    #[test]
    fn an_install_whose_publisher_changed_since_review_is_refused_and_pins_nothing() {
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

        // The user reviewed a DIFFERENT publisher key than the registry now
        // serves. Were the check done after the confirming call, the key the
        // attacker swapped in would already be pinned.
        let reviewed_key = "11".repeat(32);
        assert_ne!(reviewed_key, f.keypair.public_key_hex());
        let err = resolve_libraries(
            &f.registry,
            f.profile.path(),
            &approved("acme.stats", "1.0.0", &reviewed_key, "1.0.0"),
            PinPolicy::Install,
        )
        .unwrap_err();
        assert!(err.contains("changed between review and install"), "got: {err}");
        assert!(
            !pin_store_exists(f.profile.path()),
            "an install refused on identity must pin nothing"
        );
    }

    #[test]
    fn an_install_whose_floating_pin_moved_since_review_is_refused_and_pins_nothing() {
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
        publish_library(
            &f.registry,
            &f.keypair,
            "acme.stats",
            "1.4.0",
            "library",
            &[("stats", LIB_SRC)],
            true,
        );

        // "^1.0.0" resolved to 1.0.0 at review time; it now resolves to 1.4.0.
        let err = resolve_libraries(
            &f.registry,
            f.profile.path(),
            &approved("acme.stats", "^1.0.0", &f.keypair.public_key_hex(), "1.0.0"),
            PinPolicy::Install,
        )
        .unwrap_err();
        assert!(err.contains("changed between review and install"), "got: {err}");
        assert!(!pin_store_exists(f.profile.path()));
    }

    #[test]
    fn an_install_that_matches_the_review_pins_normally() {
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

        let out = resolve_libraries(
            &f.registry,
            f.profile.path(),
            &approved("acme.stats", "^1.2.0", &f.keypair.public_key_hex(), "1.2.4"),
            PinPolicy::Install,
        )
        .unwrap();
        assert_eq!(out[0].trust_status, LIB_TRUST_FIRST_USE);
        assert_eq!(
            pinned_key(f.profile.path(), "acme.stats").as_deref(),
            Some(f.keypair.public_key_hex().as_str())
        );
    }

    #[test]
    fn a_preview_ignores_install_time_expectations() {
        // A preview has no approval to honour, so an expectation attached to one
        // must not turn into a second, differently-shaped gate. It reports what
        // the registry actually holds.
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
        let out = resolve_libraries(
            &f.registry,
            f.profile.path(),
            &approved("acme.stats", "1.0.0", &"11".repeat(32), "9.9.9"),
            PinPolicy::Preview,
        )
        .unwrap();
        assert_eq!(out[0].trust_status, LIB_TRUST_NOT_INSTALLED);
        assert_eq!(out[0].resolved_version, "1.0.0");
        assert!(!pin_store_exists(f.profile.path()));
    }
}
