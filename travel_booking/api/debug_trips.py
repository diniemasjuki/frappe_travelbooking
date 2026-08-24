# Debug endpoint untuk check apa yang dikembalikan oleh get_trips_list
import frappe

@frappe.whitelist()
def debug_trip_names():
	"""
	Return raw trip names dari database untuk diagnosis.
	"""
	try:
		# Query langsung untuk dapatkan nama trips
		trips = frappe.db.sql("""
			SELECT name, trip_name, status
			FROM `tabTrip`
			ORDER BY creation DESC
			LIMIT 5
		""", as_dict=True)

		return {
			'success': True,
			'trip_count': len(trips),
			'trips': trips,
			'note': 'Jika name field mengandungi "Trip Group Date" atau "Trip Package", ada masalah data!'
		}

	except Exception as e:
		return {
			'success': False,
			'error': str(e),
			'trips': []
		}
