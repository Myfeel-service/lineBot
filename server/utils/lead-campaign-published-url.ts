import { v4 as uuidv4 } from 'uuid'
import { createHash } from 'node:crypto'
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import type { LeadClaimDoc } from '~~/shared/types/lead-campaign'
import { getLineWorkspaceCredentials } from '~~/server/utils/line-workspace-credentials'
import { normalizeAutoReplyAction } from '~~/shared/auto-reply-rule'
import { parsePublishedCtaUrl } from '~~/shared/liff-lead-query'
import { leadEndpointUrl } from '~~/shared/liff-lead-path'

type CampaignForEntryUrl = {
  workspaceId?: string
  liffId?: string
  campaignCode?: string
  isActive?: boolean
  tagIds?: unknown
  moduleId?: unknown
  action?: unknown
  redirectUrl?: string | null
  publishedClaimId?: string | null
  publishedCtaUrl?: string | null
}

function extractClaimTokenFromPublishedUrl(ctaUrl: string): string {
  return parsePublishedCtaUrl(ctaUrl).ct
}

function buildPublishedCtaUrl(rawToken: string, campaignCode: string, liffId: string): string {
  const config = useRuntimeConfig()
  const appBase = String(config.lineImagemapBaseUrl || '').replace(/\/$/, '')
  if (appBase) {
    return `${leadEndpointUrl(appBase)}?claimToken=${encodeURIComponent(rawToken)}&c=${encodeURIComponent(campaignCode)}&liffId=${encodeURIComponent(liffId)}`
  }
  const stateParams = `?claimToken=${encodeURIComponent(rawToken)}&c=${encodeURIComponent(campaignCode)}&liffId=${encodeURIComponent(liffId)}`
  return `https://liff.line.me/${liffId}?liff.state=${encodeURIComponent(stateParams)}`
}

function buildClaimSnapshot(campaign: CampaignForEntryUrl, workspaceId: string, campaignId: string) {
  const campaignCode = String(campaign.campaignCode || '')
  const mod = campaign.moduleId
  const hasActionType = Boolean(String((campaign.action as any)?.type ?? '').trim())
  const fallbackModule = mod != null ? String(mod).trim() : ''
  const action = hasActionType || fallbackModule
    ? normalizeAutoReplyAction(campaign.action, fallbackModule)
    : null
  const moduleId = action?.type === 'module' && action.moduleId ? action.moduleId : null
  const redirectUrl = String(campaign.redirectUrl || '').trim() || null

  const claimFields: Omit<LeadClaimDoc, 'tokenHash' | 'createdAt' | 'claimedAt' | 'appliedAt'> = {
    workspaceId,
    campaignId,
    campaignCode,
    sharedEntry: true,
    lineUserId: null,
    status: 'pending',
    tagIds: Array.isArray(campaign.tagIds) ? campaign.tagIds.map(String).filter(Boolean) : [],
    moduleId,
    action,
    redirectUrl,
  }

  return { campaignCode, claimFields }
}

async function tryReusePublishedClaim(
  db: Firestore,
  campaignId: string,
  campaign: CampaignForEntryUrl,
): Promise<{ claimId: string; rawToken: string } | null> {
  const claimId = String(campaign.publishedClaimId || '').trim()
  const ctaUrl = String(campaign.publishedCtaUrl || '').trim()
  if (!claimId || !ctaUrl) return null

  const rawToken = extractClaimTokenFromPublishedUrl(ctaUrl)
  if (!rawToken) return null

  const claimSnap = await db.collection('leadClaims').doc(claimId).get()
  if (!claimSnap.exists) return null

  const data = claimSnap.data()!
  if (data.sharedEntry !== true) return null
  if (String(data.campaignId || '') !== campaignId) return null

  const tokenHash = createHash('sha256').update(rawToken).digest('hex')
  if (String(data.tokenHash || '') !== tokenHash) return null

  return { claimId, rawToken }
}

function preservedPublishedFields(campaign: CampaignForEntryUrl): {
  publishedCtaUrl: string | null
  publishedClaimId: string | null
} {
  const publishedCtaUrl = String(campaign.publishedCtaUrl || '').trim() || null
  const publishedClaimId = String(campaign.publishedClaimId || '').trim() || null
  return { publishedCtaUrl, publishedClaimId }
}

/**
 * 依活動狀態同步「活動進入網址」：可解析 LIFF 時建立或更新 leadClaim 模板並寫入 leadCampaigns.publishedCtaUrl。
 * 更新、停用、再啟用皆沿用既有 claimToken，避免換網址。
 */
export async function syncPublishedEntryUrlForCampaign(
  db: Firestore,
  campaignId: string,
  campaign: CampaignForEntryUrl,
): Promise<{ publishedCtaUrl: string | null; publishedClaimId: string | null }> {
  const workspaceId = String(campaign.workspaceId || '').trim() || 'default'
  const { defaultLiffId: workspaceDefaultLiff } = await getLineWorkspaceCredentials(workspaceId)
  const liffId = String(campaign.liffId || '').trim() || String(workspaceDefaultLiff || '').trim()
  const isActive = campaign.isActive !== false

  if (!isActive) {
    const preserved = preservedPublishedFields(campaign)
    if (preserved.publishedClaimId && preserved.publishedCtaUrl && liffId) {
      const { claimFields } = buildClaimSnapshot(campaign, workspaceId, campaignId)
      const reused = await tryReusePublishedClaim(db, campaignId, campaign)
      if (reused) {
        await db.collection('leadClaims').doc(reused.claimId).update(claimFields)
      }
    }
    return preserved
  }

  if (!liffId) {
    return preservedPublishedFields(campaign)
  }

  const { campaignCode, claimFields } = buildClaimSnapshot(campaign, workspaceId, campaignId)
  const reused = await tryReusePublishedClaim(db, campaignId, campaign)

  let claimId: string
  let rawToken: string

  if (reused) {
    claimId = reused.claimId
    rawToken = reused.rawToken
    await db.collection('leadClaims').doc(claimId).update(claimFields)
  }
  else {
    rawToken = uuidv4()
    claimId = uuidv4()
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')
    const claimDoc: LeadClaimDoc = {
      ...claimFields,
      tokenHash,
      claimedAt: null,
      appliedAt: null,
      createdAt: FieldValue.serverTimestamp(),
    }
    await db.collection('leadClaims').doc(claimId).set(claimDoc)
  }

  const ctaUrl = buildPublishedCtaUrl(rawToken, campaignCode, liffId)

  await db.collection('leadCampaigns').doc(campaignId).update({
    publishedCtaUrl: ctaUrl,
    publishedClaimId: claimId,
  })

  return { publishedCtaUrl: ctaUrl, publishedClaimId: claimId }
}
