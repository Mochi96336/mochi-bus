const WRITABLE_TABLES = Object.freeze(['routes', 'patterns', 'stop_places'])
const TABLE_PATTERN = WRITABLE_TABLES.join('|')
const WRITE_STATEMENT = new RegExp(
  `^(?:INSERT\\s+(?:OR\\s+REPLACE\\s+)?INTO|DELETE\\s+FROM)\\s+(${TABLE_PATTERN})\\b`,
  'i',
)

export function splitSqlStatements(sql) {
  if (typeof sql !== 'string') throw new TypeError('SQL source must be a string')
  const statements = []
  let start = 0
  let inSingleQuote = false
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]
    if (char === "'") {
      if (inSingleQuote && sql[index + 1] === "'") {
        index += 1
        continue
      }
      inSingleQuote = !inSingleQuote
      continue
    }
    if (char === ';' && !inSingleQuote) {
      const statement = sql.slice(start, index + 1).trim()
      if (statement) statements.push(statement)
      start = index + 1
    }
  }
  if (inSingleQuote) throw new Error('SQL source contains an unterminated single-quoted string')
  const tail = sql.slice(start).trim()
  if (tail) statements.push(tail)
  return Object.freeze(statements)
}

export function classifyPublisherD1Statement(statement) {
  if (typeof statement !== 'string') return null
  const match = statement.trimStart().match(WRITE_STATEMENT)
  return match ? match[1].toLowerCase() : null
}

export function segmentPublisherD1Sql(sql) {
  const statements = splitSqlStatements(sql)
  if (statements.length === 0) return Object.freeze([])
  const segments = []
  let prefix = []
  let current = null

  for (const statement of statements) {
    const table = classifyPublisherD1Statement(statement)
    if (table === null) {
      if (current) current.statements.push(statement)
      else prefix.push(statement)
      continue
    }
    if (!current || current.table !== table) {
      if (current) segments.push(freezeSegment(current))
      current = { table, statements: [...prefix, statement] }
      prefix = []
    } else {
      current.statements.push(statement)
    }
  }

  if (current) {
    current.statements.push(...prefix)
    segments.push(freezeSegment(current))
  } else {
    segments.push(freezeSegment({ table: 'unattributed', statements: prefix }))
  }
  return Object.freeze(segments)
}

export function parseWranglerD1ImportJson(stdout) {
  const text = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout ?? '')
  const parsed = JSON.parse(text)
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  if (entries.length === 0) throw new Error('Wrangler D1 import returned no result entries')

  let rowsWritten = 0
  let rowsRead = 0
  let queryCount = 0
  let durationMs = 0
  for (const entry of entries) {
    if (!entry || entry.success !== true) throw new Error('Wrangler D1 import did not report success')
    const summary = Array.isArray(entry.results) ? entry.results[0] : null
    rowsWritten += nonNegativeInteger(entry.meta?.rows_written ?? summary?.['Rows written'], 'rows_written')
    rowsRead += nonNegativeInteger(entry.meta?.rows_read ?? summary?.['Rows read'] ?? 0, 'rows_read')
    const queries = entry.meta?.num_queries ?? summary?.['Total queries executed'] ?? 0
    queryCount += nonNegativeInteger(queries, 'query_count')
    const duration = Number(entry.meta?.duration ?? 0)
    if (!Number.isFinite(duration) || duration < 0) throw new Error('Wrangler D1 import duration is invalid')
    durationMs += duration
  }
  return Object.freeze({ rowsWritten, rowsRead, queryCount, durationMs })
}

function freezeSegment(segment) {
  const statements = [...segment.statements]
  return Object.freeze({
    table: segment.table,
    statements: Object.freeze(statements),
    writeStatementCount: statements.filter((statement) => classifyPublisherD1Statement(statement) === segment.table).length,
    sql: `${statements.join('\n')}\n`,
  })
}

function nonNegativeInteger(value, label) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Wrangler D1 import ${label} is invalid`)
  return number
}
