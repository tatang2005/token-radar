// Token Radar's plain dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the ranked board, a filterable table, a per-protocol detail view with the model's own inputs
// and the protocol's farm plan, and a separate Live view for the protocols whose token already trades.
// No network: every byte it shows is in data.js.
//
// The model, in this file as in lib/model.ts, so the page's code and the board's data are visibly the
// same arithmetic: the page recomputes a row's implied value from the snapshot's figures and shows the
// factors, so the number board.json carries can be checked here.
//
//   multiple = the category's shrunk FDV/TVL median (data.model.multiples), else the global median
//   growth   = 1 + clamp(change_7d / 100, -0.5, 1.0); a missing 7d change counts as 0
//   age      = 1 + min(age_years, 3) * 0.08; age_years from listed_at to as_of; a missing date is 1
//   chains   = 1 + min(chains.length - 1, 8) * 0.015
//   implied  = round(tvl_usd * multiple * growth * age * chains)
(function () {
  'use strict';

  var DATA = window.RADAR;
  var boardEl = document.getElementById('board');
  var detailEl = document.getElementById('detail');
  var countEl = document.getElementById('count');
  var qEl = document.getElementById('q');
  var catEl = document.getElementById('category');
  var chainEl = document.getElementById('chain');
  var tabBoard = document.getElementById('tab-board');
  var tabLive = document.getElementById('tab-live');
  if (!DATA || !boardEl) return;

  var state = { q: '', category: 'all', chain: 'all', tab: 'board', sort: 'rank', dir: 1, selected: null };

  function $(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) {
        if (c === null || c === undefined) return;
        if (typeof c === 'string') node.appendChild(document.createTextNode(c));
        else node.appendChild(c);
      });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
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
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /* The model's four factors, recomputed from a row's snapshot figures. */
  function factorsOf(row) {
    var mult = DATA.model.multiples[row.category || 'Uncategorized'];
    if (mult === undefined) mult = DATA.model.global_median;
    var growth = 1 + clamp((row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d) / 100, -0.5, 1.0);
    var age = row.age_days === null || row.age_days === undefined ? 1 : 1 + Math.min(row.age_days / 365.25, 3) * 0.08;
    var chains = 1 + Math.min(Math.max((row.chains || []).length - 1, 0), 8) * 0.015;
    return { multiple: mult, growth: growth, age: age, chains: chains, implied: Math.max(1, Math.round(row.tvl_usd * mult * growth * age * chains)) };
  }

  function bySlug(slug) {
    for (var i = 0; i < DATA.rows.length; i++) if (DATA.rows[i].slug === slug) return DATA.rows[i];
    return null;
  }

  /* Header, meta and the model box: the model's own words, from the data it runs on. */
  (function head() {
    var meta = document.getElementById('meta');
    if (meta) meta.textContent = 'Snapshot ' + DATA.as_of + '  ·  ' + DATA.board_size + ' protocols ranked' +
      '  ·  watchlist ' + DATA.watchlist_size + '  ·  ' + DATA.live.length + ' already trading';
    var model = document.getElementById('model');
    if (model) {
      model.innerHTML = '';
      model.appendChild($('span', {}, [
        $('b', { text: 'How the value is modelled: ' }),
        document.createTextNode('implied value = TVL \u00d7 the category\u2019s FDV/TVL multiple \u00d7 growth \u00d7 age \u00d7 chains. '),
        document.createTextNode('The multiple is the category\u2019s median market-cap/TVL among the snapshot\u2019s own tokenized protocols, shrunk toward the global median '),
        $('code', { text: 'x' + DATA.model.global_median.toFixed(3) }),
        document.createTextNode(' with a prior weight of ' + DATA.model.prior_weight + ', clamped to ' + DATA.model.clamp_low + '\u2013' + DATA.model.clamp_high + '. '),
        document.createTextNode('Growth uses the 7-day TVL change; age counts the years a protocol has run with no token; chains counts its live chains. '),
        document.createTextNode('No protocol name is special-cased: the same arithmetic scores every row.'),
      ]));
    }
    var foot = document.getElementById('foot');
    if (foot) foot.textContent = 'Model ' + DATA.model_version + '  ·  Data: DefiLlama protocol snapshot of ' + DATA.as_of + '  ·  Watchlist floor $' + DATA.floor_usd.toLocaleString('en-US');
  })();

  /* The filter dropdowns, from the board's own categories and chains. */
  (function fillFilters() {
    var cats = {};
    var chains = {};
    DATA.rows.forEach(function (r) {
      if (r.category) cats[r.category] = true;
      (r.chains || []).forEach(function (c) { chains[c] = true; });
    });
    Object.keys(cats).sort().forEach(function (c) { catEl.appendChild($('option', { value: c, text: c })); });
    Object.keys(chains).sort().forEach(function (c) { chainEl.appendChild($('option', { value: c, text: c })); });
  })();

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    var rows = DATA.rows.filter(function (r) {
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && !(r.chains || []).includes(state.chain)) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var key = state.sort;
    var dir = state.dir;
    rows.sort(function (a, b) {
      var va, vb;
      if (key === 'rank') { va = a.rank; vb = b.rank; }
      else if (key === 'name') { va = a.name.toLowerCase(); vb = b.name.toLowerCase(); }
      else if (key === 'category') { va = (a.category || '').toLowerCase(); vb = (b.category || '').toLowerCase(); }
      else if (key === 'tvl') { va = a.tvl_usd; vb = b.tvl_usd; }
      else if (key === 'change') { va = a.change_7d === null ? -Infinity : a.change_7d; vb = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { va = a.age_days === null ? -1 : a.age_days; vb = b.age_days === null ? -1 : b.age_days; }
      else { va = a.implied_value_usd; vb = b.implied_value_usd; }
      if (va < vb) return -dir;
      if (va > vb) return dir;
      return a.rank - b.rank;
    });
    return rows;
  }

  function sortTh(label, key, cls) {
    var th = $('th', { text: label, class: cls || '' });
    if (state.sort === key) th.setAttribute('aria-sort', state.dir === 1 ? 'ascending' : 'descending');
    th.addEventListener('click', function () {
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = key === 'name' || key === 'category' ? 1 : -1; }
      render();
    });
    return th;
  }

  function renderBoard() {
    boardEl.innerHTML = '';
    var rows = filteredRows();
    var table = $('table');
    var head = $('tr', {},
      sortTh('#', 'rank', 'num'),
      sortTh('Protocol', 'name'),
      sortTh('Category', 'category'),
      sortTh('Chains', 'chain', 'chains'),
      sortTh('TVL', 'tvl', 'num'),
      sortTh('7d', 'change', 'num'),
      sortTh('Age', 'age', 'num'),
      sortTh('Implied value', 'implied', 'num'));
    table.appendChild($('thead', {}, head));
    var body = $('tbody');
    if (rows.length === 0) {
      body.appendChild($('tr', {}, $('td', { colspan: '8', class: 'empty', text: 'No protocol matches this filter.' })));
    }
    rows.forEach(function (r) {
      var tr = $('tr', { class: state.selected === r.slug ? 'selected' : '' });
      tr.addEventListener('click', function () { select(r.slug); });
      var chg = $('td', { class: 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) });
      tr.appendChild($('td', { class: 'num', text: String(r.rank) }));
      tr.appendChild($('td', { class: 'name' }, [r.name, $('small', { text: r.slug })]));
      tr.appendChild($('td', { text: r.category || '—' }));
      tr.appendChild($('td', { class: 'chains', text: (r.chains || []).join(', ') || '—' }));
      tr.appendChild($('td', { class: 'num', text: fmtUsd(r.tvl_usd) }));
      tr.appendChild(chg);
      tr.appendChild($('td', { class: 'num', text: fmtAge(r.age_days) }));
      tr.appendChild($('td', { class: 'num imp', text: fmtUsd(r.implied_value_usd) }));
      body.appendChild(tr);
    });
    table.appendChild(body);
    boardEl.appendChild(table);
    countEl.textContent = rows.length + ' of ' + DATA.rows.length + ' protocols shown' +
      (state.selected ? '  ·  detail open for ' + state.selected : '');
  }

  function renderLive() {
    boardEl.innerHTML = '';
    var table = $('table');
    table.appendChild($('thead', {}, $('tr', {},
      $('th', { class: 'num', text: '#' }),
      $('th', { text: 'Protocol' }),
      $('th', { text: 'Category' }),
      $('th', { class: 'num', text: 'TVL' }),
      $('th', { class: 'num', text: 'Market cap' }),
      $('th', { class: 'num', text: 'FDV / TVL' }),
      $('th', { class: 'num', text: '7d' }))));
    var body = $('tbody');
    DATA.live.forEach(function (r, i) {
      var ratio = r.tvl_usd > 0 && r.mcap_usd !== null ? (r.mcap_usd / r.tvl_usd).toFixed(2) + 'x' : 'n/a';
      var tr = $('tr', {});
      tr.appendChild($('td', { class: 'num', text: String(i + 1) }));
      tr.appendChild($('td', { class: 'name' }, [r.name, $('small', { text: r.slug })]));
      tr.appendChild($('td', { text: r.category || '—' }));
      tr.appendChild($('td', { class: 'num', text: fmtUsd(r.tvl_usd) }));
      tr.appendChild($('td', { class: 'num', text: fmtUsd(r.mcap_usd) }));
      tr.appendChild($('td', { class: 'num', text: ratio }));
      tr.appendChild($('td', { class: 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }));
      body.appendChild(tr);
    });
    table.appendChild(body);
    boardEl.appendChild(table);
    countEl.textContent = DATA.live.length + ' protocols whose token already trades — listed for comparison, never ranked in the board.';
  }

  function renderDetail() {
    var row = state.selected ? bySlug(state.selected) : null;
    detailEl.innerHTML = '';
    if (!row) { detailEl.hidden = true; return; }
    detailEl.hidden = false;
    var f = factorsOf(row);
    var close = $('button', { class: 'close', text: 'Close ×' });
    close.addEventListener('click', function () { select(null); });
    var head = $('div', {}, [
      close,
      $('h2', {}, [row.name, $('small', { text: row.slug + '  ·  rank #' + row.rank })]),
      $('div', { class: 'facts' }, [
        $('span', {}, ['Category: ', $('b', { text: row.category || '—' })]),
        $('span', {}, ['Chains: ', $('b', { text: (row.chains || []).join(', ') || '—' })]),
        $('span', {}, ['TVL: ', $('b', { text: fmtUsd(row.tvl_usd) })]),
        $('span', {}, ['7d: ', $('b', { text: fmtPct(row.change_7d) })]),
        $('span', {}, ['Listed: ', $('b', { text: row.listed_at || 'unknown' })]),
        $('span', {}, ['Age: ', $('b', { text: fmtAge(row.age_days) })]),
      ]),
    ]);
    var ft = $('table', { class: 'factors' });
    var fb = $('tbody');
    fb.appendChild($('tr', {}, $('td', { text: 'TVL' }), $('td', { text: fmtUsd(row.tvl_usd) })));
    fb.appendChild($('tr', {}, $('td', { text: 'Category multiple (' + (row.category || 'Uncategorized') + ')' }), $('td', { text: '×' + f.multiple.toFixed(3) })));
    fb.appendChild($('tr', {}, $('td', { text: 'Growth factor (7d ' + fmtPct(row.change_7d) + ')' }), $('td', { text: '×' + f.growth.toFixed(3) })));
    fb.appendChild($('tr', {}, $('td', { text: 'Age factor (' + fmtAge(row.age_days) + ' with no token)' }), $('td', { text: '×' + f.age.toFixed(3) })));
    fb.appendChild($('tr', {}, $('td', { text: 'Chain factor (' + (row.chains || []).length + ' chain' + ((row.chains || []).length === 1 ? '' : 's') + ')' }), $('td', { text: '×' + f.chains.toFixed(3) })));
    fb.appendChild($('tr', { class: 'total' }, $('td', { text: 'Implied value' }), $('td', { text: fmtUsd(f.implied) })));
    ft.appendChild(fb);
    var steps = $('ol');
    (row.farm_steps || []).forEach(function (s) { steps.appendChild($('li', { text: s })); });
    detailEl.appendChild(head);
    detailEl.appendChild($('h3', { text: 'How the value is built' }));
    detailEl.appendChild(ft);
    detailEl.appendChild($('h3', { text: 'Farm plan — what to do, what it costs, how long it takes' }));
    detailEl.appendChild(steps);
    detailEl.scrollIntoView({ block: 'nearest' });
  }

  function select(slug) {
    state.selected = slug;
    var hash = slug ? '#detail=' + slug : '';
    if (window.history && window.history.replaceState) {
      if (hash) window.history.replaceState(null, '', hash);
      else window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    render();
  }

  function render() {
    tabBoard.setAttribute('aria-selected', state.tab === 'board' ? 'true' : 'false');
    tabLive.setAttribute('aria-selected', state.tab === 'live' ? 'true' : 'false');
    if (state.tab === 'live') { detailEl.hidden = true; renderLive(); }
    else { renderBoard(); renderDetail(); }
  }

  /* Deep links: #detail=<slug>, #q=<text>, #category=<name>, #chain=<name> — so a filtered view or a
     detail view opens straight from its link, which is how the screenshots are taken. */
  (function fromHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    hash.split('&').forEach(function (part) {
      var kv = part.split('=');
      var k = kv[0];
      var v = kv[1] ? decodeURIComponent(kv[1]) : '';
      if (k === 'detail' && bySlug(v)) state.selected = v;
      else if (k === 'q') { state.q = v; qEl.value = v; }
      else if (k === 'category') { state.category = v; catEl.value = v; }
      else if (k === 'chain') { state.chain = v; chainEl.value = v; }
      else if (k === 'tab' && (v === 'board' || v === 'live')) state.tab = v;
    });
  })();

  qEl.addEventListener('input', function () { state.q = qEl.value; render(); });
  catEl.addEventListener('change', function () { state.category = catEl.value; render(); });
  chainEl.addEventListener('change', function () { state.chain = chainEl.value; render(); });
  tabBoard.addEventListener('click', function () { state.tab = 'board'; render(); });
  tabLive.addEventListener('click', function () { state.tab = 'live'; render(); });
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.selected) select(null); });

  render();
})();
