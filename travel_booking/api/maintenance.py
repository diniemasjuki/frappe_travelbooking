# travel_booking/api/maintenance.py
#
# Utility maintenance untuk admin (System Manager sahaja) — sokongan
# operasi multi-currency model "satu Debtors multi-currency":
#
#   multi_currency_health_check()   — diagnostic READ-SAHJA: customer
#     yang terlocked currency, akaun Receivable legacy per-currency yang
#     masih berguna, status flag Accounts Settings, dan ringkasan
#     konfigurasi Travel Settings.currency_accounts.
#
#   clear_customer_currency_locks() — CLEANUP (write): unset
#     Customer.default_currency untuk SEMUA customer yang terisi, supaya
#     customer kembali currency-agnostic (boleh beli pakej MYR + SGD).
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
    """Diagnostic multi-currency — pulangkan report read-sahja.

    Empat bahagian:
      1. locked_customers    — Customer.default_currency terisi (patut
         KOSONG dalam model ni; setiap satunya adalah customer yang tak
         boleh beli pakej market lain).
      2. legacy_fx_receivable_accounts — akaun Receivable ber-currency
         asing (cth "Debtors SGD - DC") dari pendekatan LAMA + bilangan
         GL Entry yang masih rujuk akaun tu (kalau 0, selamat di-abandon;
         kalau >0, rekod sejarah — jangan padam, cuma jangan guna).
      3. accounts_settings_flag — status "Allow multi-currency invoices
         against single party account" (MESTI enabled untuk model ni).
      4. currency_accounts_config — ringkasan konfigurasi per row Travel
         Settings.currency_accounts (currency, bank, gateway, manual
         transfer account) + amaran kalau field LEGACY receivable_account
         terisi (diabaikan oleh code, tapi tanda konfigurasi lama).
    """
    frappe.only_for("System Manager")

    # 1) Customer yang terlocked currency — patut kosong.
    locked_customers = frappe.get_all(
        "Customer",
        filters={"default_currency": ["is", "set"]},
        fields=["name", "customer_name", "default_currency"],
    )

    # 2) Akaun Receivable ber-currency asing (legacy per-currency approach).
    default_company = frappe.db.get_single_value("Global Defaults", "default_company")
    company_currency = (
        frappe.get_cached_value("Company", default_company, "default_currency")
        if default_company else "MYR"
    )
    legacy_accounts = []
    if default_company:
        fx_accounts = frappe.get_all(
            "Account",
            filters={
                "account_type": "Receivable",
                "company": default_company,
                "is_group": 0,
                "account_currency": ["!=", company_currency],
            },
            fields=["name", "account_currency"],
        )
        for acc in fx_accounts:
            gl_count = frappe.db.count("GL Entry", {"account": acc.name})
            legacy_accounts.append({
                "account":   acc.name,
                "currency":  acc.account_currency,
                "gl_entries": gl_count,
                "safe_to_ignore": gl_count == 0,
            })

    # 3) Flag Accounts Settings — mesti enabled (1) untuk single-Debtors
    #    multi-currency. None bermaksud field tak jumpa (versi ERPNext
    #    berbeza) — perlu semak manual di Accounts Settings.
    accounts_flag = frappe.db.get_single_value(
        "Accounts Settings",
        "allow_multi_currency_invoices_against_single_party_account",
    )

    # 4) Ringkasan konfigurasi currency_accounts + amaran legacy.
    settings = frappe.get_cached_doc("Travel Settings")
    currency_rows = []
    for row in (settings.get("currency_accounts") or []):
        currency_rows.append({
            "currency": row.currency,
            "bank_account":                  row.bank_account or "",
            "payment_gateway_account":       row.payment_gateway_account or "",
            "manual_transfer_paid_to_account": row.manual_transfer_paid_to_account or "",
            # LEGACY — field receivable_account diabaikan oleh code (model
            # single-Debtors). Kalau terisi, tanda amaran supaya admin sedar
            # ia tak berkesan & boleh mengelirukan.
            "legacy_receivable_account":     row.receivable_account or "",
            "legacy_receivable_account_warning": bool(row.receivable_account),
        })

    return {
        "status": "ok",
        "company": default_company,
        "company_currency": company_currency,
        "locked_customers": {
            "count": len(locked_customers),
            "customers": locked_customers,
            "action": (
                "Run clear_customer_currency_locks() to fix."
                if locked_customers else "OK — all customers are currency-agnostic."
            ),
        },
        "legacy_fx_receivable_accounts": legacy_accounts,
        "accounts_settings_flag": {
            "allow_multi_currency_invoices_against_single_party_account": accounts_flag,
            "required": 1,
            "ok": bool(accounts_flag),
        },
        "currency_accounts_config": currency_rows,
    }


# ══════════════════════════════════════════════
# CLEANUP (write — unset Customer.default_currency)
# ══════════════════════════════════════════════

@frappe.whitelist()
def clear_customer_currency_locks():
    """Unset Customer.default_currency untuk SEMUA customer yang terisi.

    Idempotent — selamat panggil berulang (tiada rows = tiada perubahan).
    update_modified=False supaya customer record tak nampak "diedit" pada
    tarikh semasa (perubahan ni housekeeping metadata, bukan kandungan).

    Kembalikan senarai customer yang dibersihkan (dengan currency lama)
    untuk audit trail. Run multi_currency_health_check() dulu kalau nak
    preview sebelum cleanup.
    """
    frappe.only_for("System Manager")

    locked = frappe.get_all(
        "Customer",
        filters={"default_currency": ["is", "set"]},
        fields=["name", "default_currency"],
    )

    for c in locked:
        frappe.db.set_value(
            "Customer", c.name, "default_currency", None, update_modified=False
        )

    frappe.db.commit()

    return {
        "status": "ok",
        "cleared": len(locked),
        "customers": [
            {"name": c.name, "previous_currency": c.default_currency}
            for c in locked
        ],
        "message": (
            str(len(locked)) + " customer(s) restored to currency-agnostic."
            if locked else "No locked customers found — nothing to clear."
        ),
    }
