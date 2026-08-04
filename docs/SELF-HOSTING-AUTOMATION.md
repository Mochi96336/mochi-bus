# 用 fork 啟用自動部署與城市資料更新

這份教學接續[部署自己的 Mochi Bus](SELF-HOSTING.md)。

請先完成手動 starter 部署，確認 Worker、D1、R2 和第一份嘉義市快照都能正常運作，再開始設定 GitHub Actions。

Mochi Bus 有四個與自架維運直接相關的 workflows：

| Workflow | 作用 | 觸發方式 |
|---|---|---|
| **Deploy** | 驗證並部署 Worker，之後執行 release smoke | push 到 fork 的 `main`，或手動執行 |
| **Sync transit snapshots** | 下載 TDX 資料並發布城市快照 | 台北時間每日 03:17，或手動執行 |
| **Snapshot window watchdog** | 檢查排程快照是否留下可信結果 | 台北時間每日 07:45，或手動執行 |
| **Public network probe** | 從公開網址檢查快照與部分即時資料路徑 | 台北時間每日 08:20，或手動執行 |

它們不會互相代替：

- Deploy 不會更新城市資料。
- Sync 不會替你同步 upstream 或部署新版程式碼。
- Watchdog 和 public probe 只負責檢查與記錄，**不會自動重跑、修復或 rollback**。
- Fork 不會自動建立 Cloudflare 資源，也不會搬移本機 Secret。

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
> Deploy 會在 `main` 收到 push 時執行。請先設定本篇需要的 Tokens、Secrets 和 Variables，再提交並 push `instance.json`，避免第一個 Deploy 在缺少憑證時啟動。

## 1. 建立 fork 並放入自己的 instance

操作位置：GitHub、VS Code 與終端機

1. 打開 `Mochi96336/mochi-bus` repository。
2. 選擇 **Fork**。
3. 選擇自己的 GitHub 帳號作為 Owner。
4. 建立 fork。

Fork 是放在自己帳號下、可以獨立設定 Secrets 與 Actions 的 repository 副本。它不是新的 Cloudflare 服務，也不會影響已經手動部署的 Worker。

### 重新 clone fork

先用 VS Code 開啟準備存放專案的上層資料夾，例如：

- Windows：`C:\Users\你的名稱\Projects` 或 `D:\Projects`
- macOS / Linux：`~/Projects`

再開啟終端機，把 `YOUR_GITHUB_USERNAME` 換成自己的 GitHub 使用者名稱：

```sh
git clone https://github.com/YOUR_GITHUB_USERNAME/mochi-bus.git mochi-bus-fork
cd mochi-bus-fork
```

`git clone` 會建立新的 `mochi-bus-fork` 子資料夾，不會把 repository 檔案散落到上層資料夾。

### 先複製 `instance.json`，再安裝依賴

`npm install` 會執行 repository 的 `prepare` script 並編譯 instance。若自己的 `instance.json` 還沒放進 fork，工具會暫時改用 repository 內建的 production manifest。它不會因此部署 Mochi 正式服務，但 `.generated/instance/` 會指向錯誤的設定，容易造成誤解。

先把原本手動部署資料夾中的 `instance.json` 複製到 `mochi-bus-fork` 根目錄。可以用 VS Code Explorer；若兩個資料夾正好相鄰且名稱為 `mochi-bus`、`mochi-bus-fork`，也可以執行：

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
npm run instance:validate -- --config instance.json
npm run instance:compile -- --config instance.json
npm run instance:provision-plan -- --config instance.json
```

若還要在新資料夾繼續手動部署或發布快照，可以在本機複製 `.dev.vars` 和 `.snapshot.env`；它們仍然不可提交。

最後檢查：

```sh
git status --short
```

此時可以看到尚未提交的 `instance.json`。不應看到 `.dev.vars` 或 `.snapshot.env`；若看到它們，先停止，不要繼續。

`instance.json` 不是 Secret，可以提交。它保存 Worker、D1、R2、城市與操作模式等設定。

## 2. 設定 Push 後自動部署 Worker

### 建立 Cloudflare deploy token

操作位置：Cloudflare Dashboard

建立一組只供 GitHub Actions 部署使用的 Cloudflare API token。不要使用 Global API Key、R2 S3 Secret Access Key，或把本機 Wrangler login 當成 deploy token。

可以從 **Edit Cloudflare Workers** template 開始，再確認 Account permissions 至少包含：

```text
Workers Scripts Write
D1 Read
Workers R2 Storage Read
```

- **Workers Scripts Write：** 上傳與更新 Worker。
- **D1 Read：** Deploy preflight 確認 D1 名稱與 ID。
- **Workers R2 Storage Read：** Deploy preflight 確認 R2 bucket 身分。

Account Resources 只選擇實際部署 Mochi Bus 的 Cloudflare account。第一次使用 `workers.dev` 不需要加入自訂網域的 Zone 權限；日後綁定 route 時再依需要增加。

Cloudflare 可能調整權限名稱與 template，建立前可對照 [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) 與 [Workers GitHub Actions 指引](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)。

### 建立 Deploy 使用的 Repository Secrets 與 Variable

操作位置：自己的 fork → **Settings → Secrets and variables → Actions**

建立 Repository Secrets：

```text
CLOUDFLARE_DEPLOY_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

再到 **Variables** 建立：

```text
RELEASE_SMOKE_ORIGIN=https://你的公開網域
```

Starter 預設啟用 release smoke，因此這個 Variable 不能省略。使用 `workers.dev` 時，填入 Wrangler 實際顯示的完整網址，結尾不要加 `/`。

### Worker 的 TDX Secret 不會由 GitHub Deploy 重新設定

手動教學第一次執行：

```sh
npm run deploy -- --secrets-file .dev.vars
```

時，已把 TDX Client ID 和 Client Secret 保存到 Cloudflare Worker Secrets。

GitHub Deploy workflow 不會讀取你電腦裡的 `.dev.vars`，但既有 Worker Secrets 會繼續保留。只有更換 TDX 憑證時，才需要重新更新 Worker Secrets；做法見後面的「輪替 TDX 憑證」。

## 3. 選擇是否自動更新城市資料

只需要 Push 後自動部署 Worker 時，可以跳過本節，保留：

```json
"profile": "starter",
"snapshotSchedule": "manual"
```

此時不需要建立快照用 Secrets，也不需要啟用三個 scheduled workflows。

### 建立快照與監測使用的 Cloudflare token

需要自動更新城市資料時，建立另一組供 migration、D1 快照狀態、watchdog、public probe 與 R2 preflight 使用的 Cloudflare API token。Account permissions 至少包含：

```text
D1 Write
Workers R2 Storage Read
```

實際快照物件的上傳、讀取與刪除仍使用 R2 S3 credentials，不是這組 Cloudflare API token。

### 建立快照 Repository Secrets 與 Variable

建立以下 Repository Secrets：

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

R2 credentials 可以使用手動教學中建立的 bucket-scoped、Object Read & Write credentials。

`CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_DEPLOY_API_TOKEN` 用途不同，即使實際權限可能重疊，也不要因名稱相似而漏建。

> [!WARNING]
> GitHub Secrets 的 Value 只填真正的值，不要貼入 `NAME=value` 整行文字。

### 選擇快照排程

Managed profile 可以使用：

| `snapshotSchedule` | 行為 | 建議用途 |
|---|---|---|
| `daily` | 每天依序處理所有 `enabledCities` | 少數城市，而且確實需要每日更新 |
| `taipei-weekly-sharded` | 將城市分散在一週七天，每個城市每週處理一次 | 城市較多或接近全台 |

少數城市需要每日更新：

```json
"profile": "managed",
"snapshotSchedule": "daily"
```

城市較多時：

```json
"profile": "managed",
"snapshotSchedule": "taipei-weekly-sharded"
```

`Sync transit snapshots` 在同一個 job 中逐城處理，job 最長 180 分鐘。大量城市全部設成 `daily`，除了 TDX 額度，也可能遇到執行時間不足。

只改成自動排程、卻保留 `profile: "starter"`，會在 `instance:validate` 失敗。

> [!WARNING]
> **TDX 免費額度不保證足以支撐全台自動更新。**
>
> 快照工具會下載各個啟用城市的路線、站牌、站序、線形與班表。TDX 公車 API 目前列有計次與計量換算基準，基礎會員目前每月提供有限免費點數；實際扣點方式、存取頻率與可用額度以 TDX 會員中心為準。
>
> 網站使用者查詢即時到站、車輛與旅程估時也可能使用 TDX。啟用 `publicProbe` 後，workflow 每天還會透過公開 Worker 對每個啟用城市執行少量即時資料診斷，因此也會增加用量。
>
> 建議先從實際需要的少數城市開始，觀察用量後再增加；城市較多時優先使用每週分片。請查看 [TDX 公車 API 說明](https://tdx.transportdata.tw/api-service/swagger)、[TDX 首頁](https://tdx.transportdata.tw/)，以及會員中心的最新資訊。

### 決定是否啟用監測

從 starter 改成 managed，不會自動改寫其他欄位。只需要自動更新時，可以保留：

```json
"releaseSmoke": true,
"publicProbe": false,
"windowWatchdog": false
```

需要完整 managed 維運檢查時，改成：

```json
"releaseSmoke": true,
"publicProbe": true,
"windowWatchdog": true
```

- `windowWatchdog` 於每日 07:45 檢查已關閉的排程窗口，並在 D1 記錄自己的檢查結果；它不會補跑 Sync。
- `publicProbe` 於每日 08:20 從公開網址檢查所有啟用城市；它不會修復或 rollback。
- Public probe 的 `realtime_degraded` 是 Yellow，workflow 仍會成功；要查看 run summary 才會看見警告。
- `windowWatchdog: true` 不能搭配 `snapshotSchedule: "manual"`。

修改後再次執行：

```sh
npm run instance:validate -- --config instance.json
npm run instance:compile -- --config instance.json
npm run instance:provision-plan -- --config instance.json
```

## 4. 提交設定並啟用 Actions

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

若 `git push` 要求驗證，依 Git Credential Manager 開啟的瀏覽器完成登入，或使用 Personal Access Token。GitHub 帳號密碼不能用於 Git HTTPS push。

### 啟用 workflows

GitHub Actions 通常已在 repository 啟用；若 Actions 頁面顯示啟用提示，先依畫面操作。

公開 repository 被 fork 後，**scheduled workflows 預設停用**。到自己的 fork → **Actions**，依設定啟用：

- 使用自動快照：**Sync transit snapshots**
- `windowWatchdog: true`：**Snapshot window watchdog**
- `publicProbe: true`：**Public network probe**

Deploy 不是 scheduled workflow；確認 **Deploy** 頁面可以看到 **Run workflow**，並檢查剛才 push 產生的 run。

Scheduled workflows 只使用 default branch 上的 workflow 與 `instance.json`。本篇假設 default branch 是 `main`。

公開 repository 連續 60 天沒有活動時，GitHub 可能再次自動停用 scheduled workflows。排程也可能因平台負載延遲，負載很高時甚至可能被捨棄；重新啟用後不會自動補跑錯過的工作。可參考 [GitHub workflow 啟用說明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)與 [`schedule` 事件說明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。

### 打開 Actions 失敗通知

到 GitHub 個人設定：

```text
Settings
  → Notifications
  → System
  → Actions
```

選擇 **On GitHub** 或 **Email**，並可再選 **Only notify for failed workflows**。

Scheduled workflow 的通知會送給建立或修改其排程的使用者；若 workflow 曾停用再重新啟用，之後通知會送給重新啟用的人。完整說明見 [Managing GitHub Actions notifications](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications)。

## 5. 第一次驗證

### Deploy

1. 打開 **Actions → Deploy**。
2. 檢查剛才 push 的 run；若沒有 run，選擇 **Run workflow**。
3. 確認必要步驟通過。
4. 打開公開網址，確認網站正常。

### Sync transit snapshots

只有啟用城市資料自動更新時才做：

1. 打開 **Sync transit snapshots**。
2. 選擇 **Run workflow**。
3. `city` 選擇 `Chiayi`。
4. `force_publish` 保持 `false`。
5. `window_type` 選擇 `manual`。
6. `repair_legacy_previous` 保持 `false`，其他 repair 欄位留空。
7. 等待 workflow 完成。
8. 確認公開網站與以下 API 仍有嘉義市資料：

```text
/api/v1/map/cities
/api/v1/map/routes?city=Chiayi
```

### Public network probe

`publicProbe: true` 時，可以在快照存在後手動執行 **Public network probe**，再查看 run summary：

- `healthy`：hard checks 與即時診斷正常。
- `realtime_degraded`：快照 hard checks 正常，但即時資料有 Yellow 警告；workflow 仍可能是綠色。
- `hard_failed`／`unknown`：workflow 失敗，需要查看 failure class。

### Snapshot window watchdog

`windowWatchdog: true` 時，不要用 `window_type=manual` 的 run 驗證 watchdog。它檢查的是 03:17 排程建立的窗口；等第一個自動排程窗口在 07:30 關閉後，再查看 07:45 的結果。

### 新增城市的安全順序

每次加入新城市，一次處理一個：

1. 修改 `enabledCities`，並確認 `defaultCity`、`demoQuery` 仍合法。
2. 執行 validate、compile 與 provision plan。
3. commit 並 push。
4. 等 Deploy 完成，確認新版 Worker 已接受該城市。
5. 手動執行 Sync，只選擇新城市並使用 `window_type=manual`。
6. 確認新城市 routes API 有資料，再加入下一個城市。

不要在 Deploy 尚未完成時同時啟動新城市 Sync；snapshot smoke 可能仍打到舊 Worker，造成 `city_not_enabled` 等假失敗。

## 6. Workflow 失敗時先判斷遠端是否已改變

### Deploy 失敗

先查看第一個紅色步驟：

- **Preflight deployment resources** 或 **Verify release candidate**：尚未上傳新版 Worker。
- **Deploy Worker**：新版通常沒有完整部署，舊 Worker 通常仍在；仍應打開公開網址確認。
- **Run true post-deploy release smoke**：新版 Worker 已經 deploy，可能正在對外服務。Workflow 變紅不代表自動 rollback，也不代表仍是舊版。

Post-deploy smoke 失敗時，先確認公開網址、release SHA 與 smoke evidence，不要只重新 Run workflow 或刪除 Worker。

### Sync 失敗

Sync 會先套用 D1 migration，再建置與發布快照。後段失敗時，migration 可能已經成功套用；不要把整次失敗理解成「完全沒有改變遠端狀態」。

看到 `state_write_failed_reconcile_required` 或 `cleanup_failed` 時，保留完整 log，不要假設重新執行一定能修復。若目前 active snapshot 仍健康，先保留服務，再依 runbook 處理。

### Watchdog 或 public probe 失敗

它們只會留下診斷，不會自動補跑 Sync、修復或 rollback。若 scheduled workflow 整次沒有建立 run，GitHub 也不會產生一個「失敗」來通知你；發現資料過期時仍要檢查 workflow 是否被停用。

進階狀態與操作方式：

- [Snapshot window watchdog](operations/snapshot-window-watchdog.md)
- [Public network probe](operations/public-network-probe.md)
- [Transit snapshot publishing](operations/transit-snapshot-publishing.md)
- [Transit snapshot rollback authority](operations/transit-snapshot-rollback-authority.md)

## 7. 日後維護

### 輪替 TDX 憑證

同一組 TDX 憑證分別供公開 Worker 與 Sync workflow 使用。更換 Client ID 或 Client Secret 時，兩邊都要更新：

1. 更新 fork 的 `TDX_CLIENT_ID`、`TDX_CLIENT_SECRET` Repository Secrets。
2. 更新本機 `.dev.vars`。
3. 確認本機 fork 是準備部署的版本：

```sh
git pull --ff-only
git status --short
npm install
npm run instance:validate -- --config instance.json
npm run instance:compile -- --config instance.json
```

4. 重新部署 Worker Secrets：

```sh
npm run deploy -- --secrets-file .dev.vars
```

這個指令不只更新 Secret，也會重新部署目前 checkout 的程式碼；不要在過期或未檢查的 branch 上執行。

只更新 GitHub Secrets 時，Sync 可能恢復正常，但公開網站仍使用舊憑證；只重新部署 Worker 時，網站可能正常，但排程仍會使用過期的 GitHub Secrets。

### 更換公開網域

從 `workers.dev` 改成自訂網域，或更換既有網域時，至少同步確認：

```text
RELEASE_SMOKE_ORIGIN
SNAPSHOT_SMOKE_BASE_URL
instance.json 的 site.canonicalOrigin（使用固定 origin 時）
Cloudflare route／custom domain 權限
```

只改 Cloudflare 網域、沒有更新 Variables，Deploy smoke、snapshot smoke 或 public probe 會繼續打舊網址。

### 暫停城市資料更新

保留網站、但停止自動更新時：

- 停用 **Sync transit snapshots**。
- 同時停用 **Snapshot window watchdog**，否則它會持續把缺少更新判成 missing／failed。
- **Public network probe** 可以保留來監測既有網站，但仍會產生公開請求與少量 TDX 即時用量。

### 移除整套服務

刪除 Cloudflare 資源前，先停用：

1. Sync transit snapshots
2. Snapshot window watchdog
3. Public network probe
4. Deploy

確認沒有仍在執行中的相關 run，再依[手動自架教學的移除清單](SELF-HOSTING.md#移除服務與停止可能的費用)刪除 Worker、D1 與 R2。

完成後移除不再需要的 Repository Secrets／Variables，並撤銷：

- Cloudflare deploy API token
- 快照與監測使用的 Cloudflare API token
- R2 Access Key ID／Secret Access Key
- 不再使用的 TDX API 金鑰

刪除 GitHub repository 或 Cloudflare Worker，不會自動撤銷其他平台上的 token，也不會自動清空 R2 bucket。

### 同步 upstream 更新

進入 fork `main` 的任何 push 都會觸發 Deploy，而且 workflow 與 scripts 可以使用已保存的 Secrets。同步 upstream 前，至少檢查：

```text
.github/workflows/
scripts/
package.json
package-lock.json
instance.json
```

最保守的簡單流程：

1. 暫時停用 Deploy 與三個 scheduled workflows。
2. 使用 GitHub **Sync fork**，確認沒有不能接受的 commits 或衝突後再更新。
3. 在本機 fork 執行：

```sh
git pull --ff-only
npm install
npm run instance:validate -- --config instance.json
npm run instance:compile -- --config instance.json
npm run instance:provision-plan -- --config instance.json
npm run check
git status --short
```

4. 重新啟用 Deploy，手動執行並確認成功。
5. Deploy 成功後，再重新啟用需要的 scheduled workflows。
6. 依城市狀態補跑停用期間錯過的 Sync。

不要為了消除衝突直接執行 `git reset --hard` 或 force update，避免覆蓋自己的 `instance.json`。GitHub 操作說明見 [Syncing a fork](https://docs.github.com/en/pull-requests/how-tos/work-with-forks/syncing-a-fork)。

## 完成標誌

### 所有人都應完成

- [ ] repository 根目錄的 `instance.json` 已提交到自己的 fork
- [ ] `.dev.vars` 和 `.snapshot.env` 沒有提交
- [ ] Deploy token 使用正確 account，且權限符合本篇說明
- [ ] `RELEASE_SMOKE_ORIGIN` 已設定
- [ ] Deploy workflow 已成功執行
- [ ] 公開網址可以正常使用
- [ ] GitHub Actions 通知方式已確認

### 啟用城市資料自動更新時才需要

- [ ] 六個快照 Secrets 與 `SNAPSHOT_SMOKE_BASE_URL` 已設定
- [ ] 已依需求選擇 `daily` 或 `taipei-weekly-sharded`
- [ ] Sync transit snapshots 已啟用
- [ ] 已以 `window_type=manual` 成功發布並驗證 Chiayi
- [ ] 已知道 scheduled workflow 可能延遲、停用或漏跑，且不會自動補跑

### 啟用 managed 監測時才需要

- [ ] `windowWatchdog`／`publicProbe` 的設定與實際啟用 workflow 一致
- [ ] 第一個 scheduled window 結束後，watchdog 結果符合預期
- [ ] Public probe summary 已檢查，沒有被忽略的 `realtime_degraded`

需要回頭檢查第一次部署、費用、刪除服務或一般錯誤時，請回到[部署自己的 Mochi Bus](SELF-HOSTING.md)。
