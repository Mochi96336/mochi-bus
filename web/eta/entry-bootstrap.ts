import { installHomeDepartureTracking } from '../navigation/return-home'
import { discardStaleHomeSnapshot } from './home-snapshot-freshness'
import { restoreHomeViewBeforeMain } from './home-return-snapshot'
import { installStableHomeLayout } from './stable-home-layout'

installStableHomeLayout()
installHomeDepartureTracking()
discardStaleHomeSnapshot()
export const restoredHomeSnapshot = restoreHomeViewBeforeMain()
