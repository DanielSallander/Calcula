//! Offline validation of a [`RestSourceConfig`].
//!
//! Every rule here is a precondition the connector relies on at request time,
//! checked once when the model is built or loaded rather than discovered
//! mid-fetch. The low-level URL and HTTP-field checks live in
//! [`super::checks`]; this file is the configuration-level rules. Nothing in
//! either performs I/O.

use crate::error::EngineResult;

use super::checks::{
    invalid, reject_control_chars, validate_absolute_url, validate_header_name, validate_path,
};
use super::{
    RestAuthSpec, RestEndpoint, RestMethod, RestPagination, RestSourceConfig, MAX_REST_PAGE_LIMIT,
    MAX_REST_RESPONSE_BYTES, MAX_REST_TIMEOUT_SECS,
};

/// Validate a non-empty name/value pair used in a query string.
fn validate_query_pair(endpoint: &str, name: &str, value: &str) -> EngineResult<()> {
    if name.is_empty() {
        return Err(invalid(format!(
            "endpoint '{endpoint}' has a query parameter with an empty name"
        )));
    }
    reject_control_chars(
        &format!("endpoint '{endpoint}' query parameter '{name}'"),
        name,
    )?;
    reject_control_chars(
        &format!("endpoint '{endpoint}' query value for '{name}'"),
        value,
    )?;
    Ok(())
}

/// Validate a pagination mode's parameter names and page ceiling.
fn validate_pagination(endpoint: &str, pagination: &RestPagination) -> EngineResult<()> {
    let ceiling = |max_pages: u32| -> EngineResult<()> {
        if max_pages < 1 {
            return Err(invalid(format!(
                "endpoint '{endpoint}' pagination max_pages must be at least 1"
            )));
        }
        if max_pages > MAX_REST_PAGE_LIMIT {
            return Err(invalid(format!(
                "endpoint '{endpoint}' pagination max_pages {max_pages} exceeds the limit of {MAX_REST_PAGE_LIMIT}"
            )));
        }
        Ok(())
    };
    let param = |what: &str, value: &str| -> EngineResult<()> {
        if value.is_empty() {
            return Err(invalid(format!(
                "endpoint '{endpoint}' pagination {what} must not be empty"
            )));
        }
        reject_control_chars(&format!("endpoint '{endpoint}' pagination {what}"), value)
    };

    match pagination {
        RestPagination::None => Ok(()),
        RestPagination::PageSize {
            page_param,
            size_param,
            size,
            max_pages,
        } => {
            ceiling(*max_pages)?;
            param("page_param", page_param)?;
            param("size_param", size_param)?;
            if *size < 1 {
                return Err(invalid(format!(
                    "endpoint '{endpoint}' pagination size must be at least 1"
                )));
            }
            Ok(())
        }
        RestPagination::Offset {
            offset_param,
            limit_param,
            limit,
            max_pages,
        } => {
            ceiling(*max_pages)?;
            param("offset_param", offset_param)?;
            param("limit_param", limit_param)?;
            if *limit < 1 {
                return Err(invalid(format!(
                    "endpoint '{endpoint}' pagination limit must be at least 1"
                )));
            }
            Ok(())
        }
        RestPagination::Cursor {
            cursor_param,
            cursor_path,
            max_pages,
        } => {
            ceiling(*max_pages)?;
            param("cursor_param", cursor_param)?;
            param("cursor_path", cursor_path)
        }
        RestPagination::LinkHeader { max_pages } => ceiling(*max_pages),
    }
}

/// Validate one endpoint in full.
fn validate_endpoint(endpoint: &RestEndpoint) -> EngineResult<()> {
    let name = endpoint.name.as_str();
    if name.trim().is_empty() {
        return Err(invalid("an endpoint has an empty name"));
    }
    if name != name.trim() {
        return Err(invalid(format!(
            "endpoint name '{name}' must not have leading or trailing whitespace"
        )));
    }
    validate_path(name, &endpoint.path)?;

    for (param, value) in &endpoint.query {
        validate_query_pair(name, param, value)?;
    }

    match (&endpoint.method, &endpoint.body) {
        (RestMethod::Get, Some(_)) => {
            return Err(invalid(format!(
                "endpoint '{name}' is a GET but declares a request body; use POST"
            )));
        }
        (RestMethod::Post, Some(body)) => {
            serde_json::from_str::<serde_json::Value>(body)
                .map_err(|e| invalid(format!("endpoint '{name}' body is not valid JSON: {e}")))?;
        }
        _ => {}
    }

    reject_control_chars(&format!("endpoint '{name}' rows_path"), &endpoint.rows_path)?;

    let mut seen: Vec<&str> = Vec::with_capacity(endpoint.fields.len());
    for field in &endpoint.fields {
        if field.name.trim().is_empty() {
            return Err(invalid(format!(
                "endpoint '{name}' declares a field with an empty name"
            )));
        }
        if field.path.trim().is_empty() {
            return Err(invalid(format!(
                "endpoint '{name}' field '{}' has an empty path",
                field.name
            )));
        }
        if seen.contains(&field.name.as_str()) {
            return Err(invalid(format!(
                "endpoint '{name}' declares duplicate field '{}'",
                field.name
            )));
        }
        seen.push(field.name.as_str());
    }

    validate_pagination(name, &endpoint.pagination)
}

/// Validate the authentication spec's slot / header / parameter names.
fn validate_auth(auth: &RestAuthSpec) -> EngineResult<()> {
    let slot = |value: &str| -> EngineResult<()> {
        if value.trim().is_empty() {
            return Err(invalid("auth secret slot name must not be empty"));
        }
        reject_control_chars("auth secret slot name", value)
    };
    match auth {
        RestAuthSpec::None => Ok(()),
        RestAuthSpec::BearerSecret { slot: s } => slot(s),
        RestAuthSpec::HeaderSecret { header, slot: s } => {
            validate_header_name("auth header name", header)?;
            slot(s)
        }
        RestAuthSpec::QuerySecret { param, slot: s } => {
            if param.trim().is_empty() {
                return Err(invalid("auth query parameter name must not be empty"));
            }
            reject_control_chars("auth query parameter name", param)?;
            slot(s)
        }
        RestAuthSpec::BasicSecret {
            username,
            password_slot,
        } => {
            reject_control_chars("auth basic username", username)?;
            slot(password_slot)
        }
    }
}

/// Validate a whole [`RestSourceConfig`]. See [`RestSourceConfig::validate`].
pub(super) fn validate_config(config: &RestSourceConfig) -> EngineResult<()> {
    validate_absolute_url(&config.base_url, "base_url")?;

    for header in &config.default_headers {
        validate_header_name("default header name", &header.name)?;
        reject_control_chars(
            &format!("default header '{}' value", header.name),
            &header.value,
        )?;
    }

    validate_auth(&config.auth)?;

    if config.endpoints.is_empty() {
        return Err(invalid("at least one endpoint must be declared"));
    }
    let mut seen: Vec<&str> = Vec::with_capacity(config.endpoints.len());
    for endpoint in &config.endpoints {
        validate_endpoint(endpoint)?;
        if seen.contains(&endpoint.name.as_str()) {
            return Err(invalid(format!(
                "duplicate endpoint name '{}'",
                endpoint.name
            )));
        }
        seen.push(endpoint.name.as_str());
    }

    if config.timeout_secs < 1 || config.timeout_secs > MAX_REST_TIMEOUT_SECS {
        return Err(invalid(format!(
            "timeout_secs must be between 1 and {MAX_REST_TIMEOUT_SECS} (got {})",
            config.timeout_secs
        )));
    }
    if config.max_response_bytes < 1 || config.max_response_bytes > MAX_REST_RESPONSE_BYTES {
        return Err(invalid(format!(
            "max_response_bytes must be between 1 and {MAX_REST_RESPONSE_BYTES} (got {})",
            config.max_response_bytes
        )));
    }
    Ok(())
}
