import { assertOperationCityEnabled } from './operations-plan.mjs'

const city = process.argv[2]
if (!city) throw new Error('Usage: node scripts/instance/assert-operation-city.mjs <city>')

const enabledCity = assertOperationCityEnabled(city)
console.log(JSON.stringify({ message: 'instance_operation_city_enabled', city: enabledCity }))
