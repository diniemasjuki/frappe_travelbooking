# travel_booking/utils/assets.py
#
# Cache-busting untuk asset statik portal. Nginx hidangkan /assets dengan
# Cache-Control: max-age=31536000 (setahun) — tanpa token versi pada URL,
# browser kekal guna JS/CSS LAMA selepas deploy sehingga user hard-refresh
# (punca "perubahan tak nampak" pada booking_billing selepas kemas kini
# portal_billing.js).
#
# Didaftarkan sebagai jinja "methods" dalam hooks.py. Semua template guna:
#   src="/assets/travel_booking/js/x.js?v={{ asset_v('js/x.js') }}"
# 'relpath' relatif kepada travel_booking/public. Nilai = mtime fail (int) —
# bertukar setiap kali fail diubah, jadi URL baharu memaksa browser muat
# semula sekali sahaja, kemudian dicache setahun seperti biasa.

import os

_PUBLIC_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "public")


def asset_v(relpath: str) -> str:
	try:
		full = os.path.join(_PUBLIC_DIR, str(relpath).lstrip("/"))
		return str(int(os.path.getmtime(full)))
	except OSError:
		return "0"
