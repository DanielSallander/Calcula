//! Built-in REST/Web connector: JSON over HTTP as a first-class data source.
//!
//! [`RestConnector`] turns a declarative
//! [`RestSourceConfig`] — base URL, endpoints, pagination, field mapping — into
//! source tables. It is a **fetch-only** connector in the sense of
//! [`ConnectorCapabilities`](engine_connectors::traits::ConnectorCapabilities):
//! it pushes nothing to the source and advertises no pushdown, so the planner
//! computes everything but the scan locally.
//!
//! # The restriction contract is applied locally, always
//!
//! A REST endpoint cannot be handed a `WHERE` clause, so this connector fetches
//! the endpoint's rows and then applies the **whole** [`FetchRequest`]
//! restriction contract itself — `filters` **and** `in_filters` **and**
//! `or_groups`, plus `columns` and `limit`. Honoring all three restriction
//! kinds is a hard correctness and row-level-security requirement (see
//! `docs/adding-a-connector.md`): the planner pushes user slicers *and* the
//! propagated RLS / relationship IN-filters through this same field, so
//! dropping any of them over-returns rows. The work is done by the same shared
//! DataFusion helper the in-memory, CSV and Parquet connectors use
//! ([`apply_filters`]), so there is exactly one implementation of the contract.
//!
//! # Security posture
//!
//! Transport rules (no redirects, no cookies, https-or-loopback, a per-request
//! timeout, a streamed response-size cap, and redaction of every secret from
//! errors and [`Debug`]) live in [`http`] and are described there. The
//! configuration-level half (what a model file may declare at all) lives in
//! `engine_core::model::rest`.
//!
//! # Type inference
//!
//! An endpoint with no declared `fields` has its schema inferred by sampling
//! its first page — **`Boolean`/`Int64`/`Float64`/`String` only**. Dates,
//! timestamps and decimals are never guessed from a string; they need an
//! explicit field mapping. See [`json_rows::infer_fields`].

mod decode;
mod http;
mod json_rows;
mod pagination;

#[cfg(test)]
mod tests;

use std::collections::HashMap;

use arrow::record_batch::RecordBatch;
use engine_connectors::auth::{AuthMethod, AuthMethodKind, ConnectionTarget, ConnectorAuth};
use engine_connectors::traits::{Connector, FetchRequest, JoinAggregationRequest, SourceTable};
use engine_connectors::{ConnectorError, ConnectorResult};
use engine_core::model::Column;
use engine_core::model::{RestAuthSpec, RestField, RestSourceConfig, Table};

use crate::in_memory_connector::{apply_filters, apply_projection_and_limit};

use self::http::{RestCredential, RestTransport};

/// The synthetic source schema every REST endpoint is listed under.
pub const REST_SOURCE_SCHEMA: &str = "rest";

/// A connector that serves a JSON-over-HTTP API's endpoints as source tables.
///
/// Build it with [`from_config`](Self::from_config): a REST source has no
/// host/port/database [`ConnectionTarget`], so the connection-target
/// constructor every database connector has cannot express one.
pub struct RestConnector {
    /// Boxed deliberately. Unlike a database connector — a pool handle and a
    /// cache — a REST connector carries its whole *declarative* configuration
    /// inline (base URL, headers, every endpoint with its fields and paging).
    /// `AnyConnector` is a closed enum, so that size would be paid by every
    /// variant, and by `SourceCredential` above it. One pointer instead.
    inner: Box<RestConnectorInner>,
}

/// The connector's actual state, behind [`RestConnector`]'s box.
struct RestConnectorInner {
    /// The secret-free configuration this connector serves.
    config: RestSourceConfig,
    /// The HTTP client, default headers, and resolved credential.
    transport: RestTransport,
}

impl std::fmt::Debug for RestConnector {
    /// Prints the source's shape but never a credential — the transport's own
    /// [`Debug`] redacts, and nothing here reaches into it.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RestConnector")
            .field(
                "base_url",
                &http::url_without_query(&self.inner.config.base_url),
            )
            .field("endpoints", &self.inner.config.endpoints.len())
            .field("transport", &self.inner.transport)
            .finish()
    }
}

impl ConnectorAuth for RestConnector {
    /// A REST source authenticates with **named secret slots**
    /// ([`AuthMethodKind::SecretMap`]) — its configuration declares slot names
    /// and the host resolves them — or with none at all
    /// ([`AuthMethodKind::Integrated`], meaning a public endpoint). The
    /// username/password and environment-variable methods are database
    /// concepts and do not describe how an HTTP API is authenticated.
    fn supported_auth_methods() -> Vec<AuthMethodKind> {
        vec![AuthMethodKind::SecretMap, AuthMethodKind::Integrated]
    }
}

impl RestConnector {
    /// Build a connector from a validated configuration and a host-supplied
    /// auth.
    ///
    /// The configuration is validated first (see
    /// [`RestSourceConfig::validate`]), then every secret slot the config
    /// declares is looked up in the auth. A **declared slot the host did not
    /// supply is an error** — the connector never falls back to sending the
    /// request unauthenticated, which would leak the request to an endpoint
    /// that may answer it differently (or publicly) rather than refusing.
    ///
    /// Opens no connection: the first request happens at
    /// [`introspect_table`](Connector::introspect_table) or
    /// [`fetch_data`](Connector::fetch_data).
    pub fn from_config(config: RestSourceConfig, auth: AuthMethod) -> ConnectorResult<Self> {
        config.validate().map_err(ConnectorError::Engine)?;
        let credential = resolve_credential(&config, auth)?;
        let transport = RestTransport::new(&config, credential)?;
        Ok(Self {
            inner: Box::new(RestConnectorInner { config, transport }),
        })
    }

    /// The auth-checklist constructor every connector has — which a REST source
    /// **cannot** satisfy, and says so.
    ///
    /// [`ConnectionTarget`] describes a database server (host, port, database,
    /// schema). None of those name an HTTP endpoint, a pagination mode, or a
    /// field mapping, and silently inventing a base URL from `host`/`database`
    /// would produce a source that points somewhere the model never declared.
    /// Use [`from_config`](Self::from_config).
    pub fn from_target(_target: ConnectionTarget, _auth: AuthMethod) -> ConnectorResult<Self> {
        Err(ConnectorError::UnsupportedOperation(
            "REST connector: a REST source has no host/port/database connection target — its \
             base URL, endpoints, pagination and field mapping live in a RestSourceConfig. \
             Build it with RestConnector::from_config (or Engine::add_rest_source)."
                .into(),
        ))
    }

    /// The configuration this connector was built from (secret-free).
    pub fn config(&self) -> &RestSourceConfig {
        &self.inner.config
    }

    /// Look up a declared endpoint, or report which names do exist.
    fn endpoint(&self, table: &str) -> ConnectorResult<&engine_core::model::RestEndpoint> {
        self.inner.config.endpoint(table).ok_or_else(|| {
            let declared: Vec<&str> = self
                .inner
                .config
                .endpoints
                .iter()
                .map(|e| e.name.as_str())
                .collect();
            ConnectorError::QueryFailed(format!(
                "REST source has no endpoint '{table}' (declared: {})",
                if declared.is_empty() {
                    "none".to_string()
                } else {
                    declared.join(", ")
                }
            ))
        })
    }

    /// Fetch an endpoint's rows and decode them into one Arrow batch, inferring
    /// the schema when the endpoint declares no fields.
    async fn fetch_batch(
        &self,
        endpoint: &engine_core::model::RestEndpoint,
        page_cap: u32,
    ) -> ConnectorResult<(RecordBatch, Vec<RestField>)> {
        let mut budget = self.inner.config.max_response_bytes;
        let rows = pagination::fetch_all_rows(
            &self.inner.transport,
            &self.inner.config.base_url,
            endpoint,
            page_cap,
            &mut budget,
        )
        .await?;
        let fields = if endpoint.fields.is_empty() {
            json_rows::infer_fields(&endpoint.name, &rows)?
        } else {
            endpoint.fields.clone()
        };
        let batch = decode::rows_to_batch(&endpoint.name, &rows, &fields)?;
        Ok((batch, fields))
    }
}

/// Resolve the configuration's declared secret slots against the host-supplied
/// auth, producing the credential the transport injects into each request.
///
/// Error messages name the **slot**, never a value.
fn resolve_credential(
    config: &RestSourceConfig,
    auth: AuthMethod,
) -> ConnectorResult<RestCredential> {
    let declared = config.auth.declared_slots();
    let secrets: HashMap<String, String> = match auth {
        AuthMethod::Secrets(map) => {
            // The same NUL rule every other credential goes through, from the
            // one place that owns it (this connector resolves its own slots, so
            // it does not route through `auth::resolve_credentials`).
            engine_connectors::auth::validate_secret_map(&map)?;
            map
        }
        AuthMethod::Integrated => {
            if !declared.is_empty() {
                return Err(ConnectorError::AuthMethodNotSupported(format!(
                    "REST source declares secret slot(s) [{}] but was wired with \
                     AuthMethod::Integrated, which supplies none; use AuthMethod::Secrets",
                    declared.join(", ")
                )));
            }
            HashMap::new()
        }
        AuthMethod::UsernamePassword { .. } => {
            return Err(ConnectorError::AuthMethodNotSupported(
                "REST connector: AuthMethod::UsernamePassword is a database concept; declare a \
                 BasicSecret auth spec (username + password slot) and supply the slot with \
                 AuthMethod::Secrets"
                    .into(),
            ));
        }
        AuthMethod::EnvironmentVariable { .. } => {
            return Err(ConnectorError::AuthMethodNotSupported(
                "REST connector: AuthMethod::EnvironmentVariable is a database concept; the host \
                 resolves a REST source's secret slots itself and supplies them with \
                 AuthMethod::Secrets"
                    .into(),
            ));
        }
        // `AuthMethod` is `#[non_exhaustive]`: a future method is not one this
        // connector knows how to map onto an HTTP request.
        _ => {
            return Err(ConnectorError::AuthMethodNotSupported(
                "REST connector: only AuthMethod::Secrets (named slots) and \
                 AuthMethod::Integrated (no authentication) are supported"
                    .into(),
            ));
        }
    };

    let take = |slot: &str| -> ConnectorResult<String> {
        secrets.get(slot).cloned().ok_or_else(|| {
            ConnectorError::ConnectionFailed(format!(
                "REST source declares secret slot '{slot}' but the host supplied no value for it"
            ))
        })
    };

    Ok(match &config.auth {
        RestAuthSpec::None => RestCredential::None,
        RestAuthSpec::BearerSecret { slot } => RestCredential::Bearer(take(slot)?),
        RestAuthSpec::HeaderSecret { header, slot } => RestCredential::Header {
            name: header.clone(),
            value: take(slot)?,
        },
        RestAuthSpec::QuerySecret { param, slot } => RestCredential::Query {
            param: param.clone(),
            value: take(slot)?,
        },
        RestAuthSpec::BasicSecret {
            username,
            password_slot,
        } => RestCredential::Basic {
            username: username.clone(),
            password: take(password_slot)?,
        },
    })
}

impl Connector for RestConnector {
    /// Every declared endpoint, under the synthetic schema
    /// [`REST_SOURCE_SCHEMA`]. No request is issued — the endpoint list is
    /// declarative.
    async fn list_tables(&self) -> ConnectorResult<Vec<SourceTable>> {
        Ok(self
            .inner
            .config
            .endpoints
            .iter()
            .map(|endpoint| SourceTable {
                schema: REST_SOURCE_SCHEMA.to_string(),
                name: endpoint.name.clone(),
            })
            .collect())
    }

    /// The endpoint's schema.
    ///
    /// An endpoint with declared `fields` is answered offline from the
    /// declaration. One without them is **sampled**: its first page is fetched
    /// and the columns inferred as `Boolean`/`Int64`/`Float64`/`String` only —
    /// a `Date`, `Timestamp` or `Decimal` column cannot be told from a string
    /// by looking at it and must be declared explicitly.
    async fn introspect_table(&self, _schema: &str, table_name: &str) -> ConnectorResult<Table> {
        let endpoint = self.endpoint(table_name)?;
        let fields = if endpoint.fields.is_empty() {
            let mut budget = self.inner.config.max_response_bytes;
            let rows = pagination::fetch_all_rows(
                &self.inner.transport,
                &self.inner.config.base_url,
                endpoint,
                1,
                &mut budget,
            )
            .await?;
            json_rows::infer_fields(&endpoint.name, &rows)?
        } else {
            endpoint.fields.clone()
        };
        let columns: Vec<Column> = fields
            .iter()
            .map(|f| Column::new(&f.name, f.data_type.clone()))
            .collect();
        Table::new(table_name, columns).map_err(|e| {
            ConnectorError::IntrospectionFailed(format!("REST endpoint '{table_name}': {e}"))
        })
    }

    /// Fetch the endpoint's rows, then apply the **full** [`FetchRequest`]
    /// restriction contract locally: `filters`, `in_filters`, `or_groups`,
    /// `columns` and `limit`. See the [module docs](self) for why all of it is
    /// mandatory.
    async fn fetch_data(&self, request: &FetchRequest) -> ConnectorResult<Vec<RecordBatch>> {
        let endpoint = self.endpoint(&request.table)?;
        let (batch, _fields) = self
            .fetch_batch(endpoint, endpoint.pagination.max_pages())
            .await?;
        let filtered = apply_filters(&batch, request).await?;
        apply_projection_and_limit(filtered, request)
    }

    /// Not supported: a REST endpoint has no SQL surface.
    async fn execute_query(&self, _sql: &str) -> ConnectorResult<Vec<RecordBatch>> {
        Err(ConnectorError::UnsupportedOperation(
            "REST connector does not execute raw SQL — a REST endpoint has no SQL surface".into(),
        ))
    }

    /// Not supported. Counting rows would mean walking every page of the
    /// endpoint, which is the same cost as fetching it — so the engine fetches
    /// instead of asking, and this refuses rather than hiding a full scan
    /// behind a name that promises a cheap count.
    async fn row_count(&self, _schema: &str, table_name: &str) -> ConnectorResult<usize> {
        Err(ConnectorError::UnsupportedOperation(format!(
            "REST connector cannot count rows for '{table_name}' without fetching every page; \
             refresh the table instead"
        )))
    }

    /// Not supported: this connector advertises no pushdown, so the planner
    /// never routes a join-aggregation here.
    async fn execute_join_aggregation(
        &self,
        _request: &JoinAggregationRequest,
    ) -> ConnectorResult<Vec<RecordBatch>> {
        Err(ConnectorError::UnsupportedOperation(
            "REST connector does not support join-aggregation pushdown".into(),
        ))
    }
}
