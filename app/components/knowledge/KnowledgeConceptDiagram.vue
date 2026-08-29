<template>
  <!--
    「資料放進來之後會發生什麼事」的心智圖（D-40）。

    為什麼需要這張：很多人以為 AI 會把整份文件從頭讀到尾再回答，所以會擔心「檔案太長
    它讀不完」「要不要先幫它畫重點」。真正發生的事是**切成一條條、客人問的時候挑最相關
    的那幾條**——這個心智模型建立起來之後，後面所有決定（要不要勾總表、要不要補客人問法、
    為什麼答不出來）才講得通。

    ⛔ 這是「概念關係」不是「畫面操作」，所以用靜態示意圖而不是截圖：畫的是流程不是介面，
       後台改版不會讓它過期（站內畫面一律用聚光燈導覽，見 08-28 拍板）。
    ⛔ 用設計 token 上色、不寫死顏色：這份要跟著整站的深淺色一起變。
  -->
  <figure class="kb-concept">
    <svg
      class="kb-concept__svg"
      viewBox="0 0 520 112"
      role="img"
      aria-label="流程示意：你給的資料，AI 整理成一條條知識，客人問問題時挑最相關的那條來回答"
    >
      <!-- ① 你給的資料 -->
      <rect x="4" y="30" width="132" height="60" rx="6" fill="var(--el-fill-color-light)" stroke="var(--el-border-color-lighter)" />
      <text x="70" y="20" font-size="11" text-anchor="middle" fill="var(--text-muted)">① 你給的資料</text>
      <text x="70" y="54" font-size="12" text-anchor="middle" fill="var(--text-primary)">檔案・網址</text>
      <text x="70" y="72" font-size="12" text-anchor="middle" fill="var(--text-primary)">試算表・文字</text>

      <path d="M140 60 L172 60" stroke="var(--border-active)" stroke-width="1.5" marker-end="url(#kbArrow)" />

      <!-- ② 切成一條條知識 -->
      <rect x="178" y="30" width="132" height="60" rx="6" fill="var(--el-color-primary-light-9)" stroke="var(--el-color-primary-light-5)" />
      <text x="244" y="20" font-size="11" text-anchor="middle" fill="var(--text-muted)">② AI 幫你整理</text>
      <rect x="190" y="40" width="108" height="12" rx="2" fill="var(--el-color-primary-light-7)" />
      <rect x="190" y="56" width="108" height="12" rx="2" fill="var(--el-color-primary-light-7)" />
      <rect x="190" y="72" width="108" height="12" rx="2" fill="var(--el-color-primary-light-7)" />
      <text x="244" y="104" font-size="11" text-anchor="middle" fill="var(--text-secondary)">切成一條條問答</text>

      <path d="M314 60 L346 60" stroke="var(--border-active)" stroke-width="1.5" marker-end="url(#kbArrow)" />

      <!-- ③ 客人問的時候挑最相關的 -->
      <rect x="352" y="30" width="164" height="60" rx="6" fill="var(--el-color-success-light-9)" stroke="var(--el-color-success-light-5)" />
      <text x="434" y="20" font-size="11" text-anchor="middle" fill="var(--text-muted)">③ 客人問問題</text>
      <rect x="364" y="40" width="140" height="14" rx="2" fill="var(--el-color-success-light-7)" />
      <text x="434" y="50" font-size="10" text-anchor="middle" fill="var(--el-color-success)">挑最相關的那條</text>
      <text x="434" y="74" font-size="12" text-anchor="middle" fill="var(--text-primary)">照這條回答</text>

      <defs>
        <marker id="kbArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0 L8 4 L0 8 z" fill="var(--border-active)" />
        </marker>
      </defs>
      <!-- ⛔ 這裡刻意不再寫「沒放進來的事 AI 不會自己編」：它就在圖上方那段文字裡，
           同一句話講兩次會讓人以為是兩件事 -->
    </svg>
  </figure>
</template>

<script setup lang="ts">
/**
 * 純呈現，沒有 props：一張固定的概念圖。
 * 用在知識庫空狀態（第一次來的人最需要這個心智模型）。
 */
</script>

<!-- 樣式在 app/assets/scss/pages/_knowledge-sources.scss（.kb-concept） -->
