# travel_booking/api/booking_hub.py
# Backend API untuk Booking Operations Hub (/app/booking-hub)
#
# Menyediakan endpoints untuk:
# - Kanban board data (grouped by status)
# - Booking detail dengan reservations, payments, addons
# - Cabin grid arrangement
# - Payment summary & queue
# - Addon orders & catalog
#
# UI Consolidation: Membaca dari doctypes sedia ada tanpa schema changes.
# Semua writes melalui API patterns sedia ada.

import frappe
from frappe import _
import json
from datetime import datetime, timedelta
from dateutil.relativedelta import relativedelta


def get_booking_status_filters():
	"""Return valid booking statuses for kanban columns"""
	return ['Pending', 'Accepted', 'Processing', 'Confirmed', 'Completed', 'Abandoned']


@frappe.whitelist()
def get_booking_kanban(status: str = None, trip: str = None, date_from: str = None, date_to: str = None, search: str = None) -> dict:
	"""
	Return booking data grouped by status untuk Kanban Board.
	
	Returns:
		dict: {
			columns: { status: [booking_dict, ...] },
			counts: { queue: int, active: int }
		}
	"""
	filters = []
	
	# Status filter
	if status and status != 'All Statuses':
		filters.append(['status', '=', status])
	
	# Trip filter
	if trip:
		filters.append(['trip_name', '=', trip])
	
	# Date range filter (based on departure_date / trip_date)
	if date_from:
		filters.append(['trip_date', '>=', date_from])
	if date_to:
		filters.append(['trip_date', '<=', date_to])
	
	# Search filter (search across multiple fields)
	if search:
		search_filter = [
			['OR',
				['name', 'like', '%' + search + '%'],
				['customer', 'like', '%' + search + '%'],
				['trip_name', 'like', '%' + search + '%'],
			]
		]
		filters.append(search_filter)
	
	# Only fetch non-cancelled bookings for kanban
	filters.append(['status', '!=', 'Cancelled'])
	
	try:
		# Query minimal fields yang pasti wujud dalam apa-apa doctype
		bookings = frappe.get_all(
			'Booking',
			fields=['name', 'customer', 'status', 'creation', 'modified'],
			filters=filters,
			order_by='creation desc',
			limit=100,
		)

		# Enrich setiap booking dengan get_doc untuk dapatkan semua fields dengan selamat
		result = []
		for b in bookings:
			try:
				booking_doc = frappe.get_doc('Booking', b.name)

				# Fetch customer name
				customer_name = ''
				if booking_doc.customer:
					try:
						customer_name = frappe.get_value('Customer', booking_doc.customer, 'customer_name') or booking_doc.customer
					except:
						customer_name = booking_doc.customer

				b_dict = {
					'name': booking_doc.name,
					'customer': booking_doc.customer or '',
					'customer_name': customer_name,
					'cust_email': getattr(booking_doc, 'cust_email', '') or '',
					'trip_name': getattr(booking_doc, 'trip_name', '') or '',
					'trip_package': getattr(booking_doc, 'trip_package', '') or '',
					'departure_date': str(getattr(booking_doc, 'departure_date', None) or ''),
					'return_date': str(getattr(booking_doc, 'return_date', None) or ''),
					'status': booking_doc.status or 'Pending',
					'payment_status': getattr(booking_doc, 'payment_status', 'Pending') or 'Pending',
					'total_amount': getattr(booking_doc, 'total_amount', 0) or 0,
					'prog_payment': getattr(booking_doc, 'prog_payment', 0) or 0,
					'total_pax': getattr(booking_doc, 'total_pax', 0) or 0,
					'booked_pax': getattr(booking_doc, 'booked_pax', 0) or 0,
					'creation': str(booking_doc.creation) if booking_doc.creation else '',
				}
				result.append(b_dict)
			except Exception as doc_error:
				# Skip booking yang tak boleh dibaca, tapi teruskan yang lain
				frappe.log_error(frappe.get_traceback(), f'Booking Hub: Failed to load {b.name}')
				continue

		bookings = result  # Replace dengan enriched data (already complete dicts)
	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'Booking Hub Kanban Error')
		return {'columns': {}, 'counts': {}}

	# Group by status for kanban
	statuses = get_booking_status_filters()
	columns = {s: [] for s in statuses}
	counts = {'queue': 0, 'active': 0}

	for b in bookings:
		# Data already enriched - just group into columns
		booking_status = b.get('status', 'Pending')

		# Add to appropriate column
		if booking_status in columns:
			columns[booking_status].append(b)

		# Count queue items (pending payment + partially paid)
		if b.get('payment_status') in ('Pending', 'Partially Paid'):
			counts['queue'] += 1

		# Count active items (not completed/cancelled)
		if b.get('status') not in ('Completed', 'Cancelled'):
			counts['active'] += 1
	
	return {
		'columns': columns,
		'counts': counts,
	}


@frappe.whitelist()
def get_booking_list(search: str = None, status: str = None, limit: int = 50) -> dict:
	"""
	Return list of bookings untuk Active Bookings tab.
	Supports pagination and filtering.
	"""
	filters = []
	
	if status and status != 'All Statuses':
		filters.append(['status', '=', status])
	
	if search:
		search_filter = [
			['OR',
				['name', 'like', '%' + search + '%'],
				['customer', 'like', '%' + search + '%'],
				['trip_name', 'like', '%' + search + '%'],
			]
		]
		filters.append(search_filter)

	try:
		# Query minimal fields dahulu
		raw_bookings = frappe.get_all(
			'Booking',
			fields=['name', 'status', 'creation'],
			filters=filters,
			order_by='creation desc',
			limit=limit,
		)

		# Enrich dengan get_doc untuk dapatkan semua fields dengan selamat
		bookings = []
		for b in raw_bookings:
			try:
				doc = frappe.get_doc('Booking', b.name)

				customer_name = ''
				if doc.customer:
					try:
						customer_name = frappe.get_value('Customer', doc.customer, 'customer_name') or doc.customer
					except:
						customer_name = doc.customer

				bookings.append({
					'name': doc.name,
					'customer': doc.customer or '',
					'customer_name': customer_name,
					'cust_email': getattr(doc, 'cust_email', '') or '',
					'trip_name': getattr(doc, 'trip_name', '') or '',
					'trip_package': getattr(doc, 'trip_package', '') or '',
					'trip_date': str(getattr(doc, 'trip_date', None) or ''),
					'departure_date': str(getattr(doc, 'departure_date', None) or ''),
					'return_date': str(getattr(doc, 'return_date', None) or ''),
					'status': doc.status or 'Pending',
					'payment_status': getattr(doc, 'payment_status', 'Pending') or 'Pending',
					'total_amount': getattr(doc, 'total_amount', 0) or 0,
					'prog_payment': getattr(doc, 'prog_payment', 0) or 0,
					'total_pax': getattr(doc, 'total_pax', 0) or 0,
					'booked_pax': getattr(doc, 'booked_pax', 0) or 0,
					'is_a_cruise_trip': getattr(doc, 'is_a_cruise_trip', False) or False,
					'is_cruise_only': getattr(doc, 'is_cruise_only', False) or False,
					'creation': str(doc.creation) if doc.creation else '',
				})
			except Exception as doc_err:
				frappe.log_error(frappe.get_traceback(), f'Booking Hub List: Failed to load {b.name}')
				continue

		return {'bookings': bookings}

	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'Booking Hub List Error')
		return {'bookings': []}


@frappe.whitelist()
def get_booking_detail(booking_name: str) -> dict:
	"""
	Return complete booking detail dengan semua related data.
	Used by Active Bookings detail panel.
	"""
	if not booking_name:
		frappe.throw(_('Booking name is required'))

	try:
		booking = frappe.get_doc('Booking', booking_name)
	except Exception as e:
		frappe.throw(_('Booking {0} not found').format(booking_name))

	# Build base booking dict - AT FUNCTION LEVEL (no extra indent!)
	customer_name = ''
	if booking.customer:
		try:
			customer_name = frappe.get_value('Customer', booking.customer, 'customer_name') or booking.customer
		except:
			customer_name = booking.customer

	b_data = {
		'booking': {
			'name': booking.name,
			'customer': booking.customer or '',
			'customer_name': customer_name,
			'cust_email': getattr(booking, 'cust_email', '') or '',
			'trip_name': getattr(booking, 'trip_name', '') or '',
			'package_name': getattr(booking, 'trip_package', '') or '',
			'trip_date': str(getattr(booking, 'trip_date', None) or ''),
			'departure_date': str(getattr(booking, 'departure_date', None) or ''),
			'return_date': str(getattr(booking, 'return_date', None) or ''),
			'status': booking.status,
			'payment_status': getattr(booking, 'payment_status', 'Pending') or 'Pending',
			'total_amount': getattr(booking, 'total_amount', 0) or 0,
			'prog_payment': getattr(booking, 'prog_payment', 0) or 0,
			'total_pax': getattr(booking, 'total_pax', 0) or 0,
			'booked_pax': getattr(booking, 'booked_pax', 0) or 0,
			'is_a_cruise_trip': getattr(booking, 'is_a_cruise_trip', False),
			'is_cruise_only': getattr(booking, 'is_cruise_only', False),
			'creation': str(booking.creation) if booking.creation else '',
		},
		'reservations': [],
		'payments': [],
		'travellers': [],
		'addon_orders': [],
		'logs': [],
	}

	# Get reservations (Booking Reservation child table) - SAFE APPROACH
	raw_reservations = frappe.get_all(
		'Booking Reservation',
		fields=['name', 'traveller'],
		filters={'booking': booking_name},
		order_by='creation'
	)

	for res in raw_reservations:
		try:
			res_doc = frappe.get_doc('Booking Reservation', res.name)

			# Get traveller details if linked
			traveller_info = {}
			if res_doc.traveller:
				try:
					traveller_doc = frappe.get_doc('Traveller', res_doc.traveller)
					traveller_info = {
						'email': getattr(traveller_doc, 'email', '') or '',
						'phone': getattr(traveller_doc, 'phone', '') or '',
						'ic_number': getattr(traveller_doc, 'ic_number', '') or '',
						'passport_no': getattr(traveller_doc, 'passport_no', '') or '',
					}
				except:
					pass

			b_data['reservations'].append({
				'name': res_doc.name,
				'traveller': res_doc.traveller or '',
				'traveller_name': '',
				'room_category': getattr(res_doc, 'room_category', '') or '',
				'cabin_no': getattr(res_doc, 'cabin_no', '') or '',
				'stateroom_no': getattr(res_doc, 'stateroom_no', '') or '',
				'aroya_guest_no': getattr(res_doc, 'aroya_guest_no', '') or '',
				'pax_type': getattr(res_doc, 'pax_type', '') or '',
				'document_status': getattr(res_doc, 'document_status', 'Pending Review') or 'Pending Review',
				**traveller_info,
			})
		except Exception as res_err:
			frappe.log_error(frappe.get_traceback(), f'Booking Hub: Failed to load reservation {res.name}')
			continue

	# Get payments from linked Sales Orders
	payments = get_booking_payments(booking_name)
	b_data['payments'] = payments

	# Get unique travellers from reservations
	traveller_set = set()
	for res in b_data['reservations']:
		if res['traveller'] and res['traveller'] not in traveller_set:
			traveller_set.add(res['traveller'])

			# Find reservation with this traveller to get cabin info
			cabins_for_traveller = [r for r in b_data['reservations'] if r['traveller'] == res['traveller']]
			first_cabin = cabins_for_traveller[0] if cabins_for_traveller else {}

			b_data['travellers'].append({
				'traveller': res['traveller'],
				'traveller_name': res['traveller_name'],
				'email': res.get('email', ''),
				'phone': res.get('phone', ''),
				'ic_number': res.get('ic_number', ''),
				'passport_no': res.get('passport_no', ''),
				'room_category': first_cabin.get('room_category', ''),
				'cabin_no': first_cabin.get('cabin_no', ''),
				'document_status': first_cabin.get('document_status', 'Pending Review'),
			})

	# Get addon orders
	addon_orders = frappe.get_all(
		'Booking Addon Order',
		fields=['name', 'booking', 'customer', 'total_amount', 'status', 'creation'],
		filters={'booking': booking_name},
		order_by='creation desc'
	)

	for ao in addon_orders:
		# Get addon line items
		addon_items = frappe.get_all(
			'Booking Addon',
			fields=['name', 'addon', 'addon_title', 'qty', 'unit_price', 'amount', 'status'],
			filters={'addon_order': ao.name}
		)

		for item in addon_items:
			b_data['addon_orders'].append({
				'name': item.name,
				'booking_name': ao.name,
				'addon': item.addon,
				'addon_title': item.addon_title,
				'qty': item.qty,
				'unit_price': item.unit_price or 0,
				'amount': item.amount or 0,
				'status': item.status or 'Active',
			})

	# Get activity logs (if available via Email Log or custom log)
	logs = get_activity_logs(booking_name)
	b_data['logs'] = logs

	return b_data


def get_booking_payments(booking_name: str) -> list:
	"""
	Get payment history dengan mencari Sales Orders & Payment Entries.
	Uses indirect linking via customer + amount + date since no direct booking_name field exists.
	"""
	payments = []

	try:
		# Get booking info for matching
		booking = frappe.get_doc('Booking', booking_name)
		customer = booking.customer
		booking_total = getattr(booking, 'total_amount', 0) or 0
		booking_date = booking.creation

		# Find Sales Orders by customer + amount + date range (indirect link)
		sales_orders = frappe.get_all(
			'Sales Order',
			fields=['name', 'grand_total', 'status', 'delivery_date', 'creation'],
			filters={
				'customer': customer,
				'docstatus': 1,
				'grand_total': booking_total,
				'creation': ['>=', booking_date.strftime('%Y-%m-%d') if hasattr(booking_date, 'strftime') else booking_date],
			},
			order_by='creation desc',
			limit=5
		)

		for so in sales_orders:
			# Try multiple possible field names for PE reference
			pe_found = False

			# Method 1: Standard ERPNext reference fields
			try:
				pe_list = frappe.get_all(
					'Payment Entry',
					fields=['name', 'paid_amount', 'mode_of_payment', 'reference_no', 'status', 'creation'],
					filters={
						'party_type': 'Customer',
						'party': customer,
						'payment_type': 'Receive',
						'docstatus': 1,
					},
					order_by='creation desc',
					limit=10
				)

				# Filter PEs by matching amount and close date to SO creation
				for pe in pe_list:
					# Match if payment amount matches SO total and date is close
					if pe.paid_amount and abs(float(pe.paid_amount) - float(so.grand_total or 0)) < 0.01:
						payments.append({
							'date': str(pe.creation)[:10] if pe.creation else '',
							'payment_type': _('Payment'),
							'mode_of_payment': getattr(pe, 'mode_of_payment', '') or '',
							'amount': float(pe.paid_amount or 0),
							'reference': getattr(pe, 'reference_no', '') or pe.name,
							'status': 'Paid',
						})
						pe_found = True
						break  # One match per SO is enough
			except Exception as pe_err:
				pass

			# If no Payment Entry found, show SO as pending invoice
			if not pe_found and so.status not in ('Completed', 'Cancelled'):
				payments.append({
					'date': str(so.creation)[:10] if so.creation else (str(so.delivery_date)[:10] if so.delivery_date else ''),
					'payment_type': _('Invoice'),
					'mode_of_payment': '',
					'amount': float(so.grand_total or 0),
					'reference': so.name,
					'status': 'Pending',
				})

		# If NO Sales Orders found at all, show booking as pending
		if not payments and booking_total > 0:
			payments.append({
				'date': str(booking_date)[:10] if booking_date else '',
				'payment_type': _('Booking'),
				'mode_of_payment': '',
				'amount': float(booking_total),
				'reference': booking_name,
				'status': getattr(booking, 'payment_status', 'Pending') or 'Pending',
			})

	except Exception as e:
		frappe.log_error(frappe.get_traceback(), f'Payment Fetch Error for {booking_name}')
		# Return minimal payment info from booking itself
		try:
			booking = frappe.get_doc('Booking', booking_name)
			payments.append({
				'date': str(booking.creation)[:10] if booking.creation else '',
				'payment_type': _('Booking'),
				'mode_of_payment': '',
				'amount': float(getattr(booking, 'total_amount', 0) or 0),
				'reference': booking_name,
				'status': getattr(booking, 'payment_status', 'Unknown') or 'Unknown',
			})
		except:
			pass

	return payments


def get_activity_logs(booking_name: str) -> list:
	"""
	Get activity logs untuk timeline view.
	Can be from Email Log, Version history, or custom Activity Log.
	"""
	logs = []
	
	try:
		# Try to get from Version (document changes)
		versions = frappe.get_all(
			'Version',
			fields=['creation', 'owner', 'data'],
			filters={
				'ref_doctype': 'Booking',
				'docname': booking_name,
			},
			order_by='creation desc',
			limit=20
		)
		
		for v in versions:
			try:
				data = json.loads(v.data) if isinstance(v.data, str) else v.data
				changed_fields = list(data.keys()) if data else []
				if changed_fields:
					logs.append({
						'action': _('Updated'),
						'message': _('{0} fields updated').format(len(changed_fields)),
						'user': v.owner,
						'creation': str(v.creation),
					})
			except:
				pass
				
	except Exception as e:
		pass
	
	# If no version logs, add creation log
	if not logs:
		try:
			booking = frappe.get_doc('Booking', booking_name)
			logs.append({
				'action': _('Created'),
				'message': _('Booking created'),
				'user': booking.owner,
				'creation': str(booking.creation),
			})
		except:
			pass
	
	return logs[:15]  # Limit to last 15 entries


@frappe.whitelist()
def get_cabin_grid(booking_name: str) -> dict:
	"""
	Return cabin arrangement data untuk Cabin Grid tab.
	Groups reservations by cabin number.
	"""
	if not booking_name:
		frappe.throw(_('Booking name is required'))

	try:
		booking = frappe.get_doc('Booking', booking_name)
	except Exception as e:
		frappe.throw(_('Booking {0} not found').format(booking_name))

	# Get all reservations - SAFE APPROACH (basic fields only!)
	raw_reservations = frappe.get_all(
		'Booking Reservation',
		fields=['name', 'traveller'],  # BASIC ONLY - avoid schema drift
		filters={'booking': booking_name},
		order_by='creation'
	)

	# Enrich with full doc to get optional fields safely
	reservations = []
	for raw in raw_reservations:
		try:
			res_doc = frappe.get_doc('Booking Reservation', raw.name)
			reservations.append(res_doc)  # Use doc object for safe getattr access
		except:
			continue

	# Group by cabin
	cabins = {}
	for res_doc in reservations:
		cabin_key = getattr(res_doc, 'cabin_no', None) or 'Unassigned'

		if cabin_key not in cabins:
			# Get room category capacity info
			capacity = 4  # default
			category_name = ''
			room_cat = getattr(res_doc, 'room_category', None)
			if room_cat:
				try:
					cat = frappe.get_doc('Trip Price Category', room_cat)
					capacity = getattr(cat, 'capacity', None) or 4
					category_name = getattr(cat, 'category_name', '') or ''
				except:
					pass

			cabins[cabin_key] = {
				'cabin_no': cabin_key,
				'room_category': category_name or str(room_cat or ''),
				'capacity': capacity,
				'stateroom_no': getattr(res_doc, 'stateroom_no', '') or '',
				'travellers': [],
			}

		traveller_name_val = ''
		if res_doc.traveller:
			try:
				traveller_name_val = frappe.get_value('Traveller', res_doc.traveller, 'full_name') or ''
			except:
				pass

		cabins[cabin_key]['travellers'].append({
			'reservation_name': res_doc.name,
			'traveller': res_doc.traveller or '',
			'traveller_name': traveller_name_val,
			'pax_type': getattr(res_doc, 'pax_type', '') or '',
			'document_status': getattr(res_doc, 'document_status', None) or 'Pending Review',
			'status': getattr(res_doc, 'status', '') or '',
		})

	# Convert to sorted list
	cabin_list = sorted(cabins.values(), key=lambda x: x['cabin_no'])

	return {
		'booking': {
			'name': booking.name,
			'trip_name': getattr(booking, 'trip_name', '') or '',
			'ship_name': getattr(booking, 'ship_name', '') or '',
		},
		'cabins': cabin_list,
		'total_cabins': len(cabin_list),
		'total_travellers': sum(len(c['travellers']) for c in cabin_list),
	}


@frappe.whitelist()
def update_cabin_assignment(reservation_name: str, stateroom_no: str = None, aroya_guest_no: str = None) -> dict:
	"""
	Update stateroom assignment untuk a Booking Reservation.
	"""
	if not reservation_name:
		frappe.throw(_('Reservation name is required'))
	
	try:
		res = frappe.get_doc('Booking Reservation', reservation_name)
		
		if stateroom_no is not None:
			res.stateroom_no = stateroom_no
		
		if aroya_guest_no is not None:
			res.aroya_guest_no = aroya_guest_no
		
		res.save(ignore_permissions=True)
		frappe.db.commit()
		
		return {
			'success': True,
			'message': _('Stateroom updated successfully'),
			'reservation': reservation_name,
		}
		
	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'Cabin Assignment Error')
		frappe.throw(_('Failed to update stateroom: {0}').format(str(e)))


@frappe.whitelist()
def bulk_assign_staterooms(booking_name: str, file_url: str = None, assignments: str = None) -> dict:
	"""
	Bulk assign staterooms dari CSV upload atau manual input.
	
	Args:
		booking_name: Name of the Booking document
		file_url: URL of uploaded CSV file (optional)
		assignments: JSON string of assignments [{reservation_name, stateroom_no, aroya_guest_no}]
	"""
	if not booking_name:
		frappe.throw(_('Booking name is required'))
	
	updated_count = 0
	errors = []
	
	try:
		if file_url:
			# Parse CSV file
			import csv
			import os
			
			file_path = frappe.get_site_path('public', file_url.lstrip('/'))
			
			if not os.path.exists(file_path):
				frappe.throw(_('File not found'))
			
			with open(file_path, 'r') as f:
				reader = csv.DictReader(f)
				for row in reader:
					try:
						res_name = row.get('reservation_name') or row.get('Reservation')
						stateroom = row.get('stateroom_no') or row.get('Stateroom')
						aroya = row.get('aroya_guest_no') or row.get('Aroya Guest No')
						
						if res_name and stateroom:
							res = frappe.get_doc('Booking Reservation', res_name)
							if res.booking == booking_name:
								res.stateroom_no = stateroom
								if aroya:
									res.aroya_guest_no = aroya
								res.save(ignore_permissions=True)
								updated_count += 1
					except Exception as e:
						errors.append(f'{res_name}: {str(e)}')
						
		elif assignments:
			# Parse JSON assignments
			if isinstance(assignments, str):
				assignments = json.loads(assignments)
			
			for assign in assignments:
				try:
					res = frappe.get_doc('Booking Reservation', assign['reservation_name'])
					if res.booking == booking_name:
						if 'stateroom_no' in assign:
							res.stateroom_no = assign['stateroom_no']
						if 'aroya_guest_no' in assign:
							res.aroya_guest_no = assign['aroya_guest_no']
						res.save(ignore_permissions=True)
						updated_count += 1
				except Exception as e:
					errors.append(f"{assign.get('reservation_name', '?')}: {str(e)}")
		
		frappe.db.commit()
		
		return {
			'success': True,
			'updated_count': updated_count,
			'errors': errors,
			'message': _('{0} stateroom(s) assigned successfully').format(updated_count),
		}
		
	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'Bulk Stateroom Assignment Error')
		frappe.throw(_('Failed to process bulk assignment: {0}').format(str(e)))


@frappe.whitelist()
def get_payment_summary(date_range: str = None) -> dict:
	"""
	Return payment summary statistics untuk Payment Dashboard.
	"""
	today = datetime.now().date()
	month_start = today.replace(day=1)
	
	try:
		# This month's revenue (paid amounts from Payment Entries) - SAFE APPROACH
		raw_payments = frappe.get_all(
			'Payment Entry',
			fields=['name'],
			filters={
				'docstatus': 1,
				'payment_type': 'Receive',
				'creation': ['between', [month_start, today]],
			},
			limit=1000,
		)

		month_revenue = 0
		for p in raw_payments:
			try:
				doc = frappe.get_doc('Payment Entry', p.name)
				paid = getattr(doc, 'paid_amount', 0) or 0
				month_revenue += paid
			except:
				continue

		# Pending bookings - use safe approach with get_doc
		raw_pending = frappe.get_all(
			'Booking',
			fields=['name'],
			filters={
				'status': ['not in', ['Completed', 'Cancelled']],
			},
			limit=1000,  # Get all to calculate totals
		)

		pending_total = 0
		pending_count = 0
		for p in raw_pending:
			try:
				doc = frappe.get_doc('Booking', p.name)
				amount = getattr(doc, 'total_amount', 0) or 0
				if amount > 0:
					pending_total += amount
					pending_count += 1
			except:
				continue

		# Overdue bookings
		raw_overdue = frappe.get_all(
			'Booking',
			fields=['name'],
			filters={
				'status': ['not in', ['Completed', 'Cancelled']],
			},
			limit=1000,
		)

		overdue_total = 0
		overdue_count = 0
		for o in raw_overdue:
			try:
				doc = frappe.get_doc('Booking', o.name)
				amount = getattr(doc, 'total_amount', 0) or 0
				departure = getattr(doc, 'departure_date', None)
				if amount > 0 and departure:
					try:
						due = departure.date() if hasattr(departure, 'date') else departure
						if due < today:
							overdue_total += amount
							overdue_count += 1
					except:
						pass
			except:
				continue

	# Pending refunds (Sales Invoice) - SAFE APPROACH
		raw_refunds = frappe.get_all(
			'Sales Invoice',
			fields=['name'],
			filters={
				'status': 'Return',
				'docstatus': 1,
				'due_date': ['>', (today - timedelta(days=90))],
			},
			limit=1000,
		)

		refund_total = 0
		for r in raw_refunds:
			try:
				doc = frappe.get_doc('Sales Invoice', r.name)
				refund_total += getattr(doc, 'grand_total', 0) or 0
			except:
				continue

		return {
			'month_revenue': month_revenue,
			'pending_total': pending_total,
			'pending_count': pending_count,
			'overdue_total': overdue_total,
			'overdue_count': overdue_count,
			'refund_total': refund_total,
		}
		
	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'Payment Summary Error')
		return {
			'month_revenue': 0,
			'pending_total': 0,
			'pending_count': 0,
			'overdue_total': 0,
			'overdue_count': 0,
			'refund_total': 0,
		}


@frappe.whitelist()
def get_payment_queue(limit: int = 20) -> list:
	"""
	Return list of bookings dengan outstanding payments, sorted by urgency.
	"""
	today = datetime.now().date()
	
	try:
		# Safe approach: Query basic fields only, then enrich with get_doc
		raw_queue = frappe.get_all(
			'Booking',
			fields=['name', 'status'],
			filters={
				'status': ['not in', ['Completed', 'Cancelled']],
			},
			order_by='creation desc',
			limit=limit,
		)

		# Enrich each booking with full details
		result = []
		for q in raw_queue:
			try:
				doc = frappe.get_doc('Booking', q.name)

				# Fetch customer name
				customer_name = ''
				if doc.customer:
					try:
						customer_name = frappe.get_value('Customer', doc.customer, 'customer_name') or doc.customer
					except:
						customer_name = doc.customer

				# Calculate days overdue
				days_overdue = 0
				departure = getattr(doc, 'departure_date', None)
				if departure:
					try:
						due = departure.date() if hasattr(departure, 'date') else departure
						days_overdue = (due - today).days
					except:
						pass

				item = {
					'booking_name': doc.name,
					'customer': doc.customer or '',
					'customer_name': customer_name,
					'due_date': str(departure) if departure else '',
					'amount_due': getattr(doc, 'total_amount', 0) or 0,
					'payment_status': getattr(doc, 'payment_status', 'Pending') or 'Pending',
					'status': doc.status,
					'days_overdue': days_overdue,
				}
				result.append(item)
			except Exception as doc_err:
				frappe.log_error(frappe.get_traceback(), f'Payment Queue: Failed to load {q.name}')
				continue

		return result
		
	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'Payment Queue Error')
		return []


@frappe.whitelist()
def send_payment_reminder(booking_name: str) -> dict:
	"""
	Send payment reminder email/SMS untuk a booking.
	Uses existing email service infrastructure.
	"""
	if not booking_name:
		frappe.throw(_('Booking name is required'))
	
	try:
		booking = frappe.get_doc('Booking', booking_name)
		customer_email = booking.cust_email

		if not customer_email:
			frappe.throw(_('No email address found for this booking'))

		# Fetch customer name
		customer_display = 'Valued Customer'
		if booking.customer:
			try:
				customer_display = frappe.get_value('Customer', booking.customer, 'customer_name') or booking.customer
			except:
				customer_display = booking.customer

		# Send email using Frappe's email queue
		subject = _('Payment Reminder - Booking {0}').format(booking_name)
		message = """
		<p>Dear {customer},</p>
		<p>This is a friendly reminder regarding your booking <strong>{booking}</strong> for <strong>{trip}</strong>.</p>
		<p><strong>Payment Summary:</strong></p>
		<ul>
			<li>Total Amount: {total}</li>
			<li>Amount Paid: {paid}</li>
			<li>Outstanding Balance: {balance}</li>
		</ul>
		<p>Please settle your outstanding balance at your earliest convenience.</p>
		<p>If you have already made payment, please disregard this reminder.</p>
		<p>Thank you for choosing us!</p>
		""".format(
			customer=customer_display,
			booking=booking_name,
			trip=booking.trip_name or 'Your Trip',
			total=format_currency(booking.total_amount),
			paid='See booking details',
			balance='See booking details',
		)
		
		from frappe.core.doctype.communication.email import make
		# Create communication record
		frappe.get_doc({
			'doctype': 'Communication',
			'subject': subject,
			'content': message,
			'sending_user': frappe.session.user,
			'communication_medium': 'Email',
			'sent_or_received': 'Sent',
			'recipient': customer_email,
			'reference_doctype': 'Booking',
			'reference_name': booking_name,
			'status': 'Linked',
		}).insert(ignore_permissions=True)
		
		# Queue the email
		from frappe.email.queue import send
		send(recipients=[customer_email], subject=subject, message=message, reference_doctype='Booking', reference_name=booking_name)
		
		return {
			'success': True,
			'message': _('Payment reminder sent successfully'),
		}
		
	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'Send Reminder Error')
		frappe.throw(_('Failed to send payment reminder: {0}').format(str(e)))


@frappe.whitelist()
def generate_pay_link(booking_name: str) -> str:
	"""
	Generate Stripe checkout payment link untuk a booking.
	"""
	if not booking_name:
		frappe.throw(_('Booking name is required'))
	
	try:
		booking = frappe.get_doc('Booking', booking_name)

		# Check if there's an existing session or create new one
		# This would integrate with stripe_checkout.py logic
		from travel_booking.api.stripe_checkout import create_checkout_session

		session_url = create_checkout_session(
			booking_name=booking_name,
			amount=booking.total_amount,
			email=booking.cust_email,
		)

		return session_url

	except ImportError:
		# Fallback: return booking page URL
		return f'/checkout?booking={booking_name}'
	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'Generate Pay Link Error')
		frappe.throw(_('Failed to generate payment link: {0}').format(str(e)))


@frappe.whitelist()
def update_booking_status(booking_name: str, new_status: str, reason: str = None) -> dict:
	"""
	Update booking status dengan audit trail.
	"""
	if not booking_name:
		frappe.throw(_('Booking name is required'))
	
	valid_statuses = ['Pending', 'Accepted', 'Processing', 'Confirmed', 'Completed', 'Cancelled']
	if new_status not in valid_statuses:
		frappe.throw(_('Invalid status. Must be one of: {0}').format(', '.join(valid_statuses)))
	
	try:
		booking = frappe.get_doc('Booking', booking_name)
		old_status = booking.status
		
		booking.status = new_status
		booking.save(ignore_permissions=True)
		frappe.db.commit()
		
		# Log the status change
		frappe.get_doc({
			'doctype': 'Communication',
			'subject': _('Status Changed: {0} → {1}').format(old_status, new_status),
			'content': reason or _('Status updated by {0}').format(frappe.session.user),
			'sending_user': frappe.session.user,
			'communication_medium': 'Other',
			'sent_or_received': 'Sent',
			'reference_doctype': 'Booking',
			'reference_name': booking_name,
			'status': 'Linked',
		}).insert(ignore_permissions=True)
		
		return {
			'success': True,
			'message': _('Booking status updated to {0}').format(new_status),
			'old_status': old_status,
			'new_status': new_status,
		}
		
	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'Update Status Error')
		frappe.throw(_('Failed to update booking status: {0}').format(str(e)))


@frappe.whitelist()
def get_linked_sales_order(booking_name: str) -> str:
	"""
	Get primary Sales Order name yang linked kepada booking ini.
	"""
	if not booking_name:
		return None
	
	try:
		so = frappe.db.get_value(
			'Sales Order',
			{'custom_booking': booking_name},
			['name', 'status', 'grand_total'],
			as_dict=True,
			order_by='creation asc'
		)
		return so.name if so else None
	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'Get Linked SO Error')
		return None


@frappe.whitelist()
def get_addon_orders(limit: int = 30, booking: str = None) -> list:
	"""
	Return list of addon orders.
	"""
	filters = {}
	if booking:
		filters['booking'] = booking
	
	try:
		orders = frappe.get_all(
			'Booking Addon Order',
			fields=['name', 'booking', 'customer', 'total_amount', 'status', 'creation'],
			filters=filters,
			order_by='creation desc',
			limit=limit,
		)
		
		result = []
		for order in orders:
			# Get booking customer name
			customer_name = ''
			if order.booking:
				# First get customer ID from booking
				customer_id = frappe.db.get_value('Booking', order.booking, 'customer')
				if customer_id:
					customer_name = frappe.get_value('Customer', customer_id, 'customer_name') or customer_id

			# Get addon items
			items = frappe.get_all(
				'Booking Addon',
				fields=['name', 'addon', 'addon_title', 'qty', 'unit_price', 'amount'],
				filters={'addon_order': order.name}
			)

			for item in items:
				result.append({
					'name': item.name,
					'booking_name': order.booking,
					'customer_name': customer_name,
					'addon': item.addon,
					'addon_title': item.addon_title,
					'qty': item.qty,
					'unit_price': item.unit_price or 0,
					'amount': item.amount or 0,
					'status': order.status or 'Active',
				})

		return result
		
	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'Get Addon Orders Error')
		return []


@frappe.whitelist()
def get_addon_catalog(trip: str = None) -> list:
	"""
	Return available addons catalog.
	Optional filter by trip.
	"""
	filters = {'disable': 0}
	
	try:
		addons = frappe.get_all(
			'Addon',
			fields=[
				'name', 'addon_title', 'addon_type', 'description',
				'base_price', 'currency', 'scope', 'disable'
			],
			filters=filters,
			order_by='addon_type, addon_title'
		)
		
		return addons
		
	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'Get Addon Catalog Error')
		return []


@frappe.whitelist()
def create_addon_order(booking_name: str, addon_items: str) -> dict:
	"""
	Create new addon order untuk a booking.
	
	Args:
		booking_name: Name of the Booking document
		addon_items: List of [{addon: name, qty: number}]
	"""
	if not booking_name:
		frappe.throw(_('Booking name is required'))
	
	if not addon_items:
		frappe.throw(_('Addon items are required'))
	
	try:
		import json
		if isinstance(addon_items, str):
			addon_items = json.loads(addon_items)
		
		booking = frappe.get_doc('Booking', booking_name)
		
		# Create Addon Order header
		addon_order = frappe.get_doc({
			'doctype': 'Booking Addon Order',
			'booking': booking_name,
			'customer': booking.customer,
			'trip_package': booking.trip_package,
			'trip_date': booking.trip_date,
		})
		
		total_amount = 0
		
		for item in addon_items:
			addon_name = item.get('addon')
			qty = item.get('qty', 1)
			
			if not addon_name:
				continue
			
			# Get addon details
			addon = frappe.get_doc('Addon', addon_name)
			
			unit_price = addon.base_price or 0
			amount = unit_price * qty
			total_amount += amount
			
			# Add line item
			addon_order.append('addons', {
				'addon': addon_name,
				'addon_package': '',  # Can be extended later
				'addon_title': addon.addon_title,
				'qty': qty,
				'unit_price': unit_price,
				'amount': amount,
			})
		
		addon_order.total_amount = total_amount
		addon_order.insert(ignore_permissions=True)
		addon_order.submit()
		frappe.db.commit()
		
		return {
			'success': True,
			'message': _('Addon order created successfully'),
			'order_name': addon_order.name,
			'total_amount': total_amount,
		}
		
	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'Create Addon Order Error')
		frappe.throw(_('Failed to create addon order: {0}').format(str(e)))


@frappe.whitelist()
def get_trip_list() -> list:
	"""
	Return list of active trips untuk filter dropdown.
	"""
	try:
		trips = frappe.get_all(
			'Trip',
			fields=['name', 'trip_name', 'published', 'is_a_cruise_trip'],
			filters={'published': 1},
			order_by='trip_name',
			limit=100,
		)
		return trips
	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'Get Trip List Error')
		return []


# ========== UTILITY FUNCTIONS ==========

def format_currency(amount: float, currency: str = None) -> str:
	"""Format amount sebagai currency string."""
	if currency:
		return f"{currency} {float(amount or 0):,.2f}"
	return f"RM{float(amount or 0):,.2f}"  # Default to RM


def check_permission(doctype: str, docname: str, permission_type: str = 'read') -> None:
	"""Check user permission untuk document."""
	if not frappe.has_permission(doctype, permission_type, docname):
		frappe.throw(_('Not permitted to access {0} {1}').format(doctype, docname))
