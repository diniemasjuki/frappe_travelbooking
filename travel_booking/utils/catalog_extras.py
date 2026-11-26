# travel_booking/utils/catalog_extras.py
#
# Lapisan "extras" katalog storefront — derivasi PAKEJ KHAS + strip
# JADUAL PELAYARAN untuk homepage /cruise dan page detail trip.
#
# PAKEJ KHAS (auto-derive — TIADA field DocType baru):
#   Travel Date dianggap PAKEJ KHAS bila ia mempunyai sekurang-kurangnya
#   SATU Package Offer Active yang mengaktifkan seksi matrix tambahan
#   (matrix_flight/hotel/transport/meal = 1) DAN seksi itu BERISI baris
#   addon_price_matrix. Chips inklusi = seksyen yang aktif & berisi.
#
# Struktur baharu: Trip >> Travel Date >> Package Offer (F5). Bila tiada
# offer sah, semua fungsi pulang kosong dan UI berkenaan disembunyikan
# dengan anggun — laluan legacy (Trip Group Date / Trip Package) tetap
# berfungsi seperti sedia ada.
#
# Gunaan:
#   - www/cruise.py      → get_special_travel_dates(), get_upcoming_sailings()
#   - utils/trip_catalog + utils/new_catalog → attach_special_flags()
#     (get_trip_detail — flag is_special/inclusions untuk trip_detail.js)

import frappe
from frappe.utils import getdate

# Seksi addon matrix → chip inklusi (icon Tabler + label paparan).
_INCLUSION_SECTIONS = {
    "Flight": {"icon": "ti-plane", "label": "Flight"},
    "Hotel": {"icon": "ti-bed", "label": "Hotel"},
    "Transport": {"icon": "ti-bus", "label": "Transport"},
    "Meal": {"icon": "ti-tools-kitchen-2", "label": "Meals"},
}

# Column nama medan flag matrix per seksi (Package Offer).
_MATRIX_FLAG_FIELD = {
    "Flight": "matrix_flight",
    "Hotel": "matrix_hotel",
    "Transport": "matrix_transport",
    "Meal": "matrix_meal",
}


def _special_offers(travel_dates=None, cruise_only=False):
    """Package Offer "khas" yang sah untuk dipaparkan.

    Offer Active pada Travel Date Active (tarikh akan datang) milik Trip
    Active + published, dengan SEKURANG-KURANGNYA satu seksi matrix
    tambahan aktif DAN wujud baris addon_price_matrix.

    travel_dates — hadkan kepada senarai nama Travel Date (page detail
    per-trip); None = merentasi semua trip (homepage).

    cruise_only — filter `Trip.is_a_cruise_trip = 1` (vertikal CRUISE:
    homepage /cruise hanya papar produk cruise). Flag per-tarikh
    (attach_special_flags) kekal TANPA penapis supaya kedua-dua vertikal
    cruise & tour dapat badge/chips masing-masing.

    KEMBALI: [{name, travel_date, legacy_tgd, trip, matrix flags...,
    addon_rows}] — addon_rows dikira sekali supaya caller tidak perlu
    query kedua untuk tahu seksi mana berisi.
    """
    cond_td = ""
    params = {}
    if travel_dates:
        cond_td = "AND td.name IN %(tds)s"
        params["tds"] = list(travel_dates)
    cond_cruise = "AND t.is_a_cruise_trip = 1" if cruise_only else ""
    return frappe.db.sql(
        """
        SELECT o.name, o.travel_date, o.legacy_tgd, o.trip,
               o.currency, o.offer_name, o.flight,
               tp.package_template,
               o.matrix_flight, o.matrix_hotel, o.matrix_transport,
               o.matrix_meal,
               (SELECT COUNT(*)
                FROM `tabTrip Package Price` pm
                WHERE pm.parent = o.name
                  AND pm.parenttype = 'Package Offer'
                  AND pm.parentfield = 'addon_price_matrix') AS addon_rows
        FROM `tabPackage Offer` o
        JOIN `tabTravel Date` td ON td.name = o.travel_date
        JOIN `tabTrip` t ON t.name = td.trip
        LEFT JOIN `tabTravel Package` tp ON tp.name = o.package
        WHERE o.status_editorial = 'Active'
          AND td.status_editorial = 'Active'
          AND td.departure_date >= CURDATE()
          AND t.status = 'Active'
          AND t.published = 1
          {cond_cruise}
          {cond_td}
          AND (
            (o.matrix_flight = 1 OR o.matrix_hotel = 1
             OR o.matrix_transport = 1 OR o.matrix_meal = 1)
          )
          AND EXISTS (
            SELECT 1 FROM `tabTrip Package Price` pm2
            WHERE pm2.parent = o.name
              AND pm2.parenttype = 'Package Offer'
              AND pm2.parentfield = 'addon_price_matrix'
          )
        """.format(cond_td=cond_td, cond_cruise=cond_cruise),
        params,
        as_dict=True,
    )


def _addon_sections_by_offer(offer_names):
    """Seksi addon yang BERISI per offer — dari kategori sebenar baris
    addon_price_matrix (Trip Price Category.price_category). Hanya seksi
    dengan baris harga > 0 dikira inklusi sebenar."""
    if not offer_names:
        return {}
    rows = frappe.db.sql(
        """
        SELECT pm.parent AS offer, tpc.price_category AS section
        FROM `tabTrip Package Price` pm
        JOIN `tabTrip Price Category` tpc ON tpc.name = pm.pricing_for_class
        WHERE pm.parenttype = 'Package Offer'
          AND pm.parentfield = 'addon_price_matrix'
          AND pm.parent IN %(offers)s
          AND pm.price_adult > 0
        GROUP BY pm.parent, tpc.price_category
        """,
        {"offers": list(set(offer_names))},
        as_dict=True,
    )
    out = {}
    for r in rows:
        if r.section in _INCLUSION_SECTIONS:
            out.setdefault(r.offer, []).append(r.section)
    return out


def _offer_min_prices(offer_names):
    """TOTAL harga "dari" per offer untuk kad PAKEJ KHAS —
    MIN(price_adult) Price Matrix base (room category termurah)
    + Σ(price_adult) addon_price_matrix (surcaj Flight/Hotel/Transport/
    Meal). SATU query untuk semua kad; kontrak sama dengan page detail
    & wizard: Total pakej = base + Σ addon."""
    if not offer_names:
        return {}
    rows = frappe.db.sql(
        """
        SELECT parent,
               MIN(CASE WHEN parentfield = 'price_matrix'
                   THEN price_adult END) AS mn,
               COALESCE(SUM(CASE WHEN parentfield = 'addon_price_matrix'
                   THEN price_adult ELSE 0 END), 0) AS addon_sum
        FROM `tabTrip Package Price`
        WHERE parenttype = 'Package Offer'
          AND parent IN %(offers)s
          AND price_adult > 0
        GROUP BY parent
        """,
        {"offers": list(set(offer_names))},
        as_dict=True,
    )
    out = {}
    for r in rows:
        if r.mn:
            out[r.parent] = float(r.mn) + float(r.addon_sum or 0)
    return out


def get_special_travel_dates(limit=None, cruise_only=True):
    """Kad PAKEJ KHAS untuk homepage /cruise — SATU kad per OFFER khas
    (offer membawa komposisi pakej + currency sendiri; dua offer khas
    atas tarikh yang sama = dua kad dengan badge currency masing-masing).

    cruise_only=True (default — vertikal CRUISE): hanya trip dengan
    is_a_cruise_trip=1. Domain cruise tidak memaparkan produk bukan-cruise.

    KEMBALI list[dict]: {trip, trip_name, route, trip_image,
      date_key (untuk ?date= deep-link — legacy_tgd ATAU Travel Date),
      offer_name, departure/return/sailing_start/sailing_end, ship,
      embarkation/disembarkation_port, total_days/nights, inclusions
      [{key,icon,label}], price, currency, currency_symbol, seats_left}
    disusun ikut departure_date. limit=None → semua.
    """
    offers = _special_offers(cruise_only=cruise_only)
    if not offers:
        return []

    sections_map = _addon_sections_by_offer([o.name for o in offers])
    prices = _offer_min_prices([o.name for o in offers])

    # Buang offer yang tiada seksi berisi (flag aktif tapi matrix kosong).
    offers = [o for o in offers if sections_map.get(o.name)]
    if not offers:
        return []

    # Info Travel Date (tarikh/sailing/port) — snapshot offer boleh di sync
    # semula, jadi baca terus dari Travel Date (satu sumber kebenaran).
    td_names = list({o.travel_date for o in offers if o.travel_date})
    td_map = {}
    if td_names:
        td_map = {
            r.name: r for r in frappe.db.get_values(
                "Travel Date", td_names,
                ["name", "departure_date", "return_date", "sailing_start",
                 "sailing_end", "ship_name", "embarkation_port",
                 "disembarkation_port", "cruise_schedule"],
                as_dict=True,
            )
        }

    # Info trip (nama/route/img) — satu query untuk semua kad.
    trip_names = list({o.trip for o in offers if o.trip})
    trip_map = {}
    if trip_names:
        trip_map = {
            r.name: r for r in frappe.db.get_values(
                "Trip", trip_names,
                ["name", "trip_name", "route", "trip_image"],
                as_dict=True,
            )
        }

    symbols = {
        c.name: c.symbol
        for c in frappe.get_all("Currency", fields=["name", "symbol"])
    }

    # Kuota kolam kabin kongsi per cruise_schedule (SUM available) — corak
    # sama dengan new_catalog._cabin_pool; None bila allotment tak diset.
    seats_by_sched = {}
    sched_names = list({
        td.cruise_schedule for td in td_map.values() if td.cruise_schedule
    })
    if sched_names:
        rows = frappe.db.sql(
            """
            SELECT parent,
                   SUM(GREATEST(cabin_allotment - cabin_occupancy, 0)) AS avail,
                   SUM(cabin_allotment) AS allot
            FROM `tabTrip Package Price`
            WHERE parenttype = 'Trip Cruise Schedule'
              AND parentfield = 'cabin_rates'
              AND parent IN %(scheds)s
            GROUP BY parent
            """,
            {"scheds": sched_names},
            as_dict=True,
        )
        for r in rows:
            seats_by_sched[r.parent] = (
                int(r.avail or 0) if r.allot and int(r.allot) > 0 else None
            )

    cards = []
    for o in offers:
        td = td_map.get(o.travel_date)
        trip = trip_map.get(o.trip)
        if not td or not trip:
            continue
        chips = [
            {"key": s.lower(), **_INCLUSION_SECTIONS[s]}
            for s in sorted(sections_map.get(o.name, []))
        ]
        price = prices.get(o.name)
        sched = td.cruise_schedule or ""
        days = td.departure_date and td.return_date and (
            (getdate(td.return_date) - getdate(td.departure_date)).days + 1
        ) or 0
        nights = max(0, days - 1) if days else 0
        cards.append({
            "trip": trip.name,
            "trip_name": trip.trip_name or "",
            "route": trip.route or "",
            "trip_image": trip.trip_image
            or "/assets/travel_booking/img/defaultaroya.jpg",
            "date_key": o.legacy_tgd or o.travel_date,
            "offer_name": o.package_template or o.offer_name or "",
            "departure_date": str(td.departure_date or ""),
            "return_date": str(td.return_date or ""),
            "sailing_start": str(td.sailing_start or ""),
            "sailing_end": str(td.sailing_end or ""),
            "ship": td.ship_name or "",
            "embarkation_port": td.embarkation_port or "",
            "disembarkation_port": td.disembarkation_port or "",
            "total_days": days,
            "total_nights": nights,
            "inclusions": chips,
            "price": price,
            "currency": o.currency or "",
            "currency_symbol": symbols.get(o.currency, o.currency or ""),
            "seats_left": seats_by_sched.get(sched),
        })

    cards.sort(key=lambda c: (c["departure_date"], c["trip_name"]))
    if limit:
        cards = cards[:limit]
    return cards


def get_special_flags_by_travel_date(travel_dates):
    """Peta Travel Date → flag pakej khas — untuk chips ⭐ pada kad trip
    & kad tarikh page detail.

    KEMBALI: {td_name: {"is_special": True, "inclusions": ["flight", ...]}}
    (inclusions = UNION seksyen semua offer khas tarikh itu).
    """
    travel_dates = [d for d in (travel_dates or []) if d]
    if not travel_dates:
        return {}
    offers = _special_offers(travel_dates=travel_dates)
    if not offers:
        return {}
    sections_map = _addon_sections_by_offer([o.name for o in offers])
    flags = {}
    for o in offers:
        secs = sections_map.get(o.name) or []
        if not secs:
            continue
        f = flags.setdefault(o.travel_date, {"is_special": True, "inclusions": []})
        for s in secs:
            key = s.lower()
            if key not in f["inclusions"]:
                f["inclusions"].append(key)
    return flags


def attach_special_flags(detail: dict) -> dict:
    """Mutiarkan detail/bundle trip dengan flag pakej khas per tarikh —
    dipanggil dari get_trip_detail (kedua-dua laluan legacy & baharu)
    supaya trip_detail.js boleh render badge ⭐ + chips tanpa tahu
    struktur dalaman.

    Resolusi kunci tarikh (DUNIA kunci bercampur ikut laluan):
      - detail baharu: g["travel_date"] = nama Travel Date;
      - bundle baharu:  g["name"] = date_key = legacy_tgd ATAU nama
        Travel Date (tanpa medan travel_date berasingan);
      - legacy:         g["name"] = nama TGD — dipetakan balik ke Travel
        Date migration anchor (legacy_tgd).
    Jadi kandidat = travel_date ∪ name, diselesaikan sekali lalu: Travel
    Date yang (name IN kandidat OR legacy_tgd IN kandidat), dan flag
    dipromosikan kepada legacy_tgd supaya kedua-dua bentuk date_key
    menemuinya.
    """
    group_dates = (detail or {}).get("group_dates") or []
    if not group_dates:
        return detail

    cands = []
    for g in group_dates:
        for k in (g.get("travel_date"), g.get("name")):
            if k and k not in cands:
                cands.append(k)
    if not cands:
        return detail

    rows = frappe.get_all(
        "Travel Date",
        or_filters=[
            ["name", "in", cands],
            ["legacy_tgd", "in", cands],
        ],
        fields=["name", "legacy_tgd"],
    )
    if not rows:
        return detail

    flags = get_special_flags_by_travel_date([r.name for r in rows])
    if not flags:
        return detail

    # Promosi flag ke kunci legacy_tgd (date_key bundle / TGD legacy).
    for r in rows:
        f = flags.get(r.name)
        if f and r.legacy_tgd:
            flags.setdefault(r.legacy_tgd, f)

    for g in group_dates:
        f = flags.get(g.get("travel_date") or g.get("name"))
        g["is_special"] = bool(f)
        g["inclusions"] = (f or {}).get("inclusions") or []
    return detail


def get_upcoming_sailings(trips, trip_group_dates, limit=8):
    """Kad strip JADUAL PELAYARAN TERDEKAT untuk homepage — flatten
    trip_group_dates (sudah ditapis ready + currency listing oleh
    get_catalog_trips), SATU kad per (trip, sailing date) — perwakilan
    TGD cruise_only (durasi sailing sebenar; corak sama /cruise-schedule).

    KEMBALI list[dict]: {trip, trip_name, route, trip_image, date,
    date_label, day, mmm, year, weekday, sail_end, total_days/nights,
    ship, route_label, seats_left, seats_label, price, price_symbol}
    kronologi, limit terdekat.
    """
    events = []
    for t in trips:
        for g in trip_group_dates.get(t.get("name"), []) or []:
            base = g.get("sailing_start") or g.get("departure_date") or ""
            if not base:
                continue
            d = getdate(base)
            events.append({
                "trip": t.get("name"),
                "trip_name": t.get("trip_name") or "",
                "route": t.get("route") or "",
                "trip_image": t.get("trip_image")
                or "/assets/travel_booking/img/defaultaroya.jpg",
                "is_cruise_only": bool(g.get("is_cruise_only")),
                "date": str(base),
                "day": str(d.day),
                "mmm": d.strftime("%b"),
                "year": d.year,
                "weekday": d.strftime("%a"),
                "sail_end": g.get("sailing_end") or g.get("return_date") or "",
                "total_days": g.get("total_days") or 0,
                "total_nights": g.get("total_nights") or 0,
                "cruise_schedule": g.get("cruise_schedule") or "",
                "seats_left": g.get("seats_left"),
                "max_participants": g.get("max_participants"),
                "embarkation_port": g.get("embarkation_port") or "",
                "disembarkation_port": g.get("disembarkation_port") or "",
                "price": t.get("starting_from_price"),
                "promo_label": t.get("promo_label"),
            })

    if not events:
        return []

    # Nama kapal — SATU query untuk semua kad (corak _ship_names
    # /cruise-schedule).
    sched_names = list({e["cruise_schedule"] for e in events if e["cruise_schedule"]})
    ships = {}
    if sched_names:
        rows = frappe.db.get_values(
            "Trip Cruise Schedule", sched_names,
            ["name", "ship_name"], as_dict=True,
        )
        ships = {r.name: (r.ship_name or "") for r in rows}

    # Harga dipapar dengan simbol currency LISTING aktif — dibawa oleh
    # caller (context cruise.py), bukan di sini (bundle sudah ditapis
    # currency oleh get_catalog_trips).

    # Dedupe per (trip, sailing date) — cruise_only dulu (perwakilan),
    # kemudian kronologi, ambil `limit` terdekat.
    events.sort(key=lambda e: (e["date"], e["trip_name"], not e["is_cruise_only"]))
    seen = set()
    deduped = []
    for e in events:
        key = (e["trip"], e["date"])
        if key in seen:
            continue
        seen.add(key)
        e["ship"] = ships.get(e["cruise_schedule"], "")
        ports = [p for p in (e["embarkation_port"], e["disembarkation_port"]) if p]
        e["route_label"] = " → ".join(ports)
        # Label kuota: seats_left int → "N kabin"; unlimited → "Open Pax".
        seats = e["seats_left"]
        mx = e["max_participants"]
        if seats is None and (mx is None or mx == 0):
            e["seats_label"] = "Open Pax"
        elif seats is None:
            e["seats_label"] = "Available"
        elif seats <= 0:
            e["seats_label"] = "Full"
        else:
            e["seats_label"] = f"{seats} kabin"
        deduped.append(e)

    return deduped[:limit]
