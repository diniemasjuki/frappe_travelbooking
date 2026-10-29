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
import re
from datetime import date

import frappe
from frappe import _
from frappe.utils import getdate, validate_email_address

from travel_booking.api._helpers import standardize_phone_to_hyphen
from travel_booking.api.constants import DEFAULT_CURRENCY
from travel_booking.api.currency_axis import get_rate_to_default
from travel_booking.api.passport_maintenance import _ensure_private_url

# Roles yang dibenarkan akses page ni — selari dengan booking_hub.py
MANAGE_TRIP_ROLES = ["System Manager", "Tour Manager", "Tour Operator", "Accounts User"]

# Status dokumen yang dianggap SELESAI (bukan pending action).
DOC_STATUS_DONE = ("Verified",)

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

# Status group yang diARKIBKAN daripada senarai default page Manage Trip
# & Booking — kurangkan beban DB (senarai default hanya group aktif +
# arkib tahun semasa yang telah berangkat; arkib penuh atas permintaan
# user melalui param `archived`).
ARCHIVED_GROUP_STATUSES = ("Completed", "Cancelled")

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
	ref = getdate(ref or date.today())
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
					view: str = "all", archived: int = 0) -> dict:
	"""Senarai Trip Group Date + agregat ringkas setiap group untuk header
	accordion (bookings/pax/rooms/revenue/balance/docs). Front-end akan
	umpuk group yang share group_batch ke dalam satu baris batch —
	satu SQL, tiada N+1.

	search = identiti group (nama/kod/batch/trip/ship) ATAU kandungan
	group: booking number/docname/customer, traveller (nama/passport),
	stateroom (no/room_id) — group yang ada padanan tersenarai.

	archived = 0 (default): group TERARKIB (Completed/Cancelled) TIDAK
	dimuatkan kecuali arkib tahun semasa yang telah berangkat (recent
	archive) — kurangkan beban DB senarai default. archived = 1: semuanya
	dimuatkan (paparan "View Archived" atas permintaan user). Status
	terarkib yang dipilih EksPLISIT pada penapis status turut dilayani
	penuh — itu pun permintaan user.
	"""
	_require_access()

	conditions = ["1=1"]
	fmt = {}

	if status and status != "All":
		conditions.append("tgd.status = %(status)s")
		fmt["status"] = status
	elif not int(archived or 0):
		# Senarai default — buang yang terarkib KECUALI arkib tahun semasa
		# yang sudah berangkat (recent archive, "tahun semasa hingga hari
		# ini"). Ikon hakisan beban: puluhan group lama tidak dibaca.
		fmt["arch"] = list(ARCHIVED_GROUP_STATUSES)
		fmt["year_start"] = f"{frappe.utils.get_year_start(frappe.utils.nowdate())}"
		conditions.append("""(
			tgd.status NOT IN %(arch)s
			OR (COALESCE(tgd.departure_date, tgd.sailing_start) >= %(year_start)s
				AND COALESCE(tgd.departure_date, tgd.sailing_start) <= CURDATE())
		)""")
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
			resv.pax, resv.rooms, resv.pending_docs, resv.docs_submitted, resv.docs_verified,
			ad.addon_count
		FROM `tabTrip Group Date` tgd
		LEFT JOIN (
			SELECT b.trip_date AS grp,
			       SUM(CASE WHEN b.status NOT IN %(excl)s THEN 1 ELSE 0 END) AS booking_count,
			       SUM(CASE WHEN b.status = 'Cancelled' THEN 1 ELSE 0 END) AS cancelled_count
			FROM tabBooking b
			GROUP BY b.trip_date
		) bk ON bk.grp = tgd.name
		LEFT JOIN (
			SELECT ba.trip_date AS grp, COUNT(*) AS addon_count
			FROM `tabBooking Addon` ba
			WHERE ba.status != 'Cancelled'
			GROUP BY ba.trip_date
		) ad ON ad.grp = tgd.name
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
			"addon_count": _i(g.addon_count),
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


# Alias medan penapis dinamik SENARAI BOOKING — hanya doctype dengan join
# tetap dalam kueri get_group_bookings (b = tabBooking, c = tabCustomer).
# Penapis atas Booking Reservation / Traveller tidak dibenarkan di sini
# (kueri booking tiada join br/t) — guna _TV_FILTER_ALIASES untuk itu.
_BK_FILTER_ALIASES = {"Booking": "b", "Customer": "c"}


def _bk_summary(trip_groups=None) -> dict:
	"""Ringkasan kecil senarai booking (jalur summary) — mirror _tv_summary.
	Skop PENUH group/batch yang diminta (tidak terpengaruh carian / tapisan
	status / payment / currency / penapis dinamik) supaya jalur kekal stabil
	semasa pengguna menapis. Wang dipecah per currency + jumlah bersamaan
	default currency (≈); collected_pct = paid/gross dalam default currency.
	Pulangkan juga docs_verified (dokumen pelawat disahkan) & default_gross /
	default_paid utk jalur Total Revenue / Total Collection.
	"""
	groups = _parse_groups(None, trip_groups)
	fmt = {"groups": groups, "done": list(DOC_STATUS_DONE),
		   "def_cur": _def_cur()}
	where = "b.trip_date IN %(groups)s"

	totals = frappe.db.sql(f"""
		SELECT COUNT(*) AS cnt,
		       COALESCE(SUM(res.pax), 0) AS pax,
		       COALESCE(SUM(res.rooms), 0) AS rooms,
		       COALESCE(SUM(res.pending_docs), 0) AS pending_docs,
		       COALESCE(SUM(res.docs_verified), 0) AS docs_verified
		FROM tabBooking b
		LEFT JOIN {_RES_PER_BOOKING}
		WHERE {where}
	""", fmt, as_dict=True)[0]

	by_cur = {}
	for r in frappe.db.sql(f"""
		SELECT soc.currency, SUM(soc.gross) AS gross, SUM(soc.paid) AS paid
		FROM tabBooking b
		INNER JOIN {_SO_PER_BOOKING_CUR} ON soc.booking = b.name
		WHERE {where}
		GROUP BY soc.currency
	""", fmt, as_dict=True):
		by_cur[r.currency] = {
			"gross": _f(r.gross), "paid": _f(r.paid),
			"balance": round(_f(r.gross) - _f(r.paid), 2),
		}
	balance_rows = _sort_cur_rows([
		{"currency": cur, **vals} for cur, vals in by_cur.items()])
	dt = _annotate_default(balance_rows, ["gross", "paid", "balance"]) or {}
	gross = _f(dt.get("gross"))
	collected_pct = round((_f(dt.get("paid")) / gross) * 100, 1) if gross else 0
	return {
		"bookings": _i(totals.cnt),
		"pax": _i(totals.pax),
		"rooms": _i(totals.rooms),
		"pending_docs": _i(totals.pending_docs),
		"docs_verified": _i(totals.docs_verified),
		"balance_by_currency": balance_rows,
		"default_gross": _f(dt.get("gross")),
		"default_paid": _f(dt.get("paid")),
		"default_balance": _f(dt.get("balance")),
		"default_currency": dt.get("currency") or _def_cur(),
		"collected_pct": collected_pct,
		"rates_complete": dt.get("rates_complete", True),
	}


@frappe.whitelist()
def get_group_bookings(trip_group: str = None, trip_groups: list = None, status: str = None,
					   payment_status: str = None, search: str = None, currency: str = None,
					   custom_filters: list = None, custom_match: str = "AND",
					   limit: int = 20):
	"""Senarai booking (reservation) bagi satu Trip Group Date / batch
	dengan agregat setiap booking: pax, bilik, nilai SO, terbayar, baki,
	diskaun, dokumen pending.

	limit = row limit untuk quick preview (0 = semua). `count` dan
	`totals` dikira atas SEMUA row yang padan filter (bukan setakat
	yang dipaparkan) supaya footer kekal betul bila limit aktif.

	custom_filters: penapis dinamik [{doctype, fieldname, value, min?, max?}]
	atas medan Booking / Customer (join tetap kueri ini) — teks LIKE,
	lain-lain padanan tepat; medan nombor/tarikh boleh guna julat min/max.
	custom_match 'OR' gabungkan baris sebagai match-ANY (lalai AND).
	`summary` (jalur ringkasan) dikira atas skop penuh tanpa filter.
	"""
	_require_access()
	groups = _parse_groups(trip_group, trip_groups)

	conditions = ["b.trip_date IN %(groups)s"]
	fmt = {"groups": groups, "done": list(DOC_STATUS_DONE),
		   "excl": list(EXCLUDED_BOOKING_STATUSES)}
	conditions.extend(_tv_filter_conditions(custom_filters, fmt,
		"OR" if str(custom_match).upper() == "OR" else "AND",
		aliases=_BK_FILTER_ALIASES))

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
		# Jalur ringkasan — skop PENUH (tidak dipengaruhi carian/penapis),
		# selari semantik summary get_group_travellers.
		"summary": _bk_summary(groups),
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
def get_booking_filter_fields() -> list:
	"""Senarai medan yang boleh ditapis untuk penapis dinamik SENARAI
	BOOKING — medan meta doctype Booking & Customer sahaja (join tetap
	kueri get_group_bookings), dikumpulkan ikut doctype. Mirror
	get_traveller_filter_fields.

	Hanya medan yang BETUL-BETUL wujud sebagai kolum DB disenaraikan —
	meta boleh mendahului skema (doctype diedit tanpa migrate); medan
	tersebut tidak boleh ditapis (SQL error) jadi jangan tawarkan."""
	_require_access()
	out = []
	for dt in _BK_FILTER_ALIASES:
		try:
			cols = set(frappe.db.get_table_columns(dt))
		except Exception:
			cols = None
		fields = [{
			"fieldname": df.fieldname,
			"label": df.label or df.fieldname,
			"fieldtype": df.fieldtype,
			# Select — senarai pilihan penuh dari meta untuk autocomplete
			# nilai penapis (DISTINCT DB hanya liput nilai pernah digunakan).
			**({"options": [o.strip() for o in (df.options or "").split("\n")
				if o.strip()]} if df.fieldtype == "Select" else {}),
		} for df in frappe.get_meta(dt).fields
			if df.fieldtype in _TV_FILTER_FIELDTYPES
			and (cols is None or df.fieldname in cols)]
		if fields:
			out.append({"doctype": dt, "fields": fields})
	return out


@frappe.whitelist()
def get_booking_filter_values(doctype: str = None, fieldname: str = None,
							  trip_group: str = None, trip_groups: "list | str" = None,
							  search: str = None, limit: int = 100) -> dict:
	"""Nilai berbeza (distinct) satu medan dalam skop senarai booking —
	cadangan dropdown nilai penapis dinamik (datalist klien). Mirror
	get_traveller_filter_values, skop ikut join kueri booking (b + c)."""
	_require_access()
	alias, df = _tv_filter_field(doctype, fieldname, aliases=_BK_FILTER_ALIASES)
	groups = _parse_groups(trip_group, trip_groups)
	col = f"{alias}.`{df.fieldname}`"
	conditions = ["b.trip_date IN %(groups)s"]
	fmt = {"groups": groups}
	if search:
		conditions.append(f"CAST({col} AS CHAR) LIKE %(vs)s")
		fmt["vs"] = f"%{search}%"
	try:
		limit = max(1, min(int(limit or 100), 200))
	except (TypeError, ValueError):
		limit = 100
	rows = frappe.db.sql(f"""
		SELECT DISTINCT {col} AS v
		FROM tabBooking b
		LEFT JOIN tabCustomer c ON c.name = b.customer
		WHERE {' AND '.join(conditions)}
		ORDER BY v
		LIMIT {limit}
	""", fmt, as_dict=True)
	return {"values": ["" if r.v is None else _s(r.v) for r in rows]}


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


@frappe.whitelist()
def get_booking_addons_flights(booking: str = None) -> dict:
	"""Add-on & flight SATU booking — tab "Add-ons & Flights" L3 Booking
	Info (route /app/manage-booking-app/booking/<name>).

	Selari agregat L2 (get_group_addons / get_group_flights) tapi diskop
	kepada SATU booking:
	- addons  — Booking Addon yang dipaut terus (ba.booking = booking),
	            bentuk row sama dengan get_group_addons
	- flights — Flight yang dirujuk Booking.flight (satu link), bentuk row
	            sama dengan get_group_flights + pax_booking (pax booking NI
	            sahaja, daripada reservation aktif)
	"""
	_require_access()
	if not booking:
		frappe.throw(_("Booking is required"))
	if not frappe.db.get_value("Booking", booking, "name"):
		frappe.throw(_("Booking {0} not found").format(booking))

	fmt = {"booking": booking, "def_cur": _def_cur(),
		   "excl": list(EXCLUDED_BOOKING_STATUSES)}

	# ── Add-on order booking ni ──
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
	} for r in frappe.db.sql("""
		SELECT ba.name, ba.booking, ba.booking_number, ba.customer,
		       c.customer_name, ba.trip_package, ba.trip_date,
		       ba.status, ba.payment_status, ba.currency, ba.total_amount,
		       ba.notes, COALESCE(ba.order_date, ba.creation) AS order_date,
		       ba.creation,
		       (SELECT COUNT(*) FROM `tabBooking Addon Item` bai
		        WHERE bai.addon_order = ba.name) AS item_count
		FROM `tabBooking Addon` ba
		LEFT JOIN tabCustomer c ON c.name = ba.customer
		WHERE ba.booking = %(booking)s
		ORDER BY ba.creation DESC
	""", fmt, as_dict=True)]

	# Jumlah add-on per currency (footer section) — disiplin sama L2.
	tot_by_cur = _sort_cur_rows([
		{"currency": r.currency, "amount": _f(r.amount)}
		for r in frappe.db.sql("""
			SELECT COALESCE(NULLIF(ba.currency, ''), %(def_cur)s) AS currency,
			       SUM(ba.total_amount) AS amount
			FROM `tabBooking Addon` ba
			WHERE ba.booking = %(booking)s
			GROUP BY COALESCE(NULLIF(ba.currency, ''), %(def_cur)s)
		""", fmt, as_dict=True)
	])
	tot_default = _annotate_default(tot_by_cur, ["amount"])

	# ── Flight booking ni (Booking.flight) + statistik global flight ──
	flight_name = frappe.db.get_value("Booking", booking, "flight")
	flights = []
	if flight_name:
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
			"pax_booking": _i(r.pax_booking),
		} for r in frappe.db.sql("""
			SELECT f.name, f.flight_title, f.status, f.pnr, f.airline,
			       al.airline_name, f.home_airport, f.destination_airport,
			       f.departure_date, f.arrival_date, f.flight_class,
			       f.ticket_type, f.seats_occupied, f.min_seat, f.max_seat,
			       (SELECT COUNT(DISTINCT b2.name) FROM `tabBooking` b2
			        WHERE b2.flight = f.name
			          AND b2.status NOT IN %(excl)s) AS booking_count,
			       (SELECT COALESCE(SUM(res.pax), 0)
			        FROM (SELECT br.booking, COUNT(*) AS pax
			              FROM `tabBooking Reservation` br
			              WHERE br.status != 'Cancelled'
			              GROUP BY br.booking) res
			        JOIN `tabBooking` b3 ON b3.name = res.booking
			        WHERE b3.flight = f.name
			          AND b3.status NOT IN %(excl)s) AS pax,
			       (SELECT COUNT(*) FROM `tabBooking Reservation` br
			        WHERE br.booking = %(booking)s
			          AND br.status != 'Cancelled') AS pax_booking
			FROM `tabFlight` f
			LEFT JOIN `tabFlight Airline` al ON al.name = f.airline
			WHERE f.name = %(flight)s
		""", {**fmt, "flight": flight_name}, as_dict=True)]

	return {
		"booking": booking,
		"addons": addons,
		"flights": flights,
		"totals": {
			"by_currency": tot_by_cur,
			"default_totals": tot_default,
		},
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


def _tv_filter_field(doctype: str, fieldname: str, aliases=None):
	"""Sahkan medan penapis dinamik wujud pada meta doctype dan jenisnya
	selamat untuk SQL — nama kolum TIDAK PERNAH diinterpolate terus daripada
	input tanpa validasi ini. Juga sahkan kolum wujud dalam DB: meta boleh
	mendahului skema (doctype diedit tanpa migrate) — tanpa semakan ni
	penapis atas medan tersebut gagal dengan SQL error mentah. Return (alias, df).

	aliases — hadkan doctype yang dibenarkan kepada peta alias lain (cth.
	_BK_FILTER_ALIASES senarai booking: hanya Booking + Customer, sebab
	kueri booking tiada join br/t); lalai = semua _TV_FILTER_ALIASES."""
	alias_map = aliases if aliases is not None else _TV_FILTER_ALIASES
	alias = alias_map.get(doctype or "")
	if not alias:
		frappe.throw(_("Filter doctype must be one of: {0}").format(
			", ".join(alias_map)))
	df = frappe.get_meta(doctype).get_field(fieldname or "")
	if not df or df.fieldtype not in _TV_FILTER_FIELDTYPES:
		frappe.throw(_("{0}.{1} is not a filterable field").format(doctype, fieldname))
	if df.fieldname not in frappe.db.get_table_columns(doctype):
		frappe.throw(_("{0}.{1} does not exist in the database yet — run migrate")
			.format(doctype, fieldname))
	return alias, df


# Jenis medan nombor — penapis dinamik guna julat Min–Max (bukan padanan
# tepat); selari TV_CF_NUMERIC_TYPES pada klien.
_TV_FILTER_NUMERIC = ("Int", "Float", "Currency", "Percent")


def _num_or_none(v) -> "float | None":
	"""Float(v) atau None — teks kosong/bukan nombor → None (diabaikan)."""
	try:
		if v in (None, ""):
			return None
		return float(v)
	except (TypeError, ValueError):
		return None


def _date_or_none(v) -> "str | None":
	"""Tarikh 'YYYY-MM-DD' atau None — terima sebarang format input tarikh
	frappe (getdate); kosong/tidak sah → None (sempadan julat diabaikan)."""
	try:
		if v in (None, ""):
			return None
		return getdate(v).strftime("%Y-%m-%d")
	except Exception:
		return None


def _birthday_in_range(dob, dep, ret) -> bool:
	"""True bila ulang tahun DOB (bulan-hari) jatuh dalam tempoh trip
	dep..ret. Tahun DOB diabaikan — disemak pada tahun departure & return
	(berbeza bila trip melintasi tahun baharu; 29 Feb digulung ke 28).

	Melimpahkan ke birthday_during_trip (controller Booking Reservation) —
	sumber tunggal logik, dipakai bersama checkbox birthday_on_trip."""
	from travel_booking.module_travel_booking.doctype.booking_reservation.booking_reservation import (
		birthday_during_trip,
	)
	return birthday_during_trip(dob, dep, ret)


def _tv_filter_conditions(custom_filters: list, fmt: dict, match: str = "AND",
						  aliases=None) -> list:
	"""Tukar penapis dinamik [{doctype, fieldname, value, min?, max?}]
	kepada syarat SQL. Semantik ikut jenis field:
	- Nombor (Int/Float/Currency/Percent) + min/max → julat
	  (col >= min AND col <= max; sempadan tunggal dibenarkan).
	- Tarikh (Date/Datetime) + min/max → julat tarikh inklusif
	  (dinormalisasi ke YYYY-MM-DD; sempadan tunggal dibenarkan).
	- Teks → LIKE %v%; Select/Link/tarikh tanpa julat → padanan tepat;
	  Check → 1/0.
	Baris tanpa nilai DAN tanpa julat diabaikan.

	match='OR' & ≥2 syarat → disatukan sebagai (a OR b OR ...); selain itu
	setiap syarat digabung AND seperti mana ia berdiri dalam conditions.

	aliases — peta alias doctype dibenarkan (lalai semua); selari
	_tv_filter_field — senarai booking menghantar _BK_FILTER_ALIASES
	kerana kuerinya hanya join b (Booking) & c (Customer)."""
	out = []
	for i, f in enumerate(custom_filters or []):
		if not isinstance(f, dict):
			continue
		value = f.get("value")
		rmin = _num_or_none(f.get("min"))
		rmax = _num_or_none(f.get("max"))
		alias, df = _tv_filter_field(f.get("doctype"), f.get("fieldname"), aliases)
		if df.fieldtype in ("Date", "Datetime"):
			# Nilai tarikh bukan nombor — _num_or_none akan menolaknya;
			# normalisasi ke YYYY-MM-DD untuk perbandingan julat SQL
			# (kandungan Date ialah YYYY-MM-DD → inklusif terus).
			rmin = _date_or_none(f.get("min"))
			rmax = _date_or_none(f.get("max"))
		if value in (None, "") and rmin is None and rmax is None:
			continue
		col = f"{alias}.`{df.fieldname}`"
		vk = f"cfv{i}"
		if rmin is not None or rmax is not None:
			parts = []
			if rmin is not None:
				fmt[f"cfmin{i}"] = rmin
				parts.append(f"{col} >= %(cfmin{i})s")
			if rmax is not None:
				fmt[f"cfmax{i}"] = rmax
				parts.append(f"{col} <= %(cfmax{i})s")
			# Dibungkus kurungan supaya mod OR komposisi betul:
			# (a >= 5 AND a <= 10) OR <syarat lain>.
			out.append("(" + " AND ".join(parts) + ")")
			continue
		if value in (None, ""):
			continue
		if df.fieldtype == "Check":
			fmt[vk] = 1 if str(value).lower() in ("1", "true", "yes", "y") else 0
			out.append(f"{col} = %({vk})s")
		elif df.fieldtype in ("Data", "Small Text", "Text", "Long Text", "Editor"):
			fmt[vk] = f"%{value}%"
			out.append(f"{col} LIKE %({vk})s")
		else:
			fmt[vk] = value
			out.append(f"{col} = %({vk})s")
	if match == "OR" and len(out) > 1:
		return ["(" + " OR ".join(out) + ")"]
	return out


@frappe.whitelist()
def get_group_travellers(trip_group: str = None, trip_groups: list = None, booking: str = None,
						 search: str = None, doc_status: str = None,
						 custom_filters: list = None, custom_match: str = "AND",
						 limit: int = 20,
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

	custom_filters: penapis dinamik [{doctype, fieldname, value, min?, max?}]
	atas medan doctype sumber (Booking Reservation / Traveller / Booking /
	Customer) — teks LIKE, lain-lain padanan tepat; medan nombor
	(Int/Float/Currency/Percent) boleh guna julat min/max. custom_match
	'OR' gabungkan baris sebagai match-ANY (lalai AND = match-ALL).
	"""
	_require_access()
	conditions, fmt, order_by = _tv_scope(booking, trip_group, trip_groups)
	conditions.extend(_tv_filter_conditions(custom_filters, fmt,
		"OR" if str(custom_match).upper() == "OR" else "AND"))

	if doc_status and doc_status != "All":
		if doc_status == "No Traveller":
			# Senarai HANYA reservation tanpa link doctype Traveller
			# (slot guest belum berdaftar dokumen).
			conditions.append("(br.traveller IS NULL OR br.traveller = '')")
		elif doc_status == "Incomplete":
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
		       t.email AS tv_email, t.phone AS tv_phone,
		       t.status AS traveller_status,
		       br.birthday_on_trip, br.passport_to_expire_on_trip,
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
		       f.flight_title, f.pnr AS flight_pnr,
		       f.departure_date AS flight_departure,
		       f.arrival_date AS flight_arrival,
		       f.flight_class,
		       (SELECT COUNT(*)
		          FROM `tabBooking Addon Item` _bai
		          INNER JOIN `tabBooking Addon` _ba ON _ba.name = _bai.addon_order
		          WHERE _bai.booking_reservation = br.name
		            AND _ba.docstatus < 2) AS addons_count,
		       (SELECT GROUP_CONCAT(DISTINCT CONCAT(_bai.addon_title,
		              ' (', COALESCE(NULLIF(_bai.status, ''), _ba.status, '-'), ')')
		              SEPARATOR '; ')
		          FROM `tabBooking Addon Item` _bai
		          INNER JOIN `tabBooking Addon` _ba ON _ba.name = _bai.addon_order
		          WHERE _bai.booking_reservation = br.name
		            AND _ba.docstatus < 2) AS addons_summary,
		       b.booking_number AS b_booking_number, b.status AS booking_status,
		       b.departure_date AS b_departure, b.return_date AS b_return,
		       br.departure_date AS br_departure, br.arrival_date AS br_arrival,
		       b.customer, c.customer_name,
		       b.customer_message AS b_customer_message,
		       b.cust_email, b.get_cust_booking_phone AS cust_phone
		FROM `tabBooking Reservation` br
		INNER JOIN tabBooking b ON b.name = br.booking
		LEFT JOIN tabTraveller t ON t.name = br.traveller
		LEFT JOIN tabCustomer c ON c.name = b.customer
		LEFT JOIN `tabFlight` f ON f.name = br.flight
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
			# Mesej khusus Booking Reservation (br.customer_message) — TANPA
			# fallback mesej booking induk; baris Reservation Message panel
			# Booking Reservation (modal traveller).
			"reservation_message": r.customer_message or "",
			"cust_email": r.cust_email or "",
			"cust_phone": r.cust_phone or "",
			"traveller_name": r.traveller_name or "-",
			"traveller": r.traveller or "",
			"gender": r.gender or "",
			"dob": _s(r.dob),
			# Penanda klasifikasi trip — checkbox TERPASANG pada Booking
			# Reservation (auto oleh compute_trip_flags pada save reservation
			# / Traveller + jaring harian); bukan kiraan live supaya selari
			# dengan nilai yang admin lihat pada borang reservation.
			"birthday_trip": bool(r.birthday_on_trip),
			"passport_to_expire": bool(r.passport_to_expire_on_trip),
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
			"tv_email": r.tv_email or "",
			"tv_phone": r.tv_phone or "",
			"flight": r.flight or "",
			"flight_title": r.flight_title or "",
			"flight_pnr": r.flight_pnr or "",
			"flight_departure": _s(r.flight_departure),
			"flight_arrival": _s(r.flight_arrival),
			"flight_class": r.flight_class or "",
			"airline": r.airline or "",
			"addons_count": r.addons_count or 0,
			"addons_summary": r.addons_summary or "",
			"traveller_status": r.traveller_status or "",
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

	return {"travellers": travellers, "shown": len(travellers), "count": _i(count),
		"summary": _tv_summary(booking, trip_group, trip_groups)}


def _tv_summary(booking: str = None, trip_group: str = None, trip_groups=None) -> dict:
	"""Ringkasan kecil tab traveller — Booked for (SUM booked_pax booking
	dalam skop), Ready for (jumlah reservation dalam skop), kiraan status
	dokumen (Incomplete / Pending Verification / Verified) & Readiness
	(verified / booked_pax, %). Skop sama dengan _tv_scope; status ikut
	ungkapan paparan (COALESCE status Traveller → document_status
	reservation). Readiness dikira sebagai "sudah tidak Incomplete/Pending"
	= count - (incomplete + pending), selari dengan nombor dipapar."""
	conditions, fmt, _order = _tv_scope(booking, trip_group, trip_groups)
	where = " AND ".join(conditions)
	base = f"""FROM `tabBooking Reservation` br
		INNER JOIN tabBooking b ON b.name = br.booking
		LEFT JOIN tabTraveller t ON t.name = br.traveller
		WHERE {where}"""
	booked_pax = frappe.db.sql(f"""
		SELECT COALESCE(SUM(x.booked_pax), 0) AS s
		FROM (SELECT DISTINCT b.name, COALESCE(b.booked_pax, 0) AS booked_pax
		      {base}
		      AND b.status NOT IN ('Cancelled', 'Abandoned', 'Pending')) x
	""", fmt, as_dict=True)[0].s
	ready_for = frappe.db.sql(f"SELECT COUNT(*) AS c {base}", fmt, as_dict=True)[0].c
	status_rows = frappe.db.sql(f"""
		SELECT COALESCE(NULLIF(t.status, ''), IFNULL(br.document_status, 'Incomplete')) AS st,
		       COUNT(*) AS c
		{base} GROUP BY st""", fmt, as_dict=True)
	counts = {}
	for r in status_rows:
		counts[r.st or "Incomplete"] = _i(r.c)
	verified = counts.get("Verified", 0)
	readiness = round((verified / booked_pax) * 100, 1) if booked_pax else 0
	return {
		"booked_pax": _i(booked_pax),
		"ready_for": _i(ready_for),
		"incomplete": counts.get("Incomplete", 0),
		"pending_verification": counts.get("Pending Verification", 0),
		"verified": verified,
		"readiness": readiness,
	}


@frappe.whitelist()
def get_traveller_filter_fields() -> list:
	"""Senarai medan yang boleh ditapis untuk penapis dinamik tab
	Travellers — semua field meta (kecuali jenis layout/attach) bagi 4
	doctype sumber senarai traveller, dikumpulkan ikut doctype.

	Hanya medan yang BETUL-BETUL wujud sebagai kolum DB disenaraikan —
	meta boleh mendahului skema (doctype diedit tanpa migrate); medan
	tersebut tidak boleh ditapis (SQL error) jadi jangan tawarkan."""
	_require_access()
	out = []
	for dt in _TV_FILTER_ALIASES:
		try:
			cols = set(frappe.db.get_table_columns(dt))
		except Exception:
			cols = None
		fields = [{
			"fieldname": df.fieldname,
			"label": df.label or df.fieldname,
			"fieldtype": df.fieldtype,
			# Select — senarai pilihan penuh dari meta untuk autocomplete
			# nilai penapis (DISTINCT DB hanya liput nilai pernah digunakan).
			**({"options": [o.strip() for o in (df.options or "").split("\n")
				if o.strip()]} if df.fieldtype == "Select" else {}),
		} for df in frappe.get_meta(dt).fields
			if df.fieldtype in _TV_FILTER_FIELDTYPES
			and (cols is None or df.fieldname in cols)]
		if fields:
			out.append({"doctype": dt, "fields": fields})
	return out


# Medan imej Traveller yang boleh diganti melalui crop/edit (PII — private).
TRAVELLER_IMAGE_FIELDS = ("passport_image", "visa_photo")


@frappe.whitelist()
def replace_traveller_file(traveller: str, fieldname: str, new_url: str,
						   old_url: str = None) -> dict:
	"""Ganti fail imej Traveller (crop/rotate dari page Manage Booking) —
	REPLACE, bukan duplikasi:

	1. Set Traveller.<fieldname> = new_url.
	2. Alih snapshot Booking Reservation.traveller_passportimg yang masih
	   merujuk URL lama ke URL baharu (fallback paparan bila medan Traveller
	   kosong — jangan tinggal rujukan mati selepas fail lama dipadam).
	3. Padam dokumen File lama (URL lama). Padam fizikal disenta oleh
	   File.on_trash — hanya berlaku bila tiada File lain berkongsi fail itu.

	Fail baharu dimuat naik sebagai private oleh klien (is_private=1)."""
	_require_access()
	if fieldname not in TRAVELLER_IMAGE_FIELDS:
		frappe.throw(_("Invalid field {0}").format(fieldname))
	if not traveller or not frappe.db.exists("Traveller", traveller):
		frappe.throw(_("Traveller {0} not found").format(traveller))
	if not new_url:
		frappe.throw(_("New file URL is required"))

	old_url = (old_url or "").strip()
	if old_url and old_url != new_url:
		frappe.db.sql(
			"""UPDATE `tabBooking Reservation`
			   SET traveller_passportimg = %(new)s
			   WHERE traveller_passportimg = %(old)s AND traveller = %(t)s""",
			{"new": new_url, "old": old_url, "t": traveller})
	frappe.db.set_value("Traveller", traveller, fieldname, new_url)

	deleted = 0
	if old_url and old_url != new_url:
		# Medan Traveller & snapshot sudah dialih — padam semua File yang
		# masih membawa URL lama. on_trash menolak bila masih dirujuk medan
		# Attach (guard) dan mengekalkan fizikal bila ada duplikasi kandungan.
		for fname in frappe.get_all("File", filters={"file_url": old_url}, pluck="name"):
			try:
				frappe.delete_doc("File", fname, ignore_permissions=True)
				deleted += 1
			except Exception:
				# Fail tertinggal (masih dirujuk tempat lain) — bukan fatal;
				# nilai Traveller tetap telah dikemaskini.
				frappe.log_error(
					title="replace_traveller_file: failed to delete old file",
					message=f"File {fname} ({old_url}) for Traveller {traveller}",
				)
	return {"url": new_url, "deleted": deleted}


# Medan Traveller yang boleh diedit admin dari modal page Manage Booking —
# SEMUA melalui doctype Traveller sahaja (satu sumber kebenaran); snapshot
# Booking Reservation TIDAK disentuh (paparan SQL utamakan nilai Traveller).
TRAVELLER_EDIT_FIELDS = (
	"title", "first_name", "last_name", "gender", "date_of_birth",
	"passport_no", "passport_expiry", "ic_number", "nationality", "visa_photo",
	"email", "phone",
	"address_line1", "city", "state", "postcode", "country",
	"emergency_contact_name", "emergency_contact_phone",
	"emergency_contact_relationship",
	# Health & Special Needs — sengaja TIDAK mempengaruhi auto-status
	# (lihat MANDATORY_INFO_FIELDS doctype Traveller).
	"wheelchair_assistant", "dietary_requirements", "medical_conditions",
	"medicine_treatment",
)

# Opsyen status doctype Traveller — cermin DF.Literal traveller.json.
TRAVELLER_STATUS_OPTIONS = (
	"Incomplete", "Pending Verification", "Verified",
	"Open for Update", "Expired",
)

# Opsyen status doctype Booking (panel Booking modal traveller & bulk edit)
# dan Booking Reservation (panel Booking Reservation) — cermin DF.Literal.
BOOKING_STATUS_OPTIONS = (
	"Pending", "Accepted", "Processing", "Confirmed",
	"Completed", "Abandoned", "Cancelled",
)


def _sanitize_phone_value(v: str) -> str:
	"""Normalisasi nilai Phone warisan supaya lulus validasi frappe
	(validate_phone_number_with_country_code — perlu format boleh parse
	TANPA region, contoh +60xxxxxxxxx). Nilai lama tanpa kod negara
	("177378754" / "0123456789") diberi awalan +60 (Malaysia)."""
	v = re.sub(r"[\s()\u2013.]", "", (v or "").strip())
	if not v:
		return v
	v = re.sub(r"^\+60-\+", "+", v)  # artefak kawalan Phone (dwi-awalan)
	if v.startswith("+"):
		return v
	if v.startswith("00"):
		return "+" + v[2:]
	if v.startswith("60") and len(v) >= 9:
		return "+" + v
	if v.startswith("0"):
		return "+60" + v[1:]
	return "+60" + v


@frappe.whitelist()
def update_traveller_status(traveller: str, status: str) -> dict:
	"""Kemaskini status doctype Traveller dari bar top modal Booking Manager.

	Admin sahaja (_require_access). doc.save() penuh — before_save doctype
	urus uppercase/umur/title & auto-flow status; on_update sebar status ke
	Booking Reservation (sync_status_to_reservations → document_status).
	Pulangkan status & document_status utk kemaskini cache klien.
	"""
	_require_access()
	if status not in TRAVELLER_STATUS_OPTIONS:
		frappe.throw(_("Invalid status: {0}").format(status))
	if not frappe.db.exists("Traveller", traveller):
		frappe.throw(_("Traveller {0} not found").format(traveller))

	doc = frappe.get_doc("Traveller", traveller)
	# Medan Phone warisan (format tak boleh parse) menyekat save — baiki
	# sebelum validasi doctype.
	for f in ("phone", "emergency_contact_phone"):
		val = (doc.get(f) or "").strip()
		if val:
			doc.set(f, _sanitize_phone_value(val))
	if doc.status != status:
		doc.status = status
		# Status ni KEPUTUSAN MANUAL admin — langkau auto-promote
		# evaluate_document_status (balikkan 'Open for Update' ke
		# 'Pending Verification' bila borang lengkap) supaya pilihan admin
		# kekal; kemaskini status inilah yang mencetus cascade reservation
		# → 'Document Expired' (compute_auto_status rule 5b).
		doc.flags.keep_manual_status = 1
		doc.save(ignore_permissions=True)
	# NOTE: kunci "renamed" HANYA untuk update_traveller_info (rename bila
	# IC Number — autoname — berubah). Fungsi status tidak pernah rename;
	# dialog status klien juga tidak membaca kunci tersebut.
	return {
		"traveller": doc.name,
		"status": doc.status,
		"document_status": doc.status,
	}


@frappe.whitelist()
def update_booking_status(booking: str, status: str) -> dict:
	"""Kemaskini status doctype Booking dari panel Booking (modal traveller).

	Admin sahaja (_require_access). doc.save() penuh — hook doctype Booking
	kekal berjalan. Pulangkan status utk kemaskini cache klien.
	"""
	_require_access()
	if status not in BOOKING_STATUS_OPTIONS:
		frappe.throw(_("Invalid status: {0}").format(status))
	if not booking or not frappe.db.exists("Booking", booking):
		frappe.throw(_("Booking {0} not found").format(booking))

	doc = frappe.get_doc("Booking", booking)
	if doc.status != status:
		doc.status = status
		doc.save(ignore_permissions=True)
	return {"booking": doc.name, "booking_status": doc.status}


@frappe.whitelist()
def update_booking_contact(booking: str, cust_email: str = None, cust_phone: str = None) -> dict:
	"""Kemaskini Booking Contact doctype Booking dari panel Booking (modal
	traveller) — snapshot email & telefon per booking (cust_email +
	get_cust_booking_phone).

	Admin sahaja (_require_access). doc.save() penuh — hook doctype Booking
	kekal berjalan & perubahan ter-rekod dalam Version. Phone distandardkan
	ke format sengkang Phone (corak semasa booking dicipta — booking_engine).
	Customer TIDAK disentuh — nama paparan datang dari doctype Customer
	(master data dipakai merentas booking lain). Nilai kosong dibenarkan
	(bermakna user SENGAJA mengosongkan medan — borang diisi nilai semasa).
	Pulangkan nilai baharu utk kemaskini cache klien.
	"""
	_require_access()
	if not booking or not frappe.db.exists("Booking", booking):
		frappe.throw(_("Booking {0} not found").format(booking))
	cust_email = (cust_email or "").strip()
	cust_phone = standardize_phone_to_hyphen((cust_phone or "").strip())
	if cust_email and not validate_email_address(cust_email):
		frappe.throw(_("Invalid email address: {0}").format(cust_email))

	doc = frappe.get_doc("Booking", booking)
	changed = False
	if (doc.cust_email or "") != cust_email:
		doc.cust_email = cust_email
		changed = True
	if (doc.get_cust_booking_phone or "") != cust_phone:
		doc.get_cust_booking_phone = cust_phone
		changed = True
	if changed:
		doc.save(ignore_permissions=True)
	return {
		"booking": doc.name,
		"cust_email": doc.cust_email or "",
		"cust_phone": doc.get_cust_booking_phone or "",
	}


@frappe.whitelist()
def get_booking_billing_address(booking: str) -> dict:
	"""Alamat bil (Address address_type='Billing') customer booking —
	sumber butang salin pada panel Address borang edit traveller (modal
	Manage Booking). Utamakan Billing; tiada Billing → alamat customer
	pertama; tiada langsung → found=False.
	"""
	_require_access()
	if not booking or not frappe.db.exists("Booking", booking):
		frappe.throw(_("Booking {0} not found").format(booking))
	customer = frappe.db.get_value("Booking", booking, "customer")
	if not customer:
		return {"found": False, "customer": ""}
	rows = frappe.db.sql("""
		SELECT a.name, a.address_type, a.address_title, a.address_line1,
		       a.city, a.state, a.pincode, a.country
		FROM `tabAddress` a
		JOIN `tabDynamic Link` dl
		  ON dl.parent = a.name AND dl.parenttype = 'Address'
		WHERE dl.link_doctype = 'Customer' AND dl.link_name = %(c)s
		ORDER BY (a.address_type = 'Billing') DESC, a.modified DESC
		LIMIT 1
	""", {"c": customer}, as_dict=True)
	if not rows:
		return {"found": False, "customer": customer}
	a = rows[0]
	return {
		"found": True, "customer": customer,
		"address_title": a.address_title or "",
		"address_type": a.address_type or "",
		"address_line1": a.address_line1 or "",
		"city": a.city or "", "state": a.state or "",
		"postcode": a.pincode or "", "country": a.country or "",
	}


@frappe.whitelist()
def get_booking_order_summary(booking: str) -> dict:
	"""Order Summary booking (overview info belian) utk row "Booking Info
	Overview" panel Booking (modal traveller) — virtual property
	Booking.order_summary (kira live daripada SO utama; frappe.db.get_value
	tak boleh baca virtual field, kena get_doc penuh).

	Lazy dipanggil klien bila modal dibuka — elak kiraan SO yang agak berat
	untuk SETIAP baris senarai traveller (get_group_travellers boleh
	memuatkan ratusan booking serentak).
	"""
	_require_access()
	if not booking or not frappe.db.exists("Booking", booking):
		frappe.throw(_("Booking {0} not found").format(booking))
	return {
		"booking": booking,
		"order_summary": frappe.get_doc("Booking", booking).order_summary or "",
	}


@frappe.whitelist()
def update_reservation_status(reservation: str, status: str) -> dict:
	"""Kemaskini status doctype Booking Reservation dari panel Reservation
	(modal traveller).

	Admin sahaja (_require_access). doc.save() penuh — before_save/on_update
	doctype Booking Reservation kekal berjalan. Pulangkan status utk
	kemaskini cache klien.
	"""
	_require_access()
	if status not in RESERVATION_STATUS_OPTIONS:
		frappe.throw(_("Invalid status: {0}").format(status))
	if not reservation or not frappe.db.exists("Booking Reservation", reservation):
		frappe.throw(_("Booking Reservation {0} not found").format(reservation))

	doc = frappe.get_doc("Booking Reservation", reservation)
	if doc.status != status:
		doc.status = status
		doc.save(ignore_permissions=True)
	return {"reservation": doc.name, "reservation_status": doc.status}


# Katalog medan EDIT panel Rooming & Flight (modal traveller) — doctype
# Booking Reservation. Melengkapkan BULK_EDIT_FIELDS (bulk edit table view)
# — yang ini borang panel PER-REKOD: Rooming/accommodation (termasuk medan
# cruise) + Flight. Kunci lain diabaikan.
RESERVATION_EDIT_FIELDS = (
	# ── Rooming (accommodation) ──
	"room_id", "room_category", "room_privacy",
	"guest_sequence", "pax_type", "cabin_is_confirmed",
	# ── Cruise Cabin ──
	"stateroom_no", "delegate_no", "aroya_guest_no",
	# ── Flight (PNR/departure/arrival/class dipapar daripada doctype
	# Flight — diurus di sana, bukan pada reservation) ──
	"flight", "airline",
)


@frappe.whitelist()
def update_reservation_info(reservation: str, values: "dict | str" = None) -> dict:
	"""Kemaskini medan Rooming (accommodation) & Flight doctype Booking
	Reservation dari kad Rooming / Flight (tab Rooming & Flight Info, modal
	traveller page Manage Booking).

	Corak update_traveller_info: frappe.get_doc → set HANYA medan dalam
	RESERVATION_EDIT_FIELDS (kunci lain diabaikan) → doc.save() penuh —
	before_save/on_update doctype Booking Reservation kekal berjalan.
	db.set_value sengaja TIDAK digunakan — ia memintas hook doctype.

	Link divalidasi doctype semasa save (Room Category → Trip Price
	Category, Flight → Flight, Airline → Flight Airline). Nilai kosong
	dibenarkan — borang diisi nilai semasa, jadi kosong bermakna user
	SENGAJA mengosongkan medan (cth. unassign room_id → fallback
	booking+Room_N). Int kosong dirawat 0; Check dirawat 0/1.

	Pulangkan nilai terkini (medan edit + alias paparan flight dibaca
	semula daripada doctype Flight + status) utk kemaskini cache klien.
	"""
	_require_access()
	if isinstance(values, str):
		try:
			values = json.loads(values)
		except ValueError:
			frappe.throw(_("Invalid values payload"))
	if not isinstance(values, dict):
		values = {}
	if not reservation or not frappe.db.exists("Booking Reservation", reservation):
		frappe.throw(_("Booking Reservation {0} not found").format(reservation))

	doc = frappe.get_doc("Booking Reservation", reservation)
	_int_fields = {"guest_sequence", "aroya_guest_no"}
	_check_fields = {"cabin_is_confirmed"}
	for f in RESERVATION_EDIT_FIELDS:
		if f not in values:
			continue
		v = values.get(f)
		if f in _int_fields:
			try:
				v = int(str(v).strip() or 0)
			except (TypeError, ValueError):
				frappe.throw(_("Invalid number for {0}: {1}").format(
					frappe.bold(f), frappe.bold(v)))
		elif f in _check_fields:
			v = 1 if (v in (1, True, "1", "true", "True")) else 0
		elif isinstance(v, str):
			v = v.strip()
		doc.set(f, ("" if v is None else str(v)) if isinstance(v, str) else v)
	doc.save(ignore_permissions=True)

	# Alias paparan flight — baca semula daripada doctype Flight supaya kad
	# Flight klien menunjukkan data terkini selepas link flight ditukar.
	flight_det = frappe._dict()
	if doc.flight:
		flight_det = frappe.db.get_value("Flight", doc.flight,
			["flight_title", "pnr", "departure_date", "arrival_date", "flight_class"],
			as_dict=True) or frappe._dict()
	return {
		"reservation": doc.name,
		"reservation_status": doc.status,
		"room_id": doc.room_id or "",
		"room_category": doc.room_category or "",
		"room_privacy": doc.room_privacy or "",
		"guest_sequence": doc.guest_sequence or 0,
		"pax_type": doc.pax_type or "",
		"cabin_confirmed": bool(doc.cabin_is_confirmed),
		"stateroom_no": doc.stateroom_no or "",
		"delegate_no": doc.delegate_no or "",
		"aroya_guest_no": doc.aroya_guest_no or "",
		"flight": doc.flight or "",
		"airline": doc.airline or "",
		"flight_title": flight_det.flight_title or "",
		"flight_pnr": flight_det.pnr or "",
		"flight_departure": _s(flight_det.departure_date),
		"flight_arrival": _s(flight_det.arrival_date),
		"flight_class": flight_det.flight_class or "",
	}


# Opsyen status doctype Booking Reservation (medan "status") — cermin
# DF.Literal booking_reservation.json, utk katalog bulk edit di bawah.
RESERVATION_STATUS_OPTIONS = (
	"Waiting Document", "Document Completed", "Document Expired",
	"Preparation Completed", "Trip On Progress", "Completed", "Cancelled",
)

# Katalog medan BULK edit (table view pakej traveller) — key unik klien →
# (doctype sasaran, fieldname, fieldtype widget klien, options). Ini penentu
# "doctype borang" submission: key group Traveller disimpan MELALUI doctype
# Traveller (senarai `travellers`), key group Booking Reservation MELALUI
# doctype Booking Reservation (senarai `reservations`) — doc.save() penuh
# supaya before_save/on_update doctype sasaran sentiasa berjalan.
BULK_EDIT_FIELDS = {
	# ── Doctype Traveller ──
	"status": ("Traveller", "status", "Select", TRAVELLER_STATUS_OPTIONS),
	"gender": ("Traveller", "gender", "Select", ("Male", "Female")),
	"passport_no": ("Traveller", "passport_no", "Data", ()),
	"passport_expiry": ("Traveller", "passport_expiry", "Date", ()),
	"ic_number": ("Traveller", "ic_number", "Data", ()),
	"nationality": ("Traveller", "nationality", "Link", ("Country",)),
	"email": ("Traveller", "email", "Data", ()),
	"phone": ("Traveller", "phone", "Phone", ()),
	"address_line1": ("Traveller", "address_line1", "Small Text", ()),
	"city": ("Traveller", "city", "Data", ()),
	"state": ("Traveller", "state", "Data", ()),
	"postcode": ("Traveller", "postcode", "Data", ()),
	"country": ("Traveller", "country", "Link", ("Country",)),
	"emergency_contact_name": ("Traveller", "emergency_contact_name", "Data", ()),
	"emergency_contact_phone": ("Traveller", "emergency_contact_phone", "Phone", ()),
	"emergency_contact_relationship": (
		"Traveller", "emergency_contact_relationship", "Data", ()),
	# ── Doctype Booking Reservation ──
	"pax_type": ("Booking Reservation", "pax_type", "Data", ()),
	"room_privacy": ("Booking Reservation", "room_privacy", "Select",
		("Private", "Open Sharing")),
	"room_category": ("Booking Reservation", "room_category", "Link",
		("Trip Price Category",)),
	"reservation_status": ("Booking Reservation", "status", "Select",
		RESERVATION_STATUS_OPTIONS),
}


@frappe.whitelist()
def bulk_update_travellers(travellers: "list | str" = None,
						   reservations: "list | str" = None,
						   field: str = "", value: str = "") -> dict:
	"""Bulk kemaskini medan pilihan user pada senarai traveller (table view).

	`field` ialah key dalam BULK_EDIT_FIELDS — doctype sasaran DITENTUKAN
	OLEK KATALOG: key group Traveller memproses senarai `travellers`
	(melalui doctype Traveller), key group Booking Reservation memproses
	senarai `reservations` (melalui doctype Booking Reservation). Setiap
	rekod diproses berasingan — kegagalan satu TIDAK menghentikan yang
	lain; rekod yang tidak wujud dilangkau. Nilai kosong DITOLAK (elak
	padam beramai-ramai secara tak sengaja). Medan Phone disanitize dahulu
	(_sanitize_phone_value) supaya validasi doctype tidak menyekat save.
	Pulangkan ringkasan: updated / skipped / failed (+ sebab) + field/value
	efektif utk kemaskini cache klien.
	"""
	_require_access()
	spec = BULK_EDIT_FIELDS.get((field or "").strip())
	if not spec:
		frappe.throw(_("Invalid field: {0}").format(field))
	target_doctype, fieldname, fieldtype, _options = spec
	value = "" if value is None else str(value).strip()
	if not value:
		frappe.throw(_("Please enter a value to apply"))
	if fieldtype == "Phone":
		value = _sanitize_phone_value(value)
	if isinstance(travellers, str):
		try:
			travellers = json.loads(travellers)
		except ValueError:
			frappe.throw(_("Invalid travellers payload"))
	if isinstance(reservations, str):
		try:
			reservations = json.loads(reservations)
		except ValueError:
			frappe.throw(_("Invalid reservations payload"))

	if target_doctype == "Traveller":
		names = list(dict.fromkeys(t for t in (travellers or []) if t))
		skip_reason = "no Traveller record"
	else:
		names = list(dict.fromkeys(r for r in (reservations or []) if r))
		skip_reason = "no Booking Reservation record"
	if not names:
		frappe.throw(_("No travellers selected"))

	updated, skipped, failed = [], [], []
	for name in names:
		if not frappe.db.exists(target_doctype, name):
			skipped.append({"name": name, "reason": skip_reason})
			continue
		try:
			doc = frappe.get_doc(target_doctype, name)
			if str(doc.get(fieldname) or "") == value:
				updated.append(name)  # nilai sudah sama — tiada save perlu
				continue
			doc.set(fieldname, value)
			doc.save(ignore_permissions=True)
			updated.append(name)
		except Exception as e:
			failed.append({"name": name, "reason": str(e)[:120]})

	return {"updated": updated, "skipped": skipped, "failed": failed,
		"doctype": target_doctype, "fieldname": fieldname, "value": value}


# Katalog medan BULK edit SENARAI BOOKING (pakej booking list) — key unik
# klien → (doctype sasaran, fieldname, fieldtype widget klien, options).
# payment_status sengaja TIDAK ditawarkan — ia auto-dikira daripada
# Payment Entry; edit manual akan ditulis semula oleh sistem.
BOOKING_BULK_EDIT_FIELDS = {
	"status": ("Booking", "status", "Select", list(BOOKING_STATUS_OPTIONS)),
	"booking_channel": ("Booking", "booking_channel", "Select",
		["Direct", "Staff", "Affiliate", "B2B"]),
	"checkout_method": ("Booking", "checkout_method", "Select",
		["Online Payment Gateway", "Manual Transfer", "Held Booking"]),
	"booked_by": ("Booking", "booked_by", "Link", "User"),
	"affiliate": ("Booking", "affiliate", "Link", "Sales Partner"),
	"b2b_partner": ("Booking", "b2b_partner", "Link", "Travel B2B Partner"),
}


@frappe.whitelist()
def bulk_update_bookings(bookings: "list | str" = None,
						 field: str = "", value: str = "") -> dict:
	"""Bulk kemaskini medan pilihan user pada senarai booking (pakej
	booking list) — mirror bulk_update_travellers.

	`field` ialah key dalam BOOKING_BULK_EDIT_FIELDS (semua group Booking —
	disimpan MELALUI doctype Booking, doc.save() penuh supaya hook doctype
	kekal berjalan). Setiap rekod diproses berasingan — kegagalan satu
	TIDAK menghentikan yang lain; rekod yang tidak wujud dilangkau. Nilai
	kosong DITOLAK (elak padan beramai-ramai secara tak sengaja).
	Pulangkan ringkasan updated / skipped / failed (+ sebab) + field/value
	efektif utk kemaskini cache klien.
	"""
	_require_access()
	spec = BOOKING_BULK_EDIT_FIELDS.get((field or "").strip())
	if not spec:
		frappe.throw(_("Invalid field: {0}").format(field))
	target_doctype, fieldname, _fieldtype, _options = spec
	value = "" if value is None else str(value).strip()
	if not value:
		frappe.throw(_("Please enter a value to apply"))
	if isinstance(bookings, str):
		try:
			bookings = json.loads(bookings)
		except ValueError:
			frappe.throw(_("Invalid bookings payload"))
	names = list(dict.fromkeys(b for b in (bookings or []) if b))
	if not names:
		frappe.throw(_("No bookings selected"))

	updated, skipped, failed = [], [], []
	for name in names:
		if not frappe.db.exists(target_doctype, name):
			skipped.append({"name": name, "reason": "no Booking record"})
			continue
		try:
			doc = frappe.get_doc(target_doctype, name)
			if str(doc.get(fieldname) or "") == value:
				updated.append(name)  # nilai sudah sama — tiada save perlu
				continue
			doc.set(fieldname, value)
			doc.save(ignore_permissions=True)
			updated.append(name)
		except Exception as e:
			failed.append({"name": name, "reason": str(e)[:120]})

	return {"updated": updated, "skipped": skipped, "failed": failed,
		"doctype": target_doctype, "fieldname": fieldname, "value": value}


# ── Syarat bulk padam booking (butang icon trash senarai booking) ──
# Hanya booking Cancelled yang telah dibatalkan melebihi tempoh grace boleh
# dipadam — tempoh itu memberi ruang pemulihan sekiranya pembatalan tersilap.
BOOKING_DELETE_STATUS = "Cancelled"
BOOKING_DELETE_GRACE_HOURS = 24

# Dokumen berpaut yang dipadam DAHULU sebelum Booking dipadam (cancel
# dahulu bila docstatus 1) — dokumen operasional sahaja. Sales Invoice
# SENGAJA TIDAK disertakan (dokumen kewangan) — SI yang belum dibatalkan
# akan menyekat padam Booking dan dilaporkan dalam `failed` dengan sebab.
_BOOKING_DELETE_LINKED = (
    ("Booking Reservation", "booking"),
    ("Booking Addon", "booking"),
    ("Voucher Usage", "booking"),
    ("Affiliate Commission", "booking"),
    ("Sales Order", "custom_booking"),
)


def _delete_booking_linked_docs(booking: str) -> list:
	"""Padam dokumen berpaut satu Booking (cancel dahulu bila docstatus 1).
	Return senarai '{doctype} {name}' yang dipadam — untuk log."""
	removed = []
	for dt, lf in _BOOKING_DELETE_LINKED:
		for dn in frappe.get_all(dt, filters={lf: booking}, pluck="name"):
			d = frappe.get_doc(dt, dn)
			if d.docstatus == 1:
				d.cancel()
			frappe.delete_doc(dt, dn, ignore_permissions=True)
			removed.append(f"{dt} {dn}")
	return removed


@frappe.whitelist()
def bulk_delete_bookings(bookings: "list | str" = None) -> dict:
	"""Bulk padam senarai booking (pakej booking list) — butang icon trash
	sebelah Bulk Edit. Setiap rekod diproses berasingan (savepoint — padam
	gagal tidak meninggalkan separuh padam) dan dilaporkan: deleted /
	skipped / failed (+ sebab).

	SYARAT PADAM (setiap rekod):
	1. Status mesti 'Cancelled' — selain itu dilangkau.
	2. Mesti telah dibatalkan MELEBIHI 24 jam (`modified` dianggap masa
	   pembatalan) — tempoh grace supaya boleh dipulihkan.
	3. Dokumen berpaut DIPADAM DAHULU (cancel dahulu bila docstatus 1):
	   Booking Reservation, Booking Addon, Voucher Usage, Affiliate
	   Commission, Sales Order. Sales Invoice SENGAJA tidak dikaskad
	   (dokumen kewangan) — SI yang belum dibatalkan akan menyekat padam
	   Booking dan dilaporkan dalam `failed` dengan sebab.
	"""
	_require_access()
	if isinstance(bookings, str):
		try:
			bookings = json.loads(bookings)
		except ValueError:
			frappe.throw(_("Invalid bookings payload"))
	names = list(dict.fromkeys(b for b in (bookings or []) if b))
	if not names:
		frappe.throw(_("No bookings selected"))

	from datetime import timedelta
	from frappe.utils import get_datetime, now_datetime

	now = now_datetime()
	grace = timedelta(hours=BOOKING_DELETE_GRACE_HOURS)
	deleted, skipped, failed = [], [], []
	for name in names:
		if not frappe.db.exists("Booking", name):
			skipped.append({"name": name, "reason": "no Booking record"})
			continue
		doc = frappe.get_doc("Booking", name)
		if (doc.status or "") != BOOKING_DELETE_STATUS:
			skipped.append({"name": name,
				"reason": "only Cancelled bookings can be deleted"})
			continue
		if get_datetime(doc.modified) > now - grace:
			skipped.append({"name": name,
				"reason": "must be cancelled more than 24 hours ago"})
			continue
		sp = f"bulk_del_{name.replace('-', '_')}"
		frappe.db.savepoint(sp)
		try:
			removed = _delete_booking_linked_docs(name)
			frappe.delete_doc("Booking", name, ignore_permissions=True)
			deleted.append(name)
		except Exception as e:
			frappe.db.rollback(save_point=sp)
			failed.append({"name": name, "reason": str(e)[:120]})

	return {"deleted": deleted, "skipped": skipped, "failed": failed}


def _norm_name(value) -> str:
	"""Nama untuk perbandingan identiti Traveller — upper + ruang berlebihan
	diruntuhkan (before_save Traveller uppercase-kan nama; input admin boleh
	berbeza kes/lebar spasi)."""
	return " ".join(str(value or "").upper().split())


def _traveller_merge_guard(traveller: str, target: str):
	"""Halang merge yang akan meletakkan traveller yang sama pada DUA slot
	dalam satu booking (selari guard borang save_booking_traveller)."""
	bookings = frappe.get_all("Booking Reservation",
		filters={"traveller": traveller}, pluck="booking")
	if not bookings:
		return
	dupe = frappe.db.get_value("Booking Reservation",
		{"booking": ("in", bookings), "traveller": target}, "name")
	if dupe:
		frappe.throw(_("Both travellers are attached to slots in the same booking "
			"({0}). Merging would place the same traveller on two slots of one "
			"booking — unlink one slot first.").format(frappe.bold(dupe)))


@frappe.whitelist()
def update_traveller_info(traveller: str, values: "dict | str" = None,
                          force_merge: bool = False) -> dict:
	"""Kemaskini maklumat peribadi Traveller dari modal page Manage Booking.

	Cara kerja (satu-satunya laluan betul utk kekal konsisten):
	- frappe.get_doc("Traveller") → set HANYA medan dalam TRAVELLER_EDIT_FIELDS
	  (kunci lain diabaikan) → doc.save(). before_save doctype menjalankan
	  peraturan: uppercase nama/IC/passport/alamat, recompute full_name, umur
	  & kategori umur, title ikut gender, sync status ke reservation.
	- db.set_value sengaja TIDAK digunakan — ia memintas before_save
	  (uppercase/full_name tidak akan dikira).
	- visa_photo pastikan PRIVATE selepas save (upload dialog boleh
	  tersimpan public) — flip fizikal + URL dikemaskini.

	IC pendua — nama dokumen Traveller ialah IC (autoname field:ic_number),
	jadi menukar IC kepada IC yang sudah dimiliki rekod lain bermakna DUA
	rekod (mungkin) orang yang sama. Tiga tahap keputusan:
	1) nama (normalized) + tarikh lahir sepadan → AUTO-MERGE senyap: rekod
	   ini digabung ke rekod pemilik IC (semua slot/Comment/Version/File
	   di-repoint, rekod lama dipadam, nilai yang admin taip MENANG).
	2) tarikh lahir sepadan tapi nama berbeza → pulang needs_confirmation
	   TANPA sebarang tulisan; klien minta pengesahan admin lalu hantar
	   semula force_merge=1 untuk melaksanakan merge.
	3) tarikh lahir berbeza → throw dengan identiti pemilik IC (orang
	   berbeza).
	Pulangkan nilai terkini (medan edit + alias paparan) utk kemaskini cache
	klien."""
	_require_access()
	if isinstance(values, str):
		try:
			values = json.loads(values)
		except ValueError:
			frappe.throw(_("Invalid values payload"))
	if not isinstance(values, dict):
		values = {}
	if not traveller or not frappe.db.exists("Traveller", traveller):
		frappe.throw(_("Traveller {0} not found").format(traveller))

	doc = frappe.get_doc("Traveller", traveller)

	def _apply_editable_fields(target_doc):
		target_doc.flags.ignore_mentions = True
		for f in TRAVELLER_EDIT_FIELDS:
			if f in values:
				v = values.get(f)
				if isinstance(v, str):
					v = v.strip()
					if f in ("phone", "emergency_contact_phone") and v:
						v = _sanitize_phone_value(v)
				target_doc.set(f, ("" if v is None else str(v)) if isinstance(v, str) else v)

	# ── IC pendua — keputusan SEBELUM sebarang tulisan ──────────────────
	# Fasa pengesahan (tahap 2) mesti pulang bersih tanpa save separuh
	# jalan. Identiti dibandingkan: nilai yang DIHANTAR (fallback nilai
	# semasa rekod) lawan rekod pemilik IC baharu.
	merge_target = None
	merge_same_name = False
	if "ic_number" in values:
		new_ic = str(values.get("ic_number") or "").strip().upper()
		if new_ic and new_ic != traveller and frappe.db.exists("Traveller", new_ic):
			existing = frappe.get_doc("Traveller", new_ic)
			same_name = (
				_norm_name(values.get("first_name") or doc.first_name)
				== _norm_name(existing.first_name)
				and _norm_name(values.get("last_name") or doc.last_name)
				== _norm_name(existing.last_name)
			)
			sub_dob = str(values.get("date_of_birth") or doc.date_of_birth or "")[:10]
			same_dob = bool(sub_dob) and sub_dob == str(existing.date_of_birth or "")[:10]
			if not same_dob:
				# Tahap 3 — tarikh lahir berbeza: orang berbeza. Nyatakan
				# identiti pemilik IC supaya admin terus nampak sebabnya.
				frappe.throw(_("IC Number {0} already belongs to {1} (born {2}) — "
					"the date of birth does not match this traveller. Check the IC "
					"number, or fix the records manually if this is really the same "
					"person.").format(
					frappe.bold(new_ic),
					frappe.bold(existing.full_name or new_ic),
					str(existing.date_of_birth or "—"),
				))
			if same_name or force_merge:
				# Tahap 1 (nama+DOB sepadan → auto) atau tahap 2 yang telah
				# disahkan admin (force_merge) — merge dilaksanakan di bawah.
				_traveller_merge_guard(traveller, new_ic)
				merge_target = new_ic
				merge_same_name = same_name
			else:
				# Tahap 2 — IC + DOB sepadan tapi nama berbeza: minta
				# pengesahan admin sebelum merge. Pulang TANPA tulisan.
				return {
					"needs_confirmation": True,
					"existing": {
						"traveller": existing.name,
						"full_name": existing.full_name or existing.name,
						"first_name": existing.first_name or "",
						"last_name": existing.last_name or "",
						"date_of_birth": str(existing.date_of_birth or ""),
						"ic_number": existing.ic_number or existing.name,
					},
				}

	_apply_editable_fields(doc)
	doc.save(ignore_permissions=True)

	# IC Number ialah NAMA dokumen Traveller (autoname: field:ic_number).
	# _validate() → _sync_autoname_field() menulis semula medan kepada
	# `name` pada setiap save — menukar ic_number melalui doc.set() sahaja
	# SENYAP TIDAK BERKESAN. Laluan betul: RENAME dokumen — rename_doc
	# mengemas kini SEMUA Link field (Booking Reservation.traveller dsb.)
	# + dynamic link (Comment / Version / File), kemudian medan
	# disegerakkan kepada nama baharu. (frappe.rename_doc versi whitelist
	# tiada ignore_permissions — import model.rename_doc terus.)
	from frappe.model.rename_doc import rename_doc as _rename_doc
	renamed = False
	if merge_target:
		# MERGE X → Y — IC baharu milik rekod lain yang terbukti (nama+DOB)
		# atau diakui (force_merge) orang sama. rename_doc(merge=True)
		# repoint SEMUA rujukan X ke Y dan memadam X, tetapi mengekalkan
		# nilai medan Y — jadi medan yang admin hantar di-apply semula
		# selepas merge supaya suntingan terkini MENANG. Jejak audit
		# direkod sebagai Comment Info pada rekod survivor.
		merged_from = traveller
		_rename_doc("Traveller", traveller, merge_target,
			merge=True, ignore_permissions=True, show_alert=False)
		traveller = merge_target
		renamed = True
		doc = frappe.get_doc("Traveller", traveller)
		_apply_editable_fields(doc)
		doc.save(ignore_permissions=True)
		frappe.get_doc({
			"doctype":           "Comment",
			"comment_type":      "Info",
			"reference_doctype": "Traveller",
			"reference_name":    traveller,
			"content": (
				"Auto-merged Traveller {0} into {1} — matched IC + date of birth"
				"{2}, by {3}".format(
					frappe.bold(merged_from),
					frappe.bold(traveller),
					" + name"
					if merge_same_name
					else " (name differs, confirmed by admin)",
					frappe.session.user,
				)
			),
		}).insert(ignore_permissions=True)
	elif "ic_number" in values:
		new_ic = str(values.get("ic_number") or "").strip().upper()
		if new_ic and new_ic != traveller:
			_rename_doc("Traveller", traveller, new_ic,
				ignore_permissions=True, show_alert=False)
			frappe.db.set_value("Traveller", new_ic, "ic_number", new_ic,
				update_modified=False)
			traveller = new_ic
			renamed = True
			doc = frappe.get_doc("Traveller", traveller)

	# Imej visa ialah PII — pastikan private tidak kira bagaimana ia
	# dimuat naik (checkbox 'Private' dialog upload tidak dijamin).
	if doc.visa_photo:
		new_url = _ensure_private_url(doc.visa_photo)
		if new_url != doc.visa_photo:
			doc.reload()

	# Alias ikut kunci baris senarai traveller di klien.
	return {
		"traveller": doc.name,
		"traveller_name": doc.full_name or doc.name,
		# rename/merge berlaku? — klien papar alert yang berbeza
		"renamed": renamed,
		"title": doc.title or "",
		"first_name": doc.first_name or "",
		"last_name": doc.last_name or "",
		"gender": doc.gender or "",
		"dob": str(doc.date_of_birth or ""),
		"passport_no": doc.passport_no or "",
		"passport_expiry": str(doc.passport_expiry or ""),
		"ic_number": doc.ic_number or "",
		"nationality": doc.nationality or "",
		"visa_photo": doc.visa_photo or "",
		"email": doc.email or "",
		"phone": doc.phone or "",
		"address_line1": doc.address_line1 or "",
		"city": doc.city or "",
		"state": doc.state or "",
		"postcode": doc.postcode or "",
		"country": doc.country or "",
		"emergency_contact_name": doc.emergency_contact_name or "",
		"emergency_contact_phone": doc.emergency_contact_phone or "",
		"emergency_contact_relationship": doc.emergency_contact_relationship or "",
		"wheelchair_assistant": doc.wheelchair_assistant or "",
		"dietary_requirements": doc.dietary_requirements or "",
		"medical_conditions": doc.medical_conditions or "",
		"medicine_treatment": doc.medicine_treatment or "",
		# Medan terbitan selepas before_save — supaya klien boleh render
		# semula modal/senarai dengan status & umur TERKINI tanpa reload.
		"full_name": doc.full_name or "",
		"age": doc.age,
		"age_category": doc.age_category or "",
		"status": doc.status,
		"traveller_status": doc.status,
		"document_status": doc.status,
	}


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
def get_group_rooming(trip_group: str = None, trip_groups: list = None, booking: str = None,
					  search: str = None, privacy: str = None, limit: int = 20) -> dict:
	"""Senarai bilik (rooming) bagi satu group / batch — satu baris untuk
	setiap room_id (fallback booking+cabin_no), diumpuk occupant traveller,
	disusun ikut Room ID.

	booking = skop SATU Booking (tab Rooms L3 /app/manage-booking-app/
	booking/<name>): bilik = room key yang mengandungi reservation booking
	itu; penghuni SEPARUH bilik (kongsi merentas booking, Open Sharing)
	turut dipapar (highlight 'is-cross' oleh pakej rooming list). Group
	diterbitkan daripada Booking.trip_date — trip_group/trip_groups diabaikan.

	privacy = filter Room Privacy ('Private' / 'Open Sharing' /
	'__blank__' untuk bilik tanpa nilai).
	"""
	_require_access()

	booking_scope = None
	if booking:
		booking = str(booking).strip()
		# get_value memulangkan NULL untuk booking TAK WUJUD dan untuk
		# trip_date kosong — asingkan dulu supaya booking sah tanpa group
		# date tidak tersalah dilapor "not found".
		if not frappe.db.exists("Booking", booking):
			frappe.throw(_("Booking {0} not found").format(booking))
		btrip = frappe.db.get_value("Booking", booking, "trip_date")
		groups = [btrip] if btrip else []
		booking_scope = booking
	else:
		groups = _parse_groups(trip_group, trip_groups)

	conditions = ["br.status != 'Cancelled'", "b.status NOT IN %(excl)s"]
	fmt = {"groups": groups, "done": list(DOC_STATUS_DONE),
		   "excl": list(EXCLUDED_BOOKING_STATUSES)}

	if booking_scope:
		conditions.append("br.booking = %(booking)s")
		fmt["booking"] = booking_scope
	else:
		conditions.append("b.trip_date IN %(groups)s")

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

	# Skop booking: kumpulan group tak wajib (booking tanpa trip_date) —
	# room keys sudah terikat kepada booking itu; selain itu kekalkan
	# penapis group seperti lalai.
	room_where = ["br.status != 'Cancelled'", "b.status NOT IN %(excl)s",
				  f"{_ROOM_KEY} IN %(room_keys)s"]
	if groups:
		room_where.append("b.trip_date IN %(groups)s")

	rows = frappe.db.sql(f"""
		SELECT {_ROOM_KEY} AS room_key,
		       br.room_id, IFNULL(NULLIF(br.room_category, ''), 'Unassigned') AS room_category,
		       br.stateroom_no, br.cabin_no, br.room_privacy, br.cabin_is_confirmed,
		       br.date_selection AS trip_group,
		       br.name AS reservation, br.booking, b.booking_number,
		       c.customer_name,
		       br.guest_sequence, br.pax_type, br.guest_label,
		       br.delegate_no, br.aroya_guest_no,
		       br.traveller, br.status AS reservation_status,
		       COALESCE(NULLIF(t.title, ''), NULLIF(br.traveller_title, ''), '') AS title,
		       COALESCE(NULLIF(t.first_name, ''), NULLIF(br.traveller_first_name, ''), '') AS first_name,
		       COALESCE(NULLIF(t.last_name, ''), NULLIF(br.traveller_last_name, ''), '') AS last_name,
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
		       CASE WHEN br.is_a_cruise = 1 THEN NULLIF(br.cruise_start, '0000-00-00')
		            ELSE NULLIF(br.departure_date, '0000-00-00') END AS ref_date,
		       COALESCE(NULLIF(br.traveller_full_name, ''), NULLIF(t.full_name, ''), br.traveller, '') AS traveller_name,
		       COALESCE(NULLIF(br.traveller_gender, ''), NULLIF(t.gender, ''), '') AS gender,
		       COALESCE(NULLIF(t.status, ''), IFNULL(br.document_status, 'Incomplete')) AS document_status,
		       br.action_for_accomodation
		FROM `tabBooking Reservation` br
		INNER JOIN tabBooking b ON b.name = br.booking
		LEFT JOIN tabCustomer c ON c.name = b.customer
		LEFT JOIN tabTraveller t ON t.name = br.traveller
		WHERE {" AND ".join(room_where)}
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
				"booking": r.booking or "",
				"customer_name": r.customer_name or "",
				"delegate_no": "",
				"bookings": [],
				"booking_names": [],
				"guests": [],
				"docs_ok": 0,
				"pending_docs": 0,
			}
			by_room[r.room_key] = entry
			rooms.append(entry)
		if r.booking_number and r.booking_number not in entry["bookings"]:
			entry["bookings"].append(r.booking_number)
		if r.booking and r.booking not in entry["booking_names"]:
			entry["booking_names"].append(r.booking)
		# Umur dikira SEKALI per tetamu (dulu 2× — age + age_bucket).
		age = _age_years(r.dob, r.ref_date)
		entry["guests"].append({
			"reservation": r.reservation,
			"booking": r.booking,
			"name": r.traveller_name or "-",
			"gender": r.gender or "",
			"guest_sequence": _i(r.guest_sequence),
			"pax_type": r.pax_type or "",
			"guest_label": r.guest_label or "",
			"document_status": r.document_status,
			"aroya_guest_no": r.aroya_guest_no if r.aroya_guest_no is not None else "",
			# Profil penginapan reservation (bilik CustomRoom_ modal Move
			# Guest ambil profil tetamu, bukan bilik host).
			"room_category": r.room_category or "",
			"room_privacy": r.room_privacy or "",
			# Medan modal maklumat traveller (show_traveller_dialog) —
			# ekspresi COALESCE sama dengan get_group_travellers.
			"traveller": r.traveller or "",
			"reservation_status": r.reservation_status or "",
			"title": r.title or "",
			"first_name": r.first_name or "",
			"last_name": r.last_name or "",
			"nationality": r.nationality or "",
			"passport_no": r.passport_no or "",
			"passport_expiry": _s(r.passport_expiry),
			"email": r.email or "",
			"phone": r.phone or "",
			"ic_number": r.ic_number or "",
			"passport_image": r.passport_image or "",
			"age": age,
			"age_bucket": _age_bucket(age),
		})
		# Delegate No peringkat BILIK — ambil nilai pertama tak kosong
		# penghuni (medan per-reservation tetapi seragam sebilik).
		if not entry.get("delegate_no") and (r.delegate_no or "").strip():
			entry["delegate_no"] = r.delegate_no.strip()
		if r.document_status in DOC_STATUS_DONE:
			entry["docs_ok"] += 1
		else:
			entry["pending_docs"] += 1

	for entry in rooms:
		entry["pax"] = len(entry["guests"])

	# Pemilik bilik Open Sharing merentas booking — room_id membawa
	# booking_number PEMILIK ('<booking_number>-Room_<n>'), tetapi
	# entry.booking/booking_number diambil dari row penghuni pertama
	# (boleh tetamu booking lain). Selaraskan label bilik kepada pemilik
	# sebenar supaya kad/board tidak tersalah booking.
	num_to_booking = {}
	booking_to_customer = {}
	for r in rows:
		if r.booking_number and r.booking:
			num_to_booking.setdefault(r.booking_number, r.booking)
		if r.booking and r.customer_name:
			booking_to_customer.setdefault(r.booking, r.customer_name)
	for entry in rooms:
		rid = entry.get("room_id") or ""
		if "-Room_" in rid and rid.endswith("-Room_" + str(entry.get("cabin_no") or "")):
			owner_no = rid.split("-Room_")[0]
			owner = num_to_booking.get(owner_no)
			if owner:
				entry["booking"] = owner
				entry["customer_name"] = booking_to_customer.get(owner, entry.get("customer_name") or "")
				entry["bookings"] = [owner_no] + [
					b for b in entry["bookings"] if b != owner_no]
				entry["booking_names"] = [owner] + [
					b for b in entry["booking_names"] if b != owner]

	# Senarai pilihan kategori bilik untuk papan Rooming Board — PENUH
	# daripada doctype Trip Price Category (bukan hanya kategori yang
	# dipakai bilik semasa), DIPADANKAN dengan jenis trip: group cruise →
	# hanya kategori cruise-enabled (is_a_cruise=1); group darat → kategori
	# bukan cruise; batch campuran → kedua-duanya. Kapasiti diambil dari
	# rekod doctype; kategori yang dipakai bilik sedia ada tetap
	# disertakan (fallback kapasiti bilik) supaya paparan kolum konsisten.
	if booking_scope and not groups:
		# Booking tanpa trip_date — flag cruise terus daripada Booking.
		cruise_flags = [bool(frappe.db.get_value(
			"Booking", booking_scope, "is_a_cruise_trip"))]
	else:
		cruise_flags = [bool(r.is_a_cruise_trip) for r in frappe.get_all(
			"Trip Group Date", filters={"name": ["in", groups]},
			fields=["is_a_cruise_trip"])] if groups else []
	if all(cruise_flags):
		cat_filter = {"is_a_cruise": 1}
	elif not any(cruise_flags):
		cat_filter = {"is_a_cruise": 0}
	else:
		cat_filter = None
	categories = {}
	for cat in frappe.get_all("Trip Price Category",
	                          filters=cat_filter or {},
	                          fields=["name", "capacity", "max_capacity"],
	                          order_by="name"):
		categories[cat.name] = {
			"capacity": _i(cat.capacity),
			"max_capacity": _i(cat.max_capacity) if cat.max_capacity is not None
			else _i(cat.capacity),
		}
	# Kategori bilik sedia ada yang tertinggal (data lama / kategori
	# ditukar flag selepas bilik dicipta) — kekal dalam senarai.
	for cat in sorted({e["room_category"] for e in rooms
	                   if e["room_category"] and e["room_category"] != "Unassigned"}):
		if cat not in categories:
			cap, max_cap = _room_capacity(cat)
			categories[cat] = {"capacity": cap, "max_capacity": max_cap}
	for entry in rooms:
		meta = categories.get(entry["room_category"]) or {}
		entry["capacity"] = meta.get("capacity", 0)
		entry["max_capacity"] = meta.get("max_capacity", 0)

	# Nama paparan tersuai per bilik (Booking Room Alias) — dipisahkan
	# daripada room_id (yang kekal mekanikal/auto). Kunci: booking + cabin_no.
	alias_rows = frappe.get_all("Booking Room Alias",
		filters={"booking": ["in", list({e["booking"] for e in rooms if e["booking"]})]},
		fields=["booking", "cabin_no", "custom_name"])
	alias_map = {(a.booking, _i(a.cabin_no)): a.custom_name for a in alias_rows}
	for entry in rooms:
		entry["custom_name"] = alias_map.get(
			(entry["booking"], entry.get("cabin_no") or 0), "")

	return {"rooms": rooms, "shown": len(rooms), "count": total_rooms,
	        "categories": categories}


@frappe.whitelist()
def rename_booking_room(booking: str, cabin_no: int, custom_name: str = "") -> dict:
	"""Tetapkan / buang NAMA PAPARAN tersuai bagi satu bilik (papan
	Rooming Board — butang rename ✎).

	Opsyen A (reka bentuk): nama paparan disimpan BERASINGAN dalam
	Booking Room Alias (sekali per booking+cabin) — Booking Reservation
	.room_id TIDAK disentuh (kekalan mekanikal/auto), jadi pergerakan
	tetamu tidak pernah mempengaruhi nama bilik. custom_name kosong =
	padam alias (kembali kepada label auto).
	"""
	_require_access()
	if not booking or not frappe.db.exists("Booking", booking):
		frappe.throw(_("Booking {0} not found").format(booking))
	try:
		cabin_no = _i(cabin_no)
	except Exception:
		frappe.throw(_("Invalid cabin number"))
	if cabin_no < 1:
		frappe.throw(_("Invalid cabin number"))

	alias_name = "ROOMALIAS-{0}-{1}".format(booking, cabin_no)
	custom_name = str(custom_name or "").strip()

	if not custom_name:
		# Kosong — padam alias (kembali kepada label auto).
		if frappe.db.exists("Booking Room Alias", alias_name):
			frappe.delete_doc("Booking Room Alias", alias_name,
				ignore_permissions=True)
		return {"booking": booking, "cabin_no": cabin_no,
		        "custom_name": "", "renamed": False}

	if frappe.db.exists("Booking Room Alias", alias_name):
		alias = frappe.get_doc("Booking Room Alias", alias_name)
		alias.custom_name = custom_name
		alias.save(ignore_permissions=True)
	else:
		# Nama pendua dalam sebooking disekat validate() doctype —
		# beri mesej jelas di sini sebelum itu.
		if frappe.db.exists("Booking Room Alias",
				{"booking": booking, "custom_name": custom_name}):
			frappe.throw(_("Room name {0} is already used in this booking")
				.format(frappe.bold(custom_name)))
		frappe.get_doc({
			"doctype": "Booking Room Alias",
			"booking": booking,
			"cabin_no": cabin_no,
			"custom_name": custom_name,
		}).insert(ignore_permissions=True)

	return {"booking": booking, "cabin_no": cabin_no,
	        "custom_name": custom_name, "renamed": True}


def _booking_rooming_source_order(booking_name: str) -> list:
	"""Susunan rooming ASAL satu Booking selaras doctype Booking —
	dikira semula daripada SO UTAMA booking (sumber tunggal susunan,
	rujuk _activate_booking/_cabin_layout_from_so):

	  layout cabin SO (susun idx) → kuantiti setiap pax_type → slot
	  berurutan; cabin_no + room_category setiap slot ikut cabin SO.

	Reservation aktif booking itu kemudian DIPADANKAN kepada slot
	berurutan ini (mengikut pax_type dahulu, susunan creation sebagai
	penajam) — inilah "room order synced with doctype Booking" yang
	Reset Rooming Number pulangkan.

	Return: [{reservation, cabin_no, room_category, room_privacy,
	guest_sequence, pax_type}] — guest_sequence = 1..n DALAM cabin hasil
	padanan; room_privacy dari pilihan customer pada SO (fallback nilai
	sedia ada reservation supaya reset tidak memadam privacy).
	"""
	from travel_booking.api.so_helpers import _cabin_layout_from_so, _get_primary_so

	so_name = _get_primary_so(booking_name)
	if not so_name:
		frappe.throw(_("Primary Sales Order not found for this booking"))

	# Slot sumber berurutan: cabin ikut idx SO, pax_type ikut turutan
	# pax_breakdown, kuantiti setiap jenis.
	slots = []
	for cabin in _cabin_layout_from_so(so_name):
		for pax_type, qty in cabin.get("pax_breakdown", {}).items():
			for _ in range(int(qty)):
				slots.append({
					"cabin_no": cabin["cabin_no"],
					"room_category": cabin.get("room_category") or "",
					"room_privacy": cabin.get("room_privacy") or "",
					"pax_type": pax_type,
				})

	# Reservation aktif booking — susun: pax_type ikut turutan slot
	# (Main Guest/Extra Bed/Infant sama frekuensi), creation sebagai
	# penajam dalam jenis sama (masa slot dicipta _activate_booking).
	reservations = frappe.get_all("Booking Reservation",
		filters={"booking": booking_name, "status": ["!=", "Cancelled"]},
		fields=["name", "pax_type", "room_privacy", "creation"],
		order_by="creation asc")

	by_pax = {}
	for r in reservations:
		by_pax.setdefault(r.pax_type or "Main Guest", []).append(r)

	out, seq_in_cabin = [], {}
	for slot in slots:
		pool = by_pax.get(slot["pax_type"])
		if not pool:
			continue
		r = pool.pop(0)
		cabin = slot["cabin_no"]
		seq_in_cabin[cabin] = seq_in_cabin.get(cabin, 0) + 1
		out.append({
			"reservation": r.name,
			"cabin_no": cabin,
			"room_category": slot["room_category"],
			# Privacy asal: pilihan customer pada SO; fallback nilai
			# sedia ada reservation (SO lama tanpa nilai / multi-pax).
			"room_privacy": slot["room_privacy"] or (r.room_privacy or ""),
			"guest_sequence": seq_in_cabin[cabin],
			"pax_type": slot["pax_type"],
		})
	# Reservation lebih daripada slot SO (traveller tambahan / manual)
	# — kekal di cabin semasa, sequence selepas yang terpadan.
	for pool in by_pax.values():
		for r in pool:
			cabin = frappe.db.get_value("Booking Reservation", r.name, "cabin_no") or 0
			seq_in_cabin[cabin] = seq_in_cabin.get(cabin, 0) + 1
			out.append({
				"reservation": r.name,
				"cabin_no": cabin,
				"room_category": frappe.db.get_value(
					"Booking Reservation", r.name, "room_category") or "",
				"room_privacy": r.room_privacy or "",
				"guest_sequence": seq_in_cabin[cabin],
				"pax_type": r.pax_type or "Main Guest",
			})
	return out


@frappe.whitelist()
def get_booking_rooming_source_order(booking: str) -> dict:
	"""Pratonton susunan rooming ASAL satu booking (SO utama) untuk
	Reset Rooming Number pada modal Move Guest — client papar ringkasan
	perubahan (cabin/sequence semasa → asal) sebelum admin sahkan.
	"""
	_require_access()
	if not booking or not frappe.db.exists("Booking", booking):
		frappe.throw(_("Booking {0} not found").format(booking))
	order = _booking_rooming_source_order(booking)
	current = {r.reservation: r for r in frappe.get_all("Booking Reservation",
		filters={"name": ["in", [s["reservation"] for s in order]]},
		fields=["name", "cabin_no", "guest_sequence"])}
	changes = 0
	for s in order:
		c = current.get(s["reservation"])
		if c and ((c.cabin_no or 0) != s["cabin_no"]
				or (c.guest_sequence or 0) != s["guest_sequence"]):
			changes += 1
	return {
		"booking": booking,
		# booking_number doctype Booking — untuk paparan maklumat bilik
		# (room id auto) pada dialog pengesahan Reset modal Move Guest.
		"booking_number": frappe.db.get_value("Booking", booking, "booking_number") or "",
		"order": order,
		"changes": changes,
	}


def _room_capacity(room_category):
	"""(capacity, max_capacity) Trip Price Category. Rekod tiada / nilai
	NULL → (0, 0) = tanpa had (selari _cabin_meta() cabin_sharing, tetapi
	tanpa default 2 — papan rooming papar '—' bila 0)."""
	row = frappe.db.get_value("Trip Price Category", room_category,
	                          ["capacity", "max_capacity"], as_dict=True)
	if not row:
		return 0, 0
	cap = _i(row.capacity)
	max_cap = _i(row.max_capacity) if row.max_capacity is not None else cap
	return cap, max_cap


@frappe.whitelist()
def arrange_group_rooming(moves: list = None) -> dict:
	"""Simpan susunan rooming dari papan Rooming Board (tab Rooms).

	moves — senarai PLACEMENT PENUH (bukan diff; klien hantar kedudukan
	  setiap tetamu + sifat bilik semasa, server banding & hanya save yang
	  benar-benar berubah):
	  [{reservation, cabin_no, from_cabin_no?, room_category?, room_id?,
	    room_privacy?, stateroom_no?, guest_sequence?, cabin_is_confirmed?,
	    aroya_guest_no?}]

	- guest_sequence 0 = RESET kepada nombor auto (penghuni cabin + 1 —
	  butang Reset modal Move Guest); nilai > 0 = nombor eksplisit.
	- reset_rooming=1 (modal Move Guest — butang Reset Rooming Number,
	  selepas pengesahan) = pulangkan SUSUNAN ASAL reservation selaras
	  doctype Booking: cabin_no + guest_sequence dikira semula daripada
	  SO utama (_booking_rooming_source_order); room_id dijana semula.
	- aroya_guest_no — mutasi medan per-tetamu dari modal Move Guest
	  (seksyen Cruise Arrangement).

	- cabin_no 0 = tanggalkan dari bilik (Unassigned).
	- from_cabin_no (opsyenal, klien board baharu) = cabin_no yang dilihat
	  klien masa papan dimuatkan — GUARD STALE BOARD: tak sepadan dengan DB
	  bermakna admin lain dah pindahkan tetamu itu; tanpa guard ni, save
	  placement penuh akan mengembalikan tetamu ke posisi lapuk secara
	  senyap (last-write-wins). Mismatch → TOLAK keseluruhan request.
	- room_category hanya dipakai bila ada nilai — pindahan ke bilik lain
	  membawa kategori bilik SASARAN (satu cabin fizikal satu kategori;
	  validate_cabin_capacity enforce konsistensi ini).
	- Pindahan cabin → room_id direset kosong supaya assign_room_id()
	  (validate doctype) jana semula ID bilik baharu. room_id EKSPLISIT =
	  penempatan Open Sharing MERENTAS booking — server SEMAK bilik
	  sasaran benar-benar wujud & Open Sharing (guard ini dulu
	  client-side sahaja; rb_move boleh dilangkau dengan panggilan API
	  terus).
		- GUARD BILIK CONFIRMED: placement (cabin / room_id / kategori /
		  sequence) reservation yang cabin_is_confirmed TIDAK boleh diubah —
		  selari read_only_depends_on UI, kini di-enforce di server. Buang
		  tanda Confirmed pada bilik dahulu (board membenarkan unchecked).
	- sifat bilik (privacy / stateroom / confirmed) disimpan pada SETIAP
	  reservation penghuni bilik itu (medan per-reservation, klien
	  fan-out).
	- Batch ATOMIK — sebarang ralat membatalkan keseluruhan request
	  (rollback automatik frappe), tiada perubahan tergantung.
	- Laluan doc.save() penuh: validate() doctype (kapasiti, kategori,
	  Room ID, status) sentiasa berjalan — jaring keselamatan terakhir.
	- Skala: refresh_related (Trip Group Date / Flight) DITUNDA per-doc
	  (flags.skip_refresh_related) dan dijalankan SEKALI per trip group /
	  flight di hujung batch — N save tidak lagi menjalankan N refresh
	  (kiraan idempotent, keputusan sama dalam transaksi yang sama).
	- Siaran realtime travel_booking_rooming_updated (after-commit) supaya
	  papan admin lain tahu dan boleh dimuat semula.
	"""
	_require_access()
	if isinstance(moves, str):
		try:
			moves = json.loads(moves)
		except ValueError:
			frappe.throw(_("Invalid moves payload"))
	if not moves or not isinstance(moves, list):
		frappe.throw(_("No rooming changes to save"))

	seen = set()
	updated = []
	group_of_booking = {}    # booking → trip_date (cache elak get_value berulang)
	affected_groups = []     # trip group yang perlu refresh_bookings sekali
	affected_flights = []    # flight yang perlu refresh_seats sekali
	for mv in moves:
		reservation = (mv.get("reservation") or "").strip()
		if not reservation or reservation in seen:
			continue  # placement terakhir menang — jangan ulang save
		seen.add(reservation)
		if not frappe.db.exists("Booking Reservation", reservation):
			frappe.throw(_("Booking Reservation {0} not found").format(reservation))

		doc = frappe.get_doc("Booking Reservation", reservation)
		if doc.status == "Cancelled":
			frappe.throw(_("Reservation {0} is cancelled and cannot be "
			               "re-arranged").format(reservation))

		try:
			cabin_no = int(mv.get("cabin_no") or 0)
		except (TypeError, ValueError):
			frappe.throw(_("Invalid cabin number for {0}").format(reservation))
		if cabin_no < 0:
			frappe.throw(_("Invalid cabin number for {0}").format(reservation))

		# ── GUARD STALE BOARD — cabin asal yang dilihat klien. Klien lama
		#    tanpa medan ni: guard dilangkau (backward-compatible).
		if mv.get("from_cabin_no") is not None:
			try:
				from_cabin = int(mv.get("from_cabin_no") or 0)
			except (TypeError, ValueError):
				from_cabin = None
			if from_cabin is not None and from_cabin != (doc.cabin_no or 0):
				frappe.throw(_("Rooming board is out of date — {0} was moved by "
				               "another user. Reload the board and try again.")
				             .format(frappe.bold(doc.traveller_full_name
				                     or doc.guest_label or reservation)))

		# Nilaian hasrat TANPA mutasi dahulu (guard perlu tahu niat
		# sebelum menolak; mutasi hanya selepas semua guard lulus).
		target_category = (mv.get("room_category") or "").strip()
		explicit_room = (str(mv.get("room_id") or "").strip()
		                 if mv.get("room_id") is not None else None)
		new_seq = _i(mv.get("guest_sequence")) if mv.get("guest_sequence") is not None else None

		# ── RESET ROOMING — pulangkan susunan reservation ni kepada
		#    susunan ASAL selaras doctype Booking (SO utama): cabin_no +
		#    guest_sequence dikira semula oleh _booking_rooming_source_order.
		#    Laluan berasingan: guard confirmed tidak berlaku pada NILAI
		#    yang dihitung semula (reset ialah intent eksplisit admin
		#    "balik kepada asal", bukan perpindahan biasa). Selesai terus
		#    untuk reservation ni (placement lain dalam moves sama kekal).
		if mv.get("reset_rooming"):
			source = next((s for s in _booking_rooming_source_order(doc.booking)
			               if s["reservation"] == reservation), None)
			if source:
				doc.room_category = source["room_category"] or doc.room_category
				doc.cabin_no = source["cabin_no"] or None
				doc.room_id = ""      # assign_room_id() jana semula ikut cabin
				doc.guest_sequence = source["guest_sequence"]
				doc.flags.skip_refresh_related = 1
				doc.save(ignore_permissions=True)
				updated.append({
					"reservation": doc.name,
					"room_id": doc.room_id or "",
					"cabin_no": doc.cabin_no or 0,
					"reset": True,
				})
				bg = frappe.db.get_value("Booking", doc.booking, "trip_date") or ""
				if bg and bg not in affected_groups:
					affected_groups.append(bg)
				if doc.flight and doc.flight not in affected_flights:
					affected_flights.append(doc.flight)
			continue

		moves_cabin = cabin_no != (doc.cabin_no or 0)
		changes_room = explicit_room is not None and explicit_room != (doc.room_id or "")
		changes_category = bool(target_category) and target_category != "Unassigned" \
			and target_category != doc.room_category
		changes_seq = new_seq is not None and new_seq > 0 \
			and new_seq != (doc.guest_sequence or 0)

		# ── GUARD BILIK CONFIRMED — placement beku; unchecked Confirmed
		#    sendiri masih dibenarkan (cara sah "cairkan" bilik).
		if doc.cabin_is_confirmed and (moves_cabin or changes_room
				or changes_category or changes_seq):
			frappe.throw(_("Reservation {0} is in a confirmed room arrangement — "
			               "uncheck 'Confirmed' on the room before moving or "
			               "re-categorising it.")
			             .format(frappe.bold(doc.traveller_full_name
			                     or doc.guest_label or reservation)))

		# ── GUARD OPEN SHARING MERENTAS BOOKING — room_id eksplisit milik
		#    booking lain hanya sah bila bilik sasaran Open Sharing & ada
		#    penghuni. (Room milik sendiri: assign_room_id jana biasa.)
		if changes_room and explicit_room and "-Room_" in explicit_room:
			owner_ref = explicit_room.split("-Room_")[0]
			own_ref = doc.booking_number
			if not own_ref and doc.booking:
				own_ref = frappe.db.get_value("Booking", doc.booking, "booking_number")
			own_ref = own_ref or doc.booking
			if owner_ref != own_ref:
				occupants = frappe.get_all(
					"Booking Reservation",
					filters={"room_id": explicit_room, "status": ["!=", "Cancelled"]},
					fields=["room_privacy"], limit=1)
				if not occupants:
					frappe.throw(_("Target room {0} does not exist or has no guests")
					             .format(frappe.bold(explicit_room)))
				if (occupants[0].room_privacy or "") != "Open Sharing":
					frappe.throw(_("Target room {0} is not Open Sharing — a guest "
					               "can only be placed in a room of another booking "
					               "when that room is Open Sharing")
					             .format(frappe.bold(explicit_room)))

		# ── Mutasi (hanya selepas semua guard lulus) ──
		changed = False
		if changes_category:
			doc.room_category = target_category
			changed = True

		# Room ID eksplisit (klien Rooming Board sentiasa menghantar medan
		# ini): nilai terisi = penempatan Open Sharing MERENTAS booking —
		# reservation tetamu booking lain membawa room_id bilik sasaran
		# supaya assign_room_id() tidak menjana semula ID ikut booking
		# sendiri. Nilai kosong = penempatan biasa — reset supaya
		# assign_room_id() jana semula ikut booking+cabin baharu.
		if changes_room:
			doc.room_id = explicit_room
			changed = True

		# Pindahan cabin → set cabin; room_id sudah diurus di atas (laluan
		# klien lama tanpa medan room_id kekal reset seperti asal).
		if moves_cabin:
			doc.cabin_no = cabin_no or None
			if mv.get("room_id") is None:
				doc.room_id = ""
			changed = True

		# Guest sequence tetamu yang DIPINDAHKAN — klien hantar nombor
		# baharu mengikut urutan penghuni bilik sasaran ("mengikut rakan
		# sebilik/host"). Tetamu yang tidak berpindah tidak menghantar
		# medan ini — nilai asalnya kekal. Nilai 0 = RESET kepada nombor
		# auto (butang Reset pada modal Move Guest) — formula sama
		# set_guest_sequence doctype: bilangan penghuni cabin + 1.
		# PENGHUNI MERENTAS BOOKING DIKECUALIKAN — tetamu Open Sharing yang
		# membawa room_id bilik booking lain (cabin_no mengikut PEMILIK)
		# bukan penghuni cabin penomboran booking sendiri.
		if new_seq is not None and new_seq == 0:
			own_ref = doc.booking_number
			if not own_ref and doc.booking:
				own_ref = frappe.db.get_value("Booking", doc.booking, "booking_number")
			own_ref = own_ref or doc.booking
			doc.guest_sequence = frappe.db.sql("""
				SELECT COUNT(*)
				FROM `tabBooking Reservation`
				WHERE booking = %(booking)s
				  AND IFNULL(cabin_no, 0) = %(cabin_no)s
				  AND name != %(name)s
				  AND status != 'Cancelled'
				  AND (room_id IS NULL OR room_id = ''
				       OR SUBSTRING_INDEX(room_id, '-Room_', 1) = %(own_ref)s)
			""", {
				"booking": doc.booking,
				"cabin_no": cabin_no or doc.cabin_no or 0,
				"name": doc.name or "",
				"own_ref": own_ref,
			})[0][0] + 1
			changed = True
		elif changes_seq:
			doc.guest_sequence = new_seq
			changed = True

		if mv.get("room_privacy") is not None \
				and (mv.get("room_privacy") or "") != (doc.room_privacy or ""):
			doc.room_privacy = mv.get("room_privacy") or ""
			changed = True
		if mv.get("stateroom_no") is not None \
				and (mv.get("stateroom_no") or "").strip() != (doc.stateroom_no or "").strip():
			doc.stateroom_no = (mv.get("stateroom_no") or "").strip()
			changed = True
		if mv.get("delegate_no") is not None \
				and (mv.get("delegate_no") or "").strip() != (doc.delegate_no or "").strip():
			doc.delegate_no = (mv.get("delegate_no") or "").strip()
			changed = True
		if mv.get("cabin_is_confirmed") is not None \
				and bool(mv.get("cabin_is_confirmed")) != bool(doc.cabin_is_confirmed):
			doc.cabin_is_confirmed = 1 if mv.get("cabin_is_confirmed") else 0
			changed = True

		# Aroya Guest No — medan per-tetamu cruise (modal Move Guest,
		# seksyen Cruise Arrangement); kosong dibenarkan (tiada nombor).
		if mv.get("aroya_guest_no") is not None \
				and _i(mv.get("aroya_guest_no")) != (doc.aroya_guest_no or 0):
			doc.aroya_guest_no = _i(mv.get("aroya_guest_no")) or None
			changed = True

		if changed:
			# Tunda refresh_related per-doc — dijalankan SEKALI per trip
			# group / flight di hujung batch (transaksi sama; kiraan
			# refresh_bookings/refresh_seats nampak keseluruhan batch).
			doc.flags.skip_refresh_related = 1
			doc.save(ignore_permissions=True)
			updated.append({
				"reservation": doc.name,
				"room_id": doc.room_id or "",
				"cabin_no": doc.cabin_no or 0,
			})
			bg = group_of_booking.get(doc.booking)
			if bg is None:
				bg = frappe.db.get_value("Booking", doc.booking, "trip_date") or ""
				group_of_booking[doc.booking] = bg
			if bg and bg not in affected_groups:
				affected_groups.append(bg)
			if doc.flight and doc.flight not in affected_flights:
				affected_flights.append(doc.flight)

	if not updated:
		return {"updated": [], "count": 0,
		        "message": "No changes — rooming already up to date"}

	# ── Refresh tertunda: sekali per trip group / flight ──
	for g in affected_groups:
		frappe.get_doc("Trip Group Date", g).refresh_bookings()
	for f in affected_flights:
		frappe.get_doc("Flight", f).refresh_seats()

	# ── Siaran realtime (hanya selepas commit) — papan admin lain yang
	#    sedang terbuka boleh muat semula / beri amaran draf lapuk.
	#    'by' = pengguna penyimpan — papan PENYIMpan abaikan echo sendiri
	#    (guard RB._echoGuard, rujuk rb_watch_realtime) supaya save
	#    sendiri tidak mencetuskan amaran "another user updated".
	frappe.publish_realtime("travel_booking_rooming_updated",
	                        {"trip_groups": affected_groups,
	                         "count": len(updated),
	                         "by": frappe.session.user}, after_commit=True)

	return {"updated": updated, "count": len(updated)}


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
		       t.status AS traveller_status,
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
							  trip_groups: "list | str" = None,
							  reservations: "list | str" = None):
	"""Skop muat turun traveller — disatukan pada get_group_travellers.
	Return (baris travellers, nama asas fail). Mode booking bila `booking`
	diberikan; jika tidak mode group/batch (reservation Cancelled &
	booking Cancelled/Abandoned diketepikan).

	`reservations` (list / JSON string / berkoma) — pilihan checkbox bulk
	edit: bila diberikan, HANYA baris reservation tersebut dieksport dan
	nama fail diberi akhiran '-selected'.

	`trip_groups` menerima list (frappe.call POST) ATAU string JSON /
	berkoma (pautan <a href> GET) — _parse_groups normalize kedua-duanya."""
	if booking:
		data = get_group_travellers(booking=booking, limit=0)
		rows, base = data.get("travellers", []), booking
	else:
		groups = _parse_groups(trip_group, trip_groups)
		data = get_group_travellers(trip_groups=groups, limit=0)
		rows, base = data.get("travellers", []), "-".join(groups)[:60] or "groups"
	if reservations:
		if isinstance(reservations, str):
			try:
				reservations = json.loads(reservations)
			except ValueError:
				reservations = [x.strip() for x in reservations.split(",") if x.strip()]
		sel = {str(x) for x in (reservations or []) if x}
		if sel:
			rows = [r for r in rows if str(r.get("reservation")) in sel]
			base += "-selected"
	return rows, base


@frappe.whitelist()
def download_traveller_images(booking: str = None, trip_group: str = None,
							  trip_groups: "list | str" = None,
							  reservations: "list | str" = None):
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

	rows, base = _traveller_download_scope(booking, trip_group, trip_groups, reservations)
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
						   trip_groups: list = None,
						   reservations: "list | str" = None):
	"""Baris eksport traveller (satu baris setiap reservation, medan penuh
	daripada get_group_travellers — sumber disatukan) — dikongsi eksport
	XLSX & CSV. Kolum 'Booking' ditambah pada mode group/batch (baris
	merentas pelbagai booking). Return (rows, nama asas fail)."""
	rows_src, base = _traveller_download_scope(booking, trip_group, trip_groups, reservations)
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
							  trip_groups: "list | str" = None,
							  reservations: "list | str" = None):
	"""Excel (XLSX) SEMUA maklumat traveller + booking reservation — skop
	satu booking ATAU satu group/batch (manifest trip)."""
	from frappe.utils.xlsxutils import make_xlsx

	rows, base = _traveller_export_rows(booking, trip_group, trip_groups, reservations)
	out = make_xlsx(rows, "Travellers")
	frappe.local.response.update({
		"type": "download",
		"filename": f"travellers-{base}.xlsx",
		"filecontent": out.getvalue() if out else b"",
	})


@frappe.whitelist()
def download_travellers_csv(booking: str = None, trip_group: str = None,
							trip_groups: "list | str" = None,
							reservations: "list | str" = None):
	"""CSV SEMUA maklumat traveller + booking reservation — baris sama
	dengan Excel; skop booking ATAU group/batch. BOM UTF-8 supaya Excel
	buka dengan aksara betul."""
	import csv
	import io

	rows, base = _traveller_export_rows(booking, trip_group, trip_groups, reservations)
	buf = io.StringIO()
	csv.writer(buf).writerows(rows)
	frappe.local.response.update({
		"type": "download",
		"filename": f"travellers-{base}.csv",
		"filecontent": buf.getvalue().encode("utf-8-sig"),
	})


# ── Muat turun senarai BOOKING (pakej booking list) ─────────────────


def _booking_download_scope(trip_groups: "list | str" = None,
							bookings: "list | str" = None):
	"""Skop muat turun senarai booking — baris daripada get_group_bookings
	(skop PENUH group/batch, tanpa limit & tanpa penapis paparan) — mirror
	_traveller_download_scope.

	`bookings` (list / JSON string / berkoma) — pilihan checkbox bulk edit:
	bila diberikan, HANYA booking tersebut dieksport dan nama fail diberi
	akhiran '-selected'.

	`trip_groups` menerima list (frappe.call POST) ATAU string JSON /
	berkoma (pautan <a href> GET) — _parse_groups normalize kedua-duanya.
	Return (rows, nama asas fail)."""
	groups = _parse_groups(None, trip_groups)
	data = get_group_bookings(trip_groups=groups, limit=0)
	rows, base = data.get("bookings", []), "-".join(groups)[:60] or "groups"
	if bookings:
		if isinstance(bookings, str):
			try:
				bookings = json.loads(bookings)
			except ValueError:
				bookings = [x.strip() for x in bookings.split(",") if x.strip()]
		sel = {str(x) for x in (bookings or []) if x}
		if sel:
			rows = [r for r in rows if str(r.get("name")) in sel]
			base += "-selected"
	return rows, base


def _booking_export_rows(trip_groups: "list | str" = None,
						 bookings: "list | str" = None):
	"""Baris eksport senarai booking (satu baris setiap booking, medan
	daripada get_group_bookings — sumber disatukan) — dikongsi eksport
	XLSX & CSV. Wang per currency: baris satu currency → nombor + kolum
	'Currency'; campur currency → string pecahan 'RM 1,000.00 · S$ 20.00'.
	Return (rows, nama asas fail)."""
	rows_src, base = _booking_download_scope(trip_groups, bookings)

	def money(b, field):
		"""Nilai wang satu field — nombor (satu currency) atau string
		pecahan per currency (campur)."""
		by_cur = b.get("gross_by_currency") or []
		if not by_cur:
			return 0.0
		if len(by_cur) == 1:
			return _f(by_cur[0].get(field))
		return " · ".join(
			f"{r.get('currency')} {_f(r.get(field))}" for r in by_cur)

	headers = [
		"No", "Booking No", "Booking ID", "Customer", "Email", "Phone",
		"Booking Status", "Payment Status", "Booking Channel",
		"Checkout Method", "Trip Group Date", "Pax", "Rooms",
		"Docs Verified", "Docs Submitted", "Docs Pending",
		"Gross", "Paid", "Balance", "Currency",
		"Voucher Discount", "Price Rule Discount", "Referral Discount",
		"Customer Message", "Created",
	]
	rows = [headers]
	for i, b in enumerate(rows_src, start=1):
		rows.append([
			i, b.get("booking_number"), b.get("name"),
			b.get("customer_name"), b.get("cust_email"), b.get("cust_phone"),
			b.get("status"), b.get("payment_status"),
			b.get("booking_channel"), b.get("checkout_method"),
			b.get("trip_date"), b.get("pax"), b.get("rooms"),
			b.get("docs_verified"), b.get("docs_submitted"),
			b.get("pending_docs"),
			money(b, "gross"), money(b, "paid"), money(b, "balance"),
			b.get("currency") or "",
			_f(b.get("voucher_discount")), _f(b.get("price_rule_discount")),
			_f(b.get("referral_discount")),
			b.get("customer_message"), b.get("creation"),
		])
	return rows, base


@frappe.whitelist()
def download_bookings_excel(trip_groups: "list | str" = None,
							bookings: "list | str" = None):
	"""Excel (XLSX) senarai booking — skop group/batch ATAU baris terpilih
	(checkbox bulk edit) — mirror download_travellers_excel."""
	from frappe.utils.xlsxutils import make_xlsx

	rows, base = _booking_export_rows(trip_groups, bookings)
	out = make_xlsx(rows, "Bookings")
	frappe.local.response.update({
		"type": "download",
		"filename": f"bookings-{base}.xlsx",
		"filecontent": out.getvalue() if out else b"",
	})


@frappe.whitelist()
def download_bookings_csv(trip_groups: "list | str" = None,
						  bookings: "list | str" = None):
	"""CSV senarai booking — baris sama dengan Excel; BOM UTF-8 supaya
	Excel membuka dengan aksara betul."""
	import csv
	import io

	rows, base = _booking_export_rows(trip_groups, bookings)
	buf = io.StringIO()
	csv.writer(buf).writerows(rows)
	frappe.local.response.update({
		"type": "download",
		"filename": f"bookings-{base}.csv",
		"filecontent": buf.getvalue().encode("utf-8-sig"),
	})


# ══════════════════════════════════════════════
# PAYMENT LINK — L3 Booking Info (butang di bawah badge Payment Status,
# strip .mba-bkg-money). Admin jana pautan bayaran untuk Sales Order
# outstanding booking — BEBERAPA SO boleh digabungkan dalam SATU caj
# Stripe (satu PaymentIntent + checkout URL, metadata 'payment_requests'
# membawa SEMUA Payment Request; webhook Stripe melunaskan semuanya).
# Modal papar QR + pautan + pecahan SO, dan butang hantar melalui
# WhatsApp (wa.me, dibina sisi klien) atau emel (server).
# ══════════════════════════════════════════════


def _booking_paylink_context(booking: str):
	"""Row Booking + SEMUA Sales Order submitted (docstatus=1) booking ni
	berserta baki. Baki = grand_total − advance_paid (selari agregat
	money_by_currency dalam get_booking_profile). Pulangkan (booking, sos)
	— booking row mengandungi contact customer untuk WhatsApp/emel."""
	b = frappe.db.get_value(
		"Booking", booking,
		["name", "booking_number", "customer", "cust_email",
		 "get_cust_booking_phone AS cust_phone"],
		as_dict=True,
	)
	if not b:
		frappe.throw(_("Booking {0} not found").format(booking))

	sos = frappe.db.sql("""
		SELECT so.name, so.custom_booking_addon, so.status, so.currency,
		       so.grand_total, so.advance_paid,
		       ROUND(so.grand_total - so.advance_paid, 2) AS balance
		FROM `tabSales Order` so
		WHERE so.custom_booking = %(booking)s AND so.docstatus = 1
		ORDER BY so.creation ASC, so.name ASC
	""", {"booking": b.name}, as_dict=True)
	return b, sos


def _paylink_checkout_url(pr_name: str, booking_number: str) -> str:
	"""URL checkout (mutlak) untuk satu Payment Request — struktur sama
	dengan create_payment_intent() (stripe_checkout.py): /checkout?pr=...&
	src=portal&ref=<booking_number>. PR sedia ada boleh dibina semula URL-nya
	tanpa panggilan Stripe (intent dipulihkan checkout.html melalui cache /
	carian metadata)."""
	from urllib.parse import quote
	return frappe.utils.get_url(
		"/checkout?pr=" + quote(pr_name, safe="") +
		"&src=portal" +
		("&ref=" + quote(booking_number, safe="") if booking_number else "")
	)


def _qr_svg_data_uri(text: str) -> str:
	"""QR code pautan bayaran sebagai SVG data-URI — dipapar terus dalam
	<img> modal tanpa fail sementara. Guna SvgPathImage (tiada kebergantungan
	PIL untuk laluan ini)."""
	import base64
	import io

	import qrcode
	import qrcode.image.svg

	img = qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage,
					  box_size=12, border=2)
	buf = io.BytesIO()
	img.save(buf)
	return "data:image/svg+xml;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


@frappe.whitelist()
def get_booking_payment_links(booking: str = None) -> dict:
	"""Data modal Payment Link — SO outstanding (calon dipautkan) + senarai
	pautan AKTIF (Payment Request submitted, belum Paid, bagi SO booking)
	berserta URL checkout semula + QR untuk pautan utama."""
	_require_access()
	if not booking:
		frappe.throw(_("Booking is required"))

	b, sos = _booking_paylink_context(booking)
	booking_number = b.booking_number or b.name

	# Pautan aktif — merangkumi SEMUA SO submitted (bukan outstanding
	# sahaja): PR lama untuk SO yang dah dijumlah kaedah lain kekal kelihatan
	# supaya admin boleh abaikan/batalkan, bukan hilang senyap.
	so_names = [so.name for so in sos]
	links = []
	if so_names:
		for pr in frappe.get_all(
			"Payment Request",
			filters={
				"reference_doctype": "Sales Order",
				"reference_name": ["in", so_names],
				"docstatus": 1,
				"status": ["!=", "Paid"],
			},
			fields=["name", "reference_name", "grand_total", "currency",
					"creation"],
			order_by="creation asc",
		):
			links.append({
				"payment_request": pr.name,
				"sales_order": pr.reference_name,
				"amount": _f(pr.grand_total),
				"currency": pr.currency or _def_cur(),
				"creation": _s(pr.creation),
				"checkout_url": _paylink_checkout_url(pr.name, booking_number),
			})
	# QR utama — pautan terawal yang masih aktif (biasanya PR gabungan
	# terakhir yang dijana untuk set SO yang sama).
	if links:
		links[0]["qr"] = _qr_svg_data_uri(links[0]["checkout_url"])

	outstanding = [{
		"name": so.name,
		"is_addon": bool(so.custom_booking_addon),
		"status": so.status or "",
		"currency": so.currency or _def_cur(),
		"grand_total": _f(so.grand_total),
		"advance_paid": _f(so.advance_paid),
		"balance": _f(so.balance),
	} for so in sos if _f(so.balance) > 0.009]

	return {
		"booking": b.name,
		"booking_number": booking_number,
		"customer": b.customer or "",
		"customer_name": frappe.db.get_value("Customer", b.customer,
											 "customer_name") or b.customer or "",
		"cust_email": b.cust_email or "",
		"cust_phone": b.cust_phone or "",
		"sos": outstanding,
		"links": links,
	}


@frappe.whitelist()
def create_booking_payment_link(booking: str = None,
								sales_orders: "list | str" = None,
								amounts: "dict | str" = None) -> dict:
	"""Jana pautan bayaran untuk SO outstanding booking — SATU caj Stripe
	(PaymentIntent) untuk SEMUA SO terpilih.

	'amounts' (opsyenal): {nama SO: jumlah} — alokasi DIKUSTOM per SO untuk
	bayaran separa (lalai = baki penuh SO itu bila SO tiada dalam dict).
	Setiap jumlah disahkan: 0 < jumlah ≤ baki SO (keperluan
	validate_payment_request_amount ERPNext — PR tak boleh melebihi baki
	dokumen rujukannya). Jumlah PaymentIntent = jumlah semua alokasi.

	MEKANISME MULTI-SO: ERPNext Payment Request hanya boleh merujuk SATU
	SO, jadi SATU PR dicipta PER SO (grand_total = alokasi SO masing-masing
	— lulus validate_payment_request_amount). PaymentIntent Stripe tunggal
	 membawa jumlah KESELURUHAN; metadata 'payment_requests' (dipisah '|')
	senaraikan SEMUA PR — webhook payment_intent.succeeded melunaskan
	setiap PR (set_as_paid → satu PE per SO, advance_paid & status booking
	betul-betul dikemaskini melalui hook Payment Entry sedia ada).

	PR lama yang belum Paid bagi SO yang sama DIBATALKAN dahulu (selari
	create_payment_intent) supaya pautan lama tidak lagi berbayar dan
	ERPNext tidak mengumpul PR lapuk dalam semakan jumlahnya."""
	import stripe

	from travel_booking.api._helpers import get_customer_email
	from travel_booking.api.stripe_checkout import _get_stripe_settings

	_require_access()
	if not booking:
		frappe.throw(_("Booking is required"))

	b, sos = _booking_paylink_context(booking)
	outstanding = {so.name: so for so in sos if _f(so.balance) > 0.009}
	if not outstanding:
		frappe.throw(_("No Sales Order with outstanding balance for this booking."))

	# Pilihan SO — kosong = SEMUA SO outstanding. String JSON / CSV diterima
	# (frappe.call hantar array; form-encoded mungkin string).
	if isinstance(sales_orders, str):
		try:
			sales_orders = json.loads(sales_orders)
		except (TypeError, ValueError):
			sales_orders = [s.strip() for s in sales_orders.split(",") if s.strip()]
	sel = [str(s) for s in (sales_orders or list(outstanding.keys()))]
	invalid = [s for s in sel if s not in outstanding]
	if invalid:
		# Jangan senyap-buang — admin mesti tahu bila SO yang dipilih sudah
		# tidak outstanding (dibayar/dibatalkan sejak modal dibuka).
		frappe.throw(_(
			"These Sales Orders are not outstanding for this booking "
			"(already paid or cancelled): {0} — refresh and try again."
		).format(", ".join(invalid)))
	if not sel:
		frappe.throw(_("No Sales Order selected."))

	# ── Alokasi dikustom per SO (bayaran separa) — lalai baki penuh.
	# Nilai dikira semula di server; setiap jumlah mesti 0 < x ≤ baki SO
	# (ERPNext validate_payment_request_amount menolak PR melebihi baki).
	if isinstance(amounts, str):
		try:
			amounts = json.loads(amounts)
		except (TypeError, ValueError):
			amounts = None
	if not isinstance(amounts, dict):
		amounts = {}
	alloc = {}
	for so_name in sel:
		so = outstanding[so_name]
		balance = round(_f(so.balance), 2)
		amt = round(_f(amounts.get(so_name, balance)), 2)
		if amt <= 0:
			frappe.throw(_(
				"Allocation for {0} must be greater than zero."
			).format(so_name))
		if amt > balance + 0.01:
			frappe.throw(_(
				"Allocation for {0} ({1}) exceeds its outstanding balance ({2})."
			).format(so_name, amt, balance))
		alloc[so_name] = amt

	# SATU caj gabungan wajib SATU currency — guardrail single-currency
	# per booking; kalau bercampur (addon currency lain), minta admin jana
	# berasingan per currency.
	currencies = {outstanding[s].currency or _def_cur() for s in sel}
	if len(currencies) > 1:
		frappe.throw(_(
			"Selected Sales Orders use different currencies ({0}) — a combined "
			"payment must be single-currency. Generate a separate link per "
			"currency."
		).format(", ".join(sorted(currencies))))
	currency = currencies.pop()

	total = round(sum(alloc[s] for s in sel), 2)

	# Minimum caj online (Travel Settings) — jaring awal supaya checkout
	# tidak gagal di hujung Stripe.
	settings = frappe.get_cached_doc("Travel Settings")
	online_min = float(getattr(settings, "online_payment_min_amount", 0) or 0)
	if online_min and total < online_min:
		frappe.throw(_("Online payment requires a minimum of {0} {1}.").format(
			online_min, currency))

	ss, gateway_account = _get_stripe_settings(currency)

	email = b.cust_email or get_customer_email(b.customer) or ""
	booking_number = b.booking_number or b.name

	# ── Bersihkan PR lama belum Paid per SO terpilih (selari
	# create_payment_intent) — PR submitted terkumpul membuat
	# validate_payment_request_amount() gagal dan pautan lama mengelirukan.
	for so_name in sel:
		for old_name in frappe.get_all(
			"Payment Request",
			filters={
				"reference_doctype": "Sales Order",
				"reference_name": so_name,
				"docstatus": 1,
				"status": ["!=", "Paid"],
			},
			pluck="name",
		):
			try:
				old = frappe.get_doc("Payment Request", old_name)
				old.flags.ignore_permissions = True
				old.cancel()
			except Exception as e:
				frappe.log_error(
					"Failed to cancel old Payment Request " + old_name +
					" for " + so_name + ": " + str(e),
					"Payment Link Cleanup Error")

	# ── SATU PR per SO (grand_total = alokasi SO itu) + SATU PaymentIntent
	# gabungan berjumlah semua alokasi.
	pr_names = []
	try:
		for so_name in sel:
			pr = frappe.get_doc({
				"doctype": "Payment Request",
				"payment_request_type": "Inward",
				"party_type": "Customer",
				"party": b.customer,
				"reference_doctype": "Sales Order",
				"reference_name": so_name,
				"grand_total": alloc[so_name],
				"currency": currency,
				"email_to": email,
				"mute_email": 1,
			})
			pr.insert(ignore_permissions=True)
			pr.submit()
			# payment_account/payment_gateway SELEPAS submit (db_set — tak
			# re-trigger validate) supaya set_as_paid cipta PE ke akaun
			# gateway yang betul (rujuk nota panjang create_payment_intent).
			pr.db_set("payment_account", gateway_account.payment_account,
					  update_modified=False)
			pr.db_set("payment_gateway", gateway_account.payment_gateway,
					  update_modified=False)
			pr_names.append(pr.name)

		stripe.api_key = ss.get_password("secret_key")
		intent = stripe.PaymentIntent.create(
			amount=int(round(total * 100)),
			currency=currency.lower(),
			receipt_email=email or None,
			description="Rarecruise Payment — " + booking_number,
			metadata={
				"payment_request": pr_names[0],
				"payment_requests": "|".join(pr_names),
				"sales_order": sel[0],
				"booking_number": booking_number,
				"source": "admin",
			},
		)
	except Exception:
		frappe.db.rollback()
		raise

	# Cache pr utama → intent (sumber kebenaran checkout.html, rujuk
	# create_payment_intent). PR lain tidak perlu — checkout hanya dibuka
	# melalui pautan PR utama.
	frappe.cache().set_value("checkout_intent_" + pr_names[0], intent.id,
							 expires_in_sec=7200)
	frappe.db.commit()

	checkout_url = _paylink_checkout_url(pr_names[0], booking_number)
	return {
		"status": "ok",
		"payment_requests": pr_names,
		"checkout_url": checkout_url,
		"qr": _qr_svg_data_uri(checkout_url),
		"total": total,
		"currency": currency,
		"orders": [{
			"sales_order": so_name,
			"payment_request": pr_names[i],
			"amount": alloc[so_name],
		} for i, so_name in enumerate(sel)],
	}


@frappe.whitelist()
def send_booking_payment_email(booking: str = None,
							   payment_requests: "list | str" = None) -> dict:
	"""Emel pautan bayaran kepada customer booking — jumlah & URL DIKIRA
	SEMULA di server daripada rekod Payment Request (nama PR sahaja diterima
	dari klien; nilai wang tidak dipercayai daripada request)."""
	from travel_booking.api._helpers import get_customer_email

	_require_access()
	if not booking:
		frappe.throw(_("Booking is required"))

	b, sos = _booking_paylink_context(booking)
	booking_number = b.booking_number or b.name
	recipient = b.cust_email or get_customer_email(b.customer) or ""
	if not recipient:
		frappe.throw(_("This booking has no customer email address."))

	if isinstance(payment_requests, str):
		try:
			payment_requests = json.loads(payment_requests)
		except (TypeError, ValueError):
			payment_requests = [p.strip() for p in payment_requests.split(",")
								if p.strip()]
	payment_requests = [str(p) for p in (payment_requests or [])]
	if not payment_requests:
		frappe.throw(_("No payment link to send."))

	so_names = {so.name for so in sos}
	rows = []
	for pr in frappe.get_all(
		"Payment Request",
		filters={
			"name": ["in", payment_requests],
			"reference_doctype": "Sales Order",
			"docstatus": 1,
			"status": ["!=", "Paid"],
		},
		fields=["name", "reference_name", "grand_total", "currency"],
		order_by="creation asc",
	):
		if pr.reference_name not in so_names:
			continue  # PR bukan milik booking ni — abaikan (bukan throw,
			# supaya senarai separuh sahaja masih boleh dihantar)
		rows.append({
			"sales_order": pr.reference_name,
			"amount": _f(pr.grand_total),
			"currency": pr.currency or _def_cur(),
			"checkout_url": _paylink_checkout_url(pr.name, booking_number),
		})
	if not rows:
		frappe.throw(_("The payment links are no longer active — regenerate them first."))

	# Jumlah per currency (biasanya satu; jangan jumlah merentas currency).
	totals = {}
	for r in rows:
		totals[r["currency"]] = round(totals.get(r["currency"], 0) + r["amount"], 2)

	trip = frappe.db.sql("""
		SELECT tm.trip_name
		FROM `tabBooking` b
		LEFT JOIN `tabTrip Group Date` td ON td.name = b.trip_date
		LEFT JOIN `tabTrip` tm ON tm.name = td.trip
		WHERE b.name = %(booking)s
	""", {"booking": b.name}, as_dict=True)
	trip_name = (trip[0].trip_name if trip and trip[0].trip_name else "") or ""

	total_html = " + ".join(
		f"{cur} {frappe.utils.fmt_money(v, currency=cur)}"
		for cur, v in totals.items())
	order_rows = "".join(
		"<tr>"
		f"<td style='padding:6px 12px;border-bottom:1px solid #eee;'>"
		f"<a href='{r['checkout_url']}'>{r['sales_order']}</a></td>"
		f"<td style='padding:6px 12px;border-bottom:1px solid #eee;text-align:right;'>"
		f"{r['currency']} {frappe.utils.fmt_money(r['amount'], currency=r['currency'])}</td>"
		"</tr>"
		for r in rows)
	links_html = "".join(
		f"<li style='margin:6px 0;word-break:break-all;'>"
		f"<a href='{r['checkout_url']}'>{r['checkout_url']}</a></li>"
		for r in rows)

	message = f"""
<p>Dear {frappe.utils.escape_html(b.customer or 'Customer')},</p>
<p>This is a payment request for booking <b>{frappe.utils.escape_html(booking_number)}</b>
{('— ' + frappe.utils.escape_html(trip_name)) if trip_name else ''}.</p>
<table style="border-collapse:collapse;margin:12px 0;">
	<tr><th style="padding:6px 12px;text-align:left;border-bottom:2px solid #ddd;">Order</th>
	<th style="padding:6px 12px;text-align:right;border-bottom:2px solid #ddd;">Amount Due</th></tr>
	{order_rows}
	<tr><td style="padding:8px 12px;font-weight:700;">Total</td>
	<td style="padding:8px 12px;font-weight:700;text-align:right;">{total_html}</td></tr>
</table>
<p>Please complete your payment securely using the link below
(also shown as a scannable QR code in your payment message):</p>
<ul style="padding-left:18px;">{links_html}</ul>
<p>If you have already paid, please ignore this email.</p>
<p>Thank you.</p>
"""

	frappe.sendmail(
		recipients=[recipient],
		subject=_("Payment Request — Booking {0}").format(booking_number),
		message=message,
		now=True,
	)
	return {"status": "ok", "sent_to": recipient,
			"payment_requests": [r["sales_order"] for r in rows]}
