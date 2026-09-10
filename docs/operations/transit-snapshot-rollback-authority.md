# Transit snapshot rollback authority

本文件定義 snapshot rollback 與 metadata reconcile 的 authority、完整性、併發和失敗語意。它不授權任何 production 執行；production rollback 或 reconcile 仍需另行明確核准。

## Authority model

`dataset_versions.active_version` 是目前服務版本的唯一 authority。R2 `snapshots/state/<City>.json` 是衍生的操作 metadata，用來記錄 active／previous 與 manifest 摘要，但不能決定目前線上服務版本。

一般 rollback 必須先同時讀取 D1 active 與 R2 state：

- D1 active 缺失或格式無效時 fail closed。
- R2 state 缺失或 schema／version 無效時 fail closed。
- `state.version !== D1 active` 時，在任何 mutation 前 fail closed。
- explicit target 與預設 `state.previousVersion` 使用完全相同的 target validation。
- 不提供 `--force` 或其他略過 authority／integrity gates 的選項。

「目前服務版本由誰決定」與「該版本的高基數 routing data 在哪裡驗證」是兩件事。前者永遠是 D1 `dataset_versions.active_version`；後者由四個 routing completion manifests 決定：

- **0/4 manifests：`legacy-d1`**。這是 pre-cutover 版本，高基數 `stops` / `pattern_stops` 仍以 D1 為 rollback validation authority。
- **1–3/4 manifests：incomplete**。沒有可接受的 routing authority，mutation 前 fail closed。
- **4/4 manifests：R2 authority**。四份 completion manifest、counts、fingerprints 與 deterministic pattern-stop sample 都必須通過 bounded validation；之後再與 root manifest 做 binding。
  - root manifest 完全沒有列出四份 completion manifests：`legacy-backfill`。這是 rollout 期間回填的相容模式，仍可依已驗證的 R2 routing authority執行 rollback。
  - root manifest只綁一部分：fail closed。
  - root manifest完整綁定四份 manifest的 exact bytes + SHA-256：`root-bound`。

`legacy-backfill` 可作為 rollback authority，不代表已可刪除 legacy D1。只有 production evidence證明保留的 active／previous rollback window 都是 `root-bound`，才可把 destructive legacy high-card row/index/schema cleanup列入下一步。

舊版本的 backfill只新增同版本 routing artifacts/completion manifests，不回頭改寫 immutable root `manifest.json`，所以最多把舊版本從 `legacy-d1` 升成 `legacy-backfill`，不能 retroactively 變成 `root-bound`。新 publisher會在建立 root manifest前把四份 completion manifests納入 artifact fingerprint，因此新 publication天然是 `root-bound`。Authority evidence用 `nativeRootBoundPublicationsRequired` 表示在目前 retained active／previous window下，至少還需要幾次成功的原生 publication才能自然得到完整 root-bound window：active與previous皆 root-bound為 0；active已 root-bound但previous仍是 legacy為 1；active仍是 legacy則為 2。這只是 readiness evidence，不會觸發 publication，也不會放寬 rollback drill gate。

## Commands

預設 rollback 到可信 state 中的 previous：

```powershell
npm run snapshot:rollback -- Chiayi
```

指定保留中的版本：

```powershell
npm run snapshot:rollback -- Chiayi 20260711T000000000Z
```

依 D1 active 重建 R2 state metadata：

```powershell
npm run snapshot:reconcile -- Chiayi
```

當現有 state 缺失、無效或與 D1 分歧時，舊的 `previousVersion` 不可信，必須明確提供已知 previous；工具不會自行猜測：

```powershell
npm run snapshot:reconcile -- Chiayi 20260711T000000000Z
```

Reconcile 只驗證並更新 R2 state，永遠不修改 D1 active pointer。相同 authority 與 evidence 重跑會得到相同 state；已一致時不重寫。

## D1／R2 divergence

### D1 active = v2, state.version = v1, state.previousVersion = v0

一般 rollback 在任何 mutation 前回報 `authority_mismatch`。`v0` 來自已分歧 state，不能直接成為 reconcile previous。操作者必須先確認 D1 `v2` 健康，再提供經完整驗證的 previous；reconcile 只把 R2 state 收斂到 D1 authority。

### D1 已切到 v2、public smoke 成功、R2 state PUT 失敗

`v2` 保持 active，不盲目切回。publisher 回報 `state_write_failed_reconcile_required`，也不執行 cleanup，確保舊版本仍可供復原。後續以 D1 `v2` 為 current authority 執行 reconcile。

這是 metadata finalization failure，不得描述為 snapshot staging／validation failure，也不得因 R2 state stale 就覆寫 D1 pointer。

## Validation responsibility

Rollback／reconcile 寫入前，所有 target 先判定 routing authority，再走對應完整性路徑。

### 共用的低基數與 artifact gates

不論 legacy 或 R2 routing authority，都必須驗證：

- D1 routes、patterns、stop_places 非零。
- pattern → route 無 dangling reference，catalogue route 都有 pattern。
- root manifest schema/city/version合法。
- network object 存在、size（若可得）與 manifest 一致，bounded prefix 的 schema／city／version 正確。
- deterministic route sample的 shape、route schedule、place bundle以 root manifest descriptor的 bytes 與 SHA-256 完整驗證。

### `legacy-d1` target

只有 0/4 routing completion manifests 的 pre-cutover target，才要求 D1 高基數 validation：

- D1 `stops`、`pattern_stops` 非零。
- route／pattern／stop／place 交叉引用無 dangling rows。
- 每個 pattern 至少兩站。
- pattern stop 的 place 與 canonical stop一致。
- root manifest counts必須與包含高基數 D1 rows的 legacy evidence一致。

這條路徑保留的是舊版本 rollback compatibility；它不是新 snapshot publisher 的正常儲存模型。

### R2 routing-authority target

四份 routing completion manifests全部存在時，不得要求或偷偷 fallback到 D1 `stops` / `pattern_stops`：

- completion manifests必須全部存在且可 bounded-read；部分存在直接 fail closed。
- manifest identity、cross-manifest counts、descriptor keys/bytes/SHA-256必須一致。
- deterministic pattern-stop artifact必須依 descriptor fingerprint完整驗證，並提供 rollback sample的 `patternId` / `placeId`。
- R2 authority的 pattern/place counts必須與低基數 D1 `patterns` / `stop_places`一致；stops/patternStops counts由 R2 authority提供。
- 四份 completion manifests再與 root manifest做 exact fingerprint binding；無 binding為 `legacy-backfill`，完整 binding為 `root-bound`，partial/mismatched binding fail closed。

切換後仍由 public smoke 負責：

- route catalogue 回報 exact active version 與 count。
- exact route variant 存在且至少兩站。
- exact place bundle 使用該 active version並包含同一 variant。
- public network prefix 回報同一 active version。

日常 active probe 的 freshness window、durable probe evidence、sample rotation與 realtime diagnostics 不屬於 rollback target 的 mutation 前責任，因此不直接複製全部 active hard checks。

## Optimistic concurrency

Publisher activation、rollback activation與 smoke failure restore 都使用 expected-current guard：

```sql
WHERE active_version = <expected current>
RETURNING active_version
```

受影響列不存在時回報 `activation_conflict` 或 `restore_failed`，不得繼續 smoke、state write 或 cleanup。

Reconcile 不寫 D1，但在完整驗證後、寫 R2 state 前會再次讀取 D1 active；若 authority 已改變，停止而不寫 stale metadata。

GitHub Actions publisher 共用 `transit-snapshot` concurrency group；本機 CLI 不依賴 workflow lock，因此 D1 optimistic guard 與寫入前 authority re-read 是必要的最後防線。

## Failure semantics

| Outcome | Pointer／metadata 語意 |
| --- | --- |
| `target_validation_failed` | mutation 前停止；D1/R2 不變。 |
| `active_pointer_invalid` | 無可信 current authority；mutation 前停止。 |
| `state_invalid` | 一般 rollback 不信任缺失／無效 state；mutation 前停止。 |
| `authority_mismatch` | D1 與 R2 state 分歧，或 reconcile 驗證期間 authority 改變；不寫 stale metadata。 |
| `activation_conflict` | expected-current guard 未修改 D1；不執行 smoke／state write／cleanup。 |
| `smoke_failed_restored` | target smoke 失敗，但 original active 已以 guard 恢復；rollback attempt 失敗，current service authority 已復原。 |
| `restore_failed` | target smoke 失敗且 original pointer 無法恢復；最高優先級 authority failure，立即人工確認 D1 與 public API。 |
| `state_write_failed_reconcile_required` | D1 target 與 public smoke 健康；保持 D1 authority，不 cleanup，不盲目 rollback，後續 reconcile。 |
| `reconcile_previous_required` | stale／缺失 state 無法可靠決定 previous；必須明確提供經驗證版本。 |
| `reconcile_failed` | R2 state 未成功收斂；D1 pointer不變。 |
| `cleanup_failed` | healthy active 與 state finalize 已完成；不 rollback，只保留額外 immutable artifacts／rows 待後續清理。 |

所有 CLI diagnostics 只輸出固定 event、operation、city、allowlisted outcome 與 bounded version identifiers。不得輸出 credential、完整 URL、response body、command stderr、raw `Error`、message 或 stack。

## Production safety

合併程式碼不會自動執行 rollback 或 reconcile。執行前必須另行確認城市、D1 active、可信 previous、完整 validation evidence 與操作授權；不得拿既有 legacy repair 城市當 rehearsal，也不得建立一次性 production executor。

若要決定是否可以退休 legacy D1 high-card data，不可只看某一次 rollback成功；應使用 rollback drill的 pre-mutation authority evidence確認 active、previous與實際 rollback target的 mode，並要求保留 window 的 `rootBoundRollbackWindow=true` 後再進 destructive cleanup。