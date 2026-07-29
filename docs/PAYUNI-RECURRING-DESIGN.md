# PAYUNi 每月自動扣款 — 設計文件

> 狀態:**設計定稿，API 已對實,尚未動任何程式碼**(四項決策見 §9;CREDIT V1.3 欄位見 §2/§10)。2026-07-29。
> 沙盒金鑰已取得(商店代號 S076820628,金鑰放 `.env`)。剩兩個小確認(§10 a/b),Phase 1 開頭收掉即可開工。
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
| `trade_bind_query` | 查詢已綁定的約定 Token | `/api/trade_bind_query` |
| `trade_bind_cancel` | 取消約定 Token(帶 `UseTokenType=1` + `BindVal`) | `/api/trade_bind_cancel` |
| `trade_close` | **請退款**(帶 `TradeNo` + `CloseType`) | `/api/trade_close` |
| `trade_query` | 交易查詢(現有單次已在用) | `/api/trade/query` |

**已對實的關鍵欄位**(2026-07-29 官方 API 文件「信用卡幕後Token交易 CREDIT V1.3」截圖確認):
- **首刷建立約定**:走 UPP(整合式支付頁)首次交易、持卡人同意約定 → 交易回傳 **`CreditHash`**(= 信用卡 Token;PAYUNi 加密存卡,商店拿不到完整卡號),另回 **`CreditLife`**(Token 有效期 MMYY)、`Card4No`(末四碼)。
- **每期幕後續扣**:`POST /api/credit`,**Version 固定 1.3**,header 帶 `user-agent: payuni`。EncryptInfo 必填 `MerID / MerTradeNo(≤25,[A-Za-z0-9_-],10 分鐘內不重複) / TradeAmt(int) / Timestamp / ProdDesc(≤550)`;續扣帶 **`CreditHash`**(那組 Token)即扣該卡。**`TradeAmt` 每筆自訂** → 折抵/降級直接改這個數字,不需重建約定。
- **回應**:外層 `Status`(SUCCESS / UNKNOWN / UNAPPROVED);EncryptInfo 內 `TradeStatus`(1=已付款/2=失敗/3=取消/8=待確認)、`Card4No`、`AuthCode`、`CreditHash`(續用)、`CreditLife`。
- ⚠️ **UNKNOWN 非同步**:銀行 60 秒沒回 → 先回 `UNKNOWN`,之後 Notify 到 `NotifyURL`,或我方 15 分後用 `trade_query` 補查。續扣流程必須納入這條(沿用現有 `reconcilePayuniPending` 對帳模式)。
- **取消約定**:`trade_bind_cancel`(帶 `UseTokenType` + Token);**退款**:`trade_close`(`TradeNo` + `CloseType`)。
- PAYUNi 的 `/api/credit` 也能帶發票(`CarrierType/CarrierInfo/InvBuyerName`)與優惠券(`PromoCode/DiscountAmt`)欄位——但**我方發票走光貿、折抵用自算 `TradeAmt`,故這些 PAYUNi 欄位一律不帶**。

---

## 3. 目標架構:三條核心流程

### A. 首刷 — 建立約定 Token(客人按下訂閱)
1. 客人在方案對話框按「開始訂閱」。
2. 後端建 `paymentOrder`(kind=`period_first`)、走 `upp` 導客人去 PAYUNi 付款頁(**帶「建立約定/記憶卡號」旗標**，欄位待 §10 對實)。首刷會過 3D。
3. PAYUNi 付款成功 → Notify(server→server)回來，內含**約定 Token(`BindVal`)** 與卡別末四碼(`Card4No`)。
4. 我方 `fulfillPayuniTrade` 收單:開通本期訂閱、把 `BindVal`/末四碼存進 `subscription`、`autoRenew=true`、開發票。

> 重用:現有 PAYUNi 單次的 `buildUppForm` + `/payuni/notify` + `fulfillPayuniTrade` 幾乎照用，只多「請求 Token」與「存 Token」兩步。

### B. 每期續扣 — 我方主動幕後扣款(排程觸發)
每期在錨定日,由排程觸發:
1. `runPaymentReconcile` 找出「本期即將到期 / 已到期、`autoRenew=true`、`!cancelAtPeriodEnd`、有 `BindVal`」的訂閱。
2. 決定**下期方案** = `pendingPlanId ?? planId`(降級在此生效，見 §4)。
3. 決定**扣款金額** = `plan.priceMonthly − 折抵(min(creditBalance, price))`(折抵在此套用，見 §4)。
4. 建 `paymentOrder`(kind=`period_recurring`)。
5. 呼叫 `credit` 幕後扣款(`BindVal` + 金額)。**同步**拿到結果(不像藍新要等 webhook)。
6. 成功:滾到下一期、套用 `pendingPlanId`、扣掉已用折抵、開發票、寄收據。
7. 失敗:進 `past_due` 寬限期、隔日重試 N 次、寄提醒；寬限期滿仍失敗 → 降回免費層。

> 這條**比藍新單純**:不需要 `period-notify` webhook(改成同步扣款 + 對帳補救)，更接近現有 `reconcilePayuniPending` / `fulfillPayuniTrade` 的既有模式。

### C. 取消 / 卡失敗
- **客人取消**:寫 `autoRenew=false, cancelAtPeriodEnd=true`(沿用現成機制)。期末 roll 時 `downgradeToFree`。可選:同時 `trade_bind_cancel` 刪掉 Token(避免留著沒用的約定)。
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
- `payuniCardToken?: string`（= `BindVal`；有值 = 背後有生效中的約定，取代藍新的 `periodNo`/`periodOrderNo` 語意）
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
- `payuni.ts`:`buildCreditCharge`(幕後扣款 `credit`)、`buildBindCancel`(`trade_bind_cancel`)、`buildBindQuery`(選配)。
- UPP 首刷帶「建立約定」旗標 + 從 Notify 取 `BindVal`/`Card4No`。
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

| Phase | 內容 | 產出 / 驗收 |
|---|---|---|
| **P1 對實** | 沙盒帳號跑通:UPP 建約定拿 `BindVal`、`credit` 用 Token 扣款、`trade_bind_cancel`。把 §10 的待確認欄位釘死。 | 一支沙盒實測腳本全綠 |
| **P2 首刷+存 Token** | UPP 首刷帶建約定旗標、Notify 存 `BindVal`/末四碼、開通+開發票。前端訂閱按鈕改走 PAYUNi。 | 沙盒訂閱首期成功、Token 落庫 |
| **P3 每期續扣** | `chargeDueRecurring()` 進 reconcile、冪等、失敗重試、寬限期、續扣開發票+收據。 | 沙盒跨期自動扣款成功、失敗路徑正確 |
| **P4 降級+折抵** | `pendingPlanId`(#2)、`creditBalance`(#1)注入續扣金額;超管開折抵 UI;降級改期末。 | 降級/折抵沙盒驗證 |
| **P5 取消+換卡** | 取消(+`trade_bind_cancel`)、更新付款方式(重綁卡)、清藍新死碼。 | 全六路徑綠 → 開 `recurringEnabled` |

每個 Phase 各自可驗、可回滾;正式收款在 P5 開旗標前完全不被碰。

---

## 9. 老闆已定案(2026-07-29)

1. **首刷金額**:✅ **首期就收整月月費**——客人按訂閱當下建約定 + 完成第一期扣款、立即開通一個月。與現行單次付款一致。
2. **卡失敗寬限期**:✅ **3 天**,與現有 `GRACE_DAYS` 一致。卡不過先保留 3 天、每日重試,仍失敗才降回免費層。
3. **折抵餘額**:✅ **可累積、逐期折到用完**。`creditBalance` 可大於一期月費;每期扣款先扣折抵(`min(creditBalance, price)`)、扣完為止。
4. **換卡入口**:✅ **要加**「更新付款方式」——卡過期/被撤銷時客人可自行重跑一次 UPP 首刷拿新 Token(納入 Phase 5)。

---

## 10. API 欄位對實狀態(2026-07-29 官方文件已確認,原四項未知全解)

1. ✅ 首刷建約定 = UPP 首次交易、持卡人同意約定 → 回傳 Token。
2. ✅ Token 欄位名 = **`CreditHash`**(另有 `CreditLife` 有效期 MMYY、`Card4No` 末四碼)。
3. ✅ 幕後扣款 = `POST /api/credit`(Version 1.3),帶 `CreditHash` + 自訂 `TradeAmt`;回應 `Status`/`TradeStatus`,含 UNKNOWN 非同步路徑(見 §2)。
4. ✅ 加密沿用現有 `payuni.ts`(AES-GCM `EncryptInfo` / SHA256 `HashInfo`)。

**剩兩個小項,Phase 1 開頭一起收掉(不阻礙設計定案)**:
- (a) **UPP 首刷「請求建立 Token」要帶的參數**:流程圖已確認首刷經 UPP 回傳 `CreditHash`,但觸發建立 Token 的那個 UPP 請求旗標,需 UPP 請求參數頁或沙盒實測確認(推測是 UPP EncryptInfo 裡一個 Token/約定旗標)。
- (b) **沙盒商店的「信用卡 Token / 幕後扣款」功能是否已申請開通 + 綁定幕後授權 IP**:文件明載此功能「須向 PAYUNi 提出申請,審核開通且綁定幕後授權 IP 即可使用」。→ 待確認測試商店「審核狀態」;沙盒未開通則要走申請書。

---

## 附:相關檔案索引

- 現有 PAYUNi 單次:`server/utils/payuni.ts`、`payuni-fulfill.ts`、`payuni-reconcile.ts`、`server/routes/payuni/notify.post.ts`
- 藍新 recurring(將淘汰):`newebpay-period.ts`、`server/routes/newebpay/period-notify.post.ts`、`create/cancel-subscription.post.ts`
- 週期/結算:`shared/billing/period.ts`、`server/utils/payment.ts`、`run-billing-reconcile.ts`
- 訂閱型別:`shared/billing/plans.ts`(`WorkspaceSubscription`)
- 前端結帳:`app/components/admin/AdminPlanUpgradeDialog.vue`、`app/pages/admin/[workspaceId]/settings/billing.vue`
