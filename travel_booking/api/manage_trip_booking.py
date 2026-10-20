# travel_booking/api/manage_trip_booking.py
# Backend API untuk page /app/manage-trip-booking (Manage Trip & Booking)
#
# Struktur page:
# - Senarai Trip Group Date (collapsible), diumpuk mengikut Group Batch
#   (tgd.group_batch) bila ada — satu baris accordion = satu batch.
# - Bila di-expand, paparan tab:
#     1. Dashboard  — number card + pecahan (bilik, diskaun, status,
#                     umur, jantina, titik perlepasan)
#     2. Booking    — senarai booking + carian/filter + row limit
#     3. Traveller  — senarai traveller ikut Booking Reservation
#     4. Rooming    — senarai bilik ikut room_id + occupant
#
# Sumber data:
# - Kewangan (revenue/collected): Sales Order via custom_booking —
#  grand_total ialah nilai booking, advance_paid ialah jumlah terbayar.
#   (Booking.total_amount belum wujud sebagai kolum di DB lama.)
# - Diskaun: kolum Booking.voucher_discount / price_rule_discount /
#   referral_discount + Voucher Usage untuk bilangan penggunaan voucher.
# - Bilik: Booking Reservation — satu bilik = room_id (fallback
#   booking + cabin_no), kategori bilik pada room_category.
# - Umur/jantina traveller: snapshot pada Booking Reservation
#   (traveller_datebirth / traveller_gender), fallback ke doctype
#   Traveller (date_of_birth / gender).
#
# CURRENCY-SENSITIVE: SO booking (utama mahupun addon) boleh wujud dalam
# currency berbeza (paksi currency multi-company — rujuk
# currency_axis.py; tiada conversion antara currency). SEMUA agregat
# wang (revenue/collected/balance/diskaun/addon) dikira BERASINGAN
# mengikut currency dan dipulangkan sebagai pecahan `*_by_currency`
# ([]-shaped) — JANGAN jumlah nilai merentas currency. Field scalar
# (cth finance.revenue) hanya diisi bila SEMUA nilai dalam SATU
# currency sahaja; bila bercampur, scalar = None dan frontend papar
# pecahan per currency.
#
# Setiap pecahan turut dianotasi kadar tukaran (rate_to_default) dan
# nilai bersamaan default currency (Travel Settings.default_currency,
# fallback currency company default) — `*_default` + `default_totals`
# (jumlah keseluruhan). Kadar datang dari doctype Currency Exchange
# (nilai semasa, best-effort; tiada kadar → null dan jumlah ditanda
# rates_complete=false). Frontend papar breakdown native + jumlah "~".

import json
from datetime import date

import frappe
from frappe import _
from frappe.utils import getdate

from travel_booking.api.constants import DEFAULT_CURRENCY
from travel_booking.api.currency_axis import get_rate_to_default

# Roles yang dibenarkan akses page ni — selari dengan booking_hub.py
MANAGE_TRIP_ROLES = ["System Manager", "Tour Manager", "Tour Operator", "Accounts User"]

# Status dokumen yang dianggap SELESAI (bukan pending action).
DOC_STATUS_DONE = ("Verified", "Valid")

# ── Semantik kiraan dokumen (verified / submitted / pending) ──
# - docs_submitted — booking reservation BERPAUT dengan Traveller
#   (br.traveller): slot yang traveller dah isi hantar maklumat dokumen
#   (passport/IC) melalui portal. Slot placeholder tanpa Traveller belum
#   menghantar apa-apa.
# - docs_verified — Traveller berpaut itu sendiri berstatus dokumen
#   Verified/Valid (t.status — sumber kebenaran; document_status pada
#   reservation hanyalah cermin yang boleh tertinggal).
# - pending_docs — SEMUA yang belum verified (termasuk slot tanpa
#   Traveller) = pax - docs_verified.
_SUBMITTED_EXPR = "IFNULL(br.traveller, '') != ''"
_VERIFIED_EXPR = "IFNULL(t.status, '') IN %(done)s"

# Status booking yang TIDAK dikira dalam semua agregat (revenue, pax,
# bilik, occupancy, dll.) — Cancelled dibatalkan, Abandoned ialah
# checkout yang tidak pernah selesai. Breakdown status booking kekal
# memaparkan semua status (tujuannya untuk nampak kiraan penuh).
EXCLUDED_BOOKING_STATUSES = ("Cancelled", "Abandoned")

# Kunci identiti satu bilik: room_id kalau ada, kalau tak fallback ke
# gabungan booking + cabin_no (mirror assign_room_id() pada doctype).
_ROOM_KEY = (
	"COALESCE(NULLIF(br.room_id, ''), CONCAT(br.booking, '-Room_', IFNULL(br.cabin_no, 0)))"
)

@frappe.whitelist()
def assign_group_batch(trip_groups: list = None, group_batch: str = None) -> dict:
	"""Assign (atau re-assign) Group Batch pada senarai Trip Group Date —
	mengumpulkan beberapa group date menjadi satu baris batch dalam page
	Manage Trip & Booking. group_batch kosong = keluarkan group daripada
	batch.

	Dipanggil dari butang "Assign Group Batch" (toolbar) selepas user
	tick baris group/batch dalam datatable.
	"""
	_require_access()

	names = _parse_groups(None, trip_groups)
	# Nama batch dipiawaikan uppercase — elak duplikasi mixed-case.
	batch = (group_batch or "").strip().upper()

	for name in names:
		if not frappe.has_permission("Trip Group Date", "write", doc=name):
			frappe.throw(
				_("No permission to write Trip Group Date {0}").format(name),
				frappe.PermissionError,
			)
		frappe.db.set_value("Trip Group Date", name, "group_batch", batch)

	return {"updated": names, "group_batch": batch}


def _require_access():
	"""Gate permission — page ni terdedah pada PII traveller (IC/passport)."""
	if not frappe.session.user or frappe.session.user == "Guest":
		frappe.throw(_("Please login to access this page"), frappe.PermissionError)

	user_roles = frappe.get_roles()
	if not any(role in MANAGE_TRIP_ROLES for role in user_roles):
		frappe.throw(
			_("You do not have permission to access this page. Required roles: {0}").format(
				", ".join(MANAGE_TRIP_ROLES)
			),
			frappe.PermissionError,
		)


def _f(num):
	"""float() selamat untuk nilai NULL dari SQL."""
	try:
		return float(num or 0)
	except (TypeError, ValueError):
		return 0.0


def _i(num):
	"""int() selamat untuk nilai NULL/Decimal dari SQL."""
	try:
		return int(num or 0)
	except (TypeError, ValueError):
		return 0


def _s(val):
	"""str() selamat untuk nilai DATE/None dari SQL (untuk JSON)."""
	if val in (None, ""):
		return ""
	if isinstance(val, (date,)):
		return str(val)
	return str(val)


def _parse_groups(trip_group: str = None, trip_groups=None):
	"""Normalize input group (single / list / JSON string) kepada senarai
	nama Trip Group Date yang sah. Satu batch = beberapa group.
	"""
	names = []
	if trip_groups:
		if isinstance(trip_groups, str):
			try:
				trip_groups = json.loads(trip_groups)
			except ValueError:
				trip_groups = [g.strip() for g in trip_groups.split(",") if g.strip()]
		names = [str(g) for g in trip_groups if g]
	elif trip_group:
		names = [str(trip_group)]

	if not names:
		frappe.throw(_("Trip Group Date is required"))

	valid = frappe.get_all("Trip Group Date",
		filters={"name": ["in", names]}, pluck="name")
	if not valid:
		frappe.throw(_("Trip Group Date {0} not found").format(", ".join(names[:3])))
	return valid


def _age_years(dob, ref) -> int:
	"""Umur penuh tahun pada tarikh rujukan (fallback hari ini)."""
	if not dob:
		return None
	ref = ref or date.today()
	dob = getdate(dob)
	return ref.year - dob.year - ((ref.month, ref.day) < (dob.month, dob.day))


def _age_bucket(years) -> str:
	"""Kategori umur: <2 = Infant, <12 = Child, lain = Adult."""
	if years is None:
		return "Unknown"
	if years < 2:
		return "Infant"
	if years < 12:
		return "Child"
	return "Adult"


# ── Subquery agregat berkongsi antara endpoints ────────────────────

def _def_cur() -> str:
	"""Currency fallback untuk nilai tanpa currency (SO.currency kosong) —
	default currency paksi currency, fallback MYR."""
	try:
		from travel_booking.api.currency_axis import get_default_currency
		return get_default_currency() or DEFAULT_CURRENCY
	except Exception:
		return DEFAULT_CURRENCY


def _sort_cur_rows(rows):
	"""Susun pecahan per-currency: default currency dulu, lain ikut abjad."""
	default = _def_cur()
	return sorted(rows, key=lambda r: (r.get("currency") != default, r.get("currency") or ""))


def _annotate_default(rows, fields):
	"""Annot pecahan per-currency dengan kadar tukaran + nilai bersamaan
	default currency (nilai semasa, best-effort), dan kira `default_totals`
	— jumlah keseluruhan dalam default currency.

	Setiap row dapat: rate_to_default (1.0 untuk default currency, null
	bila tiada kadar), <field>_default, dan rate_date bila ada. Return:
	{currency, rates_complete, <field>=jumlahConverted} — rates_complete
	false bila ada currency tanpa kadar (jumlah = pecahan yang sempat
	ditukar sahaja; frontend tandakan dengan '~').
	"""
	totals = {"currency": _def_cur(), "rates_complete": True}
	for r in rows:
		rate, rate_date = get_rate_to_default(r.get("currency"))
		r["rate_to_default"] = rate
		if rate_date:
			r["rate_date"] = rate_date
		if rate is None:
			totals["rates_complete"] = False
			continue
		for f in fields:
			conv = round(_f(r.get(f)) * rate, 2)
			r[f + "_default"] = conv
			totals[f] = round(totals.get(f, 0.0) + conv, 2)
	for f in fields:
		totals.setdefault(f, 0.0)
	return totals


# Currency SO UTAMA (terawal) booking — axis currency untuk field
# diskaun pada Booking (voucher/price_rule/referral_discount,
# pre_discount_total), sama seperti property Booking.currency.
_PRIMARY_SO_CUR = (
	"(SELECT so2.currency FROM `tabSales Order` so2 "
	"WHERE so2.custom_booking = b.name AND so2.docstatus = 1 "
	"ORDER BY so2.creation ASC, so2.name ASC LIMIT 1)"
)

# Nilai wang per (booking, currency) — gross = grand_total, paid =
# advance_paid. SESUATU booking boleh ada SO dalam LEBIH DARPA SATU
# currency (addon boleh dibeli dalam currency lain), jadi SEMUA jumlah
# mesti dipecahkan ikut currency — jangan jemput hasil query ni
# terus ke satu scalar.
_SO_PER_BOOKING_CUR = """
	(SELECT so.custom_booking AS booking,
	        COALESCE(NULLIF(so.currency, ''), %(def_cur)s) AS currency,
	        SUM(so.grand_total) AS gross, SUM(so.advance_paid) AS paid
	 FROM `tabSales Order` so
	 WHERE so.docstatus = 1 AND so.custom_booking IS NOT NULL
	 GROUP BY so.custom_booking,
	          COALESCE(NULLIF(so.currency, ''), %(def_cur)s)) soc
"""

_RES_PER_BOOKING = f"""
	(SELECT br.booking,
	        COUNT(*) AS pax,
	        COUNT(DISTINCT {_ROOM_KEY}) AS rooms,
	        SUM(CASE WHEN NOT ({_VERIFIED_EXPR}) THEN 1 ELSE 0 END) AS pending_docs,
	        SUM(CASE WHEN {_SUBMITTED_EXPR} THEN 1 ELSE 0 END) AS docs_submitted,
	        SUM(CASE WHEN {_VERIFIED_EXPR} THEN 1 ELSE 0 END) AS docs_verified
	 FROM `tabBooking Reservation` br
	 LEFT JOIN tabTraveller t ON t.name = br.traveller
	 WHERE br.status != 'Cancelled'
	 GROUP BY br.booking) res ON res.booking = b.name
"""


@frappe.whitelist()
def get_trip_groups(status: str = None, trip: str = None, search: str = None,
					view: str = "all") -> dict:
	"""Senarai Trip Group Date + agregat ringkas setiap group untuk header
	accordion (bookings/pax/rooms/revenue/balance/docs). Front-end akan
	umpuk group yang share group_batch ke dalam satu baris batch —
	satu SQL, tiada N+1.

	search = identiti group (nama/kod/batch/trip/ship) ATAU kandungan
	group: booking number/docname/customer, traveller (nama/passport),
	stateroom (no/room_id) — group yang ada padanan tersenarai.
	"""
	_require_access()

	conditions = ["1=1"]
	fmt = {}

	if status and status != "All":
		conditions.append("tgd.status = %(status)s")
		fmt["status"] = status
	if trip:
		conditions.append("tgd.trip = %(trip)s")
		fmt["trip"] = trip
	if search:
		# Skop carian: identiti group (nama/kod/batch/trip/ship) + kandungan
		# group — booking (nombor/docname/customer) via tabBooking, traveller
		# (nama/passport) & stateroom (no/room_id) via Booking Reservation.
		# Setiap EXISTS ikut semantik carian tab masing-masing: booking semua
		# status (selari tab Booking), traveller/stateroom bukan reservation
		# Cancelled + bukan booking Cancelled/Abandoned (selari tab
		# Traveller/Rooming) — group yang padan tersenarai dalam table.
		conditions.append("""(
			tgd.trip_group_name LIKE %(search)s OR tgd.trip LIKE %(search)s
			OR tgd.trip_name LIKE %(search)s OR tgd.name LIKE %(search)s
			OR tgd.group_batch LIKE %(search)s OR tgd.ship_name LIKE %(search)s
			OR EXISTS (
				SELECT 1 FROM tabBooking sb
				LEFT JOIN tabCustomer sc ON sc.name = sb.customer
				WHERE sb.trip_date = tgd.name
				  AND (sb.name LIKE %(search)s OR sb.booking_number LIKE %(search)s
					OR sb.customer LIKE %(search)s OR sc.customer_name LIKE %(search)s
					OR sb.cust_email LIKE %(search)s)
			)
			OR EXISTS (
				SELECT 1 FROM `tabBooking Reservation` sbr
				INNER JOIN tabBooking sb2 ON sb2.name = sbr.booking
				LEFT JOIN tabTraveller st ON st.name = sbr.traveller
				WHERE sb2.trip_date = tgd.name
				  AND sbr.status != 'Cancelled' AND sb2.status NOT IN %(excl)s
				  AND (sbr.traveller_full_name LIKE %(search)s OR st.full_name LIKE %(search)s
					OR sbr.traveller LIKE %(search)s
					OR sbr.traveller_passportno LIKE %(search)s OR st.passport_no LIKE %(search)s)
			)
			OR EXISTS (
				SELECT 1 FROM `tabBooking Reservation` sbr2
				INNER JOIN tabBooking sb3 ON sb3.name = sbr2.booking
				WHERE sb3.trip_date = tgd.name
				  AND sbr2.status != 'Cancelled' AND sb3.status NOT IN %(excl)s
				  AND (sbr2.stateroom_no LIKE %(search)s OR sbr2.room_id LIKE %(search)s)
			)
		)""")
		fmt["search"] = f"%{search}%"
	if view == "upcoming":
		conditions.append("COALESCE(tgd.departure_date, tgd.sailing_start) >= CURDATE()")
	elif view == "past":
		conditions.append("COALESCE(tgd.departure_date, tgd.sailing_start) < CURDATE()")

	where = " AND ".join(conditions)

	groups = frappe.db.sql(f"""
		SELECT
			tgd.name, tgd.trip_group_name, tgd.trip, tgd.trip_name, tgd.status AS group_status,
			tgd.departure_date, tgd.return_date, tgd.sailing_start, tgd.sailing_end,
			tgd.ship_name, tgd.is_a_cruise_trip, tgd.is_cruise_only,
			tgd.max_participants, tgd.current_participants,
			tgd.total_days, tgd.total_nights, tgd.group_organizer, tgd.group_batch,
			bk.booking_count, bk.cancelled_count,
			resv.pax, resv.rooms, resv.pending_docs, resv.docs_submitted, resv.docs_verified
		FROM `tabTrip Group Date` tgd
		LEFT JOIN (
			SELECT b.trip_date AS grp,
			       SUM(CASE WHEN b.status NOT IN %(excl)s THEN 1 ELSE 0 END) AS booking_count,
			       SUM(CASE WHEN b.status = 'Cancelled' THEN 1 ELSE 0 END) AS cancelled_count
			FROM tabBooking b
			GROUP BY b.trip_date
		) bk ON bk.grp = tgd.name
		LEFT JOIN (
			SELECT b.trip_date AS grp,
			       COUNT(*) AS pax,
			       COUNT(DISTINCT {_ROOM_KEY}) AS rooms,
			       SUM(CASE WHEN NOT ({_VERIFIED_EXPR}) THEN 1 ELSE 0 END) AS pending_docs,
			       SUM(CASE WHEN {_SUBMITTED_EXPR} THEN 1 ELSE 0 END) AS docs_submitted,
			       SUM(CASE WHEN {_VERIFIED_EXPR} THEN 1 ELSE 0 END) AS docs_verified
			FROM `tabBooking Reservation` br
			INNER JOIN tabBooking b ON b.name = br.booking AND b.status NOT IN %(excl)s
			LEFT JOIN tabTraveller t ON t.name = br.traveller
			WHERE br.status != 'Cancelled'
			GROUP BY b.trip_date
		) resv ON resv.grp = tgd.name
		WHERE {where}
		-- Susunan operasi: group upcoming paling hampir berangkat dulu,
		-- diikuti group lepas paling baru, group tanpa tarikh paling akhir.
		ORDER BY
			CASE
				WHEN COALESCE(tgd.departure_date, tgd.sailing_start) IS NULL THEN 2
				WHEN COALESCE(tgd.departure_date, tgd.sailing_start) >= CURDATE() THEN 0
				ELSE 1
			END ASC,
			ABS(DATEDIFF(COALESCE(tgd.departure_date, tgd.sailing_start), CURDATE())) ASC,
			tgd.name DESC
	""", {**fmt, "done": list(DOC_STATUS_DONE), "excl": list(EXCLUDED_BOOKING_STATUSES)}, as_dict=True)

	# ── Kewangan per (group, currency) — TIDAK boleh dicampur terus:
	# SO booking utama/addon boleh dalam currency berbeza (paksi
	# currency multi-company). Pecahan disimpan dalam revenue_by_currency.
	money_by_grp = {}
	for r in frappe.db.sql(f"""
		SELECT b.trip_date AS grp, soc.currency,
		       SUM(soc.gross) AS revenue, SUM(soc.paid) AS collected
		FROM tabBooking b
		INNER JOIN {_SO_PER_BOOKING_CUR} ON soc.booking = b.name
		WHERE b.status NOT IN %(excl)s
		GROUP BY b.trip_date, soc.currency
	""", {**fmt, "excl": list(EXCLUDED_BOOKING_STATUSES), "def_cur": _def_cur()}, as_dict=True):
		money_by_grp.setdefault(r.grp, []).append({
			"currency": r.currency,
			"revenue": _f(r.revenue),
			"collected": _f(r.collected),
		})

	out = []
	for g in groups:
		by_cur = _sort_cur_rows([
			{**m, "balance": round(m["revenue"] - m["collected"], 2)}
			for m in money_by_grp.get(g.name, [])
		])
		default_totals = _annotate_default(by_cur, ["revenue", "collected", "balance"])
		if len(by_cur) == 1:
			revenue = by_cur[0]["revenue"]
			collected = by_cur[0]["collected"]
			balance = by_cur[0]["balance"]
			currency = by_cur[0]["currency"]
		elif not by_cur:
			revenue, collected, balance, currency = 0.0, 0.0, 0.0, None
		else:
			# Bercampur currency — scalar dibiarkan None; frontend papar
			# pecahan per currency (jumlah buta currency ialah bug).
			revenue, collected, balance, currency = None, None, None, None
		out.append({
			"name": g.name,
			"trip_group_name": g.trip_group_name or g.name,
			"trip": g.trip or "",
			"trip_name": g.trip_name or "",
			"status": g.group_status or "",
			"departure_date": _s(g.departure_date),
			"return_date": _s(g.return_date),
			"sailing_start": _s(g.sailing_start),
			"sailing_end": _s(g.sailing_end),
			"ship_name": g.ship_name or "",
			"is_a_cruise_trip": bool(g.is_a_cruise_trip),
			"is_cruise_only": bool(g.is_cruise_only),
			"max_participants": _i(g.max_participants),
			"current_participants": _i(g.current_participants),
			"total_days": _i(g.total_days),
			"total_nights": _i(g.total_nights),
			"group_organizer": g.group_organizer or "",
			"group_batch": (g.group_batch or "").strip(),
			"booking_count": _i(g.booking_count),
			"cancelled_count": _i(g.cancelled_count),
			"pax": _i(g.pax),
			"rooms": _i(g.rooms),
			"revenue": revenue,
			"collected": collected,
			"balance": balance,
			"currency": currency,
			"revenue_by_currency": by_cur,
			"default_totals": default_totals,
			"pending_docs": _i(g.pending_docs),
			"docs_submitted": _i(g.docs_submitted),
			"docs_verified": _i(g.docs_verified),
		})

	return {"groups": out, "currency": _def_cur()}


@frappe.whitelist()
def get_group_dashboard(trip_group: str = None, trip_groups: list = None) -> dict:
	"""Dashboard summary penuh untuk satu Trip Group Date / satu batch
	(group_batch — beberapa group sekaligus). Dipanggil bila tab Dashboard
	item di-expand (lazy load).
	"""
	_require_access()
	groups = _parse_groups(trip_group, trip_groups)
	fmt = {"groups": groups, "done": list(DOC_STATUS_DONE),
		   "excl": list(EXCLUDED_BOOKING_STATUSES)}

	group_rows = frappe.get_all("Trip Group Date",
		filters={"name": ["in", groups]},
		fields=["name", "trip_group_name", "status", "departure_date", "return_date",
			"sailing_start", "sailing_end", "ship_name", "max_participants",
			"current_participants", "is_a_cruise_trip", "group_batch"],
		order_by="departure_date asc, sailing_start asc, name asc")

	# ── Kewangan: pecahan per currency — Sales Order booking group ni.
	# SO utama/addon boleh dalam currency berbeza; jumlah HANYA dalam
	# currency yang sama.
	rev_by_cur = _sort_cur_rows([
		{
			"currency": r.currency,
			"revenue": _f(r.revenue),
			"collected": _f(r.collected),
			"balance": round(_f(r.revenue) - _f(r.collected), 2),
			"collection_rate": round(_f(r.collected) / _f(r.revenue) * 100, 1) if _f(r.revenue) else 0,
		}
		for r in frappe.db.sql(f"""
			SELECT soc.currency, SUM(soc.gross) AS revenue, SUM(soc.paid) AS collected
			FROM tabBooking b
			INNER JOIN {_SO_PER_BOOKING_CUR} ON soc.booking = b.name
			WHERE b.trip_date IN %(groups)s AND b.status NOT IN %(excl)s
			GROUP BY soc.currency
		""", {**fmt, "def_cur": _def_cur()}, as_dict=True)
	])
	rev_default_totals = _annotate_default(rev_by_cur, ["revenue", "collected", "balance"])

	# Baki tak laras: bilangan booking (currency-agnostic) yang masih
	# berhutang mana-mana currency.
	unpaid = frappe.db.sql(f"""
		SELECT COUNT(*) AS unpaid_bookings FROM (
			SELECT b.name, SUM(soc.gross) AS gross, SUM(soc.paid) AS paid
			FROM tabBooking b
			INNER JOIN {_SO_PER_BOOKING_CUR} ON soc.booking = b.name
			WHERE b.trip_date IN %(groups)s AND b.status NOT IN %(excl)s
			GROUP BY b.name
		) x WHERE (x.gross - x.paid) > 0.009
	""", {**fmt, "def_cur": _def_cur()}, as_dict=True)[0]

	bookings_active = frappe.db.sql("""
		SELECT COUNT(*) AS c
		FROM tabBooking b
		WHERE b.trip_date IN %(groups)s AND b.status NOT IN %(excl)s
	""", fmt, as_dict=True)[0].c

	# Scalar legacy — hanya bila SATU currency (jangan campur buta).
	if len(rev_by_cur) == 1:
		revenue = rev_by_cur[0]["revenue"]
		collected = rev_by_cur[0]["collected"]
		balance = rev_by_cur[0]["balance"]
		collection_rate = rev_by_cur[0]["collection_rate"]
		currency = rev_by_cur[0]["currency"]
	elif not rev_by_cur:
		revenue, collected, balance, collection_rate, currency = 0.0, 0.0, 0.0, 0, None
	else:
		revenue, collected, balance, collection_rate, currency = None, None, None, None, None

	# ── Diskaun (field Booking — axis currency = currency SO utama
	# booking) — dipecah ikut currency. ──
	dsc_by_cur = _sort_cur_rows([
		{
			"currency": r.currency,
			"voucher": _f(r.voucher),
			"price_rule": _f(r.price_rule),
			"referral": _f(r.referral),
			"total": round(_f(r.voucher) + _f(r.price_rule) + _f(r.referral), 2),
			"pre_discount_total": _f(r.pre_discount_total),
		}
		for r in frappe.db.sql(f"""
			SELECT COALESCE(NULLIF({_PRIMARY_SO_CUR}, ''), %(def_cur)s) AS currency,
			       SUM(b.voucher_discount) AS voucher,
			       SUM(b.price_rule_discount) AS price_rule,
			       SUM(b.referral_discount) AS referral,
			       SUM(b.pre_discount_total) AS pre_discount_total
			FROM tabBooking b
			WHERE b.trip_date IN %(groups)s AND b.status NOT IN %(excl)s
			GROUP BY COALESCE(NULLIF({_PRIMARY_SO_CUR}, ''), %(def_cur)s)
		""", {**fmt, "def_cur": _def_cur()}, as_dict=True)
	])
	dsc_default_totals = _annotate_default(
		dsc_by_cur,
		["voucher", "price_rule", "referral", "total", "pre_discount_total"],
	)
	if len(dsc_by_cur) == 1:
		voucher_discount = dsc_by_cur[0]["voucher"]
		price_rule_discount = dsc_by_cur[0]["price_rule"]
		referral_discount = dsc_by_cur[0]["referral"]
		total_discount = dsc_by_cur[0]["total"]
		pre_discount_total = dsc_by_cur[0]["pre_discount_total"]
	elif not dsc_by_cur:
		voucher_discount = price_rule_discount = referral_discount = 0.0
		total_discount, pre_discount_total = 0.0, 0.0
	else:
		voucher_discount = price_rule_discount = referral_discount = None
		total_discount, pre_discount_total = None, None

	voucher_usage = frappe.db.sql("""
		SELECT COUNT(*) AS usage_count, COUNT(DISTINCT vu.voucher) AS voucher_count
		FROM `tabVoucher Usage` vu
		INNER JOIN tabBooking b ON b.name = vu.booking AND b.trip_date IN %(groups)s
		WHERE b.status NOT IN %(excl)s
	""", fmt, as_dict=True)[0]

	# ── Bilik: jumlah + pecahan kategori ──
	rooms_total = frappe.db.sql(f"""
		SELECT COUNT(DISTINCT {_ROOM_KEY}) AS rooms
		FROM `tabBooking Reservation` br
		INNER JOIN tabBooking b ON b.name = br.booking
		WHERE br.status != 'Cancelled' AND b.status NOT IN %(excl)s AND b.trip_date IN %(groups)s
	""", fmt, as_dict=True)[0].rooms

	rooms_by_category = frappe.db.sql(f"""
		SELECT IFNULL(NULLIF(br.room_category, ''), 'Unassigned') AS category,
		       COUNT(DISTINCT {_ROOM_KEY}) AS rooms,
		       COUNT(*) AS pax
		FROM `tabBooking Reservation` br
		INNER JOIN tabBooking b ON b.name = br.booking
		WHERE br.status != 'Cancelled' AND b.status NOT IN %(excl)s AND b.trip_date IN %(groups)s
		GROUP BY IFNULL(NULLIF(br.room_category, ''), 'Unassigned')
		ORDER BY rooms DESC
	""", fmt, as_dict=True)

	# ── Traveller / dokumen ──
	pax_info = frappe.db.sql(f"""
		SELECT COUNT(*) AS pax,
		       SUM(CASE WHEN {_VERIFIED_EXPR} THEN 1 ELSE 0 END) AS docs_ok,
		       SUM(CASE WHEN {_SUBMITTED_EXPR} THEN 1 ELSE 0 END) AS docs_submitted
		FROM `tabBooking Reservation` br
		INNER JOIN tabBooking b ON b.name = br.booking
		LEFT JOIN tabTraveller t ON t.name = br.traveller
		WHERE br.status != 'Cancelled' AND b.status NOT IN %(excl)s AND b.trip_date IN %(groups)s
	""", fmt, as_dict=True)[0]

	# ── Pecahan umur & jantina (snapshot br, fallback Traveller) ──
	# Umur dikira pada tarikh rujukan per traveller: tarikh cruise bila
	# cruise, kalau tak tarikh departure; fallback hari ini.
	age_breakdown_rows = frappe.db.sql(f"""
		SELECT bucket, COUNT(*) AS count FROM (
			SELECT
				CASE
					WHEN x.dob IS NULL THEN 'Unknown'
					WHEN TIMESTAMPDIFF(YEAR, x.dob, x.ref_date) < 2 THEN 'Infant'
					WHEN TIMESTAMPDIFF(YEAR, x.dob, x.ref_date) < 12 THEN 'Child'
					ELSE 'Adult'
				END AS bucket
			FROM (
				SELECT
					NULLIF(COALESCE(NULLIF(br.traveller_datebirth, '0000-00-00'), t.date_of_birth), '') AS dob,
					COALESCE(
						CASE WHEN br.is_a_cruise = 1 THEN NULLIF(br.cruise_start, '0000-00-00')
						     ELSE NULLIF(br.departure_date, '0000-00-00') END,
						CASE WHEN b.is_a_cruise_trip = 1 THEN NULLIF(b.cruise_start, '0000-00-00')
						     ELSE NULLIF(b.departure_date, '0000-00-00') END,
						NULLIF(tgd.sailing_start, '0000-00-00'),
						NULLIF(tgd.departure_date, '0000-00-00'),
						CURDATE()
					) AS ref_date
				FROM `tabBooking Reservation` br
				INNER JOIN tabBooking b ON b.name = br.booking
				INNER JOIN `tabTrip Group Date` tgd ON tgd.name = b.trip_date
				LEFT JOIN tabTraveller t ON t.name = br.traveller
				WHERE br.status != 'Cancelled' AND b.status NOT IN %(excl)s
				  AND b.trip_date IN %(groups)s
			) x
		) y
		GROUP BY bucket
	""", fmt, as_dict=True)

	gender_breakdown_rows = frappe.db.sql("""
		SELECT COALESCE(NULLIF(br.traveller_gender, ''), NULLIF(t.gender, ''), 'Unknown') AS gender,
		       COUNT(*) AS count
		FROM `tabBooking Reservation` br
		INNER JOIN tabBooking b ON b.name = br.booking
		LEFT JOIN tabTraveller t ON t.name = br.traveller
		WHERE br.status != 'Cancelled' AND b.status NOT IN %(excl)s AND b.trip_date IN %(groups)s
		GROUP BY COALESCE(NULLIF(br.traveller_gender, ''), NULLIF(t.gender, ''), 'Unknown')
		ORDER BY count DESC
	""", fmt, as_dict=True)

	# ── Status booking & payment ──
	booking_status = frappe.db.sql("""
		SELECT b.status, COUNT(*) AS count
		FROM tabBooking b
		WHERE b.trip_date IN %(groups)s
		GROUP BY b.status
	""", fmt, as_dict=True)

	payment_status = frappe.db.sql("""
		SELECT b.payment_status, COUNT(*) AS count
		FROM tabBooking b
		WHERE b.trip_date IN %(groups)s AND b.status NOT IN %(excl)s
		GROUP BY b.payment_status
	""", fmt, as_dict=True)

	# ── Affiliate — bilangan booking ikut Sales Partner (affiliate) ──
	affiliate_rows = frappe.db.sql("""
		SELECT b.affiliate, COUNT(*) AS count
		FROM tabBooking b
		WHERE b.trip_date IN %(groups)s AND b.status NOT IN %(excl)s
		  AND b.affiliate IS NOT NULL AND b.affiliate != ''
		GROUP BY b.affiliate
		ORDER BY count DESC
	""", fmt, as_dict=True)

	# ── Booking channel & checkout method (pie chart dashboard) ──
	channel_rows = frappe.db.sql("""
		SELECT b.booking_channel, COUNT(*) AS count
		FROM tabBooking b
		WHERE b.trip_date IN %(groups)s AND b.status NOT IN %(excl)s
		GROUP BY b.booking_channel
		ORDER BY count DESC
	""", fmt, as_dict=True)

	checkout_rows = frappe.db.sql("""
		SELECT b.checkout_method, COUNT(*) AS count
		FROM tabBooking b
		WHERE b.trip_date IN %(groups)s AND b.status NOT IN %(excl)s
		GROUP BY b.checkout_method
		ORDER BY count DESC
	""", fmt, as_dict=True)

	# ── Departure point — pax ikut titik perlepasan (snapshot br,
	#    difetch daripada Trip Package.airport_form semasa booking).
	#    Kosong = pakej tanpa lapangan terbang (ground/cruise only)
	#    atau booking lama sebelum snapshot di-backfill. ──
	departure_rows = frappe.db.sql("""
		SELECT IFNULL(br.departure_point, '') AS departure_point,
		       COUNT(*) AS count
		FROM `tabBooking Reservation` br
		INNER JOIN tabBooking b ON b.name = br.booking
		WHERE br.status != 'Cancelled' AND b.status NOT IN %(excl)s
		  AND b.trip_date IN %(groups)s
		GROUP BY IFNULL(br.departure_point, '')
		ORDER BY count DESC
	""", fmt, as_dict=True)

	# ── Company — bilangan reservation ikut company pengeluar SO utama
	#    booking (Booking.company; Reservation tiada field sendiri). ──
	company_rows = frappe.db.sql("""
		SELECT COALESCE(NULLIF(b.company, ''), 'Unknown') AS company,
		       COUNT(*) AS count
		FROM `tabBooking Reservation` br
		INNER JOIN tabBooking b ON b.name = br.booking
		WHERE br.status != 'Cancelled' AND b.status NOT IN %(excl)s
		  AND b.trip_date IN %(groups)s
		GROUP BY COALESCE(NULLIF(b.company, ''), 'Unknown')
		ORDER BY count DESC
	""", fmt, as_dict=True)

	# ── Package type — bilangan reservation ikut jenis pakej (snapshot
	#    br.package_type daripada Trip Package.package_type). ──
	package_rows = frappe.db.sql("""
		SELECT IFNULL(br.package_type, '') AS package_type,
		       COUNT(*) AS count
		FROM `tabBooking Reservation` br
		INNER JOIN tabBooking b ON b.name = br.booking
		WHERE br.status != 'Cancelled' AND b.status NOT IN %(excl)s
		  AND b.trip_date IN %(groups)s
		GROUP BY IFNULL(br.package_type, '')
		ORDER BY count DESC
	""", fmt, as_dict=True)

	# ── Document status — pax ikut status dokumen traveller. Sumber
	#    kebenaran = Traveller.status (mirror br.document_status boleh
	#    tertinggal); fallback br.document_status bila slot tanpa
	#    Traveller, '' → 'Incomplete'. ──
	doc_status_rows = frappe.db.sql("""
		SELECT COALESCE(NULLIF(t.status, ''), NULLIF(br.document_status, ''), 'Incomplete') AS doc_status,
		       COUNT(*) AS count
		FROM `tabBooking Reservation` br
		INNER JOIN tabBooking b ON b.name = br.booking
		LEFT JOIN tabTraveller t ON t.name = br.traveller
		WHERE br.status != 'Cancelled' AND b.status NOT IN %(excl)s
		  AND b.trip_date IN %(groups)s
		GROUP BY COALESCE(NULLIF(t.status, ''), NULLIF(br.document_status, ''), 'Incomplete')
		ORDER BY count DESC
	""", fmt, as_dict=True)

	# ── Room privacy — pax ikut Room Privacy (Private / Open Sharing,
	#    default 'Private' pada doctype; '' = bilik belum dikonfirmasi). ──
	privacy_rows = frappe.db.sql("""
		SELECT IFNULL(br.room_privacy, '') AS room_privacy,
		       COUNT(*) AS count
		FROM `tabBooking Reservation` br
		INNER JOIN tabBooking b ON b.name = br.booking
		WHERE br.status != 'Cancelled' AND b.status NOT IN %(excl)s
		  AND b.trip_date IN %(groups)s
		GROUP BY IFNULL(br.room_privacy, '')
		ORDER BY count DESC
	""", fmt, as_dict=True)

	# ── Addon (nilai melalui Sales Order addon) ──
	# Currency SO addon mengikut currency yang customer pilih semasa
	# checkout — BOLEH berbeza daripada SO utama booking, jadi revenue
	# addon dipecah ikut currency.
	addon = frappe.db.sql("""
		SELECT COUNT(DISTINCT bao.name) AS orders
		FROM `tabBooking Addon` bao
		INNER JOIN tabBooking b2 ON b2.name = bao.booking AND b2.status NOT IN %(excl)s
		WHERE bao.trip_date IN %(groups)s AND IFNULL(bao.status, '') != 'Cancelled'
	""", fmt, as_dict=True)[0]

	addon_revenue_by_cur = _sort_cur_rows([
		{"currency": r.currency, "revenue": _f(r.revenue)}
		for r in frappe.db.sql(f"""
			SELECT COALESCE(NULLIF(so.currency, ''), %(def_cur)s) AS currency,
			       SUM(so.grand_total) AS revenue
			FROM `tabBooking Addon` bao
			INNER JOIN tabBooking b2 ON b2.name = bao.booking AND b2.status NOT IN %(excl)s
			LEFT JOIN `tabSales Order` so ON so.name = bao.sales_order AND so.docstatus = 1
			WHERE bao.trip_date IN %(groups)s AND IFNULL(bao.status, '') != 'Cancelled'
			GROUP BY COALESCE(NULLIF(so.currency, ''), %(def_cur)s)
		""", {**fmt, "def_cur": _def_cur()}, as_dict=True)
	])
	addon_default_totals = _annotate_default(addon_revenue_by_cur, ["revenue"])
	addon_revenue = addon_revenue_by_cur[0]["revenue"] if len(addon_revenue_by_cur) == 1 \
		else (0.0 if not addon_revenue_by_cur else None)

	# ── Garis masa revenue — jumlah nilai SO per HARI (ikut tarikh SO
	# dibuat) untuk booking group ni, bertindan (cumulative). Frontend
	# agregat ikut skala pilihan user (hari/minggu/bulan/suku/tahun).
	# SO booking boleh dalam currency berbeza dan tidak boleh dijumlah
	# terus, jadi setiap hari dijumlah dalam default currency (kadar
	# semasa, best-effort; rates_complete=false bila ada currency tanpa
	# kadar). ──
	tl_monthly = {}
	tl_rates_complete = True
	for r in frappe.db.sql("""
		SELECT DATE_FORMAT(so.creation, '%%Y-%%m-%%d') AS ym,
		       COALESCE(NULLIF(so.currency, ''), %(def_cur)s) AS currency,
		       SUM(so.grand_total) AS revenue
		FROM `tabSales Order` so
		INNER JOIN tabBooking b ON b.name = so.custom_booking
		WHERE b.trip_date IN %(groups)s AND b.status NOT IN %(excl)s
		  AND so.docstatus = 1
		GROUP BY DATE_FORMAT(so.creation, '%%Y-%%m-%%d'),
		         COALESCE(NULLIF(so.currency, ''), %(def_cur)s)
		ORDER BY ym ASC
	""", {**fmt, "def_cur": _def_cur()}, as_dict=True):
		rate, _rd = get_rate_to_default(r.currency)
		if rate is None:
			tl_rates_complete = False
			continue
		tl_monthly[r.ym] = round(tl_monthly.get(r.ym, 0.0) + _f(r.revenue) * rate, 2)

	revenue_timeline = []
	_run = 0.0
	for ym in sorted(tl_monthly):
		_run = round(_run + tl_monthly[ym], 2)
		revenue_timeline.append({"ym": ym, "revenue": tl_monthly[ym], "cumulative": _run})

	pax = _i(pax_info.pax)
	docs_ok = _i(pax_info.docs_ok)
	capacity = sum(_i(g.max_participants) for g in group_rows)

	age_map = {r.bucket: _i(r.count) for r in age_breakdown_rows}
	gender_map = {r.gender: _i(r.count) for r in gender_breakdown_rows}

	return {
		"group": {
			"name": group_rows[0].name if len(group_rows) == 1 else "",
			"names": [g.name for g in group_rows],
			"trip_group_name": group_rows[0].trip_group_name if len(group_rows) == 1
				else ", ".join(sorted({(g.group_batch or "") for g in group_rows})),
			"status": group_rows[0].status or "" if len(group_rows) == 1 else "",
			"departure_date": _s(group_rows[0].departure_date) if len(group_rows) == 1 else "",
			"return_date": _s(group_rows[0].return_date) if len(group_rows) == 1 else "",
			"sailing_start": _s(group_rows[0].sailing_start) if len(group_rows) == 1 else "",
			"sailing_end": _s(group_rows[0].sailing_end) if len(group_rows) == 1 else "",
			"ship_name": group_rows[0].ship_name or "" if len(group_rows) == 1 else "",
			"is_a_cruise_trip": bool(group_rows[0].is_a_cruise_trip) if len(group_rows) == 1 else False,
			"max_participants": capacity,
			"current_participants": sum(_i(g.current_participants) for g in group_rows),
		},
		"rooms": {
			"total": _i(rooms_total),
			"by_category": [
				{
					"category": r.category,
					"rooms": _i(r.rooms),
					"pax": _i(r.pax),
				} for r in rooms_by_category
			],
		},
		"finance": {
			# Pecahan per currency — SUMBU sumber kebenaran paparan.
			"revenue_by_currency": rev_by_cur,
			"addon_revenue_by_currency": addon_revenue_by_cur,
			# Jumlah keseluruhan dalam default currency (nilai semasa).
			"default_totals": rev_default_totals,
			"addon_default_totals": addon_default_totals,
			"currency": currency,
			# Scalar legacy — hanya sah bila SATU currency (None = campur).
			"revenue": revenue,
			"collected": collected,
			"balance": balance,
			"unpaid_bookings": _i(unpaid.unpaid_bookings),
			"collection_rate": collection_rate,
			"addon_revenue": addon_revenue,
			"addon_orders": _i(addon.orders),
		},
		"revenue_timeline": {
			"currency": _def_cur(),
			"rates_complete": tl_rates_complete,
			"points": revenue_timeline,
		},
		"discount": {
			"by_currency": dsc_by_cur,
			"default_totals": dsc_default_totals,
			# Scalar legacy — hanya sah bila SATU currency (None = campur).
			"total": total_discount,
			"voucher": voucher_discount,
			"price_rule": price_rule_discount,
			"referral": referral_discount,
			"pre_discount_total": pre_discount_total,
			"voucher_usage_count": _i(voucher_usage.usage_count),
			"voucher_count": _i(voucher_usage.voucher_count),
		},
		"travellers": {
			"pax": pax,
			"docs_ok": docs_ok,
			"docs_submitted": _i(pax_info.docs_submitted),
			"pending_docs": max(pax - docs_ok, 0),
			"age_breakdown": {
				"infant": age_map.get("Infant", 0),
				"child": age_map.get("Child", 0),
				"adult": age_map.get("Adult", 0),
				"unknown": age_map.get("Unknown", 0),
			},
			"gender_breakdown": gender_map,
		},
		"bookings": {
			"active": _i(bookings_active),
			"addon_orders": _i(addon.orders),
		},
		"booking_status": [{"status": s.status or "-", "count": _i(s.count)} for s in booking_status],
		"payment_status": [{"status": s.payment_status or "-", "count": _i(s.count)} for s in payment_status],
		"booking_channel": [{"channel": r.booking_channel or "-", "count": _i(r.count)} for r in channel_rows],
		"checkout_method": [{"method": r.checkout_method or "-", "count": _i(r.count)} for r in checkout_rows],
		"departure_point": [
			{"departure_point": _s(r.departure_point), "count": _i(r.count)}
			for r in departure_rows
		],
		"company_breakdown": [
			{"company": _s(r.company), "count": _i(r.count)}
			for r in company_rows
		],
		"package_type": [
			{"package_type": _s(r.package_type), "count": _i(r.count)}
			for r in package_rows
		],
		"doc_status": [
			{"doc_status": _s(r.doc_status), "count": _i(r.count)}
			for r in doc_status_rows
		],
		"room_privacy": [
			{"room_privacy": _s(r.room_privacy), "count": _i(r.count)}
			for r in privacy_rows
		],
		"affiliate_breakdown": [
			{"affiliate": r.affiliate, "count": _i(r.count)} for r in affiliate_rows
		],
		"occupancy": {
			"capacity": capacity,
			"pax": pax,
			"pct": round(pax / capacity * 100, 1) if capacity else None,
		},
	}


@frappe.whitelist()
def get_group_bookings(trip_group: str = None, trip_groups: list = None, status: str = None,
					   payment_status: str = None, search: str = None, currency: str = None,
					   limit: int = 20):
	"""Senarai booking (reservation) bagi satu Trip Group Date / batch
	dengan agregat setiap booking: pax, bilik, nilai SO, terbayar, baki,
	diskaun, dokumen pending.

	limit = row limit untuk quick preview (0 = semua). `count` dan
	`totals` dikira atas SEMUA row yang padan filter (bukan setakat
	yang dipaparkan) supaya footer kekal betul bila limit aktif.
	"""
	_require_access()
	groups = _parse_groups(trip_group, trip_groups)

	conditions = ["b.trip_date IN %(groups)s"]
	fmt = {"groups": groups, "done": list(DOC_STATUS_DONE),
		   "excl": list(EXCLUDED_BOOKING_STATUSES)}

	if status and status != "All":
		conditions.append("b.status = %(status)s")
		fmt["status"] = status
	if payment_status and payment_status != "All":
		conditions.append("b.payment_status = %(pay)s")
		fmt["pay"] = payment_status
	if currency:
		# Tapis ikut currency bil — booking dipaparkan bila ADA SO submitted
		# dalam currency itu (utama mahupun addon; currency kosong jatuh ke
		# default currency, selari _SO_PER_BOOKING_CUR).
		conditions.append(f"""EXISTS (
			SELECT 1 FROM `tabSales Order` socf
			WHERE socf.custom_booking = b.name AND socf.docstatus = 1
			  AND COALESCE(NULLIF(socf.currency, ''), %(def_cur)s) = %(cur)s)""")
		fmt["cur"] = currency
		fmt["def_cur"] = _def_cur()
	if search:
		# Skop carian: booking (ID/no), customer (nama/emel/telefon) dan
		# traveller (nama/telefon/emel/IC/paspport — snapshot reservation
		# ATAU rekod Traveller) — padanan traveller memsurfacekan booking
		# induknya. Reservation Cancelled diketepikan (bukan lagi tetamu).
		conditions.append("""(
			b.name LIKE %(s)s OR b.booking_number LIKE %(s)s
			OR b.customer LIKE %(s)s OR c.customer_name LIKE %(s)s
			OR b.cust_email LIKE %(s)s OR b.get_cust_booking_phone LIKE %(s)s
			OR EXISTS (
				SELECT 1 FROM `tabBooking Reservation` sbr
				LEFT JOIN tabTraveller stv ON stv.name = sbr.traveller
				WHERE sbr.booking = b.name AND sbr.status != 'Cancelled'
				  AND (sbr.traveller_full_name LIKE %(s)s OR stv.full_name LIKE %(s)s
					OR sbr.traveller_passportno LIKE %(s)s OR stv.passport_no LIKE %(s)s
					OR sbr.traveller_ic LIKE %(s)s OR stv.ic_number LIKE %(s)s
					OR sbr.traveller_email LIKE %(s)s OR stv.email LIKE %(s)s
					OR stv.phone LIKE %(s)s)
			)
		)""")
		fmt["s"] = f"%{search}%"
	where = " AND ".join(conditions)

	try:
		limit = int(limit or 0)
	except (TypeError, ValueError):
		limit = 20
	lim = f"LIMIT {limit}" if limit > 0 else ""

	rows = frappe.db.sql(f"""
		SELECT b.name, b.booking_number, b.customer, c.customer_name, b.cust_email,
		       b.get_cust_booking_phone AS cust_phone,
		       b.customer_message,
		       b.status, b.payment_status, b.booking_channel, b.checkout_method,
		       b.voucher_discount, b.price_rule_discount, b.referral_discount,
		       COALESCE(NULLIF({_PRIMARY_SO_CUR}, ''), %(def_cur)s) AS discount_currency,
		       b.creation, b.trip_date,
		       res.pax, res.rooms, res.pending_docs, res.docs_submitted, res.docs_verified
		FROM tabBooking b
		LEFT JOIN tabCustomer c ON c.name = b.customer
		LEFT JOIN {_RES_PER_BOOKING}
		WHERE {where}
		ORDER BY b.creation DESC
		{lim}
	""", {**fmt, "def_cur": _def_cur()}, as_dict=True)

	# Wang per (booking, currency) untuk booking di halaman ini — booking
	# boleh ada SO dalam beberapa currency (addon), jadi pecahan dijaga
	# per currency, tidak pernah dijumlah merentas currency.
	page_bookings = [r.name for r in rows]
	money_by_booking = {}
	if page_bookings:
		for r in frappe.db.sql(f"""
			SELECT soc.booking, soc.currency, soc.gross, soc.paid
			FROM {_SO_PER_BOOKING_CUR}
			WHERE soc.booking IN %(page_bookings)s
		""", {**fmt, "def_cur": _def_cur(), "page_bookings": page_bookings}, as_dict=True):
			money_by_booking.setdefault(r.booking, []).append(r)

	# Total atas semua row yang padan (untuk footer & "showing x of y")
	# — kiraan (pax/rooms/docs) currency-agnostic; wang dipecah ikut
	# currency (footer menjumlah HANYA dalam currency yang sama).
	totals = frappe.db.sql(f"""
		SELECT COUNT(*) AS cnt,
		       COALESCE(SUM(res.pax), 0) AS pax,
		       COALESCE(SUM(res.rooms), 0) AS rooms,
		       COALESCE(SUM(res.pending_docs), 0) AS pending_docs
		FROM tabBooking b
		LEFT JOIN tabCustomer c ON c.name = b.customer
		LEFT JOIN {_RES_PER_BOOKING}
		WHERE {where}
	""", fmt, as_dict=True)[0]

	# Wang (gross/paid) per currency atas semua booking yang padan filter.
	gross_by_cur = {}
	for r in frappe.db.sql(f"""
		SELECT soc.currency, SUM(soc.gross) AS gross, SUM(soc.paid) AS paid
		FROM tabBooking b
		INNER JOIN {_SO_PER_BOOKING_CUR} ON soc.booking = b.name
		LEFT JOIN tabCustomer c ON c.name = b.customer
		WHERE {where}
		GROUP BY soc.currency
	""", {**fmt, "def_cur": _def_cur()}, as_dict=True):
		gross_by_cur[r.currency] = {
			"gross": _f(r.gross), "paid": _f(r.paid),
			"balance": round(_f(r.gross) - _f(r.paid), 2), "discount": 0.0,
		}

	# Diskaun per currency (field Booking — axis currency SO utama).
	for r in frappe.db.sql(f"""
		SELECT COALESCE(NULLIF({_PRIMARY_SO_CUR}, ''), %(def_cur)s) AS currency,
		       SUM(b.voucher_discount + b.price_rule_discount + b.referral_discount) AS discount
		FROM tabBooking b
		LEFT JOIN tabCustomer c ON c.name = b.customer
		WHERE {where}
		GROUP BY COALESCE(NULLIF({_PRIMARY_SO_CUR}, ''), %(def_cur)s)
	""", {**fmt, "def_cur": _def_cur()}, as_dict=True):
		entry = gross_by_cur.setdefault(r.currency, {
			"gross": 0.0, "paid": 0.0, "balance": 0.0, "discount": 0.0,
		})
		entry["discount"] = _f(r.discount)

	tot_by_cur = _sort_cur_rows([
		{"currency": cur, **vals} for cur, vals in gross_by_cur.items()
	])
	tot_default_totals = _annotate_default(tot_by_cur, ["gross", "paid", "balance", "discount"])
	if len(tot_by_cur) == 1:
		tot_gross = tot_by_cur[0]["gross"]
		tot_paid = tot_by_cur[0]["paid"]
		tot_balance = tot_by_cur[0]["balance"]
		tot_discount = tot_by_cur[0]["discount"]
	elif not tot_by_cur:
		tot_gross = tot_paid = tot_balance = tot_discount = 0.0
	else:
		# Campur currency — scalar None (frontend papar pecahan).
		tot_gross = tot_paid = tot_balance = tot_discount = None

	bookings = []
	for r in rows:
		by_cur = _sort_cur_rows([
			{
				"currency": m.currency,
				"gross": _f(m.gross),
				"paid": _f(m.paid),
				"balance": round(_f(m.gross) - _f(m.paid), 2),
			}
			for m in money_by_booking.get(r.name, [])
		])
		b_default_totals = _annotate_default(by_cur, ["gross", "paid", "balance"])
		if len(by_cur) == 1:
			gross, paid, balance, b_currency = (
				by_cur[0]["gross"], by_cur[0]["paid"], by_cur[0]["balance"], by_cur[0]["currency"])
		elif not by_cur:
			gross, paid, balance, b_currency = 0.0, 0.0, 0.0, None
		else:
			gross, paid, balance, b_currency = None, None, None, None
		bookings.append({
			"name": r.name,
			"booking_number": r.booking_number or r.name,
			"customer": r.customer or "",
			"customer_name": r.customer_name or r.customer or "-",
			"cust_email": r.cust_email or "",
			# Snapshot phone booking (field get_cust_booking_phone — dikemas
			# kini semasa customer ubah phone via portal, sama corak
			# cust_email).
			"cust_phone": r.cust_phone or "",
			# Pesanan khas customer semasa checkout (Booking.customer_message)
			"customer_message": r.customer_message or "",
			"status": r.status or "",
			"payment_status": r.payment_status or "",
			"booking_channel": r.booking_channel or "",
			"checkout_method": r.checkout_method or "",
			"voucher_discount": _f(r.voucher_discount),
			"price_rule_discount": _f(r.price_rule_discount),
			"referral_discount": _f(r.referral_discount),
			# Diskaun dipegang dalam currency SO utama booking.
			"discount_currency": r.discount_currency,
			"creation": _s(r.creation),
			"trip_date": r.trip_date or "",
			"pax": _i(r.pax),
			"rooms": _i(r.rooms),
			"pending_docs": _i(r.pending_docs),
			"docs_submitted": _i(r.docs_submitted),
			"docs_verified": _i(r.docs_verified),
			"gross": gross,
			"paid": paid,
			"balance": balance,
			"currency": b_currency,
			"gross_by_currency": by_cur,
			"default_totals": b_default_totals,
		})

	return {
		"bookings": bookings,
		"shown": len(bookings),
		"count": _i(totals.cnt),
		# Currency yang wujud dalam set yang padan filter — pilihan dropdown
		# penapis currency frontend.
		"currencies": [r["currency"] for r in tot_by_cur],
		"totals": {
			"pax": _i(totals.pax),
			"rooms": _i(totals.rooms),
			"gross": tot_gross,
			"paid": tot_paid,
			"balance": tot_balance,
			"discount": tot_discount,
			"pending_docs": _i(totals.pending_docs),
			"by_currency": tot_by_cur,
			"default_totals": tot_default_totals,
		},
	}


@frappe.whitelist()
def get_group_addons(trip_group: str = None, trip_groups: list = None, status: str = None,
					 payment_status: str = None, search: str = None,
					 limit: int = 20) -> dict:
	"""Senarai Booking Addon bagi satu Trip Group Date / batch — addon
	order dihubung terus ke group melalui Booking Addon.trip_date.
	Status addon: Pending / Confirmed / Cancelled (semua dipaparkan;
	boleh difilter). Footer totals atas SEMUA row yang padan filter;
	wang dijumlah dalam default currency (kadar semasa; '+' bila ada
	currency tanpa kadar).
	"""
	_require_access()
	groups = _parse_groups(trip_group, trip_groups)

	conditions = ["ba.trip_date IN %(groups)s"]
	fmt = {"groups": groups, "def_cur": _def_cur()}

	if status and status != "All":
		conditions.append("ba.status = %(status)s")
		fmt["status"] = status
	if payment_status and payment_status != "All":
		conditions.append("ba.payment_status = %(pay)s")
		fmt["pay"] = payment_status
	if search:
		conditions.append("(ba.name LIKE %(s)s OR ba.booking_number LIKE %(s)s "
			"OR ba.customer LIKE %(s)s OR c.customer_name LIKE %(s)s)")
		fmt["s"] = f"%{search}%"
	where = " AND ".join(conditions)

	try:
		limit = int(limit or 0)
	except (TypeError, ValueError):
		limit = 20
	lim = f"LIMIT {limit}" if limit > 0 else ""

	rows = frappe.db.sql(f"""
		SELECT ba.name, ba.booking, ba.booking_number, ba.customer,
		       c.customer_name, ba.trip_package, ba.trip_date,
		       ba.status, ba.payment_status,
		       ba.currency, ba.total_amount, ba.notes,
		       COALESCE(ba.order_date, ba.creation) AS order_date,
		       ba.creation,
		       (SELECT COUNT(*) FROM `tabBooking Addon Item` bai
		        WHERE bai.addon_order = ba.name) AS item_count
		FROM `tabBooking Addon` ba
		LEFT JOIN tabCustomer c ON c.name = ba.customer
		WHERE {where}
		ORDER BY ba.creation DESC
		{lim}
	""", fmt, as_dict=True)

	# Jumlah atas semua row yang padan filter — amount per currency
	# (currency kosong fallback ke default currency), kemudian jumlah
	# bersamaan default currency.
	amount_by_cur = {}
	for r in frappe.db.sql(f"""
		SELECT COALESCE(NULLIF(ba.currency, ''), %(def_cur)s) AS currency,
		       SUM(ba.total_amount) AS amount
		FROM `tabBooking Addon` ba
		LEFT JOIN tabCustomer c ON c.name = ba.customer
		WHERE {where}
		GROUP BY COALESCE(NULLIF(ba.currency, ''), %(def_cur)s)
	""", fmt, as_dict=True):
		amount_by_cur[r.currency] = _f(r.amount)
	tot_by_cur = _sort_cur_rows([
		{"currency": cur, "amount": amt} for cur, amt in amount_by_cur.items()
	])
	tot_default_totals = _annotate_default(tot_by_cur, ["amount"])

	addons = [{
		"name": r.name,
		"booking": r.booking or "",
		"booking_number": r.booking_number or r.booking or "",
		"customer": r.customer or "",
		"customer_name": r.customer_name or r.customer or "-",
		"trip_package": r.trip_package or "",
		"trip_date": r.trip_date or "",
		"status": r.status or "",
		"payment_status": r.payment_status or "",
		"currency": r.currency or "",
		"total_amount": _f(r.total_amount),
		"item_count": _i(r.item_count),
		"notes": r.notes or "",
		"order_date": _s(r.order_date),
		"creation": _s(r.creation),
	} for r in rows]

	return {
		"addons": addons,
		"shown": len(addons),
		"count": _count_addons(fmt, where) if lim else len(addons),
		"totals": {
			"by_currency": tot_by_cur,
			"default_totals": tot_default_totals,
		},
	}


def _count_addons(fmt, where):
	"""Kiraan Booking Addon atas semua row yang padan filter (footer
	count bila limit aktif)."""
	r = frappe.db.sql(f"""
		SELECT COUNT(*) AS cnt
		FROM `tabBooking Addon` ba
		LEFT JOIN tabCustomer c ON c.name = ba.customer
		WHERE {where}
	""", fmt, as_dict=True)
	return _i(r[0].cnt) if r else 0


@frappe.whitelist()
def get_group_flights(trip_group: str = None, trip_groups: list = None, search: str = None,
					  limit: int = 20) -> dict:
	"""Senarai Flight yang dirujuk booking dalam Trip Group Date / batch
	(Booking.flight → Flight). Kiraan booking & pax ikut flight — hanya
	booking aktif (bukan Cancelled/Abandoned) dikira.
	"""
	_require_access()
	groups = _parse_groups(trip_group, trip_groups)

	conditions = ["b.trip_date IN %(groups)s"]
	fmt = {"groups": groups, "excl": list(EXCLUDED_BOOKING_STATUSES),
		   "done": list(DOC_STATUS_DONE)}

	if search:
		conditions.append("(f.name LIKE %(s)s OR f.flight_title LIKE %(s)s "
			"OR f.pnr LIKE %(s)s OR f.airline LIKE %(s)s "
			"OR f.home_airport LIKE %(s)s OR f.destination_airport LIKE %(s)s)")
		fmt["s"] = f"%{search}%"
	where = " AND ".join(conditions)

	try:
		limit = int(limit or 0)
	except (TypeError, ValueError):
		limit = 20
	lim = f"LIMIT {limit}" if limit > 0 else ""

	rows = frappe.db.sql(f"""
		SELECT f.name, f.flight_title, f.status, f.pnr, f.airline,
		       al.airline_name, f.home_airport, f.destination_airport,
		       f.departure_date, f.arrival_date, f.flight_class,
		       f.ticket_type, f.seats_occupied, f.min_seat, f.max_seat,
		       COUNT(DISTINCT CASE WHEN b.status NOT IN %(excl)s
		                           THEN b.name END) AS booking_count,
		       COALESCE(SUM(CASE WHEN b.status NOT IN %(excl)s
		                         THEN res.pax END), 0) AS pax
		FROM `tabFlight` f
		INNER JOIN tabBooking b ON b.flight = f.name
		LEFT JOIN `tabFlight Airline` al ON al.name = f.airline
		LEFT JOIN {_RES_PER_BOOKING}
		WHERE {where}
		GROUP BY f.name, f.flight_title, f.status, f.pnr, f.airline,
		         al.airline_name, f.home_airport, f.destination_airport,
		         f.departure_date, f.arrival_date, f.flight_class,
		         f.ticket_type, f.seats_occupied, f.min_seat, f.max_seat
		ORDER BY f.departure_date ASC, f.name ASC
		{lim}
	""", fmt, as_dict=True)

	total = frappe.db.sql(f"""
		SELECT COUNT(DISTINCT f.name) AS cnt
		FROM `tabFlight` f
		INNER JOIN tabBooking b ON b.flight = f.name
		WHERE {where}
	""", fmt, as_dict=True)[0]

	flights = [{
		"name": r.name,
		"flight_title": r.flight_title or "",
		"status": r.status or "",
		"pnr": r.pnr or r.name,
		"airline": r.airline or "",
		"airline_name": r.airline_name or "",
		"home_airport": r.home_airport or "",
		"destination_airport": r.destination_airport or "",
		"departure_date": _s(r.departure_date),
		"arrival_date": _s(r.arrival_date),
		"flight_class": r.flight_class or "",
		"ticket_type": r.ticket_type or "",
		"seats_occupied": _i(r.seats_occupied),
		"min_seat": _i(r.min_seat),
		"max_seat": _i(r.max_seat),
		"booking_count": _i(r.booking_count),
		"pax": _i(r.pax),
	} for r in rows]

	return {
		"flights": flights,
		"shown": len(flights),
		"count": _i(total.cnt),
	}


# Doctype sumber senarai traveller → alias SQL (join tetap pada kueri).
_TV_FILTER_ALIASES = {
	"Booking Reservation": "br", "Traveller": "t", "Booking": "b", "Customer": "c",
}
# Jenis field yang dibenarkan untuk penapis dinamik (jenis layout/attach
# diketepikan — tiada nilai bermakna untuk ditapis).
_TV_FILTER_FIELDTYPES = {
	"Data", "Small Text", "Text", "Long Text", "Editor",
	"Select", "Link", "Date", "Datetime", "Int", "Float", "Currency", "Percent", "Check",
}


def _tv_scope(booking: str = None, trip_group: str = None, trip_groups=None):
	"""Syarat skop senarai traveller — dikongsi get_group_travellers &
	cadangan nilai penapis dinamik. Return (conditions, fmt, order_by)."""
	if booking:
		if not frappe.db.exists("Booking", booking):
			frappe.throw(_("Booking {0} not found").format(booking))
		return (["br.booking = %(booking)s"], {"booking": booking},
				"br.guest_sequence, br.name")
	groups = _parse_groups(trip_group, trip_groups)
	return (
		["b.trip_date IN %(groups)s", "br.status != 'Cancelled'",
		 "b.status NOT IN %(excl)s"],
		{"groups": groups, "excl": list(EXCLUDED_BOOKING_STATUSES)},
		"b.booking_number, br.guest_sequence, br.name",
	)


def _tv_filter_field(doctype: str, fieldname: str):
	"""Sahkan medan penapis dinamik wujud pada meta doctype dan jenisnya
	selamat untuk SQL — nama kolum TIDAK PERNAH diinterpolate terus daripada
	input tanpa validasi ini. Return (alias, df)."""
	alias = _TV_FILTER_ALIASES.get(doctype or "")
	if not alias:
		frappe.throw(_("Filter doctype must be one of: {0}").format(
			", ".join(_TV_FILTER_ALIASES)))
	df = frappe.get_meta(doctype).get_field(fieldname or "")
	if not df or df.fieldtype not in _TV_FILTER_FIELDTYPES:
		frappe.throw(_("{0}.{1} is not a filterable field").format(doctype, fieldname))
	return alias, df


def _tv_filter_conditions(custom_filters: list, fmt: dict) -> list:
	"""Tukar penapis dinamik [{doctype, fieldname, value}] kepada syarat SQL.
	Semantik ikut jenis field: teks → LIKE %v%; Select/Link/tarikh/nombor →
	padanan tepat; Check → 1/0. Baris tanpa nilai diabaikan."""
	out = []
	for i, f in enumerate(custom_filters or []):
		if not isinstance(f, dict):
			continue
		value = f.get("value")
		if value in (None, ""):
			continue
		alias, df = _tv_filter_field(f.get("doctype"), f.get("fieldname"))
		col = f"{alias}.`{df.fieldname}`"
		vk = f"cfv{i}"
		if df.fieldtype == "Check":
			fmt[vk] = 1 if str(value).lower() in ("1", "true", "yes", "y") else 0
			out.append(f"{col} = %({vk})s")
		elif df.fieldtype in ("Data", "Small Text", "Text", "Long Text", "Editor"):
			fmt[vk] = f"%{value}%"
			out.append(f"{col} LIKE %({vk})s")
		else:
			fmt[vk] = value
			out.append(f"{col} = %({vk})s")
	return out


@frappe.whitelist()
def get_group_travellers(trip_group: str = None, trip_groups: list = None, booking: str = None,
						 search: str = None, doc_status: str = None,
						 custom_filters: list = None, limit: int = 20,
						 with_versions: bool = False) -> dict:
	"""Senarai traveller — SATU sumber untuk semua peringkat page Manage
	Booking (L2 group/batch & L3 booking info) serta eksport ZIP/XLSX/CSV.

	Dua mode skop:
	- Mode group (trip_group/trip_groups, kekal seperti asal): reservation
	  Cancelled & booking Cancelled/Abandoned diketepikan, susunan ikut
	  no booking → guest sequence.
	- Mode booking (booking): SEMUA reservation booking itu disertakan
	  (badge Cancelled dipapar berasingan) — selari tab Travellers L3.

	Prioriti data (disatukan ikut reka bentuk L3): rekod doctype Traveller
	(langsung) DIUTAMAKAN, snapshot Booking Reservation fallback; medan
	kontak disambung fallback customer booking (email/telefon).

	with_versions: lampirkan log aktiviti doctype Version per traveller
	(untuk timeline modal L3). Tidak diminta pada mode group — berat.

	custom_filters: penapis dinamik [{doctype, fieldname, value}] atas
	medan doctype sumber (Booking Reservation / Traveller / Booking /
	Customer) — teks LIKE, lain-lain padanan tepat.
	"""
	_require_access()
	conditions, fmt, order_by = _tv_scope(booking, trip_group, trip_groups)
	conditions.extend(_tv_filter_conditions(custom_filters, fmt))

	if doc_status and doc_status != "All":
		if doc_status == "Incomplete":
			conditions.append(
				"COALESCE(NULLIF(t.status, ''), IFNULL(br.document_status, '')) IN ('', 'Incomplete')")
		else:
			conditions.append(
				"COALESCE(NULLIF(t.status, ''), IFNULL(br.document_status, '')) = %(doc_status)s")
			fmt["doc_status"] = doc_status
	if search:
		conditions.append("""(
			br.traveller_full_name LIKE %(s)s OR t.full_name LIKE %(s)s
			OR br.name LIKE %(s)s OR br.traveller LIKE %(s)s
			OR br.booking LIKE %(s)s OR b.booking_number LIKE %(s)s
			OR br.traveller_passportno LIKE %(s)s OR t.passport_no LIKE %(s)s
			OR br.traveller_email LIKE %(s)s OR t.email LIKE %(s)s
			OR br.customer_email LIKE %(s)s OR t.phone LIKE %(s)s OR br.customer_phone LIKE %(s)s
		)""")
		fmt["s"] = f"%{search}%"
	where = " AND ".join(conditions)

	try:
		limit = int(limit or 0)
	except (TypeError, ValueError):
		limit = 20
	lim = f"LIMIT {limit}" if limit > 0 else ""

	rows = frappe.db.sql(f"""
		SELECT br.name AS reservation, br.status AS reservation_status,
		       br.booking, br.booking_number,
		       br.guest_sequence, br.pax_type, br.guest_label,
		       br.room_id, br.cabin_no, br.stateroom_no,
		       br.room_privacy, br.cabin_is_confirmed, br.delegate_no,
		       br.aroya_guest_no,
		       br.date_selection AS trip_group,
		       IFNULL(NULLIF(br.room_category, ''), 'Unassigned') AS room_category,
		       COALESCE(NULLIF(t.full_name, ''), NULLIF(br.traveller_full_name, ''),
		                br.traveller, '') AS traveller_name,
		       br.traveller,
		       COALESCE(NULLIF(t.gender, ''), NULLIF(br.traveller_gender, ''), '') AS gender,
		       COALESCE(NULLIF(t.date_of_birth, ''),
		                NULLIF(NULLIF(br.traveller_datebirth, '0000-00-00'), ''), '') AS dob,
		       COALESCE(NULLIF(t.nationality, ''),
		                NULLIF(br.traveller_nationality, ''), '') AS nationality,
		       COALESCE(NULLIF(t.passport_no, ''),
		                NULLIF(br.traveller_passportno, ''), '') AS passport_no,
		       COALESCE(NULLIF(t.passport_expiry, ''),
		                NULLIF(br.traveller_passportexpiry, ''), '') AS passport_expiry,
		       COALESCE(NULLIF(t.email, ''), NULLIF(br.traveller_email, ''),
		                NULLIF(br.customer_email, ''), '') AS email,
		       COALESCE(NULLIF(t.phone, ''), NULLIF(br.traveller_phone, ''),
		                NULLIF(br.customer_phone, ''), '') AS phone,
		       COALESCE(NULLIF(t.ic_number, ''), NULLIF(br.traveller_ic, ''), '') AS ic_number,
		       COALESCE(NULLIF(t.passport_image, ''),
		                NULLIF(br.traveller_passportimg, ''), '') AS passport_image,
		       t.visa_photo,
		       t.status AS traveller_status, t.document_verified,
		       COALESCE(NULLIF(t.title, ''), NULLIF(br.traveller_title, ''), '') AS title,
		       COALESCE(NULLIF(t.first_name, ''), NULLIF(br.traveller_first_name, ''), '') AS first_name,
		       COALESCE(NULLIF(t.last_name, ''), NULLIF(br.traveller_last_name, ''), '') AS last_name,
		       COALESCE(NULLIF(t.emergency_contact_name, ''),
		                NULLIF(br.traveller_emergency_contact_name, ''), '') AS emergency_contact_name,
		       COALESCE(NULLIF(t.emergency_contact_phone, ''),
		                NULLIF(br.traveller_emergency_contact_phone, ''), '') AS emergency_contact_phone,
		       COALESCE(NULLIF(t.emergency_contact_relationship, ''),
		                NULLIF(br.traveller_emergency_contact_relationship, ''),
		                '') AS emergency_contact_relationship,
		       COALESCE(NULLIF(t.address_line1, ''),
		                NULLIF(br.traveller_address_line1, ''), '') AS address_line1,
		       COALESCE(NULLIF(t.city, ''), NULLIF(br.traveller_city, ''), '') AS city,
		       COALESCE(NULLIF(t.postcode, ''), NULLIF(br.traveller_postcode, ''), '') AS postcode,
		       COALESCE(NULLIF(t.state, ''), NULLIF(br.traveller_state, ''), '') AS state,
		       COALESCE(NULLIF(t.country, ''), NULLIF(br.traveller_country, ''), '') AS country,
		       t.wheelchair_assistant, t.dietary_requirements,
		       COALESCE(NULLIF(t.medical_conditions, ''),
		                NULLIF(br.traveller_medical_conditions, ''), '') AS medical_conditions,
		       COALESCE(NULLIF(t.medicine_treatment, ''),
		                NULLIF(br.traveller_medicine_treatment, ''), '') AS medicine_treatment,
		       t.age_category,
		       t.creation AS traveller_created, t.modified AS traveller_modified,
		       COALESCE(NULLIF(t.status, ''), IFNULL(br.document_status, 'Incomplete')) AS document_status,
		       CASE WHEN br.is_a_cruise = 1 THEN NULLIF(br.cruise_start, '0000-00-00')
		            ELSE NULLIF(br.departure_date, '0000-00-00') END AS ref_date,
		       br.flight, br.airline, br.customer_message,
		       b.booking_number AS b_booking_number, b.status AS booking_status,
		       b.customer, c.customer_name,
		       b.customer_message AS b_customer_message,
		       b.cust_email, b.get_cust_booking_phone AS cust_phone
		FROM `tabBooking Reservation` br
		INNER JOIN tabBooking b ON b.name = br.booking
		LEFT JOIN tabTraveller t ON t.name = br.traveller
		LEFT JOIN tabCustomer c ON c.name = b.customer
		WHERE {where}
		ORDER BY {order_by}
		{lim}
	""", fmt, as_dict=True)

	count = frappe.db.sql(f"""
		SELECT COUNT(*) AS c
		FROM `tabBooking Reservation` br
		INNER JOIN tabBooking b ON b.name = br.booking
		LEFT JOIN tabTraveller t ON t.name = br.traveller
		WHERE {where}
	""", fmt, as_dict=True)[0].c

	travellers = []
	for r in rows:
		years = _age_years(r.dob, r.ref_date)
		# Mesej reservation (br.customer_message) diutamakan; fallback mesej
		# booking induk — selari semantik 'reservation_note' get_booking_profile.
		note = r.customer_message or r.b_customer_message or ""
		travellers.append({
			"reservation": r.reservation,
			"reservation_status": r.reservation_status or "",
			"booking": r.booking,
			"booking_number": r.booking_number or r.b_booking_number or r.booking,
			"booking_status": r.booking_status or "",
			"customer_name": r.customer_name or r.customer or "",
			# Pesanan khas booking induk (Booking.customer_message) —
			# reservation tiada field mesej sendiri.
			"customer_message": r.b_customer_message or "",
			# Alias konsisten dengan modal traveller (seksyen Booking Info).
			"booking_message": r.b_customer_message or "",
			"reservation_note": note,
			"cust_email": r.cust_email or "",
			"cust_phone": r.cust_phone or "",
			"traveller_name": r.traveller_name or "-",
			"traveller": r.traveller or "",
			"gender": r.gender or "",
			"dob": _s(r.dob),
			"age": years,
			"age_bucket": _age_bucket(years),
			"nationality": r.nationality or "",
			"passport_no": r.passport_no or "",
			"passport_expiry": _s(r.passport_expiry),
			"email": r.email or "",
			"phone": r.phone or "",
			"ic_number": r.ic_number or "",
			"passport_image": r.passport_image or "",
			"visa_photo": r.visa_photo or "",
			"traveller_status": r.traveller_status or "",
			"document_verified": bool(r.document_verified),
			"title": r.title or "",
			"first_name": r.first_name or "",
			"last_name": r.last_name or "",
			"emergency_contact_name": r.emergency_contact_name or "",
			"emergency_contact_phone": r.emergency_contact_phone or "",
			"emergency_contact_relationship": r.emergency_contact_relationship or "",
			"address_line1": r.address_line1 or "",
			"postcode": r.postcode or "",
			"city": r.city or "",
			"state": r.state or "",
			"country": r.country or "",
			"wheelchair_assistant": r.wheelchair_assistant or "",
			"dietary_requirements": r.dietary_requirements or "",
			"medical_conditions": r.medical_conditions or "",
			"medicine_treatment": r.medicine_treatment or "",
			"age_category": r.age_category or "",
			"traveller_created": _s(r.traveller_created),
			"traveller_modified": _s(r.traveller_modified),
			"document_status": r.document_status,
			"room_id": r.room_id or "",
			"cabin_no": _i(r.cabin_no),
			"room_privacy": r.room_privacy or "",
			"cabin_confirmed": bool(r.cabin_is_confirmed),
			"stateroom_no": r.stateroom_no or "",
			"delegate_no": r.delegate_no or "",
			"aroya_guest_no": _i(r.aroya_guest_no) or "",
			"room_category": r.room_category,
			"trip_group": r.trip_group or "",
			"pax_type": r.pax_type or "",
			"guest_label": r.guest_label or "",
			"guest_sequence": _i(r.guest_sequence),
			"flight": r.flight or "",
			"airline": r.airline or "",
		})

	# Log aktiviti traveller (modal L3) — hanya bila diminta: kueri Version
	# berat untuk senarai group yang besar.
	if with_versions:
		trav_names = list({r["traveller"] for r in travellers if r["traveller"]})
		ver_map = {}
		if trav_names:
			for v in frappe.get_all("Version",
					filters={"ref_doctype": "Traveller", "docname": ("in", trav_names)},
					fields=["docname", "creation"], order_by="creation asc"):
				ver_map.setdefault(v.docname, []).append(_s(v.creation))
		for r in travellers:
			r["traveller_versions"] = ver_map.get(r["traveller"], [])

	return {"travellers": travellers, "shown": len(travellers), "count": _i(count)}


@frappe.whitelist()
def get_traveller_filter_fields() -> list:
	"""Senarai medan yang boleh ditapis untuk penapis dinamik tab
	Travellers — semua field meta (kecuali jenis layout/attach) bagi 4
	doctype sumber senarai traveller, dikumpulkan ikut doctype."""
	_require_access()
	out = []
	for dt in _TV_FILTER_ALIASES:
		fields = [{
			"fieldname": df.fieldname,
			"label": df.label or df.fieldname,
			"fieldtype": df.fieldtype,
		} for df in frappe.get_meta(dt).fields
			if df.fieldtype in _TV_FILTER_FIELDTYPES]
		if fields:
			out.append({"doctype": dt, "fields": fields})
	return out


@frappe.whitelist()
def get_traveller_filter_values(doctype: str = None, fieldname: str = None,
								booking: str = None, trip_group: str = None,
								trip_groups: "list | str" = None, search: str = None,
								limit: int = 100) -> dict:
	"""Nilai berbeza (distinct) satu medan dalam skop senarai traveller —
	cadangan dropdown nilai penapis dinamik (datalist klien)."""
	_require_access()
	alias, df = _tv_filter_field(doctype, fieldname)
	conditions, fmt, _order = _tv_scope(booking, trip_group, trip_groups)
	col = f"{alias}.`{df.fieldname}`"
	if search:
		conditions = conditions + [f"CAST({col} AS CHAR) LIKE %(vs)s"]
		fmt["vs"] = f"%{search}%"
	try:
		limit = max(1, min(int(limit or 100), 200))
	except (TypeError, ValueError):
		limit = 100
	rows = frappe.db.sql(f"""
		SELECT DISTINCT {col} AS v
		FROM `tabBooking Reservation` br
		INNER JOIN tabBooking b ON b.name = br.booking
		LEFT JOIN tabTraveller t ON t.name = br.traveller
		LEFT JOIN tabCustomer c ON c.name = b.customer
		WHERE {' AND '.join(conditions)}
		ORDER BY v
		LIMIT {limit}
	""", fmt, as_dict=True)
	return {"values": ["" if r.v is None else _s(r.v) for r in rows]}


@frappe.whitelist()
def get_group_rooming(trip_group: str = None, trip_groups: list = None, search: str = None,
					  privacy: str = None, limit: int = 20) -> dict:
	"""Senarai bilik (rooming) bagi satu group / batch — satu baris untuk
	setiap room_id (fallback booking+cabin_no), diumpuk occupant traveller,
	disusun ikut Room ID.

	privacy = filter Room Privacy ('Private' / 'Open Sharing' /
	'__blank__' untuk bilik tanpa nilai).
	"""
	_require_access()
	groups = _parse_groups(trip_group, trip_groups)

	conditions = ["b.trip_date IN %(groups)s", "br.status != 'Cancelled'", "b.status NOT IN %(excl)s"]
	fmt = {"groups": groups, "done": list(DOC_STATUS_DONE),
		   "excl": list(EXCLUDED_BOOKING_STATUSES)}

	if search:
		conditions.append("""(
			br.room_id LIKE %(s)s OR br.room_category LIKE %(s)s
			OR br.booking LIKE %(s)s OR b.booking_number LIKE %(s)s
			OR br.traveller_full_name LIKE %(s)s OR t.full_name LIKE %(s)s
			OR br.stateroom_no LIKE %(s)s
		)""")
		fmt["s"] = f"%{search}%"
	if privacy == "__blank__":
		conditions.append("IFNULL(br.room_privacy, '') = ''")
	elif privacy:
		conditions.append("br.room_privacy = %(privacy)s")
		fmt["privacy"] = privacy
	where = " AND ".join(conditions)

	try:
		limit = int(limit or 0)
	except (TypeError, ValueError):
		limit = 20

	# Semua row (tiada limit) diumpuk client-side? Tidak — umpuk di SQL
	# supaya limit dikira ikut bilik, bukan ikut reservation row. Kami
	# baca senarai room key dahulu (dengan limit), kemudian tarik
	# occupant untuk room tersebut.
	room_keys = frappe.db.sql(f"""
		SELECT {_ROOM_KEY} AS room_key
		FROM `tabBooking Reservation` br
		INNER JOIN tabBooking b ON b.name = br.booking
		LEFT JOIN tabTraveller t ON t.name = br.traveller
		WHERE {where}
		GROUP BY {_ROOM_KEY}
		ORDER BY {_ROOM_KEY}
	""", fmt, as_dict=True)

	total_rooms = len(room_keys)
	keys = room_keys[:limit] if limit > 0 else room_keys
	if not keys:
		return {"rooms": [], "shown": 0, "count": 0}

	fmt["room_keys"] = [r.room_key for r in keys]

	rows = frappe.db.sql(f"""
		SELECT {_ROOM_KEY} AS room_key,
		       br.room_id, IFNULL(NULLIF(br.room_category, ''), 'Unassigned') AS room_category,
		       br.stateroom_no, br.cabin_no, br.room_privacy, br.cabin_is_confirmed,
		       br.date_selection AS trip_group,
		       br.name AS reservation, br.booking, b.booking_number,
		       br.guest_sequence, br.pax_type,
		       COALESCE(NULLIF(br.traveller_full_name, ''), NULLIF(t.full_name, ''), br.traveller, '') AS traveller_name,
		       COALESCE(NULLIF(br.traveller_gender, ''), NULLIF(t.gender, ''), '') AS gender,
		       COALESCE(NULLIF(t.status, ''), IFNULL(br.document_status, 'Incomplete')) AS document_status,
		       br.action_for_accomodation
		FROM `tabBooking Reservation` br
		INNER JOIN tabBooking b ON b.name = br.booking
		LEFT JOIN tabTraveller t ON t.name = br.traveller
		WHERE br.status != 'Cancelled' AND b.status NOT IN %(excl)s
		  AND b.trip_date IN %(groups)s
		  AND {_ROOM_KEY} IN %(room_keys)s
		ORDER BY {_ROOM_KEY}, br.guest_sequence, br.name
	""", fmt, as_dict=True)

	rooms = []
	by_room = {}
	for r in rows:
		entry = by_room.get(r.room_key)
		if not entry:
			entry = {
				"room_key": r.room_key,
				"room_id": r.room_id or r.room_key,
				"room_category": r.room_category,
				"stateroom_no": r.stateroom_no or "",
				"cabin_no": _i(r.cabin_no),
				"room_privacy": r.room_privacy or "",
				"cabin_confirmed": bool(r.cabin_is_confirmed),
				"trip_group": r.trip_group or "",
				"bookings": [],
				"guests": [],
				"docs_ok": 0,
				"pending_docs": 0,
			}
			by_room[r.room_key] = entry
			rooms.append(entry)
		if r.booking_number and r.booking_number not in entry["bookings"]:
			entry["bookings"].append(r.booking_number)
		entry["guests"].append({
			"reservation": r.reservation,
			"booking": r.booking,
			"name": r.traveller_name or "-",
			"gender": r.gender or "",
			"guest_sequence": _i(r.guest_sequence),
			"pax_type": r.pax_type or "",
			"document_status": r.document_status,
		})
		if r.document_status in DOC_STATUS_DONE:
			entry["docs_ok"] += 1
		else:
			entry["pending_docs"] += 1

	for entry in rooms:
		entry["pax"] = len(entry["guests"])

	return {"rooms": rooms, "shown": len(rooms), "count": total_rooms}


@frappe.whitelist()
def get_booking_profile(booking: str = None) -> dict:
	"""Profil penuh SATU booking untuk page Booking Info — diklik dari
	Booking Number / Booking ID dalam tab Booking page Manage Booking Group
	(route /app/manage-booking-group/booking/<name>).

	Satukan semua maklumat berkaitan booking dalam satu payload:
	- profile      — profil Booking (customer, trip, channel, diskaun,
	                 terms) + nilai wang per currency daripada Sales Order
	                 (utama + addon, docstatus=1 — selari agregat group)
	- reservations — senarai Booking Reservation + traveller (snapshot
	                 pada reservation, fallback doctype Traveller)
	- documents    — Sales Order (semua docstatus, utama & addon dilabel),
	                 Sales Invoice, Proforma Invoice
	- rooming      — bilik ikut room_id (fallback booking + cabin_no)
	                 + occupant traveller
	"""
	_require_access()
	if not booking:
		frappe.throw(_("Booking is required"))

	if not frappe.db.get_value("Booking", booking, "name"):
		frappe.throw(_("Booking {0} not found").format(booking))

	fmt = {"booking": booking, "def_cur": _def_cur(),
		   "done": list(DOC_STATUS_DONE)}

	# ── Profil — satu row Booking + customer + trip/group snapshot ──
	r = frappe.db.sql("""
		SELECT b.name, b.booking_number, b.status, b.payment_status,
		       b.booking_channel, b.checkout_method, b.booked_by,
		       b.customer, c.customer_name,
		       b.cust_email, b.get_cust_booking_phone AS cust_phone,
		       b.customer_message,
		       b.trip_name AS trip, tm.trip_name AS trip_title,
		       b.trip_package, b.package_type, b.company,
		       b.trip_date, tgd.trip_group_name, tgd.status AS group_status,
		       tgd.ship_name, tgd.group_batch,
		       tm.route AS trip_route, tm.published AS trip_published,
		       b.departure_date, b.return_date,
		       b.is_a_cruise_trip, b.cruise_start, b.cruise_end,
		       b.total_days, b.total_night,
		       b.affiliate, b.referral_code_used, b.b2b_partner,
		       b.end_customer, b.voucher, b.prog_payment,
		       b.booked_pax,
		       b.pre_discount_total,
		       b.voucher_discount, b.price_rule_discount, b.referral_discount,
		       b.terms_accepted, b.terms_accepted_at,
		       b.creation, b.modified,
		       COALESCE(NULLIF((SELECT so2.currency FROM `tabSales Order` so2
		           WHERE so2.custom_booking = b.name AND so2.docstatus = 1
		           ORDER BY so2.creation ASC, so2.name ASC LIMIT 1), ''),
		           %(def_cur)s) AS discount_currency,
		       NULLIF((SELECT so3.currency FROM `tabSales Order` so3
		           WHERE so3.custom_booking = b.name AND so3.docstatus = 1
		           ORDER BY so3.creation ASC, so3.name ASC LIMIT 1), '') AS booking_currency
		FROM tabBooking b
		LEFT JOIN tabCustomer c ON c.name = b.customer
		LEFT JOIN `tabTrip Group Date` tgd ON tgd.name = b.trip_date
		LEFT JOIN `tabTrip` tm ON tm.name = tgd.trip
		WHERE b.name = %(booking)s
	""", fmt, as_dict=True)[0]

	# ── Wang per (currency) — SO submitted booking ni. Utama & addon
	# boleh berbeza currency; JANGAN jumlah merentas currency.
	by_cur = _sort_cur_rows([
		{
			"currency": m.currency,
			"gross": _f(m.gross),
			"paid": _f(m.paid),
			"balance": round(_f(m.gross) - _f(m.paid), 2),
		}
		for m in frappe.db.sql("""
			SELECT COALESCE(NULLIF(so.currency, ''), %(def_cur)s) AS currency,
			       SUM(so.grand_total) AS gross, SUM(so.advance_paid) AS paid
			FROM `tabSales Order` so
			WHERE so.docstatus = 1 AND so.custom_booking = %(booking)s
			GROUP BY COALESCE(NULLIF(so.currency, ''), %(def_cur)s)
		""", fmt, as_dict=True)
	])
	default_totals = _annotate_default(by_cur, ["gross", "paid", "balance"])

	# Order Summary — virtual field Booking (property order_summary():
	# kira live daripada SO UTAMA, pecahan ikut kabin "Cabin Fare" +
	# "Guest N" per orang seperti Payment Summary pada wizard booking).
	# frappe.db.get_value tak kira virtual field — kena get_doc penuh.
	order_summary = frappe.get_doc("Booking", booking).order_summary or ""

	profile = {
		"booking": booking,
		"name": r.name,
		"booking_number": r.booking_number or r.name,
		"status": r.status or "",
		"payment_status": r.payment_status or "",
		"booking_channel": r.booking_channel or "",
		"checkout_method": r.checkout_method or "",
		"booked_by": r.booked_by or "",
		"customer": r.customer or "",
		"customer_name": r.customer_name or r.customer or "-",
		"cust_email": r.cust_email or "",
		"cust_phone": r.cust_phone or "",
		"customer_message": r.customer_message or "",
		"trip": r.trip or "",
		"trip_title": r.trip_title or "",
		"trip_route": (r.trip_route or "").strip(),
		"trip_published": bool(r.trip_published),
		"trip_package": r.trip_package or "",
		"package_type": r.package_type or "",
		"company": r.company or "",
		"trip_date": r.trip_date or "",
		"trip_group_name": r.trip_group_name or "",
		"group_status": r.group_status or "",
		"ship_name": r.ship_name or "",
		"group_batch": (r.group_batch or "").strip(),
		"departure_date": _s(r.departure_date),
		"return_date": _s(r.return_date),
		"is_a_cruise_trip": bool(r.is_a_cruise_trip),
		"cruise_start": _s(r.cruise_start),
		"cruise_end": _s(r.cruise_end),
		"total_days": _i(r.total_days),
		"total_night": _i(r.total_night),
		"affiliate": r.affiliate or "",
		"referral_code_used": r.referral_code_used or "",
		"b2b_partner": r.b2b_partner or "",
		"end_customer": r.end_customer or "",
		"voucher": r.voucher or "",
		# booking_currency = currency SO utama; fallback axis default.
		# Booking.total_amount / balance_amount ialah property Python
		# (bukan kolum DB) — nilai wang diambil daripada money_by_currency
		# (pecahan per currency daripada SO) yang lebih tepat.
		"booking_currency": r.booking_currency or r.discount_currency or "",
		"prog_payment": _f(r.prog_payment),
		"booked_pax": _i(r.booked_pax),
		"pre_discount_total": _f(r.pre_discount_total),
		"voucher_discount": _f(r.voucher_discount),
		"price_rule_discount": _f(r.price_rule_discount),
		"referral_discount": _f(r.referral_discount),
		"discount_currency": r.discount_currency,
		"terms_accepted": bool(r.terms_accepted),
		"terms_accepted_at": _s(r.terms_accepted_at),
		"creation": _s(r.creation),
		"modified": _s(r.modified),
		"money_by_currency": by_cur,
		"default_totals": default_totals,
		"order_summary": order_summary,
	}

	# ── Reservations + traveller — DOCTYPE TRAVELLER DIUTAMAKAN (sumber
	# utama modal traveller), fallback snapshot Booking Reservation (add-on).
	# Semua status reservation disertakan — badge papar Cancelled berasingan. ──
	res_rows = frappe.db.sql("""
		SELECT br.name AS reservation, br.status AS reservation_status,
		       br.guest_sequence, br.pax_type, br.guest_label,
		       br.room_id, br.cabin_no, br.stateroom_no,
		       br.room_privacy, br.cabin_is_confirmed,
		       IFNULL(NULLIF(br.room_category, ''), 'Unassigned') AS room_category,
		       br.date_selection AS trip_group,
		       CASE WHEN br.is_a_cruise = 1 THEN NULLIF(br.cruise_start, '0000-00-00')
		            ELSE NULLIF(br.departure_date, '0000-00-00') END AS ref_date,
		       COALESCE(NULLIF(t.full_name, ''), NULLIF(br.traveller_full_name, ''),
		                br.traveller, '') AS traveller_name,
		       br.traveller,
		       COALESCE(NULLIF(t.gender, ''), NULLIF(br.traveller_gender, ''), '') AS gender,
		       COALESCE(NULLIF(t.date_of_birth, ''),
		                NULLIF(NULLIF(br.traveller_datebirth, '0000-00-00'), ''), '') AS dob,
		       COALESCE(NULLIF(t.nationality, ''),
		                NULLIF(br.traveller_nationality, ''), '') AS nationality,
		       COALESCE(NULLIF(t.passport_no, ''),
		                NULLIF(br.traveller_passportno, ''), '') AS passport_no,
		       COALESCE(NULLIF(t.passport_expiry, ''),
		                NULLIF(br.traveller_passportexpiry, ''), '') AS passport_expiry,
		       COALESCE(NULLIF(t.ic_number, ''),
		                NULLIF(br.traveller_ic, ''), '') AS ic_number,
		       COALESCE(NULLIF(t.email, ''), NULLIF(br.traveller_email, ''), '') AS email,
		       COALESCE(NULLIF(t.phone, ''), NULLIF(br.traveller_phone, ''), '') AS phone,
		       COALESCE(NULLIF(t.passport_image, ''),
		                NULLIF(br.traveller_passportimg, ''), '') AS passport_image,
		       t.visa_photo,
		       t.status AS traveller_status, t.document_verified,
		       COALESCE(NULLIF(t.title, ''), NULLIF(br.traveller_title, ''), '') AS title,
		       COALESCE(NULLIF(t.first_name, ''),
		                NULLIF(br.traveller_first_name, ''), '') AS first_name,
		       COALESCE(NULLIF(t.last_name, ''),
		                NULLIF(br.traveller_last_name, ''), '') AS last_name,
		       COALESCE(NULLIF(t.emergency_contact_name, ''),
		                NULLIF(br.traveller_emergency_contact_name, ''), '') AS emergency_contact_name,
		       COALESCE(NULLIF(t.emergency_contact_phone, ''),
		                NULLIF(br.traveller_emergency_contact_phone, ''), '') AS emergency_contact_phone,
		       COALESCE(NULLIF(t.emergency_contact_relationship, ''),
		                NULLIF(br.traveller_emergency_contact_relationship, ''), '') AS emergency_contact_relationship,
		       COALESCE(NULLIF(t.address_line1, ''),
		                NULLIF(br.traveller_address_line1, ''), '') AS address_line1,
		       COALESCE(NULLIF(t.city, ''), NULLIF(br.traveller_city, ''), '') AS city,
		       COALESCE(NULLIF(t.postcode, ''), NULLIF(br.traveller_postcode, ''), '') AS postcode,
		       COALESCE(NULLIF(t.state, ''), NULLIF(br.traveller_state, ''), '') AS state,
		       COALESCE(NULLIF(t.country, ''), NULLIF(br.traveller_country, ''), '') AS country,
		       t.wheelchair_assistant, t.dietary_requirements,
		       COALESCE(NULLIF(t.medical_conditions, ''),
		                NULLIF(br.traveller_medical_conditions, ''), '') AS medical_conditions,
		       COALESCE(NULLIF(t.medicine_treatment, ''),
		                NULLIF(br.traveller_medicine_treatment, ''), '') AS medicine_treatment,
		       t.age_category,
		       br.customer_message,
		       COALESCE(NULLIF(t.status, ''), IFNULL(br.document_status, 'Incomplete')) AS document_status,
		       br.delegate_no, br.aroya_guest_no,
		       br.flight, br.airline,
		       b.name AS booking, b.booking_number AS b_booking_number,
		       c.customer_name, b.cust_email,
		       b.get_cust_booking_phone AS cust_phone,
		       b.customer_message AS booking_message
		FROM `tabBooking Reservation` br
		LEFT JOIN `tabTraveller` t ON t.name = br.traveller
		LEFT JOIN tabBooking b ON b.name = br.booking
		LEFT JOIN tabCustomer c ON c.name = b.customer
		WHERE br.booking = %(booking)s
		ORDER BY br.guest_sequence, br.name
	""", fmt, as_dict=True)

	reservations = []
	for row in res_rows:
		years = _age_years(row.dob, row.ref_date)
		reservations.append({
			"reservation": row.reservation,
			"reservation_status": row.reservation_status or "",
			# Konteks booking — disambung melalui Booking Reservation
			# (br.booking → tabBooking + tabCustomer).
			"booking": row.booking or booking,
			"booking_number": row.b_booking_number or booking,
			"customer_name": row.customer_name or "",
			"cust_email": row.cust_email or "",
			"cust_phone": row.cust_phone or "",
			"booking_message": row.booking_message or "",
			"traveller": row.traveller or "",
			"traveller_name": row.traveller_name or "-",
			"gender": row.gender or "",
			"dob": _s(row.dob),
			"age": years,
			"age_bucket": _age_bucket(years),
			"nationality": row.nationality or "",
			"passport_no": row.passport_no or "",
			"passport_expiry": _s(row.passport_expiry),
			"email": row.email or "",
			"phone": row.phone or "",
			"passport_image": row.passport_image or "",
			"visa_photo": row.visa_photo or "",
			"traveller_status": row.traveller_status or "",
			"document_verified": bool(row.document_verified),
			"title": row.title or "",
			"first_name": row.first_name or "",
			"last_name": row.last_name or "",
			"emergency_contact_name": row.emergency_contact_name or "",
			"emergency_contact_phone": row.emergency_contact_phone or "",
			"emergency_contact_relationship": row.emergency_contact_relationship or "",
			"address_line1": row.address_line1 or "",
			"city": row.city or "",
			"postcode": row.postcode or "",
			"state": row.state or "",
			"country": row.country or "",
			"ic_number": row.ic_number or "",
			"wheelchair_assistant": row.wheelchair_assistant or "",
			"dietary_requirements": row.dietary_requirements or "",
			"medical_conditions": row.medical_conditions or "",
			"medicine_treatment": row.medicine_treatment or "",
			"age_category": row.age_category or "",
			"reservation_note": (row.customer_message or r.customer_message or ""),
			"document_status": row.document_status,
			"room_id": row.room_id or "",
			"cabin_no": _i(row.cabin_no),
			"stateroom_no": row.stateroom_no or "",
			"room_privacy": row.room_privacy or "",
			"cabin_confirmed": bool(row.cabin_is_confirmed),
			"room_category": row.room_category,
			"trip_group": row.trip_group or "",
			"pax_type": row.pax_type or "",
			"guest_label": row.guest_label or "",
			"guest_sequence": _i(row.guest_sequence),
			"delegate_no": row.delegate_no or "",
			"aroya_guest_no": _i(row.aroya_guest_no) or "",
			"flight": row.flight or "",
			"airline": row.airline or "",
		})

	# ── Log aktiviti traveller — TANPA tambah field/query SQL utama:
	# tarikh daftar = Traveller.creation (kolum standard), kemaskini =
	# doctype Version (log "Activity" form; track_changes aktif),
	# fallback Traveller.modified bila tiada version. ──
	trav_names = list({r["traveller"] for r in reservations if r["traveller"]})
	trav_meta = {}
	if trav_names:
		for tm in frappe.get_all("Traveller",
				filters={"name": ("in", trav_names)},
				fields=["name", "creation", "modified"]):
			trav_meta[tm.name] = tm
		ver_map = {}
		for v in frappe.get_all("Version",
				filters={"ref_doctype": "Traveller", "docname": ("in", trav_names)},
				fields=["docname", "creation"], order_by="creation asc"):
			ver_map.setdefault(v.docname, []).append(_s(v.creation))
	else:
		ver_map = {}
	for res in reservations:
		tm = trav_meta.get(res["traveller"])
		res["traveller_created"] = _s(tm.creation) if tm else ""
		res["traveller_modified"] = _s(tm.modified) if tm else ""
		res["traveller_versions"] = ver_map.get(res["traveller"], [])

	# ── Transactions — Sales Order (semua docstatus; addon dilabel).
	# SO dengan custom_booking_addon diisi ialah addon; SO 'utama' ialah
	# SO pertama booking (creation terawal) — selari _get_primary_so().
	sos = frappe.db.sql("""
		SELECT so.name, so.custom_booking_addon, so.status, so.docstatus,
		       so.transaction_date, so.currency, so.grand_total,
		       so.advance_paid, so.creation
		FROM `tabSales Order` so
		WHERE so.custom_booking = %(booking)s
		ORDER BY so.creation ASC, so.name ASC
	""", fmt, as_dict=True)
	so_names = [so.name for so in sos]
	fmt["sos"] = tuple(so_names)

	sales_orders = [{
		"name": so.name,
		"is_addon": bool(so.custom_booking_addon),
		"status": so.status or "",
		"docstatus": _i(so.docstatus),
		"transaction_date": _s(so.transaction_date),
		"currency": so.currency or _def_cur(),
		"grand_total": _f(so.grand_total),
		"advance_paid": _f(so.advance_paid),
		"balance": round(_f(so.grand_total) - _f(so.advance_paid), 2),
		"creation": _s(so.creation),
	} for so in sos]

	# Payment Entry — rujukan terus ke SO booking ni ATAU ke Sales Invoice
	# yang dijana daripada SO tersebut (mekanisme "Get Advances Received"
	# ERPNext mengalihkan rujukan PE dari SO ke SI). Satu row per
	# reference; frontend kumpulkan per PE. allocated_amount ikut currency
	# dokumen rujukan (SO/SI), fallback paid_from_account_currency.
	payments = []
	if so_names:
		payments = [{
			"name": pe.name,
			"reference_date": _s(pe.reference_date),
			"mode_of_payment": pe.mode_of_payment or "",
			"reference_no": pe.reference_no or "",
			"docstatus": _i(pe.docstatus),
			"creation": _s(pe.creation),
			"paid_to": pe.paid_to or "",
			"reference_doctype": pe.reference_doctype,
			"reference_name": pe.reference_name,
			"allocated_amount": _f(pe.allocated_amount),
			"currency": (pe.currency or pe.paid_from_account_currency
						 or _def_cur()),
		} for pe in frappe.db.sql("""
			SELECT pe.name, pe.reference_date, pe.mode_of_payment,
			       pe.reference_no, pe.docstatus, pe.creation,
			       pe.paid_to, pe.paid_from_account_currency,
			       per.reference_doctype, per.reference_name,
			       per.allocated_amount,
			       COALESCE(NULLIF(so.currency, ''), NULLIF(si.currency, ''),
			                NULLIF(pe.paid_from_account_currency, '')) AS currency
			FROM `tabPayment Entry` pe
			JOIN `tabPayment Entry Reference` per ON per.parent = pe.name
			LEFT JOIN `tabSales Order` so
			       ON per.reference_doctype = 'Sales Order'
			       AND so.name = per.reference_name
			LEFT JOIN `tabSales Invoice` si
			       ON per.reference_doctype = 'Sales Invoice'
			       AND si.name = per.reference_name
			WHERE (per.reference_doctype = 'Sales Order'
			       AND per.reference_name IN %(sos)s)
			   OR (per.reference_doctype = 'Sales Invoice'
			       AND per.reference_name IN (
			         SELECT DISTINCT sii.parent
			         FROM `tabSales Invoice Item` sii
			         WHERE sii.sales_order IN %(sos)s))
			ORDER BY pe.creation DESC, per.idx ASC
		""", fmt, as_dict=True)]

	# Lampiran Payment Entry — bukti bayaran (resit bank / screenshot
	# gateway) yang dilampirkan pada PE. Peta per PE nama untuk quick
	# view / muat turun pada jadual Payment Entries.
	payment_files = {}
	if payments:
		pe_names = sorted({p["name"] for p in payments})
		# is_image derivasi daripada file_type / extension URL — versi
		# File doctype di bench ini tiada kolum is_image.
		img_exts = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")
		for f in frappe.get_all("File",
				filters={"attached_to_doctype": "Payment Entry",
				         "attached_to_name": ["in", pe_names]},
				fields=["name", "file_name", "file_url", "file_type",
				        "attached_to_name"]):
			f_url = f.file_url or ""
			is_image = bool(f.file_type and str(f.file_type).startswith("image")) \
				or f_url.lower().endswith(img_exts)
			payment_files.setdefault(f.attached_to_name, []).append({
				"name": f.name,
				"file_name": f.file_name or f_url.split("/")[-1],
				"file_url": f_url,
				"is_image": is_image,
			})

	# ── Documents — SI + Proforma Invoice (senarai maklumat, bukan
	# kiraan). SI dipaut melalui si.custom_booking ATAU item yang trace
	# ke SO booking ni (SI manual mungkin tiada custom_booking).
	sales_invoices = []
	proforma_invoices = []
	if so_names:
		sales_invoices = [{
			"name": si.name,
			"posting_date": _s(si.posting_date),
			"currency": si.currency or _def_cur(),
			"grand_total": _f(si.grand_total),
			"outstanding_amount": _f(si.outstanding_amount),
			"status": si.status or "",
			"docstatus": _i(si.docstatus),
		} for si in frappe.db.sql("""
			SELECT DISTINCT si.name, si.posting_date, si.currency,
			       si.grand_total, si.outstanding_amount, si.status,
			       si.docstatus
			FROM `tabSales Invoice` si
			WHERE si.docstatus != 2
			  AND (si.custom_booking = %(booking)s
			       OR si.name IN (
			         SELECT sii.parent FROM `tabSales Invoice Item` sii
			         WHERE sii.sales_order IN %(sos)s))
			ORDER BY si.posting_date DESC, si.name DESC
		""", fmt, as_dict=True)]

		proforma_invoices = [{
			"name": pf.name,
			"proforma_date": _s(pf.proforma_date),
			"currency": pf.currency or _def_cur(),
			"grand_total": _f(pf.grand_total),
			"status": pf.status or "",
			"docstatus": _i(pf.docstatus),
			"proforma_pdf": pf.proforma_pdf or "",
		} for pf in frappe.db.sql("""
			SELECT name, proforma_date, currency, grand_total, status,
			       docstatus, proforma_pdf
			FROM `tabProforma Invoice`
			WHERE sales_order IN %(sos)s
			ORDER BY creation DESC
		""", fmt, as_dict=True)]

	# ── Rooming — umpuk reservation ikut room key (selari
	# get_group_rooming; reservation Cancelled dikecualikan) ──
	rooms = []
	by_room = {}
	for row in frappe.db.sql(f"""
		SELECT {_ROOM_KEY} AS room_key,
		       br.room_id, IFNULL(NULLIF(br.room_category, ''), 'Unassigned') AS room_category,
		       br.stateroom_no, br.cabin_no, br.room_privacy, br.cabin_is_confirmed,
		       br.delegate_no, br.aroya_guest_no,
		       br.name AS reservation, br.guest_sequence, br.pax_type,
		       COALESCE(NULLIF(br.traveller_full_name, ''), NULLIF(t.full_name, ''),
		                br.traveller, '') AS traveller_name,
		       COALESCE(NULLIF(br.traveller_gender, ''), NULLIF(t.gender, ''), '') AS gender,
		       COALESCE(NULLIF(t.status, ''), IFNULL(br.document_status, 'Incomplete')) AS document_status
		FROM `tabBooking Reservation` br
		LEFT JOIN `tabTraveller` t ON t.name = br.traveller
		WHERE br.booking = %(booking)s AND br.status != 'Cancelled'
		ORDER BY {_ROOM_KEY}, br.guest_sequence, br.name
	""", fmt, as_dict=True):
		entry = by_room.get(row.room_key)
		if not entry:
			entry = {
				"room_key": row.room_key,
				"room_id": row.room_id or row.room_key,
				"room_category": row.room_category,
				"stateroom_no": row.stateroom_no or "",
				"cabin_no": _i(row.cabin_no),
				"room_privacy": row.room_privacy or "",
				"cabin_confirmed": bool(row.cabin_is_confirmed),
				"delegate_no": "",
				"aroya_guest_no": "",
				"guests": [],
				"docs_ok": 0,
				"pending_docs": 0,
			}
			by_room[row.room_key] = entry
			rooms.append(entry)
		# delegate_no / aroya_guest_no ialah medan per-reservation —
		# bilik mengambil nilai pertama yang ada untuk paparan kepala.
		if not entry["delegate_no"] and row.delegate_no:
			entry["delegate_no"] = row.delegate_no
		if not entry["aroya_guest_no"] and row.aroya_guest_no:
			aroya = _i(row.aroya_guest_no)
			if aroya and not entry["aroya_guest_no"]:
				entry["aroya_guest_no"] = aroya
		entry["guests"].append({
			"reservation": row.reservation,
			"name": row.traveller_name or "-",
			"gender": row.gender or "",
			"guest_sequence": _i(row.guest_sequence),
			"pax_type": row.pax_type or "",
			"document_status": row.document_status,
		})
		if row.document_status in DOC_STATUS_DONE:
			entry["docs_ok"] += 1
		else:
			entry["pending_docs"] += 1

	for entry in rooms:
		entry["pax"] = len(entry["guests"])

	# ── Tab Others — komisen affiliate (Affiliate Commission ikut SO
	# booking — utama + addon; row reversal dilabel), + info ringkas
	# affiliate (Affiliate Profile via Booking.affiliate → Sales
	# Partner): referral code, email & telefon sahaja. ──
	commissions = []
	if so_names:
		for c in frappe.get_all("Affiliate Commission",
				filters={"sales_order": ("in", tuple(so_names))},
				fields=["name", "sales_order", "currency", "commission_amount",
					"commission_rate", "commission_base", "status", "is_reversal",
					"creation"],
				order_by="creation desc"):
			commissions.append({
				"name": c.name,
				"sales_order": c.sales_order or "",
				"currency": c.currency or "",
				"amount": _f(c.commission_amount),
				"rate": _f(c.commission_rate),
				"base": c.commission_base or "",
				"status": c.status or "",
				"is_reversal": bool(c.is_reversal),
				"creation": _s(c.creation),
			})

	affiliate_info = None
	if r.affiliate:
		ap = frappe.db.get_value("Affiliate Profile",
			{"sales_partner": r.affiliate},
			["name", "full_name", "referral_code", "email_id", "phone"], as_dict=True)
		if ap:
			affiliate_info = {
				"name": ap.name,
				"full_name": ap.full_name or "",
				"referral_code": ap.referral_code or "",
				"email": ap.email_id or "",
				"phone": ap.phone or "",
			}

	return {
		"booking": booking,
		"currency": _def_cur(),
		"profile": profile,
		"reservations": reservations,
		"reservations_count": len(reservations),
		"transactions": {
			"payments": payments,
			"payment_files": payment_files,
		},
		"documents": {
			"sales_orders": sales_orders,
			"sales_invoices": sales_invoices,
			"proforma_invoices": proforma_invoices,
		},
		"rooming": rooms,
		"rooming_count": len(rooms),
		"commissions": commissions,
		"affiliate_info": affiliate_info,
	}


# ── Tab Travellers — muat turun pukal (zip imej / excel maklumat) ──
# Kedua-dua endpoint guna semula get_booking_profile (satu sumber data,
# termasuk fallback snapshot reservation → Traveller) dan balas sebagai
# attachment download (type=download).

def _traveller_image_abs_path(file_url):
	"""file_url ('/private/files/x' atau '/files/x') → path mutlak disk."""
	import os
	from frappe.utils import get_files_path
	if not file_url:
		return None
	if file_url.startswith("/private/files/"):
		rel = file_url[len("/private/files/"):]
		path = get_files_path(rel, is_private=1)
	elif file_url.startswith("/files/"):
		rel = file_url[len("/files/"):]
		path = get_files_path(rel)
	else:
		return None
	return path if os.path.isfile(path) else None


def _zip_arcname(base_name, ext, used):
	"""Nama selamat untuk entri zip + nyahduplikasi (Nama (2).jpg)."""
	import re
	safe = re.sub(r"[^\w\- ]", "", str(base_name or "traveller")).strip() or "traveller"
	name, n = f"{safe}{ext}", 2
	while name in used:
		name = f"{safe} ({n}){ext}"
		n += 1
	used.add(name)
	return name


def _traveller_download_scope(booking: str = None, trip_group: str = None,
							  trip_groups: "list | str" = None):
	"""Skop muat turun traveller — disatukan pada get_group_travellers.
	Return (baris travellers, nama asas fail). Mode booking bila `booking`
	diberikan; jika tidak mode group/batch (reservation Cancelled &
	booking Cancelled/Abandoned diketepikan).

	`trip_groups` menerima list (frappe.call POST) ATAU string JSON /
	berkoma (pautan <a href> GET) — _parse_groups normalize kedua-duanya."""
	if booking:
		data = get_group_travellers(booking=booking, limit=0)
		return data.get("travellers", []), booking
	groups = _parse_groups(trip_group, trip_groups)
	data = get_group_travellers(trip_groups=groups, limit=0)
	return data.get("travellers", []), "-".join(groups)[:60] or "groups"


@frappe.whitelist()
def download_traveller_images(booking: str = None, trip_group: str = None,
							  trip_groups: "list | str" = None):
	"""Zip SEMUA fail traveller — medan attach passport_image & visa_photo
	setiap reservation + semua fail dilampirkan (File) pada Traveller /
	Booking Reservation. Setiap fail dinamakan dengan format
	'{passport no} - {nama penuh} - {label}' (label: passport / visa,
	fallback nama fail asal untuk lampiran lain).

	Skop: satu booking (`booking`) ATAU satu group/batch (`trip_group` /
	`trip_groups`) — manifest fail penuh per trip."""
	import io
	import os
	import zipfile

	rows, base = _traveller_download_scope(booking, trip_group, trip_groups)
	used, entries, skipped = set(), [], []

	def add_entry(label: str, url: str, passport_no: str, full_name: str):
		"""Kumpul satu fail — dinamakan '{passport no} - {nama penuh} - {label}'."""
		if not url:
			return
		path = _traveller_image_abs_path(url)
		if not path:
			skipped.append(f"{full_name} — {label}: fail tidak dijumpai ({url})")
			return
		ext = os.path.splitext(url.split("?")[0])[1] or os.path.splitext(path)[1] or ".bin"
		base_name = " - ".join(x for x in (passport_no, full_name, label) if x)
		entries.append((_zip_arcname(base_name, ext, used), path))

	def label_for(filename: str) -> str:
		"""Label fail lampiran umum — visa/passport ikut nama fail, jika
		tidak kedua-duanya kekal nama asal fail."""
		low = (filename or "").lower()
		if "visa" in low:
			return "visa"
		if "pass" in low:
			return "passport"
		return os.path.splitext(filename or "fail")[0] or "fail"

	for r in rows:
		who = r.get("traveller_name") or r.get("reservation") or "traveller"
		pp = str(r.get("passport_no") or "").strip()
		field_urls = []
		for label, url in (("passport", r.get("passport_image")), ("visa", r.get("visa_photo"))):
			field_urls.append(url)
			add_entry(label, url, pp, who)
		# Semua fail lain dilampirkan (paperclip) pada Traveller / Booking
		# Reservation — supaya "Files" benar-benar menyertakan SEMUA fail.
		for dt, dn in (("Traveller", r.get("traveller")),
				("Booking Reservation", r.get("reservation"))):
			if not dn:
				continue
			for f in frappe.get_all("File",
					filters={"attached_to_doctype": dt, "attached_to_name": dn},
					fields=["file_name", "file_url"], order_by="creation asc"):
				if f.file_url in field_urls:
					continue  # medan attach passport/visa sudah diambil
				add_entry(label_for(f.file_name or f.file_url), f.file_url, pp, who)

	buf = io.BytesIO()
	with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
		if skipped:
			z.writestr("_SKIPPED.txt", "\n".join(skipped))
		if not entries and not skipped:
			z.writestr("_README.txt", "Tiada fail traveller dilampirkan pada skop ini.")
		for arcname, path in entries:
			with open(path, "rb") as fh:
				z.writestr(arcname, fh.read())

	frappe.local.response.update({
		"type": "download",
		"filename": f"traveller-files-{base}.zip",
		"filecontent": buf.getvalue(),
	})


def _traveller_export_rows(booking: str = None, trip_group: str = None,
						   trip_groups: list = None):
	"""Baris eksport traveller (satu baris setiap reservation, medan penuh
	daripada get_group_travellers — sumber disatukan) — dikongsi eksport
	XLSX & CSV. Kolum 'Booking' ditambah pada mode group/batch (baris
	merentas pelbagai booking). Return (rows, nama asas fail)."""
	rows_src, base = _traveller_download_scope(booking, trip_group, trip_groups)
	multi = not booking

	headers = [
		"No", "Traveller Name", "Reservation", "Reservation Status", "Doc Status",
		"Title", "Gender", "Date of Birth", "Age", "Age Category", "Nationality",
		"Passport No", "Passport Expiry", "IC Number",
		"Email", "Phone",
		"Emergency Contact Name", "Emergency Phone", "Emergency Relationship",
		"Address", "City", "Postcode", "State", "Country",
		"Wheelchair Assistant", "Dietary Requirements", "Medical Conditions", "Medicine / Treatment",
		"Room ID", "Room Category", "Room Privacy", "Cabin Confirmed",
		"Stateroom No", "Cabin No", "Delegate No", "Aroya Guest No",
		"Pax Type", "Guest Sequence", "Flight", "Airline",
		"Traveller Record", "Registered", "Last Updated",
	]
	if multi:
		headers.append("Booking")
	rows = [headers]
	for i, r in enumerate(rows_src, start=1):
		addr = ", ".join(x for x in (r.get("address_line1"), r.get("postcode"),
			r.get("city"), r.get("state"), r.get("country")) if x)
		row = [
			i, r.get("traveller_name"), r.get("reservation"), r.get("reservation_status"),
			r.get("document_status"), r.get("title"), r.get("gender"), r.get("dob"),
			r.get("age"), r.get("age_category"), r.get("nationality"),
			r.get("passport_no"), r.get("passport_expiry"), r.get("ic_number"),
			r.get("email"), r.get("phone"),
			r.get("emergency_contact_name"), r.get("emergency_contact_phone"),
			r.get("emergency_contact_relationship"),
			addr, r.get("city"), r.get("postcode"), r.get("state"), r.get("country"),
			r.get("wheelchair_assistant"), r.get("dietary_requirements"),
			r.get("medical_conditions"), r.get("medicine_treatment"),
			r.get("room_id"), r.get("room_category"), r.get("room_privacy"),
			"Yes" if r.get("cabin_confirmed") else "",
			r.get("stateroom_no"), r.get("cabin_no"), r.get("delegate_no"),
			r.get("aroya_guest_no"), r.get("pax_type"), r.get("guest_sequence"),
			r.get("flight"), r.get("airline"), r.get("traveller"),
			r.get("traveller_created"), r.get("traveller_modified"),
		]
		if multi:
			row.append(r.get("booking_number") or r.get("booking") or "")
		rows.append(row)
	return rows, base


@frappe.whitelist()
def download_travellers_excel(booking: str = None, trip_group: str = None,
							  trip_groups: "list | str" = None):
	"""Excel (XLSX) SEMUA maklumat traveller + booking reservation — skop
	satu booking ATAU satu group/batch (manifest trip)."""
	from frappe.utils.xlsxutils import make_xlsx

	rows, base = _traveller_export_rows(booking, trip_group, trip_groups)
	out = make_xlsx(rows, "Travellers")
	frappe.local.response.update({
		"type": "download",
		"filename": f"travellers-{base}.xlsx",
		"filecontent": out.getvalue() if out else b"",
	})


@frappe.whitelist()
def download_travellers_csv(booking: str = None, trip_group: str = None,
							trip_groups: "list | str" = None):
	"""CSV SEMUA maklumat traveller + booking reservation — baris sama
	dengan Excel; skop booking ATAU group/batch. BOM UTF-8 supaya Excel
	buka dengan aksara betul."""
	import csv
	import io

	rows, base = _traveller_export_rows(booking, trip_group, trip_groups)
	buf = io.StringIO()
	csv.writer(buf).writerows(rows)
	frappe.local.response.update({
		"type": "download",
		"filename": f"travellers-{base}.csv",
		"filecontent": buf.getvalue().encode("utf-8-sig"),
	})
