declare module "*?raw" {
  const source: string;
  export default source;
}

declare module "*?inline" {
  const dataUrl: string;
  export default dataUrl;
}
