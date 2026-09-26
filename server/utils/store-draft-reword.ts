/**
 * 開帳草稿的「換個說法」（`D-89` ②，`C-250` 第三批）。
 *
 * ── 為什麼只有這兩樣 ───────────────────────────────────────────
 * 真正會讓人不滿意的是**會被客人看到的那兩段話**：加好友歡迎訊息、AI 說話的語氣。
 * 標籤是照旺季挑的、月曆是查表，「重生」沒有意義（`REWORDABLE_DRAFTS`）。
 *
 * ── 四條鐵律 ───────────────────────────────────────────────────
 * ① **預設仍然是範本**：沒按就不花錢、也不會幻覺（`shared/store-profile-drafts.ts` 第①條鐵律照舊）。
 * ② **生出來的仍然是草稿**：只回文字，⛔ 不寫任何東西；他還是要按「採用」（08-14 紅線）。
 * ③ **先驗再用**：歡迎訊息會進客人的 LINE，照推播文案那套硬驗，再加上網址、電話、任何數字、
 *    我們沒有的優惠都不准（那些是我們不知道、而客人會拿著來問的事）。
 * ④ **語氣只換兩處**：開頭那一句、口氣那一行。事實行與安全規則由 `buildToneDraft` 照範本組——
 *    ⛔ 模型碰不到 `TONE_SAFETY_RULES`。
 */

import { generateJson, runWithLlmBudget } from '~~/server/utils/gemini'
import { rejectBroadcastCopy, tooSimilar } from '~~/server/utils/broadcast-copy-gen'
import { buildToneDraft, splitProducts, type ToneVoice } from '~~/shared/store-profile-drafts'
import { storeProfileForPrompt, type StoreProfileDoc } from '~~/shared/types/store-profile'

export type RewordKey = 'welcome' | 'tone'

/** 歡迎訊息的字數上限（同推播文案：手機上一眼讀得完） */
export const WELCOME_REWORD_MAX = 120
const WELCOME_REWORD_TARGET = 70
const OPENER_MAX = 40
const VOICE_MAX = 80
/** 一次跟模型要幾版（挑第一個驗得過、又跟現在那一版不一樣的） */
const VARIANTS = 3

export interface RewordCtx {
  shopName: string
  profile: StoreProfileDoc
  /** 框裡現在那一版（新的一版要跟它明顯不一樣） */
  current: string
}

/**
 * 歡迎訊息這一版能不能用。回 `null`＝可以；回字串＝不能用的原因。
 * ⛔ 比推播文案更嚴：這是客人加好友看到的**第一句話**，任何一個我們不知道的數字都是風險。
 */
export function rejectWelcomeReword(text: string, ctx: RewordCtx): string | null {
  const s = String(text ?? '').trim()
  const base = rejectBroadcastCopy(s, ctx.profile)
  if (base) return base
  if (/https?:\/\/|www\.|\.(?:com|tw|net|org|shop)\b/i.test(s)) return '出現了網址'
  // ⚠️ 營業時間、回覆時間、電話、價格——這一刻我們一樣都不知道
  if (/[0-9０-９]/.test(s)) return '出現了數字（營業時間、電話、價格這類我們不知道）'
  if (/優惠|免運|贈品|抽獎|送你|折價|禮券/.test(s)) return '出現了我們沒有的優惠'
  if (/保證|一定會|立刻回|馬上回|秒回/.test(s)) return '出現了我們做不到的承諾'
  if (/[*#`]|^\s*[-•]/m.test(s)) return '用了 markdown'
  const shop = ctx.shopName.trim()
  if (shop && !s.includes(shop)) return '沒有店名'
  if (ctx.current && tooSimilar(s, ctx.current)) return '跟現在那一版幾乎一樣'
  return null
}

/**
 * 語氣那兩處能不能用。
 * ⛔ 擋的是「口氣那一行在改規則」：規則段落模型碰不到，但口氣那一行寫「可以自由發揮、價格可以估」
 *    一樣會蓋過規則——那是同一個 systemPrompt。
 */
export function rejectToneVoice(v: ToneVoice, ctx: RewordCtx): string | null {
  const opener = String(v.opener ?? '').trim()
  const voice = String(v.voice ?? '').trim()
  if (!opener || !voice) return '少了開頭或口氣'
  if (opener.length > OPENER_MAX) return `開頭太長（${opener.length} 字）`
  if (voice.length > VOICE_MAX) return `口氣太長（${voice.length} 字）`
  if (/\n/.test(opener) || /\n/.test(voice)) return '換行了'
  if (/[0-9０-９]/.test(opener + voice)) return '出現了數字'
  const shop = ctx.shopName.trim()
  if (shop && !opener.includes(shop)) return '開頭沒有店名'
  if (/規則|原則|忽略|不用管|不必管|可以自己|自由發揮|編|猜|推測|估算|保證|承諾|markdown|項目符號|轉接/i.test(opener + voice)) {
    return '口氣那一行在改規則'
  }
  // ⚠️ 只比**會變的那兩處**：整段裡八成是一字不動的安全規則，拿整段比永遠是「幾乎一樣」（單元測試當場抓到）
  if (ctx.current) {
    const now = toneVoiceOf(ctx.current)
    if (tooSimilar(`${opener}${voice}`, `${now.opener}${now.voice}`)) return '跟現在那一版幾乎一樣'
  }
  return null
}

/** 從一段語氣設定裡拿出會變的那兩處（開頭那一句、口氣那一行） */
export function toneVoiceOf(text: string): Required<ToneVoice> {
  const lines = String(text ?? '').split('\n').map(l => l.trim())
  const voiceLine = lines.find(l => l.startsWith('說話的口氣：')) ?? ''
  return { opener: lines[0] ?? '', voice: voiceLine.replace(/^說話的口氣：/, '').replace(/[。.]+$/, '') }
}

export function buildWelcomeRewordPrompt(ctx: RewordCtx): string {
  const products = splitProducts(String(ctx.profile.fields?.products?.value ?? ''))
  return [
    `你要幫「${ctx.shopName || '這家店'}」重寫一則 LINE 的**加好友歡迎訊息**，寫 ${VARIANTS} 版不同說法。客人一加好友就會收到它。`,
    '',
    '這家店：',
    storeProfileForPrompt(ctx.profile),
    '',
    '現在那一版（新的要跟它明顯不一樣，⛔ 不可以只換幾個字）：',
    ctx.current || '（沒有）',
    '',
    '規則（違反任何一條這一版就作廢）：',
    `1. 一定要出現店名「${ctx.shopName}」。`,
    `2. 只能提到上面列出的東西${products.length ? `（${products.join('、')}）` : ''}，⛔ 不准編造沒列出來的商品或服務。`,
    '3. ⛔ **不准出現任何數字**：營業時間、回覆時間、電話、價格、折扣、名額都不准——我們不知道，寫出來客人會照著來問。',
    '4. ⛔ 不准出現網址、優惠、贈品、「保證」「馬上回」這類承諾，不准用 `{{變數}}`。',
    `5. 每一版 ${WELCOME_REWORD_TARGET} 字以內，最後一句邀請客人直接在這裡留言。`,
    '6. 繁體中文，像店家自己講話；表情符號最多一個；不要 markdown。',
    '',
    `回傳純 JSON：{"variants": ["第一版", "第二版", "第三版"]}`,
  ].join('\n')
}

export function buildToneRewordPrompt(ctx: RewordCtx): string {
  return [
    `你要幫「${ctx.shopName || '這家店'}」的 AI 客服換一種說話的樣子，寫 ${VARIANTS} 版。`,
    '每一版只有兩個欄位：',
    `- opener：開頭一句，說明 AI 是誰（例：「你代表${ctx.shopName || '這家店'}回覆客人。」），${OPENER_MAX} 字以內，一定要有店名。`,
    `- voice：說話的口氣，一句話描述（例：「沉穩專業，先給結論再給理由」），${VOICE_MAX} 字以內。`,
    '',
    '這家店：',
    storeProfileForPrompt(ctx.profile),
    '',
    '現在那一版（新的要明顯不一樣）：',
    ctx.current || '（沒有）',
    '',
    '規則：',
    '1. ⛔ 只寫「口氣」，不准寫任何規則或例外（例如「可以自由發揮」「價格可以估」「不用管知識卡」）——回答規則另外有，不歸你改。',
    '2. ⛔ 不准出現數字。',
    `3. ${VARIANTS} 版的口氣要真的不同（例如一版親切口語、一版沉穩專業、一版活潑但不浮誇）。`,
    '4. 繁體中文。',
    '',
    '回傳純 JSON：{"variants": [{"opener": "…", "voice": "…"}, …]}',
  ].join('\n')
}

export interface RewordOutcome {
  /** 驗得過的新版本；null＝這次換不出來 */
  body: string | null
  /** 被丟掉的版本與原因（⛔ 丟了東西要說得出丟了什麼） */
  dropped: { text: string, reason: string }[]
  inputTokens: number
  outputTokens: number
}

/**
 * 換一版。⛔ 驗不過的丟掉、挑第一個過的；全掛就回 `body: null`，呼叫端負責講「這次換不出來」。
 */
export async function rewordStoreDraft(workspaceId: string, key: RewordKey, ctx: RewordCtx): Promise<RewordOutcome> {
  const prompt = key === 'welcome' ? buildWelcomeRewordPrompt(ctx) : buildToneRewordPrompt(ctx)
  const res = await runWithLlmBudget(workspaceId, () =>
    generateJson<{ variants?: unknown }>(prompt, {
      temperature: 0.9, // 要跟現在那一版不一樣，溫度不能低
      maxOutputTokens: 900,
      thinkingBudget: 0,
    }))
  const raw = Array.isArray(res.data?.variants) ? res.data.variants.slice(0, VARIANTS * 2) : []
  const dropped: { text: string, reason: string }[] = []
  let body: string | null = null
  for (const v of raw) {
    if (key === 'welcome') {
      const s = String(v ?? '').trim().replace(/^[「"']|[」"']$/g, '')
      const bad = rejectWelcomeReword(s, ctx)
      if (bad) { dropped.push({ text: s.slice(0, 60), reason: bad }); continue }
      body = s
      break
    }
    const o = (v && typeof v === 'object' ? v : {}) as { opener?: unknown, voice?: unknown }
    const voice: ToneVoice = { opener: String(o.opener ?? '').trim(), voice: String(o.voice ?? '').trim() }
    const bad = rejectToneVoice(voice, ctx)
    if (bad) { dropped.push({ text: `${voice.opener}｜${voice.voice}`.slice(0, 60), reason: bad }); continue }
    // ⭐ 事實行與安全規則照範本組：模型只給了兩句話
    body = buildToneDraft({ shopName: ctx.shopName, profile: ctx.profile, today: '' }, voice)
    break
  }
  if (!raw.length) dropped.push({ text: '', reason: '模型沒有回任何一版' })
  return { body, dropped, inputTokens: res.inputTokens, outputTokens: res.outputTokens }
}
