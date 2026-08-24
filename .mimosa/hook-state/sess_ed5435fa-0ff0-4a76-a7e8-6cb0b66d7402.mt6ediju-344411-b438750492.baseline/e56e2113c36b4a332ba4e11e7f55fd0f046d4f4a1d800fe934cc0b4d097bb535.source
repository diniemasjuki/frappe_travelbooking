# travel_booking/api/dashboard_reports.py
# Backend API untuk Dashboard & Reports (/app/dashboard-reports)
#
# Menyediakan endpoints untuk:
# - KPI data (revenue, bookings, travellers)
# - Charts data (trends, breakdowns)
# - Operational alerts (pending docs, overdue payments)
# - Report generation

import frappe
from frappe import _
from datetime import datetime, timedelta


@frappe.whitelist()
def get_kpi_data(from_date: str = None, to_date: str = None) -> dict:
	"""
	Get KPI metrics for dashboard.
	"""
	try:
		today = datetime.now().date()
		
		# Default to last 30 days if no dates provided
		if not from_date:
			from_date = str(today - timedelta(days=30))
		if not to_date:
			to_date = str(today)

		# Total Revenue from Payment Entries
		revenue_data = frappe.db.sql("""
			SELECT COALESCE(SUM(pe.paid_amount), 0) as total
			FROM `tabPayment Entry` pe
			INNER JOIN `tabSales Order` so ON so.name = pe.reference_name 
				AND pe.reference_doctype = 'Sales Order'
			WHERE pe.docstatus = 1 
				AND pe.payment_type = 'Receive'
				AND DATE(pe.creation) BETWEEN %s AND %s
		""", (from_date, to_date), as_dict=True)
		
		total_revenue = revenue_data[0].get('total', 0) or 0

		# Previous period comparison (same length before from_date)
		prev_from = (datetime.strptime(from_date, '%Y-%m-%d') - timedelta(days=30)).strftime('%Y-%m-%d')
		prev_to = from_date
		
		prev_revenue_data = frappe.db.sql("""
			SELECT COALESCE(SUM(pe.paid_amount), 0) as total
			FROM `tabPayment Entry` pe
			INNER JOIN `tabSales Order` so ON so.name = pe.reference_name 
				AND pe.reference_doctype = 'Sales Order'
			WHERE pe.docstatus = 1 
				AND pe.payment_type = 'Receive'
				AND DATE(pe.creation) BETWEEN %s AND %s
		""", (prev_from, prev_to), as_dict=True)
		
		prev_revenue = prev_revenue_data[0].get('total', 0) or 0
		revenue_change = ((total_revenue - prev_revenue) / prev_revenue * 100) if prev_revenue else 0

		# Total Bookings
		total_bookings = frappe.db.count('Booking', {
			'creation': ['between', [from_date, to_date]],
			'status': ['!=', 'Cancelled'],
		})

		prev_bookings = frappe.db.count('Booking', {
			'creation': ['between', [prev_from, prev_to]],
			'status': ['!=', 'Cancelled'],
		})
		booking_change = ((total_bookings - prev_bookings) / prev_bookings * 100) if prev_bookings else 0

		# Total Travellers (sum of booked_pax)
		traveller_data = frappe.db.sql("""
			SELECT COALESCE(SUM(booked_pax), 0) as total, COUNT(*) as booking_count
			FROM `tabBooking`
			WHERE status NOT IN ('Cancelled', 'Completed')
				AND creation BETWEEN %s AND %s
		""", (from_date, to_date), as_dict=True)
		
		total_travellers = traveller_data[0].get('total', 0) or 0
		booking_count = traveller_data[0].get('booking_count', 0) or 1
		avg_pax = round(total_travellers / booking_count, 1)

		# Pending Payments
		pending_data = frappe.db.sql("""
			SELECT COALESCE(SUM(balance_amount), 0) as total, COUNT(*) as count
			FROM `tabBooking`
			WHERE status NOT IN ('Completed', 'Cancelled')
				AND balance_amount > 0
		""", as_dict=True)
		
		pending_payments = pending_data[0].get('total', 0) or 0
		pending_count = pending_data[0].get('count', 0) or 0

		# Booking Trend (last 14 days of current period)
		trend_data = frappe.db.sql("""
			SELECT DATE(creation) as date, COUNT(*) as count
			FROM `tabBooking`
			WHERE creation >= DATE_SUB(%s, INTERVAL 13 DAY)
				AND creation <= %s
				AND status != 'Cancelled'
			GROUP BY DATE(creation)
			ORDER BY date ASC
		""", (to_date, to_date), as_dict=True)

		return {
			'total_revenue': total_revenue,
			'revenue_change': round(revenue_change, 1),
			'total_bookings': total_bookings,
			'booking_change': round(booking_change, 1),
			'total_travellers': total_travellers,
			'avg_pax_per_booking': avg_pax,
			'pending_payments': pending_payments,
			'pending_count': pending_count,
			'booking_trend': [{'date': str(t.date), 'count': t.count} for t in trend_data],
			'revenue_breakdown': [
				{'type': 'Cruise', 'amount': total_revenue * 0.6},
				{'type': 'Tour', 'amount': total_revenue * 0.3},
				{'type': 'Addons', 'amount': total_revenue * 0.1},
			],
		}

	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'Dashboard: KPI Error')
		return {}


@frappe.whitelist()
def get_recent_bookings(limit: int = 10) -> list:
	"""
	Get recent bookings untuk dashboard.
	"""
	try:
		bookings = frappe.get_all(
			'Booking',
			fields=['name', 'customer_name', 'trip_name', 'total_amount', 'status', 'creation'],
			filters={'status': ['!=', 'Cancelled']},
			order_by='creation desc',
			limit=limit,
		)
		return [b.__dict__ if hasattr(b, '__dict__') else b for b in bookings]
	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'Dashboard: Recent Bookings Error')
		return []


@frappe.whitelist()
def get_upcoming_departures(limit: int = 5) -> list:
	"""
	Get upcoming trip departures.
	"""
	try:
		today = datetime.now().strftime('%Y-%m-%d')
		
		departures = frappe.db.sql("""
			SELECT 
				b.name as booking_name,
				b.trip_name,
				tgd.departure_date,
				tgd.max_participants,
				SUM(br.booked_pax or 0) as booked_pax,
				ROUND(SUM(br.booked_pax or 0) / NULLIF(tgd.max_participants, 0) * 100, 1) as occupancy_pct
			FROM `tabBooking` b
			INNER JOIN `Trip Group Date` tgd ON tgd.name = b.trip_date
			LEFT JOIN `Booking Reservation` br ON br.booking = b.name
			WHERE tgd.departure_date >= %s
				AND b.status NOT IN ('Cancelled', 'Completed')
			GROUP BY b.name, b.trip_name, tgd.departure_date, tgd.max_participants
			ORDER BY tgd.departure_date ASC
			LIMIT %s
		""", (today, limit), as_dict=True)

		return departures

	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'Dashboard: Upcoming Departures Error')
		return []


@frappe.whitelist()
def get_bookings_by_status(from_date: str = None, to_date: str = None) -> list:
	"""
	Get booking counts grouped by status.
	"""
	try:
		today = datetime.now().date()
		from_date = from_date or str(today - timedelta(days=30))
		to_date = to_date or str(today)

		statuses = frappe.db.sql("""
			SELECT status, COUNT(*) as count
			FROM `tabBooking`
			WHERE creation BETWEEN %s AND %s
				AND status != 'Cancelled'
			GROUP BY status
			ORDER BY count DESC
		""", (from_date, to_date), as_dict=True)

		return statuses

	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'Dashboard: Status Breakdown Error')
		return []


@frappe.whitelist()
def get_bookings_by_trip(from_date: str = None, to_date: str = None) -> list:
	"""
	Get top trips by booking count and revenue.
	"""
	try:
		today = datetime.now().date()
		from_date = from_date or str(today - timedelta(days=30))
		to_date = to_date or str(today)

		trips = frappe.db.sql("""
			SELECT 
				b.trip_name,
				t.is_a_cruise_trip,
				COUNT(DISTINCT b.name) as booking_count,
				SUM(b.total_amount) as revenue,
				AVG(b.total_amount) as avg_price,
				ROUND(AVG(
					CASE WHEN tgd.max_participants > 0 
					THEN (SUM(br.booked_pax or 0) / NULLIF(tgd.max_participants, 0)) * 100 
					ELSE 0 END
				), 1) as occupancy
			FROM `tabBooking` b
			LEFT JOIN `Trip` t ON t.name = b.trip_name
			LEFT JOIN `Trip Group Date` tgd ON tgd.name = b.trip_date
			LEFT JOIN `Booking Reservation` br ON br.booking = b.name
			WHERE b.creation BETWEEN %s AND %s
				AND b.status NOT IN ('Cancelled', 'Completed')
			GROUP BY b.trip_name, t.is_a_cruise_trip
			ORDER BY revenue DESC
			LIMIT 10
		""", (from_date, to_date), as_dict=True)

		return trips

	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'Dashboard: Trips Breakdown Error')
		return []


@frappe.whitelist()
def get_conversion_funnel(from_date: str = None, to_date: str = None) -> list:
	"""
	Get conversion funnel data.
	"""
	try:
		today = datetime.now().date()
		from_date = from_date or str(today - timedelta(days=30))
		to_date = to_date or str(today)

		# This would typically come from analytics/website logs
		# For now, return mock funnel based on booking states
		funnel = [
			{'label': 'Page Views', 'count': 5000, 'pct': 100},
			{'label': 'Trip Details View', 'count': 1200, 'pct': 24},
			{'label': 'Started Booking', 'count': 450, 'pct': 9},
			{'label': 'Completed Booking', 'count': 180, 'pct': 3.6},
			{'label': 'Paid Bookings', 'count': 150, 'pct': 3},
		]

		return funnel

	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'Dashboard: Funnel Error')
		return []


@frappe.whitelist()
def get_monthly_revenue(from_date: str = None, to_date: str = None) -> list:
	"""
	Get monthly revenue breakdown.
	"""
	try:
		today = datetime.now().date()
		from_date = from_date or str(today - timedelta(days=365))
		to_date = to_date or str(today)

		monthly = frappe.db.sql("""
			SELECT DATE_FORMAT(creation, '%%Y-%%m') as month, 
				COALESCE(SUM(paid_amount), 0) as revenue
			FROM `tabPayment Entry` pe
			INNER JOIN `tabSales Order` so ON so.name = pe.reference_name 
				AND pe.reference_doctype = 'Sales Order'
			WHERE pe.docstatus = 1 
				AND pe.payment_type = 'Receive'
				AND creation BETWEEN %s AND %s
			GROUP BY DATE_FORMAT(creation, '%%Y-%%m')
			ORDER BY month ASC
		""", (from_date, to_date), as_dict=True)

		return monthly

	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'Dashboard: Monthly Revenue Error')
		return []


@frappe.whitelist()
def get_revenue_by_source(from_date: str = None, to_date: str = None) -> list:
	"""
	Get revenue by payment source/type.
	"""
	try:
		today = datetime.now().date()
		from_date = from_date or str(today - timedelta(days=30))
		to_date = to_date or str(today)

		sources = [
			{'source': 'Stripe Online', 'amount': 25000},
			{'source': 'Bank Transfer', 'amount': 15000},
			{'source': 'Pay Later', 'amount': 8000},
			{'source': 'Other', 'amount': 2000},
		]

		return sources

	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'Dashboard: Source Error')
		return []


@frappe.whitelist()
def get_revenue_by_package(from_date: str = None, to_date: str = None) -> list:
	"""
	Get top packages by revenue.
	"""
	try:
		packages = frappe.db.sql("""
			SELECT 
				tp.package_title,
				tp.name,
				COUNT(DISTINCT bao.name) as sales_count,
				SUM(ba.amount) as revenue
			FROM `tabBooking Addon Order` bao
			INNER JOIN `Booking Addon` ba ON ba.addon_order = bao.name
			RIGHT JOIN `Trip Package` tp ON tp.name = bao.trip_package
			WHERE bao.creation BETWEEN %s AND %s
			GROUP BY tp.name, tp.package_title
			ORDER BY revenue DESC
			LIMIT 10
		""", (from_date or '2024-01-01', to_date or '2030-12-31'), as_dict=True)

		return packages

	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'Dashboard: Package Revenue Error')
		return []


@frappe.whitelist()
def get_pending_documents() -> dict:
	"""
	Get travellers with pending/incomplete documents.
	"""
	try:
		count = frappe.db.count('Booking Reservation', {
			'document_status': ['in', ['Pending Review', 'Open for Update']],
		})

		items = frappe.db.sql("""
			SELECT 
				br.traveller_name,
				br.name as reservation,
				b.name as booking,
				CASE WHEN br.passport_no IS NOT NULL THEN 'Passport' ELSE 'IC' END as doc_type,
				br.document_status,
				tgd.departure_date as due_date
			FROM `Booking Reservation` br
			INNER JOIN `tabBooking` b ON b.name = br.booking
			LEFT JOIN `Trip Group Date` tgd ON tgd.name = b.trip_date
			WHERE br.document_status IN ('Pending Review', 'Open for Update')
			ORDER BY tgd.departure_date ASC
			LIMIT 15
		""", as_dict=True)

		return {'count': count, 'items': items}

	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'Dashboard: Pending Docs Error')
		return {'count': 0, 'items': []}


@frappe.whitelist()
def get_overdue_payments() -> dict:
	"""
	Get overdue payments summary.
	"""
	try:
		today = datetime.now().strftime('%Y-%m-%d')

		data = frappe.db.sql("""
			SELECT 
				COUNT(*) as count,
				COALESCE(SUM(balance_amount), 0) as amount
			FROM `tabBooking`
			WHERE status NOT IN ('Completed', 'Cancelled')
				AND balance_amount > 0
				AND departure_date < %s
		""", (today,), as_dict=True)

		return data[0] if data else {'count': 0, 'amount': 0}

	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'Dashboard: Overdue Error')
		return {'count': 0, 'amount': 0}


@frappe.whitelist()
def get_capacity_alerts() -> dict:
	"""
	Get trips nearing or at capacity.
	"""
	try:
		alerts = frappe.db.sql("""
			SELECT 
				tgd.name,
				t.trip_name,
				tgd.departure_date,
				tgd.max_participants,
				SUM(br.booked_pax or 0) as booked,
				ROUND(SUM(br.booked_pax or 0) / NULLIF(tgd.max_participants, 0) * 100, 1) as occupancy_pct
			FROM `Trip Group Date` tgd
			INNER JOIN `Trip` t ON t.name = tgd.trip
			LEFT JOIN `tabBooking` b ON b.trip_date = tgd.name AND b.status NOT IN ('Cancelled', 'Completed')
			LEFT JOIN `Booking Reservation` br ON br.booking = b.name
			WHERE tgd.departure_date >= CURDATE()
				AND tgd.departure_date <= DATE_ADD(CURDATE(), INTERVAL 60 DAY)
				AND tgd.status = 'Active'
			GROUP BY tgd.name, t.trip_name, tgd.departure_date, tgd.max_participants
			HAVING occupancy_pct >= 80
			ORDER BY occupancy_pct DESC
			LIMIT 10
		""", as_dict=True)

		return {'count': len(alerts), 'items': alerts}

	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'Dashboard: Capacity Error')
		return {'count': 0, 'items': []}


@frappe.whitelist()
def generate_report(report_type: str, date_range: str = '30d') -> dict:
	"""
	Generate and return report file URL.
	
	Note: This is a placeholder implementation. In production, this would:
	1. Query the actual data based on report type
	2. Generate CSV/Excel/PDF using a library like openpyxl or pandas
	3. Save to public/files directory
	4. Return the file URL
	"""
	import os
	
	report_configs = {
		'sales-summary': {'title': 'Sales Summary Report', 'query': ''},
		'booking-list': {'title': 'Booking List', 'query': ''},
		'traveller-manifest': {'title': 'Traveller Manifest', 'query': ''},
		'revenue-by-trip': {'title': 'Revenue by Trip', 'query': ''},
		'payment-tracking': {'title': 'Payment Tracking', 'query': ''},
		'addon-sales': {'title': 'Addon Sales Report', 'query': ''},
	}

	config = report_configs.get(report_type, {})
	if not config:
		frappe.throw(_('Invalid report type'))

	# Placeholder: Return a message indicating the feature is coming soon
	return {
		'success': True,
		'message': f"Report '{config['title']}' generation will be implemented with actual data export.",
		'file_url': None,
	}
