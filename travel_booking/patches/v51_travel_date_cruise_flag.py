"""Patch v51: Travel Date warisi is_a_cruise_trip daripada Trip.

Medan baharu (Check, fetch_from trip.is_a_cruise_trip, readonly) mengikut
corak trip_group_date/trip_package. Baris Travel Date sedia ada (cipta
patch v48 / API) dicipta sebelum medan wujud — backfill sekali supaya
senarai, penapis standard & payload get_travel_date_detail betul tanpa
menunggu setiap tarikh di-save semula. Controller validate() mengambil
alih selepas ini (self.is_a_cruise_trip disegar semasa setiap save).

IDEMPOTENT: tulis terus db.set_value tanpa picu hook, update_modified=
False (corak v41).
"""
import frappe


def execute():
	rows = frappe.db.sql(
		"""
		SELECT td.name, IF(t.is_a_cruise_trip, 1, 0) AS flag
		FROM `tabTravel Date` td
		INNER JOIN `tabTrip` t ON t.name = td.trip
		WHERE td.is_a_cruise_trip <> IF(t.is_a_cruise_trip, 1, 0)
		""",
		as_dict=True,
	)
	for r in rows:
		frappe.db.set_value(
			"Travel Date", r.name,
			"is_a_cruise_trip", r.flag,
			update_modified=False,
		)
	print(f"v51: {len(rows)} Travel Date is_a_cruise_trip di-backfill")
