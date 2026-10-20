// Copyright (c) 2026, WargaPrihatin and contributors
// For license information, please see license.txt

frappe.views.calendar["Trip Cruise Schedule"] = {

    field_map: {
		start: "sail_start",
		end: "sail_end",
		id: "name",
		title: "trip_name",
		allDay: "is_full_day"
	},

	options:{
		editable: false
	},
    
	gantt_options:{
		readonly: true,
		drag_drop: false,
		resizable: false,
		view_mode: 'Week',       // default view mode
        min_zoom: 'Day',        // minimum zoom level
        max_zoom: 'Month'       // optional: limit maximum zoom
	},

	gantt: true
};