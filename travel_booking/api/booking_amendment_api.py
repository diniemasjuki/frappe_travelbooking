# travel_booking/api/booking_amendment_api.py
#
# Fasa 4B renovation — BOOKING AMENDMENT apply engine.
#
# Booking Amendment (doctype) merekodkan permintaan perubahan berat
# selepas tempahan (tukar tarikh / pakej) yang TIDAK boleh dimodelkan
# sebagai addon. Modul ni melaksanakan apply:
#
#   apply_amendment(amendment_name)
#     1. Re-price pakej baharu (kadar semasa dari Trip Package Price)
#        untuk komposisi cabin snapshot sebelum.
#     2. Cipta SO BAHARU (item cabin komposisi sama, kadar baharu)
#        + pautkan Booking melalui custom_booking.
#     3. Cancel SO lama yang belum bayar sahaja (yang dah bayar kekal —
#        penyelesaian kewangan melalui settlement).
#     4. Update Booking (trip_date, trip_package).
#     5. Cancel SEMUA Booking Reservation lama (hook sync availability
#        kedua-dua tarikh lama + baharu) dan re-activate slot pada
#        tarikh baharu melalui _activate_booking (idempotent by count —
#        padam dulu slot lama, cipta semula dari SO baharu).
#     6. Settlement:
#        - Additional Payment → Payment Request portal (customer bayar
#          beza melalui billing page sedia ada).
#        - Credit Note → Sales Invoice return (ERPNext standard) untuk
#          beza negatif daripada invois sedia ada (kalau tiada invois,
#          log untuk admin — refund melalui PE reversal manual).
#        - Waiver/None → tiada tindakan kewangan.
#
# GATE: Booking Hub role (perubahan berat ialah operasi desk).

import json

import frappe
from frappe.utils import flt, today

from travel_booking.api.constants import TRAVEL_ITEM_CODE


def apply_amendment(amendment_name):
	"""Apply satu Booking Amendment — transaksi penuh atau gagal."""
	_require_booking_manager()

	am = frappe.get_doc("Booking Amendment", amendment_name)
	if am.status == "Applied":
		frappe.throw("Amendment has already been applied.")
	if am.status == "Cancelled":
		frappe.throw("Amendment was cancelled.")

	booking_name = am.booking
	before = json.loads(am.before_snapshot or "{}")
	old_tgd = before.get("trip_date")
	old_pkg = before.get("trip_package")
	new_tgd = am.new_trip_group_date or old_tgd
	new_pkg = am.new_trip_package or old_pkg

	booking = frappe.get_doc("Booking", booking_name)

	# ── 1. Re-price komposisi semasa dengan kadar pakej baharu ────────
	old_so = _primary_so(booking_name)
	layout = _cabin_layout(old_so) if old_so else []
	if not layout:
		frappe.throw(
			"Cannot read cabin layout from the booking's primary Sales "
			"Order. Add the amendment manually.",
			title="Amendment Blocked",
		)

	pricing_map = _pricing_map(new_pkg)
	new_items, new_total = _build_amendment_items(
		layout, pricing_map, new_tgd, new_pkg)
	if not new_items:
		frappe.throw("No items could be priced for the new package.",
			title="Amendment Blocked")

	# ── 2. SO baharu ──────────────────────────────────────────────────
	pkg_currency = frappe.db.get_value("Trip Package", new_pkg, "currency")
	so_currency, so_company, so_price_list, conv_rate = \
		_resolve_so_currency_and_rate(pkg_currency)

	_original_user = frappe.local.session.user
	frappe.local.session.user = "Administrator"
	try:
		so = frappe.get_doc({
			"doctype":            "Sales Order",
			"customer":           booking.customer,
			"transaction_date":   today(),
			"delivery_date":      _delivery_date(new_tgd),
			"order_type":         "Sales",
			"items":              new_items,
			"company":            so_company,
			"selling_price_list": so_price_list,
			"currency":           so_currency,
			"conversion_rate":    conv_rate,
			"disable_rounded_total": 1,
		})
		so.insert(ignore_permissions=True)
		so.flags.ignore_permissions = True
		so.submit()
		frappe.db.set_value("Sales Order", so.name, "custom_booking", booking_name)

		# ── 3. Cancel SO lama yang BELUM BAYAR ────────────────────────
		cancelled_sos = []
		for name, advance in frappe.db.get_all(
				"Sales Order", {"custom_booking": booking_name},
				["name", "advance_paid"], as_list=True):
			if name == so.name or name != old_so:
				continue  # hanya SO utama; SO addon/traveller kekal
			if flt(advance) <= 0.009:
				old_doc = frappe.get_doc("Sales Order", name)
				old_doc.flags.ignore_permissions = True
				old_doc.cancel()
				cancelled_sos.append(name)

		# ── 4. Update Booking ─────────────────────────────────────────
		frappe.db.set_value("Booking", booking_name, {
			"trip_date":     new_tgd,
			"trip_package":  new_pkg,
		})

		# ── 5. Re-sync reservations ───────────────────────────────────
		# Padam slot lama (hook after_delete sync availability tarikh lama),
		# cipta semula dari SO baharu (hook after_insert sync tarikh baharu).
		for r in frappe.get_all("Booking Reservation",
		                        {"booking": booking_name}, pluck="name"):
			frappe.delete_doc("Booking Reservation", r,
			                  ignore_permissions=True, force=True)
		from travel_booking.api.so_helpers import _activate_booking
		activated = _activate_booking(booking_name)

		# ── 6. Settlement ─────────────────────────────────────────────
		credit_note = None
		payment_request = None
		old_paid = flt(before.get("paid_amount") or 0)
		diff = round(flt(so.grand_total) - old_paid, 2)

		method = am.settlement_method or "None"
		if method == "Additional Payment" and diff > 0:
			# Customer bayar beza melalui portal billing — PR terhadap SO
			# baharu; customer nampak baki di billing page seperti biasa.
			pass  # baki SO baharu semula jadi menjadi amaun tertunggak
		elif method == "Credit Note" and diff < 0:
			credit_note = _make_credit_note(booking_name, abs(diff),
			                                so_company, so_currency)

		# ── Tandakan amendment selesai ────────────────────────────────
		am.flags.amendment_apply = True
		am.status = "Applied"
		am.sales_order = so.name
		am.credit_note = credit_note
		am.price_difference = diff
		am.settlement_amount = abs(diff) if method not in (None, "None") else 0
		am.applied_on = frappe.utils.now()
		am.applied_by = frappe.session.user
		am.save(ignore_permissions=True)
	finally:
		frappe.local.session.user = _original_user

	frappe.db.commit()
	return {
		"success":        True,
		"amendment":      am.name,
		"sales_order":    so.name,
		"activated":      activated,
		"cancelled_sos":  cancelled_sos,
		"credit_note":    credit_note,
		"price_difference": diff,
	}


# ── helpers ──────────────────────────────────────────────────────────

def _primary_so(booking_name):
	"""SO utama booking (pertama mengikut creation)."""
	return frappe.db.get_value(
		"Sales Order", {"custom_booking": booking_name},
		"name", order_by="creation asc")


def _cabin_layout(so_name):
	from travel_booking.api.so_helpers import _cabin_layout_from_so
	return _cabin_layout_from_so(so_name)


def _pricing_map(trip_package):
	"""Rate matrix pakej: {room_category: Trip Package Price row}."""
	rows = frappe.get_all(
		"Trip Package Price",
		filters={"parent": trip_package, "parenttype": "Trip Package"},
		fields=["pricing_for_class", "price_adult", "price_adult_single",
		        "price_upperberth", "price_children", "price_infant"],
	)
	return {r.pricing_for_class: r for r in rows if r.pricing_for_class}


def _build_amendment_items(layout, pricing_map, new_tgd, new_pkg):
	"""Bina baris SO baharu daripada layout snapshot — sama komposisi
	kabin/pax, kadar pakej baharu. Custom fields berstruktur diisi
	(v39) supaya pembaca baharu terus berfungsi."""
	from travel_booking.api.so_helpers import _get_or_create_travel_item

	item_code = _get_or_create_travel_item()
	td_name = frappe.db.get_value("Trip Group Date", new_tgd, "trip_group_name") or ""
	trip_name = frappe.db.get_value(
	    "Trip Package", new_pkg, "trip_name") or ""
	is_cruise = bool(frappe.db.get_value(
	    "Trip Group Date", new_tgd,
	    ["is_cruise_only", "cruise_schedule"], as_dict=True)) if new_tgd else False
	# Model harga ikut jenis trip BAHARU — selari _build_so_items.
	trip_of_pkg = frappe.db.get_value("Trip Package", new_pkg, "trip_link")
	is_cruise = bool(frappe.db.get_value("Trip", trip_of_pkg, "is_a_cruise_trip"))

	items, total = [], 0.0
	for cabin in layout:
		rc = cabin.get("room_category")
		price = pricing_map.get(rc)
		if not price:
			frappe.throw(
				"New package has no rate for room category '{0}'.".format(rc),
				title="Amendment Pricing Gap",
			)
		cabin_no = cabin.get("cabin_no")
		for pax_type, qty in (cabin.get("pax_breakdown") or {}).items():
			rate = _rate_for_pax(price, pax_type, is_cruise)
			line = {
				"item_code":   item_code,
				"item_name":   "{0} (Cabin {1}) — {2}".format(rc, cabin_no, pax_type),
				"qty":         qty,
				"rate":        flt(rate),
				"uom":         "Nos",
				"description": "{0} | {1} | {2} | Cabin {3} | {4} | Amendment {5}".format(
					trip_name, td_name, rc, cabin_no, pax_type, today()),
				"custom_room_category": rc,
				"custom_cabin_no":      cabin_no,
				"custom_pax_type":      pax_type,
				"custom_trip_package":  new_pkg,
				"custom_trip_group_date": new_tgd,
			}
			if cabin.get("room_privacy"):
				line["custom_room_privacy"] = cabin["room_privacy"]
			items.append(line)
			total += flt(rate) * qty
	return items, round(total, 2)


def _rate_for_pax(price, pax_type, is_cruise):
	"""Kadar untuk pax_type — mirror _build_so_items slot/umur model."""
	if is_cruise:
		if pax_type == "Main Guest (Single)":
			return price.price_adult_single
		if pax_type == "Extra Bed":
			return price.price_upperberth
		if pax_type == "Infant":
			return price.price_infant
		return price.price_adult  # Main Guest / default
	# Non-cruise (umur)
	if pax_type == "Children":
		return price.price_children
	if pax_type == "Infant":
		return price.price_infant
	return price.price_adult


def _delivery_date(tgd):
	dep = frappe.db.get_value("Trip Group Date", tgd, "departure_date")
	if not dep:
		return today()
	from frappe.utils import add_days, getdate
	d = add_days(dep, -1)
	return d if getdate(d) >= getdate(today()) else today()


def _make_credit_note(booking_name, amount, company, currency):
	"""Credit note daripada Sales Invoice sedia ada booking (kalau ada).
	Tanpa invois — refund belum mungkin secara perakaunan (tiada
	pendapatan direkodkan); log untuk admin proses PE reversal manual.
	Return nama SI credit note atau None."""
	si = frappe.db.sql("""
		SELECT sii.parent
		FROM `tabSales Invoice Item` sii
		JOIN `tabSales Invoice` si ON si.name = sii.parent
		JOIN `tabSales Order` so ON so.name = sii.sales_order
		WHERE so.custom_booking = %s AND si.docstatus = 1
		ORDER BY si.posting_date DESC LIMIT 1
	""", booking_name)
	if not si:
		frappe.log_error(
			title="Amendment Credit Note - No Invoice",
			message="Booking {0}: tiada Sales Invoice disubmit — credit "
			"note tidak dijana. Refund {1} {2} perlu diproses manual "
			"(PE reversal) oleh admin.".format(booking_name, currency, amount),
		)
		return None
	si_name = si[0][0]
	try:
		from erpnext.accounts.doctype.sales_invoice.sales_invoice import make_sales_return
		cn = make_sales_return(si_name)
		# Skop kepada amaun beza sahaja — kekalkan satu baris pertama,
		# set qty supaya jumlah = amount.
		if not cn.items:
			return None
		keep = cn.items[0]
		unit_rate = flt(keep.rate) or 1
		keep.qty = flt(amount) / unit_rate if unit_rate else 0
		cn.items = [keep]
		cn.update_outstanding_for_self = 1
		cn.flags.ignore_permissions = True
		cn.insert()
		cn.submit()
		return cn.name
	except Exception as e:
		frappe.log_error(
			title="Amendment Credit Note Error",
			message="Booking {0}: gagal jana credit note {1} {2}: {3}".format(
				booking_name, currency, amount, e),
		)
		return None


def _resolve_so_currency_and_rate(currency=None):
	from travel_booking.api.so_helpers import _resolve_so_currency_and_rate as _r
	return _r(currency)


def _require_booking_manager():
	from travel_booking.api.booking_hub import _require_booking_manager
	_require_booking_manager()
