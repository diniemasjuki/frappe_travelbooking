import frappe


def run():
    pr = "ACC-PRQ-2026-00028"
    print("=== PR", pr, "===")
    for x in frappe.db.sql(
        "select name,status,reference_name,grand_total,modified "
        "from `tabPayment Request` where name=%s", pr, as_dict=True):
        print(x)
    print("\n=== ALL PEs referencing this PR (count them!) ===")
    rows = frappe.db.sql(
        "select name,docstatus,status,paid_amount,reference_no,creation "
        "from `tabPayment Entry` where reference_no=%s order by creation",
        (pr,), as_dict=True)
    print("count:", len(rows))
    for x in rows:
        print(x)
    so = frappe.db.get_value("Payment Request", pr, "reference_name")
    print("\nSO:", so, "advance_paid:", frappe.db.get_value("Sales Order", so, "advance_paid") if so else None)
    print("\n=== Error logs for this PR (last 24h) ===")
    for x in frappe.db.sql(
        "select creation,name,method from `tabError Log` "
        "where method like %s and creation > (NOW() - INTERVAL 1 DAY) "
        "order by creation desc limit 8",
        ("%" + pr + "%",), as_dict=True):
        print(str(x["creation"]), "|", x["name"], "|", (x["method"] or "")[:90])
