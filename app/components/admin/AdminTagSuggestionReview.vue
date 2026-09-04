<template>
  <el-drawer
    :model-value="visible"
    size="min(620px, 96vw)"
    :with-header="false"
    class="tag-review-drawer"
    @update:model-value="emit('update:visible', $event)"
  >
    <div class="tag-review">
      <span class="tag-review__eyebrow">AI 建議的標籤</span>
      <div class="tag-review__hd">
        <AdminTagTintChip :color="tag?.color || '#8a95a1'">{{ tag?.name || '（標籤已刪除）' }}</AdminTagTintChip>
        <span class="tag-review__count">{{ headingCount }}</span>
      </div>

      <!--
        ⛔ 這兩句是「按下去要負什麼責任」的說明，不是裝飾：
           採用會真的貼上（下游是推播發給誰）、忽略是**永久**的（含自動貼也不會再貼）。
           先前這件事只在客人單頁一位一位按，兩顆鈕旁邊什麼都沒寫。
      -->
      <p class="tag-review__hint">
        <strong>採用</strong>＝真的把這顆標籤貼到那位客人身上（記「AI 貼的」，隨時可拿掉）。
        <strong>忽略</strong>＝這顆標籤對那位客人<strong>永遠不再建議</strong>，之後 AI 也不會自動貼。
      </p>

      <!--
        這顆已經改成「判到直接貼」時的來龍去脈（D-61）：底下這些是**切換之前**留下的舊建議。
        ⛔ 一定要講「不按也會怎樣」——不然人會以為切成自動就沒事了，而這 116 條正是這樣積起來的。
      -->
      <p v-if="tag?.aiMode === 'auto'" class="tag-review__note">
        這顆現在設定成「AI 判到直接貼」，底下是<strong>改設定之前</strong>留下、還沒有人決定的舊建議。
        它們不會自己消失：要嘛你在這裡按，要嘛等那位客人下次再來聊天、AI 重新判到時自己貼上。
      </p>

      <!-- ⛔ 三態：載入中／讀不到／真的沒有，三種要分得出來（不可以都長成空清單） -->
      <div v-if="loading" class="tags-loading">
        <div class="spinner" />
        <span>載入中…</span>
      </div>
      <div v-else-if="loadFailed" class="tag-review__empty">
        <span>清單這次讀不到（不是「沒有人在等」）。關掉再開一次試試。</span>
      </div>
      <div v-else-if="!rows.length" class="tag-review__empty">
        <span>這顆標籤沒有人在等你決定了。</span>
      </div>

      <template v-else>
        <div class="tag-review__toolbar">
          <el-checkbox
            :model-value="allChecked"
            :indeterminate="someChecked"
            @change="toggleAll"
          >
            全選（{{ rows.length }} 位）
          </el-checkbox>
          <span class="tag-review__selected">已選 {{ selected.length }} 位</span>
        </div>

        <!-- ⛔ 截斷要講出來：靜靜少列幾條，畫面看起來就是「這顆只有這麼多人在等」 -->
        <p v-if="dropped || scanTruncated" class="tag-review__note">
          <template v-if="dropped">還有 {{ dropped }} 條沒列出來（一次最多列 {{ rows.length }} 條），處理完這批再打開一次就會看到。</template>
          <template v-else>待審資料已達掃描上限，實際可能比這裡列的更多。</template>
        </p>

        <ul class="tag-review__list">
          <li v-for="row in rows" :key="row.userId" class="tag-review__row">
            <el-checkbox
              :model-value="selected.includes(row.userId)"
              :disabled="!canOperate"
              @change="toggleOne(row.userId)"
            />
            <div class="tag-review__body">
              <div class="tag-review__who">
                <!-- ⛔ 沒有名字就講「沒有名字」，不要把 users 主鍵印出來當人名 -->
                <span class="tag-review__name">{{ row.displayName || '（沒有名字的好友）' }}</span>
                <span class="tag-review__when">{{ whenText(row.suggestedAtMs) }}</span>
              </div>
              <!--
                ⛔ 這句 reason 是 AI 自己的轉述、不是客人原話——所以旁邊那條連結是
                   「能不能負責任地按下去」的前提（同客人單頁那段的理由）。
              -->
              <p v-if="row.reason" class="tag-review__why">{{ row.reason }}</p>
              <p v-else class="tag-review__why tag-review__why--none">這條沒有留下判斷依據（舊資料）。</p>
              <button
                v-if="row.sessionId"
                type="button"
                class="tag-review__src"
                title="看 AI 是根據哪一場對話判斷的"
                @click="emit('open-conversation', row.userId, row.sessionId || '')"
              >看這段對話 →</button>
            </div>
          </li>
        </ul>
      </template>

      <!-- ⛔ 這一排永遠要在：抽屜沒有標題列（沒有那顆 ✕），只靠點外面關掉的話，
           看不到操作鈕的人（唯讀角色、清單是空的）會找不到出口 -->
      <div class="tag-review__actions">
        <template v-if="canOperate && rows.length">
          <el-button
            type="primary"
            :loading="acting === 'apply'"
            :disabled="!selected.length || acting !== ''"
            @click="submit('apply')"
          >採用選取的 {{ selected.length }} 位</el-button>
          <el-button
            :loading="acting === 'dismiss'"
            :disabled="!selected.length || acting !== ''"
            @click="submit('dismiss')"
          >忽略選取的 {{ selected.length }} 位</el-button>
        </template>
        <el-button text class="tag-review__close" @click="emit('update:visible', false)">關閉</el-button>
      </div>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { ElMessageBox } from 'element-plus'
import { PENDING_BULK_LIMIT, bulkReviewOutcomeText, pendingWhenText, type BulkReviewResult, type PendingReviewRow } from '~~/shared/tag-pending-review'

/**
 * 一次審一顆標籤的 AI 建議（`D-61`）。
 *
 * 為什麼要有這個抽屜：標籤頁的「待審 34 位」先前連到好友頁，而那頁列的是**全部**
 * 有建議的客人（不分標籤），34 條要一位一位開抽屜按——09-04 線上 116 條積壓
 * 沒有人清得完，卡的就是這一步。
 */

const props = defineProps<{
  visible: boolean
  /** null＝還沒選標籤（抽屜不會開） */
  tag: { id: string, name: string, color?: string, aiMode?: string } | null
  canOperate: boolean
  apiFetch: <T>(url: string, opts?: any) => Promise<T>
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  /** 有東西被處理掉了 → 宿主要重新載入「待審 N 位」 */
  (e: 'changed'): void
  /** 看 AI 的依據是哪一場對話（宿主決定要跳頁還是就地換場） */
  (e: 'open-conversation', userId: string, sessionId: string): void
}>()

const { showToast } = useAdminToast()

const rows = ref<PendingReviewRow[]>([])
const selected = ref<string[]>([])
const loading = ref(false)
const loadFailed = ref(false)
const dropped = ref(0)
const scanTruncated = ref(false)
const acting = ref<'' | 'apply' | 'dismiss'>('')

const headingCount = computed(() => {
  if (loading.value || loadFailed.value) return ''
  return `${rows.value.length} 位等你決定`
})
const allChecked = computed(() => rows.value.length > 0 && selected.value.length === rows.value.length)
const someChecked = computed(() => selected.value.length > 0 && !allChecked.value)

// 文案與「時間不明」那條規則在 shared（測得到），這裡只轉手
const whenText = pendingWhenText

function toggleAll() {
  selected.value = allChecked.value ? [] : rows.value.map(r => r.userId)
}

function toggleOne(userId: string) {
  selected.value = selected.value.includes(userId)
    ? selected.value.filter(id => id !== userId)
    : [...selected.value, userId]
}

async function load() {
  const tagId = props.tag?.id
  if (!tagId) return
  loading.value = true
  loadFailed.value = false
  selected.value = []
  try {
    const res = await props.apiFetch<{
      rows: PendingReviewRow[]
      dropped: number
      scanTruncated: boolean
    }>(`/api/tag/${encodeURIComponent(tagId)}/pending`)
    rows.value = res.rows ?? []
    dropped.value = res.dropped ?? 0
    scanTruncated.value = res.scanTruncated === true
  }
  catch {
    // ⛔ 讀失敗不可以退化成空清單：那看起來就是「沒有人在等你決定」
    rows.value = []
    loadFailed.value = true
  }
  finally {
    loading.value = false
  }
}

/** 打開時才載；換一顆標籤也要重載（同一個抽屜給 13 顆共用） */
watch(() => [props.visible, props.tag?.id], ([open]) => {
  if (open) void load()
})

async function submit(action: 'apply' | 'dismiss') {
  if (!props.canOperate || !props.tag || !selected.value.length) return
  const n = selected.value.length
  const name = props.tag.name
  try {
    await ElMessageBox.confirm(
      action === 'apply'
        ? `要把「${name}」貼到這 ${n} 位客人身上嗎？之後推播選這顆標籤時就會發給他們。`
        : `要忽略這 ${n} 位的「${name}」建議嗎？這顆標籤對這幾位客人永遠不再建議，AI 也不會自動貼。`,
      action === 'apply' ? `採用 ${n} 位` : `忽略 ${n} 位`,
      { confirmButtonText: action === 'apply' ? '確認貼上' : '確認忽略', cancelButtonText: '取消', type: 'warning' },
    )
  }
  catch { return } // 按取消

  acting.value = action
  const total: BulkReviewResult = { processed: 0, alreadyHandled: 0, notProcessed: 0, failed: 0 }
  try {
    // ⛔ 分批送：後端一次最多處理 PENDING_BULK_LIMIT 位，一次全丟過去會有人被靜靜略過
    for (let i = 0; i < selected.value.length; i += PENDING_BULK_LIMIT) {
      const chunk = selected.value.slice(i, i + PENDING_BULK_LIMIT)
      const res = await props.apiFetch<BulkReviewResult>(`/api/tag/${encodeURIComponent(props.tag.id)}/pending`, {
        method: 'POST',
        body: { action, userIds: chunk },
      })
      total.processed += res.processed ?? 0
      total.alreadyHandled += res.alreadyHandled ?? 0
      total.notProcessed += res.notProcessed ?? 0
      total.failed += res.failed ?? 0
    }
    showToast(bulkReviewOutcomeText(action, total), total.failed ? 'warning' : 'success')
    emit('changed')
    await load()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '處理失敗，請再試一次', 'error')
  }
  finally {
    acting.value = ''
  }
}
</script>
