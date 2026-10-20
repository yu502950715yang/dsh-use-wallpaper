'use strict';
// 3765967112 Crimson Horizon 的 angles.script（原样取自 scene.pkg，用于对象级脚本回归）。
export let __workshopId = '3732231168';

export var scriptProperties = createScriptProperties()
    .addSlider({name: 'dayStart',   label: 'Day Start',   value: 8,  min: 0, max: 24, integer: true})
    .addSlider({name: 'nightStart', label: 'Night Start', value: 20, min: 0, max: 24, integer: true})
.finish();

const states = ['automatic', 'day', 'night'];
let currentStateIndex = 0;
let lastKnownState = '';

export function init() {
    let savedState = localStorage.get('currentTimeState');
    if (savedState !== null && states.includes(savedState)) {
        currentStateIndex = states.indexOf(savedState);
    }

    let anim = thisLayer.getTextureAnimation();

    anim.pause();
    anim.setFrame(currentStateIndex);
    shared.currentTODState = getSharedState();
    lastKnownState = shared.currentTODState;
}


export function cursorClick(event) {
    currentStateIndex = (currentStateIndex + 1) % states.length;

    let anim = thisLayer.getTextureAnimation();
    anim.setFrame(currentStateIndex);

    shared.currentTODState = getSharedState();
    localStorage.set('currentTimeState', states[currentStateIndex]);
    lastKnownState = shared.currentTODState;
}


export function update() {
    if (states[currentStateIndex] === 'automatic') {
        let currentState = getSharedState();
        if (currentState !== lastKnownState) {
            lastKnownState = currentState;
            let anim = thisLayer.getTextureAnimation();
            anim.setFrame(states.indexOf(currentState));
            shared.currentTODState = currentState;
        }
    }
}


function isDayTime() {
    let currentTime = engine.timeOfDay;
    return currentTime >= (scriptProperties.dayStart / 24) && currentTime < (scriptProperties.nightStart / 24);
}


function getSharedState() {
    if (states[currentStateIndex] === 'automatic') {
        return isDayTime() ? 'day' : 'night';
    } else {
        return states[currentStateIndex];
    }
}
