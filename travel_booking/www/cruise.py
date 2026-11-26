# travel_booking/www/cruise.py
#
# Page homepage cruise /cruise — landing page utama untuk syarikat travel
# yang menjual pakej cruise. Menampilkan:
#   - Hero slide banner + search breaker
#   - Seksyen listing trip dinamik (dari Travel Website → Trip Listing
#     Sections child table — header + kategori Travel Date + maks kad
#     per seksyen, semua dikawal admin)
#   - Why Cruise With Us (benefits)
#   - Popular destinations
#   - Testimonials
#   - Final CTA
#
# Data dari trip_catalog (sumber sama /trips). Susunan & kandungan seksyen
# produk ditakrif dalam Travel Website (cruise_trip_sections) — bukan lagi
# auto-grouping ikut kategori.

import frappe

from travel_booking.utils.trip_catalog import get_catalog_trips, get_filter_options
from travel_booking.utils.website_config import get_website_config

# Penapis query string yang diterima homepage (search bar ringkas selepas
# hero: Destination + Sailing Month gabungan; corak sama katalog).
_FILTER_KEYS = ("destination", "month", "year")


def get_context(context):
    """Build context for the cruise homepage."""

    # Currency pilihan customer — menapis pakej & harga ikut currency itu.
    from travel_booking.www.trips import _get_currency_filter
    currency = _get_currency_filter()

    # 1. ALL cruise trips (cruise=1) ikut kronologi tarikh
    cruise_data = get_catalog_trips({"cruise": "1", "sort": "date", "currency": currency})
    all_cruises = cruise_data["trips"]
    trip_group_dates = cruise_data["trip_group_dates"]

    # 1a. Seksyen listing trip ikut konfigurasi Travel Website → Trip
    #     Listing Sections (aktif, susun ikut Position Sequence).
    cruise_groups = _configured_sections(all_cruises, trip_group_dates)

    # 2. Popular destinations — hanya destinasi yang ada trip cruise aktif,
    # disusun ikut bilangan cruise. options.destinations juga tertapis ke
    # cruise (untuk autocomplete search bar).
    options = get_filter_options(cruise=1)
    popular_destinations = _get_popular_destinations()

    # 3. SEARCH BAR (ringkas: Destination + Sailing Month gabungan
    # "YYYY MMM" menaik) — penapis semasa dari query string (pra-pilih).
    # Form GET → /cruises (katalog cruise), cruise=1 dibawa hidden input.
    filters = {}
    for k in _FILTER_KEYS:
        v = frappe.form_dict.get(k)
        if v:
            filters[k] = v
    from travel_booking.www.cruises import _sailing_year_months
    sailing_months = _sailing_year_months()

    # Pra-pilih dropdown gabungan daripada ?month=&year= (deep-link).
    active_month_year = ""
    if filters.get("month") and filters.get("year"):
        active_month_year = (
            f"{filters['year']}-{int(filters['month']):02d}"
        )

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

    # 4. Pass to template
    context.cruise_groups = cruise_groups
    context.trip_group_dates = trip_group_dates  # rujukan (kad kategori bawa gds sendiri)
    context.ga_cruises = _unique_trips(cruise_groups)
    context.popular_destinations = popular_destinations
    context.options = options
    # Konteks search bar
    context.active = filters
    context.sailing_months = sailing_months
    context.active_month_year = active_month_year
    context.destination_label = destination_label
    context.active_nav = "cruise"  # highlight nav if needed
    context.no_cache = 1
    context.title = "Luxury Cruise Vacations — Rarecation"
    # SEO: meta + Open Graph + JSON-LD WebSite (rujuk utils/seo.py).
    # Description default dari hero intro Travel Website (config cruise),
    # OG image dari hero background.
    from travel_booking.utils.seo import apply_seo, build_website_json_ld

    wc = get_website_config()
    # wc ialah plain dict (attr access hanya berfungsi dalam Jinja) —
    # python guna .get() bersarang.
    hero_cfg = (wc.get("cruise") or {}).get("hero") or {}

    # Hero SLIDER — child Website Banner Slide dari Travel Website →
    # Cruise Homepage → Hero Slider (aktif ikut sort_order). Tiada slide →
    # fallback SATU banner statik daripada section "Fallback Banner"
    # supaya hero kekal hidup.
    hero_slides = hero_cfg.get("banners") or []
    if not hero_slides and hero_cfg.get("background"):
        hero_slides = [{
            "banner_image": hero_cfg.get("background"),
            "banner_tag": "",
            "banner_title": "",
            "banner_subtitle": "",
            "banner_cta_label": "",
            "banner_link_url": "",
        }]
    context.hero_slides = hero_slides

    apply_seo(
        context,
        title="Luxury Cruise Vacations — Rarecation",
        description=(hero_cfg.get("intro") or ""),
        image=(hero_cfg.get("background") or ""),
        json_ld=build_website_json_ld(search_path="/cruises"),
    )
    # Meta currency listing (selector + simbol harga)
    context.currency = cruise_data["currency"]
    context.currency_symbol = cruise_data["currency_symbol"]
    context.currency_options = cruise_data["currency_options"]


def _configured_sections(all_cruises, trip_group_dates):
    """Seksyen listing trip homepage ikut konfigurasi Travel Website →
    cruise_trip_sections (child Website Trip Listing Section; aktif
    sahaja, susun ikut sort_order — _active_rows di website_config).

    Satu baris child table = satu seksyen homepage: tajuk/label/subtitle
    dari baris itu; kad trip dikumpul daripada trip cruise yang mana
    SALAH SATU tarikhnya (gds) berkategori travel_date_category baris
    tersebut. gds kad ditapis ikut kategori seksyen supaya badge
    kategori kad + pautan View Details (deep-link tarikh terdekat)
    konsisten dengan seksyen yang memaparkannya.
    Bilangan kad di-cap max_listings baris (default 6 bila kosong);
    seksyen tanpa kad di-skip (tiada grid kosong di homepage).

    Trip boleh muncul dalam beberapa seksyen jika tarikhnya meliputi
    beberapa kategori. KEMBALI list[dict]:
    {key, label, title, subtitle, cta_label, cta_url, cards} —
    cards = [{t, gds}].
    """
    wc = get_website_config()
    sections = (wc.get("cruise") or {}).get("trip_sections") or []

    groups = []
    for row in sections:
        cat = row.get("travel_date_category") or ""
        if not cat:
            continue
        try:
            limit = max(1, int(row.get("max_listings") or 6))
        except (TypeError, ValueError):
            limit = 6

        cards = []
        for t in all_cruises:
            gds = [
                g for g in (trip_group_dates.get(t.name) or [])
                if (g.get("trip_category") or "") == cat
            ]
            if gds:
                cards.append({"t": t, "gds": gds})
            if len(cards) >= limit:
                break

        if not cards:
            continue

        groups.append({
            "key": cat,
            "label": row.get("section_label") or "",
            "title": row.get("section_title") or cat,
            "subtitle": row.get("section_subtitle") or "",
            "cta_label": row.get("cta_label") or "",
            "cta_url": row.get("cta_url") or "",
            "cards": cards[:limit],
        })

    return groups


def _unique_trips(groups):
    """Trip unik (ikut susunan) merentasi seksyen listing — senarai
    item GA4 view_item_list (analytics.js); trip yang muncul dalam
    beberapa seksyen dihantar sekali sahaja."""
    seen, out = set(), []
    for grp in groups:
        for card in grp["cards"]:
            if card["t"].name not in seen:
                seen.add(card["t"].name)
                out.append(card["t"])
    return out


def _get_popular_destinations():
    """Destinasi yang disentuh oleh sekurang-kurangnya satu trip cruise
    aktif, disusun ikut bilangan cruise (terbanyak dahulu, maks 8).

    Query ini menggantikan pendekatan lama yang mengambil senarai generik
    dari get_filter_options (semua destinasi mana-mana trip) lalu
    menghiasnya dengan count — yang menyebabkan destinasi tanpa cruise
    tetap terpapar dan medan image sentiasa None (sebab get_filter_options
    tak SELECT destination_image).
    """
    try:
        rows = frappe.db.sql(
            """
            SELECT dp.name, dp.destination_name, dp.destination_country,
                   dp.destination_image AS image,
                   COUNT(DISTINCT t.name) AS cruise_count
            FROM `tabTrip Destination Point` dp
            JOIN `tabTrip Destination Point Select` sel
              ON sel.select_destination_point = dp.name
            JOIN `tabTrip` t ON t.name = sel.parent
            WHERE t.status = 'Active'
              AND t.is_a_cruise_trip = 1
            GROUP BY dp.name, dp.destination_name,
                     dp.destination_country, dp.destination_image
            ORDER BY cruise_count DESC
            LIMIT 8
            """,
            as_dict=True,
        )
    except Exception:
        frappe.logger().exception("cruise homepage: popular destinations query failed")
        return []

    return [
        {
            "name": r.name,
            "destination_name": r.destination_name or "",
            "destination_country": r.destination_country or "",
            "image": r.image,
            "cruise_count": r.cruise_count,
        }
        for r in rows
    ]
