# Diagnostic script untuk check data connectivity
# Run via: bench --site dev.rpwp.my execute travel_booking.api.diagnose_trip_data.check_data

import frappe

@frappe.whitelist()
def check_data():
	"""
	Check jika Trip, Trip Group Date, dan Trip Package ada data dan connect.
	"""
	result = {
		'trips': [],
		'connectivity': {
			'trip_with_dates': 0,
			'trip_with_packages': 0,
			'total_dates': 0,
			'total_packages': 0
		},
		'sample_data': {}
	}

	try:
		# 1. Dapatkan semua trips
		trips = frappe.get_all('Trip', fields=['name', 'trip_name', 'status'], limit=10)
		result['trips'] = trips

		for trip in trips:
			trip_name = trip.name

			# Check dates untuk trip ini
			dates = frappe.get_all('Trip Group Date',
				fields=['name', 'departure_date', 'status'],
				filters={'trip': trip_name},
				limit=5
			)

			if dates:
				result['connectivity']['trip_with_dates'] += 1
				result['connectivity']['total_dates'] += len(dates)

				if 'sample_dates' not in result['sample_data']:
					result['sample_data']['dates'] = dates

			# Check packages untuk trip ini
			packages = frappe.get_all('Trip Package',
				fields=['name', 'package_title', 'status'],
				filters={'trip_link': trip_name},
				limit=5
			)

			if packages:
				result['connectivity']['trip_with_packages'] += 1
				result['connectivity']['total_packages'] += len(packages)

				if 'sample_packages' not in result['sample_data']:
					result['sample_data']['packages'] = packages

	except Exception as e:
		result['error'] = str(e)
		frappe.log_error(frappe.get_traceback(), 'TripCmd: Diagnose Error')

	return result
