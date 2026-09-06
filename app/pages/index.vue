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
            目前順序：Hero(白) why(灰) value(白) 證言牆(灰) fast(白) pricing(灰) grow(白)
            faq(灰) 收尾CTA(綠)。新增或搬動區塊要跟著調。
            （2026-09-06 老闆回饋證言牆上移到 60 秒區之前，後半四區的灰白因此整組翻面。）
         ⚠️ 2026-08-26 三處版面重排（老闆「排版只是參考，用資深 UIUX 重新想」）：
            ①「四關」與「解法」併成一區——原本兩個整屏區塊講同一件事，解法列還把
              四個問題重抄一遍；現在每張牆卡自帶解法（問題上、✓解法下），省一屏、對仗更強。
            ②「能做什麼」先人後介面——AI 客服/AI 行銷（有真截圖）先出，圖文選單卡在後；
              賣點是「多了全年無休的客服與行銷」（09-06 前是「多半個客服半個行銷」），
              選單是佐證不是主張。
              （2026-09-03 十七輪這一區的**切法**再改一次：左右對半切 → 左軌釘住＋
               右欄畫面一扇扇捲過，順序沒變，why 見該區註解。）
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
         右邊是機會卡：節慶檔期＋四種客人名單，一張攤平的清單。
         ⚠️ 2026-09-06 老闆回饋「右圖無法理解」「節慶／該關心的客人／已分好的客群這些
            分組標題對小白難懂」→ 三個分組標頭整組拆掉，每一列自己是一句人話（誰＋幾位），
            卡片標題補上「賺錢」點明這張卡在講機會。⛔別把分組標頭加回來。
         節慶那兩列吃 shared/taiwan-festivals.ts 的真資料（系統本來就會在節前提醒老闆）。
         ⚠️ 誠實機制（2026-08-26 老闆拍板拿掉圖說後的替代方案，⛔別拆）：
           1. 卡片標頭右側掛「以咖啡店為例」＝整張卡明示是舉例，人數才可以出現；
              拿掉這個標示、又不掛圖說，虛構人數就是被當成真實客戶資料在賣。
              ⚠️ 用「舉例」而不是店名：一句「示範店 · 山丘咖啡」除了沒人懂「示範店」，
                 還可能被讀成「山丘咖啡是他們的客戶」——那比沒標示更糟（假造客戶案例）。
                 「以咖啡店為例」順便解釋了卡裡為什麼都是咖啡展、手沖這些內容。
           2. 卡上每一列都必須是**現在真的做得到**的事（節慶提醒、加入時間名單、
              60 天沒互動自動標籤、標籤分眾都是真功能）——之前「還沒說過第一句話」
              是開發中的偵測，已改掉。⛔要再放開發中的能力，免責圖說就得加回來。
           3. 印章那句話只寫到「你不用自己**盯**」＝這些名單與檔期是系統自己在看的（真的）。
              ⛔別升級成「它會自動幫你發」——自動喚醒／生日祝福那類主動發送 08-27 老闆拍板
              「先不要出現」，寫了就是賣還沒有的功能。 -->
    <header id="top" class="lp-hero">
      <span class="lp-hero__blob lp-hero__blob--1" />
      <span class="lp-hero__blob lp-hero__blob--2" />
      <div class="lp-wrap lp-hero__grid">
        <div class="lp-hero__text">
          <!-- 09-06 老闆「換一個 slogan」：從類別標籤（LINE 專用 · AI 客服與顧客經營）
               改成利益句，跟 h1「你的顧客很值錢」接成同一個故事。 -->
          <span class="lp-eyebrow">把 LINE 好友，變成回頭客</span>
          <h1>你的顧客，<br>其實很<span class="g">值錢</span>。</h1>
          <!-- 兩句各佔一行（手機收掉 br 自然流）：擠在同一段時斷行位置會把詞拆開 -->
          <p class="lp-hero__sub">
            品牌的 LINE 官方帳號有好多好友，<br>
            <b>卻不知道如何經營他們嗎？</b>
          </p>
          <!-- 解答句：敘事閉環的第三拍（值錢→沒空經營→它是你的分身→免費打造）。
               09-06 改寫：老闆回饋原句「替你經營他們的 AI 分身」還沒改到（歧義：會被讀成
               「經營『他們的分身』」），且老闆點名喜歡收尾那句「讓一個你變成很多個你」、
               說可以拉上來當副標——改成「是你的分身＋讓一個你變成很多個你」兩拍。
               收尾 CTA 刻意保留同一句＝首尾呼應。⛔說明仍不多扛：往下捲整頁都在講。 -->
          <p class="lp-hero__answer"><b>{{ brandName }}</b> 是你的 AI 分身——<br>從今天開始，讓一個你，變成很多個你。</p>
          <div class="lp-hero__actions">
            <NuxtLink class="lp-btn lp-btn--primary" to="/login">免費打造我的 {{ brandName }}</NuxtLink>
          </div>
          <p class="lp-hero__fine">
            <b>60 秒</b>開好帳號 · 免費方案不用綁卡 · 付費每月 <b>NT${{ fmt(lowestPaidPrice) }} 起</b>
          </p>
        </div>

        <div class="lp-hero__visual">
          <div class="lp-panel lp-ops">
            <div class="lp-panel__hd">
              <span class="lp-panel__pip" />
              <span class="lp-panel__title">你的好友裡，藏著賺錢的機會</span>
              <!-- 「以咖啡店為例」是人數能出現的前提（見區塊註解）：⛔別換回好友數（那會變成
                   拿虛構數字當真實客戶資料），也⛔別寫成店名（「示範店 · 山丘咖啡」被老闆抓過
                   ——訪客不懂「示範店」，還可能讀成「山丘咖啡是他們的客戶」＝假造客戶案例）。 -->
              <span class="lp-panel__meta">以咖啡店為例</span>
            </div>

            <!-- 一張攤平的清單（09-06 拆分組，見區塊註解）：每列＝誰／什麼時候＋幾位。
                 ⛔ 每一列都必須是**現在真的做得到**的事：節慶提醒、加入時間名單、
                    60 天沒互動自動標籤、標籤分眾——列的字可以白話，能力不可以虛構。 -->
            <div class="lp-ops__group">
              <div v-for="f in heroFests" :key="f.id" class="lp-op">
                <b>{{ f.name }} {{ f.md }}</b>
                <span class="lp-op__tag" :class="{ 'lp-op__tag--soon': f.soon }">{{ f.badge }}</span>
              </div>
              <div class="lp-op">
                <b>這週剛加入的新朋友</b>
                <span class="lp-op__tag lp-op__tag--num">38 位</span>
              </div>
              <div class="lp-op">
                <b>超過 60 天沒聯絡的客人</b>
                <span class="lp-op__tag lp-op__tag--num">142 位</span>
              </div>
              <div class="lp-op">
                <b>在咖啡展認識的客人</b>
                <span class="lp-op__tag lp-op__tag--num">216 位</span>
              </div>
              <div class="lp-op">
                <b>愛手沖的熟客</b>
                <span class="lp-op__tag lp-op__tag--num">184 位</span>
              </div>
            </div>

            <!-- 印章：接住上面整張清單的那句話（2026-09-02 老闆要的「蓋個印章說你不用管這些」）。
                 同日改過兩輪位置：①排在名單與按鈕之間、誰都不壓 → ②「可以直接蓋在這些東西上面嗎」
                 → ③「可以放在這張卡片的中央且大一點嗎」＝現在這版（絕對定位、對整張卡上下左右居中）。
                 ⚠️ 它是**每一列的建議句被拿掉之後的替代品**：原本每列尾巴都掛一句「可以送上一句
                    歡迎」這類建議＝同一件事在卡裡講了六次，卡片右半邊全是小字（老闆：「有點多文字」）。
                    現在每列只回答「看到什麼、幾位」，「那我要做什麼」由這一顆印章統一回答。
                 ⚠️ 它在 DOM 裡擺在名單後面、CTA 前面＝**讀螢幕的人聽到的順序**（先聽完機會再聽這句
                    結論），位置純粹靠 CSS。⛔ 別為了「視覺在中間」把它搬到名單前面。
                 ⛔ 別把建議句加回去；印章可以蓋住名稱，但**不可以蓋到人數**（那是這張卡的賣點）
                    ——多大、各寬度怎麼縮、為什麼不能用 @media，寫在 _landing.scss 的 .lp-stamp 那段。 -->
            <span class="lp-stamp">
              <small>這些你都不用自己盯</small>
              <b>交給 {{ brandName }} 就好</b>
            </span>

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
            <!-- 09-06 老闆給的改寫原文照用（原「這件事，老闆一直卡在這四關」被回饋難懂）。 -->
            <h2>你知道 LINE 會員經營、客服溝通<br>有多重要，但你總是<span class="mark">卡在這四關</span>。</h2>
            <p>還好，每一關都有 {{ brandName }} 能接住的解法——</p>
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
            <p class="lp-wall__fix"><span aria-hidden="true">✓</span>一個月 NT${{ fmt(lowestPaidPrice) }} 起</p>
          </div>
        </div>
      </div>
    </section>

    <!-- ── 能做什麼：全年無休的客服＋行銷（09-06 前叫「半個客服＋半個行銷」）──────
         ⚠️ id 沿用 #value：頁尾與法務頁的「產品介紹」都指這裡，換 id 會變死連結。
         ⚠️ 順序＝AI 客服/AI 行銷（真截圖）先、圖文選單卡後（08-26 版面重排②）：
            區塊主張是「多了全年無休的客服與行銷」，那兩張卡才是主張本體。 -->
    <section id="value" class="lp-section">
      <div class="lp-wrap">
        <div class="lp-turn lp-reveal">
          <span class="lp-turn__ava"><BrandLogo mark on-color alt="" /></span>
          <div class="lp-bubble">
            <!-- 09-06 老闆改寫主標（原「多一個 MiniMe＝半個客服、半個行銷」）：他給的長句
                 拆兩段裝——h2 收成「全年無休」，小字收他列的請假／鬧脾氣／休息／24 小時。
                 ⚠️ 黏性行動條（頁尾）跟這裡同口徑，改一邊要一起改。 -->
            <h2>多了一個 <span class="lp-nb"><BrandLogo class="lp-bubble__logo" :alt="brandName" />，</span><br>等於多了<span class="mark">全年無休</span>的客服與行銷。</h2>
            <p>永遠不會請假、不會鬧脾氣、不用休息——24 小時都在。</p>
          </div>
        </div>

        <!-- ⚠️ 進場動畫掛在**裡面每一塊**，不是掛在這層 .lp-stack：這一疊手機上有 2,126px 高，
             整疊當一個單位的話，捲到最上緣時底下 1,500px 的圖文選單窄帶就已經「進場」過了，
             真的捲到它時反而什麼都不會發生（而且元素越高，比例式的門檻越容易永遠達不到）。 -->
        <div class="lp-stack">
          <!-- ⚠️ 2026-09-03 十七輪：從「一列一個能力、左右交錯」（.lp-duo）改成
               **左邊一條釘住的軌、右邊畫面一扇扇捲過去**（使用者：「有沒有機會重新思考排版、
               打破目前的框架」，給了三個方向後選的是這個）。
               舊框架的病不在細節在切法：三列全是「文字半欄／畫面半欄」的左右對半切，
               而文字欄實測只有 ~300px 內容，卻要跟 600px 高的視窗並排垂直置中——
               上下各留 150px 的空，同一種空法連做三次。
               新框架：軌只負責「你現在看到哪一塊」，右欄一塊一塊往下＝標頭（標題＋兩個能力）
               → 滿欄的「系統實際畫面」→ 成效帶（＝視窗的圖說：說明→證據→成效）。
               內容一件都沒換，只是重新組合；視窗順勢從 560px 放大到滿欄 816px。
               ⚠️ 軌是指示器不是「三個並列的能力」：圖文選單在版面上仍然是小一號的窄帶
                  （08-27 拍板「它是手段不是第三個能力」）。
               ⛔ 軌 ≤960px 整條不顯示——所以每一塊的標題與說明一定要留在右欄的
                  .lp-pane__hd 裡，⛔別為了讓軌「有料」把它們搬進去，手機會整個看不到。
               ⛔ sticky 要活著，.lp 那層必須是 overflow-x: clip（hidden 會讓整個 .lp 變成
                  捲動容器＝連導覽列的 sticky 都是死的，十七輪實測抓到，見 _landing.scss 檔頭）。 -->
          <div class="lp-rails">
            <!-- 軌：aria-hidden＝它逐字重複右欄的標題，讀屏聽第二次沒有意義。
                 沒有 JS／SSR 時 activeCap 是 0＝第一條亮著，讀起來就是「從這裡開始」。 -->
            <!-- ⚠️ 視覺改過三輪，現行是二十輪：
                 ①十八輪的「軌線＋圓點＋綠色進度」被反映「生硬」＝那是流程精靈的語彙，
                   十九輪整組拿掉，改成全圓角軟底（⛔別加回來，見 _landing.scss）。
                 ②二十輪三件事：**每一條變成可以點的連結**（點了捲到那一塊）、
                   字級與內距放大一級、欄寬從 232px 拉到 350px＝軌與畫面欄約 **1:2**。
                 ⚠️ 因為現在有可聚焦的連結，⛔**不可以再掛 aria-hidden**（讀屏使用者
                    會 Tab 到一個「不存在」的東西）。改成有名字的 nav；標題被唸兩次
                    （一次是連結、一次是右邊的 h3）是頁內導覽的正常樣子。
                 ⚠️ href 指的是每一塊的 id（cap-*），⛔改 id 要兩邊一起改，
                    而且 .lp-pane 要有 scroll-margin-top，否則捲過去標題會被釘住的導覽列蓋掉。 -->
            <!-- ⚠️ 09-06 老闆拍板「自動貼標要獨立成一個重點」→ 軌上從三條變**四條**：
                 客服 → 行銷 → 貼標 → 選單。查證過自動貼標站得住：每顆標籤有三種模式
                 （off／建議進收件匣／**auto＝AI 判到直接貼**，來源記 ai、可撤），加上
                 活動來源與 60 天沒互動兩種本來就全自動。⛔文案別寫成「全部全自動」，
                 「判到直接貼，或先擬好等你按」才是實況。
                 行銷那條的 small 同輪換成老闆要的推播句（微調過：「馬上**就能**推播」，
                 主詞留在店家——「就馬上推播」會被讀成系統自動發＝08-27 拍板撤下的能力）。 -->
            <nav class="lp-rails__rail lp-reveal" aria-labelledby="lp-rail-lead">
              <p id="lp-rail-lead" class="lp-rail__lead">它在幫你做的事</p>
              <ol class="lp-rail__nav">
                <li>
                  <a class="lp-rail__item" :class="{ 'is-on': activeCap === 0 }" href="#cap-service">
                    <b>AI 客服</b><small>有人問，馬上有人回</small>
                  </a>
                </li>
                <li>
                  <a class="lp-rail__item" :class="{ 'is-on': activeCap === 1 }" href="#cap-marketing">
                    <b>AI 行銷</b><small>節慶到了馬上就能推播</small>
                  </a>
                </li>
                <li>
                  <a class="lp-rail__item" :class="{ 'is-on': activeCap === 2 }" href="#cap-tagging">
                    <b>自動貼標</b><small>誰買過什麼，它幫你記</small>
                  </a>
                </li>
                <li>
                  <a class="lp-rail__item" :class="{ 'is-on': activeCap === 3 }" href="#cap-richmenu">
                    <b>常問的事變成按鈕</b><small>客人自己點，你少回一輪</small>
                  </a>
                </li>
              </ol>
            </nav>

            <!-- ⚠️ 進場動畫掛在標頭／視窗／成效帶**各一個**、不是掛在 .lp-pane 這層：
                 一塊有 780px 高，整塊當一個單位的話，捲到標頭上緣時底下那扇 600px 的
                 視窗就已經淡完了（同上面那條房規；09-03 使用者反映「還沒滑到就觸發完」）。
                 ⚠️ .lp-pane 同時是左軌的觀察對象（index.vue script 的 capIo）——
                 四塊的順序就是軌上四條的順序（09-06 自動貼標升格後從三變四），
                 加減塊要兩邊一起改。 -->
            <div class="lp-rails__flow">
              <article id="cap-service" class="lp-pane">
                <div class="lp-pane__hd lp-reveal">
                  <h3>AI 客服</h3>
                  <div class="lp-pane__apps">
                    <!-- ⚠️ 特點列 09-03 二輪從「✓＋髮絲線清單」改成圖示列（反映「有點亂」＋「特點整理成圖示」）：
                         一列一個綠底圖示當視覺錨點，列與列之間不再畫線——線是上一版「亂」的來源之一
                         （清單髮絲線＋數據磚灰底兩種分隔語彙疊在同一欄）。⛔ UI 圖示不用 emoji（檔頭規矩），
                         一律 inline SVG 線條圖、吃 currentColor。
                         ⚠️ 十七輪起兩列**並排**（.lp-pane__apps 兩欄）：欄寬從半欄變滿欄 816px 之後，
                         一列一個會變成「一句話配一大片空白」。手機收回單欄。 -->
                    <div class="lp-app">
                      <span class="lp-app__i" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 7v10l8 4 8-4V7l-8-4z" /><path d="M4 7l8 4 8-4M12 11v9" /></svg></span>
                      <div><b>產品基本 QA</b><small>規格、成分、怎麼用、怎麼挑</small></div>
                    </div>
                    <div class="lp-app">
                      <span class="lp-app__i" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.6a7.6 7.6 0 0 1-7.6 7.6H4.2l1.5-3A7.6 7.6 0 1 1 21 11.6z" /><path d="M10.7 9.8a1.9 1.9 0 1 1 2.6 1.8c-.8.3-1.1.9-1.1 1.6" /><circle cx="12.2" cy="15.9" r=".9" fill="currentColor" stroke="none" /></svg></span>
                      <div><b>常見問題 QA</b><small>運費、出貨、退換、營業時間</small></div>
                    </div>
                  </div>
                </div>
                <!-- ⚠️ 「系統實際畫面」＝**用後台真正的樣式現場渲染**（2026-09-03 五輪方向，
                     取代 PNG 截圖：截圖縮放後字是點陣的、拖曳/反白會露餡成「一張照片」）。
                     做法＝掛後台對話頁同一套 class（.conversations-page 作用域，樣式源頭
                     _conversations.scss）——後台改「樣式」這裡自動跟上；改「結構」（class 換名/
                     巢狀變）不會，那時這裡要跟著搬。
                     ⛔ 內容不是自由發揮：對話的字句/時間/誰回的，必須跟
                     scripts/landing-demo-seed.ts 的 MSGS 逐字一致（08-26「截我們自己系統的圖」
                     用的同一份示範資料，這條規矩的精神＝畫面上的東西系統真的長這樣）。
                     改對話請兩邊一起改。舊 PNG 產線（landing-shots.mjs）與圖檔保留沒刪，
                     回退 PNG 版看 git log。
                     ⚠️ 對話窗刻意**不掛 inert 也不掛 role="img"**（09-03 六輪）：泡泡文字要
                     選得到反白——那是「這不是圖片」最直接的證明；內容讓讀屏照實唸。
                     裡面沒有可聚焦元素，開著互動是安全的。 -->
                <div class="lp-panel lp-pane__win lp-reveal">
                  <!-- 視窗欄長成「應用程式視窗」：左三顆窗鈕（中性灰，⛔別上紅黃綠——全頁唯一
                       非綠的彩色保留給時機卡的琥珀）、右邊掛「系統實際畫面」標籤。
                       09-03 三輪加的：純綠點＋標題那版被反映「看起來還是圖片」。 -->
                  <div class="lp-panel__hd">
                    <span class="lp-win__dot" aria-hidden="true" /><span class="lp-win__dot" aria-hidden="true" /><span class="lp-win__dot" aria-hidden="true" />
                    <span class="lp-panel__title lp-win__label">系統實際畫面</span>
                  </div>
                  <!-- ⚠️ 2026-09-03 十八輪把硬寫的泡泡改成 v-for（資料在 script 的 LP_CHAT）：
                       ①「一句一句到」的錯開延遲需要每顆泡泡有自己的序號（`--d`），
                         硬寫 HTML 要靠 nth-child 數，而泡泡分在兩個 .conv-day-group 裡、序號會重來
                       ②「內容必須跟 landing-demo-seed.ts 的 MSGS 逐字一致」這條規矩，
                         對著一份資料陣列比對比對著 40 行 HTML 好核。
                       ⛔ class 名一個都沒換（還是後台 _conversations.scss 那套），
                          後台改「結構」時這裡照樣要跟著搬。 -->
                  <div class="conversations-page lp-livewin lp-livewin--chat lp-cue">
                    <div class="conv-messages">
                      <div v-for="g in LP_CHAT" :key="g.day" class="conv-day-group">
                        <div class="conv-day-divider" :style="{ '--d': g.d }"><span class="conv-day-divider__label">{{ g.day }}</span></div>
                        <div v-for="m in g.msgs" :key="m.i" class="conv-bubble-row" :class="m.side" :style="{ '--d': m.i }">
                          <div class="conv-bubble-wrap" :class="m.side">
                            <div class="conv-bubble" :class="m.side"><div class="conv-bubble-text"><div>{{ m.text }}</div></div></div>
                            <div class="conv-bubble-meta">
                              <span class="conv-bubble-meta__line">
                                <span v-if="m.who" class="conv-sender-tag" :class="{ 'conv-sender-tag--human': m.human }">{{ m.who }}</span>
                                <span class="conv-bubble-time">{{ m.time }}</span>
                              </span>
                              <span v-if="m.read" class="conv-bubble-read">已讀</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <!-- 09-03 三輪：兩顆分離的灰磚（被反映像表單欄位）併成一條成效帶——
                     一個容器兩格、中間髮絲線分隔，欄位樣式（舊值刪除線→新值綠字）不變。
                     ⚠️ 十七輪從「文字欄的收尾」搬到**視窗正下方**：它現在是這扇窗的圖說，
                     整塊讀起來就是 說明（標頭）→ 證據（視窗）→ 成效（這一條）。 -->
                <div class="lp-outcome lp-reveal">
                  <div class="lp-outcome__cell"><span class="lp-outcome__l">客人等回覆</span><span class="lp-outcome__v"><i>4 小時</i><em>→</em><b>秒回</b></span></div>
                  <div class="lp-outcome__cell"><span class="lp-outcome__l">訊息回覆率</span><span class="lp-outcome__v"><i>6 成</i><em>→</em><b>全部回覆</b></span></div>
                </div>
              </article>

              <article id="cap-marketing" class="lp-pane">
                <div class="lp-pane__hd lp-reveal">
                  <h3>AI 行銷</h3>
                  <div class="lp-pane__apps">
                    <!-- 09-06：第一條的 small 換成老闆要的推播句（「就能」兩字是紅線微調，
                         見上面軌的註解）；第二條原「客戶貼標分眾」升格成自己的一塊（#cap-tagging），
                         這裡改講推播怎麼用那些標籤。 -->
                    <div class="lp-app">
                      <span class="lp-app__i" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M3.5 9.5h17M8 3v3.5M16 3v3.5" /><circle cx="12" cy="14.8" r="1.6" fill="currentColor" stroke="none" /></svg></span>
                      <div><b>節慶檔期提案</b><small>節慶到了馬上就能推播，分眾都幫你選好</small></div>
                    </div>
                    <div class="lp-app">
                      <span class="lp-app__i" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 3.5 10.4 14.1" /><path d="M21 3.5l-6.8 17-3.8-6.4-6.9-3.4z" /></svg></span>
                      <div><b>分眾推播</b><small>用標籤挑人發，不亂槍打鳥</small></div>
                    </div>
                  </div>
                </div>
                <!-- ⚠️ 「系統實際畫面」＝用後台「推播」頁真正的樣式現場渲染（09-06 自動貼標
                     升格成自己的一塊後，好友名單窗搬去 #cap-tagging，這扇換成推播的證據）。
                     兩個真元素：①節慶提醒（.bc-festival-hint）＝ broadcasts.vue 真的有的
                     常駐提醒，文案吃同一支 festivalReminderText（見 script 的 lpBcHint 註解，
                     ⛔別手寫節慶句子，會過期）②推播列＝後台同一顆 AdminSplitListItem 元件
                     （樣式 layout/_split-layout.scss），狀態章「草稿／已完成」與 meta 格式
                     照 broadcasts.vue 的 statusLabel／bcMetaText（草稿沒排程時間＝meta 只有人數）。
                     ⛔ 列標題刻意「客群・主題」且**不含日期與節日名**：草稿第一列演的就是
                     「擬好等你發」，而不寫死日期/節名＝這扇窗不會過期（richmenu 圖的教訓）。
                     人數跟 Hero 機會卡對齊（手沖 184、咖啡展 216），示範資料、無真實客資。
                     ⛔ 不掛 inert／role="img"（同兩扇舊窗的房規）：列滑過會亮、字選得到。 -->
                <div class="lp-panel lp-pane__win lp-reveal">
                  <div class="lp-panel__hd">
                    <span class="lp-win__dot" aria-hidden="true" /><span class="lp-win__dot" aria-hidden="true" /><span class="lp-win__dot" aria-hidden="true" />
                    <span class="lp-panel__title lp-win__label">系統實際畫面</span>
                  </div>
                  <div class="lp-livewin lp-livewin--bc">
                    <p v-if="lpBcHint" class="bc-festival-hint">🎉 {{ lpBcHint }}</p>
                    <div class="split-list">
                      <AdminSplitListItem
                        v-for="r in LP_BC_ROWS"
                        :key="r.title"
                        :title="r.title"
                        time-in-title-row
                        title-row-chip
                        :chip-text="r.chip"
                        :chip-tone="r.tone"
                        :meta-text="r.meta"
                      />
                    </div>
                  </div>
                </div>
                <div class="lp-outcome lp-reveal">
                  <!-- ⛔ 這兩格只能放**現有功能**的成效：原本第一格是「每月喚回的訂單 0→12–18 張」，
                       那是「回購喚醒」的成效，而該功能 2026-08-27 已從卡上撤掉（還沒上線）——
                       功能不出現、它的數字更不能留，否則是宣稱一個連清單上都沒有的能力。 -->
                  <div class="lp-outcome__cell"><span class="lp-outcome__l">節慶檔期</span><span class="lp-outcome__v"><i>自己記日子</i><em>→</em><b>系統先提醒</b></span></div>
                  <div class="lp-outcome__cell"><span class="lp-outcome__l">推播對象</span><span class="lp-outcome__v"><i>整包亂發</i><em>→</em><b>發給對的人</b></span></div>
                </div>
              </article>

              <!-- ── 自動貼標（09-06 老闆拍板從 AI 行銷的一條小項**升格成自己的一塊**）──
                   查證過的實況（⛔文案不可超出）：①活動來源標籤＝掃碼/登記自動貼 ②60 天沒
                   互動自動標 ③AI 讀完對話貼標＝每顆標籤自選模式（建議進收件匣等人採用，
                   或 auto＝判到直接貼、來源記 ai、可撤）。所以「自動」站得住，但第二條 app
                   的 small 要保留「或先擬好等你按」那一半，別寫成全部全自動。 -->
              <article id="cap-tagging" class="lp-pane">
                <div class="lp-pane__hd lp-reveal">
                  <h3>自動貼標</h3>
                  <div class="lp-pane__apps">
                    <div class="lp-app">
                      <span class="lp-app__i" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 11V4.5a1 1 0 0 1 1-1H11l9 9-6.9 6.9a1.4 1.4 0 0 1-2 0L3.5 11z" /><circle cx="7.6" cy="7.6" r="1.3" fill="currentColor" stroke="none" /></svg></span>
                      <div><b>來了就自動記</b><small>從哪個活動加入、多久沒互動</small></div>
                    </div>
                    <div class="lp-app">
                      <span class="lp-app__i" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.6a7.6 7.6 0 0 1-7.6 7.6H4.2l1.5-3A7.6 7.6 0 1 1 21 11.6z" /><path d="M12 7.6l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z" fill="currentColor" stroke="none" /></svg></span>
                      <div><b>AI 看完對話也會貼</b><small>可以直接貼，或先擬好等你按</small></div>
                    </div>
                  </div>
                </div>
                <!-- ⚠️ 「系統實際畫面」＝用後台「好友」頁真正的樣式現場渲染（同上一扇窗的做法與
                     規矩，樣式源頭 _users.scss ＋共用 _tables.scss/_tags.scss）。
                     ⛔ 名單/標籤/順序必須跟 scripts/landing-demo-seed.ts 的 USERS/TAGS 一致
                     （列序＝加入時間新到舊＝u12→u1，跟後台排序一樣）；只渲染 勾選/好友/標籤
                     三欄＝沿用舊 PNG「只裁到標籤欄右緣」的裁法。示範資料、無真實客資。
                     ⚠️ 只渲染前 **6** 列（二十一輪從 8 列再剪兩列＝「內容少一點」那一輪；
                     6 列已經看得到單標籤、雙標籤與各種標籤色，再多只是重複）、
                     收在**完整列**的邊界（09-03 六輪：五輪用 max-height
                     把列切一半，看起來就是裁過的圖——要少列就少渲染，別裁）。舊註解留參考：
                     12 列全高會比左欄高一截，五輪曾用容器上限裁底（≒更早 --fill 裁底的
                     視覺，08-27 老闆看過的樣子）。頭像圈裡的人形是 inline SVG，不是後台的
                     el-icon（⛔別為了這顆圖示把 Element Plus 拉進官網 bundle）。 -->
                <!-- ⚠️ 這扇窗也**不掛 inert／role="img"**（09-03 七輪）：六輪只把聊天窗的互動
                     打開、這扇忘了跟上——inert 讓它選不了字、滑過沒 hover、checkbox 點不動，
                     行為上就是一張圖片，被當場抓到「這張還是一樣」。現在滑過列會亮、名字
                     選得到、checkbox 點得動（勾了不影響任何東西，反而是「真介面」的證明）。
                     checkbox 掛 tabindex="-1"＋aria-hidden：滑鼠玩得到，但不進 Tab 順序、
                     讀屏不唸（對讀屏它是裝飾，名單與標籤才是內容）。 -->
                <div class="lp-panel lp-pane__win lp-reveal">
                  <div class="lp-panel__hd">
                    <span class="lp-win__dot" aria-hidden="true" /><span class="lp-win__dot" aria-hidden="true" /><span class="lp-win__dot" aria-hidden="true" />
                    <span class="lp-panel__title lp-win__label">系統實際畫面</span>
                  </div>
                  <!-- lp-cue：捲到眼前才演「名單一列一列進來、標籤跟著貼上去」
                       （十八輪；⛔別把它掛到外層 .lp-pane__win 以外的高容器，見房規） -->
                  <div class="lp-livewin lp-livewin--users lp-cue">
                    <table class="users-table">
                      <thead>
                        <tr>
                          <th class="users-table__th--check"><input type="checkbox" tabindex="-1" aria-hidden="true"></th>
                          <th>好友</th>
                          <th class="users-table__th--tags">標籤</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="(friend, fi) in landingDemoFriends.slice(0, 6)" :key="friend.name" :style="{ '--d': fi }">
                          <td><input type="checkbox" tabindex="-1" aria-hidden="true"></td>
                          <td>
                            <div class="user-identity">
                              <span class="user-avatar-placeholder"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="3.6" /><path d="M5 20a7 7 0 0 1 14 0" /></svg></span>
                              <span class="user-name">{{ friend.name }}</span>
                            </div>
                          </td>
                          <td>
                            <div class="user-tags-cell">
                              <span
                                v-for="tag in friend.tags"
                                :key="tag.name"
                                class="tag-chip tag-chip--tinted"
                                :style="{ '--tag-accent': tag.color }"
                              >{{ tag.name }}</span>
                            </div>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
                <div class="lp-outcome lp-reveal">
                  <div class="lp-outcome__cell"><span class="lp-outcome__l">客人資料</span><span class="lp-outcome__v"><i>憑印象</i><em>→</em><b>自動記錄</b></span></div>
                  <div class="lp-outcome__cell"><span class="lp-outcome__l">分眾名單</span><span class="lp-outcome__v"><i>自己整理</i><em>→</em><b>自動長好</b></span></div>
                </div>
              </article>

              <!-- 圖說只交代「資料是示範、數據是估算」——2026-08-27 起兩張卡上**只有現有功能**
                   （回購喚醒／生日經營已撤下），所以不再需要「哪些還沒上線」那半句；
                   「這是真介面」由卡片標頭的「系統實際畫面」meta 講。 -->
              <p class="lp-figcap lp-figcap--center lp-reveal">
                畫面中的客人與資料為示範；數據以一家 2,000 位好友的店估算，非實際績效。
              </p>

              <!-- ── 圖文選單：一條窄帶（2026-08-27 老闆拍板從 791px 的大卡降級）──
                   它是「讓客服更省力」的手段，不是第三個能力，所以不給它跟兩張主卡同等的版面。
                   ⚠️ 資訊層次刻意分三層：標題＝客人得到什麼／一句話＝為什麼省事／
                      底下兩列＝**現在做得到 vs 還沒上線**（代設的徽章就標在那個詞旁邊，
                      不用卡頂那種籠統的「部分即將推出」）。09-03 五輪把第三層從一段散文
                      改成跟上面兩列同語言的圖示列（回饋「排版是否也能優化」——左欄字少
                      盒子空，圖示列把留白撐起來也讓整區語彙一致）；⛔文案沿用原句，
                      只收掉「想更省事，」這個連接詞。
                   ⛔ 只留「有選單」那一支手機：原本兩支做前後對照，但「沒有選單」那支只是在
                      演示問題、佔掉一半版面，說服力全在「有選單」這支。
                   ⚠️ 十七輪起它也掛 .lp-pane＝左軌第三條的觀察對象（順序＝軌上的順序）。
                      它**維持**兩欄的窄帶（不跟上面兩塊一樣上下堆疊）：軌上多一條不改變
                      「它是手段不是第三個能力」的版面權重，這條小一號的帶子就是那個權重。
                   ⚠️ 十九輪拆成兩塊（使用者「把手機拉到色塊外面放左邊，右邊維持色塊跟資訊，
                      兩者等高」）：外層 .lp-band 不再是卡片、只是兩欄的架子——**手機在左、
                      沒有底色**，色塊只包右邊的文字（.lp-band__text）。⚠️ DOM 順序沒動
                      （文字仍在前、手機用 grid-column 排到左邊），讀屏與手機單欄維持
                      「先講什麼、再看畫面」。 -->
              <div id="cap-richmenu" class="lp-band lp-pane lp-reveal">
                <div class="lp-band__text">
                  <h3>常問的事變成按鈕，客人自己點</h3>
                  <p>客人一打開你的 LINE 就看到選單——不必打字問，你也少回一輪。</p>
                  <div class="lp-app">
                    <span class="lp-app__i" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4.5" width="16" height="15" rx="2.5" /><path d="M4 11h16M12 11v8.5" /></svg></span>
                    <div><b>選單現在就能在後台自己編排</b></div>
                  </div>
                  <div class="lp-app">
                    <span class="lp-app__i" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11.4a7.4 7.4 0 0 1-7.4 7.4H4.4l1.4-2.9A7.4 7.4 0 1 1 20 11.4z" /><path d="M12 7.9l.95 2.15L15.1 11l-2.15.95L12 14.1l-.95-2.15L8.9 11l2.15-.95L12 7.9z" fill="currentColor" stroke="none" /></svg></span>
                    <div><b>之後可以一句話請 {{ brandName }} 代設<span class="lp-soon lp-soon--inline">即將推出</span></b></div>
                  </div>
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
                <!-- 手機自己也是一個進場單位：手機版這支排在文字**下面** 400px 處，
                     跟著整條窄帶一起淡的話，捲到它時早就淡完了。
                     ⚠️ 十八輪多掛一個 lp-cue：淡入之後再演「歡迎訊息進來 → 圖文選單往上展開」，
                     兩件事分兩條觸發線（lp-reveal 88%／lp-cue 76%），跟全站同一條房規。 -->
                <div class="lp-band__phone lp-reveal lp-cue">
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
                      <!-- ⚠️ 二十輪多包一層 .lp-pmenu-slot（回饋「圖文選單的動畫有點生硬」）：
                           原本用 clip-path 由下往上「揭開」——圖不動、一條**水平的硬邊**掃上去，
                           那條線就是生硬的來源。現在改成**圖自己往上滑進來**、由這個
                           overflow:hidden 的槽裁掉還沒進場的部分：動的是內容不是切線，
                           而且這才是 LINE 圖文選單真正的行為。
                           ⛔ 這層不能拿掉、也不能改成 overflow:visible：選單會蓋到 Home 橫條
                              （.lp-pscreen 的 overflow 裁不到跑到它下面的東西）。 -->
                      <div class="lp-pmenu-slot">
                        <img
                          class="lp-pmenu"
                          src="/landing/richmenu-midautumn.webp"
                          alt="LINE 圖文選單示意：上排兩格「本月精選」「會員專屬」，中間一整排是中秋節禮盒的主視覺與「立即選購」按鈕，下排三格「商品資訊」「訂單問題」「真人客服」"
                          loading="lazy"
                          width="800"
                          height="540"
                        >
                      </div>

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
        </div>
      </div>
    </section>

    <!-- ── 店家的話（證言牆）─────────────────────────────────
         版位＝「能做什麼」與 60 秒區之間（2026-09-06 老闆要求上移：先看它能做什麼 →
         聽別人怎麼說 → 再看開始有多簡單）。掛灰底接上白灰交錯（value 白 → 這裡灰 →
         fast 白）；⚠️ 它上移後，fast/pricing/grow/faq 四區的灰白整組翻面（見檔頭順序表）。
         呈現＝**雙列反向慢速跑馬燈**：上列往左、下列往右飄，滑鼠移上去那一列就停。
         全頁其他動畫都是「演一次的表演」，這面牆是唯一的環境動態——所以它跟
         .lp-wall__blink 同一類（無限循環、早開演不會錯過），不掛 .lp-cue、
         沒有 JS 也照飄（純 CSS）。機關與房規見 _landing.scss 的證言牆那段。
         ⚠️ 每列的卡組用 v-for 渲染 **3 份**＝無縫循環的機關（位移一份的寬度後畫面
            跟起點一模一樣），第 2、3 份掛 aria-hidden——讀屏只該聽到一遍。
         ⛔ 內容紅線（STATUS D-13 前科，08-14 老闆拍板「補社會證明→不做」因為沒有真素材）：
            這面牆目前全部是**虛構店家的情境示意**，圖說那句「皆為情境示意」拿掉的瞬間
            就從示意變假見證（造假）。細則見 script 的 LP_VOICES 註解。 -->
    <section class="lp-section lp-section--tint">
      <div class="lp-wrap">
        <div class="lp-turn lp-reveal">
          <span class="lp-turn__ava"><BrandLogo mark on-color alt="" /></span>
          <div class="lp-bubble">
            <h2>別只聽我說，<br>聽聽<span class="mark">開店的人</span>怎麼說。</h2>
          </div>
        </div>
      </div>

      <!-- 牆刻意在 .lp-wrap 外面＝滿版寬，兩側用遮罩淡出（見 SCSS）。
           進場淡入掛在**每一列**（兩列各自是一個視覺單位），第二列錯開 70ms。 -->
      <div class="lp-voices">
        <div
          v-for="(row, ri) in LP_VOICES"
          :key="ri"
          class="lp-voices__row lp-reveal"
        >
          <div class="lp-voices__track" :class="{ 'lp-voices__track--rev': ri === 1 }">
            <ul
              v-for="n in 3"
              :key="n"
              class="lp-voices__set"
              :aria-hidden="n > 1 ? 'true' : undefined"
            >
              <!-- 卡片＝**白色對話泡泡＋店家籤**（09-03 二輪「UI 美感再優化」）：
                   泡泡尾巴指向下方的磚——全頁的語彙就是對話（MiniMe 淡綠泡泡開場、
                   後台對話窗客人是白泡泡），店家的話長成白泡泡剛好接上，
                   也取代了一輪那顆飄在角落的裝飾引號。⛔泡泡不上綠底（綠泡泡被打槍過兩次）。 -->
              <li v-for="v in row" :key="v.who" class="lp-voice">
                <blockquote class="lp-voice__bubble">
                  <p>{{ v.text }}</p>
                </blockquote>
                <div class="lp-voice__who">
                  <span class="lp-voice__tile" aria-hidden="true">{{ v.tile }}</span>
                  <span class="lp-voice__name">{{ v.who }}<small>{{ v.title }}</small></span>
                </div>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <div class="lp-wrap">
        <!-- ⛔ 這句圖說是這面牆能存在的前提（同 Hero「以咖啡店為例」的地位），不可拿掉；
             拿到可具名的真素材後整包換掉、圖說改成具名授權的寫法。 -->
        <p class="lp-figcap lp-figcap--center lp-reveal">以上店家與內容皆為情境示意，非真實客戶見證。</p>
      </div>
    </section>

    <!-- ── 60 秒上線＝一條路（09-03 十二輪打破雙卡框架；二十三輪「置中直式」收成**左軸清單**）─
         十二輪拆掉左右兩張等高白卡、十五輪拍板置中直式之後，使用者看實截再問「是否有
         更好的排法、可以捨棄現在的排版方式」。置中直式的病：每站「磚在上、字在下」的
         孤島＋長連接線，兩個小步驟拉出 ~480px 高——版面的節奏在跟「只要兩步、60 秒」
         唱反調；而且窄欄置中文字直落到 760px 寬的 demo 卡，兩者沒有共用的邊，卡是浮的。
         二十三輪＝**軸在左、內容靠右一欄對齊**：磚與連接線收成左欄，✓ 結果面板與 demo
         卡都縮排在同一條左軸下（demo 掛在軸上當證據），兩步讀起來是「掃一眼的清單」
         不是「走三站的旅程」；整個塊仍置中（830px），桌機手機同一版。
         ⚠️ 沿用的決策：①結果面板不是節點——✓ 沒有磚也沒有連接線，上方 overline 才敢說
            「兩步」（08-27 拍板）；改左軸後它縮排在第 2 步的文字欄裡＝更明確讀成
            「做完這步的結果」。②接 LINE 那站的圓點用**聊天圖示**不用數字：它不算在
            「兩步」裡（fine print：接 LINE 的部分隨時可以再回來做）
         ⚠️ 第一步是 **Google 一鍵登入**：2026-08-27 查證 app/pages/login.vue，
            登入只有 `GoogleAuthProvider`，沒有 email 開通連結——改文案前先確認
            登入方式還是不是這個。
         ⚠️ 「60 秒」的口徑（09-03 `D-57` 拍板＝方案①）：60 秒只錨「**開好帳號**」
            （Google 登入＋取名字，✓ 那行自己就是證據）；接 LINE 賣「有人陪」不賣快——
            實際是 10 分鐘級，⛔別再把 60 秒跟「上線／完成設定／接 LINE」焊在一起
            （舊版收尾 CTA 犯過）：承諾會在最難的一步爆掉，客人覺得被騙的時點剛好是
            最需要信任的時點。09-06 起這區的 h2 不再扛 60 秒（老闆回饋原標題難懂），
            門面文案剩 **4 處**同口徑（Hero 小字／這區 overline／收尾 CTA 副標／黏性條），
            改任一處先 grep。 -->
    <section id="fast" class="lp-section">
      <div class="lp-wrap">
        <div class="lp-turn lp-reveal">
          <span class="lp-turn__ava"><BrandLogo mark on-color alt="" /></span>
          <div class="lp-bubble">
            <!-- 09-06 老闆回饋「接 LINE 有人陪」字怪＋（矛盾的）「整區可拉掉」→ 拍板留區換講法：
                 這區是全頁唯一回答「我不懂技術做不做得起來」的證據區（實況 demo＋FAQ 兩題靠它），
                 標題不再扛 60 秒（口徑由底下 .lp-path__over 的「開帳號只要兩步 · 60 秒」講）。 -->
            <h2>開始，<br>比你想的<span class="mark">簡單</span>。</h2>
          </div>
        </div>

        <!-- ⚠️ **左軸清單**（09-03 二十三輪；十五輪的「置中直式」由使用者重開——「是否有
             更好的排法，可以捨棄現在的排版方式」）：磚＋連接線收在左欄（__col），
             內容靠右一欄對齊——1 → 2（✓ 章縮排在它的文字欄）→ 聊天站（demo、note
             同欄縮排）。桌機手機同一版，手機只收磚／字級一級＋讓 demo 卡跳出縮排。
             ⚠️ 第二步文案 09-03 使用者抓包：「填寫基礎商家資訊（店名、行業、賣什麼）」
             **是不存在的步驟**——grep 過整個開通流程沒有商家資訊表單，真實的第二件事是
             useOnboardingChat.ts stepCreate 的「先幫你的官方帳號取個名字，通常用品牌名，
             之後隨時能改。」文案改成取名字（劇本原文改寫、沒有新宣稱），
             「現在只需要兩步」因此仍然成立。⛔別把「行業／賣什麼」加回來——
             那是早期自助精靈時代的殘影，現行系統問的只有名字。 -->
        <!-- ⚠️ 進場動畫掛在**每一列**、不是掛在 .lp-path 這層（09-03 使用者反映「動畫常常
             還沒滑到就已經觸發完了」）：整條路 800px+，掛在外層的話一露出上緣就整條
             淡完——真的捲到時什麼都不會發生。一列一個單位＝跟著捲動一列一列亮，
             跟 #value 那疊同一條房規。
             ⚠️ 連接線的 .lp-cue 掛在**線自己**（.lp-path__rail）身上（見底下的 cueIo）：
                它要在「那一段路」真的看得見時才長，不是跟著整列的淡入一起跑。 -->
        <div class="lp-path lp-stack">
          <div class="lp-path__over lp-reveal">開帳號只要兩步 · 60 秒</div>
          <div class="lp-path__row lp-reveal lp-reveal--fade">
            <div class="lp-path__col">
              <span class="lp-path__dot">1</span>
              <span class="lp-path__rail lp-cue" aria-hidden="true" />
            </div>
            <div class="lp-path__body">
              <b>用 Google 帳號登入</b>
              <small>不用另外設密碼</small>
            </div>
          </div>
          <div class="lp-path__row lp-reveal lp-reveal--fade">
            <div class="lp-path__col">
              <span class="lp-path__dot">2</span>
              <span class="lp-path__rail lp-cue" aria-hidden="true" />
            </div>
            <div class="lp-path__body">
              <b>幫官方帳號取個名字</b>
              <small>通常用品牌名，之後隨時能改</small>
              <div class="lp-path__done"><span aria-hidden="true">✓</span>帳號就開好了，可以開始設定</div>
            </div>
          </div>
          <div class="lp-path__row lp-path__row--station lp-reveal lp-reveal--fade">
            <div class="lp-path__col">
              <span class="lp-path__dot lp-path__dot--chat" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.6a7.6 7.6 0 0 1-7.6 7.6H4.2l1.5-3A7.6 7.6 0 1 1 21 11.6z" /></svg></span>
            </div>
            <div class="lp-path__body">
              <div class="lp-path__head">
                <b>接 LINE 的時候，有人陪</b>
                <span class="lp-path__meta">系統實際畫面</span>
              </div>
              <!-- ⚠️ 「系統實際畫面」＝用開通引導頁真正的樣式現場渲染（09-03 八輪，做法與
                   #value 兩扇 live 視窗同一套；取代 admin-onboarding.png）。樣式源頭＝
                   _onboarding.scss（.onbc-*）＋ _agent-chat.scss（.agm-*），後台改樣式這裡
                   自動跟上、改「結構」要跟著搬。⛔擋互動的三件套（inert/role="img"/
                   user-select:none）一件都不准掛——會退化回「一張圖」（六、七輪的教訓）。
                   ⛔ 內容不是自由發揮：進度條五格＝useOnboardingChat.ts 的
                   ONBOARDING_PROGRESS_LABELS（別 import——那支 composable 會把整包
                   拖進官網 bundle，抄字＋這行註解就好）；兩句話與兩顆鈕＝同檔 stepSecret
                   的原文（307/305 行附近），劇本改字這裡要跟著改。示範帳號山丘咖啡，
                   停在「拿鑰匙」＝刻意沒接 LINE 的那一步。
                   ⚠️ 進場動態（09-03 八輪「做動態的」＋九輪「show 出更多步驟」）：捲到之後
                   由 JS 時間軸把整趟快樂路徑演完——對白一句句冒出（前面有真的打字點點）、
                   進度條跟著對話一格格亮到「完成」；對話區＝固定高的捲動欄（跟真頁面同款），
                   舊訊息自己往上捲。劇本資料與節奏在 OB_BEATS／playObDemo（本檔 script）。
                   SSR／無 JS／減少動態＝停在「拿鑰匙」問句＋兩顆選項的靜態卡。 -->
              <!-- 卡片自己是一個進場單位（lp-reveal）＋自己收動畫的線（lp-cue）：
                   淡入→捲到眼前才開演，兩件事分兩條線。⛔別只留外層那站的 lp-reveal：
                   那一站含標題與圖說有 594px 高，卡片會在畫面外淡完。 -->
              <div ref="obCardEl" class="lp-liveob lp-reveal lp-cue">
                <div class="onbc-shell">
                  <header class="onbc-head">
                    <BrandLogo mark class="onbc-mark" />
                    <div class="onbc-head__text">
                      <span class="onbc-head__title">開通引導</span>
                      <span class="onbc-head__sub">小幫手陪你把設定做完</span>
                    </div>
                    <!-- 真頁面是 NuxtLink；這裡是展示品，用 span 掛同 class（點了不能把人
                         帶去登入牆），title 那句照搬——滑過去有字＝又一個「它是活的」證明 -->
                    <span class="onbc-exit" title="現在離開沒關係，下次回來我會從沒做完的地方接著帶">之後再說</span>
                  </header>
                  <div class="onbc-progress" aria-hidden="true">
                    <div
                      v-for="(label, i) in OB_PROGRESS_LABELS"
                      :key="label"
                      class="onbc-step"
                      :class="{ 'is-done': i < obProgress, 'is-current': i === obProgress }"
                    >{{ label }}</div>
                  </div>
                  <div ref="obChatEl" class="onbc-chat">
                    <div
                      v-for="(b, i) in OB_BEATS.slice(0, obBeat)"
                      :key="i"
                      class="agm-msg"
                      :class="b.role === 'user' ? 'agm-msg--user' : 'agm-msg--agent'"
                    >
                      <!-- html 僅限上面 OB_BEATS 裡劇本原文的常數（同真渲染器的警語） -->
                      <!-- eslint-disable-next-line vue/no-v-html -->
                      <div class="agm-bubble"><div v-html="b.html" /></div>
                    </div>
                    <div v-if="obTyping" class="agm-msg agm-msg--agent"><div class="agm-bubble agm-typing"><i /><i /><i /></div></div>
                    <!-- 選項鈕只在「還停在問句」時存在；使用者選了（demo 演到下一拍）就消失，跟真頁面一樣。
                         順序照 orderAgentChoices：其他 → 主要動作（主鈕靠右） -->
                    <div v-if="obBeat === 2 && !obTyping" class="agm-choices">
                      <el-button round>我會拿，直接貼上</el-button>
                      <el-button round type="primary">教我一步步拿</el-button>
                    </div>
                  </div>
                </div>
              </div>
              <p class="lp-path__note">不懂技術也沒關係——每一步都用聊天帶你做，卡住就點「教我一步步拿」。</p>
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
         大字報價＋方案一覽，數字全部讀 plans.ts（單一事實來源），調價這裡自己跟上。
         方案一覽 08-26 曾收成「只主打 399」，2026-09-04 老闆要求四個方案都要呈現而回來
         （清單本體＝FEATURED_PLAN_IDS，升級對話框與 /product-info 吃同一份）；
         金流風控的五項揭露住在獨立頁 /product-info（見該頁檔頭），
         ⛔ 底下那條「完整商品資訊」連結是首頁通往揭露頁的路，不能拿掉。 -->
    <section id="pricing" class="lp-section lp-section--tint">
      <div class="lp-wrap">
        <!-- 價格鎖排（lockup）：貨幣、數字、單位同一條基線一行讀完——
             「NT$ 懸在數字左上、／月掉到下一行」被老闆抓過（單位跟數字分家，要拼兩行才懂）。
             ⚠️「／月起」的「起」是 09-04 露出四個方案時補的：底下同時看得到 799 與 1,499，
                大字若還寫死「一個月只要 399」就變成不實陳述。 -->
        <div class="lp-bigprice lp-reveal">
          <span class="lp-bigprice__lbl">一個月只要</span>
          <div class="lp-bigprice__num">
            <span class="lp-bigprice__cur">NT$</span>{{ fmt(lowestPaidPrice) }}<span class="lp-bigprice__per">／月起</span>
          </div>
          <span class="lp-bigprice__unit">不綁約、隨時可取消</span>
        </div>

        <!-- 方案一覽（2026-09-04 老闆：這裡要呈現免費／399／799／1,499）。
             ⛔ 清單本體讀 FEATURED_PLAN_IDS，別在頁面自己列 id——2026-08-17 就是因為官網與
                付款彈窗各維護一份，改了官網沒改彈窗被老闆抓到。
             ⛔ 卡上刻意只列「每月則數／席次／知識庫份數」而且沒有打叉的列：打叉會跟底下那行
                圖說（AI 客服四個方案都能用）同一區自打嘴巴——同 2026-08-21「不寫 799 才有
                完整 AI 客服」的拍板。要動這個口徑先看圖說那段的 ⛔（連著後台彈窗一起改）。
             ⛔ 卡上刻意沒有各自的按鈕：官網買不到方案（要先註冊、在後台才選），四顆一模一樣
                的按鈕只會讓人以為按下去就選定了，也違反「每一列都長一樣＝等於沒有」。
             進場動畫掛在每張卡（不是這層網格）：手機單欄時四張疊起來，掛在外層網格的話
             最後幾張在畫面外就淡完了。桌機同一排＝靠 nth-child 錯開 70ms。 -->
        <div class="lp-plans">
          <div
            v-for="p in featuredPlans"
            :key="p.id"
            class="lp-plan lp-reveal"
            :class="{ 'is-pick': p.id === entryPaidPlanId }"
          >
            <!-- 「推薦」＝上面大字報的那個價位，靠 entryPaidPlanId 導出來的，不會跟大字走散。
                 ⛔ 別改成「最受歡迎」：那是可被查證的人數宣稱，我們沒有這個數字。 -->
            <span v-if="p.id === entryPaidPlanId" class="lp-plan__ribbon">推薦</span>
            <span class="lp-plan__name">{{ p.name }}</span>
            <div class="lp-plan__price">
              <span class="lp-plan__cur">NT$</span>{{ p.price }}<small>／月</small>
            </div>
            <p class="lp-plan__quota">每月 AI 回覆 <b>{{ p.quota }}</b> 則</p>
            <ul class="lp-plan__spec">
              <li v-for="s in p.specs" :key="s">{{ s }}</li>
            </ul>
          </div>
        </div>
        <!-- 方案卡的圖說。四張卡列的東西不一樣，讀者第一個念頭是「便宜的是不是被砍功能」，
             所以這行要先把那個疑慮擋掉，再講差別。
             ⚠️ 2026-09-04 老闆拍板把這底下原有的三張特點卡整組拿掉（「友善的引導式設定」與
                「60 秒就能開始」都在重講正上方 #fast 那一段，見那兩處；三張裡唯一別處沒有的
                只有一串功能清單），清單併進這一行才有工作做。
             ⛔ 別把它改回卡片：那三張卡橫在四張方案卡與 CTA 之間 183px（平板 412px），
                讀者正要按按鈕，中間插的卻不是「選哪個方案／會不會被扣款」。
             ⛔ 這裡刻意**不寫「四個方案功能完全一樣」**，即使目前只有 answeredQuota 真的被
                enforce：plans.ts 的 scripting 在免費／輕量是 false，而後台「選擇方案」彈窗
                （AdminPlanUpgradeDialog 的「流程」欄）就是拿它印 ✓／— 給客戶看的。官網宣稱
                一樣、彈窗印「—」＝ 2026-08-17 被抓過的同一種自打嘴巴。改口徑要連彈窗與
                plans.ts 一起處理，見 STATUS 的 `D-59`。
                「AI 客服四個方案都能用」是查得證的（四個方案的 answeredQuota 都 > 0）。
             ⛔ 結尾刻意只寫「隨時可以升級或降級」、**不再補「不綁約」**：大字報價底下那行
                （.lp-bigprice__unit）已經寫了「不綁約、隨時可取消」，中間只隔約 300px，
                同一個承諾講兩次（2026-09-04 老闆「小字是否也有點多」）。這一區三個風險
                各留一次＝取消（大字底下）／換方案（這裡）／扣款（CTA 底下）。 -->
        <!-- 「知識庫」那半句的白話解釋是 09-06 老闆回饋補的（「知識庫兩份資料不好理解」）：
             方案卡上只有「知識庫 N 份資料」六個字，第一次看的人不知道那是什麼、多算多。 -->
        <p class="lp-plans__note lp-reveal">
          <b>AI 客服四個方案都能用</b>，差別只在<b>規模</b>：每月 AI 回覆則數、團隊席次，以及知識庫份數——知識庫就是你給 AI 讀的資料，菜單、價目表、官網都算。隨時可以升級或降級。
        </p>

        <div class="lp-pricecta lp-reveal">
          <NuxtLink class="lp-btn lp-btn--primary" to="/login">免費打造我的 {{ brandName }}</NuxtLink>
          <!-- ⛔ 開頭刻意**不再寫**「每個帳號都有免費額度」（2026-09-04 老闆「小字是否也有點多」）：
               正上方第一張卡就是「免費／NT$0／每月 AI 回覆 200 則」，那句話是在用文字重講一張
               已經看得到的卡。這一行只留這區唯一沒別處講過的風險答案＝額度用完會怎樣。
               ⛔「不會自動扣款」不可拿掉：它是我們對客人做的付款承諾，整頁只有這裡講。 -->
          <p class="lp-pricecta__fine">額度用完時 AI 會先轉真人接手，<b>不會自動扣款</b>。</p>
          <!-- 法遵揭露在獨立頁（/product-info，頁尾也有入口），這裡留一條看得見的路過去 -->
          <p class="lp-pricecta__more"><NuxtLink to="/product-info">完整商品資訊、付款與發票說明 →</NuxtLink></p>
        </div>
      </div>
    </section>

    <!-- ── 生意成長 ────────────────────────────────────────────
         兩條線：綠＝也經營舊客、灰＝只靠新客。示意模型，Y 軸刻意沒有刻度、
         也刻意不畫格線（沒有刻度可對照，格線只是雜訊）。
         顏色是量過對比度與色盲可辨識度才定的（見 _landing.scss 的 .lp-chart）。 -->
    <section id="grow" class="lp-section">
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
              <!-- lp-cue：畫線／浮標籤要在圖本身看得見時才跑（跟著外層卡的淡入跑的話，
                   圖還在畫面下方 300px 就畫完了） -->
              <div class="lp-chartwrap lp-cue">
                <svg class="lp-chart" viewBox="0 0 760 330" preserveAspectRatio="xMidYMid meet" role="img" aria-label="示意模型：同時經營舊客的成長曲線逐年拉開，只靠新客則維持平緩的直線成長">
                  <defs>
                    <linearGradient id="lpGrowArea" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stop-color="#06c755" stop-opacity=".22" />
                      <stop offset="100%" stop-color="#06c755" stop-opacity="0" />
                    </linearGradient>
                    <!-- 灰線的面積漸層（09-03 反映「只靠新客也參考綠色的色塊」＋「深一點」）：
                         同款做法、吃灰線的線色 #848e88。⚠️ 透明度 .26 比綠色的 .22 高一階
                         是刻意的：漸層吃的是各自路徑的 bounding box，灰色那塊只有 54px 高、
                         淡出跑得快，數字同階時看起來會比綠色淺很多（第一版 .16 被反映太淺） -->
                    <linearGradient id="lpGrowAreaBase" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stop-color="#848e88" stop-opacity=".26" />
                      <stop offset="100%" stop-color="#848e88" stop-opacity="0" />
                    </linearGradient>
                  </defs>
                  <line class="lp-chart__axis" x1="60" y1="284" x2="700" y2="284" />
                  <path
                    class="lp-chart__area"
                    d="M60 265 C110 262,160 256,210 250 C260 243,310 234,360 220 C410 205,460 186,510 160 C560 130,610 92,660 40 L660 280 L60 280 Z"
                    fill="url(#lpGrowArea)"
                  />
                  <!-- ⚠️ 掛同一個 lp-chart__area class＝跟綠色面積同一組浮出動畫；
                       疊在綠色面積上面（灰的那一帶綠色漸層已淡到近零，不會混濁）。
                       路徑＝灰線原路徑收到軸線，改灰線座標時這裡要一起改 -->
                  <path
                    class="lp-chart__area"
                    d="M60 265 C160 259,260 252,360 246 C460 240,560 233,660 226 L660 280 L60 280 Z"
                    fill="url(#lpGrowAreaBase)"
                  />
                  <!-- ⚠️ 兩條線都給 pathLength="1"：畫線動畫用 stroke-dasharray／dashoffset，
                       這個屬性讓瀏覽器把「線有多長」一律當成 1，動畫就能寫成 1 → 0。
                       ⛔ 別改回寫一個「比兩條都長」的固定值（原本是 1200，而兩條實際只有
                          658 與 600）：那樣線在動畫走到 21% 時就已經畫完，後面 0.86 秒
                          畫面是靜止的，然後標籤才突然浮出來——量過的，不是感覺。
                       附帶好處：兩條長度不同的線會同時畫完，不會一條先到。 -->
                  <!-- 灰線＝直線式的緩升（09-03 反映「太平緩」：原本 600px 只升 9px、近乎水平，
                       讀起來像「只靠新客＝原地踏步」，說過頭了）。現在升 39px＝有在成長、
                       但沒有複利的弧度——跟綠線的差距講的是「加速度」，不是「動 vs 不動」。 -->
                  <path
                    class="lp-chart__base"
                    pathLength="1"
                    d="M60 265 C160 259,260 252,360 246 C460 240,560 233,660 226"
                  />
                  <path
                    class="lp-chart__me"
                    pathLength="1"
                    d="M60 265 C110 262,160 256,210 250 C260 243,310 234,360 220 C410 205,460 186,510 160 C560 130,610 92,660 40"
                  />
                  <g class="lp-chart__dots">
                    <circle class="lp-chart__dot--me" cx="660" cy="40" r="7" />
                    <circle class="lp-chart__dot--base" cx="660" cy="226" r="6" />
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
                    <text class="lp-chart__lbl--base" x="644" y="212" text-anchor="end">只靠新客</text>
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
    <section id="faq" class="lp-section lp-section--tint lp-faqsec">
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
        <!-- 進場動畫掛在每一題（不是這層）：手機單欄時六題疊成 385px，
             掛外層的話後面幾題在畫面外就淡完了。同欄內靠 nth-child 錯開 60ms。 -->
        <div class="lp-faq">
          <div class="lp-faq__grid">
            <div>
              <details class="lp-q lp-reveal">
                <summary>我不懂技術，也能設定嗎？<span class="plus" v-html="plusIcon" /></summary>
                <div class="a">可以。註冊後有 AI 陪你用聊天的方式把設定做完——你回答店名、給一份菜單或官網，它自己讀完建成知識庫，全程不用寫程式。</div>
              </details>
              <details class="lp-q lp-reveal">
                <summary>我的客戶資料安全嗎？<span class="plus" v-html="plusIcon" /></summary>
                <!-- ⛔ 別把「可自行刪除」加回來：後台沒有刪除客人／對話的入口。這句要跟隱私權頁
                     （2026-08-21 已改成寄信處理）講一樣的話——做出自助刪除（STATUS H-15c）之前，
                     任何一處寫「隨時可刪」都是對消費者的不實承諾。 -->
                <div class="a">資料存在你自己的工作區，我們不會另作他用。需要刪除特定客人或整批資料時，寄信到 <a :href="emailHref">{{ email }}</a>，我們會在確認你的身分後 30 日內處理。</div>
              </details>
              <details class="lp-q lp-reveal">
                <summary>按用量計價，會不會爆帳單？<span class="plus" v-html="plusIcon" /></summary>
                <div class="a">不會。每個帳號都有免費額度，之後按 AI 回覆則數計價。用量在後台看得到，額度用完時 AI 會停止自動回覆並轉真人接手，<b>不會自動加收超量費用</b>——要加購額度或升級方案都由你決定。</div>
              </details>
            </div>
            <div>
              <details class="lp-q lp-reveal">
                <summary>需要綁約嗎？<span class="plus" v-html="plusIcon" /></summary>
                <div class="a">不用。隨時可取消，取消後服務用到本期結束、不會再扣款。取消方式與退費規則見<NuxtLink to="/refund">退費與取消政策</NuxtLink>。</div>
              </details>
              <details class="lp-q lp-reveal">
                <summary>支援哪種 LINE 帳號？<span class="plus" v-html="plusIcon" /></summary>
                <!-- ⚠️ 口徑跟 60 秒區一致（「每一步都用聊天帶你做」）：原本寫「貼一組 Webhook
                     網址即可接通」——對不懂技術的讀者是天書，跟全頁「不懂技術也沒關係」打架
                     （順帶修掉句中的半形逗號）。 -->
                <div class="a">你現在用的 LINE 官方帳號（OA）就可以接。接通的每一步都有聊天引導帶你做，不懂技術也沒關係。</div>
              </details>
              <details class="lp-q lp-reveal">
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
        <p class="lp-cta__sub">60 秒開好帳號，接 LINE 的每一步都有人陪。</p>
        <div class="lp-cta__actions">
          <NuxtLink class="lp-btn lp-btn--white" to="/login">免費打造我的 {{ brandName }}</NuxtLink>
          <a class="lp-cta__talk" :href="emailHref">想先聊聊？寄信給我們 →</a>
        </div>
        <p class="lp-cta__fine">每月 NT${{ fmt(lowestPaidPrice) }} 起 · 不綁約、隨時可取消，取消後服務用到本期結束</p>
      </div>
    </section>

    <!-- ── Footer（公司資訊／客服窗口／政策條款，與法務頁共用同一個元件）── -->
    <SiteFooter />

    <!-- ── 黏性行動條（捲離 Hero 之後升起）──────────────────────
         收起時 aria-hidden：不然螢幕閱讀器會在頁尾唸到一顆看不見的註冊鈕。 -->
    <div class="lp-stickybar" :class="{ 'is-show': barShown }" :aria-hidden="barShown ? undefined : 'true'">
      <div class="lp-stickybar__in">
        <!-- 主張句跟 #value 泡泡同口徑（09-06 從「半個客服＋半個行銷」改成「全年無休」），
             改一邊要一起改。「起」是 09-04 露出四個方案時補的（同大字報價）：
             定價區同時看得到 799 與 1,499。 -->
        <span class="lp-stickybar__t1">一個月只要 <em>NT${{ fmt(lowestPaidPrice) }}</em> 起，多了全年無休的客服＋行銷</span>
        <span class="lp-stickybar__t2">60 秒開好帳號 · 不綁約、隨時可取消</span>
        <NuxtLink class="lp-btn lp-btn--primary lp-btn--sm" to="/login" :tabindex="barShown ? undefined : -1">免費打造</NuxtLink>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { BubbleTyping } from '~/utils/bubble-typing'
import { prepareBubbleTyping } from '~/utils/bubble-typing'
import { BILLING_PLAN_ORDER, BILLING_PLANS, FEATURED_PLAN_IDS } from '~~/shared/billing/plans'
import { festivalReminderText, TAIWAN_FESTIVALS } from '~~/shared/taiwan-festivals'
import { daysBetween, taipeiDate } from '~~/shared/time'

definePageMeta({ layout: false })

// 品牌／產品／公司／客服窗口統一由這裡來（與法務頁、頁尾同一份來源）。
// ⚠️ brandName = 品牌／產品名（MiniMe）、companyName = 營運主體（麥菲爾股份有限公司），別混用。
// ⚠️ 草稿裡寫「Mini Me」（有空格）的地方一律用 brandName 代入：商標、電子發票品名、
//    向 PAYUNi 申報的商品名都是無空格的 MiniMe，門面自己寫另一種拼法會對不起來。
const { brandName, email, emailHref } = useSiteIdentity()

const plusIcon
  = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 3v12M3 9h12"/></svg>'

// ── #value「系統實際畫面」聊天視窗的示範對話 ────────────────
// ⛔ 每一句的字、時間、誰回的，都必須跟 scripts/landing-demo-seed.ts 的 MSGS **逐字一致**
//    （08-26「截我們自己系統的圖」用的同一份示範資料；這條規矩的精神＝畫面上的東西
//    系統真的長這樣）。改對話請兩邊一起改。
// ⚠️ 剪過兩輪，現在是 **4 句＝兩組純問答**（2026-09-03 二十三輪，使用者「AI 客服那段是否
//    用正常的問答呈現就好」）：
//      二十一輪先從 7 句剪到 5 句（「內容少一點」），但剪完剩下的 5 句裡有 3 句在講
//      **轉真人**（客人要改地址 → 機器人說交給真人 → 隔天真人回覆）——那不是問答，
//      而這一塊的標題就叫 AI 客服、底下兩條也寫「產品基本 QA／常見問題 QA」，
//      演一段轉真人等於畫面跟主張對不上。
//      現在＝客人問、AI 答，兩組，兩句都掛 AI 標籤與「已讀」。
//    ⚠️ **轉真人那三句因此從官網消失了**（它本來順帶示範了「機器人／真人」兩種發話者標籤）。
//       要把「答不了會交給真人」放回門面，⛔別塞回這扇窗（會再一次違反這一塊的主張），
//       另外找地方講。
//    ⛔ 只准整組刪、不准改字（改字就違反上面那條逐字一致）；種子資料那邊 7 句原封不動。
// `i` ＝整串對話的流水號，給「一句一句到」的錯開延遲用（CSS 的 `--d`）；`d` ＝那一天
//    的第一句序號，讓日期分隔線比它底下第一顆泡泡早一點點出現。⛔ 序號別手改，
//    往下多加一句只要放進陣列，序號是算出來的。
const LP_CHAT = (() => {
  const days: { day: string, msgs: { side: 'incoming' | 'outgoing', text: string, time: string, who?: string, human?: boolean, read?: boolean }[] }[] = [
    {
      day: '昨天',
      msgs: [
        { side: 'incoming', text: '請問日出配方適合手沖嗎？', time: '21:47' },
        { side: 'outgoing', text: '適合的！日出配方是中焙、帶柑橘與黑糖調，手沖建議水溫 90–92°C、粉水比 1:15，風味最平衡 ☕', time: '21:47', who: 'AI', read: true },
        { side: 'incoming', text: '那有禮盒包裝嗎？想送人', time: '21:49' },
        { side: 'outgoing', text: '有的，禮盒含提袋與手寫卡片，下單備註想說的話，我們會幫您附上 🎁', time: '21:49', who: 'AI', read: true },
      ],
    },
  ]
  let i = 0
  return days.map(g => ({ day: g.day, d: i, msgs: g.msgs.map(m => ({ ...m, i: i++ })) }))
})()

// ── #value「系統實際畫面」好友視窗的示範資料 ─────────────────
// ⛔ 跟 scripts/landing-demo-seed.ts 的 TAGS／USERS 是同一份（08-26「截我們自己系統的圖」
//    的示範工作區資料，無真實客資），改名單/標籤兩邊一起改。
//    列序＝加入時間新到舊（u12→u1）、每列標籤順序照後台實際渲染，跟舊 PNG 一致。
const LP_DEMO_TAGS = {
  gift: { name: '送禮客群', color: '#0f9d58' },
  brew: { name: '手沖愛好者', color: '#8a5a2b' },
  expo: { name: '咖啡展加入', color: '#4a7fb5' },
  regular: { name: '門市常客', color: '#8a6d3b' },
  sub: { name: '豆子訂閱中', color: '#6b7f5a' },
}
const landingDemoFriends = [
  { name: '豆豆媽', tags: [LP_DEMO_TAGS.sub] },
  { name: 'Tina L.', tags: [LP_DEMO_TAGS.gift] },
  { name: '老王', tags: [LP_DEMO_TAGS.regular] },
  { name: 'YUKI ☕', tags: [LP_DEMO_TAGS.expo, LP_DEMO_TAGS.sub] },
  { name: '陳太太', tags: [LP_DEMO_TAGS.gift, LP_DEMO_TAGS.regular] },
  { name: 'Jimmy C.', tags: [LP_DEMO_TAGS.brew, LP_DEMO_TAGS.sub] },
  { name: '小綠', tags: [LP_DEMO_TAGS.regular] },
  { name: '咖啡貓', tags: [LP_DEMO_TAGS.brew] },
  { name: 'Peggy Wang', tags: [LP_DEMO_TAGS.brew, LP_DEMO_TAGS.gift] },
  { name: '阿翔', tags: [LP_DEMO_TAGS.expo] },
  { name: 'Ariel 🌿', tags: [LP_DEMO_TAGS.brew, LP_DEMO_TAGS.expo] },
  { name: '曉彤', tags: [LP_DEMO_TAGS.gift] },
]

// ── 店家的話（證言牆，「能做什麼」與 60 秒區之間；09-06 上移）────
// ⛔ 內容紅線（STATUS.md D-13 前科：2026-08-14 老闆拍板「補社會證明→不做」，理由＝
//    「沒有可具名的試用店家素材；⛔日後要補請給真材料，全示意數字的頁面加假見證會從
//    『示意』變『造假』」）。這面牆目前全部是**虛構店家的情境示意**，所以：
//    ① 牆下「皆為情境示意」的圖說⛔不可拿掉——拿掉的瞬間就是假見證；
//    ② 每一句只准講**現有功能真的做得到**的事（AI 答問、答不了轉真人、節慶提醒、
//       建議式貼標、標籤分眾推播、看得出誰回的、聊天引導開通、免綁卡），
//       ⛔不准出現任何數字成效（「回購率 +30%」這種）——店家已是虛構，數字宣稱最先變造假；
//    ③ 老闆給了可具名的真素材後整包換掉、圖說改成具名授權的寫法，這段註解一併改。
// 結構＝兩列（上列講客服、下列講行銷與上手），tile＝磚裡的單一業種字
// （標記系統房規：磚裡只放數字或單一字符，⛔不引進圖示家族）。
// who／title 刻意只寫「業種＋角色」不取店名：掛了店名（哪怕虛構）就是 Hero 註解裡
// 「山丘咖啡會被讀成他們的客戶」同一顆雷。
const LP_VOICES: { tile: string, who: string, title: string, text: string }[][] = [
  [
    { tile: '咖', who: '咖啡烘焙坊', title: '老闆', text: '晚上十一點客人問手沖水溫，它馬上就答了。我早上起來只要看它答了什麼。' },
    { tile: '甜', who: '甜點工作室', title: '主理人', text: '以前訊息都積到打烊才回，現在常見的問題它先接住，我只處理要我決定的事。' },
    { tile: '選', who: '選物店', title: '店長', text: '規格、運費這些每天都有人問，把官網跟型錄餵給它，它就會答了。' },
    { tile: '寵', who: '寵物用品店', title: '老闆娘', text: '它答不了的會直接轉給我，不會硬答——這點我才敢放心讓它顧。' },
    { tile: '書', who: '獨立書店', title: '店主', text: '我完全不懂技術，照著聊天引導一步一步做，真的就設定完了。' },
  ],
  [
    { tile: '花', who: '花藝工作室', title: '主理人', text: '母親節前它先提醒我準備檔期，要發給誰，選個標籤名單就在那裡。' },
    { tile: '飾', who: '手作飾品品牌', title: '負責人', text: '誰在問送禮、誰是回頭客，它會建議貼標籤，名單越用越乾淨。' },
    { tile: '茶', who: '茶行', title: '第二代', text: '後台看得到每句話是 AI 回的還是我回的，要接手的時候心裡有底。' },
    { tile: '課', who: '烘焙教室', title: '老師', text: '開課要通知，用標籤挑出上過課的人發就好，不用整包名單亂槍打鳥。' },
    { tile: '健', who: '健身工作室', title: '教練', text: '免費就能開始、不用綁卡，接自己本來的官方帳號，試了才知道多省事。' },
  ],
]

// ── 開通引導 live 卡的動態展示（09-03 九輪「show 出更多步驟」）──────
// ⛔ 每一句對白都是 useOnboardingChat.ts 劇本的**原文**（stepWelcomeBack/stepToken/
//    stepSecret 505 行/366 行、stepWebhookAndFirstMsg 891/957 行、stepFirstMessageWait
//    548/714 行、stepDone 1107 行；使用者泡泡＝選項 label 原字），劇本改字這裡跟著改；
//    「山丘咖啡」＝landing-demo-seed.ts 的示範帳號名。
// 演的是快樂路徑的精華剪輯：真流程在貼鑰匙／貼網址中間還有輸入格、教學卡與網址卡，
// 這裡跳過操作細節、只留每一步的關鍵對白——⛔跳過的段落不准腦補成新句子。
type ObBeat = { role: 'agent' | 'user', html: string, progress?: 2 | 3 | 4 }
const OB_BEATS: ObBeat[] = [
  { role: 'agent', html: '歡迎回來，「山丘咖啡」！我們接著把剩下的設定做完，做過的我會直接跳過。' },
  { role: 'agent', html: '要從 LINE 拿兩把鑰匙。第一把 <b>Channel Access Token</b>——機器人靠它替你傳訊息。' },
  { role: 'user', html: '我會拿，直接貼上' },
  { role: 'agent', html: '收到 ✓ 這把鑰匙是「<b>山丘咖啡</b>」的，已經幫你存好。' },
  { role: 'agent', html: '第二把：<b>Channel Secret</b>——用來確認訊息真的來自 LINE、不是別人假冒的。' },
  { role: 'agent', html: '兩把鑰匙都到手 ✓ 最後一步：把下面這串網址交給 LINE，客人傳的訊息才知道要送來哪裡。', progress: 2 },
  { role: 'user', html: '貼好了，幫我檢查' },
  { role: 'agent', html: '接上了！你的官方帳號已經連上系統，客人的訊息送得進來了。' },
  { role: 'agent', html: '來見證一下。拿手機<b>加你的官方帳號好友</b>，隨便傳一句話給它——我在這裡等。', progress: 3 },
  { role: 'agent', html: '收到了！你的機器人正式活起來了 🎉 之後客人傳的每一句話，都會出現在後台的「對話」頁。' },
  { role: 'agent', html: '接通完成 🎉 接下來交給右下角的<b>小幫手</b>——下一步要做什麼、哪裡怪怪的，它都會主動說。<br>要不要先花 <b>2 分鐘認識一下後台</b>？我帶你逛一圈，知道東西都放在哪。', progress: 4 },
]
// ⛔ ＝useOnboardingChat.ts 的 ONBOARDING_PROGRESS_LABELS，抄字不 import——
//    import 會把整支 composable（含後端呼叫）拖進官網 bundle
const OB_PROGRESS_LABELS = ['建帳號', '拿鑰匙', '讓訊息進來', '傳話測試', '完成']
/** SSR／無 JS／減少動態：停在「拿鑰匙」問句＋兩顆選項＝原本的靜態卡 */
const obBeat = ref(2)
const obTyping = ref(false)
const obChatEl = ref<HTMLElement | null>(null)
const obCardEl = ref<HTMLElement | null>(null)
/** 進度＝已演到的拍點裡最後一個帶 progress 的值；開場停在「拿鑰匙」＝1 */
const obProgress = computed(() => OB_BEATS.slice(0, obBeat.value).reduce<number>((p, b) => b.progress ?? p, 1))
// 開演的時機跟中軸綠線、成長曲線同一條線（.lp-cue → cueIo），這裡不再自己養一個觀察器
let obTimers: ReturnType<typeof setTimeout>[] = []

function obScroll() {
  // 跟真頁面一樣往最新訊息捲（smooth 由 .onbc-chat 的 scroll-behavior 給）
  nextTick(() => obChatEl.value?.scrollTo({ top: obChatEl.value.scrollHeight, behavior: 'smooth' }))
}

/** 捲到卡片才開演（只演一次）；reduced-motion 早退時根本不會被呼叫。
 *  節奏（09-03 反映「動畫可以快一點」收緊過一輪，全長約 21s → 15s）：
 *  打字點點 0.48s ＋ 讀句時間跟長度走（0.45s 起跳、每字 +14ms、上限 1.5s）。 */
function playObDemo() {
  // 開演前的一個呼吸拍。卡片的淡入在觸發線之前就跑完了（.lp-cue 比 .lp-reveal 晚一截），
  // 所以這裡不是在等淡入，是「先讓人看清楚這是什麼，它再開口」。
  let t = 420
  for (let i = obBeat.value; i < OB_BEATS.length; i++) {
    const b = OB_BEATS[i]!
    if (b.role === 'agent') {
      // 真頁面 say() 之前有打字點點，照演
      obTimers.push(setTimeout(() => { obTyping.value = true; obScroll() }, t))
      t += 480
    }
    else {
      t += 300
    }
    obTimers.push(setTimeout(() => { obTyping.value = false; obBeat.value = i + 1; obScroll() }, t))
    t += Math.min(1500, 450 + b.html.length * 14) // 讀句子的時間跟長度走
  }
}

/** 千分位。刻意不用 toLocaleString：SSR（Node ICU）與瀏覽器可能給出不同字串，會造成 hydration 不一致。 */
function fmt(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// ── 價格：直接讀 shared/billing/plans.ts（單一事實來源），改價只動那份、不用改門面 ──

/**
 * 定價區的方案一覽（2026-09-04 老闆：免費／399／799／1,499 都要呈現）。
 *
 * ⛔ 清單本體在 shared/billing/plans.ts 的 `FEATURED_PLAN_IDS`——後台升級對話框與
 *    /product-info 的售價列吃同一份，別在頁面層級另開一份（2026-08-17 就是各維護各的，
 *    官網改了、付款彈窗沒改，被老闆抓到）。
 * ⛔ 順序照 `BILLING_PLAN_ORDER`（低→高）而不是照 FEATURED_PLAN_IDS 的寫法：卡片由便宜排到貴
 *    是讀者的預期，那份清單哪天被人重排也不該讓門面跟著亂。
 * ⚠️ 月費或額度是 null 的方案（企業＝面談報價）不進來：這排卡是拿數字互相比較用的，
 *    沒有數字的卡只會多一張看不懂的（企業卡 08-26 已依 `D-13④` 撤掉，別從這裡偷渡回來）。
 */
const featuredPlans = computed(() =>
  BILLING_PLAN_ORDER
    .map(id => BILLING_PLANS[id])
    .filter(p => FEATURED_PLAN_IDS.includes(p.id) && !p.internal && !p.landingHidden && !p.custom)
    .filter(p => typeof p.priceMonthly === 'number' && typeof p.answeredQuota === 'number')
    .map(p => ({
      id: p.id,
      name: p.name,
      priceMonthly: p.priceMonthly as number,
      price: fmt(p.priceMonthly as number),
      quota: fmt(p.answeredQuota as number),
      // 每張卡的規格列數必須一樣多，行才對得齊（房規：對齊到像素級）
      specs: [
        p.seats === null ? '團隊席次不限' : `團隊 ${p.seats} 席`,
        p.knowledgeSources === null ? '知識庫資料不限' : `知識庫 ${p.knowledgeSources} 份資料`,
      ],
    })),
)

/**
 * 最便宜的那個付費方案＝大字報價的主角，也是唯一掛「推薦」標的卡。
 * 導出來而不是寫死 'lite'：調價或改主打清單時，大字與標籤不會走散。
 */
const entryPaidPlanId = computed(() => featuredPlans.value.find(p => p.priceMonthly > 0)?.id ?? null)

// 「一個月 399 起」的 399 讀 plans.ts，不寫死——調價時 Hero、解法列、定價區、黏性條會一起對。
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

/** 時機卡列接下來兩個檔期。7 天內＝系統開始提醒的門檻，標琥珀；更遠的標「準備中」（草稿用語）。
 *  ⚠️ 節日表的 `angle`（「禮盒與送禮的需求會明顯升溫」那句）2026-09-02 起不帶出來了：
 *     時機卡每一列改成只有「看到什麼＋數字」，理由見上面模板裡印章那段註解。 */
const heroFests = computed(() =>
  upcoming.value.slice(0, 2).map(f => ({
    id: f.id,
    name: f.name,
    md: monthDay(f.date),
    soon: f.days <= 7,
    badge: f.days === 0 ? '今天' : f.days === 1 ? '明天' : f.days <= 7 ? `還有 ${f.days} 天` : '準備中',
  })),
)

// ── AI 行銷「系統實際畫面」推播窗的示範資料（09-06 自動貼標升格那輪新開的窗）──
// 節慶提醒＝真功能（broadcasts.vue 的 .bc-festival-hint），句子用**同一支**
// festivalReminderText 產（shared/taiwan-festivals），⛔別手寫節慶句子——寫死的
// 過完節就過期（同 richmenu 圖那筆 STATUS 待辦）。真頁面只在 7 天窗內顯示（utils/
// festival-hint.ts 的閘門）；這裡是常駐展示，所以不走那道閘，milestone 按剩餘天數
// 自動換檔（>3 天用 7 天檔句型——dayPhrase 對任何天數都成立，句子永遠是真話）。
const lpBcHint = computed(() => {
  const f = upcoming.value[0]
  if (!f) return null
  const milestone = (f.days <= 1 ? 1 : f.days <= 3 ? 3 : 7) as 1 | 3 | 7
  return festivalReminderText({ festival: f, milestone, daysUntil: f.days })
})

// 推播列（AdminSplitListItem 吃的示範資料）。⛔ 標題刻意「客群・主題」且不含日期／
// 節日名：草稿列演的就是「擬好等你發」，不寫死節名＝不會過期；狀態章與 meta 格式照
// broadcasts.vue（statusLabel／bcMetaText：草稿沒排程時間 → meta 只有人數）。
// 人數對齊 Hero 機會卡與好友窗的標籤（手沖 184、咖啡展 216）；送禮 178 是這裡自己的。
const LP_BC_ROWS = [
  { title: '送禮客群・禮盒預購通知', chip: '草稿', tone: 'neutral', meta: '178 人' },
  { title: '手沖愛好者・新豆到貨', chip: '已完成', tone: 'success', meta: '184 人' },
  { title: '咖啡展加入・迎新優惠', chip: '已完成', tone: 'success', meta: '216 人' },
] as const

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
/**
 * 「能做什麼」左軌現在亮哪一條（0 客服／1 行銷／2 自動貼標／3 圖文選單）＝右欄哪一塊正在畫面中央。
 * ⚠️ 預設 0：SSR 與沒有 JS 時第一條亮著，讀起來就是「從這裡開始」，不是三條全暗。
 * ⚠️ 它是**指示器不是動畫**，所以觀察器要裝在 reduced-motion 的早退**之前**（同黏性條）。
 */
const activeCap = ref(0)

function closeMenu() { menuOpen.value = false }
function onScroll() { stuck.value = window.scrollY > 8 }

let io: IntersectionObserver | undefined
let cueIo: IntersectionObserver | undefined
let barIo: IntersectionObserver | undefined
let capIo: IntersectionObserver | undefined
/** 每顆對話泡泡的打字控制，key＝該泡泡的 .lp-turn（它同時就是 .lp-cue 的觀察對象） */
const typings = new Map<HTMLElement, BubbleTyping>()

/**
 * 兩條觸發線。⚠️ 都用 rootMargin（百分比是**視窗高度**的百分比）而不是 threshold：
 * threshold 是「元素露出多少比例」，元素比視窗高很多時比例永遠到不了門檻，那一塊就
 * 再也不會進場。（現況最險的是「能做什麼」那疊，手機上 2,126px、最大比例只有 0.29。）
 *
 * REVEAL＝**淡入**：上緣越過畫面 88%（＝離底部 12% 視窗高）就開始，這時它才剛露出一小條，
 * 淡入正好在使用者眼前發生。
 * CUE＝**有時間軸的動畫**（畫線、長條生長、打字、live demo）：晚一截，上緣要越過畫面 76%。
 * ⚠️ 兩者不能共用一條線：畫線／長條是 0.75～0.9 秒的「表演」，用 88% 那條的話它在元素
 *    只露出一條邊時就開演——等你真的捲到它面前早就演完了（09-03 使用者反映
 *    「動畫常常還沒滑到就已經觸發完了」）。CSS 端的分工見 _landing.scss 的「捲動進場動畫」。
 */
const REVEAL_MARGIN = '0px 0px -12% 0px'
const CUE_MARGIN = '0px 0px -24% 0px'

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

  // 「能做什麼」左軌的高亮：畫面**正中央**那條 10% 高的橫線碰到哪一塊，軌上就亮哪一條。
  // ⚠️ 用 rootMargin 夾出中央橫線、不用 threshold：三塊高度差很多（780／604／534px），
  //    用比例門檻的話高的那塊永遠先達標。
  // ⚠️ 這個觀察器**不 unobserve**（它要一直跟著捲動走，往回捲也要跟著退回去），
  //    而且刻意裝在 reduced-motion 早退之前——它是「你在看哪」的指示器，不是動畫。
  // ⚠️ 沒有任何一塊碰到中線時（例如夾在兩塊之間的圖說）刻意**不動**，維持上一條亮著；
  //    歸零的話軌會在捲動中途閃回第一條。
  const capPanes = [...(root.value?.querySelectorAll<HTMLElement>('#value .lp-pane') ?? [])]
  if (capPanes.length) {
    const inView = new Set<number>()
    capIo = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        const i = capPanes.indexOf(e.target as HTMLElement)
        if (i < 0) return
        if (e.isIntersecting) inView.add(i)
        else inView.delete(i)
      })
      if (inView.size) activeCap.value = Math.min(...inView)
    }, { threshold: 0, rootMargin: '-45% 0px -45% 0px' })
    capPanes.forEach(el => capIo?.observe(el))
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

    // ① 淡入：每個 .lp-reveal 到了就掛 .in，只演一次。
    // ⚠️ .lp-reveal 要掛在「一個視覺單位」上，⛔別掛在高過一個畫面的容器：容器的上緣
    //    一露出就整塊淡完，裡面的東西等你捲到時什麼都不會發生（一條路那疊 1,038px、
    //    #value 兩列手機上各 1,200px，都是拆進去掛的）。
    io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return
        e.target.classList.add('in')
        io?.unobserve(e.target)
      })
    }, { threshold: 0, rootMargin: REVEAL_MARGIN })
    root.value?.querySelectorAll<HTMLElement>('.lp-reveal').forEach(el => io?.observe(el))

    // ② 有時間軸的動畫：晚一截才開跑，確保是在畫面上演給人看的。
    //    對象＝模板裡標了 .lp-cue 的元素（中軸綠線的兩站、成長曲線、開通引導 live 卡）
    //    ＋每顆會打字的對話泡泡。開通引導 demo 的播放也掛在這條線上（同一套規矩，
    //    不再自己一個 threshold 0.3 的觀察器）。reduced-motion 在上面早退＝維持靜態卡。
    const cues = [
      ...(root.value?.querySelectorAll<HTMLElement>('.lp-cue') ?? []),
      ...typings.keys(),
    ]
    cueIo = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return
        const el = e.target as HTMLElement
        el.classList.add('is-cued')
        typings.get(el)?.play()
        if (el === obCardEl.value) playObDemo()
        cueIo?.unobserve(el)
      })
    }, { threshold: 0, rootMargin: CUE_MARGIN })
    cues.forEach(el => cueIo?.observe(el))
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll)
  io?.disconnect()
  cueIo?.disconnect()
  barIo?.disconnect()
  capIo?.disconnect()
  obTimers.forEach(clearTimeout)
  obTimers = []
  typings.forEach(t => t.cancel())
  typings.clear()
  document.documentElement.style.scrollBehavior = ''
})
</script>
