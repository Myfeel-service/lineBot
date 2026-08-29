/**
 * 匯入視窗的「第幾步／共幾步」（D-40）。
 *
 * 為什麼要有：視窗有四種畫面卻沒有任何進度指示，使用者在第一步等好幾分鐘時
 * 不知道後面還有幾關（等待畫面明說「可以先關掉視窗」，更需要先講清楚全程有多長）。
 *
 * ⛔ 總數一律 3，不要讓它跳動：整站匯入是「換一條路」不是「多一關」——
 *    正常路是 給資料 → 看整理結果 → 完成，整站路是 給網址 → 選頁面 → 完成。
 *    兩條路都是三步；先寫「共 3 步」後來變「共 2 步」比不寫還糟。
 */
export type KbImportStep = 'input' | 'sitePages' | 'preview' | 'result'

export interface KbImportProgress {
  index: number
  total: number
}

const TOTAL = 3

export function kbImportStepProgress(step: KbImportStep, opts: { siteFinished?: boolean } = {}): KbImportProgress {
  switch (step) {
    case 'input':
      return { index: 1, total: TOTAL }
    case 'sitePages':
      // 整站匯入的結論列跟頁面清單長在同一個畫面上：匯完了就是第 3 步（完成），
      // 還沒匯就是第 2 步（挑要匯哪幾頁）
      return { index: opts.siteFinished ? 3 : 2, total: TOTAL }
    case 'preview':
      return { index: 2, total: TOTAL }
    case 'result':
      return { index: 3, total: TOTAL }
  }
}
