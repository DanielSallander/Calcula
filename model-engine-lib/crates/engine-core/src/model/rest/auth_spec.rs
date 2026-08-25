//! How a REST source authenticates — recorded as **secret slot names**.
//!
//! Split out of [] so no single file in this module carries both the
//! credential shape and the request shape. See the module docs for the
//! no-secrets rule this type exists to enforce.

use serde::{Deserialize, Serialize};

/// How to authenticate to a REST source, recorded as **secret slot names**.
///
/// The engine never stores or serializes a credential value: the host resolves
/// each named slot at wiring time and supplies the values through
/// `AuthMethod::Secrets`, which the connector injects into the outgoing
/// request. A declared slot the host does not supply is a hard error at
/// connector construction — the request is never sent unauthenticated.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RestAuthSpec {
    /// No authentication (a public endpoint).
    #[default]
    None,
    /// `Authorization: Bearer <secret>`.
    BearerSecret {
        /// Name of the secret slot holding the bearer token.
        slot: String,
    },
    /// A custom header whose value is a secret (e.g. `X-Api-Key`).
    HeaderSecret {
        /// Header field name to send the secret in.
        header: String,
        /// Name of the secret slot holding the header value.
        slot: String,
    },
    /// A query-string parameter whose value is a secret (e.g. `?api_key=…`).
    ///
    /// Weaker than a header — query strings are routinely logged by proxies and
    /// servers — but some APIs offer nothing else.
    QuerySecret {
        /// Query parameter name to send the secret in.
        param: String,
        /// Name of the secret slot holding the parameter value.
        slot: String,
    },
    /// HTTP Basic authentication. The username is not a secret and is
    /// persisted; the password comes from a slot.
    BasicSecret {
        /// Basic-auth username (persisted in the model file).
        username: String,
        /// Name of the secret slot holding the password.
        password_slot: String,
    },
}

impl RestAuthSpec {
    /// The secret slot names this spec declares, in declaration order.
    ///
    /// The connector requires every one of them to be present in the
    /// host-supplied secret map before it will issue a request.
    pub fn declared_slots(&self) -> Vec<&str> {
        match self {
            RestAuthSpec::None => Vec::new(),
            RestAuthSpec::BearerSecret { slot }
            | RestAuthSpec::HeaderSecret { slot, .. }
            | RestAuthSpec::QuerySecret { slot, .. } => vec![slot.as_str()],
            RestAuthSpec::BasicSecret { password_slot, .. } => vec![password_slot.as_str()],
        }
    }
}
