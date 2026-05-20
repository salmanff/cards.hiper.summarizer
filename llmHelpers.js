/* LLM call wrapper, cost accumulation, and model-option helpers */

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