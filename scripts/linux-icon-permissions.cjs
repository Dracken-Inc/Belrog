const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

// Public application artwork must remain readable after installation as root.
// Do not change the process umask or permissions on any other build inputs.
function linuxIconFiles(projectRoot) {
  const directory = path.join(projectRoot, 'build', 'icons')
  if (!fs.lstatSync(directory).isDirectory()) throw new Error('Linux icons must be a real directory')
  const files = fs.readdirSync(directory).filter(name => /^\d+x\d+\.png$/.test(name)).sort()
  if (!files.length) throw new Error('No Linux PNG icons found')
  for (const name of files) {
    const stat = fs.lstatSync(path.join(directory, name))
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Linux icon must be a regular, unlinked file: ${name}`)
  }
  return { directory, files }
}

function prepareLinuxIcons(projectRoot, platform) {
  if (platform !== 'linux') return []
  const { directory, files } = linuxIconFiles(projectRoot)
  fs.chmodSync(directory, 0o755)
  for (const name of files) fs.chmodSync(path.join(directory, name), 0o644)
  return files
}

// The installed basename comes from the packaged executable name, so it is not a fixed string:
// an upstream build installs velorn.{png,desktop} and this fork installs belrog.{png,desktop}.
// Match any basename and assert the invariants that actually matter - exactly one launcher,
// one icon basename, every icon readable, and the inventory matching what was prepared.
function verifyDebIconListing(listing, expectedFiles) {
  const found = []
  const iconNames = new Set()
  const launcherNames = new Set()
  for (const line of listing.split('\n')) {
    const icon = line.match(/\s\.\/usr\/share\/icons\/hicolor\/(\d+x\d+)\/apps\/([^/]+)\.png$/)
    const desktop = line.match(/\s\.\/usr\/share\/applications\/([^/]+)\.desktop$/)
    if (!icon && !desktop) continue
    const mode = line.split(/\s+/)[0]
    if (mode[0] !== '-' || mode[1] !== 'r' || mode[4] !== 'r' || mode[7] !== 'r') {
      throw new Error(`Linux installer contains an unreadable icon/launcher: ${line.trim()}`)
    }
    if (icon) { iconNames.add(icon[2]); found.push(`${icon[1]}.png`) }
    if (desktop) launcherNames.add(desktop[1])
  }
  if (!launcherNames.size) throw new Error('Linux installer is missing the desktop launcher')
  if (launcherNames.size > 1) {
    throw new Error(`Linux installer contains more than one desktop launcher: ${[...launcherNames].sort().join(', ')}`)
  }
  if (iconNames.size > 1) {
    throw new Error(`Linux installer icons are not all named for one executable: ${[...iconNames].sort().join(', ')}`)
  }
  if (!found.length || JSON.stringify(found.sort()) !== JSON.stringify([...expectedFiles].sort())) {
    throw new Error('Linux installer icon inventory does not match the prepared icons')
  }
  return found
}

function verifyDebIcons(file, expectedFiles) {
  const listing = execFileSync('dpkg-deb', ['--contents', file], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
  })
  return verifyDebIconListing(listing, expectedFiles)
}

module.exports = { linuxIconFiles, prepareLinuxIcons, verifyDebIconListing, verifyDebIcons }
