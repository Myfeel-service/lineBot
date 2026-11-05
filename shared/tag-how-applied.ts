/**
 * 標籤管理頁每一顆旁邊那句「怎麼貼上去」（`C-463`，`D-171` 示意頁 v2 下面那張表，老闆 2026-11-05「ok 執行」）。
 *
 * 為什麼要有：開帳只放 AI 判斷得出來的那種標籤，其他的（系統自己貼、按選單就貼、要人自己貼）搬到這裡講。
 * 以前這一頁只有 AI 那兩種有章，其他的都是「—」——**系統每天自己貼的跟永遠不會有人貼的長得一模一樣**，
 * 沒有貼法的那顆就一直 0 人、沒人發現（跟以前開帳建的「回購客」同一種病）。
 *
 * ⛔ 每一句都要是**真的會發生的事**：
 * - 「用在哪」那份引用裡，推播是**拿它挑人**、不是貼上去 → 不算；關掉的自動回應／活動已經帶不了客人進來 → 不算。
 * - 讀不到的開關（`null`）不講但書：⛔ 不拿不知道的事去嚇他。
 * - 什麼貼法都沒有，才講「要你在好友頁自己貼」。
 */
import type { ConfigRef, ConfigRefKind } from './config-references'
import { refStillReaches } from './config-references'
import { BIRTHDAY_TAG_CODE } from './birthday'

/** 系統每晚維護的「N 天沒互動」（`server/utils/inactive-tag.ts` 的 INACTIVE_TAG_CODE；⛔ 那支在 server，這裡不 import） */
export const INACTIVE_TAG_CODE_SHARED = 'sys_inactive'

export interface TagHowLine {
  text: string
  /** auto＝不用他動手就會貼；manual＝要他自己貼 */
  tone: 'auto' | 'manual'
}

/** 會「貼上去」的那幾種引用（推播是拿來挑人，不算） */
const APPLY_KINDS: readonly ConfigRefKind[] = ['richmenu', 'flow', 'campaign', 'script', 'supportPreset']

/** 一種引用講一句；一處就點名，多處講幾處（⛔ 不把十個名字塞進一格） */
function refLine(kind: ConfigRefKind, refs: ConfigRef[]): string {
  const one = refs.length === 1 ? `「${refs[0]!.label}」` : ''
  const many = refs.length > 1 ? `（${refs.length} 處）` : ''
  switch (kind) {
    case 'richmenu': return `客人按圖文選單${one}就貼${many}`
    case 'flow': return `客人按模組${one}的按鈕就貼${many}`
    case 'campaign': return `客人從活動${one}加好友就貼${many}`
    case 'script': return `自動回應${one}走到就貼${many}`
    case 'supportPreset': return `客服送出預存回覆${one}時貼${many}`
    default: return ''
  }
}

export function tagHowApplied(
  tag: { code?: string | null, aiMode?: string | null },
  refs: readonly ConfigRef[],
  opts: {
    /** 「AI 讀對話」總開關（autoTagSuggest）；null＝還不知道 */
    aiReading: boolean | null
    /** 「加好友時問生日」；null＝還不知道 */
    birthdayOn: boolean | null
  },
): TagHowLine[] {
  const lines: TagHowLine[] = []
  if (tag.code === INACTIVE_TAG_CODE_SHARED) {
    lines.push({ text: '系統每天自己貼，客人回來就自己摘掉', tone: 'auto' })
  }
  if (tag.code === BIRTHDAY_TAG_CODE) {
    lines.push({
      text: `系統每個月 1 號自己換${opts.birthdayOn === false ? '（要先在「好友」頁打開「生日」）' : ''}`,
      tone: 'auto',
    })
  }
  if (tag.aiMode === 'suggest' || tag.aiMode === 'auto') {
    const off = opts.aiReading === false ? '（「AI 讀對話」關著，現在不會）' : ''
    lines.push({ text: `${tag.aiMode === 'auto' ? '客人聊到就直接貼上' : '客人聊到就提醒你貼'}${off}`, tone: 'auto' })
  }
  for (const kind of APPLY_KINDS) {
    const reach = refs.filter(r => r.kind === kind && refStillReaches(r))
    if (reach.length) lines.push({ text: refLine(kind, reach), tone: 'auto' })
  }
  if (!lines.length) lines.push({ text: '要你在「好友」頁自己貼', tone: 'manual' })
  return lines
}
