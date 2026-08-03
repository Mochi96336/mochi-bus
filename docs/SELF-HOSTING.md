# 部署自己的 Mochi Bus

`bus.moc96336.com` 是 Mochi 維護的公開實例。這一頁則是給想架自己版本的人。

先從最小的一套開始：一個縣市、一個 `workers.dev` 網址、手動更新資料。這裡用 `Chiayi`（嘉義市）當範例，資料量較小，比較適合第一次測試。

完成後，你會有自己的 Worker、D1、R2 和公開網址，不需要連回 `bus.moc96336.com` 才能運作。

大致會做四件事：

1. 產生 `instance.json`
2. 建立 D1 和 R2
3. 部署 Worker
4. 發布第一份城市快照

自訂網域、自動排程、多縣市和 operator profile 先放一邊。先確認最基本的一套真的架得起來。

## 準備

需要：

- [Node.js 22 以上](https://nodejs.org/)
- Git
- [Cloudflare 帳號](https://dash.cloudflare.com/sign-up)
- TDX Client ID 與 Client Secret

TDX 憑證可以從[會員中心](https://tdx.transportdata.tw/)取得；還沒有帳號可先[註冊](https://tdx.transportdata.tw/register/general)。位置在「會員中心 → 資料服務 → API 金鑰」。

接下來會在 Cloudflare 建立一個 Worker、一個 D1 database 和一個 R2 bucket。Cloudflare 的方案與額度可能調整，建立前請看一下自己帳號目前的計費設定。

## 1. 取得程式碼

只想先測一次，可以直接 clone upstream。打算長期維護或之後接 GitHub Actions，建議先 fork 再 clone 自己的 fork。

```sh
git clone https://github.com/Mochi96336/mochi-bus.git
cd mochi-bus
npm install
```

確認 Node.js 版本：

```sh
node --version
```

應為 `v22` 或更新版本。

接著登入 Cloudflare：

```sh
npx wrangler login
npx wrangler whoami
```

`whoami` 顯示的帳號，就是稍後建立 D1、R2 和 Worker 的帳號。有多個 Cloudflare 帳號時，先在這裡確認清楚。

## 2. 放入 TDX 憑證

建立 `.dev.vars`。

macOS / Linux：

```sh
cp .dev.vars.example .dev.vars
```

Windows PowerShell：

```powershell
Copy-Item .dev.vars.example .dev.vars
```

打開檔案，填入自己的值：

```dotenv
TDX_CLIENT_ID="你的 Client ID"
TDX_CLIENT_SECRET="你的 Client Secret"
```

`.dev.vars` 已被 Git 忽略。它稍後會同時用於 Worker secrets 和本機快照發布，不要提交到 repository，也不要把內容貼到 issue 或 PR。

## 3. 建立 instance 設定

```sh
npm run instance:init -- my-chiayi-bus \
  --cities Chiayi \
  --site-name "My Chiayi Bus"
```

Windows PowerShell：

```powershell
npm run instance:init -- my-chiayi-bus `
  --cities Chiayi `
  --site-name "My Chiayi Bus"
```

這個指令只會在本機建立 `instance.json`。成功時會看到類似：

```text
Created Mochi Bus instance manifest: instance.json
Profile: starter
Cities: Chiayi
Cloudflare: my-chiayi-bus / my-chiayi-transit / my-chiayi-transit-shapes
State: valid instance manifest
```

`instance.json` 是這套服務的來源設定，可以提交到自己的 repository。它不應包含任何 secret。

第一次產生時，D1 ID 會是 `null`：

```json
"d1": {
  "databaseName": "my-chiayi-transit",
  "databaseId": null
}
```

這是正常的，因為資料庫還沒建立。

先驗證並產生部署檔案：

```sh
npm run instance:validate -- --config instance.json
npm run instance:compile -- --config instance.json
```

接著看 provisioning plan：

```sh
npm run instance:provision-plan -- --config instance.json
```

它只會列出目前缺什麼，不會建立或修改遠端資源，輸出最後會顯示：

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

不要手動改 `.generated/instance/`。它可以隨時由 `instance.json` 重新產生。

## 4. 建立 D1 和 R2

以下兩個指令會真的在目前登入的 Cloudflare 帳號建立資源。名稱請以自己的 provisioning plan 為準。

先建立 D1：

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

再建立 R2 bucket：

```sh
npx wrangler r2 bucket create my-chiayi-transit-shapes
```

R2 不需要把另一個 ID 填回 manifest，bucket 名稱一致即可。

不確定剛才有沒有建立成功，可以先列出帳號裡的資源：

```sh
npx wrangler d1 list
npx wrangler r2 bucket list
```

不要為了重試而連續執行 `create`。先確認資源是否已存在。

填好 D1 ID 後，重新產生設定：

```sh
npm run instance:validate -- --config instance.json
npm run instance:compile -- --config instance.json
```

可以再跑一次 provisioning plan。它不一定會全綠，因為 GitHub Actions 和進階檢查還沒設定；D1 ID 與 generated artifacts 正確即可繼續。

## 5. 建立資料表

```sh
npx wrangler d1 migrations apply TRANSIT_DB \
  --remote \
  --config .generated/instance/wrangler.instance.jsonc
```

Windows PowerShell：

```powershell
npx wrangler d1 migrations apply TRANSIT_DB `
  --remote `
  --config .generated/instance/wrangler.instance.jsonc
```

Wrangler 可能會詢問是否套用 migration。繼續前，確認畫面中的 database 名稱是 `my-chiayi-transit`，或你自己在 manifest 裡設定的名稱。

若名稱或 ID 對不上，先停下來檢查 `npx wrangler whoami` 和 `instance.json`，不用急著刪掉資料庫重建。

## 6. 部署 Worker

第一次部署時，同時把 `.dev.vars` 裡的兩個 TDX secrets 上傳：

```sh
npm run deploy -- --secrets-file .dev.vars
```

這個指令會建置前端、上傳 Worker，並把 `TDX_CLIENT_ID`、`TDX_CLIENT_SECRET` 存成 Cloudflare Worker secrets。檔案內容不會寫進 repository。

成功後，Wrangler 會顯示一個網址，類似：

```text
https://my-chiayi-bus.<你的-subdomain>.workers.dev
```

先把它留著，下一步會用到。

現在打開網站，頁面應該能載入；還看不到完整路線和站牌是正常的，因為城市快照尚未發布。

`workers.dev` 的 Cache API 行為和自訂網域不同，但不影響這次 starter 部署。

## 7. 發布第一份城市快照

快照發布時需要知道剛才的公開網址。

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

這一步會下載 TDX 資料、在本機驗證、寫入 D1 和 R2，再從公開網站檢查新快照。第一次執行時終端機會有不少輸出，不要在中途關掉。

### 看到 R2 credentials 警告

Starter profile 可以先不建立 `.snapshot.env`。缺少 R2 S3 credentials 時，publisher 會改用較慢的 Wrangler 上傳方式；這個警告本身不代表失敗。

要長期維運、匯入大城市或改成自動排程時，再設定：

- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `CLOUDFLARE_ACCOUNT_ID`

前兩個值必須一起設定，不能只放其中一個。

## 8. 確認結果

先開：

```text
<公開網址>/api/v1/map/cities
```

例如：

```text
https://my-chiayi-bus.example.workers.dev/api/v1/map/cities
```

回應中的城市應只包含 `Chiayi`。

再回到網站確認：

- [ ] 首頁和地圖可以開啟
- [ ] 城市範圍只有嘉義市
- [ ] 看得到路線、線形和站牌
- [ ] 到站時間可以查詢
- [ ] 未啟用的縣市不會被當成可用城市
- [ ] 網站不需要向 `bus.moc96336.com` 取得執行資料

通過這些項目，就已經是一套能獨立運作的 Mochi Bus。完整的 release smoke 會檢查版本 tag、瀏覽器資產和較長的觀察窗口，留到 GitHub Actions 或 managed/operator 部署再使用，不列入第一次安裝。

## 常見問題

### 網站能開，但沒有路線

通常是快照還沒發布成功。確認同一個 terminal 已設定 `SNAPSHOT_SMOKE_BASE_URL`，再執行：

```sh
npm run snapshot:city -- Chiayi
```

### `Snapshot publisher requires a fixed public origin or SNAPSHOT_SMOKE_BASE_URL`

目前的 shell 沒有公開網址。重新設定 `SNAPSHOT_SMOKE_BASE_URL` 後再跑一次。

### `Missing TDX_CLIENT_ID or TDX_CLIENT_SECRET`

確認 repository 根目錄有 `.dev.vars`，兩個值都已替換，不是空字串或範例文字。

### `Snapshot publisher requires a provisioned D1 database ID`

檢查 `instance.json` 的 `cloudflare.d1.databaseId`。填好後還要重新編譯：

```sh
npm run instance:compile -- --config instance.json
```

### `city_not_enabled`

請求的城市不在 `instance.json` 的 `transit.enabledCities`。修改 manifest 後重新執行：

```sh
npm run instance:validate -- --config instance.json
npm run instance:compile -- --config instance.json
npm run deploy -- --secrets-file .dev.vars
```

新增城市後，還要另外發布該城市的快照。

### generated artifacts 過期

不要直接修 `.generated/instance/`：

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

## 哪些步驟可以重跑？

這些通常可以安全重跑：

```sh
npm run instance:validate -- --config instance.json
npm run instance:compile -- --config instance.json
npx wrangler d1 migrations apply TRANSIT_DB --remote --config .generated/instance/wrangler.instance.jsonc
npm run deploy -- --secrets-file .dev.vars
npm run snapshot:city -- Chiayi
```

這兩個則先確認資源不存在：

```sh
npx wrangler d1 create ...
npx wrangler r2 bucket create ...
```

## 移除這套服務

可以從 Cloudflare Dashboard 刪除：

1. Worker
2. D1 database
3. R2 bucket

R2 bucket 裡有快照時不能直接刪除，要先清空內容。刪除遠端資源不會動到本機的 `instance.json`。

## 接下來

目前還是要手動建立 D1/R2、貼回 D1 ID、記下公開網址，再發布第一份快照。後續的 `setup` 工具可以先從這幾步下手。

先別急著加全台排程。比較好的下一步，是換一個乾淨環境再走一次，確認沒有吃到原作者帳號或本機留下來的設定；通過後，再考慮自訂網域、第二個縣市、GitHub Actions 或 managed profile。
