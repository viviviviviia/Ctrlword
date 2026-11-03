//! Dictionary streaming uses Pot's existing reqwest transport, without disabling
//! WebView security or introducing a separate HTTP service.
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tokio::sync::oneshot;

type Pending = (Option<u64>, oneshot::Sender<()>);
static REQUESTS: Lazy<Mutex<HashMap<String, Pending>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static EARLY_CANCEL: Lazy<Mutex<VecDeque<String>>> = Lazy::new(|| Mutex::new(VecDeque::new()));
static CLIENT: Lazy<reqwest::Client> = Lazy::new(reqwest::Client::new);
static LOCAL_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("local HTTP client")
});

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub request_id: String,
    pub session_id: Option<u64>,
    pub endpoint: String,
    pub api_key: Option<String>,
    pub azure: Option<bool>,
    pub body: Value,
    pub timeout_ms: u64,
    pub kind: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamUpdate {
    request_id: String,
    text: String,
}

#[tauri::command]
pub fn dictionary_cancel(request_id: String) {
    let mut pending = REQUESTS.lock().unwrap();
    if let Some((_, sender)) = pending.remove(&request_id) {
        let _ = sender.send(());
    } else {
        let mut early = EARLY_CANCEL.lock().unwrap();
        early.push_back(request_id);
        if early.len() > 256 {
            early.pop_front();
        }
    }
}
pub fn cancel_hover_requests() {
    let mut requests = REQUESTS.lock().unwrap();
    let ids: Vec<_> = requests
        .iter()
        .filter(|(_, entry)| entry.0.is_some())
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        if let Some((_, sender)) = requests.remove(&id) {
            let _ = sender.send(());
        }
    }
}

fn delta<'a>(value: &'a Value, kind: &str) -> Option<&'a str> {
    if kind == "ollama" {
        value.get("message")?.get("content")?.as_str()
    } else {
        value
            .get("choices")?
            .get(0)?
            .get("delta")?
            .get("content")?
            .as_str()
    }
}

async fn perform_chat<F: FnMut(&str) + Send>(
    request: &ChatRequest,
    mut on_text: F,
) -> Result<String, String> {
    let url = reqwest::Url::parse(&request.endpoint).map_err(|_| "Invalid endpoint")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Endpoint must use HTTP or HTTPS".into());
    }
    let local = url
        .host_str()
        .map(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .map(|ip| ip.is_loopback())
                    .unwrap_or(false)
        })
        .unwrap_or(false);
    let mut builder = if local { &*LOCAL_CLIENT } else { &*CLIENT }
        .post(url)
        .timeout(Duration::from_millis(
            request.timeout_ms.clamp(2000, 120000),
        ))
        .json(&request.body);
    if let Some(key) = request.api_key.as_ref().filter(|k| !k.is_empty()) {
        if request.azure.unwrap_or(false) {
            builder = builder.header("api-key", key)
        } else {
            builder = builder.bearer_auth(key)
        }
    }
    let mut response = builder.send().await.map_err(|error| {
        if error.is_timeout() {
            "Request timeout".into()
        } else {
            "Network request failed".to_string()
        }
    })?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        // Do not copy a remote response body (which may echo private content or credentials) into logs/UI.
        return Err(format!("HTTP {status}"));
    }
    if !request
        .body
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        let value: Value = response.json().await.map_err(|_| "Invalid JSON response")?;
        return if request.kind == "ollama" {
            value["message"]["content"].as_str()
        } else {
            value["choices"][0]["message"]["content"].as_str()
        }
        .map(str::to_owned)
        .ok_or_else(|| "No answer content returned".into());
    }
    let mut pending = Vec::<u8>::new();
    let mut answer = String::new();
    let mut done = false;
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        if error.is_timeout() {
            "Request timeout"
        } else {
            "Stream interrupted"
        }
    })? {
        if request
            .session_id
            .map(|id| !crate::hover::valid(id))
            .unwrap_or(false)
        {
            return Err("Cancelled".into());
        }
        pending.extend_from_slice(&chunk);
        if pending.len() > 1_000_000 || answer.len() > 128_000 {
            return Err("Dictionary response is too large".into());
        }
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            let line: Vec<_> = pending.drain(..=end).collect();
            let line = std::str::from_utf8(&line)
                .map_err(|_| "Invalid UTF-8 stream")?
                .trim();
            let data = if request.kind == "ollama" {
                line
            } else {
                match line.strip_prefix("data:") {
                    Some(data) => data.trim(),
                    None => continue,
                }
            };
            if data.is_empty() {
                continue;
            }
            if data == "[DONE]" {
                done = true;
                break;
            }
            let value: Value = serde_json::from_str(data).map_err(|_| "Invalid stream event")?;
            if value.get("error").is_some() {
                return Err("API reported an error during streaming".into());
            }
            if let Some(text) = delta(&value, &request.kind) {
                answer.push_str(text);
                on_text(&answer);
            }
            if value.get("done").and_then(Value::as_bool) == Some(true) {
                done = true;
                break;
            }
        }
        if done {
            break;
        }
    }
    if !done && !pending.is_empty() {
        let line = std::str::from_utf8(&pending)
            .map_err(|_| "Invalid UTF-8 stream")?
            .trim();
        let data = line.strip_prefix("data:").unwrap_or(line).trim();
        if data == "[DONE]" {
            done = true;
        } else if !data.is_empty() {
            let value: Value = serde_json::from_str(data).map_err(|_| "Incomplete stream")?;
            if let Some(text) = delta(&value, &request.kind) {
                answer.push_str(text);
            }
            done = value.get("done").and_then(Value::as_bool) == Some(true);
        }
    }
    if !done {
        return Err("Incomplete stream".into());
    }
    if answer.trim().is_empty() {
        return Err("No answer content returned".into());
    }
    Ok(answer)
}

fn register_request(request: &ChatRequest) -> Result<oneshot::Receiver<()>, String> {
    let (sender, cancel) = oneshot::channel();
    let mut pending = REQUESTS.lock().unwrap();
    let mut early = EARLY_CANCEL.lock().unwrap();
    if let Some(index) = early.iter().position(|id| id == &request.request_id) {
        early.remove(index);
        return Err("Cancelled".into());
    }
    if pending.contains_key(&request.request_id) {
        return Err("Duplicate request id".into());
    }
    pending.insert(request.request_id.clone(), (request.session_id, sender));
    Ok(cancel)
}

/// Transient statuses worth another attempt: the DeepSeek endpoint answers
/// "Service is too busy" with 503 while the same key keeps working seconds later.
const RETRY_DELAYS_MS: [u64; 3] = [250, 600, 1200];

fn retryable(error: &str) -> bool {
    if error == "Network request failed" {
        return true;
    }
    matches!(
        error
            .strip_prefix("HTTP ")
            .and_then(|code| code.parse::<u16>().ok()),
        Some(429 | 500 | 502 | 503 | 504)
    )
}

async fn chat_with_retries<F: Fn(&str) + Send + Sync>(
    request: &ChatRequest,
    on_text: F,
) -> Result<String, String> {
    let emitted = AtomicBool::new(false);
    let mut attempt = 0usize;
    loop {
        emitted.store(false, Ordering::SeqCst);
        let outcome = perform_chat(request, |text| {
            emitted.store(true, Ordering::SeqCst);
            on_text(text);
        })
        .await;
        match outcome {
            Ok(text) => return Ok(text),
            Err(error) => {
                // 429/5xx from a busy provider are transient; retry before the card
                // ever shows a failure, but never after text has streamed.
                if attempt < RETRY_DELAYS_MS.len()
                    && !emitted.load(Ordering::SeqCst)
                    && retryable(&error)
                {
                    let delay = RETRY_DELAYS_MS[attempt];
                    attempt += 1;
                    log::info!(
                        "Ctrlword retrying after {error}: attempt {} in {delay}ms",
                        attempt + 1
                    );
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                    continue;
                }
                return Err(error);
            }
        }
    }
}

#[tauri::command]
pub async fn dictionary_chat(
    window: tauri::Window,
    request: ChatRequest,
) -> Result<String, String> {
    if request.request_id.len() > 120 {
        return Err("Invalid request id".into());
    }
    if request
        .session_id
        .map(|id| !crate::hover::valid(id))
        .unwrap_or(false)
    {
        return Err("Cancelled".into());
    }
    let mut cancel = register_request(&request)?;
    let operation = chat_with_retries(&request, |text| {
        let _ = window.emit(
            "chd:stream",
            StreamUpdate {
                request_id: request.request_id.clone(),
                text: text.to_owned(),
            },
        );
    });
    let result = tokio::select! {answer=operation=>answer,_=&mut cancel=>Err("Cancelled".into())};
    REQUESTS.lock().unwrap().remove(&request.request_id);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::atomic::AtomicU64;
    fn server(status: u16, body: String) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let read = stream.read(&mut buffer).unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|number| number.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let header=format!("HTTP/1.1 {status} Result\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len());
            stream.write_all(header.as_bytes()).unwrap();
            for chunk in body.as_bytes().chunks(3) {
                if stream.write_all(chunk).is_err() {
                    break;
                }
            }
        });
        format!("http://{address}/chat/completions")
    }
    fn request(id: &str, endpoint: String, kind: &str, stream: bool) -> ChatRequest {
        ChatRequest {
            request_id: id.into(),
            session_id: None,
            endpoint,
            api_key: None,
            azure: None,
            body: serde_json::json!({"stream":stream,"messages":[]}),
            timeout_ms: 2000,
            kind: kind.into(),
        }
    }
    #[tokio::test]
    async fn fragmented_sse_is_decoded_and_reasoning_is_not_exposed() {
        let body="data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"private reasoning\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"示例\"}}]}\n\ndata: [DONE]\n\n";
        let req = request("sse", server(200, body.into()), "openai", true);
        let mut updates = vec![];
        assert_eq!(
            perform_chat(&req, |text| updates.push(text.to_owned()))
                .await
                .unwrap(),
            "示例"
        );
        assert_eq!(updates, vec!["示例"]);
    }
    #[tokio::test]
    async fn ollama_ndjson_and_regular_json_are_supported() {
        let req=request("ollama",server(200,"{\"message\":{\"content\":\"local\"},\"done\":false}\n{\"message\":{\"content\":\"\"},\"done\":true}\n".into()),"ollama",true);
        assert_eq!(perform_chat(&req, |_| {}).await.unwrap(), "local");
        let req = request(
            "json",
            server(
                200,
                "{\"choices\":[{\"message\":{\"content\":\"answer\"}}]}".into(),
            ),
            "openai",
            false,
        );
        assert_eq!(perform_chat(&req, |_| {}).await.unwrap(), "answer");
    }
    #[tokio::test]
    async fn http_errors_and_incomplete_streams_are_not_successes() {
        let req = request(
            "auth",
            server(401, "secret must not be echoed".into()),
            "openai",
            true,
        );
        assert_eq!(perform_chat(&req, |_| {}).await.unwrap_err(), "HTTP 401");
        let req = request(
            "truncated",
            server(
                200,
                "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n".into(),
            ),
            "openai",
            true,
        );
        assert_eq!(
            perform_chat(&req, |_| {}).await.unwrap_err(),
            "Incomplete stream"
        );
    }
    #[tokio::test]
    async fn cancellation_before_and_after_registration_is_reliable() {
        let req = request(
            "early-cancel-test",
            "http://127.0.0.1".into(),
            "openai",
            true,
        );
        dictionary_cancel(req.request_id.clone());
        assert!(register_request(&req).is_err());
        let mut cancellation = register_request(&req).unwrap();
        dictionary_cancel(req.request_id.clone());
        assert_eq!(cancellation.try_recv().unwrap(), ());
    }
    #[tokio::test]
    async fn stalled_api_reaches_the_configured_timeout() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (_stream, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_millis(2300));
        });
        let req = request("timeout", format!("http://{address}"), "openai", true);
        assert_eq!(
            perform_chat(&req, |_| {}).await.unwrap_err(),
            "Request timeout"
        );
    }
    /// Serves one response per accepted connection; returns the endpoint and the
    /// number of connections actually opened.
    fn sequence(statuses: Vec<u16>) -> (String, std::sync::Arc<AtomicU64>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let opened = std::sync::Arc::new(AtomicU64::new(0));
        let counter = opened.clone();
        std::thread::spawn(move || {
            for status in statuses {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                counter.fetch_add(1, Ordering::SeqCst);
                let mut buffer = [0u8; 4096];
                let _ = stream.read(&mut buffer);
                let body = if status == 200 {
                    "{\"choices\":[{\"message\":{\"content\":\"ok\"}}]}"
                } else {
                    "{\"error\":{\"message\":\"busy\"}}"
                };
                let header = format!(
                    "HTTP/1.1 {status} Result\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(header.as_bytes());
            }
        });
        (format!("http://{address}/chat/completions"), opened)
    }
    #[tokio::test]
    async fn busy_provider_is_retried_before_failing() {
        let (endpoint, opened) = sequence(vec![503, 503, 200]);
        let req = request("busy", endpoint, "openai", false);
        assert_eq!(
            chat_with_retries(&req, |_| {}).await.unwrap(),
            "ok",
            "503 then 200 must succeed"
        );
        assert_eq!(opened.load(Ordering::SeqCst), 3);
    }
    #[tokio::test]
    async fn permanent_errors_are_not_retried() {
        let (endpoint, opened) = sequence(vec![401]);
        let req = request("auth", endpoint, "openai", false);
        assert_eq!(
            chat_with_retries(&req, |_| {}).await.unwrap_err(),
            "HTTP 401"
        );
        assert_eq!(opened.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn retries_stop_after_the_last_delay() {
        let (endpoint, opened) = sequence(vec![503, 503, 503, 503, 503]);
        let req = request("busy-forever", endpoint, "openai", false);
        assert_eq!(
            chat_with_retries(&req, |_| {}).await.unwrap_err(),
            "HTTP 503"
        );
        assert_eq!(opened.load(Ordering::SeqCst), 4, "one try plus three retries");
    }
}
