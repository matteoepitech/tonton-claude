// Files embedded in the compiled agent (Bun import attributes).
declare module '*.ps1' {
  const text: string
  export default text
}
declare module '*.ico' {
  const path: string
  export default path
}
