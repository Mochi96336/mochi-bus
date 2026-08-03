# 部署自己的 Mochi Bus

`bus.moc96336.com` 是 Mochi 維護的公開參考實例。這一頁會帶你從零開始，架出一套屬於自己的 Mochi Bus。

不需要先會寫程式，但會接觸終端機、Node.js、npm、Cloudflare 和 TDX。每個工具第一次出現時，都有可以展開的小教學。

這篇先走最小、最容易檢查的一條路：

- 一個縣市：`Chiayi`（嘉義市）
- 一個 Cloudflare `workers.dev` 公開網址
- 手動更新公車資料

完成後，你會有自己的 Worker、D1、R2 和公開網址；網站不需要連回 `bus.moc96336.com` 才能運作。

```text
取得程式碼
    │
    ▼
建立自己的設定
    │
    ▼
建立 D1 和 R2
    │
    ▼
部署 Worker
    │
    ▼
發布嘉義市公車資料
```

> 只想先在自己的電腦看看，不想建立 Cloudflare 資源時，請回到 README 的[本機啟動](../README.md#本機啟動)。

## 開始前先知道

### R2 有免費額度，但仍需要付款方式

> [!IMPORTANT]
> Mochi Bus 使用 Cloudflare R2 儲存路線線形、時刻表和城市快照。
>
> R2 有每月免費額度，但啟用前仍需要在 Cloudflare Dashboard 完成 R2 checkout，並讓帳號具備可用的付款方式；實際畫面通常會要求信用卡等付款資料。
>
> 使用量保持在免費額度內時，R2 費用可以是 0；超過免費額度後會依實際用量計費。價格和免費額度可能調整，建立前請查看 [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)。
>
> 不希望加入付款方式時，可以使用本機模式體驗 Mochi Bus，但無法完成這篇的公開部署流程。

啟用位置：

```text
Cloudflare Dashboard
        │
        ▼
Storage & databases
        │
        ▼
R2 → Overview → 完成 checkout
```

<details>
<summary><strong>目前的 R2 免費額度包含什麼？</strong></summary>

Cloudflare 目前為 R2 Standard storage 提供每月免費額度，包括：

- 10 GB-month 儲存空間
- 100 萬次 Class A operations
- 1,000 萬次 Class B operations
- 對外傳輸流量免費

這些數字可能調整，請以 [Cloudflare 官方價格頁](https://developers.cloudflare.com/r2/pricing/)為準。

</details>

### 這篇會建立哪些東西？

```text
使用者打開網站
        │
        ▼
Cloudflare Worker ────── 公開網址
        │
        ├── D1：路線、站牌等表格資料
        │
        └── R2：線形、時刻表等較大檔案
```

Worker 是網站程式；D1 和 R2 保存網站需要的公車資料。

<details>
<summary><strong>Worker、D1 和 R2 分別是什麼？</strong></summary>

### Worker

Mochi Bus 真正上線執行的程式。它接收瀏覽器請求、查詢資料，再把網站或 API 結果回傳給使用者。

### D1

Cloudflare 的 SQL 資料庫。Mochi Bus 用它保存路線、站牌、路線經過哪些站，以及目前使用的資料版本。

### R2

Cloudflare 的物件儲存空間，可以把它想成給程式使用的雲端硬碟。Mochi Bus 用它保存地圖線形、時刻表和城市快照等較大的資料檔案。

</details>

### 公車資料從哪裡來？

```text
交通部 TDX
    │
    │ 下載嘉義市資料
    ▼
Mochi Bus 快照工具
    │
    ├── 路線與站牌 ──→ D1
    └── 線形與時刻表 → R2
```

TDX 提供原始公車資料。Mochi Bus 會先下載、整理並驗證，再發布到你自己的 Cloudflare 資源。

## 準備

### 需要的帳號

- [Cloudflare 帳號](https://dash.cloudflare.com/sign-up)
- TDX 帳號、Client ID 與 Client Secret
- GitHub 帳號只有在你打算 fork 專案時才需要

TDX 憑證可以從[會員中心](https://tdx.transportdata.tw/)取得；還沒有帳號可先[註冊](https://tdx.transportdata.tw/register/general)。位置在「會員中心 → 資料服務 → API 金鑰」。

### 電腦需要的工具

- [Node.js 22 以上](https://nodejs.org/)
- [Git](https://git-scm.com/downloads)
- 終端機

Windows 可以使用 PowerShell；macOS 和 Linux 可以使用 Terminal。後面灰色指令框中的文字都是貼進終端機，再按 Enter 執行。

確認 Node.js 和 npm 已安裝：

```sh
node --version
npm --version
```

第一個指令應顯示 `v22` 或更新版本。第二個指令只要能顯示版本號即可。

```text
Node.js
   └── 內含 npm

npm
   ├── 安裝 Mochi Bus 需要的工具
   └── 執行 Mochi Bus 已準備好的指令
```

<details>
<summary><strong>Node.js 和 npm 是什麼？</strong></summary>

瀏覽器可以執行 JavaScript；Node.js 則讓電腦也能直接執行 JavaScript 程式。

Mochi Bus 使用 Node.js 來建置網站、檢查設定、整理 TDX 資料和執行部署工具。

npm 會隨 Node.js 一起安裝。這篇主要使用兩種 npm 指令：

- `npm install`：安裝這個專案需要的工具
- `npm run ...`：執行 Mochi Bus 已經準備好的工作

你不需要自己撰寫 Node.js 程式。

</details>

## 1. 取得程式碼

只想跟著教學測試，可以直接 clone Mochi Bus：

```sh
git clone https://github.com/Mochi96336/mochi-bus.git
cd mochi-bus
```

打算長期維護、修改自己的版本或之後接 GitHub Actions，建議先在 GitHub fork，再把網址換成自己的帳號：

```sh
git clone https://github.com/<你的 GitHub 帳號>/mochi-bus.git
cd mochi-bus
```

接著安裝專案需要的工具：

```sh
npm install
```

這個指令只會在目前資料夾安裝工具，不會部署網站，也不會建立 Cloudflare 資源。通常可以安全重跑。

<details>
<summary><strong>repository、clone 和 fork 是什麼？</strong></summary>

- **repository**：專案檔案和修改紀錄的集合
- **clone**：把 repository 下載到自己的電腦
- **fork**：在自己的 GitHub 帳號建立一份可獨立維護的副本

只想測試時不一定需要 fork。

</details>

<details>
<summary><strong>npm install 結尾看到 Mochi production 名稱正常嗎？</strong></summary>

正常。第一次安裝時，repository 還沒有你的 `instance.json`，因此可能先用 upstream 的預設設定產生本機檔案。

這不會連線或部署到 `bus.moc96336.com`。後面建立自己的 `instance.json` 並重新 compile 後，這些檔案會被替換成你的設定。

</details>

## 2. 登入 Cloudflare

接下來會使用 Cloudflare 官方工具 Wrangler：

```text
你
 │
 │ npx wrangler ...
 ▼
Wrangler
 │
 └── 操作你的 Cloudflare 帳號
```

登入並確認目前帳號：

```sh
npx wrangler login
npx wrangler whoami
```

第一個指令通常會開啟瀏覽器，請你授權 Wrangler 存取 Cloudflare 帳號。第二個指令只會顯示目前登入的帳號。

`whoami` 顯示的帳號，就是稍後建立 D1、R2 和 Worker 的帳號。有多個 Cloudflare 帳號時，先在這裡確認清楚。

<details>
<summary><strong>npx 和 Wrangler 是什麼？</strong></summary>

- **Wrangler** 是 Cloudflare 官方提供的終端機工具
- **npx** 負責執行目前專案已安裝的 Wrangler
- 不需要另外在整台電腦全域安裝 Wrangler

之後看到 `npx wrangler ...`，可以理解成：「請 Cloudflare 官方工具執行後面的操作。」

</details>

## 3. 放入 TDX 憑證

```text
TDX Client ID + Client Secret
              │
              ▼
Mochi Bus 可以向 TDX 取得公車資料
```

先複製範例檔，建立 `.dev.vars`。

macOS / Linux：

```sh
cp .dev.vars.example .dev.vars
```

Windows PowerShell：

```powershell
Copy-Item .dev.vars.example .dev.vars
```

用任何文字編輯器打開 `.dev.vars`，Windows 記事本也可以。把範例文字換成自己的值：

```dotenv
TDX_CLIENT_ID="你的 Client ID"
TDX_CLIENT_SECRET="你的 Client Secret"
```

> [!WARNING]
> `.dev.vars` 內含密碼性質的資料。不要把內容貼到 issue、PR、公開聊天或截圖，也不要提交到 repository。

`.dev.vars` 已被 Git 忽略。它稍後會同時用於 Worker secrets 和本機快照發布。

<details>
<summary><strong>Client ID、Client Secret 和 secret 是什麼？</strong></summary>

可以把 Client ID 想成程式使用的帳號，把 Client Secret 想成這個程式帳號的密碼。

Secret 不應放在 `instance.json` 等公開設定，也不應提交到 GitHub。

</details>

## 4. 建立自己的 instance 設定

建立一套名為 `my-chiayi-bus`、只啟用嘉義市的設定。這個指令在 PowerShell、macOS 和 Linux 都相同：

```sh
npm run instance:init -- my-chiayi-bus --cities Chiayi --site-name "My Chiayi Bus"
```

這個指令只會在本機建立 `instance.json`，不會建立任何 Cloudflare 資源。

成功時會看到類似：

```text
Created Mochi Bus instance manifest: instance.json
Profile: starter
Cities: Chiayi
Cloudflare: my-chiayi-bus / my-chiayi-transit / my-chiayi-transit-shapes
State: valid instance manifest
```

這些名稱的關係是：

```text
Instance ID：my-chiayi-bus
       │
       ├── Worker：my-chiayi-bus
       ├── D1：my-chiayi-transit
       └── R2：my-chiayi-transit-shapes
```

`instance.json` 是這套服務的主要設定，可以提交到自己的 repository。它不應包含任何 secret。

第一次產生時，D1 ID 會是 `null`：

```json
"d1": {
  "databaseName": "my-chiayi-transit",
  "databaseId": null
}
```

這是正常的，因為資料庫還沒建立。

先驗證設定並產生部署檔案：

```sh
npm run instance:validate -- --config instance.json
npm run instance:compile -- --config instance.json
```

```text
instance.json
     │
     │ validate + compile
     ▼
.generated/instance/
```

接著查看 provisioning plan：

```sh
npm run instance:provision-plan -- --config instance.json
```

這個指令只會列出目前缺少什麼，不會建立或修改遠端資源。輸出最後會顯示：

```text
NO CHANGES WERE APPLIED
```

第一次執行時，GitHub secrets 或 variables 可能也會被列成 `action_required`。這篇走手動部署，先不用處理那些項目；現在只看 D1、R2 和 generated artifacts。

產生的檔案會放在：

```text
.generated/instance/instance-runtime.json
.generated/instance/wrangler.instance.jsonc
.generated/instance/operations-plan.json
```

只改 `instance.json`，不要手動修改 `.generated/instance/`。這些檔案可以隨時重新產生。

<details>
<summary><strong>instance.json 和 generated files 是什麼？</strong></summary>

`instance.json` 是你維護的來源設定，記錄網站名稱、啟用縣市和 Cloudflare 資源名稱。

`.generated/instance/` 則是 Mochi Bus 根據來源設定自動產生、交給程式和 Wrangler 使用的檔案。直接修改 generated files，下一次 compile 時就會被覆蓋。

</details>

## 5. 建立 D1 和 R2

> [!WARNING]
> 從這一步開始，指令會真的在目前登入的 Cloudflare 帳號建立遠端資源。建立前再執行一次 `npx wrangler whoami`，確認帳號正確。

### 建立 D1 database

- **操作位置：** Cloudflare
- **會建立資源：** 是
- **重跑前：** 先用 `npx wrangler d1 list` 確認是否已存在

```sh
npx wrangler d1 create my-chiayi-transit
```

Wrangler 會回傳一個 database ID。把實際值填回 `instance.json`：

```json
"d1": {
  "databaseName": "my-chiayi-transit",
  "databaseId": "xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx"
}
```

只改 `instance.json`，不要把 ID 直接寫進 generated Wrangler config。

### 建立 R2 bucket

- **操作位置：** Cloudflare
- **會建立資源：** 是
- **可能計費：** 超過 R2 免費額度時
- **重跑前：** 先用 `npx wrangler r2 bucket list` 確認是否已存在

```sh
npx wrangler r2 bucket create my-chiayi-transit-shapes
```

R2 不需要把另一個 ID 填回 `instance.json`，bucket 名稱一致即可。

不確定剛才有沒有建立成功，可以列出帳號裡的資源：

```sh
npx wrangler d1 list
npx wrangler r2 bucket list
```

不要為了重試而連續執行 `create`。如果看到同名資源，先確認它是不是剛才建立、而且準備給這套 Mochi Bus 使用。

<details>
<summary><strong>為什麼資料要分成 D1 和 R2？</strong></summary>

D1 適合保存需要查詢和互相關聯的表格資料，例如路線、站牌與站序。

R2 適合保存完整的大型檔案，例如 GeoJSON 線形、時刻表和城市路網檔案。

Worker 會依照請求，把兩邊的資料組合成網站和 API 回應。

</details>

填好 D1 ID 後，重新驗證並產生設定：

```sh
npm run instance:validate -- --config instance.json
npm run instance:compile -- --config instance.json
```

可以再跑一次 provisioning plan。它不一定會全部顯示 ready，因為 GitHub Actions 和進階檢查還沒設定；D1 ID 與 generated artifacts 正確即可繼續。

## 6. 建立 D1 資料表

目前的 D1 是空的。Migration 會建立 Mochi Bus 需要的資料表結構：

```text
空的 D1
  │
  │ migration
  ▼
具有 routes、stops 等資料表的 D1
```

這個指令在 PowerShell、macOS 和 Linux 都相同：

```sh
npx wrangler d1 migrations apply TRANSIT_DB --remote --config .generated/instance/wrangler.instance.jsonc
```

> `TRANSIT_DB` 是 Mochi Bus 程式內使用的固定 binding 名稱，不要把它換成 `my-chiayi-transit`。

Wrangler 可能會詢問是否套用 migration。繼續前，確認畫面中的 database 名稱是 `my-chiayi-transit`，或你自己在 `instance.json` 裡設定的名稱。

若名稱或 ID 對不上，先停下來檢查 `npx wrangler whoami` 和 `instance.json`，不用急著刪掉資料庫重建。

<details>
<summary><strong>migration 和 binding 是什麼？</strong></summary>

- **migration**：建立或更新資料表的結構。這一步不是在搬移既有資料。
- **binding**：Worker 程式內存取某項 Cloudflare 資源時使用的固定名稱。

`TRANSIT_DB` 指向哪一個真實 D1 database，是由 generated Wrangler config 決定。

</details>

## 7. 部署 Worker

這一步會把網站程式上傳到 Cloudflare：

```text
你電腦裡的程式
        │
        │ npm run deploy
        ▼
Cloudflare Worker
        │
        ▼
https://...workers.dev
```

第一次部署時，同時把 `.dev.vars` 裡的兩個 TDX secrets 上傳：

```sh
npm run deploy -- --secrets-file .dev.vars
```

- **操作位置：** 本機建置，接著上傳到 Cloudflare
- **會建立或更新：** Worker 與 Worker secrets
- **通常可以重跑：** 是

這個指令會建置前端、上傳 Worker，並把 `TDX_CLIENT_ID`、`TDX_CLIENT_SECRET` 存成 Cloudflare Worker secrets。檔案內容不會寫進 repository。

第一次使用 Workers 時，Wrangler 可能會要求你建立或確認 `workers.dev` subdomain。照畫面完成即可，這不代表部署失敗。

成功後，Wrangler 會顯示一個網址，類似：

```text
https://my-chiayi-bus.<你的-subdomain>.workers.dev
```

先把這個網址複製下來，下一步會用到。

> [!NOTE]
> 現在打開網站，頁面應該能載入，但還看不到完整路線和站牌。這是正常的：目前只有網站程式上線，嘉義市公車資料尚未發布。

`workers.dev` 的 Cache API 行為和自訂網域不同，但不影響這次 starter 部署。

## 8. 發布第一份城市快照

### 程式上線了，為什麼還沒有公車？

```text
部署 Worker
＝ 網站程式上線

發布城市快照
＝ 公車資料上線
```

城市快照是某個時間點整理完成的一整份城市公車資料。發布流程會：

```text
TDX
 │
 │ 下載
 ▼
本機整理與驗證
 │
 ├── 寫入 D1
 ├── 寫入 R2
 └── 從公開網址確認結果
```

快照工具需要知道剛才的公開網址，才能在發布完成後檢查結果。

macOS / Linux：

```sh
export SNAPSHOT_SMOKE_BASE_URL="https://my-chiayi-bus.<你的-subdomain>.workers.dev"
npm run snapshot:city -- Chiayi
```

Windows PowerShell：

```powershell
$env:SNAPSHOT_SMOKE_BASE_URL = "https://my-chiayi-bus.<你的-subdomain>.workers.dev"
npm run snapshot:city -- Chiayi
```

把範例網址換成 Wrangler 實際回傳的網址，結尾不要加 `/`。

`SNAPSHOT_SMOKE_BASE_URL` 只存在目前這個終端機視窗。關閉視窗或改用另一個終端機後，需要重新設定。

這一步會下載 TDX 資料、在本機驗證、寫入 D1 和 R2，再從公開網站檢查新快照。第一次執行時終端機會有不少輸出，不要在中途關掉。

- **操作位置：** TDX、本機、Cloudflare D1/R2 和公開網站
- **會寫入資料：** 是
- **可能計費：** R2 或其他 Cloudflare 使用量超過方案額度時
- **通常可以重跑：** 是

<details>
<summary><strong>城市快照是什麼？</strong></summary>

城市快照不是畫面截圖，也不是電腦備份。

它是某個時間點整理完成的一整份城市公車資料，包含路線、站牌、線形和時刻表等內容。Mochi Bus 會先驗證整份資料，再切換公開網站使用的版本。

完整路網使用快照，可以減少重複向 TDX 下載相同資料，也讓地圖載入更快。即時到站和車輛位置等容易變動的資訊，仍會在需要時查詢 TDX。

</details>

### 看到 R2 credentials 警告

Starter profile 可以先不建立 `.snapshot.env`。缺少 R2 S3 credentials 時，publisher 會改用較慢的 Wrangler 上傳方式；這個警告本身不代表失敗。

要長期維運、匯入大城市或改成自動排程時，再設定：

- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `CLOUDFLARE_ACCOUNT_ID`

前兩個值必須一起設定，不能只放其中一個。

## 9. 確認結果

先確認公開 API 看得到嘉義市。打開：

```text
<公開網址>/api/v1/map/cities
```

例如：

```text
https://my-chiayi-bus.example.workers.dev/api/v1/map/cities
```

回應中的城市應只包含 `Chiayi`。

接著回到網站確認：

- [ ] 首頁和地圖可以開啟
- [ ] 城市範圍只有嘉義市
- [ ] 看得到路線、線形和站牌
- [ ] 到站時間可以查詢
- [ ] 未啟用的縣市不會被當成可用城市
- [ ] 網站不需要向 `bus.moc96336.com` 取得執行資料

通過這些項目，就已經是一套能獨立運作的 Mochi Bus。

完整的 release smoke 會檢查版本 tag、瀏覽器資產和較長的觀察窗口，留到 GitHub Actions 或 managed/operator 部署再使用，不列入第一次安裝。

## 常見問題

### 網站能開，但沒有路線

代表 Worker 已經上線，但城市快照可能還沒發布成功。

確認目前終端機已設定 `SNAPSHOT_SMOKE_BASE_URL`，再執行：

```sh
npm run snapshot:city -- Chiayi
```

### `Snapshot publisher requires a fixed public origin or SNAPSHOT_SMOKE_BASE_URL`

目前的終端機沒有公開網址設定。重新設定 `SNAPSHOT_SMOKE_BASE_URL` 後再跑一次。

### `Missing TDX_CLIENT_ID or TDX_CLIENT_SECRET`

確認 repository 根目錄有 `.dev.vars`，兩個值都已替換，不是空字串或範例文字。

### `Snapshot publisher requires a provisioned D1 database ID`

檢查 `instance.json` 的 `cloudflare.d1.databaseId`。填好後還要重新編譯：

```sh
npm run instance:compile -- --config instance.json
```

### `city_not_enabled`

請求的城市不在 `instance.json` 的 `transit.enabledCities`。修改設定後重新執行：

```sh
npm run instance:validate -- --config instance.json
npm run instance:compile -- --config instance.json
npm run deploy -- --secrets-file .dev.vars
```

新增城市後，還要另外發布該城市的快照。

### generated artifacts 過期

不要直接修改 `.generated/instance/`。重新產生即可：

```sh
npm run instance:compile -- --config instance.json
```

### Cloudflare 資源對不上

依序確認：

1. `npx wrangler whoami` 顯示的帳號
2. `instance.json` 的 D1 名稱與 ID
3. R2 bucket 名稱
4. generated config 是否由最新的 manifest 產生

先找出哪一項不一致，不要再建一組名稱相近的資源繞過它。

### `create` 顯示資源已經存在

先列出目前帳號的資源：

```sh
npx wrangler d1 list
npx wrangler r2 bucket list
```

如果同名資源是你剛才建立的，就直接沿用，不要重複建立。若用途不明，先停止並確認，不要把陌生的舊資源直接接進這套服務。

## 哪些步驟可以重跑？

通常可以安全重跑：

```text
✓ 驗證 instance 設定
✓ 重新產生 generated files
✓ 套用 D1 migration
✓ 部署 Worker
✓ 發布城市快照
```

對應指令：

```sh
npm run instance:validate -- --config instance.json
npm run instance:compile -- --config instance.json
npx wrangler d1 migrations apply TRANSIT_DB --remote --config .generated/instance/wrangler.instance.jsonc
npm run deploy -- --secrets-file .dev.vars
npm run snapshot:city -- Chiayi
```

以下兩個指令會建立新資源，執行前先確認同名資源不存在：

```sh
npx wrangler d1 create ...
npx wrangler r2 bucket create ...
```

## 移除這套服務與停止可能的費用

可以從 Cloudflare Dashboard 刪除：

- [ ] Worker
- [ ] D1 database
- [ ] R2 bucket 內的所有物件
- [ ] 空的 R2 bucket

R2 bucket 裡有快照時不能直接刪除，要先清空內容。刪除 Worker 不會自動刪除 D1 或 R2；刪除遠端資源也不會動到本機的 `instance.json`。

如果你不再使用任何 R2 功能，也請到 Cloudflare Billing 和 R2 頁面確認 subscription 與帳單狀態。不要只刪除 Worker 就假設所有可能計費的資源都已移除。

## 接下來

先不要急著加入全台排程。比較好的下一步，是換一個乾淨環境再走一次，確認沒有使用到原作者帳號或本機留下來的設定。

完成 starter 部署後，可以再選擇：

- 加入第二個縣市
- 綁定自訂網域
- 用 GitHub Actions 自動更新資料
- 升級成 managed profile
- 定期同步 upstream 的 Mochi Bus 更新

這些進階路徑目前不屬於本篇的第一次安裝範圍。
