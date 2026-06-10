# WB AutoList · Wildberries 商品自动化上架工作流

输入「商品名 + 关键字」→ AI 自动生成**主图 + 细节图 + 宣传图** + 俄文 listing 文案 → **一键上架到 Wildberries**。

一个**自托管单机/内网工具**（Next.js）：完整 UI、设置页、上架状态实时追踪、历史记录。核心链路已在 WB **沙盒**端到端验证；面向真实卖家的生产商用尚需安全/可靠性/生产正确性加固（见下方「安全与定位」）。

## 特性

- 🪄 **一键生成**：商品名 + 关键字 → AI 文生图（主图/细节图）+ sharp 合成宣传图（标题/价签/角标）+ 俄文 SEO 文案（标题/描述/卖点/关键词/类目）。
- 🚀 **真实上架**：对接 Wildberries Content/Prices API，自动完成 解析类目 → 填充必填特征 → 建卡 → 轮询 nmID → 上传图片 → 定价 全流程。
- 📡 **实时进度**：上架过程通过 SSE 流式回传，每一步可见。
- 🧪 **演示模式**：未配置 Token 时自动进入 dry-run，完整跑通流程并生成图片（不真实上架），便于先体验。
- 🔌 **可插拔文生图**：Aurixel gpt-image-2（推荐）/ Pollinations（免 Key）/ OpenAI gpt-image-1。任意 OpenAI 兼容网关均可接入。
- 🔐 **密钥服务端保存**：Token 存于 `data/config.json`，前端只见掩码。

## 快速开始

```bash
npm install
npm run dev
# 打开 http://localhost:3000
```

首次无需任何 Key 即可在**演示模式**下跑通：输入商品名 → 一键生成 → 演示上架。

## 切换真上架

1. 在 WB 卖家后台「设置 → 访问 API」生成 Token，勾选 **Контент** 与 **Цены и скидки** 两个范围（非只读）。
2. 打开应用「设置」页，粘贴 Token 保存。
3. 回工作台，点击「一键上架到 Wildberries」。

> Token 是 JWT，**180 天**过期；创建时仅显示一次，请妥善保存。

## 配置项（设置页或 `.env.local`）

| 键 | 说明 |
|---|---|
| `WB_CONTENT_TOKEN` | WB 内容 API Token（真上架必填） |
| `WB_PRICES_TOKEN` | WB 价格 Token（留空则复用内容 Token） |
| `WB_SANDBOX` | `true` 走沙盒环境（测试 Token 必须开启），设置页亦有开关 |
| `IMAGE_PROVIDER` | `aurixel`（推荐）/ `pollinations`（免 key）/ `openai` |
| `AURIXEL_API_KEY` | Aurixel gpt-image-2 网关 Key（`ck_...`），OpenAI 兼容 |
| `OPENAI_API_KEY` | 选用 OpenAI 文生图时填写 |
| `AURIXEL_CHAT_MODEL` | 文案模型（默认 `gpt-5.5`，亦可 `claude-opus-4-8` 等，走同一 Aurixel Key） |
| `PUBLIC_BASE_URL` | 部署后填，供 WB 拉取图片（本地用字节直传，可不填） |
| `APP_PASSWORD` | 访问密码：设置后全站需 HTTP Basic Auth。**公网部署必填** |

## 安全与定位

- **密钥**：通过环境变量(`.env.local`/部署平台 secret)注入，不要提交、不要随交付目录分发。`data/config.json` 仅存非密钥偏好。
- **访问控制**：设 `APP_PASSWORD` 后全站(页面+API)需 Basic Auth；未设时**仅可用于本机 localhost**，切勿公网裸跑。
- **部署形态**：当前架构（进程内限流闸门 + 本地文件存储 + 长任务）**仅支持单进程长驻**（VPS/Docker `next start`），**不兼容 serverless/多实例**。
- **定位**：沙盒已验证；真实生产上架仍需补必填特征/TNVED/尺寸的生产实测、失败断点续传、实拍图/人工确认等（详见交付评估）。

## 桌面应用（发给卖家）

打包成 Electron 桌面端：每个卖家本机运行、数据隔离、在「设置」页填自己的 WB token 与 AI key（**不打包任何密钥**），无需服务器。

```bash
npm run dist:mac      # 在 Mac 上构建 .dmg（输出到 dist-desktop/）
```

- **数据**：写入用户数据区 `~/Library/Application Support/wb-autolist/data`（Win: `%APPDATA%\wb-autolist\data`），随应用升级保留。
- **Windows 版**：**不能在 Mac 上可靠交叉编译**（原生 `sharp` + 签名）。已配 [GitHub Actions](.github/workflows/desktop-build.yml)——推 `v*` tag 或手动触发，在 `windows-latest` / `macos-latest` 上自动产出 `.exe` / `.dmg`。
- **代码签名**：未签名的包在 Mac 需右键打开、在 Win 会被 SmartScreen 警告。正式分发需：Apple 开发者账号（mac 签名+公证）/ Windows 代码签名证书 —— 接入 CI 的 `CSC_*` / `WIN_CSC_*` secrets 即可。
- 当前已验证：**macOS arm64**（Apple Silicon）。Intel Mac / 其它架构可在 CI 增加对应 runner。

## 技术栈

Next.js 14 (App Router) · TypeScript · Tailwind · sharp（宣传图合成）· Aurixel OpenAI 兼容网关（文生图 + 文案）。

## 工作原理

完整 API 对接细节见 [docs/WB_API_SPEC.md](docs/WB_API_SPEC.md)。关键流程：

```
商品名+关键字
  → 文案(Claude/模板) + 文生图(Pollinations/OpenAI) + 宣传图(sharp)
  → [WB] 解析 subjectID → 取必填特征/TNVED → 建卡(顶层数组,异步)
  → 轮询 get/cards/list 拿 nmID → media/file 逐张传图 → upload/task 定价
  → 上架完成
```

## 目录

```
src/
  app/            页面 + API 路由
  components/     UI 组件
  lib/
    ai/           文生图、宣传图合成、文案
    wb/           Wildberries API 客户端 + 上架流水线
    config / store / generate
docs/WB_API_SPEC.md   WB API 实现规范
```

## 说明

- 必填特征采用启发式填充（颜色/TNVED/数值等），上架后可在 WB 后台微调。
- WB 建卡与定价均为异步：`200` 仅代表入队，应用会轮询确认 `nmID` 与价格任务状态。
- 速率限制：Content ~100/min、建卡 ~10/min、Prices 10次/6s —— 客户端内置退避重试。
