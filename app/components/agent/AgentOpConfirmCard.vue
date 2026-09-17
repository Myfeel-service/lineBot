<template>
  <div class="aa-op" :class="`is-${state}`">
    <div class="aa-op__head">
      <span class="aa-op__title">{{ pending.label }}</span>
      <span class="aa-op__badge" :class="{ 'is-retired': retired }">{{ badge }}</span>
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
    <!-- 已經不作數的卡：⛔不給按鈕，但也不要整張藏起來——
         人要看得到自己當時提過什麼，藏掉等於把對話的一段歷史抹掉 -->
    <p v-if="state === 'idle' && retired" class="aa-op__status">
      {{ cancelledByUser ? '你在對話裡說不用了，這張就不做了。' : '這個提議已經被後面那一個取代，不會執行。' }}
    </p>

    <div v-else-if="state === 'idle'" class="aa-op__actions">
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

const props = withDefaults(defineProps<{
  pending: AdminOpPending
  /** 被後面那張卡取代（同一個操作、同一個對象） */
  superseded?: boolean
  /** 使用者在對話裡收回了這個提議（「算了」「不用了」） */
  cancelledByUser?: boolean
  /** 不是最新的那一張——還能按，但要讓人知道這不是剛剛的事 */
  stale?: boolean
  /** 這張卡什麼時候出現的（畫「幾分鐘前提的」用） */
  proposedAt?: number
}>(), { superseded: false, cancelledByUser: false, stale: false, proposedAt: undefined })
const emit = defineEmits<{
  (e: 'done', payload: { ok: boolean, message: string, details?: string[] }): void
  (e: 'cancel'): void
  /** 「不用做」的卡片被關掉：外面要清掉待確認狀態，但不必在對話裡多講一句 */
  (e: 'dismiss'): void
}>()

const { apiFetch } = useWorkspace()
const state = ref<'idle' | 'running' | 'done' | 'failed' | 'cancelled'>('idle')

/** 這張卡還作不作數（被取代、或使用者已經收回） */
const retired = computed(() => props.superseded || props.cancelledByUser)

/** 標題旁那顆徽章：不是最新的那張要講出「這是幾分鐘前的事」 */
const badge = computed(() => {
  if (props.cancelledByUser) return '你已經說不用了'
  if (props.superseded) return '已被下面那個取代'
  if (!props.stale || !props.proposedAt) return '還沒執行'
  const mins = Math.floor((Date.now() - props.proposedAt) / 60_000)
  return mins < 1 ? '還沒執行（剛剛提的）' : `還沒執行（${mins} 分鐘前提的）`
})

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
