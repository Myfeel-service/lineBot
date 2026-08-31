# 官網用圖的原始檔

`public/landing/` 底下是**壓縮過、會跟著部署對外公開**的圖；這個資料夾放**原始檔**
（不對外、Nuxt 只服務 `public/`，`docs/` 不會被瀏覽器打開）。要換圖、要重壓，從這裡出發，
不用回頭跟老闆再要一次檔案。

沿用 `public/onboarding/README.md` 的分工慣例：正式圖進 `public/`，未壓縮來源留 `docs/`。

## 目前有什麼

| 原始檔 | 產出 | 用在哪 | 誰給的 |
|---|---|---|---|
| `richmenu-midautumn.jpg`（1527×1030、323KB） | `public/landing/richmenu-midautumn.webp`（800×540、45KB） | 首頁「常問的事變成按鈕」窄帶裡那支手機的圖文選單 | 2026-08-31 老闆提供 |

`public/landing/` 另外三張（`admin-chat.png`／`admin-friends-tags.png`／`admin-onboarding.png`）
是**系統真實截圖**，由 `scripts/landing-shots.mjs` 產生，不放在這裡也不手動改——換圖要重跑腳本。

## 壓縮指令

```sh
cwebp -q 80 -m 6 -resize 800 0 \
  docs/landing-shots-src/richmenu-midautumn.jpg \
  -o public/landing/richmenu-midautumn.webp
```

- **為什麼是 800px 寬**：實際顯示只有 250 CSS px（窄帶手機 268px 減掉殼的 9px×2），
  800px 剛好夠 3 倍螢幕。再大只是白白多幾十 KB，看不出差別。
- **為什麼是 q80**：q72→37KB、q80→45KB、q88→63KB。縮到 250px 顯示時 q80 以上肉眼分不出來，
  q72 的金色字在原尺寸下會開始糊。
- **為什麼是 webp**：`public/onboarding/` 已有先例，同畫質比 JPEG 小三成。

## ⚠️ 中秋這張會過期

窄帶裡那句節日**以前不會過期**：`shared/taiwan-festivals.ts` 會算出「接下來第一個送禮檔期」
自動代進去（原本是 div 刻的選單，文字是活的）。2026-08-31 改用實拍圖之後，節日跟著烤進圖裡，
**2026-09-25 中秋過完，官網就會掛著一張過期的圖**。

換圖時：拿新的節慶主視覺蓋掉這裡的原始檔 → 跑上面那行 `cwebp`（輸出檔名跟著換）→
改 `app/pages/index.vue` 的 `src` 與 `alt`（`alt` 裡有寫「中秋節禮盒」，別忘了一起改）。
追蹤在 `docs/STATUS.md`。

## ⛔ 這張圖是示意，不是某家店的真選單

圖上的「山丘咖啡」是全頁共用的示範店家（見 `scripts/landing-demo-seed.ts`），商品是虛構的。
窄帶下面的圖說寫著「選單畫面為示意，店家與商品皆為虛構」——**那句不能拿掉**：兩張後台截圖有
「系統實際畫面」的標頭標示它們是真的，這支沒有，不講就會被當成真店家的選單。
