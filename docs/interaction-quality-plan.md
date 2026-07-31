# Mochi Bus 互動品質提升計畫（修訂版）

> 目標不是讓畫面更炫，而是讓每一次點擊後的半秒可信。

**文件狀態：** 待批准
**適用範圍：** 首頁 `/`、地圖 `/map`、設定 `/setup`、完整路線 `/route`
**與設計系統的關係：** 本文件只描述**範圍、排程與實作規格**。所有互動「規則」最終寫入 [design-system.md](design-system.md) 的 Interaction rules，不在此另立一套規範。

---

## 一、與初版計畫的差異

初版把三件事列為第一階段：`async-action-state`、`loading-gate`、`roving-tabs`。核實程式碼後做了四項調整：

| 調整 | 原因 |
|---|---|
| **新增 PR 0（live region 清理）並排在最前** | `#map-drawer` 與 `.cover` 是容器級 `aria-live`，會讓第一階段的成功／失敗宣告雙重朗讀，也讓第二階段的 settled announcement 在原理上無法生效 |
| **PR 順序改為 tabs → async → gate** | tabs 只碰一個檔案且已有測試檔；async 橫跨三頁並與既有 coordinator 有交界，不該當第一個 |
| **移除 `focus-boundary.ts`、砍掉 Collapsible Notice 的 `dismissed` 態** | 兩者都只有一個真實 call site，違反本計畫自訂的「每套工具先服務兩個以上情境」 |
| **`async-action-state` 不再自帶 run ID** | 專案已有兩套世代機制，第三套會互相打架 |

### 修訂紀錄

第二次審查修正了三處 `async-action-state` 的規格錯誤：

| 原稿 | 修正 | 理由 |
|---|---|---|
| retry 按鈕在 `DrawerViewSession.onDispose` 註冊 `dispose()` | 改為 **pending-only + `isConnected` 保險**，不接 dispose | session 是 render 的回傳值，按鈕卻必須在 render 前建立，順序上接不起來；且 retry 按鈕活不到 settle 階段（§6.7c） |
| 例外不往外拋，回傳 `undefined` | 改為 **discriminated result**，`reason` 原樣交還 | 違反 [place-routes-controller.ts:157-166](../web/map/place-routes-controller.ts#L157-L166) 既有原則；TDX 需要 error 物件才能產生訊息（§6.4） |
| `quiet` 時仍在按鈕設 `aria-busy` | 改為 **`busyTarget` 選項，預設不設** | 按鈕 pending 期間是 `disabled`，已移出 AT 互動模型；busy 屬於內容變動的區域（§6.6） |

---

## 二、現況核實

初版對現況的描述有四處高估。以下為實際狀態，作為範圍縮減的依據。

### 2.1 已經成立的行為（不需重做）

| 初版認定的缺口 | 實際狀態 | 證據 |
|---|---|---|
| 「Loading 與完成內容直接替換，缺少穩定交接」 | 附近站牌的 loading 與 resolved view **共用同一個 `drawerKey`**，因此不重播進場動畫、保留 scrollTop、沿用 size memory | [nearby-places-view.ts:41](../web/map/nearby-places-view.ts#L41)、[drawer-view.ts:134](../web/map/drawer-view.ts#L134)、[drawer-view.ts:138](../web/map/drawer-view.ts#L138) |
| 「設定 Picker 缺少焦點管理」 | 開啟已 `city.focus()`、關閉已回 `addBoardButton.focus()`、Escape 已可關閉 | [setup/main.ts:215](../web/setup/main.ts#L215)、[:231](../web/setup/main.ts#L231)、[:665](../web/setup/main.ts#L665) |
| 「舊請求可能覆蓋新畫面」 | `createNavRequestCoordinator` 提供 requestId + AbortSignal；各 controller 另有 `generation` 二次把關 | [nav-request.ts](../src/domain/map/nav-request.ts)、[place-routes-controller.ts:93](../web/map/place-routes-controller.ts#L93) |
| 「Drawer view dispose 後仍可能更新 DOM」 | `DrawerViewSession` 已提供 `signal` 與 `onDispose` | [drawer-view.ts:110](../web/map/drawer-view.ts#L110) |

推論：**新工具必須架在 `DrawerViewSession` 與 `NavRequestCoordinator` 之上，不得平行再造。**

### 2.2 真正的缺口（本計畫處理）

| 缺口 | 證據 |
|---|---|
| Timetable tabs 有 `role` / `aria-selected` / roving `tabIndex`，但無方向鍵、無 `aria-controls`、panel 無 `role="tabpanel"` | [timetable-view.ts:91-104](../web/map/timetable-view.ts#L91-L104) |
| Skeleton 一律立即顯示，無延遲閘與最短顯示時間 | [main.ts:288](../web/map/main.ts#L288)、[main.ts:334](../web/map/main.ts#L334) |
| 首頁重新整理只有 `disabled` + 換字，無 `aria-busy`、無成功／失敗態 | [eta/main.ts:281](../web/eta/main.ts#L281) |
| 容器級 `aria-live` 造成整塊重播 | [map-page.ts:59](../src/map-page.ts#L59)、[ui.ts:55](../src/ui.ts#L55) |
| `refreshBoard()` 無 `try/finally`，例外會永久卡死自動更新 | [eta/main.ts:278-339](../web/eta/main.ts#L278-L339) |

### 2.3 已存在的「手工版 gate」

[nearby-places-controller.ts:85-92](../web/map/nearby-places-controller.ts#L85-L92) 的 `onAutoPreview` 分支刻意跳過結果清單，註解寫明「The result list would exist for only one frame」。這正是 loading gate 要一般化的問題 —— 目前是針對單一路徑手寫的特例。

---

## 三、交付總覽

```
PR 0  live region 清理            阻擋項，必須先做
PR 1  roving-tabs.ts             最小、自足、零跨頁風險
PR 2  async-action-state.ts      含首頁 refresh 卡死修正
PR 3  loading-gate.ts
PR 4  焦點收尾（setup inert + 地圖 drawer 輸入來源）
PR 5  collapsible notice（兩態）
PR 6  settled live region + 完整路線 ETA 交接
─── 以下待基礎穩定後另案評估 ───
      share-action / tooltip group / press feedback
```

新增模組共 **四個**（初版為七個）：`roving-tabs.ts`、`async-action-state.ts`、`loading-gate.ts`、`settled-live-region.ts`。

---

## 四、PR 0：Live region 清理

### 4.1 問題

`#map-drawer` 整個是 `aria-live="polite"`，而 [drawer-view.ts:80](../web/map/drawer-view.ts#L80) 每次 render 都 `replaceChildren()` —— 等於**每次抽屜換頁都朗讀整個抽屜內容**。同時：

- [drawer-primitives.ts:9](../web/map/drawer-primitives.ts#L9) 的 `role="status"` 巢狀在其中，部分 AT 會重複朗讀
- 首頁 `.cover` 包住 `#bus-list`，每次 ETA reconcile 重播整塊看板 —— 與 design-system.md「ETA／車輛刷新不重播」相牴觸
- 第二階段的 settled announcement 前提是**由程式控制宣告時機**；容器 live region 是 DOM 一變就播，兩者無法共存

而地圖頁真正的宣告通道**早就存在且已被正確使用**：`setStatus()` 寫入 `#map-status`（`aria-live="polite"`），[main.ts:294](../web/map/main.ts#L294)、[:337](../web/map/main.ts#L337)、[:342](../web/map/main.ts#L342) 都有呼叫。`#map-drawer` 的 `aria-live` 是純冗餘。

### 4.2 變更

| 檔案 | 變更 |
|---|---|
| [src/map-page.ts:59](../src/map-page.ts#L59) | 移除 `#map-drawer` 的 `aria-live="polite"`；`#map-status` 保持不變 |
| [src/ui.ts:55](../src/ui.ts#L55) | 移除 `.cover` 的 `aria-live="polite"` |
| [src/ui.ts:66](../src/ui.ts#L66) | **`#notice` 補上 `aria-live="polite"`** |
| [src/ui.ts:68](../src/ui.ts#L68) | `.eta-footer` 內新增 `<span id="refresh-status" role="status" aria-live="polite" class="visually-hidden"></span>` |

### 4.3 必須注意的行為變更

`#notice` 目前**沒有自己的 `aria-live`**，完全依賴 `.cover`。若只移除 `.cover` 而不補上，降級提示（「部分資料有些延遲」「依時刻表推估」）會靜默消失。這是本 PR 最容易漏掉的一步。

移除 `.cover` 後，ETA 數值變動不再自動朗讀。這是**刻意的**：依 design-system.md，自動刷新應保持安靜，資訊由 `#updated`（`資料 HH:MM:SS`）與 `#refresh-status` 承載。

### 4.4 測試

- `test/e2e/eta.spec.ts`：斷言 `.cover` 無 `aria-live`；`#notice` 有 `aria-live="polite"`
- `test/e2e/map-degraded-data.spec.ts`：斷言 `#map-drawer` 無 `aria-live`，且錯誤訊息仍出現在 `#map-status`
- 新增 `test/e2e/live-region-contract.spec.ts`：全站掃描 `[aria-live]`，斷言不存在「live region 內含 live region 或 `role="status"`」的巢狀情形

---

## 五、PR 1：`roving-tabs.ts`

### 5.1 API

`web/lib/roving-tabs.ts`

```ts
export type RovingTabsOptions = {
  tablist: HTMLElement
  tabs: readonly HTMLButtonElement[]
  panel: HTMLElement
  idPrefix: string
  initialIndex: number
  onSelect: (index: number) => void
}

/** 回傳 cleanup；監聽器掛在 tablist 上，節點移除即失效，cleanup 為選用。 */
export function attachRovingTabs(options: RovingTabsOptions): () => void
```

### 5.2 行為契約

| 輸入 | 行為 |
|---|---|
| `ArrowLeft` / `ArrowRight` | 移到相鄰可用 tab，**環繞**（首←→末） |
| `Home` / `End` | 第一個／最後一個可用 tab |
| `disabled` tab | 一律跳過；若全部 disabled 則不動作 |
| 任一移動 | 立即 `focus()` 新 tab 並觸發 `onSelect`（follow focus，符合 APG 自動啟動模式） |
| 點擊 | 同上 |

不實作 RTL 反轉（介面語言為 zh-Hant，恆為 LTR）。

ARIA 關聯：

- tab：`id="${idPrefix}-tab-${i}"`、`aria-controls="${idPrefix}-panel"`
- panel：`id="${idPrefix}-panel"`、`role="tabpanel"`、`tabIndex=0`、`aria-labelledby` 指向**目前選中**的 tab id
- `tabIndex` 恆保持只有一個為 `0`

### 5.3 整合

[timetable-view.ts:91-104](../web/map/timetable-view.ts#L91-L104)：

1. `content` div 加上 `role="tabpanel"` 與 id
2. 現有 `renderService(service, activeButton)` 內的 tabIndex／`aria-selected` 迴圈（:71-77）改由 `attachRovingTabs` 接管，`renderService` 只負責換內容
3. `idPrefix` 用路線識別，避免同頁多個 tablist 撞 id

### 5.4 視覺

服務日期切換時的內容交接：`opacity` 120–180ms，水平位移上限 8px，**不動畫 drawer 高度**（`timetableDrawerSize` 已由內容量決定，見 [drawer-content-size.ts:19](../web/map/drawer-content-size.ts#L19)）。`prefers-reduced-motion` 下瞬間切換。

### 5.5 測試

- `web/map/timetable-view.test.ts`（既有）：補方向鍵、Home/End、跳過 disabled、tabIndex 單一為 0、`aria-controls` / `aria-labelledby` 正確
- `test/e2e/map-timetable.spec.ts`（既有）：鍵盤走訪一輪並斷言內容確實更換
- `test/e2e/map-timetable-size-memory.spec.ts`（既有）：確認切換 tab 不破壞 size memory

---

## 六、PR 2：`async-action-state.ts`

### 6.1 職責邊界

**只負責按鈕的可見狀態機。** 不做請求取消、不做世代判定 —— 那些由呼叫端既有的 `NavRequestCoordinator` 或 controller `generation` 負責。

### 6.2 API

`web/lib/async-action-state.ts`

```ts
export type AsyncActionPhase = 'idle' | 'pending' | 'success' | 'error'

export type AsyncActionLabels = {
  idle: string
  pending: string
  success?: string
  error?: string
}

export type AsyncActionOptions = {
  button: HTMLButtonElement
  labels: AsyncActionLabels
  /** success / error 停留時間，預設 1200ms。省略 success 與 error 標籤即為 pending-only 模式，不排任何倒數。 */
  settleMs?: number
  /** 由呼叫端提供的 status 節點寫入函式；不提供則不宣告 */
  announce?: (message: string) => void
  /**
   * aria-busy 的掛載對象。預設不設任何 aria-busy。
   * 判準見 §6.6：按鈕 pending 期間仍可互動才掛在按鈕上，
   * 按鈕被 disabled 時應指向內容正在變動的區域。
   */
  busyTarget?: HTMLElement
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void
}

/**
 * 三態結果。skipped 與 rejected 必須可區分：
 * 「因為 pending 沒跑」和「跑了但失敗」是兩件事，呼叫端的處理也不同。
 */
export type AsyncActionResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }
  | { status: 'skipped' }

export type AsyncAction = {
  /**
   * quiet: true 時不播成功回饋（不改 label、不宣告 success）。
   * 錯誤一律照常呈現 —— quiet 抑制的是成功，不是失敗。
   * 供 30 秒定時器與 visibilitychange 使用。
   */
  run<T>(task: () => Promise<T>, options?: { quiet?: boolean }): Promise<AsyncActionResult<T>>
  phase(): AsyncActionPhase
  dispose(): void
}

export function createAsyncAction(options: AsyncActionOptions): AsyncAction
```

### 6.3 行為契約

| 情境 | 行為 |
|---|---|
| `phase === 'pending'` 時再次 `run` | 回傳 `{ status: 'skipped' }`，**不執行 task** |
| task 拋例外 | 進 `error`，回傳 `{ status: 'rejected', reason }`。**`reason` 原封不動交給呼叫端** |
| success / error 停留期間再次 `run` | 取消倒數，直接進 `pending` |
| `quiet: true` | 不宣告 success、settle 直接回 idle。**pending label 照常顯示**(按鈕確實是 disabled,狀態要一致);**錯誤照常呈現** |
| 未提供 `labels.success` / `labels.error` | pending-only 模式，settle 立即回 `idle`，不排倒數 |
| 寫入 DOM 前 | 檢查 `button.isConnected`，已 detached 則跳過（見 §6.5c） |
| `dispose()` 之後 `run` | 回傳 `{ status: 'skipped' }`，不碰 DOM |
| `prefers-reduced-motion` | 狀態切換不變，只是沒有轉場動畫（本工具本就不做動畫，由 CSS 決定） |

**最重要的保證：`run` 內部以 `try/finally` 包住 task，pending 一定會結束。** 這是本模組存在的首要理由，優先於文字狀態。

### 6.4 錯誤不得被吞掉

`run` **不得** 把例外轉成 `undefined` 後靜默丟棄。[place-routes-controller.ts:157-166](../web/map/place-routes-controller.ts#L157-L166) 的既有註解已經定調：

> Keep rendering outside the load catch: a renderer bug is a real application failure and must not be silently disguised as a missing route shape.

吞例外正是該註解禁止的行為。具體後果有三：

1. **TDX 需要 error 物件本身。** [setup/main.ts:632](../web/setup/main.ts#L632) 的 `showTdxError(error instanceof Error && error.message ? error.message : '驗證失敗，稍後再試')` 沒有 `reason` 就沒有訊息可顯示。
2. **`skipped` 與 `rejected` 必須可分辨。** 若都回傳 `undefined`，呼叫端無從判斷「因為還在 pending 所以沒跑」與「跑了但炸了」。
3. **`quiet` 若連錯誤一起吞，等於把「不會卡死」換成「卡死但沒人知道」。** 30 秒定時器裡的 renderer bug 會每輪靜默失敗。因此 `quiet` 只抑制成功回饋。

### 6.5 按鈕寬度

**不由本模組處理。** 由 CSS `min-width` 依最長字串決定，寫在對應樣式檔。理由：`#refresh` 只是 `.eta-footer-actions` 內的一顆按鈕（[ui.ts:72](../src/ui.ts#L72)），不值得為此在 JS 量測。

### 6.6 `aria-busy` 的歸屬

專案既有的兩個用法剛好示範了正確分界：

| 位置 | 掛載對象 | 按鈕在 pending 期間 |
|---|---|---|
| [ui.ts:60](../src/ui.ts#L60) | `#bus-list`（資料區） | — |
| [city-network-controller.ts:62](../web/map/city-network-controller.ts#L62) | `networkButton` | **仍可互動**（再點一次即 hide） |

> **規則：按鈕在 pending 期間仍可互動 → `aria-busy` 掛在按鈕；按鈕被 `disabled` → `aria-busy` 屬於內容正在變動的區域。**

`disabled` 已經把按鈕移出 AT 的互動模型，此時再掛 `aria-busy` 沒有作用。因此 `busyTarget` **預設不設**：

- 首頁 → `busyTarget: listNode`（`#bus-list`），與 [eta/main.ts:161](../web/eta/main.ts#L161) 既有的 `removeAttribute('aria-busy')` 對稱
- TDX → 不傳（`#tdx-message` 已承載狀態）
- 地圖 retry → 不傳

### 6.7 整合點

#### (a) 首頁重新整理 —— 含卡死修正

[eta/main.ts:278-339](../web/eta/main.ts#L278-L339) 的 `refreshBoard()` 目前用 `refreshButton.disabled` 當互斥鎖，但**整個函式沒有 `try/finally`**。第 321–336 行的 `sort` / `reconcileRows` / `persistHomeBoard` / `Intl` 格式化任一處拋例外，按鈕會永久停在 `disabled`；隨後 [:371](../web/eta/main.ts#L371) 的 30 秒定時器與 [:373](../web/eta/main.ts#L373) 的 visibilitychange 每次都在 [:280](../web/eta/main.ts#L280) 早退 —— **首頁 ETA 從此不再更新，只能重新整理頁面才能恢復。**

改為：

```ts
const refreshAction = createAsyncAction({
  button: refreshButton,
  labels: { idle: '重新整理', pending: '更新中', success: '已更新', error: '更新失敗' },
  announce: (message) => { refreshStatusNode.textContent = message },
  busyTarget: listNode,
})

refreshButton.addEventListener('click', () => { void refreshAction.run(refreshBoard) })
setInterval(() => { if (!document.hidden) void refreshAction.run(refreshBoard, { quiet: true }) }, 30_000)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refreshAction.run(refreshBoard, { quiet: true })
})
```

`refreshBoard()` 同時移除自身的 `disabled` 互斥與 label 操作（:280–282、:337–338），以及 [:161](../web/eta/main.ts#L161) 與 [:366](../web/eta/main.ts#L366) 的 `removeAttribute('aria-busy')` —— 互斥與 busy 標記都改由 `run` 保證，避免兩邊各自管理同一個屬性。

`quiet` 旗標讓「自動更新保持安靜」成為**型別上的區別**，而不是靠註解約束。注意 `quiet` 只抑制成功回饋：若 `reconcileRows` 之類的 renderer bug 在自動更新中發生，`error` 標籤與 `#refresh-status` 仍會出現，使用者看得到、下一輪也仍會重試。

#### (b) TDX 儲存並測試

[setup/main.ts:608-635](../web/setup/main.ts#L608-L635)。

**建議不改按鈕文字。** `#tdx-message`（`aria-live="polite"`，[ui.ts:119](../src/ui.ts#L119)）已經承載全部四種狀態文字，且 `aria-describedby` 從兩個輸入框指向它。再讓按鈕變字是重複的狀態表面，且按鈕在聚焦狀態下改名會被部分 AT 重新朗讀。

因此此處只取用 `try/finally` 保證 —— 現況若 `renderTdx` 拋例外，`tdxSave` 同樣永久 disabled。

`labels` 傳 `{ idle: '儲存並測試', pending: '儲存並測試' }`；`announce` 與 `busyTarget` 都不傳。

錯誤處理保留在呼叫端，因此 **`run` 必須把 `reason` 交回來**：

```ts
const result = await saveAction.run(() => verifyTdxCredentials({ clientId, clientSecret }))
if (result.status === 'rejected') {
  showTdxError(result.reason instanceof Error && result.reason.message
    ? result.reason.message
    : '驗證失敗，稍後再試', [tdxId, tdxSecret])
  return
}
if (result.status === 'skipped') return
// fulfilled：寫入憑證並 renderTdx(...)
```

#### (c) 地圖 Retry —— pending-only，不需要 dispose 接線

[drawer-primitives.ts:52](../web/map/drawer-primitives.ts#L52) 的 `retryButton` 有三處 call site（[main.ts:279](../web/map/main.ts#L279)、[:639](../web/map/main.ts#L639)、[:914](../web/map/main.ts#L914)）。

**這裡不能、也不需要接 `DrawerViewSession.onDispose`。**

不能的理由是順序：session 是 `renderDrawer(view)` 的回傳值，但按鈕必須在 `view.content` 陣列組好之前就建立。而且三個 call site 全都丟棄回傳的 session（[nearby-places-view.ts:98](../web/map/nearby-places-view.ts#L98) 回傳 `message`、[place-routes-view.ts:44](../web/map/place-routes-view.ts#L44) 的 `renderSettled` 直接丟掉）。

不需要的理由更根本：**retry 按鈕永遠活不到 success 或 error。** 按下去會觸發 controller 的 `onStart` → `renderLoading` → drawer 重繪，按鈕當場被 [drawer-view.ts:80](../web/map/drawer-view.ts#L80) 的 `replaceChildren()` 拔掉；失敗時 `renderError` 也是建**新**按鈕。需要 dispose 的東西是 settle 倒數 —— 沒有 settle 階段，就沒有東西需要 dispose。

因此：

- `labels` 只傳 `{ idle: '再試一次', pending: '重試中…' }`，觸發 pending-only 模式
- 寫入 DOM 前檢查 `button.isConnected` 作為保險：drawer 一 `replaceChildren()`，舊按鈕即 detached，殘留回呼自然 no-op。零接線
- `announce`、`busyTarget` 都不傳；狀態由 `setStatus` 寫入 `#map-status`

pending 態在 PR 3 之後才真正可見：loading gate 的 0–120ms 延遲窗內 drawer 還沒重繪，按鈕需要在這段時間表示「已收到點擊」。

[main.ts:639](../web/map/main.ts#L639) 的 bootstrap retry 已經手寫了 `disabled` + `重試中…`，正是同一個 pending-only 形狀，直接改用共用實作即可。

### 6.8 測試

新增 `web/lib/async-action-state.test.ts`，注入 `schedule` / `cancelSchedule` 假時鐘：

生命週期
- pending 期間重複 `run` → 回傳 `skipped`，第二個 task 未被呼叫
- settleMs 後回 `idle`
- 停留期間再 `run` → 立即 pending，前一個倒數被取消
- `dispose()` 後 `run` 回傳 `skipped`、不碰 DOM；pending 中的倒數不觸發

錯誤傳遞
- task reject → 回傳 `{ status: 'rejected', reason }`，且 `reason` **與拋出的物件為同一參考**
- **task 拋同步例外 → phase 仍回到 `error` 且 reason 保留**（迴歸首頁卡死）
- `skipped` 與 `rejected` 可分辨

quiet
- `quiet: true` 成功 → 不改 label、不呼叫 announce
- **`quiet: true` 失敗 → 仍套用 `labels.error` 並呼叫 announce**

aria-busy
- 未傳 `busyTarget` → 按鈕與任何節點都不出現 `aria-busy`
- 傳 `busyTarget` → pending 期間該節點為 `aria-busy="true"`，settle 後移除

pending-only
- 未提供 `labels.success` / `labels.error` → settle 立即回 `idle`，`schedule` 從未被呼叫
- `button.isConnected === false` 時所有 DOM 寫入被跳過

E2E：`test/e2e/eta-lifecycle.spec.ts` 新增案例 —— 注入會讓 reconcile 拋例外的資料，斷言（a）出現「更新失敗」而非靜默，（b）下一輪 30 秒刷新仍能執行。

---

## 七、PR 3：`loading-gate.ts`

### 7.1 API

`web/lib/loading-gate.ts`

```ts
export type LoadingGateOptions = {
  /** 低於此時間完成則完全不顯示 skeleton，預設 120ms */
  delayMs?: number
  /** skeleton 一旦顯示的最短存續時間，預設 300ms */
  minVisibleMs?: number
  showLoading: () => void
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void
  now?: () => number
}

export type LoadingGate = {
  start(): void
  /** render 會在滿足最短顯示時間後執行 */
  settle(render: () => void): void
  /** 取消所有排程；已排入的 render 不會執行 */
  abort(): void
}

export function createLoadingGate(options: LoadingGateOptions): LoadingGate
```

### 7.2 時序

```
start()
  └─ 0–120ms   維持前一個穩定畫面，不顯示 skeleton
  └─ >120ms    showLoading()

settle(render)
  ├─ skeleton 未顯示        → 取消計時器，立即 render()
  ├─ 已顯示 <300ms          → 延後 render() 至補足 300ms
  └─ 已顯示 ≥300ms          → 立即 render()
```

最壞情況總延遲 = 120 + 300 = **420ms**，仍在可接受範圍。初版提議的 380ms 會使此值達 500ms，已超過感知上限，故下修。

### 7.3 生命週期歸屬（關鍵）

Gate 的計時器 **必須由 controller 的 `generation` 擁有，不能掛在 `DrawerViewSession` 上**。理由：在 0–120ms 的延遲窗內尚未 render，因此還沒有新 session 存在。

具體要求：

- `nearbyPlaces.invalidate()`（[nearby-places-controller.ts:104](../web/map/nearby-places-controller.ts#L104)）與 `placeRoutes.cancel()`（[place-routes-controller.ts:209](../web/map/place-routes-controller.ts#L209)）必須同時呼叫 `gate.abort()`
- 每次 `start()` 隱含 abort 前一輪
- 已排入的 min-visible 尾端 render 在 abort 後**不得執行** —— 這是 §5.3「舊計時器不得在新畫面觸發」的具體落點

### 7.4 整合點

| 位置 | start | settle |
|---|---|---|
| 附近站牌 | [main.ts:288](../web/map/main.ts#L288) `onStart`（僅 `!previewSource` 分支） | `onPlaces` / `onError` |
| 站牌所有路線 | [main.ts:334](../web/map/main.ts#L334) `onStart` | `onRoutes` / `onError` |

`onStart` 中的 `setStatus(...)`（`正在找這附近的站牌…`）**不進 gate，立即執行** —— §12.4 的空白風險由 status 文字承接。同理 `nearbyPlacesMap.renderLoadingOrigin(origin)` 也立即執行，地圖上的 origin marker 是最即時的回饋。

第一階段**只做這兩處**。路線完整資料、時刻表、城市路線目錄留待實測後再評估。

### 7.5 place-routes 的 size：維持現狀，不動

初版計畫要求 `renderLoading` 補上顯式 `size: 'standard'`。**這是錯的，實作時已撤回。**

[place-routes-view.test.ts:188](../web/map/place-routes-view.test.ts#L188) 明確斷言 `renderLoading` 的 `size` 必須是 `undefined`：

> renders the three-row loading skeleton without overriding a remembered workspace size

`renderError`（[:251](../web/map/place-routes-view.test.ts#L251)）同樣如此。這是刻意設計 —— 留空才能讓 `drawerSizeForTransition` 的 size memory 生效：重訪一個 12 條路線的站牌時，loading 會沿用上次的 `tall`，而不是先跳 `standard` 再跳 `tall`。寫死 `'standard'` 反而會製造它想避免的跳動。

僅在**首次造訪**且結果為 0 條或 8 條以上時，才會有 `standard → compact/tall` 的一次變化。Gate 反而縮小了這個窗口：多數空結果會在 120ms 內直接呈現，根本不經過 skeleton。

### 7.6 Skeleton 視覺：採靜態（方案 A）

移除 [loading-skeleton.css:37](../web/map/loading-skeleton.css#L37) 的 `animation: drawer-loading-shimmer 1.35s ease-in-out infinite`、`:149` 與 `:158` 的 `animation-delay`，以及 `@keyframes`（:162）。

決定理由不是「安靜」，而是：[loading-skeleton.css:166-170](../web/map/loading-skeleton.css#L166-L170) 在 `prefers-reduced-motion` 下已經是 `display: none`，**現在等於維護兩套視覺**。改靜態後兩邊一致，視覺回歸只需一組截圖，也讓 `test/e2e/map-visual.spec.ts` 不再受動畫相位影響而不穩定。

保留 `::after` 節點與 `--skeleton-highlight` 作為靜態底色層，避免大改結構。

### 7.7 測試

新增 `web/lib/loading-gate.test.ts`（假時鐘）：

- 100ms 完成 → `showLoading` 從未被呼叫，render 立即執行
- 200ms 完成 → showLoading 於 120ms 觸發，render 於 420ms 執行
- 500ms 完成 → showLoading 於 120ms，render 立即
- `abort()` 於延遲窗內 → showLoading 不觸發
- `abort()` 於 min-visible 尾端 → render 不觸發
- 連續 `start()` → 前一輪計時器全數清除

E2E：

- `test/e2e/map-async-navigation.spec.ts`：快速連點兩個站牌，斷言第一個的 skeleton 不出現在第二個畫面
- `test/e2e/map-route-loading-height.spec.ts`（既有）：擴充 place-routes loading → settled 的高度斷言
- `test/e2e/map-visual.spec.ts`：更新 skeleton 截圖基準

---

## 八、PR 4：焦點收尾

### 8.1 設定 Picker

現況已完成開啟聚焦、關閉還原、Escape 關閉。**僅需補兩項：**

1. `showPicker()`（[setup/main.ts:208](../web/setup/main.ts#L208)）時對主要內容區設 `inert`，`hidePicker()`（[:229](../web/setup/main.ts#L229)）時移除
2. 步驟切換時（`routePicker` / `directionStep` / `suggestionStep` 三者的 `hidden` 互斥）確認焦點不會停留在剛被 `hidden` 的節點上 —— 若當前 `document.activeElement` 位於被隱藏的步驟內，將焦點移到新步驟的第一個控制

`inert` 生效後 Tab 不會落在背景的任何控制上，**不需要手寫 focus trap**。

注意 `inert` 不等於 focus trap：Tab 走到文件尾端仍會經過 `body` 再繞回來。要斷言的是「焦點永遠不落在背景控制上」，不是「焦點永遠在 Picker 內」。

步驟焦點只處理**同步**的三個切換（`backToRoutes`、`backToStops`、`chooseRoute` → 方向步驟）。建議步驟（`loadSuggestions`）的控制要等 fetch 回來才存在，中途搶焦點會干擾使用者；該路徑接受焦點暫時落到 `body`，靠 `inert` 保證下一次 Tab 仍回到 Picker 內。

### 8.2 地圖 Drawer

不設 focus trap（§5.5）。只在**鍵盤導覽**時把焦點移到新 view 的標題或第一個控制。

輸入來源判斷**不可使用 `event instanceof KeyboardEvent`** —— 由 Enter/Space 觸發的 click 仍是 `PointerEvent`。改用：

```ts
function isKeyboardActivation(event: MouseEvent): boolean {
  return event.detail === 0
}
```

實作為 `createKeyboardActivationTracker`（[drawer-view.ts](../web/map/drawer-view.ts)）：document 上的 capture 監聽，`click` 記錄 `detail === 0`，`pointerdown` 清旗標。地圖點擊（Leaflet 事件）與觸控一律視為非鍵盤。

**旗標是一次性的。** 每次 `render()` 都消耗掉，否則一次鍵盤操作留下的 `true` 會被後面某個非鍵盤觸發的 render（popstate、URL hydration、ETA 刷新）撿去用而錯誤地搶走焦點。

焦點**同步**在 `render()` 內轉移，不排計時器，因此沒有需要註冊到 `DrawerViewSession.onDispose` 的東西。

轉移目標是**第一個可聚焦控制**（通常是返回鍵），不是標題：標題在 DOM 上排在返回鍵之後，聚焦標題會讓返回鍵只剩 Shift+Tab 才到得了。Drawer 不是 modal，往前的 Tab 序必須保持完整。

#### 焦點修復（實作時才發現的第二個條件）

只做「鍵盤才轉移」會漏掉一種情況：loading 與 settled **共用 view key**，settled 的 `replaceChildren()` 會把剛剛被聚焦的節點拔掉，而同 key 的第二次 render 不會再轉移焦點（`animateContent` 為 false，旗標也已消耗）。結果焦點掉回 `body`。

因此第二個條件：**render 前焦點在 drawer 內、render 後不在了 → 接回第一個可聚焦控制。**

這是修復，不是搶奪 —— 焦點本來就在 drawer 裡，是我們自己的 `replaceChildren()` 弄丟的。焦點原本在 drawer 之外時一律不碰。

#### 測試的正確命題

「滑鼠操作不搶焦點」不能用「點 drawer 內的按鈕」來驗證：**瀏覽器本來就會把焦點移到被點的按鈕上**，焦點在 drawer 外撐不過任何一次 drawer 內點擊。

有意義的命題只在導覽**不是由 drawer 內控制發起**時成立 —— 地圖點擊正是那條路徑，也正是手機上搶焦點會叫出虛擬鍵盤的那條。斷言為：地圖點擊開啟新 view 後，焦點不得被拉進 drawer。（焦點離開原本的外部元素是正常的，點地圖會聚焦地圖容器。）

### 8.3 測試

- `test/e2e/map-transfer-keyboard.spec.ts`（既有）擴充：鍵盤開啟 place view 後焦點落在標題；滑鼠開啟時焦點不動
- 新增 setup picker 的 `inert` 與 Tab 邊界 E2E

---

## 九、PR 5：Collapsible Notice（兩態）

### 9.1 範圍縮減

初版設計 `open` / `folded` / `dismissed` 三態加六行權限矩陣。實際 call site 只有 [drawer-primitives.ts:1](../web/map/drawer-primitives.ts#L1) 的 `degradedNotice` 一個。

**第一版只做 `open` / `folded` 兩態，不做 `dismissed`。** 等出現第二個真正需要永久關閉的通知再擴充。

### 9.2 政策：由 call site 的結構決定，不列舉通知種類

實作時發現不需要一張「哪一種通知可折疊」的表 —— 五個 call site 自己就分成乾淨的兩類：

| call site | 通知旁邊還有可用內容嗎 | 可折疊 |
|---|---|---|
| [place-routes-view.ts](../web/map/place-routes-view.ts) `renderRoutes` 的 warning | 有（整份路線清單） | 是 |
| [trip-results-view.ts](../web/map/trip-results-view.ts) `warningContent` | 有（整份行程結果） | 是 |
| [main.ts](../web/map/main.ts) 車輛降級 ×2 | 有（路線與站牌仍可用） | 是 |
| [place-routes-view.ts](../web/map/place-routes-view.ts) `renderError` | 沒有，通知就是內容 | 否 |
| [trip-results-view.ts](../web/map/trip-results-view.ts) 「查詢失敗了」 | 沒有，通知就是內容 | 否 |

> **規則：通知旁邊還有可用內容時才可折疊。通知本身就是整個畫面的內容時不行 —— 那時候折疊等於把唯一的出口藏起來。**

這條規則是結構性的、在每個 call site 當場可判斷，比列舉通知種類更耐得住新增功能。

### 9.3 折疊不得隱藏問題敘述

實作為 `<details>`：`<summary>` 承載訊息，折疊只收起處理動作。訊息永遠看得見。

`role="status"` 掛在**訊息節點**而不是整張通知。掛在容器上會有兩個問題：展開折疊讓按鈕文字進出 live region 而被重新朗讀；而且朗讀內容會變成把按鈕唸一遍。要宣告的是問題本身。

### 9.4 折疊狀態

存在記憶體，**不寫入 localStorage** —— 問題仍成立時重新載入應重新展開。

以訊息內容為鍵。理由是車輛定位每 20 秒重畫一次通知：不記住的話，使用者折疊完二十秒後又會彈開。

---

## 十、PR 6：Settled live region 與 ETA 交接

依賴 PR 0。在容器級 `aria-live` 移除前，本 PR 無法生效。

### 10.1 `settled-live-region.ts`

```ts
export type SettledLiveRegion = {
  /** 連續呼叫會取消前一個排程，最後狀態穩定 600ms 後才朗讀 */
  announce(message: string): void
  /** 立即朗讀，用於錯誤 */
  announceNow(message: string): void
  dispose(): void
}
```

穩定窗採 **600ms**（初版建議 500–700ms 區間的中值）。

### 10.2 ETA 交接共用

[eta-row-view.ts:66](../web/eta/eta-row-view.ts#L66) 的中性交接推廣至完整路線頁與站牌所有路線。維持中性 `opacity` + 小幅位移 + 等寬占位。

**不做紅綠漲跌**：ETA 由 8 分變 5 分只是時間前進，沒有好壞語意；金融隱喻會誤導。此點 design-system.md 已載明。

---

## 十一、決策清單

| # | 問題 | 決定 | 依據 |
|---|---|---|---|
| 1 | Skeleton 靜態或單次 shimmer | **靜態** | reduced-motion 下已 `display:none`，現況等於兩套視覺（§7.6） |
| 2 | Gate 延遲 120ms | **採用，但做成參數** | nearby 走邊緣快取常 <50ms，需實測校準 |
| 3 | 最短顯示 380ms | **下修為 300ms** | 總延遲 420ms vs 500ms（§7.2） |
| 4 | 「已更新」顯示時長 | **1200ms，且只在 click 觸發** | 由 `quiet` 旗標在型別上強制（§6.7a）；`quiet` 不抑制錯誤 |
| 5 | TDX 忙線可折疊 | 是 | — |
| 6 | 「部分資料稍早」可永久關閉 | **否** | design-system.md：stale 必須保留可見文字 |
| 7 | 第一階段不含分享 | 是 | — |
| 8 | Drawer 只在鍵盤時移焦點 | 是，用 `event.detail === 0` 判定 | Enter 觸發的 click 仍是 PointerEvent（§8.2） |
| 9 | 分享按鈕位置 | Drawer 標題旁 | 待 PR 6 之後另議 |
| 10 | 移除無限 shimmer | 是 | 同 #1 |

---

## 十二、驗收標準

### 12.1 Live region（PR 0）

- 全站不存在 live region 巢狀 live region 或 `role="status"`
- 首頁降級提示仍會朗讀（`#notice` 有自己的 `aria-live`）
- 地圖錯誤仍會朗讀（經 `#map-status`）
- ETA 自動刷新不再朗讀整塊看板

### 12.2 Tabs（PR 1）

- 方向鍵可切換且環繞、Home/End 可用、跳過 disabled
- `tabIndex` 永遠只有一個為 `0`
- `aria-controls` / `aria-labelledby` 雙向正確
- reduced-motion 下瞬間切換
- 切換後 drawer size memory 不受影響

### 12.3 Async button（PR 2）

- pending 期間不能重複提交，且回傳可辨識的 `skipped`
- **task 拋出同步或非同步例外，按鈕都必須回到可用狀態**
- **例外的 `reason` 原樣交還呼叫端，不得被吞成 `undefined`**
- 自動更新（`quiet`）成功時不改 label、不宣告；**失敗時仍呈現錯誤**
- `aria-busy` 只出現在 `busyTarget` 指定的節點；未指定則全站不新增 `aria-busy`
- `dispose()` 後不更新 DOM
- retry 按鈕為 pending-only：不排 settle 倒數，`isConnected` 為 false 時不寫 DOM
- 成功／失敗不改變按鈕寬度（CSS `min-width`）

### 12.4 Loading（PR 3）

- 120ms 內完成不顯示 skeleton
- skeleton 顯示後不短於 300ms
- 快速切換 view 時舊 skeleton 與舊 render 都不落在新畫面
- place-routes loading → settled 沿用 size memory，不被 loading 覆寫（§7.5）
- reduced-motion 與一般模式的 skeleton 視覺一致

### 12.5 迴歸（全部 PR）

不得破壞：Back／Forward、深連結、URL 分享、地圖鏡頭狀態、drawer scrollTop、車輛 Popup、自動 ETA 更新、TDX 憑證錯誤處理、常用站牌資料、手機觸控操作。

對應既有測試：`map-navigation-equivalence.spec.ts`、`map-async-navigation.spec.ts`、`map-desktop-drawer-stability.spec.ts`、`eta-lifecycle.spec.ts`。

---

## 十三、風險

| 風險 | 控制 |
|---|---|
| 移除容器 `aria-live` 導致部分提示靜默消失 | `#notice` 補 `aria-live`；新增 live-region 契約 E2E |
| Gate 計時器在 view 已替換後觸發 render | 計時器歸屬 controller `generation`；`invalidate()` / `cancel()` 必須連帶 `abort()`；單元測試明確覆蓋 |
| 三套世代機制互相打架 | `async-action-state` 明確不做 staleness 判定（§6.1） |
| 狀態工具吞掉 renderer bug，把「卡死」換成「靜默失敗」 | `run` 回傳 discriminated result，`reason` 原樣交還；`quiet` 只抑制成功（§6.4）；E2E 明確斷言錯誤可見 |
| `aria-busy` 出現兩個競爭來源 | 由 `busyTarget` 單一擁有；首頁移除 [eta/main.ts:161](../web/eta/main.ts#L161) / [:366](../web/eta/main.ts#L366) 的手動 `removeAttribute`（§6.6） |
| retry 按鈕的計時器在節點被 `replaceChildren()` 後寫 DOM | 改為 pending-only，根本不排倒數；另加 `isConnected` 保險（§6.7c） |
| 120ms 空白期使畫面看似無反應 | `setStatus` 與 origin marker 不進 gate，立即執行（§7.4） |
| 共用工具過度抽象 | 已砍 `focus-boundary.ts` 與 `dismissed` 態；剩餘四個模組各有 ≥2 個 call site |
| Skeleton 截圖基準變動 | PR 3 內同批更新 `map-visual.spec.ts` |

---

## 十四、明確不做

- React 化、`motion/react`
- 全面動畫化、每次 ETA 更新重播整列
- ETA 紅綠漲跌、數字彈跳
- 地圖點擊 Ripple
- Long press / hold to confirm（刪除已有 5 秒復原，清除已有確認對話框）
- Expanding search（搜尋是主要入口，不得隱藏）
- Command palette
- 收藏 like burst
- 地圖 Drawer 完整 focus trap
