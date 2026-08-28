const DB_NAME = 'rack-photo-pwa'
const STORE_NAME = 'projects'
const ACCESS_HASH = '70f2f92eae1c13a821d9f0699d7bc42313c3e588e8c30d5b5cdbe9f02987ba3b'

const gate = document.querySelector('#gate')
const recovery = document.querySelector('#recovery')
const gateStatus = document.querySelector('#gate-status')
const statusBox = document.querySelector('#status')
const progress = document.querySelector('#progress')
const stats = document.querySelector('#stats')
const downloadButton = document.querySelector('#download')
const reportButton = document.querySelector('#report')
const projectSelect = document.querySelector('#project')
const scanButton = document.querySelector('#scan')

let scanResult = null
let workspaceCache = null

function showError(target, message) {
  target.textContent = message
  target.classList.remove('hidden')
  target.classList.add('error')
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function openExistingDb() {
  if (indexedDB.databases) {
    const databases = await indexedDB.databases()
    if (!databases.some(item => item.name === DB_NAME)) {
      throw new Error('此浏览器中没有找到 FAI 照片数据库。请用原来拍照的浏览器或主屏幕 App 打开。')
    }
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME)
    request.onupgradeneeded = () => {
      request.transaction.abort()
      reject(new Error('数据库不存在；已阻止创建空数据库。'))
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('无法打开照片数据库。'))
  })
}

function readWorkspace(db) {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      reject(new Error('数据库中没有 projects 数据表。'))
      return
    }
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const workspaceRequest = store.get('workspace')
    workspaceRequest.onsuccess = () => {
      if (workspaceRequest.result) {
        resolve(workspaceRequest.result)
        return
      }
      const legacyRequest = store.get('active')
      legacyRequest.onsuccess = () => resolve(legacyRequest.result)
      legacyRequest.onerror = () => reject(legacyRequest.error)
    }
    workspaceRequest.onerror = () => reject(workspaceRequest.error)
    tx.onerror = () => reject(tx.error)
  })
}

function workspaceProjects(workspace) {
  return workspace?.projects || (workspace?.project ? [workspace.project] : [])
}

function allCandidates(workspace, projectId) {
  const projects = workspaceProjects(workspace).filter(project => project.id === projectId)
  const items = []
  for (const project of projects) {
    for (const page of project.pages || []) {
      for (const [slotOffset, slot] of (page.slots || []).entries()) {
        const candidates = slot.candidates || []
        const selectedOffset = candidates.findIndex(candidate => candidate.id === slot.selectedCandidateId)
        if (selectedOffset >= 0) {
          const candidate = candidates[selectedOffset]
          items.push({
            project,
            page,
            slot,
            candidate,
            slotIndex: slotOffset + 1,
            candidateIndex: selectedOffset + 1,
          })
        }
        if (!slot.candidates?.length && slot.blob) {
          items.push({
            project,
            page,
            slot,
            candidate: { blob: slot.blob, originalBlob: slot.blob },
            slotIndex: slotOffset + 1,
            candidateIndex: 1,
          })
        }
      }
    }
  }
  return items
}

async function probeBlob(blob) {
  if (!(blob instanceof Blob) || blob.size <= 0) return { readable: false, reason: 'missing' }
  try {
    await blob.slice(0, Math.min(blob.size, 65536)).arrayBuffer()
    return { readable: true, size: blob.size, type: blob.type || 'application/octet-stream' }
  } catch (error) {
    return { readable: false, size: blob.size, type: blob.type || '', reason: error?.message || String(error) }
  }
}

async function scanDatabase() {
  progress.classList.remove('hidden')
  stats.classList.add('hidden')
  downloadButton.classList.add('hidden')
  reportButton.classList.add('hidden')
  statusBox.classList.remove('error')
  statusBox.textContent = '正在以只读方式打开数据库…'

  const workspace = workspaceCache || await loadProjects()
  if (!workspace) throw new Error('数据库存在，但没有找到项目记录。')
  const projectId = projectSelect.value
  if (!projectId) throw new Error('请先选择要恢复的项目。')

  const candidates = allCandidates(workspace, projectId)
  const records = []
  progress.max = Math.max(1, candidates.length * 3)
  progress.value = 0
  for (const item of candidates) {
    const variants = []
    for (const field of ['originalBlob', 'blob', 'thumbnailBlob']) {
      const result = await probeBlob(item.candidate[field])
      variants.push({ field, ...result })
      progress.value += 1
      statusBox.textContent = `正在扫描：第 ${records.length + 1} / ${candidates.length} 个照片候选…`
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    records.push({
      projectName: item.project.name || '',
      projectId: item.project.id || '',
      pageNumber: item.page.number || item.page.outputPageNumber || '',
      pageTitle: item.page.title || '',
      slotIndex: item.slotIndex,
      slotCode: item.slot.code || item.slot.slotCode || '',
      candidateIndex: item.candidateIndex,
      candidateId: item.candidate.id || '',
      selected: item.slot.selectedCandidateId === item.candidate.id,
      variants,
      source: item,
    })
  }

  const readableCandidates = records.filter(record => record.variants.some(variant => variant.readable))
  const readableVariants = records.flatMap(record => record.variants).filter(variant => variant.readable)
  scanResult = { scannedAt: new Date().toISOString(), records, readableCandidates, readableVariants }
  stats.innerHTML = `
    <div class="stat"><strong>${candidates.length}</strong>已选照片</div>
    <div class="stat"><strong>${readableCandidates.length}</strong>至少一个副本可读</div>
    <div class="stat"><strong>${readableVariants.length}</strong>可读副本总数</div>
    <div class="stat"><strong>${candidates.length - readableCandidates.length}</strong>全部副本不可读</div>`
  stats.classList.remove('hidden')
  reportButton.classList.remove('hidden')
  if (readableCandidates.length) downloadButton.classList.remove('hidden')
  statusBox.textContent = readableCandidates.length
    ? `扫描完成：找到 ${readableCandidates.length} 个至少有一个可读副本的照片候选。现在可以下载。`
    : '扫描完成，但当前数据库中的原图、处理图和缩略图副本均无法读取。请保留设备现状并转入系统备份取证。'
}

async function loadProjects() {
  statusBox.classList.remove('error')
  statusBox.textContent = '正在以只读方式读取项目列表…'
  const db = await openExistingDb()
  try {
    workspaceCache = await readWorkspace(db)
  } finally {
    db.close()
  }
  const projects = workspaceProjects(workspaceCache)
  if (!projects.length) throw new Error('数据库存在，但没有找到项目记录。')
  projectSelect.innerHTML = projects.map(project => {
    const name = String(project.name || project.projectId || '未命名项目').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
    return `<option value="${project.id}">${name}</option>`
  }).join('')
  projectSelect.disabled = false
  scanButton.disabled = false
  statusBox.textContent = `已找到 ${projects.length} 个项目。请选择一个项目，再开始扫描。`
  return workspaceCache
}

function safeAscii(value) {
  return String(value || 'photo').normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 42) || 'photo'
}

function extensionFor(type, originalName = '') {
  const known = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'image/webp': 'webp' }
  if (known[type]) return known[type]
  const match = originalName.match(/\.([a-z0-9]{2,5})$/i)
  return match ? match[1].toLowerCase() : 'bin'
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function zipArchive(files) {
  const encoder = new TextEncoder()
  const localParts = []
  const centralParts = []
  let offset = 0
  const now = new Date()
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()
  const write16 = (view, at, value) => view.setUint16(at, value, true)
  const write32 = (view, at, value) => view.setUint32(at, value >>> 0, true)

  for (const file of files) {
    const name = encoder.encode(file.name)
    const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes)
    const checksum = crc32(bytes)
    const local = new Uint8Array(30)
    const localView = new DataView(local.buffer)
    write32(localView, 0, 0x04034b50)
    write16(localView, 4, 20)
    write16(localView, 6, 0x0800)
    write16(localView, 8, 0)
    write16(localView, 10, dosTime)
    write16(localView, 12, dosDate)
    write32(localView, 14, checksum)
    write32(localView, 18, bytes.byteLength)
    write32(localView, 22, bytes.byteLength)
    write16(localView, 26, name.byteLength)
    write16(localView, 28, 0)
    localParts.push(local, name, bytes)

    const central = new Uint8Array(46)
    const centralView = new DataView(central.buffer)
    write32(centralView, 0, 0x02014b50)
    write16(centralView, 4, 20)
    write16(centralView, 6, 20)
    write16(centralView, 8, 0x0800)
    write16(centralView, 10, 0)
    write16(centralView, 12, dosTime)
    write16(centralView, 14, dosDate)
    write32(centralView, 16, checksum)
    write32(centralView, 20, bytes.byteLength)
    write32(centralView, 24, bytes.byteLength)
    write16(centralView, 28, name.byteLength)
    write16(centralView, 30, 0)
    write16(centralView, 32, 0)
    write16(centralView, 34, 0)
    write16(centralView, 36, 0)
    write32(centralView, 38, 0)
    write32(centralView, 42, offset)
    centralParts.push(central, name)
    offset += local.byteLength + name.byteLength + bytes.byteLength
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  write32(endView, 0, 0x06054b50)
  write16(endView, 4, 0)
  write16(endView, 6, 0)
  write16(endView, 8, files.length)
  write16(endView, 10, files.length)
  write32(endView, 12, centralSize)
  write32(endView, 16, offset)
  write16(endView, 20, 0)
  return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' })
}

function archiveManifest(project) {
  const pages = (project.pages || []).map(page => ({ ...page, slots: (page.slots || []).map(slot => ({ ...slot,
    candidates: (slot.candidates || []).map(({ blob, originalBlob, thumbnailBlob, previewUrl, ...candidate }) => candidate),
  })) }))
  const slots = pages.flatMap(page => page.slots || [])
  const captured = slots.filter(slot => slot.status !== 'skipped' && slot.candidates?.some(candidate => candidate.id === slot.selectedCandidateId)).length
  const skipped = slots.filter(slot => slot.status === 'skipped').length
  return {
    version: 4,
    id: project.id,
    name: project.name,
    workflow: project.workflow,
    projectId: project.projectId,
    rackId: project.rackId,
    templateVersion: project.templateVersion,
    createdAt: project.createdAt,
    exportedAt: new Date().toISOString(),
    storageMode: 'offline-local-recovery-zip',
    projectComplete: slots.length > 0 && slots.length === captured + skipped,
    progress: { captured, skipped, pending: slots.length - captured - skipped, projectComplete: slots.length > 0 && slots.length === captured + skipped },
    pages,
  }
}

async function downloadRecovered() {
  if (!scanResult) return
  downloadButton.disabled = true
  reportButton.disabled = true
  progress.classList.remove('hidden')
  progress.max = Math.max(1, scanResult.readableCandidates.length)
  progress.value = 0
  const files = []
  const recoveryReport = []
  let recovered = 0

  for (const record of scanResult.readableCandidates) {
    const priority = ['blob', 'originalBlob', 'thumbnailBlob']
    let chosen = null
    let buffer = null
    let lastError = ''
    for (const field of priority) {
      const variant = record.variants.find(item => item.field === field && item.readable)
      const blob = record.source.candidate[field]
      if (!variant || !(blob instanceof Blob)) continue
      try {
        buffer = await blob.arrayBuffer()
        chosen = { field, blob }
        break
      } catch (error) {
        lastError = error?.message || String(error)
      }
    }

    if (chosen && buffer) {
      const page = String(record.pageNumber || 0).padStart(2, '0')
      const slot = String(record.slotIndex).padStart(2, '0')
      const ext = extensionFor(chosen.blob.type, record.source.candidate.originalName || record.source.candidate.name || '')
      const name = `02-Report-Photos/page-${page}_slot-${slot}_${safeAscii(record.slotCode)}.${ext}`
      files.push({ name, bytes: new Uint8Array(buffer) })
      recovered += 1
      recoveryReport.push({ ...record, source: undefined, exported: true, exportedVariant: chosen.field, exportedBytes: buffer.byteLength, fileName: name })
    } else {
      recoveryReport.push({ ...record, source: undefined, exported: false, exportError: lastError || 'all readable probes failed during full read' })
    }
    progress.value += 1
    statusBox.textContent = `正在完整读取并打包：${progress.value} / ${progress.max}…`
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  const mapHeaders = ['projectName', 'pageNumber', 'pageTitle', 'slotIndex', 'slotCode', 'candidateIndex', 'selected', 'exportedVariant', 'exportedBytes', 'fileName']
  const mapRows = recoveryReport.map(record => mapHeaders.map(key => String(record[key] ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t'))
  const mapBytes = new TextEncoder().encode(`\uFEFF${[mapHeaders.join('\t'), ...mapRows].join('\r\n')}\r\n`)
  files.push({ name: '03-Project-Package/recovery-map.tsv', bytes: mapBytes })

  const readmeBytes = new TextEncoder().encode('Only the selected photo for each slot/point is included. Recovered photos are ordered by page and slot/point. See recovery-map.tsv for the original project, page title, point code, selected candidate number, and recovered variant.\r\n')
  files.push({ name: 'README.txt', bytes: readmeBytes })

  const reportBytes = new TextEncoder().encode(JSON.stringify({ scannedAt: scanResult.scannedAt, exportedAt: new Date().toISOString(), recovered, records: recoveryReport }, null, 2))
  files.push({ name: '03-Project-Package/recovery-report.json', bytes: reportBytes })
  const project = scanResult.readableCandidates[0]?.source.project
  if (!project) throw new Error('找不到所选项目的项目结构。')
  const manifestBytes = new TextEncoder().encode(JSON.stringify(archiveManifest(project), null, 2))
  files.push({ name: '03-Project-Package/manifest.json', bytes: manifestBytes })

  const archive = zipArchive(files)
  if (['127.0.0.1', 'localhost'].includes(location.hostname)) window.__recoveryArchive = archive
  triggerDownload(archive, `${safeAscii(project.name || 'FAI-project')}_recovered-powerpoint-import.zip`)
  statusBox.textContent = `PowerPoint 恢复 ZIP 已生成：成功完整读取 ${recovered} 张已选照片。请等待系统下载或分享窗口出现。`
  downloadButton.disabled = false
  reportButton.disabled = false
}

function publicReport() {
  return {
    scannedAt: scanResult?.scannedAt,
    records: (scanResult?.records || []).map(({ source, ...record }) => record),
  }
}

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60000)
}

document.querySelector('#unlock').addEventListener('click', async () => {
  gateStatus.classList.add('hidden')
  gateStatus.classList.remove('error')
  try {
    const value = document.querySelector('#code').value
    if (!value || await sha256(value) !== ACCESS_HASH) throw new Error('访问码不正确。')
    sessionStorage.setItem('fai-rack-access-unlocked', 'true')
    gate.classList.add('hidden')
    recovery.classList.remove('hidden')
  } catch (error) {
    showError(gateStatus, error?.message || String(error))
  }
})

document.querySelector('#load-projects').addEventListener('click', async event => {
  const button = event.currentTarget
  button.disabled = true
  try {
    await loadProjects()
  } catch (error) {
    showError(statusBox, error?.message || String(error))
  } finally {
    button.disabled = false
  }
})

scanButton.addEventListener('click', async event => {
  const button = event.currentTarget
  button.disabled = true
  try {
    await scanDatabase()
  } catch (error) {
    showError(statusBox, error?.message || String(error))
  } finally {
    button.disabled = false
  }
})

downloadButton.addEventListener('click', () => downloadRecovered().catch(error => {
  showError(statusBox, `恢复包生成失败：${error?.message || String(error)}`)
  downloadButton.disabled = false
  reportButton.disabled = false
}))

reportButton.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(publicReport(), null, 2)], { type: 'application/json' })
  triggerDownload(blob, `FAI-photo-recovery-report-${new Date().toISOString().slice(0, 10)}.json`)
})

if (sessionStorage.getItem('fai-rack-access-unlocked') === 'true' || ['127.0.0.1', 'localhost'].includes(location.hostname)) {
  gate.classList.add('hidden')
  recovery.classList.remove('hidden')
}
