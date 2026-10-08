import { describe, expect, it } from 'vitest'
import { compareMembersForList } from './member-order'

/**
 * `D-117`：成員管理原本沒排序（擁有者排第 4），LINE 通知只照角色排——同一群人兩頁順序不一樣。
 * 這裡用老闆截圖那份名單（正式庫 MYFEEL 的 7 位成員，資料庫文件順序）釘住兩頁共用的順序。
 */
describe('成員名單順序（成員管理、LINE 通知共用）', () => {
  const dbOrder = [
    { email: 'arthur.lin@myfeel-tw.com', role: 'admin' },
    { email: 'jo.chen@myfeel-tw.com', role: 'agent' },
    { email: 'ray.you@myfeel-tw.com', role: 'agent' },
    { email: 'kevin.chiang@myfeel-tw.com', role: 'owner' },
    { email: 'jordan@myfeel-tw.com', role: 'admin' },
    { email: 'alice.tseng@myfeel-tw.com', role: 'agent' },
    { email: 'tomoko@myfeel-tw.com', role: 'admin' },
  ]

  it('擁有者 → 管理員 → 客服，同角色照 Email', () => {
    expect([...dbOrder].sort(compareMembersForList).map(m => m.email)).toEqual([
      'kevin.chiang@myfeel-tw.com',
      'arthur.lin@myfeel-tw.com',
      'jordan@myfeel-tw.com',
      'tomoko@myfeel-tw.com',
      'alice.tseng@myfeel-tw.com',
      'jo.chen@myfeel-tw.com',
      'ray.you@myfeel-tw.com',
    ])
  })

  it('自己排第一（那一列有只給自己的按鈕），觀察者排在客服後面', () => {
    const rows = [...dbOrder, { email: 'a@x.com', role: 'viewer' }, { email: 'ray.you@myfeel-tw.com', role: 'agent', isSelf: true }]
    const sorted = [...rows].sort(compareMembersForList)
    expect(sorted[0]).toMatchObject({ isSelf: true })
    expect(sorted.at(-1)).toMatchObject({ role: 'viewer' })
  })
})
