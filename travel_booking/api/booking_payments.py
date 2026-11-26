# travel_booking/api/booking_payments.py
# PAYMENT ENTRY booking — Travel Manager › Booking Info (page booking order)
# ═══════════════════════════════════════════════════════════════════
# Customer yang membayar melalui Manual Transfer memuat naik bukti di
# portal → Payment Entry DRAFT (docstatus 0 — "Pending") dicipta oleh
# portal_payment.submit_manual_payment / _create_manual_payment_entry,
# bukti dilampirkan pada PE itu. Staf mengesahkan bukti lalu SUBMIT PE
# (docstatus 1 — "Verified"). Selama ini langkah itu hanya boleh dibuat
# pada borang Payment Entry Desk; modul ini bawanya ke page Booking Info:
#
#   1. REGISTER PAYMENT — staf merekod bayaran BARU diterima daripada
#      customer (walk-in / transfer) terus dari page: cipta PE draf
#      ber-alokasi ke SO outstanding booking (get_payment_registration_
#      context + register_booking_payment).
#   2. SUBMIT PAYMENT ENTRY — sahkan & submit PE draf (butang toolbar /
#      dialog senarai PE).
#
# SATU SUMBER KEBENARAN: endpoint di sini TIDAK mencipta/mengira apa-apa
# dokumen kewangan sendiri — Register membina PE dengan medan standard
# ERPNext (corak portal_payment.submit_manual_payment) dan Submit hanya
# memanggil pe.submit() (validasi & hook standard ERPNext + travel_booking
# tetap berjalan):
#   - resit emel customer (booking_engine._send_receipt_email)
#   - notifikasi Telegram PAYMENT VERIFIED (integrasi telegram)
#   - kira semula payment_status booking (_recompute_booking_status)

import json

import frappe
from frappe import _

from travel_booking.api.manage_trip_booking import (
	_booking_paylink_context,
	_def_cur,
	_f,
	_require_access,
)

# Status booking yang tidak lagi menerima bayaran — cermin
# booking_engine._assert_booking_payable (didefinisikan semula di sini
# untuk payload, tanpa import perulangan).
_NOT_PAYABLE_STATUSES = ("Cancelled", "Abandoned")


def _booking_so_names(booking: str) -> list:
	"""Nama SEMUA Sales Order yang didaftarkan pada booking (registri
	Booking.sales_orders — semua docstatus, susunan idx) — sumber kebenaran
	pautan SO ↔ booking, selari get_booking_profile."""
	return frappe.get_all(
		"Booking Sales Order",
		filters={"parenttype": "Booking", "parent": booking},
		pluck="sales_order",
		order_by="idx asc, sales_order asc",
	)


def _linked_payment_entry_names(so_names: list) -> list:
	"""Nama Payment Entry yang MERUJUK booking ini — melalui Sales Order
	dalam registri booking ATAU Sales Invoice yang dijana daripada SO itu
	(mekanisme "Get Advances Received" ERPNext mengalihkan rujukan PE dari
	SO ke SI). Peraturan sama dengan get_booking_profile (tab Documents)."""
	if not so_names:
		return []
	return [r[0] for r in frappe.db.sql("""
		SELECT DISTINCT pe.name
		FROM `tabPayment Entry` pe
		JOIN `tabPayment Entry Reference` per ON per.parent = pe.name
		WHERE (per.reference_doctype = 'Sales Order' AND per.reference_name IN %(sos)s)
		   OR (per.reference_doctype = 'Sales Invoice' AND per.reference_name IN (
		         SELECT DISTINCT sii.parent FROM `tabSales Invoice Item` sii
		         WHERE sii.sales_order IN %(sos)s))
	""", {"sos": tuple(so_names)})]


def _reference_currencies(so_names: list) -> tuple:
	"""Currency dokumen rujukan PE: ({nama SO: currency},
	{nama SI: currency}) — SI yang dijana daripada SO booking ini.
	PE mengikut currency dokumen yang dialokasikan."""
	so_cur = {d.name: d.currency for d in frappe.get_all(
		"Sales Order", filters={"name": ["in", so_names]},
		fields=["name", "currency"])}
	si_names = sorted(set(frappe.get_all(
		"Sales Invoice Item", filters={"sales_order": ["in", so_names]},
		pluck="parent")))
	si_cur = {d.name: d.currency for d in frappe.get_all(
		"Sales Invoice", filters={"name": ["in", si_names or ["__none__"]]},
		fields=["name", "currency"])}
	return so_cur, si_cur


def _parse_names(value) -> list:
	"""Senarai nama unik daripada payload frappe.call (array / JSON string /
	CSV). Nilai kosong dibuang."""
	if isinstance(value, str):
		try:
			value = json.loads(value)
		except (TypeError, ValueError):
			value = value.split(",")
	return list(dict.fromkeys(
		str(v).strip() for v in (value or []) if str(v or "").strip()))


def _pe_files(pe_names: list) -> dict:
	"""Lampiran (bukti bayaran) per Payment Entry — peta nama PE →
	[{name, file_name, file_url, is_image}] (selari payment_files dalam
	get_booking_profile)."""
	out = {}
	if not pe_names:
		return out
	img_exts = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")
	for f in frappe.get_all(
			"File",
			filters={"attached_to_doctype": "Payment Entry",
					 "attached_to_name": ["in", pe_names]},
			fields=["name", "file_name", "file_url", "file_type", "attached_to_name"],
			order_by="creation asc"):
		f_url = f.file_url or ""
		is_image = bool(f.file_type and str(f.file_type).startswith("image")) \
			or f_url.lower().endswith(img_exts)
		out.setdefault(f.attached_to_name, []).append({
			"name": f.name,
			"file_name": f.file_name or f_url.split("/")[-1],
			"file_url": f_url,
			"is_image": is_image,
		})
	return out


@frappe.whitelist()
def get_booking_payment_entries(booking: str = None) -> dict:
	"""Senarai Payment Entry SATU booking untuk dialog "Submit Payment
	Entry" pada page Booking Info.

	Semua docstatus dipulangkan (selari tab Documents); yang docstatus 0
	ditanda `pending` — calang untuk disahkan & disubmit. Jumlah tidak
	dikira semula di sini — diambil terus daripada dokumen PE (sumber
	kebenaran ERPNext).

	Return {booking, booking_number, booking_status, booking_payable,
	can_submit, pending_count, payment_entries}. `booking_payable` false
	untuk booking Cancelled/Abandoned (bayaran tidak lagi diterima — selari
	booking_engine._assert_booking_payable). `can_submit` = pengguna punya
	kebenaran submit Payment Entry.
	"""
	_require_access()
	if not booking or not frappe.db.exists("Booking", booking):
		frappe.throw(_("Booking {0} not found").format(booking or ""))

	so_names = _booking_so_names(booking)
	names = _linked_payment_entry_names(so_names)
	files = _pe_files(names)
	so_cur, si_cur = _reference_currencies(so_names)

	rows = frappe.get_all(
		"Payment Entry",
		filters={"name": ["in", names or ["__none__"]]},
		fields=["name", "docstatus", "posting_date", "reference_date",
				"reference_no", "mode_of_payment", "paid_to", "paid_amount",
				"paid_to_account_currency", "paid_from_account_currency",
				"party_type", "party", "company", "remarks", "owner",
				"creation", "modified"],
		order_by="posting_date desc, creation desc") if names else []
	refs = frappe.get_all(
		"Payment Entry Reference",
		filters={"parent": ["in", names or ["__none__"]]},
		fields=["parent", "reference_doctype", "reference_name", "allocated_amount"],
		order_by="parent asc, idx asc") if names else []

	status, booking_number = frappe.db.get_value(
		"Booking", booking, ["status", "booking_number"]) or ("", booking)
	status = status or ""
	booking_number = booking_number or booking
	doc_submit_perm = bool(frappe.has_permission("Payment Entry", "submit"))

	by_name = {}
	payment_entries = []
	for pe in rows:
		pending = int(pe.docstatus or 0) == 0
		row = {
			"name": pe.name,
			"docstatus": int(pe.docstatus or 0),
			"pending": pending,
			"posting_date": str(pe.posting_date or ""),
			"reference_date": str(pe.reference_date or ""),
			"reference_no": pe.reference_no or "",
			"mode_of_payment": pe.mode_of_payment or "",
			"paid_to": pe.paid_to or "",
			"paid_amount": float(pe.paid_amount or 0),
			"currency": pe.paid_to_account_currency or pe.paid_from_account_currency or "",
			"party": pe.party or "",
			"company": pe.company or "",
			"remarks": pe.remarks or "",
			"owner": pe.owner or "",
			"creation": str(pe.creation or ""),
			"references": [],
			"files": files.get(pe.name, []),
			# Kebenaran submit atas DOKUMEN ini (user permission + if_owner).
			"can_submit": pending and bool(frappe.has_permission(
				"Payment Entry", "submit",
				doc=frappe.get_doc("Payment Entry", pe.name))),
		}
		by_name[pe.name] = row
		payment_entries.append(row)

	for r in refs:
		row = by_name.get(r.parent)
		if not row:
			continue
		if r.reference_doctype == "Sales Order":
			ref_in_booking = r.reference_name in so_names
			cur = so_cur.get(r.reference_name)
		else:
			ref_in_booking = r.reference_name in si_cur
			cur = si_cur.get(r.reference_name)
		row["references"].append({
			"reference_doctype": r.reference_doctype,
			"reference_name": r.reference_name,
			"allocated_amount": float(r.allocated_amount or 0),
			"currency": cur or row["currency"],
			# Rujukan LUAR booking ini (satu PE boleh mengalokasikan beberapa
			# booking) — ditanda supaya staff tahu submit mempengaruhi
			# dokumen lain.
			"in_booking": bool(ref_in_booking),
		})

	pending_count = sum(1 for x in payment_entries if x["pending"])
	return {
		"booking": booking,
		"booking_number": booking_number,
		"booking_status": status,
		"booking_payable": status not in _NOT_PAYABLE_STATUSES,
		"can_submit": doc_submit_perm,
		"pending_count": pending_count,
		"payment_entries": payment_entries,
	}


def _fail_reason(e) -> str:
	"""Sebab kegagalan ringkas untuk payload `failed` — mesej frappe.throw
	diolah sebagai teks (bukan objek Exception mentah)."""
	msg = getattr(e, "message", None)
	if isinstance(msg, (list, tuple)):
		msg = " ".join(str(m) for m in msg)
	return str(msg or e)[:300]


@frappe.whitelist(methods=["POST"])
def submit_booking_payment_entries(booking: str = None,
								   payment_entries: "list | str" = None) -> dict:
	"""Sahkan & submit Payment Entry (draft) customer bagi SATU booking —
	butang "Submit Payment Entry" page Booking Info.

	Kebenaran DUA lapis: peranan page (_require_access) + kebenaran submit
	Payment Entry framework (Tour Manager / Accounts Manager / System
	Manager — Tour Operator & Accounts User tidak). Setiap PE diproses
	asing dalam savepoint — kegagalan satu TIDAK membatalkan yang lain;
	hasil dilaporkan per PE (corak bulk_update_bookings).

	Pra-syarat SEBELUM sebarang submit (semua gagal jika dilanggar):
	  - setiap PE mesti MERUJUK booking ini (SO registri / SI daripadanya)
	  - booking mesti masih aktif (bukan Cancelled/Abandoned)
	PE yang bukan draft dilangkau (skipped).

	Return {booking, submitted, skipped, failed}.
	"""
	_require_access()
	if not booking or not frappe.db.exists("Booking", booking):
		frappe.throw(_("Booking {0} not found").format(booking or ""))
	names = _parse_names(payment_entries)
	if not names:
		frappe.throw(_("No payment entry selected"))
	if not frappe.has_permission("Payment Entry", "submit"):
		frappe.throw(_("No permission to submit Payment Entry"), frappe.PermissionError)

	# Semak KESEMUA pilihan dahulu — tiada sebarang submit jika ada PE yang
	# bukan milik booking ini (elak separuh berjaya atas permintaan salah).
	linked = set(_linked_payment_entry_names(_booking_so_names(booking)))
	foreign = [n for n in names if n not in linked]
	if foreign:
		frappe.throw(_("Payment Entry not linked to this booking: {0}").format(
			", ".join(foreign)))

	from travel_booking.api.booking_engine import _assert_booking_payable
	_assert_booking_payable(booking)

	submitted, skipped, failed = [], [], []
	for i, name in enumerate(names):
		pe = frappe.get_doc("Payment Entry", name)
		if pe.docstatus != 0:
			skipped.append({"name": name,
							"reason": _("Only a draft Payment Entry can be submitted")})
			continue
		if not frappe.has_permission("Payment Entry", "submit", doc=pe):
			failed.append({"name": name,
						   "reason": _("No permission to submit Payment Entry {0}").format(name)})
			continue
		sp = f"bkg_pe_{i}"
		frappe.db.savepoint(sp)
		n_msgs = len(frappe.message_log)
		try:
			pe.submit()
			submitted.append(name)
		except Exception as e:
			frappe.db.rollback(save_point=sp)
			# Mesej yang di-throw dalam pe.submit() dilaporkan melalui
			# `failed` — buang daripada message_log supaya klien tidak
			# terima msgprint ralat kedua di atas ringkasan hasil.
			del frappe.message_log[n_msgs:]
			failed.append({"name": name, "reason": _fail_reason(e)})

	return {"booking": booking, "submitted": submitted,
			"skipped": skipped, "failed": failed}


# ══════════════════════════════════════════════
# REGISTER PAYMENT — rekod bayaran BARU diterima daripada customer
# ══════════════════════════════════════════════

def _draft_reserved_by_so(so_names: list) -> dict:
	"""Jumlah alokasi dalam Payment Entry DRAFT (docstatus 0) yang merujuk
	SO yang diberi — peta {nama SO: jumlah}.

	Baki "efektif" sesuatu SO = balance − reserved: SO.advance_paid hanya
 dikira PE *submitted*, jadi tanpa pengiraan ini dua draf berasingan boleh
	melampaui baki sebenar dan mengelirukan staff (ERPNext sendiri hanya
	menolak semasa data terkini dikira dengan PE yang telah submit)."""
	if not so_names:
		return {}
	rows = frappe.db.sql("""
		SELECT per.reference_name AS so, SUM(per.allocated_amount) AS reserved
		FROM `tabPayment Entry Reference` per
		JOIN `tabPayment Entry` pe ON pe.name = per.parent
		WHERE pe.docstatus = 0 AND per.reference_doctype = 'Sales Order'
		  AND per.reference_name IN %(sos)s
		GROUP BY per.reference_name
	""", {"sos": tuple(so_names)}, as_dict=True)
	return {r.so: _f(r.reserved) for r in rows}


def _parse_allocations(value) -> dict:
	"""Alokasi {nama SO: jumlah} daripada payload frappe.call — terima
	dict, senarai [{sales_order, amount}] atau JSON string. Baris tanpa
	nama / jumlah ≤ 0 dibuang."""
	if isinstance(value, str):
		try:
			value = json.loads(value)
		except (TypeError, ValueError):
			value = None
	items = []
	if isinstance(value, dict):
		items = value.items()
	elif isinstance(value, list):
		items = ((a.get("sales_order") or a.get("name"), a.get("amount"))
				 for a in value if isinstance(a, dict))
	out = {}
	for so, amt in items:
		so = str(so or "").strip()
		try:
			amt = round(float(amt), 2)
		except (TypeError, ValueError):
			continue
		if so and amt > 0:
			out[so] = amt
	return out


def _default_paid_to(currency: str, company: str) -> str:
	"""Akaun bank lalai untuk satu currency — baris Travel Settings
	(Multi Currency Account) dahulu, fallback akaun Bank pertama company
	(corak portal_payment.submit_manual_payment)."""
	settings = frappe.get_cached_doc("Travel Settings")
	for row in (settings.get("currency_accounts") or []):
		if row.currency == currency and row.manual_transfer_paid_to_account:
			return row.manual_transfer_paid_to_account
	return frappe.db.get_value(
		"Account", {"company": company, "account_type": "Bank",
					"is_group": 0, "account_currency": currency, "disabled": 0},
		"name") or ""


BOOKING_STATUS_OPTIONS = ("Pending", "Accepted", "Processing", "Confirmed",
						  "Completed", "Abandoned", "Cancelled")


@frappe.whitelist(methods=["POST"])
def set_booking_status(booking: str = None, status: str = None) -> dict:
	"""Tukar status booking terus dari page Booking Info — butang "Status"
	toolbar. doc.save() PENUH supaya hook on_booking_update berjalan:
	cascade Cancelled/Abandoned (batalkan SO/PR belum bayar), emel
	Processing/Confirmed, sebar status ke reservation.

	Gate: peranan page (MANAGE_TRIP_ROLES) + Tour Manager/System Manager
	sahaja — amalan "approvals" yang didokumen pada kepala page
	(travel_manager.js), kerana Cancelled/Abandoned menjalankan cascade.
	Return {booking, status, changed, payment_status}.
	"""
	_require_access()
	user_roles = frappe.get_roles()
	if not ("Tour Manager" in user_roles or "System Manager" in user_roles):
		frappe.throw(_("Only Tour Manager / System Manager can update the booking status here."),
					 frappe.PermissionError)
	if not booking or not frappe.db.exists("Booking", booking):
		frappe.throw(_("Booking {0} not found").format(booking or ""))
	status = (status or "").strip()
	if status not in BOOKING_STATUS_OPTIONS:
		frappe.throw(_("Invalid booking status: {0}").format(status or "—"))

	b = frappe.get_doc("Booking", booking)
	changed = (b.status or "") != status
	if changed:
		b.status = status
		b.save(ignore_permissions=True)
	return {"booking": booking, "status": status, "changed": changed,
			"payment_status": frappe.db.get_value("Booking", booking, "payment_status")}


@frappe.whitelist()
def get_payment_registration_context(booking: str = None) -> dict:
	"""Konteks dialog "Register Payment" pada page Booking Info — SO
	outstanding booking (dengan BAKI EFEKTIF: baki − alokasi PE draf lain
	yang belum disahkan), pilihan akaun Bank/Cash per currency (lalai =
	Travel Settings), Mode of Payment, dan kebenaran submit pengguna.

	Return {booking, booking_number, customer, customer_name, company,
	booking_status, booking_payable, sos, accounts_by_currency, modes,
	can_submit, today}.
	"""
	_require_access()
	if not booking or not frappe.db.exists("Booking", booking):
		frappe.throw(_("Booking {0} not found").format(booking or ""))

	from travel_booking.api.manage_trip_booking import (
		_booking_paylink_context,
		_def_cur,
		_f,
	)
	b, sos = _booking_paylink_context(booking)
	outstanding = [so for so in sos if _f(so.balance) > 0.009]
	reserved = _draft_reserved_by_so([so.name for so in outstanding])

	company = frappe.db.get_value("Booking", booking, "company") \
		or frappe.db.get_single_value("Global Defaults", "default_company")
	status, customer = frappe.db.get_value(
		"Booking", booking, ["status", "customer"]) or ("", booking)

	sos_out = []
	for so in outstanding:
		effective = max(round(_f(so.balance) - reserved.get(so.name, 0), 2), 0.0)
		sos_out.append({
			"name": so.name,
			"is_addon": bool(so.custom_booking_addon),
			"currency": so.currency or _def_cur(),
			"grand_total": _f(so.grand_total),
			"advance_paid": _f(so.advance_paid),
			"balance": _f(so.balance),
			"reserved": reserved.get(so.name, 0),
			"effective_balance": effective,
		})

	currencies = sorted({row["currency"] for row in sos_out})
	accounts_by_currency = {}
	for cur in currencies:
		opts = [{"name": a.name,
				 "label": f"{a.account_name} ({a.account_type})",
				 "account_type": a.account_type}
				for a in frappe.get_all(
					"Account",
					filters={"company": company, "is_group": 0, "disabled": 0,
							 "account_type": ["in", ["Bank", "Cash"]],
							 "account_currency": cur},
					fields=["name", "account_name", "account_type", "account_currency"],
					order_by="account_type desc, account_name asc")]
		default = _default_paid_to(cur, company)
		if default and default not in [o["name"] for o in opts]:
			d = frappe.db.get_value("Account", default,
				["account_name", "account_type"], as_dict=True)
			if d:
				opts.insert(0, {"name": default,
								"label": f"{d.account_name} ({d.account_type})",
								"account_type": d.account_type})
		accounts_by_currency[cur] = {
			"options": opts,
			"default": default or (opts[0]["name"] if opts else ""),
		}

	return {
		"booking": booking,
		"booking_number": b.booking_number or booking,
		"customer": b.customer or "",
		"customer_name": frappe.db.get_value("Customer", b.customer,
											 "customer_name") or b.customer or "",
		"company": company,
		"booking_status": status,
		"booking_payable": status not in _NOT_PAYABLE_STATUSES,
		"sos": sos_out,
		"accounts_by_currency": accounts_by_currency,
		"modes": frappe.get_all("Mode of Payment", filters={"enabled": 1},
								pluck="name", order_by="name"),
		"can_submit": bool(frappe.has_permission("Payment Entry", "submit")),
		"today": frappe.utils.today(),
	}


def _attach_payment_files(pe_name: str, attachments) -> int:
	"""Simpan lampiran bukti (resit bank) daripada dialog Register Payment
	sebagai File PERIBADI dilampirkan pada Payment Entry — corak sama dengan
	portal_payment.submit_manual_payment: base64 data-URI disahkan melalui
	magic bytes (JPG/PNG/PDF; PDF dirender halaman 1 ke PNG) oleh
	upload_normalize._decode_and_normalize_upload. Cap 5 fail.
	Return bilangan fail yang disimpan."""
	if isinstance(attachments, str):
		try:
			attachments = json.loads(attachments)
		except (TypeError, ValueError):
			frappe.throw(_("Invalid attachment payload"))
	if not isinstance(attachments, list):
		return 0
	from travel_booking.utils.upload_normalize import _decode_and_normalize_upload
	count = 0
	for a in attachments[:5]:
		if not isinstance(a, dict):
			continue
		filedata = str(a.get("filedata") or "")
		filename = str(a.get("filename") or "").strip()
		if not filedata or not filename:
			continue
		content, filename = _decode_and_normalize_upload(filedata, filename, label="receipt")
		frappe.get_doc({
			"doctype": "File",
			"file_name": filename,
			"attached_to_doctype": "Payment Entry",
			"attached_to_name": pe_name,
			"is_private": 1,
			"content": content,
		}).insert(ignore_permissions=True)
		count += 1
	return count


@frappe.whitelist(methods=["POST"])
def register_booking_payment(booking: str = None,
							 allocations: "list | dict | str" = None,
							 paid_to: str = None, mode_of_payment: str = None,
							 reference_no: str = None, reference_date: str = None,
							 remarks: str = None, submit_now: bool = False,
							 attachments: "list | str" = None) -> dict:
	"""Rekod bayaran BARU diterima daripada customer (desk) — cipta
	Payment Entry DRAFT ("Pending") terus dari page Booking Info, dengan
	alokasi ke SO outstanding booking (corak medan sama dengan
	portal_payment.submit_manual_payment).

	allocations: {nama SO: jumlah} atau [{sales_order, amount}] — setiap
	jumlah mesti 0 < x ≤ BAKI EFEKTIF SO itu (baki − alokasi PE draf lain
	yang belum disahkan). Semua SO terpilih wajib SATU currency.

	paid_to (opsyenal) — akaun Bank/Cash penerimaan; kosong = default
	Travel Settings untuk currency itu. mode_of_payment (opsyenal).
	submit_now — sah & submit serta-merta (perlukan kebenaran submit;
	resit emel + notifikasi dihantar oleh hook standard).
	attachments (opsyenal) — [{filedata: data-URI base64, filename}] bukti
	resit; disimpan sebagai File PERIBADI pada PE (JPG/PNG/PDF, cap 5 fail —
	corak sama dengan upload bukti portal).

	Return {name, docstatus, submitted, amount, currency, files, warning?}.
	`warning` diisi bila submit_now gagal — PE kekal sebagai draf.
	"""
	_require_access()
	if not booking or not frappe.db.exists("Booking", booking):
		frappe.throw(_("Booking {0} not found").format(booking or ""))
	if not frappe.has_permission("Payment Entry", "create"):
		frappe.throw(_("No permission to create Payment Entry"), frappe.PermissionError)
	# ERPNext memeriksa kebenaran BACA Account secara eksplisit semasa
	# validate (party/bank account) — semak awal dengan mesej jelas, kerana
	# peranan page ada yang tanpa akses Accounts (cth. Tour Operator sahaja).
	if not frappe.has_permission("Account", "read"):
		frappe.throw(_("You need Accounts access to register payments — "
					   "ask an administrator for the Accounts User role."),
					 frappe.PermissionError)
	if submit_now and not frappe.has_permission("Payment Entry", "submit"):
		frappe.throw(_("No permission to submit Payment Entry — register as draft instead."),
					 frappe.PermissionError)

	from travel_booking.api.so_helpers import _safe_date

	allocs = _parse_allocations(allocations)
	if not allocs:
		frappe.throw(_("No Sales Order selected."))

	from travel_booking.api.booking_engine import _assert_booking_payable
	_assert_booking_payable(booking)

	b, sos = _booking_paylink_context(booking)
	outstanding = {so.name: so for so in sos if _f(so.balance) > 0.009}
	invalid = [s for s in allocs if s not in outstanding]
	if invalid:
		frappe.throw(_("These Sales Orders are not outstanding for this booking "
					   "(already paid or cancelled): {0} — refresh and try again.")
					 .format(", ".join(invalid)))

	# Semak semula baki efektif DI SERVER (baki − rizab draf lain) — nilai
	# dari klien tidak dipercayai.
	reserved = _draft_reserved_by_so(list(allocs))
	currency = None
	total = 0.0
	refs = []
	for so_name, amount in allocs.items():
		so = outstanding[so_name]
		effective = max(round(_f(so.balance) - reserved.get(so_name, 0), 2), 0.0)
		if amount > effective + 0.009:
			frappe.throw(_("Allocation for {0} ({1}) exceeds its available balance ({2} — "
						   "outstanding {3} less {4} already reserved by draft payments).")
						 .format(so_name, amount, effective, _f(so.balance),
								 reserved.get(so_name, 0)))
		so_cur = so.currency or _def_cur()
		if currency is None:
			currency = so_cur
		elif so_cur != currency:
			frappe.throw(_("Selected Sales Orders use different currencies ({0}, {1}) — "
						   "one Payment Entry must be single-currency. Register them separately.")
						 .format(currency, so_cur))
		total = round(total + amount, 2)
		refs.append({"reference_doctype": "Sales Order",
					 "reference_name": so_name,
					 "allocated_amount": amount})

	company = frappe.db.get_value("Booking", booking, "company") \
		or frappe.db.get_single_value("Global Defaults", "default_company")
	if not paid_to:
		paid_to = _default_paid_to(currency, company)
	if not paid_to:
		frappe.throw(_("No Bank/Cash account is configured for currency {0} — "
					   "set it in Travel Settings (Multi Currency Account).").format(currency))
	acc = frappe.db.get_value("Account", paid_to,
		["name", "company", "is_group", "account_currency", "disabled"], as_dict=True)
	if not acc or acc.disabled:
		frappe.throw(_("Account {0} not found").format(paid_to))
	if acc.is_group or acc.company != company:
		frappe.throw(_("Account {0} is not a valid Bank/Cash account of {1}.").format(paid_to, company))
	if acc.account_currency != currency:
		frappe.throw(_("Account {0} currency ({1}) does not match the payment currency ({2}).")
					 .format(paid_to, acc.account_currency, currency))

	from erpnext.accounts.party import get_party_account
	party_account = get_party_account("Customer", b.customer, company)

	reference_date = _safe_date(reference_date)
	primary_so = next(iter(allocs))
	pe = frappe.get_doc({
		"doctype": "Payment Entry",
		"payment_type": "Receive",
		"company": company,
		"posting_date": reference_date or frappe.utils.today(),
		"party_type": "Customer",
		"party": b.customer,
		"party_account": party_account,
		"paid_from": party_account,
		"paid_to": paid_to,
		"paid_amount": total,
		"received_amount": total,
		"reference_no": (reference_no or "").strip() or primary_so,
		"reference_date": reference_date or frappe.utils.today(),
		"mode_of_payment": (mode_of_payment or "").strip() or None,
		"remarks": (remarks or "").strip()
			or f"Payment registered from Booking {b.booking_number or booking} ({primary_so}).",
	})
	for r in refs:
		pe.append("references", r)
	pe.insert(ignore_permissions=True)

	# Lampiran bukti — SEBELUM blok submit_now supaya fail kekal pada PE
	# draf walaupun submit gagal dan di-rollback ke savepoint.
	files_count = _attach_payment_files(pe.name, attachments)

	# submit_now — sah serta-merta; kegagalan validasi ERPNext → rollback ke
	# savepoint: PE KEKAL sebagai draf (disimpan bersama request) dan sebab
	# dilaporkan melalui `warning`, bukan gagal penuh.
	submitted = False
	warning = None
	if submit_now:
		frappe.db.savepoint("reg_pe")
		n_msgs = len(frappe.message_log)
		try:
			pe.submit()
			submitted = True
		except Exception as e:
			frappe.db.rollback(save_point="reg_pe")
			del frappe.message_log[n_msgs:]
			warning = _fail_reason(e)

	return {"name": pe.name, "docstatus": int(pe.docstatus), "submitted": submitted,
			"amount": total, "currency": currency, "files": files_count,
			**({"warning": warning} if warning else {})}

