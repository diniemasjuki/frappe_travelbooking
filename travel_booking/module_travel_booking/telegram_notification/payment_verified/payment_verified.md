Transaksi pembayaran ini telah disahkan.

Nama: {{doc.party_name}}
Paid Amount: {{doc.paid_from_account_currency}} {{ doc.paid_amount }}
Received Amount: {{doc.paid_to_account_currency}} {{doc.received_amount}}{%- set ns = namespace(so_ref=none) -%}
{%- for r in doc.references %}{% if not ns.so_ref and r.reference_doctype == "Sales Order" %}{% set ns.so_ref = r.reference_name %}{% endif %}{% endfor -%}
{%- set booking_name = frappe.db.get_value("Sales Order", ns.so_ref, "custom_booking") if ns.so_ref else none -%}
{%- set b = frappe.db.get_value("Booking", booking_name, ["booking_number","trip_title","trip_package","trip_date","departure_date","return_date"], as_dict=True) if booking_name else none -%}
{%- set pkg = frappe.db.get_value("Trip Package", b.trip_package, "package_title") if b and b.trip_package else none -%}
{%- set gd = frappe.db.get_value("Trip Group Date", b.trip_date, "trip_group_name") if b and b.trip_date else none -%}
{%- set dates = (" (" ~ b.departure_date ~ ((" - " ~ b.return_date) if b.return_date else "") ~ ")") if b.departure_date else "" -%}
{% if b and b.booking_number %}{{ "\n\nBooking No. #" ~ b.booking_number ~ ("\n\nTrip: \n" ~ b.trip_title if b.trip_title else "") ~ ("\n\nPackage: \n" ~ pkg if pkg else "") ~ ("\n\nGroup Date: \n" ~ gd ~ dates if gd else "") }}{% endif %}

Alhamdulillah