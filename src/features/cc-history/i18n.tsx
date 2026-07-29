import { useEffect, useMemo, useState, type ReactNode } from "react"
import {
  DICTS,
  EN,
  I18nContext,
  STORAGE_KEY,
  getLang,
  type I18nContextValue,
  type Lang,
} from "./i18n-context"

/**
 * cc-history 뷰 전용 언어 컨텍스트. 훅·사전 등 비컴포넌트 값은 `./i18n-context` 에 두고
 * (fast-refresh 규칙상 .tsx 는 컴포넌트만 export), 여기서는 Provider 만 내보낸다.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(getLang)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, lang)
  }, [lang])

  const value = useMemo<I18nContextValue>(
    () => ({
      lang,
      setLang: setLangState,
      t: (key) => DICTS[lang][key] ?? EN[key] ?? String(key),
    }),
    [lang]
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
