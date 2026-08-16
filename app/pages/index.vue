<template>
  <div
    ref="root"
    class="lp lp-home"
    :class="{ 'is-stuck': stuck, 'is-anim': anim, 'is-menu-open': menuOpen }"
  >
    <!-- 頭像的照片與退路都做在 CSS 背景（見 .lp-fr__ava）：照片一層疊在人形剪影上，
         檔案還沒放（404）時那一層不繪製，剪影自然透出來，不需要 JS 也不會有破圖。
         ⛔ 別改回 <img>＋@error：圖片是 SSR 出去的，404 早於 Vue 掛載，監聽器還沒接上（實測不生效）。
         照片規格與**授權要求**見 public/avatars/README.md。
         ⛔ 照片是佔位人像：卡片上的名字與訊息都是編的（下方已標「示意畫面」），
            不可以在旁邊加「某某店家實際使用」這類說法，那會變成沒有本人同意的掛名推薦。 -->
    <!-- ── Nav ─────────────────────────────────────────────
         外殼（.lp-nav / .lp-brand / .lp-btn）與法務頁的 SiteLegalPage 共用，
         這裡只換錨點標籤與 CTA 文案，不動結構，免得改壞那三頁。 -->
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
          <a href="#value" @click="closeMenu">產品</a>
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

    <!-- ── Hero ────────────────────────────────────────────
         主張＝「你已經有的名單很值錢，只是沒人經營」。
         右邊刻意不放產品畫面，放「一份躺著沒動的好友名單」——那是店主自己的現況。 -->
    <header id="top" class="lp-hero">
      <span class="lp-hero__blob lp-hero__blob--1" />
      <span class="lp-hero__blob lp-hero__blob--2" />
      <div class="lp-wrap lp-hero__grid">
        <div class="lp-hero__text">
          <!-- 品牌名已在正上方的 nav 商標，這裡不再重複，只講產品定位 -->
          <span class="lp-eyebrow">LINE AI 客服 · CRM · 再行銷</span>
          <h1>你的顧客，<br>其實很<span class="g">值錢</span></h1>
          <!-- 兩句各佔一行（手機收掉 br 自然流）：擠在同一段時「只是」會被拆開，
               行尾留一個「只」看起來像錯字 -->
          <p class="lp-hero__sub">
            你的品牌 LINE 官方帳號已經有好多好友，<br>
            <b>只是還不知道怎麼經營他們。</b>
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
              <span class="lp-panel__title">好友名單</span>
              <span class="lp-panel__meta">{{ fmt(FRIEND_TOTAL) }} 位好友</span>
            </div>
            <div class="lp-friends__list">
              <div
                v-for="(f, i) in FRIENDS"
                :key="f.name"
                class="lp-fr"
                :class="{ 'is-show': i < shownFriends }"
              >
                <!-- 照片走 CSS 背景圖層而不是 <img>：載不到時背景層不繪製、直接透出底下的剪影，
                     用 <img> 的話 Chrome 會在 alt="" 上再畫一個破圖圖示（實測過）。 -->
                <span class="lp-fr__ava" :style="{ backgroundColor: f.color, '--photo': AVATAR_PHOTOS_READY ? `url(${f.photo})` : undefined }" />
                <span class="lp-fr__txt"><b>{{ f.name }}</b><small>{{ f.msg }}</small></span>
                <span class="lp-fr__meta">
                  <span class="lp-fr__ago">{{ f.ago }}</span>
                  <span class="lp-fr__tag" :class="`lp-fr__tag--${f.tag}`">{{ TAG_TEXT[f.tag] }}</span>
                </span>
              </div>
            </div>
            <div class="lp-friends__foot">
              <b>{{ fmt(sleepShown) }}</b> 位超過 60 天沒有互動
            </div>
          </div>
          <p class="lp-figcap">示意畫面：名單躺在那裡，就只是名單。</p>
        </div>
      </div>
    </header>

    <!-- ── 卡在哪 ──────────────────────────────────────────
         不列我們歸納的名詞，列店主自己會講的三句話——比較容易對號入座。 -->
    <section id="why" class="lp-section">
      <div class="lp-wrap">
        <div class="lp-reveal">
          <span class="lp-eyebrow lp-eyebrow--plain">你不是不想做，是每次都卡住</span>
          <h2 class="lp-h2">其實你也知道要經營，<br>只是動手時總卡在同一個地方</h2>
        </div>
        <div class="lp-cards3">
          <div v-for="b in BLOCKERS" :key="b.title" class="lp-pcard lp-reveal">
            <div class="lp-pcard__ic"><el-icon><component :is="b.icon" /></el-icon></div>
            <h3>{{ b.title }}</h3>
            <p>「{{ b.quote }}」</p>
          </div>
        </div>
        <div class="lp-note lp-reveal">
          <span class="q"><el-icon><ChatLineRound /></el-icon></span>
          <span>這三件事 {{ brandName }} 都接手：<b>設定陪你聊完、名單自己分、訊息按時送。</b></span>
        </div>
      </div>
    </section>

    <!-- ── 怎麼變簡單 ──────────────────────────────────────
         左卡＝現在就有的（對話式開通引導）；右卡＝還沒上線的幕僚模式，
         所以掛「即將推出」，不能當現有功能賣。 -->
    <section id="easy" class="lp-section">
      <div class="lp-wrap">
        <div class="lp-reveal">
          <span class="lp-eyebrow">不用自己摸後台</span>
          <h2 class="lp-h2">設定跟著 AI 聊完就好</h2>
          <p class="lp-lede">開通時它陪你一步一步做完；做完之後，換它主動告訴你現在可以做什麼。</p>
        </div>
        <div class="lp-two">
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

          <div class="lp-panel lp-reveal">
            <div class="lp-panel__hd">
              <span class="lp-panel__pip lp-panel__pip--soon" />
              <span class="lp-panel__title">設定完成後</span>
              <span class="lp-soon">即將推出</span>
            </div>
            <div class="lp-panel__bd">
              <!-- 只留一張建議示意：這是還沒上線的功能，不該跟左邊已上線的拿同樣版位 -->
              <div class="lp-mock lp-adv">
                <div class="lp-adv__c lp-d1">
                  <span class="t">今天可以做這件事</span>
                  <span class="q">有 <b>142 位</b>老客超過 60 天沒回購，喚回訊息我擬好了。</span>
                  <span class="lp-adv__btn">要 · 不要</span>
                </div>
              </div>
              <h3>它會告訴你，現在可以怎麼做</h3>
              <p>AI 主動把該做的事端到你面前，你只要決定要或不要。</p>
            </div>
          </div>
        </div>
        <p class="lp-figcap lp-figcap--center">
          「設定完成後」的主動建議仍在開發中，其餘為現有功能。
        </p>
      </div>
    </section>

    <!-- ── 做什麼 ──────────────────────────────────────────
         id 沿用 #value：頁尾與法務頁的「產品介紹」都指這裡，換 id 會變死連結。 -->
    <section id="value" class="lp-section">
      <div class="lp-wrap">
        <div class="lp-reveal">
          <span class="lp-eyebrow">從接客服一路做到養熟客</span>
          <h2 class="lp-h2">具體幫你做三件事</h2>
          <p class="lp-lede">客服、行銷、客戶資料三件事層層遞進——每一件都有功能實際在幫你動手。</p>
        </div>

        <div class="lp-demos">
          <div class="lp-panel lp-demo lp-reveal">
            <div class="lp-panel__hd">
              <span class="lp-demo__k">1</span>
              <span class="lp-panel__title">AI 客服</span>
            </div>
            <div class="lp-panel__bd">
              <div class="lp-mock lp-stage">
                <div class="lp-qa lp-qa--q">這款豆子適合手沖嗎？</div>
                <div class="lp-qa lp-qa--a">適合！中焙帶柑橘調，建議水溫 90–92°C</div>
                <span class="lp-stage__pill">已回覆 · 23:41</span>
              </div>
              <h3>半夜、假日，它都在</h3>
              <p>客人問產品、問訂單，AI 依你上傳的知識庫即時回，答不了就轉真人。</p>
            </div>
          </div>

          <div class="lp-panel lp-demo lp-reveal">
            <div class="lp-panel__hd">
              <span class="lp-demo__k">2</span>
              <span class="lp-panel__title">自動化行銷</span>
            </div>
            <div class="lp-panel__bd">
              <div class="lp-mock lp-stage">
                <div class="lp-seg"><span>60 天沒回購</span><b>142 位</b></div>
                <div class="lp-seg"><span>生日在本月</span><b>12 位</b></div>
                <div class="lp-seg"><span>買過禮盒</span><b>326 位</b></div>
                <span class="lp-stage__go">訊息已排程，週三 10:00 送出</span>
              </div>
              <h3>名單自己分好，訊息按時送出</h3>
              <p>依行為與興趣自動分眾，對的訊息送給對的人。送出前一律由你確認。</p>
            </div>
          </div>

          <div class="lp-panel lp-demo lp-reveal">
            <div class="lp-panel__hd">
              <span class="lp-demo__k">3</span>
              <span class="lp-panel__title">客戶貼標</span>
            </div>
            <div class="lp-panel__bd">
              <div class="lp-mock lp-stage">
                <div class="lp-prof"><span class="lp-prof__a" /><span><b>陳小姐</b><small>LINE 好友</small></span></div>
                <div class="lp-info"><span>買過</span><b>日出配方 ×3</b></div>
                <div class="lp-info"><span>客單價</span><b>NT$1,280</b></div>
                <div class="lp-info"><span>標籤</span><b>手沖愛好者</b></div>
              </div>
              <h3>聊過、買過的，自動記進名片</h3>
              <p>客服與行銷資料打通，同一位客人前後文都在，不再靠印象認人。</p>
            </div>
          </div>
        </div>
        <!-- 三張卡上都有具體數字（142 位／NT$1,280／23:41），沒有這行會被當成真實客戶資料 -->
        <p class="lp-figcap lp-figcap--center">
          示意畫面，數字非真實資料。行銷訊息送出前一律由你確認。
        </p>
      </div>
    </section>

    <!-- ── 為什麼不是「又一套 LINE 工具」────────────────────
         右欄是浮起的勝方卡（超出表格上下緣），左欄樸素列舊做法。
         ⚠️ .lp-cmp__winner 的寬度是照 grid 欄位比例算的，改欄寬要一起改。 -->
    <section id="diff" class="lp-section">
      <div class="lp-wrap">
        <div class="lp-reveal">
          <span class="lp-eyebrow lp-eyebrow--plain">為什麼不是「又一套 LINE 工具」</span>
          <h2 class="lp-h2">同樣要做的事，<br>{{ brandName }} 連「設定的工」也幫你做掉</h2>
          <p class="lp-lede">差別不在功能多寡，在於哪些事要你自己動手。</p>
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
            <div class="lp-cmp__dim"><span class="lp-cmp__ic"><el-icon><component :is="row.icon" /></el-icon></span>{{ row.dim }}</div>
            <div class="lp-cmp__old"><span class="lp-cmp__x">✕</span>{{ row.old }}</div>
            <div class="lp-cmp__new"><span class="lp-cmp__v">✓</span>{{ row.mine }}</div>
          </div>
        </div>
      </div>
    </section>

    <!-- ── 定價 ────────────────────────────────────────────
         先用「請人要多少錢」對比出量級，再往下才是方案目錄。
         方案卡、商品資訊、FAQ 都保留：售價階段要與向金流申報的一致，
         商品名稱／說明／售價／付款與發票必須集中在同一處（風控會逐項核對）。 -->
    <section id="pricing" class="lp-section">
      <div class="lp-wrap">
        <div class="lp-reveal">
          <span class="lp-eyebrow">定價</span>
          <h2 class="lp-h2">一個月 NT${{ fmt(lowestPaidPrice) }} 起，<br>少請半個客服、半個行銷</h2>
        </div>

        <div class="lp-panel lp-reveal">
          <div class="lp-panel__hd">
            <span class="lp-panel__pip" />
            <span class="lp-panel__title">每月成本比較</span>
            <span class="lp-panel__meta">示意估算</span>
          </div>
          <div class="lp-panel__bd">
            <div class="lp-sal">
              <div class="lp-sal__who">半個客服<small>回訊息 · 查訂單</small></div>
              <div class="lp-sal__bar"><i class="is-hi" style="--w: 88%" /></div>
              <div class="lp-sal__v is-hi">NT$20,000</div>
            </div>
            <div class="lp-sal">
              <div class="lp-sal__who">半個行銷<small>分眾 · 推播 · 檔期</small></div>
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
             永遠不會與 viewport 交會，掛在卡上會讓它們一直是透明的。 -->
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

    <!-- ── 常見問題 ────────────────────────────────────────
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

    <!-- ── 註冊三步 ────────────────────────────────────────
         這三步是註冊後開通引導真的會問的三件事，不是行銷話術。 -->
    <section id="signup" class="lp-section">
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

    <!-- ── 收尾 CTA ────────────────────────────────────────
         2026-08-14 拍板把「預約 Demo」表單整區拿掉：主要動線已是免費註冊，
         企業方案卡也不再露出（只主打 399），那張表單失去唯一的必要用途。
         想找人談的路徑改成頁尾的客服電話／信箱＋定價區下方那行來信洽詢。
         ⛔ 頁尾原本的 /#demo 連結已一併移除，不要留死錨點。 -->
    <section class="lp-section lp-cta">
      <span class="lp-cta__blob lp-cta__blob--1" />
      <span class="lp-cta__blob lp-cta__blob--2" />
      <div class="lp-wrap lp-cta__in">
        <h2>今天的客人，<br>讓 {{ brandName }} 顧。</h2>
        <p class="lp-cta__sub">用你現有的 LINE 官方帳號開通，一分鐘完成。</p>
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
  </div>
</template>

<script setup lang="ts">
import { BILLING_PLAN_ORDER, BILLING_PLANS, FEATURED_PLAN_IDS, type BillingPlan, type BillingPlanId } from '~~/shared/billing/plans'
import { Aim, ChatDotRound, ChatLineRound, Coin, Connection, PriceTag, Setting, Timer } from '@element-plus/icons-vue'

definePageMeta({ layout: false })

// 品牌／產品／公司／客服窗口統一由這裡來（與法務頁、頁尾同一份來源）。
// ⚠️ brandName = 品牌／產品名（MiniMe）、companyName = 營運主體（麥菲爾股份有限公司），別混用。
const { brandName, serviceFullName, companyName, taxId, phone, email, emailHref, cardStatementName } = useSiteIdentity()

const plusIcon
  = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 3v12M3 9h12"/></svg>'

/** 千分位。刻意不用 toLocaleString：SSR（Node ICU）與瀏覽器可能給出不同字串，會造成 hydration 不一致。 */
function fmt(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// ── 定價卡：直接讀 shared/billing/plans.ts（單一事實來源），改價只動那份、不用改門面 ──
// 標記為「最受歡迎」的方案（給 ribbon 與主色 CTA）。
const RECOMMENDED_PLAN: BillingPlanId = 'growth'

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
// ⚠️ 這份是「已申報、可對外揭露」的完整清單——商品資訊的售價列要用它，不能用下面的精選清單。
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
      recommended: p.id === RECOMMENDED_PLAN,
    })),
)

/**
 * 試銷期只主打免費＋399（2026-08-14 老闆拍板：只 show 399）。
 *
 * 清單本體在 shared/billing/plans.ts 的 `FEATURED_PLAN_IDS`——升級對話框也吃同一份，
 * 別在頁面層級另開清單（2026-08-17 就是因為各維護各的，付款彈窗漏改被老闆抓到）。
 *
 * ⛔ 這是**行銷展示**的取捨，跟「有沒有向金流申報」是兩回事，所以不要改 plans.ts 的
 *    `landingHidden` 來達成——那個旗標的意思是「這個價格沒申報、不可以出現在官網」，
 *    借來當展示開關會讓下面商品資訊的售價列跟著少掉，變成「頁面宣稱的售價」與
 *    「向 PAYUNi 申報的售價」不一致。商品資訊一律列全部三階段。
 */
const featuredPlans = computed(() => {
  const picked = publicPlans.value.filter(p => FEATURED_PLAN_IDS.includes(p.id))
  // 只要檯面上有任何一個方案含推播，每張卡都列這一行（沒有的打叉），行數才會一致
  const showBroadcast = picked.some(p => p.plan.broadcast === 'basic' || p.plan.broadcast === 'advanced')
  return picked.map(p => ({ ...p, features: featureRows(p.plan, showBroadcast) }))
})

// （2026-08-14 曾有「另有 NT$799／1,499」的老實交代行，D-14② 拍板整行移除；
//   對應的 otherPaidPrices computed 已一併刪除，別再加回來。）

/**
 * 商品資訊要揭露的售價。
 *
 * 2026-08-14 老闆拍板「先隱藏就好，目前只 show 399」→ 這裡跟著只列**檯面上在賣的**
 * （`FEATURED_PLAN_IDS`），不再列全部已申報的三階段。
 *
 * ⚠️ 這是刻意的取捨，不是漏寫：
 *  - 風控的紅線是「門面出現**未申報**的價格」（見 plans.ts 的 landingHidden 註解）。
 *    列得比申報少不踩那條線，列得比申報多才會被退件。
 *  - 但 `starter`(799) / `growth`(1,499) 在 plans.ts 仍是可自助結帳的方案，
 *    也就是**系統收得到、官網沒寫**。老闆選的是「先隱藏、不動計費」。
 *    要真正停售得改 plans.ts＋升級對話框＋處理既有訂閱戶，見 STATUS `D-14`。
 */
const paidPriceList = computed(() =>
  featuredPlans.value
    .filter(p => p.price.unit) // 有「／月」單位 = 付費方案（免費與面談沒有）
    .map(p => p.price.amount)
    .join('／'),
)

// 「一個月 399 起」的 399 也讀 plans.ts，不寫死——調價時 Hero、定價區會一起對。
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
    '你的 LINE 官方帳號已經有好多好友，只是還不知道怎麼經營。AI 客服 24 小時回訊息、名單自動分眾推播、聊過買過自動貼標——註冊一分鐘，用你現有的官方帳號開通。',
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

// 比較表：左欄講舊做法、右欄講我們怎麼做。⛔每一列都要是「同一件事的兩種做法」，
// 不要放我們有、對手沒有的功能清單——那是型錄不是比較。
const COMPARISON = [
  { icon: Setting, dim: '開始設定', old: '從零建規則、自己拉流程', mine: '有 AI 陪你聊完，設定自動到位' },
  { icon: PriceTag, dim: '名單怎麼分', old: '自己下條件、自己拉名單', mine: '依行為與興趣自動分眾' },
  { icon: ChatDotRound, dim: '客服誰回', old: '你自己回，或再買一套客服工具', mine: 'AI 依你的知識庫即時回，需要時轉真人' },
  { icon: Aim, dim: '回答準不準', old: '罐頭關鍵字，常答非所問', mine: '只依你上傳的內容回答，不亂編' },
  { icon: Connection, dim: '系統整合', old: '客服、CRM、行銷各買各的', mine: '客服 × CRM × 再行銷，一個後台全包' },
]

// 店主自己會講的三句話（訪談原話，不是我們歸納的名詞）
const BLOCKERS = [
  { icon: Timer, title: '沒有時間', quote: '我自己就夠忙了，能撥出來的時間很少。' },
  { icon: Setting, title: '後台太複雜', quote: '打開來好複雜，不知道從哪裡開始設定。' },
  { icon: Coin, title: '工具又貴', quote: '找第三方工具又貴，買了還是不知道怎麼下手。' },
]

// ── Hero 好友名單（示意資料，非真實客戶）──
/**
 * 好友名單頭像。
 *
 * ⚠️ **放好照片後，把下面的 `AVATAR_PHOTOS_READY` 改成 `true`**——
 *    在那之前一律走人形剪影，不去請求那六個檔案。
 *    （若讓它照常請求，檔案不存在時每次載入都會噴 6 個 404 到 console，
 *      畫面雖然靠剪影撐住了，但那些 404 會一路帶上正式站。）
 *
 * 照片規格與**授權要求**見 `public/avatars/README.md`。
 * color 是照片載入前、以及退回剪影時的底色。
 */
const AVATAR_PHOTOS_READY = false
const FRIENDS = [
  { name: '陳小姐', msg: '謝謝！收到了 👍', ago: '8 個月前', tag: 'cold', color: '#7bc67e', photo: '/avatars/1.jpg' },
  { name: '王先生', msg: '請問還有貨嗎？', ago: '5 個月前', tag: 'miss', color: '#e8b04b', photo: '/avatars/2.jpg' },
  { name: '林太太', msg: '好的，我再看看', ago: '11 個月前', tag: 'cold', color: '#6fa8dc', photo: '/avatars/3.jpg' },
  { name: 'Amy', msg: '這個可以宅配嗎？', ago: '3 個月前', tag: 'miss', color: '#c98bc4', photo: '/avatars/4.jpg' },
  { name: '張老闆', msg: '下次再跟你買', ago: '1 年前', tag: 'cold', color: '#8fb89b', photo: '/avatars/5.jpg' },
  { name: '蔡小姐', msg: '我朋友也想要一組', ago: '7 個月前', tag: 'cold', color: '#e39b7b', photo: '/avatars/6.jpg' },
] as const
const TAG_TEXT: Record<string, string> = { cold: '久未互動', miss: '未回覆' }
const FRIEND_TOTAL = 2148
const SLEEP_TOTAL = 1806

// 名單逐列浮現 ＋ 沉睡人數跳動。伺服器端與「減少動態效果」時直接給最終狀態
// （初值就是全部顯示、數字就是終值），所以沒有 JS 也讀得到完整內容。
// 標 <number>：FRIENDS 是 as const，FRIENDS.length 的型別是字面值 6，ref 會跟著只收 6
const shownFriends = ref<number>(FRIENDS.length)
const sleepShown = ref<number>(SLEEP_TOTAL)

const root = ref<HTMLElement | null>(null)
const stuck = ref(false)
const anim = ref(false)
const menuOpen = ref(false)

function closeMenu() { menuOpen.value = false }
function onScroll() { stuck.value = window.scrollY > 8 }

let io: IntersectionObserver | undefined
let listTimers: ReturnType<typeof setTimeout>[] = []
let countRaf = 0

onMounted(() => {
  window.addEventListener('scroll', onScroll, { passive: true })
  onScroll()

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

    // 名單一列一列進來，跑完再讓沉睡人數往上數——先看到人，再看到數字才有衝擊
    shownFriends.value = 0
    FRIENDS.forEach((_, i) => {
      listTimers.push(setTimeout(() => { shownFriends.value = i + 1 }, 420 + i * 230))
    })
    listTimers.push(setTimeout(countUpSleep, 420 + FRIENDS.length * 230 + 300))
  })
})

function countUpSleep() {
  const start = performance.now()
  const dur = 1100
  sleepShown.value = 0
  const tick = (t: number) => {
    const p = Math.min(1, (t - start) / dur)
    sleepShown.value = Math.round(SLEEP_TOTAL * (1 - (1 - p) ** 3))
    if (p < 1) countRaf = requestAnimationFrame(tick)
  }
  countRaf = requestAnimationFrame(tick)
}

onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll)
  io?.disconnect()
  listTimers.forEach(clearTimeout)
  listTimers = []
  if (countRaf) cancelAnimationFrame(countRaf)
  document.documentElement.style.scrollBehavior = ''
})
</script>
