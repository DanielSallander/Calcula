//! Integration tests for the built-in REST/Web source at the [`Engine`] facade.
//!
//! Deterministic and default-run: the one test that actually issues requests
//! drives a tiny in-process HTTP server bound to `127.0.0.1:0`. Everything else
//! is offline — `Engine::add_rest_source` opens no connection, and neither does
//! `wire_sources`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use arrow::array::Float64Array;
use arrow::record_batch::RecordBatch;

use bi_engine::{
    sum_measure, AuthMethod, Column, DataModel, DataType, Engine, PersistedAuthKind, QueryRequest,
    RestAuthSpec, RestEndpoint, RestField, RestPagination, RestSourceConfig, SourceKind,
    StorageMode, Table, TableSourceBinding,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// A unique temp-file path so parallel tests never collide.
fn temp_model_path(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("calcula_rest_source_{name}.model.json"));
    let _ = std::fs::remove_file(&path);
    path
}

/// A REST config with one `orders` endpoint and a declared bearer-token slot.
fn rest_config(base_url: impl Into<String>) -> RestSourceConfig {
    RestSourceConfig::new(base_url)
        .with_header("Accept", "application/json")
        .with_auth(RestAuthSpec::BearerSecret {
            slot: "orders_token".into(),
        })
        .with_endpoint(
            RestEndpoint::new("orders", "orders")
                .with_rows_path("data")
                .with_fields(vec![
                    RestField::new("id", "id", DataType::Int64),
                    RestField::new("amount", "amount", DataType::Float64),
                ])
                .with_pagination(RestPagination::PageSize {
                    page_param: "page".into(),
                    size_param: "size".into(),
                    size: 2,
                    max_pages: 10,
                }),
        )
}

/// A model with one in-memory `Orders` table bound to the `web` source.
fn rest_model() -> DataModel {
    DataModel::builder()
        .add_table(
            Table::new(
                "Orders",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_measure(sum_measure("Revenue", "Orders", "amount"))
        .build()
        .unwrap()
}

/// The host-supplied secret map for [`rest_config`].
fn secrets() -> AuthMethod {
    AuthMethod::secrets([("orders_token", "s3cr3t-token-value")])
}

// ---------------------------------------------------------------------------
// Offline: catalog, persistence, wiring
// ---------------------------------------------------------------------------

#[test]
fn add_rest_source_records_a_secret_free_catalog_entry() {
    let mut engine = Engine::new(rest_model());
    engine
        .add_rest_source("web", rest_config("https://api.example.com/v1"), secrets())
        .expect("add_rest_source");

    let source = engine.model().source("web").expect("source in catalog");
    assert_eq!(source.kind, SourceKind::Rest);
    assert_eq!(source.preferred_auth, PersistedAuthKind::SecretMap);
    let config = source.rest.as_ref().expect("rest config persisted");
    assert_eq!(config.base_url, "https://api.example.com/v1");
    assert_eq!(config.endpoints.len(), 1);

    // The slot NAME is recorded; the VALUE never reaches the model.
    let json = serde_json::to_string(engine.model()).expect("model serializes");
    assert!(json.contains("orders_token"), "slot name should persist");
    assert!(
        !json.contains("s3cr3t-token-value"),
        "the model file must never carry a secret value"
    );
}

#[test]
fn add_rest_source_refuses_a_config_that_does_not_validate() {
    let mut engine = Engine::new(rest_model());
    let bad = RestSourceConfig::new("http://api.example.com")
        .with_endpoint(RestEndpoint::new("orders", "orders"));
    let err = engine
        .add_rest_source("web", bad, AuthMethod::Integrated)
        .unwrap_err()
        .to_string();
    assert!(err.contains("plain http"), "got {err}");
    // Nothing was recorded.
    assert!(engine.model().source("web").is_none());
}

#[test]
fn add_rest_source_refuses_a_missing_secret_slot() {
    let mut engine = Engine::new(rest_model());
    let err = engine
        .add_rest_source(
            "web",
            rest_config("https://api.example.com"),
            AuthMethod::secrets([("wrong_slot", "x")]),
        )
        .unwrap_err()
        .to_string();
    assert!(err.contains("orders_token"), "got {err}");
    assert!(engine.model().source("web").is_none());
}

#[test]
fn add_rest_source_rejects_a_duplicate_id() {
    let mut engine = Engine::new(rest_model());
    engine
        .add_rest_source("web", rest_config("https://api.example.com"), secrets())
        .unwrap();
    let err = engine
        .add_rest_source("web", rest_config("https://api.example.com"), secrets())
        .unwrap_err();
    assert!(matches!(err, bi_engine::EngineError::DuplicateName(_)));
}

#[test]
fn a_direct_query_table_may_not_bind_to_a_rest_source() {
    let model = DataModel::builder()
        .add_table(
            Table::new("Orders", vec![Column::new("id", DataType::Int64)])
                .unwrap()
                .with_storage_mode(StorageMode::DirectQuery),
        )
        .build()
        .unwrap();
    let mut engine = Engine::new(model);
    engine
        .add_rest_source("web", rest_config("https://api.example.com"), secrets())
        .unwrap();
    let err = engine
        .bind_source_table("web", "rest", "orders", Some("Orders"))
        .unwrap_err()
        .to_string();
    assert!(err.contains("InMemory"), "got {err}");
}

#[tokio::test]
async fn a_saved_rest_source_reopens_and_rewires_from_host_supplied_secrets() {
    let mut engine = Engine::new(rest_model());
    engine
        .add_rest_source("web", rest_config("https://api.example.com/v1"), secrets())
        .unwrap();
    engine
        .bind_source_table("web", "rest", "orders", Some("Orders"))
        .unwrap();
    let path = temp_model_path("reopen");
    engine.save_model(&path).unwrap();

    let saved = std::fs::read_to_string(&path).unwrap();
    assert!(!saved.contains("s3cr3t-token-value"), "secret hit the file");

    let model = Engine::load_model(&path).unwrap();
    let mut reopened = Engine::new(model);
    let mut auth: HashMap<String, AuthMethod> = HashMap::new();
    auth.insert("web".to_string(), secrets());
    let report = reopened.wire_sources_with_auth(&auth).await.unwrap();
    assert_eq!(report.wired, vec!["web".to_string()]);
    assert_eq!(report.bound_tables, vec!["Orders".to_string()]);
    assert!(report.unbound_tables.is_empty());

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn rewiring_without_the_declared_secret_fails_closed_naming_the_slot() {
    let mut engine = Engine::new(rest_model());
    engine
        .add_rest_source("web", rest_config("https://api.example.com/v1"), secrets())
        .unwrap();
    let path = temp_model_path("no_secret");
    engine.save_model(&path).unwrap();

    let model = Engine::load_model(&path).unwrap();
    let mut reopened = Engine::new(model);
    // No auth for "web": the fallback is `Integrated` (no credential), which a
    // source declaring a slot must refuse rather than call unauthenticated.
    let auth: HashMap<String, AuthMethod> = HashMap::new();
    let err = reopened
        .wire_sources_with_auth(&auth)
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("orders_token"), "got {err}");

    let _ = std::fs::remove_file(&path);
}

// ---------------------------------------------------------------------------
// End-to-end over a loopback server
// ---------------------------------------------------------------------------

/// A one-shot loopback HTTP server that answers every request from `pages`
/// (by request index, saturating at the last entry) and records the requests.
struct TinyServer {
    port: u16,
    seen: Arc<Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for TinyServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl TinyServer {
    /// Bind on loopback and serve `pages` as `200 OK` JSON bodies.
    async fn start(pages: Vec<String>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let task = {
            let seen = Arc::clone(&seen);
            tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        return;
                    };
                    let pages = pages.clone();
                    let seen = Arc::clone(&seen);
                    tokio::spawn(async move {
                        let mut raw = Vec::new();
                        let mut chunk = [0u8; 1024];
                        loop {
                            let Ok(read) = socket.read(&mut chunk).await else {
                                return;
                            };
                            if read == 0 {
                                return;
                            }
                            raw.extend_from_slice(&chunk[..read]);
                            if raw.windows(4).any(|w| w == b"\r\n\r\n") {
                                break;
                            }
                        }
                        let head = String::from_utf8_lossy(&raw).to_string();
                        let index = {
                            let mut log = seen.lock().expect("log");
                            log.push(head);
                            log.len() - 1
                        };
                        let body = pages
                            .get(index)
                            .cloned()
                            .unwrap_or_else(|| pages.last().cloned().unwrap_or_default());
                        let response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = socket.write_all(response.as_bytes()).await;
                        let _ = socket.flush().await;
                        let _ = socket.shutdown().await;
                    });
                }
            })
        };
        Self { port, seen, task }
    }

    /// The server's loopback base URL (plain `http` is legal for loopback).
    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// The raw request heads received so far.
    fn requests(&self) -> Vec<String> {
        self.seen.lock().expect("log").clone()
    }
}

#[tokio::test]
async fn a_rest_table_refreshes_over_http_and_answers_a_measure_query() {
    // Two full pages of 2 rows, then a short page — the paging stop signal.
    let server = TinyServer::start(vec![
        r#"{"data":[{"id":1,"amount":100.0},{"id":2,"amount":40.0}]}"#.to_string(),
        r#"{"data":[{"id":3,"amount":30.0},{"id":4,"amount":20.0}]}"#.to_string(),
        r#"{"data":[]}"#.to_string(),
    ])
    .await;

    let mut engine = Engine::new(rest_model());
    engine
        .add_rest_source("web", rest_config(server.base_url()), secrets())
        .expect("add_rest_source");
    engine
        .bind_source_table("web", "rest", "orders", Some("Orders"))
        .expect("bind");

    engine.refresh_table("Orders").await.expect("refresh");

    let results = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            ..Default::default()
        })
        .await
        .expect("query");
    let batch: &RecordBatch = &results[0];
    let index = batch.schema().index_of("Revenue").expect("Revenue column");
    let revenue = batch
        .column(index)
        .as_any()
        .downcast_ref::<Float64Array>()
        .expect("Revenue is Float64")
        .value(0);
    assert!(
        (revenue - 190.0).abs() < 1e-9,
        "expected 190.0, got {revenue}"
    );

    // Three requests: two full pages plus the short one that stops the walk.
    let requests = server.requests();
    assert_eq!(requests.len(), 3, "got {requests:?}");
    assert!(requests[0].contains("page=1"), "got {}", requests[0]);
    assert!(requests[1].contains("page=2"), "got {}", requests[1]);
    // The declared bearer slot's value reached the wire...
    assert!(
        requests[0].contains("authorization: Bearer s3cr3t-token-value")
            || requests[0].contains("Authorization: Bearer s3cr3t-token-value"),
        "got {}",
        requests[0]
    );
    // ...and the default header travelled with it.
    assert!(
        requests[0]
            .to_lowercase()
            .contains("accept: application/json"),
        "got {}",
        requests[0]
    );
}

#[tokio::test]
async fn binding_a_rest_endpoint_discovers_it_and_its_declared_schema() {
    let server = TinyServer::start(vec![r#"{"data":[]}"#.to_string()]).await;
    let mut engine = Engine::new(
        DataModel::builder()
            .add_table(Table::new("Placeholder", vec![Column::new("x", DataType::Int64)]).unwrap())
            .build()
            .unwrap(),
    );
    engine
        .add_rest_source("web", rest_config(server.base_url()), secrets())
        .expect("add_rest_source");

    // The endpoint's declared fields answer introspection offline, so binding
    // adds the model table without a request.
    let bound = engine.bind_source_tables("web").await.expect("bind tables");
    assert_eq!(bound, vec!["orders".to_string()]);
    let table = engine.model().table("orders").expect("orders table");
    assert_eq!(table.columns().len(), 2);
    assert_eq!(
        table.source_binding().map(|b| b.source_id.as_str()),
        Some("web")
    );
    assert!(
        server.requests().is_empty(),
        "declared fields must not require a request"
    );
}

#[test]
fn a_persisted_rest_source_round_trips_through_the_model_file() {
    let config = rest_config("https://api.example.com/v1");
    let mut engine = Engine::new(rest_model());
    engine
        .add_rest_source("web", config.clone(), secrets())
        .unwrap();
    engine
        .bind_source_table("web", "rest", "orders", Some("Orders"))
        .unwrap();
    let path = temp_model_path("round_trip");
    engine.save_model(&path).unwrap();

    let model = Engine::load_model(&path).unwrap();
    let source = model.source("web").expect("source survives the round trip");
    assert_eq!(source.rest.as_ref(), Some(&config));
    assert_eq!(
        model
            .table("Orders")
            .unwrap()
            .source_binding()
            .map(|b| b.table.as_str()),
        Some("orders")
    );

    let _ = std::fs::remove_file(&path);
}

#[test]
fn the_binding_helper_builds_a_rest_table_binding() {
    // The persisted binding for a REST endpoint is an ordinary
    // (schema, table) pair — `rest` plus the endpoint name.
    let binding = TableSourceBinding::new("web", "rest", "orders");
    assert_eq!(binding.schema, "rest");
    assert_eq!(binding.table, "orders");
    assert!(binding.source_query.is_none());
}
