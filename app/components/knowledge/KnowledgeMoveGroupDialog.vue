<template>
  <el-dialog
    v-model="visible"
    title="移到哪一組"
    width="min(440px, 92vw)"
    :close-on-click-modal="!movingToFolder"
    :before-close="closeUnlessMoving"
    destroy-on-close
  >
    <el-select v-model="moveTarget" filterable class="src-move-select" placeholder="選一組">
      <el-option-group v-if="generalFolders.length" label="通用（不是講單一商品）">
        <el-option v-for="f in generalFolders" :key="f.id" :label="f.name" :value="f.id" />
      </el-option-group>
      <el-option-group v-if="productFolders.length" label="商品">
        <el-option v-for="f in productFolders" :key="f.id" :label="f.name" :value="f.id" />
      </el-option-group>
      <el-option label="不放分組" :value="MOVE_NONE" />
    </el-select>
    <p class="text-muted text-xs src-move-hint">{{ moveHint }}</p>
    <template #footer>
      <el-button :disabled="movingToFolder" @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="movingToFolder" :disabled="!moveTargetChanged" @click="confirmMove">
        移過去
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
/**
 * 移到哪一組（`D-127` 分組就是商品；取代 `C-320` 的「⋯ → AI 認的商品名」）。
 * 知識庫頁右上「⋯」或「要處理的事」的「放進分組」打開；`C-406` 從知識庫頁搬出來。
 * 搬的那一下跟拖進分組同一支，留在頁面（move）。
 */
import { productNameForGroup } from '~~/shared/knowledge-product-group'
import type { KbFolderRow } from '~/utils/kb-product-groups'

/** 「不放分組」那個選項的值（el-select 收不了 null） */
const MOVE_NONE = '__none__'

const props = defineProps<{
  open: boolean
  /**
   * 正開著的那一份（頁面的 SourceSummary 照傳）。⚠️ 四格都必填：頁面那邊改名或拿掉哪一格，typecheck 會在傳進來的地方紅，
   * 不會默默變成 undefined、說明那一行用錯規則（`C-407`）
   */
  source: { id: string, type: string, folderId: string | null, generateOverview: boolean } | null
  folders: KbFolderRow[]
  /** 頁面的 moveSourceToFolder（拖進分組也走它）。回 true＝搬成了 */
  move: (sourceId: string, folderId: string | null, opts: { announce?: boolean }) => Promise<boolean>
}>()

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
}>()

const visible = computed({
  get: () => props.open,
  set: (v: boolean) => emit('update:open', v),
})

const moveTarget = ref('')
const moveFrom = ref('')
const movingToFolder = ref(false)
const generalFolders = computed(() => props.folders.filter(f => f.general))
const productFolders = computed(() => props.folders.filter(f => !f.general))
const moveTargetChanged = computed(() => !!moveTarget.value && moveTarget.value !== moveFrom.value)
/**
 * 選了之後 AI 會怎麼看這一份——換組真正的後果，選之前就講。
 * 判斷直接用 shared productNameForGroup、旗標跟伺服器 syncGroupSourcesProduct／alignSourceProductWithGroup 同一套（`C-407`：以前這裡另抄一份規則）
 */
const moveHint = computed(() => {
  const s = props.source
  if (!s || !moveTarget.value) return ''
  const f = props.folders.find(x => x.id === moveTarget.value)
  if (!f || f.general) return 'AI 不會把這份當成任何一台的資料。'
  if (!productNameForGroup(f, { isCatalog: s.generateOverview === true, isSheet: s.type === 'gsheet' })) return '試算表、型錄一份常講好幾台，放在哪一組都不會整份當成那一台。'
  return `AI 會把這份當成「${f.name}」的資料。`
})

/** 搬到一半不給關（ESC、右上角叉叉；「取消」本來就鎖著）（`C-407`，同編輯分組）：以前關得掉，搬完會把下一次打開的視窗關掉 */
function closeUnlessMoving(done: () => void) {
  if (!movingToFolder.value) done()
}

/** 每次打開都從這一份現在放的那一組開始 */
watch(() => props.open, (open) => {
  if (!open) return
  moveFrom.value = props.source?.folderId ?? MOVE_NONE
  moveTarget.value = moveFrom.value
})

async function confirmMove() {
  const s = props.source
  if (!s || !moveTargetChanged.value) return
  movingToFolder.value = true
  try {
    if (await props.move(s.id, moveTarget.value === MOVE_NONE ? null : moveTarget.value, { announce: true })) {
      visible.value = false
    }
  }
  finally {
    movingToFolder.value = false
  }
}
</script>
