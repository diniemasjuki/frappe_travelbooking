// Copyright (c) 2026, WargaPrihatin and contributors
// For license information, please see license.txt

frappe.ui.form.on("Flight", {
	refresh(frm) {

	},

    departure_date: function(frm) {
        if((frm.doc.arrival_date == null) || ( frm.doc.departure_date > frm.doc.arrival_date )) { 
            frm.set_value("arrival_date", frappe.datetime.add_days(frm.doc.departure_date, 7 ));
        }
    },

    arrival_date: function(frm) {
        if((frm.doc.departure_date == null) || ( frm.doc.departure_date > frm.doc.arrival_date )) {
            frm.set_value("departure_date", frappe.datetime.add_days(frm.doc.arrival_date, -7 ));
        }
    },


});
