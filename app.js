const apiBase = `${window.location.origin}/api`;

async function fetchJson(path) {
  const response = await fetch(`${apiBase}/${path}`);
  if (!response.ok) {
    throw new Error(`Failed to load ${path}: ${response.status}`);
  }
  return response.json();
}

function formatCurrency(value) {
  return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 0 })}`;
}

function renderOverview(data) {
  const container = document.getElementById('overview-cards');
  container.innerHTML = `
    <div class="stat">
      <h3>${data.totalMembers}</h3>
      <p>Total Members</p>
    </div>
    <div class="stat">
      <h3>${formatCurrency(data.totalLoans)}</h3>
      <p>Total Loans</p>
    </div>
    <div class="stat">
      <h3>${formatCurrency(data.totalSavings)}</h3>
      <p>Total Savings</p>
    </div>
    <div class="stat">
      <h3>${data.loanRecoveryRate}%</h3>
      <p>Loan Recovery Rate</p>
    </div>
  `;
}

function renderTable(tableId, rows, columns) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  tbody.innerHTML = rows.map(row => {
    return `
      <tr>
        ${columns.map(column => {
          const value = row[column.key] ?? '';
          const rendered = column.formatter ? column.formatter(value) : value;
          return `<td>${rendered}</td>`;
        }).join('')}
      </tr>
    `;
  }).join('');
}

async function loadData() {
  try {
    document.getElementById('overview-error').classList.add('hidden');
    document.getElementById('loading-state').classList.remove('hidden');

    const [overview, members, loans, savings] = await Promise.all([
      fetchJson('overview'),
      fetchJson('members'),
      fetchJson('loans'),
      fetchJson('savings')
    ]);

    renderOverview(overview);

    renderTable('members-table', members, [
      { key: 'id' },
      { key: 'name' },
      { key: 'joinDate' },
      { key: 'status' }
    ]);

    renderTable('loans-table', loans, [
      { key: 'id' },
      { key: 'member' },
      { key: 'amount', formatter: formatCurrency },
      { key: 'status' }
    ]);

    renderTable('savings-table', savings, [
      { key: 'id' },
      { key: 'member' },
      { key: 'balance', formatter: formatCurrency },
      { key: 'lastDeposit' }
    ]);
  } catch (error) {
    console.error(error);
    document.getElementById('overview-error').classList.remove('hidden');
  } finally {
    document.getElementById('loading-state').classList.add('hidden');
  }
}

function init() {
  document.getElementById('refresh-button').addEventListener('click', loadData);
  loadData();
}

window.addEventListener('DOMContentLoaded', init);
