/**
 * Action Prose — Two-Pass Imagination Engine
 *
 * Pass 1 (compilePlot): Generate a narrative plot/arc from lyrics + audio structure.
 * Pass 2 (compileShots): Generate per-shot CSV with required columns:
 *   Shot_ID, Type, Video_Prompt (+ all schema fields)
 *
 * Backend-agnostic: supports 'local' (llama-server sidecar), 'lmstudio', 'openrouter'.
 */
import { compilePromptRequest } from './promptCompiler.js'

// ═══════════════════════════════════════════
// Pass 1: Plot Generation
// ═══════════════════════════════════════════

const PLOT_SYSTEM_PROMPT = `You are a music video director writing a narrative treatment.
Given a song's lyrics, structure, and style brief, write a coherent plot summary that
guides shot-level planning. The plot must:
- Have a clear beginning, middle, end aligned with song sections
- Name the cast characters (from provided slugs) and their roles
- Establish the primary location(s) and visual mood
- Define the narrative arc: setup → conflict → climax → resolution
- Be specific enough that a second pass can derive individual shots from it
- Reference beat timestamps and section boundaries where dramatic beats land

Output: JSON object with keys:
  "logline": "one-sentence summary",
  "arc": ["setup", "conflict", "climax", "resolution"],
  "cast": [{ "slug": "...", "role": "...", "description": "..." }],
  "locations": [{ "slug": "...", "description": "..." }],
  "beats": [{ "sectionId": "...", "timeSec": 0, "description": "what happens" }],
  "visualStyle": "mtv-1990s style description"
`

/**
 * Compute per-section shot budget: ~1 shot per 4 seconds, clamped to [2, 8].
 * @param {number} sectionDurationSec
 * @returns {number}
 */
export function computeShotBudget(sectionDurationSec) {
  return Math.max(2, Math.min(8, Math.round(sectionDurationSec / 4)))
}

function buildPlotUserPrompt({ title, artist, durationSec, lyricsRaw, sections, beats, style, creativePreset, castSlugs }) {
  const sectionSummary = sections.map(s =>
    `${s.id} (${s.kind}): ${s.startSec.toFixed(1)}–${s.endSec.toFixed(1)}s, energy ${s.energy}`
  ).join('\n')

  // Downsample beats to 32 evenly spaced samples spanning first to last onset
  const beatSummary = beats && beats.length > 0
    ? downsampleBeats(beats, 32).map((b, i) => `${i}: ${b.toFixed(2)}s`).join(', ')
    : 'none provided'

  return `Song: "${title}" by ${artist || 'unknown'}
Duration: ${durationSec.toFixed(1)}s
Style: ${style} (${creativePreset})
Cast slugs available: ${castSlugs.join(', ') || 'none — create new'}

Sections (from audio envelope):
${sectionSummary}

Beats (32 evenly spaced):
${beatSummary}

Lyrics (raw):
${lyricsRaw.slice(0, 4000)}

Write the plot treatment as JSON.`
}

/**
 * Pass 1: Compile narrative plot from song metadata + audio structure.
 * @returns {Promise<Object>} plot object with logline, arc, cast, locations, beats, visualStyle
 */
export async function compilePlot(input, { backend, modelId, win }) {
  const messages = [
    { role: 'system', content: PLOT_SYSTEM_PROMPT },
    { role: 'user', content: buildPlotUserPrompt(input) },
  ]

  const request = compilePromptRequest({
    messages,
    schema: null, // plot is free-form JSON, not schema-constrained
    backend,
    modelId,
    temperature: 0.7,
    maxTokens: 2048,
  })

  const response = await callLLM(request, { backend, modelId, win })
  const plot = parseJSONResponse(response)

  // Validate required keys
  const required = ['logline', 'arc', 'cast', 'locations', 'beats', 'visualStyle']
  for (const key of required) {
    if (!plot[key]) throw new Error(`Plot missing required key: ${key}`)
  }

  return plot
}

// ═══════════════════════════════════════════
// Pass 2: Per-Shot CSV Generation
// ═══════════════════════════════════════════

const SHOT_BUDGET_PLACEHOLDER = '{{SHOT_BUDGET}}'

const SHOTS_SYSTEM_PROMPT = `You are a music video director breaking a plot into individual shots.
Given a plot treatment, song structure, and style brief, produce a shot list as CSV.

REQUIRED COLUMNS (exact names, case-sensitive):
  Shot_ID, Section_ID, Start_Sec, End_Sec, Shot_Type, Size, Camera_Move, Energy, Performance_Mode, Cast, Props, Lyric, Lip_Sync, Action, Location_Override, Film, Lighting

ENUM CONSTRAINTS (must match exactly):
  Shot_Type: performance | performance_wide | b_roll
  Size: wide | medium | close-up | detail
  Camera_Move: locked | push-in | pull-out | pan-left | tilt-up | orbit | handheld | whip-pan | snap-zoom
  Energy: calm | building | intense
  Performance_Mode: lip-sync | wide-performance | b-roll | narrative

RULES:
- Shots must be in ascending Start_Sec order, no gaps, no overlaps
- Every shot's Section_ID must match a provided section id
- Lip_Sync: "true" only for performance/performance_wide shots with a Lyric
- Cast: comma-separated slugs (empty for b_roll with nobody)
- Props: comma-separated slugs from provided props list (empty if none)
- Lyric: the exact lyric line for lip-sync shots; empty otherwise
- Action: prose description of what happens on screen (the only free prose field)
- Location_Override: slug from locations list or empty to inherit
- Film/Lighting: per-shot overrides or empty to inherit from look
- Target ${SHOT_BUDGET_PLACEHOLDER} shots per section; minimum shot length 1.5s; maximum 15s
- MTV-1990s style: whip-pan, snap-zoom, hard backlight, cyan/magenta/amber gels, 35mm grain, anamorphic letterbox

Output: CSV with header row + data rows. No markdown, no extra text.
`

/**
 * Downsample beats to N evenly spaced samples spanning first to last onset.
 * @param {number[]} beats - Array of onset timestamps in seconds
 * @param {number} count - Number of samples to return (default 32)
 * @returns {number[]}
 */
export function downsampleBeats(beats, count = 32) {
  if (!beats || beats.length === 0) return []
  if (beats.length <= count) return [...beats].sort((a, b) => a - b)
  const sorted = [...beats].sort((a, b) => a - b)
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const result = []
  for (let i = 0; i < count; i++) {
    const ratio = i / (count - 1)
    const target = first + ratio * (last - first)
    // Find the closest actual beat to this target
    let bestIdx = 0
    let bestDist = Infinity
    for (let j = 0; j < sorted.length; j++) {
      const dist = Math.abs(sorted[j] - target)
      if (dist < bestDist) {
        bestDist = dist
        bestIdx = j
      }
    }
    result.push(sorted[bestIdx])
  }
  return result
}

function buildShotsUserPrompt({ plot, title, durationSec, sections, beats, shots, style, creativePreset, castSlugs, sectionBudgets }) {
  const sectionList = sections.map((s, idx) => {
    const budget = sectionBudgets ? sectionBudgets[idx] : '?'
    return `${s.id} (${s.kind}): ${s.startSec.toFixed(1)}–${s.endSec.toFixed(1)}s [budget: ${budget} shots]`
  }).join('\n')
  const shotTemplate = shots.map(s => `${s.startSec.toFixed(1)}–${s.endSec.toFixed(1)}s: ${s.lyric.join(' / ') || '[no vocal]'}`).join('\n')
  const castList = plot.cast.map(c => `${c.slug}: ${c.description}`).join('\n')
  const locationList = plot.locations.map(l => `${l.slug}: ${l.description}`).join('\n')

  // Downsample beats to 32 evenly spaced across the track
  const beatSummary = beats && beats.length > 0
    ? downsampleBeats(beats, 32).map((b, i) => `${i}: ${b.toFixed(2)}s`).join(', ')
    : 'none provided'

  return `Plot: ${plot.logline}
Arc: ${plot.arc.join(' → ')}
Visual Style: ${plot.visualStyle}

Sections:
${sectionList}

Shot template (timing + lyric from tiling):
${shotTemplate}

Cast:
${castList}

Locations:
${locationList}

Beats (32 evenly spaced):
${beatSummary}

Generate the shot list CSV. Every row must have all 16 columns.`
}

/**
 * Pass 2: Compile per-shot plan from plot + audio structure.
 * Generates shots one section at a time to avoid token budget issues.
 * Treats model's Start_Sec/End_Sec as advisory — clamps into section's tiled slot
 * when it disagrees beyond tolerance. Hard throws only for structural errors.
 * @returns {Promise<Object>} shotPlan with shots[] array matching schema
 */
export async function compileShots(input, { backend, modelId, win, onShot }) {
  const { plot, title, durationSec, sections, beats, shots: tiledShots, style, creativePreset, castSlugs } = input

  // Compute per-section shot budgets
  const sectionBudgets = sections.map(s => computeShotBudget(s.endSec - s.startSec))

  // Build the system prompt with the actual budget numbers
  const systemPrompt = SHOTS_SYSTEM_PROMPT.replace(SHOT_BUDGET_PLACEHOLDER, sectionBudgets.join(', '))

  // Generate shots one section at a time
  const allShots = []
  for (let sectionIdx = 0; sectionIdx < sections.length; sectionIdx++) {
    const section = sections[sectionIdx]
    const budget = sectionBudgets[sectionIdx]
    const sectionTiledShots = tiledShots.filter(s => s.startSec >= section.startSec && s.endSec <= section.endSec)

    // Build prompt for this section only
    const sectionPrompt = `Plot: ${plot.logline}
Arc: ${plot.arc.join(' → ')}
Visual Style: ${plot.visualStyle}

Sections:
${section.id} (${section.kind}): ${section.startSec.toFixed(1)}–${section.endSec.toFixed(1)}s [budget: ${budget} shots]

Shot template (timing + lyric from tiling):
${sectionTiledShots.map(s => `${s.startSec.toFixed(1)}–${s.endSec.toFixed(1)}s: ${s.lyric.join(' / ') || '[no vocal]'}`).join('\n')}

Cast:
${plot.cast.map(c => `${c.slug}: ${c.description}`).join('\n')}

Locations:
${plot.locations.map(l => `${l.slug}: ${l.description}`).join('\n')}

Beats (32 evenly spaced):
${beats && beats.length > 0
    ? downsampleBeats(beats, 32).map((b, i) => `${i}: ${b.toFixed(2)}s`).join(', ')
    : 'none provided'}

Generate the shot list CSV for THIS SECTION ONLY (${budget} shots). Every row must have all 16 columns.
Shot_ID prefix: ${section.id}_
Section_ID for all rows: ${section.id}
Start_Sec must be within [${section.startSec.toFixed(2)}, ${section.endSec.toFixed(2)}].
End_Sec must be within [${section.startSec.toFixed(2)}, ${section.endSec.toFixed(2)}].`

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: sectionPrompt },
    ]

    const request = compilePromptRequest({
      messages,
      schema: null,
      backend,
      modelId,
      temperature: 0.6,
      maxTokens: 2048, // Per-section budget keeps us well under limit
    })

    const response = await callLLM(request, { backend, modelId, win })
    const sectionShots = parseCSVResponse(response, {
      sections: [section], // Only this section is valid
      castSlugs,
      plot,
      sectionTolerance: 0.5, // Advisory timing tolerance
      tiledShots: sectionTiledShots, // For clamping
      durationSec, // Full-track duration: the last shot of the LAST section must land on it
    })

    // Verify we got the expected budget (warn if not, but don't throw)
    if (sectionShots.length !== budget) {
      console.warn(`[compileShots] Section ${section.id}: expected ${budget} shots, got ${sectionShots.length}`)
    }

    allShots.push(...sectionShots)

    if (onShot) {
      for (let i = 0; i < sectionShots.length; i++) {
        onShot(sectionShots[i], allShots.length, sectionBudgets.reduce((a, b) => a + b, 0))
      }
    }
  }

  // Build full plan object matching schema
  const plan = buildPlanObject({
    title,
    durationSec,
    sections,
    shots: allShots,
    plot,
    style,
    creativePreset,
    backend,
    modelId: modelId || 'auto',
  })

  return plan
}

/**
 * Parse CSV response into structured shot objects.
 * Timing is ADVISORY: if a row's Start_Sec/End_Sec falls outside its section's
 * tiled slot by more than sectionTolerance (default 0.5s), clamp it to the slot
 * and record a warning. Only throw for structural errors (unknown section, unknown slug).
 */
export function parseCSVResponse(csvText, { sections, castSlugs, plot, sectionTolerance = 0.5, tiledShots = [], durationSec = 0 }) {
  const lines = csvText.trim().split('\n').filter(l => l.trim())
  if (lines.length < 2) throw new Error('CSV response empty or missing data rows')

  const header = lines[0].split(',').map(h => h.trim())
  const requiredCols = [
    'Shot_ID', 'Section_ID', 'Start_Sec', 'End_Sec', 'Shot_Type', 'Size',
    'Camera_Move', 'Energy', 'Performance_Mode', 'Cast', 'Props',
    'Lyric', 'Lip_Sync', 'Action', 'Location_Override', 'Film', 'Lighting'
  ]

  for (const col of requiredCols) {
    if (!header.includes(col)) throw new Error(`CSV missing required column: ${col}`)
  }

  const shots = []
  const warnings = []

  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVLine(lines[i])
    if (row.length !== header.length) {
      throw new Error(`CSV row ${i} has ${row.length} columns, expected ${header.length}`)
    }

    const obj = {}
    header.forEach((h, idx) => { obj[h] = (row[idx] || '').trim() })

    // Validate enums
    const validShotType = ['performance', 'performance_wide', 'b_roll']
    const validSize = ['wide', 'medium', 'close-up', 'detail']
    const validCameraMove = ['locked', 'push-in', 'pull-out', 'pan-left', 'tilt-up', 'orbit', 'handheld', 'whip-pan', 'snap-zoom']
    const validEnergy = ['calm', 'building', 'intense']
    const validPerfMode = ['lip-sync', 'wide-performance', 'b-roll', 'narrative']

    if (!validShotType.includes(obj.Shot_Type)) throw new Error(`Invalid Shot_Type: ${obj.Shot_Type}`)
    if (!validSize.includes(obj.Size)) throw new Error(`Invalid Size: ${obj.Size}`)
    if (!validCameraMove.includes(obj.Camera_Move)) throw new Error(`Invalid Camera_Move: ${obj.Camera_Move}`)
    if (!validEnergy.includes(obj.Energy)) throw new Error(`Invalid Energy: ${obj.Energy}`)
    if (!validPerfMode.includes(obj.Performance_Mode)) throw new Error(`Invalid Performance_Mode: ${obj.Performance_Mode}`)

    // Validate section exists (STRUCTURAL ERROR — throw)
    const section = sections.find(s => s.id === obj.Section_ID)
    if (!section) throw new Error(`Section_ID not found: ${obj.Section_ID}`)

    // Validate timing — ADVISORY with clamping
    let startSec = Number(obj.Start_Sec)
    let endSec = Number(obj.End_Sec)
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
      throw new Error(`Invalid timing: ${obj.Start_Sec}–${obj.End_Sec}`)
    }

    // Find the tiled slot for this shot (by index within section)
    const sectionShotIndex = shots.filter(s => s.sectionId === section.id).length
    const tiledSlot = tiledShots[sectionShotIndex]

    if (tiledSlot) {
      // Check if model's timing disagrees with tiled slot beyond tolerance
      if (Math.abs(startSec - tiledSlot.startSec) > sectionTolerance ||
          Math.abs(endSec - tiledSlot.endSec) > sectionTolerance) {
        warnings.push(`Shot ${obj.Shot_ID}: model timing ${startSec.toFixed(2)}–${endSec.toFixed(2)} disagrees with tiled slot ${tiledSlot.startSec.toFixed(2)}–${tiledSlot.endSec.toFixed(2)} (tolerance ${sectionTolerance}s) — clamping`)
        startSec = tiledSlot.startSec
        endSec = tiledSlot.endSec
      }
    } else {
      // No tiled slot — clamp to section bounds
      if (startSec < section.startSec || endSec > section.endSec) {
        warnings.push(`Shot ${obj.Shot_ID}: timing ${startSec.toFixed(2)}–${endSec.toFixed(2)} outside section ${section.id} [${section.startSec.toFixed(2)}, ${section.endSec.toFixed(2)}] — clamping`)
        startSec = Math.max(section.startSec, Math.min(startSec, section.endSec - 0.1))
        endSec = Math.min(section.endSec, Math.max(endSec, startSec + 0.1))
      }
    }

    // Validate cast slugs (STRUCTURAL ERROR — throw)
    const cast = obj.Cast ? obj.Cast.split(',').map(s => s.trim()).filter(Boolean) : []
    for (const slug of cast) {
      if (!castSlugs.includes(slug) && !plot.cast.some(c => c.slug === slug)) {
        throw new Error(`Unknown cast slug: ${slug}`)
      }
    }

    shots.push({
      id: obj.Shot_ID,
      sectionId: obj.Section_ID,
      startSec,
      endSec,
      shotType: obj.Shot_Type,
      size: obj.Size,
      cameraMove: obj.Camera_Move,
      energy: obj.Energy,
      performanceMode: obj.Performance_Mode,
      cast,
      props: obj.Props ? obj.Props.split(',').map(s => s.trim()).filter(Boolean) : [],
      lyric: obj.Lyric || undefined,
      lipSync: obj.Lip_Sync === 'true',
      action: obj.Action,
      locationOverride: obj.Location_Override || undefined,
      film: obj.Film || undefined,
      lighting: obj.Lighting || undefined,
    })
  }

  // Log warnings but don't throw
  for (const w of warnings) {
    console.warn(`[parseCSVResponse] ${w}`)
  }

  // Verify chronological order and no gaps — use clamped timings
  for (let i = 1; i < shots.length; i++) {
    if (Math.abs(shots[i].startSec - shots[i-1].endSec) > 0.11) {
      throw new Error(`Gap/overlap between shot ${i} and ${i+1}: ${shots[i-1].endSec} vs ${shots[i].startSec}`)
    }
  }
  if (shots.length > 0) {
    if (Math.abs(shots[0].startSec - 0) > 0.11) throw new Error(`First shot doesn't start at 0`)
    if (Math.abs(shots[shots.length-1].endSec - durationSec) > 0.11) {
      throw new Error(`Last shot doesn't end at duration: ${shots[shots.length-1].endSec} vs ${durationSec}`)
    }
  }

  return shots
}

function parseCSVLine(line) {
  const result = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i+1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  result.push(current)
  return result
}

/**
 * Build the full plan object matching shotPlan.schema.json.
 */
function buildPlanObject({ title, durationSec, sections, shots, plot, style, creativePreset, backend, modelId }) {
  const look = {
    preset: style,
    film: '35mm anamorphic, Kodak Vision3 500T, visible grain and halation',
    letterbox: '2.35:1 matte',
    lighting: 'hard backlight, cyan and amber gels, haze',
    palette: 'cyan/magenta/amber accents, sodium orange, cool steel blues',
    location: {
      slug: plot.locations[0]?.slug || 'primary',
      lock: plot.locations[0]?.description || 'industrial night location, concrete and steel',
      props: plot.locations[0]?.props?.map(p => ({ slug: p.slug, lock: p.description })) || [],
    },
  }

  const cast = plot.cast.map(c => ({
    slug: c.slug,
    name: c.slug,
    role: c.role || 'lead',
    lock: c.description,
    wardrobe: 'era-appropriate performance attire',
    wardrobeAt: sections.map(s => s.id),
    refImage: undefined,
  }))

  // Build clips from shots (1 clip per shot for now)
  const clips = shots.map((shot, idx) => ({
    index: idx,
    startSec: shot.startSec,
    lengthSec: Math.round((shot.endSec - shot.startSec) * 1000) / 1000,
    shotIds: [shot.id],
  }))

  return {
    schemaVersion: 1,
    track: {
      path: '', // filled by pipeline
      durationSec,
      hash: '', // filled by pipeline
      bpm: 0, // filled by pipeline
      beats: [], // filled by pipeline
      sections: sections.map(s => ({
        id: s.id,
        kind: s.kind,
        startSec: s.startSec,
        endSec: s.endSec,
        energy: s.energy,
      })),
      profileSource: 'envelope',
    },
    look,
    cast,
    shots,
    clips,
    llm: {
      backend,
      modelId,
      endpoint: '', // filled at runtime
      pid: 0,
      logPath: '',
      grammarEnforced: false,
      repairRetries: 0,
    },
  }
}

// ═══════════════════════════════════════════
// LLM Backend Calls
// ═══════════════════════════════════════════

async function callLLM(request, { backend, modelId, win }) {
  switch (backend) {
    case 'local':
      return callLocalLLM(request, { win })
    case 'lmstudio':
      return callLMStudio(request, { modelId, win })
    case 'openrouter':
      return callOpenRouter(request, { modelId, win })
    default:
      throw new Error(`Unknown backend: ${backend}`)
  }
}

async function callLocalLLM(request, { win }) {
  const { getSidecar } = await import('./modelCatalog.js')
  const { port, baseUrl } = getSidecar()
  const url = `${baseUrl}/v1/chat/completions`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`llama-server error: ${err}`)
  }

  const data = await response.json()
  return data.choices?.[0]?.message?.content || ''
}

async function callLMStudio(request, { modelId, win }) {
  const lmstudio = (await import('./lmstudio.js')).default
  const baseUrl = lmstudio.getBaseUrl()
  const url = `${baseUrl}/v1/chat/completions`

  const body = {
    ...request,
    model: modelId || request.model,
    ...request,
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`LM Studio error: ${err}`)
  }

  const data = await response.json()
  return data.choices?.[0]?.message?.content || ''
}

async function callOpenRouter(request, { modelId, win }) {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set')

  const url = 'https://openrouter.ai/api/v1/chat/completions'
  const body = {
    ...request,
    model: modelId || 'nvidia/nemotron-3-ultra:free',
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://belrog.ai',
      'X-Title': 'Belrog',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`OpenRouter error: ${err}`)
  }

  const data = await response.json()
  return data.choices?.[0]?.message?.content || ''
}

function parseJSONResponse(text) {
  // Try direct parse first
  try {
    return JSON.parse(text)
  } catch {
    // Try to extract JSON from markdown code block
    const match = text.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/)
    if (match) {
      try {
        return JSON.parse(match[1])
      } catch {}
    }
    // Try to find first { ... } block
    const braceMatch = text.match(/\{[\s\S]*\}/)
    if (braceMatch) {
      try {
        return JSON.parse(braceMatch[0])
      } catch {}
    }
    throw new Error('Failed to parse JSON from LLM response')
  }
}