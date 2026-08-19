# travel_booking/www/booking.py
import frappe
import frappe.sessions
import json

from travel_booking.api._helpers import get_company_currency


def get_context(context):
    # NOTA: nama parameter URL (?trip_master=&trip_group_date=) dikekalkan
    # buat masa ini supaya pautan/bookmark sedia ada tak pecah — walaupun
    # field sebenar doctype dipanggil 'trip' (bukan 'trip_master').
    trip_master     = frappe.form_dict.get("trip_master")
    trip_group_date = frappe.form_dict.get("trip_group_date")

    # "Ready" = Trip Active DAN ada sekurang-kurangnya SATU Trip Group Date
    # yang juga Active, tarikh akan datang (belum lepas), DAN ada Trip
    # Package Active untuk group date tu. Trip yang belum lengkap disetup
    # (tiada group date, atau ada group date tapi tiada package lagi)
    # SENGAJA tak dipapar — customer tak patut nampak trip yang "belum
    # ready", elak dead-end di step seterusnya.
    #
    # EXISTS (bukan JOIN) sebab kita cuma perlu tahu "ada ke tidak" — lebih
    # efisien (berhenti scan sebaik jumpa satu match) dan elak duplicate
    # row yang perlukan DISTINCT tambahan.
    trips = frappe.db.sql("""
        SELECT DISTINCT t.name, t.trip_name, t.is_a_cruise_trip
        FROM `tabTrip` t
        WHERE t.status = 'Active'
          AND EXISTS (
              SELECT 1
              FROM `tabTrip Group Date` td
              WHERE td.trip = t.name
                AND td.status = 'Active'
                AND td.departure_date >= CURDATE()
                AND EXISTS (
                    SELECT 1
                    FROM `tabTrip Package Group Date Select` sel
                    JOIN `tabTrip Package` tp ON tp.name = sel.parent
                    WHERE sel.trip_group_date = td.name
                      AND tp.status = 'Active'
                )
          )
        ORDER BY t.trip_name
    """, as_dict=True)

    # Flag cruise per-trip — wizard papar & susun tarikh ikut SAILING date
    # (sailing_start) untuk trip cruise, bukan departure_date. Untuk Fly
    # Cruise, departure_date ialah tarikh penerbangan keluar (lebih awal dari
    # sailing) — customer lebih peduli bila kapal berlayar, bukan bila terbang.
    trip_is_cruise = {t.name: bool(t.is_a_cruise_trip) for t in trips}

    trip_group_dates = {}
    trip_packages    = {}
    if trips:
        trip_names = [t.name for t in trips]

        # SAMA syarat "ready" (package Active wujud) DAN tarikh akan datang
        # diterapkan di sini juga (cascade) — elak keadaan Trip lepas
        # filter atas (sebab ADA satu date yang ready), tapi grid "Select
        # Departure Date" tetap papar date LAIN untuk trip yang sama yang
        # sebenarnya belum ready/dah lepas tarikh (dead-end di "Select
        # Package" nanti, grid kosong).
        dates = frappe.db.sql("""
            SELECT td.name, td.trip, td.trip_group_name, td.trip_group_code,
                   td.departure_date, td.return_date, td.total_days, td.total_nights,
                   td.sailing_start, td.sailing_end, td.cruise_schedule,
                   td.max_participants, td.current_participants
            FROM `tabTrip Group Date` td
            WHERE td.trip IN %(trips)s
              AND td.status = 'Active'
              AND td.departure_date >= CURDATE()
              AND EXISTS (
                  SELECT 1
                  FROM `tabTrip Package Group Date Select` sel
                  JOIN `tabTrip Package` tp ON tp.name = sel.parent
                  WHERE sel.trip_group_date = td.name
                    AND tp.status = 'Active'
              )
            ORDER BY td.departure_date ASC
        """, {"trips": trip_names}, as_dict=True)

        # seats_left berasaskan SUM(booked_pax) merentasi SEMUA booking
        # tak-cancelled untuk setiap tarikh — SEPADAN dengan gate overbooking
        # di confirm_booking (yang juga guna booked_pax, bukan
        # current_participants). current_participants (Booking Reservation
        # Confirmed) lewat lag (hanya kira bayaran dah masuk), jadi kalau
        # guna ia untuk seats_left, customer nampak "available" padahal gate
        # akan block sebab booking Pending dah tempah tempat.
        booked_pax_by_date = {}
        if dates:
            pax_rows = frappe.db.sql("""
                SELECT b.trip_date, COALESCE(SUM(b.booked_pax), 0) AS pax
                FROM `tabBooking` b
                WHERE b.trip_date IN %(dates)s AND b.status != 'Cancelled'
                GROUP BY b.trip_date
            """, {"dates": [d.name for d in dates]}, as_dict=True)
            booked_pax_by_date = {r.trip_date: int(r.pax or 0) for r in pax_rows}

        for d in dates:
            if d.trip not in trip_group_dates:
                trip_group_dates[d.trip] = []
            max_pax = int(d.max_participants or 0)
            booked = int(booked_pax_by_date.get(d.name, 0))
            # max_participants == 0 -> UNLIMITED (seats_left null -> frontend
            # papar "Available"). >0 -> seats_left = max - booked (boleh 0 =
            # sold out). Negatif di-clip ke 0 (lebihan tempat dah ditempah).
            seats_left = None if max_pax == 0 else max(0, max_pax - booked)
            trip_group_dates[d.trip].append({
                "name":            d.name,
                "trip_group_name": d.trip_group_name or "",
                "trip_group_code": d.trip_group_code or "",
                "departure_date":  str(d.departure_date) if d.departure_date else "",
                "return_date":     str(d.return_date)    if d.return_date    else "",
                "sailing_start":   str(d.sailing_start)  if d.sailing_start  else "",
                "sailing_end":     str(d.sailing_end)    if d.sailing_end    else "",
                "cruise_schedule": d.cruise_schedule or "",
                "total_days":      d.total_days   or 0,
                "total_nights":    d.total_nights or 0,
                "max_participants": max_pax,
                "seats_left":      seats_left,
            })

        # Susun semula senarai tarikh per-trip: cruise ikut SAILING date
        # (sailing_start), lain-lain ikut departure_date. Susunan SQL
        # (departure_date ASC) cuma default — dirombak per-trip di sini supaya
        # grid cruise papar sailing terawal dulu, sepadan dengan paparan tarikh
        # sailing di frontend. Fallback departure_date kalau sailing kosong
        # (cruise tanpa cruise_schedule terlink).
        for _trip_name, _groups in trip_group_dates.items():
            if trip_is_cruise.get(_trip_name):
                _groups.sort(key=lambda g: g["sailing_start"] or g["departure_date"])
            else:
                _groups.sort(key=lambda g: g["departure_date"])

        # Trip Packages untuk setiap Trip Group Date (produk yang dijual).
        # Relationship Package -> Group Date adalah one-to-many melalui child
        # table 'Trip Package Group Date Select' (bukan field terus pada
        # Trip Package) — jadi kita JOIN child table tu untuk cari packages.
        if dates:
            date_names = [d.name for d in dates]
            pkgs = frappe.db.sql("""
                SELECT tp.name, sel.trip_group_date, tp.package_title, tp.package_type,
                       tp.airport_form, ap.airport_name, tp.currency, cur.symbol AS currency_symbol
                FROM `tabTrip Package` tp
                JOIN `tabTrip Package Group Date Select` sel ON sel.parent = tp.name
                LEFT JOIN `tabFlight Airport` ap ON ap.name = tp.airport_form
                LEFT JOIN `tabCurrency` cur ON cur.name = tp.currency
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
                    # td (Trip Group Date) yang pakej ini terlink — DIPERLUKAN
                    # bila sailing cruise digabungkan (fly + cruise-only): td
                    # sebenar untuk booking di TERBITKAN dari pakej yang dipilih
                    # di frontend (rujak booking.js step0Next).
                    "trip_group_date": p.trip_group_date,
                    "package_name": p.package_title or "",
                    "package_type": p.package_type or "",
                    "flight":       p.airport_form or "",
                    "flight_label": flight_label,
                    # PENTING (multi-currency): currency package ni — customer
                    # BOLEH pilih trip yang currency BERBEZA (cth "3N Yanbu
                    # Cruise" MYR vs "Switzerland : SIN" SGD, rujuk dokumen
                    # reka bentuk multi-currency). Frontend guna field ni
                    # untuk papar harga + bank details Manual Transfer ikut
                    # currency package yang DIPILIH, bukan MYR hardcode.
                    "currency":     p.currency or "MYR",
                    # currency_symbol dari doctype Currency ERPNext SENDIRI
                    # (field 'symbol' native, cth "RM"/"S$"/"B$") — SENGAJA
                    # bukan hardcode senarai {MYR:"RM", SGD:"S$", ...} dalam
                    # kod kita, supaya currency BAHARU (mana-mana pun) terus
                    # berfungsi sebaik admin cipta rekod Currency di ERPNext
                    # — tiada keperluan tambah code setiap kali currency baharu.
                    "currency_symbol": p.currency_symbol or (p.currency or "MYR"),
                })

    context.trips            = trips
    context.trip_group_dates = json.dumps(trip_group_dates)
    context.trip_packages    = json.dumps(trip_packages)
    context.trip_cruise_flags = json.dumps(trip_is_cruise)
    context.trip_master      = trip_master or ""
    context.trip_group_date  = trip_group_date or ""
    context.no_cache         = 1
    context.title            = "Book Your Cruise — Rarecation"

    # Company currency — SEMUA harga pakej disimpan & dicaj dalam company
    # currency; currency lain cuma paparan (converter frontend). Wizard
    # perlukan symbol + code company currency untuk fmt() default + paparan
    # dwi-currency bila customer pilih display currency berbeza.
    company_currency = get_company_currency()
    context.company_currency = company_currency
    context.company_symbol = (
        frappe.db.get_value("Currency", company_currency, "symbol") or company_currency
    )

    context.csrf_token = (
        frappe.sessions.get_csrf_token() if frappe.session.user != "Guest" else ""
    )