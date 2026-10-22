<template>
  <!-- `D-146`①：登入後第一頁（客服對話統計）最上面那一條（示意畫布 ①②）。讀不到、還沒接 LINE＝整條不畫 -->
  <div
    v-if="strip"
    class="lq-strip"
    :class="`lq-strip--${strip.level}`"
    data-tour="cs-line-quota"
    data-testid="cs-line-quota"
    :role="strip.level === 'over' ? 'alert' : undefined"
  >
    <div class="lq-strip__row">
      <span class="lq-strip__label">
        <el-icon class="lq-strip__icon"><component :is="strip.level === 'ok' ? ChatDotRound : strip.level === 'near' ? WarningFilled : CircleCloseFilled" /></el-icon>
        LINE 訊息
      </span>
      <span class="lq-strip__main">{{ strip.main }}</span>
      <div
        v-if="strip.usedPercent !== null"
        class="lq-strip__bar"
        role="progressbar"
        aria-label="LINE 訊息這個月用了多少"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="strip.usedPercent"
      >
        <div class="lq-strip__fill" :style="{ width: `${strip.usedPercent}%` }" />
      </div>
      <span v-else class="lq-strip__spacer" />
      <el-tooltip :content="strip.title" placement="bottom-end" :show-after="150">
        <span class="lq-strip__meta" tabindex="0">{{ strip.meta }} <span class="lq-strip__info" aria-hidden="true">ⓘ</span></span>
      </el-tooltip>
    </div>
    <div v-if="strip.note" class="lq-strip__note-row">
      <p class="lq-strip__note">{{ strip.note }}</p>
      <!-- 加購／升級要到 LINE 那邊做；只給管 LINE 的人（客服按了也進不去） -->
      <el-button
        v-if="can('line.manage')"
        tag="a"
        :href="LINE_OA_MANAGER_URL"
        target="_blank"
        rel="noopener"
        type="primary"
        size="small"
        class="lq-strip__go"
      >
        前往 LINE 官方帳號後台
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ChatDotRound, CircleCloseFilled, WarningFilled } from '@element-plus/icons-vue'
import { LINE_OA_MANAGER_URL, lineQuotaStrip } from '~~/shared/line-quota'

/**
 * LINE 這個月還剩幾則（`D-146`）。
 * ⛔ 不放進下面那排數字卡：那排跟著右上角的日期區間變，這個數字每月 1 號重算、不跟日期走，
 *    放進去會被讀成「近 7 天剩幾則」。
 * 平常灰一行；八成黃、用完紅，多一行講後果（句子在 shared/line-quota.ts，跟每一頁紅條、小幫手同一句）。
 */
const { workspaceId, can } = useWorkspace()
const { quota, load } = useLineQuota()

const strip = computed(() => lineQuotaStrip(quota.value))

// 換帳號要重問（這一頁換帳號時不一定重掛）；同一個帳號 5 分鐘內不重問（見 useLineQuota）
watch(workspaceId, () => { void load() }, { immediate: true })
</script>
