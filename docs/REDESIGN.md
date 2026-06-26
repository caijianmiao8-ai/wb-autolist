# WB AutoList 去技术化重构 · 实现规格(留档)

> 客户(中文卖家)反馈现有 app「过于技术化」。本文件是**定稿 UI + 实现规格**,
> 跨上下文/会话续作的唯一真源。改设计先改本文件。草图已用 visualize 工具逐屏向
> 客户确认通过。**实现必须照本文件的版式重画,不是在旧版式上塞功能。**

## 0. 当前构建状态(2026-06-25)

分支 `feat/tauri-rust`。已提交:`e73e924`(地基) `fe93ac4`/`fb54e7a`(单品功能) `ec2772b`(设置起步)。

| 屏 | 功能 | 版式(照草图重画) |
|---|---|---|
| 初次设置向导 | ✅ | ✅ 已照草图 |
| 单品上架(工作台) | ✅ | ✅ **已彻底重画**(控制台/预览·一屏不滚·实时预览) |
| 商品管理 | ✅ | ✅ **已重画**(人话状态·单刷新+分域折叠·强下架确认·详情折叠·限流人话·沙盒死链置灰) |
| 上架记录 | ✅ | ✅ **已重画**(草稿箱「继续编辑发布」+只读发布历史·人话状态/报错·详情折叠·搜索) |
| 设置 | ✅ | ✅ **已重画**(EnvBadge·运行环境段·已连接折叠「修改」·常用/高级分层·粘性保存·显示密钥) |
| 批量上架 | ✅ | ✅ **已重画**(双区一屏·EnvBadge·行校验红框·去重就绪计数·粘性入队·完成→去草稿箱) |
| 全局环境徽标 | ✅ EnvBadge/EnvBanner | ✅ 全部 5 屏统一接入 |

> **2026-06-25 全前端重画完成**:6 屏(向导 + 工作台 + 商品管理 + 上架记录 + 设置 + 批量)全部从零重画到统一的「固定高框架 + 一屏不滚 + EnvBadge + 去技术化」模型;每屏 `tsc` 通过、preview 工具按 1280×800 验过整页不滚。后端逻辑全继承未动。**延后(需新后端)**:批量「关联素材文件夹」匹配 + 专门的双语审核网格(现走「上架记录 › 草稿箱」审核);发布页「全部 WB 特征/变体/TNVED 逐条编辑」。

**根因记录 + 解法(已落地于工作台)**:之前一直"旧版式 + 加功能 / 微调",未真正重画,所以总不一眼就懂、还滚页。**解法 = 从零重写组件树,不在旧骨架上改**:
1. **AppShell 改固定高框架**:`flex h-screen overflow-hidden`,EnvBanner+Nav 钉住,只有 `<main>`(`min-h-0 flex-1 overflow-y-auto`)滚。整窗不滚页。旧屏(manage/history/settings/batch)未重画也不破——它们仍在 `<main>` 内滚动,跟以前一样。
2. **每屏 = 控制台/预览 两区模型**(工作台示范):左 = 输入/摘要 + **粘性底部 CTA**(主操作永远可见);右 = **实时预览/结果**(绝不留空)。`grid min-h-0 flex-1` 填满剩余高,两列各自 `overflow-y-auto` 内部滚——**编辑不滚页**。
3. **必须照真实桌面宽度验收**(根因:之前照 680px mockup 工具做,从没在窗口宽度看过)。标准见 §8「preview 工具验收法」。
工作台文件:`Workbench.tsx`(InputForm/ProductSummary/PrimaryAction/LivePreview + StepBar/Images/Copy/Video/Progress)、`AppShell.tsx`。其余屏一律照此重画。

## 1. 原则(每屏都遵守)

1. **去技术化**:界面不出现 nmID/vendorCode/JWT/provider/限流/缓存/dryRun/特征数 等术语(收进「详情」折叠或改人话)。
2. **简单默认 + 渐进展开**:普通卖家一路点完;精细参数默认折叠,「高级」一键全拿到。
3. **内容双语**:AI 出俄语(发布用)+ 中文对照(只读参考,**绝不发 WB**)。界面语言保持**中文**(非俄化)。
4. **防呆分级**:危险/不可逆/影响真店的操作 → 强确认(命名环境 + 后果 + 恢复方式);普通操作不打扰。确认强度按"是否影响真实店铺/不可逆"分级,不能随机。
5. **统一反馈**:内联 toast + 统一危险确认弹窗(别混用原生 alert/confirm 与 toast)。

## 2. 卖家词表(统一替换,全屏一致)

| 技术词 | 卖家语言 |
|---|---|
| nmID / vendorCode / barcode / imtID | 默认隐藏,只在「详情 ▾」里 |
| 特征数 / характеристики | 「商品参数」 |
| 划线价 | 「原价」(同时显示「到手价」) |
| 价格域限流 / 冷却 / 429 | 「Wildberries 限制改价频率,约 N 秒后可再改」 |
| 同步(分域:商品/库存/价格) | 一个「刷新」(内部分域调度);分域收进高级 |
| 本地缓存(秒开、不限流) | 不展示;副标题放任务概览 |
| dryRun / 演示 / 沙盒 | 「测试发布(不会上线真实店铺)」;三态见 §3 |
| price_unknown / no_price | 「待定价」 |
| ok / live | 「可售」/「待选仓库」按实际 |
| rejected | 「被驳回」+ 原因人话 |
| 402(图额度) | 「免费额度用完会自动用占位图,不影响上架」 |
| JWT / content-api-sandbox / gpt-image-2 / Маркетплейс | 卖家语言改写;细节收进高级 |
| WB 报错原文(英文/JSON) | 归一为人话(如"新卡需先过 WB 审核才能定价,通常 24h 内"),原文进「详情」 |

## 3. 全局三态环境徽标(共享组件,最先做)

- 三态:**演示**(无 WB token,dryRun) / **沙盒**(测试店) / **正式**(真实店)。
  - 演示 = 灰(slate);沙盒 = 琥珀(amber);正式 = 玫红(rose)。
- **正式环境**:全局顶栏(Nav 下)常驻红色横幅「正式环境:所有操作作用于真实店铺」。
- 抽成一个组件(如 `EnvBadge` + `EnvBanner`),**所有屏文案逐字一致**。当前各屏口径不一(ManagePanel 两态、工作台/批量三态、设置不显示)——必须统一。
- 数据来源:`getSettings()` → `dryRun`(演示)/`wbSandbox`(沙盒 vs 正式)。

## 4. 各屏定稿规格

### 4.1 初次设置向导(✅ 已做)
- 首启检测「无 Aurixel key 且无 WB token」→ 全屏 4 步;设置页「重新运行向导」可重弹(`AppShell` 读 localStorage `wb:rerunSetup`)。
- 步骤:① 欢迎 ② 连 Aurixel(粘 key + 测连接显模型数 + 去充值链接)③ 连 WB(token + 沙盒/正式 + 测连接,绿勾才下一步;返回仓库)④ 默认仓库 + 包裹尺寸/重量 → 完成存配置。
- 文件:`AppShell.tsx`(网关)、`SetupWizard.tsx`;命令 `test_aurixel`/`test_wb`(返回 `ConnTest{ok,detail,warehouses}`)。

### 4.2 单品上架(工作台)→ 重排成 3 步
布局:顶部环境徽标。流程「输入 → 生成 → 预览 → 发布」,左输入卡 + 右预览/进度(或步进式皆可,关键是清爽)。
- **输入(只露 4 类)**:商品名* / 关键词 / 售价(到手价 ₽) / **两个独立上传框:参考产品图、英文产品视频**。一个「一键生成」。其余(品牌/包裹/提示词/图片数量/先出主图)进**「高级选项」折叠**(已实现折叠,版式待重排)。
- **生成**:点「一键生成」→ AI 图文 + (若上传了视频)配俄语**并行**;一次确认覆盖花费(消耗 Aurixel)。
- **预览**:图片网格(可单张重生成)+ 文案(**俄/中/双语**切换,可编辑)+ **视频位**(英文→「配成俄语」→ 配音中→✓ 俄配,可重配)。类目显示为可改小标签。
- **发布**:默认清爽一屏确认(售价/到手价、库存、仓库、包裹[默认]、类目、媒体[含俄配 ✓]、环境徽标)。底部「**高级 · 全部商品参数**」可展开:见 §5 后端支撑(**逐条特征/变体/TNVED 编辑需新后端,标为延后**;先做 类目/包裹/品牌/价格折扣 覆盖)。
- 已具备的后端/能力:`generate`(返回含 zh 的 copy)、`regenerate_image`/`generate_rest`、`dub_preflight`/`dub_start`/`set_listing_video`、`publish`(自动传 video_ru)、`update_copy`。
- 现状:功能在 `Workbench.tsx`(CopyPanel 双语、VideoPanel 配音、输入折叠);**版式待重排到草图三步**。

### 4.3 商品管理(ManagePanel)→ 重画
- 顶部:标题 + **环境徽标** + 单个「刷新」(内部分域)+「当前仓库:XX ▾」+ 任务概览副标题(共 N 商品 · X 可售 / Y 待处理 · 上次更新…)。
- 卡片列表/网格,每卡:缩略图 + 标题(可俄/中)+ **人话状态**(可售/待定价[+"新卡需过审 24h"]/待选仓库/已下架/被驳回)+ 原价→到手价 + 库存 + 操作(改价/库存/下架/删除)+「详情 ▾」(nmID/vendor/特征收这里)。
- **强下架确认**(必修):命名环境 +「会从{沙盒/真实}店铺下架,买家无法搜索/购买」+「补货后需重设库存恢复」。改价/删卡确认同级。
- 价格限流:按钮置灰时旁注「WB 限制改价频率,约 N 秒后可再改」。
- 改价/改库存后:该卡标「待确认(约 1 分钟生效)」+「刷新这张卡」。
- 沙盒卡「查看商品页」死链 → 置灰 + tooltip。
- 后端齐备:`db_list_cards`/`sync_*`/`set_card_price`/`set_card_stock`/`trash_cards`/`warehouse_allows`。

### 4.4 上架记录(HistoryList)→ 重画
- **拆两段**:①「草稿箱」(未发布,每条「继续编辑发布」带 listing id 回单品预览;可删)②「发布历史」(只读追溯)。
- 历史项:状态(已上架/测试发布/失败)。已上架 → 「查看」+「去商品管理」(写操作只在商品管理);失败 → 一个「重新发布」(内部自动决定补图/定价);测试发布 → 注「不会上线真店」。
- 隐藏 nmID/vendorCode/dryRun/sandbox 原始字段(进详情)。失败原文归一人话 + 详情可展开。
- 可选:状态筛选 chips + 搜索;空状态 CTA 指「单品上架」「批量导入」。
- 后端:`list_listings`/`get_listing`/`retry_pricing`/`trash_card`;草稿续作复用 `Workbench`(用 listing id 进预览)。

### 4.5 设置(SettingsForm)→ 重画
- 顶部:**当前模式三态徽标** +「账号与默认值已在向导配置,此处查看/修改」+「重新运行向导」(✅ 已加)。
- **常用**:运行环境(演示/沙盒/正式,切正式二次确认[✅]+正式顶栏横幅)、WB 店铺(✓已连接+有效期+续期)、Aurixel(✓已连接+余额+充值/修改)、默认仓库。已配置项默认折叠显示当前值,点「修改」才展开。
- **高级(默认折叠)**:配图引擎 provider、新品默认库存策略(默认留空/保守,文案"可在商品管理逐个补")、默认包裹尺寸、价格用单独 Token(默认关)、密钥显示/隐藏眼睛。
- 库存设置唯一日常入口锁定「商品管理」;设置页只留保守默认策略。
- 后端:`get_settings`(RedactedConfig)/`save_settings`(patch)/`list_warehouses`。

### 4.6 批量上架(BatchPanel)→ 重画(最大,放最后)
- **4 步**:① 导入 ② 生成草稿 ③ 审核(双语网格)④ 发布。
- **导入**:Excel(列随意 AI 认,`import_excel`)/手填 +「**关联素材文件夹**」(图片夹 + 视频夹)。匹配规则:**文件名列优先,没列按「商品名/货号 = 文件名」自动猜**(两种都支持)。每行校验,缺必填(商品名/售价)标红、不进生成。
- **生成草稿**:估算(N 商品 · X 图 · Y 视频配俄语 · 预计耗时 · Aurixel 花费 · 环境)→ 确认 → 并发跑(图文+配俄语),进度+可暂停。**只草稿,不盲发**(保留「生成后直接发布跳过审核」开关但默认关)。
- **审核(双语网格)**:卡片网格,每卡 主图+俄/中标题+价+状态(就绪/待修/失败)+视频角标。顶部「俄/中/双语」全局切。失败/待修点进**单品编辑器**就地修。勾选要发的(全选就绪)。
- **发布**:发布选中 N 张 → 确认(环境 + 花费 + **WB 定价限流提示:≈1 张/分钟,N 张约 X 分钟**)→ 队列发,出 nmID/失败原因,失败可重试。**幂等不重发**(已有 resume/in-flight 锁)。
- 后端:`import_excel`/`enqueue_jobs`/`list_jobs`/`clear_jobs` + queue worker;素材文件夹匹配 + 草稿网格状态需新增前端逻辑(+ 可能一个列目录的命令)。

## 5. 后端支撑 & 延后项
- 现有命令足够支撑 §4.2–4.5 的**功能**(见各屏「后端」行)。
- **延后(需新后端,先不做,做前先确认)**:
  - 发布页「**全部 WB 特征/尺码颜色变体/TNVED 逐条编辑**」—— 现流水线自动定类目+特征,无逐条编辑读写;要做需新增 WB 特征字典读取 + 卡片特征写入。先做 类目/包裹/品牌/价格 覆盖即可。
  - 批量「关联素材文件夹」可能需要一个「列目录文件名」的 Rust 命令(或前端用 dialog 选多文件)。

## 6. 主题 & 复用
- 强调色渐变 `#CB11AB → #7F3FBF`(`wb-pink`/`wb-purple`);浅色 slate 面;`globals.css` 组件类:`.card`/`.btn-primary`/`.btn-ghost`/`.input`/`.label`/`.chip`/`.inset`/`.hairline`/`.animate-fade-up`。
- 复用模式:`listen()` 事件桥(generate:progress/publish:progress/dub:progress)、`window.confirm` 危险确认、`api`(`src/lib/api.ts`)统一 invoke 包装。
- 图标:lucide-react。

## 7. 构建顺序(建议,逐屏照草图重画、各自提交验证)
1. **全局环境徽标 + 顶栏横幅**(共享,先做,别屏复用)。
2. **单品工作台**重排成 3 步(功能已有,纯版式重排 + 接环境徽标 + 类目可改小标签)。
3. **商品管理**重画(人话状态 + 强下架确认 + 详情折叠 + 单刷新)。
4. **上架记录**重画(草稿箱 + 只读历史)。
5. **设置**重画(常用/高级分层 + 向导已设此处管理)。
6. **批量**重画(导入素材匹配 + 草稿 + 双语审核网格 + 勾选发布)。
> 单品功能已就绪所以排前面(低风险);批量最大放最后。每屏 = 一个可提交、可验证的增量。

## 8.5 草图保真审计 + 1:1 还原计划(2026-06-25,客户要求 1:1)

**真源**:已批准草图全部恢复到 `docs/mockups/*.html`(从会话 transcript 提取)。**逐屏照这些 HTML 还原**,不再凭文字规格/记忆。
**审计结论(6 屏对照)**:向导=高;工作台/商品管理/上架记录/设置=中;批量=低。即之前是「照文字规格搭」,非「对草图还原」,结构性走样。
**客户决定:全部还原 UI + 补齐 4 个后端功能。**

### Phase 1 — 纯 UI 照草图改(无需后端)
- **工作台**:加 step3「发布复核卡」(售价/到手·库存数量·发货仓库·包裹·类目·媒体[✓俄配]·环境,逐行 ✎改;底「确认上架」)+ 视频卡从左 ProductSummary 挪到**右侧媒体区**(图下)+「视频去向」①上传②配俄语③预览④随卡上架 四步图 + StepBar 可点切换 + 改一键生成副文案(别暗示自动配)。〔库存/仓库行 + 全参数 fold = Phase 2〕
- **商品管理**:卡片动作(改价/库存/下架)**直接外露**(非藏「管理▾」抽屉)+「详情▾」放 nmID/货号/barcode/特征数 + **内联红色强确认卡**替掉 window.confirm(下架/改价/删除)+ 库存挪到价格旁内联 + 仓库做成「当前仓库:X ▾」按钮样式。
- **上架记录**:改成 **Tab 切换**「草稿箱·N / 发布历史·N」(非竖排)+ 发布历史内「全部 / 失败 N」筛选 chip + 俄文标题下加**中文副标题**(用 listing.copy.titleZh)+ 信息克制。
- **设置**:运行环境 **三态**(演示/沙盒/正式 分段)+ 默认仓库挪进**高级** + 常用区做成**单卡分组列表**(运行环境/店铺/Aurixel 三条 row)+ 默认库存改「**留空更稳**」取向 + Aurixel 行加「充值」按钮。
- **向导**:加顶部「⚡ WB AutoList · 初次设置」标题栏 + 占位示例值。

### Phase 2 — 4 个后端功能(草图核心,需新 Rust)
1. **批量双语审核网格 + 关联素材文件夹**:列目录命令(Rust)+ 按 商品名/货号=文件名 匹配图/视频 + 4 步向导(导入→生成草稿→双语网格审核[勾选/修正/重试]→选择性发布[显 nmID/限流条])+ 全程视频配俄语角标。job↔listing 关联。
2. **发布页全部商品参数**:WB 特征字典读(按类目取 характеристики 列表)+ 卡片特征/尺码颜色变体/TNVED 写入;接到工作台 step3「高级·全部商品参数」fold + 库存数量/发货仓库行(publish 需加参数)。
3. **视频台词时间轴 + 导出 SRT**:dub cli.mjs 输出逐句俄/中时间码 → 后端捕获 + 命令 → 预览「台词对照」区 +「导出 .srt」。
4. **Aurixel 余额**:查余额接口(conduit-api 是否有 /credits 或 /dashboard/billing,需调研)→ 命令 → 设置/向导显示「余额 $X」+ 充值。

### 不照草图(必要的正确性/稳健性偏差,保留)
- 🔴 **向导权限**:草图写「只读」是**错的**——只读 Token 无法上架。保留「内容+营销(非只读)」。
- EnvBadge 动态三态(草图批量写死「沙盒」)、正式店铺红色告警、空/加载/错误态、设置底部常驻保存 —— 均保留。

### 进度
- [x] P1 商品管理(动作外露+内联强下架卡+详情barcode+当前仓库按钮+去分域) [x] P1 上架记录(Tab+失败筛选+中文副标题) [x] P1 设置(三态环境+常用单卡行列表+仓库进高级+库存留空+充值) [x] P1 向导(品牌标题栏)
- [~] P1 工作台:副文案已修;**发布复核卡 + 视频卡归位右侧 + 可点步骤** 并入 P2(与 stock/warehouse/参数后端一起做,避免改两遍)
- [x] P2 批量网格+素材:**已做** 4 步向导(导入+关联素材文件夹→生成草稿→双语审核网格[勾选/修正/重试]→选择性串行发布[显nmID/限流]);后端新增 list_job_listings/pick_folder/list_media_files/read_file_b64(std::fs+dialog,无新依赖);ListingInput 加 basePhotos;**图片素材匹配已通**,批量视频→俄配暂在单品做(已在 UI 注明,后续可接 queue dub)
- [~] P2 发布全参数(**进行中,客户选先做这个**)。视频字幕=客户定**先不做**。实施计划(v1):
  - [x] **后端读命令已做**:commands.rs `search_subjects`/`subject_characteristics`/`wb_colors`/`wb_tnved`(暴露 categories.rs 现成函数);wb/types.rs 给 WbSubject/WbCharacteristic/WbColor 加 Serialize;lib.rs 注册;api.ts + types.ts 已加封装与类型(WbSubject/WbCharacteristic/WbColor)。cargo+tsc 通过。
  - [x] **工作台发布复核 step 已做**:新增 review step(预览→发布复核→上架);ReviewCard 复核卡(售价/到手/包裹/类目/媒体[含俄配✓]/上架环境)+ 视频卡归位到预览右侧媒体区 + StepBar 可点切换(预览↔发布)+ 「确认上架」/「返回预览修改」。tsc 通过。
  - [x] **全部商品参数编辑器 + pipeline 已做**:ReviewCard 内「高级·全部商品参数」fold(默认折叠):类目可改(searchSubjects 搜索切换)+ 特征逐项编辑(subjectCharacteristics,必填*标注,charcType 4=数字输入,цвет→wbColors 下拉)+ TNVED(wbTnved 预填)。Listing 加 characteristics/tnved;update_params 命令;pipeline.rs 改为「用户 subject/characteristics/tnved 优先,空则 AI 兜底」(opt-in,真实发布路径不受影响);generate.rs literal 补字段。cargo+tsc 通过。
  - 仍延后:尺码×颜色多变体(多 barcode,触及单 sku)。
  - ✅ **发布全参数 v1 完成**(类目/特征/颜色/TNVED 可编辑并生效)。
  - 类目/特征**提前到生成后**:工作台 step3 复核里调 search/resolve 显示类目(可改),get_characteristics 拉清单,AI 预填值(沿用 build_characteristics 逻辑)显示成可编辑项。多数特征=自由输入(text/number 按 charcType),цвет=wb_colors 下拉,TNVED=wb_tnved 下拉/输入。
  - Listing 持久化(types.rs 已有 subjectId/subjectName):加 `characteristics: Vec<{id,value}>`、`tnved`。pipeline.rs:308 payload 改「用户确认值优先,AI 兜底」。
  - **v1 范围**:特征 + 颜色 + TNVED + 单一规格(变体保留「单一规格」+「加尺码/颜色」按钮但置灰/标后续)。**多尺码×颜色变体(多barcode)= 延后**(触及 Listing 单 sku 假设、marketplace/prices/resume 幂等)。
  - 同时补 P1 遗留的工作台:发布复核卡(售价/到手/库存/仓库/包裹/类目/媒体/环境 逐行✎改)+ 视频卡归位右侧媒体区 + StepBar 可点。
  - 风险:charcs 可选值形态(自由输入 vs 字典)——多数自由输入,少数走 /directory/{name};先按自由输入+已知 colors/tnved 下拉做,后续可细化。
- [ ] P2 视频SRT:segments 已在管线(segments_src.json EN/segments_ru.json RU),需 pipeline 输出 sidecar+cli 打印 SEGMENTS_FILE+dub.rs 捕获+前端台词区/导出;**中文台词需多一次 gpt-5.5 翻译(付费),动手前确认**
- [x] P2 Aurixel余额:**已做**。实测 endpoint = `GET https://conduit-api.aurixel.ai/v1/balance`(Bearer key)→ `{cash_balance_usd, cash_balance_rmb, token_balance}`。后端 `aurixel_balance` 命令 + AurixelBalance{usd,rmb};api.ts aurixelBalance;设置 Aurixel 行显示「余额 ¥X ($Y)」(已配 key 时拉)。cargo+tsc 通过。
> recon 全文留档:tasks/wkmewmis3.output(4 功能后端落点)。
> 验证法:每屏 tsc 通过 + preview 1280×800 不滚页。卡片/数据相关项在 .app 用真数据终验。

## 8. 验证 & 打包(每屏完成必做)
- **preview 工具验收法(关键 — 照真实桌面宽度看,别再只信 .app/computer-use)**:
  1. `.claude/launch.json` 已配 `wb-autolist`(绝对 node 路径跑 `next dev -p 3100`)。`preview_start` name=`wb-autolist`(端口被占会拒,先 `lsof -ti:3100|xargs kill -9`)。
  2. `preview_resize` 显式 1280×800(别用 preset,native 会缩放;首张截图可能"挤在左上"是渲染时序,重截即可)。
  3. **几何为准,截图为辅**:`preview_eval` 量 `document.scrollingElement.scrollHeight===clientHeight`(整页不滚)、各列 `overflow-y-auto` 内部滚;`preview_inspect` 看精确样式。`preview_fill` 验交互(如填商品名→右侧实时预览跟着变)。`preview_resize colorScheme`/`data-theme=dark` 验暗色。
  4. 浏览器里 Tauri `invoke` 必失败("N errors" toast 正常)——只验版式/交互;真数据用 .app。
- `npx tsc --noEmit` + `npm run fe:build`(改 `.next`/路由后先 `rm -rf .next out`)。
- 测试 .app:`npm run tauri -- build --debug` → `target/debug/bundle/macos/WB AutoList.app`(dmg 步偶发 hdiutil 失败,.app 已签可用)。
- **GUI 测试坑(重要)**:① 打开前先 `pkill -9 -f "WB AutoList.app/Contents/MacOS"` 杀掉旧实例,否则 `open` 只切到旧版不换新代码;② `open "<.app 全路径>"`(绕开旧 dist-desktop 的 LaunchServices 残留)。③ 新签名首启会弹钥匙串授权,用户点「始终允许」。④ 本机已种 Aurixel key,向导不自动弹 → 用 设置→重新运行向导。⑤ App 数据目录 `~/Library/Application Support/com.wbautolist.app/data`。⑥ computer-use 在本机 1080p 屏截图发 stale、命中检测错位 → 别自动点 GUI,让用户点。
- node/cargo 路径见 `memory/node-binary-location`(node 在 ~/.local/node/bin,不在 PATH)。
