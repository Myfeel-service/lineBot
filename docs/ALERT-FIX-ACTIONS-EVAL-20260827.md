# 異常提醒「一鍵幫我修／對話式代辦」通盤評估（2026-08-27）

> 性質：**決策紀錄**（寫完凍結，不回頭改狀態）。進度與拍板結果一律看 `docs/STATUS.md`（`D-34`）。
> 起因：老闆提議——小幫手與頁面頂端的異常提醒可以有「一鍵解決」：點了切到有異常的地方、
> 跳出 popup 講清楚系統打算怎麼做，按確定就執行；有些則改成對話式引導，收完資料由助理直接完成。
> 本報告回答三件事：①哪些異常適合哪種修法（32 顆逐一過）②該怎麼做、先做哪些
> ③這些異常現在有沒有被規則整理起來、好不好維護。

---

## 0. 一句話結論

**可做、而且不是新案子**——「popup 確認後代為執行」就是 `C-31` Phase 2 已拍板要做的
pending-op 確認流；這次評估等於把 Phase 2 的**首批操作對象定為「異常修復動作」**。
32 顆異常裡：**9 顆可一鍵修**（其中 4 顆的後端動作端點今天就存在，幾乎零新風險）、
**8 顆適合對話式**（5 條劇本已上線）、其餘 15 顆維持「帶路／系統端／付款頁」是對的，不要硬加按鈕。

---

## 1. 現況盤點：異常系統今天有什麼

### 1.1 結構（維護性審計的答案：**有規則、單一來源做得扎實**）

| 層 | 檔案 | 管什麼 |
|---|---|---|
| 定義 | `shared/types/alerts.ts` | 32 顆 id、白話標題（`ALERT_LABELS`）、嚴重度（`ALERT_SEVERITY`）、系統端清單（`SYSTEM_OWNED_ALERTS`）——前端面板、提醒帶、小幫手問答、LINE 推播**全部吃同一份** |
| 訊號 | `server/utils/workspace-alerts.ts` | 每顆一個 probe，只回「有沒有、幾筆、一句話」；單項失敗＝unknown 不誤報 |
| 呈現 | `app/composables/useWorkspaceAlerts.ts` | 註冊表：後果文案、cta、權限、落點 route／scopeRoutes、頁內錨點 anchor、劇本 guideId |

加一顆異常的動線有明文：shared 加 id → 後端加 probe → 註冊表加一筆。三個露出面
（右下角小幫手、頁面提醒帶 `AdminPageAlertStrip`、側欄的點）都吃同一份展開（`alertsForPath`／`navAlerts`），
不會各講各話。**這次加「修復手段」也應該長在同一條動線上，不要另開登記處。**

### 1.2 「修」的手段今天有三級

1. **帶我看**（聚光燈）：17 顆掛了 `anchor`，提醒帶在本頁直接高亮能處理它的區塊（`C-83`）。
2. **用聊天帶我修**（對話式）：5 條劇本（`app/utils/agent-guides.ts`）蓋 7 顆異常——
   解釋後果 → 給正確答案 → 使用者動手 → **真的重查一次驗證**。零 LLM、吃 `useAgentScriptRunner`。
   其中 `handoff-notify` 已經是「對話收資料 → 助理代寫入 → 讀回來驗證」的完整樣板。
3. **導航深連結**：`?verify=`／`?health=`／`?tab=`／`?focus=`，到頁自動捲到、篩好、聚光。

### 1.3 缺的那一塊

小幫手 agent（`server/utils/ai-admin-agent.ts`）**全唯讀**，`mutates=true` 的工具被閘門刻意擋下——
等的就是 `C-31` Phase 2 的 pending-op 確認流（08-14 老闆已拍板方向與紅線）。
「一鍵解決的確認 popup」＝那個確認流的**非聊天版入口**，兩者該共用同一套後端。

---

## 2. 判定規則（六條）——哪種問題用哪種修法

> 建議把這六條抄進 `useWorkspaceAlerts.ts` 的 `AlertDefinition` 檔頭，
> 以後新增異常時照規則選手段，不用每次重新發明。

| # | 條件 | 手段 |
|---|---|---|
| 1 | 修法是**確定性動作**、系統知道要動哪一筆、做錯可回復或可重做 | **一鍵修**：popup 講「會動什麼、幾筆、做完會怎樣」（內容來自後端 preview，不由前端寫死）→ 確定 → 執行 → **拿同一顆 probe（skipCache）再查一次**，綠了才說修好 |
| 2 | 修法需要使用者**提供資料或做選擇**（選人、選模組、填 ID） | **對話式**：劇本收資料（選項一律白名單，模型不生 ID）→ 最後的寫入走跟一鍵修同一個操作模組 |
| 3 | 修法要動的東西在 **LINE 那邊、我們沒有寫入 API** | **對話式教學**：給正確答案＋截圖步驟＋驗證迴圈（現有 5 條劇本的形狀） |
| 4 | 修法需要**人工判斷內容**（改知識、回覆客人） | **帶路＋聚光燈**（現狀）；中期可接 AI 草稿流程（建議收件匣已有這條路） |
| 5 | 碰到 🔴 紅線：**錢／群發／對客人說話／刪除／憑證／成員** | 永遠導航到正式頁面，最後一顆按鈕留人（08-14 拍板＝永久原則，工程不自行放寬） |
| 6 | `SYSTEM_OWNED`（系統端） | 不給修復按鈕（現狀正確）；例外＝「重試」類安全冪等動作可個案開 |

---

## 3. 32 顆逐一分類

手段代號：**A**＝一鍵修｜**B**＝對話式｜**C**＝帶路＋聚光燈（維持現狀）｜**D**＝系統端不給按鈕｜**E**＝付款頁（紅線）。
「✅端點已有」＝後端動作端點今天就存在，只差確認流。

### A. 建議一鍵修（9 顆）

| 異常 | 級 | 一鍵動作 | 依據／注意 |
|---|---|---|---|
| `lineWebhookUrlMismatch` | 紅 | 把 LINE 上的收訊網址換成正式網址 | LINE 有「Set webhook endpoint URL」寫入 API（PUT，官方文件已查，見 §6）。popup 必列「現在填的 X → 換成 Y」；⚠️若舊網址是另一套還在服務的系統，換了等於把訊息搬過來——popup 要明講 |
| `lineWebhookBroken`（僅「沒填網址」病因） | 紅 | 直接把正式網址填上去 | 同上支 API。`classifyLineWebhook` 已分四種病因：**nourl→一鍵**；token 失效／開關沒開→仍走劇本（LINE 後台才改得了） |
| `knowledgeSyncFailed` | 紅 | 對失敗的來源再同步一次 | ✅端點已有（`sources/[id]` 的 sync/resync）。再失敗→接現有劇本講原因（試算表沒分享等外因） |
| `knowledgeIndexFailed` | 紅 | 重試學習（re-embed） | ✅端點已有（`reindex`）。安全冪等 |
| `knowledgeIndexStuck` | 黃(系統端) | 再排一次學習 | 同上端點；是 §2 規則 6 的「重試類例外」。修不好照舊講「聯絡我們」 |
| `knowledgeOutdated` | 黃 | 把變了的來源排重新同步 | ✅端點已有（resync-jobs／preview／apply）。popup 要講「會自動用新內容重學；想逐份比對，頁面上有『前往比對』」——不拿掉人工比對那條路 |
| `anyTextBlocking` | 紅 | 停用那條「輸入任何內容」的設定 | 後端已知道是哪條（detail 帶名稱）。停用可回復；popup 列名稱＋提醒「想保留這條就去改觸發方式」。改觸發要人想關鍵字→不一鍵 |
| `scriptDeadEnd` | 紅 | 幫卡死的那一題補「我沒有」跳過退路（跳過→轉真人） | AI 生成端已有同款**確定性補**邏輯（findStuckCollects），搬用即可。跳過按鈕字樣是客人看得到的字→popup 必須把會加的字樣原文展示，讓人最後看一眼（紅線精神） |
| `broadcastFailed` | 黃 | 重設為草稿（清舊帳，**不代發**） | ✅端點已有（`broadcast/[id]/retry`），且它刻意不發送——發送留在推播頁由人按＝群發紅線的正確形狀 |

### B. 建議對話式（8 顆；5 顆已有劇本）

| 異常 | 級 | 現狀 | 說明 |
|---|---|---|---|
| `lineWebhookBroken`（token 失效／開關沒開） | 紅 | ✅劇本 `line-webhook` | 重發 Token、開 Use webhook 只能進 LINE 後台；劇本教＋回來驗證 |
| `liffMissing` | 紅 | ✅劇本 `liff-setup` | 已是「收 LIFF ID → 代存 → 跟 LINE 驗證」完整樣板 |
| `liffEndpointBroken` | 紅 | ✅劇本 `liff-endpoint` | LIFF 寫入 API 需要 LINE Login channel 的 token，系統目前沒存→待查證（§6）；查證前維持教學 |
| `liffEndpointUrlMismatch` | 紅 | ✅劇本 `liff-endpoint` | 同上 |
| `handoffNotifyMissing` | 黃 | ✅劇本 `handoff-notify` | 「要通知誰」沒有合理預設值，必須問人 |
| `brokenModuleButton`（模組被刪） | 紅 | ❌缺 | 建議新劇本：列出壞掉的按鈕→白名單選單挑「改指向哪個模組」（或拿掉按鈕）→代改→重查。模組被**停用**的病因可另給一鍵「重新啟用」 |
| `lineChannelConflict` | 紅 | ❌缺 | 要人決定「官方帳號留哪一邊」；清另一邊的連接＝動憑證（紅線），動作留人、劇本只帶決策與指路 |
| `scriptUnreachable` | 黃 | ❌缺（P2） | 可讓 AI 建議更明確的觸發詞、人挑一組後代存；近期維持帶路即可 |

### C. 維持帶路＋聚光燈（6 顆）——修法本質是人工判斷，加按鈕是假自動化

`knowledgeWrongAnswers`（要人改內容；中期可接建議草稿流）、`knowledgeDetectStalled`（要人換來源網址）、
`humanBacklog`／`firstReplyBacklog`（要人去回客人——AI 代回是另一個功能、碰「對客人說話」紅線）、
`knowledgeSuggestions`／`tagDiscoverySuggestions`（採用前本來就要人看過內容，頁面上就是採用鈕）。

### D. 系統端維持不給按鈕（5 顆）

`llmError`（自己恢復）、`maintenanceStalled`、`scannerStalled`、`claimPushUnmarked`（cron 補蓋；一鍵重蓋可當 P2 個案）、
`broadcastOverdue`（「立刻補送」踩群發紅線＋可能跟看門狗打架，**不建議做**，要做需老闆單獨拍板）。
`invoiceFailed` 對客戶口徑是「開立中」（08-16 拍板），照舊。

### E. 付款頁（4 顆）——錢的紅線

`quotaExceeded`、`quotaRunningOut`、`paymentPastDue`、`renewalNotBound`：升級／扣款／綁卡永遠在正式付款頁完成。

---

## 4. 建議的做法

### 4.1 使用者看到的流程（跟老闆描述的一致）

1. 提醒帶／小幫手卡片上，可一鍵修的異常多一顆主按鈕（字樣建議「**幫我修**」，白話、跟「帶我看」同族）。
2. 按了→照現有導航機制帶到那一頁，網址帶 `?fix=<alertId>`（沿用 `?verify=`／`?health=` 的深連結家族）。
3. 到頁跳出確認 popup：**內容來自後端 preview**——會動哪幾筆（名稱列出來）、做什麼、做完會怎樣、
   有風險的話風險是什麼。⛔不由前端寫死文案，否則跟實際影響遲早漂移。
4. 按「確定執行」→ 執行 → 當場**用同一顆 probe（skipCache=true）重查**：
   綠了就說修好了（提醒帶那列當場消失）；沒綠講實話＋下一步。
5. 對話式的照舊走「用聊天帶我修」；劇本最後的寫入步驟改走同一個操作模組（現有 `handoff-notify` 先不動，之後收編）。

### 4.2 架構：掛進現有註冊表，不另開登記處

- `AlertDefinition` 加一個欄位 `fixOpId?: string`（跟 `guideId`、`anchor` 並排）。
- 後端新增**操作模組註冊表**（`C-31` Phase 2 拍板過的形狀）：每個 op ＝
  `preview()`（回影響清單與白話說明）＋ `execute()`（冪等、寫 `auditLogs`）＋ `verify()`（一律＝重跑對應 probe）。
- 小幫手聊天側的 pending-op 確認流跟這裡**共用同一張 op 表**——聊天裡說「幫我修推播」跟提醒帶上按「幫我修」，
  走的是同一段 preview→confirm→execute→verify，只是入口不同。
- 沿用既有鐵律：模型不生 ID、寫入先驗證後執行不重生、`mutates` 閘門不拆（op 表就是閘門的合法出口）、每筆寫 `auditLogs`。

### 4.3 順序建議

| 批次 | 內容 | 為什麼先做這批 |
|---|---|---|
| **P0** | 確認流地基（op 表＋preview popup＋verify 迴圈）＋首批 4 顆「✅端點已有」：`broadcastFailed` 重設草稿、`knowledgeIndexFailed`／`Stuck` 重試學習、`knowledgeSyncFailed` 再同步 | 動作端點現成、全部冪等安全，風險最低；先把確認流的骨架跑順 |
| **P1** | `knowledgeOutdated` 重新同步、`anyTextBlocking` 停用、`scriptDeadEnd` 補退路、**webhook 一鍵換網址**（要先過 §6 查證＋沙盒實測） | 價值最高的一批；webhook 那顆是全站最致命異常的正解 |
| **P2** | 新劇本：`brokenModuleButton` 選新指向、`lineChannelConflict` 決策引導、`scriptUnreachable` 觸發詞建議；`claimPushUnmarked` 一鍵重蓋 | 要新互動或新查證，不擋 P0/P1 |

---

## 5. 維護性排查結論（老闆問的第三件事）

**結論：有規則、三層單一來源扎實，這次順檢只找到「缺口」不是「亂」。** 缺口清單：

1. `lineChannelConflict` 是紅級、修法最複雜（要做決定＋動兩邊），卻既無劇本也無錨點——只有一段文字。→ P2 補劇本。
2. `anyTextBlocking` 紅級無劇本無一鍵，只有聚光燈到清單。→ P1 一鍵停用。
3. 修復手段現在散在三個欄位（`cta` 導航、`anchor`、`guideId`），沒有一條「什麼情況用哪個」的明文規則
   ——本報告 §2 的六條就是要補的那條規則，建議抄進 `AlertDefinition` 檔頭。
4. 劇本↔異常的對應有雙向登記（`guideId` ↔ `alertIds`）但沒有測試釘住一致性。→ 加一條 vitest 把兩邊對起來。

---

## 6. 查證結果與待查證

| 事項 | 狀態 |
|---|---|
| LINE「Set webhook endpoint URL」寫入 API | **已查官方文件確認存在**（Messaging API reference、PUT、吃 channel access token——就是系統已存的那把）。動工前仍要沙盒實測一次（路徑細節與失敗碼） |
| LINE「Use webhook」開關能否用 API 開 | 文件上**沒看到**——⛔照 07-29 的教訓，「查不到＝沒有」不能當定論，動工時再確認一次；查無就維持劇本教學 |
| LIFF Endpoint 能否用 API 代改 | LIFF 的伺服器 API 需要 **LINE Login channel** 的 token；系統目前只存 Messaging API token 與 liffId。**待查證**能否取得（要看有沒有存 Login channel 的 secret）。查證前 LIFF 家族維持劇本 |

---

## 7. 要拍板的題目

1. **同意把 `C-31` Phase 2 的首批操作對象定為「異常修復動作」**（取代原本較泛的低風險寫入首批）？
2. P1 的 **webhook 一鍵換網址**：這是用系統的鑰匙去改 LINE 上的設定，影響「訊息送到哪」。
   popup 會列「現在填的 → 換成」並要求確認——這樣的守門夠不夠，還是這顆永遠留人工？
3. `scriptDeadEnd` 一鍵補退路會**新增一顆客人看得到的按鈕**（字樣 popup 原文展示）——可以一鍵，還是要留人工？
4. `broadcastOverdue` 的「立刻補送」我建議**不做**（群發紅線＋跟看門狗打架）——同意？
