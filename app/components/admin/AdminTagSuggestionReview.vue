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
      <p v-if="effectiveAiMode === 'auto'" class="tag-review__note">
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
      <!--
        ⛔ 掃描沒掃完的時候，不可以斷言「沒有人在等你決定」（2026-09-04 code review 抓到）：
           那是一句**假的否定**——掃描撞上限＝我們根本沒看完，不知道有沒有人在等。
           三種「沒有」要講三種話（同 feedback_filters_must_report_what_they_dropped）。
      -->
      <div v-else-if="!rows.length" class="tag-review__empty">
        <span v-if="scanTruncated">
          等你決定的建議太多、這次沒有掃完，所以<strong>不確定</strong>這顆還有沒有人在等。
          先處理其他標籤，或稍後再打開一次。
        </span>
        <span v-else>這顆標籤沒有人在等你決定了。</span>
      </div>

      <template v-else>
        <div class="tag-review__toolbar">
          <!-- ⛔ 唯讀角色也要鎖：每一列都鎖了、只有全選沒鎖的話，
               他勾得動「已選 34 位」卻一顆動作鈕都沒有（那幾顆藏在 canOperate 後面），
               等於給了一個按了不會有結果的控制項 -->
          <el-checkbox
            :model-value="allChecked"
            :indeterminate="someChecked"
            :disabled="!canOperate"
            @change="toggleAll"
          >
            全選（{{ rows.length }} 位）
          </el-checkbox>
          <span class="tag-review__selected">已選 {{ selected.length }} 位</span>
        </div>

        <!--
          ⛔ 截斷要講出來：靜靜少列幾條，畫面看起來就是「這顆只有這麼多人在等」。
          ⛔ 兩句話是**兩件不同的事**，不可以用 if/else 只顯示一句（2026-09-04 code review 抓到）：
             「這批列不完」的下一步是「處理完再開一次」；「掃描沒掃完」則是這個承諾**兌現不了**
             ——兩個同時成立時只講前面那句，等於給了一個做不到的保證。
        -->
        <p v-if="dropped" class="tag-review__note">
          還有 {{ dropped }} 位沒列出來（一次最多列 {{ rows.length }} 位），處理完這批再打開一次就會看到。
        </p>
        <p v-if="scanTruncated" class="tag-review__note">
          等你決定的建議已達掃描上限，這次<strong>沒有全部看完</strong>，實際人數可能比這裡列的更多。
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
  /**
   * 有東西被處理掉了。帶著後端剛算好的「每顆標籤待審幾位」——
   * 宿主直接換上就好，不必再打一次 API（`D-61` code review：按一次原本要掃三輪同樣的資料）。
   * 沒帶就是拿不到（例如中途失敗），宿主自己去重抓。
   */
  (e: 'changed', summary?: { counts?: Record<string, number>, users?: number }): void
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
/** 後端這次回的當下設定；空字串＝還沒讀到，先用父層開抽屜時帶進來的那份 */
const freshAiMode = ref('')
const effectiveAiMode = computed(() => freshAiMode.value || String(props.tag?.aiMode ?? ''))

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
  freshAiMode.value = '' // 換一顆標籤時先清掉，別拿上一顆的設定講話
  try {
    const res = await props.apiFetch<{
      tag?: { aiMode?: string }
      rows: PendingReviewRow[]
      dropped: number
      scanTruncated: boolean
    }>(`/api/tag/${encodeURIComponent(tagId)}/pending`)
    rows.value = res.rows ?? []
    dropped.value = res.dropped ?? 0
    scanTruncated.value = res.scanTruncated === true
    /**
     * 端點本來就查了這顆標籤的當下設定，以前卻丟掉不用（2026-09-04 code review 抓到）。
     * 沒接的話，下面那段「這顆現在是判到直接貼」用的是**開頁時的舊快照**——
     * 同事在別的分頁把它從「先建議」切成「直接貼」，這個抽屜就會漏講、或講反。
     */
    freshAiMode.value = String(res.tag?.aiMode ?? '')
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
  const total: BulkReviewResult = { processed: 0, alreadyHandled: 0, notFound: 0, notProcessed: 0, failed: 0 }
  /**
   * ⛔ **中途失敗不可以把前面的成果當沒發生過**（2026-09-04 code review 抓到）。
   *
   * 舊寫法把整個迴圈包在一個 try 裡，第二批逾時就直接跳到 catch——於是第一批
   * **真的已經貼上去的 100 位**（標籤寫了、底帳也記了）連一句話都沒有：不刷新、
   * 不通知宿主、徽章還是 200、清單還是列 200。人再按一次，那 100 位變成
   * 「已經被處理過（略過）」，完全看不出第一次其實成功了一半。
   * 現在改成逐批 try：某一批炸掉就停下來，但**已經做掉的照樣算、照樣回報、照樣刷新**。
   */
  let stoppedAt = ''
  /** 後端隨處理結果帶回來的最新畫面資料（省掉兩輪重複掃描） */
  let fresh: { rows: PendingReviewRow[], dropped: number, scanTruncated: boolean, counts?: Record<string, number>, users?: number } | null = null
  // ⛔ 分批送：後端一次最多處理 PENDING_BULK_LIMIT 位，一次全丟過去會有人被靜靜略過
  for (let i = 0; i < selected.value.length; i += PENDING_BULK_LIMIT) {
    const chunk = selected.value.slice(i, i + PENDING_BULK_LIMIT)
    try {
      const res = await props.apiFetch<BulkReviewResult & {
        rows?: PendingReviewRow[]
        dropped?: number
        scanTruncated?: boolean
        counts?: Record<string, number>
      }>(`/api/tag/${encodeURIComponent(props.tag.id)}/pending`, {
        method: 'POST',
        body: { action, userIds: chunk },
      })
      total.processed += res.processed ?? 0
      total.alreadyHandled += res.alreadyHandled ?? 0
      total.notFound += res.notFound ?? 0
      total.notProcessed += res.notProcessed ?? 0
      total.failed += res.failed ?? 0
      // 後端已經把處理完的畫面資料算好了；留最後一批的（那才是最終狀態）
      if (res.rows) fresh = { rows: res.rows, dropped: res.dropped ?? 0, scanTruncated: res.scanTruncated === true, counts: res.counts }
    }
    catch (e: any) {
      stoppedAt = String(e?.data?.statusMessage || e?.statusMessage || '處理失敗')
      // 這一批以後的都沒送出去 → 算進「沒處理」，人才知道還剩幾位要再按一次
      total.notProcessed += selected.value.length - i
      break
    }
  }
  acting.value = ''

  const touched = total.processed + total.alreadyHandled + total.notFound
  if (stoppedAt) {
    showToast(
      touched
        ? `${bulkReviewOutcomeText(action, total)}；後面中斷了（${stoppedAt}），剩下的請再按一次`
        : `${stoppedAt}，請再試一次`,
      'error',
    )
  }
  else {
    showToast(bulkReviewOutcomeText(action, total), total.failed || total.notFound ? 'warning' : 'success')
  }
  // 只要真的動過任何一筆，宿主的「待審 N 位」與這份清單都要跟著更新——
  // 中斷不是「什麼都沒發生」，畫面停在舊數字才是真正會害人重複操作的那件事
  if (touched) {
    // ⛔ 位數與條數一起傳（`D-63` UI/UX 審查⑤）：宿主頁的橫幅兩個都要講，
    //    只傳 counts 的話「幾位客人」會停在舊數字
    emit('changed', fresh ? { counts: fresh.counts, users: fresh.users } : undefined)
    if (fresh) {
      // 後端已經回了最新狀態 → 直接換上，不用再打一次 GET（同一批資料不掃第三輪）
      rows.value = fresh.rows
      dropped.value = fresh.dropped
      scanTruncated.value = fresh.scanTruncated
      selected.value = []
    }
    else {
      await load() // 中途失敗、拿不到最新狀態時才退回重抓
    }
  }
}
</script>
