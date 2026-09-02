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

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'docs' / 'onboarding-shots-src'
OUT = ROOT / 'public' / 'onboarding'

# 標註樣式（2026-09-02 老闆拍板 B+C）
DIM = 0.82        # 周圍壓暗 18%（08-19 拍板的聚光，沒動）
RED = (180, 84, 78)     # 低飽和磚紅 #B4544E：框線與編號徽章同一個色
GREEN = (62, 142, 95)   # 同一階飽和度的綠：只用在「就是這個」的對照圖
BORDER_W = 2      # 框線寬（**縮圖後**的實際像素，見下）
BADGE_R = 12

TARGET_W = 880    # 動畫輸出寬度
VH = 620          # 動畫的「視窗」高度（＝在原圖上裁多高當一格畫面）


def load(name: str) -> Image.Image:
    return Image.open(SRC / name).convert('RGB')


def shot(src_im: Image.Image, crop, marks=(), out_w=None, counter=None, blur=()) -> Image.Image:
    """裁切 → 聚光 → 低飽和紅細框 → 編號徽章 → 右下角「第幾格／共幾格」。

    marks: [(box, n)] 或 [(box, n, style)]，box=(x1, y1, x2, y2) 用**原圖**座標；
           n=None＝只框不編號。style 預設 'focus'（紅框）；'pick'＝綠框「就是這個」、
           'reject'＝紅框加一個大叉「不是這個」。
    ⛔ 綠／紅不可以是唯一的差別（色盲看不出來），所以 reject 一定要畫叉——
       那個叉才是「不要點」的訊號，顏色只是加強。
    counter: (第幾格, 共幾格)；只有一個停格的圖不要給——一格的進度沒有資訊，
             只是多一個要讀的東西。

    標註史（別再繞回去）：
      2026-08-19 粗紅框被嫌「很俗」→ 改聚光＋細框 → 細框也拔掉，只剩壓暗。
      2026-09-02 老闆實測回饋：LINE 後台是白底，聚光後的目標**也是白的**，只比周圍
      亮 18%，在對話卡片裡（實際顯示約 630px 寬）要找一兩秒。拍板加回框線，但
      **低飽和磚紅、2px、圓角**——被嫌俗的是飽和粗紅框，不是「有框」這件事。
      同一輪加編號徽章：一支動畫演三四個動作、又是循環播放，中途接上的人不知道
      自己看到的是第幾步。編號是唯一能把「旁邊那句話」跟「這一格畫面」綁起來的東西。

    blur: [(x1, y1, x2, y2)] 原圖座標，先把這些區域糊掉再做別的。用來遮**真實客戶的
          帳號名稱與頭像**——`public/onboarding/` 是對外公開網址，那些東西推上去就收不回來。
    ⛔ 用糊的不用色塊：這幾張圖的重點正是「列表長這樣」，蓋成一塊灰色等於把要教的東西也蓋掉；
       糊掉只讓字認不出來，版面結構還在。

    ⛔ 框線與徽章一律在 resize **之後**才畫。畫在原圖上會跟著被縮小（這裡的縮放約
       0.81 倍），2px 會變成 1.6px 的糊線，而且每支動畫的縮放比還不一樣。
    """
    ox, oy = crop[0], crop[1]
    if blur:
        src_im = src_im.copy()
        for (x1, y1, x2, y2) in blur:
            box = (x1, y1, x2, y2)
            src_im.paste(src_im.crop(box).filter(ImageFilter.GaussianBlur(7)), box)
    im = src_im.crop(crop)

    if marks:
        dark = Image.eval(im, lambda v: int(v * DIM))
        mask = Image.new('L', im.size, 255)
        md = ImageDraw.Draw(mask)
        for mark in marks:
            x1, y1, x2, y2 = mark[0]
            md.rounded_rectangle((x1 - ox, y1 - oy, x2 - ox, y2 - oy), radius=10, fill=0)
        im = Image.composite(dark, im, mask)

    k = 1.0 if out_w is None else out_w / im.width
    if out_w is not None:
        im = im.resize((out_w, round(im.height * k)))
    d = ImageDraw.Draw(im)

    for mark in marks:
        (x1, y1, x2, y2), n = mark[0], mark[1]
        style = mark[2] if len(mark) > 2 else 'focus'
        colour = GREEN if style == 'pick' else RED
        rx1, ry1 = (x1 - ox) * k, (y1 - oy) * k
        rx2, ry2 = (x2 - ox) * k, (y2 - oy) * k
        d.rounded_rectangle((rx1, ry1, rx2, ry2), radius=8, outline=colour, width=BORDER_W)
        if style == 'reject':
            # 兩條對角線＝「不要點這個」。往內縮一點畫，卡片內容還看得見
            pad = 10
            d.line((rx1 + pad, ry1 + pad, rx2 - pad, ry2 - pad), fill=colour, width=BORDER_W + 1)
            d.line((rx2 - pad, ry1 + pad, rx1 + pad, ry2 - pad), fill=colour, width=BORDER_W + 1)
        if n is None:
            continue
        # 徽章壓在框的左上角；貼到圖邊時往內縮，不然會被裁掉半顆
        cx = min(max(rx1, BADGE_R + 1), im.width - BADGE_R - 1)
        cy = min(max(ry1, BADGE_R + 1), im.height - BADGE_R - 1)
        d.ellipse((cx - BADGE_R, cy - BADGE_R, cx + BADGE_R, cy + BADGE_R), fill=colour)
        d.text((cx, cy), str(n), fill=(255, 255, 255), anchor='mm', font_size=16)

    if counter:
        i, total = counter
        pw, ph = 60, 24
        px, py = im.width - pw - 12, im.height - ph - 12
        d.rounded_rectangle((px, py, px + pw, py + ph), radius=12, fill=RED)
        d.text((px + pw / 2, py + ph / 2), f'{i} / {total}',
               fill=(255, 255, 255), anchor='mm', font_size=15)
    return im


STEPS: dict[str, int] = {}   # 檔名 → 圖上有幾顆編號徽章（0＝沒編號）


def build_anim(name: str, spec, x0: int = 240, x1: int = 1330) -> None:
    """spec: [(來源圖, 捲到哪, box 或 None, 停多久 ms[, 這一幀的左邊界])]。

    第五個元素＝**只有這一幀**要換左邊界。用在同一支動畫混用不同時期的截圖：
    新截圖的 LINE Developers 側欄比舊的窄，照舊的 x0 裁會把內容左半切掉。
    ⛔ 寬度一律沿用預設的 (x1 - x0)，右邊界自己算——**每一幀的畫布尺寸必須一模一樣**，
       差一個像素 webp 動畫就拼不起來（不是變醜，是拼不起來）。

    有 box 的幀＝一個「停格」，自動接續編號並在右下角標「第幾格／共幾格」；
    box=None 的幀是開場與捲動帶過，不編號也不標進度（130ms 閃過的東西標了只會抖）。
    只有一個停格的動畫整支不編號。
    """
    stops = sum(1 for entry in spec if entry[2])
    numbered = stops > 1
    width = x1 - x0
    frames, durations, i = [], [], 0
    for entry in spec:
        src_im, top, box, ms = entry[0], entry[1], entry[2], entry[3]
        fx0 = entry[4] if len(entry) > 4 else x0
        n = counter = None
        if box:
            i += 1
            if numbered:
                n, counter = i, (i, stops)
        marks = [(box, n)] if box else []
        frames.append(shot(src_im, (fx0, top, fx0 + width, top + VH), marks,
                           out_w=TARGET_W, counter=counter))
        durations.append(ms)
    sizes = {f.size for f in frames}
    assert len(sizes) == 1, f'{name}: 幀尺寸不一致 {sizes}——webp 動畫會拼不起來'
    frames[0].save(OUT / name, save_all=True, append_images=frames[1:],
                   duration=durations, loop=0, quality=82, method=4)
    STEPS[name] = stops if numbered else 0


def write_steps_manifest() -> None:
    """把「每張圖上有幾顆編號」寫成 TS 常數，給測試對照文案裡的①②③。

    為什麼要有這個檔：圖上的號碼跟文案裡的號碼是兩個檔案裡的兩份資料，改了一邊
    不會有任何東西變紅——只有使用者會看到③指到別的動作。有這份清單，
    `shared/onboarding-shot-steps.test.ts` 才驗得起來。⛔手改無效，跑腳本才會更新。
    """
    lines = [
        '/**',
        ' * 每張開通引導示意圖上有幾顆編號徽章（0＝整張沒編號）。',
        ' *',
        ' * ⛔ 這個檔是 `scripts/make-onboarding-shots.py` 產生的，不要手改——',
        ' *    改圖的步數要改腳本重跑，這裡才會跟著動。',
        ' */',
        'export const ONBOARDING_SHOT_STEPS: Record<string, number> = {',
    ]
    for k in sorted(STEPS):
        lines.append(f"  '{k}': {STEPS[k]},")
    lines.append('}')
    (ROOT / 'shared' / 'onboarding-shot-steps.ts').write_text('\n'.join(lines) + '\n')


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    lst = load('src-channel-list.jpg')          # 帳號清單（同名雙卡）
    api = load('src-messaging-api.jpg')         # Messaging API 分頁整頁
    bs = load('src-basic-settings.jpg')         # Basic settings 分頁整頁
    oam = load('src-oam-response.jpg')          # 官方帳號後台的回應設定
    login = load('src-line-login-channel-DO-NOT-USE.jpg')  # 這張的正途：教 LIFF 在哪

    # 常用目標（原圖座標）
    card_mapi = (556, 595, 714, 640)      # 清單中間卡的「Messaging API」小字
    card_login = (812, 598, 922, 636)     # 清單右邊卡的「LINE Login」小字
    tab_mapi = (432, 332, 558, 378)       # Messaging API 分頁
    tab_mapi_bs = (435, 330, 560, 372)    # 同一顆，但在 Basic settings 頁的座標
    tab_bs = (295, 330, 420, 372)         # Basic settings 分頁
    tab_liff = (538, 330, 588, 372)       # LIFF 分頁
    reissue = (1224, 1977, 1310, 2023)    # Channel access token 的 Issue／Reissue
    copy_icon = (1120, 1984, 1176, 2032)  # 複製圖示
    secret_row = (270, 1651, 800, 1715)   # Channel secret 那一列
    wh_edit = (512, 1042, 594, 1086)      # Webhook URL 的 Edit 鈕
    wh_url = (425, 1000, 710, 1090)       # Webhook URL 欄位＋Update
    wh_toggle = (434, 1117, 511, 1174)    # Use webhook 開關

    # ── 靜態圖 ──────────────────────────────────────────────────
    def save_static(name: str, im: Image.Image, steps: int = 0) -> None:
        im.save(OUT / name)
        STEPS[name] = steps

    # 帳號清單（修復劇本用；教學用下面的動畫版）：圈中間卡的「Messaging API」小字
    save_static('line-console-channel.png',
                shot(lst, (270, 380, 1070, 700), [(card_mapi, None)]))

    # 發鑰匙：Messaging API 分頁最底的 Issue／Reissue 鈕
    save_static('line-console-issue-token.png',
                shot(api, (240, 1868, 1330, 2065), [(reissue, None)]))

    # Webhook 全景（修復劇本用）：①貼網址的欄位 ②Use webhook 開關。
    # ⚠️這張的①②是**它自己的**編號（「這裡有兩樣東西」），跟動畫的編號無關——
    # 它被三支修復劇本共用，那些劇本的文字沒有引用號碼。開通引導不用這張。
    save_static('line-console-webhook-url.png',
                shot(api, (240, 950, 1330, 1205), [(wh_url, 1), (wh_toggle, 2)]), steps=2)

    # Use webhook 開關（開通引導第三步專用）：上面留著網址那一列當定位，只圈開關。
    # 為什麼另外裁一張：接線教學拆成「貼網址」「開開關」兩步之後，第三步再拿上面那張
    # ①②全景，會讓人以為這一步要做兩件事（2026-09-02）。
    save_static('line-console-use-webhook.png',
                shot(api, (240, 980, 1330, 1205), [(wh_toggle, None)]))

    # 認錯卡對照【LIFF 版】：跟上面那張正好相反——LIFF 住在「LINE Login」那張卡下面。
    # 為什麼要獨立一張而不是共用上面那張：拿鑰匙教人「別點 LINE Login」，設 LIFF 教人
    # 「就是要點 LINE Login」。同一張圖不可能同時講兩件相反的事，共用就是把人教錯
    #（2026-08-19 `D-17` 盤點抓到的那個「兩份教學互打」）。
    save_static('line-console-which-card-liff.png',
                shot(lst, (520, 370, 1080, 710),
                     [((806, 386, 1044, 692), None, 'pick'),
                      ((548, 386, 784, 692), None, 'reject')]))

    # ── 官方帳號後台（manager.line.biz，中文介面）──────────────
    # 「啟用 Messaging API」：走「清單裡沒看到我的帳號？」那條岔路的人要看的那一頁。
    # ⚠️狀態必須是「未使用」——已經啟用過的帳號那頁沒有這顆按鈕（2026-09-02 老闆為此
    # 特地開了一個全新的測試官方帳號來拍）
    oam_enable = load('src-oam-enable-messaging-api.jpg')
    save_static('oam-enable-messaging-api.png',
                shot(oam_enable, (200, 100, 1180, 430),
                     [((690, 366, 913, 408), None)],
                     blur=[(1140, 16, 1268, 42), (306, 16, 396, 36)]))

    # 帳號一覽：「你已經有 LINE 官方帳號了嗎？」那一題的配圖（列表裡有帳號＝就是有）
    # ⛔ 三列都是**真實客戶**的帳號名稱與頭像，一定要糊掉
    oam_list = load('src-oam-account-list.jpg')
    save_static('oam-account-list.png',
                shot(oam_list, (250, 190, 1230, 510),
                     [((296, 266, 1190, 500), None)],
                     blur=[(308, 336, 462, 372), (308, 398, 478, 434),
                           (308, 460, 435, 495), (1214, 14, 1340, 40)]))

    # ── LIFF（LINE Login 那張卡底下）──────────────────────────
    liff_list = load('src-liff-list.jpg')
    liff_add = load('src-liff-add.jpg')

    # 認錯卡對照圖（2026-09-02 新增）：全流程唯一「照著做也會錯」的地方。
    # 點到 LINE Login 那張卡，Basic settings 裡**也有**一個 Channel secret，貼進來系統照收，
    # 然後客人每句話都被當成假冒的丟掉——而且畫面上一切正常，沒有任何地方會亮紅。
    # 兩張卡本來就並排在同一張截圖裡，不用重截。
    save_static('line-console-which-card.png',
                shot(lst, (520, 370, 1080, 710),
                     [((548, 386, 784, 692), None, 'pick'),
                      ((806, 386, 1044, 692), None, 'reject')]))

    # ── 循環動畫 ────────────────────────────────────────────────
    # 帳號清單：先看整頁（含麵包屑，知道自己在哪）再聚焦小字。
    # 只有一個動作 → 不編號（build_anim 會自己判斷）
    build_anim('line-console-channel.webp', [
        (lst, 84, None, 1100),
        (lst, 84, card_mapi, 2400),
    ])

    # 拿第一把鑰匙：①切分頁 →（捲到底）→ ②按 Issue → ③按複製
    build_anim('line-console-get-token.webp', [
        (api, 90, None, 900),        # 開場：先看正常畫面（跟使用者瀏覽器裡一樣）
        (api, 90, tab_mapi, 1600),   # ①切到 Messaging API 分頁
        (api, 280, None, 130),       # 捲動帶過…
        (api, 560, None, 130),
        (api, 900, None, 130),
        (api, 1220, None, 130),
        (api, 1450, None, 300),
        (api, 1450, reissue, 1900),  # ②最下面按 Issue 發鑰匙
        (api, 1450, copy_icon, 1900),  # ③按複製
    ])

    # 拿第二把鑰匙：①切 Basic settings →（捲下來）→ ②Channel secret 那一列。
    # 為什麼是動畫不是那張列圖：緊裁的一列缺「從哪裡來」的定位，使用者對不出
    # 這個欄位在頁面的什麼地方（2026-08-19 老闆實測回饋）
    build_anim('line-console-channel-secret.webp', [
        (bs, 90, None, 900),
        (bs, 90, tab_bs, 1600),      # ①切到 Basic settings 分頁
        (bs, 300, None, 130),        # 捲動帶過…
        (bs, 620, None, 130),
        (bs, 980, None, 130),
        (bs, 1300, None, 300),
        (bs, 1300, secret_row, 2200),  # ②就是這一列，整串複製
    ])

    # 關內建自動回應：①右上「設定」→ ②側欄「回應設定」→ ③選「手動聊天」。
    # 這支含側欄（x 從 0 起）：側欄本身就是導航故事的一部分
    build_anim('oam-auto-reply.webp', [
        (oam, 0, None, 900),
        (oam, 0, (1264, 53, 1344, 94), 1500),   # ①右上「設定」
        (oam, 0, (44, 213, 190, 247), 1500),    # ②側欄「回應設定」
        (oam, 200, None, 130),                  # 捲動帶過…
        (oam, 420, None, 130),
        (oam, 610, None, 300),
        (oam, 610, (546, 750, 652, 792), 2400),  # ③選「手動聊天」
    ], x0=0, x1=1352)

    # 貼 Webhook 網址：①選對卡 → ②切分頁 →（捲下來）→ ③按 Edit → ④貼上按 Update。
    # 跨三頁的真實路徑（同名雙卡是最大雷點，教學開頭就要處理）。
    # ⛔ 2026-09-02 重裁：原本最後還演到「打開 Use webhook」，但那是教學的**下一步**，
    #    看得見畫面的人會提前做完、讀螢幕的人拿到的描述跟指令互相矛盾（08-28 就記了
    #    這個洞，等重裁）。加編號之後這個矛盾會直接寫在畫面上，所以一起收掉：
    #    動畫停在④存檔，開關那一步用 line-console-use-webhook.png。
    build_anim('line-console-webhook.webp', [
        (lst, 84, None, 900),           # 開場：帳號清單正常畫面
        (lst, 84, card_mapi, 1800),     # ①點掛「Messaging API」小字的那張卡
        (bs, 90, tab_mapi_bs, 1800),    # ②進來後切「Messaging API」分頁
        (api, 90, None, 250),           # 落在 Messaging API 分頁，捲動帶過…
        (api, 520, None, 130),
        (api, 950, None, 300),
        (api, 950, wh_edit, 1600),      # ③先按「Edit」打開輸入格（第一次的人沒這步會卡住）
        (api, 950, wh_url, 2200),       # ④貼上網址按 Update 存檔
    ])

    # 建活動頁 LIFF——2026-09-02 補齊後半段（老闆補拍了 LIFF 清單與 Add 表單）。
    # ⚠️LIFF 住在「LINE Login」那張卡下面——跟拿鑰匙相反，動畫開頭就要把卡選對。
    # ⚠️④ 那一格是整支教學的重點：Endpoint URL 填錯，客人點活動連結會卡在轉圈，
    #    貼標與綁定完全不會發生（LINE 一定把人送回這裡登記的網址，跟分享的連結網域無關）。
    build_anim('line-console-liff-setup.webp', [
        (lst, 84, None, 900),
        (lst, 84, card_login, 1800),                    # ①點掛「LINE Login」小字的那張卡
        (login, 90, tab_liff, 1800),                    # ②切「LIFF」分頁
        # ⚠️這兩張是 09-02 新拍的，側欄比舊截圖窄——左邊界要往左挪，否則內容左半被切掉
        (liff_list, 136, (745, 705, 789, 737), 1800, 200),   # ③按「Add」
        (liff_add, 70, (337, 118, 1000, 156), 2800, 200),    # ④Endpoint URL 貼活動頁網址
    ])

    write_steps_manifest()

    for f in sorted(OUT.iterdir()):
        if f.suffix in ('.png', '.webp'):
            print(f'{f.name:44s} {f.stat().st_size // 1024:>4d} KB')


if __name__ == '__main__':
    main()
