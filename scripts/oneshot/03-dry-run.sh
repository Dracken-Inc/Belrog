#!/usr/bin/env bash
# ONE-SHOT H3 — DRY RUN: audit + compile + print the exact clip plan and
# workflow graph summary. Queues NOTHING. GPU untouched. Fully safe with
# agents running.
# Usage: ./03-dry-run.sh /path/to/song.mp3 /path/to/script.txt [style text]
set -eu
BELROG_REPO="${BELROG_REPO:-/home/henlafon/belrog-src}"
AUDIO="${1:?usage: 03-dry-run.sh song.mp3 script.txt [style]}"
SCRIPT="${2:?need script file}"
STYLE="${3:-}"
cd "$BELROG_REPO"
node scripts/oneshot/run-oneshot-chain.mjs --audit-only || exit 1
# compile-only pass
node --input-type=module -e "
import fs from 'node:fs'
const m = await import('$PWD/src/services/h3OneShot.js')
const script = fs.readFileSync('$SCRIPT','utf8')
const c = m.compileScriptToClips(script)
const dur = (() => { try { return Number(process.execPath && require('node:child_process').execSync('ffprobe -v error -show_entries format=duration -of csv=p=0 \'$AUDIO\'').toString().trim()) } catch { return 0 } })()
console.log('audio duration:', dur ? dur.toFixed(2)+'s' : 'UNKNOWN (pass --duration)')
console.log('clips compiled:', c.clips.length)
for (const cl of c.clips) console.log(\`  clip \${cl.clipIndex}: shot \${cl.shotIndex}  \${cl.seconds.toFixed(2)}s (\${cl.frames}f)\`)
for (const w of c.warnings) console.log('  WARN:', w)
if (c.clips.length) {
  const g = m.buildH3OneShotWorkflow({ chainId:'dryrun', audioFile:'x.mp3', clipPrompts:c.clipPrompts, totalSeconds:dur||60, stylePrompt:'$STYLE' })
  console.log('workflow nodes:', Object.keys(g).length, '| ref2va:', g['3'].inputs.unet_name)
}
" 2>/dev/null || node --input-type=module -e "
import fs from 'node:fs'
import cp from 'node:child_process'
const m = await import('$PWD/src/services/h3OneShot.js')
const script = fs.readFileSync('$SCRIPT','utf8')
const c = m.compileScriptToClips(script)
let dur = 0
try { dur = Number(cp.execSync(\"ffprobe -v error -show_entries format=duration -of csv=p=0 '$AUDIO'\").toString().trim()) } catch {}
console.log('audio duration:', dur ? dur.toFixed(2)+'s' : 'UNKNOWN')
console.log('clips compiled:', c.clips.length)
for (const cl of c.clips) console.log('  clip '+cl.clipIndex+': shot '+cl.shotIndex+'  '+cl.seconds.toFixed(2)+'s ('+cl.frames+'f)')
for (const w of c.warnings) console.log('  WARN:', w)
console.log('DRY RUN complete — nothing queued.')
"
