# TEMPORARY diagnostic — delete after verification.
import frappe
import os
from frappe.modules import get_module_path, scrub


def run():
	frappe.flags.ignore_permissions = True
	out = []
	def p(*a): out.append(" ".join(str(x) for x in a))

	page = frappe.get_doc("Page", "trip-manager")
	p("page_name:", page.name, "| module:", page.module, "| standard:", page.standard)

	# expected path
	page_name = scrub(page.name)
	module_path = get_module_path(page.module)
	fpath = os.path.join(module_path, "page", page_name, page_name + ".js")
	p("expected js path:", fpath)
	p("file exists:", os.path.exists(fpath))
	if os.path.exists(fpath):
		p("file size:", os.path.getsize(fpath))
		p("readable:", os.access(fpath, os.R_OK))

	# call load_assets
	page.load_assets()
	p("script length after load_assets:", len(page.script or ""))
	p("script starts with:", repr((page.script or "")[:80]))
	return "\n".join(out)
