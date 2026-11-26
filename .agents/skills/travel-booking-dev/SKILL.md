---
name: travel-booking-dev
description: Conventions and architecture for the travel_booking Frappe/ERPNext app (cruise & tour trip booking management). Use whenever working in this repo — editing its Python API modules, DocTypes, hooks.py, Desk pages, www/portal pages, desk JS/CSS, running bench migrate/tests/build for it, or answering questions about Booking, Trip, pricing, cabin, portal or payment behavior — even if the user just says "this app" or "here" without naming it.
---

# travel_booking dev guide

## What this app is

Frappe v17 app on ERPNext ("Travel Booking Management"): customers browse trips on a public
website (`travel_booking/www/`), book through a portal, and staff manage trips, bookings,
pricing and payments from custom Desk pages. Built for the rpwp.my / rarecation.com family of
sites.

- **Dev/test site: `_rare`** — the only site on this bench with the app installed. Point every
  bench command at it: `bench --site _rare migrate`. Production sites (rpwp.my,
  trip.rarecation.com, …) run the same code — never experiment there.
- Design docs for major features live in the repo root: `ROOMING_WORKFLOW.md`,
  `ENHANCED_ADDON_SCOPING.md`, `BOOKING_MANAGER_PROPOSAL.md`. Read the relevant one before
  touching that feature.

## Architecture map

| Path | What lives there |
|---|---|
| `travel_booking/api/` | Nearly all business logic (see module groups below) |
| `travel_booking/module_travel_booking/doctype/` | DocTypes: Booking, Booking Reservation, Trip*, Traveller, Voucher, Travel Price Rule, … |
| `travel_booking/module_admin_portal/page/`, `resources_management/page/` | Custom Desk pages (trip-manager, trip-command-center, booking-hub, ongoing-today, dashboard-reports, travel-resources) — routes, roles and scripts registered in `hooks.py` `pages` |
| `travel_booking/www/` | Public website + customer portal (Jinja `.html` + `.py` controllers), backed by `api/portal_*.py` |
| `travel_booking/public/js|css/` | Desk assets, e.g. the reusable `booking_list.js` list component |
| `travel_booking/utils/` | Website helpers: trip_catalog, featured_catalog, geo_currency, seo, website_config |
| `travel_booking/install.py`, `patches/` | Default records created at install; `app_init` patch in `hooks.py` |

### api/ module groups

- **Booking core**: `booking_engine.py` is the orchestrator — `confirm_booking`, the status
  engine (`_recompute_booking_status`), cascade cancel, scheduled tasks, doc-event hooks.
  `booking.py` is only a re-export façade kept for backwards compatibility — import from
  `booking_engine` (or the specific module) directly, never from `booking.py`.
  `so_helpers.py` builds Customer / Sales Order / Payment Entry records.
- **Pricing**: `pricing.py` (pricing map, selection, capacity validation), `price_rule.py`
  (Travel Price Rule engine), `price_config.py`, `price_labels.py`, `currency_axis.py`.
- **Cruise/cabin**: `cabin_registry.py` (physical stateroom registry), `cabin_sharing.py`,
  `cabin_upgrade.py`; availability sync lives on the `Trip Cruise Schedule` doctype.
- **Portal**: `portal_auth.py`, `otp.py`, `portal_booking.py`, `portal_payment.py`,
  `portal_profile.py`, `portal_traveller.py`, `stripe_checkout.py`.
- **Extras**: `addon_manager.py`, `merchandise.py`, `package_components.py`, `voucher.py`,
  `terms.py`, `email_service.py`, `billing_address_sync.py`, `realtime.py`
  (permission override for unsaved docs), `passport_maintenance.py`, `receipt_ocr.py`.
- **Desk-page backends**: `ongoing_today.py`, `trip_command_center.py`, `booking_hub.py`,
  `dashboard_reports.py`, `trip_manager.py`, `manage_trip_booking.py`.

### DocTypes that matter most

- **Booking** — the customer-facing booking. Holds *snapshot* fields mirrored from its Sales
  Order: `pre_discount_total`, `payment_status`, `prog_payment`, `booked_pax`. The overbooking
  gate is `SUM(booked_pax)` against trip capacity.
- **Sales Order** — the *source of truth for prices*. Every SO change (draft edit,
  update-after-submit, discount, cancel, delete) syncs back to Booking snapshots via
  `on_sales_order_change` in `hooks.py`. Never write price fields on Booking directly.
- **Booking Reservation** — links a booking's travellers to a `Trip Cruise Schedule` + room
  category. Insert/update/delete triggers cabin availability sync and Cruise Cabin registry
  refresh.
- **Trip → Trip Group Date → Trip Package → Trip Package Price** (rows `cabin_rates` per room
  category) → **Trip Cruise Schedule**; midnight cron keeps Trip Group Date / schedule
  statuses current.
- **Travel Settings** (Single) — feature flags and limits (e.g. `pending_abandoned_days`,
  AI OCR settings).

## Hard conventions

- **Comments and docstrings are in Malay (Bahasa Malaysia)** — the entire codebase is. Write
  new comments/docstrings in Malay, matching the existing terse, explanatory style.
- **Whitelisted API methods need full type annotations** — `hooks.py` sets
  `require_type_annotated_api_methods = True`; a missing annotation breaks the app's checks.
- **Asset cache-busting is mandatory.** nginx serves `/assets` with a 1-year cache, so after
  editing any file listed in `app_include_js` / `app_include_css` (hooks.py) you MUST bump its
  `?v=` timestamp suffix or clients never see the change. Portal (www) assets instead use the
  `asset_v()` Jinja helper (`?v={{ asset_v('js/portal_billing.js') }}`) — mtime-based, no
  manual bump needed.
- **`use_json_request_body = True`** — non-GET whitelisted endpoints receive native JSON
  bodies, not form-encoded data.
- **Doc events are highly interlinked.** Payment Entry, Booking, Address, Sales Order,
  Booking Reservation and Trip Cruise Schedule all have hooks (see `hooks.py`). Before
  changing any of these flows, read the hook chain first — a "simple" edit can desync booking
  aggregates, cabin availability or invoices.
- **Daily jobs exist as safety nets**: invoice reconciliation (`reconcile_missing_invoices`),
  abandoned bookings, reservation status recompute, expired-passport PII cleanup (6-month rule:
  passport images are deleted, never archived). Don't add flows that assume these ran
  synchronously.

## Everyday commands

```bash
cd /home/frappe/frappe-bench

# After DocType JSON changes
bench --site _rare migrate
bench restart

# After desk JS/CSS changes (plus the ?v= bump in hooks.py)
bench build --app travel_booking

# Tests (see conventions below)
bench --site _rare run-tests --app travel_booking
bench --site _rare run-tests --module travel_booking.api.test_receipt_ocr
bench --site _rare run-tests --module travel_booking.api.test_receipt_ocr --case TestReceiptOCR.test_disabled

# Scratchpad / one-off calls
bench --site _rare console
bench --site _rare execute travel_booking.api.some_module.fn --kwargs "{'arg': 1}"
```

Lint/format: repo has pre-commit (ruff, eslint, prettier, pyupgrade) — install once with
`pre-commit install`; it will fix formatting on commit.

## Testing conventions

Unit tests live **next to the code** (`travel_booking/api/test_*.py`,
`travel_booking/utils/test_*.py`), not in doctype folders. Follow the existing style:

- Base class `frappe.tests.UnitTestCase`, `unittest.mock.patch` for externals.
- **Hermetic**: mock settings and external API calls; never hit real services.
- **Never leave site state changed**: restore Travel Settings flags to their *original site
  values* in teardown (see `_restore_flag` in `test_receipt_ocr.py` — old tests hardcoded 0
  and disabled AI OCR on a production site).

## Pitfalls checklist

Before finishing a change, verify:

1. New/edited whitelisted methods have type annotations.
2. Comments/docstrings are in Malay.
3. If a doctype JSON changed → migrate ran; if desk JS/CSS changed → `?v=` bumped + build ran.
4. Booking snapshot fields were not written directly — the SO path did it.
5. Related doc-event chains still hold (run the app's tests, not just the module you touched).
6. Nothing destructive was run against a production site — dev work happens on `_rare`.
