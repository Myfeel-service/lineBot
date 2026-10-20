import { STATUS_LABELS, type ConversationStatus, type PreInboundKind } from './types/conversation-stats'
import { HUMAN_HANDLING_BOT_NOTE } from './human-handling-copy'

/**
 * 對話頁頂部那顆狀態徽章：字、顏色、滑上去的說明。
 *
 * 顏色照**急迫度**排，不是照狀態名稱：紅（客人正在被晾著）＞橘（沒人碰過）＞藍（有人在跟，資訊性）＞灰（不需要人）。
 * ⛔ 刻意不用綠：這個專案的 `primary` 就是品牌綠，旁邊的「我接手」正是綠色主按鈕（`C-72`）。
 * ⛔ 這個調色盤裡 `info` 是**藍色**不是灰，所以「中性灰」靠 muted 那個 class（見 _conversations.scss）。
 *
 * `D-4` 交過來的那一條（2026-10-20）：只傳貼圖、或加好友還沒開口的那一場，狀態欄位是 open，
 * 但它**不在「待處理」分頁**（`isPreInboundSession`）。以前頂部照欄位寫「待處理」＋橘色——
 * 在「全部」點開那一位就看到「待處理」，切去待處理分頁卻找不到他。
 * 所以頂部跟分頁吃同一條規則：這種場講實話（「只傳了貼圖」／「還沒開口」）、灰色、說明為什麼不在待處理。
 */
export interface SessionHeaderStatus {
  label: string
  type: 'danger' | 'warning' | 'info'
  muted: boolean
  hint: string
}

export function sessionHeaderStatus(meta: {
  status: ConversationStatus
  statusLabel?: string
  /** 時間軸 API 帶的（`preInboundKind`）；只有 open 的場才會有值 */
  preInbound?: PreInboundKind
}): SessionHeaderStatus {
  const label = meta.statusLabel || STATUS_LABELS[meta.status] || String(meta.status)
  if (meta.status === 'open' && meta.preInbound === 'sticker') {
    return {
      label: '只傳了貼圖',
      type: 'info',
      muted: true,
      hint: '客人只傳了貼圖，不用處理，所以不在「待處理」裡；他之後打字、傳圖或按按鈕就會進去',
    }
  }
  if (meta.status === 'open' && meta.preInbound === 'follow') {
    return {
      label: '還沒開口',
      type: 'info',
      muted: true,
      hint: '客人加了好友還沒講話，不用處理，所以不在「待處理」裡；他一開口就會進去',
    }
  }
  switch (meta.status) {
    case 'pending_human':
      return { label, type: 'danger', muted: false, hint: '客人要求真人、還沒有人接手——這場最需要你' }
    case 'open':
      return { label, type: 'warning', muted: false, hint: '這場對話還沒有人處理過' }
    case 'human_handling':
      return { label, type: 'info', muted: false, hint: `已經有同事接手，${HUMAN_HANDLING_BOT_NOTE}` }
    case 'bot_handling':
      return { label, type: 'info', muted: true, hint: '目前由機器人／AI 自動回覆中，不需要人介入' }
    default:
      return { label, type: 'info', muted: true, hint: '' }
  }
}
