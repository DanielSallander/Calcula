//! Unit tests for the persisted REST source configuration and its validation.

use super::*;
use crate::types::DataType;

/// A minimal valid configuration to mutate in individual cases.
fn config() -> RestSourceConfig {
    RestSourceConfig::new("https://api.example.com/v1")
        .with_endpoint(RestEndpoint::new("orders", "orders"))
}

#[test]
fn a_minimal_config_validates() {
    assert!(config().validate().is_ok());
}

#[test]
fn defaults_are_the_documented_timeout_and_size_budget() {
    let cfg = RestSourceConfig::new("https://api.example.com");
    assert_eq!(cfg.timeout_secs, DEFAULT_REST_TIMEOUT_SECS);
    assert_eq!(cfg.max_response_bytes, DEFAULT_REST_MAX_RESPONSE_BYTES);
    assert_eq!(DEFAULT_REST_TIMEOUT_SECS, 30);
    assert_eq!(DEFAULT_REST_MAX_RESPONSE_BYTES, 32 * 1024 * 1024);
}

#[test]
fn config_round_trips_through_serde_in_camel_case() {
    let cfg = RestSourceConfig::new("https://api.example.com/v1")
        .with_header("Accept", "application/json")
        .with_auth(RestAuthSpec::HeaderSecret {
            header: "X-Api-Key".into(),
            slot: "example_key".into(),
        })
        .with_endpoint(
            RestEndpoint::new("orders", "orders")
                .with_query("region", "eu")
                .with_rows_path("data.items")
                .with_fields(vec![
                    RestField::new("id", "id", DataType::Int64),
                    RestField::new("customer.name", "customer", DataType::String),
                ])
                .with_pagination(RestPagination::PageSize {
                    page_param: "page".into(),
                    size_param: "size".into(),
                    size: 100,
                    max_pages: 20,
                }),
        );

    let json = serde_json::to_string(&cfg).unwrap();
    assert!(json.contains("\"baseUrl\""), "got {json}");
    assert!(json.contains("\"defaultHeaders\""), "got {json}");
    assert!(json.contains("\"maxResponseBytes\""), "got {json}");
    assert!(json.contains("\"rowsPath\""), "got {json}");
    assert!(json.contains("\"dataType\""), "got {json}");
    assert!(json.contains("\"pageParam\""), "got {json}");
    assert!(json.contains("\"maxPages\""), "got {json}");

    let restored: RestSourceConfig = serde_json::from_str(&json).unwrap();
    assert_eq!(cfg, restored);
}

#[test]
fn the_serialized_tag_spellings_are_the_documented_ones() {
    // The host writes these strings by hand in its source dialog and they are
    // quoted verbatim in the integration changelog, so pin them.
    let json = serde_json::to_value(RestAuthSpec::BearerSecret { slot: "t".into() }).unwrap();
    assert_eq!(json["type"], serde_json::json!("bearerSecret"));
    let json = serde_json::to_value(RestAuthSpec::BasicSecret {
        username: "u".into(),
        password_slot: "p".into(),
    })
    .unwrap();
    assert_eq!(json["type"], serde_json::json!("basicSecret"));
    assert_eq!(json["passwordSlot"], serde_json::json!("p"));

    let json = serde_json::to_value(RestPagination::PageSize {
        page_param: "page".into(),
        size_param: "size".into(),
        size: 1,
        max_pages: 1,
    })
    .unwrap();
    assert_eq!(json["mode"], serde_json::json!("pageSize"));
    let json = serde_json::to_value(RestPagination::LinkHeader { max_pages: 1 }).unwrap();
    assert_eq!(json["mode"], serde_json::json!("linkHeader"));

    assert_eq!(
        serde_json::to_value(RestMethod::Get).unwrap(),
        serde_json::json!("get")
    );
    assert_eq!(
        serde_json::to_value(RestField::new("a", "a", DataType::Int64)).unwrap()["dataType"],
        serde_json::json!("Int64")
    );
}

#[test]
fn every_auth_spec_round_trips() {
    for auth in [
        RestAuthSpec::None,
        RestAuthSpec::BearerSecret { slot: "t".into() },
        RestAuthSpec::HeaderSecret {
            header: "X-Key".into(),
            slot: "k".into(),
        },
        RestAuthSpec::QuerySecret {
            param: "api_key".into(),
            slot: "k".into(),
        },
        RestAuthSpec::BasicSecret {
            username: "svc".into(),
            password_slot: "pw".into(),
        },
    ] {
        let json = serde_json::to_string(&auth).unwrap();
        let restored: RestAuthSpec = serde_json::from_str(&json).unwrap();
        assert_eq!(auth, restored, "round trip failed for {json}");
    }
}

#[test]
fn every_pagination_mode_round_trips() {
    for mode in [
        RestPagination::None,
        RestPagination::PageSize {
            page_param: "page".into(),
            size_param: "size".into(),
            size: 50,
            max_pages: 5,
        },
        RestPagination::Offset {
            offset_param: "offset".into(),
            limit_param: "limit".into(),
            limit: 50,
            max_pages: 5,
        },
        RestPagination::Cursor {
            cursor_param: "cursor".into(),
            cursor_path: "meta.next".into(),
            max_pages: 5,
        },
        RestPagination::LinkHeader { max_pages: 5 },
    ] {
        let json = serde_json::to_string(&mode).unwrap();
        let restored: RestPagination = serde_json::from_str(&json).unwrap();
        assert_eq!(mode, restored, "round trip failed for {json}");
    }
}

#[test]
fn the_persisted_config_carries_no_secret_values() {
    // Structural: the only credential-shaped keys a REST config may serialize
    // are *slot names*. A value never appears because no field can hold one.
    let cfg = RestSourceConfig::new("https://api.example.com")
        .with_auth(RestAuthSpec::BasicSecret {
            username: "svc".into(),
            password_slot: "svc_password".into(),
        })
        .with_endpoint(RestEndpoint::new("t", "t"));
    let value: serde_json::Value = serde_json::to_value(&cfg).unwrap();
    let auth = value["auth"].as_object().unwrap();
    assert!(auth.contains_key("passwordSlot"));
    assert!(!auth.contains_key("password"));
    assert_eq!(auth["passwordSlot"], serde_json::json!("svc_password"));
}

#[test]
fn declared_slots_lists_every_secret_the_host_must_supply() {
    assert!(RestAuthSpec::None.declared_slots().is_empty());
    assert_eq!(
        RestAuthSpec::BearerSecret { slot: "t".into() }.declared_slots(),
        vec!["t"]
    );
    assert_eq!(
        RestAuthSpec::BasicSecret {
            username: "u".into(),
            password_slot: "p".into()
        }
        .declared_slots(),
        vec!["p"]
    );
}

#[test]
fn plain_http_is_refused_for_a_public_host() {
    let cfg =
        RestSourceConfig::new("http://api.example.com").with_endpoint(RestEndpoint::new("t", "t"));
    let err = cfg.validate().unwrap_err().to_string();
    assert!(err.contains("plain http"), "got {err}");
}

#[test]
fn plain_http_is_allowed_for_loopback() {
    for base in [
        "http://localhost:8080",
        "http://127.0.0.1:9",
        "http://127.5.5.5/api",
        "http://[::1]:3000/v1",
    ] {
        let cfg = RestSourceConfig::new(base).with_endpoint(RestEndpoint::new("t", "t"));
        assert!(cfg.validate().is_ok(), "{base} should be allowed");
    }
}

#[test]
fn loopback_detection_rejects_lookalikes() {
    assert!(is_loopback_host("localhost"));
    assert!(is_loopback_host("127.0.0.1"));
    assert!(is_loopback_host("[::1]"));
    assert!(!is_loopback_host("localhost.evil.com"));
    assert!(!is_loopback_host("127.0.0.1.evil.com"));
    assert!(!is_loopback_host("0.0.0.0"));
    assert!(!is_loopback_host("192.168.1.1"));
    assert!(!is_loopback_host(""));
}

#[test]
fn a_non_http_scheme_is_refused() {
    for base in ["file:///etc/passwd", "ftp://example.com", "gopher://x/"] {
        let cfg = RestSourceConfig::new(base).with_endpoint(RestEndpoint::new("t", "t"));
        assert!(cfg.validate().is_err(), "{base} should be refused");
    }
}

#[test]
fn a_relative_base_url_is_refused() {
    let cfg =
        RestSourceConfig::new("api.example.com/v1").with_endpoint(RestEndpoint::new("t", "t"));
    assert!(cfg.validate().is_err());
}

#[test]
fn credentials_in_the_url_are_refused() {
    let cfg = RestSourceConfig::new("https://user:pass@api.example.com")
        .with_endpoint(RestEndpoint::new("t", "t"));
    let err = cfg.validate().unwrap_err().to_string();
    assert!(err.contains("userinfo"), "got {err}");
}

#[test]
fn an_endpoint_path_may_not_carry_a_scheme_or_host() {
    for path in [
        "https://evil.example.com/steal",
        "//evil.example.com/steal",
        "javascript:alert(1)",
        "../../admin",
        "a\\b",
    ] {
        let cfg = RestSourceConfig::new("https://api.example.com")
            .with_endpoint(RestEndpoint::new("t", path));
        assert!(cfg.validate().is_err(), "path '{path}' should be refused");
    }
}

#[test]
fn an_ordinary_relative_path_is_accepted() {
    for path in ["", "orders", "/v2/orders", "orders/2026/open"] {
        let cfg = RestSourceConfig::new("https://api.example.com/")
            .with_endpoint(RestEndpoint::new("t", path));
        assert!(cfg.validate().is_ok(), "path '{path}' should be accepted");
    }
}

#[test]
fn header_and_query_injection_is_refused() {
    let cfg = RestSourceConfig::new("https://api.example.com")
        .with_header("X-Bad\r\nInjected", "v")
        .with_endpoint(RestEndpoint::new("t", "t"));
    assert!(cfg.validate().is_err());

    let cfg = RestSourceConfig::new("https://api.example.com")
        .with_header("X-Ok", "value\r\nX-Injected: 1")
        .with_endpoint(RestEndpoint::new("t", "t"));
    assert!(cfg.validate().is_err());

    let cfg = RestSourceConfig::new("https://api.example.com")
        .with_endpoint(RestEndpoint::new("t", "t").with_query("a\r\nb", "v"));
    assert!(cfg.validate().is_err());
}

#[test]
fn endpoint_names_must_be_present_and_unique() {
    let cfg = RestSourceConfig::new("https://api.example.com")
        .with_endpoint(RestEndpoint::new("  ", "t"));
    assert!(cfg.validate().is_err());

    let cfg = RestSourceConfig::new("https://api.example.com")
        .with_endpoint(RestEndpoint::new("orders", "a"))
        .with_endpoint(RestEndpoint::new("orders", "b"));
    let err = cfg.validate().unwrap_err().to_string();
    assert!(err.contains("duplicate endpoint"), "got {err}");
}

#[test]
fn a_config_with_no_endpoints_is_refused() {
    let cfg = RestSourceConfig::new("https://api.example.com");
    assert!(cfg.validate().is_err());
}

#[test]
fn duplicate_field_names_are_refused() {
    let cfg = RestSourceConfig::new("https://api.example.com").with_endpoint(
        RestEndpoint::new("t", "t").with_fields(vec![
            RestField::new("a", "x", DataType::String),
            RestField::new("b", "x", DataType::String),
        ]),
    );
    assert!(cfg.validate().is_err());
}

#[test]
fn a_get_with_a_body_is_refused_and_a_post_body_must_be_json() {
    let mut endpoint = RestEndpoint::new("t", "t");
    endpoint.body = Some("{}".into());
    let cfg = RestSourceConfig::new("https://api.example.com").with_endpoint(endpoint);
    let err = cfg.validate().unwrap_err().to_string();
    assert!(err.contains("GET"), "got {err}");

    let cfg = RestSourceConfig::new("https://api.example.com")
        .with_endpoint(RestEndpoint::new("t", "t").with_body("not json"));
    let err = cfg.validate().unwrap_err().to_string();
    assert!(err.contains("not valid JSON"), "got {err}");

    let cfg = RestSourceConfig::new("https://api.example.com")
        .with_endpoint(RestEndpoint::new("t", "t").with_body(r#"{"q":"x"}"#));
    assert!(cfg.validate().is_ok());
}

#[test]
fn max_pages_must_be_at_least_one_and_within_the_ceiling() {
    let make = |max_pages| {
        RestSourceConfig::new("https://api.example.com").with_endpoint(
            RestEndpoint::new("t", "t").with_pagination(RestPagination::LinkHeader { max_pages }),
        )
    };
    assert!(make(0).validate().is_err());
    assert!(make(1).validate().is_ok());
    assert!(make(MAX_REST_PAGE_LIMIT).validate().is_ok());
    assert!(make(MAX_REST_PAGE_LIMIT + 1).validate().is_err());
}

#[test]
fn max_pages_reports_one_for_the_unpaginated_mode() {
    assert_eq!(RestPagination::None.max_pages(), 1);
    assert_eq!(RestPagination::LinkHeader { max_pages: 7 }.max_pages(), 7);
}

#[test]
fn timeout_and_size_budgets_are_bounded() {
    let cfg = config().with_timeout_secs(0);
    assert!(cfg.validate().is_err());
    let cfg = config().with_timeout_secs(MAX_REST_TIMEOUT_SECS + 1);
    assert!(cfg.validate().is_err());
    let cfg = config().with_max_response_bytes(0);
    assert!(cfg.validate().is_err());
    let cfg = config().with_max_response_bytes(MAX_REST_RESPONSE_BYTES + 1);
    assert!(cfg.validate().is_err());
    assert!(config().with_timeout_secs(1).validate().is_ok());
}

#[test]
fn an_empty_auth_slot_name_is_refused() {
    let cfg = config().with_auth(RestAuthSpec::BearerSecret { slot: "".into() });
    assert!(cfg.validate().is_err());
}

#[test]
fn a_link_header_next_url_is_held_to_the_same_rule_as_the_base_url() {
    // The connector re-uses this on every `rel="next"` it follows.
    assert!(validate_absolute_url("https://api.example.com/p2", "next").is_ok());
    assert!(validate_absolute_url("http://api.example.com/p2", "next").is_err());
    assert!(validate_absolute_url("http://localhost:1/p2", "next").is_ok());
    assert!(validate_absolute_url("/p2", "next").is_err());
}

#[test]
fn endpoint_lookup_finds_a_declared_endpoint() {
    let cfg = config();
    assert!(cfg.endpoint("orders").is_some());
    assert!(cfg.endpoint("missing").is_none());
}

#[test]
fn rest_method_spells_itself_for_the_wire() {
    assert_eq!(RestMethod::Get.as_str(), "GET");
    assert_eq!(RestMethod::Post.as_str(), "POST");
    assert_eq!(RestMethod::default(), RestMethod::Get);
}
