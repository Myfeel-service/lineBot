<template>
  <div>
    <p class="kb-step-label">
      <span class="kb-step-count">第 {{ finished ? 3 : 2 }} 步，共 3 步</span>{{ stepTitle }}
    </p>
    <p class="kb-section-hint">
      每一份會<strong>各自成為一份資料</strong>，整理好直接加進去；完成後可以到資料清單點開檢查。
    </p>

    <!-- 跑完的結論列：沒有逐條預覽，結束一定要講「做了什麼、還要看什麼」（同整站匯入） -->
    <el-alert
      v-if="finished"
      :type="failedCount || warnedCount || quotaShortTotal || conflictCount || notStartedCount ? 'warning' : 'success'"
      show-icon
      :closable="false"
      class="kb-site-summary"
    >
      <template #title>
        {{ okCount ? `已建立 ${okCount} 份資料、共 ${cardTotal} 條知識` : '這一批沒有建立新的資料' }}
      </template>
      <div class="text-xs">
        <template v-if="conflictCount"><strong>{{ conflictCount }}</strong> 份跟知識庫裡現有的資料同名，等你決定要換掉舊的、還是另外建一份。</template>
        <template v-if="notLearnedTotal">其中 <strong>{{ notLearnedTotal }}</strong> 條 AI 還沒學起來（客人問到會找不到）——到那份資料點開該條按「重新學習」即可。</template>
        <template v-if="quotaShortTotal">另有 <strong>{{ quotaShortTotal }}</strong> 條因為知識空間不夠沒收進去（清單上有標是哪幾份）。</template>
        <!-- 「可以再按一次重試」不寫在這裡：空間滿了那幾份的重試鈕是鎖住的（2026-10-12 文字審視），每一列自己講怎麼辦 -->
        <template v-if="failedCount - unsureCount > 0">{{ failedCount - unsureCount }} 份沒有加入（清單上有標原因）。</template>
        <template v-if="unsureCount">{{ unsureCount }} 份連線逾時、不確定加進去了沒，按下面的「重試」會跟伺服器確認。</template>
        <template v-if="notStartedCount">{{ notStartedCount }} 份還沒開始就停下了，可以按下面的按鈕接著加入。</template>
        <template v-if="skippedCount">{{ skippedCount }} 份跟現有資料一模一樣，已跳過（沒有重複建立）。</template>
        <template v-if="warnedCount">{{ warnedCount }} 份帶有提醒，建議點開檢查內容。</template>
        <template v-if="okCount && !failedCount && !warnedCount && !notLearnedTotal && !quotaShortTotal && !conflictCount && !notStartedCount">建議點開幾條看看內容對不對。</template>
      </div>
    </el-alert>

    <!-- 知識空間（`C-296`）：按之前就看得到；滿了就在這裡講、不讓他按（⛔ 不要每一份都上傳完才一份份失敗） -->
    <p v-if="quotaLine" class="kb-quota-line" :class="{ 'is-full': roomFull }">{{ quotaLine }}</p>

    <div class="kb-site-list">
      <div v-for="r in rows" :key="r.key" class="kb-site-row">
        <span class="kb-file-batch__kind">{{ r.kindLabel }}</span>
        <div class="kb-site-page">
          <div class="kb-site-title">{{ r.name }}</div>
          <div class="kb-site-url">{{ r.sizeLabel }}</div>
          <div v-if="r.error" class="kb-site-error">✕ {{ r.error }}</div>
          <!-- 同名：等他決定（`C-135` 單份那條路會問，一次好幾份也要問，⛔ 不默默多建一份重複的） -->
          <div v-if="r.status === 'conflict' && r.pending" class="kb-file-batch__conflict">
            <span>知識庫裡已經有一份「{{ r.pending.existing.name }}」（{{ r.pending.existing.chunkCount }} 條）</span>
            <el-button size="small" type="primary" plain :disabled="busy" @click="decide(r, 'replace')">換掉舊的</el-button>
            <el-button size="small" :disabled="busy" @click="decide(r, 'new')">另外建一份</el-button>
            <!-- 鎖住要講為什麼（2026-10-11 真的寫入測試踩到：另一份還在整理時按了沒反應，看起來像壞掉） -->
            <span v-if="running" class="text-xs text-muted">這一批跑完就能選</span>
          </div>
          <div v-if="r.quotaShort" class="kb-site-warnings">
            <!-- ⚠️ 不能叫他「一批裡再放一次」：內容一模一樣的在一次好幾份裡會被跳過；單獨放一份才會問要不要換掉原本那一份 -->
            ⚠︎ 知識空間不夠：收了前 {{ r.cards }} 條，還有 {{ r.quotaShort }} 條沒收進去（空出空間後，把這一份單獨再放一次、選擇換掉原本那一份，就能補齊）
          </div>
          <div v-if="r.warningTexts.length" class="kb-site-warnings">
            <div v-for="(w, i) in r.warningTexts" :key="i">⚠︎ {{ w }}</div>
          </div>
          <!-- 交代「做了什麼」的話（換掉了哪一份、跳過了哪一份）不是提醒：不加 ⚠︎、不算進「帶有提醒」 -->
          <div v-if="r.infoTexts.length" class="kb-file-batch__info">
            <div v-for="(t, i) in r.infoTexts" :key="i">{{ t }}</div>
          </div>
        </div>
        <span class="kb-site-status" :class="`is-${statusClass(r.status)}`">
          <template v-if="r.status === 'processing'">{{ r.stage }}⋯</template>
          <template v-else-if="r.status === 'done'">
            ✓ {{ r.cards }} 條<span v-if="r.notLearned" class="kb-site-status__warn">（{{ r.notLearned }} 條待學）</span>
          </template>
          <template v-else-if="r.status === 'skipped'">已經有了</template>
          <template v-else-if="r.status === 'failed'">{{ r.unsure ? '待確認' : '✕ 沒有加入' }}</template>
          <template v-else-if="r.status === 'rejected'">不收</template>
          <template v-else-if="r.status === 'conflict'">{{ r.deciding ? '加入中⋯' : '等你決定' }}</template>
          <template v-else>{{ finished ? '沒有開始' : '等待中' }}</template>
        </span>
      </div>
    </div>

    <div class="kb-import-actions">
      <el-button :disabled="busy" @click="leave('back')">上一步</el-button>
      <!-- 沒有可以跑的就不留這顆：一顆寫著「重試 0 份」「匯入這 0 份」的灰按鈕只會讓人以為還有事沒做完 -->
      <el-button
        v-if="running || pendingCount"
        type="primary"
        :loading="running"
        :disabled="!pendingCount || busy || (roomFull && !hasUnsure)"
        @click="run"
      >
        {{ runLabel }}
      </el-button>
      <el-button v-if="finished && !busy" type="primary" plain @click="leave('close')">
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
 * 結束給一條結論列。⛔ 單一檔案照舊走有預覽的那條路——這裡只接「收得了的有兩份以上」。
 *
 * 規矩（2026-10-10、10-11 兩輪審查後補齊）：
 *  ① 收不了的檔（舊版 .doc、空檔、超過 10MB、超過一次 10 份）**列在清單上講原因**，不是默默少一份；
 *  ② 知識空間收到滿為止：**按之前**就講還能放幾條、滿了不讓按；放不下的那份收前 N 條、標出幾條沒收；
 *  ③ 跟現有資料同名的不自己決定：整理好先擱著，讓他按「換掉舊的／另外建一份」；
 *     離開這個畫面（上一步、完成、關窗）前還有沒決定的要先問，⛔ 不默默丟掉付過錢的整理結果；
 *  ④ 單份路會講的提醒這裡也要講：原文太長被截斷、字是 AI 認的、原檔沒留成；
 *  ⑤ 關窗時正在跑的那幾份會跑完（worker 只在開始下一份之前檢查中斷），還沒開始的不跑、結論裡要講；
 *  ⑥ 整理好了才失敗的（空間滿、匯入那一下出錯）重試時**直接拿整理好的結果匯**，不再上傳、不再付一次 AI 的錢。
 */
import { ElMessageBox } from 'element-plus'
import { pickFolderForSource } from '~~/shared/knowledge-folder-match'
import { KNOWLEDGE_FILE_KIND_LABEL, knowledgeFileKind } from '~~/shared/knowledge-file-types'
import { PREVIEW_JOB_DEADLINE } from '~/composables/usePreviewJobPoll'
import { batchKindLabel, batchRejectReasons, type FileBatchSnapshot, type FileBatchSummary } from '~/utils/kb-file-batch'
import { formatFileSize } from '~/utils/knowledge-upload'

/** 整理好的結果在伺服器留 1 小時（完成那一刻起算）；重試時超過這個就重新整理，留 10 分鐘餘裕 */
const PREPARED_TTL_MS = 50 * 60 * 1000
/**
 * ⛔ 以前寫「刪掉⋯後，可以再按一次重試」：空間滿了重試鈕是鎖住的，而要刪知識就得關掉這個視窗——
 *    一關，跑過的這一批就清空了（2026-10-12 文字審視）。照做得到的講：騰出空間後把這份再放一次。
 */
const ROOM_FULL_MSG = '知識空間滿了，這份沒收進去（刪掉用不到的知識或升級方案之後，把這份再放一次）'
/** 匯入遇到閘道逾時後，等多久再用同一包重送（見 bulkCreate） */
const BULK_RETRY_WAIT_MS = 3000

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
  /** 這一批跑完（含中途關窗收工）、或對同名那份做完決定：父層用來刷新清單與結算 */
  (e: 'finished', summary: FileBatchSummary): void
}>()

const { apiFetch } = useWorkspace()
const { poll: pollPreviewJob, reset: resetJobPoll } = usePreviewJobPoll()

interface PreviewDone {
  chunks: Array<{ title: string; content: string; tags?: string[]; questions?: string[] }>
  suggestedProductName?: string
  contentHash?: string
  warnings?: string[]
  truncated?: boolean
  ocrUsed?: boolean
  meta?: Record<string, string | number>
  /** quotaChunkCount：換掉它會空出多少空間（不含草稿，跟伺服器算額度同一把尺）；舊的伺服器沒有這一格 */
  existingMatches?: Array<{ id: string; name: string; chunkCount: number; quotaChunkCount?: number; type?: string }>
}
type RowStatus = 'idle' | 'processing' | 'done' | 'skipped' | 'failed' | 'rejected' | 'conflict'
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
  infoTexts: string[]
  error: string
  /** 整理好、還沒匯進去的結果（空間滿、匯入失敗時留著；重試直接用，不再整理一次） */
  prepared: { jobId: string, res: PreviewDone, at: number } | null
  /** 同名、等他決定時擱著的整理結果（不用重新整理、不再花一次錢） */
  pending: { jobId: string, res: PreviewDone, existing: { id: string, name: string, chunkCount: number, quotaChunkCount?: number } } | null
  /** 送出去兩次都逾時的那一包（不知道伺服器做完了沒）：重試時原封不動再送，見 importRow */
  unsure: { body: Record<string, unknown>, quotaShort: number, replaceSourceId: string } | null
  deciding: boolean
}

const statusClass = (s: RowStatus) => (s === 'rejected' ? 'failed' : s === 'conflict' ? 'processing' : s === 'skipped' ? 'done' : s)

const rows = ref<Row[]>([])
// ⚠️ 這幾個要宣告在下面那個 watch **之前**：watch 帶 immediate，setup 當下就會跑一次並寫 finished，
//    排在後面＝「Cannot access before initialization」，整個元件掛掉（匯入視窗吃過兩次同一顆雷；
//    `kb-import-declaration-order.test.ts` 守著）
const running = ref(false)
const finished = ref(false)
/** 按過「整理並匯入」沒有：關窗時父層據此決定「收工清掉」還是「保留清單下次接著按」 */
const started = ref(false)
const doneCount = ref(0)
const batchTotal = ref(0)
let aborted = false
/** 這一批還放得下幾條（跑之前讀一次最新的；兩份同時跑時**送出前先預留**，不會一起超收） */
let room = Number.POSITIVE_INFINITY

watch(() => props.files, (files) => {
  const reasons = batchRejectReasons(files)
  rows.value = files.map((file, i) => {
    const kind = knowledgeFileKind(file.name)
    const error = reasons[i] ?? ''
    return {
      key: `${i}:${file.name}:${file.size}`,
      file: error ? null : file,
      name: file.name,
      // 收不了的那份標副檔名（DOC、PAGES）——右邊狀態欄已經寫「不收」，這裡再寫一次就重複了
      kindLabel: batchKindLabel(file.name, kind ? KNOWLEDGE_FILE_KIND_LABEL[kind] : null),
      sizeLabel: formatFileSize(file.size),
      status: error ? 'rejected' : 'idle',
      stage: '',
      cards: 0,
      notLearned: 0,
      quotaShort: 0,
      warningTexts: [],
      infoTexts: [],
      error,
      prepared: null,
      pending: null,
      unsure: null,
      deciding: false,
    }
  })
  finished.value = false
  started.value = false
}, { immediate: true })

/** 收得了的份數（標題用這個：以前寫「還要跑的份數」，跑的途中會倒數、失敗的又跳回去） */
const acceptedCount = computed(() => rows.value.filter(r => r.file).length)
/** 還可以跑的（第一次＝全部收得下的；跑完後＝沒匯入成功、或還沒開始就停下的） */
const pendingCount = computed(() => rows.value.filter(r => r.file && (r.status === 'idle' || r.status === 'failed')).length)
const okRows = computed(() => rows.value.filter(r => r.status === 'done'))
const okCount = computed(() => okRows.value.filter(r => r.cards > 0).length)
const cardTotal = computed(() => okRows.value.reduce((s, r) => s + r.cards, 0))
const notLearnedTotal = computed(() => okRows.value.reduce((s, r) => s + r.notLearned, 0))
const quotaShortTotal = computed(() => rows.value.reduce((s, r) => s + r.quotaShort, 0))
const failedCount = computed(() => rows.value.filter(r => r.status === 'failed').length)
/** 失敗裡面「不確定進去了沒」的（見 hasUnsure）：結論列分開講，⛔ 不算進「沒有匯入」 */
const unsureCount = computed(() => rows.value.filter(r => r.status === 'failed' && r.unsure).length)
const conflictCount = computed(() => rows.value.filter(r => r.status === 'conflict').length)
const skippedCount = computed(() => rows.value.filter(r => r.status === 'skipped').length)
const warnedCount = computed(() => okRows.value.filter(r => r.warningTexts.length).length)
/** 跑完了卻還是「等待中」的＝中途關窗、還沒開始就停下的 */
const notStartedCount = computed(() => (finished.value ? rows.value.filter(r => r.file && r.status === 'idle').length : 0))
/**
 * 正在對同名那份做決定也算「在跑」（2026-10-11 審查）：以前只看 running，決定匯到一半按「上一步」
 * 或關窗，元件被卸掉，那一份建好了卻沒人刷新清單；重試也會在這時算錯剩下的空間
 */
const busy = computed(() => running.value || rows.value.some(r => r.deciding))
watch(busy, on => emit('running', on), { flush: 'sync' })

const stepTitle = computed(() => {
  // 動詞一律「加入」（2026-10-12 文字審視）：視窗標題叫「加入知識」、單份的按鈕叫「整理並加入」，這裡講「匯入」等於同一件事兩個叫法
  if (!finished.value) return acceptedCount.value ? `一次加入 ${acceptedCount.value} 份檔案` : '這幾份都收不了'
  if (okCount.value) return '加好了'
  return conflictCount.value ? '還有檔案在等你決定' : '這一批沒有加入'
})
const runLabel = computed(() => {
  if (running.value) return `加入中（${doneCount.value}/${batchTotal.value}）⋯`
  if (!finished.value) return `整理並加入這 ${pendingCount.value} 份`
  return notStartedCount.value && !failedCount.value ? `接著加入剩下的 ${pendingCount.value} 份` : `重試沒加入的 ${pendingCount.value} 份`
})

/** 按之前的空間（父層每一批跑完都會重讀；run() 開跑時再讀一次最新的） */
const roomBefore = computed(() => {
  const q = props.quota
  if (!q || q.limit == null) return null
  return Math.max(0, q.limit - q.used)
})
const roomFull = computed(() => roomBefore.value === 0)
/**
 * 有一份「送出去兩次都逾時、不知道進去了沒」：空間看起來滿了也要讓他按重試——
 * 它很可能其實已經收進去了（空間就是被它用掉的），重試是把同一包交給伺服器確認，不會多佔空間
 * （2026-10-12 守門員抓到：滿了就鎖按鈕，那一份永遠標著「沒有匯入」、也沒得重試）
 */
const hasUnsure = computed(() => rows.value.some(r => r.unsure && r.status !== 'done'))
const UNSURE_MSG = '連線逾時，不確定這份加進去了沒有；按「重試」會跟伺服器確認（不會重複建立）'
const quotaLine = computed(() => {
  if (busy.value || roomBefore.value == null || !pendingCount.value) return ''
  if (roomFull.value) return `知識空間滿了（${props.quota!.used}／${props.quota!.limit} 條）：先刪掉用不到的知識或升級方案，再回來加入`
  return `知識空間：還能放 ${roomBefore.value} 條；放不下的那一份會收到滿為止`
})

/** 關窗：通知 worker 收工（正在跑的會跑完，結論照樣 emit 給父層結算） */
function abort() {
  aborted = true
}
function snapshot(): FileBatchSnapshot {
  const processing = rows.value.filter(r => r.status === 'processing' || r.deciding).length
  return {
    started: started.value,
    done: okCount.value,
    processing,
    queued: running.value ? Math.max(0, batchTotal.value - doneCount.value - rows.value.filter(r => r.status === 'processing').length) : 0,
    conflicts: rows.value.filter(r => r.status === 'conflict' && !r.deciding).length,
  }
}
defineExpose({ abort, isRunning: () => busy.value, snapshot })

function emitFinished() {
  emit('finished', {
    sources: okCount.value,
    cards: cardTotal.value,
    quotaShort: quotaShortTotal.value,
    failed: failedCount.value,
    conflicts: conflictCount.value,
    notStarted: rows.value.filter(r => r.file && r.status === 'idle').length,
  })
}

/** 上一步／完成：還有同名、沒決定的先問（⛔ 那幾份的 AI 整理已經付過錢，不可以默默丟掉） */
async function leave(to: 'back' | 'close') {
  if (conflictCount.value) {
    try {
      await ElMessageBox.confirm(
        `跟現有資料同名、等你決定的 ${conflictCount.value} 份不會加入（整理好的結果會丟掉）。`,
        '還有檔案在等你決定',
        { confirmButtonText: '不加入，離開', cancelButtonText: '回去決定', type: 'warning' },
      )
    }
    catch {
      return
    }
  }
  if (to === 'back') emit('back')
  else emit('close')
}

/** 單份路會講的提醒，這裡也要講（審查實測：以前只轉傳 warnings，截斷與 AI 認字兩句都不見了） */
function previewNotices(res: PreviewDone): string[] {
  const out: string[] = []
  if (res.truncated) out.push('原文超過 10 萬字已截斷，可能漏掉後半部')
  if (res.ocrUsed) out.push(Number(res.meta?.image ?? 0) === 1 ? '這張照片上的字由 AI 辨識，請點開核對數字與價格' : '這份是掃描檔，字由 AI 辨識，請點開核對數字與價格')
  return [...out, ...(res.warnings ?? [])]
}

const errorText = (err: any) => String(err?.data?.statusMessage || err?.statusMessage || err?.message || '加入失敗').slice(0, 120)

/**
 * 匯入那一下遇到閘道逾時（502／504／408）或連線中斷，**不等於沒匯進去**：伺服器可能已經做完、只是回應沒送到。
 * 同一個 importId 再送一次，伺服器認得是同一批（`C-46` 冪等鍵），不會多建一份；一份就重送一次，再失敗才算失敗。
 * ⚠️ 重送的必須是**同一個 body 物件**：伺服器拿整包內容比對「是不是同一次」，重算 chunks／資料夾就對不上了。
 *    先等 3 秒：第一次可能還在伺服器上跑，馬上重送會兩次一起寫（資料一樣、但多付一次學習的錢）。
 */
async function bulkCreate<T>(body: Record<string, unknown>): Promise<T> {
  try {
    return await apiFetch<T>('/api/ai/knowledge/bulk-create', { method: 'POST', body })
  }
  catch (err: any) {
    if (!isGatewayTimeout(err)) throw err
    await new Promise(resolve => setTimeout(resolve, BULK_RETRY_WAIT_MS))
    return await apiFetch<T>('/api/ai/knowledge/bulk-create', { method: 'POST', body })
  }
}

/** 閘道逾時／連線斷了：伺服器可能其實做完了，只是回應沒送到 */
function isGatewayTimeout(err: any): boolean {
  const code = Number(err?.statusCode ?? err?.status ?? err?.response?.status ?? 0)
  return code === 502 || code === 504 || code === 408 || code === 0
}

/**
 * 把整理好的結果匯進去（第一次跑、重試、或他對同名那份做了決定之後）。
 * 空間在這裡才扣：放不下的收前 N 條；完全滿了丟錯（呼叫端決定這一列要標成什麼）。
 */
async function importRow(r: Row, jobId: string, res: PreviewDone, replaceSourceId?: string) {
  const file = r.file!
  let reserved = 0
  let body: Record<string, unknown>
  // 上一次送出去兩次都逾時＝不知道伺服器做完了沒：原封不動再送那一包，讓伺服器自己認（做完了就回上一次的結果）。
  // ⛔ 不可以先在這裡算空間：如果其實已經收進去了，算出來會是「滿了」，就會在畫面上說沒收、其實全都在
  //    （2026-10-12 code review）。內容也不能重算——伺服器是拿整包比對「是不是同一次」
  const unsure = r.unsure && r.unsure.replaceSourceId === (replaceSourceId ?? '') ? r.unsure : null
  if (unsure) {
    body = unsure.body
    r.quotaShort = unsure.quotaShort
  }
  else {
    let chunks = res.chunks
    // 「換掉舊的」：舊的那幾條會進回收桶、不再算空間（草稿本來就不算，用伺服器算好的那個數）
    const existing = r.pending?.existing
    const freed = replaceSourceId ? (existing?.quotaChunkCount ?? existing?.chunkCount ?? 0) : 0
    r.quotaShort = 0
    if (room !== Number.POSITIVE_INFINITY) {
      const avail = room + freed
      if (avail <= 0) throw new Error(ROOM_FULL_MSG)
      if (chunks.length > avail) {
        r.quotaShort = chunks.length - avail
        chunks = chunks.slice(0, avail)
      }
      reserved = chunks.length - freed
      room -= reserved
    }
    body = {
      source: {
        type: 'file',
        name: file.name,
        fileName: file.name,
        // 「換掉舊的」只換內容：所屬產品、資料夾都留舊的那份原本的設定（⛔ 帶了伺服器就照收，
        // 舊資料會被默默搬到照檔名猜的資料夾、產品名換成 AI 這次猜的，2026-10-12 code review）
        ...(replaceSourceId
          ? {}
          : {
              productName: res.suggestedProductName ?? '',
              // 沒有逐份預覽＝更不會有人事後去拖資料夾：猜得到就放進去，猜不到就是未分類（跟整站同一把尺）
              folderId: pickFolderForSource(props.folders ?? [], { sourceName: file.name, productName: res.suggestedProductName ?? '' })?.folderId ?? null,
            }),
        contentHash: res.contentHash ?? '',
      },
      ...(replaceSourceId ? { replaceSourceId } : {}),
      importId: jobId, // 冪等鍵：逾時重按不會多生一份
      chunks: chunks.map(c => ({ title: c.title, content: c.content, tags: c.tags ?? [], questions: c.questions ?? [] })),
      overviewCard: null,
    }
  }
  try {
    r.stage = '加入中'
    const bulk = await bulkCreate<{ total: number; indexed: number; failed: number; originalKept?: boolean | null }>(body)
    r.cards = bulk.total ?? bulk.indexed
    r.notLearned = bulk.failed ?? 0
    r.warningTexts = [
      ...previewNotices(res),
      // 單獨再放一次才會問「換掉原本那一份」；一批裡內容一模一樣的會被跳過（同 quotaShort 那句）
      ...(bulk.originalKept === false ? ['原檔這次沒有留下來（知識照常可以用）；要能「下載原檔」，把這一份單獨再放一次、選擇換掉原本那一份'] : []),
    ]
    r.status = 'done'
    r.prepared = null
    r.pending = null
    r.unsure = null
  }
  catch (err) {
    room += reserved // 沒匯進去（或不確定），預留的空間先還回去；下一次開跑會重讀實際的空間
    // 重送也逾時＝不知道做完了沒：記下這一包，下次原封不動再送（見上面）
    r.unsure = isGatewayTimeout(err) ? { body, quotaShort: r.quotaShort, replaceSourceId: replaceSourceId ?? '' } : null
    r.quotaShort = 0
    throw err
  }
}

/** 開跑前讀一次最新的空間：父層那份是上一批跑完時讀的，重試前可能已經刪過知識或升級過 */
async function freshRoom(): Promise<number> {
  let q = props.quota
  try {
    q = (await apiFetch<{ quota: { used: number, limit: number | null } | null }>('/api/ai/knowledge/quota')).quota
  }
  catch { /* 讀不到就用父層那份；伺服器照樣把關，不會超收 */ }
  return q?.limit == null ? Number.POSITIVE_INFINITY : Math.max(0, q.limit - q.used)
}

async function run() {
  const targets = rows.value.filter(r => r.file && (r.status === 'idle' || r.status === 'failed'))
  if (!targets.length || busy.value) return
  running.value = true
  started.value = true
  aborted = false
  finished.value = false
  doneCount.value = 0
  batchTotal.value = targets.length
  resetJobPoll()
  room = await freshRoom()

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
      r.infoTexts = []
      let jobId = ''
      try {
        // 上一輪已經整理好、只是沒匯進去的：直接拿來匯（⛔ 不要再上傳、再付一次 AI 的錢）
        // 上次送出去兩次都逾時的（unsure）不看期限：重試只是把同一包再送給伺服器認，用不到整理工作
        const reuse = r.prepared && (r.unsure || Date.now() - r.prepared.at < PREPARED_TTL_MS) ? r.prepared : null
        let res: PreviewDone
        if (reuse) {
          jobId = reuse.jobId
          res = reuse.res
        }
        else {
          // 空間已經滿了就不上傳、不整理（⛔ 不要付了 AI 的錢才發現放不進去）
          if (room !== Number.POSITIVE_INFINITY && room <= 0) {
            r.status = 'failed'
            r.error = '知識空間滿了，這份沒有整理（刪掉用不到的知識或升級方案之後，把這份再放一次）'
            continue
          }
          r.stage = '上傳中'
          const up = await apiFetch<{ storagePath: string; uploadUrl: string }>(
            '/api/ai/knowledge/upload-url',
            { method: 'POST', body: { fileName: file.name, contentType: file.type } },
          )
          await putFileToSignedUrl(up.uploadUrl, file)
          r.stage = '整理中'
          const created = await apiFetch<{ jobId?: string; duplicate?: { id: string; name: string } }>('/api/ai/knowledge/preview-jobs', {
            method: 'POST',
            // ⛔ 不帶 backgroundAdvance：這一份的匯入只在這個 worker 裡做，人一關窗就沒人收結果
            body: { type: 'file', fileName: file.name, contentType: file.type, storagePath: up.storagePath, generateOverview: false },
          })
          if (created.duplicate) {
            // 跳過不是「匯好了」：不顯示「✓ 0 條」、也不算進「帶有提醒」
            r.status = 'skipped'
            r.infoTexts = [`內容跟既有資料「${created.duplicate.name}」一模一樣，沒有重複建立`]
            continue
          }
          if (!created.jobId) throw new Error('建立整理工作失敗')
          jobId = created.jobId
          res = await pollPreviewJob<PreviewDone>(jobId)
          if (!res.chunks.length) throw new Error('AI 沒有整理出任何知識（內容可能太少）')
          r.prepared = { jobId, res, at: Date.now() }
        }

        const sameName = (res.existingMatches ?? []).find(m => !m.type || m.type === 'file')
        if (sameName) {
          // 同名：整理結果擱著等他決定，不重整理、不再花一次錢
          r.status = 'conflict'
          r.pending = { jobId, res, existing: { id: sameName.id, name: sameName.name, chunkCount: sameName.chunkCount, quotaChunkCount: sameName.quotaChunkCount } }
          continue
        }
        await importRow(r, jobId, res)
      }
      catch (err: any) {
        r.status = 'failed'
        if (err?.code === PREVIEW_JOB_DEADLINE) {
          // 這一份的匯入只在這裡做：逾時不能說「背景還在整理」，而且要主動停掉，不然排程會付錢做完再丟掉
          r.error = '整理太久，這份跳過了（沒有加入，可以按下面的「重試」）'
          r.prepared = null
          if (jobId) void apiFetch(`/api/ai/knowledge/preview-jobs/${jobId}`, { method: 'DELETE' }).catch(() => {})
        }
        else {
          // 不確定進去了沒的，⛔ 不講「沒有匯入」（很可能其實已經在了）
          r.error = r.unsure ? UNSURE_MSG : errorText(err)
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
  emitFinished()
}

/** 同名那份：「換掉舊的」＝走「更新這一份」（舊的進回收桶 30 天）；「另外建一份」＝照常新建 */
async function decide(r: Row, choice: 'replace' | 'new') {
  if (!r.pending || r.deciding || running.value) return
  const { jobId, res, existing } = r.pending
  r.deciding = true
  r.error = ''
  if (room === Number.POSITIVE_INFINITY && props.quota?.limit != null) {
    room = Math.max(0, props.quota.limit - (props.quota.used ?? 0))
  }
  try {
    await importRow(r, jobId, res, choice === 'replace' ? existing.id : undefined)
    if (choice === 'replace' && r.status === 'done') r.infoTexts = [`已換掉舊的「${existing.name}」，舊的 ${existing.chunkCount} 條移到回收桶（30 天內救得回來）`]
  }
  catch (err: any) {
    // 留在「等你決定」：兩顆按鈕還在，空出空間或過一下再按一次就好（⛔ 標成失敗的話，重試會重新上傳、重新整理）
    r.status = 'conflict'
    r.error = r.unsure ? UNSURE_MSG.replace('按「重試」', '再按一次') : errorText(err)
  }
  finally {
    r.deciding = false
    emitFinished()
  }
}
</script>
