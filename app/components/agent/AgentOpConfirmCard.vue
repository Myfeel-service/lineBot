<template>
  <div class="aa-op" :class="`is-${state}`">
    <div class="aa-op__head">
      <span class="aa-op__title">{{ pending.label }}</span>
      <span class="aa-op__badge">還沒執行</span>
    </div>

    <p class="aa-op__summary">{{ pending.preview.summary }}</p>

    <ul v-if="pending.preview.items.length" class="aa-op__items">
      <li v-for="(it, i) in pending.preview.items" :key="i">
        <span class="aa-op__item-label">{{ it.label }}</span>
        <span v-if="it.note" class="aa-op__item-note">{{ it.note }}</span>
      </li>
    </ul>

    <p v-if="pending.preview.warning" class="aa-op__warning" role="note">⚠️ {{ pending.preview.warning }}</p>

    <!-- 已經是這個狀態＝沒有事情要做：只給「知道了」。
         ⛔ 不給一顆按下去什麼都不會發生的確認鈕（那會讓人以為自己改了什麼） -->
    <div v-if="state === 'idle'" class="aa-op__actions">
      <template v-if="pending.preview.noop">
        <!-- ⛔ 也要通知外面把憑證清掉：不清的話這個「已經不用做」的提議，
             會在下一句無關的話裡被當成【上一個提議】再塞回模型面前 -->
        <el-button size="small" @click="dismiss">知道了</el-button>
      </template>
      <template v-else>
        <el-button size="small" @click="cancel">取消</el-button>
        <el-button size="small" type="primary" @click="confirm">{{ pending.preview.confirmLabel }}</el-button>
      </template>
    </div>

    <p v-else-if="state === 'running'" class="aa-op__status">正在執行…</p>
    <p v-else-if="state === 'cancelled'" class="aa-op__status">已取消，沒有改到任何東西。</p>
    <p v-else-if="state === 'done'" class="aa-op__status is-done">✓ 已執行</p>
    <p v-else-if="state === 'failed'" class="aa-op__status is-failed">沒有執行成功</p>
  </div>
</template>

<script setup lang="ts">
/**
 * 小幫手代辦的確認卡（`C-31` Phase 2）。
 *
 * 紀律：
 * - 卡片上的每一句話都來自後端**當下查到的實況**（preview），⛔這個元件不寫任何動作說明文案。
 * - 按下確定之前，什麼都還沒有發生；標題旁的「還沒執行」就是在講這件事。
 * - 按過一次就不再給第二顆按鈕：同一張卡重複執行是使用者最容易誤觸的路。
 */
import type { AdminOpPending } from '~~/shared/types/admin-ops'

const props = defineProps<{ pending: AdminOpPending }>()
const emit = defineEmits<{
  (e: 'done', payload: { ok: boolean, message: string, details?: string[] }): void
  (e: 'cancel'): void
  /** 「不用做」的卡片被關掉：外面要清掉待確認狀態，但不必在對話裡多講一句 */
  (e: 'dismiss'): void
}>()

const { apiFetch } = useWorkspace()
const state = ref<'idle' | 'running' | 'done' | 'failed' | 'cancelled'>('idle')

function cancel() {
  state.value = 'cancelled'
  emit('cancel')
}

function dismiss() {
  state.value = 'cancelled'
  emit('dismiss')
}

async function confirm() {
  if (state.value !== 'idle') return
  state.value = 'running'
  try {
    const res = await apiFetch<{ ok: boolean, message: string, details?: string[] }>('/api/admin/agent/confirm', {
      method: 'POST',
      body: { token: props.pending.token },
    })
    state.value = res.ok ? 'done' : 'failed'
    emit('done', res)
  }
  catch (e: any) {
    // 後端擋下來的理由（過期、被別人改過、沒權限）要原樣講給使用者聽——
    // 這幾種的下一步完全不同，含糊成「失敗了」等於叫人瞎猜
    state.value = 'failed'
    emit('done', {
      ok: false,
      message: e?.statusMessage || e?.data?.statusMessage || '執行失敗，沒有確認改到什麼，請到對應頁面看一眼。',
    })
  }
}
</script>
