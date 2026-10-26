{{ doc.customer }}
{{ doc.get_cust_phone }}
{{ doc.cust_email }}

-----------

Booking No.: #{{ doc.booking_number }}

Trip: {{ doc.trip_name }}{% if doc.trip_title %}
{{ doc.trip_title }}{% endif %}

Date Group: {{ doc.trip_date }}{% if doc.trip_date_group_name %}
{{ doc.trip_date_group_name }}{% endif %}

Package: {{ doc.trip_package }}{% if doc.trip_package_name %}
{{ doc.trip_package_name }}{% endif %}

Order Summary:
{{ doc.order_summary or "(no items)" }}

Checkout:
{{ doc.company }}
Amount (After Disc): {{ '{:,.2f}'.format(doc.total_amount or 0) }} {{ doc.currency }}
Amount Due (checkout): {{ '{:,.2f}'.format(doc.payment_due_amount or 0) }} {{ doc.currency }}
Payment Method: {{ doc.checkout_method }}

-----------

Message:
{{ doc.customer_message or "" }}