# 用 fork 啟用自動部署、城市更新與維運檢查

這份教學接續[部署自己的 Mochi Bus](SELF-HOSTING.md)。

請先完成手動 starter 部署，確認 Worker、D1、R2 和第一份城市快照都能正常運作，再開始設定自動化。

Mochi Bus repository 目前提供四個與自架維運直接相關的 workflows：

| Workflow | 作用 | 何時執行 |
|---|---|---|
| **Deploy** | 驗證並重新部署 Worker，部署後執行 release smoke | fork 的 `main` 收到 push，或手動執行 |
| **Sync transit snapshots** | 下載 TDX 城市資料並發布快照 | 台北時間每日 03:17，或手動執行 |
| **Snapshot window watchdog** | 檢查排程快照是否留下可信結果 | 台北時間每日 07:45，或手動執行 |
| **Public network probe** | 從公開網址檢查網站、快照與部分即時資料路徑 | 台北時間每日 08:20，或手動執行 |

它們可以分開啟用：

- 只設定 **Deploy**，不會自動更新城市資料。
- 只設定 **Sync transit snapshots**，不會替你同步或部署新版程式碼。
- Watchdog 和 public probe 只負責偵測與留下結果，**不會自動重跑、修復或 rollback**。
- Fork 不會自動建立 Cloudflare 資源，也不會自動搬移本機 Secret。

## 開始前確認

- [ ] 已完成手動自架教學
- [ ] 公開網址可以正常開啟
- [ ] `instance.json` 已填入正確的 D1 database ID
- [ ] 嘉義市快照已成功發布
- [ ] 已建立 GitHub 帳號
- [ ] 知道目前使用的 Cloudflare account

> [!WARNING]
> `.dev.vars`、`.snapshot.env`、TDX Client Secret、R2 Secret Access Key 和 Cloudflare API token 都不能提交到 repository。

> [!IMPORTANT]
> 公開 repository 的 fork 預設停用 scheduled workflows。先完成本篇的 Cloudflare Tokens、Repository Secrets 和 Variables，再提交 `instance.json`、啟用 Actions 並手動驗證。這樣可以避免第一個 workflow 因缺少憑證而失敗。

## 1. 建立自己的 fork

操作位置：GitHub 網站

1. 打開 `Mochi96336/mochi-bus` repository。
2. 選擇 **Fork**。
3. 選擇自己的 GitHub 帳號作為 Owner。
4. 建立 fork。

Fork 是放在自己帳號下、可以獨立設定 Secrets 與 Actions 的 repository 副本。它不是新的 Cloudflare 服務，也不會影響已經手動部署的 Worker。

### 建議重新 clone fork

操作位置：先用 VS Code 開啟準備存放專案的上層資料夾，再在該資料夾開啟終端機

最容易理解的方式，是把 fork 下載到另一個資料夾，不直接改動原本完成手動部署的資料夾。

先在 VS Code 選擇 **File → Open Folder**，開啟原本 `mochi-bus` 所在的上層專案資料夾，例如：

- Windows：`C:\Users\你的名稱\Projects` 或 `D:\Projects`
- macOS / Linux：`~/Projects`

接著選擇 **Terminal → New Terminal**。把 `YOUR_GITHUB_USERNAME` 換成自己的 GitHub 使用者名稱，再執行：

```sh
git clone https://github.com/YOUR_GITHUB_USERNAME/mochi-bus.git mochi-bus-fork
cd mochi-bus-fork
```

`git clone` 會在終端機目前位置建立新的 `mochi-bus-fork` 子資料夾，不會把 repository 檔案散落到上層資料夾，也不需要先執行 `cd ..`。

### 先複製 instance，再安裝依賴

`npm install` 會自動執行 repository 的 `prepare` script 並編譯 instance。若自己的 `instance.json` 還沒放進 fork，工具會暫時改用 repository 內建的 production manifest；它不會因此部署 Mochi 正式服務，但輸出和 `.generated/instance/` 會非常容易讓人誤會。

因此先把原本 `mochi-bus` 資料夾中的 `instance.json` 複製到 `mochi-bus-fork` 根目錄。

可以直接使用 VS Code Explorer 複製；若兩個資料夾名稱正好是 `mochi-bus` 與 `mochi-bus-fork`，也可以在 `mochi-bus-fork` 終端機執行：

Windows PowerShell：

```powershell
Copy-Item ..\mochi-bus\instance.json .\instance.json
```

macOS / Linux：

```sh
cp ../mochi-bus/instance.json ./instance.json
```

確認根目錄已看到 `instance.json` 後，再執行：

```sh
npm install
```

若還要在新資料夾繼續手動部署或發布快照，也可以在本機複製 `.dev.vars` 和 `.snapshot.env`；它們仍然不可提交。原本資料夾若有自己修改過的程式碼，也要另外檢查與移植，單純複製 `instance.json` 不會帶走那些修改。

## 2. 驗證 fork 中的 instance 設定

操作位置：VS Code 編輯器與終端機

確認新資料夾根目錄存在：

```text
instance.json
```

依序執行：

```sh
npm run instance:validate -- --config instance.json
npm run instance:compile -- --config instance.json
npm run instance:provision-plan -- --config instance.json
```

再查看目前的 Git 狀態：

```sh
git status --short
```

此時可以看到尚未提交的 `instance.json`。不應看到 `.dev.vars` 或 `.snapshot.env`；若看到它們，先停止，不要繼續。

`instance.json` 不是 Secret，可以提交；它會保存 Worker、D1、R2、城市與操作模式等設定。這一步先不要執行 `git add`、`git commit` 或 `git push`，等 Tokens、Secrets 和 Variables 都設定完成後再一起提交。

## 3. 讓 workflows 找到 instance 設定

目前的 operational workflows 會自動尋找 repository 根目錄的：

```text
instance.json
```

因此本篇固定把 instance 設定放在根目錄，**不需要另外建立 `MOCHI_BUS_INSTANCE_CONFIG` Repository Variable**。

若把檔案移到 `instances/...` 等其他路徑，現有 workflows 不會只因為建立同名 GitHub Variable 就自動讀取它；還必須修改 workflow，將該 Variable 明確傳入 `MOCHI_BUS_INSTANCE_CONFIG` 環境變數。這屬於自訂 workflow 的進階路線，本篇不採用。

Scheduled workflows 只會使用 fork **default branch** 上的 workflow 與 instance 設定。本篇假設 default branch 是 `main`；若自行改名，必須同步檢查所有 workflow trigger 與操作說明。

## 4. 設定 Push 後自動部署 Worker

Deploy workflow 會在 fork 的 `main` 收到任何 push 時執行，也可以從 GitHub Actions 手動啟動。這包含程式碼、`instance.json`，甚至純文件更新；它沒有 path filter。

### 建立 Cloudflare deploy token

操作位置：Cloudflare Dashboard

建立一組只供 GitHub Actions 部署使用的 Cloudflare API token。不要把本機 Wrangler login、R2 S3 Secret Access Key 或 Global API Key 當成 deploy token。

前往 **My Profile → API Tokens → Create Token**，可以從 **Edit Cloudflare Workers** template 開始，再確認 Account permissions 至少包含：

```text
Workers Scripts Write
D1 Read
Workers R2 Storage Read
```

- **Workers Scripts Write：** 上傳與更新 Worker。
- **D1 Read：** Deploy preflight 唯讀確認 D1 名稱與 ID。
- **Workers R2 Storage Read：** Deploy preflight 唯讀確認 R2 bucket 身分；實際快照物件的寫入由下方另外建立的 S3 credentials 負責。

Account Resources 只選擇實際部署 Mochi Bus 的 Cloudflare account。第一次使用 `workers.dev` 不需要為自訂網域加入 Zone 權限；日後綁定 route 時再依需要增加對應 zone 的 Workers Routes 權限。

Cloudflare 可能調整權限名稱與 template 內容，建立前可對照 [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) 與 [Workers GitHub Actions 指引](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)。

建立後保存：

```text
Cloudflare deploy API token
Cloudflare Account ID
```

### 建立 Deploy 使用的 Repository Secrets 與 Variable

操作位置：自己的 fork → GitHub Settings

前往：

```text
Settings
  → Secrets and variables
  → Actions
  → Secrets
  → New repository secret
```

至少建立：

```text
CLOUDFLARE_DEPLOY_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

Secret 名稱必須完全一致，包括大小寫。

本篇從 starter 接續，而 starter 預設啟用 release smoke，因此還必須在 **Variables** 建立：

```text
RELEASE_SMOKE_ORIGIN=https://你的公開網域
```

Starter 使用 `workers.dev` 時，填入 Wrangler 實際顯示的完整網址；結尾不要加 `/`。缺少這個 Variable 時，Deploy preflight 會在上傳 Worker 前停止。

### TDX Worker Secrets 不會從本機自動搬進 GitHub

手動教學第一次執行：

```sh
npm run deploy -- --secrets-file .dev.vars
```

時，已把 TDX Client ID 和 Client Secret 保存到 Cloudflare Worker Secrets。

之後的 GitHub Deploy workflow 不會讀取你電腦裡的 `.dev.vars`。既有 Worker Secret 會繼續保留；只有更換 TDX 憑證時，才需要另外更新 Worker Secrets。

### 更換 TDX 憑證時要更新兩個位置

同一組 TDX 憑證會分別供公開 Worker 與快照 workflow 使用。日後更換 Client ID 或 Client Secret 時，兩邊都要更新：

1. 在 fork 的 GitHub Actions Repository Secrets 更新 `TDX_CLIENT_ID` 與 `TDX_CLIENT_SECRET`。
2. 更新本機 `.dev.vars` 內的同名欄位。
3. 先確認本機 fork 是準備部署的版本：

```sh
git pull --ff-only
git status --short
npm install
npm run instance:validate -- --config instance.json
npm run instance:compile -- --config instance.json
```

4. 再重新部署 Worker Secrets：

```sh
npm run deploy -- --secrets-file .dev.vars
```

這個指令不只更新 Secret，也會重新部署目前本機 checkout 的程式碼。不要在過期的 branch、來源不明的修改或尚未檢查的 upstream 更新上執行。

只更新 GitHub Secrets 時，快照可能恢復正常，但公開網站查詢即時到站仍可能使用舊憑證；只重新部署 Worker 時，網站可能正常，但排程仍會因 GitHub Secrets 過期而失敗。

## 5. 設定城市資料 workflow

> 只需要 Push 後自動部署 Worker、不需要城市資料排程時，可以跳過第 5、6 節，直接前往第 7 節。保留 `profile: "starter"` 與 `snapshotSchedule: "manual"`，也不需要建立快照 workflow 的 Token、Secrets 或 `SNAPSHOT_SMOKE_BASE_URL`。

`Sync transit snapshots` workflow 可以：

- 依 instance 設定的排程發布城市資料
- 從 GitHub Actions 手動選擇一個城市
- 發布前套用 D1 migration
- 發布後從公開網址執行 smoke 驗證

### 建立快照與監測 workflows 共用的 Secrets

操作位置：Cloudflare Dashboard 與自己的 fork → GitHub Settings

先在 Cloudflare Dashboard 建立另一組供 migration、D1 快照狀態、watchdog、public probe 與 R2 bucket preflight 使用的 API token。Account permissions 至少包含：

```text
D1 Write
Workers R2 Storage Read
```

- **D1 Write：** 套用 migration，並讀寫快照窗口、watchdog 與 public probe 狀態資料。
- **Workers R2 Storage Read：** preflight 唯讀確認目標 bucket 身分。
- 實際快照物件的上傳、讀取與刪除仍使用下方 `R2_ACCESS_KEY_ID`／`R2_SECRET_ACCESS_KEY`，不是這組 Cloudflare API token。

Account Resources 只選擇實際部署 Mochi Bus 的 Cloudflare account。Cloudflare 可能調整權限名稱，建立前可再對照 [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)。

再到 GitHub Settings 建立以下 Repository Secrets：

```text
TDX_CLIENT_ID
TDX_CLIENT_SECRET
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
```

再建立 Repository Variable：

```text
SNAPSHOT_SMOKE_BASE_URL=https://你的公開網域
```

這裡的 R2 Access Key ID 與 Secret Access Key，可以使用手動教學中建立的那組 bucket-scoped、Object Read & Write credentials。

`CLOUDFLARE_API_TOKEN` 是供 migration 與快照遠端操作使用的 Cloudflare API token；它和 `CLOUDFLARE_DEPLOY_API_TOKEN` 的用途不同，即使實際權限設計可能重疊，也不要因為名稱相似就漏建其中一個 Secret。

> [!WARNING]
> GitHub Secrets 儲存的是 Secret 的值，不要把 `NAME=value` 整行貼進 Value 欄位。Name 填 `TDX_CLIENT_ID`，Value 只填真正的 Client ID。

## 6. 選擇自動更新與監測層級

> [!WARNING]
> **TDX 免費額度不保證足以支撐全台自動更新、公開流量與每日 public probe。**
>
> 快照工具會下載各個啟用城市的路線、站牌、站序、線形與班表。TDX 公車 API 說明列有計次與計量兩種換算基準，目前分別為每 1 點 1,500 次與 150 MB；基礎會員目前每月各類資料服務合計提供 3 點免費額度。實際扣點方式、存取頻率與可用額度仍依訂閱方案及 TDX 會員中心顯示為準。
>
> 除了快照下載，網站使用者查詢即時到站、車輛與旅程估時也可能使用 TDX。啟用 `publicProbe` 後，workflow 還會每天對每個啟用城市走一次 arrivals、journey 與 vehicles 等公開即時路徑，因此也會增加用量。
>
> 建議先從實際需要的少數城市開始，在 TDX 會員中心觀察用量後再逐步增加；城市較多時優先考慮每週分片，額度有限時也可先關閉 public probe。
>
> TDX 的額度、計點與方案可能調整，設定前請查看 [TDX 公車 API 說明](https://tdx.transportdata.tw/api-service/swagger)、首頁額度公告與會員中心的最新資訊。

Starter profile 強制使用：

```json
"profile": "starter",
"snapshotSchedule": "manual"
```

即使 fork 已建立、Secrets 也全部填好，`manual` 仍代表不會自動發布城市快照。

### 選擇 snapshot 排程

Managed profile 可以依城市數量選擇兩種自動排程：

| `snapshotSchedule` | 行為 | 建議用途 |
|---|---|---|
| `daily` | 每天依序處理所有 `enabledCities` | 只有少數城市，而且確實需要每日更新 |
| `taipei-weekly-sharded` | 將啟用城市分散在一週七天，每個城市每週處理一次 | 城市較多或接近全台 |

`Sync transit snapshots` 在同一個 job 中逐城處理，不是每個城市平行執行；目前 job 最長 180 分鐘。城市很多時使用 `daily`，除了 TDX 額度，也可能遇到執行時間不足。

少數城市需要每日更新時：

```json
"profile": "managed",
"snapshotSchedule": "daily"
```

城市較多時，建議改用：

```json
"profile": "managed",
"snapshotSchedule": "taipei-weekly-sharded"
```

只改成自動排程、卻保留 `profile: "starter"`，會在 `instance:validate` 直接失敗。

### 決定是否啟用 managed 監測

原本由 starter 產生的 `instance.json` 通常是：

```json
"releaseSmoke": true,
"publicProbe": false,
"windowWatchdog": false
```

把 `profile` 改成 `managed` **不會自動改寫這三個欄位**。

只需要自動更新，不需要額外監測時，可以保留：

```json
"releaseSmoke": true,
"publicProbe": false,
"windowWatchdog": false
```

要使用完整 managed 維運檢查時，明確改成：

```json
"releaseSmoke": true,
"publicProbe": true,
"windowWatchdog": true
```

- `windowWatchdog` 在每日 07:45 檢查已關閉的排程窗口，只讀取與記錄 D1 證據；它不會補跑缺少的城市。
- `publicProbe` 在每日 08:20 從公開網址檢查所有啟用城市，並執行少量即時資料診斷；它不會自動修復或 rollback。
- Public probe 的 `realtime_degraded` 屬於 Yellow，workflow 仍可能顯示成功；要打開 run summary 才看得到警告。
- `windowWatchdog: true` 不能搭配 `snapshotSchedule: "manual"`。

修改後執行：

```sh
npm run instance:validate -- --config instance.json
npm run instance:compile -- --config instance.json
npm run instance:provision-plan -- --config instance.json
```

Provisioning plan 可以再次列出自動化仍缺少的 Secrets、Variables 或操作條件。先不要 push，下一步會在所有設定完成後一起提交。

### 排程失敗不會自動補跑

Scheduled workflow 可能因 GitHub 平台延遲，少數情況甚至不執行。Mochi Bus 不會自動回補錯過的排程：

- `daily` 錯過時，下一次正常排程是隔天。
- `taipei-weekly-sharded` 的某個城市錯過時，下一次正常排程可能是下一週。
- Watchdog 只會把 missing／failed 狀態報出來，不會替 Sync workflow 重跑。

發現缺少窗口時，要到 **Sync transit snapshots** 人工補跑並確認公開 API；不要只重新執行 watchdog。

## 7. 提交設定並啟用 Actions

操作位置：VS Code 終端機與自己的 fork

先確認只有預期中的設定準備提交：

```sh
git status --short
git add instance.json
git status --short
```

第二次輸出中，`instance.json` 應位於 staged 狀態；不應看到 `.dev.vars` 或 `.snapshot.env`。

提交並推送：

```sh
git commit -m "chore: add self-hosted instance config"
git push
```

若 `git commit` 顯示 `Please tell me who you are`，先設定自己的 Git 顯示名稱與 GitHub 已驗證 email：

```sh
git config --global user.name "你的名稱"
git config --global user.email "你的 GitHub 已驗證 email"
```

若 `git push` 要求驗證，依 Git Credential Manager 開啟的瀏覽器完成登入，或使用 Personal Access Token。GitHub 帳號密碼不能用於 Git HTTPS push；可參考 [GitHub authentication](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github)。

### 啟用 fork 的 workflows

Push 完成後：

1. 打開自己的 fork。
2. 選擇 **Actions**。
3. 若出現停用提示，選擇 **I understand my workflows, go ahead and enable them** 或 **Enable workflows**。
4. 打開 **Deploy**，確認可以看到 **Run workflow**。
5. 有自動城市更新時，啟用 **Sync transit snapshots**。
6. `windowWatchdog: true` 時，啟用 **Snapshot window watchdog**。
7. `publicProbe: true` 時，啟用 **Public network probe**。

不要只在 `instance.json` 把檢查設為 `true`，卻忘記啟用對應 workflow；那樣設定看起來完整，但排程不會執行。

公開 fork 的 scheduled workflows 預設停用；公開 repository 連續 60 天沒有活動時也可能再次被 GitHub 自動停用。之後發現資料沒有更新時，要同時確認 Sync、watchdog 與 public probe 的 enabled 狀態。詳細行為可參考 [GitHub 的 workflow 啟用說明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)。

> [!NOTE]
> GitHub scheduled workflows 只在 default branch 上執行，並可能因平台負載延遲或被捨棄。重新啟用 workflow 後，不會自動補跑停用期間錯過的工作。

### 打開 Actions 失敗通知

Watchdog 和 public probe 只有在 GitHub Actions 裡留下結果；未設定通知時，紅色 workflow 不一定會被你及時看到。

到 GitHub 個人設定：

```text
Settings
  → Notifications
  → System
  → Actions
  → Only notify for failed workflows
```

也可以選擇 Email 或 On GitHub。Scheduled workflow 的通知通常會送給建立、修改 cron，或最近重新啟用該 workflow 的使用者。

完整說明請見 [Managing GitHub Actions notifications](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications)。

## 8. 第一次驗證已啟用的 workflows

操作位置：自己的 fork → Actions

### 驗證 Deploy workflow

1. 選擇 **Deploy**。
2. 若剛才 push 已自動產生成功的 run，可以直接檢查該次結果；否則選擇 **Run workflow**。
3. 打開執行紀錄，確認所有必要步驟通過。
4. 再打開公開網址，確認網站仍能運作。

### 驗證 Sync transit snapshots workflow

只有設定城市資料自動更新時才需要這一段。第一次不要只等排程，應手動執行並觀察結果：

1. 選擇 **Sync transit snapshots**。
2. 選擇 **Run workflow**。
3. `city` 選擇 `Chiayi`。
4. `force_publish` 保持 `false`。
5. `window_type` 改成 `manual`。
6. `repair_legacy_previous` 保持 `false`，其他 repair 欄位留空。
7. 等待 workflow 完成。
8. 確認公開網站與以下 API 仍有嘉義市資料：

```text
/api/v1/map/cities
/api/v1/map/routes?city=Chiayi
```

### 驗證 watchdog 與 public probe

`publicProbe: true` 時，可以在第一份城市快照存在後手動執行 **Public network probe**，再查看 run summary：

- `healthy`：hard checks 與即時診斷皆正常。
- `realtime_degraded`：快照 hard checks 正常，但即時 TDX 路徑有 Yellow 警告；workflow 仍可能是綠色。
- `hard_failed`／`unknown`：workflow 失敗，需要查看第一個 failure class。

`windowWatchdog: true` 時，不要拿第一次 `window_type=manual` 的驗證 run 當作 scheduled window。Watchdog 檢查的是 03:17 排程所建立的窗口；等第一個自動排程窗口在 07:30 關閉後，再查看 07:45 的 **Snapshot window watchdog** 結果。

### 新增城市的安全順序

之後每次加入新城市，都一次處理一個：

1. 修改 `enabledCities`，並確認 `defaultCity`、`demoQuery` 仍合法。
2. 執行 validate、compile 與 provision plan。
3. commit 並 push。
4. 等 **Deploy** 完成，確認新版 Worker 已接受該城市。
5. 立刻手動執行 **Sync transit snapshots**，只選擇新城市，`window_type=manual`。
6. 確認新城市的 routes API 有資料，再加入下一個城市。

手動 workflow 必須在所選執行 branch 的 `instance.json` 啟用該城市；本篇使用 `main`，因此必須先 push。但 Worker 部署完成到快照發布完成之間，新城市可能短暫出現在設定中卻沒有路線資料。一次只加一城並立即發布，可以縮短這個空窗。

不要在 Deploy 尚未完成時同時啟動新城市 Sync；snapshot smoke 可能仍打到舊 Worker，導致 `city_not_enabled` 或其他假失敗。

## 9. 依失敗步驟判斷影響範圍

### Deploy workflow 失敗

先確認：

- repository 根目錄有已提交的 `instance.json`
- `CLOUDFLARE_DEPLOY_API_TOKEN` 存在
- `CLOUDFLARE_ACCOUNT_ID` 屬於正確帳號
- D1、R2 與 Worker 名稱仍和 instance 一致

再看紅色步驟發生在哪裡：

- **Preflight deployment resources** 或 **Verify release candidate** 失敗：尚未上傳新版 Worker。
- **Deploy Worker** 失敗：新版通常沒有完整部署，舊 Worker 通常仍在，但仍應打開公開網址確認。
- **Run true post-deploy release smoke** 失敗：新版 Worker 已經完成 deploy，可能正在對外服務；workflow 變紅不代表自動 rollback，也不代表仍是舊版。

看到 post-deploy smoke 失敗時，先確認公開網址、release SHA 與 smoke evidence，不要只重新 Run workflow 或直接刪除 Worker。

### Snapshot workflow 失敗

先確認：

- repository 根目錄有已提交的 `instance.json`
- 六個快照 Secrets 都存在
- `SNAPSHOT_SMOKE_BASE_URL` 是正確的公開網址
- R2 credentials 有目標 bucket 的 Object Read & Write 權限
- `profile` 與 `snapshotSchedule` 組合合法
- `enabledCities` 包含要發布的城市

Snapshot workflow 會先套用 D1 migration，再建置與發布快照。後段失敗時，migration 可能已經成功套用；不要以為整次 workflow 完全沒有改變遠端狀態。

看到 `state_write_failed_reconcile_required` 或 `cleanup_failed` 時，保留完整 log，不要假設重新 Run workflow 一定能修復。若目前 active snapshot 仍健康，先保留服務，再依 repository 的 publishing／rollback runbook 處理。

### Watchdog 或 public probe 失敗

- Watchdog 只判斷窗口與 active snapshot 證據，不會自動補跑 Sync。
- Public probe 只從公開網路檢查，不會自動修復或 rollback。
- `realtime_degraded` 是 Yellow，可能不會觸發失敗通知；要定期查看 summary。
- 若 scheduled workflow 整次沒有建立 run，Actions 也不會產生一個「失敗」來通知你；看到資料過期時仍要檢查 workflow 是否被停用。

進階狀態與查詢方式可參考：

- [Snapshot window watchdog](operations/snapshot-window-watchdog.md)
- [Public network probe](operations/public-network-probe.md)
- [Transit snapshot publishing](operations/transit-snapshot-publishing.md)
- [Transit snapshot rollback authority](operations/transit-snapshot-rollback-authority.md)

## 10. 日後變更時要同步更新什麼

Fork 不會自動替你完成：

- Cloudflare D1、R2 和 Worker 的第一次建立
- Repository Secrets 與 Variables
- 自訂網域
- API rate limit
- 要啟用哪些城市
- snapshot 更新頻率
- Secret 輪替
- upstream 更新的安全檢查與衝突處理

### 更換公開網域

從 `workers.dev` 改成自訂網域，或更換既有網域時，至少同步確認：

```text
RELEASE_SMOKE_ORIGIN
SNAPSHOT_SMOKE_BASE_URL
instance.json 的 site.canonicalOrigin（只有使用固定 origin 時）
Cloudflare route／custom domain 權限
```

只改 Cloudflare 網域、沒有更新兩個 GitHub Variables，Deploy smoke、snapshot smoke 或 public probe 會繼續打舊網址。

### 每個 push 都可能部署

Deploy workflow 沒有 path filter。同步 upstream、修改 README 或只調整文件，只要 push 到 fork 的 `main`，都會重新執行完整檢查與部署。

Fork 的作用是提供長期維護與自動化的容器，不是按一下就完成所有部署。

## 11. 暫停自動化或移除服務

只想停止城市資料自動更新、但保留網站時：

- 停用 **Sync transit snapshots**。
- 同時停用 **Snapshot window watchdog**，否則它會持續把缺少更新判成 missing／failed。
- **Public network probe** 可以選擇保留來監測既有網站，但它仍會產生公開請求與少量 TDX 即時用量。

準備刪除 Cloudflare 資源或停止整套服務時，先到自己的 fork，依序停用：

1. **Sync transit snapshots**
2. **Snapshot window watchdog**
3. **Public network probe**
4. **Deploy**

確認沒有仍在執行中的相關 workflow run，再刪除 Worker、D1 或 R2。

接著依[手動自架教學的移除服務清單](SELF-HOSTING.md#移除服務與停止可能的費用)刪除不再使用的 Cloudflare 資源。完成後再移除 fork 中不再需要的 Repository Secrets 與 Variables，並撤銷：

- Cloudflare deploy API token
- 快照與監測使用的 Cloudflare API token
- R2 Access Key ID／Secret Access Key
- 不再使用的 TDX API 金鑰

刪除 GitHub repository 或 Cloudflare Worker，不會自動撤銷其他平台上的 token，也不會自動清空 R2 bucket。

## 12. 安全同步 Mochi Bus upstream 更新

自己的 fork 和原始 Mochi Bus 是兩個 repository。原始專案更新後，fork 不會自動合併所有修改。

> [!WARNING]
> 你的 fork 已保存 Cloudflare 與 TDX Secrets。進入 default branch 的 workflow 或它所執行的 scripts，都可能在 workflow run 中使用這些 Secrets。不要在沒有檢查 `.github/workflows/`、`scripts/`、`package.json`、`package-lock.json` 與 action SHA 變更時，直接把 upstream 更新送進會自動部署的 `main`。

目前 Deploy 會在 `main` 更新後立刻啟動。因此「先 Sync fork，再到本機驗證」的順序太晚：驗證尚未完成時，生產部署可能已經開始。

較安全、也最容易理解的做法：

1. 在 Actions 暫時停用：
   - Deploy
   - Sync transit snapshots
   - Snapshot window watchdog
   - Public network probe
2. 打開自己的 fork 首頁，確認目前分支是 `main`。
3. 選擇 **Sync fork**，先查看 GitHub 顯示的 upstream commits。
4. 沒有無法接受的內容或衝突時，選擇 **Update branch**。
5. 在本機 fork 資料夾執行：

```sh
git pull --ff-only
npm install
npm run instance:validate -- --config instance.json
npm run instance:compile -- --config instance.json
npm run instance:provision-plan -- --config instance.json
npm run check
```

6. 再次確認：

```sh
git status --short
```

不應因安裝或編譯產生需要提交的未知檔案，也不應出現 `.dev.vars` 或 `.snapshot.env`。

7. 先重新啟用 **Deploy**，手動執行一次並確認成功。
8. Deploy 成功後，再重新啟用需要的 scheduled workflows。

停用期間錯過的排程不會自動補跑。重新啟用後，依城市狀態手動補跑 Sync，並確認 watchdog／public probe 的下一次結果。

若 GitHub 要求建立 pull request 解決衝突，先保持 workflows 停用並逐項處理；不要使用 force update 或 `git reset --hard` 覆蓋自己的 `instance.json`。

GitHub 的完整操作說明請見 [Syncing a fork](https://docs.github.com/en/pull-requests/how-tos/work-with-forks/syncing-a-fork)。

## 完成標誌

完成本篇後應符合：

- [ ] repository 根目錄的 `instance.json` 已提交到自己的 fork
- [ ] `.dev.vars` 和 `.snapshot.env` 沒有提交
- [ ] Deploy token 使用指定 account，並具備 Workers Scripts Write、D1 Read 與 Workers R2 Storage Read
- [ ] `RELEASE_SMOKE_ORIGIN` 已設定
- [ ] Deploy workflow 已啟用並可手動成功執行
- [ ] 知道任何 push 到 `main` 都會重新部署 Worker
- [ ] 若啟用城市資料自動更新：快照 token、六個 Secrets 與 `SNAPSHOT_SMOKE_BASE_URL` 已設定
- [ ] 已依城市數量選擇 `daily` 或 `taipei-weekly-sharded`
- [ ] 已明確決定是否啟用 `publicProbe` 與 `windowWatchdog`
- [ ] 對應的 Sync、watchdog 與 public probe workflows 都已啟用
- [ ] Sync transit snapshots 已以 `window_type=manual` 成功發布 `Chiayi`
- [ ] 每個新加入的城市都已依序完成 Deploy、手動 Sync 與公開 API 驗證
- [ ] 第一個 scheduled window 結束後，watchdog 結果符合預期
- [ ] Public probe summary 沒有被忽略的 `realtime_degraded`
- [ ] GitHub Actions 失敗通知已開啟
- [ ] 已知道 scheduled workflow 可能延遲、停用或漏跑，且不會自動補跑
- [ ] 公開網址與城市 API 驗證正常

需要回頭檢查第一次部署、費用、刪除服務或一般錯誤時，請回到[部署自己的 Mochi Bus](SELF-HOSTING.md)。
