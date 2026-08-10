# 專案狀態總表（待辦／進行中／完成）

> **這份是唯一狀態事實來源。** 每次有實質變動就更新這份，不要只寫在對話或記憶裡。
> 最後更新：2026-08-10
> 規則與欄位定義見本檔最後一節「怎麼維護這份」。

**狀態代碼**

| 代碼 | 意思 |
|---|---|
| `TODO` | 還沒開工 |
| `DOING` | 已動工，程式在 working tree，**尚未 commit** |
| `DONE` | 已 commit 並推上 `main` |
| `DEPLOY?` | 程式已進 main，但**線上是否生效／外部設定是否做完未驗證** |
| `BLOCKED` | 卡在外部（申請、憑證、老闆拍板） |
| `DECIDE` | 等老闆拍板才動 |

---

## 🔵 進行中（DOING — 未 commit）

_目前沒有未 commit 的工作。_

---

## 🔴 待辦（TODO / BLOCKED / DECIDE）

### A. 上線與部署

| 項目 | 狀態 | 說明 |
|---|---|---|
| AWS Cost Explorer 成功路徑未實測 | `TODO` | 本機無憑證，接好但沒跑通。根帳號要先開「IAM 存取帳務資訊」否則必 AccessDenied。教學：`docs/AWS-COST-SETUP.md` |
| 自動回應合一：部署前實機驗七件事 | `TODO` | 動了送訊息與 webhook 編排，不驗不能上 |
| 異常中心索引部署兩租戶 | `TODO` | `knowledgeSources (workspaceId ASC, outdatedAt ASC)` 已寫進 `firestore.indexes.json` 未部署（沒部署會退回全掃描，不會壞）⛔deploy 別加 `--force` |
| myfeel LINE Webhook URL 仍填舊網域 | `TODO` | LINE Developers 後台要換成正式網址 |
| LIFF Endpoint URL 遷移 | `TODO` | ⛔順序：先改 LINE console endpoint → 部署 → 才跑 `resync --apply`；舊網域不可下架 |
| 對話 180 天清理沒掛排程 | `DECIDE` | 兩租戶都沒掛，訊息無限累積（成本問題非資料遺失）。掛上就真刪且無 TTL 可挽回 → 等老闆決定 |
| `aiTurns` TTL policy | `TODO` | 新子集合，要兩租戶各手動設一次 |
| `aiHandoffEvents` TTL policy | `TODO` | 寫入已帶 `expireAt`（240 天）但 policy 沒設＝永遠不會自動清。補記「找真人」事件後量會再增加（八月多 12 筆） |
| AWS 成本金鑰環境變數 | `TODO` | 走金鑰路線要在 Amplify 設 `AWS_COST_ACCESS_KEY_ID`／`AWS_COST_SECRET_ACCESS_KEY`。⛔**不可命名為 `AWS_ACCESS_KEY_ID`**：Lambda 保留變數，會被執行角色蓋掉且查不出原因 |

### B. 金流與發票

| 項目 | 狀態 | 說明 |
|---|---|---|
| PAYUNi「07 信用卡 Token API」申請書 | `BLOCKED` | 沙盒被 UPP02087 擋住（05 幕後授權已開）。核准後還要進後台啟用。Amplify 動態 IP vs 綁授權 IP 要問 |
| PAYUNi P3 每期續扣排程 | `TODO` | ⛔續扣必用 `confirmRenewal`，否則一次扣款拿兩個月 |
| PAYUNi P4 降級／折抵、P5 換卡＋清藍新死碼 | `TODO` | 設計見 `docs/PAYUNI-RECURRING-DESIGN.md` |
| 光貿發票正式金鑰 | `BLOCKED` | `GUANGMAO_INVOICE_*` 沒填 = 每筆訂單發票 skipped = 零開票 |
| 光貿作廢／折讓沙盒實測 | `TODO` | 開立已全綠，這兩支還沒實測 |
| 含稅／未稅口徑 | `BLOCKED` | 要問會計，稅務問題不是體驗問題 |
| 升級按比例退費／折抵 | `DECIDE` | `payment.ts` 刻意註記的待辦。建議折抵不退現金，等拍板 |
| 退款流程（`trade/close`） | `TODO` | 會動錢，建議連真實金流一起測 |
| 收據／通知信（SES） | `TODO` | 已寫未開，要 `EMAIL_FROM` + 驗證網域 + 出 sandbox |

### C. AI 與腳本

| 項目 | 狀態 | 說明 |
|---|---|---|
| 腳本 13 模塊 ③⑨ | `TODO` | A+B+C 階段其餘全完成 |
| 「查詢訂單」改用腳本收四格再轉真人 | `TODO` | 老闆選了「先關規則，之後再做」 |
| AI 正式上線前 6 步 | `TODO` | ①停 anyText 規則 ②設 handoffNotify 收件人+SLA ③設 serviceHours 勿擾 ④設 shopUrl ⑤replyMode 先 draft 跑 1-2 週 ⑥confidence 上線初期回 0.75 |
| AI history 沒時間上限 | `TODO` | 會撈到 2.5 個月前舊訊息（已報未修） |
| `resync-preview` 504 風險 | `TODO` | 同吃 `chunkTextWithLlm`，可套 job 機制 |
| `upload.post.ts` 6MB 雷 | `TODO` | 同 Lambda payload 上限，未改直傳 signed URL |
| 產品名注入：splash 租戶 | `TODO` | 若要做，需同樣種 productName + reindex |
| 🔴 知識庫重傳同一份檔會重跑重收費 | `TODO` | 手動上傳**沒有內容去重**（`contentHash` 只有 url／Google Sheet 自動同步在用），重傳沒改過的大檔＝OCR＋切卡＋embedding 整套重跑重收，且不受則數／token 額度擋。最省力修法＝把現成的 contentHash 比對接到手動上傳，未變更就跳過 |

### D. 等老闆拍板

| 項目 | 說明 |
|---|---|
| 「系統」發送者標籤要不要留 | 老闆只講真人/AI/機器人三類，系統是我加的 |
| 貼圖算不算「待處理」 | |
| 昨日摘要「沒人回 N」可否點進名單、要不要補 SLA 那條 | |
| 用量頁 hero「AI 幫你處理的則數」用詞 | 這個數字含客人直接喊「找真人」被攔截、AI 其實沒出手的情況（八月 12 筆／約 6%）。歸在「轉給真人」那段所以沒說謊，但字面涵蓋不到。要不要在 tooltip 補一句；改用詞可能要連 `docs/STATS-SIMPLIFICATION-20260807.md` 一起看 |

### E. 技術債

| 項目 | 說明 |
|---|---|
| ESLint 未導入 | 刻意延後（初次導入會產生大量風格 noise），typecheck 已進 CI |
| 巨型檔案待拆 | `server/utils/handler.ts`(~2500 行)、`flow.vue`、`AdminPanel.vue` — 應獨立成無行為變更的重構 PR |
| 重複實作收斂 | `tsToMs` 全 repo 9 份、worker-pool 3 份、`deliverOrDraft` 統一出口 |

### F. 已知限制（不打算修，但別忘了）

| 項目 | 說明 |
|---|---|
| 改桶只影響未來資料 | 小幫手／生成腳本的 token 改記「後台自用」後，**八月以前的舊資料仍留在「回答客人」桶**，且月結桶是加總值、拆不出來，無法回填 → 跨月比較時九月起口徑會略有不同 |
| 成本無法分攤到各官方帳號 | 資料庫（Google）與主機（AWS）都不依 workspace 分記用量，只有 AI 能逐帳號拆。頁面已寫明 |
| 跨雲流量是唯一估算項 | 資料庫在 Google、主機在 AWS，每次讀取都是對外流量但**沒有任何用量指標可查**。用「讀取次數 × 每筆 1 KB × US$0.12/GiB」估，已對帳單校準（誤差 5% 內）。常數 `ASSUMED_BYTES_PER_READ`，調高＝更保守 |
| 估算單價無條件進位 | 「一次抓 NT$0.04」是實測平均進位到分位。⚠️若哪天實測平均掉到 NT$0.005 以下，進位到分位會變成高估兩倍，那時要改進位到千分位 |
| 金額一律只給 super admin | 五支會回金額的端點全部有守衛；`ai/usage/summary` 對非超管**連 key 都不回**。理由：計費賣「則數」，token 是平台進貨價，租戶拿到金額就能反推毛利 |

---

## ✅ 完成（DONE — 已 commit 並推上 main）

> ⚠️ 這批全部已進 `main`，但**線上部署狀態未逐項驗證**（`DEPLOY?`）。要確認得看 Amplify／Firebase console。

| 日期 | 項目 | 代表 commit |
|---|---|---|
| 2026-08-10 | AI 記帳稽核：修正成本頁用錯分母（該用 invocations 不是 answered）、小幫手與生成腳本兩處歸錯桶、「找真人」轉真人事件漏記；三桶算式抽成單一來源 `ai-cost-buckets.ts` ＋ 7 項測試 | `66a6af7` |
| 2026-08-10 | 超管成本頁改版：拖拉估算器整組刪掉，改成 AI（實測）／資料庫（Firebase 實測用量）／主機（AWS 真實帳單）三筆；含 Cloud Monitoring 分桶時區 bug（`taipeiMidnightAfter`）與 AWS 設定教學 | `a936ca3` |
| 2026-08-09 | 自動回應合一：自動回覆功能整組下架、腳本簡單模式、整頁捲軸收成一條 | `023b36d` |
| 2026-08-09 | 腳本編輯器 UX 大改 1~10 項（含合併成兩分頁、健康狀態三重檢查） | `023b36d` |
| 2026-08-08 | 對話完整時間軸 ＋ 分段讀（兩端點合一、一段 40 則） | `a9e41c7` `9194b89` `6528595` `e6b3108` |
| 2026-08-08 | 未讀紅點規則（只有客人來訊才紅）＋ 全部已讀 | `fbfc055` |
| 2026-08-08 | 自動回覆複讀防呆（並行去重＋時效＋轉真人後清紀錄） | `1dce231` `6716c90` |
| 2026-08-08 | 續扣單誤作廢造成重複扣款 | `4c1e1cc` |
| 2026-08-08 | 會話事件補 workspaceId ＋ 舊資料回填（兩專案已跑） | `7792461` `62c65bb` |
| 2026-08-08 | LIFF 設定端點改前綴查詢、租戶判斷規則收斂 | `6dec35a` `35e4839` |
| 2026-08-08 | 小幫手收編腳本異常兩項（scriptDeadEnd 紅／scriptUnreachable 黃） | `cb83e8f` |
| 2026-08-07 | LIFF 換網域災情三件套 ＋ Endpoint 填錯系統內偵測 | `1cbe1b1` |
| 2026-08-07 | 活動連結「無法完成綁定」修復 | `1cbe1b1` |
| 2026-08-07 | 昨日摘要卡改版 ＋ 日期窗時區 bug（`taipei-day.ts`） | `9ee9544` |
| 2026-08-07 | 對話日期分隔線、誰回的標籤、右鍵標記（釘選／待跟進） | `1cbe1b1` |
| 2026-08-07 | 開通引導對話 agent Phase 1 | `c1ce12e` |
| 2026-08-06 | 客服 LINE 推播改版（二選一模式／每日摘要合併／digestHour） | `3f71f75` |
| 2026-08-06 | AI 脈絡卡每回合一張（`aiTurns`）＋ 接手前要知道的事 | `3f71f75` |
| 2026-08-06 | 轉真人拓樸統一 ＋ 勿擾時段 | `9261f55` |
| 2026-08-06 | 對話列表五分頁統一、客人動作軌跡 | `9261f55` |
| 2026-08-05 | 跨產品張冠李戴（對話級產品鎖）、重新同步報假變更 | `8f8de5d` |
| 2026-08-05 | 圖片辨識 Phase 1+2、客人照片存檔 | `c7e87ba` |
| 2026-08-04 | 知識庫 UX 收斂＋P1 七項、建議收件匣、待處理佇列說謊六修 | `4736127` `240c4cb` |
| 2026-07-31 | 知識卡啟用開關＋有效期限、併發子保溫 | `a47d40d` `fc591f4` |
| 2026-07-30 | PAYUNi 特店送件補件（品牌統一 MiniMe、改價）、幕後 Token 續扣 P1 | `c510965` `c5d61cf` |

更早的完成項目請看 `git log`（366 個 commit）。

---

## 怎麼維護這份

1. **每次工作結束前**，把動到的東西寫進對應區塊：新開工 → `進行中`；commit 完 → 從 `進行中` 搬到 `完成`（補 commit hash）；發現新事情 → `待辦`。
2. **狀態要對得上 repo 實況**：`DOING` 必須真的在 `git status` 看得到；`DONE` 必須真的在 `git log` 查得到。不確定就寫 `DEPLOY?`，不要猜「已上線」。
3. **一句話寫清楚「為什麼」**，不要只寫做了什麼——三個月後只有 why 有用。
4. 細節規格不要塞進這裡，放 `docs/` 專門文件，這份只放指標。
5. 同步到 Notion 時，三個區塊各對一個 view；`狀態` 欄直接對 Notion 的 select 屬性。
