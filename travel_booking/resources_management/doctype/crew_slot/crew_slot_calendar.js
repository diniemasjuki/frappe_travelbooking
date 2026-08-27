// Crew Slot Calendar & Gantt Configuration
// This configures Frappe's built-in calendar view for Crew Slot doctype
// READ-ONLY mode for safety (no drag-drop editing)

frappe.views.calendar["Crew Slot"] = {
	field_map: {
		start: "start_date",
		end: "end_date",
		id: "name",
		title: "name",
		status: "status",
		allDay: 1,
	},
	options: {
		editable: false, // READ-ONLY: Disable drag-drop
		headerToolbar: {
			left: "prev,next today",
			center: "title",
			right: "dayGridMonth,timeGridWeek,listWeek",
		},
		eventColor: "#3b82f6",
		eventDidMount: function (info) {
			var event = info.event;
			var status = event.extendedProps.status || "Planned";

			var statusColors = {
				Planned: "#3b82f6",
				Confirmed: "#10b981",
				Cancelled: "#ef4444",
				Completed: "#6b7280",
			};

			if (statusColors[status]) {
				event.setProp("backgroundColor", statusColors[status]);
				event.setProp("borderColor", statusColors[status]);
			}

			info.el.setAttribute("title", event.title + "\nStatus: " + status);
		},
	},
	gantt: true,
	gantt_options: {
		readonly: true, // SAFETY: Completely disable moving/resizing
		view_mode: "Week",
		min_zoom: "Day",
		max_zoom: "Month",
		bar_height: 30,
		padding: 18,
		view_resize: false,
		date_format: "YYYY-MM-DD",
		language: "en",
		custom_popup_html: function (task) {
			var status = task.status || "Planned";
			return (
				'<div class="gantt-popup-details">' +
				'<div class="gantt-popup-title">' + task.name + "</div>" +
				'<div class="gantt-popup-info">' +
				"<span><b>Dates:</b> " + task.start + " to " + task.end + "</span><br>" +
				"<span><b>Status:</b> " + status + "</span><br>" +
				"<span><b>Trip:</b> " + (task.trip_name || "Not linked") + "</span><br>" +
				"<span><b>Crew Assigned:</b> " + (task.current_crew || 0) + " / " + (task.max_crew || 1) + "</span>" +
				"</div></div>"
			);
		},
	},
};
