<template>
  <!--
    FAQ 範本「長什麼樣子」的示意圖（2026-09-03，老闆問「用範本自己填是否有範本的樣貌」）。

    為什麼需要：「兩欄（問題／答案）」是抽象的，第一次填的人會猜——第一列要不要打欄位名稱？
    一列一題還是一列一段？答案可以多長？看一眼表格的樣子，這三個問題同時消失。
    ⛔ 內容跟 `scripts/generate-faq-template.mjs` 產出的範本**要對得上**（欄位名與示範列的口吻）：
       圖跟實際下載到的檔案長不一樣，比沒有圖更糟。第一版我寫「問題」，而真的範本是
       「客人會問的問題」——查證後才發現，改欄位名記得回來改這張圖。
    ⛔ 顏色一律走 token；這是我們自己畫的表格示意，不是任何試算表軟體的截圖。
  -->
  <figure class="kb-tpl-fig">
    <svg
      class="kb-tpl-fig__svg"
      viewBox="0 0 460 150"
      role="img"
      aria-label="示意圖：範本是兩欄的表格，第一列是欄位名稱「客人會問的問題」和「答案」，接下來每一列填一個問答，例如「運費怎麼算？」對應「滿 1000 元免運，未滿收 80 元運費。」"
    >
      <!-- 表格外框 -->
      <rect x="1" y="1" width="458" height="148" rx="6" fill="var(--bg-surface)" stroke="var(--el-border-color)" />

      <!-- 欄標（A / B）：讓人認得出這是試算表的欄，不是我們的表單 -->
      <rect x="1" y="1" width="458" height="18" fill="var(--el-fill-color)" />
      <text x="92" y="14" font-size="10" fill="var(--text-muted)" text-anchor="middle">A</text>
      <text x="300" y="14" font-size="10" fill="var(--text-muted)" text-anchor="middle">B</text>
      <line x1="184" y1="1" x2="184" y2="149" stroke="var(--el-border-color-lighter)" />

      <!-- 第 1 列＝欄位名稱（這是最常被漏掉的一件事，所以標號） -->
      <rect x="1" y="19" width="458" height="28" fill="var(--el-fill-color-lighter)" />
      <text x="14" y="38" font-size="11.5" font-weight="700" fill="var(--text-primary)">客人會問的問題</text>
      <text x="196" y="38" font-size="12" font-weight="700" fill="var(--text-primary)">答案</text>
      <rect x="3" y="21" width="454" height="24" rx="4" fill="none" stroke="var(--teach-mark)" stroke-width="1.5" />
      <circle cx="443" cy="33" r="9" fill="var(--teach-mark)" />
      <text x="443" y="37" font-size="11" font-weight="700" fill="#fff" text-anchor="middle">1</text>

      <!-- 示範列：一列一題（口吻與 generate-faq-template.mjs 的範本一致） -->
      <line x1="1" y1="47" x2="459" y2="47" stroke="var(--el-border-color-lighter)" />
      <text x="14" y="65" font-size="11" fill="var(--text-secondary)">錢什麼時候會退？</text>
      <text x="196" y="65" font-size="11" fill="var(--text-secondary)">客服確認後依每月排程刷退⋯</text>

      <line x1="1" y1="75" x2="459" y2="75" stroke="var(--el-border-color-lighter)" />
      <text x="14" y="93" font-size="11" fill="var(--text-secondary)">運費怎麼算？</text>
      <text x="196" y="93" font-size="11" fill="var(--text-secondary)">滿 1,000 元免運；未滿收 80 元。</text>

      <line x1="1" y1="103" x2="459" y2="103" stroke="var(--el-border-color-lighter)" />
      <text x="14" y="121" font-size="11" fill="var(--text-secondary)">多久出貨？</text>
      <text x="196" y="121" font-size="11" fill="var(--text-secondary)">付款後 3–5 個工作天內出貨。</text>

      <!-- ② 一列一題：填的人最常問的第二件事 -->
      <line x1="1" y1="131" x2="459" y2="131" stroke="var(--el-border-color-lighter)" />
      <text x="14" y="144" font-size="10.5" fill="var(--text-muted)">⋯ 一列一題，往下加就好</text>
      <circle cx="443" cy="139" r="9" fill="var(--teach-mark)" />
      <text x="443" y="143" font-size="11" font-weight="700" fill="#fff" text-anchor="middle">2</text>
    </svg>
    <figcaption class="kb-tpl-fig__cap">
      <strong>1</strong> 第一列固定是欄位名稱（範本已經填好，不要動）　<strong>2</strong> 之後一列一題，有幾題就填幾列——<strong>同一題不要開多列</strong>，其他問法 AI 會自動補
    </figcaption>
  </figure>
</template>

<script setup lang="ts">
/**
 * 純呈現，沒有 props。用在匯入視窗第一步「用範本自己填」那條路展開後。
 */
</script>

<!-- 樣式在 app/assets/scss/components/_knowledge-import.scss（.kb-tpl-fig） -->
