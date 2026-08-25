//! The source-level configuration: base URL, default headers, auth spec,
//! endpoints, and the transport budgets.

use serde::{Deserialize, Serialize};

use crate::error::EngineResult;

use super::{
    validate, RestAuthSpec, RestEndpoint, DEFAULT_REST_MAX_RESPONSE_BYTES,
    DEFAULT_REST_TIMEOUT_SECS,
};

/// Serde default for [`RestSourceConfig::timeout_secs`].
fn default_timeout_secs() -> u32 {
    DEFAULT_REST_TIMEOUT_SECS
}

/// Serde default for [`RestSourceConfig::max_response_bytes`].
fn default_max_response_bytes() -> u64 {
    DEFAULT_REST_MAX_RESPONSE_BYTES
}

/// A literal request header sent with every request to a REST source.
///
/// **Never a credential** — this value is written into the shared model file
/// verbatim. See the [module docs](self).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestHeader {
    /// Header field name (an RFC 9110 token, e.g. `Accept`).
    pub name: String,
    /// Header field value. Must contain no control characters — a `\r\n` here
    /// would be request-header injection.
    pub value: String,
}

impl RestHeader {
    /// Create a default request header.
    pub fn new(name: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            value: value.into(),
        }
    }
}

/// Secret-free persisted configuration for one REST/Web data source.
///
/// See the [module docs](self) for the no-secrets rule and the transport
/// posture that [`validate`](Self::validate) enforces.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestSourceConfig {
    /// Absolute base URL every endpoint path is joined onto. Must be `https://`
    /// unless its host is loopback, and must carry no `user:password@`
    /// userinfo.
    pub base_url: String,
    /// Non-secret headers sent with every request.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub default_headers: Vec<RestHeader>,
    /// How to authenticate — slot names only.
    #[serde(default)]
    pub auth: RestAuthSpec,
    /// The endpoints this source exposes as tables.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub endpoints: Vec<RestEndpoint>,
    /// Per-request timeout in seconds (default
    /// [`DEFAULT_REST_TIMEOUT_SECS`]). Applies to each page separately.
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u32,
    /// Cumulative response-body budget for one `fetch_data`, in bytes (default
    /// [`DEFAULT_REST_MAX_RESPONSE_BYTES`]). Enforced **while streaming**, so an
    /// oversized or endless body is aborted rather than buffered.
    #[serde(default = "default_max_response_bytes")]
    pub max_response_bytes: u64,
}

impl Default for RestSourceConfig {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            default_headers: Vec::new(),
            auth: RestAuthSpec::None,
            endpoints: Vec::new(),
            timeout_secs: DEFAULT_REST_TIMEOUT_SECS,
            max_response_bytes: DEFAULT_REST_MAX_RESPONSE_BYTES,
        }
    }
}

impl RestSourceConfig {
    /// Create a configuration for `base_url` with the default timeout and size
    /// budget and no endpoints.
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            ..Default::default()
        }
    }

    /// Add a default (non-secret) request header.
    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.default_headers.push(RestHeader::new(name, value));
        self
    }

    /// Set the authentication spec (slot names only).
    pub fn with_auth(mut self, auth: RestAuthSpec) -> Self {
        self.auth = auth;
        self
    }

    /// Declare an endpoint.
    pub fn with_endpoint(mut self, endpoint: RestEndpoint) -> Self {
        self.endpoints.push(endpoint);
        self
    }

    /// Set the per-request timeout in seconds.
    pub fn with_timeout_secs(mut self, secs: u32) -> Self {
        self.timeout_secs = secs;
        self
    }

    /// Set the cumulative response-body budget in bytes.
    pub fn with_max_response_bytes(mut self, bytes: u64) -> Self {
        self.max_response_bytes = bytes;
        self
    }

    /// Look up a declared endpoint by its table name.
    pub fn endpoint(&self, name: &str) -> Option<&RestEndpoint> {
        self.endpoints.iter().find(|e| e.name == name)
    }

    /// Check every rule the connector relies on before it will issue a request.
    ///
    /// Enforces: an absolute `https://` base URL (plain `http://` only for a
    /// loopback host) with no userinfo; at least one endpoint, with non-empty
    /// unique names; endpoint paths that carry no scheme, host, or `..`
    /// traversal; injection-free header and query names/values; a parseable
    /// JSON body only on `POST`; unique non-empty field names; a `max_pages`
    /// of at least 1 and at most [`MAX_REST_PAGE_LIMIT`]; and a timeout and
    /// response budget within [`MAX_REST_TIMEOUT_SECS`] /
    /// [`MAX_REST_RESPONSE_BYTES`].
    ///
    /// Returns [`EngineError::InvalidData`](crate::error::EngineError::InvalidData)
    /// naming the offending element. Never performs I/O.
    pub fn validate(&self) -> EngineResult<()> {
        validate::validate_config(self)
    }
}
