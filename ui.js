/* All DOM rendering, status/processing helpers, and UI state management */

// ============================================
// SAVE / PROCESSING STATE
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
// SIDEBAR
// ============================================

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

// ============================================
// DETAILS TAB — TOP-LEVEL
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

// ============================================
// DETAILS TAB — SUB-SECTIONS
// ============================================

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

function renderPostResultActions() {
  var container = document.getElementById('post-result-actions')
  if (!container) return

  if (!state.currentResult) {
    container.innerHTML = ''
    return
  }

  var relevantCount = Object.keys(state.relevantRecordMap).length
  var strippedNotice = ''

  if (state.recordsNotSaved) {
    strippedNotice =
      '<div style="background:#fff3bf;border:1px solid #ffe066;border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#664d03;">' +
        '<strong>⚠️ Source records not available.</strong> ' +
        'There were too many records to save alongside the summary. ' +
        'Modify and Research More will work in this session (records are in memory), ' +
        'but after a page refresh these actions will start from scratch.' +
      '</div>'
  } else if (relevantCount === 0 && state.isSaved) {
    strippedNotice =
      '<div style="background:#fff3bf;border:1px solid #ffe066;border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#664d03;">' +
        '<strong>⚠️ Source records not in memory.</strong> ' +
        'This summary was loaded from a saved state without its source records. ' +
        'Modify and Research More will regenerate from a fresh search.' +
      '</div>'
  }

  container.innerHTML = strippedNotice +
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

function renderPublishingSection() {
  var container = document.getElementById('publishing-section-container')
  if (!container) return

  var summary = (state.activeSummaryIndex !== null && state.activeSummaryIndex !== undefined)
    ? state.savedSummaries[state.activeSummaryIndex]
    : null

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