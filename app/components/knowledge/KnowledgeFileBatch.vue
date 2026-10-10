<template>
  <div>
    <p class="kb-step-label">
      <span class="kb-step-count">第 {{ finished ? 3 : 2 }} 步，共 3 步</span>{{ finished ? '匯入完成' : `一次匯入 ${pendingCount} 份檔案` }}
    </p>
    <p class="kb-section-hint">
      每一份會<strong>各自成為一份資料</strong>：AI 整理完直接匯入，不逐條預覽；完成後可以到資料清單點開檢查。
    </p>

    <!-- 跑完的結論列：沒有逐條預覽，結束一定要講「做了什麼、還要看什麼」（同整站匯入） -->
    <el-alert
      v-if="finished"
      :type="failedCount || warnedCount || quotaShortTotal ? 'warning' : 'success'"
      show-icon
      :closable="false"
      class="kb-site-summary"
    >
      <template #title>
        已建立 {{ okCount }} 份資料、共 {{ cardTotal }} 條知識
      </template>
      <div class="text-xs">
        <template v-if="notLearnedTotal">其中 <strong>{{ notLearnedTotal }}</strong> 條 AI 還沒學起來（客人問到會找不到）——到那份資料點開該條按「重新學習」即可。</template>
        <template v-if="quotaShortTotal">另有 <strong>{{ quotaShortTotal }}</strong> 條因為知識空間不夠沒收進去（清單上有標是哪幾份）。</template>
        <template v-if="failedCount">{{ failedCount }} 份沒有匯入（清單上有標原因，可以再按一次重試）。</template>
        <template v-if="warnedCount">{{ warnedCount }} 份帶有提醒，建議點開檢查內容。</template>
        <template v-if="!failedCount && !warnedCount && !notLearnedTotal && !quotaShortTotal">這些知識沒有經過逐條預覽，建議到知識庫抽幾條看看內容是否合用。</template>
      </div>
    </el-alert>

    <div class="kb-site-list">
      <div v-for="r in rows" :key="r.key" class="kb-site-row">
        <span class="kb-file-batch__kind">{{ r.kindLabel }}</span>
        <div class="kb-site-page">
          <div class="kb-site-title">{{ r.name }}</div>
          <div class="kb-site-url">{{ r.sizeLabel }}</div>
          <div v-if="r.error" class="kb-site-error">✕ {{ r.error }}</div>
          <div v-if="r.quotaShort" class="kb-site-warnings">⚠︎ 知識空間不夠：收了前 {{ r.cards }} 條，還有 {{ r.quotaShort }} 條沒收進去</div>
          <div v-if="r.warningTexts.length" class="kb-site-warnings">
            <div v-for="(w, i) in r.warningTexts" :key="i">⚠︎ {{ w }}</div>
          </div>
        </div>
        <span class="kb-site-status" :class="`is-${r.status === 'rejected' ? 'failed' : r.status}`">
          <template v-if="r.status === 'processing'">{{ r.stage }}⋯</template>
          <template v-else-if="r.status === 'done'">
            ✓ {{ r.cards }} 條<span v-if="r.notLearned" class="kb-site-status__warn">（{{ r.notLearned }} 條待學）</span>
          </template>
          <template v-else-if="r.status === 'failed'">✕ 沒有匯入</template>
          <template v-else-if="r.status === 'rejected'">不收</template>
          <template v-else>等待中</template>
        </span>
      </div>
    </div>

    <div class="kb-import-actions">
      <el-button :disabled="running" @click="emit('back')">上一步</el-button>
      <!-- 跑完而且沒有可以重試的：這顆就不該留著（一顆寫著「重試 0 份」的灰按鈕只會讓人以為還有事沒做完） -->
      <el-button
        v-if="!finished || pendingCount"
        type="primary"
        :loading="running"
        :disabled="!pendingCount || running"
        @click="run"
      >
        {{ running ? `匯入中（${doneCount}/${batchTotal}）⋯` : finished ? `重試沒匯入的 ${pendingCount} 份` : `整理並匯入這 ${pendingCount} 份` }}
      </el-button>
      <el-button v-if="finished && !running" type="primary" plain @click="emit('close')">
        完成，去看知識庫
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 一次匯入好幾份檔案（`C-296`④，`D-120` 第 1 步：老闆要「手邊有什麼就丟什麼、步驟最少」）。
 *
 * 形狀照整站匯入（`runSiteImport`）：一份一列、兩份同時跑、AI 整理完**直接匯入、不逐條預覽**、
 * 結束給一條結論列。⛔ 單一檔案照舊走有預覽的那條路——這裡只接「一次丟兩份以上」。
 *
 * 三個規矩：
 *  ① 收不了的檔（舊版 .doc、超過 10MB、超過一次 10 份）**列在清單上講原因**，不是默默少一份；
 *  ② 知識空間收到滿為止：放不下的那一份收前 N 條、標出幾條沒收；完全滿了就那一份不匯入並講；
 *  ③ 關窗時正在跑的那幾份會跑完（worker 只在開始下一份之前檢查中斷），還沒開始的不跑。
 */
import { pickFolderForSource } from '~~/shared/knowledge-folder-match'
import {
  KNOWLEDGE_FILE_KIND_LABEL,
  KNOWLEDGE_FILE_MAX_BYTES,
  knowledgeFileKind,
  unsupportedFileHint,
} from '~~/shared/knowledge-file-types'
import { PREVIEW_JOB_DEADLINE } from '~/composables/usePreviewJobPoll'

/** 一次最多幾份：每份一次 AI 整理，再多就該分批（也避免瀏覽器分頁被綁住太久） */
const MAX_FILE_BATCH = 10

const props = defineProps<{
  files: File[]
  folders?: Array<{ id: string; name: string }>
  /** 知識空間（匯入視窗讀好的那份）；null＝不限或讀不到 */
  quota: { used: number, limit: number | null } | null
}>()

const emit = defineEmits<{
  (e: 'back'): void
  (e: 'close'): void
  (e: 'running', on: boolean): void
  /** 這一批跑完（含中途關窗收工）：建了幾份、幾條——父層用來刷新清單與結算 */
  (e: 'finished', summary: { sources: number, cards: number, quotaShort: number }): void
}>()

const { apiFetch } = useWorkspace()
const { poll: pollPreviewJob, reset: resetJobPoll } = usePreviewJobPoll()

type RowStatus = 'idle' | 'processing' | 'done' | 'failed' | 'rejected'
interface Row {
  key: string
  file: File | null
  name: string
  kindLabel: string
  sizeLabel: string
  status: RowStatus
  stage: string
  cards: number
  notLearned: number
  quotaShort: number
  warningTexts: string[]
  error: string
}

function sizeLabel(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const rows = ref<Row[]>([])
// ⚠️ 這幾個要宣告在下面那個 watch **之前**：watch 帶 immediate，setup 當下就會跑一次並寫 finished，
//    排在後面＝「Cannot access before initialization」，整個元件掛掉（匯入視窗吃過兩次同一顆雷）
const running = ref(false)
const finished = ref(false)
const doneCount = ref(0)
const batchTotal = ref(0)
let aborted = false

watch(() => props.files, (files) => {
  const seen = new Set<string>()
  let accepted = 0
  rows.value = files.map((file, i) => {
    const kind = knowledgeFileKind(file.name)
    const sameKey = `${file.name}:${file.size}`
    let error = ''
    if (!kind) error = unsupportedFileHint(file.name)
    else if (file.size > KNOWLEDGE_FILE_MAX_BYTES) error = '檔案超過 10MB 上限'
    else if (seen.has(sameKey)) error = '跟上面那一份是同一個檔，不重複匯入'
    else if (accepted >= MAX_FILE_BATCH) error = `一次最多 ${MAX_FILE_BATCH} 份，這份請下一批再放`
    if (!error) accepted++
    seen.add(sameKey)
    return {
      key: `${i}:${sameKey}`,
      file: error ? null : file,
      name: file.name,
      // 收不了的那份標副檔名（DOC、PAGES）——右邊狀態欄已經寫「不收」，這裡再寫一次就重複了
      kindLabel: kind ? KNOWLEDGE_FILE_KIND_LABEL[kind].replace(/ (文件|表格)$/, '') : (file.name.split('.').pop() ?? '').slice(0, 5).toUpperCase() || '檔案',
      sizeLabel: sizeLabel(file.size),
      status: error ? 'rejected' : 'idle',
      stage: '',
      cards: 0,
      notLearned: 0,
      quotaShort: 0,
      warningTexts: [],
      error,
    }
  })
  finished.value = false
}, { immediate: true })

/** 還可以跑的（第一次＝全部收得下的；跑完後＝沒匯入成功、可以重試的） */
const pendingCount = computed(() => rows.value.filter(r => r.file && (r.status === 'idle' || r.status === 'failed')).length)
const okRows = computed(() => rows.value.filter(r => r.status === 'done'))
const okCount = computed(() => okRows.value.filter(r => r.cards > 0).length)
const cardTotal = computed(() => okRows.value.reduce((s, r) => s + r.cards, 0))
const notLearnedTotal = computed(() => okRows.value.reduce((s, r) => s + r.notLearned, 0))
const quotaShortTotal = computed(() => rows.value.reduce((s, r) => s + r.quotaShort, 0))
const failedCount = computed(() => rows.value.filter(r => r.status === 'failed').length)
const warnedCount = computed(() => okRows.value.filter(r => r.warningTexts.length).length)

/** 關窗：通知 worker 收工（正在跑的會跑完，結論照樣 emit 給父層結算） */
function abort() {
  aborted = true
}
defineExpose({ abort, isRunning: () => running.value })

async function run() {
  const targets = rows.value.filter(r => r.file && (r.status === 'idle' || r.status === 'failed'))
  if (!targets.length) return
  running.value = true
  aborted = false
  finished.value = false
  emit('running', true)
  doneCount.value = 0
  batchTotal.value = targets.length
  resetJobPoll()

  // 空間收到滿為止：兩份同時跑，**送出前先預留**，不然兩份各自以為放得下、一起超收
  const limit = props.quota?.limit
  let room = limit == null ? Number.POSITIVE_INFINITY : Math.max(0, limit - (props.quota?.used ?? 0))

  let cursor = 0
  const worker = async () => {
    while (cursor < targets.length) {
      if (aborted) return
      const r = targets[cursor++]!
      const file = r.file!
      r.status = 'processing'
      r.error = ''
      r.quotaShort = 0
      r.warningTexts = []
      let jobId = ''
      let reserved = 0
      try {
        r.stage = '上傳中'
        const up = await apiFetch<{ storagePath: string; uploadUrl: string }>(
          '/api/ai/knowledge/upload-url',
          { method: 'POST', body: { fileName: file.name, contentType: file.type } },
        )
        // 直打簽名網址（絕對網址）→ 用 $fetch，不要用會加 workspace／auth 標頭的 apiFetch
        await $fetch(up.uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } })
        r.stage = '整理中'
        const created = await apiFetch<{ jobId?: string; duplicate?: { id: string; name: string } }>('/api/ai/knowledge/preview-jobs', {
          method: 'POST',
          // ⛔ 不帶 backgroundAdvance：這一份的匯入只在這個 worker 裡做，人一關窗就沒人收結果
          body: { type: 'file', fileName: file.name, contentType: file.type, storagePath: up.storagePath, generateOverview: false },
        })
        if (created.duplicate) {
          r.status = 'done'
          r.warningTexts = [`內容與既有資料「${created.duplicate.name}」完全相同，已跳過（沒有重複建立）`]
          continue
        }
        if (!created.jobId) throw new Error('建立整理工作失敗')
        jobId = created.jobId
        const res = await pollPreviewJob<{ chunks: Array<{ title: string; content: string; tags?: string[]; questions?: string[] }>; suggestedProductName?: string; contentHash?: string; warnings?: string[] }>(jobId)
        if (!res.chunks.length) throw new Error('AI 沒有整理出任何知識（內容可能太少）')

        let chunks = res.chunks
        if (room !== Number.POSITIVE_INFINITY) {
          if (room <= 0) {
            r.status = 'failed'
            r.error = '知識空間滿了，這份沒收進去（刪掉用不到的知識或升級方案後，可以再按一次重試）'
            void apiFetch(`/api/ai/knowledge/preview-jobs/${jobId}`, { method: 'DELETE' }).catch(() => {})
            continue
          }
          if (chunks.length > room) {
            r.quotaShort = chunks.length - room
            chunks = chunks.slice(0, room)
          }
          reserved = chunks.length
          room -= reserved
        }

        r.stage = '匯入中'
        const bulk = await apiFetch<{ total: number; indexed: number; failed: number }>('/api/ai/knowledge/bulk-create', {
          method: 'POST',
          body: {
            source: {
              type: 'file',
              name: file.name,
              fileName: file.name,
              productName: res.suggestedProductName ?? '',
              contentHash: res.contentHash ?? '',
              // 沒有逐份預覽＝更不會有人事後去拖資料夾：猜得到就放進去，猜不到就是未分類（跟整站同一把尺）
              folderId: pickFolderForSource(props.folders ?? [], { sourceName: file.name, productName: res.suggestedProductName ?? '' })?.folderId ?? null,
            },
            importId: jobId, // 冪等鍵：逾時重按不會多生一份
            chunks: chunks.map(c => ({ title: c.title, content: c.content, tags: c.tags ?? [], questions: c.questions ?? [] })),
            overviewCard: null,
          },
        })
        r.cards = bulk.total ?? bulk.indexed
        r.notLearned = bulk.failed ?? 0
        r.warningTexts = res.warnings ?? []
        r.status = 'done'
      }
      catch (err: any) {
        room += reserved // 沒匯進去，預留的空間還回去
        r.quotaShort = 0
        r.status = 'failed'
        if (err?.code === PREVIEW_JOB_DEADLINE) {
          // 這一份的匯入只在這裡做：逾時不能說「背景還在整理」，而且要主動停掉，不然排程會付錢做完再丟掉
          r.error = '整理太久，這份跳過了（沒有匯入，可以再按一次重試）'
          if (jobId) void apiFetch(`/api/ai/knowledge/preview-jobs/${jobId}`, { method: 'DELETE' }).catch(() => {})
        }
        else {
          r.error = String(err?.data?.statusMessage || err?.statusMessage || err?.message || '匯入失敗').slice(0, 120)
        }
      }
      finally {
        doneCount.value++
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, targets.length) }, worker))

  running.value = false
  finished.value = true
  emit('running', false)
  emit('finished', { sources: okCount.value, cards: cardTotal.value, quotaShort: quotaShortTotal.value })
}
</script>
