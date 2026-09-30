const test = require('node:test')
const assert = require('node:assert/strict')
const rmi = require('./remoteModelInstall.js')

/**
 * C3 acceptance tests: shell-escaping + remote download pipeline.
 * exec is injected (a command log + scripted responses), so no SSH needed.
 */

function makeExec(responder) {
  const commands = []
  const exec = async (command) => {
    commands.push(command)
    return responder(command)
  }
  exec.commands = commands
  return exec
}

test('quoteRemoteArg escapes single quotes, backticks, $ and newlines', () => {
  assert.equal(rmi.quoteRemoteArg('plain'), "'plain'")
  assert.equal(rmi.quoteRemoteArg("it's"), "'it'\\''s'")
  assert.equal(rmi.quoteRemoteArg('a`b$c\n'), "'a`b$c\n'")
  assert.equal(rmi.quoteRemoteArg('a b/c'), "'a b/c'")
})

test('buildRemoteDownloadCommand quotes every injected value', () => {
  const cmd = rmi.buildRemoteDownloadCommand({
    url: 'https://hf.co/fal/x/resolve/main/a b-c.safetensors',
    targetDir: '/home/user/models/loras',
    filename: "weird'$(echo x).safetensors",
  })
  // The hostile filename must be a single shell-quoted token:
  // 'weird'\''$(echo x).safetensors'  (inner single-quotes escaped, $ not expanded)
  assert.ok(cmd.includes("'weird'\\''$(echo x).safetensors'"), cmd)
  assert.ok(cmd.includes("'https://hf.co/fal/x/resolve/main/a b-c.safetensors'"))
  // Resumable downloaders, aria2c preferred.
  assert.ok(cmd.includes('aria2c --quiet --continue=true'))
  assert.ok(cmd.includes('wget -q --continue'))
  assert.ok(cmd.includes('curl -sSL -C -'))
})

test('checkRemoteDiskSpace refuses a too-small partition before any download', async () => {
  const exec = makeExec((cmd) => {
    if (cmd.includes('df')) return { success: true, stdout: '10737418240\n' } // 10 GB
    return { success: true, stdout: '' }
  })
  // Requires 40 GB + 10% -> must fail.
  const result = await rmi.checkRemoteDiskSpace(exec, '/models', 40 * 1024 ** 3)
  assert.equal(result.ok, false)
  assert.match(result.error, /free/i)
  assert.equal(exec.commands[0].includes('df -P -B1 --output=avail'), true)
})

test('checkRemoteDiskSpace passes a big-enough partition', async () => {
  const exec = makeExec((cmd) => (cmd.includes('df') ? { success: true, stdout: '500000000000\n' } : { success: true, stdout: '' }))
  const result = await rmi.checkRemoteDiskSpace(exec, '/models', 40 * 1024 ** 3)
  assert.equal(result.ok, true)
  assert.equal(result.availableBytes, 500000000000)
})

test('pollRemoteDownload completes when size reaches expected, streaming progress', async () => {
  let probe = 0
  const sizes = [0, 100, 200, 200, 200]
  const exec = makeExec(() => {
    probe += 1
    return { success: true, stdout: String(sizes[Math.min(probe - 1, sizes.length - 1)]) }
  })
  const progress = []
  const result = await rmi.pollRemoteDownload(exec, {
    targetDir: '/models/loras',
    filename: 'x.safetensors',
    expectedBytes: 200,
    pollMs: 1,
    onProgress: (size, total) => progress.push({ size, total }),
    sleep: async () => {},
  })
  assert.equal(result.ok, true)
  assert.equal(result.size, 200)
  assert.ok(progress.length >= 3)
  // Every probe must stat the exact (quoted) remote path.
  assert.ok(exec.commands.every((c) => c.includes("stat -c %s '/models/loras/x.safetensors'")))
})

test('pollRemoteDownload reports a stalled transfer', async () => {
  const exec = makeExec(() => ({ success: true, stdout: '50' }))
  const result = await rmi.pollRemoteDownload(exec, {
    targetDir: '/m',
    filename: 'y.safetensors',
    expectedBytes: 1000,
    pollMs: 1,
    maxPolls: 25,
    sleep: async () => {},
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /stalled/i)
})

test('pollRemoteDownload handles missing file until it appears', async () => {
  let n = 0
  const exec = makeExec(() => {
    n += 1
    return { success: true, stdout: n < 3 ? 'missing' : '300' }
  })
  const result = await rmi.pollRemoteDownload(exec, {
    targetDir: '/m',
    filename: 'z.safetensors',
    expectedBytes: 300,
    pollMs: 1,
    sleep: async () => {},
  })
  assert.equal(result.ok, true)
  assert.equal(result.size, 300)
})

test('verifyRemoteFile accepts a matching pinned hash and rejects a mismatch', async () => {
  const goodHash = 'a'.repeat(64)
  const execOk = makeExec(() => ({ success: true, stdout: `${goodHash}  /m/x.safetensors` }))
  const ok = await rmi.verifyRemoteFile(execOk, { targetDir: '/m', filename: 'x.safetensors', expectedSha256: goodHash.toUpperCase() })
  assert.equal(ok.ok, true)
  assert.equal(ok.hash, goodHash)

  const execBad = makeExec(() => ({ success: true, stdout: `${'b'.repeat(64)}  /m/x.safetensors` }))
  const bad = await rmi.verifyRemoteFile(execBad, { targetDir: '/m', filename: 'x.safetensors', expectedSha256: goodHash })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /mismatch/i)
})

test('verifyRemoteFile treats an empty/missing remote file as a failure', async () => {
  const exec = makeExec(() => ({ success: false, stderr: 'no such file' }))
  const result = await rmi.verifyRemoteFile(exec, { targetDir: '/m', filename: 'x.safetensors', expectedSha256: '' })
  assert.equal(result.ok, false)
  assert.match(result.error, /missing or empty/i)
})

test('startRemoteDownload wraps the command detached (nohup + sh -c single-quoted arg)', async () => {
  const exec = makeExec(() => ({ success: true, stdout: '' }))
  const result = await rmi.startRemoteDownload(exec, {
    url: 'https://hf.co/a.safetensors',
    targetDir: '/models/loras',
    filename: 'a.safetensors',
  })
  assert.equal(result.ok, true)
  const cmd = exec.commands[0]
  assert.ok(cmd.startsWith('nohup sh -c '))
  assert.ok(cmd.includes('&'))
  // The entire inner download command is ONE quoted argument.
  assert.ok(/^nohup sh -c '.*' > \/dev\/null 2>&1 &$/.test(cmd))
})