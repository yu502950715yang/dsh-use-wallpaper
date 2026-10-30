/** WE image 实例的系统用户纹理名：取当前播放封面（scene.json instance.usertextures）。 */
export const MEDIA_THUMBNAIL_TEXTURE = '$mediaThumbnail';
/** 中性快照：所有失败/无会话路径共用（available=false ⇒ 客户端派发 stopped）。 */
export function emptyMediaSnapshot(reason, at = 0) {
    return {
        available: false, reason, appId: '', title: '', artist: '', album: '', contentType: '',
        playback: 'stopped', hasThumbnail: false, thumbnailRev: 0, positionMs: null, durationMs: null, at,
    };
}
