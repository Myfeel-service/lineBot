<template>
  <!--
    試算表「共用給系統帳號」那一步的帳號＋「看圖怎麼按」三張截圖（加入視窗起步那一格、讀不到時那一塊共用）。
    ⛔ 不要再抄一份到別處（2026-10-13 `/code-review`）：以前兩處逐字各一份，Google 改了按鈕名稱只改到一份，
       兩處就教出不同的步驟，而且沒有任何測試會紅（`C-180` 那種畫面副本債）。
    ⛔ 圖是老闆拍的真截圖（2026-09-03，走 `make-onboarding-shots.py` 的 gsheet 區塊）：站外畫面不憑記憶畫，
       前一版畫的示意圖四處畫錯（欄位名、權限下拉位置、通知預設打勾）。
    ⚠️ 圖上的①②③是同一張共用視窗的三個位置，跟步驟那一句的三個動作同序（貼帳號→檢視者→傳送），
       改順序要一起改產線（`make-onboarding-shots.py`）。
    ⚠️ 「檢視者」留著：我們只需要看，選「編輯者」也讀得到，但少給權限比較安全。
  -->
  <span v-if="email" class="kb-start__email">
    <code class="kb-gsheet-email">{{ email }}</code>
    <el-button size="small" text type="primary" @click="emit('copy')">複製</el-button>
  </span>
  <span v-else class="text-xs text-muted">（讀不到系統帳號，請重新整理頁面或聯絡我們）</span>
  <button type="button" class="kb-start__fold" :aria-expanded="open" @click="open = !open">
    {{ open ? '收起圖' : '看圖怎麼按' }}
  </button>
  <div v-if="open" class="kb-start__shots">
    <figure class="kb-shot">
      <img :src="SHOTS.gsheetShare1" alt="Google 共用視窗最上面那一格，紅框標示要貼帳號的位置" loading="lazy">
      <figcaption><span class="kb-shot__n">1</span>帳號貼在紅框那一格</figcaption>
    </figure>
    <figure class="kb-shot">
      <img :src="SHOTS.gsheetShare2" alt="貼上帳號後右邊出現權限下拉，預設是編輯者，紅框標示要改成檢視者" loading="lazy">
      <figcaption><span class="kb-shot__n">2</span>Google 預設給「編輯者」，改成「檢視者」</figcaption>
    </figure>
    <figure class="kb-shot">
      <img :src="SHOTS.gsheetShare3" alt="共用視窗右下角，紅框標示傳送按鈕" loading="lazy">
      <figcaption><span class="kb-shot__n">3</span>按右下角的「傳送」（不用通知對方）</figcaption>
    </figure>
  </div>
</template>

<script setup lang="ts">
import { ONBOARDING_SHOTS as SHOTS } from '~/utils/onboarding-shots'

defineProps<{ email: string }>()
const emit = defineEmits<{ copy: [] }>()
/** 圖展開了沒：兩處共用同一個狀態（在起步那格打開過，讀不到時那塊也是開的），由父層傳進來 */
const open = defineModel<boolean>('open', { default: false })
</script>
