# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class TravelPackage(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		from travel_booking.module_trip_management.doctype.package_component.package_component import PackageComponent
		from travel_booking.module_trip_management.doctype.variant_axis.variant_axis import VariantAxis
		from travel_booking.module_trip_management.doctype.variant_option.variant_option import VariantOption
		from travel_booking.module_trip_management.doctype.package_price_template.package_price_template import PackagePriceTemplate

		naming_series: DF.Literal["PKG-.YYYY.-.####"]
		package_name: DF.Data
		status: DF.Literal["Draft", "Pending Review", "Active", "Retired"]
		package_template: DF.Literal["", "Cruise + Flight", "Cruise Only", "Fly Package", "Ground Only", "Customed"]
		components: DF.Table[PackageComponent]
		variant_axes: DF.Table[VariantAxis]
		variant_options: DF.Table[VariantOption]
		default_currency: DF.Link | None  # Currency
		price_review_required: DF.Check
		price_template: DF.Table[PackagePriceTemplate]
		trip: DF.Link | None  # Trip
		item: DF.Link | None  # Item
		package_description: DF.TextEditor
	# end: auto-generated types

	_DOCTYPE_NAME = "Travel Package"

	def validate(self):
		self._normalize_axes()
		self._sync_price_keys()
		if not self.public_slug:
			self.public_slug = frappe.generate_hash(length=16)

	def on_update(self):
		# E1: daftar Item sejagat — cipta automatik bila Active
		if self.status == "Active":
			self._ensure_item()

	def _normalize_axes(self):
		"""Paksi: kod slug lowercase, tiada duplikasi; seed paksi age standard."""
		seen = set()
		for ax in self.variant_axes or []:
			ax.axis_code = (ax.axis_code or "").strip().lower().replace(" ", "_")
			if not ax.axis_code:
				frappe.throw("Axis Code diperlukan pada setiap baris Variant Axis.")
			if ax.axis_code in seen:
				frappe.throw(f"Axis '{ax.axis_code}' berulang.")
			seen.add(ax.axis_code)

		if "age" not in seen:
			self.append("variant_axes", {
				"axis_code": "age", "axis_name": "Age Level",
				"nature": "price", "required": 1, "sort_order": 90,
			})
			seen.add("age")

		existing_opts = {(o.axis_code, o.option_code) for o in self.variant_options or []}
		if ("age", "ADULT") not in existing_opts:
			for i, (code, label) in enumerate([('ADULT', 'Adult (12+)'), ('CHILD', 'Child (5-11)'), ('INFANT', 'Infant (0-23mo)'), ('TODDLER', 'Toddler (2-4)')]):
				self.append("variant_options", {
					"axis_code": "age", "option_code": code,
					"option_name": label, "sort_order": i,
				})

	def _sync_price_keys(self):
		"""price_key = opt1|opt2|opt3|AGE — kanonik & boleh query."""
		for row in self.price_template or []:
			parts = [row.opt1, row.opt2, row.opt3, row.age_option]
			row.price_key = "|".join(p for p in parts if p)

	def _ensure_item(self):
		"""E1: Item ERPNext sebagai pendaftar sejagat — create-if-missing."""
		if self.item:
			return
		item_code = "TB-PKG-" + self.name
		try:
			if frappe.db.exists("Item", item_code):
				self.db_set("item", item_code)
				return
			if not frappe.db.exists("Item Group", "Travel Package"):
				frappe.get_doc({"doctype": "Item Group", "item_group_name": "Travel Package",
								"parent_item_group": "All Item Groups", "is_group": 0}).insert(ignore_permissions=True)
			frappe.get_doc({
				"doctype": "Item", "item_code": item_code, "item_name": self.package_name,
				"item_group": "Travel Package", "stock_uom": "Unit",
				"is_stock_item": 0, "is_sales_item": 1,
			}).insert(ignore_permissions=True)
			self.db_set("item", item_code)
		except Exception:
			frappe.log_error(frappe.get_traceback(), "TravelPackage._ensure_item")
