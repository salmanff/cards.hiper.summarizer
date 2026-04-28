/* Browse Research Assistant - Sequential per-collection pipeline */

// ============================================
// PARAMETERS (defaults — overridden by tech panel)
// ============================================

const PARAMS = {
  cheapModel: null,
  mainModel: null,
  maxCount: 500,
  maxRoundTrips: 2
}

// ============================================
// CONSTANTS
// ============================================

const COLLECTION_MAP = {
  logs: 'cards.hiper.freezr.logs',
  marks: 'cards.hiper.freezr.marks'
}

const MAX_PREVIEW_RECORDS = 3

// ============================================
// STAGE 1a PROMPT
// ============================================

function buildStage1aPrompt(userQuery) {
  var now = new Date()
  var nowMs = now.getTime()
  var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  var yesterdayStart = todayStart - 86400000
  var weekAgoStart = todayStart - 7 * 86400000
  var monthAgoStart = todayStart - 30 * 86400000
  var currentYear = now.getFullYear()
  var currentMonth = now.getMonth() + 1
  var currentDay = now.getDate()

  return `You are a query planner. You will classify a user request and return a JSON object.

## FACTS (pre-computed — do not recalculate, do not adjust)
TODAY_START_MS   = ${todayStart}
TODAY_END_MS     = ${nowMs}
YESTERDAY_START  = ${yesterdayStart}
YESTERDAY_END    = ${todayStart}
WEEK_START       = ${weekAgoStart}
MONTH_START      = ${monthAgoStart}
NOW              = ${nowMs}
CURRENT_DATE     = ${currentYear}-${String(currentMonth).padStart(2,'0')}-${String(currentDay).padStart(2,'0')}

## USER REQUEST
"${userQuery}"

## TASK
Choose ONE date rule from the list below that best matches the user request.
Then copy the exact ms values shown — do NOT compute new numbers.

DATE RULES:
  RULE A — specific day mentioned (e.g. "March 19", "last Tuesday", "on the 5th"):
    startTime = midnight of that day as Unix ms
    endTime   = startTime + 86400000

  RULE B — "today":
    startTime = TODAY_START_MS = ${todayStart}
    endTime   = TODAY_END_MS   = ${nowMs}

  RULE C — "yesterday":
    startTime = YESTERDAY_START = ${yesterdayStart}
    endTime   = YESTERDAY_END   = ${todayStart}

  RULE D — "last week" / "past 7 days" / "this week":
    startTime = WEEK_START = ${weekAgoStart}
    endTime   = NOW        = ${nowMs}

  RULE E — "last month" / "past 30 days" / "this month":
    startTime = MONTH_START = ${monthAgoStart}
    endTime   = NOW         = ${nowMs}

  RULE F — "recently" / "lately" / no date mentioned:
    startTime = YESTERDAY_START = ${yesterdayStart}
    endTime   = null

  RULE G — specific month name (e.g. "in February", "during March"):
    startTime = first ms of that month (midnight on the 1st)
    endTime   = first ms of the following month

## COLLECTION RULES
- "logs"  → browsing history, pages visited, time spent
- "marks" → bookmarks, saved, starred, highlights, notes
- both   → general / ambiguous queries (default)

## KEYWORD RULE
Only set keyword if the user names a specific brand, website, or person.
Leave null for general topics or concepts.

## OUTPUT
Reply with ONLY valid JSON. No explanation, no markdown, no extra text.
{
  "rule": "<A|B|C|D|E|F|G>",
  "collections": ["logs"] | ["marks"] | ["logs","marks"],
  "suggestedDates": {
    "startTime": <number | null>,
    "endTime": <number | null>
  },
  "keyword": <string | null>
}`
}

// ============================================
// STAGE 1b PROMPT (per-collection)
// ============================================

function buildStage1bPrompt(userQuery, collection, records, roundTrip, totalRelevantSoFar, maxRoundTrips, suggestedDates) {
  var oldestTs = null
  if (records.length > 0) {
    for (var i = 0; i < records.length; i++) {
      var dm = records[i]._date_modified
      if (dm && (oldestTs === null || dm < oldestTs)) oldestTs = dm
    }
  }

  var startTime = suggestedDates && suggestedDates.startTime
  var startTimeStr = startTime
    ? 'Expected range starts at: ' + new Date(startTime).toISOString() + ' (' + startTime + ' ms).'
    : 'No specific start time — fetch until you find enough relevant results.'

  var compactRecords = records.map(function(r) {
    var obj = { _id: r._id }
    if (r.title) obj.title = r.title
    if (r.url) obj.url = r.url
    if (r.domainApp) obj.domainApp = r.domainApp
    if (r.author) obj.author = r.author
    if (r.keywords) obj.keywords = r.keywords
    if (r.vHighlights) obj.vHighlights = r.vHighlights.map(function(h) { return h && h.string ? h.string : null }).filter(function(s) { return s !== null })
    if (r.vComments) obj.vComments = r.vComments
    if (r.description) obj.description = r.description
    if (r.vNote) obj.vNote = r.vNote
    if (r._date_modified) obj._date_modified = r._date_modified
    return obj
  })

  return `You are a relevance filter for the "${collection}" collection. The user wants: "${userQuery}"

Round ${roundTrip} of max ${maxRoundTrips}.
Relevant records found so far in this collection: ${totalRelevantSoFar}
Records in this batch: ${records.length}
Oldest record in this batch: ${oldestTs ? new Date(oldestTs).toISOString() : 'unknown'} (${oldestTs !== null ? oldestTs : 'unknown'} ms)
${startTimeStr}

## TASK 1 — FIND RELEVANT RECORDS
Identify which records below are relevant to the user's request. Be inclusive.
In other words, it is better to have more records (false positives) 
so include any record that could be somehow related to the subject.

## TASK 2 — DECIDE IF DONE
Should we fetch MORE (older) records from "${collection}"?

Return done=true if ANY of these:
- You found enough relevant results AND oldest record is near or older than startTime
- The oldest record is clearly before the user's time frame
- This is round ${maxRoundTrips}

Return done=false if:
${startTime
  ? '- The oldest record (' + (oldestTs ? new Date(oldestTs).toISOString() : 'unknown') + ') is still NEWER than the expected start (' + new Date(startTime).toISOString() + ') — keep fetching to cover that range'
  : '- You believe there are more relevant records further back in time'}

## RESPONSE (valid JSON only):
{
  "relevant": ["id1", "id2", ...],
  "done": true or false,
  "reason": "brief explanation"
}

## RECORDS:
${JSON.stringify(compactRecords, null, 1)}`
}

// ============================================
// STAGE 2 PROMPT
// ============================================

function buildStage2SystemPrompt() {
  return `You are a research assistant that creates beautiful, concise HTML summaries of browsing history data.

## HTML RULES (STRICT)
- Return ONLY inline-styled HTML. No <script>, no <style> tags, no event handlers (onclick etc), no javascript: URLs.
- Use inline style attributes for all visual formatting.
- Make it visually appealing with good typography, cards/grids, spacing.
- Use <a href="..." target="_blank" rel="noopener noreferrer"> for links.
- Be concise — focus on the most relevant items.

## DATA SCHEMA
### logs fields: url, title, domainApp, description, vulog_visits, vulog_ttl_time, vuLog_height, vulog_max_scroll, vCreated, _date_modified
### marks fields: url, title, domainApp, description, vNote, vStars, vHighlights, vComments, vCreated, _date_modified

"vulog_visits" shows all times the page was visited, and vulog_ttl_time shows the total mount of time spent.
"vuLog_height" shows the total height of the page and "vulog_max_scroll" shows the maxikum scrollY, so you can see how much of the page has been read, though this is not a very reliable indicator.
"vStars" can have a "star" (ie favorites) or "inbox" - indictoors given by the user.

## RESPONSE FORMAT
You MUST structure your response using these exact delimiters (no JSON):

===TITLE===
Your summary title here
===HTML===
<div>...your full HTML content here...</div>
===END===

Always include all three delimiters. Put ONLY the title text after ===TITLE=== and ONLY the HTML after ===HTML===.`
}

function compactStage2Records(records) {
  return records.map(function(r) {
    var obj = { _id: r._id }
    if (r.title) obj.title = r.title
    if (r.url) obj.url = r.url
    if (r.domainApp) obj.domainApp = r.domainApp
    if (r.author) obj.author = r.author
    if (r.keywords) obj.keywords = r.keywords
    if (r.vHighlights) obj.vHighlights = r.vHighlights.map(function(h) { return h && h.string ? h.string : null }).filter(function(s) { return s !== null })
    if (r.vCreated) obj.vCreated = r.vCreated
    if (r.vComments) obj.vComments = r.vComments
    if (r.description) obj.description = r.description
    if (r.vNote) obj.vNote = r.vNote
    if (r.vStars) obj.vStars = r.vStars
    if (r.vulog_visits) obj.vulog_visits = r.vulog_visits
    if (r.vulog_ttl_time) obj.vulog_ttl_time = r.vulog_ttl_time
    if (r.vuLog_height) obj.vuLog_height = r.vuLog_height
    if (r.vulog_max_scroll) obj.vulog_max_scroll = r.vulog_max_scroll
    return obj
  })
}
function buildStage2UserPrompt(userQuery, relevantRecords) {


  return `The user asked: "${userQuery}"

Here are the ${relevantRecords.length} potentially relevant records found. 
Parse through them carefully, and assess which ones are related to the user's query.
Pick the best/most relevant ones, and create a comprehensive, well-formatted HTML summary.
You SHOULD NOT explicitly state that the user spent x minutes on the site, or that they scrolled y%
of the site, or that they have marked it with a "star" in vStars. But you can use that data to assess how 
important that page is to the user and so decide how prominently to display the information.
(You can include the above info if the user explicitly asks for it)
You can also use vHighlights to assess a page's importance, but you do not need to show the highlights as
these can take a lot of space. Use good judgement.
(again if the user asks you to show all the highlights you can do so)

Records:
${JSON.stringify(compactStage2Records(relevantRecords), null, 1)}`
}

// ============================================
// APP STATE
// ============================================

const state = {
  _autoMainModel: null,
  _autoCheapModel: null,
  _autoProvider: null,

  mainModel: null,
  cheapModel: null,
  mainProvider: null,
  cheapProvider: null,

  allProviders: {},
  allModels: [],
  providerName: null,

  accessTokens: {},
  allRounds: [],
  relevantRecordMap: {},
  currentUserQuery: '',
  suggestedDates: { startTime: null, endTime: null },
  modifyInstructions: [],

  currentResult: null,
  savedSummaries: [],
  activeSummaryIndex: null,

  isSaved: true,

  totalCost: { tokens: 0, inputTokens: 0, outputTokens: 0, inputCost: 0, outputCost: 0, totalCost: 0, details: [] },

  pendingRetry: null,
  isProcessing: false,
  activeTab: 'details',
  lastError: null
}

// ============================================
// INITIALIZATION
// ============================================

document.addEventListener('DOMContentLoaded', async function() {
  bindEvents()
  setSaveState(true)
  await loadSavedSummaries()
  await initModels()
  await checkPermissions()
})

function pickModelByFamily(models, familyKeyword) {
  var keyword = familyKeyword.toLowerCase()
  var matching = models.filter(function(m) {
    return m.family && m.family.toLowerCase().indexOf(keyword) !== -1
  })
  if (matching.length === 0) return null
  return matching.find(function(m) { return m.latest }) || matching[0]
}

function pickDefaultsForProvider(providerName) {
  var models = state.allProviders[providerName]
  if (!models || models.length === 0) return { mainModel: null, cheapModel: null }

  var isClaudeProvider = providerName.toLowerCase().indexOf('claude') !== -1
  var mainFamilyKeyword  = isClaudeProvider ? 'sonnet' : 'mini'
  var cheapFamilyKeyword = isClaudeProvider ? 'haiku'  : 'nano'

  var mainModelObj  = pickModelByFamily(models, mainFamilyKeyword)
  var cheapModelObj = pickModelByFamily(models, cheapFamilyKeyword)

  if (!mainModelObj) {
    mainModelObj = models.find(function(m) { return m.latest }) || models[0]
  }
  if (!cheapModelObj) {
    cheapModelObj = models.reduce(function(best, m) {
      if (!m.pricing || m.pricing.input == null) return best
      if (!best || m.pricing.input < best.pricing.input) return m
      return best
    }, null) || mainModelObj
  }

  return {
    mainModel:  mainModelObj  ? mainModelObj.id  : null,
    cheapModel: cheapModelObj ? cheapModelObj.id : null
  }
}

async function initModels() {
  try {
    var pingResult = await freezr.llm.ping()
    if (!pingResult || !pingResult.exists) return

    var providers = pingResult.providers
    if (!providers) return

    var providerName = pingResult.defaultProvider
    if (!providerName || !providers[providerName]) {
      providerName = Object.keys(providers)[0]
    }
    if (!providerName) return

    var models = providers[providerName]
    if (!models || models.length === 0) return

    state.allProviders = providers
    state.allModels    = models
    state.providerName = providerName

    var defaults = pickDefaultsForProvider(providerName)

    state._autoMainModel  = defaults.mainModel
    state._autoCheapModel = defaults.cheapModel
    state._autoProvider   = providerName

    state.mainModel     = defaults.mainModel
    state.cheapModel    = defaults.cheapModel
    state.mainProvider  = providerName
    state.cheapProvider = providerName

    console.log('[MODELS] provider:', providerName,
      '| mainModel:', state.mainModel,
      '| cheapModel:', state.cheapModel)

    populateTechPanel()

  } catch (err) {
    console.warn('[MODELS] Could not ping LLM:', err)
  }
}

// ============================================
// TECH PANEL
// ============================================

function populateModelDropdowns(providerName) {
  var mainSelect  = document.getElementById('tech-main-model')
  var cheapSelect = document.getElementById('tech-cheap-model')
  if (!mainSelect || !cheapSelect) return

  var models = state.allProviders[providerName]
  if (!models || models.length === 0) return

  var defaults = pickDefaultsForProvider(providerName)

  function buildOptions(selectEl, defaultModelId) {
    selectEl.innerHTML = ''
    models.forEach(function(m) {
      var option = document.createElement('option')
      option.value = m.id
      var label = m.id
      if (m.pricing && m.pricing.input != null) {
        label += '  ($' + m.pricing.input + '/M)'
      }
      if (m.latest) label += ' ★'
      option.textContent = label
      if (m.id === defaultModelId) option.selected = true
      selectEl.appendChild(option)
    })
  }

  buildOptions(mainSelect,  defaults.mainModel)
  buildOptions(cheapSelect, defaults.cheapModel)
}

function populateTechPanel() {
  var providerSelect = document.getElementById('tech-provider')
  if (!providerSelect) return

  var maxCountEl = document.getElementById('tech-max-count')
  var maxRoundsEl = document.getElementById('tech-max-rounds')
  if (maxCountEl) maxCountEl.value = PARAMS.maxCount
  if (maxRoundsEl) maxRoundsEl.value = PARAMS.maxRoundTrips

  var providerNames = Object.keys(state.allProviders)
  if (providerNames.length === 0) return

  providerSelect.innerHTML = ''
  providerNames.forEach(function(name) {
    var option = document.createElement('option')
    option.value = name
    option.textContent = name
    if (name === state.providerName) option.selected = true
    providerSelect.appendChild(option)
  })

  populateModelDropdowns(state.providerName)
}

function getTechSettings() {
  var maxCountEl     = document.getElementById('tech-max-count')
  var maxRoundsEl    = document.getElementById('tech-max-rounds')
  var providerEl     = document.getElementById('tech-provider')
  var mainSelectEl   = document.getElementById('tech-main-model')
  var cheapSelectEl  = document.getElementById('tech-cheap-model')

  if (maxCountEl) {
    var maxCount = parseInt(maxCountEl.value, 10)
    if (!isNaN(maxCount)) PARAMS.maxCount = Math.max(10, Math.min(5000, maxCount))
  }

  if (maxRoundsEl) {
    var maxRounds = parseInt(maxRoundsEl.value, 10)
    if (!isNaN(maxRounds)) PARAMS.maxRoundTrips = Math.max(1, Math.min(10, maxRounds))
  }

  var chosenProvider = (providerEl && providerEl.value) ? providerEl.value : state._autoProvider

  if (mainSelectEl && mainSelectEl.value) {
    state.mainModel    = mainSelectEl.value
    state.mainProvider = chosenProvider
  }

  if (cheapSelectEl && cheapSelectEl.value) {
    state.cheapModel    = cheapSelectEl.value
    state.cheapProvider = chosenProvider
  }

  console.log('[TECH] provider:', chosenProvider, '| mainModel:', state.mainModel, '| cheapModel:', state.cheapModel)
}

function bindEvents() {
  document.getElementById('new-query-btn').addEventListener('click', handleNewQuery)
  document.getElementById('send-btn').addEventListener('click', handleSend)
  document.getElementById('cancel-btn').addEventListener('click', handleCancel)
  document.getElementById('save-btn').addEventListener('click', handleSave)

  document.getElementById('tab-details-btn').addEventListener('click', function() { switchTab('details') })
  document.getElementById('tab-results-btn').addEventListener('click', function() { switchTab('results') })

  document.getElementById('sidebar-list').addEventListener('click', handleSidebarClick)
  document.getElementById('details-rounds').addEventListener('click', handleRoundToggleClick)

  document.getElementById('user-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSend()
  })

  document.getElementById('tab-details').addEventListener('click', handleDetailsTabClick)

  document.getElementById('tech-provider').addEventListener('change', function() {
    populateModelDropdowns(this.value)
  })

  document.getElementById('tech-toggle').addEventListener('click', function() {
    var panel = document.getElementById('tech-panel')
    var arrow = document.getElementById('tech-toggle-arrow')
    var isOpen = !panel.classList.contains('hidden')
    panel.classList.toggle('hidden', isOpen)
    arrow.classList.toggle('open', !isOpen)
  })
}

async function checkPermissions() {
  try {
    var perms = await freezr.perms.getAppPermissions()
    var logsGranted = perms.find(function(p) { return p.name === 'read_logs' && p.granted })
    var marksGranted = perms.find(function(p) { return p.name === 'read_marks' && p.granted })
    var llmGranted = perms.find(function(p) { return p.name === 'ai_access' && p.granted })

    var missing = []
    if (!logsGranted) missing.push('Read Browsing Logs')
    if (!marksGranted) missing.push('Read Bookmarks')
    if (!llmGranted) missing.push('AI/LLM Access')

    if (missing.length > 0) {
      showStatus('⚠️ Please grant these permissions in Settings: ' + missing.join(', '), true)
      document.getElementById('status-bar').classList.remove('hidden')
      document.getElementById('result-section').classList.remove('hidden')
      document.getElementById('input-section').classList.add('hidden')
    }
  } catch (err) {
    console.warn('[PERMS] Could not check permissions:', err)
  }
}

// ============================================
// TAB MANAGEMENT
// ============================================

function switchTab(tab) {
  state.activeTab = tab
  document.getElementById('tab-details-btn').classList.toggle('active', tab === 'details')
  document.getElementById('tab-results-btn').classList.toggle('active', tab === 'results')
  document.getElementById('tab-details').classList.toggle('hidden', tab !== 'details')
  document.getElementById('tab-results').classList.toggle('hidden', tab !== 'results')
}

// ============================================
// DATA ACCESS
// ============================================

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

// ============================================
// LLM HELPERS
// ============================================

function accumulateCost(result, label) {
  if (!result || !result.meta) return
  var meta = result.meta
  var detail = { label: label, provider: meta.provider, model: meta.model }

  if (meta.tokensUsed) {
    var iQ = (meta.tokensUsed.input && meta.tokensUsed.input.qtty) || 0
    var oQ = (meta.tokensUsed.output && meta.tokensUsed.output.qtty) || 0
    state.totalCost.inputTokens += iQ
    state.totalCost.outputTokens += oQ
    state.totalCost.tokens += iQ + oQ
    detail.inputTokens = iQ
    detail.outputTokens = oQ
  }

  if (meta.cost) {
    state.totalCost.inputCost  += meta.cost.inputCost  || 0
    state.totalCost.outputCost += meta.cost.outputCost || 0
    state.totalCost.totalCost  += meta.cost.totalCost  || 0
    detail.inputCost  = meta.cost.inputCost  || 0
    detail.outputCost = meta.cost.outputCost || 0
    detail.totalCost  = meta.cost.totalCost  || 0
  }

  state.totalCost.details.push(detail)
  updateCostDisplay()
}

async function askLLM(prompt, options) {
  try {
    var result = await freezr.llm.ask(prompt, options || {})
    console.log('[LLM raw result]', {
      model: result && result.meta && result.meta.model,
      success: result && result.success,
      responseType: typeof (result && result.response),
      responsePreview: result && typeof result.response === 'string'
        ? result.response.slice(0, 300)
        : result && result.response
    })
    if (!result || !result.success) {
      return { success: false, error: (result && result.error) || 'LLM request failed', retryable: true }
    }
    return result
  } catch (err) {
    var msg = err && err.message ? err.message : String(err)
    return { success: false, error: msg, retryable: true }
  }
}

function cheapLLMOptions(extra) {
  var opts = Object.assign({}, extra)
  if (state.cheapModel)    opts.model    = state.cheapModel
  if (state.cheapProvider) opts.provider = state.cheapProvider
  return opts
}

function mainLLMOptions(extra) {
  var opts = Object.assign({}, extra)
  if (state.mainModel)    opts.model    = state.mainModel
  if (state.mainProvider) opts.provider = state.mainProvider
  return opts
}

function parseJSON(result) {
  if (typeof result.response === 'object' && result.response !== null) return result.response

  var text = typeof result.response === 'string' ? result.response : JSON.stringify(result.response)

  try { return JSON.parse(text) } catch(e) {}

  var stripped = text
    .replace(/^[\s\S]*?```(?:json)?\s*/i, '')
    .replace(/\s*```[\s\S]*$/i, '')
    .trim()
  try { return JSON.parse(stripped) } catch(e) {}

  var blockSource = stripped.length > 10 ? stripped : text
  var match = blockSource.match(/\{[\s\S]*\}/)
  if (match) {
    try { return JSON.parse(match[0]) } catch(e) {}
  }

  var titleMatch = text.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  var htmlStart = text.indexOf('<div')
  if (htmlStart !== -1) {
    var htmlChunk = text.slice(htmlStart)
    htmlChunk = htmlChunk.replace(/"\s*\}?\s*`*\s*$/, '').trim()
    var title = titleMatch ? titleMatch[1].replace(/\\"/g, '"') : 'Research Summary'
    console.log('[parseJSON] Used HTML extraction fallback — title:', title, '| html length:', htmlChunk.length)
    return { title: title, html: htmlChunk }
  }

  throw new Error('Could not parse LLM response as JSON. Raw: ' + text.slice(0, 300))
}

// ============================================
// HTML SANITIZATION
// ============================================

function sanitizeHTML(html) {
  var s = html.replace(/<script[\s\S]*?<\/script>/gi, '')
  s = s.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  s = s.replace(/javascript\s*:/gi, '')
  return s
}

// ============================================
// SAVE STATE HELPERS
// ============================================

function setSaveState(isSaved) {
  state.isSaved = isSaved
  var saveBtn = document.getElementById('save-btn')
  if (saveBtn) {
    saveBtn.disabled = isSaved
    saveBtn.textContent = 'Save Summary'
  }
}

function checkUnsavedChanges() {
  if (!state.currentResult || state.isSaved) return true
  return confirm('You have unsaved results. Discard them and continue?')
}

// ============================================
// RETRY HANDLING
// ============================================

function showRetryStatus(errorMsg) {
  var bar = document.getElementById('status-bar')
  var statusText = document.getElementById('status-text')
  bar.classList.remove('hidden')
  bar.style.background = '#fff3bf'

  statusText.innerHTML = ''

  var msg = document.createElement('span')
  msg.style.color = '#664d03'
  msg.style.fontWeight = '500'
  msg.textContent = '⚠️ LLM error: ' + (errorMsg || 'server overloaded') + '. '
  statusText.appendChild(msg)

  if (state.pendingRetry) {
    var btn = document.createElement('button')
    btn.textContent = 'Retry'
    btn.className = 'primary-btn'
    btn.style.fontSize = '12px'
    btn.style.padding = '4px 14px'
    btn.style.marginLeft = '10px'
    btn.addEventListener('click', handleRetry)
    statusText.appendChild(btn)
  }
}

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
// SEARCH ONE COLLECTION SEQUENTIALLY
// ============================================

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
      if (suggestedDates && suggestedDates.endTime) {
        dbQuery._date_modified = { $lt: suggestedDates.endTime }
      }
    } else {
      if (oldestTs !== null) {
        dbQuery._date_modified = { $lt: oldestTs }
      }
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
        if (batchOldest === null || dm < batchOldest) batchOldest = dm
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

// ============================================
// STREAMING HELPERS
// ============================================

function extractDelimitedTitle(text) {
  var marker = '===TITLE==='
  var idx = text.indexOf(marker)
  if (idx === -1) return null
  var after = text.slice(idx + marker.length)
  var htmlIdx = after.indexOf('===HTML===')
  var chunk = htmlIdx !== -1 ? after.slice(0, htmlIdx) : after
  var trimmed = chunk.trim()
  return trimmed || null
}

function extractDelimitedHtml(text) {
  var marker = '===HTML==='
  var idx = text.indexOf(marker)
  if (idx === -1) return null
  var after = text.slice(idx + marker.length)
  var endIdx = after.indexOf('===END===')
  var chunk = endIdx !== -1 ? after.slice(0, endIdx) : after
  // Trim leading/trailing whitespace but preserve inner whitespace
  return chunk.replace(/^\s*\n/, '').replace(/\n\s*$/, '') || null
}

// ============================================
// STAGE 2
// ============================================

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

  // Use the final response text (or accumulated) with delimiter extraction
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

// ============================================
// MAIN PIPELINE
// ============================================

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

// ============================================
// POST-RESULT ACTIONS
// ============================================

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

// ============================================
// USER ACTIONS
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

async function handleSave() {
  if (!state.currentResult) return

  var saveBtn = document.getElementById('save-btn')
  saveBtn.disabled = true
  saveBtn.textContent = 'Saving...'

  try {
    var summaryData = {
      title: state.currentResult.title,
      query_text: state.currentUserQuery,
      html: state.currentResult.html,
      modify_instructions: (state.modifyInstructions || []).slice(),
      rounds: state.allRounds.map(function(r) {
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
      }),
      relevant_record_ids: Object.keys(state.relevantRecordMap),
      relevant_records: Object.values(state.relevantRecordMap),
      total_cost: Object.assign({}, state.totalCost),
      suggested_dates: Object.assign({}, state.suggestedDates),
      created_at: Date.now()
    }

    var existingSummary = (state.activeSummaryIndex !== null && state.activeSummaryIndex !== undefined)
      ? state.savedSummaries[state.activeSummaryIndex]
      : null
    var existingId = existingSummary && existingSummary._id

    if (existingId) {
      // Preserve published_versions when updating
      if (Array.isArray(existingSummary.published_versions)) {
        summaryData.published_versions = existingSummary.published_versions
      }
      summaryData.created_at = existingSummary.created_at || summaryData.created_at
      await freezr.update('summaries', existingId, summaryData)
      summaryData._id = existingId
      state.savedSummaries[state.activeSummaryIndex] = summaryData
    } else {
      var result = await freezr.create('summaries', summaryData)
      summaryData._id = result._id
      state.savedSummaries.unshift(summaryData)
      state.activeSummaryIndex = 0
    }

    renderSidebar()
    setSaveState(true)
    renderDetailsTab()
    saveBtn.textContent = 'Saved ✓'
    setTimeout(function() {
      saveBtn.textContent = 'Save Summary'
    }, 2000)
  } catch (err) {
    console.error('Failed to save summary:', err)
    saveBtn.textContent = 'Save Failed'
    saveBtn.disabled = false
  }
}

function handleNewQuery() {
  if (!checkUnsavedChanges()) return

  state.activeSummaryIndex = null
  state.pendingRetry = null
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

// ============================================
// PUBLISH
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

    // Read back the published record to inspect _accessibles
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

    // Also check if shareResult itself carries the code/public_id
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

  // Find the version entry so we know whether it was public or privatelink
  var versionEntry = null
  if (summary && Array.isArray(summary.published_versions)) {
    versionEntry = summary.published_versions.find(function(v) { return v._id === publishedId }) || null
  }
  var grantee = (versionEntry && versionEntry.type === 'privatelink') ? '_privatelink' : '_public'

  console.log('[UNPUBLISH] publishedId:', publishedId, '| grantee:', grantee, '| versionEntry:', JSON.stringify(versionEntry))

  try {
    // Step 1: Revoke public/private access — removes the copy from public_records
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

    // Step 2: Delete the published record itself
    await freezr.delete('published', publishedId)
    console.log('[UNPUBLISH] deleted published record:', publishedId)

    // Step 3: Remove from summary's published_versions and save
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
// DELETE SUMMARY
// ============================================

function renderChangeTitleSection() {
  var container = document.getElementById('change-title-container')
  if (!container) return

  if (state.activeSummaryIndex === null || state.activeSummaryIndex === undefined) {
    container.innerHTML = ''
    return
  }

  var summary = state.savedSummaries[state.activeSummaryIndex]
  if (!summary || !summary._id) {
    container.innerHTML = ''
    return
  }

  var currentTitle = escapeHtml(state.currentResult ? state.currentResult.title : (summary.title || ''))

  container.innerHTML =
    '<div class="details-block" style="margin-top:8px;">' +
      '<div class="details-label">Change Title</div>' +
      '<div style="display:flex;gap:8px;align-items:center;">' +
        '<input id="change-title-input" type="text" value="' + currentTitle + '" ' +
          'style="flex:1;padding:8px 10px;border:1px solid #dee2e6;border-radius:6px;font-size:14px;font-family:inherit;background:white;" />' +
        '<button id="change-title-save-btn" class="primary-btn" style="font-size:13px;padding:8px 18px;flex-shrink:0;">Save</button>' +
      '</div>' +
    '</div>'
}

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

function renderDeleteButton() {
  var container = document.getElementById('delete-summary-container')
  if (!container) return

  if (state.activeSummaryIndex === null || state.activeSummaryIndex === undefined) {
    container.innerHTML = ''
    return
  }

  var summary = state.savedSummaries[state.activeSummaryIndex]
  if (!summary || !summary._id) {
    container.innerHTML = ''
    return
  }

  container.innerHTML =
    '<div style="text-align:center;margin:48px 0 40px 0;">' +
      '<button id="delete-summary-btn" class="secondary-btn" ' +
        'style="color:#c92a2a;border-color:#ffc9c9;background:#fff5f5;">' +
        'Delete Summary' +
      '</button>' +
    '</div>'
}

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
// DETAILS TAB RENDERING
// ============================================

function renderDetailsTab() {
  renderQueryInfo()
  renderCostBreakdown()
  renderRounds()
  renderModifyHistory()
  renderPostResultActions()
  renderPublishingSection()
  renderChangeTitleSection()
  renderDeleteButton()
}

function renderPublishingSection() {
  var container = document.getElementById('publishing-section-container')
  if (!container) return

  var summary = (state.activeSummaryIndex !== null && state.activeSummaryIndex !== undefined)
    ? state.savedSummaries[state.activeSummaryIndex]
    : null

  // Only show publishing section for saved summaries with a result
  if (!summary || !summary._id || !state.currentResult) {
    container.innerHTML = ''
    return
  }

  var versions = Array.isArray(summary.published_versions) ? summary.published_versions : []
  var disabledAttr = state.isProcessing ? ' disabled' : ''

  console.log('[RENDER PUBLISHING] versions:', JSON.stringify(versions))

  var html = '<div class="details-block" style="margin-top:8px;">'
  html += '<div class="details-label" style="margin-bottom:12px;">Publishing</div>'

  html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:' + (versions.length > 0 ? '16px' : '4px') + ';">'
  html += '<button id="publish-public-btn" class="primary-btn" style="font-size:13px;padding:8px 18px;"' + disabledAttr + '>🌐 Publish Publicly</button>'
  html += '<button id="publish-private-btn" class="primary-btn" style="font-size:13px;padding:8px 18px;"' + disabledAttr + '>🔒 Create Private Link</button>'
  html += '</div>'

  if (versions.length > 0) {
    html += '<div class="published-versions-header">Published Versions (' + versions.length + ')</div>'

    versions.slice().reverse().forEach(function(v) {
      var dateStr = v.created_at ? new Date(v.created_at).toLocaleString() : ''
      var isPrivate = v.type === 'privatelink'
      var publicPath = v.public_id ? ('/' + v.public_id) : null
      var accessUrl = isPrivate && v.code && publicPath
        ? (publicPath + '?code=' + v.code)
        : publicPath

      console.log('[RENDER PUBLISHING] version entry:', JSON.stringify(v),
        '| isPrivate:', isPrivate,
        '| publicPath:', publicPath,
        '| accessUrl:', accessUrl)

      html += '<div class="published-version-item">'
      html += '<div class="published-version-info">'

      html += '<div class="published-version-title">' + escapeHtml(v.title || 'Untitled')
      html += ' <span style="font-size:10px;padding:2px 7px;border-radius:10px;font-weight:600;' +
        (isPrivate
          ? 'background:#fff3bf;color:#664d03;'
          : 'background:#d3f9d8;color:#1a5c2a;') + '">'
      html += isPrivate ? '🔒 Private' : '🌐 Public'
      html += '</span></div>'

      html += '<div class="published-version-date">' + escapeHtml(dateStr) + '</div>'

      if (isPrivate && v.code) {
        html += '<div style="font-size:11px;color:#495057;margin-top:4px;">'
        html += 'Code: <code style="background:#f1f3f5;padding:2px 6px;border-radius:3px;font-size:11px;">' + escapeHtml(v.code) + '</code>'
        html += '</div>'
      }

      html += '</div>'

      if (accessUrl) {
        html += '<a class="published-version-link" href="' + escapeHtml(accessUrl) + '" target="_blank" rel="noopener noreferrer">View</a>'
      } else {
        html += '<span style="font-size:11px;color:#adb5bd;padding:4px 8px;">No URL yet</span>'
      }

      html += '<button class="published-version-delete" data-action="delete-published" data-published-id="' + escapeHtml(v._id) + '">Unpublish</button>'
      html += '</div>'
    })
  }

  html += '</div>'
  container.innerHTML = html
}

function renderQueryInfo() {
  var el = document.getElementById('details-query-text')
  var valueEl = document.getElementById('details-query-value')
  if (state.currentUserQuery) {
    var dateInfo = ''
    if (state.suggestedDates && (state.suggestedDates.startTime || state.suggestedDates.endTime)) {
      var parts = []
      if (state.suggestedDates.startTime) parts.push('from ' + new Date(state.suggestedDates.startTime).toLocaleDateString())
      if (state.suggestedDates.endTime) parts.push('to ' + new Date(state.suggestedDates.endTime).toLocaleDateString())
      dateInfo = ' (' + parts.join(' ') + ')'
    }
    valueEl.textContent = state.currentUserQuery + dateInfo
    el.classList.remove('hidden')
  } else {
    el.classList.add('hidden')
  }
}

function renderCostBreakdown() {
  var costEl = document.getElementById('details-cost')
  var costValueEl = document.getElementById('details-cost-value')
  var c = state.totalCost

  if (c.details && c.details.length > 0) {
    var rows = c.details.map(function(d) {
      var inTok = d.inputTokens || 0
      var outTok = d.outputTokens || 0
      var cost = d.totalCost ? ('$' + d.totalCost.toFixed(5)) : '—'
      return '<tr>' +
        '<td>' + escapeHtml(d.label || '') + '</td>' +
        '<td>' + escapeHtml(d.model || '—') + '</td>' +
        '<td>' + inTok.toLocaleString() + '</td>' +
        '<td>' + outTok.toLocaleString() + '</td>' +
        '<td>' + cost + '</td>' +
        '</tr>'
    }).join('')

    var totalCostStr = c.totalCost > 0 ? ('$' + c.totalCost.toFixed(5)) : '—'
    rows += '<tr>' +
      '<td colspan="2"><strong>Total</strong></td>' +
      '<td>' + c.inputTokens.toLocaleString() + '</td>' +
      '<td>' + c.outputTokens.toLocaleString() + '</td>' +
      '<td><strong>' + totalCostStr + '</strong></td>' +
      '</tr>'

    costValueEl.innerHTML = '<table class="cost-table">' +
      '<thead><tr><th>Step</th><th>Model</th><th>In tokens</th><th>Out tokens</th><th>Cost</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>'
    costEl.classList.remove('hidden')
  } else {
    costEl.classList.add('hidden')
  }
}

function renderRounds() {
  var container = document.getElementById('details-rounds')
  if (!container) return
  if (state.allRounds.length === 0) { container.innerHTML = ''; return }

  var openRounds = {}
  container.querySelectorAll('.round-card').forEach(function(card) {
    var rIdx = card.getAttribute('data-round-index')
    var body = card.querySelector('.round-card-body')
    if (body && !body.classList.contains('hidden')) openRounds[rIdx] = true
  })

  var html = ''

  state.allRounds.forEach(function(round, rIdx) {
    var isOpen = (rIdx in openRounds) ? openRounds[rIdx] : (rIdx === state.allRounds.length - 1)
    var colNames = round.collectionsData ? Object.keys(round.collectionsData).join(', ') : '—'

    html += '<div class="round-card" data-round-index="' + rIdx + '">'

    html += '<div class="round-card-header" data-toggle="round" data-round-index="' + rIdx + '">'
    html += '<span class="round-badge">' + round.roundTrip + '</span>'
    html += '<span class="round-card-title">Round ' + round.roundTrip + ' — ' + escapeHtml(colNames) + '</span>'
    html += '<span class="round-card-meta">fetched: ' + (round.fetched || 0) + ' · relevant: ' + (round.relevantCount || 0) + '</span>'
    html += '<span class="round-toggle' + (isOpen ? ' open' : '') + '">▼</span>'
    html += '</div>'

    html += '<div class="round-card-body' + (isOpen ? '' : ' hidden') + '">'

    if (round.collectionsData) {
      Object.keys(round.collectionsData).forEach(function(col) {
        var cd = round.collectionsData[col]
        var queryObj = {}
        if (cd.query) {
          if (typeof cd.query === 'string') {
            try { queryObj = JSON.parse(cd.query) } catch(e) { queryObj = cd.query }
          } else {
            queryObj = cd.query
          }
        }

        html += '<div class="col-section">'
        html += '<div class="col-section-header">'
        html += '<span class="col-badge col-badge-' + col + '">' + col + '</span>'
        if (cd.done) html += '<span class="col-done-tag">✓ done</span>'
        html += '</div>'

        html += '<div class="query-filter-label">Query</div>'
        html += '<div class="query-filter-code">' + escapeHtml(JSON.stringify(queryObj, null, 2)) + '</div>'

        html += '<div class="round-stats-row">'
        html += '<span class="round-stat"><strong>' + (cd.fetched || 0) + '</strong> fetched</span>'
        html += '<span class="round-stat relevant"><strong>' + (cd.relevantCount || 0) + '</strong> relevant</span>'
        if (cd.oldestTimestamp) {
          html += '<span class="round-stat">oldest: ' + new Date(cd.oldestTimestamp).toLocaleDateString() + '</span>'
        }
        html += '</div>'

        if (cd.reason) {
          html += '<div class="thinking-block"><div class="thinking-label">LLM Decision</div>' + escapeHtml(cd.reason) + '</div>'
        }

        if (cd.fetchError) {
          html += '<div class="query-error-box">⚠️ ' + escapeHtml(cd.fetchError) + '</div>'
        }

        if (cd.relevantIds && cd.relevantIds.length > 0) {
          html += '<div class="results-preview-label">Relevant (' + cd.relevantIds.length + ')</div>'
          cd.relevantIds.slice(0, MAX_PREVIEW_RECORDS).forEach(function(id) {
            var rec = state.relevantRecordMap[id]
            if (!rec) return
            html += '<div class="result-record">'
            html += '<div class="result-record-title">' + escapeHtml(rec.title || rec.url || '(no title)') + '</div>'
            if (rec.url) html += '<div class="result-record-url">' + escapeHtml(rec.url) + '</div>'
            var meta = []
            if (rec.domainApp) meta.push(rec.domainApp)
            if (rec.vulog_visits) meta.push(rec.vulog_visits + ' visits')
            if (rec.vStars) meta.push('★'.repeat(Math.min(rec.vStars, 5)))
            if (rec._date_modified) meta.push(new Date(rec._date_modified).toLocaleDateString())
            if (meta.length > 0) {
              html += '<div class="result-record-meta">' + meta.map(escapeHtml).join(' · ') + '</div>'
            }
            html += '</div>'
          })
          if (cd.relevantIds.length > MAX_PREVIEW_RECORDS) {
            html += '<div class="results-more">+ ' + (cd.relevantIds.length - MAX_PREVIEW_RECORDS) + ' more</div>'
          }
        }

        html += '</div>'
      })
    }

    if (round.suggestedDates && (round.suggestedDates.startTime || round.suggestedDates.endTime)) {
      html += '<div class="date-range-info">'
      html += '<span class="date-range-label">Date range: </span>'
      if (round.suggestedDates.startTime) html += new Date(round.suggestedDates.startTime).toLocaleDateString()
      if (round.suggestedDates.startTime && round.suggestedDates.endTime) html += ' → '
      if (round.suggestedDates.endTime) html += new Date(round.suggestedDates.endTime).toLocaleDateString()
      html += '</div>'
    }

    html += '</div>'
    html += '</div>'
  })

  container.innerHTML = html
}

function renderModifyHistory() {
  var container = document.getElementById('modify-history')
  if (!container) return

  var instructions = state.modifyInstructions || []
  if (instructions.length === 0) {
    container.innerHTML = ''
    return
  }

  var html = ''
  instructions.forEach(function(item) {
    var dateStr = item.timestamp ? new Date(item.timestamp).toLocaleString() : ''
    html += '<div class="modify-history-card">'
    html += '<div class="modify-history-label">Modify instruction · ' + escapeHtml(dateStr) + '</div>'
    html += '<div class="modify-history-text">' + escapeHtml(item.instruction) + '</div>'
    html += '</div>'
  })

  container.innerHTML = html
}

function buildActionModelHtml(prefix, includeCheap) {
  var html = ''
  html += '<div style="display:flex;justify-content:flex-end;margin-top:6px;">'
  html += '<div class="tech-toggle" id="' + prefix + '-model-toggle" style="margin:0;">'
  html += '<span class="tech-toggle-arrow" id="' + prefix + '-model-arrow">▶</span>'
  html += '<span class="tech-toggle-text">Model Settings</span>'
  html += '</div>'
  html += '</div>'
  html += '<div id="' + prefix + '-model-panel" class="hidden" style="margin-top:8px;background:#f8f9fa;border:1px solid #e9ecef;border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;">'

  html += '<div class="tech-row">'
  html += '<label class="tech-label" style="min-width:120px;" for="' + prefix + '-provider">Provider</label>'
  html += '<select id="' + prefix + '-provider" class="tech-select"></select>'
  html += '</div>'

  html += '<div class="tech-row">'
  html += '<div class="tech-label-group" style="min-width:120px;">'
  html += '<label class="tech-label" for="' + prefix + '-main-model">' + (includeCheap ? 'Summary Model' : 'Model') + '</label>'
  if (includeCheap) html += '<div class="tech-model-hint">Generates the final summary</div>'
  html += '</div>'
  html += '<select id="' + prefix + '-main-model" class="tech-select"></select>'
  html += '</div>'

  if (includeCheap) {
    html += '<div class="tech-row">'
    html += '<div class="tech-label-group" style="min-width:120px;">'
    html += '<label class="tech-label" for="' + prefix + '-cheap-model">Filtering Model</label>'
    html += '<div class="tech-model-hint">Filters records for relevance</div>'
    html += '</div>'
    html += '<select id="' + prefix + '-cheap-model" class="tech-select"></select>'
    html += '</div>'
  }

  html += '</div>'
  return html
}

function populateActionModels(prefix, includeCheap) {
  var providerSelect = document.getElementById(prefix + '-provider')
  if (!providerSelect) return

  var providerNames = Object.keys(state.allProviders)
  if (providerNames.length === 0) return

  providerSelect.innerHTML = ''
  providerNames.forEach(function(name) {
    var option = document.createElement('option')
    option.value = name
    option.textContent = name
    if (name === (state.mainProvider || state.providerName)) option.selected = true
    providerSelect.appendChild(option)
  })

  rebuildActionModelOptions(prefix, providerSelect.value, includeCheap)

  providerSelect.addEventListener('change', function() {
    rebuildActionModelOptions(prefix, this.value, includeCheap)
  })

  var toggle = document.getElementById(prefix + '-model-toggle')
  if (toggle) {
    toggle.addEventListener('click', function() {
      var panel = document.getElementById(prefix + '-model-panel')
      var arrow = document.getElementById(prefix + '-model-arrow')
      if (panel && arrow) {
        var isOpen = !panel.classList.contains('hidden')
        panel.classList.toggle('hidden', isOpen)
        arrow.classList.toggle('open', !isOpen)
      }
    })
  }
}

function rebuildActionModelOptions(prefix, providerName, includeCheap) {
  var models = state.allProviders[providerName]
  if (!models || models.length === 0) return

  var defaults = pickDefaultsForProvider(providerName)

  function fillSelect(selectId, currentModelId, defaultModelId) {
    var sel = document.getElementById(selectId)
    if (!sel) return
    sel.innerHTML = ''
    var hasCurrentModel = false
    models.forEach(function(m) {
      var option = document.createElement('option')
      option.value = m.id
      var label = m.id
      if (m.pricing && m.pricing.input != null) label += '  ($' + m.pricing.input + '/M)'
      if (m.latest) label += ' ★'
      option.textContent = label
      if (m.id === currentModelId) { option.selected = true; hasCurrentModel = true }
      sel.appendChild(option)
    })
    if (!hasCurrentModel && defaultModelId) {
      sel.value = defaultModelId
    }
  }

  fillSelect(prefix + '-main-model', state.mainModel, defaults.mainModel)
  if (includeCheap) {
    fillSelect(prefix + '-cheap-model', state.cheapModel, defaults.cheapModel)
  }
}

function applyActionModelSettings(prefix, includeCheap) {
  var providerEl = document.getElementById(prefix + '-provider')
  var mainModelEl = document.getElementById(prefix + '-main-model')

  if (providerEl && providerEl.value) {
    var chosenProvider = providerEl.value
    if (mainModelEl && mainModelEl.value) {
      state.mainModel = mainModelEl.value
      state.mainProvider = chosenProvider
    }
    if (includeCheap) {
      var cheapModelEl = document.getElementById(prefix + '-cheap-model')
      if (cheapModelEl && cheapModelEl.value) {
        state.cheapModel = cheapModelEl.value
        state.cheapProvider = chosenProvider
      }
    }
    console.log('[ACTION MODEL] prefix:', prefix, '| provider:', chosenProvider,
      '| mainModel:', state.mainModel, includeCheap ? ('| cheapModel:' + state.cheapModel) : '')
  }
}

function renderPostResultActions() {
  var container = document.getElementById('post-result-actions')
  if (!container) return

  if (!state.currentResult) {
    container.innerHTML = ''
    return
  }

  var relevantCount = Object.keys(state.relevantRecordMap).length

  container.innerHTML =
    '<div class="post-result-action-card">' +
      '<div class="details-label">Research More</div>' +
      '<p class="post-result-hint">Fetch older records or search further back in time.</p>' +
      '<textarea id="action-research-more-input" class="action-textarea" placeholder="Optional: refine what you\'re looking for..." rows="2"></textarea>' +
      buildActionModelHtml('research', true) +
      '<button id="action-research-more-btn" class="primary-btn" style="margin-top:10px;"' + (state.isProcessing ? ' disabled' : '') + '>Research More</button>' +
    '</div>' +
    '<div class="post-result-action-card">' +
      '<div class="details-label">Modify Summary</div>' +
      '<p class="post-result-hint">Ask the AI to change the style, focus, or format of the current summary (' + relevantCount + ' records available).</p>' +
      '<textarea id="action-modify-input" class="action-textarea" placeholder="e.g. Show only results from the last 3 days, or group by domain..." rows="2"></textarea>' +
      buildActionModelHtml('modify', false) +
      '<button id="action-modify-btn" class="primary-btn" style="margin-top:10px;"' + (state.isProcessing ? ' disabled' : '') + '>Modify Page</button>' +
    '</div>'

  populateActionModels('research', true)
  populateActionModels('modify', false)
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

// ============================================
// SIDEBAR
// ============================================

async function loadSavedSummaries() {
  try {
    var results = await freezr.query('summaries', {}, { sort: { created_at: -1 }, count: 100 })
    state.savedSummaries = Array.isArray(results) ? results : []
    renderSidebar()
  } catch (err) {
    console.warn('Failed to load saved summaries:', err)
  }
}

function renderSidebar() {
  var list = document.getElementById('sidebar-list')
  if (state.savedSummaries.length === 0) {
    list.innerHTML = '<div class="sidebar-empty">No saved summaries yet.</div>'
    return
  }
  list.innerHTML = state.savedSummaries.map(function(s, i) {
    var date = s.created_at ? new Date(s.created_at).toLocaleDateString() : ''
    var isActive = state.activeSummaryIndex === i

    var publishIcons = ''
    if (Array.isArray(s.published_versions) && s.published_versions.length > 0) {
      var hasPublic  = s.published_versions.some(function(v) { return v.type === 'public' })
      var hasPrivate = s.published_versions.some(function(v) { return v.type === 'privatelink' })
      if (hasPublic)  publishIcons += '<span title="Published publicly" style="font-size:11px;">🌐</span>'
      if (hasPrivate) publishIcons += '<span title="Private link exists" style="font-size:11px;">🔒</span>'
    }

    return '<div class="sidebar-item' + (isActive ? ' active' : '') + '" data-index="' + i + '">' +
      '<div class="sidebar-item-title">' + escapeHtml(s.title || 'Untitled') + '</div>' +
      '<div class="sidebar-item-date">' + date + (publishIcons ? ' ' + publishIcons : '') + '</div>' +
      '</div>'
  }).join('')
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
// UI HELPERS
// ============================================

function setProcessing(isProcessing) {
  state.isProcessing = isProcessing
  var sendBtn = document.getElementById('send-btn')
  var cancelBtn = document.getElementById('cancel-btn')
  var input = document.getElementById('user-input')

  sendBtn.disabled = isProcessing
  input.disabled = isProcessing
  cancelBtn.classList.toggle('hidden', !isProcessing)

  var researchBtn = document.getElementById('action-research-more-btn')
  var modifyBtn = document.getElementById('action-modify-btn')
  if (researchBtn) researchBtn.disabled = isProcessing
  if (modifyBtn) modifyBtn.disabled = isProcessing
}

function showStatus(text, isWarning) {
  var bar = document.getElementById('status-bar')
  var statusText = document.getElementById('status-text')
  bar.classList.remove('hidden')
  statusText.textContent = text
  bar.style.background = isWarning ? '#fff3bf' : '#eef2ff'
  statusText.style.color = isWarning ? '#664d03' : '#3b5bdb'
}

function updateCostDisplay() {
  var costEl = document.getElementById('cost-display')
  var c = state.totalCost
  var parts = []
  if (c.tokens > 0) parts.push(c.tokens.toLocaleString() + ' tokens')
  if (c.totalCost > 0) parts.push('$' + c.totalCost.toFixed(5))
  costEl.textContent = parts.join(' • ')
}

function escapeHtml(str) {
  if (str === null || str === undefined) return ''
  var div = document.createElement('div')
  div.textContent = String(str)
  return div.innerHTML
}