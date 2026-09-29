import { v4 as uuidv4 } from 'uuid'
import { getStorage } from '../utils/firebase'
import {
  getUploadFileExtension,
  getUploadFolder,
  validateUploadPayload,
} from '~~/server/utils/upload-validator'
import { requireCapability } from '~~/server/utils/workspace-auth'

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'marketing.write')

  const body = await readBody(event)
  const base64Input = body?.fileBase64
  const { buffer, category, contentType } = validateUploadPayload({
    base64Input,
    contentType: body?.contentType,
  })

  const id = uuidv4()
  const storage = getStorage()
  const bucket = storage.bucket()

  const ext = getUploadFileExtension(contentType)
  const folder = getUploadFolder(category)

  const fileName = `${folder}/${workspaceId}/${id}.${ext}`
  const file = bucket.file(fileName)

  await file.save(buffer, { contentType: contentType || 'application/octet-stream' })
  await file.makePublic()

  const imageUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`

  return { imageUrl, url: imageUrl }
})
