/**
 * LINE 通知名單的比對（純函式，`C-271`⑭ 從 `server/utils/ai-settings.ts` 搬來、收成一份）。
 *
 * 為什麼要有：同一行「`v === id || v.endsWith('_' + id)`」原本抄了四份（加名單、拿名單、webhook、LINE 通知頁），
 * 改一處就會對不上。名單比對一律走 `notifyListHas`，存進資料前一律 `normalizeLineUserId`。
 */

/** 純 LINE userId：U＋32 位十六進位 */
const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/i

/**
 * 收斂成純 LINE userId。
 * users 的 Firestore doc id 是 {workspaceId}_{lineUserId}，若整串被存進通知名單，
 * pushMessage 會被 LINE 判成無效 userId 而靜默失敗——通知永遠不會到。
 * 純 LINE userId 不含底線，因此可安全地取最後一段來自我修正。
 */
export function normalizeLineUserId(value: unknown): string {
  const s = String(value ?? '').trim()
  if (!s.includes('_')) return s
  const tail = s.slice(s.lastIndexOf('_') + 1)
  return LINE_USER_ID_RE.test(tail) ? tail : s
}

/** 通知名單上有沒有這個 LINE 帳號（舊資料可能存成 `${workspaceId}_U…`，兩種都算） */
export function notifyListHas(ids: readonly unknown[], lineUserId: string): boolean {
  const id = normalizeLineUserId(lineUserId)
  return Boolean(id) && ids.some(v => normalizeLineUserId(v) === id)
}

/**
 * 傳到手機的通知分三種，每個人自己勾要收哪幾種（`D-143`，2026-10-22）。
 * 名稱跟「設定 → LINE 通知」表格那三格、右邊手機預覽的三個分頁一樣。
 * - `handoff`：客人要找真人（當下那則、沒人接手的提醒）
 * - `digest`：早上的摘要（節日提醒、本週顧客觀察附在裡面）
 * - `crit`：出大事（嚴重異常、額度快用完／用完）
 *
 * ⚠️ 「同事把客人交給你」那則不在這三種裡：那則是指名給他的，在名單上（＝有勾任何一種）就傳。
 * ⛔ 還是同一份名單（`D-8`②：不開第二份），三種都不勾＝從名單拿掉——「最多 10 位」「名單上的人都收不到」
 *    這些口徑才不用改。
 */
export const NOTIFY_KINDS = ['handoff', 'digest', 'crit'] as const
export type NotifyKind = typeof NOTIFY_KINDS[number]
export const NOTIFY_KIND_LABELS: Record<NotifyKind, string> = { handoff: '客人找真人', digest: '早上的摘要', crit: '出大事' }

export function isNotifyKind(v: unknown): v is NotifyKind {
  return (NOTIFY_KINDS as readonly unknown[]).includes(v)
}

/** 每個人**不收**哪幾種：key 是純 LINE userId。存「不收的」是為了沒記＝三種都收，舊資料不用回填 */
export type NotifyOptOut = Record<string, NotifyKind[]>

/**
 * 「不收哪幾種」收成乾淨的樣子：只留名單上的人（key 一律 normalize）、只留認得的種類、空的不記。
 * `critOffForAll`：`D-143` 之前「出大事」是整個帳號一個開關（`criticalAlertPush`），關著＝每個人都不收出大事；
 * 第一次有人改勾選時才攤平寫進每個人（`member-line-bind.ts` 的 `setMemberNotifyKind`），讀的時候都走這裡。
 */
export function normalizeNotifyOptOut(raw: unknown, ids: readonly unknown[], opts: { critOffForAll?: boolean } = {}): NotifyOptOut {
  const stored = new Map<string, Set<NotifyKind>>()
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const id = normalizeLineUserId(key)
      if (!id || !Array.isArray(value)) continue
      const set = stored.get(id) ?? new Set<NotifyKind>()
      for (const k of value) if (isNotifyKind(k)) set.add(k)
      stored.set(id, set)
    }
  }
  const out: NotifyOptOut = {}
  for (const rawId of ids) {
    const id = normalizeLineUserId(rawId)
    if (!id || out[id]) continue
    const set = new Set(stored.get(id))
    if (opts.critOffForAll) set.add('crit')
    const off = NOTIFY_KINDS.filter(k => set.has(k))
    if (off.length) out[id] = off
  }
  return out
}

/** 這個人收哪幾種（呼叫端先確認他在名單上；不在名單上＝一種都不收） */
export function notifyKindsFor(optOut: Readonly<Record<string, readonly NotifyKind[]>> | undefined, lineUserId: string): NotifyKind[] {
  const off = optOut?.[normalizeLineUserId(lineUserId)] ?? []
  return NOTIFY_KINDS.filter(k => !off.includes(k))
}

/**
 * 某一種要傳給誰：名單上、而且沒把這一種取消的人。**送出端一律走這支**（⛔ 不要再直接拿 lineUserIds 去推）。
 * 回傳的是名單上原本的字串（跟 `pushToNotifyList` 收的一樣）。
 */
export function notifyRecipients(
  cfg: { lineUserIds: readonly string[], optOut?: Readonly<Record<string, readonly NotifyKind[]>> },
  kind: NotifyKind,
): string[] {
  return cfg.lineUserIds.filter(id => notifyKindsFor(cfg.optOut, id).includes(kind))
}
