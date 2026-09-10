import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ONBOARDING_CAROUSELS } from './onboarding-shots'

/**
 * 步驟輪播的守門（2026-09-10）。
 *
 * 這支取代了 `onboarding-shot-steps.test.ts` 在開通引導那條路上的角色。舊測試守的是
 * 「圖上的紅色編號」與「文案裡的①②③」對不對得上——那兩份資料住在不同檔案，改了一邊
 * 不會有東西變紅。輪播把 `src` 跟 `caption` 綁在同一個物件裡，**那個漂移已經不可能發生**，
 * 所以這裡改守剩下的三件事：
 *
 * ① 分鏡檔要**真的在** `public/onboarding/`。輪播載不到圖會自己把那一步濾掉、
 *    全部載不到就整張卡不畫——所以打錯檔名的下場是**畫面上安靜地少一步**，
 *    沒有錯誤、沒有破圖，只有使用者照著一份少一步的教學做不完。
 * ② 圖說**不准出現圈號**。步序由卡片自己的計數器與步驟軌講，圖說再標一次
 *    就是同一件事講兩次（右下角那顆「第幾格／共幾格」也是為此從圖上拿掉的）。
 * ③ 一支輪播至少要有兩步。只有一步的東西不叫輪播，該用單張示意圖卡。
 */

const ROOT = resolve(import.meta.dirname, '../..')
const CIRCLED = '①②③④⑤⑥⑦⑧⑨'

describe('開通引導步驟輪播', () => {
  for (const [name, steps] of Object.entries(ONBOARDING_CAROUSELS)) {
    describe(name, () => {
      it('至少兩步（只有一步的用單張圖卡，不要用輪播）', () => {
        expect(steps.length).toBeGreaterThanOrEqual(2)
      })

      for (const [i, step] of steps.entries()) {
        it(`第 ${i + 1} 步的分鏡檔存在`, () => {
          const path = resolve(ROOT, 'public', step.src.replace(/^\//, ''))
          expect(existsSync(path), `${step.src} 不在 public/onboarding/——輪播會安靜地少這一步`).toBe(true)
        })

        it(`第 ${i + 1} 步的圖說不自己標號`, () => {
          const used = [...CIRCLED].filter(c => step.caption.includes(c))
          expect(used, `圖說寫了 ${used.join('')}，但步序是卡片的計數器在講`).toEqual([])
        })
      }

      it('同一支裡沒有重複的分鏡', () => {
        const srcs = steps.map(s => s.src)
        expect(new Set(srcs).size).toBe(srcs.length)
      })
    })
  }
})
