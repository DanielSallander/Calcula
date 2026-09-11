//! FILENAME: app/src-tauri/src/ai/builtin_model.rs
//! PURPOSE: The on-board model (Tier 1): which file it is, where it may live,
//!          and how it arrives — downloaded on first use after the frontend has
//!          collected one consent, resumed if interrupted, and refused unless
//!          its sha256 is the pinned one.
//! CONTEXT: Owner decision D6, 2026-09-10 (docs/design/open-items.md 2.AI.10):
//!          the engine ships in the installer, the weights do not. A gigabyte
//!          in an installer for a feature a user may never touch is the wrong
//!          default; a gigabyte downloaded WITHOUT asking is worse. So the
//!          sentence the model picker shows names the size, the licence, the
//!          source and the hash, and this module downloads nothing until the
//!          command that click reaches is invoked.
//!
//!          THE PIN IS THE TRUST. The URL is Hugging Face's, the hash is the
//!          LFS object id from the repository listing, and a file whose bytes
//!          hash differently is deleted with both hashes reported. There is no
//!          "use it anyway": a model file is code that runs on this machine in
//!          every sense that matters. `app/scripts/fetch-builtin-model.mjs`
//!          carries the same pin for a developer machine and for the offline
//!          installer; `builtinRuntimePins.test.ts` diffs the two.
//!
//!          WHY %LOCALAPPDATA% AND NOT %APPDATA%. The plan said the roaming
//!          app-data folder. A roaming profile syncs to the domain controller
//!          at sign-out, and a gigabyte in it turns every sign-out on a managed
//!          machine into a transfer. The local folder is for caches and large
//!          re-derivable artifacts, which is what a re-downloadable model is.
//!
//!          Qwen2.5-Coder-3B is under the "Qwen Research" licence and must
//!          never be a default; the 1.5B is Apache-2.0.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};

pub const MODEL_ID: &str = "qwen2.5-coder-1.5b-instruct-q4_k_m";
pub const MODEL_FILE: &str = "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf";
pub const MODEL_LABEL: &str = "Qwen2.5-Coder 1.5B Instruct (Q4_K_M)";
pub const MODEL_URL: &str =
    "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf";
pub const MODEL_SOURCE_URL: &str = "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF";
pub const MODEL_LICENCE: &str = "Apache-2.0";
pub const MODEL_SIZE_BYTES: u64 = 1_117_320_768;
pub const MODEL_SHA256: &str = "cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046";

/// How long a download may go without a single byte before it is abandoned.
/// The partial file is kept, so the cost of abandoning is one resume.
pub const STALL_SECS: u64 = 60;

/// Everything the consent sentence and the downloader need to know about the
/// model. Owned strings so a test can point the same downloader at a local
/// server with its own bytes and its own hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPin {
    pub id: String,
    pub file: String,
    pub label: String,
    pub url: String,
    pub source_url: String,
    pub licence: String,
    pub size_bytes: u64,
    pub sha256: String,
}

/// The pinned default model.
pub fn pin() -> ModelPin {
    ModelPin {
        id: MODEL_ID.into(),
        file: MODEL_FILE.into(),
        label: MODEL_LABEL.into(),
        url: MODEL_URL.into(),
        source_url: MODEL_SOURCE_URL.into(),
        licence: MODEL_LICENCE.into(),
        size_bytes: MODEL_SIZE_BYTES,
        sha256: MODEL_SHA256.into(),
    }
}

// ---------------------------------------------------------------------------
// Where the model may be
// ---------------------------------------------------------------------------

/// Where a copy came from. Only the DOWNLOADED copy is ever deleted by the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelOrigin {
    /// Shipped inside an offline installer (`models/` under the resource dir).
    Bundled,
    /// Fetched by `download` into the local app-data folder.
    Downloaded,
    /// A developer's copy in the source tree, debug builds only.
    Dev,
}

/// The folders searched, in the order they are searched.
#[derive(Debug, Clone)]
pub struct ModelDirs {
    pub bundled: Option<PathBuf>,
    pub downloads: PathBuf,
    pub dev: Option<PathBuf>,
}

impl ModelDirs {
    fn ordered(&self) -> Vec<(ModelOrigin, &Path)> {
        let mut out = Vec::new();
        if let Some(b) = &self.bundled {
            out.push((ModelOrigin::Bundled, b.as_path()));
        }
        out.push((ModelOrigin::Downloaded, self.downloads.as_path()));
        if let Some(d) = &self.dev {
            out.push((ModelOrigin::Dev, d.as_path()));
        }
        out
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Located {
    Found { path: PathBuf, origin: ModelOrigin },
    /// A file with the right name and the wrong size. Never used: llama-server
    /// would fail on it, or worse, load something that is not the pinned model.
    Mismatch { path: PathBuf, origin: ModelOrigin, size_bytes: u64 },
    Absent,
}

/// The first usable copy, bundled before downloaded before dev. A mismatch
/// is reported only when no folder holds a usable copy.
pub fn locate(dirs: &ModelDirs, pin: &ModelPin) -> Located {
    let mut first_mismatch: Option<Located> = None;
    for (origin, dir) in dirs.ordered() {
        let path = dir.join(&pin.file);
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        if !meta.is_file() {
            continue;
        }
        if meta.len() == pin.size_bytes {
            return Located::Found { path, origin };
        }
        if first_mismatch.is_none() {
            first_mismatch = Some(Located::Mismatch { path, origin, size_bytes: meta.len() });
        }
    }
    first_mismatch.unwrap_or(Located::Absent)
}

// ---------------------------------------------------------------------------
// The download
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub bytes: u64,
    pub total: u64,
    /// True while the finished file is being hashed, which on a slow disk is
    /// a visible pause after the bar reached the end.
    pub verifying: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadError {
    /// The cancel flag was raised. The partial file is kept for a resume.
    Cancelled { bytes: u64 },
    Failed(String),
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DownloadError::Cancelled { bytes } => {
                write!(f, "The download was stopped at {} bytes. It resumes from there next time.", bytes)
            }
            DownloadError::Failed(m) => f.write_str(m),
        }
    }
}

/// What the server's answer to a (possibly ranged) request means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponseAction {
    /// 200 with nothing on disk: write from the start.
    Fresh,
    /// 206 to a range request: append to what is there.
    Append,
    /// 200 to a range request: the server ignored the range, so the partial
    /// file is discarded rather than spliced onto a second copy of the head.
    Restart,
    Refuse(u16),
}

pub fn classify_response(status: u16, have: u64) -> ResponseAction {
    match (status, have) {
        (206, h) if h > 0 => ResponseAction::Append,
        (200, 0) => ResponseAction::Fresh,
        (200, _) => ResponseAction::Restart,
        (s, _) => ResponseAction::Refuse(s),
    }
}

/// sha256 of a file as lowercase hex, streamed in 1 MB reads.
pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| format!("Could not open {}: {}", path.display(), e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("Could not read {}: {}", path.display(), e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// The partial-download path beside the final one.
pub fn part_path(dest_dir: &Path, pin: &ModelPin) -> PathBuf {
    dest_dir.join(format!("{}.part", pin.file))
}

/// Whether a progress report is due: every 4 MB or every half second.
fn progress_due(last_bytes: u64, bytes: u64, last_at: Instant, now: Instant) -> bool {
    bytes - last_bytes >= 4 << 20 || now.duration_since(last_at) >= Duration::from_millis(500)
}

/// Download the pinned model into `dest_dir`, resuming a partial file, and
/// leave it under its final name only once the hash matches.
///
/// NOTHING HERE ASKS. Consent is collected by the picker before the command
/// that calls this is invoked, and the command is on the governed denylist so
/// a third-party extension cannot start a gigabyte download on a user's
/// behalf.
pub async fn download(
    pin: &ModelPin,
    dest_dir: &Path,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(DownloadProgress),
) -> Result<PathBuf, DownloadError> {
    let fail = |m: String| DownloadError::Failed(m);
    std::fs::create_dir_all(dest_dir)
        .map_err(|e| fail(format!("Could not create {}: {}", dest_dir.display(), e)))?;
    let final_path = dest_dir.join(&pin.file);
    let part = part_path(dest_dir, pin);

    let mut have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if have >= pin.size_bytes {
        let _ = std::fs::remove_file(&part);
        have = 0;
    }

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| fail(format!("HTTP client error: {}", e)))?;
    let mut req = client.get(&pin.url).header("user-agent", "calcula/0.1 (on-board model download)");
    if have > 0 {
        req = req.header("range", format!("bytes={}-", have));
    }
    let mut resp = req
        .send()
        .await
        .map_err(|e| fail(format!("Could not reach {}: {}", pin.url, super::error_chain(&e))))?;

    let action = classify_response(resp.status().as_u16(), have);
    match action {
        ResponseAction::Refuse(status) => {
            return Err(fail(format!("{} answered HTTP {}. The model was not downloaded.", pin.url, status)));
        }
        ResponseAction::Restart => have = 0,
        ResponseAction::Fresh | ResponseAction::Append => {}
    }
    if let Some(remaining) = resp.content_length() {
        if have + remaining != pin.size_bytes {
            return Err(fail(format!(
                "The server offers {} bytes but the pinned model is {} bytes. What is at {} is not the \
                 pinned model, so nothing was downloaded.",
                have + remaining,
                pin.size_bytes,
                pin.url,
            )));
        }
    }

    let mut file = if action == ResponseAction::Append {
        OpenOptions::new().append(true).open(&part)
    } else {
        File::create(&part)
    }
    .map_err(|e| fail(format!("Could not write {}: {}", part.display(), e)))?;

    let mut received = have;
    let mut last_report = (Instant::now(), received);
    on_progress(DownloadProgress { bytes: received, total: pin.size_bytes, verifying: false });
    loop {
        if cancel.load(Ordering::Relaxed) {
            drop(file);
            return Err(DownloadError::Cancelled { bytes: received });
        }
        let next = tokio::time::timeout(Duration::from_secs(STALL_SECS), resp.chunk()).await;
        let chunk = match next {
            Err(_) => {
                return Err(fail(format!(
                    "The download stalled for {} seconds at {} of {} bytes. The partial file is kept; the \
                     next attempt resumes from it.",
                    STALL_SECS, received, pin.size_bytes,
                )));
            }
            Ok(Err(e)) => {
                return Err(fail(format!(
                    "The download failed at {} of {} bytes: {}. The partial file is kept; the next attempt \
                     resumes from it.",
                    received,
                    pin.size_bytes,
                    super::error_chain(&e),
                )));
            }
            Ok(Ok(None)) => break,
            Ok(Ok(Some(bytes))) => bytes,
        };
        file.write_all(&chunk)
            .map_err(|e| fail(format!("Could not write {}: {}", part.display(), e)))?;
        received += chunk.len() as u64;
        let now = Instant::now();
        if progress_due(last_report.1, received, last_report.0, now) {
            last_report = (now, received);
            on_progress(DownloadProgress { bytes: received, total: pin.size_bytes, verifying: false });
        }
    }
    file.flush().map_err(|e| fail(format!("Could not flush {}: {}", part.display(), e)))?;
    drop(file);

    let size = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if size != pin.size_bytes {
        return Err(fail(format!(
            "The download ended at {} bytes; the pinned model is {} bytes. The partial file is kept; the \
             next attempt resumes from it.",
            size, pin.size_bytes,
        )));
    }

    on_progress(DownloadProgress { bytes: size, total: pin.size_bytes, verifying: true });
    let to_hash = part.clone();
    let actual = tokio::task::spawn_blocking(move || sha256_file(&to_hash))
        .await
        .map_err(|e| fail(format!("Hashing the download failed: {}", e)))?
        .map_err(fail)?;
    if actual != pin.sha256 {
        let _ = std::fs::remove_file(&part);
        return Err(fail(format!(
            "The downloaded file's sha256 is {} but the pinned model's is {}. The bytes are not the pinned \
             model, so they were deleted and nothing was installed.",
            actual, pin.sha256,
        )));
    }
    std::fs::rename(&part, &final_path)
        .map_err(|e| fail(format!("Could not move the verified model into place: {}", e)))?;
    Ok(final_path)
}

/// Remove the DOWNLOADED copy and any partial download. Bundled and dev copies
/// are never touched: they are not the app's to delete.
pub fn delete_downloaded(dirs: &ModelDirs, pin: &ModelPin) -> Result<bool, String> {
    let mut removed = false;
    for path in [dirs.downloads.join(&pin.file), part_path(&dirs.downloads, pin)] {
        match std::fs::remove_file(&path) {
            Ok(()) => removed = true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Could not delete {}: {}", path.display(), e)),
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn the_pin_names_the_apache_licensed_1_5b() {
        let p = pin();
        assert_eq!(p.id, MODEL_ID);
        assert!(p.file.ends_with(".gguf"));
        assert!(p.file.contains("1.5b"), "the 3B is Qwen-Research licensed and must never be the default");
        assert_eq!(p.licence, "Apache-2.0");
        assert!(p.url.starts_with("https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/"));
        assert!(p.url.ends_with(&p.file));
        assert_eq!(p.sha256.len(), 64);
        assert!(p.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert!(p.size_bytes > 1_000_000_000);
    }

    #[test]
    fn the_pin_serializes_camel_case_for_the_picker() {
        let v = serde_json::to_value(pin()).unwrap();
        assert!(v.get("sizeBytes").is_some());
        assert!(v.get("sourceUrl").is_some());
        assert!(v.get("size_bytes").is_none());
    }

    #[test]
    fn classify_response_reads_a_range_answer_the_way_the_downloader_must() {
        assert_eq!(classify_response(200, 0), ResponseAction::Fresh);
        assert_eq!(classify_response(206, 4096), ResponseAction::Append);
        // The trap: a server that ignores the range answers 200 with the whole
        // file, and appending that to a partial copy splices two heads.
        assert_eq!(classify_response(200, 4096), ResponseAction::Restart);
        assert_eq!(classify_response(206, 0), ResponseAction::Refuse(206));
        assert_eq!(classify_response(404, 0), ResponseAction::Refuse(404));
        assert_eq!(classify_response(416, 4096), ResponseAction::Refuse(416));
    }

    #[test]
    fn sha256_file_matches_a_known_digest() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("abc.txt");
        std::fs::write(&p, b"abc").unwrap();
        assert_eq!(
            sha256_file(&p).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
    }

    fn test_pin(dir: &Path, name: &str, bytes: &[u8], url: &str) -> ModelPin {
        let _ = dir;
        ModelPin {
            id: "test-model".into(),
            file: name.into(),
            label: "Test model".into(),
            url: url.into(),
            source_url: "http://example.invalid".into(),
            licence: "MIT".into(),
            size_bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
        }
    }

    #[test]
    fn locate_prefers_bundled_then_downloaded_then_dev_and_never_a_wrong_sized_file() {
        let root = tempfile::tempdir().unwrap();
        let bundled = root.path().join("bundled");
        let downloads = root.path().join("downloads");
        let dev = root.path().join("dev");
        for d in [&bundled, &downloads, &dev] {
            std::fs::create_dir_all(d).unwrap();
        }
        let good = vec![7u8; 1000];
        let p = test_pin(root.path(), "m.gguf", &good, "http://unused");
        let dirs = ModelDirs { bundled: Some(bundled.clone()), downloads: downloads.clone(), dev: Some(dev.clone()) };

        assert_eq!(locate(&dirs, &p), Located::Absent);

        std::fs::write(dev.join("m.gguf"), &good).unwrap();
        assert!(matches!(locate(&dirs, &p), Located::Found { origin: ModelOrigin::Dev, .. }));

        std::fs::write(downloads.join("m.gguf"), &good).unwrap();
        assert!(matches!(locate(&dirs, &p), Located::Found { origin: ModelOrigin::Downloaded, .. }));

        // A wrong-sized file in the preferred slot is skipped in favour of the
        // good copy further down the list...
        std::fs::write(bundled.join("m.gguf"), b"short").unwrap();
        assert!(matches!(locate(&dirs, &p), Located::Found { origin: ModelOrigin::Downloaded, .. }));

        // ...and reported, not used, when it is the only one.
        std::fs::remove_file(downloads.join("m.gguf")).unwrap();
        std::fs::remove_file(dev.join("m.gguf")).unwrap();
        match locate(&dirs, &p) {
            Located::Mismatch { origin, size_bytes, .. } => {
                assert_eq!(origin, ModelOrigin::Bundled);
                assert_eq!(size_bytes, 5);
            }
            other => panic!("expected a mismatch, got {:?}", other),
        }
    }

    #[test]
    fn delete_downloaded_touches_only_the_download_folder() {
        let root = tempfile::tempdir().unwrap();
        let bundled = root.path().join("bundled");
        let downloads = root.path().join("downloads");
        std::fs::create_dir_all(&bundled).unwrap();
        std::fs::create_dir_all(&downloads).unwrap();
        let p = test_pin(root.path(), "m.gguf", b"xyz", "http://unused");
        std::fs::write(bundled.join("m.gguf"), b"xyz").unwrap();
        std::fs::write(downloads.join("m.gguf"), b"xyz").unwrap();
        std::fs::write(downloads.join("m.gguf.part"), b"x").unwrap();
        let dirs = ModelDirs { bundled: Some(bundled.clone()), downloads: downloads.clone(), dev: None };
        assert!(delete_downloaded(&dirs, &p).unwrap());
        assert!(!downloads.join("m.gguf").exists());
        assert!(!downloads.join("m.gguf.part").exists());
        assert!(bundled.join("m.gguf").exists(), "the bundled copy is not the app's to delete");
        assert!(!delete_downloaded(&dirs, &p).unwrap(), "nothing left to remove");
    }

    // ---- A tiny HTTP server that speaks enough for the downloader ----------

    struct Served {
        url: String,
        range_requests: Arc<AtomicUsize>,
    }

    /// Serve `payload` at `/m.bin`. `honour_range` false answers every request
    /// with 200 and the whole body, the way a server that ignores Range does.
    /// `sizes` lets a test lie about Content-Length.
    async fn serve(payload: Arc<Vec<u8>>, honour_range: bool) -> Served {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let range_requests = Arc::new(AtomicUsize::new(0));
        let seen = range_requests.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let payload = payload.clone();
                let seen = seen.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 1024];
                    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        let Ok(n) = sock.read(&mut tmp).await else { return };
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    let head = String::from_utf8_lossy(&buf).to_string();
                    let range = head
                        .lines()
                        .find(|l| l.to_ascii_lowercase().starts_with("range:"))
                        .and_then(|l| l.split('=').nth(1))
                        .and_then(|v| v.trim().trim_end_matches('-').parse::<usize>().ok());
                    if range.is_some() {
                        seen.fetch_add(1, Ordering::SeqCst);
                    }
                    let (status, start) = match (range, honour_range) {
                        (Some(s), true) => ("206 Partial Content", s.min(payload.len())),
                        _ => ("200 OK", 0),
                    };
                    let body = &payload[start..];
                    let mut response = format!(
                        "HTTP/1.1 {}\r\nContent-Length: {}\r\nConnection: close\r\n",
                        status,
                        body.len()
                    );
                    if start > 0 {
                        response.push_str(&format!(
                            "Content-Range: bytes {}-{}/{}\r\n",
                            start,
                            payload.len() - 1,
                            payload.len()
                        ));
                    }
                    response.push_str("\r\n");
                    let _ = sock.write_all(response.as_bytes()).await;
                    let _ = sock.write_all(body).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        Served { url: format!("http://{}/m.bin", addr), range_requests }
    }

    fn payload(len: usize) -> Arc<Vec<u8>> {
        Arc::new((0..len).map(|i| (i % 251) as u8).collect())
    }

    #[tokio::test]
    async fn a_download_that_matches_the_pin_lands_under_its_final_name() {
        let bytes = payload(1_300_000);
        let served = serve(bytes.clone(), true).await;
        let dir = tempfile::tempdir().unwrap();
        let p = test_pin(dir.path(), "m.gguf", &bytes, &served.url);
        let cancel = AtomicBool::new(false);
        let mut reports = Vec::new();
        let path = download(&p, dir.path(), &cancel, |pr| reports.push(pr)).await.unwrap();
        assert_eq!(path, dir.path().join("m.gguf"));
        assert_eq!(std::fs::read(&path).unwrap(), *bytes);
        assert!(!part_path(dir.path(), &p).exists());
        assert!(reports.iter().any(|r| r.verifying), "the hashing pause is reported");
        assert_eq!(reports.first().map(|r| r.bytes), Some(0));
        assert_eq!(served.range_requests.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_download_whose_bytes_differ_from_the_pin_is_refused_and_removed() {
        let bytes = payload(200_000);
        let served = serve(bytes.clone(), true).await;
        let dir = tempfile::tempdir().unwrap();
        let mut p = test_pin(dir.path(), "m.gguf", &bytes, &served.url);
        // Same size, different hash: the case a corrupted or substituted file presents.
        p.sha256 = "0".repeat(64);
        let cancel = AtomicBool::new(false);
        let err = download(&p, dir.path(), &cancel, |_| {}).await.unwrap_err();
        match err {
            DownloadError::Failed(m) => {
                assert!(m.contains("sha256"), "{}", m);
                assert!(m.contains(&"0".repeat(64)), "both hashes are reported: {}", m);
            }
            other => panic!("expected a failure, got {:?}", other),
        }
        assert!(!dir.path().join("m.gguf").exists(), "nothing installed");
        assert!(!part_path(dir.path(), &p).exists(), "the bad bytes are not kept for a resume either");
    }

    #[tokio::test]
    async fn a_server_offering_a_different_size_is_refused_before_a_byte_is_kept() {
        let bytes = payload(50_000);
        let served = serve(bytes.clone(), true).await;
        let dir = tempfile::tempdir().unwrap();
        let mut p = test_pin(dir.path(), "m.gguf", &bytes, &served.url);
        p.size_bytes += 1;
        let cancel = AtomicBool::new(false);
        let err = download(&p, dir.path(), &cancel, |_| {}).await.unwrap_err();
        assert!(matches!(&err, DownloadError::Failed(m) if m.contains("offers")), "{:?}", err);
        assert!(!part_path(dir.path(), &p).exists());
    }

    #[tokio::test]
    async fn a_cancelled_download_keeps_its_part_and_the_next_attempt_resumes_with_a_range() {
        // Twelve megabytes, not three: progress is reported every 4 MB or
        // 500 ms, and a 3 MB payload arrives over loopback inside 500 ms, so
        // the only report with bytes > 0 was the "verifying" one after the
        // download had already finished — which is what the first version of
        // this test measured.
        let bytes = payload(12_000_000);
        let served = serve(bytes.clone(), true).await;
        let dir = tempfile::tempdir().unwrap();
        let p = test_pin(dir.path(), "m.gguf", &bytes, &served.url);

        // Cancel from inside the first progress report after some bytes landed.
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let err = download(&p, dir.path(), &cancel, move |pr| {
            if pr.bytes > 0 {
                flag.store(true, Ordering::SeqCst);
            }
        })
        .await
        .unwrap_err();
        let kept = match err {
            DownloadError::Cancelled { bytes } => bytes,
            other => panic!("expected Cancelled, got {:?}", other),
        };
        assert!(kept > 0 && kept < bytes.len() as u64, "stopped part-way: {}", kept);
        assert_eq!(std::fs::metadata(part_path(dir.path(), &p)).unwrap().len(), kept);
        assert!(!dir.path().join("m.gguf").exists());

        // The resume asks for the rest and the whole file still verifies.
        cancel.store(false, Ordering::SeqCst);
        let path = download(&p, dir.path(), &cancel, |_| {}).await.unwrap();
        assert_eq!(served.range_requests.load(Ordering::SeqCst), 1, "exactly one Range request");
        assert_eq!(std::fs::read(&path).unwrap(), *bytes);
    }

    #[tokio::test]
    async fn a_server_that_ignores_the_range_makes_the_download_start_over_and_still_verify() {
        let bytes = payload(900_000);
        let served = serve(bytes.clone(), false).await;
        let dir = tempfile::tempdir().unwrap();
        let p = test_pin(dir.path(), "m.gguf", &bytes, &served.url);
        // A stale partial copy that is NOT a prefix of the payload: appending the
        // whole file to it would produce a corrupt file that only the hash catches.
        std::fs::write(part_path(dir.path(), &p), vec![0xEEu8; 10_000]).unwrap();
        let cancel = AtomicBool::new(false);
        let path = download(&p, dir.path(), &cancel, |_| {}).await.unwrap();
        assert_eq!(served.range_requests.load(Ordering::SeqCst), 1, "the resume was attempted");
        assert_eq!(std::fs::read(&path).unwrap(), *bytes, "and the ignored range restarted cleanly");
    }

    #[tokio::test]
    async fn an_unreachable_url_is_reported_as_unreachable_with_nothing_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let p = test_pin(dir.path(), "m.gguf", b"data", "http://127.0.0.1:1/m.bin");
        let cancel = AtomicBool::new(false);
        let err = download(&p, dir.path(), &cancel, |_| {}).await.unwrap_err();
        assert!(matches!(&err, DownloadError::Failed(m) if m.contains("Could not reach")), "{:?}", err);
        assert!(!part_path(dir.path(), &p).exists());
    }
}
