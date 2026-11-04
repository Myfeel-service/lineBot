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

const invite = ref<OaInvite | null>(null)
const loading = ref(false)
const error = ref('')
const drawError = ref('')
const urls = reactive<Record<InviteCardKind, string>>({ a4: '', share: '' })
/** 這兩張是哪個帳號的（換帳號要重做，同一個帳號開第二次不重抓） */
let madeFor = ''

watch(visible, (v) => {
  if (v) void load()
}, { immediate: true })

async function load() {
  const wid = workspaceId.value
  if (!wid || (madeFor === wid && invite.value)) return
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
