/* ============================================================
   travel_booking/public/js/traveller_manage_addon.js
   Manage Add-on page — lists purchased Booking Addon Items
   with grouping (by order / by package / by traveller).
   Requires: traveller_common.js (loaded before this)
   ============================================================ */

'use strict';

(function () {
  var BOOKING_REF   = _pageData.booking_ref || '';
  var ADDON_ORDERS  = _pageData.addon_orders || [];
  var TRAVELLERS    = _pageData.travellers || [];

  /* Traveller lookup map (Booking Reservation name → display name) */
  var travellerMap = {};
  TRAVELLERS.forEach(function (t) {
    travellerMap[t.name] = t.traveller_full_name || t.guest_label || 'Guest';
  });

  /* ── Init ── */
  async function init() {
    if (!BOOKING_REF) return;
    try {
      await ensureSession();
      renderNav();
      renderPage();
    } catch (e) {
      console.error('Manage Add-on init failed:', e);
    }
  }

  /* ── Flatten all lines from all orders into one array ── */
  function flattenLines() {
    var lines = [];
    ADDON_ORDERS.forEach(function (o) {
      (o.lines || []).forEach(function (l) {
        lines.push(l);
      });
    });
    return lines;
  }

  /* ── Resolve traveller display name from line data ── */
  function resolveTravellerName(l) {
    if (l.traveller_name) return l.traveller_name;
    if (l.booking_reservation && travellerMap[l.booking_reservation])
      return travellerMap[l.booking_reservation];
    return 'Guest';
  }

  /* ── Group lines by selected mode ── */
  function groupLines(lines, mode) {
    var groups = {};
    var order = [];
    lines.forEach(function (l) {
      var key;
      if (mode === 'package') {
        key = l.addon_package || 'unknown';
      } else if (mode === 'traveller') {
        key = (l.scope === 'Per Pax' && l.booking_reservation)
          ? l.booking_reservation : '__per_booking__';
      } else {
        key = l.order_name || 'unknown';
      }
      if (!groups[key]) {
        groups[key] = { key: key, lines: [], sample: l };
        order.push(key);
      }
      groups[key].lines.push(l);
    });
    return order.map(function (k) { return groups[k]; });
  }

  /* ── Render the full page ── */
  function renderPage() {
    var lines   = flattenLines();
    var loading = document.getElementById('ma-loading');
    var content = document.getElementById('ma-content');
    if (loading) loading.style.display = 'none';
    if (!content) return;
    content.style.display = 'block';

    var ref = encodeURIComponent(BOOKING_REF);
    var browseUrl = '/traveller/booking_addons?booking=' + ref;
    var backUrl   = '/traveller/booking?ref=' + ref;
    var html = '';

    /* ── Page header ── */
    html += '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:20px;">';
    html += '<div>';
    html += '<h1 style="margin:0;font-size:24px;font-weight:700;">🎁 Manage Add-ons</h1>';
    html += '<p style="margin:4px 0 0;font-size:13px;color:var(--text-muted);">Booking: ' + _esc(BOOKING_REF) + '</p>';
    html += '</div>';
    html += '<div style="display:flex;gap:8px;flex-wrap:wrap;">';
    html += '<a href="' + backUrl + '" class="tv-btn tv-btn--ghost tv-btn--sm">← Back to Booking</a>';
    if (lines.length > 0)
      html += '<a href="' + browseUrl + '" class="tv-btn tv-btn--primary tv-btn--sm">Browse More Add-ons →</a>';
    html += '</div>';
    html += '</div>';

    /* ── Empty state ── */
    if (lines.length === 0) {
      html += '<div class="tv-card tv-text-center" style="padding:48px 24px;">';
      html += '<div style="font-size:48px;margin-bottom:16px;">🎁</div>';
      html += '<h3 style="margin:0 0 8px;">No Add-ons Purchased</h3>';
      html += '<p style="color:var(--text-muted);margin:0 0 20px;">Enhance your trip with optional activities, upgrades & more.</p>';
      html += '<a href="' + browseUrl + '" class="tv-btn tv-btn--primary">Browse Add-ons →</a>';
      html += '</div>';
      content.innerHTML = html;
      return;
    }

    /* ── Group selector (segmented pill toggle, reuses .tv-pay-chip) ── */
    var GROUP_MODES = [
      { key: 'order',     icon: '🧾', label: 'Booking Addon' },
      { key: 'package',   icon: '📦', label: 'Addon Package' },
      { key: 'traveller', icon: '👤', label: 'Traveller' }
    ];
    var modeCounts = {};
    GROUP_MODES.forEach(function (m) {
      modeCounts[m.key] = groupLines(lines, m.key).length;
    });

    html += '<div class="tv-card" style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap;">';
    html += '<span style="font-size:13px;font-weight:600;color:var(--text-secondary);">Group by</span>';
    html += '<div class="tv-pay-chips" id="ma-group-chips" style="margin:0;flex-wrap:wrap;">';
    GROUP_MODES.forEach(function (m, i) {
      var on = (i === 0) ? ' on' : '';
      html += '<button type="button" class="tv-pay-chip' + on + '" data-mode="' + m.key + '">'
        + m.icon + ' ' + _esc(m.label)
        + ' <span style="font-size:11px;opacity:0.65;">' + modeCounts[m.key] + '</span>'
        + '</button>';
    });
    html += '</div>';
    html += '<span style="font-size:12px;color:var(--text-muted);margin-left:auto;">'
      + lines.length + ' item(s) across ' + ADDON_ORDERS.length + ' order(s)</span>';
    html += '</div>';

    /* ── Items container ── */
    html += '<div id="ma-items"></div>';

    content.innerHTML = html;

    /* Render initial groups + wire up pill toggle */
    renderItems('order');
    var chipBox = document.getElementById('ma-group-chips');
    if (chipBox) {
      chipBox.addEventListener('click', function (e) {
        var chip = e.target.closest('.tv-pay-chip');
        if (!chip) return;
        chipBox.querySelectorAll('.tv-pay-chip').forEach(function (c) { c.classList.remove('on'); });
        chip.classList.add('on');
        renderItems(chip.dataset.mode);
      });
    }

    /* Wire up collapsible group headers (event delegation on items container) */
    var itemsBox = document.getElementById('ma-items');
    if (itemsBox) {
      itemsBox.addEventListener('click', function (e) {
        var header = e.target.closest('.ma-group-header');
        if (!header) return;
        var card = header.closest('.ma-group-card');
        if (!card) return;
        card.classList.toggle('collapsed');
      });
    }
  }

  /* ── Re-render the items area for the selected grouping ── */
  function renderItems(mode) {
    var container = document.getElementById('ma-items');
    if (!container) return;
    var lines  = flattenLines();
    var groups = groupLines(lines, mode);
    container.innerHTML = renderGroups(groups, mode);
  }

  /* ── Render all groups ── */
  function renderGroups(groups, mode) {
    var html = '';
    groups.forEach(function (g) {
      html += renderGroupHeader(g, mode);
      html += '<div class="ma-group-body">';
      g.lines.forEach(function (l) {
        html += renderItemRow(l, mode);
      });
      html += '</div>'; /* close group body */
      html += '</div>'; /* close group card */
    });
    return html;
  }

  /* ── Group header (varies by mode) ── */
  function renderGroupHeader(g, mode) {
    var s = g.sample;
    var html = '';

    html += '<div class="tv-card tv-animate-in ma-group-card" style="margin-bottom:12px;">';
    html += '<div class="ma-group-header" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;padding-bottom:12px;border-bottom:1px solid var(--border-default);margin-bottom:12px;">';

    if (mode === 'order') {
      /* By Booking Addon (order) */
      var totalAmount = 0;
      g.lines.forEach(function (l) { totalAmount += parseFloat(l.amount) || 0; });
      html += '<div style="display:flex;align-items:center;gap:8px;">';
      html += '<span class="ma-group-chevron">▾</span>';
      html += '<span style="font-weight:700;font-size:14px;">' + _esc(s.order_name) + '</span>';
      html += '<span style="font-size:12px;color:var(--text-muted);">'
        + g.lines.length + ' item(s) · Total: ' + fmtDual(totalAmount) + '</span>';
      html += '</div>';
      html += '<div style="display:flex;gap:6px;">';
      html += statusBadge(s.order_status, 'booking');
      html += statusBadge(s.order_payment_status, 'payment');
      html += '</div>';
    } else if (mode === 'package') {
      /* By Addon Package */
      var pkgName = s.addon_package_name || '';
      var title = s.addon_title || 'Unknown Addon';
      html += '<div style="display:flex;align-items:center;gap:8px;">';
      html += '<span class="ma-group-chevron">▾</span>';
      html += '<span style="font-weight:700;font-size:14px;">' + _esc(title) + '</span>';
      if (pkgName)
        html += '<span style="font-size:12px;color:var(--text-muted);">' + _esc(pkgName) + '</span>';
      html += '<span style="font-size:12px;color:var(--text-muted);">· '
        + g.lines.length + ' item(s)</span>';
      html += '</div>';
    } else {
      /* By Traveller */
      var tname = (g.key === '__per_booking__')
        ? 'Per Booking (Unassigned)' : resolveTravellerName(s);
      html += '<div style="display:flex;align-items:center;gap:8px;">';
      html += '<span class="ma-group-chevron">▾</span>';
      html += '<span style="font-weight:700;font-size:14px;">👤 ' + _esc(tname) + '</span>';
      html += '<span style="font-size:12px;color:var(--text-muted);">· '
        + g.lines.length + ' item(s)</span>';
      html += '</div>';
    }

    html += '</div>'; /* close header row */
    return html;
  }

  /* ── Single item row ── */
  function renderItemRow(l, mode) {
    var html = '';
    html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;padding:10px 0;border-bottom:1px solid rgba(0,0,0,0.06);">';

    /* Left: addon info */
    html += '<div style="flex:1;min-width:200px;">';
    html += '<div style="font-weight:600;font-size:13px;">' + _esc(l.addon_title || 'Unknown') + '</div>';
    if (l.addon_package_name)
      html += '<div style="font-size:12px;color:var(--text-muted);">' + _esc(l.addon_package_name) + '</div>';

    /* Context line: order / traveller / scope / qty */
    var ctx = [];
    if (mode !== 'order' && l.order_name)
      ctx.push(_esc(l.order_name));
    if (l.scope === 'Per Pax') {
      if (mode !== 'traveller')
        ctx.push('Traveller: ' + _esc(resolveTravellerName(l)));
      ctx.push('Per Pax');
    } else {
      ctx.push('Per Booking');
    }
    if (l.qty > 1)
      ctx.push('Qty: ' + l.qty);
    if (ctx.length)
      html += '<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">' + ctx.join(' · ') + '</div>';

    /* Validity dates */
    if (l.valid_from || l.valid_to) {
      var v = '';
      if (l.valid_from && l.valid_to)
        v = fmtDate(l.valid_from) + ' – ' + fmtDate(l.valid_to);
      else if (l.valid_from)
        v = 'From ' + fmtDate(l.valid_from);
      else
        v = 'Until ' + fmtDate(l.valid_to);
      html += '<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">📅 ' + _esc(v) + '</div>';
    }
    html += '</div>';

    /* Right: amount + status badges */
    html += '<div style="text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:4px;">';
    html += '<div style="font-weight:700;font-size:14px;">' + fmtDual(l.amount) + '</div>';
    if (l.unit_price && l.qty > 1)
      html += '<div style="font-size:11px;color:var(--text-muted);">' + fmtDual(l.unit_price) + ' × ' + l.qty + '</div>';
    html += '<div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;">';
    html += statusBadge(l.order_status, 'booking');
    html += statusBadge(l.order_payment_status, 'payment');
    html += '</div>';
    html += '</div>';

    html += '</div>'; /* close item row */
    return html;
  }

  /* ── Boot ── */
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init);
  else
    init();
})();
