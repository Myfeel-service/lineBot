# PAYUNi 固定 IP 中繼站 — 完整架設教學

> 目的:讓我方的「每月自動扣款」有一個**固定不變的對外 IP**,才能填進 PAYUNi 後台的白名單。
> 對象:照著做就好,不需要懂反向代理。全部約 40 分鐘,月費約 USD 3.5~5。
> 相關背景與為什麼非做不可 → `docs/GOLIVE-BLOCKERS.md` A3。

---

## 0. 這台機器到底在做什麼(先看懂再動手)

PAYUNi 的幕後扣款 API 會檢查「**是誰打過來的**」——只接受事先登記過的 IP。
我方跑在 AWS Amplify 上,它的對外 IP 每次都不一樣(實測一天換好幾個),所以永遠填不進去。

解法是找一個**IP 永遠不變**的地方,讓扣款那一支呼叫從那裡出去:

```
        現在(會被擋)                     架完之後(通)
  Amplify ──扣款──▶ PAYUNi ✗       Amplify ──▶ 中繼站 ──扣款──▶ PAYUNi ✓
   IP 每次都不同                              IP 永遠是這個
```

**只有「扣款」這一支需要它。** 客人刷卡的付款頁是瀏覽器直接連 PAYUNi,永遠不經過這台機器
(2026-08-06 實測:解約與查詢也不檢查 IP,只有 `/api/credit` 會)。

**它掛掉會怎樣?** 影響很小:那天的自動扣款沒扣到,隔天排程會再試,還有 3 天寬限期。
客人照樣付得到錢。**所以這台機器不需要備援、不需要很好的規格。**

**它看得到我們的什麼?** 看得到加密後的封包,看不懂內容,也**偽造不出「扣款成功」**
(回應要用我方特店金鑰驗簽才會被採信)。所以它不是一個需要高度信任的角色 —— 但仍要照 §9 收好。

---

## 1. 動手前要準備的東西

| 需要 | 說明 |
|---|---|
| AWS 帳號 | 用現有的那個(帳單與權責跟 Amplify 在一起) |
| 一個網域 | 例如 `lineminime.com`,要能新增一筆 DNS 紀錄 |
| PAYUNi 後台 | 會員 › 商店清單 › 點商店 › 「串接設定」 |
| Amplify 主控台 | 要新增一個環境變數並重新部署 |

**先決定一個子網域名稱**,本文一律用 `relay.lineminime.com` 當範例,照做時換成你的。

---

## 2. Step 1|開一台最小的機器(5 分鐘)

1. 進 AWS 主控台 → 搜尋 **Lightsail** → 進去按 **Create instance**
2. **Region**:選 **Tokyo(ap-northeast-1)**
3. **Platform**:`Linux/Unix`
4. **Blueprint**:選 **OS Only → Ubuntu 24.04 LTS**
   (不要選 WordPress 那種帶應用程式的)
5. **Instance plan**:選**最便宜的那一個**(512MB / 1 vCPU 就夠,它只跑一個轉發程式)
6. **Identify your instance**:命名 `payuni-relay`
7. 按 **Create instance**,等它從 `Pending` 變成 `Running`(約 1 分鐘)

---

## 3. Step 2|綁一個永遠不變的 IP(3 分鐘)← 這步是整件事的重點

1. 點進剛建立的 `payuni-relay` → 上方分頁 **Networking**
2. 找到 **Static IP** → **Create static IP**(或到左側 Networking 頁建立後再 attach)
3. Region 選同一個(Tokyo),**Attach to an instance** 選 `payuni-relay`
4. 命名 `payuni-relay-ip` → **Create**

記下那個 IP,例如 `13.230.xx.xx`,後面 §6 §7 都要用。

> 💡 **費用小提醒**:靜態 IP **掛在執行中的機器上不收費**;但如果哪天把機器刪了、IP 留著沒掛,
> AWS 會開始收錢。要停用就**兩個一起刪**。

---

## 4. Step 3|打開網路連接埠(2 分鐘)

還在 **Networking** 分頁 → **IPv4 Firewall** → 確認有這幾條,沒有就 **Add rule**:

| Application | Protocol | Port |
|---|---|---|
| SSH | TCP | 22 |
| HTTP | TCP | 80 |
| HTTPS | TCP | 443 |

**80 一定要開** —— 憑證自動申請要用它驗證你真的擁有這個網域,沒開的話 HTTPS 會一直失敗。

---

## 5. Step 4|連進機器、把系統更新好(5 分鐘)

在 Lightsail 那台機器的頁面按 **Connect using SSH**(瀏覽器直接開終端機,不用設金鑰)。

貼上這段(一次一段,等它跑完):

```bash
# 更新系統
sudo apt update && sudo apt upgrade -y

# 開啟自動安全更新 —— 這樣以後幾乎不用登入維護它
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -f noninteractive unattended-upgrades
```

---

## 6. Step 5|安裝 Caddy(3 分鐘)

Caddy 是一個會**自動申請與續期 HTTPS 憑證**的網頁伺服器,選它就是為了不用管憑證。

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

裝完確認它活著:

```bash
systemctl status caddy --no-pager
```

看到綠色的 `active (running)` 就對了(按 `q` 離開)。

---

## 7. Step 6|設定 DNS(5 分鐘,要等生效)

到你的網域管理後台(Cloudflare 或其他),新增一筆:

| 類型 | 名稱 | 值 |
|---|---|---|
| A | `relay` | 剛才那個靜態 IP,例如 `13.230.xx.xx` |

**如果是 Cloudflare**:建議設成**灰雲(DNS only)**。

> ⚠️ **更正一個曾經寫錯的說法**:舊文件寫「開橘雲會讓出口 IP 不是我們那台,白名單白填」——**這是錯的**。
> 橘雲影響的是「**別人打進中繼站**」那個方向;中繼站**打出去給 PAYUNi** 用的永遠是它自己的 IP,
> 白名單不會失效。
> 建議灰雲的真正理由是:**扣款路徑上少一個依賴、少一個故障點**,而且 Caddy 自動申請憑證最單純。
> (若你偏好把機器藏在 Cloudflare 後面當作加固,橘雲也是可行的,只是要自己處理憑證與逾時設定。)

確認 DNS 生效(在你自己的電腦上跑):

```bash
dig +short relay.lineminime.com
# 應該印出那個靜態 IP
```

沒生效就等幾分鐘再試,**DNS 沒生效就往下做,憑證一定會失敗**。

---

## 8. Step 7|寫設定檔,讓它只轉發該轉的(5 分鐘)

回到機器的終端機:

```bash
sudo nano /etc/caddy/Caddyfile
```

**把整個檔案內容換成**下面這段(記得換掉網域):

```caddyfile
relay.lineminime.com {
	# 只放行 PAYUNi 幕後那幾支,其餘一律 404
	# —— 別讓這台機器變成任何人都能借道的公開代理
	# trade/query(查單對帳)雖然不檢查 IP,仍要放行:它必須與扣款同一個出口、
	# 打到同一個環境,否則會出現「扣款打正式、查單問沙盒 → 查無此單」的誤判
	@payuni path /api/credit /api/credit_bind/* /api/trade/query

	handle @payuni {
		reverse_proxy https://api.payuni.com.tw {
			# Host 與 TLS 名稱都要是 PAYUNi 的,否則上游會拒絕
			header_up Host api.payuni.com.tw
			# ⚠️ 這三行不能省 —— 原因見 §15.5,少了它整台機器等於白架
			header_up -X-Forwarded-For
			header_up -X-Forwarded-Proto
			header_up -X-Forwarded-Host
		}
	}

	# 其他路徑一律擋掉
	handle {
		respond "not found" 404
	}

	# 留一份紀錄,出事時查得到
	log {
		output file /var/log/caddy/relay.log
		format json
	}
}
```

存檔離開(`Ctrl+O` → `Enter` → `Ctrl+X`),然後套用:

```bash
sudo systemctl reload caddy
```

> ⚠️ **上游網址要與環境一致**:上面寫的是**正式** `https://api.payuni.com.tw`。
> 沙盒要用的是 `https://sandbox-api.payuni.com.tw`,且要與 Amplify 的 `PAYUNI_ENV` 對得起來。
>
> **兩個環境可以共用同一台機器**(2026-08-08 確認線上就是這樣跑的):開兩個網域區塊,
> 各自釘死自己的上游即可,例如 `<你的網域>` 走正式、`<你的網域>-test` 走沙盒。
> 一台機器一個固定 IP,兩個環境的白名單填同一個 IP 就好,不必為了沙盒再開一台。
> **不能混的是「同一個網域區塊裡的上游」**,不是機器——舊版本文寫成「一台機器只服務
> 一個環境」是誤導。
>
> 兩段的 `@payuni path` 白名單要各改各的:`sed` 沒有加 `g`(或漏了其中一段)時,
> 只會改到第一段,沙盒那邊就會靜靜地少一條路徑。

---

## 9. Step 8|驗機器本身(3 分鐘,先確認再往下)

**在機器的終端機上**跑:

```bash
# ① 這台機器對外出去的 IP,必須等於剛才那個靜態 IP
curl -s https://api.ipify.org; echo

# ② 憑證有沒有拿到(從機器上打自己)
curl -s -o /dev/null -w "%{http_code}\n" https://relay.lineminime.com/api/credit -X POST -d 'x'
#   → 期待 200(PAYUNi 會回一包錯誤 JSON,那就對了)

# ③ 查單也要通(漏了這條,對帳補開通會整支退回直連)
curl -s -o /dev/null -w "%{http_code}\n" https://relay.lineminime.com/api/trade/query -X POST -d 'x'
#   → 期待 200。若回 404,是 @payuni 那行少寫了 /api/trade/query

# ④ 不該放行的路徑要被擋
curl -s -o /dev/null -w "%{http_code}\n" https://relay.lineminime.com/api/upp -X POST -d 'x'
#   → 期待 404
```

**四個都符合才往下做。** ① 不相符表示靜態 IP 沒綁好;② 不是 200 多半是 DNS 或 80 埠沒開。

---

## 10. Step 9|把這個 IP 填進 PAYUNi 後台(2 分鐘)

PAYUNi 後台 → **會員 › 商店清單 › 點該商店 › 「串接設定」** → 找到
**「限定 API 之 IP 設定」**:

1. **只填那一個靜態 IP**
2. **把之前為了測試填的浮動 IP 全部清掉**(它們早就失效了,留著只是多開幾道門)
3. 存檔

> 多筆是用半形逗號分隔、上限 10 組。正式與沙盒是**兩個不同的商店**,各自要填各自的。

---

## 11. Step 10|讓我方系統改走中繼站(3 分鐘)

Amplify 主控台 → 你的 App → **Environment variables** → 新增:

| 變數 | 值 |
|---|---|
| `PAYUNI_RELAY_BASE` | `https://relay.lineminime.com` |

⚠️ **不要加結尾斜線**、不要加路徑。存檔後**重新部署**才會生效。

順便核對這兩個(見 `docs/GOLIVE-BLOCKERS.md` D1):

| 變數 | 正式站應該是 |
|---|---|
| `PAYUNI_ENV` | `prod` ← 拼錯不會報錯,會安靜地打到沙盒 |
| `PAYUNI_MERCHANT_ID` | 正式特店代號 |

---

## 12. Step 11|驗收(5 分鐘)

1. **看得到流量**:在機器上 `sudo tail -f /var/log/caddy/relay.log`,
   然後在後台觸發一次續扣對帳 → 應該看到一筆 `/api/credit` 的紀錄
2. **扣款真的成功**:看該筆訂閱的 `lastChargeError` 是不是空的、訂單有沒有變 `paid`
3. **PAYUNi 後台**:交易明細看得到那筆授權

**成功的樣子**:扣款回 `授權成功`。
**IP 沒設好的樣子**:回 `不提供此IP幕後交易,<某個IP>` —— 訊息會**直接告訴你它看到的 IP 是多少**,
拿那個值跟白名單比對就知道差在哪。

---

## 13. 出事要怎麼退回去(30 秒)

把 Amplify 的 `PAYUNI_RELAY_BASE` **清空**,重新部署 → 立刻回到「直連 PAYUNi」的行為,
**一行程式都不用改**。(當然,直連就會被 IP 白名單擋,但至少不是中繼站的問題了。)

---

## 14. 日常維運(幾乎不用管)

| 項目 | 說明 |
|---|---|
| 系統更新 | Step 4 已開自動安全更新 |
| 憑證 | Caddy 自動續期,不用管 |
| 監控 | **不需要高可用,但要知道它死了**:扣款失敗本來就會寫 `lastChargeError` 並寄提醒信 |
| 費用 | 機器月費 + 靜態 IP(掛著免費);流量極少 |
| 什麼時候要動它 | 換網域、換環境(沙盒↔正式)、PAYUNi 新增要走幕後的 API |

---

## 15. 常見錯誤對照表

| 現象 | 原因 | 怎麼修 |
|---|---|---|
| `curl` 憑證錯誤 / HTTPS 連不上 | DNS 沒生效,或 80 埠沒開 | 等 DNS、補防火牆規則,再 `sudo systemctl reload caddy` |
| 打 `/api/credit` 回 404 | Caddyfile 路徑寫錯 | 檢查 `@payuni path` 那行 |
| log 出現 `中繼站沒有代理 trade/query` | 機器是舊版設定,`@payuni` 那行沒有這條路徑 | 補上 `/api/trade/query` 後 `sudo systemctl reload caddy`。在補之前對帳會自動退回直連,功能不會壞,但出口 IP 與扣款不同 |
| 回 `不提供此IP幕後交易` | 白名單沒填、或填錯 | 用錯誤訊息裡回報的 IP 去對 |
| 回 `DEF01006 商店狀態不符合` | 不是中繼站的問題 | 特店還沒開通(見 GOLIVE-BLOCKERS A3) |
| 扣款打到沙盒 | `PAYUNI_ENV` 與 Caddyfile 上游不一致 | 兩邊都要是同一個環境 |
| 出口 IP 不等於靜態 IP | 靜態 IP 沒 attach | 回 Step 2 |

---

## 15.5 ⚠️ 一定要拿掉 `X-Forwarded-For`(2026-08-07 實機踩到,會讓整台機器白做)

**症狀**:中繼站架好、憑證也通了,經它扣款卻回

```
CREDIT03010 不提供此IP幕後交易，211.21.19.45, 54.249.132.4
                                ↑ 我方原始來源      ↑ 中繼站的 IP
```

**根因**:Caddy 的 `reverse_proxy` **預設會加上 `X-Forwarded-For`** 告訴上游「原始來電者是誰」,
而 **PAYUNi 會把那個標頭裡的 IP 也一起納入來源 IP 檢查**(上面那筆回應把兩個 IP 都列出來就是證據)。

**為什麼危險**:正式環境那個位置會是 **Amplify 的動態 IP**。若 PAYUNi 的規則是「看到的每個 IP 都要在
白名單內」,中繼站就永遠不會通 —— 而且錯誤訊息與「IP 沒填」長得幾乎一樣,極難看出根因。

**修法**:在 `reverse_proxy` 區塊裡加三行(Step 7 的設定檔已含):

```caddyfile
header_up -X-Forwarded-For
header_up -X-Forwarded-Proto
header_up -X-Forwarded-Host
```

順帶好處:不會把我方內部/雲端 IP 洩漏給金流。

> ⚠️ **上面這個根因說法目前是「未證實」,別當定論**(2026-08-08 更正)。
>
> 實際去看線上那台機器,**兩個網域區塊都沒有這三行**,只有 `header_up Host` ——
> 但 08-07 那筆真憑證續扣 NT$399 確實成功了(而且當時開發機 IP 已從白名單移除)。
> 若 PAYUNi 真的把 `X-Forwarded-For` 裡的 IP 一起檢查,那筆就該被擋下來。
>
> 所以能確定的只有:**08-07 曾經看到一筆同時列出兩個 IP 的 `CREDIT03010`**;
> 至於那到底是不是被擋的原因,現有證據下不了結論(當時可能同時改了白名單)。
>
> 這三行仍然**建議加**,但理由是「不要把我方 IP 洩漏給金流」這個實實在在的好處,
> 不是「不加就不會通」。要加的話挑一個能馬上補測一筆真扣款的時間做,別在沒人看著時改。

**💡 這裡有一個非常好用的驗證神器**:PAYUNi 的 `CREDIT03010` 訊息會**把它實際看到的所有來源 IP
原樣回報**。所以要確認「PAYUNi 到底看到誰」,不必猜也不必看 log ——
故意用一個沒白名單的 IP 打一筆真扣款,它就會告訴你答案。

### ✅ 實機驗證通過(2026-08-07)

| 探針 | 結果 |
|---|---|
| 兩個網域的 HTTPS 憑證(Let's Encrypt) | ✅ 自動簽發 |
| `/api/upp`(白名單外的路徑) | ✅ `404` —— 不是公開代理 |
| `/api/credit`(白名單內) | ✅ 正常轉發到 PAYUNi |
| **真憑證經中繼站續扣 NT$399** | ✅ **`SUCCESS 授權成功`** |
| 直連(開發機 IP,已從白名單移除) | ✅ 被擋 `CREDIT03010` —— 白名單真的在守門 |

### ✅ 補上 `/api/trade/query` 並驗收(2026-08-08)

線上那台原本只放行 `/api/credit` 與 `/api/credit_bind/*`,對 `/api/trade/query` 回 `404`,
所以對帳查單每次都退回直連。當天已在機器上補好(兩個網域區塊都改),驗收:

| 探針 | 正式 | 沙盒 |
|---|---|---|
| `/api/trade/query`(新放行) | ✅ `200` | ✅ `200` |
| `/api/upp`(白名單外) | ✅ `404` | ✅ `404` |

改法(一行,重跑不會重複加,`$` 錨定 + `g` 讓兩個區塊都改到):

```bash
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%F)
sudo sed -i 's|@payuni path /api/credit /api/credit_bind/\*$|@payuni path /api/credit /api/credit_bind/* /api/trade/query|g' /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile   # 要看到 Valid configuration
sudo systemctl reload caddy
```

> `reload` 時可能出現 `Warning: The unit file ... changed on disk`:與本次改動無關
> (systemd 在說 caddy.service 定義檔某次被動過),設定照樣生效,`sudo systemctl daemon-reload` 可消。

**最終狀態**:PAYUNi 白名單裡**只留中繼站那一個 IP**,所有浮動 IP 清空。
開發機要測續扣時,把本機 `.env` 也設 `PAYUNI_RELAY_BASE=https://<沙盒中繼網域>` 即可。

## 16. 安全性:誠實說清楚

**這台機器拿不到、也偽造不了什麼**:封包在我方就已用特店金鑰加密+簽章,回應也要用同一組金鑰
驗簽才會被採信。**它簽不出「扣款成功」。**

**但有一個要正視的風險**:它的作用就是「把來源 IP 換成白名單上的那個」。
所以**任何人只要 ①知道這個網址 ②拿到我方特店金鑰,就能繞過 IP 白名單**。
IP 白名單本來是金鑰外洩後的第二道鎖,中繼站等於在那道鎖上開了一個小門。

三個對策,由簡到繁:

1. **網址不要好猜**,也不要寫進任何公開的地方(本文的 `relay.` 只是範例)
2. **Caddy 只放行兩個路徑**(Step 7 已做)—— 它不能被拿來當通用代理
3. **加一道共用密碼**(建議做,但**目前程式還不支援**):
   讓我方呼叫時帶一個自訂標頭,Caddy 檢查沒帶就 404。
   ⚠️ **不能用「把帳密寫在網址裡」那招** —— 2026-08-07 實測,Node 的 `fetch` 會直接
   拒絕帶帳密的網址(`Request cannot be constructed from a URL that includes credentials`)。
   要做需要在 `server/utils/payuni.ts` 加約 10 行(新增 `PAYUNI_RELAY_TOKEN`,
   有設就在四個幕後呼叫帶上標頭),Caddyfile 對應加:

   ```caddyfile
   @payuni {
   	path /api/credit /api/credit_bind/* /api/trade/query
   	header X-Relay-Token "換成一組長亂碼"
   }
   ```

**還有一件與此連動的事**:正式特店的 Hash Key / IV 曾經在對話裡外流過一次。
**上線前本來就該換一次金鑰**(PAYUNi 後台「更換金鑰」→ 同步更新 Amplify 並重新部署)。
換了之後,上面那個風險的前提(拿到金鑰)就回到可控狀態。
