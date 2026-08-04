import { discardUntrustedReturnHomeEntry } from '../navigation/return-home-entry'
import { installReturnHomeNavigation } from '../navigation/return-home'
import './initial-view-gate.css'
import { installInitialMapViewGate } from './initial-view-gate'

discardUntrustedReturnHomeEntry()
installReturnHomeNavigation('.map-home[href="/"]')
installInitialMapViewGate()
