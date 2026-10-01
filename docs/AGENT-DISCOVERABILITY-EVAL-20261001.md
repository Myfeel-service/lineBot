# 小幫手出場時機：別家怎麼讓人在對的時候想起「交給它做」（2026-10-01）

> 編號 `D-112`。老闆原話：「用語意化請 agent 做事的功能蠻重要且好用，但目前的 UIUX 有點難知道什麼時候該用，評估一下其他廠商這方面的 UIUX 都怎麼做」。
> 示意頁（可以點著試）：artifact `G3FKKywM6zBVqTHozPusMd`（https://claude.ai/artifact/G3FKKywM6zBVqTHozPusMd）。這份報告是附錄，**判斷請看示意頁**。
> 前情：小幫手能代辦的範圍與紅線見 `docs/ASSISTANT-SEMANTIC-OPS-EVAL-20260813.md`（08-14 拍板）、`docs/TOUR-AND-AGENT-COVERAGE-EVAL-20260929.md`（`D-109`，代辦 7→15 件）。這份只談「人什麼時候會想到要用它」，**不碰紅線**（群發／對客人說話／刪除／憑證／成員／錢，最後一顆按鈕永遠留人）。

---

## 一、結論

查了 30 家（同類的客服／電商／行銷後台 17 家，加上 Notion、Microsoft、Google 這類通用工具與設計準則）。
做法幾乎一樣：**不靠一顆常駐按鈕讓人想起來，而是把「交給它做」放在那件事正要發生的地方。**

建議先做四件（約 4.5 天），第五件看用量再說：

| 順序 | 做什麼 | 工期 |
|---|---|---|
| 1 | 「目前狀況」的卡片，如果那件事小幫手做得到，多一顆「交給小幫手」，按下去它已經帶著這件事開好 | 1 天 |
| 2 | 自動回應、推播、標籤、知識庫的「新增」旁邊多一顆「用一句話建立」 | 1 天 |
| 3 | 輸入框上方的建議跟著頁面換，先列「直接幫你做」的（只從 15 件代辦挑）；分頁改名 | 1 天 |
| 4 | 它改完，頁面當場跟著變、改到的那一列亮一下；在別頁叫它做的給「前往查看」 | 1.5 天 |
| 5（之後） | 他手動改完同一件事時，提一次「下次可以用講的」 | 1 天 |

---

## 二、為什麼現在想不起來用它

1. **要點兩下才到。** 按右下角，打開先看到「目前狀況」；能講話的「問助理」是第三個分頁（`TutorialAgent.vue` 預設分頁是 `setup`）。
2. **開場只講「查」。** 四個建議問題全是查詢（「現在有什麼要處理的？」「這個月 AI 用量如何?」…），輸入框的範例也是查詢；能代辦這件事只寫在開場白後半的一行灰色括號裡（`AdminAgentChat.vue`）。
3. **每一頁都一樣。** 建議問題寫死四句，不看他在哪一頁；而且對話一開始就消失。
4. **改完看不到。** 按了確定，結果只在對話裡講一句；他正在看的那一頁不會更新，要自己重新整理（repo 裡沒有任何頁面在聽「小幫手改好了」這件事）。
5. **卡片沒接上代辦。** 「目前狀況」的異常卡有「幫我修」（一鍵修，7 種），但 15 件代辦沒有一件接到卡片上。例：節慶卡只有「去排推播 →」，不能叫小幫手先擬好草稿——明明「建一則推播草稿」就是代辦之一。

---

## 三、別家怎麼做（照「對想不起來用它最有效」排序）

標記：**[讀過]** 官方文件或實測文章原文；**[摘要]** 官方頁面擋抓取，只看到搜尋摘要。

### 1. 系統先發現該做的事，卡片一按就叫它開工
同類後台最主要的解法。
- **Shopify**：後台首頁最多 5 張建議卡，有出處；按卡上的動作會開對話並列好待辦；可以關掉並說為什麼，之後會照這個調整。[讀過] 2025-12-10 起，搶先體驗。
- **Zendesk**：管理助理（2026-05-26 正式推出）每週更新建議，按「幫我看看」就開助理並附上「查原因」「怎麼改善」；也可以按鈕直接開設定頁自己改。[讀過]
- **Square**：新的助理（2026-04 公開測試）分「點子」與「任務」，主動提庫存快沒、商品缺照片、排班衝突。產品主管：「從被動到主動……主要的介面不是一個問問題的框，是你交辦任務。」[讀過]
- **Gorgias／Intercom**：AI 沒答好的對話整理成「可以補的地方」，接受／略過／標記完成；Intercom 的建議四週沒處理就過期。[讀過]

**我們**：一半。異常卡有「幫我修」，代辦沒接上（第二節第 5 點）。

### 2. 在那件事旁邊放一顆，寫清楚用途，按下去題目帶好
- **Salesforce**：管理員可以在頁面上放按鈕，按了等於替使用者把那句話講給助理；官方理由「使用者不用記要怎麼講」。設定區每一頁都有「問設定助理」。[摘要／讀過]
- **HubSpot**：服務時效設定頁有一顆「用 AI 管理」，按了開助理並附建議問題。[讀過]
- **GitHub**：檢查失敗旁邊「解釋錯誤」，開對話時題目已經填好。[讀過]
- **Microsoft／Google**：選了儲存格或空白文字框，旁邊才冒出一兩個動作；Microsoft 2025-12 起把入口從工具列搬進文件本身，理由寫明「讓人更容易發現」。[讀過]

**我們**：沒有。

### 3. 建議跟著頁面換，而且寫成「幫我做」
- **Google**：每個 App 各有一組建議，產品總監說那幾句是做過大量研究與測試挑出來的。[讀過]
- **Salesforce／Klaviyo／Shopify**：在哪一頁打開就讀那一頁；範例寫成交辦（「複製某位使用者的權限」「幫我檢查歡迎流程」），不是「有什麼可以幫你」。[讀過]
- **Microsoft**：2025-07-15 收掉獨立的「範例庫」，範例改放在每個輸入框下面。[讀過]
- **設計準則**：NN/g（2026-04）——開場要講清楚它能做什麼、依頁面調整、建議做成可以按的按鈕；Shape of AI——建議只在有脈絡時出現、3～6 個、按了就直接送出。

**我們**：沒有。

### 4. 先給你看，改完畫面跟著變
- **HubSpot**：用講的改服務時效、工單流程，改之前先問，頁面即時更新。[摘要]
- **Shopify**：預覽卡上的欄位可以先改，按鈕寫明「儲存折扣」；一顆箭頭直接帶到那個商品或訂單。[讀過]
- **Word／Notion**：每處改動標出來，可以逐處保留或復原。[讀過]

**我們**：一半。確認卡完整（先講會改什麼、按了才動），缺的是改完那一頁的反應。

### 5. 剛好用得上時提一次，每件事只講一次
- **Gmail**：只有長信才自動出摘要卡；常收起就預設收起。[讀過]
- **Zendesk／Intercom**：一週一次、四週過期。[讀過]
- **Sentry**（2019，非 AI）：觸發條件成立才出提示，被一直關掉的提示整個拿掉。[讀過]

**我們**：沒有（只有「第一次來」「出異常」兩種小氣泡）。

---

## 四、不建議學的

**不適合我們的兩種常見做法**
- **快捷鍵叫出指令列**（Linear、Figma、Intercom、Gorgias）：對象是一天用八小時的客服人員；店家老闆不會記快捷鍵。
- **獨立的範例庫頁**：Microsoft 已經收掉。

**別家踩過的雷**
- **把原本的路拿掉，逼人用 AI**：Salesforce 說明中心 2025-09-29 把搜尋換成 AI 助理，714 票連署抗議，11-14 又加回來，主管公開說「我太早做這個決定」。→ 我們「＋ 新增」照舊是主按鈕。
- **一直跟著你、關不掉**：Word 跟著游標跑的 Copilot 圖示、Acrobat「這份文件很長」橫幅，都只能整個關掉 AI。→ 每張提示單獨可關，每件事只講一次。
- **只放星星圖示、取可愛名字**：NN/g 測試沒有人把星星圖示聯想到 AI；Amazon「Rufus」看名字不知道做什麼。→ 按鈕寫字。
- **建議它做不到的事**：Cisco 提醒模型自己想的「下一步建議」會建議系統做不到的事；HubSpot 的建議被嫌普通。→ 建議只從 15 件代辦挑、每頁寫死（跟 AI 生成腳本那輪定的「拒答建議必須白名單真實功能」同一條）。

---

## 五、每件要動什麼（估工期用）

1. **卡片接代辦（1 天）**：小幫手要多一個「帶著一句話打開問答分頁並送出」的入口（今天只能切分頁，`useTutorial` 的 `openPanelTab`）。節慶卡、待辦「開啟 AI 自動回覆」「啟用一條客服流程」各加一顆。送出的是普通的一句話，走既有的提議→確認卡，**後端不用新增**。
2. **「用一句話建立」（1 天）**：同一個入口，但不自動送出（內容要他講），只打開、游標放進輸入框、範例換成這一頁的。四頁共用一顆元件，樣式進 partial。
3. **建議跟著頁面（1 天）**：一張「頁面 → 最多 3 個做＋1 個查」的對照表；建議從「對話開始前才出現」改成「一直在輸入框上方、跟著頁面換」。⛔ 每個「做」都要對得上 15 件代辦之一，加一支反向測試（代辦改名或拿掉就紅，比照 `agent-teachings` 的做法）。開場白重寫成先講會做事。
4. **改完畫面跟著變（1.5 天）**：確認後的回應要帶「改的是哪一頁的哪一筆」；有代辦的五頁（自動回應、推播、標籤、知識庫、AI 設定）聽這個訊號重新讀資料並把那一筆亮一下；不在那一頁時給「前往查看」帶路卡（沿用既有帶路卡與白名單）。15 件代辦的回應各要補這一格，所以比較久。
5. **手動改完提一次（1 天，之後）**：只掛在有對應代辦的那幾個儲存動作；每件事只提一次、一天最多一次、「不用再提醒」永久關。記在個人偏好（同 `adminUserPrefs`）。

**量測**：每個入口送出時帶來源（卡片／頁面按鈕／頁面建議／自己打字），兩週後看哪個有人按。別家都沒有公開入口別的使用數字，只能自己量。

---

## 六、要拍板的三題

1. **「用一句話建立」放哪幾頁？** ①有「新增」的四頁（建議）②先只放自動回應、兩週後再擴 ③連 AI 設定也放（那頁沒有新增鈕，要每張設定卡加「用講的修改」）。
2. **「問助理」分頁要不要改名？** ①改「問／交辦」（建議：名字本身就說它會做事）②維持。
3. **第 5 件什麼時候做？** ①先不做，看 1～4 的用量（建議）②一起做。

---

## 七、查證方法與限制

- 兩路平行查網路：同類後台（Shopify、HubSpot、Intercom、Zendesk、Salesforce、Klaviyo、Mailchimp、Square、Wix、Gorgias、Freshworks、respond.io、SleekFlow、LINE 官方帳號、漸強、Omnichat、Manychat）；通用工具與準則（Notion、Microsoft 365、Google Workspace、Canva、Figma、Linear、Atlassian、Airtable、monday、Asana、ClickUp、GitHub、Adobe、Slack、Microsoft 人機互動準則、Shape of AI、NN/g、Google PAIR）。
- **沒有任何一家公開「哪個入口帶來最多使用」的數字**。最接近的證據是做法的轉向：Microsoft 為了「更容易發現」把入口搬進文件、收掉範例庫；Google 從手動按「摘要」改成長信自動出卡；Square 從問答框轉向主動列任務。
- 部分來源只看到搜尋摘要（HubSpot「頁面即時更新」、Intercom 助理、Salesforce 頁面按鈕的部落格），已在第三節標 [摘要]。
- 同類的 LINE 生態（LINE 官方帳號管理後台、漸強、Omnichat）**沒有找到**管理端「用講的幫你改設定」的助理；最接近的是 respond.io 與 SleekFlow（都是確認卡→套用）。⚠️ 這是「查不到」，不等於「沒有」。
- repo 現況只讀了小幫手面板、問答、確認卡、目前狀況卡片與代辦註冊表；沒有實機走（這輪不改程式）。

## 附：主要來源

- Shopify：https://changelog.shopify.com/posts/proactive-business-recommendations-from-sidekick 、https://help.shopify.com/en/manual/ai-powered-tools/sidekick/pulse 、https://help.shopify.com/en/manual/shopify-admin/productivity-tools/sidekick/features 、https://www.getmesa.com/blog/how-to-use-shopify-sidekick
- Zendesk：https://support.zendesk.com/hc/en-us/articles/10013995711386 、https://support.zendesk.com/hc/en-us/articles/9598690362010
- Square：https://squareup.com/help/us/en/article/8617-use-managerbot-to-manage-business-tasks-and-insights 、https://venturebeat.com/data/block-introduces-managerbot-a-proactive-square-ai-agent-and-the-clearest
- Gorgias：https://docs.gorgias.com/en-US/continuously-improve-ai-agent-with-opportunities-beta-4858461 ；Intercom：https://intercom.help/fin4all/en/articles/11411760-optimize-fin-instantly-with-the-help-of-ai
- Salesforce：https://admin.salesforce.com/blog/2025/revolutionize-record-pages-ai-powered-agent-shortcuts-are-here 、https://trailhead.salesforce.com/content/learn/modules/agentforce-for-setup-quick-look/get-to-know-setup-with-agentforce
- HubSpot：https://knowledge.hubspot.com/ai/use-breeze-assistant 、https://knowledge.hubspot.com/help-desk/set-sla-goals-in-help-desk 、https://www.inboundav.com/blog/i-put-hubspots-ai-assistant-to-the-test
- Klaviyo：https://help.klaviyo.com/hc/en-us/articles/52230280693403 ；GitHub：https://docs.github.com/en/enterprise-cloud@latest/copilot/tutorials/explore-pull-requests
- Microsoft：https://mc.merill.net/message/MC1189000 、https://mc.merill.net/message/MC1470885 、https://support.microsoft.com/en-us/topic/1c192167-9250-4ef8-b488-63c474d8b84f
- Google：https://blog.google/products/workspace/google-gemini-workspace-ai-prompt-tips/ 、https://workspaceupdates.googleblog.com/2025/05/gemini-summary-cards-gmail-app.html
- respond.io：https://respond.io/help/quick-start/using-copilot.md ；SleekFlow：https://help.sleekflow.io/en_US/create-and-set-up-your-ai-agent-with-conversational-setup-tool
- 準則：https://www.microsoft.com/en-us/haxtoolkit/library/ 、https://shapeof.ai/patterns/nudges 、https://shapeof.ai/patterns/suggestions 、https://www.nngroup.com/articles/ai-chatbots-design-guidelines/ 、https://www.nngroup.com/articles/ai-sparkles-icon-problem/ 、https://pair.withgoogle.com/chapter/mental-models/
- 踩雷：https://www.salesforceben.com/search-is-back-on-salesforce-help-nearly-2-months-after-community-backlash/ 、https://techcommunity.microsoft.com/discussions/microsoft-copilot/i-want-to-turn-off-or-hide-the-draft-with-copilot-dingbat-that-follows-my-cursor/4288889 、https://community.adobe.com/t5/acrobat-discussions/possible-to-permanently-disable-the-quot-this-appears-to-be-a-long-document-quot-popup-header/m-p/15282893 、https://blogs.cisco.com/ai/non-obvious-patterns-in-building-enterprise-ai-assistants 、https://blog.sentry.io/growing-adoption-building-modern-clippy
