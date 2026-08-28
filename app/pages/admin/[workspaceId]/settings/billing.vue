<template>
  <AdminSplitLayout solo :is-empty="false">
    <template #editor-header>
      <AdminSoloPageHeading
        field-label="設定"
        title="訂閱與付款"
        caption="查看目前方案與付款紀錄,或升級／續訂方案(付款由統一金流 PAYUNi 處理)。"
      />
      <div class="flex gap-2 admin-header-actions">
        <el-button :loading="loading" @click="reloadAll">重新載入</el-button>
      </div>
    </template>

    <template #editor-body>
      <div class="ls-page-body admin-panel-stack">
        <el-alert
          v-if="returnedOrder"
          :title="returnedOrder.title"
          :type="returnedOrder.type"
          show-icon
          :closable="false"
        >
          <div class="billing-return-body">
            <span>{{ returnedOrder.desc }}</span>
            <span v-if="polling" class="text-xs text-muted">付款確認中，會自動更新…</span>
            <el-button v-else-if="returnedOrder.pending" size="small" :loading="loading" @click="reloadAll">
              重新整理
            </el-button>
            <el-button v-else-if="returnedOrder.retry" size="small" type="primary" @click="upgradeOpen = true">
              重新選擇方案
            </el-button>
          </div>
        </el-alert>

        <!--
          發票開立失敗要看得到。開票在收款後於背景進行、失敗會自動重試（見 reissueFailedInvoices），
          但若持續失敗，這是稅務問題，管理者必須知道——不能只埋在付款紀錄表的一欄裡。
        -->
        <!-- 對客戶的口徑是「開立中」不是「失敗」（2026-08-16 老闆拍板）：系統每日自動補開、
             客戶不需要做任何事，「失敗」只會讓人以為系統壞了。⛔真實狀態（failed）照存不動，
             超管金流總覽照樣顯示紅色「開立失敗」＋未開成計數——只軟化對外措辭，不軟化內部事實。 -->
        <el-alert
          v-if="invoiceEnabled && hasFailedInvoice"
          type="info"
          show-icon
          :closable="false"
          title="電子發票開立中"
        >
          <span class="text-xs">
            已付款訂單的電子發票由系統自動開立，完成後會在下方付款紀錄顯示號碼並寄送通知。若有設定上的問題（例如統編），我們會主動與你聯繫。
          </span>
        </el-alert>

        <div v-if="planView" class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <div class="billing-plan-head">
                <span class="billing-plan-head__label">目前方案</span>
                <span class="billing-plan-head__name">{{ planView.name }}</span>
              </div>
            </div>
            <el-button size="small" type="primary" @click="upgradeOpen = true">升級 / 續訂</el-button>
          </div>
          <div class="card-section-stack">
            <!-- data-tour="bill-quota"：則數用完／快用完時，提醒帶會把這一塊圈起來
                 （「壞掉的就是這一格」，見 utils/alert-field-marks.ts）。
                 ⛔包一層 div 是為了有東西可以圈——內距／間距照 card-section-stack 原樣，
                 版面不能因為多這層而變。 -->
            <div v-if="planState.limit != null" class="billing-quota-block" data-tour="bill-quota">
              <el-progress
                :percentage="planState.percent"
                :color="planState.color"
                :stroke-width="16"
                :text-inside="true"
                :format="() => `${planState.percentRaw}%`"
              />
              <p class="text-xs text-muted">
                本期已用 <strong>{{ planState.used.toLocaleString() }}</strong> / {{ planState.limit.toLocaleString() }} 則
                <!-- 帳單頁是最該問得到「則是什麼」的地方：這裡的數字直接決定要不要升級 -->
                <el-tooltip placement="top" :content="REPLY_UNIT_TIP">
                  <el-icon class="admin-unit-info"><InfoFilled /></el-icon>
                </el-tooltip>
                <template v-if="planView.currentPeriodStart && planView.currentPeriodEnd">
                  · 本期 {{ planView.currentPeriodStart }} ~ {{ planView.currentPeriodEnd }}
                </template>
              </p>
            </div>
            <p v-else class="text-xs text-muted">客製額度,無固定則數上限。</p>

            <!-- 續訂狀態：自動扣款這件事必須一眼看得到，而且**隨時退得掉**。
                 取消按鈕的顯示條件是 canCancel（= 還有生效中的委託），不是 autoRenew——
                 扣款失敗或已被降級時，卡在金流那邊還綁著，那正是最需要停掉它的時刻，
                 絕不能讓警告訊息把取消入口蓋掉。 -->
            <el-alert
              v-if="planView.status === 'past_due'"
              data-tour="bill-past-due"
              type="warning"
              :closable="false"
              show-icon
              title="這期的自動扣款尚未成功"
            >
              <span class="text-xs">
                <!-- 帶上金流回的真實原因（卡片過期／額度不足／被銀行拒絕）——
                     只說「扣款未成功」等於叫客戶自己猜要修什麼。 -->
                <template v-if="planView.lastChargeError">原因：{{ planView.lastChargeError }}。</template>
                服務仍在正常運作，我們每天會再試一次。請確認信用卡是否過期或額度不足；幾天內仍未扣款成功，方案會降回免費層。
              </span>
              <!-- 卡不能用的當下就給出路。少了這顆按鈕，客戶只能等被降級再來找客服。 -->
              <div v-if="canUpdateCard" class="billing-renew-row billing-renew-row--tight">
                <el-button size="small" type="primary" :loading="updatingCard" @click="updatePaymentMethod">
                  換一張卡付款
                </el-button>
              </div>
            </el-alert>

            <div v-if="planView.cancelAtPeriodEnd" class="billing-renew-row">
              <span class="text-xs text-muted">
                已取消自動續訂，服務可用到 <strong>{{ planView.currentPeriodEnd }}</strong>，之後降回免費層。
              </span>
            </div>
            <div v-else-if="canCancel" class="billing-renew-row">
              <span class="text-xs text-muted">
                <template v-if="planView.autoRenew">
                  每月自動續訂中 · 下次扣款 <strong>{{ nextChargeDate }}</strong>
                  <!-- 金額要寫出來：折抵或期末降級都會讓下期金額與方案定價不同，
                       客戶看到「下次扣款日」卻不知道扣多少，才是最容易變成客訴的地方。 -->
                  <template v-if="planView.nextChargeAmount != null">
                    · 金額 <strong>NT${{ planView.nextChargeAmount.toLocaleString() }}</strong>
                  </template>
                </template>
                <template v-else>自動扣款委託仍在生效中，若不想再被扣款請取消。</template>
                <!-- 末四碼：客戶要能認出「到底是哪張卡在被扣」，換卡／對帳都靠它。 -->
                <template v-if="cardLabel"> · 扣款卡 {{ cardLabel }}</template>
              </span>
              <!-- 換卡入口:卡過期／被銀行撤銷時客戶要能自己救,不然只能等降級再來客服。 -->
              <el-button v-if="canUpdateCard" size="small" text :loading="updatingCard" @click="updatePaymentMethod">更新付款方式</el-button>
              <el-button size="small" text :loading="canceling" @click="cancelSubscription">取消訂閱</el-button>
            </div>

            <!-- 首期收款成功、但約定卡沒綁成（2026-08-28 老闆拍板補這顆）。
                 為什麼非補不可：這個狀態下 `canCancel`（＝有委託）是 false，所以上面那整排
                 「更新付款方式／取消訂閱」都不會出現——使用者讀到「下期不會自動扣款」之後，
                 在頁面上**找不到任何可以按的東西**（08-28 全異常巡檢抓到的唯一無出路項）。
                 ⛔顯示條件直接讀那顆異常本身，不要在這裡另寫一份判斷：條件寫兩份就會漂，
                 而漂掉的那一天畫面上看起來完全正常。 -->
            <div v-if="showRebindCard" class="billing-renew-row" data-tour="bill-rebind">
              <span class="text-xs text-muted">
                這期的錢已經收到，但自動扣款的卡片沒有綁定成功——<strong>下期不會自動扣款</strong>，方案會被降回免費層。重新設定一次就會綁上。
              </span>
              <el-button size="small" type="primary" :loading="updatingCard" @click="updatePaymentMethod">
                重新設定付款方式
              </el-button>
            </div>

            <!-- 已預約的期末降級：一定要能看到、也一定要能反悔。看不到的排程等於「莫名其妙
                 某天方案就變小了」，那是最難處理的客服case。 -->
            <div v-if="planView.pendingPlanName" class="billing-renew-row">
              <span class="text-xs text-muted">
                已預約 <strong>{{ nextChargeDate }}</strong> 起改為「<strong>{{ planView.pendingPlanName }}</strong>」方案，
                目前方案用到 {{ planView.currentPeriodEnd }}。
              </span>
              <el-button size="small" text :loading="unscheduling" @click="cancelScheduledChange">取消預約</el-button>
            </div>

            <!-- 折抵餘額：客戶的錢，看不到會以為被吃掉了 -->
            <div v-if="creditBalance > 0" class="billing-renew-row">
              <span class="text-xs text-muted">
                折抵餘額 <strong>NT${{ creditBalance.toLocaleString() }}</strong>——會自動折抵下期扣款，用完為止。
              </span>
            </div>
          </div>
          <!-- has-mandate：有自動扣款委託時，降級改成「期末生效」（不吃掉已付的剩餘天數） -->
          <AdminPlanUpgradeDialog
            v-model="upgradeOpen"
            :current-plan-id="planView.id"
            :has-mandate="planView.hasMandate"
            @changed="loadPlanSummary"
          />
        </div>
        <div v-else-if="loading" class="message-card ar-section-card billing-plan-loading">
          <div class="spinner" />
          <span class="text-sm text-muted">載入方案資訊…</span>
        </div>
        <div v-else class="message-card ar-section-card">
          <div class="card-section-stack">
            <p class="text-sm">此帳號尚未開通付費方案。</p>
            <div><el-button type="primary" @click="upgradeOpen = true">查看方案</el-button></div>
          </div>
          <AdminPlanUpgradeDialog v-model="upgradeOpen" :current-plan-id="null" />
        </div>

        <div class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">付款紀錄</span>
            </div>
            <el-button
              v-if="hiddenOrderCount > 0 || showAllOrders"
              size="small"
              text
              @click="showAllOrders = !showAllOrders"
            >
              {{ showAllOrders ? '只顯示重要' : `查看全部（含 ${hiddenOrderCount} 筆已逾期/失敗）` }}
            </el-button>
          </div>
          <div class="card-section-stack">
            <el-table :data="visibleOrders" size="small" empty-text="尚無付款紀錄">
              <el-table-column label="日期" min-width="140">
                <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
              </el-table-column>
              <el-table-column label="方案" min-width="80">
                <template #default="{ row }">{{ planName(row.planId) }}</template>
              </el-table-column>
              <el-table-column label="金額(含稅)" min-width="90" align="right">
                <template #default="{ row }">NT${{ row.amount.toLocaleString() }}</template>
              </el-table-column>
              <el-table-column label="付款方式" min-width="90">
                <template #default="{ row }">{{ payTypeLabel(row.paymentType) }}</template>
              </el-table-column>
              <el-table-column label="狀態" min-width="90">
                <template #default="{ row }">
                  <el-tag :type="statusType(row.status)" size="small">{{ statusLabel(row.status) }}</el-tag>
                  <span v-if="row.status === 'failed' && row.failReason" class="billing-fail-reason">{{ failReasonText(row.failReason) }}</span>
                </template>
              </el-table-column>
              <el-table-column v-if="invoiceEnabled" label="發票號碼" min-width="120">
                <template #default="{ row }">
                  <!-- 已作廢／已折讓的發票**照樣可以點開**——會計對帳最需要看的就是這兩種
                       （作廢時間原因、折讓後實際金額都在明細裡），只掛標籤不給看等於逼人來問 -->
                  <template v-if="row.invoiceNumber">
                    <el-button
                      type="primary"
                      link
                      size="small"
                      class="billing-invoice-view"
                      @click="viewInvoice(row)"
                    >
                      <span class="billing-order-no">{{ row.invoiceNumber }}</span>
                    </el-button>
                    <el-tag v-if="row.invoiceStatus === 'voided'" type="info" size="small">已作廢</el-tag>
                    <el-tag v-else-if="row.invoiceAllowanceTotal" type="warning" size="small">已折讓</el-tag>
                  </template>
                  <el-tag v-else-if="row.invoiceStatus === 'voided'" type="info" size="small">已作廢</el-tag>
                  <!-- 對客戶顯示「開立中」不是「失敗」——系統每日自動補開,客戶無事可做;真實狀態超管看 -->
                  <el-tooltip
                    v-else-if="row.invoiceStatus === 'failed'"
                    content="發票由系統自動開立，完成後這裡會顯示號碼並寄送通知"
                    placement="top"
                  >
                    <el-tag type="info" size="small">開立中</el-tag>
                  </el-tooltip>
                  <el-tooltip
                    v-else-if="row.invoiceStatus === 'skipped'"
                    content="這筆未開立發票（金額為 0，或此帳號未啟用電子發票）"
                    placement="top"
                  >
                    <span class="text-xs text-muted">未開立</span>
                  </el-tooltip>
                  <span v-else class="text-xs text-muted">{{ invoiceStatusLabel(row.invoiceStatus) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="訂單編號" min-width="170">
                <template #default="{ row }">
                  <span class="billing-order-no" title="對帳／客服查詢用">{{ row.merchantOrderNo }}</span>
                </template>
              </el-table-column>
              <el-table-column label="操作" min-width="140">
                <template #default="{ row }">
                  <template v-if="row.status === 'pending'">
                    <el-button size="small" type="primary" link :loading="actingOrder === row.merchantOrderNo" @click="resumePayment(row)">繼續付款</el-button>
                    <el-button size="small" type="info" link :loading="actingOrder === row.merchantOrderNo" @click="cancelOrder(row)">取消</el-button>
                  </template>
                  <el-button
                    v-else-if="row.status === 'failed'"
                    size="small"
                    type="primary"
                    link
                    :loading="actingOrder === row.merchantOrderNo"
                    @click="resumePayment(row)"
                  >重新付款</el-button>
                  <span v-else class="text-xs text-muted">—</span>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </div>

        <!--
          發票資訊。統編／抬頭是**組織層級**的設定（一家公司開 3 個 OA 不該填 3 次），
          所以這裡預設顯示「沿用組織設定」的唯讀摘要，只有真的需要不同抬頭時才展開覆寫。
          直接給一張空表單，會讓人以為「沒填 = 不會開發票」而在每個 OA 各填一次。
        -->
        <!-- id="invoice"：升級對話框的「先填發票資訊」用 #invoice 跳進來（見 scrollToInvoice） -->
        <div v-if="invoiceEnabled" id="invoice" class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">發票資訊</span>
              <span class="text-xs text-muted">每次付款成功後自動開立</span>
            </div>
            <el-button v-if="invoiceOverriding" size="small" :loading="savingInvoice" :disabled="!invoiceValid" @click="saveInvoiceProfile">
              儲存
            </el-button>
          </div>

          <div class="card-section-stack">
            <template v-if="!invoiceOverriding">
              <div class="billing-invoice-inherited">
                <div>
                  <p class="text-sm">{{ effectiveInvoiceLabel }}</p>
                  <p class="text-xs text-muted">
                    沿用組織的發票設定。
                    <NuxtLink v-if="invoiceOrgId" :to="`/admin/org/${invoiceOrgId}`" class="billing-invoice-link">
                      去組織設定修改 →
                    </NuxtLink>
                  </p>
                </div>
                <el-button size="small" text @click="startOverride">改用專屬設定</el-button>
              </div>
            </template>

            <template v-else>
              <el-alert type="info" :closable="false" show-icon>
                <span class="text-xs">
                  這個官方帳號將使用**專屬的**發票資訊，不再沿用組織設定。
                  全部欄位清空並儲存即可改回沿用。
                </span>
              </el-alert>
              <AdminInvoiceProfileForm v-model="invoiceForm" :fallback-name-hint="workspaceName" @update:valid="invoiceValid = $event" />
            </template>
          </div>
        </div>

        <!--
          發票明細視窗:把已存但列表沒顯示的「隨機碼」攤出來——B2C 到財政部平台查詢／兌獎需要它。
          光貲目前沒有「重寄 email／取得 PDF」的 API,所以這裡走客戶自助路徑(號碼＋隨機碼＋平台連結),
          而不是接一支還沒對過文件的端點。
        -->
        <el-dialog v-model="invoiceViewOpen" title="電子發票明細" width="min(420px, 92vw)">
          <div v-if="invoiceDetailLoading" class="billing-invoice-detail-loading">
            <div class="spinner" />
            <span class="text-sm text-muted">讀取發票明細…</span>
          </div>
          <div v-else-if="invoiceDetail" class="billing-invoice-detail">
            <!-- 作廢的先講:下面的欄位只是歷史紀錄,別讓人抄了統編金額才發現這張無效 -->
            <el-alert v-if="invoiceDetail.voided" type="warning" :closable="false">
              <span class="text-xs">
                這張發票已於 {{ fmtTime(invoiceDetail.voidedAt) }} 作廢{{ invoiceDetail.voidReason ? `（原因：${invoiceDetail.voidReason}）` : '' }},不可再用於報帳。
              </span>
            </el-alert>
            <div class="bid-row">
              <span class="bid-label">發票號碼</span>
              <span class="billing-order-no bid-value">{{ invoiceDetail.invoiceNumber }}</span>
            </div>
            <!-- 開給誰:用開立當下的快照。舊發票沒存快照 → buyerType 為 null,整段不顯示,不猜 -->
            <div v-if="invoiceDetail.buyerType" class="bid-row">
              <span class="bid-label">發票類型</span>
              <span class="bid-value">{{ invoiceDetail.buyerType === 'b2b' ? '公司發票（三聯式）' : '個人發票（二聯式）' }}</span>
            </div>
            <div v-if="invoiceDetail.buyerUBN" class="bid-row">
              <span class="bid-label">統一編號</span>
              <span class="bid-value">
                <span class="billing-order-no">{{ invoiceDetail.buyerUBN }}</span>
                <el-button link size="small" type="primary" @click="copyText(invoiceDetail.buyerUBN)">複製</el-button>
              </span>
            </div>
            <div v-if="invoiceDetail.buyerName" class="bid-row">
              <span class="bid-label">{{ invoiceDetail.buyerType === 'b2b' ? '公司抬頭' : '買受人' }}</span>
              <span class="bid-value">{{ invoiceDetail.buyerName }}</span>
            </div>
            <div v-if="invoiceDetail.itemName" class="bid-row">
              <span class="bid-label">品名</span>
              <span class="bid-value">
                {{ invoiceDetail.itemName }}
                <!-- 舊發票沒存品名快照,回推值在方案改名後就不是發票上的字,必須標註 -->
                <span v-if="invoiceDetail.itemNameDerived" class="text-xs text-muted">（依現行方案名回推,以發票正本為準）</span>
              </span>
            </div>
            <div v-if="invoiceDetail.randomNum" class="bid-row">
              <span class="bid-label">隨機碼</span>
              <span class="bid-value">
                <span class="billing-order-no">{{ invoiceDetail.randomNum }}</span>
                <el-button link size="small" type="primary" @click="copyText(invoiceDetail.randomNum)">複製</el-button>
              </span>
            </div>
            <div class="bid-row">
              <span class="bid-label">開立時間</span>
              <span class="bid-value">{{ fmtTime(invoiceDetail.issuedAt) }}</span>
            </div>
            <div class="bid-row">
              <span class="bid-label">金額</span>
              <span class="bid-value">
                含稅 NT${{ invoiceDetail.totalAmt.toLocaleString() }}
                <span class="text-xs text-muted">（銷售額 {{ invoiceDetail.amt.toLocaleString() }} ＋ 稅額 {{ invoiceDetail.taxAmt.toLocaleString() }}）</span>
              </span>
            </div>
            <!-- 折讓過的發票金額已不是原額——不顯示的話會計對帳必定對不上 -->
            <template v-if="invoiceDetail.allowanceTotal > 0">
              <div class="bid-row">
                <span class="bid-label">折讓紀錄</span>
                <span class="bid-value bid-allowance-list">
                  <span v-for="a in invoiceDetail.allowances" :key="a.allowanceNumber" class="bid-allowance">
                    −NT${{ a.amount.toLocaleString() }}・{{ a.reason }}
                    <span class="text-xs text-muted">（{{ a.createdAtMs ? fmtTime(a.createdAtMs) : '時間不詳' }}・單號 {{ a.allowanceNumber }}）</span>
                  </span>
                </span>
              </div>
              <div class="bid-row">
                <span class="bid-label">折讓後金額</span>
                <span class="bid-value">
                  含稅 NT${{ invoiceDetail.netAmt.toLocaleString() }}
                  <span class="text-xs text-muted">（原發票 NT${{ invoiceDetail.totalAmt.toLocaleString() }} − 已折讓 NT${{ invoiceDetail.allowanceTotal.toLocaleString() }}）</span>
                </span>
              </div>
            </template>
            <!-- 指引照發票類型講該講的;作廢的不給查詢/報帳指引（一張無效的發票沒有下一步） -->
            <el-alert v-if="!invoiceDetail.voided" type="info" :closable="false">
              <span class="text-xs">
                <template v-if="invoiceDetail.buyerType === 'b2b'">
                  公司發票已於開立時寄送至您設定的發票 Email,可供報帳使用。
                </template>
                <template v-else-if="invoiceDetail.buyerType === 'b2c'">
                  個人發票可至
                  <a href="https://www.einvoice.nat.gov.tw/" target="_blank" rel="noopener" class="billing-invoice-link">財政部電子發票整合服務平台</a>
                  ,以發票號碼＋隨機碼查詢與兌獎。
                </template>
                <template v-else>
                  個人發票可至
                  <a href="https://www.einvoice.nat.gov.tw/" target="_blank" rel="noopener" class="billing-invoice-link">財政部電子發票整合服務平台</a>
                  ,以發票號碼＋隨機碼查詢與兌獎;公司發票(有統編)已於開立時寄送至您設定的發票 Email。
                </template>
              </span>
            </el-alert>
            <!-- 證明聯 PDF:光貲的連結只有 10 分鐘有效 → 每次點都即時取。
                 取到後先嘗試自動開新分頁;被彈窗攔截擋下時,這裡的連結還在,自己點即可。
                 作廢的發票不給下載(端點也擋)——無效發票的證明聯只會被誤用。 -->
            <div v-if="!invoiceDetail.voided" class="bid-file-row">
              <a
                v-if="invoiceFileUrl"
                :href="invoiceFileUrl"
                target="_blank"
                rel="noopener"
                class="billing-invoice-link"
              >開啟證明聯 PDF</a>
              <el-button v-else size="small" :loading="invoiceFileLoading" @click="fetchInvoiceFile">
                下載證明聯 PDF
              </el-button>
              <span v-if="invoiceFileUrl" class="text-xs text-muted">連結 10 分鐘內有效,逾時請重新點「檢視發票」</span>
              <span v-else-if="!invoiceFileError" class="text-xs text-muted">報帳用;發票開立 180 天內可下載</span>
              <span v-if="invoiceFileError" class="text-xs text-danger">{{ invoiceFileError }}</span>
            </div>
          </div>
        </el-dialog>
      </div>
    </template>
  </AdminSplitLayout>
</template>

<script setup lang="ts">
import { InfoFilled } from '@element-plus/icons-vue'
import { BILLING_PLANS } from '~~/shared/billing/plans'
import { REPLY_UNIT_TIP } from '~~/shared/billing/usage-units'
import { CHECKOUT_CONSENT_TEXT, POLICY_LINKS } from '~~/shared/legal'
import { cardStatementNotice } from '~~/shared/billing/statement'
import type { PaymentOrderStatus } from '~~/shared/types/payment'
import { describeInvoiceProfile } from '~~/shared/types/organization'
import type { InvoiceForm } from '~~/app/components/admin/AdminInvoiceProfileForm.vue'

definePageMeta({ middleware: ['auth', 'workspace-settings'], layout: 'default' })
useHead({ title: useAdminTitle('訂閱與付款') })

const route = useRoute()
const { apiFetch } = useWorkspace()
const { showToast } = useAdminToast()
const { plan: planView, state: planState, load: loadPlanSummary } = usePlanSummary()

const config = useRuntimeConfig()
const invoiceEnabled = Boolean(config.public.invoiceEnabled)
/** 帳單上的請款名稱揭露（與升級對話框同一句，見 shared/billing/statement.ts）。 */
const statementNotice = computed(() => cardStatementNotice({
  statementName: String(config.public.cardStatementName || ''),
  legalCompanyName: String(config.public.legalCompanyName || ''),
  brandName: String(config.public.brandName || ''),
}))

const upgradeOpen = ref(false)
const loading = ref(false)

interface OrderRow {
  merchantOrderNo: string
  planId: string
  amount: number
  status: PaymentOrderStatus
  paymentType: string | null
  failReason?: string | null
  createdAt: number | null
  paidAt: number | null
  invoiceNumber?: string | null
  invoiceStatus?: 'issued' | 'failed' | 'skipped' | 'voided' | null
  /** 已開折讓的累計金額；>0 時列表在號碼旁標「已折讓」（明細在點開的視窗裡） */
  invoiceAllowanceTotal?: number | null
}
const orders = ref<OrderRow[]>([])

/** 有付款成功、但發票開立失敗的紀錄 → 頁首顯示警示（稅務問題，要看得到）。 */
const hasFailedInvoice = computed(() =>
  orders.value.some(o => o.status === 'paid' && o.invoiceStatus === 'failed'),
)

// 帳單頁預設只留「重要的」：已付款 + 進行中的待付款 + **最新一筆**失敗（可重試）。
// 逾期（放棄的舊單）與**較舊的失敗**（重試留下的）收進「查看全部」,避免一長串噪音。
// orders 已是新到舊排序,所以第一筆遇到的 failed 是最新的 → 留、其餘 failed 收起。
const showAllOrders = ref(false)
const visibleOrders = computed(() => {
  if (showAllOrders.value) return orders.value
  let failedSeen = false
  return orders.value.filter((o: OrderRow) => {
    if (o.status === 'expired') return false
    if (o.status === 'failed') {
      if (failedSeen) return false
      failedSeen = true
    }
    return true
  })
})
const hiddenOrderCount = computed(() => orders.value.length - visibleOrders.value.length)

// ── 自動續訂 ──────────────────────────────────────────────
/** 下次扣款日 = 本期到期日的隔天（我方排程在錨定日扣款）。 */
const nextChargeDate = computed(() => {
  const end = planView.value?.currentPeriodEnd
  if (!end) return '—'
  const [y, m, d] = end.split('-').map(Number) as [number, number, number]
  const t = new Date(Date.UTC(y, m - 1, d + 1))
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`
})

/**
 * 能不能取消 = 金流那邊還有生效中的扣款委託。**不是**看 autoRenew——
 * 扣款失敗被降回免費層時 autoRenew 已經是 false，但卡還綁著，那時最需要這個按鈕。
 */
const canCancel = computed(() => planView.value?.hasMandate === true)

/** 扣款卡標示（末四碼）；沒有末四碼就不顯示，不要湊出「•••• ????」這種假資訊。 */
const cardLabel = computed(() => {
  const last4 = String(planView.value?.cardLast4 || '').trim()
  return last4 ? `•••• ${last4}` : ''
})

const creditBalance = computed(() => Number(planView.value?.creditBalance ?? 0))

/** 取消已預約的期末降級（客戶反悔）→ 下期回到沿用現行方案。 */
const unscheduling = ref(false)
async function cancelScheduledChange() {
  unscheduling.value = true
  try {
    await apiFetch('/api/payment/schedule-plan-change', { method: 'POST', body: { planId: null } })
    showToast('已取消預約，下期沿用目前方案', 'success')
    await loadPlanSummary()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || e?.message || '取消預約失敗', 'error')
  }
  finally {
    unscheduling.value = false
  }
}

const canceling = ref(false)
async function cancelSubscription() {
  try {
    await ElMessageBox.confirm(
      `取消後不再自動扣款，「${planView.value?.name}」方案可以用到 ${planView.value?.currentPeriodEnd}，之後降回免費層（每月 200 則）。`,
      '取消自動續訂',
      { confirmButtonText: '確認取消訂閱', cancelButtonText: '再想想', type: 'warning' },
    )
  }
  catch { return }

  canceling.value = true
  try {
    const r = await apiFetch<{ activeUntil: string | null }>('/api/payment/cancel-subscription', { method: 'POST' })
    showToast(`已取消自動續訂，服務可用到 ${r.activeUntil ?? '本期結束'}`, 'success')
    await loadPlanSummary()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '取消失敗，請聯繫客服', 'error')
  }
  finally {
    canceling.value = false
  }
}

// ── 發票資訊（預設沿用組織設定，需要時才覆寫）──────────────────
const invoiceForm = reactive<InvoiceForm>({
  buyerUBN: '', buyerName: '', buyerEmail: '', carrierNum: '', loveCode: '',
})
const savingInvoice = ref(false)
const invoiceValid = ref(true)
/** true = 這個 OA 有自己的專屬設定（不沿用組織）。 */
const invoiceOverriding = ref(false)
const invoiceOrgId = ref<string | null>(null)
const effectiveInvoice = ref<Record<string, string | null>>({})

const workspaceName = computed(() => planView.value?.name ?? '')

/** 一句話說清楚「現在會開出什麼樣的發票」——與發票表單預覽共用 describeInvoiceProfile（口徑一致）。 */
const effectiveInvoiceLabel = computed(() => describeInvoiceProfile(effectiveInvoice.value))

const INVOICE_STATUS_LABEL: Record<string, string> = { failed: '開立失敗', skipped: '未開立', voided: '已作廢', issued: '—' }
function invoiceStatusLabel(s?: string | null) { return s ? (INVOICE_STATUS_LABEL[s] ?? '—') : '—' }

// ── 檢視發票明細 ──────────────────────────────────────────────
// 隨機碼有存但列表沒顯示,點開才向後端讀一次(不預載 50 筆的 join)。
interface InvoiceDetail {
  invoiceNumber: string
  randomNum: string | null
  totalAmt: number
  amt: number
  taxAmt: number
  issuedAt: number | null
  /** 開立當下的買方快照；null = 上線前的舊發票沒存,整段不顯示、不猜 */
  buyerType: 'b2b' | 'b2c' | null
  buyerUBN: string | null
  buyerName: string | null
  itemName: string | null
  /** true = 品名是用現行方案名回推的（舊發票沒存快照）,顯示時要註明 */
  itemNameDerived: boolean
  voided: boolean
  voidReason: string | null
  voidedAt: number | null
  allowances: { allowanceNumber: string; amount: number; reason: string; createdAtMs: number | null }[]
  allowanceTotal: number
  netAmt: number
}
const invoiceViewOpen = ref(false)
const invoiceDetailLoading = ref(false)
const invoiceDetail = ref<InvoiceDetail | null>(null)
/** 正在檢視的訂單編號——「下載證明聯」要拿它去要 PDF 連結。 */
const invoiceViewOrderNo = ref('')

async function viewInvoice(row: OrderRow) {
  if (!row.invoiceNumber) return
  invoiceViewOpen.value = true
  invoiceDetailLoading.value = true
  invoiceDetail.value = null
  invoiceViewOrderNo.value = row.merchantOrderNo
  // 換一張發票就把上一張的 PDF 狀態清掉(連結 10 分鐘失效,留著只會開到過期頁)
  invoiceFileUrl.value = ''
  invoiceFileError.value = ''
  try {
    invoiceDetail.value = await apiFetch<InvoiceDetail>(
      `/api/payment/invoice-detail?order=${encodeURIComponent(row.merchantOrderNo)}`,
    )
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '讀取發票明細失敗', 'error')
    invoiceViewOpen.value = false
  }
  finally {
    invoiceDetailLoading.value = false
  }
}

// ── 下載證明聯 PDF ──
// 光貿的 file_url 只有 10 分鐘有效 → 每次點都即時要,不存不快取。
// 拿到後先嘗試直接開新分頁;被瀏覽器的彈窗攔截擋下時,畫面上已經有連結可以自己點。
const invoiceFileUrl = ref('')
const invoiceFileLoading = ref(false)
const invoiceFileError = ref('')

async function fetchInvoiceFile() {
  invoiceFileLoading.value = true
  invoiceFileError.value = ''
  try {
    const r = await apiFetch<{ fileUrl: string }>(
      `/api/payment/invoice-file?order=${encodeURIComponent(invoiceViewOrderNo.value)}`,
    )
    invoiceFileUrl.value = r.fileUrl
    window.open(r.fileUrl, '_blank', 'noopener')
  }
  catch (e: any) {
    // 逾 180 天、存入載具的發票未中獎等,光貿的原因會在訊息裡——原樣顯示,使用者才知道為什麼
    invoiceFileError.value = e?.data?.statusMessage || e?.data?.message || e?.message || '取得證明聯失敗'
  }
  finally {
    invoiceFileLoading.value = false
  }
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    showToast('已複製', 'success')
  }
  catch {
    showToast('複製失敗,請手動選取', 'error')
  }
}

/** 從「沿用組織」切到「專屬設定」：把組織的值當起點帶進表單，不要給他一張空的。 */
function startOverride() {
  const p = effectiveInvoice.value
  invoiceForm.buyerUBN = p.buyerUBN ?? ''
  invoiceForm.buyerName = p.buyerName ?? ''
  invoiceForm.buyerEmail = p.buyerEmail ?? ''
  invoiceForm.carrierNum = p.carrierNum ?? ''
  invoiceForm.loveCode = p.loveCode ?? ''
  invoiceOverriding.value = true
}

async function saveInvoiceProfile() {
  savingInvoice.value = true
  try {
    const r = await apiFetch<{ inherited: boolean }>('/api/payment/invoice-profile', {
      method: 'POST',
      body: { ...invoiceForm },
    })
    showToast(r.inherited ? '已改回沿用組織設定' : '發票資訊已儲存', 'success')
    await loadInvoiceProfile()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '儲存失敗', 'error')
  }
  finally {
    savingInvoice.value = false
  }
}

const STATUS_LABEL: Record<PaymentOrderStatus, string> = { pending: '待付款', paid: '已付款', failed: '失敗', expired: '已逾期' }
function statusLabel(s: PaymentOrderStatus) { return STATUS_LABEL[s] ?? s }
function statusType(s: PaymentOrderStatus): 'success' | 'danger' | 'warning' | 'info' {
  if (s === 'paid') return 'success'
  if (s === 'failed') return 'danger'
  if (s === 'pending') return 'warning'
  return 'info'
}
function planName(id: string) { return BILLING_PLANS[id as keyof typeof BILLING_PLANS]?.name ?? id }

// 付款方式代碼 → 看得懂的中文（對帳/客服問起來時用得到）
const PAY_TYPE_LABEL: Record<string, string> = {
  CREDIT: '信用卡',
  VACC: 'ATM 轉帳',
  WEBATM: 'WebATM',
  CVS: '超商代碼',
  BARCODE: '超商條碼',
}
function payTypeLabel(t: string | null) { return t ? (PAY_TYPE_LABEL[t] ?? t) : '—' }

// 失敗原因白話化:PAYUNi 的「授權失敗」對一般人不好懂 → 補白話;其餘（金額不符…）已夠白話,原樣顯示。
const FAIL_REASON_PLAIN: Record<string, string> = {
  授權失敗: '卡片未通過（銀行未核准這筆交易）',
}
function failReasonText(r: string | null | undefined) { return r ? (FAIL_REASON_PLAIN[r] ?? r) : '' }
function fmtTime(ms: number | null) {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// 金流導回帶的 ?order=;顯示付款結果(真正開通以 server→server 的 notify 為準,可能稍慢於導回)
const returnedOrder = computed(() => {
  const no = String(route.query.order || '').trim()
  if (!no) return null
  const o = orders.value.find(r => r.merchantOrderNo === no)
  if (!o) return { title: '付款處理中', type: 'info' as const, desc: '若剛完成付款，款項確認後方案會自動更新。', pending: true, retry: false }
  if (o.status === 'paid') return { title: '付款完成，方案已開通', type: 'success' as const, desc: `訂單 ${no}`, pending: false, retry: false }
  // 失敗時帶上這筆的真實原因（授權失敗…），別只講「未扣款或已取消」讓人猜。
  if (o.status === 'failed') return { title: '這筆付款未成功', type: 'error' as const, desc: `${o.failReason ? `${failReasonText(o.failReason)}，` : ''}可重新選擇方案結帳。`, pending: false, retry: true }
  if (o.status === 'expired') return { title: '這筆訂單已逾期', type: 'info' as const, desc: '可重新選擇方案結帳。', pending: false, retry: true }
  return { title: '付款處理中', type: 'warning' as const, desc: '款項確認後方案會自動更新。', pending: true, retry: false }
})

// 導回時 Notify 常常還沒送達 → 短暫輪詢直到訂單結案（最多 ~32s），使用者不必自己按重新載入。
const polling = ref(false)
let pollTimer: ReturnType<typeof setTimeout> | null = null
let pollTries = 0

function stopPoll() {
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
  polling.value = false
}

function pollReturnedOrder() {
  if (!returnedOrder.value?.pending || pollTries >= 8) {
    stopPoll()
    return
  }
  polling.value = true
  pollTries += 1
  pollTimer = setTimeout(async () => {
    await reloadAll()
    pollReturnedOrder()
  }, 4000)
}

async function loadOrders() {
  try { orders.value = await apiFetch<OrderRow[]>('/api/payment/orders') }
  catch { orders.value = [] }
}

// ── 待付款訂單:繼續付款 / 取消 ──────────────────────────────
// submitToGateway 由 useGatewayCheckout composable 自動 import（與升級對話框共用）
const actingOrder = ref('')

/** 待付款訂單「繼續付款」:重新建單（30 分內沿用同單號）→ 導回 PAYUNi 付款頁。 */
async function resumePayment(row: OrderRow) {
  // 這條路徑也可能建出**新**訂單（失敗單重新付款時舊單不會被沿用），所以同樣要在
  // 付款前取得條款同意——句子與升級對話框的勾選框共用 CHECKOUT_CONSENT_TEXT，
  // 兩條路徑客戶看到的同意內容一字不差（見 shared/legal.ts）。
  const policyLinks = POLICY_LINKS.map(p => `<a href="${p.to}" target="_blank" rel="noopener">${p.label}</a>`).join('・')
  try {
    await ElMessageBox.confirm(
      `<p>將以 NT$${row.amount.toLocaleString()}（含稅）完成「${planName(row.planId)}」方案的付款，接著前往統一金流 PAYUNi 的安全付款頁面。</p>`
      // 帳單請款名稱與品牌不同，付款前一定要講（理由見 shared/billing/statement.ts）。
      // 與升級對話框共用同一句，兩條結帳路徑客戶看到的一字不差。
      + `<p>${statementNotice.value}</p>`
      + `<p>${CHECKOUT_CONSENT_TEXT}</p><p>${policyLinks}</p>`,
      '確認付款',
      {
        dangerouslyUseHTMLString: true, // 只放我們自己的字串與政策連結，無使用者輸入
        confirmButtonText: '同意條款並前往付款',
        cancelButtonText: '取消',
        type: 'info',
      },
    )
  }
  catch { return } // 使用者取消

  actingOrder.value = row.merchantOrderNo
  const overlay = ElLoading.service({ lock: true, text: '正在前往 PAYUNi 安全付款頁面…' })
  try {
    const res = await apiFetch<{ action: string; fields: Record<string, string> }>('/api/payment/create-order', {
      method: 'POST',
      body: { planId: row.planId, workspaceId: route.params.workspaceId, termsAccepted: true },
    })
    if (!res.action) throw new Error('金流尚未設定')
    submitToGateway(res.action, res.fields)
    // 送出後瀏覽器即導向付款頁；overlay 保持到頁面離開為止
  }
  catch (e: any) {
    overlay.close()
    actingOrder.value = ''
    showToast(e?.data?.statusMessage || e?.message || '建立訂單失敗', 'error')
  }
}

/**
 * 更新付款方式（換卡）——P5。
 *
 * PAYUNi 的約定 Token 綁在「一次真實的付款」上:要換卡就得再跑一次 UPP 首刷,由客戶在
 * PAYUNi 付款頁輸入新卡並過 3D,回來的新 `CreditHash` 會覆蓋舊的。所以這件事**一定伴隨
 * 一期的付款**,不是純粹換張卡而已——文案必須講清楚,否則客戶會覺得被莫名收費。
 *
 * 兩種情況的實際效果不同（都由後端 buildPaidSubscription 決定,這裡只是把它說白）：
 *  · 扣款失敗中（past_due）→ 本期本來就還沒收到錢 → 這筆就是補繳,新一期從今天起算。
 *  · 一切正常（active）  → 期間堆疊 → 等於「提前付下一期」,已付的剩餘天數不會消失。
 *
 * ⚠️ 若日後查到 PAYUNi 支援 0 元／1 元純綁卡,這裡就能改成不收錢的換卡
 *    （目前官方文件沒查到,見 docs/PAYUNI-RECURRING-DESIGN.md §11）。
 */
/**
 * 換卡實際會被收多少 = **現行方案的月費全額**。
 *
 * ⚠️ 刻意**不用** `planView.nextChargeAmount`——那是「下一期續扣」的金額(已扣折抵、已套用
 *    期末降級)。換卡走的是 `create-order`,它一律收現行方案的 `priceMonthly`,折抵只在
 *    續扣路徑套用。用 nextChargeAmount 去報價會出現「對話框說 499、實際刷 799」。
 * 回 null = 這個方案不能線上結帳（免費／客製）→ 不顯示換卡入口。
 */
const cardChargeAmount = computed<number | null>(() => {
  const plan = BILLING_PLANS[(planView.value?.id ?? '') as keyof typeof BILLING_PLANS]
  const price = plan?.priceMonthly
  if (plan?.custom || price == null || price <= 0) return null
  return price
})

/**
 * 能不能換卡。除了「有委託」還要求「現行方案真的能線上結帳」——
 * 已被降回免費層但仍持有 Token 的帳號若露出這顆按鈕,按下去只會拿到
 * 400「此方案不支援線上結帳」。
 */
const canUpdateCard = computed(() => canCancel.value && cardChargeAmount.value != null)

/**
 * 「首期付了、卡沒綁成」要不要顯示那顆補綁按鈕（2026-08-28）。
 *
 * ⛔ 判斷刻意直接讀 `renewalNotBound` 這顆異常，不在這裡另寫一份條件：
 * 真正的判定（有 period_first 訂單、已付款、cardBound=false、且在時間窗內）在後端，
 * 這裡照抄一份的話，兩邊遲早對不上——而漂掉的那天畫面看起來完全正常，沒有人會發現。
 * 也順便保證「提醒帶指到這顆按鈕」時它一定在（提醒帶的錨點就是這一列）。
 *
 * 另外要求 `cardChargeAmount != null`：免費／客製方案按下去只會拿到
 * 400「此方案不支援線上結帳」（同 `canUpdateCard` 的理由）。
 */
const { alerts: workspaceAlerts } = useWorkspaceAlerts()
const showRebindCard = computed(() =>
  cardChargeAmount.value != null
  && workspaceAlerts.value.some(a => a.id === 'renewalNotBound' && a.state === 'active'),
)

const updatingCard = ref(false)
async function updatePaymentMethod() {
  const pv = planView.value
  const charge = cardChargeAmount.value
  if (!pv || charge == null) return
  const isPastDue = pv.status === 'past_due'
  const amount = charge.toLocaleString()
  const policyLinks = POLICY_LINKS.map(p => `<a href="${p.to}" target="_blank" rel="noopener">${p.label}</a>`).join('・')
  try {
    await ElMessageBox.confirm(
      `<p>換卡需要由你在 PAYUNi 付款頁完成一次實際付款（新卡才會被記錄下來），`
      + `因此這次會以新卡收取 <b>NT$${amount}</b>（含稅）。</p>`
      + (isPastDue
        ? `<p>本期的自動扣款尚未成功，這筆就是補繳；付款完成後「${pv.name}」方案會從今天重新起算一整期。</p>`
        : `<p>目前方案已付到 ${pv.currentPeriodEnd}，這筆等於<b>提前支付下一期</b>——已付的天數不會消失，新一期接在 ${pv.currentPeriodEnd} 之後。</p>`)
      + `<p>之後每月自動扣款改用新卡。</p><p>${CHECKOUT_CONSENT_TEXT}</p><p>${policyLinks}</p>`,
      '更新付款方式',
      {
        dangerouslyUseHTMLString: true, // 只放我們自己的字串與政策連結，無使用者輸入
        confirmButtonText: '同意條款並前往換卡付款',
        cancelButtonText: '取消',
        type: 'info',
      },
    )
  }
  catch { return }

  updatingCard.value = true
  const overlay = ElLoading.service({ lock: true, text: '正在前往 PAYUNi 安全付款頁面…' })
  try {
    const res = await apiFetch<{ action: string; fields: Record<string, string> }>('/api/payment/create-order', {
      method: 'POST',
      body: { planId: pv.id, workspaceId: route.params.workspaceId, termsAccepted: true },
    })
    if (!res.action) throw new Error('金流尚未設定')
    submitToGateway(res.action, res.fields)
  }
  catch (e: any) {
    overlay.close()
    updatingCard.value = false
    showToast(e?.data?.statusMessage || e?.message || '建立訂單失敗', 'error')
  }
}

/** 待付款訂單「取消」:作廢這筆 pending（標記逾期）→ 從清單移除。 */
async function cancelOrder(row: OrderRow) {
  try {
    await ElMessageBox.confirm(`確定取消這筆待付款訂單（${row.merchantOrderNo}）嗎？`, '取消訂單', {
      confirmButtonText: '取消訂單', cancelButtonText: '再想想', type: 'warning',
    })
  }
  catch { return }

  actingOrder.value = row.merchantOrderNo
  try {
    await apiFetch('/api/payment/void-order', { method: 'POST', body: { merchantOrderNo: row.merchantOrderNo } })
    showToast('已取消該筆訂單', 'success')
    await loadOrders()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '取消失敗', 'error')
  }
  finally {
    actingOrder.value = ''
  }
}

async function loadInvoiceProfile() {
  if (!invoiceEnabled) return
  try {
    const res = await apiFetch<{
      orgId: string | null
      override: Record<string, string | null>
      effective: Record<string, string | null>
      inherited: boolean
    }>('/api/payment/invoice-profile')

    invoiceOrgId.value = res.orgId
    effectiveInvoice.value = res.effective
    invoiceOverriding.value = !res.inherited

    const p = res.inherited ? res.effective : res.override
    invoiceForm.buyerUBN = p.buyerUBN ?? ''
    invoiceForm.buyerName = p.buyerName ?? ''
    invoiceForm.buyerEmail = p.buyerEmail ?? ''
    invoiceForm.carrierNum = p.carrierNum ?? ''
    invoiceForm.loveCode = p.loveCode ?? ''
  }
  catch { /* 讀不到就留空表單，不擋整頁 */ }
}

async function reloadAll() {
  loading.value = true
  try { await Promise.all([loadPlanSummary(), loadOrders(), loadInvoiceProfile()]) }
  finally { loading.value = false }
}

/**
 * 帶著 #invoice 進來（升級對話框的「先填發票資訊」）就捲到發票區。
 * 發票卡在整頁最下面，不捲的話等於把人丟在頁面頂端自己找。
 */
function scrollToInvoice() {
  if (route.hash !== '#invoice') return
  nextTick(() => document.getElementById('invoice')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}
watch(() => route.hash, scrollToInvoice)

onMounted(async () => {
  scrollToInvoice() // 發票卡的 v-if 只看靜態設定，不用等資料回來就能捲
  await reloadAll()
  scrollToInvoice() // 資料回來後上方卡片會長高、位置跑掉，再對正一次
  pollReturnedOrder()
})
onUnmounted(stopPoll)
</script>
