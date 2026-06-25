# WB Dub 接入说明 — 商家音视频素材的 EN→RU 配音

面向 **WB 主程序**集成:把这条配音工作流并入「上架素材处理」,对商家上传的产品视频做
**英语→俄语**配音(保留原说话人音色、保留背景音乐/音效),产出可直接上架的俄配成片。

- 代码位置:`tools/dub/`(纯 Node ESM,无 npm 依赖)
- 一个 **Aurixel** key 跑通全部三段付费调用:ASR(语音转写+时间戳+分轨)、翻译(gpt-5.5)、TTS 克隆(qwen3-tts-vc)
- 已在生产线 `conduit-api.aurixel.ai` 实测通过(单人 + 母女双人两种素材,见 README「Routing」节)

---

## 1. 在 WB 流程中的位置

```
商家上传产品视频(英文配音)
        │
        ▼
 [WB 上架素材处理] ──► 调用 WB-Dub ──► 俄配成片(同画面 + 俄语人声 + 原背景)
        │                                      │
        └──────────────► 入库 / 上架 Wildberries 商品卡
```

输入是商家的音视频文件,输出是一个**同等画面、俄语配音**的 mp4,可直接作为俄区商品视频。

---

## 2. 调用接口

### 方式 A:子进程(推荐,语言无关 — 适合 Rust/Tauri 主程序)

```bash
node tools/dub/cli.mjs <输入视频> --out <输出mp4> \
  --asr-provider aurixel --tts-provider aurixel-vc \
  --keywords "вафельница,завтрак,подарок" --tone "дружелюбный маркетинговый"
```

- **环境**:`PATH` 需含 `~/.local/node/bin` 与 `~/.local/bin`(node/ffmpeg/uvx);密钥从工作目录的 `.env.local` 读取(见 §4)。
- **退出码**:`0` = 成功;`1` = 失败(stderr 打印 `FAILED: <原因>`,并保留中间产物目录用于排查)。
- **成功判定**:退出码 0 **且** stdout 末尾有 `OUTPUT : <路径>`。
- **进度**:stdout 每阶段一行 `  [ok ] <stage>  <ms>ms` 或 `  [ERR] …`;WB 可按阶段名做进度条(阶段清单见 §6)。
- **产物**:`--out` 指定的 mp4。中间件在 `--work <dir>`(默认系统临时目录)下,成功后可删。

成片摘要(stdout 末尾,WB 可解析记录):
```
segments     : 27
speakers(cloned): speaker_0=qwen-tts-vc-…, speaker_1=qwen-tts-vc-…
video dur    : 93.203s
output dur   : 93.200s  (drift 0.003s)
asr/tts      : aurixel-asr / aurixel-tts-vc
OUTPUT       : /path/out.ru.mp4
```

### 方式 B:程序内调用(WB 主程序是 Node 时)

```js
import { loadConfig, assertSecrets } from './tools/dub/config.mjs';
import { runPipeline } from './tools/dub/pipeline.mjs';

const cfg = loadConfig({ overrides: { ASR_PROVIDER: 'aurixel', TTS_PROVIDER: 'aurixel-vc' } });
assertSecrets(cfg);                              // 缺密钥时抛出可读错误

const res = await runPipeline(cfg, {
  input: '/abs/merchant_video.mp4',
  out:   '/abs/merchant_video.ru.mp4',
  workDir: '/abs/scratch',                       // 可临时目录,完成后删
  mode: 'segment',
  dryRun: false,
  translate: { keywords: ['вафельница'], brand: '', tone: 'дружелюбный маркетинговый' },
  tts: {},                                       // 留空 = 每个说话人克隆自己的声音
  keepOriginalAudio: 0,                          // 0=完全替换;0..1=把原声压低垫在底下
  onEvent: (ev) => log(ev.stage, ev.ok, ev.ms, ev.warn || ev.error),
});
// res: { out, segments, speakers:[…], speakerVoiceMap:{spk:voiceId}, cloned:bool,
//        videoDur, outDur, drift, asrProvider, ttsProvider }
```

`runPipeline` 失败时 **throw**;请用 try/catch,并保留 `workDir` 供排查。

---

## 3. 输入 / 输出

| | 说明 |
|---|---|
| **输入** | 任何 ffmpeg 能解的音视频(mp4/mov/webm…)。源语言默认 **en**,可 `--src-lang`。需含**可懂的人声**。 |
| **输出** | 同画面 mp4,音轨 = **俄语人声**(克隆原说话人)+ **原背景音乐/音效**(Demucs 分离后回填,默认 `BG_VOLUME=0.8` 并对人声做 duck)。 |
| **画面** | 不改:视频流直接复用(`-c copy` 思路),只换音轨。 |
| **时长** | 与原片对齐到 ~±0.15s(双向等时 + 末端对齐 + verify 阶段核验 drift)。 |
| **多说话人** | 自动分轨,每人克隆各自音色;童声/极短说话人(<`MIN_CLONE_SEC`)回退到 distinct 预制音色。 |

---

## 4. 配置(密钥与开关)

**密钥**:工作目录 `.env.local`(已 gitignore,**禁止打印/提交**)。一个 key 即可:

```bash
AURIXEL_API_KEY=ck-…                              # 正式线 key
AURIXEL_BASE=https://conduit-api.aurixel.ai/v1    # 默认即生产线,可省
ASR_PROVIDER=aurixel
TTS_PROVIDER=aurixel-vc
```

`process.env` > `.env.local` > 默认值。WB 可用真实环境变量注入密钥(不落盘)。

WB 可能会调的开关(都有合理默认,一般不用动):

| 变量 / flag | 默认 | 作用 |
|---|---|---|
| `AURIXEL_SPEAKER_SENSITIVITY` | `0.3` | 分轨灵敏度,低=更少说话人(防把一个人切成两个) |
| `--keywords "a,b,c"` | 空 | 俄语关键词,翻译时尽量织入(SEO/卖点) |
| `--brand X` | 空 | 品牌名保持原文不译 |
| `--tone "…"` | 空 | 营销语气提示 |
| `--keep-original-audio 0..1` | `0` | 0=纯俄配;>0 把原英文声压低垫底 |
| `--no-background` | 关 | 关掉则不回填背景(纯人声) |
| `MIN_CLONE_SEC` | `2` | 低于此秒数的说话人不克隆、回退预制音色 |
| `RENDER_CANDIDATES` | `4` | 每句多合成几条择优(高=更稳但更慢/更贵) |
| `--dry-run` | — | 不发任何付费请求,仅验证接线 |

完整开关见 [README.md](README.md)「Key config」。`DUB_DEBUG=1` 打印**脱敏**配置(所有 `*_KEY` 已掩码)。

---

## 5. 运行环境依赖

| 依赖 | 用途 | 备注 |
|---|---|---|
| Node 18+ | 运行时 | 用全局 `fetch`/`FormData`;无 npm 依赖 |
| `ffmpeg` / `ffprobe` | 抽音/混音/封装 | 默认 `~/.local/bin`,可 `FFMPEG_PATH`/`FFPROBE_PATH` 覆盖 |
| `uvx`(uv) | 跑 Demucs(背景分离)+ resemblyzer(择优声纹) | 默认 `~/.local/bin`;**首次会下载模型**(几百 MB,之后缓存) |
| Aurixel 网关 | ASR/翻译/TTS | 外网可达 `conduit-api.aurixel.ai` |

**纯本地、无需 key 的阶段**:Demucs(背景分离)、resemblyzer(择优)——离线跑。
部署机建议预热一次(先跑一个样片),把 Demucs/resemblyzer 模型下好,避免首单超时。

---

## 6. 阶段、耗时、计费、缓存

阶段顺序(`onEvent` 的 `stage` 名,WB 可据此做进度):
```
extract → separate → asr → diarize-refine → translate → enroll(clone)
→ voice-select → iso-fit → tts+fit → assemble → gate-silence → mux → verify
```

- **耗时**:93s 视频在生产线约 **6–13 分钟**(瓶颈 = `separate` demucs ~20–40s + `tts+fit` 择优合成,与时长/句数成正比)。属**重任务**,务必异步队列处理,不要卡在上传请求里。
- **计费**(付费 = 走网关的调用):`asr`(1 次)+ `translate`/`diarize-refine`(gpt-5.5)+ `enroll`(每说话人 1 次)+ `voice-select`(≈ 句数 × `RENDER_CANDIDATES` 次 TTS 合成)。`tts+fit` 是大头。
- **缓存**:ASR 结果按 `视频size+mtime+provider+设置` 缓存于 `~/.cache/wb-dub/asr`,**同片重跑不重转写/不重计费**。其余阶段不缓存。
- **幂等**:同输入 + 同配置,结构性结果稳定(分轨/归属/对齐/漂移一致);仅合成 f0(±~15Hz,被 pitch-norm 锁在参考音高 ±10% 内,音色仍分得开)与翻译措辞(同义不同词)有界变化。重试安全。

---

## 7. 并发与规模

- 网关有限流。**不要无限并发**;建议主程序用**有界队列**(起步并发 2–4,按网关额度/实测调)。
- 每个任务还会起 ffmpeg + demucs(吃 CPU)+ resemblyzer;并发受 CPU 限制(择优内部并发已按 `cpu-2` 自适应)。
- 大批量上架建议:任务入库 → worker 池逐个/小并发跑 → 写回成片路径与摘要。

---

## 8. 失败模式与处理

| 情况 | 行为 | WB 侧处理 |
|---|---|---|
| 任一付费阶段网络/限流报错 | 已内置重试+退避;仍失败则整体 `FAILED`、退出码 1 | 入重试队列;`workDir` 留存供排查 |
| 网关 STT 退化为纯文本(无时间戳) | `asr` 阶段抛错(明确提示) | 切 `ASR_PROVIDER=whisper`(本地离线)或直连 speechmatics 兜底 |
| 视频无可懂人声 | `asr` 无 segment → 失败 | 视为不可配音,跳过/人工 |
| 童声/极短说话人 | 自动回退预制音色(非报错) | 正常,成片可用 |
| `verify` 漂移略大 | 仅 WARN,不失败 | 记录即可(实测 drift ≤ 0.15s) |
| 缺密钥 | `assertSecrets`/启动即报缺哪个 key | 配 `.env.local` |

**降级链**:网关不可用时,ASR 可切 `whisper`(本地)、TTS 可切 `qwen-vc`(直连 DashScope,需另一个 key)。provider 是配置驱动的,切换无需改码(见 `factory.mjs`)。

---

## 9. 质量与稳定性特征

- **结构性决策稳定**:分轨人数、各句说话人归属、克隆参考窗、时序对齐、时长漂移——同片多次跑一致(测试线 vs 生产线逐项一致)。
- **有界随机**:Qwen 合成 f0 逐次有 ±~40Hz 抖动,经 **voice-select(best-of-K 声纹择优)+ pitch-norm(锚定参考音高)** 收敛;母女等多说话人**音色始终分得开**。
- **跨语种口音**:英文说话人→俄语带轻微口音(克隆固有);情绪化结尾的表现力是 Qwen 克隆天花板。
- 详细原理见 [README.md](README.md)「Why it stays consistent」。

---

## 10. 安全

- 密钥只放 `.env.local`(gitignore)或真实环境变量;**任何日志/产物/异常都不得打印 key**(`DUB_DEBUG` 已全量脱敏)。
- 商家素材属敏感数据:`workDir` 中间件(分离音轨、克隆样本、各句 wav)用完即删;成片按 WB 数据策略存储。
- 每次 enroll 会在网关生成一个持久自定义音色 id,长期批量跑会堆积,需要的话按网关侧清理策略定期清。

---

## 11. 接入自检清单

- [ ] 部署机:Node 18+ / ffmpeg / ffprobe / uvx 就位,`PATH` 含 `~/.local/{node/bin,bin}`
- [ ] `.env.local`:`AURIXEL_API_KEY` + `ASR_PROVIDER=aurixel` + `TTS_PROVIDER=aurixel-vc`
- [ ] 预热:跑一遍 `--dry-run`(零付费,验接线)再跑一个真样片(下好 demucs/resemblyzer 模型)
- [ ] 主程序:有界并发队列 + 异步;按退出码/`OUTPUT` 行判成败;失败入重试、留 `workDir`
- [ ] 监控:记录每片耗时/句数/drift/成败;网关限流时退避
- [ ] 安全:不打印 key;中间件用后即删
