# UI/UX 審查待辦（依優先順序）— 🗄️ 已封存，僅供追溯理由

> # 🗄️ 本檔已封存（2026-08-12）——**不要在這裡新增或勾選項目**
>
> **還活著的項目已併入 [`docs/STATUS.md`](./STATUS.md) 並取得永久編號**（2026-08-12 老闆拍板全部記錄待辦）：
>
> | 本檔位置 | 現編號 |
> |---|---|
> | R4 全站沒有手機版（item 4） | `E-13` |
> | 打磨批次：flow 存檔定位殘項(26)、輪播 380px(27)、richmenu 按兩次(28 殘項)、死碼清理殘項(34)、裝飾 emoji(35 殘項)、scoped 樣式(36)、統計卡三套(37)、flow 打磨(40)、匯入對話框(41)、landing select 預設值(10 殘項) | `E-14` |
> | 手機導覽找不到「登入」（item 11） | `E-15` |
>
> **檔內沒勾但其實已解**（2026-08-12 逐條驗證）：
> - item 6 假 Demo 表單：**7/20 自助導購那批已修**（真 POST `/api/leads`＋honeypot＋聯絡方式必填），本檔比修復早一天定稿所以沒記到。
> - item 10 大半解（聯絡方式必填＋honeypot；殘「select 無空白預設」併入 `E-14`）。
> - item 5 的 `.btn-danger`：文字已是 `var(--color-error)` 紅（R1 生效），「近黑字」已不成立。
> - item 38 無障礙：三個子項全勾，父項忘了勾＝實質完成。
>
> ⚠️ 底下的勾選框一律不可信，狀態只看 `STATUS.md`。檔頭原寫「commit 到 billing-anchored-period」
> ——那是 7 月的工作分支，早併回 `main`。**本檔保留的唯一價值是每一項的「為什麼、修法、殘留」說明。**

> 建立：2026-07-16。審查範圍：全 30 頁（入口/登入/超管/LIFF、核心營運、AI 客服、Flow/圖文選單、設定/計費/組織）。
> 進度：已完成 R1、R2、R3、R5、item 7、8、9、12、13、14、15、16、17、18、19、20、21、22、23、24、29、30、31、32、33、38、39、42，
> item 26/28/34 部分。**所有 greenlit 項目（②④⑥⑦⑧）已全數完成**。每批皆 `nuxt typecheck`（配色/SCSS 另用 sass CLI）通過，均已 commit 到 billing-anchored-period。
> ⚠️ R1＋item42 是全站配色變更，建議實機目視一次。
> 排序原則：**先修「一改就同時修好很多頁」的根因**，再修「會流失名單／誤刪心血」的，
> 再修「明顯瑕疵與一致性破綻」，最後才是打磨。
> 標記：`[ ]` 未做、`[x] ✅` 已完成。UI＝畫面美感/視覺一致，UX＝流程順暢/資訊清楚。

---

## 📌 使用者決策紀錄（2026-07-17）

- **延後不做（先記著）**：① landing 假 Demo 表單（P0，待你決定 lead 去向）、③ 手機版 RWD、⑤ emoji→SVG 圖示，以及所有「打磨」項（⑨⑩⑪⑫⑬）。
- **方向拍板**：門面/入口頁（landing、login、選帳、死路頁）**延續 MYFEEL 綠、統整成共用品牌樣式**；**後台維持單色**（R1 不變）。品牌名走 `runtimeConfig.public.brandName`（多租戶可覆寫，預設 MYFEEL），不寫死。
- **已 greenlight，全部完成**：② 門面綠統整＋login、④ flow 即時預覽、⑥ LIFF 錯誤頁、⑦ 發票硬擋、⑧ flow 錯誤第幾則。

### 🎨 2026-07-19 增修（美感／主色延伸）
- **主色（品牌綠）延伸進整個後台**（用 `artifact-design` 標準檢視後）：`element-variables.scss` 的 `--el-color-primary` 與 `core/_variables.scss` 的 `--color-line` 由近黑 → 品牌綠 #06c755（按鈕／active／focus／邊框全走綠），hover `#04a046`、tint `rgba(6,199,85,.16)`。8 處 active/連結/hover 文字改用可讀深綠 `--brand-green-text: #067a3a`（AA 對比，避免亮綠當文字失效）。中性色與正文維持灰階；語意狀態色（success/warning/danger/info）不受影響、與主色分開。
- **flow 機器人預覽 UX 升級**：加 LINE 風聊天標題列（頭像＋OA 名，`currentWorkspaceName`）、底部假輸入列、圖示化空狀態；編輯器頂端加「🔽 隱藏／👁 顯示預覽」切換。
- 驗證：`sass` CLI ＋ `nuxt typecheck` ＋ **完整 `nuxt build` 皆通過**；建議實機目視配色。

---

## 🔑 第 0 順位 — 五個根因（最高槓桿，先修這五項會一次消掉下面約半數單頁項目）

1. [x] ✅ **狀態色被灰階化（R1）** — UI　（2026-07-17 完成；方向＝狀態保留彩色）
   - `element-variables.scss`：primary 維持近黑單色，但 success/warning/danger/info 的 base 由灰改回
     語意彩色（#16a34a 綠 / #d97706 橙 / #dc2626 紅 / #2563eb 藍）→ 所有 el-tag / el-alert /
     danger 按鈕 / el-switch 等狀態元件重新有顏色（付款、訂閱、角色、對話狀態、KPI…一次解決）。
   - `core/_variables.scss`：`--color-success/warning/error/info` 同步改為對齊的彩色 →
     自訂 `.badge-*`、`.text-success/danger`、`.btn-danger`（順帶變真紅）也恢復顏色。
   - 已用 `sass` CLI 驗證兩檔皆編譯通過。**建議實機再目視一次配色**（我在此環境無法算繪顏色）。
   一次解決 item 15/19(色彩部分)/24；殘留 item 42（清掉散落的舊綠/藍/紫）另計。

2. [x] ✅ **確認框兩套並行、破壞性動作保護不足（R2）** — UX　（2026-07-16 完成）
   已把 13 處原生 `confirm()` 全部改為 `ElMessageBox.confirm` + `confirmButtonClass: 'el-button--danger'`
   （campaigns/auto-reply/support-presets/richmenu/flow 刪除、broadcasts 取消、members/super 移除、
   organization 清憑證、super 停用組織、super 授予/撤銷 Super Admin）。`useUnsavedChanges.ts` 的
   `window.confirm` 刻意保留（beforeunload 同步守衛，ElMessageBox 為非同步無法替代）。
   **殘留**：授予 Super Admin 的「輸入 email 比對」更強二次確認尚未做（另列為加強項）。

3. [x] ✅ **觀察者（viewer）唯讀只做一半（R3）** — UX ＋ 權限漏洞　（2026-07-17 完成）
   6 頁（users/tags/campaigns/auto-reply/broadcasts/support-presets）全部：
   - 引入 `const { canOperate, assertCanOperate } = useAdminOperateGuard()`。
   - 每個寫入函式（submit/delete/sync/batch/addTag/removeTag/saveDraft/confirmSchedule/confirmSendNow/cancel）開頭加 `assertCanOperate()`（防呆＋提示）；broadcasts 的自動輪詢 `processDueScheduledBroadcasts` 用靜默 `canOperate.value` 擋。
   - 所有寫入鈕（新增/儲存/刪除/批次/同步/移標✕）加 `v-if="canOperate"`，對 viewer 直接隱藏（符合「無權限一律隱藏」）。
   `nuxt typecheck` 通過。

4. [ ] **全站沒有手機版（R4）** — UX/UI　→ **STATUS `E-13`**
   `.layout-wrapper` 固定 flex + 240px 側欄 + `overflow:hidden`，**無漢堡、無抽屜**（grep 全站無 toggle/drawer/collapse）；
   41 個 SCSS 只有 10 個有 media query。兩大編輯器（flow/richmenu）拖曳只綁 `mousedown` + window `mousemove`
   （`useAreaEditor.ts:272`，無 pointer/touch），觸控裝置完全無法操作、且無「請用電腦」提示。
   **修法**：≤900px 時側欄改抽屜 + 頂部漢堡；編輯器改 pointer events，或在窄寬顯示攔截提示；
   LIFF 頁（手機 webview）另見第 21 項。

5. [ ] **殘留樣式與未定義 class（R5）** — UI　（部分完成）
   - [x] ✅ `.badge-yellow` / `.badge-purple` **已補定義**（`_badges.scss`），不再渲染成無底透明。
   - [x] ✅ `.btn-secondary:hover` 白邊 `rgba(255,255,255,.15)` **已改** `var(--border-active)`。
   - [ ] `.btn-danger` 仍是 `rgba(0,0,0,.1)` 底 + 近黑字 → **危險按鈕不像危險**（待 R1 狀態色 token 一起給真紅）。
   - [ ] 殘留非灰階舊色未清：綠 `rgba(6,199,85)`（flow 拖放暈影、layout active）、藍 `#8bb6ff`（版型縮圖框）、
     藍 `#eef3fb`/`#1f5fae`（對話頁 active）、紫 `#9b59b6`（stats handoff）、綠 fallback `#0f7b54`/`#06c755`（見第 42 項）。

---

## 🔴 第 1 順位 — 立即修（名單流失／不可復原誤刪）

6. [x] **Landing 預約 Demo 表單是假的** — UX　`pages/index.vue:367`　（✅ 7/20 自助導購批次已修：真 POST `/api/leads`＋honeypot；2026-08-12 驗證）
   `@submit.prevent="submitted = true"` 只設本地變數、**沒有任何 API 送出**，卻立刻顯示
   「收到了！我們會在 1 個工作天內聯繫」。所有 hero/pricing/CTA 都導到這張表單
   → **每一筆潛在客戶都石沉大海，還被告知已收到。**
   **修法**：接真正的 lead 端點（或至少 mailto/第三方表單），送出失敗顯示錯誤而非假成功。

7. [x] ✅ **flow 刪整卡/整欄無確認無 undo** — UX　（2026-07-16 完成）
   `removeMessage`（訊息卡 ✕）與新增的 `removeColumn`（輪播欄 ✕，取代 3 處 inline `msg.columns.splice`）
   都改為 `ElMessageBox.confirm` + danger。
   **殘留**：單一按鈕/快速回覆的小 ✕ 刻意不加確認（易重建、加確認反而擾民）；如要更保險可改做 undo toast。

---

## 🟠 第 2 順位 — 盡快改（明顯瑕疵／一致性破綻／關鍵資訊看不清）

### 跨頁共通
8. [x] ✅ **結束會話無確認** — UX　（2026-07-16 完成）：`AdminPanel.closeSelectedSession` 加上 `ElMessageBox.confirm`（並說明「下次來訊視為新會話」）。
9. [x] ✅ **字面 `**markdown**` 外洩** — UI　（2026-07-16 完成）：knowledge/sources 三處 hint 的 `**…**` 已改成 `<strong>…</strong>`。

### index.vue（Landing）
10. [ ] 表單 `novalidate` 且無驗證，姓名/聯絡方式可全空白送出仍成功；聯絡方式欄 `type="text"` 手機不跳對應鍵盤 — UX。
    附帶：`<select>` 產業別/需求無空白預設（初值「電商/客服回不完」），不動就送出會汙染名單資料。
11. [ ] 手機導覽列「登入」`display:none`（_landing.scss:339）且不在漢堡選單內 → 手機上完全找不到登入 — UX。（2026-08-12 重驗仍在：漢堡選單有了但登入沒進選單）→ **STATUS `E-15`**
12. [x] ✅ sticky nav 68px 遮住錨點標題 — UI　（2026-07-16 完成）：`.lp` 各錨點區加 `scroll-margin-top: 80px`。

### login.vue
13. [x] ✅ **品牌斷層（門面綠統整）** — UI　（2026-07-17 完成）：
    - 新增全站共用品牌綠 token `--brand-green*`（core/_variables.scss）。
    - landing 的 `--g*` 改為 reference 這組 token（同值、lossless）→ 門面頁同一套綠色來源。
    - login 改綠：logo 綠漸層、連結/裝飾綠、修 btn-google hover 白邊；標題改 `brandName`（`runtimeConfig.public.brandName`，多租戶可覆寫、預設 MYFEEL），不再硬寫「LINE Bot 管理系統」。
    - 選帳頁 accent 由黑改綜色（`--brand-green-deep`）。後台維持單色不受影響。
14. [x] ✅ login 錯誤顯示 Firebase 英文技術訊息 — UX　（2026-07-17 完成）：常見錯誤碼映射為繁中友善訊息；使用者關掉/取消登入視窗（popup-closed-by-user/cancelled-popup-request）不再顯示紅字。

### billing / org 帳務
15. [x] ✅ 付款狀態、藍新導回結果（成功🎉/失敗）灰階下同色 — UI　（2026-07-17 由 R1 解決）：付款 el-tag（paid 綠/failed 紅/pending 橙/expired 藍）與導回結果 el-alert 恢復彩色。
16. [x] ✅ billing 初次載入無骨架 — UX　（2026-07-17 完成）：在方案卡與「未開通」之間加 `v-else-if="loading"` 載入骨架（spinner＋「載入方案資訊…」），付費客戶不再於資料到位前先看到「尚未開通」。
17. [x] ✅ `AdminInvoiceProfileForm` 無格式驗證 — UX　（2026-07-17 完成）：加即時 inline 驗證（統編 8 碼數字、Email 格式、手機條碼「/」+7 碼、捐贈碼 3–7 碼數字、載具/捐贈碼互斥），錯格式當場紅字提示。**並硬擋儲存**：表單以 `update:valid` 對外回報，billing／org 兩頁的「儲存」鈕在格式錯誤時停用（item 7）。

### settings（members / organization）
18. [x] ✅ 角色下拉 `@change` 即改權限無確認 — UX　（2026-07-17 完成）：changeRole 前加 `ElMessageBox.confirm`（顯示要改成的角色）；取消時因 `:model-value` 單向綁定自然回復原值。
19. [x] ✅ webhook/角色色彩＋成員頁收尾 — UI/UX　（2026-07-17 完成）：色彩由 R1 恢復；members 標題長文字牆精簡為一句、el-table 補 `empty-text="尚無成員，點右上「邀請成員」新增"`。

### org/[orgId]
20. [x] ✅ org 分頁狀態未進 URL — UX　（2026-07-17 完成）：`tab` 由 `?tab=` 初始化並 `watch` 寫回（`router.replace`），重整/分享連結不再掉回總覽。

### AI 客服
21. [x] ✅ knowledge/sources **「新增單張手寫卡」無入口** — UX　（2026-07-17 完成）：sidebar header 補「✍️ 手寫」按鈕接 `openCreateManual`（guard `canEditKb`）。
22. [x] ✅ 「全部重新索引」藏在無文字 `🔁` emoji 鈕 — UX　（2026-07-17 完成）：改為「🔁 重建索引」有文字，與「🔄 重新同步」不再混淆。
23. [x] ✅ ai-scripts 關頁不提醒 — UX　（2026-07-17 完成）：`useUnsavedChanges` 補 `enableBeforeUnload: true`，F5/關分頁會攔；（刪除的原生 confirm 已於 R2 一併改為 ElMessageBox）。
24. [x] ✅ playground 五態區塊、ai-usage KPI 卡、ai-scripts 節點徽章灰階下只靠 emoji — UI　（2026-07-17 由 R1 解決）：el-color 與 badge 色恢復後自動有顏色。

### flow / richmenu（兩大編輯器）
25. [x] ✅ **LINE 訊息即時預覽（item 4）** — UX　（2026-07-18 完成）：新增 `FlowMessagePreview.vue`（`components/flow/`）+ `_flow-preview.scss`，編輯器右側加一欄仿 LINE 聊天預覽，隨編輯即時更新。涵蓋全部 10 種型別：text（純氣泡/按鈕卡）、image、video、richMessage/richMessageRef（imagemap 大圖＋版型區塊 overlay，用 `PRESET_BOUNDS_PCT`/custom bounds）、carousel、imageCarousel、flexImageCarousel（比例用 `line-image-spec` 換算）、quickReply（氣泡＋膠囊列）、userInput。≤1100px 自動收起。`sass`＋`nuxt typecheck` 皆過；**建議實機目視一次**。
26. [ ] （部分完成）flow 存檔驗證定位 — UX：
    - [x] ✅ 存檔錯誤現在會帶「第 N 則」位置（`validateMessages` 每則包 IIFE，回傳自動加前綴；圖文訊息另已帶「區塊 X」）(item 8)。
    - [ ] 尚未做：輪播「第 M 欄」欄位級定位、自動捲動到出錯卡、inline 紅框、`AdminAreaActionEditor` 的 `errorMessage` 死碼（永不 render）。
27. [ ] 輪播卡固定 380px 造成「垂直捲動裡再包水平捲動」雙軸捲動、窄螢幕被裁 — UI（_flow.scss:223）。
28. [ ] （部分完成）— [x] ✅ richmenu 建立即刻部署到 LINE：`submitForm` 在建立時加「確認部署」ElMessageBox（提示會即時對所有好友生效）。[ ] 超界靠存檔自動修正並要求再送一次（逼按兩次）尚未改成即時 clamp。

### super-admin
29. [x] ✅ `/admin/super` 首頁**空白頁** — UI/UX　（2026-07-16 完成）：加了重導向 middleware 直接送到 `/admin/super/organizations`（未來若要做總覽 dashboard 再改回）。

### liff/lead.vue（LINE webview 內給消費者看）
30. [x] ✅ LIFF 消費者錯誤頁 — UX　（2026-07-17 完成）：診斷 JSON 改成只在 `?debug=1` 才顯示（消費者看不到內部資訊）；錯誤文案由「回後台重新儲存」改為「請聯繫這個官方帳號的商家」（對的對象）；補「重新整理再試」按鈕，不再卡死。

### 其他
31. [x] ✅ conversation-stats「匯出 CSV」無資料時靜默 — UX　（2026-07-16 完成）：按鈕加 `:disabled="!trend.buckets.length"`。
32. [x] ✅ users「從 LINE 同步好友」無進度顯示 — UX　（2026-07-17 完成）：新增 `syncProgress`，每輪更新「已處理 X 筆，剩約 Y 位」並顯示在同步鈕旁，大量好友時不再像卡死。
33. [x] ✅ broadcasts 側欄 **failed/cancelled/processing 全同一種灰** — UI　（2026-07-16 完成）：改用 `broadcastTone()`，failed→error、processing→warning、completed/scheduled→success、其餘 neutral。

---

## 🟡 第 3 順位 — 打磨（死碼清理／微調／無障礙）

34. [ ] **殘留死碼清理**（部分完成，稽核有高估）— UI：
    - [x] ✅ `_campaigns.scss` 的 `.cmp-stat-rate`（未用且帶錯誤綠 fallback）已移除。
    - [ ] `_auto-reply.scss`：**不是整批死碼**。`.ar-section-hint`/`.ar-status-switch`/`.ar-any-text-note`/`.ar-section-card` 其實**跨頁共用**（campaigns/organization/support-presets/flow）；只有舊版 layout 類（`.ar-layout`/`.ar-sidebar*`/`.ar-list*`/`.ar-editor(-inner/header/title)`/`.module-picker`/`.module-option*`/`.input-base`）疑似死碼，且與共用類交錯，需**逐類確認**後再動，暫緩。
    - [—] organization「清除憑證」區塊（`showClearStoredCredentials=false`）是**刻意的功能開關**（註解：「改為 true 即可顯示」），**非死碼**，保留。
    - [ ] `areaColors` 色盤在 richmenu 與 FlowRichMessageAreas 重複兩份 → 抽共用常數（待處理）。
35. [ ] （大致完成）**emoji 當功能圖示** — UI：
    - [x] ✅ 側欄導覽（default.vue 15 + super-admin.vue 3）改用 `@element-plus/icons-vue`。
    - [x] ✅ 頁首/區塊標題 emoji 全部移除（12 頁 SoloHeading + 8 個 split-sidebar-title + fem-header「回覆訊息」）→ 乾淨文字標題，iconography 由側欄 icon 承擔（避免重複）。
    - [ ] 尚未：按鈕上的 ➕/🗑️/📥 等小裝飾 emoji（半通用、影響小，屬第三波，可留可換）。`nuxt build` 通過。
36. [ ] **樣式散落 `<style scoped>`** — UI：AiContextBanner 大量 px 值寫在元件內，違反本專案「樣式放 partials + token」慣例 → 搬到 partial。
37. [ ] **重複元件抽共用** — UI：統計卡三套（el-card / .bc-stat-box / .cmp-stat-box）、表格兩套（el-table vs 手刻 table）→ 抽 stat-box、統一表格。
38. [ ] **無障礙**（部分完成）— UI：
    - [x] ✅ 漢堡鈕補 `:aria-expanded="menuOpen"`（index.vue）。
    - [x] ✅ 額度 `over` 由 `role="status"` 改為動態 `role="alert"`（AdminQuotaBanner）。
    - [x] ✅ LIFF：`.liff-lead-btn` 加 `min-height: 44px`（觸控目標）＋按鈕安全屬性；`.liff-lead` 根容器加 `role="status"` 與動態 `aria-live`（error=assertive），階段變化會被螢幕報讀。
39. [x] ✅ **對話框固定像素寬** — UI　（2026-07-17 完成）：全站 17 個 `width="Npx"` 對話框改為 `width="min(Npx, 92vw)"`，小螢幕不再頂滿/溢出。
40. [ ] **flow 編輯器打磨** — UI/UX：拖曳把手 `⠿` 對比過低、9 顆訊息類型按鈕同權重無主次、`{{...}}` 插入變數鈕語意不明且只附加到字串尾端、用戶輸入卡「必須放最後」只在存檔時驗證、達上限/互斥時按鈕不先 disable。
41. [ ] **匯入對話框** — UI/UX：虛線框暗示可拖放但沒綁 drop 事件、長輪詢（8 分鐘）無取消鈕。
42. [x] ✅ **殘留彩色收斂** — UI　（2026-07-17 完成）：
    - flow 拖放綠暈 → `--color-line-glow`（改單色，不再黑框＋綠暈雙訊號）。
    - LayoutPresetPicker 藍縮圖框 `#8bb6ff` → `--border-active`；active 綠暈 → `--color-line-glow`。
    - 對話頁 active/hover 藍 `#eef3fb` → `--bg-hover`、連結藍 `#1f5fae` → `--color-line`。
    - **定義 `--color-primary: var(--color-line)`** → 修好 6 處 `var(--color-primary, #0f7b54)` 殘留綠 fallback（plan-upgrade/workspaces/org-overview/login）。
    - 保留：`_landing.scss`/`_liff-lead.scss` 的 LINE 綠（刻意品牌色）、stats handoff 紫（post-R1 屬彩色狀態）、split-list-chip is-success 綠（正確的 status 色）；login 綠底歸 item 13 品牌決策。
    已用 `sass` CLI 驗證編譯通過。

---

## ✅ 已做得好（確認現況，值得保留，勿動壞）

- ai-settings 的**基本/進階分層**、模型欄位只給 super admin —— 過去痛點已解。
- knowledge 的切卡/reindex **5 秒輪詢自動刷新**、上傳改 signed URL 繞過 413、預覽改非同步 job 繞過 504、匯入結果列出失敗卡 —— 舊痛點已明顯改善。
- 額度 banner **正確手刻橘/紅語意色**並分 near/over 兩階（全站唯一把顏色做對的地方，可當 R1 的範本）。
- richmenu 畫布「色號＋編號對應」做得好。
