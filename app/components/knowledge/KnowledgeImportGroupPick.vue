<template>
  <div class="kb-group-pick" :class="{ 'is-ask': ask }">
    <!--
      「這份在講哪個商品？」（`C-320`）：只有「什麼都比不到、AI 又認出一個商品」才問。
      新分組（預設）、最像的 1～3 組、「通用」各一顆；都不是的話按「其他分組」看全部。
    -->
    <template v-if="ask">
      <p class="kb-group-pick__q">這份在講哪個商品？</p>
      <div class="kb-group-pick__chips">
        <el-radio-group :model-value="currentKey" size="small" :disabled="busy || moving" @change="pick">
          <el-radio v-for="o in askOptions" :key="o.key" :value="o.key" border>{{ o.label }}</el-radio>
        </el-radio-group>
        <span v-if="moving" class="kb-group-pick__busy">搬過去中⋯</span>
        <button v-else-if="!choosing" type="button" class="kb-group-pick__edit" :disabled="busy" @click="openChooser">其他分組</button>
      </div>
    </template>
    <!-- 選單打開時那一行字先收起來：選單本身就顯示現在是哪一組，兩個並排會擠成兩行（2026-10-15 截圖看到） -->
    <template v-else-if="!choosing">
      <span class="kb-group-pick__line">{{ lineText }}</span>
      <!-- 搬進商品分組時伺服器可能要補商品名、重新學過這一份（最久約 9 秒，`/code-review` ⑬）：要看得出正在做 -->
      <span v-if="moving" class="kb-group-pick__busy">搬過去中⋯</span>
      <button v-else type="button" class="kb-group-pick__edit" :disabled="busy" @click="openChooser">改</button>
    </template>
    <el-select
      v-if="choosing"
      ref="selectEl"
      :model-value="currentKey"
      size="small"
      filterable
      automatic-dropdown
      placeholder="選一個分組"
      class="kb-group-pick__select"
      :disabled="busy"
      @change="pick"
      @visible-change="onVisible"
    >
      <el-option v-for="o in allOptions" :key="o.key" :label="o.label" :value="o.key" />
    </el-select>
  </div>
</template>

<script setup lang="ts">
/**
 * 「放在哪一組」那一行（`C-320`）：結果頁、停下來的那一頁、一次好幾份的每一列共用。
 * 平常只有一行「放在『X』」＋「改」；按「改」才出一個選單（「通用」排最前面、新分組、不放分組）。
 * 只負責畫與選：選了什麼交給呼叫端（還沒加的改送出去的值；已經加進去的搬過去）。
 */
import {
  closestGroups,
  findGroupByName,
  GENERAL_GROUP_NAME,
  generalGroup,
  groupChoiceFromKey,
  groupChoiceKey,
  type ImportGroup,
  type ImportGroupChoice,
  type ImportGroupHints,
  newGroupName,
  orderedGroups,
} from '~~/shared/knowledge-import-group'

const props = withDefaults(defineProps<{
  groups: readonly ImportGroup[]
  /** null＝沒有要改（換掉原本那一份、他沒動過）：分組照原本那一份的 */
  modelValue: ImportGroupChoice | null
  /** AI 認的商品名（''＝沒認出）：「新分組『X』」那個選項用 */
  newName?: string
  /** 這次開窗替他建的分組：顯示成「新分組『X』」，「新分組」那個選項也對到它（不會再建一次） */
  newIds?: readonly string[]
  hints?: ImportGroupHints
  ask?: boolean
  /** 按不得（例如正在加入）：只鎖住 */
  busy?: boolean
  /** 正在搬過去（已經加進去的那一份）：鎖住、並顯示「搬過去中⋯」 */
  moving?: boolean
}>(), { newName: '', newIds: () => [], hints: () => ({}), ask: false, busy: false, moving: false })

const emit = defineEmits<{ 'update:modelValue': [value: ImportGroupChoice] }>()

const choosing = ref(false)
const selectEl = ref<{ focus: () => void } | null>(null)

const nameOf = (id: string) => props.groups.find(g => g.id === id)?.name ?? ''
const cleanNew = computed(() => newGroupName(props.newName))

/**
 * 「新分組『X』」那個選項的值：已經替他建好了就是那一組（⛔ 不再是 'new'，不然選了會再建一個同名的）；
 * 有一組本來就叫這個名字＝不是新的，不給這個選項（那一組自己會在清單上）。
 */
const newOption = computed<{ key: string, label: string } | null>(() => {
  if (!cleanNew.value) return null
  const same = findGroupByName(props.groups, cleanNew.value)
  if (same && !props.newIds.includes(same.id)) return null
  return { key: same ? `g:${same.id}` : 'new', label: `新分組「${same?.name ?? cleanNew.value}」` }
})

const currentKey = computed(() => groupChoiceKey(props.modelValue))

/**
 * 「通用」那個選項：已經有通用那一組就是它；還沒有＝選了才建一組（`POST /api/ai/folders` 帶 general，伺服器那邊已經收）。
 * ⛔ 不因為還沒有就不給這個選項：FAQ、公告、價目表本來就該放這裡，沒得選只會讓它們都掉在「不放分組」
 */
const generalOption = computed(() => {
  const g = generalGroup(props.groups)
  return g ? { key: `g:${g.id}`, label: g.name } : { key: 'general', label: GENERAL_GROUP_NAME }
})

const lineText = computed(() => {
  const c = props.modelValue
  if (!c) return '分組不變'
  if (c.kind === 'none') return '不放分組'
  if (c.kind === 'new') return c.general ? `放在「${c.name}」` : `放在新分組「${c.name}」`
  const name = nameOf(c.id)
  if (!name) return '分組不變'
  return props.newIds.includes(c.id) ? `放在新分組「${name}」` : `放在「${name}」`
})

const askOptions = computed(() => {
  const out: Array<{ key: string, label: string }> = []
  if (newOption.value) out.push(newOption.value)
  const skip = new Set(props.newIds)
  for (const g of closestGroups(props.groups.filter(x => !skip.has(x.id)), props.hints, 3)) out.push({ key: `g:${g.id}`, label: g.name })
  out.push(generalOption.value)
  return out
})

/** 「改」那一排：「通用」最前面、其他分組、新分組、不放分組 */
const allOptions = computed(() => {
  const out = orderedGroups(props.groups).map(g => ({ key: `g:${g.id}`, label: g.name }))
  if (generalOption.value.key === 'general') out.unshift(generalOption.value)
  if (newOption.value?.key === 'new') out.push(newOption.value)
  out.push({ key: 'none', label: '不放分組' })
  return out
})

function openChooser() {
  choosing.value = true
  nextTick(() => selectEl.value?.focus())
}
function onVisible(open: boolean) {
  if (!open) choosing.value = false
}
function pick(key: string | number | boolean | undefined) {
  choosing.value = false
  const k = String(key ?? '')
  if (!k || k === currentKey.value) return
  emit('update:modelValue', groupChoiceFromKey(k, cleanNew.value))
}
</script>
