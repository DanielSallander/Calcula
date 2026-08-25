//! Integration tests for the REST connector against an **in-process loopback
//! HTTP server**.
//!
//! No network and no `#[ignore]`: the tests bind `127.0.0.1:0`, so they run in
//! the default `cargo test` sweep on any machine. The server is ~100 lines of
//! `tokio::net::TcpListener` rather than a web-framework dependency — the
//! connector only needs a handful of HTTP/1.1 response shapes, and one of them
//! (a body with no `Content-Length`, terminated by close) is exactly the case a
//! framework would hide.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use engine_connectors::auth::{AuthMethod, AuthMethodKind, ConnectionTarget, ConnectorAuth};
use engine_connectors::traits::{
    Connector, FetchRequest, FilterCondition, FilterOperator, InFilterCondition, InValueKind,
};
use engine_core::model::{RestAuthSpec, RestEndpoint, RestField, RestPagination, RestSourceConfig};
use engine_core::types::DataType;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::http::parse_link_next;
use super::RestConnector;

// ---------------------------------------------------------------------------
// Mock HTTP server
// ---------------------------------------------------------------------------

/// One request the mock server received.
#[derive(Debug, Clone)]
struct RecordedRequest {
    /// HTTP method as sent.
    method: String,
    /// Request target (path plus query string).
    target: String,
    /// Header lines, lowercased names mapped to their raw values.
    headers: Vec<(String, String)>,
    /// Request body (empty unless `Content-Length` said otherwise).
    body: String,
}

impl RecordedRequest {
    /// The value of a header, matched case-insensitively.
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == &name.to_ascii_lowercase())
            .map(|(_, v)| v.as_str())
    }

    /// The query string (everything after the first `?`), or `""`.
    fn query(&self) -> &str {
        self.target.split_once('?').map(|(_, q)| q).unwrap_or("")
    }
}

/// A canned response for the mock server to write.
#[derive(Debug, Clone)]
struct MockResponse {
    /// HTTP status code.
    status: u16,
    /// Extra response headers.
    headers: Vec<(String, String)>,
    /// Response body.
    body: Vec<u8>,
    /// Sleep this long before answering (drives the timeout test).
    delay: Duration,
    /// Omit `Content-Length` and end the body by closing the connection, so the
    /// size cap must be enforced while streaming rather than up front.
    no_content_length: bool,
}

impl MockResponse {
    /// A `200 OK` with a JSON body.
    fn json(body: impl Into<String>) -> Self {
        Self {
            status: 200,
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: body.into().into_bytes(),
            delay: Duration::ZERO,
            no_content_length: false,
        }
    }

    /// Add a response header.
    fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    /// Set the status code.
    fn with_status(mut self, status: u16) -> Self {
        self.status = status;
        self
    }

    /// Delay the response.
    fn with_delay(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }

    /// Stream the body without a `Content-Length`.
    fn streamed(mut self) -> Self {
        self.no_content_length = true;
        self
    }
}

/// Decides what to answer, given the request and its 0-based index.
type Responder = Arc<dyn Fn(&RecordedRequest, usize) -> MockResponse + Send + Sync>;

/// An in-process HTTP/1.1 server on loopback. Dropping it stops accepting.
struct MockServer {
    addr: SocketAddr,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl MockServer {
    /// Bind a server on `127.0.0.1:0` answering through `responder`.
    async fn start<F>(responder: F) -> Self
    where
        F: Fn(&RecordedRequest, usize) -> MockResponse + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback listener");
        let addr = listener.local_addr().expect("listener address");
        let requests: Arc<Mutex<Vec<RecordedRequest>>> = Arc::new(Mutex::new(Vec::new()));
        let responder: Responder = Arc::new(responder);
        let task = {
            let requests = Arc::clone(&requests);
            tokio::spawn(async move {
                loop {
                    let Ok((socket, _)) = listener.accept().await else {
                        return;
                    };
                    let responder = Arc::clone(&responder);
                    let requests = Arc::clone(&requests);
                    tokio::spawn(async move {
                        let _ = handle_connection(socket, responder, requests).await;
                    });
                }
            })
        };
        Self {
            addr,
            requests,
            task,
        }
    }

    /// The server's `http://127.0.0.1:<port>` base URL.
    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.addr.port())
    }

    /// Everything received so far.
    fn requests(&self) -> Vec<RecordedRequest> {
        self.requests.lock().expect("request log").clone()
    }
}

/// Read one request, record it, and write the responder's answer.
async fn handle_connection(
    mut socket: TcpStream,
    responder: Responder,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
) -> std::io::Result<()> {
    let mut raw: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 1024];
    let head_end = loop {
        let read = socket.read(&mut chunk).await?;
        if read == 0 {
            return Ok(());
        }
        raw.extend_from_slice(&chunk[..read]);
        if let Some(pos) = find_subslice(&raw, b"\r\n\r\n") {
            break pos + 4;
        }
    };

    let head = String::from_utf8_lossy(&raw[..head_end]).to_string();
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or_default().to_string();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default().to_string();

    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }

    let content_length: usize = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let mut body_bytes = raw[head_end..].to_vec();
    while body_bytes.len() < content_length {
        let read = socket.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        body_bytes.extend_from_slice(&chunk[..read]);
    }

    let request = RecordedRequest {
        method,
        target,
        headers,
        body: String::from_utf8_lossy(&body_bytes).to_string(),
    };
    let index = {
        let mut log = requests.lock().expect("request log");
        log.push(request.clone());
        log.len() - 1
    };

    let response = responder(&request, index);
    if !response.delay.is_zero() {
        tokio::time::sleep(response.delay).await;
    }

    let reason = match response.status {
        200 => "OK",
        302 => "Found",
        401 => "Unauthorized",
        500 => "Internal Server Error",
        _ => "Status",
    };
    let mut head = format!("HTTP/1.1 {} {reason}\r\n", response.status);
    for (name, value) in &response.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    if !response.no_content_length {
        head.push_str(&format!("Content-Length: {}\r\n", response.body.len()));
    }
    head.push_str("Connection: close\r\n\r\n");
    socket.write_all(head.as_bytes()).await?;
    socket.write_all(&response.body).await?;
    socket.flush().await?;
    let _ = socket.shutdown().await;
    Ok(())
}

/// `Vec::windows`-based substring search (no extra dependency).
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// A config pointing at `server` with one endpoint named `rows` at `/rows`.
fn config_for(server: &MockServer, endpoint: RestEndpoint) -> RestSourceConfig {
    RestSourceConfig::new(server.base_url()).with_endpoint(endpoint)
}

/// Build a connector with no authentication.
fn connector(config: RestSourceConfig) -> RestConnector {
    RestConnector::from_config(config, AuthMethod::Integrated).expect("connector builds")
}

/// A plain fetch of the endpoint named `table`.
fn fetch(table: &str) -> FetchRequest {
    FetchRequest {
        schema: Some(super::REST_SOURCE_SCHEMA.to_string()),
        table: table.to_string(),
        ..Default::default()
    }
}

/// Total rows across a batch sequence.
fn row_count(batches: &[arrow::record_batch::RecordBatch]) -> usize {
    batches.iter().map(|b| b.num_rows()).sum()
}

// ---------------------------------------------------------------------------
// Construction / auth
// ---------------------------------------------------------------------------

#[test]
fn supported_auth_is_secret_map_and_no_auth() {
    assert_eq!(
        RestConnector::supported_auth_methods(),
        vec![AuthMethodKind::SecretMap, AuthMethodKind::Integrated]
    );
}

#[test]
fn from_target_explains_that_a_rest_source_has_no_connection_target() {
    let err = RestConnector::from_target(
        ConnectionTarget::new("api.example.com", "db"),
        AuthMethod::Integrated,
    )
    .unwrap_err()
    .to_string();
    assert!(err.contains("from_config"), "got {err}");
}

#[test]
fn from_config_refuses_a_non_https_public_base_url() {
    let config = RestSourceConfig::new("http://api.example.com")
        .with_endpoint(RestEndpoint::new("rows", "rows"));
    let err = RestConnector::from_config(config, AuthMethod::Integrated)
        .unwrap_err()
        .to_string();
    assert!(err.contains("plain http"), "got {err}");
}

// A reqwest `Client` is constructed inside `from_config`, so the tests that
// get that far run on a runtime even though nothing here is awaited.
#[tokio::test]
async fn from_config_accepts_https_and_loopback_http() {
    for base in ["https://api.example.com", "http://127.0.0.1:8080"] {
        let config = RestSourceConfig::new(base).with_endpoint(RestEndpoint::new("rows", "rows"));
        assert!(RestConnector::from_config(config, AuthMethod::Integrated).is_ok());
    }
}

#[test]
fn a_declared_slot_the_host_did_not_supply_is_refused() {
    let config = RestSourceConfig::new("https://api.example.com")
        .with_auth(RestAuthSpec::BearerSecret {
            slot: "api_token".into(),
        })
        .with_endpoint(RestEndpoint::new("rows", "rows"));

    // No secrets at all.
    let err = RestConnector::from_config(config.clone(), AuthMethod::Integrated)
        .unwrap_err()
        .to_string();
    assert!(err.contains("api_token"), "got {err}");

    // A map that supplies the wrong slot.
    let err = RestConnector::from_config(config, AuthMethod::secrets([("other", "x")]))
        .unwrap_err()
        .to_string();
    assert!(err.contains("api_token"), "got {err}");
}

#[test]
fn database_auth_methods_are_refused_with_an_explanation() {
    let config = RestSourceConfig::new("https://api.example.com")
        .with_endpoint(RestEndpoint::new("rows", "rows"));
    for auth in [
        AuthMethod::UsernamePassword {
            username: "u".into(),
            password: "p".into(),
        },
        AuthMethod::EnvironmentVariable {
            username_var: "U".into(),
            password_var: "P".into(),
        },
    ] {
        let err = RestConnector::from_config(config.clone(), auth)
            .unwrap_err()
            .to_string();
        assert!(err.contains("AuthMethod::Secrets"), "got {err}");
    }
}

#[tokio::test]
async fn secrets_never_appear_in_debug_output_or_in_construction_errors() {
    const TOKEN: &str = "s3cr3t-bearer-value";
    let config = RestSourceConfig::new("https://api.example.com")
        .with_auth(RestAuthSpec::BearerSecret {
            slot: "api_token".into(),
        })
        .with_endpoint(RestEndpoint::new("rows", "rows"));
    let connector = RestConnector::from_config(config, AuthMethod::secrets([("api_token", TOKEN)]))
        .expect("connector builds");

    let debug = format!("{connector:?}");
    assert!(!debug.contains(TOKEN), "Debug leaked the token: {debug}");
    assert!(
        debug.contains("***"),
        "Debug should mark the redaction: {debug}"
    );

    // And the config the connector exposes carries the slot NAME only.
    let json = serde_json::to_string(connector.config()).expect("config serializes");
    assert!(!json.contains(TOKEN), "config leaked the token: {json}");
    assert!(json.contains("api_token"), "got {json}");
}

// ---------------------------------------------------------------------------
// Listing / introspection
// ---------------------------------------------------------------------------

#[tokio::test]
async fn list_tables_reports_the_declared_endpoints_without_a_request() {
    let server = MockServer::start(|_, _| MockResponse::json("[]")).await;
    let connector = connector(
        RestSourceConfig::new(server.base_url())
            .with_endpoint(RestEndpoint::new("orders", "orders"))
            .with_endpoint(RestEndpoint::new("customers", "customers")),
    );
    let tables = connector.list_tables().await.expect("list");
    let names: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, vec!["orders", "customers"]);
    assert!(tables.iter().all(|t| t.schema == super::REST_SOURCE_SCHEMA));
    assert!(
        server.requests().is_empty(),
        "listing must issue no request"
    );
}

#[tokio::test]
async fn introspection_infers_types_by_sampling_the_first_page() {
    let server = MockServer::start(|_, _| {
        MockResponse::json(r#"[{"id":1,"name":"a","ratio":0.5,"ok":true,"when":"2026-08-25"}]"#)
    })
    .await;
    let connector = connector(config_for(&server, RestEndpoint::new("rows", "rows")));
    let table = connector
        .introspect_table(super::REST_SOURCE_SCHEMA, "rows")
        .await
        .expect("introspect");
    assert_eq!(
        table.column("id").expect("id").data_type(),
        &DataType::Int64
    );
    assert_eq!(
        table.column("name").expect("name").data_type(),
        &DataType::String
    );
    assert_eq!(
        table.column("ratio").expect("ratio").data_type(),
        &DataType::Float64
    );
    assert_eq!(
        table.column("ok").expect("ok").data_type(),
        &DataType::Boolean
    );
    // An ISO date string is inferred as String — never guessed as a Date.
    assert_eq!(
        table.column("when").expect("when").data_type(),
        &DataType::String
    );
}

#[tokio::test]
async fn introspection_of_a_declared_endpoint_issues_no_request() {
    let server = MockServer::start(|_, _| MockResponse::json("[]")).await;
    let connector = connector(config_for(
        &server,
        RestEndpoint::new("rows", "rows").with_fields(vec![
            RestField::new("id", "id", DataType::Int64),
            RestField::new("at", "at", DataType::Timestamp),
        ]),
    ));
    let table = connector
        .introspect_table(super::REST_SOURCE_SCHEMA, "rows")
        .await
        .expect("introspect");
    assert_eq!(table.columns().len(), 2);
    assert_eq!(
        table.column("at").expect("at").data_type(),
        &DataType::Timestamp
    );
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn an_unknown_endpoint_names_the_declared_ones() {
    let server = MockServer::start(|_, _| MockResponse::json("[]")).await;
    let connector = connector(config_for(&server, RestEndpoint::new("rows", "rows")));
    let err = connector
        .fetch_data(&fetch("missing"))
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("rows"), "got {err}");
}

// ---------------------------------------------------------------------------
// rows_path + decoding
// ---------------------------------------------------------------------------

#[tokio::test]
async fn rows_are_read_from_the_response_root_when_no_rows_path_is_declared() {
    let server = MockServer::start(|_, _| MockResponse::json(r#"[{"id":1},{"id":2}]"#)).await;
    let connector = connector(config_for(&server, RestEndpoint::new("rows", "rows")));
    let out = connector.fetch_data(&fetch("rows")).await.expect("fetch");
    assert_eq!(row_count(&out), 2);
}

#[tokio::test]
async fn rows_are_read_from_a_nested_rows_path() {
    let server = MockServer::start(|_, _| {
        MockResponse::json(r#"{"data":{"items":[{"id":1},{"id":2},{"id":3}]},"total":3}"#)
    })
    .await;
    let connector = connector(config_for(
        &server,
        RestEndpoint::new("rows", "rows").with_rows_path("data.items"),
    ));
    let out = connector.fetch_data(&fetch("rows")).await.expect("fetch");
    assert_eq!(row_count(&out), 3);
}

#[tokio::test]
async fn a_wrong_rows_path_errors_rather_than_reporting_an_empty_table() {
    let server = MockServer::start(|_, _| MockResponse::json(r#"{"data":[{"id":1}]}"#)).await;
    let connector = connector(config_for(
        &server,
        RestEndpoint::new("rows", "rows").with_rows_path("items"),
    ));
    let err = connector
        .fetch_data(&fetch("rows"))
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("rowsPath"), "got {err}");
}

#[tokio::test]
async fn declared_fields_project_nested_values_and_null_the_missing_ones() {
    let server = MockServer::start(|_, _| {
        MockResponse::json(
            r#"[{"id":1,"customer":{"name":"Ada"}},{"id":2},{"id":3,"customer":{}}]"#,
        )
    })
    .await;
    let connector = connector(config_for(
        &server,
        RestEndpoint::new("rows", "rows").with_fields(vec![
            RestField::new("id", "id", DataType::Int64),
            RestField::new("customer.name", "customer", DataType::String),
        ]),
    ));
    use arrow::array::Array;
    let out = connector.fetch_data(&fetch("rows")).await.expect("fetch");
    assert_eq!(row_count(&out), 3);
    let column = out[0]
        .column_by_name("customer")
        .expect("customer column")
        .clone();
    let strings = column
        .as_any()
        .downcast_ref::<arrow::array::StringArray>()
        .expect("string array");
    assert_eq!(strings.value(0), "Ada");
    assert!(strings.is_null(1));
    assert!(strings.is_null(2));
}

#[tokio::test]
async fn a_post_endpoint_sends_its_static_json_body() {
    let server = MockServer::start(|_, _| MockResponse::json(r#"[{"id":1}]"#)).await;
    let connector = connector(config_for(
        &server,
        RestEndpoint::new("rows", "search").with_body(r#"{"q":"open"}"#),
    ));
    let out = connector.fetch_data(&fetch("rows")).await.expect("fetch");
    assert_eq!(row_count(&out), 1);
    let requests = server.requests();
    assert_eq!(requests[0].method, "POST");
    assert_eq!(requests[0].body, r#"{"q":"open"}"#);
    assert_eq!(requests[0].header("content-type"), Some("application/json"));
    assert!(requests[0].target.starts_with("/search"));
}

// ---------------------------------------------------------------------------
// Pagination — all four modes
// ---------------------------------------------------------------------------

/// Build `count` rows starting at `start` as a JSON array.
fn page_body(start: usize, count: usize) -> String {
    let items: Vec<String> = (start..start + count)
        .map(|i| format!(r#"{{"id":{i}}}"#))
        .collect();
    format!("[{}]", items.join(","))
}

#[tokio::test]
async fn page_size_pagination_walks_until_a_short_page() {
    let server = MockServer::start(|_, index| match index {
        0 => MockResponse::json(page_body(0, 2)),
        1 => MockResponse::json(page_body(2, 2)),
        _ => MockResponse::json(page_body(4, 1)),
    })
    .await;
    let connector = connector(config_for(
        &server,
        RestEndpoint::new("rows", "rows").with_pagination(RestPagination::PageSize {
            page_param: "page".into(),
            size_param: "size".into(),
            size: 2,
            max_pages: 10,
        }),
    ));
    let out = connector.fetch_data(&fetch("rows")).await.expect("fetch");
    assert_eq!(row_count(&out), 5);
    let requests = server.requests();
    assert_eq!(requests.len(), 3);
    assert!(
        requests[0].query().contains("page=1"),
        "{}",
        requests[0].query()
    );
    assert!(requests[0].query().contains("size=2"));
    assert!(requests[1].query().contains("page=2"));
    assert!(requests[2].query().contains("page=3"));
}

#[tokio::test]
async fn offset_pagination_advances_by_the_limit() {
    let server = MockServer::start(|_, index| match index {
        0 => MockResponse::json(page_body(0, 3)),
        _ => MockResponse::json(page_body(3, 1)),
    })
    .await;
    let connector = connector(config_for(
        &server,
        RestEndpoint::new("rows", "rows").with_pagination(RestPagination::Offset {
            offset_param: "offset".into(),
            limit_param: "limit".into(),
            limit: 3,
            max_pages: 10,
        }),
    ));
    let out = connector.fetch_data(&fetch("rows")).await.expect("fetch");
    assert_eq!(row_count(&out), 4);
    let requests = server.requests();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].query().contains("offset=0"));
    assert!(requests[1].query().contains("offset=3"));
    assert!(requests[1].query().contains("limit=3"));
}

#[tokio::test]
async fn cursor_pagination_sends_the_cursor_read_from_the_body() {
    let server = MockServer::start(|_, index| match index {
        0 => MockResponse::json(r#"{"items":[{"id":1}],"meta":{"next":"c2"}}"#),
        1 => MockResponse::json(r#"{"items":[{"id":2}],"meta":{"next":null}}"#),
        _ => MockResponse::json(r#"{"items":[],"meta":{}}"#),
    })
    .await;
    let connector = connector(config_for(
        &server,
        RestEndpoint::new("rows", "rows")
            .with_rows_path("items")
            .with_pagination(RestPagination::Cursor {
                cursor_param: "cursor".into(),
                cursor_path: "meta.next".into(),
                max_pages: 10,
            }),
    ));
    let out = connector.fetch_data(&fetch("rows")).await.expect("fetch");
    assert_eq!(row_count(&out), 2);
    let requests = server.requests();
    assert_eq!(requests.len(), 2);
    assert!(!requests[0].query().contains("cursor="));
    assert!(
        requests[1].query().contains("cursor=c2"),
        "{}",
        requests[1].query()
    );
}

#[tokio::test]
async fn link_header_pagination_follows_rel_next_until_it_is_absent() {
    let server = MockServer::start(|request, index| {
        // The next URL points back at this same server, on /p2.
        let host = request.header("host").unwrap_or("127.0.0.1").to_string();
        match index {
            0 => MockResponse::json(page_body(0, 1)).with_header(
                "Link",
                &format!("<http://{host}/p2>; rel=\"next\", <http://{host}/last>; rel=\"last\""),
            ),
            _ => MockResponse::json(page_body(1, 1)),
        }
    })
    .await;
    let connector = connector(config_for(
        &server,
        RestEndpoint::new("rows", "rows")
            .with_pagination(RestPagination::LinkHeader { max_pages: 10 }),
    ));
    let out = connector.fetch_data(&fetch("rows")).await.expect("fetch");
    assert_eq!(row_count(&out), 2);
    let requests = server.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1].target, "/p2");
}

#[tokio::test]
async fn max_pages_stops_an_api_that_never_says_it_is_done() {
    let server = MockServer::start(|_, _| MockResponse::json(page_body(0, 2))).await;
    let connector = connector(config_for(
        &server,
        RestEndpoint::new("rows", "rows").with_pagination(RestPagination::PageSize {
            page_param: "page".into(),
            size_param: "size".into(),
            size: 2,
            max_pages: 3,
        }),
    ));
    let out = connector.fetch_data(&fetch("rows")).await.expect("fetch");
    // Three full pages of 2, then the ceiling stops the walk.
    assert_eq!(row_count(&out), 6);
    assert_eq!(server.requests().len(), 3);
}

#[tokio::test]
async fn a_link_header_pointing_at_a_public_plaintext_host_is_refused() {
    let server = MockServer::start(|_, _| {
        MockResponse::json(page_body(0, 1))
            .with_header("Link", "<http://evil.example.com/p2>; rel=\"next\"")
    })
    .await;
    let connector = connector(config_for(
        &server,
        RestEndpoint::new("rows", "rows")
            .with_pagination(RestPagination::LinkHeader { max_pages: 5 }),
    ));
    let err = connector
        .fetch_data(&fetch("rows"))
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("plain http"), "got {err}");
}

#[tokio::test]
async fn a_link_header_pointing_at_another_https_host_is_refused() {
    // REGRESSION: the rel="next" URL was checked only for SCHEME, so any https
    // host the server named was followed — and the transport attaches the
    // source's resolved credential to every request, so the secret went with
    // it. That is exactly what `redirect::Policy::none()` refuses; a Link
    // header is a redirect the body asks for politely.
    let server = MockServer::start(|_, _| {
        MockResponse::json(page_body(0, 1))
            .with_header("Link", "<https://evil.example.com/p2>; rel=\"next\"")
    })
    .await;
    let connector = connector(config_for(
        &server,
        RestEndpoint::new("rows", "rows")
            .with_pagination(RestPagination::LinkHeader { max_pages: 5 }),
    ));
    let err = connector
        .fetch_data(&fetch("rows"))
        .await
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("evil.example.com"),
        "must name the host it refused: {err}"
    );
    assert!(
        err.contains("does not declare"),
        "must say why it refused: {err}"
    );
    // Exactly one request: the walk stopped instead of leaking the credential.
    assert_eq!(server.requests().len(), 1);
}

#[tokio::test]
async fn a_link_header_may_change_path_and_port_free_parts_of_its_own_host() {
    // The positive control for the pin: ordinary paging on the declared host
    // must keep working, or the fix would break every real Link-header API.
    let server = MockServer::start(|request, index| {
        let host = request.header("host").unwrap_or("127.0.0.1").to_string();
        match index {
            0 => MockResponse::json(page_body(0, 1)).with_header(
                "Link",
                &format!("<http://{host}/deep/p2?cursor=x>; rel=\"next\""),
            ),
            _ => MockResponse::json(page_body(1, 1)),
        }
    })
    .await;
    let connector = connector(config_for(
        &server,
        RestEndpoint::new("rows", "rows")
            .with_pagination(RestPagination::LinkHeader { max_pages: 10 }),
    ));
    let out = connector.fetch_data(&fetch("rows")).await.expect("fetch");
    assert_eq!(row_count(&out), 2);
    assert_eq!(server.requests()[1].target, "/deep/p2?cursor=x");
}

#[test]
fn link_header_parsing_handles_the_shapes_apis_actually_send() {
    assert_eq!(
        parse_link_next("<https://a/2>; rel=\"next\""),
        Some("https://a/2".to_string())
    );
    assert_eq!(
        parse_link_next("<https://a/1>; rel=\"prev\", <https://a/3>; rel=\"next\""),
        Some("https://a/3".to_string())
    );
    assert_eq!(
        parse_link_next("<https://a/3>; rel=\"next last\""),
        Some("https://a/3".to_string())
    );
    // `next` first, so its params carry the `, ` separator to the next link.
    assert_eq!(
        parse_link_next("<https://a/2>; rel=\"next\", <https://a/9>; rel=\"last\""),
        Some("https://a/2".to_string())
    );
    // A comma inside the URL must not split the header.
    assert_eq!(
        parse_link_next("<https://a/x?ids=1,2,3>; rel=\"next\""),
        Some("https://a/x?ids=1,2,3".to_string())
    );
    assert_eq!(parse_link_next("<https://a/1>; rel=\"prev\""), None);
    assert_eq!(parse_link_next(""), None);
}

// ---------------------------------------------------------------------------
// Security posture
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_redirect_is_refused_and_never_followed() {
    let server = MockServer::start(|_, index| {
        if index == 0 {
            MockResponse::json("")
                .with_status(302)
                .with_header("Location", "http://127.0.0.1:1/elsewhere")
        } else {
            MockResponse::json(page_body(0, 1))
        }
    })
    .await;
    let connector = connector(config_for(&server, RestEndpoint::new("rows", "rows")));
    let err = connector
        .fetch_data(&fetch("rows"))
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("refuses redirects"), "got {err}");
    // Exactly one request: the redirect target was never fetched.
    assert_eq!(server.requests().len(), 1);
}

#[tokio::test]
async fn the_response_size_cap_aborts_an_oversized_body() {
    let big = format!("[{}]", vec![r#"{"id":1}"#; 2000].join(","));
    let server = MockServer::start(move |_, _| MockResponse::json(big.clone())).await;
    let mut config = config_for(&server, RestEndpoint::new("rows", "rows"));
    config.max_response_bytes = 512;
    let connector = connector(config);
    let err = connector
        .fetch_data(&fetch("rows"))
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("max_response_bytes"), "got {err}");
}

#[tokio::test]
async fn the_size_cap_is_enforced_while_streaming_a_body_with_no_content_length() {
    let big = format!("[{}]", vec![r#"{"id":1}"#; 4000].join(","));
    let server = MockServer::start(move |_, _| MockResponse::json(big.clone()).streamed()).await;
    let mut config = config_for(&server, RestEndpoint::new("rows", "rows"));
    config.max_response_bytes = 256;
    let connector = connector(config);
    let err = connector
        .fetch_data(&fetch("rows"))
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("max_response_bytes"), "got {err}");
}

#[tokio::test]
async fn the_cap_spans_every_page_of_a_paginated_fetch() {
    let server = MockServer::start(|_, _| MockResponse::json(page_body(0, 5))).await;
    let mut config = config_for(
        &server,
        RestEndpoint::new("rows", "rows").with_pagination(RestPagination::PageSize {
            page_param: "page".into(),
            size_param: "size".into(),
            size: 5,
            max_pages: 100,
        }),
    );
    // Enough for a couple of pages, not for a hundred.
    config.max_response_bytes = 120;
    let connector = connector(config);
    let err = connector
        .fetch_data(&fetch("rows"))
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("max_response_bytes"), "got {err}");
    assert!(
        server.requests().len() < 100,
        "the cap must stop the walk early"
    );
}

#[tokio::test]
async fn a_request_that_outlives_the_timeout_fails_with_a_timeout() {
    let server =
        MockServer::start(|_, _| MockResponse::json("[]").with_delay(Duration::from_secs(5))).await;
    let mut config = config_for(&server, RestEndpoint::new("rows", "rows"));
    config.timeout_secs = 1;
    let connector = connector(config);
    let err = connector
        .fetch_data(&fetch("rows"))
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("timed out"), "got {err}");
}

#[tokio::test]
async fn an_error_status_is_reported_and_the_secret_is_redacted_from_it() {
    const TOKEN: &str = "s3cr3t-echoed-back";
    // A hostile (or merely careless) API that echoes the credential into its
    // error body must not be able to write it into an engine error message.
    let server = MockServer::start(|_, _| {
        MockResponse::json(format!(r#"{{"error":"bad token {TOKEN}"}}"#)).with_status(401)
    })
    .await;
    let config = config_for(&server, RestEndpoint::new("rows", "rows")).with_auth(
        RestAuthSpec::BearerSecret {
            slot: "api_token".into(),
        },
    );
    let connector = RestConnector::from_config(config, AuthMethod::secrets([("api_token", TOKEN)]))
        .expect("connector builds");
    let err = connector
        .fetch_data(&fetch("rows"))
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("401"), "got {err}");
    assert!(!err.contains(TOKEN), "the error leaked the token: {err}");
    assert!(err.contains("***"), "got {err}");
}

#[tokio::test]
async fn each_auth_spec_puts_its_secret_where_it_declared_it() {
    // Bearer.
    let server = MockServer::start(|_, _| MockResponse::json("[]")).await;
    let config = config_for(&server, RestEndpoint::new("rows", "rows"))
        .with_auth(RestAuthSpec::BearerSecret { slot: "t".into() });
    let connector = RestConnector::from_config(config, AuthMethod::secrets([("t", "TOK")]))
        .expect("connector builds");
    let _ = connector
        .introspect_table(super::REST_SOURCE_SCHEMA, "rows")
        .await;
    assert_eq!(
        server.requests()[0].header("authorization"),
        Some("Bearer TOK")
    );

    // Custom header.
    let server = MockServer::start(|_, _| MockResponse::json("[]")).await;
    let config = config_for(&server, RestEndpoint::new("rows", "rows")).with_auth(
        RestAuthSpec::HeaderSecret {
            header: "X-Api-Key".into(),
            slot: "k".into(),
        },
    );
    let connector = RestConnector::from_config(config, AuthMethod::secrets([("k", "KEY")]))
        .expect("connector builds");
    let _ = connector
        .introspect_table(super::REST_SOURCE_SCHEMA, "rows")
        .await;
    assert_eq!(server.requests()[0].header("x-api-key"), Some("KEY"));

    // Query parameter.
    let server = MockServer::start(|_, _| MockResponse::json("[]")).await;
    let config = config_for(&server, RestEndpoint::new("rows", "rows")).with_auth(
        RestAuthSpec::QuerySecret {
            param: "api_key".into(),
            slot: "k".into(),
        },
    );
    let connector = RestConnector::from_config(config, AuthMethod::secrets([("k", "KEY")]))
        .expect("connector builds");
    let _ = connector
        .introspect_table(super::REST_SOURCE_SCHEMA, "rows")
        .await;
    assert!(
        server.requests()[0].query().contains("api_key=KEY"),
        "{}",
        server.requests()[0].query()
    );

    // Basic.
    let server = MockServer::start(|_, _| MockResponse::json("[]")).await;
    let config = config_for(&server, RestEndpoint::new("rows", "rows")).with_auth(
        RestAuthSpec::BasicSecret {
            username: "svc".into(),
            password_slot: "p".into(),
        },
    );
    let connector = RestConnector::from_config(config, AuthMethod::secrets([("p", "PW")]))
        .expect("connector builds");
    let _ = connector
        .introspect_table(super::REST_SOURCE_SCHEMA, "rows")
        .await;
    let header = server.requests()[0]
        .header("authorization")
        .expect("basic auth header")
        .to_string();
    assert!(header.starts_with("Basic "), "got {header}");
}

#[tokio::test]
async fn default_headers_and_static_query_parameters_are_sent() {
    let server = MockServer::start(|_, _| MockResponse::json("[]")).await;
    let config = RestSourceConfig::new(server.base_url())
        .with_header("Accept", "application/vnd.api+json")
        .with_endpoint(RestEndpoint::new("rows", "rows").with_query("region", "eu"));
    let connector = connector(config);
    let _ = connector
        .introspect_table(super::REST_SOURCE_SCHEMA, "rows")
        .await;
    let requests = server.requests();
    assert_eq!(
        requests[0].header("accept"),
        Some("application/vnd.api+json")
    );
    assert!(requests[0].query().contains("region=eu"));
}

// ---------------------------------------------------------------------------
// The restriction contract (the RLS-critical one)
// ---------------------------------------------------------------------------

/// Four rows the restriction tests slice in different ways.
fn restriction_server_body() -> String {
    r#"[
        {"id":1,"region":"East","amount":100},
        {"id":2,"region":"West","amount":30},
        {"id":3,"region":"East","amount":40},
        {"id":4,"region":"North","amount":70}
    ]"#
    .to_string()
}

#[tokio::test]
async fn fetch_data_applies_filters_in_filters_and_or_groups_locally() {
    let server = MockServer::start(|_, _| MockResponse::json(restriction_server_body())).await;
    let connector = connector(config_for(&server, RestEndpoint::new("rows", "rows")));

    // Scalar filter: amount >= 50 → ids 1 and 4.
    let out = connector
        .fetch_data(&FetchRequest {
            filters: vec![FilterCondition::new(
                "amount",
                FilterOperator::GreaterThanOrEqual,
                "50",
            )],
            ..fetch("rows")
        })
        .await
        .expect("fetch");
    assert_eq!(row_count(&out), 2);

    // IN filter (the shape row-level security propagates): region IN ('West').
    let out = connector
        .fetch_data(&FetchRequest {
            in_filters: vec![InFilterCondition {
                column: "region".into(),
                values: vec!["West".into()],
                kind: InValueKind::Text,
            }],
            ..fetch("rows")
        })
        .await
        .expect("fetch");
    assert_eq!(row_count(&out), 1);

    // An EMPTY IN-list must match nothing — an RLS-restricted dimension with no
    // permitted keys restricts the fact to zero rows, never to all of them.
    let out = connector
        .fetch_data(&FetchRequest {
            in_filters: vec![InFilterCondition {
                column: "region".into(),
                values: vec![],
                kind: InValueKind::Text,
            }],
            ..fetch("rows")
        })
        .await
        .expect("fetch");
    assert_eq!(row_count(&out), 0);

    // OR groups (multi-role RLS union): (region = 'West') OR (amount > 50).
    let out = connector
        .fetch_data(&FetchRequest {
            or_groups: vec![
                vec![FilterCondition::new(
                    "region",
                    FilterOperator::Equal,
                    "West",
                )],
                vec![FilterCondition::new(
                    "amount",
                    FilterOperator::GreaterThan,
                    "50",
                )],
            ],
            ..fetch("rows")
        })
        .await
        .expect("fetch");
    // West/30, East/100, North/70 → 3 rows.
    assert_eq!(row_count(&out), 3);

    // All three combined must AND together: (amount >= 50) AND region IN
    // ('East','North') AND ((region='East') OR (amount>65)) → ids 1 and 4.
    let out = connector
        .fetch_data(&FetchRequest {
            filters: vec![FilterCondition::new(
                "amount",
                FilterOperator::GreaterThanOrEqual,
                "50",
            )],
            in_filters: vec![InFilterCondition {
                column: "region".into(),
                values: vec!["East".into(), "North".into()],
                kind: InValueKind::Text,
            }],
            or_groups: vec![
                vec![FilterCondition::new(
                    "region",
                    FilterOperator::Equal,
                    "East",
                )],
                vec![FilterCondition::new(
                    "amount",
                    FilterOperator::GreaterThan,
                    "65",
                )],
            ],
            ..fetch("rows")
        })
        .await
        .expect("fetch");
    assert_eq!(row_count(&out), 2);
}

#[tokio::test]
async fn fetch_data_applies_the_column_projection_and_the_row_limit() {
    let server = MockServer::start(|_, _| MockResponse::json(restriction_server_body())).await;
    let connector = connector(config_for(&server, RestEndpoint::new("rows", "rows")));

    let out = connector
        .fetch_data(&FetchRequest {
            columns: vec!["region".into()],
            limit: Some(2),
            ..fetch("rows")
        })
        .await
        .expect("fetch");
    assert_eq!(row_count(&out), 2);
    assert_eq!(out[0].num_columns(), 1);
    let schema = out[0].schema();
    assert_eq!(schema.field(0).name(), "region");

    // A projection naming a column the endpoint does not produce is an error,
    // not a silently narrower result.
    let err = connector
        .fetch_data(&FetchRequest {
            columns: vec!["nope".into()],
            ..fetch("rows")
        })
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("nope"), "got {err}");
}

// ---------------------------------------------------------------------------
// Unsupported operations
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sql_row_count_and_join_pushdown_are_refused() {
    let server = MockServer::start(|_, _| MockResponse::json("[]")).await;
    let connector = connector(config_for(&server, RestEndpoint::new("rows", "rows")));
    assert!(connector.execute_query("SELECT 1").await.is_err());
    assert!(connector
        .row_count(super::REST_SOURCE_SCHEMA, "rows")
        .await
        .is_err());
    assert!(!connector.capabilities().expression_pushdown);
}
