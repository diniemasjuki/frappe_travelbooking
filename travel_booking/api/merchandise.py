# travel_booking/api/merchandise.py
#
# Fasa 3 renovation — MERCHANDISE & INVENTORY STOK.
#
# Merchandise = ERPNext Item sebenar (is_stock_item=1) + Warehouse —
# selari dengan nature ERPNext: Stock Entry, Delivery Note, reorder,
# barcode, Stock Reservation Entry semua sedia ada.
#
# Modul ni membekalkan tiga keupayaan di atas mesineri standard:
#
#   1. get_stock_warehouse(company) — resolve warehouse stok default
#      untuk company pengeluar SO (fallback abjad Stores).
#
#   2. ensure_merchandise_item(...) — utiliti cipta Item merchandise
#      (stok / service) + Item Price untuk price list currency.
#
#   3. reserve_so_stock(so_name) — pasca-submit SO booking/addon yang
#      mengandungi baris merchandise stok: cipta Stock Reservation
#      Entry melalui API standard ERPNext
#      (SalesOrderStockReservation.create_stock_reservation_entries).
#      Dipanggil dari doc_events Sales Order on_submit (hook sedia ada
#      on_sales_order_change tidak menutup submit path — tambah handler
#      khusus dalam hooks).
#
#   4. create_delivery_notes_for_trip(trip_group_date) — Delivery Note
#      pukal untuk SEMUA booking aktif tarikh tu yang ada baris
#      merchandise stok belum dihantar (mapper standard make_delivery_note).
#
#   5. create_merch_order(...) — jualan merchandise berasingan (public):
#      SO item merchandise sahaja melalui jalur bayaran sedia ada
#      (Stripe Payment Request / manual transfer) — bukan webshop.
#
# TIDAK direka cipta: sebarang GL/stock posting custom — semua melalui
# dokumen standard ERPNext.

import frappe
from frappe.utils import flt

from travel_booking.api.constants import DEFAULT_CURRENCY


# ══════════════════════════════════════════════
# WAREHOUSE RESOLUTION
# ══════════════════════════════════════════════

def get_stock_warehouse(company):
	"""Warehouse stok untuk company pengeluar SO merchandise.

	Prioriti: Travel Settings > Multi Currency Account row yang match
	company (field warehouse jika ditambah kemudian) → fallback
	warehouse 'Stores - <company abbr>' → warehouse leaf pertama
	company tu. Return None kalau company tiada warehouse langsung
	(item merchandise stok perlu warehouse sah sebelum reserve)."""
	if not company:
		return None

	# Fallback utama: Stores standard ERPNext (auto-wujud setiap company)
	abbr = frappe.db.get_value("Company", company, "abbr")
	if abbr:
		stores = "Stores - " + abbr
		if frappe.db.exists("Warehouse", stores):
			return stores

	# Warehouse leaf pertama company (abjad)
	wh = frappe.db.get_value(
		"Warehouse",
		{"company": company, "is_group": 0, "disabled": 0},
		"name", order_by="name asc")
	return wh


# ══════════════════════════════════════════════
# ITEM MERCHANDISE UTILITIES
# ══════════════════════════════════════════════

def ensure_merchandise_item(item_code, item_name=None, is_stock_item=1,
                            item_group="Merchandise", uom="Nos",
                            is_public=False):
	"""Cipta (kalau tiada) Item merchandise. is_stock_item=1 → inventori
	sebenar (Stock Entry / Delivery Note); 0 → service ringkas.
	item_group default 'Merchandise' (kategori item fizikal — patch v41).
	is_public=True → tandakan Item.is_public_merchandise (jualan berasingan
	di laman public); item bundled dalam pakej = False."""
	if frappe.db.exists("Item", item_code):
		return item_code
	doc = frappe.get_doc({
		"doctype":        "Item",
		"item_code":      item_code,
		"item_name":      item_name or item_code,
		"item_group":     item_group,
		"stock_uom":      uom,
		"is_stock_item":  1 if is_stock_item else 0,
		"is_sales_item":  1,
		"grant_commission": 0,   # merchandise bukan komisen affiliate
	})
	# Flag public (custom field patch v41) — hanya set bila field wujud
	# (site yang belum migrate v41).
	if frappe.get_meta("Item").has_field("is_public_merchandise"):
		doc.is_public_merchandise = 1 if is_public else 0
	doc.insert(ignore_permissions=True)
	return item_code


def ensure_item_price(item_code, currency, rate, price_list=None):
	"""Item Price untuk item merchandise dalam price list currency."""
	if not price_list:
		from travel_booking.api.currency_axis import currency_to_price_list
		price_list = currency_to_price_list(currency) or "Standard Selling"
	existing = frappe.db.get_value(
		"Item Price",
		{"item_code": item_code, "price_list": price_list, "selling": 1},
		"name")
	if existing:
		frappe.db.set_value("Item Price", existing, "price_list_rate", flt(rate))
		return existing
	frappe.get_doc({
		"doctype":       "Item Price",
		"item_code":     item_code,
		"price_list":    price_list,
		"selling":       1,
		"price_list_rate": flt(rate),
		"currency":      currency,
	}).insert(ignore_permissions=True)
	return None


# ══════════════════════════════════════════════
# STOCK RESERVATION (pasca SO submit)
# ══════════════════════════════════════════════

def _so_stock_items(so_name):
	"""Baris SO yang menjual item merchandise STOK (is_stock_item=1) —
	candidate untuk reserve."""
	return frappe.db.sql("""
		SELECT soi.name, soi.item_code, soi.warehouse, soi.qty
		FROM `tabSales Order Item` soi
		JOIN `tabItem` i ON i.name = soi.item_code
		WHERE soi.parent = %s AND soi.parenttype = 'Sales Order'
		  AND i.is_stock_item = 1
	""", so_name, as_dict=True)


def reserve_so_stock(so_name):
	"""Cipta Stock Reservation Entry untuk baris merchandise stok SO.

	Dipanggil dari doc_events Sales Order on_submit (hooks) — Frappe
	hantar OBJEK dokumen untuk hook; caller manual (create_merch_order)
	hantar string nama. Kedua-dua bentuk diterima.

	Selamat dipanggil berulang — ERPNext skip baris yang sudah direserve
	penuh (has_unreserved_stock). SO tanpa baris stok → no-op senyap.
	Kegagalan di-log, TIDAK throw — bayaran/booking tak pernah
	tergantung kerana isu stok (corak error isolation app)."""
	# doc_events hantar objek Document; caller lain hantar string name.
	if hasattr(so_name, "doctype") and hasattr(so_name, "name"):
		so = frappe._dict({
			"name":      so_name.name,
			"docstatus": so_name.docstatus,
			"company":   so_name.company,
		})
	else:
		so = frappe.db.get_value(
			"Sales Order", so_name, ["name", "docstatus", "company"], as_dict=True)
	if not so or so.docstatus != 1:
		return {"reserved": 0, "skipped": "not-submitted"}

	items = _so_stock_items(so_name)
	if not items:
		return {"reserved": 0, "skipped": "no-stock-items"}

	warehouse = get_stock_warehouse(so.company)
	if not warehouse:
		frappe.log_error(
			title="Merchandise Reserve - No Warehouse",
			message="Company {0} tidak mempunyai warehouse stok — baris "
			"merchandise SO {1} tidak direserve.".format(so.company, so_name),
		)
		return {"reserved": 0, "skipped": "no-warehouse"}

	try:
		so_doc = frappe.get_doc("Sales Order", so_name)
		# Flag reserve_stock pada baris stok — ERPNext skip baris tanpa
		# flag ni dalam create_stock_reservation_entries (SO Item field
		# standard v15+; db_set supaya berkesan pasca-submit).
		for it in so_doc.items:
			if it.item_code in {i["item_code"] for i in items} and not it.reserve_stock:
				it.db_set("reserve_stock", 1)
				it.reserve_stock = 1

		from erpnext.selling.doctype.sales_order.services.reservation import (
			SalesOrderStockReservation,
		)
		sor = SalesOrderStockReservation(so_doc)
		items_details = [{
			"sales_order_item": it.name,
			"warehouse":        it.warehouse or warehouse,
			"qty_to_reserve":   flt(it.qty),
		} for it in items]
		sor.create_stock_reservation_entries(
			items_details=items_details, notify=False)
		return {"reserved": len(items_details)}
	except Exception as e:
		frappe.log_error(
			title="Merchandise Reserve Error",
			message="Gagal reserve stok untuk SO {0}: {1}".format(so_name, e),
		)
		return {"reserved": 0, "error": str(e)}


# ══════════════════════════════════════════════
# DELIVERY NOTE PUKAL (per trip date)
# ══════════════════════════════════════════════

def create_delivery_notes_for_trip(trip_group_date):
	"""Delivery Note pukal untuk SEMUA booking aktif satu Trip Group Date
	yang ada baris merchandise stok belum dihantar.

	Return {created: [DN names], skipped: [{booking, reason}]}.
	Guna mapper standard ERPNext make_delivery_note (packing list,
	warehouse, reservation → delivery semua dikendalikan ERPNext).
	SO yang sudah ada DN (docstatus != 2) dilangkau supaya idempoten.
	"""
	_require_booking_manager()

	bookings = frappe.db.get_all(
		"Booking",
		filters={"trip_date": trip_group_date,
		         "status": ["not in", ["Cancelled", "Abandoned"]]},
		pluck="name")

	created, skipped = [], []
	for booking_name in bookings:
		# SO aktif booking yang ada baris merchandise stok
		so_names = frappe.db.sql("""
			SELECT DISTINCT so.name
			FROM `tabSales Order` so
			JOIN `tabSales Order Item` soi ON soi.parent = so.name
			JOIN `tabItem` i ON i.name = soi.item_code
			WHERE so.custom_booking = %s
			  AND so.docstatus = 1
			  AND i.is_stock_item = 1
		""", booking_name, as_dict=True)

		for row in so_names:
			so_name = row.name
			# Langkau SO yang dah ada DN aktif (idempoten)
			has_dn = frappe.db.sql("""
				SELECT dni.parent
				FROM `tabDelivery Note Item` dni
				JOIN `tabDelivery Note` dn ON dn.name = dni.parent
				WHERE dni.against_sales_order = %s AND dn.docstatus != 2
				LIMIT 1
			""", so_name)
			if has_dn:
				skipped.append({"booking": booking_name, "so": so_name,
				                "reason": "already-delivered"})
				continue
			try:
				dn = _make_delivery_note(so_name)
				if dn:
					created.append(dn)
				else:
					skipped.append({"booking": booking_name, "so": so_name,
					                "reason": "no-deliverable-lines"})
			except Exception as e:
				skipped.append({"booking": booking_name, "so": so_name,
				                "reason": str(e)[:200]})

	frappe.db.commit()
	return {"created": created, "skipped": skipped}


def _make_delivery_note(so_name):
	"""Bina + submit Delivery Note untuk SO melalui mapper standard.
	Return nama DN atau None kalau tiada baris deliverable."""
	# v17: mapper DN dari SO di selling/mapper (bukan stock/delivery_note).
	from erpnext.selling.doctype.sales_order.mapper import make_delivery_note

	so_doc = frappe.get_doc("Sales Order", so_name)
	warehouse = get_stock_warehouse(so_doc.company)

	dn = make_delivery_note(so_name)

	# Pastikan setiap baris stok ada warehouse sah
	if warehouse:
		for item in dn.items:
			if not item.warehouse:
				item.warehouse = warehouse

	if not dn.items:
		return None

	_original_user = frappe.local.session.user
	frappe.local.session.user = "Administrator"
	try:
		dn.flags.ignore_permissions = True
		dn.insert()
		dn.submit()
		return dn.name
	finally:
		frappe.local.session.user = _original_user


def _require_booking_manager():
	"""Gate desk — mirror booking_hub._require_booking_manager."""
	from travel_booking.api.booking_hub import _require_booking_manager
	_require_booking_manager()


# ══════════════════════════════════════════════
# JUALAN MERCHANDISE BERASINGAN (public)
# ══════════════════════════════════════════════

@frappe.whitelist(allow_guest=True)
def get_public_merchandise(currency: str = None):
	"""Katalog merchandise awam — Item yang DIBENDERAKAN jualan berasingan
	(patch v41: custom field Item.is_public_merchandise = 1) + jualan
	aktif (is_sales_item=1, disabled=0).

	Item bundled dalam pakej trip = Merchandise TANPA flag — tidak muncul
	di katalog public. (Tapisan lama hardcoded item_group='Products'
	diganti — group ERPNext default itu kosong dan bercampur dengan
	bukan-merchandise.)

	Return ringkas untuk card listing; harga dari Item Price price list
	currency. Item tanpa harga currency itu disembunyikan."""
	rows = frappe.db.sql("""
		SELECT i.item_code, i.item_name, i.image, i.description,
		       i.item_group, i.is_stock_item
		FROM `tabItem` i
		WHERE i.is_sales_item = 1 AND i.disabled = 0
		  AND IFNULL(i.is_public_merchandise, 0) = 1
		ORDER BY i.item_code
		LIMIT 100
	""", as_dict=True)

	if not rows:
		return {"items": [], "currency": currency or DEFAULT_CURRENCY}

	currency = currency or DEFAULT_CURRENCY
	from travel_booking.api.currency_axis import currency_to_price_list
	price_list = currency_to_price_list(currency) or "Standard Selling"

	price_map = {}
	for p in frappe.db.get_all(
		"Item Price",
		filters={"price_list": price_list, "selling": 1,
		         "item_code": ["in", [r.item_code for r in rows]]},
		fields=["item_code", "price_list_rate"]):
		price_map[p.item_code] = flt(p.price_list_rate)

	items = []
	for r in rows:
		price = price_map.get(r.item_code)
		if price is None:
			continue  # tiada harga currency ni — sembunyikan
		items.append({
			"item_code":   r.item_code,
			"item_name":   r.item_name or r.item_code,
			"image":       r.image or "",
			"description": (r.description or "")[:280],
			"in_stock":    _merch_in_stock(r.item_code),
			"currency":    currency,
			"price":       price,
		})
	return {"items": items, "currency": currency}


def _merch_in_stock(item_code):
	"""Boolean kasar ada stok (bin apa-apa warehouse) — untuk paparan
	'In stock' pada kad. Buat projection: stok sebenar - SO aktif belum
	deliver (perilaku konservatif tanpa SRE)."""
	projected = frappe.db.sql("""
		SELECT COALESCE(SUM(b.actual_qty), 0) - COALESCE((
		    SELECT SUM(soi.qty - soi.delivered_qty)
		    FROM `tabSales Order Item` soi
		    JOIN `tabSales Order` so ON so.name = soi.parent
		    WHERE soi.item_code = %s AND so.docstatus = 1
		      AND soi.qty > soi.delivered_qty
		), 0)
		FROM `tabBin` b WHERE b.item_code = %s
	""", (item_code, item_code))[0][0]
	return flt(projected) > 0


@frappe.whitelist()
def create_merch_order(lines, billing=None, payment_method="Online Payment",
                       currency=None, bank_transfer_ref=None, receipt=None):
	"""Jualan merchandise berasingan — SO item merchandise sahaja.

	lines = JSON list [{item_code, qty}]. billing = JSON {name, email,
	phone, address_line1, city, postcode, state, country} — guna jalur
	customer/address sedia ada (so_helpers). Payment: Stripe Payment
	Request URL (return) atau Manual Transfer (draft PE) — corak
	confirm_booking dipendekkan untuk merchandise sahaja.

	GATE: login (portal user) — jualan berasingan bukan guest checkout
	v1; guest boleh ditambah kemudian melalui OTP yang sedia ada.
	"""
	if frappe.session.user in ("Guest", ""):
		frappe.throw("Please log in to purchase merchandise.",
			frappe.PermissionError)

	if isinstance(lines, str):
		import json
		lines = json.loads(lines)
	if isinstance(billing, str):
		import json
		billing = json.loads(billing)
	if not lines:
		frappe.throw("Please select at least one merchandise item.")

	from travel_booking.api.currency_axis import (
		get_declared_currencies, get_default_currency)
	currency = currency or get_default_currency()
	declared = get_declared_currencies()
	if declared and currency not in declared:
		frappe.throw("Currency '{0}' is not available.".format(currency),
			title="Currency Not Available")

	# Re-price semula dari DB (jangan percaya client)
	from travel_booking.api.currency_axis import currency_to_price_list
	price_list = currency_to_price_list(currency) or "Standard Selling"
	validated = []
	for line in lines:
		item_code = line.get("item_code")
		qty = int(line.get("qty", 0) or 0)
		if not item_code or qty <= 0:
			continue
		price = frappe.db.get_value(
			"Item Price",
			{"item_code": item_code, "price_list": price_list, "selling": 1},
			"price_list_rate")
		if price is None:
			frappe.throw(
				"{0} is not available in {1}.".format(item_code, currency),
				title="Merchandise Currency Unavailable")
		if not frappe.db.get_value("Item", item_code, "is_sales_item"):
			frappe.throw("Invalid item: " + str(item_code))
		validated.append({"item_code": item_code, "qty": qty,
		                  "rate": flt(price)})

	if not validated:
		frappe.throw("Please select at least one merchandise item.")

	# Customer portal user
	customer_name = _customer_for_session_user()
	if not customer_name:
		frappe.throw("No customer profile found for your account. "
			"Please contact support.")

	so_currency, so_company, so_price_list, conversion_rate = \
		_resolve_so_currency_and_rate(currency)

	warehouse = get_stock_warehouse(so_company)

	so_items = []
	for l in validated:
		so_items.append({
			"item_code": l["item_code"],
			"qty":       l["qty"],
			"rate":      l["rate"],
			"uom":       "Nos",
			"warehouse": warehouse or "",
			# Flag standard ERPNext — baris stok auto-reserve bila
			# Stock Settings enable + SO disubmit (hook on_submit kami
			# panggil reserve_so_stock juga sebagai jaring kedua).
			"reserve_stock": 1,
			"description": "Merchandise order",
		})

	grand_total = sum(l["rate"] * l["qty"] for l in validated)

	_original_user = frappe.local.session.user
	frappe.local.session.user = "Administrator"
	try:
		so = frappe.get_doc({
			"doctype":            "Sales Order",
			"customer":           customer_name,
			"transaction_date":   frappe.utils.today(),
			"delivery_date":      frappe.utils.today(),
			"order_type":         "Sales",
			"items":              so_items,
			"company":            so_company,
			"selling_price_list": so_price_list,
			"currency":           so_currency,
			"conversion_rate":    conversion_rate,
			"disable_rounded_total": 1,
		})
		so.insert(ignore_permissions=True)
		so.flags.ignore_permissions = True
		so.submit()

		# Reserve stok merchandise (mesineri standard)
		reserve_so_stock(so.name)
	finally:
		frappe.local.session.user = _original_user

	# Bayaran — jalur sedia ada
	payment_url = None
	pe_name = None
	if payment_method == "Online Payment":
		try:
			from travel_booking.api.stripe_checkout import create_payment_intent
			pi = create_payment_intent(
				sales_order=so.name, amount=grand_total, source="portal")
			# pi: {payment_intent_client_secret, payment_request, amount, ...}
			# Checkout page sedia ada (/checkout) render Stripe Elements dari
			# client secret — pulangkan URL corak portal.
			if pi and pi.get("payment_intent_client_secret"):
				payment_url = ("/checkout?pr=" + str(pi.get("payment_request") or "")
				               + "&src=merch&ref=" + so.name)
		except Exception as e:
			frappe.log_error(
				title="Merchandise Payment Intent Error",
				message="Gagal cipta payment intent untuk SO {0}: {1}".format(
					so.name, e))
			payment_method = "Manual Transfer"
	if payment_method == "Manual Transfer":
		from travel_booking.api.so_helpers import _create_manual_payment_entry
		pe_name = _create_manual_payment_entry(
			so_name=so.name, customer_name=customer_name,
			amount=grand_total, receipt_data=receipt or "",
			label="merch-" + so.name, bank_transfer_ref=bank_transfer_ref)

	frappe.db.commit()
	return {
		"success":       True,
		"sales_order":   so.name,
		"grand_total":   grand_total,
		"currency":      so_currency,
		"payment_url":   payment_url,
		"payment_entry": pe_name,
	}


def _customer_for_session_user():
	"""Customer ERPNext untuk portal user semasa — melalui Contact link
	(coration _ensure_contact_customer_link app)."""
	contact = frappe.db.get_value(
		"Contact", {"email_id": frappe.session.user}, "name")
	if not contact:
		return None
	dl = frappe.db.get_value(
		"Dynamic Link",
		{"parent": contact, "link_doctype": "Customer"}, "link_name")
	return dl


def _resolve_so_currency_and_rate(currency=None):
	from travel_booking.api.so_helpers import _resolve_so_currency_and_rate as _r
	return _r(currency)
