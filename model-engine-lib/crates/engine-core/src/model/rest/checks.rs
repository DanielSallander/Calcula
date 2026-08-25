//! The low-level string and URL checks a REST configuration is held to.
//!
//! Separated from [`super::validate`] so the *rules about a URL or an HTTP
//! field* live apart from the *rules about a configuration*. Nothing here
//! performs I/O.

use crate::error::{EngineError, EngineResult};

/// Build the single error type this module reports.
pub(super) fn invalid(reason: impl Into<String>) -> EngineError {
    EngineError::InvalidData(format!("REST source: {}", reason.into()))
}

/// Returns `true` if `host` is a loopback address literal or `localhost`.
///
/// Loopback is the one place plain `http://` is permitted: a test server or a
/// local development gateway never leaves the machine, so there is no network
/// path to eavesdrop on. Anything else — including `0.0.0.0`, a private LAN
/// address, or a name that merely *resolves* to loopback — must use TLS.
pub fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_end_matches('.');
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    if host == "[::1]" || host == "::1" {
        return true;
    }
    // 127.0.0.0/8
    let mut parts = host.split('.');
    let (Some(a), Some(b), Some(c), Some(d), None) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) else {
        return false;
    };
    a == "127"
        && [b, c, d]
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|ch| ch.is_ascii_digit()))
}

/// Split an absolute URL into its lowercase scheme and its authority (the part
/// between `://` and the first `/`, `?`, or `#`).
pub(super) fn split_scheme_authority(url: &str) -> Option<(String, &str)> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
    {
        return None;
    }
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    Some((scheme.to_ascii_lowercase(), &rest[..authority_end]))
}

/// Strip a `host:port` authority down to its host (handling `[::1]:8080`).
pub(super) fn host_of(authority: &str) -> &str {
    if let Some(end) = authority.find(']') {
        // IPv6 literal: `[::1]` or `[::1]:8080`.
        return &authority[..=end];
    }
    match authority.split_once(':') {
        Some((host, _port)) => host,
        None => authority,
    }
}

/// Reject any ASCII control character or space, which cannot appear literally in
/// a request line or header field without splitting the message.
pub(super) fn reject_control_chars(what: &str, value: &str) -> EngineResult<()> {
    if value
        .chars()
        .any(|c| c.is_control() || c == ' ' || c == '\u{7f}')
    {
        return Err(invalid(format!(
            "{what} must not contain control characters or spaces"
        )));
    }
    Ok(())
}

/// Validate an absolute URL against the source's transport posture: an
/// `https://` scheme (or `http://` to a loopback host), a non-empty authority,
/// no `user:password@` userinfo, and no control characters.
///
/// Public because the connector re-applies it to every `Link: rel="next"` URL
/// before following it — a compromised API must not be able to walk the
/// connector onto another host, or downgrade it to plaintext. One rule, one
/// implementation.
pub fn validate_absolute_url(url: &str, what: &str) -> EngineResult<()> {
    if url.trim().is_empty() {
        return Err(invalid(format!("{what} must not be empty")));
    }
    if url != url.trim() {
        return Err(invalid(format!(
            "{what} must not have leading or trailing whitespace"
        )));
    }
    reject_control_chars(what, url)?;

    let Some((scheme, authority)) = split_scheme_authority(url) else {
        return Err(invalid(format!(
            "{what} must be an absolute URL beginning with 'https://' (got '{url}')"
        )));
    };
    if authority.is_empty() {
        return Err(invalid(format!("{what} has no host (got '{url}')")));
    }
    if authority.contains('@') {
        return Err(invalid(format!(
            "{what} must not embed credentials in its userinfo — declare a secret slot instead"
        )));
    }
    let host = host_of(authority);
    match scheme.as_str() {
        "https" => Ok(()),
        "http" if is_loopback_host(host) => Ok(()),
        "http" => Err(invalid(format!(
            "{what} uses plain http:// with a non-loopback host '{host}'; \
             use https:// (plain http is permitted only for loopback)"
        ))),
        other => Err(invalid(format!(
            "{what} uses unsupported scheme '{other}://'; only https:// (or http:// to loopback) is allowed"
        ))),
    }
}

/// Validate an endpoint path: relative only, no scheme, no host, no traversal.
///
/// A path that could carry a scheme or an authority would let one endpoint
/// silently target a server the model does not declare — the whole point of
/// pinning `base_url` is that the reader of a model file can see where its data
/// comes from.
pub(super) fn validate_path(endpoint: &str, path: &str) -> EngineResult<()> {
    let what = format!("endpoint '{endpoint}' path");
    reject_control_chars(&what, path)?;
    if path.contains("://") {
        return Err(invalid(format!(
            "{what} must not contain a scheme — it is joined onto the source's base URL"
        )));
    }
    if path.starts_with("//") {
        return Err(invalid(format!(
            "{what} must not start with '//' (a protocol-relative host)"
        )));
    }
    // A ':' before the first '/' would be read as a scheme by a URL parser.
    let head = path.split('/').next().unwrap_or("");
    if head.contains(':') {
        return Err(invalid(format!(
            "{what} must not contain ':' before its first '/' (that reads as a scheme)"
        )));
    }
    if path.split(['/', '?']).any(|segment| segment == "..") {
        return Err(invalid(format!("{what} must not contain a '..' segment")));
    }
    if path.contains('\\') {
        return Err(invalid(format!("{what} must not contain a backslash")));
    }
    Ok(())
}

/// Validate an HTTP field name (a RFC 9110 token).
pub(super) fn validate_header_name(what: &str, name: &str) -> EngineResult<()> {
    if name.is_empty() {
        return Err(invalid(format!("{what} must not be empty")));
    }
    const EXTRA: &[char] = &[
        '!', '#', '$', '%', '&', '\'', '*', '+', '-', '.', '^', '_', '`', '|', '~',
    ];
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || EXTRA.contains(&c))
    {
        return Err(invalid(format!(
            "{what} '{name}' is not a valid HTTP header name"
        )));
    }
    Ok(())
}
