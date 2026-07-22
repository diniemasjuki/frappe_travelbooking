# travel_booking/www/booking.py
import frappe
import json


def get_context(context):
    trip_master = frappe.form_dict.get("trip_master")
    trip_date   = frappe.form_dict.get("trip_date")

    trips = frappe.db.sql("""
        SELECT name, trip_name, trip_type, trip_code,
               duration_days, duration_nights
        FROM `tabTrip Master`
        WHERE status = 'Active'
        ORDER BY trip_type, trip_name
    """, as_dict=True)

    trip_dates    = {}
    trip_packages = {}
    if trips:
        dates = frappe.db.sql("""
            SELECT name, trip_master, sailing_no, departure_date, return_date
            FROM `tabTrip Date`
            WHERE trip_master IN %(masters)s
              AND status = 'Active'
            ORDER BY departure_date ASC
        """, {"masters": [t.name for t in trips]}, as_dict=True)

        for d in dates:
            if d.trip_master not in trip_dates:
                trip_dates[d.trip_master] = []
            trip_dates[d.trip_master].append({
                "name":           d.name,
                "sailing_no":     d.sailing_no,
                "departure_date": str(d.departure_date) if d.departure_date else "",
                "return_date":    str(d.return_date)    if d.return_date    else "",
            })

        # Trip Packages untuk setiap Trip Date (produk yang dijual)
        if dates:
            pkgs = frappe.db.sql("""
                SELECT tp.name, tp.trip_date, tp.package_name, tp.package_type,
                       tp.flight, f.airline, f.home_airport, f.departure_date
                FROM `tabTrip Package` tp
                LEFT JOIN `tabFlight` f ON f.name = tp.flight
                WHERE tp.trip_date IN %(dates)s
                  AND tp.status = 'Active'
                ORDER BY tp.package_type ASC, tp.package_name ASC
            """, {"dates": [d.name for d in dates]}, as_dict=True)

            for p in pkgs:
                if p.trip_date not in trip_packages:
                    trip_packages[p.trip_date] = []
                if p.flight:
                    flight_label = (p.airline or "Flight")
                    if p.home_airport:
                        flight_label = flight_label + " · " + p.home_airport
                else:
                    flight_label = "No Flight"
                trip_packages[p.trip_date].append({
                    "name":         p.name,
                    "package_name": p.package_name,
                    "package_type": p.package_type,
                    "flight":       p.flight or "",
                    "flight_label": flight_label,
                })

    context.trips         = trips
    context.trip_dates    = json.dumps(trip_dates)
    context.trip_packages = json.dumps(trip_packages)
    context.trip_master   = trip_master or ""
    context.trip_date     = trip_date   or ""
    context.no_cache      = 1
    context.title         = "Book Your Cruise — Rarecation"