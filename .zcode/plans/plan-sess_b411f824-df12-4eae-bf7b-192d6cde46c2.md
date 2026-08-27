# Plan: Group flight info into 3 labeled sub-sections (Option A)

Reorganize Trip Hero (Section A) on `traveller/booking.html` from one flat `tv-hero-grid` into 3 clearly-labeled category blocks. Each block renders **only if it has data** ("if exist"). The 3rd block (Flight Itinerary) currently has no booking-level data, so it must be surfaced first.

## 1. Surface flight data at booking level — `travel_booking/api/portal_booking.py`

The Booking doctype already has a single `flight` Link (→ Flight); per-slot flights inherit from it. The booking query (lines 47-77) does NOT select it.

- **Add `b.flight`** to the booking query SELECT (after line 50, `b.status,` → add `b.flight,`).
- **Build a `flight_info` dict** after `booking = booking[0]` (line 81), before the `return` (line 336):
  - Primary source: `booking.flight` (the booking-level link).
  - **Fallback** when `booking.flight` is null: `SELECT DISTINCT flight FROM tabBooking Reservation WHERE booking=%s AND IFNULL(flight,'')!=''`; use it only if exactly one distinct value (slots normally inherit the same flight).
  - When a flight link exists, fetch via `frappe.db.get_value("Flight", link, [pnr, airline, home_airport, destination_airport, departure_date, arrival_date, flight_class, flight_itinerary], as_dict=True)`.
  - Resolve display names:
    - Airline: `get_value("Flight Airline", fd.airline, "airline_name")`.
    - Home & destination airports: `get_value("Flight Airport", link, [airport_code, airport_name, airport_city], as_dict=True)` for each.
  - Shape: `{ pnr, airline, home_airport_code, home_airport_name, dest_airport_code, dest_airport_name, departure_date, arrival_date, flight_class, itinerary_html }` (empty `{}` when no flight).
- **Add to the booking return dict**: `"flight_itinerary": flight_info,` (nested object → JS checks `b.flight_itinerary && b.flight_itinerary.pnr`).

Note: `pnr` is the Flight doc's `name` (autoname `field:pnr`). The existing booking-level `airport_*` fields come from `tp.airport_form` (Trip Package's departure airport) — a different concept, kept as-is in the Departure & Arrival block.

## 2. Restructure Trip Hero into 3 sub-sections — `travel_booking/public/js/traveller_detail.js`

Replace the single flat `tv-hero-grid` (lines 157-190) with three labeled blocks. Each uses the existing `.tv-sec` heading (uppercase label + top-border divider) + `.tv-hero-grid`/`.tv-hero-cell` (already responsive 3→2→1 col).

**Block 1 — ✈ Departure & Arrival** (always):
- Departure Date (`depDate`), Return Date (`retDate`), Fly From (`flyFromHtml`, keep the existing cruise-only/ground-only conditional).

**Block 2 — ⚓ Cruise & Sailing** (`if (isCruise)`):
- Sailing Start, Sailing End, Ship, Embarkation Port, Disembarkation Port.

**Block 3 — 🛫 Flight Itinerary** (`if (fi && fi.pnr)`):
- PNR, Departure Airport (code + name), Arrival Airport (code + name), Departure Date (`fi.departure_date`), Return Date (`fi.arrival_date`), Airline (`fi.airline` + `fi.flight_class` as small subtitle).
- Optional: if `fi.itinerary_html` is non-empty, render it in a muted container below the grid (admin-entered Text Editor HTML — trusted source).

## 3. CSS — `travel_booking/public/css/traveller.css` (minimal)

- Reuse `.tv-sec` (gives the labeled divider between blocks — the first `.tv-sec` is not `:first-child` of the card since the ref/name/group rows precede it, so it correctly shows a top divider) and `.tv-hero-grid`/`.tv-hero-cell` (no new grid CSS needed; mobile-responsive already).
- Add one small optional rule for the rich-itinerary container: `.tv-flight-itinerary-html { margin-top:12px; font-size:13px; color:var(--text-secondary); line-height:1.6; border-top:1px solid var(--border-light); padding-top:12px; }` and `img { max-width:100%; }`.

## Notes / edge cases
- "if exist": Cruise block only when `isCruise`; Flight block only when `b.flight_itinerary.pnr`; rich text only when present. Non-cruise + no-flight bookings show only Block 1.
- Distinction kept on purpose: "Fly From" (package airport) lives in Departure & Arrival; the Flight doctype's home→dest airports live in Flight Itinerary (trip-level vs flight-level — they can differ).
- **Restart**: the `portal_booking.py` change needs a gunicorn restart (preload caches Python). JS/CSS auto-bust via `asset_v()` mtime. I'll verify the API via `curl` (per the known log trap, prefer curl over console) and restore log ownership if needed.

## Files
1. `travel_booking/api/portal_booking.py` — add `b.flight` to SELECT + build/return `flight_itinerary`.
2. `travel_booking/public/js/traveller_detail.js` — 3 labeled sub-sections in Section A + flight block rendering.
3. `travel_booking/public/css/traveller.css` — one optional container rule.