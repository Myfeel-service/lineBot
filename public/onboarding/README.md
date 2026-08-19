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

| 檔名 | 內容 | 紅框圈什麼 | 來源檔 |
|---|---|---|---|
| `line-console-channel.png` | LINE Developers 帳號清單 | 卡片下方的「Messaging API」**小字**（⛔同名可能兩張卡，認小字不認名稱） | `src-channel-list.jpg` |
| `line-console-get-token.webp` | **循環動畫**：切 Messaging API 分頁 → 捲到底 → 按 Issue → 按複製 | 三個停格各圈一處（分頁／Issue 鈕／複製圖示） | `src-messaging-api.jpg` |
| `line-console-issue-token.png` | Messaging API 分頁最底 | Channel access token 的 Issue／Reissue 鈕 | `src-messaging-api.jpg` |
| `line-console-channel-secret.png` | Messaging API 頻道的 Basic settings | Channel secret 那一列（修復劇本的小面板用） | `src-basic-settings.jpg` |
| `line-console-channel-secret.webp` | **循環動畫**：切 Basic settings 分頁 → 捲下來 → Channel secret 那一列 | 兩個停格（分頁／目標列） | `src-basic-settings.jpg` |
| `line-console-webhook-url.png` | Messaging API 分頁的 Webhook settings | ①貼網址的欄位 ②Use webhook 開關 | `src-messaging-api.jpg` |
| `oam-auto-reply.png` | 官方帳號後台 → 設定 → 回應設定 | 「手動聊天」選項（＝關掉內建自動回應的新版做法） | `src-oam-response.jpg` |
| `oam-enable-messaging-api.png` | 官方帳號後台 → 設定 → Messaging API 的啟用鈕 | 啟用按鈕 | **尚缺**——只用在「清單沒看到帳號」的岔路，補上即自動顯示 |

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

## 拍攝／處理規格（換圖時照做）

- **語言**：LINE Developers 後台**只有英文**（沒有中文介面），照英文截——使用者看到的
  就是英文；官方帳號後台（manager.line.biz）是中文，照中文截。
- **打碼**（下面三樣一定要遮，已建立先例）：右上角**個人大頭照**、**個人名字**、
  官方帳號後台頂列的**加好友 ID（@xxxx）**。帳號名稱用測試帳號（Myfeel Test）可留。
- ⛔ **憑證絕對不能入鏡**：Token／Channel secret／Channel ID／QR code 的值，截圖前先清空
  或蓋住——這個資料夾是對外公開網址，圖推上線就收不回來。
- **標註＝聚光式**（2026-08-19 拍板）：目標維持原亮度、周圍壓暗 14%、細線框（#E0313A、2px、圓角）——⛔別畫回粗紅框，被嫌過俗。一張圖圈一個重點（webhook 那張例外，①②編號對齊
  卡片步驟）。不要在圖上寫字——文字由卡片負責，寫在圖上之後改文案會對不起來。
- **裁切**：只裁「目標＋認得出位置的周邊」，整頁縮圖進卡片會變螞蟻字。寬度 1000–1400px。
- **教學圖優先用「從分頁帶到目標」的動畫**（2026-08-19 拍板）：緊裁的一列靜態圖缺「從哪裡來」的定位，使用者對不出這個欄位在頁面的什麼地方；靜態緊裁圖只用在修復劇本這種「已經知道位置、回去再看一眼」的場景。

## 更新紀錄

LINE 後台改版時圖會過期，但**畫面不會自己通知我們**。換圖時在這裡補一行：

| 日期 | 換了哪幾張 | 備註 |
|---|---|---|
| 2026-08-19 | 首批六張（老闆截圖、Claude 裁切標註） | 岔路那張（oam-enable-messaging-api）尚缺。⚠️這批圖同時抓到教學文案過期：回應設定新版介面沒有「聊天機器人」選項，正確操作是回應方式選「手動聊天」，劇本文案已同步改 |
| 2026-08-19 ② | 拿鑰匙段改節點式教學：登入圖移除、新增 get-token 循環動畫；產線收進 `scripts/make-onboarding-shots.py` | 老闆拍板：一次一步＋「下一步」翻頁；切分頁→捲底→Issue→複製合成一支動畫（63KB） |
| 2026-08-19 ③ | 標註全套改聚光式；新增 channel-secret 循環動畫 | 粗紅框被嫌俗；緊裁列圖缺定位，教學圖改「從分頁帶到目標」的動畫 |
