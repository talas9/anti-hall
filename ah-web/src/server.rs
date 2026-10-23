//! The HTTP side: loopback only, a Host check against DNS rebinding, a session cookie minted from the one-time token in the
//! printed address, the page, its files and the event stream.
use crate::agents;
use crate::app::App;
use ah_web_proto::{Boot, SNAPSHOT_EVENT};
use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use std::convert::Infallible;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::WatchStream;

type Shared = Arc<App>;

/// The routes.
pub fn router(app: Shared) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/static/{*path}", get(static_file))
        .route("/pkg/{*path}", get(pkg_file))
        .route("/api/stream", get(stream))
        .layer(middleware::from_fn_with_state(app.clone(), guard))
        .with_state(app)
}

/// Constant-time equality for the token.
fn ct_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn cookie_ok(app: &App, headers: &HeaderMap) -> bool {
    let name = app.settings().cookie_name.clone();
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .any(|(k, v)| k == name && ct_eq(v, &app.token))
}

/// Every request: note activity, refuse a Host header that is not this server's own loopback address, add the security headers.
async fn guard(State(app): State<Shared>, req: Request, next: Next) -> Response {
    app.touch();
    let s = app.settings();
    let host_ok = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).is_some_and(|h| {
        let (name, port) = h.rsplit_once(':').unwrap_or((h, ""));
        port == app.port.to_string() && (name == s.bind_host || name == "localhost")
    });
    if !host_ok {
        return StatusCode::MISDIRECTED_REQUEST.into_response();
    }
    let mut resp = next.run(req).await;
    if let Ok(v) = HeaderValue::from_str(&s.csp) {
        resp.headers_mut().insert(header::CONTENT_SECURITY_POLICY, v);
    }
    resp.headers_mut().insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp.headers_mut().insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    resp
}

fn refuse(app: &App) -> Response {
    (StatusCode::UNAUTHORIZED, app.settings().msg_unauthorized.clone()).into_response()
}

#[derive(Deserialize)]
struct TokenQuery {
    t: Option<String>,
}

/// `/`: with the token in the address, set the session cookie and go to the clean address; with the cookie, the page.
async fn index(State(app): State<Shared>, Query(q): Query<TokenQuery>, headers: HeaderMap) -> Response {
    let s = app.settings();
    if let Some(t) = q.t.as_deref()
        && ct_eq(t, &app.token)
    {
        let cookie = format!("{}={}; HttpOnly; SameSite=Strict; Path=/", s.cookie_name, app.token);
        let mut r = Redirect::to("/").into_response();
        if let Ok(v) = HeaderValue::from_str(&cookie) {
            r.headers_mut().insert(header::SET_COOKIE, v);
        }
        return r;
    }
    if !cookie_ok(&app, &headers) {
        return refuse(&app);
    }
    let path = app.root.join(&s.static_dir).join(&s.index_file);
    let Ok(html) = tokio::fs::read_to_string(&path).await else {
        return (StatusCode::NOT_FOUND, s.msg_not_found.clone()).into_response();
    };
    let boot = Boot {
        ui: s.ui.clone(),
        heartbeat_warn_s: s.heartbeat_warn_s,
        heartbeat_stale_s: s.heartbeat_stale_s,
        kind_order: s.kind_order.clone(),
    };
    // the JSON sits inside a <script> element: keep a "</" in a text from closing it
    let json = serde_json::to_string(&boot).unwrap_or_default().replace("</", "<\\/");
    let mut r = html.replace(&s.boot_marker, &json).into_response();
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    r
}

async fn serve_from(app: &App, headers: &HeaderMap, dir: &str, rel: &str) -> Response {
    if !cookie_ok(app, headers) {
        return refuse(app);
    }
    let s = app.settings();
    // plain relative names only: no "..", no absolute path, no hidden file
    if rel.split('/').any(|p| p.is_empty() || p == ".." || p.starts_with('.')) {
        return (StatusCode::NOT_FOUND, s.msg_not_found.clone()).into_response();
    }
    let ext = rel.rsplit('.').next().unwrap_or_default();
    let Some(mime) = s.mime.get(ext) else {
        return (StatusCode::NOT_FOUND, s.msg_not_found.clone()).into_response();
    };
    match tokio::fs::read(app.root.join(dir).join(rel)).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, mime.clone())], bytes).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, s.msg_not_found.clone()).into_response(),
    }
}

async fn static_file(State(app): State<Shared>, headers: HeaderMap, Path(p): Path<String>) -> Response {
    let dir = app.settings().static_dir.clone();
    serve_from(&app, &headers, &dir, &p).await
}

async fn pkg_file(State(app): State<Shared>, headers: HeaderMap, Path(p): Path<String>) -> Response {
    let dir = app.settings().pkg_dir.clone();
    serve_from(&app, &headers, &dir, &p).await
}

/// Counts an open stream; the poller stops when the last one is gone.
struct StreamGuard(Shared);

impl Drop for StreamGuard {
    fn drop(&mut self) {
        self.0.streams.fetch_sub(1, Ordering::SeqCst);
        self.0.touch();
    }
}

/// `/api/stream`: the current snapshot at once, then every change.
async fn stream(State(app): State<Shared>, headers: HeaderMap) -> Response {
    if !cookie_ok(&app, &headers) {
        return refuse(&app);
    }
    let s = app.settings();
    if app.streams.fetch_add(1, Ordering::SeqCst) >= s.max_streams {
        app.streams.fetch_sub(1, Ordering::SeqCst);
        return (StatusCode::SERVICE_UNAVAILABLE, s.msg_busy.clone()).into_response();
    }
    let guard = StreamGuard(app.clone());
    if app.polling.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
        tokio::spawn(agents::poll(app.clone()));
    }
    let events = WatchStream::new(app.tx.subscribe()).map(move |json| {
        let _held = &guard;
        guard.0.touch();
        Ok::<Event, Infallible>(Event::default().event(SNAPSHOT_EVENT).data(json))
    });
    Sse::new(events).keep_alive(KeepAlive::new().interval(Duration::from_secs(s.sse_keepalive_s))).into_response()
}
