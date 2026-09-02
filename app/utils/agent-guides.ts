/**
 * 「帶你修好」引導劇本（C-31 Phase 1）——小幫手面板內嵌的修復精靈。
 *
 * 每條劇本對應一種（或一組）異常：解釋後果 → 給正確的網址／選項 → 使用者動手 →
 * **真的去驗證有沒有生效**（後端訊號，不是嘴上說修好了）。零 LLM，吃共用的
 * useAgentScriptRunner 引擎，訊息合約與開通精靈同一份（AgentMessageRenderer 渲染）。
 *
 * 加一條劇本＝這裡加一筆 AGENT_GUIDES ＋ useWorkspaceAlerts 註冊表對應異常掛 guideId。
 * 原則沿用開通精靈的紀律：教學網址一律取 shared／後端口徑（不手抄）、
 * 查不到≠修好也≠沒修好（誠實三態）、每一步有跳過出口。
 */
import { escapeHtml } from '~~/shared/types/agent-messages'
import { ALERT_SCOPE_LABELS } from '~~/shared/types/alerts'
import type { WorkspaceAlertId } from '~~/shared/types/alerts'
import type { BrokenModuleFixState, BrokenModuleRefRow, BrokenModuleRepointResult } from '~~/shared/types/alert-fix'
import { ONBOARDING_SHOTS } from '~/utils/onboarding-shots'
import { kbVerifyOutcome } from '~/utils/kb-verify-outcome'
import type { AgentScriptRunner, AgentScriptStep } from '~/composables/useAgentScriptRunner'

export type AgentGuideId = 'liff-endpoint' | 'liff-setup' | 'handoff-notify' | 'knowledge-sync' | 'knowledge-first' | 'line-webhook' | 'broken-module' | 'line-channel'

export interface AgentGuideCtx {
  r: AgentScriptRunner
  // opts 用 any：實際塞的是 useWorkspace().apiFetch（ofetch 的選項型別），
  // 這裡收窄只會跟 ofetch 的型別打架，劇本端不需要那個精度
  apiFetch: <T>(url: string, opts?: any) => Promise<T>
  workspaceId: string
  /** 步驟間共享的狀態。exit=true 之後的步驟全部靜默跳過（劇本的「提前收工」出口） */
  state: { exit?: boolean } & Record<string, unknown>
}

export interface AgentGuideDef {
  id: AgentGuideId
  /** 面板標題 */
  title: string
  /** 對應的異常（同一條劇本可以修同一家族的多顆異常） */
  alertIds: WorkspaceAlertId[]
  steps: AgentScriptStep<AgentGuideCtx>[]
}

/** 後續步驟的共用 guard：前面已經收工就不再往下走 */
const exited = (c: AgentGuideCtx) => c.state.exit === true

/**
 * 「帶著做」清單（D-40 補遺）——不是修東西、是**陪你把一件事做完並驗證**的劇本。
 *
 * 為什麼要有這份清單：knowledge-first 原本唯一的入口是開通清單的「建立知識庫」，
 * 而那份清單只列**還沒做完**的事——放完第一份知識，這項就從清單消失，劇本從此
 * 叫不出來（想放第二份、新同事想走一遍，都沒有路）。更糟的是導覽跑完那句
 * 「教學分頁隨時都在」對它是假話。這份清單讓它長進教學分頁與頁首問號。
 *
 * ⛔ 修復劇本（liff-endpoint、line-webhook…）不進這份清單：它們的入口是異常卡，
 *    「東西沒壞還列出修理教學」只會讓人以為壞了。
 */
export interface WalkthroughGuideEntry {
  id: AgentGuideId
  /** 一句白話：這條會陪你做完什麼 */
  blurb: string
  /** 誰跑得動（對齊該任務實際需要的角色，跟 SetupCapability.requires 同一把尺） */
  requires: 'operate' | 'settings'
}

export const WALKTHROUGH_GUIDES: WalkthroughGuideEntry[] = [
  { id: 'knowledge-first', blurb: '陪你放進第一份資料，並確認 AI 真的答得出來。', requires: 'operate' },
]

// ── LIFF Endpoint ───────────────────────────────────────────────

interface LiffCheckRes {
  expectedUrl: string
  checks: {
    liffId: string
    source: 'default' | 'campaign'
    status: 'ok' | 'mismatch' | 'broken' | 'unknown'
    endpoint: string | null
    reason?: 'wrong_page' | 'unreachable' | 'deleted'
  }[]
}

const LIFF_PROBLEM_LABELS: Record<string, string> = {
  wrong_page: '指到不相干的頁面',
  unreachable: '登記的網址已經連不上',
  deleted: '這個 LIFF 在 LINE 上已不存在',
  mismatch: '網域不是正式網址（多半是換網域前的舊網址）',
}

function liffProblemLine(c: LiffCheckRes['checks'][number]): string {
  const label = LIFF_PROBLEM_LABELS[c.reason || c.status] || '登記的網址不對'
  const current = c.endpoint ? `（現在填的是 ${escapeHtml(c.endpoint)}）` : ''
  return `・<b>${escapeHtml(c.liffId)}</b>：${label}${current}`
}

async function fetchLiffChecks(c: AgentGuideCtx): Promise<LiffCheckRes> {
  // force=1：使用者剛去 LINE 改完回頭確認，要跳過 5 分鐘快取真的再查一次
  return c.apiFetch<LiffCheckRes>('/api/admin/liff-endpoint-check', { query: { force: 1 } })
}

const liffEndpointGuide: AgentGuideDef = {
  id: 'liff-endpoint',
  title: '修好活動頁（LIFF）登記',
  alertIds: ['liffEndpointBroken', 'liffEndpointUrlMismatch'],
  steps: [
    {
      id: 'diagnose',
      async run(c) {
        const { r } = c
        await r.say('這個問題會害客人<b>點活動連結時打不開</b>、或在兩個網址之間繞路。我帶你修，大約兩分鐘。')
        const res = await r.apiRetry(() => fetchLiffChecks(c), { failText: '查詢 LIFF 登記狀態失敗', skipLabel: '先不修' })
        if (!res) {
          c.state.exit = true
          await r.say('好，先不修。右下角的紅點會一直盯著這件事，想修的時候再點「用聊天帶我修」。')
          return
        }
        const bad = res.checks.filter(x => x.status === 'broken' || x.status === 'mismatch')
        if (!bad.length) {
          c.state.exit = true
          const unknown = res.checks.filter(x => x.status === 'unknown')
          if (unknown.length) {
            r.card({ kind: 'status', state: 'skipped', text: `這次有 ${unknown.length} 個 LIFF 查不到登記狀態` })
            await r.say('剛剛查不到部分 LIFF 的狀態——<b>查不到不代表沒問題</b>，等幾分鐘再打開我檢查一次。')
          }
          else {
            r.card({ kind: 'status', state: 'ok', text: '剛查了一次，LIFF 登記都正常' })
            await r.say('看起來已經修好了（或剛剛自己恢復）✓ 沒有要做的事。')
          }
          return
        }
        if (!res.expectedUrl) {
          // 沒有正式網址就給不出「正確答案」——別亂教，指去設定頁（那邊有同一套檢查與說明）
          c.state.exit = true
          await r.say('系統這邊還沒設定正式網址，我給不出正確的登記網址。這種情況請到設定頁處理（那邊有完整的連線檢查）。')
          r.card({ kind: 'link', internal: true, label: '前往「組織與 LINE 設定」', href: `/admin/${c.workspaceId}/settings/organization?verify=liff` })
          return
        }
        c.state.expectedUrl = res.expectedUrl
        await r.say(`查到 ${bad.length} 個 LIFF 的登記網址有問題：<br>${bad.map(liffProblemLine).join('<br>')}`)
        await r.say('修法：到 LINE Developers 打開這個 LIFF，把 <b>Endpoint URL</b> 換成下面這串（活動頁專用網址），存檔。')
        r.card({ kind: 'copy', label: '正確的 Endpoint URL（活動頁專用）', value: res.expectedUrl })
        r.card({
          kind: 'help',
          summary: '怎麼改？',
          steps: [
            {
              text: '打開 LINE Developers 並登入',
              href: 'https://developers.line.biz/console/',
              hrefLabel: '打開 LINE Developers ↗',
            },
            {
              // 2026-09-02 補圖：這支修復劇本原本**一張圖都沒有**，而「要點 LINE Login
              // 那張、不是 Messaging API」正是整條路唯一反直覺的一步。
              // ⛔ 這裡刻意用靜態對照圖不用帶路動畫：動畫演到「按 Add 新增」，
              //    而修復的人是要**點進已經存在的那個** LIFF，演給他看反而教錯。
              text: '選掛著「LINE Login」小字的那張卡（⚠️跟拿鑰匙相反——LIFF 住在 LINE Login 頻道下），切到 LIFF 分頁',
              image: ONBOARDING_SHOTS.whichCardLiff,
              alt: '兩張同名卡片並排：右邊掛 LINE Login 小字的那張圈綠框，左邊掛 Messaging API 小字的那張圈紅框並打叉',
            },
            { text: '點進上面列出的那個 LIFF' },
            { text: 'Endpoint URL 換成剛剛那串，按 Update／存檔' },
          ],
        })
      },
    },
    {
      id: 'verify-loop',
      guard: exited,
      async run(c) {
        const { r } = c
        while (true) {
          const choice = await r.askChoices([
            { label: '改好了，幫我檢查', value: 'check', primary: true },
            { label: '先跳過', value: 'skip' },
          ])
          if (choice !== 'check') {
            await r.say('好。這個檢查不會消失——右下角的紅點會一直盯著，修好它就自己熄掉。也可以到設定頁修（進頁會自動檢查）。')
            r.card({ kind: 'link', internal: true, label: '前往「組織與 LINE 設定」', href: `/admin/${c.workspaceId}/settings/organization?verify=liff` })
            return
          }
          const cardId = r.card({ kind: 'status', state: 'pending', text: '正在跟 LINE 確認登記狀態…' })
          const res = await r.apiRetry(() => fetchLiffChecks(c), { failText: '查詢失敗', skipLabel: '先跳過' })
          if (!res) {
            r.updateMsg(cardId, { kind: 'status', state: 'skipped', text: '這次沒檢查成功（不代表沒修好）' })
            return
          }
          const bad = res.checks.filter(x => x.status === 'broken' || x.status === 'mismatch')
          const unknown = res.checks.filter(x => x.status === 'unknown')
          if (!bad.length && !unknown.length) {
            r.updateMsg(cardId, { kind: 'status', state: 'ok', text: '所有 LIFF 的登記都正常了' })
            await r.say('修好了 🎉 之後客人點活動連結就會直接打開活動頁。')
            return
          }
          if (!bad.length) {
            r.updateMsg(cardId, { kind: 'status', state: 'skipped', text: `${unknown.length} 個 LIFF 這次查不到` })
            await r.say('改過的都過了，剩下的這次查不到——<b>查不到不代表有問題</b>，過幾分鐘再檢查一次就好。')
            continue
          }
          r.updateMsg(cardId, { kind: 'status', state: 'fail', text: `還有 ${bad.length} 個沒過` })
          await r.say(`還沒過的：<br>${bad.map(liffProblemLine).join('<br>')}<br>最常見是<b>改完沒按存檔</b>、或改到別的 LIFF。再看一眼，好了再按檢查。`)
        }
      },
    },
  ],
}

// ── 還沒有活動頁（LIFF）──────────────────────────────────────────
// 與上面那條的分工：liff-endpoint 修「已經有 LIFF 但登記錯了」，
// 這條處理「根本還沒有 LIFF、活動連結點下去什麼都沒有」（D-19，2026-08-21 拍板）。

/** LIFF ID 長得像 2007123456-AbCdEfGh：純數字的 channel id ＋ 連字號 ＋ 一串英數 */
const LIFF_ID_RE = /^\d{8,}-[A-Za-z0-9]+$/

const liffSetupGuide: AgentGuideDef = {
  id: 'liff-setup',
  title: '設定活動頁（LIFF）',
  alertIds: ['liffMissing'],
  steps: [
    {
      id: 'explain-and-copy',
      async run(c) {
        const { r } = c
        await r.say('你有活動在跑，但還沒設定<b>活動頁</b>——客人在外面點活動連結會打不開，貼標和綁定都不會發生。設定一次就好，之後所有活動共用。大約三分鐘。')

        // 正確答案一律取後端口徑（publicBaseUrl），⛔別拿瀏覽器網址兜：
        // 正式網址有設的環境會教錯，那正是 2026-08-07 換網域災情的形狀
        let expectedUrl = ''
        const res = await r.apiRetry(
          () => c.apiFetch<LiffCheckRes>('/api/admin/liff-endpoint-check', { query: { force: 1 } }),
          { failText: '查詢活動頁網址失敗', skipLabel: '先不設' },
        )
        if (res) expectedUrl = String(res.expectedUrl || '').trim()
        if (!expectedUrl) {
          c.state.exit = true
          await r.say('系統這邊還沒設定正式網址，我給不出要填的活動頁網址。請到設定頁處理（那邊有完整的說明與檢查）。')
          r.card({ kind: 'link', internal: true, label: '前往「組織與 LINE 設定」', href: `/admin/${c.workspaceId}/settings/organization?focus=liff` })
          return
        }
        c.state.expectedUrl = expectedUrl

        await r.say('第一步：到 LINE 建一個活動頁，網址填下面這串。')
        r.card({ kind: 'copy', label: '活動頁網址（貼到 LINE 的 Endpoint URL）', value: expectedUrl })
        r.card({
          kind: 'help',
          summary: '怎麼建？',
          steps: [
            {
              text: '打開 LINE Developers 並登入',
              href: 'https://developers.line.biz/console/',
              hrefLabel: '打開 LINE Developers ↗',
            },
            {
              // ⚠️ 與「拿鑰匙」教學相反：那邊教人認 Messaging API、別點 LINE Login，
              // 這邊要點的正是 LINE Login。不明講的話兩份教學會互打
              // （2026-08-19 D-17 盤點抓到的雷）
              text: '選掛著「LINE Login」小字的那張卡 ——⚠️跟拿鑰匙那次相反，這次別點 Messaging API',
              image: ONBOARDING_SHOTS.liffSetupAnim,
              alt: '循環動畫：LINE Login 頻道的 LIFF 分頁、Add LIFF、貼 Endpoint URL',
            },
            { text: '切到「LIFF」分頁，按「Add」新增一個' },
            { text: 'Endpoint URL 貼上剛剛複製的那串網址；Size 選 Full；其餘照預設' },
            { text: '建好後，把清單上那串「LIFF ID」複製起來（長得像 2007123456-AbCdEfGh）' },
          ],
        })
      },
    },
    {
      id: 'save-and-verify',
      guard: exited,
      async run(c) {
        const { r } = c
        while (true) {
          const liffId = await r.askInput({
            inputType: 'text',
            placeholder: '例：2007123456-AbCdEfGh',
            maxLength: 60,
            skippable: true,
            skipLabel: '先跳過',
            validate: v => (LIFF_ID_RE.test(v.trim())
              ? null
              : '這串看起來不像 LIFF ID。它長得像 <b>2007123456-AbCdEfGh</b>（數字、連字號、一串英數），在 LIFF 分頁的清單上。'),
          })
          if (!liffId) {
            await r.say('好，先跳過。這顆紅點會一直在——它代表現在有客人點連結會打不開。想設定的時候再點「用聊天帶我修」，或直接到設定頁。')
            r.card({ kind: 'link', internal: true, label: '前往「組織與 LINE 設定」', href: `/admin/${c.workspaceId}/settings/organization?focus=liff` })
            return
          }

          const cardId = r.card({ kind: 'status', state: 'pending', text: '正在存起來…' })
          const saved = await r.apiRetry(
            () => c.apiFetch('/api/admin/line-workspace', {
              method: 'PUT',
              body: { defaultLiffId: liffId.trim() },
            }),
            { failText: '存檔失敗', skipLabel: '先跳過' },
          )
          if (!saved) {
            r.updateMsg(cardId, { kind: 'status', state: 'skipped', text: '這次沒存成功' })
            return
          }
          r.updateMsg(cardId, { kind: 'status', state: 'ok', text: '已存起來' })

          // ⛔ 存起來不等於會動：LIFF ID 打錯、或 LINE 那邊的 Endpoint URL 填成別的網址，
          // 客人照樣打不開。一定要真的回頭問 LINE 一次才敢說修好了。
          // 內層迴圈＝「去 LINE 改網址 → 回來再驗一次」，不必重問已經存好的 ID。
          while (true) {
            const checkId = r.card({ kind: 'status', state: 'pending', text: '正在跟 LINE 確認這個活動頁通不通…' })
            const check = await r.apiRetry(
              () => c.apiFetch<LiffCheckRes>('/api/admin/liff-endpoint-check', { query: { force: 1 } }),
              { failText: '查詢失敗', skipLabel: '先跳過' },
            )
            if (!check) {
              r.updateMsg(checkId, { kind: 'status', state: 'skipped', text: '這次查不到（不代表沒設好）' })
              await r.say('已經存起來了，只是這次問不到 LINE。<b>查不到不代表有問題</b>，過幾分鐘打開我再檢查一次。')
              return
            }
            const mine = check.checks.find(x => x.liffId === liffId.trim())
            if (!mine || mine.status === 'unknown') {
              r.updateMsg(checkId, { kind: 'status', state: 'skipped', text: '這次查不到這個活動頁的狀態' })
              await r.say('已經存起來了。這次沒問到 LINE 那邊的登記狀態——過幾分鐘再檢查一次就好。')
              return
            }
            if (mine.status === 'ok') {
              r.updateMsg(checkId, { kind: 'status', state: 'ok', text: '活動頁設定完成，連結打得開了' })
              await r.say('設好了 🎉 客人現在點活動連結會直接進到活動頁，貼標與綁定也會正常運作。')
              return
            }
            // broken / mismatch：ID 存對了，但那個 LIFF 在 LINE 登記的網址不是活動頁
            r.updateMsg(checkId, { kind: 'status', state: 'fail', text: 'LIFF 存好了，但 LINE 那邊填的網址不對' })
            await r.say(
              `這個 LIFF 在 LINE 登記的網址是 <b>${escapeHtml(mine.endpoint || '（空白）')}</b>，`
              + '不是活動頁。回到那個 LIFF 把 <b>Endpoint URL</b> 整串蓋掉成下面這串再存檔。',
            )
            r.card({ kind: 'copy', label: '活動頁網址', value: String(c.state.expectedUrl ?? '') })
            const again = await r.askChoices([
              { label: '改好了，再檢查一次', value: 'again', primary: true },
              { label: '先跳過', value: 'skip' },
            ])
            if (again !== 'again') {
              await r.say('好。右下角的紅點會一直盯著這件事，修好就自己熄掉。')
              return
            }
          }
        }
      },
    },
  ],
}

// ── 轉真人通知 ──────────────────────────────────────────────────
// 連結卡的 ?focus=handoff：AI 設定頁看到它會自動聚光「轉真人通知」那一卡＋儲存鈕
// （ai-settings.vue 進頁處理）。純連結會落在頁面頂端，人還得自己在長頁面裡找。

const handoffNotifyGuide: AgentGuideDef = {
  id: 'handoff-notify',
  title: '設定轉真人通知',
  alertIds: ['handoffNotifyMissing'],
  steps: [
    {
      id: 'pick-and-save',
      async run(c) {
        const { r } = c
        await r.say('現在 AI 接不住、或客人指名找真人時，<b>沒有人會收到通知</b>——客人可能等很久都沒人理。花一分鐘設定要通知誰。')
        await r.say('從你官方帳號的好友裡選一位（收通知的人必須加了這個官方帳號好友），之後隨時能在「AI 設定」加更多人。')

        r.busy.value = true
        let options: { id: string, label: string, pictureUrl?: string }[] = []
        try {
          const res = await c.apiFetch<{ users: { lineUserId?: string, displayName?: string, pictureUrl?: string }[] }>('/api/users/list?limit=20')
          options = (res.users || [])
            .map(u => ({
              id: String(u.lineUserId || '').trim(),
              label: String(u.displayName || '').trim() || '（未提供暱稱）',
              pictureUrl: String(u.pictureUrl || '').trim() || undefined,
            }))
            .filter(o => o.id)
            .slice(0, 8)
        }
        catch { /* 抓不到走下面的空清單出口 */ }
        finally {
          r.busy.value = false
        }

        if (!options.length) {
          c.state.exit = true
          await r.say('目前抓不到好友清單（通常是還沒有人加這個官方帳號好友）。先用手機加自己的官方帳號好友再回來設，或到「AI 設定」用完整的選人器。')
          r.card({ kind: 'link', internal: true, label: '前往「AI 設定」', href: `/admin/${c.workspaceId}/ai-settings?focus=handoff` })
          return
        }
        if (options.length >= 8)
          await r.say('下面列的是最近的好友。要通知的人不在裡面的話，按「先跳過」，到「AI 設定 → 轉真人通知」有完整的搜尋選人。')

        const picked = await r.askPicker(options, true)
        if (!picked) {
          c.state.exit = true
          await r.say('先跳過。提醒一下：通知沒設的話，客人要找真人時不會有人知道。')
          r.card({ kind: 'link', internal: true, label: '前往「AI 設定」', href: `/admin/${c.workspaceId}/ai-settings?focus=handoff` })
          return
        }
        const ok = await r.apiRetry(
          () => c.apiFetch('/api/ai/settings', {
            method: 'PUT',
            body: {
              handoffNotify: {
                enabled: true,
                lineUserIds: [picked.id],
                displayNames: { [picked.id]: picked.label },
              },
            },
          }),
          { failText: '存檔失敗', skipLabel: '先跳過' },
        )
        if (ok === null) {
          c.state.exit = true
          return
        }
        c.state.pickedLabel = picked.label
      },
    },
    {
      id: 'verify',
      guard: exited,
      async run(c) {
        const { r } = c
        // 存檔成功不等於生效：跟後端把設定要回來驗一次（agent 只轉述真實訊號）
        const cardId = r.card({ kind: 'status', state: 'pending', text: '確認設定有沒有生效…' })
        try {
          const s = await c.apiFetch<{ handoffNotify?: { enabled?: boolean, lineUserIds?: string[] } }>('/api/ai/settings')
          if (s.handoffNotify?.enabled === true && (s.handoffNotify?.lineUserIds?.length ?? 0) > 0) {
            r.updateMsg(cardId, { kind: 'status', state: 'ok', text: '轉真人通知已設定' })
            await r.say(`設好了 ✓ 之後有客人要找真人，「${escapeHtml(String(c.state.pickedLabel || ''))}」的 LINE 會跳通知。想加更多人，到「AI 設定 → 轉真人通知」。`)
            return
          }
          r.updateMsg(cardId, { kind: 'status', state: 'fail', text: '設定看起來還沒生效' })
          await r.say('剛存的設定讀回來還是空的——請到「AI 設定 → 轉真人通知」看一眼。')
          r.card({ kind: 'link', internal: true, label: '前往「AI 設定」', href: `/admin/${c.workspaceId}/ai-settings?focus=handoff` })
        }
        catch {
          r.updateMsg(cardId, { kind: 'status', state: 'skipped', text: '這次沒確認成功（不代表沒設好）' })
          await r.say('跟伺服器確認沒成功——<b>查不到不代表沒設好</b>，右下角的提醒若熄掉就是生效了。')
        }
      },
    },
  ],
}

// ── 知識來源同步失敗 ────────────────────────────────────────────

interface SourceListRes {
  items: { name?: string, status?: string, failureReason?: string }[]
}

function failedSourceLines(items: SourceListRes['items']): string {
  const failed = items.filter(i => i.status === 'failed')
  return failed.slice(0, 5)
    .map(i => `・<b>${escapeHtml(String(i.name || '(未命名)'))}</b>${i.failureReason ? `：${escapeHtml(String(i.failureReason).slice(0, 60))}` : ''}`)
    .join('<br>') + (failed.length > 5 ? `<br>…共 ${failed.length} 份` : '')
}

const knowledgeSyncGuide: AgentGuideDef = {
  id: 'knowledge-sync',
  title: '修好同步失敗的資料',
  alertIds: ['knowledgeSyncFailed'],
  steps: [
    {
      id: 'diagnose',
      async run(c) {
        const { r } = c
        await r.say('資料同步失敗時，AI 讀到的內容會停在失敗前那一版——客人問到相關問題，會拿到<b>過時或空的答案</b>。')
        const res = await r.apiRetry(() => c.apiFetch<SourceListRes>('/api/ai/sources/list'), { failText: '查詢知識庫失敗', skipLabel: '先不修' })
        if (!res) {
          c.state.exit = true
          return
        }
        const failed = res.items.filter(i => i.status === 'failed')
        if (!failed.length) {
          c.state.exit = true
          r.card({ kind: 'status', state: 'ok', text: '剛查了一次，沒有同步失敗的資料' })
          await r.say('看起來已經恢復了 ✓ 可能剛剛重新同步成功，沒有要做的事。')
          return
        }
        await r.say(`現在有 <b>${failed.length} 份</b>資料同步失敗：<br>${failedSourceLines(res.items)}`)
        await r.say('點下面進知識庫，我幫你篩好「有問題的資料」清單——通常按<b>重新同步</b>就會好；若原因寫網址失效或權限問題，先照原因處理再同步。')
        r.card({ kind: 'link', internal: true, label: '去修這些資料（已篩好清單）', href: `/admin/${c.workspaceId}/knowledge/sources?health=failedSources` })
      },
    },
    {
      id: 'verify-loop',
      guard: exited,
      async run(c) {
        const { r } = c
        while (true) {
          const choice = await r.askChoices([
            { label: '修好了，幫我確認', value: 'check', primary: true },
            { label: '先跳過', value: 'skip' },
          ])
          if (choice !== 'check') {
            await r.say('好。右下角的紅點會一直盯著這件事，全部修好就自己熄掉。')
            return
          }
          const cardId = r.card({ kind: 'status', state: 'pending', text: '重新確認同步狀態…' })
          const res = await r.apiRetry(() => c.apiFetch<SourceListRes>('/api/ai/sources/list'), { failText: '查詢失敗', skipLabel: '先跳過' })
          if (!res) {
            r.updateMsg(cardId, { kind: 'status', state: 'skipped', text: '這次沒確認成功（不代表沒修好）' })
            return
          }
          const failed = res.items.filter(i => i.status === 'failed')
          if (!failed.length) {
            r.updateMsg(cardId, { kind: 'status', state: 'ok', text: '同步失敗已全部排除' })
            await r.say('都恢復了 🎉 AI 現在讀得到最新內容。')
            return
          }
          r.updateMsg(cardId, { kind: 'status', state: 'fail', text: `還有 ${failed.length} 份沒好` })
          await r.say(`還沒好的：<br>${failedSourceLines(res.items)}<br>剛按重新同步的話要等它跑完（清單會顯示進度），過一下再按確認。`)
        }
      },
    },
  ],
}

// ── 放進第一份知識（D-40） ──────────────────────────────────────
/**
 * 這條不是「修壞掉的東西」，是**從零到 AI 真的答得出一題**的那一段旅程。
 *
 * 為什麼要有：08-19 拍板把知識庫移出開通引導（當時知識庫是空的，開了 AI 也只會答不出來，
 * 判斷正確），說好由小幫手的開通清單接手——但清單只是指路，指完就沒有下文了。
 * 08-28 的初次上手評估把「開通完成 → AI 真的會回答」列為未接缺口第一名，這條就是接它。
 *
 * 形式為什麼是劇本不是導覽（08-17 拍板的分工）：這件事做完之後**後端驗得出來**
 * （知識庫有沒有內容、AI 開關、試答），凡是有真訊號可驗的任務都走劇本。
 *
 * ⛔ 不重講匯入視窗裡已經有的說明（那一段的就地說明是全站密度最高的）：
 *    劇本只負責「帶到那裡 → 等真的做完 → 確認 AI 真的學會 → 補上最後一哩」。
 *    教材同一份寫兩處，之後必漂。
 */
interface KnowledgeCountRes {
  items: { chunkCount?: number }[]
}

async function knowledgeChunkTotal(c: AgentGuideCtx): Promise<number | null> {
  try {
    const res = await c.apiFetch<KnowledgeCountRes>('/api/ai/sources/list')
    return res.items.reduce((sum, i) => sum + Number(i.chunkCount ?? 0), 0)
  }
  catch {
    // ⛔查不到 ≠ 沒有：回 null 讓呼叫端自己決定怎麼講，不要當成 0
    return null
  }
}

const knowledgeFirstGuide: AgentGuideDef = {
  id: 'knowledge-first',
  title: '帶你放進第一份知識',
  // 這條不對應任何異常——它是「還沒開始」不是「壞了」。入口在開通清單的「建立知識庫」。
  alertIds: [],
  steps: [
    {
      id: 'intro',
      async run(c) {
        const { r } = c
        const total = await knowledgeChunkTotal(c)
        // 已經有東西了就不要假裝從零開始（也不要因為查不到就亂講）
        if (total !== null && total > 0) {
          c.state.exit = true
          r.card({ kind: 'status', state: 'ok', text: `知識庫裡已經有 ${total} 條知識` })
          await r.say('你的知識庫已經有內容了，這條「從零開始」的帶路就不用跑。想再放一份資料進來，直接用知識庫頁右上的「加入知識」就好。')
          r.card({ kind: 'link', internal: true, label: '去知識庫看看', href: `/admin/${c.workspaceId}/knowledge/sources` })
          return
        }
        await r.say('知識庫就是 <b>AI 回答客人時的依據</b>——你放什麼進去，它才答得出什麼。<b>沒放進來的事，AI 不會自己編</b>（它會轉給真人，不會亂掰）。')
        await r.say('我帶你放第一份進去，大約 5 分鐘。<b>不用先準備完美的資料</b>：常見問答、價目表、商品說明，手邊有什麼就先放什麼，之後隨時能加。')
      },
    },
    {
      id: 'open-import',
      guard: exited,
      async run(c) {
        const { r } = c
        await r.say('點下面這顆，我直接幫你把「加入知識」的視窗打開。裡面每一種資料該注意什麼，視窗上都會講——<b>你照著做就好，我在這裡等你</b>。')
        r.card({
          kind: 'link',
          internal: true,
          label: '打開「加入知識」',
          // ?import=1＝知識庫頁進頁自動開匯入視窗（既有參數，不是為這條劇本新做的）
          href: `/admin/${c.workspaceId}/knowledge/sources?import=1`,
        })
        await r.say('小提醒：<b>檔案和貼上的文字是「當下固定」</b>，之後改了要重新放；<b>Google 試算表會自動跟著更新</b>。常常要改的價目表、商品清單，用試算表最省事。')
      },
    },
    {
      id: 'wait-for-knowledge',
      guard: exited,
      async run(c) {
        const { r } = c
        while (true) {
          const choice = await r.askChoices([
            { label: '我放好了，幫我確認', value: 'check', primary: true },
            { label: '先跳過', value: 'skip', escape: true },
          ])
          if (choice !== 'check') {
            c.state.exit = true
            await r.say('好，先跳過。想繼續的時候，右下角小幫手的「建立知識庫」還會在那裡等你。')
            return
          }
          const cardId = r.card({ kind: 'status', state: 'pending', text: '看看知識庫裡有沒有東西了…' })
          const total = await knowledgeChunkTotal(c)
          if (total === null) {
            // ⛔查不到就照實說「查不到」，不要說成「你還沒放」——那是兩件不同的事
            r.updateMsg(cardId, { kind: 'status', state: 'skipped', text: '這次沒查成功（不代表你沒放進去）' })
            await r.say('剛剛查不到知識庫的狀態，網路或系統忙一下就會好。可以再按一次確認。')
            continue
          }
          if (total > 0) {
            r.updateMsg(cardId, { kind: 'status', state: 'ok', text: `知識庫裡有 ${total} 條知識了` })
            c.state.chunkTotal = total
            await r.say(`收到，<b>${total} 條</b>知識進去了 🎉`)
            return
          }
          r.updateMsg(cardId, { kind: 'status', state: 'fail', text: '知識庫還是空的' })
          await r.say('還沒看到內容耶。匯入要跑一小段時間（AI 要把資料整理成一條條問答），<b>如果視窗還在跑就等它跑完</b>；已經跑完的話，記得最後要按<b>「直接匯入 N 條」</b>那一顆，光是預覽不會存進去。')
        }
      },
    },
    {
      id: 'verify-answerable',
      guard: exited,
      async run(c) {
        const { r } = c
        await r.say('進庫不等於學會。我用一句話真的問 AI 一次，確認它答得出來——<b>這次試問不計費、也不會算進統計</b>。')
        const q = await r.askInput({
          inputType: 'text',
          placeholder: '例：你們幾點營業',
          maxLength: 100,
          skippable: true,
          skipLabel: '先不試問',
        })
        if (!q) {
          await r.say('好，那就先不試。之後想確認的話，「測試對話」那一頁隨時可以問。')
          return
        }
        const cardId = r.card({ kind: 'status', state: 'pending', text: `問 AI：「${escapeHtml(q)}」…` })
        const res = await r.apiRetry(
          () => c.apiFetch<{ timedOut: boolean, decision: string }>('/api/ai/knowledge/verify', { method: 'POST', body: { query: q } }),
          { failText: '試問沒跑成功', skipLabel: '先跳過' },
        )
        if (!res) {
          r.updateMsg(cardId, { kind: 'status', state: 'skipped', text: '這次沒問成功（不影響已匯入的知識）' })
          return
        }
        const outcome = kbVerifyOutcome({ query: q, timedOut: res.timedOut, decision: res.decision })
        r.updateMsg(cardId, {
          kind: 'status',
          state: outcome.tone === 'ok' ? 'ok' : 'fail',
          text: outcome.tone === 'ok' ? 'AI 答得出來' : 'AI 還答不出這一題',
        })
        await r.say(escapeHtml(outcome.text))
        if (outcome.tone !== 'ok') {
          await r.say('這很常見，通常是<b>客人的問法跟你寫的標題差太多</b>。到那一條知識裡補上「客人可能怎麼問」，答對率會馬上不一樣。')
          r.card({ kind: 'link', internal: true, label: '去知識庫補問法', href: `/admin/${c.workspaceId}/knowledge/sources` })
        }
      },
    },
    {
      id: 'last-mile-ai-switch',
      guard: exited,
      async run(c) {
        const { r } = c
        // 最後一哩：知識放好了但總開關關著＝客人完全感覺不到。
        // 這正是匯入完成當下最容易漏掉的一步（同 D-40 交棒卡）。
        const settings = await r.apiRetry(
          () => c.apiFetch<{ enabled?: boolean }>('/api/ai/settings'),
          { failText: '查 AI 設定失敗', skipLabel: '先跳過' },
        )
        if (!settings) {
          await r.say('沒查到 AI 開關的狀態——記得到「AI 設定」確認它是開著的，客人才聽得到這些內容。')
          return
        }
        if (settings.enabled === true) {
          r.card({ kind: 'status', state: 'ok', text: 'AI 客服是開啟的' })
          await r.say('都到位了 🎉 知識放好了、AI 也開著，客人問到相關問題就會用上這些內容。之後想加資料，隨時回知識庫按「加入知識」。')
          return
        }
        r.card({ kind: 'status', state: 'fail', text: 'AI 客服還沒開啟' })
        await r.say('還差最後一步：<b>AI 客服的總開關還關著</b>，所以剛剛放進去的知識目前不會用在回覆客人上。開了才算真的上線。')
        r.card({ kind: 'link', internal: true, label: '去開啟 AI 客服', href: `/admin/${c.workspaceId}/ai-settings` })
      },
    },
  ],
}

// ── LINE 收訊（Webhook） ────────────────────────────────────────
// 兩顆紅燈共用：lineWebhookBroken（已斷）與 lineWebhookUrlMismatch（快斷）。
// 驗證一律 runTest:false——查設定是免費 GET；「請 LINE 真的發一則測試訊息」有次數上限，
// 那顆留在設定頁的「測試連線」。劇本的連結卡帶 ?focus=webhook／?focus=token，
// 設定頁看到會用聚光燈（ad-hoc tour）指出要按哪裡（organization.vue 進頁處理）。

/** line-webhook-verify 端點回應的子集（劇本只看這幾格，完整定義在 server 端點檔） */
interface WebhookVerifyRes {
  getOk: boolean
  getStatus?: number
  lineEndpoint: string | null
  lineActive: boolean | null
  urlMatchesCompare: boolean | null
  endpointUnreachable: boolean | null
}

export type LineWebhookProblem =
  | { kind: 'token' } // LINE 不認得 Channel Access Token（401，多半是被重發過）
  | { kind: 'nourl' } // LINE 後台還沒填 Webhook URL（404）
  | { kind: 'inactive' } // 網址有填但 Use webhook 開關沒開
  | { kind: 'mismatch', endpoint: string, unreachable: boolean } // 填的不是正式網址
  | { kind: 'unknown' } // 查不到：不下結論（誠實三態）
  | { kind: 'ok' }

/** 分診順序照後端 workspace-alerts 同一把尺：token → 沒網址 → 開關 → 網址不一致 */
export function classifyLineWebhook(res: WebhookVerifyRes): LineWebhookProblem {
  if (!res.getOk) {
    if (res.getStatus === 401)
      return { kind: 'token' }
    if (res.getStatus === 404)
      return { kind: 'nourl' }
    return { kind: 'unknown' }
  }
  if (res.lineActive === false)
    return { kind: 'inactive' }
  if (res.urlMatchesCompare === false)
    return { kind: 'mismatch', endpoint: String(res.lineEndpoint || ''), unreachable: res.endpointUnreachable === true }
  return { kind: 'ok' }
}

const LINE_CONSOLE_LINK = {
  href: 'https://developers.line.biz/console/',
  hrefLabel: '打開 LINE Developers ↗',
} as const

/** 設定頁連結卡：?focus= 讓設定頁進頁用聚光燈指位（webhook＝複製網址＋測試連線；token＝貼 Token＋儲存） */
function orgFocusCard(c: AgentGuideCtx, focus: 'webhook' | 'token', label: string) {
  c.r.card({ kind: 'link', internal: true, label, href: `/admin/${c.workspaceId}/settings/organization?focus=${focus}` })
}

/**
 * 查一次 Webhook 設定（不發測試訊息）。'no-token'＝系統這邊連 Token 都沒存，
 * 再重試也不會好，要走「先把 Token 存回來」的出口而不是 retry 迴圈。
 */
async function fetchWebhookVerify(c: AgentGuideCtx, compareUrl: string): Promise<WebhookVerifyRes | 'no-token' | null> {
  return c.r.apiRetry(async () => {
    try {
      return await c.apiFetch<WebhookVerifyRes>('/api/admin/line-webhook-verify', {
        method: 'POST',
        body: { compareUrl, runTest: false },
      })
    }
    catch (e: unknown) {
      const err = e as { statusCode?: number, status?: number, data?: { statusCode?: number } }
      if ((err?.statusCode ?? err?.status ?? err?.data?.statusCode) === 400)
        return 'no-token' as const
      throw e
    }
  }, { failText: '查詢 Webhook 狀態失敗', skipLabel: '先不修' })
}

/** Token 失效的修法（診斷與驗證迴圈都可能走到）：教重發＋聚光燈連結卡，走完即收工 */
async function adviseTokenReissue(c: AgentGuideCtx) {
  const { r } = c
  await r.say('修法分兩步：先去 LINE 重發一把新鑰匙，再回系統貼上。')
  r.card({
    kind: 'help',
    summary: '怎麼重發？',
    steps: [
      {
        text: '打開 LINE Developers 並登入',
        href: 'https://developers.line.biz/console/',
        hrefLabel: '打開 LINE Developers ↗',
      },
      {
        // 同名卡片可能有兩張（Messaging API／LINE Login），認小字不認名稱——
        // 點錯那張拿到的是另一把不能用的鑰匙
        text: '選掛著「Messaging API」小字的那張卡（同名可能有兩張，認小字不認名稱）',
        image: ONBOARDING_SHOTS.consoleChannel,
        alt: '帳號清單頁，圈出卡片下方的 Messaging API 小字',
      },
      {
        text: '切到 Messaging API 分頁，捲到最下方，Channel access token 按「Reissue」（沒發過就按 Issue）',
        image: ONBOARDING_SHOTS.issueToken,
        alt: 'Messaging API 分頁最下方，圈出重發 Channel access token 的按鈕',
      },
      { text: '整串複製' },
    ],
    ...LINE_CONSOLE_LINK,
  })
  await r.say('複製好之後，點下面這張卡到設定頁——我會用聚光燈指給你看要貼哪一格、按哪顆儲存。存檔後右下角的紅點修好就自己熄掉。')
  orgFocusCard(c, 'token', '去設定頁貼新 Token（我會指位置）')
  c.state.exit = true
}

const lineWebhookGuide: AgentGuideDef = {
  id: 'line-webhook',
  title: '修好 LINE 收訊（Webhook）',
  alertIds: ['lineWebhookBroken', 'lineWebhookUrlMismatch'],
  steps: [
    {
      id: 'diagnose',
      async run(c) {
        const { r } = c
        await r.say('這顆紅燈關係到<b>客人的訊息進不進得來系統</b>。我先跟 LINE 實際查一次設定，看是哪裡出了問題。')

        // 正確答案（正式 webhook 網址）先查 publicBaseUrl，拿不到才退回瀏覽器網址——
        // 與開通精靈同一套：直接兜瀏覽器網址，在正式網址有設的環境會教錯
        let base = ''
        try {
          const ws = await c.apiFetch<{ publicBaseUrl?: string }>('/api/admin/line-workspace')
          base = String(ws?.publicBaseUrl || '').trim()
        }
        catch { /* 拿不到走瀏覽器網址保底 */ }
        const webhookUrl = `${base || (typeof window === 'undefined' ? '' : window.location.origin)}/webhook`
        c.state.webhookUrl = webhookUrl

        const res = await fetchWebhookVerify(c, webhookUrl)
        if (!res) {
          c.state.exit = true
          await r.say('好，先不修。右下角的紅點會一直盯著這件事，想修的時候再點「用聊天帶我修」。')
          return
        }
        if (res === 'no-token') {
          c.state.exit = true
          await r.say('系統這邊<b>還沒存 LINE 的鑰匙</b>（Channel Access Token），要先把它存回來才談得到收訊息。點下面這張卡，我會在設定頁指給你看要貼哪裡。')
          orgFocusCard(c, 'token', '去設定頁存 Token（我會指位置）')
          return
        }

        const p = classifyLineWebhook(res)
        switch (p.kind) {
          case 'ok': {
            c.state.exit = true
            r.card({ kind: 'status', state: 'ok', text: '剛查了一次，LINE 的 Webhook 設定正常' })
            await r.say('看起來已經修好了（或剛剛自己恢復）✓ 想再保險一點，到設定頁按「<b>測試連線</b>」請 LINE 真的發一則測試訊息——點下面這張卡，我會指給你看在哪。')
            orgFocusCard(c, 'webhook', '到設定頁測試連線（我會指位置）')
            return
          }
          case 'unknown': {
            c.state.exit = true
            r.card({ kind: 'status', state: 'skipped', text: '這次查不到 LINE 那邊的狀態（不代表壞掉）' })
            await r.say('跟 LINE 查詢沒成功——<b>查不到不代表有問題</b>，等幾分鐘再打開我檢查一次。')
            return
          }
          case 'token': {
            await r.say('查到了：LINE <b>不認得我們手上的鑰匙</b>（Channel Access Token 失效，多半是被重發過）。這段時間訊息進不來，機器人也發不出去。')
            await adviseTokenReissue(c)
            return
          }
          case 'nourl': {
            await r.say('查到了：LINE 後台<b>還沒填收訊網址（Webhook URL）</b>——客人傳的訊息，LINE 不知道要送去哪，全部進不來。照下面的步驟接上。')
            r.card({ kind: 'copy', label: '你的 Webhook 網址', value: webhookUrl })
            r.card({
              kind: 'help',
              summary: '怎麼貼？',
              steps: [
                {
                  text: '打開 LINE Developers 並登入',
                  href: 'https://developers.line.biz/console/',
                  hrefLabel: '打開 LINE Developers ↗',
                },
                { text: '選你的官方帳號 → Messaging API 分頁' },
                {
                  text: 'Webhook URL 按「Edit」打開輸入格，貼上上面那串，按「Update」存檔',
                  image: ONBOARDING_SHOTS.webhookUrl,
                  alt: 'Messaging API 分頁，圈出 Webhook URL 欄位、Update 按鈕與 Use webhook 開關',
                },
                { text: '同一區把「Use webhook」開關打開' },
              ],
              ...LINE_CONSOLE_LINK,
            })
            return
          }
          case 'inactive': {
            await r.say('查到了：網址有填，但「<b>Use webhook</b>」開關沒打開——等於門牌掛了、門沒開，訊息還是進不來。')
            r.card({
              kind: 'help',
              summary: '怎麼開？',
              steps: [
                { text: '打開 LINE Developers → 你的官方帳號 → Messaging API 分頁' },
                {
                  text: 'Webhook URL 欄位下方找到「Use webhook」，打開它',
                  image: ONBOARDING_SHOTS.webhookUrl,
                  alt: 'Messaging API 分頁，圈出 Use webhook 開關的位置',
                },
              ],
              ...LINE_CONSOLE_LINK,
            })
            return
          }
          case 'mismatch': {
            await r.say(
              `查到了：LINE 後台填的收訊網址是<br><b>${escapeHtml(p.endpoint || '（空白）')}</b><br>`
              + (p.unreachable
                ? '而且那個網址<b>已經連不上</b>——訊息現在就進不來。把它換成下面這串正式網址。'
                : '不是這套系統的正式網址。訊息目前可能還進得來，但那個網址一停用就會<b>無聲斷掉</b>——趁還沒斷，換成下面這串。'),
            )
            r.card({ kind: 'copy', label: '正確的 Webhook 網址', value: webhookUrl })
            r.card({
              kind: 'help',
              summary: '怎麼換？',
              steps: [
                { text: '打開 LINE Developers → 你的官方帳號 → Messaging API 分頁' },
                {
                  text: 'Webhook URL 按「Edit」，整串蓋掉換成上面那串（不要留舊的），按「Update」存檔',
                  image: ONBOARDING_SHOTS.webhookUrl,
                  alt: 'Messaging API 分頁，圈出 Webhook URL 欄位與 Update 按鈕',
                },
              ],
              ...LINE_CONSOLE_LINK,
            })
          }
        }
      },
    },
    {
      id: 'verify-loop',
      guard: exited,
      async run(c) {
        const { r } = c
        const webhookUrl = String(c.state.webhookUrl || '')
        while (true) {
          const choice = await r.askChoices([
            { label: '改好了，幫我檢查', value: 'check', primary: true },
            { label: '先跳過', value: 'skip' },
          ])
          if (choice !== 'check') {
            await r.say('好。右下角的紅點會一直盯著這件事，修好它就自己熄掉。想在畫面上被指一次位置，點下面這張卡。')
            orgFocusCard(c, 'webhook', '到設定頁看 Webhook 位置（我會指給你）')
            return
          }
          const cardId = r.card({ kind: 'status', state: 'pending', text: '正在跟 LINE 確認 Webhook 設定…' })
          const res = await fetchWebhookVerify(c, webhookUrl)
          if (!res) {
            r.updateMsg(cardId, { kind: 'status', state: 'skipped', text: '這次沒檢查成功（不代表沒修好）' })
            return
          }
          if (res === 'no-token') {
            r.updateMsg(cardId, { kind: 'status', state: 'fail', text: '系統這邊的 Token 不見了' })
            await r.say('設定頁存的 Channel Access Token 被清掉了——要先把 Token 存回來。點下面這張卡，我會指給你看貼哪裡。')
            orgFocusCard(c, 'token', '去設定頁存 Token（我會指位置）')
            return
          }
          const p = classifyLineWebhook(res)
          if (p.kind === 'ok') {
            r.updateMsg(cardId, { kind: 'status', state: 'ok', text: 'Webhook 已接通，設定都對了' })
            await r.say('修好了 🎉 LINE 之後會把客人的訊息送進系統。想再保險一點，到設定頁按「<b>測試連線</b>」請 LINE 真的發一則測試訊息（有次數限制，別連續猛按）。')
            orgFocusCard(c, 'webhook', '到設定頁測試連線（我會指位置）')
            return
          }
          if (p.kind === 'unknown') {
            r.updateMsg(cardId, { kind: 'status', state: 'skipped', text: '這次查不到（不代表沒修好）' })
            await r.say('跟 LINE 查詢沒成功——<b>查不到不代表沒修好</b>，等幾分鐘再按一次檢查。')
            continue
          }
          if (p.kind === 'token') {
            r.updateMsg(cardId, { kind: 'status', state: 'fail', text: 'LINE 不認得目前的 Token' })
            await r.say('這次查出來是 <b>Token 失效</b>（可能剛剛在 LINE 那邊被重發過）。')
            await adviseTokenReissue(c)
            return
          }
          if (p.kind === 'nourl') {
            r.updateMsg(cardId, { kind: 'status', state: 'fail', text: 'LINE 後台還是沒有 Webhook 網址' })
            await r.say('最常見是貼了但<b>沒按 Update／存檔</b>。再貼一次、存檔，好了再按檢查。')
            continue
          }
          if (p.kind === 'inactive') {
            r.updateMsg(cardId, { kind: 'status', state: 'fail', text: '「Use webhook」開關還沒打開' })
            await r.say('網址有了，剩下把開關打開——就在 Webhook URL 欄位下面。開了再按檢查。')
            continue
          }
          // mismatch
          r.updateMsg(cardId, { kind: 'status', state: 'fail', text: 'LINE 填的還是別的網址' })
          await r.say(`現在填的是 <b>${escapeHtml(p.endpoint || '（空白）')}</b>。再複製一次、<b>整串蓋掉</b>貼上並按 Update／存檔，好了再按檢查。`)
        }
      },
    },
  ],
}

// ── 按鈕指到已刪除／已停用的模組 ────────────────────────────────
// C-87（2026-08-27 老闆拍板「執行二」）：這顆異常的修法要人做選擇（改指到哪個模組），
// 一鍵修給不了合理預設——所以走對話：列壞在哪、白名單挑新指向、代改、當場重查。
// ⛔模組選項只能來自後端白名單（劇本零 LLM，本來也沒有模型能生 ID）。

// 回應合約與面向標籤都吃 shared（⛔別在這裡再宣告一份：欄位改名時兩邊各自編譯得過、
// 畫面才靜靜壞掉；標籤各寫一份會讓異常卡與劇本在同一畫面用兩套稱呼）
function brokenPlaceLines(refs: BrokenModuleRefRow[]): string {
  return refs.slice(0, 6)
    .map(r => `・${ALERT_SCOPE_LABELS[r.sourceKind] ?? '設定'}「<b>${escapeHtml(r.sourceLabel)}</b>」`)
    .join('<br>') + (refs.length > 6 ? `<br>…共 ${refs.length} 處` : '')
}

async function fetchBrokenFix(c: AgentGuideCtx): Promise<BrokenModuleFixState | null> {
  return c.r.apiRetry(() => c.apiFetch<BrokenModuleFixState>('/api/admin/broken-module-fix'), {
    failText: '查詢壞掉的按鈕失敗',
    skipLabel: '先不修',
  })
}

/** 圖文選單頁的連結卡＋為什麼代改不了的說明（兩處會用到，話術只留一份） */
function richmenuRepublishCard(c: AgentGuideCtx, menuNames: string[]) {
  return c.r.say(
    `⚠️ 圖文選單「<b>${menuNames.map(escapeHtml).join('」、「')}</b>」的按鈕我改不動——選單的按鈕是`
    + '<b>發佈時燒進 LINE</b> 的，只改後台資料，客人按線上那顆還是沒反應。要到選單頁把那顆按鈕'
    + '改好、<b>重新發佈</b>才會生效。',
  ).then(() => {
    c.r.card({ kind: 'link', internal: true, label: '前往「圖文選單」', href: `/admin/${c.workspaceId}/richmenu` })
  })
}

/**
 * 「挑一個模組改指過去」的共用流程：刪掉的模組、以及使用者選擇不復活的停用模組都走這裡。
 * 只被圖文選單引用時直接短路——那種情況代改一定是 no-op，走完挑選只會白忙一趟
 * 還在稽核留下一筆「改了 0 筆」的紀錄。
 */
async function repointBrokenGroup(
  c: AgentGuideCtx,
  modules: BrokenModuleFixState['modules'],
  moduleId: string,
  refs: BrokenModuleRefRow[],
): Promise<void> {
  const { r } = c
  const menuNames = [...new Set(refs.filter(x => x.sourceKind === 'richmenu').map(x => x.sourceLabel))]
  if (refs.every(x => x.sourceKind === 'richmenu')) {
    await richmenuRepublishCard(c, menuNames)
    return
  }
  if (!modules.length) {
    await r.say('目前<b>沒有任何啟用中的模組</b>可以指過去——先到「機器人模組」建一個（或把要用的模組打開），再回來點我。')
    r.card({ kind: 'link', internal: true, label: '前往「機器人模組」', href: `/admin/${c.workspaceId}/flow` })
    return
  }
  if (modules.length > 8)
    await r.say('下面列前 8 個模組；要指的不在裡面就按「先跳過」，到各設定頁自己改。')
  const picked = await r.askPicker(modules.slice(0, 8).map(m => ({ id: m.id, label: m.name })), true)
  if (!picked) {
    await r.say('好，這組先跳過。紅點會一直盯著，修好就自己熄掉。')
    return
  }
  const cardId = r.card({ kind: 'status', state: 'pending', text: `正在把按鈕改指到「${picked.label}」…` })
  const done = await r.apiRetry(
    () => c.apiFetch<BrokenModuleRepointResult>('/api/admin/broken-module-fix', {
      method: 'POST',
      body: { action: 'repoint', fromModuleId: moduleId, toModuleId: picked.id },
    }),
    { failText: '改指向失敗', skipLabel: '先跳過這組' },
  )
  if (!done) {
    r.updateMsg(cardId, { kind: 'status', state: 'skipped', text: '這組先跳過（沒有動到任何設定）' })
    return
  }
  const parts: string[] = []
  if (done.scripts) parts.push(`${done.scripts} 條客服流程`)
  if (done.campaigns) parts.push(`${done.campaigns} 個活動`)
  if (done.flows) parts.push(`${done.flows} 個模組的圖文訊息`)
  r.updateMsg(cardId, {
    kind: 'status',
    state: 'ok',
    text: `已把 ${parts.join('、')} 改指到「${done.toName}」`,
  })
  // 停用中的設定也一起改了，但它不在使用者剛看到的清單上——如實講，別讓數字對不上
  if (done.hiddenDisabled)
    await r.say(`另外順手改了 ${done.hiddenDisabled} 個<b>目前停用中</b>的設定（之後打開就不會又是壞按鈕）。`)
  if (done.richmenus.length)
    await richmenuRepublishCard(c, done.richmenus)
}

const brokenModuleGuide: AgentGuideDef = {
  id: 'broken-module',
  title: '修好沒反應的按鈕',
  alertIds: ['brokenModuleButton'],
  steps: [
    {
      id: 'fix-loop',
      async run(c) {
        const { r } = c
        await r.say('這些按鈕客人按下去<b>什麼都不會收到</b>，也不會看到錯誤——只會覺得壞了。我帶你一組一組修。')
        const res = await fetchBrokenFix(c)
        if (!res) {
          c.state.exit = true
          await r.say('好，先不修。右下角的紅點會一直盯著這件事，想修的時候再點「用聊天帶我修」。')
          return
        }
        if (!res.refs.length) {
          c.state.exit = true
          r.card({ kind: 'status', state: 'ok', text: '剛查了一次，沒有按鈕指向壞掉的模組' })
          await r.say('看起來已經修好了（或有人剛處理過）✓ 沒有要做的事。')
          return
        }

        // 同一顆壞模組被多處引用＝同一個決定，一組一起處理
        const byModule = new Map<string, BrokenModuleRefRow[]>()
        for (const ref of res.refs) {
          const list = byModule.get(ref.moduleId) ?? []
          list.push(ref)
          byModule.set(ref.moduleId, list)
        }

        for (const [moduleId, refs] of byModule) {
          const first = refs[0]!
          if (first.reason === 'inactive') {
            // 模組還在只是停用。重新啟用最省事，但**不能是唯一選項**：季節性活動刻意停用的
            // 模組如果被按鈕指著，復活它等於把過期內容重新送給客人——那種情況要改指到別處。
            await r.say(`這幾個地方的按鈕指向模組「<b>${escapeHtml(first.moduleName || moduleId)}</b>」——它還在，只是<b>被停用了</b>：<br>${brokenPlaceLines(refs)}`)
            const choice = await r.askChoices([
              { label: '重新啟用這個模組', value: 'reenable', primary: true },
              { label: '改指到別的模組', value: 'repoint' },
              { label: '先跳過這組', value: 'skip' },
            ])
            if (choice === 'skip') continue
            if (choice === 'repoint') {
              await r.say('好——這個模組維持停用，我把這些按鈕改指到你挑的模組。')
              await repointBrokenGroup(c, res.modules.filter(m => m.id !== moduleId), moduleId, refs)
              continue
            }
            const cardId = r.card({ kind: 'status', state: 'pending', text: '正在重新啟用…' })
            const ok = await r.apiRetry(
              () => c.apiFetch<{ ok: boolean; moduleName: string }>('/api/admin/broken-module-fix', {
                method: 'POST',
                body: { action: 'reenable', moduleId },
              }),
              { failText: '重新啟用失敗', skipLabel: '先跳過這組' },
            )
            if (!ok) {
              r.updateMsg(cardId, { kind: 'status', state: 'skipped', text: '這組先跳過（沒有動到任何設定）' })
              continue
            }
            r.updateMsg(cardId, { kind: 'status', state: 'ok', text: `模組「${ok.moduleName}」已重新啟用，這幾顆按鈕活回來了` })
            continue
          }

          // 模組已刪除：挑一個現有模組整批改指過去（只被選單引用的情況會在裡面短路）
          await r.say(`這幾個地方的按鈕指向的模組<b>已經被刪除了</b>：<br>${brokenPlaceLines(refs)}`)
          await repointBrokenGroup(c, res.modules, moduleId, refs)
        }
      },
    },
    {
      id: 'verify',
      guard: exited,
      async run(c) {
        const { r } = c
        const cardId = r.card({ kind: 'status', state: 'pending', text: '重新檢查一次…' })
        const res = await fetchBrokenFix(c)
        if (!res) {
          r.updateMsg(cardId, { kind: 'status', state: 'skipped', text: '這次沒檢查成功（不代表沒修好）' })
          return
        }
        if (!res.refs.length) {
          r.updateMsg(cardId, { kind: 'status', state: 'ok', text: '所有按鈕都指向活著的模組了' })
          await r.say('修好了 🎉 客人按這些按鈕會正常收到訊息。')
          return
        }
        const menuLeft = res.refs.filter(x => x.sourceKind === 'richmenu').length
        r.updateMsg(cardId, { kind: 'status', state: 'fail', text: `還有 ${res.refs.length} 處沒好` })
        await r.say(
          `還沒好的：<br>${brokenPlaceLines(res.refs)}`
          + (menuLeft ? '<br>選單類要在選單頁改完並<b>重新發佈</b>後，這裡才會消掉。' : '<br>剛剛跳過的那幾組，想修的時候再點一次「用聊天帶我修」。'),
        )
      },
    },
  ],
}

// ── 同一個官方帳號接在兩個工作區 ────────────────────────────────
// C-87：訊息只會進到簽章先對上的那一邊、兩邊檢查都是綠的（08-19 實測）。
// 修法本質是「決定帳號留哪邊＋動另一邊的憑證」——憑證是紅線，動手永遠留人，
// 劇本只負責把狀況講清楚、幫忙做決定、指路、最後真的重查一次。

interface ConflictCheck {
  state: 'active' | 'clear' | 'unknown'
  detail: string
}

/**
 * 窄探針：只問「這個官方帳號有沒有接在兩邊」。
 * ⛔別改回打 `/api/admin/alerts?force=1`——那會讓整個工作區所有 probe 跳快取重跑
 * （問 LINE、逐個 LIFF 的外部請求、額度、佇列掃描…）只為讀一個布林，而下面的驗證迴圈
 * 是使用者可以連按的。判定本體共用 server 的 checkLineChannelConflict，口徑仍只有一份。
 */
async function fetchChannelConflict(c: AgentGuideCtx): Promise<ConflictCheck | null> {
  return c.r.apiRetry(
    () => c.apiFetch<ConflictCheck>('/api/admin/line-channel-check'),
    { failText: '查詢連接狀態失敗', skipLabel: '先不處理' },
  )
}

const lineChannelGuide: AgentGuideDef = {
  id: 'line-channel',
  title: '處理接在兩邊的官方帳號',
  alertIds: ['lineChannelConflict'],
  steps: [
    {
      id: 'decide',
      async run(c) {
        const { r } = c
        await r.say('這個狀況麻煩在<b>兩邊的檢查看起來都正常</b>：同一個官方帳號接在兩個工作區時，客人的訊息只會進到其中一邊，另一邊一則都收不到、也不會有錯誤訊息。')
        const check = await fetchChannelConflict(c)
        if (!check) {
          // ⛔不要靜默退出：面板會停在一則錯誤訊息、沒有任何交代（其他劇本都有收尾句）
          c.state.exit = true
          await r.say('好，先不處理。右下角的紅點會一直盯著這件事，想處理的時候再點「用聊天帶我修」。')
          return
        }
        if (check.state === 'clear') {
          c.state.exit = true
          r.card({ kind: 'status', state: 'ok', text: '剛查了一次，這個官方帳號現在只接在這一邊' })
          await r.say('看起來已經處理好了 ✓ 沒有要做的事。')
          return
        }
        if (check.state === 'unknown') {
          c.state.exit = true
          r.card({ kind: 'status', state: 'skipped', text: '這次查不到（不代表沒問題）' })
          await r.say('剛剛查不到 LINE 那邊的狀態——<b>查不到不代表沒事</b>，等幾分鐘再打開我檢查一次。')
          return
        }
        if (check.detail)
          await r.say(`查到了：${escapeHtml(check.detail)}。`)
        await r.say('先做一個決定：這個官方帳號<b>要在哪一邊服務客人</b>？決定了我就告訴你另一邊怎麼處理。')

        const choice = await r.askChoices([
          { label: '留在這一邊（處理掉另一邊）', value: 'keep-here', primary: true },
          { label: '留在另一邊（處理掉這一邊）', value: 'keep-there' },
          { label: '先不處理', value: 'skip' },
        ])
        if (choice === 'skip') {
          c.state.exit = true
          await r.say('好。提醒一下：在處理好之前，其中一邊會一直收不到客人訊息、而且看不出來。想處理時再點「用聊天帶我修」。')
          return
        }
        if (choice === 'keep-here') {
          await r.say(
            '好，帳號留這邊。要做的是把<b>另一邊工作區</b>存的 LINE 鑰匙處理掉，兩條路：<br>'
            + '・那個工作區<b>還要用</b>（只是接錯帳號）→ 切換過去，到它的「組織與 LINE 設定」把鑰匙換成<b>它自己該用的官方帳號</b>。<br>'
            + '・那個工作區<b>已經不用了</b> → 聯絡我們幫你把那邊的連接清空（目前畫面上沒有自助清除鈕）。',
          )
          await r.say('處理完回來按「幫我檢查」，我再跟 LINE 確認一次。')
          return
        }
        // keep-there：這一邊要換成正確的鑰匙（或請我們清空）
        await r.say(
          '好，帳號留另一邊。那<b>這一邊</b>存的鑰匙就要處理掉，兩條路：<br>'
          + '・這個工作區要接<b>別的官方帳號</b> → 點下面的卡，我在設定頁指給你看把 Token 換掉的位置。<br>'
          + '・這個工作區<b>暫時不接任何帳號</b> → 聯絡我們幫你清空（目前畫面上沒有自助清除鈕）。',
        )
        orgFocusCard(c, 'token', '去設定頁換這一邊的鑰匙（我會指位置）')
      },
    },
    {
      id: 'verify-loop',
      guard: exited,
      async run(c) {
        const { r } = c
        while (true) {
          const choice = await r.askChoices([
            { label: '處理好了，幫我檢查', value: 'check', primary: true },
            { label: '先跳過', value: 'skip' },
          ])
          if (choice !== 'check') {
            await r.say('好。右下角的紅點會一直盯著這件事，處理好就自己熄掉。')
            return
          }
          const cardId = r.card({ kind: 'status', state: 'pending', text: '正在重新確認這個官方帳號接在哪…' })
          const check = await fetchChannelConflict(c)
          if (!check) {
            r.updateMsg(cardId, { kind: 'status', state: 'skipped', text: '這次沒檢查成功（不代表沒處理好）' })
            return
          }
          if (check.state === 'clear') {
            r.updateMsg(cardId, { kind: 'status', state: 'ok', text: '這個官方帳號現在只接在一邊了' })
            await r.say('處理好了 🎉 客人的訊息現在會穩定進到正確的那一邊。')
            return
          }
          if (check.state === 'unknown') {
            r.updateMsg(cardId, { kind: 'status', state: 'skipped', text: '這次查不到（不代表沒處理好）' })
            await r.say('這次查不到——<b>查不到不代表沒處理好</b>，等幾分鐘再按一次檢查。')
            continue
          }
          r.updateMsg(cardId, { kind: 'status', state: 'fail', text: '兩邊都還接著' })
          await r.say(`還是接在兩邊${check.detail ? `（${escapeHtml(check.detail)}）` : ''}。最常見是另一邊<b>只改了畫面沒按儲存</b>；若那邊已經不用、又沒有清除鈕，聯絡我們處理。好了再按檢查。`)
        }
      },
    },
  ],
}

// ── 註冊表 ──────────────────────────────────────────────────────

export const AGENT_GUIDES: Record<AgentGuideId, AgentGuideDef> = {
  'liff-endpoint': liffEndpointGuide,
  'liff-setup': liffSetupGuide,
  'handoff-notify': handoffNotifyGuide,
  'knowledge-sync': knowledgeSyncGuide,
  'knowledge-first': knowledgeFirstGuide,
  'line-webhook': lineWebhookGuide,
  'broken-module': brokenModuleGuide,
  'line-channel': lineChannelGuide,
}
