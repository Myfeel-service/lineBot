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

         ⛔ 還沒上線的功能一律掛「即將推出」（.lp-soon）並用圖說講清楚哪一半是現有的。
            目前掛著的有：圖文選單代設、AI 行銷卡（回購喚醒／生日經營）；
            Hero 時機卡的「新好友還沒開口」名單寫在圖說裡。（判斷依據見 docs/STATUS.md）
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
         右邊是「現在可以把握的時機」卡（08-26 草稿）：節慶、客戶狀態、標籤三組時機。
         節慶那組吃 shared/taiwan-festivals.ts 的真資料（系統本來就會在節前提醒老闆），
         其餘兩組與好友數是虛構示範——所以圖說必須交代哪一半是真的（⛔ 拿掉圖說前先想清楚：
         沒有那行，虛構人數就是被當成真實客戶資料在賣）。 -->
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
              <span class="lp-panel__title">現在可以把握的時機</span>
              <span class="lp-panel__meta">2,148 位好友</span>
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
              <div class="lp-ops__head">客戶狀態</div>
              <div class="lp-op">
                <b>本週新加入的好友</b>
                <small>還沒說過第一句話</small>
                <span class="lp-op__tag lp-op__tag--num">38 位</span>
              </div>
              <div class="lp-op">
                <b>上次聯絡超過 60 天</b>
                <small>可以請他們回來看看</small>
                <span class="lp-op__tag lp-op__tag--num">142 位</span>
              </div>
            </div>

            <div class="lp-ops__group">
              <div class="lp-ops__head">標籤</div>
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
              <NuxtLink class="lp-btn lp-btn--primary lp-btn--block" to="/login">建立你的 {{ brandName }}</NuxtLink>
            </div>
          </div>
          <p class="lp-figcap">
            示意畫面：好友數、人數與標籤為虛構示範。節慶檔期與「60 天沒聯絡」名單是現有功能、由系統自動產生；
            「新好友還沒開口」的自動名單仍在開發中。
          </p>
        </div>
      </div>
    </header>

    <!-- ── 為什麼卡住：四道牆（問題＋解法同一張卡）─────────────
         四個原因不是平等的：第一道（沒人手）是前提，另外三個是它的後果，
         所以第一張卡佔 1.45 倍寬並吃綠底。情境小圖（.lp-wall__scene）是抽象示意圖形
         （人、對話、後台、價標），不含任何數字宣稱，不用掛示意圖說。
         ⚠️ 每張牆卡底部帶自己的解法（✓ 綠字）——原本「四道牆」與「四關一次解掉」是
            兩個整屏區塊，解法列還把問題重抄一遍才講解法；併卡之後問題與解法對得上、
            省一整屏（08-26 版面重排①）。⛔ 解法別再拆回獨立區塊。 -->
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
            <span class="lp-wall__n">1</span>
            <h3>沒有人可以做</h3>
            <p>員工就是這麼多，每個人手上都滿了。</p>
            <div class="lp-wall__fix">
              <span class="lp-app__c">✓</span>
              <div><b>它 24 小時都在</b><small>不用增加人力，也不用排班</small></div>
            </div>
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
            <span class="lp-wall__n">2</span>
            <h3>派了員工，還要照顧他的情緒</h3>
            <p>多一件事，就是多一次溝通。</p>
            <div class="lp-wall__fix">
              <span class="lp-app__c">✓</span>
              <div><b>交辦只要一句話</b><small>它不會累，也不用溝通</small></div>
            </div>
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
            <span class="lp-wall__n">3</span>
            <h3>自己動手，後台太複雜</h3>
            <p>打開來一堆設定，不知道從哪開始。</p>
            <div class="lp-wall__fix">
              <span class="lp-app__c">✓</span>
              <div><b>一步一步跟著做就好</b><small>重點的地方 AI 幫你標出來</small></div>
            </div>
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
            <span class="lp-wall__n">4</span>
            <h3>找其他工具，好貴</h3>
            <p>一個月好幾千，還得有人學、有人顧。</p>
            <!-- ⛔ 這裡不能寫「隨時可退」：退費措辭只有檔頭那一種寫法 -->
            <div class="lp-wall__fix">
              <span class="lp-app__c">✓</span>
              <div><b>一個月 NT${{ fmt(lowestPaidPrice) }}</b><small>不綁約、隨時可取消</small></div>
            </div>
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

        <div class="lp-stack lp-reveal">
          <div class="lp-appgrid">
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
                <span class="lp-soon">部分即將推出</span>
              </div>
              <div class="lp-panel__bd lp-appcard__bd">
                <div class="lp-app"><span class="lp-app__c">✓</span><div><b>節慶檔期提案</b><small>節到了先開口，連分眾都擬好</small></div></div>
                <div class="lp-app"><span class="lp-app__c">✓</span><div><b>客戶貼標分眾</b><small>買過什麼、來自哪個展場</small></div></div>
                <div class="lp-app"><span class="lp-app__c">✓</span><div><b>回購喚醒</b><small>久沒來的，替你請回來</small></div></div>
                <div class="lp-app"><span class="lp-app__c">✓</span><div><b>生日與會員經營</b><small>該送券的時候自動送</small></div></div>
                <!-- ⚠️ 真實介面截圖：後台「好友」頁的標籤欄，五位示範好友（無真實客資）。
                     ⛔ 裁圖規矩：只能裁到示範資料那幾列——測試工作區下面幾列是**真實同事**
                     的名字與頭像，入鏡就是把個資放上官網。重截用 scripts/landing-shots.mjs。 -->
                <img
                  class="lp-shot"
                  src="/landing/admin-friends-tags.png"
                  alt="後台好友列表：每位客人身上掛著彩色標籤，例如手沖愛好者、送禮客群、咖啡展加入，可直接篩選與改標籤"
                  loading="lazy"
                  width="1736"
                  height="670"
                >
                <div class="lp-statrow lp-statrow--foot">
                  <div class="lp-stat"><span class="lp-stat__l">每月喚回的訂單</span><span class="lp-stat__v"><i>0 張</i><em>→</em><b>12–18 張</b></span></div>
                  <div class="lp-stat"><span class="lp-stat__l">客人資料</span><span class="lp-stat__v"><i>憑印象</i><em>→</em><b>自動記錄</b></span></div>
                </div>
              </div>
            </div>
          </div>

          <!-- 這一區有具體數字與還沒上線的項目，圖說要交代：資料是示範、數據是估算、
               哪些還沒上線（「這是真介面」由卡片標頭的「系統實際畫面」meta 講）。
               兩個短句各佔一行——原本一大段四件事擠 80 字寬，老闆截圖抓過難讀。 -->
          <p class="lp-figcap lp-figcap--center">
            畫面中的客人與資料為示範；數據以 2,000 好友的示範店估算，非實際績效。<br>
            <b>「回購喚醒」與「生日與會員經營」仍在開發中</b>，其餘皆為現有功能。
          </p>

          <!-- ── 圖文選單：客人手機上的前後對照 ──
               「一句話代設」還沒上線 → 掛即將推出。
               ⛔ 草稿這裡畫的是一張五色平面 Banner，老闆看截圖說醜（跟原版 SCSS 早就寫下的
                  理由一樣：五色跟全頁沒關係，像貼了一張別人的圖）——沿用手機前後對照。
               ⚠️ 之後想放**真實截圖**（例如真的 LINE 選單畫面）：換掉右手機的 .lp-rm 即可，
                  但必須是真的介面截圖，不可以自己拼一張假的。 -->
          <div class="lp-panel">
            <div class="lp-panel__hd">
              <span class="lp-panel__pip" />
              <span class="lp-panel__title">圖文選單</span>
              <span class="lp-panel__meta">客人自己點，不用打字問</span>
              <span class="lp-soon">部分即將推出</span>
            </div>
            <div class="lp-panel__bd">
              <div class="lp-phones">
                <div class="lp-phonecol">
                  <span class="lp-phonetag lp-phonetag--off">沒有選單</span>
                  <div class="lp-phone">
                    <div class="lp-pscreen">
                      <div class="lp-pscreen__top"><span class="lp-pscreen__ava" />山丘咖啡</div>
                      <div class="lp-pchat">
                        <div class="lp-pmsg lp-pmsg--them">請問有賣禮盒嗎？</div>
                        <div class="lp-pmsg lp-pmsg--them">運費怎麼算？</div>
                        <div class="lp-pmsg lp-pmsg--them">今天有開嗎…？</div>
                      </div>
                      <div class="lp-pinput">輸入訊息</div>
                    </div>
                  </div>
                  <p class="lp-phonecap lp-phonecap--off">客人自己打字問，你一句一句回。</p>
                </div>
                <div class="lp-phonecol">
                  <span class="lp-phonetag lp-phonetag--on">有選單</span>
                  <div class="lp-phone">
                    <div class="lp-pscreen">
                      <div class="lp-pscreen__top"><span class="lp-pscreen__ava" />山丘咖啡</div>
                      <div class="lp-pchat lp-pchat--short">
                        <div class="lp-pmsg lp-pmsg--them">請問有賣禮盒嗎？</div>
                        <div class="lp-pmsg lp-pmsg--me">有的，{{ giftFestName }}禮盒已上架 ☕</div>
                      </div>
                      <div class="lp-rm">
                        <div class="lp-rm__r2">
                          <span class="lp-rm__c lp-rm__c--soft">本月精選</span>
                          <span class="lp-rm__c lp-rm__c--soft">會員專屬</span>
                        </div>
                        <div class="lp-rm__hero">
                          <span class="lp-rm__brand">禮盒專區</span>
                          <span class="lp-rm__go">立即選購 ▸</span>
                        </div>
                        <div class="lp-rm__r3">
                          <span class="lp-rm__c">商品資訊</span>
                          <span class="lp-rm__c">訂單問題</span>
                          <span class="lp-rm__c lp-rm__c--on">真人客服</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <p class="lp-phonecap lp-phonecap--on">常問的事變成按鈕，客人自己點。</p>
                </div>
              </div>
              <p class="lp-phones__note">過去要自己切版、自己設連結——之後跟 {{ brandName }} 講一句話就好。</p>
              <div class="lp-statrow">
                <div class="lp-stat"><span class="lp-stat__l">設定要花的時間</span><span class="lp-stat__v"><i>2 小時</i><em>→</em><b>一句話</b></span></div>
                <div class="lp-stat"><span class="lp-stat__l">客人要打字問的事</span><span class="lp-stat__v"><i>每一件</i><em>→</em><b>點按鈕就好</b></span></div>
              </div>
            </div>
          </div>
          <!-- 這張卡的示意與數據條講到還沒上線的「代設」，圖說要交代哪一半是現有的 -->
          <p class="lp-figcap lp-figcap--center">
            示意畫面。<b>選單現在就能在後台自己編排</b>；<br>
            「2 小時 → 一句話」的<b>一句話代設仍在開發中</b>。
          </p>
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
              <div class="lp-tl">
                <div class="lp-tl__track"><i /></div>
                <div class="lp-tl__steps">
                  <div class="lp-tl__step">
                    <span class="lp-tl__dot">1</span>
                    <b>登入 Email</b>
                    <small>收開通連結</small>
                  </div>
                  <div class="lp-tl__step">
                    <span class="lp-tl__dot">2</span>
                    <b>填寫基礎商家資訊</b>
                    <small>店名、行業、賣什麼</small>
                  </div>
                  <div class="lp-tl__step lp-tl__step--done">
                    <span class="lp-tl__dot lp-tl__dot--ok">✓</span>
                    <b>開始使用</b>
                    <small>60 秒</small>
                  </div>
                </div>
              </div>
              <p class="lp-tl__note">就像銀行開戶，只要身分證和手機號碼。</p>
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
      </div>
    </section>

    <!-- ── 價格 ────────────────────────────────────────────────
         大字報價，數字讀 plans.ts（單一事實來源），調價這裡自己跟上。
         方案卡目錄已隨 08-26 改版收掉（試銷期只主打 399，見 FEATURED_PLAN_IDS）；
         金流風控的五項揭露住在獨立頁 /product-info（見該頁檔頭），
         ⛔ 底下那條「完整商品資訊」連結是首頁通往揭露頁的路，不能拿掉。 -->
    <section id="pricing" class="lp-section">
      <div class="lp-wrap">
        <div class="lp-bigprice lp-reveal">
          <span class="lp-bigprice__lbl">一個月只要</span>
          <div class="lp-bigprice__num"><span class="lp-bigprice__cur">NT$</span>{{ fmt(lowestPaidPrice) }}</div>
          <span class="lp-bigprice__unit">／月 · 不綁約、隨時可取消</span>
        </div>

        <div class="lp-pricefeat lp-reveal">
          <div class="lp-pf">
            <span class="lp-pf__ico lp-pf__ico--brand"><BrandLogo mark on-color alt="" /></span>
            <b>友善的引導式設定</b>
            <small>一步一步帶你完成，部分步驟有 AI 協助標示——不用怕複雜。</small>
          </div>
          <div class="lp-pf">
            <span class="lp-pf__ico">✓</span>
            <b>別人有的，我們都有</b>
            <small>自動化訊息、腳本、AI 客服、AI 行銷建議、報表。</small>
          </div>
          <div class="lp-pf">
            <span class="lp-pf__ico">✓</span>
            <b>60 秒就能開始</b>
            <small>Email 登入、商家基礎資訊設定，今天就能讓它上工。</small>
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
                  <path
                    class="lp-chart__base"
                    d="M60 265 C110 264,160 263,210 263 C260 262,310 261,360 260 C410 259,460 258,510 258 C560 257,610 256,660 256"
                  />
                  <path
                    class="lp-chart__me"
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
        <div class="lp-reveal">
          <span class="lp-eyebrow lp-eyebrow--plain">常見問題</span>
          <h2 class="lp-h2">你可能會想問</h2>
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
                <div class="a">LINE 官方帳號（OA）,貼一組 Webhook 網址即可接通。</div>
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
        <span class="lp-stickybar__t1">一個月只要 <em>NT${{ fmt(lowestPaidPrice) }}</em>，多半個客服＋半個行銷</span>
        <span class="lp-stickybar__t2">60 秒完成設定 · 不綁約、隨時可取消</span>
        <NuxtLink class="lp-btn lp-btn--primary lp-btn--sm" to="/login" :tabindex="barShown ? undefined : -1">免費打造</NuxtLink>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
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

/**
 * 圖文選單示意裡那句「{節日}禮盒已上架」用的節日：接下來第一個**送禮檔期**。
 * 為什麼挑送禮檔期而不是單純的下一個節日：那句話講的是禮盒，套到中元節、國慶日會語意不通。
 * 為什麼不寫死：寫死的節日會過期（草稿寫「父親節」，做頁面的當天就已經過完了）。
 */
const giftFestName = computed(() =>
  upcoming.value.find(x => /送禮|禮盒|伴手禮|禮物|紅包/.test(x.angle))?.name ?? '節慶',
)

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
    const els = root.value?.querySelectorAll<HTMLElement>('.lp-reveal') ?? []
    io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('in')
          io?.unobserve(e.target)
        }
      })
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' })
    els.forEach(el => io?.observe(el))
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll)
  io?.disconnect()
  barIo?.disconnect()
  document.documentElement.style.scrollBehavior = ''
})
</script>
