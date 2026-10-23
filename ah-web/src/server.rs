//! The HTTP side: loopback only, a Host check against DNS rebinding, a session cookie minted from the one-time token in the
//! printed address, the page, its files and the event stream.
use crate::data;
use crate::model::Out;
use crate::app::App;
use ah_web_proto::{ActionReq, ActionRes, Boot, Detail, DELTA_EVENT, SNAPSHOT_EVENT};
use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::Json;
use axum::Router;
use serde::Deserialize;
use std::convert::Infallible;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::IntervalStream;

type Shared = Arc<App>;

/// The routes.
pub fn router(app: Shared) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/static/{*path}", get(static_file))
        .route("/pkg/{*path}", get(pkg_file))
        .route("/api/stream", get(stream))
        .route("/api/action", post(action))
        .route("/api/agent/{id}", get(detail))
        .route(ah_web_proto::LIVE_MAP_PATH, get(live_map))
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
        mode: s.mode.clone(),
        limits: s.limits(),
        actions: s.menu(),
        feed_max: s.feed_max,
        graph: crate::cfg::graph_json(&app.root.join(&s.live_graph_rel)).unwrap_or_default(),
        live: s.live(),
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

/// Counts an open stream in its tier; the poller stops when the last one is gone.
struct StreamGuard(Shared, bool);

impl Drop for StreamGuard {
    fn drop(&mut self) {
        let counter = if self.1 { &self.0.lite_streams } else { &self.0.full_streams };
        counter.fetch_sub(1, Ordering::SeqCst);
        self.0.touch();
    }
}

#[derive(Deserialize)]
struct StreamQuery {
    /// `lite` or `full`; anything else (or nothing) takes the configured start tier, `auto` counting as full.
    mode: Option<String>,
}

/// `/api/stream?mode=`: the current snapshot at once, then only what changed, at the tier's rate.
async fn stream(State(app): State<Shared>, Query(q): Query<StreamQuery>, headers: HeaderMap) -> Response {
    if !cookie_ok(&app, &headers) {
        return refuse(&app);
    }
    let s = app.settings();
    if app.streams() >= s.max_streams {
        return (StatusCode::SERVICE_UNAVAILABLE, s.msg_busy.clone()).into_response();
    }
    let lite = match q.mode.as_deref().unwrap_or(&s.mode) {
        "lite" => true,
        _ => false,
    };
    let counter = if lite { &app.lite_streams } else { &app.full_streams };
    counter.fetch_add(1, Ordering::SeqCst);
    let guard = StreamGuard(app.clone(), lite);
    if app.polling.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
        tokio::spawn(data::poll(app.clone()));
    }
    let hz = if lite { s.lite_push_hz } else { s.full_push_hz }.min(s.push_hz_max).max(0.01);
    let mut tick = tokio::time::interval(Duration::from_secs_f64(1.0 / hz));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last: Option<u64> = None;
    let events = IntervalStream::new(tick).filter_map(move |_| {
        let _held = &guard;
        let out = {
            let m = guard.0.model();
            match last {
                None => Out::Snapshot(m.snapshot()),
                Some(n) => m.since(n),
            }
        };
        match out {
            Out::Nothing => None,
            Out::Delta(d) => {
                last = Some(d.seq);
                Event::default().event(DELTA_EVENT).json_data(&d).ok().map(Ok::<Event, Infallible>)
            }
            Out::Snapshot(snap) => {
                last = Some(snap.seq);
                Event::default().event(SNAPSHOT_EVENT).json_data(&snap).ok().map(Ok::<Event, Infallible>)
            }
        }
    });
    Sse::new(events).keep_alive(KeepAlive::new().interval(Duration::from_secs(s.sse_keepalive_s))).into_response()
}

/// An agent id is a tracker id: letters, digits and `-_.:` only, so it can be put in an engine argument or a control request.
fn id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}

fn res(ok: bool, outcome: &str, message: String) -> Response {
    Json(ActionRes { ok, outcome: outcome.into(), message }).into_response()
}

/// `POST /api/action`: run one menu action on one agent as an engine verb (the engine audits it). Actions that ask first are refused
/// until the request says the person confirmed.
async fn action(State(app): State<Shared>, headers: HeaderMap, Json(req): Json<ActionReq>) -> Response {
    if !cookie_ok(&app, &headers) {
        return refuse(&app);
    }
    let s = app.settings();
    let Some(def) = s.actions.iter().find(|a| a.name == req.action) else {
        return res(false, "refused", s.msg_action_unknown.clone());
    };
    if !id_ok(&req.id) {
        return res(false, "refused", s.msg_action_bad_id.clone());
    }
    if def.confirm && !req.confirmed {
        return res(false, "refused", s.msg_action_confirm.clone());
    }
    if def.local {
        return res(true, "done", String::new());
    }
    let args: Vec<String> = def.args.iter().map(|a| a.replace("{id}", &req.id)).collect();
    let run = tokio::process::Command::new(&app.engine)
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let Ok(Ok(out)) = tokio::time::timeout(Duration::from_millis(s.action_timeout_ms), run).await else {
        return res(false, "failed", s.msg_action_timeout.clone());
    };
    let body: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
    let ok = body.get("ok").and_then(serde_json::Value::as_bool).unwrap_or(false);
    let text = |k: &str| body.get(k).and_then(serde_json::Value::as_str).map(str::to_string);
    if ok {
        let note = body.get("result").map(|r| r.to_string()).unwrap_or_default();
        res(true, "done", note.chars().take(s.action_note_max_chars).collect())
    } else {
        res(false, &text("outcome").unwrap_or_else(|| "failed".into()), text("error").unwrap_or_else(|| s.msg_action_failed.clone()))
    }
}

/// `GET /api/agent/{id}`: what the tracker knows of one agent, as label/value rows.
async fn detail(State(app): State<Shared>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    if !cookie_ok(&app, &headers) {
        return refuse(&app);
    }
    let s = app.settings();
    if !id_ok(&id) {
        return (StatusCode::BAD_REQUEST, s.msg_action_bad_id.clone()).into_response();
    }
    let Ok(doc) = crate::ctl::call(&app.socket, &format!("agents agent={id}"), Duration::from_millis(s.ctl_timeout_ms), s.ctl_max_bytes).await else {
        return (StatusCode::BAD_GATEWAY, s.msg_action_timeout.clone()).into_response();
    };
    let mut rows = Vec::new();
    if let Some(a) = doc.get("agents").and_then(serde_json::Value::as_array).and_then(|l| l.first()).and_then(serde_json::Value::as_object) {
        for (k, v) in a {
            if s.detail_skip_keys.contains(k) || v.is_null() {
                continue;
            }
            let text = match v {
                serde_json::Value::String(t) => t.clone(),
                other => other.to_string(),
            };
            rows.push((k.clone(), text.chars().take(s.step_max_chars).collect()));
        }
    }
    Json(Detail { rows }).into_response()
}

/// `GET /api/live/map`: which checks answer which hook events, for the Live screen.
async fn live_map(State(app): State<Shared>, headers: HeaderMap) -> Response {
    if !cookie_ok(&app, &headers) {
        return refuse(&app);
    }
    let s = app.settings();
    Json(crate::live::map(&app, &s).await).into_response()
}
