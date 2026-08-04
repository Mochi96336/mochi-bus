import { installReturnHomeNavigation } from '../navigation/return-home'
import { installInitialMapViewGate } from './initial-view-gate'

installReturnHomeNavigation('.map-home[href="/"]')
installInitialMapViewGate()
