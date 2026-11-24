// Things made in Visuals and Sound are filed in their own folder in the Assets panel.
import test from 'node:test'
import assert from 'node:assert/strict'
import { GENERATED_FOLDERS, generatedFolderId } from '../src/services/generatedFolders.mjs'

function assets(folders = []) {
  const state = { folders: [...folders], assets: [], made: 0 }
  state.addFolder = folder => { const created = { id: `folder-${++state.made + 100}`, name: folder.name, parentId: folder.parentId || null }; state.folders.push(created); return created }
  state.addAsset = asset => { const made = { id: `asset-${state.assets.length + 1}`, ...asset }; state.assets.push(made); return made }
  return state
}

test('a folder is made the first time, found after that, and only at the top level', () => {
  assert.deepEqual(GENERATED_FOLDERS, { visuals: 'Visuals', sound: 'Sound' })
  const state = assets([{ id: 'folder-1', name: 'Visuals', parentId: 'folder-9' }])
  const first = generatedFolderId(state, 'Visuals')
  assert.equal(first, 'folder-101') // The one inside another folder is somebody's own; a top-level one is made.
  assert.equal(generatedFolderId(state, 'Visuals'), first)
  assert.equal(state.folders.filter(folder => folder.name === 'Visuals' && !folder.parentId).length, 1)
  assert.notEqual(generatedFolderId(state, 'Sound'), first)
  // Nothing to file into: the result simply stays at the top, as before.
  for (const broken of [null, {}, { folders: [], addFolder: () => { throw new Error('no') } }, { folders: [], addFolder: () => null }]) assert.equal(generatedFolderId(broken, 'Visuals'), null)
  assert.equal(generatedFolderId(state, ''), null)
})
