# Wildberries 自动上架 —— API 实现规范（调研 + 沙盒实测）

> 本文件是上架流水线的事实依据。端点/字段名经过调研、对抗校验，并已在**真实沙盒环境实测通过**（nmID=330643 建卡+3图+定价全成功）。casing 与实测纠正点已标注。

## ⚡ 沙盒实测纠正（比旧文档更准，务必遵守）

1. **沙盒 host = 生产 host 把 `-api.wildberries.ru` 换成 `-api-sandbox.wildberries.ru`**：
   `content-api-sandbox.wildberries.ru`、`discounts-prices-api-sandbox.wildberries.ru`。测试 Token(`"t":true`)只能用沙盒 host，用生产 host 返回 401。
2. **无尺码商品（безразмерный，如耳机）禁止传 `techSize`/`wbSize`**。旧文档说单尺码用 `"0"/"0"` —— 实测被拒：「Недопустимо указывать Размер... для безразмерного товара」。正确做法：`sizes:[{price, skus}]`，不带 techSize/wbSize。
3. **`cards/error/list` 真实结构是 `{data:{items:[{vendorCodes:[...], errors:{<vendorCode>:[msg]}, subjects:{...}}]}}`**，不是 `{data:[...]}`。按 `data.items[].errors[vendorCode]` 取错误。
4. 新 Token 权限用 `acc`/`ent` 编码（旧的 `s` 位掩码已废，实测 `s:0`）。建卡异步，沙盒里 nmID 约 10–15s 出现。
5. **并发限制（压测实测）**：WB 网关每 host **基本只允许 1 个并发请求**——任意并发突发(3/5/8/12)都只 1 个 200、其余全 **429 "too many requests"**（body 指向 dev.wildberries.ru/news/281）。且 Node `fetch`(undici) keep-alive 复用连接时，**顺序请求需间隔 ≥800ms** 才不 429（Python urllib 每次新连接则 300ms 即可）。→ 客户端用**每 host 串行闸门(并发1, 间隔900ms)** + 429 退避重试，多商品并发上架可全绿（实测 4/4 并发上架成功）。`vendorCode` 重复会被 WB 拒（"vendor code is used in other cards"），属正确防重。

## 0. 总览

```
商品名+关键字
  └─> [content-api]  resolve subjectID（按类目名搜索）
  └─> [content-api]  取必填特征 + 字典值（TNVED/颜色等）
  └─> [image-gen]    文生图 + sharp 合成宣传图
  └─> [content-api]  POST /content/v2/cards/upload  (异步！200=入队，非创建成功)
  └─> [content-api]  轮询 get/cards/list (+ cards/error/list) 直到出现 nmID/imtID
  └─> [content-api]  挂图：v3/media/file(字节) 或 v3/media/save(公网URL)
  └─> [discounts-prices-api] POST /api/v2/upload/task  (异步价格任务)
  └─> 轮询 buffer/tasks → history/tasks
```

两条铁律：
1. **建卡 / 定价都是异步的**：`200 OK` 只代表"入队"，必须轮询确认。
2. **Content 与 Prices 是两个独立 Token 范围**，需同时具备（一个 Token 勾两个范围，或两个 Token）。

## 1. 认证

- Host：`content-api.wildberries.ru`（卡片/媒体/类目）、`discounts-prices-api.wildberries.ru`（价格）。**不要用旧的 `suppliers-api`**。
- Header：**`Authorization: Bearer <JWT>`**（默认）。老端点 401 时回退裸 `Authorization: <JWT>`。
- Token 是 JWT，**180 天**过期；只在创建时显示一次。
- 需要 **Контент(Content)** + **Цены и скидки(Prices)** 两个范围；**不能用只读 Token**。
- Sandbox：Test 类型 Token + `-sandbox` host（如 `content-api-sandbox.wildberries.ru`）。本地测试优先用 **dry-run**。

## 2. 上架步骤

所有 Content 返回 `{data, error, errorText, additionalErrors}`，**判 `error===false`，不能只看 200**。
限流：Content ~100/min；建卡/编辑 ~10/min；Prices 10 次/6 秒。

### Step1 解析 subjectID
`GET /content/v2/object/all?name=<猜测>&limit=1000&locale=ru`
→ `data[]: {subjectID, parentID, subjectName, parentName}`，按 subjectName 子串(不含父类)匹配，取最优 subjectID。

### Step2 取特征 + 字典
`GET /content/v2/object/charcs/{subjectID}?locale=ru`
→ `{charcID, name, required, unitName, maxCount, popular, charcType}`
- `required===true` 必填（缺则静默失败进 error 列表）
- charcType：**1=字符串/字符串数组**，**4=数字/数字数组**，0=废弃勿填；遵守 maxCount(0=不限,1=单值)
字典端点（charcs 不返回这些取值）：
- 颜色 `GET /content/v2/directory/colors` → `data[]:{name,parentName}`
- TNVED `GET /content/v2/directory/tnved?subjectID=<id>&search=<前缀>` → `data[]:{tnved,isKiz}`（必须带 subjectID）

### Step3 建卡
`POST /content/v2/cards/upload`，**body 是顶层数组**：
```json
[{ "subjectID":105, "variants":[{
  "vendorCode":"SELLER-SKU-001",  // 唯一
  "title":"...", "description":"...", "brand":"...",
  "dimensions":{"length":30,"width":25,"height":3,"weightBrutto":0.2}, // cm / kg
  "characteristics":[{"id":14177449,"value":["Red"]}],
  "sizes":[{"techSize":"0","wbSize":"0","price":1990,"skus":["2000000000017"]}]
}]}]
```
- variant 仅 `vendorCode` 是 schema 必填；但类目决定哪些 characteristics 必填。
- **无尺码商品不要传 techSize/wbSize**（实测纠正，见顶部）；有尺码(服饰鞋)才传。缺 skus → WB 自动生成条码。
- 单请求 ≤100 卡、每卡 ≤30 nmID、≤10MB。
- 响应不含 nmID/imtID。

### Step4 轮询 nmID
`POST /content/v2/get/cards/list`
```json
{"settings":{"sort":{"ascending":false},"filter":{"withPhoto":-1,"textSearch":"SELLER-SKU-001"},"cursor":{"limit":100}}}
```
→ 匹配 `cards[].vendorCode`，取 `nmID`/`imtID`。每 10–30s 轮询，最长 ~30 分钟。
超时则 `POST /content/v2/cards/error/list?locale=ru`（**POST，不是 GET**）取人类可读错误。

### Step5 挂图（需先有 nmID）
- 字节上传（无需公网托管，推荐自托管）：`POST /content/v3/media/file`
  headers：`X-Nm-Id:<nmID>`、`X-Photo-Number:<1基序号>`；multipart 字段 **`uploadfile`**；一次一张。
- 公网URL：`POST /content/v3/media/save` body `{"nmId":213,"data":["https://..."]}`
  **字段 `nmId`(小写d)**；**整组替换**语义；URL 必须公网直链。
- 约束：≤30 张，最小 700×900，≤32MB，JPG/PNG/WebP；推荐 3:4 / 900×1200。

### Step6 定价（待 nmID 同步后）
`POST https://discounts-prices-api.wildberries.ru/api/v2/upload/task`
body `{"data":[{"nmID":213,"price":2990,"discount":33}]}`（**nmID 大写D**；price 整数无小数）
轮询：`GET /api/v2/buffer/tasks?uploadID=<id>` → `GET /api/v2/history/tasks?uploadID=<id>`
status：3=成功，5=部分成功。

## 3. 文生图

- ImageProvider 接口统一返回 `Buffer`。`IMAGE_PROVIDER=pollinations|openai`，默认 pollinations。
- Pollinations（免key）：`GET https://image.pollinations.ai/prompt/{enc}?width=&height=&seed=&model=flux&nologo=true`，**响应体即原始图片**。`/models` 取活跃模型，缺失则回退。无SLA，需超时+重试。
- OpenAI：`POST /v1/images/generations` `{model:"gpt-image-1",size,quality,n:1}` → `data[0].b64_json`（无 url）。
- 宣传图：**sharp + SVG overlay**（非 node-canvas）。`sharp(base).resize().composite([{input:svgBuffer}])`。注意服务器需有字体。

## 4. 风险与 dry-run

- 状态机：`QUEUED → SYNCED → MEDIA → PRICED → LIVE | ERROR`，崩溃可续跑（避免重复 vendorCode）。
- 建卡 200≠成功；媒体 200≠成功（一张失败则整组不上传）；上架前本地校验（顶层数组、nmId casing、单位、charcType、必填、vendorCode 唯一）。
- **dry-run（WB_DRY_RUN / 无 Token）**：不发真实 HTTP，返回拟真响应（建卡→{error:false}；list→延迟后给假 nmID；价格→假 uploadID→processing→status:3）；图片返回占位 Buffer 但**真实跑 sharp 合成**；校验照常执行。

### 字段 casing 速查
- 建卡/读卡/价格：`nmID`（大写D）
- media/save body：`nmId`（小写d），数组字段 `data`
- media/file headers：`X-Nm-Id`、`X-Photo-Number`（1基），字段 `uploadfile`
- cards/error/list：**POST**
- 处处判 `error===false`
