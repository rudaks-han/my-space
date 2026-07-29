import { useCallback, useEffect, useState } from "react"

import { isTauri, trackedInvoke } from "@/lib/tauri"

/** 스펙 폴더 안의 문서 파일(Rust `SpecFile` 와 대응). */
export interface SpecFile {
  name: string
  path: string
  /** 스펙 폴더 기준 상대 경로(하위 폴더 구분용). */
  rel: string
}

/** `.cowork/specs` 아래 스펙 폴더 하나(Rust `SpecDir` 와 대응). */
export interface SpecDir {
  name: string
  path: string
  files: SpecFile[]
}

/** 본문 검색 결과 한 건(Rust `SearchHit` 와 대응). */
export interface SearchHit {
  path: string
  /** 처음 일치한 줄 미리보기. */
  snippet: string
  /** 문서 내 일치 횟수. */
  count: number
}

/**
 * cowork 홈(`home`) 아래 스펙 문서 목록을 불러온다. `home` 이 바뀌면(설정 변경) 다시 읽는다.
 * `reload` 로 수동 새로고침할 수 있다.
 */
export function useCoworkSpecs(home: string) {
  const [specs, setSpecs] = useState<SpecDir[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!isTauri()) {
      setError("데스크톱 앱에서만 사용할 수 있습니다.")
      return
    }
    setLoading(true)
    setError(null)
    try {
      setSpecs(await trackedInvoke<SpecDir[]>("cowork_list_specs", { home }))
    } catch (e) {
      setError(String(e))
      setSpecs([])
    } finally {
      setLoading(false)
    }
  }, [home])

  useEffect(() => {
    // 진입/홈 변경 시 목록을 읽는다(데이터 페칭 목적의 의도된 setState).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload()
  }, [reload])

  return { specs, loading, error, reload }
}
