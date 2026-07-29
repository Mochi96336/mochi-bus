from pathlib import Path

path = Path('web/map/main.ts')
source = path.read_text(encoding='utf-8')


def replace_once(old: str, new: str, label: str) -> None:
    global source
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    source = source.replace(old, new, 1)


replace_once(
    "import { createNearbyPlacesView } from './nearby-places-view'\n",
    "import { createNearbyPlacesView, nearbyPlacesFailureMessage } from './nearby-places-view'\n",
    'nearby failure helper import',
)
replace_once(
    "setStatus(error instanceof Error && error.message ? error.message : '附近站牌讀取失敗', true)",
    'setStatus(nearbyPlacesFailureMessage(error), true)',
    'silent nearby error message',
)
replace_once(
    "onRetry: () => void findNearbyPlaces(origin[0], origin[1], false, 'replace'),",
    "onRetry: () => void findNearbyPlaces(origin[0], origin[1], autoPreview, 'replace'),",
    'nearby retry request',
)

path.write_text(source, encoding='utf-8')
