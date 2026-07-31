# 내장 펫 스프라이트시트

앱에 함께 넣어 둔 캐릭터 그림. `src/features/pet/pet-sprite.ts` 의 `BUILTIN_SHEETS` 가
Vite 에셋으로 불러다 쓰고, `pet-species.ts` 가 `내장 애니메이션` 종류로 노출한다
(id 목록은 `BUILTIN_SPRITE_IDS` — 두 곳이 어긋나면 타입에서 걸린다).

모두 [petdex.dev](https://petdex.dev) 의 Codex 펫 패키지
(`npx petdex install <slug>` → `~/.petdex/pets/<slug>/spritesheet.webp`) 원본이며,
규격은 **8열 × 프레임 192×208**, 행이 애니메이션 상태다. 열세 장 모두 1536×1872(9행)이다.

파일 이름은 반드시 **slug(= `~/.petdex/pets` 의 폴더 이름)** 와 같게 둔다 —
`settings-context.ts` 의 `migratePet` 이 저장된 `petdexDir` 의 basename 을 내장 id 와
견주어 옮기기 때문에, 이름이 다르면 같은 캐릭터를 폴더로 쓰던 설정이 옮겨지지 않는다
(그래서 `mini-jerry` · `pinkribbonchibi` 는 `pet.json` 의 표기가 아니라 폴더 이름을 따랐다).

| 파일                    | slug              | 이름            | 크기   |
| ----------------------- | ----------------- | --------------- | ------ |
| `code-frenzy-cat.webp`  | `code-frenzy-cat` | Code Frenzy Cat | 2.1 MB |
| `guga.webp`             | `guga`            | Guga            | 1.9 MB |
| `lanlan.webp`           | `lanlan`          | Lanlan          | 1.7 MB |
| `baobao-coder.webp`     | `baobao-coder`    | Baobao Coder    | 1.5 MB |
| `cozy-fluff.webp`       | `cozy-fluff`      | Cozy Fluff      | 2.6 MB |
| `lemon.webp`            | `lemon`           | Lemon           | 2.3 MB |
| `luffy.webp`            | `luffy`           | Luffy           | 2.0 MB |
| `max.webp`              | `max`             | Max             | 1.8 MB |
| `mini-jerry.webp`       | `mini-jerry`      | mini-Jerry      | 264 KB |
| `mochi.webp`            | `mochi`           | Mochi           | 1.9 MB |
| `noir-webling.webp`     | `noir-webling`    | Noir Webling    | 1.6 MB |
| `pinkribbonchibi.webp`  | `pinkribbonchibi` | Pink Ribbon Chibi | 2.0 MB |
| `shellpop-snail.webp`   | `shellpop-snail`  | Shellpop Snail  | 2.0 MB |

⚠️ **아직 정리되지 않은 것 — 라이선스.** 이 그림들은 우리가 그린 것이 아니라 petdex
제출자들의 작업물이고, `pet.json` 에 라이선스 항목이 없다. 저장소가 public 이고
릴리스로 배포되는 이상 재배포에 해당하니, 원저작자 표기나 허락을 받아 두는 편이 좋다.

실존 인물을 그린 `mini-elon` · `steve-jobs` 두 장은 **공개 배포 전에 제거했다**
(2026-07-30) — 초상 자체가 문제이므로 이 둘은 다시 넣지 않는다. 쓰고 싶으면
`npx petdex install mini-elon` 처럼 각자 받으면 되고, 설치분은 설정의 `내장 애니메이션`
줄에 자동으로 나타난다. 같은 이유로 뺀 것이 `clawd`(Anthropic 마스코트 스티커에서 만든
것) · `yier-gif`(출처 불명의 스티커 프레임)이고, `luna` 는 취향에서 제외했다.

⚠️ `luffy.webp` 는 **원피스 몽키 D 루피**로, 슈에이샤·토에이의 저작물이다. 위 규칙에
어긋나지만 소유자 판단으로 내장했다(2026-07-31) — 권리자 문의가 오면 가장 먼저 뺄 대상이니,
"타사 캐릭터는 넣지 않는다" 를 근거로 다른 캐릭터를 더 들이지는 말 것.

빼는 방법은 간단하다 — `.webp` 파일과 `BUILTIN_SPRITE_IDS`·`BUILTIN_SHEETS`·`PET_SPECIES`
의 해당 항목만 지우면 된다. 사라진 종류로 저장돼 있던 설정은 `settings-context.ts` 의
`migratePet` 이 기본값으로 되돌린다.
