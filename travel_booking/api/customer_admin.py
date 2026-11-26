# travel_booking/api/customer_admin.py
# API DIREKTORI CUSTOMER (Travel Manager > Customer) — STAF SAHAJA.
#
# [Nov 2026] Direktori SEMUA customer untuk admin: senarai datatable
# (carian server-side — jumlah customer boleh melebihi cap), agregat
# kewangan per-currency (billed/paid/tunggakan + credit note), booking
# terkini, loyalty points (feature-detect ERPNext Loyalty Program) dan
# permukaan model B2B sedia ada (Travel B2B Partner — Customer Group
# "B2B", booking_channel Booking).
#
# DOKTRIN (selari package_admin.py):
#   • Bacaan = 4 role desk (TRIP_COMMAND_CENTER_ROLES); tulis
#     contact/address = Manager/Operator; customer_type/customer_group/
#     disabled = Tour Manager/System Manager sahaja (corak _gate_status_change).
#   • Mutasi SENTIASA doc.save() penuh — hooks (billing_address_sync,
#     Address.on_update ERPNext) mesti fire; JANGAN raw DB write.
#   • Edit email Contact JANGAN buang row email lama (row lama
#     dinyah-primary sahaja) — resolusi portal Customer-by-email dan
#     login sedia ada bergantung padanya (corak _upsert_contact_primary).
#   • Agregat direktori: SATU panggilan per kumpulan (bukan N+1), cap
#     1000 + `total` utk amaran pemotongan (corak get_dates_directory).
#   • Kewangan ikut sumber ERPNext yang authoritative sahaja: SO
#     docstatus=1 (grand_total + advance_paid — guardrail reka bentuk
#     app: semua SO satu customer sama currency; pecahan tepat per
#     currency disertakan), Sales Invoice is_return=1 = credit note,
#     Payment Entry unallocated_amount > 0 = lebihan/advance belum agih.
#     Refund pulangan masih flow manual admin (payment_status Booking)
#     — tiada credit note auto dicipta app ini.
#   • Loyalty: BACAAN sahaja daripada ERPNext standard (tabLoyalty Point
#     Entry, expiry dihormati); tiada custom field/tabel baharu.

import json

import frappe
from frappe import _
from frappe.utils import cint, flt, nowdate

from travel_booking.api.trip_command_center import (
	TRIP_COMMAND_CENTER_ROLES,
	_check_command_center_roles,
)

# Tulis maklumat kontak/billing (mengalir ke dokumen bil & portal):
# Manager + Operator — selari tddCanWrite (corak Package Offers/Dates).
_CUSTOMER_WRITE_ROLES = {"System Manager", "Tour Manager", "Tour Operator"}
# Struktur segmentasi (type/group/disabled) — pengurusan sahaja
# (selari _MANAGER_ONLY package_admin.py).
_MANAGER_ONLY = {"System Manager", "Tour Manager"}


def _require_customer_admin():
	_check_command_center_roles(TRIP_COMMAND_CENTER_ROLES, "Customer Directory")


def _require_customer_write():
	_check_command_center_roles(sorted(_CUSTOMER_WRITE_ROLES), "Customer Directory")


def _gate_customer_structural(field: str):
	"""Perubahan struktur segmentasi customer (type/group/disabled) —
	hanya Tour Manager / System Manager (corak _gate_status_change)."""
	if not (_MANAGER_ONLY & set(frappe.get_roles())):
		frappe.throw(
			_("Only Tour Manager / System Manager can change {0}.").format(field),
			frappe.PermissionError,
		)


def _loyalty_enabled() -> bool:
	"""Feature-detect ERPNext Loyalty Program — papar kolum loyalty HANYA
	bila modul aktif di site ini (corak "erpnext" in get_installed_apps()
	dari install.py; JANGAN frappe.db.exists("Installed Application"))."""
	try:
		if "erpnext" not in frappe.get_installed_apps():
			return False
		# Aktif = ada Loyalty Program TERSEDIA di site ATAU ada customer
		# yang sudah di-daftar ke satu program.
		if frappe.db.sql("SELECT name FROM `tabLoyalty Program` LIMIT 1"):
			return True
		return bool(frappe.db.sql(
			"SELECT name FROM `tabCustomer` "
			"WHERE IFNULL(loyalty_program, '') != '' LIMIT 1"))
	except Exception:
		return False


# ══════════════════════════════════════════════
# DIREKTORI — senarai semua customer + agregat
# ══════════════════════════════════════════════

@frappe.whitelist()
def get_customers_directory(search: str = "", customer_type: str = "",
                            customer_group: str = "", limit: int = 1000) -> dict:
	"""Direktori SEMUA customer — halaman Customer (Travel Manager,
	Nov 2026): datatable (carian SERVER-SIDE + penapis; sort/pagination/
	column-toggle client-side tmDataTable).

	Carian mencari nama/nama dokumen/email kontak (Contact Email →
	Dynamic Link) & group — jumlah customer auto-bertambah dari portal,
	jadi carian mesti di server (corak get_trip_groups). Cap 1000 baris +
	`total` utk amaran pemotongan (corak get_dates_directory).

	Agregat SEKALI panggilan per kumpulan (bukan per-customer):
	  • email/phone primary (Contact → Dynamic Link)
	  • bilangan booking + booking terakhir (customer ATAU end_customer B2B)
	  • kewangan per currency (SO docstatus=1: billed/paid/outstanding)
	  • credit note (Sales Invoice is_return=1 docstatus=1)
	  • loyalty points (tabLoyalty Point Entry — hanya bila aktif)
	  • partner B2B (LEFT JOIN Travel B2B Partner.customer)
	"""
	_require_customer_admin()
	limit = max(1, min(cint(limit) or 1000, 1000))

	# Kondisi digabung dengan AND — JANGAN letak kondisi "OR" tanpa
	# kurungan (precedence AND > OR memecahkan penapis carian).
	conds = []
	params = {"limit": limit}
	if search:
		params["search"] = "%{}%".format((search or "").strip())
		conds.append("""(
			c.customer_name LIKE %(search)s
			OR c.name LIKE %(search)s
			OR c.customer_group LIKE %(search)s
			OR EXISTS (
				SELECT 1 FROM `tabDynamic Link` dl
				JOIN `tabContact Email` ce
				  ON ce.parent = dl.parent AND dl.parenttype = 'Contact'
				WHERE dl.link_doctype = 'Customer' AND dl.link_name = c.name
				  AND ce.email_id LIKE %(search)s
			)
		)""")
	if customer_type:
		params["ctype"] = customer_type
		conds.append("c.customer_type = %(ctype)s")
	if customer_group:
		params["cgroup"] = customer_group
		conds.append("c.customer_group = %(cgroup)s")
	where = " AND ".join(conds) or "1=1"

	customers = frappe.db.sql(f"""
		SELECT c.name, c.customer_name, c.customer_type, c.customer_group,
		       c.disabled, c.territory,
		       bp.name AS b2b_partner, bp.partner_name AS b2b_partner_name,
		       bp.status AS b2b_status, bp.default_discount_percent
		FROM `tabCustomer` c
		LEFT JOIN `tabTravel B2B Partner` bp ON bp.customer = c.name
		WHERE {where}
		ORDER BY c.customer_name ASC, c.name ASC
		LIMIT %(limit)s
	""", params, as_dict=True)

	names = [c.name for c in customers] or ["__none__"]
	total = frappe.db.sql(f"""
		SELECT COUNT(*) FROM `tabCustomer` c WHERE {where}
	""", params)[0][0]

	# ── Email/phone primary per customer (Contact → Dynamic Link) ──
	emails, phones = {}, {}
	for r in frappe.db.sql("""
		SELECT dl.link_name AS customer, ce.email_id AS email
		FROM `tabDynamic Link` dl
		JOIN `tabContact` ct ON ct.name = dl.parent AND dl.parenttype = 'Contact'
		JOIN `tabContact Email` ce
		  ON ce.parent = ct.name AND ce.parenttype = 'Contact'
		WHERE dl.link_doctype = 'Customer' AND dl.link_name IN %(names)s
		ORDER BY ce.is_primary DESC, ct.creation ASC, ce.idx ASC
	""", {"names": names}, as_dict=True):
		# Baris pertama ikut ORDER = primary dahulu; simpan sekali sahaja.
		emails.setdefault(r.customer, r.email)
	for r in frappe.db.sql("""
		SELECT dl.link_name AS customer, cp.phone AS phone
		FROM `tabDynamic Link` dl
		JOIN `tabContact` ct ON ct.name = dl.parent AND dl.parenttype = 'Contact'
		JOIN `tabContact Phone` cp
		  ON cp.parent = ct.name AND cp.parenttype = 'Contact'
		WHERE dl.link_doctype = 'Customer' AND dl.link_name IN %(names)s
		ORDER BY cp.is_primary_phone DESC, ct.creation ASC, cp.idx ASC
	""", {"names": names}, as_dict=True):
		phones.setdefault(r.customer, r.phone)

	# ── Bilangan booking + booking terakhir (customer ATAU end_customer) ──
	bookings_agg = {}
	for r in frappe.db.sql("""
		SELECT t.cust AS customer, COUNT(*) AS bookings, MAX(t.creation) AS last_booking
		FROM (
			SELECT b.customer AS cust, b.creation FROM `tabBooking` b
			WHERE b.customer IN %(names)s
			UNION ALL
			SELECT b.end_customer AS cust, b.creation FROM `tabBooking` b
			WHERE b.end_customer IN %(names)s
			  AND IFNULL(b.end_customer, '') != ''
			  AND IFNULL(b.end_customer, '') != b.customer
		) t
		GROUP BY t.cust
	""", {"names": names}, as_dict=True):
		bookings_agg[r.customer] = r

	# ── Kewangan per currency (SO docstatus=1) + credit note ──
	fin_agg = {}
	for r in frappe.db.sql("""
		SELECT so.customer AS customer, so.currency AS currency,
		       SUM(so.grand_total) AS billed, SUM(so.advance_paid) AS paid
		FROM `tabSales Order` so
		WHERE so.customer IN %(names)s AND so.docstatus = 1
		GROUP BY so.customer, so.currency
	""", {"names": names}, as_dict=True):
		fin_agg.setdefault(r.customer, []).append({
			"currency": r.currency or "MYR",
			"billed": flt(r.billed),
			"paid": flt(r.paid),
			"outstanding": flt(r.billed) - flt(r.paid),
		})
	credit_agg = {}
	for r in frappe.db.sql("""
		SELECT si.customer AS customer, si.currency AS currency,
		       COUNT(*) AS credit_notes, SUM(si.grand_total) AS credit_total
		FROM `tabSales Invoice` si
		WHERE si.customer IN %(names)s AND si.docstatus = 1 AND si.is_return = 1
		GROUP BY si.customer, si.currency
	""", {"names": names}, as_dict=True):
		# Jumlahkan credit per currency ke dalam balance currency sama.
		row = next((b for b in fin_agg.get(r.customer, [])
		            if b["currency"] == (r.currency or "MYR")), None)
		vals = {"credit": flt(r.credit_total), "credit_notes": cint(r.credit_notes)}
		if row:
			row.update(vals)
		else:
			fin_agg.setdefault(r.customer, []).append({
				"currency": r.currency or "MYR", "billed": 0.0, "paid": 0.0,
				"outstanding": 0.0, **vals,
			})

	# ── Loyalty points (hanya bila aktif; expiry dihormati) ──
	loyalty_enabled = _loyalty_enabled()
	loyalty_agg = {}
	if loyalty_enabled:
		for r in frappe.db.sql("""
			SELECT lpe.customer AS customer, SUM(lpe.loyalty_points) AS points
			FROM `tabLoyalty Point Entry` lpe
			WHERE lpe.customer IN %(names)s
			  AND (lpe.expiry_date IS NULL OR lpe.expiry_date >= %(today)s)
			GROUP BY lpe.customer
		""", {"names": names, "today": nowdate()}, as_dict=True):
			loyalty_agg[r.customer] = cint(r.points)

	for c in customers:
		b = bookings_agg.get(c.name)
		c["email"] = emails.get(c.name) or ""
		c["phone"] = phones.get(c.name) or ""
		c["bookings"] = cint(b.bookings) if b else 0
		c["last_booking"] = str(b.last_booking.date()) if b and b.last_booking else None
		c["balances"] = fin_agg.get(c.name, [])
		# Nilai agregat rentas-currency utk SORT klien sahaja — paparan
		# sentiasa pecahan per-currency.
		c["outstanding_total"] = flt(sum(
			(max(0.0, b["outstanding"])) for b in c["balances"]))
		c["credit_total"] = flt(sum(
			(b.get("credit") or 0.0) for b in c["balances"]))
		c["loyalty_points"] = loyalty_agg.get(c.name, 0) if loyalty_enabled else None
	return {
		"customers": customers,
		"total": cint(total),
		"loyalty_enabled": loyalty_enabled,
	}


# ══════════════════════════════════════════════
# DETAIL — satu customer (lazy, dipanggil bila route dibuka)
# ══════════════════════════════════════════════

@frappe.whitelist()
def get_customer_detail(customer: str) -> dict:
	"""Maklumat PENUH satu customer utk detail page
	(travel-manager/customer/<nama>): profil, contacts (flag portal-user),
	addresses, bookings terkini, kewangan per currency (SO/SI/PE) +
	credit note + lebihan belum agih, loyalty, dan profil B2B Partner
	bila customer ini ialah Billing Customer partner."""
	_require_customer_admin()
	if not customer or not frappe.db.exists("Customer", customer):
		frappe.throw(_("Customer {0} not found.").format(customer),
			frappe.DoesNotExistError)

	loyalty_enabled = _loyalty_enabled()
	cust = frappe.db.get_value("Customer", customer, [
		"name", "customer_name", "customer_type", "customer_group", "territory",
		"disabled", "customer_primary_address", "customer_primary_contact",
		"creation", "modified",
	], as_dict=True)
	has_display_currency = frappe.get_meta("Customer").has_field("rc_display_currency")
	if has_display_currency:
		cust["rc_display_currency"] = frappe.db.get_value(
			"Customer", customer, "rc_display_currency")
	if loyalty_enabled:
		cust["loyalty_program"] = frappe.db.get_value(
			"Customer", customer, "loyalty_program")

	# ── Contacts (ber-flag portal-user: Contact ber-User terlink) ──
	contacts = frappe.db.sql("""
		SELECT ct.name, ct.first_name, ct.last_name, ct.full_name,
		       ct.user, ct.status
		FROM `tabContact` ct
		JOIN `tabDynamic Link` dl
		  ON dl.parent = ct.name AND dl.parenttype = 'Contact'
		WHERE dl.link_doctype = 'Customer' AND dl.link_name = %(customer)s
		ORDER BY ct.creation ASC
	""", {"customer": customer}, as_dict=True)
	ct_names = [ct.name for ct in contacts] or ["__none__"]
	ct_emails, ct_phones = {}, {}
	for r in frappe.db.sql("""
		SELECT parent, email_id, is_primary FROM `tabContact Email`
		WHERE parent IN %(names)s ORDER BY is_primary DESC, idx ASC
	""", {"names": ct_names}, as_dict=True):
		ct_emails.setdefault(r.parent, []).append(
			{"email": r.email_id, "is_primary": bool(r.is_primary)})
	for r in frappe.db.sql("""
		SELECT parent, phone, is_primary_phone FROM `tabContact Phone`
		WHERE parent IN %(names)s ORDER BY is_primary_phone DESC, idx ASC
	""", {"names": ct_names}, as_dict=True):
		ct_phones.setdefault(r.parent, []).append(
			{"phone": r.phone, "is_primary": bool(r.is_primary_phone)})
	for ct in contacts:
		ct["emails"] = ct_emails.get(ct.name, [])
		ct["phones"] = ct_phones.get(ct.name, [])
		ct["is_portal_user"] = bool(ct.user)

	# ── Addresses (Billing ditanda utk dialog edit) ──
	addresses = frappe.db.sql("""
		SELECT a.name, a.address_type, a.is_primary_address, a.address_line1,
		       a.address_line2, a.city, a.state, a.pincode, a.country, a.disabled
		FROM `tabAddress` a
		JOIN `tabDynamic Link` dl
		  ON dl.parent = a.name AND dl.parenttype = 'Address'
		WHERE dl.link_doctype = 'Customer' AND dl.link_name = %(customer)s
		ORDER BY a.is_primary_address DESC, a.creation ASC
	""", {"customer": customer}, as_dict=True)

	# ── Bookings terkini (customer ATAU end_customer B2B) ──
	# Jumlah bil/bayar per booking datang daripada REGISTRY SO
	# (tabBooking Sales Order — satu sumber kebenaran sejak Nov 2026),
	# corak get_bookings_list: SUM grand_total/advance_paid per currency.
	bookings = frappe.db.sql("""
		SELECT b.name, b.booking_number, b.status, b.payment_status,
		       b.booked_pax, b.departure_date, b.booking_channel,
		       b.b2b_partner, b.trip_title, b.trip_name, b.creation
		FROM `tabBooking` b
		WHERE b.customer = %(customer)s OR b.end_customer = %(customer)s
		ORDER BY b.creation DESC
		LIMIT 50
	""", {"customer": customer}, as_dict=True)
	bk_names = [b.name for b in bookings] or ["__none__"]
	bk_fin = {}
	for r in frappe.db.sql("""
		SELECT reg.parent AS booking, so.currency AS currency,
		       SUM(so.grand_total) AS billed, SUM(so.advance_paid) AS paid
		FROM `tabBooking Sales Order` reg
		JOIN `tabSales Order` so ON so.name = reg.sales_order
		WHERE reg.parent IN %(names)s AND so.docstatus = 1
		GROUP BY reg.parent, so.currency
	""", {"names": bk_names}, as_dict=True):
		bk_fin.setdefault(r.booking, []).append({
			"currency": r.currency or "MYR",
			"billed": flt(r.billed), "paid": flt(r.paid),
			"outstanding": flt(r.billed) - flt(r.paid),
		})
	for b in bookings:
		b["balances"] = bk_fin.get(b.name, [])
	bookings_total = frappe.db.sql("""
		SELECT COUNT(*) FROM `tabBooking` b
		WHERE b.customer = %(customer)s OR b.end_customer = %(customer)s
	""", {"customer": customer})[0][0]
	channel_split = {}
	for r in frappe.db.sql("""
		SELECT b.booking_channel AS channel, COUNT(*) AS n
		FROM `tabBooking` b
		WHERE b.customer = %(customer)s OR b.end_customer = %(customer)s
		GROUP BY b.booking_channel
	""", {"customer": customer}, as_dict=True):
		channel_split[r.channel or "Direct"] = cint(r.n)

	# ── Kewangan per currency + credit note + lebihan belum agih ──
	finance = {"per_currency": [], "invoices": [], "credit_notes": [],
	           "unallocated_advances": []}
	for r in frappe.db.sql("""
		SELECT so.currency AS currency, SUM(so.grand_total) AS billed,
		       SUM(so.advance_paid) AS paid
		FROM `tabSales Order` so
		WHERE so.customer = %(customer)s AND so.docstatus = 1
		GROUP BY so.currency
	""", {"customer": customer}, as_dict=True):
		finance["per_currency"].append({
			"currency": r.currency or "MYR",
			"billed": flt(r.billed), "paid": flt(r.paid),
			"outstanding": flt(r.billed) - flt(r.paid),
		})
	for r in frappe.db.sql("""
		SELECT si.name, si.posting_date, si.currency, si.status,
		       si.grand_total, si.outstanding_amount
		FROM `tabSales Invoice` si
		WHERE si.customer = %(customer)s AND si.docstatus = 1 AND si.is_return = 0
		ORDER BY si.posting_date DESC
		LIMIT 20
	""", {"customer": customer}, as_dict=True):
		finance["invoices"].append(r)
	for r in frappe.db.sql("""
		SELECT si.name, si.posting_date, si.currency, si.grand_total
		FROM `tabSales Invoice` si
		WHERE si.customer = %(customer)s AND si.docstatus = 1 AND si.is_return = 1
		ORDER BY si.posting_date DESC
		LIMIT 20
	""", {"customer": customer}, as_dict=True):
		finance["credit_notes"].append(r)
	for r in frappe.db.sql("""
		SELECT pe.name, pe.posting_date, pe.paid_amount, pe.unallocated_amount
		FROM `tabPayment Entry` pe
		WHERE pe.party_type = 'Customer' AND pe.party = %(customer)s
		  AND pe.docstatus = 1 AND pe.unallocated_amount > 0
		ORDER BY pe.posting_date DESC
		LIMIT 20
	""", {"customer": customer}, as_dict=True):
		finance["unallocated_advances"].append(r)

	# ── Loyalty points semasa (expiry dihormati) ──
	loyalty_points = None
	if loyalty_enabled:
		row = frappe.db.sql("""
			SELECT SUM(lpe.loyalty_points) AS points
			FROM `tabLoyalty Point Entry` lpe
			WHERE lpe.customer = %(customer)s
			  AND (lpe.expiry_date IS NULL OR lpe.expiry_date >= %(today)s)
		""", {"customer": customer, "today": nowdate()})
		loyalty_points = cint(row[0][0]) if row else 0

	# ── Profil B2B Partner (customer ini = Billing Customer partner) ──
	b2b = None
	partner = frappe.db.get_value("Travel B2B Partner", {"customer": customer},
		["name", "partner_name", "status", "contact_email",
		 "default_discount_percent"], as_dict=True)
	if partner:
		partner["users"] = frappe.get_all("Travel B2B Partner User",
			filters={"parent": partner.name, "parenttype": "Travel B2B Partner"},
			fields=["user", "access_level"], order_by="idx")
		partner["package_discounts"] = frappe.get_all(
			"Travel B2B Package Discount",
			filters={"parent": partner.name, "parenttype": "Travel B2B Partner"},
			fields=["trip_package", "discount_percent"], order_by="idx")
		partner["channel_split"] = {}
		for r in frappe.db.sql("""
			SELECT b.booking_channel AS channel, COUNT(*) AS n
			FROM `tabBooking` b
			WHERE b.b2b_partner = %(partner)s
			GROUP BY b.booking_channel
		""", {"partner": partner.name}, as_dict=True):
			partner["channel_split"][r.channel or "Direct"] = cint(r.n)
		b2b = partner

	# ── Senarai Customer Group utk dialog (Select, BUKAN Link) ──
	# DocPerm Customer Group ERPNext tidak merangkumi System Manager
	# (hanya role Sales + select) — medan Link frappe akan trigger
	# validate_link_and_fetch 403 + modal ralat pada user tanpa read.
	# Select dari senarai DB (frappe.db.get_all — tanpa semakan permission,
	# selari SQL direktori yang sudah papar nama group; page sudah
	# role-gated 4 role desk).
	customer_groups = frappe.db.get_all("Customer Group",
		filters={"is_group": 0}, pluck="name", order_by="name")

	return {
		"customer": cust,
		"customer_groups": customer_groups,
		"loyalty_enabled": loyalty_enabled,
		"loyalty_points": loyalty_points,
		"contacts": contacts,
		"addresses": addresses,
		"bookings": bookings,
		"bookings_total": cint(bookings_total),
		"channel_split": channel_split,
		"finance": finance,
		"b2b": b2b,
	}


# ══════════════════════════════════════════════
# SIMPAN — info customer / contact / alamat billing
# ══════════════════════════════════════════════

@frappe.whitelist()
def save_customer_info(values: str) -> dict:
	"""Kemaskini medan Customer (Customer > Customer, Travel Manager).
	`values` JSON: name, customer_name, customer_type, customer_group,
	disabled, rc_display_currency.

	customer_type/customer_group/disabled manager-gated (segmentasi B2B
	"Company + group B2B" ditanda dari sini). Semua melalui doc.save()
	penuh — autoname Customer = naming_series, jadi tukar customer_name
	TIDAK rename dokumen."""
	_require_customer_write()
	data = json.loads(values or "{}")
	if not isinstance(data, dict):
		frappe.throw(_("Invalid values."))
	name = data.get("name")
	if not name or not frappe.db.exists("Customer", name):
		frappe.throw(_("Customer {0} not found.").format(name or ""),
			frappe.DoesNotExistError)

	doc = frappe.get_doc("Customer", name)
	if data.get("customer_name") is not None:
		cn = str(data["customer_name"]).strip()
		if not cn:
			frappe.throw(_("Customer name cannot be empty."))
		doc.customer_name = cn
	if data.get("rc_display_currency") is not None:
		if frappe.get_meta("Customer").has_field("rc_display_currency"):
			doc.rc_display_currency = data["rc_display_currency"] or None
	# Medan struktur — manager sahaja.
	for f in ("customer_type", "customer_group", "disabled"):
		if data.get(f) is not None:
			_gate_customer_structural(f)
			doc.set(f, data[f])
	doc.flags.ignore_permissions = True
	doc.save()
	return {"status": "ok", "name": doc.name}


@frappe.whitelist()
def save_customer_contact(customer: str, contact: str = "",
                          email: str = "", phone: str = "") -> dict:
	"""Kemaskini email/telefon PRIMARY Contact customer — modal Contacts
	detail page.

	Email lama KEKAL sebagai row (dinyah-primary sahaja, corak
	_upsert_contact_primary portal_booking): resolusi portal
	Customer-by-email dan login sedia ada tidak putus. AKAUN login portal
	(User) TIDAK ditukar — ini maklumat kontak sahaja (nota sama
	update_end_customer_info). Telefon dinormalisasi ke format Frappe
	(+60-xxx, standardize_phone_to_hyphen)."""
	_require_customer_write()
	if not customer or not frappe.db.exists("Customer", customer):
		frappe.throw(_("Customer {0} not found.").format(customer or ""),
			frappe.DoesNotExistError)
	# Contact mesti benar-benar di-link kepada customer ini.
	link_filters = {"link_doctype": "Customer", "link_name": customer,
	                "parenttype": "Contact"}
	if contact:
		if not frappe.db.exists("Contact", contact) or not frappe.db.exists(
				"Dynamic Link", {**link_filters, "parent": contact}):
			frappe.throw(_("Contact {0} is not linked to this customer.").format(contact))
		contact_name = contact
	else:
		contact_name = frappe.db.get_value("Dynamic Link", link_filters, "parent")
		if not contact_name:
			frappe.throw(_("This customer has no contact record to update."))

	email = (email or "").strip().lower()
	phone = (phone or "").strip()
	if not email and not phone:
		frappe.throw(_("Nothing to update — provide email or phone."))
	if email and not frappe.utils.validate_email_address(email):
		frappe.throw(_("Please enter a valid email address."))

	from travel_booking.api._helpers import standardize_phone_to_hyphen
	from travel_booking.api.portal_booking import _upsert_contact_primary
	doc = frappe.get_doc("Contact", contact_name)
	if email:
		_upsert_contact_primary(doc, "email_ids", "email_id", email, "is_primary")
	if phone:
		_upsert_contact_primary(doc, "phone_nos", "phone", phone, "is_primary_phone")
	doc.flags.ignore_permissions = True
	doc.save()
	return {"status": "ok", "contact": contact_name}


@frappe.whitelist()
def save_customer_address(customer: str, values: str) -> dict:
	"""Cipta/kemaskini alamat BILLING customer — modal Billing Address
	detail page. `values` JSON: address_line1, city, state, postcode,
	country.

	Helper yang SAMA dengan wizard checkout (_upsert_customer_billing_address):
	alamat 'Billing' sedia ada dikemaskini (bukan didupkan),
	is_primary_address=1, resolusi country case-insensitive, pointer
	customer_primary_address dikemaskini. Hook billing_address_sync
	(Address.on_update) MENYEBAR snapshot ke booking lain customer yang
	sama — sebab itu mutasi mesti doc.save() penuh, bukan raw write."""
	_require_customer_write()
	if not customer or not frappe.db.exists("Customer", customer):
		frappe.throw(_("Customer {0} not found.").format(customer or ""),
			frappe.DoesNotExistError)
	data = json.loads(values or "{}")
	if not isinstance(data, dict):
		frappe.throw(_("Invalid values."))
	if not (data.get("address_line1") or "").strip():
		frappe.throw(_("Address line 1 is required."))

	from travel_booking.api.so_helpers import _upsert_customer_billing_address
	address = _upsert_customer_billing_address(customer, data)
	return {"status": "ok", "address": address}
