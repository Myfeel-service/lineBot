/**
 * 頁面提醒帶的分組：**指向同一個區塊的合成一條**（2026-08-28 老闆拍板）。
 *
 * 為什麼：同一頁常常好幾顆異常的下一步是同一個地方——組織頁「檢查連線」有 3 顆共用、
 * LIFF 那一格 3 顆、知識庫「要處理的事」5 顆。逐條列的結果是**最壞情況 6 條紅帶、
 * 407px 高、佔掉筆電可視高度 54%**（2026-08-28 實測），而那 6 條裡有 3 條的「帶我看」
 * 按下去會亮同一個區塊。
 *
 * ⛔ 這不是「收合」，不違背 2026-08-27「紅色永不收合」那條拍板：
 * 每一件事都還在畫面上、名字都看得到、每一顆自己的「幫我修」也都還按得到——
 * 只是把「去同一個地方」的收成一組，領頭那顆完整展開、其餘一行一條。
 *
 * 純函式抽在這裡是為了測得到：分組錯了的樣子是「有一顆異常從畫面上消失」，
 * 而畫面看起來完全正常、不會有任何錯誤訊息（同側欄狀態點、欄位圈框的理由）。
 */

/** 分組只認得這幾個欄位，刻意不吃整包 ResolvedAlert（測試不必造一整顆） */
export interface StripRowLike {
  id: string
  severity: 'critical' | 'warning' | 'suggestion'
  /** 「帶我看」會亮哪個區塊。⛔沒有錨點的不參與分組（它們的下一步各不相同） */
  anchorSelector?: string
}

export interface StripGroup<T extends StripRowLike> {
  /** 完整展開的那一顆（＝這一組裡最嚴重、且在原本順序中最前面的） */
  lead: T
  /** 其餘的，一行一條列在領頭下面。沒有就是空陣列 */
  rest: T[]
  /** 這一組的嚴重度＝領頭的（rows 已經紅在前，所以領頭一定是最嚴重的） */
  severity: 'critical' | 'warning' | 'suggestion'
}

/**
 * 把「這一頁的事」按「帶我看會亮哪一區」分組。
 *
 * 規則：
 * 1. **順序沿用輸入**：呼叫端給的已經是紅在前，分組後每一組出現在它領頭的位置。
 * 2. **只有錨點字串完全相同才算同一組**：`brokenModuleButton` 用的是逗號列四頁的
 *    選擇器，跟任何單頁的都不相等，自然自己一組——這是對的，它的區塊在別頁。
 * 3. **沒有錨點的一律自己一組**：沒有「帶我看」就沒有共同的目的地，硬併會騙人。
 */
export function groupStripRows<T extends StripRowLike>(rows: T[]): StripGroup<T>[] {
  const out: StripGroup<T>[] = []
  const byAnchor = new Map<string, StripGroup<T>>()
  for (const row of rows) {
    const key = row.anchorSelector
    if (!key) {
      out.push({ lead: row, rest: [], severity: row.severity })
      continue
    }
    const hit = byAnchor.get(key)
    if (hit) {
      hit.rest.push(row)
      continue
    }
    const group: StripGroup<T> = { lead: row, rest: [], severity: row.severity }
    byAnchor.set(key, group)
    out.push(group)
  }
  return out
}
