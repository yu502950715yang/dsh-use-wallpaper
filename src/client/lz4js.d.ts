// lz4js@0.2.0 无自带类型声明，此处补充最小类型（CJS，浏览器可用）。
declare module 'lz4js' {
  export function compressBound(n: number): number;
  export function decompressBound(src: Uint8Array): number;
  export function compressBlock(
    src: Uint8Array,
    dst: Uint8Array,
    sIndex: number,
    sLength: number,
    hashTable: Uint32Array,
  ): number;
  export function decompressBlock(
    src: Uint8Array,
    dst: Uint8Array,
    sIndex: number,
    sLength: number,
    dIndex: number,
  ): number;
  export function compress(src: Uint8Array, maxSize?: number): Uint8Array;
  export function decompress(src: Uint8Array, maxSize?: number): Uint8Array;
  const LZ4: {
    compressBound(n: number): number;
    decompressBound(src: Uint8Array): number;
    compressBlock(
      src: Uint8Array,
      dst: Uint8Array,
      sIndex: number,
      sLength: number,
      hashTable: Uint32Array,
    ): number;
    decompressBlock(
      src: Uint8Array,
      dst: Uint8Array,
      sIndex: number,
      sLength: number,
      dIndex: number,
    ): number;
    compress(src: Uint8Array, maxSize?: number): Uint8Array;
    decompress(src: Uint8Array, maxSize?: number): Uint8Array;
  };
  export default LZ4;
}
