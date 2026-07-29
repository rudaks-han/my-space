/**
 * Slack 사이드바 테마 모음 — Slack 설정의 "테마" 목록을 그대로 옮긴 것이다.
 *
 * 디자인 프리셋(`themes.ts`)과는 **다른 축**이다. 프리셋이 앱 전체 색(본문·카드·버튼)을
 * 정하는 반면, 여기 테마는 크롬(상단바 + 좌측 레일 + 상태바) 색 하나만 덮어쓴다.
 * Slack 에서 사이드바 색만 고르는 것과 같은 개념이며, 고르지 않으면 프리셋 색을 쓴다.
 *
 * 색은 Slack 설정 화면 스크린샷의 스와치에서 추출했다. 스와치가 구(球) 모양이라 위쪽에
 * 하이라이트가 얹혀 밝게 찍히므로, 실제 적용색(`chrome`)은 아래쪽 stop 에 가중치를 둔
 * 값이고 `from`/`to` 는 목록의 원형 스와치를 그리는 데만 쓴다.
 * `chromeFg` 는 흰색과 먹색 중 대비가 높은 쪽을 골라 둔 값이다(밝은 테마는 먹색이 된다).
 */

export interface SlackTheme {
  /** 저장 키로 쓰는 고유 id */
  id: string
  /** 목록에 표시할 이름 */
  name: string
  /** 스와치 원의 그라디언트 시작색 */
  from: string
  /** 스와치 원의 그라디언트 끝색 */
  to: string
  /** 실제로 크롬에 칠하는 단색 */
  chrome: string
  /** 크롬 위 글자색(대비로 자동 선택) */
  chromeFg: string
}

export interface SlackThemeGroup {
  label: string
  themes: SlackTheme[]
}

export const SLACK_THEME_GROUPS: SlackThemeGroup[] = [
  {
    label: "Fun and new",
    themes: [
      {
        id: "raspberry-beret",
        name: "Raspberry Beret",
        from: "#EFC0E2",
        to: "#EEA1C3",
        chrome: "#EEACCE",
        chromeFg: "#1D1C1D",
      },
      {
        id: "big-business",
        name: "Big Business",
        from: "#4B4F6C",
        to: "#343F7C",
        chrome: "#3C4576",
        chromeFg: "#FFFFFF",
      },
      {
        id: "pog",
        name: "POG",
        from: "#ECCAAD",
        to: "#E7BE73",
        chrome: "#E9C287",
        chromeFg: "#1D1C1D",
      },
      {
        id: "mint-chip",
        name: "Mint Chip",
        from: "#B2CFC0",
        to: "#97AFD4",
        chrome: "#A0BACD",
        chromeFg: "#1D1C1D",
      },
      {
        id: "pbj",
        name: "PB&J",
        from: "#DDBEB8",
        to: "#D9AAB8",
        chrome: "#DAB1B8",
        chromeFg: "#1D1C1D",
      },
      {
        id: "chill-vibes",
        name: "Chill Vibes",
        from: "#3A7C67",
        to: "#2F6766",
        chrome: "#336E66",
        chromeFg: "#FFFFFF",
      },
      {
        id: "forest-floor",
        name: "Forest Floor",
        from: "#657027",
        to: "#625623",
        chrome: "#635F24",
        chromeFg: "#FFFFFF",
      },
      {
        id: "slackr",
        name: "Slackr",
        from: "#C1C4DE",
        to: "#88C3E5",
        chrome: "#9CC3E3",
        chromeFg: "#1D1C1D",
      },
      {
        id: "sea-glass",
        name: "Sea Glass",
        from: "#BFD4EE",
        to: "#CBB8EE",
        chrome: "#C7C2EE",
        chromeFg: "#1D1C1D",
      },
      {
        id: "lemon-lime",
        name: "Lemon Lime",
        from: "#8B8629",
        to: "#50721F",
        chrome: "#657922",
        chromeFg: "#FFFFFF",
      },
      {
        id: "falling-leaves",
        name: "Falling Leaves",
        from: "#84612B",
        to: "#856624",
        chrome: "#856426",
        chromeFg: "#FFFFFF",
      },
      {
        id: "sunrise",
        name: "Sunrise",
        from: "#F7D1D0",
        to: "#F4BAC8",
        chrome: "#F5C2CB",
        chromeFg: "#1D1C1D",
      },
    ],
  },
  {
    label: "Updated classics",
    themes: [
      {
        id: "choco-mint",
        name: "Choco Mint",
        from: "#554F2E",
        to: "#365038",
        chrome: "#415034",
        chromeFg: "#FFFFFF",
      },
      {
        id: "cmyk",
        name: "CMYK",
        from: "#BFC7E0",
        to: "#D8A3C2",
        chrome: "#CFB0CC",
        chromeFg: "#1D1C1D",
      },
      {
        id: "haberdashery",
        name: "Haberdashery",
        from: "#2B4953",
        to: "#3A4029",
        chrome: "#354338",
        chromeFg: "#FFFFFF",
      },
      {
        id: "hoth",
        name: "Hoth",
        from: "#E0F2F9",
        to: "#C5EBFA",
        chrome: "#CEEDFA",
        chromeFg: "#1D1C1D",
      },
      {
        id: "ochin",
        name: "Ochin",
        from: "#28568F",
        to: "#20467E",
        chrome: "#234C84",
        chromeFg: "#FFFFFF",
      },
      {
        id: "sweet-treat",
        name: "Sweet Treat",
        from: "#F6C6C1",
        to: "#F3B1A9",
        chrome: "#F4B8B1",
        chromeFg: "#1D1C1D",
      },
      {
        id: "kind-of-blue",
        name: "Kind of Blue",
        from: "#7EB3E3",
        to: "#5B8DBB",
        chrome: "#679AC9",
        chromeFg: "#1D1C1D",
      },
      {
        id: "funky-fresh",
        name: "Funky Fresh",
        from: "#ABB7E3",
        to: "#8DC2BD",
        chrome: "#98BECA",
        chromeFg: "#1D1C1D",
      },
      {
        id: "jazz-club",
        name: "Jazz Club",
        from: "#90252E",
        to: "#5E1A39",
        chrome: "#701E35",
        chromeFg: "#FFFFFF",
      },
      {
        id: "electric-fusion",
        name: "Electric Fusion",
        from: "#D1F39D",
        to: "#BDF8AD",
        chrome: "#C4F6A7",
        chromeFg: "#1D1C1D",
      },
      {
        id: "brassy",
        name: "Brassy",
        from: "#E0C564",
        to: "#CBB259",
        chrome: "#D2B95D",
        chromeFg: "#1D1C1D",
      },
      {
        id: "sunglasses-inside",
        name: "Sunglasses Inside",
        from: "#43184C",
        to: "#330F3A",
        chrome: "#391240",
        chromeFg: "#FFFFFF",
      },
    ],
  },
  {
    label: "Single color",
    themes: [
      {
        id: "aubergine",
        name: "Aubergine",
        from: "#4D1B57",
        to: "#3F1246",
        chrome: "#44154C",
        chromeFg: "#FFFFFF",
      },
      {
        id: "clementine",
        name: "Clementine",
        from: "#BE5524",
        to: "#AD4C1F",
        chrome: "#B34F21",
        chromeFg: "#FFFFFF",
      },
      {
        id: "banana",
        name: "Banana",
        from: "#FCEC9B",
        to: "#FAE175",
        chrome: "#FBE582",
        chromeFg: "#1D1C1D",
      },
      {
        id: "jade",
        name: "Jade",
        from: "#3C8060",
        to: "#357156",
        chrome: "#37765A",
        chromeFg: "#FFFFFF",
      },
      {
        id: "lagoon",
        name: "Lagoon",
        from: "#2B608A",
        to: "#264E71",
        chrome: "#28547A",
        chromeFg: "#FFFFFF",
      },
      {
        id: "barbra",
        name: "Barbra",
        from: "#F3B2C9",
        to: "#F19BB7",
        chrome: "#F2A3BD",
        chromeFg: "#1D1C1D",
      },
      {
        id: "gray",
        name: "Gray",
        from: "#E0E1E1",
        to: "#D5D5D7",
        chrome: "#D9D9DA",
        chromeFg: "#1D1C1D",
      },
      {
        id: "mood-indigo",
        name: "Mood Indigo",
        from: "#1B2A7B",
        to: "#13206B",
        chrome: "#162471",
        chromeFg: "#FFFFFF",
      },
    ],
  },
  {
    label: "Vision assistive",
    themes: [
      {
        id: "tritanopia",
        name: "Tritanopia",
        from: "#2B2B2B",
        to: "#090909",
        chrome: "#151515",
        chromeFg: "#FFFFFF",
      },
      {
        id: "protanopia-deuteranopia",
        name: "Protanopia & Deuteranopia",
        from: "#53365A",
        to: "#3B1A43",
        chrome: "#43244B",
        chromeFg: "#FFFFFF",
      },
    ],
  },
]

/** 평탄화 목록(id 로 찾을 때 쓴다). */
export const SLACK_THEMES: SlackTheme[] = SLACK_THEME_GROUPS.flatMap(
  (g) => g.themes
)

/** id 로 테마를 찾는다. 없으면 null(= 프리셋 색을 그대로 쓴다). */
export function getSlackTheme(id: string | null): SlackTheme | null {
  if (!id) return null
  return SLACK_THEMES.find((t) => t.id === id) ?? null
}
