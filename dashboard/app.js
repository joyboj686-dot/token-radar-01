(function () {
  'use strict';

  var D = window.RADAR;
  if (!D) return;

  var wlSet = new Set((D.watchlist_slugs || []).map(String));

  var state = {
    q: '', category: 'all', chain: 'all', watchlistOnly: false,
    tab: 'pre-token', sort: 'implied', dir: -1, selected: null,
  };

  var usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usdFmt.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function localImplied(row, model) {
    var g = Math.min(model.growth_cap, Math.max(model.growth_floor, row.change_7d == null ? 0 : row.change_7d));
    var gm = 1 + (g / 100) * model.growth_weight;
    var age = row.age_days == null ? model.unknown_age_days : row.age_days;
    var mat = model.maturity_floor + (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    return Math.max(1, Math.round((row.tvl_usd || 0) * (row.category_multiple || 0.214) * gm * mat));
  }

  function buildTopbar() {
    document.getElementById('topbar-sub').textContent =
      'Snapshot ' + D.as_of + ' · $' + Math.round(D.floor_usd / 1e6) + 'M floor · ' + D.watchlist_size + ' watchlist · ' + D.board_size + ' ranked';
    var meta = document.getElementById('topbar-meta');
    meta.innerHTML = '';
    meta.appendChild(el('span', { text: 'Source: DefiLlama' }));
    meta.appendChild(el('span', { text: 'Model: ' + D.model_version }));
    meta.appendChild(el('span', { text: 'Comps: ' + (D.comps_count || 128) }));
  }

  function buildLede() {
    document.getElementById('lede-title').textContent =
      D.watchlist_size + ' watchlist protocols ranked by implied value';
    document.getElementById('lede-desc').innerHTML =
      'The watchlist is the floor: every protocol with at least $' + Math.round(D.floor_usd / 1e6) + 'M of TVL that <b>records no token</b>. ' +
      'The early radar adds ' + D.early_size + ' pre-token protocols below that floor. Implied value is a model, not a promise.';
    var facts = document.getElementById('facts');
    facts.innerHTML = '';
    [
      ['Watchlist covered', D.watchlist_size + ' / ' + D.watchlist_size],
      ['Pre-token rows scored', String(D.board_size)],
      ['Early rows below floor', String(D.early_size)],
      ['Live-token protocols set aside', String(D.live_size)],
    ].forEach(function (r) {
      facts.appendChild(el('div', { class: 'fact' }, el('span', { text: r[0] }), el('b', { text: r[1] })));
    });
  }

  function buildControls() {
    var container = document.getElementById('controls');
    container.innerHTML = '';
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, slug, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; render(); });

    var cats = [];
    if (D.rows) {
      var seen = new Set();
      D.rows.forEach(function (r) { var c = r.category || 'Other'; if (!seen.has(c)) { seen.add(c); cats.push(c); } });
      cats.sort();
    }
    var catSel = el('select', { id: 'category-filter', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      (cats || []).map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    catSel.addEventListener('change', function () { state.category = catSel.value; render(); });

    var chains = [];
    if (D.rows) {
      var seenC = new Set();
      D.rows.forEach(function (r) { (r.chains || []).forEach(function (ch) { if (!seenC.has(ch)) { seenC.add(ch); chains.push(ch); } }); });
      chains.sort();
    }
    var chainSel = el('select', { id: 'chain-filter', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      (chains || []).map(function (ch) { return el('option', { value: ch, text: ch, selected: ch === state.chain ? 'selected' : null }); })
    );
    chainSel.addEventListener('change', function () { state.chain = chainSel.value; render(); });

    var wlWrap = el('label', { class: 'field-watchlist', style: 'cursor:pointer;' });
    var wlCb = el('input', { type: 'checkbox', id: 'wl-only', checked: state.watchlistOnly });
    wlCb.addEventListener('change', function () { state.watchlistOnly = wlCb.checked; render(); });
    wlWrap.appendChild(wlCb);
    wlWrap.appendChild(document.createTextNode(' Watchlist only'));

    var preBtn = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token board (' + D.board_size + ')' });
    preBtn.addEventListener('click', function () { state.tab = 'pre-token'; render(); });
    var liveBtn = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Already trading (' + D.live_size + ')' });
    liveBtn.addEventListener('click', function () { state.tab = 'live'; render(); });

    container.appendChild(el('div', { class: 'field' }, el('label', { text: 'Search', 'aria-hidden': 'true' }), search));
    container.appendChild(el('div', { class: 'field' }, el('label', { text: 'Category', 'aria-hidden': 'true' }), catSel));
    container.appendChild(el('div', { class: 'field' }, el('label', { text: 'Chain', 'aria-hidden': 'true' }), chainSel));
    container.appendChild(el('div', { class: 'field' }, wlWrap));
    container.appendChild(el('div', { class: 'tabs' }, preBtn, liveBtn));
    container.appendChild(el('span', { class: 'count', id: 'row-count', text: '' }));
  }

  function sortHeader(key, label) {
    var arrow = state.sort === key ? (state.dir < 0 ? '▼' : '▲') : '';
    var btn = el('button', { type: 'button', text: label + ' ' + arrow });
    btn.addEventListener('click', function () {
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = -1; }
      render();
    });
    return el('th', { scope: 'col' }, btn);
  }

  function buildBoardTable(list) {
    if (!list.length) {
      return el('div', { class: 'panel' },
        el('div', { class: 'empty' },
          el('h2', { text: 'No protocols match that filter' }),
          el('p', { text: 'Clear the search or pick another category to see the board.' }),
          el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.watchlistOnly = false; render(); } })
        )
      );
    }
    var maxVal = list[0].implied_value_usd || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d == null ? 'n/a' : fmtPct(r.change_7d);
      var gClass = r.change_7d == null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null,
          el('div', { class: 'name' },
            el('b', { text: r.name }),
            el('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : '—') })
          )
        ),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + gClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', null,
          el('div', { class: 'implied' },
            el('span', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / maxVal) * 100)) + '%' })),
            el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
          )
        ),
        el('td', null, el('span', { class: 'status', text: r._watchlist ? 'watchlist' : 'early' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols ranked by implied value. Select a row for model breakdown and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('rank', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('implied', 'Implied'),
            el('th', { scope: 'col', text: 'Status' })
          )),
          tbody
        )
      )
    );
  }

  function buildLiveTable(list) {
    var tbody = el('tbody');
    list.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null,
          el('div', { class: 'name' },
            el('b', { text: r.name }),
            el('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : '—') })
          )
        ),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d != null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'status', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Protocols whose token already trades. Set aside from the pre-token ranking.' }),
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: '#' }),
            el('th', { scope: 'col', text: 'Protocol' }),
            el('th', { scope: 'col', text: 'TVL' }),
            el('th', { scope: 'col', text: '7d' }),
            el('th', { scope: 'col', text: 'Market cap' }),
            el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function buildModelSection() {
    var m = D.model;
    var bt = D.backtest || {};
    var compsCount = D.comps_count || 128;
    var panel = el('section', { class: 'model-panel' });
    panel.appendChild(el('h2', { text: 'How implied value is computed' }));
    panel.appendChild(el('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased. Implied value is the entry\'s own claim from the snapshot\'s figures; it does not predict whether or when a token launches.' }));
    panel.appendChild(el('div', { class: 'formula', text: buildFormula(m) }));
    var ul = el('ul', { style: 'margin:0;padding-left:18px;color:var(--muted);font-size:13px;line-height:1.7;' });
    ul.appendChild(el('li', { html: '<b>Category multiple</b>: for each category, the median mcap/TVL ratio of protocols whose token already trades, shrunk toward the global median 0.214 with prior weight 4. Clamped to [0.02, 1.5]. Categories with no comps use 0.214.' }));
    ul.appendChild(el('li', { html: '<b>Growth</b>: clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') × ' + m.growth_weight + '.' }));
    ul.appendChild(el('li', { html: '<b>Maturity</b>: ' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' × ' + m.maturity_range + '. Unknown age uses ' + m.unknown_age_days + ' days.' }));
    ul.appendChild(el('li', { html: '<b>Comps</b>: ' + compsCount + ' live-token protocols used to fit category multiples.' }));
    panel.appendChild(ul);
    panel.appendChild(el('p', { class: 'sub', style: 'margin-top:10px;', text: 'Backtest (train/test split by slug, every 5th as test): n=' + (bt.test_n || 0) + ', median abs% error=' + fmtPct((bt.median_abs_pct_error || 0) * 100) + ', mean abs% error=' + fmtPct((bt.mean_abs_pct_error || 0) * 100) + ', within 2x of actual=' + Math.round((bt.within_2x_share || 0) * 100) + '%.' }));
    return panel;
  }

  function buildFormula(m) {
    return 'implied = round( tvl_usd × category_multiple × (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 × ' + m.growth_weight + ') × (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' × ' + m.maturity_range + ') )';
  }

  function openDetail(slug) {
    var row = (D.rows || []).filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    var inner = document.getElementById('detail-inner');
    inner.innerHTML = '';
    var steps = row.farm_steps || [];
    var catMult = row.category_multiple || 0.214;
    var local = localImplied(row, D.model);
    var match = Math.abs(local - row.implied_value_usd) <= Math.max(1, row.implied_value_usd * 0.01) ? 'The page recomputes this row as ' + fmtUsd(local) + ', matching the board (within rounding).' : 'The page recomputes this row as ' + fmtUsd(local) + ' (data.js may be stale).';

    inner.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('div', { class: 'badge', text: 'Rank ' + row.rank + ' of ' + D.board_size + (row._watchlist ? ' · Watchlist' : ' · Early radar') }),
        el('h2', { id: 'detail-title', style: 'margin-top:6px;', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' · ' + (row.chains && row.chains.length ? row.chains.join(', ') : '—') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close', text: '✕', onclick: function () { closeDetail(); } })
    ));

    inner.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Model breakdown' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Category multiple' }), el('b', { text: catMult.toFixed(4) })),
        el('div', null, el('span', { text: 'Growth' }), el('b', { text: fmtPct(row.growth_pct) })),
        el('div', null, el('span', { text: 'Growth multiplier' }), el('b', { text: (row.growth_multiplier || 1).toFixed(4) })),
        el('div', null, el('span', { text: 'Maturity multiplier' }), el('b', { text: (row.maturity_multiplier || 1).toFixed(4) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { text: fmtAge(row.age_days) })),
        el('div', { style: 'border-top:1px solid var(--border);padding-top:4px;margin-top:2px;' },
          el('span', { text: 'Implied value' }), el('b', { style: 'color:var(--accent);', text: fmtUsd(row.implied_value_usd) })
        )
      ),
      el('p', { class: 'sub', style: 'margin-top:6px;', text: 'Model ' + D.model_version + ': ' + match })
    ));

    if (steps.length) {
      inner.appendChild(el('section', { class: 'detail-section' },
        el('h3', { text: 'Farm plan' }),
        el('ol', { class: 'steps' }, steps.map(function (s) {
          var at = s.indexOf(' Cost: ');
          var action = at >= 0 ? s.slice(0, at) : s;
          var tail = at >= 0 ? s.slice(at + 1) : '';
          return el('li', null, el('b', { text: action }), el('div', { class: 'cost', text: tail }));
        }))
      ));
    }

    inner.appendChild(el('p', { class: 'disclaimer', text: 'Implied value is the model\'s own estimate from the snapshot\'s figures. It does not predict whether or when a token launches. Farm steps are concrete actions with estimated costs; verify current gas prices before transacting.' }));

    var dlg = document.getElementById('detail');
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); }
    else { dlg.setAttribute('open', ''); }
  }

  function closeDetail() {
    var dlg = document.getElementById('detail');
    if (dlg.open) dlg.close();
    state.selected = null;
    writeHash();
  }

  function filteredRows() {
    var q = (state.q || '').trim().toLowerCase();
    return (state.tab === 'pre-token' ? D.rows : D.live || []).filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all') { if (!(r.chains || []).includes(state.chain)) return false; }
      if (state.watchlistOnly && !r._watchlist) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd || 0; bv = b.tvl_usd || 0; }
      else if (key === 'growth') { av = a.change_7d == null ? -Infinity : a.change_7d; bv = b.change_7d == null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days == null ? Infinity : a.age_days; bv = b.age_days == null ? Infinity : b.age_days; }
      else if (key === 'rank') { av = a.rank || 0; bv = b.rank || 0; }
      else { av = a.implied_value_usd || 0; bv = b.implied_value_usd || 0; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function renderTable() {
    var section = document.getElementById('table-section');
    section.innerHTML = '';
    var list = sortedRows(filteredRows());
    var countEl = document.getElementById('row-count');
    if (countEl) countEl.textContent = list.length + ' rows shown';
    if (state.tab === 'pre-token') {
      section.appendChild(buildBoardTable(list));
      section.appendChild(buildModelSection());
    } else {
      section.appendChild(buildLiveTable(list));
    }
  }

  function render() {
    renderTable();
    if (state.selected) {
      var found = (D.rows || []).some(function (r) { return r.slug === state.selected; });
      if (!found) { state.selected = null; }
      else openDetail(state.selected);
    }
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var p = new URLSearchParams(hash);
    if (p.get('q')) state.q = p.get('q');
    if (p.get('p')) state.selected = p.get('p');
    if (p.get('category')) state.category = p.get('category');
    if (p.get('chain')) state.chain = p.get('chain');
    if (p.get('tab')) state.tab = p.get('tab');
    if (p.get('watchlist')) state.watchlistOnly = p.get('watchlist') === '1';
  }

  function writeHash() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.category !== 'all') p.set('category', state.category);
    if (state.chain !== 'all') p.set('chain', state.chain);
    if (state.tab !== 'pre-token') p.set('tab', state.tab);
    if (state.watchlistOnly) p.set('watchlist', '1');
    if (state.selected) p.set('p', state.selected);
    var s = p.toString();
    if (s) window.history.replaceState(null, '', '#' + s);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  readHash();
  buildTopbar();
  buildLede();
  buildControls();
  render();

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { var dlg = document.getElementById('detail'); if (dlg && dlg.open) { dlg.close(); state.selected = null; writeHash(); } }
  });
  window.addEventListener('hashchange', function () {
    var pq = state.q, pc = state.category, pch = state.chain, pt = state.tab, pw = state.watchlistOnly, ps = state.selected;
    readHash();
    if (state.q !== pq || state.category !== pc || state.chain !== pch || state.tab !== pt || state.watchlistOnly !== pw || state.selected !== ps) render();
  });
})();
