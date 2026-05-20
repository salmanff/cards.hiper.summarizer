/* Database access: validateDataOwner token management, executeQuery, and searchCollection pipeline */

async function getAccessToken(collection) {
  var permName = collection === 'logs' ? 'read_logs' : 'read_marks'
  var tableId = COLLECTION_MAP[collection]
  var cacheKey = permName

  if (state.accessTokens[cacheKey]) return state.accessTokens[cacheKey]

  var result = await freezr.perms.validateDataOwner({
    data_owner_user: freezrMeta.userId,
    table_id: tableId,
    permission: permName
  })
  var token = result['access-token']
  if (!token) throw new Error('Permission not granted for ' + collection + '. Please check Settings.')
  state.accessTokens[cacheKey] = token
  return token
}

async function executeQuery(collection, query, options) {
  var tableId = COLLECTION_MAP[collection]
  if (!tableId) throw new Error('Unknown collection: ' + collection)

  var accessToken = await getAccessToken(collection)
  var permName = collection === 'logs' ? 'read_logs' : 'read_marks'

  var queryOptions = {
    appToken: accessToken,
    permission_name: permName,
    count: Math.min((options && options.count) || PARAMS.maxCount, PARAMS.maxCount),
    sort: (options && options.sort) || { _date_modified: -1 },
    skip: (options && options.skip) || 0
  }

  var results = await freezr.query(tableId, query || {}, queryOptions)
  return Array.isArray(results) ? results : []
}

async function searchCollection(col, userQuery, suggestedDates, startRoundNumber) {
  var oldestTs = null
  var relevantCount = 0
  var roundTrip = 0
  var done = false

  while (!done && roundTrip < PARAMS.maxRoundTrips) {
    roundTrip++
    var globalRound = startRoundNumber + roundTrip - 1

    showStatus('Searching ' + col + ' · round ' + roundTrip + '/' + PARAMS.maxRoundTrips + '...')

    var dbQuery = {}
    if (roundTrip === 1) {
      if (suggestedDates && suggestedDates.endTime) dbQuery._date_modified = { $lt: suggestedDates.endTime }
    } else {
      if (oldestTs !== null) dbQuery._date_modified = { $lt: oldestTs }
    }

    var records = []
    var fetchError = null
    try {
      records = await executeQuery(col, dbQuery, { count: PARAMS.maxCount })
    } catch (err) {
      fetchError = err.message || String(err)
      records = []
    }

    var batchOldest = null
    for (var i = 0; i < records.length; i++) {
      var dm = records[i]._date_modified
      if (dm !== undefined && dm !== null) {
        var dmNum = Number(dm)
        if (!isNaN(dmNum) && (batchOldest === null || dmNum < batchOldest)) batchOldest = dmNum
      }
    }

    var relevantIds = []
    var reason = ''

    if (records.length === 0 || fetchError) {
      done = true
      reason = fetchError || 'No records returned.'
    } else {
      var prompt = buildStage1bPrompt(
        userQuery, col, records,
        roundTrip, relevantCount,
        PARAMS.maxRoundTrips, suggestedDates
      )

      var llmResult = await askLLM(prompt, cheapLLMOptions({ responseType: 'json' }))

      if (!llmResult.success) {
        state.pendingRetry = { type: 'pipeline', query: userQuery, resumeFromStage2: false }
        showRetryStatus(llmResult.error)
        setProcessing(false)
        return false
      }

      accumulateCost(llmResult, 'Stage 1b · ' + col + ' round ' + globalRound)

      var parsed
      try {
        parsed = parseJSON(llmResult)
      } catch(e) {
        parsed = { relevant: [], done: true, reason: 'Parse error: ' + e.message }
      }

      relevantIds = Array.isArray(parsed.relevant) ? parsed.relevant : []
      done = !!parsed.done
      reason = parsed.reason || ''

      // Hard code-level override: if the oldest record in this batch is already
      // older than startTime we have exhausted the date range — stop regardless
      // of what the LLM decided (LLMs frequently misread date comparisons).
      if (suggestedDates && suggestedDates.startTime && batchOldest !== null && Number(batchOldest) < Number(suggestedDates.startTime)) {
        done = true
        reason += ' [auto-stopped: oldest batch record (' + new Date(batchOldest).toISOString().slice(0,10) + ') is before query start (' + new Date(suggestedDates.startTime).toISOString().slice(0,10) + ')]'
      }

      var recordById = {}
      records.forEach(function(r) { if (r._id) recordById[r._id] = r })
      relevantIds.forEach(function(id) {
        if (recordById[id]) state.relevantRecordMap[id] = recordById[id]
      })
      relevantCount += relevantIds.length
    }

    if (batchOldest !== null) oldestTs = batchOldest

    var roundColData = {}
    roundColData[col] = {
      query: typeof dbQuery === 'object' ? JSON.stringify(dbQuery) : dbQuery,
      fetched: records.length,
      relevantIds: relevantIds,
      relevantCount: relevantIds.length,
      reason: reason,
      fetchError: fetchError,
      oldestTimestamp: oldestTs,
      done: done
    }

    state.allRounds.push({
      roundTrip: globalRound,
      collectionsData: roundColData,
      fetched: records.length,
      relevantCount: relevantIds.length,
      suggestedDates: Object.assign({}, suggestedDates)
    })
    renderDetailsTab()

    if (roundTrip >= PARAMS.maxRoundTrips) break
  }

  return true
}