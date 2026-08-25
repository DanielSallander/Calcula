//! One endpoint of a REST source: what to request, how to paginate it, and
//! how to project a JSON row object onto typed columns.

use serde::{Deserialize, Serialize};

use crate::types::DataType;

/// HTTP method used to request an endpoint.
///
/// Deliberately limited to the two read shapes an analytical source needs. A
/// mutating method has no place in a refresh path that the engine may retry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RestMethod {
    /// `GET` (the default).
    #[default]
    Get,
    /// `POST` with a static JSON body ([`RestEndpoint::body`]) — the common
    /// shape for search/report APIs that take their parameters in the body.
    Post,
}

impl RestMethod {
    /// The method's uppercase HTTP spelling.
    pub fn as_str(&self) -> &'static str {
        match self {
            RestMethod::Get => "GET",
            RestMethod::Post => "POST",
        }
    }
}

/// One declared column of an endpoint: where to read it from a JSON row object,
/// what to call it, and what engine type to decode it as.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestField {
    /// Dotted path into the row object, e.g. `id` or `customer.name`. A path
    /// segment that is absent (or explicitly `null`) decodes to an Arrow null.
    pub path: String,
    /// Column name in the resulting engine table.
    pub name: String,
    /// Engine type to decode the JSON value as.
    pub data_type: DataType,
}

impl RestField {
    /// Declare a field read from `path` and exposed as `name`.
    pub fn new(path: impl Into<String>, name: impl Into<String>, data_type: DataType) -> Self {
        Self {
            path: path.into(),
            name: name.into(),
            data_type,
        }
    }
}

/// How an endpoint's rows are spread over multiple HTTP requests.
///
/// Every paginating mode carries its own `max_pages` ceiling: an API that never
/// signals "done" (or a cursor that cycles) must terminate the fetch, not hang
/// it. The ceiling is a **stop**, not an error — the pages already read are
/// returned.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RestPagination {
    /// One request, one response (the default).
    #[default]
    None,
    /// `?page=1&size=100`, incrementing `page` from 1 until a page comes back
    /// with fewer rows than `size` (or `max_pages` is reached).
    PageSize {
        /// Query parameter carrying the 1-based page number.
        page_param: String,
        /// Query parameter carrying the page size.
        size_param: String,
        /// Rows requested per page.
        size: u32,
        /// Hard ceiling on the number of requests.
        max_pages: u32,
    },
    /// `?offset=0&limit=100`, advancing `offset` by `limit` until a page comes
    /// back with fewer rows than `limit` (or `max_pages` is reached).
    Offset {
        /// Query parameter carrying the row offset.
        offset_param: String,
        /// Query parameter carrying the page size.
        limit_param: String,
        /// Rows requested per page.
        limit: u32,
        /// Hard ceiling on the number of requests.
        max_pages: u32,
    },
    /// Cursor paging: the next cursor is read out of the response body at
    /// `cursor_path` and sent back as `cursor_param`. Paging stops when the
    /// path is absent, null, or an empty string.
    Cursor {
        /// Query parameter carrying the cursor.
        cursor_param: String,
        /// Dotted path to the next cursor in the response body, e.g.
        /// `meta.nextCursor`.
        cursor_path: String,
        /// Hard ceiling on the number of requests.
        max_pages: u32,
    },
    /// RFC 5988 `Link:` header paging — follow `rel="next"` until it is absent.
    ///
    /// The `next` URL is validated against the same https-or-loopback rule as
    /// the base URL before it is followed, so a compromised API cannot walk the
    /// connector onto an arbitrary (or plaintext) host.
    LinkHeader {
        /// Hard ceiling on the number of requests.
        max_pages: u32,
    },
}

impl RestPagination {
    /// The maximum number of HTTP requests this mode may issue (1 for
    /// [`RestPagination::None`]).
    pub fn max_pages(&self) -> u32 {
        match self {
            RestPagination::None => 1,
            RestPagination::PageSize { max_pages, .. }
            | RestPagination::Offset { max_pages, .. }
            | RestPagination::Cursor { max_pages, .. }
            | RestPagination::LinkHeader { max_pages } => *max_pages,
        }
    }
}

/// One declared endpoint of a REST source. Each endpoint is exposed as a source
/// table named [`name`](Self::name) under the synthetic schema `rest`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestEndpoint {
    /// Source table name for this endpoint (unique within the source).
    pub name: String,
    /// Path joined onto the source's base URL. Must carry **no** scheme or
    /// host: an endpoint may not redirect the source to another server.
    pub path: String,
    /// HTTP method (default `GET`).
    #[serde(default)]
    pub method: RestMethod,
    /// Static query-string parameters sent with every request.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub query: Vec<(String, String)>,
    /// Static JSON request body. Only valid for [`RestMethod::Post`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// Dotted path to the rows array inside the response body. Empty means the
    /// response body **is** the array.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub rows_path: String,
    /// Declared columns. **Empty means infer** by sampling the first page — see
    /// the connector's `introspect_table`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<RestField>,
    /// How this endpoint paginates (default: not at all).
    #[serde(default)]
    pub pagination: RestPagination,
}

impl RestEndpoint {
    /// Declare a `GET` endpoint at `path`, exposed as the table `name`.
    pub fn new(name: impl Into<String>, path: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            path: path.into(),
            method: RestMethod::Get,
            query: Vec::new(),
            body: None,
            rows_path: String::new(),
            fields: Vec::new(),
            pagination: RestPagination::None,
        }
    }

    /// Set the HTTP method.
    pub fn with_method(mut self, method: RestMethod) -> Self {
        self.method = method;
        self
    }

    /// Add a static query-string parameter.
    pub fn with_query(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.query.push((name.into(), value.into()));
        self
    }

    /// Set the static JSON request body (implies [`RestMethod::Post`]).
    pub fn with_body(mut self, body: impl Into<String>) -> Self {
        self.body = Some(body.into());
        self.method = RestMethod::Post;
        self
    }

    /// Set the dotted path to the rows array in the response.
    pub fn with_rows_path(mut self, path: impl Into<String>) -> Self {
        self.rows_path = path.into();
        self
    }

    /// Declare the endpoint's columns (suppressing type inference).
    pub fn with_fields(mut self, fields: Vec<RestField>) -> Self {
        self.fields = fields;
        self
    }

    /// Set the pagination mode.
    pub fn with_pagination(mut self, pagination: RestPagination) -> Self {
        self.pagination = pagination;
        self
    }
}
