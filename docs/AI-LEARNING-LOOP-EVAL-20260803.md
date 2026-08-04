# AI 學習迴圈評估:補知識/對話異常 UX + 「整理好你只需同意」+ 從對話學習(2026-08-03)

老闆提問三件事:
1. 補知識庫、對話評估異常,在 UIUX 上要有更好的體驗
2. 能不能直接知道該做什麼,甚至系統幫你整理好、你只需要同意
3. 系統會不會從對話中學習,抓到問題或給出更好的建議

一句話總評:**「發現問題→補知識→驗證」的每一塊零件都做了,但零件之間的線斷了四條;
「幫你整理好只需同意」的資料地基已上線正在收資料(aiHandoffEvents),讀取端一行都沒寫;
「從對話學習」現在完全不存在,而且有兩種訊號今天不開始存、以後就做不了。**

---

## 一、現況體檢(三路盤點結論)

### 補知識的使用者旅程(現況 4 步跨 2~3 頁)

唯一有預填的閉環:ai-usage「近期轉真人案例」→ 點「補知識」→ sources 頁開新增
modal、**只預填標題一欄**(客人口語原句截 100 字當標題)→ 內容全手打(可按「AI
整理一下」)→ 建立(同步 embedding)→ **手動回 ai-usage 按「已處理」**→ 想驗證
要再開第三頁 playground 重打一次。

摩擦點:
- 系統不會告訴你「該補什麼」——現有清單是 `aiMeta` per-客人覆寫快照
  (`shared/types/ai-knowledge.ts:326-354`),同一客人問 5 題答不出只留最後一句,
  limit 20、無聚類、無排行、不吃月份篩選
- 知識庫頁**沒有搜尋**(`knowledge/sources/index.vue`,2292 行,grep 無 filter 框;
  `list.get.ts` 是死端點)——補卡前無法確認「這題是不是已經有卡」
- 建卡成功 ≠ 驗證通過,「生效了嗎」要自己開 playground 自證

### 對話異常的可見性(現況:看得到一半,而且是偏誤的一半)

- **「答錯」全站零覆蓋**:只記錄「AI 自己知道答不出來」(handoff/disambiguate),
  「AI 自信地答錯」沒有任何訊號——無人工評分、無標記錯誤、客服採不採用 AI 草稿也不記錄。
  唯一 proxy「答後仍轉真人」(answeredThenHandoffRate)藏在 ai-usage 預設收合的
  「進階/技術細節」裡
- **「最近變差了嗎」答不出來**:品質率沒有時間趨勢(趨勢圖只有次數柱狀),案例清單無日期篩選
- **AI 當時實際回了什麼看不到**:`messages` 子集合沒有任何 AI 標記
  (`server/utils/handler.ts:1829-1848`),`aiMeta` 只存最近一次
- **llm_error 沒有數字**:`AiUsageDoc` 無按 reason 分桶計數;異常中心只看近 24h/50 筆;
  徽章灰色與「人工指定」同級(`ai-usage.vue:597-603` 無 llm_error 分支)
- 異常中心 11 項全是**二元故障訊號**,沒有任何品質趨勢告警(答錯率升、反問率飆高)

### 斷掉的四條線(全是小修,合計約半天)

| # | 斷點 | 修法 |
|---|------|------|
| 1 | 客服對話頁 `AiContextBanner.vue:48-50` 明知 `lastQuery` 且明知「知識庫沒有相關資訊」,卻只給**純文字**建議 | 加「補知識」按鈕帶 `?q=lastQuery`(客服現場最自然的入口,現在完全沒接) |
| 2 | ai-usage「開對話」push `?userId=` 但 `AdminPanel.vue` 只讀 `?tab=`(:2330),`?userId` 全 app 零消費者 → 落在收件匣但對話沒被選中 | AdminPanel onMounted 消費 `?userId=` 直接選中該客人 |
| 3 | 異常中心 llmError CTA 只連 `/ai-usage` 不帶參數;ai-usage 也不讀 route.query → 使用者要自己想起去下拉選原因 | CTA 帶 `?reason=llm_error#handoffs`,ai-usage 讀 query 預設篩選+捲動 |
| 4 | `humanBacklog` 警示連 `/conversations` 不帶 tab → 落在「全部」分頁 | 帶 `?tab=`(drillTo 樣板已存在:`conversation-stats.vue:377-381`) |

---

## 二、「幫你整理好、你只需同意」= 建議收件匣(P1 主體工程)

### 已有的地基(關鍵:資料正在收)

- **`aiHandoffEvents` 事件流已上線**:`server/utils/ai-handoff-events.ts`,每次 handoff
  append 一筆(query 原話/reason/confidence/intent/top3 命中卡+相似度/isFollowup),
  240 天 TTL、複合索引已建、兩租戶 TTL policy 已設。commit `2d64655`(08-01)已在
  origin/main。**全 repo 零讀取端**——寫進去的資料現在沒人看
- docs/AI-KB-TODO.md:169 已有需求原文:「自動聚類排行(本週 12 人問價格、5 人問水箱
  容量…),每條旁邊『補一張卡』按鈕」——本評估把它升級為「LLM 先擬好整張卡」
- LLM 起草的工程樣板齊全,直接照抄紀律:
  - `ai-script-generate.ts:1-14`(純函式、不寫 DB、同套 normalize+validate、
    驗證失敗餵回錯誤重生一次、產出是草稿)
  - `enrichCardBatch`(批次卡片 LLM)、`normalizeChunkWithLlm`(手寫卡整理)、
    `summarizeHandoffContext`(transcript 餵 flash-lite 已驗證可行)
  - 寫卡安全出口 = 既有 `bulk-create.post.ts`;長工作 job 化樣板 = `ai-preview-jobs.ts`

### 缺的五塊(按依賴順序)

1. **讀取+聚類層**(最大塊):`GET /api/ai/usage/gaps` 之類;聚類用 `embedQuery` 對
   query 分群(現有零件無 clustering 程式碼)。建議離線批次算(cron 寫結果 collection),
   別在查詢時掃幾千筆 event
2. **`knowledgeSuggestions` collection + 生命週期**:pending / accepted / dismissed。
   沒有這個,店家忽略過的建議每次重算會再推一次(= 狼來了,功能就死了)
3. **`draftKnowledgeCardFromConversations()`**:輸入一群同類 query + top3 命中卡
   (「已知但不夠」的對照),輸出 `{title, content, questions[], productName?}` 草稿。
   工程量小,照 script-generate 紀律寫
4. **排程**:插進 `run-tasks.post.ts` 現成插槽;注意 cron-maintenance.ts:58-60 已警告
   cron 內跑 LLM 吃時間預算 → 聚類+草擬走 job 化,cron 只負責觸發
5. **UI**:知識庫頁新區塊「AI 建議你補這些」——
   主題卡:「**12 位客人問過運費,AI 都答不出來**」+ 樣本問句 2~3 條 + **已擬好的
   知識卡草稿預覽** + 三鍵:`採用並學習` / `修改後採用` / `忽略`。
   採用後:走 bulk-create → 同步 embedding → **自動用代表問句重演一次**(答對打勾)
   → 自動把該主題下所有關聯 handoff 標記已處理(銷案不再手動)。
   視覺樣板可複用 knowledge/health 的 banner+chip+modal

### 口徑決策(要拍板)

- 聚類粒度:主題(intent+embedding 分群)為主,避免同義句灌水
- 「忽略」語意:忽略主題(而非單句),新樣本進來重新浮出的門檻(如樣本數翻倍)
- 建議上限:每週每 workspace 最多 N 張草稿(避免一次倒 50 張嚇死店家)

---

## 三、「從對話中學習」= 現在完全不會,分三層做

沒有任何排程在碰對話內容(`run-tasks.post.ts` 8 項全是維運);唯一 LLM 讀對話的
是 handoff 摘要。三層由近到遠:

- **L1 缺口學習**(= 第二節的建議收件匣):從「答不出來」學。零件齊全,唯一在等的
  是資料量(08-01 起收,docs 建議累積 1~2 週——**現在開發,月中上線剛好有資料**)
- **L2 答錯學習**:從「答了但答錯」學。目前零訊號,要先開始存三種(工程量都很小,
  但**晚一天存少一天資料**):
  1. 客服對 AI 建議草稿的採用/改寫/棄用(`AiContextBanner` 一鍵填入時記錄;改寫幅度
     大 = AI 草稿不合格的訊號)
  2. `AiContextBanner` 加「AI 答錯了」一鍵標記(寫進事件流,含當時 sourceChunkIds
     → 直接指向該修哪張卡)
  3. `answeredThenHandoff` 進事件流(現在只有月計數,不知道是哪些問題答完又被轉人)
- **L3 從真人回覆學**(Intercom 式:AI 答不出→看真人怎麼回→草擬卡):目前被兩件事
  擋死——`messages` 無 AI/事件標記(無法把真人回覆對應回那一問,只能 timestamp 猜)、
  messages 有 180 天清理端點。前置:outgoing message 補 `aiGenerated` / 關聯 eventId
  欄位。先鋪資料,功能後做

---

## 四、建議優先序

| 級別 | 內容 | 量級 |
|------|------|------|
| P0 | 斷鏈四修(banner 補知識鈕 / ?userId 消費 / ?reason 帶參 / humanBacklog 帶 tab)+ answeredThenHandoff 移出進階摺疊 | 半天 |
| P1 | **建議收件匣本體**(聚類 job + suggestions collection + LLM 草稿 + 三鍵 UI + 採用後自動重演驗證/自動銷案) | 中大,3~5 天 |
| P1.5 | 補知識體驗:LLM 草稿預填內容+問法(不只標題)、建卡 modal 內建「試答看看」、從補知識入口建卡成功自動銷案、知識庫搜尋框 | 1~2 天 |
| P2 | L2 學習訊號開存(草稿採用記錄 / 答錯一鍵標記 / answeredThenHandoff 進事件流)+ outgoing message AI 標記(為 L3 鋪路) | 1 天 |
| P3 | 週報 digest:每週 LINE 推「本週 AI 答不好 top 5 主題,已擬好 N 張卡待你同意」(樣板 = dailyBacklogDigest) | 1 天 |

## 五、實作紀錄(2026-08-03 當日完成,typecheck 0 / vitest 700 綠,未 commit)

P0～P3 全數實作:

- **P0 斷鏈四修**:AiContextBanner 補知識鈕(AdminPanel 開新分頁帶 ?q=)、AdminPanel 消費
  `?userId=`(不在第一頁就用 list?search= 撈)、llmError CTA 帶 `?reason=llm_error`+ai-usage
  讀 query 預篩並捲動+llm_error 徽章轉紅、humanBacklog 帶 `?tab=pending_human`、
  「答完客人又找真人」上主畫面 substat(進階區成本三桶保留)。
- **P1 建議收件匣**:
  - `server/utils/ai-knowledge-suggest.ts`:embedding 貪婪聚類(門檻 0.83、≥2 次成題)、
    LLM 草擬(誠實原則=缺的事實寫【請填寫：…】,佔位符數存 blanksCount)、
    cron 掃描(每輪 ≤2 workspace、每 workspace 7 天一次、手動要求優先)、
    忽略後翻倍再現、`resolveHandoffsByQueries` 銷案、週一 9 點缺口週報
  - collection `knowledgeSuggestions`(等值查詢,免新複合索引);掃描狀態存
    `cronState/knowledge-gap-scan`
  - 端點:suggestions GET/refresh/accept/dismiss;accept=擋佔位符→建卡→銷案→isTest 試答驗證
  - UI:`KnowledgeSuggestions.vue` 掛 sources 頁側欄(體檢 banner 下),審核彈窗可改草稿,
    採用回饋講三件事(學會了沒/試答結果/銷了幾筆案例)
  - cron:`run-tasks` 新增 `ai:knowledge-gap-scan`+`ai:knowledge-gap-digest`;dev
    scheduledTasks 掛 */30
- **P1.5**:?q= 補知識同時預填「客人問法」(進 embedding)、建卡成功自動銷同問句案例
  (`resolve-by-query` 端點)、知識庫全庫搜尋(`search.get.ts` 掃 1500 卡記憶體比對,
  側欄搜尋框,點結果直達卡片)
- **P2 學習訊號開存**:`aiFeedbackEvents`(240 天 TTL)收 wrong_answer(對話頁「這題 AI
  答錯了」鈕,帶當時命中卡)與 draft_applied(填入草稿時靜默記);wrong_answer 已進缺口
  聚類;outgoing 訊息新增 `aiGenerated: true` 標記(答題+反問兩路)——L3 的資料從今天開始存
- **P3 週報**:`weeklyKnowledgeGapDigest`(週一台北 9 點後,有 pending 建議才推,
  cronState 防重,走 notifyKnowledgeSourceEvent)

### 部署 checklist

1. `firestore.indexes.json` 新增 `aiFeedbackEvents(workspaceId, createdAt DESC)`——
   **兩個租戶專案都要 deploy indexes**。沒 deploy 不會壞(查詢有 catch),但「AI 答錯了」
   那一路訊號不會進聚類;程式會 `console.warn` 講明原因。
2. TTL policy 兩專案各手動設一次:
   - `aiFeedbackEvents.expireAt`(240 天,同 aiHandoffEvents 前例)
   - `knowledgeSuggestions.expireAt`(180 天,只有 accepted/dismissed 帶這個欄位;
     pending 沒有 → 不受影響)。**沒設會讓建議只增不減**,撞到去重比對上限後
     已處理過的主題會被重複推薦(程式會 warn)。
3. Cloud Scheduler 不用動(新任務走既有 run-tasks 端點)
4. 上線後驗證:等 cron 掃過(≤10 分鐘/次,每輪 1 個 workspace)→ 知識庫頁應出現
   「AI 建議補的知識」;MYFEEL 正式站 aiHandoffEvents 自 08-01 起累積,首掃就有料

### Code review 修正(同日第二輪,三路獨立審查)

三個審查視角(正確性/成本規模/UX 權限)找出的真缺陷都已修:

**會寫錯資料的**
- 回饋事件被記到**錯的互動**上:aiMeta 只存最近一次,客服看著舊那題按「答錯」時
  客人可能已經又問了一題 → 現在前端必須帶 `interactionAtMs`,後端不符回 409
- 回饋沒有寫入端冪等 → 改成固定 doc id(`type_ws_user_interactionAtMs`),
  重複點覆寫同一筆(否則一人點兩下就湊到 `MIN_CLUSTER_EVENTS=2` 生出假建議)
- `markWrong` 在 await 後才寫狀態鍵 → 期間切客人會把標記顯示到別人身上
- 採用是 read-modify-write → 改成交易佔位(中間態 `accepting`,建卡失敗會退回 pending),
  否則兩個分頁同按會建出兩張幾乎一樣的卡
- 忽略沒有狀態守門 → 可把 accepted 翻回 dismissed 再被「翻倍重新浮出」,要店家重寫同一張卡
- 自動銷案沒看 handoff 原因 → 業務洽詢/敏感主題即使問句相同也不該被關掉,現在限 GAP_REASONS

**cron 會超時 / 白花錢的**
- 原本同步在 cron 跑滿 150 次 embedding + 5 次 LLM × 2 workspace,最壞 ~500s >
  Cloud Scheduler 300s deadline(**違反本文件自己寫的「聚類+草擬走 job 化」決策**)。
  現在:每輪 1 個 workspace、草稿上限 2 張、每張草稿前檢查牆鐘預算(90s/預留 30s)、
  加掃描租約(被掐斷不會兩個 Lambda 重複掃)、既有建議更新改批次寫
- 候選探索每 10 分鐘 800 筆讀(>99% 輪次是零結果)→ 加 `__nextDueAt` 早退(1 讀)
  + handoff 查詢補 `.select('workspaceId')`
- 週報在週一整天每 10 分鐘掃 300 筆 → 加 `__lastRunDate` 整體早退
- 手動「重新掃描」零節流(對外開放的 LLM 成本槓桿,且不受則數額度攔)→ 30 分鐘地板
- centroid 用純陣列存 → Firestore 自動建索引 = 每份文件上千筆用不到的索引條目,
  改存 `FieldValue.vector`(同知識卡慣例)
- 搜尋 debounce 300ms 無取消 → 一句話送 3~9 發、每發掃 1500 卡;改 500ms + AbortController

**使用者會卡住 / 被誤導的**
- 佔位符正則前後端不一致(前端要冒號、後端不要)→ 草稿看起來乾淨卻被 400 擋下,
  且搜不到要改哪裡。改成 shared 單一事實來源 `countKnowledgeDraftBlanks`,
  並在前端就 disable 採用鈕
- 主畫面「答完客人又找真人」在零資料時顯示**綠色 0%**(把沒資料講成滿分)→ 顯示「—」
- 異常中心 llm_error 深連結落在空清單(警示看 24 小時發生數、清單預設只顯示未處理)
  → 連結帶 `includeResolved=1`,且用完清掉網址
- 客人原話被塞進 questions 進 embedding,但建卡彈窗沒有這個欄位 → 看不到也刪不掉
  (可能夾著電話姓名)。補上「客人可能怎麼問」欄位 + 個資提醒
- 建議收件匣整塊在「從未掃描過」時隱藏 → 連「重新掃描」按鈕都看不到。改成載入完就顯示
- 監控頁「開對話」找不到客人時靜默不動(像連結壞掉)→ 補 toast
- 搜尋結果沒標卡片狀態 → 看到 failed/disabled 的卡會誤判「已經有了不用補」
- 掃描失敗卻寫 `lastScanAt` → UI 顯示「剛剛分析過」+ 沒有建議,看起來像真的沒缺口。
  改成記 `lastErrorAt/lastError` 並在 UI 說「上次分析失敗了」
- 靜默截斷全部改成會講:草稿因預算沒做完仍會**建立建議文件**(draft=null,下輪補草稿)、
  取樣次數顯示「至少 N 次」、搜尋命中超過 30 筆會說、去重/週報撞上限會 warn

**第二輪自我複查又補的三項**(第一輪修完後回頭核對才發現)
- `aiContextRefreshKey` 宣告了卻沒有任何地方遞增 → AI 脈絡卡只在「切換客人」時更新。
  這讓新加的 409 樂觀鎖變成死路:被要求「重新整理」但畫面上沒有刷新的地方。
  現在列表輪詢發現選中客人有新訊息就自動重抓,且 409 當下直接把畫面救回來
- 「標記後會列入分析」文案過度承諾:同類問題要累積到 `MIN_CLUSTER_EVENTS` 才成主題,
  單獨一筆不會馬上出現 → 改成「同類問題累積後會出現在…」
- `recordAiUsage` 只在函式尾端呼叫 → 中途拋錯時 embedding/LLM 的錢已花掉卻記 0
  (成本報表低估、token 護欄失準)→ 改走 `finally`

全部修正皆經 typecheck 0 / vitest 701 綠,並用機械核對逐條確認落地。

## 六、待確認事項

1. **`/api/conversations/cleanup`(180 天刪 messages)到底有沒有掛在 Cloud Scheduler?**
   repo 內零呼叫端、不在 run-tasks 8 項裡。有掛 → L3 的資料窗口是 180 天;
   沒掛 → messages 無限累積是成本問題。要去 Cloud Scheduler console 看實際 job 清單
2. 建議收件匣的口徑三決策(聚類粒度/忽略語意/每週上限)——見第二節
3. 正式環境 `aiHandoffEvents` 實際筆數(部署兩天了,抽查一下有沒有在寫,
   避免報表上線是空的)
