"""Patch v52: Package Offer warisi trip + medan salinan ops daripada
Travel Date (Stage 1 pembersihan offer).

Medan baharu Package Offer.trip (Link, readonly) TIDAK diambil terus
daripada mana-mana field lain — nilainya sentiasa Travel Date.trip,
diselesaikan oleh controller validate() pada setiap save. Patch ini
backfill baris sedia ada (offer yang dicipta sebelum medan wujud) dan
sekaligus re-stamp medan salinan (tarikh/sailing/ship/port/schedule)
supaya terbukti konsisten dengan Travel Date — sama seperti yang
sync_to_offers lakukan.

Offer legacy tanpa travel_date (v40) tidak disentuh.

IDEMPOTENT: UPDATE terus tanpa picu hook, update_modified tidak
tersentuh (corak v41/v51).
"""
import frappe


def execute():
	n = frappe.db.sql(
		"""
		SELECT COUNT(*)
		FROM `tabPackage Offer` o
		JOIN `tabTravel Date` td ON td.name = o.travel_date
		"""
	)[0][0]
	frappe.db.sql(
		"""
		UPDATE `tabPackage Offer` o
		JOIN `tabTravel Date` td ON td.name = o.travel_date
		SET o.trip = td.trip,
			o.departure_date = td.departure_date,
			o.return_date = td.return_date,
			o.days_before_closure = td.days_before_closure,
			o.sailing_start = td.sailing_start,
			o.sailing_end = td.sailing_end,
			o.ship_name = td.ship_name,
			o.ship_code = td.ship_code,
			o.embarkation_port = td.embarkation_port,
			o.disembarkation_port = td.disembarkation_port,
			o.cruise_schedule = td.cruise_schedule
		"""
	)
	print(f"v52: {n} Package Offer di-stamp semula daripada Travel Date "
		  f"(termasuk trip)")
