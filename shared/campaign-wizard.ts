/**
 * 「一檔活動」精靈的計畫與結果敘述（`C-212`）。
 *
 * **為什麼要有這個精靈**：正式庫實況說使用者的單位是**「一檔商品」**不是「一種東西一頁」——
 * MYFEEL 16 則推播裡 14 則按標籤分眾、13 則內容是模組；8 個活動**全部**同時綁標籤＋模組；
 * 6,066 筆貼標有 82% 來自活動連結加好友；標籤名字全是「問卷 - X」「客服 - X」。
 * 每上一檔要跨四頁、順序固定、缺零件就中斷回頭，**這條路他們已經走了 8 次**。
 *
 * ⛔ **底層仍是四筆資料、四支既有端點**，精靈只負責順序與預設值：
 *    不動資料模型、不加側欄項目、**不取代既有表單**（熟手照舊）。
 *
 * **這支檔案只管兩件純邏輯**（所以測得到）：
 *   ① 照輸入算出「這次要建哪幾樣、順序是什麼」
 *   ② 建到一半失敗時，**講得出已經建好了什麼**——這是整個精靈最重要的一段。
 *      一次建四樣東西，第三樣失敗時如果只說「建立失敗」，使用者會以為什麼都沒發生，
 *      然後重跑一次 → 多出一顆重複的標籤和一個重複的模組，而且他不會知道。
 */

export type CampaignWizardStepKey = 'tag' | 'module' | 'campaign' | 'broadcast'

export type CampaignWizardStepStatus = 'pending' | 'done' | 'failed' | 'skipped'

export interface CampaignWizardStep {
  key: CampaignWizardStepKey
  /** 給人看的一句話，例如「建立標籤「問卷 - 宜米製冰機」」 */
  label: string
  status: CampaignWizardStepStatus
  /** 建好之後的 id（給下一步用） */
  createdId?: string
  /** 失敗原因（已經是白話） */
  error?: string
}

export interface CampaignWizardInput {
  /** 這一檔叫什麼 */
  name: string
  /** 要新建的標籤名稱；空字串＝不建新的 */
  newTagName: string
  /** 要一起用的既有標籤 */
  existingTagIds: string[]
  /** 客人加好友後要看到什麼 */
  replyMode: 'newModule' | 'existingModule' | 'none'
  /** replyMode = newModule 時的文字內容 */
  newModuleText: string
  /** replyMode = existingModule 時挑的模組 */
  existingModuleId: string
  /** 完成後要不要順手建一則推播草稿 */
  createBroadcastDraft: boolean
}

export function defaultNewTagName(campaignName: string): string {
  const trimmed = String(campaignName ?? '').trim()
  // 跟 MYFEEL 既有的命名習慣一致（正式庫 39 顆標籤裡的活動標籤全是這個形狀）
  return trimmed ? `問卷 - ${trimmed}` : ''
}

export function defaultBroadcastName(campaignName: string): string {
  const trimmed = String(campaignName ?? '').trim()
  return trimmed ? `${trimmed} 開賣通知` : ''
}

/**
 * 動工前的檢查。回 null＝可以開始。
 *
 * ⛔ **LIFF 沒設好要在這裡就擋**，不是等他把整張表填完才說：活動連結產不出來的話，
 *    這一檔從頭到尾都沒有用（既有表單也是這樣擋的，精靈不能比它寬鬆）。
 */
export function validateCampaignWizard(
  input: CampaignWizardInput,
  opts: { liffReady: boolean },
): string | null {
  if (!String(input.name ?? '').trim()) return '請先填這一檔的名字'
  if (!opts.liffReady) {
    return '還沒設定活動頁（LIFF），現在建也產不出活動連結。請先到「組織與 LINE」設定，設定只要做一次。'
  }
  const hasTag = Boolean(String(input.newTagName ?? '').trim()) || input.existingTagIds.length > 0
  if (!hasTag) return '至少要有一顆標籤——客人加好友時就是靠它記住這一檔的人'
  if (input.replyMode === 'newModule' && !String(input.newModuleText ?? '').trim()) {
    return '請填客人加好友後會看到的那段文字'
  }
  if (input.replyMode === 'existingModule' && !String(input.existingModuleId ?? '').trim()) {
    return '請選一個既有的機器人模組'
  }
  return null
}

/** 照輸入算出這次要跑哪幾步（順序就是相依順序：標籤 → 模組 → 活動 → 推播草稿） */
export function buildCampaignWizardPlan(input: CampaignWizardInput): CampaignWizardStep[] {
  const steps: CampaignWizardStep[] = []
  const newTagName = String(input.newTagName ?? '').trim()

  if (newTagName) {
    steps.push({ key: 'tag', label: `建立標籤「${newTagName}」`, status: 'pending' })
  }
  if (input.replyMode === 'newModule') {
    steps.push({ key: 'module', label: `建立機器人模組「${input.name.trim()}」`, status: 'pending' })
  }
  steps.push({ key: 'campaign', label: `建立活動「${input.name.trim()}」並拿到活動連結`, status: 'pending' })
  if (input.createBroadcastDraft) {
    steps.push({
      key: 'broadcast',
      label: `建立推播草稿「${defaultBroadcastName(input.name)}」（不會發出去）`,
      status: 'pending',
    })
  }
  return steps
}

export interface CampaignWizardOutcome {
  /** 活動本身有沒有建成——這是「這一檔到底能不能用」的唯一判準 */
  ok: boolean
  headline: string
  /** 逐步結果，照原順序 */
  lines: string[]
  /**
   * ⛔ **已經建好、但這一檔沒成的東西**。
   * 沒有這一段的話，使用者會以為什麼都沒發生而重跑一次，
   * 於是多出一顆重複的標籤與一個重複的模組——而且他永遠不會知道。
   */
  leftovers: string[]
}

const STEP_NOUN: Record<CampaignWizardStepKey, string> = {
  tag: '標籤',
  module: '機器人模組',
  campaign: '活動',
  broadcast: '推播草稿',
}

export function summarizeCampaignWizard(steps: CampaignWizardStep[]): CampaignWizardOutcome {
  const campaign = steps.find(s => s.key === 'campaign')
  const ok = campaign?.status === 'done'

  const lines = steps.map((step) => {
    if (step.status === 'done') return `✅ ${step.label}`
    if (step.status === 'failed') return `❌ ${step.label}——${step.error || '失敗'}`
    if (step.status === 'skipped') return `⏭️ ${step.label}（沒有執行）`
    return `⏳ ${step.label}`
  })

  // 活動沒建成時，前面已經建好的東西要逐項點名（它們是真的存在於系統裡的）
  const leftovers = ok
    ? []
    : steps
        .filter(s => s.status === 'done')
        .map(s => `${STEP_NOUN[s.key]}「${s.label.replace(/^建立[^「]*「|」.*$/g, '')}」已經建好了`)

  let headline: string
  if (ok) {
    const failedAfter = steps.filter(s => s.status === 'failed')
    headline = failedAfter.length
      // 活動是主體，推播草稿是加值：主體成了就不要用「失敗」當標題嚇人
      ? '活動已經建好、可以開始收名單了，只有後面那一步沒成。'
      : '一檔活動建好了，下面是這次幫你做的事。'
  }
  else if (leftovers.length) {
    headline = '活動沒有建成，但前面幾樣已經建好了——⛔ 不要整個重來，會多出重複的東西。'
  }
  else {
    headline = '沒有建成，系統裡也沒有留下任何東西，可以直接再試一次。'
  }

  return { ok, headline, lines, leftovers }
}
