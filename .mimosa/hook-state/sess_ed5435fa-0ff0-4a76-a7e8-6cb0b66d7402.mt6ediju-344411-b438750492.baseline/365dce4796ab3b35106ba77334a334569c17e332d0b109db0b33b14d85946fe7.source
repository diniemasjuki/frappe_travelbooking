// Copyright (c) 2026, WargaPrihatin and contributors
// For license information, please see license.txt

frappe.ui.form.on("Trip Cruise Schedule", {

	// refresh(frm) {
	// },

    // 
    sail_start: function(frm) {
        if((frm.doc.sail_end == null) || ( frm.doc.sail_start > frm.doc.sail_end )) { 
            frm.set_value("sail_end", frappe.datetime.add_days(frm.doc.sail_start, 7 ));
        }
    },

    sail_end: function(frm) {
        if((frm.doc.sail_start == null) || ( frm.doc.sail_start > frm.doc.sail_end )) {
            frm.set_value("sail_start", frappe.datetime.add_days(frm.doc.sail_end, -7 ));
        }
    },

    port_start: function(frm) {
        if(frm.doc.port_end == null) {
            frm.set_value("port_end", frm.doc.port_start );
        }
    },


});

