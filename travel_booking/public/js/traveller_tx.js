/* ============================================================
   travel_booking/public/js/traveller_tx.js
   Transaction history page — aggregated from all SOs.
   With PAGINATION: 10/20/50/100 rows per page.
   Requires: traveller_common.js (loaded before this)
   ============================================================ */

'use strict';

(function () {
  var allTransactions = [];
  var currentPage = 1;
  var rowsPerPage = 10;

  /* ── Init ── */
  async function init() {
    try {
      await ensureSession();
      renderNav();
      await loadTransactions();
      wireFilters();
    } catch (e) {
      console.error('Failed to load transactions:', e);
    }
  }

  async function loadTransactions() {
    var loading = document.getElementById('tx-loading');
    var content = document.getElementById('tx-content');
    var empty = document.getElementById('tx-empty');

    try {
      // Get ALL SO payments (no booking filter — shows everything)
      var data = await API_PM('get_all_so_payments', {});
      var orders = data.orders || [];

      // Flatten all transactions from all SOs
      allTransactions = [];
      orders.forEach(function (so) {
        if (so.is_cancelled) return;
        var bookings = so.bookings || [];
        var bookingRef = so.booking_numbers && so.booking_numbers[0] || '';
        var tripName = bookings[0] || 'Booking';

        (so.payments || []).forEach(function (pay) {
          allTransactions.push({
            date: pay.payment_date,
            amount: pay.paid_amount,
            method: pay.channel_label || pay.channel || 'Online Payment',
            channel: pay.channel,
            status: pay.status || 'Pending',
            ref: pay.reference_no,
            name: pay.name, // PE name for receipt download
            hasProof: !!pay.proof_of_payment,
            soName: so.name,
            grandTotal: so.grand_total,
            bookingRef: bookingRef,
            tripName: tripName,
            currency: so.currency_symbol || RC.company_symbol || 'RM',
            // Invoice if available
            invoice: (so.invoices && so.invoices[0]) || null
          });
        });
      });

      // Sort by date descending (newest first)
      allTransactions.sort(function (a, b) {
        return new Date(b.date || 0) - new Date(a.date || 0);
      });

      if (loading) loading.style.display = 'none';

      if (!allTransactions.length) {
        if (empty) empty.style.display = 'block';
        return;
      }

      // Get saved rows preference or default
      var savedRows = localStorage.getItem('tx_rows_per_page');
      if (savedRows) rowsPerPage = parseInt(savedRows) || 10;

      if (content) {
        content.style.display = 'block';
        renderPaginatedTransactions();
      }
    } catch (e) {
      if (loading) loading.style.display = 'none';
      if (empty) {
        empty.style.display = 'block';
        empty.querySelector('.tv-empty__title').textContent = 'Unable to Load Transactions';
        empty.querySelector('.tv-empty__desc').textContent =
          e.message || 'Please check your connection and try again.';
      }
    }
  }

  /* ── Render with Pagination ── */
  function renderPaginatedTransactions() {
    var content = document.getElementById('tx-content');
    var paginationEl = document.getElementById('tx-pagination');

    if (!content) return;

    var total = allTransactions.length;
    var totalPages = Math.ceil(total / rowsPerPage);

    // Ensure current page is valid
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;

    // Calculate slice
    var startIdx = (currentPage - 1) * rowsPerPage;
    var endIdx = Math.min(startIdx + rowsPerPage, total);
    var pageData = allTransactions.slice(startIdx, endIdx);

    // Render cards for this page (no outer wrapper - each card is standalone)
    var html = '';

    html += '<div style="font-size:13px;color:var(--text-muted);margin-bottom:20px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">';
    html += '<span><strong>' + total + '</strong> transaction(s) found · Showing <strong>' + (startIdx + 1) + '-' + endIdx + '</strong> of <strong>' + total + '</strong></span>';
    html += '<span style="font-size:11px;">Page <strong>' + currentPage + '</strong> of <strong>' + totalPages + '</strong></span>';
    html += '</div>';

    if (pageData.length > 0) {
      pageData.forEach(function (tx, idx) {
        html += renderTxCard(tx, idx);
      });
    } else {
      html += '<div class="tv-empty" style="padding:30px;background:var(--bg-card);border:1px solid var(--border-default);border-radius:var(--radius-lg);"><div class="tv-empty__icon">📋</div><p style="color:var(--text-muted);">No transactions for this page.</p></div>';
    }

    content.innerHTML = html;

    // Render pagination controls
    if (totalPages > 1 && paginationEl) {
      paginationEl.style.display = 'block';
      paginationEl.innerHTML = renderPagination(currentPage, totalPages, total);
      wirePaginationControls();
    } else if (paginationEl) {
      paginationEl.style.display = 'none';
    }

    // Wire collapsible trip name toggles
    wireCollapsibleCards();
    // Wire receipt/invoice direct downloads
    wireDocDownloads();
  }

  /* ── Fetch a document PDF from get_document_pdf.
     Backend serves the PDF as a BINARY response (frappe.response.filecontent,
     content-type application/pdf) on success, or JSON on error — _post()
     JSON-parses everything so it can't carry binary. Use raw fetch here. ── */
  async function _fetchDocPdf(doctype, docname) {
    var r = await fetch('/api/method/travel_booking.api.portal_payment.get_document_pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Frappe-CSRF-Token': _csrfToken() },
      credentials: 'include',
      body: JSON.stringify({ doctype: doctype, docname: docname })
    });

    // Binary PDF (success path) → object URL
    var ct = (r.headers.get('content-type') || '').toLowerCase();
    if (r.ok && ct.indexOf('application/pdf') !== -1) {
      var blob = await r.blob();
      return { url: URL.createObjectURL(blob) };
    }

    // JSON path — error dict or file_url fallback
    var d = await r.json().catch(function () { return {}; });
    var result = (d && d.message) || d;
    if (result && result.file_url) {
      return { url: result.file_url };
    }
    if (result && result.status === 'ok') {
      return { direct: true };
    }
    return { error: (result && result.message) || 'Document not available. Please contact support.' };
  }

  /* ── Trigger browser save of a PDF URL ── */
  function _savePdf(url, filename) {
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  /* ── Wire receipt & invoice download buttons ── */
  function wireDocDownloads() {
    document.querySelectorAll('[data-act="download-receipt"]').forEach(function (btn) {
      btn.addEventListener('click', async function (e) {
        e.stopPropagation(); // don't toggle the collapsible card
        var payName = this.dataset.name;
        if (!payName) return;
        try {
          showToast('Preparing receipt...', 'info');
          var doc = await _fetchDocPdf('Payment Entry', payName);
          if (doc.url) {
            _savePdf(doc.url, 'receipt-' + payName + '.pdf');
            showToast('Receipt downloaded.', 'success');
          } else if (doc.direct) {
            showToast('Download started...', 'success');
          } else {
            showToast(doc.error || 'Receipt not available.', 'warning');
          }
        } catch (err) {
          showToast(err.message || 'Failed to download receipt.', 'error');
        }
      });
    });

    document.querySelectorAll('[data-act="download-invoice"]').forEach(function (btn) {
      btn.addEventListener('click', async function (e) {
        e.stopPropagation(); // don't toggle the collapsible card
        var invName = this.dataset.name;
        if (!invName) return;
        try {
          showToast('Preparing invoice...', 'info');
          var doc = await _fetchDocPdf('Sales Invoice', invName);
          if (doc.url) {
            _savePdf(doc.url, invName.replace('/', '-') + '.pdf');
            showToast('Invoice downloaded.', 'success');
          } else if (doc.direct) {
            showToast('Download started...', 'success');
          } else {
            showToast(doc.error || 'Invoice not available.', 'warning');
          }
        } catch (err) {
          showToast(err.message || 'Failed to download invoice.', 'error');
        }
      });
    });
  }

  /* ── Render Pagination Controls ── */
  function renderPagination(page, totalPages, totalItems) {
    var html = '';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:16px;padding:16px 0;border-top:1px solid var(--border-light);flex-wrap:wrap;">';

    // Left: Page info
    html += '<div style="font-size:13px;color:var(--text-secondary);">';
    html += 'Showing <strong>' + rowsPerPage + '</strong> per page · ';
    html += '<strong>' + totalItems + '</strong> total</div>';

    // Center: Page numbers
    html += '<div style="display:flex;align-items:center;gap:4px;">';

    // Previous button
    html += '<button class="tv-btn tv-btn--ghost tv-btn--sm tx-pg-btn" data-pg-action="prev" ' + (page <= 1 ? 'disabled' : '') + '>← Prev</button>';

    // Page number buttons (show max 7 pages with ellipsis)
    var pagesToShow = getVisiblePages(page, totalPages);
    pagesToShow.forEach(function (p) {
      if (p === '...') {
        html += '<span style="padding:4px 8px;color:var(--text-muted);">…</span>';
      } else {
        var isCurrent = (p === page);
        html += '<button class="tv-btn tv-btn--sm tx-pg-num" data-pg-page="' + p + '" ' +
                (isCurrent ? 'tv-btn--primary' : 'tv-btn--ghost') + '">' + p + '</button>';
      }
    });

    // Next button
    html += '<button class="tv-btn tv-btn--ghost tv-btn--sm tx-pg-btn" data-pg-action="next" ' + (page >= totalPages ? 'disabled' : '') + '>Next →</button>';

    html += '</div>'; // center

    // Right: Jump to page
    html += '<div style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-secondary);">';
    html += 'Go to';
    html += '<input type="number" id="tx-jump-page" min="1" max="' + totalPages + '" value="' + page + '" ';
    html += 'class="tv-input" style="width:60px;padding:6px 10px;text-align:center;font-size:13px;" title="Jump to page"/>';
    html += 'of ' + totalPages;
    html += '</div>';

    html += '</div>'; // container
    return html;
  }

  /* Helper: Get visible page numbers with ellipsis */
  function getVisiblePages(current, total) {
    if (total <= 7) {
      return Array.from({ length: total }, (_, i) => i + 1);
    }

    var pages = [];
    pages.push(1);

    if (current > 3) pages.push('...');

    var start = Math.max(2, current - 2);
    var end = Math.min(total - 1, current + 2);

    for (var i = start; i <= end; i++) {
      pages.push(i);
    }

    if (current < total - 2) pages.push('...');

    pages.push(total);
    return pages;
  }

  /* Wire up pagination button clicks */
  function wirePaginationControls() {
    var pgContainer = document.getElementById('tx-pagination');
    if (!pgContainer) return;

    // Page number buttons
    pgContainer.querySelectorAll('[data-pg-page]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var targetPage = parseInt(this.dataset.pgPage);
        if (targetPage && targetPage !== currentPage) {
          currentPage = targetPage;
          renderPaginatedTransactions();
          // Scroll to top of list smoothly
          document.getElementById('tx-content').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });

    // Prev/Next buttons
    pgContainer.querySelectorAll('[data-pg-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var action = this.dataset.pgAction;
        if (action === 'prev' && currentPage > 1) {
          currentPage--;
          renderPaginatedTransactions();
          document.getElementById('tx-content').scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else if (action === 'next') {
          var totalPages = Math.ceil(allTransactions.length / rowsPerPage);
          if (currentPage < totalPages) {
            currentPage++;
            renderPaginatedTransactions();
            document.getElementById('tx-content').scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
      });
    });

    // Jump to page input
    var jumpInput = document.getElementById('tx-jump-page');
    if (jumpInput) {
      jumpInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          var targetPage = parseInt(this.value);
          var totalPages = Math.ceil(allTransactions.length / rowsPerPage);
          if (targetPage >= 1 && targetPage <= totalPages) {
            currentPage = targetPage;
            renderPaginatedTransactions();
            document.getElementById('tx-content').scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
      });
    }
  }

  /* ── Render Transaction List (Columned Cards) ── */
  function renderTransactions(transactions) {
    var html = '';

    html += '<div class="tv-card">';
    html += '<div style="font-size:13px;color:var(--text-muted);margin-bottom:20px;display:flex;justify-content:space-between;align-items:center;">';
    html += '<span>' + transactions.length + ' transaction(s) found</span>';
    html += '</div>';

    transactions.forEach(function (tx, idx) {
      html += renderTxCard(tx, idx);
    });

    html += '</div>'; // card
    return html;
  }

  /* ── Single Transaction Card (Collapsible, No Outer Wrapper) ── */
  function renderTxCard(tx, idx) {
    var statusCls = tx.status === 'Verified' ? 'success' : (tx.status === 'Cancelled' ? 'danger' : 'warning');
    var statusText = tx.status || 'Pending';
    var iconEmoji = tx.channel === 'online' ? '💳' : '🏦';
    var methodLabel = tx.method || (tx.channel === 'online' ? 'Online Payment' : 'Bank Transfer');
    var cardId = 'tx-card-' + idx;

    var html = '';
    
    /* ── STANDALONE CARD (no outer wrapper) ── */
    html += '<div id="' + cardId + '" class="tv-tx-card" data-tx-status="' + _esc(statusText) + '" style="display:flex;flex-direction:column;gap:0;padding:20px;border:1px solid var(--border-default);border-radius:var(--radius-lg);background:var(--bg-card);margin-bottom:16px;transition:var(--transition);">';

    /* ── HEADER ROW: Trip Name (Collapsible Title) + Status ── */
    html += '<div class="tx-card-header" style="display:flex;justify-content:space-between;align-items:center;gap:12px;cursor:pointer;" data-card="' + cardId + '">';
    
    // Left: Icon + Trip Name (clickable to expand/collapse)
    html += '<div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;">';
    html += '<span class="tx-toggle-icon" style="font-size:18px;transition:transform .2s;">▸</span>';
    html += '<div>';
    html += '<div style="font-family:var(--font-heading);font-size:16px;font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + _esc(tx.tripName || '—') + '</div>';
    html += '<div style="font-size:12px;color:var(--text-muted);white-space:nowrap;">' + (tx.date ? fmtDate(tx.date) : '') + '</div>';
    html += '</div></div>';

    // Right: Method icon + Amount + Status badge
    html += '<div style="display:flex;align-items:center;gap:12px;">';
    html += '<span style="font-size:20px;">' + iconEmoji + '</span>';
    html += '<div style="text-align:right;">';
    html += '<div style="font-family:var(--font-heading);font-size:16px;font-weight:700;color:var(--text-primary);">' + fmtDual(tx.amount, tx.currency) + '</div>';
    html += '<span class="tv-badge tv-badge--' + statusCls + '" style="margin-top:4px;">' + _esc(statusText) + '</span>';
    html += '</div></div>';
    html += '</div>'; // header

    /* ── COLLAPSIBLE BODY (hidden by default, shows on click) ── */
    html += '<div class="tx-card-body" style="display:none;">';

    /* Info Grid: 3 columns (Booking Ref · Bill Number · Ref No) */
    html += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;padding:14px;background:var(--bg-secondary);border-radius:var(--sm);margin-top:4px;">';

    // Col 1: Booking Ref
    html += '<div>';
    html += '<div class="tv-field__label">Booking Ref</div>';
    if (tx.bookingRef) {
      html += '<a href="/traveller/booking?ref=' + encodeURIComponent(tx.bookingRef) + '" ';
      html += 'style="font-family:var(--font-heading);font-weight:600;font-size:14px;color:var(--c-gold-dark);text-decoration:none;">';
      html += _esc(tx.bookingRef) + '</a>';
    } else {
      html += '<span style="font-family:var(--font-heading);font-weight:600;font-size:14px;color:var(--text-muted);">—</span>';
    }
    html += '</div>';

    // Col 2: Bill Number (was Sales Order)
    html += '<div>';
    html += '<div class="tv-field__label">Bill Number</div>';
    html += '<div style="font-family:\'SF Mono\',Monaco,monospace;font-size:13px;color:var(--text-secondary);" title="' + _esc(tx.soName) + '">' + _esc(tx.soName || '—') + '</div>';
    html += '</div>';

    // Col 3: Ref No.
    html += '<div>';
    html += '<div class="tv-field__label">Ref No.</div>';
    html += '<div style="font-family:\'SF Mono\',Monaco,monospace;font-size:13px;color:var(--text-muted);" title="' + _esc(tx.ref) + '">' + (tx.ref ? _esc(tx.ref) : '—') + '</div>';
    html += '</div>';

    html += '</div>'; // info grid

    /* Action Buttons Row — Receipt/Invoice download directly, View navigates */
    html += '<div style="display:flex;justify-content:flex-end;gap:8px;padding-top:12px;border-top:1px solid var(--border-light);margin-top:4px;">';

    // Build billing URL with ref + bill params for single-SO view
    var billingUrl = '/traveller/billing?ref=' + encodeURIComponent(tx.bookingRef || '') + '&bill=' + encodeURIComponent(tx.soName || '');

    // Receipt download (direct PDF via print format) — verified transactions only
    if (statusText === 'Verified') {
      html += '<button class="tv-btn tv-btn--ghost tv-btn--sm" title="Download Receipt PDF" data-act="download-receipt" data-name="' + _esc(tx.name || '') + '">📥 Receipt</button>';
    }

    // Invoice download (direct PDF via print format) — if SO has an invoice
    if (tx.invoice && tx.invoice.name) {
      html += '<button class="tv-btn tv-btn--ghost tv-btn--sm" title="Download Invoice PDF" data-act="download-invoice" data-name="' + _esc(tx.invoice.name) + '">📋 Invoice</button>';
    }

    // View in billing (single-SO view)
    if (tx.bookingRef) {
      html += '<a href="' + billingUrl + '" class="tv-btn tv-btn--primary tv-btn--sm" title="View in Billing" style="text-decoration:none;">View →</a>';
    }

    html += '</div>'; // actions
    html += '</div>'; // collapsible body
    html += '</div>'; // card

    return html;
  }

  /* Wire up collapsible card toggles */
  function wireCollapsibleCards() {
    document.querySelectorAll('.tx-card-header').forEach(function (header) {
      header.addEventListener('click', function () {
        var cardId = this.dataset.card;
        var card = document.getElementById(cardId);
        if (!card) return;

        var body = card.querySelector('.tx-card-body');
        var toggle = this.querySelector('.tx-toggle-icon');

        if (body && toggle) {
          var isHidden = body.style.display === 'none';
          body.style.display = isHidden ? '' : 'none';
          toggle.style.transform = isHidden ? 'rotate(90deg)' : 'rotate(0deg)';
          
          // Optional: highlight active card
          if (isHidden) {
            card.style.borderColor = 'var(--c-gold)';
            card.style.boxShadow = 'var(--shadow-md)';
          } else {
            card.style.borderColor = 'var(--border-default)';
            card.style.boxShadow = 'none';
          }
        }
      });
    });

    // Auto-expand first card
    var firstHeader = document.querySelector('.tx-card-header');
    if (firstHeader) firstHeader.click();
  }

  /* ── Wire up filters, pagination & actions ── */
  function wireFilters() {
    // Rows per page selector
    var rowsSelector = document.getElementById('tx-rows-per-page');
    if (rowsSelector) {
      // Set saved value
      rowsSelector.value = String(rowsPerPage);

      rowsSelector.addEventListener('change', function () {
        rowsPerPage = parseInt(this.value) || 10;
        localStorage.setItem('tx_rows_per_page', String(rowsPerPage));
        currentPage = 1; // Reset to first page when changing rows
        renderPaginatedTransactions();
      });
    }

    // Status filter
    var filterEl = document.getElementById('tx-filter-status');
    if (filterEl) {
      filterEl.addEventListener('change', function () {
        var val = this.value;
        document.querySelectorAll('.tv-tx-card').forEach(function (card) {
          if (!val || card.dataset.txStatus === val) {
            card.style.display = '';
          } else {
            card.style.display = 'none';
          }
        });

        // Update count of visible items
        var visible = document.querySelectorAll('.tv-tx-card[style=""], .tv-tx-card:not([style])').length;
        var total = allTransactions.length;
        var countEl = document.querySelector('#tx-content .tv-card > div');
        if (countEl) {
          countEl.innerHTML = '<strong>' + total + '</strong> transaction(s) found · Showing <strong>1-' + visible + '</strong> of <strong>' + total + '</strong>';
        }
      });
    }

    // Note: Receipt/Invoice buttons are now <a> links to /traveller/billing?ref=...&bill=...
    // No click handler needed — browser handles navigation natively.
  }

  /* ── Start on DOM ready ── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
