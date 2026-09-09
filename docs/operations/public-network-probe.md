# Public network probe

A6b 每日從 GitHub Actions 公網 runner 建立一條與發布流程、A6a watchdog 完全獨立的證據鏈:

```
GitHub public network → DNS/TLS → Worker release → public API → active snapshot → route/place/network contract
```

A6a watchdog 只讀 D1、不打公開 API;它的 Green 不能代替公網可用性。這個 probe 反向:每日 08:20 Asia/Taipei(UTC cron `20 0 * * *`)對全部 22 個 snapshot 城市走真實公開路徑。D1 只作唯讀低基數參考(`dataset_versions.active_version`、routes/patterns/stop_places counts、deterministic sample),所有 hard 判定都來自公開 API 的實際回應。`stops` / `pattern_stops` 不再是 root-bound 新版本的 D1 reference；route detail、place bundle 與 network 路徑會經公開 Worker 實際 exercise R2 routing authority。Probe 只寫自己的 `public_probe_*` 表,不修改 dataset_versions、R2、artifacts 或 snapshot window/watchdog 結果。

每日 public probe 的 GET 必須使用與一般使用者相同的公開 URL，不附加 synthetic case query、`snapshot` 或 publisher `probe`。唯一例外是 hard-only place-bundle 驗證會使用公開且明確的 `realtime=0`，要求同一個 arrivals handler 只讀 snapshot/schedule、不得接觸 TDX；這不是 pinned snapshot authority。`sampleCaseId` 只用於 deterministic rotation、sampled journey leg identity、D1 evidence 與 telemetry。`probe` 仍保留給帶 exact active `snapshot=<version>` 與 bounded city/window identity 的 publisher snapshot-pinned reads。

## 兩個健康平面

Snapshot hard health 與 realtime health 是分開的平面。Snapshot 平面每天 22/22 城完整覆蓋；TDX-backed realtime diagnostics 則每日 deterministic 抽 4 城。未抽 realtime 的城市必須標 `snapshot_healthy`，不能假裝成完整 `healthy`。

### Hard health(可判 Red)

每城 10 個 hard check,失敗即 `hard_failed`:

| Check | Failure class |
| --- | --- |
| D1 active pointer 存在且格式合法 | `active_pointer_missing` / `active_pointer_invalid` |
| active version 的低基數 D1 routes/patterns/stop_places 非空 | `active_rows_empty` |
| catalogue 沒有無 pattern 的 route | `route_without_pattern` |
| `/api/v1/map/routes` 回 200 且 schemaVersion 2 | `public_routes_failed` / `public_schema_invalid` |
| routes source 為 `snapshot` | `public_source_not_snapshot` |
| routes snapshotVersion 等於 D1 active | `public_version_mismatch` |
| public route count 等於 active dataset count | `public_count_mismatch` |
| deterministic route detail 有 sampled variant 且 ≥2 stops | `route_sample_failed` |
| deterministic place arrivals 用 place-bundle 且版本相符；未抽 realtime 時用 `realtime=0` | `place_bundle_sample_failed` |
| `/api/v1/map/network` 64 KiB prefix 的 schema/city/version 相符 | `network_missing` / `network_version_mismatch` |

高基數 `stops` / `pattern_stops` 的完整性不靠 public probe 直接 COUNT D1：root-bound 版本沒有這份 D1 copy。routing completion manifests、root binding 與 artifact fingerprint 是 publisher/rollback authority gate 的責任；public probe 則從使用者真正會走的公開 route/place/network surface 驗證 active version 沒有因 authority cutover 而破壞。

### Realtime diagnostics(只降 Yellow)

只有當天被 deterministic rotation 選中的 4 城，在 hard 10/10 全過之後才跑完整 realtime plane。任何 realtime 失敗都不會把城市判 Red,也不會讓 job 失敗:

| Warning | 觸發 |
| --- | --- |
| `realtime_upstream_degraded` | arrivals/journey 帶 warning、TDX 429/quota/timeout、rateLimited |
| `realtime_schedule_only` | 有 realtime candidates 但全部只剩 schedule |
| `realtime_stale_replay` | 任一 arrivals source 為 stale-realtime |
| `journey_estimate_unknown` | synthetic journey estimate source 為 none 或呼叫失敗 |
| `vehicles_upstream_degraded` | vehicles schema 異常或帶 warning;合法空車清單不觸發 |

沒有被抽中的 18 城不執行 Journey ETA 或 Vehicles，也不讓 place arrivals 進入 TDX；因此它們只有 snapshot hard-health evidence，狀態是 `snapshot_healthy`。

## 流量紀律

- 不下載雙北完整 network:`/api/v1/map/network` 只讀 64 KiB bounded prefix 後放棄 stream。
- Snapshot hard health 仍每天全量 22 城，不因省 TDX 額度降低 public snapshot coverage。
- Realtime 每天只抽 4/22 城；每個 sampled city 固定一個 synthetic journey case(單 leg)、一次 place arrivals 與一次 vehicles。名義上的 realtime resolution 從至少 66/day 降到約 12/day，實際 upstream 次數仍由 edge cache、singleflight 與 circuit breaker 決定。
- 未抽中的 place arrivals 使用 `realtime=0`；candidate/query 均為 0，不取得 token、不讀 shared realtime cooldown、不回放 stale realtime。
- Expensive rate-limit 桶(30/min/IP):arrivals、network、journey 之間至少間隔 2.5 秒，避免 probe 自己觸發 public API rate limit。
- Probe 自己的 429 是 `probe_rate_limited` → `unknown`,證據不完整,不判城市 Red。

## Rotation

Route/place sample 的 deterministic rotation 仍以 `public\n<city>\n<probeDate>\n<probeCaseVersion>` 為種子,與 A5b 的 `<city>\n<windowId>\n<probeCaseVersion>` 為兩條獨立序列,內外兩套 probe 不會永久命中同一 route/place。`PUBLIC_PROBE_CASE_VERSION` 由 `public-probe-contract.mjs` 獨立管理。

Realtime coverage 另以「日期 × sample size」在固定的 enabled-city schedule order 上移動連續 window。Production sample size 是 4；22 城在最多 6 個每日 run 內都會至少被抽到一次。這個 selection 不靠亂數，因此同一天重跑 workflow 會抽到相同城市，證據可重現，也不會因 retry 額外擴大 TDX coverage。

## Status policy

| Status | 意義 | Job policy |
| --- | --- | --- |
| `healthy` | hard 10/10，且該城今日有抽 realtime、無 warning | success |
| `snapshot_healthy` | hard 10/10，但該城今日沒有抽 realtime | success；不得解讀為 realtime Green |
| `realtime_degraded` | hard 10/10，該城有抽 realtime 且有 warning | success;summary 顯示 Yellow |
| `hard_failed` | 任一 hard check 失敗 | fail |
| `unknown` | D1 參考不可讀、probe 被限流等基礎設施問題 | fail;不宣稱城市失敗、不得觸發 rollback |
| `record_write_failed` | probe 執行了但 durable 記錄寫入失敗 | fail |

所有城市都會完成評估後才決定 exit code。`hard_failed` 只代表公開面與 active dataset 的矛盾需要人工調查;這個 probe 沒有任何自動修復或 rollback 行為。

## Queries

```powershell
npx wrangler d1 execute mochi-transit --remote --command "SELECT probe_date, city_code, status, active_version, observed_version, failure_class, warnings FROM public_probe_city_results ORDER BY evaluated_at DESC LIMIT 30"
npx wrangler d1 execute mochi-transit --remote --command "SELECT * FROM public_probe_runs ORDER BY evaluated_at DESC LIMIT 10"
```

Telemetry `public_probe_completed` 每城市恰好一筆、100% synthetic sampling。完整 realtime Green 的 `healthy` 事件是 `result: success`；`snapshot_healthy` 與 `realtime_degraded` 都是 `result: degraded, source: snapshot`，避免「沒有抽 realtime」被 telemetry 誤看成完整 Green。事件只含 city、固定 enum、版本、case id 與計數;不保存 URL、route/place identity、credential、raw error 或 response body。