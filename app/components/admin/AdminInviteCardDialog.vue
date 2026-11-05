<template>
  <!--
    加好友邀請卡（`C-458`／`D-169`，John 哥 2026-11-04「第一杯冰沙」）：A4 桌牌＋分享圖。
    預覽就是要下載／列印的那一張 PNG（畫法與理由見 `utils/invite-card.ts`）。
    第一版不做 Email 邀請：名單是店家貼來的、客人沒同意收信，寄了容易被當垃圾信，連我們寄收據的信箱一起被擋。
  -->
  <el-dialog v-model="visible" class="invite-card-dialog" title="邀請卡" width="min(760px, 94vw)" append-to-body>
    <p class="invite-card__intro">
      客人掃上面的 QR，就會加入你的 LINE 官方帳號好友。<strong>桌牌</strong>印出來擺在櫃台或門口；
      <strong>分享圖</strong>存起來貼到 FB、IG，或直接傳給客人。
    </p>

    <div v-if="loading" class="tags-loading">
      <div class="spinner" />
      <span>正在做你的邀請卡…</span>
    </div>
    <p v-else-if="error" class="invite-card__notice is-error">{{ error }}</p>
    <p v-else-if="invite && !invite.basicId" class="invite-card__notice">
      還沒接上 LINE 官方帳號，所以還沒有你的加好友 QR。接上之後回到這裡就有。
    </p>
    <template v-else-if="invite">
      <!-- `C-468`：生日這一行三種樣子（理由見 script 的 bdMode）。⛔ 鈕不用主色：這個框的主要動作是「列印」 -->
      <div v-if="bdMode" :class="['invite-card__bday', { 'is-warn': bdMode === 'warn' }]" data-invite="birthday" :data-mode="bdMode">
        <template v-if="bdMode === 'ask'">
          <span class="invite-card__bday-text">🎂 <b>掃 QR 加好友的人，要不要順便問生日？</b>打開之後加好友的，才會被問到。</span>
          <el-button size="small" :loading="bdSaving" @click="turnOnBirthday">打開</el-button>
        </template>
        <span v-else-if="bdMode === 'done'" class="invite-card__bday-text">✓ <b>打開了</b>：之後加好友的人都會被問生日。想在生日當月送點什麼，到「生日」寫上去。</span>
        <!-- 開著卻附不上：他以為客人會被問、其實不會——正要讓一批人加好友的這一刻講他的狀況與去哪改 -->
        <span v-else-if="bdBlock" class="invite-card__bday-text">{{ birthdayAppendWarning(bdBlock) }}</span>
      </div>
      <div class="invite-card__grid">
        <section class="invite-card__item" data-invite="a4">
          <div class="invite-card__head">
            <b>A4 桌牌</b>
            <span>印出來擺櫃台、門口，放進小立牌剛好</span>
          </div>
          <div class="invite-card__preview">
            <img v-if="urls.a4" :src="urls.a4" alt="A4 桌牌預覽">
          </div>
          <div class="invite-card__actions">
            <el-button type="primary" size="small" :disabled="!urls.a4" @click="printA4">列印</el-button>
            <el-button size="small" :disabled="!urls.a4" @click="download('a4')">下載圖片</el-button>
          </div>
        </section>
        <section class="invite-card__item" data-invite="share">
          <div class="invite-card__head">
            <b>分享圖</b>
            <span>貼到 FB、IG，或傳給客人</span>
          </div>
          <div class="invite-card__preview">
            <img v-if="urls.share" :src="urls.share" alt="分享圖預覽">
          </div>
          <div class="invite-card__actions">
            <el-button size="small" :disabled="!urls.share" @click="download('share')">下載圖片</el-button>
          </div>
        </section>
      </div>
      <p v-if="drawError" class="invite-card__notice is-error">{{ drawError }}</p>

      <div class="invite-card__link">
        <span class="invite-card__link-label">加好友連結</span>
        <code class="invite-card__link-val">{{ invite.addFriendUrl }}</code>
        <el-button size="small" @click="copyLink">複製</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import {
  drawInviteCard,
  INVITE_CARD_SIZE,
  inviteFileName,
  printA4Image,
  qrMatrixFrom,
  type InviteCardKind,
} from '~/utils/invite-card'
import { birthdayAppendWarning, type BirthdayAppendBlock, type BirthdaySettings } from '~~/shared/birthday'
import { apiErrorText } from '~/utils/api-error-text'
import { enableBirthday, readBirthdayAppendBlock, readBirthdaySettings } from '~/utils/birthday-settings'

interface OaInvite {
  basicId: string
  addFriendUrl: string
  displayName: string
  pictureUrl: string
  pictureDataUrl?: string
}

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const visible = computed({
  get: () => props.modelValue,
  set: v => emit('update:modelValue', v),
})

const { workspaceId, apiFetch } = useWorkspace()
const { showToast } = useAdminToast()
const { can } = useAdminOperateGuard()

const invite = ref<OaInvite | null>(null)
const loading = ref(false)
const error = ref('')
const drawError = ref('')
const urls = reactive<Record<InviteCardKind, string>>({ a4: '', share: '' })
/** 這兩張是哪個帳號的（換帳號要重做；同一個帳號、上次兩張都畫成功，開第二次才不重抓） */
let madeFor = ''

/**
 * `C-468`（示意頁 v88，老闆 2026-11-05「好 執行」）：**生日還沒打開**才在說明下面多一行「要不要順便問生日」。
 * 為什麼在這裡：做邀請卡＝正要讓一批人加好友，而問生日只發生在加好友那一刻——錯過了就問不回來
 *   （免費方案不能推播，「問生日」模組只剩圖文選單一條路）。接 LINE 那一趟按了「先不要」的、沒走過那一趟的老店都會經過這裡。
 * ⛔ 讀不到設定、不能改設定（存檔打的是 `ai.settings.write`，同「生日」框）就不出現：⛔ 不問一件不知道現況、或按了會被擋的事。
 * ⛔ 打開了就不再出現；剛按的那一次當場改成一句確認（他要看得到「打開了」跟「生日禮在哪補」），下次開框就沒有了。
 */
const bdCurrent = ref<BirthdaySettings | null>(null)
/** 他的歡迎訊息現在附不附得上生日卡（null＝附得上或不知道） */
const bdBlock = ref<BirthdayAppendBlock | null>(null)
const bdJustOn = ref(false)
const bdSaving = ref(false)
/*
 * code review 第 11 條：以前第一個條件是 `!!invite.value?.basicId`——那一段永遠成立
 * （這一行長在 `v-else-if="invite"` 裡面，上面那條 `v-else-if="invite && !invite.basicId"`
 * 已經把沒有 basicId 的情況接走了），而測試又把這個寫法當字串釘死，
 * 於是「多餘的條件」反過來變成不能動的東西。拿掉，測試改釘行為。
 *
 * `C-468` 後續（老闆 2026-11-05「按你的建議執行」）：**只有他的歡迎訊息真的附不上才講**——
 * - `ask`：沒開、附得上 → 問要不要打開
 * - `done`：剛按了打開 → 一句確認（⛔ 不再對每個人念「什麼情況不附」）
 * - `warn`：開著、但附不上 → 講他的狀況與去哪改（他以為客人會被問，其實不會）
 * - 沒開、附不上 → ⛔ 不出現：不問一件按了也沒用的事
 */
const bdMode = computed<'ask' | 'done' | 'warn' | null>(() => {
  if (bdJustOn.value) return 'done'
  const cur = bdCurrent.value
  if (!cur) return null
  if (!cur.enabled) return bdBlock.value ? null : 'ask'
  return bdBlock.value ? 'warn' : null
})

/**
 * 開框、存檔各算一代（code review 第 10 條）：按了「打開」之後馬上關掉再打開，
 * 舊的那一筆回來會把新開的框改成「✓ 打開了」——那是上一次點擊的結果，跑到這一次的畫面上。
 * 兩次快速開關也會讓兩個讀取互相蓋。比對代號，被取代的那一筆就丟掉。
 */
let bdGen = 0

async function loadBirthday() {
  const gen = ++bdGen
  bdJustOn.value = false
  bdCurrent.value = null
  bdBlock.value = null
  if (!can('ai.settings.write')) return
  // 讀不到回 null＝這一行不出現（⛔ 不問一件不知道現況的事）；附不附得上讀不到＝當作附得上（⛔ 不知道就不警告）
  const [current, block] = await Promise.all([readBirthdaySettings(apiFetch), readBirthdayAppendBlock(apiFetch)])
  if (gen !== bdGen) return
  bdBlock.value = block
  bdCurrent.value = current
}

async function turnOnBirthday() {
  if (!bdCurrent.value || bdSaving.value) return
  bdSaving.value = true
  const gen = ++bdGen
  try {
    // ⛔ **只送 `enabled`**（code review 第 3 條）：伺服器本來就是深合併
    //   （`ai-settings.ts` 的 `birthday: { ...current.birthday, ...partial.birthday }`），
    //   把開框當下讀到的生日禮一起送回去反而會蓋掉——他在「生日」框或另一個分頁剛寫好的禮物
    //   會被洗成空白，客人收到的卡片與回覆從此不再提那個禮物，而且沒有任何提示。
    await enableBirthday(apiFetch)
    // ⚠️ 存檔途中有人把框關掉又打開＝已經重讀過一次了，這一筆的結果不可以再蓋回去（第 10 條）
    if (gen !== bdGen) return
    bdCurrent.value = { ...bdCurrent.value, enabled: true }
    bdJustOn.value = true
  }
  catch (e: unknown) {
    // ⛔ 不要自己撈 statusMessage：`apiErrorText` 多做兩件事——補 `data.message`、把英文的
    //   開發訊息濾掉改用中文（當初就是因為 23 個地方各寫一份才收斂成這支）。第 6 條。
    showToast(apiErrorText(e, '沒有打開成功，再按一次試試'), 'error')
  }
  finally {
    bdSaving.value = false
  }
}

watch(visible, (v) => {
  if (!v) return
  void load()
  // ⚠️ 不跟著 load() 的「畫過就不重抓」：生日可能剛在「生日」框或別的地方改過，每次開框都重看
  void loadBirthday()
}, { immediate: true })

async function load() {
  const wid = workspaceId.value
  // 只有上次**兩張都畫成功**才不重做（code review 第 15 條）：還沒接 LINE、畫失敗的那一次，
  // 框裡講「接上之後回到這裡就有」——不重抓的話，接好 LINE 回來打開還是空的，要整頁重新整理才有
  if (!wid || (madeFor === wid && invite.value?.basicId && urls.a4 && urls.share)) return
  loading.value = true
  error.value = ''
  drawError.value = ''
  urls.a4 = ''
  urls.share = ''
  try {
    const r = await apiFetch<OaInvite>('/api/admin/onboarding/oa-invite', { query: { avatar: '1' } })
    invite.value = r
    madeFor = wid
    if (r.basicId) await draw(r)
  }
  catch {
    invite.value = null
    error.value = '讀不到你的 LINE 官方帳號資料，等一下再打開一次試試。'
  }
  finally {
    loading.value = false
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

async function draw(r: OaInvite) {
  try {
    // 只有打開這個框才載 QR 套件（後台其他頁用不到）
    const mod: any = await import('qrcode')
    const create = (mod.create ?? mod.default?.create) as (text: string, opts: { errorCorrectionLevel: 'M' }) => { modules: { size: number, get: (r: number, c: number) => number | boolean } }
    const qr = qrMatrixFrom(create(r.addFriendUrl, { errorCorrectionLevel: 'M' }))
    // 頭像載不到就畫名字第一個字（⛔ 不讓頭像擋掉整張卡）
    const avatar = r.pictureDataUrl ? await loadImage(r.pictureDataUrl).catch(() => null) : null
    for (const kind of ['a4', 'share'] as const) {
      const { w, h } = INVITE_CARD_SIZE[kind]
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('canvas')
      drawInviteCard(ctx, kind, { name: r.displayName || r.basicId, basicId: r.basicId, avatar }, qr)
      urls[kind] = canvas.toDataURL('image/png')
    }
  }
  catch {
    drawError.value = '這個瀏覽器畫不出邀請卡。下面的加好友連結一樣可以用，換一個瀏覽器（Chrome、Safari）再試一次。'
  }
}

function download(kind: InviteCardKind) {
  if (!urls[kind]) return
  const a = document.createElement('a')
  a.href = urls[kind]
  a.download = inviteFileName(kind, invite.value?.displayName || invite.value?.basicId || '')
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function printA4() {
  if (urls.a4) printA4Image(urls.a4)
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(invite.value?.addFriendUrl || '')
    showToast('已複製加好友連結', 'success')
  }
  catch {
    showToast('這個瀏覽器不讓我複製，請手動選取', 'warning')
  }
}
</script>
