# 讓「成本總覽」顯示主機（AWS）花費

超管後台 **成本總覽** 頁的「主機花費」區塊，會顯示 **AWS 自己算好的帳單金額**（不是用單價推估的），
並依服務分項列出：AWS Amplify、Amazon Lightsail、S3、CloudWatch、寄信（SES）等各花多少。

沒設定的話，那個區塊會顯示「讀不到 AWS 花費」加上原因 —— **不會顯示 NT$0**，
所以不會把「沒接上」誤讀成「這個月沒花錢」。其他功能完全不受影響。

本文是逐步操作教學。全部做完大約 15 分鐘，其中有一段要等 AWS 產生資料（最長 24 小時）。

---

## 開始前先知道三件事

1. **只讀帳單，碰不到任何東西。** 整個設定只會給出一個權限 `ce:GetCostAndUsage`，
   它只能查「花了多少錢」，看不到也改不了任何伺服器、資料庫、檔案。
2. **查詢要錢，但很少。** AWS 對 Cost Explorer API 每次查詢收 **US$0.01**。
   系統已經快取 6 小時（帳單資料本來就一天才更新一次），一個月大約 NT$1–2。
3. **需要根帳號（root）登入一次。** 第 1 步只有根帳號能做，之後就用一般管理員帳號即可。

---

## 步驟 1：允許 IAM 使用者讀取帳務資訊（根帳號）

> 這步最容易被跳過，而且跳過的話**後面權限給再多都會被擋**，錯誤訊息還只會說 AccessDenied，
> 很難聯想到是這裡沒開。請先做這步。

1. 用 **根帳號（root user，就是註冊 AWS 時的那個 email）** 登入 AWS 主控台
2. 點右上角自己的帳號名稱 → 選 **帳戶（Account）**
3. 往下捲，找到 **IAM 使用者和角色存取帳務資訊（IAM user and role access to Billing information）**
4. 點 **編輯（Edit）** → 勾選 **啟用 IAM 存取（Activate IAM Access）** → **更新（Update）**

> 2023 年以後開的 AWS 帳號預設就是開啟的。看到已經勾好就直接進下一步。

---

## 步驟 2：啟用 Cost Explorer

1. 主控台右上角帳號名稱 → **帳單與成本管理（Billing and Cost Management）**
2. 左側選單點 **Cost Explorer**——**第一次打開這頁就會自動啟用**，不用另外按什麼。
   （舊版介面才有「啟用」按鈕。）打開後直接看到報告畫面＝已啟用。

⏳ **這裡要等。** 剛啟用的帳號 AWS 需要準備歷史資料，**最長 24 小時**才查得到東西。
在這之前系統會顯示「AWS 帳號尚未啟用 Cost Explorer（啟用後約 24 小時才有資料）」，這是正常的，隔天再看。
如果打開就看得到金額和圖表，代表早就啟用過，不用等。

---

## 步驟 3：建立唯讀的查帳權限

有兩條路，**建議走 A**（不用產生金鑰、沒有外洩風險）。
如果找不到執行角色或不確定，走 B 也完全沒問題。

### 路線 A（建議）：直接給 Amplify 的執行角色權限

適合「網站就是部署在 Amplify」的情況。做完不用設任何環境變數，程式會自動用執行角色的身分去查。

1. 進 **AWS Amplify** 主控台 → 選這個 App → **App settings** → **General**
2. 找到 App 使用的 **IAM 服務角色（service role / compute role）**，記下角色名稱
3. 進 **IAM** → **角色（Roles）** → 搜尋剛剛那個角色名稱 → 點進去
4. **新增權限（Add permissions）** → **建立內嵌政策（Create inline policy）**
5. 切到 **JSON** 分頁，貼上：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadCostExplorer",
      "Effect": "Allow",
      "Action": "ce:GetCostAndUsage",
      "Resource": "*"
    }
  ]
}
```

6. 命名為 `ReadCostExplorer` → 建立
7. **重新部署一次** Amplify（讓執行環境重新取得角色權限）

> `Resource` 必須是 `*`：Cost Explorer 的 API 不支援指定資源範圍，這是 AWS 的規定，
> 不是權限開太大 —— 這個 action 本來就只能讀帳單數字。

完成後直接跳到 **步驟 5 驗收**（不需要步驟 4）。

### 路線 B：開一個唯讀 IAM 使用者，用金鑰

1. 進 **IAM** → **使用者（Users）** → **建立使用者（Create user）**
2. 使用者名稱填 `cost-reader`（好認就好）
3. **不要**勾「提供 AWS 管理主控台存取權」—— 這個帳號只給程式用，不需要能登入
4. 下一步的權限頁選 **直接連接政策（Attach policies directly）** → **建立政策（Create policy）**
5. 切到 **JSON** 分頁，貼上上面那段一模一樣的 JSON → 命名 `ReadCostExplorer` → 建立
6. 回到建立使用者的頁面，重新整理政策清單，勾選 `ReadCostExplorer` → 建立使用者
7. 點進剛建好的使用者 → **安全憑證（Security credentials）** → **建立存取金鑰（Create access key）**
8. 用途選 **在 AWS 外部執行的應用程式（Application running outside AWS）** → 下一步 → 建立
9. 畫面會顯示 **存取金鑰 ID** 與 **私密存取金鑰**

> 🔑 **私密存取金鑰只會顯示這一次**，關掉就再也看不到（只能重新產生）。
> 先複製到安全的地方，馬上進步驟 4 貼上。

---

## 步驟 4：把金鑰設成環境變數（只有路線 B 需要）

### 正式站（Amplify）

1. 進 **AWS Amplify** 主控台 → 選這個 App → **App settings** → **Environment variables**
2. **Manage variables** → 新增兩筆：

| 變數名稱 | 值 |
| --- | --- |
| `COST_EXPLORER_ACCESS_KEY_ID` | 步驟 3 的存取金鑰 ID |
| `COST_EXPLORER_SECRET_ACCESS_KEY` | 步驟 3 的私密存取金鑰 |

3. 儲存 → **重新部署（Redeploy this version）**

### 本機開發（選用）

在 `.env` 加上同樣兩行即可：

```
COST_EXPLORER_ACCESS_KEY_ID=AKIA...
COST_EXPLORER_SECRET_ACCESS_KEY=...
```

> ### ⛔ 為什麼名字不能用 AWS 開頭？（2026-08-11 實測撞到）
>
> 兩層限制，缺一不可：
>
> 1. **Amplify 主控台整個擋掉 "AWS" 前綴**：存檔直接跳紅字
>    `Environment variables cannot start with the reserved prefix "AWS"`。
>    第一版取名 `AWS_COST_*`，就是在這裡存不進去才改名的。
> 2. `AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、`AWS_SESSION_TOKEN` 是 **Lambda 的保留變數**
>    （Amplify 的 SSR 就是跑在 Lambda 上），由執行環境自動填入執行角色的臨時憑證，
>    就算設得進去也會被蓋掉，變成「明明設了金鑰卻還是說沒憑證」而且查不出原因。
>
> 所以用 `COST_EXPLORER_` 開頭的專屬名稱，程式會明確地把它們交給 Cost Explorer 用。
> 兩個都留空時，程式才退回去用預設憑證鏈（也就是路線 A 的做法）。

---

## 步驟 5：驗收

1. 進超管後台 → 側欄 **成本總覽**
2. 看「主機花費」區塊：
   - 顯示金額與服務分項 → **成功**
   - 還是顯示「讀不到」→ 對照下面的錯誤訊息表

> 頁面有 **6 小時快取**。剛設定好如果還是舊畫面，等一下或隔天再看；
> 這是為了避免每次重整都付 US$0.01。

---

## 錯誤訊息對照表

畫面上顯示的原因就是實際發生的事，照這張表處理：

| 畫面顯示 | 意思 | 怎麼修 |
| --- | --- | --- |
| 尚未設定 AWS 憑證（需要一組有 ce:GetCostAndUsage 權限的金鑰） | 程式完全找不到任何 AWS 憑證 | 走路線 B 的話，檢查步驟 4 的兩個變數名稱有沒有打錯（是 `COST_EXPLORER_*`，不是 AWS 開頭）、有沒有重新部署 |
| AWS 憑證缺少 ce:GetCostAndUsage 權限 | 找到憑證了，但被 AWS 拒絕 | ①**先確認步驟 1 有做**（最常見）②檢查政策 JSON 有沒有貼對、有沒有真的掛到那個使用者／角色上 |
| AWS 帳號尚未啟用 Cost Explorer（啟用後約 24 小時才有資料） | 步驟 2 沒做，或做了還在等 | 確認有按啟用，然後等滿 24 小時 |
| 這個月份還沒開始 | 選到未來的月份 | 把月份選回本月或過去 |

---

## 這個數字包含什麼、不包含什麼

- **顯示的是「原價」**：真實用量的成本，**不含 AWS 送的折抵金（credits）與退費**。
  帳號還有折抵金時，AWS 帳單的淨額會是 0，只看淨額會誤以為「主機不用錢」，
  折抵一用完金額才突然冒出來——所以主數字刻意用原價，折抵金另外一行寫
  「原價 − 折抵 ＝ 實付」，三個數字對得起來。
- **包含**：這個 AWS 帳號底下**所有服務**的實際花費（Amplify、Lightsail、S3、CloudWatch、SES…）。
  這是 AWS 開給你的帳單金額，不是估算。
- **不包含**：AI（Gemini）、資料庫（Firebase）—— 那兩筆在同一頁的另外兩個區塊，
  也不包含 LINE 官方帳號月費與推播、金流手續費、發票、網域，那些沒有用量可查，要看各平台帳單。
- **分日以 UTC 計**，和台北時間差 8 小時。月總額不受影響，只有跨月當天可能差一點。
- 金額欄位取 **UnblendedCost**（實際帳面金額，依 RECORD_TYPE 把 Credit／Refund 拆出來另計）。

---

## 相關程式碼

| 檔案 | 做什麼 |
| --- | --- |
| `server/utils/aws-cost.ts` | 呼叫 Cost Explorer、把錯誤翻成看得懂的原因 |
| `server/api/admin/super/host-costs.get.ts` | 端點本身，含 6 小時快取與三態（ok／unavailable） |
| `app/pages/admin/super/costs.vue` | 成本總覽頁的「主機花費」區塊 |
| `nuxt.config.ts` | `awsCostAccessKeyId` / `awsCostSecretAccessKey` 兩個 runtimeConfig |
