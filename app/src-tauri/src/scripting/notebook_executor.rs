//! FILENAME: app/src-tauri/src/scripting/notebook_executor.rs
//! PURPOSE: Dedicated OS thread that owns the persistent NotebookSession.
//! CONTEXT: QuickJS (rquickjs) types are !Send. Instead of smuggling the
//! session across threads behind an `unsafe impl Send` (the old
//! SendableSession), one lazily-spawned executor thread CREATES and USES the
//! session for its whole lifetime; async Tauri commands exchange jobs with it
//! over channels. Cells serialize naturally through the FIFO channel, and the
//! UI thread is never blocked by a long-running cell.

use std::rc::Rc;
use std::sync::{mpsc, Mutex};

use engine::grid::Grid;
use engine::style::StyleRegistry;
use script_engine::model_provider::ModelDataProvider;
use script_engine::{NotebookSession, ScriptResult};

/// Everything needed to construct the model.* provider ON the executor thread
/// (the provider itself holds an Rc and is !Send; its inputs are Send).
pub struct ProviderSeed {
    pub app: tauri::AppHandle,
    pub rt: tokio::runtime::Handle,
}

impl ProviderSeed {
    fn build(self) -> Rc<dyn ModelDataProvider> {
        Rc::new(crate::bi::script_provider::HostModelProvider::new(
            self.app, self.rt,
        ))
    }
}

/// A unit of work for the executor thread.
enum Job {
    /// Run one cell in the persistent session (created on first use).
    RunCell {
        source: String,
        grids: Vec<Grid>,
        style_registry: StyleRegistry,
        sheet_names: Vec<String>,
        active_sheet: usize,
        /// Script-surface id attributing this run ("notebook:{id}").
        surface_id: String,
        /// Used only when the session is (re)created on this job.
        provider_seed: Option<ProviderSeed>,
        reply: tokio::sync::oneshot::Sender<Result<(ScriptResult, Vec<Grid>), String>>,
    },
    /// Drop the session (clears all JS globals).
    Reset {
        reply: tokio::sync::oneshot::Sender<()>,
    },
}

/// Handle to the executor thread, stored in ScriptState. The thread is
/// spawned lazily on first use and respawned if it ever dies (a dead channel
/// only loses JS session state, which a respawn recreates on demand).
pub struct NotebookExecutor {
    tx: Mutex<Option<mpsc::Sender<Job>>>,
}

impl NotebookExecutor {
    pub fn new() -> Self {
        NotebookExecutor {
            tx: Mutex::new(None),
        }
    }

    /// Get a sender to the executor thread, spawning it if needed.
    fn sender(&self) -> Result<mpsc::Sender<Job>, String> {
        let mut guard = self
            .tx
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.is_none() {
            let (tx, rx) = mpsc::channel::<Job>();
            std::thread::Builder::new()
                .name("notebook-executor".to_string())
                .spawn(move || executor_loop(rx))
                .map_err(|e| format!("Failed to spawn notebook executor thread: {}", e))?;
            *guard = Some(tx);
        }
        Ok(guard.as_ref().expect("sender just ensured").clone())
    }

    /// Forget the current channel so the next call respawns the thread.
    fn clear_sender(&self) {
        let mut guard = self
            .tx
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = None;
    }

    /// Run one cell on the executor thread. The session is created on first
    /// use and persists across calls (JS globals survive) until `reset`.
    /// `provider_seed` enables the model.* API when the session is created on
    /// this call; `surface_id` attributes provider calls ("notebook:{id}").
    pub async fn run_cell(
        &self,
        source: String,
        grids: Vec<Grid>,
        style_registry: StyleRegistry,
        sheet_names: Vec<String>,
        active_sheet: usize,
        surface_id: String,
        provider_seed: Option<ProviderSeed>,
    ) -> Result<(ScriptResult, Vec<Grid>), String> {
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        let mut job = Job::RunCell {
            source,
            grids,
            style_registry,
            sheet_names,
            active_sheet,
            surface_id,
            provider_seed,
            reply: reply_tx,
        };
        // Send with one respawn retry: mpsc::send returns the job on failure,
        // so a dead thread costs a respawn, not a grid re-clone.
        let mut attempts = 0;
        loop {
            let tx = self.sender()?;
            match tx.send(job) {
                Ok(()) => break,
                Err(mpsc::SendError(returned)) => {
                    job = returned;
                    self.clear_sender();
                    attempts += 1;
                    if attempts >= 2 {
                        return Err("Notebook executor thread unavailable".to_string());
                    }
                }
            }
        }
        reply_rx
            .await
            .map_err(|_| "Notebook executor thread terminated unexpectedly".to_string())?
    }

    /// Drop the persistent session (clears all JS globals). A dead thread
    /// already has no session, so a send failure counts as success.
    pub async fn reset(&self) {
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        let tx = match self.sender() {
            Ok(tx) => tx,
            Err(_) => return,
        };
        if tx.send(Job::Reset { reply: reply_tx }).is_err() {
            self.clear_sender();
            return;
        }
        if reply_rx.await.is_err() {
            self.clear_sender();
        }
    }
}

impl Default for NotebookExecutor {
    fn default() -> Self {
        Self::new()
    }
}

/// The executor thread body: owns the only NotebookSession. Created here,
/// used here, dropped here — the session never crosses a thread boundary.
fn executor_loop(rx: mpsc::Receiver<Job>) {
    let mut session: Option<NotebookSession> = None;
    while let Ok(job) = rx.recv() {
        match job {
            Job::RunCell {
                source,
                grids,
                style_registry,
                sheet_names,
                active_sheet,
                surface_id,
                provider_seed,
                reply,
            } => {
                if session.is_none() {
                    let provider = provider_seed.map(ProviderSeed::build);
                    match NotebookSession::new(
                        grids.clone(),
                        style_registry.clone(),
                        sheet_names.clone(),
                        active_sheet,
                        provider,
                    ) {
                        Ok(s) => session = Some(s),
                        Err(e) => {
                            let _ = reply.send(Err(e));
                            continue;
                        }
                    }
                }
                let s = session.as_ref().expect("session just ensured");
                let outcome = s.run_cell(
                    &source,
                    grids,
                    style_registry,
                    sheet_names,
                    active_sheet,
                    &surface_id,
                );
                let _ = reply.send(Ok(outcome));
            }
            Job::Reset { reply } => {
                session = None;
                let _ = reply.send(());
            }
        }
    }
    // Channel closed (app shutdown): session drops with the thread.
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine::grid::Grid;
    use engine::style::StyleRegistry;

    fn fixture() -> (Vec<Grid>, StyleRegistry, Vec<String>) {
        (
            vec![Grid::new()],
            StyleRegistry::new(),
            vec!["Sheet1".to_string()],
        )
    }

    #[tokio::test]
    async fn run_cell_persists_js_globals_until_reset() {
        let exec = NotebookExecutor::new();
        let (grids, reg, names) = fixture();

        let (r1, _) = exec
            .run_cell("let x = 41;".into(), grids.clone(), reg.clone(), names.clone(), 0, "notebook:test".into(), None)
            .await
            .expect("run 1");
        assert!(matches!(r1, ScriptResult::Success { .. }));

        // Same session: x is visible in the next cell.
        let (r2, _) = exec
            .run_cell("x + 1".into(), grids.clone(), reg.clone(), names.clone(), 0, "notebook:test".into(), None)
            .await
            .expect("run 2");
        match &r2 {
            ScriptResult::Success { output, .. } => {
                assert_eq!(output.last().map(|i| i.to_text()).as_deref(), Some("42"));
            }
            other => panic!("expected success, got {:?}", other),
        }

        // Reset drops the session: x is gone.
        exec.reset().await;
        let (r3, _) = exec
            .run_cell("typeof x".into(), grids, reg, names, 0, "notebook:test".into(), None)
            .await
            .expect("run 3");
        match &r3 {
            ScriptResult::Success { output, .. } => {
                assert_eq!(
                    output.last().map(|i| i.to_text()).as_deref(),
                    Some("\"undefined\"")
                );
            }
            other => panic!("expected success, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn structured_table_output_flows_through() {
        let exec = NotebookExecutor::new();
        let (grids, reg, names) = fixture();
        let (r, _) = exec
            .run_cell(
                "display.table([{a: 1, b: 'x'}, {a: 2, b: 'y'}]); 'done'".into(),
                grids,
                reg,
                names,
                0,
                "notebook:test".into(),
                None,
            )
            .await
            .expect("run");
        match &r {
            ScriptResult::Success { output, .. } => {
                assert_eq!(output.len(), 2, "table item + REPL string: {:?}", output);
                match &output[0] {
                    script_engine::ScriptOutputItem::Table { columns, rows, truncated, total_rows } => {
                        assert_eq!(columns, &vec!["a".to_string(), "b".to_string()]);
                        assert_eq!(rows, &vec![
                            vec!["1".to_string(), "x".to_string()],
                            vec!["2".to_string(), "y".to_string()],
                        ]);
                        assert!(!truncated);
                        assert_eq!(*total_rows, 2);
                    }
                    other => panic!("expected table item, got {:?}", other),
                }
            }
            other => panic!("expected success, got {:?}", other),
        }
    }
}
