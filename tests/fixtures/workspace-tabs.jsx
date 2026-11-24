// The real Create and Sound tabs, mounted the way App.jsx mounts them. Nothing
// else: no provider accounts, no ComfyUI, no project IO, no file writes. The
// tabs only need their zustand stores, so this is the cheapest place to prove
// they still render - which matters because a tab that throws on mount used to
// ship silently. .jsx is not scanned by the identifier gate, `node --check` is
// blind to it, and the build succeeds: App.jsx passes mode="sound" while the
// component's parameter list had been emptied, so `const sound = mode === 'sound'`
// threw "ReferenceError: mode is not defined" and both tabs showed the crash
// panel on Henry's machine in 0.5.2.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import CreateWorkspace from '../../src/components/CreateWorkspace'

// The tabs reach for exactly these; anything else stays undefined so a code
// path that needs more than this fails loudly instead of inventing an answer.
// comfyRouter reports "not connected" on purpose: CreateWorkspace early-returns
// "Create is available in the Belrog desktop app" without it, and the point here
// is that the tab renders, not that it can price a request. Nothing sends.
const inertRouter = Object.fromEntries(['status', 'models', 'list', 'refresh', 'balance', 'previewCreate',
  'submitCreate', 'cancel', 'connect', 'clear'].map(name => [name, async () => ({ success: false })]))
window.electronAPI = {
  isElectron: true,
  invoke: async () => null,
  on: () => {},
  removeListener: () => {},
  readFileAsBuffer: async () => ({ success: false, error: 'synthetic fixture' }),
  comfyRouter: inertRouter,
}

function Fixture() {
  const [tab, setTab] = useState('create')
  return <div className="flex h-screen flex-col bg-sf-dark-950 text-sf-text-primary">
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-sf-dark-700 px-4">
      <span>Belrog · Create and Sound tabs</span>
      <button type="button" className="rounded bg-sf-dark-700 px-3 py-1" onClick={() => setTab('create')}>Create</button>
      <button type="button" className="rounded bg-sf-dark-700 px-3 py-1" onClick={() => setTab('sound')}>Sound</button>
    </header>
    <main className="flex min-h-0 flex-1 flex-col">
      {/* Exactly as App.jsx renders them: Sound gets mode, Create gets nothing
          and relies on the default. Both share one component. */}
      {tab === 'sound' ? <CreateWorkspace mode="sound" /> : <CreateWorkspace />}
    </main>
  </div>
}

window.workspaceTabsTest = { ready: false, snapshot: () => ({
  mode: document.querySelector('.vcreate')?.dataset.mode || null,
  title: document.querySelector('.vc-title')?.innerText || null,
}) }

createRoot(document.getElementById('root')).render(<Fixture />)
requestAnimationFrame(() => { window.workspaceTabsTest.ready = true })
