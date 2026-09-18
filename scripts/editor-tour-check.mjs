/**
 * 「導覽不可以停在門口」的實機守門員（2026-09-18，`D-82`／`C-201`）。
 *
 *   npm run dev -- --port 3311                                      # 另一個終端先跑起來
 *   CHECK_BASE_URL=http://localhost:3311 node --env-file=.env_myfeel scripts/editor-tour-check.mjs
 *
 * 為什麼一定要真的開瀏覽器：`tutorial-topics.test.ts` 只驗得到「錨點字串在某個 .vue 裡面」，
 * 驗不到這次真正會壞的兩件事——
 *   ① `clickBefore` 有沒有真的把右半邊的編輯器打開（打不開的話，後面每一步都會退化成
 *      「這一步要指的位置目前不在畫面上」，而那正是這輪要消滅的東西）
 *   ② 那些**有渲染條件**的欄位（「怎麼比對」只在關鍵字模式、「發送設定」只在可編輯時）
 *      在導覽跑到它的那一刻在不在畫面上。
 * 這個專案吃過「typecheck 綠＋測試綠，但新程式根本沒被執行到」（記憶
 * `feedback_verify_new_code_actually_runs`），所以這裡逐步斷言，不看總結。
 *
 * ⚠️ 連的是**正式資料庫（myfeel）**：讀 `workspaceMembers` 找一個管理員來登入（唯讀），
 *    瀏覽器操作全程只在畫面上點，**不送出任何存檔**（不按「建立」「儲存」「發送」）。
 *    唯一可能被寫到的是 `adminUserPrefs/{uid}`（只存「這個人看過哪幾頁的導覽」）——
 *    ⛔ 跑之前先把原本的內容抄下來，跑完**原封還原**（不像舊的 auto-tour-check 直接刪掉，
 *       那會把這位管理員真實的「看過了」記錄一起清掉、害他下次每頁又被跳一次）。
 */
import { cert, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import puppeteer from 'puppeteer'

const BASE = process.env.CHECK_BASE_URL ?? 'http://localhost:3000'
const WORKSPACE_ID = process.env.CHECK_WORKSPACE_ID ?? '212405d2-d782-443b-9670-adac3b3e1f99' // MYFEEL

/**
 * 這一輪擴寫的兩支導覽。`opensEditor` ＝ 跑到第幾步時，右半邊的編輯器應該已經被打開
 * （1 起算），`editorAnchor` ＝ 那時候畫面上一定要有的東西。
 */
const CASES = [
  {
    tourId: 'ai-scripts',
    path: 'ai-scripts',
    label: '自動回應',
    expectSteps: 8,
    opensEditor: 4,
    editorAnchor: '[data-tour="scr-trigger-mode"]',
    // 有渲染條件、最可能在跑到時不在畫面上的那幾格
    conditional: ['[data-tour="scr-match"]', '[data-tour="scr-test"]', '[data-tour="scr-reply"]', '[data-tour="scr-save"]'],
  },
  {
    tourId: 'broadcasts',
    path: 'broadcasts',
    label: '推播',
    expectSteps: 7,
    opensEditor: 3,
    editorAnchor: '[data-tour="bc-audience"]',
    conditional: ['[data-tour="bc-content"]', '[data-tour="bc-schedule"]', '[data-tour="bc-send"]'],
  },
  // ── 第二批（2026-09-18）──────────────────────────────────────────────
  {
    tourId: 'support-presets',
    path: 'support-presets',
    label: '客服預存',
    expectSteps: 5,
    opensEditor: 3,
    editorAnchor: '[data-tour="sp-action"]',
    conditional: ['[data-tour="sp-tagging"]', '[data-tour="sp-save"]'],
  },
  {
    tourId: 'members',
    path: 'settings/members',
    label: '成員管理',
    expectSteps: 3,
    // 這一支不用開編輯器（整頁就是一張表）
    opensEditor: 0,
    editorAnchor: '',
    conditional: ['[data-tour="mem-line"]'],
  },
  // ── 第三批（2026-09-18）──────────────────────────────────────────────
  {
    tourId: 'tags',
    path: 'tags',
    label: '標籤管理',
    expectSteps: 5,
    opensEditor: 4,
    editorAnchor: '[data-tour="tag-code"]',
    conditional: ['[data-tour="tag-templates"]', '[data-tour="tag-name"]'],
  },
  {
    tourId: 'activity',
    path: 'settings/activity',
    label: '操作紀錄',
    expectSteps: 2,
    opensEditor: 0,
    editorAnchor: '',
    conditional: ['[data-tour="act-list"]', '[data-tour="act-filter"]'],
  },
  {
    // 這一支的重點：最後一塊住在**預設收合**的「進階調校」裡，
    // 導覽要先幫他展開；沒展開的話那一步就是「位置不在畫面上」。
    tourId: 'ai-settings',
    path: 'ai-settings',
    label: 'AI 設定',
    expectSteps: 6,
    opensEditor: 5,
    editorAnchor: '[data-tour="ais-handback"]',
    conditional: ['[data-tour="ais-hours"]', '[data-tour="ais-handback"]'],
  },
]

const {
  FIREBASE_PROJECT_ID: projectId,
  FIREBASE_CLIENT_EMAIL: clientEmail,
  FIREBASE_PRIVATE_KEY: privateKey,
  FIREBASE_API_KEY: apiKey,
} = process.env
if (!projectId || !clientEmail || !privateKey || !apiKey) {
  console.error('缺環境變數（要 --env-file=.env_myfeel）：FIREBASE_PROJECT_ID／CLIENT_EMAIL／PRIVATE_KEY／API_KEY')
  process.exit(1)
}
initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) })
const db = getFirestore()

const members = await db.collection('workspaceMembers').where('workspaceId', '==', WORKSPACE_ID).get()
const rows = members.docs.map(d => ({ id: d.id, ...d.data() }))
const admin = rows.find(r => r.role === 'owner' || r.role === 'admin') ?? rows[0]
if (!admin) { console.error('這個工作區查不到成員'); process.exit(1) }
const uid = String(admin.uid ?? admin.id)

// ── 先把這位管理員原本的「看過了」抄一份，最後原封還原 ───────────────────────
const prefsRef = db.collection('adminUserPrefs').doc(uid)
const prefsBefore = await prefsRef.get()
const prefsData = prefsBefore.exists ? prefsBefore.data() : null
console.log(`adminUserPrefs/${uid}：${prefsBefore.exists ? '原本有資料，已抄下來，跑完會還原' : '原本不存在，跑完會刪掉'}`)

const custom = await getAuth().createCustomToken(uid)
const signIn = await (await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: custom, returnSecureToken: true }),
})).json()
if (!signIn.idToken) { console.error('換 idToken 失敗：', JSON.stringify(signIn)); process.exit(1) }
const session = { uid, email: (await getAuth().getUser(uid)).email ?? '', apiKey, idToken: signIn.idToken, refreshToken: signIn.refreshToken }
console.log(`登入身分：${session.email}（${admin.role}）\n`)

let failed = false
const fail = (msg) => { failed = true; console.error(`❌ ${msg}`) }
const pass = msg => console.log(`✅ ${msg}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })

async function openLoggedInPage() {
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  page.on('pageerror', e => console.log('  [page error]', String(e).slice(0, 200)))
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2', timeout: 90_000 })
  await page.evaluate(async (s) => {
    const user = {
      uid: s.uid,
      email: s.email,
      emailVerified: true,
      isAnonymous: false,
      providerData: [{ providerId: 'google.com', uid: s.email, displayName: null, email: s.email, phoneNumber: null, photoURL: null }],
      stsTokenManager: { refreshToken: s.refreshToken, accessToken: s.idToken, expirationTime: Date.now() + 3600_000 },
      createdAt: String(Date.now() - 86400_000),
      lastLoginAt: String(Date.now()),
      apiKey: s.apiKey,
      appName: '[DEFAULT]',
    }
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('firebaseLocalStorageDb', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' })
      req.onsuccess = () => {
        const tx = req.result.transaction('firebaseLocalStorage', 'readwrite')
        tx.objectStore('firebaseLocalStorage').put({ fbase_key: `firebase:authUser:${s.apiKey}:[DEFAULT]`, value: user })
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })
  }, session)
  return { page, ctx }
}

/** 這一步的卡片現況：第幾步／共幾步、標題、有沒有那句「位置不在畫面上」 */
async function readStep(page) {
  return page.evaluate(() => {
    const card = document.querySelector('.el-tour')
    if (!card) return null
    const count = card.querySelector('.ta-tour-count')?.textContent?.trim() ?? ''
    return {
      count,
      title: card.querySelector('.ta-tour-title')?.textContent?.trim() ?? '',
      missing: !!card.querySelector('.ta-tour-missing'),
    }
  })
}

/** 按卡片右下角那顆（「下一步」／最後一步的「結束」） */
async function clickNext(page) {
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.el-tour__footer .el-button')]
    btns[btns.length - 1]?.click()
  })
  await sleep(900)
}

try {
  for (const c of CASES) {
    console.log(`── ${c.label}（${c.tourId}）──────────────────`)
    const { page, ctx } = await openLoggedInPage()
    try {
      // 用 ?tour= 指名開這一支，不必等自動導覽（自動導覽只跑「這個帳號沒看過」的）
      await page.goto(`${BASE}/admin/${WORKSPACE_ID}/${c.path}?tour=${c.tourId}`, { waitUntil: 'networkidle2', timeout: 90_000 })
      if (!page.url().includes(`/admin/${WORKSPACE_ID}/${c.path}`))
        throw new Error(`沒有停在這一頁，現在在 ${page.url()}`)
      await page.waitForSelector('.ta-tour-title', { visible: true, timeout: 30_000 })

      const seen = []
      for (let i = 1; i <= c.expectSteps + 2; i++) {
        const step = await readStep(page)
        if (!step) break
        seen.push(step)
        const where = step.count || `${i}`
        if (step.missing)
          fail(`${c.label} 第 ${where} 步「${step.title}」→ 指不到東西（畫面上跳出「位置不在畫面上」）`)
        else
          console.log(`   ${where}　${step.title}`)

        // clickBefore 該把編輯器（或收合區）打開的那一步：查那個錨點在不在、有沒有實際大小
        if (c.opensEditor && i === c.opensEditor) {
          const box = await page.evaluate((sel) => {
            const el = document.querySelector(sel)
            if (!el) return null
            const r = el.getBoundingClientRect()
            return { w: Math.round(r.width), h: Math.round(r.height) }
          }, c.editorAnchor)
          if (box && box.w > 0 && box.h > 0)
            pass(`${c.label}：第 ${where} 步真的把編輯器打開了（${c.editorAnchor} ${box.w}×${box.h}）`)
          else
            fail(`${c.label}：第 ${where} 步沒把編輯器打開（${c.editorAnchor} 不在畫面上）＝導覽還是停在門口`)
        }
        if (i >= c.expectSteps) break
        await clickNext(page)
      }

      // 頁首那顆問號＝使用者自己想再看一遍的唯一入口（沒掛教學的頁是整顆不畫的，
      // 操作紀錄這一輪之前正是那樣）。⛔ 用 ?tour= 開得起來不等於使用者找得到。
      if (await page.$('.page-help-btn'))
        pass(`${c.label}：頁首那顆「這頁怎麼用」在`)
      else
        fail(`${c.label}：頁首沒有那顆問號＝使用者自己想再看一遍時找不到入口`)

      const total = seen[0]?.count?.split('/')?.[1]?.trim()
      if (String(total) === String(c.expectSteps))
        pass(`${c.label}：導覽共 ${total} 步（跟預期一樣）`)
      else
        fail(`${c.label}：導覽共 ${total} 步，預期 ${c.expectSteps} 步`)

      // 有渲染條件的那幾格，跑完整支之後逐一確認真的在畫面上
      for (const sel of c.conditional) {
        const there = await page.$(sel)
        if (there) pass(`${c.label}：${sel} 在畫面上`)
        else fail(`${c.label}：${sel} 不在畫面上（導覽指到它的那一步會變成空話）`)
      }
    }
    catch (e) {
      fail(`${c.label}：${String(e).split('\n')[0]}`)
    }
    finally {
      await ctx.close()
    }
    console.log('')
  }

  // ── 加驗：這一輪補的就地說明，真的出現在畫面上了嗎 ─────────────────────────
  // 導覽是「帶你看一遍」，就地說明是「你自己看的時候讀得到」——後者沒出現的話，
  // 沒跑導覽的人（＝絕大多數回訪的人）等於什麼都沒補到。
  {
    console.log('── 加驗：就地說明 ──────────────────')
    const { page, ctx } = await openLoggedInPage()
    try {
      // ① 訂閱與付款：額度用完會怎樣（這一頁拍板不做導覽，只補一句）
      await page.goto(`${BASE}/admin/${WORKSPACE_ID}/settings/billing`, { waitUntil: 'networkidle2', timeout: 90_000 })
      await sleep(2500)
      const billing = await page.evaluate(() => ({
        quota: document.querySelector('[data-tour="bill-quota"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        body: document.body.innerText,
      }))
      if (!billing.quota) {
        // 沒有則數上限的帳號（客製額度、或根本還沒開通付費方案）本來就沒有這一區，
        // 這句話也就不該出現。⛔ 這種情況要講出來是「這次沒驗到」，不可以混成綠燈。
        const why = billing.body.includes('客製額度')
          ? '客製額度、沒有則數上限'
          : billing.body.includes('尚未開通付費方案')
            ? '這個帳號還沒開通付費方案'
            : ''
        if (why) console.log(`   ⏭️ 用量那一區不存在（${why}）＝這一句本來就不適用，這次沒驗到`)
        else fail(`訂閱與付款：找不到用量那一區，也看不出原因。畫面上是：「${billing.body.replace(/\s+/g, ' ').slice(0, 160)}」`)
      }
      else if (billing.quota.includes('用完之後') && billing.quota.includes('轉給真人客服')) {
        pass('訂閱與付款：「用完之後會怎樣」看得到了')
      }
      else {
        fail(`訂閱與付款：那句「用完之後會怎樣」沒出現。實際讀到的是：「${billing.quota.slice(0, 120)}」`)
      }

      // ② 推播：匯入名單那串 U 開頭的編號要去哪拿
      await page.goto(`${BASE}/admin/${WORKSPACE_ID}/broadcasts`, { waitUntil: 'networkidle2', timeout: 90_000 })
      await page.waitForSelector('[data-tour="bc-new"]', { timeout: 60_000 })
      await page.keyboard.press('Escape') // 自動導覽可能蓋住畫面
      await sleep(800)
      await page.click('[data-tour="bc-new"]')
      await page.waitForSelector('[data-tour="bc-audience"]', { timeout: 30_000 })
      // 點「匯入名單」那顆 radio
      await page.evaluate(() => {
        const labels = [...document.querySelectorAll('[data-tour="bc-audience"] .el-radio')]
        labels.find(l => l.textContent?.includes('匯入名單'))?.click()
      })
      await sleep(800)
      // ⛔ 不要只看 [data-tour="bc-audience"]：那一格裡面只有「發送對象」那排選項，
      //    「匯入名單」的輸入框與說明是**它的兄弟節點**（第一次寫錯就是錯在這，看起來像程式沒改到）
      const audience = await page.evaluate(() => {
        const card = document.querySelector('[data-tour="bc-audience"]')?.closest('.message-card')
        return {
          picked: !!document.querySelector('[data-tour="bc-audience"] .el-radio.is-checked'),
          text: card?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        }
      })
      if (!audience.text.includes('LINE User IDs'))
        fail(`推播：沒有切到「匯入名單」那個選項（有選中的選項嗎：${audience.picked}），這一條沒驗到`)
      else if (audience.text.includes('複製 ID') && audience.text.includes('多數情況用不到'))
        pass('推播：「匯入名單」講得出那串編號去哪拿了')
      else
        fail(`推播：「匯入名單」的說明沒出現。實際讀到：「${audience.text.slice(0, 160)}」`)

      // ③ 推播成效說明不可以再把機器設定名攤給店家看
      const jargon = await page.evaluate(() => {
        const el = document.querySelector('.bc-click-hint')
        return el ? el.textContent ?? '' : ''
      })
      const leaked = ['PUBLIC_BASE_URL', 'LINE_IMAGEMAP_BASE_URL', 'CLICK_TRACKING_BASE_URL', '/api/r'].filter(t => jargon.includes(t))
      if (!jargon) fail('推播：找不到成效說明那段（.bc-click-hint）')
      else if (leaked.length) fail(`推播：成效說明還把這些攤給店家看－－${leaked.join('、')}`)
      else pass('推播：成效說明已經沒有機器設定名了')
    }
    catch (e) {
      fail(`就地說明加驗：${String(e).split('\n')[0]}`)
    }
    finally {
      await ctx.close()
    }
    console.log('')
  }

  // ── 加驗：已經展開「進階調校」的人，導覽不可以反手把它收起來 ──────────────
  // `clickBefore` 是無條件點的，而這個目標是**開關**不是按鈕：使用者自己先展開過的話，
  // 再點一次就等於當著他的面收起來，然後那一步指向一個剛被自己藏掉的東西。
  // 這正是 `clickBeforeUnless` 要擋的事，但它只有在「先展開」的情況下才會被執行到——
  // 上面那輪（預設收合）跑得再綠也驗不到這一條。
  {
    console.log('── 加驗：使用者自己先展開過「進階調校」──────────────────')
    const { page, ctx } = await openLoggedInPage()
    try {
      // ⛔ 不可以「展開之後再 goto ?tour=」：整頁重新載入會把展開狀態沖掉，
      //    這一關就變成跟上面那輪一模一樣的情境＝**假綠燈**（2026-09-18 破壞性驗證當場抓到：
      //    把 clickBeforeUnless 拆掉，這一關照樣綠）。所以改成不換頁，直接按頁首那顆問號開導覽。
      await page.goto(`${BASE}/admin/${WORKSPACE_ID}/ai-settings`, { waitUntil: 'networkidle2', timeout: 90_000 })
      await page.waitForSelector('[data-tour="ais-advanced"]', { timeout: 60_000 })
      // 自動導覽可能先跳出來蓋住畫面，先關掉再操作
      await page.keyboard.press('Escape')
      await sleep(800)
      await page.click('[data-tour="ais-advanced"]')
      await sleep(800)
      if (!(await page.$('[data-tour="ais-handback"]')))
        throw new Error('手動展開沒生效，這一關的前提不成立')

      await page.click('.page-help-btn')
      await page.waitForSelector('.ta-tour-title', { visible: true, timeout: 30_000 })
      // 走到第 5 步（那一步才會碰 clickBefore）
      for (let i = 1; i < 5; i++) await clickNext(page)
      const step = await readStep(page)
      const stillThere = !!(await page.$('[data-tour="ais-handback"]'))
      if (stillThere && step && !step.missing)
        pass(`已經展開的人：導覽沒有把「進階調校」收起來（第 ${step.count}「${step.title}」照樣指得到）`)
      else
        fail('已經展開的人：導覽反手把「進階調校」收起來了＝那一步指向一個剛被自己藏掉的東西')
    }
    catch (e) {
      fail(`加驗：${String(e).split('\n')[0]}`)
    }
    finally {
      await ctx.close()
    }
    console.log('')
  }
}
finally {
  // 原封還原，不留痕跡（⛔不是刪掉：那會清掉這位管理員真實的「看過了」）
  if (prefsData) await prefsRef.set(prefsData)
  else await prefsRef.delete().catch(() => {})
  console.log(`adminUserPrefs/${uid} 已${prefsData ? '還原成原本的內容' : '刪回原本的「不存在」'}`)
  await browser.close()
}

if (failed) process.exitCode = 1
else console.log('\n全部通過')
