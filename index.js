/* Entry point — wires DOM events and kicks off initialisation on DOMContentLoaded */

function bindEvents() {
  document.getElementById('new-query-btn').addEventListener('click', handleNewQuery)
  document.getElementById('send-btn').addEventListener('click', handleSend)
  document.getElementById('cancel-btn').addEventListener('click', handleCancel)
  document.getElementById('save-btn').addEventListener('click', handleSave)

  document.getElementById('tab-details-btn').addEventListener('click', function() { switchTab('details') })
  document.getElementById('tab-results-btn').addEventListener('click', function() { switchTab('results') })

  document.getElementById('sidebar-list').addEventListener('click', handleSidebarClick)
  document.getElementById('details-rounds').addEventListener('click', handleRoundToggleClick)

  var userInput = document.getElementById('user-input')
  userInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSend()
  })
  userInput.addEventListener('input', function() {
    this.style.height = 'auto'
    this.style.height = Math.min(this.scrollHeight, 400) + 'px'
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
    var logsGranted  = perms.find(function(p) { return p.name === 'read_logs'  && p.granted })
    var marksGranted = perms.find(function(p) { return p.name === 'read_marks' && p.granted })
    var llmGranted   = perms.find(function(p) { return p.name === 'ai_access'  && p.granted })

    var missing = []
    if (!logsGranted)  missing.push('Read Browsing Logs')
    if (!marksGranted) missing.push('Read Bookmarks')
    if (!llmGranted)   missing.push('AI/LLM Access')

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

document.addEventListener('DOMContentLoaded', async function() {
  bindEvents()
  setSaveState(true)
  await loadSavedSummaries()
  await initModels()
  await checkPermissions()
})