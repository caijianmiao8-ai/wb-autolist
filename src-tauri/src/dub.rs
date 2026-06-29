#![allow(dead_code)]
//! EN→RU 产品视频配音 —— 对 Node 配音 CLI(tools/dub/cli.mjs)的子进程网关。
//!
//! 拓扑:重 CPU 阶段(ffmpeg / Demucs / 择优)在**用户自己的机器**上跑、用
//! **用户自己的 Aurixel key**(按量计费在用户账上),中心不背 CPU。本模块只负责
//! 起子进程、把它逐行的阶段进度桥接成 webview 事件、原子地拿回成片路径。
//!
//! 安全:Aurixel 密钥只经子进程 env 注入,绝不进命令行参数 / 日志 / 事件。
//! DUB_ENV_PATH 指向一个不存在的文件,让 CLI 只认我们注入的 env(不读仓库
//! .env.local —— 打包后也不存在)。

use crate::config::get_config;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::oneshot;

/// Windows: suppress the console window that spawning a console-subsystem binary
/// (node / uvx / python / ffmpeg) pops up from a GUI app — it looks alarming to
/// users. 0x08000000 = CREATE_NO_WINDOW. No-op elsewhere.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
fn hide_window(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn hide_window(_cmd: &mut std::process::Command) {}

/// 一次只允许一个配音任务(单用户桌面;前端也会锁住表单)。存放取消句柄;
/// `Some` 即代表「有任务在跑」。
fn cancel_slot() -> &'static Mutex<Option<oneshot::Sender<()>>> {
    static S: OnceLock<Mutex<Option<oneshot::Sender<()>>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DubOptions {
    pub input_path: String,
    #[serde(default)]
    pub out_path: Option<String>,
    // —— 翻译优化(可选) ——
    #[serde(default)]
    pub brand: Option<String>,
    #[serde(default)]
    pub keywords: Option<String>,
    #[serde(default)]
    pub tone: Option<String>,
    /// "clone"(克隆原声,默认) | "preset"(预设音色)
    #[serde(default)]
    pub voice_mode: Option<String>,
    /// 预设音色名(voice_mode=preset 时生效)
    #[serde(default)]
    pub preset_voice: Option<String>,
    /// "fast" | "standard"(默认) | "high"
    #[serde(default)]
    pub quality: Option<String>,
    // —— 高级 ——
    #[serde(default)]
    pub keep_background: Option<bool>,
    #[serde(default)]
    pub gate_silence: Option<bool>,
    #[serde(default)]
    pub diarize: Option<bool>,
    /// 原声混入比例 0..1(0=完全替换,默认)
    #[serde(default)]
    pub keep_original_audio: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DubPreflight {
    pub node: bool,
    pub ffmpeg: bool,
    pub ffprobe: bool,
    /// 可选:Demucs 背景分离 + resemblyzer 择优。缺则自动降级(不挡上手)。
    pub uvx: bool,
    pub aurixel_key: bool,
    pub cli_found: bool,
    /// node && ffmpeg && ffprobe && aurixel_key && cli_found —— 必需项全齐才放行。
    pub ready: bool,
    pub node_path: String,
    pub cli_path: String,
}

fn home() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default()
}

/// 绝对路径直接看文件是否存在;否则尝试 `<bin> --version` 看能不能跑起来。
fn bin_ok(path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    if Path::new(path).is_file() {
        return true;
    }
    let mut c = std::process::Command::new(path);
    c.arg("--version").stdout(Stdio::null()).stderr(Stdio::null());
    hide_window(&mut c); // no console flash on the Windows preflight checks
    c.status().map(|s| s.success()).unwrap_or(false)
}

/// 打包进安装包的二进制:resource_dir/bin/{name}{.exe}。让客户(Windows)开箱即用
/// node/ffmpeg/uvx,而不依赖系统 PATH。
fn bundled_bin(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let exe = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let p = app.path().resource_dir().ok()?.join("bin").join(exe);
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

/// 找 node:env DUB_NODE → 打包资源 → ~/.local/node/bin/node(开发机) → PATH 的 `node`。
fn resolve_node(app: &AppHandle) -> String {
    if let Ok(p) = std::env::var("DUB_NODE") {
        if !p.is_empty() {
            return p;
        }
    }
    if let Some(p) = bundled_bin(app, "node") {
        return p.to_string_lossy().into();
    }
    let cand = format!("{}/.local/node/bin/node", home());
    if Path::new(&cand).is_file() {
        return cand;
    }
    "node".into()
}

fn resolve_uvx(app: &AppHandle) -> String {
    if let Ok(p) = std::env::var("DEMUCS_UVX") {
        if !p.is_empty() {
            return p;
        }
    }
    if let Some(p) = bundled_bin(app, "uvx") {
        return p.to_string_lossy().into();
    }
    format!("{}/.local/bin/uvx", home())
}

fn resolve_ffbin(app: &AppHandle, name: &str) -> String {
    let envk = if name == "ffmpeg" {
        "FFMPEG_PATH"
    } else {
        "FFPROBE_PATH"
    };
    if let Ok(p) = std::env::var(envk) {
        if !p.is_empty() {
            return p;
        }
    }
    if let Some(p) = bundled_bin(app, name) {
        return p.to_string_lossy().into();
    }
    let cand = format!("{}/.local/bin/{}", home(), name);
    if Path::new(&cand).is_file() {
        return cand;
    }
    name.into()
}

/// 找配音脚本:env DUB_CLI → 打包资源 resource_dir/tools/dub/cli.mjs →
/// 开发期 <crate>/../tools/dub/cli.mjs。
fn resolve_cli(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("DUB_CLI") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("tools").join("dub").join("cli.mjs");
        if p.is_file() {
            return Some(p);
        }
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|r| r.join("tools").join("dub").join("cli.mjs"));
    if let Some(p) = dev {
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn opt_str(o: &Option<String>) -> Option<String> {
    o.as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 检测运行时是否齐备 —— 喂前端的「自检条」。
#[tauri::command]
pub fn dub_preflight(app: AppHandle, state: State<Arc<AppState>>) -> DubPreflight {
    let cfg = get_config(&state.paths);
    let node_path = resolve_node(&app);
    let cli = resolve_cli(&app);
    let node = bin_ok(&node_path);
    let ffmpeg = bin_ok(&resolve_ffbin(&app, "ffmpeg"));
    let ffprobe = bin_ok(&resolve_ffbin(&app, "ffprobe"));
    let uvx = bin_ok(&resolve_uvx(&app));
    // 钥匙串读失败时不能误判为「有 key」(与上架路径同样的 kc_error 守卫)。
    let aurixel_key = !cfg.kc_error && !cfg.aurixel_api_key.trim().is_empty();
    let cli_found = cli.is_some();
    let ready = node && ffmpeg && ffprobe && aurixel_key && cli_found;
    DubPreflight {
        node,
        ffmpeg,
        ffprobe,
        uvx,
        aurixel_key,
        cli_found,
        ready,
        node_path,
        cli_path: cli
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
    }
}

/// 原生选文件对话框,返回视频的绝对路径(webview 的 <input type=file> 拿不到真路径)。
#[tauri::command]
pub async fn dub_pick_video(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .add_filter("视频", &["mp4", "mov", "mkv", "webm", "avi", "m4v"])
        .pick_file(move |p| {
            let _ = tx.send(p);
        });
    let picked = rx.await.map_err(|e| e.to_string())?;
    Ok(picked
        .and_then(|fp| fp.into_path().ok())
        .map(|pb| pb.to_string_lossy().to_string()))
}

/// Native folder picker → absolute dir path (used by 批量「关联素材文件夹」).
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = oneshot::channel();
    app.dialog().file().pick_folder(move |p| {
        let _ = tx.send(p);
    });
    let picked = rx.await.map_err(|e| e.to_string())?;
    Ok(picked
        .and_then(|fp| fp.into_path().ok())
        .map(|pb| pb.to_string_lossy().to_string()))
}

/// 解析 CLI 的进度行 `  [ok ] stage   234ms  [WARN …]` → JSON 事件。非进度行返回 None。
fn parse_stage(line: &str) -> Option<Value> {
    let t = line.trim_start();
    let ok = t.starts_with("[ok");
    let err = t.starts_with("[ERR]");
    if !ok && !err {
        return None;
    }
    let body = t.get(5..)?.trim(); // 去掉 5 字符的 "[ok ]" / "[ERR]"
    let parts: Vec<&str> = body.split_whitespace().collect();
    let stage = (*parts.first()?).to_string();
    let ms = parts
        .get(1)
        .and_then(|s| s.trim_end_matches("ms").parse::<u64>().ok())
        .unwrap_or(0);
    let rest = parts.get(2..).map(|r| r.join(" ")).unwrap_or_default();
    let mut obj = json!({ "stage": stage, "ok": ok, "ms": ms });
    if let Some(w) = rest.strip_prefix("WARN ") {
        obj["warn"] = Value::String(w.to_string());
    } else if !rest.is_empty() {
        if err {
            obj["error"] = Value::String(rest);
        } else {
            obj["warn"] = Value::String(rest);
        }
    }
    Some(obj)
}

/// 从 stderr 里挑出最可读的错误(CLI 失败时打 `FAILED:` / `FATAL:`)。
fn first_error_line(stderr: &str) -> Option<String> {
    for l in stderr.lines() {
        let l = l.trim();
        if let Some(r) = l.strip_prefix("FAILED:") {
            return Some(r.trim().to_string());
        }
        if let Some(r) = l.strip_prefix("FATAL:") {
            return Some(r.trim().to_string());
        }
    }
    stderr
        .lines()
        .rev()
        .map(|s| s.trim())
        .find(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// 启动一次配音。逐阶段 emit `dub:progress`,成功 emit `dub:done` 并返回成片路径。
#[tauri::command]
pub async fn dub_start(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    options: DubOptions,
) -> Result<String, String> {
    let cfg = get_config(&state.paths);
    if cfg.kc_error {
        return Err("密钥读取失败(钥匙串),请到设置页重新保存 Aurixel 密钥".into());
    }
    let key = cfg.aurixel_api_key.trim().to_string();
    if key.is_empty() {
        return Err("未配置 Aurixel 密钥,请到设置页填写".into());
    }

    let input = PathBuf::from(&options.input_path);
    if !input.is_file() {
        return Err(format!("找不到视频文件:{}", options.input_path));
    }

    let cli = resolve_cli(&app).ok_or("找不到配音脚本 cli.mjs(打包资源缺失)")?;
    let node = resolve_node(&app);
    let ffmpeg = resolve_ffbin(&app, "ffmpeg");
    let ffprobe = resolve_ffbin(&app, "ffprobe");
    let uvx = resolve_uvx(&app);

    // 输出路径:用户给定,否则与源同目录、加 .ru.mp4。
    let out = match &options.out_path {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => {
            let stem = input
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "output".into());
            let dir = input
                .parent()
                .map(|d| d.to_path_buf())
                .unwrap_or_else(|| PathBuf::from("."));
            dir.join(format!("{}.ru.mp4", stem))
        }
    };

    // 质量档 → 候选数 / 择优 / 音高重掷 / 等时。
    let quality = options.quality.as_deref().unwrap_or("standard");
    let (render_candidates, mut voice_select, pitch_reroll, iso) = match quality {
        "fast" => (1u32, false, false, false),
        "high" => (4u32, true, true, true),
        _ => (2u32, true, true, true), // standard
    };

    // 缺 uvx → 关掉依赖它的功能(择优 + 背景分离),不挡跑通。
    let uvx_ok = bin_ok(&uvx);
    voice_select = voice_select && uvx_ok;
    let keep_background = options.keep_background.unwrap_or(true) && uvx_ok;

    // 音色:克隆走 aurixel-vc,预设走 aurixel(预设音色经 AURIXEL_VOICE)。
    let voice_mode = options.voice_mode.as_deref().unwrap_or("clone");
    let tts_provider = if voice_mode == "preset" {
        "aurixel"
    } else {
        "aurixel-vc"
    };

    let mut args: Vec<String> = vec![
        cli.to_string_lossy().to_string(),
        input.to_string_lossy().to_string(),
        "--out".into(),
        out.to_string_lossy().to_string(),
        "--asr-provider".into(),
        "aurixel".into(),
        "--tts-provider".into(),
        tts_provider.into(),
        "--cleanup".into(), // 成功后清理 workDir(商家音频/克隆样本属敏感数据)
    ];
    if let Some(b) = opt_str(&options.brand) {
        args.push("--brand".into());
        args.push(b);
    }
    if let Some(k) = opt_str(&options.keywords) {
        args.push("--keywords".into());
        args.push(k);
    }
    if let Some(t) = opt_str(&options.tone) {
        args.push("--tone".into());
        args.push(t);
    }
    if !iso {
        args.push("--no-iso".into());
    }
    if !keep_background {
        args.push("--no-background".into());
        // Demucs is only needed to KEEP the background (high preset). For fast/
        // standard the clone enrolls from raw audio (cloneSrc fallback), so skip
        // Demucs entirely → no uvx/torch download. voice-select (standard) still
        // runs via VOICE_SELECT and works on raw-audio references.
        args.push("--no-stems".into());
    }
    if options.gate_silence == Some(false) {
        args.push("--no-gate".into());
    }
    if options.diarize == Some(false) {
        args.push("--no-diarize".into());
    }
    if let Some(v) = options.keep_original_audio {
        if v > 0.0 && v <= 1.0 {
            args.push("--keep-original-audio".into());
            args.push(format!("{}", v));
        }
    }

    // env:密钥 + 质量旋钮 + 隔离 .env.local。
    let mut cmd = tokio::process::Command::new(&node);
    cmd.args(&args)
        .env("AURIXEL_API_KEY", &key)
        .env("RENDER_CANDIDATES", render_candidates.to_string())
        .env("VOICE_SELECT", if voice_select { "true" } else { "false" })
        .env("PITCH_REROLL", if pitch_reroll { "true" } else { "false" })
        // Point the Node CLI at the bundled ffmpeg/ffprobe/uvx (it reads these env
        // vars; absolute paths bypass PATH so the customer needs nothing installed).
        .env("FFMPEG_PATH", &ffmpeg)
        .env("FFPROBE_PATH", &ffprobe)
        .env("DEMUCS_UVX", &uvx)
        .env(
            "DUB_ENV_PATH",
            state
                .paths
                .data_dir
                .join(".dub.env")
                .to_string_lossy()
                .to_string(),
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if voice_mode == "preset" {
        if let Some(v) = opt_str(&options.preset_voice) {
            cmd.env("AURIXEL_VOICE", v);
        }
    }
    // No console window when launching node.exe on Windows (it would otherwise pop
    // a cmd window; node's own children are hidden via windowsHide in ffmpeg.mjs).
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    // 占闸(原子):已有任务则拒。然后起子进程。
    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    {
        let mut slot = cancel_slot().lock().unwrap();
        if slot.is_some() {
            return Err("已有配音任务在进行中".into());
        }
        *slot = Some(cancel_tx);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            *cancel_slot().lock().unwrap() = None;
            return Err(format!("启动配音进程失败({}):{}", node, e));
        }
    };

    let stdout = child.stdout.take().ok_or("无法读取子进程 stdout")?;
    let stderr = child.stderr.take().ok_or("无法读取子进程 stderr")?;

    // 后台收 stderr(失败信息)。
    let err_task = tokio::spawn(async move {
        let mut buf = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            buf.push_str(&l);
            buf.push('\n');
        }
        buf
    });

    let app_ev = app.clone();
    let mut reader = BufReader::new(stdout).lines();
    let mut output: Option<String> = None;
    let mut cancelled = false;

    loop {
        tokio::select! {
            line = reader.next_line() => {
                match line {
                    Ok(Some(l)) => {
                        if let Some(o) = l.strip_prefix("OUTPUT=") {
                            output = Some(o.trim().to_string());
                            continue;
                        }
                        if let Some(ev) = parse_stage(&l) {
                            let _ = app_ev.emit("dub:progress", ev);
                        }
                    }
                    Ok(None) => break, // EOF
                    Err(_) => break,
                }
            }
            _ = &mut cancel_rx => {
                cancelled = true;
                let _ = child.start_kill();
                break;
            }
        }
    }

    let status = child.wait().await;
    let stderr_txt = err_task.await.unwrap_or_default();
    *cancel_slot().lock().unwrap() = None;

    if cancelled {
        let _ = app.emit("dub:progress", json!({"stage":"cancelled","ok":false,"ms":0}));
        return Err("已取消".into());
    }

    let ok = status.map(|s| s.success()).unwrap_or(false);
    match (ok, output) {
        (true, Some(o)) => {
            let _ = app.emit("dub:done", json!({ "out": o }));
            Ok(o)
        }
        _ => {
            let msg = first_error_line(&stderr_txt).unwrap_or_else(|| "配音失败".into());
            let _ = app.emit(
                "dub:progress",
                json!({"stage":"failed","ok":false,"ms":0,"error":msg}),
            );
            Err(msg)
        }
    }
}

/// 取消正在跑的配音任务(也用于取消「下载配音引擎」)。
#[tauri::command]
pub fn dub_cancel() -> bool {
    if let Some(tx) = cancel_slot().lock().unwrap().take() {
        let _ = tx.send(());
        true
    } else {
        false
    }
}

/// 配音引擎(Demucs/voice-select 模型)预下载状态。preparing 在下载期间为真;
/// last_msg 是最近一条进度——设置页切 tab 回来据此重建 UI。
fn engine_state() -> &'static Mutex<(bool, String)> {
    static S: OnceLock<Mutex<(bool, String)>> = OnceLock::new();
    S.get_or_init(|| Mutex::new((false, String::new())))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    preparing: bool,
    ready: bool,
    last_msg: String,
}

/// 查询配音引擎状态(是否在下载 / 是否已就绪 / 最近进度)。
#[tauri::command]
pub fn dub_engine_status(state: State<Arc<AppState>>) -> EngineStatus {
    let (preparing, last_msg) = {
        let g = engine_state().lock().unwrap();
        (g.0, g.1.clone())
    };
    let ready = state.paths.data_dir.join(".dub_engine_ready").is_file();
    EngineStatus {
        preparing,
        ready,
        last_msg,
    }
}

/// 预下载 / 预热配音引擎(Demucs + voice-select 模型),让首次配音不再卡在下载。
/// 跑一次 `node cli.mjs --prepare-engine`(本地 uvx,带失速看门狗 + 无黑窗)。成功
/// 后落一个 sentinel 文件,设置页据此显示「已就绪」。一次只允许一个(与配音共用闸)。
#[tauri::command]
pub async fn dub_prepare_engine(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let cli = resolve_cli(&app).ok_or("找不到配音脚本(打包资源缺失)")?;
    let node = resolve_node(&app);
    let ffmpeg = resolve_ffbin(&app, "ffmpeg");
    let ffprobe = resolve_ffbin(&app, "ffprobe");
    let uvx = resolve_uvx(&app);
    if !bin_ok(&node) {
        return Err("缺 Node 运行时".into());
    }
    if !bin_ok(&uvx) {
        return Err("缺 uvx(下载引擎所需)".into());
    }

    // 防呆:已有配音或下载在跑则拒(共用 cancel_slot,一次一个 uvx 任务)。
    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    {
        let mut slot = cancel_slot().lock().unwrap();
        if slot.is_some() {
            return Err("已有配音/下载任务在进行中".into());
        }
        *slot = Some(cancel_tx);
    }
    {
        let mut g = engine_state().lock().unwrap();
        g.0 = true;
        g.1 = "正在准备配音引擎…".into();
    }
    let _ = app.emit("dub:engine", json!({"preparing": true, "msg": "正在准备配音引擎…"}));

    let mut cmd = tokio::process::Command::new(&node);
    cmd.arg(cli.to_string_lossy().to_string())
        .arg("--prepare-engine")
        .env("FFMPEG_PATH", &ffmpeg)
        .env("FFPROBE_PATH", &ffprobe)
        .env("DEMUCS_UVX", &uvx)
        .env(
            "DUB_ENV_PATH",
            state.paths.data_dir.join(".dub.env").to_string_lossy().to_string(),
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            *cancel_slot().lock().unwrap() = None;
            engine_state().lock().unwrap().0 = false;
            return Err(format!("启动失败:{}", e));
        }
    };
    let stdout = child.stdout.take().ok_or("无法读取 stdout")?;
    let stderr = child.stderr.take().ok_or("无法读取 stderr")?;
    let err_task = tokio::spawn(async move {
        let mut buf = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            buf.push_str(&l);
            buf.push('\n');
        }
        buf
    });

    let app_ev = app.clone();
    let mut reader = BufReader::new(stdout).lines();
    let mut ready = false;
    let mut cancelled = false;
    loop {
        tokio::select! {
            line = reader.next_line() => {
                match line {
                    Ok(Some(l)) => {
                        let t = l.trim();
                        if t == "ENGINE_READY=1" { ready = true; continue; }
                        if t.is_empty() { continue; }
                        engine_state().lock().unwrap().1 = t.to_string();
                        let _ = app_ev.emit("dub:engine", json!({"preparing": true, "msg": t}));
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
            _ = &mut cancel_rx => { cancelled = true; let _ = child.start_kill(); break; }
        }
    }
    let status = child.wait().await;
    let stderr_txt = err_task.await.unwrap_or_default();
    *cancel_slot().lock().unwrap() = None;
    engine_state().lock().unwrap().0 = false;

    if cancelled {
        engine_state().lock().unwrap().1 = "已取消".into();
        let _ = app.emit("dub:engine", json!({"preparing": false, "msg": "已取消", "cancelled": true}));
        return Err("已取消".into());
    }
    let ok = ready && status.map(|s| s.success()).unwrap_or(false);
    if ok {
        let _ = std::fs::write(state.paths.data_dir.join(".dub_engine_ready"), b"ready");
        engine_state().lock().unwrap().1 = "配音引擎已就绪".into();
        let _ = app.emit("dub:engine", json!({"preparing": false, "ready": true, "msg": "配音引擎已就绪"}));
        Ok(())
    } else {
        let msg = first_error_line(&stderr_txt).unwrap_or_else(|| "下载失败,可重试".into());
        engine_state().lock().unwrap().1 = format!("失败:{}", msg);
        let _ = app.emit("dub:engine", json!({"preparing": false, "ready": false, "msg": msg, "error": true}));
        Err(msg)
    }
}

/// 用系统默认程序打开文件(成片预览)。
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(&path).spawn();
    #[cfg(target_os = "windows")]
    let spawned = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", &path]);
        hide_window(&mut c); // don't flash a cmd window when opening the result
        c.spawn()
    };
    #[cfg(target_os = "linux")]
    let spawned = std::process::Command::new("xdg-open").arg(&path).spawn();
    spawned.map(|_| ()).map_err(|e| e.to_string())
}

/// 在文件管理器里定位文件(「在文件夹中显示」)。
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open")
        .args(["-R", &path])
        .spawn();
    #[cfg(target_os = "windows")]
    let spawned = std::process::Command::new("explorer")
        .arg(format!("/select,{}", path))
        .spawn();
    #[cfg(target_os = "linux")]
    let spawned = {
        let dir = Path::new(&path)
            .parent()
            .map(|d| d.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        std::process::Command::new("xdg-open").arg(dir).spawn()
    };
    spawned.map(|_| ()).map_err(|e| e.to_string())
}
