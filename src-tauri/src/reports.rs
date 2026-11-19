use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::Manager;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{mpsc, oneshot, Mutex as AsyncMutex, OnceCell},
    time::{timeout, timeout_at, Instant},
};

const DISCONNECTED: &str = "The environment stopped. Refresh to reconnect.";
const TIMED_OUT: &str = "The environment took too long. Refresh to retry.";

#[derive(Clone, Serialize)]
pub struct Environment {
    id: String,
    label: String,
}

#[derive(Default)]
pub struct Reports {
    targets: OnceCell<Vec<(Environment, AsyncMutex<Option<Worker>>)>>,
}

fn local() -> Environment {
    Environment {
        id: "local".into(),
        label: match std::env::consts::OS {
            "windows" => "Windows",
            "macos" => "macOS",
            "linux" => "Linux",
            os => os,
        }
        .into(),
    }
}

#[cfg(any(windows, test))]
fn distros(bytes: &[u8]) -> Vec<Environment> {
    let units: Vec<_> = bytes
        .chunks_exact(2)
        .map(|p| u16::from_le_bytes([p[0], p[1]]))
        .collect();
    if bytes.len() % 2 != 0 {
        return vec![];
    }
    let Ok(names) = String::from_utf16(&units) else {
        return vec![];
    };
    names
        .trim_start_matches('\u{feff}')
        .lines()
        .map(str::trim)
        .filter(|name| {
            !name.is_empty()
                && !name.contains('\0')
                && !name.eq_ignore_ascii_case("docker-desktop")
                && !name.eq_ignore_ascii_case("docker-desktop-data")
        })
        .map(|name| Environment {
            id: format!("wsl:{name}"),
            label: format!("WSL · {name}"),
        })
        .collect()
}

impl Reports {
    async fn targets(&self) -> &[(Environment, AsyncMutex<Option<Worker>>)] {
        self.targets
            .get_or_init(|| async {
                let entries = vec![local()];
                #[cfg(windows)]
                let entries = {
                    let mut entries = entries;
                    let output = timeout(
                        Duration::from_secs(10),
                        wsl().args(["--list", "--quiet"]).output(),
                    )
                    .await;
                    if let Ok(Ok(out)) = output {
                        if out.status.success() {
                            entries.extend(distros(&out.stdout));
                        }
                    }
                    entries
                };
                entries
                    .into_iter()
                    .map(|entry| (entry, AsyncMutex::default()))
                    .collect()
            })
            .await
    }

    async fn request(
        &self,
        directory: &Path,
        environment: &str,
        method: &str,
        input: Value,
    ) -> Result<Value, String> {
        let duration = match method {
            "summary" => Duration::from_secs(300),
            "limits" | "reset" | "prices" | "save" => Duration::from_secs(60),
            _ => return Err("Unknown report request".into()),
        };
        let deadline = Instant::now() + duration;
        let worker = timeout_at(deadline, async {
            let (_, slot) = self
                .targets()
                .await
                .iter()
                .find(|(entry, _)| entry.id == environment)
                .ok_or("Unknown report request")?;
            let mut slot = slot.lock().await;
            if slot
                .as_ref()
                .is_none_or(|worker| worker.pending.lock().unwrap().is_none())
            {
                let command = worker_command(directory, environment).await?;
                *slot = Some(Worker::spawn(command)?);
            }
            Ok::<_, String>(slot.as_ref().unwrap().clone())
        })
        .await
        .map_err(|_| TIMED_OUT)??;
        worker.request(method, input, deadline).await
    }
}

#[tauri::command]
pub async fn environments(state: tauri::State<'_, Reports>) -> Result<Vec<Environment>, String> {
    Ok(state
        .targets()
        .await
        .iter()
        .map(|(entry, _)| entry.clone())
        .collect())
}

#[tauri::command]
pub async fn report(
    app: tauri::AppHandle,
    state: tauri::State<'_, Reports>,
    environment: String,
    method: String,
    input: Option<Value>,
) -> Result<Value, String> {
    let dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    state
        .request(&dir, &environment, &method, input.unwrap_or(Value::Null))
        .await
}

#[cfg(windows)]
fn wsl() -> Command {
    let mut command = Command::new("wsl.exe");
    command.creation_flags(0x08000000).kill_on_drop(true);
    command
}

#[cfg(any(windows, test))]
fn forwarded(existing: &str) -> String {
    existing
        .split(':')
        .filter(|s| {
            !s.is_empty()
                && !s
                    .split('/')
                    .next()
                    .unwrap()
                    .eq_ignore_ascii_case("T3CODE_DESKTOP_HOST_SCOPE")
        })
        .chain(["T3CODE_DESKTOP_HOST_SCOPE"])
        .collect::<Vec<_>>()
        .join(":")
}

async fn worker_command(dir: &Path, environment: &str) -> Result<Command, String> {
    let command = if environment == "local" {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let suffix = std::env::consts::EXE_SUFFIX;
        let node = exe.with_file_name(format!("modelgauge-node{suffix}"));
        let mut command = Command::new(node);
        // Node realpath fails on the extended-length paths returned by Windows.
        #[cfg(windows)]
        command.arg("--preserve-symlinks-main");
        command.arg(dir.join("worker.cjs"));
        command
    } else {
        #[cfg(not(windows))]
        return Err("Unknown report request".into());
        #[cfg(windows)]
        {
            let distro = environment
                .strip_prefix("wsl:")
                .ok_or("Unknown report request")?;
            let args = ["--distribution", distro, "--exec"];
            let out = timeout(
                Duration::from_secs(30),
                wsl()
                    .args(args)
                    .args(["wslpath", "-a", "-u"])
                    .arg(dir)
                    .output(),
            )
            .await
            .map_err(|_| TIMED_OUT)?
            .map_err(|e| e.to_string())?;
            let path = std::str::from_utf8(&out.stdout)
                .unwrap_or("")
                .trim_end_matches(['\r', '\n']);
            if !out.status.success() || !path.starts_with('/') || path.contains(['\r', '\n', '\0'])
            {
                return Err("WSL could not resolve the report worker.".into());
            }
            let mut command = wsl();
            command
                .args(args)
                .arg(format!("{path}/wsl/node"))
                .arg(format!("{path}/worker.cjs"));
            command
        }
    };
    #[cfg(windows)]
    {
        let scope = std::env::var_os("T3CODE_DESKTOP_HOST_SCOPE")
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var_os("COMPUTERNAME"))
            .ok_or("Missing Windows host scope")?;
        let mut command = command;
        command
            .creation_flags(0x08000000)
            .env("T3CODE_DESKTOP_HOST_SCOPE", scope)
            .env(
                "WSLENV",
                forwarded(&std::env::var("WSLENV").unwrap_or_default()),
            );
        return Ok(command);
    }
    #[cfg(not(windows))]
    Ok(command)
}

type Reply = oneshot::Sender<Result<Value, String>>;
type Pending = Arc<Mutex<Option<HashMap<u64, Reply>>>>;

struct PendingRequest<'a> {
    id: u64,
    pending: &'a Pending,
}

impl Drop for PendingRequest<'_> {
    fn drop(&mut self) {
        if let Some(map) = self.pending.lock().unwrap().as_mut() {
            map.remove(&self.id);
        }
    }
}

#[derive(Clone)]
struct Worker {
    writes: mpsc::Sender<(u64, Vec<u8>, Instant)>,
    pending: Pending,
    next: Arc<AtomicU64>,
}

impl Worker {
    fn spawn(mut command: Command) -> Result<Self, String> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| e.to_string())?;
        let mut stdin = child.stdin.take().unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let (writes, mut queue) = mpsc::channel::<(u64, Vec<u8>, Instant)>(32);
        let pending: Pending = Arc::new(Mutex::new(Some(HashMap::new())));
        let readers = pending.clone();
        let mut reader = tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(mut msg) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let Some(id) = msg["id"].as_u64() else {
                    continue;
                };
                if let Some(tx) = readers
                    .lock()
                    .unwrap()
                    .as_mut()
                    .and_then(|map| map.remove(&id))
                {
                    let reply = match msg["error"].as_str() {
                        Some(error) if !error.is_empty() => Err(error.to_owned()),
                        _ => Ok(msg["value"].take()),
                    };
                    let _ = tx.send(reply);
                }
            }
            readers.lock().unwrap().take();
            let _ = timeout(Duration::from_secs(5), child.wait()).await;
        });
        let writers = pending.clone();
        tokio::spawn(async move {
            while let Some((id, line, deadline)) = queue.recv().await {
                if Instant::now() >= deadline
                    || !writers
                        .lock()
                        .unwrap()
                        .as_ref()
                        .is_some_and(|map| map.contains_key(&id))
                {
                    continue;
                }
                if !matches!(
                    timeout_at(deadline, stdin.write_all(&line)).await,
                    Ok(Ok(()))
                ) {
                    writers.lock().unwrap().take();
                    reader.abort(); // A partial JSON line makes the stream unusable.
                    return;
                }
            }
            drop(stdin);
            if timeout(Duration::from_secs(5), &mut reader).await.is_err() {
                reader.abort();
            }
        });
        Ok(Self {
            writes,
            pending,
            next: Arc::default(),
        })
    }

    async fn request(
        &self,
        method: &str,
        input: Value,
        deadline: Instant,
    ) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let mut line = serde_json::to_vec(&json!({ "id": id, "method": method, "input": input }))
            .map_err(|e| e.to_string())?;
        line.push(b'\n');
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap()
            .as_mut()
            .ok_or(DISCONNECTED)?
            .insert(id, tx);
        let _request = PendingRequest {
            id,
            pending: &self.pending,
        };
        timeout_at(deadline, async {
            self.writes
                .send((id, line, deadline))
                .await
                .map_err(|_| DISCONNECTED)?;
            rx.await.map_err(|_| DISCONNECTED)?
        })
        .await
        .map_err(|_| TIMED_OUT)?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_discovery_and_forwarding() {
        let bytes: Vec<_> =
            "\u{feff}Ubuntu 测试\r\nDocker-Desktop\r\ndocker-desktop-data\r\nDebian\r\n"
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect();
        let envs = distros(&bytes);
        assert_eq!(envs.len(), 2);
        assert_eq!(envs[0].id, "wsl:Ubuntu 测试");
        assert_eq!(envs[0].label, "WSL · Ubuntu 测试");
        assert_eq!(envs[1].id, "wsl:Debian");
        assert_eq!(
            forwarded("PATH/l:T3CODE_DESKTOP_HOST_SCOPE/u::FOO/p"),
            "PATH/l:FOO/p:T3CODE_DESKTOP_HOST_SCOPE"
        );
    }

    #[test]
    fn rejects_unknown_environment_and_method_before_launch() {
        tauri::async_runtime::block_on(async {
            let state = Reports::default();
            state
                .targets
                .set(vec![(local(), AsyncMutex::default())])
                .unwrap_or_else(|_| panic!());
            for (env, method) in [("wsl:undiscovered", "prices"), ("local", "unknown")] {
                assert_eq!(
                    state
                        .request(Path::new("."), env, method, Value::Null)
                        .await
                        .unwrap_err(),
                    "Unknown report request"
                );
            }
            assert!(state.targets().await[0].1.lock().await.is_none());
        });
    }

    #[test]
    fn multiplexes_responses_and_handles_timeouts_and_exit() {
        tauri::async_runtime::block_on(async {
            let mut command = Command::new("node");
            command.arg("-e").arg(
                r#"
                const lines = require("node:readline").createInterface({input: process.stdin});
                const send = reply => console.log(JSON.stringify(reply));
                const pair = [];
                lines.on("line", line => {
                    const {id, input} = JSON.parse(line);
                    if (input === "hold" || input === "release") pair.push({id, input});
                    if (pair.length === 2) {
                        console.log("diagnostic");
                        for (const {id, input} of pair.reverse()) {
                            send(input === "hold" ? {id, value: "first response"} : {id, error: "synthetic failure"});
                        }
                        pair.length = 0;
                    }
                    if (input === "exit") process.exit(0);
                });
            "#,
            );
            let worker = Worker::spawn(command).unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            let first_worker = worker.clone();
            let first = tokio::spawn(async move {
                first_worker
                    .request("prices", json!("hold"), deadline)
                    .await
            });
            assert_eq!(
                worker
                    .request("prices", json!("release"), deadline)
                    .await
                    .unwrap_err(),
                "synthetic failure"
            );
            assert_eq!(first.await.unwrap().unwrap(), "first response");
            assert_eq!(
                worker
                    .request(
                        "prices",
                        json!("ignore"),
                        Instant::now() + Duration::from_millis(30)
                    )
                    .await
                    .unwrap_err(),
                TIMED_OUT
            );
            assert!(worker.pending.lock().unwrap().as_ref().unwrap().is_empty());
            assert_eq!(
                worker
                    .request("prices", json!("exit"), deadline)
                    .await
                    .unwrap_err(),
                DISCONNECTED
            );
            assert!(worker.pending.lock().unwrap().is_none());
        });
    }
}
