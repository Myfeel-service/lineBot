import { getDoc } from '~~/server/utils/firebase'
import { pushMessage } from '~~/server/utils/line'
import { allowedTestRecipientIds } from '~~/server/utils/broadcast-test-recipients'
import { attributeContextForUser } from '~~/server/utils/render-attributes'
import { lineUserFirestoreDocId } from '~~/shared/line-workspace'

/**
 * 「先發一則給自己看」的收件人檢查＋一位一位送（推播試發 `C-248`、模組傳給自己看 `C-426` 共用）。
 * ⛔ 規則只寫這一份：名單外的人不送、不是好友的先講、一位失敗不拖累其他人——兩邊各寫一套遲早不一樣。
 */

/** LINE 的 userId 一律是 U ＋ 32 位十六進位 */
const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/i
/** 一次最多發幾位：看稿的人通常 1–5 位（正式庫實測），上限只是擋手滑 */
const MAX_TEST_RECIPIENTS = 10

export interface TestSendResult {
  lineUserId: string
  displayName: string
  ok: boolean
  /** 沒送到的原因（人看得懂的一句話） */
  error?: string
}

export interface TestRecipientFriend {
  lineUserId: string
  friend: Record<string, unknown> | null
}

/**
 * `D-119` ⑥（2026-10-09）：一次可以勾好幾位，但**只能發給試發名單上的人**——
 * 自己綁好的手機、綁好的同事、常找來看稿的人。⛔ 名單一律由伺服器算，不信任前端傳來的。
 * （舊的單一 `lineUserId` 照收，一樣要在名單上）
 *
 * ⛔ 也先確認每一位都還是這個官方帳號的好友：不是的話 LINE 會回一個看不懂的 400，
 * 而店家只會看到「發送失敗」三個字。名單上的人也可能後來封鎖或刪了好友。
 */
export async function resolveTestRecipients(
  body: { lineUserIds?: unknown, lineUserId?: unknown } | null | undefined,
  workspaceId: string,
  uid: string,
): Promise<TestRecipientFriend[]> {
  const requested = [
    ...(Array.isArray(body?.lineUserIds) ? body.lineUserIds : []),
    ...(body?.lineUserId ? [body.lineUserId] : []),
  ].map(v => String(v ?? '').trim())
  const lineUserIds = [...new Set(requested)]
  if (!lineUserIds.length) {
    throw createError({ statusCode: 400, statusMessage: '請至少勾一位要收試發的人。' })
  }
  if (lineUserIds.length > MAX_TEST_RECIPIENTS) {
    throw createError({ statusCode: 400, statusMessage: `一次最多試發給 ${MAX_TEST_RECIPIENTS} 位。` })
  }
  if (lineUserIds.some(v => !LINE_USER_ID_RE.test(v))) {
    throw createError({ statusCode: 400, statusMessage: '收件人裡有一個不是 LINE 帳號，請重新打開試發再勾一次。' })
  }
  const allowed = await allowedTestRecipientIds(workspaceId, uid)
  if (lineUserIds.some(v => !allowed.has(v))) {
    throw createError({
      statusCode: 403,
      statusMessage: '試發只能發給名單上的人：你自己、綁好手機的同事、常找來看稿的人。要發給別人，先把他加進「常找來看稿的人」。',
    })
  }
  return Promise.all(lineUserIds.map(async id => ({
    lineUserId: id,
    friend: await getDoc<Record<string, unknown>>('users', lineUserFirestoreDocId(id, workspaceId)),
  })))
}

/**
 * 一位一位送：誰送到、誰沒送到要分得開（⛔ 一位失敗不可以讓其他人也算失敗）。
 * 每一位換上**他自己的**名字（`D-118` A），跟正式發送同一支 `attributeContextForUser`。
 */
export async function pushToTestRecipients(
  friends: TestRecipientFriend[],
  renderFor: (attributes: Record<string, string>) => unknown[],
  workspaceId: string,
  logTag: string,
): Promise<TestSendResult[]> {
  const sent: TestSendResult[] = []
  for (const { lineUserId, friend } of friends) {
    const displayName = String((friend as { displayName?: string } | null)?.displayName || '')
    if (!friend) {
      sent.push({ lineUserId, displayName, ok: false, error: '已經不是這個官方帳號的好友' })
      continue
    }
    // 名單只管「誰在名單上」（`allowedTestRecipientIds`），封鎖了的在這裡講、不送（試發框也不給勾）
    if ((friend as { isBlocked?: boolean }).isBlocked === true) {
      sent.push({ lineUserId, displayName, ok: false, error: '對方封鎖了官方帳號，收不到' })
      continue
    }
    try {
      await pushMessage(lineUserId, renderFor(attributeContextForUser(friend)) as never, workspaceId)
      sent.push({ lineUserId, displayName, ok: true })
    }
    catch (e: unknown) {
      const detail = (e as { originalError?: { response?: { data?: { message?: string } } }; message?: string })
      const reason = detail?.originalError?.response?.data?.message || detail?.message || ''
      console.error(`${logTag} push failed:`, reason || e)
      sent.push({ lineUserId, displayName, ok: false, error: `LINE 沒有收下${reason ? `（${reason}）` : ''}，常見原因是對方封鎖了官方帳號` })
    }
  }
  return sent
}

/** 一位都沒送到：整次算失敗，講出是誰、為什麼（一位的時候照原本的說法） */
export function assertSomeoneReceived(sent: TestSendResult[]): TestSendResult[] {
  const delivered = sent.filter(s => s.ok)
  if (delivered.length) return delivered
  const only = sent.length === 1 ? sent[0] : null
  throw createError({
    statusCode: only && only.error === '已經不是這個官方帳號的好友' ? 404 : 502,
    statusMessage: only
      ? `沒送到「${only.displayName || only.lineUserId}」：${only.error}。`
      : `一位都沒送到：${sent.map(s => `${s.displayName || s.lineUserId}（${s.error}）`).join('、')}。`,
  })
}
