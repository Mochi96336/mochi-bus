import { discardUntrustedReturnHomeEntry } from '../navigation/return-home-entry'
import { installReturnHomeNavigation } from '../navigation/return-home'

discardUntrustedReturnHomeEntry()
installReturnHomeNavigation('.brand[href="/"], .topbar .icon-link[href="/"]')
