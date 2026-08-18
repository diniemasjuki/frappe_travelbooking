# travel_booking/api/addon_manager.py
#
# Portal endpoints untuk upsell addon/insurance selepas booking confirmed:
#   - get_available_addons(booking_number) — katalog Addon Package yang
#     layak untuk booking ni (scoped ikut trip_package), dengan status
#     stok/cutoff untuk paparan portal.
#   - checkout_addons(booking_number, lines, payment_method, ...) — cart
#     checkout: re-price server-side, cipta SATU Sales Order addon +
#     Booking Addon Order (header) + Booking Addon (baris), route ke
#     pembayaran (Stripe/Manual Transfer, reuse infrastruktur sedia ada).
#
# Ownership booking disahkan setiap panggilan melalui _get_customer()
# (portal_booking.py) — customer HANYA boleh checkout addon untuk booking
# dia sendiri, tak kira apa booking_number dihantar.

import frappe
import json

from travel_booking.api.portal_booking import _get_customer
from travel_booking.api.constants import ADDON_ITEM_CODE, INSURANCE_ITEM_CODE
from travel_booking.api.so_helpers import (
    _get_or_create_travel_item,
    _resolve_so_currency_and_rate,
    _create_manual_payment_entry,
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
        ["name", "customer", "trip_package", "trip_date", "status"], as_dict=True
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
    """Senarai Addon Package yang di-scope untuk trip_package booking ni,
    dengan status stok/cutoff untuk paparan portal (bukan untuk pricing
    autoritatif — checkout_addons() re-price semula dari DB, jangan
    percaya harga yang dipaparkan di sini balik dari client).
    """
    booking = _get_owned_booking(booking_number)

    departure_date = None
    if booking.trip_date:
        departure_date = frappe.db.get_value("Trip Group Date", booking.trip_date, "departure_date")

    rows = frappe.db.sql("""
        SELECT
            ap.name, ap.addon, ap.addon_title, ap.plan_type,
            ap.currency, ap.unit_price,
            ap.sales_cutoff_enabled, ap.sales_cutoff_days_before_departure,
            ap.max_qty_per_booking, ap.max_total_qty, ap.current_qty_sold,
            a.addon_type, a.description, a.cover_image, a.scope
        FROM `tabAddon Package` ap
        JOIN `tabAddon` a ON a.name = ap.addon
        WHERE ap.trip_package = %s AND ap.status = 'Active' AND a.disable = 0
        ORDER BY a.addon_type, ap.addon_title, ap.plan_type
    """, booking.trip_package, as_dict=True)

    today = frappe.utils.getdate()
    out = []
    for r in rows:
        sold_out = bool(r.max_total_qty and r.current_qty_sold >= r.max_total_qty)
        cutoff_closed = False
        if r.sales_cutoff_enabled and departure_date:
            days_left = frappe.utils.date_diff(departure_date, today)
            cutoff_closed = days_left < (r.sales_cutoff_days_before_departure or 0)

        remaining = None
        if r.max_total_qty:
            remaining = max(0, r.max_total_qty - (r.current_qty_sold or 0))

        out.append({
            "addon_package":      r.name,
            "addon":               r.addon,
            "addon_title":         r.addon_title,
            "addon_type":          r.addon_type,
            "plan_type":           r.plan_type or "",
            "description":         r.description or "",
            "cover_image":         r.cover_image or "",
            "scope":               r.scope,
            "currency":            r.currency,
            "unit_price":          float(r.unit_price or 0),
            "max_qty_per_booking": r.max_qty_per_booking or 0,
            "remaining":           remaining,
            "sold_out":            sold_out,
            "cutoff_closed":       cutoff_closed,
            "purchasable":         not sold_out and not cutoff_closed,
        })

    return out


# ══════════════════════════════════════════════
# CHECKOUT (cart -> 1 Sales Order addon)
# ══════════════════════════════════════════════

@frappe.whitelist()
def checkout_addons(booking_number: str, lines: str, payment_method: str = "Online Payment",
                    receipt: str = None, bank_transfer_ref: str = None):
    """lines = JSON list [{"addon_package": "AP-xxx", "qty": 2}, ...].

    Server-side re-price SEMUA baris dari DB (jangan sesekali percaya rate
    dari client) — sama prinsip dengan _validate_selection_capacity() di
    pricing.py untuk wizard booking utama.
    """
    booking = _get_owned_booking(booking_number)

    if isinstance(lines, str):
        lines = json.loads(lines)
    if not lines:
        frappe.throw("Please select at least one item.")

    bank_transfer_ref = (bank_transfer_ref or "").strip()
    if payment_method == "Manual Transfer" and not bank_transfer_ref:
        frappe.throw("Please enter your bank transfer reference number.")

    validated_lines = []
    departure_date = None
    if booking.trip_date:
        departure_date = frappe.db.get_value("Trip Group Date", booking.trip_date, "departure_date")
    today = frappe.utils.getdate()

    for line in lines:
        ap_name = line.get("addon_package")
        qty = int(line.get("qty", 0))
        if not ap_name or qty <= 0:
            continue

        ap = frappe.db.get_value(
            "Addon Package", ap_name,
            ["name", "addon", "addon_title", "trip_package", "status", "currency", "unit_price",
             "sales_cutoff_enabled", "sales_cutoff_days_before_departure",
             "max_qty_per_booking", "max_total_qty", "current_qty_sold"],
            as_dict=True
        )
        if not ap or ap.status != "Active":
            frappe.throw("One of the selected items is no longer available.")
        if ap.trip_package != booking.trip_package:
            frappe.throw("One of the selected items is not valid for this booking's package.")

        if ap.sales_cutoff_enabled and departure_date:
            days_left = frappe.utils.date_diff(departure_date, today)
            if days_left < (ap.sales_cutoff_days_before_departure or 0):
                frappe.throw(ap.addon_title + " is no longer available for purchase (sales closed).")

        if ap.max_qty_per_booking:
            existing = frappe.db.sql("""
                SELECT COALESCE(SUM(qty), 0)
                FROM `tabBooking Addon`
                WHERE addon_package = %s AND booking = %s AND status != 'Cancelled'
            """, (ap.name, booking.name))[0][0]
            if (existing + qty) > ap.max_qty_per_booking:
                frappe.throw(
                    "You can only purchase up to " + str(ap.max_qty_per_booking) +
                    " of " + ap.addon_title + " per booking."
                )

        if ap.max_total_qty and (ap.current_qty_sold or 0) + qty > ap.max_total_qty:
            frappe.throw(ap.addon_title + " has reached its maximum quantity available.")

        addon_type = frappe.db.get_value("Addon", ap.addon, "addon_type")
        validated_lines.append({
            "addon_package": ap.name,
            "addon_title":   ap.addon_title,
            "addon_type":    addon_type,
            "currency":      ap.currency or "MYR",
            "unit_price":    float(ap.unit_price or 0),
            "qty":           qty,
        })

    if not validated_lines:
        frappe.throw("Please select at least one item.")

    currencies = {l["currency"] for l in validated_lines}
    if len(currencies) > 1:
        frappe.throw("Selected items have mismatched currencies. Please contact support.")
    so_currency = currencies.pop()

    grand_total = sum(l["unit_price"] * l["qty"] for l in validated_lines)

    so_currency, conversion_rate = _resolve_so_currency_and_rate(so_currency)

    _original_user = frappe.session.user
    frappe.set_user("Administrator")
    try:
        so_items = []
        for l in validated_lines:
            item_code = INSURANCE_ITEM_CODE if l["addon_type"] == "Insurance" else ADDON_ITEM_CODE
            item_code = _get_or_create_travel_item(
                item_code=item_code,
                item_name="Travel Insurance" if item_code == INSURANCE_ITEM_CODE else "Travel Addon",
            )
            so_items.append({
                "item_code":   item_code,
                "item_name":   l["addon_title"],
                "qty":         l["qty"],
                "rate":        l["unit_price"],
                "uom":         "Nos",
                "description": l["addon_title"] + " | Booking: " + booking.name,
            })

        so = frappe.get_doc({
            "doctype":               "Sales Order",
            "customer":              booking.customer,
            "custom_booking":        booking.name,
            "transaction_date":      frappe.utils.today(),
            "delivery_date":         frappe.utils.today(),
            "order_type":            "Sales",
            "items":                 so_items,
            "selling_price_list":    "Standard Selling",
            "currency":              so_currency,
            "conversion_rate":       conversion_rate,
            "disable_rounded_total": 1,
        })
        so.insert(ignore_permissions=True)
        so.flags.ignore_permissions = True
        so.submit()

        order = frappe.get_doc({
            "doctype":     "Booking Addon Order",
            "booking":     booking.name,
            "status":      "Pending",
            "payment_status": "Pending",
            "currency":    so_currency,
            "sales_order": so.name,
        })
        order.insert(ignore_permissions=True)

        for l in validated_lines:
            frappe.get_doc({
                "doctype":        "Booking Addon",
                "addon_order":    order.name,
                "booking":        booking.name,
                "customer":       booking.customer,
                "trip_package":   booking.trip_package,
                "trip_date":      booking.trip_date,
                "departure_date": departure_date,
                "addon_package":  l["addon_package"],
                "qty":            l["qty"],
                "status":         "Pending",
            }).insert(ignore_permissions=True)

        frappe.db.commit()
    finally:
        frappe.set_user(_original_user)

    payment_url = ""
    if payment_method == "Online Payment":
        # BUG FIX (rujuk laporan): _create_payment_url() (so_helpers.py) hardcode
        # source="wizard" — direka HANYA untuk confirm_booking() punya flow wizard
        # (checkout.js returnUrl() akan redirect ke /booking?...&step=confirm bila
        # source="wizard", tak kira apa return_to dihantar). Guna itu di sini
        # menyebabkan customer redirect BALIK KE WIZARD BOOKING lepas bayar addon,
        # bukan balik ke portal Add-ons — jadi panggil create_payment_intent()
        # TERUS dengan source="portal" + return_to eksplisit ke page ni sendiri.
        from travel_booking.api.stripe_checkout import create_payment_intent
        try:
            result = create_payment_intent(
                sales_order    = so.name,
                amount         = grand_total,
                source         = "portal",
                booking_number = booking_number,
                return_to      = "/traveller_portal/booking_addons?ref=" + booking_number,
            )
            payment_url = result.get("checkout_url", "")
        except Exception as e:
            frappe.log_error("Addon payment checkout creation failed: " + str(e), "Addon Payment URL Error")
    elif payment_method == "Manual Transfer":
        _create_manual_payment_entry(
            so_name       = so.name,
            customer_name = booking.customer,
            amount        = grand_total,
            receipt_data  = receipt,
            label         = "addon-" + order.name,
            bank_transfer_ref = bank_transfer_ref,
        )

    return {
        "success":       True,
        "addon_order":   order.name,
        "sales_order":   so.name,
        "grand_total":   grand_total,
        "currency":      so_currency,
        "payment_method": payment_method,
        "payment_url":   payment_url,
    }


# ══════════════════════════════════════════════
# GET BOOKING ADDONS (sejarah pembelian — portal)
# ══════════════════════════════════════════════

@frappe.whitelist()
def get_booking_addons(booking_number: str):
    """Senarai Booking Addon Order + baris untuk booking ni — untuk
    paparan "apa yang saya dah beli" di portal.
    """
    booking = _get_owned_booking(booking_number)

    orders = frappe.get_all(
        "Booking Addon Order",
        filters={"booking": booking.name},
        fields=["name", "status", "payment_status", "currency", "total_amount",
                "sales_order", "order_date"],
        order_by="order_date desc",
    )
    for o in orders:
        o["lines"] = frappe.get_all(
            "Booking Addon",
            filters={"addon_order": o.name},
            fields=["name", "addon_title", "qty", "unit_price", "amount",
                    "status", "valid_from", "valid_to"],
            order_by="creation asc",
        )
    return orders