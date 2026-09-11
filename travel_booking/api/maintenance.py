# travel_booking/api/maintenance.py
#
# Utility maintenance untuk admin (System Manager sahaja) — sokongan
# operasi model multi-currency/multi-company "paksi currency" (Travel
# Settings > Multi Currency Account: currency -> company + price list +
# payment accounts):
#
#   multi_currency_health_check()   — diagnostic READ-SAHJA: konsistensi
#     paksi currency (currency <-> Company.default_currency <-> Price
#     List currency), konfigurasi payment accounts per-currency, dan
#     SO luar-axis (currency tidak diisytiharkan).
#
#   list_packages_for_currency_review() — senarai Trip Package berflag
#     price_review_required (guardrail migrasi harga).
#
# clear_customer_currency_locks() dihentikan — model baharu TIDAK lagi
# memaksa/unset Customer.default_currency (customer bebas berurusan
# dengan company berbeza ikut currency pakej yang ditempah).
#
# Cara panggil (bench console):
#   from travel_booking.api.maintenance import multi_currency_health_check
#   multi_currency_health_check()
# atau dari Desk/browser (perlu login System Manager):
#   /api/method/travel_booking.api.maintenance.multi_currency_health_check

import frappe


# ══════════════════════════════════════════════
# DIAGNOSTIC (read-only)
# ══════════════════════════════════════════════

@frappe.whitelist()
def multi_currency_health_check():
    """Diagnostic paksi currency multi-company — pulangkan report read-sahja.

    Bahagian:
      1. currency_axis — setiap baris Travel Settings.currency_accounts
         disemak: company wujud + default_currency sepadan; price list
         wujud + currency sepadan; payment accounts terisi (bank /
         manual transfer paid_to / payment gateway — amaran sahaja bila
         kosong, bukan error).
      2. undeclared_company_currencies — Company lain dalam site yang
         currency-nya BELUM diisytiharkan dalam axis (booking tak boleh
         jalan untuk currency itu sehingga baris ditambah).
      3. sos_outside_axis — Sales Order travel_booking (custom_booking
         terisi) yang currency-nya tidak diisytiharkan dalam axis —
         rekod sejarah dari model lama; jangan padam, cuma monitoring.
    """
    frappe.only_for("System Manager")

    from travel_booking.api.currency_axis import get_currency_axis, get_declared_currencies

    default_company = frappe.db.get_single_value("Global Defaults", "default_company")
    declared = get_declared_currencies()

    # 1) Konsistensi setiap baris axis.
    axis_report = []
    for r in get_currency_axis():
        company_currency = frappe.get_cached_value("Company", r["company"], "default_currency")
        pl_currency = (
            frappe.get_cached_value("Price List", r["selling_price_list"], "currency")
            if r["selling_price_list"] else None
        )
        issues = []
        if company_currency != r["currency"]:
            issues.append(
                "Company default currency ({0}) != row currency ({1})".format(
                    company_currency, r["currency"]
                )
            )
        if r["selling_price_list"] and pl_currency != r["currency"]:
            issues.append(
                "Price List currency ({0}) != row currency ({1})".format(
                    pl_currency, r["currency"]
                )
            )
        if not r["bank_account"]:
            issues.append("Bank Account not set (manual transfer display info)")
        if not r["manual_transfer_paid_to_account"]:
            issues.append("Manual Transfer Paid To Account not set (PE will fall back to first Bank account)")
        if not r["payment_gateway_account"]:
            issues.append("Payment Gateway Account not set (online payment unavailable for this currency)")
        axis_report.append({
            "currency": r["currency"],
            "company": r["company"],
            "selling_price_list": r["selling_price_list"] or "",
            "is_default": r["is_default"],
            "issues": issues,
            "ok": not issues,
        })

    # 2) Company dalam site yang belum diisytiharkan dalam axis.
    undeclared = []
    for c in frappe.get_all("Company", filters={"is_group": 0}, fields=["name", "default_currency"]):
        if c.name == default_company:
            continue
        if c.default_currency and c.default_currency not in declared:
            undeclared.append({
                "company": c.name,
                "currency": c.default_currency,
                "note": "Currency not declared in Travel Settings > Multi Currency Account — packages cannot be sold in this currency until a row is added.",
            })

    # 3) SO travel_booking yang currency-nya di luar axis (rekod lama).
    sos_outside = frappe.db.sql(
        """
        SELECT so.name, so.currency, so.company
        FROM `tabSales Order` so
        WHERE so.custom_booking IS NOT NULL
          AND so.currency NOT IN %s
        LIMIT 50
        """,
        (tuple(declared) if declared else ("__none__",),),
        as_dict=True,
    )

    return {
        "status": "ok",
        "default_company": default_company,
        "declared_currencies": sorted(declared),
        "currency_axis": {
            "count": len(axis_report),
            "rows": axis_report,
            "action": (
                "All rows OK."
                if all(r["ok"] for r in axis_report) and axis_report
                else "Fix rows flagged with issues in Travel Settings > Multi Currency Account."
            ),
        },
        "undeclared_company_currencies": undeclared,
        "sos_outside_axis": {
            "count": len(sos_outside),
            "rows": sos_outside,
            "note": "Historical SOs from the legacy model — do not delete; informational only.",
        },
    }


# ══════════════════════════════════════════════
# SEED MISSING RECORDS (untuk site sedia ada — selepas deploy versi baharu)
# ══════════════════════════════════════════════

@frappe.whitelist()
def ensure_default_records():
    """Cipta rekod-rekod lalai yang MUNGKIN belum wujud pada site lama
    (after_install hanya jalan semasa pemasangan pertama).

    Buat masa ni: Print Format "Rarecation Proforma Invoice" (baru
    diperkenalkan untuk page Billing portal). Idempotent — selamat
    panggil berulang. Reuse helper install.py supaya satu sumber sahaja.

    Panggil selepas deploy versi multi-page portal:
      bench --site <site> console
      >>> from travel_booking.api.maintenance import ensure_default_records
      >>> ensure_default_records()
    """
    frappe.only_for("System Manager")

    from travel_booking import install as _install
    _install._create_print_format()

    from travel_booking.api.constants import PRINT_FORMAT_PROFORMA
    return {
        "status": "ok",
        "proforma_print_format_created": bool(
            frappe.db.exists("Print Format", PRINT_FORMAT_PROFORMA)
        ),
        "message": "Default records ensured. New records (if any) have been created.",
    }


# ══════════════════════════════════════════════
# CURRENCY MIGRATION REVIEW (post company-currency overhaul)
# ══════════════════════════════════════════════

@frappe.whitelist()
def list_packages_for_currency_review():
    """Senaraikan Trip Package yang berflag `price_review_required`.

    Selepas migrasi ke workflow company-currency, pakej yang currency-nya
    (hint paparan) berbeza dari company currency ditandakan oleh patch
    `v1_set_price_review_flag` supaya admin semak & isi semula harga dalam
    company currency. Sementara flag terpasang, `_get_pricing_map`
    menghalang booking/voucher atas pakej berkenaan.

    Fungsi ni READ-SAHJA — admin gunakan untuk pantau kerja semakan. Selepas
    semak & isi semula harga, admin uncheck `price_review_required` pada
    Trip Package (Desk) untuk membuka kembali jualan.

    Pulangkan {company_currency, count, packages:[{name, package_name,
    trip, trip_name, currency}]}.
    """
    frappe.only_for("System Manager")

    from travel_booking.api._helpers import get_company_currency
    company_currency = get_company_currency()

    rows = frappe.db.sql(
        """
        SELECT tp.name, tp.package_title, tp.trip_link, tp.currency,
               t.trip_name
        FROM `tabTrip Package` tp
        LEFT JOIN `tabTrip` t ON t.name = tp.trip_link
        WHERE IFNULL(tp.price_review_required, 0) = 1
        ORDER BY tp.trip_link, tp.name
        """,
        as_dict=True,
    )

    packages = [
        {
            "name":          r.name,
            "package_title": r.package_title or "",
            "trip":          r.trip_link or "",
            "trip_name":     r.trip_name or "",
            "currency":      r.currency or "",
            "same_as_company": (r.currency == company_currency) if r.currency else False,
        }
        for r in rows
    ]

    return {
        "status": "ok",
        "company_currency": company_currency,
        "count": len(packages),
        "packages": packages,
        "message": (
            str(len(packages)) + " package(s) awaiting currency review. "
            "Booking is blocked on these until 'Price Review Required' is unchecked."
            if packages else
            "No packages awaiting review — all packages are bookable."
        ),
    }

