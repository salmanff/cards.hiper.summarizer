/* Pipeline orchestration: runPipeline, runStage2, handleResearchMore, handleModifyPage */

async function runStage2(userQuery) {
  var relevantRecords = Object.values(state.relevantRecordMap)
  showStatus('Stage 2 — generating summary from ' + relevantRecords.length + ' relevant records...')

  if (relevantRecords.length === 0) {
    setProcessing(false)
    document.getElementById('result-container').innerHTML =
      '<p style="color:#868e96;padding:20px;">No relevant records found for your query.</p>'
    document.getElementById('result-title').textContent = 'No Results'
    state.currentResult = { title: 'No Results', html: '' }
    renderDetailsTab()
    switchTab('results')
    showStatus('Done — no relevant records found.')
    return
  }

  var accumulated = ''
  var streamStarted = false
  var updateTimer = null

  function flushStreamUpdate() {
    updateTimer = null
    try {
      var partialTitle = extractDelimitedTitle(accumulated)
      if (partialTitle) document.getElementById('result-title').textContent = partialTitle
      var partialHtml = extractDelimitedHtml(accumulated)
      if (partialHtml) {
        document.getElementById('result-container').innerHTML =
          sanitizeHTML(partialHtml) +
          '<span style="display:inline-block;width:2px;height:1em;background:#3b5bdb;margin-left:3px;vertical-align:middle;animation:blink 0.8s step-end infinite;"></span>'
      }
    } catch (e) {
      console.warn('[STREAM] flush error:', e)
    }
  }

  function onDelta(chunk) {
    accumulated += chunk
    if (!streamStarted) {
      streamStarted = true
      switchTab('results')
      document.getElementById('result-title').textContent = 'Generating…'
      document.getElementById('result-container').innerHTML =
        '<p style="color:#adb5bd;font-style:italic;padding:8px 0;">Generating summary…</p>'
    }
    if (!updateTimer) {
      updateTimer = setTimeout(flushStreamUpdate, 80)
    }
  }

  var stage2Result = await askLLM(
    buildStage2UserPrompt(userQuery, relevantRecords),
    mainLLMOptions({ context: buildStage2SystemPrompt(), max_tokens: 8000, streamBack: true, onDelta: onDelta })
  )

  if (updateTimer) { clearTimeout(updateTimer); updateTimer = null }

  if (!stage2Result.success) {
    setProcessing(false)
    state.pendingRetry = { type: 'pipeline', query: userQuery, resumeFromStage2: true }
    showRetryStatus(stage2Result.error)
    return
  }

  accumulateCost(stage2Result, 'Stage 2 — Summary')

  var finalText = (typeof stage2Result.response === 'string') ? stage2Result.response : accumulated
  var title = extractDelimitedTitle(finalText) || 'Research Summary'
  var html = sanitizeHTML(extractDelimitedHtml(finalText) || '<p>No content generated.</p>')

  state.currentResult = { title: title, html: html }
  document.getElementById('result-title').textContent = title
  document.getElementById('result-container').innerHTML = html

  renderDetailsTab()
  switchTab('results')
  setProcessing(false)
  setSaveState(false)
  showStatus('Summary ready! ' + relevantRecords.length + ' relevant records used.')
}

async function runPipeline(userQuery) {
  getTechSettings()

  state.currentUserQuery = userQuery
  state.allRounds = []
  state.relevantRecordMap = {}
  state.suggestedDates = { startTime: null, endTime: null }
  state.modifyInstructions = []
  state.totalCost = { tokens: 0, inputTokens: 0, outputTokens: 0, inputCost: 0, outputCost: 0, totalCost: 0, details: [] }
  state.accessTokens = {}
  state.currentResult = null

  document.getElementById('cost-display').textContent = ''
  renderDetailsTab()

  console.log('[PIPELINE] cheapModel:', state.cheapModel, '(' + state.cheapProvider + ')',
    '| mainModel:', state.mainModel, '(' + state.mainProvider + ')',
    '| maxCount:', PARAMS.maxCount, '| maxRoundTrips:', PARAMS.maxRoundTrips)

  showStatus('Stage 1a — planning query...')

  var stage1aResult = await askLLM(
    buildStage1aPrompt(userQuery),
    mainLLMOptions({ responseType: 'json', max_tokens: 512 })
  )

  if (!stage1aResult.success) {
    setProcessing(false)
    state.pendingRetry = { type: 'pipeline', query: userQuery, resumeFromStage2: false }
    showRetryStatus(stage1aResult.error)
    return
  }
  accumulateCost(stage1aResult, 'Stage 1a — Query Plan')

  var queryPlan
  try {
    queryPlan = parseJSON(stage1aResult)
  } catch (err) {
    showStatus('Stage 1a parse error: ' + err.message, true)
    setProcessing(false)
    return
  }

  var plannedCollections = Array.isArray(queryPlan.collections) ? queryPlan.collections : ['logs', 'marks']
  plannedCollections = plannedCollections.filter(function(c) { return COLLECTION_MAP[c] })
  if (plannedCollections.length === 0) plannedCollections = ['logs', 'marks']

  state.suggestedDates = queryPlan.suggestedDates || { startTime: null, endTime: null }

  console.log('[1a] Collections:', plannedCollections, '| Dates:', state.suggestedDates, '| Keyword:', queryPlan.keyword)

  var nextRound = 1
  for (var ci = 0; ci < plannedCollections.length; ci++) {
    var col = plannedCollections[ci]
    var ok = await searchCollection(col, userQuery, state.suggestedDates, nextRound)
    if (!ok) return
    nextRound = state.allRounds.length + 1
  }

  await runStage2(userQuery)
}

async function handleResearchMore(userFollowUp) {
  if (state.isProcessing) return
  applyActionModelSettings('research', true)
  setProcessing(true)
  var query = userFollowUp || state.currentUserQuery
  var previousRecordCount = Object.keys(state.relevantRecordMap).length
  console.log('[RESEARCH MORE] Starting with', previousRecordCount, 'existing relevant records')

  var oldestByCol = {}
  state.allRounds.forEach(function(r) {
    if (r.collectionsData) {
      Object.keys(r.collectionsData).forEach(function(col) {
        var cd = r.collectionsData[col]
        if (cd.oldestTimestamp) {
          if (!oldestByCol[col] || cd.oldestTimestamp < oldestByCol[col]) {
            oldestByCol[col] = cd.oldestTimestamp
          }
        }
      })
    }
  })

  var collectionsToSearch = Object.keys(COLLECTION_MAP)
  var nextRound = state.allRounds.length + 1

  for (var ci = 0; ci < collectionsToSearch.length; ci++) {
    var col = collectionsToSearch[ci]

    var extraDates = Object.assign({}, state.suggestedDates)
    if (oldestByCol[col]) {
      extraDates.endTime = oldestByCol[col]
      extraDates.startTime = null
    }

    var ok = await searchCollection(col, query, extraDates, nextRound)
    if (!ok) return
    nextRound = state.allRounds.length + 1
  }

  var relevantRecords = Object.values(state.relevantRecordMap)
  var newRecordCount = relevantRecords.length - previousRecordCount
  console.log('[RESEARCH MORE] Total relevant records for Stage 2:', relevantRecords.length,
    '(' + previousRecordCount + ' previous +', newRecordCount, 'new)')
  showStatus('Updating summary with ' + relevantRecords.length + ' relevant records (' + previousRecordCount + ' previous + ' + newRecordCount + ' new)...')

  var researchMorePrompt = buildStage2UserPrompt(query, relevantRecords) +
    '\n\nIMPORTANT: This is an UPDATE to an existing summary. The records above include BOTH previously found records (' +
    previousRecordCount + ' records) AND newly discovered records (' + newRecordCount + ' records). ' +
    'You MUST incorporate ALL relevant records — both old and new — into a single comprehensive summary. ' +
    'Do NOT discard or ignore the previously found records. Merge everything together into one cohesive, complete summary.'

  if (state.currentResult && state.currentResult.html) {
    researchMorePrompt += '\n\nFor reference, here is the PREVIOUS summary that was generated. ' +
      'Use it as a starting point and expand it with the new records:\n' +
      state.currentResult.html
  }

  var accumulated = ''
  var streamStarted = false
  var updateTimer = null

  function flushUpdate() {
    updateTimer = null
    try {
      var partialTitle = extractDelimitedTitle(accumulated)
      if (partialTitle) document.getElementById('result-title').textContent = partialTitle
      var partialHtml = extractDelimitedHtml(accumulated)
      if (partialHtml) {
        document.getElementById('result-container').innerHTML =
          sanitizeHTML(partialHtml) +
          '<span style="display:inline-block;width:2px;height:1em;background:#3b5bdb;margin-left:3px;vertical-align:middle;animation:blink 0.8s step-end infinite;"></span>'
      }
    } catch (e) {
      console.warn('[STREAM] researchMore flush error:', e)
    }
  }

  function onDelta(chunk) {
    accumulated += chunk
    if (!streamStarted) {
      streamStarted = true
      switchTab('results')
      document.getElementById('result-title').textContent = 'Updating…'
      document.getElementById('result-container').innerHTML =
        '<p style="color:#adb5bd;font-style:italic;padding:8px 0;">Updating summary…</p>'
    }
    if (!updateTimer) {
      updateTimer = setTimeout(flushUpdate, 80)
    }
  }

  var stage2Result = await askLLM(
    researchMorePrompt,
    mainLLMOptions({ context: buildStage2SystemPrompt(), max_tokens: 8000, streamBack: true, onDelta: onDelta })
  )

  if (updateTimer) { clearTimeout(updateTimer); updateTimer = null }

  if (!stage2Result.success) {
    setProcessing(false)
    state.pendingRetry = { type: 'researchMore', query: query }
    showRetryStatus(stage2Result.error)
    return
  }
  accumulateCost(stage2Result, 'Extra Stage 2 — Summary')

  var finalText = (typeof stage2Result.response === 'string') ? stage2Result.response : accumulated
  var title = extractDelimitedTitle(finalText) || 'Research Summary'
  var html = sanitizeHTML(extractDelimitedHtml(finalText) || '<p>No content generated.</p>')

  state.currentResult = { title: title, html: html }
  document.getElementById('result-title').textContent = title
  document.getElementById('result-container').innerHTML = html

  renderDetailsTab()
  switchTab('results')
  setProcessing(false)
  setSaveState(false)
  showStatus('Updated summary ready!')
}

async function handleModifyPage(userInstruction) {
  if (!state.currentResult || state.isProcessing) return
  applyActionModelSettings('modify', false)
  setProcessing(true)
  showStatus('Modifying page...')

  var relevantRecords = Object.values(state.relevantRecordMap)

  var userPrompt = 'Modify the HTML summary below according to this instruction: "' + userInstruction + '"\n\n' +
    'You MUST return a new, complete HTML summary that incorporates the instruction.\n' +
    'CURRENT TITLE: ' + state.currentResult.title + '\n\n' +
    'CURRENT HTML (modify this):\n' + state.currentResult.html + '\n\n' +
    'SOURCE RECORDS (' + relevantRecords.length + ' items — use these to add/change content if needed):\n' +
    JSON.stringify(compactStage2Records(relevantRecords), null, 1) + '\n\n' +
    'Return your response using the ===TITLE===, ===HTML===, ===END=== delimiters as specified in your instructions.'

  var accumulated = ''
  var streamStarted = false
  var updateTimer = null
  var prevHtml = state.currentResult.html

  function flushModifyUpdate() {
    updateTimer = null
    try {
      var partialTitle = extractDelimitedTitle(accumulated)
      if (partialTitle) document.getElementById('result-title').textContent = partialTitle
      var partialHtml = extractDelimitedHtml(accumulated)
      if (partialHtml) {
        document.getElementById('result-container').innerHTML =
          sanitizeHTML(partialHtml) +
          '<span style="display:inline-block;width:2px;height:1em;background:#3b5bdb;margin-left:3px;vertical-align:middle;animation:blink 0.8s step-end infinite;"></span>'
      }
    } catch (e) {
      console.warn('[STREAM] modify flush error:', e)
    }
  }

  function onDelta(chunk) {
    accumulated += chunk
    if (!streamStarted) {
      streamStarted = true
      switchTab('results')
      document.getElementById('result-container').innerHTML =
        '<p style="color:#adb5bd;font-style:italic;padding:8px 0;">Modifying summary…</p>'
    }
    if (!updateTimer) {
      updateTimer = setTimeout(flushModifyUpdate, 80)
    }
  }

  var result = await askLLM(
    userPrompt,
    mainLLMOptions({ context: buildStage2SystemPrompt(), max_tokens: 8000, streamBack: true, onDelta: onDelta })
  )

  if (updateTimer) { clearTimeout(updateTimer); updateTimer = null }

  if (!result.success) {
    document.getElementById('result-container').innerHTML = sanitizeHTML(prevHtml)
    setProcessing(false)
    state.pendingRetry = { type: 'modifyPage', instruction: userInstruction }
    showRetryStatus(result.error)
    return
  }
  accumulateCost(result, 'Modify Page')

  var finalText = (typeof result.response === 'string') ? result.response : accumulated
  var newHtml = extractDelimitedHtml(finalText)

  if (!newHtml) {
    document.getElementById('result-container').innerHTML = sanitizeHTML(prevHtml)
    setProcessing(false)
    showStatus('⚠️ The AI returned empty HTML. Try rephrasing your instruction.', true)
    return
  }

  var title = extractDelimitedTitle(finalText) || state.currentResult.title
  var html = sanitizeHTML(newHtml)

  state.currentResult = { title: title, html: html }

  if (!state.modifyInstructions) state.modifyInstructions = []
  state.modifyInstructions.push({ instruction: userInstruction, timestamp: Date.now() })

  document.getElementById('result-title').textContent = title
  document.getElementById('result-container').innerHTML = html

  renderDetailsTab()
  switchTab('results')
  setProcessing(false)
  setSaveState(false)
  showStatus('Page updated!')
}