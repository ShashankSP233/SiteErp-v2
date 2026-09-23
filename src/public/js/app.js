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
});
