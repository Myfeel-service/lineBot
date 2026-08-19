#!/usr/bin/env python3
"""開通引導示意圖產線：docs/onboarding-shots-src/ 的原始截圖 → public/onboarding/ 的正式圖。

用法：python3 scripts/make-onboarding-shots.py   （需要 Pillow：pip3 install Pillow）

LINE 後台改版時的重製流程：
  1. 重截同一頁（拍攝規格見 public/onboarding/README.md：打碼、憑證不可入鏡）
  2. 蓋掉 docs/onboarding-shots-src/ 對應的來源檔
  3. 對照新截圖調下面的座標（都是原圖座標），重跑本腳本

⛔ 動畫（get-token）不是錄影，是從整頁截圖裁「不同捲動位置的視窗」拼成的循環動畫——
   所以換截圖重跑就能重製，維護成本跟靜態圖同級。這是拍板用動畫的前提，別改成錄螢幕。
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'docs' / 'onboarding-shots-src'
OUT = ROOT / 'public' / 'onboarding'
RED = (224, 49, 58)


def load(name: str) -> Image.Image:
    return Image.open(SRC / name).convert('RGB')


def annotate(im: Image.Image, crop, boxes=(), badges=()) -> Image.Image:
    """裁切＋聚光標註。box/badge 座標都用「原圖」座標，這裡自動換算。

    聚光式（2026-08-19 改版）：目標保持原亮度、周圍輕微壓暗，框用細線——
    粗紅框被嫌「很俗」，壓暗周圍比加粗框更能把視線帶到目標，也不蓋到畫面內容。
    """
    im = im.crop(crop)
    ox, oy = crop[0], crop[1]

    if boxes:
        # 周圍壓暗 14%，目標區域（圓角矩形）維持原樣
        dark = Image.eval(im, lambda v: int(v * 0.86))
        mask = Image.new('L', im.size, 255)
        md = ImageDraw.Draw(mask)
        for (x1, y1, x2, y2) in boxes:
            md.rounded_rectangle((x1 - ox, y1 - oy, x2 - ox, y2 - oy), radius=10, fill=0)
        im = Image.composite(dark, im, mask)

    d = ImageDraw.Draw(im)
    for (x1, y1, x2, y2) in boxes:
        d.rounded_rectangle((x1 - ox, y1 - oy, x2 - ox, y2 - oy), radius=10, outline=RED, width=2)
    for (x, y, n) in badges:
        r = 13
        d.ellipse((x - ox - r, y - oy - r, x - ox + r, y - oy + r), fill=RED)
        d.text((x - ox, y - oy), str(n), fill=(255, 255, 255), anchor='mm', font_size=17)
    return im


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    # ── 靜態圖 ──────────────────────────────────────────────────
    # 帳號清單：只留三張卡那排，圈中間卡的「Messaging API」小字（同名雙卡認小字不認名稱）
    annotate(load('src-channel-list.jpg'), (270, 380, 1070, 700),
             boxes=[(560, 598, 725, 636)]).save(OUT / 'line-console-channel.png')

    # 發鑰匙：Messaging API 分頁最底的 Issue／Reissue 鈕
    annotate(load('src-messaging-api.jpg'), (240, 1868, 1330, 2065),
             boxes=[(1222, 1972, 1310, 2024)]).save(OUT / 'line-console-issue-token.png')

    # 第二把鑰匙：Basic settings 的 Channel secret 那一列
    annotate(load('src-basic-settings.jpg'), (240, 1555, 1330, 1800),
             boxes=[(275, 1648, 800, 1712)]).save(OUT / 'line-console-channel-secret.png')

    # Webhook：①貼網址的欄位 ②Use webhook 開關（編號對齊卡片步驟）
    annotate(load('src-messaging-api.jpg'), (240, 950, 1330, 1205),
             boxes=[(425, 1000, 710, 1090), (432, 1120, 510, 1168)],
             badges=[(745, 1043, 1), (545, 1144, 2)]).save(OUT / 'line-console-webhook-url.png')

    # 關自動回應：回應設定頁，圈「手動聊天」（新版介面沒有「聊天機器人」那組選項了）
    annotate(load('src-oam-response.jpg'), (250, 545, 1330, 950),
             boxes=[(542, 748, 756, 795)]).save(OUT / 'oam-auto-reply.png')

    # ── 循環動畫：切分頁 → 捲到底 → 按 Issue → 按複製 ──────────
    src = load('src-messaging-api.jpg')
    x0, x1, vh, target_w = 240, 1330, 620, 880

    def frame(top: int, box=None) -> Image.Image:
        im = src.crop((x0, top, x1, top + vh))
        if box:
            # 與靜態圖同一套聚光式標註（縮圖後線寬會除以 ~1.24，這裡畫粗一點）
            dark = Image.eval(im, lambda v: int(v * 0.86))
            mask = Image.new('L', im.size, 255)
            ImageDraw.Draw(mask).rounded_rectangle(
                (box[0] - x0, box[1] - top, box[2] - x0, box[3] - top), radius=10, fill=0)
            im = Image.composite(dark, im, mask)
            ImageDraw.Draw(im).rounded_rectangle(
                (box[0] - x0, box[1] - top, box[2] - x0, box[3] - top), radius=10, outline=RED, width=3)
        return im.resize((target_w, int(vh * target_w / (x1 - x0))))

    tab = (432, 332, 558, 378)          # Messaging API 分頁
    reissue = (1224, 1977, 1310, 2023)  # Issue／Reissue 鈕
    copy = (1120, 1984, 1176, 2032)     # 複製圖示

    spec = [
        (90, tab, 1600),      # 停：切到 Messaging API 分頁
        (280, None, 130),     # 捲動帶過…
        (560, None, 130),
        (900, None, 130),
        (1220, None, 130),
        (1450, None, 300),
        (1450, reissue, 1900),  # 停：最下面按 Issue 發鑰匙
        (1450, copy, 1900),     # 停：按複製
    ]
    frames = [frame(t, b) for t, b, _ in spec]
    frames[0].save(OUT / 'line-console-get-token.webp', save_all=True,
                   append_images=frames[1:], duration=[d for _, _, d in spec],
                   loop=0, quality=82, method=4)

    for f in sorted(OUT.iterdir()):
        if f.suffix in ('.png', '.webp'):
            print(f'{f.name:44s} {f.stat().st_size // 1024:>4d} KB')


if __name__ == '__main__':
    main()
