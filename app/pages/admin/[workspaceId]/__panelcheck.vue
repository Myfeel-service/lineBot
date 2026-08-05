<template>
  <div style="height: 100vh; display: flex; flex-direction: column;">
    <div id="probe-state" style="padding: 4px 8px; font: 12px monospace; background: #eee;">
      input={{ JSON.stringify(panelInput) }} caret={{ caretPos }} stickerSent={{ stickerSent }} dialog={{ dialogOpen }}
    </div>
    <div style="flex: 1; min-height: 0;">
      <ConversationsAdminPanel :api-fetch="fakeFetch" />
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: false })

const route = useRoute()
const list = useState<any[]>('workspace:list', () => [])
list.value = [{
  workspaceId: String(route.params.workspaceId),
  name: 'probe',
  role: 'owner',
  organizationId: null,
  organizationName: null,
}]

const CONVS = [
  { userId: 'u-a', displayName: '客人 A', pictureUrl: '', lastMessage: 'hi', lastDirection: 'incoming', lastMessageAt: { _seconds: 1 }, isBlocked: false },
  { userId: 'u-b', displayName: '客人 B', pictureUrl: '', lastMessage: 'yo', lastDirection: 'incoming', lastMessageAt: { _seconds: 1 }, isBlocked: false },
]
const stickerSent = ref(0)

async function fakeFetch(url: string, opts?: any): Promise<any> {
  await new Promise(r => setTimeout(r, 100))
  if (url.includes('/api/conversations/list')) return { conversations: CONVS, total: 2, page: 1, limit: 30, hasMore: false }
  if (url.endsWith('/messages')) return { messages: [], activeSession: null }
  if (url.endsWith('/send')) {
    if (opts?.body?.type === 'sticker') stickerSent.value++
    return { ok: true }
  }
  if (url.includes('/ai-context')) return null
  if (url.includes('/support-preset/list')) return []
  return {}
}

const panelInput = ref('')
const caretPos = ref(-1)
const dialogOpen = ref(false)
onMounted(() => {
  setInterval(() => {
    const ta = document.querySelector('.conv-input-row textarea') as HTMLTextAreaElement | null
    panelInput.value = ta?.value ?? '(none)'
    caretPos.value = ta?.selectionStart ?? -1
    dialogOpen.value = !!document.querySelector('.el-dialog__wrapper:not([style*="display: none"]) , .el-overlay-dialog')
  }, 40)
})
</script>
