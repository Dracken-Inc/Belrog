/**
 * Prompt Compiler — llama-server Request Builder
 *
 * Compiles action prose + JSON schema into llama-server /v1/chat/completions request.
 * Handles grammar-constrained decoding (GBNF from JSON schema) when available.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SCHEMA_PATH = resolve('src/schema/shotPlan.schema.json')
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))

/**
 * Convert JSON Schema to GBNF grammar for llama.cpp constrained decoding.
 * Only supports the GBNF-expressible subset (no $ref, oneOf, anyOf, allOf, etc.)
 */
export function jsonSchemaToGBNF(schema, rootName = 'root') {
  const defs = {}

  function typeToGBNF(s, name) {
    const t = s.type
    if (!t) return ''

    if (Array.isArray(t)) {
      // Union types not supported in GBNF subset — should not happen per schema law
      return typeToGBNF({ type: t[0] }, name)
    }

    switch (t) {
      case 'string':
        if (s.enum && s.enum.length > 0) {
          const escaped = s.enum.map(v => '"' + String(v).replace(/["\\]/g, '\\$&') + '"').join(' | ')
          return `(${escaped})`
        }
        if (s.format === 'uri') return '"uri"' // Simplified
        return 'string'
      case 'number':
      case 'integer':
        return 'number'
      case 'boolean':
        return 'boolean'
      case 'array':
        if (s.items) {
          const itemType = typeToGBNF(s.items, `${name}_item`)
          return `array ${itemType}`
        }
        return 'array'
      case 'object':
        return objectToGBNF(s, name)
      default:
        return 'null'
    }
  }

  function objectToGBNF(s, name) {
    if (!s.properties) return 'object { }'
    const required = new Set(s.required || [])
    const props = []
    for (const [key, propSchema] of Object.entries(s.properties)) {
      const optional = !required.has(key)
      const propType = typeToGBNF(propSchema, key)
      const keyStr = '"' + key.replace(/["\\]/g, '\\$&') + '"'
      if (optional) {
        props.push(`  ${keyStr} [ ${propType} ]`)
      } else {
        props.push(`  ${keyStr} ${propType}`)
      }
    }
    // additionalProperties: false is the law
    return `object {\n${props.join(',\n')}\n}`
  }

  const grammar = objectToGBNF(schema, rootName)
  return `root ::= ${grammar}\n${Object.entries(defs).map(([k, v]) => `${k} ::= ${v}`).join('\n')}`
}

/**
 * Build the llama-server chat completion request.
 * @param {Object} opts - { messages, schema, backend, modelId, temperature, maxTokens }
 * @returns {Object} Request body for /v1/chat/completions
 */
export function compilePromptRequest({ messages, schema, backend, modelId, temperature = 0.6, maxTokens = 4096 }) {
  const request = {
    model: modelId || 'auto',
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  }

  // Grammar-constrained decoding for local backend with schema
  if (backend === 'local' && schema) {
    try {
      const gbnf = jsonSchemaToGBNF(schema)
      request.grammar = gbnf
      request.grammar_lazy = true // compile on first use
    } catch (e) {
      console.warn('[promptCompiler] GBNF compilation failed, falling back to unconstrained:', e.message)
    }
  }

  // For LM Studio / OpenRouter: pass response_format if they support it
  if ((backend === 'lmstudio' || backend === 'openrouter') && schema) {
    request.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'shot_plan',
        strict: true,
        schema,
      },
    }
  }

  return request
}

/**
 * Call LLM backend (local, lmstudio, openrouter).
 * This is a thin wrapper — actual HTTP calls are in actionProse.mjs for now.
 * Kept here for future consolidation.
 */
export async function callLLM(request, { backend, modelId, win }) {
  // Delegate to actionProse's backend callers for now
  // This function exists for API completeness
  throw new Error('callLLM not implemented in promptCompiler — use actionProse.mjs backend callers')
}

/**
 * Extract JSON from LLM response (handles markdown code blocks, etc.)
 */
export function extractJSON(text) {
  try {
    return JSON.parse(text)
  } catch {}

  // Try markdown code block
  const mdMatch = text.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/)
  if (mdMatch) {
    try {
      return JSON.parse(mdMatch[1])
    } catch {}
  }

  // Try first { ... } block
  const braceMatch = text.match(/\{[\s\S]*\}/)
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0])
    } catch {}
  }

  throw new Error('Failed to extract JSON from response')
}

/**
 * Build system prompt for shot plan generation with schema context.
 */
export function buildShotPlanSystemPrompt(schema) {
  const required = schema.required || []
  const props = schema.properties || {}
  const fields = Object.entries(props).map(([k, v]) => {
    const desc = v.description || ''
    const req = required.includes(k) ? ' (required)' : ''
    return `  ${k}${req}: ${desc}`
  }).join('\n')

  return `You are a music video director producing a structured shot plan.
Output MUST be valid JSON matching this schema exactly:

${fields}

Rules:
- Never use null for optional fields — omit the key entirely
- All enum values must match exactly
- Shots array must be chronological, no gaps, cover full track duration
- Prompts must be concrete, visual, production-ready (no placeholders)
- Maximum prompt length: 2500 characters
- No banned words: "arithmetic", "placeholder", "figure it out", "waiting for the director"
`
}