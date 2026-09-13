# travel_booking/api/portal_booking.py
# Booking Data — Portal

import frappe
from travel_booking.api._helpers import (
    get_customer_by_email,
    get_user_b2b_partner,
    has_on_behalf_role,
    on_behalf_level_ok,
)


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


# ════════════════════════════════════════════════════════════
# ON-BEHALF ACCESS (modul booking-channel, fasa 1b)
# ════════════════════════════════════════════════════════════
# User dengan role yang dikonfigurasi dalam Travel Settings >
# On-Behalf Booking Roles boleh MENGURUS booking yang mereka buat BAGI
# PIHAK customer lain: Booking.booked_by = user DAN Booking.booking_channel
# != "Direct" (channel Direct = user tempah untuk diri sendiri walaupun
# logged in — bukan urusan 3rd party).

def _managed_booking_names(user):
    """Set nama Booking yang user ini urus bagi pihak orang lain:
      - Staff/Affiliate (role-based): booking yang DIA tempah sendiri
        (booked_by = user, booking_channel bukan Direct).
      - B2B (Travel B2B Partner User): SEMUA booking saluran B2B milik
        partner yang diwakilinya — staf partner bertukar-tukar mengurus
        tempahan rakan se-partner, bukan terkurung pada yang ditempah
        sendiri. Isolasi antara partner dijamin oleh kewibadaan
        per-partner (bukan role global).
    Kosong untuk user tanpa kewibadaan on-behalf.
    """
    if not user or user == "Guest" or not has_on_behalf_role(user):
        return set()
    names = set(frappe.get_all(
        "Booking",
        filters={"booked_by": user, "booking_channel": ["!=", "Direct"]},
        pluck="name",
    ))
    b2b = get_user_b2b_partner(user)
    if b2b:
        names.update(frappe.get_all(
            "Booking",
            filters={"booking_channel": "B2B", "b2b_partner": b2b["partner"]},
            pluck="name",
        ))
    return names


def _portal_access(require_customer=True):
    """Resolve konteks akses portal untuk session semasa sekali sahaja:

        (user, customer_name, managed_bookings)

    - customer_name: rekod Customer milik user (boleh None — rujuk nota
      _get_customer; kini DIBENARKAN bila user ada booking on-behalf).
    - managed_bookings: set nama Booking yang user urus bagi pihak
      customer lain (rujuk _managed_booking_names).

    require_customer=True kekal menolak user tanpa Customer DAN tanpa
      sebarang booking on-behalf (mesej sama seperti _get_customer supaya
      keputusan UX portal tidak berubah untuk akaun separuh jadi).
    """
    user = frappe.session.user
    if not user or user == "Guest":
        frappe.throw("Please log in to continue.", frappe.AuthenticationError)

    customer_name = get_customer_by_email(user)
    managed = _managed_booking_names(user)

    if require_customer and not customer_name and not managed:
        frappe.throw(
            "No customer record found for this account. "
            "Access to bookings/transactions requires a customer record.",
            frappe.PermissionError
        )

    return user, customer_name, managed


def _booking_accessible(booking, customer_name, managed_bookings):
    """True jika booking boleh diakses session semasa: milik customer
    user, END CUSTOMER tempahan B2B yang diwakilinya, ATAU dalam set
    booking on-behalf yang diurusnya. `booking` perlu bawa sekurang-
    kurangnya field .name dan .customer (field .end_customer/.booking_
    channel dibaca berhati-hati via .get() — tidak semua caller fetch).
    """
    if customer_name and booking.customer == customer_name:
        return True
    if customer_name and booking.get("end_customer") == customer_name:
        # End customer tempahan B2B — akses status/dokumen sahaja
        # (penapisan harga ditangani _price_hidden_for di paparan data).
        return True
    return booking.name in (managed_bookings or set())


def _price_hidden_for(booking, customer_name):
    """True bila viewer ialah END CUSTOMER tempahan B2B — SEMUA angka
    harga/billing mesti ditapis keluar dari respons portal. Staf partner
    (dalam managed set) kekal melihat harga net; pemilik tempahan
    Direct/Staff/Affiliate tidak terjejas (end_customer kosong).
    """
    if not customer_name:
        return False
    if booking.get("booking_channel") != "B2B":
        return False
    end = booking.get("end_customer")
    if not end or end != customer_name:
        return False
    # Partner sendiri tiada akaun end-customer berasingan — jika
    # Booking.customer == viewer, dia dibilkan, bukan pelanggan yang
    # perlu dilindungi.
    return booking.get("customer") != customer_name


def _so_accessible_by(so_name, customer_name, managed_bookings):
    """Versi _booking_accessible untuk Sales Order — SO boleh diakses bila
    milik customer user, ATAU SO itu milik booking on-behalf yang diurus
    (Sales Order.custom_booking). Pulangkan False kalau SO tiada.
    """
    so = frappe.db.get_value(
        "Sales Order", so_name, ["customer", "custom_booking"], as_dict=True
    )
    if not so:
        return False
    if customer_name and so.customer == customer_name:
        return True
    return bool(so.custom_booking and so.custom_booking in (managed_bookings or set()))


def _booking_action_allowed(booking, customer_name, managed_bookings, required_level):
    """Gate TINDAKAN (bukan sekadar lihat) ke atas booking — dipakai oleh
    endpoint yang mengubah data / melakukan bayaran:

      - Pemilik booking (customer session sendiri): SEMUA tindakan dibenarkan.
      - Manager on-behalf: booking mesti dalam set yang diurusnya DAN
        tahap akses role-nya (Travel Settings > On-Behalf Booking Roles >
        Access Level) mesti >= tahap yang diminta:
          "Docs" — urus maklumat & dokumen traveller
          "Full" — bayaran + muat turun resit/invois
      - End customer tempahan B2B: layak TINDAKAN tahap Docs ke bawah
        sahaja (isi maklumat/dokumen traveller sendiri). Tindakan
        pembayaran ("Full") SENTIASA dinafikan — bil adalah urusan
        partner, bukannya pelanggan.

    Pulangkan False jika tidak dibenarkan (caller throw PermissionError).
    """
    if customer_name and booking.customer == customer_name:
        return True
    if customer_name and booking.get("end_customer") == customer_name:
        return on_behalf_level_ok(required_level) and required_level != "Full"
    if booking.name not in (managed_bookings or set()):
        return False
    return on_behalf_level_ok(required_level)


def _so_action_allowed(so_name, customer_name, managed_bookings, required_level):
    """Versi _booking_action_allowed untuk Sales Order (bayaran/resit/
    invois mengikut SO, bukan booking terus)."""
    so = frappe.db.get_value(
        "Sales Order", so_name, ["customer", "custom_booking"], as_dict=True
    )
    if not so:
        return False
    if customer_name and so.customer == customer_name:
        return True
    if not (so.custom_booking and so.custom_booking in (managed_bookings or set())):
        return False
    return on_behalf_level_ok(required_level)


@frappe.whitelist()
def get_booking_data(booking_number: str):
    frappe.flags.ignore_permissions = True
    # ON-BEHALF: manager (booked_by) turut dibenarkan buka booking yang
    # diurusnya — rujuk _booking_accessible(). customer_name boleh None
    # untuk manager tanpa rekod Customer sendiri.
    _user, customer_name, managed = _portal_access()

    booking = frappe.db.sql("""
        SELECT
            b.name, b.booking_number, b.customer, b.cust_email, b.trip_date,
            b.trip_package, b.status, b.flight,
            b.booking_channel, b.b2b_partner, b.end_customer,
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

    if not _booking_accessible(booking, customer_name, managed):
        frappe.throw("Access denied.", frappe.PermissionError)

    # Flag untuk frontend: akses ini melalui hak on-behalf (bukan pemilik
    # booking). Dipakai UI untuk maklumat/kawalan paparan (cth label
    # "managed on behalf") — khususnya page /traveller/onbehalf-booking.
    on_behalf_view = not (customer_name and booking.customer == customer_name)

    # B2B: viewer ialah end-customer tempahan partner — SEMUA angka
    # harga/billing ditapis keluar dari respons (status/dokumen sahaja).
    price_hidden = _price_hidden_for(booking, customer_name)

    # Maklumat customer akhir + tahap akses — HANYA untuk akses on-behalf
    # (page booking.html pemilik tidak memaparkan maklumat diri sendiri).
    # Tahap akses menentukan tindakan yang dibenarkan UI (View/Docs/Full).
    end_customer = None
    on_behalf_access_level = None
    if on_behalf_view:
        if (booking.get("booking_channel") == "B2B"
                and booking.get("end_customer")):
            # B2B — end customer sebenar ialah Booking.end_customer;
            # Booking.customer kini ialah entiti BIL partner.
            end_customer = frappe.db.get_value(
                "Customer", booking.end_customer, "customer_name"
            )
        else:
            end_customer = frappe.db.get_value(
                "Customer", booking.customer, "customer_name"
            )
        from travel_booking.api._helpers import get_on_behalf_access_level
        on_behalf_access_level = get_on_behalf_access_level() or "View"

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
            res.room_id,
            res.guest_sequence,
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
            t.fullname_format,
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
            "room_id":           raw.room_id           or "",
            "guest_sequence":    raw.guest_sequence    or "",
            "flight":            raw.flight            or "",
            "flight_pnr":        raw.flight_pnr        or "",
            "flight_departure":  raw.flight_home_airport        or "",
            "flight_arrival":    raw.flight_destination_airport or "",
            "document_status":   raw.document_status   or "Pending",
            "filled":            is_filled,
            "is_verified":       is_verified,
            "traveller_id":      raw.traveller         or "",
            "full_name":         raw.full_name         or "",
            "fullname_format":   raw.fullname_format   or "First Name + Last Name",
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

    # Bina senarai SEMUA SO (untuk paparan "Bill Orders" di portal).
    # MULTI-CURRENCY: setiap SO bawa currency + symbol masing-masing supaya
    # frontend papar simbol yang BETUL (bukan simbol company sahaja).
    from travel_booking.api.currency_axis import get_default_currency
    so_list = []
    grand_total  = 0.0
    advance_paid = 0.0
    symbol_cache = {}
    for so_name in _get_all_booking_sales_orders(booking_name):
        so_vals = frappe.db.get_value("Sales Order", so_name,
                                      ["grand_total", "advance_paid", "status", "currency"], as_dict=True)
        if so_vals:
            gt = float(so_vals.grand_total or 0)
            ap = float(so_vals.advance_paid or 0)
            grand_total  += gt
            advance_paid += ap
            so_currency = so_vals.currency or get_default_currency()
            if so_currency not in symbol_cache:
                symbol_cache[so_currency] = frappe.db.get_value(
                    "Currency", so_currency, "symbol"
                ) or so_currency
            so_list.append({
                "name":         so_name,
                "grand_total":  gt,
                "advance_paid": ap,
                "balance":      gt - ap,
                "status":       so_vals.status or "Draft",
                "currency":        so_currency,
                "currency_symbol": symbol_cache[so_currency],
            })

    # Currency ringkasan agregat = currency SO UTAMA (guardrail reka bentuk:
    # semua SO satu booking patut sama currency; kalau SO addon berlainan
    # currency, pecahan tepat ada di so_list & addon_orders — setiap satu
    # bawa currency sendiri).
    summary_currency = (frappe.db.get_value("Sales Order", primary_so, "currency")
                        if primary_so else None) \
        or (so_list[0]["currency"] if so_list else None) \
        or get_default_currency()
    if summary_currency not in symbol_cache:
        symbol_cache[summary_currency] = frappe.db.get_value(
            "Currency", summary_currency, "symbol"
        ) or summary_currency

    so_data = {
        "grand_total":  grand_total,
        "advance_paid": advance_paid,
        "status":       frappe.db.get_value("Sales Order", primary_so, "status") if primary_so else None,
        "currency":        summary_currency,
        "currency_symbol": symbol_cache[summary_currency],
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
        elif pkg_type == "Cruise + Flight":
            trip_category = "Cruise + Flight"
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

    # ── Flight itinerary (booking-level) ──
    # Booking.flight ialah Link ke tabFlight (slot mewarisi via fetch_from).
    # Surface di booking level supaya Trip Hero boleh papar block Flight Itinerary.
    flight_info = {}
    flight_link = booking.flight or ""
    if not flight_link:
        # Fallback: jika booking-level flight kosong, ambil flight DISTINCT dari
        # slots (slot biasanya mewarisi booking.flight, jadi biasanya satu/kosong).
        distinct = [
            r[0] for r in frappe.db.sql(
                "SELECT DISTINCT flight FROM `tabBooking Reservation` "
                "WHERE booking=%s AND IFNULL(flight,'')!=''",
                booking.name,
            )
        ]
        if len(distinct) == 1:
            flight_link = distinct[0]

    if flight_link:
        fd = frappe.db.get_value(
            "Flight", flight_link,
            ["pnr", "airline", "home_airport", "destination_airport",
             "departure_date", "arrival_date", "flight_class", "flight_itinerary"],
            as_dict=True,
        )
        if fd:
            airline_name = ""
            if fd.airline:
                airline_name = frappe.db.get_value("Flight Airline", fd.airline, "airline_name") or ""
            home = {}
            if fd.home_airport:
                home = frappe.db.get_value(
                    "Flight Airport", fd.home_airport,
                    ["airport_code", "airport_name", "airport_city"], as_dict=True,
                ) or {}
            dest = {}
            if fd.destination_airport:
                dest = frappe.db.get_value(
                    "Flight Airport", fd.destination_airport,
                    ["airport_code", "airport_name", "airport_city"], as_dict=True,
                ) or {}
            flight_info = {
                "pnr":               fd.pnr or flight_link,
                "airline":           airline_name,
                "home_airport_code": home.get("airport_code", ""),
                "home_airport_name": home.get("airport_name", ""),
                "dest_airport_code": dest.get("airport_code", ""),
                "dest_airport_name": dest.get("airport_name", ""),
                "departure_date":    str(fd.departure_date) if fd.departure_date else "",
                "arrival_date":      str(fd.arrival_date) if fd.arrival_date else "",
                "flight_class":      fd.flight_class or "",
                "itinerary_html":    fd.flight_itinerary or "",
            }

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
            # B2B end-customer: payment_status disembunyikan (bukan maklumat
            # perjalanan — ia billing partner).
            "payment_status":     None if price_hidden else payment_status,
            "can_edit_traveller_details": can_edit_traveller_details,
            # ON-BEHALF: true bila dibuka oleh manager (bukan pemilik) —
            # sertakan maklumat customer akhir + tahap akses untuk page
            # onbehalf-booking (UI kawal butang ikut tahap).
            "on_behalf_view":     on_behalf_view,
            # B2B: penapis harga aktif untuk end-customer (frontend sembunyi
            # kad harga/baki & papar notis "bil diuruskan agen").
            "price_hidden":       price_hidden,
            "booking_channel":    booking.get("booking_channel") or "Direct",
            "is_b2b":             booking.get("booking_channel") == "B2B",
            "end_customer_name":  end_customer or "",
            "end_customer_email": booking.cust_email if on_behalf_view else "",
            "on_behalf_access_level": on_behalf_access_level or "",
            # Flight itinerary (booking-level, from tabFlight via booking.flight)
            "flight_itinerary":           flight_info,
        },
        "slots":   slots,
        "cabins":  cabins,
        # B2B end-customer: payload kewangan DITAPIS sepenuhnya — bukan
        # sekadar disembunyi di UI (angka tak boleh bocor melalui API).
        "payment": ({"so": {}, "so_list": []} if price_hidden
                    else {"so": so_data, "so_list": so_list}),
        "addon_orders": _get_addon_orders_for_booking(
            booking.name, hide_prices=price_hidden
        ),
    }


def _get_addon_orders_for_booking(booking_name: str, hide_prices: bool = False) -> list:
    """Ambil senarai Booking Addon untuk satu booking (untuk paparan panel
    Add-ons & Extras dalam booking detail). Return list of dicts dengan ringkasan
    setiap order — bukan detail penuh baris (itu tugas get_booking_addons()).

    hide_prices=True (end-customer tempahan B2B): jumlah & payment status
    dibuang — order status (Confirmed/Pending) kekal sebagai maklumat
    perjalanan.
    """
    orders = frappe.get_all(
        "Booking Addon",
        filters={"booking": booking_name, "status": ("!=", "Cancelled")},
        fields=["name", "status", "payment_status", "total_amount", "currency", "order_date"],
        order_by="order_date desc",
    )
    # Simbol currency (MYR->RM, SGD->S$) supaya frontend tak perlu tafsir
    # kod currency sendiri.
    _attach_currency_symbols(orders)
    if hide_prices:
        for o in orders:
            o["total_amount"] = None
            o["payment_status"] = None
    return orders


def _attach_currency_symbols(rows: list) -> None:
    """Isi `currency_symbol` pada setiap row (dict dengan field `currency`)
    daripada master Currency — in-place, fallback kepada kod currency."""
    currencies = {r.get("currency") for r in rows if r.get("currency")}
    if not currencies:
        return
    sym_map = {}
    for name, sym in frappe.db.sql(
        "SELECT name, symbol FROM `tabCurrency` WHERE name IN %s",
        (tuple(currencies),), as_list=True,
    ):
        sym_map[name] = sym or name
    for r in rows:
        cur = r.get("currency") or ""
        r["currency_symbol"] = sym_map.get(cur, cur)


def _flight_map_for(flight_links: list) -> dict:
    """Resolve maklumat ringkas Flight untuk senarai booking — SATU query
    per master (Flight / Flight Airline / Flight Airport) untuk semua link
    unik. Return {flight_docname: {...}}; kosong jika tiada link.

    Paparan kad My Bookings perlukan: airline, PNR, laluan airport
    (kod + bandar), tarikh berlepas & tarikh tiba-pulang, kelas."""
    links = [f for f in flight_links if f]
    if not links:
        return {}

    flights = frappe.get_all(
        "Flight", filters={"name": ["in", links]},
        fields=["name", "pnr", "airline", "home_airport", "destination_airport",
                "departure_date", "arrival_date", "flight_class"],
    )

    airline_links = {f.airline for f in flights if f.airline}
    airline_names = dict(frappe.get_all(
        "Flight Airline", filters={"name": ["in", list(airline_links)]},
        fields=["name", "airline_name"], as_list=True,
    )) if airline_links else {}

    airport_links = set()
    for f in flights:
        airport_links.update(a for a in (f.home_airport, f.destination_airport) if a)
    airports = {a.name: a for a in frappe.get_all(
        "Flight Airport", filters={"name": ["in", list(airport_links)]},
        fields=["name", "airport_code", "airport_city"],
    )} if airport_links else {}

    out = {}
    for f in flights:
        home = airports.get(f.home_airport) if f.home_airport else None
        dest = airports.get(f.destination_airport) if f.destination_airport else None
        out[f.name] = {
            "pnr":             f.pnr or f.name,
            "airline":         airline_names.get(f.airline, f.airline or ""),
            "from_code":       (home.airport_code if home else "") or "",
            "from_city":       (home.airport_city if home else "") or "",
            "to_code":         (dest.airport_code if dest else "") or "",
            "to_city":         (dest.airport_city if dest else "") or "",
            "dep_date":        str(f.departure_date) if f.departure_date else "",
            "ret_arrival_date": str(f.arrival_date) if f.arrival_date else "",
            "flight_class":    f.flight_class or "",
        }
    return out


@frappe.whitelist()
def get_bookings_list():
    """Senarai SEMUA booking customer untuk page My Bookings (multi-page
    portal) — data mini-info setiap kad booking dalam satu panggilan.

    Pulangkan list (disusun ikut departure_date ASC):
      booking_number, trip_name, package_title/code, group_name,
      trip_category (Cruise/Fly Package/Tour...), departure_date,
      return_date, total_days/nights, cruise info (is_cruise, ship_name,
      ports, sailing_start/end), flight info (pnr, airline, airports,
      dep/return-arrival dates), booking_status, payment_status,
      total_slots, filled_count, billed/paid/balance + currency.

    Grouping visual (Upcoming/Future/Past) dibuat di CLIENT ikut tarikh —
    server cuma bekalkan data; peraturan grouping ialah urusan paparan.

    ON-BEHALF: manager tanpa rekod Customer sendiri (cth affiliate yang
    tak pernah tempah untuk diri) dapat senarai KOSONG di sini — booking
    yang mereka urus bagi pihak customer lain dihidangkan di endpoint
    berasingan get_on_behalf_bookings_list().
    """
    frappe.flags.ignore_permissions = True
    _user, customer_name, _managed = _portal_access()
    if not customer_name:
        return {"bookings": []}

    from travel_booking.api.booking import _compute_payment_status

    # Tempahan user sendiri ATAU tempahan B2B yang DIA end-customernya
    # (ditempah oleh partner bagi pihaknya — paparan tanpa harga).
    bookings = frappe.db.sql("""
        SELECT b.name, b.booking_number, b.status,
               b.booking_channel, b.end_customer, b.customer,
               b.flight,
               tm.trip_name, td.trip_group_name,
               td.departure_date, td.return_date,
               td.embarkation_port, td.disembarkation_port,
               td.sailing_start, td.sailing_end,
               td.ship_name, td.total_days, td.total_nights,
               td.is_a_cruise_trip, td.is_cruise_only AS tgd_cruise_only,
               tp.package_title, tp.package_code, tp.package_type,
               tp.is_cruise_only AS pkg_cruise_only
        FROM `tabBooking` b
        LEFT JOIN `tabTrip Group Date` td ON td.name = b.trip_date
        LEFT JOIN `tabTrip` tm ON tm.name = td.trip
        LEFT JOIN `tabTrip Package` tp ON tp.name = b.trip_package
        WHERE b.customer = %s OR b.end_customer = %s
        ORDER BY td.departure_date ASC, b.creation ASC
    """, (customer_name, customer_name), as_dict=True)

    # Flight per booking — resolve SEKALI secara pukal (distinct link) supaya
    # senarai panjang tidak bertambah query N+1. Booking.flight ialah Link ke
    # tabFlight; maklumat penerbangan diambil terus dari doc Flight (bukan
    # medan fetch_from Booking yang sebahagiannya tidak konsisten).
    flight_map = _flight_map_for(list({bk.flight for bk in bookings if bk.get("flight")}))

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
        # Fallback ikut currency axis (bukan hardcoded MYR).
        from travel_booking.api.currency_axis import get_default_currency
        currency = frappe.db.get_value(
            "Sales Order", {"custom_booking": bk.name},
            "currency", order_by="creation asc"
        ) or get_default_currency()
        currency_symbol = frappe.db.get_value("Currency", currency, "symbol") or currency

        # B2B: end-customer melihat tempahan partner — angka kewangan
        # DITAPIS (None) di peringkat API, bukan sekadar disembunyi UI.
        price_hidden = _price_hidden_for(bk, customer_name)

        # Klasifikasi trip — logik sama dengan get_booking_data() supaya
        # label kad konsisten dengan page detail (Cruise / Cruise + Flight /
        # Fly Package / Tour ...).
        is_cruise    = bool(bk.is_a_cruise_trip)
        cruise_only  = bool(bk.pkg_cruise_only or bk.tgd_cruise_only)
        pkg_type     = bk.package_type or ""
        if is_cruise:
            if cruise_only:
                trip_category = "Cruise Only"
            elif pkg_type == "Cruise + Flight":
                trip_category = "Cruise + Flight"
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

        out.append({
            "booking_number":  bk.booking_number or bk.name,
            "trip_name":       bk.trip_name       or "-",
            # Package (varian yang ditempah) & kodnya
            "package_title":   bk.package_title   or "",
            "package_code":    bk.package_code    or "",
            "group_name":      bk.trip_group_name or "",
            "trip_category":   trip_category,
            "departure_date":  str(bk.departure_date) if bk.departure_date else "",
            "return_date":     str(bk.return_date)    if bk.return_date    else "",
            "total_days":      int(bk.total_days or 0),
            "total_nights":    int(bk.total_nights or 0),
            # Cruise — hanya diisi untuk trip cruise
            "is_cruise":       is_cruise,
            "cruise_only":     cruise_only,
            "ship_name":       bk.ship_name or "",
            "embarkation_port":   bk.embarkation_port    or "",
            "disembarkation_port": bk.disembarkation_port or "",
            "sailing_start":   str(bk.sailing_start) if bk.sailing_start else "",
            "sailing_end":     str(bk.sailing_end)   if bk.sailing_end   else "",
            # Flight (dari Flight doc via Booking.flight — {} jika tiada)
            "flight":          flight_map.get(bk.flight, {}) if bk.get("flight") else {},
            "booking_status":  bk.status or "",
            "payment_status":  None if price_hidden else _compute_payment_status(paid, billed),
            "total_slots":     total_slots,
            "filled_count":    filled_count,
            "price_hidden":    price_hidden,
            "booking_channel": bk.get("booking_channel") or "Direct",
            "billed":          None if price_hidden else billed,
            "paid":            None if price_hidden else paid,
            "balance":         None if price_hidden else max(0.0, billed - paid),
            "currency":        "" if price_hidden else currency,
            "currency_symbol": "" if price_hidden else currency_symbol,
        })

    return {"bookings": out}

@frappe.whitelist()
def get_on_behalf_bookings_list():
    """Senarai booking yang user session urus BAGI PIHAK customer lain —
    khas untuk page "Bookings on Behalf" dalam portal traveller.

    Kriteria: Booking.booked_by = user DAN Booking.booking_channel !=
    "Direct" (booked_by juga diisi untuk tempahan sendiri yang logged-in,
    tapi channel Direct — itu bukan urusan 3rd party). Struktur data sama
    dengan get_bookings_list() supaya kad boleh dikongsi, DITAMBAH maklumat
    customer akhir setiap booking (manager perlu tahu booking milik siapa).

    Akses ditolak senyap (senarai kosong) untuk user tanpa role on-behalf
    — endpoint ini hanya releven untuk manager yang dikonfigurasi dalam
    Travel Settings > On-Behalf Booking Roles.
    """
    frappe.flags.ignore_permissions = True
    user, _customer_name, managed = _portal_access()
    if not managed:
        return {"bookings": []}

    from travel_booking.api.booking import _compute_payment_status
    from travel_booking.api._helpers import get_customer_phone
    from travel_booking.api.currency_axis import get_default_currency

    bookings = frappe.db.sql("""
        SELECT b.name, b.booking_number, b.status, b.booking_channel,
               b.cust_email, b.customer, b.end_customer,
               c.customer_name,
               ec.customer_name AS end_customer_display_name,
               tm.trip_name, td.trip_group_name,
               tp.package_title,
               td.departure_date, td.return_date,
               td.embarkation_port, td.disembarkation_port,
               td.sailing_start, td.sailing_end
        FROM `tabBooking` b
        LEFT JOIN `tabCustomer` c ON c.name = b.customer
        LEFT JOIN `tabCustomer` ec ON ec.name = b.end_customer
        LEFT JOIN `tabTrip Group Date` td ON td.name = b.trip_date
        LEFT JOIN `tabTrip` tm ON tm.name = td.trip
        LEFT JOIN `tabTrip Package` tp ON tp.name = b.trip_package
        WHERE b.name IN %(names)s
        ORDER BY td.departure_date ASC, b.creation ASC
    """, {"names": tuple(managed)}, as_dict=True)

    out = []
    for bk in bookings:
        counts = frappe.db.sql("""
            SELECT COUNT(name) AS total,
                   SUM(CASE WHEN traveller IS NOT NULL AND traveller != ''
                            THEN 1 ELSE 0 END) AS filled
            FROM `tabBooking Reservation`
            WHERE booking = %s
        """, bk.name, as_dict=True)
        total_slots  = int(counts[0].total or 0)
        filled_count = int(counts[0].filled or 0)

        totals = frappe.db.sql("""
            SELECT COALESCE(SUM(grand_total), 0)  AS billed,
                   COALESCE(SUM(advance_paid), 0) AS paid
            FROM `tabSales Order`
            WHERE custom_booking = %s AND docstatus != 2
        """, bk.name, as_dict=True)
        billed = float(totals[0].billed or 0)
        paid   = float(totals[0].paid or 0)

        currency = frappe.db.get_value(
            "Sales Order", {"custom_booking": bk.name},
            "currency", order_by="creation asc"
        ) or get_default_currency()
        currency_symbol = frappe.db.get_value("Currency", currency, "symbol") or currency

        # B2B: customer akhir yang dipapar ialah Booking.end_customer —
        # BUKAN Booking.customer (itu entiti bil partner).
        is_b2b = (bk.booking_channel == "B2B")
        end_cust_link = bk.end_customer if (is_b2b and bk.end_customer) else bk.customer
        out.append({
            "booking_number":  bk.booking_number or bk.name,
            "booking_channel": bk.booking_channel or "",
            "is_b2b":          is_b2b,
            # Customer akhir — paparan utama yang membezakan kad ini dari
            # My Bookings (manager tahu serta-merta booking milik siapa).
            "end_customer_name":  (bk.end_customer_display_name or end_cust_link or "") if is_b2b
                                  else (bk.customer_name or bk.customer or ""),
            "end_customer_email": bk.cust_email or "",
            "end_customer_phone": get_customer_phone(end_cust_link) or "",
            "trip_name":       bk.trip_name       or "-",
            "package_title":   bk.package_title   or "",
            "group_name":      bk.trip_group_name or "",
            "departure_date":  str(bk.departure_date) if bk.departure_date else "",
            "return_date":     str(bk.return_date)    if bk.return_date    else "",
            "embarkation_port":   bk.embarkation_port    or "",
            "disembarkation_port": bk.disembarkation_port or "",
            "sailing_start":   str(bk.sailing_start) if bk.sailing_start else "",
            "sailing_end":     str(bk.sailing_end)   if bk.sailing_end   else "",
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
