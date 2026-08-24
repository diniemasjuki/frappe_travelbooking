# travel_booking/www/tour.py
#
# Page homepage tour /tour — landing page utama untuk syarikat travel
# yang menjual pakej travel (tour) ke luar negara. Scope: trip BUKAN cruise
# (is_a_cruise_trip = 0).
#
# Data dari trip_catalog (sumber sama /trips) + enrichment khusus tour.

import frappe

from travel_booking.utils.trip_catalog import get_catalog_trips, get_filter_options


def get_context(context):
    """Build context for the tour homepage."""

    # 1. Get ALL non-cruise trips (cruise=0 filter) as "featured"
    tour_data = get_catalog_trips({"cruise": "0", "sort": "date"})
    all_tours = tour_data["trips"]
    trip_group_dates = tour_data["trip_group_dates"]

    # Enrich with tour-specific fields for card display
    featured_tours = _enrich_tour_cards(all_tours[:6], trip_group_dates)

    # 2. Get popular destinations (from filter options + count tours per dest)
    options = get_filter_options()
    popular_destinations = _get_popular_destinations(options.get("destinations", []))

    # 3. Pass to template
    context.featured_tours = featured_tours
    context.popular_destinations = popular_destinations
    context.options = options
    context.active_nav = "tour"
    context.no_cache = 1
    context.title = "International Travel & Tours — Rarecation"


def _enrich_tour_cards(trips, trip_group_dates):
    """Enrich trip dicts with tour-card-specific fields."""
    enriched = []
    for t in trips:
        gds = trip_group_dates.get(t.name, [])
        g = gds[0] if gds else {}

        # Duration label
        total_days = g.get("total_days") or 0
        total_nights = g.get("total_nights") or 0
        days_nights = f"{total_days}D/{total_nights}N" if total_days else ""

        # Organizer / agent name
        organizer = t.get("organizer_name") or ""

        # Route name (destination summary)
        destinations = t.get("destinations") or []
        route_name = ", ".join(
            [d.get("destination_name", "") for d in destinations[:3]]
        )
        if len(destinations) > 3:
            route_name += f" +{len(destinations) - 3}"

        # Short description
        short_desc = t.get("short_description") or ""
        if not short_desc and destinations:
            short_desc = (
                "Discover "
                + " & ".join(
                    [d.get("destination_name", "") for d in destinations[:2]]
                )
                + " with our curated travel experience."
            )

        # Hot sale flag (departure within 60 days AND limited seats)
        is_hot_sale = False
        if g:
            from datetime import date

            dep = g.get("departure_date")
            seats = g.get("seats_left")
            if dep and seats:
                try:
                    dep_date = date.fromisoformat(str(dep))
                    is_hot_sale = (
                        (dep_date - date.today()).days <= 60
                        and seats > 0
                        and seats <= 5
                    )
                except (ValueError, TypeError):
                    pass

        enriched.append(
            {
                **t,
                "days_nights": days_nights,
                "organizer": organizer,
                "route_name": route_name,
                "short_description": short_desc[:150],
                "is_hot_sale": is_hot_sale,
            }
        )

    return enriched


def _get_popular_destinations(destination_list):
    """Get destinations with tour count. Returns list of dicts."""
    if not destination_list:
        return []

    dest_names = [d.get("name") for d in destination_list if d.get("name")]

    counts = {}
    if dest_names:
        try:
            rows = frappe.db.sql(
                """
                SELECT dp.name, COUNT(DISTINCT t.name) as tour_count
                FROM `tabTrip Destination Point` dp
                JOIN `tabTrip Destination` td ON td.destination_point = dp.name
                JOIN `tabTrip` t ON t.name = td.parent
                WHERE t.status = 'Active'
                  AND t.is_a_cruise_trip = 0
                  AND dp.name IN %(dests)s
                GROUP BY dp.name
                ORDER BY tour_count DESC
                LIMIT 8
            """,
                {"dests": dest_names},
                as_dict=True,
            )

            counts = {r.name: r.tour_count for r in rows}
        except Exception:
            pass

    result = []
    for d in destination_list[:8]:
        name = d.get("name")
        result.append(
            {
                "name": name,
                "destination_name": d.get("destination_name", ""),
                "destination_country": d.get("destination_country", ""),
                "image": d.get("image"),
                "tour_count": counts.get(name, 0),
            }
        )

    return result
