/** 中性快照：所有失败/无会话路径共用（available=false ⇒ 客户端派发 stopped）。 */
export function emptyMediaSnapshot(reason, at = 0) {
    return {
        available: false, reason, appId: '', title: '', artist: '', album: '', contentType: '',
        playback: 'stopped', hasThumbnail: false, thumbnailRev: 0, positionMs: null, durationMs: null, at,
    };
}
