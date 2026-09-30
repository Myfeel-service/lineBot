/**
 * 「現在是小幫手代辦在跑」的境域（2026-09-30 code review）。
 *
 * 為什麼要有：代辦改別的資料一律轉呼叫既有端點（建標籤、補知識卡、改自動回應、建推播草稿…），
 * 那幾支端點自己會寫一筆 `actor:'human'` 的操作紀錄，代辦自己又寫一筆 `actor:'agent'`——
 * 操作紀錄頁就看到「他手動做了一次、小幫手又做了一次」，每件事都是兩筆，
 * 「`actor='agent'` 是 AI 動過手唯一查得到的地方」這條也破了。
 *
 * 做法：確認端點把 `op.execute` 圈進這個境域；境域內的 `writeAuditLog` 遇到 `actor:'human'` 就不寫，
 * 只留代辦自己那一筆（它比較完整：改了哪個詞、前後各是什麼、代號有沒有換）。
 * ⛔ 所以**每一支代辦都要自己寫紀錄**——它轉呼叫的端點在這裡是不會替它記的。
 *
 * ⛔ 用 AsyncLocalStorage、不用 header／body 旗標：旗標是任何拿得到登入憑證的人都送得出來的，
 *    拿它決定「這筆紀錄要不要寫」＝誰都能把自己的操作從紀錄裡藏起來。境域只存在這台機器的記憶體裡，
 *    外面送不進來。
 * ⚠️ 前提：代辦轉呼叫端點用的是 Nitro 的站內 `$fetch`（同一個行程裡直接呼叫那支 handler，
 *    非同步境域會一路跟進去）。2026-09-30 在 dev 起真的伺服器打過，確認境域有傳進被呼叫的端點。
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const agentOpALS = new AsyncLocalStorage<{ opId: string }>()

/** 把一次代辦的執行圈起來（只給 `/api/admin/agent/confirm` 用） */
export function runAsAgentOp<T>(opId: string, fn: () => Promise<T>): Promise<T> {
  return agentOpALS.run({ opId }, fn)
}

/** 目前是不是在某一支代辦的執行裡；是的話回那支的 id */
export function currentAgentOpId(): string | null {
  return agentOpALS.getStore()?.opId ?? null
}
