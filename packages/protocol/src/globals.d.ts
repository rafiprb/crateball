// Present in browsers and in Node alike. This package is checked without either runtime's library, so the
// little it uses is declared here (the client and the server check it against their own, full ones).
declare class TextEncoder {
  encode(s: string): Uint8Array;
}
declare class TextDecoder {
  decode(b: Uint8Array): string;
}
declare function structuredClone<T>(v: T): T;
