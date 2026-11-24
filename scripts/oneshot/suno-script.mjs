#!/usr/bin/env node
/**
 * suno-script.mjs — one track in, tiled director script out.
 * Usage: node suno-script.mjs --audio /path/song.m4a [--style "..."] [--seed N]
 *                         [--out script.txt] [--target 5]
 * Lyrics come from the file's metadata (Suno embeds them); duration from ffprobe.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { generateSunoScript } from '../../src/services/sunoIntake.js'
import { probeSunoTrack } from '../../src/services/sunoIntakeProbe.mjs'

const argv = process.argv.slice(2)
const args = { target: 5 }
for (let i = 0; i < argv.length; i += 1) {
  const k = argv[i]
  if (k === '--audio') args.audio = argv[++i]
  else if (k === '--style') args.style = argv[++i] || ''
  else if (k === '--seed') args.seed = Number(argv[++i])
  else if (k === '--out') args.out = argv[++i]
  else if (k === '--target') args.target = Number(argv[++i])
}
if (!args.audio) {
  console.error('usage: suno-script.mjs --audio song.m4a [--style "..."] [--seed N] [--out script.txt]')
  process.exit(1)
}
const probe = probeSunoTrack(args.audio)
const script = generateSunoScript({
  durationSec: probe.durationSec,
  lyricsRaw: probe.lyricsRaw,
  style: args.style || '',
  seedBase: Number.isFinite(args.seed) ? args.seed : null,
  targetSec: args.target,
  title: probe.title || args.audio.split('/').pop(),
})
if (!probe.lyricsRaw.trim()) console.error('WARN: no lyrics tag in file — b-roll lane only (no lyric moments)')
if (args.out) {
  writeFileSync(args.out, script)
  console.error(`script written: ${args.out} (${probe.durationSec.toFixed(2)}s, ${script.split('\nShot ').length - 1} shots)`)
} else {
  process.stdout.write(script)
}
