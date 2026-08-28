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
const deepScanButton = document.querySelector('#deep-scan')

let scanResult = null
let deepResult = null
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
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME)
    const timer = window.setTimeout(() => reject(new Error('打开数据库超过 15 秒。请保持 HOME APP 在前台后重试。')), 15000)
    request.onupgradeneeded = () => {
      request.transaction.abort()
      window.clearTimeout(timer)
      reject(new Error('数据库不存在；已阻止创建空数据库。'))
    }
    request.onsuccess = () => {
      window.clearTimeout(timer)
      resolve(request.result)
    }
    request.onerror = () => {
      window.clearTimeout(timer)
      reject(request.error || new Error('无法打开照片数据库。'))
    }
  })
}

function readRecord(db, key, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      reject(new Error('数据库中没有 projects 数据表。'))
      return
    }
    const tx = db.transaction(STORE_NAME, 'readonly')
    const timer = window.setTimeout(() => {
      try { tx.abort() } catch {}
      reject(new Error(`读取 ${key} 记录超时。`))
    }, timeoutMs)
    const store = tx.objectStore(STORE_NAME)
    const request = store.get(key)
    request.onsuccess = () => { window.clearTimeout(timer); resolve(request.result) }
    request.onerror = () => { window.clearTimeout(timer); reject(request.error) }
    tx.onerror = () => { window.clearTimeout(timer); reject(tx.error) }
  })
}

async function readWorkspace(db) {
  statusBox.textContent = '正在先尝试较小的旧项目记录，请保持 PWA 在前台…'
  try {
    const active = await readRecord(db, 'active', 30000)
    if (active && workspaceProjects(active).length) return active
  } catch {}
  statusBox.textContent = '未找到可用的旧项目记录；正在读取大型 workspace（约 480 MB 照片引用），最多等待 3 分钟…'
  try {
    return await readRecord(db, 'workspace', 180000)
  } catch {
    throw new Error('旧 active 记录不可用，workspace 记录也超过 3 分钟。浏览器内只读恢复路径已用尽。')
  }
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

function allProjectCandidates(workspace, projectId) {
  const projects = workspaceProjects(workspace).filter(project => project.id === projectId)
  const items = []
  for (const project of projects) {
    for (const page of project.pages || []) {
      for (const [slotOffset, slot] of (page.slots || []).entries()) {
        for (const [candidateOffset, candidate] of (slot.candidates || []).entries()) {
          items.push({
            project,
            page,
            slot,
            candidate,
            slotIndex: slotOffset + 1,
            candidateIndex: candidateOffset + 1,
          })
        }
        if (!slot.candidates?.length && slot.blob) {
          items.push({
            project,
            page,
            slot,
            candidate: { id: `${page.id || page.number}-${slot.id || slotOffset}-legacy`, blob: slot.blob, originalBlob: slot.blob },
            slotIndex: slotOffset + 1,
            candidateIndex: 1,
          })
        }
      }
    }
  }
  return items
}

function candidateKey(item) {
  return [item.project.id || '', item.page.id || item.page.number || '', item.slot.id || item.slotIndex || '', item.candidate.id || item.candidateIndex || ''].join('::')
}

function withTimeout(promise, milliseconds, message) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), milliseconds)
    promise.then(value => {
      window.clearTimeout(timer)
      resolve(value)
    }, error => {
      window.clearTimeout(timer)
      reject(error)
    })
  })
}

function fileReaderBuffer(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
    reader.onabort = () => reject(new Error('FileReader aborted'))
    reader.readAsArrayBuffer(blob)
  })
}

function decodedImageBuffer(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const image = new Image()
    const finish = () => URL.revokeObjectURL(url)
    image.onerror = () => {
      finish()
      reject(new Error('Image decoder could not open the local object'))
    }
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Canvas decoder unavailable')
        context.drawImage(image, 0, 0)
        canvas.toBlob(async recovered => {
          finish()
          if (!recovered) return reject(new Error('Image decoder produced no bytes'))
          try {
            resolve(await recovered.arrayBuffer())
          } catch (error) {
            reject(error)
          }
        }, blob.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.95)
      } catch (error) {
        finish()
        reject(error)
      }
    }
    image.src = url
  })
}

async function recoverBlobBuffer(blob, field, preferredMethod = '', expectedBytes = 0) {
  const methods = [
    ['direct', () => blob.arrayBuffer()],
    ['fileReader', () => fileReaderBuffer(blob)],
  ]
  if (!expectedBytes && field !== 'originalBlob') methods.push(['imageDecoder', () => decodedImageBuffer(blob)])
  if (preferredMethod) methods.sort(([name]) => name === preferredMethod ? -1 : 1)
  const errors = []
  for (const [method, read] of methods) {
    try {
      const buffer = await withTimeout(Promise.resolve().then(read), 10000, `${method} timed out`)
      if (buffer?.byteLength > 0) {
        if (expectedBytes && buffer.byteLength !== expectedBytes) {
          errors.push(`${method}: actual ${buffer.byteLength} bytes, expected ${expectedBytes}`)
          continue
        }
        return { buffer, method }
      }
    } catch (error) {
      errors.push(`${method}: ${error?.message || String(error)}`)
    }
  }
  throw new Error(errors.join(' | ') || 'no readable bytes')
}

async function readRawBlob(blob) {
  if (!(blob instanceof Blob) || blob.size <= 0) throw new Error('missing blob')
  const methods = [
    ['direct', () => blob.arrayBuffer()],
    ['fileReader', () => fileReaderBuffer(blob)],
  ]
  const errors = []
  for (const [method, read] of methods) {
    try {
      const buffer = await withTimeout(Promise.resolve().then(read), 15000, `${method} timed out`)
      if (buffer?.byteLength > 0) return { buffer, method }
    } catch (error) {
      errors.push(`${method}: ${error?.message || String(error)}`)
    }
  }
  throw new Error(errors.join(' | ') || 'no readable bytes')
}

async function probeBlob(blob, field, expectedBytes = 0) {
  if (!(blob instanceof Blob) || blob.size <= 0) return { readable: false, reason: 'missing' }
  try {
    const recovered = await recoverBlobBuffer(blob, field, '', expectedBytes)
    return { readable: true, method: recovered.method, size: blob.size, actualBytes: recovered.buffer.byteLength, type: blob.type || 'application/octet-stream' }
  } catch (error) {
    return { readable: false, size: blob.size, actualBytes: 0, type: blob.type || '', reason: error?.message || String(error) }
  }
}

function expectedSize(candidate, field) {
  if (field === 'blob') return Number(candidate.compressedBytes || candidate.bytes || 0)
  if (field === 'originalBlob') return Number(candidate.originalBytes || 0)
  return 0
}

function canvasBlob(canvas, type = 'image/jpeg', quality = 0.9) {
  return new Promise((resolve, reject) => canvas.toBlob(
    blob => blob ? resolve(blob) : reject(new Error('Canvas produced no image bytes')),
    type,
    quality,
  ))
}

async function rebuildProcessedFromOriginal(originalBlob, candidate, preferredMethod = '') {
  const recovered = await recoverBlobBuffer(originalBlob, 'originalBlob', preferredMethod, Number(candidate.originalBytes || 0))
  const stableBlob = new Blob([recovered.buffer], { type: originalBlob.type || 'image/jpeg' })
  const url = URL.createObjectURL(stableBlob)
  try {
    const image = await withTimeout(new Promise((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('Original image decoder failed'))
      element.src = url
    }), 15000, 'Original image decoder timed out')
    const crop = candidate.crop || { x: 0, y: 0, width: 1, height: 1 }
    const sx = Math.max(0, Math.round(crop.x * image.naturalWidth))
    const sy = Math.max(0, Math.round(crop.y * image.naturalHeight))
    const sw = Math.max(1, Math.min(image.naturalWidth - sx, Math.round(crop.width * image.naturalWidth)))
    const sh = Math.max(1, Math.min(image.naturalHeight - sy, Math.round(crop.height * image.naturalHeight)))
    const width = Math.max(1, Number(candidate.width) || sw)
    const height = Math.max(1, Number(candidate.height) || sh)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas unavailable for crop reconstruction')
    context.drawImage(image, sx, sy, sw, sh, 0, 0, width, height)
    const rebuilt = await canvasBlob(canvas, 'image/jpeg', 0.9)
    return { buffer: await rebuilt.arrayBuffer(), blob: rebuilt }
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function scanDatabase() {
  deepResult = null
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
    for (const field of ['blob', 'originalBlob', 'thumbnailBlob']) {
      const expected = expectedSize(item.candidate, field)
      const result = await probeBlob(item.candidate[field], field, expected)
      variants.push({ field, expectedSize: expected, sizeMatches: Boolean(expected && result.actualBytes === expected), ...result })
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
  const safeCandidates = records.filter(record => record.variants.some(variant => variant.readable && variant.sizeMatches && ['blob', 'originalBlob'].includes(variant.field)))
  scanResult = { scannedAt: new Date().toISOString(), records, readableCandidates, readableVariants, safeCandidates }
  stats.innerHTML = `
    <div class="stat"><strong>${candidates.length}</strong>已选照片</div>
    <div class="stat"><strong>${readableCandidates.length}</strong>至少一个副本可读</div>
    <div class="stat"><strong>${readableVariants.length}</strong>可读副本总数</div>
    <div class="stat"><strong>${safeCandidates.length}</strong>可验证或从原图重建</div>
    <div class="stat"><strong>${candidates.length - readableCandidates.length}</strong>全部副本不可读</div>`
  stats.classList.remove('hidden')
  reportButton.classList.remove('hidden')
  if (safeCandidates.length === candidates.length && candidates.length) downloadButton.classList.remove('hidden')
  statusBox.textContent = safeCandidates.length
    ? `扫描完成：${safeCandidates.length} / ${candidates.length} 张可用尺寸吻合的处理图或从原图重建。${safeCandidates.length === candidates.length ? '可以生成恢复 ZIP。' : '数量不足，已阻止生成不完整 ZIP。'}`
    : '扫描完成，但当前数据库中的原图、处理图和缩略图副本均无法读取。请保留设备现状并转入系统备份取证。'
}

async function deepScanCandidatePool() {
  progress.classList.remove('hidden')
  stats.classList.add('hidden')
  downloadButton.classList.add('hidden')
  reportButton.classList.add('hidden')
  statusBox.classList.remove('error')
  statusBox.textContent = '正在准备候选照片深度匹配…'

  const workspace = workspaceCache || await loadProjects()
  if (!workspace) throw new Error('数据库存在，但没有找到项目记录。')
  const projectId = projectSelect.value
  if (!projectId) throw new Error('请先选择要恢复的项目。')

  const targets = allCandidates(workspace, projectId)
  const pool = allProjectCandidates(workspace, projectId)
  if (!targets.length) throw new Error('所选项目没有已选照片。')
  if (!pool.length) throw new Error('所选项目没有可扫描的候选照片。')

  const byProcessedSize = new Map()
  const byOriginalSize = new Map()
  for (const target of targets) {
    const processedBytes = expectedSize(target.candidate, 'blob')
    const originalBytes = expectedSize(target.candidate, 'originalBlob')
    if (!processedBytes || !originalBytes) continue
    const entry = { target, key: candidateKey(target), processedBytes, originalBytes }
    const list = byProcessedSize.get(processedBytes) || []
    list.push(entry)
    byProcessedSize.set(processedBytes, list)
    const originalList = byOriginalSize.get(originalBytes) || []
    originalList.push(entry)
    byOriginalSize.set(originalBytes, originalList)
  }

  const pairCounts = new Map()
  for (const list of byProcessedSize.values()) {
    for (const entry of list) {
      const pair = `${entry.processedBytes}:${entry.originalBytes}`
      pairCounts.set(pair, (pairCounts.get(pair) || 0) + 1)
    }
  }
  const ambiguousPairs = [...pairCounts.values()].filter(count => count > 1).length
  if (ambiguousPairs) throw new Error(`发现 ${ambiguousPairs} 组重复的原图/处理图尺寸组合，已停止以避免错配。`)

  const matches = new Map()
  const sourceDiagnostics = []
  progress.max = Math.max(1, pool.length)
  progress.value = 0

  for (const source of pool) {
    const diagnostic = {
      pageNumber: source.page.number || source.page.outputPageNumber || '',
      slotIndex: source.slotIndex,
      slotCode: source.slot.code || source.slot.slotCode || '',
      candidateIndex: source.candidateIndex,
      candidateId: source.candidate.id || '',
      selected: source.slot.selectedCandidateId === source.candidate.id,
      processedActualBytes: 0,
      originalActualBytes: 0,
      matchedTarget: '',
      matchMode: '',
      error: '',
    }
    let processed = null
    let original = null
    const readErrors = []
    try {
      processed = await readRawBlob(source.candidate.blob)
      diagnostic.processedActualBytes = processed.buffer.byteLength
    } catch (error) {
      readErrors.push(`processed: ${error?.message || String(error)}`)
    }
    try {
      original = await readRawBlob(source.candidate.originalBlob)
      diagnostic.originalActualBytes = original.buffer.byteLength
    } catch (error) {
      readErrors.push(`original: ${error?.message || String(error)}`)
    }

    const processedTargets = processed
      ? (byProcessedSize.get(processed.buffer.byteLength) || []).filter(entry => !matches.has(entry.key))
      : []
    const originalTargets = original
      ? (byOriginalSize.get(original.buffer.byteLength) || []).filter(entry => !matches.has(entry.key))
      : []
    const paired = original ? processedTargets.filter(entry => entry.originalBytes === original.buffer.byteLength) : []
    const originalOnly = originalTargets.length === 1 ? originalTargets[0] : null
    const processedOnly = processedTargets.length === 1 ? processedTargets[0] : null
    const match = paired.length === 1 ? paired[0] : (originalOnly || processedOnly)
    if (match) {
      const dualMatch = paired.length === 1
      const originalMatch = Boolean(original && (dualMatch || match.originalBytes === original.buffer.byteLength))
      const exactProcessed = Boolean(processed && (dualMatch || processedOnly === match))
      matches.set(match.key, {
        target: match.target,
        source,
        mode: exactProcessed ? 'exact-processed' : 'rebuild-from-original',
        processedBuffer: exactProcessed ? processed.buffer : null,
        processedMethod: processed?.method || '',
        originalMethod: original?.method || '',
        processedActualBytes: processed?.buffer.byteLength || 0,
        originalActualBytes: original?.buffer.byteLength || 0,
        originalMatched: originalMatch,
      })
      diagnostic.matchedTarget = match.key
      diagnostic.matchMode = dualMatch ? 'processed+original' : (originalMatch ? 'original-only' : 'processed-only')
    } else if (paired.length > 1) {
      readErrors.push('ambiguous byte-length pair')
    }
    diagnostic.error = readErrors.join(' | ')
    sourceDiagnostics.push(diagnostic)
    progress.value += 1
    statusBox.textContent = `正在扫描全部候选：${progress.value} / ${progress.max}；已精确匹配 ${matches.size} / ${targets.length} 张…`
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  const unresolved = targets.filter(target => !matches.has(candidateKey(target)))
  deepResult = {
    scannedAt: new Date().toISOString(),
    project: targets[0]?.project,
    targets,
    poolCount: pool.length,
    matches,
    unresolved,
    sourceDiagnostics,
  }
  scanResult = null
  stats.innerHTML = `
    <div class="stat"><strong>${targets.length}</strong>已选照片</div>
    <div class="stat"><strong>${pool.length}</strong>全部候选照片</div>
    <div class="stat"><strong>${matches.size}</strong>可精确导出或由原图重建</div>
    <div class="stat"><strong>${unresolved.length}</strong>仍未匹配</div>`
  stats.classList.remove('hidden')
  reportButton.classList.remove('hidden')
  if (!unresolved.length) downloadButton.classList.remove('hidden')
  statusBox.textContent = unresolved.length
    ? `深度扫描完成：精确找回 ${matches.size} / ${targets.length} 张；仍缺 ${unresolved.length} 张，已阻止生成不完整 ZIP。请下载诊断清单。`
    : `深度扫描完成：${targets.length} 张全部找到可验证的处理图或唯一原图。可以生成 PowerPoint 恢复 ZIP。`
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
  deepScanButton.disabled = false
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
  if (deepResult) return downloadDeepRecovered()
  if (!scanResult) return
  downloadButton.disabled = true
  reportButton.disabled = true
  progress.classList.remove('hidden')
  progress.max = Math.max(1, scanResult.safeCandidates.length)
  progress.value = 0
  const files = []
  const recoveryReport = []
  let recovered = 0

  for (const record of scanResult.safeCandidates) {
    let chosen = null
    let buffer = null
    let lastError = ''
    const candidate = record.source.candidate
    const processedVariant = record.variants.find(item => item.field === 'blob' && item.readable && item.sizeMatches)
    if (processedVariant && candidate.blob instanceof Blob) {
      try {
        const recovered = await recoverBlobBuffer(candidate.blob, 'blob', processedVariant.method, expectedSize(candidate, 'blob'))
        buffer = recovered.buffer
        chosen = { field: 'blob-verified', blob: candidate.blob }
      } catch (error) {
        lastError = error?.message || String(error)
      }
    }

    if (!chosen) {
      const originalVariant = record.variants.find(item => item.field === 'originalBlob' && item.readable && item.sizeMatches)
      if (originalVariant && candidate.originalBlob instanceof Blob) {
        try {
          const rebuilt = await rebuildProcessedFromOriginal(candidate.originalBlob, candidate, originalVariant.method)
          buffer = rebuilt.buffer
          chosen = { field: 'reconstructed-from-original', blob: rebuilt.blob }
        } catch (error) {
          lastError = error?.message || String(error)
        }
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
  const project = scanResult.safeCandidates[0]?.source.project
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

async function downloadDeepRecovered() {
  if (!deepResult || deepResult.unresolved.length) throw new Error('深度匹配尚未找齐全部已选照片。')
  downloadButton.disabled = true
  reportButton.disabled = true
  progress.classList.remove('hidden')
  progress.max = deepResult.targets.length
  progress.value = 0
  const files = []
  const recoveryReport = []

  for (const target of deepResult.targets) {
    const match = deepResult.matches.get(candidateKey(target))
    if (!match) throw new Error(`缺少第 ${target.page.number || ''} 页第 ${target.slotIndex} 个位置的照片。`)
    let outputBuffer = match.processedBuffer
    let exportedVariant = 'exact-existing-processed'
    if (!outputBuffer && match.mode === 'rebuild-from-original') {
      const rebuilt = await rebuildProcessedFromOriginal(match.source.candidate.originalBlob, target.candidate, match.originalMethod)
      outputBuffer = rebuilt.buffer
      exportedVariant = 'rebuilt-from-uniquely-matched-original'
    }
    if (!outputBuffer) throw new Error(`第 ${target.page.number || ''} 页第 ${target.slotIndex} 个位置无法生成处理图。`)
    const page = String(target.page.number || target.page.outputPageNumber || 0).padStart(2, '0')
    const slot = String(target.slotIndex).padStart(2, '0')
    const type = match.source.candidate.blob?.type || target.candidate.blob?.type || 'image/jpeg'
    const ext = extensionFor(type, target.candidate.originalName || target.candidate.name || '')
    const name = `02-Report-Photos/page-${page}_slot-${slot}_${safeAscii(target.slot.code || target.slot.slotCode || '')}.${ext}`
    files.push({ name, bytes: new Uint8Array(outputBuffer) })
    recoveryReport.push({
      projectName: target.project.name || '',
      pageNumber: target.page.number || target.page.outputPageNumber || '',
      pageTitle: target.page.title || '',
      slotIndex: target.slotIndex,
      slotCode: target.slot.code || target.slot.slotCode || '',
      selectedCandidateIndex: target.candidateIndex,
      selectedCandidateId: target.candidate.id || '',
      sourcePageNumber: match.source.page.number || match.source.page.outputPageNumber || '',
      sourceSlotIndex: match.source.slotIndex,
      sourceCandidateIndex: match.source.candidateIndex,
      sourceCandidateId: match.source.candidate.id || '',
      processedActualBytes: match.processedActualBytes,
      originalActualBytes: match.originalActualBytes,
      exportedVariant,
      exportedBytes: outputBuffer.byteLength,
      crop: target.candidate.crop || null,
      width: target.candidate.width || null,
      height: target.candidate.height || null,
      fileName: name,
    })
    progress.value += 1
    statusBox.textContent = `正在打包精确匹配照片：${progress.value} / ${progress.max}…`
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  const mapHeaders = ['projectName', 'pageNumber', 'pageTitle', 'slotIndex', 'slotCode', 'selectedCandidateIndex', 'selectedCandidateId', 'sourcePageNumber', 'sourceSlotIndex', 'sourceCandidateIndex', 'sourceCandidateId', 'processedActualBytes', 'originalActualBytes', 'exportedVariant', 'exportedBytes', 'fileName']
  const mapRows = recoveryReport.map(record => mapHeaders.map(key => String(record[key] ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t'))
  files.push({ name: '03-Project-Package/recovery-map.tsv', bytes: new TextEncoder().encode(`\uFEFF${[mapHeaders.join('\t'), ...mapRows].join('\r\n')}\r\n`) })
  files.push({ name: 'README.txt', bytes: new TextEncoder().encode('Each exported image was recovered from the complete candidate pool. Exact matching processed JPEG bytes are preserved without re-encoding; when only a uniquely matched original is available, the saved crop metadata is used to rebuild the processed image.\r\n') })
  files.push({ name: '03-Project-Package/recovery-report.json', bytes: new TextEncoder().encode(JSON.stringify({ scannedAt: deepResult.scannedAt, exportedAt: new Date().toISOString(), method: 'all-candidate-pool-dual-byte-match', recovered: recoveryReport.length, records: recoveryReport }, null, 2)) })
  files.push({ name: '03-Project-Package/manifest.json', bytes: new TextEncoder().encode(JSON.stringify(archiveManifest(deepResult.project), null, 2)) })

  const archive = zipArchive(files)
  if (['127.0.0.1', 'localhost'].includes(location.hostname)) window.__recoveryArchive = archive
  triggerDownload(archive, `${safeAscii(deepResult.project.name || 'FAI-project')}_deep-recovered-powerpoint-import.zip`)
  const rebuiltCount = recoveryReport.filter(item => item.exportedVariant === 'rebuilt-from-uniquely-matched-original').length
  statusBox.textContent = `深度恢复 ZIP 已生成：共 ${recoveryReport.length} 张；${recoveryReport.length - rebuiltCount} 张处理图原样导出，${rebuiltCount} 张按保存的裁切参数从唯一匹配原图重建。`
  downloadButton.disabled = false
  reportButton.disabled = false
}

function publicReport() {
  if (deepResult) {
    return {
      scannedAt: deepResult.scannedAt,
      method: 'all-candidate-pool-dual-byte-match',
      selectedCount: deepResult.targets.length,
      poolCount: deepResult.poolCount,
      matchedCount: deepResult.matches.size,
      unresolved: deepResult.unresolved.map(item => ({
        pageNumber: item.page.number || item.page.outputPageNumber || '',
        slotIndex: item.slotIndex,
        slotCode: item.slot.code || item.slot.slotCode || '',
        candidateIndex: item.candidateIndex,
        candidateId: item.candidate.id || '',
        expectedProcessedBytes: expectedSize(item.candidate, 'blob'),
        expectedOriginalBytes: expectedSize(item.candidate, 'originalBlob'),
      })),
      sourceDiagnostics: deepResult.sourceDiagnostics,
    }
  }
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

deepScanButton.addEventListener('click', async event => {
  const button = event.currentTarget
  button.disabled = true
  scanButton.disabled = true
  try {
    await deepScanCandidatePool()
  } catch (error) {
    showError(statusBox, error?.message || String(error))
  } finally {
    button.disabled = false
    scanButton.disabled = false
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
