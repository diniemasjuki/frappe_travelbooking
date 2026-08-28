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

    # 2. Get popular destinations — only those linked to published, active
    # NON-CRUISE trips, sorted by tour count. options.destinations juga
    # tertapis ke tour (untuk hero search autocomplete).
    options = get_filter_options(cruise=0)
    popular_destinations = _get_popular_destinations()

    # 3. Pass to template
    context.featured_tours = featured_tours
    context.trip_group_dates = trip_group_dates  # untuk trip_card.html (gds)
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


def _get_popular_destinations():
    """Destinasi yang terkait dengan trip Active, published, NON-CRUISE,
    disusun ikut jumlah tour menurun. Self-contained — tak bergantung pada
    get_filter_options() (yang pulangkan semua destinasi termasuk cruise).

    Child table Trip.destination_list → Trip Destination Point Select,
    medan `select_destination_point` → Trip Destination Point master.
    """
    try:
        rows = frappe.db.sql(
            """
            SELECT dp.name, dp.destination_name, dp.destination_country,
                   dp.destination_image, COUNT(DISTINCT t.name) AS tour_count
            FROM `tabTrip Destination Point` dp
            JOIN `tabTrip Destination Point Select` sel
                ON sel.select_destination_point = dp.name
            JOIN `tabTrip` t
                ON t.name = sel.parent AND sel.parenttype = 'Trip'
            WHERE t.status = 'Active'
              AND t.is_a_cruise_trip = 0
              AND t.published = 1
            GROUP BY dp.name
            ORDER BY tour_count DESC
            LIMIT 8
            """,
            as_dict=True,
        )
    except Exception:
        return []

    return [
        {
            "name": r.name,
            "destination_name": r.destination_name or r.name,
            "destination_country": r.destination_country or "",
            "image": r.destination_image or "",
            "tour_count": r.tour_count or 0,
        }
        for r in rows
    ]
