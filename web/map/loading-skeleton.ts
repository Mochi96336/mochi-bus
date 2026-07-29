import './loading-skeleton.css'

const loadingRowCount = 3

export function createNearbyPlaceLoadingList(): HTMLDivElement {
  return createLoadingList('nearby-list map-loading-list', createNearbyPlaceSkeleton)
}

export function createPlaceRouteLoadingList(): HTMLDivElement {
  return createLoadingList('place-route-list map-loading-list', createPlaceRouteSkeleton)
}

function createLoadingList(
  className: string,
  createRow: () => HTMLDivElement,
): HTMLDivElement {
  const list = document.createElement('div')
  list.className = className
  list.ariaHidden = 'true'
  for (let index = 0; index < loadingRowCount; index += 1) {
    list.appendChild(createRow())
  }
  return list
}

function createNearbyPlaceSkeleton(): HTMLDivElement {
  const row = document.createElement('div')
  row.className = 'nearby-place-button map-loading-row nearby-place-skeleton'

  const name = document.createElement('strong')
  name.className = 'skeleton-line skeleton-nearby-name'

  const distance = document.createElement('span')
  distance.className = 'skeleton-line skeleton-nearby-distance'

  row.appendChild(name)
  row.appendChild(distance)
  return row
}

function createPlaceRouteSkeleton(): HTMLDivElement {
  const row = document.createElement('div')
  row.className = 'place-route-loading-row map-loading-row'

  const route = document.createElement('div')
  route.className = 'place-route-button'

  const tick = document.createElement('span')
  tick.className = 'route-color-tick'

  const main = document.createElement('span')
  main.className = 'place-route-main'

  const name = document.createElement('strong')
  name.className = 'skeleton-line skeleton-route-name'

  const eta = document.createElement('span')
  eta.className = 'place-route-eta'
  const etaValue = document.createElement('b')
  etaValue.className = 'eta-value skeleton-line skeleton-route-eta-value'
  eta.appendChild(etaValue)

  const detail = document.createElement('small')
  detail.className = 'skeleton-line skeleton-route-detail'

  const favorite = document.createElement('span')
  favorite.className = 'favorite-direction-button skeleton-favorite'

  main.appendChild(name)
  main.appendChild(eta)
  route.appendChild(tick)
  route.appendChild(main)
  route.appendChild(detail)
  row.appendChild(route)
  row.appendChild(favorite)
  return row
}
