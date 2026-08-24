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

    # 2. Get popular destinations (from filter options + count cruises per dest)
    options = get_filter_options()
    popular_destinations = _get_popular_destinations(options.get("destinations", []))

    # 3. Pass to template
    context.featured_cruises = featured_cruises
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


def _get_popular_destinations(destination_list):
    """Get destinations with cruise count. Returns list of dicts."""
    if not destination_list:
        return []

    # Count how many active cruises go to each destination
    dest_names = [d.get("name") for d in destination_list if d.get("name")]

    counts = {}
    if dest_names:
        try:
            rows = frappe.db.sql("""
                SELECT dp.name, COUNT(DISTINCT t.name) as cruise_count
                FROM `tabTrip Destination Point` dp
                JOIN `tabTrip Destination` td ON td.destination_point = dp.name
                JOIN `tabTrip` t ON t.name = td.parent
                WHERE t.status = 'Active'
                  AND t.is_a_cruise_trip = 1
                  AND dp.name IN %(dests)s
                GROUP BY dp.name
                ORDER BY cruise_count DESC
                LIMIT 8
            """, {"dests": dest_names}, as_dict=True)

            counts = {r.name: r.cruise_count for r in rows}
        except Exception:
            pass

    # Build result list with image placeholder
    result = []
    for d in destination_list[:8]:
        name = d.get("name")
        result.append({
            "name": name,
            "destination_name": d.get("destination_name", ""),
            "destination_country": d.get("destination_country", ""),
            "image": d.get("image"),  # optional field
            "cruise_count": counts.get(name, 0),
        })

    return result
