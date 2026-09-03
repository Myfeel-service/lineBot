<template>
  <!--
    Google 試算表「共用給服務帳號」的**示意圖**（2026-09-03，`C-106` 的示意版）。

    為什麼這裡可以有圖，而我們自己的畫面不行：
    ・**站外畫面該配圖**——這一步發生在 Google 的介面裡，我們的聚光燈導覽指不到那裡，
      使用者是在另一個網站上找「共用」按鈕（08-29 `D-40`③ 已拍板要做）。
    ・**站內畫面不配圖**（08-28 ＋ `D-40`④ 兩次拍板）——後台自己的畫面用聚光燈指真實元件，
      截圖會過期說謊。這個匯入視窗 09-03 一天內改了六版，任何截圖今天拍明天就錯。

    ⛔ 這是**示意圖不是截圖**（拍板原文：「Google 畫面誰截要指定、拿不到就畫示意」）：
       所以刻意用我們自己的設計語彙畫，並在圖說明講「示意」——不拼一張看起來像真截圖的假圖
       （見記憶 feedback_mockup_structure_not_style）。真截圖到手後可直接換掉這支元件。
    ⛔ 框線與編號徽章用 `--teach-mark`（低飽和磚紅），與截圖產線的紅同一個值
       （09-02 拍板「低飽和紅細框＋步驟編號」）；⛔不可以用 danger 紅：意思是「看這裡」不是「壞了」。
    ⛔ 顏色一律走 token：這張圖要跟著整站的深淺色一起變。
  -->
  <figure class="kb-share-fig">
    <svg
      class="kb-share-fig__svg"
      viewBox="0 0 460 168"
      role="img"
      aria-label="示意圖：在 Google 試算表的共用視窗裡，第一步把服務帳號貼進輸入格，第二步把權限改成檢視者，第三步按傳送"
    >
      <!-- 對話框外殼 -->
      <rect x="1" y="1" width="458" height="166" rx="8" fill="var(--bg-surface)" stroke="var(--el-border-color)" />
      <text x="16" y="24" font-size="12" font-weight="600" fill="var(--text-primary)">與使用者和群組共用</text>

      <!-- ① 貼上帳號的輸入格 -->
      <rect x="16" y="38" width="300" height="26" rx="4" fill="var(--el-fill-color-lighter)" stroke="var(--el-border-color-light)" />
      <text x="26" y="55" font-size="11" fill="var(--text-muted)">貼上剛剛複製的帳號</text>
      <rect x="13" y="35" width="306" height="32" rx="6" fill="none" stroke="var(--teach-mark)" stroke-width="1.5" />
      <circle cx="332" cy="51" r="9" fill="var(--teach-mark)" />
      <text x="332" y="55" font-size="11" font-weight="700" fill="#fff" text-anchor="middle">1</text>

      <!-- ② 權限下拉：預設是「編輯者」，要改成「檢視者」 -->
      <text x="16" y="96" font-size="11" fill="var(--text-secondary)">權限</text>
      <rect x="46" y="82" width="88" height="24" rx="4" fill="var(--bg-surface)" stroke="var(--el-border-color-light)" />
      <text x="56" y="98" font-size="11" fill="var(--text-primary)">檢視者</text>
      <path d="M120 92 l5 5 l5 -5" fill="none" stroke="var(--text-muted)" stroke-width="1.2" />
      <rect x="43" y="79" width="94" height="30" rx="6" fill="none" stroke="var(--teach-mark)" stroke-width="1.5" />
      <circle cx="150" cy="94" r="9" fill="var(--teach-mark)" />
      <text x="150" y="98" font-size="11" font-weight="700" fill="#fff" text-anchor="middle">2</text>
      <text x="168" y="98" font-size="10.5" fill="var(--text-muted)">（預設是「編輯者」，改成檢視就好）</text>

      <!-- 通知使用者：可以不勾（server 的錯誤訊息也這樣講） -->
      <rect x="16" y="124" width="11" height="11" rx="2" fill="var(--bg-surface)" stroke="var(--el-border-color)" />
      <text x="34" y="134" font-size="10.5" fill="var(--text-muted)">通知使用者（不用勾）</text>

      <!-- ③ 傳送 -->
      <rect x="316" y="120" width="60" height="26" rx="4" fill="var(--el-fill-color)" />
      <text x="346" y="137" font-size="11" fill="var(--text-secondary)" text-anchor="middle">取消</text>
      <rect x="384" y="120" width="60" height="26" rx="4" fill="var(--brand-green, #06c755)" />
      <text x="414" y="137" font-size="11" font-weight="600" fill="#fff" text-anchor="middle">傳送</text>
      <rect x="381" y="117" width="66" height="32" rx="6" fill="none" stroke="var(--teach-mark)" stroke-width="1.5" />
      <circle cx="414" cy="107" r="9" fill="var(--teach-mark)" />
      <text x="414" y="111" font-size="11" font-weight="700" fill="#fff" text-anchor="middle">3</text>
    </svg>
    <!-- ⛔ 這句不能省：它是「示意圖」與「截圖」的分界，也是我們沒有假造 Google 畫面的證據 -->
    <figcaption class="kb-share-fig__cap">示意圖（Google 的畫面配置與顏色可能略有不同，認「共用」和權限那一格就對了）</figcaption>
  </figure>
</template>

<script setup lang="ts">
/**
 * 純呈現，沒有 props。用在匯入視窗第一步「要改了自動更新」那條路展開後的分享步驟旁。
 */
</script>

<!-- 樣式在 app/assets/scss/components/_knowledge-import.scss（.kb-share-fig） -->
