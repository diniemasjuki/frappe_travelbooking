# travel_booking/api/desk_booking.py
#
# WIZARD BOOKING DESK — Travel Manager > Booking > Booking Group > Booking Baru
# ═══════════════════════════════════════════════════════════════════
# Endpoint perantara untuk staf desk mencipta booking bagi pihak
# pelanggan (walk-in / telefon) di halaman desk
# /app/travel-manager/booking-group/new — TANPA melalui portal /booknow yang
# berorientasikan guest (OTP email customer, rate-limit per-IP).
#
# PRINSIP SATU SUMBER KEBENARAN:
#   Endpoint ni TIDAK mengira harga / kapasiti / diskaun sendiri.
#   Penciptaan di-DELEGATE kepada booking_engine._confirm_booking_impl()
#   — pipeline yang SAMA dengan portal /booknow (confirm_booking).
#   Yang berbeza hanyalah pintu masuk:
#     - Gate akses _require_access() (MANAGE_TRIP_ROLES) — corak yang
#       sama dengan booking_edit.py, bukan allow_guest;
#     - on_behalf=True — staf BERINGIN: OTP email customer dilangkau,
#       Booking.booking_channel direkod "Staff" dan booked_by = session
#       user (rujuk resolve_booking_actor() + stamp di
#       booking_engine._confirm_booking_impl);
#     - TANPA rate-limit per-IP — staf pejabat berkongsi IP awam, had
#       15 booking/jam portal tidak sesuai untuk laluan dalaman.
#
#   Struktur produk: OFFER SAHAJA (Package Offer identiti-sendiri).
#   Flag Travel Settings.use_package_offers WAJIB ON dan offer mesti
#   ada currency sendiri — wizard desk tidak menyokong struktur legacy
#   Trip Group Date / Trip Package.
#
# Role on-behalf: role staf desk mestilah berada dalam
# Travel Settings.on_behalf_roles (channel "Staff") supaya
# resolve_booking_actor() mengesahkan actor — di-seed idempoten oleh
# install._ensure_on_behalf_roles() (after_install /
# maintenance.ensure_default_records).

import re
from typing import Optional

import frappe
from frappe import _
from frappe.utils import cint, today

from travel_booking.api._helpers import (
    get_customer_by_email,
    get_customer_email,
    get_customer_phone,
    resolve_booking_actor,
)
from travel_booking.api.manage_trip_booking import _require_access


# ══════════════════════════════════════════════
# 1. BOOTSTRAP WIZARD — konteks sekali panggil
# ══════════════════════════════════════════════

@frappe.whitelist(methods=["POST"])
def get_wizard_context() -> dict:
	"""Bootstrap wizard booking desk (satu panggilan semasa buka halaman).

	Pulangkan segala-galanya yang wizard perlukan SEBELUM pilihan produk
	dibuat — flag struktur, kemampuan on-behalf session user, had kabin
	per booking, dan dokumen T&C aktif (untuk tick persetujuan Step 4
	dengan terms_reference yang SAH digate _confirm_booking_impl).

	- use_package_offers: wizard desk OFFER-ONLY — bila flag OFF, wizard
	  disekat dengan mesej jelas (bukan gagal senyap semasa submit).
	- on_behalf.ok: FALSE bila role session user belum berada dalam
	  Travel Settings.on_behalf_roles — wizard memaparkan banner sekatan
	  (gate OTP server akan throw kalau dipaksakan).
	- terms: {name, title, content} dokumen T&C aktif per vertical site
	  (api/terms.get_active_terms_record) atau None bila tiada — gate
	  T&C di impl dilangkau bila None (selari portal).
	"""
	_require_access()

	from travel_booking.api.constants import get_max_cabins
	from travel_booking.api.terms import get_active_terms_record
	from travel_booking.utils.flags import use_package_offers

	actor = resolve_booking_actor()
	terms = get_active_terms_record()
	settings = frappe.get_cached_doc("Travel Settings")

	return {
		"use_package_offers": bool(use_package_offers()),
		"max_cabins": get_max_cabins(),
		# Terma deposit global (fallback bila offer tiada override) — mirror
		# _effective_payment_terms: offer.deposit_percent/final_payment_days
		# → nilai global di bawah. Deposit % turut dipaparkan get_payment_
		# settings; disertakan di sini supaya wizard cukup satu bootstrap.
		"default_deposit_percent": float(
			getattr(settings, "default_deposit_percent", 0) or 0),
		"default_final_payment_days": int(
			getattr(settings, "default_final_payment_days", 0) or 0),
		"on_behalf": {
			"ok": bool(actor),
			"channel": (actor or {}).get("channel") or "",
			"full_name": (actor or {}).get("full_name") or "",
		},
		"terms": {
			"name": terms.get("name"),
			"title": terms.get("title") or terms.get("name"),
			"content": terms.get("content") or "",
		} if terms else None,
	}


# ══════════════════════════════════════════════
# 2. PEMILIH OFFER (Step 1) — senarai offer jualan
# ══════════════════════════════════════════════

@frappe.whitelist(methods=["POST"])
def list_sellable_offers(trip: Optional[str] = None, q: Optional[str] = None,
                         limit: int = 200) -> dict:
	"""Senarai Package Offer yang BOLEH DIJUAL untuk pemilih wizard desk.

	Endpoint sedia ada package_admin.get_offers_list digate
	_require_product_admin() — terlalu ketat untuk role booking desk
	(cth Accounts User). Endpoint ni guna _require_access() yang sama
	dengan baki wizard.

	Hanya offer yang lulus gate baca wizard (selari
	pricing._get_booking_details_offer yang throw offer bukan-Active):
	  - status_editorial = "Active";
	  - departure_date >= hari ini (upcoming);
	Fields commercial offer disertakan (deposit_percent /
	final_payment_days) supaya wizard Step 4 boleh disable pilihan
	Deposit dalam tetingkap bayaran akhir TANPA panggilan kedua.
	"""
	_require_access()

	limit = max(1, min(cint(limit) or 200, 500))
	filters = {
		"status_editorial": "Active",
		"departure_date": [">=", today()],
	}
	or_filters = None
	if trip and trip.strip():
		filters["trip"] = trip.strip()
	if q and q.strip():
		needle = q.strip()
		or_filters = [
			["Package Offer", "offer_name", "like", f"%{needle}%"],
			["Package Offer", "name", "like", f"%{needle}%"],
		]

	offers = frappe.get_all(
		"Package Offer",
		filters=filters,
		or_filters=or_filters,
		fields=[
			"name", "offer_name", "package", "trip", "travel_date",
			"currency", "departure_date", "return_date", "ship_name",
			"cruise_schedule", "deposit_percent", "final_payment_days",
			# Nama warisan untuk parity panggilan portal — voucher ber-scope
			# (validate_voucher) & price-rule ctx berjalan atas nama legacy
			# Trip Package / TGD (identik dengan booknow.js offer-mode).
			"legacy_trip_package", "legacy_tgd",
		],
		order_by="departure_date asc, name asc",
		limit=limit,
	)

	trip_names = {
		t.name: t.trip_name
		for t in frappe.get_all(
			"Trip",
			filters={"name": ["in", list({o.trip for o in offers if o.trip}) or [""]]},
			fields=["name", "trip_name"],
		)
	}
	for o in offers:
		o["trip_name"] = trip_names.get(o.trip) or ""
		o["offer_label"] = o.offer_name or o.name
	return {"offers": offers}


# ══════════════════════════════════════════════
# 3. CARI PELANGGAN (Step 3) — autofill billing
# ══════════════════════════════════════════════

@frappe.whitelist(methods=["POST"])
def lookup_customer(query: str) -> dict:
	"""Cari pelanggan sedia ada ikut EMAIL (tepat) atau TELEFON (7 digit
	terakhir) untuk autofill borang billing Step 3 wizard desk.

	Sumber data = Contact → Dynamic Link Customer (corak sedia ada
	get_customer_by_email/_email/_phone di _helpers.py — BUKAN tekaan
	dari Customer.name). Alamat = Address 'Billing' primary yang di-link
	ke Customer — medan pincode dipetakan balik ke "postcode" (mapping
	sama dengan _upsert_customer_billing_address).

	Pulangkan {"found": true, customer, customer_name, email, phone,
	address{address_line1, city, postcode, state, country}} atau
	{"found": false} — autofill SAHAJA; staf bebas mengubah nilai, dan
	confirm tetap bina/kemas kini Customer daripada borang (impl).
	"""
	_require_access()

	q = (query or "").strip()
	if not q:
		return {"found": False}

	customer = None
	# 1) Email tepat ( Cuba nilai asal & lowercase — Contact Email
	#    disimpan exact-case, input desk mungkin bercampur).
	for candidate in dict.fromkeys([q, q.lower()]):
		customer = get_customer_by_email(candidate)
		if customer:
			break

	# 2) Telefon — format simpanan berbeza-beza (+6012-3456789 /
	#    60123456789 / 012 345 6789). Padanan LIKE 7 digit TERAKHIR cukup
	#    praktikal untuk autofill; tiada penulisan, baca sahaja.
	if not customer:
		digits = re.sub(r"\D", "", q)
		if len(digits) >= 7:
			tail = digits[-7:]
			rows = frappe.db.sql("""
				SELECT dl.link_name AS customer
				FROM `tabContact Phone` cp
				JOIN `tabContact` c ON c.name = cp.parent
				JOIN `tabDynamic Link` dl
				  ON dl.parent = c.name AND dl.parenttype = 'Contact'
				WHERE dl.link_doctype = 'Customer' AND cp.phone LIKE %s
				ORDER BY cp.is_primary_phone DESC, cp.idx ASC
				LIMIT 1
			""", (f"%{tail}%",), as_dict=True)
			customer = rows[0].customer if rows else None

	if not customer or not frappe.db.exists("Customer", customer):
		return {"found": False}

	cust = frappe.db.get_value(
		"Customer", customer, "customer_name", as_dict=True)
	addr = frappe.db.sql("""
		SELECT a.address_line1, a.city, a.state, a.pincode, a.country
		FROM `tabAddress` a
		JOIN `tabDynamic Link` dl
		  ON dl.parent = a.name AND dl.parenttype = 'Address'
		WHERE dl.link_doctype = 'Customer' AND dl.link_name = %s
		  AND a.address_type = 'Billing' AND a.disabled = 0
		ORDER BY a.is_primary_address DESC, a.creation ASC
		LIMIT 1
	""", (customer,), as_dict=True)
	addr = addr[0] if addr else None

	return {
		"found": True,
		"customer": customer,
		"customer_name": (cust.customer_name if cust else customer),
		"email": get_customer_email(customer) or "",
		"phone": get_customer_phone(customer) or "",
		"address": {
			"address_line1": (addr.address_line1 if addr else "") or "",
			"city": (addr.city if addr else "") or "",
			"postcode": (addr.pincode if addr else "") or "",
			"state": (addr.state if addr else "") or "",
			"country": (addr.country if addr else "") or "",
		},
	}


# ══════════════════════════════════════════════
# 4. SUBMIT WIZARD — cipta booking (Step 5)
# ══════════════════════════════════════════════

@frappe.whitelist(methods=["POST"])
def create_desk_booking(package_offer: str, selections: str, billing: str,
                        payment_type: str = "Full Payment",
                        payment_method: str = "Pay Later",
                        receipt: Optional[str] = None,
                        voucher_code: str = "", affiliate_code: str = "",
                        sales_persons: Optional[str] = None,
                        bank_transfer_ref: str = "", bank_transfer_date: str = "",
                        bank_transfer_note: str = "",
                        terms_accepted: bool = False, terms_reference: str = "",
                        customer_message: str = "",
                        addons: str = "") -> dict:
	"""Cipta booking dari wizard desk — delegate penuh kepada
	booking_engine._confirm_booking_impl() (pipeline portal /booknow).

	Bebas rate-limit per-IP (gate _require_access per-role) & OTP customer
	dilangkau (on_behalf=True — actor di-resolve daripada session staf).
	Seluruh harga/kapasiti/discaun di-re-price & di-re-validate server-side
	dalam impl — nilai client TIDAK PERNAH dipercayai, sama seperti portal.

	Params selari portal /booknow (rujuk confirm_booking):
	  - selections: JSON [{room_category, main_guests, extra_beds, infants,
	    guests?: [{slot, category}], room_privacy?}] — kaunter WAJIB konsisten
	    dengan itemisasi guests[] bila dihantar (pricing._validate_guest_list).
	  - billing: JSON {email, full_name, phone, address_line1, city,
	    postcode, state, country} — alamat 5 medan WAJIB (gate impl).
	  - addons: JSON [{addon_package, qty}] — di-re-price dalam impl.
	  - payment_method: "Online Payment" | "Manual Transfer" | "Pay Later".
	  - terms_accepted + terms_reference: rekod persetujuan T&C aktif
	    (gate impl — reference mesti padan dokumen aktif bila ada).

	TIADA booking_number (tiada re-confirm "Back dari checkout" di desk) dan
	TIADA amount_paid/trip_package/travel_package (impl abaikan amount_paid;
	wizard desk OFFER-ONLY — trip_group_date dinormalisasi server daripada
	provenance offer). Pulangan serupa portal: booking_number, sales_order,
	grand_total/net_total/amount_due, payment_url, addons_*, dll.
	"""
	_require_access()

	offer = (package_offer or "").strip()
	if not offer:
		frappe.throw(_("Package Offer is required for the desk booking wizard."))

	from travel_booking.utils.flags import use_package_offers
	if not use_package_offers():
		frappe.throw(_(
			"The new package-offer structure is switched off "
			"(Travel Settings → Use Package Offers). Enable it to use the "
			"desk booking wizard."
		))

	# Wizard desk OFFER-ONLY — offer mesti identiti-sendiri (ada currency
	# sendiri; harga terus dari Price Matrix). Offer warisan (tanpa
	# currency) jatuh ke resolusi legacy dalam impl yang wizard ni tak
	# sediakan inputnya — sekat awal dengan mesej jelas.
	offer_currency = frappe.db.get_value("Package Offer", offer, "currency")
	if not offer_currency:
		frappe.throw(_(
			"Package Offer {0} has no own currency (legacy-migrated offer) "
			"and cannot be sold through the desk booking wizard."
		).format(offer))

	from travel_booking.api.booking_engine import _confirm_booking_impl
	result = _confirm_booking_impl(
		trip_group_date="",  # dinormalisasi server daripada provenance offer
		selections=selections,
		billing=billing,
		payment_type=payment_type,
		payment_method=payment_method,
		receipt=receipt,
		voucher_code=voucher_code,
		affiliate_code=affiliate_code,
		amount_paid=None,
		trip_package=None,
		sales_persons=sales_persons,
		bank_transfer_ref=bank_transfer_ref,
		bank_transfer_date=bank_transfer_date,
		bank_transfer_note=bank_transfer_note,
		booking_number=None,
		on_behalf=True,
		terms_accepted=terms_accepted,
		terms_reference=terms_reference,
		customer_message=customer_message,
		travel_package=None,
		package_offer=offer,
		addons=addons,
	)

	# Impl sudah success → buang mesej INFO/ERROR residual dari message_log
	# (cth. msgprint "Item Price updated" semasa SO insert ATAU kegagalan
	# emel status yang di-catch dalam impl — booking tetap sah). Tanpa ini
	# frappe.call paparkan modal yang mengelirukan staf WALAUPUN booking
	# berjaya (payload result membawa segala status kegagalan sebenar:
	# payment_setup_failed / addons_error). Ralat sebenar (throw) tidak
	# sampai ke sini — impl throw memutuskan request sebelum clear.
	# PENTING: reset pada frappe.local (bukan `frappe.message_log = ...`
	# yang hanya mengikat semula nama modul — response._server_messages
	# dibina daripada frappe.local.message_log, rujuk utils/response.py).
	frappe.local.message_log = []
	return result
