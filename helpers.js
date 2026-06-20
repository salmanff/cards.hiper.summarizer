/* Pure utility functions — no side effects, no DOM access */

function escapeHtml(str) {
  if (str === null || str === undefined) return ''
  var div = document.createElement('div')
  div.textContent = String(str)
  return div.innerHTML
}

function sanitizeHTML(html) {
  var s = html.replace(/<script[\s\S]*?<\/script>/gi, '')
  s = s.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  s = s.replace(/javascript\s*:/gi, '')
  return s
}

function formatQueryDisplay(queryObj) {
  if (!queryObj || typeof queryObj !== 'object') {
    try { return JSON.stringify(queryObj, null, 2) } catch (e) { return String(queryObj) }
  }
  var clone
  try { clone = JSON.parse(JSON.stringify(queryObj)) } catch (e) { return JSON.stringify(queryObj, null, 2) }

  if (clone._date_modified && typeof clone._date_modified === 'object') {
    var dm = clone._date_modified
    var readable = {}
    Object.keys(dm).forEach(function(op) {
      var label = op
      if (op === '$lt') label = 'before'
      else if (op === '$lte') label = 'before or on'
      else if (op === '$gt') label = 'after'
      else if (op === '$gte') label = 'on or after'
      var num = Number(dm[op])
      readable[label] = isNaN(num)
        ? dm[op]
        : new Date(num).toLocaleString() + '  (' + num + ')'
    })
    clone._date_modified = readable
  }
  return JSON.stringify(clone, null, 2)
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
  return chunk.replace(/^\s*\n/, '').replace(/\n\s*$/, '') || null
}

// ============================================
// DATE PLAN → TIMESTAMPS (done in code, never by the LLM)
// ============================================

// Resolve which year the user meant when they did NOT type one.
// Rule: pick the most recent occurrence of (month[/day]) that has already begun.
function resolveYear(explicitYear, month, day) {
  if (explicitYear && !isNaN(Number(explicitYear))) return Number(explicitYear)
  var now = new Date()
  var currentYear = now.getFullYear()
  if (!month) return currentYear
  var candidate = new Date(currentYear, Number(month) - 1, day ? Number(day) : 1).getTime()
  return candidate <= Date.now() ? currentYear : currentYear - 1
}

// Convert the Stage 1a plan (rule + date components) into { startTime, endTime } ms.
// All arithmetic happens here so the LLM never has to compute epoch values.
function computeDatesFromPlan(plan) {
  var DAY = 86400000
  var now = Date.now()
  var d = new Date()
  var todayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

  var rule = plan && plan.rule ? String(plan.rule).toUpperCase() : 'F'
  var date = (plan && plan.date) || {}

  switch (rule) {
    case 'B': // today
      return { startTime: todayStart, endTime: now }
    case 'C': // yesterday — include today too, so end at now
      return { startTime: todayStart - DAY, endTime: now }
    case 'D': // recently / this week / past 7 days
      return { startTime: todayStart - 7 * DAY, endTime: now }
    case 'E': // last month / past 30 days
      return { startTime: todayStart - 30 * DAY, endTime: now }
    case 'H': { // vague relative period — LLM estimates the window in days
      var rel = (plan && plan.relative) || {}
      var startDays = Number(rel.daysAgoStart)
      var endDays = Number(rel.daysAgoEnd)
      if (isNaN(startDays)) startDays = 14
      if (isNaN(endDays)) endDays = 0
      if (endDays > startDays) { var swap = startDays; startDays = endDays; endDays = swap }
      return {
        startTime: now - startDays * DAY,
        endTime: endDays <= 0 ? now : now - endDays * DAY
      }
    }
    case 'A': { // specific day
      var yearA = resolveYear(date.year, date.month, date.day)
      var monthA = (date.month ? Number(date.month) : 1) - 1
      var dayA = date.day ? Number(date.day) : 1
      var startA = new Date(yearA, monthA, dayA).getTime()
      return { startTime: startA, endTime: startA + DAY }
    }
    case 'G': { // specific month
      var yearG = resolveYear(date.year, date.month, null)
      var monthG = (date.month ? Number(date.month) : 1) - 1
      var startG = new Date(yearG, monthG, 1).getTime()
      var endG = new Date(yearG, monthG + 1, 1).getTime()
      return { startTime: startG, endTime: endG }
    }
    case 'F': // no date hint at all — default to since yesterday, up to now
    default:
      return { startTime: todayStart - DAY, endTime: now }
  }
}