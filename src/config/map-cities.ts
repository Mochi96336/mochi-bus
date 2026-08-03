import { instanceRuntime } from '../instance-runtime'

export type MapCity = {
  code: string
  name: string
  region: 'north' | 'central' | 'south' | 'east' | 'islands'
  center: [number, number]
  // 縣市按鈕在區域總覽的視覺偏移(像素,+x 右 +y 下),不影響 center 的實際地理定位。
  // 只給幾個中心點物理距離太近、按鈕會疊在一起的縣市(市被縣包住的那幾組)。
  labelOffset?: [number, number]
}

export const mapCities: MapCity[] = [
  // 北部六縣市擠在同一個視窗:偏移量以「扇形展開」配置,基隆右上、臺北正上、
  // 新北正下、桃園左下,兩個新竹一左一右,區域總覽 zoom 7–8 才不會疊成一疊。
  { code: 'Taipei', name: '臺北', region: 'north', center: [25.052, 121.548], labelOffset: [6, -20] },
  { code: 'NewTaipei', name: '新北', region: 'north', center: [25.013, 121.465], labelOffset: [2, 18] },
  { code: 'Taoyuan', name: '桃園', region: 'north', center: [24.993, 121.301], labelOffset: [-30, 6] },
  { code: 'Keelung', name: '基隆', region: 'north', center: [25.128, 121.741], labelOffset: [26, -16] },
  { code: 'Hsinchu', name: '新竹市', region: 'north', center: [24.804, 120.968], labelOffset: [-30, 10] },
  { code: 'HsinchuCounty', name: '新竹縣', region: 'north', center: [24.839, 121.018], labelOffset: [16, -6] },
  { code: 'MiaoliCounty', name: '苗栗', region: 'central', center: [24.56, 120.821] },
  { code: 'Taichung', name: '臺中', region: 'central', center: [24.147, 120.674], labelOffset: [10, -10] },
  { code: 'ChanghuaCounty', name: '彰化', region: 'central', center: [24.076, 120.544], labelOffset: [-12, 10] },
  { code: 'NantouCounty', name: '南投', region: 'central', center: [23.91, 120.684] },
  { code: 'YunlinCounty', name: '雲林', region: 'central', center: [23.708, 120.535] },
  { code: 'Chiayi', name: '嘉義市', region: 'south', center: [23.48, 120.449], labelOffset: [14, -8] },
  { code: 'ChiayiCounty', name: '嘉義縣', region: 'south', center: [23.452, 120.255], labelOffset: [-16, 10] },
  { code: 'Tainan', name: '臺南', region: 'south', center: [22.997, 120.212] },
  { code: 'Kaohsiung', name: '高雄', region: 'south', center: [22.627, 120.301], labelOffset: [-12, 8] },
  { code: 'PingtungCounty', name: '屏東', region: 'south', center: [22.672, 120.488], labelOffset: [14, -8] },
  { code: 'YilanCounty', name: '宜蘭', region: 'east', center: [24.754, 121.754] },
  { code: 'HualienCounty', name: '花蓮', region: 'east', center: [23.992, 121.611] },
  { code: 'TaitungCounty', name: '臺東', region: 'east', center: [22.755, 121.15] },
  { code: 'PenghuCounty', name: '澎湖', region: 'islands', center: [23.571, 119.579] },
  { code: 'KinmenCounty', name: '金門', region: 'islands', center: [24.432, 118.318] },
  { code: 'LienchiangCounty', name: '馬祖', region: 'islands', center: [26.16, 119.951] },
]

const enabledCityCodes = new Set(instanceRuntime.transit.enabledCities)
export const enabledMapCities = mapCities.filter((city) => enabledCityCodes.has(city.code))
