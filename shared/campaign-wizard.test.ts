import { describe, expect, it } from 'vitest'
import {
  buildCampaignWizardPlan,
  defaultBroadcastName,
  defaultNewTagName,
  summarizeCampaignWizard,
  validateCampaignWizard,
  type CampaignWizardInput,
  type CampaignWizardStep,
} from './campaign-wizard'

const base: CampaignWizardInput = {
  name: '宜米製冰機',
  newTagName: '問卷 - 宜米製冰機',
  existingTagIds: [],
  replyMode: 'newModule',
  newModuleText: '謝謝報名！',
  existingModuleId: '',
  createBroadcastDraft: true,
}

describe('預設值跟著使用者既有的命名習慣', () => {
  it('標籤預設「問卷 - 活動名」（正式庫的活動標籤全是這個形狀）', () => {
    expect(defaultNewTagName('宜米製冰機')).toBe('問卷 - 宜米製冰機')
    expect(defaultNewTagName('  ')).toBe('')
  })

  it('推播草稿有個看得懂的預設名字', () => {
    expect(defaultBroadcastName('宜米製冰機')).toBe('宜米製冰機 開賣通知')
    expect(defaultBroadcastName('')).toBe('')
  })
})

describe('validateCampaignWizard', () => {
  const liffOk = { liffReady: true }

  it('填好就放行', () => {
    expect(validateCampaignWizard(base, liffOk)).toBeNull()
  })

  it('沒名字擋下', () => {
    expect(validateCampaignWizard({ ...base, name: ' ' }, liffOk)).toContain('名字')
  })

  it('⛔ LIFF 沒設好要在動工前就擋（不是等他填完才說連結產不出來）', () => {
    const err = validateCampaignWizard(base, { liffReady: false })
    expect(err).toContain('LIFF')
    expect(err).toContain('組織與 LINE')
  })

  it('⛔ 一顆標籤都沒有要擋——那是這一檔記得住人的唯一方法', () => {
    const noTag = { ...base, newTagName: '', existingTagIds: [] }
    expect(validateCampaignWizard(noTag, liffOk)).toContain('標籤')
  })

  it('只挑既有標籤、不建新的也可以', () => {
    const reuse = { ...base, newTagName: '', existingTagIds: ['t1'] }
    expect(validateCampaignWizard(reuse, liffOk)).toBeNull()
  })

  it('說要建新模組卻沒填文字要擋；說要用既有模組卻沒挑也要擋', () => {
    expect(validateCampaignWizard({ ...base, newModuleText: '' }, liffOk)).toContain('文字')
    expect(validateCampaignWizard(
      { ...base, replyMode: 'existingModule', existingModuleId: '' },
      liffOk,
    )).toContain('模組')
  })

  it('選「不回訊息」就不管模組那兩格', () => {
    const silent: CampaignWizardInput = { ...base, replyMode: 'none', newModuleText: '', existingModuleId: '' }
    expect(validateCampaignWizard(silent, liffOk)).toBeNull()
  })
})

describe('buildCampaignWizardPlan', () => {
  it('順序就是相依順序：標籤 → 模組 → 活動 → 推播草稿', () => {
    expect(buildCampaignWizardPlan(base).map(s => s.key)).toEqual(['tag', 'module', 'campaign', 'broadcast'])
  })

  it('沿用既有標籤與既有模組時，只剩活動一步', () => {
    const reuse: CampaignWizardInput = {
      ...base,
      newTagName: '',
      existingTagIds: ['t1'],
      replyMode: 'existingModule',
      existingModuleId: 'm1',
      createBroadcastDraft: false,
    }
    expect(buildCampaignWizardPlan(reuse).map(s => s.key)).toEqual(['campaign'])
  })

  it('活動那一步永遠都在（它是這個精靈的主體）', () => {
    const minimal: CampaignWizardInput = { ...base, newTagName: '', existingTagIds: ['t1'], replyMode: 'none', createBroadcastDraft: false }
    expect(buildCampaignWizardPlan(minimal).map(s => s.key)).toEqual(['campaign'])
  })
})

/** 造一組跑完的步驟 */
function steps(...rows: Array<[CampaignWizardStep['key'], CampaignWizardStep['status'], string?]>): CampaignWizardStep[] {
  const label: Record<string, string> = {
    tag: '建立標籤「問卷 - 宜米製冰機」',
    module: '建立機器人模組「宜米製冰機」',
    campaign: '建立活動「宜米製冰機」並拿到活動連結',
    broadcast: '建立推播草稿「宜米製冰機 開賣通知」（不會發出去）',
  }
  return rows.map(([key, status, error]) => ({ key, label: label[key]!, status, error }))
}

describe('summarizeCampaignWizard — 建到一半失敗時講不講得出建了什麼', () => {
  it('全部成功', () => {
    const out = summarizeCampaignWizard(steps(['tag', 'done'], ['module', 'done'], ['campaign', 'done'], ['broadcast', 'done']))
    expect(out.ok).toBe(true)
    expect(out.headline).toContain('建好了')
    expect(out.leftovers).toEqual([])
    expect(out.lines.every(l => l.startsWith('✅'))).toBe(true)
  })

  it('⛔ 活動失敗、但標籤與模組已經建好 → 一定要點名它們，並叫人不要整個重來', () => {
    const out = summarizeCampaignWizard(steps(
      ['tag', 'done'], ['module', 'done'], ['campaign', 'failed', '活動代碼重複'],
    ))
    expect(out.ok).toBe(false)
    expect(out.headline).toContain('不要整個重來')
    expect(out.leftovers).toHaveLength(2)
    expect(out.leftovers.join()).toContain('問卷 - 宜米製冰機')
    expect(out.leftovers.join()).toContain('宜米製冰機')
    expect(out.lines.join()).toContain('活動代碼重複')
  })

  it('第一步就失敗＝系統裡沒留下東西，可以直接再試一次', () => {
    const out = summarizeCampaignWizard(steps(['tag', 'failed', '代號重複'], ['campaign', 'skipped']))
    expect(out.ok).toBe(false)
    expect(out.leftovers).toEqual([])
    expect(out.headline).toContain('可以直接再試一次')
  })

  it('⛔ 活動成了、只有推播草稿沒成 → 標題不可以用「失敗」嚇人（主體已經可以用了）', () => {
    const out = summarizeCampaignWizard(steps(
      ['tag', 'done'], ['campaign', 'done'], ['broadcast', 'failed', '額度不足'],
    ))
    expect(out.ok).toBe(true)
    expect(out.headline).toContain('可以開始收名單')
    expect(out.headline).not.toContain('沒有建成')
    expect(out.leftovers).toEqual([])
  })

  it('沒跑完的步驟標成等待中，不會被講成失敗', () => {
    const out = summarizeCampaignWizard(steps(['tag', 'done'], ['campaign', 'pending']))
    expect(out.lines[1]).toContain('⏳')
    expect(out.ok).toBe(false)
  })
})
