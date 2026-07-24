# Mochi Bus 生產可觀測性與故障復原實作狀態 — 2026-07-22

> 本文件是目前 repository implementation tracker，不是即時 production health dashboard，也不取代 2026-07-19 的審計判斷。狀態於 2026-07-24 重新核對 `main` commit `82f6b8645cd0ed03a82cf70eb39f33402bb3bd8b`。Repository 能力、PR checks、Deploy workflow 結果與 production acceptance 是不同證據層級；沒有 durable workflow／artifact 證據時，不得把「已合併」寫成「production 現在健康」。

原始審計的故障模型、telemetry contract、decision matrix 與三階段方案，保留在 [2026-07-19 immutable audit snapshot](https://github.com/a20030824/mochi-bus/blob/c76d75a454d1c552b90e31fa6cedb90df5805dbb/docs/audits/2026-07-19-production-observability-recovery-audit.md)。

## 1. 如何閱讀狀態

- **已合併**：實作已在 `main`，但不等同於此刻 production 一定健康。
- **Repository 已驗證**：對應 exact head 的 repository checks 通過；這不是 production acceptance。
- **Production acceptance 已驗證**：必須有可重讀的 Deploy workflow 結果、exact release identity 與 bounded artifact。
- **部分完成**：已有相鄰保護，但原審計定義的完整能力仍未建立。
- **待設定**：屬於 GitHub／Cloudflare repository setting，不應偽裝成程式碼 PR 已完成。

## 2. Phase A 實作狀態

| 批次 | 目前狀態 | 主要證據與邊界 |
| --- | --- | --- |
| A1 telemetry schema/privacy boundary | 已合併（`b13057c`） | Allowlist envelope、禁止欄位、fail-open emitter 與測試已建立；原始 batch 不含產品 callsite。 |
| A2 release identity | 已合併（`baea152`） | Version Metadata、完整 release SHA 與唯讀 release identity 已建立；`deploymentId` 沒有被 Worker version 冒充。 |
| A3 API completion denominator | 已合併（`22933f0`） | 四個 Map operation 使用 complete-once、固定 cohort sampling 與 success／degraded／empty／error 分母。 |
| A4 TDX resolution completion | 已合併（`0673335`） | memory／edge／upstream／circuit／stale 與受控 retry 被收斂為一筆 logical resolution completion。 |
| A5a snapshot window outcome | 已合併（`aad570b`） | Durable attempt/canonical window、deterministic window ID、source/publish time 分離與安全 summary 已建立。 |
| A5b unchanged active probe | 已合併（`c2c45e3`） | `unchanged` 前驗證 D1 authority、manifest、network、public catalogue 與 deterministic route/place sample；後續另有 bounded manifest/network metadata hardening。 |
| A6a missed-window watchdog | 已合併（`feb9aa6`） | 共用 Asia/Taipei schedule/window identity、07:30 close、07:45 watchdog、durable run/city result 與 probe evidence expiry 已建立。A6 evidence 後續由 PR #56、#58、#59、#60 修復、重跑並清除一次性 trigger。 |
| A6b daily public probe | 已合併（`614ad00`） | 每日 22 城公網 probe、hard health／realtime diagnostics、bounded reads、rotation 與 durable completion 已建立；probe 曾實際抓出 snapshot catalogue/pattern 問題，後續由 PR #50、#53 修正。 |
| A7 rollback authority | 已合併／Repository 已驗證（`f3abd0ac`，PR #156） | D1 active 是唯一 current authority；完整 target gate、expected-current transition、smoke restore、R2 reconcile、state-write/cleanup failure separation 與 bounded diagnostics 已建立。此 tracker 沒有把能力合併誤寫成已執行 production rollback 或 reconcile。 |
| A8 post-deploy release-specific smoke | Repository 實作完成；production acceptance 尚未在 tracker 建證 | PR #157 建立 exact-release HTTP/assets/API/browser/observation gate；PR #158–#162 依首次 Deploy 暴露的真實 failure evidence，修正 route ETA race、代表性 route identity 與 browser edge propagation。能力已在 `main`，但本文件尚未記錄一筆成功 Deploy run 與其 `release-smoke-report.json`，因此不能宣稱 production acceptance。 |
| A9 fresh-browser + organic frontend evidence | 部分完成 | PR #145 隔離 stateful E2E；PR #146 加入 Linux visual regression；PR #157–#162 提供 deploy-time synthetic fresh-browser evidence。這些都不等同於 production organic frontend boot/runtime collector。 |

## 3. 2026-07-22～2026-07-24 remediation log

| PR | Merge commit／狀態 | 已完成 | 明確未包含 |
| --- | --- | --- | --- |
| #142 `fix(ci): verify production release before deploy` | `9c77506cf353a5cc60452532d32c626bf1bf05af` | Deploy workflow 在 `npm ci` 後執行完整 `npm run check`，阻止未通過 exact-release 驗證的 commit 發布。 | GitHub ruleset 的 strict up-to-date checks；真正 post-deploy smoke。 |
| #143 `fix(map): keep failed timetable stop navigation consistent` | `6d2c318e40f6071b25924539687d12e7eae7d059` | 明確選取的 timetable stop 在 request 前寫入 session/URL；失敗、retry、reload 不再退回舊站牌。 | Timetable API/schema 或 rendering 重寫。 |
| #144 `fix(observability): bound production error logs` | `3cef46289b76d8c15ad9e1430dcd49ea264e216e` | 三個高風險 Worker callsite 改用 bounded structured record，只允許 event、operation、city、failureClass、errorType。 | API response、fallback denominator、snapshot CLI diagnostics 或第三方 logging。 |
| #145 `fix(e2e): isolate shared Worker state` | `c193779e0ac9a8bc101a59ab2d1976b1c029ffba` | 普通 UI 與 Worker-stateful suite 分開執行；stateful case 使用 fresh Wrangler、單 worker、逐案 reset，普通 UI API request 被 firewall。 | Production reset endpoint；test route 沒有明確 test binding 時回 404。 |
| #146 `ci(visual): run screenshot regression on Linux` | `c76d75a454d1c552b90e31fa6cedb90df5805dbb` | 六張 reviewed Linux baseline 接入獨立 read-only visual job；差異失敗時保留 expected／actual／diff/report。 | 尚未加入 required-check ruleset；CI 不會自動更新或 push snapshot。 |
| #155 `ci(snapshot): make manual city input a choice` | `fbb4a96b78b44f8e3e497cd89f11a73f6c2317e1` | Manual snapshot dispatch 使用與 `supportedCities` 精確一致的 22-city choice。 | Scheduled sharding、repair guards、snapshot algorithm。 |
| #156 `fix(snapshot): enforce rollback authority` | `f3abd0ac0827f674fa34e93307416b2508d1b667` | A7 authority、reconcile、optimistic guard、完整 target evidence、failure semantics 與 runbook。 | Production rollback/reconcile、A8、A9。 |
| #157 `feat(deploy): verify the deployed release` | `59ae5941ec0c38b46f2c4d2d6aa6a4461bc3ac1e` | Deploy 後 exact release SHA／Worker version propagation、pages、recursive hashed assets、Taipei/Chiayi API、degraded-capable arrivals、fresh Chromium、10 分鐘 observation、final postflight 與 bounded artifact contract。 | 自動 rollback、Visual required check、organic frontend collector。 |
| #158 `fix(tdx): keep route ETA degraded fallback stable` | `611feb6032ea10892a14c0557358aeba1b58d794` | 首次 A8 pre-deploy check 暴露的 route ETA concurrency race：station order 與 ETA 保持並行，但以 `Promise.allSettled()` 等待 station-order cache/singleflight lifecycle 完成後再進入既有 degraded fallback。 | Rate-limit 放寬、circuit/retry redesign、自動 rollback。 |
| #159 `fix(release): use a stable route smoke sample` | `8bd6e4a17928d7de045a70188104f4c332f4ea84` | A8 不再依賴 catalogue 第一筆，改用語意樣本 `307`。 | Product API、snapshot mutation、手動 deploy。 |
| #160 `fix(release): derive route smoke identity from catalogue` | `a52bdc3c5ea25c5dea0c96eee649f08b7a8b91dc` | 保留 `307` 語意樣本，但 RouteUID 從已驗證的當期 catalogue 推導，避免把易變 TDX UID 當永久產品契約。 | Default route 行為、snapshot republish、rate-limit 變更。 |
| #162 `fix(release): wait for browser edge propagation` | `9dc4afab0b1359ea85f391eb0451e63e565f0de4` | Fresh Chromium 在載入目標頁前，使用同一 page bounded polling exact SHA 與同一 Worker version；持續 edge mismatch 收斂為正式 propagation failure class，不再洩漏低階 one-shot `release_not_observed`。 | Route sampling、product API、rollback、A9。 |

## 4. 相鄰但獨立的 Shape matcher production gate

Shape-to-pattern matcher 的 production integration 不屬於 A1–A9，但其量測／artifact 邊界與本 tracker 使用相同的證據原則：

- PR #161（`c76c90777c8601496d109effe86ac6e0f81b7e3b`）合併 replayable raw-cache、uninstrumented／instrumented measurement、deterministic report reconciliation、transactional publication 與 bounded cleanup/error contracts。
- PR #163（`82f6b8645cd0ed03a82cf70eb39f33402bb3bd8b`）加入 manual-only、read-only、credentialed 九城市＋InterCity workflow；只允許 formally verified report copies 進入 14-day artifact，並在 live acquisition 後立即移除 TDX credentials。
- 合併 harness／workflow 不等於 matcher production readiness。必須先在 `main` 手動 dispatch、取得 artifact，並正式 review latency、memory、projection frontier、assignment proof 與 Direction 2 distributions；Production PR 2 在此之前保持 blocked，PR 3 尚未開始。

## 5. 目前仍需處理

### Production evidence

1. **A8 production acceptance**：找到一筆由 A8-capable `main` commit 觸發且成功完成的 Deploy workflow，核對 exact release SHA／Worker version、initial HTTP/assets/API/browser smoke、10 分鐘 observation、final postflight，並讀取 `release-smoke-report.json`。在記錄 workflow run ID、artifact identity 與結果前，A8 只能標成 repository implementation complete。
2. **Shape matcher credentialed measurement**：從 GitHub Actions 的 `Measure Shape-to-pattern matcher` workflow，在 `main` 輸入 `MEASURE` 手動執行；下載並 review verified artifact。不得改成 push/schedule 自動消耗 TDX credentials，也不得上傳 raw cache。

### Repository settings

1. `main` ruleset 的 **Require branches to be up to date before merging** 狀態只存在 GitHub setting；tracker 不把程式碼 PR 當成設定證據。
2. 觀察 `Visual regression` 經過一般 UI 變更的穩定度，再決定是否加入 required status checks。

### Product／operations capability

1. **A9 organic frontend evidence**：只有 production error volume、release correlation 與 triage 需求證明必要時，才加入 bounded collector；不得記 URL/query、精確位置、board/journey identity、raw error 或 stack。

## 6. 驗證與維護規則

- 每次更新本 tracker，必須寫明核對日期與 `main` SHA。
- 不得把 PR checks 通過寫成「production 現在健康」。
- 不得把 pre-deploy verification 寫成 post-deploy smoke。
- 不得把 Playwright／visual／deploy-time synthetic evidence 寫成 organic frontend telemetry。
- Production acceptance 必須能回指 workflow run、exact release identity 與 bounded artifact；缺任一者就維持未驗證。
- 原始審計結論應以 immutable commit 保存，不回頭改寫當時未知的事實。
