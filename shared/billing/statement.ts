// ═══════════════════════════════════════════════════════════════════
//  信用卡帳單上的請款名稱（單一事實來源）
//
//  為什麼需要這一支：**客人在帳單上看到的名字，跟我們對外的品牌不一樣**。
//  對外品牌是 MiniMe，但收單登記的特店名稱是 myfeel（營運公司麥菲爾的英文），
//  2026-08-16 實開 PAYUNi 正式付款頁確認過（見 docs/STATUS.md `B-32`）。
//
//  不揭露的後果不是「體驗不好」，是**直接賠錢**：
//    ① 客人今天付款，一個月後打開帳單只看到一行「myfeel 399」
//    ② 手上沒有任何我們的品牌線索可對照，而且看帳單的常常不是當初註冊的人
//    ③ 認不出來 → 當成盜刷 → 打去銀行爭議
//    ④ 我們啟用的是免 3D 驗證的幕後扣款＝**爭議款自負**（申請書紅字，見
//       docs/GOLIVE-BLOCKERS.md A2-2）→ 一通電話，那筆錢就是我們吸收
//  訂閱是每月扣，同一個誤會會一直重複發生。
//
//  ⚠️ 名字要**逐字**與帳單一致（小寫 `myfeel`，不要寫成 Myfeel／MYFEEL），
//     客人才對得起來；中文公司全名附在後面，讓人知道是誰。
// ═══════════════════════════════════════════════════════════════════

export interface StatementNameParts {
  /** 信用卡帳單上的請款名稱，逐字照收單登記（本平台＝myfeel）。 */
  statementName: string
  /** 營運主體全名（麥菲爾股份有限公司）。 */
  legalCompanyName: string
  /** 對外品牌（MiniMe）。 */
  brandName: string
}

/**
 * 一句話的帳單揭露。結帳確認框、收據信、條款頁共用同一句——
 * 三個地方講一樣的話，客人才會記得住。
 */
export function cardStatementNotice(p: StatementNameParts): string {
  return `信用卡帳單上會顯示「${p.statementName}」（${p.legalCompanyName}），這是 ${p.brandName} 的營運公司。`
}

/** 短版：塞在既有句子後面用（結帳確認框、付款前提示）。 */
export function cardStatementNoticeShort(p: Pick<StatementNameParts, 'statementName' | 'legalCompanyName'>): string {
  return `帳單顯示「${p.statementName}」（${p.legalCompanyName}）`
}
