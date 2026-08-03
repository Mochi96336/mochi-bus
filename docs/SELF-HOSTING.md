# 部署自己的 Mochi Bus

`bus.moc96336.com` 是 Mochi 維護的公開參考實例。這份教學會帶你從零開始，架出一套屬於自己的 Mochi Bus。

不需要先會寫程式。這篇會從安裝工具、打開專案、編輯設定，一路做到取得公開網址與發布嘉義市公車資料。

這次只走一條最容易檢查的路：

- 一個縣市：`Chiayi`（嘉義市）
- 一個 Cloudflare `workers.dev` 公開網址
- 手動更新公車資料

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
> R2 有每月免費額度，但啟用前仍要在 Cloudflare Dashboard 完成 R2 checkout，讓帳號具備可用的付款方式；實際畫面通常會要求信用卡等付款資料。
>
> 使用量保持在免費額度內時，R2 費用可以是 0；超過免費額度後會依實際用量計費。價格和免費額度可能調整，建立前請查看 [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)。
>
> 不希望加入付款方式時，可以使用本機模式體驗 Mochi Bus，但無法完成這篇的公開部署流程。

先到 Cloudflare Dashboard 完成：

```text
Storage & databases
        │
        ▼
R2 → Overview
        │
        ▼
完成 checkout
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

- **Worker**：Mochi Bus 真正上線執行的程式，負責網站和 API。
- **D1**：Cloudflare 的 SQL 資料庫，保存路線、站牌和資料版本等表格資料。
- **R2**：Cloudflare 的物件儲存空間，可以想成程式使用的雲端硬碟，保存地圖線形、時刻表和城市快照。

</details>

### 繼續前確認

- [ ] 已建立 Cloudflare 帳號
- [ ] 已完成 R2 checkout
- [ ] 已取得 TDX Client ID 與 Client Secret
- [ ] 電腦可以安裝 Git、Node.js 和文字編輯器

TDX 憑證位於「[TDX 會員中心](https://tdx.transportdata.tw/) → 資料服務 → API 金鑰」。還沒有帳號時，先完成[會員註冊](https://tdx.transportdata.tw/register/general)，再建立一組 API 金鑰。

## 1. 安裝需要的工具

需要：

- [Git](https://git-scm.com/downloads)
- [Node.js 22 以上](https://nodejs.org/)
- [Visual Studio Code](https://code.visualstudio.com/Download)（建議，但不是強制）

建議使用 VS Code，因為後面可以在同一個畫面：

- 看見所有專案檔案
- 編輯 `.dev.vars`、`.snapshot.env` 和 `instance.json`
- 打開內建終端機執行指令
- 避免 Windows 把 `.dev.vars` 存成 `.dev.vars.txt`

不需要安裝任何 VS Code extension。

<details>
<summary><strong>第一次安裝時該選哪些選項？</strong></summary>

- Node.js 下載頁選擇 **LTS** 版本，安裝選項保留預設即可。
- Git 安裝程式的選項保留預設即可。
- VS Code 使用 User Installer 或 System Installer 都可以。
- 不要把專案放進 `C:\Program Files` 等需要管理員權限的資料夾。

安裝完成後，完全關閉再重新開啟 VS Code，讓新安裝的 Git 和 Node.js 可以被找到。

</details>

### 打開 VS Code 終端機

1. 開啟 VS Code。
2. 從上方選單選擇 **Terminal → New Terminal**。
3. 畫面下方會出現可以輸入指令的區域。

Windows 預設通常是 PowerShell；macOS 和 Linux 通常是自己的系統 shell。後面灰色指令框中的文字，都是貼進這個終端機，再按 Enter 執行。

確認工具已安裝：

```sh
git --version
node --version
npm --version
```

應看到：

- Git 顯示版本號
- Node.js 顯示 `v22` 或更新版本
- npm 顯示版本號

若出現「找不到指令」，先完全關閉 VS Code 再重新開啟。

```text
Node.js
   └── 內含 npm

npm
   ├── 安裝 Mochi Bus 需要的工具
   └── 執行 Mochi Bus 已準備好的指令
```

<details>
<summary><strong>Node.js 和 npm 是什麼？</strong></summary>

Node.js 讓電腦可以執行 Mochi Bus 的建置和資料處理程式。

npm 會隨 Node.js 一起安裝。這篇主要使用：

- `npm install`：安裝專案需要的工具
- `npm run ...`：執行 Mochi Bus 已準備好的工作

你不需要自己撰寫 Node.js 程式。

</details>

## 2. 取得程式碼

先在 VS Code 終端機查看目前位置：

```sh
pwd
```

Windows PowerShell、macOS 和 Linux 都可以使用 `pwd`。Mochi Bus 會下載到這個位置。

接著執行：

```sh
git clone https://github.com/Mochi96336/mochi-bus.git
cd mochi-bus
```

`git clone` 會建立一個新的 `mochi-bus` 資料夾；`cd mochi-bus` 則會進入它。

從現在開始，除非教學另外說明，**所有指令都要在 `mochi-bus` 資料夾中執行**。

再次執行：

```sh
pwd
```

最後一段路徑應該是 `mochi-bus`。

### 用 VS Code 開啟整個專案資料夾

1. 選擇 **File → Open Folder**。
2. 找到剛才下載的 `mochi-bus` 資料夾。
3. 選擇 **Select Folder**；macOS 選擇 **Open**。
4. 若出現 Workspace Trust 提示，先確認這個資料夾是由上面的官方 `git clone` 指令取得。確認後選擇 **Yes, I trust the authors**，終端機和專案工具才會正常啟用。
5. 再選擇 **Terminal → New Terminal**。

左側 Explorer 現在應該會看到 `README.md`、`package.json`、`docs` 等檔案。新終端機的目前位置也應該是 `mochi-bus`。

> [!NOTE]
> 之後若關閉再重開 VS Code，請用 **File → Open Recent** 重新開啟 `mochi-bus`，不要只開一個單獨檔案。

<details>
<summary><strong>repository、clone 和 fork 是什麼？</strong></summary>

- **repository**：專案檔案和修改紀錄的集合
- **clone**：把 repository 下載到自己的電腦
- **fork**：在自己的 GitHub 帳號建立一份可獨立維護的副本

第一次跟著教學時直接 clone 官方 repository 最簡單，也不需要 GitHub 帳號。完成部署後，再研究 fork 和同步 upstream。

</details>

### 安裝專案工具

```sh
npm install
```

這個指令只會在目前資料夾安裝工具，不會部署網站，也不會建立 Cloudflare 資源。

完成時：

- 終端機會回到可以再次輸入指令的狀態
- 沒有出現 `npm ERR!`
- `npm WARN` 通常只是警告，不代表安裝失敗
- 結尾可能出現 Mochi production 名稱，這是第一次安裝的預設編譯，不代表連線或部署到正式站

## 3. 登入 Cloudflare

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

登入：

```sh
npx wrangler login
```

這通常會開啟瀏覽器。登入 Cloudflare，確認授權後回到 VS Code。

再確認目前登入的帳號：

```sh
npx wrangler whoami
```

完成時應顯示你的 Cloudflare 帳號資訊。稍後的 D1、R2 和 Worker 都會建立在這個帳號。

若 Wrangler 要你選擇帳號，選擇剛才完成 R2 checkout 的同一個帳號。

<details>
<summary><strong>npx 和 Wrangler 是什麼？</strong></summary>

- **Wrangler**：Cloudflare 官方提供的終端機工具
- **npx**：執行目前專案已安裝的 Wrangler

之後看到 `npx wrangler ...`，可以理解成：「請 Cloudflare 官方工具執行後面的操作。」

</details>

## 4. 放入 TDX 憑證

先複製範例檔，建立 `.dev.vars`。

macOS / Linux：

```sh
cp .dev.vars.example .dev.vars
```

Windows PowerShell：

```powershell
Copy-Item .dev.vars.example .dev.vars
```

### 用 VS Code 編輯 `.dev.vars`

1. 在左側 Explorer 找到 `.dev.vars`。
2. 點一下檔名開啟。
3. 把兩個範例值換成自己的 TDX 憑證。
4. 保留左右的引號。
5. 按 `Ctrl+S`；macOS 按 `Command+S` 儲存。

```dotenv
TDX_CLIENT_ID="你的 Client ID"
TDX_CLIENT_SECRET="你的 Client Secret"
```

> [!WARNING]
> `.dev.vars` 內含密碼性質的資料。不要把內容貼到 issue、PR、公開聊天或截圖，也不要提交到 repository。

`.dev.vars` 已被 Git 忽略，不會正常出現在 Git commit 裡。

<details>
<summary><strong>Client ID、Client Secret 和 secret 是什麼？</strong></summary>

可以把 Client ID 想成程式使用的帳號，把 Client Secret 想成這個程式帳號的密碼。

Secret 不應放在 `instance.json` 等公開設定，也不應提交到 GitHub。

</details>

## 5. 建立自己的 instance 設定

建立一套名為 `my-chiayi-bus`、只啟用嘉義市的設定：

```sh
npm run instance:init -- my-chiayi-bus --cities Chiayi --site-name "My Chiayi Bus"
```

這個指令只會在本機建立 `instance.json`，不會建立 Cloudflare 資源。

完成時應看到：

```text
Created Mochi Bus instance manifest: instance.json
Profile: starter
Cities: Chiayi
Cloudflare: my-chiayi-bus / my-chiayi-transit / my-chiayi-transit-shapes
State: valid instance manifest
```

名稱關係：

```text
Instance ID：my-chiayi-bus
       │
       ├── Worker：my-chiayi-bus
       ├── D1：my-chiayi-transit
       └── R2：my-chiayi-transit-shapes
```

第一次產生時，`instance.json` 裡的 D1 ID 會是 `null`。這是正常的，因為資料庫還沒建立。

先驗證並產生部署檔案：

```sh
npm run instance:validate -- --config instance.json
npm run instance:compile -- --config instance.json
```

兩個指令都沒有出現 error，並回到可輸入指令的狀態，就可以繼續。

```text
instance.json
     │
     │ validate + compile
     ▼
.generated/instance/
```

只修改 `instance.json`。不要手動修改 `.generated/instance/`，因為下次 compile 會重新產生它們。

<details>
<summary><strong>選用：查看完整 provisioning plan</strong></summary>

```sh
npm run instance:provision-plan -- --config instance.json
```

這個指令不會建立或修改遠端資源，但會列出 GitHub Actions、secrets 和其他進階項目。第一次手動部署時看到 `action_required` 或 `blocked` 不一定代表主流程失敗。

輸出最後應顯示：

```text
NO CHANGES WERE APPLIED
```

</details>

## 6. 建立 D1 和 R2

> [!WARNING]
> 從這一步開始，指令會真的在 Cloudflare 帳號建立遠端資源。先再確認一次帳號：
>
> ```sh
> npx wrangler whoami
> ```

### 建立 D1 database

- **操作位置：** Cloudflare
- **會建立資源：** 是
- **重跑前：** 先用 `npx wrangler d1 list` 確認是否已存在

```sh
npx wrangler d1 create my-chiayi-transit
```

完成時，Wrangler 會顯示一個 `database_id`，格式像：

```text
database_id = "12345678-abcd-1234-abcd-123456789012"
               └──────────────────────────────────┘
                    只複製引號裡的這一段
```

### 把 D1 ID 填回 `instance.json`

1. 在 VS Code 左側點開 `instance.json`。
2. 按 `Ctrl+F`；macOS 按 `Command+F`。
3. 搜尋 `"databaseId": null`。
4. 只把 `null` 換成剛才的 ID，並保留引號和逗點。
5. 儲存檔案。

修改前：

```json
"databaseId": null
```

修改後：

```json
"databaseId": "12345678-abcd-1234-abcd-123456789012"
```

### 建立 R2 bucket

- **操作位置：** Cloudflare
- **會建立資源：** 是
- **可能計費：** 超過 R2 免費額度時
- **重跑前：** 先用 `npx wrangler r2 bucket list` 確認是否已存在

```sh
npx wrangler r2 bucket create my-chiayi-transit-shapes
```

完成時應顯示 bucket 已建立。R2 不需要把另一個 ID 填回 `instance.json`。

可以用以下指令確認兩個資源：

```sh
npx wrangler d1 list
npx wrangler r2 bucket list
```

列表中應看到：

- `my-chiayi-transit`
- `my-chiayi-transit-shapes`

不要為了重試而連續執行 `create`。如果看到同名資源，先確認它是不是剛才建立的。

<details>
<summary><strong>為什麼資料要分成 D1 和 R2？</strong></summary>

D1 適合保存需要查詢和互相關聯的表格資料，例如路線、站牌與站序。

R2 適合保存完整的大型檔案，例如 GeoJSON 線形、時刻表和城市路網檔案。

Worker 會把兩邊的資料組合成網站和 API 回應。

</details>

填好 D1 ID 後，重新驗證並產生設定：

```sh
npm run instance:validate -- --config instance.json
npm run instance:compile -- --config instance.json
```

沒有出現 error 就可以繼續。

## 7. 建立 R2 發布憑證

城市快照會從你的電腦直接寫入 R2，因此還需要一組只給快照工具使用的 R2 credentials。

> [!WARNING]
> Secret Access Key 只會在建立 token 後顯示一次。建立後立刻複製到 `.snapshot.env`，不要貼到公開地方。

### 在 Cloudflare 建立 R2 API token

1. 打開 Cloudflare Dashboard。
2. 進入 **Storage & databases → R2 → Overview**。
3. 在 **Account Details** 找到 **API Tokens**，選擇 **Manage**。
4. 一般個人帳號可選擇 **Create User API token**；只有需要帳號層級 token 時才選 **Create Account API token**。
5. 權限選擇 **Object Read & Write**。
6. 將可存取的 bucket 限制為 `my-chiayi-transit-shapes`。
7. 建立 token。
8. 立即複製畫面上的：
   - Access Key ID
   - Secret Access Key

Account ID 不是 Access Key ID。它通常可以在同一頁的 **Account Details** 或 R2 S3 endpoint 中找到：

```text
https://ACCOUNT_ID.r2.cloudflarestorage.com
        └────────┘
          這一段
```

<details>
<summary><strong>Account token 和 User token 有什麼差別？</strong></summary>

- **User API token**：綁定目前登入的 Cloudflare 使用者，個人自架通常選這個即可。
- **Account API token**：綁定整個 Cloudflare account，通常只有 Super Administrator 能建立。

兩者都可以產生 R2 的 Access Key ID 和 Secret Access Key。這篇只需要其中一種。

</details>

### 建立 `.snapshot.env`

macOS / Linux：

```sh
cp .snapshot.env.example .snapshot.env
```

Windows PowerShell：

```powershell
Copy-Item .snapshot.env.example .snapshot.env
```

在 VS Code 左側打開 `.snapshot.env`，填入剛才的三個值：

```dotenv
R2_ACCESS_KEY_ID="你的 Access Key ID"
R2_SECRET_ACCESS_KEY="你的 Secret Access Key"
CLOUDFLARE_ACCOUNT_ID="你的 Cloudflare Account ID"
```

按 `Ctrl+S`；macOS 按 `Command+S` 儲存。

> `.snapshot.env` 也已被 Git 忽略。它只供本機快照發布使用，不會上傳成 Worker secret。

## 8. 建立 D1 資料表

目前的 D1 是空的。Migration 會建立 Mochi Bus 需要的資料表結構：

```text
空的 D1
  │
  │ migration
  ▼
具有 routes、stops 等資料表的 D1
```

執行：

```sh
npx wrangler d1 migrations apply TRANSIT_DB --remote --config .generated/instance/wrangler.instance.jsonc
```

> `TRANSIT_DB` 是 Mochi Bus 程式內使用的固定 binding 名稱，不要把它換成 `my-chiayi-transit`。

Wrangler 可能會詢問是否套用 migration。確認畫面中的 database 是 `my-chiayi-transit`，再輸入 `y` 並按 Enter。

完成時應顯示 migration 已成功套用，並回到可輸入指令的狀態。

<details>
<summary><strong>migration 和 binding 是什麼？</strong></summary>

- **migration**：建立或更新資料表的結構，不是在搬移舊資料。
- **binding**：Worker 程式內存取某項 Cloudflare 資源時使用的固定名稱。

`TRANSIT_DB` 指向哪一個真實 D1 database，是由 generated Wrangler config 決定。

</details>

## 9. 部署 Worker

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

執行：

```sh
npm run deploy -- --secrets-file .dev.vars
```

- **操作位置：** 本機建置，接著上傳到 Cloudflare
- **會建立或更新：** Worker 與 Worker secrets
- **通常可以重跑：** 是

第一次使用 Workers 時，Wrangler 可能會要求建立或確認 `workers.dev` subdomain。照畫面完成即可。

成功後，Wrangler 會顯示一個以 `.workers.dev` 結尾的完整網址。**直接複製終端機實際顯示的網址，不要自己猜 subdomain。**

把網址貼進瀏覽器。此時網站應該能開，但還沒有完整路線和站牌，因為嘉義市資料尚未發布。

完成標誌：

- 終端機沒有顯示 deploy error
- 顯示一個可開啟的 `https://...workers.dev` 網址
- 瀏覽器可以載入網站頁面

## 10. 發布第一份城市快照

```text
部署 Worker
＝ 網站程式上線

發布城市快照
＝ 公車資料上線
```

快照發布會：

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

先把剛才的完整 `workers.dev` 網址複製好。

macOS / Linux：

```sh
export SNAPSHOT_SMOKE_BASE_URL="PASTE_YOUR_WORKERS_DEV_URL_HERE"
npm run snapshot:city -- Chiayi
```

Windows PowerShell：

```powershell
$env:SNAPSHOT_SMOKE_BASE_URL = "PASTE_YOUR_WORKERS_DEV_URL_HERE"
npm run snapshot:city -- Chiayi
```

執行前，先把 `PASTE_YOUR_WORKERS_DEV_URL_HERE` 換成 Wrangler 實際顯示的完整網址，例如：

```text
https://my-chiayi-bus.example.workers.dev
```

網址結尾不要加 `/`。

`SNAPSHOT_SMOKE_BASE_URL` 只存在目前這個終端機。關閉終端機或換到另一個視窗後，需要重新設定。

第一次執行時會有很多輸出，不要中途關閉 VS Code。

- **操作位置：** TDX、本機、Cloudflare D1/R2 和公開網站
- **會寫入資料：** 是
- **可能計費：** 使用量超過 Cloudflare 方案額度時
- **通常可以重跑：** 是

完成標誌：

- 最後幾行出現 `"status":"published"` 或 `"phase":"published"`
- 終端機回到可以再次輸入指令的狀態
- 沒有出現 `snapshot_publish_failure`

<details>
<summary><strong>城市快照是什麼？</strong></summary>

城市快照不是畫面截圖，也不是電腦備份。

它是某個時間點整理完成的一整份城市公車資料，包含路線、站牌、線形和時刻表等內容。Mochi Bus 會先驗證整份資料，再切換公開網站使用的版本。

即時到站和車輛位置等容易變動的資訊，仍會在需要時查詢 TDX。

</details>

## 11. 確認結果

### 確認 API

把剛才的公開網址後面加上：

```text
/api/v1/map/cities
```

例如：

```text
https://my-chiayi-bus.example.workers.dev/api/v1/map/cities
```

瀏覽器可能會顯示一整段 JSON，這是正常的。使用瀏覽器尋找功能搜尋 `Chiayi`，應該可以找到它。

### 確認網站

- [ ] 公開網址可以開啟
- [ ] 地圖顯示嘉義市
- [ ] 看得到路線、線形和站牌
- [ ] 點擊路線或站牌後有內容
- [ ] 到站時間可以查詢

通過這些項目，就已經是一套能獨立運作的 Mochi Bus。

## 常見問題

### `git`、`node`、`npm` 或 `npx` 顯示找不到指令

安裝工具後，完全關閉 VS Code 再重新開啟。

若仍失敗，確認 Git 與 Node.js 已完成安裝，而不是只下載安裝檔。

### PowerShell 顯示無法載入 `npm.ps1`

不需要修改 PowerShell 執行原則。把指令中的：

- `npm` 改成 `npm.cmd`
- `npx` 改成 `npx.cmd`

例如：

```powershell
npm.cmd install
npx.cmd wrangler whoami
```

也可以在 VS Code 終端機右上角的下拉選單改用 **Command Prompt**。使用 Command Prompt 時，以 `cd` 顯示目前路徑，不要使用 `pwd`。

### `Could not read package.json`、`Missing script` 或找不到專案檔案

目前終端機不在 `mochi-bus` 資料夾。

在 VS Code 使用 **File → Open Recent** 開啟 `mochi-bus`，再建立新的終端機。Windows PowerShell、macOS 和 Linux 執行：

```sh
pwd
```

Windows Command Prompt 則執行：

```bat
cd
```

最後一段路徑應該是 `mochi-bus`。

### `npm install` 出現很多警告

`npm WARN` 通常不代表失敗。真正的安裝錯誤通常會顯示 `npm ERR!`。

### 找不到 `.dev.vars` 或 `.snapshot.env`

確認已執行複製指令，並在 VS Code Explorer 按一下重新整理圖示。

這兩個檔名開頭有一個 `.`，不是副檔名遺失。

### `instance.json already exists`

代表先前已建立過設定。不要直接加 `--force` 覆蓋；先打開現有的 `instance.json`，確認是否就是要繼續使用的設定。

### `create` 顯示資源已經存在

先列出目前帳號的資源：

```sh
npx wrangler d1 list
npx wrangler r2 bucket list
```

如果同名資源是你剛才建立的，就直接沿用，不要重複建立。若用途不明，先停止並確認。

### D1 ID 填入後驗證失敗

確認：

- 只替換了 `null`
- ID 左右仍有雙引號
- 該行結尾逗點仍存在
- 沒有把 `databaseName` 改掉

### `Missing TDX_CLIENT_ID or TDX_CLIENT_SECRET`

確認 repository 根目錄有 `.dev.vars`，兩個值都已替換，不是空字串或範例文字，並且已儲存。

### `Snapshot publisher requires a provisioned D1 database ID`

檢查 `instance.json` 的 `cloudflare.d1.databaseId`。填好後重新執行：

```sh
npm run instance:validate -- --config instance.json
npm run instance:compile -- --config instance.json
```

### `Snapshot publisher requires a fixed public origin or SNAPSHOT_SMOKE_BASE_URL`

目前終端機沒有公開網址設定，或仍保留 `PASTE_YOUR_WORKERS_DEV_URL_HERE`。重新設定實際網址後再執行。

### 出現 R2 credentials、`Snapshot state writer unavailable` 或 R2 403

確認根目錄有 `.snapshot.env`，並且三個值都已填寫與儲存：

- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `CLOUDFLARE_ACCOUNT_ID`

再確認：

- R2 token 權限是 **Object Read & Write**
- token 包含 `my-chiayi-transit-shapes` bucket
- `CLOUDFLARE_ACCOUNT_ID` 填的是 Account ID，不是 Access Key ID
- Secret Access Key 沒有多複製空格

### 出現 `snapshot_publish_failure`

往上查看它前面的第一個錯誤訊息。修正後通常可以重新執行：

```sh
npm run snapshot:city -- Chiayi
```

### 網站能開，但沒有路線

代表 Worker 已上線，但城市快照可能尚未成功發布。確認 snapshot 指令最後有出現 `"status":"published"` 或 `"phase":"published"`。

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
4. `.snapshot.env` 的 Account ID
5. generated config 是否由最新的 `instance.json` 產生

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
npx wrangler d1 create my-chiayi-transit
npx wrangler r2 bucket create my-chiayi-transit-shapes
```

## 移除這套服務與停止可能的費用

可以從 Cloudflare Dashboard 刪除：

- [ ] Worker
- [ ] D1 database
- [ ] R2 bucket 內的所有物件
- [ ] 空的 R2 bucket
- [ ] 不再使用的 R2 API token

R2 bucket 裡有快照時不能直接刪除，要先清空內容。刪除 Worker 不會自動刪除 D1 或 R2；刪除遠端資源也不會動到本機的 `instance.json`、`.dev.vars` 或 `.snapshot.env`。

如果不再使用任何 R2 功能，也請到 Cloudflare Billing 和 R2 頁面確認 subscription 與帳單狀態。不要只刪除 Worker 就假設所有可能計費的資源都已移除。

## 接下來

完成 starter 部署後，可以再選擇：

- fork repository，長期維護自己的版本
- 加入第二個縣市
- 綁定自訂網域
- 用 GitHub Actions 自動更新資料
- 升級成 managed profile
- 定期同步 upstream 的 Mochi Bus 更新

這些進階路徑目前不屬於本篇的第一次安裝範圍。