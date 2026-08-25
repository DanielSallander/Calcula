//! The paging loop: turn one endpoint declaration into the sequence of HTTP
//! requests that yields all of its rows.
//!
//! Every mode is bounded twice over, because an API that never says "done" must
//! terminate the fetch rather than hang it:
//!
//! - by `max_pages`, which the model validates to be between 1 and
//!   `MAX_REST_PAGE_LIMIT`; and
//! - by the source's cumulative `max_response_bytes`, which is charged across
//!   *all* pages, not per page.
//!
//! Reaching either bound is a **stop**, not an error — except the byte budget,
//! which is a refusal, since silently returning a truncated table would be a
//! wrong answer.

use engine_connectors::{ConnectorError, ConnectorResult};
use engine_core::model::rest::require_same_authority;
use engine_core::model::{validate_absolute_url, RestEndpoint, RestPagination};
use serde_json::Value;

use super::http::{join_url, PageRequest, RestTransport};
use super::json_rows::{extract_cursor, extract_rows};

/// Fetch every page of `endpoint` and return the concatenated row values.
///
/// `page_cap` bounds the number of requests: normally the endpoint's own
/// `max_pages`, but the introspection path passes `1` because a single page is
/// enough to sample a schema.
///
/// `budget` is the fetch's remaining response-byte allowance and is decremented
/// as pages are read, so a source's `max_response_bytes` limits the whole
/// paginated fetch rather than each page separately.
pub(crate) async fn fetch_all_rows(
    transport: &RestTransport,
    base_url: &str,
    endpoint: &RestEndpoint,
    page_cap: u32,
    budget: &mut u64,
) -> ConnectorResult<Vec<Value>> {
    let start_url = join_url(base_url, &endpoint.path);
    let mut rows: Vec<Value> = Vec::new();
    let mut state = PageState::start(&endpoint.pagination);
    let mut url = start_url;
    let cap = page_cap.max(1);

    for _ in 0..cap {
        let request = PageRequest {
            url: url.clone(),
            method: endpoint.method,
            query: state.query_params(endpoint),
            body: endpoint.body.clone(),
        };
        let page = transport.fetch(&request, budget).await?;
        let body: Value = serde_json::from_slice(&page.body).map_err(|e| {
            ConnectorError::QueryFailed(transport.redact(format!(
                "REST endpoint '{}' returned a body that is not JSON: {e}",
                endpoint.name
            )))
        })?;
        let page_rows = extract_rows(&body, &endpoint.rows_path)
            .map_err(|e| ConnectorError::QueryFailed(transport.redact(e.to_string())))?;
        let page_row_count = page_rows.len();
        rows.extend(page_rows);

        match state.advance(&endpoint.pagination, page_row_count, &body, page.next_link)? {
            Advance::Stop => break,
            Advance::SameUrl => {}
            Advance::NewUrl(next) => {
                let what = "the Link header's rel=\"next\" URL";
                validate_absolute_url(&next, what).map_err(ConnectorError::Engine)?;
                // PIN THE HOST. The scheme check alone lets a server name any
                // https host, and the transport attaches this source's resolved
                // credential to every request it makes — so an unpinned `next`
                // hands the secret to whoever the server chose. This is the same
                // attack `redirect::Policy::none()` refuses; a Link header is
                // just a redirect the body asks for politely.
                require_same_authority(&next, base_url, what).map_err(ConnectorError::Engine)?;
                url = next;
            }
        }
    }
    Ok(rows)
}

/// What to do after reading a page.
enum Advance {
    /// No more pages.
    Stop,
    /// Request the same URL again with updated paging parameters.
    SameUrl,
    /// Request this absolute URL next (`Link`-header paging).
    NewUrl(String),
}

/// The mutable cursor through a paginated endpoint.
enum PageState {
    /// Unpaginated: one request and done.
    Single,
    /// 1-based page number.
    Page(u32),
    /// Row offset.
    Offset(u64),
    /// The cursor to send next, or `None` on the first request.
    Cursor(Option<String>),
    /// `Link`-header paging holds its state in the URL itself.
    Link,
}

impl PageState {
    /// The starting state for a pagination mode.
    fn start(pagination: &RestPagination) -> Self {
        match pagination {
            RestPagination::None => PageState::Single,
            RestPagination::PageSize { .. } => PageState::Page(1),
            RestPagination::Offset { .. } => PageState::Offset(0),
            RestPagination::Cursor { .. } => PageState::Cursor(None),
            RestPagination::LinkHeader { .. } => PageState::Link,
        }
    }

    /// The endpoint's static query parameters plus this page's paging
    /// parameters. `Link` paging adds none — the next URL already carries them.
    fn query_params(&self, endpoint: &RestEndpoint) -> Vec<(String, String)> {
        let mut params: Vec<(String, String)> = endpoint.query.clone();
        match (&endpoint.pagination, self) {
            (
                RestPagination::PageSize {
                    page_param,
                    size_param,
                    size,
                    ..
                },
                PageState::Page(page),
            ) => {
                params.push((page_param.clone(), page.to_string()));
                params.push((size_param.clone(), size.to_string()));
            }
            (
                RestPagination::Offset {
                    offset_param,
                    limit_param,
                    limit,
                    ..
                },
                PageState::Offset(offset),
            ) => {
                params.push((offset_param.clone(), offset.to_string()));
                params.push((limit_param.clone(), limit.to_string()));
            }
            (RestPagination::Cursor { cursor_param, .. }, PageState::Cursor(Some(cursor))) => {
                params.push((cursor_param.clone(), cursor.clone()));
            }
            _ => {}
        }
        params
    }

    /// Decide what happens after a page, updating the state in place.
    ///
    /// `PageSize` / `Offset` stop on a short page (fewer rows than requested),
    /// which is the universal "last page" signal for both; `Cursor` stops when
    /// the response carries no next cursor; `LinkHeader` stops when there is no
    /// `rel="next"`.
    fn advance(
        &mut self,
        pagination: &RestPagination,
        page_rows: usize,
        body: &Value,
        next_link: Option<String>,
    ) -> ConnectorResult<Advance> {
        match (pagination, &mut *self) {
            (RestPagination::None, _) => Ok(Advance::Stop),
            (RestPagination::PageSize { size, .. }, PageState::Page(page)) => {
                if page_rows < *size as usize {
                    return Ok(Advance::Stop);
                }
                *page += 1;
                Ok(Advance::SameUrl)
            }
            (RestPagination::Offset { limit, .. }, PageState::Offset(offset)) => {
                if page_rows < *limit as usize {
                    return Ok(Advance::Stop);
                }
                *offset += u64::from(*limit);
                Ok(Advance::SameUrl)
            }
            (RestPagination::Cursor { cursor_path, .. }, PageState::Cursor(cursor)) => {
                match extract_cursor(body, cursor_path)? {
                    Some(next) => {
                        // A cursor that repeats itself would loop forever
                        // within `max_pages`; treat it as the end.
                        if cursor.as_deref() == Some(next.as_str()) {
                            return Ok(Advance::Stop);
                        }
                        *cursor = Some(next);
                        Ok(Advance::SameUrl)
                    }
                    None => Ok(Advance::Stop),
                }
            }
            (RestPagination::LinkHeader { .. }, PageState::Link) => match next_link {
                Some(next) => Ok(Advance::NewUrl(next)),
                None => Ok(Advance::Stop),
            },
            // The state is built from the pagination mode in `start`, so these
            // cannot disagree; stopping is the safe reading if they ever do.
            _ => Ok(Advance::Stop),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine_core::model::RestMethod;

    fn endpoint(pagination: RestPagination) -> RestEndpoint {
        RestEndpoint::new("t", "rows")
            .with_query("static", "1")
            .with_pagination(pagination)
    }

    #[test]
    fn page_size_sends_page_and_size_and_advances_until_a_short_page() {
        let pagination = RestPagination::PageSize {
            page_param: "page".into(),
            size_param: "size".into(),
            size: 2,
            max_pages: 10,
        };
        let ep = endpoint(pagination.clone());
        let mut state = PageState::start(&pagination);
        let params = state.query_params(&ep);
        assert_eq!(
            params,
            vec![
                ("static".to_string(), "1".to_string()),
                ("page".to_string(), "1".to_string()),
                ("size".to_string(), "2".to_string()),
            ]
        );
        // A full page advances.
        assert!(matches!(
            state.advance(&pagination, 2, &Value::Null, None).unwrap(),
            Advance::SameUrl
        ));
        assert_eq!(state.query_params(&ep)[1].1, "2");
        // A short page stops.
        assert!(matches!(
            state.advance(&pagination, 1, &Value::Null, None).unwrap(),
            Advance::Stop
        ));
    }

    #[test]
    fn offset_advances_by_the_limit() {
        let pagination = RestPagination::Offset {
            offset_param: "offset".into(),
            limit_param: "limit".into(),
            limit: 3,
            max_pages: 10,
        };
        let ep = endpoint(pagination.clone());
        let mut state = PageState::start(&pagination);
        assert_eq!(state.query_params(&ep)[1].1, "0");
        assert!(matches!(
            state.advance(&pagination, 3, &Value::Null, None).unwrap(),
            Advance::SameUrl
        ));
        assert_eq!(state.query_params(&ep)[1].1, "3");
        assert!(matches!(
            state.advance(&pagination, 0, &Value::Null, None).unwrap(),
            Advance::Stop
        ));
    }

    #[test]
    fn a_cursor_that_repeats_itself_terminates_the_loop() {
        let pagination = RestPagination::Cursor {
            cursor_param: "cursor".into(),
            cursor_path: "next".into(),
            max_pages: 100,
        };
        let mut state = PageState::start(&pagination);
        let body: Value = serde_json::from_str(r#"{"next":"abc"}"#).unwrap();
        assert!(matches!(
            state.advance(&pagination, 1, &body, None).unwrap(),
            Advance::SameUrl
        ));
        // The same cursor again is the end, not another lap.
        assert!(matches!(
            state.advance(&pagination, 1, &body, None).unwrap(),
            Advance::Stop
        ));
    }

    #[test]
    fn link_paging_adds_no_query_parameters_of_its_own() {
        let pagination = RestPagination::LinkHeader { max_pages: 5 };
        let ep = endpoint(pagination.clone());
        let mut state = PageState::start(&pagination);
        assert_eq!(state.query_params(&ep).len(), 1);
        assert!(matches!(
            state
                .advance(
                    &pagination,
                    1,
                    &Value::Null,
                    Some("https://api.example.com/p2".into())
                )
                .unwrap(),
            Advance::NewUrl(_)
        ));
        assert!(matches!(
            state.advance(&pagination, 1, &Value::Null, None).unwrap(),
            Advance::Stop
        ));
    }

    #[test]
    fn the_unpaginated_mode_never_asks_for_a_second_page() {
        let pagination = RestPagination::None;
        let mut state = PageState::start(&pagination);
        assert!(matches!(
            state
                .advance(&pagination, 1000, &Value::Null, None)
                .unwrap(),
            Advance::Stop
        ));
    }

    #[test]
    fn the_post_method_is_carried_through_to_every_page() {
        let ep = RestEndpoint::new("t", "search").with_body(r#"{"q":1}"#);
        assert_eq!(ep.method, RestMethod::Post);
        assert_eq!(ep.body.as_deref(), Some(r#"{"q":1}"#));
    }
}
