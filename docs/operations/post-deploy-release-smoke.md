# Post-deploy release smoke

A8 在 production Worker 部署完成後，從 GitHub-hosted runner 經由公開網路驗證實際提供服務的 release。它不是 `npm run check` 的別名，也不使用本機 Wrangler preview 作為 production evidence。

## 執行位置

`.github/workflows/deploy.yml` 的順序固定為：

```text
npm ci
→ npm run check
→ wrangler deploy --tag <full Git SHA>
→ install Chromium
→ npm run release:smoke
→ upload bounded report
```

Smoke 只在 `Deploy Worker` 成功後執行。Workflow 使用既有 `deploy-production` concurrency，且不新增 auto-merge、deployment environment 或自動 rollback。

Release smoke 的 origin、enabled cities、default city 與 demo route identity 都從同一次編譯產生的 instance runtime 讀取。呼叫端若以 `MOCHI_BUS_RUNTIME_CONFIG` 或 `MOCHI_BUS_WRANGLER_CONFIG` 指定其他 generated artifacts，target selection 也必須使用同一組 environment；不允許 origin 與城市範圍分別來自不同 instance。

## Release propagation gate

Runner 輪詢：

```text
GET /api/v1/health/release
```

必須同時符合：

- `schemaVersion === 1`
- `releaseSha` 精確等於觸發 workflow 的完整 `github.sha`
- `workerVersionId` 是 bounded identifier
- `workerCreatedAt` 是有效 ISO timestamp

預設最多等待 5 分鐘，每 10 秒一次。舊 SHA 或短暫 release-endpoint 網路讀取失敗留在同一 bounded timeout 內重試，不代表新 release 已壞；超時才以 `release_propagation_timeout` 結束。結構無效的 identity 不重試。

## Initial HTTP and asset smoke

確認新 release 後，依序驗證：

- `/`
- `/setup`
- `/map?city=<defaultCity>`

Map target 永遠跟隨 instance 的 `transit.defaultCity`，因此單城 fork 不會再請求未啟用的固定城市。每個頁面必須回傳 2xx HTML、DOCTYPE 與非空 title。Runner 從 HTML 的同源 `src`／`href` 開始，遞迴讀取 JS static imports、dynamic imports、CSS `@import` 與 `url()`，因此不只檢查穩定 entry files，也會實際讀取 Vite hashed chunks。

Asset graph 有固定節點上限；response body 也有固定 byte limit。外部 origin、data URL 與 blob URL 不進入 graph。任一同源 asset 404／5xx、HTML masquerading as JS/CSS、graph 無 asset、沒有 hashed chunk 或超過上限都使 smoke 失敗。

## Representative API smoke

Runner 最多選兩個代表城市，順序固定為：

1. route detail city：有 `demoQuery` 時使用 `demoQuery.city`，否則使用 `defaultCity`
2. 若與 detail city 不同，優先加入 `defaultCity`
3. 若仍有空位且 Chiayi 已啟用，加入 Chiayi 作為既有 cross-tier canary
4. 否則依 `enabledCities` 順序加入下一個城市

因此 production 仍驗證 Taipei 與 Chiayi；單城 instance 只驗證自身城市；而 demo city 與 default city 不同時，兩者都一定進入 API contract smoke。

每個代表城市都必須通過：

- `/api/v1/map/routes` schema 2
- `source === snapshot`
- 非空 `snapshotVersion`
- 非空且有 `routeUid`／`routeName` 的 route catalogue
- `/api/v1/map/network` 64 KiB bounded prefix 的 city/version 與 catalogue 一致

Route detail city 有設定 `demoQuery` 時使用其 `routeName`，但不硬編 RouteUID。Runner 從已驗證的 catalogue 收集所有同名 RouteUID，去重並排序；route detail 必須至少有一個可用 snapshot variant，其 RouteUID 與該集合相交。

若 `demoQuery` 為 `null`，runner 會從 catalogue 中可被公開 route endpoint 接受的 route name 裡，以排序後第一個名稱作為 deterministic sample。Instance schema、operational loader 與 selector 都將 route name 限制為最多 40 字元，與 `/api/v1/map/route` 的輸入契約一致；過長名稱不會成為自動 sample。

通過 route detail 後，runner 取該 variant 第一個 stop 的 canonical place，再讀取 place arrivals。Arrivals 無論當下 realtime healthy 或 degraded，都必須維持：

- schema 1
- `scheduleSource === place-bundle`
- snapshot version 一致
- 非空 routes
- route source 只允許 realtime、stale-realtime、schedule、none
- warning 只允許既有 TDX warning enum
- realtime candidates/queries/rateLimited 欄位有效

Smoke 不刻意製造 TDX 故障，也不新增 production test backdoor。若當下自然出現 rate limit、quota 或 upstream unavailable，契約仍必須提供結構可用的 snapshot/schedule fallback。

## Fresh-browser boot

每次 deploy 使用新 Chromium browser context，`serviceWorkers: block`，依序驗證三個主要頁面。對每個目標，runner 先用即將載入該頁的同一個 Chromium page 導航至帶 synthetic probe token 的 release endpoint，最多等待 60 秒、每 5 秒一次；只有觀察到 exact release SHA 與同一 Worker version 後，才掛載 runtime error listeners 並導航目標頁面。這避免舊頁面先載入、release endpoint 稍後變新時留下假陽性。

browser context 先看到舊 SHA，或同一 SHA 但 Worker version 尚未一致時，會留在該窗口內重試。持續不一致收斂為 `release_propagation_timeout`；endpoint 持續不可讀或結構無效則收斂為 `release_observation_failed`。低階 `release_not_observed` 不得直接成為最終 Deploy evidence。

其他 hard failure 包含：

- document 非 2xx
- 主要 shell selector 不可見
- Map 沒有建立 Leaflet container
- `pageerror`
- console error
- 同源 JS/CSS request failure，包括 chunk load failure

不保存 console message、URL、query、stack 或 response body。

## Observation window

Initial HTTP 與 fresh-browser smoke 通過後，workflow 預設維持 10 分鐘觀察窗，每分鐘重新讀取 release endpoint。期間 release SHA 或 Worker version 改變、identity 不可讀或 release endpoint 失效都使 job 失敗。

觀察窗結束後，再跑一次完整 HTTP/assets/API postflight。這避免只在 deployment propagation 的第一個成功瞬間取樣。

## Failure policy

A8 不自動 rollback。

- release 尚未 propagation：等待，直到 bounded timeout
- hard smoke failure：deploy job 失敗，停止把此 workflow 描述成成功 deployment
- TDX degraded 但 fallback contract 有效：smoke 可成功，report 記錄 `degradedObserved`
- data/snapshot 單城問題：由 snapshot operations 處理，不回退無關 Worker

人工 rollback 前仍須確認問題可重現、命中新 release，且不是 TDX、單城 snapshot 或 transient propagation。

## Evidence and privacy

Workflow 永遠上傳 `release-smoke-report.json`，保留 14 天。

成功 report 只包含：

- release SHA
- Worker version ID／created time
- started/completed time
- page、asset、hashed asset、city counts
- 是否觀察到合法 degraded response
- browser error counters
- observation check count

失敗 report 只包含 allowlisted `failureClass` 與 expected release SHA。禁止保存完整 URL、route/stop/place identity、console message、raw Error、stack、response body、credential、token 或 secret。

## Local contract verification

CLI target selection 與 instance runtime contract 由下列測試驗證，不需接觸 production：

```text
npm run test -- scripts/release-smoke/run-post-deploy.test.mjs scripts/instance/operational-resources.test.mjs
npm run test:instance
```

真正的 `npm run release:smoke` 預設會打 production origin；除 deploy workflow 或明確受控操作外，不應拿它當一般本機單元測試執行。
