# travel_booking/api/ongoing_today.py
#
# Backend untuk Desk Page /app/ongoing-today — "Ongoing Today".
#
# Konsep: satu snapshot harian SEMUA elemen travel booking yang sensitif
# dengan timeline masa, disusun sebagai row-groups untuk paparan Gantt:
#
#   1. ongoing_trips   — Trip Group Date yang sedang berjalan / akan berlepas
#   2. payment_due     — Booking dengan baki bayaran tertunggak (deadline = departure)
#   3. room_assignment — Reservation yang ready untuk room/cabin assignment
#   4. flight_assignment — Reservation yang ready untuk flight assignment
#   5. pending_orders  — Booking Pending yang perlu follow-up (risiko abandoned)
#   6. passport_links  — Link upload passport guest yang akan/already expired
#   7. documents_pending — Dokumen guest yang belum verified/review
#   8. inquiries       — Travel Inquiry belum di-convert (aging follow-up)
#
# Setiap item dibekalkan dengan `bar_start` / `bar_end` (date) supaya
# frontend boleh melukis bar pada paksi masa tanpa kira-kira sendiri,
# dan `urgency` yang dikira PADA SETIAP PAGE LOAD — itulah makna
# "ongoing today": status relatif kepada hari ini sentiasa segar.
#
# Lihat juga:
# - travel_booking/api/booking_hub.py     (pola role-guard + payment queue)
# - travel_booking/api/manage_trip_booking.py (pola agregat SO custom_booking)

from __future__ import annotations

from datetime import datetime, timedelta

import frappe
from frappe import _
from frappe.utils import nowdate, now_datetime

# ---------------------------------------------------------------------------
# Konfigurasi tingkah laku (cadangan: jadikan field Travel Settings nanti)
# ---------------------------------------------------------------------------
MONITOR_ROLES = ["System Manager", "Tour Manager", "Tour Operator", "Accounts User"]

#: Booking Pending melebihi tempoh ini (hari) dianggap berisiko menjadi
#: abandoned — row akan ditanda critical. Tiada auto-abandon di sini;
#: page ini hanya memantau & memberi isyarat.
PENDING_ORDER_WINDOW_DAYS = 7

#: SLA follow-up inquiry dari website (hari).
INQUIRY_SLA_DAYS = 3

#: Ambang urgensi (hari sebelum deadline).
CRITICAL_DAYS = 3
WARNING_DAYS = 7

#: Berapa hari ke belakang timeline mula dilukis (ruang untuk bar overdue).
DEFAULT_LOOKBACK_DAYS = 7

ACTIVE_BOOKING_STATUSES = ("Accepted", "Processing", "Confirmed", "Pending")
EXCLUDED_BOOKING_STATUSES = ("Completed", "Cancelled", "Abandoned")
# Status reservation yang belum selesai pengesahan dokumen. 'Incomplete'
# menggantikan 'Pending'/'Pending Review' (dihapus dari options — rujuk
# patch v30_traveller_status_incomplete).
PENDING_DOC_STATUSES = ("Incomplete", "Open for Update", "Rejected")

# Status reservation yang belum selesai pengesahan dokumen
_UNRESOLVED_DOC_SQL = "IFNULL(br.document_status,'') IN ('Incomplete','Open for Update')"


def _require_monitor_role() -> None:
	"""Role guard — mirror pola booking_hub._require_booking_manager()."""
	user_roles = frappe.get_roles(frappe.session.user)
	if not any(role in MONITOR_ROLES for role in user_roles):
		frappe.throw(
			_("Anda memerlukan salah satu role: {0}").format(", ".join(MONITOR_ROLES)),
			frappe.PermissionError,
		)


def _d(value) -> str:
	"""Koerce nilai tarikh (date/datetime/str) kepada 'YYYY-MM-DD' atau ''."""
	if not value:
		return ""
	if isinstance(value, datetime):
		return value.date().isoformat()
	s = str(value)
	return s[:10]


def _days_left(deadline: str, today) -> int | None:
	if not deadline:
		return None
	try:
		dl = datetime.strptime(deadline[:10], "%Y-%m-%d").date()
	except ValueError:
		return None
	if isinstance(today, str):
		try:
			today = datetime.strptime(today[:10], "%Y-%m-%d").date()
		except ValueError:
			return None
	return (dl - today).days


def _urgency(days_left: int | None, has_deadline: bool = True) -> str:
	"""overdue | critical | warning | ok | info."""
	if days_left is None:
		return "warning" if has_deadline else "info"
	if days_left < 0:
		return "overdue"
	if days_left <= CRITICAL_DAYS:
		return "critical"
	if days_left <= WARNING_DAYS:
		return "warning"
	return "ok"


def _item(
	group: str,
	doctype: str,
	name: str,
	label: str,
	sublabel: str = "",
	bar_start: str = "",
	bar_end: str = "",
	deadline: str = "",
	meta: str = "",
	amount: float | None = None,
	currency: str = "",
	count: int | None = None,
	total: int | None = None,
	route: str = "",
) -> dict:
	"""Satu row dalam gantt. bar_start/bar_end ialah julat bar pada paksi masa."""
	today = nowdate()
	dl = _days_left(deadline, today)
	# Bar default: [today, deadline] untuk upcoming, [deadline, today] untuk overdue.
	if deadline and not bar_start and not bar_end:
		if (dl or 0) >= 0:
			bar_start, bar_end = today, deadline
		else:
			bar_start, bar_end = deadline, today
	return {
		"group": group,
		"doctype": doctype,
		"name": name,
		"label": label,
		"sublabel": sublabel,
		"bar_start": bar_start,
		"bar_end": bar_end,
		"deadline": deadline,
		"days_left": dl,
		"urgency": _urgency(dl, has_deadline=bool(deadline)),
		"meta": meta,
		"amount": amount,
		"currency": currency,
		"count": count,
		"total": total,
		"route": route,
	}


@frappe.whitelist()
def get_monitor_data(range_days: int = 30, trip: str = "") -> dict:
	"""
	Snapshot "Ongoing Today": semua item sensitif masa, dikelompokkan untuk
	paparan Gantt timeline pada page /app/ongoing-today.

	:param range_days: horizon ke hadapan (14/30/90)
	:param trip: filter ikut Trip (optional)
	"""
	_require_monitor_role()

	today = datetime.strptime(nowdate(), "%Y-%m-%d").date()
	try:
		range_days = max(7, min(int(range_days or 30), 180))
	except (TypeError, ValueError):
		range_days = 30
	horizon = today + timedelta(days=range_days)

	bookings, so_agg, res_agg, currencies = _load_booking_context(trip)
	inquiries = _load_inquiries(trip)
	trip_groups = _load_trip_groups(today, horizon, trip)

	groups = [
		_build_ongoing_trips(trip_groups),
		_build_payment_due(bookings, so_agg, currencies, horizon),
		_build_room_assignment(bookings, res_agg, horizon),
		_build_flight_assignment(bookings, res_agg, horizon),
		_build_pending_orders(bookings, today),
		_build_passport_links(bookings, res_agg, horizon),
		_build_documents_pending(bookings, res_agg, horizon),
		_build_inquiries(inquiries, today),
	]

	# Susun item dalam setiap group: overdue dahulu, kemudian paling dekat deadline.
	for g in groups:
		g["items"].sort(key=lambda it: (it["days_left"] is None, it["days_left"] if it["days_left"] is not None else 9**9))

	kpis = {}
	for g in groups:
		kpis[g["key"]] = {
			"total": len(g["items"]),
			"overdue": sum(1 for it in g["items"] if it["urgency"] == "overdue"),
			"critical": sum(1 for it in g["items"] if it["urgency"] == "critical"),
		}
		g.pop("empty_hint", None)

	# Julat paksi masa: cukup untuk meliputi semua bar + lookback.
	range_start = today - timedelta(days=DEFAULT_LOOKBACK_DAYS)
	range_end = horizon
	for g in groups:
		for it in g["items"]:
			for d in (it.get("bar_start"), it.get("bar_end")):
				if d:
					try:
						dd = datetime.strptime(d, "%Y-%m-%d").date()
						range_start = min(range_start, dd)
						range_end = max(range_end, dd)
					except ValueError:
						continue

	return {
		"today": today.isoformat(),
		"generated_at": now_datetime().strftime("%Y-%m-%d %H:%M:%S"),
		"range": {
			"start": range_start.isoformat(),
			"end": range_end.isoformat(),
			"days": (range_end - range_start).days + 1,
			"horizon_days": range_days,
		},
		"groups": groups,
		"kpis": kpis,
		"trips": _trip_options(),
	}


# ---------------------------------------------------------------------------
# Data loaders
# ---------------------------------------------------------------------------

def _load_booking_context(trip: str):
	"""Booking aktif + agregat SO (kewangan) + agregat reservation (operasi).

	Mengikut pola manage_trip_booking.py: agregat dikumpul dalam 1-2 query
	besar, BUKAN frappe.get_doc per-booking (total_amount/balance_amount
	adalah virtual property yang berat).
	"""
	cond = ""
	params: list = []
	if trip:
		cond = " AND b.trip_name = %s"
		params.append(trip)

	bookings = frappe.db.sql(
		f"""
		SELECT b.name, b.customer, c.customer_name, b.status, b.payment_status,
		       b.departure_date, b.return_date, b.trip_name, b.trip_date,
		       b.is_a_cruise_trip, b.booking_channel, b.booked_by, b.cust_email,
		       b.creation
		FROM `tabBooking` b
		LEFT JOIN `tabCustomer` c ON c.name = b.customer
		WHERE b.status NOT IN ('Completed','Cancelled','Abandoned'){cond}
		""",
		params,
		as_dict=True,
	)
	booking_names = [b.name for b in bookings] or [""]

	# Kewangan per booking (grand_total - advance_paid), SO terserah (docstatus=1).
	so_agg = {
		r.custom_booking: r
		for r in frappe.db.sql(
			"""
			SELECT so.custom_booking,
			       SUM(so.grand_total) AS gross,
			       SUM(so.advance_paid) AS paid,
			       SUM(so.grand_total) - SUM(so.advance_paid) AS balance
			FROM `tabSales Order` so
			WHERE so.docstatus = 1 AND so.custom_booking IS NOT NULL
			GROUP BY so.custom_booking
			""",
			as_dict=True,
		)
	}

	# Currency SO pertama setiap booking (untuk paparan amount).
	currencies: dict[str, str] = {}
	for r in frappe.db.sql(
		"""
		SELECT so.custom_booking, so.currency
		FROM `tabSales Order` so
		WHERE so.docstatus = 1 AND so.custom_booking IS NOT NULL
		ORDER BY so.creation ASC
		""",
		as_dict=True,
	):
		currencies.setdefault(r.custom_booking, r.currency or "MYR")

	# Agregat reservation per booking.
	placeholders = ",".join(["%s"] * len(booking_names))
	res_agg = {
		r.booking: r
		for r in frappe.db.sql(
			f"""
			SELECT br.booking,
			       COUNT(*) AS total_res,
			       SUM(CASE WHEN IFNULL(br.cabin_is_confirmed,0)=0
			                THEN 1 ELSE 0 END) AS rooms_unassigned,
			       SUM(CASE WHEN br.flight_departure_date IS NOT NULL
			                 AND IFNULL(br.flight,'')='' AND IFNULL(br.flight_info_lock,0)=0
			                THEN 1 ELSE 0 END) AS flight_pending,
			       MIN(CASE WHEN br.flight_departure_date IS NOT NULL
			                 AND IFNULL(br.flight,'')='' AND IFNULL(br.flight_info_lock,0)=0
			                THEN br.flight_departure_date END) AS flight_due,
			       SUM(CASE WHEN {_UNRESOLVED_DOC_SQL}
			                THEN 1 ELSE 0 END) AS docs_pending,
			       SUM(CASE WHEN br.passport_link_expires_on IS NOT NULL
			                 AND {_UNRESOLVED_DOC_SQL}
			                THEN 1 ELSE 0 END) AS passport_pending,
			       MIN(CASE WHEN br.passport_link_expires_on IS NOT NULL
			                 AND {_UNRESOLVED_DOC_SQL}
			                THEN DATE(br.passport_link_expires_on) END) AS passport_due
			FROM `tabBooking Reservation` br
			WHERE IFNULL(br.status,'') <> 'Cancelled'
			  AND br.booking IN ({placeholders})
			GROUP BY br.booking
			""",
			booking_names,
			as_dict=True,
		)
	}

	# Koerce Decimal/float hasil SUM() kepada int untuk paparan kiraan.
	for agg in res_agg.values():
		for k in ("total_res", "rooms_unassigned", "flight_pending", "docs_pending", "passport_pending"):
			if agg.get(k) is not None:
				agg[k] = int(agg[k])

	return bookings, so_agg, res_agg, currencies


def _load_inquiries(trip: str):
	cond = ""
	params: list = []
	if trip:
		cond = " AND ti.trip = %s"
		params.append(trip)
	return frappe.db.sql(
		f"""
		SELECT ti.name, ti.prospect_name, ti.phone, ti.status, ti.attandee,
		       ti.trip, ti.creation
		FROM `tabTravel Inquiry` ti
		WHERE ti.status IN ('New','Contacted'){cond}
		ORDER BY ti.creation ASC
		""",
		params,
		as_dict=True,
	)


def _load_trip_groups(today, horizon, trip: str):
	cond = ""
	params: list = [horizon.isoformat(), today.isoformat()]
	if trip:
		cond = " AND tgd.trip = %s"
		params.append(trip)
	return frappe.db.sql(
		f"""
		SELECT tgd.name, tgd.trip_group_name, tgd.trip_name, tgd.trip,
		       tgd.departure_date, tgd.return_date, tgd.status, tgd.ship_name,
		       tgd.max_participants, tgd.current_participants,
		       tgd.is_a_cruise_trip
		FROM `tabTrip Group Date` tgd
		WHERE IFNULL(tgd.status,'') NOT IN ('Cancelled','Completed')
		  AND tgd.departure_date <= %s
		  AND (tgd.return_date IS NULL OR tgd.return_date >= %s){cond}
		ORDER BY tgd.departure_date ASC
		""",
		params,
		as_dict=True,
	)


def _trip_options() -> list:
	return [
		{"name": r.name, "label": r.label or r.name}
		for r in frappe.db.sql(
			"SELECT name, trip_name AS label FROM `tabTrip` ORDER BY modified DESC LIMIT 100",
			as_dict=True,
		)
	]


# ---------------------------------------------------------------------------
# Group builders
# ---------------------------------------------------------------------------

def _build_ongoing_trips(trip_groups) -> dict:
	items = []
	for t in trip_groups:
		dep, ret = _d(t.departure_date), _d(t.return_date) or _d(t.departure_date)
		running = dep <= nowdate() <= ret
		label = t.trip_group_name or t.trip_name or t.name
		if len(label) > 26:
			label = label[:25] + "…"
		pax = f"{t.current_participants or 0}"
		if t.max_participants:
			pax += f"/{t.max_participants}"
		items.append(
			_item(
				group="ongoing_trips",
				doctype="Trip Group Date",
				name=t.name,
				label=label,
				sublabel=t.ship_name or "",
				bar_start=dep,
				bar_end=ret,
				deadline=dep,
				meta=(("RUNNING" if running else "Departs") + f" · {pax} pax · {t.status or ''}").strip(" ·"),
				route=f"trip-group-date/{t.name}",
			)
		)
	return {
		"key": "ongoing_trips",
		"label": "Ongoing & Upcoming Trips",
		"description": "Trip group yang sedang berjalan hari ini atau berlepas dalam horizon semasa.",
		"items": items,
	}


def _build_payment_due(bookings, so_agg, currencies, horizon) -> dict:
	items = []
	for b in bookings:
		fin = so_agg.get(b.name)
		balance = float((fin and fin.balance) or 0)
		if balance <= 0.5:
			continue
		dep = _d(b.departure_date)
		cust = b.customer_name or b.customer or ""
		currency = currencies.get(b.name, "MYR")
		meta_parts = [f"{currency} {balance:,.2f} outstanding", b.payment_status or ""]
		if not dep:
			meta_parts.append("tiada tarikh berlepas")
		items.append(
			_item(
				group="payment_due",
				doctype="Booking",
				name=b.name,
				label=b.name,
				sublabel=f"{cust} · {b.trip_name or ''}".strip(" ·"),
				deadline=dep,
				meta=" · ".join(p for p in meta_parts if p),
				amount=balance,
				currency=currency,
				route=f"booking-hub/{b.name}",
			)
		)
	return {
		"key": "payment_due",
		"label": "Payment Due — Baki Tertunggak",
		"description": "Booking dengan baki bayaran penuh belum dijelaskan. Deadline = tarikh berlepas.",
		"items": items,
	}


def _build_room_assignment(bookings, res_agg, horizon) -> dict:
	items = []
	for b in bookings:
		# Room assignment hanya relevan selepas deposit diterima (bukan Pending).
		if b.status not in ("Accepted", "Processing", "Confirmed"):
			continue
		res = res_agg.get(b.name)
		if not res or not res.rooms_unassigned:
			continue
		dep = _d(b.departure_date)
		cust = b.customer_name or b.customer or ""
		items.append(
			_item(
				group="room_assignment",
				doctype="Booking",
				name=b.name,
				label=b.name,
				sublabel=f"{cust} · {b.trip_name or ''}".strip(" ·"),
				deadline=dep,
				meta=f"{res.rooms_unassigned} dari {res.total_res} bilik/cabin belum di-assign",
				count=res.rooms_unassigned,
				total=res.total_res,
				route=f"booking-hub/{b.name}",
			)
		)
	return {
		"key": "room_assignment",
		"label": "Room / Cabin Assignment",
		"description": "Reservation yang sepatutnya sudah ready untuk room/cabin assignment sebelum berlepas.",
		"items": items,
	}


def _build_flight_assignment(bookings, res_agg, horizon) -> dict:
	items = []
	for b in bookings:
		if b.status not in ("Accepted", "Processing", "Confirmed"):
			continue
		res = res_agg.get(b.name)
		if not res or not res.flight_pending:
			continue
		due = _d(res.flight_due)
		cust = b.customer_name or b.customer or ""
		items.append(
			_item(
				group="flight_assignment",
				doctype="Booking",
				name=b.name,
				label=b.name,
				sublabel=f"{cust} · {b.trip_name or ''}".strip(" ·"),
				deadline=due,
				meta=f"{res.flight_pending} guest menunggu flight assignment",
				count=res.flight_pending,
				total=res.total_res,
				route=f"booking-hub/{b.name}",
			)
		)
	return {
		"key": "flight_assignment",
		"label": "Flight Assignment",
		"description": "Reservation dengan tarikh penerbangan ditetapkan tetapi flight (PNR) belum di-assign.",
		"items": items,
	}


def _build_pending_orders(bookings, today) -> dict:
	items = []
	for b in bookings:
		if b.status != "Pending":
			continue
		created = _d(b.creation)
		try:
			created_d = datetime.strptime(created, "%Y-%m-%d").date() if created else None
		except ValueError:
			created_d = None
		deadline = (created_d + timedelta(days=PENDING_ORDER_WINDOW_DAYS)).isoformat() if created_d else ""
		age = (today - created_d).days if created_d else None
		cust = b.customer_name or b.customer or ""
		meta = []
		if age is not None:
			meta.append(f"created {age} hari lalu")
		if b.booking_channel:
			meta.append(b.booking_channel)
		if not (so_agg_paid(b.name)):
			meta.append("tiada deposit lagi")
		items.append(
			_item(
				group="pending_orders",
				doctype="Booking",
				name=b.name,
				label=b.name,
				sublabel=f"{cust} · {b.trip_name or ''}".strip(" ·"),
				bar_start=created,
				bar_end=deadline or today.isoformat(),
				deadline=deadline,
				meta=" · ".join(meta),
				route=f"booking-hub/{b.name}",
			)
		)
	return {
		"key": "pending_orders",
		"label": "Pending Orders — Follow-up",
		"description": (
			f"Booking masih Pending (belum bayar deposit). Melebihi {PENDING_ORDER_WINDOW_DAYS} hari "
			"tanpa tindakan berisiko menjadi Abandoned."
		),
		"items": items,
	}


def so_agg_paid(booking: str) -> bool:
	"""Ada ketibaan bayaran untuk booking ini (advance_paid > 0)."""
	return bool(
		frappe.db.sql(
			"""
			SELECT so.name FROM `tabSales Order` so
			WHERE so.docstatus = 1 AND so.custom_booking = %s AND so.advance_paid > 0
			LIMIT 1
			""",
			booking,
		)
	)


def _build_passport_links(bookings, res_agg, horizon) -> dict:
	items = []
	for b in bookings:
		if b.status not in ("Accepted", "Processing", "Confirmed"):
			continue
		res = res_agg.get(b.name)
		if not res or not res.passport_pending:
			continue
		due = _d(res.passport_due)
		cust = b.customer_name or b.customer or ""
		items.append(
			_item(
				group="passport_links",
				doctype="Booking",
				name=b.name,
				label=b.name,
				sublabel=f"{cust} · {b.trip_name or ''}".strip(" ·"),
				deadline=due,
				meta=f"{res.passport_pending} guest belum hantar dokumen (link passport)",
				count=res.passport_pending,
				total=res.total_res,
				route=f"booking-hub/{b.name}",
			)
		)
	return {
		"key": "passport_links",
		"label": "Passport Upload Links",
		"description": "Link upload passport guest yang sudah/akan expired sebelum dokumen diserahkan.",
		"items": items,
	}


def _build_documents_pending(bookings, res_agg, horizon) -> dict:
	items = []
	for b in bookings:
		if b.status not in ("Accepted", "Processing", "Confirmed"):
			continue
		res = res_agg.get(b.name)
		if not res or not res.docs_pending:
			continue
		dep = _d(b.departure_date)
		cust = b.customer_name or b.customer or ""
		items.append(
			_item(
				group="documents_pending",
				doctype="Booking",
				name=b.name,
				label=b.name,
				sublabel=f"{cust} · {b.trip_name or ''}".strip(" ·"),
				deadline=dep,
				meta=f"{res.docs_pending}/{res.total_res} dokumen belum verified",
				count=res.docs_pending,
				total=res.total_res,
				route=f"booking-hub/{b.name}",
			)
		)
	return {
		"key": "documents_pending",
		"label": "Documents Pending Review",
		"description": "Dokumen guest (IC/passport) yang masih Pending / Open for Update sebelum berlepas.",
		"items": items,
	}


def _build_inquiries(inquiries, today) -> dict:
	items = []
	for inq in inquiries:
		created = _d(inq.creation)
		try:
			created_d = datetime.strptime(created, "%Y-%m-%d").date() if created else None
		except ValueError:
			created_d = None
		deadline = (created_d + timedelta(days=INQUIRY_SLA_DAYS)).isoformat() if created_d else ""
		age = (today - created_d).days if created_d else None
		meta = []
		if age is not None:
			meta.append(f"{age} hari lalu")
		if inq.attandee:
			meta.append(f"PIC: {inq.attandee}")
		if inq.phone:
			meta.append(inq.phone)
		items.append(
			_item(
				group="inquiries",
				doctype="Travel Inquiry",
				name=inq.name,
				label=inq.prospect_name or inq.name,
				sublabel=inq.name,
				bar_start=created,
				bar_end=deadline or today.isoformat(),
				deadline=deadline,
				meta=" · ".join(meta),
				route=f"travel-inquiry/{inq.name}",
			)
		)
	return {
		"key": "inquiries",
		"label": "Inquiries — Follow-up",
		"description": f"Inquiry dari website yang belum dihubungi/di-convert (SLA {INQUIRY_SLA_DAYS} hari).",
		"items": items,
	}
