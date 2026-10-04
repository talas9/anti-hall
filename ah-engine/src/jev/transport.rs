//! The HTTP layer: one POST (or GET) under one deadline, with the rules that keep a key where it belongs.
//!
//! [`Transport`] is the seam: [`HttpTransport`] is the real client (`ureq` over `rustls`, no OpenSSL), and tests use a
//! scripted fake or a loopback server. What every transport must do, because the request carries the user's key:
//!
//! * never follow a redirect (a 3xx is a network error, as Node's `redirect: 'error'` makes it);
//! * never use a proxy from the environment;
//! * apply ONE deadline covering connect, request, headers and body.
//!
//! [`post_systemone`] turns what a transport returns into the classified result the rest of the client works with
//! (Node: `postSystemone`).
use super::breaker::Clock;
use super::error::Reason;
use super::settings::JevSettings;
use crate::defaults;
use serde_json::Value;
use std::time::Duration;

/// How a body read failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyError {
    /// The deadline passed while reading.
    Timeout,
    /// Anything else (connection reset, over the size limit, not UTF-8).
    Other,
}

/// What a vendor answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawResponse {
    /// The HTTP status.
    pub status: u16,
    /// The body, or why it could not be read.
    pub body: Result<String, BodyError>,
}

/// Why no answer arrived at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetError {
    /// The deadline passed.
    Timeout,
    /// The connection failed, or the server redirected (never followed).
    Network,
}

/// One HTTP request.
#[derive(Debug, Clone)]
pub struct Request<'a> {
    /// POST with a JSON body, or GET without.
    pub body: Option<&'a str>,
    /// The URL.
    pub url: &'a str,
    /// The bearer token, sent only in the Authorization header.
    pub bearer: &'a str,
    /// The one deadline for the whole exchange.
    pub timeout: Duration,
}

/// Sends a request and returns what came back. Implementations must follow the rules in the module docs.
pub trait Transport: Send + Sync {
    /// Send `req`.
    fn send(&self, req: &Request<'_>) -> Result<RawResponse, NetError>;
}

/// The real transport: a shared `ureq` agent (its connection pool is the "warm connection" of D36).
pub struct HttpTransport {
    agent: ureq::Agent,
}

impl HttpTransport {
    /// Build the agent: no redirects, no proxy, statuses returned rather than raised.
    pub fn new() -> HttpTransport {
        let config = ureq::Agent::config_builder().http_status_as_error(false).max_redirects(0).max_redirects_will_error(false).proxy(None).build();
        HttpTransport { agent: ureq::Agent::new_with_config(config) }
    }
}

impl Default for HttpTransport {
    fn default() -> Self {
        HttpTransport::new()
    }
}

fn classify(e: &ureq::Error) -> NetError {
    match e {
        ureq::Error::Timeout(_) => NetError::Timeout,
        _ => NetError::Network,
    }
}

impl Transport for HttpTransport {
    fn send(&self, req: &Request<'_>) -> Result<RawResponse, NetError> {
        let header = format!("Bearer {}", req.bearer);
        let result = match req.body {
            Some(body) => self
                .agent
                .post(req.url)
                .config()
                .timeout_global(Some(req.timeout))
                .build()
                .header("Authorization", &header)
                .header("Content-Type", "application/json")
                .send(body),
            None => self.agent.get(req.url).config().timeout_global(Some(req.timeout)).build().header("Authorization", &header).call(),
        };
        let mut resp = result.map_err(|e| classify(&e))?;
        let status = resp.status().as_u16();
        if (300..400).contains(&status) {
            return Err(NetError::Network); // a redirect is never followed: the key and the text stay at the vendor
        }
        let limit = defaults::num("jev.max_response_bytes");
        let body = resp.body_mut().with_config().limit(limit).read_to_string().map_err(|e| {
            if matches!(e, ureq::Error::Timeout(_)) {
                BodyError::Timeout
            } else {
                BodyError::Other
            }
        });
        Ok(RawResponse { status, body })
    }
}

/// The classified result of one attempt (Node: the object `postSystemone` returns).
#[derive(Debug, Clone, PartialEq)]
pub enum Posted {
    /// A 2xx whose body parsed as JSON.
    Json(Value, u64),
    /// A failure, with the elapsed milliseconds and whether an error body named an exhausted balance.
    Failed {
        /// Why.
        reason: Reason,
        /// Elapsed milliseconds.
        ms: u64,
        /// True when a 400 or 403 body explicitly named insufficient balance, credits or quota.
        balance: bool,
    },
}

/// The words that mark an out-of-balance error body: the configured alternation, ASCII case-insensitive.
fn balance_words() -> Vec<&'static str> {
    defaults::text("jev.balance_pattern").split('|').collect()
}

/// True when `body` (its first `jev.balance_body_bytes` characters) names an exhausted balance. The body is only
/// classified, never logged.
pub fn names_balance(body: &str) -> bool {
    let head: String = body.chars().take(defaults::num("jev.balance_body_bytes") as usize).collect::<String>().to_ascii_lowercase();
    balance_words().iter().any(|w| head.contains(&w.to_ascii_lowercase()))
}

/// Run one request through `transport` and classify the outcome (Node: `postSystemone`). Never panics, never returns
/// the key or any part of an error body.
pub fn post_systemone(transport: &dyn Transport, clock: &dyn Clock, url: &str, key: &str, body: &str, timeout: Duration) -> Posted {
    let start = clock.now_ms();
    let elapsed = || clock.now_ms().saturating_sub(start);
    let fail = |reason: Reason, balance: bool, ms: u64| Posted::Failed { reason, ms, balance };
    let resp = match transport.send(&Request { body: Some(body), url, bearer: key, timeout }) {
        Ok(r) => r,
        Err(NetError::Timeout) => return fail(Reason::Timeout, false, elapsed()),
        Err(NetError::Network) => return fail(Reason::NetworkError, false, elapsed()),
    };
    if !(200..300).contains(&resp.status) {
        let balance = matches!(resp.status, 400 | 403) && resp.body.as_ref().is_ok_and(|b| names_balance(b));
        return fail(Reason::Http(resp.status), balance, elapsed());
    }
    let text = match resp.body {
        Ok(t) => t,
        Err(BodyError::Timeout) => return fail(Reason::Timeout, false, elapsed()),
        Err(BodyError::Other) => return fail(Reason::ParseError, false, elapsed()),
    };
    let ms = elapsed();
    match serde_json::from_str::<Value>(&text) {
        Ok(v) => Posted::Json(v, ms),
        Err(_) => fail(Reason::ParseError, false, ms),
    }
}

/// The endpoint for `vendor`: the built-in one, unless a loopback test override applies. The per-vendor override always
/// applies; the generic one applies to the primary role only, so a primary and its fallback never share one mock.
pub fn endpoint_for(settings: &JevSettings, vendor: super::settings::Vendor, primary: bool) -> String {
    use super::settings::Vendor;
    let idx = match vendor {
        Vendor::Vercel => 0,
        Vendor::Typesafe => 1,
    };
    if let Some(per) = &settings.endpoint_overrides[idx] {
        return per.clone();
    }
    if primary {
        if let Some(generic) = &settings.endpoint_override {
            return generic.clone();
        }
    }
    match vendor {
        Vendor::Vercel => defaults::text("jev.endpoint_vercel").to_string(),
        Vendor::Typesafe => defaults::text("jev.endpoint_typesafe").to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jev::breaker::ManualClock;
    use crate::jev::settings::{Env, Sources, Vendor};
    use crate::jev::testkit::{ok, Fake};

    fn post(script: Vec<Result<RawResponse, NetError>>) -> Posted {
        let f = Fake::new(script);
        post_systemone(&f, &ManualClock::default(), "http://127.0.0.1:1/x", "k", "{}", Duration::from_millis(100))
    }

    #[test]
    fn a_2xx_json_body_is_returned_and_everything_else_is_classified() {
        assert!(matches!(post(vec![ok(200, r#"{"a":1}"#)]), Posted::Json(_, _)));
        assert!(matches!(post(vec![ok(200, "not json")]), Posted::Failed { reason: Reason::ParseError, .. }));
        assert!(matches!(post(vec![Err(NetError::Timeout)]), Posted::Failed { reason: Reason::Timeout, .. }));
        assert!(matches!(post(vec![Err(NetError::Network)]), Posted::Failed { reason: Reason::NetworkError, .. }));
        assert!(matches!(post(vec![Ok(RawResponse { status: 200, body: Err(BodyError::Timeout) })]), Posted::Failed { reason: Reason::Timeout, .. }));
        assert!(matches!(post(vec![Ok(RawResponse { status: 200, body: Err(BodyError::Other) })]), Posted::Failed { reason: Reason::ParseError, .. }));
        assert!(matches!(post(vec![ok(500, "boom")]), Posted::Failed { reason: Reason::Http(500), balance: false, .. }));
    }

    #[test]
    fn only_a_400_or_403_naming_the_balance_is_an_out_of_balance_answer() {
        assert!(matches!(post(vec![ok(402, "Insufficient credits")]), Posted::Failed { balance: false, .. }), "402 is eligible on its own");
        assert!(matches!(post(vec![ok(400, "Insufficient credits")]), Posted::Failed { balance: true, .. }));
        assert!(matches!(post(vec![ok(403, "your QUOTA is used up")]), Posted::Failed { balance: true, .. }));
        assert!(matches!(post(vec![ok(403, "forbidden")]), Posted::Failed { balance: false, .. }));
        assert!(matches!(post(vec![ok(401, "billing")]), Posted::Failed { balance: false, .. }));
    }

    #[test]
    fn endpoints_are_the_built_in_ones_unless_a_loopback_override_applies() {
        let settings = |env: &[(&str, &str)]| {
            JevSettings::resolve(std::path::Path::new("/h"), Sources { env: Env::from_pairs(env.iter().copied()), ..Default::default() })
        };
        let plain = settings(&[]);
        assert_eq!(endpoint_for(&plain, Vendor::Vercel, true), "https://ai-gateway.vercel.sh/typesafe/v1/systemone");
        assert_eq!(endpoint_for(&plain, Vendor::Typesafe, false), "https://api.typesafe.ai/v1/systemone");
        let o = settings(&[("ANTIHALL_JEV_TEST_ENDPOINT", "http://127.0.0.1:9/p"), ("ANTIHALL_JEV_TEST_ENDPOINT_TYPESAFE", "http://localhost:9/t")]);
        assert_eq!(endpoint_for(&o, Vendor::Vercel, true), "http://127.0.0.1:9/p");
        assert_eq!(
            endpoint_for(&o, Vendor::Vercel, false),
            "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
            "the generic override is for the primary only"
        );
        assert_eq!(endpoint_for(&o, Vendor::Typesafe, false), "http://localhost:9/t");
    }
}
