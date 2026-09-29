import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 端點守門的兩條規矩（`G-106`，2026-09-29 全站權限盤點後立的）。
 *
 * ① **門檻只能從權限表來**：工作區端點一律 `requireCapability(event, '<能力>')`，
 *    ⛔ 不可以再寫 `requireWorkspaceAccess(event, 'agent')` 這種寫死角色的。
 *    為什麼：盤點時 275 支端點只有 34 支讀 `shared/permissions.ts`，其他各自寫死——
 *    前端照表把「按鈕沒反應」的修復開給客服，後端那支還寫死 admin，客服一按就失敗（`G-102`）。
 *    表是前端 `can()` 跟後端共用的，只有兩邊讀同一份，「看得到＝按得動」才成立。
 *
 * ② **每一支端點都要看得出它的門**：沒有任何守門函式、又不在下面公開清單裡的端點＝紅。
 *    新增一支公開端點是可以的，但要來這裡寫一行「為什麼可以公開」——
 *    盤點時 `/api/liff/apply`（信任 body 帶的帳號）與 `/api/r`（開放轉址）就是這樣長出來的（`G-94`／`G-95`）。
 */

const ROOT = join(__dirname, '..', '..')

/** 公開端點（不綁任何登入身分）＝每一支都要講得出為什麼可以公開、靠什麼擋 */
const PUBLIC_ENDPOINTS: Record<string, string> = {
  'server/api/ai/sources/[sourceId]/resync-preview.post.ts': '已下架，固定回 410，不碰任何資料',
  'server/api/leads.post.ts': '官網聯絡表單；honeypot＋依 IP 限頻（`G-105`）',
  'server/api/liff/config.get.ts': 'LIFF 頁登入前要先拿到 LIFF id；只回公開設定，亂編的帳號 id 不讀庫（`G-105`）',
  'server/api/liff/lead-error.post.ts': '活動頁回報打不開的原因；不收呼叫端自報的帳號、依 IP 限頻（`G-105`）',
  'server/api/line-imagemap-img.get.ts': 'LINE 伺服器來抓圖文訊息的圖；token 有 HMAC 簽章＋到期',
  'server/api/line-imagemap-img/[token].get.ts': '同上（LINE 伺服器抓圖，HMAC 簽章＋到期）',
  'server/api/line-imagemap-img/[token]/[size].get.ts': '同上（LINE 伺服器抓圖，HMAC 簽章＋到期）',
  'server/api/r/[token].get.ts': '推播點擊轉址；只轉到那則推播真的包過的網址（`G-95`）',
  'server/api/t/[token].get.ts': '點擊貼標連結；token 有 HMAC 簽章＋到期',
  'server/routes/c/[code].get.ts': '短網址；只轉到 /admin/ 底下（那邊要登入）',
  'server/routes/payuni/notify.post.ts': 'PAYUNi 付款通知；HashInfo 驗簽＋兩層成功判定',
  'server/routes/payuni/return.ts': '付款後導回；只做站內轉址',
  'server/routes/webhook.get.ts': 'LINE 後台驗證 webhook 網址用的 GET，不碰資料',
}

/** 看得出「這支有門」的寫法（依身分從寬到嚴都算） */
const GUARD_PATTERNS = [
  /requireCapability\(/,
  /requireSuperAdmin\(/,
  /requireActiveOrgAdmin\(/,
  /requireOrgAdmin\(/,
  /requireAuth\(/,
  /requireFirebaseAuth\(/,
  /assertCronAuthorized\(/,
  /safeSecretEqual\(/,
  /verifyLiffAccessToken\(/,
  /x-line-signature/i,
  /verifyIdToken\(/,
  // 只驗登入、不綁帳號（例：「你有哪些官方帳號」清單本身）
  /verifyRequestToken\(/,
]

function listEndpointFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listEndpointFiles(full))
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

const files = [
  ...listEndpointFiles(join(ROOT, 'server', 'api')),
  ...listEndpointFiles(join(ROOT, 'server', 'routes')),
].map(full => ({ rel: relative(ROOT, full), src: readFileSync(full, 'utf8') }))

describe('端點守門（G-106）', () => {
  it('掃得到端點（⛔ 路徑寫錯的話下面兩條會空跑成綠燈）', () => {
    expect(files.length).toBeGreaterThan(200)
  })

  it('① 工作區端點一律讀權限表：⛔ 不可以寫死角色（requireWorkspaceAccess）', () => {
    const offenders = files.filter(f => /requireWorkspaceAccess\(/.test(f.src)).map(f => f.rel)
    expect(offenders, '改成 requireCapability(event, \'<能力>\')；表裡沒有合適的能力就先在 shared/permissions.ts 補一項').toEqual([])
  })

  it('② 每一支端點都看得出它的門；公開的要在清單裡講為什麼', () => {
    const unguarded = files
      .filter(f => !GUARD_PATTERNS.some(p => p.test(f.src)))
      .map(f => f.rel)
      .filter(rel => !(rel in PUBLIC_ENDPOINTS))
    expect(unguarded, '加上守門，或在 PUBLIC_ENDPOINTS 寫一行為什麼可以公開').toEqual([])
  })

  it('公開清單不留死項：列在上面的檔案都還在（刪了端點要順手拿掉那一行）', () => {
    const existing = new Set(files.map(f => f.rel))
    expect(Object.keys(PUBLIC_ENDPOINTS).filter(rel => !existing.has(rel))).toEqual([])
  })
})
