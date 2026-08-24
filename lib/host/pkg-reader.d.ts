import { Buffer } from 'node:buffer';
import type { PkgEntry } from '../shared/types.js';
export declare function parsePkg(buf: Uint8Array): {
    entries: PkgEntry[];
    dataStart: number;
};
export declare class PkgReader {
    private buf;
    private entries;
    private dataStart;
    constructor(pkgPathOrBuf: string | Uint8Array);
    listEntries(): PkgEntry[];
    readEntry(name: string): Buffer | null;
}
