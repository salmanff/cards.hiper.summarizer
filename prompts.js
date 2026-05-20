/* LLM prompt builder functions and record compaction helpers */

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

function buildStage1bPrompt(userQuery, collection, records, roundTrip, totalRelevantSoFar, maxRoundTrips, suggestedDates) {
  var oldestTs = null
  var newestTs = null
  if (records.length > 0) {
    for (var i = 0; i < records.length; i++) {
      var dm = records[i]._date_modified
      if (dm) {
        var dmNum = Number(dm)
        if (!isNaN(dmNum)) {
          if (oldestTs === null || dmNum < oldestTs) oldestTs = dmNum
          if (newestTs === null || dmNum > newestTs) newestTs = dmNum
        }
      }
    }
  }

  var startTime = suggestedDates && suggestedDates.startTime
  var endTime = suggestedDates && suggestedDates.endTime
  var startTimeStr = startTime
    ? 'Query date range: ' + new Date(startTime).toISOString() + ' → ' + (endTime ? new Date(endTime).toISOString() : 'now') + '.'
    : 'No specific start time — fetch until you find enough relevant results.'

  // How many records in this batch actually fall inside the query range?
  var inRangeCount = 0
  if (startTime) {
    for (var j = 0; j < records.length; j++) {
      var dmj = Number(records[j]._date_modified)
      if (!isNaN(dmj) && dmj >= Number(startTime) && (!endTime || dmj <= Number(endTime))) inRangeCount++
    }
  }

  var batchRangeStr = (newestTs !== null && oldestTs !== null)
    ? 'This batch spans ' + new Date(newestTs).toISOString() + ' (newest) → ' + new Date(oldestTs).toISOString() + ' (oldest).'
    : 'Batch date range: unknown.'

  var compactRecords = records.map(function(r) {
    var obj = { _id: r._id }
    if (r.title) obj.title = r.title
    if (r.url) obj.url = r.url
    if (r.domainApp) obj.domainApp = r.domainApp
    if (r.author) obj.author = r.author
    if (r.keywords) obj.keywords = r.keywords
    if (r.vHighlights) obj.vHighlights = r.vHighlights.map(function(h) {
      if (!h) return null
      var out = {}
      if (h.string) out.string = h.string
      if (h.vImages) out.vImages = h.vImages
      return (out.string || out.vImages) ? out : null
    }).filter(function(s) { return s !== null })
    if (r.vComments) obj.vComments = r.vComments
    if (r.description) obj.description = r.description
    if (r.vNote) obj.vNote = r.vNote
    if (r._date_created) obj._date_created = r._date_created
    return obj
  })

  return `You are a relevance filter for the "${collection}" collection. The user wants: "${userQuery}"

Round ${roundTrip} of max ${maxRoundTrips}.
Relevant records found so far in this collection: ${totalRelevantSoFar}
Records in this batch: ${records.length}
${batchRangeStr}
${startTimeStr}
${startTime ? 'Records in THIS batch that fall inside the query date range: ' + inRangeCount + ' out of ' + records.length + '.' : ''}

## IMPORTANT — HOW RECORDS ARE SORTED
The records below are sorted by \`_date_modified\` DESCENDING (newest first, oldest last).
A batch where the OLDEST record is before \`startTime\` typically still contains many records INSIDE the date range — they sit at the top of the list. **You must inspect every record's own \`_date_modified\` individually.** Do NOT assume all records share the date of the oldest one.

## TASK 1 — FIND RELEVANT RECORDS
For EACH record in the list below, decide:
  (a) Is the record's own \`_date_modified\` inside the user's date range? ${startTime ? '(>= ' + startTime + (endTime ? ' AND <= ' + endTime : '') + ')' : '(no strict range — any date OK)'}
  (b) Is the record topically relevant to: "${userQuery}"?

Mark the record as relevant ONLY if BOTH (a) and (b) are true. Be inclusive on topic — false positives on topic are fine. But be strict on date — records outside the range must NEVER be marked relevant, even if topically perfect.

${startTime && inRangeCount > 0
  ? '⚠️ This batch contains ' + inRangeCount + ' record(s) inside the date range. Even if the oldest record in the batch is before startTime, you MUST still go through the in-range records and pick out the topically relevant ones. Do not return an empty relevant array just because the batch crosses the startTime boundary.'
  : ''}

## TASK 2 — DECIDE IF DONE
Should we fetch MORE (older) records from "${collection}"? This is independent of TASK 1 — answer TASK 1 fully before deciding here.

Return done=true if ANY of these:
- ${startTime ? 'The oldest record in this batch (' + (oldestTs ? new Date(oldestTs).toISOString() : 'unknown') + ') is dated BEFORE the query start (' + new Date(startTime).toISOString() + ') — meaning the batch has already reached past the beginning of the date range and the next round would be entirely outside it' : 'You have found enough relevant results'}
- No records were returned in this batch
- This is round ${maxRoundTrips}

Return done=false ONLY if:
${startTime
  ? '- The oldest record (' + (oldestTs ? new Date(oldestTs).toISOString() : 'unknown') + ') is dated AFTER the query start (' + new Date(startTime).toISOString() + ') — meaning there are likely more records within the range still to fetch'
  : '- You believe there are more relevant records further back in time'}

## RESPONSE (valid JSON only):
{
  "relevant": ["id1", "id2", ...],
  "done": true or false,
  "reason": "brief explanation — if you returned an empty relevant array, justify by reference to specific record dates, not just the oldest"
}

## RECORDS:
${JSON.stringify(compactRecords, null, 1)}`
}

function buildStage2SystemPrompt() {
  return `You are a research assistant that creates beautiful, concise HTML summaries of browsing history data.

## HTML RULES (STRICT)
- Return ONLY inline-styled HTML. No <script>, no <style> tags, no event handlers (onclick etc), no javascript: URLs.
- Use inline style attributes for all visual formatting.
- Make it visually appealing with good typography, cards/grids, spacing.
- Use <a href="..." target="_blank" rel="noopener noreferrer"> for links.
- Be concise — focus on the most relevant items.

## DATA SCHEMA
### logs fields: url, title, domainApp, description, vulog_visits, vulog_ttl_time, vuLog_height, vulog_max_scroll, vCreated, _date_modified, _date_created
### marks fields: url, title, domainApp, description, vNote, vStars, vHighlights, vComments, vCreated, _date_modified, _date_created

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
    if (r.vHighlights) obj.vHighlights = r.vHighlights.map(function(h) {
      if (!h) return null
      var out = {}
      if (h.string) out.string = h.string
      if (h.vImages) out.vImages = h.vImages
      return (out.string || out.vImages) ? out : null
    }).filter(function(s) { return s !== null })
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
You can also use vHighlights to assess a page's importance, but if there are a lot of highlights, you do 
not need to show all of them, as these can take a lot of space. Use good judgement.
(Of course,  if the user asks you to show all the highlights you can do so)
vHighlights can also have vImages tag that shows the images that were highlighted - vImages is a list of
objects with a url and an al tag. If a highlight has any vImages, and no string, then it is an 
image-only highlight and you should show the image in the summary, since the user probably wanted to see the visual content.

**IMPORTANT — DATE FILTER:** The user's original request may specify a date range. Before including any record in your summary, verify its \`_date_modified\` or \`_date_created\` timestamps fall within the period the user asked about. Do NOT include records from outside that period even if they are topically related. If after filtering by date there are few or no records, say so clearly rather than padding with out-of-range content.

Records:
${JSON.stringify(compactStage2Records(relevantRecords), null, 1)}`
}