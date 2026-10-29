<template>
  <!--
    「先發一則給自己看」的框：推播試發（`C-248`）、機器人模組「傳給我自己看」（`C-426`）共用。
    `D-119` ⑥（2026-10-09 老闆「照改」）：收件人是一份固定名單打勾，⛔ 不在九千多位好友裡搜名字
    （叫 Alice 的有 5 位，挑錯就是把還沒定稿的內容發給客人）。也 ⛔ 不只限自己：正式庫裡被拿來試打的
    推播，36 人次有 29 次是發給不在後台的看稿同事，4 則一次發 3–5 人。
    「怎麼送」由用的那頁給（`send`）：推播要先存草稿再送存好的那份；模組送畫面上那份、⛔ 不存（存了就上線了）。
  -->
  <el-dialog v-model="visible" class="bc-dialog-testsend" :title="title" width="min(480px, 92vw)">
    <div class="admin-field-stack">
      <div class="admin-field-group">
        <AdminFieldLabel text="要發給誰（可以勾好幾位）" tight />
        <div v-if="listLoading" class="tags-loading">
          <div class="spinner" />
          <span>載入中…</span>
        </div>
        <p v-else-if="listError" class="bc-dialog-footer__error">{{ listError }}</p>
        <template v-else-if="list">
          <!-- 自己還沒把手機加進來：就地加（加一次，之後直接勾自己） -->
          <div v-if="!list.self && list.selfIsMember" class="bc-testsend-bind">
            <template v-if="!binding">
              <p class="bc-testsend-bind__text">你的手機還沒加進來。加一次，之後直接勾自己就好。</p>
              <el-button size="small" type="primary" plain @click="binding = true">把我的手機加進來</el-button>
              <!-- ⚠️ 綁好＝也加進通知名單（`D-103` 的規則）：先講，不要讓他之後被通知嚇到 -->
              <p class="text-xs text-muted">加進來之後也會收到「客人要找真人」的通知，不想收可以到「設定 → LINE 通知」關掉。</p>
            </template>
            <AdminLineNotifySelfAdd v-else @done="onSelfBound" @cancel="binding = false" />
          </div>

          <el-checkbox-group v-model="pickedIds" class="bc-testsend-list">
            <div v-if="list.self" class="bc-testsend-group">
              <p class="bc-testsend-group__title">你自己</p>
              <el-checkbox :value="list.self.lineUserId" class="bc-testsend-row">
                <span class="bc-testsend-who">
                  <img v-if="list.self.pictureUrl" :src="list.self.pictureUrl" class="bc-testsend-avatar" alt="">
                  <span v-else class="bc-testsend-avatar bc-testsend-avatar--initial">{{ initialOf(list.self.displayName) }}</span>
                  {{ list.self.displayName || '你的手機' }}
                </span>
              </el-checkbox>
            </div>

            <div v-if="list.members.length" class="bc-testsend-group">
              <p class="bc-testsend-group__title">同事</p>
              <el-checkbox v-for="m in list.members" :key="m.lineUserId" :value="m.lineUserId" class="bc-testsend-row">
                <span class="bc-testsend-who">
                  <img v-if="m.pictureUrl" :src="m.pictureUrl" class="bc-testsend-avatar" alt="">
                  <span v-else class="bc-testsend-avatar bc-testsend-avatar--initial">{{ initialOf(m.displayName) }}</span>
                  {{ m.displayName || m.email }}
                  <span v-if="m.email && m.displayName" class="bc-testsend-sub">{{ m.email }}</span>
                </span>
              </el-checkbox>
            </div>

            <div class="bc-testsend-group">
              <p class="bc-testsend-group__title">常找來看稿的人</p>
              <div v-for="s in list.saved" :key="s.lineUserId" class="bc-testsend-saved">
                <!-- 封鎖了／不是好友了：照樣列出來（⛔ 不安靜地拿掉），不給勾、講原因 -->
                <el-checkbox :value="s.lineUserId" :disabled="Boolean(s.unreachable)" class="bc-testsend-row">
                  <span class="bc-testsend-who">
                    <img v-if="s.pictureUrl" :src="s.pictureUrl" class="bc-testsend-avatar" alt="">
                    <span v-else class="bc-testsend-avatar bc-testsend-avatar--initial">{{ initialOf(s.displayName) }}</span>
                    {{ s.displayName || '（沒有名字）' }}
                    <span v-if="s.unreachable" class="bc-testsend-sub">{{ s.unreachable === 'blocked' ? '封鎖了官方帳號，收不到' : '已經不是好友，收不到' }}</span>
                  </span>
                </el-checkbox>
                <el-button v-if="can('broadcast.testList')" text size="small" class="bc-testsend-remove" @click="removeRecipient(s)">拿掉</el-button>
              </div>
              <p v-if="!list.saved.length" class="text-xs text-muted">
                還沒有。主管、要看稿的同事不在後台的話，<template v-if="can('broadcast.testList')">從下面加一次就一直在。</template><template v-else>請管理員在這裡加一次。</template>
              </p>
            </div>
          </el-checkbox-group>

          <!-- 加人：管理員才看得到（`broadcast.testList`）。這是唯一還要在全部好友裡找名字的地方，所以秀頭像與加好友日期分同名 -->
          <el-select
            v-if="can('broadcast.testList')"
            v-model="addPick"
            filterable
            remote
            :remote-method="searchFriends"
            :loading="friendsLoading"
            :loading-text="'找好友中…'"
            :no-data-text="'打名字找好友'"
            placeholder="＋ 加一位常找來看稿的人（打名字找好友）"
            class="bc-testsend-add"
            @change="addRecipient"
          >
            <el-option v-for="u in friends" :key="u.lineUserId" :label="u.displayName || u.lineUserId" :value="u.lineUserId">
              <span class="bc-testsend-who">
                <img v-if="u.pictureUrl" :src="u.pictureUrl" class="bc-testsend-avatar" alt="">
                <span v-else class="bc-testsend-avatar bc-testsend-avatar--initial">{{ initialOf(u.displayName) }}</span>
                {{ u.displayName || u.lineUserId }}
                <span v-if="u.joined" class="bc-testsend-sub">{{ u.joined }} 加好友</span>
              </span>
            </el-option>
          </el-select>
        </template>
      </div>

      <!-- 送什麼、會不會影響帳：由用的那頁講（⛔ 三件事一定要講：真的會送到、內容跟正式的一樣、不影響任何帳） -->
      <slot name="hint" />

      <div v-if="done" class="bc-testsend-done">
        每人送了 {{ done.messageCount }} 則給
        <b>{{ okNames }}</b>{{ done.moduleName ? `（機器人模組「${done.moduleName}」的內容）` : '' }}。
        {{ doneTail }}
        <!-- ⛔ 有人沒送到要講出是誰、為什麼（一位失敗不可以被「已送出」蓋過去） -->
        <p v-for="s in failed" :key="s.lineUserId" class="bc-testsend-failed">
          沒送到「{{ s.displayName || s.lineUserId }}」：{{ s.error }}
        </p>
      </div>
      <p v-if="error" class="bc-dialog-footer__error">{{ error }}</p>
    </div>
    <template #footer>
      <div class="bc-dialog-footer__actions">
        <el-button @click="visible = false">關閉</el-button>
        <el-button type="primary" :loading="sending" @click="submit">{{ submitLabel }}</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { parseFirestoreDate } from '~~/shared/firestore-date'

interface TestRecipient { lineUserId: string; displayName: string; pictureUrl: string; email?: string; unreachable?: 'blocked' | 'gone' }
interface TestRecipientList { selfIsMember: boolean; self: TestRecipient | null; members: TestRecipient[]; saved: TestRecipient[] }
interface TestSendResult { lineUserId: string; displayName: string; ok: boolean; error?: string }
interface TestSendResponse { messageCount: number; moduleName?: string; sent: TestSendResult[] }

const props = withDefaults(defineProps<{
  modelValue: boolean
  title: string
  /**
   * 真的送出去。回傳字串＝沒送、把這句講給人聽（例如推播草稿沒存成功）；
   * 丟錯的話照 API 的 statusMessage 講。
   */
  send: (lineUserIds: string[]) => Promise<TestSendResponse | string>
  submitLabel?: string
  /** 送完那句的後半 */
  doneTail?: string
}>(), {
  submitLabel: '送出試發',
  doneTail: '去手機上看一眼，沒問題再回來發。',
})
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const visible = computed({
  get: () => props.modelValue,
  set: v => emit('update:modelValue', v),
})

const { workspaceId, apiFetch } = useWorkspace()
const { can } = useAdminOperateGuard()
const { showToast } = useAdminToast()

const sending = ref(false)
const error = ref('')
const done = ref<TestSendResponse | null>(null)
const okNames = computed(() =>
  (done.value?.sent ?? []).filter(s => s.ok).map(s => s.displayName || s.lineUserId).join('、'))
const failed = computed(() => (done.value?.sent ?? []).filter(s => !s.ok))

const list = ref<TestRecipientList | null>(null)
const listLoading = ref(false)
const listError = ref('')
/** 勾了誰 */
const pickedIds = ref<string[]>([])
/** 正在就地把自己的手機加進來（掃 QR） */
const binding = ref(false)
/** 「加一位常找來看稿的人」選單 */
const addPick = ref('')
const friends = ref<Array<{ lineUserId: string; displayName: string; pictureUrl: string; joined: string }>>([])
const friendsLoading = ref(false)

/**
 * 記住上次勾了誰（`D-119` 起是一組人，鍵換新的：舊鍵存的是單一 ID，⛔ 不沿用）。
 * 推播跟模組共用同一把：看稿的是同一群人。
 * ⚠️ 讀回來要先跟名單交集：上次勾的人可能被拿掉了，⛔ 不可以帶著名單外的人送出去（伺服器也會擋）。
 */
const LS_KEY = computed(() => `bc-test-send-to-v2:${workspaceId.value}`)

function initialOf(name: string) {
  return (name || '?').trim().slice(0, 1).toUpperCase()
}

/** 名單上勾得了的人（封鎖了、不是好友了的不算） */
function sendableIds(l: TestRecipientList): string[] {
  return [
    ...(l.self ? [l.self.lineUserId] : []),
    ...l.members.map(m => m.lineUserId),
    ...l.saved.filter(s => !s.unreachable).map(s => s.lineUserId),
  ]
}

async function loadList(opts: { keepPicked?: boolean } = {}) {
  listLoading.value = !list.value
  listError.value = ''
  try {
    const l = await apiFetch<TestRecipientList>('/api/broadcast/test-recipients')
    list.value = l
    const ok = new Set(sendableIds(l))
    if (opts.keepPicked) {
      pickedIds.value = pickedIds.value.filter(id => ok.has(id))
      return
    }
    let remembered: string[] = []
    try { remembered = JSON.parse(localStorage.getItem(LS_KEY.value) || '[]') }
    catch { /* 無痕視窗讀不到就算了，只是少一個方便 */ }
    const picked = (Array.isArray(remembered) ? remembered : []).map(String).filter(id => ok.has(id))
    // 沒記到就預設勾自己（按鈕寫的就是「給自己看」）
    pickedIds.value = picked.length ? picked : (l.self ? [l.self.lineUserId] : [])
  }
  catch (e: any) {
    listError.value = e?.data?.statusMessage || '讀不到試發名單，請關掉再打開一次'
  }
  finally {
    listLoading.value = false
  }
}

/** 就地把自己的手機加進來之後：重抓名單、把自己勾起來 */
async function onSelfBound() {
  binding.value = false
  await loadList({ keepPicked: true })
  const self = list.value?.self
  if (self && !pickedIds.value.includes(self.lineUserId)) pickedIds.value = [self.lineUserId, ...pickedIds.value]
}

/** 加人用的找好友（只有管理員看得到那個選單）：打了字才找，⛔ 不先把全部好友列出來 */
async function searchFriends(keyword?: string) {
  const kw = String(keyword || '').trim()
  if (!kw) { friends.value = []; return }
  friendsLoading.value = true
  try {
    const params = new URLSearchParams({ limit: '20', search: kw })
    const res = await apiFetch<{ users?: Array<{ lineUserId?: string; displayName?: string; pictureUrl?: string; createdAt?: unknown }> }>(`/api/users/list?${params.toString()}`)
    const listed = new Set(list.value ? [
      ...(list.value.self ? [list.value.self.lineUserId] : []),
      ...list.value.members.map(m => m.lineUserId),
      ...list.value.saved.map(s => s.lineUserId),
    ] : [])
    friends.value = (res?.users ?? [])
      .map((u) => {
        const d = parseFirestoreDate(u.createdAt)
        return {
          lineUserId: String(u.lineUserId || ''),
          displayName: String(u.displayName || ''),
          pictureUrl: String(u.pictureUrl || ''),
          // 同名的人靠「哪天加好友」分（叫 Alice 的有 5 位）
          joined: d ? `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}` : '',
        }
      })
      .filter(u => u.lineUserId && !listed.has(u.lineUserId))
  }
  catch {
    friends.value = []
  }
  finally {
    friendsLoading.value = false
  }
}

async function addRecipient(lineUserId: string) {
  addPick.value = ''
  if (!lineUserId) return
  try {
    const res = await apiFetch<{ displayName: string }>('/api/broadcast/test-recipients', { method: 'POST', body: { lineUserId } })
    await loadList({ keepPicked: true })
    // 剛加的那位通常就是這次要發的人：直接勾起來
    if (!pickedIds.value.includes(lineUserId)) pickedIds.value = [...pickedIds.value, lineUserId]
    showToast(`已把「${res.displayName || '這位'}」加進常找來看稿的人`, 'success')
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '加不進去，請再試一次', 'error')
  }
}

async function removeRecipient(s: TestRecipient) {
  try {
    await apiFetch(`/api/broadcast/test-recipients/${encodeURIComponent(s.lineUserId)}`, { method: 'DELETE' })
    await loadList({ keepPicked: true })
    showToast(`已從常找來看稿的人拿掉「${s.displayName || '這位'}」`, 'success')
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '拿不掉，請再試一次', 'error')
  }
}

// 每次打開：清掉上一次的結果、重抓名單
watch(() => props.modelValue, (open) => {
  if (!open) return
  error.value = ''
  done.value = null
  binding.value = false
  void loadList()
})

async function submit() {
  const to = [...pickedIds.value]
  error.value = ''
  done.value = null
  if (!to.length) {
    error.value = list.value?.self || list.value?.members.length || list.value?.saved.length
      ? '請至少勾一位'
      : '名單上還沒有人：先把你的手機加進來，或請管理員加常找來看稿的人'
    return
  }
  sending.value = true
  try {
    const res = await props.send(to)
    if (typeof res === 'string') {
      error.value = res
      return
    }
    done.value = res
    try { localStorage.setItem(LS_KEY.value, JSON.stringify(to)) }
    catch { /* 存不進去只是下次要重勾 */ }
  }
  catch (e: any) {
    error.value = e?.data?.statusMessage || '試發失敗，請稍後再試'
  }
  finally {
    sending.value = false
  }
}
</script>
