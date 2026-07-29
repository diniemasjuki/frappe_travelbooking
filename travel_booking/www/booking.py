# travel_booking/www/booking.py
import frappe
import json


def get_context(context):
    # NOTA: nama parameter URL (?trip_master=&trip_group_date=) dikekalkan
    # buat masa ini supaya pautan/bookmark sedia ada tak pecah — walaupun
    # field sebenar doctype dipanggil 'trip' (bukan 'trip_master').
    trip_master     = frappe.form_dict.get("trip_master")
    trip_group_date = frappe.form_dict.get("trip_group_date")

    trips = frappe.db.sql("""
        SELECT name, trip_name, trip_code
        FROM `tabTrip`
        WHERE status = 'Active'
        ORDER BY trip_name
    """, as_dict=True)

    trip_group_dates = {}
    trip_packages    = {}
    if trips:
        trip_names = [t.name for t in trips]

        dates = frappe.db.sql("""
            SELECT name, trip, trip_group_name, trip_group_code,
                   departure_date, return_date, total_days, total_nights
            FROM `tabTrip Group Date`
            WHERE trip IN %(trips)s
              AND status = 'Active'
            ORDER BY departure_date ASC
        """, {"trips": trip_names}, as_dict=True)

        for d in dates:
            if d.trip not in trip_group_dates:
                trip_group_dates[d.trip] = []
            trip_group_dates[d.trip].append({
                "name":            d.name,
                "trip_group_name": d.trip_group_name or "",
                "trip_group_code": d.trip_group_code or "",
                "departure_date":  str(d.departure_date) if d.departure_date else "",
                "return_date":     str(d.return_date)    if d.return_date    else "",
                "total_days":      d.total_days   or 0,
                "total_nights":    d.total_nights or 0,
            })

        # Trip Packages untuk setiap Trip Group Date (produk yang dijual).
        # Relationship Package -> Group Date adalah one-to-many melalui child
        # table 'Trip Package Group Date Select' (bukan field terus pada
        # Trip Package) — jadi kita JOIN child table tu untuk cari packages.
        if dates:
            date_names = [d.name for d in dates]
            pkgs = frappe.db.sql("""
                SELECT tp.name, sel.trip_group_date, tp.package_title, tp.package_type,
                       tp.airport_form, ap.airport_name
                FROM `tabTrip Package` tp
                JOIN `tabTrip Package Group Date Select` sel ON sel.parent = tp.name
                LEFT JOIN `tabFlight Airport` ap ON ap.name = tp.airport_form
                WHERE sel.trip_group_date IN %(dates)s
                  AND tp.status = 'Active'
                ORDER BY tp.package_type ASC, tp.package_title ASC
            """, {"dates": date_names}, as_dict=True)

            for p in pkgs:
                if p.trip_group_date not in trip_packages:
                    trip_packages[p.trip_group_date] = []
                if p.airport_form:
                    flight_label = p.airport_name or p.airport_form
                else:
                    flight_label = "No Flight"
                trip_packages[p.trip_group_date].append({
                    "name":         p.name,
                    "package_name": p.package_title or "",
                    "package_type": p.package_type or "",
                    "flight":       p.airport_form or "",
                    "flight_label": flight_label,
                })

    context.trips            = trips
    context.trip_group_dates = json.dumps(trip_group_dates)
    context.trip_packages    = json.dumps(trip_packages)
    context.trip_master      = trip_master or ""
    context.trip_group_date  = trip_group_date or ""
    context.no_cache         = 1
    context.title            = "Book Your Cruise — Rarecation"