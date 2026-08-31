<template>
  <div
    ref="root"
    class="lp lp-home"
    :class="{ 'is-stuck': stuck, 'is-anim': anim, 'is-menu-open': menuOpen }"
  >
    <!-- ══════════════════════════════════════════════════════════════
         導購頁。2026-08-26 依老闆的新版草稿（桌面「!DOCTYPE html.pages」）改版**結構與文案**；
         **視覺一律沿用既有設計系統**（白灰交錯、淡綠泡泡、單一綠強調）——老闆同日看截圖拍板
         「這個 html 只是架構跟文案的參考」，草稿自帶的深松綠段／奶油黃段／綠泡泡不搬
         （那套已經試過兩次、兩次都被打槍，詳見 _landing.scss 檔頭）。
         ⚠️ 區塊底色是**交錯**的：白 → 灰 → 白 → 灰⋯（灰的掛 .lp-section--tint）。
            目前順序：Hero(白) why(灰) value(白) fast(灰) pricing(白) grow(灰) faq(白)
            收尾CTA(綠)。新增或搬動區塊要跟著調。
         ⚠️ 2026-08-26 三處版面重排（老闆「排版只是參考，用資深 UIUX 重新想」）：
            ①「四關」與「解法」併成一區——原本兩個整屏區塊講同一件事，解法列還把
              四個問題重抄一遍；現在每張牆卡自帶解法（問題上、✓解法下），省一屏、對仗更強。
            ②「能做什麼」先人後介面——AI 客服/AI 行銷（有真截圖）先出，圖文選單卡在後；
              賣點是「多半個客服半個行銷」，選單是佐證不是主張。
            ③ 商品資訊卡已搬成**獨立頁 /product-info**（08-26 老闆拍板「直接開一個頁面」）：
              金流風控要的五項揭露集中在那一頁，入口＝定價區連結＋全站頁尾「產品」欄。
              ⚠️ 當初 PAYUNi 審的是首頁上的卡，搬頁後上線前建議知會 PAYUNi 業務一句。

         ⚠️ 兩件事會連坐別的頁面，動之前先看：
           1. 外殼類名（.lp-nav / .lp-brand / .lp-btn / .lp-wrap / .lp-foot）與三個法務頁
              共用（components/site/SiteLegalPage.vue）——只在首頁生效的東西掛 .lp-home。
           2. #value / #pricing / #faq 這三個 id 是頁尾與法務頁的連結目標
              （SiteFooter.vue），換 id 會變死連結。#diff（比較表）已隨 08-26 改版整區移除，
              頁尾的「功能比較」連結同步拿掉了。

         ⛔ 還沒上線的功能一律掛「即將推出」（.lp-soon）並講清楚哪一半是現有的。
            目前只有一處：圖文選單窄帶的「一句話代設」（標在那個詞旁邊，不用籠統的卡頂徽章）。
            ⚠️ 2026-08-27 老闆拍板「回購喚醒與生日經營先不要出現」——連同它們的成效數字
            （「每月喚回的訂單 0→12–18 張」）一起撤：功能不出現，它的數字更不能留。
            Hero 時機卡走另一套誠實機制（卡上只放真功能＋「以咖啡店為例」標示，見該區註解）。
            （判斷依據見 docs/STATUS.md）
         ⛔ 草稿裡的「付費後隨時可退」「前 14 天免費」**沒有照搬**：退費措辭只有一種寫法
            「不綁約、隨時可取消，取消後服務用到本期結束」——實際政策沒有退現金也沒有試用期，
            寫了就是對消費者的不實承諾（政策原文見 pages/refund.vue）。
         ⛔ 草稿末尾的「假註冊聊天視窗」（收 Email 後宣稱寄出開通連結）**沒有移植**：
            那就是 2026-07-20 自助導購漏斗修掉的「demo 表單黑洞」。所有 CTA 通往真的 /login。
         ══════════════════════════════════════════════════════════════ -->

    <!-- ── Nav（與法務頁共用外殼，只換錨點標籤）───────────────── -->
    <nav class="lp-nav">
      <div class="lp-wrap lp-nav__in">
        <!-- 商標＝品牌／產品名（MiniMe）；公司名（麥菲爾股份有限公司）在頁尾與法務頁揭露。
             兩個圖檔都出、由 CSS 切換：手機導覽列擠不下含字樣的 logotype（會把選單鈕推出畫面），
             ≤720px 改出 logomark。品牌名由 a 的 aria-label 提供，所以兩張圖都 alt=""。 -->
        <a class="lp-brand" href="#top" :aria-label="brandName">
          <BrandLogo class="lp-brand__type" alt="" />
          <BrandLogo mark class="lp-brand__mark" alt="" />
        </a>
        <div class="lp-nav__links">
          <a href="#why" @click="closeMenu">卡在哪</a>
          <a href="#value" @click="closeMenu">能做什麼</a>
          <a href="#pricing" @click="closeMenu">價格</a>
          <a href="#grow" @click="closeMenu">成長</a>
        </div>
        <div class="lp-nav__right">
          <NuxtLink to="/login" class="lp-nav__signin">登入</NuxtLink>
          <NuxtLink class="lp-btn lp-btn--primary lp-btn--sm" to="/login">免費註冊</NuxtLink>
          <button class="lp-nav__burger" aria-label="選單" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen"><span /></button>
        </div>
      </div>
    </nav>

    <!-- ── Hero ────────────────────────────────────────────────
         右邊是時機卡：節慶、該關心的客人、你分好的客群三組。
         節慶那組吃 shared/taiwan-festivals.ts 的真資料（系統本來就會在節前提醒老闆）。
         ⚠️ 誠實機制（2026-08-26 老闆拍板拿掉圖說後的替代方案，⛔別拆）：
           1. 卡片標頭右側掛「以咖啡店為例」＝整張卡明示是舉例，人數才可以出現；
              拿掉這個標示、又不掛圖說，虛構人數就是被當成真實客戶資料在賣。
              ⚠️ 用「舉例」而不是店名：一句「示範店 · 山丘咖啡」除了沒人懂「示範店」，
                 還可能被讀成「山丘咖啡是他們的客戶」——那比沒標示更糟（假造客戶案例）。
                 「以咖啡店為例」順便解釋了卡裡為什麼都是咖啡展、手沖這些內容。
           2. 卡上每一列都必須是**現在真的做得到**的事（節慶提醒、加入時間名單、
              60 天沒互動自動標籤、標籤分眾都是真功能）——之前「還沒說過第一句話」
              是開發中的偵測，已改掉。⛔要再放開發中的能力，免責圖說就得加回來。 -->
    <header id="top" class="lp-hero">
      <span class="lp-hero__blob lp-hero__blob--1" />
      <span class="lp-hero__blob lp-hero__blob--2" />
      <div class="lp-wrap lp-hero__grid">
        <div class="lp-hero__text">
          <span class="lp-eyebrow">LINE 專用 · AI 客服與顧客經營</span>
          <h1>你的顧客，<br>其實很<span class="g">值錢</span>。</h1>
          <!-- 兩句各佔一行（手機收掉 br 自然流）：擠在同一段時斷行位置會把詞拆開 -->
          <p class="lp-hero__sub">
            品牌的 LINE 官方帳號有好多好友，<br>
            <b>卻不知道如何經營他們嗎？</b>
          </p>
          <!-- 解答句：敘事閉環的第三拍（值錢→沒空經營→它是你的分身→免費打造）。
               ⛔刻意只有一行——「客服它回、行銷它提醒」往下捲整頁都在講，Hero 不多扛說明 -->
          <p class="lp-hero__answer"><b>{{ brandName }}</b>，替你經營他們的 AI 分身。</p>
          <div class="lp-hero__actions">
            <NuxtLink class="lp-btn lp-btn--primary" to="/login">免費打造我的 {{ brandName }}</NuxtLink>
          </div>
          <p class="lp-hero__fine">
            <b>60 秒</b>完成設定 · 免費方案不用綁卡 · 付費每月 <b>NT${{ fmt(lowestPaidPrice) }} 起</b>
          </p>
        </div>

        <div class="lp-hero__visual">
          <div class="lp-panel lp-ops">
            <div class="lp-panel__hd">
              <span class="lp-panel__pip" />
              <span class="lp-panel__title">你的好友裡，藏著這些機會</span>
              <!-- 「以咖啡店為例」是人數能出現的前提（見區塊註解）：⛔別換回好友數（那會變成
                   拿虛構數字當真實客戶資料），也⛔別寫成店名（「示範店 · 山丘咖啡」被老闆抓過
                   ——訪客不懂「示範店」，還可能讀成「山丘咖啡是他們的客戶」＝假造客戶案例）。 -->
              <span class="lp-panel__meta">以咖啡店為例</span>
            </div>

            <div class="lp-ops__group">
              <div class="lp-ops__head">節慶</div>
              <div v-for="f in heroFests" :key="f.id" class="lp-op">
                <b>{{ f.name }} {{ f.md }}</b>
                <small>{{ f.angle }}</small>
                <span class="lp-op__tag" :class="{ 'lp-op__tag--soon': f.soon }">{{ f.badge }}</span>
              </div>
            </div>

            <div class="lp-ops__group">
              <div class="lp-ops__head">該關心的客人</div>
              <div class="lp-op">
                <b>本週新加入的好友</b>
                <small>可以送上一句歡迎</small>
                <span class="lp-op__tag lp-op__tag--num">38 位</span>
              </div>
              <div class="lp-op">
                <b>上次聯絡超過 60 天</b>
                <small>可以請他們回來看看</small>
                <span class="lp-op__tag lp-op__tag--num">142 位</span>
              </div>
            </div>

            <div class="lp-ops__group">
              <div class="lp-ops__head">你分好的客群</div>
              <div class="lp-op">
                <b>南港展覽館咖啡展</b>
                <small>展場加入的好友</small>
                <span class="lp-op__tag lp-op__tag--num">216 位</span>
              </div>
              <div class="lp-op">
                <b>手沖愛好者</b>
                <small>買過單品豆</small>
                <span class="lp-op__tag lp-op__tag--num">184 位</span>
              </div>
            </div>

            <div class="lp-ops__cta">
              <NuxtLink class="lp-btn lp-btn--primary lp-btn--block" to="/login">免費打造我的 {{ brandName }}</NuxtLink>
            </div>
          </div>
        </div>
      </div>
    </header>

    <!-- ── 為什麼卡住：四道牆（問題＋解法同一張卡）─────────────
         四個原因不是平等的：第一道（沒人手）是前提，另外三個是它的後果，
         所以第一張卡佔 1.45 倍寬並吃綠底。情境小圖（.lp-wall__scene）是抽象示意圖形
         （人、對話、後台、價標），不含任何數字宣稱，不用掛示意圖說。
         ⚠️ 每張牆卡底部帶自己的答案（淡底面板）——原本「四道牆」與「四關一次解掉」是
            兩個整屏區塊，解法列還把問題重抄一遍才講解法；併卡之後問題與答案對得上、
            省一整屏（08-26 版面重排①）。⛔ 解法別再拆回獨立區塊。
         ⛔ 答案一律**一句話、一行**（08-27 老闆拍板）：窄卡裡答案的可用寬度量出來只有
            113px ≈ 一行 7 個字，寫成「一句＋一句補充」四張全部折行、四塊高低不齊。
            四句要保持對仗（都是 7–8 字的動作句），補充說明留給下面的區塊講。 -->
    <section id="why" class="lp-section lp-section--tint">
      <div class="lp-wrap">
        <div class="lp-turn lp-reveal">
          <span class="lp-turn__ava"><BrandLogo mark on-color alt="" /></span>
          <div class="lp-bubble">
            <h2>這件事，<br>老闆一直<span class="mark">卡在這四關</span>。</h2>
            <p>還好，每一關都有 AI 能接住的解法——</p>
          </div>
        </div>

        <div class="lp-walls">
          <div class="lp-wall lp-wall--main lp-reveal">
            <div class="lp-wall__scene" aria-hidden="true">
              <svg viewBox="0 0 200 84">
                <g transform="translate(8,14)"><circle cx="16" cy="14" r="11" fill="rgba(255,255,255,.28)" /><path d="M0 46c0-11 7-17 16-17s16 6 16 17" fill="rgba(255,255,255,.28)" /><rect x="2" y="52" width="28" height="5" rx="2.5" fill="rgba(255,255,255,.5)" /><rect x="2" y="61" width="20" height="5" rx="2.5" fill="rgba(255,255,255,.5)" /></g>
                <g transform="translate(56,14)"><circle cx="16" cy="14" r="11" fill="rgba(255,255,255,.28)" /><path d="M0 46c0-11 7-17 16-17s16 6 16 17" fill="rgba(255,255,255,.28)" /><rect x="2" y="52" width="28" height="5" rx="2.5" fill="rgba(255,255,255,.5)" /><rect x="2" y="61" width="24" height="5" rx="2.5" fill="rgba(255,255,255,.5)" /></g>
                <g transform="translate(104,14)"><circle cx="16" cy="14" r="11" fill="rgba(255,255,255,.28)" /><path d="M0 46c0-11 7-17 16-17s16 6 16 17" fill="rgba(255,255,255,.28)" /><rect x="2" y="52" width="28" height="5" rx="2.5" fill="rgba(255,255,255,.5)" /><rect x="2" y="61" width="16" height="5" rx="2.5" fill="rgba(255,255,255,.5)" /></g>
                <g transform="translate(152,14)" class="lp-wall__blink">
                  <circle cx="16" cy="14" r="11" fill="none" stroke="rgba(255,255,255,.34)" stroke-width="1.6" stroke-dasharray="3 3" />
                  <path d="M0 46c0-11 7-17 16-17s16 6 16 17" fill="none" stroke="rgba(255,255,255,.34)" stroke-width="1.6" stroke-dasharray="3 3" />
                  <text x="16" y="64" text-anchor="middle" font-size="12" fill="rgba(255,255,255,.5)">？</text>
                </g>
              </svg>
            </div>
            <h3>沒有人可以做</h3>
            <p class="lp-wall__sub">員工就是這麼多，每個人手上都滿了。</p>
            <p class="lp-wall__fix"><span aria-hidden="true">✓</span>它 24 小時都在</p>
          </div>

          <div class="lp-wall lp-reveal">
            <div class="lp-wall__scene" aria-hidden="true">
              <svg viewBox="0 0 160 84">
                <rect x="6" y="10" width="86" height="24" rx="10" fill="#edf1eb" />
                <rect x="16" y="19" width="52" height="5" rx="2.5" fill="#c6cec6" />
                <rect x="62" y="42" width="92" height="24" rx="10" fill="#e9fbf0" />
                <rect x="74" y="51" width="42" height="5" rx="2.5" fill="#9fd9b4" />
                <path d="M92 22 q26 0 26 20" stroke="#c6cec6" stroke-width="1.6" fill="none" stroke-dasharray="3 3" />
                <path d="M62 54 q-30 0 -30 18" stroke="#c6cec6" stroke-width="1.6" fill="none" stroke-dasharray="3 3" />
              </svg>
            </div>
            <h3>派了員工，還要照顧他的情緒</h3>
            <p class="lp-wall__sub">多一件事，就是多一次溝通。</p>
            <p class="lp-wall__fix"><span aria-hidden="true">✓</span>交辦只要一句話</p>
          </div>

          <div class="lp-wall lp-reveal">
            <div class="lp-wall__scene" aria-hidden="true">
              <svg viewBox="0 0 160 84">
                <rect x="6" y="8" width="44" height="68" rx="7" fill="#edf1eb" />
                <g fill="#d6ddd5"><rect x="12" y="15" width="32" height="5" rx="2.5" /><rect x="12" y="25" width="26" height="5" rx="2.5" /><rect x="12" y="35" width="30" height="5" rx="2.5" /><rect x="12" y="45" width="22" height="5" rx="2.5" /><rect x="12" y="55" width="28" height="5" rx="2.5" /><rect x="12" y="65" width="24" height="5" rx="2.5" /></g>
                <rect x="58" y="8" width="96" height="68" rx="7" fill="#f5f8f4" />
                <g stroke="#c6cec6" stroke-width="1.4" fill="none">
                  <path d="M70 26h22M104 26h20M92 26q10 0 10 14t14 14M70 54h34" />
                </g>
                <g fill="#fff" stroke="#cbd3cb" stroke-width="1.2">
                  <rect x="64" y="18" width="18" height="15" rx="4" /><rect x="98" y="18" width="18" height="15" rx="4" /><rect x="126" y="18" width="18" height="15" rx="4" />
                  <rect x="64" y="46" width="18" height="15" rx="4" /><rect x="100" y="46" width="18" height="15" rx="4" />
                </g>
              </svg>
            </div>
            <h3>自己動手，後台太複雜</h3>
            <p class="lp-wall__sub">打開來一堆設定，不知道從哪開始。</p>
            <p class="lp-wall__fix"><span aria-hidden="true">✓</span>畫面帶你一步步做</p>
          </div>

          <div class="lp-wall lp-reveal">
            <div class="lp-wall__scene" aria-hidden="true">
              <svg viewBox="0 0 160 84">
                <g transform="translate(2,22)">
                  <path d="M34 2h36a8 8 0 0 1 8 8v18a8 8 0 0 1-8 8H34L4 20z" fill="#f1f4f0" stroke="#d6ddd5" stroke-width="1.5" />
                  <circle cx="60" cy="19" r="4" fill="#fff" stroke="#c6cec6" stroke-width="1.4" />
                  <text x="88" y="26" font-size="17" font-weight="700" fill="#96a499">$3,000+</text>
                </g>
              </svg>
            </div>
            <h3>找其他工具，好貴</h3>
            <p class="lp-wall__sub">一個月好幾千，還得有人學、有人顧。</p>
            <p class="lp-wall__fix"><span aria-hidden="true">✓</span>一個月 NT${{ fmt(lowestPaidPrice) }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- ── 能做什麼：半個客服＋半個行銷 ─────────────────────────
         ⚠️ id 沿用 #value：頁尾與法務頁的「產品介紹」都指這裡，換 id 會變死連結。
         ⚠️ 順序＝AI 客服/AI 行銷（真截圖）先、圖文選單卡後（08-26 版面重排②）：
            區塊主張是「多半個客服、半個行銷」，那兩張卡才是主張本體。 -->
    <section id="value" class="lp-section">
      <div class="lp-wrap">
        <div class="lp-turn lp-reveal">
          <span class="lp-turn__ava"><BrandLogo mark on-color alt="" /></span>
          <div class="lp-bubble">
            <h2>多一個 <span class="lp-nb"><BrandLogo class="lp-bubble__logo" :alt="brandName" />，</span><br>等於多了<span class="mark">半個客服、半個行銷</span>。</h2>
          </div>
        </div>

        <!-- ⚠️ 進場動畫掛在**裡面每一塊**，不是掛在這層 .lp-stack：這一疊手機上有 2,126px 高，
             整疊當一個單位的話，捲到最上緣時底下 1,500px 的圖文選單窄帶就已經「進場」過了，
             真的捲到它時反而什麼都不會發生（而且元素越高，比例式的門檻越容易永遠達不到）。 -->
        <div class="lp-stack">
          <div class="lp-appgrid lp-reveal">
            <div class="lp-panel lp-appcard">
              <div class="lp-panel__hd">
                <span class="lp-panel__pip" />
                <span class="lp-panel__title">AI 客服</span>
                <span class="lp-panel__meta">系統實際畫面</span>
              </div>
              <div class="lp-panel__bd lp-appcard__bd">
                <div class="lp-app"><span class="lp-app__c">✓</span><div><b>產品基本 QA</b><small>規格、成分、怎麼用、怎麼挑</small></div></div>
                <div class="lp-app"><span class="lp-app__c">✓</span><div><b>常見問題 QA</b><small>運費、出貨、退換、營業時間</small></div></div>
                <!-- ⚠️ 真實介面截圖（2026-08-26 老闆拍板「截我們自己系統的圖」）：
                     後台對話頁，資料是種在測試工作區的示範對話（示範帳號、無真實客資）。
                     內容重點：AI 半夜秒回兩題（AI 徽章）→ 改訂單轉真人（機器人徽章）→
                     隔天早上真人跟進（真人徽章）。⛔ 要換圖用
                     scripts/landing-demo-seed.ts ＋ scripts/landing-shots.mjs 重截，
                     不可以自己拼一張假的當截圖。 -->
                <img
                  class="lp-shot"
                  src="/landing/admin-chat.png"
                  alt="後台對話畫面：客人半夜詢問手沖與禮盒，AI 立即回覆並標示 AI 徽章；改訂單需求轉給真人，隔天早上真人回覆並標示真人徽章"
                  loading="lazy"
                  width="1280"
                  height="1052"
                >
                <div class="lp-statrow lp-statrow--foot">
                  <div class="lp-stat"><span class="lp-stat__l">客人等回覆</span><span class="lp-stat__v"><i>4 小時</i><em>→</em><b>秒回</b></span></div>
                  <div class="lp-stat"><span class="lp-stat__l">訊息回覆率</span><span class="lp-stat__v"><i>6 成</i><em>→</em><b>全部回覆</b></span></div>
                </div>
              </div>
            </div>

            <div class="lp-panel lp-appcard">
              <div class="lp-panel__hd">
                <span class="lp-panel__pip" />
                <span class="lp-panel__title">AI 行銷</span>
                <span class="lp-panel__meta">系統實際畫面</span>
              </div>
              <div class="lp-panel__bd lp-appcard__bd">
                <div class="lp-app"><span class="lp-app__c">✓</span><div><b>節慶檔期提案</b><small>節到了先開口，連分眾都擬好</small></div></div>
                <div class="lp-app"><span class="lp-app__c">✓</span><div><b>客戶貼標分眾</b><small>買過什麼、來自哪個展場</small></div></div>
                <!-- ⚠️ 真實介面截圖：後台「好友」頁的標籤欄，五位示範好友（無真實客資）。
                     ⛔ 裁圖規矩：只能裁到示範資料那幾列——測試工作區下面幾列是**真實同事**
                     的名字與頭像，入鏡就是把個資放上官網。重截用 scripts/landing-shots.mjs。 -->
                <!-- ⚠️ 這張刻意用 --fill（撐滿卡片剩餘高度、底部超出的列裁掉）：兩張卡的截圖
                     天生高度差一倍，2026-08-27 老闆指定「讓右邊的圖高一些、跟左邊一樣高」。
                     ⛔ 源圖必須夠高（現在 12 列）否則 cover 會改裁寬度、把標籤欄切掉——
                     列數由 scripts/landing-demo-seed.ts 的 USERS 決定，重截見 landing-shots.mjs。 -->
                <img
                  class="lp-shot lp-shot--fill"
                  src="/landing/admin-friends-tags.png"
                  alt="後台好友列表：每位客人身上掛著彩色標籤，例如手沖愛好者、送禮客群、咖啡展加入，可直接篩選與改標籤"
                  loading="lazy"
                  width="1736"
                  height="1484"
                >
                <div class="lp-statrow lp-statrow--foot">
                  <!-- ⛔ 這兩格只能放**現有功能**的成效：原本第一格是「每月喚回的訂單 0→12–18 張」，
                       那是「回購喚醒」的成效，而該功能 2026-08-27 已從卡上撤掉（還沒上線）——
                       功能不出現、它的數字更不能留，否則是宣稱一個連清單上都沒有的能力。 -->
                  <div class="lp-stat"><span class="lp-stat__l">節慶檔期</span><span class="lp-stat__v"><i>自己記日子</i><em>→</em><b>系統先提醒</b></span></div>
                  <div class="lp-stat"><span class="lp-stat__l">客人資料</span><span class="lp-stat__v"><i>憑印象</i><em>→</em><b>自動記錄</b></span></div>
                </div>
              </div>
            </div>
          </div>

          <!-- 圖說只交代「資料是示範、數據是估算」——2026-08-27 起兩張卡上**只有現有功能**
               （回購喚醒／生日經營已撤下），所以不再需要「哪些還沒上線」那半句；
               「這是真介面」由卡片標頭的「系統實際畫面」meta 講。 -->
          <p class="lp-figcap lp-figcap--center lp-reveal">
            畫面中的客人與資料為示範；數據以一家 2,000 位好友的店估算，非實際績效。
          </p>

          <!-- ── 圖文選單：一條窄帶（2026-08-27 老闆拍板從 791px 的大卡降級）──
               它是「讓客服更省力」的手段，不是第三個能力，所以不給它跟兩張主卡同等的版面。
               ⚠️ 資訊層次刻意分三層：標題＝客人得到什麼／一句話＝為什麼省事／
                  底下一行＝**現在做得到 vs 還沒上線**（代設的徽章就標在那個詞旁邊，
                  不用卡頂那種籠統的「部分即將推出」）。
               ⛔ 只留「有選單」那一支手機：原本兩支做前後對照，但「沒有選單」那支只是在
                  演示問題、佔掉一半版面，說服力全在「有選單」這支。 -->
          <div class="lp-band lp-reveal">
            <div class="lp-band__text">
              <h3>常問的事變成按鈕，客人自己點</h3>
              <p>客人一打開你的 LINE 就看到選單——不必打字問，你也少回一輪。</p>
              <p class="lp-band__status">
                選單<b>現在就能在後台自己編排</b>；<br>
                想更省事，之後可以<b>一句話請 {{ brandName }} 代設</b><span class="lp-soon lp-soon--inline">即將推出</span>
              </p>
            </div>

            <!-- ⚠️ 2026-08-31 老闆拍板兩件事：①選單換成**真的圖文選單圖**（原本是 div 刻的
                 綠＋灰階色塊）②整支要做得「像真的手機截圖」。所以由上而下照真機一層層疊：
                 狀態列＋靈動島 → LINE 聊天室標頭 → 聊天區 → 輸入列 → 圖文選單 → Home 安全區。
                 ⛔ 輸入列一定在圖文選單**上面**：LINE 的圖文選單是頂掉鍵盤的位置展開的，
                    輸入列不會被蓋住。畫成選單壓在輸入列上面，用過 LINE 的人一眼就看得出是假的。
                 ⚠️ 聊天區放**一則**歡迎訊息（2026-08-31 老闆指定「山丘咖啡可以傳一個歡迎訊息」，
                    同時**推翻**了先前那條「⛔手機裡不放對話泡泡」——當初的顧慮是聊天內容會把焦點
                    從選單身上拉走）。所以規矩改成：**只留這一則、而且內容要把人指回選單**
                    （「下面選單可以直接逛禮盒、查訂單」）。⛔ 別再加第二則、更別演一來一往的對話，
                    那就是當初想避免的失焦。
                 ⚠️ 訊息靠聊天區**頂部**對齊、空白留在下面（2026-08-31 老闆抓到，我原本做成貼底）。
                    ⛔ 別再改回貼底：「新訊息在最下面」講的是**內容超過一頁時的捲動位置**，
                    訊息還沒填滿一頁時是從上往下排、空的是下半截——這支手機只有一則訊息，
                    正是沒填滿的情況。
                 ⛔ 泡泡旁邊不放店名：LINE 的一對一聊天室**不顯示對方名字**（只有群組才顯示），
                    加了就露餡。頭像＋白泡泡＋右下角時間才是對的。
                 ⚠️ 輸入列最左邊是**鍵盤**圖示、不是選單圖示：選單已經展開時那顆會切成鍵盤
                    （點下去收起選單回去打字），它同時解釋了「為什麼這支手機的選單是開著的」。
                 ⚠️ 尺寸全部對著 250px 的螢幕寬算＝ .lp-band__phone 的 268px 減掉 .lp-phone
                    兩側各 9px 的殼；改寬度時 SCSS 那邊的固定值要一起校。 -->
            <div class="lp-band__phone">
              <div class="lp-phone">
                <div class="lp-pscreen">
                  <div class="lp-pstatus">
                    <span class="lp-pstatus__time">9:41</span>
                    <span class="lp-pstatus__island" aria-hidden="true" />
                    <svg class="lp-pstatus__sys" viewBox="0 0 47 12" aria-hidden="true">
                      <g fill="currentColor">
                        <rect x="0" y="7.5" width="2.5" height="3.5" rx=".7" />
                        <rect x="3.8" y="6" width="2.5" height="5" rx=".7" />
                        <rect x="7.6" y="4" width="2.5" height="7" rx=".7" />
                        <rect x="11.4" y="2" width="2.5" height="9" rx=".7" />
                        <circle cx="22" cy="9.8" r="1.15" />
                        <rect x="32.3" y="3.7" width="8.2" height="4.8" rx="1.4" />
                      </g>
                      <g fill="none" stroke="currentColor" stroke-linecap="round">
                        <path d="M17.1 5.1a7 7 0 0 1 9.8 0" stroke-width="1.5" />
                        <path d="M19.1 7.4a4.2 4.2 0 0 1 5.8 0" stroke-width="1.5" />
                        <rect x="31" y="2.4" width="13" height="7.4" rx="2.3" stroke-width="1" opacity=".45" />
                        <path d="M45.3 5.2v2.2" stroke-width="1.4" opacity=".45" />
                      </g>
                    </svg>
                  </div>

                  <div class="lp-pnav">
                    <svg class="lp-pnav__back" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M15 4.5 7.5 12l7.5 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                    <span class="lp-pnav__ava" aria-hidden="true" />
                    <span class="lp-pnav__name">山丘咖啡</span>
                    <svg class="lp-pnav__ico" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M6.4 3.4h3.1l1.5 4-2 1.5a12.4 12.4 0 0 0 6.1 6.1l1.5-2 4 1.5v3.1a2 2 0 0 1-2.2 2A17.2 17.2 0 0 1 4.4 5.6a2 2 0 0 1 2-2.2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
                    </svg>
                    <svg class="lp-pnav__ico" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
                    </svg>
                  </div>

                  <div class="lp-pbody">
                    <span class="lp-pbody__day">今天</span>
                    <div class="lp-pmsg">
                      <span class="lp-pmsg__ava" aria-hidden="true" />
                      <p class="lp-pmsg__bubble">歡迎加入山丘咖啡！<br>下面選單可以直接逛禮盒、查訂單，有問題也可以直接問我們。</p>
                      <span class="lp-pmsg__time">9:41</span>
                    </div>
                  </div>

                  <div class="lp-pbar">
                    <svg class="lp-pbar__ico" viewBox="0 0 24 24" aria-hidden="true">
                      <rect x="2.5" y="6" width="19" height="12" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.7" />
                      <g fill="currentColor">
                        <rect x="5.5" y="9" width="2" height="2" rx=".6" />
                        <rect x="9" y="9" width="2" height="2" rx=".6" />
                        <rect x="12.5" y="9" width="2" height="2" rx=".6" />
                        <rect x="16" y="9" width="2.5" height="2" rx=".6" />
                        <rect x="7.5" y="13" width="9" height="2" rx=".8" />
                      </g>
                    </svg>
                    <svg class="lp-pbar__ico" viewBox="0 0 24 24" aria-hidden="true">
                      <g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round">
                        <path d="M3 8.6h3.3l1.6-2.3h8.2l1.6 2.3H21v9.8H3z" />
                        <circle cx="12" cy="13.2" r="3.3" />
                      </g>
                    </svg>
                    <span class="lp-pbar__field" aria-hidden="true" />
                    <svg class="lp-pbar__ico" viewBox="0 0 24 24" aria-hidden="true">
                      <g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
                        <circle cx="12" cy="12" r="8.6" />
                        <path d="M8.6 14.2a4.4 4.4 0 0 0 6.8 0" />
                      </g>
                      <g fill="currentColor"><circle cx="9.2" cy="10" r="1.1" /><circle cx="14.8" cy="10" r="1.1" /></g>
                    </svg>
                    <svg class="lp-pbar__ico" viewBox="0 0 24 24" aria-hidden="true">
                      <g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
                        <rect x="9.2" y="3" width="5.6" height="10.4" rx="2.8" />
                        <path d="M5.8 11.6a6.2 6.2 0 0 0 12.4 0M12 17.8V21" />
                      </g>
                    </svg>
                  </div>

                  <!-- ⚠️ 節日寫死在圖裡了：這張圖之前是 div 刻的，「{節日}禮盒」那句由
                       shared/taiwan-festivals.ts 算出「下一個送禮檔期」自動代入（所以永遠不會過期）。
                       換成整張圖之後那個機制沒了——**2026-09-25 中秋過完，官網就會掛著過期的圖**。
                       換圖流程：原始檔在 docs/landing-shots-src/，壓縮指令見同資料夾 README。
                       STATUS.md 有對應的待辦，別讓它沉掉。 -->
                  <img
                    class="lp-pmenu"
                    src="/landing/richmenu-midautumn.webp"
                    alt="LINE 圖文選單示意：上排兩格「本月精選」「會員專屬」，中間一整排是中秋節禮盒的主視覺與「立即選購」按鈕，下排三格「商品資訊」「訂單問題」「真人客服」"
                    loading="lazy"
                    width="800"
                    height="540"
                  >

                  <div class="lp-phome" aria-hidden="true"><i /></div>
                </div>
              </div>
            </div>
          </div>
          <!-- 「哪些現有、哪些未上線」窄帶自己那行已經講了，這裡只需標示意。
               ⚠️ 要講到「店家與商品為虛構」：選單換成實拍風格的圖之後，不講的人會以為
                  這是某家真的店的選單（兩張後台截圖有「系統實際畫面」標頭，這支沒有）。 -->
          <p class="lp-figcap lp-figcap--center lp-reveal">選單畫面為示意，店家與商品皆為虛構。</p>
        </div>
      </div>
    </section>

    <!-- ── 60 秒上線 ───────────────────────────────────────────
         左＝三步時間軸（註冊後真的會走的三步，不是行銷話術）；
         右＝開通引導對話的真實截圖（示範帳號「山丘咖啡」，見 scripts/landing-shots.mjs 圖三）。 -->
    <section id="fast" class="lp-section lp-section--tint">
      <div class="lp-wrap">
        <div class="lp-turn lp-reveal">
          <span class="lp-turn__ava"><BrandLogo mark on-color alt="" /></span>
          <div class="lp-bubble">
            <h2>只要 <span class="mark">60 秒</span>，<br>免費完成上線設定。</h2>
          </div>
        </div>

        <div class="lp-fast lp-stack lp-reveal">
          <div class="lp-panel">
            <div class="lp-panel__hd">
              <span class="lp-panel__pip" />
              <span class="lp-panel__title">現在只需要兩步</span>
              <span class="lp-panel__meta">60 秒</span>
            </div>
            <div class="lp-panel__bd">
              <!-- ⚠️ 只有**兩個**節點：標題就寫「兩步」。第三個節點（原本的「✓ 開始使用／60 秒」）
                   不是步驟、是做完的結果，已改成卡底的結果面板（沿用四道牆的答案面板語彙）。
                   ⛔ 別再把結果畫回第三個圈——標題說兩步、畫面三個圈，第一次看的人得自己數。
                      這樣「60 秒」在同一屏也只剩兩次（泡泡＋卡片 meta）。
                   ⚠️ 第一步是 **Google 一鍵登入**：2026-08-27 查證 app/pages/login.vue，
                      登入只有 `GoogleAuthProvider`，沒有 email 開通連結——原本寫
                      「登入 Email／收開通連結」是假的，客人點進去只會看到一顆 Google 按鈕。
                      改文案前先確認登入方式還是不是這個。 -->
              <div class="lp-tl lp-tl--two">
                <div class="lp-tl__track"><i /></div>
                <div class="lp-tl__steps">
                  <div class="lp-tl__step">
                    <span class="lp-tl__dot">1</span>
                    <b>用 Google 帳號登入</b>
                    <small>不用另外設密碼</small>
                  </div>
                  <div class="lp-tl__step">
                    <span class="lp-tl__dot">2</span>
                    <b>填寫基礎商家資訊</b>
                    <small>店名、行業、賣什麼</small>
                  </div>
                </div>
              </div>
              <div class="lp-tl__done"><span aria-hidden="true">✓</span>帳號就開好了，可以開始設定</div>
            </div>
          </div>

          <div class="lp-panel">
            <div class="lp-panel__hd">
              <span class="lp-panel__pip" />
              <span class="lp-panel__title">接 LINE 的時候，有人陪</span>
              <span class="lp-panel__meta">系統實際畫面</span>
            </div>
            <div class="lp-panel__bd">
              <!-- ⚠️ 真實介面截圖：開通引導對話（示範帳號山丘咖啡，刻意沒接 LINE 才停在這一步）。
                   重截用 scripts/landing-demo-seed.ts ＋ scripts/landing-shots.mjs。 -->
              <img
                class="lp-shot lp-shot--flush"
                src="/landing/admin-onboarding.png"
                alt="開通引導對話畫面：進度條顯示建帳號、拿鑰匙、接線、傳話測試、完成五步，小幫手一句一句教你從 LINE 拿金鑰，並提供「教我一步步拿」按鈕"
                loading="lazy"
                width="1440"
                height="648"
              >
              <p class="lp-fast__note">不懂技術也沒關係——每一步都用聊天帶你做，卡住就點「教我一步步拿」。</p>
            </div>
          </div>
        </div>

        <!-- ⚠️ 這一區原本**一顆按鈕都沒有**：讀者剛被說服「原來這麼簡單」，卻要自己滑到定價區
             才找得到入口。⛔ 用詞跟全站一致（免費打造我的 MiniMe），別自己另取一個。 -->
        <div class="lp-fast__cta lp-reveal">
          <NuxtLink class="lp-btn lp-btn--primary" to="/login">免費打造我的 {{ brandName }}</NuxtLink>
          <p class="lp-fast__fine"><b>免費方案不用綁卡</b>，接 LINE 的部分隨時可以再回來做。</p>
        </div>
      </div>
    </section>

    <!-- ── 價格 ────────────────────────────────────────────────
         大字報價，數字讀 plans.ts（單一事實來源），調價這裡自己跟上。
         方案卡目錄已隨 08-26 改版收掉（試銷期只主打 399，見 FEATURED_PLAN_IDS）；
         金流風控的五項揭露住在獨立頁 /product-info（見該頁檔頭），
         ⛔ 底下那條「完整商品資訊」連結是首頁通往揭露頁的路，不能拿掉。 -->
    <section id="pricing" class="lp-section">
      <div class="lp-wrap">
        <!-- 價格鎖排（lockup）：貨幣、數字、單位同一條基線一行讀完——
             「NT$ 懸在數字左上、／月掉到下一行」被老闆抓過（單位跟數字分家，要拼兩行才懂）。 -->
        <div class="lp-bigprice lp-reveal">
          <span class="lp-bigprice__lbl">一個月只要</span>
          <div class="lp-bigprice__num">
            <span class="lp-bigprice__cur">NT$</span>{{ fmt(lowestPaidPrice) }}<span class="lp-bigprice__per">／月</span>
          </div>
          <span class="lp-bigprice__unit">不綁約、隨時可取消</span>
        </div>

        <div class="lp-pricefeat lp-reveal">
          <!-- ⛔ 這三張卡刻意**沒有圖示磚**：原本是 logo／✓／✓，兩顆一模一樣——
               房規「每一列都長一樣的圖示等於沒有圖示」（同 Hero 檔期列拿掉方磚的理由）。
               三個標題本身就講完了，磚只是裝飾。 -->
          <div class="lp-pf">
            <b>友善的引導式設定</b>
            <small>一步一步帶你完成，部分步驟有 AI 協助標示——不用怕複雜。</small>
          </div>
          <div class="lp-pf">
            <b>別人有的，我們都有</b>
            <small>自動化訊息、客服流程、AI 客服、AI 行銷建議、報表。</small>
          </div>
          <div class="lp-pf">
            <b>60 秒就能開始</b>
            <small>Google 登入、填一下商家資訊，今天就能讓它上工。</small>
          </div>
        </div>

        <div class="lp-pricecta lp-reveal">
          <NuxtLink class="lp-btn lp-btn--primary" to="/login">免費打造我的 {{ brandName }}</NuxtLink>
          <p class="lp-pricecta__fine">每個帳號都有免費額度，額度用完時 AI 會先轉真人接手，<b>不會自動扣款</b>。</p>
          <!-- 法遵揭露在獨立頁（/product-info，頁尾也有入口），這裡留一條看得見的路過去 -->
          <p class="lp-pricecta__more"><NuxtLink to="/product-info">完整商品資訊、付款與發票說明 →</NuxtLink></p>
        </div>
      </div>
    </section>

    <!-- ── 生意成長 ────────────────────────────────────────────
         兩條線：綠＝也經營舊客、灰＝只靠新客。示意模型，Y 軸刻意沒有刻度、
         也刻意不畫格線（沒有刻度可對照，格線只是雜訊）。
         顏色是量過對比度與色盲可辨識度才定的（見 _landing.scss 的 .lp-chart）。 -->
    <section id="grow" class="lp-section lp-section--tint">
      <div class="lp-wrap">
        <div class="lp-turn lp-reveal">
          <span class="lp-turn__ava"><BrandLogo mark on-color alt="" /></span>
          <div class="lp-bubble">
            <h2>有了 <span class="lp-nb"><BrandLogo class="lp-bubble__logo" :alt="brandName" />，</span><br>讓你的生意<span class="mark">每年都翻倍</span>。</h2>
            <p>因為舊客會回來，而且會帶人回來。</p>
          </div>
        </div>

        <div class="lp-stack lp-reveal">
          <!-- 刻意沒有標頭列：「營業額成長 · 示意模型」與圖說重複 -->
          <div class="lp-panel lp-panel--plain">
            <div class="lp-panel__bd">
              <div class="lp-chartwrap">
                <svg class="lp-chart" viewBox="0 0 760 330" preserveAspectRatio="xMidYMid meet" role="img" aria-label="示意模型：同時經營舊客的成長曲線逐年拉開，只靠新客的曲線幾乎持平">
                  <defs>
                    <linearGradient id="lpGrowArea" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stop-color="#06c755" stop-opacity=".22" />
                      <stop offset="100%" stop-color="#06c755" stop-opacity="0" />
                    </linearGradient>
                  </defs>
                  <line class="lp-chart__axis" x1="60" y1="284" x2="700" y2="284" />
                  <path
                    class="lp-chart__area"
                    d="M60 265 C110 262,160 256,210 250 C260 243,310 234,360 220 C410 205,460 186,510 160 C560 130,610 92,660 40 L660 280 L60 280 Z"
                    fill="url(#lpGrowArea)"
                  />
                  <!-- ⚠️ 兩條線都給 pathLength="1"：畫線動畫用 stroke-dasharray／dashoffset，
                       這個屬性讓瀏覽器把「線有多長」一律當成 1，動畫就能寫成 1 → 0。
                       ⛔ 別改回寫一個「比兩條都長」的固定值（原本是 1200，而兩條實際只有
                          658 與 600）：那樣線在動畫走到 21% 時就已經畫完，後面 0.86 秒
                          畫面是靜止的，然後標籤才突然浮出來——量過的，不是感覺。
                       附帶好處：兩條長度不同的線會同時畫完，不會一條先到。 -->
                  <path
                    class="lp-chart__base"
                    pathLength="1"
                    d="M60 265 C110 264,160 263,210 263 C260 262,310 261,360 260 C410 259,460 258,510 258 C560 257,610 256,660 256"
                  />
                  <path
                    class="lp-chart__me"
                    pathLength="1"
                    d="M60 265 C110 262,160 256,210 250 C260 243,310 234,360 220 C410 205,460 186,510 160 C560 130,610 92,660 40"
                  />
                  <g class="lp-chart__dots">
                    <circle class="lp-chart__dot--me" cx="660" cy="40" r="7" />
                    <circle class="lp-chart__dot--base" cx="660" cy="256" r="6" />
                  </g>
                  <g class="lp-chart__x">
                    <text x="60" y="308" text-anchor="middle">第 1 年</text>
                    <text x="210" y="308" text-anchor="middle">第 2 年</text>
                    <text x="360" y="308" text-anchor="middle">第 3 年</text>
                    <text x="510" y="308" text-anchor="middle">第 4 年</text>
                    <text x="660" y="308" text-anchor="middle">第 5 年</text>
                  </g>
                  <!-- 標籤吃墨色、不吃線色：顏色由線端圓點與下方圖例的色塊帶 -->
                  <g class="lp-chart__lbls">
                    <text class="lp-chart__lbl--me" x="644" y="24" text-anchor="end">也經營舊客</text>
                    <text class="lp-chart__lbl--base" x="644" y="242" text-anchor="end">只靠新客</text>
                  </g>
                </svg>
              </div>
              <div class="lp-chartlegend">
                <span class="lp-cl"><i class="is-me" />也經營舊客：他們回購，也帶朋友來</span>
                <span class="lp-cl"><i class="is-base" />只靠新客：每一單都要重新買廣告</span>
              </div>
              <p class="lp-figcap">
                示意模型，非實際績效或收益保證：假設每年回購與轉介紹持續累積。
                實際成長依產業、商品、價格與經營方式而異。
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ── 常見問題 ────────────────────────────────────────────
         08-26 草稿沒有這一區，但保留：頁尾與法務頁的 /#faq 指這裡，
         而且退費、額度、資料刪除這幾題的答案都是照政策措辭寫的，拿掉等於少一處對消費者的揭露。 -->
    <section id="faq" class="lp-section lp-faqsec">
      <div class="lp-wrap">
        <!-- ⚠️ 這一區原本是 eyebrow＋h2，08-27 收成跟其他區塊一樣的泡泡：
             全頁八個區塊只剩它不是「MiniMe 開口說話」，節奏斷在這裡；
             而且 FAQ 本來就是它在回答問題，泡泡比中性標題更貼。 -->
        <div class="lp-turn lp-reveal">
          <span class="lp-turn__ava"><BrandLogo mark on-color alt="" /></span>
          <div class="lp-bubble">
            <h2>開始之前，<br>你可能還想問<span class="mark">這些</span>。</h2>
          </div>
        </div>
        <div class="lp-faq lp-reveal">
          <div class="lp-faq__grid">
            <div>
              <details class="lp-q">
                <summary>我不懂技術，也能設定嗎？<span class="plus" v-html="plusIcon" /></summary>
                <div class="a">可以。註冊後有 AI 陪你用聊天的方式把設定做完——你回答店名、給一份菜單或官網，它自己讀完建成知識庫，全程不用寫程式。</div>
              </details>
              <details class="lp-q">
                <summary>我的客戶資料安全嗎？<span class="plus" v-html="plusIcon" /></summary>
                <!-- ⛔ 別把「可自行刪除」加回來：後台沒有刪除客人／對話的入口。這句要跟隱私權頁
                     （2026-08-21 已改成寄信處理）講一樣的話——做出自助刪除（STATUS H-15c）之前，
                     任何一處寫「隨時可刪」都是對消費者的不實承諾。 -->
                <div class="a">資料存在你自己的工作區，我們不會另作他用。需要刪除特定客人或整批資料時，寄信到 <a :href="emailHref">{{ email }}</a>，我們會在確認你的身分後 30 日內處理。</div>
              </details>
              <details class="lp-q">
                <summary>按用量計價，會不會爆帳單？<span class="plus" v-html="plusIcon" /></summary>
                <div class="a">不會。每個帳號都有免費額度，之後按 AI 回覆則數計價。用量在後台看得到，額度用完時 AI 會停止自動回覆並轉真人接手，<b>不會自動加收超量費用</b>——要加購額度或升級方案都由你決定。</div>
              </details>
            </div>
            <div>
              <details class="lp-q">
                <summary>需要綁約嗎？<span class="plus" v-html="plusIcon" /></summary>
                <div class="a">不用。隨時可取消，取消後服務用到本期結束、不會再扣款。取消方式與退費規則見<NuxtLink to="/refund">退費與取消政策</NuxtLink>。</div>
              </details>
              <details class="lp-q">
                <summary>支援哪種 LINE 帳號？<span class="plus" v-html="plusIcon" /></summary>
                <!-- ⚠️ 口徑跟 60 秒區一致（「每一步都用聊天帶你做」）：原本寫「貼一組 Webhook
                     網址即可接通」——對不懂技術的讀者是天書，跟全頁「不懂技術也沒關係」打架
                     （順帶修掉句中的半形逗號）。 -->
                <div class="a">你現在用的 LINE 官方帳號（OA）就可以接。接通的每一步都有聊天引導帶你做，不懂技術也沒關係。</div>
              </details>
              <details class="lp-q">
                <summary>客人想找真人怎麼辦？<span class="plus" v-html="plusIcon" /></summary>
                <div class="a">可一鍵轉真人，對話統計也會記錄轉真人的情況。</div>
              </details>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ── 收尾 CTA ────────────────────────────────────────────
         想找人談的路徑＝頁尾的客服電話／信箱＋這裡的來信洽詢（預約 Demo 表單 08-14 已移除，
         ⛔ 不要留 /#demo 死錨點）。 -->
    <section class="lp-section lp-cta">
      <span class="lp-cta__blob lp-cta__blob--1" />
      <span class="lp-cta__blob lp-cta__blob--2" />
      <div class="lp-wrap lp-cta__in">
        <h2>從今天開始，<br>讓一個你，變成很多個你。</h2>
        <p class="lp-cta__sub">連結你的 LINE 官方帳號，60 秒打造第一個 {{ brandName }}。</p>
        <div class="lp-cta__actions">
          <NuxtLink class="lp-btn lp-btn--white" to="/login">免費打造我的 {{ brandName }}</NuxtLink>
          <a class="lp-cta__talk" :href="emailHref">想先聊聊？寄信給我們 →</a>
        </div>
        <p class="lp-cta__fine">每月 NT${{ fmt(lowestPaidPrice) }} · 不綁約、隨時可取消，取消後服務用到本期結束</p>
      </div>
    </section>

    <!-- ── Footer（公司資訊／客服窗口／政策條款，與法務頁共用同一個元件）── -->
    <SiteFooter />

    <!-- ── 黏性行動條（捲離 Hero 之後升起）──────────────────────
         收起時 aria-hidden：不然螢幕閱讀器會在頁尾唸到一顆看不見的註冊鈕。 -->
    <div class="lp-stickybar" :class="{ 'is-show': barShown }" :aria-hidden="barShown ? undefined : 'true'">
      <div class="lp-stickybar__in">
        <!-- 「多了半個」的「了」不能省：省掉會被讀成「多半（大概）個客服」，泡泡版就是有「了」 -->
        <span class="lp-stickybar__t1">一個月只要 <em>NT${{ fmt(lowestPaidPrice) }}</em>，多了半個客服＋半個行銷</span>
        <span class="lp-stickybar__t2">60 秒完成設定 · 不綁約、隨時可取消</span>
        <NuxtLink class="lp-btn lp-btn--primary lp-btn--sm" to="/login" :tabindex="barShown ? undefined : -1">免費打造</NuxtLink>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { BubbleTyping } from '~/utils/bubble-typing'
import { prepareBubbleTyping } from '~/utils/bubble-typing'
import { BILLING_PLAN_ORDER, BILLING_PLANS, FEATURED_PLAN_IDS } from '~~/shared/billing/plans'
import { TAIWAN_FESTIVALS } from '~~/shared/taiwan-festivals'
import { daysBetween, taipeiDate } from '~~/shared/time'

definePageMeta({ layout: false })

// 品牌／產品／公司／客服窗口統一由這裡來（與法務頁、頁尾同一份來源）。
// ⚠️ brandName = 品牌／產品名（MiniMe）、companyName = 營運主體（麥菲爾股份有限公司），別混用。
// ⚠️ 草稿裡寫「Mini Me」（有空格）的地方一律用 brandName 代入：商標、電子發票品名、
//    向 PAYUNi 申報的商品名都是無空格的 MiniMe，門面自己寫另一種拼法會對不起來。
const { brandName, email, emailHref } = useSiteIdentity()

const plusIcon
  = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 3v12M3 9h12"/></svg>'

/** 千分位。刻意不用 toLocaleString：SSR（Node ICU）與瀏覽器可能給出不同字串，會造成 hydration 不一致。 */
function fmt(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// ── 價格：直接讀 shared/billing/plans.ts（單一事實來源），改價只動那份、不用改門面 ──
// 「一個月 399」的 399 讀 plans.ts，不寫死——調價時 Hero、解法列、定價區、黏性條會一起對。
const lowestPaidPrice = computed(() => {
  const prices = BILLING_PLAN_ORDER
    .map(id => BILLING_PLANS[id])
    .filter(p => !p.internal && !p.landingHidden && !p.custom)
    .map(p => p.priceMonthly)
    .filter((n): n is number => typeof n === 'number' && n > 0)
  return prices.length ? Math.min(...prices) : 0
})

// ── SEO / 社群分享 ──
// ⚠️ 這一段一定要放在 lowestPaidPrice 之後：ogDescription 是會被立刻求值的函式，
//    擺在 const 宣告之前會踩到 TDZ，整個 app 初始化就掛掉（實際踩過）。
//
// 分享預覽圖要絕對網址（LINE／Facebook 的爬蟲不吃相對路徑）。
// ⛔不要寫死網域：這是多租戶部署，而且這個專案搬過網域（見 LIFF 遷移那次的災情）。
// useRequestURL() 在 SSR 拿請求的 origin、在瀏覽器拿 location，跟著部署走。
const ogImageUrl = `${useRequestURL().origin}/og-cover.png`

useSeoMeta({
  // 這是產品的行銷頁，標題以產品名為主；公司名在頁尾與法務頁揭露。
  title: `${brandName} — 你的顧客，其實很值錢｜LINE AI 客服 × CRM × 再行銷`,
  description:
    '你的 LINE 官方帳號已經有好多好友，只是還不知道怎麼經營。AI 客服 24 小時回訊息、名單依標籤自動分眾推播、聊過買過自動貼標，節慶檔期還會主動提醒你——註冊一分鐘，用你現有的官方帳號開通。',
  ogTitle: `${brandName} — 你的顧客，其實很值錢`,
  // 價格寫在這裡而不是圖上：這行是動態組的，調價會自己跟上；圖檔調價沒人會記得重跑
  ogDescription: `接走日常客服、分眾喚醒老客、把買過一次的人養成熟客。月費 NT$${fmt(lowestPaidPrice.value)} 起，免綁約。`,
  ogType: 'website',
  ogImage: ogImageUrl,
  ogImageWidth: 1200,
  ogImageHeight: 630,
  ogImageAlt: `${brandName} — 你的顧客，其實很值錢`,
  twitterCard: 'summary_large_image',
  twitterImage: ogImageUrl,
})

// ══════════════════════════════════════════════════════════════
//  Hero 時機卡的「節慶」組
//
//  資料來源＝ shared/taiwan-festivals.ts，也就是系統真的用來提醒老闆的那張表。
//  ⛔ 別在這裡另外寫一份節日清單：草稿寫死「父親節 8/8 下週」，做頁面的當下就已經過期了
//     ——名稱與日期一律從表裡拿，才不會有這個問題。
// ══════════════════════════════════════════════════════════════

/**
 * 「今天」是幾號（台北時區）。
 *
 * ⚠️ 用 useState 而不是直接 `taipeiDate()`：SSR 與瀏覽器各算一次的話，跨午夜的請求
 *    兩邊會拿到不同日期 → hydration 不一致。useState 的值會隨 payload 送到瀏覽器。
 */
const today = useState<string>('lp-today', () => taipeiDate())

/** 09-25 → 9/25（去掉前導零，跟訊息裡的寫法一致） */
function monthDay(date: string): string {
  const [, m, d] = date.split('-')
  return `${Number(m)}/${Number(d)}`
}

/** 還沒過的節日，由近到遠。節日表本身已依日期排序（有測試在顧）。 */
const upcoming = computed(() =>
  TAIWAN_FESTIVALS
    .map(f => ({ ...f, days: daysBetween(today.value, f.date) }))
    .filter(f => f.days >= 0),
)

/** 時機卡列接下來兩個檔期。7 天內＝系統開始提醒的門檻，標琥珀；更遠的標「準備中」（草稿用語）。 */
const heroFests = computed(() =>
  upcoming.value.slice(0, 2).map(f => ({
    id: f.id,
    name: f.name,
    md: monthDay(f.date),
    angle: f.angle,
    soon: f.days <= 7,
    badge: f.days === 0 ? '今天' : f.days === 1 ? '明天' : f.days <= 7 ? `還有 ${f.days} 天` : '準備中',
  })),
)

/*
 * ⚠️ 這裡本來有一個 giftFestName：圖文選單示意裡那句「{節日}禮盒」用的節日，從 upcoming
 *    挑出接下來第一個**送禮檔期**代入（挑送禮檔期而不是下一個節日，是因為那句話講的是禮盒，
 *    套到中元節、國慶日會語意不通）。它存在的理由是「寫死的節日會過期」——草稿寫「父親節」，
 *    做頁面的當天就已經過完了。
 *    2026-08-31 老闆拍板改用實拍的圖文選單圖，節日跟著進了圖裡，這段就沒有東西可以代入了，
 *    所以整個移除（留著不用會變成沒人敢刪的死碼）。**過期問題沒有消失，只是換成人工換圖**，
 *    追蹤在 STATUS.md。要復活的話這幾行照抄回來即可。
 */

// ── 互動（進場效果、黏性條、手機選單）──
// 伺服器端與「減少動態效果」時直接給最終狀態，所以沒有 JS 也讀得到完整內容。
const root = ref<HTMLElement | null>(null)
const stuck = ref(false)
const anim = ref(false)
const menuOpen = ref(false)
const barShown = ref(false)

function closeMenu() { menuOpen.value = false }
function onScroll() { stuck.value = window.scrollY > 8 }

let io: IntersectionObserver | undefined
let barIo: IntersectionObserver | undefined
/** 每顆對話泡泡的打字控制，key＝該泡泡的 .lp-turn（它同時就是 .lp-reveal 的觀察對象） */
const typings = new Map<HTMLElement, BubbleTyping>()

onMounted(() => {
  window.addEventListener('scroll', onScroll, { passive: true })
  onScroll()

  // 黏性條與動畫無關（它是行動入口，不是效果），所以擺在 reduced-motion 的早退之前
  const hero = root.value?.querySelector('.lp-hero')
  if (hero) {
    barIo = new IntersectionObserver(
      entries => { barShown.value = !(entries[0]?.isIntersecting ?? true) },
      { threshold: 0 },
    )
    barIo.observe(hero)
  }

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduce) return

  document.documentElement.style.scrollBehavior = 'smooth'
  anim.value = true

  nextTick(() => {
    // 泡泡先把句子拆成一顆一顆的字（此時泡泡還是 opacity:0，拆的過程看不到），捲到才播。
    // ⚠️ DOM 裡永遠是完整句子、只是先透明——爬蟲與沒有 JS 的人看到的內容不變，見 utils/bubble-typing.ts
    root.value?.querySelectorAll<HTMLElement>('.lp-turn').forEach((turn) => {
      const typing = prepareBubbleTyping(turn)
      if (typing) typings.set(turn, typing)
    })

    const els = root.value?.querySelectorAll<HTMLElement>('.lp-reveal') ?? []
    // ⚠️ threshold 用 0 ＋ 底部 -12%（不是 threshold 0.12）：threshold 是**比例**，
    //    元素比視窗高很多時比例永遠到不了門檻，那一塊就再也不會出現。
    //    現況最險的是「能做什麼」那疊，手機上 2,126px、最大比例只有 0.29——今天還過得去，
    //    但那是運氣不是設計。改成「上緣越過畫面 88% 就算進場」就沒有這個失敗模式。
    io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return
        e.target.classList.add('in')
        typings.get(e.target as HTMLElement)?.play()
        io?.unobserve(e.target)
      })
    }, { threshold: 0, rootMargin: '0px 0px -12% 0px' })
    els.forEach(el => io?.observe(el))
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll)
  io?.disconnect()
  barIo?.disconnect()
  typings.forEach(t => t.cancel())
  typings.clear()
  document.documentElement.style.scrollBehavior = ''
})
</script>
