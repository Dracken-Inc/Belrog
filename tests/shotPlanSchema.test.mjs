/**
 * Freeze test for src/schema/shotPlan.schema.json — the ONE shot-plan contract.
 *
 * Two workers write against this file: the input layer produces it, the output
 * layer renders from it, and the imagination LLM is told to emit it via
 * response_format. The failure mode this guards is the one that already burned
 * the pipeline once: two vocabularies, one artifact. If the schema drifts from
 * src/config/musicVideoShotConfig.js, the LLM invents ids that the generator
 * cannot resolve and the output silently degrades into filler.
 *
 * Three jobs, all control checks by construction:
 *   1. the file stays valid JSON Schema and compiles,
 *   2. it stays inside the GBNF subset a grammar builder can express (V11),
 *   3. its enums equal the shipped vocabularies, with any forward-only id
 *      declared in PENDING_VOCAB so it cannot hide.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_PATH = path.join(ROOT, 'src', 'schema', 'shotPlan.schema.json')
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))

/** Keywords a GBNF grammar builder cannot express. Presence = constrained decoding fails. */
const FORBIDDEN_KEYWORDS = [
  '$ref', '$defs', 'definitions', 'oneOf', 'anyOf', 'allOf', 'not',
  'if', 'then', 'else', 'dependentSchemas', 'patternProperties',
  'format', 'pattern', 'const', 'contentEncoding'
]

/**
 * Ids the schema allows that the shipped config does not yet list. Each one is a
 * real gap that W-A step 4 closes by extending src/config/musicVideoShotConfig.js;
 * when the config catches up, delete the entry here. Anything NOT listed here and
 * NOT in the config is drift, and fails.
 */
const PENDING_VOCAB = {
  'look.preset': ['mtv-1990s'],
  'shots[].cameraMove': ['dutch-tilt', 'dolly-zoom', 'whip-pan', 'steadicam', 'crane', 'snap-zoom'],
  'track.sections[].kind': ['intro', 'verse', 'pre_chorus', 'chorus', 'bridge', 'breakdown', 'outro', 'other'],
  'track.profileSource': ['envelope', 'timed_lyrics', 'manual'],
  'llm.backend': ['local', 'lmstudio', 'openrouter']
}

function walk(node, visit, trail = '$') {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, visit, `${trail}[${i}]`))
    return
  }
  if (node && typeof node === 'object') {
    visit(node, trail)
    for (const [key, value] of Object.entries(node)) {
      walk(value, visit, `${trail}.${key}`)
    }
  }
}

test('shot plan schema parses and compiles as JSON Schema', () => {
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: false, allErrors: true })
  const validate = ajv.compile(schema)
  assert.equal(typeof validate, 'function', 'schema did not compile')
})

test('shot plan schema stays inside the GBNF-friendly subset (V11)', () => {
  const hits = []
  walk(schema, (node, trail) => {
    for (const keyword of FORBIDDEN_KEYWORDS) {
      if (Object.prototype.hasOwnProperty.call(node, keyword)) {
        hits.push(`${trail}: ${keyword}`)
      }
    }
    // A nullable union is not expressible either; absence means "not applicable".
    if (Array.isArray(node.type)) hits.push(`${trail}: type union [${node.type.join(',')}]`)
    if (node.nullable === true) hits.push(`${trail}: nullable`)
  })
  assert.deepEqual(hits, [], `grammar-hostile keywords found:\n${hits.join('\n')}`)
})

test('every object in the schema closes itself and names its required keys', () => {
  const open = []
  walk(schema, (node, trail) => {
    if (node.type === 'object') {
      if (node.additionalProperties !== false) open.push(`${trail}: additionalProperties not false`)
      if (!Array.isArray(node.required)) open.push(`${trail}: no required list`)
    }
  })
  assert.deepEqual(open, [], `open objects:\n${open.join('\n')}`)
})

test('llm provenance block is required on every plan', () => {
  assert.deepEqual(schema.required, ['schemaVersion', 'track', 'look', 'cast', 'shots', 'clips', 'llm'])
  assert.deepEqual(schema.properties.llm.required, ['backend', 'modelId'])
  assert.ok(schema.properties.llm.properties.endpoint)
  assert.ok(schema.properties.llm.properties.grammarEnforced)
})

test('schema enums match the shipped vocabularies, plus declared pending ids', async () => {
  const config = await import('../src/config/musicVideoShotConfig.js')
  const pairs = [
    ['shots[].size', 'MUSIC_VIDEO_SHOT_SIZE_OPTIONS'],
    ['shots[].shotType', 'MUSIC_VIDEO_SHOT_TYPE_OPTIONS'],
    ['shots[].cameraMove', 'MUSIC_VIDEO_CAMERA_MOVE_OPTIONS'],
    ['shots[].energy', 'MUSIC_VIDEO_ENERGY_OPTIONS'],
    ['shots[].performanceMode', 'MUSIC_VIDEO_PERFORMANCE_MODE_OPTIONS'],
    ['cast[].role', 'MUSIC_VIDEO_CAST_ROLE_OPTIONS'],
    ['look.preset', 'MUSIC_VIDEO_STYLE_CARD_OPTIONS']
  ]
  const enumFor = {
    'shots[].size': schema.properties.shots.items.properties.size.enum,
    'shots[].shotType': schema.properties.shots.items.properties.shotType.enum,
    'shots[].cameraMove': schema.properties.shots.items.properties.cameraMove.enum,
    'shots[].energy': schema.properties.shots.items.properties.energy.enum,
    'shots[].performanceMode': schema.properties.shots.items.properties.performanceMode.enum,
    'cast[].role': schema.properties.cast.items.properties.role.enum,
    'look.preset': schema.properties.look.properties.preset.enum
  }
  for (const [field, symbol] of pairs) {
    const configIds = config[symbol].map((option) => option.id)
    const schemaIds = enumFor[field]
    const missing = configIds.filter((id) => !schemaIds.includes(id))
    assert.deepEqual(missing, [], `schema ${field} dropped ids the config ships (${symbol})`)
    const undeclared = schemaIds.filter(
      (id) => !configIds.includes(id) && !(PENDING_VOCAB[field] || []).includes(id)
    )
    assert.deepEqual(undeclared, [], `schema ${field} invented ids not in the config and not declared pending`)
    const stale = (PENDING_VOCAB[field] || []).filter((id) => !schemaIds.includes(id))
    assert.deepEqual(stale, [], `PENDING_VOCAB lists ${field} ids the schema no longer allows — prune the entry`)
  }
})

test('a conforming plan validates and a slipped one does not', () => {
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: false, allErrors: true })
  const validate = ajv.compile(schema)
  const plan = {
    schemaVersion: 1,
    track: {
      path: '/music/forsaken.m4a',
      durationSec: 283.56,
      hash: 'sha256:ce1f',
      bpm: 118.4,
      beats: [0.0, 0.508, 1.016],
      sections: [
        { id: 'intro', kind: 'intro', startSec: 0, endSec: 17.0, energy: 0.22 },
        { id: 'verse-1', kind: 'verse', startSec: 17.0, endSec: 39.3, energy: 0.41 }
      ],
      profileSource: 'envelope'
    },
    look: {
      preset: 'mtv-1990s',
      film: '35mm anamorphic, Kodak Vision3 500T, visible grain and halation',
      letterbox: '2.35:1 matte',
      lighting: 'hard backlight, cyan and amber gels, haze',
      location: {
        slug: 'rooftop-night',
        lock: 'wet concrete rooftop at night, chain-link fence, sodium city glow behind',
        props: [{ slug: 'bullhorn', lock: 'dented silver bullhorn with a cracked handle' }]
      }
    },
    cast: [
      { slug: 'vocalist', role: 'lead', lock: 'lean man, buzz cut, black tech jacket over a grey tee' }
    ],
    shots: [
      {
        id: 's01',
        sectionId: 'intro',
        startSec: 0,
        endSec: 8.4,
        shotType: 'performance_wide',
        size: 'wide',
        cameraMove: 'crane',
        energy: 'building',
        cast: ['vocalist'],
        props: [],
        lipSync: false,
        action: 'wide crane down onto the rooftop as the first feedback swell hits'
      }
    ],
    clips: [{ index: 0, startSec: 0, lengthSec: 8.4, shotIds: ['s01'] }],
    llm: { backend: 'local', modelId: 'recommended-preset-q4_k_m.gguf', grammarEnforced: true, repairRetries: 0 }
  }
  assert.equal(validate(plan), true, JSON.stringify(validate.errors))

  // A second compile of the same schema must be deterministic — V9 depends on it.
  assert.equal(validate(JSON.parse(JSON.stringify(plan))), true)

  const invented = JSON.parse(JSON.stringify(plan))
  invented.shots[0].cameraMove = 'drone-orbit-360'
  assert.equal(validate(invented), false, 'an id outside the vocabulary must fail')

  const inventedCast = JSON.parse(JSON.stringify(plan))
  inventedCast.shots[0].shotType = 'guitar_riff'
  assert.equal(validate(inventedCast), false, 'a made-up shot type must fail')

  const sloppy = JSON.parse(JSON.stringify(plan))
  sloppy.shots[0].notes = 'figure it out at render time'
  assert.equal(validate(sloppy), false, 'fields the schema does not declare must fail')

  const nullable = JSON.parse(JSON.stringify(plan))
  nullable.shots[0].lyric = null
  assert.equal(validate(nullable), false, 'null must not stand in for an omitted field')

  const anonymous = JSON.parse(JSON.stringify(plan))
  delete anonymous.llm
  assert.equal(validate(anonymous), false, 'a plan with no provenance must fail')
})
