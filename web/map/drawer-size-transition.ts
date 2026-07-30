export type DrawerSize = 'content' | 'compact' | 'standard' | 'tall' | 'expanded'
export type DrawerCameraTransition = 'predict' | 'preserve'

export type DrawerCameraWorkspace = Readonly<{
  view: string
  camera: DrawerCameraTransition
}>

export type DrawerSizeTransition = Readonly<{
  from: DrawerSize
  to: DrawerSize
  durationMs: number
  camera: DrawerCameraTransition
  fromView?: string
  toView: string
  fromCamera: DrawerCameraTransition
  toCamera: DrawerCameraTransition
}>

export const DRAWER_CAMERA_WORKSPACE_EVENT = 'map-drawer-camera-workspace'
export const DRAWER_SIZE_TRANSITION_EVENT = 'map-drawer-size-transition'
