/**
 * Render Preflight — the vLLM gate and the ComfyUI target resolver.
 *
 * RULE (Henry, 2026-11-27), enforced here in code and not just in behaviour:
 *   "keyshot images only for testing, no video or audio generations while vllm is running."
 *
 * So before ANYTHING is queued at ComfyUI we ask one question: is this same
 * machine also serving vLLM? If it is, video and audio jobs are refused
 * outright — the remedy is stated, never guessed at. Stills (one PNG per shot)
 * are the only thing allowed while vLLM is up, and they are only allowed when
 * the operator asks for them explicitly.
 *
 * No URL is ever assumed. If the ComfyUI URL is not configured we say `unset`.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const COMFY_URL_ENV = 'BELROG_COMFY_URL'
export const VLLM_URL_ENV = 'BELROG_VLLM_URL'
export const VLLM_PORT_ENV = 'BELROG_VLLM_PORT'
export const GPU_GO_ENV = 'BELROG_GPU_GO'

const PROBE_TIMEOUT_MS = 2000

export class RenderGateError extends Error {
  constructor(message, { check, remedy } = {}) {
    super(message)
    this.name = 'RenderGateError'
    this.check = check
    this.remedy = remedy
  }
}

/**
 * Where does the ComfyUI URL come from? Never a silent localhost default.
 * @returns {{ url: string|null, source: string, configFile: string }}
 */
export function resolveComfyUrl({ env = process.env, home = homedir() } = {}) {
  const configFile = join(home || '.', '.belrog', 'render.json')
  const fromEnv = String(env[COMFY_URL_ENV] || '').trim()
  if (fromEnv) return { url: fromEnv.replace(/\/+$/, ''), source: `env:${COMFY_URL_ENV}`, configFile }
  return { url: null, source: 'unset', configFile }
}

/**
 * Read an optional on-disk config (the CLI's answer to the app's settings store;
 * the Electron app keeps the same value in its own store and we never touch it).
 */
export async function readRenderConfig(configFile) {
  if (!configFile) return {}
  try {
    return JSON.parse(await readFile(configFile, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * Resolve the ComfyUI URL from env then config file. `url` is null when unset.
 */
export async function resolveComfyTarget({ env = process.env, home = homedir() } = {}) {
  const envRes = resolveComfyUrl({ env, home })
  if (envRes.url) return { ...envRes, url: envRes.url }
  const cfg = await readRenderConfig(envRes.configFile)
  const fromFile = String(cfg.comfyUrl || '').trim()
  if (fromFile) return { url: fromFile.replace(/\/+$/, ''), source: `file:${envRes.configFile}`, configFile: envRes.configFile }
  return { url: null, source: 'unset', configFile: envRes.configFile }
}

/** Host of a URL, or null when the URL is unset/malformed. */
export function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

/**
 * Is vLLM answering on the render host? Cheap GET /v1/models, short timeout.
 * `up: false` with an `error` means we could not reach it — which is NOT proof
 * it is down, so callers that generate video treat `reachable: false` as
 * "could not check" and must say so instead of claiming the coast is clear.
 */
export async function probeVllm({ comfyUrl, env = process.env, fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const explicit = String(env[VLLM_URL_ENV] || '').trim()
  const host = hostOf(comfyUrl)
  const port = String(env[VLLM_PORT_ENV] || '8000').trim()
  let url = explicit
  if (!url && host) url = `http://${host}:${port}/v1/models`
  if (!url) return { up: false, reachable: false, url: null, error: 'no render host to probe (ComfyUI URL unset)' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: controller.signal })
    const body = await res.text().catch(() => '')
    const looksLikeVllm = res.status < 500 && /"(id|object|data)"|model/.test(body.slice(0, 400))
    return {
      up: res.ok || looksLikeVllm,
      reachable: true,
      url,
      status: res.status,
      models: (() => { try { return (JSON.parse(body).data || []).map((m) => m.id) } catch { return [] } })(),
    }
  } catch (err) {
    return { up: false, reachable: false, url, error: err?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(err?.message || err) }
  } finally {
    clearTimeout(timer)
  }
}

/** Cheap liveness probe of ComfyUI itself (also the source of /object_info at doctor time). */
export async function probeComfy({ url, fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (!url) return { up: false, reachable: false, url: null, error: 'unset' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${url}/system_stats`, { signal: controller.signal })
    return { up: res.ok, reachable: true, url, status: res.status }
  } catch (err) {
    return { up: false, reachable: false, url, error: err?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(err?.message || err) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The gate. `kind` is 'video' | 'audio' | 'still'.
 * Throws RenderGateError naming the failed check and the remedy; returns the
 * probe facts when allowed so the caller can log them.
 */
export async function assertGenerationAllowed({
  kind = 'video',
  env = process.env,
  home = homedir(),
  fetchImpl = fetch,
  comfyUrl: comfyUrlOverride = null,
} = {}) {
  const target = comfyUrlOverride ? { url: comfyUrlOverride, source: 'argument' } : await resolveComfyTarget({ env, home })

  if (!target.url) {
    throw new RenderGateError(
      'ComfyUI URL is unset — refusing to render. Nothing was contacted and no localhost was assumed.',
      {
        check: 'comfy-url-configured',
        remedy: `Set ${COMFY_URL_ENV} to the ComfyUI base URL (e.g. the Spark tailnet address), or put { "comfyUrl": "..." } in ${target.configFile}.`,
      },
    )
  }

  const comfy = await probeComfy({ url: target.url, fetchImpl })
  const vllm = await probeVllm({ comfyUrl: target.url, env, fetchImpl })
  const facts = { comfy: { ...target, ...comfy }, vllm, kind }

  if (!comfy.up && !comfy.reachable) {
    throw new RenderGateError(
      `ComfyUI at ${target.url} is not answering (${comfy.error}). Nothing was queued.`,
      { check: 'comfy-reachable', remedy: 'Start ComfyUI on the render host, or fix the URL — it resolved from ' + target.source + '.' },
    )
  }

  if (vllm.up) {
    const models = vllm.models?.length ? ` Serving: ${vllm.models.join(', ')}.` : ''
    if (kind === 'still') {
      throw new RenderGateError(
        `vLLM is answering at ${vllm.url}, so even the still-frame test is refused on this host.${models}`,
        { check: 'vllm-not-running', remedy: 'Still frames are allowed only while vLLM is down. Shut vLLM down with Henry\'s explicit ok, then re-run --stills.' },
      )
    }
    throw new RenderGateError(
      `vLLM is answering at ${vllm.url}, so ${kind} generation is refused on this machine.${models}`,
      {
        check: 'vllm-not-running',
        remedy: 'Two options: (a) render stills instead with --stills (allowed only once vLLM is down), or (b) shut vLLM down with Henry\'s explicit ok and re-run. Do not queue video or audio while vLLM is up.',
      },
    )
  }

  if (!vllm.reachable && kind !== 'still') {
    // We could not prove vLLM is down. On a shared GPU box that is not a green light.
    throw new RenderGateError(
      `Could not check vLLM at ${vllm.url} (${vllm.error}) — refusing ${kind} generation rather than assuming it is down.`,
      { check: 'vllm-probe-readable', remedy: `Point ${VLLM_URL_ENV} at the real vLLM endpoint (or confirm the port via ${VLLM_PORT_ENV}) and re-run.` },
    )
  }

  return facts
}

/**
 * Full-render gate: Henry approves GPU time, so a multi-shot render needs
 * BELROG_GPU_GO as well as the vLLM gate.
 */
export function assertFullRenderApproved({ env = process.env } = {}) {
  const go = String(env[GPU_GO_ENV] || '').trim()
  if (!go) {
    throw new RenderGateError(
      `Full (multi-shot) render refused: ${GPU_GO_ENV} is not set. Henry approves full renders.`,
      { check: 'gpu-go', remedy: `Run a single calibration shot with --single, stills with --stills, or export ${GPU_GO_ENV}=1 once Henry has said go.` },
    )
  }
  return { approved: true, source: `env:${GPU_GO_ENV}`, value: go }
}
