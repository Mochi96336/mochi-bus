export type DrawerSize = 'content' | 'compact' | 'standard' | 'tall' | 'expanded'

export type DrawerSizeTransition = Readonly<{
  from: DrawerSize
  to: DrawerSize
  durationMs: number
}>

export const DRAWER_SIZE_TRANSITION_EVENT = 'map-drawer-size-transition'
