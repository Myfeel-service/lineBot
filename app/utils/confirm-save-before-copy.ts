import { ElMessageBox } from 'element-plus'

/**
 * 按「複製」時畫面上還有沒存的修改：先問要不要存，存好再複製（`C-294`，全站同一句）。
 *
 * ⛔ 不要「默默把修改帶進複本」也不要「默默丟掉」：前者原本那筆看起來沒變、人以為改到了；
 *    後者是辛苦改的東西不見。規則見 `docs/COPY-RULES-AND-INVENTORY-20261009.md`。
 * 回 true＝他按了「儲存並複製」（呼叫端接著存，存不成功就不要複製）。
 */
export function confirmSaveBeforeCopy(): Promise<boolean> {
  return ElMessageBox.confirm('還有沒儲存的修改。要先儲存，再把存好的這一份複製一份嗎？', '先儲存再複製', {
    confirmButtonText: '儲存並複製',
    cancelButtonText: '取消',
  }).then(() => true).catch(() => false)
}
