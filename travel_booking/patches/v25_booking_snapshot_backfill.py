"""Backfill snapshot Booking → Booking Reservation (fill-empty-only).

Reservation ialah "extension" Booking — setiap slot patut bawa konteks
booking-nya (customer, trip, tarikh, alamat, channel, kewangan). Field
fetch_from hanya terisi bila rekod disimpan melalui laluan yang memicu
_validate_links (Desk/insert); rekod lama yang dicipta sebelum field
wujud ATAU tak pernah disimpan semula tinggal kosong. Patch ni isi
semua field snapshot kosong dari sumber sebenarnya:

- Booking         → status/channel/customer/voucher/affiliate/diskaun/kewangan
- Trip Package    → trip_link/trip_name/organizer/departure_point/kod/jenis
- Trip Group Date → tarikh pergi/balik/cruise + total hari/malam
- Flight          → detail flight slot (ticket type, airline, airport, itinerary)

Khas:
- is_a_cruise / is_cruise_only DISelaraskan TANPA SYARAT dengan Booking —
  ia cermin tulen (validate_cabin_capacity pun membaca terus Booking),
  dan field Check tak boleh bezakan "0 tak diisi" vs "0 sah".
- Field numeric NOT NULL (kewangan, diskaun, prog_payment): kolum Currency/
  Percent dicipta MariaDB sebagai NOT NULL DEFAULT 0 — nilai 0.0 sedia ada
  TAK boleh dibezakan dari "belum diisi". Semua field ni derivatif TULEN
  (kiraan dari SO, read-only, tiada admin edit) jadi dikira semula TANPA
  SYARAT daripada Booking. Field Data/Link/Date (nullable) kekal
  fill-empty-only.
- Kewangan (booking_currency/total/balance/paid) dikira dari property
  virtual Booking (agregat Sales Order) — doc Booking di-load SEKALI
  setiap booking, bukan setiap slot.

Keselamatan: frappe.db.set_value(update_modified=False) — TIADA
doc.save(), jadi sync_document_status (tolak status ke Traveller),
validate_cabin_capacity dan refresh_related TIDAK tercetus. Idempoten —
nilai derivatif dikira semula sama; selamat laku berulang / di
mana-mana site.
"""

import frappe

# Kolom reservation yang perlu dibaca (uj kosong) & booking fields
# yang diperlukan — dikumpul di sini supaya query boleh di-batch.
_RESERVATION_FIELDS = [
    "name", "booking", "flight", "is_a_cruise", "is_cruise_only",
    "address_source",
    "booking_number", "customer", "customer_email",
    "trip_package", "trip_link", "trip_name", "package_title",
    "trip_organizer", "departure_point", "trip_package_code", "package_type",
    "date_selection", "departure_date", "arrival_date",
    "cruise_start", "cruise_end", "trip_cruise_schedule",
    "flight_ticket_type", "airline", "flight_departure_airport",
    "flight_departure_date", "flight_destination_airport",
    "flight_return_date", "flight_itinerary",
    "guest_address_line1", "guest_city", "guest_postcode",
    "guest_state", "guest_country",
    "booking_status", "booking_payment_status", "booking_prog_payment",
    "company", "checkout_method", "booking_channel", "customer_phone",
    "booked_by", "end_customer", "b2b_partner", "affiliate",
    "referral_code_used", "voucher", "booking_trip_name",
    "total_days", "total_nights",
    "booking_pre_discount_total", "booking_voucher_discount",
    "booking_price_rule_discount", "booking_referral_discount",
    "booking_currency", "booking_total_amount",
    "booking_balance_amount", "booking_paid_amount",
]

_BOOKING_FIELDS = [
    "booking_number", "customer", "cust_email", "trip_package",
    "trip_date", "is_a_cruise_trip", "is_cruise_only",
    "status", "payment_status", "prog_payment", "company",
    "checkout_method", "booking_channel", "get_cust_booking_phone",
    "booked_by", "end_customer", "b2b_partner", "affiliate",
    "referral_code_used", "voucher", "trip_name",
    "pre_discount_total", "voucher_discount", "price_rule_discount",
    "referral_discount",
    "cust_address_line1", "cust_city", "cust_postcode",
    "cust_state", "cust_country",
]

_TRIP_PACKAGE_FIELDS = [
    "trip_link", "trip_name", "package_title", "organizer_link",
    "airport_form", "package_code", "package_type",
]

_TRIP_DATE_FIELDS = [
    "departure_date", "return_date", "sailing_start", "sailing_end",
    "cruise_schedule", "total_days", "total_nights",
]

# reservation field ← Flight field
_FLIGHT_FIELD_MAP = {
    "flight_ticket_type":        "ticket_type",
    "airline":                   "airline",
    "flight_departure_airport":  "home_airport",
    "flight_departure_date":     "departure_date",
    "flight_destination_airport": "destination_airport",
    "flight_return_date":        "arrival_date",
    "flight_itinerary":          "flight_itinerary",
}


def _is_empty(value, numeric=False):
    """Kosong = None / string kosong. Untuk numeric (Currency/Percent/Int),
    sifar IALAH nilai sah — jangan dianggap kosong."""
    if numeric:
        return value is None
    return value in (None, "")


def execute():
    bookings = frappe.get_all(
        "Booking Reservation", pluck="booking", distinct=True,
    )
    bookings = [b for b in bookings if b]
    updated_slots = 0

    for booking_name in bookings:
        bk = frappe.db.get_value("Booking", booking_name, _BOOKING_FIELDS,
                                 as_dict=True)
        if not bk:
            continue

        pkg = None
        if bk.trip_package:
            pkg = frappe.db.get_value("Trip Package", bk.trip_package,
                                      _TRIP_PACKAGE_FIELDS, as_dict=True)
        tgd = None
        if bk.trip_date:
            tgd = frappe.db.get_value("Trip Group Date", bk.trip_date,
                                      _TRIP_DATE_FIELDS, as_dict=True)

        rows = frappe.get_all(
            "Booking Reservation",
            filters={"booking": booking_name},
            fields=_RESERVATION_FIELDS,
        )

        # Kumpul flight unik slot booking ni — detail flight di-batch
        # sekali per booking, bukan query N+1 per slot.
        flight_names = {r.flight for r in rows if r.flight}
        flight_info = {}
        for fname in flight_names:
            flight_info[fname] = frappe.db.get_value(
                "Flight", fname, list(_FLIGHT_FIELD_MAP.values()), as_dict=True,
            ) or frappe._dict()

        # Doc Booking diperlukan HANYA untuk kewangan (property virtual).
        # Load lambat — booking tanpa slot berkewangan kosong tak payah load.
        booking_doc = None

        for row in rows:
            updates = {}

            def _fill(field, value, numeric=False):
                if not _is_empty(value, numeric=numeric) and _is_empty(
                        row.get(field), numeric=numeric):
                    updates[field] = value

            # --- Snapshot sedia ada (Booking / Trip Package / Trip Date) ---
            _fill("booking_number", bk.booking_number)
            _fill("customer", bk.customer)
            _fill("customer_email", bk.cust_email)
            _fill("trip_package", bk.trip_package)
            _fill("date_selection", bk.trip_date)
            if pkg:
                _fill("trip_link", pkg.trip_link)
                _fill("trip_name", pkg.trip_name)
                _fill("package_title", pkg.package_title)
                _fill("trip_organizer", pkg.organizer_link)
                _fill("departure_point", pkg.airport_form)
                _fill("trip_package_code", pkg.package_code)
                _fill("package_type", pkg.package_type)
            if tgd:
                _fill("departure_date", tgd.departure_date)
                _fill("arrival_date", tgd.return_date)
                _fill("cruise_start", tgd.sailing_start)
                _fill("cruise_end", tgd.sailing_end)
                _fill("trip_cruise_schedule", tgd.cruise_schedule)
                _fill("total_days", tgd.total_days, numeric=True)
                _fill("total_nights", tgd.total_nights, numeric=True)

            # --- Detail flight slot (dari doc Flight slot tu) ---
            if row.flight:
                fd = flight_info.get(row.flight) or frappe._dict()
                for res_field, flight_field in _FLIGHT_FIELD_MAP.items():
                    _fill(res_field, fd.get(flight_field))

            # --- Alamat billing Booking → alamat guest slot ---
            addr_filled = False
            for res_field, bk_field in (
                ("guest_address_line1", "cust_address_line1"),
                ("guest_city",          "cust_city"),
                ("guest_postcode",      "cust_postcode"),
                ("guest_state",         "cust_state"),
                ("guest_country",       "cust_country"),
            ):
                before = row.get(res_field)
                _fill(res_field, bk.get(bk_field))
                if not addr_filled and not _is_empty(row.get(res_field)) \
                        and _is_empty(before):
                    addr_filled = True
            if addr_filled and _is_empty(row.address_source):
                updates["address_source"] = "From Booking"

            # --- Snapshot baharu (state/channel/party) — fill-empty-only ---
            _fill("booking_status", bk.status)
            _fill("booking_payment_status", bk.payment_status)
            _fill("company", bk.company)
            _fill("checkout_method", bk.checkout_method)
            _fill("booking_channel", bk.booking_channel)
            _fill("customer_phone", bk.get_cust_booking_phone)
            _fill("booked_by", bk.booked_by)
            _fill("end_customer", bk.end_customer)
            _fill("b2b_partner", bk.b2b_partner)
            _fill("affiliate", bk.affiliate)
            _fill("referral_code_used", bk.referral_code_used)
            _fill("voucher", bk.voucher)
            _fill("booking_trip_name", bk.trip_name)

            # --- Field numeric NOT NULL: kira semula TANPA SYARAT ---
            # (kolum Currency/Percent = NOT NULL DEFAULT 0 — "0 tak diisi"
            # dan "0 sah" tak boleh dibezakan; semuanya derivatif tulen)
            updates["booking_prog_payment"] = bk.prog_payment or 0
            updates["booking_pre_discount_total"] = bk.pre_discount_total or 0
            updates["booking_voucher_discount"] = bk.voucher_discount or 0
            updates["booking_price_rule_discount"] = bk.price_rule_discount or 0
            updates["booking_referral_discount"] = bk.referral_discount or 0

            # --- Kewangan (property virtual Booking — doc load lambat) ---
            # paid_amount pada Booking ialah field virtual berFORMULA
            # ("doc.total_amount - doc.balance_amount", tiada attribute
            # Python) — kira ekspresi yang sama di sini.
            if booking_doc is None:
                booking_doc = frappe.get_doc("Booking", booking_name)
            _total = booking_doc.total_amount or 0
            _balance = booking_doc.balance_amount or 0
            updates["booking_currency"] = booking_doc.currency
            updates["booking_total_amount"] = _total
            updates["booking_balance_amount"] = _balance
            updates["booking_paid_amount"] = _total - _balance

            # --- Cermin cruise: selaraskan TANPA SYARAT dengan Booking ---
            if row.is_a_cruise != int(bool(bk.is_a_cruise_trip)):
                updates["is_a_cruise"] = 1 if bk.is_a_cruise_trip else 0
            if row.is_cruise_only != int(bool(bk.is_cruise_only)):
                updates["is_cruise_only"] = 1 if bk.is_cruise_only else 0

            if updates:
                frappe.db.set_value("Booking Reservation", row.name, updates,
                                    update_modified=False)
                updated_slots += 1

    if bookings:
        frappe.logger("travel_booking").info(
            "v25_booking_snapshot_backfill: %s booking diproses, "
            "%s slot reservation dikemaskini." % (len(bookings), updated_slots)
        )
