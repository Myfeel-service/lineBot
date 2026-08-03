# 對話統計口徑定義（活文件）

> 這是**口徑定義書**，不是稽核報告。它不會「完成」，會被反覆查。
> 改動 `initialHandler` / `status` 的語意前請先讀這份。
>
> 最後更新：2026-08-03

---

## 一句話總結

**「未首接」在兩個畫面代表不同的意思，而且是刻意的。**

| 畫面 | 讀哪個欄位 | 問題是 |
|---|---|---|
| 對話統計看板的「未首接」 | `initialHandler === 'unhandled'` | 有沒有人**回答過**這位客人？ |
| 收件匣側欄的「未首接」佇列 | `status === 'open'`（扣掉未開口的加好友） | 這場對話**還需不需要人處理**？ |

**這兩個數字本來就不會一樣。看到不一樣不是 bug。**

---

## 為什麼要分開

同一個問題沒辦法同時給出兩個答案。舉三個例子：

1. **客人按了「切換選單」按鈕。** 統計上「沒有人回答他」是對的（他也沒問問題）；但佇列上他根本不在等任何東西，不該排隊等客服處理。
2. **客人問了、機器人用「系統通知」模組回了。** 系統通知不是客服回覆，統計上不該算機器人首接；但客人已經收到東西了，佇列上不該再掛著。
3. **活動加好友的自動推播。** 那是客人沒問就送的，記成機器人首接會讓活動辦越大、統計灌水越兇；但客服也不需要為它做任何事。

早期兩件事共用一個判斷，所以上面三種情況全部誤掛在「未首接」佇列裡——客服看到一堆其實不用處理的對話。

---

## 兩個欄位的分工

| 欄位 | 用途 | 誰會改它 |
|---|---|---|
| `initialHandler` | **統計**：這場對話第一個回答客人的是誰（`bot` / `ai` / `human` / `unhandled`） | 只有「真的回答了客人」才寫。寫進去之後不再改（首接只有一次） |
| `status` | **流程／佇列**：現在的處理狀態（`open` / `bot_handling` / `pending_human` / `human_handling` / `closed`） | 任何「系統已回應」或「轉真人」都會改 |

分界點在 [`server/utils/conversation-session.ts`](../server/utils/conversation-session.ts) 的 `enterModule()`：

- `bot_flow` / `welcome` / `ai` → **兩個都改**（回答了客人，也離開佇列）
- `live_agent` → 兩個都改（`status` 轉 `pending_human`）
- `system_notice` → **只改 `status`，不改 `initialHandler`**　← 就是這一行在做分家

---

## 哪些情況會進「未首接」佇列

### 會進（客人有需求、還沒人回應）

| 情況 | 為什麼 |
|---|---|
| 客人傳文字，沒有規則命中、AI 沒開 | 真的沒人理他 |
| 客人傳文字，AI 在草稿模式 | 建議回覆只進收件匣，客人**沒收到**東西 |
| 客人按了按鈕，但按鈕指向的模組已刪除／已停用 | 客人按了什麼都沒收到，需要人看一眼。根因另有「按鈕按下去沒反應」的異常提醒（見 `broken-module-refs.ts`） |
| 客人傳貼圖 | 刻意不回（回「我看不懂」很突兀），但客人確實沒收到回應 |

### 不會進

| 情況 | 記成什麼 | 為什麼 |
|---|---|---|
| 加好友／點活動連結，客人還沒開口 | 不記 | 沒有東西被「接」。算未首接會被活動流量灌水，算機器人首接又反向灌功 |
| 活動加好友的自動推播 | `system_notice` | 客人沒問就送的，不是回答 → 不算首接；但客服不用處理 → 離開佇列 |
| 客人問了、機器人用「系統通知」模組回了 | `system_notice` | 同上 |
| 只切換圖文選單的按鈕 | `system_notice` | 已完成的操作，不是待回覆的提問 |
| 機器人流程／自動回覆回了客人（含純文字、網址） | `bot_flow` | 機器人首接 |
| 客人傳圖／影／音／檔，收到引導語 | `bot_flow` | 是寫死的引導語不是 AI 作答，所以記 bot 不記 ai |
| AI 回答、AI 反問澄清、AI 問「要轉接嗎」 | `ai` | AI 首接 |
| 客服在收件匣手打訊息 | `human` 或轉真人 | 見 `onHumanOutgoingMessage` |
| 客服點「客服預存」送出 | 同上 | 與手打訊息同一件事（漏記過，會讓機器人跟真人搶話） |
| 群發推播 | 不記 | 不是回答，也不影響這場對話的狀態 |

---

## 群發推播為什麼不寫進對話紀錄

群發**不會**在 `conversations/{uid}/messages` 留任何東西。對話畫面上看到的群發標記是**讀取時才拼進去的**，見 [`timeline.get.ts`](../server/api/conversations/sessions/[sessionId]/timeline.get.ts) 的 `loadBroadcastItems()`。

理由：

1. 一次三千人的群發就是三千筆重複內容，訊息本體只該存一份（在推播報表那邊）。
2. 更嚴重的是——寫成 outgoing 訊息會把三千個人的 `lastMessageAt` 同時推到現在，**整個「全部」收件匣排序會被洗掉一次**，「已讀」推定也跟著失準。

收件人名單本來就完整存在 `broadcasts.audienceSnapshot.resolvedUserIds`，直接反查即可，零額外寫入。

**規模上限**：那份名單是單一文件內的陣列，Firestore 單文件 1MB，約兩萬多人會頂到。這個限制在寫入端本來就存在，不是這個做法帶來的。

---

## 側欄佇列的數字與清單為什麼要同源

側欄的數字和清單曾經各算一套，導致「寫 373 筆、點進去只有 3 筆」。

現在兩邊共用 [`server/utils/conversation-queue.ts`](../server/utils/conversation-queue.ts)：

- `isOpenQueueSession()` — 逐筆判定（列表用）
- `countOpenQueueSessions()` — 計數（數字用）
- `scanFilteredPage()` — **過濾在分頁之前**。不能改回「先取 30 筆再過濾」，那樣每頁都會縮水

為什麼不直接用 `where('hasInbound', '==', true)` 查：舊資料沒有這個欄位，Firestore 的等值查詢**不匹配缺欄位的文件**，那些舊會話會從清單和數字裡一起憑空消失。

---

## 改動這些語意前的檢查清單

- [ ] 有沒有其他地方讀 `status === 'open'`？（目前只有側欄；cron 與異常中心只讀 `pending_human` / `human_handling`）
- [ ] 有沒有其他地方讀 `initialHandler`？（目前是 `conversation-stats/kpi.get.ts` 與 `trend.get.ts`）
- [ ] 新增「會回覆客人」的路徑時，有沒有記帳？（漏記的後果是客人收到回覆、系統卻算它未首接）
- [ ] 新增的回覆算不算「首接」？不算的話用 `system_notice`，別為了讓它離開佇列就記成 `bot_flow`

---

## 相關測試

改壞了這些會紅：

- `server/utils/conversation-session.enter-module.test.ts` — `system_notice` 只動 `status` 不動 `initialHandler`
- `server/utils/conversation-session.human-reply.test.ts` — 真人首接 vs 轉真人的分類
- `server/utils/conversation-queue.test.ts` — 過濾在分頁之前、換頁不重複不漏
- `server/utils/handler.session-accounting.test.ts` — 各條回覆路徑有沒有記帳
- `server/utils/broken-module-refs.test.ts` — 空按鈕靜態檢查
