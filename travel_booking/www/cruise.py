# travel_booking/www/cruise.py
#
# Page homepage cruise /cruise — landing page utama untuk syarikat travel
# yang menjual pakej cruise. Menampilkan:
#   - Hero dengan search widget
#   - Featured cruises (cruise sahaja, dihighlight)
#   - Why Cruise With Us (benefits)
#   - Popular destinations
#   - How It Works
#   - Testimonials (static content)
#   - Newsletter CTA
#
# Data dari trip_catalog (sumber sama /trips) + enrichment khusus cruise.

import frappe

from travel_booking.utils.trip_catalog import get_catalog_trips, get_filter_options


def get_context(context):
    """Build context for the cruise homepage."""

    # 1. Get ALL cruise trips (cruise=1 filter) as "featured"
    cruise_data = get_catalog_trips({"cruise": "1", "sort": "date"})
    all_cruises = cruise_data["trips"]
    trip_group_dates = cruise_data["trip_group_dates"]

    # Enrich with cruise-specific fields for card display
    featured_cruises = _enrich_cruise_cards(all_cruises[:6], trip_group_dates)

    # 2. Popular destinations — hanya destinasi yang ada trip cruise aktif,
    # disusun ikut bilangan cruise. options.destinations juga tertapis ke
    # cruise (untuk hero search autocomplete).
    options = get_filter_options(cruise=1)
    popular_destinations = _get_popular_destinations()

    # 3. Pass to template
    context.featured_cruises = featured_cruises
    context.trip_group_dates = trip_group_dates  # untuk trip_card.html (gds)
    context.popular_destinations = popular_destinations
    context.options = options
    context.active_nav = "cruise"  # highlight nav if needed
    context.no_cache = 1
    context.title = "Luxury Cruise Vacations — Rarecation"


def _enrich_cruise_cards(trips, trip_group_dates):
    """Enrich trip dicts with cruise-card-specific fields."""
    enriched = []
    for t in trips:
        gds = trip_group_dates.get(t.name, [])
        g = gds[0] if gds else {}

        # Duration label
        total_days = g.get("total_days") or 0
        total_nights = g.get("total_nights") or 0
        days_nights = f"{total_days}D/{total_nights}N" if total_days else ""

        # Ship name (from group date or trip)
        ship_name = g.get("trip_group_name") or t.get("trip_name") or ""

        # Route name (destination summary)
        destinations = t.get("destinations") or []
        route_name = ", ".join(
            [d.get("destination_name", "") for d in destinations[:3]]
        )
        if len(destinations) > 3:
            route_name += f" +{len(destinations) - 3}"

        # Short description (first 120 chars of description or generated)
        short_desc = t.get("short_description") or ""
        if not short_desc and destinations:
            short_desc = f"Explore {' & '.join([d.get('destination_name', '') for d in destinations[:2]])} aboard luxury cruise."

        # Hot sale flag (arbitrary: if departure within 60 days AND has seats)
        is_hot_sale = False
        if g:
            from datetime import date, timedelta
            dep = g.get("departure_date")
            seats = g.get("seats_left")
            if dep and seats:
                try:
                    dep_date = date.fromisoformat(str(dep))
                    is_hot_sale = (dep_date - date.today()).days <= 60 and seats > 0 and seats <= 5
                except (ValueError, TypeError):
                    pass

        enriched.append({
            **t,
            "days_nights": days_nights,
            "ship_name": ship_name,
            "route_name": route_name,
            "short_description": short_desc[:150],
            "is_hot_sale": is_hot_sale,
        })

    return enriched


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
