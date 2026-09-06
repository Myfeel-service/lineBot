# 開通引導的示意圖

小幫手的「怎麼拿？／怎麼貼？／怎麼關？」卡片會在每一小步旁邊配一張畫面截圖。
**卡片吃的是下表的 PNG**（路徑單一來源在 `app/utils/onboarding-shots.ts`）。

⚠️ **這個資料夾會對外公開**（`public/` 底下的東西任何人都能用網址開啟，也會跟著部署）。
只放卡片真的會用到的圖；**未裁切的原始截圖放 `docs/onboarding-shots-src/`**（不對外、不部署），
重裁重框時從那裡出發，不用重拍。

> **圖不在也不會壞**：卡片會先在背景載一次，載不到就只顯示文字。
> 補圖／換圖丟進來重新部署即可，**不用改程式**。

## 正式圖（卡片實際顯示的）

來源檔都在 `docs/onboarding-shots-src/`（下表只寫檔名）。

「圈幾格」欄位＝圖上有幾顆紅色編號徽章；**同一組號碼會出現在旁邊的文案裡**（見下面
「編號」一節）。0 格＝整張沒編號（只有一個動作，標號碼只是多一個要讀的東西）。

| 檔名 | 內容 | 圈什麼／幾格 | 來源檔 |
|---|---|---|---|
| `line-console-channel.png` | LINE Developers 帳號清單（靜態，修復劇本用） | 卡片下方的「Messaging API」**小字**（⛔同名可能兩張卡，認小字不認名稱）。0 格 | `src-channel-list.jpg` |
| `line-console-channel.webp` | **循環動畫**：①登入頁 → ②帳號清單聚焦「Messaging API」小字 | 2 格。⚠️①的紅框**框整組三顆登入鈕**、不框單顆（2026-09-07 老闆問「是否也用紅框示意」）——08-19「登入頁不圈按鈕」的理由（圈哪顆都會誤導用其他方式登入的人）照樣守住，又跟其他停格視覺一致。⚠️ 這一格要**自己的左邊界 x0=130**：登入頁內容置中在 x≈675，沿用預設 240 會整塊偏左（老闆抓到「圖片是歪的」）。那一格還沒登入＝沒有個人資訊，不用打碼 | `src-login.jpg`＋`src-channel-list.jpg` |
| `line-console-get-token.webp` | **循環動畫**：①切 Messaging API 分頁 → 捲到底 → ②按 Issue → ③按複製 | 3 格（分頁／Issue 鈕／複製圖示） | `src-messaging-api.jpg` |
| `line-console-issue-token.png` | Messaging API 分頁最底 | Channel access token 的 Issue／Reissue 鈕。0 格 | `src-messaging-api.jpg` |
| `line-console-channel-secret.webp` | **循環動畫**：①切 Basic settings 分頁 → 捲下來 → ②Channel secret 那一列 | 2 格（分頁／目標列） | `src-basic-settings.jpg` |
| `line-console-webhook-url.png` | Webhook settings 全景（**只給修復劇本**）：①貼網址的欄位 ②Use webhook 開關 | 2 格。⚠️這張的①②是**它自己的**編號（「這裡有兩樣東西」），跟動畫的編號無關 | `src-messaging-api.jpg` |
| `line-console-which-card.png` | **認錯卡對照**：兩張同名卡並排，左邊（Messaging API）綠框＝要點的，右邊（LINE Login）紅框打叉＝不要點 | 0 格。⛔**綠紅不是唯一差別**（色盲看不出來）——錯的那張有一個大叉，那才是訊號 | `src-channel-list.jpg`（兩張卡本來就並排在同一張截圖裡，不用重截） |
| `line-console-use-webhook.png` | 只圈 Use webhook 開關（上面留網址那列當定位）——**開通引導第三步專用** | 0 格。跟上面那張別混：只做一件事的步驟不能配兩個編號的全景圖 | `src-messaging-api.jpg` |
| `line-console-webhook.webp` | **循環動畫**：①選 Messaging API 卡 → ②切分頁 → 捲下來 → ③按 Edit → ④貼網址按 Update | 4 格。⛔**停在④存檔**——開 Use webhook 是教學的下一步，演進來的話人會提前做完 | `src-channel-list.jpg`＋`src-basic-settings.jpg`＋`src-messaging-api.jpg` |
| `oam-response-settings.webp` | **循環動畫【開通流程用】**：①左欄「回應設定」→ ②把 Webhook 打開 → ③選「手動聊天」 | 3 格。⛔**刻意不含「點右上角設定」**——走到這一步的人前兩步（拿 Channel secret、貼網址）已經在「設定」裡面待過了，再叫他點一次是叫他去他已經站著的地方（2026-09-06 老闆抓到） | `src-oam-response.jpg`（與下面那支同一張） |
| `oam-auto-reply.webp` | **循環動畫【冷啟動用】**：①右上「設定」→ ②側欄「回應設定」→ ③把 Webhook 打開 → ④選「手動聊天」 | 4 格。⚠️`field-help.ts` 的「教我怎麼關」用這一支：那裡的人從**我們自己的設定頁**點進來、沒進過 OA 後台，而連結**落在「主頁」不是設定頁**、左欄還沒展開——「先點右上角設定」對他是必要的第一步，不能省 | `src-oam-response.jpg`（與上面那支同一張） |
| `oam-channel-secret.webp` | **循環動畫**：①右上「設定」→ ②左欄「Messaging API」→ ③`Channel secret` 那一列按「複製」 | 3 格。⛔**框整列不框按鈕**——`Channel ID` 與 `Channel secret` 各有一顆「複製」且上下相鄰，只圈按鈕分不出是哪一列 | `src-oam-messaging-api.jpg`。⛔ **不可以退回緊裁的一列靜態圖**：2026-09-06 第一版就是那樣做的，老闆一看說「根本不知道在哪裡」——本檔「拍攝／處理規格」那一節早就寫著緊裁圖缺定位、只用在「已經知道位置、回去再看一眼」的修復情境 |
| `oam-webhook-url.webp` | **循環動畫**：①右上「設定」→ ②左欄「Messaging API」→ ③貼進「Webhook網址」→ ④按「儲存」 | 4 格。⚠️貼上與存檔**分兩格**：「貼了沒按儲存」是接不通的第一名 | `src-oam-messaging-api.jpg`。⚠️ 2026-09-07 老闆拍板**恢復①②導航**（推翻 09-06 的裁切）：上一步跟這一步**中間離開過**（回 MiniMe 貼 secret、複製網址），回來的人可能已經不在那一頁。⛔ 判準＝**「中間有沒有離開」不是「同不同一頁」**——「回應設定」那支緊接在後、沒離開，維持不含「點設定」 |
| `oam-enable-messaging-api.webp` | **循環動畫**：①按「啟用Messaging API」→ ②建立服務提供者（填店名）→ ③隱私權兩欄可不填按確定 → ④最後確認按確定 | 4 格。⛔**停在④按確定，不演完成畫面**——演到「已經好了」會讓人以為不用按那顆（同 webhook 動畫踩過的坑），而且完成畫面上有明文 Channel secret | `src-oam-enable-messaging-api.jpg`＋`src-oam-enable-provider.jpg`＋`src-oam-enable-privacy.jpg`＋`src-oam-enable-confirm.jpg`。⛔ **動畫每一幀要自己遮**：`shot()` 的 blur 參數是逐次呼叫的、`build_anim` 沒有那個入口——第一版忘了，第①格把加好友 ID 與個人名字原封推出去（靜圖版有遮）。⚠️ vh 調到 700（彈窗最高 578px，照預設 620 會貼著上下邊） |
| `oam-enable-messaging-api.png` | 官方帳號後台 → 設定 → Messaging API，**狀態「未使用」**＋「啟用Messaging API」鈕 | 啟用按鈕。0 格 | `src-oam-enable-messaging-api.jpg`。⚠️**必須是還沒啟用的帳號**——啟用過的那頁根本沒有這顆鈕（2026-09-02 老闆為此開了一個全新測試帳號來拍） |
| `oam-account-list.png` | 官方帳號後台的**帳號一覽**：「你已經有 LINE 官方帳號了嗎？」那一題的配圖 | 整張表格。0 格 | `src-oam-account-list.jpg`。⛔ 三列都是**真實客戶**的帳號名稱與頭像，產線用高斯模糊糊掉（不是蓋色塊——這張要教的正是「列表長這樣」，蓋掉就沒東西可看了）；換圖要重對座標 |
| `line-console-liff-setup.webp` | **循環動畫**：①LINE Login 那張卡 → ②LIFF 分頁 → ③按 Add → ④填 Endpoint URL | 4 格。④是重點：填錯客人會卡在轉圈 | `src-channel-list.jpg`＋`src-line-login-channel-DO-NOT-USE.jpg`＋`src-liff-list.jpg`＋`src-liff-add.jpg`。⚠️後兩張是 09-02 新拍的，**側欄比舊截圖窄**，那兩幀的左邊界要另外指定（`build_anim` 的第五個元素） |
| `line-console-which-card-liff.png` | **認錯卡對照【LIFF 版】**：右邊（LINE Login）綠框＝要點的，左邊（Messaging API）紅框打叉 | 0 格 | `src-channel-list.jpg`。⛔ 跟上面那張 `which-card` **正好相反**，別互相代用——拿鑰匙教人別點 LINE Login，設 LIFF 教人就是要點它 |

**全部由 `scripts/make-onboarding-shots.py` 產生**（需要 Python3＋Pillow）：裁切座標、紅框、
編號徽章、動畫的停格與捲動節奏都寫在腳本裡。換圖流程＝重截 → 蓋掉來源檔 → 對新圖調座標 →
重跑腳本。⛔動畫是「整頁截圖裁不同捲動位置」拼出來的，不是錄影——換截圖重跑即可重製，
別改成錄螢幕（錄的沒人會重錄，過期了只能整段作廢）。

（`src-login.jpg` 登入頁：2026-08-19 拍板不配圖——登入頁人人認得，而且圈哪顆按鈕都會誤導
用其他方式登入的人；文案改講「用你平常的方式登入」。來源檔留著。）

## 來源檔備註（`docs/onboarding-shots-src/`）

- `src-line-login-channel-DO-NOT-USE.jpg`＝**LINE Login 頻道**的 Basic settings。
  ⛔**別拿它教第二把鑰匙**——那頁的 Channel secret 是另一把（LINE Login 用的），跟收訊息
  的不是同一把，教了就是把人送進「Secret 貼錯→訊息全被丟掉」的災難。檔名直接標了 DO NOT
  USE，留著只當「長這樣的頁面不要用」的對照。
- `src-provider-settings.jpg`＝Provider 設定頁，目前沒有任何步驟用到。

**2026-09-06 新批（老闆用 CITY PLAY 測試頻道從零走一次拍的，已由 `scripts/mask-onboarding-src.py` 處理過）**
——這批的價值在於**畫面狀態是「還沒設定」**，舊那批全是設定完成的帳號，所以圖跟文案一直對不起來：

- `src-token-empty.jpg`＝Messaging API 分頁最底，**Channel access token 還沒發**：空白列＋一顆 `Issue`，
  旁邊**沒有複製圖示**。⛔ 拿 Token 教學的第②格要用這張——舊圖那顆按鈕寫的是 `Reissue`，
  而新手看到的是 `Issue`。**不可以只把圖上的字 P 掉**：有值＋有複製圖示＋按鈕寫 `Issue` 這個組合
  在真實後台不存在，那是假圖。
- `src-token-issued.jpg`＝按下 `Issue` 之後：token 兩行、複製圖示出現、按鈕變 `Reissue`。第③格（按複製圖示）用這張。
  ⚠️ token 值已模糊，**但複製圖示刻意留清楚**（右界停在 x=1130，1139~1153 是圖示）——那顆正是要圈的東西。
- `src-webhook-editing.jpg`＝按 `Edit` 之後：輸入格打開、網址貼好、`Update`／`Cancel` 都在，
  下面 `Use webhook` **是灰的**。接線教學第④格用這張（舊圖從頭到尾沒有 `Update` 這顆鈕）。
- `src-webhook-saved.jpg`＝按完 `Update`：網址存好（`Verify`／`Edit`）、`Use webhook` **仍然是灰的**。
  「打開 Use webhook」那張靜圖用這張（舊的 `line-console-use-webhook.png` 上開關已經是綠的＝教人開一個開好的東西）。
- `src-basic-settings-secret.jpg`＝Channel secret 那一列**有值**（已模糊）。取代現在那張空白的——
  空白列會讓新手以為自己那邊沒資料。
- `src-secret-issue-warning.jpg`＝按到 **Channel secret 旁邊那顆 `Issue`** 跳出的確認框。
  ⛔ 這是新發現的雷：**同一個後台有兩顆都叫 `Issue`**，一顆發 Access Token（Messaging API 分頁最底，
  按了沒事），一顆重發 Channel Secret（Basic settings，**按了已接好的線當場斷，而且一小時內換不回來**），
  連老闆自己都按錯。第二組連線資訊那一步要配這張警告「看到這個框就是按錯了，按 Cancel」。

⚠️ **這批原始截圖裡有活的憑證**（真的 Channel access token 與 Channel secret），
只有處理過的版本進 repo；未處理的原檔留在老闆桌面，不要搬進來。
⚠️ 圖上的 Webhook 網址原本是 `world.splash-digilab.com/cityplay`（另一個專案），已換成
`https://lineminime.com/webhook`——**做法是從 `src-messaging-api.jpg` 剪真實像素貼過去**，不是自己畫字。

## 拍攝／處理規格（換圖時照做）

- **語言**：LINE Developers 後台**只有英文**（沒有中文介面），照英文截——使用者看到的
  就是英文；官方帳號後台（manager.line.biz）是中文，照中文截。
- **打碼**（下面三樣一定要遮，已建立先例）：右上角**個人大頭照**、**個人名字**、
  官方帳號後台頂列的**加好友 ID（@xxxx）**。帳號名稱用測試帳號（Myfeel Test）可留。
- ⛔ **憑證絕對不能入鏡**：Token／Channel secret／Channel ID／QR code 的值，截圖前先清空
  或蓋住——這個資料夾是對外公開網址，圖推上線就收不回來。
- **標註＝聚光＋低飽和紅細框**（2026-09-02 拍板三修）：目標維持原亮度、周圍壓暗 18%，
  目標外緣再畫一圈 **2px、圓角、`#B4544E`（低飽和磚紅）** 的細框。
  標註史別再繞回去：08-19 粗紅框被嫌「很俗」→ 改純聚光 → 細框也拔掉；09-02 老闆實測
  回饋 **LINE 後台是白底、聚光後的目標也是白的**，只比周圍亮 18%，在對話卡片裡（實際
  顯示約 630px 寬）要找一兩秒——所以框加回來，但**被嫌俗的是飽和粗紅框，不是「有框」**。
  ⛔ 不要回去用飽和正紅（`#E0313A` 那一版）。
- **編號徽章**（2026-09-02 同一輪）：動畫的每個停格左上角壓一顆號碼，右下角標「第幾格／
  共幾格」。理由：一支動畫演三四個動作又是**循環播放**，中途接上的人不知道自己看到的是
  第幾步；號碼是唯一能把「旁邊那句話」跟「這一格畫面」綁起來的東西。
  **只有一個動作的圖不編號**——一格的進度沒有資訊，只是多一個要讀的東西。
  ⚠️ **圖上的號碼＝文案裡的①②③**，改文案順序要一起改腳本重跑。這件事有測試守著
  （`shared/onboarding-shot-steps.test.ts`，對照產圖腳本輸出的 `shared/onboarding-shot-steps.ts`）。
- 一張圖圈一個重點（`line-console-webhook-url.png` 那張例外，它是修復劇本用的全景）。
  不要在圖上寫字——文字由卡片負責，寫在圖上之後改文案會對不起來。
- **裁切**：只裁「目標＋認得出位置的周邊」，整頁縮圖進卡片會變螞蟻字。寬度 1000–1400px。
- **教學圖優先用「從分頁帶到目標」的動畫**（2026-08-19 拍板）：緊裁的一列靜態圖缺「從哪裡來」的定位，使用者對不出這個欄位在頁面的什麼地方；靜態緊裁圖只用在修復劇本這種「已經知道位置、回去再看一眼」的場景。

## 三種教學形式的分工（2026-08-19 拍板）

| 場景 | 用什麼 | 例子 |
|---|---|---|
| 從零到完成的**旅程** | 滿版對話教學（開通引導，`useOnboardingChat`） | 建帳號→拿鑰匙→接線→傳話測試 |
| 單一欄位**怎麼填** | 欄位旁按鈕→就地彈窗（`AdminFieldHelp`＋`app/utils/field-help.ts`） | Token／Channel Secret／Webhook URL |
| 東西**壞了要修**（要驗證、要診斷） | 右下角小幫手劇本＋聚光燈（`agent-guides`） | webhook 紅燈「用聊天帶我修」 |

⛔ 別混用：欄位教學的終點動作是「貼回那個欄位」，任何把人帶離欄位的形式（滿版）都輸在起跑點；
小幫手劇本留給要真訊號驗證的修復流程。我們自己後台的欄位用聚光燈（`?focus=`），不用截圖。

## 怎麼新增一支教學（外部後台的欄位）

1. **截圖**：那條路徑會經過的每一頁各一張完整截圖（規格見上），丟進 `docs/onboarding-shots-src/`
2. **產圖**：座標與動畫節奏標進 `scripts/make-onboarding-shots.py`，重跑
3. **登記**：路徑加進 `app/utils/onboarding-shots.ts`；欄位教學再加一筆 `app/utils/field-help.ts`
4. **掛上**：欄位標籤旁 `<AdminFieldHelp id="..." />`（或接進開通劇本／修復劇本的節點）

## 更新紀錄

LINE 後台改版時圖會過期，但**畫面不會自己通知我們**。換圖時在這裡補一行：

| 日期 | 換了哪幾張 | 備註 |
|---|---|---|
| 2026-08-19 | 首批六張（老闆截圖、Claude 裁切標註） | 岔路那張（oam-enable-messaging-api）尚缺。⚠️這批圖同時抓到教學文案過期：回應設定新版介面沒有「聊天機器人」選項，正確操作是回應方式選「手動聊天」，劇本文案已同步改 |
| 2026-08-19 ② | 拿鑰匙段改節點式教學：登入圖移除、新增 get-token 循環動畫；產線收進 `scripts/make-onboarding-shots.py` | 老闆拍板：一次一步＋「下一步」翻頁；切分頁→捲底→Issue→複製合成一支動畫（63KB） |
| 2026-08-19 ③ | 標註全套改聚光式；新增 channel-secret 循環動畫 | 粗紅框被嫌俗；緊裁列圖缺定位，教學圖改「從分頁帶到目標」的動畫 |
| 2026-08-19 ④ | 標註拔掉框線只留聚光（壓暗 14→18%）；帳號清單改動畫版（教學用）；動畫開場加正常畫面幀；幾個框對正（「手動聊天」右側多一截最明顯）；秘鑰靜態列圖退場 | 老闆逐輪校 |
| 2026-08-19 ⑤ | 關自動回應也改帶路動畫（右上設定→側欄回應設定→手動聊天，73KB），教學兩步併一步；靜態版退場 | 三個「找位置」環節全數動畫化 |
| 2026-08-19 ⑥ | 欄位教學鈕擴到 LIFF（教我怎麼設，動畫待截圖）與內建自動回應（教我怎麼關，複用動畫）；設定頁補關自動回應提醒；LIFF 修復劇本明講「LINE Login 那張卡」 | D-17 盤點的兩個洞 |
| 2026-08-19 ⑦ | webhook 改全程動畫（含選對卡前導，跨三頁）；LIFF 動畫前半段用現有截圖先做（選卡＋LIFF 分頁）；兩支動畫第一格互為對照（各亮一張同名卡） | 老闆：教學前面也要有選卡步驟 |
| 2026-08-19 ⑧ | webhook 動畫補「先按 Edit 打開輸入格」停格，全部教學文案同步——現截圖是已設定狀態，第一次的人沒這步會卡住 | 老闆抓到 |
| 2026-09-02 ④ | LIFF 動畫從 2 格補到 4 格（Add 與 Endpoint URL 兩幀）；新增 `line-console-which-card-liff.png`；產線的 `build_anim` 支援逐幀左邊界 | 老闆問「提及 LIFF 設定時是否都加上圖片」——盤點後修復劇本 `liff-endpoint` 原本**一張圖都沒有**，補上對照圖。⛔ 那裡刻意不用帶路動畫：動畫演到「按 Add 新增」，而修復的人是要點進**已經存在**的 LIFF，演給他看反而教錯。⚠️ 逐幀左邊界的鐵律＝**寬度必須一致**，差一像素 webp 動畫就拼不起來（腳本裡有 assert 擋著） |
| 2026-09-02 ③ | 老闆開了一個全新測試官方帳號拍齊缺圖：補上 `oam-enable-messaging-api.png`（欠最久的那張）與新的 `oam-account-list.png`；產線加高斯模糊遮罩 | 同批還拿到「Webhook 全空的狀態」「LIFF 清單＋Add 表單」「申請官方帳號全流程」「啟用 Messaging API 的三個彈窗」等來源檔，尚未做成正式圖。⚠️**新來源檔裡有兩把明文 Channel secret**（CITY PLAY 的 Messaging API 與 LINE Login 各一），那兩張目前沒進 `docs/onboarding-shots-src/`，要用之前必須先遮 |
| 2026-09-02 ② | 新增 `line-console-which-card.png`（認錯卡對照）；產線的標註加 `pick`／`reject` 兩種樣式 | 掛在第二把鑰匙那一步的收合警告裡。**這是全流程唯一「照著做也會錯」的地方**：點到 LINE Login 那張卡，Basic settings 裡也有一個 Channel secret，貼進來系統照收，然後客人每句話都被當成假冒的丟掉，而且畫面上一切正常 |
| 2026-09-06 ② | **新增 `oam-enable-messaging-api.webp`**（啟用 Messaging API 全程四格）與三張來源檔 | 老闆問「第 3 條（建好帳號後補引導）要不要加」——盤點後**不加他說的那種過場漫畫**（那一步沒有按鈕要按、下一則本來就有圖、而且三格裡必有一格是我們自己的畫面＝踩到 08-28「站內不配圖」的拍板），改補在**真正會卡住的地方**：「還沒有官方帳號」那條路。原本「按啟用」只有四個字，實際上按下去要**連過三關**（選服務提供者／隱私權／最後確認），最後那關還跳「一旦與提供者連動即無法變更或解除」。素材是老闆 09-02 拍好、README 記著卻沒進資料夾的那批（`~/Desktop/截圖 2026-09-02 下午3.53.*`）。⛔ 完成畫面（`3.54.06`）刻意不收：有明文 Channel secret，而且演完成會讓人以為不用按最後那顆確定 |
| 2026-09-06 | **來源檔補「還沒設定」狀態六張**（`src-token-empty` / `src-token-issued` / `src-webhook-editing` / `src-webhook-saved` / `src-basic-settings-secret` / `src-secret-issue-warning`），新增前處理腳本 `scripts/mask-onboarding-src.py` | 老闆對開通對話的文案回饋（`STATUS` 的 `D-66`）連帶查出來的：**這批圖全是拿「早就設定完成」的帳號截的**，所以①拿 Token 那格按鈕寫 `Reissue`（新手看到的是 `Issue`）②接線那格 `Update` 這顆鈕**從頭到尾沒出現過**、而且 `Use webhook` 已經是綠的③Channel secret 整列空白。⛔ **09-02 那次記著「webhook 動畫已重裁停在④存檔」是假的**——那次只挪了聚光位置，底圖狀態沒換，等於沒修。逐格拆 webp 才看得出來，改圖前務必自己拆開看。 |
| 2026-09-02 | **全部重產**：標註加回低飽和紅細框（`#B4544E` 2px）＋動畫停格加編號徽章與「第幾格／共幾格」；webhook 動畫重裁停在④存檔；新增 `line-console-use-webhook.png` | 老闆拍板 B+C（框＋編號一起做）。順手收掉 08-28 記在程式裡的洞：webhook 動畫原本會演到「開 Use webhook」＝教學的下一步，看得見畫面的人會提前做完、讀螢幕的人拿到的描述跟指令互相矛盾。產線同時輸出 `shared/onboarding-shot-steps.ts` 給測試對帳 |
