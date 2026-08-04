import { restoredHomeSnapshot } from '../eta/entry-bootstrap'
import '../eta/main'
import {
  installHomeViewSnapshotPersistence,
  reapplyHomeViewAfterMain,
} from '../eta/home-return-snapshot'

reapplyHomeViewAfterMain(restoredHomeSnapshot)
installHomeViewSnapshotPersistence()
