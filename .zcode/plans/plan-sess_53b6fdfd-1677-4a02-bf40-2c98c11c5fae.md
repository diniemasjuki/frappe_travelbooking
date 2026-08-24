## Rancangan Migrasi: Multi-Domain Routing ke Separate App

### Objektif
Cipta **standalone Frappe app** `multi_domain_routing` yang reusable untuk mana-mana Frappe site.

### Struktur App Baharu
```
multi_domain_routing/
├── hooks.py                              # before_request hook
├── multi_domain_routing/doctype/
│   ├── domain_routing_config/            # Singleton config (NEW)
│   └── domain_mapping/                   # Child table (EXTRACTED)
└── api/_middleware.py                    # Core logic (REFACTORED)
```

### Langkah Implementation

**Fasa 1: Setup App**
- `bench new-app multi_domain_routing`
- `bench install-app multi_domain_routing`

**Fasa 2: Cipta Doctypes**
- `Domain Routing Config` (singleton): enable toggle + domain_mappings table + cache_ttl
- `Domain Mapping` (child table): domain_name, redirect_url, is_active, description

**Fasa 3: Refactor Middleware**
- Extract `_middleware.py` dari travel_booking
- Baca dari `Domain Routing Config` (bukan Travel Website)
- Add configurable caching (default 5 min, 0 = no cache)
- Clean modular functions (_get_config, _build_config, _find_mapping)

**Fasa 4: Bersihkan travel_booking**
- Remove enable_multi_domain + domain_mappings fields dari travel_website.json
- Delete website_domain_mapping doctype
- Remove before_request hook dari travel_booking/hooks.py
- Delete travel_booking/api/_middleware.py
- Optional: Keep integration function untuk baca external config

**Fasa 5: Testing & Deployment**
- Test virtual hosting dengan test.rpwp.my
- Verify enable/disable toggle works
- Verify dynamic config changes (no restart needed)
- Provide migration script untuk copy existing config

### Hasil Akhir
✅ Reusable standalone app  
✅ Zero coupling dengan travel_booking  
✅ Dedicated config doctype  
✅ Independent versioning & marketplace-ready