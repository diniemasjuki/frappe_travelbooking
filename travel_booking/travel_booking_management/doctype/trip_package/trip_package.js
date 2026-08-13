// Copyright (c) 2026, WargaPrihatin and contributors
// For license information, please see license.txt

// frappe.ui.form.on("Trip Package", {
// 	refresh(frm) {

// 	},
// });


frappe.ui.form.on("Trip Package", {

	refresh(frm) {

        if( frm.doc.trip_link ){

            set_filter_group_date(frm);

        }
        
        

	},

    // IMPORT FROM CRUISE TABLE
    import_from_cruise_rate : function(frm) {

        // clear dulu child table kalau perlu
        frm.clear_table("package_pricing");

        // pilihan: get 1st row multilink only
        if (frm.doc.select_group_by_date && frm.doc.select_group_by_date.length > 0){
                // fetch data from this (Trip Package) form
                let first_link = frm.doc.select_group_by_date[0];
            
                // fetch data from "Trip Group Date" record dari server
                frappe.db.get_doc('Trip Group Date', first_link.trip_group_date).then( tripGroupDate => {
                    
                    // fetch data from "Trip Cruise Schedule" record dari server
                    frappe.db.get_doc('Trip Cruise Schedule', tripGroupDate.cruise_schedule).then( tripCruiseSchedule => {
                    
                        // loop child table dalam Doctype C (yang ada dalam B)
                        (tripCruiseSchedule.cabin_rates || []).forEach( row => {
                        
                            let child = frm.add_child("package_pricing"); 

                            child.pricing_for_class	 = row.pricing_for_class;
                            child.price_adult_single = row.price_adult_single;
                            child.price_adult		 = row.price_adult;
                            child.price_upperberth 	 = row.price_upperberth;
                            child.price_children 	 = row.price_children;
                            child.price_toddler 	 = row.price_toddler;
                            child.price_infant 		 = row.price_infant;

                            // updating the table view after adding the child rows
                            frm.refresh_field("package_pricing");

                        });
                            
                    });

                }
            );
        }
        
        frm.refresh_field("package_pricing");
        // frappe.msgprint("Data imported from Doctype B!");
    },

    // TRIGGER IF TRIP VALUE CHANGES
    trip_link: function(frm) {

        frm.set_value("select_group_by_date", null);

        set_filter_group_date(frm);
        
    },


    //
    is_cruise_only: function(frm){

        frm.set_value("select_group_by_date", null);
        frm.set_value("airport_form", null);

        set_filter_group_date(frm);

    },


    //
    package_type: function(frm){

        if(frm.doc.package_type === "Fly Package"){

            frm.set_df_property('airport_form', 'reqd', 1);

        }
    }

});




function set_filter_group_date(frm){

    // if this is a cruise trip
    if (frm.doc.is_a_cruise_trip){

        // update package type option
        frm.set_df_property('package_type', 'options', [
            'Fly Cruise',
            'Cruise Only'
        ]);

        // is a cruise only
        if (frm.doc.is_cruise_only == 1 ){

            // Update filter untuk child table field pricing_for_class
            frm.fields_dict['package_pricing'].grid.get_field('pricing_for_class').get_query = function(doc, cdt, cdn) {
                return {
                    filters: {
                        'is_a_cruise': true   // contoh field dalam TripPriceCategory
                    }
                };

            };


            // LIST KAN DATE TRIP CRUISE-ONLY
            frm.fields_dict['select_group_by_date'].get_query = function(doc) {
                return {
                    filters: {
                        "trip": frm.doc.trip_link,
                        "is_cruise_only": true
                    }
                };
            };

            frm.set_value("package_type", "Cruise Only");
        }

        // is a cruise trip
        if(frm.doc.is_cruise_only == 0){

            // LIST KAN DATE TRIP FLY-CRUISE
            frm.fields_dict['select_group_by_date'].get_query = function(doc) {
                return {
                    filters: {
                        "trip": frm.doc.trip_link,
                        "is_cruise_only": false
                    }
                };
            };

            frm.set_value("package_type", "Fly Cruise");
        }

    }
    
    // is a normal tour (rarecation trip)
    else{

        // LIST KAN DATE TRIP BIASA.
        frm.fields_dict['select_group_by_date'].get_query = function(doc) {
            return {
                filters: {
                    "trip": frm.doc.trip_link
                }
            };
        };
        
        frm.set_df_property('package_type', 'options', [
            'Fly Package',
            'Ground Only',
            'Customed'
        ]);

        // Update filter untuk child table field pricing_for_class
        frm.fields_dict['package_pricing'].grid.get_field('pricing_for_class').get_query = function(doc, cdt, cdn) {
            return {
                filters: {
                    'is_a_cruise': false   // contoh field dalam TripPriceCategory
                }
            };
        };


    }

}