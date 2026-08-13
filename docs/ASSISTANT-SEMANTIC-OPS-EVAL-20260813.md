# 後台小幫手：對話式引導常態化＋語意化操作 評估與分階段規劃（2026-08-13）

> 🧊 **凍結文件（決策紀錄）。** 本檔記錄評估當下看到什麼、為什麼這樣判斷、建議怎麼做。
> 待辦與現況一律看 [`docs/STATUS.md`](./STATUS.md)（本次入表 `C-31`、`E-16`、`E-17`）。
> 給老闆看的白話版另出 artifact「小幫手 2.0：從會講話到會動手」。

**起因**：老闆提問——①開通引導的「對話式引導」能不能變成常態（agent 被問到相關問題都能帶著做）？
②全面健檢並大改現在的 agent。③最終目標「語意化操作」：使用者用白話講需求，agent 代為操作後台功能，
做法仿腳本切成標準化模組。**已確認的前提**（2026-08-13 老闆拍板）：範圍只有後台管理者側；
操作形式「兩者都要，依風險分級」（低風險直接做、高風險先預覽再確認）。

**方法**：四路程式碼盤點（開通引導／小幫手本體／腳本模塊架構／全部寫入端點與權限）＋
三份歷史文件對讀（`ONBOARDING-CHAT-DESIGN-20260807`、`ASSISTANT-AGENT-EVAL-20260806`、`ONBOARDING-CHAT-EVAL-20260812`）。
純程式碼審閱，未實機操作。

---

## 一、結論先講

1. **可行，而且不是蓋第四套系統。** repo 裡已有三個「半成品」，這次要做的是收斂：
   - **訊息渲染層**（`shared/types/agent-messages.ts`＋`AgentMessageRenderer.vue`＋`AgentAskDock.vue`）：
     卡片／按鈕／輸入框／複製卡都寫好了，型別檔頭明寫「LLM driver 未來回這些型別就能長按鈕」——
     但目前全 repo 只有開通精靈一個使用者，問助理還在回純文字（`AdminAgentChat.vue:11` 直接 `{{ m.text }}`）。
   - **劇本引擎**（`useOnboardingChat.ts`，1101 行）：「帶著做＋後端真訊號驗證＋超時排障」整套都會，
     而且**已經會代使用者寫入**（存 Token、開 AI 都是它代打、走既有端點與使用者本人 bearer）——
     但步驟是命令式 async function 寫死在開通情境，無法列舉、無法複用，第二個精靈只能整份複製。
   - **LLM agent**（`ai-admin-agent.ts`，295 行）：7 個唯讀工具、租戶隔離乾淨（workspaceId 由 session 帶入，
     模型碰不到）、prompt injection 防線、審計＋記帳分桶都有——但 `ToolDef` 只有 `{description, run}` 兩欄，
     沒有權限、沒有 schema、沒有寫入概念；端點一刀 `viewer`。
2. **「從查到做」不是新想法，是欠了兩次的舊帳。** `ASSISTANT-AGENT-EVAL-20260806.md:146` 的 S2 與
   `ONBOARDING-CHAT-DESIGN-20260807.md` 的 Phase 3 都明寫這條路，連「腳本引擎的動作累積器是現成底座」
   都點名了。這次評估等於把兩份文件的「另案」正式立案。
3. **語意化操作的正確切法＝「操作模組註冊表」，形狀直接抄腳本系統**（收斂層＋驗證層分離、
   註冊表單一來源、草稿確認才落地、限縮詞彙表、拒答出口），但有三件事**不能照搬**（見 §3.4）。
4. **兩個必須先補的地基**：①全站沒有操作稽核（誰改了什麼查不到，AI 動手前必補）；
   ②工具層沒有權限欄位（現在五個直讀 Firestore 的工具剛好都是 viewer 級「是巧合不是機制」）。
5. **盤點順帶抓到三個現成缺陷**（與本案無關也該修）：
   - `richmenu/setDefault.post.ts` 只帶 `richMenuId`（LINE 側 ID）時**不驗歸屬**→ 入表 `E-16`。
   - 小幫手 `get_ai_usage` 把 token 細目回給 viewer，繞過「token 只給超管」的既有規則
     （`ai-admin-agent.ts:113-115` vs `ai/usage/summary.get.ts:203`）→ 入表 `E-17`。
   - 腳本上下架（`enabled` switch 隨表單 PUT）與圖文選單 `setAsDefault()`（`richmenu.vue:784`）
     **完全沒有二次確認**——「按下去就對外生效」清單裡的裸奔操作，收進本案 Phase 2 的預覽端點一起解。

---

## 二、現況盤點（四路彙整，細節以各檔案為準）

### 2.1 開通引導（劇本 driver）

- 純前端劇本狀態機、**零 LLM**；原語 `say/card/askChoices/askInput/askPicker/apiRetry`（`useOnboardingChat.ts:114-242`）。
- resume 不存進度：每個 step 開頭自己 guard（訊號已完成就靜默跳過）；跳過記 localStorage `onb-skips:{wid}`（純 UX 記憶）。
- 等待卡＝3 路 `Promise.race`（輪詢／使用者按鈕／90s 超時排障），排障重驗與主流程共用 `verifyAndAdvise()` 依真實錯誤分診。
- **寫入代打**走既有端點＋使用者本人 bearer：`self-serve`、`line-workspace` PUT（partial）、`ai/settings` PUT、`line-webhook-verify`（唯讀探針，刻意不用會清全租戶快取的 `verifyWebhookOnSave`）。
- 寫死在開通情境的部分：步驟順序在 `start()` 重複兩份（新建/續走）；進度條手動指派；
  設計文件說的宣告式劇本 `onboarding-script.ts` **從來沒建出來**；`{kind:'check', probe}` 訊號輪詢卡合約沒實作
  （輪詢邏輯硬綁 first-message 端點）；**零測試**（1101 行含 race 的狀態機）。

### 2.2 小幫手（TutorialAgent＋問助理）

- 三分頁：目前狀況（27 個 alert probe＋verdict 四級＋修復閉環 `verifyLastFix` 30 分鐘歸因窗）／教學（純靜態 25 主題 el-tour）／問助理（LLM）。
- 問助理：`gemini-2.5-flash`、temperature 0、每輪重建 prompt、最多 4 次工具呼叫；7 個唯讀工具；
  三個工具用 `$fetch`＋authHeader 轉發（目標端點重跑完整 `requireWorkspaceAccess`＝權限口徑零第二份），
  五個直讀 Firestore（只靠端點一刀 viewer）。
- 對話歷史：前端記憶體（重整即失）＋request 帶最近 6 則＋`adminAgentLogs`（**write-only 純審計 sink**，零讀取端）。
- 前端 `TOOL_LABELS` 是手寫第二份工具名對照（與全案單一來源慣例不符）。
- HITL 雛形三個都現成但沒接在 chat 上：`AgentAsk` choices／「只回草稿走既有端點存檔」（`scripts/generate`）／建議收件匣採用流。

### 2.3 腳本系統（可複製的形狀）

- 「13 模塊」是產品對標清單，程式實況是 **8 種節點型別**（`shared/types/ai-script.ts:12`）。
  **教訓：roadmap 編號不要洩進 code；操作模組用能力／端點切，別先訂數字。**
- 值得抄的（依價值）：①收斂層 `normalize*`＋驗證層 `validate*` 分離，且**驗證器與功能頁共用同一支**
  （agent 只是第三個呼叫端）②型別驅動的 `Record<K,string>` label 單一來源＋description 自動灌 prompt
  ③只回草稿、人按確認才走既有端點 ④限縮詞彙表＋拒答出口＋「建議只准指向真的存在的功能」
  ⑤確定性後檢＋一次回饋重生＋有界迴圈＋兩次 token 都記帳 ⑥建議級 vs 阻擋級分家
  ⑦綠燈只宣告真的查過的事、保守強條件（漏報好過誤報）。
- **不能照搬的**：圖驗證引擎（操作多是單發指令）；`ActiveScriptState` 狀態機（跨輪只需要短命 pending-op）；
  **「跑了再檢查、不行重生」的迴圈語意——寫入必須反過來：驗證 → dry-run → 冪等執行一次，後檢在執行之前**；
  佔位符（操作參數缺了只能反問，不能自動補通用值）。

### 2.4 可操作能力盤點（207 支端點，寫入約 130 支）

權限系統：`shared/permissions.ts` 12 個 capability（內容=agent、設定=admin）＋`requireWorkspaceAccess/requireCapability`
單一事實來源；多租戶三層隔離（端點解析 workspaceId／查詢一律 where／rules deny-all）。
**全站沒有通用稽核**：只有零星 `createdBy`（5 處）、`updatedAt` 普遍但不記誰改的。

風險分級結論（完整清單見盤點，這裡記代表項）：

| 級別 | 執行策略 | 代表操作 |
|---|---|---|
| 🟢 低 | AI 直接做完回報 | 全部 GET、`broadcast/validate`、`audience/estimate`、對話標記 flags、忽略建議、資料夾整理、建推播**草稿** |
| 🟡 中 | AI 準備好 → 聊天內確認 → 執行 | `ai/settings` PUT（⛔**整份覆寫**，必須先讀後寫）、知識卡編輯、腳本編輯含上下架、模組/圖文訊息、批次貼標、reindex 類（燒 token）、會話接手/交還/結案 |
| 🔴 高 | AI 只做「準備＋說明」，**最終按鈕永遠留給人** | `broadcast/send|schedule|process-due`、`conversations/send`（以官方帳號名義說話）、richmenu `setDefault/create`（全好友即時生效）、所有 delete（來源是級聯刪）、LINE 憑證、成員權限、計費四支 |
| ⛔ 禁 | **連工具都不掛** | cron secret 那批（`run-tasks` 內含會刷卡的 reconcile）、super admin 全區 |

現成 dry-run 資產：推播 `validate.post.ts`（全案品質最好的預覽端點，回預估人數＋前 5 筆預覽）＋前端發送前確認框；
知識庫匯入三段式（preview-job → 挑卡 → bulk-create）＋ resync diff；
腳本的 reachability 計算（前端已會算「這條啟用後會攔掉誰」，可搬成後端 `preview-impact` 端點兩邊共用）。
**缺口**：腳本上下架與 `setAsDefault` 無確認；`reindex-all`/`reenrich` 無預覽無確認。

---

## 三、目標架構

### 3.1 一個渲染層、兩種 driver、一張模組表

```
                      ┌─ 劇本 driver（狀態機）──── 開通精靈、「帶你修好」引導劇本
AgentMessageRenderer ─┤
（AgentMsg/AgentAsk） └─ LLM driver（問助理）──── 查資料、帶著做、代辦
                                   │
                            操作模組註冊表（讀寫共用一張表）
                                   │
                          既有端點（authHeader 轉發）＝權限/驗證單一來源
```

- 沿用 08-07 已拍板的「一個渲染層、兩種 driver」，這次把 LLM driver 接上渲染層（缺的那半）。
- 引導劇本從開通擴到 alerts：alerts 註冊表的 `route`/`cta` 現在只能把人丟到頁面，
  那個位置就是掛「帶你修好」劇本 id 的地方（`liffEndpointBroken`、`handoffNotifyMissing`、`knowledgeSyncFailed` 先做）。

### 3.2 操作模組（OperationDef）的形狀

`ToolDef` 從 `{description, run}` 擴成：

```ts
{ id, label,                    // label 收 shared 單一來源（給模型的 description、給人的確認文案、UI 顯示同源）
  capability,                   // 掛 shared/permissions 既有 capability；執行前比對 role（loop 要收 role）
  mutates: boolean,
  risk: 'low'|'medium'|'high',  // high 永遠不給 execute，只給 prepare
  schema,                       // args 宣告式驗證（zod 或手寫 normalize，比照腳本收斂層）
  dryRun?: (args) => 中文 diff/影響說明,   // 中風險必備；盡量借既有 validate/preview 端點
  execute: (args, ctx) => 走既有端點（authHeader 轉發），不直接動 Firestore }
```

### 3.3 確認流（依風險分級，2026-08-13 老闆拍板方向）

- 🟢 低：直接執行 → 回報結果（做了什麼講清楚）。
- 🟡 中：LLM 產出 pending-op（args＋dry-run 結果）→ 聊天內出 `AgentAsk` choices
  「目前 09:00–19:00 → 改成 22:00–08:00，確定嗎？」→ 使用者按確認 → **第二個 request 才執行**
  （pending-op 是短命 payload 跟著訊息走，不開狀態機、不存 Firestore）。
- 🔴 高：AI 建草稿＋跑 dry-run＋講清楚影響，然後給深連結或按鈕**帶去該頁**，最終按鈕留在原本的頁面上
  （沿用推播「發送前確認」既有 UI，不在聊天內做第二個發送入口）。

### 3.4 鐵律（從既有系統繼承，寫進實作前的 code review 清單）

1. `workspaceId` 由 session 帶入，模型永遠碰不到（現行鐵律，沿用）。
2. 寫入一律走既有端點＋authHeader 轉發；**agent 這邊一行驗證邏輯都不重寫**（驗證器與功能頁同一支）。
3. 模型不生 ID（tagId/scriptId/moduleId…）：先用唯讀工具列清單、再讓它挑序號——腳本系統「tag 不教」的教訓。
4. 寫入順序＝驗證 → dry-run → 冪等執行**一次**；失敗不自動重試、不把錯誤餵回模型讓它再寫（唯讀才可以）。
5. `ai/settings` 是整份覆寫：patch 任何欄位必先 GET 全量再寫回，否則清掉別的設定。
6. 執行後的「改好了」要用真實訊號驗（比照 `verifyLastFix`），不是模型自己說。
7. 綠燈只宣告真的查過的事；查不到＝unknown 單獨講。
8. 每次寫入落稽核（見 Phase 0）；token 記 `test*` 後台自用桶（現行慣例）。
9. 引導教學內容必須與健康檢查同口徑同來源（`liff-lead-path` 式的 shared 常數）——
   開通精靈「教填官網」教錯的前科（G-7）就是兩套口徑的代價。

---

## 四、分階段規劃

| Phase | 內容 | 使用者看得到什麼 | 驗收 | 估 |
|---|---|---|---|---|
| **0 地基**（可獨立先上） | ①`auditLogs`：統一寫入稽核（workspaceId, uid, actor: human\|agent, endpoint, before/after, ts；schema 比照 `adminAgentLogs` 擴充＋補索引兩租戶）②`ToolDef` 加 `requires/label/mutates`，loop 收 `role`，`TOOL_LABELS` 收 shared ③修 `E-17` token 洩漏 ④修 `E-16` setDefault 歸屬 | 看不到（地基） | 稽核寫入有測試；viewer 問 token 細目拿不到；typecheck 0 錯 | 2–3 天 |
| **1 引導常態化** | ①chat 端點回 `AgentMsg[]`＋`AgentAsk`，`AdminAgentChat` 改掛 `AgentMessageRenderer`（08-06 明列未做的「深連結」一併解）②`useOnboardingChat` 抽 `useAgentScriptRunner`（say/ask/apiRetry/訊號等待卡），步驟改宣告式 `{id, guard, run, signal}` 陣列，**補測試**③第一批「帶你修好」劇本掛進小幫手面板（挑 3 個 alert：LIFF endpoint、轉真人通知沒設、知識來源同步失敗），alerts 註冊表 cta 位置掛劇本 id | 問「怎麼設定 X」不再是一段死文字：有可點按鈕、帶你去對的頁、做完真的檢查有沒有生效；異常卡片多一顆「帶我修好」 | 三條劇本實機走通；runner 有測試；開通精靈行為不變（回歸） | 4–6 天 |
| **2 語意化操作 MVP** | ①操作模組註冊表＋pending-op 確認流（§3.2/3.3）②第一批 🟢 低風險模組（標記、忽略建議、資料夾、建推播草稿、跑試算）③第一批 🟡 中風險（AI 設定單欄 patch＝先讀後寫、腳本上下架）④配套 dry-run：`scripts/preview-impact` 端點（搬 reachability 計算，**人工存檔也共用**＝順帶補上下架確認缺口） | 「幫我把勿擾改成 22:00–08:00」→ 秀改動前後 → 按確定 → 改好回報；「先把那條腳本停掉」→ 秀影響 → 確認 → 停用 | 每個寫入都有稽核紀錄；確認前不落任何變更；playground 級實測 20 案（含惡意指令、跨租戶嘗試） | 5–8 天 |
| **3 擴大覆蓋** | 更多 🟡 模組（知識卡編輯、批次貼標、reindex）；🔴 高風險維持「準備＋人按」**永久紅線**；視使用回饋決定要不要做 org 層 | 更多事講一句話就完成準備 | 逐批驗收 | 另估 |

**順序建議：0 → 1 → 2。** 理由：引導（Phase 1）是信任的地基——使用者先體驗到「它帶我做的都是對的」，
才會放心讓它代辦；反過來先做代辦、引導還是死文字，出一次錯信任就崩（08-07 設計文件釘死原則的延伸）。

---

## 五、風險與防守（含老闆沒問到的盲點）

1. **稽核先行不可妥協**：現在出事查不到「是誰／是不是 AI 改的」；先開寫入後補稽核＝裸奔窗口。
2. **教學內容過期**是引導型 agent 的長期風險（G-7 前科）：劇本引用的網址/口徑一律取 shared 常數，不許手抄。
3. **LLM 幻覺參數**：schema 擋格式、清單挑序號擋 ID、dry-run 擋語意——三層都要，缺一層就會有「改錯欄位」事故。
4. **端點一刀 viewer 的閘門要改成 per-tool gate**，否則掛第一個寫入工具的瞬間 viewer 就能做 admin 的事。
5. **對話無跨 session 狀態是特性不是缺陷**：pending-op 過期即失效（重整＝取消），不要為此開狀態機。
6. **成本**：問助理現在 flash＋thinkingBudget 0，一輪極便宜；操作化後多 dry-run 一兩輪，量級不變；照慣例記後台自用桶。
7. **`process-due` 這類名字無害、實際會對外發送的端點**，在模組表用 deny-list 明文排除，防未來手滑掛上。

## 六、待老闆拍板

1. **分期順序照建議（0→1→2）嗎？**（另一選項：先 2 後 1，快點看到「代辦」但信任風險前置）
2. **🔴 高風險紅線清單認可**：群發/對客人說話/刪除/憑證/成員/計費永遠留人按——這條要拍板成永久原則，工程不自行放寬。
3. **Phase 2 的 🟡 首批要不要含「AI 設定」**（會立即影響客人體驗的欄位，如勿擾、信心門檻），
   還是首批只跑內部標記類、AI 設定放 Phase 3？
