# travel_booking/www/cruise_schedule.py
#
# Page jadual /cruise-schedule — TIMELINE pelayaran CRUISE sahaja
# (sesuai nama page: trip dengan is_a_cruise_trip = 1 sahaja).
#
# Sumber data: get_catalog_trips() — definisi "ready" yang SAMA dengan
# katalog (Trip Active + TGD Active + tarikh akan datang + ada package
# Active + published), harga "from" ikut currency listing pelawat.
# Cruise dipaksa = 1 (corak sama dengan /cruises).
#
# Pengumpulan timeline: event dikumpul ikut SAILING DATE (sailing_start,
# fallback departure_date). Dalam sailing date yang sama:
#   - trip dengan NAMA BERBEZA kekal kad berasingan (TIDAK digabung);
#   - variant TGD trip yang SAMA (cth Cruise Only + Cruise + Flight yang sama
#     sailing) digabung jadi SATU kad — perwakilan = TGD cruise_only
#     (durasi sailing sebenar; Cruise + Flight membawa hari penerbangan),
#     SEPADAN konvensyen trip_card.
#
# Query string: q (carian), destination (Trip Destination Point), month
# (bulan sailing 1–12), year (tahun sailing), currency.

import calendar
import json

import frappe
from frappe.utils import getdate

from travel_booking.utils.trip_catalog import (
    get_catalog_trips,
    get_filter_options,
)
from travel_booking.utils.website_config import web_date
from travel_booking.www.cruises import _sailing_periods
from travel_booking.www.trips import _get_currency_filter

# nama medan penapis yang diterima dari query string (month/year pasangan
# bulan-tahun pelayaran — corak sama dengan bar penapis /cruises)
_FILTER_KEYS = ("q", "destination", "month", "year", "currency")


def _ship_names(schedule_names) -> dict:
    """Trip Cruise Schedule -> ship_name (SATU query untuk semua kad,
    bukan get_doc per kad). Nama kapal dipapar pada meta node cruise."""
    names = [s for s in schedule_names if s]
    if not names:
        return {}
    rows = frappe.db.get_values(
        "Trip Cruise Schedule", names, ["name", "ship_name"], as_dict=True
    )
    return {r.name: (r.ship_name or "") for r in rows}


def _package_min_prices(package_names) -> dict:
    """Trip Package -> MIN(price_adult) (SATU query untuk semua pakej modal).
    Harga pakej dalam currency NATIVE pakej — currency yang sama digunakan
    untuk billing booking, jadi modal papar harga ikut currency pakej itu."""
    names = [p for p in package_names if p]
    if not names:
        return {}
    rows = frappe.db.sql(
        """
        SELECT parent, MIN(price_adult) AS min_price
        FROM `tabTrip Package Price`
        WHERE parent IN %(names)s
        GROUP BY parent
        """,
        {"names": names},
        as_dict=True,
    )
    return {r.parent: (float(r.min_price) if r.min_price else None) for r in rows}


def _variant_label(group: dict) -> str:
    """Label kemas variant sailing — "Cruise Only" / "Cruise + Flight" (corak
    sama dengan wizard booking; trip_group_name terlalu teknikal — mengandungi
    tarikh + kod trip)."""
    return "Cruise Only" if group.get("is_cruise_only") else "Cruise + Flight"


def _sailing_full_label(e: dict) -> str:
    """Julat sailing dengan KEDUA-DUA tarikh penuh (hari+bulan+tahun),
    cth "2 Nov 2026 – 9 Nov 2026"; tarikh tunggal bila mula=tamat."""
    start = web_date(e.get("date"))
    end = web_date(e.get("sail_end") or e.get("date"))
    if not start:
        return ""
    if not end or end == start:
        return start
    return f"{start} – {end}"


def _json_safe(obj) -> str:
    """JSON string selamat dibenamkan dalam <script type="application/json">
    — escape < > & supaya kandungan string tak boleh menutup tag / inject
    HTML (corak htmlsafe_json; ensure_ascii lalai dah tukar non-ASCII ke
    \\uXXXX)."""
    s = json.dumps(obj)
    return s.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def _attach_booking_options(dates: list, trip_packages: dict) -> None:
    """Suntik pilihan tempahan setiap kad sebagai JSON string `options_json`
    — sumber modal pemilihan pakej /cruise-schedule (butang Book Now TIDAK
    terus ke /booknow). Struktur: {trip, trip_name, sailing, variants:
    [{tgd, label, duration, range, seats, packages: [{name, type, flight,
    symbol, price}]}]}.

    Data 100% preloaded server-side — modal tak panggil API: setiap TGD
    "ready" dijamin ada >= 1 pakej Active (definisi "ready" katalog)."""
    wanted: list = []  # (event perwakilan, [(variant_event, [pakej])])
    names: set = set()
    for grp in dates:
        for e in grp["events"]:
            pairs = []
            for ev in e.get("variant_events") or [e]:
                pkgs = trip_packages.get(ev["tgd"]) or []
                names.update(p["name"] for p in pkgs)
                pairs.append((ev, pkgs))
            wanted.append((e, pairs))

    prices = _package_min_prices(names)

    for e, pairs in wanted:
        # Badge "With Flight" (rc-sched-side): kad ni ada pakej penerbangan
        # — pakej dgn airport_form dalam group bukan cruise-only. SEMUA
        # variant TGD kad disemak (kad gabungan Cruise Only + Cruise + Flight
        # tetap papar badge).
        e["has_flight"] = any(
            p.get("flight") and not p.get("is_cruise_only")
            for _ev, pkgs in pairs
            for p in pkgs
        )
        variants = []
        for ev, pkgs in pairs:
            variants.append(
                {
                    "tgd": ev["tgd"],
                    "label": _variant_label(ev),
                    "duration": (
                        f"{ev['total_days']}D / {ev['total_nights']}N"
                        if ev.get("total_days")
                        else ""
                    ),
                    "range": ev.get("range_label") or "",
                    # ISO sailing date variant ni — masuk bnw_cart untuk
                    # reverse-trace TGD di wizard /booknow (corak trip_detail.js)
                    "sailing_start": ev.get("date") or "",
                    # None = UNLIMITED; 0 = sold out (variant dilumpuhkan)
                    "seats": ev.get("seats_left"),
                    "packages": [
                        {
                            "name": p["name"],
                            "type": p.get("package_type") or "Package",
                            "flight": p.get("flight_label") or "",
                            "symbol": p.get("currency_symbol")
                            or p.get("currency")
                            or "",
                            "currency": p.get("currency") or "MYR",
                            "price": prices.get(p["name"]),
                            # ── Detail pakej (baris label/nilai dalam modal) ──
                            # Pakej cruise-only papar tarikh sailing; pakej
                            # penerbangan papar tarikh penerbangan TGD-nya
                            # (corak mockup SELECT PACKAGE). Tarikh diformat
                            # web_date ikut konfigurasi Travel Website.
                            "cruise_only": p.get("is_cruise_only"),
                            "dep_date": web_date(p.get("departure_date")),
                            "ret_date": web_date(p.get("return_date")),
                            "sail_start": web_date(p.get("sailing_start")),
                            "sail_end": web_date(p.get("sailing_end")),
                            "duration": (
                                f"{p['total_days']}D/{p['total_nights']}N"
                                if p.get("total_days")
                                else ""
                            ),
                            "ground": bool(p.get("ground_arrangement")),
                        }
                        for p in pkgs
                    ],
                }
            )
        e["options_json"] = _json_safe(
            {
                "trip": e["trip"],
                "trip_name": e["trip_name"],
                "sailing": e.get("range_label") or e.get("date_label") or "",
                # Tarikh penuh kedua-dua hujung sailing — sub tajuk modal
                # papar tarikh secara LENGKAP (cth "2 Nov 2026 – 9 Nov 2026"),
                # bukan bentuk ringkas range_label ("2 – 9 Nov 2026").
                "sailing_full": _sailing_full_label(e),
                "variants": variants,
            }
        )


def _range_label(start_iso: str, end_iso: str) -> str:
    """Label julat sailing yang kemas: "12 – 20 Oct 2026" (bulan/tahun
    sama), "28 Sep – 05 Oct 2026" (bulan sama tahun), "28 Dec 2026 –
    03 Jan 2027" (tahun berbeza), tarikh tunggal, atau ""."""
    if not start_iso:
        return ""
    s = getdate(start_iso)
    if not end_iso:
        return f"{s.day} {s:%b %Y}"
    e = getdate(end_iso)
    if s == e:
        return f"{s.day} {s:%b %Y}"
    if (s.year, s.month) == (e.year, e.month):
        return f"{s.day} – {e.day} {s:%b %Y}"
    if s.year == e.year:
        return f"{s.day} {s:%b} – {e.day} {e:%b} {e.year}"
    return f"{s.day} {s:%b %Y} – {e.day} {e:%b %Y}"


def _build_timeline(data: dict) -> tuple[list, list]:
    """Ratakan trip x group date kepada kad cruise, KUMPUL ikut sailing
    date, dan gabung variant TGD trip yang sama. KEMBALI (dates, years):

    - dates: [{key (ISO sailing date), events: [kad, ...]}] kronologi —
      SATU kad per TRIP dalam setiap sailing date (nama lain tak digabung).
    - years: [int, ...] tahun sailing yang ada departure (dropdown).
    """
    events: list = []
    for t in data["trips"]:
        for g in data["trip_group_dates"].get(t.name) or []:
            base = g.get("sailing_start") or g.get("departure_date") or ""
            if not base:
                continue
            d = getdate(base)
            events.append(
                {
                    # ── trip (header kad) ──
                    "trip": t["name"],
                    "route": t.get("route") or "",
                    "trip_name": t.get("trip_name") or "",
                    "trip_image": t.get("trip_image")
                    or "/assets/travel_booking/img/defaultaroya.jpg",
                    "categories": t.get("trip_categories") or "",
                    "destinations": [
                        dd["destination_name"] for dd in (t.get("destinations") or [])
                    ],
                    "starting_from_price": t.get("starting_from_price"),
                    # ── group date (perwakilan sailing) ──
                    "tgd": g["name"],
                    "is_cruise_only": bool(g.get("is_cruise_only")),
                    "date": base,
                    "date_label": web_date(base),
                    "day": str(d.day),
                    "mmm": d.strftime("%b"),
                    "year": d.year,
                    "weekday": d.strftime("%a"),
                    "sail_end": g.get("sailing_end") or g.get("return_date") or "",
                    "total_days": g.get("total_days") or 0,
                    "total_nights": g.get("total_nights") or 0,
                    "seats_left": g.get("seats_left"),
                    "max_participants": g.get("max_participants"),
                    "embarkation_port": g.get("embarkation_port") or "",
                    "disembarkation_port": g.get("disembarkation_port") or "",
                    "cruise_schedule": g.get("cruise_schedule") or "",
                }
            )

    # Nama kapal (Trip Cruise Schedule) — sekali query untuk semua kad.
    ships = _ship_names({e["cruise_schedule"] for e in events})
    for e in events:
        e["ship"] = ships.get(e["cruise_schedule"], "")
        # meta terorgan: julat sailing + laluan port
        e["range_label"] = _range_label(e["date"], e["sail_end"])
        ports = [p for p in (e["embarkation_port"], e["disembarkation_port"]) if p]
        e["route_label"] = " → ".join(ports)

    # Kronologi; sailing + trip sama — cruise_only dulu (perwakilan kad).
    events.sort(
        key=lambda e: (e["date"], e["trip_name"], not e["is_cruise_only"])
    )

    # ── Kumpul ikut SAILING DATE, kemudian gabung variant trip yang sama ──
    dates: list = []
    by_date: dict = {}
    for e in events:
        grp = by_date.get(e["date"])
        if not grp:
            grp = {"key": e["date"], "events": []}
            by_date[e["date"]] = grp
            dates.append(grp)
        grp["events"].append(e)

    for grp in dates:
        merged: list = []
        by_trip: dict = {}
        for e in grp["events"]:
            rep = by_trip.get(e["trip"])
            if not rep:
                # kad pertama trip ni pada sailing ni (cruise_only dah
                # didahulukan oleh susunan) — kekal sebagai perwakilan.
                e["variants"] = 1
                e["variant_events"] = [e]
                by_trip[e["trip"]] = e
                merged.append(e)
            else:
                rep["variants"] += 1
                rep["variant_events"].append(e)
        grp["events"] = merged

    # ── Pemisah bulan pada timeline: kumpulan PERTAMA setiap (tahun, bulan)
    # ditanda — /cruise-schedule render header bulan (cth "October 2026")
    # sebelum node sailing pertama bulan itu, jadi timeline terpecah jelas
    # per bulan. Senarai dates kronologi, jadi satu laluan cukup. ──
    seen_months: set = set()
    for grp in dates:
        d = getdate(grp["key"])
        month_key = (d.year, d.month)
        grp["new_month"] = month_key not in seen_months
        seen_months.add(month_key)
        grp["month_label"] = d.strftime("%B %Y")

    # Pilihan tempahan per kad (variant TGD + pakej + harga) untuk modal
    # pemilihan pakej — disuntik sebagai options_json.
    _attach_booking_options(dates, data["trip_packages"])

    return dates, sorted({e["year"] for e in events})


def get_context(context):
    # Penapis dari query string (GET form — deep-link mesra, corak sama
    # dengan /cruises). Cruise dipaksa = 1: page ini khas cruise sahaja.
    filters = {}
    for k in _FILTER_KEYS:
        v = frappe.form_dict.get(k)
        if v:
            filters[k] = v

    catalog_filters = {
        "cruise": "1",
        "currency": _get_currency_filter(),
        "q": filters.get("q") or "",
        "destination": filters.get("destination") or "",
        # "" → cint 0 → tanpa tapisan bulan (get_catalog_trips)
        "month": filters.get("month") or "",
    }
    if filters.get("year"):
        catalog_filters["year"] = filters["year"]

    data = get_catalog_trips(catalog_filters)
    dates, year_options = _build_timeline(data)

    # Pilihan autocomplete destinasi — destinasi yang dipakai trip cruise
    # aktif sahaja (sumber sama dengan bar penapis /cruises + hero /cruise).
    context.options = get_filter_options(cruise=1)

    # Pilihan dropdown bulan — bulan sebenar yang ada sailing cruise ready
    # (sumber sama dengan bar penapis /cruises).
    _years, _months = _sailing_periods()
    context.month_options = [
        {"value": m, "label": calendar.month_name[m]} for m in _months
    ]

    # Label destinasi terpilih untuk paparan semula pada input autocomplete
    # selepas reload dgn ?destination=... (hidden input membawa nilai
    # sebenar). Nilai tak wujud di master: label fallback = nilai mentah.
    destination_label = filters.get("destination") or ""
    if destination_label:
        dest = frappe.db.get_value(
            "Trip Destination Point", destination_label,
            ["destination_name", "destination_country"], as_dict=True,
        )
        if dest:
            destination_label = (
                f"{dest.destination_name}, {dest.destination_country}"
                if dest.destination_country
                else (dest.destination_name or destination_label)
            )
    context.destination_label = destination_label

    context.dates = dates
    context.year_options = year_options
    # statistik bar meta: jumlah sailing date (node) & cruise berbeza
    context.stats = {
        "sailings": len(dates),
        "trips": len(data["trips"]),
    }
    context.active = filters
    context.active_nav = "cruise"  # menu cruise + highlight (corak katalog)
    context.no_cache = 1
    context.title = "Cruise Schedule — Rarecation"
    # SEO: meta + Open Graph + JSON-LD WebSite (rujuk utils/seo.py).
    from travel_booking.utils.seo import apply_seo

    apply_seo(
        context,
        title="Cruise Schedule — Rarecation",
        description=(
            "Upcoming cruise sailing schedule — browse departure dates, "
            "ships and itineraries month by month and reserve your cabin "
            "online."
        ),
        noindex=bool(filters.get("month") or filters.get("year")),
    )
    # Meta currency listing (simbol harga + selector menubar)
    context.currency = data["currency"]
    context.currency_symbol = data["currency_symbol"]
    context.currency_options = data["currency_options"]
