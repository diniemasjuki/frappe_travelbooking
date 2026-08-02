# travel_booking/api/portal_booking.py
# Booking Data — Portal

import frappe
from travel_booking.api._helpers import get_customer_by_email


def _get_customer():
    user_email = frappe.session.user
    if not user_email or user_email == "Guest":
        frappe.throw("Sila log in untuk meneruskan.", frappe.AuthenticationError)

    customer_name = get_customer_by_email(user_email)
    if not customer_name:
        frappe.throw("Akaun customer tidak ditemui.", frappe.AuthenticationError)

    return customer_name


@frappe.whitelist()
def get_booking_data(booking_number: str):
    frappe.flags.ignore_permissions = True
    customer_name = _get_customer()

    booking = frappe.db.sql("""
        SELECT
            b.name, b.booking_number, b.customer, b.trip_date,
            b.status,
            tm.trip_name,
            td.trip_group_name, td.departure_date, td.return_date
        FROM `tabBooking` b
        LEFT JOIN `tabTrip Group Date`   td ON td.name = b.trip_date
        LEFT JOIN `tabTrip` tm ON tm.name = td.trip
        WHERE b.booking_number = %s
    """, booking_number, as_dict=True)

    if not booking:
        frappe.throw("Booking tidak ditemui.")
    booking = booking[0]

    if booking.customer != customer_name:
        frappe.throw("Akses ditolak.", frappe.PermissionError)

    # Kunci akses ikut status (Accepted/Cancelled) DIBUANG — semua booking
    # (tak kira status atau payment_status) boleh dibuka & dilihat customer
    # dalam portal, tak kira dah bayar atau belum.

    booking_name = booking.name  # docname untuk query Reservation

    # --- Reservations ---
    # stateroom_no = bilik sebenar (admin assign dari manifest Aroya).
    # room_category = jenis bilik yang dibeli.
    slots_raw = frappe.db.sql("""
        SELECT
            res.name              AS slot_name,
            res.room_category,
            res.cabin_no,
            res.pax_type,
            res.stateroom_no,
            res.aroya_guest_no,
            res.delegate_no,
            res.flight,
            res.document_status,
            res.traveller,
            rc.room_type,
            f.pnr                 AS flight_pnr,
            f.home_airport        AS flight_home_airport,
            f.destination_airport AS flight_destination_airport,
            f.departure_date      AS flight_departure_date,
            t.first_name,
            t.last_name,
            t.full_name,
            t.ic_number,
            t.passport_no,
            t.passport_expiry,
            t.nationality,
            t.date_of_birth,
            t.email,
            t.phone,
            t.gender,
            t.age_category,
            t.passport_image,
            t.visa_photo,
            t.emergency_contact_name,
            t.emergency_contact_phone,
            t.emergency_contact_relationship,
            t.dietary_requirements,
            t.medical_conditions,
            t.special_needs
        FROM `tabBooking Reservation` res
        LEFT JOIN `tabTraveller` t          ON t.name  = res.traveller
        LEFT JOIN `tabFlight` f             ON f.name  = res.flight
        LEFT JOIN `tabTrip Price Category` rc ON rc.name = res.room_category
        WHERE res.booking = %s
        ORDER BY res.cabin_no ASC, res.creation ASC
    """, booking_name, as_dict=True)

    # Group ikut cabin_no (field EKSPLISIT pada setiap Booking Reservation
    # — diisi automatik oleh _activate_booking() untuk booking website,
    # ATAU admin isi terus semasa cipta manual di Desk). Ini gantikan
    # logic LAMA (Pass1: text-match stateroom_no, Pass2: parse balik SO
    # layout) yang rapuh — cabin_no sekarang SUMBER TUNGGAL untuk
    # grouping, stateroom_no cuma dipaparkan sebagai maklumat TAMBAHAN
    # dalam kad cabin (bukan penentu kumpulan lagi). Consistency check
    # untuk stateroom_no antara sibling DITANGGUHKAN buat masa ini
    # (keputusan bersama — ada rancangan paparan lain untuk stateroom_no).
    all_slots = []
    traveller_counter = 0

    for raw in slots_raw:
        traveller_counter += 1
        is_filled   = bool(raw.traveller)
        is_verified = raw.document_status == "Verified"

        slot = {
            "slot_name":         raw.slot_name,
            "slot_label":        "Traveller " + str(traveller_counter) + (" (" + raw.pax_type + ")" if raw.pax_type else ""),
            "age_category":      raw.age_category      or "",
            "room_category":     raw.room_category     or "",
            "room_type":         raw.room_type         or "",
            "pax_type":          raw.pax_type          or "",
            "stateroom_no":      raw.stateroom_no      or "",
            "delegate_no":       raw.delegate_no       or "",
            "aroya_guest_no":    raw.aroya_guest_no    or "",
            "flight":            raw.flight            or "",
            "flight_pnr":        raw.flight_pnr        or "",
            "flight_departure":  raw.flight_home_airport        or "",
            "flight_arrival":    raw.flight_destination_airport or "",
            "document_status":   raw.document_status   or "Pending",
            "filled":            is_filled,
            "is_verified":       is_verified,
            "traveller_id":      raw.traveller         or "",
            "full_name":         raw.full_name         or "",
            "first_name":        raw.first_name        or "",
            "last_name":         raw.last_name         or "",
            "ic_number":         raw.ic_number         or "",
            "passport_no":       raw.passport_no       or "",
            "passport_expiry":   str(raw.passport_expiry) if raw.passport_expiry else "",
            "nationality":       raw.nationality       or "",
            "date_of_birth":     str(raw.date_of_birth) if raw.date_of_birth else "",
            "email":             raw.email             or "",
            "phone":             raw.phone             or "",
            "gender":            raw.gender            or "",
            "has_passport":      bool(raw.passport_image),
            "has_visa_photo":    bool(raw.visa_photo),
            "emergency_contact_name":         raw.emergency_contact_name         or "",
            "emergency_contact_phone":        raw.emergency_contact_phone        or "",
            "emergency_contact_relationship": raw.emergency_contact_relationship or "",
            "dietary_requirements": raw.dietary_requirements or "",
            "medical_conditions":   raw.medical_conditions   or "",
            "special_needs":        raw.special_needs        or "",
        }

        slot["_cabin_no"] = raw.cabin_no or 0
        slot["_rc"]       = raw.room_category or ""
        all_slots.append(slot)

    def _mkcabin(room_category, stateroom, cslots, cabin_no_hint=0):
        return {
            "cabin_assignment": stateroom or "",
            "cabin_no":         cabin_no_hint,
            "room_name":        room_category or "",
            "room_category":    room_category or "",
            "state_room":       stateroom or "",
            "stateroom_no":     stateroom or "",
            "assigned":         bool(stateroom),
            "slots":            cslots,
        }

    cabins = []

    # Utama: group ikut cabin_no (rekod TERKINI, sentiasa diisi).
    cabin_map   = {}
    cabin_order = []
    no_cabin_no = []
    for slot in all_slots:
        if slot["_cabin_no"]:
            key = slot["_cabin_no"]
            if key not in cabin_map:
                cabin_map[key] = _mkcabin(slot["_rc"], slot["stateroom_no"], [], key)
                cabin_order.append(key)
            cabin_map[key]["slots"].append(slot)
            # stateroom_no dipaparkan dari SIBLING PERTAMA yang ada nilai —
            # cuma paparan, tak paksa konsisten (validation ditangguh).
            if not cabin_map[key]["stateroom_no"] and slot["stateroom_no"]:
                cabin_map[key]["stateroom_no"]     = slot["stateroom_no"]
                cabin_map[key]["state_room"]       = slot["stateroom_no"]
                cabin_map[key]["cabin_assignment"] = slot["stateroom_no"]
                cabin_map[key]["assigned"]         = True
        else:
            no_cabin_no.append(slot)
    for k in sorted(cabin_order):
        cabins.append(cabin_map[k])

    # Fallback UNTUK REKOD LAMA sahaja (cabin_no belum diisi, dari sebelum
    # field ni wujud) — group ikut room_category, letak SELEPAS cabin yang
    # dah ada cabin_no.
    if no_cabin_no:
        cat_map   = {}
        cat_order = []
        for slot in no_cabin_no:
            key = slot["_rc"] or "?"
            if key not in cat_map:
                cat_map[key] = _mkcabin(slot["_rc"], "", [])
                cat_order.append(key)
            cat_map[key]["slots"].append(slot)
        for k in cat_order:
            cabins.append(cat_map[k])

    # Nombor cabin PAPARAN (1, 2, 3... berturutan) — guna urutan senarai
    # cabins di atas, BUKAN cabin_no mentah, supaya paparan sentiasa
    # 1..N berturutan walaupun cabin_no yang disimpan tak berturutan.
    for i, c in enumerate(cabins, 1):
        c["cabin_no"] = i
    for slot in all_slots:
        slot.pop("_cabin_no", None)
        slot.pop("_rc", None)

    slots = []
    for cabin in cabins:
        slots.extend(cabin["slots"])

    total_slots  = len(slots)
    filled_count = sum(1 for s in slots if s["filled"])

    # payment_status & totals dikira dari GABUNGAN SEMUA SO yang berkaitan
    # booking (SO utama + SO addon). Sama helper dengan api/booking.py
    # (single source of truth) — elak papar nilai stale.
    from travel_booking.api.booking import _compute_payment_status, _get_all_booking_sales_orders, _get_primary_so

    grand_total  = 0.0
    advance_paid = 0.0
    for so_name in _get_all_booking_sales_orders(booking_name):
        so_vals = frappe.db.get_value("Sales Order", so_name,
                                      ["grand_total", "rounded_total", "advance_paid"], as_dict=True)
        if so_vals:
            # PENTING: guna rounded_total (fallback grand_total) — konsisten
            # dengan get_all_so_payments() (portal_payment.py) dan
            # _recompute_booking_status()/create_payment_request() (booking.py/
            # stripe_checkout.py) supaya payment_status & total yang dipapar
            # di sini SEPADAN dengan apa yang backend guna untuk validate
            # bayaran sebenar — elak "portal kata ada baki, bayar kata dah
            # settle" atau payment_status tersangkut salah selama-lamanya.
            grand_total  += float(so_vals.rounded_total or so_vals.grand_total or 0)
            advance_paid += float(so_vals.advance_paid or 0)

    primary_so = _get_primary_so(booking_name)

    so_data = {
        "grand_total":  grand_total,
        "advance_paid": advance_paid,
        "status":       frappe.db.get_value("Sales Order", primary_so, "status") if primary_so else None,
    }

    # Kunci "Traveller Details di-lock sehingga Confirmed/Completed" DIBUANG —
    # traveller details boleh diisi bila-bila masa, tak kira status atau
    # payment_status. can_edit_traveller_details kekal dalam response (untuk
    # backward compat dengan frontend) tapi sentiasa True sekarang.
    can_edit_traveller_details = True

    payment_status = _compute_payment_status(advance_paid, grand_total)

    return {
        "booking": {
            "name":           booking.name,
            "booking_number": booking.booking_number or booking.name,
            "trip_name":      booking.trip_name       or "-",
            "trip_type":      "",
            "group_name":     booking.trip_group_name or "",
            "sailing_no":     booking.trip_group_name or "",
            "departure_date": str(booking.departure_date) if booking.departure_date else "",
            "return_date":    str(booking.return_date)    if booking.return_date    else "",
            "sales_order":    primary_so or "",
            "total_slots":    total_slots,
            "filled_count":   filled_count,
            "booking_status": booking.status or "",
            "payment_status": payment_status,
            "can_edit_traveller_details": can_edit_traveller_details,
        },
        "slots":   slots,
        "cabins":  cabins,
        "payment": {"so": so_data},
    }