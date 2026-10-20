// Usage:
// Bind to a Text Layer, Text Property (to the right of where you can enter text, click on the gear/cog icon and select bind script). Compile the script to ensure Script Properties show up in editor. Run Scripts to view live in editor or Apply Wallpaper to view live on Desktop.

'use strict';

export let __workshopId = '2108644365';


export var scriptProperties = createScriptProperties()
	.addCombo({
		name: 'monthFormat',
		label: 'Month Format',
		options: [{
			label: 'Numeric',
			value: '1'
		}, {
			label: 'Abbreviated',
			value: '2'
		},{
			label: 'Full',
			value: '3'
		}]
	})
	.addCombo({
		name: 'dayFormat',
		label: 'Day Format',
		options: [{
			label: 'Abbreviated',
			value: '1'
		}, {
			label: 'Full',
			value: '2'
		}]
	})
	.addCheckbox({
		name: 'showDay',
		label: 'Show Day',
		value: false
	})
   .addCheckbox({
		name: 'alignVertical',
		label: 'Align Day Vertically',
		value: false
	})
  .addCheckbox({
		name: 'useDelimiter',
		label: 'Use Delimiter',
		value: false
	})
	.addText({
		name: 'addDelimiter',
		label: 'Delimiter',
		value: '/'
	})
	.finish();


let months;
let day;
var delimiterValue;
var newLine;
/**
 * @param {String} value (for property 'text')
 */
export function update(value){
  if (scriptProperties.useDelimiter == true){
  delimiterValue = scriptProperties.addDelimiter
}
  if (scriptProperties.useDelimiter == false){
   delimiterValue = [
  ' '
]
}
if (scriptProperties.alignVertical == true){
   newLine = [
  '\n'
]
}
if (scriptProperties.alignVertical == false){
   newLine = [
  ''
]
}
  if (scriptProperties.monthFormat == 1){
  months = [
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  '11',
  '12'
]
}
 if (scriptProperties.monthFormat == 2){
 months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
]
}
if (scriptProperties.monthFormat == 3){
 months = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]
}
if (scriptProperties.dayFormat == 1){
  day = [
  'Sun',
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  '\nSat'
]
}
if (scriptProperties.dayFormat == 2){
 day = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  '\nSaturday'
]
}
	let date = new Date();{
    if (scriptProperties.showDay == true ){
    return day[date.getDay()] + newLine + ' ' + date.getDate() + delimiterValue + months[date.getMonth()] + delimiterValue + date.getFullYear();
    }
    if (scriptProperties.showDay == false ){
	return   date.getDate() + delimiterValue + months[date.getMonth()] + delimiterValue + date.getFullYear();
}
}
}
