<!--
  「客人會看到什麼」的共用預覽（`C-230`／`C-231`／`C-232`）。

  客服預存、活動的加好友歡迎訊息、AI 腳本的「送出一個模組」這三處，設定的都是同一種
  動作（傳送文字／開啟網址／觸發機器人模組），但以前**沒有一處看得到客人會收到什麼**。
  客服預存尤其險：那是真人客服在跟客人聊天的當下直接點一下就送出去的，
  **沒有草稿這道關卡可以擋，送錯收不回來**。

  ⭐ **文字與網址走 `autoReplyActionToLineMessages`**，也就是送出端同一支函式——
     預覽照表單另外算一次的話，我們替店家寫的那句話在預覽裡就看不到（`H-27`）。
  ⭐ **選了模組就去把那個模組真的抓回來畫**。⛔ 這裡是三態，不是兩態：
     還在抓／抓到了／抓不到。**抓不到一定要講**，畫成空白等於告訴他「這個模組是空的」，
     而那正是空「歡迎模組」害約 667 位加好友的人一句話都沒收到的形狀（`D-23`）。
-->
<template>
  <aside class="aap">
    <p v-if="title" class="aap__title">{{ title }}</p>

    <!-- ① 還沒選完／沒東西可送 -->
    <div v-if="state === 'empty'" class="aap__note aap__note--quiet">
      {{ emptyText }}
    </div>

    <!-- ② 模組內容還在抓 -->
    <div v-else-if="state === 'loading'" class="aap__note aap__note--quiet">
      正在把那個模組的內容抓回來…
    </div>

    <!-- ③ ⛔ 抓不到要講。畫成空白＝告訴他「這個模組是空的」 -->
    <div v-else-if="state === 'error'" class="aap__note aap__note--warn">
      這次沒能把「{{ moduleName || '那個模組' }}」的內容抓回來，所以下面畫不出客人會看到什麼。
      <b>這不代表那個模組是空的</b>——重新整理可以再試一次，或到「機器人模組」那一頁直接看。
    </div>

    <!-- ④ 模組真的是空的：這才是要當場攔下來的事 -->
    <div v-else-if="state === 'emptyModule'" class="aap__note aap__note--warn">
      「{{ moduleName || '這個模組' }}」<b>裡面一則訊息都沒有</b>，選了它客人什麼都收不到。
      請先到「機器人模組」把內容編好。
    </div>

    <template v-else>
      <p v-if="moduleName" class="aap__source">
        送出的是機器人模組「<b>{{ moduleName }}</b>」的內容：
      </p>
      <FlowMessagePreview
        :messages="previewMessages"
        :rich-messages="richMessages"
        :oa-name="oaName"
      />
    </template>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { autoReplyActionToLineMessages } from '~~/shared/auto-reply-content'
import { lineMessagesToPreviewMessages } from '~~/shared/broadcast-content'

const props = withDefaults(defineProps<{
  /** `AutoReplyAction` 形狀：{ type, text, uri, moduleId } */
  action: Record<string, any> | null | undefined
  /** 選單用的模組清單（只要 id／name，用來把編號講成名字） */
  moduleOptions?: Array<{ id: string; name: string }>
  title?: string
  emptyText?: string
}>(), {
  moduleOptions: () => [],
  title: '客人會看到什麼',
  emptyText: '上面選好之後，這裡會顯示客人在 LINE 裡看到的樣子。',
})

const { apiFetch, currentWorkspaceName } = useWorkspace()
const oaName = computed(() => currentWorkspaceName.value)

const actionType = computed(() => String(props.action?.type ?? ''))
const moduleId = computed(() => String(props.action?.moduleId ?? '').trim())
const moduleName = computed(() =>
  props.moduleOptions.find(m => m.id === moduleId.value)?.name ?? '')

/** 模組抓回來的內容。null＝還沒抓／抓失敗，兩者由 `moduleError` 分辨 */
const moduleMessages = ref<any[] | null>(null)
const moduleRichMessages = ref<any[]>([])
const moduleLoading = ref(false)
const moduleError = ref(false)

/**
 * ⛔ **每次換模組都要先把上一個的內容清掉**。不清的話，抓新的那段期間畫面上還掛著
 * 上一個模組的訊息——看起來像「我選了 B，但畫出來的是 A」，而且他不會知道那是舊的。
 */
async function loadModule(id: string) {
  moduleMessages.value = null
  moduleRichMessages.value = []
  moduleError.value = false
  if (!id) return

  moduleLoading.value = true
  try {
    const [flow, rich] = await Promise.all([
      apiFetch<any>(`/api/flow/${id}`),
      // 圖文訊息是另一份資料，模組裡用 `richMessageRef` 指過去；抓不到只是圖畫不出來，不算失敗
      apiFetch<any[]>('/api/rich-message/list').catch(() => []),
    ])
    moduleMessages.value = Array.isArray(flow?.messages) ? flow.messages : []
    moduleRichMessages.value = Array.isArray(rich) ? rich : []
  }
  catch {
    moduleError.value = true
    moduleMessages.value = null
  }
  finally {
    moduleLoading.value = false
  }
}

watch(
  () => (actionType.value === 'module' ? moduleId.value : ''),
  id => { void loadModule(id) },
  { immediate: true },
)

/**
 * 兩種來源**格式不一樣，不可以混在一起轉**：
 *
 * - 文字／網址：`autoReplyActionToLineMessages` 回的是 **LINE API 格式**
 *   （`template`／`buttons`），要用 `lineMessagesToPreviewMessages` 翻成預覽吃的形狀。
 * - 模組：`flows.messages` 存的**本來就是編輯器格式**（`FlowMessagePreview` 直接看得懂，
 *   機器人模組那一頁就是這樣餵它的），⛔ **不可以再轉一手**——那支轉換器看到
 *   `type: 'text'` 只會取 `text`，**模組訊息上掛的按鈕會被整排吃掉**，
 *   預覽就少了客人真正會按的東西。
 */
const previewMessages = computed(() => {
  if (actionType.value === 'module') return moduleMessages.value ?? []
  return lineMessagesToPreviewMessages(
    autoReplyActionToLineMessages(props.action as any ?? { type: '', text: '', uri: '' }),
  )
})

const richMessages = computed(() =>
  actionType.value === 'module' ? moduleRichMessages.value : [])

type State = 'empty' | 'loading' | 'error' | 'emptyModule' | 'ready'
const state = computed<State>(() => {
  if (actionType.value === 'module') {
    if (!moduleId.value) return 'empty'
    if (moduleLoading.value) return 'loading'
    if (moduleError.value) return 'error'
    if (!(moduleMessages.value?.length)) return 'emptyModule'
    return 'ready'
  }
  return previewMessages.value.length ? 'ready' : 'empty'
})
</script>
