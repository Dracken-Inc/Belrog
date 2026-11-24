// Renders the real Create and Sound tabs in a browser and proves they paint.
//
// Why this exists: in 0.5.2 both tabs opened straight into the crash panel
// ("ReferenceError: mode is not defined") on Henry's laptop. Nothing caught it.
// `node --check` cannot see it, the identifier gate deliberately skips .jsx,
// `npm run build` succeeds, and the packaged smoke test only proves a window
// appears. The bug was App.jsx passing mode="sound" to a component whose
// parameter list had been emptied when the GPU-sharing button was removed, so
// the only check that would have caught it is one that mounts the tab.
//
// Needs the fixture server, like the other browser checks:
//   npx vite --port 5222 --strictPort --host 127.0.0.1
//   VELORN_TEST_URL=http://127.0.0.1:5222 CHROME_PATH=... node scripts/check-workspace-tabs.cjs
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const target = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5222')
if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.pathname !== '/'
  || target.search || target.hash) throw Error('Workspace tab check requires a loopback HTTP fixture server')
const base = target.origin
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'belrog-workspace-tabs-'))

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true,
  })
  const groups = [], errors = [], blocked = []
  let page
  try {
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    page.setDefaultTimeout(15000)
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) })
    await page.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.origin === base) return route.continue()
      blocked.push(url.href); return route.abort()
    })
    const frame = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
    const tab = () => page.evaluate(() => window.workspaceTabsTest.snapshot())
    const shown = mode => page.locator(`.vcreate[data-mode="${mode}"]`)

    await page.goto(`${base}/tests/fixtures/workspace-tabs.html`)
    await page.waitForFunction(() => window.workspaceTabsTest?.ready)
    await frame()

    // Create opens first, exactly as App.jsx mounts it: no mode prop, so the
    // default has to be 'create' or the tab paints the wrong screen.
    await shown('create').waitFor({ state: 'visible' })
    assert.match((await tab()).title, /see\?$/, 'the Create tab asks what you want to see')
    groups.push('Create tab mounts and paints its prompt')

    // Sound is the same component told apart by one prop. This is the click
    // that crashed on Henry's laptop: the prop was dropped, so `mode` was never
    // declared and every render threw before anything painted.
    await page.getByRole('button', { name: 'Sound', exact: true }).click()
    await shown('sound').waitFor({ state: 'visible' })
    await frame()
    assert.match((await tab()).title, /hear\?$/, 'the Sound tab asks what you want to hear')
    assert.equal(await shown('create').count(), 0, 'switching tabs must not leave Create painted underneath')
    groups.push('Sound tab mounts through mode="sound" and paints its own prompt')

    // Back and forth: App.jsx keeps both tabs mounted once opened, so a tab has
    // to survive being hidden and shown, not just open once on a clean slate.
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await shown('create').waitFor({ state: 'visible' })
    await page.getByRole('button', { name: 'Sound', exact: true }).click()
    await shown('sound').waitFor({ state: 'visible' })
    await frame()
    assert.equal((await tab()).mode, 'sound')
    groups.push('repeated tab switching keeps both tabs rendering')

    await page.setViewportSize({ width: 900, height: 800 })
    await frame()
    assert.equal(await shown('sound').count(), 1, 'Sound must still render at a narrow window')
    await page.screenshot({ path: path.join(output, 'sound-tab.png') })
    groups.push('Sound tab renders at a narrow window size')

    assert.deepEqual(errors, [], 'a tab that throws shows the crash panel instead of its content')
    assert.deepEqual(blocked, [], 'the tabs must not reach the network just to open')
    console.log(JSON.stringify({ success: true, groups, output }, null, 2))
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
    console.error({ output, groups, errors, blocked }); throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
