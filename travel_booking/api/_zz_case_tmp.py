# SEMENTARA — siasatan kes RYRLMV52611 (padam selepas guna).
import frappe
import json


def run():
	BK = "BK2611010"
	bd = frappe.db.get_value(
		"Booking", BK,
		["pre_discount_total", "price_rule_discount", "voucher_discount",
		 "referral_discount", "payment_due_amount",
		 "trip_package", "trip_date", "status", "payment_status", "creation"],
		as_dict=True)
	print("=== BOOKING ===")
	for k, v in bd.items():
		print(f"  {k}: {v}")

	print("=== APPLIED PRICE RULES ===")
	raw = frappe.db.get_value("Booking", BK, "applied_price_rules")
	print(raw)

	so = frappe.db.get_value("Sales Order", {"custom_booking": BK}, "name")
	print("=== SALES ORDER:", so, "===")
	if so:
		sd = frappe.db.get_value(
			"Sales Order", so,
			["net_total", "discount_amount", "apply_discount_on",
			 "additional_discount_percentage", "grand_total", "transaction_date"],
			as_dict=True)
		for k, v in sd.items():
			print(f"  {k}: {v}")
		items = frappe.get_all("Sales Order Item", filters={"parent": so},
		                       fields=["rate", "qty", "amount"])
		print("  items:", [(i.rate, i.qty, i.amount) for i in items])

	# Bandingkan harga pakej: retail vs promo (pricing map semasa)
	pkg = bd.trip_package
	if pkg:
		rows = frappe.get_all("Trip Package Price", filters={"parent": pkg, "parenttype": "Trip Package"},
		                      fields=["pricing_for_class", "price_adult", "price_adult_single", "price_upperberth"])
		print("=== HARGA PAKEJ SEMASA (", pkg, ") ===")
		for r in rows:
			print(f"  {r.pricing_for_class}: adult={r.price_adult} single={r.price_adult_single} upper={r.price_upperberth}")
