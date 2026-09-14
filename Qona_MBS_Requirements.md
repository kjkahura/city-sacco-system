# Qona DT SACCO Mobile Banking System — Requirements Summary

**RFP Reference:** QS/MBS/5TH/MAY/2026  
**Client:** Qona DT SACCO, Good Man Plaza, Westlands, Nairobi, P.O. Box 2392-00606  
**Submission Deadline:** 19th May 2026, 5:00pm EAT  
**Clarification Deadline:** 12th May 2026  
**Contact:** client.contact@example.com  

---

## Functional Requirements

### A. Member Account Management
- Balance inquiry across account types: BOSA, Share Capital, Deposits, Loan Accounts, Dividend Accounts
- Mini-statement (last 10 transactions) and full statement PDF download
- Account-to-account transfers (dividend → loan, deposit → shares, BOSA → any)
- Beneficiary management: add, edit, delete, view
- Profile updates: phone number, email, next of kin, address

### B. Share Capital & Dividend Management
- Share trading marketplace: buy/sell between members
- Direct share purchase from SACCO via mobile money or bank deposit
- Dividend management: view history, capitalize to shares, withdraw to wallet or bank
- Real-time share valuation and performance trends

### C. Funds Transfer & Payments
- **Deposits:** M-Pesa STK Push
- **Withdrawals:** M-Pesa B2C, Airtel Money B2C, Bank transfers (PesaLink/EFT/RTGS)
- **Internal transfers:** Between members, between own accounts
- **Utility bills:** KPLC (prepaid/postpaid), Water, DStv/GOtv/Zuku, Internet
- **Airtime & data:** Safaricom, Airtel, Telkom
- **M-Pesa merchant:** Buy Goods (Till) and Paybill
- **Transaction management:** History, receipts, dispute reporting, limits, reversals

### D. Loan Management
- Instant loan applications with automated credit scoring and disbursement
- Guarantor requests (accept/decline with notifications)
- View guaranteed loans and member obligations
- Loan status, limit check, product catalog
- Loan repayment from M-Pesa, SACCO account, or bank
- Loan statements, top-up, restructuring, document download
- Early settlement with accurate interest adjustment

### E. WhatsApp Banking Module
- Balance inquiry, mini-statements, loan applications, airtime, bill payments via WhatsApp
- Secure OTP/session authentication for WhatsApp channel

### F. Security & Compliance
- PIN + Biometric authentication (Fingerprint, Face ID)
- 2FA (OTP via SMS/Email) for high-value transactions
- Device binding (IMSI/IMEI locking)
- SIM-swap and IMSI change detection — block key transactions
- End-to-end transaction encryption
- Session timeout and secure login
- Anti-fraud mechanisms
- Kenya Data Protection Act compliance

### G. Notifications & Alerts
- SMS for all transactions
- Push notifications for in-app activity
- Email for statements
- Customizable notification preferences

### H. Customer Support (In-App)
- Chat, call, email support channels
- FAQ section
- Ticket submission and tracking

### I. Integration Requirements
- Core banking system (real-time sync)
- M-Pesa: STK Push, B2C, Buy Goods, Paybill
- Airtel Money: B2C
- Bank transfers: PesaLink, EFT, RTGS
- Bill payment aggregators: KPLC, Water, DSTV
- Credit Reference Bureau (CRB)
- API-first architecture

### J. System Administration (SACCO Staff)
- Admin dashboard: transaction volumes, failed transactions, system health
- Maker-checker workflow for all admin actions
- Immutable audit trails (User ID, Date, Time, IP, Device, Action)

### K. Reporting & Analytics
- Transaction reports, user activity, system usage
- Custom report builder
- Dashboard with key metrics

### L. Self-Service User Functions
- Password/PIN reset via OTP
- Update personal information
- Manage beneficiaries and notification preferences

### M. Registration & Onboarding
- Self-service member registration
- Account verification and Terms & Conditions acceptance

### N. Source Code Escrow
- Source code to be placed in escrow during project delivery

---

## Technical Evaluation Criteria

| Criterion | Marks | Details |
|-----------|-------|---------|
| Technical Specifications Compliance | 50 | Adherence to all system features and technical requirements |
| Company Profile | 8 | 4+ years of business existence |
| Technical Staff | 15 | 4+ key staff with CVs provided |
| Past Performance | 15 | 3+ similar projects completed in last 6 years |
| Project Implementation Plans | 12 | Quality and feasibility of delivery schedule |
| **PASS MARK** | **70/100** | **Minimum score to proceed to financial evaluation** |
| **Financial Evaluation** | **30 marks** | **Formula: 30 × (Pm / P)** — Pm = proposal price, P = minimum price |

---

## Key Contract Terms

| Term | Requirement |
|------|-------------|
| **Performance Bond** | 15% of contract value |
| **Warranty Period** | 12 months minimum |
| **Annual Maintenance** | 3 years post-warranty; rates fixed for 5 years |
| **Support** | 24/7 support at no extra cost |
| **Delivery Timeline** | Within 6 weeks of signed purchase order |
| **Late Delivery Penalty** | 2% per week (max 4 weeks, then contract cancellation) |
| **Service Availability** | 99.9% minimum uptime |
| **Payment Terms** | 100% on 2 months successful operation |
| **Price Validity** | 120 days from RFP closing date |
| **Currency** | Kenya Shillings, inclusive of all taxes |

---

## Summary

This mobile banking system must serve Qona DT SACCO's member base with a comprehensive suite of financial, payment, loan, and self-service functions. The platform must integrate with Kenya's major payment networks (M-Pesa, Airtel Money, PesaLink) and comply with local data protection regulations. Support for WhatsApp banking extends reach to less-connected members. A robust security architecture with biometric authentication, 2FA, and SIM-swap detection is critical for protecting member assets and regulatory compliance. The system must be delivered within 6 weeks with 99.9% availability and 24/7 support.
