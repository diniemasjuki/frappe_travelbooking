import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


def execute():
	"""Fasa A: pautan provenance lead→quote→booking pada Quotation (ERPNext
	native — Quotation dijadikan dokumen sebut harga cruise, TIADA doctype
	baharu; corak sama seperti Sales Order.custom_booking).

	- custom_travel_package / custom_package_offer: produk struktur baharu
	  yang di-quote — membolehkan laporan konversi quote→booking per offer.
	- custom_travel_inquiry: pautan balik ke lead (Travel Inquiry) supaya
	  status inquiry boleh ditukar 'Converted' bila quote menemui booking.

	Idempoten: create_custom_fields sudah skip field sedia ada."""
	create_custom_fields({
		"Quotation": [
			dict(
				fieldname="travel_booking_section",
				label="Travel Booking",
				fieldtype="Section Break",
				insert_after="items_section",
				collapsible=1,
			),
			dict(
				fieldname="custom_travel_package",
				label="Travel Package",
				fieldtype="Link",
				options="Travel Package",
				insert_after="travel_booking_section",
				description="Pakej struktur baharu yang di-quote (Fasa A).",
			),
			dict(
				fieldname="custom_package_offer",
				label="Package Offer",
				fieldtype="Link",
				options="Package Offer",
				insert_after="custom_travel_package",
				description="Offer (departure) yang di-quote — kosong untuk quote generic.",
			),
			dict(
				fieldname="custom_travel_inquiry",
				label="Travel Inquiry (Lead)",
				fieldtype="Link",
				options="Travel Inquiry",
				insert_after="custom_package_offer",
				description="Lead asal quote ini — untuk laporan konversi inquiry→quote→booking.",
			),
		],
	})
