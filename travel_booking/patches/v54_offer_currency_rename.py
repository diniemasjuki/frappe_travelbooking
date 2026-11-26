"""Patch v54: Rename kolum Package Offer.offer_currency → currency
(Nov 2026 — penamaan universal untuk tetapan currency, selari medan
child table).

Migrate (sync json) mencipta kolum `currency` baharu yang kosong dan
meninggalkan kolum lama `offer_currency`. Patch ini: (1) salin data
lama → baru, (2) gugurkan kolum lama supaya skema bersih. Idempoten —
selamat diulang.
"""
import frappe


def _has_column(table, column):
	return bool(frappe.db.sql(
		f"SHOW COLUMNS FROM `{table}` LIKE %s", (column,)))


def execute():
	table = "`tabPackage Offer`"

	# 1) Kolum lama ada? (offering yang belum sync / sudah drop)
	if not _has_column("tabPackage Offer", "offer_currency"):
		print("v54: kolum offer_currency tiada — tiada apa-apa untuk dilakukan")
		return

	# 2) Salin data (hanya baris yang currency-nya masih kosong — idempoten)
	copied = frappe.db.sql(
		f"""
		UPDATE {table}
		SET currency = offer_currency
		WHERE (currency IS NULL OR currency = '')
		  AND offer_currency IS NOT NULL AND offer_currency != ''
		"""
	)
	n = frappe.db.sql(
		f"SELECT COUNT(*) FROM {table} WHERE offer_currency IS NOT NULL "
		f"AND offer_currency != ''")[0][0]
	print(f"v54: data offer_currency disalin ke currency "
		  f"({n} baris bernilai)")

	# 3) Gugurkan kolum lama — data sudah selamat di `currency`
	frappe.db.sql_ddl(
		f"ALTER TABLE {table} DROP COLUMN offer_currency")
	print("v54: kolum offer_currency digugurkan")
	frappe.db.commit()
