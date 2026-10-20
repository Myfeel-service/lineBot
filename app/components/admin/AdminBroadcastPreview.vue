<!--
  一則推播「客人收到的樣子」。推播頁右欄（`C-229`／`C-245`）與客服對話頁的群發抽屜（`D-48`）共用這一支。
  ⛔ 不要為了別的頁再寫第二套推播預覽（`H-27`：預覽在說謊比沒有預覽更糟，兩套遲早漂開）。

  `C-245`（2026-09-24）**修掉一個畫了四個月、客人一次都沒收到的預覽**：
  選「觸發機器人模組」時，`unifiedActionToLineMessages()` 組出來的那張
  「點下面的按鈕看看＋開始」卡片，**送出端會在送出前整張換成模組自己的那幾則訊息**
  （`broadcast-send.ts`，2026-05-07 起）。所以這裡分三條路（判斷在 `broadcastPreviewRoute`，
  模組那條用的是送出端同一支 `extractBroadcastTriggerModuleId()`）：
    ① 已送出且有留存 → 畫**當時真的送出去的那一份**（`C-246` 的快照）
    ② 模組型 → 用共用的 `AdminActionPreview` 把那個模組**真的抓回來畫**（三態它自己講）
    ③ 純文字／開啟網址 → 照訊息本身畫
  `layout` 只管外框：page＝推播頁右欄（黏著、拉滿編輯區，樣式在 _broadcasts.scss）；
  drawer＝對話頁的抽屜（跟著抽屜寬，樣式在 _conversations.scss）。內容三條路兩邊一模一樣。
-->
<template>
  <!-- ① 已送出，而且當時的內容有留存 -->
  <div v-if="route === 'sent'" :class="panelClass">
    <p class="aap__source">
      這是<b>當時真的送出去</b>的 {{ sentContentMessages.length }} 則{{ sentContentModuleName ? `（機器人模組「${sentContentModuleName}」）` : '' }}：
    </p>
    <p v-if="sentContentVarNote" class="aap__note" :class="noteTone">{{ sentContentVarNote }}</p>
    <FlowMessagePreview :messages="sentContentPreview.value" :oa-name="oaName" />
  </div>

  <!-- ② 觸發機器人模組：去把那個模組真的抓回來畫 -->
  <AdminActionPreview
    v-else-if="route === 'module'"
    :class="panelClass"
    :action="{ type: 'module', moduleId: previewModuleId, text: '', uri: '' }"
    :module-options="moduleOptions"
    title=""
    broadcast
    :blank-variables="blankVariables"
  >
    <template #ready-note="{ count }">
      <!-- ⛔ 這句只有推播講得出來：別處是客人按了才收到，推播是直接送到手機上。
           這句在手機框**上面**（下面會被小幫手浮鈕蓋住），所以講「下面畫的是」 -->
      <p v-if="readOnly" class="aap__note aap__note--warn">
        這則推播<b>沒有留存當時送出去的內容</b>（2026-09-24 之前送出的都沒有），
        下面畫的是那個模組<b>現在</b>的樣子，中間可能已經被改過。
      </p>
      <p v-else class="aap__note aap__note--quiet">
        客人會<b>直接收到這 {{ count }} 則</b>，不需要點任何按鈕。
      </p>
    </template>
  </AdminActionPreview>

  <!-- ③ 純文字／開啟網址：用了名字變數時多講一句（範例名字，或舊推播當時是空白），改用跟①同一種面板（手機上面一句、下面手機）；
       ⛔ 句子直接接在手機旁邊會變成預覽區的第二欄，把手機擠到中間。抽屜裡一律包一層（抽屜自己沒有面板） -->
  <div v-else-if="textPreviewVarNote || layout === 'drawer'" :class="panelClass">
    <p v-if="textPreviewVarNote" class="aap__note" :class="noteTone">{{ textPreviewVarNote }}</p>
    <FlowMessagePreview :messages="textPreview.value" :oa-name="oaName" />
  </div>
  <FlowMessagePreview
    v-else
    class="bc-preview"
    :messages="textPreview.value"
    :oa-name="oaName"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  broadcastPreviewRoute,
  extractBroadcastTriggerModuleId,
  lineMessagesToPreviewMessages,
} from '~~/shared/broadcast-content'
import {
  broadcastBlankVariableNote,
  previewVariableNote,
  renderBroadcastVariablesDeep,
  renderPreviewVariablesDeep,
} from '~~/shared/preview-variables'

const props = withDefaults(defineProps<{
  /**
   * 這則推播的內容（LINE 格式）。推播頁傳的是表單即時組出來的那一份（`buildMessages()`，
   * 送出端也是吃它）；對話頁傳的是詳情 API 存的那一份。
   */
  messages: Record<string, unknown>[]
  /** 送出端留存的「當時真的送出去」那一份（`C-246`；只在詳情 API 有，2026-09-24 以前送的沒有） */
  sentContent?: Record<string, any> | null
  /** 名字變數那一格客人當時收到的是空白（`D-118`，判斷見 `broadcastSentWithBlankVariables`） */
  blankVariables?: boolean
  /** 回頭看已經發出去／取消的那一則（決定模組型那句話怎麼講） */
  readOnly?: boolean
  /** 模組的名字（把編號講成名字；沒有就不講名字） */
  moduleOptions?: Array<{ id: string; name: string }>
  layout?: 'page' | 'drawer'
}>(), {
  sentContent: null,
  blankVariables: false,
  readOnly: false,
  moduleOptions: () => [],
  layout: 'page',
})

const { currentWorkspaceName } = useWorkspace()
const oaName = computed(() => currentWorkspaceName.value)

const route = computed(() => broadcastPreviewRoute({ messages: props.messages, sentContent: props.sentContent }))
const previewModuleId = computed(() => extractBroadcastTriggerModuleId(props.messages))

const panelClass = computed(() => (props.layout === 'drawer' ? 'bc-sent-preview' : 'bc-preview bc-preview--panel'))
const noteTone = computed(() => (props.blankVariables ? 'aap__note--warn' : 'aap__note--quiet'))

/**
 * ⭐ 純文字／開啟網址走的是 `messages` 本身——這兩型送出端只會把 {{變數}} 換成名字或空白
 * （`server/utils/render-attributes.ts`），下面照同一條規則畫，所以畫出來的就是客人收到的。
 * ⛔ 不要改成照表單另外拼一份：系統套進去的預設文案（「點下面的按鈕看看」那句）就不會出現在預覽裡。
 */
const previewMessages = computed(() => lineMessagesToPreviewMessages(props.messages))

const sentContentMessages = computed<any[]>(() => {
  const msgs = props.sentContent?.messages
  return Array.isArray(msgs) ? msgs : []
})
const sentContentModuleName = computed(() => String(props.sentContent?.moduleName ?? ''))

const renderForPreview = (messages: any[]) => (props.blankVariables
  ? renderBroadcastVariablesDeep(messages)
  // `D-128`：範例值標黃色（FlowMessagePreview 用 PreviewText 畫）
  : renderPreviewVariablesDeep(messages, { mark: true }))
const noteForPreview = (keys: string[]) => (props.blankVariables
  ? broadcastBlankVariableNote(keys)
  : previewVariableNote(keys))
const sentContentPreview = computed(() => renderForPreview(sentContentMessages.value))
const sentContentVarNote = computed(() => noteForPreview(sentContentPreview.value.keys))
const textPreview = computed(() => renderForPreview(previewMessages.value))
const textPreviewVarNote = computed(() => noteForPreview(textPreview.value.keys))
</script>
