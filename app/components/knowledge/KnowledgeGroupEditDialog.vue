<template>
  <el-dialog
    v-model="visible"
    title="編輯分組"
    width="min(480px, 92vw)"
    :close-on-click-modal="false"
    :before-close="closeUnlessBusy"
    destroy-on-close
  >
    <div class="folder-form">
      <!--
        `D-127` 分組就是商品：商品分組的名字就是 AI 認的商品名（底下每份資料都掛這個名字），所以標籤直接叫「商品名」；
        通用那一組不講單一商品，照舊叫「名稱」。改商品名＝底下每份換名字、舊名字收成客人的叫法（伺服器 folders PUT）
      -->
      <div class="admin-field-group">
        <AdminFieldLabel :text="folderForm.general ? '名稱' : '商品名'" tight />
        <el-input
          v-model="folderForm.name"
          maxlength="50"
          show-word-limit
          :placeholder="folderForm.general ? '例：客服 FAQ' : '例：SHARP 自動調理零水鍋'"
        />
      </div>
      <!-- 「通用」那一組（`C-320`）：勾了排到最上面；底下的資料不當成任何一台（`D-127`） -->
      <el-checkbox v-model="folderForm.general" class="src-folder-general-check">
        通用（FAQ、公告這種不是講單一商品的）
      </el-checkbox>
      <!--
        客人還會怎麼叫它（`C-323`，`D-126` 第 4 步）：以前在「⋯ → 產品名稱整理」，跟分組是兩套。
        商品分組才有（通用那一組不講單一商品）。`D-127` 起一組只有一個商品名（上面那一格），這裡是它的其他叫法：
        全名、型號、舊名字、客人的暱稱。
        標籤＋可提示的輸入框（Element 元件、不手刻）：打字時下拉列出像的現有商品名，挑了＝當成同一台；打新的＝客人的叫法。
        ⛔ 不用 el-select 多選＋allow-create：沒按 Enter 就按儲存，打的字會被安靜丟掉（addGroupAlias 那段）
      -->
      <div v-if="!folderForm.general" class="admin-field-group src-group-alias">
        <AdminFieldLabel text="客人還會怎麼叫它" tight />
        <div v-if="groupAliasLoading" class="src-chunk-loading"><div class="spinner" /></div>
        <p v-else-if="groupAliasFailed" class="folder-form-hint">讀不到，關掉再打開一次試試。</p>
        <template v-else>
          <div v-for="row in groupAliasRows" :key="row.product" class="src-group-alias__row">
            <div v-if="row.current.length" class="src-group-alias__tags">
              <el-tag
                v-for="a in row.current"
                :key="a"
                :closable="canEdit"
                disable-transitions
                @close="removeGroupAlias(row, a)"
              >
                {{ a }}
              </el-tag>
            </div>
            <el-autocomplete
              v-if="canEdit"
              v-model="row.draft"
              :fetch-suggestions="groupAliasSuggestionsFor(row)"
              :trigger-on-focus="false"
              select-when-unmatched
              placeholder="打一個叫法，按 Enter"
              class="src-group-alias__input"
              @select="(item) => addGroupAlias(row, String(item.value ?? ''))"
            />
          </div>
          <p class="folder-form-hint">客人用這些叫法問，AI 就知道是這一台。別寫「除濕機」這種好幾台都通用的。</p>
        </template>
      </div>
      <p v-if="folder" class="folder-form-hint">
        目前底下 {{ sourceCount }} 份資料。
        刪掉這一組，底下的資料會移到「未分類」，<strong>不會</strong>被刪掉。
      </p>
    </div>
    <template #footer>
      <div class="folder-footer">
        <el-button
          type="danger"
          plain
          :loading="folderDeleting"
          :disabled="folderSaving"
          @click="deleteFolderFromModal"
        >
          刪除分組
        </el-button>
        <div class="folder-footer-right">
          <el-button :disabled="folderSaving || folderDeleting" @click="visible = false">取消</el-button>
          <el-button
            type="primary"
            :loading="folderSaving"
            :disabled="folderDeleting || !folderForm.name.trim() || !folderFormDirty"
            @click="saveFolderName"
          >
            儲存
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
/**
 * 編輯分組（`C-320`：資料庫裡叫 folder，畫面上叫「分組」）：改名、改成／取消通用、客人還會怎麼叫它（`C-323`）、刪除。
 * 知識庫頁左邊每一組右邊的「編輯分組」打開；`C-406` 從知識庫頁搬出來。
 * 會動到頁面資料的那幾件交給頁面做：合成一組（mergeGroups）、分組清單換一列／少一列（saved／deleted）、
 * 底下換了商品名的那幾份重新學（relearn）、「要處理的事」重算（changed）。
 */
import { ElMessageBox } from 'element-plus'
import { apiErrorText } from '~/utils/api-error-text'
import { ALIAS_TOO_SHORT_TEXT, isUsableAlias, normalizeProductName } from '~~/shared/product-name-similarity'
import {
  buildGroupAliasRows,
  groupAliasDiff,
  type GroupAliasRow,
  groupAliasOptions,
  type KbFolderRow,
  productGroupNamed,
} from '~/utils/kb-product-groups'

const props = defineProps<{
  open: boolean
  /** 正在編輯的那一組 */
  folder: KbFolderRow | null
  folders: KbFolderRow[]
  /** 改得了資料（sources.write）才給拿掉／加叫法：頁面判斷好傳進來（`C-407`，同 KnowledgeSiteDrafts） */
  canEdit: boolean
  /** 那一組底下現在幾份資料（刪除前講、視窗底下講） */
  sourceCount: number
  /** 頁面的 mergeProductGroups：兩組其實是同一台 → 合成一組（要動分組清單、重讀、重新學，留在頁面） */
  mergeGroups: (keep: KbFolderRow, from: KbFolderRow) => Promise<void>
}>()

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  /** 組名／通用存好了：頁面分組清單換成這一列 */
  (e: 'saved', folder: KbFolderRow): void
  /** 刪掉了：頁面拿掉這一組、底下的資料顯示在「未分類」 */
  (e: 'deleted', folderId: string): void
  /** 底下換了商品名的那幾份：頁面一份份重新學（不等；左邊那幾列標「搬移中」） */
  (e: 'relearn', sourceIds: string[]): void
  /** 「要處理的事」的數字可能跟著變（頁面重跑健康檢查） */
  (e: 'changed'): void
}>()

const { apiFetch } = useWorkspace()
const { showToast } = useAdminToast()

const visible = computed({
  get: () => props.open,
  set: (v: boolean) => emit('update:open', v),
})

const { aliasPairs, aliasProductNames, aliasFinalOf, loadAliases } = useProductAliases(() => props.folders)

const folderForm = ref({ name: '', general: false })
const folderSaving = ref(false)
const folderDeleting = ref(false)

/**
 * 存／刪到一半不給關（ESC、右上角叉叉；「取消」那顆同時鎖住）（`C-407`）：以前關得掉，
 * 馬上開另一組時那一組的按鈕卡在「處理中」、等這一組存完又把那一組的視窗關掉（打的字不見）
 */
function closeUnlessBusy(done: () => void) {
  if (!folderSaving.value && !folderDeleting.value) done()
}

// ── 客人還會怎麼叫它（`C-323`，`D-126` 第 4 步「別名取代產品名稱整理」）──
// `D-127` 起一組一列（商品名＝組名），列出現有的別名；可以打新的叫法，也可以挑一個現有的商品名（＝當成同一台）。
// 舊的「自己挑兩個合併」「已確認的對照→解除」就是這兩件事。⛔ 按「儲存」才寫（跟名字、通用同一顆）：取消要真的取消。
const groupAliasRows = ref<GroupAliasRow[]>([])
const groupAliasLoading = ref(false)
const groupAliasFailed = ref(false)

async function loadGroupAliases(folderId: string) {
  groupAliasRows.value = []
  groupAliasFailed.value = false
  groupAliasLoading.value = true
  const ok = await loadAliases()
  // 讀的這一兩秒他可能已經關掉、換開另一組
  if (!props.open || props.folder?.id !== folderId) return
  groupAliasLoading.value = false
  if (!ok) {
    groupAliasFailed.value = true
    return
  }
  groupAliasRows.value = buildGroupAliasRows(props.folder, aliasPairs.value)
}

/** 輸入框打字時的下拉：只在打字後出現（一點進去就列一排別的商品，會以為要從裡面挑） */
function groupAliasSuggestionsFor(row: GroupAliasRow) {
  return (query: string, cb: (items: Array<{ value: string }>) => void) => {
    const q = normalizeProductName(query)
    cb(q ? groupAliasOptions(row, aliasProductNames.value, aliasFinalOf.value).filter(n => normalizeProductName(n).includes(q)).map(value => ({ value })) : [])
  }
}

/**
 * 把一個叫法加成標籤（Enter、挑下拉、按儲存時框裡還有字）。回 false＝不收、原因已經講了。
 * ⛔ 不用 el-select 的「多選＋可自己打」：那個要按 Enter 才算數，打了字直接按儲存會被安靜丟掉（以前「所屬產品」欄位踩過同一個坑）
 */
function addGroupAlias(row: GroupAliasRow, value = row.draft): boolean {
  const s = String(value ?? '').trim()
  if (!s) return true
  const k = normalizeProductName(s)
  // 只檢查新的：舊資料裡可能有過短的別名，拿掉又加回來不該被擋
  if (!row.original.some(a => normalizeProductName(a) === k)) {
    if (!isUsableAlias(s)) { showToast(ALIAS_TOO_SHORT_TEXT, 'warning'); return false }
    if (s.length > 50) { showToast('叫法最多 50 個字', 'warning'); return false }
  }
  if (k === normalizeProductName(row.product)) showToast('這就是它的商品名，不用另外加', 'info')
  else if (!row.current.some(a => normalizeProductName(a) === k)) row.current = [...row.current, s]
  row.draft = ''
  return true
}

function removeGroupAlias(row: GroupAliasRow, alias: string) {
  row.current = row.current.filter(a => a !== alias)
}

/** 通用那一組不講單一商品：勾著通用時這一塊收起來、也不存 */
const groupAliasChanges = computed(() => folderForm.value.general
  ? []
  : groupAliasRows.value
      .map(row => ({ row, ...groupAliasDiff(row) }))
      .filter(x => x.added.length || x.removed.length))

/** 名字、「通用」或客人的叫法（`C-323`）有改才能按儲存（只送改了的那幾格） */
const folderFormDirty = computed(() => {
  const t = props.folder
  if (!t) return false
  return folderForm.value.name.trim() !== t.name || folderForm.value.general !== (t.general === true)
    || groupAliasChanges.value.length > 0
    // 框裡打了字還沒按 Enter 也算：儲存會把它一起加進去（不然按鈕是灰的，他會以為打的字存不了）
    || (!folderForm.value.general && groupAliasRows.value.some(r => r.draft.trim()))
})

/** 每次打開都從那一組現在的樣子開始 */
watch(() => props.open, (open) => {
  const folder = props.folder
  if (!open || !folder) return
  folderForm.value = { name: folder.name, general: folder.general === true }
  // 通用那一組也讀：他可能當場取消勾「通用」、接著要加叫法
  void loadGroupAliases(folder.id)
})

async function saveFolderName() {
  if (!props.folder) return
  const target = props.folder
  const newName = folderForm.value.name.trim()
  if (!newName || !folderFormDirty.value) return
  const body: { name?: string, general?: boolean } = {}
  if (newName !== target.name) body.name = newName
  if (folderForm.value.general !== (target.general === true)) body.general = folderForm.value.general
  // 框裡還有字＝他要加的，先收成標籤；收不了（太短）就停在這裡，原因 addGroupAlias 講過了
  if (!folderForm.value.general) {
    for (const row of groupAliasRows.value) if (!addGroupAlias(row)) return
  }
  const aliasChanges = groupAliasChanges.value
  /*
   * 挑的是另一個現有商品分組的名字＝那一組其實就是這一台 → 合成一組（`D-127` /code-review 第 10 條）：
   * 以前只記一條別名，左邊照樣兩組、那一組的資料商品名還是自己的組名，下次改名又分家。
   */
  const mergeGroups = aliasChanges.flatMap(x => x.added)
    .map(a => productGroupNamed(props.folders, a))
    .filter((g): g is KbFolderRow => !!g && g.id !== target.id)
    .filter((g, i, all) => all.findIndex(o => o.id === g.id) === i)
  const mergeIds = new Set(mergeGroups.map(g => g.id))
  // 挑的是另一個現有商品名＝兩台當成同一台。沒有系統證據背書，最常見的誤用是把同系列不同型號併掉——存之前講清楚
  const existing = new Set(aliasProductNames.value.map(normalizeProductName))
  const merges = aliasChanges.flatMap(x =>
    x.added.filter(a => existing.has(normalizeProductName(a)) && !productGroupNamed(props.folders, a)).map(a => `「${a}」`))
  if (merges.length || mergeGroups.length) {
    try {
      await ElMessageBox.confirm(
        [
          mergeGroups.length ? `${mergeGroups.map(g => `「${g.name}」`).join('、')}那一組的資料會搬進這一組，合成一組。` : '',
          merges.length ? `${merges.join('、')}現在是別的商品名，存了之後 AI 會把它當成這一台。` : '',
          '同系列的不同型號（例如 ULTRA 版、12L 與 16L）是兩台不同機器，不要這樣加。',
        ].join(''),
        '確認是同一台？',
        { confirmButtonText: '是同一台，儲存', cancelButtonText: '再想想', type: 'warning' },
      )
    }
    catch {
      return // 使用者取消
    }
  }
  folderSaving.value = true
  let relearnIds: string[] = []
  let aliasFrom = ''
  let syncFailed = false
  try {
    if (body.name !== undefined || body.general !== undefined) {
      // `D-127`：改組名、改成／取消通用＝底下每份換商品名；回要重新學的那幾份、舊組名收成了哪個別名。同名的商品分組＝400（講原因）
      const res = await apiFetch<KbFolderRow & { relearnSourceIds?: string[], aliasFrom?: string, syncFailed?: boolean }>(`/api/ai/folders/${target.id}`, { method: 'PUT', body })
      // 舊伺服器回的沒有 general：照這次送的補上，畫面上的排序才對得上
      emit('saved', { id: res.id, name: res.name, order: res.order, createdAtMs: res.createdAtMs, general: res.general ?? (body.general ?? target.general === true) })
      relearnIds = res.relearnSourceIds ?? []
      aliasFrom = res.aliasFrom ?? ''
      syncFailed = res.syncFailed === true
    }
    // 叫法一個一個存（各自有操作紀錄）。中途失敗就停、前面存好的不回滾，catch 裡重讀一次讓畫面等於真的存進去的。
    // 指向的是**改完之後**的組名（同一個視窗裡又改名又加叫法時，加的要跟著新名字）
    for (const x of aliasChanges) {
      for (const alias of x.removed) {
        await apiFetch('/api/ai/knowledge/product-aliases', { method: 'POST', body: { action: 'remove', alias } })
      }
      for (const alias of x.added) {
        // 是另一個商品分組的名字：下面合成一組時伺服器會收成別名，這裡不另外記
        if (mergeIds.has(productGroupNamed(props.folders, alias)?.id ?? '')) continue
        await apiFetch('/api/ai/knowledge/product-aliases', { method: 'POST', body: { action: 'confirm', canonical: newName, alias } })
      }
    }
    const keep = props.folders.find(f => f.id === target.id)
    if (keep) {
      for (const from of mergeGroups) await props.mergeGroups(keep, from)
    }
    // 「可能是同一台」那一列的數字可能跟著變
    if (aliasChanges.length || relearnIds.length || aliasFrom || syncFailed) emit('changed')
    if (syncFailed) {
      // 組名存好了、底下資料的商品名沒跟上：分組上留了記號，排程自己補上（`D-129`；以前叫他到「要處理的事」按「重新學習」）
      showToast('組名改好了；底下資料的商品名系統會自己跟上', 'info')
    }
    else if (!mergeGroups.length) {
      showToast(aliasFrom ? `已儲存；舊名字「${aliasFrom}」留成客人的叫法` : '已儲存', 'success')
    }
    visible.value = false
    // 底下每份換了商品名：一份份重新學（不等；左邊那幾列標「搬移中」，學完講一句）
    emit('relearn', relearnIds)
  }
  catch (err: any) {
    showToast(apiErrorText(err, '儲存失敗'), 'error')
    if (aliasChanges.length) void loadGroupAliases(target.id)
    // 組名改成了、後面叫法那一步才失敗：底下每份的商品名已經換了，照樣要重新學
    emit('relearn', relearnIds)
  }
  finally {
    folderSaving.value = false
  }
}

async function deleteFolderFromModal() {
  if (!props.folder) return
  const target = props.folder
  const count = props.sourceCount
  const msg = count
    ? `要刪除「${target.name}」這一組嗎？\n底下的 ${count} 份資料會移到「未分類」，不會被刪除。`
    : `要刪除「${target.name}」這一組嗎？（底下沒有資料）`
  try {
    await ElMessageBox.confirm(msg, '刪除分組', {
      confirmButtonText: '刪除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
      type: 'warning',
    })
  }
  catch { return }
  folderDeleting.value = true
  try {
    const res = await apiFetch<{ relearnSourceIds?: string[] }>(`/api/ai/folders/${target.id}`, { method: 'DELETE' })
    emit('deleted', target.id)
    showToast(count ? `已刪除分組，${count} 份資料移到了未分類` : '已刪除分組', 'success')
    visible.value = false
    // `D-127`：未分類＝不是講單一商品，伺服器把它們的商品名清掉了——一份份重新學，AI 才不會繼續當成那一台
    emit('relearn', res?.relearnSourceIds ?? [])
  }
  catch (err: any) {
    showToast(apiErrorText(err, '刪除失敗'), 'error')
  }
  finally {
    folderDeleting.value = false
  }
}
</script>
