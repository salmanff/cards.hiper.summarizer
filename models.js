/* LLM provider/model discovery, tech-panel population, and model-settings helpers */

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
      mainSelect === selectEl
        ? (m.id === defaults.mainModel  ? option.selected = true : null)
        : (m.id === defaults.cheapModel ? option.selected = true : null)
      selectEl.appendChild(option)
    })
    // Ensure correct default is selected
    selectEl.value = defaultModelId || ''
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