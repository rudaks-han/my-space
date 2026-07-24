import { check, type Update } from "@tauri-apps/plugin-updater"
import { relaunch } from "@tauri-apps/plugin-process"
import { toast } from "sonner"

import { isTauri } from "@/lib/tauri"

/**
 * GitHub 릴리스에 새 버전이 있는지 확인한다.
 * tauri.conf.json 의 `plugins.updater.endpoints` 가 가리키는 `latest.json` 을 읽어
 * 현재 앱 버전과 비교한다(서명은 pubkey 로 검증).
 *
 * @param silent true(기본)면 최신 버전일 때 아무 알림도 띄우지 않는다.
 *   앱 시작 시 자동 확인용. 사용자가 "업데이트 확인"을 직접 눌렀을 땐 false 로 호출.
 */
export async function checkForUpdates(silent = true) {
  // 브라우저(vite dev, Tauri 밖)에서는 업데이터 플러그인이 없으므로 건너뛴다.
  if (!isTauri()) return

  try {
    const update = await check()
    if (!update) {
      if (!silent) toast.success("이미 최신 버전을 사용 중입니다.")
      return
    }
    promptInstall(update)
  } catch (error) {
    console.error("update check failed", error)
    if (!silent) toast.error("업데이트 확인에 실패했습니다.")
  }
}

/** 새 버전 발견 시 사용자에게 설치 여부를 묻는 토스트를 띄운다. */
function promptInstall(update: Update) {
  toast(`새 버전 ${update.version} 이(가) 있습니다`, {
    description: update.body?.trim() || "지금 업데이트하시겠어요?",
    duration: Infinity,
    action: {
      label: "업데이트",
      onClick: () => void installUpdate(update),
    },
  })
}

/** 업데이트를 내려받아 설치한 뒤 앱을 재시작한다. 진행률을 토스트로 보여준다. */
async function installUpdate(update: Update) {
  const id = toast.loading("업데이트 다운로드 중…")
  try {
    let downloaded = 0
    let total = 0
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          total = event.data.contentLength ?? 0
          break
        case "Progress":
          downloaded += event.data.chunkLength
          if (total > 0) {
            const pct = Math.round((downloaded / total) * 100)
            toast.loading(`업데이트 다운로드 중… ${pct}%`, { id })
          }
          break
        case "Finished":
          toast.loading("설치 중…", { id })
          break
      }
    })
    toast.success("업데이트 완료. 앱을 재시작합니다…", { id })
    await relaunch()
  } catch (error) {
    console.error("update install failed", error)
    toast.error("업데이트 설치에 실패했습니다.", { id })
  }
}
