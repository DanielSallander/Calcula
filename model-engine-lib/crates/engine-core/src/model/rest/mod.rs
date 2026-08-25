//! Persisted, **secret-free** configuration for a REST/Web data source.
//!
//! A REST source is described entirely by data: a base URL, a set of declared
//! endpoints (each of which becomes one source "table"), how to paginate, and
//! how to project a JSON row object onto typed columns. The connector that
//! executes this description lives in `engine-query` — `engine-core` performs
//! **no I/O**, so this module is types plus [`RestSourceConfig::validate`].
//!
//! # No secrets — slot names only
//!
//! These types serialize into the model file, which is shared between users
//! (see the [`source`](super::source) module docs). [`RestAuthSpec`] therefore
//! records only the **name of a secret slot**, never a value: the host resolves
//! slot names to real credentials at wiring time and injects them through
//! `AuthMethod::Secrets`, which is never serialized.
//!
//! [`RestHeader`] and [`RestEndpoint::query`] hold literal values and are
//! persisted verbatim, so they are for non-secret request shaping only
//! (`Accept`, `User-Agent`, an API version pin). Putting a token in a default
//! header writes that token into every copy of the model file. Use a slot.
//!
//! # Transport posture
//!
//! [`RestSourceConfig::validate`] enforces the security floor that the
//! connector then relies on: `https://` everywhere except a **loopback** host
//! (so tests and local development can use plain `http://`), no credentials in
//! the URL's userinfo, no scheme or host smuggled into an endpoint `path`
//! (which would let one endpoint silently target a different server than the
//! one the model declares), a bounded timeout, a bounded response size, and a
//! bounded page count.

mod auth_spec;
mod checks;
mod config;
mod endpoint;
mod validate;

#[cfg(test)]
mod tests;

pub use auth_spec::RestAuthSpec;
pub use checks::{is_loopback_host, validate_absolute_url};
pub use config::{RestHeader, RestSourceConfig};
pub use endpoint::{RestEndpoint, RestField, RestMethod, RestPagination};

/// Default per-request timeout in seconds ([`RestSourceConfig::timeout_secs`]).
pub const DEFAULT_REST_TIMEOUT_SECS: u32 = 30;

/// Upper bound accepted for [`RestSourceConfig::timeout_secs`] (10 minutes).
pub const MAX_REST_TIMEOUT_SECS: u32 = 600;

/// Default cumulative response-body budget for one fetch, in bytes (32 MiB).
pub const DEFAULT_REST_MAX_RESPONSE_BYTES: u64 = 32 * 1024 * 1024;

/// Upper bound accepted for [`RestSourceConfig::max_response_bytes`] (512 MiB).
pub const MAX_REST_RESPONSE_BYTES: u64 = 512 * 1024 * 1024;

/// Upper bound accepted for any pagination mode's `max_pages`.
pub const MAX_REST_PAGE_LIMIT: u32 = 10_000;
