<template>
  <div class="lp lp-legal-page">
    <nav class="lp-nav">
      <div class="lp-wrap lp-nav__in">
        <!-- 與門面導覽列同一套：≤720px 換成只有圖標的 logomark（見 _landing.scss 的 .lp-brand） -->
        <NuxtLink class="lp-brand" to="/" :aria-label="brandName">
          <BrandLogo class="lp-brand__type" alt="" />
          <BrandLogo mark class="lp-brand__mark" alt="" />
        </NuxtLink>
        <div class="lp-nav__right">
          <NuxtLink to="/login" class="lp-nav__signin">登入</NuxtLink>
          <!-- 主要動線＝自助註冊（與首頁一致）；想先談的人走頁尾的客服電話／信箱 -->
          <NuxtLink class="lp-btn lp-btn--primary lp-btn--sm" to="/login">免費註冊</NuxtLink>
        </div>
      </div>
    </nav>

    <header class="lp-legal__hd">
      <div class="lp-wrap lp-legal__hd-in">
        <NuxtLink class="lp-legal__back" to="/">← 回首頁</NuxtLink>
        <h1>{{ title }}</h1>
        <div class="lp-legal__meta">
          <span><b>適用服務</b>{{ serviceFullName }}</span>
          <span><b>營運主體</b>{{ companyName }}（統一編號 {{ taxId }}）</span>
          <span><b>最後更新</b>{{ POLICY_VERSION }}</span>
        </div>
      </div>
    </header>

    <main class="lp-wrap lp-legal">
      <slot />

      <section class="lp-legal__contact">
        <h2>聯絡我們</h2>
        <p>對本{{ shortName }}有任何疑問，或需要我們協助處理，歡迎用以下任一方式聯絡，我們會在服務時間內儘速回覆。</p>
        <ul class="lp-legal__contact-list">
          <li><span class="lp-foot__k">公司名稱</span><span>{{ companyName }}</span></li>
          <li><span class="lp-foot__k">統一編號</span><span>{{ taxId }}</span></li>
          <li><span class="lp-foot__k">客服信箱</span><a :href="emailHref">{{ email }}</a></li>
          <li><span class="lp-foot__k">客服電話</span><a :href="phoneHref">{{ phone }}</a></li>
          <li><span class="lp-foot__k">服務時間</span><span>{{ hours }}</span></li>
        </ul>
      </section>

      <nav v-if="otherPolicies.length" class="lp-legal__more">
        <span class="lp-legal__more-k">其他條款</span>
        <NuxtLink v-for="p in otherPolicies" :key="p.to" :to="p.to">{{ p.label }} →</NuxtLink>
      </nav>
    </main>

    <SiteFooter />
  </div>
</template>

<script setup lang="ts">
/**
 * 法務頁（服務條款 / 隱私權政策 / 退費與取消政策）的共用外殼。
 *
 * 三頁的頁首、營運主體標示、聯絡窗口、頁尾都走這裡——金流風控是拿「公司名稱、統一編號、
 * 客服信箱、客服電話」逐頁核對的，共用一份才不會有頁面漏標或標得不一樣。
 * 版面沿用門面的 .lp 設計語言（外層 .lp 才吃得到 pages/_landing.scss 的變數與 nav/foot 樣式）。
 */
import { POLICY_LINKS, POLICY_VERSION } from '~~/shared/legal'

const props = defineProps<{
  /** 頁面標題，例「隱私權政策」。 */
  title: string
}>()

// brandName 只用在商標連結的 aria-label（看得到的字樣在 logotype 圖檔裡）
const { brandName, serviceFullName, companyName, taxId, email, emailHref, phone, phoneHref, hours } = useSiteIdentity()

/** 「對本政策有疑問」的自稱：把標題的「政策 / 條款」尾字拿來用，讀起來才順。 */
const shortName = computed(() => (props.title.endsWith('條款') ? '條款' : '政策'))

const route = useRoute()
/** 頁尾之外，條款彼此互連（審核與客戶都常一次看完三份）。 */
const otherPolicies = computed(() => POLICY_LINKS.filter(p => p.to !== route.path))
</script>
