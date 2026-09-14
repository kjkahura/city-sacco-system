# Loan Guarantee Section - Mobile Mockup & Specification

## Visual Mockup

```
┌────────────────────────────────────┐
│ 9:59                        LTE 77% │
├────────────────────────────────────┤
│ ← newCUondevfourr                ✕ │
│   Savings and Credit Cooperative    │
├────────────────────────────────────┤
│                                    │
│ ┌──────────────────────────────┐  │
│ │ Saving one          Active   │  │
│ │ Account No: 913520033106     │  │
│ ├──────────────────────────────┤  │
│ │ ● 104,869.00 INR             │  │
│ │   Available Balance           │  │
│ │              [Contribute]     │  │
│ └──────────────────────────────┘  │
│                                    │
│ ┌─────────────┬─────────────────┐  │
│ │ Transactions│ ▼ Blocked       │  │
│ ├────────────────────────────────┤  │
│ │                              │  │
│ │ ┌──────────────────────────┐ │  │
│ │ │ Guarantees               │ │  │
│ │ ├──────────────────────────┤ │  │
│ │ │                          │ │  │
│ │ │ ▶ 50,000.00 INR          │ │  │
│ │ │   John Mwangi            │ │  │
│ │ │                          │ │  │
│ │ │ ▼ 35,500.00 INR          │ │  │
│ │ │   Mary Kipchoge          │ │  │
│ │ │   ┌──────────────────┐   │ │  │
│ │ │   │ Loan Product:... │   │ │  │
│ │ │   │ Original Guar... │   │ │  │
│ │ │   │ Current Liab.... │   │ │  │
│ │ │   │ Status: Active   │   │ │  │
│ │ │   └──────────────────┘   │ │  │
│ │ │                          │ │  │
│ │ │ ▶ 25,000.00 INR          │ │  │
│ │ │   Samuel Kariuki         │ │  │
│ │ │                          │ │  │
│ │ └──────────────────────────┘ │  │
│ │                              │  │
│ └────────────────────────────────┤  │
│                                    │
│ [Home] [Profile] [Alerts] [Settings]│
└────────────────────────────────────┘
```

---

## Feature Specification

### 1. Overview
A new **Guarantees** section appears in the savings account detail view, displaying all loans where the member acts as a guarantor. The section uses a collapsible list design to fit mobile screens while providing detailed information on demand.

### 2. Data Structure

**Guarantee Object:**
```javascript
{
  id: "guar_001",                          // Unique guarantee ID
  memberId: "mem_001",                     // Current member (guarantor)
  loanId: "loan_123",                      // Guaranteed loan ID
  borrowerMemberId: "mem_002",             // Borrower's member ID
  borrowerName: "Mary Kipchoge",           // Borrower's display name
  loanProductName: "Business Loan",        // Loan product type
  originalGuaranteedAmount: 50000.00,      // Original amount guaranteed (INR)
  currentLiability: 35500.00,              // Current outstanding liability
  guaranteeStatus: "Active",               // Active, Arrears, Closed, Defaulted
  guaranteeDate: "2025-06-15",             // Date guarantee was created
  guaranteeExpiry: "2026-06-15"            // Expiry date (if applicable)
}
```

### 3. UI Components

#### 3.1 Tab Navigation
- **Position:** Below the Available Balance card / Contribute button
- **Tabs:** "Transactions" | "Blocked"
- **Active State:** Underline in teal (#00897b), text color teal
- **Inactive State:** Gray text (#999), no underline
- **Interaction:** Clicking a tab switches content below without page reload
- **Default Active:** Transactions tab
- **Styling:** White background with subtle border

#### 3.2 Tab Content Areas
- **Transactions Tab:** Shows transaction history (sample transactions shown)
- **Blocked Tab:** Shows the Guarantees section with all guarantee items
- **Position:** Below the tabs, fills remaining scrollable space
- **Transitions:** Smooth fade between tab contents

#### 3.3 Guarantees Section Header
- **Title:** "Guarantees"
- **Position:** Inside the "Blocked" tab content area
- **Background:** White with light border
- **Padding:** 16px

#### 3.4 Guarantee List Item (Collapsed)
- **Layout:** Horizontal row with touch target of minimum 44px height
- **Icon:** Chevron (▶ or ▼) indicating expand/collapse state
- **Content:**
  - **Amount** (large, bold): `{currentLiability}.00 INR` or `{originalGuaranteedAmount}.00 INR` (TBD: current or original)
  - **Borrower Name** (gray, secondary): `{borrowerName}`
- **Interaction:** Tap anywhere on the row to toggle expand/collapse
- **Visual State:** Highlight on tap with slight background color change

#### 3.5 Guarantee List Item (Expanded)
- **Animation:** Smooth slide-down expansion
- **Content Panel:**
  - **Loan Product:** "{loanProductName}"
  - **Original Guaranteed:** "{originalGuaranteedAmount} INR"
  - **Current Liability:** "{currentLiability} INR"
  - **Loan Status:** "{guaranteeStatus}" (colored badge)
  - **Optional:** Guarantee Date, Guarantee Expiry
- **Styling:**
  - Light background (off-white or subtle gray)
  - Padding: 12px
  - Rounded corners: 8px
  - Subtle border or shadow to distinguish from collapsed state
- **Interaction:** Tap to collapse; no additional actions visible (but can be added later)

#### 3.6 Status Badge Styling
| Status | Color | Background |
|--------|-------|------------|
| Active | Green | #E8F5E9 |
| Arrears | Orange | #FFF3E0 |
| Closed | Gray | #EEEEEE |
| Defaulted | Red | #FFEBEE |

### 4. API Endpoint

**GET /api/members/{memberId}/guarantees**

**Response:**
```json
{
  "status": "success",
  "data": [
    {
      "id": "guar_001",
      "loanId": "loan_123",
      "borrowerName": "Mary Kipchoge",
      "loanProductName": "Business Loan",
      "originalGuaranteedAmount": 50000.00,
      "currentLiability": 35500.00,
      "guaranteeStatus": "Active",
      "guaranteeDate": "2025-06-15",
      "guaranteeExpiry": "2026-06-15"
    },
    ...
  ],
  "total": 3
}
```

**Error Response (404):**
```json
{
  "status": "error",
  "error": "Member not found"
}
```

### 5. Frontend Implementation

#### 5.1 HTML Structure
```html
<!-- Tabs -->
<div class="tabs-container">
  <button class="tab-button active" onclick="switchTab('transactions')">Transactions</button>
  <button class="tab-button" onclick="switchTab('blocked')">Blocked</button>
</div>

<!-- Scrollable Content -->
<div class="scroll-content">
  <!-- Balance Card -->
  <!-- ... balance card HTML ... -->
  
  <!-- Transactions Tab -->
  <div id="transactions" class="tab-content active">
    <!-- Transaction items go here -->
  </div>
  
  <!-- Blocked Tab -->
  <div id="blocked" class="tab-content">
    <div class="guarantees-section">
      <h3 class="guarantees-title">Guarantees</h3>
      
      <div class="guarantees-list">
    <!-- Guarantee items rendered here -->
    <div class="guarantee-item" data-guarantee-id="guar_001">
      <div class="guarantee-header">
        <span class="guarantee-toggle">▶</span>
        <div class="guarantee-summary">
          <div class="guarantee-amount">50,000.00 INR</div>
          <div class="guarantee-borrower">Mary Kipchoge</div>
        </div>
      </div>
      
      <div class="guarantee-details" style="display: none;">
        <div class="detail-row">
          <span class="detail-label">Loan Product:</span>
          <span class="detail-value">Business Loan</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Original Guaranteed:</span>
          <span class="detail-value">50,000.00 INR</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Current Liability:</span>
          <span class="detail-value">35,500.00 INR</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Status:</span>
          <span class="detail-value status-badge active">Active</span>
        </div>
      </div>
    </div>
  </div>
</div>
```

#### 5.2 CSS Styling
```css
/* Tab Navigation */
.tabs-container {
  background: white;
  border-bottom: 1px solid #e0e0e0;
  display: flex;
  flex-shrink: 0;
}

.tab-button {
  flex: 1;
  padding: 12px;
  text-align: center;
  border-bottom: 3px solid transparent;
  color: #999;
  font-weight: 500;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s ease;
  background: white;
  border: none;
  font-family: inherit;
}

.tab-button:hover {
  color: #666;
}

.tab-button.active {
  color: #00897b;
  border-bottom-color: #00897b;
}

/* Tab Content */
.tab-content {
  display: none;
}

.tab-content.active {
  display: block;
}

/* Scroll Content */
.scroll-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.guarantees-section {
  background: #f5f5f5;
  border-radius: 8px;
  margin: 16px;
  padding: 16px;
  border: 1px solid #e0e0e0;
}

.guarantees-title {
  font-size: 18px;
  font-weight: 600;
  margin-bottom: 12px;
  color: #333;
}

.guarantee-item {
  background: white;
  border-radius: 6px;
  margin-bottom: 8px;
  border: 1px solid #e0e0e0;
  overflow: hidden;
}

.guarantee-header {
  display: flex;
  align-items: center;
  padding: 12px;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.2s ease;
}

.guarantee-header:active {
  background-color: #f0f0f0;
}

.guarantee-toggle {
  font-size: 16px;
  margin-right: 12px;
  transition: transform 0.2s ease;
  color: #666;
}

.guarantee-toggle.expanded {
  transform: rotate(90deg);
}

.guarantee-summary {
  flex: 1;
}

.guarantee-amount {
  font-size: 16px;
  font-weight: 600;
  color: #00695c;
  margin-bottom: 4px;
}

.guarantee-borrower {
  font-size: 13px;
  color: #999;
}

.guarantee-details {
  background-color: #fafafa;
  padding: 12px;
  border-top: 1px solid #e0e0e0;
}

.detail-row {
  display: flex;
  justify-content: space-between;
  padding: 8px 0;
  font-size: 13px;
  border-bottom: 1px solid #f0f0f0;
}

.detail-row:last-child {
  border-bottom: none;
}

.detail-label {
  color: #666;
  font-weight: 500;
}

.detail-value {
  color: #333;
  text-align: right;
}

.status-badge {
  padding: 4px 8px;
  border-radius: 4px;
  font-weight: 600;
  font-size: 12px;
}

.status-badge.active {
  background-color: #e8f5e9;
  color: #2e7d32;
}

.status-badge.arrears {
  background-color: #fff3e0;
  color: #e65100;
}

.status-badge.closed {
  background-color: #eeeeee;
  color: #666;
}

.status-badge.defaulted {
  background-color: #ffebee;
  color: #c62828;
}
```

#### 5.3 JavaScript Logic
```javascript
// Tab Switching
function switchTab(tabName) {
  // Hide all tab contents
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.remove('active');
  });

  // Remove active class from all buttons
  document.querySelectorAll('.tab-button').forEach(button => {
    button.classList.remove('active');
  });

  // Show selected tab content
  const selectedTab = document.getElementById(tabName);
  if (selectedTab) {
    selectedTab.classList.add('active');
  }

  // Add active class to clicked button
  event.target.classList.add('active');
}

// Guarantee Toggle
function toggleGuarantee(headerElement) {
  const item = headerElement.closest('.guarantee-item');
  const details = item.querySelector('.guarantee-details');
  const toggle = headerElement.querySelector('.guarantee-toggle');

  details.classList.toggle('open');
  toggle.classList.toggle('expanded');
}

document.addEventListener('DOMContentLoaded', () => {
  // Initialize guarantee toggle handlers
  document.querySelectorAll('.guarantee-item').forEach(item => {
    const header = item.querySelector('.guarantee-header');
    header.addEventListener('click', function() {
      toggleGuarantee(this);
    });
  });
});

// Function to fetch and render guarantees
async function loadGuarantees(memberId) {
  try {
    const response = await fetch(`/api/members/${memberId}/guarantees`);
    const json = await response.json();
    
    if (json.status === 'success') {
      renderGuarantees(json.data);
    } else {
      console.error('Error loading guarantees:', json.error);
    }
  } catch (error) {
    console.error('Fetch error:', error);
  }
}

function renderGuarantees(guarantees) {
  const container = document.querySelector('.guarantees-list');
  
  if (!guarantees || guarantees.length === 0) {
    container.innerHTML = '<p style="color: #999; text-align: center; padding: 16px;">No guarantees</p>';
    return;
  }
  
  container.innerHTML = guarantees.map(g => `
    <div class="guarantee-item" data-guarantee-id="${g.id}">
      <div class="guarantee-header">
        <span class="guarantee-toggle">▶</span>
        <div class="guarantee-summary">
          <div class="guarantee-amount">${formatCurrency(g.currentLiability)} INR</div>
          <div class="guarantee-borrower">${g.borrowerName}</div>
        </div>
      </div>
      
      <div class="guarantee-details" style="display: none;">
        <div class="detail-row">
          <span class="detail-label">Loan Product:</span>
          <span class="detail-value">${g.loanProductName}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Original Guaranteed:</span>
          <span class="detail-value">${formatCurrency(g.originalGuaranteedAmount)} INR</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Current Liability:</span>
          <span class="detail-value">${formatCurrency(g.currentLiability)} INR</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Status:</span>
          <span class="detail-value status-badge ${g.guaranteeStatus.toLowerCase()}">${g.guaranteeStatus}</span>
        </div>
      </div>
    </div>
  `).join('');
  
  // Re-attach event listeners
  document.querySelectorAll('.guarantee-item').forEach(item => {
    const header = item.querySelector('.guarantee-header');
    const details = item.querySelector('.guarantee-details');
    const toggle = item.querySelector('.guarantee-toggle');
    
    header.addEventListener('click', () => {
      const isExpanded = details.style.display !== 'none';
      details.style.display = isExpanded ? 'none' : 'block';
      toggle.classList.toggle('expanded');
    });
  });
}

function formatCurrency(amount) {
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
}
```

### 6. Backend Implementation (server.js)

**New Endpoint:**
```javascript
app.get('/api/members/:memberId/guarantees', (req, res) => {
  const { memberId } = req.params;
  
  // Validate member exists
  const member = globalData.members.find(m => m.id === memberId);
  if (!member) {
    return res.status(404).json({ status: 'error', error: 'Member not found' });
  }
  
  // Find all guarantees where this member is the guarantor
  const guarantees = globalData.guarantees
    .filter(g => g.memberId === memberId)
    .map(g => {
      const borrower = globalData.members.find(m => m.id === g.borrowerMemberId);
      const loan = globalData.loans.find(l => l.id === g.loanId);
      
      return {
        id: g.id,
        loanId: g.loanId,
        borrowerName: borrower ? borrower.displayName : 'Unknown',
        loanProductName: loan ? loan.productTypeKey : 'Unknown',
        originalGuaranteedAmount: g.originalGuaranteedAmount,
        currentLiability: g.currentLiability,
        guaranteeStatus: g.guaranteeStatus,
        guaranteeDate: g.guaranteeDate,
        guaranteeExpiry: g.guaranteeExpiry
      };
    });
  
  res.json({ status: 'success', data: guarantees, total: guarantees.length });
});
```

**Data Structure (globalData):**
```javascript
globalData.guarantees = [
  {
    id: 'guar_001',
    memberId: 'mem_001',
    loanId: 'loan_123',
    borrowerMemberId: 'mem_002',
    originalGuaranteedAmount: 50000.00,
    currentLiability: 35500.00,
    guaranteeStatus: 'Active',
    guaranteeDate: '2025-06-15',
    guaranteeExpiry: '2026-06-15'
  },
  // ... more guarantees
];
```

### 7. Acceptance Criteria

- [ ] Tab navigation displays at top with "Transactions" and "Blocked" tabs
- [ ] Default active tab is "Transactions"
- [ ] Clicking "Blocked" tab shows Guarantees section
- [ ] Clicking "Transactions" tab shows transaction history (future scope)
- [ ] Guarantees section displays below balance card in "Blocked" tab
- [ ] Each guarantee shows collapsed state with amount and borrower name
- [ ] Tapping a guarantee expands it to show full details
- [ ] Details include: Loan Product, Original Guaranteed, Current Liability, Status
- [ ] Status badge is color-coded (Active=Green, Arrears=Orange, Closed=Gray, Defaulted=Red)
- [ ] Chevron icon rotates when expanding/collapsing
- [ ] Tab switching is smooth without page reload
- [ ] API endpoint `/api/members/{memberId}/guarantees` returns correct data
- [ ] Empty state shows "No guarantees" message when applicable
- [ ] Works responsively on mobile screens (375px minimum width)
- [ ] Smooth animations for expand/collapse and tab switching

### 8. Future Enhancements

- Add filter/sort by status or amount
- Add "View Loan" button to navigate to loan details
- Add guarantee release/cancellation workflow
- Add guarantee amount history (chart)
- Export guarantees as PDF
