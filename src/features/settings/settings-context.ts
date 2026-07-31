import { createContext, useContext } from "react"

import {
  DEFAULT_SPECIES,
  PET_SPECIES,
  isBuiltinSprite,
} from "@/features/pet/pet-species"

/*
 * 설정의 타입·기본값·Context·훅. SettingsProvider(컴포넌트)는 settings-store.tsx 에 있다.
 * 컴포넌트 파일이 컴포넌트 외의 값을 export 하면 fast refresh 가 깨지므로 여기로 분리했다.
 */

/** 앱 전반(특정 기능에 속하지 않는) 설정. */
export interface GeneralSettings {
  /**
   * 로그인(macOS 시작) 시 앱을 자동 실행한다. 기본값 켜짐 — 이 앱은 트레이에 상주해
   * 작업 감시·알림을 돌리는 것이 주 목적이라, 켜 두지 않으면 그 기능이 무의미해진다.
   *
   * 실제 등록은 OS 쪽(macOS: `~/Library/LaunchAgents` 플리스트)이고 이 값은 **의도**만
   * 담는다. 둘을 맞추는 일은 `use-autostart.ts` 가 앱 시작 시·토글 시 한다.
   */
  autoStart: boolean
}

/** Claude Code 관련 설정. */
export interface ClaudeCodeSettings {
  /**
   * 작업 감시 on/off. herdr 작업 상태를 주기적으로 폴링해 작업목록 실시간 갱신·
   * 트레이 팝오버 질문·완료/대기 알림을 구동한다. 끄면 이 모든 실시간 동작이 멈춘다.
   */
  watchEnabled: boolean
  /** 입력 대기(AskUserQuestion·권한 프롬프트) 진입 시 인앱 알림(토스트) 표시. */
  notifyOnBlocked: boolean
  /** 작업이 끝났을 때(진행 중 → 완료/대기) 인앱 알림(토스트) 표시. */
  notifyOnDone: boolean
}

/** Slack 관련 설정. */
export interface SlackSettings {
  /** 안 읽은 메시지 자동 새로고침(폴링) 주기(초). */
  pollSeconds: number
}

/** Flex(휴가) 관련 설정. */
export interface FlexSettings {
  /**
   * Flex 워크스페이스 기본 URL. 로그인/기본 진입에 쓴다.
   * 사내에서 별도 서브도메인을 쓰면 그 값으로 바꾼다.
   */
  workspaceUrl: string
  /**
   * 팀 휴가(구성원 일정) 페이지 URL. Flex 웹에서 해당 페이지를 연 뒤 주소창의 URL을
   * 그대로 붙여넣는다. 비어 있으면 workspaceUrl 로 진입한다.
   */
  vacationUrl: string
}

/** Gmail 관련 설정 — "관심 대상" 메일을 정의하는 필터. */
export interface GmailSettings {
  /**
   * 관심 발신자. 메일의 보낸사람 주소에 이 문자열이 포함되면 관심 메일로 본다.
   * 전체 주소(a@b.com)든 도메인 조각(@team.com)이든 된다.
   */
  senders: string[]
  /**
   * 관심 키워드. 메일 제목·미리보기에 이 문자열이 포함되면 관심 메일로 본다.
   */
  keywords: string[]
}

/** Cowork spec 문서 관련 설정. */
export interface CoworkSettings {
  /**
   * cowork 홈 디렉터리. 이 아래 `.cowork/specs` 에서 스펙 문서를 찾는다.
   * `~` 는 홈으로 펼쳐진다.
   */
  home: string
  /**
   * 마크다운 뷰어에 주입할 스타일(css) 원문 — **덮어쓰기용**이라 기본값은 빈 문자열이다.
   * 비어 있으면 앱에 번들된 기본 테마(`cowork-spec/bundled-css.ts`)를 쓰므로, Typora 가
   * 없는 사람도 그대로 잘 보인다. 자기 Typora 테마 css 를 가져오면 여기에 저장되고
   * 번들 스타일 대신 적용된다.
   */
  markdownCss: string
  /** "스타일 가져오기" 가 읽어올 Typora 테마 css 경로(`~` 지원). */
  cssPath: string
}

/** 데스크톱 펫(상시 표시 캐릭터 창) 설정. */
export interface PetSettings {
  /**
   * 캐릭터를 화면 위에 상시 표시한다(모든 데스크톱에 항상 위). 끄면 `pet` 창을 숨긴다 —
   * 알림은 기존 트레이 팝오버로만 뜬다.
   */
  enabled: boolean
  /** 알림·질문이 있을 때 캐릭터 위에 말풍선을 띄운다. 끄면 표정·움직임만 바뀐다. */
  bubble: boolean
  /**
   * 마우스 이벤트를 통과시킨다. 켜면 펫이 뒤 창의 클릭을 막지 않지만,
   * 그 대가로 펫을 클릭·드래그할 수도 없다(장식 전용).
   */
  clickThrough: boolean
  /** 캐릭터 크기 배율(0.8 작게 / 1 보통 / 1.3 크게). */
  scale: number
  /** 캐릭터 종류 id — `pet-species.ts` 의 PET_SPECIES 참고. */
  species: string
  /**
   * `species: "custom"` 일 때 쓸 이미지의 data URL. 파일 경로를 그대로 두면
   * 파일이 사라졌을 때 빈 창이 되고 창마다 다시 읽어야 하므로, 불러온 시점에
   * 내용을 박아 둔다(cowork 의 markdownCss 와 같은 방식).
   */
  customImage: string
  /** "이미지 불러오기" 가 읽어올 파일 경로(`~` 지원). 다시 불러올 때 쓴다. */
  customImagePath: string
  /**
   * `species: "petdex"` 일 때 읽을 Codex 펫 패키지 폴더(`pet.json` + 스프라이트시트).
   * 시트는 ~2MB 라 내용을 저장하지 않고 경로만 둔다 — 펫 창이 그때그때 읽어 메모리에 든다.
   */
  petdexDir: string
  /** 고른 패키지 이름(폴더를 못 읽을 때 무엇을 고른 것인지 보여 주기 위해). */
  petdexName: string
  /**
   * 스프라이트 프레임의 세로비(높이/폭). 시트를 읽기 전에 창 크기를 잡는 데 쓴다 —
   * 없으면 첫 표시에서 캐릭터 위가 잘린다.
   */
  petdexAspect: number
  /**
   * `species: "anim"` 일 때 동작별로 재생할 이미지 경로(GIF·APNG·애니메이션 WebP).
   * 움직이는 이미지는 수 MB 가 흔해 내용을 저장하면 localStorage 한도를 넘기므로
   * 경로만 둔다 — 펫 창이 그때그때 읽는다(`pet-anim.ts`).
   */
  animPaths: { idle: string; running: string; busy: string; waiting: string }
  /**
   * 캐릭터를 눌렀을 때 위로 펼쳐질 빠른 이동 아이콘들의 메뉴 id 목록(`menus.tsx` 의 MENUS).
   * 표시 순서는 사이드바 순서를 따르므로 이 배열의 순서는 의미가 없다(집합처럼 쓴다).
   * 아이콘을 누르면 Rust `pet_open_menu` 가 메인 창을 띄우고 그 메뉴 탭을 연다.
   */
  dialMenus: string[]
  /**
   * Claude Code 알림(작업 완료 등)을 보여 줄 시간(초). **0 = 항상 표시**(치울 때까지).
   *
   * 두 곳이 이 값을 함께 써야 한다: 말풍선 유지 시간(`usePetMood`)과, 상시 표시를 꺼 뒀을 때
   * 펫이 떠 있는 시간(Rust `present_until`). 한쪽만 바꾸면 같은 알림이 설정에 따라
   * 다른 시간 동안 보인다 — 그래서 PetController 가 `pet_set_notice_ttl` 로 Rust 에 밀어 넣는다.
   */
  noticeSeconds: number
}

/**
 * 앱 전체 설정.
 * ★ 설정 카테고리 추가 지점 ★ — 새 카테고리는 여기에 필드를 추가하고
 * DEFAULT_SETTINGS 에 기본값을, settings-view.tsx 의 CATEGORIES 에 화면을 추가한다.
 */
export interface AppSettings {
  general: GeneralSettings
  claudeCode: ClaudeCodeSettings
  slack: SlackSettings
  gmail: GmailSettings
  flex: FlexSettings
  cowork: CoworkSettings
  pet: PetSettings
}

export const DEFAULT_SETTINGS: AppSettings = {
  general: {
    autoStart: true,
  },
  claudeCode: {
    watchEnabled: true,
    notifyOnBlocked: true,
    notifyOnDone: true,
  },
  slack: {
    pollSeconds: 120,
  },
  gmail: {
    senders: [],
    keywords: [],
  },
  flex: {
    workspaceUrl: "https://flex.team",
    vacationUrl: "",
  },
  cowork: {
    home: "/Users/rudaks/_WORK/_ENOMIX_GIT/spectrakr/cowork",
    markdownCss: "",
    cssPath:
      "~/Library/Application Support/abnerworks.Typora/themes/rudaks.css",
  },
  pet: {
    enabled: false,
    bubble: true,
    clickThrough: false,
    scale: 1,
    species: DEFAULT_SPECIES,
    customImage: "",
    customImagePath: "",
    petdexDir: "",
    petdexName: "",
    // 192×208 규격 기본값.
    petdexAspect: 208 / 192,
    animPaths: { idle: "", running: "", busy: "", waiting: "" },
    dialMenus: ["home", "gmail", "slack", "claude-bridge"],
    noticeSeconds: 12,
  },
}

/** 설정 저장 키. */
export const SETTINGS_STORAGE_KEY = "myspace.settings"

/**
 * 저장된 값에 기본값을 병합한다. 앱 버전이 올라가 새 설정 키가 생겨도(오래된 저장값에
 * 그 키가 없어도) 항상 완전한 설정 객체를 얻도록 카테고리별로 얕은 병합한다.
 */
export function withDefaults(
  stored: Partial<AppSettings> | null | undefined
): AppSettings {
  return {
    general: { ...DEFAULT_SETTINGS.general, ...(stored?.general ?? {}) },
    claudeCode: {
      ...DEFAULT_SETTINGS.claudeCode,
      ...(stored?.claudeCode ?? {}),
    },
    slack: { ...DEFAULT_SETTINGS.slack, ...(stored?.slack ?? {}) },
    gmail: { ...DEFAULT_SETTINGS.gmail, ...(stored?.gmail ?? {}) },
    flex: { ...DEFAULT_SETTINGS.flex, ...(stored?.flex ?? {}) },
    cowork: { ...DEFAULT_SETTINGS.cowork, ...(stored?.cowork ?? {}) },
    pet: migratePet({ ...DEFAULT_SETTINGS.pet, ...(stored?.pet ?? {}) }),
  }
}

/**
 * 내장 애니메이션이 생기기 전에 `~/.petdex` 폴더로 같은 캐릭터를 쓰던 설정을 옮긴다.
 * 폴더 이름이 내장 id 와 같으면(예: `~/.petdex/pets/guga`) 내장 쪽으로 바꾼다 — 그림은
 * 같은 시트인데 폴더가 사라지면 펫이 빈 창이 되므로, 붙어 있을 이유가 없는 의존이다.
 *
 * `petdexDir` 는 지우지 않는다. `Petdex 폴더` 를 다시 고르면 그대로 쓰이고, 이 함수는
 * species 가 이미 내장 id 면 손대지 않으므로 두 번 돌아도 결과가 같다.
 *
 * 사라진 종류로 저장돼 있으면 기본값으로 되돌린다 — 배포 전에 내장 시트에서 뺀
 * 캐릭터(실존 인물 그림)를 고른 채로 남아 있으면 펫이 빈 창이 되기 때문이다.
 */
function migratePet(pet: PetSettings): PetSettings {
  if (pet.species === "petdex") {
    const slug = pet.petdexDir.replace(/\/+$/, "").split("/").pop() ?? ""
    return isBuiltinSprite(slug) ? { ...pet, species: slug } : pet
  }
  const known = PET_SPECIES.some((s) => s.id === pet.species)
  return known ? pet : { ...pet, species: DEFAULT_SPECIES }
}

export interface SettingsContextValue {
  settings: AppSettings
  /** 앱 전반 설정 일부를 갱신한다. */
  setGeneral: (patch: Partial<GeneralSettings>) => void
  /** Claude Code 설정 일부를 갱신한다. */
  setClaudeCode: (patch: Partial<ClaudeCodeSettings>) => void
  /** Slack 설정 일부를 갱신한다. */
  setSlack: (patch: Partial<SlackSettings>) => void
  /** Gmail 설정 일부를 갱신한다. */
  setGmail: (patch: Partial<GmailSettings>) => void
  /** Flex 설정 일부를 갱신한다. */
  setFlex: (patch: Partial<FlexSettings>) => void
  /** Cowork spec 설정 일부를 갱신한다. */
  setCowork: (patch: Partial<CoworkSettings>) => void
  /** 데스크톱 펫 설정 일부를 갱신한다. */
  setPet: (patch: Partial<PetSettings>) => void
}

export const SettingsContext = createContext<SettingsContextValue | null>(null)

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext)
  if (!ctx) {
    throw new Error(
      "useSettings 는 SettingsProvider 안에서만 사용할 수 있습니다."
    )
  }
  return ctx
}
