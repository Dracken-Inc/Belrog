/**
 * Song-file probe tests. The fixtures cover the parsing rules; the live part
 * runs the real ffprobe against files this test generates, because the whole
 * bug was a container shape (mp4 with a blank container duration) that only
 * shows up against a real muxer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { parseProbeOutput } = require('../electron/audioTrackProbe.js')

const SONG_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'belrog-probe-')), 'song.m4a')

function has(binary) {
  try {
    execFileSync('which', [binary], { stdio: 'ignore' })
    return true
  } catch (_) {
    return false
  }
}

function makeFile(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'ignore' })
}

function probe(filePath) {
  const stdout = execFileSync('ffprobe', [
    '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath,
  ], { encoding: 'utf8' })
  return parseProbeOutput(stdout, filePath)
}

test('container duration is preferred, stream duration is the fallback', () => {
  const container = parseProbeOutput(JSON.stringify({
    format: { duration: '283.5', tags: { title: 'Forsaken, Falling', LYRICS: 'line one\nline two' } },
    streams: [{ codec_type: 'audio', duration: '283.5' }],
  }), '/music/song.m4a')
  assert.equal(container.ok, true)
  assert.equal(container.durationSec, 283.5)
  assert.equal(container.title, 'Forsaken, Falling')
  assert.match(container.lyricsRaw, /line one/)
  assert.equal(container.hasAudio, true)

  const streamOnly = parseProbeOutput(JSON.stringify({
    format: { tags: {} },
    streams: [{ codec_type: 'video', duration: '12.4' }, { codec_type: 'audio', duration: '12.4' }],
  }), '/music/song.mp4')
  assert.equal(streamOnly.ok, true, 'a muxer that omits the container duration must still work')
  assert.equal(streamOnly.durationSec, 12.4)
  assert.equal(streamOnly.title, 'song', 'the filename is the title fallback')
})

test('unreadable input fails loudly instead of reporting zero seconds', () => {
  assert.equal(parseProbeOutput('not json', '/m/a.m4a').ok, false)
  assert.equal(parseProbeOutput(JSON.stringify({ format: {}, streams: [] }), '/m/a.m4a').ok, false)
  assert.equal(parseProbeOutput(JSON.stringify({ format: { duration: '0' }, streams: [] }), '/m/a.m4a').ok, false)
})

test('CONTROL: a real file probes with the same rules', (t) => {
  if (!has('ffmpeg') || !has('ffprobe')) return t.skip('ffmpeg not installed on this machine')
  makeFile(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '6', '-c:a', 'aac', SONG_PATH])
  assert.ok(existsSync(SONG_PATH), 'the test generated a track')
  const result = probe(SONG_PATH)
  assert.equal(result.ok, true, `probe failed: ${result.error}`)
  assert.ok(Math.abs(result.durationSec - 6) < 0.5, `expected ~6s, got ${result.durationSec}`)
  assert.equal(result.hasAudio, true)
  assert.equal(result.lyricsRaw, '', 'a synthetic file has no lyric tags — the caller must not invent any')
})

test('CONTROL: an mp4 with a music track reads the same clock as an m4a', (t) => {
  if (!has('ffmpeg') || !has('ffprobe')) return t.skip('ffmpeg not installed on this machine')
  const videoPath = `${SONG_PATH}.mp4`
  makeFile([
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=5',
    '-t', '6', '-c:a', 'aac', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath,
  ])
  const result = probe(videoPath)
  assert.equal(result.ok, true, `mp4 probe failed: ${result.error}`)
  assert.ok(Math.abs(result.durationSec - 6) < 0.5, `expected ~6s, got ${result.durationSec}`)
  assert.equal(result.hasAudio, true, 'a video without audio cannot carry a music video')
})
