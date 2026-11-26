"""Product Elements Restructure — patch v42: BACKFILL BOM Cruise Segment.

Pindah maklumat sedia ada ke dalam komposisi pakej (Trip Package
Component) — bahagian yang BETUL-BETUL boleh diterbitkan daripada data
semasa tanpa rekaan:

  Cruise Segment / Included — untuk setiap Trip Package aktif cruise
  yang TIADA baris Cruise Segment: cruise_schedule diambil daripada
  Trip Group Date pertama pautannya (select_group_by_date →
  Trip Group Date.cruise_schedule). TGD fly-cruise yang merujuk
  schedule owner lain turut dipakai — cruise_schedule TGD itu tetap
  schedule pelayaran sebenar pakej tersebut.

PERLINDUNGAN DATA:
- INSERT-ONLY + idempoten: pakej yang sudah ada baris Cruise Segment
  dilangkau sepenuhnya (termasuk baris lama yang tidak sah — bukan
  scope patch untuk padam tanpa pengesahan admin).
- Tiada field Trip Package lama diubah; tiada re-trigger validate()
  penuh (insert child row terus — corak v2_seed_addon_rates).
- Komponen Flight sengaja TIDAK di-backfill — tiada rekod Flight (PNR)
  sebenar lagi; baris akan diisi admin bila PNR wujud (jangan cipta
  data rekaan).

Ringkasan dilaporkan dalam patch log (pakej berjaya / dilangkau).
"""

import frappe


def execute():
	backfilled = 0
	skipped_no_tgd = 0
	skipped_no_schedule = 0
	skipped_existing = 0

	# Semua pakej cruise aktif (melalui trip_link → Trip.is_a_cruise_trip).
	pkgs = frappe.db.sql("""
		SELECT tp.name
		FROM `tabTrip Package` tp
		JOIN `tabTrip` t ON t.name = tp.trip_link
		WHERE tp.status = 'Active'
		  AND IFNULL(t.is_a_cruise_trip, 0) = 1
		ORDER BY tp.name
	""", as_dict=True)

	for row in pkgs:
		pkg = row.name

		# Idempoten: pakej yang sudah ada baris Cruise Segment dilangkau.
		existing = frappe.db.sql("""
			SELECT COUNT(*) FROM `tabTrip Package Component`
			WHERE parent = %s AND parenttype = 'Trip Package'
			  AND component_type = 'Cruise Segment'
		""", pkg)[0][0]
		if existing:
			skipped_existing += 1
			continue

		# TGD pertama pautan pakej (creation order) → cruise_schedule.
		tgd_schedule = frappe.db.sql("""
			SELECT tgd.cruise_schedule
			FROM `tabTrip Package Group Date Select` sel
			JOIN `tabTrip Group Date` tgd ON tgd.name = sel.trip_group_date
			WHERE sel.parent = %s AND sel.parenttype = 'Trip Package'
			ORDER BY tgd.departure_date ASC
			LIMIT 1
		""", pkg)
		if not tgd_schedule:
			skipped_no_tgd += 1
			continue
		schedule = tgd_schedule[0][0] if tgd_schedule and tgd_schedule[0] else None
		if not schedule:
			skipped_no_schedule += 1
			continue

		# Insert child row terus (elak re-trigger validate penuh pakej).
		frappe.get_doc({
			"doctype":        "Trip Package Component",
			"parent":         pkg,
			"parenttype":     "Trip Package",
			"parentfield":    "components",
			"component_type": "Cruise Segment",
			"inclusion_mode": "Included",
			"cruise_schedule": schedule,
		}).insert(ignore_permissions=True)
		backfilled += 1

	frappe.db.commit()
	print("[v42] Backfill Cruise Segment BOM: {0} backfilled, "
	      "{1} skipped (sudah ada), {2} skipped (tiada TGD), "
	      "{3} skipped (TGD tanpa cruise_schedule)".format(
	          backfilled, skipped_existing, skipped_no_tgd, skipped_no_schedule))
