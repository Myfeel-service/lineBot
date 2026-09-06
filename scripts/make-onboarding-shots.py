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


def build_anim(name: str, spec, x0: int = 240, x1: int = 1330, vh: int = VH) -> None:
    """spec: [(來源圖, 捲到哪, box 或 None, 停多久 ms[, 這一幀的左邊界])]。

    第五個元素＝**只有這一幀**要換左邊界。用在同一支動畫混用不同時期的截圖：
    新截圖的 LINE Developers 側欄比舊的窄，照舊的 x0 裁會把內容左半切掉。
    ⛔ 寬度一律沿用預設的 (x1 - x0)，右邊界自己算——**每一幀的畫布尺寸必須一模一樣**，
       差一個像素 webp 動畫就拼不起來（不是變醜，是拼不起來）。

    有 box 的幀＝一個「停格」，自動接續編號並在右下角標「第幾格／共幾格」；
    box=None 的幀是開場與捲動帶過，不編號也不標進度（130ms 閃過的東西標了只會抖）。
    只有一個停格的動畫整支不編號。

    vh＝視窗高度（預設 620）。**彈窗流程要調高**：對話框比一般欄位高得多
    （啟用 Messaging API 那三關最高的一個是 578px），照 620 裁會上下各只剩幾十像素、
    看起來像貼著邊。⛔ 一支動畫裡所有幀共用同一個 vh，不可以逐幀改。
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
        frames.append(shot(src_im, (fx0, top, fx0 + width, top + vh), marks,
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

    # ── 2026-09-06 新批：**還沒設定過**的畫面（老闆用 CITY PLAY 測試頻道從零走一次拍的）──
    #
    # 為什麼非要這批不可：上面那幾張全是「早就設定完成」的帳號，所以教學圖跟文案一直對不起來——
    # 叫人按「Issue」畫面上寫的卻是「Reissue」、叫人按「Update」畫面上根本沒有那顆鈕、
    # 叫人「打開 Use webhook」畫面上它已經是綠的、叫人複製 Channel secret 那一列卻是空的。
    #
    # ⚠️ 這批是**視窗截圖（756 高）**，不是整頁截圖（2223 高）——所以只能當**停格**用，
    #    不能拿來做捲動幀（`top` 最多到 136，再多就裁出黑邊）。捲動仍然吃上面的整頁截圖，
    #    但捲動要**在露出目標區塊之前停住**，否則會先閃過舊的（已設定）狀態，
    #    人剛看到「Reissue」下一格就被叫去按「Issue」。
    tok0 = load('src-token-empty.jpg')        # token 還沒發：一顆 Issue、沒有複製圖示
    tok1 = load('src-token-issued.jpg')       # 按完 Issue：token 出現＋複製圖示＋按鈕變 Reissue
    wh0 = load('src-webhook-empty.jpg')       # Webhook URL 全空：只有一顆 Edit
    wh1 = load('src-webhook-editing.jpg')     # 按完 Edit：輸入格＋網址＋Update／Cancel
    wh2 = load('src-webhook-saved.jpg')       # 按完 Update：網址存好，Use webhook 仍是灰的
    bs2 = load('src-basic-settings-secret.jpg')   # Channel secret 那一列**有值**（值已模糊）
    warn = load('src-secret-issue-warning.jpg')   # 按到 Channel secret 旁邊那顆 Issue 的確認框

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

    # 2026-09-06 新批上的目標（都是新來源檔自己的座標，跟上面那組不通用）
    NEW_TOP = 136                         # 這批只有 756 高，VH=620 → top 最多 136
    n_issue = (283, 519, 350, 562)        # token 還沒發時那顆 Issue
    n_copy = (1130, 524, 1170, 566)       # 按完 Issue 之後才出現的複製圖示
    n_wh_edit = (333, 428, 394, 462)      # 空的 Webhook URL 底下那顆 Edit
    n_wh_url = (443, 198, 1307, 374)      # 輸入格＋網址＋Update（④要做的整件事）
    n_wh_toggle = (444, 664, 500, 700)    # 存好之後才要開的 Use webhook（灰的）
    n_secret_row = (283, 262, 750, 304)   # Channel secret 那一列（有值）
    n_secret_issue = (1244, 264, 1309, 302)   # ⛔ 同一列右邊那顆 Issue：按了線就斷
    n_secret_modal = (334, 287, 1018, 474)    # 按下去跳出來的確認框（這張圖真正要讀的東西）

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

    # ── Google 試算表：把 FAQ 範本變成「改了自動更新」的資料來源（`C-106`）──
    #
    # 為什麼這四張可以用真截圖，而後台自己的畫面不行：**這是站外畫面**。我們的聚光燈導覽
    # 指不到 Google 的介面，使用者是在另一個網站上找按鈕（08-28 拍板：站內不配圖、站外要配圖）。
    # 這四張取代了我 09-03 憑記憶畫的示意圖——那張畫錯四處（欄位名、權限下拉位置、
    # 通知預設打勾、訊息框），正是「憑記憶畫別人的 UI」的風險。
    #
    # ⛔ **打碼**：`public/onboarding/` 是對外公開網址。母本擁有者的 email 與頭像
    #    （`service@myfeel-tw.com`／MYFEEL 圓標）一律糊掉——那是公司帳號，推上去就收不回來。
    #    ⛔ 用糊的不用色塊（見 shot 的說明）：糊掉只讓字認不出來，版面結構還在。
    # ⚠️ 服務帳號那串 `firebase-adminsdk-fbsvc@…` **不打碼**：它本來就要給客戶看、
    #    畫面上也是它，糊掉這張圖就失去意義。
    gs_copy = load('src-gsheet-copy.png')       # /copy 的「複製文件」頁
    gs_tpl = load('src-gsheet-template.png')    # 副本開起來（FAQ ＋使用說明分頁）
    gs_sh1 = load('src-gsheet-share-1.png')     # 共用視窗第一態
    gs_sh2 = load('src-gsheet-share-2.png')     # 貼上服務帳號後（權限＝編輯者）

    # 右上角使用者頭像（四張都有，座標一致）
    avatar = (2570, 30, 2650, 105)

    # ① 複製文件：只有一顆「建立副本」，不編號（一格的進度沒有資訊）
    save_static('gsheet-copy.png',
                shot(gs_copy, (600, 200, 2100, 780), [((672, 664, 806, 726), None)], out_w=880))

    # ② 副本長什麼樣。
    #
    # ⛔ **這張不打標註也不打聚光**（跟下面兩張的處理刻意不同）：它的作用是「檔案長這樣」，
    #    整張圖都是內容；而 `shot()` 只要給了 marks 就會把框外壓暗 18%，那會把要讀的
    #    示範問答一起壓暗——聚光是給「在一堆東西裡找一顆按鈕」用的，不是給參考圖用的。
    # ⚠️ 第一版裁 (0,300)–(2704,1444) 並標三個號，實測是壞的：標題列被切掉半個字、
    #    ①②的徽章因為只差 50px 疊在一起、而且下半張是一大片空白列。改成只裁資料那一條。
    save_static('gsheet-template.png',
                shot(gs_tpl, (60, 280, 1560, 600), out_w=880))
    # ⚠️ 右邊界 1560 不是 2200：裁到 2200 會把空白的 C 欄一起收進來，
    #    等比縮到 880 之後表格裡的字只剩約 7px（實測讀不到，同 `G-33` 手機截圖那個教訓）。

    # ③④⑤ 共用流程＝三條**緊裁窄條**，一條一個動作。
    #
    # ⚠️ 2026-09-03 老闆反映「紅框的樣式應該要跟創建時的粗細一樣」。實測比對後找到真因：
    #    **不是框線寬度不同**（PNG 裡兩批都是 2px，量過），是**裁切的廣角程度不同**。
    #    LINE 那批都是緊貼目標的窄長條（例：webhook-url 是 1090×255），框幾乎貼著元件；
    #    我第一版把整個 Google 對話框收進來（1030×910），在同樣的顯示寬度下所有東西
    #    都被縮小，2px 框看起來就像髮絲線、徽章也變小。
    # ⛔ 所以修法不是把框加粗（那會讓兩批的框變成兩種粗細），而是**照 LINE 那批的鏡位重裁**：
    #    一條窄長條只講一個動作。順帶好處：三條窄圖加起來比原本兩張大圖還矮。
    # ⚠️ 「通知共用對象可以不勾」不再標框——它是可選的小事，標了會跟真正的關鍵步驟搶注意力
    #    （關鍵是「權限預設是編輯者，要改成檢視者」）。那句話留在文字裡。
    #
    # ① 貼帳號：標最上面那一格（此時還沒貼，欄位是空的）
    save_static('gsheet-share-1.png',
                shot(gs_sh1, (841, 300, 1863, 600),
                     [((860, 462, 1850, 580), 1)],
                     out_w=880, blur=[avatar]))

    # ② 改權限：這是最容易漏的一步——Google 貼上後**預設是「編輯者」**
    save_static('gsheet-share-2.png',
                shot(gs_sh2, (841, 415, 1863, 600),
                     [((1590, 448, 1826, 556), 2)],
                     out_w=880, blur=[avatar]))

    # ③ 按傳送：只裁對話框最下面那一條
    save_static('gsheet-share-3.png',
                shot(gs_sh2, (841, 1010, 1863, 1160),
                     [((1655, 1053, 1826, 1137), 3)],
                     out_w=880, blur=[avatar]))

    # Webhook 全景（修復劇本用）：①貼網址的欄位 ②Use webhook 開關。
    # ⚠️這張的①②是**它自己的**編號（「這裡有兩樣東西」），跟動畫的編號無關——
    # 它被三支修復劇本共用，那些劇本的文字沒有引用號碼。開通引導不用這張。
    save_static('line-console-webhook-url.png',
                shot(api, (240, 950, 1330, 1205), [(wh_url, 1), (wh_toggle, 2)]), steps=2)

    # Use webhook 開關（開通引導第三步專用）：上面留著網址那一列當定位，只圈開關。
    # 為什麼另外裁一張：接線教學拆成「貼網址」「開開關」兩步之後，第三步再拿上面那張
    # ①②全景，會讓人以為這一步要做兩件事（2026-09-02）。
    # ⚠️ 2026-09-06 換來源：舊的那張是拿「早就設定完成」的帳號截的，**開關已經是綠的**——
    #    這一步要教的正是「把它打開」，圖上卻已經開了。新來源是剛按完 Update 的真實狀態：
    #    網址存好（Verify／Edit）、開關**還是灰的**。
    save_static('line-console-use-webhook.png',
                shot(wh2, (240, 530, 1330, 715), [(n_wh_toggle, None)]))

    # ⛔ 兩顆都叫「Issue」的雷（2026-09-06 老闆補拍時自己按錯才發現）：
    #    Messaging API 分頁最底那顆發 Access Token（按了沒事，就是重發一把）；
    #    Basic settings 裡 Channel secret 旁邊那顆**重發 Channel Secret**——按下去
    #    已經接好的線當場斷、畫面上看不出異常、而且一小時內換不回來。
    #    這張的用途是「看到這個框就是按錯了，按 Cancel」，所以彈窗本身不框（要讀）、
    #    只在那顆 Issue 上打叉。
    #    ⚠️ 第一版只框那顆 Issue，實測是壞的：那顆在最右上角、被裁掉一半，而且
    #       `shot()` 一有 marks 就把框外壓暗 18%，把**要讀的彈窗文字**一起壓成灰的。
    #       改成兩個框——彈窗本身圈起來（要讀，所以不能被壓暗）、那顆 Issue 打叉（訊號是叉不是顏色）。
    save_static('line-console-secret-issue-warning.png',
                shot(warn, (250, 238, 1340, 500),
                     [(n_secret_modal, None), (n_secret_issue, None, 'reject')]))

    # ── 官方帳號後台（中文）也能做的兩件事（2026-09-06 老闆實測：跟 LINE Developers 同步）──
    #
    # ⛔ 為什麼要把這兩步搬過來：LINE Developers 的同名雙卡是全流程**唯一「照著做也會錯」**
    #    的地方——挑錯那張卡，它的 Basic settings **也有**一個 Channel secret，貼進來系統照收，
    #    然後客人每句話都被當成假冒的丟掉，而且畫面上一切正常。中文後台這一頁**沒有卡片可以挑**
    #    （它就是「這個帳號」的設定頁），錯誤機會直接消失，`which-card` 那張警告圖也不用了。
    # ⚠️ 兩顆「複製」上下相鄰（Channel ID 一顆、Channel secret 一顆），所以框**整列**不框按鈕——
    #    只圈按鈕的話一眼看過去分不出是哪一列的。
    # ⛔ 2026-09-06 第一版做成**緊裁的一列靜態圖**，老闆一看就說「根本不知道在哪裡」——
    #    而這正是本 README 寫著的規矩：「緊裁的一列靜態圖缺『從哪裡來』的定位，使用者對不出
    #    這個欄位在頁面的什麼地方；靜態緊裁圖只用在**已經知道位置、回去再看一眼**的場景」。
    #    第一次來的人不知道位置，所以跟其他教學一樣改成**帶路動畫**（含側欄與頁首，x0=0）。
    oam_api = load('src-oam-messaging-api.jpg')
    oam_settings = (1252, 56, 1334, 90)      # 右上角齒輪「設定」
    oam_mapi_nav = (45, 252, 235, 282)       # 左欄「Messaging API」

    # 拿第二組連線資訊：①右上設定 → ②左欄 Messaging API → ③Channel secret 那一列按複製
    # ⚠️ 框整列不框按鈕：Channel ID 與 Channel secret 各有一顆「複製」且上下相鄰，
    #    只圈按鈕的話一眼看過去分不出是哪一列的。
    build_anim('oam-channel-secret.webp', [
        (oam_api, 0, None, 900),
        (oam_api, 0, oam_settings, 1500),
        (oam_api, 0, oam_mapi_nav, 1500),
        (oam_api, 0, (466, 354, 998, 394), 2400),
    ], x0=0, x1=1352)

    # 貼網址：**從頭走一次**（①右上設定 → ②左欄 Messaging API → ③貼網址 → ④儲存）。
    #
    # ⚠️ 2026-09-07 老闆拍板**恢復導航**（推翻我 09-06「同一頁不重演」的裁切）——理由是成立的：
    #    上一步跟這一步**中間離開過**（回 MiniMe 貼 Channel secret、再複製 Webhook 網址），
    #    回來的時候人可能已經不在那一頁了，重新帶路不是重複、是接住迷路的人。
    # ⛔ 「回應設定」那支維持不含「點設定」（同一輪老闆自己抓的重複）：那一步跟這一步之間
    #    沒有離開 OA 後台，兩個決定不衝突——**判準是「中間有沒有離開」，不是「同不同一頁」**。
    # ⚠️ 貼上與存檔分成兩格：「貼了沒按儲存」是接不通的第一名，值得自己一格。
    build_anim('oam-webhook-url.webp', [
        (oam_api, 0, None, 900),
        (oam_api, 0, oam_settings, 1500),        # ①右上「設定」
        (oam_api, 0, oam_mapi_nav, 1500),        # ②左欄「Messaging API」
        (oam_api, 0, (466, 408, 930, 452), 1800),  # ③貼進「Webhook網址」
        (oam_api, 0, (928, 410, 996, 450), 2000),  # ④按「儲存」
    ], x0=0, x1=1352)

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
    # ⛔ 動畫的每一幀都要**自己**遮過：`shot()` 的 blur 參數是逐次呼叫的，
    #    `build_anim` 沒有那個入口。第一版忘了這件事，動畫第①格把頂列的加好友 ID
    #    與右上角個人名字**原封推上公開網址**（靜圖版有遮、動畫版沒有）。
    #    另外三張在 `mask-onboarding-src.py` 已經先遮好了，只有這張是沿用舊來源檔。
    oam_head = [(1140, 16, 1268, 42), (306, 16, 396, 36)]
    oam_enable_anim = oam_enable.copy()
    for _b in oam_head:
        oam_enable_anim.paste(oam_enable_anim.crop(_b).filter(ImageFilter.GaussianBlur(7)), _b)
    oam_prov = load('src-oam-enable-provider.jpg')     # 彈窗①選擇服務提供者
    oam_priv = load('src-oam-enable-privacy.jpg')      # 彈窗②隱私權政策及服務條款
    oam_conf = load('src-oam-enable-confirm.jpg')      # 彈窗③最後確認
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
    # 帳號清單：①登入頁 → 整頁清單（含麵包屑，知道自己在哪）→ 聚焦小字。
    #
    # 登入頁那一格是 2026-09-07 老闆要求補的（「把真實登入的那一段也錄進去」）。
    # ⛔ 那一格**刻意零標註**：08-19 拍板「登入頁不配圖」的真正理由是**圈哪顆按鈕都會誤導
    #    用其他方式登入的人**（LINE帳號／電子郵件／通行金鑰三種都有人用，09-06 也再拍板過
    #    文案維持「用你平常的方式登入」）。現在把頁面放進來當**定位**（他知道自己會先看到這頁、
    #    三種方式都看得到），但不圈任何一顆——兩個拍板都守住。
    # ⚠️ 這一格沒有個人資訊（還沒登入），不用打碼。
    # ⚠️ 登入頁那一格**要自己的左邊界**（2026-09-07 老闆抓到「圖片是歪的」）：這頁的內容置中在
    #    x≈675，沿用帳號清單的裁切窗（x0=240）會讓整塊登入區偏在畫面左邊。x0=130 才會置中。
    # ⚠️ 紅框**框整組三顆登入鈕**、不框單顆（同輪老闆問「是否也用紅框示意」）：有框＝跟其他
    #    停格視覺一致；框整組＝不指定登入方式，08-19「圈哪顆都會誤導用其他方式登入的人」照樣守住。
    #    加了框之後這支變成兩個停格 → 自動編號①②，文案要跟著用同一組號碼。
    login_pg = load('src-login.jpg')
    build_anim('line-console-channel.webp', [
        (login_pg, 80, (492, 336, 860, 556), 2000, 130),   # ①登入（三種方式框整組）
        (lst, 84, None, 900),
        (lst, 84, card_mapi, 2400),                        # ②認「Messaging API」小字那張卡
    ])

    # 拿第一把鑰匙：①切分頁 →（捲到底）→ ②按 Issue → ③按複製
    # ⚠️ 2026-09-06 改：②③兩個停格換成**還沒發過 token** 的新來源。
    # ⛔ 捲動幀停在 top=1220（視窗 1220–1840），**不可以再捲到 1450**——舊截圖的
    #    token 區塊從 y≈1900 起，捲到 1450 會先閃過寫著「Reissue」的按鈕，
    #    下一格才叫人按「Issue」，自己打自己。
    # ⛔ ②③刻意用**同一個 top**（兩張新來源是同一個捲動位置的前後狀態），
    #    所以看起來就是「按下去之後畫面多了東西」，不是跳到另一頁。
    build_anim('line-console-get-token.webp', [
        (api, 90, None, 900),        # 開場：先看正常畫面（跟使用者瀏覽器裡一樣）
        (api, 90, tab_mapi, 1600),   # ①切到 Messaging API 分頁
        (api, 280, None, 130),       # 捲動帶過…
        (api, 560, None, 130),
        (api, 900, None, 130),
        (api, 1220, None, 300),
        (tok0, NEW_TOP, None, 250),        # 捲到最底（還沒發：一顆 Issue、沒有複製圖示）
        (tok0, NEW_TOP, n_issue, 1900),    # ②按「Issue」發一組
        (tok1, NEW_TOP, n_copy, 1900),     # ③token 出來了 → 按複製圖示整串複製
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
        (bs, 980, None, 300),
        # ⚠️ 2026-09-06 改：②換成 Channel secret **有值**的來源。舊來源那一列是空的
        #    （憑證不可入鏡而清掉），新手看到空白會以為自己那邊沒資料——這是回饋裡的一條。
        # ⛔ 捲動幀停在 980，不再捲到 1300：舊截圖那一列在 y≈1651，捲過去就先看到空白列。
        (bs2, 100, None, 250),
        (bs2, 100, n_secret_row, 2200),  # ②就是這一列，整串複製
    ])

    # 關內建自動回應：①右上「設定」→ ②側欄「回應設定」→ ③選「手動聊天」。
    # 這支含側欄（x 從 0 起）：側欄本身就是導航故事的一部分
    # 2026-09-06 從三格變四格：**開 Webhook** 併進來了。
    # 原本那個開關要去 LINE Developers 開（英文、而且是另一趟），但它跟「關內建自動回應」
    # 其實就在同一頁上下相鄰——老闆實測兩邊設定是同步的，所以搬過來一趟做完兩件事。
    # ⚠️ 圖上那顆 Webhook 是**開著**（綠色）的，所以文案寫「**確認**它是開的，灰的就點一下」——
    #    ⛔ 不可以寫成「把它打開」：那會變成又一個「叫人做一件圖上已經做好的事」（webhook 那支踩過）。
    build_anim('oam-auto-reply.webp', [
        (oam, 0, None, 900),
        (oam, 0, (1264, 53, 1344, 94), 1500),   # ①右上「設定」
        (oam, 0, (44, 213, 190, 247), 1500),    # ②側欄「回應設定」
        (oam, 0, (548, 452, 600, 488), 2000),   # ③確認「Webhook」是開的
        (oam, 200, None, 130),                  # 捲動帶過…
        (oam, 420, None, 130),
        (oam, 610, None, 300),
        (oam, 610, (546, 750, 652, 792), 2400),  # ④選「手動聊天」
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
        # ⛔ 捲動停在 380（視窗 380–1000）：舊截圖的 Webhook URL 那一列在 y≈1024，
        #    再往下就會先露出「網址已經填好、Verify／Edit 兩顆鈕、Use webhook 綠燈」的
        #    完成狀態——第一次的人畫面上只有一顆 Edit，而且開關還沒出現。
        (api, 380, None, 300),
        # ⚠️ 2026-09-06 ③④換成真實狀態：③是 Webhook URL **全空**（只有一顆 Edit），
        #    ④是按完 Edit 之後（輸入格＋網址＋**Update**）。舊圖的④從頭到尾沒有 Update 這顆鈕，
        #    而且下面 Use webhook 已經是綠的＝下一步的事被提前演完。
        # ⚠️ 這兩幀的左邊界是 168 不是 240：`src-webhook-empty.jpg` 是 09-02 拍的，
        #    那時 LINE Developers 的側欄比較窄，內容從 x=218 起（其他來源都是 290）。
        #    照預設 240 裁會把每一行的標籤切掉左半（實測「Webhook settings」變「bhook settings」）。
        #    ⛔ 寬度不能動，只挪左邊界——每一幀的畫布尺寸必須一模一樣。
        (wh0, NEW_TOP, None, 250, 168),
        (wh0, NEW_TOP, n_wh_edit, 1600, 168),   # ③先按「Edit」打開輸入格
        (wh1, NEW_TOP, n_wh_url, 2400),    # ④貼上網址按「Update」存檔
    ])

    # 啟用 Messaging API：①按啟用 → 連過三個彈窗（2026-09-06 新增）。
    # 為什麼值得一支動畫：我們的文案原本只有「按啟用」四個字，而實際上按下去要連過三關，
    # 最後一關還跳一句「一旦與提供者連動即無法變更或解除」——沒被預告的人會停在那裡不敢按。
    # ⚠️ vh 調到 700：彈窗比一般欄位高（最高那個 578px），照預設 620 裁會貼著上下邊。
    # ⛔ 停在④按「確定」，**不演完成畫面**：演到「已經好了」會讓人以為不用按那顆確定
    #    （webhook 動畫踩過同一個坑），而且完成畫面上有明文 Channel secret。
    build_anim('oam-enable-messaging-api.webp', [
        (oam_enable_anim, 0, None, 900),                  # 開場：狀態「未使用」的正常畫面
        (oam_enable_anim, 0, (691, 365, 912, 405), 1800),  # ①按「啟用Messaging API」
        # ⚠️框要往左上包到「建立服務提供者」那一行：徽章畫在框的左上角，
        #    框只圈輸入格的話徽章會正好蓋在那行字上（實測第一版就是這樣）
        (oam_prov, 0, (414, 274, 845, 344), 2400),        # ②建立服務提供者：填店名 →「同意」
        (oam_priv, 0, (876, 558, 936, 604), 1800),        # ③隱私權兩欄可不填 →「確定」
        (oam_conf, 0, (876, 496, 936, 541), 2400),        # ④最後確認 →「確定」
    ], x0=0, x1=1352, vh=700)

    # 回應設定【開通流程版】：**不重演「點右上角設定」**（2026-09-06 老闆抓到）。
    #
    # 走到這一步的人，前兩步（拿 Channel secret、貼網址）已經在「設定」裡面待過了——
    # 再叫他點一次右上角的設定，是叫他去他已經站著的地方。
    # ⛔ 但**不能兩邊都砍**：`field-help.ts` 的「教我怎麼關」是從我們自己的設定頁**冷啟動**，
    #    那裡的人沒進過 OA 後台，而我們給的連結**落在「主頁」不是設定頁**，左邊那排選單還沒展開——
    #    對他們來說「先點右上角設定」是必要的第一步。所以兩支並存，來源是同一張截圖。
    # ⚠️ 文案要跟著分兩份：開通流程用①②③，欄位教學用①②③④。
    build_anim('oam-response-settings.webp', [
        (oam, 0, None, 900),
        (oam, 0, (44, 213, 190, 247), 1500),    # ①左欄「回應設定」（他已經在設定裡了）
        (oam, 0, (548, 452, 600, 488), 2000),   # ②把「Webhook」打開
        (oam, 200, None, 130),                  # 捲動帶過…
        (oam, 420, None, 130),
        (oam, 610, None, 300),
        (oam, 610, (546, 750, 652, 792), 2400),  # ③選「手動聊天」
    ], x0=0, x1=1352)

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
