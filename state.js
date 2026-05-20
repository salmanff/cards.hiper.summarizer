/* Shared state and constants — loaded first so all modules can reference them */

const PARAMS = {
  cheapModel: null,
  mainModel: null,
  maxCount: 200,
  maxRoundTrips: 2
}

const MAX_RECORDS_TO_SAVE = 30

const COLLECTION_MAP = {
  logs: 'cards.hiper.freezr.logs',
  marks: 'cards.hiper.freezr.marks'
}

const MAX_PREVIEW_RECORDS = 3

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
  recordsNotSaved: false,

  totalCost: { tokens: 0, inputTokens: 0, outputTokens: 0, inputCost: 0, outputCost: 0, totalCost: 0, details: [] },

  pendingRetry: null,
  isProcessing: false,
  activeTab: 'details',
  lastError: null
}