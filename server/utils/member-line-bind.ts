/**
 * 成員 ↔ LINE 綁定。
 *
 * 為什麼需要：轉真人通知是「用官方帳號推播給客服人員」，但後台成員（workspaceMembers）
 * 只有 Firebase uid + email，跟 LINE 身分沒有任何關聯欄位——所以以前只能到幾千位客人裡
 * 用暱稱猜、或手抄 U 開頭的 userId。
 *
 * 流程：後台為某位成員產一次性綁定碼 → 該成員用自己的 LINE 傳「綁定 XXXXXX」給官方帳號
 * → webhook 認碼，把 lineUserId 寫回該成員。
 *
 * ⚠️ 2026-09-27 更正（`D-103` 待查證）：原本這裡寫「碼傳得進來＝對方確實已加好友」，這個前提
 *    **沒有查證過**——LINE 允許還不是好友的人從「訊息已打好」的連結傳訊息進來也說不定。
 *    所以現在：①讀不到他的 LINE 個人資料（LINE 只給已加好友的人）就在回覆裡附加好友連結；
 *    ②每次推播的成敗都記下來（`line-notify-delivery.ts`），推不出去那一列會變黃、講原因。
 *
 * 綁好＝加進通知名單，並回一則「之後會收到什麼、第一則幾點」（`D-103`①②）。
 */
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import { getUserProfile, replyMessage } from './line'
import { resolveLineOaBasicId } from './line-oa-basic-id'
import { AI_SETTINGS_COLLECTION, getAiSettings, invalidateAiSettingsCache } from './ai-settings'
import { recordNotifyDelivery } from './line-notify-delivery'
import { buildNotifyConfirmText, type NotifyConfirmResult } from '~~/shared/line-notify-messages'

/** 去掉易混淆字元（0/O、1/I/L）的字母數字表 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6
export const MEMBER_BIND_CODE_TTL_MS = 10 * 60 * 1000

/**
 * 綁定訊息格式：`綁定 A3F9K2`（也接受 bind / 全形冒號 / 沒空格）。
 * 一定要有前綴——只認 6 碼會把客人隨口打的字誤判成綁定嘗試。
 */
const BIND_TEXT_RE = new RegExp(`^\\s*(?:綁定|bind)\\s*[-:：]?\\s*([A-Za-z0-9]{${CODE_LENGTH}})\\s*$`, 'i')

/** 後台顯示給成員照抄的整串訊息 */
export function buildBindCodeMessage(code: string): string {
  return `綁定 ${code}`
}

/** 從來訊解析綁定碼（大寫）；不是綁定訊息回 null。純函式，方便測誤判 */
export function parseMemberBindCode(text: string): string | null {
  const match = BIND_TEXT_RE.exec(String(text ?? ''))
  return match?.[1] ? match[1].toUpperCase() : null
}

/**
 * 一鍵綁定連結：點開直接是與此官方帳號的聊天室，且訊息已預先填好，成員只要按送出。
 * 用 LINE URL scheme `line.me/R/oaMessage/{@basicId}/?{text}`（ID 與內文都要 percent-encode）。
 * 拿不到 basicId（憑證沒設／API 掛掉）時回空字串，UI 退回「複製那行字自己貼」。
 */
export function buildBindDeepLink(basicId: string, code: string): string {
  const id = String(basicId || '').trim()
  if (!id) return ''
  return `https://line.me/R/oaMessage/${encodeURIComponent(id)}/?${encodeURIComponent(buildBindCodeMessage(code))}`
}

/** 加好友連結（綁定成功卻讀不到他的 LINE 資料時附在回覆裡）；拿不到 ID 回空字串 */
export function buildAddFriendUrl(basicId: string): string {
  const id = String(basicId || '').trim()
  return id ? `https://line.me/R/ti/p/${encodeURIComponent(id)}` : ''
}

function randomCode(): string {
  let out = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  }
  return out
}

export function memberDocId(uid: string, workspaceId: string): string {
  return `${uid}_${workspaceId}`
}

/**
 * 為成員產生（或重發）一次性綁定碼。舊碼直接被覆蓋，同一位成員永遠只有一組有效碼。
 */
export async function issueMemberLineBindCode(
  workspaceId: string,
  uid: string,
): Promise<{ code: string; expiresAt: number; message: string; bindUrl: string }> {
  const db = getDb()
  const ref = db.collection('workspaceMembers').doc(memberDocId(uid, workspaceId))
  const snap = await ref.get()
  if (!snap.exists) {
    throw createError({ statusCode: 404, statusMessage: '找不到此成員' })
  }

  // 同一工作區內碼不重複（成員數量以十計，讀全量在記憶體比對即可，免建複合索引）
  const all = await db.collection('workspaceMembers').where('workspaceId', '==', workspaceId).get()
  const taken = new Set(
    all.docs
      .filter(d => d.id !== ref.id && Number(d.data().lineBindCodeExpiresAt ?? 0) > Date.now())
      .map(d => String(d.data().lineBindCode ?? '')),
  )
  let code = randomCode()
  for (let i = 0; i < 20 && taken.has(code); i++) code = randomCode()

  const expiresAt = Date.now() + MEMBER_BIND_CODE_TTL_MS
  const [, basicId] = await Promise.all([
    ref.update({ lineBindCode: code, lineBindCodeExpiresAt: expiresAt }),
    resolveLineOaBasicId(workspaceId).catch(() => ''),
  ])

  return {
    code,
    expiresAt,
    message: buildBindCodeMessage(code),
    bindUrl: buildBindDeepLink(basicId, code),
  }
}

/**
 * webhook 文字訊息入口：看起來像綁定碼就消化掉並回傳 true（呼叫端直接 return，
 * 不再進自動回覆／AI）。不像綁定碼時只做一次 regex，熱路徑零額外讀取。
 */
export async function tryConsumeMemberLineBindCode(params: {
  lineUserId: string
  text: string
  workspaceId: string
  replyToken?: string
}): Promise<boolean> {
  const code = parseMemberBindCode(params.text)
  if (!code) return false

  /** 回傳有沒有真的回出去（綁定成功那則要記成「送到了」，`C-270`⑥） */
  const reply = async (text: string): Promise<boolean> => {
    if (!params.replyToken) return false
    return replyMessage(params.replyToken, [{ type: 'text', text }], params.workspaceId)
      .then(() => true)
      .catch((e) => {
        console.error('[member-bind] reply failed:', e)
        return false
      })
  }

  try {
    const db = getDb()
    const snap = await db.collection('workspaceMembers')
      .where('workspaceId', '==', params.workspaceId)
      .get()

    const target = snap.docs.find(d => String(d.data().lineBindCode ?? '').toUpperCase() === code)
    if (!target) {
      await reply('❌ 綁定碼不正確,請向管理員確認後重新輸入。')
      return true
    }
    if (Number(target.data().lineBindCodeExpiresAt ?? 0) < Date.now()) {
      // 2026-09-27 `C-270`：綁定搬到「設定 → LINE 通知」（自己掃 QR 或管理員「改傳連結」都在那一頁）
      await reply('❌ 這組綁定碼已過期，請到後台「設定 → LINE 通知」重新產生一組。')
      return true
    }

    // 同一個 LINE 帳號不能同時掛在兩位成員上——否則通知名單會出現兩筆相同 userId,
    // 而且移除其中一位不會停止通知。舊的那筆先解除。
    const conflicts = snap.docs.filter(
      d => d.id !== target.id && String(d.data().lineUserId ?? '') === params.lineUserId,
    )
    /** 他原本綁的那支（換手機）：跟「是我」那條同一個規矩，舊那支要從通知名單拿掉 */
    const previous = String(target.data().lineUserId ?? '').trim()

    // ⚠️ LINE 只給「已加好友」的人的個人資料；讀不到＝**可能**還不是好友（也可能一時讀不到）
    const profile = await getUserProfile(params.lineUserId, params.workspaceId).catch(() => null)
    const batch = db.batch()
    batch.update(target.ref, {
      lineUserId: params.lineUserId,
      lineDisplayName: profile?.displayName ?? null,
      linePictureUrl: profile?.pictureUrl ?? null,
      lineBoundAt: FieldValue.serverTimestamp(),
      lineBindCode: FieldValue.delete(),
      lineBindCodeExpiresAt: FieldValue.delete(),
    })
    for (const c of conflicts) {
      batch.update(c.ref, {
        lineUserId: FieldValue.delete(),
        lineDisplayName: FieldValue.delete(),
        linePictureUrl: FieldValue.delete(),
        lineBoundAt: FieldValue.delete(),
      })
    }
    await batch.commit()
    if (previous && previous !== params.lineUserId) await removeFromHandoffNotify(params.workspaceId, previous)

    // `D-103`①：綁好＝加進通知名單（原本回覆還叫人自己去 AI 設定勾，兩頁各做一次）
    const result: NotifyConfirmResult = await addToHandoffNotify(
      params.workspaceId,
      params.lineUserId,
      profile?.displayName ?? '',
    )
    // `D-103`②：當場告訴他之後會收到什麼、第一則幾點——原本綁完到第一則之間沒有任何回音
    const [settings, basicId] = await Promise.all([
      getAiSettings(params.workspaceId).catch(() => null),
      profile ? Promise.resolve('') : resolveLineOaBasicId(params.workspaceId).catch(() => ''),
    ])
    const text = settings
      ? buildNotifyConfirmText({
          result,
          cfg: settings.handoffNotify,
          serviceHours: settings.serviceHours,
          nowMs: Date.now(),
          friendUnknown: !profile,
          addFriendUrl: buildAddFriendUrl(basicId),
        })
      : '好了 ✓ 這支手機加進 LINE 通知了。到後台「設定 → LINE 通知」看得到之後會收到什麼。'
    const replied = await reply(text)
    // 綁定成功那則也算「送到了」：後台那一列才講得出「剛剛送達確認訊息」
    if (replied && (result === 'added' || result === 'already'))
      await recordNotifyDelivery(params.workspaceId, [{ lineUserId: params.lineUserId, ok: true, kind: 'confirm' }], db)
    return true
  }
  catch (e) {
    console.error('[member-bind] consume failed:', e)
    await reply('⚠️ 綁定時發生錯誤,請稍後再試。')
    return true
  }
}

/**
 * 解除綁定。順手把該 lineUserId 從轉真人通知名單移除——不然人走了通知還一直推,
 * 而且後台看到的名單會有一筆對不上任何成員的 Uxxx。
 */
export async function unbindMemberLine(workspaceId: string, uid: string): Promise<void> {
  const db = getDb()
  const ref = db.collection('workspaceMembers').doc(memberDocId(uid, workspaceId))
  const snap = await ref.get()
  if (!snap.exists) throw createError({ statusCode: 404, statusMessage: '找不到此成員' })

  const lineUserId = String(snap.data()?.lineUserId ?? '').trim()
  await ref.update({
    lineUserId: FieldValue.delete(),
    lineDisplayName: FieldValue.delete(),
    linePictureUrl: FieldValue.delete(),
    lineBoundAt: FieldValue.delete(),
    lineBindCode: FieldValue.delete(),
    lineBindCodeExpiresAt: FieldValue.delete(),
  })
  if (lineUserId) await removeFromHandoffNotify(workspaceId, lineUserId)
}

/** 通知名單最多幾位（跟 normalizeAiSettings 的 slice(0,10) 同一個數字；超過會被靜靜切掉，所以這裡先擋） */
export const HANDOFF_NOTIFY_MAX = 10

/**
 * - `added`／`already`：在名單上＝真的會收到
 * - `full`：名單滿了沒加；`failed`：寫不進去
 *
 * ⚠️ 2026-09-27 `D-103` 拍板拿掉「總開關」（名單有人＝開），所以 2026-09-26 補的 `off`
 *    （「在名單上但通知被關著」）不會再出現：畫面上已經沒有能把它關成那樣的開關。
 */
export type AddToNotifyResult = NotifyConfirmResult

/**
 * 名單上**真的在收**的人。總開關拿掉之後，只有舊資料會出現「名單有人但 enabled=false」——
 * 那些人其實一則都沒收到（讀通知的每一處都先看 enabled），所以一律當成沒有人在收。
 */
export function effectiveNotifyIds(raw: { enabled?: unknown, lineUserIds?: unknown } | null | undefined): string[] {
  if (raw?.enabled !== true || !Array.isArray(raw.lineUserIds)) return []
  return raw.lineUserIds.map(v => String(v ?? '').trim()).filter(Boolean)
}

/**
 * 把某個 lineUserId 加進 aiSettings.handoffNotify 名單。三個入口共用：開帳按「是我」、
 * 綁定碼（成員自己掃 QR 或管理員傳連結）、「LINE 通知」頁把「收通知」打開。
 *
 * ⭐ 為什麼要有：綁定手機原本**不會**加進通知名單（綁定成功的回覆還叫他自己去加）——
 *    「客人要找你本人、早上的摘要會傳到這支手機」就只是一句沒人兌現的話。
 * ⚠️ 總開關拿掉之後（`D-103`）：加進來就一定打開。舊資料「名單有人但關著」＝那些人一則都沒收到，
 *    這次寫入以**真的在收的人**（`effectiveNotifyIds`）為底，⛔ 不把他們一起默默打開。
 * ⛔ 滿了就回 `full`、不擠掉別人（畫面要照實講「名單滿了」）。
 * ⚠️ 只更新名單那幾格：⛔ 不走整份覆寫 AI 設定的那條路。
 */
export async function addToHandoffNotify(workspaceId: string, lineUserId: string, displayName: string): Promise<AddToNotifyResult> {
  const id = String(lineUserId || '').trim()
  if (!id) return 'failed'
  try {
    const db = getDb()
    const ref = db.collection(AI_SETTINGS_COLLECTION).doc(workspaceId)
    // ⚠️ 交易：兩位同時加（或剛好有人在存設定）時，各讀一份再各寫 [...ids, 自己]
    //    會把對方蓋掉、兩邊卻都拿到 added（code review 抓到）
    const result = await db.runTransaction(async (tx): Promise<AddToNotifyResult> => {
      const snap = await tx.get(ref)
      const raw = snap.exists ? snap.data()?.handoffNotify : undefined
      const ids = effectiveNotifyIds(raw)
      // 舊資料可能存成 `${workspaceId}_U…` 主鍵形式，兩種都要比對得到
      if (ids.some(v => v === id || v.endsWith(`_${id}`))) return 'already'
      if (ids.length >= HANDOFF_NOTIFY_MAX) return 'full'
      const nextIds = [...ids, id]
      const prevNames: Record<string, string> = raw?.displayNames ?? {}
      const displayNames: Record<string, string> = {}
      for (const k of nextIds) if (prevNames[k]) displayNames[k] = prevNames[k]
      if (displayName) displayNames[id] = displayName.slice(0, 40)
      if (snap.exists) {
        tx.update(ref, {
          'handoffNotify.lineUserIds': nextIds,
          'handoffNotify.displayNames': displayNames,
          'handoffNotify.enabled': true,
        })
      }
      else {
        // 還沒有 AI 設定文件（新帳號）：只寫名單這一格，其餘由 normalizeAiSettings 讀的時候補預設
        tx.set(ref, { workspaceId, handoffNotify: { enabled: true, lineUserIds: nextIds, displayNames } }, { merge: true })
      }
      return 'added'
    })
    invalidateAiSettingsCache(workspaceId)
    return result
  }
  catch (e) {
    console.error('[member-bind] add to handoffNotify failed:', e)
    return 'failed'
  }
}

/**
 * 把一個 LINE 帳號綁到某位成員身上（跟綁定碼那條路同一套：同一個 LINE 不能掛兩位成員）。
 * 回傳有沒有真的綁上（沒有成員文件的人——組織管理員、超級管理員——綁不了，但通知名單照樣可以加）。
 */
export async function bindMemberLineUser(
  workspaceId: string,
  uid: string,
  profile: { lineUserId: string, displayName: string, pictureUrl: string },
): Promise<boolean> {
  const db = getDb()
  const ref = db.collection('workspaceMembers').doc(memberDocId(uid, workspaceId))
  const snap = await ref.get()
  if (!snap.exists) return false
  /** 他原本綁的那支（換手機綁定時，舊那支要從通知名單拿掉——跟解除綁定同一條規矩，code review 抓到） */
  const previous = String(snap.data()?.lineUserId ?? '').trim()
  const others = await db.collection('workspaceMembers')
    .where('workspaceId', '==', workspaceId)
    .where('lineUserId', '==', profile.lineUserId)
    .get()
  const batch = db.batch()
  batch.update(ref, {
    lineUserId: profile.lineUserId,
    lineDisplayName: profile.displayName || null,
    linePictureUrl: profile.pictureUrl || null,
    lineBoundAt: FieldValue.serverTimestamp(),
    lineBindCode: FieldValue.delete(),
    lineBindCodeExpiresAt: FieldValue.delete(),
  })
  for (const d of others.docs) {
    if (d.id === ref.id) continue
    batch.update(d.ref, {
      lineUserId: FieldValue.delete(),
      lineDisplayName: FieldValue.delete(),
      linePictureUrl: FieldValue.delete(),
      lineBoundAt: FieldValue.delete(),
    })
  }
  await batch.commit()
  // ⛔ 不拿掉的話，舊手機繼續收客人找真人的通知與每日摘要，卻已經不屬於任何一位成員
  if (previous && previous !== profile.lineUserId) await removeFromHandoffNotify(workspaceId, previous)
  return true
}

export type NotifyReceivingResult =
  | { ok: true, result: AddToNotifyResult | 'removed' }
  | { ok: false, reason: 'not-member' | 'not-bound' }

/**
 * 「LINE 通知」頁那一列的「收通知」開關（`D-103`⑤）。綁定跟收不收是兩件事：
 * 關掉＝從名單拿掉、LINE 還綁著（之後打開不用再掃一次）。
 * 權限（只能動自己／管理員動別人）由端點判斷，這裡只做事。
 */
export async function setMemberNotifyReceiving(workspaceId: string, uid: string, on: boolean): Promise<NotifyReceivingResult> {
  const snap = await getDb().collection('workspaceMembers').doc(memberDocId(uid, workspaceId)).get()
  if (!snap.exists) return { ok: false, reason: 'not-member' }
  const lineUserId = String(snap.data()?.lineUserId ?? '').trim()
  if (!lineUserId) return { ok: false, reason: 'not-bound' }
  if (!on) {
    await removeFromHandoffNotify(workspaceId, lineUserId)
    return { ok: true, result: 'removed' }
  }
  return { ok: true, result: await addToHandoffNotify(workspaceId, lineUserId, String(snap.data()?.lineDisplayName ?? '')) }
}

/** 從 aiSettings.handoffNotify 名單移掉某個 lineUserId（沒有就什麼都不做） */
export async function removeFromHandoffNotify(workspaceId: string, lineUserId: string): Promise<void> {
  const id = String(lineUserId || '').trim()
  if (!id) return
  try {
    const db = getDb()
    const ref = db.collection(AI_SETTINGS_COLLECTION).doc(workspaceId)
    // 交易：跟 addToHandoffNotify 同一份名單，同時一加一減時不可以互相蓋掉
    const changed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (!snap.exists) return false
      const raw = snap.data()?.handoffNotify
      const ids: string[] = Array.isArray(raw?.lineUserIds) ? raw.lineUserIds.map((v: unknown) => String(v ?? '')) : []
      // 舊資料可能存成 `${workspaceId}_U…` 主鍵形式,兩種都要比對得到
      const hit = (v: string) => v === id || v.endsWith(`_${id}`)
      if (!ids.some(hit)) return false

      const next = ids.filter(v => !hit(v))
      const displayNames = { ...(raw?.displayNames ?? {}) }
      for (const key of Object.keys(displayNames)) {
        if (hit(key)) delete displayNames[key]
      }
      tx.update(ref, { 'handoffNotify.lineUserIds': next, 'handoffNotify.displayNames': displayNames })
      return true
    })
    if (changed) invalidateAiSettingsCache(workspaceId)
  }
  catch (e) {
    console.error('[member-bind] remove from handoffNotify failed:', e)
  }
}
