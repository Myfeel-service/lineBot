<template>
  <AdminSplitLayout solo :is-empty="false">
    <template #editor-header>
      <AdminSoloPageHeading
        field-label="標籤管理"
        title="標籤列表"
        caption="建立與管理好友標籤，用於分眾推播"
      />
      <div class="flex gap-1 admin-header-actions">
        <!-- 範本＝AI 判斷型標籤的起手式：名稱、判斷條件都寫好，一鍵建立改幾個字就能用（D-27③） -->
        <el-button v-if="canOperate" size="small" data-tour="tag-templates" @click="openTemplates">從範本建立</el-button>
        <el-button v-if="canOperate" :icon="Plus" type="primary" size="small" data-tour="tag-new" @click="openCreate">新增</el-button>
      </div>
    </template>

    <template #editor-body>
      <div class="solo-editor-body admin-panel-stack">
        <div class="message-card tags-page-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">篩選與表格</span>
            </div>
          </div>
          <div class="card-section-stack">
            <div class="tags-toolbar" data-tour="tag-filter">
              <div class="tags-toolbar__field tags-toolbar__field--search">
                <AdminFieldLabel text="搜尋（標籤名稱或英文代號）" tight />
                <el-input v-model="searchText" placeholder="輸入關鍵字…" clearable />
              </div>
              <div class="tags-toolbar__field tags-toolbar__field--category">
                <AdminFieldLabel text="分類" tight />
                <el-select v-model="filterCategory" placeholder="全部" clearable>
                  <el-option
                    v-for="c in TAG_CATEGORY_OPTIONS"
                    :key="c.value"
                    :label="c.label"
                    :value="c.value"
                  />
                </el-select>
              </div>
              <div class="tags-toolbar__field tags-toolbar__field--status">
                <AdminFieldLabel text="狀態" tight />
                <el-select v-model="filterStatus" placeholder="全部" clearable>
                  <el-option label="啟用" value="active" />
                  <el-option label="停用" value="inactive" />
                </el-select>
              </div>
              <div class="tags-toolbar__field tags-toolbar__field--status">
                <AdminFieldLabel text="AI 判斷" tight />
                <el-select v-model="filterAiMode" placeholder="全部" clearable>
                  <el-option label="不用（我自己貼）" value="off" />
                  <el-option label="AI 先建議" value="suggest" />
                  <el-option label="AI 直接貼" value="auto" />
                </el-select>
              </div>
              <span class="tags-count text-muted">共 {{ total.toLocaleString('zh-TW') }} 筆</span>
            </div>

            <div v-if="loading" class="tags-loading">
              <div class="spinner" />
              <span>載入中…</span>
            </div>
            <div v-else-if="!tags.length" class="tags-empty">
              <span>{{ total ? '無符合的標籤' : '尚無任何標籤，請點擊右上角「新增標籤」開始' }}</span>
            </div>
            <div v-else class="table-wrap">
              <table class="tags-table">
                <thead>
                  <tr>
                    <th class="tags-table__th--swatch" />
                    <th>名稱</th>
                    <th>Code</th>
                    <th>AI 判斷</th>
                    <th>分類</th>
                    <th>狀態</th>
                    <th class="tags-table__th--count">好友數</th>
                    <th>建立時間</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="tag in tags"
                    :key="tag.id"
                    class="tags-table__row--clickable"
                    tabindex="0"
                    @click="openEdit(tag)"
                    @keydown.enter="openEdit(tag)"
                  >
                    <td>
                      <span class="tag-color-dot" :style="{ '--dot-bg': tag.color || '#6B7280' }" />
                    </td>
                    <td class="td-name">{{ tag.name }}</td>
                    <td class="td-code">{{ tag.code }}</td>
                    <!-- 一眼看出「這顆是誰在貼」：AI 有在動的才上色，off 給低調的「—」
                         （21 顆裡多數是 off，整欄都掛灰章只是噪音） -->
                    <td>
                      <span v-if="tag.aiMode === 'auto'" class="badge badge-green">AI 直接貼</span>
                      <span v-else-if="tag.aiMode === 'suggest'" class="badge badge-orange">AI 先建議</span>
                      <span v-else class="text-muted">—</span>
                    </td>
                    <td>
                      <span class="badge badge-gray">{{ tagCategoryLabel(tag.category) }}</span>
                    </td>
                    <td>
                      <span :class="tag.status === 'active' ? 'badge badge-green' : 'badge badge-gray'">
                        {{ tag.status === 'active' ? '啟用' : '停用' }}
                      </span>
                    </td>
                    <!-- 大數字要能點進明細：帶著標籤跳好友頁（?tagIds=）就是那份名單。
                         ⛔ 要 stop 掉冒泡——整列的 click 是開編輯對話框，不擋的話會同時觸發。
                         0 位時不給連結（點進去只會看到空清單，是死路不是捷徑）。 -->
                    <td class="td-count">
                      <button
                        v-if="(tag.memberCount ?? 0) > 0"
                        type="button"
                        class="tags-count-link"
                        :title="`看這 ${formatMemberCount(tag.memberCount)} 位好友`"
                        @click.stop="goTaggedFriends(tag.id)"
                      >{{ formatMemberCount(tag.memberCount) }}</button>
                      <span v-else>{{ formatMemberCount(tag.memberCount) }}</span>
                    </td>
                    <td class="td-time">{{ formatZhDateOnly(tag.createdAt) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div v-if="!loading && total > pageSize" class="admin-table-pager">
              <el-pagination
                :current-page="page"
                :page-size="pageSize"
                :total="total"
                layout="total, prev, pager, next"
                background
                @current-change="onPageChange"
              />
            </div>
          </div>
        </div>
      </div>
    </template>
  </AdminSplitLayout>

  <el-dialog
    v-model="dialogVisible"
    :title="isEditing ? '編輯標籤' : '新增標籤'"
    width="min(600px, 94vw)"
    class="tags-dialog"
    :close-on-click-modal="false"
  >
    <el-form label-position="top" @submit.prevent>
      <div class="admin-field-stack">
        <div class="admin-field-group">
          <AdminFieldLabel text="啟用狀態" tight />
          <el-switch
            v-model="form.status"
            active-value="active"
            inactive-value="inactive"
            active-text="啟用中"
            inactive-text="已停用"
            class="tags-status-switch"
          />
          <span class="tags-hint">停用的標籤不會出現在貼標選單，但仍可在此編輯</span>
        </div>

        <div class="admin-field-group" data-tour="tag-code">
          <AdminFieldLabel text="英文代號（系統辨識用，建立後就不能改）" tight />
          <el-input
            v-model="form.code"
            :disabled="isEditing"
            placeholder="例如 interest_food、vip"
            maxlength="40"
          />
          <span class="tags-hint">給系統認的英文代號（不會給客人看到）：只能用英文小寫、數字、底線，開頭要是英文字母</span>
        </div>

        <div class="admin-field-group" data-tour="tag-name">
          <AdminFieldLabel text="顯示名稱（最多 30 字）" tight />
          <el-input v-model="form.name" placeholder="例如 美食愛好者" maxlength="30" />
        </div>

        <div class="admin-field-group">
          <AdminFieldLabel text="分類" tight />
          <el-select v-model="form.category" class="tags-dialog-select">
            <el-option
              v-for="c in TAG_CATEGORY_OPTIONS"
              :key="c.value"
              :label="c.label"
              :value="c.value"
            />
          </el-select>
        </div>

        <div class="admin-field-group">
          <AdminFieldLabel text="標籤顏色" tight />
          <div class="tags-color-row">
            <button
              v-for="c in TAG_PRESET_COLORS"
              :key="c"
              type="button"
              class="tags-color-swatch"
              :class="{ active: form.color === c }"
              :style="{ '--swatch-bg': c }"
              @click="form.color = c"
            />
          </div>
        </div>

        <!-- 說明與 AI 判斷條件是**兩欄**（D-27②）：既有標籤的說明是寫給人看的（檔期備註
             之類），拿去當 AI 條件會讓它亂猜。AI 只讀 aiCriteria，description 回歸內部備註。 -->
        <div class="admin-field-group">
          <AdminFieldLabel text="說明（給團隊看，選填）" tight />
          <el-input
            v-model="form.description"
            type="textarea"
            :rows="2"
            placeholder="這顆標籤是做什麼的、誰負責、檔期備註——寫給人看的話"
            maxlength="200"
          />
        </div>

        <!-- 三段選擇（D-27①）：一個控制講完「讓不讓 AI 判＋判了怎麼處理」。
             ⛔ 不做成兩個開關——四種組合有一種（不讓判卻自動貼）沒有意義。
             預設 off＝問卷/客服/活動這類事件紀錄標籤完全不被 AI 碰。 -->
        <div class="admin-field-group">
          <AdminFieldLabel text="要不要讓 AI 判斷這顆標籤？" tight />
          <!-- ⛔ 用 el-radio-group 不要手刻 <input type="radio">：base/_reset.scss 有
               `input, textarea, select { width: 100% }`，原生 radio 會被拉成滿版把整列吃光，
               旁邊的文字被壓成 0 寬變直排（2026-08-24 實際破版過）。Element Plus 的真 input
               是隱藏的 .el-radio__original，不吃那條規則。 -->
          <el-radio-group v-model="form.aiMode" class="tags-ai-options">
            <el-radio
              v-for="opt in AI_MODE_OPTIONS"
              :key="opt.value"
              :value="opt.value"
              class="tags-ai-option"
            >
              <span class="tags-ai-option__title">{{ opt.title }}</span>
              <span class="tags-ai-option__desc">{{ opt.desc }}</span>
            </el-radio>
          </el-radio-group>
        </div>

        <!-- 判斷條件只在需要時出現（漸進揭露）：off 的 19 顆標籤不用面對用不到的欄位。
             切到 suggest/auto 時把 description 預填進來讓人改（不是靜默沿用，見 watch）。
             ⛔ maxlength 200 = ai-tag-suggest 的 CRITERIA_IN_PROMPT_MAX，動一邊要動另一邊
             （有測試釘住「滿 200 字要整段進 prompt」）。 -->
        <div v-if="form.aiMode !== 'off'" class="admin-field-group tags-criteria-group">
          <AdminFieldLabel text="AI 判斷條件（只有這欄 AI 會看）" tight />
          <el-input
            v-model="form.aiCriteria"
            type="textarea"
            :rows="3"
            placeholder="例：客人詢問、比較除濕機，或提到家裡潮濕、衣服晾不乾想找解法。只問舊機維修的不算。"
            maxlength="200"
            show-word-limit
          />
          <p class="tags-desc-hint text-muted">
            AI 會拿整段對話對照這裡寫的條件，<strong>只看客人說的話</strong>（客服自己提到不算）。
            寫法：<strong>什麼算</strong>、順便寫<strong>什麼不算</strong>，越像人話越準。
            要生效記得到「AI 設定 → 顧客標籤」開啟 AI 讀對話的總開關。
          </p>
        </div>
      </div>
    </el-form>

    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button v-if="canOperate" type="primary" :loading="saving" @click="submitForm">
        {{ isEditing ? '儲存變更' : '建立標籤' }}
      </el-button>
    </template>
  </el-dialog>

  <!-- ── 範本（D-27③）：AI 判斷型標籤的起手式 ──────────────
       難的不是點「新增」，是想不到該建哪些、條件怎麼寫。範本全部寫好，
       勾選建立後改幾個字就能用；建立時一律「AI 先建議」，跑準了再自行升級直接貼。 -->
  <el-dialog v-model="templateDialogVisible" title="從範本建立 AI 判斷型標籤" width="min(680px, 94vw)">
    <p class="tags-desc-hint text-muted" style="margin-top: 0">
      這些都是「對話裡看得出來」的意圖標籤——判斷條件已經寫好，建立後可到標籤上逐字修改。
      建立時一律是「<strong>AI 先建議</strong>」，你按採用才貼；覺得準了再把該顆改成「直接貼」。
    </p>
    <!-- 同三段選擇：原生 checkbox 也會被 reset 的 `input { width: 100% }` 拉滿版，一律走 el-checkbox -->
    <el-checkbox-group v-model="selectedTemplateCodes" class="tags-template-list">
      <el-checkbox
        v-for="t in TAG_TEMPLATES"
        :key="t.code"
        :value="t.code"
        :disabled="existingCodes.has(t.code)"
        class="tags-template-item"
        :class="{ 'is-exists': existingCodes.has(t.code) }"
      >
        <span class="tags-template-item__name">
          <span class="tag-color-dot" :style="{ '--dot-bg': t.color }" />
          {{ t.name }}
          <span v-if="existingCodes.has(t.code)" class="badge badge-gray">已建立</span>
        </span>
        <span class="tags-template-item__criteria">條件：{{ t.criteria }}</span>
        <span class="tags-template-item__usage">{{ t.usage }}</span>
      </el-checkbox>
    </el-checkbox-group>
    <template #footer>
      <el-button @click="templateDialogVisible = false">關閉</el-button>
      <el-button
        v-if="canOperate"
        type="primary"
        :loading="creatingTemplates"
        :disabled="!selectedTemplateCodes.length"
        @click="createFromTemplates"
      >
        建立所選（{{ selectedTemplateCodes.length }}）
      </el-button>
    </template>
  </el-dialog>

</template>

<script setup lang="ts">
import { Plus } from '@element-plus/icons-vue'
import { formatZhDateOnly } from '~~/shared/firestore-date'
import { TAG_CATEGORY_OPTIONS, TAG_PRESET_COLORS, tagCategoryLabel } from '~~/shared/tag-admin'
import { TAG_TEMPLATES } from '~~/shared/tag-templates'
import type { TagAiMode } from '~~/shared/types/tag-broadcast'

/** 三段選擇的文案（D-27①）：信任程度由低到高，一次講完「讓不讓判＋判了怎麼處理」 */
const AI_MODE_OPTIONS: Array<{ value: TagAiMode; title: string; desc: string }> = [
  { value: 'off', title: '不用，我自己貼（預設）', desc: 'AI 完全不會碰這顆。問卷、客服、活動這類由系統或人貼的標籤選這個。' },
  { value: 'suggest', title: 'AI 判斷後先建議，我按了才貼', desc: '出現在「好友」頁那位客人的 AI 建議區，你按採用才生效。新標籤建議從這段開始。' },
  { value: 'auto', title: 'AI 判斷到就直接貼上', desc: '不用你按。會記「AI 貼的」、隨時可拿掉；手動拿掉過的客人 AI 不會再貼。' },
]

definePageMeta({ middleware: 'auth', layout: 'default' })

const { workspaceId, apiFetch } = useWorkspace()
const { canOperate, assertCanOperate } = useAdminOperateGuard()
const { tags, loading, total, page, pageSize, loadTags } = useAdminTagList()
const { showToast } = useAdminToast()

const saving = ref(false)
const dialogVisible = ref(false)
const isEditing = ref(false)
const searchText = ref('')
const filterCategory = ref('')
const filterStatus = ref('')
const filterAiMode = ref('')

const defaultForm = () => ({
  id: '',
  code: '',
  name: '',
  category: 'custom' as const,
  color: '#6B7280',
  description: '',
  aiMode: 'off' as TagAiMode,
  aiCriteria: '',
  status: 'active' as 'active' | 'inactive',
})
const form = ref(defaultForm())

/**
 * 切到「讓 AI 判」而條件還是空的 → 把說明**預填**進去當底稿讓人改。
 * ⛔ 是預填不是靜默沿用：欄位裡看得到、能整段改掉——「AI 偷偷拿說明當條件」正是
 * 這次要拆掉的行為（G-24 的教訓）。
 */
watch(() => form.value.aiMode, (mode, prev) => {
  if (prev === 'off' && mode !== 'off' && !form.value.aiCriteria.trim() && form.value.description.trim()) {
    form.value.aiCriteria = form.value.description.trim()
  }
})

// ── 範本（D-27③）──────────────────────────────────────
const templateDialogVisible = ref(false)
const selectedTemplateCodes = ref<string[]>([])
const creatingTemplates = ref(false)
/** 已存在的 code（含分頁外的：範本 code 撞號時後端也會 409 擋，這裡是第一道顯示） */
const existingCodes = computed(() => new Set(tags.value.map((t: any) => String(t.code ?? ''))))

function openTemplates() {
  selectedTemplateCodes.value = []
  templateDialogVisible.value = true
}

async function createFromTemplates() {
  if (!assertCanOperate()) return
  if (!selectedTemplateCodes.value.length) return
  creatingTemplates.value = true
  let created = 0
  let skipped = 0
  try {
    // 逐顆建（一次最多 8 顆）：單顆撞號（409）算跳過不算失敗，其餘照建
    for (const code of selectedTemplateCodes.value) {
      const t = TAG_TEMPLATES.find(x => x.code === code)
      if (!t) continue
      try {
        await apiFetch('/api/tag/create', {
          method: 'POST',
          body: {
            code: t.code,
            name: t.name,
            category: t.category,
            color: t.color,
            description: t.usage,
            aiMode: 'suggest', // 範本一律先建議（人工把關），跑準了再自行升級 auto
            aiCriteria: t.criteria,
            status: 'active',
          },
        })
        created++
      }
      catch (e: any) {
        if (e?.status === 409 || e?.statusCode === 409) skipped++
        else throw e
      }
    }
    showToast(skipped ? `建立 ${created} 顆（${skipped} 顆已存在，略過）` : `建立 ${created} 顆標籤`, 'success')
    templateDialogVisible.value = false
    await refreshTags()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '建立失敗', 'error')
  }
  finally {
    creatingTemplates.value = false
  }
}

function formatMemberCount(count: number | undefined) {
  return (count ?? 0).toLocaleString('zh-TW')
}

/** 點「好友數」→ 好友頁並自動套上這顆標籤的篩選（那頁 onMounted 會讀 ?tagIds=） */
function goTaggedFriends(tagId: string) {
  navigateTo(`/admin/${workspaceId.value}/users?tagIds=${encodeURIComponent(tagId)}`)
}

function tagListQuery(targetPage = page.value) {
  return {
    page: targetPage,
    limit: pageSize.value,
    includeMemberCount: true,
    status: filterStatus.value || undefined,
    category: filterCategory.value || undefined,
    aiMode: filterAiMode.value || undefined,
    search: searchText.value,
  }
}

async function reloadTags(resetPage = false) {
  const targetPage = resetPage ? 1 : page.value
  const ok = await loadTags(tagListQuery(targetPage))
  if (!ok) showToast('載入標籤失敗', 'error')
}

async function refreshTags() {
  await reloadTags()
}

async function onPageChange(nextPage: number) {
  await loadTags(tagListQuery(nextPage))
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
watch([filterStatus, filterCategory, filterAiMode], () => {
  void reloadTags(true)
})
watch(searchText, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void reloadTags(true), 300)
})

function openCreate() {
  isEditing.value = false
  form.value = defaultForm()
  dialogVisible.value = true
}

function openEdit(tag: any) {
  isEditing.value = true
  form.value = {
    id: tag.id,
    code: tag.code,
    name: tag.name,
    category: (tag.category ?? 'custom') as any,
    color: tag.color ?? '#6B7280',
    description: tag.description ?? '',
    // 舊標籤沒有這兩欄＝off（跟後端與掃描器同一個口徑）
    aiMode: (tag.aiMode === 'suggest' || tag.aiMode === 'auto' ? tag.aiMode : 'off') as TagAiMode,
    aiCriteria: tag.aiCriteria ?? '',
    status: tag.status === 'inactive' ? 'inactive' : 'active',
  }
  dialogVisible.value = true
}

function validateForm(): string | null {
  if (!form.value.code.trim()) return '請填寫 Code'
  if (!/^[a-z][a-z0-9_]*$/.test(form.value.code)) return 'Code 格式錯誤（英文小寫開頭，可含數字與底線）'
  if (!form.value.name.trim()) return '請填寫顯示名稱'
  if (!form.value.category) return '請選擇分類'
  return null
}

async function submitForm() {
  if (!assertCanOperate()) return
  const err = validateForm()
  if (err) return showToast(err, 'error')
  saving.value = true
  try {
    if (isEditing.value) {
      await apiFetch(`/api/tag/${form.value.id}`, {
        method: 'PUT',
        body: {
          name: form.value.name.trim(),
          category: form.value.category,
          color: form.value.color,
          description: form.value.description.trim(),
          aiMode: form.value.aiMode,
          aiCriteria: form.value.aiCriteria.trim(),
          status: form.value.status,
        },
      })
      showToast('標籤已更新', 'success')
    }
    else {
      await apiFetch('/api/tag/create', {
        method: 'POST',
        body: {
          code: form.value.code.trim(),
          name: form.value.name.trim(),
          category: form.value.category,
          color: form.value.color,
          description: form.value.description.trim(),
          aiMode: form.value.aiMode,
          aiCriteria: form.value.aiCriteria.trim(),
          status: form.value.status,
        },
      })
      showToast('標籤已建立', 'success')
    }
    dialogVisible.value = false
    await refreshTags()
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '儲存失敗', 'error')
  }
  finally {
    saving.value = false
  }
}

onMounted(() => reloadTags(true))
</script>
