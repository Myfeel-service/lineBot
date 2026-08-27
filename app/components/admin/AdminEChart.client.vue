<template>
  <VChart :option="option" autoresize />
</template>

<script setup lang="ts">
/**
 * 圖表元件（只有對話統計與 AI 表現兩頁在用）。
 *
 * ⛔ **不要改回全域 plugin。** 圖表庫原本註冊在 `app/plugins/echarts.client.ts`，
 * 而 plugin 會被打進「每一頁都要下載」的 entry chunk：實測把它拿掉重新打包，
 * entry 從 1,010 KB 掉到 464 KB（壓縮後 341 KB → 159 KB）——也就是每一次首次載入
 * （含**公開官網的訪客**）都在下載 182 KB 的畫圖工具，而全站只有這兩頁畫圖。
 * 見 docs/ADMIN-PERF-AUDIT-20260827.md 的 `E-25`。
 *
 * 用法：`<LazyAdminEChart :option="…" />`（Lazy 前綴才會切成獨立 chunk、進那兩頁才下載）。
 * 檔名帶 `.client` 是因為 canvas 需要 DOM。
 *
 * tree-shake：只引入實際用到的圖種與元件——折線／長條、格線、提示框、圖例、
 * 縮放軸、標記點。要用新的圖種（例如圓餅）得在這裡補 `use()`，否則圖會整塊空白。
 */
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { BarChart, LineChart } from 'echarts/charts'
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkPointComponent,
  TooltipComponent,
} from 'echarts/components'
import VChart from 'vue-echarts'

use([
  CanvasRenderer,
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkPointComponent,
])

defineProps<{
  /** ECharts option 物件（各頁自己組，這裡不介入樣式決策） */
  option: Record<string, unknown>
}>()
</script>
