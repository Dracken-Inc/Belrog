/**
 * Director Engine — Generate Script Modal
 *
 * Electron module that renders the "Generate Script" modal and orchestrates
 * the music video pipeline with real-time progress updates.
 *
 * Features:
 *  - Model picker (local/lmstudio/openrouter) with VRAM fit indicator
 *  - Two-pass progress: Plot generation → Per-shot CSV → V-gate validation
 *  - plan.json output with save dialog
 *  - V-gate status display (grammar + schema + repair retry count)
 *  - Error handling with recoverable/non-recoverable distinction
 */

const { ipcRenderer, contextBridge } = require('electron')
const path = require('path')

// ═══════════════════════════════════════════
// State
// ═══════════════════════════════════════════

let currentPipeline = null
let abortController = null
let modelCatalog = []

// ═══════════════════════════════════════════
// Modal HTML Template
// ═══════════════════════════════════════════

const MODAL_HTML = `
<div id="director-modal" class="director-modal-overlay" style="display:none;">
  <div class="director-modal" role="dialog" aria-modal="true" aria-labelledby="director-title">
    <div class="director-header">
      <h2 id="director-title">Generate Music Video Script</h2>
      <button class="director-close" aria-label="Close">&times;</button>
    </div>

    <div class="director-body">
      <!-- Step 1: Input Selection -->
      <section id="step-input" class="director-step">
        <h3>1. Select Input</h3>
        <div class="field-group">
          <label for="input-file">Suno .m4a file</label>
          <div class="file-picker-row">
            <input type="text" id="input-file" readonly placeholder="No file selected">
            <button id="btn-browse" class="btn btn-secondary">Browse…</button>
          </div>
          <div id="file-meta" class="file-meta" style="display:none;"></div>
        </div>
        <div class="field-group">
          <label for="output-dir">Output directory</label>
          <div class="file-picker-row">
            <input type="text" id="output-dir" readonly placeholder="Auto (projects/belrog_<timestamp>/)">
            <button id="btn-output-dir" class="btn btn-secondary">Choose…</button>
          </div>
        </div>
      </section>

      <!-- Step 2: Model Selection -->
      <section id="step-model" class="director-step">
        <h3>2. Choose LLM Backend</h3>
        <div class="field-group">
          <label for="backend-select">Backend</label>
          <select id="backend-select">
            <option value="local">Local (llama-server sidecar)</option>
            <option value="lmstudio">LM Studio (local OpenAI-compatible)</option>
            <option value="openrouter">OpenRouter (cloud)</option>
          </select>
        </div>
        <div class="field-group" id="model-select-group">
          <label for="model-select">Model</label>
          <select id="model-select"></select>
          <div id="vram-indicator" class="vram-indicator"></div>
        </div>
        <div class="field-group" id="lmstudio-config" style="display:none;">
          <label for="lmstudio-url">LM Studio Base URL</label>
          <input type="text" id="lmstudio-url" value="http://localhost:1234/v1" placeholder="http://localhost:1234/v1">
        </div>
        <div class="field-group" id="openrouter-config" style="display:none;">
          <label for="openrouter-key">OpenRouter API Key</label>
          <input type="password" id="openrouter-key" placeholder="sk-or-...">
          <small>Stored in session only, not persisted</small>
        </div>
      </section>

      <!-- Step 3: Style Options -->
      <section id="step-style" class="director-step">
        <h3>3. Style & Options</h3>
        <div class="field-group">
          <label for="style-select">Creative Style</label>
          <select id="style-select">
            <option value="mtv-1990s">MTV 1990s (default)</option>
          </select>
        </div>
        <div class="field-group">
          <label for="preset-select">Creative Preset</label>
          <select id="preset-select">
            <option value="narrative">Narrative</option>
            <option value="performance">Performance-focused</option>
            <option value="abstract">Abstract/Visual</option>
          </select>
        </div>
        <div class="field-group">
          <label for="target-sec">Target shot length (seconds)</label>
          <input type="number" id="target-sec" value="5" min="2" max="15" step="0.5">
        </div>
      </section>

      <!-- Step 4: Progress & Execution -->
      <section id="step-progress" class="director-step" style="display:none;">
        <h3>4. Generation Progress</h3>

        <div id="progress-overall" class="progress-bar-container">
          <div class="progress-label">Overall</div>
          <div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div>
          <div class="progress-pct">0%</div>
        </div>

        <div id="stage-steps" class="stage-steps">
          <div class="stage-step" data-stage="intake">
            <span class="stage-icon">○</span>
            <span class="stage-name">Intake (metadata + lyrics)</span>
          </div>
          <div class="stage-step" data-stage="audio">
            <span class="stage-icon">○</span>
            <span class="stage-name">Audio Analysis (envelope → beats + sections)</span>
          </div>
          <div class="stage-step" data-stage="plot">
            <span class="stage-icon">○</span>
            <span class="stage-name">Pass 1: Plot Generation</span>
          </div>
          <div class="stage-step" data-stage="shots">
            <span class="stage-icon">○</span>
            <span class="stage-name">Pass 2: Per-Shot Plan</span>
          </div>
          <div class="stage-step" data-stage="validate">
            <span class="stage-icon">○</span>
            <span class="stage-name">V-Gate Validation</span>
          </div>
          <div class="stage-step" data-stage="emit">
            <span class="stage-icon">○</span>
            <span class="stage-name">Write plan.json</span>
          </div>
        </div>

        <div id="stage-detail" class="stage-detail">
          <div class="detail-message">Ready to start…</div>
          <div class="detail-sub" style="display:none;"></div>
        </div>

        <div id="vgate-status" class="vgate-status" style="display:none;">
          <h4>V-Gate Status</h4>
          <div class="vgate-row">
            <span class="vgate-label">Grammar Check:</span>
            <span class="vgate-value" id="vgate-grammar">pending</span>
          </div>
          <div class="vgate-row">
            <span class="vgate-label">Schema Validation:</span>
            <span class="vgate-value" id="vgate-schema">pending</span>
          </div>
          <div class="vgate-row">
            <span class="vgate-label">Repair Retries:</span>
            <span class="vgate-value" id="vgate-repairs">0</span>
          </div>
        </div>

        <div id="shot-progress" class="shot-progress" style="display:none;">
          <div class="shot-progress-bar"><div class="shot-progress-fill" style="width:0%"></div></div>
          <div class="shot-progress-text">Shot <span id="shot-current">0</span> / <span id="shot-total">0</span></div>
        </div>
      </section>

      <!-- Step 5: Result -->
      <section id="step-result" class="director-step" style="display:none;">
        <h3>5. Result</h3>
        <div id="result-summary" class="result-summary"></div>
        <div class="result-actions">
          <button id="btn-open-folder" class="btn btn-secondary" style="display:none;">Open Output Folder</button>
          <button id="btn-save-plan" class="btn btn-primary" style="display:none;">Save plan.json As…</button>
          <button id="btn-generate-another" class="btn btn-secondary">Generate Another</button>
        </div>
      </section>
    </div>

    <div class="director-footer">
      <button id="btn-back" class="btn btn-secondary" style="display:none;">Back</button>
      <button id="btn-next" class="btn btn-primary">Next</button>
      <button id="btn-start" class="btn btn-primary" style="display:none;">Start Generation</button>
      <button id="btn-abort" class="btn btn-danger" style="display:none;">Abort</button>
    </div>
  </div>
</div>

<style>
.director-modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.6);
  display: flex; align-items: center; justify-content: center;
  z-index: 10000; font-family: system-ui, -apple-system, sans-serif;
}
.director-modal {
  background: var(--card, #1e1e1e); color: var(--foreground, #fff);
  border: 1px solid var(--border, #333); border-radius: 12px;
  width: 90%; max-width: 720px; max-height: 90vh; overflow: auto;
  box-shadow: 0 20px 60px rgba(0,0,0,0.4);
}
.director-header { display:flex; justify-content:space-between; align-items:center; padding:16px 20px; border-bottom:1px solid var(--border,#333); }
.director-header h2 { margin:0; font-size:1.25rem; }
.director-close { background:none; border:none; color:var(--muted-foreground,#888); font-size:1.5rem; cursor:pointer; line-height:1; }
.director-close:hover { color:var(--foreground,#fff); }
.director-body { padding:20px; }
.director-step h3 { margin:0 0 16px; font-size:1rem; color:var(--muted-foreground,#888); }
.field-group { margin-bottom:16px; }
.field-group label { display:block; margin-bottom:6px; font-size:0.875rem; font-weight:500; }
.field-group input, .field-group select { width:100%; padding:10px 12px; border-radius:6px; border:1px solid var(--border,#333); background:var(--background,#121212); color:var(--foreground,#fff); font-size:0.9375rem; }
.field-group input:focus, .field-group select:focus { outline:none; border-color:var(--accent,#3b82f6); }
.file-picker-row { display:flex; gap:8px; }
.file-picker-row input { flex:1; }
.btn { padding:10px 18px; border-radius:6px; border:none; font-size:0.875rem; font-weight:500; cursor:pointer; transition:opacity 0.15s; }
.btn:disabled { opacity:0.5; cursor:not-allowed; }
.btn-primary { background:var(--accent,#3b82f6); color:white; }
.btn-primary:hover:not(:disabled) { opacity:0.9; }
.btn-secondary { background:var(--border,#333); color:var(--foreground,#fff); }
.btn-secondary:hover:not(:disabled) { opacity:0.8; }
.btn-danger { background:#ef4444; color:white; }
.director-footer { display:flex; justify-content:flex-end; gap:12px; padding:16px 20px; border-top:1px solid var(--border,#333); }
.stage-steps { display:flex; flex-direction:column; gap:8px; margin-bottom:16px; }
.stage-step { display:flex; align-items:center; gap:10px; font-size:0.875rem; color:var(--muted-foreground,#888); transition:color 0.2s; }
.stage-step.active { color:var(--accent,#3b82f6); font-weight:500; }
.stage-step.done { color:var(--foreground,#fff); }
.stage-step.done .stage-icon { color:#22c55e; }
.stage-icon { width:20px; text-align:center; font-size:1rem; }
.stage-detail { padding:12px; background:var(--background,#121212); border-radius:6px; border:1px solid var(--border,#333); min-height:60px; }
.detail-message { font-weight:500; }
.detail-sub { font-size:0.8125rem; color:var(--muted-foreground,#888); margin-top:4px; }
.progress-bar-container { display:flex; align-items:center; gap:12px; margin-bottom:16px; }
.progress-label { width:80px; font-size:0.875rem; }
.progress-bar { flex:1; height:8px; background:var(--background,#121212); border-radius:4px; overflow:hidden; }
.progress-fill { height:100%; background:var(--accent,#3b82f6); border-radius:4px; transition:width 0.3s; }
.progress-pct { width:45px; text-align:right; font-size:0.8125rem; color:var(--muted-foreground,#888); }
.vgate-status { margin-top:16px; padding:12px; background:var(--background,#121212); border-radius:6px; border:1px solid var(--border,#333); }
.vgate-status h4 { margin:0 0 12px; font-size:0.875rem; }
.vgate-row { display:flex; justify-content:space-between; margin-bottom:8px; font-size:0.875rem; }
.vgate-row:last-child { margin-bottom:0; }
.vgate-label { color:var(--muted-foreground,#888); }
.vgate-value { font-weight:500; }
.vgate-value.ok { color:#22c55e; }
.vgate-value.warn { color:#f59e0b; }
.vgate-value.fail { color:#ef4444; }
.shot-progress { margin-top:16px; }
.shot-progress-bar { height:6px; background:var(--background,#121212); border-radius:3px; overflow:hidden; }
.shot-progress-fill { height:100%; background:#8b5cf6; border-radius:3px; transition:width 0.2s; }
.shot-progress-text { text-align:right; margin-top:4px; font-size:0.8125rem; color:var(--muted-foreground,#888); }
.result-summary { padding:16px; background:var(--background,#121212); border-radius:6px; border:1px solid var(--border,#333); margin-bottom:16px; }
.result-actions { display:flex; justify-content:flex-end; gap:12px; }
.vram-indicator { margin-top:6px; font-size:0.75rem; padding:4px 8px; border-radius:4px; display:inline-block; }
.vram-indicator.fit { background:#22c55e22; color:#22c55e; border:1px solid #22c55e44; }
.vram-indicator.tight { background:#f59e0b22; color:#f59e0b; border:1px solid #f59e0b44; }
.vram-indicator.no-fit { background:#ef444422; color:#ef4444; border:1px solid #ef444444; }
.file-meta { margin-top:8px; font-size:0.8125rem; color:var(--muted-foreground,#888); }
</style>
`

// ═══════════════════════════════════════════
// Core Modal Class
// ═══════════════════════════════════════════

class DirectorEngine {
  constructor() {
    this.modal = null
    this.currentStep = 1
    this.selectedFile = null
    this.outputDir = null
    this.selectedBackend = 'local'
    this.selectedModel = null
    this.generatedPlan = null
    this.planPath = null
  }

  /**
   * Initialize and inject modal into DOM.
   */
  init() {
    if (document.getElementById('director-modal')) return
    const container = document.createElement('div')
    container.innerHTML = MODAL_HTML
    document.body.appendChild(container.firstElementChild)
    this.modal = document.getElementById('director-modal')
    this.bindEvents()
    this.loadModelCatalog()
  }

  /**
   * Show the modal.
   */
  show() {
    this.init()
    this.modal.style.display = 'flex'
    this.currentStep = 1
    this.showStep(1)
    this.updateFooter()
  }

  /**
   * Hide the modal.
   */
  hide() {
    if (this.modal) this.modal.style.display = 'none'
  }

  /**
   * Bind all event listeners.
   */
  bindEvents() {
    // Close
    this.modal.querySelector('.director-close').addEventListener('click', () => this.hide())

    // Step 1: Input
    this.modal.querySelector('#btn-browse').addEventListener('click', () => this.browseInputFile())
    this.modal.querySelector('#btn-output-dir').addEventListener('click', () => this.browseOutputDir())

    // Step 2: Model
    this.modal.querySelector('#backend-select').addEventListener('change', (e) => this.onBackendChange(e.target.value))
    this.modal.querySelector('#model-select').addEventListener('change', (e) => this.onModelChange(e.target.value))

    // Navigation
    this.modal.querySelector('#btn-back').addEventListener('click', () => this.goBack())
    this.modal.querySelector('#btn-next').addEventListener('click', () => this.goNext())
    this.modal.querySelector('#btn-start').addEventListener('click', () => this.startGeneration())
    this.modal.querySelector('#btn-abort').addEventListener('click', () => this.abortGeneration())

    // Result actions
    this.modal.querySelector('#btn-open-folder').addEventListener('click', () => this.openOutputFolder())
    this.modal.querySelector('#btn-save-plan').addEventListener('click', () => this.savePlanAs())
    this.modal.querySelector('#btn-generate-another').addEventListener('click', () => this.resetForNew())

    // IPC listeners for pipeline progress
    ipcRenderer.on('mv:progress', (_, data) => this.onProgress(data))
    ipcRenderer.on('mv:shot-done', (_, data) => this.onShotDone(data))
    ipcRenderer.on('mv:error', (_, data) => this.onError(data))
    ipcRenderer.on('mv:complete', (_, data) => this.onComplete(data))
  }

  /**
   * Load model catalog from main process.
   */
  async loadModelCatalog() {
    try {
      const result = await ipcRenderer.invoke('director:get-model-catalog')
      if (result.success) {
        modelCatalog = result.presets
        this.populateModelSelect()
      }
    } catch (err) {
      console.warn('[DirectorEngine] Failed to load model catalog:', err)
    }
  }

  /**
   * Populate model select dropdown based on backend.
   */
  populateModelSelect() {
    const select = this.modal.querySelector('#model-select')
    const backend = this.selectedBackend
    select.innerHTML = ''

    let models = []
    if (backend === 'local') {
      models = modelCatalog.filter(m => m.fits).map(m => ({
        value: m.id,
        label: `${m.name} (${m.vramGB.toFixed(1)} GB VRAM)`,
        fits: true,
      }))
      if (models.length === 0) {
        models = modelCatalog.map(m => ({
          value: m.id,
          label: `${m.name} (${m.vramGB.toFixed(1)} GB VRAM) ⚠️`,
          fits: false,
        }))
      }
    } else if (backend === 'lmstudio') {
      models = [
        { value: 'auto', label: 'Auto-detect from LM Studio' },
        { value: 'local-model', label: 'Custom (enter in LM Studio)' },
      ]
    } else if (backend === 'openrouter') {
      models = [
        { value: 'nvidia/nemotron-3-ultra:free', label: 'Nemotron 3 Ultra (free)' },
        { value: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet' },
        { value: 'openai/gpt-4o', label: 'GPT-4o' },
        { value: 'google/gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
      ]
    }

    for (const m of models) {
      const opt = document.createElement('option')
      opt.value = m.value
      opt.textContent = m.label
      select.appendChild(opt)
    }

    this.updateVRAMIndicator()
  }

  /**
   * Update VRAM fit indicator for local models.
   */
  updateVRAMIndicator() {
    const indicator = this.modal.querySelector('#vram-indicator')
    const backend = this.selectedBackend
    const modelId = this.modal.querySelector('#model-select').value

    if (backend !== 'local' || !modelId) {
      indicator.textContent = ''
      indicator.className = 'vram-indicator'
      return
    }

    const model = modelCatalog.find(m => m.id === modelId)
    if (!model) return

    const vram = modelCatalog.vramGB || 0
    const safeLimit = vram * 0.85

    if (model.vramGB <= safeLimit) {
      indicator.textContent = `✓ Fits in ${vram.toFixed(1)} GB VRAM (limit: ${safeLimit.toFixed(1)} GB)`
      indicator.className = 'vram-indicator fit'
    } else if (model.vramGB <= vram) {
      indicator.textContent = `⚠ Tight fit: ${model.vramGB.toFixed(1)} GB of ${vram.toFixed(1)} GB VRAM`
      indicator.className = 'vram-indicator tight'
    } else {
      indicator.textContent = `✗ Exceeds VRAM: ${model.vramGB.toFixed(1)} GB needed, ${vram.toFixed(1)} GB available`
      indicator.className = 'vram-indicator no-fit'
    }
  }

  // ═══════════════════════════════════════════
  // Event Handlers
  // ═══════════════════════════════════════════

  async browseInputFile() {
    const result = await ipcRenderer.invoke('dialog:openFile', {
      title: 'Select Suno .m4a file',
      filters: [{ name: 'Suno Audio', extensions: ['m4a'] }],
      properties: ['openFile'],
    })
    if (!result.canceled && result.filePaths.length) {
      this.selectedFile = result.filePaths[0]
      const inputEl = this.modal.querySelector('#input-file')
      inputEl.value = this.selectedFile
      // Show metadata preview
      const meta = await ipcRenderer.invoke('director:peek-metadata', this.selectedFile)
      if (meta) {
        this.modal.querySelector('#file-meta').style.display = 'block'
        this.modal.querySelector('#file-meta').textContent = `${meta.title || 'Untitled'} — ${meta.artist || 'Unknown artist'} — ${meta.durationSec?.toFixed(1) || '?'}s`
      }
      this.validateStep1()
    }
  }

  async browseOutputDir() {
    const result = await ipcRenderer.invoke('dialog:openDirectory', {
      title: 'Select output directory',
    })
    if (!result.canceled && result.filePaths.length) {
      this.outputDir = result.filePaths[0]
      this.modal.querySelector('#output-dir').value = this.outputDir
    }
  }

  onBackendChange(backend) {
    this.selectedBackend = backend
    // Show/hide backend-specific config
    this.modal.querySelector('#lmstudio-config').style.display = backend === 'lmstudio' ? 'block' : 'none'
    this.modal.querySelector('#openrouter-config').style.display = backend === 'openrouter' ? 'block' : 'none'
    this.populateModelSelect()
    this.updateVRAMIndicator()
  }

  onModelChange(modelId) {
    this.selectedModel = modelId
    this.updateVRAMIndicator()
  }

  validateStep1() {
    const nextBtn = this.modal.querySelector('#btn-next')
    nextBtn.disabled = !this.selectedFile
  }

  // ═══════════════════════════════════════════
  // Step Navigation
  // ═══════════════════════════════════════════

  showStep(step) {
    // Hide all steps
    this.modal.querySelectorAll('.director-step').forEach(el => el.style.display = 'none')
    // Show target
    const stepEl = this.modal.querySelector(`#step-${['input', 'model', 'style', 'progress', 'result'][step - 1]}`)
    if (stepEl) stepEl.style.display = 'block'
    this.currentStep = step
    this.updateFooter()
  }

  goBack() {
    if (this.currentStep > 1) this.showStep(this.currentStep - 1)
  }

  goNext() {
    if (this.currentStep === 1) {
      if (!this.selectedFile) return
      this.showStep(2)
    } else if (this.currentStep === 2) {
      this.showStep(3)
    } else if (this.currentStep === 3) {
      this.showStep(4)
      // Switch footer to start button
      this.modal.querySelector('#btn-next').style.display = 'none'
      this.modal.querySelector('#btn-start').style.display = 'inline-flex'
    }
  }

  updateFooter() {
    const backBtn = this.modal.querySelector('#btn-back')
    const nextBtn = this.modal.querySelector('#btn-next')
    const startBtn = this.modal.querySelector('#btn-start')
    const abortBtn = this.modal.querySelector('#btn-abort')

    backBtn.style.display = this.currentStep > 1 ? 'inline-flex' : 'none'
    nextBtn.style.display = (this.currentStep < 4 && this.currentStep !== 4) ? 'inline-flex' : 'none'
    startBtn.style.display = this.currentStep === 4 ? 'inline-flex' : 'none'
    abortBtn.style.display = 'none'
  }

  // ═══════════════════════════════════════════
  // Pipeline Execution
  // ═══════════════════════════════════════════

  async startGeneration() {
    if (!this.selectedFile) return

    // Gather options
    const options = {
      style: this.modal.querySelector('#style-select').value,
      creativePreset: this.modal.querySelector('#preset-select').value,
      backend: this.selectedBackend,
      modelId: this.selectedModel || null,
      targetSec: Number(this.modal.querySelector('#target-sec').value),
      outputDir: this.outputDir || null,
    }

    // Backend-specific extras
    if (this.selectedBackend === 'lmstudio') {
      options.lmstudioUrl = this.modal.querySelector('#lmstudio-url').value
    } else if (this.selectedBackend === 'openrouter') {
      options.openrouterKey = this.modal.querySelector('#openrouter-key').value
    }

    // Reset UI for progress
    this.resetProgressUI()
    this.modal.querySelector('#btn-start').style.display = 'none'
    this.modal.querySelector('#btn-abort').style.display = 'inline-flex'
    this.modal.querySelector('#btn-back').style.display = 'none'

    // Create abort controller
    abortController = new AbortController()

    try {
      // Call main process to run pipeline
      const result = await ipcRenderer.invoke('director:run-pipeline', {
        filePath: this.selectedFile,
        options,
      })

      if (result.success) {
        this.generatedPlan = result.plan
        this.planPath = result.planPath
        this.showResult(result)
      } else {
        this.showError(result.error)
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        this.showError(err.message)
      }
    } finally {
      this.modal.querySelector('#btn-abort').style.display = 'none'
      this.modal.querySelector('#btn-back').style.display = 'inline-flex'
    }
  }

  abortGeneration() {
    if (abortController) abortController.abort()
    ipcRenderer.send('director:abort-pipeline')
    this.modal.querySelector('#btn-abort').disabled = true
    this.modal.querySelector('#btn-abort').textContent = 'Aborting…'
  }

  resetProgressUI() {
    // Reset stage steps
    this.modal.querySelectorAll('.stage-step').forEach(el => {
      el.className = 'stage-step'
      el.querySelector('.stage-icon').textContent = '○'
    })
    this.modal.querySelector('.stage-step[data-stage="intake"]').classList.add('active')

    // Reset progress bars
    this.modal.querySelector('#progress-overall .progress-fill').style.width = '0%'
    this.modal.querySelector('#progress-overall .progress-pct').textContent = '0%'
    this.modal.querySelector('#stage-detail .detail-message').textContent = 'Starting…'
    this.modal.querySelector('#stage-detail .detail-sub').style.display = 'none'

    // Hide V-gate and shot progress
    this.modal.querySelector('#vgate-status').style.display = 'none'
    this.modal.querySelector('#shot-progress').style.display = 'none'

    // Reset V-gate values
    this.modal.querySelector('#vgate-grammar').textContent = 'pending'
    this.modal.querySelector('#vgate-grammar').className = 'vgate-value'
    this.modal.querySelector('#vgate-schema').textContent = 'pending'
    this.modal.querySelector('#vgate-schema').className = 'vgate-value'
    this.modal.querySelector('#vgate-repairs').textContent = '0'
  }

  // ═══════════════════════════════════════════
  // IPC Progress Handlers
  // ═══════════════════════════════════════════

  onProgress(data) {
    const { stage, progress, overall, message, detail } = data

    // Update overall progress
    this.modal.querySelector('#progress-overall .progress-fill').style.width = `${Math.round(overall * 100)}%`
    this.modal.querySelector('#progress-overall .progress-pct').textContent = `${Math.round(overall * 100)}%`

    // Update stage steps
    const stages = ['intake', 'audio', 'plot', 'shots', 'validate', 'emit']
    const currentIndex = stages.indexOf(stage)

    stages.forEach((s, i) => {
      const el = this.modal.querySelector(`.stage-step[data-stage="${s}"]`)
      if (!el) return
      if (i < currentIndex) {
        el.className = 'stage-step done'
        el.querySelector('.stage-icon').textContent = '✓'
      } else if (i === currentIndex) {
        el.className = 'stage-step active'
        el.querySelector('.stage-icon').textContent = '◐'
      } else {
        el.className = 'stage-step'
        el.querySelector('.stage-icon').textContent = '○'
      }
    })

    // Update detail message
    this.modal.querySelector('#stage-detail .detail-message').textContent = message
    if (detail) {
      const sub = this.modal.querySelector('#stage-detail .detail-sub')
      sub.textContent = typeof detail === 'string' ? detail : JSON.stringify(detail)
      sub.style.display = 'block'
    }

    // Show V-gate status during validation
    if (stage === 'validate') {
      this.modal.querySelector('#vgate-status').style.display = 'block'
    }

    // Show shot progress during shots stage
    if (stage === 'shots') {
      this.modal.querySelector('#shot-progress').style.display = 'block'
    }
  }

  onShotDone(data) {
    const { shotIndex, totalShots, shot } = data
    const pct = Math.round((shotIndex / totalShots) * 100)
    this.modal.querySelector('#shot-progress .shot-progress-fill').style.width = `${pct}%`
    this.modal.querySelector('#shot-current').textContent = shotIndex
    this.modal.querySelector('#shot-total').textContent = totalShots
  }

  onError(data) {
    const { stage, error, recoverable } = data
    this.showError(`${stage}: ${error}`, recoverable)
  }

  onComplete(data) {
    const { planPath, plan } = data
    this.generatedPlan = plan
    this.planPath = planPath
    this.showResult({ planPath, plan })
  }

  // ═══════════════════════════════════════════
  // Result / Error Display
  // ═══════════════════════════════════════════

  showResult({ planPath, plan }) {
    this.showStep(5)

    const shots = plan.shots || []
    const sections = plan.track?.sections || []
    const cast = plan.cast || []
    const repairs = plan.llm?.repairRetries ?? 0

    this.modal.querySelector('#result-summary').innerHTML = `
      <div class="result-row"><strong>Plan:</strong> ${planPath}</div>
      <div class="result-row"><strong>Track:</strong> ${plan.track?.durationSec?.toFixed(1) || '?'}s, ${sections.length} sections, ${shots.length} shots</div>
      <div class="result-row"><strong>Cast:</strong> ${cast.map(c => c.slug).join(', ') || 'none'}</div>
      <div class="result-row"><strong>V-Gate:</strong> Grammar ✓ | Schema ✓ | Repairs: ${repairs}</div>
      <div class="result-row"><strong>Backend:</strong> ${plan.llm?.backend || '?'} / ${plan.llm?.modelId || '?'}</div>
    `

    this.modal.querySelector('#btn-open-folder').style.display = 'inline-flex'
    this.modal.querySelector('#btn-save-plan').style.display = 'inline-flex'

    // Update V-gate display with final results
    this.modal.querySelector('#vgate-grammar').textContent = 'passed'
    this.modal.querySelector('#vgate-grammar').className = 'vgate-value ok'
    this.modal.querySelector('#vgate-schema').textContent = 'passed'
    this.modal.querySelector('#vgate-schema').className = 'vgate-value ok'
    this.modal.querySelector('#vgate-repairs').textContent = repairs
  }

  showError(message, recoverable = false) {
    this.modal.querySelector('#stage-detail .detail-message').textContent = `Error: ${message}`
    this.modal.querySelector('#stage-detail .detail-message').style.color = '#ef4444'
    if (recoverable) {
      this.modal.querySelector('#stage-detail .detail-sub').textContent = 'This error may be recoverable — check settings and retry.'
      this.modal.querySelector('#stage-detail .detail-sub').style.display = 'block'
    }
    this.modal.querySelector('#btn-abort').style.display = 'none'
    this.modal.querySelector('#btn-back').style.display = 'inline-flex'
  }

  async openOutputFolder() {
    if (this.planPath) {
      await ipcRenderer.invoke('shell:openPath', path.dirname(this.planPath))
    }
  }

  async savePlanAs() {
    if (!this.generatedPlan) return
    const result = await ipcRenderer.invoke('dialog:saveFile', {
      title: 'Save plan.json',
      defaultPath: 'plan.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (!result.canceled && result.filePath) {
      const fs = require('fs/promises')
      await fs.writeFile(result.filePath, JSON.stringify(this.generatedPlan, null, 2))
    }
  }

  resetForNew() {
    this.selectedFile = null
    this.outputDir = null
    this.generatedPlan = null
    this.planPath = null
    this.modal.querySelector('#input-file').value = ''
    this.modal.querySelector('#output-dir').value = ''
    this.modal.querySelector('#file-meta').style.display = 'none'
    this.showStep(1)
    this.validateStep1()
  }

  // ═══════════════════════════════════════════
  // V-Gate Status Updates (called from main during validation)
  // ═══════════════════════════════════════════

  updateVGateGrammar(passed) {
    this.modal.querySelector('#vgate-grammar').textContent = passed ? 'passed' : 'failed'
    this.modal.querySelector('#vgate-grammar').className = `vgate-value ${passed ? 'ok' : 'fail'}`
  }

  updateVGateSchema(passed) {
    this.modal.querySelector('#vgate-schema').textContent = passed ? 'passed' : 'failed'
    this.modal.querySelector('#vgate-schema').className = `vgate-value ${passed ? 'ok' : 'fail'}`
  }

  updateVGateRepairs(count) {
    this.modal.querySelector('#vgate-repairs').textContent = count
  }
}

// ═══════════════════════════════════════════
// Expose to renderer via contextBridge
// ═══════════════════════════════════════════

const directorEngine = new DirectorEngine()

contextBridge.exposeInMainWorld('directorEngine', {
  show: () => directorEngine.show(),
  hide: () => directorEngine.hide(),
  updateVGateGrammar: (passed) => directorEngine.updateVGateGrammar(passed),
  updateVGateSchema: (passed) => directorEngine.updateVGateSchema(passed),
  updateVGateRepairs: (count) => directorEngine.updateVGateRepairs(count),
})

// Also expose for direct require in main process tests
module.exports = { DirectorEngine, directorEngine }