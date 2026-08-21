'use strict';
// Please note: Do not remove this line or asset references may break.
export let __workshopId = '2652493753';
// Please note: Do not remove this line or asset references may break.

export var scriptProperties = createScriptProperties()
	.addSlider({
		name: 'barWidth',
		label: 'Width粗细',
		value: 5,
		min: 0,
		max: 10,
		integer: false
	})
	.addSlider({
		name: 'scaleY',
		label: 'Height高度',
		value: 50,
		min: 0,
		max: 100,
		integer: false
	})
		.addSlider({
		name: 'originX',
		label: 'Distance距离',
		value: 30,
		min: -60,
		max: 60,
		integer: false
	})
	.addCombo({
		name: 'barAlignmentdir',
		label: 'Direction',
		options: [{
			label: 'Centre',
			value: 'centre'
		}, {
			label: 'Bottom',
			value: 'bottom'
		}, {
			label: 'Top',
			value: 'top'
		}]
	})
	.finish();

var bars = [];
var baseOrigin;
var baseAngle;
let audioData = engine.registerAudioBuffers(64);



/**
 * @param {Boolean} value（for property 'visible'）
 */
export function update() {

	var origin = baseOrigin.copy();
	var scale = new Vec3(0 + scriptProperties.barWidth);
	
	for (var i = 0; i < 64; ++i) {
		let amt = audioData.average[i];
		let bar = bars[i];

		scale.y = amt * scriptProperties.scaleY;
		origin.x += scriptProperties.originX;
		origin.y += 0;
		bar.scale = scale;
		bar.origin = origin;
		bar.alignment = scriptProperties.barAlignmentdir;
		
		}	
	}


/**
 * @param {Boolean} value (for property 'visible')
 */
export function init() {
	bars.push(thisLayer);
	let thisIndex = thisScene.getLayerIndex(thisLayer);
	for (var i = 1; i < 64; ++i) {
		let bar = thisScene.createLayer('models/bar.json');
		bar.alignment = scriptProperties.barAlignmentdir;
        thisScene.sortLayer(bar, thisIndex);
        bar.parallaxDepth = new Vec2(0,0);
        bars.push(bar);
    }
		

	for (var i = 0; i < 64; ++i) {
        let angle = 360 * (i / 64);
        let bar = bars[i];
        bar.angles = new Vec3(0, 0, 0); //0 + scriptProperties.barAlignment); 
	}
	baseOrigin = thisLayer.origin;
}



