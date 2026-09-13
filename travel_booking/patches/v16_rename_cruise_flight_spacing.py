import frappe


def execute():
	# Tukar nilai package_type "Cruise+Flight" → "Cruise + Flight" (rephrase
	# label dengan spacing sekitar "+"; kod dalaman "FC" kekal). Meliputi:
	#   1. Trip Package.package_type (punca / enum sebenar)
	#   2. Salinan fetch_from pada Booking & Booking Reservation
	#   3. package_title tersimpan yang embed jenis ("{trip} : Cruise+Flight :
	#      {airport}" atau gaya manual cth "3N Yanbu Cruise / Cruise+Flight / KUL")
	#   4. trip_group_name TGD lama dengan suffix " : Cruise+Flight"
	for table in ("tabTrip Package", "tabBooking", "tabBooking Reservation"):
		frappe.db.sql(
			f"""UPDATE `{table}`
				SET package_type = 'Cruise + Flight'
				WHERE package_type = 'Cruise+Flight'"""
		)

	frappe.db.sql(
		"""UPDATE `tabTrip Package`
			SET package_title = REPLACE(package_title, 'Cruise+Flight', 'Cruise + Flight')
			WHERE package_title LIKE '%%Cruise+Flight%%'"""
	)

	frappe.db.sql(
		"""UPDATE `tabTrip Group Date`
			SET trip_group_name = REPLACE(trip_group_name, 'Cruise+Flight', 'Cruise + Flight')
			WHERE trip_group_name LIKE '%%Cruise+Flight%%'"""
	)
