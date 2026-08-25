//! HTTP transport for the REST connector.
//!
//! Everything security-relevant about how a request leaves this process lives
//! here, in one place:
//!
//! - **No redirects.** [`reqwest::redirect::Policy::none`]. A `3xx` comes back
//!   as an ordinary response and is reported as a refusal naming the
//!   `Location`. Following one would let a server move an authenticated request
//!   — headers and all — onto a host the model never declared.
//! - **No cookie jar.** The `cookies` feature is not enabled at all, so there
//!   is no cross-request state a server could set.
//! - **A per-request timeout**, from `RestSourceConfig::timeout_secs`.
//! - **A cumulative response-size budget**, enforced *while streaming*: the
//!   `Content-Length` is checked before the first byte and every chunk is
//!   counted, so an oversized (or endless) body is aborted rather than
//!   buffered.
//! - **Secrets never reach a message.** Errors are constructed here, never
//!   forwarded from `reqwest` with a URL attached (`Error::without_url`), and
//!   every string this module produces is passed through
//!   [`RestTransport::redact`], which replaces each resolved secret value with
//!   `***`. The [`Debug`] impl redacts too.

use std::time::Duration;

use engine_connectors::{ConnectorError, ConnectorResult};
use engine_core::model::{RestHeader, RestMethod, RestSourceConfig};

/// The placeholder a redacted secret is replaced with.
pub(crate) const REDACTED: &str = "***";

/// Maximum number of body bytes quoted back in an error message (after
/// redaction) when a request fails with a non-success status.
const ERROR_BODY_SNIPPET_BYTES: usize = 200;

/// A resolved credential: the connector's `RestAuthSpec` with its secret slot
/// names replaced by the values the host supplied.
///
/// Deliberately **not** `Debug`/`Clone`-derived into anything that prints — the
/// only formatting route is [`RestTransport`]'s redacting [`Debug`].
pub(crate) enum RestCredential {
    /// No authentication.
    None,
    /// `Authorization: Bearer <token>`.
    Bearer(String),
    /// A custom header carrying the secret.
    Header {
        /// Header field name.
        name: String,
        /// Secret header value.
        value: String,
    },
    /// A query-string parameter carrying the secret.
    Query {
        /// Query parameter name.
        param: String,
        /// Secret parameter value.
        value: String,
    },
    /// HTTP Basic authentication.
    Basic {
        /// Basic-auth username (not a secret).
        username: String,
        /// Basic-auth password.
        password: String,
    },
}

impl RestCredential {
    /// The secret values this credential carries, for redaction. The Basic
    /// username is excluded — it is persisted in the model file and is not a
    /// secret.
    fn secret_values(&self) -> Vec<String> {
        match self {
            RestCredential::None => Vec::new(),
            RestCredential::Bearer(t) => vec![t.clone()],
            RestCredential::Header { value, .. } => vec![value.clone()],
            RestCredential::Query { value, .. } => vec![value.clone()],
            RestCredential::Basic { password, .. } => vec![password.clone()],
        }
    }
}

/// One request in a paginated fetch.
pub(crate) struct PageRequest {
    /// Absolute URL (already joined and, for `Link`-header paging, validated).
    pub(crate) url: String,
    /// HTTP method.
    pub(crate) method: RestMethod,
    /// Query-string parameters to append (static plus paging).
    pub(crate) query: Vec<(String, String)>,
    /// Static JSON request body (POST only).
    pub(crate) body: Option<String>,
}

/// One response, read into memory under the size budget.
pub(crate) struct HttpPage {
    /// The full response body.
    pub(crate) body: Vec<u8>,
    /// The `rel="next"` URL from an RFC 5988 `Link` header, if present.
    pub(crate) next_link: Option<String>,
}

/// The REST connector's HTTP client, its default headers, and its resolved
/// credential. See the [module docs](self) for the security posture.
pub(crate) struct RestTransport {
    client: reqwest::Client,
    default_headers: Vec<RestHeader>,
    credential: RestCredential,
    /// Every resolved secret value, used *only* to scrub message text.
    redactions: Vec<String>,
    /// Per-request timeout, kept for error messages.
    timeout_secs: u32,
}

impl std::fmt::Debug for RestTransport {
    /// Prints no credential material — not the values, not their lengths.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RestTransport")
            .field("default_headers", &self.default_headers.len())
            .field("credential", &REDACTED)
            .field("timeout_secs", &self.timeout_secs)
            .finish()
    }
}

impl RestTransport {
    /// Build the transport for `config` with an already-resolved `credential`.
    ///
    /// The client refuses redirects, keeps no cookies, and applies
    /// `config.timeout_secs` to every request.
    pub(crate) fn new(
        config: &RestSourceConfig,
        credential: RestCredential,
    ) -> ConnectorResult<Self> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(u64::from(config.timeout_secs)))
            .build()
            .map_err(|e| {
                ConnectorError::ConnectionFailed(format!(
                    "REST connector: could not build the HTTP client: {}",
                    e.without_url()
                ))
            })?;
        let redactions = credential
            .secret_values()
            .into_iter()
            .filter(|v| !v.is_empty())
            .collect();
        Ok(Self {
            client,
            default_headers: config.default_headers.clone(),
            credential,
            redactions,
            timeout_secs: config.timeout_secs,
        })
    }

    /// Replace every resolved secret value in `text` with [`REDACTED`].
    ///
    /// Every message this connector produces goes through here. It is a
    /// backstop, not the primary defence — messages are built so a secret has
    /// no route into them in the first place — but a backstop that costs a
    /// string scan is worth having on a path that handles credentials.
    pub(crate) fn redact(&self, text: impl Into<String>) -> String {
        let mut text = text.into();
        for secret in &self.redactions {
            if text.contains(secret.as_str()) {
                text = text.replace(secret.as_str(), REDACTED);
            }
        }
        text
    }

    /// Issue one request and read its body, charging the bytes read against
    /// `budget` (the fetch's remaining `max_response_bytes`).
    ///
    /// Errors on a non-success status (including a refused redirect), on a body
    /// that would exceed the budget, and on any transport failure. The URL's
    /// query string never appears in an error — that is where a
    /// `QuerySecret` lives.
    pub(crate) async fn fetch(
        &self,
        request: &PageRequest,
        budget: &mut u64,
    ) -> ConnectorResult<HttpPage> {
        let mut builder = match request.method {
            RestMethod::Get => self.client.get(&request.url),
            RestMethod::Post => self.client.post(&request.url),
        };
        for header in &self.default_headers {
            builder = builder.header(header.name.as_str(), header.value.as_str());
        }
        if !request.query.is_empty() {
            builder = builder.query(&request.query);
        }
        match &self.credential {
            RestCredential::None => {}
            RestCredential::Bearer(token) => builder = builder.bearer_auth(token),
            RestCredential::Header { name, value } => {
                builder = builder.header(name.as_str(), value.as_str());
            }
            RestCredential::Query { param, value } => {
                builder = builder.query(&[(param.as_str(), value.as_str())]);
            }
            RestCredential::Basic { username, password } => {
                builder = builder.basic_auth(username, Some(password));
            }
        }
        if let Some(body) = &request.body {
            builder = builder
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body.clone());
        }

        let where_ = url_without_query(&request.url).to_string();
        let response = builder
            .send()
            .await
            .map_err(|e| self.transport_error(&where_, e))?;

        let status = response.status();
        let next_link = response
            .headers()
            .get(reqwest::header::LINK)
            .and_then(|v| v.to_str().ok())
            .and_then(parse_link_next);

        if status.is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .map(url_without_query)
                .unwrap_or("(no Location header)")
                .to_string();
            return Err(ConnectorError::QueryFailed(self.redact(format!(
                "REST request to {where_} was answered with redirect {status} to '{location}'; \
                 the REST connector refuses redirects (a redirect can move an authenticated \
                 request to a host the model does not declare)"
            ))));
        }

        if !status.is_success() {
            let snippet = self.error_snippet(response).await;
            return Err(ConnectorError::QueryFailed(self.redact(format!(
                "REST request to {where_} failed with status {status}{snippet}"
            ))));
        }

        if let Some(len) = response.content_length() {
            if len > *budget {
                return Err(self.budget_error(&where_, len, *budget));
            }
        }

        let body = self.read_capped(response, budget, &where_).await?;
        Ok(HttpPage { body, next_link })
    }

    /// Read a response body chunk by chunk, aborting the moment the cumulative
    /// budget would be exceeded. The bytes actually read are subtracted from
    /// `budget`, so the cap spans every page of a paginated fetch.
    async fn read_capped(
        &self,
        mut response: reqwest::Response,
        budget: &mut u64,
        where_: &str,
    ) -> ConnectorResult<Vec<u8>> {
        let mut body: Vec<u8> = Vec::new();
        loop {
            let chunk = response
                .chunk()
                .await
                .map_err(|e| self.transport_error(where_, e))?;
            let Some(chunk) = chunk else { break };
            let len = chunk.len() as u64;
            if len > *budget {
                return Err(self.budget_error(where_, body.len() as u64 + len, *budget));
            }
            *budget -= len;
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }

    /// The size-cap refusal, worded the same way wherever it is raised.
    fn budget_error(&self, where_: &str, needed: u64, remaining: u64) -> ConnectorError {
        ConnectorError::QueryFailed(self.redact(format!(
            "REST response from {where_} exceeds the source's max_response_bytes budget \
             (needs at least {needed} more bytes, {remaining} remaining); raise \
             max_response_bytes or narrow the endpoint"
        )))
    }

    /// Read up to [`ERROR_BODY_SNIPPET_BYTES`] of an error response for context.
    /// Best-effort: a body that cannot be read yields no snippet.
    async fn error_snippet(&self, response: reqwest::Response) -> String {
        match response.bytes().await {
            Ok(bytes) => {
                if bytes.is_empty() {
                    return String::new();
                }
                let end = bytes.len().min(ERROR_BODY_SNIPPET_BYTES);
                let text = String::from_utf8_lossy(&bytes[..end]);
                format!(": {}", text.trim())
            }
            Err(_) => String::new(),
        }
    }

    /// Map a `reqwest` failure onto a connector error, stripping the URL (it
    /// carries the query string, and a `QuerySecret` lives there) and naming
    /// the failure mode so a timeout is distinguishable from a refusal.
    fn transport_error(&self, where_: &str, error: reqwest::Error) -> ConnectorError {
        let timeout_secs = self.timeout_secs;
        let stripped = error.without_url();
        let what = if stripped.is_timeout() {
            format!("timed out after {timeout_secs}s")
        } else if stripped.is_connect() {
            "could not connect".to_string()
        } else if stripped.is_decode() {
            "failed while reading the response body".to_string()
        } else {
            "failed".to_string()
        };
        ConnectorError::QueryFailed(
            self.redact(format!("REST request to {where_} {what}: {stripped}")),
        )
    }
}

/// Join an endpoint path onto the source's base URL.
///
/// The path is always relative (validation refuses a scheme, a host, and `..`),
/// so this is a plain concatenation with exactly one `/` between the two — no
/// URL parser is needed and none of the "resolve against the base" surprises of
/// RFC 3986 apply.
pub(crate) fn join_url(base_url: &str, path: &str) -> String {
    let path = path.trim();
    if path.is_empty() {
        return base_url.to_string();
    }
    format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

/// The part of a URL before its query string — safe to quote in an error
/// because a `QuerySecret` only ever appears after the `?`.
pub(crate) fn url_without_query(url: &str) -> &str {
    match url.find('?') {
        Some(i) => &url[..i],
        None => url,
    }
}

/// Extract the `rel="next"` target from an RFC 5988 `Link` header value.
///
/// Handles the multi-link form `<u1>; rel="prev", <u2>; rel="next"` and a
/// space-separated relation list (`rel="next last"`), and tolerates commas
/// inside a URL because links are located by their angle brackets rather than
/// by splitting the header on `,`.
pub(crate) fn parse_link_next(header: &str) -> Option<String> {
    let mut rest = header;
    loop {
        let start = rest.find('<')?;
        let after = &rest[start + 1..];
        let end = after.find('>')?;
        let url = after[..end].trim();
        let params_rest = &after[end + 1..];
        let params_end = params_rest.find('<').unwrap_or(params_rest.len());
        let params = &params_rest[..params_end];
        let is_next = params
            .split(';')
            .filter_map(|p| p.split_once('='))
            .any(|(key, value)| {
                // The params slice runs up to the *next* link, so a middle
                // entry keeps its `, ` separator: `rel="next", ` must still
                // read as `next`. Strip the separator before the quotes.
                let relations = value.trim().trim_end_matches(',').trim().trim_matches('"');
                key.trim().eq_ignore_ascii_case("rel")
                    && relations
                        .split_whitespace()
                        .any(|token| token.eq_ignore_ascii_case("next"))
            });
        if is_next && !url.is_empty() {
            return Some(url.to_string());
        }
        rest = params_rest;
    }
}
