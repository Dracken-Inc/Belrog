import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  User, Box, MapPin, Plus, Trash2, Download, Upload, RefreshCw,
  Sparkles, Users, Pencil, Save,
} from 'lucide-react'
import { useAssetLibraryStore, allLibraryEntries, libraryCounts } from '../../stores/assetLibraryStore'
import { requestAssetLibraryReference } from '../../services/assetLibraryBridge'
import { buildReferencePrompt, referenceNegative } from '../../services/scriptGapDetection'
import useAssetsStore from '../../stores/assetsStore'

/**
 * Cast — the left-panel management window for reference entries
 * (characters / props / locations). Always visible, works when empty.
 *
 * This is the OFFICIAL place for the asset library. It shares the global
 * assetLibraryStore with the Generate workspace, and queues reference-image
 * generation through the assetLibraryBridge (GenerateWorkspace drains it).
 */

function slug(value = '', { fallback = 'entry', maxLength = 48 } = {}) {
  const s = String(value || '').trim()
  const base = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return (base || fallback).slice(0, maxLength)
}

const KIND_ICON = { character: User, prop: Box, location: MapPin }
const KIND_LABEL = { character: 'Character', prop: 'Prop', location: 'Location' }
const KIND_TONE = {
  character: 'bg-sf-accent/20 text-sf-accent',
  prop: 'bg-sf-dark-600 text-sf-text-secondary',
  location: 'bg-sf-dark-600 text-sf-text-muted',
}

export default function CastPanel({ isActive = true }) {
  const {
    library,
    notice,
    setNotice,
    upsert,
    updateDescription,
    remove,
    addMany,
    export: doExport,
    import: doImport,
  } = useAssetLibraryStore()
  const assets = useAssetsStore((s) => s.assets)

  const [form, setForm] = useState({ kind: 'character', name: '', description: '' })
  const [filter, setFilter] = useState('all') // all | character | prop | location
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [menu, setMenu] = useState(null) // { entryId, x, y }
  const menuRef = useRef(null)
  const listRef = useRef(null)

  // Close the context menu on outside click / Escape
  useEffect(() => {
    if (!menu) return
    const onDown = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenu(null) }
    const onKey = (e) => { if (e.key === 'Escape') setMenu(null) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [menu])

  const counts = useMemo(() => libraryCounts(library), [library])
  const entries = useMemo(() => allLibraryEntries(library), [library])

  const visible = useMemo(() => {
    const q = String(search || '').trim().toLowerCase()
    return entries.filter((e) => {
      if (filter !== 'all' && e._kind !== filter) return false
      if (!q) return true
      return e.name?.toLowerCase().includes(q) || e.description?.toLowerCase().includes(q)
    })
  }, [entries, filter, search])

  // ── Add ─────────────────────────────────────────────────────────────────
  const handleAdd = useCallback(() => {
    const name = String(form.name || '').trim()
    if (!name) {
      setNotice({ tone: 'error', text: 'Give the entry a name first (e.g. "Rose", "the rusty gate", "Midnight Pier").' })
      return
    }
    const { created } = upsert({
      kind: form.kind,
      name,
      slug: slug(name),
      description: String(form.description || '').trim(),
      provenance: { source: 'manual', scriptVersion: null, shots: [] },
    })
    setForm((p) => ({ ...p, name: '', description: '' }))
    setNotice({
      tone: 'success',
      text: created ? `Added "${name}" to Cast.` : `"${name}" already existed — its description was kept/merged.`,
    })
  }, [form, upsert, setNotice])

  // ── Generate a reference image (bridged to GenerateWorkspace) ──────────
  const handleGenerate = useCallback((entry) => {
    const prompt = buildReferencePrompt(entry)
    if (!prompt) {
      setNotice({ tone: 'error', text: `"${entry?.name || 'This entry'}" has no description yet — write one, then generate.` })
      return
    }
    const ok = requestAssetLibraryReference({
      entryId: entry.id,
      kind: entry._kind,
      name: entry.name,
      prompt,
      negative: referenceNegative(entry._kind),
    })
    setNotice({
      tone: ok ? 'success' : 'error',
      text: ok
        ? `Queued a reference image for "${entry?.name}". Switch to the Generate tab to watch it.`
        : 'Could not queue the generation (Generate tab not ready yet).',
    })
  }, [setNotice])

  const handleRegenerateAll = useCallback(() => {
    const items = entries.filter((e) => !e.assetId && buildReferencePrompt(e))
    if (items.length === 0) {
      const skipped = entries.filter((e) => !e.assetId && !buildReferencePrompt(e)).length
      setNotice({
        tone: 'info',
        text: skipped > 0
          ? `Nothing to regenerate. ${skipped} need a description first.`
          : 'Every entry already has a reference.',
      })
      return
    }
    let queued = 0
    for (const e of items) {
      if (requestAssetLibraryReference({
        entryId: e.id, kind: e._kind, name: e.name,
        prompt: buildReferencePrompt(e), negative: referenceNegative(e._kind),
      })) queued += 1
    }
    setNotice({ tone: 'success', text: `Queued ${queued} reference image${queued === 1 ? '' : 's'}. Switch to the Generate tab to watch them.` })
  }, [entries, setNotice])

  // ── Export / Import ─────────────────────────────────────────────────────
  const handleExport = useCallback(() => {
    const total = counts.characters + counts.props + counts.locations
    if (total === 0) {
      setNotice({ tone: 'info', text: 'The Cast library is empty — nothing to export.' })
      return
    }
    const text = doExport()
    const blob = new Blob([text], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `belrog-cast-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30000)
  }, [counts, doExport, setNotice])

  const handleImportFile = useCallback((file) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const result = doImport(String(reader.result || ''))
      if (!result?.ok) {
        setNotice({ tone: 'error', text: result?.error || 'Could not import that file.' })
        return
      }
      setNotice({
        tone: 'success',
        text: `Imported ${result.imported} new entr${result.imported === 1 ? 'y' : 'ies'}${result.skipped ? `, ${result.skipped} already known` : ''}.`,
      })
    }
    reader.onerror = () => setNotice({ tone: 'error', text: 'Could not read that file.' })
    reader.readAsText(file)
  }, [doImport, setNotice])

  const handleDelete = useCallback((entry) => {
    if (!window.confirm(`Delete "${entry.name}" from Cast? (Any generated image is kept.)`)) return
    remove(entry.id)
    setNotice({ tone: 'info', text: `Deleted "${entry.name}".` })
  }, [remove, setNotice])

  // ── Per-entry export (a single entry, importable via the same Import) ──
  const downloadJson = useCallback((text, filename) => {
    const blob = new Blob([text], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30000)
  }, [])

  const handleExportEntry = useCallback((entry) => {
    const safe = String(entry?.slug || slug(entry?.name || 'entry')).replace(/[^a-z0-9-]+/g, '-')
    downloadJson(
      JSON.stringify({
        format: 'belrog-asset-library',
        version: 1,
        exportedAt: new Date().toISOString(),
        entries: [{
          id: entry.id,
          kind: entry._kind,
          name: entry.name,
          slug: entry.slug,
          description: entry.description,
          assetId: entry.assetId || null,
          provenance: entry.provenance || null,
        }],
      }, null, 2),
      `belrog-cast-${safe}.json`
    )
    setMenu(null)
    setNotice({ tone: 'success', text: `Exported "${entry?.name}". Import it anywhere with the same Import button.` })
  }, [downloadJson, setNotice])

  const filterTabs = [
    { id: 'all', label: 'All', count: entries.length },
    { id: 'character', label: 'Characters', count: counts.characters },
    { id: 'prop', label: 'Props', count: counts.props },
    { id: 'location', label: 'Locations', count: counts.locations },
  ]

  return (
    <div className="h-full flex flex-col bg-sf-dark-900">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-sf-dark-700 px-3 py-2 space-y-2">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-sf-accent" />
          <span className="text-sm font-medium text-sf-text-primary">Cast</span>
          <span className="text-[10px] text-sf-text-muted">
            {counts.characters} · {counts.props} · {counts.locations}
          </span>
        </div>
        {/* Add form */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <select
              value={form.kind}
              onChange={(e) => setForm((p) => ({ ...p, kind: e.target.value }))}
              className="rounded border border-sf-dark-500 bg-sf-dark-800 px-1.5 py-1 text-[11px] text-sf-text-primary focus:outline-none focus:border-sf-accent"
              aria-label="Entry type"
            >
              <option value="character">Character</option>
              <option value="prop">Prop</option>
              <option value="location">Location</option>
            </select>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAdd() }}
              placeholder="Name (e.g. Rose)"
              className="min-w-0 flex-1 rounded border border-sf-dark-500 bg-sf-dark-800 px-2 py-1 text-[11px] text-sf-text-primary placeholder:text-sf-text-muted focus:outline-none focus:border-sf-accent"
            />
            <button
              type="button"
              onClick={handleAdd}
              className="rounded bg-sf-accent p-1.5 text-white hover:opacity-90"
              title="Add to Cast"
              aria-label="Add to Cast"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
          <input
            type="text"
            value={form.description}
            onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd() }}
            placeholder="Description — becomes the reference prompt"
            className="w-full rounded border border-sf-dark-500 bg-sf-dark-800 px-2 py-1 text-[11px] text-sf-text-primary placeholder:text-sf-text-muted focus:outline-none focus:border-sf-accent"
          />
        </div>
        {/* Filter tabs */}
        <div className="flex items-center gap-1">
          {filterTabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setFilter(t.id)}
              className={`px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                filter === t.id ? 'bg-sf-accent text-white' : 'bg-sf-dark-700 text-sf-text-muted hover:text-sf-text-primary'
              }`}
            >
              {t.label} <span className="opacity-70">{t.count}</span>
            </button>
          ))}
        </div>
        {/* Search + toolbar */}
        <div className="flex items-center gap-1.5">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            className="min-w-0 flex-1 rounded border border-sf-dark-500 bg-sf-dark-800 px-2 py-1 text-[11px] text-sf-text-primary placeholder:text-sf-text-muted focus:outline-none focus:border-sf-accent"
          />
          <button type="button" onClick={handleRegenerateAll} className="rounded border border-sf-accent/60 bg-sf-accent/15 px-1.5 py-1 text-sf-accent hover:bg-sf-accent/25" title="Regenerate all missing references" aria-label="Regenerate all"><RefreshCw className="w-3 h-3" /></button>
          <button type="button" onClick={handleExport} className="rounded border border-sf-dark-500 px-1.5 py-1 text-sf-text-muted hover:text-sf-text-primary hover:border-sf-dark-400" title="Export Cast" aria-label="Export Cast"><Download className="w-3 h-3" /></button>
          <label className="rounded border border-sf-dark-500 px-1.5 py-1 text-sf-text-muted hover:text-sf-text-primary hover:border-sf-dark-400 cursor-pointer" title="Import Cast" aria-label="Import Cast">
            <Upload className="w-3 h-3" />
            <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => { handleImportFile(e.target.files?.[0] || null); e.target.value = '' }} />
          </label>
        </div>
      </div>

      {/* Notice toast */}
      {notice && (
        <div className={`flex-shrink-0 mx-3 mt-2 rounded px-2 py-1 text-[11px] leading-snug ${
          notice.tone === 'error' ? 'border border-red-500/40 bg-red-500/10 text-red-200/90'
            : notice.tone === 'success' ? 'border border-emerald-500/40 bg-emerald-500/10 text-emerald-200/90'
            : 'border border-sf-dark-600 bg-sf-dark-800/60 text-sf-text-secondary'
        }`}>
          {notice.text}
          <button type="button" onClick={() => setNotice(null)} className="ml-2 opacity-60 hover:opacity-100" aria-label="Dismiss">×</button>
        </div>
      )}

      {/* Entry list */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {visible.length === 0 ? (
          <div className="mt-6 rounded-lg border border-dashed border-sf-dark-600 px-3 py-6 text-center text-[11px] text-sf-text-muted leading-relaxed">
            {search || filter !== 'all'
              ? 'No entries match this filter.'
              : 'Empty Cast. Add a character, prop, or location above. The Director Script "People" tab will also surface names it detects so you can add them in one click.'}
          </div>
        ) : (
          visible.map((entry) => {
            const Icon = KIND_ICON[entry._kind] || Box
            const refAsset = entry.assetId ? assets.find((a) => a?.id === entry.assetId) : null
            const selected = selectedId === entry.id
            return (
              <div
                key={entry.id}
                data-cast-entry={entry.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedId(selected ? null : entry.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedId(selected ? null : entry.id) } }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  const r = listRef.current?.getBoundingClientRect()
                  setMenu({ entryId: entry.id, x: e.clientX, y: e.clientY, panelLeft: r?.left ?? 0, panelWidth: r?.width ?? 0 })
                }}
                className={`flex items-start gap-2 rounded-lg border p-2 transition-colors ${
                  selected ? 'border-sf-accent bg-sf-accent/10' : 'border-sf-dark-700 bg-sf-dark-800/40 hover:border-sf-dark-500'
                }`}
              >
                {refAsset?.url ? (
                  <img src={refAsset.url} alt="" className="h-12 w-12 shrink-0 rounded object-cover border border-sf-dark-600" />
                ) : (
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded border border-dashed border-sf-dark-600">
                    <Icon className="w-4 h-4 text-sf-text-muted" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className={`rounded px-1 py-0.5 text-[9px] leading-none ${KIND_TONE[entry._kind]}`}>
                      {KIND_LABEL[entry._kind]}
                    </span>
                    <span className="truncate text-[12px] font-medium text-sf-text-primary">{entry.name}</span>
                    {selected && <span className="ml-auto shrink-0 text-[9px] uppercase tracking-wide text-sf-accent">selected</span>}
                  </div>
                  <input
                    type="text"
                    value={entry.description || ''}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => updateDescription(entry.id, e.target.value)}
                    placeholder="Write a description — it becomes the prompt… (right-click for more)"
                    className="mt-1 w-full rounded border border-sf-dark-600 bg-sf-dark-900/70 px-1.5 py-0.5 text-[11px] text-sf-text-primary focus:outline-none focus:border-sf-accent"
                  />
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleGenerate(entry) }}
                    className="flex items-center gap-1 rounded border border-sf-dark-500 px-1.5 py-1 text-[10px] text-sf-text-secondary hover:text-sf-accent hover:border-sf-accent/50"
                    title={refAsset ? 'Regenerate the reference image' : 'Generate the reference image'}
                  >
                    <Sparkles className="w-3 h-3" />
                    {refAsset ? 'Re-gen' : 'Gen'}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleDelete(entry) }}
                    className="flex items-center justify-center gap-1 rounded border border-sf-dark-500 px-1.5 py-1 text-[10px] text-sf-text-muted hover:text-red-300 hover:border-red-500/40"
                    title="Delete this entry"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>
    {/* Right-click context menu (portal — escapes panel clipping) */}
      {menu && (() => {
        const entry = entries.find((e) => e.id === menu.entryId)
        if (!entry) return null
        const refAsset = entry.assetId ? assets.find((a) => a?.id === entry.assetId) : null
        // Keep the menu inside the viewport
        const mw = 184
        const x = Math.min(menu.x, window.innerWidth - mw - 8)
        const y = Math.min(menu.y, window.innerHeight - 190 - 8)
        const items = [
          {
            icon: Sparkles,
            label: refAsset ? 'Regenerate reference' : 'Generate reference',
            onClick: () => { handleGenerate(entry); setMenu(null) },
          },
          {
            icon: Pencil,
            label: 'Edit description',
            onClick: () => {
              setMenu(null)
              const el = listRef.current?.querySelector(`[data-cast-entry="${CSS.escape(entry.id)}"] input`)
              el?.focus()
            },
          },
          {
            icon: Download,
            label: 'Export entry',
            onClick: () => handleExportEntry(entry),
          },
          {
            icon: Trash2,
            label: 'Delete',
            danger: true,
            onClick: () => { setMenu(null); handleDelete(entry) },
          },
        ]
        return createPortal(
          <div
            ref={menuRef}
            style={{ position: 'fixed', left: x, top: y, width: mw, zIndex: 10000 }}
            className="rounded-lg border border-sf-dark-500 bg-sf-dark-800 py-1 shadow-2xl shadow-black/60"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-2.5 py-1 text-[10px] font-medium text-sf-text-muted border-b border-sf-dark-700">
              {KIND_LABEL[entry._kind]} — {entry.name}
            </div>
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                onClick={it.onClick}
                className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors ${
                  it.danger ? 'text-red-300 hover:bg-red-500/15' : 'text-sf-text-secondary hover:bg-sf-dark-700 hover:text-sf-text-primary'
                }`}
              >
                <it.icon className="w-3 h-3" />
                {it.label}
              </button>
            ))}
          </div>,
          document.body
        )
      })()}
    </div>
  )
}