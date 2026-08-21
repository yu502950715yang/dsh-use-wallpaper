'use strict';
// Please note: Do not remove this line or asset references may break.
export let __workshopId = '2519054915';

export var scriptProperties = createScriptProperties()
	// Whether you want a 24h or 12h style format
	.addCheckbox({
		name: 'use24hFormat',
		label: 'ui_editor_properties_use_24h_format',
		value: true
	})
	// This will be used to separate each element
	.addText({
		name: 'delimiter',
		label: 'ui_editor_properties_delimiter',
		value: ':'
	})
	.finish();

/**
 * @param {String} value (for property 'text')
 */
export function update(value) {
	let space = " ";
	let ent = "\n";
	let time = new Date();
	let months = [
  'Jan.',
  'Feb.',
  'Mar.',
  'Apr.',
  'May.',
  'Jun.',
  'Jul.',
  'Aug.',
  'Sep.',
  'Oct.',
  'Nov.',
  'Dec.'
];
	var hours = time.getHours();
	if (!scriptProperties.use24hFormat) {
	if (hours < 12) {
			var meridiem = 'AM';
		}
	if (hours >= 12) {
			var meridiem = 'PM';
		}
		hours %= 12;
		if (hours == 0) {
			hours = 12;
		}
	}
	hours = ("00" + hours).slice(-2);
	let minutes = ("00" + time.getMinutes()).slice(-2);
	//24 hour format off
	if (!scriptProperties.use24hFormat) {
	var value = meridiem + space + hours + scriptProperties.delimiter + minutes + ent + months[time.getMonth()] + space + time.getDate() + space + time.getFullYear();
	}
	//24 hour format on
	if (scriptProperties.use24hFormat) {
	var value = hours + scriptProperties.delimiter + minutes + ent + months[time.getMonth()] + space + time.getDate() + space + time.getFullYear();
	}
	return value;
}
