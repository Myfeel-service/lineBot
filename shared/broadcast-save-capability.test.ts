/**
 * 會讓推播排上時間的動作一律要「送出」權限（`C-352`②，2026-10-19 老闆「照建議」）。
 *
 * 以前推播「儲存變更」帶排程時間就能把推播排上，只要「寫草稿」權限；正式的「確認排程」卻要「送出」權限。
 * 規則在 `broadcastSaveCapability`，端點（`PUT /api/broadcast/:id`）與推播頁按鈕／欄位問同一支。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CAPABILITIES, ROLE_LEVEL, broadcastSaveCapability, can } from './permissions'
import type { WorkspaceMemberRole } from './types/organization'

const ROOT = join(__dirname, '..')
const page = readFileSync(join(ROOT, 'app/pages/admin/[workspaceId]/broadcasts.vue'), 'utf8')

describe('存一則推播要哪一項權限', () => {
  it('草稿、沒帶排程時間 → 寫草稿就夠', () => {
    expect(broadcastSaveCapability('draft')).toBe('broadcast.write')
    expect(broadcastSaveCapability('draft', null)).toBe('broadcast.write')
    expect(broadcastSaveCapability(null, undefined)).toBe('broadcast.write')
  })

  it('🔴 帶了排程時間（把它排上去）→ 要送出權限', () => {
    expect(broadcastSaveCapability('draft', '2026-10-30T10:00:00+08:00')).toBe('broadcast.send')
  })

  it('🔴 已經排好的那一則：改內容、改時間、拿掉排程都要送出權限', () => {
    expect(broadcastSaveCapability('scheduled')).toBe('broadcast.send')
    expect(broadcastSaveCapability('scheduled', '2026-10-30T10:00:00+08:00')).toBe('broadcast.send')
    expect(broadcastSaveCapability('scheduled', null)).toBe('broadcast.send')
  })

  it('跟「確認排程」同一道門：表裡兩項都在、送出那一項本來就寫著含排程', () => {
    expect(CAPABILITIES['broadcast.send']).toBeDefined()
    expect(CAPABILITIES['broadcast.write']).toBeDefined()
  })
})

describe('這次收斂有沒有讓現有的人少一件事（回報要講清楚）', () => {
  it('照現在的權限表：能存草稿的角色都能送出——今天沒有任何角色因此被擋（改了表要回頭看推播頁的排程區）', () => {
    const roles = Object.keys(ROLE_LEVEL) as WorkspaceMemberRole[]
    const writeOnly = roles.filter(r => can(r, 'broadcast.write') && !can(r, 'broadcast.send'))
    expect(writeOnly).toEqual([])
    // 觀察者兩樣都沒有（以前就排不了）；客服起兩樣都有（以前、現在都排得了）
    expect(can('viewer', 'broadcast.write')).toBe(false)
    expect(can('agent', 'broadcast.send')).toBe(true)
  })
})

describe('推播頁照同一支規則畫（無權限一律隱藏）', () => {
  it('「儲存草稿／儲存變更」那顆照這一則要的能力出現，表單鎖不鎖也看它', () => {
    expect(page).toContain('broadcastSaveCapability(isCreating.value ? null : selectedItem.value?.status)')
    expect(page).toMatch(/<el-button v-if="can\(saveCapability\)" :loading="saving" @click="saveDraft\(\)">/)
    expect(page).toContain('const isLocked = computed(() => isReadOnly.value || !can(saveCapability.value))')
    expect(page).toContain('if (!assertCan(saveCapability.value)) return false')
  })

  it('「發送時間」（立即／排程）只給有送出權限的人選；已經排好的那一則照樣看得到排在哪天', () => {
    expect(page).toMatch(/<div v-if="can\('broadcast\.send'\) \|\| form\.scheduleMode === 'schedule'" class="admin-field-group" data-schedule-field>/)
  })

  it('排程中的說明「要改內容按儲存變更，不發了按取消排程」只給有送出權限的人', () => {
    expect(page).toContain('<template v-if="can(\'broadcast.send\')">要改內容按「儲存變更」，不發了按「取消排程」。</template>')
  })
})
