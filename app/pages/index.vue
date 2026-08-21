<template>
  <div
    ref="root"
    class="lp lp-home"
    :class="{ 'is-stuck': stuck, 'is-anim': anim, 'is-menu-open': menuOpen }"
  >
    <!-- ══════════════════════════════════════════════════════════════
         導購頁。版面是「一段對話」：每一區的標題都是 MiniMe 開口講的一句話
         （綠氣泡＋頭像，見 _landing.scss 的 .lp-turn），底下是它端出來的東西。

         ⚠️ 兩件事會連坐別的頁面，動之前先看：
           1. 外殼類名（.lp-nav / .lp-brand / .lp-btn / .lp-wrap / .lp-foot）與三個法務頁
              共用（components/site/SiteLegalPage.vue）——只在首頁生效的東西掛 .lp-home。
           2. #value / #diff / #pricing / #faq 這四個 id 是頁尾與法務頁的連結目標
              （SiteFooter.vue 的「產品介紹／功能比較／定價／常見問題」），換 id 會變死連結。

         ⛔ 還沒上線的功能一律掛「即將推出」（.lp-soon）並在區塊底下用一行圖說講清楚
            哪一半是現有的。目前掛著的有三處：節慶提案卡、自動化行銷示意、圖文選單代設。
            要拿掉徽章之前，先確認功能真的上線了（判斷依據見 docs/STATUS.md）。
         ⚠️ 區塊底色是**交錯**的：白 → 灰 → 白 → 灰⋯⋯（灰的那幾區掛 .lp-section--tint）。
            新增或搬動區塊時要跟著調，不然會出現兩個同色區塊相鄰、看起來像漏了一段。
            目前順序：Hero(白) fix(灰) why(白) fast(灰) value(白) diff(灰) pricing(白)
            grow(灰) faq(白) signup(灰) 收尾CTA(綠)。
         ⛔ 退費措辭只有一種寫法：「不綁約、隨時可取消，取消後服務用到本期結束」。
            不可以寫成「隨時可退」「前 N 天免費」——實際政策沒有退現金也沒有試用期，
            寫了就是對消費者的不實承諾（政策原文見 pages/refund.vue）。
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
          <a href="#fix" @click="closeMenu">怎麼幫你</a>
          <a href="#why" @click="closeMenu">為什麼卡住</a>
          <a href="#value" @click="closeMenu">能做什麼</a>
          <a href="#pricing" @click="closeMenu">定價</a>
          <a href="#faq" @click="closeMenu">常見問題</a>
        </div>
        <div class="lp-nav__right">
          <NuxtLink to="/login" class="lp-nav__signin">登入</NuxtLink>
          <NuxtLink class="lp-btn lp-btn--primary lp-btn--sm" to="/login">免費註冊</NuxtLink>
          <button class="lp-nav__burger" aria-label="選單" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen"><span /></button>
        </div>
      </div>
    </nav>

    <!-- ── Hero ────────────────────────────────────────────────
         右邊放「接下來的行銷檔期」而不是產品畫面：那張卡裡沒有一個編造的數字，
         節日、日期與行銷切角全部來自 shared/taiwan-festivals.ts（系統本來就會在節前提醒老闆），
         所以它同時是主張的證據，也是現有功能的展示。
         ⛔ 別把「生日」「60 天沒回購」混進這張卡：那兩種時機目前偵測不到
            （客人資料沒有生日欄位，也沒有購買紀錄），混進來就是拿還沒有的東西當門面。 -->
    <header id="top" class="lp-hero">
      <span class="lp-hero__blob lp-hero__blob--1" />
      <span class="lp-hero__blob lp-hero__blob--2" />
      <div class="lp-wrap lp-hero__grid">
        <div class="lp-hero__text">
          <span class="lp-eyebrow">LINE 專用 · AI 客服與顧客經營</span>
          <h1>你的顧客，<br>其實很<span class="g">值錢</span>。</h1>
          <!-- 兩句各佔一行（手機收掉 br 自然流）：擠在同一段時「只是」會被拆開，
               行尾留一個「只」看起來像錯字 -->
          <p class="lp-hero__sub">
            品牌的 LINE 官方帳號有好多好友，<br>
            <b>卻不知道怎麼經營他們嗎？</b>
          </p>
          <div class="lp-hero__actions">
            <NuxtLink class="lp-btn lp-btn--primary" to="/login">免費註冊</NuxtLink>
            <a class="lp-btn lp-btn--ghost" href="#pricing">看定價 →</a>
          </div>
          <p class="lp-hero__fine">
            <b>1 分鐘</b>完成註冊 · 免費方案不用綁卡 · 付費每月 <b>NT${{ fmt(lowestPaidPrice) }} 起</b>
          </p>
        </div>

        <div class="lp-hero__visual">
          <div class="lp-panel lp-friends">
            <div class="lp-panel__hd">
              <span class="lp-panel__pip" />
              <span class="lp-panel__title">接下來可以把握的時機</span>
              <span class="lp-panel__meta">台灣節慶檔期</span>
            </div>
            <div class="lp-friends__list">
              <div
                v-for="(f, i) in heroFestivals"
                :key="f.id"
                class="lp-fr"
                :class="{ 'is-show': i < shownRows, 'lp-fr--soon': f.soon }"
              >
                <span class="lp-fr__txt"><b>{{ f.name }} {{ f.md }}</b><small>{{ f.angle }}</small></span>
                <span class="lp-fr__meta">
                  <span class="lp-fr__tag" :class="f.soon ? 'lp-fr__tag--soon' : 'lp-fr__tag--plan'">{{ f.badge }}</span>
                </span>
              </div>
            </div>
            <div class="lp-friends__foot">
              未來一年還有 <b>{{ festivalsAheadShown }}</b> 個檔期，可以跟他們說說話
            </div>
          </div>
          <p class="lp-figcap">檔期表由系統內建，快到了會主動提醒你。</p>
        </div>
      </div>
    </header>

    <!-- ── 它先開口：節慶提案 ──────────────────────────────────
         整區的主張是「它不是等你下指令，是它先開口」。
         ⚠️ 節日／日期／切角是真的（節慶表），兩個客群的人數與訊息是示意，
            而且「自動分客群＋代擬訊息＋一鍵採用」還沒上線 → 卡片掛「即將推出」。 -->
    <section id="fix" class="lp-section lp-section--tint">
      <div class="lp-wrap">
        <div class="lp-turn lp-reveal">
          <span class="lp-turn__ava"><BrandLogo mark on-color alt="" /></span>
          <div class="lp-bubble">
            <h2>你需要一個最懂你的 <span class="lp-nb"><BrandLogo class="lp-bubble__logo" :alt="brandName" />，</span>幫你管理他們。</h2>
            <p v-if="proposal">就拿{{ proposal.days <= 30 ? '快到的' : '下一個' }}{{ proposal.name }}來說——它會先開口，而且連要對誰說什麼都想好了。</p>
          </div>
        </div>

        <div v-if="proposal" class="lp-stack lp-reveal">
          <div class="lp-panel">
            <div class="lp-panel__hd">
              <span class="lp-panel__pip lp-panel__pip--soon" />
              <span class="lp-panel__title">{{ proposal.name }}檔期提案</span>
              <span class="lp-panel__meta">{{ proposal.md }} · 建議 {{ proposal.startMd }} 前送出</span>
              <span class="lp-soon">即將推出</span>
            </div>
            <div class="lp-panel__bd">
              <div v-for="g in proposal.groups" :key="g.who" class="lp-prop">
                <div class="lp-prop__hd">
                  <span class="lp-prop__who">{{ g.who }}</span>
                  <span class="lp-prop__n">{{ g.n }} 位</span>
                </div>
                <p class="lp-prop__angle">切角：{{ g.angle }}</p>
                <p class="lp-prop__msg">「{{ g.msg }}」</p>
              </div>
              <!-- ⛔ 這兩顆是 <span> 不是 <button>：門面上不放按不動的按鈕。
                   真正的行動鈕在下面的 .lp-prop__cta。 -->
              <div class="lp-prop__foot">
                <span class="lp-prop__act lp-prop__act--yes">就照這個做</span>
                <span class="lp-prop__act lp-prop__act--edit">我想改一下</span>
                <span class="lp-prop__note">改完它會記住你的口味，下次照你的習慣提案。</span>
              </div>
            </div>
          </div>
          <p class="lp-figcap">
            示意畫面：節日、日期與行銷切角出自系統內建的節慶表，<b>快到了會主動提醒你（現有功能）</b>；
            人數為示意，<b>自動分客群、代擬訊息與一鍵採用仍在開發中</b>。
          </p>
        </div>
      </div>
    </section>

    <!-- ── 為什麼卡住：四道牆 ──────────────────────────────────
         四個原因不是平等的：第一道（沒人手）是前提，另外三個是它的後果，
         所以第一張卡佔 1.45 倍寬並吃綠底（見 .lp-walls 註解）。 -->
    <section id="why" class="lp-section">
      <div class="lp-wrap">
        <div class="lp-turn lp-reveal">
          <span class="lp-turn__ava"><BrandLogo mark on-color alt="" /></span>
          <div class="lp-bubble">
            <!-- br 是為了不讓「多了」「少請」這種詞被折行拆開（中文可以斷在任何字之間）；
                 ≤720px 由 CSS 收掉，讓它自然流。 -->
            <h2>多一個 <span class="lp-nb"><BrandLogo class="lp-bubble__logo" :alt="brandName" />，</span><br>等於多了<span class="mark">半個客服、半個行銷</span>。</h2>
            <p>因為顧客經營這件事，本來就沒人做得起來——</p>
          </div>
        </div>
        <div class="lp-walls">
          <div
            v-for="(w, i) in WALLS"
            :key="w.title"
            class="lp-wall lp-reveal"
            :class="{ 'lp-wall--main': i === 0 }"
          >
            <span class="lp-wall__n">{{ i + 1 }}</span>
            <h3>{{ w.title }}</h3>
            <p>{{ w.sub }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- ── 60 秒上線 ───────────────────────────────────────────
         左＝你要準備什麼（兩樣）；右＝設定過程長什麼樣（真的有的對話式開通引導）。
         兩張卡吃同一個 --demo-h，標題才會落在同一條線上。 -->
    <section id="fast" class="lp-section lp-section--tint">
      <div class="lp-wrap">
        <div class="lp-turn lp-reveal">
          <span class="lp-turn__ava"><BrandLogo mark on-color alt="" /></span>
          <div class="lp-bubble">
            <h2>只要 <span class="mark">60 秒</span>，它就可以開始工作。</h2>
          </div>
        </div>
        <div class="lp-two">
          <div class="lp-panel lp-reveal">
            <div class="lp-panel__hd">
              <span class="lp-panel__pip" />
              <span class="lp-panel__title">你只需要準備兩樣</span>
              <span class="lp-panel__meta">60 秒</span>
            </div>
            <div class="lp-panel__bd">
              <div class="lp-mock lp-need">
                <div class="lp-need__i">
                  <span class="lp-need__ic" aria-hidden="true">@</span>
                  <span class="lp-need__t"><b>登入 Email</b><small>收開通連結</small></span>
                  <span class="lp-need__chk" aria-hidden="true">✓</span>
                </div>
                <div class="lp-need__i">
                  <span class="lp-need__ic lp-need__ic--brand"><BrandLogo mark on-color alt="" /></span>
                  <span class="lp-need__t"><b>你的 LINE 官方帳號</b><small>現在就有的那個</small></span>
                  <span class="lp-need__chk" aria-hidden="true">✓</span>
                </div>
                <p class="lp-need__note">就像去銀行開戶，只要身分證和手機號碼。</p>
              </div>
              <h3>不用先準備資料才能開始</h3>
              <p>Email 註冊、貼一組 Webhook 網址接上官方帳號，就可以開始設定。</p>
            </div>
          </div>

          <div class="lp-panel lp-reveal">
            <div class="lp-panel__hd">
              <span class="lp-panel__pip" />
              <span class="lp-panel__title">設定時</span>
              <span class="lp-panel__meta">全程有 AI 陪你</span>
            </div>
            <div class="lp-panel__bd">
              <div class="lp-mock lp-setup">
                <div class="lp-sd lp-sd--ai lp-d1">你的店叫什麼名字？</div>
                <div class="lp-sd lp-sd--me lp-d2">山丘咖啡</div>
                <div class="lp-sd lp-sd--ai lp-d3">好的。把菜單或官網給我，我自己讀 <span class="ok">✓</span></div>
                <div class="lp-sdbar lp-d4"><i /><span>設定完成 100%</span></div>
              </div>
              <h3>一步一步，跟著它做就好</h3>
              <p>用聊天的方式把設定做完，不用進後台一頁頁點。</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ── 能做什麼 ────────────────────────────────────────────
         ⚠️ id 沿用 #value：頁尾與法務頁的「產品介紹」都指這裡，換 id 會變死連結。 -->
    <section id="value" class="lp-section">
      <div class="lp-wrap">
        <div class="lp-turn lp-reveal">
          <span class="lp-turn__ava"><BrandLogo mark on-color alt="" /></span>
          <div class="lp-bubble">
            <h2><BrandLogo class="lp-bubble__logo" :alt="brandName" /> 每天可以幫你做這些事。</h2>
          </div>
        </div>

        <div class="lp-demos">
          <div class="lp-panel lp-demo lp-reveal">
            <div class="lp-panel__hd">
              <span class="lp-demo__k">1</span>
              <span class="lp-panel__title">自動化行銷</span>
              <span class="lp-soon">部分即將推出</span>
            </div>
            <div class="lp-panel__bd">
              <div class="lp-mock lp-stage">
                <div class="lp-seg"><span>買過禮盒</span><b>326 位</b></div>
                <div class="lp-seg"><span>{{ proposal?.name ?? '節慶' }} · 送禮客群</span><b>214 位</b></div>
                <div class="lp-seg"><span>60 天沒回購</span><b>142 位</b></div>
                <span class="lp-stage__go">訊息已排程，週三 10:00 送出</span>
              </div>
              <h3>名單自己分好，訊息按時送出</h3>
              <p>沒回購的、過節的、生日的，時間到自己送。送出前一律由你確認。</p>
            </div>
          </div>

          <div class="lp-panel lp-demo lp-reveal">
            <div class="lp-panel__hd">
              <span class="lp-demo__k">2</span>
              <span class="lp-panel__title">顧客貼標</span>
            </div>
            <div class="lp-panel__bd">
              <div class="lp-mock lp-stage">
                <div class="lp-prof"><span class="lp-prof__a" /><span><b>陳小姐</b><small>LINE 好友</small></span></div>
                <div class="lp-info"><span>買過</span><b>禮盒 ×2</b></div>
                <div class="lp-info"><span>客單價</span><b>NT$1,280</b></div>
                <div class="lp-info"><span>標籤</span><b>送禮客群</b></div>
              </div>
              <h3>誰是誰、買過什麼，自動記住</h3>
              <p>客服與行銷資料打通，同一位客人前後文都在，不再靠印象認人。</p>
            </div>
          </div>

          <div class="lp-panel lp-demo lp-reveal">
            <div class="lp-panel__hd">
              <span class="lp-demo__k">3</span>
              <span class="lp-panel__title">AI 客服</span>
            </div>
            <div class="lp-panel__bd">
              <div class="lp-mock lp-stage">
                <div class="lp-qa lp-qa--q">這款豆子適合手沖嗎？</div>
                <div class="lp-qa lp-qa--a">適合！中焙帶柑橘調，建議水溫 90–92°C</div>
                <span class="lp-stage__pill">已回覆 · 23:41</span>
              </div>
              <h3>半夜、假日，客人問了都有人回</h3>
              <p>客人問產品、問訂單，AI 依你上傳的知識庫即時回，答不了就轉真人。</p>
            </div>
          </div>
        </div>
        <!-- 三張卡都有具體數字，沒有這行會被當成真實客戶資料；同時交代第一張哪一半還沒上線 -->
        <p class="lp-figcap lp-figcap--center">
          示意畫面，數字非真實資料。<b>依標籤分眾、排程送出、送出前由你確認</b>都是現有功能；
          <b>自動判斷「60 天沒回購」與「本月壽星」仍在開發中</b>（客人資料目前沒有生日與購買紀錄）。
        </p>

        <!-- ── 圖文選單：客人手機上的前後對照 ── -->
        <div class="lp-stack lp-reveal">
          <div class="lp-panel">
            <div class="lp-panel__hd">
              <span class="lp-demo__k">4</span>
              <span class="lp-panel__title">LINE 下方的功能選單</span>
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
                        <div class="lp-pmsg lp-pmsg--me">有的，{{ proposal?.name ?? '節慶' }}禮盒已上架 ☕</div>
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
            </div>
          </div>
          <p class="lp-figcap lp-figcap--center">
            示意畫面。<b>選單現在就能在後台自己編排</b>；<b>用一句話請 {{ brandName }} 代設仍在開發中</b>。
          </p>
        </div>
      </div>
    </section>

    <!-- ── 差別 ────────────────────────────────────────────────
         右欄是浮起的勝方卡（超出表格上下緣），左欄樸素列舊做法。
         ⚠️ .lp-cmp__winner 的寬度是照 grid 欄位比例算的，改欄寬要一起改。
         ⛔ 右欄只能寫**現在真的做得到**的事：比較表是逐項對照，拿還沒上線的功能去比
            等於拿別人沒有的東西比我們也沒有的東西。 -->
    <section id="diff" class="lp-section lp-section--tint">
      <div class="lp-wrap">
        <div class="lp-turn lp-reveal">
          <span class="lp-turn__ava"><BrandLogo mark on-color alt="" /></span>
          <div class="lp-bubble">
            <h2>跟其他行銷工具，差在<span class="mark">這裡</span>。</h2>
            <p>差別不在功能多寡，在於哪些事還要你自己動手。</p>
          </div>
        </div>

        <div class="lp-cmp lp-reveal">
          <div class="lp-cmp__winner" aria-hidden="true" />
          <div class="lp-cmp__row lp-cmp__row--head">
            <div class="lp-cmp__dim">比較項目</div>
            <div class="lp-cmp__old">一般行銷工具</div>
            <!-- 這格底色是品牌綠，logotype 要用 on-color 轉白才讀得到 -->
            <div class="lp-cmp__new"><BrandLogo class="lp-cmp__logo" on-color /><span class="lp-cmp__tag">最省事</span></div>
          </div>
          <div v-for="row in COMPARISON" :key="row.dim" class="lp-cmp__row">
            <div class="lp-cmp__dim">{{ row.dim }}</div>
            <div class="lp-cmp__old"><span class="lp-cmp__x">✕</span>{{ row.old }}</div>
            <div class="lp-cmp__new"><span class="lp-cmp__v">✓</span>{{ row.mine }}</div>
          </div>
        </div>
      </div>
    </section>

    <!-- ── 定價 ────────────────────────────────────────────────
         先用「請人要多少錢」對比出量級，再往下才是方案目錄。
         方案卡、商品資訊、FAQ 都保留：售價階段要與向金流申報的一致，
         商品名稱／說明／售價／付款與發票必須集中在同一處（風控會逐項核對）。 -->
    <section id="pricing" class="lp-section">
      <div class="lp-wrap">
        <div class="lp-turn lp-reveal">
          <span class="lp-turn__ava"><BrandLogo mark on-color alt="" /></span>
          <div class="lp-bubble">
            <h2>一個月 <span class="mark">NT${{ fmt(lowestPaidPrice) }}</span> 起，<br>少請半個客服、半個行銷。</h2>
          </div>
        </div>

        <!-- ⛔ 這張卡刻意**沒有標頭列**：標頭原本寫「每月成本比較 · 示意估算」，但上面的區塊標題
             已經是「一個月 NT$399 起，少請半個客服、半個行銷」、底下的圖說也已經寫「示意、非實際
             報價」——再加一條標頭只是把同一句話講第三次。整頁的示意圖都套著同一款灰底標頭列，
             那是後台控制台的樣子，門面上能省的就要省。 -->
        <div class="lp-panel lp-panel--plain lp-reveal">
          <div class="lp-panel__bd">
            <div class="lp-sal">
              <div class="lp-sal__who">半個客服<small>回訊息 · 查訂單</small></div>
              <div class="lp-sal__bar"><i class="is-hi" style="--w: 88%" /></div>
              <div class="lp-sal__v is-hi">NT$20,000</div>
            </div>
            <div class="lp-sal">
              <div class="lp-sal__who">半個行銷<small>節慶檔期 · 分眾 · 推播</small></div>
              <div class="lp-sal__bar"><i class="is-hi" style="--w: 100%" /></div>
              <div class="lp-sal__v is-hi">NT$22,500</div>
            </div>
            <div class="lp-sal">
              <div class="lp-sal__who">{{ brandName }}<small>兩件事都做 · 24 小時</small></div>
              <div class="lp-sal__bar"><i class="is-lo" style="--w: 1.5%" /></div>
              <div class="lp-sal__v is-lo">NT${{ fmt(lowestPaidPrice) }}</div>
            </div>
          </div>
        </div>
        <p class="lp-figcap">薪資為台灣市場常見水準之示意，非實際報價；各方案功能與額度見下方。</p>

        <!-- 計費說明＋兩張方案卡＝一個置中的「方案」群組（別再拆開，理由見 _landing.scss 的 .lp-offer） -->
        <div class="lp-offer lp-reveal">
          <p class="lp-price__intro">
            每個帳號都有免費額度，用完才按 AI 回覆的則數計價。<b>額度用完時 AI 會先轉真人接手，不會自動扣款。</b>
          </p>

          <!-- 試銷期只主打免費與 399 兩張（見 FEATURED_PLAN_IDS）。
               進場效果掛在外層、不掛每張卡：手機上這排會橫向捲動，捲出畫面外的卡片
               永遠不會與 viewport 交會，掛在卡上會讓它們一直是透明的。
               ⛔ 2026-08-21 拍板：不加「NT$799 含完整 AI 客服」那段——沿用 08-14 的
                  「先隱藏、只 show 399」，而且 799 與 399 的實際差別是額度／席次／知識庫
                  份數與腳本自動化，399 本來就有 AI 客服，寫成「799 才有客服」是不實陳述。 -->
          <div class="lp-plans lp-plans--featured">
            <div
              v-for="p in featuredPlans"
              :key="p.id"
              class="lp-plan"
              :class="{ 'lp-plan--pro': p.price.unit }"
            >
              <span v-if="p.price.unit" class="lp-plan__ribbon">最受歡迎</span>
              <span class="lp-plan__name">{{ p.name }}</span>
              <div class="lp-plan__price">
                {{ p.price.amount }}<small v-if="p.price.unit">{{ p.price.unit }}</small>
              </div>
              <p class="lp-plan__for">{{ p.quota }}</p>
              <ul class="lp-plan__list">
                <li v-for="(feat, i) in p.features" :key="i" :class="{ 'is-off': !feat.on }">
                  <span class="tick">{{ feat.on ? '✓' : '✕' }}</span> {{ feat.label }}
                </li>
              </ul>
              <NuxtLink
                class="lp-btn lp-btn--block"
                :class="p.price.unit ? 'lp-btn--primary' : 'lp-btn--ghost'"
                to="/login"
              >{{ p.cta }}</NuxtLink>
            </div>
          </div>
        </div>

        <!-- 商品資訊：把「商品名稱／說明／售價／付款與發票」集中一處。
             信用卡收單的風控就是找這四項，散在行銷文案裡他們找不到（也是被退件的常見原因）。 -->
        <div class="lp-product lp-reveal">
          <h3 class="lp-product__h">商品資訊</h3>
          <dl class="lp-product__list">
            <div class="lp-product__row">
              <dt>商品名稱</dt>
              <dd><b>{{ serviceFullName }}</b></dd>
            </div>
            <div class="lp-product__row">
              <dt>商品說明</dt>
              <dd>讓 LINE 官方帳號的商家用戶透過本系統，導入自動化 AI 客服回覆，以及行銷與客戶關係管理(CRM)系統。以線上訂閱方式提供，無實體商品、不需運送。</dd>
            </div>
            <div class="lp-product__row">
              <dt>商品售價</dt>
              <dd>月租 {{ paidPriceList }}（新臺幣含稅價，以「LINE 官方帳號」為單位計價）；另有免費方案，企業需求為客製報價。</dd>
            </div>
            <div class="lp-product__row">
              <dt>付款與發票</dt>
              <!-- 帳單請款名稱要在這裡露出：風控找的就是這張卡，客人事後對帳也翻得到
                   （為什麼非講不可見 shared/billing/statement.ts）。 -->
              <dd>
                信用卡付款，由<b>統一金流 PAYUNi</b> 處理；付款完成後依法開立<b>電子發票</b>並寄到你的帳務信箱。<template v-if="cardStatementName">信用卡帳單上會顯示「<b>{{ cardStatementName }}</b>」（{{ companyName }}）。</template>
              </dd>
            </div>
            <div class="lp-product__row">
              <dt>銷售者</dt>
              <dd>{{ companyName }}（統一編號 {{ taxId }}）　客服電話 {{ phone }}　客服信箱 {{ email }}</dd>
            </div>
          </dl>
        </div>

        <!-- 付款方式、發票、含稅、計價單位都寫在上面的商品資訊卡了，這裡只補它沒講的 -->
        <p class="lp-price__fine lp-reveal">
          ＊不綁約、隨時可取消，取消後服務用到本期結束——詳見<NuxtLink to="/refund">退費與取消政策</NuxtLink>與<NuxtLink to="/terms">服務條款</NuxtLink>。
          試銷期方案與額度可能調整，實際以後台顯示為準。
        </p>
      </div>
    </section>

    <!-- ── 生意成長 ────────────────────────────────────────────
         兩條線：綠＝也經營舊客、灰＝只靠新客。示意模型，Y 軸刻意沒有刻度。
         顏色不是挑好看的，是量過對比度與色盲可辨識度才定的（見 _landing.scss 的 .lp-chart）。 -->
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
          <!-- 同上，刻意沒有標頭列：「營業額成長 · 示意模型」與圖說重複 -->
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
                  <!-- ⛔ 刻意只留一條基準線，不畫格線：Y 軸沒有刻度（示意模型沒有真實數字），
                       格線沒有東西可以對照，畫上去只是雜訊。 -->
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
         獨立成區，不要塞在定價底下：導覽列點「常見問題」會捲進價目表中間，
         而且六題只有兩題跟錢有關（其餘是資料安全、支援哪種帳號、怎麼轉真人）。 -->
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
                <div class="a">資料存在你自己的工作區，你擁有、可管理與刪除，我們不會另作他用。</div>
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

    <!-- ── 註冊三步 ────────────────────────────────────────────
         這三步是註冊後開通引導真的會問的三件事，不是行銷話術。 -->
    <section id="signup" class="lp-section lp-section--tint">
      <div class="lp-wrap">
        <div class="lp-reveal">
          <span class="lp-eyebrow">一分鐘註冊</span>
          <h2 class="lp-h2">而且註冊超簡單</h2>
          <p class="lp-lede">三個問題，一分鐘。你回答，它準備。</p>
        </div>
        <div class="lp-steps">
          <div class="lp-step lp-reveal">
            <div class="lp-step__n">1</div>
            <h3>你的店叫什麼名字</h3>
            <p>打上店名就好，之後隨時能改。</p>
          </div>
          <div class="lp-step lp-reveal">
            <div class="lp-step__n">2</div>
            <h3>給它菜單或官網</h3>
            <p>貼連結或上傳 PDF,AI 自己讀完建成知識庫。</p>
          </div>
          <div class="lp-step lp-reveal">
            <div class="lp-step__n">3</div>
            <h3>試著問它一句話</h3>
            <p>當一次客人，測測它答得好不好。</p>
          </div>
        </div>
        <div class="lp-signup__cta lp-reveal">
          <NuxtLink class="lp-btn lp-btn--primary" to="/login">免費註冊</NuxtLink>
          <span class="lp-signup__fine">免綁約 · 免信用卡 · 用你現有的 LINE 官方帳號開通</span>
        </div>
      </div>
    </section>

    <!-- ── 收尾 CTA ────────────────────────────────────────────
         2026-08-14 拍板把「預約 Demo」表單整區拿掉：主要動線已是免費註冊，
         企業方案卡也不再露出（只主打 399），那張表單失去唯一的必要用途。
         想找人談的路徑改成頁尾的客服電話／信箱＋這裡的來信洽詢。
         ⛔ 頁尾原本的 /#demo 連結已一併移除，不要留死錨點。 -->
    <section class="lp-section lp-cta">
      <span class="lp-cta__blob lp-cta__blob--1" />
      <span class="lp-cta__blob lp-cta__blob--2" />
      <div class="lp-wrap lp-cta__in">
        <h2>下一個時機，<br>就從今天開始。</h2>
        <p class="lp-cta__sub">你的顧客已經在 LINE 裡。用你現有的官方帳號開通，一分鐘完成。</p>
        <div class="lp-cta__actions">
          <NuxtLink class="lp-btn lp-btn--white" to="/login">免費註冊</NuxtLink>
          <a class="lp-cta__talk" :href="emailHref">想先聊聊？寄信給我們 →</a>
        </div>
        <ul class="lp-rr">
          <li><span class="tick">✓</span> 免費方案不用綁卡</li>
          <li><span class="tick">✓</span> 不綁約，隨時停用</li>
          <li><span class="tick">✓</span> 資料你擁有</li>
          <li><span class="tick">✓</span> 1 分鐘完成註冊</li>
        </ul>
      </div>
    </section>

    <!-- ── Footer（公司資訊／客服窗口／政策條款，與法務頁共用同一個元件）── -->
    <SiteFooter />

    <!-- ── 黏性行動條（捲離 Hero 之後升起）──────────────────────
         收起時 aria-hidden：不然螢幕閱讀器會在頁尾唸到一顆看不見的註冊鈕。 -->
    <div class="lp-stickybar" :class="{ 'is-show': barShown }" :aria-hidden="barShown ? undefined : 'true'">
      <div class="lp-stickybar__in">
        <span class="lp-stickybar__t1">多半個客服＋半個行銷 · NT${{ fmt(lowestPaidPrice) }}／月</span>
        <span class="lp-stickybar__t2">1 分鐘完成註冊 · 免綁約</span>
        <NuxtLink class="lp-btn lp-btn--primary lp-btn--sm" to="/login" :tabindex="barShown ? undefined : -1">免費註冊</NuxtLink>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { BILLING_PLAN_ORDER, BILLING_PLANS, FEATURED_PLAN_IDS, type BillingPlan, type BillingPlanId } from '~~/shared/billing/plans'
import { TAIWAN_FESTIVALS } from '~~/shared/taiwan-festivals'
import { addDays, daysBetween, taipeiDate } from '~~/shared/time'

definePageMeta({ layout: false })

// 品牌／產品／公司／客服窗口統一由這裡來（與法務頁、頁尾同一份來源）。
// ⚠️ brandName = 品牌／產品名（MiniMe）、companyName = 營運主體（麥菲爾股份有限公司），別混用。
// ⚠️ 行銷文案裡寫「Mini Me」（有空格）的地方一律用 brandName 代入：商標、電子發票品名、
//    向 PAYUNi 申報的商品名都是無空格的 MiniMe，門面自己寫另一種拼法會對不起來。
const { brandName, serviceFullName, companyName, taxId, phone, email, emailHref, cardStatementName } = useSiteIdentity()

const plusIcon
  = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 3v12M3 9h12"/></svg>'

/** 千分位。刻意不用 toLocaleString：SSR（Node ICU）與瀏覽器可能給出不同字串，會造成 hydration 不一致。 */
function fmt(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// ── 定價卡：直接讀 shared/billing/plans.ts（單一事實來源），改價只動那份、不用改門面 ──
function priceText(p: BillingPlan): { amount: string, unit: string } {
  if (p.priceMonthly === null) return { amount: '面談', unit: '' }
  if (p.priceMonthly === 0) return { amount: '免費', unit: '' }
  return { amount: `NT$${fmt(p.priceMonthly)}`, unit: '／月' }
}

function quotaText(p: BillingPlan): string {
  if (p.answeredQuota === null) return '客製 AI 回覆額度'
  return `每月 ${fmt(p.answeredQuota)} 則 AI 回覆`
}

/**
 * 方案卡的功能列。**每張卡都列出同一組項目**，有的打勾、沒有的打叉。
 *
 * 為什麼不是「只列有的」：那樣各卡行數不一樣，兩張並排時行數少的那張會在
 * 按鈕上方空一大塊（實測免費卡空了 60px、輕量卡只空 22px）。行數一致還有個好處——
 * 一眼看得出升級到底多拿到什麼，不用左右來回比對。
 *
 * 只列出「檯面上至少有一個方案具備」的項目：兩張卡都沒有的（例如目前的腳本自動化）
 * 全列 ✕ 只是徒增行數，不放。
 */
type PlanFeature = { label: string, on: boolean }

function featureRows(p: BillingPlan, showBroadcast: boolean): PlanFeature[] {
  const f: PlanFeature[] = [
    { label: p.seats === null ? '團隊席次不限' : `團隊 ${p.seats} 席`, on: true },
    { label: p.knowledgeSources === null ? '知識庫資料不限' : `知識庫 ${p.knowledgeSources} 份資料`, on: true },
  ]
  if (showBroadcast) {
    const b = p.broadcast === 'advanced' ? '進階分眾推播' : '基礎推播'
    f.push({ label: b, on: p.broadcast === 'basic' || p.broadcast === 'advanced' })
  }
  if (p.scripting) f.push({ label: '腳本自動化', on: true })
  if (p.reports === 'export') f.push({ label: '報表匯出', on: true })
  else if (p.reports === 'advanced') f.push({ label: '進階數據報表', on: true })
  if (p.api) f.push({ label: 'API 串接', on: true })
  return f
}

// 對外方案（排除 test/internal 與未向金流申報售價的 landingHidden）。
const publicPlans = computed(() =>
  BILLING_PLAN_ORDER
    .map(id => BILLING_PLANS[id])
    .filter(p => !p.internal && !p.landingHidden)
    .map(p => ({
      id: p.id,
      name: p.name,
      price: priceText(p),
      quota: quotaText(p),
      plan: p,
      custom: p.custom,
      // 全站 CTA 用詞統一「免費註冊」：所有按鈕都通往 /login，不要兩個名字
      cta: '免費註冊',
    })),
)

/**
 * 試銷期只主打免費＋399（2026-08-14 老闆拍板：只 show 399，2026-08-21 再次確認）。
 *
 * 清單本體在 shared/billing/plans.ts 的 `FEATURED_PLAN_IDS`——升級對話框也吃同一份，
 * 別在頁面層級另開清單（2026-08-17 就是因為各維護各的，付款彈窗漏改被老闆抓到）。
 *
 * ⛔ 這是**行銷展示**的取捨，跟「有沒有向金流申報」是兩回事，所以不要改 plans.ts 的
 *    `landingHidden` 來達成——那個旗標的意思是「這個價格沒申報、不可以出現在官網」。
 */
const featuredPlans = computed(() => {
  const picked = publicPlans.value.filter(p => FEATURED_PLAN_IDS.includes(p.id as BillingPlanId))
  // 只要檯面上有任何一個方案含推播，每張卡都列這一行（沒有的打叉），行數才會一致
  const showBroadcast = picked.some(p => p.plan.broadcast === 'basic' || p.plan.broadcast === 'advanced')
  return picked.map(p => ({ ...p, features: featureRows(p.plan, showBroadcast) }))
})

/**
 * 商品資訊要揭露的售價：跟著檯面上在賣的（`FEATURED_PLAN_IDS`）。
 *
 * ⚠️ 這是刻意的取捨，不是漏寫：風控的紅線是「門面出現**未申報**的價格」，
 *    列得比申報少不踩線，列得比申報多才會被退件。但 799 / 1,499 在 plans.ts 仍是
 *    可自助結帳的方案（系統收得到、官網沒寫），要真正停售見 STATUS `D-14`。
 */
const paidPriceList = computed(() =>
  featuredPlans.value
    .filter(p => p.price.unit) // 有「／月」單位 = 付費方案（免費與面談沒有）
    .map(p => p.price.amount)
    .join('／'),
)

// 「一個月 399 起」的 399 也讀 plans.ts，不寫死——調價時 Hero、定價區、黏性條會一起對。
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

/**
 * 比較表：左欄講舊做法、右欄講我們怎麼做。
 * ⛔ 每一列都要是「同一件事的兩種做法」，不要放我們有、對手沒有的功能清單——那是型錄不是比較。
 * ⛔ 右欄只能寫**現在真的做得到**的事：所以沒有「它先開口幫你擬好訊息」那一列
 *    （那是節慶提案，還沒上線，掛在 #fix 的即將推出卡上）。
 */
/* ⛔ 這裡刻意**沒有 icon 欄位**：原本每一列前面掛一顆 Element Plus 的線性圖示（齒輪／時鐘／
   對話框⋯⋯），但①那六顆灰色小圖示沒有帶任何資訊，項目名本身就講完了 ②它們是全頁唯一的
   「單線灰色圖示」家族，與全頁的標記系統（只有數字方磚）不同調。
   拿掉之後這頁連 Element Plus 都不需要了（見標記系統的註解）。 */
const COMPARISON = [
  { dim: '開始設定', old: '從零建規則、自己拉流程', mine: '有 AI 陪你聊完，設定自動到位' },
  { dim: '上線要多久', old: '導入排程動輒兩三週', mine: '貼一組 Webhook 網址就接通' },
  { dim: '客服誰回', old: '你自己回，或再買一套客服工具', mine: 'AI 依你的知識庫即時回，需要時轉真人' },
  { dim: '名單怎麼分', old: '自己下條件、自己拉名單', mine: '依標籤自動分眾，排程按時送出' },
  { dim: '回答準不準', old: '罐頭關鍵字，常答非所問', mine: '只依你上傳的內容回答，不亂編' },
  { dim: '每月要多少', old: '數千元起，還要有人學、有人顧', mine: `NT$${fmt(lowestPaidPrice.value)} 起，免費方案不用綁卡` },
]

/**
 * 為什麼顧客經營一直沒做起來：四道牆（訪談歸納，第一道是前提、另外三道是它的後果）。
 */
const WALLS = [
  { title: '沒有人可以做', sub: '員工就是這麼多，每個人手上都滿了。' },
  { title: '派了人，還要顧他的情緒', sub: '多一件事，就是多一次溝通。' },
  { title: '自己動手，後台太複雜', sub: '打開來一堆設定，不知道從哪開始。' },
  { title: '找工具，一個月好幾千', sub: '買了還是得有人學、有人顧。' },
]

// ══════════════════════════════════════════════════════════════
//  節慶檔期（Hero 清單與 #fix 提案卡）
//
//  資料來源＝ shared/taiwan-festivals.ts，也就是系統真的用來提醒老闆的那張表。
//  ⛔ 別在這裡另外寫一份節日清單：那張表加減節日時，門面要自己跟上。
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

/** Hero 清單：接下來五個檔期。7 天內＝系統開始提醒的門檻（FESTIVAL_REMIND_DAYS 的最大值），標琥珀。 */
const heroFestivals = computed(() =>
  upcoming.value.slice(0, 5).map(f => ({
    id: f.id,
    name: f.name,
    md: monthDay(f.date),
    angle: f.angle,
    soon: f.days <= 7,
    badge: f.days === 0 ? '今天' : f.days === 1 ? '明天' : `還有 ${f.days} 天`,
  })),
)

/** 未來一年還有幾個檔期。節日表排到 2027 年底，所以這個數字在 2026 年內都是完整的。 */
const festivalsAhead = computed(() => upcoming.value.filter(f => f.days <= 365).length)

/**
 * #fix 提案卡用的節日：接下來第一個「送禮檔期」。
 *
 * 為什麼挑送禮檔期而不是單純的下一個節日：卡片裡那兩句示範訊息講的是送禮
 * （幫他挑、幫他準備），套到中元節或國慶日會語意不通。
 * 為什麼不寫死一個節日：寫死的例子會過期——2026-08 寫「父親節」，到了九月就變成
 * 在講一個已經過完的節日。名稱與日期都從表裡拿，訊息模板套進去，就不會有這個問題。
 */
const proposal = computed(() => {
  const f = upcoming.value.find(x => /送禮|禮盒|伴手禮|禮物|紅包/.test(x.angle)) ?? upcoming.value[0]
  if (!f) return null
  const md = monthDay(f.date)
  return {
    name: f.name,
    md,
    days: f.days,
    // 建議開跑日＝節前 7 天，與系統第一次提醒的時間點一致
    startMd: monthDay(addDays(f.date, -7)),
    groups: [
      {
        who: '買過禮盒的老客',
        n: 214,
        angle: '他去年送過，今年大概還會再送一次',
        msg: `${f.name}快到了。去年您挑的那款禮盒今年也備好了，${md} 前下單可以指定到貨日。`,
      },
      {
        who: '還沒買過的新朋友',
        n: 86,
        angle: '第一次送禮，需要有人幫他挑',
        msg: `${f.name}要送什麼好？我們把最常被選的三個組合整理好了，照預算挑就可以，不用自己比。`,
      },
    ],
  }
})

// ── 互動（進場效果、名單逐列浮現、數字跳動、黏性條）──
// 伺服器端與「減少動態效果」時直接給最終狀態（初值就是全部顯示、數字就是終值），
// 所以沒有 JS 也讀得到完整內容。
const HERO_ROWS = 5
const shownRows = ref<number>(HERO_ROWS)
const festivalsAheadShown = ref<number>(0)
watchEffect(() => { festivalsAheadShown.value = festivalsAhead.value })

const root = ref<HTMLElement | null>(null)
const stuck = ref(false)
const anim = ref(false)
const menuOpen = ref(false)
const barShown = ref(false)

function closeMenu() { menuOpen.value = false }
function onScroll() { stuck.value = window.scrollY > 8 }

let io: IntersectionObserver | undefined
let barIo: IntersectionObserver | undefined
let listTimers: ReturnType<typeof setTimeout>[] = []
let countRaf = 0

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

    // 檔期一列一列進來，跑完再讓「還有幾個檔期」往上數——先看到時機，再看到數量才有衝擊
    shownRows.value = 0
    for (let i = 0; i < HERO_ROWS; i++) {
      listTimers.push(setTimeout(() => { shownRows.value = i + 1 }, 420 + i * 230))
    }
    listTimers.push(setTimeout(countUpAhead, 420 + HERO_ROWS * 230 + 300))
  })
})

function countUpAhead() {
  const target = festivalsAhead.value
  const start = performance.now()
  const dur = 1100
  festivalsAheadShown.value = 0
  const tick = (t: number) => {
    const p = Math.min(1, (t - start) / dur)
    festivalsAheadShown.value = Math.round(target * (1 - (1 - p) ** 3))
    if (p < 1) countRaf = requestAnimationFrame(tick)
  }
  countRaf = requestAnimationFrame(tick)
}

onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll)
  io?.disconnect()
  barIo?.disconnect()
  listTimers.forEach(clearTimeout)
  listTimers = []
  if (countRaf) cancelAnimationFrame(countRaf)
  document.documentElement.style.scrollBehavior = ''
})
</script>
