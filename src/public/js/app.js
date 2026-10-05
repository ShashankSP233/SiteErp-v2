document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('table.data-table').forEach(table => {
    const body = table.tBodies[0]; if (!body) return;
    const rows = Array.from(body.rows);
    const wrap = document.createElement('div'); wrap.className = 'mb-2 d-flex justify-content-end';
    const input = document.createElement('input');
    input.type = 'search'; input.className = 'form-control form-control-sm'; input.style.maxWidth = '260px';
    input.placeholder = 'Search this table…';
    wrap.appendChild(input); table.parentNode.insertBefore(wrap, table);
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      rows.forEach(r => { r.style.display = !q || r.textContent.toLowerCase().includes(q) ? '' : 'none'; });
    });
  });

  let searchId = 0;
  function enhanceItemMasterSelect(select) {
    if (select.dataset.itemSearchReady === 'true') return;
    select.dataset.itemSearchReady = 'true';

    const searchableOptions = Array.from(select.options).filter(option => option.value);
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'form-control form-control-sm item-master-filter';
    search.placeholder = 'Search by item code or name…';
    search.autocomplete = 'off';
    search.setAttribute('aria-label', 'Search item masters');
    search.id = `item-master-filter-${++searchId}`;

    const help = document.createElement('div');
    help.className = 'form-text item-master-filter-help';
    help.id = `${search.id}-help`;
    search.setAttribute('aria-describedby', help.id);
    select.setAttribute('aria-describedby', [select.getAttribute('aria-describedby'), help.id].filter(Boolean).join(' '));
    help.textContent = `Type to narrow ${searchableOptions.length} items.`;

    select.before(search);
    select.after(help);

    function filterOptions(query) {
      const term = query.trim().toLocaleLowerCase();
      let matches = 0;
      searchableOptions.forEach(option => {
        const match = !term || option.textContent.toLocaleLowerCase().includes(term);
        option.hidden = !match;
        if (match) matches += 1;
      });
      help.textContent = term
        ? (matches ? `${matches} matching item${matches === 1 ? '' : 's'}.` : 'No matching items.')
        : `Type to narrow ${searchableOptions.length} items.`;
    }

    let clearingForSearch = false;
    search.addEventListener('input', () => {
      if (select.value) {
        select.value = '';
        clearingForSearch = true;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        clearingForSearch = false;
      }
      filterOptions(search.value);
    });

    select.addEventListener('change', () => {
      if (clearingForSearch) return;
      search.value = '';
      filterOptions('');
    });

    select.form?.addEventListener('reset', () => {
      window.setTimeout(() => {
        search.value = '';
        searchableOptions.forEach(option => { option.hidden = false; });
        filterOptions('');
      }, 0);
    });
  }

  function enhanceNewSelects(root) {
    if (root.matches?.('[data-item-master-search]')) enhanceItemMasterSelect(root);
    root.querySelectorAll?.('[data-item-master-search]').forEach(enhanceItemMasterSelect);
  }

  enhanceNewSelects(document);
  new MutationObserver(records => {
    records.forEach(record => record.addedNodes.forEach(node => {
      if (node.nodeType === Node.ELEMENT_NODE) enhanceNewSelects(node);
    }));
  }).observe(document.body, { childList: true, subtree: true });
});
