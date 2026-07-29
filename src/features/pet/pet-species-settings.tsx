import { useCallback, useEffect, useState, type ReactNode } from "react"
import {
  ImageIcon,
  FilmIcon,
  FolderOpenIcon,
  PackageIcon,
  RotateCwIcon,
  XIcon,
} from "lucide-react"
import { open as openFileDialog } from "@tauri-apps/plugin-dialog"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { isTauri, trackedInvoke } from "@/lib/tauri"
import { useSettings } from "@/features/settings/settings-context"
import { PetCharacter } from "./pet-character"
import { BUILTIN_CATEGORY, PET_SPECIES, isBuiltinSprite } from "./pet-species"
import {
  SPRITE_ASPECT,
  loadPetSprite,
  packageSource,
  usePetSprite,
} from "./pet-sprite"
import { ANIM_SLOTS, animPathFor, type PetAnimPaths } from "./pet-anim"
import type { PetMood } from "./use-pet-mood"

/** 미리보기용 캐릭터 크기(설정 카드 안). */
const PREVIEW = 46

/** 파일 선택 대화상자에서 받을 확장자 — Rust `pet_read_image` 가 허용하는 것과 같아야 한다. */
const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg"]

/** 가져오기 종류인데 아직 원본(이미지·패키지)이 지정되지 않았는지. */
function noSource(
  id: string,
  customImage: string,
  petdexDir: string,
  animPaths: PetAnimPaths
): boolean {
  if (id === "custom") return !customImage
  if (id === "petdex") return !petdexDir
  if (id === "anim") return !animPathFor(animPaths, "idle")
  return false
}

/**
 * `움직이는 이미지` 를 골랐을 때 나오는 동작별 파일 지정.
 *
 * Petdex 스프라이트의 대안이다 — 규격(8열 격자·상태별 행)을 맞출 필요 없이 움직이는
 * 이미지를 동작마다 하나씩 넣으면 된다. 재생은 웹뷰가 한다(pet-anim.ts 참고).
 * 한 칸만 채워도 나머지 동작이 그걸 쓰므로, 하나부터 시작해 늘려 갈 수 있다.
 */
function AnimPicker() {
  const { settings, setPet } = useSettings()
  const paths = settings.pet.animPaths

  const set = useCallback(
    (mood: PetMood, path: string) => {
      setPet({ animPaths: { ...paths, [mood]: path } })
    },
    [paths, setPet]
  )

  const pick = useCallback(
    async (mood: PetMood) => {
      if (!isTauri()) return
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "이미지", extensions: IMAGE_EXTS }],
      })
      const path = Array.isArray(picked) ? picked[0] : picked
      if (typeof path === "string" && path) set(mood, path)
    },
    [set]
  )

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-[10px] border border-border p-3">
      <div className="text-[13px] font-semibold">동작별 이미지</div>
      <p className="text-[13px] text-muted-foreground">
        GIF·APNG·애니메이션 WebP 를 넣으면 그대로 움직입니다(정지 이미지도
        됩니다). 스프라이트시트 규격을 맞출 필요가 없어 아무 캐릭터 GIF 나 쓸 수
        있습니다. <span className="font-semibold">한 칸만 채워도</span> 나머지
        동작이 그 이미지를 씁니다.
      </p>
      <p className="text-[13px] text-muted-foreground">
        경로만 저장하므로(움직이는 이미지는 수 MB 라 내용을 저장하면 설정 한도를
        넘습니다) 원본 파일을 옮기면 다시 지정해야 합니다. 배경이 투명한
        정사각형 이미지가 가장 잘 맞습니다.
      </p>

      <div className="mt-1 flex flex-col gap-2">
        {ANIM_SLOTS.map((slot) => (
          <div key={slot.mood} className="flex flex-col gap-1">
            <div className="flex items-baseline gap-2">
              <span className="text-[13px] font-semibold">{slot.label}</span>
              <span className="text-[13px] text-muted-foreground">
                {slot.hint}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={paths[slot.mood] ?? ""}
                onChange={(e) => set(slot.mood, e.target.value)}
                placeholder={
                  slot.mood === "idle"
                    ? "~/Pictures/pet-sleep.gif"
                    : "비우면 동작 없음 이미지를 씁니다"
                }
                spellCheck={false}
                className="font-mono text-[13px]"
              />
              <Button
                variant="outline"
                className="shrink-0 rounded-full"
                onClick={() => void pick(slot.mood)}
              >
                <FolderOpenIcon className="size-3.5" />
                선택
              </Button>
              {paths[slot.mood] ? (
                <Button
                  variant="outline"
                  className="shrink-0 rounded-full"
                  onClick={() => set(slot.mood, "")}
                >
                  <XIcon className="size-3.5" />
                  지우기
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Rust `PetPackage` 와 대응 — 설치된 Codex 펫 패키지 하나. */
interface PetPackage {
  slug: string
  name: string
  description: string
  dir: string
}

/**
 * `~/.petdex/pets` 설치 목록. 캐릭터 칸(내장 애니메이션 줄)과 `Petdex 폴더` 칸이 함께 쓴다.
 *
 * 앱에 시트를 넣어 둔 슬러그(`BUILTIN_SPRITE_IDS`)는 걸러 낸다 — 같은 캐릭터가 두 번 나오고,
 * 둘 중 하나는 폴더가 사라지면 못 쓰는 쪽이라 어느 것을 고른 건지 구분되지 않는다.
 */
function useInstalledPackages(): {
  packages: PetPackage[]
  scanned: boolean
  rescan: () => void
} {
  const [packages, setPackages] = useState<PetPackage[]>([])
  const [scanned, setScanned] = useState(false)
  /** "다시 찾기" 가 올리는 값 — 목록을 다시 읽는 계기. */
  const [reload, setReload] = useState(0)

  // 조회는 effect 안의 async 클로저에서 한다 — effect 본문에서 곧바로 setState 하면
  // 연쇄 렌더가 된다(react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!isTauri()) return
    let alive = true
    void (async () => {
      try {
        const list = await trackedInvoke<PetPackage[]>("pet_list_packages")
        if (alive) setPackages(list.filter((p) => !isBuiltinSprite(p.slug)))
      } catch {
        if (alive) setPackages([])
      } finally {
        if (alive) setScanned(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [reload])

  const rescan = useCallback(() => setReload((n) => n + 1), [])
  return { packages, scanned, rescan }
}

/**
 * 패키지를 고른다 — 종류를 `petdex` 로 바꾸고 폴더·이름·세로비를 함께 저장한다.
 *
 * 세로비를 설정에 남기는 이유: 펫 창을 처음 띄울 때 시트를 읽기 전에 창 크기를 정해야
 * 하는데(PetController), 스프라이트 프레임은 세로로 길어 정사각으로 잡으면 위가 잘린다.
 * effect 가 아니라 고른 순간에 저장하는 이유: effect 안에서 동기적으로 setState 하면
 * 연쇄 렌더가 된다(react-hooks/set-state-in-effect).
 */
function useSelectPackage(): (dir: string) => Promise<void> {
  const { setPet } = useSettings()
  return useCallback(
    async (dir: string) => {
      setPet({ species: "petdex", petdexDir: dir })
      if (!dir.trim() || !isTauri()) return
      try {
        const loaded = await loadPetSprite(packageSource(dir))
        setPet({
          petdexName: loaded.name,
          petdexAspect: loaded.frameH / loaded.frameW,
        })
      } catch {
        // 오류는 usePetSprite 가 화면에 띄운다.
      }
    },
    [setPet]
  )
}

/**
 * `Petdex 캐릭터` 를 골랐을 때 나오는 패키지 선택.
 *
 * 내려받기는 하지 않는다. 펫 그림은 제출자들의 팬아트라 앱이 재배포에 끼어들 이유가 없고,
 * `npx petdex install <slug>` 한 줄이면 `~/.petdex/pets/<slug>/` 에 놓인다 — 우리는 읽기만 한다.
 * 다른 곳에 받아 둔 패키지도 쓸 수 있게 폴더 직접 지정도 열어 둔다.
 */
function PetdexPicker() {
  const { settings, setPet } = useSettings()
  const s = settings.pet
  const { packages, scanned, rescan } = useInstalledPackages()

  // 화면에 보여 줄 시트 정보(프레임 수·크기·오류). 캐시되므로 select 와 중복으로 읽지 않는다.
  const { sprite, error } = usePetSprite(
    s.petdexDir ? packageSource(s.petdexDir) : null
  )

  const select = useSelectPackage()

  const pickFolder = useCallback(async () => {
    if (!isTauri()) return
    const picked = await openFileDialog({ directory: true, multiple: false })
    const dir = Array.isArray(picked) ? picked[0] : picked
    if (typeof dir === "string" && dir) await select(dir)
  }, [select])

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-[10px] border border-border p-3">
      <div className="text-[13px] font-semibold">Petdex 폴더</div>
      <p className="text-[13px] text-muted-foreground">
        Codex 펫 규격(<span className="font-mono">pet.json</span> +
        스프라이트시트)으로 만들어진 애니메이션 캐릭터를 그대로 씁니다. 기분에
        따라 시트의 상태(idle·run·review·jump·wave)를 재생합니다 — 내장
        애니메이션과 같은 방식이고, 다른 건 시트를 폴더에서 읽는다는 점뿐입니다.
      </p>
      <p className="text-[13px] text-muted-foreground">
        <span className="font-mono">npx petdex install guga</span> 처럼 받으면{" "}
        <span className="font-mono">~/.petdex/pets/</span> 에 설치되고 위{" "}
        <span className="font-semibold">내장 애니메이션</span> 줄에 함께
        나타납니다. 여기서는 다른 곳에 받아 둔 폴더를 직접 지정합니다. 캐릭터는{" "}
        <a
          href="https://petdex.dev"
          className="font-semibold text-ui-link hover:underline"
        >
          petdex.dev
        </a>{" "}
        에서 고르세요.
      </p>

      {packages.length > 0 ? (
        <ul className="mt-1 flex max-h-56 flex-col gap-px overflow-y-auto">
          {packages.map((p) => {
            const isActive = p.dir === s.petdexDir
            return (
              <li key={p.dir}>
                <button
                  type="button"
                  onClick={() => void select(p.dir)}
                  className={cn(
                    "flex min-h-9 w-full cursor-pointer flex-col rounded-lg px-3 py-1.5 text-left transition-colors",
                    isActive
                      ? "bg-ui-list-active text-ui-list-active-fg"
                      : "hover:bg-ui-list-hover"
                  )}
                >
                  <span className="text-[15px] font-bold">{p.name}</span>
                  <span
                    className={cn(
                      "line-clamp-1 text-[13px]",
                      isActive ? "opacity-80" : "text-muted-foreground"
                    )}
                  >
                    {p.description || p.slug}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        scanned && (
          <p className="text-[13px] text-muted-foreground">
            내장 애니메이션 외에 설치된 패키지가 없습니다.{" "}
            <span className="font-mono">npx petdex install &lt;slug&gt;</span>{" "}
            를 실행한 뒤 “다시 찾기”를 누르세요.
          </p>
        )
      )}

      <div className="mt-1 flex items-center gap-2">
        <Input
          value={s.petdexDir}
          onChange={(e) => setPet({ petdexDir: e.target.value })}
          // 직접 입력한 경로도 다 쓰고 나면 목록에서 고른 것과 같게 처리한다
          // (이름·세로비를 함께 저장해야 창 크기가 맞는다).
          onBlur={(e) => void select(e.target.value)}
          placeholder="~/.petdex/pets/guga"
          spellCheck={false}
          className="font-mono text-[13px]"
        />
        <Button
          variant="outline"
          className="shrink-0 rounded-full"
          onClick={() => void pickFolder()}
        >
          <FolderOpenIcon className="size-3.5" />
          폴더 선택
        </Button>
        <Button
          variant="outline"
          className="shrink-0 rounded-full"
          onClick={rescan}
        >
          <RotateCwIcon className="size-3.5" />
          다시 찾기
        </Button>
      </div>

      {error ? (
        <p className="text-[13px] font-semibold text-ui-error">{error}</p>
      ) : sprite ? (
        <p className="text-[13px] text-ui-success">
          {sprite.name} — 상태별 프레임 {sprite.rowFrames.join("·")} (
          {sprite.frameW}×{sprite.frameH})
        </p>
      ) : s.petdexDir ? (
        <p className="text-[13px] text-muted-foreground">불러오는 중…</p>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          아직 고른 패키지가 없어 기본 캐릭터로 표시됩니다.
        </p>
      )}
    </div>
  )
}

/**
 * 캐릭터 칸 한 개. 내장 종류(PET_SPECIES)와 설치된 Petdex 패키지가 같은 모양을 쓰므로
 * 껍데기를 한 곳에 둔다 — 미리보기 내용만 넣는 쪽이 다르다.
 */
function SpeciesTile({
  label,
  active,
  onClick,
  children,
}: {
  label: string
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex w-[84px] cursor-pointer flex-col items-center gap-1 rounded-[10px] border px-2 py-2 transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid",
        active
          ? "border-ui-selection bg-ui-selection/10"
          : "border-border hover:bg-ui-list-hover"
      )}
    >
      {/* 스프라이트는 세로로 길어 정사각 칸에 넣으면 넘친다 — 칸을 조금 높인다. */}
      <span
        className="flex items-end justify-center overflow-hidden"
        style={{ width: PREVIEW, height: PREVIEW + 8 }}
      >
        {children}
      </span>
      <span
        className={cn(
          "text-center text-[13px] leading-tight",
          active ? "font-bold" : "text-muted-foreground"
        )}
      >
        {label}
      </span>
    </button>
  )
}

/**
 * 설정의 "캐릭터" 행 — 종류를 고르고, `직접 등록` 이면 이미지를 불러온다.
 *
 * 미리보기는 실제 펫과 같은 `PetCharacter` 를 작게 그린 것이다(별도 썸네일을 두면
 * 종류를 추가할 때마다 두 곳을 손봐야 한다). 기분은 idle 고정 — 여기서 표정까지
 * 흔들리면 무엇을 고르는 화면인지 흐려진다.
 */
export function PetSpeciesRow() {
  const { settings, setPet } = useSettings()
  const s = settings.pet
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 이미지를 읽어 내용(data URL)째 설정에 저장한다 — 경로만 두면 파일이 사라졌을 때
  // 펫이 빈 창이 되고, 창마다 파일을 다시 읽어야 한다.
  const load = useCallback(
    async (path: string) => {
      if (!isTauri() || !path.trim()) return
      setBusy(true)
      setError(null)
      try {
        const dataUrl = await trackedInvoke<string>("pet_read_image", { path })
        setPet({ customImage: dataUrl, customImagePath: path })
      } catch (e) {
        setError(String(e))
      } finally {
        setBusy(false)
      }
    },
    [setPet]
  )

  const pick = useCallback(async () => {
    if (!isTauri()) return
    setError(null)
    try {
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "이미지", extensions: IMAGE_EXTS }],
      })
      const path = Array.isArray(picked) ? picked[0] : picked
      if (typeof path !== "string" || !path) return
      await load(path)
    } catch (e) {
      setError(String(e))
    }
  }, [load])

  const categories = [...new Set(PET_SPECIES.map((x) => x.category))]

  // `~/.petdex/pets` 설치분 — 내장 애니메이션 줄에 함께 세운다(내장 시트로 들어 있는
  // 슬러그는 훅이 걸러 낸다).
  const { packages } = useInstalledPackages()
  const selectPackage = useSelectPackage()
  const installedDirs = new Set(packages.map((p) => p.dir))

  return (
    <div className="border-b border-border py-3">
      <div className="text-[15px] font-semibold">캐릭터</div>
      <p className="mt-1 text-[13px] text-muted-foreground">
        펫으로 쓸 캐릭터입니다.{" "}
        <span className="font-semibold">내장 애니메이션</span>은 앱에 함께 들어
        있어 설치 없이 바로 움직이고, 동작(자는 중·작업 중·바쁨·대기)은 그림
        자체가 표현합니다. <span className="font-mono">~/.petdex/pets</span> 에
        설치한 캐릭터도 같은 줄에 함께 나옵니다.
      </p>

      {categories.map((category) => (
        <div key={category} className="mt-3">
          <div className="text-[13px] font-semibold text-muted-foreground">
            {category}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {PET_SPECIES.filter((x) => x.category === category).map((x) => (
              <SpeciesTile
                key={x.id}
                label={x.name}
                /*
                 * `Petdex 폴더` 는 **설치 목록에 없는** 폴더를 직접 지정했을 때만 선택
                 * 상태다. 설치분 칸도 species 를 `petdex` 로 두므로, 그냥 비교하면
                 * 설치분을 골랐을 때 두 칸이 함께 켜져 어느 쪽인지 알 수 없다.
                 */
                active={
                  x.id === "petdex"
                    ? s.species === "petdex" && !installedDirs.has(s.petdexDir)
                    : x.id === s.species
                }
                onClick={() => setPet({ species: x.id })}
              >
                {noSource(x.id, s.customImage, s.petdexDir, s.animPaths) ? (
                  x.id === "petdex" ? (
                    <PackageIcon className="mb-2 size-6 text-muted-foreground" />
                  ) : x.id === "anim" ? (
                    <FilmIcon className="mb-2 size-6 text-muted-foreground" />
                  ) : (
                    <ImageIcon className="mb-2 size-6 text-muted-foreground" />
                  )
                ) : (
                  <PetCharacter
                    mood="idle"
                    size={PREVIEW}
                    species={x.id}
                    customImage={s.customImage || undefined}
                    petdexDir={s.petdexDir || undefined}
                    petdexAspect={s.petdexAspect}
                    animPaths={s.animPaths}
                  />
                )}
              </SpeciesTile>
            ))}

            {/*
             * `~/.petdex/pets` 에 설치된 패키지도 같은 줄에 세운다 — 시트 규격이 내장과
             * 같아서 사용자에게는 구분할 이유가 없는 차이다(폴더를 찾아 지정하는 절차 없이
             * 바로 고를 수 있어야 한다). 저장되는 건 여전히 species=petdex + 폴더 경로다.
             */}
            {category === BUILTIN_CATEGORY &&
              packages.map((p) => (
                <SpeciesTile
                  key={p.dir}
                  label={p.name}
                  active={s.species === "petdex" && s.petdexDir === p.dir}
                  onClick={() => void selectPackage(p.dir)}
                >
                  <PetCharacter
                    mood="idle"
                    size={PREVIEW}
                    species="petdex"
                    petdexDir={p.dir}
                    petdexAspect={SPRITE_ASPECT}
                  />
                </SpeciesTile>
              ))}
          </div>
        </div>
      ))}

      {s.species === "petdex" && <PetdexPicker />}

      {s.species === "anim" && <AnimPicker />}

      {s.species === "custom" && (
        <div className="mt-3 flex flex-col gap-1.5 rounded-[10px] border border-border p-3">
          <div className="text-[13px] font-semibold">이미지 파일</div>
          <p className="text-[13px] text-muted-foreground">
            png·jpg·gif·webp·svg, 512KB 이하. 배경이 투명한 정사각형 이미지가
            가장 잘 맞습니다. 불러온 이미지는 내용째 저장되므로 원본 파일을
            옮겨도 계속 표시됩니다. 다만{" "}
            <span className="font-semibold">표정은 바뀌지 않고</span> 움직임과
            머리 위 배지로만 상태를 알립니다.
          </p>
          <div className="mt-1 flex items-center gap-2">
            <Input
              value={s.customImagePath}
              onChange={(e) => setPet({ customImagePath: e.target.value })}
              placeholder="~/Pictures/my-pet.png"
              spellCheck={false}
              className="font-mono text-[13px]"
            />
            <Button
              variant="outline"
              className="shrink-0 rounded-full"
              onClick={() => void pick()}
              disabled={busy}
            >
              <FolderOpenIcon className="size-3.5" />
              파일 선택
            </Button>
            <Button
              variant="outline"
              className="shrink-0 rounded-full"
              onClick={() => void load(s.customImagePath)}
              disabled={busy || !s.customImagePath.trim()}
            >
              <RotateCwIcon
                className={cn("size-3.5", busy && "animate-spin")}
              />
              불러오기
            </Button>
          </div>
          {error ? (
            <p className="text-[13px] font-semibold text-ui-error">{error}</p>
          ) : s.customImage ? (
            <p className="text-[13px] text-ui-success">
              이미지를 불러왔습니다({Math.round(s.customImage.length / 1024)}
              KB).
            </p>
          ) : (
            <p className="text-[13px] text-muted-foreground">
              아직 이미지가 없어 기본 캐릭터로 표시됩니다.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
