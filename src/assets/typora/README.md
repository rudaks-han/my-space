# Typora 테마 (번들)

`rudaks.css` — Cowork Spec 문서 뷰어의 **기본** 마크다운 스타일.

## 왜 여기에 있나

원래 뷰어는 설정의 "스타일 가져오기" 로 `~/Library/Application Support/abnerworks.Typora/themes/rudaks.css`
를 읽어야 제대로 보였다. 그 경로는 Typora + 이 테마를 깔아 둔 사람에게만 있어서, 앱을
내려받은 사람은 대부분 "가져오기 실패" 만 보고 최소 스타일로 문서를 읽었다. 그래서 같은
css 를 앱에 번들해 두고, 저장된 스타일이 없으면 이걸 쓴다
(`src/features/cowork-spec/bundled-css.ts` — `?raw` 문자열 import).

원본 파일을 고쳤으면 여기로 다시 복사해야 한다(자동 동기화는 없다):

```bash
cp ~/Library/Application\ Support/abnerworks.Typora/themes/rudaks.css src/assets/typora/rudaks.css
```

## 출처 / 라이선스

Typora 기본 테마 `github.css`(Typora 배포본, MIT)를 손본 파생 테마다 — 고유 라인의 절반
가까이가 `github.css` 와 같다. 폰트(JetBrains Mono, NanumSquare, NEXON Lv2 Gothic)는
파일에 들어 있지 않고 CDN url 로만 참조하므로 재배포 대상이 아니다. 오프라인이면 폰트만
시스템 기본으로 대체되고 나머지 스타일은 그대로 적용된다.
