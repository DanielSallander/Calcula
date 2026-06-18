//! Authentication and connection target types for data source connectors.
//!
//! This module separates **what to connect to** ([`ConnectionTarget`]) from
//! **how to authenticate** ([`AuthMethod`]). Model files store only the
//! connection target and a preferred auth kind — never secrets.
//!
//! # Design
//!
//! - [`ConnectionTarget`] is serializable and safe to persist in model files.
//! - [`AuthMethod`] is intentionally **not** serializable because it may
//!   contain secrets (passwords, tokens). The host application resolves an
//!   `AuthMethod` at runtime from the user's environment.
//! - [`AuthMethodKind`] is the secret-free discriminant, serializable as a
//!   hint for the preferred auth method.
//! - [`ConnectionSpec`] bundles a target with an auth hint — this is what
//!   a model file stores for each data source.
//!
//! # Adding a new connector
//!
//! Every connector MUST implement [`ConnectorAuth`] and provide a
//! `from_target(ConnectionTarget, AuthMethod)` constructor. See the
//! [`ConnectorAuth`] trait docs for the full checklist.

use serde::{Deserialize, Serialize};

use crate::error::{ConnectorError, ConnectorResult};

/// How to authenticate to a data source.
///
/// This enum is connector-agnostic. Not every auth method is supported by
/// every connector — call [`ConnectorAuth::supported_auth_methods`] to check.
///
/// # Adding new auth methods
///
/// When adding a variant here, you MUST:
/// 1. Update every connector's `supported_auth_methods()` implementation.
/// 2. Update every connector's `from_target()` to handle the new variant
///    (even if only to return [`ConnectorError::AuthMethodNotSupported`]).
/// 3. Add tests for connectors that support the new method.
///
/// [`ConnectorError::AuthMethodNotSupported`]: crate::error::ConnectorError::AuthMethodNotSupported
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum AuthMethod {
    /// Integrated / Windows / SSPI / Kerberos authentication.
    ///
    /// Uses the OS-level identity of the running process. No credentials
    /// are stored or transmitted by the engine. This is the preferred method
    /// in enterprise environments: if Alice opens Bob's model, Alice's own
    /// database permissions apply automatically.
    ///
    /// **SQL Server:** maps to `IntegratedSecurity=true` in the connection
    /// string (requires Windows or Kerberos environment).
    ///
    /// **PostgreSQL:** connects without embedded credentials, relying on
    /// server-side GSSAPI, SSPI, or peer authentication.
    Integrated,

    /// Explicit username and password.
    ///
    /// Credentials are provided at connection time by the host application
    /// (e.g., prompted from the user or read from a secure vault). They are
    /// **not** stored in the model file.
    UsernamePassword {
        /// Database username.
        username: String,
        /// Database password.
        password: String,
    },

    /// Environment-variable-based credential lookup.
    ///
    /// The named environment variables are resolved at connection time.
    /// Only the variable *names* appear in configuration — never the values.
    EnvironmentVariable {
        /// Environment variable name that holds the username.
        username_var: String,
        /// Environment variable name that holds the password.
        password_var: String,
    },
}

/// Describes a database server to connect to — the "what", not the "how".
///
/// This struct is serializable and safe to store in model files. It contains
/// no secrets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectionTarget {
    /// Hostname or IP address.
    pub host: String,

    /// Port number. Each connector applies its own default when `None`
    /// (e.g., 5432 for PostgreSQL, 1433 for SQL Server).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,

    /// Database name.
    pub database: String,

    /// Default schema (e.g., `"public"` for PostgreSQL, `"dbo"` for
    /// SQL Server). Optional — connectors apply their own defaults.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_schema: Option<String>,

    /// Whether to trust the server's TLS certificate without validation.
    /// Useful for development environments with self-signed certificates.
    ///
    /// **PostgreSQL:** when `true`, the connection's ssl-mode is forced to
    /// `require` — TLS is mandatory, but the server certificate is *not*
    /// verified. When `false` (default), sqlx's default applies: ssl-mode
    /// `prefer` (or the `PGSSLMODE` environment variable when set), meaning
    /// TLS is attempted with silent plaintext fallback and no certificate
    /// verification — unchanged from previous releases.
    ///
    /// **SQL Server:** when `true`, the server's TLS certificate is accepted
    /// without validation (`TrustServerCertificate` semantics).
    ///
    /// Stricter verification modes (`verify-ca` / `verify-full`, custom CA
    /// bundles) are future work: they require a dedicated CA / encryption
    /// policy field on [`ConnectionTarget`].
    #[serde(default)]
    pub trust_server_certificate: bool,
}

impl ConnectionTarget {
    /// Create a new connection target with the minimum required fields.
    pub fn new(host: impl Into<String>, database: impl Into<String>) -> Self {
        Self {
            host: host.into(),
            port: None,
            database: database.into(),
            default_schema: None,
            trust_server_certificate: false,
        }
    }

    /// Set the port number.
    pub fn with_port(mut self, port: u16) -> Self {
        self.port = Some(port);
        self
    }

    /// Set the default schema.
    pub fn with_default_schema(mut self, schema: impl Into<String>) -> Self {
        self.default_schema = Some(schema.into());
        self
    }

    /// Enable or disable trusting the server's TLS certificate.
    pub fn with_trust_server_certificate(mut self, trust: bool) -> Self {
        self.trust_server_certificate = trust;
        self
    }
}

/// Secret-free discriminant for [`AuthMethod`].
///
/// Used to declare which auth methods a connector supports, and as a
/// serializable hint in model files (via [`ConnectionSpec`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AuthMethodKind {
    /// Integrated / Windows / Kerberos authentication.
    Integrated,
    /// Explicit username and password.
    UsernamePassword,
    /// Environment-variable-based credential lookup.
    EnvironmentVariable,
}

impl AuthMethod {
    /// Returns the [`AuthMethodKind`] discriminant for this auth method.
    pub fn kind(&self) -> AuthMethodKind {
        match self {
            AuthMethod::Integrated => AuthMethodKind::Integrated,
            AuthMethod::UsernamePassword { .. } => AuthMethodKind::UsernamePassword,
            AuthMethod::EnvironmentVariable { .. } => AuthMethodKind::EnvironmentVariable,
        }
    }
}

/// What a model file stores about a data source connection.
///
/// Contains only the connection target and a hint about which auth method
/// to try — **no secrets**. The host application resolves the actual
/// [`AuthMethod`] at runtime based on the user's environment and the
/// preferred auth kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectionSpec {
    /// Where to connect.
    pub target: ConnectionTarget,
    /// Which authentication method the model author used.
    /// The host app tries this method first, then may fall back to others.
    pub preferred_auth: AuthMethodKind,
}

/// Trait that connector types implement to declare supported auth methods.
///
/// This is separate from the data-operation [`Connector`] trait because it
/// operates at the type level (before a connection exists).
///
/// # For connector implementors
///
/// Every connector MUST implement this trait. If you add a new connector
/// variant to [`AnyConnector`] and forget to implement `ConnectorAuth`,
/// the `supported_auth_methods()` dispatch on `AnyConnector` will not
/// compile.
///
/// ## Full checklist for new connectors
///
/// 1. Implement `ConnectorAuth` — declare which auth methods you support.
/// 2. Add `YourConfig::from_target(ConnectionTarget, AuthMethod)` — build
///    your native connection string/URL from structured parts.
/// 3. Handle **every** [`AuthMethod`] variant in `from_target`, returning
///    [`ConnectorError::AuthMethodNotSupported`] for unsupported ones.
/// 4. Add `Engine::add_<name>_source(ConnectionTarget, AuthMethod)` to the
///    engine facade.
/// 5. Add a variant to [`AnyConnector`] in the registry.
/// 6. Add tests for each supported auth method.
///
/// [`Connector`]: crate::traits::Connector
/// [`AnyConnector`]: engine_query::registry::AnyConnector
/// [`ConnectorError::AuthMethodNotSupported`]: crate::error::ConnectorError::AuthMethodNotSupported
pub trait ConnectorAuth {
    /// Returns the list of auth methods this connector type supports.
    ///
    /// The host application uses this to present appropriate auth options
    /// to the user (e.g., show "Windows Authentication" only for connectors
    /// that include [`AuthMethodKind::Integrated`]).
    fn supported_auth_methods() -> Vec<AuthMethodKind>;
}

/// Validate that a connection parameter contains no embedded NUL byte.
///
/// NUL bytes cannot be represented in the PostgreSQL startup message
/// (NUL-terminated strings) and are meaningless in TDS strings; allowing
/// them through could truncate or restructure protocol messages. Connectors
/// call this on every host / database / credential value before passing it
/// to the driver's typed configuration builder.
pub(crate) fn validate_no_nul(parameter: &str, value: &str) -> ConnectorResult<()> {
    if value.contains('\0') {
        return Err(ConnectorError::InvalidConnectionParameter {
            parameter: parameter.to_string(),
            reason: "value contains an embedded NUL byte".to_string(),
        });
    }
    Ok(())
}

/// Validate the non-credential parts of a [`ConnectionTarget`] (rejects
/// embedded NUL bytes in the host and database). Every connector calls this
/// before handing the target to its driver's typed configuration builder.
pub(crate) fn validate_target(target: &ConnectionTarget) -> ConnectorResult<()> {
    validate_no_nul("host", &target.host)?;
    validate_no_nul("database", &target.database)?;
    Ok(())
}

/// Credentials resolved from an [`AuthMethod`].
///
/// Environment-variable lookups have been performed and any embedded NUL bytes
/// in the resulting username/password rejected. A connector maps this to its
/// own driver auth — in particular it decides whether it accepts
/// [`Integrated`](Self::Integrated) (e.g. PostgreSQL rejects it; SQL Server
/// maps it to Windows/SSPI auth).
pub(crate) enum ResolvedCredentials {
    /// Explicit username and password (given directly, or read from the named
    /// environment variables).
    UsernamePassword {
        /// Resolved database username.
        username: String,
        /// Resolved database password.
        password: String,
    },
    /// OS-level integrated authentication — no embedded credentials.
    Integrated,
}

/// Resolve an [`AuthMethod`] into concrete [`ResolvedCredentials`].
///
/// This is the **single** place that handles every `AuthMethod` variant: it
/// looks up environment variables and validates the resolved credentials for
/// NUL bytes, so each connector's `from_target` only has to decide how to map
/// the result onto its driver (and whether it supports `Integrated`). Because
/// `AuthMethod` is `#[non_exhaustive]`, centralizing the match here means a new
/// auth variant is wired in one location rather than in every connector.
pub(crate) fn resolve_credentials(auth: AuthMethod) -> ConnectorResult<ResolvedCredentials> {
    let (username, password) = match auth {
        AuthMethod::Integrated => return Ok(ResolvedCredentials::Integrated),
        AuthMethod::UsernamePassword { username, password } => (username, password),
        AuthMethod::EnvironmentVariable {
            username_var,
            password_var,
        } => (resolve_env_var(&username_var)?, resolve_env_var(&password_var)?),
    };
    validate_no_nul("username", &username)?;
    validate_no_nul("password", &password)?;
    Ok(ResolvedCredentials::UsernamePassword { username, password })
}

/// Read a required environment variable, mapping an unset variable to a
/// connection error that names it (the value itself is never logged).
fn resolve_env_var(var: &str) -> ConnectorResult<String> {
    std::env::var(var)
        .map_err(|_| ConnectorError::ConnectionFailed(format!("environment variable '{var}' not set")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_target_builder() {
        let target = ConnectionTarget::new("localhost", "mydb")
            .with_port(5432)
            .with_default_schema("public")
            .with_trust_server_certificate(true);

        assert_eq!(target.host, "localhost");
        assert_eq!(target.port, Some(5432));
        assert_eq!(target.database, "mydb");
        assert_eq!(target.default_schema.as_deref(), Some("public"));
        assert!(target.trust_server_certificate);
    }

    #[test]
    fn connection_target_defaults() {
        let target = ConnectionTarget::new("dbserver", "analytics");
        assert_eq!(target.port, None);
        assert_eq!(target.default_schema, None);
        assert!(!target.trust_server_certificate);
    }

    #[test]
    fn connection_target_serde_round_trip() {
        let target = ConnectionTarget::new("host.example.com", "warehouse")
            .with_port(5433)
            .with_default_schema("reporting");

        let json = serde_json::to_string(&target).unwrap();
        let restored: ConnectionTarget = serde_json::from_str(&json).unwrap();
        assert_eq!(target, restored);
    }

    #[test]
    fn connection_target_serde_omits_none_fields() {
        let target = ConnectionTarget::new("host", "db");
        let json = serde_json::to_string(&target).unwrap();
        assert!(!json.contains("port"));
        assert!(!json.contains("default_schema"));
    }

    #[test]
    fn auth_method_kind_serde_round_trip() {
        for kind in [
            AuthMethodKind::Integrated,
            AuthMethodKind::UsernamePassword,
            AuthMethodKind::EnvironmentVariable,
        ] {
            let json = serde_json::to_string(&kind).unwrap();
            let restored: AuthMethodKind = serde_json::from_str(&json).unwrap();
            assert_eq!(kind, restored);
        }
    }

    #[test]
    fn connection_spec_serde_round_trip() {
        let spec = ConnectionSpec {
            target: ConnectionTarget::new("server.corp", "analytics")
                .with_port(1433)
                .with_trust_server_certificate(true),
            preferred_auth: AuthMethodKind::Integrated,
        };

        let json = serde_json::to_string_pretty(&spec).unwrap();
        let restored: ConnectionSpec = serde_json::from_str(&json).unwrap();
        assert_eq!(spec, restored);
    }

    #[test]
    fn validate_no_nul_accepts_clean_value() {
        assert!(validate_no_nul("host", "db.example.com").is_ok());
        assert!(validate_no_nul("password", "p@ss;w0rd/?#=").is_ok());
    }

    #[test]
    fn validate_no_nul_rejects_embedded_nul_byte() {
        let err = validate_no_nul("password", "p\0w").unwrap_err();
        assert!(matches!(
            err,
            ConnectorError::InvalidConnectionParameter { ref parameter, .. }
                if parameter == "password"
        ));
    }

    #[test]
    fn auth_method_kind_discriminant() {
        assert_eq!(AuthMethod::Integrated.kind(), AuthMethodKind::Integrated);
        assert_eq!(
            AuthMethod::UsernamePassword {
                username: "u".into(),
                password: "p".into()
            }
            .kind(),
            AuthMethodKind::UsernamePassword
        );
        assert_eq!(
            AuthMethod::EnvironmentVariable {
                username_var: "U".into(),
                password_var: "P".into()
            }
            .kind(),
            AuthMethodKind::EnvironmentVariable
        );
    }
}
