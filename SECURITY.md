# 安全政策

Mochi Bus 是一個人維護的開源專案（Apache-2.0），沒有專職資安團隊，回報處理是盡力而為，不保證回應時限或修補時程。

## 支援範圍

只有 `main` 分支與線上正式站 [bus.moc96336.com](https://bus.moc96336.com/) 在維護中，沒有版本分支需要回溯修補。

## 回報漏洞

**請不要**用公開 GitHub Issue 回報安全漏洞。改用 GitHub 的私密回報管道：

[Report a vulnerability](https://github.com/Mochi96336/mochi-bus/security/advisories/new)（repo 的 Security 分頁 → Advisories → Report a vulnerability）

回報時盡量附上：

- 重現步驟或 PoC（curl 指令、request/response 範例皆可）
- 影響範圍(哪個 endpoint／頁面／資料)與可能後果
- 是否需要特定前提(例如自備 TDX 憑證、特定城市的快照狀態)

## 範圍內

- Worker 本體(`src/`)：路由、rate limiting、輸入驗證、BYOK 憑證處理、edge security headers
- 前端頁面(`web/`、`src/ui.ts`、`src/map-page.ts`)：XSS、CSP 繞過、跨站請求問題
- 快照發布管線(`scripts/`)：驗證閘門繞過、發布未經驗證的資料

## 範圍外

- TDX 平台本身的服務品質或資料正確性(請回報給[交通部 TDX](https://tdx.transportdata.tw/))
- 第三方套件的上游漏洞(請直接回報給該套件專案；可以順便讓我們知道好排定升級)
- 需要實體接觸裝置、社交工程或已知過期瀏覽器才成立的攻擊
- 已經在 [`docs/HEALTHCHECK-2026-07-10.md`](docs/HEALTHCHECK-2026-07-10.md) 風險登錄表中被記錄為已知、正在排隊處理的項目——歡迎回報以確認我們沒漏掉，但不算新發現

## 已公開的安全實作紀錄

專案的邊緣傳輸安全設定(HTTPS/TLS/HSTS)、驗證與部署證據記錄在 [`docs/operations/edge-security.md`](docs/operations/edge-security.md)；資料/BYOK/API 防護相關的完整整改紀錄在 [`docs/HEALTHCHECK-2026-07-10.md`](docs/HEALTHCHECK-2026-07-10.md)。
