// Copyright (c) 2026, WargaPrihatin and contributors
// For license information, please see license.txt

frappe.views.calendar["Trip Group Date"] = {

    field_map: {
		start: "departure_date",
		end: "return_date",
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

		start_date_limit: frappe.datetime.add_months(frappe.datetime.now_date(), -1),
    	end_date_limit: frappe.datetime.add_months(frappe.datetime.now_date(), 1),


        min_zoom: 'Day',        // minimum zoom level
        max_zoom: 'Month',       // optional: limit maximum zoom
		view_mode: 'Week'       // default view mode
	},

	gantt: true
};