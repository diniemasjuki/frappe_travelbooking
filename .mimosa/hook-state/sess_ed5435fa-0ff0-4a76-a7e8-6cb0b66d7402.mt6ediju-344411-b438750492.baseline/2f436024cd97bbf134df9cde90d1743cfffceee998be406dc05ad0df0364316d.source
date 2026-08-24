# travel_booking/api/portal_booking.py
# Booking Data — Portal

import frappe
from travel_booking.api._helpers import get_customer_by_email


def _get_customer():
    """Pulang nama Customer untuk user yang sedang login, atau throw.

    KONSISTEN dgn check_session() (portal_auth.py): staff/admin dengan
    role "Traveller" TANPA rekod Customer dibenarkan masuk portal
    (dashboard kosong) — tetapi mereka TIDAK ada customer untuk buka
    booking/payment. Jadi untuk endpoint yang spesifik perlukan Customer
    (cth get_booking_data, save_traveller), kita throw dgn mesej JELAS
    (bukan generic "AuthenticationError" yang seolah-olah mereka belum
    login). Sebelum ni, staff Traveller nampak "anda login" (dashboard)
    tapi setiap klik dapat AuthenticationError — mengelirukan.

    Mesej sekarang: penjelasan "anda tiada rekod customer" supaya
    frontend/user faham ia bukan masalah session/auth.
    """
    user_email = frappe.session.user
    if not user_email or user_email == "Guest":
        frappe.throw("Please log in to continue.", frappe.AuthenticationError)

    customer_name = get_customer_by_email(user_email)
    if not customer_name:
        # Boleh jadi: (a) staff Traveller (sah, tiada Customer), atau
        # (b) customer sebenar yang Contact-nya putus (bug data). Mesej
        # neutral untuk kedua-dua kes — bukan AuthenticationError (yang
        # mengelirukan: user sebenarnya SAH login).
        frappe.throw(
            "No customer record found for this account. "
            "Access to bookings/transactions requires a customer record.",
            frappe.PermissionError
        )

    return customer_name


@frappe.whitelist()
def get_booking_data(booking_number: str):
    frappe.flags.ignore_permissions = True
    customer_name = _get_customer()

    booking = frappe.db.sql("""
        SELECT
            b.name, b.booking_number, b.customer, b.trip_date,
            b.trip_package, b.status,
            -- Trip info
            tm.trip_name,
            tm.is_a_cruise_trip AS trip_is_cruise,
            -- Trip Group Date info (dates, sailing, ports)
            td.trip_group_name, td.departure_date, td.return_date,
            td.embarkation_port, td.disembarkation_port,
            td.sailing_start, td.sailing_end,
            td.ship_name, td.ship_code,
            td.is_cruise_only AS tgd_cruise_only,
            -- Trip Package info (package type, airport)
            tp.package_title, tp.package_code, tp.package_type,
            tp.is_cruise_only AS pkg_cruise_only,
            tp.airport_form AS depart_airport,
            -- Flight Airport info
            fa.airport_name, fa.airport_code, fa.airport_city,
            -- Port names (resolve Link fields to display names)
            ep.destination_name AS embark_port_name,
            dp.destination_name AS disembark_port_name
        FROM `tabBooking` b
        LEFT JOIN `tabTrip Group Date`        td  ON td.name  = b.trip_date
        LEFT JOIN `tabTrip`                    tm  ON tm.name  = td.trip
        LEFT JOIN `tabTrip Package`            tp  ON tp.name  = b.trip_package
        LEFT JOIN `tabFlight Airport`          fa  ON fa.name  = tp.airport_form
        LEFT JOIN `tabTrip Destination Point`  ep  ON ep.name  = td.embarkation_port
        LEFT JOIN `tabTrip Destination Point`  dp  ON dp.name  = td.disembarkation_port
        WHERE b.booking_number = %s
    """, booking_number, as_dict=True)

    if not booking:
        frappe.throw("Booking not found.")
    booking = booking[0]

    if booking.customer != customer_name:
        frappe.throw("Access denied.", frappe.PermissionError)

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
            "passport_image":    raw.passport_image or "",
            "visa_photo":        raw.visa_photo or "",
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

    primary_so = _get_primary_so(booking_name)

    # Bina senarai SEMUA SO (untuk paparan "Bill Orders" di portal)
    so_list = []
    grand_total  = 0.0
    advance_paid = 0.0
    for so_name in _get_all_booking_sales_orders(booking_name):
        so_vals = frappe.db.get_value("Sales Order", so_name,
                                      ["grand_total", "advance_paid", "status"], as_dict=True)
        if so_vals:
            gt = float(so_vals.grand_total or 0)
            ap = float(so_vals.advance_paid or 0)
            grand_total  += gt
            advance_paid += ap
            so_list.append({
                "name":         so_name,
                "grand_total":  gt,
                "advance_paid": ap,
                "balance":      gt - ap,
                "status":       so_vals.status or "Draft",
            })

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

    # Determine trip classification
    is_cruise = bool(booking.trip_is_cruise)
    cruise_only = bool(booking.pkg_cruise_only or booking.tgd_cruise_only)
    pkg_type = booking.package_type or ""

    # Build display labels based on type
    if is_cruise:
        if cruise_only:
            trip_category = "Cruise Only"
        elif pkg_type == "Fly Cruise":
            trip_category = "Fly Cruise"
        elif pkg_type == "Customed":
            trip_category = "Cruise (Custom)"
        else:
            trip_category = "Cruise Trip"
    else:
        if pkg_type == "Ground Only":
            trip_category = "Ground Only"
        elif pkg_type == "Fly Package":
            trip_category = "Fly Package"
        elif pkg_type == "Customed":
            trip_category = "Tour (Custom)"
        else:
            trip_category = "Tour Package"

    return {
        "booking": {
            "name":           booking.name,
            "booking_number": booking.booking_number or booking.name,
            "trip_name":      booking.trip_name       or "-",
            # Trip classification
            "is_cruise":      is_cruise,
            "cruise_only":    cruise_only,
            "package_type":   pkg_type,
            "trip_category":  trip_category,
            # Package info
            "package_title":  booking.package_title  or "",
            "package_code":   booking.package_code   or "",
            # Dates
            "departure_date": str(booking.departure_date) if booking.departure_date else "",
            "return_date":    str(booking.return_date)    if booking.return_date    else "",
            # Sailing (cruise only)
            "sailing_start":  str(booking.sailing_start) if booking.sailing_start else "",
            "sailing_end":    str(booking.sailing_end)   if booking.sailing_end   else "",
            # Ports & Ship (resolve Link names)
            "embarkation_port":   booking.embark_port_name    or booking.embarkation_port   or "",
            "disembarkation_port": booking.disembark_port_name or booking.disembarkation_port or "",
            "ship_name":          booking.ship_name          or "",
            "ship_code":          booking.ship_code          or "",
            # Airport (for fly packages)
            "depart_airport":     booking.depart_airport     or "",
            "airport_name":       booking.airport_name       or "",
            "airport_code":       booking.airport_code       or "",
            "airport_city":       booking.airport_city         or "",
            # Group/Trip code
            "group_name":         booking.trip_group_name    or "",
            # Status & counts
            "sales_order":        primary_so or "",
            "total_slots":        total_slots,
            "filled_count":       filled_count,
            "booking_status":     booking.status or "",
            "payment_status":     payment_status,
            "can_edit_traveller_details": can_edit_traveller_details,
        },
        "slots":   slots,
        "cabins":  cabins,
        "payment": {"so": so_data, "so_list": so_list},
    }


@frappe.whitelist()
def get_bookings_list():
    """Senarai SEMUA booking customer untuk page My Bookings (multi-page
    portal) — data mini-info setiap kad booking dalam satu panggilan.

    Pulangkan list (disusun ikut departure_date ASC):
      booking_number, trip_name, group_name, departure_date, return_date,
      booking_status, payment_status, total_slots, filled_count,
      billed (grand_total semua SO sah), paid (advance_paid), balance,
      currency + currency_symbol (SO pertama booking — guardrail reka
      bentuk: semua SO satu booking mesti currency sama).

    Grouping visual (Upcoming/Future/Past) dibuat di CLIENT ikut tarikh —
    server cuma bekalkan data; peraturan grouping ialah urusan paparan.
    """
    frappe.flags.ignore_permissions = True
    customer_name = _get_customer()

    from travel_booking.api.booking import _compute_payment_status

    bookings = frappe.db.sql("""
        SELECT b.name, b.booking_number, b.status,
               tm.trip_name, td.trip_group_name,
               td.departure_date, td.return_date
        FROM `tabBooking` b
        LEFT JOIN `tabTrip Group Date` td ON td.name = b.trip_date
        LEFT JOIN `tabTrip` tm ON tm.name = td.trip
        WHERE b.customer = %s
        ORDER BY td.departure_date ASC, b.creation ASC
    """, customer_name, as_dict=True)

    out = []
    for bk in bookings:
        # Kiraan slot (total/filled) — aggregate terus, ringan.
        counts = frappe.db.sql("""
            SELECT COUNT(name) AS total,
                   SUM(CASE WHEN traveller IS NOT NULL AND traveller != ''
                            THEN 1 ELSE 0 END) AS filled
            FROM `tabBooking Reservation`
            WHERE booking = %s
        """, bk.name, as_dict=True)
        total_slots  = int(counts[0].total or 0)
        filled_count = int(counts[0].filled or 0)

        # Jumlah kewangan merentasi SEMUA SO booking (kecuali Cancelled) —
        # selari dengan get_booking_data()/_recompute_booking_status().
        totals = frappe.db.sql("""
            SELECT COALESCE(SUM(grand_total), 0)  AS billed,
                   COALESCE(SUM(advance_paid), 0) AS paid
            FROM `tabSales Order`
            WHERE custom_booking = %s AND docstatus != 2
        """, bk.name, as_dict=True)
        billed = float(totals[0].billed or 0)
        paid   = float(totals[0].paid or 0)

        # Currency: SO PERTAMA (creation asc) — wakil sah untuk booking ni.
        currency = frappe.db.get_value(
            "Sales Order", {"custom_booking": bk.name},
            "currency", order_by="creation asc"
        ) or "MYR"
        currency_symbol = frappe.db.get_value("Currency", currency, "symbol") or currency

        out.append({
            "booking_number":  bk.booking_number or bk.name,
            "trip_name":       bk.trip_name       or "-",
            "group_name":      bk.trip_group_name or "",
            "departure_date":  str(bk.departure_date) if bk.departure_date else "",
            "return_date":     str(bk.return_date)    if bk.return_date    else "",
            "booking_status":  bk.status or "",
            "payment_status":  _compute_payment_status(paid, billed),
            "total_slots":     total_slots,
            "filled_count":    filled_count,
            "billed":          billed,
            "paid":            paid,
            "balance":         max(0.0, billed - paid),
            "currency":        currency,
            "currency_symbol": currency_symbol,
        })

    return {"bookings": out}