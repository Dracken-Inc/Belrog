/**
 * Music Video IPC Handlers — thin registration layer
 *
 * Every handler here is a one-line delegation to the canonical pipeline at
 * src/services/musicVideoPipeline.js. This file exists so the static IPC
 * channel contract test (tests/ipcChannelContract.test.mjs) can find every
 * ipcMain.handle('music-video:*'…) registration inside electron/ without
 * duplicating any business logic.
 *
 * Do NOT implement pipeline logic here — put it in musicVideoPipeline.js.
 */
import { ipcMain } from 'electron'
import {
  runMusicVideoPipeline,
  resumeAndRender,
  loadProjectState,
  listProjects,
  deleteProject,
  cancelAllPendingShots,
  requestCancel,
  clearCancelFlags,
} from '../src/services/musicVideoPipeline.js'

/**
 * Register all music-video IPC handlers against the given BrowserWindow.
 * @param {import('electron').BrowserWindow | null} win
 */
export function registerMusicVideoIpcHandlers(win) {
  let currentSongId = null

  // Start a new music-video project from an audio file (m4a/mp3/wav…)
  ipcMain.handle('music-video:start', async (_event, { audioFilePath, options = {} } = {}) => {
    if (!win || win.isDestroyed()) return { ok: false, error: 'No Belrog window available.' }
    if (!audioFilePath || typeof audioFilePath !== 'string') return { ok: false, error: 'audioFilePath is required.' }
    try {
      const result = await runMusicVideoPipeline({ filePath: audioFilePath, win, options })
      currentSongId = result.songId ?? currentSongId
      return { ok: true, ...result }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  })

  // Resume an existing project from its saved state
  ipcMain.handle('music-video:resume', async (_event, { songId } = {}) => {
    if (!win || win.isDestroyed()) return { ok: false, error: 'No Belrog window available.' }
    const targetSongId = songId || currentSongId
    if (!targetSongId) return { ok: false, error: 'songId is required.' }
    try {
      const result = await resumeAndRender({ songId: targetSongId, win })
      currentSongId = targetSongId
      return { ok: true, ...result }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  })

  // Pause — the flag is what stops the loop between clips; the on-disk status
  // is what the UI shows. Setting one without the other leaves a render running
  // that the user believes they stopped.
  ipcMain.handle('music-video:pause', async () => {
    if (!currentSongId) return { ok: false, error: 'No active project.' }
    try {
      const { updateProjectState, PROJECT_STATUS } = await import('../src/services/musicVideoPipeline.js')
      requestCancel(currentSongId, true)
      await updateProjectState(currentSongId, { status: PROJECT_STATUS.CANCELLED })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  })

  // Resume after pause (same as resume)
  ipcMain.handle('music-video:resume-pipeline', async () => {
    if (!currentSongId) return { ok: false, error: 'No active project.' }
    try {
      const { updateProjectState, PROJECT_STATUS } = await import('../src/services/musicVideoPipeline.js')
      clearCancelFlags()
      await updateProjectState(currentSongId, { status: PROJECT_STATUS.RENDERING })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  })

  // Cancel the active project
  ipcMain.handle('music-video:cancel', async (_event, { songId } = {}) => {
    const targetSongId = songId || currentSongId
    if (!targetSongId) return { ok: false, error: 'songId is required.' }
    try {
      requestCancel(targetSongId, true)
      await cancelAllPendingShots(targetSongId)
      win?.webContents.send('mv:cancelled', { songId: targetSongId })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  })

  // Return the current project state for UI polling
  ipcMain.handle('music-video:get-state', async (_event, { songId } = {}) => {
    const targetSongId = songId || currentSongId
    if (!targetSongId) return { ok: false, error: 'songId is required.' }
    const state = await loadProjectState(targetSongId)
    return { ok: true, state }
  })

  // List all saved music-video projects
  ipcMain.handle('music-video:list-projects', async () => {
    const projects = await listProjects()
    return { ok: true, projects }
  })

  // Delete a saved project
  ipcMain.handle('music-video:delete-project', async (_event, { songId } = {}) => {
    if (!songId || typeof songId !== 'string') return { ok: false, error: 'songId is required.' }
    try {
      await deleteProject(songId)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  })

  // Dry-run: generate plan.json without rendering (for testing/preview)
  ipcMain.handle('music-video:dry-run', async (_event, { audioFilePath, options = {} } = {}) => {
    if (!win || win.isDestroyed()) return { ok: false, error: 'No Belrog window available.' }
    if (!audioFilePath || typeof audioFilePath !== 'string') return { ok: false, error: 'audioFilePath is required.' }
    try {
      const result = await runMusicVideoPipeline({ filePath: audioFilePath, win, options: { ...options, dryRun: true } })
      currentSongId = result.songId ?? currentSongId
      return { ok: true, ...result }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  })

  // File picker for the audio source
  ipcMain.handle('music-video:pickAudioFile', async () => {
    if (!win || win.isDestroyed()) return { ok: false, error: 'No Belrog window available.' }
    const { dialog } = await import('electron')
    try {
      const result = await dialog.showOpenDialog(win, {
        title: 'Choose the song file',
        properties: ['openFile'],
        filters: [
          { name: 'Audio', extensions: ['m4a', 'mp3', 'wav', 'flac', 'aac', 'ogg', 'opus'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      })
      if (result.canceled || !result.filePaths?.length) return { ok: true, filePath: null }
      return { ok: true, filePath: result.filePaths[0] }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  })
}