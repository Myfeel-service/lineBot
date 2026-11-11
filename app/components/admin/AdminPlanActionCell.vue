<template>
  <el-tooltip
    v-if="canCheckout"
    :disabled="ready"
    :content="blockReason"
    placement="top"
  >
    <!-- disabled 的按鈕不會觸發 tooltip，需外層 span 承接 hover -->
    <span>
      <el-button
        :type="action === '降級' ? 'info' : 'primary'"
        :plain="action === '降級'"
        size="small"
        :disabled="!scheduled && !ready"
        :loading="loading"
        @click="emit('checkout')"
      >
        <!-- 期末降級沒有新的一筆交易 → 不需勾同意、也不受金流未設定影響,
             而且按鈕要講清楚是「期末」生效,別讓人以為按下去就馬上降。 -->
        {{ scheduled ? '期末降級' : action }}
      </el-button>
    </span>
  </el-tooltip>
  <template v-else-if="custom">
    <el-button v-if="contactHref" size="small" @click="emit('contact')">聯繫我們</el-button>
    <span v-else class="text-xs text-muted">請洽窗口</span>
  </template>
  <!-- 免費層：不需結帳，但也不要留空白格（會像壞掉） -->
  <span v-else class="text-xs text-muted">{{ isCurrent ? '使用中' : '免費' }}</span>
</template>

<script setup lang="ts">
/**
 * 方案表那顆按鈕（`B-55`，2026-11-11 從 `AdminPlanUpgradeDialog.vue` 抽出來）。
 *
 * 為什麼要抽：手機上那張表改成一個方案一張卡之後，同一顆按鈕要出現在兩種版面裡。
 * 留在原地各寫一份的話，兩邊早晚會走散——而這顆是**收錢的按鈕**，走散的代價是
 * 「某一種版面上的鎖沒鎖住」或「按鈕文字講錯生效時間」。⛔ 不要把判斷搬進來：
 * 買不買得到、鎖不鎖、期末還是立即，全部由父層算好傳進來（那些判斷跟整張表的狀態有關）。
 */
defineProps<{
  /** 買得到嗎（`canCheckout`）；false 時只會是客製方案或免費層 */
  canCheckout: boolean
  /** 按下去會發生什麼 */
  action: '續訂' | '升級' | '降級'
  /** 這是「期末才生效」的降級（背後有自動續扣時）——不需勾同意、也不受金流未設定影響 */
  scheduled: boolean
  /** 現在可以結帳了嗎＝金流設定好 ＋ 勾了同意 ＋ 發票資訊填了 */
  ready: boolean
  /** 還不能結帳的原因（`ready` 為 false 時滑過按鈕會看到） */
  blockReason: string
  loading: boolean
  /** 客製方案（企業）：不走結帳，改成聯繫窗口 */
  custom: boolean
  /** 聯繫窗口的連結；空字串＝只顯示「請洽窗口」 */
  contactHref: string
  /** 這個方案就是目前在用的 */
  isCurrent: boolean
}>()

const emit = defineEmits<{ checkout: [], contact: [] }>()
</script>
