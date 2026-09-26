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
 * 附帶保證：碼是用 LINE 傳進來的，代表對方確實已加此官方帳號好友——不會出現「設定了
 * 卻永遠推不出去」的靜默失敗（LINE push 只能推給好友）。
 */
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import { getUserProfile, replyMessage } from './line'
import { resolveLineOaBasicId } from './line-oa-basic-id'
import { AI_SETTINGS_COLLECTION, invalidateAiSettingsCache } from './ai-settings'

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

  const reply = async (text: string) => {
    if (!params.replyToken) return
    await replyMessage(params.replyToken, [{ type: 'text', text }], params.workspaceId)
      .catch(e => console.error('[member-bind] reply failed:', e))
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
      await reply('❌ 這組綁定碼已過期,請管理員到後台「成員管理」重新產生。')
      return true
    }

    // 同一個 LINE 帳號不能同時掛在兩位成員上——否則通知名單會出現兩筆相同 userId,
    // 而且移除其中一位不會停止通知。舊的那筆先解除。
    const conflicts = snap.docs.filter(
      d => d.id !== target.id && String(d.data().lineUserId ?? '') === params.lineUserId,
    )

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

    const who = String(target.data().invitedEmail ?? '').trim()
    await reply(
      `✅ 綁定成功${who ? `：${who}` : ''}\n`
      + '之後把這個帳號加進「轉真人通知」名單,客人要找真人時就會通知到這裡。',
    )
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

export type AddToNotifyResult = 'added' | 'already' | 'full' | 'failed'

/**
 * 把某個 lineUserId 加進 aiSettings.handoffNotify 名單（`C-250`③：開帳按「是我」的那支手機）。
 *
 * ⭐ 為什麼要有：綁定手機原本**不會**加進通知名單（綁定成功的回覆還叫他自己去加）——
 *    「客人要找你本人、早上的摘要會傳到這支手機」就只是一句沒人兌現的話。
 * ⚠️ 名單原本是空的才順手把通知打開：那是還沒設定過的新帳號；名單有人但關著＝他刻意關的，⛔ 不替他打開。
 * ⛔ 滿了就回 `full`、不擠掉別人（畫面要照實講「名單滿了」）。
 * ⚠️ 只更新名單那兩三格（跟 removeFromHandoffNotify 同一個寫法）：⛔ 不走整份覆寫 AI 設定的那條路。
 */
export async function addToHandoffNotify(workspaceId: string, lineUserId: string, displayName: string): Promise<AddToNotifyResult> {
  const id = String(lineUserId || '').trim()
  if (!id) return 'failed'
  try {
    const db = getDb()
    const ref = db.collection(AI_SETTINGS_COLLECTION).doc(workspaceId)
    const snap = await ref.get()
    const raw = snap.exists ? snap.data()?.handoffNotify : undefined
    const ids: string[] = Array.isArray(raw?.lineUserIds) ? raw.lineUserIds.map((v: unknown) => String(v ?? '')) : []
    // 舊資料可能存成 `${workspaceId}_U…` 主鍵形式，兩種都要比對得到
    if (ids.some(v => v === id || v.endsWith(`_${id}`))) return 'already'
    if (ids.length >= HANDOFF_NOTIFY_MAX) return 'full'
    const displayNames = { ...(raw?.displayNames ?? {}), ...(displayName ? { [id]: displayName.slice(0, 40) } : {}) }
    const patch: Record<string, unknown> = {
      'handoffNotify.lineUserIds': [...ids, id],
      'handoffNotify.displayNames': displayNames,
    }
    if (ids.length === 0 && raw?.enabled !== true) patch['handoffNotify.enabled'] = true
    if (snap.exists) {
      await ref.update(patch)
    }
    else {
      // 還沒有 AI 設定文件（新帳號）：只寫名單這一格，其餘由 normalizeAiSettings 讀的時候補預設
      await ref.set({ workspaceId, handoffNotify: { enabled: true, lineUserIds: [id], displayNames } }, { merge: true })
    }
    invalidateAiSettingsCache(workspaceId)
    return 'added'
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
  return true
}

/** 從 aiSettings.handoffNotify 名單移掉某個 lineUserId（沒有就什麼都不做） */
export async function removeFromHandoffNotify(workspaceId: string, lineUserId: string): Promise<void> {
  const id = String(lineUserId || '').trim()
  if (!id) return
  try {
    const db = getDb()
    const ref = db.collection(AI_SETTINGS_COLLECTION).doc(workspaceId)
    const snap = await ref.get()
    if (!snap.exists) return
    const raw = snap.data()?.handoffNotify
    const ids: string[] = Array.isArray(raw?.lineUserIds) ? raw.lineUserIds.map((v: unknown) => String(v ?? '')) : []
    // 舊資料可能存成 `${workspaceId}_U…` 主鍵形式,兩種都要比對得到
    const hit = (v: string) => v === id || v.endsWith(`_${id}`)
    if (!ids.some(hit)) return

    const next = ids.filter(v => !hit(v))
    const displayNames = { ...(raw?.displayNames ?? {}) }
    for (const key of Object.keys(displayNames)) {
      if (hit(key)) delete displayNames[key]
    }
    await ref.update({ 'handoffNotify.lineUserIds': next, 'handoffNotify.displayNames': displayNames })
    invalidateAiSettingsCache(workspaceId)
  }
  catch (e) {
    console.error('[member-bind] remove from handoffNotify failed:', e)
  }
}
