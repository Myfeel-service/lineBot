"""把老闆補拍的 LINE Developers 截圖處理成可用的來源檔（2026-09-06 批）。

跑這支的時機＝**老闆又補拍了一批**，不是每次產圖都要跑。產出丟進
`docs/onboarding-shots-src/`，之後由 `make-onboarding-shots.py` 裁切標註。

做三件事：
1. **統一 1352 寬**——舊來源檔都是 1352，新截圖是 2x（2704）。同一份版面、同樣的
   CSS 座標，縮一半之後所有欄位的 x 都對得起來（實測：Webhook URL 值都落在 x=451）。
2. **遮敏感資訊**（一律高斯模糊，⛔不要蓋色塊）——模糊看得出「這裡本來有一串東西」，
   蓋掉的話新手會以為自己那邊沒資料，那正是這批圖要修的毛病之一。
3. **換示範網址**——原圖上是 `world.splash-digilab.com/cityplay`（另一個專案），客人照抄
   會打不通。⛔**不是自己畫字**：直接從 `src-messaging-api.jpg` 剪下真實的
   `https://lineminime.com/webhook` 像素貼過去——同一個頁面、同字型同字級同抗鋸齒，
   拼接後看不出接縫。自己用系統字型重畫一定對不起來（沒有 Roboto）。

⛔ 這批圖裡有**活的憑證**：Channel access token 與 Channel secret 都是真的值。
   模糊區的座標改動之後**一定要目視確認**，別只看腳本跑完沒報錯。
"""
from PIL import Image, ImageFilter
import numpy as np, os

DESK='/Users/kevin/Desktop/'
DST=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),'docs','onboarding-shots-src')+'/'
OLD=DST+'src-messaging-api.jpg'
# 舊來源檔裡真實的 https://lineminime.com/webhook（同一頁面、同字型同尺寸）
URL_STRIP=Image.open(OLD).convert('RGB').crop((451,1019,687,1034))

def half(name):
    im=Image.open(DESK+name).convert('RGB')
    return im.resize((1352, im.size[1]//2), Image.LANCZOS)

def bbox_dark(img, box, thr=170):
    a=np.array(img.crop(box).convert('L')); d=a<thr
    if not d.any(): return None
    r=np.where(d.any(axis=1))[0]; c=np.where(d.any(axis=0))[0]
    return (box[0]+int(c.min()), box[1]+int(r.min()), box[0]+int(c.max())+1, box[1]+int(r.max())+1)

def blur(im, box, radius=6):
    im.paste(im.crop(box).filter(ImageFilter.GaussianBlur(radius)), box)

def swap_url(im, searchbox):
    b=bbox_dark(im, searchbox)
    im.paste((255,255,255),(b[0]-3,b[1]-4,b[0]+340,b[3]+4))
    im.paste(URL_STRIP,(b[0],b[1]))
    return b

out={}

# ① token 還沒發（沒有任何敏感資訊）
im=half('截圖 2026-09-06 下午3.50.17.png'); out['src-token-empty.jpg']=im

# ② token 發出來了 → 值要糊掉（這把是活的）
im=half('截圖 2026-09-06 下午3.50.22.png')
b=bbox_dark(im,(210,515,1130,575))   # ⛔右界停在 1130：1139~1153 是**複製圖示**，
# 那顆正是教學第三格要圈的重點，糊掉就沒東西可指了
print('token value bbox', b)
blur(im,(b[0]-4,b[1]-5,min(b[2],1130)+4,b[3]+5), 5)
out['src-token-issued.jpg']=im

# ③ 輸入格打開、網址貼好、Update 在（Use webhook 灰的）
im=half('截圖 2026-09-06 下午3.20.51.png')
print('editing url', swap_url(im,(455,205,745,245)))
out['src-webhook-editing.jpg']=im

# ④ 網址存好、Use webhook 還是灰的 → QR 要糊掉
im=half('截圖 2026-09-06 下午3.21.44.png')
print('saved url', swap_url(im,(440,545,900,580)))
blur(im,(468,168,672,375), 10)
out['src-webhook-saved.jpg']=im

# ⑤ Channel secret 那一列有值（值要糊掉）
im=half('截圖 2026-09-06 下午3.19.54.png')
b=bbox_dark(im,(440,265,740,300))
print('secret bbox', b)
blur(im,(b[0]-4,b[1]-5,b[2]+4,b[3]+5), 5)
out['src-basic-settings-secret.jpg']=im

# ⑥ 按錯 Issue 的確認框（背景那串 secret 也要糊）
im=half('截圖 2026-09-06 下午3.48.37.png')
blur(im,(442,268,737,296), 5)
out['src-secret-issue-warning.jpg']=im


# ⑦⑧⑨ 啟用 Messaging API 的三個彈窗（2026-09-06 從 09-02 那批桌面截圖補進來）。
# 為什麼要：我們的教學只寫「按啟用」四個字，實際上按下去要**連過三關**，
# 而且第三關會跳一句「一旦與提供者連動即無法變更或解除」——沒被預告的人會停在那裡不敢按。
# ⛔ 完成後那張（3.54.06）刻意不收：它有明文 Channel secret＋Channel ID，而且
#    演到「已經好了」會讓人以為不用按最後那顆確定（同 webhook 動畫踩過的坑）。
OAM_HEADER = [(1140, 16, 1268, 42), (306, 16, 396, 36)]   # 右上角個人名字、頂列的加好友 ID

im = half('截圖 2026-09-02 下午3.53.35.png')      # 彈窗①：選擇服務提供者
for b in OAM_HEADER:
    blur(im, b, 5)
# 底下三個既有的服務提供者是老闆自己的（含別的專案名），糊掉；
# ⛔ 只糊名字不糊整列——這一格要教的是「上面那個『建立服務提供者』才是你要選的」，
#    整塊蓋掉就看不出這是一份清單了
blur(im, (440, 344, 545, 420), 5)
out['src-oam-enable-provider.jpg'] = im

im = half('截圖 2026-09-02 下午3.53.43.png')      # 彈窗②：隱私權政策及服務條款（兩欄都選填）
for b in OAM_HEADER:
    blur(im, b, 5)
out['src-oam-enable-privacy.jpg'] = im

im = half('截圖 2026-09-02 下午3.53.50.png')      # 彈窗③：最後確認（⚠️無法變更或解除）
for b in OAM_HEADER:
    blur(im, b, 5)
out['src-oam-enable-confirm.jpg'] = im


# ⑩ 啟用完成後的「設定 → Messaging API」那一頁（2026-09-06）。
# 這張是整個改法的關鍵：**Channel secret 就列在上面、旁邊有複製鈕**，
# 而且下面就是 Webhook 網址欄位＋儲存——第二組連線資訊與貼網址兩件事都能在這裡做完，
# 不用進 LINE Developers 挑那兩張同名卡（挑錯的下場是客人訊息被整批丟掉、畫面上完全正常）。
im = half('截圖 2026-09-02 下午3.54.06.png')
for b in OAM_HEADER:
    blur(im, b, 5)
blur(im, (570, 318, 660, 345), 5)    # Channel ID
blur(im, (570, 360, 825, 387), 5)    # Channel secret（真的值）
out['src-oam-messaging-api.jpg'] = im

for name,img in out.items():
    img.save(DST+name, quality=92)
    print('wrote', name, img.size)
