/**
 * AI 說話的口氣用「像誰」來選（`D-175`，John 哥 2026-11-04 會議）。
 *
 * John 哥：「語氣應該選一些 role model，像我們以前挑廣告配音：你要主播台的感覺、娛樂主播，還是吃播藝人？
 * 用具體的東西幫他篩選，因為大部分人不知道怎麼形容自己要的。」
 *
 * ── 規矩 ───────────────────────────────────────────────────────
 * ① **只用職業類型，⛔ 不用真人、不用特定藝人**（肖像與觀感問題）。
 * ② **照店的類型給不同的四個**：診所、補習班不適合「綜藝主持」（`STORE_BIZ_WORDING` 同一套三型＋中性型）。
 * ③ **每個角色附一句「同一題」的示範回答**——同一題才比得出差別；題目照店的類型換。
 *    示範只示範口氣：內容（有沒有試聽、要不要預約）實際上照知識卡答，卡片上要講這一句。
 * ④ 選了之後**只換「說話的口氣：」那一行**（`buildToneDraft` 組的那一行），開頭、事實行與
 *    `TONE_SAFETY_RULES` 一字不動——⛔ 換口氣不可以順手把安全規則換掉。
 * ⑤ 範本生、零 LLM（同 `store-profile-drafts.ts` 第①條鐵律）：每次一樣、測試釘得住。
 */

import { storeBizTypeOf, type StoreBizType } from './store-profile-biz'

export type ToneRoleId =
  | 'shopkeeper'
  | 'reviewer'
  | 'host'
  | 'anchor'
  | 'advisor'
  | 'receptionist'
  | 'teacher'
  | 'senior'

export interface ToneRole {
  id: ToneRoleId
  /** 像誰（卡片上那顆的名字） */
  label: string
  /** 一句話講這個人怎麼說話（名字旁邊的小字） */
  trait: string
  /** 寫進 systemPrompt「說話的口氣：」後面的字（給模型看的） */
  voice: string
}

export const TONE_ROLES: Readonly<Record<ToneRoleId, ToneRole>> = {
  shopkeeper: {
    id: 'shopkeeper',
    label: '隔壁店長',
    trait: '親切，像跟熟客聊天',
    voice: '像隔壁熟悉的店長：親切、口語，像跟熟客聊天；可以用一兩個表情符號，不推銷',
  },
  reviewer: {
    id: 'reviewer',
    label: '開箱網紅',
    trait: '口語，愛分享心得',
    voice: '像愛分享的開箱網紅：口語、真誠，像在跟朋友推薦；可以用表情符號，不誇大效果',
  },
  host: {
    id: 'host',
    label: '綜藝主持',
    trait: '熱鬧，有活力',
    voice: '像綜藝節目主持人：熱情、有活力，可以用驚嘆號和表情符號帶氣氛；數字和規定照實講，不誇大',
  },
  anchor: {
    id: 'anchor',
    label: '新聞主播',
    trait: '沉穩，先講重點',
    voice: '像新聞主播：沉穩、清楚，先講重點再補一句說明；不用表情符號、不用驚嘆號',
  },
  advisor: {
    id: 'advisor',
    label: '專業顧問',
    trait: '精準，不多話',
    voice: '像專業顧問：精準、有條理、不多話；先給結論，必要時分步驟講；不用表情符號',
  },
  receptionist: {
    id: 'receptionist',
    label: '貼心櫃台',
    trait: '溫柔，先關心你',
    voice: '像貼心的櫃台人員：溫柔有禮，先回應客人的狀況再回答；稱呼客人用「您」',
  },
  teacher: {
    id: 'teacher',
    label: '帶班老師',
    trait: '有耐心，一步步講',
    voice: '像有耐心的帶班老師：一步一步講清楚、鼓勵發問；口氣溫和，不說教',
  },
  senior: {
    id: 'senior',
    label: '學長姐',
    trait: '輕鬆，像過來人',
    voice: '像過來人的學長姐：輕鬆、口語，會用自己的經驗打比方；課程與費用照實講',
  },
}

/**
 * 每一型給哪四個（第一個＝猜不出來時的預設）。
 * ⛔ 做服務、教課的不給「綜藝主持」；新聞主播每一型都有（最中性的那一個，不想要個性的人選它）。
 */
export const TONE_ROLES_BY_BIZ: Readonly<Record<StoreBizType, readonly ToneRoleId[]>> = {
  goods: ['shopkeeper', 'reviewer', 'host', 'anchor'],
  service: ['receptionist', 'advisor', 'shopkeeper', 'anchor'],
  class: ['teacher', 'senior', 'advisor', 'anchor'],
  neutral: ['shopkeeper', 'advisor', 'reviewer', 'anchor'],
}

/** 示範那一題（同一型的四個角色回答同一題，才比得出口氣的差別） */
export const TONE_SAMPLE_QUESTION: Readonly<Record<StoreBizType, string>> = {
  goods: '有推薦的嗎？',
  service: '第一次去要先預約嗎？',
  class: '可以先試聽嗎？',
  neutral: '有推薦的嗎？',
}

/** 示範回答底下那一句：示範的是口氣，⛔ 不是在替他答應「可以試聽」「要先預約」 */
export const TONE_SAMPLE_NOTE = '只是示範口氣；實際內容照你的知識庫回答。'

/**
 * 某個角色回答那一題的樣子。
 * @param product 他的第一樣主打（「有推薦的嗎？」那題用得到；沒有就講「我們的招牌」）
 * ⛔ 不放任何數字、價格、時間：那些我們不知道，示範也不可以編。
 */
export function toneSampleAnswer(role: ToneRoleId, biz: StoreBizType, product = ''): string {
  const p = String(product ?? '').trim() || '我們的招牌'
  if (biz === 'service') {
    const s: Partial<Record<ToneRoleId, string>> = {
      receptionist: '您好～第一次來建議先預約，到了就不用等。方便告訴我想約哪一天嗎？',
      advisor: '建議先預約。請提供希望的日期與時段，我幫您確認。',
      shopkeeper: '要先約喔～跟我說哪天方便，我幫你看還有沒有位子 😊',
      anchor: '需要先預約。請告訴我希望的日期，我們會回覆可以預約的時段。',
    }
    return s[role] ?? s.anchor!
  }
  if (biz === 'class') {
    const s: Partial<Record<ToneRoleId, string>> = {
      teacher: '可以的，歡迎先來感受上課的方式。告訴我想上的科目和程度，我幫你安排適合的一堂。',
      senior: '可以啊～很多人都是試聽完才決定的，跟我說想上哪一科，我幫你問問看時間 😄',
      advisor: '可以安排試聽。請告訴我想上的課程與方便的時間，我幫您確認。',
      anchor: '可以試聽。請告訴我想上的課程，我們會回覆可以安排的時段。',
    }
    return s[role] ?? s.anchor!
  }
  const s: Record<ToneRoleId, string> = {
    shopkeeper: `有喔～很多熟客第一次都從${p}開始 😊 跟我說你喜歡什麼，我再幫你挑。`,
    reviewer: `一定要試試${p}！喜歡的人都會回頭再買 😆 跟我說你的需求，我幫你挑！`,
    host: `問得太好了！${p}是我們的人氣王 🎉 想知道細節我馬上跟你說！`,
    anchor: `推薦${p}，是最多人選的一樣。需要的話，我可以再說明細節。`,
    advisor: `建議先從${p}開始。告訴我你的需求，我再幫你比較。`,
    receptionist: `您好～很多客人第一次都選${p}。方便告訴我您的需求嗎？我幫您挑。`,
    teacher: `可以先從${p}開始，有不懂的地方隨時問我，我一步步跟你說。`,
    senior: `我會推${p}～我身邊的人第一次都從它開始 😄`,
  }
  return s[role]
}

/** 這家店（照產業別）給哪四個 */
export function toneRolesFor(industry: string | null | undefined): ToneRole[] {
  return TONE_ROLES_BY_BIZ[storeBizTypeOf(industry)].map(id => TONE_ROLES[id])
}

/**
 * 一開始先選哪一個：照網站猜的口氣（輪廓卡「品牌語氣」那一格）挑最接近的，猜不出來就是那一型的第一個。
 * ⛔ 只在那一型的四個裡面挑：網站很活潑的診所也不會被預選「綜藝主持」（那一型根本沒有它）。
 */
export function pickDefaultToneRole(industry: string | null | undefined, toneGuess: string | null | undefined): ToneRoleId {
  const ids = TONE_ROLES_BY_BIZ[storeBizTypeOf(industry)]
  const t = String(toneGuess ?? '')
  const prefs: Array<[RegExp, ToneRoleId[]]> = [
    [/活潑|熱情|熱鬧|有趣|俏皮|活力/, ['host', 'reviewer', 'senior', 'shopkeeper']],
    [/專業|沉穩|嚴謹|正式|簡潔|精準|權威/, ['advisor', 'anchor']],
    [/溫暖|溫柔|貼心|體貼|關懷|細心|耐心/, ['receptionist', 'teacher', 'shopkeeper']],
    [/親切|口語|輕鬆|自然|朋友|白話/, ['shopkeeper', 'senior', 'reviewer']],
  ]
  for (const [re, want] of prefs) {
    if (!re.test(t)) continue
    const hit = want.find(id => ids.includes(id))
    if (hit) return hit
  }
  return ids[0]!
}

export const TONE_VOICE_PREFIX = '說話的口氣：'

/** systemPrompt 裡「說話的口氣：」那一行（`buildToneDraft` 組的就是這個形狀） */
export function toneRoleVoiceLine(role: ToneRoleId): string {
  return `${TONE_VOICE_PREFIX}${TONE_ROLES[role].voice}。`
}

/**
 * 給 AI 的指示換成某個角色的口氣。
 * - 指示裡有「說話的口氣：」那一行（開帳建的、或之前選過角色）→ **只換那一行**，其他一字不動
 * - 沒有那一行（自己寫的、舊的三個範本）→ `replaced: false`，由呼叫端決定要不要整段換（要先問過他）
 */
export function replaceToneVoiceLine(prompt: string, role: ToneRoleId): { text: string, replaced: boolean } {
  const lines = String(prompt ?? '').split('\n')
  const i = lines.findIndex(l => l.trim().startsWith(TONE_VOICE_PREFIX))
  if (i < 0) return { text: String(prompt ?? ''), replaced: false }
  lines[i] = toneRoleVoiceLine(role)
  return { text: lines.join('\n'), replaced: true }
}

/** 指示現在是哪一個角色的口氣（口氣那一行跟某個角色一字不差才算；⛔ 自己改過的不算） */
export function toneRoleOf(prompt: string): ToneRoleId | null {
  const line = String(prompt ?? '').split('\n').map(l => l.trim()).find(l => l.startsWith(TONE_VOICE_PREFIX))
  if (!line) return null
  const hit = (Object.keys(TONE_ROLES) as ToneRoleId[]).find(id => toneRoleVoiceLine(id) === line)
  return hit ?? null
}
