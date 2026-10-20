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
    private readonly pkgPathValue;
    constructor(pkgPathOrBuf: string | Uint8Array);
    get pkgPath(): string;
    listEntries(): PkgEntry[];
    private findEntry;
    entryInfo(name: string): {
        offset: number;
        size: number;
    } | null;
    entryAbsRange(name: string): {
        start: number;
        end: number;
    } | null;
    readEntry(name: string): Buffer | null;
}
