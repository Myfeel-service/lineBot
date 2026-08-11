<template>
  <AdminSplitLayout solo :is-empty="false">
    <template #editor-header>
      <AdminSoloPageHeading
        field-label="超級管理員"
        title="成本總覽"
        caption="AI 與資料庫的實際花費，一頁看清楚錢花在哪、誰花的。"
      />
      <div class="flex gap-2 admin-header-actions">
        <el-date-picker
          v-model="period"
          type="month"
          value-format="YYYYMM"
          format="YYYY 年 MM 月"
          :clearable="false"
          placeholder="選擇月份"
        />
        <el-button :loading="loading" @click="load">重新整理</el-button>
      </div>
    </template>

    <template #editor-body>
      <div class="solo-editor-body admin-panel-stack">
        <!-- 提醒：這頁算得出來的、與算不出來的 -->
        <div class="sa-cost-note">
          這頁放<b>系統本身</b>的三筆錢：<b>AI</b>（Gemini）、<b>資料庫</b>（Firebase）、<b>主機</b>（AWS）。
          前兩筆依實際用量換算，主機是 AWS 帳單金額。<br>
          <b>LINE 月費與推播、金流手續費、發票、網域不在此</b> —— 那些查不到用量，請看各平台帳單。
        </div>

        <!-- 本月總花費：AI ＋ 資料庫（兩者相加＝總額，才並排） -->
        <div class="message-card ar-section-card">
          <div class="sa-cost-body">
            <div class="sa-cost-hero">
              <div class="sa-cost-hero__label">{{ periodLabel }} 總花費（AI ＋ 資料庫 ＋ 主機）</div>
              <div class="sa-cost-hero__row">
                <div class="sa-cost-hero__value">{{ ntTwd(grandTotalTwd) }}</div>
                <span
                  v-if="grandDeltaPct !== null"
                  class="sa-cost-delta"
                  :class="grandDeltaPct > 0 ? 'is-up' : (grandDeltaPct < 0 ? 'is-down' : 'is-flat')"
                >
                  較上月 {{ grandDeltaPct > 0 ? '▲' : (grandDeltaPct < 0 ? '▼' : '＝') }} {{ Math.abs(grandDeltaPct) }}%
                </span>
              </div>
              <div class="sa-cost-hero__sub">{{ grandSubText }}</div>
            </div>

            <template v-if="grandTotalTwd >= 1">
              <div class="sa-cost-bar">
                <span class="sa-cost-seg sa-cost-seg--ai" :style="{ width: grandPct(aiTotalTwd) + '%' }" />
                <span class="sa-cost-seg sa-cost-seg--infra" :style="{ width: grandPct(infraTotalTwd) + '%' }" />
                <span class="sa-cost-seg sa-cost-seg--host" :style="{ width: grandPct(hostTotalTwd) + '%' }" />
              </div>
              <div class="sa-cost-legend">
                <div class="sa-cost-legend__item">
                  <span class="sa-cost-dot sa-cost-dot--ai" />
                  <span class="sa-cost-legend__name">AI（回答／整理知識／後台自用）</span>
                  <span class="sa-cost-legend__val">{{ ntTwdSoft(aiTotalTwd) }} ・ {{ grandPct(aiTotalTwd) }}%</span>
                </div>
                <div v-if="infra.status === 'ok'" class="sa-cost-legend__item">
                  <span class="sa-cost-dot sa-cost-dot--infra" />
                  <span class="sa-cost-legend__name">資料庫（讀寫／儲存／流量）</span>
                  <span class="sa-cost-legend__val">{{ ntTwdSoft(infraTotalTwd) }} ・ {{ grandPct(infraTotalTwd) }}%</span>
                </div>
                <div v-if="host.status === 'ok'" class="sa-cost-legend__item">
                  <span class="sa-cost-dot sa-cost-dot--host" />
                  <span class="sa-cost-legend__name">主機（AWS）</span>
                  <span class="sa-cost-legend__val">{{ ntTwdSoft(hostTotalTwd) }} ・ {{ grandPct(hostTotalTwd) }}%</span>
                </div>
              </div>
            </template>
            <div v-else class="sa-cost-empty">{{ emptyText }}</div>

            <!-- 讀取失敗絕不當成 0：說清楚上面那個數字少了什麼 -->
            <div v-if="missingParts.length" class="sa-infra-warn">
              ⚠ 上面的總額<b>不含{{ missingParts.join('、') }}</b>（讀不到，見下方各區塊說明）。
            </div>
          </div>
        </div>

        <!-- AI 花費：三桶怎麼分 -->
        <div class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">AI 花費 {{ ntdSoft(totals.totalCostUsd) }}</span>
              <span
                v-if="hasSpend && deltaPct !== null"
                class="sa-cost-delta"
                :class="deltaPct > 0 ? 'is-up' : (deltaPct < 0 ? 'is-down' : 'is-flat')"
              >
                較上月 {{ deltaPct > 0 ? '▲' : (deltaPct < 0 ? '▼' : '＝') }} {{ Math.abs(deltaPct) }}%
              </span>
            </div>
          </div>
          <div class="sa-cost-body">
            <div class="sa-cost-hero">
              <div class="sa-cost-hero__sub">
                {{ activeCount }} 個帳號有花費 ・ 客人這邊呼叫 AI {{ totals.invocations.toLocaleString() }} 次（答出 {{ totals.answered.toLocaleString() }} 則）・ 後台自用 {{ totals.testInvocations.toLocaleString() }} 次
              </div>
            </div>

            <!-- 一條比例條看出三桶怎麼分（總額不到 NT$1 就不畫，避免出現「有%沒金額」） -->
            <template v-if="hasSpend">
              <div class="sa-cost-bar">
                <span class="sa-cost-seg sa-cost-seg--conv" :style="{ width: pct(totals.conversationCostUsd) + '%' }" />
                <span class="sa-cost-seg sa-cost-seg--build" :style="{ width: pct(totals.buildCostUsd) + '%' }" />
                <span class="sa-cost-seg sa-cost-seg--test" :style="{ width: pct(totals.testCostUsd) + '%' }" />
              </div>
              <div class="sa-cost-legend">
                <div class="sa-cost-legend__item">
                  <span class="sa-cost-dot sa-cost-dot--conv" />
                  <span class="sa-cost-legend__name">回答客人</span>
                  <span class="sa-cost-legend__val">{{ ntdSoft(totals.conversationCostUsd) }} ・ {{ pct(totals.conversationCostUsd) }}%</span>
                </div>
                <div class="sa-cost-legend__item">
                  <span class="sa-cost-dot sa-cost-dot--build" />
                  <span class="sa-cost-legend__name">整理知識庫</span>
                  <span class="sa-cost-legend__val">{{ ntdSoft(totals.buildCostUsd) }} ・ {{ pct(totals.buildCostUsd) }}%</span>
                </div>
                <div class="sa-cost-legend__item">
                  <span class="sa-cost-dot sa-cost-dot--test" />
                  <span class="sa-cost-legend__name">後台自用</span>
                  <span class="sa-cost-legend__val">{{ ntdSoft(totals.testCostUsd) }} ・ {{ pct(totals.testCostUsd) }}%</span>
                </div>
              </div>
            </template>
            <div v-else class="sa-cost-empty">{{ emptyText }}</div>

            <!-- 估算用的單一單價：客人與後台共用同一個數字，要算「多一倍訊息量要多少錢」就乘這個 -->
            <div v-if="planningPerCallText" class="sa-cost-rate">
              <span class="sa-cost-rate__label">估算抓這個數字</span>
              <span class="sa-cost-rate__value">一次 {{ planningPerCallText }}</span>
              <span class="sa-cost-rate__note">
                客人每來一則訊息算一次（{{ totals.invocations.toLocaleString() }} 次）、後台自己操作也算一次（{{ totals.testInvocations.toLocaleString() }} 次）。
                本月實測平均 {{ measuredPerCallText }}，<b>無條件進位</b>後給你估算用，只會高不會低。
              </span>
            </div>
          </div>
        </div>

        <!-- 教學型：這些錢花在哪、做什麼、多少錢 -->
        <div class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">AI 的錢花在哪？一看就懂</span>
            </div>
          </div>
          <div class="sa-cost-body">
            <p class="sa-cost-guide__intro">
              AI 是<b>按用量計費</b>的（單位叫 token，可想成「字數」）—— 客人問的字、AI 回的字都算錢。
              分成三桶的用意是看<b>哪一筆會隨客人變多而變多</b>：只有「回答客人」會，另外兩桶跟客人多寡無關。
            </p>
            <div class="sa-cost-guide">
              <div class="sa-cost-guide__col sa-cost-guide__col--conv">
                <div class="sa-cost-guide__head">
                  <span class="sa-cost-dot sa-cost-dot--conv" /> 回答客人
                  <span class="sa-cost-guide__when">客人越多越貴</span>
                </div>
                <ul class="sa-cost-guide__list">
                  <li><b>看懂問題、找資料、寫出回覆</b>：一則客人訊息主要花在這 <span class="sa-cost-guide__price">最大宗</span></li>
                  <li><b>答不出來的判斷</b>：決定要轉真人、還是反問客人一句 <span class="sa-cost-guide__price">一樣算一次</span></li>
                  <li><b>判斷該不該走腳本</b>：這句要不要交給自動流程接手 <span class="sa-cost-guide__price">幾乎免費</span></li>
                  <li><b>讀客人傳的照片</b>：看懂圖片內容才知道怎麼接 <span class="sa-cost-guide__price">併入同一則</span></li>
                </ul>
                <!-- 與上方「估算抓這個數字」同一個來源，兩處不會各說各的 -->
                <div class="sa-cost-guide__foot">
                  <template v-if="planningPerCallText">客人來一則訊息抓 <b>{{ planningPerCallText }}</b></template>
                  <template v-else>這個月還沒有客人來問，算不出平均</template>
                </div>
              </div>

              <div class="sa-cost-guide__col sa-cost-guide__col--build">
                <div class="sa-cost-guide__head">
                  <span class="sa-cost-dot sa-cost-dot--build" /> 整理知識庫
                  <span class="sa-cost-guide__when">跟你上傳多少資料走，與客人多寡無關</span>
                </div>
                <ul class="sa-cost-guide__list">
                  <li><b>整理文件</b>：把 PDF／文件拆成一條條知識 <span class="sa-cost-guide__price">一份約 NT$2–5</span></li>
                  <li><b>掃描檔轉文字</b>：圖片型 PDF 先辨識成文字，最貴 <span class="sa-cost-guide__price">一份約 NT$5–10</span></li>
                  <li><b>補「客人會怎麼問」</b>：幫知識卡補上常見問法，之後才搜得到 <span class="sa-cost-guide__price">很少</span></li>
                  <li><b>每天掃知識缺口</b>：找出答不出來的問題、草擬補充建議 <span class="sa-cost-guide__price">很少</span></li>
                </ul>
                <div class="sa-cost-guide__foot sa-cost-guide__foot--warn">⚠ 重傳沒改過的檔會重算重收</div>
              </div>

              <div class="sa-cost-guide__col sa-cost-guide__col--test">
                <div class="sa-cost-guide__head">
                  <span class="sa-cost-dot sa-cost-dot--test" /> 後台自用
                  <span class="sa-cost-guide__when">跟你自己操作幾次走，與客人多寡無關</span>
                </div>
                <ul class="sa-cost-guide__list">
                  <li><b>試打 AI</b>：在設定頁重演一句話，看它會怎麼答 <span class="sa-cost-guide__price">同回答客人</span></li>
                  <li><b>知識庫試答</b>：存完卡片按試答，確認現在答得出來 <span class="sa-cost-guide__price">同回答客人</span></li>
                  <li><b>採用建議後自動驗證</b>：系統用代表問句再試答一次 <span class="sa-cost-guide__price">同回答客人</span></li>
                  <li><b>問小幫手</b>：右下角助理幫你查狀況、給建議 <span class="sa-cost-guide__price">同回答客人</span></li>
                  <li><b>一句話生成腳本</b>：吐出一整份腳本，比一則回覆貴 <span class="sa-cost-guide__price">約 8～10 倍</span></li>
                </ul>
                <div class="sa-cost-guide__foot">一次跟回答客人一樣價，不算到客人頭上</div>
              </div>
            </div>
          </div>
        </div>

        <!-- 逐帳號明細 -->
        <div class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">各官方帳號花了多少</span>
            </div>
            <span class="text-xs text-muted">{{ workspaces.length }} 個帳號 ・ 由高到低</span>
          </div>
          <div class="card-section-stack">
            <el-table v-loading="loading" :data="workspaces" size="small" empty-text="本月尚無 AI 花費">
              <el-table-column label="官方帳號" min-width="180">
                <template #default="{ row }">
                  <span class="text-sm font-bold">{{ row.name }}</span>
                  <el-tag v-if="!row.aiEnabled" size="small" type="info" class="sa-cost-off">AI 未啟用</el-tag>
                </template>
              </el-table-column>
              <!-- 次數全部集中在這一欄，右邊四欄一律「單行金額」，欄與欄的高度才一致。
                   ⛔ 主要數字必須是 invocations 不是 answered：右邊「回答客人」那筆錢買的是
                   全部呼叫（答題＋轉真人判斷＋反問），拿 answered 當分母會算出高 2～3 倍的單價 -->
              <el-table-column label="AI 呼叫" width="150" align="right">
                <template #default="{ row }">
                  <template v-if="row.invocations || row.testInvocations">
                    <div class="text-xs">{{ row.invocations.toLocaleString() }} 次</div>
                    <!-- ⛔ 副行必須是主數字的「真拆解」：答出＋沒答出＝上面那個數。
                         原本寫「答出 82・後台 125」——後台根本不在 207 裡，卻排得像拆解，
                         而且實測資料剛好 82+125=207（沒答出=125、後台自用也=125，兩個 125
                         是不同的東西）——老闆當場被騙到。後台自用另起一行、寫明「另計」。 -->
                    <div v-if="row.invocations" class="text-xs text-muted">答出 {{ row.answered.toLocaleString() }}・沒答出 {{ Math.max(0, row.invocations - row.answered).toLocaleString() }}</div>
                    <div v-if="row.testInvocations" class="text-xs text-muted">後台另計 {{ row.testInvocations.toLocaleString() }} 次</div>
                  </template>
                  <span v-else class="text-xs text-muted">—</span>
                </template>
              </el-table-column>
              <el-table-column label="回答客人" width="105" align="right">
                <template #header><span class="sa-cost-th"><span class="sa-cost-dot sa-cost-dot--conv" />回答客人</span></template>
                <template #default="{ row }">{{ ntdSoft(row.conversationCostUsd) }}</template>
              </el-table-column>
              <el-table-column label="整理知識庫" width="110" align="right">
                <template #header><span class="sa-cost-th"><span class="sa-cost-dot sa-cost-dot--build" />整理知識庫</span></template>
                <template #default="{ row }">{{ ntdSoft(row.buildCostUsd) }}</template>
              </el-table-column>
              <el-table-column label="後台自用" width="105" align="right">
                <template #header><span class="sa-cost-th"><span class="sa-cost-dot sa-cost-dot--test" />後台自用</span></template>
                <template #default="{ row }">{{ ntdSoft(row.testCostUsd) }}</template>
              </el-table-column>
              <el-table-column label="合計" width="120" align="right">
                <template #default="{ row }"><span class="sa-cost-total">{{ ntdSoft(row.totalCostUsd) }}</span></template>
              </el-table-column>
            </el-table>
          </div>
        </div>

        <!-- 資料庫（Firebase）實際用量與花費 -->
        <div class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">資料庫花費 {{ infra.status === 'ok' ? ntdSoft(infra.totals.totalCostUsd) : '' }}</span>
            </div>
            <span v-if="infra.status === 'ok'" class="text-xs text-muted">{{ infra.projectId }} ・ {{ locationLabel }}</span>
          </div>

          <!-- 三態：載入中／讀取失敗／有資料。查不到絕不畫成 0 -->
          <div v-if="infraLoading" class="sa-cost-body">
            <div class="sa-cost-empty">正在讀取資料庫用量⋯</div>
          </div>
          <div v-else-if="infra.status !== 'ok'" class="sa-cost-body">
            <div class="sa-infra-warn">
              ⚠ 讀不到資料庫用量：{{ infra.reason }}。<br>
              這不代表沒有花費 —— 請直接看 Firebase 主控台的「專案費用」。
            </div>
          </div>
          <div v-else class="sa-cost-body">
            <p class="sa-cost-guide__intro">
              資料庫是<b>按次計費</b>的：每讀一筆資料、每寫一筆資料都算錢，但<b>每天前 5 萬次讀取、2 萬次寫入免費</b>。
              所以平常幾乎不用錢，<b>只有「某天大量讀取」才會產生費用</b>（例如整批稽核、回填腳本、大量重整報表）。
            </p>

            <!-- 四項相加＝資料庫總花費，才並排 -->
            <div class="sa-infra-grid">
              <div class="sa-infra-cell">
                <div class="sa-infra-cell__label">讀取資料</div>
                <div class="sa-infra-cell__val">{{ ntdSoft(infra.totals.readCostUsd) }}</div>
                <div class="sa-infra-cell__sub">
                  {{ times(infra.totals.reads) }}<template v-if="infra.totals.billableReads > 0">，其中 {{ times(infra.totals.billableReads) }}要錢</template>
                </div>
              </div>
              <div class="sa-infra-cell">
                <div class="sa-infra-cell__label">寫入資料</div>
                <div class="sa-infra-cell__val">{{ ntdSoft(infra.totals.writeCostUsd) }}</div>
                <div class="sa-infra-cell__sub">
                  {{ times(infra.totals.writes) }}<template v-if="infra.totals.billableWrites <= 0">，都在免費額度內</template>
                </div>
              </div>
              <div class="sa-infra-cell">
                <div class="sa-infra-cell__label">刪除資料</div>
                <div class="sa-infra-cell__val">{{ ntdSoft(infra.totals.deleteCostUsd) }}</div>
                <div class="sa-infra-cell__sub">
                  {{ times(infra.totals.deletes) }}<template v-if="infra.totals.billableDeletes <= 0">，都在免費額度內</template>
                </div>
              </div>
              <div class="sa-infra-cell">
                <div class="sa-infra-cell__label">存放資料</div>
                <div class="sa-infra-cell__val">{{ ntdSoft(infra.totals.storageCostUsd + infra.totals.fileStorageCostUsd) }}</div>
                <div class="sa-infra-cell__sub">
                  資料 {{ gib(infra.totals.storageGib) }}、檔案 {{ gib(infra.totals.fileStorageGib) }}
                </div>
              </div>
              <!-- 唯一估算的一格：沒有任何用量指標查得到跨雲流量，只能用讀取次數推 -->
              <div class="sa-infra-cell sa-infra-cell--est">
                <div class="sa-infra-cell__label">跨雲流量 <span class="sa-infra-est-tag">估算</span></div>
                <div class="sa-infra-cell__val">{{ ntdSoft(infra.totals.egressCostUsd) }}</div>
                <div class="sa-infra-cell__sub">
                  {{ times(infra.totals.reads) }} × 每筆約 {{ Math.round(infra.bytesPerRead / 1024 * 10) / 10 }} KB
                </div>
              </div>
            </div>

            <!-- 每天讀取次數：錢就是在超過免費線的那幾天花掉的 -->
            <div class="sa-infra-chart-head">
              <span class="sa-infra-chart-title">每天讀取幾次（錢主要花在這）</span>
              <span class="sa-infra-chart-max">
                <span class="sa-infra-key sa-infra-key--free" />每天免費的 5 萬次
                <span class="sa-infra-key sa-infra-key--paid" />要付錢的部分
                ・ 最高一天 {{ times(maxReads) }}
              </span>
            </div>
            <div class="sa-infra-chart">
              <div class="sa-infra-chart__plot">
                <div
                  v-for="d in infra.days"
                  :key="d.day"
                  class="sa-infra-col"
                  :title="`${d.day}：讀取 ${d.reads.toLocaleString()} 次、寫入 ${d.writes.toLocaleString()} 次 → ${ntdSoft(d.costUsd)}`"
                >
                  <span v-if="labelledDays.has(d.day)" class="sa-infra-col__tag">{{ ntdSoft(d.costUsd) }}</span>
                  <span class="sa-infra-col__bar" :style="{ height: barPct(d.reads) + '%' }">
                    <span class="sa-infra-col__paid" :style="{ height: paidPct(d) + '%' }" />
                  </span>
                </div>
              </div>
              <div class="sa-infra-chart__axis">
                <span v-for="d in infra.days" :key="d.day" class="sa-infra-chart__tick">{{ Number(d.day.slice(8, 10)) }}</span>
              </div>
            </div>

            <div v-if="infra.topDays.length" class="sa-infra-top">
              錢主要花在
              <b v-for="(d, i) in infra.topDays" :key="d.day">
                {{ i ? '、' : '' }}{{ Number(d.day.slice(5, 7)) }}/{{ Number(d.day.slice(8, 10)) }}（{{ ntdSoft(d.costUsd) }}）
              </b>
              。單日讀取暴增通常是整批稽核、回填腳本或反覆重整報表造成的，不是客人來訊。
            </div>

            <p class="sa-cost-est__foot">
              讀寫與儲存＝<b>實際用量</b>依 Google 公開單價換算（{{ locationLabel }}：讀取每 10 萬次 US${{ infra.pricing.readPer100k }}、寫入 US${{ infra.pricing.writePer100k }}、儲存每 GB 每月 US${{ infra.pricing.storagePerGibMonth }}，US$1＝NT${{ infra.usdToTwd }}）。
              跨雲流量<b>是唯一估算的一項</b>：資料庫在 Google、主機在 AWS，每次讀取都要付對外流量費，但這筆沒有任何用量指標可查，
              只能用「讀取次數 × 每筆平均大小」推估（每 GB US${{ infra.pricing.egressPerGib }}）。
              每筆 {{ Math.round(infra.bytesPerRead / 1024 * 10) / 10 }} KB 是量測各集合實際大小後取的保守值，回推金額與 Google 帳單相符（誤差 5% 內）。
              另外這是<b>整個系統</b>的用量，Google 不會依官方帳號分開記，因此無法像 AI 那樣分攤到各帳號。
            </p>
          </div>
        </div>

        <!-- 主機（AWS）：這裡是真實帳單金額，不是推估 -->
        <div class="message-card ar-section-card">
          <div class="message-card-header">
            <div class="card-header-main">
              <span class="section-title">主機花費 {{ host.status === 'ok' ? ntTwdSoft(hostTotalTwd) : '' }}</span>
            </div>
            <span v-if="host.status === 'ok'" class="text-xs text-muted">AWS 實際帳單（原價，未扣折抵金）・ {{ host.currency }}</span>
          </div>

          <div v-if="hostLoading" class="sa-cost-body">
            <div class="sa-cost-empty">正在讀取 AWS 帳單⋯</div>
          </div>
          <div v-else-if="host.status !== 'ok'" class="sa-cost-body">
            <div class="sa-infra-warn">
              ⚠ 讀不到 AWS 花費：{{ host.reason }}
            </div>
            <div class="sa-host-setup">
              <div class="sa-host-setup__title">要讓這裡顯示金額，需要在 AWS 做四件事</div>
              <ol class="sa-host-setup__steps">
                <li>用<b>根帳號</b>到「帳戶」設定，把 <b>IAM 使用者存取帳務資訊</b> 打開（沒開的話後面權限給再多都會被擋）</li>
                <li>到「帳單與成本管理」左側點 <b>Cost Explorer</b>——第一次打開頁面就會自動啟用（啟用後<b>約 24 小時</b>才會有資料）</li>
                <li>建立一個 IAM 使用者，只給 <b>ce:GetCostAndUsage</b> 這一個權限（唯讀，看不到也改不了任何資源），並建立存取金鑰</li>
                <li>把金鑰設成環境變數 <b>AWS_COST_ACCESS_KEY_ID</b> 與 <b>AWS_COST_SECRET_ACCESS_KEY</b>，重新部署</li>
              </ol>
              <p class="sa-host-setup__note">
                完整逐步教學（含每一頁要點哪裡、權限 JSON、常見錯誤對照）放在 <b>docs/AWS-COST-SETUP.md</b>。
                設好之後這裡會顯示 AWS 自己算的帳單金額（含 Amplify、Lightsail、寄信等各項），不需要任何估算。
                查詢每次 US$0.01，已快取 6 小時，一個月大約一塊多台幣。
              </p>
            </div>
          </div>
          <div v-else class="sa-cost-body">
            <p class="sa-cost-guide__intro">
              這是 <b>AWS 自己算好的帳單金額</b>（不是用單價推估的），依服務分項如下。
              金額是<b>原價</b>——真實用量的成本，還沒扣掉 AWS 送的折抵金。
            </p>
            <div v-if="hostCreditTwd > 0" class="sa-host-credit">
              這個月實際付給 AWS 的是 <b>{{ ntTwd(hostNetTwd) }}</b>，因為折抵金吸收了大部分費用：
              原價 {{ ntTwdSoft(hostTotalTwd) }} − 折抵 {{ ntTwd(hostCreditTwd) }} ＝ 實付 {{ ntTwd(hostNetTwd) }}。
              折抵金用完之後，帳單就會回到原價。
            </div>
            <div v-if="host.services.length" class="sa-host-list">
              <div v-for="s in host.services" :key="s.name" class="sa-host-row">
                <span class="sa-host-row__bar" :style="{ width: hostPct(s.cost) + '%' }" />
                <span class="sa-host-row__name">{{ s.name }}</span>
                <span class="sa-host-row__val">{{ hostMoney(s.cost) }}</span>
              </div>
            </div>
            <div v-else class="sa-cost-empty">這個月 AWS 沒有產生費用（都在免費額度內）</div>
            <p class="sa-cost-est__foot">
              金額為 AWS Cost Explorer 的 UnblendedCost（原價＝扣除折抵金 Credit 與退費 Refund 前），
              分日以 <b>UTC</b> 計（與台北日差 8 小時，月總額不受影響）。資料一天更新一次，本頁快取 6 小時。
            </p>
          </div>
        </div>
      </div>
    </template>
  </AdminSplitLayout>
</template>

<script setup lang="ts">
definePageMeta({ middleware: ['auth', 'super-admin'], layout: 'super-admin' })
useHead({ title: '成本總覽 — 超級管理員' })

const { apiFetch } = useSuperAdmin()
const { showToast } = useAdminToast()

interface CostRow {
  id: string
  name: string
  organizationId: string | null
  aiEnabled: boolean
  invocations: number
  answered: number
  testInvocations: number
  conversationCostUsd: number
  buildCostUsd: number
  testCostUsd: number
  totalCostUsd: number
}
interface Totals {
  conversationCostUsd: number
  buildCostUsd: number
  testCostUsd: number
  totalCostUsd: number
  invocations: number
  answered: number
  testInvocations: number
  activeWorkspaces: number
}
interface CostsResponse {
  period: string
  prevPeriod: string
  totals: Totals
  prevTotalCostUsd: number
  workspaces: CostRow[]
}

// 資料庫（Firebase）用量與費用，來自 /api/admin/super/infra-costs
interface InfraTotals {
  reads: number
  writes: number
  deletes: number
  billableReads: number
  billableWrites: number
  billableDeletes: number
  storageGib: number
  fileStorageGib: number
  readCostUsd: number
  writeCostUsd: number
  deleteCostUsd: number
  storageCostUsd: number
  fileStorageCostUsd: number
  /** 跨雲流量：唯一的估算項 */
  egressCostUsd: number
  /** 實際量測的部分（不含估算流量） */
  measuredCostUsd: number
  totalCostUsd: number
}
interface InfraDay {
  day: string
  reads: number
  writes: number
  deletes: number
  billableReads: number
  costUsd: number
}
interface InfraPricing {
  readPer100k: number
  writePer100k: number
  deletePer100k: number
  storagePerGibMonth: number
  egressPerGib: number
}
/** 前端一律拿到補齊預設值的完整物件，模板才不用到處 optional chaining */
interface Infra {
  status: 'ok' | 'unavailable'
  reason: string
  projectId: string
  usdToTwd: number
  location: string
  multiRegion: boolean
  /** 流量估算所用的「每筆讀取多少 bytes」，要顯示給人看才知道估算依據 */
  bytesPerRead: number
  pricing: InfraPricing
  days: InfraDay[]
  totals: InfraTotals
  topDays: Array<{ day: string; costUsd: number; reads: number }>
}
type InfraResponse = Partial<Infra> & { status: 'ok' | 'unavailable' }

// 主機（AWS）花費，來自 /api/admin/super/host-costs
interface Host {
  status: 'ok' | 'unavailable'
  reason: string
  currency: string
  usdToTwd: number
  /** 原價（不含折抵金） */
  totalCost: number
  /** 折抵金＋退費（有折抵時為負數） */
  creditTotal: number
  /** 實付＝原價＋折抵 */
  netTotal: number
  services: Array<{ name: string; cost: number }>
}
type HostResponse = Partial<Host> & { status: 'ok' | 'unavailable' }

const USD_TO_TWD = 32
function twd(usd: number) { return Math.round((usd || 0) * USD_TO_TWD) }
function ntd(usd: number) { return `NT$${twd(usd).toLocaleString('en-US')}` }
// 有一點點花費、但四捨五入後不到 NT$1 → 顯示「<NT$1」而非誤導的「NT$0」
function ntdSoft(usd: number) { return (usd > 0 && twd(usd) === 0) ? '<NT$1' : ntd(usd) }
// 已是台幣的金額直接格式化
function ntTwd(n: number) { return `NT$${Math.round(n || 0).toLocaleString('en-US')}` }
function ntTwdSoft(n: number) { return (n > 0 && Math.round(n) === 0) ? '<NT$1' : ntTwd(n) }

function currentPeriod() {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`
}

const loading = ref(false)
const period = ref(currentPeriod())
const workspaces = ref<CostRow[]>([])
const totals = ref<Totals>({ conversationCostUsd: 0, buildCostUsd: 0, testCostUsd: 0, totalCostUsd: 0, invocations: 0, answered: 0, testInvocations: 0, activeWorkspaces: 0 })
const prevTotalCostUsd = ref(0)

// ── 資料庫（Firebase）實際花費 ────────────────────────────────
// 用量來自 Cloud Monitoring，不是估的；三態（載入中／讀不到／有資料）分開處理，
// 讀不到絕不當 0（否則畫面會把「查詢失敗」演成「這個月沒花錢」）。
const EMPTY_INFRA_TOTALS: InfraTotals = {
  reads: 0, writes: 0, deletes: 0,
  billableReads: 0, billableWrites: 0, billableDeletes: 0,
  storageGib: 0, fileStorageGib: 0,
  readCostUsd: 0, writeCostUsd: 0, deleteCostUsd: 0,
  storageCostUsd: 0, fileStorageCostUsd: 0,
  egressCostUsd: 0, measuredCostUsd: 0, totalCostUsd: 0,
}
const DEFAULT_INFRA_PRICING: InfraPricing = { readPer100k: 0.06, writePer100k: 0.18, deletePer100k: 0.02, storagePerGibMonth: 0.18, egressPerGib: 0.12 }

const infraLoading = ref(true)
const infra = ref<Infra>({
  status: 'unavailable', reason: '', projectId: '', usdToTwd: USD_TO_TWD,
  location: '', multiRegion: true, bytesPerRead: 1024, pricing: DEFAULT_INFRA_PRICING,
  days: [], totals: EMPTY_INFRA_TOTALS, topDays: [],
})
/** 上月資料庫花費；null＝讀不到（此時不可與本月相減） */
const prevInfraCostUsd = ref<number | null>(null)

const hostLoading = ref(true)
const host = ref<Host>({
  status: 'unavailable', reason: '', currency: 'USD', usdToTwd: USD_TO_TWD, totalCost: 0, creditTotal: 0, netTotal: 0, services: [],
})
/** 上月主機花費；null＝讀不到 */
const prevHostCost = ref<number | null>(null)

const aiTotalTwd = computed(() => twd(totals.value.totalCostUsd))
const infraTotalTwd = computed(() => infra.value.status === 'ok' ? twd(infra.value.totals.totalCostUsd) : 0)
// AWS 帳單幣別通常是 USD，但若帳號本身以台幣結算就直接用，不要再乘一次匯率
const hostToTwd = (amount: number) => host.value.currency === 'USD' ? twd(amount) : Math.round(amount)
const hostTotalTwd = computed(() => host.value.status === 'ok' ? hostToTwd(host.value.totalCost) : 0)
// 折抵金以「正數」呈現（後端存的是負數沖銷項），實付另外算，畫面上三個數字要對得起來
const hostCreditTwd = computed(() => host.value.status === 'ok' ? Math.abs(hostToTwd(host.value.creditTotal)) : 0)
const hostNetTwd = computed(() => host.value.status === 'ok' ? hostToTwd(host.value.netTotal) : 0)
const grandTotalTwd = computed(() => aiTotalTwd.value + infraTotalTwd.value + hostTotalTwd.value)

function hostMoney(amount: number) {
  const t = hostToTwd(amount)
  return (amount > 0 && t === 0) ? '<NT$1' : `NT$${t.toLocaleString('en-US')}`
}
function hostPct(cost: number) {
  const top = host.value.services[0]?.cost ?? 0
  return top > 0 ? Math.max(2, Math.round((cost / top) * 100)) : 0
}

/** 哪幾筆讀不到 → hero 要講清楚總額少了什麼（絕不靜默當 0） */
const missingParts = computed(() => {
  const out: string[] = []
  if (!infraLoading.value && infra.value.status !== 'ok') out.push('資料庫')
  if (!hostLoading.value && host.value.status !== 'ok') out.push('主機')
  return out
})

function grandPct(twdAmount: number) {
  const t = grandTotalTwd.value
  return t > 0 ? Math.round((twdAmount / t) * 100) : 0
}

const grandSubText = computed(() => {
  const parts = [`${activeCount.value} 個帳號有花費`, `AI 回答 ${totals.value.answered.toLocaleString()} 則`]
  if (infra.value.status === 'ok') parts.push(`資料庫讀取 ${times(infra.value.totals.reads)}`)
  return parts.join(' ・ ')
})

/**
 * 較上月：本月與上月的**組成必須一模一樣**才能比。
 * 少了資料庫或主機那一筆卻照算百分比，會變成拿三筆比兩筆、跌幅純屬幻覺。
 */
const grandDeltaPct = computed(() => {
  const curInfra = infra.value.status === 'ok'
  const curHost = host.value.status === 'ok'
  if (curInfra !== (prevInfraCostUsd.value !== null)) return null
  if (curHost !== (prevHostCost.value !== null)) return null

  const cur = totals.value.totalCostUsd * USD_TO_TWD
    + (curInfra ? infra.value.totals.totalCostUsd * USD_TO_TWD : 0)
    + (curHost ? hostToTwd(host.value.totalCost) : 0)
  const prev = prevTotalCostUsd.value * USD_TO_TWD
    + (prevInfraCostUsd.value ?? 0) * USD_TO_TWD
    + (prevHostCost.value === null ? 0 : (host.value.currency === 'USD' ? prevHostCost.value * USD_TO_TWD : prevHostCost.value))
  if (!prev) return null
  return Math.round(((cur - prev) / prev) * 100)
})

const locationLabel = computed(() => {
  const loc = infra.value.location
  if (!loc) return '位置未知（以較貴的多區域費率估）'
  return infra.value.multiRegion ? `${loc} 多區域` : `${loc} 單一區域`
})

const maxReads = computed(() => Math.max(0, ...infra.value.days.map(d => d.reads)))
function barPct(reads: number) { return maxReads.value > 0 ? (reads / maxReads.value) * 100 : 0 }
function paidPct(d: InfraDay) { return d.reads > 0 ? (d.billableReads / d.reads) * 100 : 0 }

// 只在「花了錢且佔比明顯」的柱子上標金額：標滿 31 根會糊成一團，標關鍵那幾天才讀得到數字
const labelledDays = computed(() => {
  const t = infra.value.totals.totalCostUsd
  if (t <= 0) return new Set<string>()
  return new Set(
    infra.value.days
      .filter(d => d.costUsd > 0 && d.costUsd / t >= 0.08)
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, 6)
      .map(d => d.day),
  )
})

/**
 * 次數講人話：1,822,586 →「182 萬次」、1,730 →「1,730 次」。
 * 單位連同數字一起產生，才不會出現「182 萬 次」這種中間多一格的排版。
 */
function times(n: number) {
  const v = Number(n || 0)
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)} 億次`
  if (v >= 1e4) {
    const w = v / 1e4
    return `${w >= 100 ? Math.round(w) : w.toFixed(1)} 萬次`
  }
  return `${v.toLocaleString('en-US')} 次`
}

/** 存量：不到 1 GB 用 MB 講，才不會看到一排 0.03 GB */
function gib(g: number) {
  const v = Number(g || 0)
  return v < 1 ? `${Math.round(v * 1024)} MB` : `${v.toFixed(2)} GB`
}

const periodLabel = computed(() => {
  const p = period.value || ''
  return p.length === 6 ? `${p.slice(0, 4)} 年 ${p.slice(4, 6)} 月` : p
})

/**
 * 估算用單價：**客人與後台合成同一個數字**，因為兩邊跑的是同一條答題流程、同一個費率，
 * 實測差距只有幾個百分點（差在每題撈到多少參考資料），拆成兩個數字只會讓人以為有差別。
 *
 * 分母是「AI 被呼叫幾次」＝客人每來一則訊息算一次（不論最後是答出來、轉真人還是反問），
 * 加上後台自己操作的次數。⛔ 別拿「答出幾則」當分母，那只佔全部呼叫的四成左右。
 *
 * 再**無條件進位到分位**當估算值：一來好乘，二來順便蓋掉「有些呼叫其實沒花到錢」
 * （客人直接說找真人 → 直接轉接不呼叫 AI）造成的平均值稀釋，估出來只會偏高不會偏低。
 */
const allAiCalls = computed(() => totals.value.invocations + totals.value.testInvocations)
const measuredPerCallTwd = computed(() => {
  const calls = allAiCalls.value
  if (!calls) return 0
  return (totals.value.conversationCostUsd + totals.value.testCostUsd) * USD_TO_TWD / calls
})
const planningPerCallTwd = computed(() => Math.ceil(measuredPerCallTwd.value * 100) / 100)
const planningPerCallText = computed(() => planningPerCallTwd.value > 0 ? `NT$${planningPerCallTwd.value.toFixed(2)}` : '')
const measuredPerCallText = computed(() => measuredPerCallTwd.value > 0 ? `NT$${measuredPerCallTwd.value.toFixed(3)}` : '')

// 以「四捨五入後的台幣」判定本月是否有實質花費（避免零頭造成有%沒金額）
const hasSpend = computed(() => twd(totals.value.totalCostUsd) >= 1)
const activeCount = computed(() => workspaces.value.filter(w => twd(w.totalCostUsd) >= 1).length)
const emptyText = computed(() =>
  totals.value.totalCostUsd > 0
    ? `${periodLabel.value} AI 花費不到 NT$1（可視為 0）`
    : `${periodLabel.value} 尚無 AI 花費`,
)

// 成本佔比（三桶相加＝總成本，用來畫比例條）
function pct(usd: number) {
  const t = totals.value.totalCostUsd
  return t > 0 ? Math.round((usd / t) * 100) : 0
}

// 較上月變化（%）；上月為 0 或無資料則不顯示，避免除以 0 或誤導
const deltaPct = computed(() => {
  const cur = totals.value.totalCostUsd
  const prev = prevTotalCostUsd.value
  if (!prev) return null
  return Math.round(((cur - prev) / prev) * 100)
})

/** 上一個月份（YYYYMM），處理跨年 */
function prevYyyyMm(p: string): string {
  const y = Number(p.slice(0, 4))
  const m = Number(p.slice(4, 6))
  return `${m <= 1 ? y - 1 : y}${String(m <= 1 ? 12 : m - 1).padStart(2, '0')}`
}

/** 後端回來的資料補齊預設值；status 不是 ok 就保持空資料，不要拿殘缺欄位去算錢 */
function normalizeInfra(res: InfraResponse): Infra {
  const ok = res.status === 'ok'
  return {
    status: res.status,
    reason: res.reason || '原因不明',
    projectId: res.projectId || '',
    usdToTwd: res.usdToTwd || USD_TO_TWD,
    location: res.location || '',
    multiRegion: res.multiRegion ?? true,
    bytesPerRead: res.bytesPerRead || 1024,
    pricing: res.pricing || DEFAULT_INFRA_PRICING,
    days: ok ? (res.days || []) : [],
    totals: ok ? (res.totals || EMPTY_INFRA_TOTALS) : EMPTY_INFRA_TOTALS,
    topDays: ok ? (res.topDays || []) : [],
  }
}

async function loadInfra() {
  infraLoading.value = true
  const prevPeriod = prevYyyyMm(period.value)
  try {
    // 上月只是拿來算「較上月」，失敗就當不可比、不擋本月顯示
    const [cur, prev] = await Promise.all([
      apiFetch<InfraResponse>(`/api/admin/super/infra-costs?period=${period.value}`),
      apiFetch<InfraResponse>(`/api/admin/super/infra-costs?period=${prevPeriod}`).catch(() => null),
    ])
    infra.value = normalizeInfra(cur)
    prevInfraCostUsd.value = prev?.status === 'ok' ? (prev.totals?.totalCostUsd ?? 0) : null
  }
  catch (e: any) {
    infra.value = normalizeInfra({ status: 'unavailable', reason: e?.data?.statusMessage || '讀取失敗' })
    prevInfraCostUsd.value = null
  }
  finally {
    infraLoading.value = false
  }
}

async function loadAi() {
  loading.value = true
  try {
    const res = await apiFetch<CostsResponse>(`/api/admin/super/costs?period=${period.value}`)
    workspaces.value = res.workspaces
    totals.value = res.totals
    prevTotalCostUsd.value = res.prevTotalCostUsd
  }
  catch (e: any) {
    showToast(e?.data?.statusMessage || '讀取失敗', 'error')
  }
  finally {
    loading.value = false
  }
}

function normalizeHost(res: HostResponse): Host {
  const ok = res.status === 'ok'
  return {
    status: res.status,
    reason: res.reason || '原因不明',
    currency: res.currency || 'USD',
    usdToTwd: res.usdToTwd || USD_TO_TWD,
    totalCost: ok ? (res.totalCost ?? 0) : 0,
    creditTotal: ok ? (res.creditTotal ?? 0) : 0,
    netTotal: ok ? (res.netTotal ?? res.totalCost ?? 0) : 0,
    services: ok ? (res.services || []) : [],
  }
}

async function loadHost() {
  hostLoading.value = true
  const prevPeriod = prevYyyyMm(period.value)
  try {
    const [cur, prev] = await Promise.all([
      apiFetch<HostResponse>(`/api/admin/super/host-costs?period=${period.value}`),
      apiFetch<HostResponse>(`/api/admin/super/host-costs?period=${prevPeriod}`).catch(() => null),
    ])
    host.value = normalizeHost(cur)
    prevHostCost.value = prev?.status === 'ok' ? (prev.totalCost ?? 0) : null
  }
  catch (e: any) {
    host.value = normalizeHost({ status: 'unavailable', reason: e?.data?.statusMessage || '讀取失敗' })
    prevHostCost.value = null
  }
  finally {
    hostLoading.value = false
  }
}

function load() {
  return Promise.all([loadAi(), loadInfra(), loadHost()])
}
onMounted(load)
watch(period, load)
</script>
