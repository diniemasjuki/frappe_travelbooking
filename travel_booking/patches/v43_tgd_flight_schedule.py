"""Restrukturasi ownership (TGD = perkhidmatan fizikal, pakej = komposisi)
— patch v43.

DUA perubahan:

1. Field Trip Group Date.flight_schedule (Link → Flight Schedule) +
   flight_schedule_title (Data, fetch schedule_code) — pasangan simetri
   dengan cruise_schedule sedia ada. Setiap TGD kini memegang KEDUA-DUA
   perkhidmatan fizikal per-tarikh: cruise + set penerbangan (PNR).
   Tiada enforcement wajib — TGD cruise-only biarkan kosong.

2. BACKOUT BOM Cruise Segment/Flight — komponen tersebut ialah properti
   TGD (per-tarikh), BUKAN properti pakej; menyimpannya pada pakej
   menduplikasi data dan hanya "betul" untuk TGD pertama pakej (pakej
   span banyak TGD). Padam SEMUA baris Trip Package Component dengan
   component_type Cruise Segment/Flight (hasil backfill v42 — data
   duplikat; schedule kekal wujud pada TGD, TIADA maklumat hilang).
   Schema options dibersihkan dalam fail doctype (migrate sync).

Idempoten — selamat dijalankan berulang.
"""

import frappe



def execute():
	# ── 1. Field flight_schedule pada Trip Group Date ──────────────────
	# TIDAK dicipta di sini — schema JSON doctype (owner app) membawa
	# kedua-dua field (flight_schedule + flight_schedule_title) dan
	# disegerakkan oleh migrate model sync. Patch hanya mengesahkan.
	if not frappe.get_meta("Trip Group Date").has_field("flight_schedule"):
		frappe.throw(
			"Trip Group Date.flight_schedule missing — check doctype sync."
		)

	# ── 2. Backout BOM Cruise Segment / Flight ─────────────────────────
	# Padam baris duplikat (data kekal pada TGD). Report sebelum/selepas
	# untuk jejak audit.
	rows = frappe.db.get_all("Trip Package Component",
		filters={"component_type": ["in", ["Cruise Segment", "Flight"]]},
		pluck="name")
	frappe.db.delete("Trip Package Component",
		{"component_type": ["in", ["Cruise Segment", "Flight"]]})
	frappe.db.commit()

	remaining = frappe.db.count("Trip Package Component")
	print("[v43] Backout BOM: {0} baris Cruise Segment/Flight dipadam "
	      "(data kekal pada TGD). BOM tinggal {1} baris (merch/activity).".format(
	          len(rows), remaining))
