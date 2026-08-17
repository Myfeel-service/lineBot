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
import type { WorkspaceAlertId } from '~~/shared/types/alerts'
import type { AgentScriptRunner, AgentScriptStep } from '~/composables/useAgentScriptRunner'

export type AgentGuideId = 'liff-endpoint' | 'handoff-notify' | 'knowledge-sync'

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
            '打開 LINE Developers 並登入（下面有連結）',
            '選你的官方帳號 → LIFF 分頁',
            '點進上面列出的那個 LIFF',
            'Endpoint URL 換成剛剛那串，按 Update／存檔',
          ],
          href: 'https://developers.line.biz/console/',
          hrefLabel: '打開 LINE Developers ↗',
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

// ── 註冊表 ──────────────────────────────────────────────────────

export const AGENT_GUIDES: Record<AgentGuideId, AgentGuideDef> = {
  'liff-endpoint': liffEndpointGuide,
  'handoff-notify': handoffNotifyGuide,
  'knowledge-sync': knowledgeSyncGuide,
}
