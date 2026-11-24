/**
 * Song-file intake tests. The point of these is that the song you loaded in
 * step 1 is the song that gets timed, and that the lyrics in the script are
 * the lyrics Belrog actually measured. Several tests are CONTROL tests: they
 * must go red when the wiring they describe is removed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildScriptFromTrack,
  isProbeablePath,
  resolveTrackFilePath,
  resolveTrackLyrics,
  timedLyricsToLrc,
} from './musicVideoTrackIntake.mjs'
import { generateSunoScript, harvestCastSlugs } from './sunoIntake.js'
import { parseStructuredDirectorScript } from '../utils/yoloPlanning.js'

const SRT = [
  '1',
  '00:00:05,000 --> 00:00:09,000',
  'You paint your eyelids with correction fluid moons',
  '',
  '2',
  '00:00:20,500 --> 00:00:24,000',
  'We are only halfway home',
  '',
].join('\n')

test('only a real on-disk path is probeable', () => {
  assert.equal(isProbeablePath('/music/song.m4a'), true)
  assert.equal(isProbeablePath('C:\\Music\\song.mp3'), true)
  assert.equal(isProbeablePath('blob:https://app/1234'), false)
  assert.equal(isProbeablePath('assets/song.mp3'), false)
  assert.equal(resolveTrackFilePath({ absolutePath: 'blob:x', path: '/tmp/song.mp3' }), '/tmp/song.mp3')
  assert.equal(resolveTrackFilePath({ url: 'blob:x' }), null)
})

test('timed lyrics keep their real times', () => {
  const lrc = timedLyricsToLrc([
    { startSec: 5, text: 'first line' },
    { startSec: 20.5, text: 'second line' },
  ])
  assert.match(lrc, /^\[00:05\.00\]first line$/m)
  assert.match(lrc, /^\[00:20\.50\]second line$/m)
  const lyric = resolveTrackLyrics({ lyricsText: SRT, fileLyricsRaw: '' })
  assert.equal(lyric.lyricSource, 'timed')
  assert.equal(lyric.timed, true)
  assert.match(lyric.lyricsRaw, /\[00:20\.50\]We are only halfway home/)
})

test('lyric sources are ranked, and the weakest is named honestly', () => {
  assert.equal(resolveTrackLyrics({ lyricsText: SRT, fileLyricsRaw: 'tag lyrics' }).lyricSource, 'timed')
  assert.equal(resolveTrackLyrics({ lyricsText: '', fileLyricsRaw: 'tag lyrics' }).lyricSource, 'file')
  assert.equal(resolveTrackLyrics({ lyricsText: 'plain words', fileLyricsRaw: '' }).lyricSource, 'pasted')
  const none = resolveTrackLyrics({ lyricsText: '', fileLyricsRaw: '' })
  assert.equal(none.lyricSource, 'none')
  assert.equal(none.lyricsRaw, '')
})

test('the step-1 asset is the file that gets probed, never a fresh picker', async () => {
  let probed = null
  let picked = 0
  const api = {
    probeAudioTrack: async (filePath) => { probed = filePath; return { ok: true, durationSec: 40, title: 'Track', lyricsRaw: '' } },
    pickAudioTrack: async () => { picked += 1; return '/wrong/song.mp3' },
  }
  const result = await buildScriptFromTrack({
    asset: { absolutePath: '/music/right.mp3' },
    api,
    lyricsText: SRT,
    cast: [{ slug: 'rose', label: 'Rose' }],
  })
  assert.equal(probed, '/music/right.mp3', 'the loaded asset must be the file ffprobe reads')
  assert.equal(picked, 0, 'a second file picker is a bug: it times a different song')
  assert.equal(result.lyricSource, 'timed')
  // The measured lyric lines must be IN the script, not just in the arguments.
  assert.match(result.script, /Lyric moment: You paint your eyelids with correction fluid moons/)
  assert.match(result.script, /Lyric moment: We are only halfway home/)
})

test('a caller-resolved path wins, and the file name comes back for status lines', async () => {
  let probed = null
  const api = { probeAudioTrack: async (p) => { probed = p; return { ok: true, durationSec: 30, fileName: p.split('/').pop() } } }
  const result = await buildScriptFromTrack({
    filePath: '/project/audio/resolved.m4a',
    asset: { absolutePath: '/somewhere/else.m4a' },
    api,
  })
  assert.equal(probed, '/project/audio/resolved.m4a')
  assert.equal(result.fileName, 'resolved.m4a')
  assert.equal(result.fileName.includes('/'), false)
})

test('CONTROL: drop the step-1 lyrics and the script stops claiming them', async () => {
  const api = {
    probeAudioTrack: async () => ({ ok: true, durationSec: 40, title: 'Track', lyricsRaw: '' }),
    pickAudioTrack: async () => null,
  }
  const withLyrics = await buildScriptFromTrack({ asset: { absolutePath: '/m/a.mp3' }, api, lyricsText: SRT })
  const withoutLyrics = await buildScriptFromTrack({ asset: { absolutePath: '/m/a.mp3' }, api, lyricsText: '' })
  assert.ok(withLyrics.script.includes('Lyric moment:'), 'timed lyrics must produce cues')
  assert.ok(!withoutLyrics.script.includes('Lyric moment:'), 'no measured lyrics = no invented cues')
  assert.match(withoutLyrics.script, /not found — cutting on the clock only/)
  assert.equal(withoutLyrics.lyricSource, 'none')
  assert.equal(withLyrics.shotCount > 0, true)
})

test('no file at all is an error, not a silent empty script', async () => {
  const api = { probeAudioTrack: async () => ({ ok: true, durationSec: 40 }), pickAudioTrack: async () => null }
  await assert.rejects(() => buildScriptFromTrack({ asset: { url: 'blob:x' }, api }), /No song file to read/)
})

test('cast slugs come from the roster and from lyric tags, never from thin air', () => {
  assert.deepEqual(harvestCastSlugs({ cast: [{ slug: 'rose' }, { label: 'Jake' }] }), ['rose', 'jake'])
  assert.deepEqual(harvestCastSlugs({ cast: [], lyricsRaw: '[Rose]\nline one\n[Jake] / [Rose]\nline two' }), ['rose', 'jake'])
  // Section headers are structure, not people.
  assert.deepEqual(harvestCastSlugs({ cast: [], lyricsRaw: '[Verse]\nline\n[Chorus]\nline' }), [])
  // Neither are the timestamps an SRT/LRC from step 1 is made of. Without this
  // filter a timed song produced "CHARACTER: 00_12 — uncast" rows in Cast.
  assert.deepEqual(harvestCastSlugs({ cast: [], lyricsRaw: '[00:12.00]line\n[00:20.00]line' }), [])
  const timed = generateSunoScript({ durationSec: 40, lyricsRaw: '[00:12.00]line\n[00:20.00]line', cast: [] })
  assert.ok(!/^CHARACTER: \d/m.test(timed), 'no cast entry made of a clock')
})

test('the skeleton names an artist, states exact times, and invents no prose', () => {
  // Deliberately uneven onsets: an even 5s grid would make "exact start times"
  // and "5s steps" indistinguishable, so the chain check would have no teeth.
  const lyrics = ['[00:00.00]line 0', '[00:07.00]line 1', '[00:11.00]line 2', '[00:26.00]line 3', '[00:31.00]line 4'].join('\n')
  const script = generateSunoScript({ durationSec: 40, lyricsRaw: lyrics, cast: [{ slug: 'rose' }], title: 'Song', lyricSource: 'timed' })
  const shots = script.split(/\n(?=Shot \d+:)/).filter((block) => /^Shot \d+:/.test(block))
  assert.ok(shots.length >= 3, `expected tiled shots, got ${shots.length}`)
  assert.ok(shots.some((block) => !/Length: 5\.0s/.test(block)), 'lengths follow the lyric onsets, not a fixed grid')
  let cursor = 0
  for (const block of shots) {
    const start = /Start at: (\d+):([\d.]+)/.exec(block)
    assert.ok(start, 'every shot carries its start')
    const length = /Length: ([\d.]+)s/.exec(block)
    assert.ok(length, 'every shot carries its length')
    const startSec = Number(start[1]) * 60 + Number(start[2])
    assert.ok(Math.abs(startSec - cursor) < 0.11, `chain must be gapless at ${startSec} vs ${cursor}`)
    cursor = startSec + Number(length[1])
    if (block.includes('Lyric moment:')) assert.match(block, /^Artist: /m, 'a sung shot must name who sings')
  }
  assert.match(script, /^CHARACTER: rose — in your Cast roster$/m)
  // The old writer pasted the same fake sentence into every shot. If that ever
  // comes back, this fails.
  assert.ok(!/slow push-in/.test(script), 'no canned camera move')
  assert.ok(!/cinematic photoreal/.test(script), 'no canned style line')
  assert.match(script, /\[placeholder\]/, 'placeholder frames stay visible')
})

test('CONTROL: an uncased name is declared uncast so the placeholder step can see it', () => {
  const script = generateSunoScript({ durationSec: 30, lyricsRaw: '[Rose]\nsinging along\nmore words here', cast: [] })
  assert.match(script, /^CHARACTER: rose — uncast: no reference sheet yet$/m)
  assert.match(script, /^Artist: rose$/m)
  const empty = generateSunoScript({ durationSec: 30, lyricsRaw: '', cast: [] })
  assert.match(empty, /^CHARACTER: lead — uncast/m, 'no cast at all still declares one name to fill')
})

test('the skeleton parses with the real script parser and keeps its shot count', () => {
  const lyrics = Array.from({ length: 10 }, (_, i) => `[00:${String(i * 4).padStart(2, '0')}.00]line number ${i}`).join('\n')
  const script = generateSunoScript({ durationSec: 40, lyricsRaw: lyrics, cast: [{ slug: 'rose' }], title: 'Song' })
  const scenes = parseStructuredDirectorScript(script, { maxShotDurationSeconds: 600 })
  const shots = scenes.flatMap((s) => s.shots || [])
  const declared = (script.match(/^Shot \d+:/gm) || []).length
  assert.equal(shots.length, declared, 'the parser must see every declared shot')
  // Every "Start at:" the generator wrote must survive parsing, in order. This
  // once silently dropped Shot 1 because the header ran into it with no blank
  // line, and the plan still looked fine until you counted.
  const parsedStarts = shots.map((s) => String(s.startAtRaw || '').trim())
  const declaredStarts = [...script.matchAll(/^Start at: (.+)$/gm)].map((m) => m[1].trim())
  assert.deepEqual(parsedStarts, declaredStarts, 'starts survive parsing in order')
  assert.ok(declaredStarts.length >= 4)
  assert.ok(shots.every((s) => Number(s.durationSeconds) > 0), 'durations survive parsing')
  const legend = Array.isArray(scenes.assets) ? scenes.assets : []
  assert.ok(legend.some((entry) => entry.kind === 'character' && entry.slug === 'rose'), 'the legend reaches the gap detector')
})
