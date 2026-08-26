<template>
  <SiteLegalPage title="商品資訊">
    <!-- ══════════════════════════════════════════════════════════════
         商品資訊獨立頁（2026-08-26 老闆拍板「直接開一個頁面」，原本是首頁定價區的一張卡）。

         ⚠️ 這一頁是**金流風控的核對清單**：商品名稱／說明／售價／付款與發票／銷售者
            五項必須集中同一處且對外可見（散在行銷文案裡是特店送件被退件的常見原因）。
            入口有三條：首頁定價區的連結、全站頁尾「產品」欄、以及本頁網址本身。
         ⚠️ 當初 PAYUNi 審的是首頁上的這張卡——搬成獨立頁後若遇到風控複查，
            這頁就是給他們看的地方；上線後建議知會 PAYUNi 業務一句（見 STATUS G-28）。
         ⛔ 售價只列檯面上在賣的（FEATURED_PLAN_IDS）：列得比申報少不踩線，
            列得比申報多才會被退件（同首頁時期的取捨，理由詳見 shared/billing/plans.ts）。
         ══════════════════════════════════════════════════════════════ -->
    <section>
      <h2>商品內容</h2>
      <div class="lp-product lp-product--page">
        <dl class="lp-product__list">
          <div class="lp-product__row">
            <dt>商品名稱</dt>
            <dd><b>{{ serviceFullName }}</b></dd>
          </div>
          <div class="lp-product__row">
            <dt>商品說明</dt>
            <dd>讓 LINE 官方帳號的商家用戶透過本系統，導入自動化 AI 客服回覆，以及行銷與客戶關係管理(CRM)系統。以線上訂閱方式提供，無實體商品、不需運送。</dd>
          </div>
          <div class="lp-product__row">
            <dt>商品售價</dt>
            <dd>月租 {{ paidPriceList }}（新臺幣含稅價，以「LINE 官方帳號」為單位計價）；另有免費方案，企業需求為客製報價。</dd>
          </div>
          <div class="lp-product__row">
            <dt>付款與發票</dt>
            <!-- 帳單請款名稱要在這裡露出：風控找的就是這一格，客人事後對帳也翻得到
                 （為什麼非講不可見 shared/billing/statement.ts）。 -->
            <dd>
              信用卡付款，由<b>統一金流 PAYUNi</b> 處理；付款完成後依法開立<b>電子發票</b>並寄到你的帳務信箱。<template v-if="cardStatementName">信用卡帳單上會顯示「<b>{{ cardStatementName }}</b>」（{{ companyName }}）。</template>
            </dd>
          </div>
          <div class="lp-product__row">
            <dt>銷售者</dt>
            <dd>{{ companyName }}（統一編號 {{ taxId }}）　客服電話 {{ phone }}　客服信箱 {{ email }}</dd>
          </div>
        </dl>
      </div>
    </section>

    <section>
      <h2>額度與計費方式</h2>
      <!-- 這兩句與首頁定價區、FAQ「會不會爆帳單」同一套說法，改任何一處要三處一起改 -->
      <p>
        每個帳號都有免費額度，之後按 AI 回覆則數計價。用量在後台看得到，
        額度用完時 AI 會停止自動回覆並轉真人接手，<b>不會自動加收超量費用</b>——要加購額度或升級方案都由你決定。
      </p>
    </section>

    <section>
      <h2>取消與退費</h2>
      <!-- ⛔ 退費措辭只有一種寫法（實際政策沒有退現金也沒有試用期）：
           「不綁約、隨時可取消，取消後服務用到本期結束」。 -->
      <p>
        不綁約、隨時可取消，取消後服務用到本期結束——詳細規則見<NuxtLink to="/refund">退費與取消政策</NuxtLink>與<NuxtLink to="/terms">服務條款</NuxtLink>。
        試銷期方案與額度可能調整，實際以後台顯示為準。
      </p>
    </section>
  </SiteLegalPage>
</template>

<script setup lang="ts">
import { BILLING_PLANS, FEATURED_PLAN_IDS } from '~~/shared/billing/plans'

definePageMeta({ layout: false })

const { serviceFullName, companyName, taxId, phone, email, cardStatementName } = useSiteIdentity()

/** 千分位。刻意不用 toLocaleString：SSR 與瀏覽器可能給出不同字串（同 index.vue）。 */
function fmt(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * 要揭露的售價：跟著檯面上在賣的（FEATURED_PLAN_IDS，試銷期只主打免費＋399）。
 * 這個 computed 原本在 index.vue 的商品資訊卡上，整卡搬過來時一起搬——別兩邊各留一份。
 */
const paidPriceList = computed(() =>
  FEATURED_PLAN_IDS
    .map(id => BILLING_PLANS[id])
    .filter(p => typeof p.priceMonthly === 'number' && p.priceMonthly > 0)
    .map(p => `NT$${fmt(p.priceMonthly as number)}`)
    .join('／'),
)

useSeoMeta({
  title: `商品資訊與付款說明｜${serviceFullName}`,
  description: '商品名稱、內容說明、售價、付款方式與電子發票、銷售者資訊——一頁看完本服務的購買相關資訊。',
})
</script>
