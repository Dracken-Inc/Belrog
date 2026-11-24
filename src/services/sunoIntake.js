/**
 * Suno intake — turn a downloaded track (m4a/mp3, lyrics in metadata) into a
 * tiled director script the one-shot H3 engine can compile. Deterministic:
 * same file + same options = byte-identical script. No LLM in this path.
 *
 * Timing law (belrog-maintenance): start[i] + length[i] === start[i+1] with
 * zero gaps/overlaps, and coverage ends exactly at the track duration.
 *
 * Pure tiling only: the ffprobe step lives in sunoIntakeProbe.mjs so this file
 * can be bundled into the renderer.
 */
const MIN_SHOT_SEC = 3.5

/**
 * Lyric blocks from raw tag text. LRC lines ([mm:ss.xx] text) give real times;
 * plain blocks (Suno style, blank-line separated) are distributed evenly over
 * the duration after a fixed 5% intro. Returns { startSec, endSec, lines[] }
 * sorted, clamped, gapless coverage NOT guaranteed here — tiling owns that.
 */
export function parseLyricBlocks(raw, durationSec) {
  const text = String(raw || '').replace(/\r\n/g, '\n').trim()
  if (!text) return []
  const lrcRe = /^\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]\s*(.*)$/
  const lrcLines = []
  let sawLrc = false
  for (const line of text.split('\n')) {
    const m = lrcRe.exec(line.trim())
    if (m && m[4] !== undefined) {
      sawLrc = true
      const frac = m[3] ? Number('0.' + m[3].padEnd(3, '0')) : 0
      const t = Number(m[1]) * 60 + Number(m[2]) + frac
      if (t >= 0 && t < durationSec && m[4].trim()) lrcLines.push({ t, text: m[4].trim() })
    }
  }
  if (sawLrc) {
    lrcLines.sort((a, b) => a.t - b.t)
    const blocks = []
    for (let i = 0; i < lrcLines.length; i += 1) {
      const startSec = Math.min(lrcLines[i].t, durationSec - 0.1)
      const endSec = i + 1 < lrcLines.length
        ? Math.max(Math.min(lrcLines[i + 1].t, durationSec), startSec + 0.1)
        : durationSec
      blocks.push({ startSec, endSec, lines: [lrcLines[i].text] })
    }
    return blocks
  }
  // Plain lines (Suno embeds section headers and direction lines one per
  // line, often without blank lines): every non-empty line is a unit, spread
  // evenly over the non-intro span.
  const blocks = text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => [l])
  if (!blocks.length) return []
  const intro = Math.min(5, durationSec * 0.05)
  const span = durationSec - intro
  const per = span / blocks.length
  return blocks.map((lines, i) => ({
    startSec: i === 0 ? intro : intro + i * per,
    endSec: i === blocks.length - 1 ? durationSec : Math.min(durationSec, intro + (i + 1) * per),
    lines,
  }))
}

/**
 * Tile blocks into shots covering [0, durationSec] exactly. Boundaries land on
 * lyric onsets where possible; every shot >= MIN_SHOT_SEC; leftover < MIN_SHOT_SEC
 * is merged into the final shot. Deterministic.
 */
export function tileShots(blocks, durationSec, { targetSec = 5 } = {}) {
  if (!(durationSec > 0)) throw new Error('tileShots: duration must be positive')
  const target = Math.max(Number(targetSec) || 5, MIN_SHOT_SEC)
  const interior = [...new Set(blocks
    .map((b) => Math.round(Math.min(Math.max(b.startSec, 0), durationSec) * 10) / 10)
    .filter((t) => t > 0 && t < durationSec))].sort((a, b) => a - b)
  // Keep the first lyric onset at or beyond `target` past the previous cut;
  // boundaries land on real onsets, spacing never drops under target.
  const kept = [0]
  for (const t of interior) {
    if (t - kept[kept.length - 1] >= target) kept.push(t)
  }
  if (durationSec - kept[kept.length - 1] >= MIN_SHOT_SEC) kept.push(durationSec)
  else {
    if (kept.length > 1) kept.pop() // absorb sub-minimum tail into last shot
    kept.push(durationSec)
  }
  const shots = []
  for (let i = 0; i + 1 < kept.length; i += 1) {
    const startSec = kept[i]
    const endSec = kept[i + 1]
    const lyric = blocks
      .filter((b) => b.startSec < endSec && b.endSec > startSec)
      .flatMap((b) => b.lines)
    shots.push({ startSec, endSec, seconds: Math.round((endSec - startSec) * 10) / 10, lyric })
  }
  return shots
}

/** Chain audit: zero gaps/overlaps, coverage ends at duration. [] when clean. */
export function auditTiling(shots, durationSec) {
  const issues = []
  let cursor = 0
  for (const [i, s] of shots.entries()) {
    if (Math.abs(s.startSec - cursor) > 0.11) issues.push({ shot: i + 1, kind: 'chain', message: `start ${s.startSec} != cursor ${cursor.toFixed(2)}` })
    if (s.seconds < MIN_SHOT_SEC && !(shots.length === 1 && durationSec >= MIN_SHOT_SEC)) issues.push({ shot: i + 1, kind: 'short', message: `${s.seconds}s < ${MIN_SHOT_SEC}s` })
    cursor = Math.round((s.startSec + s.seconds) * 10) / 10
  }
  if (shots.length && Math.abs(cursor - durationSec) > 0.11) issues.push({ shot: shots.length, kind: 'coverage', message: `coverage ends ${cursor} != ${durationSec}` })
  if (!shots.length) issues.push({ shot: 0, kind: 'empty', message: 'no shots' })
  return issues
}

function fmtClock(sec) {
  const m = Math.floor(sec / 60)
  const s = (sec - m * 60).toFixed(1).padStart(4, '0')
  return `${String(m).padStart(2, '0')}:${s}`
}

/**
 * Cast slugs this script can name without making anyone up: the user's Cast
 * roster first, then [Name] tags inside the lyrics. Bracket section headers
 * ([Verse], [Chorus]) are structure, not people, so they are filtered against
 * a small blocklist instead of being harvested as performers.
 */
const LYRIC_TAG_BLOCK = new Set([
  'verse', 'chorus', 'pre-chorus', 'bridge', 'intro', 'outro', 'hook', 'drop',
  'breakdown', 'interlude', 'solo', 'reprise', 'refrain', 'post-chorus',
  'ad-lib', 'adlib', 'spoken', 'instrumental', 'beat', 'fade', 'production',
])

export function harvestCastSlugs({ cast = [], lyricsRaw = '' } = {}) {
  const slugs = []
  const seen = new Set()
  const push = (raw) => {
    const slug = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
    if (!slug || seen.has(slug)) return
    seen.add(slug)
    slugs.push(slug)
  }
  for (const entry of Array.isArray(cast) ? cast : []) push(entry?.slug || entry?.label)
  // Tag-only lines name the singer: "[Rose]" or "[Jake] / [Rose]". A line that
  // starts with a timestamp ("[00:12.00]line") is timing, so it is skipped
  // whole; lyric text inside a sung line is never treated as a name.
  for (const line of String(lyricsRaw || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('[')) continue
    if (/^\[\d{1,2}:\d{2}/.test(trimmed)) continue
    for (const match of trimmed.matchAll(/\[([^\]]{1,40})\]/g)) {
      const tag = match[1].trim()
      if (!tag || /^\d+$/.test(tag) || /^\d{1,2}:\d{2}([.:]\d+)?$/.test(tag) || LYRIC_TAG_BLOCK.has(tag.toLowerCase())) continue
      // "[Rose] / [Jake]" split on separators; "[Verse 1]"-style headers drop
      // their trailing number before the blocklist check.
      for (const part of tag.split(/\s*\/\s*|\s*&\s*|\s*,\s*/)) {
        const cleaned = part.replace(/\s*\d+\s*$/, '').trim()
        if (!cleaned || LYRIC_TAG_BLOCK.has(cleaned.toLowerCase())) continue
        if (/^(verse|chorus|bridge|intro|outro|part|section|take)\w*\s*\d*$/i.test(cleaned)) continue
        push(cleaned)
      }
    }
  }
  return slugs
}

/**
 * Full script text for the one-shot compiler from a probed track + style brief.
 * seedBase derives from title+duration so reruns are stable, new files differ.
 *
 * This is a skeleton, not a film. It commits to the two things the file can
 * prove — when the cuts happen and what is being sung — and names the cast it
 * knows. Everything creative (the frame, the setting, the camera) is left to
 * the director planner, because invented prose here turned into 31 identical
 * shots of a "slow push-in". The [placeholder] marker on each keyframe line
 * keeps that visible in the queue instead of quietly generating a guess.
 */
export function generateSunoScript({
  durationSec,
  lyricsRaw = '',
  style = '',
  seedBase = null,
  targetSec = 5,
  title = '',
  cast = [],
  lyricSource = 'file',
} = {}) {
  const blocks = parseLyricBlocks(lyricsRaw, durationSec)
  const shots = tileShots(blocks, durationSec, { targetSec })
  const issues = auditTiling(shots, durationSec)
  if (issues.length) throw new Error(`sunoIntake tiling refused: ${issues.map((i) => i.message).join('; ')}`)
  let hash = 2166136261
  const seedSource = `${title}|${durationSec}`
  for (let i = 0; i < seedSource.length; i += 1) { hash ^= seedSource.charCodeAt(i); hash = Math.imul(hash, 16777619) >>> 0 }
  const seed = seedBase ?? (hash % 900000) + 100000
  const knownSlugs = harvestCastSlugs({ cast, lyricsRaw })
  const slugs = knownSlugs.length ? knownSlugs : ['lead']
  const rosterSlugs = new Set((Array.isArray(cast) ? cast : [])
    .map((entry) => String(entry?.slug || entry?.label || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_')))
  const styleNote = String(style || '').trim()
    || 'not set — add the look in the Director step'
  const lyricNote = {
    timed: 'timed in step 1 by transcription or your pasted SRT/LRC',
    file: 'read from the file',
    transcription: 'timed by transcription',
    pasted: 'untimed lyrics pasted — spread across the song',
    none: 'not found — cutting on the clock only',
  }[lyricSource] || 'timing only'
  const head = [
    'BELROG DIRECTOR SCRIPT',
    `Seed base: ${seed}. Deterministic tiling from the track — regenerate only with a new file or brief.`,
    `Story: music video for "${title || 'untitled'}", ${durationSec.toFixed(2)}s.`,
    `This script is a skeleton. Cut timings and lyric lines come from the track (${lyricNote}).`,
    'Nothing describes a frame on purpose: send it to the Director step to get the shots written, or write them here.',
    `Style: ${styleNote}`,
    '',
    '# Cast this script names. An "uncast" line means the name appears but no reference sheet exists yet.',
    ...slugs.map((slug) => `CHARACTER: ${slug} — ${rosterSlugs.has(slug) ? 'in your Cast roster' : 'uncast: no reference sheet yet'}`),
    '',
    'Coverage 1: Main tiled sequence',
    'Coverage type: main_sequence',
    'Coverage label: Main tiled sequence',
    'Purpose: Cut the track on lyric onsets with exact timing and no gaps.',
    '',
  ]
  const body = shots.map((s, i) => {
    const lyricText = s.lyric.filter((line) => !/^\s*\[[^\]]*\]\s*$/.test(line)).join(' / ')
    const type = lyricText ? 'performance' : 'b-roll'
    const lines = [
      `Shot ${i + 1}: Cut at ${fmtClock(s.startSec)}`,
      `Start at: ${fmtClock(s.startSec)}`,
    ]
    if (lyricText) {
      // Who sings: the [Tag] on these lines if there is one, the only known
      // performer if there is one, otherwise the whole roster. Guessing a
      // single singer from a multi-cast roster is invention, so we do not.
      const tagged = [...new Set(s.lyric
        .flatMap((line) => [...String(line).matchAll(/\[([^\]]{1,40})\]/g)].map((m) => m[1]))
        .map((tag) => tag.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, ''))
        .filter((tag) => slugs.includes(tag)))]
      const artist = tagged.length ? tagged.join(', ') : (slugs.length === 1 ? slugs[0] : 'all')
      lines.push(`Artist: ${artist}`)
      // No lyric in this tile: omit the cue entirely. Writing "[No lyric]" into
      // the prompt would make the model paint a placeholder beat that never
      // happens in the song.
      lines.push(`Lyric moment: ${lyricText.slice(0, 240)}`)
    }
    lines.push(`Shot type: ${type}`)
    lines.push(
      `Keyframe prompt: [placeholder] ${fmtClock(s.startSec)}–${fmtClock(s.startSec + s.seconds)}, `
      + (lyricText ? `performance on the line "${lyricText.slice(0, 160)}"` : 'no vocal here, cut to the music')
      + '. Waiting for the director to write this frame.',
    )
    lines.push(`Length: ${s.seconds.toFixed(1)}s`)
    lines.push('')
    return lines.join('\n')
  })
  // A blank line between the coverage header and the first shot is load-bearing:
  // the parser folds the lines right after a heading into scene context, and
  // without it Shot 1 disappears from the plan.
  return `${head.join('\n')}\n\n${body.join('\n')}`
}
