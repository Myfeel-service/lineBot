<template>
  <!--
    Google 試算表「共用給服務帳號」的**示意圖**（2026-09-03，`C-106` 的示意版）。

    為什麼這裡可以有圖，而我們自己的畫面不行：
    ・**站外畫面該配圖**——這一步發生在 Google 的介面裡，我們的聚光燈導覽指不到那裡，
      使用者是在另一個網站上找「共用」按鈕（08-29 `D-40`③ 已拍板要做）。
    ・**站內畫面不配圖**（08-28 ＋ `D-40`④ 兩次拍板）——後台自己的畫面用聚光燈指真實元件，
      截圖會過期說謊。這個匯入視窗 09-03 一天內改了六版，任何截圖今天拍明天就錯。

    ⚠️ **第二版：照老闆提供的真截圖修正**。第一版憑記憶畫，四處畫錯：
       ①欄位名是「新增使用者、群組、聊天室和日曆活動」不是「新增使用者和群組」
       ②權限下拉在輸入框**右邊**，而且貼上帳號後預設顯示「**編輯者**」（我畫成「檢視者」在下方）
       ③有一個**預設打勾**的「通知共用對象」＋訊息輸入框（我畫成未勾、也沒有訊息框）
       ④送出鈕「傳送」在右下（這個對了）。
       ——這就是「憑記憶畫別人的 UI」的風險。真截圖進產線後這支元件就該退場（見 `C-106`）。
    ⛔ 仍然**是示意圖不是截圖**：用我們自己的設計語彙畫、圖說寫明「示意」，不拼假圖
       （見記憶 feedback_mockup_structure_not_style）。
    ⛔ 框線與編號徽章用 `--teach-mark`（低飽和磚紅），與截圖產線的紅同一個值
       （09-02 拍板「低飽和紅細框＋步驟編號」）；⛔不可用 danger 紅：意思是「看這裡」不是「壞了」。
    ⛔ 除了 Google 自己的藍（#1a73e8，認得出來比配色一致重要）之外，顏色一律走 token。
  -->
  <figure class="kb-share-fig">
    <svg
      class="kb-share-fig__svg"
      viewBox="0 0 460 214"
      role="img"
      aria-label="示意圖：Google 試算表的共用視窗。第一步把服務帳號貼進「新增使用者」欄位，第二步把右邊的權限從「編輯者」改成「檢視者」，第三步可以取消勾選「通知共用對象」，第四步按右下角的傳送"
    >
      <rect x="1" y="1" width="458" height="212" rx="8" fill="var(--bg-surface)" stroke="var(--el-border-color)" />
      <text x="16" y="26" font-size="12" font-weight="600" fill="var(--text-primary)">共用「⋯ - 副本」</text>

      <!-- ① 貼上帳號的欄位（Google 的欄位名很長，照實寫） -->
      <rect x="16" y="46" width="286" height="34" rx="4" fill="var(--bg-surface)" stroke="#1a73e8" />
      <text x="24" y="44" font-size="8.5" fill="#1a73e8">新增使用者、群組、聊天室和日曆活動</text>
      <rect x="24" y="55" width="200" height="16" rx="8" fill="#e8f0fe" />
      <text x="34" y="67" font-size="9" fill="var(--text-secondary)">firebase-adminsdk-fbsvc@⋯</text>
      <rect x="13" y="43" width="292" height="40" rx="6" fill="none" stroke="var(--teach-mark)" stroke-width="1.5" />
      <circle cx="318" cy="63" r="9" fill="var(--teach-mark)" />
      <text x="318" y="67" font-size="11" font-weight="700" fill="#fff" text-anchor="middle">1</text>

      <!-- ② 權限下拉在右邊，貼上後預設是「編輯者」——要改成「檢視者」 -->
      <rect x="342" y="50" width="82" height="26" rx="4" fill="var(--bg-surface)" stroke="var(--el-border-color)" />
      <text x="352" y="67" font-size="10.5" fill="var(--text-primary)">編輯者</text>
      <path d="M406 60 l5 5 l5 -5" fill="none" stroke="var(--text-muted)" stroke-width="1.2" />
      <rect x="339" y="47" width="88" height="32" rx="6" fill="none" stroke="var(--teach-mark)" stroke-width="1.5" />
      <circle cx="437" cy="36" r="9" fill="var(--teach-mark)" />
      <text x="437" y="40" font-size="11" font-weight="700" fill="#fff" text-anchor="middle">2</text>

      <!-- ③ 通知共用對象：預設**打勾**，可以取消 -->
      <rect x="16" y="96" width="12" height="12" rx="2" fill="#1a73e8" />
      <path d="M19 102 l2.5 2.5 l4 -4.5" fill="none" stroke="#fff" stroke-width="1.6" />
      <text x="36" y="106" font-size="10.5" fill="var(--text-primary)">通知共用對象</text>
      <rect x="13" y="93" width="112" height="18" rx="5" fill="none" stroke="var(--teach-mark)" stroke-width="1.5" />
      <circle cx="139" cy="102" r="9" fill="var(--teach-mark)" />
      <text x="139" y="106" font-size="11" font-weight="700" fill="#fff" text-anchor="middle">3</text>

      <!-- 訊息輸入框：照實畫出來，不然使用者會以為自己開錯視窗 -->
      <rect x="16" y="118" width="408" height="38" rx="4" fill="var(--bg-surface)" stroke="var(--el-border-color)" />
      <text x="26" y="135" font-size="10" fill="var(--text-muted)">訊息（不用填）</text>

      <!-- ④ 傳送（Google 的主要按鈕是藍色圓角） -->
      <text x="330" y="186" font-size="10.5" fill="#1a73e8" text-anchor="middle">取消</text>
      <rect x="360" y="170" width="64" height="26" rx="13" fill="#1a73e8" />
      <text x="392" y="187" font-size="11" font-weight="600" fill="#fff" text-anchor="middle">傳送</text>
      <rect x="357" y="167" width="70" height="32" rx="6" fill="none" stroke="var(--teach-mark)" stroke-width="1.5" />
      <circle cx="437" cy="159" r="9" fill="var(--teach-mark)" />
      <text x="437" y="163" font-size="11" font-weight="700" fill="#fff" text-anchor="middle">4</text>
    </svg>
    <figcaption class="kb-share-fig__cap">
      <strong>1</strong> 貼上帳號　<strong>2</strong> 右邊從「編輯者」改成「<b>檢視者</b>」　<strong>3</strong> 通知可以取消勾　<strong>4</strong> 按傳送
      <br>示意圖（我們畫的，非 Google 實際截圖）
    </figcaption>
  </figure>
</template>

<script setup lang="ts">
/**
 * 純呈現，沒有 props。用在匯入視窗第一步「要改了自動更新」那條路展開後的分享步驟旁。
 */
</script>

<!-- 樣式在 app/assets/scss/components/_knowledge-import.scss（.kb-share-fig） -->
