<template>
  <footer class="lp-foot">
    <div class="lp-wrap lp-foot__in">
      <div class="lp-foot__col lp-foot__col--brand">
        <BrandLogo class="lp-foot__brand" />
        <p class="lp-foot__tag">你的顧客，其實很值錢</p>
        <ul class="lp-foot__list">
          <li><span class="lp-foot__k">公司名稱</span><span>{{ companyName }}</span></li>
          <li><span class="lp-foot__k">統一編號</span><span>{{ taxId }}</span></li>
          <li><span class="lp-foot__k">服務名稱</span><span>{{ serviceFullName }}</span></li>
        </ul>
      </div>

      <div class="lp-foot__col">
        <h2 class="lp-foot__h">客服聯絡</h2>
        <ul class="lp-foot__list">
          <li><span class="lp-foot__k">客服電話</span><a :href="phoneHref">{{ phone }}</a></li>
          <li><span class="lp-foot__k">客服信箱</span><a :href="emailHref">{{ email }}</a></li>
          <li><span class="lp-foot__k">服務時間</span><span>{{ hours }}</span></li>
        </ul>
      </div>

      <div class="lp-foot__col">
        <h2 class="lp-foot__h">產品</h2>
        <ul class="lp-foot__list lp-foot__list--nav">
          <!-- 用 /#anchor（不是 #anchor）：法務頁上也要能跳回首頁對應段落 -->
          <!-- ⛔ 別加回 /#demo：首頁的預約 Demo 表單 2026-08-14 已整區移除，
               想找人談的走左邊「客服聯絡」那欄的電話與信箱 -->
          <li><a href="/#value">產品介紹</a></li>
          <li><a href="/#diff">功能比較</a></li>
          <li><a href="/#pricing">定價</a></li>
          <li><a href="/#faq">常見問題</a></li>
          <li><NuxtLink to="/login">免費註冊</NuxtLink></li>
          <li><NuxtLink to="/login">登入</NuxtLink></li>
        </ul>
      </div>

      <div class="lp-foot__col">
        <h2 class="lp-foot__h">政策與條款</h2>
        <ul class="lp-foot__list lp-foot__list--nav">
          <li v-for="p in POLICY_LINKS" :key="p.to"><NuxtLink :to="p.to">{{ p.label }}</NuxtLink></li>
        </ul>
      </div>
    </div>

    <div class="lp-foot__bar">
      <div class="lp-wrap lp-foot__bar-in">
        <span>© {{ year }} {{ companyName }}　保留一切權利</span>
        <span class="lp-foot__pay">信用卡付款由統一金流 PAYUNi 處理　·　依法開立電子發票</span>
      </div>
    </div>
  </footer>
</template>

<script setup lang="ts">
// 公開頁共用 footer：公司名稱、統一編號、服務名稱、客服電話／信箱／時間、三份政策連結。
// 這些項目是金流風控的必要揭露（見 nuxt.config 的 legalCompanyName 註解），
// 所有對外頁面都掛同一個元件，避免有頁面漏揭露或寫得不一致。
//
// ⚠️ 品牌／服務名（MiniMe）與營運主體（麥菲爾股份有限公司）是兩件事，都要看得到：
//    發票賣方、法務頁主體、風控核對的「公司名稱」用的是後者。
import { POLICY_LINKS } from '~~/shared/legal'

// 品牌名不在這裡取用：商標由 <BrandLogo /> 出（logotype 已含 MiniMe 字樣）
const { serviceFullName, companyName, taxId, email, emailHref, phone, phoneHref, hours } = useSiteIdentity()

const year = new Date().getFullYear()
</script>
