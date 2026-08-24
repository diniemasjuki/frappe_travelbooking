// Copyright (c) 2026, WargaPrihatin and contributors
// For license information, please see license.txt

// frappe.ui.form.on("Trip Group Date", {
// 	refresh(frm) {
// 	},
// });



frappe.ui.form.on("Trip Group Date", {    

    // setting onload
    refresh(frm) {

        if( frm.doc.filter_by_trip && frm.doc.trip ){
            frm.set_query("cruise_schedule", function() {
                return {
                    filters: [ 
                        // ikut nilai semasa field lain
                        ["Trip Cruise Schedule", "trip_link", "=", frm.doc.trip]
                    ]
                };
            });
        }

    },



    //
    filter_by_trip:function(frm){

        if( frm.doc.filter_by_trip && frm.doc.trip ){
            frm.set_query("cruise_schedule", function() {
                return {
                    filters: [ 
                        // ikut nilai semasa field lain
                        ["Trip Cruise Schedule", "trip_link", "=", frm.doc.trip]
                    ]
                };
            });
        }else{
            frm.set_query("cruise_schedule", function() {
                return {
                    filters: [ ]
                };
            });
        }
    },



    // TRIGGER IF TRIP VALUE CHANGES
    trip_name: function(frm) { 

        // 
        if(frm.doc.is_a_cruise_trip == 0) {
            frm.set_value("is_cruise_only", 0);
            frm.set_value("max_participants", 12);
        }else if(frm.doc.is_a_cruise_trip == 1) {
            frm.set_value("max_participants", 0);
        }


        frm.set_query("cruise_schedule", function() {
            return {
                filters: [ 
                    // ikut nilai semasa field lain
                    ["Trip Cruise Schedule", "trip_link", "=", frm.doc.trip]
                ]
            };
        });

        if( frm.doc.cruise_schedule) {
            frm.set_value("cruise_schedule",null);
        }

    },


    // TRIGGER IF TRIP VALUE CHANGES
    is_cruise_only: function(frm) {
        frm.set_value("max_participants", 0);
    },


    departure_date: function(frm) {

        if(frm.doc.is_a_cruise_trip && frm.doc.is_a_cruise_trip == 0) {
            var length_of_trip = 14;            
        }else{
            if(frm.doc.cruise_days && frm.doc.cruise_days > 0) {
                var length_of_trip = frm.doc.cruise_days;
            }else{
                var length_of_trip = 7;
            }
        }
        
        if( (frm.doc.departure_date && frm.doc.return_date && frm.doc.departure_date > frm.doc.return_date ) || (frm.doc.return_date == null) ) {
            frm.set_value("return_date", frappe.datetime.add_days(frm.doc.departure_date, length_of_trip ));
            frm.set_value("departure_date", frm.doc.departure_date);
        }
    },


    // 
    sailing_start: function(frm) {
        frm.set_value("departure_date", frappe.datetime.add_days(frm.doc.sailing_start, -1 ));
        frm.set_value("return_date", frappe.datetime.add_days(frm.doc.sailing_end, 1 ));
    },

    
    //
    validate: function(frm) {
        if ( (frm.doc.sailing_start == frm.doc.departure_date || frm.doc.sailing_end == frm.doc.return_date) && frm.doc.is_cruise_only == 0 ) {
            alert("Are you sure that DEPARTURE DATE IS SAME as SAILING START DATE and RETURN DATE IS SAME as SAILING END DATE? If yes, please tick the 'CRUISE ONLY' checkbox.");
        }
    },

});