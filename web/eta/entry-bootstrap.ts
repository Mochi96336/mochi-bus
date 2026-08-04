import { installHomeDepartureTracking } from '../navigation/return-home'
import { restoreHomeViewBeforeMain } from './home-return-snapshot'
import { installStableHomeLayout } from './stable-home-layout'

installStableHomeLayout()
installHomeDepartureTracking()
export const restoredHomeSnapshot = restoreHomeViewBeforeMain()
