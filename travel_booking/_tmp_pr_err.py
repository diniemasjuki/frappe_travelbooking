import frappe

def run():
    errs = frappe.db.sql("""
        SELECT name, error, creation FROM `tabError Log`
        WHERE title = 'Checkout Back Cancel Error'
        ORDER BY creation DESC LIMIT 2
    """, as_dict=True)
    out = []
    for e in errs:
        out.append({"creation": str(e.creation), "error": (e.error or "")[:600]})
    return out
