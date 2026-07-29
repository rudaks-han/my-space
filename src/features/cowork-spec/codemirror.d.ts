// CodeMirror 5 는 우리가 쓰는 방식(runMode + 모드 사이드이펙트 import)에 대한 타입을
// 따로 제공하지 않으므로, 필요한 부분만 최소로 선언한다.
declare module "codemirror" {
  const CodeMirror: {
    runMode: (
      text: string,
      modespec: string,
      callback: (token: string, style: string | null) => void
    ) => void
  }
  export default CodeMirror
}
declare module "codemirror/addon/*"
declare module "codemirror/mode/*"
