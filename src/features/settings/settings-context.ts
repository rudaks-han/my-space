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

/**
 * 어떤 터미널 도구로 Claude Code 작업을 감시할지. **지원하는 터미널은 herdr·cmux·Orca 셋뿐이다.**
 *
 * 세션 목록은 (1) 어떤 터미널 pane 이 어떤 Claude 세션인지, (2) 그 세션이 지금 진행
 * 중인지 대기 중인지를 터미널 쪽에서 받아야 성립한다. herdr 는 소켓 API 로, cmux 는
 * 이벤트 로그(`~/.cmuxterm/events.jsonl` 의 `agent.hook.*`)로, Orca 는 훅 상태 파일
 * (`~/Library/Application Support/orca/agent-hooks/last-status.json`)로 그 둘을 내주지만,
 * 순수 터미널 에뮬레이터(Ghostty·iTerm2·Terminal)는 어느 쪽도 알려 주지 않는다.
 *
 * **여러 개를 동시에 켠다.** 하나만 보면 반쪽만 보이기 때문이다(herdr 만 보면 다른 터미널에서
 * 바로 띄운 세션이 빠지고, cmux 만 보면 cmux 안에서 herdr 로 띄운 세션들이 한 탭으로 뭉친다).
 * 모든 백엔드가 같은 Claude `session_id` 를 들고 있어서 중복 제거가 된다.
 */
export type ClaudeWatchTerminal = "herdr" | "cmux" | "orca"

/** 고를 수 있는 감시 대상 전부(설정 화면의 나열 순서이기도 하다). */
export const CLAUDE_WATCH_TERMINALS: ClaudeWatchTerminal[] = [
  "herdr",
  "cmux",
  "orca",
]

/**
 * 사용자에게 보여줄 백엔드 이름. 설정 문구와 세션 목록의 오류 문구가 같은 표현을 쓰도록
 * 한곳에 둔다(`"herdr,orca"` 처럼 저장값이 그대로 새는 것을 막는다).
 */
export function watchBackendLabel(b: ClaudeWatchTerminal[]): string {
  return b.length === 0 ? "감시 안 함" : b.join(" · ")
}

/**
 * 예전 단일 선택 값(`"herdr"` / `"cmux"` / `"both"`)을 목록으로 옮긴다.
 *
 * `"both"` 는 **"그때 있던 전부"**(herdr+cmux)였고 기본값이기도 했으므로 셋 다로 옮긴다 —
 * `"cmux"` 처럼 하나만 콕 집어 고른 사람의 선택은 그대로 두되, 기본값을 쓰던 사람이 Orca 만
 * 빠진 채로 남지 않게 한다. Rust 쪽 `backend_from_str` 도 같은 규칙이다(둘이 어긋나면 화면과
 * 감시 루프가 서로 다른 백엔드를 본다).
 */
export function migrateWatchBackend(
  stored: ClaudeWatchTerminal[] | string | undefined
): ClaudeWatchTerminal[] {
  if (Array.isArray(stored)) {
    return CLAUDE_WATCH_TERMINALS.filter((t) => stored.includes(t))
  }
  if (stored === "both") return CLAUDE_WATCH_TERMINALS
  if (stored === "herdr" || stored === "cmux" || stored === "orca") {
    return [stored]
  }
  return CLAUDE_WATCH_TERMINALS
}

/** Claude Code 관련 설정. */
export interface ClaudeCodeSettings {
  /**
   * 감시 대상 터미널(**켠 것 여러 개를 동시에 본다**). Rust 감시 루프도 같은 값을 알아야
   * 하므로(창이 열리기 전부터 돌기 때문에 localStorage 를 못 읽는다) `ClaudeNotifier` 가
   * 쉼표로 이어 `herdr_set_backend` 로 밀어 넣고, Rust 는 그 값을 `~/.myspace/backend` 에
   * 남긴다.
   */
  backend: ClaudeWatchTerminal[]
  /**
   * cmux 소켓 비밀번호(cmux 설정에서 만든 값). **목록·상태에는 필요 없다** — cmux 소켓은
   * cmux 안에서 시작된 프로세스만 붙을 수 있어서, 이동·프롬프트 전송·화면 읽기 세 동작만
   * 이 비밀번호를 쓴다. 비워 두면 목록은 정상이고 그 동작들만 실패한다.
   */
  cmuxPassword: string
  /**
   * 작업 감시 on/off. 선택한 백엔드의 작업 상태를 주기적으로 확인해 작업목록 실시간 갱신·
   * 트레이 팝오버 질문·완료/대기 알림을 구동한다. 끄면 이 모든 실시간 동작이 멈춘다.
   */
  watchEnabled: boolean
  /** 입력 대기(AskUserQuestion·권한 프롬프트) 진입 시 인앱 알림(토스트) 표시. */
  notifyOnBlocked: boolean
  /** 작업이 끝났을 때(진행 중 → 완료/대기) 인앱 알림(토스트) 표시. */
  notifyOnDone: boolean
}

/**
 * 사이드바에 어떤 메뉴를 보일지 설정.
 *
 * **감출 것만 저장한다**(기본값은 전부 표시). 반대로 "보일 id 목록"을 저장하면
 * `menus.tsx` 에 메뉴를 새로 추가했을 때 기존 사용자에게는 그 메뉴가 나타나지 않는다 —
 * 저장된 목록에 없기 때문이다.
 */
export interface MenuSettings {
  /** 사이드바에서 통째로 감출 그룹 id 목록(`MENU_GROUPS` 의 id). */
  hiddenGroups: string[]
  /** 사이드바에서 감출 개별 메뉴 id 목록(`MENUS` 의 id). */
  hiddenItems: string[]
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

/** 내장 브라우저(웹 탭) 설정. */
export interface BrowserSettings {
  /**
   * 이 시간(분) 동안 보지 않은 탭의 웹뷰를 파기해 메모리를 돌려준다. **0 = 파기 안 함.**
   *
   * 탭 하나가 곧 WKWebView 하나이고, 그 하나가 `WebContent` 프로세스 하나(요즘 페이지는
   * 200~400MB)다. 숨겨 두는 것만으로는 프로세스가 사라지지 않으므로, 오래 안 본 탭은
   * 웹뷰를 닫고 **탭 목록에만 남긴다** — 다시 누르면 저장된 URL 로 새로 연다.
   *
   * 대가는 복귀 시 재로드(스크롤 위치·입력 중인 폼이 사라진다)라서 시간을 넉넉히 준다.
   * 탭을 오가는 동안에는 파기되지 않고, 브라우저 메뉴를 아예 닫으면 시간과 무관하게 즉시
   * 전부 파기된다(닫았다는 건 안 보겠다는 뜻이다).
   *
   * "안 본다"에는 **다른 앱을 쓰는 중(창이 포커스를 잃은 상태)** 도 포함된다. 트레이 상주
   * 앱이라 브라우저 탭을 켜 둔 채 다른 앱을 쓰는 시간이 대부분이고, 앱 안에서 메뉴를
   * 옮겼는지만 따지면 그 시간 내내 수백 MB 를 쥔 채로 영원히 회수되지 않는다.
   */
  discardMinutes: number
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

/**
 * Cowork 서비스(IntelliJ 없이 서비스 기동) 설정.
 *
 * **`CoworkSettings.home` 과 일부러 분리했다.** 스펙 문서를 보는 폴더와 서비스를 띄우는
 * 소스 폴더는 같을 이유가 없다 — 문서만 따로 클론해 두거나, 여러 워크트리 중 하나에서만
 * 서비스를 띄우는 게 흔하다.
 */
export interface CoworkServiceSettings {
  /**
   * cowork 를 클론한 폴더(= IntelliJ 로 여는 프로젝트 루트). `~` 는 홈으로 펼쳐진다.
   *
   * 기본값이 **빈 문자열**인 이유: 이 값은 사람마다 다른 절대경로다. 누군가의 경로를
   * 박아 두면 다른 사람 머신에서는 조용히 실패하므로, 비워 두고 화면이 "지정하세요" 라고
   * 말하게 한다. 처음 열 때 IntelliJ 최근 프로젝트에서 `cowork` 를 찾으면 자동으로
   * 채워 주므로(`use-services.ts`), 대부분은 손으로 적을 일이 없다.
   */
  projectPath: string
}

/**
 * 펫 말풍선으로 받을 알림 종류. 펫이 앱의 유일한 알림 창구이므로 이 스위치들이
 * 곧 "어떤 알림을 받을지"다.
 *
 * 기본은 **Claude Code 와 직접 등록한 알림(리마인더)만 켜짐** — 이 둘은 이 설정이 생기기
 * 전부터 늘 뜨던 알림이라 기본값이 곧 기존 동작이다. 나머지(Gmail·Slack·캘린더)는 상시
 * 켜 두면 하루에도 수십 번 뜨는 종류라 사용자가 골라 켠다(뱃지 건수는 이 설정과 무관하게
 * 다이얼에 계속 붙는다).
 *
 * 끄는 지점이 출처마다 다르다:
 *  - `claude` 는 **Rust 에도 알린다**(`pet_set_claude_alert`). herdr 알림은 Rust 가 만들어
 *    표시 축을 올리므로, 프론트엔드에서만 끄면 말풍선은 비어 있는데 펫이 나타난다.
 *  - `reminder` 는 **발생 자체를 막는다**(reminder-store 가 `reminder_fire` 를 부르지 않는다).
 *    스케줄러가 메인 창에 있어 설정을 바로 읽을 수 있으니 Rust 를 거칠 이유가 없다.
 *  - 나머지는 프론트엔드가 만들어 보내는 알림이라(`pet_notify`) 끄면 애초에 오지 않는다.
 */
export interface PetNotifySettings {
  /** Claude Code(herdr) 입력 대기·작업 완료. */
  claude: boolean
  /** 생산성 → 알림 메뉴에 직접 등록한 시각 알림(리마인더). */
  reminder: boolean
  /** 새로 도착한 안 읽은 메일. 설정 → Gmail 의 관심 필터가 있으면 관심 메일만. */
  gmail: boolean
  /** 선택한 채널에 새로 온 안 읽은 메시지. */
  slack: boolean
  /**
   * 구글 캘린더 일정 알림 전체 스위치. **아래 두 값의 상위**다 —
   * 이것이 꺼져 있으면 `gcalStart` / `gcalBefore` 가 켜져 있어도 알리지 않는다.
   *
   * 왜 세 값으로 나누나: 일정 알림을 잠깐 끄고 싶을 때 "언제 알릴지"(정시·10분 전)를
   * 고른 값까지 지워 버리면, 다시 켤 때 사용자가 두 번 고르게 된다.
   */
  gcal: boolean
  /** 일정 시작 시각(정시). `gcal` 이 켜져 있을 때만 쓴다. */
  gcalStart: boolean
  /** 일정 시작 10분 전. `gcal` 이 켜져 있을 때만 쓴다. */
  gcalBefore: boolean
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
  /** 어떤 알림을 말풍선으로 받을지(`PetNotifySettings`). */
  notify: PetNotifySettings
}

/**
 * 앱 전체 설정.
 * ★ 설정 카테고리 추가 지점 ★ — 새 카테고리는 여기에 필드를 추가하고
 * DEFAULT_SETTINGS 에 기본값을, settings-view.tsx 의 CATEGORIES 에 화면을 추가한다.
 */
export interface AppSettings {
  general: GeneralSettings
  menus: MenuSettings
  claudeCode: ClaudeCodeSettings
  slack: SlackSettings
  browser: BrowserSettings
  gmail: GmailSettings
  flex: FlexSettings
  cowork: CoworkSettings
  coworkService: CoworkServiceSettings
  pet: PetSettings
}

export const DEFAULT_SETTINGS: AppSettings = {
  general: {
    autoStart: true,
  },
  // 기본값은 "모두 사용" — 감출 것만 쌓인다.
  menus: {
    hiddenGroups: [],
    hiddenItems: [],
  },
  claudeCode: {
    // 기본값을 "셋 다"로 두는 이유: 어느 하나만 보면 반쪽만 보이고(다른 터미널에서 직접 띄운
    // 세션이 빠지거나 herdr 세션이 한 탭으로 뭉친다), 안 쓰는 쪽은 비용이 사실상 0이다 —
    // cmux 가 없으면 이벤트 로그 파일이 없어 즉시 빈 결과, Orca 가 없으면 데몬 pid 확인에서
    // 끝나고(CLI 를 띄우지도 않는다), herdr 가 없으면 CLI 호출이 한 번 실패하고 끝난다.
    // 하나만 쓰는 사람도 이 값으로 정상 동작한다.
    backend: CLAUDE_WATCH_TERMINALS,
    cmuxPassword: "",
    watchEnabled: true,
    notifyOnBlocked: true,
    notifyOnDone: true,
  },
  slack: {
    pollSeconds: 120,
  },
  browser: {
    // 5분. 탭을 오가는 정도로는 절대 걸리지 않으면서, 아침에 열어 둔 탭이 오후까지
    // 300MB 를 쥐고 있는 일은 막는 선.
    discardMinutes: 5,
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
  coworkService: {
    projectPath: "",
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
    notify: {
      claude: true,
      // 이 설정이 생기기 전에는 늘 떴던 알림이라 기본값이 켜짐이다 — 기본을 꺼짐으로
      // 두면 사용자가 직접 걸어 둔 알림이 조용히 사라진다.
      reminder: true,
      gmail: false,
      slack: false,
      gcal: false,
      // 상위 스위치를 켜는 순간 바로 알림이 오도록 "언제"의 기본값은 채워 둔다 —
      // 셋 다 꺼진 상태로 두면 켜도 아무 일이 없어 고장으로 보인다.
      gcalStart: true,
      gcalBefore: true,
    },
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
    menus: { ...DEFAULT_SETTINGS.menus, ...(stored?.menus ?? {}) },
    claudeCode: migrateClaudeCode({
      ...DEFAULT_SETTINGS.claudeCode,
      ...(stored?.claudeCode ?? {}),
    }),
    slack: { ...DEFAULT_SETTINGS.slack, ...(stored?.slack ?? {}) },
    browser: { ...DEFAULT_SETTINGS.browser, ...(stored?.browser ?? {}) },
    gmail: { ...DEFAULT_SETTINGS.gmail, ...(stored?.gmail ?? {}) },
    flex: { ...DEFAULT_SETTINGS.flex, ...(stored?.flex ?? {}) },
    cowork: { ...DEFAULT_SETTINGS.cowork, ...(stored?.cowork ?? {}) },
    coworkService: {
      ...DEFAULT_SETTINGS.coworkService,
      ...(stored?.coworkService ?? {}),
    },
    pet: migratePet({
      ...DEFAULT_SETTINGS.pet,
      ...(stored?.pet ?? {}),
      // 알림 종류는 한 겹 더 병합한다 — 카테고리별 얕은 병합만으로는 예전 저장값의
      // notify 객체가 새로 생긴 스위치를 undefined 로 덮어(=꺼진 것도 아닌 값) 남긴다.
      notify: {
        ...DEFAULT_SETTINGS.pet.notify,
        ...(stored?.pet?.notify ?? {}),
      },
    }),
  }
}

/**
 * 감시 대상이 단일 선택(`"both"` 등 문자열)이던 시절의 저장값을 목록으로 옮긴다.
 * 얕은 병합만으로는 문자열이 그대로 남아 `backend.includes` 같은 호출이 조용히 틀린다.
 */
function migrateClaudeCode(s: ClaudeCodeSettings): ClaudeCodeSettings {
  return { ...s, backend: migrateWatchBackend(s.backend) }
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
  /** 사이드바 메뉴 표시 설정 일부를 갱신한다. */
  setMenus: (patch: Partial<MenuSettings>) => void
  /** Claude Code 설정 일부를 갱신한다. */
  setClaudeCode: (patch: Partial<ClaudeCodeSettings>) => void
  /** Slack 설정 일부를 갱신한다. */
  setSlack: (patch: Partial<SlackSettings>) => void
  /** 내장 브라우저 설정 일부를 갱신한다. */
  setBrowser: (patch: Partial<BrowserSettings>) => void
  /** Gmail 설정 일부를 갱신한다. */
  setGmail: (patch: Partial<GmailSettings>) => void
  /** Flex 설정 일부를 갱신한다. */
  setFlex: (patch: Partial<FlexSettings>) => void
  /** Cowork spec 설정 일부를 갱신한다. */
  setCowork: (patch: Partial<CoworkSettings>) => void
  /** Cowork 서비스 설정 일부를 갱신한다. */
  setCoworkService: (patch: Partial<CoworkServiceSettings>) => void
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
