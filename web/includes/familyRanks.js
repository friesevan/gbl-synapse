(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const form = $('comparisonForm');
  const names = Object.keys(pokeListObj);
  const display = name => name.replace(/_/g, ' ');
  const normalize = name => name.trim().replace(/_/g, ' ').toLowerCase();
  const resolve = value => names.find(name => normalize(name) === normalize(value));
  const params = new URLSearchParams(location.search);
  let familySignature = '', generation = 0, pending = 0;
  let worker, rows = [], settings = {}, selectedLeagues = [];
  const columnPrefs = new Map();
  let choices = [], pickerSignature = '';
  const leagueName = league => FamilyRanks.leagues.find(item => item[0] === league)[1];
  const colKey = FamilyRanks.columnKey;
  function addIVRow(values = ['', '', '']) {
    const row = document.createElement('div'); row.className = 'iv-entry inputs';
    const number = document.createElement('strong'); number.className = 'entry-number'; row.append(number);
    for (const [i, stat] of ['Attack', 'Defense', 'Stamina', 'Current CP'].entries()) {
      const label = document.createElement('label'); label.textContent = i === 3 ? stat : stat + ' IV';
      const input = document.createElement('input');
      input.type = 'number'; input.min = i === 3 ? '10' : '0'; if (i < 3) input.max = '15'; input.step = '1';
      input.required = i < 3; input.placeholder = i === 3 ? 'Optional' : '0–15'; input.value = values[i] ?? '';
      input.dataset.stat = stat; label.append(input); row.append(label);
    }
    const remove = document.createElement('button'); remove.type = 'button';
    remove.className = 'secondary remove-entry'; remove.textContent = 'Remove';
    remove.addEventListener('click', () => { row.remove(); numberRows(); invalidate(); });
    const level = document.createElement('span'); level.className = 'entry-level'; level.setAttribute('aria-live', 'polite'); row.append(level, remove); $('ivRows').append(row); numberRows(); refreshLevels();
  }
  function refreshLevels() {
    const mon = resolve($('pokemon').value);
    for (const row of $('ivRows').children) {
      const values = [...row.querySelectorAll('input')].map(input => input.value);
      const output = row.querySelector('.entry-level'); output.classList.remove('level-warning');
      if (!values[3].trim()) { output.textContent = 'Current level not checked'; continue; }
      if (!mon) { output.textContent = 'Select a base Pokémon to infer level'; continue; }
      const parsed = FamilyRanks.candidatesFromRows([values], mon);
      if (parsed.errors.length) { output.textContent = '⚠ ' + parsed.errors[0].replace('Entry 1: ', ''); output.classList.add('level-warning'); continue; }
      const info = FamilyRanks.inferLevels(parsed.candidates[0], pokeListObj, cpm);
      output.textContent = info.error ? '⚠ ' + info.error : levelLabel(info.levels);
      output.classList.toggle('level-warning', !!info.error);
    }
  }
  function levelLabel(levels) {
    return levels.length === 1 ? 'Current level: ' + levels[0] : 'Possible levels: ' + levels[0] + '–' + levels[levels.length - 1];
  }
  function numberRows() {
    const entries = [...$('ivRows').children];
    entries.forEach((row, i) => {
      row.querySelector('.entry-number').textContent = 'Entry ' + (i + 1);
      row.querySelectorAll('input').forEach(input => input.setAttribute('aria-label', input.dataset.stat + (input.dataset.stat === 'Current CP' ? ' entry ' : ' IV entry ') + (i + 1)));
      const remove = row.querySelector('button'); remove.disabled = entries.length === 1;
      remove.setAttribute('aria-label', 'Remove entry ' + (i + 1));
    });
  }
  $('addIVRow').addEventListener('click', () => {
    addIVRow(); invalidate(); $('ivRows').lastElementChild.querySelector('input').focus();
  });
  let sortColumn = '', showBestOnly = false;
  function toggle(parent, value, label, checked) {
    const wrapper = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox'; input.value = value; input.checked = checked;
    wrapper.append(input, document.createTextNode(label)); parent.append(wrapper);
  }
  for (const name of names) {
    const option = document.createElement('option'); option.value = display(name);
    $('pokemonNames').append(option);
  }
  for (const [value, label] of FamilyRanks.leagues) {
    toggle($('leagues'), value, label + (value === 'ML' ? ' · Unlimited' : ' · ' + value + ' CP'),
      !params.has('leagues') || params.get('leagues').split(',').includes(value));
  }
  function selection(id) {
    return [...$(id).querySelectorAll('input:checked')].map(input => input.value);
  }
  function syncFamily() {
    const mon = resolve($('pokemon').value);
    const signature = mon || '';
    if (signature === familySignature) return;
    const old = new Map([...$('evolutions').querySelectorAll('input')].map(input => [input.value, input.checked]));
    familySignature = signature;
    columnPrefs.clear(); choices = []; pickerSignature = '';
    $('evolutions').replaceChildren();
    const evos = mon ? FamilyRanks.family(mon, pokeListObj) : [];
    for (const evo of evos) toggle($('evolutions'), evo, display(evo), old.has(evo) ? old.get(evo) : true);
    if (!evos.length) $('evolutions').textContent = 'Choose a base Pokémon to show its family.';
    syncColumnPicker();
  }
  function message(text) { $('status').textContent = text; }
  function invalidate(clearChoices = true) {
    generation++; rows = []; $('results').replaceChildren(); $('recommendations').replaceChildren(); $('inputErrors').replaceChildren();
    if (clearChoices) choices = [];
    message('Update your selection, then compare IVs.');
  }
  function visibleColumns() {
    const mon = resolve($('pokemon').value), enabledEvos = selection('evolutions'), enabledLeagues = selection('leagues');
    return (mon ? FamilyRanks.family(mon, pokeListObj) : []).flatMap(evo => enabledEvos.includes(evo) ?
      enabledLeagues.filter(league => columnPrefs.get(colKey(evo, league)) !== false).map(league => ({evo, league})) : []);
  }
  function syncColumnPicker(force = false) {
    const mon = resolve($('pokemon').value), evos = selection('evolutions'), leagues = selection('leagues');
    const signature = JSON.stringify([mon, evos, leagues]);
    if (!force && signature === pickerSignature) return;
    pickerSignature = signature; $('columnPicker').replaceChildren();
    if (!mon) { $('columnPicker').textContent = 'Select a base Pokémon first.'; return; }
    const table = document.createElement('table'); table.className = 'column-picker-table';
    const header = table.createTHead().insertRow();
    for (const title of ['Evolution', ...FamilyRanks.leagues.map(item => item[1])]) {
      const th = document.createElement('th'); th.scope = 'col'; th.textContent = title; header.append(th);
    }
    const body = table.createTBody();
    for (const evo of FamilyRanks.family(mon, pokeListObj)) {
      const tr = body.insertRow(), th = document.createElement('th'); th.scope = 'row'; th.textContent = display(evo); tr.append(th);
      for (const [league, name] of FamilyRanks.leagues) {
        const td = tr.insertCell(), input = document.createElement('input'); input.type = 'checkbox';
        input.checked = columnPrefs.get(colKey(evo, league)) !== false;
        input.disabled = !evos.includes(evo) || !leagues.includes(league);
        input.setAttribute('aria-label', 'Show ' + display(evo) + ' ' + name + ' League column');
        input.addEventListener('change', () => {
          columnPrefs.set(colKey(evo, league), input.checked);
          if (rows.length && !pending) { render(); updateURL(); }
          else message('Column selection updated. Compare IVs to build your report.');
        }); td.append(input);
      }
    }
    $('columnPicker').append(table);
  }
  function currentSearch() {
    const mon = resolve($('pokemon').value);
    const ivs = [...$('ivRows').children].map(row => [...row.querySelectorAll('input')].map(input => input.value));
    const parsed = FamilyRanks.candidatesFromRows(ivs, mon);
    if (parsed.errors.length) throw new Error(parsed.errors.join(' '));
    const state = {mon, ivs: parsed.candidates.map(item => item.ivs), columns: visibleColumns().map(item => [item.evo, item.league]),
      cps: parsed.candidates.map(item => item.currentCp), floor: Number($('floor').value), min: Number($('min').value), max: Number($('max').value), choices};
    return FamilyRanks.importSearch(FamilyRanks.exportSearch(state), pokeListObj);
  }
  function updateURL() {
    try {
      const state = currentSearch();
      const query = new URLSearchParams({mon: state.mon, IVs: state.ivs.map(ivs => ivs.join('_')).join(','),
        leagues: selection('leagues').join(','), evos: selection('evolutions').join(','),
        floor: state.floor, min: state.min, max: state.max, cols: JSON.stringify(state.columns)});
      if (state.cps.some(cp => cp !== null)) query.set('cps', JSON.stringify(state.cps));
      if (choices.length) query.set('choices', JSON.stringify(choices));
      history.replaceState(null, '', '?' + query);
    } catch (_) { /* Empty/unfinished forms have no searchable URL yet. */ }
  }
  function applySearch(state) {
    $('pokemon').value = display(state.mon); syncFamily();
    $('ivRows').replaceChildren(); state.ivs.forEach((ivs, i) => addIVRow([...ivs, state.cps?.[i] ?? '']));
    for (const id of ['floor', 'min', 'max']) $(id).value = state[id];
    // Restore the exact column selection; broad toggles can still select whole families/leagues.
    $('evolutions').querySelectorAll('input').forEach(input => { input.checked = true; });
    $('leagues').querySelectorAll('input').forEach(input => { input.checked = true; });
    const enabled = new Set(state.columns.map(item => JSON.stringify(item)));
    for (const evo of FamilyRanks.family(state.mon, pokeListObj)) for (const [league] of FamilyRanks.leagues)
      columnPrefs.set(colKey(evo, league), enabled.has(colKey(evo, league)));
    choices = state.choices; syncColumnPicker(true); compare();
  }
  $('exportSearch').addEventListener('click', () => {
    try { $('searchString').value = FamilyRanks.exportSearch(currentSearch()); $('saveStatus').textContent = 'Search exported. Copy the string into a text note.'; }
    catch (error) { $('saveStatus').textContent = error.message; }
  });
  $('copySearch').addEventListener('click', async () => {
    if (!$('searchString').value.trim()) { $('saveStatus').textContent = 'Export a search first.'; return; }
    try { await navigator.clipboard.writeText($('searchString').value); $('saveStatus').textContent = 'Search string copied.'; }
    catch (_) { $('searchString').focus(); $('searchString').select(); $('saveStatus').textContent = 'Select and copy the search string manually.'; }
  });
  $('loadSearch').addEventListener('click', () => {
    try { const state = FamilyRanks.importSearch($('searchString').value, pokeListObj); applySearch(state); $('saveStatus').textContent = 'Search restored.'; }
    catch (error) { $('saveStatus').textContent = error.message; }
  });
  function detailLink(mon, league, ivs) {
    const query = new URLSearchParams({mon, cp: league, IVs: ivs.join('_'),
      f: settings.floor, min: settings.min, max: settings.max});
    const link = document.createElement('a'); link.href = 'index.html?' + query;
    link.textContent = 'Full rankings'; return link;
  }
  function drawPlan(plan, count) {
    const host = $('recommendations'); host.replaceChildren();
    const heading = document.createElement('h2'); heading.textContent = 'Recommended evolution plan'; host.append(heading);
    const summary = document.createElement('p'); summary.textContent = plan.assignments.length + ' of ' + count + ' slots covered · Combined IV rank ' + plan.totalRank;
    host.append(summary);
    const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = 'Each unique IV spread can fill one slot. The plan maximizes slots covered, then minimizes the sum of IV ranks. It respects your chosen cells. Hidden columns are excluded.'; host.append(hint);
    const list = document.createElement('ul'); list.className = 'plan-list';
    for (const item of plan.assignments) {
      const li = document.createElement('li');
      const text = document.createElement('span'); text.textContent = item.candidate.ivs.join(' / ') + ' → ' + display(item.evo) + ' · ' + leagueName(item.league) + ' · #' + item.result.rank + (item.locked ? ' · Your choice' : '');
      const action = document.createElement('button'); action.type = 'button'; action.className = 'secondary'; action.textContent = item.locked ? 'Release' : 'Lock choice';
      action.addEventListener('click', () => {
        if (item.locked) choices = choices.filter(choice => colKey(choice.evo, choice.league) !== colKey(item.evo, item.league));
        else choices.push({ivs: item.candidate.ivs, evo: item.evo, league: item.league});
        render(); updateURL();
      }); li.append(text, action); list.append(li);
    }
    host.append(list);
    if (plan.unfilled.length) {
      const details = document.createElement('details'), summary = document.createElement('summary');
      summary.textContent = plan.unfilled.length + ' unfilled slots'; details.append(summary);
      const missing = document.createElement('ul'); missing.className = 'plan-list';
      for (const slot of plan.unfilled) {
        const li = document.createElement('li'); li.className = 'unfilled-slot'; li.textContent = display(slot.evo) + ' · ' + leagueName(slot.league) + ' · No spread allocated'; missing.append(li);
      }
      details.append(missing); host.append(details);
    }
    if (plan.unused.length) { const unused = document.createElement('p'); unused.className = 'hint'; unused.textContent = 'Unallocated spreads: ' + plan.unused.map(item => item.ivs.join('/')).join(', '); host.append(unused); }
    if (choices.length) {
      const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'secondary'; reset.textContent = 'Release all choices';
      reset.addEventListener('click', () => { choices = []; render(); updateURL(); }); host.append(reset);
    }
  }
  function render() {
    const priorScroll = $('results').querySelector('.table-scroll')?.scrollLeft || 0;
    const priorFocus = document.activeElement?.dataset.focusKey;
    rows = FamilyRanks.markBest(rows);
    $('results').replaceChildren();
    const columns = visibleColumns().map(column => [colKey(column.evo, column.league), column]);
    const visibleKeys = new Set(columns.map(([key]) => key));
    const activeRows = rows.filter(row => visibleKeys.has(colKey(row.evo, row.league)));
    const previousChoices = choices.length;
    choices = choices.filter(choice => visibleKeys.has(colKey(choice.evo, choice.league)) && activeRows.some(row =>
      row.result && row.evo === choice.evo && row.league === choice.league && row.candidate.ivs.join('/') === choice.ivs.join('/')));
    const allCandidates = [...new Map(rows.map(row => [row.candidate.key, row.candidate])).values()];
    const plan = FamilyRanks.allocate(allCandidates, columns.map(([, column]) => column), activeRows, choices);
    const recommended = new Map(plan.assignments.map(item => [JSON.stringify([item.candidate.key, item.evo, item.league]), item]));
    drawPlan(plan, columns.length);
    if (choices.length < previousChoices) {
      const notice = document.createElement('p'); notice.className = 'hint';
      notice.textContent = (previousChoices - choices.length) + ' choices released because their columns were hidden or their spreads became unavailable.';
      $('recommendations').prepend(notice);
    }
    if (!columns.length) { $('results').textContent = 'No columns selected. Re-check combinations above to rebuild the report.'; return; }
    if (!columns.some(([key]) => key === sortColumn)) sortColumn = '';
    const candidates = allCandidates;
    const cells = new Map(rows.map(row => [JSON.stringify([row.candidate.key, row.evo, row.league]), row]));
    const section = document.createElement('section'); section.className = 'matrix-results';
    const toolbar = document.createElement('div'); toolbar.className = 'matrix-toolbar';
    const heading = document.createElement('h2'); heading.textContent = 'IV comparison';
    const label = document.createElement('label'); label.textContent = 'Sort rows by ';
    const sort = document.createElement('select');
    const original = document.createElement('option'); original.value = ''; original.textContent = 'Entry order'; sort.append(original);
    for (const [key, column] of columns) {
      const option = document.createElement('option'); option.value = key;
      option.textContent = display(column.evo) + ' · ' + FamilyRanks.leagues.find(item => item[0] === column.league)[1]; sort.append(option);
    }
    sort.value = sortColumn; label.append(sort);
    const filterLabel = document.createElement('label');
    const filter = document.createElement('input'); filter.type = 'checkbox'; filter.checked = showBestOnly;
    filterLabel.append(filter, document.createTextNode(' Show winners and recommended spreads'));
    const container = document.createElement('div'); container.className = 'table-scroll';
    container.tabIndex = 0; container.setAttribute('aria-label', 'Scrollable IV comparison table');
    toolbar.append(heading, label, filterLabel); section.append(toolbar, container); $('results').append(section);
    function drawTable() {
      container.replaceChildren();
      let ordered = FamilyRanks.sortCandidates(candidates, activeRows, sortColumn);
      if (showBestOnly) {
        const winningKeys = new Set([...activeRows.filter(row => row.best).map(row => row.candidate.key), ...plan.assignments.map(item => item.candidate.key)]);
        ordered = ordered.filter(candidate => winningKeys.has(candidate.key));
      }
      if (!ordered.length) { container.textContent = 'No eligible winning IV spreads for this selection.'; return; }
      const table = document.createElement('table'); table.className = 'comparison-matrix'; table.style.width = (columns.length + 1) * 190 + 'px';
      const caption = document.createElement('caption'); caption.textContent = display(candidates[0].mon) + ' · ' + candidates.length + ' unique IV spreads'; table.append(caption);
      const widths = document.createElement('colgroup');
      for (let i = 0; i <= columns.length; i++) { const col = document.createElement('col'); col.style.width = '190px'; widths.append(col); }
      table.append(widths);
      const thead = table.createTHead();
      const familyHead = thead.insertRow(), leagueHead = thead.insertRow();
      const corner = document.createElement('th'); corner.rowSpan = 2; corner.scope = 'col'; corner.className = 'iv-column'; corner.textContent = 'Attack / Defense / Stamina'; familyHead.append(corner);
      const families = [...new Set(columns.map(([, column]) => column.evo))];
      for (const evo of families) {
        const th = document.createElement('th'); th.scope = 'colgroup'; th.colSpan = columns.filter(([, column]) => column.evo === evo).length;
        th.textContent = display(evo); familyHead.append(th);
      }
      for (const [key, column] of columns) {
        const th = document.createElement('th'); th.scope = 'col';
        const leagueName = FamilyRanks.leagues.find(item => item[0] === column.league)[1];
        const button = document.createElement('button'); button.type = 'button'; button.className = 'column-sort';
        button.textContent = leagueName + (key === sortColumn ? ' ↑' : ' ↕');
        button.setAttribute('aria-label', 'Sort by ' + display(column.evo) + ' ' + leagueName + ' League ranking');
        th.setAttribute('aria-sort', key === sortColumn ? 'ascending' : 'none');
        button.addEventListener('click', () => { sortColumn = key; sort.value = key; drawTable(); });
        const hide = document.createElement('button'); hide.type = 'button'; hide.className = 'hide-column'; hide.textContent = '×';
        hide.setAttribute('aria-label', 'Hide ' + display(column.evo) + ' ' + leagueName + ' League column');
        hide.addEventListener('click', () => { columnPrefs.set(key, false); syncColumnPicker(true); render(); updateURL(); });
        th.append(button, hide); leagueHead.append(th);
      }
      const body = table.createTBody();
      for (const candidate of ordered) {
        const tr = body.insertRow();
        const ivs = document.createElement('th'); ivs.scope = 'row'; ivs.className = 'iv-column';
        const spread = document.createElement('strong'); spread.textContent = candidate.ivs.join(' / ');
        const entries = document.createElement('span'); entries.className = 'entry-reference';
        entries.textContent = (candidate.entryKeys.length === 1 ? 'Entry ' : 'Entries ') + candidate.entryKeys.join(', ');
        const level = document.createElement('span'); level.className = 'entry-reference'; level.textContent = candidate.currentCp == null ? 'Current CP not provided' : candidate.currentCp + ' CP · ' + (candidate.currentLevels?.length ? levelLabel(candidate.currentLevels) : 'Level unavailable');
        ivs.append(spread, entries, level); tr.append(ivs);
        for (const [, column] of columns) {
          const row = cells.get(JSON.stringify([candidate.key, column.evo, column.league]));
          const cell = tr.insertCell();
          if (row.best) cell.className = 'best-candidate';
          if (row.result) {
            cell.classList.add('rated-cell'); cell.style.setProperty('--rating-hue', (FamilyRanks.percentile(row.result) * 1.3).toFixed(1));
            const assignment = recommended.get(JSON.stringify([candidate.key, column.evo, column.league]));
            if (assignment) cell.classList.add(assignment.locked ? 'chosen-cell' : 'recommended-cell');
            const choose = document.createElement('button'); choose.type = 'button'; choose.className = 'choose-cell';
            choose.dataset.focusKey = JSON.stringify([candidate.key, column.evo, column.league]);
            choose.setAttribute('aria-pressed', String(!!assignment && assignment.locked));
            choose.setAttribute('aria-label', (assignment && assignment.locked ? 'Release ' : 'Choose ') + candidate.ivs.join('/') + ' for ' + display(column.evo) + ' ' + leagueName(column.league) + ' League, rank ' + row.result.rank);
            const rank = document.createElement('strong'); rank.textContent = '#' + row.result.rank + ' / ' + row.result.total;
            const rating = document.createElement('span'); rating.textContent = row.result.perfection.toFixed(2) + '% stat product';
            const stats = document.createElement('span'); stats.textContent = 'L' + row.result.level + ' · ' + row.result.cp + ' CP';
            choose.append(rank, rating, stats);
            if (row.best) { const badge = document.createElement('span'); badge.className = 'winner-badge'; badge.textContent = '★ Best in column'; choose.append(badge); }
            if (assignment) { const badge = document.createElement('span'); badge.className = 'plan-badge'; badge.textContent = assignment.locked ? '✓ Your choice' : '◇ Recommended'; choose.append(badge); }
            choose.addEventListener('click', () => {
              const same = choices.some(choice => choice.evo === column.evo && choice.league === column.league && choice.ivs.join('/') === candidate.ivs.join('/'));
              choices = choices.filter(choice => colKey(choice.evo, choice.league) !== colKey(column.evo, column.league) && choice.ivs.join('/') !== candidate.ivs.join('/'));
              if (!same) choices.push({ivs: candidate.ivs, evo: column.evo, league: column.league});
              render(); updateURL();
            });
            cell.append(choose, detailLink(column.evo, column.league, candidate.ivs));
          } else {
            const unavailable = document.createElement('div'); unavailable.className = 'unavailable-cell';
            const title = document.createElement('strong'); title.textContent = 'Unavailable';
            const reason = document.createElement('span'); reason.className = 'unavailable-reason'; reason.textContent = row.error || 'Exceeds CP limit at minimum level';
            unavailable.append(title, reason); cell.append(unavailable);
          }
        }
      }
      container.append(table);
    }
    sort.addEventListener('change', () => { sortColumn = sort.value; drawTable(); });
    filter.addEventListener('change', () => { showBestOnly = filter.checked; drawTable(); });
    drawTable();
    container.scrollLeft = priorScroll;
    if (priorFocus) [...container.querySelectorAll('button')].find(button => button.dataset.focusKey === priorFocus)?.focus({preventScroll: true});
  }
  function compare() {
    invalidate(false);
    if (!form.reportValidity()) { message('Check the highlighted field. Each IV entry needs three integers from 0 to 15.'); return; }
    syncFamily();
    const mon = resolve($('pokemon').value);
    if (!mon) { message('Choose a base Pokémon from the suggestions.'); return; }
    const parsed = FamilyRanks.candidatesFromRows(
      [...$('ivRows').children].map(row => [...row.querySelectorAll('input')].map(input => input.value)), mon);
    if (parsed.errors.length) {
      parsed.errors.forEach(error => { const p = document.createElement('p'); p.textContent = error; $('inputErrors').append(p); });
      message('Fix the listed IV entries before comparing.'); return;
    }
    const candidates = FamilyRanks.uniqueCandidates(parsed.candidates);
    settings = Object.fromEntries(['floor', 'min', 'max'].map(id => [id, Number($(id).value)]));
    if (settings.min > settings.max) { message('Minimum level must not exceed maximum level.'); return; }
    const evos = selection('evolutions'); selectedLeagues = selection('leagues');
    if (!evos.length || !selectedLeagues.length) { message('Select at least one family member and one league.'); return; }
    if (!worker) { message('The calculator is unavailable. Reload this page from a web server.'); return; }
    syncColumnPicker();
    if (!visibleColumns().length) { message('Select at least one evolution / league column.'); return; }
    updateURL();
    const id = ++generation, groups = new Map();
    for (const candidate of candidates) {
      for (const evo of FamilyRanks.family(candidate.mon, pokeListObj).filter(evo => evos.includes(evo))) {
        for (const league of selectedLeagues) {
          let error;
          if (candidate.ivs && candidate.ivs.some(value => value < settings.floor)) error = 'Below selected IV floor';
          else if (!FamilyRanks.eligible(candidate.mon, evo, candidate.ivs)) error = 'Unavailable for these Tyrogue IVs';
          rows.push({candidate, evo, league, result: null, error});
          if (error) continue;
          const key = JSON.stringify([evo, league]);
          if (!groups.has(key)) groups.set(key, {id, mon: evo, league, candidates: [], ...settings});
          groups.get(key).candidates.push(candidate);
        }
      }
    }
    pending = groups.size;
    if (!pending) { render(); updateURL(); message('No eligible candidates. Check evolution selections, IV floor and evolution requirements.'); return; }
    message('Calculating ' + candidates.length + ' candidates across ' + pending + ' evolution / league combinations…');
    for (const request of groups.values()) worker.postMessage(request);
  }
  try {
    worker = new Worker('includes/familyRanksWorker.js');
    worker.onmessage = event => {
      const {id, mon, league, results, error} = event.data;
      if (id !== generation) return;
      const ratings = new Map((results || []).map(item => [item.key, item]));
      for (const row of rows) {
        if (row.evo !== mon || row.league !== league || row.error) continue;
        const rating = ratings.get(row.candidate.key);
        row.result = rating?.result || null; row.error = rating?.error; row.candidate.currentLevels = rating?.levels || [];
        if (error) row.error = 'Calculation failed: ' + error;
      }
      pending--;
      if (pending) message('Calculating… ' + pending + ' evolution / league combinations remaining.');
      else {
        render(); updateURL();
        const failed = rows.filter(row => row.error && row.error.startsWith('Calculation failed')).length;
        message('Comparison complete: ' + rows.length + ' results.' + (failed ? ' ' + failed + ' calculation errors.' : ' Click a cell to reserve it and update the recommended plan.'));
      }
    };
    worker.onerror = () => {
      worker.terminate(); worker = null; generation++;
      message('Unable to load the calculator. Reload this page from a web server.');
    };
  } catch (error) { message('Open this page from a web server to enable calculations.'); }
  form.addEventListener('submit', event => { event.preventDefault(); compare(); });
  form.addEventListener('input', event => {
    if (event.target.closest('#columnPicker')) return;
    const filters = event.target.closest('#leagues') || event.target.closest('#evolutions');
    if (filters && rows.length && !pending) { syncColumnPicker(); compare(); }
    else { invalidate(!filters); syncFamily(); syncColumnPicker(); }
    refreshLevels();
  });
  for (const id of ['floor', 'min', 'max']) if (params.has(id)) $(id).value = params.get(id);
  if (params.has('mon')) $('pokemon').value = display(params.get('mon'));
  const savedIVs = params.get('IVs');
  let savedCPs = [], cpRestoreError = false;
  try {
    if (params.has('cps')) {
      savedCPs = JSON.parse(params.get('cps'));
      if (!Array.isArray(savedCPs) || savedCPs.length !== (savedIVs || '').split(',').length || savedCPs.some(cp => cp !== null && (!Number.isInteger(cp) || cp < 10))) throw new Error('Invalid CP');
    }
  } catch (_) { savedCPs = []; cpRestoreError = true; }
  if (savedIVs) savedIVs.split(',').forEach((spread, i) => addIVRow([...spread.split('_'), savedCPs[i] ?? '']));
  else addIVRow();
  syncFamily();
  if (params.has('evos')) {
    const enabled = params.get('evos').split(',');
    $('evolutions').querySelectorAll('input').forEach(input => { input.checked = enabled.includes(input.value); });
  }
  syncColumnPicker(true);
  try {
    if (params.has('cols')) {
      const enabled = new Set(JSON.parse(params.get('cols')).map(item => JSON.stringify(item)));
      for (const evo of FamilyRanks.family(resolve($('pokemon').value), pokeListObj)) for (const [league] of FamilyRanks.leagues) columnPrefs.set(colKey(evo, league), enabled.has(colKey(evo, league)));
    }
    if (params.has('choices')) choices = FamilyRanks.importSearch(FamilyRanks.exportSearch({...currentSearch(), choices: JSON.parse(params.get('choices'))}), pokeListObj).choices;
  } catch (_) { choices = []; message('Some saved column or choice settings could not be restored.'); }
  syncColumnPicker(true);
  refreshLevels();
  if (cpRestoreError) message('Saved CP values could not be restored. Re-enter current CP before comparing.');
  else if (params.has('mon') && savedIVs) compare();
})();
