# 用 fork 啟用自動部署與城市資料更新

這份教學接續[部署自己的 Mochi Bus](SELF-HOSTING.md)。

請先完成手動 starter 部署，確認 Worker、D1、R2 和第一份城市快照都能正常運作，再開始設定自動化。

自動化分成兩件不同的事：

```text
程式碼有更新
    └── Deploy workflow
        └── 重新部署 Worker

公車資料需要更新
    └── Sync transit snapshots workflow
        └── 重新發布城市快照
```

兩者使用不同的 Secrets，也可以分開啟用：

- 只設定 Deploy workflow，不會自動更新城市資料。
- 只設定快照 workflow，不會替你同步或部署新版程式碼。
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
> 公開 repository 的 fork 預設不執行 workflows。先完成本篇的 Cloudflare Tokens、Repository Secrets 和 Variables，再提交 `instance.json`、啟用 Actions 並手動驗證。這樣可以避免第一個 Deploy 因缺少憑證而失敗。

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
npm install
```

`git clone` 會在終端機目前位置建立新的 `mochi-bus-fork` 子資料夾，不會把 repository 檔案散落到上層資料夾，也不需要先執行 `cd ..`。

接著把原本資料夾中的 `instance.json` 複製到新資料夾根目錄。

若還要在新資料夾繼續手動部署或發布快照，也可以在本機複製 `.dev.vars` 和 `.snapshot.env`；它們仍然不可提交。

## 2. 把 instance 設定放進 fork 專案

操作位置：VS Code 編輯器與終端機

確認新資料夾根目錄存在：

```text
instance.json
```

先驗證：

```sh
npm run instance:validate -- --config instance.json
npm run instance:compile -- --config instance.json
```

再查看目前的 Git 狀態：

```sh
git status --short
```

此時可以看到尚未提交的 `instance.json`。不應看到 `.dev.vars` 或 `.snapshot.env`；若看到它們，先停止，不要繼續。

`instance.json` 不是 Secret，可以提交；它會保存 Worker、D1、R2、城市與操作模式等設定。這一步先不要執行 `git add`、`git commit` 或 `git push`，等 Tokens、Secrets 和 Variables 都設定完成後再一起提交。

## 3. 讓 workflows 找到 instance 設定

目前的 Deploy 與 Sync transit snapshots workflows 會自動尋找 repository 根目錄的：

```text
instance.json
```

因此本篇固定把 instance 設定放在根目錄，**不需要另外建立 `MOCHI_BUS_INSTANCE_CONFIG` Repository Variable**。

若把檔案移到 `instances/...` 等其他路徑，現有 workflows 不會只因為建立同名 GitHub Variable 就自動讀取它；還必須修改 workflow，將該 Variable 明確傳入 `MOCHI_BUS_INSTANCE_CONFIG` 環境變數。這屬於自訂 workflow 的進階路線，本篇不採用。

## 4. 設定 Push 後自動部署 Worker

Deploy workflow 會在 fork 的 `main` 收到 push 時執行，也可以從 GitHub Actions 手動啟動。

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

需要確認目前 instance 還缺哪些操作設定時，可以在本機執行：

```sh
npm run instance:provision-plan -- --config instance.json
```

完整規格也可參考 [Instance provisioning plan](INSTANCE_PROVISIONING.md)。

### 建立 Repository Secrets

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

本篇從 starter 接續，而 starter 預設啟用 release smoke，因此還必須建立 Repository Variable：

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
3. 在本機 fork 資料夾重新執行：

```sh
npm run deploy -- --secrets-file .dev.vars
```

只更新 GitHub Secrets 時，快照可能恢復正常，但公開網站查詢即時到站仍可能使用舊憑證；只重新部署 Worker 時，網站可能正常，但排程仍會因 GitHub Secrets 過期而失敗。

## 5. 設定城市資料自動更新

> 只需要 Push 後自動部署 Worker、不需要城市資料排程時，可以跳過第 5、6 節，直接前往第 7 節。保留 `profile: "starter"` 與 `snapshotSchedule: "manual"`，也不需要建立快照 workflow 的 Token、Secrets 或 `SNAPSHOT_SMOKE_BASE_URL`。

`Sync transit snapshots` workflow 可以：

- 依 instance 設定的排程發布城市資料
- 從 GitHub Actions 手動選擇一個城市
- 發布前套用 D1 migration
- 發布後從公開網址執行 smoke 驗證

### 建立快照 workflow Secrets

操作位置：Cloudflare Dashboard 與自己的 fork → GitHub Settings

先在 Cloudflare Dashboard 建立另一組供 migration、D1 快照狀態與 R2 bucket preflight 使用的 API token。Account permissions 至少包含：

```text
D1 Write
Workers R2 Storage Read
```

- **D1 Write：** 套用 migration，並讀寫快照窗口與狀態資料。
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

## 6. 從 starter 升級為 managed 排程（需要自動更新城市資料才做）

> [!WARNING]
> **TDX 免費額度不保證足以每天更新全台資料。**
>
> 快照工具會下載各個啟用城市的路線、站牌、站序、線形與班表。TDX 公車 API 說明列有計次與計量兩種換算基準，目前分別為每 1 點 1,500 次與 150 MB；實際扣點方式、存取頻率與可用額度仍依訂閱方案及 TDX 會員中心顯示為準。
>
> 若把全台縣市都加入 `enabledCities` 並設定每日更新，資料量、重試或其他 TDX API 使用都可能讓免費額度不足。建議先從實際需要的少數城市開始，在 TDX 會員中心觀察用量後再逐步增加；城市較多時，優先考慮每週分片排程。
>
> TDX 的額度、計點與方案可能調整，設定前請查看 [TDX 公車 API 說明](https://tdx.transportdata.tw/api-service/swagger) 與會員中心的最新資訊。

Starter profile 強制使用：

```json
"profile": "starter",
"snapshotSchedule": "manual"
```

即使 fork 已建立、Secrets 也全部填好，`manual` 仍代表不會自動發布城市快照。

Managed profile 可以依城市數量選擇兩種自動排程：

| `snapshotSchedule` | 行為 | 建議用途 |
|---|---|---|
| `daily` | 每天處理所有 `enabledCities` | 只有少數城市，而且確實需要每日更新 |
| `taipei-weekly-sharded` | 將啟用城市分散在一週七天，每個城市每週處理一次 | 城市較多或接近全台 |

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

修改後執行：

```sh
npm run instance:validate -- --config instance.json
npm run instance:compile -- --config instance.json
npm run instance:provision-plan -- --config instance.json
```

Provisioning plan 可以再次列出 managed 自動化仍缺少的 Secrets、Variables 或操作條件。先不要 push，下一步會在所有設定完成後一起提交。

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

公開 repository 的 fork 預設不執行 workflows。Push 完成後：

1. 打開自己的 fork。
2. 選擇 **Actions**。
3. 若出現停用提示，選擇 **I understand my workflows, go ahead and enable them** 或 **Enable workflows**。
4. 打開 **Deploy**，確認可以看到 **Run workflow**。
5. 只有設定城市資料自動更新時，才需要再打開 **Sync transit snapshots**；若顯示 **Enable workflow**，選擇它並確認可以看到 **Run workflow**。

公開 fork 的 scheduled workflows 預設停用；公開 repository 連續 60 天沒有活動時，排程也可能再次被 GitHub 自動停用。之後發現城市資料沒有更新時，先到 Actions 確認 **Sync transit snapshots** 仍為 enabled。詳細行為可參考 [GitHub 的 workflow 啟用說明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)。

> [!NOTE]
> `Sync transit snapshots` 預定每天在台北時間 03:17 啟動。GitHub Actions 的排程可能因平台負載延遲，不保證精確在該分鐘開始。使用 `taipei-weekly-sharded` 時，workflow 仍每天啟動，但只處理當天被分配到的啟用城市。

> 若你在設定 Secrets 前就提早啟用 Actions，第一次 push 可能已產生一個失敗的 Deploy。這不代表原本線上的 Worker 被刪除；完成本篇設定後，手動重新執行即可。

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

每次把新的城市加入 `enabledCities` 後，都先用 `window_type=manual` 單獨成功執行一次，再交給 `daily` 或 `taipei-weekly-sharded` 排程。不要一次加入許多城市後，只用 Chiayi 判斷全部城市都能正常發布。

完成後再讓 managed profile 依選定的排程持續運作。

## 9. 兩種自動化各自失敗時怎麼判斷

### Deploy workflow 失敗

先確認：

- repository 根目錄有已提交的 `instance.json`
- `CLOUDFLARE_DEPLOY_API_TOKEN` 存在
- `CLOUDFLARE_ACCOUNT_ID` 屬於正確帳號
- D1、R2 與 Worker 名稱仍和 instance 一致

Deploy 失敗不一定會讓目前線上的舊 Worker 消失。先查看第一個失敗步驟，不要急著刪除 Cloudflare 資源。

### Snapshot workflow 失敗

先確認：

- repository 根目錄有已提交的 `instance.json`
- 六個快照 Secrets 都存在
- `SNAPSHOT_SMOKE_BASE_URL` 是正確的公開網址
- R2 credentials 有目標 bucket 的 Object Read & Write 權限
- `profile` 與 `snapshotSchedule` 組合合法
- `enabledCities` 包含要發布的城市

看到 `state_write_failed_reconcile_required` 或 `cleanup_failed` 時，保留完整 log，不要假設重新 Run workflow 一定能修復。

## 10. Fork 之後仍要自己決定的事

Fork 不會自動替你完成：

- Cloudflare D1、R2 和 Worker 的第一次建立
- Repository Secrets 與 Variables
- 自訂網域
- API rate limit
- 要啟用哪些城市
- snapshot 更新頻率
- Secret 輪替
- upstream 更新發生衝突時如何處理

Fork 的作用是提供長期維護與自動化的容器，不是按一下就完成所有部署。

## 11. 停止自動化或移除服務

只想停止城市資料自動更新、但保留網站時，可以停用 **Sync transit snapshots** workflow；Deploy workflow 與目前線上的 Worker 不受影響。

準備刪除 Cloudflare 資源或停止整套服務時，先到自己的 fork：

1. 選擇 **Actions → Sync transit snapshots**。
2. 從右上角的 `…` 選單選擇 **Disable workflow**。
3. 再到 **Actions → Deploy**，同樣選擇 **Disable workflow**。
4. 確認沒有仍在執行中的相關 workflow run。

先停用 workflows，可以避免刪除 Worker、D1 或 R2 後，排程仍繼續啟動並反覆失敗或存取 TDX／Cloudflare。

接著依[手動自架教學的移除服務清單](SELF-HOSTING.md#移除服務與停止可能的費用)刪除不再使用的 Cloudflare 資源。完成後再移除 fork 中不再需要的 Repository Secrets 與 Variables，並撤銷：

- Cloudflare deploy API token
- 快照使用的 Cloudflare API token
- R2 Access Key ID／Secret Access Key
- 不再使用的 TDX API 金鑰

刪除 GitHub repository 或 Cloudflare Worker，不會自動撤銷其他平台上的 token，也不會自動清空 R2 bucket。

## 12. 同步 Mochi Bus upstream 更新

自己的 fork 和原始 Mochi Bus 是兩個 repository。原始專案更新後，fork 不會自動合併所有修改。

> [!WARNING]
> 你的 fork 已保存 Cloudflare 與 TDX Secrets。同步 upstream 前，先查看即將加入的 commits，特別是 `.github/workflows/`、`scripts/`、`package.json` 和 `package-lock.json`。更新進入 fork 的 `main` 後，Deploy workflow 可能會使用這些 Secrets 自動執行。

同步前先確認：

- `instance.json` 已提交
- 本機沒有尚未保存的重要修改
- `.dev.vars` 和 `.snapshot.env` 沒有進入 commit
- 已看過 upstream 更新的大致內容

最容易理解的是使用 GitHub 網頁：

1. 打開自己的 fork 首頁。
2. 確認目前分支是 `main`。
3. 選擇檔案列表上方的 **Sync fork**。
4. 查看 GitHub 顯示的 upstream commits。
5. 沒有衝突且內容符合預期時，選擇 **Update branch**。
6. 若 GitHub 要求建立 pull request 解決衝突，先停止自動部署並逐項處理；不要使用 force update 或 `git reset --hard` 覆蓋自己的 `instance.json`。

GitHub 的完整操作說明請見 [Syncing a fork](https://docs.github.com/en/pull-requests/how-tos/work-with-forks/syncing-a-fork)。

網頁同步完成後，在本機 fork 資料夾執行：

```sh
git pull --ff-only
npm install
npm run instance:validate -- --config instance.json
npm run instance:compile -- --config instance.json
npm run instance:provision-plan -- --config instance.json
```

最後回到 Actions 檢查這次更新觸發的 Deploy。若 pull 顯示有本機修改、無法 fast-forward 或出現衝突，先確認改過哪些檔案，不要為了更新直接執行 `git reset --hard`。

## 完成標誌

完成本篇後應符合：

- [ ] repository 根目錄的 `instance.json` 已提交到自己的 fork
- [ ] `.dev.vars` 和 `.snapshot.env` 沒有提交
- [ ] Deploy token 使用指定 account，並具備 Workers Scripts Write、D1 Read 與 Workers R2 Storage Read
- [ ] `RELEASE_SMOKE_ORIGIN` 已設定
- [ ] Deploy workflow 已啟用並可手動成功執行
- [ ] Push 到 `main` 後會重新部署 Worker
- [ ] 若啟用城市資料自動更新：快照 token、六個 Secrets 與 `SNAPSHOT_SMOKE_BASE_URL` 已設定
- [ ] 若啟用城市資料自動更新：已依城市數量選擇 `daily` 或 `taipei-weekly-sharded`
- [ ] 若啟用城市資料自動更新：Sync transit snapshots 已啟用，並以 `window_type=manual` 成功發布 `Chiayi`
- [ ] 每個新加入的城市都已先手動成功發布一次
- [ ] 若使用 managed profile：排程會處理已啟用城市
- [ ] 公開網址與城市 API 驗證正常

需要回頭檢查第一次部署、費用、刪除服務或一般錯誤時，請回到[部署自己的 Mochi Bus](SELF-HOSTING.md)。