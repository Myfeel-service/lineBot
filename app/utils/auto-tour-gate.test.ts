import { describe, expect, it } from 'vitest'
import type { AutoTourInput } from './auto-tour-gate'
import { decideAutoTour } from './auto-tour-gate'

/** 一切條件都到齊、該跑的那一組；每個案例只改要驗的那一項 */
const READY: AutoTourInput = {
  seenReady: true,
  setupLoaded: true,
  onboardingIncomplete: false,
  hasTopics: true,
  tourOpen: false,
  seen: false,
}

const decide = (patch: Partial<AutoTourInput> = {}) => decideAutoTour({ ...READY, ...patch })

describe('decideAutoTour', () => {
  it('條件到齊就開跑', () => {
    expect(decide()).toBe('start')
  })

  it('看過了就不再跑', () => {
    expect(decide({ seen: true })).toBe('skip')
  })

  describe('還不知道答案的時候一律等，不可以猜', () => {
    it('後端記憶還沒查完：猜「沒看過」會變成每次進來都跳一次', () => {
      expect(decide({ seenReady: false })).toBe('wait')
      // ⛔ 連「看過了」都不能拿來提早結束：那一格這時候讀到的是還沒填的空值
      expect(decide({ seenReady: false, seen: true })).toBe('wait')
    })

    it('體檢還沒載入：猜「開通做完了」會在他被拉去開通對話的路上插一支導覽', () => {
      expect(decide({ setupLoaded: false })).toBe('wait')
    })

    it('角色還沒載進來：這一瞬間沒教學可跑，不等於這個角色沒教學可跑', () => {
      expect(decide({ hasTopics: false })).toBe('wait')
    })
  })

  it('開通還沒做完就不插隊（那條流程結尾本來就會問要不要導覽）', () => {
    expect(decide({ onboardingIncomplete: true })).toBe('skip')
  })

  it('開通未完的判斷要先於角色與記憶——不能等到角色載完才想起來讓路', () => {
    expect(decide({ onboardingIncomplete: true, hasTopics: false })).toBe('skip')
  })

  it('已經有導覽開著就這次不跑，而且是「放棄」不是「等它關掉」', () => {
    // 等它關掉再跑＝看完一支馬上被下一支蓋上，正是當初否決自動導覽的那種騷擾
    expect(decide({ tourOpen: true })).toBe('skip')
  })

  it('觀察者這種一支教學都跑不動的角色不會被判成 start', () => {
    // hasTopics 已經是「依角色過濾後」的結果，所以這裡只會落在 wait，永遠等不到 start
    expect(decide({ hasTopics: false })).not.toBe('start')
  })
})
