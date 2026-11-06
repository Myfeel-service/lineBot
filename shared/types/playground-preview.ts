/**
 * 測試對話頁「客人會收到什麼」的兩種預覽（`D-173`，John 哥 11-04「不管在哪一區換了服裝換了武器，我就是到測試區去練」）。
 * 伺服器照**真的送出那條路**組（`server/utils/handler.ts` 的 `previewScriptReply`／`previewFollowWelcome`），畫面只負責畫。
 */

import type { BirthdayAppendBlock } from '../birthday'

/** 一條自動回應「客人會先收到什麼」 */
export interface ScriptReplyPreview {
  /** 送字那條路：真的會送出去的 LINE 訊息（送模組時是空的，看 `moduleId`） */
  lineMessages: Record<string, unknown>[]
  /** 送模組那條路 */
  moduleId?: string
  moduleName?: string
  /** 模組被關掉或刪掉＝客人什麼都收不到（⛔ 不可以畫成空白） */
  moduleMissing?: boolean
  /** 送完停在等客人回答（問一題／快速回覆）＝後面幾步要客人回了才走 */
  waits: boolean
  /** 送完就轉給真人 */
  handoff: boolean
}

/**
 * 客人加好友那一刻會收到什麼。
 * ⚠️ 留過生日的客人不會再收到生日卡；LINE 官方帳號後台自己的那則歡迎訊息我們看不到（畫面上講）。
 */
export interface FollowWelcomePreview {
  /** 加好友那一支自動回應的名字；null＝沒有 */
  scriptName: string | null
  reply: ScriptReplyPreview | null
  /** 生日卡：off＝沒開；appended＝附在歡迎訊息後面；alone＝沒有歡迎訊息、自己送；blocked＝附不上（看 `birthdayBlock`） */
  birthday: 'off' | 'appended' | 'alone' | 'blocked'
  birthdayBlock?: BirthdayAppendBlock
  /** 生日卡本身（畫出來用；off 時是空的） */
  birthdayMessages: Record<string, unknown>[]
}
