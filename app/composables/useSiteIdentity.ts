/**
 * 官網門面（landing / 法務頁 / 登入頁）共用的「營運主體與客服窗口」資訊。
 *
 * 為什麼收成一個 composable、而不是各頁自己 useRuntimeConfig()：
 * 公司名稱、統一編號、客服信箱、客服電話這四項是**信用卡收單風控會逐項核對**的資料
 * （見 nuxt.config 的 legalCompanyName 註解），四個頁面必須字字一致；散在各頁最後
 * 一定會有一頁漏改。tel: 連結的正規化也一併收在這裡。
 *
 * 值都來自 runtimeConfig.public（有預設、可用 env 覆寫成別的營運主體）。
 */
export function useSiteIdentity() {
  const pub = useRuntimeConfig().public
  const email = String(pub.supportEmail ?? '').trim()
  const phone = String(pub.supportPhone ?? '').trim()

  return {
    /** 對外品牌＝產品名（MiniMe）。⚠️ 不是公司名，公司是 companyName。 */
    brandName: String(pub.brandName ?? 'MiniMe'),
    /** 產品全名 = 向金流申報的商品名稱（法務頁、商品資訊、發票品名都以它為準）。 */
    serviceFullName: String(pub.serviceFullName ?? ''),
    companyName: String(pub.legalCompanyName ?? ''),
    taxId: String(pub.legalTaxId ?? ''),
    email,
    emailHref: email ? `mailto:${email}` : '',
    phone,
    // tel: 只吃數字與開頭的 +；顯示用的連字號、括號、空白都要清掉才撥得出去
    phoneHref: phone ? `tel:${phone.replace(/[^\d+]/g, '')}` : '',
    hours: String(pub.supportHours ?? ''),
  }
}
