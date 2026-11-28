/**
 * Shot Plan Validator — V-Gate
 *
 * Three layers of validation:
 *  1. Grammar check via ltx_prompt_lint.py (prompt syntax, banned tokens, length)
 *  2. JSON Schema validation (shotPlan.schema.json)
 *  3. One repair retry via LLM if validation fails
 *
 * Returns validated plan with llm.repairRetries incremented.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import Ajv2020 from 'ajv/dist/2020.js'
import { compilePromptRequest, callLLM } from './promptCompiler.js'

// This file must be loadable from an ESM context (Electron main imports it), and
// ESM has no require(). createRequire keeps the optional-dependency probes working.
import { createRequire as _createRequire } from 'node:module'
const nodeRequire = _createRequire(import.meta.url)

const SCHEMA_PATH = resolve('src/schema/shotPlan.schema.json')
const AJV = new Ajv2020({ strict: true, allowUnionTypes: false, allErrors: true })
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))
const VALIDATE = AJV.compile(SCHEMA)

// Path to ltx_prompt_lint.py (may be in project root or scripts)
const LINT_PATHS = [
  resolve('ltx_prompt_lint.py'),
  resolve('scripts/ltx_prompt_lint.py'),
  resolve('tools/ltx_prompt_lint.py'),
]

let cachedLintPath = null

function findLintScript() {
  if (cachedLintPath) return cachedLintPath
  const { accessSync, constants } = nodeRequire('node:fs')
  for (const p of LINT_PATHS) {
    try {
      accessSync(p, constants.X_OK)
      cachedLintPath = p
      return p
    } catch {}
  }
  // Not found — will be created by setup
  return null
}

/**
 * Run ltx_prompt_lint.py on all prompts in the plan.
 * @param {Object} plan - The shot plan object
 * @returns {Promise<{ ok: boolean, errors: string[] }>}
 */
async function runGrammarCheck(plan) {
  const lintPath = findLintScript()
  if (!lintPath) {
    // If lint script doesn't exist, create a minimal one inline
    return runInlineGrammarCheck(plan)
  }

  // Collect all prompt strings from the plan
  const prompts = collectPrompts(plan)

  return new Promise((resolve) => {
    const proc = spawn('python3', [lintPath, '--stdin'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    proc.stdin.write(JSON.stringify({ prompts }))
    proc.stdin.end()

    proc.stdout.on('data', d => stdout += d)
    proc.stderr.on('data', d => stderr += d)

    proc.on('close', code => {
      if (code === 0) {
        resolve({ ok: true, errors: [] })
      } else {
        try {
          const result = JSON.parse(stdout)
          resolve({ ok: false, errors: result.errors || [stderr || 'Grammar check failed'] })
        } catch {
          resolve({ ok: false, errors: [stdout || stderr || 'Grammar check failed with unknown error'] })
        }
      }
    })

    proc.on('error', err => {
      resolve({ ok: false, errors: [`Failed to spawn linter: ${err.message}`] })
    })
  })
}

/**
 * Inline grammar check (fallback when ltx_prompt_lint.py not available).
 * Checks: banned tokens, max length, required fields, enum compliance.
 */
function runInlineGrammarCheck(plan) {
  const errors = []

  // Banned tokens (per style guide)
  const bannedPatterns = [
    /arithmetic/gi, // Henry's forbidden word
    /figure it out at render time/gi,
    /waiting for the director to write this frame/gi,
    /placeholder/gi,
    /todo/gi,
    /xxx/gi,
  ]

  // Check all prompt-like fields
  function checkField(path, value) {
    if (!value || typeof value !== 'string') return
    for (const pattern of bannedPatterns) {
      if (pattern.test(value)) {
        errors.push(`${path}: contains banned pattern "${pattern.source}"`)
      }
    }
    // Max length for prompts (LTX context limit)
    if (value.length > 2500) {
      errors.push(`${path}: prompt too long (${value.length} chars, max 2500)`)
    }
  }

  // Walk the plan for prompt fields
  const promptPaths = [
    { path: 'shots[].keyframePromptRaw', values: plan.shots?.map(s => s.keyframePromptRaw) || [] },
    { path: 'shots[].motionPromptRaw', values: plan.shots?.map(s => s.motionPromptRaw) || [] },
    { path: 'shots[].action', values: plan.shots?.map(s => s.action) || [] },
    { path: 'look.film', values: [plan.look?.film] },
    { path: 'look.lighting', values: [plan.look?.lighting] },
    { path: 'look.location.lock', values: [plan.look?.location?.lock] },
    { path: 'cast[].lock', values: plan.cast?.map(c => c.lock) || [] },
    { path: 'cast[].wardrobe', values: plan.cast?.map(c => c.wardrobe) || [] },
  ]

  for (const { path, values } of promptPaths) {
    for (let i = 0; i < values.length; i++) {
      checkField(`${path}[${i}]`, values[i])
    }
  }

  // Check enum compliance for shots
  const validShotType = ['performance', 'performance_wide', 'b_roll']
  const validSize = ['wide', 'medium', 'close-up', 'detail']
  const validCameraMove = ['locked', 'push-in', 'pull-out', 'pan-left', 'tilt-up', 'orbit', 'handheld', 'dutch-tilt', 'dolly-zoom', 'whip-pan', 'steadicam', 'crane', 'snap-zoom']
  const validEnergy = ['calm', 'building', 'intense']
  const validPerfMode = ['lip-sync', 'wide-performance', 'b-roll', 'narrative']
  const validSectionKind = ['intro', 'verse', 'pre_chorus', 'chorus', 'bridge', 'breakdown', 'outro', 'other']
  const validProfileSource = ['envelope', 'timed_lyrics', 'manual']
  const validPreset = ['mtv-1990s']
  const validBackend = ['local', 'lmstudio', 'openrouter']

  for (let i = 0; i < (plan.shots?.length || 0); i++) {
    const s = plan.shots[i]
    if (s.shotType && !validShotType.includes(s.shotType)) errors.push(`shots[${i}].shotType: invalid "${s.shotType}"`)
    if (s.size && !validSize.includes(s.size)) errors.push(`shots[${i}].size: invalid "${s.size}"`)
    if (s.cameraMove && !validCameraMove.includes(s.cameraMove)) errors.push(`shots[${i}].cameraMove: invalid "${s.cameraMove}"`)
    if (s.energy && !validEnergy.includes(s.energy)) errors.push(`shots[${i}].energy: invalid "${s.energy}"`)
    if (s.performanceMode && !validPerfMode.includes(s.performanceMode)) errors.push(`shots[${i}].performanceMode: invalid "${s.performanceMode}"`)
  }

  for (let i = 0; i < (plan.track?.sections?.length || 0); i++) {
    const sec = plan.track.sections[i]
    if (sec.kind && !validSectionKind.includes(sec.kind)) errors.push(`track.sections[${i}].kind: invalid "${sec.kind}"`)
  }

  if (plan.track?.profileSource && !validProfileSource.includes(plan.track.profileSource)) {
    errors.push(`track.profileSource: invalid "${plan.track.profileSource}"`)
  }

  if (plan.look?.preset && !validPreset.includes(plan.look.preset)) {
    errors.push(`look.preset: invalid "${plan.look.preset}"`)
  }

  if (plan.llm?.backend && !validBackend.includes(plan.llm.backend)) {
    errors.push(`llm.backend: invalid "${plan.llm.backend}"`)
  }

  // Check no nulls used for optional fields (must be omitted)
  function checkNoNulls(obj, path = '') {
    if (obj === null) {
      errors.push(`${path}: null used for optional field (must be omitted)`)
      return
    }
    if (Array.isArray(obj)) {
      obj.forEach((v, i) => checkNoNulls(v, `${path}[${i}]`))
    } else if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        checkNoNulls(v, path ? `${path}.${k}` : k)
      }
    }
  }
  checkNoNulls(plan)

  return { ok: errors.length === 0, errors }
}

/**
 * Collect all prompt strings from plan for external linter.
 */
function collectPrompts(plan) {
  const prompts = []
  if (plan.shots) {
    for (const shot of plan.shots) {
      if (shot.keyframePromptRaw) prompts.push({ id: shot.id, field: 'keyframePromptRaw', text: shot.keyframePromptRaw })
      if (shot.motionPromptRaw) prompts.push({ id: shot.id, field: 'motionPromptRaw', text: shot.motionPromptRaw })
      if (shot.action) prompts.push({ id: shot.id, field: 'action', text: shot.action })
    }
  }
  if (plan.look) {
    if (plan.look.film) prompts.push({ id: 'look', field: 'film', text: plan.look.film })
    if (plan.look.lighting) prompts.push({ id: 'look', field: 'lighting', text: plan.look.lighting })
    if (plan.look.location?.lock) prompts.push({ id: 'look.location', field: 'lock', text: plan.look.location.lock })
  }
  if (plan.cast) {
    for (const c of plan.cast) {
      if (c.lock) prompts.push({ id: c.slug, field: 'cast.lock', text: c.lock })
      if (c.wardrobe) prompts.push({ id: c.slug, field: 'cast.wardrobe', text: c.wardrobe })
    }
  }
  return prompts
}

/**
 * Validate plan against JSON Schema.
 */
function validateSchema(plan) {
  const valid = VALIDATE(plan)
  if (valid) return { ok: true, errors: [] }

  const errors = (VALIDATE.errors || []).map(e => {
    const path = e.instancePath || e.schemaPath
    return `${path}: ${e.message} (keyword: ${e.keyword})`
  })
  return { ok: false, errors }
}

/**
 * Repair plan via LLM given validation errors.
 */
async function repairPlan(plan, errors, { backend, modelId, win }) {
  const messages = [
    {
      role: 'system',
      content: `You are a JSON repair agent. Fix the provided plan.json to satisfy the schema and grammar rules.
The plan must conform to shotPlan.schema.json (GBNF subset: no $ref, oneOf, anyOf, allOf, patternProperties, if/then, format, pattern).
Rules:
- Never use null for optional fields — omit the key entirely
- All enum values must match exactly
- Shots must be chronological, no gaps, cover full duration
- Prompts must not contain banned words: arithmetic, placeholder, "figure it out", "waiting for the director"
- Prompt max length: 2500 chars
- Output ONLY the corrected JSON, no markdown, no explanation.`
    },
    {
      role: 'user',
      content: `Validation errors:\n${errors.join('\n')}\n\nCurrent plan:\n${JSON.stringify(plan, null, 2)}`
    },
  ]

  const request = compilePromptRequest({
    messages,
    schema: SCHEMA,
    backend,
    modelId,
    temperature: 0.2,
    maxTokens: 8192,
  })

  const response = await callLLM(request, { backend, modelId, win })
  const repaired = parseJSONResponse(response)

  // Validate repaired
  const schemaCheck = validateSchema(repaired)
  if (!schemaCheck.ok) {
    throw new Error(`Repair failed schema validation: ${schemaCheck.errors.join('; ')}`)
  }

  const grammarCheck = runInlineGrammarCheck(repaired)
  if (!grammarCheck.ok) {
    throw new Error(`Repair failed grammar check: ${grammarCheck.errors.join('; ')}`)
  }

  return repaired
}

function parseJSONResponse(text) {
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/)
    if (match) {
      try {
        return JSON.parse(match[1])
      } catch {}
    }
    const braceMatch = text.match(/\{[\s\S]*\}/)
    if (braceMatch) {
      try {
        return JSON.parse(braceMatch[0])
      } catch {}
    }
    throw new Error('Failed to parse JSON from LLM repair response')
  }
}

/**
 * Main validation entry point: grammar + schema + one repair retry.
 * @returns {Promise<Object>} validated plan with llm.repairRetries updated
 */
export async function validatePlan(plan, { backend, modelId, win }) {
  let currentPlan = plan
  let repairRetries = 0

  // Run grammar check
  let grammarResult = await runGrammarCheck(currentPlan)
  if (!grammarResult.ok) {
    if (repairRetries < 1) {
      currentPlan = await repairPlan(currentPlan, grammarResult.errors, { backend, modelId, win })
      repairRetries++
      grammarResult = await runGrammarCheck(currentPlan)
      if (!grammarResult.ok) throw new Error(`Grammar check failed after repair: ${grammarResult.errors.join('; ')}`)
    } else {
      throw new Error(`Grammar check failed: ${grammarResult.errors.join('; ')}`)
    }
  }

  // Run schema validation
  let schemaResult = validateSchema(currentPlan)
  if (!schemaResult.ok) {
    if (repairRetries < 1) {
      currentPlan = await repairPlan(currentPlan, schemaResult.errors, { backend, modelId, win })
      repairRetries++
      schemaResult = validateSchema(currentPlan)
      if (!schemaResult.ok) throw new Error(`Schema validation failed after repair: ${schemaResult.errors.join('; ')}`)
    } else {
      throw new Error(`Schema validation failed: ${schemaResult.errors.join('; ')}`)
    }
  }

  // Update repair retry count in plan
  if (!currentPlan.llm) currentPlan.llm = {}
  currentPlan.llm.repairRetries = repairRetries

  return currentPlan
}

/**
 * Standalone validate (no repair) for testing.
 */
export function validatePlanStrict(plan) {
  const grammar = runInlineGrammarCheck(plan)
  const schema = validateSchema(plan)
  return {
    ok: grammar.ok && schema.ok,
    grammarErrors: grammar.errors,
    schemaErrors: schema.errors,
  }
}

/**
 * Export for testing.
 */
export { runInlineGrammarCheck, validateSchema, runGrammarCheck }