export const DEFAULT_CITIES = [
  'Taipei', 'NewTaipei', 'Taoyuan', 'Keelung', 'Taichung',
  'Tainan', 'Kaohsiung', 'Chiayi', 'MiaoliCounty',
]

export const ALL_CITIES = new Set([
  'Taipei', 'NewTaipei', 'Taoyuan', 'Keelung', 'Hsinchu', 'HsinchuCounty',
  'MiaoliCounty', 'Taichung', 'ChanghuaCounty', 'NantouCounty', 'YunlinCounty',
  'Chiayi', 'ChiayiCounty', 'Tainan', 'Kaohsiung', 'PingtungCounty', 'YilanCounty',
  'HualienCounty', 'TaitungCounty', 'PenghuCounty', 'KinmenCounty', 'LienchiangCounty',
])

export const MATCHER_SOURCE = 'src/domain/map/shape-pattern-matcher.ts'
export const SUPPORTED_MATCHER_GIT_BLOB_SHA1 = 'fc67cdecd785e89b9b08937edab156ade430198b'
export const HARNESS_VERSION = 3
export const REPORT_SCHEMA_VERSION = 3
export const RAW_SCHEMA_VERSION = 2
export const DEFAULT_RAW_DIR = '.tdx-measurement/raw'
export const DEFAULT_REPORT_DIR = '.tdx-measurement/reports'
export const DEFAULT_GENERATED_DIR = '.tdx-measurement/generated'
export const DEFAULT_FETCH_CONCURRENCY = 2
export const DEFAULT_MAX_ATTEMPTS = 5
export const DEFAULT_TIMEOUT_MS = 20_000
export const DEFAULT_TOP_OUTLIERS = 10
export const REPORT_FILES = [
  'metadata.json', 'partitions.jsonl', 'pairs.jsonl',
  'outcomes.json', 'outliers.json', 'summary.json',
]
export const COMPLETION_FILE = 'completion.json'
