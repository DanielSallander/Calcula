//! FILENAME: app/src-tauri/src/ai/runtime.rs
//! PURPOSE: The on-board inference runtime (Tier 1): find the bundled
//!          llama-server, start it on a loopback port with the on-board model,
//!          hold it in a job object so it dies with the app, wait for it to be
//!          healthy, stop it when idle, and expose all of that as commands and
//!          as the base URL the completion path uses for the `calcula-builtin`
//!          provider.
//! CONTEXT: Owner decisions D6/D7, 2026-09-10 (docs/design/open-items.md
//!          2.AI.10; the reversal of the "no shipped runtime" anti-goal is
//!          docs/design/local-model-script-authoring.md §14). Every other
//!          provider is a server the USER runs; this one is a server Calcula
//!          runs, which changes three things:
//!
//!          1. THE PORT IS OURS TO PICK, so it is a free one, and the
//!             provider registry's entry carries a placeholder the completion
//!             commands never send to. `ensure_running` is the one function
//!             that knows the real port, and starting the runtime is a side
//!             effect of the first completion that needs it.
//!          2. THE PROCESS MUST NOT OUTLIVE US. A child of a GUI process that
//!             crashes keeps a gigabyte resident and a port bound with no
//!             window to close it from. The child is assigned to a Windows job
//!             object with KILL_ON_JOB_CLOSE; the job handle lives in the
//!             running record, so both a deliberate stop and our own death
//!             end it. The test spawns `ping`, drops the job, and watches it go.
//!          3. IDLE COSTS MEMORY. After `IDLE_UNLOAD_SECS` without a request
//!             the runtime is stopped and the frontend is told why, so the
//!             next request pays the load time again with a visible reason
//!             rather than a silent gigabyte held forever.
//!
//!          WHERE THE ENGINE IS. Not a Tauri `externalBin`: that must exist at
//!          every `cargo build` of this crate and carries only the executable,
//!          while llama-server needs its DLLs beside it. The whole folder is a
//!          bundled RESOURCE (`<resource dir>/llama-server/`, mapped by the
//!          `tauri.runtime-<arch>.conf.json` overlay at release time); a debug
//!          build also looks in the source tree, where
//!          `app/scripts/fetch-llama-server.mjs` puts it; and the
//!          `CALCULA_LLAMA_SERVER` variable names an executable outright for a
//!          test or an experiment. A build without any of them still runs;
//!          the picker says the runtime is not installed.
//!
//!          All model traffic stays in Rust `reqwest`: the webview's CSP
//!          allows no loopback connection, deliberately.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

use super::builtin_model::{self, DownloadError, DownloadProgress, Located, ModelDirs, ModelOrigin, ModelPin};
use super::providers::BUILTIN_ID;

/// The rustc target this binary was built for, spelled the way the fetch
/// script and the config overlays spell it.
pub const TARGET_TRIPLE: &str = if cfg!(target_arch = "aarch64") {
    "aarch64-pc-windows-msvc"
} else {
    "x86_64-pc-windows-msvc"
};
pub const ENGINE_EXE: &str = "llama-server.exe";
/// Under the resource dir in an installed build (the overlay's mapping).
pub const INSTALLED_ENGINE_DIR: &str = "llama-server";
/// Under the resource dir: the offline installer's model copy.
pub const BUNDLED_MODELS_DIR: &str = "models";
/// Under `%LOCALAPPDATA%\com.calcula.app`: the downloaded copy.
pub const DOWNLOADED_MODELS_DIR: &str = "models";
/// An executable path that overrides every search location.
pub const ENGINE_PATH_ENV: &str = "CALCULA_LLAMA_SERVER";
/// The stamp the fetch script writes beside the executable; its first line is
/// the llama.cpp build number.
pub const BUILD_STAMP: &str = "BUILD.txt";

/// Sized to the model rather than the machine: 8k of the 1.5B's KV cache is
/// about 230 MB, and the assistant prompts are a fifth of that.
pub const CONTEXT_TOKENS: u32 = 8192;
pub const IDLE_UNLOAD_SECS: u64 = 15 * 60;
const IDLE_POLL_SECS: u64 = 30;
/// A cold load of a 1.1 GB file from a slow disk; measured 1.6 s from an SSD.
pub const HEALTH_TIMEOUT_SECS: u64 = 180;
const HEALTH_POLL_MS: u64 = 250;
pub const LOG_TAIL_LINES: usize = 40;
/// The free port is chosen and released before the child binds it; a
/// collision in that window shows as an early exit mentioning the bind.
const PORT_ATTEMPTS: usize = 3;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub const RUNTIME_EVENT: &str = "ai:builtin-runtime";
pub const MODEL_PROGRESS_EVENT: &str = "ai:builtin-model-progress";

pub const MODEL_NOT_DOWNLOADED: &str = "The built-in model is not downloaded yet. Open the AI Chat panel, \
                                        choose \"Calcula built-in\" and accept the download.";

// ---------------------------------------------------------------------------
// Where things are
// ---------------------------------------------------------------------------

/// The folders this machine's copy of the app resolves against.
#[derive(Debug, Clone)]
pub struct RuntimePaths {
    pub resource_dir: Option<PathBuf>,
    pub local_data_dir: PathBuf,
    /// The crate directory in a debug build; None in release.
    pub dev_root: Option<PathBuf>,
    pub engine_override: Option<PathBuf>,
}

#[cfg(debug_assertions)]
fn dev_root() -> Option<PathBuf> {
    Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

#[cfg(not(debug_assertions))]
fn dev_root() -> Option<PathBuf> {
    None
}

impl RuntimePaths {
    pub fn from_app(app: &AppHandle) -> Result<Self, String> {
        let local_data_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("Could not resolve the local app-data folder: {}", e))?;
        Ok(Self {
            resource_dir: app.path().resource_dir().ok(),
            local_data_dir,
            dev_root: dev_root(),
            engine_override: std::env::var_os(ENGINE_PATH_ENV).map(PathBuf::from),
        })
    }

    /// Executable candidates in search order: the override, the installed
    /// resource folder, the developer's fetched folder.
    pub fn engine_candidates(&self) -> Vec<PathBuf> {
        let mut out = Vec::new();
        if let Some(p) = &self.engine_override {
            out.push(p.clone());
        }
        if let Some(r) = &self.resource_dir {
            out.push(r.join(INSTALLED_ENGINE_DIR).join(ENGINE_EXE));
        }
        if let Some(d) = &self.dev_root {
            out.push(d.join("binaries").join(format!("llama-server-{}", TARGET_TRIPLE)).join(ENGINE_EXE));
        }
        out
    }

    pub fn model_dirs(&self) -> ModelDirs {
        ModelDirs {
            bundled: self.resource_dir.as_ref().map(|r| r.join(BUNDLED_MODELS_DIR)),
            downloads: self.local_data_dir.join(DOWNLOADED_MODELS_DIR),
            dev: self.dev_root.as_ref().map(|d| d.join("models")),
        }
    }
}

pub fn locate_engine(paths: &RuntimePaths) -> Option<PathBuf> {
    paths.engine_candidates().into_iter().find(|p| p.is_file())
}

/// The llama.cpp build number from the stamp beside the executable, if any.
pub fn engine_build(engine: &Path) -> Option<String> {
    let stamp = engine.parent()?.join(BUILD_STAMP);
    let text = std::fs::read_to_string(stamp).ok()?;
    let first = text.lines().next()?.trim();
    (!first.is_empty()).then(|| first.to_string())
}

fn engine_missing_message(paths: &RuntimePaths) -> String {
    let searched: Vec<String> = paths.engine_candidates().iter().map(|p| p.display().to_string()).collect();
    format!(
        "This build of Calcula does not include the on-board runtime (looked for {} in: {}). A developer \
         runs `npm run fetch:llama-server`; an installer built without it cannot use the built-in model.",
        ENGINE_EXE,
        searched.join(", "),
    )
}

// ---------------------------------------------------------------------------
// The child process
// ---------------------------------------------------------------------------

/// The last lines the runtime wrote, for an error message that says WHY.
#[derive(Default)]
pub struct LogTail {
    lines: Mutex<VecDeque<String>>,
}

impl LogTail {
    pub fn push(&self, line: String) {
        if let Ok(mut lines) = self.lines.lock() {
            if lines.len() >= LOG_TAIL_LINES {
                lines.pop_front();
            }
            lines.push_back(line);
        }
    }

    pub fn text(&self) -> String {
        self.lines
            .lock()
            .map(|l| l.iter().cloned().collect::<Vec<_>>().join("\n"))
            .unwrap_or_default()
    }
}

fn pump<R: Read + Send + 'static>(reader: R, tail: Arc<LogTail>) {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            tail.push(line);
        }
    });
}

/// A Windows job object whose members are killed when its last handle closes.
pub struct KillOnCloseJob(HANDLE);

// A HANDLE is a raw pointer newtype; the job handle is only ever used from
// the thread that holds the running record's lock.
unsafe impl Send for KillOnCloseJob {}
unsafe impl Sync for KillOnCloseJob {}

impl KillOnCloseJob {
    pub fn new() -> Result<Self, String> {
        let handle = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
            .map_err(|e| format!("CreateJobObject failed: {}", e))?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let set = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if let Err(e) = set {
            unsafe {
                let _ = CloseHandle(handle);
            }
            return Err(format!("SetInformationJobObject failed: {}", e));
        }
        Ok(Self(handle))
    }

    pub fn assign(&self, child: &Child) -> Result<(), String> {
        let process = HANDLE(child.as_raw_handle() as *mut std::ffi::c_void);
        unsafe { AssignProcessToJobObject(self.0, process) }
            .map_err(|e| format!("AssignProcessToJobObject failed: {}", e))
    }
}

impl Drop for KillOnCloseJob {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// A started runtime. Dropping it closes the job, which kills the child.
pub struct Running {
    child: Child,
    _job: KillOnCloseJob,
    pub port: u16,
    pub engine_path: PathBuf,
    pub model_path: PathBuf,
    pub generation: u64,
    pub started: Instant,
    last_used: Instant,
    tail: Arc<LogTail>,
}

impl Running {
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.port)
    }

    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn touch(&mut self) {
        self.last_used = Instant::now();
    }

    pub fn idle_for(&self) -> Duration {
        self.last_used.elapsed()
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    pub fn log_tail(&self) -> String {
        self.tail.text()
    }

    /// Terminate and reap. The job would do it on drop; this frees the port
    /// before the caller reports "stopped".
    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The command line the runtime is started with.
///
/// `--jinja` because the chat sends its tool definitions on every turn and
/// llama-server refuses `tools` without the Jinja template engine;
/// `--no-webui` because nothing should be listening for a browser; one slot
/// because there is one user; the context is sized to the model.
pub fn engine_args(model: &Path, port: u16) -> Vec<String> {
    vec![
        "-m".into(),
        model.display().to_string(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
        "-c".into(),
        CONTEXT_TOKENS.to_string(),
        "-np".into(),
        "1".into(),
        "--jinja".into(),
        "--no-webui".into(),
    ]
}

/// A loopback port nothing is listening on right now.
pub fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("Could not find a free loopback port: {}", e))?;
    listener
        .local_addr()
        .map(|a| a.port())
        .map_err(|e| format!("Could not read the bound port: {}", e))
}

pub fn launch(engine: &Path, model: &Path, port: u16, generation: u64) -> Result<Running, String> {
    launch_with_args(engine, model, engine_args(model, port), port, generation)
}

/// Start `engine` with `args`, in a job, with no console window and both
/// output streams pumped into the log tail. Does NOT wait for health.
pub fn launch_with_args(
    engine: &Path,
    model: &Path,
    args: Vec<String>,
    port: u16,
    generation: u64,
) -> Result<Running, String> {
    let job = KillOnCloseJob::new()?;
    let mut command = Command::new(engine);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);
    if let Some(dir) = engine.parent().filter(|p| !p.as_os_str().is_empty()) {
        command.current_dir(dir);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start {}: {}", engine.display(), e))?;
    if let Err(e) = job.assign(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
    }
    let tail = Arc::new(LogTail::default());
    if let Some(out) = child.stdout.take() {
        pump(out, tail.clone());
    }
    if let Some(err) = child.stderr.take() {
        pump(err, tail.clone());
    }
    Ok(Running {
        child,
        _job: job,
        port,
        engine_path: engine.to_path_buf(),
        model_path: model.to_path_buf(),
        generation,
        started: Instant::now(),
        last_used: Instant::now(),
        tail,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartFailure {
    Exited { status: String, tail: String },
    Timeout { secs: u64, tail: String },
    Http(String),
}

impl std::fmt::Display for StartFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartFailure::Exited { status, tail } => write!(
                f,
                "The on-board runtime exited ({}) before it was ready. Its last output:\n{}",
                status, tail
            ),
            StartFailure::Timeout { secs, tail } => write!(
                f,
                "The on-board runtime did not become ready within {} seconds. Its last output:\n{}",
                secs, tail
            ),
            StartFailure::Http(m) => write!(f, "Could not probe the on-board runtime: {}", m),
        }
    }
}

/// Poll `/health` until the runtime answers 200, the child exits, or the
/// timeout passes. An exit is reported with the child's own last lines,
/// because "connection refused" says nothing about a missing DLL or a model
/// file the server could not read.
pub async fn wait_healthy(r: &mut Running, timeout: Duration) -> Result<(), StartFailure> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| StartFailure::Http(e.to_string()))?;
    let url = format!("http://127.0.0.1:{}/health", r.port);
    let started = Instant::now();
    loop {
        match r.child.try_wait() {
            Ok(Some(status)) => {
                return Err(StartFailure::Exited { status: status.to_string(), tail: r.log_tail() });
            }
            Ok(None) => {}
            Err(e) => return Err(StartFailure::Http(format!("Could not poll the runtime process: {}", e))),
        }
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                return Ok(());
            }
        }
        if started.elapsed() >= timeout {
            return Err(StartFailure::Timeout { secs: timeout.as_secs(), tail: r.log_tail() });
        }
        tokio::time::sleep(Duration::from_millis(HEALTH_POLL_MS)).await;
    }
}

/// Whether an idle runtime has earned its unload. Measured from the last
/// REQUEST, never from the start: a long conversation keeps it warm.
pub fn idle_expired(last_used: Instant, now: Instant, limit: Duration) -> bool {
    now.saturating_duration_since(last_used) >= limit
}

// ---------------------------------------------------------------------------
// Managed state
// ---------------------------------------------------------------------------

pub struct RuntimeState {
    running: tokio::sync::Mutex<Option<Running>>,
    generation: AtomicU64,
    download_active: AtomicBool,
    download_cancel: AtomicBool,
    download_progress: Mutex<Option<DownloadProgress>>,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self::new()
    }
}

impl RuntimeState {
    pub fn new() -> Self {
        Self {
            running: tokio::sync::Mutex::new(None),
            generation: AtomicU64::new(0),
            download_active: AtomicBool::new(false),
            download_cancel: AtomicBool::new(false),
            download_progress: Mutex::new(None),
        }
    }

    /// For the app's exit handler: kill the child now if the record can be
    /// reached. The job object ends it regardless once this process exits;
    /// this only frees the port promptly.
    pub fn shutdown_blocking(&self) {
        if let Ok(mut guard) = self.running.try_lock() {
            if let Some(mut r) = guard.take() {
                r.kill();
            }
        }
    }

    fn progress(&self) -> Option<DownloadProgress> {
        self.download_progress.lock().ok().and_then(|g| *g)
    }

    fn set_progress(&self, p: Option<DownloadProgress>) {
        if let Ok(mut g) = self.download_progress.lock() {
            *g = p;
        }
    }
}

// `rename_all` on an enum renames the VARIANTS; the struct-variant FIELDS need
// `rename_all_fields`, or `base_url` crosses the wire in snake_case while the
// TypeScript mirror reads `baseUrl`. The serialization test below is what
// caught it.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RuntimeEvent {
    Starting { model: String },
    Ready { port: u16, base_url: String, pid: u32 },
    Stopped { reason: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ModelProgressEvent {
    Downloading { bytes: u64, total: u64 },
    Verifying { bytes: u64, total: u64 },
    Done { path: String },
    Failed { message: String },
    Cancelled { bytes: u64 },
}

fn emit_runtime(app: &AppHandle, event: RuntimeEvent) {
    let _ = app.emit(RUNTIME_EVENT, event);
}

fn emit_progress(app: &AppHandle, event: ModelProgressEvent) {
    let _ = app.emit(MODEL_PROGRESS_EVENT, event);
}

fn spawn_idle_watcher(app: AppHandle, generation: u64) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
            let state = app.state::<RuntimeState>();
            let mut guard = state.running.lock().await;
            let Some(r) = guard.as_mut() else { break };
            if r.generation != generation {
                // A newer start has its own watcher.
                break;
            }
            if !r.alive() {
                let tail = r.log_tail();
                *guard = None;
                drop(guard);
                crate::log_warn!("AI", "The on-board runtime exited on its own. Last output:\n{}", tail);
                emit_runtime(&app, RuntimeEvent::Stopped { reason: "the runtime exited on its own".into() });
                break;
            }
            if idle_expired(r.last_used, Instant::now(), Duration::from_secs(IDLE_UNLOAD_SECS)) {
                if let Some(mut r) = guard.take() {
                    r.kill();
                }
                drop(guard);
                emit_runtime(
                    &app,
                    RuntimeEvent::Stopped {
                        reason: format!(
                            "stopped after {} minutes without a request; the next request starts it again",
                            IDLE_UNLOAD_SECS / 60
                        ),
                    },
                );
                break;
            }
        }
    });
}

/// The live base URL of the on-board runtime, starting it if it is not
/// running. Every completion for the built-in provider goes through here.
pub async fn ensure_running(app: &AppHandle) -> Result<String, String> {
    let state = app.state::<RuntimeState>();
    let mut guard = state.running.lock().await;
    if let Some(r) = guard.as_mut() {
        if r.alive() {
            r.touch();
            return Ok(r.base_url());
        }
        let tail = r.log_tail();
        crate::log_warn!("AI", "The on-board runtime had exited; restarting it. Last output:\n{}", tail);
        *guard = None;
    }

    let paths = RuntimePaths::from_app(app)?;
    let engine = locate_engine(&paths).ok_or_else(|| engine_missing_message(&paths))?;
    let pin = builtin_model::pin();
    let model = match builtin_model::locate(&paths.model_dirs(), &pin) {
        Located::Found { path, .. } => path,
        Located::Mismatch { path, size_bytes, .. } => {
            return Err(format!(
                "The model file at {} is {} bytes, not the {} bytes of {}. Delete it and download the \
                 model again from the AI Chat panel.",
                path.display(),
                size_bytes,
                pin.size_bytes,
                pin.label,
            ));
        }
        Located::Absent => return Err(MODEL_NOT_DOWNLOADED.to_string()),
    };

    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    emit_runtime(app, RuntimeEvent::Starting { model: pin.id.clone() });
    let mut last_error = String::new();
    for attempt in 0..PORT_ATTEMPTS {
        let port = free_port()?;
        let mut running = launch(&engine, &model, port, generation)?;
        match wait_healthy(&mut running, Duration::from_secs(HEALTH_TIMEOUT_SECS)).await {
            Ok(()) => {
                let base = running.base_url();
                let pid = running.pid();
                crate::log_info!(
                    "AI",
                    "On-board runtime ready on port {} (pid {}, {} {}, model {})",
                    port,
                    pid,
                    ENGINE_EXE,
                    engine_build(&engine).unwrap_or_else(|| "unstamped".into()),
                    model.display()
                );
                *guard = Some(running);
                drop(guard);
                emit_runtime(app, RuntimeEvent::Ready { port, base_url: base.clone(), pid });
                spawn_idle_watcher(app.clone(), generation);
                return Ok(base);
            }
            Err(StartFailure::Exited { status, tail })
                if attempt + 1 < PORT_ATTEMPTS && tail.to_ascii_lowercase().contains("bind") =>
            {
                last_error = StartFailure::Exited { status, tail }.to_string();
                continue;
            }
            Err(e) => {
                running.kill();
                let message = e.to_string();
                emit_runtime(app, RuntimeEvent::Stopped { reason: message.clone() });
                return Err(message);
            }
        }
    }
    emit_runtime(app, RuntimeEvent::Stopped { reason: last_error.clone() });
    Err(last_error)
}

/// Stop the runtime if it is running. True when something was stopped.
pub async fn stop_runtime(app: &AppHandle, reason: &str) -> bool {
    let state = app.state::<RuntimeState>();
    let mut guard = state.running.lock().await;
    match guard.take() {
        Some(mut r) => {
            r.kill();
            drop(guard);
            emit_runtime(app, RuntimeEvent::Stopped { reason: reason.to_string() });
            true
        }
        None => false,
    }
}

/// What `ai_list_models` answers for the built-in provider: the one model,
/// when its file is in place. Nothing is started to answer this.
pub fn builtin_models(app: &AppHandle) -> Result<Vec<String>, String> {
    let paths = RuntimePaths::from_app(app)?;
    Ok(match builtin_model::locate(&paths.model_dirs(), &builtin_model::pin()) {
        Located::Found { .. } => vec![builtin_model::MODEL_ID.to_string()],
        _ => Vec::new(),
    })
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub present: bool,
    pub path: Option<String>,
    pub build: Option<String>,
    pub searched: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelPresence {
    Present,
    Absent,
    Mismatch,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub pin: ModelPin,
    pub presence: ModelPresence,
    pub path: Option<String>,
    /// Which folder the copy was found in. Named `found_in` rather than
    /// `origin` because the frontend's source-scan guard against comparing a
    /// script TRUST origin to a string reads `.origin === "…"` anywhere.
    pub found_in: Option<ModelOrigin>,
    pub size_on_disk: Option<u64>,
    pub download_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningInfo {
    pub port: u16,
    pub base_url: String,
    pub pid: u32,
    pub uptime_secs: u64,
    pub idle_secs: u64,
    pub model_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinStatus {
    pub provider_id: String,
    pub target: String,
    pub engine: EngineStatus,
    pub model: ModelStatus,
    pub running: Option<RunningInfo>,
    /// True while a start holds the runtime lock (the health wait).
    pub starting: bool,
    pub download: Option<DownloadProgress>,
    pub idle_unload_secs: u64,
}

pub fn status(app: &AppHandle) -> Result<BuiltinStatus, String> {
    let state = app.state::<RuntimeState>();
    let paths = RuntimePaths::from_app(app)?;
    let engine_path = locate_engine(&paths);
    let engine = EngineStatus {
        present: engine_path.is_some(),
        build: engine_path.as_deref().and_then(engine_build),
        path: engine_path.map(|p| p.display().to_string()),
        searched: paths.engine_candidates().iter().map(|p| p.display().to_string()).collect(),
    };
    let pin = builtin_model::pin();
    let dirs = paths.model_dirs();
    let model = match builtin_model::locate(&dirs, &pin) {
        Located::Found { path, origin } => ModelStatus {
            size_on_disk: std::fs::metadata(&path).ok().map(|m| m.len()),
            path: Some(path.display().to_string()),
            found_in: Some(origin),
            presence: ModelPresence::Present,
            pin: pin.clone(),
            download_dir: dirs.downloads.display().to_string(),
        },
        Located::Mismatch { path, origin, size_bytes } => ModelStatus {
            pin: pin.clone(),
            presence: ModelPresence::Mismatch,
            path: Some(path.display().to_string()),
            found_in: Some(origin),
            size_on_disk: Some(size_bytes),
            download_dir: dirs.downloads.display().to_string(),
        },
        Located::Absent => ModelStatus {
            pin: pin.clone(),
            presence: ModelPresence::Absent,
            path: None,
            found_in: None,
            size_on_disk: None,
            download_dir: dirs.downloads.display().to_string(),
        },
    };
    let (running, starting) = match state.running.try_lock() {
        Ok(mut guard) => match guard.as_mut().map(|r| r.alive()) {
            Some(true) => {
                let r = guard.as_ref().expect("checked just above");
                (
                    Some(RunningInfo {
                        port: r.port,
                        base_url: r.base_url(),
                        pid: r.pid(),
                        uptime_secs: r.started.elapsed().as_secs(),
                        idle_secs: r.idle_for().as_secs(),
                        model_path: r.model_path.display().to_string(),
                    }),
                    false,
                )
            }
            Some(false) => {
                // Exited on its own since the last look; the record is stale.
                *guard = None;
                (None, false)
            }
            None => (None, false),
        },
        Err(_) => (None, true),
    };
    Ok(BuiltinStatus {
        provider_id: BUILTIN_ID.to_string(),
        target: TARGET_TRIPLE.to_string(),
        engine,
        model,
        running,
        starting,
        download: state.progress(),
        idle_unload_secs: IDLE_UNLOAD_SECS,
    })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ai_builtin_status(app: AppHandle, window: tauri::Window) -> Result<BuiltinStatus, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    status(&app)
}

/// Download the model if it is not in place. THE CONSENT IS THE CALLER'S:
/// the picker shows the sentence and invokes this on the click; the command
/// is on the governed denylist so a third-party extension cannot invoke it.
#[tauri::command]
pub async fn ai_builtin_ensure_model(app: AppHandle, window: tauri::Window) -> Result<BuiltinStatus, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let paths = RuntimePaths::from_app(&app)?;
    let pin = builtin_model::pin();
    let dirs = paths.model_dirs();
    if let Located::Found { .. } = builtin_model::locate(&dirs, &pin) {
        return status(&app);
    }
    let state = app.state::<RuntimeState>();
    if state.download_active.swap(true, Ordering::SeqCst) {
        return Err("The model is already being downloaded.".to_string());
    }
    state.download_cancel.store(false, Ordering::SeqCst);
    crate::log_info!("AI", "Downloading the on-board model {} to {}", pin.file, dirs.downloads.display());
    let result = builtin_model::download(&pin, &dirs.downloads, &state.download_cancel, |p| {
        state.set_progress(Some(p));
        let event = if p.verifying {
            ModelProgressEvent::Verifying { bytes: p.bytes, total: p.total }
        } else {
            ModelProgressEvent::Downloading { bytes: p.bytes, total: p.total }
        };
        emit_progress(&app, event);
    })
    .await;
    state.set_progress(None);
    state.download_active.store(false, Ordering::SeqCst);
    match result {
        Ok(path) => {
            crate::log_info!("AI", "On-board model verified at {}", path.display());
            emit_progress(&app, ModelProgressEvent::Done { path: path.display().to_string() });
            status(&app)
        }
        Err(DownloadError::Cancelled { bytes }) => {
            emit_progress(&app, ModelProgressEvent::Cancelled { bytes });
            Err(DownloadError::Cancelled { bytes }.to_string())
        }
        Err(DownloadError::Failed(message)) => {
            crate::log_warn!("AI", "On-board model download failed: {}", message);
            emit_progress(&app, ModelProgressEvent::Failed { message: message.clone() });
            Err(message)
        }
    }
}

#[tauri::command]
pub fn ai_builtin_cancel_download(app: AppHandle, window: tauri::Window) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    app.state::<RuntimeState>().download_cancel.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn ai_builtin_start(app: AppHandle, window: tauri::Window) -> Result<BuiltinStatus, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    ensure_running(&app).await?;
    status(&app)
}

#[tauri::command]
pub async fn ai_builtin_stop(app: AppHandle, window: tauri::Window) -> Result<BuiltinStatus, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    stop_runtime(&app, "stopped from the AI Chat panel").await;
    status(&app)
}

/// Remove the downloaded copy (never a bundled or dev copy), stopping the
/// runtime first so the file is not in use.
#[tauri::command]
pub async fn ai_builtin_delete_model(app: AppHandle, window: tauri::Window) -> Result<BuiltinStatus, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    stop_runtime(&app, "the model was deleted").await;
    let paths = RuntimePaths::from_app(&app)?;
    let removed = builtin_model::delete_downloaded(&paths.model_dirs(), &builtin_model::pin())?;
    if removed {
        crate::log_info!("AI", "Deleted the downloaded on-board model");
    }
    status(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(root: &Path) -> RuntimePaths {
        RuntimePaths {
            resource_dir: Some(root.join("res")),
            local_data_dir: root.join("local"),
            dev_root: Some(root.join("dev")),
            engine_override: Some(root.join("override").join("x.exe")),
        }
    }

    #[test]
    fn engine_candidates_search_override_then_installed_then_dev() {
        let root = Path::new("C:/r");
        let c = paths(root).engine_candidates();
        assert_eq!(c[0], root.join("override").join("x.exe"));
        assert_eq!(c[1], root.join("res").join("llama-server").join("llama-server.exe"));
        assert_eq!(
            c[2],
            root.join("dev").join("binaries").join(format!("llama-server-{}", TARGET_TRIPLE)).join("llama-server.exe")
        );
        assert_eq!(c.len(), 3);
    }

    #[test]
    fn model_dirs_search_bundled_then_downloads_then_dev() {
        let root = Path::new("C:/r");
        let d = paths(root).model_dirs();
        assert_eq!(d.bundled, Some(root.join("res").join("models")));
        assert_eq!(d.downloads, root.join("local").join("models"));
        assert_eq!(d.dev, Some(root.join("dev").join("models")));
    }

    #[test]
    fn locate_engine_takes_the_first_candidate_that_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let p = paths(tmp.path());
        assert!(locate_engine(&p).is_none());
        let dev = tmp.path().join("dev").join("binaries").join(format!("llama-server-{}", TARGET_TRIPLE));
        std::fs::create_dir_all(&dev).unwrap();
        std::fs::write(dev.join("llama-server.exe"), b"").unwrap();
        std::fs::write(dev.join("BUILD.txt"), "b10897\nasset\n").unwrap();
        let found = locate_engine(&p).unwrap();
        assert_eq!(found, dev.join("llama-server.exe"));
        assert_eq!(engine_build(&found).as_deref(), Some("b10897"));
        // The installed copy outranks the dev copy.
        let installed = tmp.path().join("res").join("llama-server");
        std::fs::create_dir_all(&installed).unwrap();
        std::fs::write(installed.join("llama-server.exe"), b"").unwrap();
        assert_eq!(locate_engine(&p).unwrap(), installed.join("llama-server.exe"));
        assert_eq!(engine_build(&installed.join("llama-server.exe")), None, "no stamp, no build");
    }

    #[test]
    fn the_command_line_pins_loopback_the_port_the_context_and_what_the_chat_needs() {
        let args = engine_args(Path::new("C:/m/model.gguf"), 4321);
        let joined = args.join(" ");
        assert!(joined.contains("--host 127.0.0.1"), "{}", joined);
        assert!(joined.contains("--port 4321"), "{}", joined);
        assert!(joined.contains(&format!("-c {}", CONTEXT_TOKENS)), "{}", joined);
        assert!(joined.contains("-np 1"), "{}", joined);
        // The chat sends tools on every turn; without the Jinja engine the
        // server refuses them.
        assert!(args.iter().any(|a| a == "--jinja"), "{}", joined);
        assert!(args.iter().any(|a| a == "--no-webui"), "{}", joined);
        assert_eq!(args[0], "-m");
        assert!(args[1].ends_with("model.gguf"));
    }

    #[test]
    fn free_port_is_a_loopback_port_that_can_be_bound() {
        let port = free_port().unwrap();
        assert!(port > 0);
        std::net::TcpListener::bind(("127.0.0.1", port)).expect("the port was free a moment ago");
    }

    #[test]
    fn the_log_tail_keeps_only_the_last_lines() {
        let tail = LogTail::default();
        for i in 0..(LOG_TAIL_LINES + 5) {
            tail.push(format!("line {}", i));
        }
        let text = tail.text();
        assert!(!text.contains("line 0\n"), "the oldest lines are gone");
        assert!(text.ends_with(&format!("line {}", LOG_TAIL_LINES + 4)));
        assert_eq!(text.lines().count(), LOG_TAIL_LINES);
    }

    #[test]
    fn idle_expiry_is_measured_from_the_last_request() {
        let start = Instant::now();
        let limit = Duration::from_secs(10);
        assert!(!idle_expired(start, start + Duration::from_secs(9), limit));
        assert!(idle_expired(start, start + Duration::from_secs(10), limit));
        // A request five seconds ago on a runtime started an hour ago is not idle.
        let recent = start + Duration::from_secs(3600);
        assert!(!idle_expired(recent, recent + Duration::from_secs(5), limit));
    }

    fn spawn_ping() -> Child {
        Command::new("ping.exe")
            .args(["-n", "30", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("ping.exe exists on every Windows")
    }

    fn exited_within(child: &mut Child, wait: Duration) -> bool {
        let started = Instant::now();
        while started.elapsed() < wait {
            if let Ok(Some(_)) = child.try_wait() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[test]
    fn dropping_the_job_kills_the_child_and_a_child_outside_a_job_survives() {
        // Negative control first: a 30-second ping with no job keeps running.
        let mut loose = spawn_ping();
        assert!(!exited_within(&mut loose, Duration::from_millis(400)), "the control child must still be alive");
        let _ = loose.kill();
        let _ = loose.wait();

        // The mechanism under test: assign, drop the job, the child is gone.
        let mut held = spawn_ping();
        let job = KillOnCloseJob::new().unwrap();
        job.assign(&held).unwrap();
        assert!(!exited_within(&mut held, Duration::from_millis(200)), "assignment alone kills nothing");
        drop(job);
        assert!(exited_within(&mut held, Duration::from_secs(3)), "closing the job must kill its member");
    }

    #[tokio::test]
    async fn wait_healthy_reports_an_exited_child_with_its_own_output() {
        let mut r = launch_with_args(
            Path::new("cmd.exe"),
            Path::new("unused.gguf"),
            vec!["/c".into(), "echo boom-from-child & exit 3".into()],
            free_port().unwrap(),
            1,
        )
        .unwrap();
        let err = wait_healthy(&mut r, Duration::from_secs(10)).await.unwrap_err();
        match err {
            StartFailure::Exited { status, tail } => {
                assert!(status.contains('3'), "exit status is reported: {}", status);
                assert!(tail.contains("boom-from-child"), "the child's own words are kept: {}", tail);
            }
            other => panic!("expected Exited, got {:?}", other),
        }
        assert!(err_string_names_the_output(&r));
    }

    fn err_string_names_the_output(r: &Running) -> bool {
        StartFailure::Exited { status: "3".into(), tail: r.log_tail() }
            .to_string()
            .contains("boom-from-child")
    }

    #[tokio::test]
    async fn wait_healthy_times_out_on_a_child_that_never_listens() {
        let mut r = launch_with_args(
            Path::new("ping.exe"),
            Path::new("unused.gguf"),
            vec!["-n".into(), "30".into(), "127.0.0.1".into()],
            free_port().unwrap(),
            1,
        )
        .unwrap();
        let err = wait_healthy(&mut r, Duration::from_millis(900)).await.unwrap_err();
        assert!(matches!(err, StartFailure::Timeout { .. }), "{:?}", err);
        assert!(r.alive(), "a timeout does not kill by itself; the caller decides");
        r.kill();
        assert!(!r.alive());
    }

    #[test]
    fn a_launched_child_dies_with_its_running_record() {
        let mut r = launch_with_args(
            Path::new("ping.exe"),
            Path::new("unused.gguf"),
            vec!["-n".into(), "30".into(), "127.0.0.1".into()],
            0,
            1,
        )
        .unwrap();
        let pid = r.pid();
        assert!(r.alive());
        drop(r);
        // The job closed with the record; the process must be gone.
        let started = Instant::now();
        let mut gone = false;
        while started.elapsed() < Duration::from_secs(3) {
            let out = Command::new("tasklist.exe")
                .args(["/FI", &format!("PID eq {}", pid), "/NH"])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .unwrap();
            let text = String::from_utf8_lossy(&out.stdout);
            if !text.contains(&pid.to_string()) {
                gone = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(gone, "pid {} outlived its Running record", pid);
    }

    #[test]
    fn the_status_shape_is_camel_case() {
        let s = BuiltinStatus {
            provider_id: BUILTIN_ID.into(),
            target: TARGET_TRIPLE.into(),
            engine: EngineStatus { present: false, path: None, build: None, searched: vec![] },
            model: ModelStatus {
                pin: builtin_model::pin(),
                presence: ModelPresence::Absent,
                path: None,
                found_in: None,
                size_on_disk: None,
                download_dir: "x".into(),
            },
            running: None,
            starting: false,
            download: None,
            idle_unload_secs: IDLE_UNLOAD_SECS,
        };
        let v = serde_json::to_value(s).unwrap();
        assert_eq!(v["providerId"], "calcula-builtin");
        assert_eq!(v["model"]["presence"], "absent");
        assert!(v["model"].get("foundIn").is_some(), "the field the picker reads: {}", v["model"]);
        assert_eq!(v["idleUnloadSecs"], IDLE_UNLOAD_SECS);
        assert!(v.get("provider_id").is_none());
        let e = serde_json::to_value(RuntimeEvent::Ready { port: 1, base_url: "u".into(), pid: 2 }).unwrap();
        assert_eq!(e["state"], "ready");
        assert_eq!(e["baseUrl"], "u");
        let p = serde_json::to_value(ModelProgressEvent::Downloading { bytes: 1, total: 2 }).unwrap();
        assert_eq!(p["phase"], "downloading");
    }

    /// The real thing: the fetched engine and the downloaded model in the
    /// developer's tree. `cargo test -p app_lib runtime::tests::the_real -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn the_real_runtime_starts_answers_a_grammar_exactly_and_stops() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let engine = root.join("binaries").join(format!("llama-server-{}", TARGET_TRIPLE)).join(ENGINE_EXE);
        let model = root.join("models").join(builtin_model::MODEL_FILE);
        if !engine.is_file() || !model.is_file() {
            eprintln!("skipped: run npm run fetch:llama-server and npm run fetch:builtin-model first");
            return;
        }
        let port = free_port().unwrap();
        let mut r = launch(&engine, &model, port, 1).unwrap();
        wait_healthy(&mut r, Duration::from_secs(HEALTH_TIMEOUT_SECS)).await.unwrap();
        let client = reqwest::Client::new();
        let body = serde_json::json!({
            "model": builtin_model::MODEL_ID,
            "max_tokens": 8,
            "temperature": 0,
            "messages": [{"role": "user", "content": "What is 2+2? Answer in words."}],
            "grammar": "root ::= \"OK\"",
        });
        let reply: serde_json::Value = client
            .post(format!("{}/chat/completions", r.base_url()))
            .json(&body)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(reply["choices"][0]["message"]["content"], "OK", "{}", reply);
        r.kill();
        assert!(!r.alive());
    }
}
