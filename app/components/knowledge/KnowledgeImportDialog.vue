<template>
  <el-dialog
    :model-value="modelValue"
    title="上傳 / 匯入"
    width="min(760px, 92vw)"
    :close-on-click-modal="false"
    class="kb-import-dialog"
    @update:model-value="emit('update:modelValue', $event)"
    @close="onDialogClose"
  >
    <!-- ── Step 1:選來源 ─────────────────────────── -->
    <div v-if="step === 'input'">
      <p class="kb-step-label">選擇來源 — 把 PDF、Excel、網址或一大段文字交給 AI 切成知識卡</p>
      <el-tabs v-model="mode" class="kb-import-tabs">
        <el-tab-pane name="file">
          <template #label><span data-tour="kb-tab-file">檔案</span></template>
          <p class="kb-section-hint">
            支援 PDF、Excel（.xlsx / .xls），單檔上限 10MB。
            <br><strong>Excel 表格</strong>：跟 Google Sheet 一樣「<strong>一列變成一張卡</strong>」——<strong>第一欄當卡片標題</strong>（例：商品名稱），其餘欄位當內容；第一列請放欄位名稱（例：商品、價格、庫存）。最適合商品表、問答表。
            <br><strong>PDF 或內容比較零散的檔案</strong>：改由 AI 自動判斷怎麼分段。掃描檔（用拍的、掃的）會由 AI 認字，請逐張核對數字、價格有沒有看錯。
            <br>提醒：檔案是<strong>上傳一次就固定</strong>，之後改了要重新上傳；想要「改了會自動更新」請改用 Google Sheet。
          </p>
          <div class="kb-file-zone">
            <input
              ref="fileInputEl"
              type="file"
              accept=".pdf,.xlsx,.xls,application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              class="kb-file-input"
              @change="onFileChosen"
            >
            <el-button type="primary" plain @click="fileInputEl?.click()">選擇檔案</el-button>
            <span v-if="fileName" class="kb-file-name">{{ fileName }}（{{ fileSizeKb }} KB）</span>
            <span v-else class="text-muted">尚未選擇檔案</span>
          </div>
        </el-tab-pane>

        <el-tab-pane name="url">
          <template #label><span data-tour="kb-tab-url">網址</span></template>
          <p class="kb-section-hint">
            系統會抓取網頁上的文字做成卡片。若那個網頁需要先登入、或要按按鈕才會顯示內容，可能抓不到，請改用上傳檔案。
            <strong>提醒：很多商城「首頁」的商品區塊是動態載入的，抓下來會只剩選單和頁尾</strong>——請改貼商品「列表頁」或單一商品頁的網址。
          </p>
          <el-input
            v-model="urlInput"
            placeholder="https://example.com/faq"
            clearable
          />
        </el-tab-pane>

        <el-tab-pane name="gsheet">
          <template #label><span data-tour="kb-tab-gsheet">Google Sheet</span></template>
          <!-- 官方範本入口:兩欄(問題/答案)就好,其他問法由 AI 匯入時自動補 -->
          <div class="kb-gsheet-template">
            <div class="kb-gsheet-template-text">
              <strong>第一次匯入?建議從官方 FAQ 範本開始:</strong>
              <ol class="kb-gsheet-steps">
                <li>{{ faqTemplateCopyUrl ? '點右側按鈕建立範本副本' : '下載範本檔,上傳到 Google 雲端硬碟並以「Google 試算表」開啟' }}</li>
                <li>在「FAQ」分頁填「客人會問的問題」和「答案」(客人的其他問法之後由 AI 自動補)</li>
                <li>把試算表「共用」給下方服務帳號(檢視權限即可)</li>
                <li>回到這裡貼上試算表連結</li>
              </ol>
            </div>
            <el-button
              tag="a"
              :href="faqTemplateCopyUrl || '/templates/faq-sheet-template.xlsx'"
              target="_blank"
              rel="noopener"
              size="small"
              type="primary"
              plain
            >
              {{ faqTemplateCopyUrl ? '使用 FAQ 範本' : '下載 FAQ 範本' }}
            </el-button>
          </div>
          <p class="kb-section-hint">
            貼上 Google Sheet 連結，<strong>每一列自動變成一張知識卡</strong>：
            <strong>第一欄當卡片標題</strong>，其餘欄位當內容——
            兩欄的表格就是「問題／答案」，多欄的表格會逐欄列成「<strong>欄名：內容</strong>」。第一列請放欄位名稱（例：商品、價格、庫存）。
            之後你在 Sheet 改內容，機器人會<strong>定期自動更新</strong>（自動更新時靠第一欄的標題認出是同一列；你在後台手動改過的卡不會被蓋掉）。
          </p>
          <el-alert
            v-if="serviceAccountEmail"
            type="info"
            :closable="false"
            show-icon
            class="kb-gsheet-share-hint"
          >
            <template #title>
              請先把這份 Sheet「分享」給下列帳號（檢視權限即可），否則讀不到：
            </template>
            <code class="kb-gsheet-email">{{ serviceAccountEmail }}</code>
            <el-button size="small" text type="primary" class="kb-gsheet-copy-btn" @click="copyServiceEmail">
              複製
            </el-button>
          </el-alert>
          <el-input
            v-model="gsheetInput"
            placeholder="https://docs.google.com/spreadsheets/d/.../edit"
            clearable
          />
        </el-tab-pane>

        <el-tab-pane name="text">
          <template #label><span data-tour="kb-tab-text">貼上文字</span></template>
          <p class="kb-section-hint">貼一大段文字（最多 100,000 字），由 AI 幫你切成多張卡。</p>
          <el-input
            v-model="textInput"
            type="textarea"
            :rows="10"
            :maxlength="100000"
            show-word-limit
            placeholder="把你的客服 FAQ 或政策原文貼這裡..."
          />
        </el-tab-pane>
      </el-tabs>

      <div v-if="mode !== 'gsheet'" class="kb-overview-toggle" data-tour="kb-overview">
        <el-checkbox v-model="generateOverview">
          這是商品 / 列表頁（額外產生一張「總覽卡」）
        </el-checkbox>
        <p class="kb-section-hint">
          適用商品「列表頁」、型錄這類「列出很多項目」的頁面（<strong>不建議用首頁</strong>——商品區塊常是動態載入抓不到，總覽卡會做錯）。
          除了把每個項目切成卡片，再額外合成一張帶分類的總覽卡，讓客人問「你們有賣什麼 / 有哪些產品」時能一次回答，不會被反問。
        </p>
      </div>

      <div class="kb-import-actions">
        <el-button
          type="primary"
          data-tour="kb-preview"
          :loading="previewing"
          :disabled="!canPreview"
          @click="runPreview"
        >
          {{ previewing ? (mode === 'gsheet' ? '讀取中⋯' : 'AI 切卡中⋯') : (mode === 'gsheet' ? '讀取 Sheet' : '預覽切卡') }}
        </el-button>
        <span v-if="previewing && mode !== 'gsheet'" class="text-muted text-xs">
          {{ previewProgressText }}
        </span>
      </div>
    </div>

    <!-- ── Step 2:預覽 + 編輯 ─────────────────────────── -->
    <div v-if="step === 'preview'">
      <p class="kb-step-label">預覽切卡結果</p>
      <p class="kb-section-hint">
        AI 偵測到 <strong>{{ chunks.length }}</strong> 張卡片。
        <span v-if="truncated" class="kb-warning"> 原文超過 10 萬字已截斷，可能漏掉後半部。</span>
        <span v-else>勾選要匯入的、可直接編輯內容；確認後一鍵建立。</span>
      </p>

      <div class="kb-source-name-row">
        <span class="kb-source-name-label">來源名稱</span>
        <el-input
          v-model="sourceMeta.name"
          :maxlength="200"
          size="small"
          placeholder="顯示在知識庫來源列表的名稱"
          class="kb-source-name-input"
        />
      </div>

      <!-- 產品名（P1-1）：AI 自動偵測預填、使用者可改。空 = 非單一產品來源（FAQ、公告等）。 -->
      <div v-if="sourceMeta.type !== 'gsheet'" class="kb-source-name-row">
        <span class="kb-source-name-label">所屬產品</span>
        <el-input
          v-model="sourceMeta.productName"
          :maxlength="60"
          size="small"
          placeholder="這份內容都在講同一個產品時才填（含品牌與型號）"
          class="kb-source-name-input"
        />
      </div>
      <p v-if="sourceMeta.type !== 'gsheet'" class="kb-section-hint">
        {{ sourceMeta.productName ? 'AI 判斷這份內容屬於這個產品，卡片會自動標上產品名，客人指名問時才不會答錯台。不對可以直接改。' : '內容涵蓋多個產品或非產品內容（FAQ、公告）時留空即可。' }}
      </p>

      <el-alert
        v-if="ocrUsed"
        type="warning"
        show-icon
        :closable="false"
        class="kb-ocr-alert"
      >
        <template #title>
          這份 PDF 是掃描檔，文字由 AI 辨識
        </template>
        <div class="text-xs">辨識可能有錯漏（尤其數字、價格、電話），請逐張確認內容正確再匯入。</div>
      </el-alert>

      <!-- 表格健檢:示範列沒換、重複問題、空答案、合併儲存格等;提醒不擋匯入 -->
      <el-alert
        v-if="healthWarnings.length"
        type="warning"
        show-icon
        :closable="false"
        class="kb-health-warnings"
      >
        <template #title>
          建議先確認以下 {{ healthWarnings.length }} 點（不影響匯入）
        </template>
        <ul class="kb-health-list">
          <li v-for="(w, i) in healthWarnings" :key="i">{{ w }}</li>
        </ul>
      </el-alert>

      <el-alert
        v-if="dupMatches.length"
        type="warning"
        show-icon
        :closable="false"
        class="kb-dedup-warning"
      >
        <template #title>
          已存在 {{ dupMatches.length }} 個同名來源
        </template>
        <div class="kb-dedup-body">
          <p class="text-xs">繼續建立會在來源列表出現多筆同名項目，可能不是你想要的。在上方「來源名稱」改個名字，這個提醒就會消失。</p>
          <ul class="kb-dedup-list">
            <li v-for="m in dupMatches" :key="m.id">
              「{{ m.name }}」（{{ m.chunkCount }} 張卡，{{ relativeTime(m.updatedAtMs) || '未更新' }}）
            </li>
          </ul>
        </div>
      </el-alert>

      <!-- 總覽卡（列表頁專屬）：列在最上面、可編輯、可取消 -->
      <div v-if="overviewCard" class="kb-overview-card">
        <div class="kb-chunk-checkbox">
          <el-checkbox v-model="overviewCard.included" />
        </div>
        <div class="kb-chunk-content">
          <div class="kb-overview-badge">總覽卡（接「你們有賣什麼」這類問題）</div>
          <el-input v-model="overviewCard.title" placeholder="標題" size="small" class="kb-chunk-title" />
          <el-input
            v-model="overviewCard.content"
            type="textarea"
            :rows="4"
            placeholder="內容"
            class="kb-chunk-textarea"
          />
          <div class="kb-chunk-tags">
            <el-tag
              v-for="tag in overviewCard.tags"
              :key="tag"
              size="small"
              closable
              @close="removeTag(overviewCard, tag)"
            >
              {{ tag }}
            </el-tag>
          </div>
        </div>
      </div>

      <div class="kb-bulk-actions">
        <el-button size="small" plain @click="selectAll">全選</el-button>
        <el-button size="small" plain @click="selectNone">全不選</el-button>
        <span class="text-muted text-xs">已選 {{ includedCount }} / {{ chunks.length }}</span>
      </div>

      <div class="kb-chunk-list">
        <div
          v-for="(chunk, idx) in chunks"
          :key="idx"
          class="kb-chunk-row"
          :class="{ 'kb-chunk-row--excluded': !chunk.included }"
        >
          <div class="kb-chunk-checkbox">
            <el-checkbox v-model="chunk.included" />
          </div>
          <div class="kb-chunk-content">
            <el-input
              v-model="chunk.title"
              placeholder="標題"
              size="small"
              class="kb-chunk-title"
            />
            <el-input
              v-model="chunk.content"
              type="textarea"
              :rows="3"
              placeholder="內容"
              class="kb-chunk-textarea"
            />
            <!-- 客人問法:AI 自動補的檢索關鍵(參與比對),匯入前可逐題檢查/修改 -->
            <div class="kb-chunk-questions">
              <span class="kb-questions-label">客人問法</span>
              <el-tag
                v-for="(q, qi) in chunk.questions"
                :key="`${qi}-${q}`"
                size="small"
                type="info"
                closable
                @close="chunk.questions.splice(qi, 1)"
              >
                {{ q }}
              </el-tag>
              <el-input
                v-if="editingQuestionIdx === idx"
                ref="questionInputRef"
                v-model="questionInput"
                size="small"
                class="kb-question-input"
                placeholder="客人會怎麼問?"
                @keydown.enter.prevent="commitQuestion(chunk)"
                @blur="commitQuestion(chunk)"
              />
              <el-button
                v-else-if="chunk.questions.length < 3"
                size="small"
                plain
                @click="startAddQuestion(idx)"
              >
                ＋
              </el-button>
            </div>
            <div class="kb-chunk-tags">
              <el-tag
                v-for="tag in chunk.tags"
                :key="tag"
                size="small"
                closable
                @close="removeTag(chunk, tag)"
              >
                {{ tag }}
              </el-tag>
              <el-input
                v-if="editingTagIdx === idx"
                ref="tagInputRef"
                v-model="tagInput"
                size="small"
                class="kb-tag-input"
                @keydown.enter.prevent="commitTag(chunk)"
                @blur="commitTag(chunk)"
              />
              <el-button v-else size="small" plain @click="startAddTag(idx)">＋</el-button>
            </div>
          </div>
        </div>
      </div>

      <div class="kb-import-actions">
        <el-button @click="step = 'input'">← 重新切片</el-button>
        <el-button
          type="primary"
          :loading="importing"
          :disabled="includedCount === 0"
          @click="runImport"
        >
          {{ importing ? '匯入並索引中⋯' : `確認匯入 ${includedCount} 張` }}
        </el-button>
      </div>
    </div>

    <!-- ── Step 3:結果(只有部分失敗才會看到;全成功直接關窗) ── -->
    <div v-if="step === 'result' && result">
      <p class="kb-step-label">匯入結果</p>
      <div class="kb-result-summary">
        <div class="kb-result-stat">
          <span class="kb-result-label">總計</span>
          <strong>{{ result.total }}</strong>
        </div>
        <div class="kb-result-stat kb-result-stat--success">
          <span class="kb-result-label">已索引</span>
          <strong>{{ result.indexed }}</strong>
        </div>
        <div class="kb-result-stat" :class="result.failed ? 'kb-result-stat--danger' : ''">
          <span class="kb-result-label">失敗</span>
          <strong>{{ result.failed }}</strong>
        </div>
      </div>

      <div v-if="result.failed > 0" class="kb-result-failed-list">
        <p class="kb-section-hint">以下卡片建立但索引失敗，可在知識庫點開該卡按「重新索引」：</p>
        <ul class="kb-failed-list">
          <li v-for="item in failedItems" :key="item.id">
            <strong>{{ item.title }}</strong>
            <span class="text-muted text-xs">— {{ item.failureReason ?? '未知原因' }}</span>
          </li>
        </ul>
      </div>

      <div class="kb-import-actions">
        <el-button @click="resetAll">繼續匯入</el-button>
        <el-button type="primary" @click="close">完成</el-button>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
const props = defineProps<{
  modelValue: boolean
  /**
   * 父層的完整來源清單:同名警告要比對「全部」既有名稱——
   * 只比對 preview 回傳的(原始名稱的)同名清單,會漏掉「改名撞進另一個既有來源」的情況。
   */
  existingSources?: Array<{ id: string; name: string; chunkCount: number; updatedAtMs: number }>
}>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** 有實際建立資料時觸發(全成功或部分成功),父層應刷新來源列表 */
  'imported': [sourceId: string | null]
}>()


const { apiFetch } = useWorkspace()
const { showToast } = useAdminToast()

type ImportMode = 'file' | 'url' | 'text' | 'gsheet'
type Step = 'input' | 'preview' | 'result'

const step = ref<Step>('input')
const mode = ref<ImportMode>('file')

// ── File ──────────────────────────────────────────────────
const fileInputEl = ref<HTMLInputElement | null>(null)
const fileName = ref('')
const fileSizeKb = ref(0)
// 留住 File 物件本身：預覽時才用 signed URL 直傳 Storage（不再前置轉 base64 塞 JSON，
// 否則 ~5MB 檔 base64 膨脹到 ~6.7MB 會超過 Lambda 6MB payload 上限 → 413）。
const selectedFile = ref<File | null>(null)
const fileContentType = ref('')

function onFileChosen(e: Event) {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  if (file.size > 10 * 1024 * 1024) {
    showToast('檔案超過 10MB 上限', 'error')
    target.value = ''
    return
  }
  selectedFile.value = file
  fileName.value = file.name
  fileSizeKb.value = Math.round(file.size / 1024)
  fileContentType.value = file.type
}

// ── URL / text ────────────────────────────────────────────
const urlInput = ref('')
const textInput = ref('')

// ── Google Sheet ──────────────────────────────────────────
const gsheetInput = ref('')
const serviceAccountEmail = ref('')

async function copyServiceEmail() {
  try {
    await navigator.clipboard.writeText(serviceAccountEmail.value)
    showToast('已複製服務帳號 email', 'success')
  }
  catch {
    showToast('複製失敗，請手動選取複製', 'error')
  }
}

// 官方 FAQ 範本:有設定母本網址就轉成 /copy 連結(一鍵建立副本);沒設定或網址無法轉則退回下載 xlsx
const faqTemplateCopyUrl = computed(() => {
  const u = String(useRuntimeConfig().public.faqTemplateSheetUrl || '').trim()
  if (!u) return ''
  if (/\/copy([?#]|$)/.test(u)) return u
  // 「發布到網路」的網址是 /spreadsheets/d/e/{發布ID}/...，那個 e 不是檔案 ID、也不支援 /copy；
  // 硬湊會變成 /d/e/copy（404）。這種情況不硬轉,回空字串 → 退回下載 xlsx。
  if (/\/spreadsheets\/d\/e\//.test(u)) return ''
  const m = u.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)
  return m ? `https://docs.google.com/spreadsheets/d/${m[1]}/copy` : ''
})
// 載入要分享給哪個服務帳號 email（提示用；失敗不擋）
onMounted(async () => {
  try {
    const res = await apiFetch<{ serviceAccountEmail: string }>('/api/ai/knowledge/gsheet-account')
    serviceAccountEmail.value = res.serviceAccountEmail
  }
  catch { /* 提示性質，讀不到就不顯示 */ }
})

// ── Overview（列表頁總覽卡）──────────────────────────────
const generateOverview = ref(false)
type OverviewCard = { included: boolean; title: string; content: string; tags: string[]; questions: string[] }
const overviewCard = ref<OverviewCard | null>(null)

// ── Preview ───────────────────────────────────────────────
const previewing = ref(false)
// 非同步 job 的即時進度（切卡 3/5、辨識掃描檔 2/6…）；null = 尚無進度資訊
const previewProgress = ref<{ done: number; total: number; label: string } | null>(null)
const previewProgressText = computed(() => {
  const p = previewProgress.value
  if (!p) return 'Gemini 正在分析內容⋯'
  return p.total > 1 ? `${p.label} ${p.done}/${p.total}⋯` : `${p.label}⋯`
})
const truncated = ref(false)
const ocrUsed = ref(false) // 掃描檔 PDF 由 AI 辨識文字 → 預覽時提醒逐張確認
const healthWarnings = ref<string[]>([]) // 表格來源的匯入前健檢警告（提醒不擋匯入）
const chunks = ref<Array<{ included: boolean; title: string; content: string; tags: string[]; questions: string[] }>>([])
const existingMatches = ref<Array<{ id: string; name: string; chunkCount: number; updatedAtMs: number }>>([])
const sourceMeta = ref({
  type: '' as ImportMode | '',
  name: '',
  url: '',
  /** 所屬產品名：AI 偵測預填、使用者可改；'' = 非單一產品來源 */
  productName: '',
})

const canPreview = computed(() => {
  if (mode.value === 'file') return Boolean(selectedFile.value)
  if (mode.value === 'url') return /^https?:\/\//i.test(urlInput.value.trim())
  if (mode.value === 'gsheet') return /docs\.google\.com\/spreadsheets|^[a-zA-Z0-9-_]{20,}$/.test(gsheetInput.value.trim())
  return textInput.value.trim().length > 0
})

const includedCount = computed(() => chunks.value.filter(c => c.included).length)

// 同名警告要「活的」:使用者在預覽步驟改名,警告即時跟著變。
// 比對對象 = 父層完整來源清單 ∪ preview 回傳的同名清單(父層沒傳 prop 時的 fallback),
// 否則改名撞進「另一個」既有來源不會有任何警告——正是這個警示要防的事。
const dupMatches = computed(() => {
  const name = sourceMeta.value.name.trim()
  if (!name) return []
  const pool = new Map<string, { id: string; name: string; chunkCount: number; updatedAtMs: number }>()
  for (const s of props.existingSources ?? []) pool.set(s.id, s)
  for (const m of existingMatches.value) if (!pool.has(m.id)) pool.set(m.id, m)
  return [...pool.values()].filter(m => m.name.trim() === name)
})

/** 預覽 job 完成時的回應形狀（與舊 preview-chunks 相同） */
interface PreviewResult {
  chunks: Array<{ title: string; content: string; tags: string[]; questions?: string[] }>
  overviewCard?: { title: string; content: string; tags: string[]; questions: string[] } | null
  sourceName: string
  sourceUrl: string
  truncated: boolean
  ocrUsed?: boolean
  existingMatches?: Array<{ id: string; name: string; chunkCount: number; updatedAtMs: number }>
  /** 表格來源的匯入前健檢警告（示範列沒換、重複問題等） */
  warnings?: string[]
  /** AI 自動偵測的產品名（多產品 / 平台頁為空）；預填給使用者確認可改 */
  suggestedProductName?: string
}

type PollResponse =
  | ({ status: 'done' } & PreviewResult)
  | { status: 'processing'; phase: string; progress: { done: number; total: number; label: string } }
  | { status: 'error'; error: string }

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 輪詢預覽 job 直到 done / error。伺服器端每次輪詢推進一步(壓在閘道逾時內),
 * 所以這裡永遠拿短回應——閘道偶發 504/502/408 是「某一步剛好較久」,吞掉繼續輪詢
 * (伺服器端 lease 會由下一輪重接),不可一次抖動就整個失敗。上限 5 分鐘。
 */
async function pollPreviewJob(jobId: string): Promise<PreviewResult> {
  // 大型密文件最壞情況:OCR 逐批 + 逐段切卡跨多輪輪詢,每輪 ~20s,總量可到數分鐘。
  // 上限放寬到 8 分鐘;伺服器端 job 存活 1 小時,真超時使用者可重新上傳。
  const deadline = Date.now() + 8 * 60 * 1000
  while (Date.now() < deadline) {
    await sleep(1200)
    let res: PollResponse
    try {
      res = await apiFetch<PollResponse>(`/api/ai/knowledge/preview-jobs/${encodeURIComponent(jobId)}`)
    }
    catch (e: any) {
      const code = Number(e?.statusCode ?? e?.status ?? e?.response?.status ?? 0)
      if (code === 504 || code === 502 || code === 408 || code === 0) continue
      throw e
    }
    if (res.status === 'done') return res
    if (res.status === 'error') throw new Error(res.error || '處理失敗')
    previewProgress.value = res.progress
  }
  throw new Error('處理逾時，請稍後再試或改貼文字')
}

async function runPreview() {
  previewing.value = true
  previewProgress.value = null
  try {
    const body: Record<string, unknown> = { type: mode.value, generateOverview: generateOverview.value }
    if (mode.value === 'file') {
      const file = selectedFile.value
      if (!file) return
      // 原檔直傳 Storage（signed PUT URL）：繞過 Lambda 6MB payload 上限、免 base64 33% 膨脹。
      // 檔案 bytes 不經過我們的 API/Lambda，只把 storagePath 送去建 job。
      previewProgress.value = { done: 0, total: 1, label: '上傳檔案' }
      const up = await apiFetch<{ storagePath: string; uploadUrl: string }>(
        '/api/ai/knowledge/upload-url',
        { method: 'POST', body: { fileName: file.name, contentType: file.type } },
      )
      // 直打 GCS signed URL（絕對網址）→ 用 $fetch，不要用會加 workspace/auth 標頭的 apiFetch。
      await $fetch(up.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
      })
      previewProgress.value = null
      body.fileName = file.name
      body.contentType = file.type
      body.storagePath = up.storagePath
    }
    else if (mode.value === 'url') {
      body.url = urlInput.value.trim()
    }
    else if (mode.value === 'gsheet') {
      body.url = gsheetInput.value.trim()
    }
    else {
      body.text = textInput.value.trim()
      // 帶日期避免每次都叫「手打輸入」→ 第二次必撞同名警告(且名稱可在預覽步驟再改)
      const now = new Date()
      body.name = `貼上文字 ${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`
    }

    // 建 job(秒回)→ 輪詢推進(永不 504)。回應形狀與舊 preview-chunks 相同。
    const created = await apiFetch<{ jobId: string }>(
      '/api/ai/knowledge/preview-jobs',
      { method: 'POST', body },
    )
    const res = await pollPreviewJob(created.jobId)

    if (!res.chunks.length) {
      showToast('AI 沒有切出任何有意義的卡片；請改貼文字或檢查來源內容', 'error')
      return
    }

    truncated.value = res.truncated
    ocrUsed.value = res.ocrUsed === true
    healthWarnings.value = res.warnings ?? []
    chunks.value = res.chunks.map(c => ({
      included: true,
      title: c.title,
      content: c.content,
      tags: [...(c.tags ?? [])],
      questions: [...(c.questions ?? [])],
    }))
    overviewCard.value = res.overviewCard
      ? {
          included: true,
          title: res.overviewCard.title,
          content: res.overviewCard.content,
          tags: [...(res.overviewCard.tags ?? [])],
          questions: [...(res.overviewCard.questions ?? [])],
        }
      : null
    existingMatches.value = res.existingMatches ?? []
    sourceMeta.value = {
      type: mode.value,
      name: res.sourceName,
      url: res.sourceUrl,
      productName: res.suggestedProductName ?? '',
    }
    step.value = 'preview'
  }
  catch (err: any) {
    showToast(err?.data?.statusMessage || err?.statusMessage || err?.message || '切片失敗', 'error')
  }
  finally {
    previewing.value = false
    previewProgress.value = null
  }
}

// ── Tag editor (per chunk) ────────────────────────────────
const editingTagIdx = ref<number | null>(null)
const tagInput = ref('')
const tagInputRef = ref<Array<{ focus: () => void }> | { focus: () => void } | null>(null)

function startAddTag(idx: number) {
  editingTagIdx.value = idx
  tagInput.value = ''
  nextTick(() => {
    const el = Array.isArray(tagInputRef.value) ? tagInputRef.value[0] : tagInputRef.value
    el?.focus?.()
  })
}

function commitTag(chunk: { tags: string[] }) {
  const t = tagInput.value.trim()
  if (t && !chunk.tags.includes(t)) chunk.tags.push(t)
  tagInput.value = ''
  editingTagIdx.value = null
}

function removeTag(chunk: { tags: string[] }, tag: string) {
  chunk.tags = chunk.tags.filter(x => x !== tag)
}

// ── Question editor (per chunk) ───────────────────────────
// 「客人問法」跟標題/內容一起進向量,是檢索命中的關鍵;AI 補的在這裡逐題把關。
// 上限 3 句與後端 bulk-create 的截斷一致。
const editingQuestionIdx = ref<number | null>(null)
const questionInput = ref('')
const questionInputRef = ref<Array<{ focus: () => void }> | { focus: () => void } | null>(null)

function startAddQuestion(idx: number) {
  editingQuestionIdx.value = idx
  questionInput.value = ''
  nextTick(() => {
    const el = Array.isArray(questionInputRef.value) ? questionInputRef.value[0] : questionInputRef.value
    el?.focus?.()
  })
}

function commitQuestion(chunk: { questions: string[] }) {
  const q = questionInput.value.trim()
  if (q && !chunk.questions.includes(q) && chunk.questions.length < 3) chunk.questions.push(q)
  questionInput.value = ''
  editingQuestionIdx.value = null
}

// ── Bulk selection ────────────────────────────────────────
function selectAll() {
  for (const c of chunks.value) c.included = true
}
function selectNone() {
  for (const c of chunks.value) c.included = false
}

// ── Import ────────────────────────────────────────────────
const importing = ref(false)
const result = ref<{
  sourceId: string | null
  total: number
  indexed: number
  failed: number
  items: Array<{ id: string; title: string; status: string; failureReason?: string }>
} | null>(null)

const failedItems = computed(() =>
  (result.value?.items ?? []).filter(i => i.status === 'failed'),
)

async function runImport() {
  const selected = chunks.value
    .filter(c => c.included && c.title.trim() && c.content.trim())
    .map(c => ({ title: c.title.trim(), content: c.content.trim(), tags: c.tags, questions: c.questions ?? [] }))

  if (!selected.length) return showToast('請至少選擇一張卡', 'error')
  if (selected.length > 150) return showToast('單次最多匯入 150 張，請先取消勾選一些', 'error')

  importing.value = true
  try {
    const ov = overviewCard.value
    const overviewPayload = ov && ov.included && ov.title.trim() && ov.content.trim()
      ? { title: ov.title.trim(), content: ov.content.trim(), tags: ov.tags, questions: ov.questions ?? [] }
      : null

    const res = await apiFetch<typeof result.value>('/api/ai/knowledge/bulk-create', {
      method: 'POST',
      body: {
        source: {
          type: sourceMeta.value.type,
          name: sourceMeta.value.name.trim() || '未命名來源',
          url: sourceMeta.value.url,
          productName: sourceMeta.value.productName.trim(),
        },
        chunks: selected,
        overviewCard: overviewPayload,
      },
    })
    result.value = res
    // 全部成功直接關窗(關窗 handler 會通知父層刷新並選中新來源);
    // 有失敗才停在結果頁,讓使用者看到哪幾張失敗、原因是什麼
    if (res && res.failed === 0) {
      showToast(`成功匯入 ${res.indexed} 張`, 'success')
      close()
    }
    else if (res) {
      step.value = 'result'
      showToast(`匯入完成：${res.indexed} 成功 / ${res.failed} 失敗`, 'error')
    }
  }
  catch (err: any) {
    showToast(err?.statusMessage || err?.message || '匯入失敗', 'error')
  }
  finally {
    importing.value = false
  }
}

function resetAll() {
  step.value = 'input'
  mode.value = 'file'
  fileName.value = ''
  fileSizeKb.value = 0
  selectedFile.value = null
  fileContentType.value = ''
  urlInput.value = ''
  textInput.value = ''
  gsheetInput.value = ''
  chunks.value = []
  overviewCard.value = null
  generateOverview.value = false
  existingMatches.value = []
  truncated.value = false
  ocrUsed.value = false
  healthWarnings.value = []
  result.value = null
  sourceMeta.value = { type: '', name: '', url: '', productName: '' }
  if (fileInputEl.value) fileInputEl.value.value = ''
}

function close() {
  emit('update:modelValue', false)
}

/**
 * 統一在「關窗」時結算:只要有實際建立過資料(result 存在,全成功或部分成功),
 * 就通知父層刷新來源列表並重置狀態;中途關窗(還沒匯入)則保留輸入,下次打開接續。
 */
function onDialogClose() {
  if (result.value) {
    emit('imported', result.value.sourceId)
    resetAll()
  }
}

function relativeTime(ms: number): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  if (diff < 60_000) return '剛剛'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分鐘前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小時前`
  return new Date(ms).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' })
}
</script>
