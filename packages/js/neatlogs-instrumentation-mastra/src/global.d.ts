// Type declaration for CommonJS require() used in dynamic-require fallback.
// This instrumentation targets Node.js environments where require() is available.
declare function require(module: string): any;
declare namespace require {
  function resolve(module: string, options?: { paths?: string[] }): string;
}
