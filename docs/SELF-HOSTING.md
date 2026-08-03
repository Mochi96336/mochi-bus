# 部署自己的 Mochi Bus

`bus.moc96336.com` 是 Mochi 維護的公開參考實例。這份教學會帶你從零開始，架出一套屬於自己的 Mochi Bus。

不需要先會寫程式。這篇只走一條最容易檢查的路：

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

## 怎麼閱讀這篇

本篇以 **Visual Studio Code（VS Code）** 作為主要操作畫面。熟悉終端機與文字編輯器的人，可以自行換成其他工具。

不展開任何摺疊區，也能完成部署。摺疊區主要使用三種標籤：

- **第一次操作：** 不熟悉 VS Code、終端機或 Cloudflare 畫面時展開
- **深入了解：** 想知道工具和架構為什麼這樣設計時展開
- **遇到錯誤：** 實際看到對應訊息時再展開

費用、Secret、安全警告、必要指令和成功標誌不會藏在摺疊區裡。

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

<details>
<summary><strong>深入了解：哪些操作會消耗 R2 額度？</strong></summary>

```text
保存城市快照檔案        → Storage
建立、上傳、刪除物件    → Class A operations
讀取線形、時刻表等物件  → Class B operations
對外傳輸                → 目前不收 egress 費用
```

嘉義市 starter 的資料量通常不大，但免費額度不是「永遠不會收費」的承諾。加入更多縣市、頻繁重跑或提高流量後，使用量也會增加。

</details>

<details>
<summary><strong>深入了解：刪除 Worker 為什麼不會停止 R2 使用量？</strong></summary>

Worker、D1 和 R2 是三個獨立資源。刪除 Worker 只會移除網站程式，不會刪除 R2 裡已保存的城市快照，也不會自動取消 R2 subscription。

不再使用服務時，要另外清空並刪除 R2 bucket，再到 Billing 與 R2 頁面確認帳務狀態。

</details>

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

- **Worker：** Mochi Bus 真正上線執行的程式，負責網站和 API。
- **D1：** Cloudflare 的 SQL 資料庫，保存路線、站牌、站序與目前啟用的資料版本。
- **R2：** Cloudflare 的物件儲存空間，可以想成程式使用的雲端硬碟，保存地圖線形、時刻表和城市快照。

<details>
<summary><strong>深入了解：需要快照資料的地圖 API 如何經過這些資源？</strong></summary>

```text
瀏覽器
  │
  │ 請求地圖 API
  ▼
Worker
  │
  ├── 查 D1：路線、站牌、目前啟用的版本
  │
  └── 讀 R2：該版本的線形、時刻表與路網檔案
          │
          ▼
       回傳結果
```

不是每個請求都一定同時使用 D1 和 R2。靜態網站檔案、即時到站或不同 API，可能走不同資料來源。

使用者不會直接拿到 D1 或 R2 的管理權限。公開請求先由 Worker 接收，再由 Worker 使用 binding 存取正確的資源。

</details>

</details>

### 繼續前確認

- [ ] 已建立 Cloudflare 帳號
- [ ] 已完成 R2 checkout
- [ ] 已取得 TDX Client ID 與 Client Secret
- [ ] 電腦可以安裝 Git、Node.js 和 VS Code

TDX 憑證位於「[TDX 會員中心](https://tdx.transportdata.tw/) → 資料服務 → API 金鑰」。還沒有帳號時，先完成[會員註冊](https://tdx.transportdata.tw/register/general)，再建立一組 API 金鑰。

## 1. 安裝需要的工具

請安裝：

- [Git](https://git-scm.com/downloads)
- [Node.js 22 以上](https://nodejs.org/)
- [Visual Studio Code](https://code.visualstudio.com/Download)

不需要安裝任何 VS Code extension。

安裝完成後，在 VS Code 選擇 **Terminal → New Terminal**，執行：

```sh
git --version
node --version
npm --version
```

成功時：

- Git 顯示版本號
- Node.js 顯示 `v22` 或更新版本
- npm 顯示版本號

<details>
<summary><strong>第一次操作：安裝 Git、Node.js 和 VS Code</strong></summary>

- Node.js 下載頁選擇 **LTS** 版本，安裝選項保留預設即可。
- Git 安裝程式的選項保留預設即可。
- VS Code 使用 User Installer 或 System Installer 都可以。
- 不要把專案放進 `C:\Program Files` 等需要管理員權限的資料夾。
- 安裝完成後，完全關閉再重新開啟 VS Code，讓新安裝的 Git 和 Node.js 可以被找到。

</details>

<details>
<summary><strong>第一次操作：VS Code 的終端機在哪裡？</strong></summary>

1. 開啟 VS Code。
2. 從上方選單選擇 **Terminal → New Terminal**。
3. 畫面下方會出現可以輸入指令的區域。
4. 把教學中的指令貼進去，再按 Enter。

Windows 預設通常是 PowerShell；macOS 和 Linux 通常是自己的系統 shell。

</details>

<details>
<summary><strong>深入了解：Node.js、npm 和 LTS 是什麼？</strong></summary>

```text
Node.js
   ├── 執行 Mochi Bus 的 scripts
   ├── 建置網站
   ├── 整理 TDX 資料
   └── 呼叫部署工具

npm
   ├── 讀取 package.json
   ├── 安裝專案依賴
   └── 執行 npm run ... 指令
```

npm 會隨 Node.js 一起安裝。你不需要自己撰寫 Node.js 程式。

LTS 是 Node.js 的長期支援版本，通常比剛發布的新版本更適合部署工具與專案依賴。Mochi Bus 要求 Node.js 22 以上；選擇目前的 LTS 版本即可，不必特別尋找 Node.js 22 的舊安裝檔。

</details>

## 2. 取得程式碼

在 VS Code 終端機執行：

```sh
git clone https://github.com/Mochi96336/mochi-bus.git
cd mochi-bus
```

`git clone` 會建立一個新的 `mochi-bus` 資料夾；`cd mochi-bus` 會進入它。

> [!IMPORTANT]
> 從現在開始，除非教學另外說明，所有指令都要在 `mochi-bus` 資料夾中執行。

接著安裝專案需要的工具：

```sh
npm install
```

這個指令只會在目前資料夾安裝工具，不會部署網站，也不會建立 Cloudflare 資源。

完成時：

- 終端機回到可以再次輸入指令的狀態
- 沒有出現 `npm ERR!`
- `npm WARN` 通常只是警告，不代表安裝失敗
- 結尾可能出現 Mochi production 名稱，這是第一次安裝的預設編譯，不代表連線或部署到正式站

<details>
<summary><strong>第一次操作：如何確認目前位於 mochi-bus 資料夾？</strong></summary>

PowerShell、macOS 和 Linux：

```sh
pwd
```

Windows Command Prompt：

```bat
cd
```

最後一段路徑應該是 `mochi-bus`。

若關閉後重新開啟 VS Code，請用 **File → Open Recent** 開啟 `mochi-bus`，再建立新的終端機。

</details>

<details>
<summary><strong>第一次操作：用 VS Code 開啟整個 mochi-bus</strong></summary>

1. 選擇 **File → Open Folder**。
2. 找到剛才下載的 `mochi-bus` 資料夾。
3. 選擇 **Select Folder**；macOS 選擇 **Open**。
4. 若出現 Workspace Trust 提示，先確認資料夾是由上面的官方 `git clone` 指令取得。
5. 確認後選擇 **Yes, I trust the authors**。
6. 再選擇 **Terminal → New Terminal**。

左側 Explorer 應該會看到 `README.md`、`package.json`、`docs` 等檔案。

</details>

<details>
<summary><strong>深入了解：repository、工作資料夾與 npm install</strong></summary>

- **repository：** 專案檔案和修改紀錄的集合
- **clone：** 把 repository 下載到自己的電腦
- **fork：** 在自己的 GitHub 帳號建立一份可獨立維護的副本
- **目前工作資料夾：** 終端機執行指令時所在的位置

`npm run ...` 會從目前資料夾尋找 `package.json`；若不在 `mochi-bus`，就會看到找不到 package 或 script 的錯誤。

```text
package.json
  └── 宣告專案需要哪些套件與指令

package-lock.json
  └── 鎖定實際安裝版本

node_modules/
  └── 下載到本機的套件
```

`node_modules/` 只存在本機而且體積較大，不會提交到 repository。通常可以安全重跑 `npm install`。

</details>

## 3. 登入 Cloudflare

執行：

```sh
npx wrangler login
npx wrangler whoami
```

第一個指令通常會開啟瀏覽器。登入並授權後回到 VS Code。

`whoami` 應顯示你的 Cloudflare 帳號資訊。稍後的 D1、R2 和 Worker 都會建立在這個帳號。

若 Wrangler 要你選擇帳號，選擇剛才完成 R2 checkout 的同一個帳號。

<details>
<summary><strong>第一次操作：Wrangler 登入時會看到什麼？</strong></summary>

1. 執行 `npx wrangler login`。
2. 瀏覽器開啟 Cloudflare 授權頁。
3. 登入 Cloudflare。
4. 確認授權 Wrangler。
5. 回到 VS Code。
6. 執行 `npx wrangler whoami`。
7. 確認顯示的是預計使用的帳號。

</details>

<details>
<summary><strong>深入了解：npx、Wrangler 和 whoami</strong></summary>

- **Wrangler：** Cloudflare 官方提供的終端機工具
- **npx：** 執行目前專案已安裝的 Wrangler

之後看到 `npx wrangler ...`，可以理解成：「請 Cloudflare 官方工具執行後面的操作。」

`whoami` 很重要，因為遠端資源和 R2 credentials 必須屬於同一個 Cloudflare account：

```text
Wrangler 登入帳號 A
        │
        ├── D1 建在 A
        ├── R2 建在 A
        └── Worker 建在 A

.snapshot.env 卻填帳號 B
        │
        └── R2 可能回傳 403
```

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

打開 `.dev.vars`，填入自己的值並儲存：

```dotenv
TDX_CLIENT_ID="你的 Client ID"
TDX_CLIENT_SECRET="你的 Client Secret"
```

> [!WARNING]
> `.dev.vars` 內含密碼性質的資料。不要把內容貼到 issue、PR、公開聊天或截圖，也不要提交到 repository。

`.dev.vars` 已被 Git 忽略，不會正常出現在 Git commit 裡。

<details>
<summary><strong>第一次操作：如何在 VS Code 編輯 .dev.vars？</strong></summary>

1. 在左側 Explorer 找到 `.dev.vars`。
2. 點一下檔名開啟。
3. 把兩個範例值換成自己的 TDX 憑證。
4. 保留左右的引號。
5. 按 `Ctrl+S`；macOS 按 `Command+S` 儲存。

若沒有看到檔案，按一下 Explorer 上方的重新整理圖示。

</details>

<details>
<summary><strong>深入了解：點開頭檔案、Secret 與 .gitignore</strong></summary>

點開頭檔案通常用來保存設定，而且在部分作業系統中會被視為隱藏檔案。`.dev.vars` 是完整檔名，不要改成 `.dev.vars.txt`。

可以把 Client ID 想成程式使用的帳號，把 Client Secret 想成這個程式帳號的密碼。Mochi Bus 會使用它們向 TDX 交換短期 access token，再讀取公車資料。

repository 的 `.gitignore` 已列出 `.dev.vars` 和 `.snapshot.env`。這是一層保護，不代表可以公開貼出內容；截圖、聊天、issue 和手動強制加入 Git 仍可能洩漏 Secret。

<details>
<summary><strong>深入了解：.dev.vars 和 .snapshot.env 有什麼不同？</strong></summary>

```text
.dev.vars
  └── TDX Client ID / Secret
      ├── 部署成 Worker secrets
      └── 本機快照發布工具讀取

.snapshot.env
  └── R2 S3 credentials
      └── 只供本機快照發布工具使用
```

兩個檔案都只放本機，不應提交。

</details>

</details>

## 5. 建立自己的 instance 設定

建立一套名為 `my-chiayi-bus`、只啟用嘉義市的設定：

```sh
npm run instance:init -- my-chiayi-bus --cities Chiayi --site-name "My Chiayi Bus"
```

這個指令只會在本機建立 `instance.json`，不會建立 Cloudflare 資源。

成功時應看到：

```text
Created Mochi Bus instance manifest: instance.json
Profile: starter
Cities: Chiayi
Cloudflare: my-chiayi-bus / my-chiayi-transit / my-chiayi-transit-shapes
State: valid instance manifest
```

第一次產生時，`instance.json` 裡的 D1 ID 會是 `null`。這是正常的，因為資料庫還沒建立。

驗證設定並產生部署檔案：

```sh
npm run instance:validate -- --config instance.json
npm run instance:compile -- --config instance.json
```

兩個指令都沒有出現 error，並回到可輸入指令的狀態，就可以繼續。

> 只修改 `instance.json`。不要手動修改 `.generated/instance/`，因為下次 compile 會重新產生它們。

<details>
<summary><strong>第一次操作：如何找到 instance.json？</strong></summary>

執行 `instance:init` 後，VS Code 左側 Explorer 的專案根目錄會出現 `instance.json`。

若沒看到，按一下 Explorer 上方的重新整理圖示。不要到 `.generated/instance/` 裡尋找另一份來修改。

</details>

<details>
<summary><strong>深入了解：Instance ID、validate 和 generated files</strong></summary>

```text
Instance ID：my-chiayi-bus
       │
       ├── Worker：my-chiayi-bus
       ├── D1：my-chiayi-transit
       └── R2：my-chiayi-transit-shapes
```

starter initializer 會從 Instance ID 產生一組一致、容易辨認的 Cloudflare 資源名稱。

```text
instance.json
   │
   ├── validate：檢查設定是否合法
   │
   └── compile：產生程式真正使用的檔案
                    │
                    ▼
             .generated/instance/
```

`instance.json` 是你維護的來源設定；`.generated/instance/` 是自動產物。直接修改 generated files，下一次 compile 就會被覆蓋。

<details>
<summary><strong>進階工具：查看完整 provisioning plan</strong></summary>

```sh
npm run instance:provision-plan -- --config instance.json
```

這個指令不會建立或修改遠端資源，但會列出 GitHub Actions、secrets 和其他進階項目。第一次手動部署時看到 `action_required` 或 `blocked` 不一定代表主流程失敗。

輸出最後應顯示：

```text
NO CHANGES WERE APPLIED
```

</details>

</details>

## 6. 建立 D1 和 R2

> [!WARNING]
> 從這一步開始，指令會真的在 Cloudflare 帳號建立遠端資源。先再確認一次：
>
> ```sh
> npx wrangler whoami
> ```

### 建立 D1 database

```sh
npx wrangler d1 create my-chiayi-transit
```

Wrangler 會顯示一個 `database_id`。只複製引號裡的 ID，然後把 `instance.json` 中的：

```json
"databaseId": null
```

改成：

```json
"databaseId": "12345678-abcd-1234-abcd-123456789012"
```

> [!IMPORTANT]
> 只替換 `null`。保留雙引號、欄位名稱和行尾逗點。

### 建立 R2 bucket

```sh
npx wrangler r2 bucket create my-chiayi-transit-shapes
```

R2 不需要把另一個 ID 填回 `instance.json`。

確認兩個資源：

```sh
npx wrangler d1 list
npx wrangler r2 bucket list
```

列表中應看到：

- `my-chiayi-transit`
- `my-chiayi-transit-shapes`

> 不要為了重試而連續執行 `create`。看到同名資源時，先確認它是否就是剛才建立的。

填好 D1 ID 後，重新執行：

```sh
npm run instance:validate -- --config instance.json
npm run instance:compile -- --config instance.json
```

<details>
<summary><strong>第一次操作：如何把 database_id 填進 instance.json？</strong></summary>

Wrangler 輸出可能看起來像：

```text
database_id = "12345678-abcd-1234-abcd-123456789012"
               └──────────────────────────────────┘
                    只複製引號裡的這一段
```

接著：

1. 在 VS Code 左側點開 `instance.json`。
2. 按 `Ctrl+F`；macOS 按 `Command+F`。
3. 搜尋 `"databaseId": null`。
4. 只把 `null` 換成剛才的 ID。
5. 保留 ID 左右的雙引號。
6. 保留行尾逗點。
7. 儲存檔案。

</details>

<details>
<summary><strong>深入了解：D1、R2、名稱、ID 和 binding</strong></summary>

D1 適合保存需要查詢和互相關聯的表格資料，例如路線、站牌與站序。

R2 適合保存完整的大型檔案，例如 GeoJSON 線形、時刻表和城市路網檔案。

```text
程式內固定 binding
TRANSIT_DB / TRANSIT_SHAPES
        │
        │ .generated/instance/wrangler.instance.jsonc
        ▼
真實 Cloudflare 資源
my-chiayi-transit / my-chiayi-transit-shapes
```

- **database name：** 人類容易辨認的名稱，例如 `my-chiayi-transit`
- **database ID：** Cloudflare 指派的唯一 UUID

D1 binding 使用 database ID 精確識別資料庫；R2 binding 使用 bucket name 指定 bucket。因此建立 D1 後要把 ID 寫回 `instance.json`，建立 R2 後只要名稱一致。

</details>

## 7. 建立 R2 發布憑證

城市快照會從你的電腦直接寫入 R2，因此還需要一組 R2 S3 credentials。

建立 token 時必須：

- 權限選擇 **Object Read & Write**
- 可存取的 bucket 限制為 `my-chiayi-transit-shapes`
- 立即保存 Access Key ID 和 Secret Access Key

> [!WARNING]
> Secret Access Key 只會在建立 token 後顯示一次。建立後立刻複製，不要貼到公開地方。

建立 `.snapshot.env`：

macOS / Linux：

```sh
cp .snapshot.env.example .snapshot.env
```

Windows PowerShell：

```powershell
Copy-Item .snapshot.env.example .snapshot.env
```

填入三個值並儲存：

```dotenv
R2_ACCESS_KEY_ID="你的 Access Key ID"
R2_SECRET_ACCESS_KEY="你的 Secret Access Key"
CLOUDFLARE_ACCOUNT_ID="你的 Cloudflare Account ID"
```

Account ID 不是 Access Key ID。它通常可以在 R2 的 **Account Details** 或 S3 endpoint 中找到：

```text
https://ACCOUNT_ID.r2.cloudflarestorage.com
        └────────┘
          這一段
```

> `.snapshot.env` 已被 Git 忽略，只供本機快照發布工具使用，不會部署成 Worker secret。

<details>
<summary><strong>第一次操作：在 Cloudflare 建立 R2 token</strong></summary>

1. 打開 Cloudflare Dashboard。
2. 進入 **Storage & databases → R2 → Overview**。
3. 在 **Account Details** 找到 **API Tokens**，選擇 **Manage**。
4. 一般個人帳號選擇 **Create User API token**。
5. 權限選擇 **Object Read & Write**。
6. 將可存取的 bucket 限制為 `my-chiayi-transit-shapes`。
7. 建立 token。
8. 立即複製 Access Key ID 和 Secret Access Key。
9. 回到 R2 Account Details 取得 Account ID。
10. 在 VS Code 打開 `.snapshot.env`，填入三個值並儲存。

</details>

<details>
<summary><strong>深入了解：R2 token、三個 Key／ID 與最小權限</strong></summary>

- **User API token：** 綁定目前登入的 Cloudflare 使用者，個人自架通常選這個即可。
- **Account API token：** 綁定整個 Cloudflare account，通常只有 Super Administrator 能建立。

```text
Access Key ID
  └── 辨認這一組 R2 credential

Secret Access Key
  └── 證明程式持有這組 credential
      只顯示一次，必須保密

Cloudflare Account ID
  └── 指定 credential 要連到哪個 Cloudflare account
```

將權限限制在單一 bucket，符合最小權限原則。即使 credential 意外外洩，它也不能碰帳號裡其他 R2 資料。

<details>
<summary><strong>深入了解：為什麼已有 Wrangler login，還要 S3 credentials？</strong></summary>

```text
Wrangler login
  └── 適合 CLI 建立資源、migration、deploy

R2 S3 credentials
  └── 快照發布工具直接大量 PUT / GET / DELETE 物件
```

Wrangler 可以逐一上傳物件，但快照發布工具還需要讀取 manifest、驗證物件、寫入 state 與清理舊版本。直接使用 R2 S3 API 更完整，也適合大量檔案。

</details>

</details>

## 8. 建立 D1 資料表

目前的 D1 是空的。執行 migration 建立 Mochi Bus 需要的資料表：

```sh
npx wrangler d1 migrations apply TRANSIT_DB --remote --config .generated/instance/wrangler.instance.jsonc
```

> [!IMPORTANT]
> `TRANSIT_DB` 是 Mochi Bus 程式內使用的固定 binding 名稱，不要把它換成 `my-chiayi-transit`。

Wrangler 可能會詢問是否套用 migration。確認畫面中的 database 是 `my-chiayi-transit`，再輸入 `y` 並按 Enter。

完成時應顯示 migration 已成功套用，並回到可輸入指令的狀態。

<details>
<summary><strong>第一次操作：Wrangler 問 Yes／No 時要確認什麼？</strong></summary>

先看畫面中的：

- database name 是否為 `my-chiayi-transit`
- 操作是否為 remote database
- migration 是否來自目前的 Mochi Bus 專案

三項都正確，再輸入 `y`。若名稱或 ID 不對，先停止，不要急著刪除資料庫。

</details>

<details>
<summary><strong>深入了解：migration、binding 與安全重跑</strong></summary>

- **migration：** 建立或更新資料表結構，不是在搬移舊資料。
- **binding：** Worker 程式內存取某項 Cloudflare 資源時使用的固定名稱。

```text
程式內固定名稱
TRANSIT_DB
    │
    │ generated Wrangler config
    ▼
真實 Cloudflare D1
my-chiayi-transit
```

Wrangler 會記錄已套用的 migration。再次執行時，只會處理尚未套用的項目，不會把同一份 schema 無限重建。

仍應先確認 generated config 指向正確資料庫，因為 `--remote` 操作的是雲端 D1。

</details>

## 9. 部署 Worker

執行：

```sh
npm run deploy -- --secrets-file .dev.vars
```

這一步會：

- 建置前端
- 建立或更新 Cloudflare Worker
- 將 TDX Client ID 和 Client Secret 上傳成 Worker secrets

第一次使用 Workers 時，Wrangler 可能會要求建立或確認 `workers.dev` subdomain。照畫面完成即可。

成功後，Wrangler 會顯示一個以 `.workers.dev` 結尾的完整網址。**直接複製終端機實際顯示的網址，不要自己猜 subdomain。**

把網址貼進瀏覽器。此時網站應該能開，但還沒有完整路線和站牌，因為嘉義市資料尚未發布。

完成標誌：

- 終端機沒有顯示 deploy error
- 顯示一個可開啟的 `https://...workers.dev` 網址
- 瀏覽器可以載入網站頁面

<details>
<summary><strong>第一次操作：首次部署時 Wrangler 可能問什麼？</strong></summary>

第一次使用 Workers，可能需要：

- 建立或確認 `workers.dev` subdomain
- 選擇 Cloudflare account
- 確認 Worker 名稱

選擇完成 R2 checkout、並且 D1/R2 建立在其中的同一個帳號。部署完成後只使用 Wrangler 實際輸出的完整網址。

</details>

<details>
<summary><strong>深入了解：deploy、Worker secret 和城市資料</strong></summary>

`package.json` 中的 deploy script 會先執行網站 build，再呼叫 Wrangler deploy，使用 `.generated/instance/wrangler.instance.jsonc` 連接正確的 D1 和 R2。

```text
原始碼
  │
  ├── compile instance 設定
  ├── Vite 建置前端
  ├── Wrangler 上傳 Worker
  └── 寫入 TDX Worker secrets
```

`.dev.vars` 是本機檔案。deploy 指令讀取其中的 TDX 值，將它們存成 Cloudflare Worker secrets。

```text
部署 Worker
＝ 網站程式上線

發布城市快照
＝ 公車資料上線
```

deploy 不會自動下載並發布 TDX 城市資料。下一步完成城市快照後，網站才會有完整路線、站牌、線形和時刻表。

</details>

## 10. 發布第一份城市快照

先把 Wrangler 顯示的完整 `workers.dev` 網址複製好。

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

執行前，把 `PASTE_YOUR_WORKERS_DEV_URL_HERE` 換成實際網址，例如：

```text
https://my-chiayi-bus.example.workers.dev
```

網址結尾不要加 `/`。

`SNAPSHOT_SMOKE_BASE_URL` 只存在目前這個終端機。關閉終端機或換到另一個視窗後，需要重新設定。

第一次執行時會有很多輸出，不要中途關閉終端機。

- **會寫入資料：** Cloudflare D1 和 R2
- **可能計費：** 使用量超過 Cloudflare 方案額度時
- **通常可以重跑：** 是

完成標誌：

- 最後幾行出現 `"status":"published"` 或 `"phase":"published"`
- 終端機回到可以再次輸入指令的狀態
- 沒有出現 `snapshot_publish_failure`

<details>
<summary><strong>城市快照是什麼？</strong></summary>

城市快照（snapshot）不是畫面截圖，也不是電腦備份。

它是某個時間點整理完成的一整份城市公車資料，包含路線、站牌、線形和時刻表。Mochi Bus 會先驗證整份資料，再切換公開網站使用的版本。

<details>
<summary><strong>深入了解：從下載到上線經過哪些階段？</strong></summary>

```text
TDX
 │
 ▼
下載原始資料
 │
 ▼
整理與本機驗證
 │
 ├── 產生 D1 SQL
 └── 產生 R2 artifacts
         │
         ▼
stage：寫入尚未啟用的新版本
         │
         ▼
remote validation：檢查 D1 與 R2
         │
         ▼
activate：切換啟用版本
         │
         ▼
smoke：從公開網址驗證
         │
         ▼
finalize：寫入快照狀態
         │
         ▼
cleanup：清理不再保留的舊版本
```

每個階段都完成後，才會輸出 `published`。

</details>

<details>
<summary><strong>深入了解：哪些資料放 D1，哪些放 R2？</strong></summary>

```text
D1
  ├── routes
  ├── patterns
  ├── stops
  ├── stop_places
  ├── pattern_stops
  └── dataset_versions

R2
  ├── route shapes
  ├── schedules
  ├── stop-place bundles
  ├── network.json
  ├── manifest.json
  └── 快照狀態
```

D1 適合關聯查詢；R2 適合直接讀取完整檔案。

</details>

<details>
<summary><strong>深入了解：啟用版本如何避免使用者看到半套資料？</strong></summary>

```text
舊版本仍在線
    │
    ├── 寫入新版本資料
    ├── 驗證新版本 D1 / R2
    └── 最後才更新 active_version
                 │
                 ▼
             新版本上線
```

在 activate 前，公開網站仍使用舊版本。即使新版本寫到一半失敗，也不會讓使用者讀到半套資料。

</details>

<details>
<summary><strong>深入了解：各階段失敗時會發生什麼？</strong></summary>

- **stage 失敗：** 新版本尚未啟用；既有版本不受影響。
- **remote validation 失敗：** 不會切換啟用版本。
- **activate 後 smoke 失敗，且已有 previous version：** 發布工具會嘗試恢復 previous version。
- **第一次發布的 smoke 失敗：** 沒有 previous version 可恢復，會回報 restore failure，需要先修正錯誤再重新發布。
- **finalize 失敗：** 新版本可能已經通過公開驗證並保持啟用，但快照狀態尚未完成，會回報需要 reconcile。
- **cleanup 失敗：** 新版本仍可繼續服務，但舊資料可能沒有清理完成。

```text
已有 previous version
新版本 activate
      │
      ▼
公開 smoke 失敗
      │
      ▼
嘗試恢復 previous version
```

不要在第一次看到錯誤時手動刪除 D1 或 R2。先查看第一個錯誤訊息。

單純重跑不保證會再次執行先前失敗的 cleanup；看到 reconcile 或 cleanup 類錯誤時，應保留完整輸出，再使用對應維運工具處理。

</details>

<details>
<summary><strong>深入了解：為什麼即時到站仍然查 TDX？</strong></summary>

```text
變化較慢
路線、站牌、線形、時刻表 → 城市快照

變化很快
車輛位置、即時到站       → 使用時查詢 TDX
```

把穩定資料做成城市快照，可以降低重複下載並加快地圖載入；即時資料若也做成快照，很快就會過期。

</details>

<details>
<summary><strong>深入了解：snapshot:city 為什麼通常可以安全重跑？</strong></summary>

發布工具會為資料建立版本，驗證新版本後才啟用。若已有 previous version，也能在特定 smoke 失敗情況下嘗試恢復。

它會比較內容 hash；資料沒有實質變化時，可以沿用既有版本而不必每次全量重寫。若前一次在尚未啟用的階段失敗，重跑會重新產生並驗證資料。

「通常可以安全重跑」不代表可以隨意更換 database、bucket 或 Account ID。資源設定必須保持一致；finalize、reconcile 或 cleanup 類錯誤也可能需要額外處理。

</details>

</details>

## 11. 確認結果

把公開網址後面加上：

```text
/api/v1/map/cities
```

例如：

```text
https://my-chiayi-bus.example.workers.dev/api/v1/map/cities
```

瀏覽器可能會顯示一整段 JSON，這是正常的。回應中應該可以找到 `Chiayi`。

接著確認：

- [ ] 公開網址可以開啟
- [ ] 地圖顯示嘉義市
- [ ] 看得到路線、線形和站牌
- [ ] 點擊路線或站牌後有內容
- [ ] 到站時間可以查詢

通過這些項目，就已經是一套能獨立運作的 Mochi Bus。

<details>
<summary><strong>第一次操作：瀏覽器顯示一整段 JSON 要看哪裡？</strong></summary>

使用瀏覽器尋找功能：

- Windows / Linux：`Ctrl+F`
- macOS：`Command+F`

搜尋 `Chiayi`。應找到嘉義市城市代碼；starter 設定不應把 Taipei 等其他城市當成已啟用城市。

</details>

<details>
<summary><strong>深入驗證：如何確認城市快照已經生效？</strong></summary>

除了 `/api/v1/map/cities`，也可以開啟：

```text
/api/v1/map/routes?city=Chiayi
```

回應應包含路線陣列，並帶有目前快照的來源或版本資訊。若網站能開但這個 API 沒有路線，通常表示城市快照尚未成功發布。

</details>

## 常見問題

<details>
<summary><strong>工具、VS Code 與終端機</strong></summary>

<details>
<summary><strong>遇到錯誤：git、node、npm 或 npx 顯示找不到指令</strong></summary>

完全關閉 VS Code 再重新開啟。

若仍失敗，確認 Git 與 Node.js 已完成安裝，而不是只下載安裝檔。

</details>

<details>
<summary><strong>遇到錯誤：PowerShell 無法載入 npm.ps1</strong></summary>

把 `npm` 改成 `npm.cmd`，把 `npx` 改成 `npx.cmd`：

```powershell
npm.cmd install
npx.cmd wrangler whoami
```

不需要修改 PowerShell 執行原則。

</details>

<details>
<summary><strong>遇到錯誤：Could not read package.json 或 Missing script</strong></summary>

目前終端機不在 `mochi-bus` 資料夾。

PowerShell、macOS 和 Linux 執行：

```sh
pwd
```

Command Prompt 執行：

```bat
cd
```

最後一段路徑應該是 `mochi-bus`。

</details>

<details>
<summary><strong>遇到錯誤：npm install 出現很多警告</strong></summary>

`npm WARN` 通常不代表失敗。真正的安裝錯誤通常會顯示 `npm ERR!`，而且終端機會以非零狀態結束。

</details>

</details>

<details>
<summary><strong>設定檔與憑證</strong></summary>

<details>
<summary><strong>遇到錯誤：找不到 .dev.vars 或 .snapshot.env</strong></summary>

確認已執行對應的複製指令，並在 VS Code Explorer 按一下重新整理。

這兩個檔名開頭有一個 `.`，不是副檔名遺失。

</details>

<details>
<summary><strong>遇到錯誤：instance.json already exists</strong></summary>

代表先前已建立過設定。不要直接加 `--force` 覆蓋；先打開現有的 `instance.json`，確認是否就是要繼續使用的設定。

</details>

<details>
<summary><strong>遇到錯誤：D1 ID 填入後 validate 失敗</strong></summary>

確認：

- 只替換了 `null`
- ID 左右仍有雙引號
- 該行結尾逗點仍存在
- 沒有把 `databaseName` 改掉

</details>

<details>
<summary><strong>遇到錯誤：Missing TDX_CLIENT_ID or TDX_CLIENT_SECRET</strong></summary>

確認 repository 根目錄有 `.dev.vars`，兩個值都已替換，不是空字串或範例文字，而且已儲存。

</details>

</details>

<details>
<summary><strong>Cloudflare 資源</strong></summary>

<details>
<summary><strong>遇到錯誤：create 顯示資源已經存在</strong></summary>

列出目前帳號的資源：

```sh
npx wrangler d1 list
npx wrangler r2 bucket list
```

如果同名資源是你剛才建立的，就直接沿用，不要重複建立。若用途不明，先停止並確認。

</details>

<details>
<summary><strong>遇到錯誤：Snapshot publisher requires a provisioned D1 database ID</strong></summary>

檢查 `instance.json` 的 `cloudflare.d1.databaseId`。填好後重新執行：

```sh
npm run instance:validate -- --config instance.json
npm run instance:compile -- --config instance.json
```

</details>

<details>
<summary><strong>遇到錯誤：R2 credentials、Snapshot state writer unavailable 或 R2 403</strong></summary>

確認根目錄有 `.snapshot.env`，並且三個值都已填寫與儲存：

- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `CLOUDFLARE_ACCOUNT_ID`

再確認：

- R2 token 權限是 **Object Read & Write**
- token 包含 `my-chiayi-transit-shapes` bucket
- Account ID 和 `npx wrangler whoami` 屬於同一個 Cloudflare account
- `CLOUDFLARE_ACCOUNT_ID` 填的不是 Access Key ID
- Secret Access Key 沒有多複製空格

</details>

<details>
<summary><strong>遇到錯誤：Cloudflare 資源互相對不上</strong></summary>

依序確認：

1. `npx wrangler whoami` 顯示的帳號
2. `instance.json` 的 D1 名稱與 ID
3. R2 bucket 名稱
4. `.snapshot.env` 的 Account ID
5. generated config 是否由最新的 `instance.json` 產生

不要再建立一組名稱相近的資源繞過問題。

</details>

</details>

<details>
<summary><strong>部署與城市快照</strong></summary>

<details>
<summary><strong>遇到錯誤：缺少 SNAPSHOT_SMOKE_BASE_URL</strong></summary>

錯誤可能是：

```text
Snapshot publisher requires a fixed public origin or SNAPSHOT_SMOKE_BASE_URL
```

目前終端機沒有公開網址設定，或仍保留 `PASTE_YOUR_WORKERS_DEV_URL_HERE`。重新設定實際網址後再執行。

</details>

<details>
<summary><strong>遇到錯誤：snapshot_publish_failure</strong></summary>

往上查看它前面的第一個錯誤訊息。修正後通常可以重新執行：

```sh
npm run snapshot:city -- Chiayi
```

不要只看最後一行，也不要先刪除 D1 或 R2。

</details>

<details>
<summary><strong>遇到錯誤：state_write_failed_reconcile_required</strong></summary>

新版本可能已經通過 smoke 並保持啟用，但快照狀態尚未完成。

保留完整輸出，不要刪除 D1 或 R2，也不要假設單純重跑一定能修復。這類錯誤需要使用 repository 內的 reconcile 維運流程處理。

</details>

<details>
<summary><strong>遇到錯誤：cleanup_failed</strong></summary>

新版本通常仍可服務，但舊版本資料可能尚未清理。

保留完整輸出。由於內容未變時下一次執行可能提前結束，單純重跑不保證再次執行 cleanup。

</details>

<details>
<summary><strong>遇到錯誤：網站能開，但沒有路線</strong></summary>

代表 Worker 已上線，但城市快照可能尚未成功發布。

確認快照指令最後有出現 `"status":"published"` 或 `"phase":"published"`，再檢查：

```text
/api/v1/map/routes?city=Chiayi
```

</details>

<details>
<summary><strong>遇到錯誤：city_not_enabled</strong></summary>

請求的城市不在 `instance.json` 的 `transit.enabledCities`。修改設定後重新執行：

```sh
npm run instance:validate -- --config instance.json
npm run instance:compile -- --config instance.json
npm run deploy -- --secrets-file .dev.vars
```

新增城市後，還要另外發布該城市的快照。

</details>

<details>
<summary><strong>遇到錯誤：generated artifacts 過期</strong></summary>

不要直接修改 `.generated/instance/`。重新產生即可：

```sh
npm run instance:compile -- --config instance.json
```

</details>

</details>

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

R2 bucket 裡有城市快照時不能直接刪除，要先清空內容。刪除 Worker 不會自動刪除 D1 或 R2；刪除遠端資源也不會動到本機的 `instance.json`、`.dev.vars` 或 `.snapshot.env`。

如果不再使用任何 R2 功能，也請到 Cloudflare Billing 和 R2 頁面確認 subscription 與帳單狀態。不要只刪除 Worker，就假設所有可能計費的資源都已移除。

## 接下來

完成 starter 部署後，可以再選擇：

- fork repository，長期維護自己的版本
- 加入第二個縣市
- 綁定自訂網域
- 用 GitHub Actions 自動更新資料
- 升級成 managed profile
- 定期同步 upstream 的 Mochi Bus 更新

這些進階路徑目前不屬於本篇的第一次安裝範圍。
