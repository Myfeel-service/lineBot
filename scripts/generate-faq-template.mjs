/**
 * 產生「FAQ 知識庫範本」xlsx → public/templates/faq-sheet-template.xlsx
 *
 * 用途:商家匯入知識庫的官方範本。上傳到 Google Sheet 當母本
 * (開「知道連結者可檢視」,後台放 /copy 連結讓商家一鍵建立副本),
 * public/ 下的檔案同時可當「直接下載範本」的 fallback。
 *
 * 分頁順序是刻意的:資料分頁(FAQ)必須是第一個分頁——
 * 匯入端在連結沒帶 #gid= 時讀的是第一個分頁(見 server/utils/google-sheets.ts)。
 *
 * 重新產生:node scripts/generate-faq-template.mjs
 *
 * xlsx 社群版不支援凍結列/底色/保護範圍,這些要在 Google Sheet 母本上手動設定:
 *   1. 「FAQ」分頁:檢視 → 凍結 → 1 列
 *   2. 「FAQ」分頁第一列(表頭):資料 → 保護工作表和範圍(避免商家改壞表頭)
 *   3. 示範列(2–4 列)上淺黃底色,提醒替換
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import XLSX from 'xlsx'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outPath = resolve(root, 'public/templates/faq-sheet-template.xlsx')

// ── 分頁 1:FAQ(資料)────────────────────────────────────────────
// 欄位設計:就兩欄,都必填。其他問法、分類一律由 AI 在匯入時自動補,
// 商家要調整就在匯入前的預覽畫面改——把填表門檻壓到最低。
const faqHeader = ['客人會問的問題', '答案']

const faqRows = [
  [
    '退款多久會入帳?',
    '【示範答案,請替換】退款申請經客服確認後,平台將依每月排程進行刷退或匯款,實際入帳日以金流與銀行作業時間為準。',
  ],
  [
    '運費怎麼計算?',
    '【示範答案,請替換】單筆訂單滿 1,000 元免運費;未滿收取 80 元運費,離島地區運費另計。',
  ],
  [
    '下單後多久會到貨?',
    '【示範答案,請替換】付款完成後 3–5 個工作天內出貨,出貨後 1–2 天送達;預購商品依商品頁標示時間為準。',
  ],
]

const faqSheet = XLSX.utils.aoa_to_sheet([faqHeader, ...faqRows])
faqSheet['!cols'] = [{ wch: 30 }, { wch: 80 }]

// ── 分頁 2:使用說明 ────────────────────────────────────────────
const guideRows = [
  ['📖 FAQ 範本使用說明', ''],
  ['', ''],
  ['【填寫步驟】', ''],
  ['1', '在「FAQ」分頁填寫,一列一題,兩欄都必填。前 3 列是示範,請替換成你自己的內容。'],
  ['2', '填完後點右上角「共用」,把試算表分享給後台顯示的服務帳號(檢視權限即可,取消勾選「通知使用者」)。'],
  ['3', '回到後台貼上這份試算表的連結,預覽確認後完成匯入。'],
  ['', ''],
  ['【重要規則】', ''],
  ['✍️ 問題用客人的話寫', '寫「錢什麼時候會退?」,不要寫「退款時間」這種內部分類詞。問題寫得越像客人真的會打的字,AI 越容易答對。'],
  ['🚫 不要合併儲存格', '合併儲存格會讓系統漏讀整列資料,而且不會有任何錯誤提示。'],
  ['🚫 表頭不要動', '第一列的欄位名稱請不要刪除或改名。'],
  ['📌 同一題不要開多列', '一個問題寫一列就好,不用把不同問法各開一列——匯入時 AI 會自動幫每一題補上「客人換句話說的問法」。'],
  ['🔑 第一欄是比對依據', '系統用「客人會問的問題」判斷是同一題。改了這一欄的文字,系統會視為「刪掉舊題、新增新題」。'],
  ['🔒 後台改過的不會被覆蓋', '曾在後台手動編輯過的知識卡,之後不會再被這份試算表的內容覆蓋。'],
  ['📏 數量與長度上限', '最多 150 列;每題答案最多 5,000 字。'],
  ['🖼️ 圖片與註解讀不到', '儲存格裡的圖片、插入的註解都不會被匯入;答案中需要附連結時,直接把網址貼在文字裡即可。'],
  ['', ''],
  ['【AI 會自動幫你補什麼】', ''],
  ['其他問法', '匯入時 AI 會為每一題自動產生 2–3 句「客人可能的其他問法」,幫助 AI 用不同說法也能對到這一題。'],
  ['分類', '會依內容自動加上分類標籤,方便你在後台管理。'],
  ['預覽可修改', 'AI 補的內容在匯入前的預覽畫面都看得到、可以逐題修改;你的答案原文不會被 AI 改寫。'],
  ['敏感題目請多看一眼', '「我要找真人客服」「我要客訴」這類需要精準觸發的題目,匯入預覽時請確認 AI 補的問法符合你的想法,不符合就當場改。'],
  ['', ''],
  ['【之後想更新內容?】', ''],
  ['直接改這份試算表', '系統每小時會自動更新一次;也可以到後台這份資料按「立即更新」。只有內容有變動的題目會重新處理。'],
]

const guideSheet = XLSX.utils.aoa_to_sheet(guideRows)
guideSheet['!cols'] = [{ wch: 24 }, { wch: 88 }]

// ── 輸出(FAQ 一定要是第一個分頁)───────────────────────────────
const wb = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(wb, faqSheet, 'FAQ')
XLSX.utils.book_append_sheet(wb, guideSheet, '使用說明')

mkdirSync(dirname(outPath), { recursive: true })
// xlsx 的 ESM 版 writeFile 沒接 node fs,改用 write(buffer) 自己落地
writeFileSync(outPath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
console.log(`✅ 範本已產生:${outPath}`)
