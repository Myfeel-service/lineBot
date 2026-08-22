# 通知信（AWS SES）開通教學——照著做就好

> 對應 STATUS `B-24`（網域驗證）→ `B-25`（離開沙盒）→ `B-12`（填變數開通）。
> 寫給要實際操作的人（老闆），全程不用改程式——程式早就寫好了，只是寄不出去。
> 參考同款教學：`docs/AWS-COST-SETUP.md`（成本金鑰那次也是這樣一步步走通的）。

## 為什麼要做這件事

程式裡有五種信已經寫好、隨時會寄，但現在**一封都寄不出去**（環境變數沒設，程式會直接略過並在 log 留一行）：

| 信 | 什麼時候寄 | 沒有它會怎樣 |
|---|---|---|
| 付款收據 | 每次付款成功後 | 客戶付了錢沒有任何憑據信，觀感差 |
| 續扣前提醒 | 自動扣款前 3 天 | 「怎麼又扣我錢」的客訴 |
| **扣款失敗通知** | 卡片扣不過的當下（只寄第一次） | **最痛的一個**：卡過期的客戶完全不知道，3 天寬限期過了就被降回免費方案＝靜默流失，我們也不知道 |
| 額度通知 | 額度用到 80%／100% | 客戶不知道 AI 已停、訊息全轉真人 |
| 降級通知 | 寬限期滿降級時 | 客戶發現功能消失才來問 |

## 先搞懂三個名詞（30 秒）

- **SES**＝AWS 的寄信服務。我們主機本來就在 AWS，用它最順、也最便宜（一千封約 NT$3，我們的量趨近免費）。
- **網域驗證（DKIM）**＝跟 AWS 證明「lineminime.com 是我們的」，做法是去 DNS 加三筆紀錄。不做這步，信寄不出去或全進垃圾桶。
- **沙盒**＝SES 新帳號的預設狀態：**只能寄給你自己驗證過的信箱**，真客戶一封都收不到。要「申請離開沙盒」，AWS 人工審核、通常一兩個工作天。

## 正確順序（兩件事可以同時做）

**第 1 步和第 2 步互不相依，建議同一天一起發動**——第 2 步要等 AWS 審核，早送早過。

### 第 1 步：驗證網域（B-24）

1. 進 AWS 主控台 → 搜「SES」→ 左邊「**身分**（Identities）」→「**建立身分**」。
   ⚠️ 右上角**區域**選 **ap-northeast-1（東京）**——跟我們其他服務同區，之後不用記第二個區域。
2. 類型選「**網域**」，填 `lineminime.com`，其他預設值直接建立。
3. 建立後 AWS 會給 **3 筆 CNAME 紀錄**（DKIM 用）。
4. 到管理 lineminime.com DNS 的地方，把這 3 筆 CNAME 原樣加進去。
   ⚠️ 這步的卡點是「**誰有 DNS 權限**」，不是技術——加紀錄本身一分鐘。
5. 等 AWS 顯示「已驗證」（通常幾分鐘到幾小時，DNS 生效快慢決定）。

### 第 2 步：申請離開沙盒（B-25）

1. SES 主控台 → 左邊「**帳戶儀表板**」→ 上方會有沙盒提示 →「**申請生產存取權**（Request production access）」。
2. 表單怎麼填（照抄改一改就好）：
   - Mail type：**Transactional**（我們只寄交易通知，不寄行銷信）
   - Website URL：`https://lineminime.com`
   - Use case description（英文，範例）：
     > We send transactional emails only: payment receipts, subscription renewal reminders, failed-payment notices, and quota alerts for our SaaS customer-service platform. Volume is low (well under 1,000/month). All recipients are paying customers who registered on our platform. We do not send marketing email.
   - 預估量照實填（每月幾百封以內）。
3. 送出後等 AWS 回信，**通常 1～2 個工作天**。沒過會問追加問題，照實回就好。

### 第 3 步：給主機寄信的權限

程式**刻意不用金鑰**寄信（走執行角色，比 COST_EXPLORER 那組金鑰更省事），所以要讓 Amplify 的執行角色有 SES 權限。

⚠️ **2026-08-17 實況更正**：Amplify 的 SSR 主機**預設沒有掛任何角色**——IAM 角色清單裡只會看到三個 AWS 系統自動建的服務角色（ResourceExplorer／Support／TrustedAdvisor），找不到 amplify 開頭的是正常的。所以要**先建、再掛、再加權限**：

1. **讓 Amplify 建角色**：Amplify 主控台 → 該 App → 左側「應用程式設定」→「**IAM 角色**」→ 找「**運算角色**（Compute role）」區塊（⚠️ 不是「服務角色」，那是給建置部署用的）→ 按編輯，選「**建立並使用新的服務角色**」讓 Amplify 自動建（信任關係它會自己設對）。
   - 若這頁只能挑現有角色、沒有自動建立選項：回 IAM →「建立角色」→ 信任實體選「自訂信任政策」貼：
     ```json
     {
       "Version": "2012-10-17",
       "Statement": [{ "Effect": "Allow", "Principal": { "Service": "amplify.amazonaws.com" }, "Action": "sts:AssumeRole" }]
     }
     ```
     權限先不加直接下一步，名稱取 `amplify-ssr-email-role`，建好回 Amplify 的運算角色選它。
2. **加寄信權限**：IAM → 「角色」→ 點開剛建的那個角色 → 「新增許可」→「建立內嵌政策」→ 切 JSON 貼：
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{ "Effect": "Allow", "Action": ["ses:SendEmail"], "Resource": "*" }]
   }
   ```
3. 命名如 `send-transactional-email`，儲存。
4. 角色是部署時掛上去的——**接下來第 4 步設完環境變數重新部署那一次，會一併生效**，不用多部署一輪。

（若之後 log 出現 `AccessDenied`，就是這步沒做到、掛錯角色，或掛完沒重新部署。）

### 第 4 步：設環境變數＋重新部署（B-12）

Amplify 主控台 → 該 App → 環境變數，加：

| 變數 | 值 | 說明 |
|---|---|---|
| `EMAIL_FROM` | `MiniMe <noreply@lineminime.com>` | 寄件人。**網域必須是第 1 步驗證過的那個**；`noreply@` 這個信箱不必真的存在 |
| `EMAIL_REPLY_TO` | `service@myfeel-tw.com`（選填） | 客戶按「回覆」時信寄到哪；不設就是不可回覆 |

⛔ **不要設 `AWS_SES_REGION`**——Amplify 擋所有 `AWS` 開頭的變數（跟 `A-9` 成本金鑰同一個坑）。
程式的讀取順序是 `AWS_SES_REGION` → `AWS_REGION`，而 **Amplify 執行環境本來就有 `AWS_REGION`**，什麼都不用做。
（本機 `.env` 測試時才需要自己設 `AWS_SES_REGION=ap-northeast-1`。）

設完**重新部署一次**（跟 `B-6` 自動扣款開關同理：環境變數是部署時吃進去的，改了不部署＝沒改）。

### 第 5 步：驗證真的通了

1. **還在沙盒等審核時就可以先測**：SES「身分」→「建立身分」→ 類型選「**電子郵件地址**」→ 填自己的信箱 → 去收驗證信點連結。之後用這個信箱當客戶 email 走一筆測試付款，收據信應該進來。
2. 離開沙盒後，正式判準是 log：原本每次付款會有一行 `[email] 未設定 SES（EMAIL_FROM / AWS_SES_REGION），略過寄信`，**這行消失＝設定生效**；寄失敗會有 `[email] 寄信失敗` 加原因。
3. 寄信失敗**不會**影響收款與開通（程式刻意吞掉），所以測試期間不用擔心弄壞金流。

## 常見錯誤對照

| 症狀 | 原因 | 解法 |
|---|---|---|
| log：`Email address is not verified` | 還在沙盒（收件人沒驗證）或 FROM 網域沒驗證 | 等第 2 步審核過；或先照第 5 步驗證收件信箱測試 |
| log：`AccessDenied` | Amplify 執行角色沒有 SES 權限 | 第 3 步 |
| log 還是「未設定 SES，略過寄信」 | 環境變數沒吃到 | `EMAIL_FROM` 拼字、以及**改完有沒有重新部署** |
| 信進垃圾桶 | DKIM 沒生效 | 回第 1 步看三筆 CNAME 是否都「已驗證」 |
