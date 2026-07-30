# PAYUNi 每月自動扣款 — 設計文件

> 狀態:**P1~P5 程式全部完成,含解約(§8.4④)。已跑對抗式 code review 並修完 14 條確認缺陷(§8.6)。522 測試綠、typecheck 0。程式面已無未知。**
>
> 🚧 **沙盒驗證卡在權限**:`UPP02087 商店未提供約定信用卡幕後交易`
> → **要向 PAYUNi 開通「約定信用卡幕後交易」(沙盒+正式,正式另需綁授權 IP)**,否則首刷一行都驗不了。
> 後台另有一套「續期收款」(金流端排程、固定金額),**不是同一件事、也建議不要改用**,見 §12。
>
> 沙盒金鑰在 `.env`(S076820628)。**開發**不需等 PAYUNi（P1–P5 已證明）;**驗證需要**。2026-07-30。
> 目的:規劃「每月自動扣款(#3)」，並讓「降級期末生效(#2)」「退費折抵下一期(#1)」蓋在其上。
> 對應決策:老闆 2026-07-29 拍板 #1 折抵不退現金、#2 降級期末生效、#3 要自動扣款。

---

## 0. 一句話總結(白話)

PAYUNi 的自動扣款**不是**「金流按月自動幫你扣、金額固定」，而是「**首刷過一次 3D 驗證後，把卡片存成一組 Token；之後每個月由『我們的系統』主動拿這組 Token 去扣款，金額我們每期自己決定**」。

這對我們是**好消息**:
- 每期金額我方可變 → 折抵、降級、加減額度都只是「這期少扣一點」，不用大動作。
- 失敗方向安全 → 系統若出事，就是「這期沒扣到」(頂多少收錢)，**不會**變成「服務停了、卡卻一直被扣」的爭議款。後者正是金流排程模型最可怕的地方。

代價:**排程與觸發扣款的責任在我方**——要有一支可靠的排程，每期在對的日子去扣款。

---

## 1. 現況(調查結論)

- 生產環境目前只有 **PAYUNi 單次付款**在跑。每期客人自己回來刷一次。
- 系統裡確實有一整套定期定額程式，但**全部是寫給藍新(newebpay)的**，且被 `nuxt.config.ts` 寫死的 `recurringEnabled=false` 整條關掉。PAYUNi 側 **recurring 零程式碼**。
- `create-subscription.post.ts` / `cancel-subscription.post.ts` 這兩支是**藍新版死碼**(import 藍新、被旗標+未設金鑰雙重擋住)。
- 訂閱資料內嵌在 `workspaces/{id}.subscription`(型別 `WorkspaceSubscription`，見 `shared/billing/plans.ts`)，已有 `anchorDay / currentPeriodStart/End / autoRenew / cancelAtPeriodEnd / status` 等欄位——**這些全部可重用**。
- 週期推進:`rollSubscriptionToCurrentPeriod`(`shared/billing/period.ts`)是真相來源(讀取時就地推算)；`runPaymentReconcile`(`server/utils/payment.ts`)由 EventBridge cron + middleware tick 觸發落地。
- **完全沒有** credit/餘額/折抵概念，需新加。

---

## 2. PAYUNi 的自動扣款模型(查證結果)

來源:PAYUNi 官方 PHP SDK(github.com/payuni/PHP_SDK)mode 清單與 examples、官方 API base(現有 `server/utils/payuni.ts` 已在用)。

**API 結構**(與現有單次付款相同,`payuni.ts` 已具備):
- 端點:`https://api.payuni.com.tw/api/{mode}`(測試 `sandbox-api.`)。已知 `/api/upp`、`/api/trade/query` 皆此模式。
- 加密:AES-256-GCM → `EncryptInfo`；檢查碼 `HashInfo = SHA256(merKey + EncryptInfo + merIV)`；外層 `{ MerID, Version, EncryptInfo, HashInfo }`。**現有 `payuni.ts` 的 encrypt/decrypt/hash 全部可直接重用。**

**與 recurring 有關的 mode**:
| mode | 用途 | 端點 |
|---|---|---|
| `upp` | 整合支付頁(首刷、過 3D) | `/api/upp` |
| `credit` | **信用卡幕後扣款**(用卡片資料或 Token 直接扣) | `/api/credit` |
| `credit_bind_query` | 查詢已綁定的約定 Token | **`/api/credit_bind/query`** ✅ 已實測存在 |
| `credit_bind_cancel` | 取消 Token(約定／記憶卡號) | **`/api/credit_bind/cancel`** ✅ 已實測存在 |
| （後台「續期收款」） | 金流端排程的定期扣款(**另一套模型**,見 §12) | `/api/period`、`/api/period/query` ✅ 存在但**未開通** |
| `trade_close` | **請退款**(帶 `TradeNo` + `CloseType`) | `/api/trade_close` |
| `trade_query` | 交易查詢(現有單次已在用) | `/api/trade/query` |

> ✅ **端點已用探針掃出來(2026-07-30)**。原本寫的 `trade_bind_*` 是錯的,SDK 的 mode 名是
> `credit_bind_query` / `credit_bind_cancel`,而**實際 URL 是「底線 + 斜線」**——與 `trade/query`
> 同一套規則。掃描判準:回 JSON = 路徑存在;回 HTML 前端頁 = 路徑不存在。
>
> | 路徑 | 結果 |
> |---|---|
> | `/api/credit_bind/query` | ✅ 存在 |
> | `/api/credit_bind/cancel` | ✅ 存在 |
> | `/api/credit_bind_query`、`/api/credit/bind_query`、`/api/trade/bind_query` | ❌ 不存在 |
>
> **必填欄位（靠錯誤訊息逼出來的）**:
> - `credit_bind/query`（Version **1.0**）:`CreditToken` **或** `CreditHash` **擇一**
>   （只給 MerID → `QUERY02001 綁定Token|Hash，請擇一送入`;給了假值 → `QUERY03001 查無符合綁定資料`
>   = 格式與權限都沒問題）。
> - `credit_bind/cancel`（Version **1.0**;帶 1.3 → `API00003` 版本錯):
>   `MerID` / `UseTokenType` / **`BindVal`** / `CreditTokenType`(選填) / `Timestamp`
>   - `UseTokenType`:**1=綁定(約定)、2=記憶卡號**（給 3/4 → `CANCEL02006 綁定類型，格式錯誤`;不給 → `CANCEL02005 未有綁定類型`）
>     ⚠️ 值域與 UPP 建約定時的 `UseTokenType` **不同**（UPP 有 3=強制約定,這裡沒有）。
>   - **`BindVal` = 那個「綁定唯一值」**(官方文件 Ver 1.0 確認)。要放哪個由 `UseTokenType` 決定:
>     **約定(1) → 放 `CreditHash`**;記憶卡號(2) → 放 `CreditToken`。
>     （這個欄位名猜了 30+ 個都不對——`Bind*`/`Token*`/`*No`/`*Id` 全試過。教訓:欄位名沒把握就去要文件,別暴力猜。）
>   - `CreditTokenType`:1=會員(預設)、2=商店。我方首刷送 2 → 解約也帶 2。
>   - **實測(2026-07-30)**:用真實作打沙盒 + 假 Token → `CANCEL03001 取消失敗，查無符合約定資料`
>     = 欄位與格式全對(已納入 `notFound` 判斷:查無 = 與成功等價,可直接清掉我方 Token)。

**已對實的關鍵欄位**(2026-07-29 官方 API 文件「信用卡幕後Token交易 CREDIT V1.3」截圖確認):
- **首刷建立約定**:走 UPP(整合式支付頁)首次交易、持卡人同意約定 → 交易回傳 **`CreditHash`**(= 信用卡 Token;PAYUNi 加密存卡,商店拿不到完整卡號),另回 **`CreditLife`**(Token 有效期 MMYY)、`Card4No`(末四碼)。
- **每期幕後續扣**:`POST /api/credit`,**Version 固定 1.3**,header 帶 `user-agent: payuni`。EncryptInfo 必填 `MerID / MerTradeNo(≤25,[A-Za-z0-9_-],10 分鐘內不重複) / TradeAmt(int) / Timestamp / ProdDesc(≤550)`;續扣帶 **`CreditHash`**(那組 Token)即扣該卡。**`TradeAmt` 每筆自訂** → 折抵/降級直接改這個數字,不需重建約定。
- **回應**:外層 `Status`(SUCCESS / UNKNOWN / UNAPPROVED);EncryptInfo 內 `TradeStatus`(1=已付款/2=失敗/3=取消/8=待確認)、`Card4No`、`AuthCode`、`CreditHash`(續用)、`CreditLife`。
- ⚠️ **UNKNOWN 非同步**:銀行 60 秒沒回 → 先回 `UNKNOWN`,之後 Notify 到 `NotifyURL`,或我方 15 分後用 `trade_query` 補查。續扣流程必須納入這條(沿用現有 `reconcilePayuniPending` 對帳模式)。
- **取消約定**:`/api/credit_bind/cancel`(帶 `UseTokenType` + **`BindVal`**,見上方欄位表);**退款**:`trade_close`(`TradeNo` + `CloseType`)。
- PAYUNi 的 `/api/credit` 也能帶發票(`CarrierType/CarrierInfo/InvBuyerName`)與優惠券(`PromoCode/DiscountAmt`)欄位——但**我方發票走光貿、折抵用自算 `TradeAmt`,故這些 PAYUNi 欄位一律不帶**。

---

## 3. 目標架構:三條核心流程

### A. 首刷 — 建立約定 Token(客人按下訂閱)
1. 客人在方案對話框按「開始訂閱」(已勾同意條款,存 `termsAcceptedAt/termsVersion`)。
2. 後端建 `paymentOrder`(kind=`period_first`)、走 `/api/upp`(Version 2.0)導客人去 PAYUNi 付款頁,EncryptInfo 帶 `Credit=1 / UseTokenType=3 / CreditToken=<workspaceId> / CreditTokenType=2`(見 §10)。首刷會過 3D。
3. PAYUNi 付款成功 → Notify(server→server)回來,內含 **`CreditHash`**(約定 Token)、`CreditLife`(有效期 MMYY)、`Card4No`(末四碼)。
4. 我方 `fulfillPayuniTrade` 收單:開通本期訂閱、把 `CreditHash`/`CreditLife`/末四碼存進 `subscription`、`autoRenew=true`、開發票。

> 重用:現有 PAYUNi 單次的 `buildUppForm` + `/payuni/notify` + `fulfillPayuniTrade` 幾乎照用，只多「請求 Token」與「存 Token」兩步。

### B. 每期續扣 — 我方主動幕後扣款(排程觸發)
每期在錨定日,由排程觸發:
1. `runPaymentReconcile` 找出「本期即將到期 / 已到期、`autoRenew=true`、`!cancelAtPeriodEnd`、有 `CreditHash`」的訂閱。
2. 決定**下期方案** = `pendingPlanId ?? planId`(降級在此生效，見 §4)。
3. 決定**扣款金額** = `plan.priceMonthly − 折抵(min(creditBalance, price))`(折抵在此套用，見 §4)。
4. 建 `paymentOrder`(kind=`period_recurring`)。
5. 呼叫 `credit` 幕後扣款(`CreditHash` + 金額)。**同步**拿到結果(不像藍新要等 webhook)。
6. 成功:滾到下一期、套用 `pendingPlanId`、扣掉已用折抵、開發票、寄收據。
7. 失敗:進 `past_due` 寬限期、隔日重試 N 次、寄提醒；寬限期滿仍失敗 → 降回免費層。

> 這條**比藍新單純**:不需要 `period-notify` webhook(改成同步扣款 + 對帳補救)，更接近現有 `reconcilePayuniPending` / `fulfillPayuniTrade` 的既有模式。

### C. 取消 / 卡失敗
- **客人取消**:寫 `autoRenew=false, cancelAtPeriodEnd=true`(沿用現成機制)。期末 roll 時 `downgradeToFree`,**同時** `credit_bind/cancel` 解約並清掉 Token(見 §8.5——刻意在期末才解,不在按下取消時解)。
- **卡失敗**:同 §B step 7。因為是我方主動扣、失敗即知，不會有「背景一直扣」的問題。

---

## 4. #2 降級、#1 折抵 如何落在此模型(這就是為什麼要先做 #3)

**#2 降級期末生效**:
- 降級時**不**立即換方案，改寫 `subscription.pendingPlanId = 目標方案`(新欄位)。
- 期末續扣(§B step 2)時，用 `pendingPlanId` 當下期方案扣款、開通，並清掉 `pendingPlanId`。
- 沿用 `cancelAtPeriodEnd` 那一套「期末才生效」的模式，只是把「降到免費」一般化成「降到指定方案」。
- 客人本期照舊用到底、剩餘天數不蒸發 → 符合老闆決策。移除對話框「立即生效、不折抵」警告。

**#1 退費折抵下一期**:
- 新增 `subscription.creditBalance`(整數，含稅元)。超管開折抵 → `creditBalance += X`。
- 期末續扣(§B step 3)時，`扣款金額 = price − min(creditBalance, price)`，並把用掉的折抵從 `creditBalance` 扣除。
- **稅務**:折抵是「下期少收錢」→ 下期發票就開少收後的實收金額，原發票完全不動、不用折讓。乾淨。
  - (對照:發票折讓 `allowance.post.ts` 是另一回事——那是要對「已開的原發票」做稅務沖銷，用於退現金/整筆取消。折抵下一期不需要動它。)

> 沒有 #3(每期我方可變金額的扣款),#1/#2 就得靠「終止舊約定→用新價重建約定」這種脆弱時序;有了 PAYUNi token 模型,兩者都只是「下期扣款時金額算不一樣」。

---

## 5. 資料模型改動

`WorkspaceSubscription`(`shared/billing/plans.ts`)新增:
- `payuniCardToken?: string`（= `CreditHash`；有值 = 背後有生效中的約定，取代藍新的 `periodNo`/`periodOrderNo` 語意）
- `payuniCardLast4?: string`（卡別末四碼，UI 顯示「扣款卡 ****1234」用）
- `pendingPlanId?: BillingPlanId | null`（#2:排程於期末生效的方案）
- `creditBalance?: number`（#1:可折抵下期的餘額，含稅元）

`hasMandate`(billing.ts 衍生給前端判斷「能不能取消」)改成看 `payuniCardToken` 是否存在。

`paymentOrder`:沿用現有 `kind`(`period_first`/`period_recurring`)、`amount` 欄位，無需改型別。

---

## 6. 重用 vs 新增(對照現有檔案)

**可直接重用**:
- `server/utils/payuni.ts` 的 encrypt/decrypt/hash/`buildUppForm`(加解密與外層封裝完全相同)。
- `server/routes/payuni/notify.post.ts` + `fulfillPayuniTrade`(首刷收單,只多存 Token)。
- `shared/billing/period.ts` 的 `rollSubscriptionToCurrentPeriod` / `downgradeToFree` / 寬限期邏輯。
- `runPaymentReconcile` 的排程骨架(在裡面新增「續扣 due 訂閱」步驟)。
- 發票開立(`issueInvoiceForOrder`)、帳單 email。

**要新增(PAYUNi 版)**:
- `payuni.ts`:`buildCreditCharge`(幕後扣款 `credit`)、`buildBindCancel`(`credit_bind/cancel`)。
- UPP 首刷帶「建立約定」旗標 + 從 Notify 取 `CreditHash`/`Card4No`。
- `create-subscription.post.ts` / `cancel-subscription.post.ts`:**改接 PAYUNi**(現藍新版死碼可一併移除或封存)。
- `runPaymentReconcile` 內新增 `chargeDueRecurring()`:找 due 訂閱 → `credit` 扣款 → 結算。
- `recurringEnabled`:從寫死 `false` 改成「PAYUNi 金鑰齊 + 明確開關」計算。

**藍新遺留**:`newebpay-period.ts`、`newebpay/period-notify.post.ts`、`create/cancel-subscription` 藍新分支 → 全數變死碼，建議 Phase 4 清掉(非阻塞)。

---

## 7. 風險與防呆(必做)

1. **扣款冪等**:每期 `paymentOrder` 用「訂閱ID + 期別」當唯一鍵，防排程重跑重複扣款。`credit` 呼叫前先檢查本期是否已有成功單。
2. **扣款失敗重試 + 上限**:失敗進 `past_due`、每日重試、�bounded 次數、寄提醒;寬限期滿降級。避免無限重試打爆卡。
3. **Token 遺失/失效**:卡過期或被銀行撤銷 → `credit` 回失敗 → 走 §C。UI 要有「更新付款方式(重新綁卡)」入口(重跑一次 UPP 首刷拿新 Token)。
4. **排程可靠度**:續扣靠排程,排程沒跑 = 這期沒扣到(安全方向,但要監控)。錨定日 + 寬限期給緩衝;`rollSubscriptionToCurrentPeriod` 的就地推算保證額度重置不依賴排程。
5. **對帳**:`credit` 同步結果 + 事後 `trade_query` 補查(漏接時),沿用 `reconcilePayuniPending` 模式。
6. **發票**:每期扣款成功才開發票、金額 = 實扣(已折抵)金額。冪等鍵沿用 `merchantOrderNo`。
7. **稅務一致**:折抵走「下期少收」不動原發票;退現金(若未來要)才走 `trade_close` + 發票作廢/折讓。兩條路不可混。
8. **灰度**:整條藏在 `recurringEnabled` 後,先沙盒帳號跑通「建約定→續扣→降級→折抵→取消→卡失敗」六條路徑,再對單一測試租戶開,最後全開。

---

## 8. 分階段實作計畫

| Phase | 內容 | 產出 / 驗收 | 狀態 |
|---|---|---|---|
| **P1 對實** | 沙盒跑通:UPP 建約定拿 `CreditHash`、`credit` 用 Token 扣款、解約。把 §10 的待確認欄位釘死。 | 一支沙盒實測腳本全綠 | ✅ 完成（`/api/credit` 與 `credit_bind/cancel` 探針皆已通) |
| **P2 首刷+存 Token** | UPP 首刷帶建約定旗標、Notify 存 `CreditHash`/末四碼、開通+開發票。前端訂閱按鈕改走 PAYUNi。 | 沙盒訂閱首期成功、Token 落庫 | ✅ 程式完成（§8.1）· 🚧 **沙盒被 `UPP02087` 擋住,待 PAYUNi 開通權限才能驗**（見 §10 更正） |
| **P3 每期續扣** | `chargeDueRecurring()` 進 reconcile、冪等、失敗重試、寬限期、續扣開發票+收據。 | 沙盒跨期自動扣款成功、失敗路徑正確 | ✅ 程式完成（§8.2）· 🚧 同上待權限 |
| **P4 降級+折抵** | `pendingPlanId`(#2)、`creditBalance`(#1)注入續扣金額;超管開折抵 UI;降級改期末。 | 降級/折抵沙盒驗證 | ✅ 程式完成（§8.3）· 🚧 同上待權限 |
| **P5 取消+換卡** | 取消、更新付款方式(重綁卡)、清藍新死碼。 | 全六路徑綠 → 正式開旗標 | ✅ 程式完成（§8.4）· ⬜ 只剩「向 PAYUNi 解除約定」待端點確認 |

### 8.1 P2 實作落點（2026-07-30）

灰度開關 **`PAYUNI_PERIOD_ENABLED`**（server `payuniPeriodEnabled` + public `recurringEnabled` 同源）。
留白 = 現行單次付款,行為一行不變。

| 檔案 | 改了什麼 |
|---|---|
| `payuni.ts` | `PAYUNI_UPP_TOKEN_VERSION='2.0'`、`buildTokenBindFields`（`Credit=1`/`UseTokenType=3`/`CreditToken`/`CreditTokenType=2`）、`sanitizeCreditTokenRef`、`parseCardMandate` |
| `create-order.post.ts` | 旗標開 → `kind='period_first'`＋帶建約定欄位＋UPP 2.0＋建單時定 `anchorDay`；`findRecentPendingOrder` 加比對 kind |
| `payment.ts` | `buildPaidSubscription` 收 `payuniCard`（存 Token/末四碼/有效期、開 `autoRenew`、**沿用**既有 Token）；`settlePaidOrder` **以訂單 kind 為閘門**、回報 `cardBindFailed` |
| `payuni-fulfill.ts` | 攤出 `CreditHash` 交給 settle；首期未建成約定 → `console.error` 告警 |
| `billing.ts` / `plan-state.ts` | `hasMandate` 改看 `payuniCardToken`（或舊藍新委託）、新增 `cardLast4` |
| `cancel-subscription.post.ts` | PAYUNi 分支:取消**不需打金流**（扣款由我方排程發動）→ 只寫 `autoRenew=false/cancelAtPeriodEnd=true`,Token 保留給解約與恢復 |
| `AdminPlanUpgradeDialog.vue` / `billing.vue` | 結帳一律走 `create-order`（藍新 `create-subscription` 不再被觸及）；帳單頁顯示「扣款卡 •••• 1234」 |

**刻意的三個防呆**（每一個都對應一種會上新聞的錯）:
1. **`UseTokenType=3`（強制約定）**:用 `1` 客戶可在 PAYUNi 頁自行取消約定 → 收了首月卻沒委託的靜默失敗。
2. **只有 `kind='period_first'` 才存 Token**:單次付款若也照收 `CreditHash`,會把「只想買一期」的客人悄悄變成每月扣款。
3. **沒拿到 Token 就不開 `autoRenew`**,並回報 `cardBindFailed`:否則期末會等一筆永遠不會發生的續扣,把人卡到降級。

**P2 剩下的**:沙盒實刷一筆訂閱首期,確認 UPP 2.0 回應真的帶回 `CreditHash`/`Card4No`/`CreditLife`（程式已照官方文件對欄位,但**沒對真交易驗過**）。**目前被 `UPP02087` 擋住,必須先讓 PAYUNi 在沙盒特店開通「約定信用卡幕後交易」**（見 §10 更正）。

### 8.2 P3 實作落點（2026-07-30）

新檔 `server/utils/payuni-recurring.ts`,掛進 `runBillingReconcile` 的第 ③ 步（**必須在 roll 之後**——是 roll 把到期的自動續訂標成 `past_due`,續扣照這個狀態挑人）。

| 元件 | 說明 |
|---|---|
| `isDueForRecurringCharge(sub, today)` | 純函式真值表:`past_due` + `autoRenew` + 未取消 + 有 Token + 自助付費方案 + 今天沒試過。active 不扣、取消不扣、免費/企業/內部不扣 |
| `recurringOrderNo(ws, periodStart, attemptDate)` | `R`+雜湊6+期6+日6 = **19 碼**（被「發票自訂編號 ≤20」綁死）。同帳號同期同天 → 同單號 → `create()` 撞 = 擋掉重複扣款;隔日重試自然換號（滿足 MerTradeNo 10 分鐘不重複） |
| `chargeDueRecurring(config, now, db)` | claim → 建本期帳 → `/api/credit` → `fulfillPayuniTrade` |
| `settlePaidOrder` | **`kind='period_recurring'` 改走 `confirmRenewal`** |

**三層防重複扣款**（設計 §7.1 的落實）:
1. **claim**:transaction 內把 `lastChargeDate` 寫成今天 → 另一路（cron / middleware tick）看到就跳過。同時就是「每日只重試一次」的節流。
2. **訂單冪等鍵**:單號由 (帳號, 本期起日, 嘗試日) 決定,`create()` 撞到即跳過、不扣款。
3. **狀態**:成功後 `status → active`,下一輪查詢不會再選到。

**一個會讓客戶一次扣款拿到兩個月的坑（已修）**:續扣**不能**用 `buildPaidSubscription`。到期時 roll 已把訂閱推進新一期,那支會判定「同方案未到期 → 期間堆疊」再往後推一期。續扣要的是 `confirmRenewal`（把**已經滾進來的這一期**確認為 active）。已加測試釘住。

**UNKNOWN 不當失敗**:PAYUNi 回 `UNKNOWN`（銀行 60 秒未回）或呼叫本身丟錯 → 訂單留 `pending`、不標失敗、不重扣,交給 `reconcilePayuniPending` 用 `trade/query` 補查（走與 Notify 相同的開通路徑）。當成失敗去重扣 = 可能扣兩次。

**失敗路徑**:維持 `past_due`（額度照給、服務照跑）→ 寫回 `lastChargeError` → 帳單頁顯示真實原因 → 只在**第 1 次**失敗寄提醒信（每天重試都寄會變騷擾）→ 寬限期（`GRACE_DAYS=3`）滿了由 roll 自然降回免費層（不在續扣裡數次數、不在這裡動方案）。

**新增訂閱欄位**:`lastChargeDate` / `chargeAttempts` / `chargePeriodStart` / `lastChargeError`。

### 8.3 P4 實作落點（2026-07-30）

規則全部收斂在新檔 `shared/billing/recurring.ts`（純函式,前後端共用）:
`resolveNextPeriodPlanId`(下期方案 = `pendingPlanId ?? planId`)、`resolveRecurringCharge`(金額 = 月費 − min(折抵, 月費))、`isDowngrade`。
**排程與帳單頁讀同一支** → 畫面說「下次扣 NT$299」就真的扣 299;兩邊各自重算就會變成客訴。

| 面向 | 落點 |
|---|---|
| #2 降級期末生效 | `POST /api/payment/schedule-plan-change`(只寫 `pendingPlanId`,不收錢不動本期);續扣建單時解析成 `order.planId` → `settlePaidOrder` 開通並清掉排程 |
| #1 折抵 | `POST /api/admin/super/grant-credit`(transaction + `billingCredits` 稽核集合);續扣建單時算進 `amount` 並把用掉的量寫進 `order.creditApplied`;結算時依**訂單上的值**扣餘額 |
| 客戶端 UI | 升級對話框:有委託時降級鈕變「期末降級」、不需勾同意（沒有新交易）;帳單頁顯示下次扣款**金額**、已預約的期末降級（可取消預約）、折抵餘額 |
| 超管 UI | 金流總覽頁「開折抵」對話框（可填負數沖銷,餘額不進負） |

**刻意的取捨**:
- **折抵蓋滿整期 → 不呼叫金流、不開發票**。0 元請款會被金流退;而且那筆錢先前已收過並已開票,再開一張 0 元發票沒有稅務依據。訂單記 `invoiceStatus: 'skipped'` + `paymentType: 'CREDIT_BALANCE'` 留痕。
- **折抵以訂單上的 `creditApplied` 為準,不在結算時重算**。重試／查單補救走同一條路時才不會重複扣或漏扣餘額。
- **`schedule-plan-change` 只接受降級**。升級要立即生效（客戶要的是現在就有額度）→ 走 `create-order`。沒有自動續扣的帳號直接擋下並說清楚,不給他一個永遠不會生效的假排程。

**過程中抓到並修掉的第二個真 bug**:`buildPaidSubscription` 用 `newSubscription()` 重建訂閱,**沒把 `creditBalance` 帶過來** → 客戶只要再付一次款（升級／手動續費）,我們就順手把欠他的折抵刪掉。那是拿走客戶的錢,不是「重新起算一期」的一部分。已修 + 測試。
（對比:`pendingPlanId` 刻意**不**帶——客戶剛主動換了方案,期末不該再把他剛買的方案降回舊排程。）

### 8.4 P5 實作落點（2026-07-30）

**① 換卡入口（更新付款方式）**
PAYUNi 的約定 Token 綁在「一次真實付款」上——要換卡就得再跑一次 UPP 首刷,由客戶輸入新卡並過 3D,回來的新 `CreditHash` 覆蓋舊的（`buildPaidSubscription` 的 card 邏輯已支援覆蓋）。所以**換卡一定伴隨一期付款**,文案必須講清楚,否則客戶會覺得被莫名收費。兩處入口:帳單頁自動續訂列的「更新付款方式」、以及**扣款失敗警示框內的「換一張卡付款」**（卡不能用的當下就給出路,不然客戶只能等被降級再找客服）。

兩種狀態的效果不同,對話框分別講明:
- `past_due`（扣款失敗中）→ 本期本來就沒收到錢 → 這筆是補繳,新一期**從今天起算**。
- `active`（一切正常）→ 期間堆疊 → 等於**提前付下一期**,已付天數不消失。

> ⚠️ 若日後查到 PAYUNi 支援 0 元／1 元純綁卡,這裡就能改成不收錢的換卡（官方文件目前沒查到）。

**② 順手修掉的第三個真 bug**:`past_due` 的訂閱**不該堆疊**。原本 `buildPaidSubscription` 只要「同方案 + 未到期」就堆疊,而 past_due 正是「已滾進新一期但**這一期還沒收到錢**」——堆疊等於假設你已付到期末,於是把新買的一期接到到期日之後,客戶付了錢卻拿到一段未來期間,而沒付款的本期照樣在寬限期滿被降級。已加 `status !== 'past_due'` + 測試。

**③ 取消訂閱**:PAYUNi Token 模型下取消**不需要呼叫金流**——扣款由我方排程發動,排程看到 `cancelAtPeriodEnd` 就不扣,只寫 DB 就真的停了,而且失敗方向安全（寫失敗 = 沒取消成功,客戶再按一次）。藍新當初必須「先終止委託成功才寫 DB」的風險結構性消失了。取消時一併清掉 `pendingPlanId`（期末都要降級了,留著等於兩個互相矛盾的指示）。
**解約已實作**(見下方 ⑤):但刻意**不在按下取消時解**——客戶本期還能用,而且可能反悔想恢復訂閱,那時還需要這組 Token。

**④ 清藍新定期定額死碼**（整塊移除,它從未真正開通過）:
- 刪檔:`server/utils/newebpay-period.ts`、`server/routes/newebpay/period-notify.post.ts`、`server/api/payment/create-subscription.post.ts`
- 刪函式/管線:`settleRecurringAuth`、`runPaymentReconcile` 的 `periodCfg` 參數與「降級時終止委託」段、`buildPaidSubscription`/`settlePaidOrder`/`createPendingOrder` 的 `periodNo`/`supersedes*` 管線、`confirmRenewal` 的 `periodNo` 參數
- 刪設定:`NEWEBPAY_PERIOD_ENABLED` / `_API_URL` / `_ALTER_URL`
- `hasMandate` 改成只看 `payuniCardToken`（藍新那條取消路徑已不存在,顯示按鈕只會讓客戶按到報錯）
- **保留**:藍新**單次付款**的 `newebpay.ts` + `routes/newebpay/{notify,return}`（服務 2026-07 切換前的歷史訂單）;`periodNo` 等型別欄位標 `@deprecated` 留著讓萬一存在的歷史文件仍能通過型別檢查

每個 Phase 各自可驗、可回滾;正式收款在 P5 開旗標前完全不被碰。

---

## 9. 老闆已定案(2026-07-29)

1. **首刷金額**:✅ **首期就收整月月費**——客人按訂閱當下建約定 + 完成第一期扣款、立即開通一個月。與現行單次付款一致。
2. **卡失敗寬限期**:✅ **3 天**,與現有 `GRACE_DAYS` 一致。卡不過先保留 3 天、每日重試,仍失敗才降回免費層。
3. **折抵餘額**:✅ **可累積、逐期折到用完**。`creditBalance` 可大於一期月費;每期扣款先扣折抵(`min(creditBalance, price)`)、扣完為止。
4. **換卡入口**:✅ **要加**「更新付款方式」——卡過期/被撤銷時客人可自行重跑一次 UPP 首刷拿新 Token(納入 Phase 5)。

---

## 10. API 欄位對實狀態(2026-07-30 官方文件已確認,零技術未知)

1. ✅ 首刷建約定 = UPP 首次交易、持卡人同意約定 → 回傳 Token。
2. ✅ Token 欄位名 = **`CreditHash`**(另有 `CreditLife` 有效期 MMYY、`Card4No` 末四碼)。
3. ✅ 幕後扣款 = `POST /api/credit`(Version 1.3),帶 `CreditHash` + 自訂 `TradeAmt`;回應 `Status`/`TradeStatus`,含 UNKNOWN 非同步路徑(見 §2)。
4. ✅ 加密沿用現有 `payuni.ts`(AES-GCM `EncryptInfo` / SHA256 `HashInfo`)。

**沙盒探針(2026-07-30)**:拿 .env 沙盒金鑰(MerID S076820628)打 `sandbox-api.payuni.com.tw/api/credit` + 假 `CreditHash` → 回 `Status: CREDIT02025 / Message: 約定信用卡不存在 / TradeStatus: 2`。這證明**簽章/加密位元組相容、IP 沒擋、V1.3 端點與請求/回應格式全對**。

> ⚠️ **更正(2026-07-30 晚)**:上一版把這個回應讀成「沙盒幕後扣款功能已開」——**是過度解讀**。
> `CREDIT02025` 只代表「你給的 Token 不存在」,不代表商店有這項權限。實際打 UPP 建約定時被明確擋下:
>
> ```
> Status: UPP02087   Message: 商店未提供約定信用卡幕後交易
> ```
>
> **逐欄位拆解結果**(同一組沙盒金鑰,只換參數):
>
> | 送出的參數 | 結果 |
> |---|---|
> | 不帶建約定欄位（現行單次付款,1.0） | ✅ 正常開出付款頁 |
> | 只帶 `Credit=1` / 加 `CreditTokenType=2`（2.0） | ✅ 正常開出付款頁 |
> | `UseTokenType=2`（記憶卡號）（2.0） | ✅ 正常開出付款頁 |
> | **`UseTokenType=1` 或 `3`（約定）**（1.0 與 2.0 都試） | ❌ `UPP02087 商店未提供約定信用卡幕後交易` |
>
> 兩個結論:
> 1. **`Version 2.0` 本身沒問題**(不帶建約定欄位時 2.0 照樣開出付款頁),被擋的是「約定」這項權限。
> 2. **「不需等 PAYUNi、正式上線前才需申請」是錯的** —— 沙盒特店也要開通「約定信用卡幕後交易」,
>    否則 §3A 首刷路徑一行都驗不了。**申請從「上線前的事」變成「現在就擋住驗證的事」,要立刻送件**
>    （沙盒 + 正式都要;正式另需綁授權 IP）。
>
> `UseTokenType=2`（記憶卡號）雖然過得了,**不可拿來當替代方案**——那是「幫客戶記卡號、下次少打字」,
> 仍需客戶本人在付款頁完成交易,不是我方可主動發動的幕後扣款,拿它做訂閱等於沒有訂閱。

**UPP 首刷建 token 參數已對實(2026-07-30 官方 UPP 文件)**:UPP 端點 `/api/upp`、**Version 固定 2.0**、Form Post。首刷要在 EncryptInfo 加:
- `Credit=1`(啟用信用卡一次付清)
- **`UseTokenType`**:`1`=約定(付款頁消費者可自行取消)、`2`=記憶卡號、**`3`=強制約定(消費者無法取消)**。→ 訂閱**建議 3**(確保一定拿到 token,否則客戶在 PAYUNi 頁取消約定=付了首月卻沒委託=訂閱靜默失敗;取消走我方「取消訂閱」UI)。
- **`CreditToken`**=我方自訂參照字串(≤200、`[A-Za-z0-9@.#$%_-+]`),用 `workspaceId`。**用 UseTokenType 時此為必填。**
- `CreditTokenType`=`2`(商店級 token;本專案每租戶單一特店);`CreditTokenExpired` 可省(預設跟卡到期日)。
- 回應(UPP Version 2.0、`TradeStatus`=1 已付款)在信用卡區回 **`CreditHash`**(Token Hash,續扣用)+ **`CreditLife`**(MMYY)+ `Card4No`。

**→ 首刷→續扣整條無技術未知,可從 Phase 1 一路做到 Phase 5。**

## 11. 申請清單（**這是目前唯一的阻塞點**）

第三方 PAYUNi 外掛廠商（WP Brewer）的文件把規則寫得最清楚,與我方探針結果完全一致:

| 申請書 | 用途 | 我方沙盒狀態（探針實測） |
|---|---|---|
| `05.PAYUNi_幕後授權取號API申請書.xlsx` | 幕後授權（一次性與定期定額都要） | ✅ **看起來已開通** — `/api/credit` 回的是業務錯誤（`CREDIT02025` 約定卡不存在 / `CREDIT02011` 未有信用卡號）,不是權限錯誤 |
| `07.PAYUNi_信用卡Token API申請書.xlsx` | 信用卡 Token（**只有存卡／定期定額需要**） | ❌ **未開通** → `UPP02087 商店未提供約定信用卡幕後交易` |

- 申請書從 PAYUNi 文件中心下載,填妥掃描後 mail 至 **service@payuni.com.tw**。
- **核准後還要「至統一金流後台啟用」**（後台 API 設定裡有開關）。
  → **先做這件（零成本）**:登入 `sandbox.payuni.com.tw` 看商店設定／API 設定裡有沒有「信用卡 Token」開關可以直接打開;有的話就不必等申請。
- 幕後交易需**綁定授權 IP**（正式站要填主機 IP;Amplify 是動態 IP,這點要一併問 PAYUNi 怎麼處理——**可能是正式上線的隱藏阻礙,建議一起問**）。

**結論**:程式（P1–P4）不受阻,但**任何實刷驗證都要先拿到 07 這張**。原文寫的「不需等 PAYUNi、正式上線前才申請」已更正。

---

## 附:相關檔案索引

- 現有 PAYUNi 單次:`server/utils/payuni.ts`、`payuni-fulfill.ts`、`payuni-reconcile.ts`、`server/routes/payuni/notify.post.ts`
- 藍新 recurring(將淘汰):`newebpay-period.ts`、`server/routes/newebpay/period-notify.post.ts`、`create/cancel-subscription.post.ts`
- 週期/結算:`shared/billing/period.ts`、`server/utils/payment.ts`、`run-billing-reconcile.ts`
- 訂閱型別:`shared/billing/plans.ts`(`WorkspaceSubscription`)
- 前端結帳:`app/components/admin/AdminPlanUpgradeDialog.vue`、`app/pages/admin/[workspaceId]/settings/billing.vue`

---

## 12. 「續期收款」——PAYUNi 的**另一套**定期扣款(2026-07-30 發現)

老闆在沙盒後台找到左側選單 **「續期收款」**(不是我先前 OCR 誤讀的「擴期收款」),底下有
新增／管理／訂單／明細。**這是與我們實作的 Token 模型完全不同的第二條路,必須講清楚差別,
以免日後有人以為「後台明明有,為什麼還要申請」。**

### 後台「新增續期收款」表單長什麼樣(截圖確認)

- 基本資訊:LOGO 呈現版型、指定日期(不限定／指定日期)、網址種類(交易／繳費／捐款)、交易名稱(≤30)、交易簡介(≤300)
- **續期扣款設定**:每期金額(**輸入 0 代表消費者自行填寫**)、扣款週期(每週／每月／每年)、
  扣款日期(每月 1–31 選一)、扣款期數(期數設定,例 12 期／或時間設定)
- **首期扣款設定**:首期扣款設定(依原扣款排程／訂單建立當日／指定日期)、
  **首期扣款金額(依原扣款金額／自訂)**、首次授權 3D 設定 = 啟用 3D
- 列表頁欄位:續期收款連結單號、連結名稱、金額、首期金額、狀態(使用中／已到期／已關閉／審核中)、開啟/關閉

### 與我們實作的 Token 模型差在哪

| | **續期收款**(後台這套) | **信用卡 Token 幕後扣款**(我們實作的) |
|---|---|---|
| 誰發動扣款 | **PAYUNi 按自己的排程扣** | **我方排程主動扣** |
| 每期金額 | **固定**(建連結時就定死;只有首期可自訂) | **每期自訂** |
| 期數 | **有上限**(例 12 期,到期要重簽) | 無上限 |
| 建立方式 | 後台建**收款連結**,客戶點連結去付款頁 | API 首刷建約定,每個客戶一組 Token |
| 失敗方向 | 我方降級了、金流仍按排程扣 → **「服務停了卡還在扣」** | 排程沒跑 = 這期沒扣到(頂多少收錢) |
| 折抵 / 降級期末生效 | **做不到**(金額固定) | 只是「這期少扣一點」 |

### 為什麼**不**改用它(建議)

1. **老闆已拍板的兩件事它都做不到**:#1 退費折抵下期、#2 降級期末生效——兩者都需要「每期金額可變」。
2. **失敗方向相反**:金流端排程 = 回到藍新那個「服務停了卡還在扣」的風險結構,而那套程式我們
   2026-07-30 才剛整塊移除。
3. **期數上限**:12 期後要客戶重簽,留存率直接被打折。
4. **它的 API 也沒開通**:`/api/period` → `PRD02043 商店未提供續期收款幕後交易`(見下)。
   後台建連結或許可用,但那是「一條連結給所有人點」,對不上我們 per-workspace 的訂閱模型。

### 它可以當 **Plan B**

若 07 申請書卡很久、又急著開始收訂閱費:用後台建 4 條連結(對應 4 個方案)先收錢,
**折抵與降級改人工處理**。代價是上面 1–3 條全部承受。這是商業決策,不是技術問題。

### 順手釘死的兩個事實

- **`/api/period` 存在但未開通**:`PRD02043 商店未提供續期收款幕後交易，223.143.244.121`
  → 訊息**把我方對外 IP 一起回傳**,證實 PAYUNi 對幕後 API 會檢查來源 IP。
  這對 §11 的「Amplify 動態 IP vs 綁定授權 IP」是直接證據——要跟 PAYUNi 談清楚。
  (注意:`/api/credit` 從**同一個 IP** 打過去是正常回業務錯誤的,所以 credit 這支沒被 IP 擋。)
- **`/api/period/query` 存在且沒被權限擋**:`PMDF02006 未有續期收款單號` → 必填「續期收款單號」。
- `period` 只吃 Version **1.0**(帶 1.3／2.0 → `API00001`)。

### 8.5 解除卡片約定（P5 最後一項,2026-07-30 完成)

`payuni.ts` 新增 `cancelCardBinding` / `buildBindCancel` / `buildBindCancelFields`
（端點 `PAYUNI_BIND_CANCEL_ENDPOINTS`,欄位與版本見 §2）。

**接在哪裡**:`runPaymentReconcile` 的「**真的降回免費層**」那一刻 —— 不是按下取消那一刻。
- 按下取消 = `cancelAtPeriodEnd`,客戶本期還能用、而且可能反悔想恢復訂閱 → **Token 要留著**。
- 期末真的降級了 → 解約 + 清掉 `payuniCardToken` / `payuniCardLast4` / `payuniCardExpiry`。
  不留一個沒人會用的授權在金流端,對客戶也是好事（他的卡不再被我們綁著）。

**失敗處理**:解約失敗就**留著 Token、下次對帳再試**,絕不中斷對帳。
因為這是**清潔工作不是安全需求**——PAYUNi 是我方主動發動扣款,`autoRenew=false` 之後沒有任何
排程會扣他（對比藍新:不終止委託就會「服務被降級、錢照扣」,那才是必須成功的操作）。

`查無符合約定資料`（`CANCEL03001`）視為**與成功等價**——本來就沒有東西要解,可以直接清掉我方 Token,
不必無限重試。

**金鑰沒設 → 整段跳過**,只寫資料庫（單元測試與金流未設定時走這條）。

### 8.6 Code review 修復（2026-07-30,15 條發現 / 14 條確認）

P1–P5 寫完後跑了一輪對抗式 code review,抓到 14 個確認的缺陷 —— **一半會動到錢**。
全部已修 + 補迴歸測試（522 測試綠）。留在這裡當「這些坑長什麼樣」的紀錄:

**A. 會扣錯錢（4）**
1. **換卡對話框報 499、實際刷 799**:對話框引用 `nextChargeAmount`（已折抵／已套用期末降級的
   *下一期* 金額）,但 `create-order` 一律收現行方案全額。→ 改用 `cardChargeAmount`
   （現行方案 `priceMonthly`）,並在方案不可線上結帳時**隱藏換卡入口**
   （已降到 free 卻還持有 Token 的帳號,原本按下去只會拿到 400）。
2. **被拒的卡每天重扣到永遠**:寬限期滿的降級只在「讀取時」就地推算,**從不寫回 Firestore**,
   而 `runPaymentReconcile` 第 ① 段用 `currentPeriodEnd < today` 查 → 永遠選不到已滾進新一期的
   past_due doc。→ reconcile 新增**第 ② 段掃 `status=='past_due'`** 讓降級落地,
   `isDueForRecurringCharge` 另加寬限期檢查當第二道保險。
3. **收了錢永遠開不通**:只有字面 `UNKNOWN` 被當未定;`TradeStatus=8`（待確認）與
   `HTTP_504` 被當硬失敗 → 訂單寫成 `failed`（**終態**）→ 銀行事後核准再也結算不了。
   → 新增 `isCreditChargeIndeterminate`（UNKNOWN / TradeStatus=8 / HTTP_* / BAD_JSON 全算未定）。
4. **同一期兩筆授權**:單號刻意把「嘗試日」編進去 → 隔天冪等鍵必然不同。
   → 新增 `hasUnresolvedRecurringOrder`：只要還有 pending 的續扣單就不再扣（查詢失敗保守跳過）。

**B. 會弄壞資料（3）** — 全部改成 Firestore **點狀欄位路徑**,不再「讀出整包 → 展開 → 寫回」:
`recordChargeError`、`schedule-plan-change`、`cancel-subscription`。
原本的寫法會把讀取後、寫入前發生的變更整包覆蓋掉（客戶剛按的「取消訂閱」被還原、
剛用掉的折抵餘額復活）。`notFound` 也從寬鬆的「訊息含查無」收緊成**只認 `CANCEL03001`**
——「查無此特店」這種設定錯誤也含「查無」,誤判會刪掉唯一能解約的憑證。

**C. 會漏帳（2）**
- `supersedePendingOrders` 現在**跳過 `period_recurring`**,續扣單的 pending TTL 也從 3 小時
  放寬到 3 天（`STALE_RECURRING_PENDING_MS`）。原本客戶在排程扣款期間按一下「升級」,
  那張等 trade/query 補查的單就會被作廢 → 錢收了、期間沒開通、沒 log 也沒發票。
- `settlePaidOrder` 新增回傳 `replacedCardToken`,`fulfillPayuniTrade` 據此**解掉被覆蓋的舊約定**。
  原本每換一次卡就在客戶卡上多留一組永遠解不掉的約定。

**D. 韌性與雜訊（5）**
- 每個 workspace 的迴圈本體包 `try/catch`（一筆壞資料原本會讓補發票、通知信對**所有人**都不跑）。
- 金鑰長度**先驗一次再進迴圈**（原本設定錯會在 claim 之後才 throw、被誤歸為「結果未定」,
  燒掉當天唯一一次嘗試 → 3 天後所有付費客戶靜默降級,而對帳報告只顯示 `unknown`）。
- 續扣提醒信改用 `resolveRecurringCharge`（原本自己拿 `plan.priceMonthly` → 信、畫面、實扣三個數字）。
- `CreditHash` 警告只對 `one_time` 印（`/api/credit` 本來就會回傳它,原本每筆續扣都印一行）。
- **刷卡只走被 `await` 的 cron 端點**:`runBillingReconcile` 新增 `opts.charge`（預設 false）,
  `payment-reconcile-tick` middleware 是 fire-and-forget,不給它刷卡。

> 一條標 PLAUSIBLE 未改:`cancelCardBinding` 依賴解密後的內層 `Status==='SUCCESS'`,而實測只
> 觀察過 `CANCEL03001`。官方文件的「返回參數 (EncryptInfo)」確實列了 `Status`(SUCCESS) 與
> `Message`,所以現行寫法**符合規格**,只是成功案例還沒實刷驗證過 → 等權限開通後一併驗。
