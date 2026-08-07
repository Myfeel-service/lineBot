# 開通引導對話 agent — 設計規劃(2026-08-07)

> 目標:新客戶第一次登入,由 agent 用「聊天」的方式帶完所有必要設定,終點是 `docs/TODO.md` item 17 早就寫好的魔法時刻——**接上 LINE → 用手機傳一句話 → 看到訊息進到後台**。互動示意(可點擊)另見 artifact「開通引導對話 agent」。
>
> **狀態:Phase 1 已於 2026-08-07 實作完成(未 commit、未部署),實作紀錄見 §8。**

## 1. 現況與落差

| # | 現況 | 落差 |
|---|------|------|
| 1 | `/admin/onboarding`(`layout:false`)只收一個 `workspaceName` 就結束 | 之後把人丟去 `/settings/organization` 自己面對 5 個 LINE 憑證欄位,新手在最難的一步孤立無援 |
| 2 | `TutorialAgent` 是被動元件(等你主動點 FAB),且 onboarding 頁根本沒掛它 | 第一次登入的關鍵時刻,agent 缺席 |
| 3 | 後台 chat agent(`server/utils/ai-admin-agent.ts`)全部唯讀;`AdminAgentChat.vue` 只會渲染純文字 | 沒有「結構化訊息渲染層」(輸入框/按鈕/複製卡/檢查卡),聊天帶填寫做不起來 |
| 4 | `setup-status` 必要訊號只有 `lineConnected` + `aiEnabled`;webhook 通不通、`handoffNotify` 只活在 alerts 裡 | 「能上線」的完整判定散在兩套系統 |

## 2. 釘死的原則(沿用新手教學 agent 的既有決策)

1. **完成判定永遠來自後端真實訊號**;劇本/LLM 只「轉述」狀態,不「判斷」狀態。
2. **Phase 1 純劇本式狀態機、零 LLM**——對話感來自 UI,不來自模型。憑證輸入絕不經過 LLM。
3. **寫入一律沿用既有端點與權限**:`PUT /api/admin/line-workspace`(admin)、`PUT /api/ai/settings`(`ai.settings.write`)、`POST /api/onboarding/self-serve`。精靈不開新的寫入後門。
4. **每一步可跳過**,不會卡死;**續走(resume)由訊號重算**——currentStep = 第一個未完成的必要訊號,不存「進行到第幾步」這種會說謊的狀態。

## 3. 體驗流程(golden path)

| 步 | 對話做什麼 | 使用者動作 | 幕後 API / 訊號 |
|----|-----------|-----------|----------------|
| 0 | 歡迎:自我介紹+預告要做的四件事(接 LINE→測試→開 AI→完成)、約 10 分鐘 | 「開始吧」/「先自己逛逛」 | — |
| 1 | 幫工作區取名 | 聊天輸入框打字 | `POST /api/onboarding/self-serve` → 建 org+workspace+系統模組 |
| 2 | 問「有 LINE 官方帳號了嗎?」 | 按鈕二選一;沒有→給申請連結卡,回來按繼續 | — |
| 3 | 要第一把鑰匙:Channel Access Token(附「怎麼拿?」展開教學) | 聊天內嵌遮罩輸入框貼上 | `PUT /api/admin/line-workspace`(partial,只寫該欄) |
| 4 | Channel Secret(同上) | 同上 | 同上 |
| 5 | LIFF ID(選填)。**已拍板:拆出「接 LINE」必要判定,改列加分項**;精靈保留這步但一鍵可跳過,文案講明「之後辦活動再補」 | 貼上或「先跳過」 | 同上;`defaultLiffId` 自 `lineConnected` 判定拆出,新增獨立 optional 訊號 `liffReady` |
| 6 | 給 Webhook URL 複製卡,教他貼去 LINE Developers 並開 Use webhook | 複製→貼→回來按「幫我檢查」 | 沿用 `verifyWebhookOnSave`/`compareWebhookUrl` 真打 LINE API,檢查卡顯示真實結果 |
| 7 | **魔法時刻**:請他拿手機加自己的 OA 好友、隨便傳一句話;等待卡輪詢 | 用手機傳訊息 | 新訊號 `firstMessageReceived`(見 §4.4);收到→**回顯那句話的內容與時間** |
| 8 | 開 AI:建議先「草稿模式」(AI 擬稿、人按送出),穩了再切全自動 | 按鈕二選一 | `PUT /api/ai/settings {enabled:true, replyMode}` |
| 9 | 問商店網址(說詞:沒填的話價格類問題整條死——`AI-KB-AUDIT-20260731` 實證) | 輸入或跳過 | `PUT /api/ai/settings {shopUrl}` |
| 10 | 轉真人要通知誰。**已拍板:不自動綁「第一句話的傳送者」**,改**引導式選人**:聊天內嵌選人器(沿用 ai-settings 既有選人器),列出官方帳號好友讓使用者主動選——開通當下清單通常只有剛加好友的老闆自己,體驗一樣順,但選擇權在人 | 從清單選人或跳過 | `PUT /api/ai/settings {handoffNotify:{enabled:true, lineUserIds:[…]}}` |
| 11 | 完成摘要卡(✓ 清單+跳過項)+加分項導流(知識庫/腳本)+交棒:「之後有問題按右下角的我」 | 進入後台 | 健康卡紅點接手盯跳過項 |

## 4. 架構

### 4.1 前端

- `/admin/onboarding` 整頁改造成對話式(保持 `layout:false` 全螢幕);workspace 建立後**不再導走**,同一場對話繼續接 LINE。
- 新元件層 **`AgentMessageRenderer`**:結構化訊息渲染(schema 見 §4.3)。這層就是 `docs/ASSISTANT-AGENT-EVAL-20260806.md` 方向 D 明寫缺的「訊息格式+渲染層」,Phase 3 的後台 agent 深連結/代辦直接複用。
- 泡泡樣式沿用 `_tutorial-agent.scss` 既有 class(`.aa-` 前綴),新樣式進 SCSS partials,不寫 `.vue <style>`。
- **已有 workspace 但必要項未完成**:TutorialAgent 健康卡加「繼續完成開通」入口→同一劇本,訊號驅動從第一個未完成處接續(在 `/admin/{wid}/setup` 或彈全螢幕層,擇一)。

### 4.2 劇本引擎

宣告式 steps(仿 `tutorial-topics.ts` 的手法):每步宣告訊息、輸入型態、驗證、寫入呼叫、完成訊號。runner 是純前端狀態機。

### 4.3 訊息 schema(渲染層的合約)

```ts
type AgentMsg =
  | { kind: 'text';    html: string }
  | { kind: 'help';    summary: string; steps: string[] }        // 「怎麼拿?」展開教學
  | { kind: 'link';    label: string; href: string }
  | { kind: 'copy';    label: string; value: string }            // Webhook URL 複製卡
  | { kind: 'check';   probe: ProbeId; pendingText: string; doneText: string } // 真訊號輪詢卡
  | { kind: 'summary'; items: { label: string; done: boolean }[] }

type AgentAsk =
  | { kind: 'choices'; options: { label: string; value: string }[] }
  | { kind: 'input';   field: string; inputType: 'text'|'secret'|'url';
      validate?: RegExp; skippable?: boolean; placeholder?: string }
```

### 4.4 與既有 agent 的整合(關鍵架構決策)

現在 repo 裡其實已有**三個 agent 形狀的東西**,開通引導是第四個場景,不是第四套系統:

| 既有物 | 本質 | 開通引導跟它的關係 |
|--------|------|-------------------|
| `TutorialAgent.vue`(右下角 FAB 三分頁面板) | 訊號驅動的健康摘要+教學入口,**被動** | 同一個「小幫手」人設與語氣;共用 `useSetupStatus` 訊號、`_tutorial-agent.scss` 泡泡 class;開通結束**交棒**給它(跳過項由健康卡紅點盯) |
| `AdminAgentChat.vue` + `runAdminAgentChat`(問助理) | **LLM** 對話,8 個唯讀工具,純文字渲染 | **不是同一個東西**——開通引導 Phase 1 零 LLM。共用的是新渲染層;Phase 2 起「我卡住了」才把它接進來(唯讀、context 塞 setup-status) |
| `useTutorial` + `tutorial-topics.ts`(el-tour 導覽引擎) | 宣告式劇本+頁面高亮 | 手法直接沿用(宣告式 steps);開通完成後的加分項導流可直接 `startTopicById('knowledge')` 接既有 tour |

**整合原則:一個渲染層、兩種 driver。**

```
                ┌─ 劇本 driver(狀態機,零 LLM)──── 開通引導、未來的固定流程精靈
AgentMessageRenderer ┤
(AgentMsg schema)    └─ LLM driver(runAdminAgentChat)── 問助理、Phase 3 代辦
```

- 渲染層是**合約**(§4.3 schema),driver 可換:劇本 driver 產出的訊息和 LLM driver 產出的訊息,長一樣、渲染一樣。
- 這樣 Phase 3「後台 agent 從查到做」不用再發明訊息格式——LLM 回 `{kind:'check'}`/`{kind:'choices'}` 就能在問助理分頁渲染出確認按鈕,正是 ASSISTANT-AGENT-EVAL 方向 D 缺的那層。
- **為什麼開通不直接用 LLM agent 做**:①憑證不能過 LLM;②完成判定必須是真訊號(釘死原則);③開通是固定線性流程,LLM 只會帶來不確定性,它的價值在「卡住時的自由問答」(Phase 2)。

**檔案級調整清單(Phase 1)**:

| 動作 | 檔案 | 說明 |
|------|------|------|
| 新增 | `shared/types/agent-messages.ts` | `AgentMsg`/`AgentAsk` schema(前後端共用,Phase 3 LLM 工具也用它) |
| 新增 | `app/components/agent/AgentMessageRenderer.vue` | 渲染層;樣式沿用 `.aa-` class、新樣式進 SCSS partials |
| 新增 | `app/utils/onboarding-script.ts` | 宣告式劇本 steps(仿 `tutorial-topics.ts`) |
| 新增 | `app/composables/useOnboardingChat.ts` | runner 狀態機+訊號 resume |
| 改造 | `app/pages/admin/onboarding.vue` | 表單→對話頁;保留 self-serve POST;**加 `?workspaceId=` 模式**:帶參數=跳過建立步、從第一個未完成訊號接續(老 workspace 續走用) |
| 擴充 | `server/api/admin/setup-status.get.ts` + `shared/types/setup.ts` | 加 `firstMessageReceived` 訊號+`SETUP_LABELS`;`defaultLiffId` 拆出 `lineConnected` 判定、新增 optional 訊號 `liffReady`(chat 工具 `get_setup_status` 自動受益) |
| 擴充 | `app/composables/useSetupStatus.ts` | 註冊表加該 capability |
| 小改 | `TutorialAgent.vue` 健康卡 | 必要項未完成時加「繼續完成開通」按鈕 → `/admin/onboarding?workspaceId={wid}` |
| 不動 | `ai-admin-agent.ts`、firestore rules/index | Phase 1 完全不碰 LLM 管線 |

### 4.5 後端

- **沿用**:`POST /api/onboarding/self-serve`、`PUT /api/admin/line-workspace`(partial+`verifyWebhookOnSave`)、`PUT /api/ai/settings`。
- **新增一個訊號 `firstMessageReceived`**:查該 workspace 有無任一 inbound 訊息(單欄位查詢免索引;照 `setup-status.get.ts` 手法 try/catch 降級 `unknown`)。建議直接擴 `SetupCapabilityId`——健康卡同時受益;`SETUP_LABELS` 記得同步(chat 工具 `get_setup_status` 共用)。
- **`lineConnected` 判定改兩欄**(token+secret);`defaultLiffId` 拆出為獨立 optional 訊號 `liffReady`(2026-08-07 拍板)。注意既有健康卡文案與 `SETUP_LABELS` 同步改。
- 輪詢:等待卡 3–5 秒輪 `setup-status`,要帶 `force` 繞過前端 60s TTL 節流。
- **免新索引、免改 firestore rules**(判定唯讀、寫入走既有端點)。

## 5. 分期

| Phase | 內容 | 估 |
|-------|------|----|
| **1(MVP)** | 對話式精靈整頁+`AgentMessageRenderer`+劇本引擎+`firstMessageReceived` 訊號+訊號 resume+健康卡「繼續完成開通」入口。**零 LLM。** | 4–6 工作天 |
| **2** | 每步 inline help 補圖文(LINE Developers 截圖);「我卡住了」→ LLM 自由問答(唯讀,複用 `runAdminAgentChat`,system context 塞 setup-status JSON、禁止臆測) | 2–3 天 |
| **3** | 後台 agent 從「查」到「做」:write tools+聊天內確認步驟(對齊 ASSISTANT-AGENT-EVAL S2;腳本引擎動作累積器是現成底座)。渲染層 Phase 1 已建好,直接受益 | 另案 |

## 6. 拍板紀錄(2026-08-07 老闆決議)

1. **非 admin 成員入口**:✅ 照建議——顯示「請管理員完成接線」+開放教學分頁,不給假按鈕。
2. **LIFF ID**:老闆問「容易 skip 或你建議怎麼做」→ **採兩者並行**:(a) `defaultLiffId` 從 `lineConnected` 必要判定拆出,改獨立加分項訊號 `liffReady`——只做「容易跳過」不拆判定的話,跳過的人會永遠掛「LINE 未接通」、resume 每次都卡回 LIFF 這步;(b) 精靈保留這一步但一鍵可跳過,文案講明「之後辦活動再補」。
3. **handoffNotify**:❌ 不用「自動綁第一句話傳送者」。改**引導式選人**:聊天內嵌選人器(沿用 ai-settings 既有選人器),列出官方帳號好友讓使用者主動選——開通當下清單通常只有剛加好友的老闆自己,體驗一樣順,但選擇權在人。
4. **跳過項提醒**:✅ 只交健康卡紅點,不另外推播。

## 7. 風險與防守

- **多租戶**:文案不寫死品牌/網址;Webhook URL 用 runtime `publicBaseUrl`(`PUBLIC_BASE_URL`)。
- **憑證安全**:secret 型輸入遮罩顯示、不落任何 log(含 `adminAgentLogs`)、不進 LLM。
- **權限**:寫入步只對 owner/admin 開;viewer/agent 進來看到唯讀版。
- **別在 Phase 1 偷加 LLM 判斷**——「LLM 說你設好了」而實際沒設好,信任一次崩完(釘死原則 §2-1)。
- **`/admin/onboarding` 的 auth middleware 放行清單**(`app/middleware/auth.ts`)已存在,改頁時別弄丟。
- 第一則訊息輪詢注意 visibilitychange:頁面在背景時停輪(照 TutorialAgent 既有做法)。

## 8. 實作紀錄(2026-08-07,Phase 1 完成)

**驗證**:`nuxt typecheck` 我方檔案 0 錯(同日有另一條「統計簡化」工作線在改 kpi/conversation-stats,那邊的 `unhandledSamples` 紅字不是本功能的);vitest 969 測試全綠;dev server 煙霧測試(first-message/setup-status 未登入回 401、/admin/onboarding 回 200)。**尚未實機走完整流程**(需真 LINE 憑證),上線前建議用測試 OA 走一遍 golden path。

### 新增檔案
| 檔案 | 內容 |
|------|------|
| `shared/types/agent-messages.ts` | AgentMsg 7 種(text/help/link/copy/status/highlight/summary)+AgentAsk 4 種(idle/choices/input/picker)+escapeHtml。**LLM driver 未來直接回這些型別即可長按鈕** |
| `app/components/agent/AgentMessageRenderer.vue` | 訊息渲染層(一則一實例) |
| `app/components/agent/AgentAskDock.vue` | 輸入區:按鈕列/輸入框(secret 遮罩)/選人清單 |
| `app/composables/useOnboardingChat.ts` | 劇本＋狀態機(**劇本沒拆去 utils,單檔含 say/ask 原語＋步驟函式**);每步自我檢查已完成就靜默跳過=訊號 resume;跳過記 localStorage `onb-skips:{wid}` |
| `server/api/admin/onboarding/first-message.get.ts` | 見證時刻專用:回 `{received, text, messageType, at}`,回顯那句話。**與 setup-status 拆開的理由**:健康卡高頻輪詢只要 done/incomplete,這支要多讀訊息子集合拿內容,只有精靈等待卡在打 |
| `app/assets/scss/components/_agent-chat.scss` | agm-/agd- 樣式(main.scss 已 @use) |

### 修改檔案
| 檔案 | 內容 |
|------|------|
| `shared/types/setup.ts` | SetupCapabilityId 加 `liffReady`+`firstMessageReceived`;SETUP_LABELS 同步(chat 工具自動受益) |
| `server/api/admin/setup-status.get.ts` | lineConnected 改兩欄(token+secret);liffReady 拆出(共用同一次 doc read);firstMessageReceived=掃 conversations 前 20 筆看 `lastPeerActivityAt`(**traceOnly 加好友不會蓋這欄位=加了好友沒開口不算**;equality-only 免索引) |
| `server/api/admin/org/[orgId]/overview.get.ts` | lineConnected 口徑同步改兩欄 |
| `app/composables/useSetupStatus.ts` | 註冊表加 liffReady(optional);**firstMessageReceived 刻意不進註冊表**——沒有側欄入口可給缺項巡覽指 |
| `app/pages/admin/onboarding.vue` | 表單→對話頁;`?workspaceId=` 續走模式(頁面自驗角色,middleware 不管這條路);非 admin 顯示「請管理員完成接線」卡 |
| `app/components/TutorialAgent.vue` | 健康卡加「用聊天引導完成開通」按鈕(`ta-gaptour--onboard`,incompleteRequired>0 才顯示) |
| `app/pages/admin/[workspaceId]/settings/organization.vue` | ⚠️ **配套鬆綁**:label「必填」→「選填」+ save() 拿掉「沒填 LIFF 不給存」硬驗證——否則精靈跳過 LIFF 的人回這頁改 Token 會被卡死 |
| `app/utils/tutorial-topics.ts` | organization tour 的 LIFF 步驟標題同步改選填 |
| `app/assets/scss/pages/_onboarding.scss` | 加 onbc- 對話頁外殼樣式(舊 onb- 卡片樣式保留給「請管理員」卡) |

### 實作時的關鍵決定(規格沒寫死的部分)
1. **firstMessageReceived 探針選 `lastPeerActivityAt`** 而非 lastDirection:AI/歡迎模組會秒回,lastDirection 立刻翻成 outgoing,會把「收過訊息」誤判成沒收過。
2. **等待卡與「先跳過測試」用 Promise.race**:輪詢(4 秒、背景分頁不打)先到就收掉按鈕,按鈕先到就停輪詢。
3. 免新索引、免改 firestore rules、免部署排程——**部署零額外動作**(兩租戶照常 deploy 即可)。

### 未做(續 Phase 2/3)
- 每步 inline help 的 LINE Developers 截圖;「我卡住了」→ LLM 唯讀問答。
- `/admin/{wid}/line-settings` 舊 redirect 與 workspaces 頁「我想開始使用」文案未動(入口行為不變)。

### 8.1 UI/UX 審查修正(2026-08-07 第二輪,13 項)

依 ui-review 七維度審完後修畢(typecheck 0 錯、sass 編譯過、981 測試綠):

**P0 誠實度**:①成績單改「查不到就不出成績單」(重試/直接進後台兩出口),不再把剛做完的事顯示成沒做 ②申請官方帳號連結從日本入口改台灣(tw.linebiz.com/entry) ③Webhook 檢查失敗依後端訊息分流建議——401/查詢失敗→「可能 Token 貼錯」+當場**重貼 Token** 出口(reenterToken);網址不一致→重貼網址;其他→存檔/開關。

**P1 步驟**:④**LIFF 搬到魔法時刻之後**(加分區開頭)——選填項不再延後高潮,主線變成 鑰匙→接線→見證→開AI ⑤三張 help 卡+Webhook 步都加了可點的 LINE Developers 連結(schema help 加 href/hrefLabel) ⑥續走模式先靜默驗一次 Webhook,之前接好的人直接跳到測試(preVerify) ⑦好友清單截斷時(≥8)先講「不在清單裡就跳過、去 AI 設定用完整搜尋」 ⑧「之後再說」在帳號建好後改直接進新帳號後台(composable 匯出 activeWorkspaceId)。

**P2 語意**:⑨「工作區」→「官方帳號」統一用語 ⑩開場文案改「一共四步…跟進度條一格一格對得上」 ⑪status 加中性 `skipped` 狀態(灰色 Remove 圖示),略過測試不再穿警告色。

**P3 像素**:⑫`.agd` 內歸零 Element Plus `.el-button + .el-button` 預設 margin(否則疊上 gap 變 8 vs 20px 不均) ⑬`.agd__picker` 直欄 stretch 會把「先跳過」text 按鈕拉滿版→`align-self: center`(房規常見坑第一條)。
