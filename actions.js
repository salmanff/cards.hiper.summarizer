/* User-action handlers: send/cancel/save/delete, publish/unpublish, sidebar, title change, retry */

// ============================================
// RETRY
// ============================================

async function handleRetry() {
  if (!state.pendingRetry || state.isProcessing) return
  var retry = state.pendingRetry
  state.pendingRetry = null

  if (retry.type === 'pipeline') {
    setProcessing(true)
    if (retry.resumeFromStage2) {
      await runStage2(retry.query)
    } else {
      await runPipeline(retry.query)
    }
  } else if (retry.type === 'researchMore') {
    await handleResearchMore(retry.query)
  } else if (retry.type === 'modifyPage') {
    await handleModifyPage(retry.instruction)
  }
}

// ============================================
// SEND / CANCEL
// ============================================

async function handleSend() {
  var input = document.getElementById('user-input')
  var text = input.value.trim()
  if (!text || state.isProcessing) return

  document.getElementById('input-section').classList.add('hidden')
  document.getElementById('result-section').classList.remove('hidden')
  document.getElementById('result-title').textContent = 'Processing...'
  document.getElementById('result-container').innerHTML = ''

  input.value = ''
  switchTab('details')
  setProcessing(true)
  showStatus('Starting pipeline...')

  await runPipeline(text)
}

function handleCancel() {
  state.isProcessing = false
  state.pendingRetry = null
  setProcessing(false)
  showStatus('Cancelled')
}

// ============================================
// SAVE SUMMARY
// ============================================

async function handleSave() {
  if (!state.currentResult) return

  var saveBtn = document.getElementById('save-btn')
  saveBtn.disabled = true
  saveBtn.textContent = 'Saving...'

  var relevantRecords = Object.values(state.relevantRecordMap)
  var relevantIds = Object.keys(state.relevantRecordMap)
  var stripRecords = relevantRecords.length > MAX_RECORDS_TO_SAVE

  var existingSummary = (state.activeSummaryIndex !== null && state.activeSummaryIndex !== undefined)
    ? state.savedSummaries[state.activeSummaryIndex]
    : null
  var existingId = existingSummary && existingSummary._id

  function buildRounds() {
    return state.allRounds.map(function(r) {
      var safeColData = {}
      if (r.collectionsData) {
        Object.keys(r.collectionsData).forEach(function(col) {
          var cd = r.collectionsData[col]
          safeColData[col] = Object.assign({}, cd, {
            query: typeof cd.query === 'string' ? cd.query : JSON.stringify(cd.query || {})
          })
        })
      }
      return {
        roundTrip: r.roundTrip,
        collectionsData: safeColData,
        fetched: r.fetched,
        relevantCount: r.relevantCount
      }
    })
  }

  function buildBase(includeRounds, includeRecords) {
    var data = {
      title: state.currentResult.title,
      query_text: state.currentUserQuery,
      html: state.currentResult.html,
      modify_instructions: (state.modifyInstructions || []).slice(),
      relevant_record_ids: relevantIds,
      relevant_records: includeRecords ? relevantRecords : [],
      records_stripped: !includeRecords && relevantIds.length > 0,
      total_cost: Object.assign({}, state.totalCost),
      suggested_dates: Object.assign({}, state.suggestedDates),
      created_at: Date.now()
    }
    if (includeRounds) data.rounds = buildRounds()
    if (existingId) {
      if (Array.isArray(existingSummary.published_versions)) {
        data.published_versions = existingSummary.published_versions
      }
      data.created_at = existingSummary.created_at || data.created_at
    }
    return data
  }

  async function persist(summaryData) {
    if (existingId) {
      await freezr.update('summaries', existingId, summaryData)
      summaryData._id = existingId
      state.savedSummaries[state.activeSummaryIndex] = summaryData
    } else {
      var result = await freezr.create('summaries', summaryData)
      summaryData._id = result._id
      state.savedSummaries.unshift(summaryData)
      state.activeSummaryIndex = 0
    }
    return summaryData
  }

  var savedData = null
  var saveNote = null

  // Tier 1: full save (but records stripped if over threshold)
  try {
    savedData = await persist(buildBase(true, !stripRecords))
    if (stripRecords) saveNote = 'strip_records'
  } catch (err1) {
    console.warn('[SAVE] Tier 1 failed:', err1)
    // Tier 2: drop rounds data
    try {
      savedData = await persist(buildBase(false, !stripRecords))
      saveNote = stripRecords ? 'strip_records_and_rounds' : 'strip_rounds'
    } catch (err2) {
      console.warn('[SAVE] Tier 2 failed:', err2)
      // Tier 3: absolute minimum — title, html, ids, cost only
      try {
        var minimal = {
          title: state.currentResult.title,
          query_text: state.currentUserQuery,
          html: state.currentResult.html,
          relevant_record_ids: relevantIds,
          relevant_records: [],
          records_stripped: relevantIds.length > 0,
          total_cost: Object.assign({}, state.totalCost),
          suggested_dates: Object.assign({}, state.suggestedDates),
          created_at: existingId ? (existingSummary.created_at || Date.now()) : Date.now()
        }
        if (existingId && Array.isArray(existingSummary.published_versions)) {
          minimal.published_versions = existingSummary.published_versions
        }
        savedData = await persist(minimal)
        saveNote = 'minimal'
      } catch (err3) {
        console.error('[SAVE] All tiers failed:', err3)
        saveBtn.textContent = 'Save Failed'
        saveBtn.disabled = false
        showStatus('⚠️ Save failed — could not write to database. ' + (err3.message || ''), true)
        return
      }
    }
  }

  // Update in-memory flag
  state.recordsNotSaved = !!(savedData && savedData.records_stripped)

  renderSidebar()
  setSaveState(true)
  renderDetailsTab()

  if (saveNote === 'strip_records' || saveNote === 'strip_records_and_rounds') {
    saveBtn.textContent = 'Saved (partial)'
    showStatus(
      '⚠️ Saved — but ' + relevantIds.length + ' source records were too large to store. ' +
      'Modify/Research More will only work in this session.',
      true
    )
  } else if (saveNote === 'strip_rounds') {
    saveBtn.textContent = 'Saved (partial)'
    showStatus('Saved — round details omitted to reduce size.', false)
  } else if (saveNote === 'minimal') {
    saveBtn.textContent = 'Saved (minimal)'
    showStatus('⚠️ Saved with minimal data only — rounds and source records omitted.', true)
  } else {
    saveBtn.textContent = 'Saved ✓'
  }
  setTimeout(function() {
    saveBtn.textContent = 'Save Summary'
  }, 2500)
}

// ============================================
// NEW QUERY
// ============================================

function handleNewQuery() {
  if (!checkUnsavedChanges()) return

  state.activeSummaryIndex = null
  state.pendingRetry = null
  state.recordsNotSaved = false
  renderSidebar()

  document.getElementById('result-section').classList.add('hidden')
  document.getElementById('status-bar').classList.add('hidden')
  document.getElementById('input-section').classList.remove('hidden')
  document.getElementById('user-input').value = ''
  document.getElementById('user-input').focus()

  state.allRounds = []
  state.relevantRecordMap = {}
  state.currentResult = null
  state.currentUserQuery = ''
  state.suggestedDates = { startTime: null, endTime: null }
  state.modifyInstructions = []
  state.totalCost = { tokens: 0, inputTokens: 0, outputTokens: 0, inputCost: 0, outputCost: 0, totalCost: 0, details: [] }
  state.accessTokens = {}
  document.getElementById('details-rounds').innerHTML = ''
  document.getElementById('cost-display').textContent = ''
  setSaveState(true)
}

// ============================================
// CHANGE TITLE
// ============================================

async function handleSaveTitle() {
  var input = document.getElementById('change-title-input')
  if (!input) return
  var newTitle = input.value.trim()
  if (!newTitle) return

  var btn = document.getElementById('change-title-save-btn')
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...' }

  try {
    if (state.currentResult) state.currentResult.title = newTitle

    document.getElementById('result-title').textContent = newTitle

    if (state.activeSummaryIndex !== null && state.activeSummaryIndex !== undefined) {
      var summary = state.savedSummaries[state.activeSummaryIndex]
      if (summary && summary._id) {
        summary.title = newTitle
        state.savedSummaries[state.activeSummaryIndex] = summary
        await freezr.update('summaries', summary._id, summary)
      }
    }

    renderSidebar()

    if (btn) { btn.textContent = 'Saved ✓' }
    setTimeout(function() {
      if (btn) { btn.disabled = false; btn.textContent = 'Save' }
    }, 2000)
  } catch (err) {
    console.error('Failed to save title:', err)
    if (btn) { btn.disabled = false; btn.textContent = 'Save Failed' }
  }
}

// ============================================
// DELETE SUMMARY
// ============================================

async function handleDeleteSummary() {
  if (state.activeSummaryIndex === null || state.activeSummaryIndex === undefined) return
  var summary = state.savedSummaries[state.activeSummaryIndex]
  if (!summary || !summary._id) return

  var confirmed = confirm('Delete "' + (summary.title || 'Untitled') + '"? This cannot be undone.')
  if (!confirmed) return

  var btn = document.getElementById('delete-summary-btn')
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting...' }

  try {
    await freezr.delete('summaries', summary._id)

    state.savedSummaries.splice(state.activeSummaryIndex, 1)
    state.activeSummaryIndex = null
    renderSidebar()

    state.currentResult = null
    state.currentUserQuery = ''
    state.allRounds = []
    state.relevantRecordMap = {}
    state.suggestedDates = { startTime: null, endTime: null }
    state.modifyInstructions = []
    state.totalCost = { tokens: 0, inputTokens: 0, outputTokens: 0, inputCost: 0, outputCost: 0, totalCost: 0, details: [] }
    state.accessTokens = {}
    state.recordsNotSaved = false

    document.getElementById('result-section').classList.add('hidden')
    document.getElementById('status-bar').classList.add('hidden')
    document.getElementById('input-section').classList.remove('hidden')
    document.getElementById('details-rounds').innerHTML = ''
    document.getElementById('cost-display').textContent = ''
    document.getElementById('user-input').focus()
    setSaveState(true)

  } catch (err) {
    console.error('Failed to delete summary:', err)
    if (btn) { btn.disabled = false; btn.textContent = 'Delete Summary' }
    showStatus('Failed to delete summary: ' + (err.message || String(err)), true)
  }
}

// ============================================
// PUBLISH / UNPUBLISH
// ============================================

async function handlePublish(type) {
  if (!state.currentResult || !state.isSaved || state.isProcessing) return

  var summary = (state.activeSummaryIndex !== null && state.activeSummaryIndex !== undefined)
    ? state.savedSummaries[state.activeSummaryIndex]
    : null

  if (!summary || !summary._id) {
    showStatus('Please save the summary first before publishing.', true)
    return
  }

  var isPrivate = type === 'privatelink'
  showStatus(isPrivate ? 'Creating private link...' : 'Publishing summary...')
  renderPublishingSection()

  try {
    var publishedData = {
      title: state.currentResult.title,
      html: state.currentResult.html,
      summary_id: summary._id,
      created_at: Date.now()
    }

    var createResult = await freezr.create('published', publishedData)
    var publishedId = createResult._id
    console.log('[PUBLISH] createResult:', JSON.stringify(createResult))
    if (!publishedId) throw new Error('Failed to create published record')

    var grantee = isPrivate ? '_privatelink' : '_public'

    var shareResult = await freezr.perms.shareRecords(publishedId, {
      name: 'publish_summary',
      table_id: 'cards.hiper.summarizer.published',
      grantees: [grantee],
      action: 'grant',
      pubDate: Date.now()
    })
    console.log('[PUBLISH] shareRecords result (full):', JSON.stringify(shareResult))

    var publicId = null
    var privateCode = null
    try {
      var publishedRecord = await freezr.read('published', publishedId)
      console.log('[PUBLISH] read-back record (full):', JSON.stringify(publishedRecord))
      console.log('[PUBLISH] _accessibles:', JSON.stringify(publishedRecord._accessibles))

      var pubEntry = publishedRecord._accessibles && publishedRecord._accessibles.find(function(a) {
        return a.permission_name === 'publish_summary'
      })
      console.log('[PUBLISH] matched _accessibles entry:', JSON.stringify(pubEntry))

      if (pubEntry) {
        publicId = pubEntry.public_id
        privateCode = pubEntry.code || null
      }
    } catch (readErr) {
      console.warn('[PUBLISH] Could not read back published record:', readErr)
    }

    if (!publicId && shareResult) {
      publicId = shareResult.public_id || (shareResult.result && shareResult.result.public_id) || null
      console.log('[PUBLISH] public_id from shareResult:', publicId)
    }
    if (!privateCode && shareResult) {
      privateCode = shareResult.code || (shareResult.result && shareResult.result.code) || null
      console.log('[PUBLISH] code from shareResult:', privateCode)
    }

    var versionEntry = {
      _id: publishedId,
      public_id: publicId,
      title: state.currentResult.title,
      created_at: publishedData.created_at,
      type: isPrivate ? 'privatelink' : 'public',
      code: privateCode || null
    }
    console.log('[PUBLISH] versionEntry to store:', JSON.stringify(versionEntry))

    var existingVersions = Array.isArray(summary.published_versions) ? summary.published_versions : []
    summary.published_versions = existingVersions.concat([versionEntry])

    await freezr.update('summaries', summary._id, summary)
    state.savedSummaries[state.activeSummaryIndex] = summary

    renderDetailsTab()
    renderSidebar()

    if (isPrivate) {
      var privateUrl = publicId ? ('/' + publicId + (privateCode ? '?code=' + privateCode : '')) : null
      showStatus('Private link created!' + (privateUrl ? ' URL: ' + privateUrl : ''))
      console.log('[PUBLISH] final private URL:', privateUrl)
    } else {
      var publicUrl = publicId ? ('/' + publicId) : null
      showStatus('Published publicly!' + (publicUrl ? ' URL: ' + publicUrl : ''))
      console.log('[PUBLISH] final public URL:', publicUrl)
    }

  } catch (err) {
    console.error('[PUBLISH] Failed:', err)
    showStatus('Publish failed: ' + (err.message || String(err)), true)
    renderDetailsTab()
  }
}

async function handleDeletePublished(publishedId) {
  var summary = (state.activeSummaryIndex !== null && state.activeSummaryIndex !== undefined)
    ? state.savedSummaries[state.activeSummaryIndex]
    : null

  var confirmed = confirm('Unpublish and delete this published version? This cannot be undone.')
  if (!confirmed) return

  showStatus('Unpublishing...')

  var versionEntry = null
  if (summary && Array.isArray(summary.published_versions)) {
    versionEntry = summary.published_versions.find(function(v) { return v._id === publishedId }) || null
  }
  var grantee = (versionEntry && versionEntry.type === 'privatelink') ? '_privatelink' : '_public'

  console.log('[UNPUBLISH] publishedId:', publishedId, '| grantee:', grantee, '| versionEntry:', JSON.stringify(versionEntry))

  try {
    try {
      var denyResult = await freezr.perms.shareRecords(publishedId, {
        name: 'publish_summary',
        table_id: 'cards.hiper.summarizer.published',
        grantees: [grantee],
        action: 'deny'
      })
      console.log('[UNPUBLISH] shareRecords deny result:', JSON.stringify(denyResult))
    } catch (denyErr) {
      console.warn('[UNPUBLISH] shareRecords deny failed (continuing to delete):', denyErr)
    }

    await freezr.delete('published', publishedId)
    console.log('[UNPUBLISH] deleted published record:', publishedId)

    if (summary && summary._id && Array.isArray(summary.published_versions)) {
      summary.published_versions = summary.published_versions.filter(function(v) {
        return v._id !== publishedId
      })
      await freezr.update('summaries', summary._id, summary)
      state.savedSummaries[state.activeSummaryIndex] = summary
    }

    renderDetailsTab()
    renderSidebar()
    showStatus('Unpublished and deleted.')
  } catch (err) {
    console.error('[UNPUBLISH] Failed:', err)
    showStatus('Unpublish failed: ' + (err.message || String(err)), true)
  }
}

// ============================================
// SIDEBAR INTERACTION
// ============================================

async function loadSavedSummaries() {
  document.getElementById('sidebar-list').innerHTML =
    '<div style="padding:24px;display:flex;justify-content:center;">' +
      '<div class="freezr-spinner"></div>' +
    '</div>'
  try {
    var results = await freezr.query('summaries', {}, { sort: { created_at: -1 }, count: 100 })
    state.savedSummaries = Array.isArray(results) ? results : []
    renderSidebar()
  } catch (err) {
    console.warn('Failed to load saved summaries:', err)
    renderSidebar()
  }
}

function handleSidebarClick(e) {
  var target = e.target
  while (target && target !== e.currentTarget) {
    if (target.classList.contains('sidebar-item')) {
      var index = parseInt(target.getAttribute('data-index'), 10)
      if (!checkUnsavedChanges()) return
      loadSummaryIntoView(index)
      return
    }
    target = target.parentElement
  }
}

function loadSummaryIntoView(index) {
  var summary = state.savedSummaries[index]
  if (!summary) return

  state.activeSummaryIndex = index
  renderSidebar()

  state.currentResult = { title: summary.title, html: summary.html }
  state.currentUserQuery = summary.query_text || ''
  state.allRounds = summary.rounds ? summary.rounds.slice() : []
  state.suggestedDates = summary.suggested_dates || { startTime: null, endTime: null }
  state.modifyInstructions = Array.isArray(summary.modify_instructions) ? summary.modify_instructions.slice() : []

  state.relevantRecordMap = {}
  if (Array.isArray(summary.relevant_records)) {
    summary.relevant_records.forEach(function(r) {
      if (r && r._id) state.relevantRecordMap[r._id] = r
    })
  }

  // Detect if source records were stripped on save
  var hasIds = Array.isArray(summary.relevant_record_ids) && summary.relevant_record_ids.length > 0
  var hasRecords = Object.keys(state.relevantRecordMap).length > 0
  state.recordsNotSaved = !!(summary.records_stripped || (hasIds && !hasRecords))

  state.totalCost = summary.total_cost ? Object.assign({}, summary.total_cost) : {
    tokens: 0, inputTokens: 0, outputTokens: 0, inputCost: 0, outputCost: 0, totalCost: 0, details: []
  }

  document.getElementById('input-section').classList.add('hidden')
  document.getElementById('result-section').classList.remove('hidden')
  document.getElementById('status-bar').classList.add('hidden')
  document.getElementById('result-title').textContent = summary.title || 'Untitled'
  document.getElementById('result-container').innerHTML = sanitizeHTML(summary.html || '<p>No content</p>')

  renderDetailsTab()
  updateCostDisplay()
  setSaveState(true)
  switchTab('results')
}

// ============================================
// DELEGATED CLICK HANDLERS
// ============================================

function handleDetailsTabClick(e) {
  var target = e.target
  if (target.id === 'action-research-more-btn') {
    var instructionEl = document.getElementById('action-research-more-input')
    handleResearchMore(instructionEl ? instructionEl.value.trim() : '')
  } else if (target.id === 'action-modify-btn') {
    var modifyEl = document.getElementById('action-modify-input')
    if (modifyEl && modifyEl.value.trim()) {
      handleModifyPage(modifyEl.value.trim())
    }
  } else if (target.id === 'change-title-save-btn') {
    handleSaveTitle()
  } else if (target.id === 'delete-summary-btn') {
    handleDeleteSummary()
  } else if (target.id === 'publish-public-btn') {
    handlePublish('public')
  } else if (target.id === 'publish-private-btn') {
    handlePublish('privatelink')
  } else if (target.getAttribute && target.getAttribute('data-action') === 'delete-published') {
    var pubId = target.getAttribute('data-published-id')
    if (pubId) handleDeletePublished(pubId)
  }
}

function handleRoundToggleClick(e) {
  var target = e.target
  while (target && target !== e.currentTarget) {
    if (target.getAttribute('data-toggle') === 'round') {
      var rIdx = target.getAttribute('data-round-index')
      var card = document.querySelector('.round-card[data-round-index="' + rIdx + '"]')
      if (card) {
        var body = card.querySelector('.round-card-body')
        var arrow = target.querySelector('.round-toggle')
        if (body) {
          var isOpen = !body.classList.contains('hidden')
          body.classList.toggle('hidden', isOpen)
          if (arrow) arrow.classList.toggle('open', !isOpen)
        }
      }
      return
    }
    target = target.parentElement
  }
}