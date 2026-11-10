export function createAudioStartGuard(ops) {
    let generation = 0;
    return {
        async start() {
            const gen = ++generation;
            const result = await ops.start();
            if (gen !== generation) {
                // 等待期已被 stop（或更新的 start 取代）：采集可能刚建立 ⇒ 立即停掉，不残留
                ops.stop();
                return 'cancelled';
            }
            return result;
        },
        stop() {
            generation += 1;
            ops.stop();
        },
    };
}
