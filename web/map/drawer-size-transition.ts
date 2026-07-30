export type DrawerSize = 'content' | 'compact' | 'standard' | 'tall' | 'expanded'
export type DrawerCameraTransition = 'predict' | 'preserve'

export type DrawerSizeTransition = Readonly<{
  from: DrawerSize
  to: DrawerSize
  durationMs: number
  camera: DrawerCameraTransition
}>

export const DRAWER_SIZE_TRANSITION_EVENT = 'map-drawer-size-transition'
