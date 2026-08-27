# travel_booking/api/addon_manager.py
#
# Portal endpoints untuk upsell addon/insurance selepas booking confirmed:
#   - get_available_addons(booking_number) — katalog Addon Package yang
#     layak untuk booking ni (scoped ikut trip_package), dengan status
#     stok/cutoff untuk paparan portal.
#   - checkout_addons(booking_number, lines, ...) — cart checkout:
#     re-price server-side, cipta SATU Sales Order addon (item "Trip Addon
#     Package") + Booking Addon (header) + Booking Addon Item (baris),
#     redirect ke billing page untuk pembayaran.
#
# Ownership booking disahkan setiap panggilan melalui _get_customer()
# (portal_booking.py) — customer HANYA boleh checkout addon untuk booking
# dia sendiri, tak kira apa booking_number dihantar.

import frappe
import json

from travel_booking.api.portal_booking import _get_customer
from travel_booking.api.constants import ADDON_PACKAGE_ITEM_CODE
from travel_booking.api.so_helpers import (
    _get_or_create_travel_item,
    _resolve_so_currency_and_rate,
)


# ══════════════════════════════════════════════
# OWNERSHIP GUARD
# ══════════════════════════════════════════════

def _get_owned_booking(booking_number):
    """Sahkan booking_number wujud DAN milik customer yang sedang login.
    Pulang dict {name, customer, trip_package, trip_date, status}, atau
    throw PermissionError. Dipanggil di SETIAP endpoint dalam modul ni
    sebelum apa-apa operasi — jangan percaya booking_number dari client
    tanpa verify ownership.
    """
    customer_name = _get_customer()
    booking = frappe.db.get_value(
        "Booking", {"booking_number": booking_number},
        ["name", "customer", "trip_package", "trip_date", "status", "affiliate"], as_dict=True
    )
    if not booking or booking.customer != customer_name:
        frappe.throw("Booking not found.", frappe.PermissionError)
    if booking.status == "Cancelled":
        frappe.throw("This booking has been cancelled.")
    return booking


# ══════════════════════════════════════════════
# GET AVAILABLE ADDONS (katalog untuk portal)
# ══════════════════════════════════════════════

@frappe.whitelist()
def get_available_addons(booking_number: str):
    """Senarai Trip Addon (produk) dengan Trip Addon Package sebagai variant.
    Setiap addon boleh ada beberapa package (plan type, pricing, scoping berbeza).
    Hanya package yang applicable untuk booking ni yang di-return.

    Checkout_addons() re-price semula dari DB — jangan percaya harga dari client.
    """
    booking = _get_owned_booking(booking_number)

    departure_date = None
    if booking.trip_date:
        departure_date = frappe.db.get_value("Trip Group Date", booking.trip_date, "departure_date")

    rows = frappe.db.sql("""
        SELECT DISTINCT
            ap.name, ap.addon, ap.addon_title, ap.addon_package_name, ap.plan_type,
            ap.currency, ap.unit_price,
            ap.sales_cutoff_enabled, ap.sales_cutoff_days_before_departure,
            ap.max_qty_per_booking, ap.max_total_qty, ap.current_qty_sold,
            ap.applicable_to, ap.scope,
            a.addon_type, a.description, a.cover_image, a.youtube_video_url
        FROM `tabTrip Addon Package` ap
        JOIN `tabTrip Addon` a ON a.name = ap.addon
        WHERE ap.status = 'Active' AND a.disable = 0
        ORDER BY a.addon_type, a.addon_title, ap.plan_type
    """, as_dict=True)

    today = frappe.utils.getdate()

    # Build package dicts, grouped by parent Trip Addon
    addon_map = {}   # {addon_name: {addon-level fields, packages: [...]}}

    for r in rows:
        # Check scoping
        is_applicable = False
        try:
            ap_doc = frappe.get_doc("Trip Addon Package", r.name)
            is_applicable = ap_doc.is_applicable_for_trip_package(
                trip_package_name=booking.trip_package,
                group_date_name=booking.trip_date
            )
        except Exception:
            if r.applicable_to == "All Trips" or not r.applicable_to:
                is_applicable = True
            else:
                scopings = frappe.get_all("Trip Scoping", {"parent": r.name}, ["trip_package"], limit=1)
                if scopings:
                    is_applicable = True

        if not is_applicable:
            continue

        sold_out = bool(r.max_total_qty and r.current_qty_sold >= r.max_total_qty)
        cutoff_closed = False
        if r.sales_cutoff_enabled and departure_date:
            days_left = frappe.utils.date_diff(departure_date, today)
            cutoff_closed = days_left < (r.sales_cutoff_days_before_departure or 0)

        remaining = None
        if r.max_total_qty:
            remaining = max(0, r.max_total_qty - (r.current_qty_sold or 0))

        pkg = {
            "addon_package":      r.name,
            "addon_package_name": r.addon_package_name or "",
            "plan_type":           r.plan_type or "",
            "scope":               r.scope,
            "applicable_to":       r.applicable_to,
            "currency":            r.currency,
            "unit_price":          float(r.unit_price or 0),
            "max_qty_per_booking": r.max_qty_per_booking or 0,
            "remaining":           remaining,
            "sold_out":            sold_out,
            "cutoff_closed":       cutoff_closed,
            "purchasable":         not sold_out and not cutoff_closed,
        }

        # Group by parent Trip Addon
        if r.addon not in addon_map:
            addon_map[r.addon] = {
                "addon":            r.addon,
                "addon_title":       r.addon_title,
                "addon_type":        r.addon_type or "Other",
                "description":       r.description or "",
                "cover_image":       r.cover_image or "",
                "youtube_video_url": r.youtube_video_url or "",
                "gallery_images":    [],
                "packages":          [],
            }
        addon_map[r.addon]["packages"].append(pkg)

    # Batch-fetch gallery images from tabFile (addon_gallery is a virtual field;
    # images live in tabFile with attached_to_field='addon_gallery', is_private=0)
    addon_names = list(addon_map.keys())
    if addon_names:
        gallery_rows = frappe.db.sql("""
            SELECT attached_to_name, file_url
            FROM tabFile
            WHERE attached_to_doctype = 'Trip Addon'
              AND attached_to_field = 'addon_gallery'
              AND is_private = 0
              AND attached_to_name IN %s
            ORDER BY creation ASC
        """, (tuple(addon_names),), as_dict=True)
        for gr in gallery_rows:
            if gr.attached_to_name in addon_map:
                addon_map[gr.attached_to_name]["gallery_images"].append(gr.file_url)

    # Convert to list, sorted by addon_type then title
    out = sorted(addon_map.values(), key=lambda x: (x["addon_type"], x["addon_title"]))
    return out


# ══════════════════════════════════════════════
# CHECKOUT (cart -> 1 Sales Order addon)
# ══════════════════════════════════════════════

@frappe.whitelist()
def checkout_addons(booking_number: str, lines: str, payment_method: str = "Online Payment",
                    receipt: str = None, bank_transfer_ref: str = None):
    """lines = JSON list [{"addon_package": "AP-xxx", "qty": 2,
    "travellers": ["BR-xxx", ...]}, ...].

    Server-side re-price SEMUA baris dari DB (jangan sesekali percaya rate
    dari client). Travellers array wajib untuk Per Pax scope — server
    re-derive qty dari len(travellers) untuk Per Pax.

    Per Pax: setiap traveller = 1 SO line (qty=1) + 1 Booking Addon Item row
    dengan booking_reservation diset.
    Per Booking: 1 SO line (qty=N) + 1 Booking Addon Item row tanpa reservation.

    Selepas cipta SO + Booking Addon, redirect ke billing page.
    """
    booking = _get_owned_booking(booking_number)

    if isinstance(lines, str):
        lines = json.loads(lines)
    if not lines:
        frappe.throw("Please select at least one item.")

    validated_lines = []
    departure_date = None
    if booking.trip_date:
        departure_date = frappe.db.get_value("Trip Group Date", booking.trip_date, "departure_date")
    today = frappe.utils.getdate()

    for line in lines:
        ap_name = line.get("addon_package")
        travellers = line.get("travellers") or []
        if not ap_name:
            continue

        ap = frappe.db.get_value(
            "Trip Addon Package", ap_name,
            ["name", "addon", "addon_title", "addon_package_name", "scope",
             "applicable_to", "status", "currency", "unit_price",
             "sales_cutoff_enabled", "sales_cutoff_days_before_departure",
             "max_qty_per_booking", "max_total_qty", "current_qty_sold"],
            as_dict=True
        )
        if not ap or ap.status != "Active":
            frappe.throw("One of the selected items is no longer available.")

        scope = ap.scope or "Per Booking"
        # Per Pax: server re-derives qty from traveller count (don't trust client)
        if scope == "Per Pax":
            qty = len(travellers)
            if qty == 0:
                frappe.throw("Please select at least one traveller for " + ap.addon_title + ".")
        else:
            qty = int(line.get("qty", 0))
            if qty <= 0:
                continue

        # Scoping check (same pattern as get_available_addons)
        is_applicable = False
        try:
            ap_doc = frappe.get_doc("Trip Addon Package", ap.name)
            is_applicable = ap_doc.is_applicable_for_trip_package(
                trip_package_name=booking.trip_package,
                group_date_name=booking.trip_date
            )
        except Exception:
            if ap.applicable_to == "All Trips" or not ap.applicable_to:
                is_applicable = True
            else:
                scopings = frappe.get_all("Trip Scoping", {"parent": ap.name}, ["trip_package"], limit=1)
                if scopings:
                    is_applicable = True
        if not is_applicable:
            frappe.throw("One of the selected items is not valid for this booking.")

        if ap.sales_cutoff_enabled and departure_date:
            days_left = frappe.utils.date_diff(departure_date, today)
            if days_left < (ap.sales_cutoff_days_before_departure or 0):
                frappe.throw(ap.addon_title + " is no longer available for purchase (sales closed).")

        if ap.max_qty_per_booking:
            existing = frappe.db.sql("""
                SELECT COALESCE(SUM(qty), 0)
                FROM `tabBooking Addon Item`
                WHERE addon_package = %s AND booking = %s AND status != 'Cancelled'
            """, (ap.name, booking.name))[0][0]
            if (existing + qty) > ap.max_qty_per_booking:
                frappe.throw(
                    "You can only purchase up to " + str(ap.max_qty_per_booking) +
                    " of " + ap.addon_title + " per booking."
                )

        if ap.max_total_qty and (ap.current_qty_sold or 0) + qty > ap.max_total_qty:
            frappe.throw(ap.addon_title + " has reached its maximum quantity available.")

        validated_lines.append({
            "addon_package":      ap.name,
            "addon":              ap.addon,
            "addon_title":        ap.addon_title,
            "addon_package_name": ap.addon_package_name or "",
            "scope":              scope,
            "currency":           ap.currency or "MYR",
            "unit_price":         float(ap.unit_price or 0),
            "qty":                qty,
            "travellers":         travellers,
        })

    if not validated_lines:
        frappe.throw("Please select at least one item.")

    currencies = {l["currency"] for l in validated_lines}
    if len(currencies) > 1:
        frappe.throw("Selected items have mismatched currencies. Please contact support.")
    so_currency = currencies.pop()

    grand_total = sum(l["unit_price"] * l["qty"] for l in validated_lines)
    so_currency, conversion_rate = _resolve_so_currency_and_rate(so_currency)

    # Batch-resolve traveller display names from Booking Reservation
    all_traveller_names = set()
    for l in validated_lines:
        all_traveller_names.update(l["travellers"])
    traveller_map = {}
    if all_traveller_names:
        rows = frappe.db.sql("""
            SELECT name, traveller_full_name, guest_label
            FROM `tabBooking Reservation`
            WHERE name IN %s
        """, (tuple(all_traveller_names),), as_dict=True)
        for r in rows:
            traveller_map[r.name] = r.traveller_full_name or r.guest_label or "Guest"

    # Ensure the ERPNext Item exists
    item_code = _get_or_create_travel_item(
        item_code=ADDON_PACKAGE_ITEM_CODE,
        item_name="Trip Addon Package",
    )

    # Attribute the addon sale to the booking's affiliate Sales Partner
    # when the affiliate app's Affiliate Settings.commission_on_addons is
    # enabled. The SO's sales_partner then triggers the affiliate app's
    # Sales Order.on_update hook (create_commission_if_eligible) so the
    # affiliate earns commission on addon sales too - not just the
    # primary package SO. When disabled, addons stay unattributed.
    addon_sales_partner = None
    if booking.affiliate:
        try:
            if frappe.db.get_single_value(
                "Affiliate Settings", "commission_on_addons"
            ):
                addon_sales_partner = booking.affiliate
        except Exception:
            # Affiliate app not installed / Settings missing - skip
            # attribution silently rather than block the addon checkout.
            pass

    _original_user = frappe.local.session.user
    frappe.local.session.user = "Administrator"
    try:
        # Build SO items (scope-aware)
        so_items = []
        for l in validated_lines:
            price_str = l["currency"] + " " + str(l["unit_price"])
            pkg_label = (l["addon_package_name"] + " (" + price_str + ")") if l["addon_package_name"] else price_str

            if l["scope"] == "Per Pax":
                for tr_name in l["travellers"]:
                    tname = traveller_map.get(tr_name, "Unknown")
                    so_items.append({
                        "item_code":   item_code,
                        "item_name":   "Trip Addon Package",
                        "qty":         1,
                        "rate":        l["unit_price"],
                        "uom":         "Nos",
                        "description": l["addon_title"] + " | " + pkg_label + " | Traveller: " + tname,
                    })
            else:
                traveller_list = ""
                if l["travellers"]:
                    named = [traveller_map.get(t, "Unknown") for t in l["travellers"]]
                    traveller_list = " | Travellers: " + ", ".join(named)
                so_items.append({
                    "item_code":   item_code,
                    "item_name":   "Trip Addon Package",
                    "qty":         l["qty"],
                    "rate":        l["unit_price"],
                    "uom":         "Nos",
                    "description": l["addon_title"] + " | " + pkg_label + traveller_list,
                })

        # Create Booking Addon (header) BEFORE the Sales Order so the SO
        # can carry custom_booking_addon as a reverse link. sales_order is
        # set after SO submit via db_set.
        order = frappe.get_doc({
            "doctype":      "Booking Addon",
            "booking":      booking.name,
            "status":       "Pending",
            "currency":     so_currency,
            "total_amount": grand_total,
        })
        order.insert(ignore_permissions=True)

        so = frappe.get_doc({
            "doctype":               "Sales Order",
            "customer":              booking.customer,
            "custom_booking":        booking.name,
            "custom_booking_addon":  order.name,
            "transaction_date":      frappe.utils.today(),
            "delivery_date":         frappe.utils.today(),
            "order_type":            "Sales",
            "items":                 so_items,
            "selling_price_list":    "Standard Selling",
            "currency":              so_currency,
            "conversion_rate":       conversion_rate,
            "disable_rounded_total": 1,
            "sales_partner":         addon_sales_partner,
        })
        so.insert(ignore_permissions=True)
        so.flags.ignore_permissions = True
        so.submit()

        # Reverse link: set sales_order on the header after SO is submitted.
        order.db_set("sales_order", so.name)

        # Create Booking Addon Item rows (scope-aware)
        for l in validated_lines:
            if l["scope"] == "Per Pax":
                for tr_name in l["travellers"]:
                    frappe.get_doc({
                        "doctype":             "Booking Addon Item",
                        "addon_order":         order.name,
                        "addon_package":       l["addon_package"],
                        "booking_reservation": tr_name,
                        "qty":                 1,
                        "currency":            l["currency"],
                        "unit_price":          l["unit_price"],
                        "amount":              l["unit_price"],
                        "status":              "Pending",
                    }).insert(ignore_permissions=True)
            else:
                frappe.get_doc({
                    "doctype":       "Booking Addon Item",
                    "addon_order":   order.name,
                    "addon_package": l["addon_package"],
                    "qty":           l["qty"],
                    "currency":      l["currency"],
                    "unit_price":    l["unit_price"],
                    "amount":        l["unit_price"] * l["qty"],
                    "status":        "Pending",
                }).insert(ignore_permissions=True)

        # Increment current_qty_sold on each Trip Addon Package
        for l in validated_lines:
            new_sold = (frappe.db.get_value("Trip Addon Package", l["addon_package"], "current_qty_sold") or 0) + l["qty"]
            frappe.db.set_value("Trip Addon Package", l["addon_package"], "current_qty_sold", new_sold)

        frappe.db.commit()
    finally:
        frappe.local.session.user = _original_user

    return {
        "success":      True,
        "addon_order":   order.name,
        "sales_order":   so.name,
        "grand_total":   grand_total,
        "currency":      so_currency,
        "billing_url":   "/traveller/billing?ref=" + booking_number,
    }


# ══════════════════════════════════════════════
# GET BOOKING ADDONS (sejarah pembelian — portal)
# ══════════════════════════════════════════════

@frappe.whitelist()
def get_booking_addons(booking_number: str):
    """Senarai Booking Addon + baris untuk booking ni — untuk
    paparan "apa yang saya dah beli" di portal (Manage Add-on page).

    Setiap baris (Booking Addon Item) membawa medan pengepal
    ternormalisasi (order_status, order_payment_status, dll) supaya
    boleh di-group by addon_package / traveller tanpa kehilangan info
    order asal.
    """
    booking = _get_owned_booking(booking_number)

    orders = frappe.get_all(
        "Booking Addon",
        filters={"booking": booking.name},
        fields=["name", "status", "payment_status", "currency", "total_amount",
                "sales_order", "order_date"],
        order_by="order_date desc",
    )

    # Batch-fetch addon_package_name for all lines across all orders
    all_pkg_names = set()
    for o in orders:
        o["lines"] = frappe.get_all(
            "Booking Addon Item",
            filters={"addon_order": o.name},
            fields=["name", "addon_title", "addon_package", "addon",
                    "booking_reservation", "traveller_name", "scope",
                    "qty", "unit_price", "amount", "currency",
                    "status", "valid_from", "valid_to"],
            order_by="creation asc",
        )
        for l in o["lines"]:
            if l.get("addon_package"):
                all_pkg_names.add(l["addon_package"])

    pkg_name_map = {}
    if all_pkg_names:
        for name, pkg_name in frappe.db.sql(
            "SELECT name, addon_package_name FROM `tabTrip Addon Package` WHERE name IN %s",
            (tuple(all_pkg_names),), as_list=True
        ):
            pkg_name_map[name] = pkg_name

    # Denormalize header fields onto each line for grouping views
    for o in orders:
        for l in o["lines"]:
            l["order_name"] = o["name"]
            l["order_status"] = o["status"]
            l["order_payment_status"] = o["payment_status"]
            l["order_total"] = o["total_amount"]
            l["order_currency"] = o["currency"]
            l["sales_order"] = o.get("sales_order")
            l["order_date"] = o.get("order_date")
            l["addon_package_name"] = pkg_name_map.get(l.get("addon_package"), "")

    return orders