# travel_booking/www/_json.py
#
# Helper berkongsi untuk membina JSON string yang SELAMAT dibenamkan di
# dalam <script type="application/json"> pada laman www.
#
# Frappe render www dengan Jinja autoescape OFF — sebarang "</script>"
# dalam nilai (cth. query param ?ref=... atau ?token=...) boleh menutup
# tag <script> dan menyuntik HTML/JS pada page guest (reflected XSS).
# json.dumps TIDAK escape < > &, jadi SEMUA JSON yang dibenamkan melalui
# context mesti dump guna json_safe() di sini.
#
# Corak sama seperti _json_safe() dalam www/cruise_schedule.py — fungsi
# itu dibiarkan (sudah berfungsi); module ini untuk pages lain.

import json


def json_safe(obj) -> str:
    """JSON string selamat dibenamkan dalam <script type="application/json">
    — escape < > & supaya kandungan string tak boleh menutup tag / inject
    HTML (corak htmlsafe_json; ensure_ascii lalai dah tukar non-ASCII ke
    \\uXXXX)."""
    s = json.dumps(obj)
    return s.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
