# Freesentation

설정 → Appearance → Font 의 선택지 하나. 실제 배선은 `freesentation.css`(같은 폴더) →
`src/index.css` 의 `@import` → `src/lib/fonts.ts` 의 `FONTS` 항목.

- 출처: <https://github.com/Freesentation/freesentation> (`woff2/` 폴더, 2.001)
- 소개/다운로드: <https://freesentation.blog/freesentation>
- 라이선스: **SIL Open Font License 1.1** — 전문은 `OFL.txt`. 글꼴 단독 판매와 라이선스
  변경만 금지고, 앱 내장·수정·재배포는 허용된다. 그래서 저장소가 공개여도 문제없다
  (같은 assets 폴더의 `../pets/` 스프라이트와 달리 권리 관계가 확실하다).

woff2 를 npm 대신 저장소에 직접 담은 이유는 하나뿐이다 — **npm 패키지가 없다.**
공식 css 는 jsDelivr 를 가리키는데 이 앱은 오프라인에서도 떠야 하므로 CDN 은 못 쓴다.
받아 온 곳이 upstream 그대로이니, 갱신하려면 같은 경로에서 다시 받아 덮으면 된다:

```bash
for w in 4Regular 5Medium 6SemiBold 7Bold; do
  curl -sSL -o "Freesentation-$w.woff2" \
    "https://raw.githubusercontent.com/Freesentation/freesentation/main/woff2/Freesentation-$w.woff2"
done
```

굵기 9종 중 **400/500/600/700 만** 담았다. 한 벌이 ~470KB 라 9종이면 4MB 가 넘고,
UI 는 normal/medium/semibold/bold 밖에 쓰지 않는다. 새 굵기가 필요해지면 위 목록에
이름을 더하고 `freesentation.css` 에 `@font-face` 를 한 벌 더 적으면 된다.
