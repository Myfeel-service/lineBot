<template>
  <el-dialog
    v-model="visible"
    title="這幾個商品名是同一台嗎？"
    width="min(680px, 94vw)"
  >
    <p class="text-muted text-sm src-health-list-hint">
      同一台有兩種寫法，AI 會當成兩台，反問客人二選一。
      <strong>是不是同一台由你判斷</strong>——同系列的不同型號（例如 ULTRA 版、12L 與 16L）看起來也很像，不能合併。
    </p>

    <div v-if="aliasLoading" class="src-chunk-loading"><div class="spinner" /></div>
    <!-- 讀不到：⛔ 不擺上一次讀到的那份（`C-407`：以前照樣列著、按鈕也能按）；講法同編輯分組讀不到時 -->
    <p v-else-if="loadFailed" class="text-muted text-sm">讀不到，關掉再打開一次試試。</p>
    <template v-else>
      <p v-if="!aliasCandidates.length" class="text-muted text-sm">
        目前沒有需要確認的組合。
      </p>
      <div v-for="c in aliasCandidates" :key="c.key" class="src-alias-card">
        <div class="src-alias-pair">
          「{{ c.a }}」<span class="src-alias-eq">＝</span>「{{ c.b }}」？
          <!-- 型號風險優先於「證據明確」:兩者同時成立時只顯示綠標,等於在誘導使用者合併兩台不同機器 -->
          <span v-if="c.variantRisk" class="src-alias-tag is-risk">可能是不同型號</span>
          <span v-else-if="c.confidence === 'high'" class="src-alias-tag is-high">證據明確</span>
        </div>
        <p class="src-alias-reason">{{ c.reason }}</p>
        <!-- `G-102`：合併／不是／解除／手動合併都打 `product-aliases` POST（sources.write），觀察者只看候選 -->
        <div v-if="canEdit" class="src-alias-actions">
          <el-button type="primary" size="small" :loading="aliasSaving === c.key" @click="decideAlias(c, 'confirm')">
            是同一台，合併
          </el-button>
          <el-button size="small" :loading="aliasSaving === c.key" @click="decideAlias(c, 'dismiss')">
            不是，兩台不同
          </el-button>
          <!-- `D-127`：兩個都是商品分組＝合成一組（資料搬過去、另一組刪掉），講清楚留哪一組 -->
          <span class="text-muted text-xs">{{ productGroupNamed(folders, c.a) && productGroupNamed(folders, c.b) ? `合成一組，留「${c.a}」這一組` : `合併後會以「${c.a}」為正式名稱` }}</span>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
/**
 * 可能是同一台（別名候選）：系統列候選、由人確認（`C-323`；`C-406` 從知識庫頁搬出來）。
 * 同一台機器兩種叫法會被 AI 當成兩台(反問二選一、出貨時間並列)。系統偵測候選、由人確認——
 * 不自動合併:「W1 REGEN」與「W1 REGEN ULTRA」字面上也像別名,但那是兩台不同機器。
 * 候選視窗只剩「是不是同一台」那幾組；自己加叫法、拿掉別名在編輯分組（KnowledgeGroupEditDialog）。
 */
import { apiErrorText } from '~/utils/api-error-text'
import {
  groupNameFirst,
  type KbFolderRow,
  type ProductAliasCandidate,
  productGroupNamed,
  sameAliasPair,
} from '~/utils/kb-product-groups'

const props = withDefaults(defineProps<{
  open: boolean
  folders: KbFolderRow[]
  /** 改得了資料（sources.write）才給合併／不是：頁面判斷好傳進來（`C-407`，同 KnowledgeSiteDrafts） */
  canEdit: boolean
  /** 「疑似重複」帶過來的那一組（系統沒列成候選也要讓他判斷），打開時排第一個 */
  pinned?: ProductAliasCandidate | null
  /** 頁面的 mergeProductGroups：兩組其實是同一台 → 合成一組（要動分組清單、重讀、重新學，留在頁面） */
  mergeGroups: (keep: KbFolderRow, from: KbFolderRow) => Promise<void>
}>(), {
  pinned: null,
})

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  /** 合併／不是之後：「要處理的事」那一列的數字可能跟著變（頁面重跑健康檢查） */
  (e: 'changed'): void
}>()

const { apiFetch } = useWorkspace()
const { showToast } = useAdminToast()

const visible = computed({
  get: () => props.open,
  set: (v: boolean) => emit('update:open', v),
})

const { aliasLoading, aliasCandidates, loadAliases } = useProductAliases(() => props.folders)
const aliasSaving = ref('')
/** 這一次讀不到（⛔ 不能擺上一次的清單：可能是別次打開帶進來的那一組，按鈕照樣按得下去） */
const loadFailed = ref(false)
/**
 * 「疑似重複」帶進來、他還沒判斷的那一組（`C-407`）：每次重讀都放回第一個。
 * 以前只在打開時放一次，先處理別組（重讀清單）它就不見了——系統沒列成候選，伺服器回的清單裡本來就沒有它
 */
const pinnedLeft = ref<ProductAliasCandidate | null>(null)

/** 判斷過的就是帶進來的那一組：之後重讀不再放回去 */
function decided(c: ProductAliasCandidate) {
  if (pinnedLeft.value && sameAliasPair(c, pinnedLeft.value)) pinnedLeft.value = null
}

/** 重讀候選，還沒判斷的帶進來那一組排第一個 */
async function reloadCandidates() {
  const ok = await loadAliases()
  loadFailed.value = !ok
  const extra = pinnedLeft.value
  if (ok && extra) aliasCandidates.value = [groupNameFirst(props.folders, extra), ...aliasCandidates.value.filter(c => !sameAliasPair(c, extra))]
}

watch(() => props.open, async (open) => {
  if (!open) return
  // 先清掉上一次的：讀的這一兩秒、或讀不到時，都不該看到別次打開時的清單
  aliasCandidates.value = []
  loadFailed.value = false
  pinnedLeft.value = props.pinned
  await reloadCandidates()
})

async function decideAlias(c: ProductAliasCandidate, action: 'confirm' | 'dismiss') {
  aliasSaving.value = c.key
  try {
    // 兩個名字都是商品分組（`D-127`）：是同一台＝合成一組，不只是記一條別名（不然左邊照樣是兩組、資料分兩處）
    const keepGroup = action === 'confirm' ? productGroupNamed(props.folders, c.a) : null
    const fromGroup = action === 'confirm' ? productGroupNamed(props.folders, c.b) : null
    if (keepGroup && fromGroup && keepGroup.id !== fromGroup.id) {
      await props.mergeGroups(keepGroup, fromGroup)
      decided(c)
      await reloadCandidates()
      emit('changed')
      return
    }
    const res = await apiFetch<{ changed?: boolean }>('/api/ai/knowledge/product-aliases', {
      method: 'POST',
      body: action === 'confirm'
        ? { action: 'confirm', canonical: c.a, alias: c.b }
        : { action: 'dismiss', a: c.a, b: c.b },
    })
    showToast(
      action !== 'confirm'
        ? '好的，不再詢問這一組'
        // 沒異動時要講清楚,否則清單少一列但沒發生任何事,看起來像剛才那次沒生效
        : res?.changed === false
          ? '這兩個名字本來就已經對應到同一台了'
          // 以前這個視窗下面就有「已確認的對照」可以解除；搬走之後要講一次去哪裡拿掉
          : '已合併，AI 之後會把它們當同一台（要拿掉：那一組的「編輯分組」）',
      'success',
    )
    decided(c)
    await reloadCandidates()
    emit('changed')
  }
  catch (err: any) {
    showToast(apiErrorText(err, '儲存失敗'), 'error')
  }
  finally {
    aliasSaving.value = ''
  }
}
</script>
