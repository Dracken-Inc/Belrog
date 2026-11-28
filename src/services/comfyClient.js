/**
 * ComfyUI client for the render layer.
 *
 * This is deliberately a SEPARATE client from src/services/comfyui.js: that
 * singleton talks to whichever ComfyUI the app is configured for and holds a
 * websocket. A music-video render goes to the render host chosen by
 * renderPreflight (usually a different machine), so it needs its own address,
 * and nothing on the render path should depend on a websocket staying open.
 *
 * Laws:
 *  - Poll /queue and /history. A dropped socket must not lose a 10-minute clip.
 *  - Upload with the same endpoint and fields comfyui.js uses, so a file
 *    uploaded from the render path is indistinguishable from one the app put
 *    there.
 *  - No dependency on electron, so the CLI can use the exact same code. If the
 *    app and the CLI disagree about a URL or an upload field, this file is the
 *    only place that answer lives.
 */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

const DEFAULT_CLIENT_ID = 'belrog'

export function createComfyClient(baseUrl, { clientId = DEFAULT_CLIENT_ID } = {}) {
  if (!baseUrl) throw new Error('createComfyClient needs a baseUrl — renderPreflight returns `unset` when none is configured, and guessing is how a render ends up on the wrong machine')
  const base = String(baseUrl).replace(/\/+$/, '')
  return {
    baseUrl: base,
    clientId,
    host: (() => { try { return new URL(base).hostname } catch { return 'default' } })(),

    async getObjectInfoCached() {
      const res = await fetch(`${base}/object_info`)
      if (!res.ok) throw new Error(`GET /object_info failed: HTTP ${res.status}`)
      return res.json()
    },

    async uploadFile(filePath, filename, subfolder = '', type = 'input') {
      const buf = await readFile(filePath)
      const name = String(filename || basename(filePath)).replace(/[\\/:*?"<>|]/g, '_')
      const form = new FormData()
      form.append('image', new Blob([buf]), name)
      if (subfolder) form.append('subfolder', subfolder)
      form.append('type', type)
      form.append('overwrite', 'true')
      const res = await fetch(`${base}/upload/image`, { method: 'POST', body: form })
      if (!res.ok) throw new Error(`upload ${name} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
      return res.json()
    },

    async queuePrompt(graph) {
      const res = await fetch(`${base}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: graph, client_id: clientId }),
      })
      const body = await res.text()
      if (!res.ok) throw new Error(`/prompt rejected: HTTP ${res.status} ${body.slice(0, 800)}`)
      try { return JSON.parse(body) }
      catch { throw new Error(`/prompt returned a non-JSON body: ${body.slice(0, 200)}`) }
    },

    async getHistory(promptId) {
      const res = await fetch(`${base}/history/${encodeURIComponent(promptId)}`)
      if (!res.ok) throw new Error(`/history failed: HTTP ${res.status}`)
      return res.json()
    },

    async getQueueStatus() {
      const res = await fetch(`${base}/queue`)
      if (!res.ok) throw new Error(`/queue failed: HTTP ${res.status}`)
      return res.json()
    },

    async downloadVideo(item) {
      const q = new URLSearchParams({
        filename: item.filename,
        subfolder: item.subfolder || '',
        type: item.type || 'output',
      })
      const res = await fetch(`${base}/view?${q}`)
      if (!res.ok) throw new Error(`/view failed for ${item.filename}: HTTP ${res.status}`)
      return res
    },

    async interrupt() {
      await fetch(`${base}/interrupt`, { method: 'POST' }).catch(() => {})
    },
  }
}
