<template>
  <el-dialog
    :model-value="!!fixTarget"
    :title="fixTarget ? `幫我修：${fixTarget.title}` : ''"
    width="520px"
    append-to-body
    :z-index="2600"
    class="afx-dialog"
    :close-on-click-modal="phase !== 'executing'"
    :show-close="phase !== 'executing'"
    @update:model-value="onDialogToggle"
    @closed="reset"
  >
    <!-- ① 讀取預告：popup 的每一句都來自後端當下的查詢，這裡沒有寫死的動作說明 -->
    <div v-if="phase === 'loading'" class="afx-loading" aria-live="polite">
      正在查現在的狀況、算會動到哪幾筆…
    </div>

    <!-- 預告查不到：誠實講，不猜、不給執行鈕 -->
    <div v-else-if="phase === 'load-failed'" class="afx-blocked" role="alert">
      <p>這次查不到現況（不代表壞掉）。沒查到「會動哪幾筆」之前不會執行任何動作。</p>
      <el-button size="small" @click="loadPreview">再查一次</el-button>
    </div>

    <!-- ② 預告 -->
    <template v-else-if="phase === 'preview' && preview">
      <p class="afx-summary">{{ preview.summary }}</p>
      <ul v-if="preview.items.length" class="afx-items">
        <li v-for="(it, i) in preview.items" :key="i">
          <span class="afx-items__label">{{ it.label }}</span>
          <span v-if="it.note" class="afx-items__note">{{ it.note }}</span>
        </li>
      </ul>
      <p v-if="preview.warning" class="afx-warning" role="note">⚠️ {{ preview.warning }}</p>
      <!-- clear／blocked 沒有執行鈕：沒事就是沒事、修不了就指下一步，不給假按鈕 -->
      <p v-if="preview.state === 'clear'" class="afx-clear">✓ 沒有要做的事——若提醒還亮著，過一下會自己熄掉。</p>
    </template>

    <!-- ③ 執行中 -->
    <div v-else-if="phase === 'executing'" class="afx-loading" aria-live="polite">
      正在處理…做完會當場再檢查一次。
    </div>

    <!-- ④ 結果＋驗證：做了什麼如實講；「修好了沒」吃重查後的同一份異常訊號，不自己宣告 -->
    <template v-else-if="phase === 'done' && result">
      <p class="afx-result" :class="result.ok ? 'is-ok' : 'is-fail'">{{ result.message }}</p>
      <ul v-if="result.details?.length" class="afx-items afx-items--details">
        <li v-for="(d, i) in result.details" :key="i">{{ d }}</li>
      </ul>
      <p class="afx-verify" :class="`is-${verifyState}`" aria-live="polite">
        <template v-if="verifyState === 'checking'">再檢查一次中…</template>
        <template v-else-if="verifyState === 'clear'">✓ 再檢查過一次：這個問題已經解除。</template>
        <template v-else-if="verifyState === 'active'">再檢查一次，問題還在（可能還有這輪沒涵蓋到的部分）——可以再按一次「幫我修」，或照上面的說明處理。</template>
        <template v-else>這次沒檢查成功——查不到不代表沒修好，稍後看提醒有沒有自己熄掉。</template>
      </p>
    </template>

    <template #footer>
      <template v-if="phase === 'preview' && preview?.state === 'fixable'">
        <el-button @click="closeFix">取消</el-button>
        <el-button type="primary" @click="execute">{{ preview.confirmLabel || '確定執行' }}</el-button>
      </template>
      <el-button v-else-if="phase !== 'executing'" @click="closeFix">關閉</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import type { AlertFixExecuteResult, AlertFixPreview } from '~~/shared/types/alert-fix'

/**
 * 一鍵修確認 popup（`D-34`，2026-08-27 老闆拍板；`C-31` Phase 2 的確認流本體）。
 *
 * 流程紀律：
 * 1. 開窗先打 preview——「會動哪幾筆」由後端當下查實況，⛔這個元件不寫任何動作說明文案，
 *    寫死的說明跟實際影響遲早漂移。
 * 2. 只有人按了確定才打 execute（紅線精神：最後一顆按鈕留人）。
 * 3. 做完 refresh({ force: true }) 重跑**同一份**異常訊號當驗證——綠了才說解除，
 *    不綠如實講；⛔不另立第二套「修好了沒」的判定。
 *
 * 掛一份在 layout（入口有提醒帶與小幫手兩個，開窗狀態在 useAlertFix）。
 */
const { fixTarget, closeFix } = useAlertFix()
const { apiFetch } = useWorkspace()
const { alerts, refresh } = useWorkspaceAlerts()

type Phase = 'loading' | 'load-failed' | 'preview' | 'executing' | 'done'
const phase = ref<Phase>('loading')
const preview = ref<AlertFixPreview | null>(null)
const result = ref<AlertFixExecuteResult | null>(null)
const verifyState = ref<'checking' | 'clear' | 'active' | 'unknown'>('checking')

watch(fixTarget, (t) => {
  if (t) void loadPreview()
})

function reset() {
  phase.value = 'loading'
  preview.value = null
  result.value = null
  verifyState.value = 'checking'
}

function onDialogToggle(open: boolean) {
  if (!open) closeFix()
}

async function loadPreview() {
  const t = fixTarget.value
  if (!t?.fixOpId) return
  phase.value = 'loading'
  try {
    preview.value = await apiFetch<AlertFixPreview>('/api/admin/alert-fix/preview', {
      method: 'POST',
      body: { opId: t.fixOpId },
    })
    phase.value = 'preview'
  }
  catch {
    phase.value = 'load-failed'
  }
}

async function execute() {
  const t = fixTarget.value
  if (!t?.fixOpId) return
  phase.value = 'executing'
  try {
    result.value = await apiFetch<AlertFixExecuteResult>('/api/admin/alert-fix/execute', {
      method: 'POST',
      body: { opId: t.fixOpId },
    })
  }
  catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }; statusMessage?: string }
    result.value = {
      ok: false,
      message: `這次沒有執行成功：${String(err?.data?.statusMessage || err?.statusMessage || '連線失敗').slice(0, 160)}。沒有動到任何設定，可以再試一次。`,
    }
  }
  phase.value = 'done'

  // 驗證：重跑同一份異常訊號（force＝連後端外部查詢快取一起跳過），讀這顆異常的新狀態
  verifyState.value = 'checking'
  try {
    await refresh({ force: true })
    const fresh = alerts.value.find(a => a.id === t.id)
    verifyState.value = fresh?.state === 'clear' ? 'clear' : fresh?.state === 'active' ? 'active' : 'unknown'
  }
  catch {
    verifyState.value = 'unknown'
  }
}
</script>

<!-- 樣式在 app/assets/scss/components/_alert-fix.scss -->
