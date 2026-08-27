/**
 * 「同一件事同一瞬間只查一次」的共用機制（`E-28`）。
 *
 * 為什麼要有這支：後台外殼上有好幾個元件會同時要同一份資料（頁頂提醒條、右下角小幫手、
 * 額度橫幅、頁內的卡片），而它們各自 `onMounted` 就是同一個 tick 一起發車。原本每支
 * composable 各自手抄一份防重複的閂，四份的完整度都不一樣——2026-08-27 那輪抓到的三個
 * bug 全都是「某一份少了其中一件」（少了共用狀態＝每頁打兩次；少了「這支是誰的」＝
 * 拿 A 家的查詢回答 B 家；少了 ticket＝落後的那支把新答案蓋回舊的）。
 *
 * 這支只負責三件機械事，**不碰任何資料與節流政策**（TTL、force、要寫哪些 state 一律
 * 留在呼叫端，因為各處語意不同：異常與體檢有 60 秒節流、方案額度刻意沒有）：
 *   1. 同一個 key 正在飛 → 共用那一支，不再發第二次
 *   2. 落地前問 `isLatest()`：不是最新那一支就別寫（換帳號時舊的那支不可以蓋掉新的）
 *   3. `releaseOthers(key)`：換帳號時放掉別家還在飛的那支，⛔但**留下同一家的**
 *      （切帳號時常常已經有元件替新帳號發車了，連它一起放掉會送出兩支一模一樣的查詢）
 *
 * ⚠️ 逾時只「放鎖」不動查詢本身：網路卡在半空中（睡眠／換 wifi）那支 promise 可能永遠
 * 不 resolve 也不 reject，共用之後會把整個 session 的重查全部擋住、轉圈停不掉。放鎖之後
 * 下一次呼叫可以重新查；那支殭屍查詢即使後來落地，也因為 ticket 對不上而不會寫任何東西。
 */

/** 鎖最多留這麼久。訂 30 秒是因為最慢的那支（異常彙總）正式站實測 1.3～4.1 秒，差一個量級 */
const LOCK_TIMEOUT_MS = 30_000

export interface SharedRequest {
  /** 同一個 key 正在飛的那一支（沒有就 null）。呼叫端拿到就直接 return 它 */
  pending: (key: string) => Promise<void> | null
  /** 開跑。`task` 會拿到 `isLatest()`——寫任何 state 之前先問它 */
  start: (key: string, task: (isLatest: () => boolean) => Promise<void>) => Promise<void>
  /** 放掉「不是這個 key」的那支飛行中查詢；回傳有沒有真的放掉 */
  releaseOthers: (currentKey: string) => boolean
}

export function useSharedRequest(stateKey: string): SharedRequest {
  const inflight = useState<Promise<void> | null>(`${stateKey}:inflight`, () => null)
  const inflightFor = useState(`${stateKey}:inflight-for`, () => '')
  const ticket = useState(`${stateKey}:ticket`, () => 0)

  function pending(key: string): Promise<void> | null {
    return inflight.value && inflightFor.value === key ? inflight.value : null
  }

  function start(key: string, task: (isLatest: () => boolean) => Promise<void>): Promise<void> {
    const mine = ++ticket.value
    inflightFor.value = key
    const isLatest = () => ticket.value === mine
    const release = () => {
      if (!isLatest()) return // 已經被接手了：別把新那支的旗標清掉
      inflight.value = null
      inflightFor.value = ''
    }

    const run = (async () => {
      try {
        await task(isLatest)
      }
      finally {
        release()
      }
    })()

    inflight.value = run
    if (import.meta.client)
      setTimeout(release, LOCK_TIMEOUT_MS) // 見檔頭：逾時只放鎖
    return run
  }

  function releaseOthers(currentKey: string): boolean {
    if (!inflight.value || inflightFor.value === currentKey) return false
    inflight.value = null
    inflightFor.value = ''
    ticket.value++ // 讓那支落地時認出自己已被接手，不會回頭寫資料或清旗標
    return true
  }

  return { pending, start, releaseOthers }
}
