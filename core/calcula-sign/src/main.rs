//! FILENAME: core/calcula-sign/src/main.rs
//! PURPOSE: The author-facing CLI that makes a third-party Calcula add-in
//!          shippable: hold a publisher keypair, stamp + sign a sidecar
//!          manifest, and produce `<base>.manifest.sig`.
//! CONTEXT: Wave F built the sandboxed contribution API and capped every
//!          contribution by the SIGNED sidecar manifest — but nothing produced
//!          a signature, so `formula.udf` (and therefore worksheet functions,
//!          the headline add-in capability) was unreachable for any third
//!          party. This tool is that on-ramp.
//!
//!          THREE RULES IT EXISTS TO KEEP:
//!
//!          1. ONE TRUST ROOT. It signs with `calp::signing::PublisherKeypair`
//!             out of the same per-user profile directory `.calp` publishing
//!             uses (`%LOCALAPPDATA%\Calcula\publisher-key.json`). An author has
//!             ONE publisher identity across packages and add-ins; the app has
//!             one TOFU store. No new crypto is written here.
//!
//!          2. THE SIGNATURE COVERS THE CODE. A signature over the manifest
//!             alone would authenticate a *description* of an add-in while
//!             leaving the executed bytes free to be swapped — and "signed"
//!             would imply far more than it delivered. So `sign` computes the
//!             SHA-256 of the bundle the host imports and writes it into the
//!             manifest as `codeHash` BEFORE signing. The host re-checks it.
//!
//!          3. THE PRIVATE KEY NEVER LEAVES THE PROFILE. It is never printed,
//!             never copied into the add-in folder, and never accepted as a
//!             command-line argument.
//!
//! USAGE (see docs/design/third-party-addin-authoring.md §7):
//!   calcula-sign key show   [--profile <dir>]
//!   calcula-sign key init   [--profile <dir>]
//!   calcula-sign sign   <folder | bundle.js | name.manifest.json> [--profile <dir>]
//!   calcula-sign verify <folder | bundle.js | name.manifest.json>

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use calp::signing::{
    check_extension_code_hash, extension_code_hash, extension_layout_for_source,
    verify_signature, CodeHashStatus, ExtensionBundleLayout, PublisherKeypair,
    EXTENSION_CODE_HASH_FIELD,
};

const USAGE: &str = "\
calcula-sign - sign a Calcula add-in's sidecar manifest (Ed25519)

USAGE:
  calcula-sign key show   [--profile <dir>]
  calcula-sign key init   [--profile <dir>]
  calcula-sign sign   <target> [--profile <dir>]
  calcula-sign verify <target>

  <target> is the add-in FOLDER, its bundle <name>.js, or <name>.manifest.json.

COMMANDS:
  key show    Print this profile's publisher public key. Never prints the secret.
  key init    Create the publisher keypair if this profile has none.
  sign        Stamp publisherKey + codeHash into the manifest, then sign the
              manifest bytes and write <base>.manifest.sig next to it.
  verify      Re-check a signed add-in exactly the way Calcula will: signature
              over the manifest bytes, then codeHash against the bundle.

OPTIONS:
  --profile <dir>   Publisher profile directory holding publisher-key.json.
                    Defaults to %LOCALAPPDATA%\\Calcula (the same identity the
                    app uses to publish .calp packages).

NOTES:
  * `sign` REWRITES the manifest (pretty-printed, keys sorted) before signing,
    because the signature is over the bytes exactly as they land on disk.
  * The private key stays in the profile directory. Back that directory up and
    keep it off shared drives: whoever holds it can publish as you.
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(msg) => {
            eprintln!("[FAIL] {}", msg);
            ExitCode::FAILURE
        }
    }
}

// ---------------------------------------------------------------------------
// Argument handling
// ---------------------------------------------------------------------------

/// Pull `--profile <dir>` out of the argument list, returning the remainder.
/// Returns an error for a `--profile` with no value or any unknown `--flag`.
fn take_profile(args: &[String]) -> Result<(Option<PathBuf>, Vec<String>), String> {
    let mut profile: Option<PathBuf> = None;
    let mut rest: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if a == "--profile" {
            let v = args
                .get(i + 1)
                .ok_or_else(|| "--profile needs a directory".to_string())?;
            profile = Some(PathBuf::from(v));
            i += 2;
            continue;
        }
        if let Some(v) = a.strip_prefix("--profile=") {
            profile = Some(PathBuf::from(v));
            i += 1;
            continue;
        }
        if a.starts_with("--") {
            return Err(format!("unknown option '{}'\n\n{}", a, USAGE));
        }
        rest.push(a.clone());
        i += 1;
    }
    Ok((profile, rest))
}

/// The default publisher profile directory — byte-for-byte the one the app uses
/// (`app/src-tauri/src/calp_commands.rs::calcula_profile_dir`), so `calcula-sign`
/// and in-app `.calp` publishing are the SAME publisher identity.
fn default_profile_dir() -> PathBuf {
    let local_app_data = std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("XDG_DATA_HOME"))
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(local_app_data).join("Calcula")
}

fn run(args: &[String]) -> Result<(), String> {
    let (profile, rest) = take_profile(args)?;
    let profile_dir = profile.unwrap_or_else(default_profile_dir);

    match rest.first().map(String::as_str) {
        None | Some("help") | Some("-h") => {
            print!("{}", USAGE);
            Ok(())
        }
        Some("key") => match rest.get(1).map(String::as_str) {
            Some("show") => cmd_key_show(&profile_dir),
            Some("init") => cmd_key_init(&profile_dir),
            other => Err(format!(
                "'key' needs 'show' or 'init' (got {:?})\n\n{}",
                other.unwrap_or(""),
                USAGE
            )),
        },
        Some("sign") => {
            let target = rest
                .get(1)
                .ok_or_else(|| format!("'sign' needs a target\n\n{}", USAGE))?;
            cmd_sign(Path::new(target), &profile_dir)
        }
        Some("verify") => {
            let target = rest
                .get(1)
                .ok_or_else(|| format!("'verify' needs a target\n\n{}", USAGE))?;
            cmd_verify(Path::new(target))
        }
        Some(other) => Err(format!("unknown command '{}'\n\n{}", other, USAGE)),
    }
}

// ---------------------------------------------------------------------------
// key show / key init
// ---------------------------------------------------------------------------

fn cmd_key_show(profile_dir: &Path) -> Result<(), String> {
    match PublisherKeypair::load_existing(profile_dir).map_err(|e| e.to_string())? {
        Some(kp) => {
            println!("Profile      : {}", profile_dir.display());
            println!("Publisher    : {}", kp.display_name());
            println!("Public key   : {}", kp.public_key_hex());
            println!();
            println!("This is the key subscribers pin. The matching private key stays in");
            println!("{}\\publisher-key.json and is never printed.", profile_dir.display());
            Ok(())
        }
        None => Err(format!(
            "no publisher keypair in '{}'. Run: calcula-sign key init",
            profile_dir.display()
        )),
    }
}

fn cmd_key_init(profile_dir: &Path) -> Result<(), String> {
    let existed = PublisherKeypair::load_existing(profile_dir)
        .map_err(|e| e.to_string())?
        .is_some();
    // load_or_create generates with the OS CSPRNG when absent, and is a no-op
    // otherwise — so init is idempotent and can NEVER rotate a key by accident.
    let kp = PublisherKeypair::load_or_create(profile_dir).map_err(|e| e.to_string())?;
    if existed {
        println!("[OK] Publisher keypair already exists (unchanged).");
    } else {
        println!("[OK] Publisher keypair created with the OS CSPRNG.");
    }
    println!("Profile      : {}", profile_dir.display());
    println!("Publisher    : {}", kp.display_name());
    println!("Public key   : {}", kp.public_key_hex());
    println!();
    println!("BACK UP '{}\\publisher-key.json'.", profile_dir.display());
    println!("Losing it means your next release signs with a DIFFERENT key, which every");
    println!("existing user sees as a publisher CHANGE (their add-in's capabilities are");
    println!("revoked until they explicitly accept the new key).");
    Ok(())
}

// ---------------------------------------------------------------------------
// sign
// ---------------------------------------------------------------------------

/// Fields a sidecar manifest must carry before it is worth signing. Validated
/// here so an author finds out at sign time, not from a silent no-op in the app.
fn validate_manifest(manifest: &serde_json::Value) -> Result<(String, String), String> {
    let obj = manifest
        .as_object()
        .ok_or_else(|| "the manifest must be a JSON object".to_string())?;

    let id = obj
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if id.is_empty() {
        return Err("the manifest needs a non-empty \"id\" (e.g. \"acme.tax-tools\")".to_string());
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    {
        return Err(format!(
            "manifest id '{}' may only contain A-Z a-z 0-9 . - _",
            id
        ));
    }

    let version = obj
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if version.is_empty() {
        return Err("the manifest needs a non-empty \"version\"".to_string());
    }

    if obj.get("workerSupport").and_then(|v| v.as_bool()) != Some(true) {
        return Err(
            "the manifest must declare \"workerSupport\": true — Calcula refuses third-party \
             code on the main thread, so a bundle without it can never run"
                .to_string(),
        );
    }

    Ok((id, version))
}

fn cmd_sign(target: &Path, profile_dir: &Path) -> Result<(), String> {
    let layout = extension_layout_for_source(target).map_err(|e| e.to_string())?;
    let ExtensionBundleLayout {
        manifest: manifest_path,
        signature: sig_path,
        bundle: bundle_path,
    } = layout;

    if !manifest_path.is_file() {
        return Err(format!(
            "no sidecar manifest at '{}'. Every add-in needs one: it is what Calcula reads \
             (without running your code) to tell the user what you will install.",
            manifest_path.display()
        ));
    }
    if !bundle_path.is_file() {
        return Err(format!(
            "no bundle at '{}'. The signature must cover the code, so the file has to exist.",
            bundle_path.display()
        ));
    }

    let raw = std::fs::read(&manifest_path).map_err(|e| e.to_string())?;
    let mut manifest: serde_json::Value = serde_json::from_slice(&raw)
        .map_err(|e| format!("'{}' is not valid JSON: {}", manifest_path.display(), e))?;
    let (id, version) = validate_manifest(&manifest)?;

    let keypair = PublisherKeypair::load_existing(profile_dir)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| {
            format!(
                "no publisher keypair in '{}'. Run 'calcula-sign key init' first — signing must \
                 never silently mint a new identity.",
                profile_dir.display()
            )
        })?;
    let public_key = keypair.public_key_hex();

    // The code hash goes in BEFORE signing: that is the entire reason a
    // signature over the manifest says anything about the executed bytes.
    let code_hash = extension_code_hash(&bundle_path).map_err(|e| e.to_string())?;
    {
        let obj = manifest
            .as_object_mut()
            .ok_or_else(|| "the manifest must be a JSON object".to_string())?;
        obj.insert(
            "publisherKey".to_string(),
            serde_json::Value::String(public_key.clone()),
        );
        obj.insert(
            EXTENSION_CODE_HASH_FIELD.to_string(),
            serde_json::Value::String(code_hash.clone()),
        );
    }

    // Write the manifest EXACTLY as it will be signed, then re-read those bytes
    // so the signature can never be over anything but what is on disk.
    let canonical = format!(
        "{}\n",
        serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?
    );
    std::fs::write(&manifest_path, canonical.as_bytes()).map_err(|e| e.to_string())?;
    let signed_bytes = std::fs::read(&manifest_path).map_err(|e| e.to_string())?;

    let signature = keypair.sign(&signed_bytes);
    std::fs::write(&sig_path, format!("{}\n", signature)).map_err(|e| e.to_string())?;

    // Prove the artifact we just wrote verifies, before claiming success.
    verify_signature(&public_key, &signed_bytes, &signature, &id, &version)
        .map_err(|e| format!("self-check failed after writing the signature: {}", e))?;

    println!("[OK] Signed {} v{}", id, version);
    println!("  manifest : {}", manifest_path.display());
    println!("  bundle   : {}", bundle_path.display());
    println!("  signature: {}", sig_path.display());
    println!("  publisher: {}", public_key);
    println!("  codeHash : {}", code_hash);
    println!();
    println!("Ship all three files together. Re-run 'calcula-sign sign' after ANY change to");
    println!("the bundle or the manifest — an edited bundle no longer matches codeHash and");
    println!("Calcula will report the add-in as tampered.");
    Ok(())
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

fn cmd_verify(target: &Path) -> Result<(), String> {
    let layout = extension_layout_for_source(target).map_err(|e| e.to_string())?;
    let raw = std::fs::read(&layout.manifest)
        .map_err(|e| format!("cannot read '{}': {}", layout.manifest.display(), e))?;
    let manifest: serde_json::Value = serde_json::from_slice(&raw)
        .map_err(|e| format!("'{}' is not valid JSON: {}", layout.manifest.display(), e))?;
    let (id, version) = validate_manifest(&manifest)?;

    let publisher_key = manifest
        .get("publisherKey")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if publisher_key.is_empty() {
        return Err(
            "the manifest carries no publisherKey — this add-in is UNSIGNED. Calcula will load \
             it but zero its capabilities, so it cannot register worksheet functions."
                .to_string(),
        );
    }
    let sig_hex = std::fs::read_to_string(&layout.signature)
        .map_err(|_| {
            format!(
                "no signature at '{}' — run 'calcula-sign sign' on this add-in",
                layout.signature.display()
            )
        })?
        .trim()
        .to_string();

    verify_signature(&publisher_key, &raw, &sig_hex, &id, &version)
        .map_err(|e| format!("{}", e))?;

    let code = check_extension_code_hash(&manifest, &layout.bundle);
    match code {
        CodeHashStatus::Match => {}
        CodeHashStatus::NotDeclared => {
            return Err(format!(
                "the signature is valid but the manifest declares no {} — it authenticates the \
                 DESCRIPTION of '{}' and not its code. Re-sign with this tool.",
                EXTENSION_CODE_HASH_FIELD, id
            ));
        }
        CodeHashStatus::Mismatch => {
            return Err(format!(
                "TAMPERED: '{}' does not match the codeHash inside the signed manifest. The \
                 bundle changed after signing.",
                layout.bundle.display()
            ));
        }
        CodeHashStatus::BundleUnreadable => {
            return Err(format!(
                "cannot read the bundle '{}' to check codeHash",
                layout.bundle.display()
            ));
        }
    }

    println!("[OK] {} v{} verifies", id, version);
    println!("  publisher: {}", publisher_key);
    println!("  manifest : signature valid over {} bytes", raw.len());
    println!("  bundle   : {} matches codeHash", layout.bundle.display());
    println!();
    println!("On first install Calcula pins this publisher key under 'ext:{}'.", id);
    println!("A later release signed by a DIFFERENT key is reported as a publisher change and");
    println!("must be accepted explicitly.");
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_addin(dir: &Path, manifest: &str, code: &str) {
        std::fs::write(dir.join("demo.js"), code).unwrap();
        std::fs::write(dir.join("demo.manifest.json"), manifest).unwrap();
    }

    const GOOD_MANIFEST: &str = r#"{
      "id": "acme.demo",
      "name": "Demo",
      "version": "1.0.0",
      "workerSupport": true,
      "publisherKey": "",
      "capabilities": ["formula.udf"],
      "contributes": { "formulas": ["DEMO"] }
    }"#;

    #[test]
    fn sign_then_verify_roundtrip() {
        let profile = TempDir::new().unwrap();
        let src = TempDir::new().unwrap();
        write_addin(src.path(), GOOD_MANIFEST, "export default {};");

        cmd_key_init(profile.path()).unwrap();
        cmd_sign(src.path(), profile.path()).unwrap();
        cmd_verify(src.path()).unwrap();

        // The signature file exists and the manifest was stamped.
        assert!(src.path().join("demo.manifest.sig").is_file());
        let m: serde_json::Value =
            serde_json::from_slice(&std::fs::read(src.path().join("demo.manifest.json")).unwrap())
                .unwrap();
        assert_eq!(m["publisherKey"].as_str().unwrap().len(), 64);
        assert_eq!(m[EXTENSION_CODE_HASH_FIELD].as_str().unwrap().len(), 64);
    }

    #[test]
    fn verify_detects_code_tampering_after_signing() {
        let profile = TempDir::new().unwrap();
        let src = TempDir::new().unwrap();
        write_addin(src.path(), GOOD_MANIFEST, "export default {};");
        cmd_key_init(profile.path()).unwrap();
        cmd_sign(src.path(), profile.path()).unwrap();

        // Swap the CODE only; manifest + signature untouched.
        std::fs::write(src.path().join("demo.js"), "/* evil */ export default {};").unwrap();
        let err = cmd_verify(src.path()).unwrap_err();
        assert!(err.contains("TAMPERED"), "unexpected: {err}");
    }

    #[test]
    fn verify_detects_manifest_tampering_after_signing() {
        let profile = TempDir::new().unwrap();
        let src = TempDir::new().unwrap();
        write_addin(src.path(), GOOD_MANIFEST, "export default {};");
        cmd_key_init(profile.path()).unwrap();
        cmd_sign(src.path(), profile.path()).unwrap();

        // Widen the declared capability set by hand.
        let path = src.path().join("demo.manifest.json");
        let text = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, text.replace("formula.udf", "net.fetch")).unwrap();
        let err = cmd_verify(src.path()).unwrap_err();
        assert!(err.contains("signature"), "unexpected: {err}");
    }

    #[test]
    fn sign_refuses_without_a_keypair() {
        let profile = TempDir::new().unwrap();
        let src = TempDir::new().unwrap();
        write_addin(src.path(), GOOD_MANIFEST, "export default {};");
        let err = cmd_sign(src.path(), profile.path()).unwrap_err();
        assert!(err.contains("key init"), "unexpected: {err}");
        assert!(!src.path().join("demo.manifest.sig").exists());
    }

    #[test]
    fn sign_refuses_a_manifest_that_could_never_run() {
        let profile = TempDir::new().unwrap();
        cmd_key_init(profile.path()).unwrap();

        for (bad, needle) in [
            (r#"{"id":"","version":"1.0.0","workerSupport":true}"#, "id"),
            (r#"{"id":"a b","version":"1.0.0","workerSupport":true}"#, "id"),
            (r#"{"id":"acme.d","version":"","workerSupport":true}"#, "version"),
            (r#"{"id":"acme.d","version":"1.0.0"}"#, "workerSupport"),
        ] {
            let src = TempDir::new().unwrap();
            write_addin(src.path(), bad, "export default {};");
            let err = cmd_sign(src.path(), profile.path()).unwrap_err();
            assert!(err.contains(needle), "for {bad}: unexpected {err}");
            assert!(!src.path().join("demo.manifest.sig").exists());
        }
    }

    #[test]
    fn signing_twice_is_stable_and_re_signing_tracks_the_code() {
        let profile = TempDir::new().unwrap();
        let src = TempDir::new().unwrap();
        write_addin(src.path(), GOOD_MANIFEST, "export default {};");
        cmd_key_init(profile.path()).unwrap();

        cmd_sign(src.path(), profile.path()).unwrap();
        let first = std::fs::read_to_string(src.path().join("demo.manifest.sig")).unwrap();
        cmd_sign(src.path(), profile.path()).unwrap();
        let second = std::fs::read_to_string(src.path().join("demo.manifest.sig")).unwrap();
        // Ed25519 is deterministic and the canonical manifest is stable.
        assert_eq!(first, second);

        // Change the code, re-sign: the add-in verifies again.
        std::fs::write(src.path().join("demo.js"), "export default { v: 2 };").unwrap();
        assert!(cmd_verify(src.path()).is_err());
        cmd_sign(src.path(), profile.path()).unwrap();
        cmd_verify(src.path()).unwrap();
    }

    #[test]
    fn directory_bundle_layout_is_supported() {
        let profile = TempDir::new().unwrap();
        let src = TempDir::new().unwrap();
        std::fs::write(src.path().join("index.js"), "export default {};").unwrap();
        std::fs::write(src.path().join("extension.manifest.json"), GOOD_MANIFEST).unwrap();
        cmd_key_init(profile.path()).unwrap();
        cmd_sign(src.path(), profile.path()).unwrap();
        cmd_verify(src.path()).unwrap();
        assert!(src.path().join("extension.manifest.sig").is_file());
    }

    #[test]
    fn key_show_never_prints_the_secret_and_init_is_idempotent() {
        let profile = TempDir::new().unwrap();
        assert!(cmd_key_show(profile.path()).is_err()); // nothing yet
        cmd_key_init(profile.path()).unwrap();
        let first = PublisherKeypair::load_existing(profile.path())
            .unwrap()
            .unwrap()
            .public_key_hex();
        cmd_key_init(profile.path()).unwrap();
        let second = PublisherKeypair::load_existing(profile.path())
            .unwrap()
            .unwrap()
            .public_key_hex();
        assert_eq!(first, second, "key init must never rotate an existing key");
        cmd_key_show(profile.path()).unwrap();
    }

    #[test]
    fn take_profile_parses_both_forms_and_rejects_junk() {
        let (p, rest) = take_profile(&["sign".into(), "x".into(), "--profile".into(), "d".into()])
            .unwrap();
        assert_eq!(p, Some(PathBuf::from("d")));
        assert_eq!(rest, vec!["sign".to_string(), "x".to_string()]);

        let (p2, _) = take_profile(&["--profile=e".into(), "verify".into()]).unwrap();
        assert_eq!(p2, Some(PathBuf::from("e")));

        assert!(take_profile(&["--profile".into()]).is_err());
        assert!(take_profile(&["--wat".into()]).is_err());
    }
}
