import frappe


def execute():
	# Tukar nilai package_type "Fly Cruise" → "Cruise+Flight" (rename label
	# package type; kod dalaman "FC" kekal). Meliputi:
	#   1. Trip Package.package_type (punca / enum sebenar)
	#   2. Salinan fetch_from pada Booking & Booking Reservation
	#   3. package_title tersimpan yang embed jenis ("{trip} : Fly Cruise : {airport}")
	#   4. trip_group_name TGD lama dengan suffix " : Fly Cruise"
	#      (naming TGD guna naming series, jadi name tak terjejas)
	for table in ("tabTrip Package", "tabBooking", "tabBooking Reservation"):
		frappe.db.sql(
			f"""UPDATE `{table}`
				SET package_type = 'Cruise+Flight'
				WHERE package_type = 'Fly Cruise'"""
		)

	frappe.db.sql(
		"""UPDATE `tabTrip Package`
			SET package_title = REPLACE(package_title, ' : Fly Cruise :', ' : Cruise+Flight :')
			WHERE package_title LIKE '%% : Fly Cruise : %%'"""
	)

	frappe.db.sql(
		"""UPDATE `tabTrip Group Date`
			SET trip_group_name = REPLACE(trip_group_name, ' : Fly Cruise', ' : Cruise+Flight')
			WHERE trip_group_name LIKE '%% : Fly Cruise'"""
	)
