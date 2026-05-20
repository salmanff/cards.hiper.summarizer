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